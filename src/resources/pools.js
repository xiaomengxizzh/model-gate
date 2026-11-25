import { randomBytes } from 'node:crypto'
import { poolInFlightImpact, inFlightDeleteError } from './in-flight.js'

const POOL_ID_RE = /^pool_[A-Za-z0-9_-]{16,64}$/
const SELECTIONS = new Set(['priority', 'weighted', 'round_robin'])
const PATCH_FIELDS = new Set([
  'poolId', 'slug', 'revision', 'name', 'enabled', 'selection', 'recoveryPolicyRef',
  'members', 'directory', 'quota', 'dailyQuota', 'maxContext', 'maxConcurrent', 'qps',
])
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype'])
const IN_FLIGHT_NOTE = '在途请求数量未知：当前控制面没有在途请求注册表。编辑或删除只影响新会话，不取消已启动请求；请在确认前检查应用侧活动会话。'

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function cleanText(value, max, label) {
  if (typeof value !== 'string' || !value.trim()) return { error: label + '不能为空' }
  const out = value.trim()
  if (out.length > max) return { error: label + '不能超过 ' + max + ' 个字符' }
  if (/[\0-\x1f]/.test(out)) return { error: label + '不能包含控制字符' }
  return { value: out }
}

function identityOf(pool) {
  const poolId = typeof pool?.poolId === 'string' && POOL_ID_RE.test(pool.poolId) ? pool.poolId : null
  const slug = typeof pool?.slug === 'string' && pool.slug.trim()
    ? pool.slug.trim()
    : poolId ? 'mg-pool-' + poolId.slice('pool_'.length) : String(pool?.name || '')
  return { poolId, slug }
}

function rawMembersOf(pool) {
  if (Array.isArray(pool?.members)) return pool.members
  if (Array.isArray(pool?.directory)) return pool.directory
  return []
}

function modelOf(member) {
  const modelId = typeof member?.modelId === 'string' ? member.modelId.trim() : ''
  const model = typeof member?.model === 'string' ? member.model.trim() : ''
  return modelId || model
}

export function orderPoolMembers(pool, opts = {}) {
  const members = rawMembersOf(pool).filter((member) => member?.enabled !== false).map((member, index) => ({ member, index }))
  if (pool.selection === 'priority') return members.sort((a, b) => (Number.isInteger(a.member.priority) ? a.member.priority : a.index) - (Number.isInteger(b.member.priority) ? b.member.priority : b.index)).map((entry) => entry.member)
  if (pool.selection === 'weighted') {
    const random = typeof opts.random === 'function' ? opts.random : Math.random
    return members.map((entry) => ({ ...entry, order: random() ** (1 / Math.max(1, Number(entry.member.weight) || 1)) })).sort((a, b) => a.order - b.order).map((entry) => entry.member)
  }
  if (pool.selection === 'round_robin') {
    if (!members.length) return []
    const cursor = Number.isInteger(opts.cursor) ? opts.cursor : 0
    const offset = ((cursor % members.length) + members.length) % members.length
    return [...members.slice(offset), ...members.slice(0, offset)].map((entry) => entry.member)
  }
  return members.map((entry) => entry.member)
}

function providerOf(member, model, cfg) {
  if (typeof member?.providerId === 'string' && member.providerId.trim()) return member.providerId.trim()
  if (Array.isArray(member?.providers) && typeof member.providers[0] === 'string' && member.providers[0].trim()) return member.providers[0].trim()
  return String(cfg?.models?.[model]?.provider || '')
}

// Public resource projection. Legacy virtual models remain readable without inventing a
// persisted identifier; the first update migrates them to a stable poolId/slug.
export function publicPool(pool, cfg = {}) {
  if (!object(pool)) return null
  const identity = identityOf(pool)
  const selection = SELECTIONS.has(pool.selection) ? pool.selection : 'priority'
  const members = rawMembersOf(pool).map((member, index) => {
    const model = modelOf(member)
    return {
      poolId: identity.poolId,
      modelId: model,
      model,
      providerId: providerOf(member, model, cfg),
      priority: Number.isInteger(member?.priority) && member.priority >= 0 ? member.priority : index,
      weight: Number.isInteger(member?.weight) && member.weight >= 0 ? member.weight : 0,
      enabled: member?.enabled !== false,
      constraints: object(member?.constraints) ? clone(member.constraints) : {},
    }
  })
  return {
    poolId: identity.poolId,
    slug: identity.slug,
    name: typeof pool.name === 'string' ? pool.name : '',
    enabled: pool.enabled !== false,
    selection,
    recoveryPolicyRef: typeof pool.recoveryPolicyRef === 'string' ? pool.recoveryPolicyRef : '',
    revision: Number.isInteger(pool.revision) && pool.revision >= 0 ? pool.revision : 0,
    members,
  }
}

