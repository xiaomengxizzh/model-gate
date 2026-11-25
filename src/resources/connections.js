import { randomBytes } from 'node:crypto'
import { resolveKey } from '../router.js'
import { redactConnectionForConfig, redactProviderForConfig } from './redaction.js'

const ID_RE = /^conn_[A-Za-z0-9_-]{16,64}$/
const RESERVED = new Set(['__proto__', 'constructor', 'prototype'])
const PATCH_FIELDS = new Set(['displayName', 'enabled', 'priority', 'maxConcurrent', 'quotaScopeId', 'authDomain', 'modelIds'])

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function clone(value) { return value === undefined ? undefined : structuredClone(value) }
function clean(value, max, label, allowEmpty = false) {
  if (value === undefined && allowEmpty) return { value: '' }
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) return { error: label + '不能为空' }
  const out = value.trim()
  if (out.length > max || /[\0-\x1f]/.test(out)) return { error: label + '格式或长度非法' }
  return { value: out }
}
function failure(status, code, error, details) { return { status, code, error, ...(details ? { details } : {}) } }
function listOf(provider) { return Array.isArray(provider?.connections) ? provider.connections.filter(object) : [] }
function findConnection(provider, id) {
  const index = listOf(provider).findIndex((connection) => connection.connectionId === id || (!ID_RE.test(String(connection.connectionId || '')) && connection.id === id))
  return { connection: index >= 0 ? listOf(provider)[index] : null, index }
}
export function publicConnection(providerId, provider, connection, cfg = {}) {
  if (!object(connection)) return null
  const connectionId = ID_RE.test(String(connection.connectionId || '')) ? connection.connectionId : 'legacy:' + providerId + ':' + String(connection.id || connection.connectionId || 'default')
  const keyId = typeof connection.credentialKeyId === 'string' && connection.credentialKeyId ? connection.credentialKeyId : connectionId
  return {
    connectionId,
    providerId,
    displayName: connection.displayName || connection.id || connectionId,
    enabled: connection.enabled !== false,
    priority: Number.isInteger(connection.priority) ? connection.priority : 0,
    maxConcurrent: Number.isInteger(connection.maxConcurrent) && connection.maxConcurrent > 0 ? connection.maxConcurrent : 0,
    quotaScopeId: connection.quotaScopeId || '',
    authDomain: connection.authDomain || '',
    modelIds: Array.isArray(connection.modelIds) ? [...connection.modelIds] : [],
    credentialConfigured: !!resolveKey(cfg, { apiKeyEnv: connection.apiKeyEnv }, keyId).key,
    verification: 'configured',
    credentialKeyId: keyId,
  }
}
export function listConnections(cfg, providerId) {
  const provider = cfg.providers?.[providerId]
  return Object.hasOwn(cfg.providers || {}, providerId) ? listOf(provider).map((connection) => publicConnection(providerId, provider, connection, cfg)).filter(Boolean) : []
}
function normalizePatch(input, creating, prior) {
  if (!object(input)) return { error: 'patch 必须是对象' }
  for (const key of Object.keys(input)) if (!PATCH_FIELDS.has(key)) return { error: '不支持的连接字段: ' + key }
  const out = {}
  if (input.displayName !== undefined || creating) {
    const value = clean(input.displayName, 80, '连接显示名')
    if (value.error) return value
    out.displayName = value.value
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') return { error: 'enabled 必须是布尔值' }
    out.enabled = input.enabled
  } else if (creating) out.enabled = true
  if (input.priority !== undefined) {
    if (!Number.isInteger(input.priority) || input.priority < 0) return { error: 'priority 必须是非负整数' }
    out.priority = input.priority
  } else if (creating) out.priority = 0
  if (input.maxConcurrent !== undefined) {
    if (!Number.isInteger(input.maxConcurrent) || input.maxConcurrent < 0) return { error: 'maxConcurrent 必须是非负整数' }
    out.maxConcurrent = input.maxConcurrent
  } else if (creating) out.maxConcurrent = 0
  for (const key of ['quotaScopeId', 'authDomain']) {
    if (input[key] !== undefined || creating) {
      const value = clean(input[key] || '', 100, key, true)
      if (value.error) return value
      out[key] = value.value
    }
  }
  if (input.modelIds !== undefined) {
    if (!Array.isArray(input.modelIds) || input.modelIds.some((id) => typeof id !== 'string' || !id)) return { error: 'modelIds 必须是非空字符串数组' }
    out.modelIds = [...new Set(input.modelIds)]
  } else if (creating) out.modelIds = []
  return { patch: out }
}

