import { createHash, randomBytes } from 'node:crypto'
import { planService, publicService } from './services.js'
import {
  apiOperationError, apiOperationStore, createApiPreview, executeApiWrite,
  handleApiOperationRoute, publicApiOperation, replayApiWrite,
} from './operation-store.js'
import { validateEndpointNetwork } from './network-policy.js'
import { restoreProviderSecretsFromCurrent } from './redaction.js'
import { serviceInFlightImpact, inFlightDeleteError } from './in-flight.js'

function hash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function fail(status, code, error, details) { return { status, body: { ok: false, code, error: error || code, retryable: status >= 500 || status === 409, ...(details ? { details } : {}) } } }
function configValidationFailure(ctx, value) {
  if (typeof ctx.validateConfig !== 'function') return null
  try { ctx.validateConfig(value); return null } catch (error) {
    if (!error || !error.code) throw error
    return fail(error.status || 403, error.code, error.message || error.code)
  }
}
function safeEndpoint(value) {
  try { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString().replace(/\/$/, '') } catch { return '' }
}
function serviceIdFromPath(path) {
  try { return decodeURIComponent(path.slice('/api/services/'.length)) } catch { return null }
}

function prune(store, now) {
  for (const [key, value] of store) if (value.expiresAt <= now) store.delete(key)
  while (store.size > 200) store.delete(store.keys().next().value)
}