function findPool(cfg, id) {
  const pools = Array.isArray(cfg?.virtualModels) ? cfg.virtualModels : []
  const index = pools.findIndex((pool) => {
    if (!object(pool)) return false
    const identity = identityOf(pool)
    return id === identity.poolId || id === identity.slug || (!identity.poolId && id === pool.name)
  })
  return { pool: index >= 0 ? pools[index] : null, index }
}

function containsPoolReference(value, refs, seen = new WeakSet()) {
  if (typeof value === 'string') return refs.includes(value)
  if (!object(value) || seen.has(value)) return false
  seen.add(value)
  if (typeof value.poolId === 'string' && refs.includes(value.poolId)) return true
  if (value.kind === 'pool' && typeof value.id === 'string' && refs.includes(value.id)) return true
  if (value.targetType === 'pool' && typeof value.targetId === 'string' && refs.includes(value.targetId)) return true
  return Object.values(value).some((entry) => containsPoolReference(entry, refs, seen))
}

function bindingLabel(key, binding) {
  if (!object(binding)) return String(key)
  const id = binding.bindingId || binding.harnessId || key
  return String(id) + (binding.instanceId ? ':' + binding.instanceId : '')
}

function emptyImpact() {
  return { codexBindings: [], harnessBindings: [], inFlight: { state: 'unknown', note: IN_FLIGHT_NOTE } }
}

// References are checked in both supported binding shapes. Names are not references for
// migrated pools; only a legacy pool without poolId falls back to its existing name.
export function poolImpact(cfg, id, opts = {}) {
  const found = findPool(cfg, id)
  const identity = identityOf(found.pool || {})
  const refs = [...new Set([
    found.pool ? id : null,
    identity.poolId,
    identity.slug,
    !identity.poolId && found.pool ? found.pool.name : null,
  ].filter(Boolean))]
  const impact = emptyImpact()
  const bindings = cfg?._codexCatalog?.bindings
  if (object(bindings)) {
    for (const [key, binding] of Object.entries(bindings)) {
      if (refs.includes(key) || containsPoolReference(binding, refs)) impact.codexBindings.push(key)
    }
  }
  const harnessBindings = cfg?.harnessBindings
  if (Array.isArray(harnessBindings)) {
    harnessBindings.forEach((binding, index) => {
      if (containsPoolReference(binding, refs)) impact.harnessBindings.push(bindingLabel(String(index), binding))
    })
  } else if (object(harnessBindings)) {
    for (const [key, binding] of Object.entries(harnessBindings)) {
      if (containsPoolReference(binding, refs)) impact.harnessBindings.push(bindingLabel(key, binding))
    }
  }
  impact.codexBindings = [...new Set(impact.codexBindings)]
  impact.harnessBindings = [...new Set(impact.harnessBindings)]
  impact.inFlight = poolInFlightImpact(opts.inFlight, refs)
  return impact
}

function routeNames(cfg) {
  const names = new Set(Object.keys(cfg?.models || {}))
  for (const model of Object.values(cfg?.models || {})) {
    for (const alias of (Array.isArray(model?.alias) ? model.alias : [])) if (typeof alias === 'string') names.add(alias)
  }
  if (typeof cfg?.defaults?.model === 'string') names.add(cfg.defaults.model)
  return names
}

function validateName(cfg, name, excludeIndex) {
  const checked = cleanText(name, 80, '模型池名称')
  if (checked.error) return checked
  if (RESERVED_IDS.has(checked.value)) return { error: '模型池名称是保留标识' }
  if (routeNames(cfg).has(checked.value)) return { error: '模型池名称与真实模型、别名或默认虚拟名冲突' }
  const duplicate = (Array.isArray(cfg?.virtualModels) ? cfg.virtualModels : []).some((pool, index) => index !== excludeIndex && pool?.name === checked.value)
  if (duplicate) return { error: '模型池名称已存在' }
  return checked
}

function newPoolId(cfg) {
  let id
  do { id = 'pool_' + randomBytes(12).toString('base64url') } while (findPool(cfg, id).pool || findPool(cfg, 'mg-pool-' + id.slice('pool_'.length)).pool)
  return id
}

