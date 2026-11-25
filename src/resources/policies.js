import { redactDefaultsForConfig } from './redaction.js'

const BUDGET_KEYS = ['maxTotalAttempts', 'maxFailovers', 'maxRecoveryAttempts', 'maxWaitMs', 'maxElapsedMs', 'maxAttemptsPerCandidate']
const RETRY_KEYS = ['maxAttempts', 'initialDelayMs', 'maxDelayMs', 'jitter']
const TIMEOUT_KEYS = ['connectMs', 'firstByteMs', 'idleMs', 'loopMs', 'overallMs']
const CONCURRENCY_KEYS = ['maxPerProvider', 'affinityTtlMs']
const GROUPS = { requestBudget: BUDGET_KEYS, retry: RETRY_KEYS, timeout: TIMEOUT_KEYS, concurrency: CONCURRENCY_KEYS }
const SECRET_PATCH_KEYS = new Set(['extraheaders', 'proxy', 'baseurl', 'clientkey', 'apikey', 'sessionhmacsecret', 'authorization', 'token', 'secret', 'credential', 'credentials', 'password'])
function secretPatchKey(key) { return SECRET_PATCH_KEYS.has(String(key).toLowerCase().replace(/[-_]/g, '')) }
function credentialChannelError() { return { code: 'credential_channel_required', error: '凭据变更必须使用独立凭据通道' } }

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function own(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key) }
function finite(value) { return Number.isFinite(Number(value)) }
function validateOverrides(input) {
  if (!object(input)) return { error: 'overrides 必须是对象' }
  if (Object.keys(input).some(secretPatchKey)) return credentialChannelError()
  const out = {}
  for (const [group, keys] of Object.entries(GROUPS)) {
    if (input[group] === undefined) continue
    if (!object(input[group])) return { error: group + ' 必须是对象' }
    if (Object.keys(input[group]).some(secretPatchKey)) return credentialChannelError()
    out[group] = {}
    for (const key of keys) {
      if (!own(input[group], key)) continue
      const value = input[group][key]
      if (group === 'requestBudget' && key === 'maxElapsedMs' && value === null) { out[group][key] = null; continue }
      if (!finite(value) || Number(value) < 0) return { error: group + '.' + key + ' 必须是非负数' }
      out[group][key] = Number(value)
    }
  }
  return { value: out }
}
function mergeGroup(base, override, mode) {
  const out = { ...base }
  for (const [key, value] of Object.entries(override || {})) {
    if (value === null) { out[key] = null; continue }
    out[key] = mode === 'min' && finite(out[key]) ? Math.min(Number(out[key]), Number(value)) : mode === 'max' ? Math.max(Number(out[key]) || 0, Number(value)) : Number(value)
  }
  return out
}
function policyKey(scopeType, scopeId) { return scopeType + ':' + scopeId }

export function effectivePolicy(cfg, query = {}) {
  const defaults = cfg.defaults || {}
  const result = {
    requestBudget: { ...(defaults.requestBudget || {}) },
    retry: { ...(defaults.retry || {}) },
    timeout: { ...(defaults.timeout || {}) },
    concurrency: { ...(defaults.concurrency || {}) },
  }
  const sources = [{ scopeType: 'global', scopeId: 'global', source: 'defaults' }]
  const policies = cfg.policies && typeof cfg.policies === 'object' ? cfg.policies : {}
  for (const scope of [{ scopeType: 'harness', scopeId: query.harnessId }, { scopeType: 'pool', scopeId: query.poolId }]) {
    if (!scope.scopeId) continue
    const policy = policies[policyKey(scope.scopeType, scope.scopeId)] || policies[scope.scopeId]
    if (!object(policy?.overrides)) continue
    const checked = validateOverrides(policy.overrides)
    if (checked.error) continue
    for (const group of Object.keys(GROUPS)) result[group] = mergeGroup(result[group], checked.value[group], group === 'concurrency' ? 'max' : 'min')
    sources.push({ ...scope, source: 'policy', revision: policy.revision || 0 })
  }
  result.hardConstraints = { officialTargetsNeverEnterThirdPartyPool: true, routeModeGptOutbound: 0, replayToolsOrUnknownSubmission: false, crossIdentityQuotaBypass: false, nativeCompactionOwner: 'codex' }
  return { contract: 'mg-policy/1', effective: result, sources, calibration: 'fixture-verified; production-traffic-calibration-pending' }
}

export function planPolicy(cfg, body, opts = {}) {
  if (!object(body)) return { status: 400, code: 'invalid_policy', error: '请求体必须是对象' }
  if (body.action !== 'policy.update') return { status: 400, code: 'unsupported_preview_action', error: '仅支持 policy.update' }
  if (!Number.isInteger(body.expectedVersion) || body.expectedVersion !== (cfg.configVersion || 0)) return { status: 409, code: 'version_conflict', error: '配置版本已过期', details: { currentVersion: cfg.configVersion || 0 } }
  if (typeof body.requestId !== 'string' || !body.requestId || body.requestId.length > 100) return { status: 400, code: 'invalid_request_id', error: 'requestId 必填' }
  const scopeType = String(body.scopeType || '')
  if (!['global', 'harness', 'pool'].includes(scopeType)) return { status: 400, code: 'invalid_scope', error: 'scopeType 仅支持 global/harness/pool' }
  const scopeId = scopeType === 'global' ? 'global' : String(body.scopeId || '').trim()
  if (!scopeId || /[\0-\x1f]/.test(scopeId) || scopeId.length > 120) return { status: 400, code: 'invalid_scope', error: 'scopeId 非法' }
  const checked = validateOverrides(body.overrides)
  if (checked.error) return { status: 400, code: checked.code || 'invalid_policy', error: checked.error }
  const key = policyKey(scopeType, scopeId)
  const before = scopeType === 'global' ? { requestBudget: cfg.defaults?.requestBudget || {}, retry: cfg.defaults?.retry || {}, timeout: cfg.defaults?.timeout || {}, concurrency: cfg.defaults?.concurrency || {} } : cfg.policies?.[key] || null
  let payload
  if (scopeType === 'global') {
    const defaults = { ...(cfg.defaults || {}) }
    for (const [group, values] of Object.entries(checked.value)) defaults[group] = { ...(defaults[group] || {}), ...values }
    // Defaults are cloned into a durable plan; credentials must remain masks
    // until the save callback restores them from the current generation.
    payload = { expectedVersion: body.expectedVersion, defaults: redactDefaultsForConfig(defaults) }
  } else {
    const policies = { ...(cfg.policies && typeof cfg.policies === 'object' ? cfg.policies : {}) }
    policies[key] = { scopeType, scopeId, overrides: checked.value, revision: (policies[key]?.revision || 0) + 1 }
    payload = { expectedVersion: body.expectedVersion, policies }
  }
  return { status: 200, plan: { action: body.action, policyId: key, scopeType, scopeId, expectedVersion: body.expectedVersion, requestId: body.requestId, before, after: checked.value, impact: { inFlight: 'fixed-generation; new requests only' }, payload, expiresAt: new Date((opts.now || Date.now()) + 300000).toISOString() } }
}