export function planConnection(cfg, body, opts = {}) {
  if (!object(body)) return failure(400, 'invalid_connection', '请求体必须是对象')
  const action = String(body.action || '')
  if (!['connection.create', 'connection.update', 'connection.delete'].includes(action)) return failure(400, 'unsupported_preview_action', '仅支持 connection.create/update/delete')
  if (!Number.isInteger(body.expectedVersion) || body.expectedVersion !== (cfg.configVersion || 0)) return failure(409, 'version_conflict', '配置版本已过期', { currentVersion: cfg.configVersion || 0 })
  if (typeof body.requestId !== 'string' || !body.requestId || body.requestId.length > 100) return failure(400, 'invalid_request_id', 'requestId 必填')
  const providerId = body.providerId
  if (typeof providerId !== 'string' || RESERVED.has(providerId) || !Object.hasOwn(cfg.providers || {}, providerId)) return failure(404, 'service_not_found', '服务不存在')
  const beforeProvider = cfg.providers[providerId]
  const current = listOf(beforeProvider)
  let before = null
  let index = -1
  let connectionId = null
  if (action !== 'connection.create') {
    if (typeof body.connectionId !== 'string' || RESERVED.has(body.connectionId)) return failure(400, 'invalid_connection_id', 'connectionId 必填')
    const found = findConnection(beforeProvider, body.connectionId)
    if (!found.connection) return failure(404, 'connection_not_found', '连接不存在')
    before = found.connection; index = found.index
    connectionId = ID_RE.test(String(before.connectionId || '')) ? before.connectionId : 'conn_' + randomBytes(12).toString('base64url')
  } else connectionId = 'conn_' + randomBytes(12).toString('base64url')

  let after = null
  let impact = { enabledConnections: current.filter((item) => item.enabled !== false).length, models: Object.keys(cfg.models || {}).filter((name) => cfg.models[name].provider === providerId).length }
  if (action === 'connection.delete') {
    if (!['delete', 'retain'].includes(body.credentialAction)) return failure(400, 'credential_action_required', '必须明确凭据处理方式')
    if (before.enabled !== false && impact.enabledConnections <= 1) return failure(422, 'last_connection_required', '不能删除服务最后一个启用连接')
  } else {
    const normalized = normalizePatch(body.patch, action === 'connection.create', before)
    if (normalized.error) return failure(400, 'invalid_connection', normalized.error)
    after = { ...(before ? clone(before) : {}), ...normalized.patch, connectionId, credentialKeyId: before?.credentialKeyId || connectionId, providerId }
    if (after.enabled !== false && current.filter((item, i) => i !== index && item.enabled !== false).length === 0) after.priority = after.priority || 0
    if (before?.enabled !== false && after.enabled === false && impact.enabledConnections <= 1) return failure(422, 'last_connection_required', '不能停用服务最后一个启用连接')
  }
  const connections = current.map(clone)
  if (action === 'connection.create') connections.push(after)
  else if (action === 'connection.delete') connections.splice(index, 1)
  else connections[index] = after
  // Durable previews must never inherit provider credentials. The commit path
  // restores these masks from the then-current config generation.
  const providers = Object.fromEntries(Object.entries(cfg.providers || {}).map(([id, provider]) => [id, redactProviderForConfig(clone(provider))]))
  providers[providerId] = { ...providers[providerId], connections: connections.map((connection) => redactConnectionForConfig(connection)) }
  const payload = { expectedVersion: body.expectedVersion, providers }
  if (action === 'connection.delete' && body.credentialAction === 'delete') payload.deleteConnectionCredentials = [before?.credentialKeyId || connectionId]
  const viewCfg = { ...cfg, providers }
  return { status: 200, plan: { action, providerId, connectionId, expectedVersion: body.expectedVersion, requestId: body.requestId, before: before ? publicConnection(providerId, beforeProvider, before, cfg) : null, after: after ? publicConnection(providerId, providers[providerId], after, viewCfg) : null, impact, credentialAction: action === 'connection.delete' ? body.credentialAction : 'unchanged', payload, expiresAt: new Date((opts.now || Date.now()) + 300000).toISOString() } }
}

export function selectConnection(state, cfg, providerId, now = Date.now(), modelId = '') {
  const provider = cfg.providers?.[providerId]
  const connections = listOf(provider)
  if (!connections.length) return { connection: null, unavailable: false }
  const eligible = connections.filter((connection) => {
    if (connection.enabled === false) return false
    if (Array.isArray(connection.modelIds) && connection.modelIds.length && modelId && !connection.modelIds.includes(modelId)) return false
    const id = ID_RE.test(String(connection.connectionId || '')) ? connection.connectionId : connection.id
    const keyId = connection.credentialKeyId || id
    const health = state.connectionHealth?.[providerId + ':' + id]
    if (health && health.openUntil > now) return false
    return !!resolveKey(cfg, { apiKeyEnv: connection.apiKeyEnv }, keyId).key
  }).sort((a, b) => (Number.isInteger(a.priority) ? a.priority : 0) - (Number.isInteger(b.priority) ? b.priority : 0))
  if (!eligible.length) return { connection: null, unavailable: true }
  const samePriority = eligible.filter((item) => (Number.isInteger(item.priority) ? item.priority : 0) === (Number.isInteger(eligible[0].priority) ? eligible[0].priority : 0))
  const key = providerId + ':cursor'
  const cursor = state.connectionCursors?.[key] || 0
  state.connectionCursors ||= {}
  state.connectionCursors[key] = cursor + 1
  return { connection: samePriority[cursor % samePriority.length], unavailable: false }
}
