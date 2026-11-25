import { randomBytes } from 'node:crypto'
import { resolveKey } from '../router.js'
import { redactProviderForConfig } from './redaction.js'
import { serviceInFlightImpact, inFlightDeleteError } from './in-flight.js'
import { validateEndpointNetwork } from './network-policy.js'

const APIS = new Set(['openai', 'responses', 'anthropic', 'gemini', 'cohere'])
const ID_RE = /^svc_[A-Za-z0-9_-]{16,64}$/

function text(value, max, label) {
  if (typeof value !== 'string' || !value.trim()) return { error: label + '不能为空' }
  const out = value.trim()
  if (out.length > max) return { error: label + '不能超过 ' + max + ' 个字符' }
  return { value: out }
}

export async function validateEndpoint(raw, opts = {}) {
  return validateEndpointNetwork(raw, opts)
}

export function serviceIdOf(id, provider) {
  if (provider && typeof provider.serviceId === 'string' && ID_RE.test(provider.serviceId)) return provider.serviceId
  return 'legacy:' + String(id)
}

export function publicService(id, provider, cfg) {
  const models = Object.values(cfg.models || {}).filter((model) => model.provider === id)
  return {
    serviceId: serviceIdOf(id, provider),
    providerId: id,
    displayName: provider.displayName || id,
    endpoint: provider.baseUrl || '',
    api: provider.api || 'openai',
    region: provider.region || '',
    enabled: provider.enabled !== false,
    allowPrivateNetwork: provider.allowPrivateNetwork === true,
    templateId: provider.templateId || null,
    credentialConfigured: !!resolveKey(cfg, provider, id).key,
    modelCount: models.length,
    connectionCount: Array.isArray(provider.connections) ? provider.connections.length : 0,
    lifecycle: 'configured',
    verification: 'configured',
  }
}

export function serviceImpact(cfg, id, opts = {}) {
  const models = Object.entries(cfg.models || {}).filter(([, model]) => model.provider === id).map(([name]) => name)
  const pools = (cfg.virtualModels || []).filter((pool) => (pool.directory || []).some((entry) => entry.model && cfg.models?.[entry.model]?.provider === id)).map((pool) => pool.name)
  const directPools = (cfg.virtualModels || []).filter((pool) => (pool.directory || []).some((entry) => (entry.providers || []).includes(id))).map((pool) => pool.name)
  const bindings = Object.values(cfg._codexCatalog?.bindings || {}).filter((binding) => binding.provider === id).map((binding) => binding.slug)
  const aggregations = Object.entries(cfg.providers || {}).filter(([providerId, provider]) => providerId !== id && provider.aggregation).map(([providerId]) => providerId)
  return {
    models,
    pools: [...new Set([...pools, ...directPools])],
    codexBindings: bindings,
    aggregationProviders: aggregations,
    credentialPresent: !!(cfg._keys && cfg._keys[id]),
    connections: Array.isArray(cfg.providers?.[id]?.connections) ? cfg.providers[id].connections.length : 0,
    inFlight: serviceInFlightImpact(opts.inFlight, id),
  }
}

async function normalizePatch(input, creating, prior, opts) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'patch 必须是对象' }
  const allowed = new Set(['displayName', 'endpoint', 'api', 'region', 'allowPrivateNetwork', 'templateId', 'enabled'])
  for (const key of Object.keys(input)) if (!allowed.has(key)) return { error: '不支持的服务字段: ' + key }
  const patch = {}
  if (input.displayName !== undefined || creating) {
    const name = text(input.displayName, 80, '服务显示名称')
    if (name.error) return name
    patch.displayName = name.value
  }
  if (input.allowPrivateNetwork !== undefined && typeof input.allowPrivateNetwork !== 'boolean') {
    return { error: 'allowPrivateNetwork 必须是布尔值' }
  }
  const allowPrivateNetwork = input.allowPrivateNetwork === undefined
    ? prior?.allowPrivateNetwork === true
    : input.allowPrivateNetwork
  const endpoint = await validateEndpointNetwork(input.endpoint === undefined ? prior?.baseUrl : input.endpoint, {
    allowPrivateNetwork,
    lookup: opts.lookup,
    timeoutMs: opts.timeoutMs,
  })
  if (endpoint.error) return endpoint
  patch.baseUrl = endpoint.value
  patch.allowPrivateNetwork = allowPrivateNetwork
  if (input.api !== undefined || creating) {
    const api = String(input.api || 'openai')
    if (!APIS.has(api)) return { error: '不支持的协议: ' + api }
    patch.api = api
  }
  if (input.region !== undefined || creating) {
    if (input.region != null && typeof input.region !== 'string') return { error: '区域必须是字符串' }
    const region = String(input.region || '').trim()
    if (region.length > 40) return { error: '区域不能超过 40 个字符' }
    patch.region = region
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') return { error: 'enabled 必须是布尔值' }
    patch.enabled = input.enabled
  } else if (creating) patch.enabled = true
  if (input.templateId !== undefined) {
    const templateId = text(input.templateId, 100, 'templateId')
    if (templateId.error) return templateId
    patch.templateId = templateId.value
  }
  return { patch }
}

