import { randomBytes } from 'node:crypto'

const RESERVED = new Set(['__proto__', 'constructor', 'prototype'])
const HARNESSES = new Set(['codex', 'claude-code', 'opencode', 'dsh'])
const MODES = new Set(['official', 'route', 'aggregated', 'api'])
const ROLES = new Set(['parent', 'child', 'route'])
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function clean(value, max, label) { return typeof value === 'string' && value.trim() && value.trim().length <= max && !/[\0-\x1f]/.test(value) ? { value: value.trim() } : { error: label + '格式或长度非法' } }
function failure(status, code, error, details) { return { status, code, error, ...(details ? { details } : {}) } }
function targetValid(cfg, target) {
  if (!object(target) || !['native', 'model', 'pool'].includes(target.kind)) return false
  const id = String(target.id || '').trim()
  if (!id || RESERVED.has(id)) return false
  if (target.kind === 'native') return true
  if (target.kind === 'model') return Object.entries(cfg.models || {}).some(([name, def]) => (name === id || def.modelId === id) && def.enabled !== false)
  return (cfg.virtualModels || []).some((pool) => (pool.poolId === id || pool.slug === id || pool.name === id) && pool.enabled !== false)
}
export function listHarnessBindings(cfg) { return Object.values(cfg.harnessBindings || {}).filter(object) }
export function publicHarnessBinding(binding) { return binding ? { ...structuredClone(binding), desiredRevision: binding.desiredRevision || 1, appliedRevision: binding.appliedRevision || 0, verifiedRevision: binding.verifiedRevision || 0, verification: 'desired-only' } : null }
function normalize(input, creating, before) {
  if (!object(input)) return { error: 'patch 必须是对象' }
  const allowed = new Set(['harnessId', 'instanceId', 'mode', 'roleTargets', 'policyRef'])
  for (const key of Object.keys(input)) if (!allowed.has(key)) return { error: '不支持的绑定字段: ' + key }
  const out = {}
  for (const key of ['harnessId', 'instanceId', 'policyRef']) {
    if (input[key] !== undefined || creating) {
      const raw = input[key] || (key === 'policyRef' ? '' : key === 'instanceId' ? 'default' : '')
      const value = key === 'policyRef' && !raw ? { value: '' } : clean(raw, 120, key)
      if (value.error) return value
      out[key] = value.value
    }
  }
  const harnessId = out.harnessId || before?.harnessId
  if (!HARNESSES.has(harnessId)) return { error: 'harnessId 不在支持集合' }
  const mode = input.mode !== undefined ? input.mode : creating ? 'api' : before?.mode
  if (!MODES.has(mode)) return { error: 'mode 非法' }
  out.mode = mode
  const roles = input.roleTargets !== undefined ? input.roleTargets : creating ? {} : before?.roleTargets
  if (!object(roles)) return { error: 'roleTargets 必须是对象' }
  out.roleTargets = {}
  for (const role of Object.keys(roles)) {
    if (!ROLES.has(role)) return { error: '不支持的接入角色: ' + role }
    if (roles[role] !== null) out.roleTargets[role] = structuredClone(roles[role])
  }
  return { value: out }
}
export function planHarnessBinding(cfg, body, opts = {}) {
  if (!object(body)) return failure(400, 'invalid_binding', '请求体必须是对象')
  const action = String(body.action || '')
  if (!['binding.create', 'binding.update', 'binding.delete'].includes(action)) return failure(400, 'unsupported_preview_action', '仅支持 binding.create/update/delete')
  if (!Number.isInteger(body.expectedVersion) || body.expectedVersion !== (cfg.configVersion || 0)) return failure(409, 'version_conflict', '配置版本已过期', { currentVersion: cfg.configVersion || 0 })
  if (typeof body.requestId !== 'string' || !body.requestId || body.requestId.length > 100) return failure(400, 'invalid_request_id', 'requestId 必填')
  const bindings = { ...(cfg.harnessBindings || {}) }
  let before = null
  let bindingId = body.bindingId
  if (action !== 'binding.create') {
    if (typeof bindingId !== 'string' || !bindings[bindingId]) return failure(404, 'binding_not_found', '应用绑定不存在')
    before = bindings[bindingId]
  } else bindingId = 'bind_' + randomBytes(12).toString('base64url')
  let after = null
  if (action !== 'binding.delete') {
    const normalized = normalize(body.patch, action === 'binding.create', before)
    if (normalized.error) return failure(400, 'invalid_binding', normalized.error)
    after = { ...(before ? structuredClone(before) : {}), ...normalized.value, bindingId, desiredRevision: (before?.desiredRevision || 0) + 1, appliedRevision: before?.appliedRevision || 0, verifiedRevision: before?.verifiedRevision || 0 }
    for (const target of Object.values(after.roleTargets)) if (!targetValid(cfg, target)) return failure(422, 'binding_target_unavailable', '绑定目标不存在、已停用或不是稳定 model/pool ID')
    if (after.mode === 'official' && Object.keys(after.roleTargets).some((role) => role !== 'parent')) return failure(422, 'official_target_forbidden', '官方直连只允许官方父目标')
  }
  if (after) bindings[bindingId] = after
  else delete bindings[bindingId]
  return { status: 200, plan: { action, bindingId, expectedVersion: body.expectedVersion, requestId: body.requestId, before: publicHarnessBinding(before), after: publicHarnessBinding(after), impact: { inFlight: 'fixed-generation; existing requests are not cancelled', application: after?.harnessId || before?.harnessId || null }, payload: { expectedVersion: body.expectedVersion, harnessBindings: bindings }, expiresAt: new Date((opts.now || Date.now()) + 300000).toISOString() } }
}