function normalizeMembers(raw, selection, poolId, cfg, directory, stored = false) {
  if (!Array.isArray(raw)) return { error: 'members 必须是数组' }
  if (!raw.length) return { status: 422, code: 'pool_members_required', error: '模型池至少需要 1 个成员' }
  const members = []
  const entries = []
  const seen = new Set()
  for (let index = 0; index < raw.length; index++) {
    const input = raw[index]
    if (!object(input)) return { error: '成员 #' + (index + 1) + ' 必须是对象' }
    const modelId = typeof input.modelId === 'string' ? input.modelId.trim() : ''
    const model = typeof input.model === 'string' ? input.model.trim() : ''
    if (modelId && model && modelId !== model) return { error: '成员 #' + (index + 1) + ' 的 modelId 与 model 不一致' }
    const modelName = modelId || model
    if (!modelName) return { error: '成员 #' + (index + 1) + ' 必须提供 modelId 或 model' }
    if (!Object.hasOwn(cfg?.models || {}, modelName)) return { error: '成员 #' + (index + 1) + ' 引用的模型不存在: ' + modelName }
    const providerId = providerOf(input, modelName, cfg)
    if (!providerId) return { error: '成员 #' + (index + 1) + ' 无法确定 providerId' }
    if (providerId !== cfg.models[modelName]?.provider) return { error: '成员 #' + (index + 1) + ' 的 providerId 与模型 provider 不匹配' }
    if (!Object.hasOwn(cfg?.providers || {}, providerId)) return { error: '成员 #' + (index + 1) + ' 引用的 provider 不存在: ' + providerId }
    const priority = input.priority === undefined ? index : input.priority
    if (!Number.isInteger(priority) || priority < 0) return { error: '成员 #' + (index + 1) + ' 的 priority 必须是非负整数' }
    let weight = 0
    if (selection === 'weighted') {
      weight = input.weight
      if (!Number.isInteger(weight) || weight < 1 || weight > 100) return { error: 'weighted 模型池的成员 weight 必须是 1..100 的整数' }
    } else if (input.weight !== undefined && input.weight !== null && input.weight !== 0 && !stored) {
      return { error: '只有 weighted 模型池允许配置非零 weight' }
    }
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') return { error: '成员 #' + (index + 1) + ' 的 enabled 必须是布尔值' }
    if (input.constraints !== undefined && !object(input.constraints)) return { error: '成员 #' + (index + 1) + ' 的 constraints 必须是对象' }
    const key = modelName + '\0' + providerId
    if (seen.has(key)) return { error: '模型池成员重复: ' + modelName }
    seen.add(key)
    members.push({
      poolId,
      modelId: modelName,
      model: modelName,
      providerId,
      priority,
      weight,
      enabled: input.enabled !== false,
      constraints: clone(input.constraints || {}),
    })
    const previous = Array.isArray(directory) ? directory.find((entry) => entry?.model === modelName && (!Array.isArray(entry.providers) || entry.providers.includes(providerId))) : null
    entries.push({
      ...(previous ? clone(previous) : {}),
      model: modelName,
      mode: previous?.mode === 'onFail' ? 'onFail' : 'afterAll',
      enabled: input.enabled !== false,
      providers: previous && Array.isArray(previous.providers) && previous.providers.length ? [...previous.providers] : [providerId],
    })
  }
  return { members, directory: entries }
}

function normalizePatch(input, creating) {
  if (!object(input)) return { error: 'patch 必须是对象' }
  for (const key of Object.keys(input)) if (!PATCH_FIELDS.has(key)) return { error: '不支持的模型池字段: ' + key }
  return { patch: input }
}

function failure(status, code, error, details) {
  return { status, code, error, ...(details ? { details } : {}) }
}