export async function planService(cfg, body, opts = {}) {
  const action = String(body.action || '')
  if (!['service.create', 'service.update', 'service.delete'].includes(action)) return { status: 400, code: 'unsupported_preview_action', error: '仅支持 service.create/update/delete 预览' }
  if (!Number.isInteger(body.expectedVersion) || body.expectedVersion !== (cfg.configVersion || 0)) return { status: 409, code: 'version_conflict', error: '配置版本已过期，请刷新后重试', currentVersion: cfg.configVersion || 0 }
  if (typeof body.requestId !== 'string' || !body.requestId.trim() || body.requestId.length > 100) return { status: 400, code: 'invalid_request_id', error: 'requestId 必填且不能超过 100 字符' }
  let id = body.serviceId
  let before = null
  let after = null
  let impact = { models: [], pools: [], codexBindings: [], aggregationProviders: [], credentialPresent: false }
  if (action === 'service.create') {
    id = 'svc_' + randomBytes(12).toString('base64url')
    const normalized = await normalizePatch(body.patch, true, null, opts)
    if (normalized.error) return { status: 400, code: 'invalid_service', error: normalized.error }
    after = { serviceId: id, displayName: normalized.patch.displayName, baseUrl: normalized.patch.baseUrl, api: normalized.patch.api, region: normalized.patch.region, enabled: normalized.patch.enabled !== false, allowPrivateNetwork: normalized.patch.allowPrivateNetwork, ...(normalized.patch.templateId ? { templateId: normalized.patch.templateId } : {}) }
  } else {
    if (typeof id !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(id) || !Object.hasOwn(cfg.providers || {}, id)) return { status: 404, code: 'service_not_found', error: '服务不存在' }
    before = cfg.providers[id]
    impact = serviceImpact(cfg, id, opts)
    if (action === 'service.delete') {
      const active = inFlightDeleteError(impact.inFlight, 'service_in_flight', '服务仍有在途请求，请等待完成后删除')
      if (active) return active
    }
    if (action === 'service.update') {
      const normalized = await normalizePatch(body.patch, false, before, opts)
      if (normalized.error) return { status: 400, code: 'invalid_service', error: normalized.error }
      after = { ...before, ...normalized.patch }
    } else {
      if (!['delete', 'retain'].includes(body.credentialAction)) return { status: 400, code: 'credential_action_required', error: '删除服务必须明确选择 delete 或 retain 凭据' }
      if (impact.models.length || impact.pools.length || impact.codexBindings.length || impact.aggregationProviders.length || impact.connections) return { status: 422, code: 'service_referenced', error: '服务仍被模型、模型池、Codex 目录或聚合配置引用', details: impact }
      after = null
    }
  }
  const providers = Object.fromEntries(Object.entries(cfg.providers || {}).map(([providerId, provider]) => [providerId, redactProviderForConfig(provider)]))
  if (after) providers[id] = redactProviderForConfig(after)
  else delete providers[id]
  const payload = { expectedVersion: body.expectedVersion, providers }
  if (action === 'service.delete' && body.credentialAction === 'delete') payload.deleteProviderCredentials = [id]
  return {
    status: 200,
    plan: {
      action,
      serviceId: id,
      expectedVersion: body.expectedVersion,
      requestId: body.requestId,
      before: before ? publicService(id, before, cfg) : null,
      after: after ? publicService(id, after, { ...cfg, providers }) : null,
      impact,
      credentialAction: action === 'service.delete' ? body.credentialAction : 'unchanged',
      payload,
      expiresAt: new Date((opts.now || Date.now()) + 300000).toISOString(),
    },
  }
}