export async function handleServiceApi(ctx) {
  const { method, path, getConfig, saveConfig, previews, receipts, now = Date.now() } = ctx
  const operationRoute = handleApiOperationRoute(ctx, method, path)
  if (operationRoute) return operationRoute
  prune(previews, now)
  prune(receipts, now)
  const cfg = getConfig()
  if (method === 'GET' && path === '/api/services') {
    return { status: 200, body: { contract: 'mg-services/1', configVersion: cfg.configVersion || 0, services: Object.entries(cfg.providers || {}).map(([id, provider]) => ({ ...publicService(id, provider, cfg), endpoint: safeEndpoint(provider.baseUrl) })) } }
  }
  if (method === 'GET' && path.startsWith('/api/services/')) {
    const id = serviceIdFromPath(path)
    if (!id) return fail(400, 'invalid_service_id', '服务 ID 编码无效')
    const provider = cfg.providers?.[id]
    if (!id || ['__proto__', 'constructor', 'prototype'].includes(id) || !Object.hasOwn(cfg.providers || {}, id)) return fail(404, 'service_not_found', '服务不存在')
    return { status: 200, body: { contract: 'mg-services/1', service: { ...publicService(id, provider, cfg), endpoint: safeEndpoint(provider.baseUrl) } } }
  }
  if (method === 'POST' && path === '/api/config/preview') {
    const invalid = configValidationFailure(ctx, ctx.body || {})
    if (invalid) return invalid
    const result = await planService(cfg, ctx.body || {}, { now, lookup: ctx.lookup, timeoutMs: ctx.networkTimeoutMs, inFlight: ctx.state?.inFlight })
    if (result.error) return fail(result.status, result.code, result.error, result.details)
    const plan = result.plan
    const invalidPlan = configValidationFailure(ctx, plan.payload)
    if (invalidPlan) return invalidPlan
    try {
      const created = createApiPreview(ctx, {
        previews, requestId: plan.requestId, plan, ttlMs: ctx.body?.ttlMs,
        view: {
          ok: true, expectedVersion: plan.expectedVersion, action: plan.action,
          serviceId: plan.serviceId, before: plan.before, after: plan.after,
          impact: plan.impact, credentialAction: plan.credentialAction,
        },
      })
      return { status: 200, body: created }
    } catch (error) { return apiOperationError(error, 'preview_store_failed') }
  }
  const write = (method === 'POST' && path === '/api/services') || method === 'PATCH' || method === 'DELETE'
  if (!write || !path.startsWith('/api/services')) return null
  const body = ctx.body || {}
  const invalidBody = configValidationFailure(ctx, body)
  if (invalidBody) return invalidBody
  const requestFingerprint = hash({ method, path, body })
  const prior = replayApiWrite(ctx, { receipts, requestId: body.requestId, requestFingerprint })
  if (prior) return prior
  const token = String(body.confirmToken || '')
  const durable = apiOperationStore(ctx)
  let stored
  if (durable) {
    try { stored = durable.readPreview(body.previewId, { includePlan: true }) } catch (error) {
      return error.code === 'preview_not_found'
        ? fail(428, token ? 'preview_expired' : 'confirmation_required', '预览不存在、已使用或已过期，请重新预览')
        : apiOperationError(error)
    }
  } else {
    stored = previews.get(token)
    if (!stored) return fail(428, stored === undefined && token ? 'preview_expired' : 'confirmation_required', '预览不存在、已使用或已过期，请重新预览')
    if (stored.expiresAt <= now) { previews.delete(token); return fail(428, 'preview_expired', '预览已过期，请重新预览') }
  }
  const id = method === 'POST' ? stored.plan.serviceId : serviceIdFromPath(path)
  if (!id) return fail(400, 'invalid_service_id', '服务 ID 编码无效')
  const expectedAction = method === 'POST' ? 'service.create' : method === 'PATCH' ? 'service.update' : 'service.delete'
  if (stored.plan.action !== expectedAction || stored.plan.serviceId !== id || body.previewId !== stored.previewId || body.expectedVersion !== stored.plan.expectedVersion || body.requestId !== stored.plan.requestId) {
    return fail(409, 'preview_binding_mismatch', '预览与当前操作、服务、版本或 requestId 不匹配')
  }
  const invalidPlan = configValidationFailure(ctx, stored.plan.payload)
  if (invalidPlan) return invalidPlan
  if (stored.plan.action !== 'service.delete') {
    const provider = stored.plan.payload.providers[id]
    const network = await validateEndpointNetwork(provider.baseUrl, {
      allowPrivateNetwork: provider.allowPrivateNetwork === true,
      lookup: ctx.lookup,
      timeoutMs: ctx.networkTimeoutMs,
    })
    if (network.error) return fail(400, network.code, network.error)
  }
  return executeApiWrite(ctx, {
    previews, receipts, previewId: stored.previewId, confirmToken: token,
    requestId: body.requestId, requestFingerprint,
    save: () => {
      const current = getConfig()
      if (stored.plan.action === 'service.delete') {
        const active = inFlightDeleteError(serviceInFlightImpact(ctx.state?.inFlight, id), 'service_in_flight', '服务仍有在途请求，请等待完成后删除')
        if (active) return active
      }
      const payload = { ...stored.plan.payload, providers: Object.fromEntries(Object.entries(stored.plan.payload.providers || {}).map(([providerId, provider]) => [providerId, restoreProviderSecretsFromCurrent(provider, current.providers?.[providerId], { editableBaseUrl: providerId === id && stored.plan.action === 'service.update' })])) }
      return saveConfig(payload, stored.plan.expectedVersion)
    },
    responseFor: (result, operation) => {
      const next = getConfig()
      const service = next.providers?.[id] ? { ...publicService(id, next.providers[id], next), endpoint: safeEndpoint(next.providers[id].baseUrl) } : null
      return { status: 200, body: { ok: true, contract: 'mg-services/1', requestId: body.requestId, service, configVersion: next.configVersion || 0, operation: operation ? publicApiOperation(operation) : { id: 'op_' + randomBytes(8).toString('hex'), state: 'succeeded', steps: [{ id: 'config-transaction', state: 'succeeded' }] } } }
    },
    failureFor: (result) => {
      const currentVersion = getConfig().configVersion || 0
      return fail(result.conflict ? 409 : result.status || 400, result.conflict ? 'version_conflict' : result.code || 'service_write_failed', result.error || result.message, result.conflict ? { currentVersion } : undefined)
    },
  })
}