// Preview-only planner. It never mutates cfg and deliberately returns the complete
// virtualModels array so the existing configuration transaction remains the sole writer.
export function planPool(cfg, body, opts = {}) {
  if (!object(body)) return failure(400, 'invalid_pool', '请求体必须是对象')
  const action = String(body.action || '')
  if (!['pool.create', 'pool.update', 'pool.delete'].includes(action)) return failure(400, 'unsupported_preview_action', '仅支持 pool.create/update/delete 预览')
  const expectedVersion = Number.isInteger(body.expectedVersion) ? body.expectedVersion : null
  if (expectedVersion === null || expectedVersion !== (cfg.configVersion || 0)) return failure(409, 'version_conflict', '配置版本已过期，请刷新后重试', { currentVersion: cfg.configVersion || 0 })
  if (typeof body.requestId !== 'string' || !body.requestId.trim() || body.requestId.length > 100) return failure(400, 'invalid_request_id', 'requestId 必填且不能超过 100 字符')

  const current = Array.isArray(cfg.virtualModels) ? cfg.virtualModels : []
  const creating = action === 'pool.create'
  const deleting = action === 'pool.delete'
  const normalized = creating ? normalizePatch(body.patch, true) : { patch: object(body.patch) ? body.patch : {} }
  if (normalized.error) return failure(400, 'invalid_pool', normalized.error)
  const patch = normalized.patch
  if (!creating) {
    for (const key of Object.keys(patch)) if (!PATCH_FIELDS.has(key)) return failure(400, 'invalid_pool', '不支持的模型池字段: ' + key)
  }

  let before = null
  let index = -1
  let poolId = null
  if (!creating) {
    if (typeof body.poolId !== 'string' || !body.poolId || RESERVED_IDS.has(body.poolId)) return failure(400, 'invalid_pool_id', 'poolId 必填')
    const found = findPool(cfg, body.poolId)
    if (!found.pool) return failure(404, 'pool_not_found', '模型池不存在')
    before = found.pool
    index = found.index
    poolId = identityOf(before).poolId
  }

  let impact = emptyImpact()
  if (deleting) {
    impact = poolImpact(cfg, body.poolId, opts)
    const active = inFlightDeleteError(impact.inFlight, 'pool_in_flight', '模型池仍有在途请求，请等待完成后删除')
    if (active) return active
    if (impact.codexBindings.length || impact.harnessBindings.length) return failure(422, 'pool_referenced', '模型池仍被 Codex 或应用绑定引用，请先解绑', impact)
  }

  let after = null
  if (!deleting) {
    poolId = poolId || newPoolId(cfg)
    const persistedSlug = typeof before?.slug === 'string' && before.slug.trim() ? before.slug.trim() : ''
    const slug = persistedSlug || 'mg-pool-' + poolId.slice('pool_'.length)
    const name = validateName(cfg, patch.name === undefined ? before?.name : patch.name, index)
    if (name.error) return failure(400, 'invalid_pool', name.error)
    const selection = patch.selection === undefined ? (SELECTIONS.has(before?.selection) ? before.selection : 'priority') : patch.selection
    if (!SELECTIONS.has(selection)) return failure(400, 'invalid_pool', 'selection 仅支持 priority、weighted 或 round_robin')
    if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') return failure(400, 'invalid_pool', 'enabled 必须是布尔值')
    const recoveryPolicyRef = patch.recoveryPolicyRef === undefined ? before?.recoveryPolicyRef : patch.recoveryPolicyRef
    if (recoveryPolicyRef !== undefined && recoveryPolicyRef !== null && typeof recoveryPolicyRef !== 'string') return failure(400, 'invalid_pool', 'recoveryPolicyRef 必须是字符串')
    if (typeof recoveryPolicyRef === 'string' && recoveryPolicyRef.length > 120) return failure(400, 'invalid_pool', 'recoveryPolicyRef 不能超过 120 个字符')

    const hasMemberPatch = Object.hasOwn(patch, 'members') || Object.hasOwn(patch, 'directory')
    const rawMembers = hasMemberPatch ? (patch.members === undefined ? patch.directory : patch.members) : rawMembersOf(before || {})
    const rawDirectory = hasMemberPatch && Array.isArray(patch.directory) ? patch.directory : before?.directory
    const normalizedMembers = normalizeMembers(rawMembers, selection, poolId, cfg, rawDirectory, !hasMemberPatch)
    if (normalizedMembers.status) return failure(normalizedMembers.status, normalizedMembers.code, normalizedMembers.error)
    if (normalizedMembers.error) return failure(400, 'invalid_pool_member', normalizedMembers.error)

    after = creating ? {
      quota: 0, dailyQuota: 0, maxContext: 0, maxConcurrent: 0, qps: 0,
    } : clone(before)
    after.poolId = poolId
    after.slug = slug
    after.name = name.value
    after.enabled = patch.enabled === undefined ? before?.enabled !== false : patch.enabled
    after.selection = selection
    after.recoveryPolicyRef = String(recoveryPolicyRef || '').trim()
    after.revision = creating ? 1 : (Number.isInteger(before?.revision) && before.revision >= 0 ? before.revision + 1 : 1)
    after.members = normalizedMembers.members
    after.directory = hasMemberPatch ? normalizedMembers.directory : clone(before?.directory || normalizedMembers.directory)
    for (const key of ['quota', 'dailyQuota', 'maxContext', 'maxConcurrent', 'qps']) {
      if (Object.hasOwn(patch, key)) after[key] = clone(patch[key])
    }
    if (!deleting && (action === 'pool.update' || action === 'pool.create')) impact = poolImpact(cfg, poolId, opts)
  }

  const virtualModels = clone(current)
  if (creating) virtualModels.push(after)
  else if (deleting) virtualModels.splice(index, 1)
  else virtualModels[index] = after
  const now = Number.isFinite(opts.now) ? opts.now : Date.now()
  return {
    status: 200,
    plan: {
      action,
      poolId,
      expectedVersion,
      requestId: body.requestId,
      before: before ? publicPool(before, cfg) : null,
      after: after ? publicPool(after, cfg) : null,
      impact,
      payload: { expectedVersion, virtualModels },
      expiresAt: new Date(now + 300000).toISOString(),
    },
  }
}
