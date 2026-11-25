import { createHash, randomBytes } from 'node:crypto'
import { planModel, publicModel } from './models.js'
import { planPool, publicPool } from './pools.js'
import { planConnection, listConnections } from './connections.js'
import { planPolicy, effectivePolicy } from './policies.js'
import { restoreDefaultsSecretsFromCurrent, restoreProviderSecretsFromCurrent, SECRET_MASK } from './redaction.js'
import { discoverConnection } from './discovery.js'
import { planHarnessBinding, listHarnessBindings, publicHarnessBinding } from './bindings.js'
import { listProviderTemplates, getProviderTemplate, templateStats } from './templates.js'
import { modelInFlightImpact, poolInFlightImpact, inFlightDeleteError } from './in-flight.js'
import {
  apiOperationError, apiOperationStore, createApiPreview, executeApiWrite,
  handleApiOperationRoute, publicApiOperation, replayApiWrite,
} from './operation-store.js'

function hash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function fail(status, code, error, details) { return { status, body: { ok: false, code, error: error || code, retryable: status >= 500 || status === 409, ...(details ? { details } : {}) } } }
function configValidationFailure(ctx, value) {
  if (typeof ctx.validateConfig !== 'function') return null
  try { ctx.validateConfig(value); return null } catch (error) {
    if (!error || !error.code) throw error
    return fail(error.status || 403, error.code, error.message || error.code)
  }
}
function decode(value) { try { return decodeURIComponent(value) } catch { return null } }
function prune(store, now) { for (const [key, value] of store) if (value.expiresAt <= now) store.delete(key); while (store.size > 200) store.delete(store.keys().next().value) }
function planner(resource, cfg, body, opts = {}) { return resource === 'model' ? planModel(cfg, body, opts) : resource === 'pool' ? planPool(cfg, body, opts) : resource === 'connection' ? planConnection(cfg, body) : resource === 'binding' ? planHarnessBinding(cfg, body) : planPolicy(cfg, body) }
function planId(plan, resource) { return resource === 'model' ? plan.modelId : resource === 'pool' ? plan.poolId : resource === 'connection' ? plan.connectionId : resource === 'binding' ? plan.bindingId : plan.policyId }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function credentialChannelFailure() { return { status: 400, code: 'credential_channel_required', error: '资源补丁不能修改凭据，请使用独立凭据通道' } }
function urlHasSecrets(value) {
  if (typeof value !== 'string' || !value || value === SECRET_MASK) return false
  try {
    const url = new URL(value)
    return !!(url.username || url.password || url.search || url.hash)
  } catch { return false }
}
function maskedHeaders(value) {
  return object(value) && Object.values(value).every((entry) => entry === SECRET_MASK)
}
function safeSecretProjection(value, provider = false) {
  if (!object(value)) return false
  if (value.extraHeaders !== undefined && !maskedHeaders(value.extraHeaders)) return false
  if (value.proxy !== undefined && value.proxy !== null && value.proxy !== '' && value.proxy !== false && value.proxy !== 'direct' && value.proxy !== SECRET_MASK) return false
  if (value.sessionHmacSecret !== undefined && value.sessionHmacSecret !== null && value.sessionHmacSecret !== '' && value.sessionHmacSecret !== SECRET_MASK) return false
  if (value.connections !== undefined && (!Array.isArray(value.connections) || !value.connections.every((connection) => safeSecretProjection(connection, true)))) return false
  return !provider || !urlHasSecrets(value.baseUrl)
}
function currentDefaultsSecrets(planned, current) {
  // Policy patches cannot change defaults credentials. The helper copies from
  // the commit-time generation, including direct/empty -> secret rotations.
  const restored = restoreDefaultsSecretsFromCurrent(planned, current)
  // The client key has its own encrypted credential channel; omitting it makes
  // saveConfig keep the current key instead of interpreting a stale blank as clear.
  delete restored.clientKey
  return restored
}
function prepareResourcePayload(plan, current) {
  if (plan.resource === 'connection') {
    if (!object(plan.payload?.providers)) return credentialChannelFailure()
    for (const provider of Object.values(plan.payload.providers)) {
      if (!safeSecretProjection(provider, true)) return credentialChannelFailure()
    }
    if (!Object.hasOwn(current.providers || {}, plan.providerId)) return { conflict: true, currentVersion: current.configVersion || 0 }
    const providers = Object.fromEntries(Object.entries(current.providers || {}).map(([id, provider]) => [id, structuredClone(provider)]))
    const planned = plan.payload.providers[plan.providerId]
    if (!Array.isArray(planned?.connections)) return credentialChannelFailure()
    // A connection patch owns only the target provider's connections. Build the
    // rest of the replacement from the current generation so unrelated provider
    // edits and credential rotations cannot be restored from the stale preview.
    providers[plan.providerId] = restoreProviderSecretsFromCurrent({ ...providers[plan.providerId], connections: structuredClone(planned.connections) }, providers[plan.providerId])
    return { payload: { ...plan.payload, providers } }
  }
  if (plan.resource === 'policy' && plan.scopeType === 'global') {
    if (!safeSecretProjection(plan.payload?.defaults)) return credentialChannelFailure()
    return { payload: { ...plan.payload, defaults: currentDefaultsSecrets(plan.payload.defaults, current.defaults || {}) } }
  }
  return { payload: plan.payload }
}

function viewList(resource, cfg, providerId = '') {
  if (resource === 'model') return Object.entries(cfg.models || {}).map(([name, def]) => publicModel(name, def, cfg)).filter(Boolean)
  if (resource === 'pool') return (cfg.virtualModels || []).map((pool) => publicPool(pool, cfg)).filter(Boolean)
  if (resource === 'policy') return []
  if (resource === 'binding') return listHarnessBindings(cfg).map(publicHarnessBinding)
  return providerId ? listConnections(cfg, providerId) : Object.keys(cfg.providers || {}).flatMap((id) => listConnections(cfg, id))
}

export async function handleResourceApi(ctx) {
  const { method, path, getConfig, saveConfig, previews, receipts, now = Date.now() } = ctx
  const operationRoute = handleApiOperationRoute(ctx, method, path)
  if (operationRoute) return operationRoute
  prune(previews, now); prune(receipts, now)
  const cfg = getConfig()
  if (method === 'POST' && /^\/api\/connections\/[^/]+\/[^/]+\/discover$/.test(path)) {
    const parts = path.split('/')
    try { return { status: 200, body: await discoverConnection(cfg, decode(parts[3]), decode(parts[4]), { fetchImpl: ctx.fetchImpl, requestImpl: ctx.requestImpl, lookup: ctx.lookup, networkTimeoutMs: ctx.networkTimeoutMs, timeoutMs: ctx.discoveryTimeoutMs }) } }
    catch (error) { return fail(error.status || 400, error.code || 'discovery_failed', error.message) }
  }
  if (method === 'GET' && path === '/api/provider-templates') {
    const query = new URL('http://local' + (ctx.url || path)).searchParams
    const params = Object.fromEntries(query)
    if (params.limit !== undefined) params.limit = Number(params.limit)
    try { return { status: 200, body: { ...listProviderTemplates(params), stats: templateStats() } } }
    catch (error) { return fail(400, 'invalid_template_query', error.message) }
  }
  if (method === 'GET' && path.startsWith('/api/provider-templates/')) {
    const id = decode(path.slice('/api/provider-templates/'.length))
    const item = id ? getProviderTemplate(id) : null
    return item ? { status: 200, body: { contract: 'mg-provider-templates/1', item } } : fail(404, 'template_not_found', '服务模板不存在')
  }
  if (method === 'POST' && path === '/api/config/preview') {
    const resource = String(ctx.body?.action || '').startsWith('model.') ? 'model' : String(ctx.body?.action || '').startsWith('pool.') ? 'pool' : String(ctx.body?.action || '').startsWith('connection.') ? 'connection' : String(ctx.body?.action || '').startsWith('policy.') ? 'policy' : String(ctx.body?.action || '').startsWith('binding.') ? 'binding' : null
    if (!resource) return null
    const invalidBody = configValidationFailure(ctx, ctx.body || {})
    if (invalidBody) return invalidBody
    const result = planner(resource, cfg, ctx.body || {}, { inFlight: ctx.state?.inFlight })
    if (result.error) return fail(result.status, result.code, result.error, result.details)
    const plan = { ...result.plan, resource, id: planId(result.plan, resource) }
    const invalidPlan = configValidationFailure(ctx, plan.payload)
    if (invalidPlan) return invalidPlan
    try {
      const created = createApiPreview(ctx, {
        previews, requestId: plan.requestId, plan, ttlMs: ctx.body?.ttlMs,
        view: {
          ok: true, resource, expectedVersion: plan.expectedVersion, action: plan.action,
          modelId: resource === 'model' ? plan.modelId : undefined,
          poolId: resource === 'pool' ? plan.poolId : undefined,
          connectionId: resource === 'connection' ? plan.connectionId : undefined,
          policyId: resource === 'policy' ? plan.policyId : undefined,
          bindingId: resource === 'binding' ? plan.bindingId : undefined,
          before: plan.before, after: plan.after, impact: plan.impact,
        },
      })
      return { status: 200, body: created }
    } catch (error) { return apiOperationError(error, 'preview_store_failed') }
  }
  const resource = path === '/api/models' || path.startsWith('/api/models/') ? 'model' : path === '/api/pools' || path.startsWith('/api/pools/') ? 'pool' : path === '/api/connections' || path.startsWith('/api/connections/') ? 'connection' : path === '/api/policies' ? 'policy' : path === '/api/harness-bindings' || path.startsWith('/api/harness-bindings/') ? 'binding' : null
  if (!resource) return null
  if (method === 'GET') {
    const items = viewList(resource, cfg, new URL('http://local' + (ctx.url || path)).searchParams.get('providerId') || '')
    const basePath = '/api/' + (resource === 'model' ? 'models' : resource === 'pool' ? 'pools' : resource === 'connection' ? 'connections' : resource === 'policy' ? 'policies' : 'harness-bindings')
    if (path === basePath) return { status: 200, body: { contract: 'mg-' + resource + 's/1', configVersion: cfg.configVersion || 0, items } }
    const id = decode(path.split('/').at(-1))
    const item = items.find((entry) => resource === 'model' ? entry.name === id || entry.modelId === id : resource === 'pool' ? entry.poolId === id || entry.slug === id || (!entry.poolId && entry.name === id) : resource === 'connection' ? entry.connectionId === id : resource === 'binding' ? entry.bindingId === id : false)
    return item ? { status: 200, body: { contract: 'mg-' + resource + 's/1', item } } : fail(404, resource + '_not_found', resource === 'model' ? '模型不存在' : '模型池不存在')
  }
  const isCreate = method === 'POST' && path === '/api/' + (resource === 'model' ? 'models' : resource === 'pool' ? 'pools' : resource === 'connection' ? 'connections' : resource === 'policy' ? 'policies' : 'harness-bindings')
  const isChange = ['PATCH', 'DELETE'].includes(method) && path.startsWith('/api/' + (resource === 'model' ? 'models' : resource === 'pool' ? 'pools' : resource === 'connection' ? 'connections' : 'harness-bindings') + '/')
  if (!isCreate && !isChange) return null
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
    if (!stored) return fail(428, token ? 'preview_expired' : 'confirmation_required', '预览不存在、已使用或已过期，请重新预览')
    if (stored.expiresAt <= now) { previews.delete(token); return fail(428, 'preview_expired', '预览已过期，请重新预览') }
  }
  const pathId = isCreate ? null : decode(path.split('/').at(-1))
  const expectedAction = resource === 'policy' ? 'policy.update' : resource === 'binding' && isCreate ? 'binding.create' : resource === 'binding' && method === 'PATCH' ? 'binding.update' : resource === 'binding' ? 'binding.delete' : isCreate ? resource + '.create' : method === 'PATCH' ? resource + '.update' : resource + '.delete'
  const idMatches = isCreate || (resource === 'model' ? stored.plan.name === pathId || stored.plan.modelId === pathId : resource === 'pool' ? stored.plan.poolId === pathId || stored.plan.before?.slug === pathId : resource === 'connection' ? stored.plan.connectionId === pathId : stored.plan.bindingId === pathId)
  if (stored.plan.resource !== resource || stored.plan.action !== expectedAction || !idMatches || body.previewId !== stored.previewId || body.expectedVersion !== stored.plan.expectedVersion || body.requestId !== stored.plan.requestId) return fail(409, 'preview_binding_mismatch', '预览与当前操作、资源、版本或 requestId 不匹配')
  const invalidPlan = configValidationFailure(ctx, stored.plan.payload)
  if (invalidPlan) return invalidPlan
  return executeApiWrite(ctx, {
    previews, receipts, previewId: stored.previewId, confirmToken: token,
    requestId: body.requestId, requestFingerprint,
    save: () => {
      const current = getConfig()
      if (stored.plan.action === 'model.delete') {
        const active = inFlightDeleteError(modelInFlightImpact(ctx.state?.inFlight, stored.plan.name, stored.plan.modelId), 'model_in_flight', '模型仍有在途请求，请等待完成后删除')
        if (active) return active
      }
      if (stored.plan.action === 'pool.delete') {
        const before = stored.plan.before || {}
        const active = inFlightDeleteError(poolInFlightImpact(ctx.state?.inFlight, [stored.plan.poolId, before.poolId, before.slug, before.name].filter(Boolean)), 'pool_in_flight', '模型池仍有在途请求，请等待完成后删除')
        if (active) return active
      }
      const prepared = prepareResourcePayload(stored.plan, current)
      if (prepared.error || prepared.conflict) return prepared
      return saveConfig(prepared.payload, stored.plan.expectedVersion)
    },
    responseFor: (result, operation) => {
      const next = getConfig()
      const items = viewList(resource, next, resource === 'connection' ? stored.plan.providerId : '')
      const id = stored.plan.id
      const item = resource === 'policy' ? effectivePolicy(next, { harnessId: stored.plan.scopeType === 'harness' ? stored.plan.scopeId : '', poolId: stored.plan.scopeType === 'pool' ? stored.plan.scopeId : '' }) : resource === 'binding' ? listHarnessBindings(next).map(publicHarnessBinding).find((entry) => entry.bindingId === id) || null : items.find((entry) => resource === 'model' ? entry.name === stored.plan.name || entry.modelId === id : resource === 'pool' ? entry.poolId === id || entry.slug === id : entry.connectionId === id) || null
      return { status: 200, body: { ok: true, contract: 'mg-' + resource + 's/1', requestId: body.requestId, item, configVersion: next.configVersion || 0, operation: operation ? publicApiOperation(operation) : { id: 'op_' + randomBytes(8).toString('hex'), state: 'succeeded', steps: [{ id: 'config-transaction', state: 'succeeded' }] } } }
    },
    failureFor: (result) => fail(result.conflict ? 409 : result.status || 400, result.conflict ? 'version_conflict' : result.code || 'resource_write_failed', result.error || result.message, result.conflict ? { currentVersion: result.currentVersion ?? (getConfig().configVersion || 0) } : undefined),
  })
}
