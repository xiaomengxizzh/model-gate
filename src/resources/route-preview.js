// G11 zero-upstream route preview. The legacy {model} projection is kept byte-for-byte;
// extended previews consume the execution router, routing decision kernel and RequestLedger.
import { decide, rankCandidates, PHASE, ERROR_CLASS } from '../routing/decision.js'
import { candidate, evidence, FACT_SOURCE, budgetFromLedger } from '../routing/facts.js'
import { RequestLedger } from './request-ledger.js'
import { effectivePolicy } from './policies.js'
import { publicModel } from './models.js'
import { orderPoolMembers } from './pools.js'
import { listConnections } from './connections.js'
import { buildProvider, codexBindingFor, modelTarget, resolveKey } from '../router.js'
import { classifyTarget } from '../codex/identity.js'
import { targetDeny } from '../codex/auth.js'
import { goCodexToolDefaults } from '../providers/opencode-go.js'
import { todayKey } from '../shared.js'

const CAPABILITIES = new Set(['chat', 'embedding', 'rerank', 'audio', 'image', 'video'])
const SCENARIOS = new Set(['normal', 'failover', 'recovery', 'cancel', 'quota'])
const ROLE_NAMES = new Set(['official', 'route', 'aggregated', 'parent', 'child', 'route'])
const TARGET_KINDS = new Set(['native', 'model', 'pool'])
const LEDGER_KEYS = new Set(['maxTotalAttempts', 'maxFailovers', 'maxRecoveryAttempts', 'maxWaitMs', 'maxElapsedMs', 'maxAttemptsPerCandidate'])
const MONEY_KEYS = new Set(['requestUsd', 'taskUsd', 'dailyUsd'])
const BODY_KEYS = new Set(['model', 'role', 'capability', 'scenario', 'budget', 'harnessId', 'target'])
const RESERVED = new Set(['__proto__', 'constructor', 'prototype'])
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v) => typeof v === 'string' ? v.trim() : ''
const failure = (status, code, error) => ({ status, body: { ok: false, code, error, retryable: false } })

function legacyPreview(state, model, deps) {
  let hit
  try { hit = state.router.resolve(model) } catch (e) {
    return { status: 200, body: { ok: true, hit: { type: 'unknown', model, note: e.message } } }
  }
  const vms = state.cfg.virtualModels || []
  if (hit.def.isVirtualModel) {
    const items = hit.def.directory.map(e => {
      const m = state.cfg.models
      const provs = (e.providers && e.providers.length ? e.providers : (m && m[e.model] ? [m[e.model].provider, ...(m[e.model].fallbacks || [])] : []))
      return { model: e.model, mode: e.mode, providers: provs, limit: deps.routeLimit(state, state.cfg, e.model, null) }
    })
    return { status: 200, body: { ok: true, hit: { type: 'virtual', name: hit.def.name, directory: items, quota: hit.def.quota, dailyQuota: hit.def.dailyQuota, used: (state.stats.byModel[hit.def.name] || {}).tokens || 0, quotaState: deps.virtualQuotaExceeded(state, hit.def) } } }
  }
  if (hit.def.virtual) return { status: 200, body: { ok: true, hit: { type: 'defaults', name: hit.canonicalName, directory: state.cfg.defaults.directory || [] } } }
  return { status: 200, body: { ok: true, hit: { type: hit.known ? 'model' : 'unknown', name: hit.canonicalName, provider: hit.def.provider || null, note: hit.known ? null : (vms.length ? '将返回 404（已配置虚拟模型）' : '将走默认上游兜底') } } }
}

function validateBudget(raw) {
  if (raw === undefined) return { value: {} }
  if (!object(raw)) return { error: failure(400, 'invalid_budget', 'budget 必须为对象') }
  for (const key of Object.keys(raw)) if (!LEDGER_KEYS.has(key) && !MONEY_KEYS.has(key) && key !== 'limits') {
    return { error: failure(400, 'invalid_budget', 'budget 含未知字段') }
  }
  const out = {}
  if (raw.limits !== undefined) {
    if (!object(raw.limits)) return { error: failure(400, 'invalid_budget', 'budget.limits 必须为对象') }
    for (const [key, value] of Object.entries(raw.limits)) {
      if (!LEDGER_KEYS.has(key)) return { error: failure(400, 'invalid_budget', 'budget.limits 含未知字段') }
      out[key] = value
    }
  }
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'limits') continue
    if (own(out, key) && out[key] !== value) return { error: failure(400, 'invalid_budget', 'budget 重复字段值冲突') }
    out[key] = value
  }
  for (const [key, value] of Object.entries(out)) {
    if (key === 'maxElapsedMs' && value === null) continue
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (LEDGER_KEYS.has(key) && !Number.isInteger(value)) || (MONEY_KEYS.has(key) && !Number.isSafeInteger(Math.round(value * 1e6)))) {
      return { error: failure(400, 'invalid_budget', 'budget 次数/时长上限必须为整数，金额上限必须为非负数；maxElapsedMs 可为 null') }
    }
  }
  return { value: out }
}

function bindingFor(cfg, harnessId) {
  if (!harnessId) return null
  const bindings = cfg.harnessBindings || {}
  const list = Array.isArray(bindings) ? bindings : Object.values(bindings)
  const matches = list.filter(b => b && b.harnessId === harnessId)
  return matches.length === 1 ? matches[0] : null
}

function resolveRole(state, body) {
  const cfg = state.cfg
  const cleanTarget = target => {
    if (!object(target) || !TARGET_KINDS.has(target.kind) || !text(target.id) || Object.keys(target).some(k => !['kind', 'id'].includes(k))) return null
    return { kind: target.kind, id: text(target.id) }
  }
  const explicitTarget = body.target === undefined ? null : cleanTarget(body.target)
  if (body.target !== undefined && !explicitTarget) return { error: failure(400, 'invalid_role', 'target 必须为 {kind:native|model|pool,id}') }
  if (body.role === undefined) return { value: { name: 'route', target: { kind: 'native', id: body.model }, direct: false } }
  const role = body.role
  if (typeof role === 'string') {
    const name = role.trim()
    if (!ROLE_NAMES.has(name)) return { error: failure(400, 'invalid_role', 'role 不支持') }
    if (name === 'official') return { value: { name, target: { kind: 'native', id: body.model }, direct: true } }
    if (name === 'parent' || name === 'child') {
      const binding = bindingFor(cfg, body.harnessId)
      const target = cleanTarget(binding?.roleTargets?.[name])
      if (!target) return { error: failure(400, 'invalid_role', '目标角色需要唯一 harnessId 绑定') }
      return { value: { name, target, direct: target.kind === 'native', binding } }
    }
    const binding = bindingFor(cfg, body.harnessId)
    const target = explicitTarget || cleanTarget(binding?.roleTargets?.route) || (name === 'aggregated' ? cleanTarget(binding?.roleTargets?.child) : null)
    if (!target) return { error: failure(400, 'invalid_role', 'route/aggregated 需要 target 或唯一 harnessId 绑定') }
    return { value: { name, target, direct: false, binding } }
  }
  if (!object(role) || !TARGET_KINDS.has(role.kind) || !text(role.id) || Object.keys(role).some(k => !['kind', 'id'].includes(k))) {
    return { error: failure(400, 'invalid_role', 'role Target 必须为 {kind:native|model|pool,id}') }
  }
  return { value: { name: role.kind, target: { kind: role.kind, id: text(role.id) }, direct: role.kind === 'native' } }
}

function poolByTarget(cfg, id) {
  return (cfg.virtualModels || []).find(p => p && p.enabled !== false && (p.poolId === id || p.slug === id || p.name === id)) || null
}

function modelByTarget(cfg, id) {
  if (RESERVED.has(id) || !own(cfg.models || {}, id)) return null
  const def = cfg.models[id]
  return def && def.enabled !== false ? { name: id, def } : null
}

function routeEntries(cfg, hit) {
  const dir = cfg.defaults?.directory || []
  const out = []
  const add = (model, mode, providers) => {
    if (!model || out.some(e => e.model === model)) return
    const md = cfg.models?.[model]
    if (md?.enabled === false) return
    out.push({ model, mode: mode === 'onFail' ? 'onFail' : 'afterAll', providers: providers?.length ? providers : (md ? [md.provider, ...(md.fallbacks || [])] : []) })
  }
  if (hit.def.isVirtualModel) {
    const pool = hit.def
    const members = Array.isArray(pool.members) && pool.members.length ? orderPoolMembers(pool, { random: () => 0 }) : pool.directory
    for (const entry of members || []) add(entry.model || entry.modelId, entry.mode, entry.providers || (entry.providerId ? [entry.providerId] : undefined))
  } else if (hit.def.virtual) {
    for (const entry of dir) if (entry?.enabled !== false) add(entry.model, entry.mode, entry.providers)
    if (!out.length && hit.def.provider) out.push({ model: null, mode: 'afterAll', providers: [hit.def.provider] })
  } else {
    add(hit.canonicalName, 'afterAll', [hit.def.provider, ...(hit.def.fallbacks || [])])
    for (const entry of dir) if (entry?.enabled !== false) add(entry.model, entry.mode, entry.providers)
  }
  return out
}

function quotaView(state, model, def) {
  const used = (state.stats.byModel?.[model] || {}).tokens || 0
  const daily = (state.stats.daily?.[model]?.[todayKey()] || {}).tokens || 0
  const quota = Number(def?.quota) || 0
  const dailyQuota = Number(def?.dailyQuota) || 0
  const exhausted = (quota > 0 && used >= quota) || (dailyQuota > 0 && daily >= dailyQuota)
  return { model, state: exhausted ? 'exhausted' : 'available', used, quota, dailyUsed: daily, dailyQuota }
}

function connectionView(state, cfg, providerId, model) {
  const connections = listConnections(cfg, providerId)
  if (!connections.length) return { state: 'legacy_provider', quotaScopeId: cfg.providers?.[providerId]?.quotaScopeId || null }
  const rawList = cfg.providers?.[providerId]?.connections
  const rawConnections = Array.isArray(rawList) ? rawList : rawList && typeof rawList === 'object' ? Object.values(rawList) : []
  const configuredIds = new Set()
  for (const raw of rawConnections) {
    const id = String(raw?.connectionId || raw?.id || '')
    const keyId = raw?.credentialKeyId || id
    if (id && resolveKey(cfg, { apiKeyEnv: raw?.apiKeyEnv }, keyId).key) {
      configuredIds.add(id)
      configuredIds.add('legacy:' + providerId + ':' + id)
    }
  }
  const eligible = connections.filter(c => {
    if (!c.enabled || (c.modelIds?.length && !c.modelIds.includes(model))) return false
    const id = c.connectionId
    const health = state.connectionHealth?.[providerId + ':' + id]
    return !(health?.openUntil > Date.now()) && configuredIds.has(id)
  }).sort((a, b) => a.priority - b.priority)
  const firstPriority = eligible[0]?.priority ?? 0
  const samePriority = eligible.filter(c => c.priority === firstPriority)
  const cursor = state.connectionCursors?.[providerId + ':cursor'] || 0
  return {
    state: eligible.length ? 'available' : 'unavailable',
    selectedConnectionId: samePriority.length ? samePriority[cursor % samePriority.length].connectionId : null,
    eligibleConnectionIds: eligible.map(c => c.connectionId),
    quotaScopeIds: [...new Set(connections.map(c => c.quotaScopeId).filter(Boolean))].sort(),
  }
}

function buildCandidates(state, entries, capability, now) {
  const cfg = state.cfg
  const out = []
  for (const entry of entries) for (const providerId of entry.providers) {
    if (!providerId || RESERVED.has(providerId) || !own(cfg.providers || {}, providerId) || cfg.providers[providerId]?.enabled === false) continue
    const model = entry.model || providerId
    const built = buildProvider(cfg, providerId)
    const identity = classifyTarget(built, cfg)
    const official = identity.kind === 'official'
    const binding = codexBindingFor(cfg, model)
    const md = cfg.models?.[model] || (binding ? cfg.models?.[binding.model] : null) || {}
    const goDefaults = md.provider === providerId ? goCodexToolDefaults(providerId, built._def, modelTarget(cfg, model, providerId).servingName) : null
    const keyMissing = !!(built._def?.apiKeyEnv && !built.keyOk)
    const connections = connectionView(state, cfg, providerId, model)
    const unavailable = connections.state === 'unavailable'
    const declaredTools = md.codex?.capabilities === undefined ? goDefaults?.capabilities : md.codex?.capabilities
    const caps = {
      capability: md.capability || binding?.capability || 'chat',
      contextWindow: Number(md.maxContext || md.codex?.contextWindow) || 0,
      modalities: Array.isArray(md.codex?.modalities) ? md.codex.modalities.map(String) : [],
      tools: { types: declaredTools && typeof declaredTools === 'object' ? ['function', 'custom'] : [], hosted: [] },
      readability: { plaintext: true, v2Encrypted: false },
    }
    const facts = {
      authorization: evidence(!official && !keyMissing && !unavailable, { source: FACT_SOURCE.CONFIG, observedAt: now }),
      identity: evidence({ kind: official ? 'official_subscription' : identity.kind === 'thirdParty' ? 'third_party' : 'unknown', name: model, scope: 'primary' }, { source: FACT_SOURCE.CONFIG, observedAt: now }),
      capabilities: evidence(caps, { source: FACT_SOURCE.CONFIG, observedAt: now }),
    }
    let price
    for (const value of [md.costEstimateUsd, cfg.providers[providerId].costEstimateUsd]) {
      const n = Number(value)
      if (Number.isFinite(n) && n >= 0) { price = n; break }
    }
    if (price !== undefined) facts.pricing = evidence({ usd: price, worstCaseUsd: price, paid: price > 0 }, { source: FACT_SOURCE.CONFIG, observedAt: now })
    const cand = candidate({ model, provider: providerId, facts })
    cand.providerKind = official ? 'official_subscription' : 'third_party'
    cand.authorized = !official && !keyMissing && !unavailable
    out.push({ cand, model, providerId, official, estimatedCostUsd: price ?? null, quota: quotaView(state, model, md), connections })
  }
  return out
}

function healthOf(state, providerId, now) {
  const h = state.health?.[providerId] || state.hst?.[providerId] || {}
  const open = h.openUntil > now || (h.streamDrops || 0) >= 3
  return open ? { state: 'open', cooldownUntilMs: h.openUntil || 0 } : { state: 'closed' }
}

function ledgerPolicy(candidateIds, override, requestBudget, cfg) {
  const base = requestBudget || {}
  const perCandidate = Math.max(2, Number(cfg.defaults?.retry?.maxAttempts) || 3, (Number(cfg.defaults?.codexFallbackLimits?.maxSameProviderAttempts) || 1) + 1)
  const candidateLimit = override.maxAttemptsPerCandidate ?? base.maxAttemptsPerCandidate ?? perCandidate
  const limits = {
    maxTotalAttempts: override.maxTotalAttempts ?? base.maxTotalAttempts ?? 24,
    maxFailovers: override.maxFailovers ?? base.maxFailovers ?? 20,
    maxRecoveryAttempts: override.maxRecoveryAttempts ?? base.maxRecoveryAttempts ?? 5,
    maxWaitMs: override.maxWaitMs ?? base.maxWaitMs ?? 30000,
    maxElapsedMs: own(override, 'maxElapsedMs') ? override.maxElapsedMs : (base.maxElapsedMs ?? null),
  }
  return {
    limits,
    candidateLimits: Object.fromEntries(candidateIds.map(id => [id, candidateLimit])),
    quotaDomainLimits: {},
  }
}

function moneyBudget(state, override, billingLedger) {
  const configured = state.cfg.defaults?.codexBudget || {}
  const routing = state.cfg.routing?.budget || {}
  const limits = { requestUsd: configured.requestUsd ?? routing.requestUsd, taskUsd: configured.taskUsd ?? routing.taskUsd, dailyUsd: configured.dailyUsd ?? routing.dailyUsd }
  for (const key of MONEY_KEYS) if (own(override, key)) limits[key] = override[key]
  if (billingLedger) {
    try {
      return budgetFromLedger(billingLedger.usage({}), {
        limitsMicro: {
          requestMicro: limits.requestUsd == null ? null : Math.round(Number(limits.requestUsd) * 1e6),
          taskMicro: limits.taskUsd == null ? null : Math.round(Number(limits.taskUsd) * 1e6),
          dayMicro: limits.dailyUsd == null ? null : Math.round(Number(limits.dailyUsd) * 1e6),
        },
        currency: billingLedger.currency,
        enforceUnknownCost: true,
      })
    } catch { return { error: failure(503, 'route_preview_budget_unavailable', '费用账本不可读；拒绝预演，未发送上游') } }
  }
  const positive = v => Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0
  return {
    limits: { requestUsd: positive(limits.requestUsd), taskUsd: positive(limits.taskUsd), dailyUsd: positive(limits.dailyUsd) },
    spent: { requestUsd: 0, taskUsd: 0, dailyUsd: 0 },
    enforceUnknownCost: configured.enforceUnknownCost === true,
  }
}

function decisionInput(state, scenario, rows, capability, budget, policy, now) {
  const current = rows[0]?.cand || null
  const common = {
    now, request: { capability }, current, candidates: rows.map(r => r.cand), triedTargets: [],
    attempts: { total: 0, sameProvider: 0, failovers: 0 }, limits: policy.decisionLimits,
    budget, remainingMs: policy.limits.maxElapsedMs,
    emergency: state.cfg.defaults?.codexEmergency === true || state.cfg.defaults?.codexEmergency?.acknowledged === true ? { acknowledged: true } : null,
    healthOf: cand => healthOf(state, cand.provider, now),
  }
  if (scenario === 'normal') return { ...common, phase: PHASE.UNSENT }
  if (scenario === 'cancel') return { ...common, phase: PHASE.USER_CANCELLED, callerCancelled: true }
  if (scenario === 'quota') return { ...common, phase: PHASE.ACCEPTED, error: { status: 402 }, attempts: { total: 1, sameProvider: 0, failovers: 0 } }
  if (scenario === 'recovery') return { ...common, phase: PHASE.ACCEPTED, attempts: { total: 1, sameProvider: 0, failovers: 0 } }
  return { ...common, phase: PHASE.ACCEPTED, error: { status: 503 }, attempts: { total: 2, sameProvider: 1, failovers: 0 } }
}

function safeReplay(decision, ledgerExplanation) {
  if (typeof decision.audit?.replaySafe === 'boolean') return { safe: decision.audit.replaySafe, reason: decision.audit.replayReason }
  const allowed = ledgerExplanation?.decision?.allowed === true
  return { safe: allowed, reason: allowed ? 'request_ledger_allowed' : (ledgerExplanation?.decision?.code || 'request_ledger_denied') }
}

function publicDecision(d) {
  return {
    action: d.action, code: d.code, phase: d.audit.phase, errorClass: d.audit.errorClass,
    replaySafe: d.audit.replaySafe, replayReason: d.audit.replayReason,
    budget: d.budget,
  }
}

export function previewRoute(state, body, deps = {}) {
  const model = String(body.model || '').trim()
  if (!model) return { status: 400, body: { error: '缺少 model' } }
  const extended = Object.keys(body).some(k => k !== 'model')
  if (!extended) return legacyPreview(state, model, deps)
  if (typeof body.model !== 'string') return failure(400, 'invalid_route_preview', 'model 必须为字符串')
  for (const key of Object.keys(body)) if (!BODY_KEYS.has(key)) return failure(400, 'invalid_route_preview', '请求含未知字段')
  if (body.harnessId !== undefined && (typeof body.harnessId !== 'string' || !text(body.harnessId))) return failure(400, 'invalid_role', 'harnessId 必须为非空字符串')
  const capability = body.capability === undefined ? 'chat' : body.capability
  if (typeof capability !== 'string' || !CAPABILITIES.has(capability)) return failure(400, 'invalid_capability', 'capability 不支持')
  const scenario = body.scenario === undefined ? 'normal' : body.scenario
  if (typeof scenario !== 'string' || !SCENARIOS.has(scenario)) return failure(400, 'invalid_scenario', 'scenario 不支持')
  const checkedBudget = validateBudget(body.budget)
  if (checkedBudget.error) return checkedBudget.error
  const checkedRole = resolveRole(state, body)
  if (checkedRole.error) return checkedRole.error
  const role = checkedRole.value
  if (body.target !== undefined && (!['route', 'aggregated'].includes(role.name) || !object(body.target))) return failure(400, 'invalid_role', 'target 仅适用于 route/aggregated')

  let hit = null
  let pool = null
  let entries = []
  if (role.target.kind === 'pool') {
    try { hit = state.router.resolve(model) } catch { return failure(422, 'route_preview_unresolved', '模型无法解析；未发送上游') }
    pool = poolByTarget(state.cfg, role.target.id)
    if (!pool) return failure(422, 'route_preview_target_unavailable', '角色目标池不存在或已停用')
    entries = [{ model: pool.name, mode: 'afterAll', providers: [], directory: pool }]
    const expanded = routeEntries(state.cfg, { canonicalName: pool.name, def: { isVirtualModel: true, ...pool } })
    entries = expanded
  } else if (role.target.kind === 'model') {
    const selected = modelByTarget(state.cfg, role.target.id)
    if (!selected) return failure(422, 'route_preview_target_unavailable', '角色目标模型不存在或已停用')
    try { hit = state.router.resolve(selected.name) } catch { return failure(422, 'route_preview_unresolved', '角色目标模型无法解析') }
    entries = routeEntries(state.cfg, hit)
  } else {
    try { hit = state.router.resolve(role.target.id) } catch { return failure(422, 'route_preview_unresolved', '角色目标模型无法解析') }
    if (!hit.known) return failure(422, 'route_preview_target_unavailable', '角色目标模型不存在或已停用')
    entries = routeEntries(state.cfg, hit)
  }
  if (!entries.length) return failure(422, 'route_preview_no_candidate', '没有可用候选；未发送上游')

  const now = Date.now()
  const rows = buildCandidates(state, entries, capability, now)
  if (!rows.length) return failure(422, 'route_preview_no_candidate', '没有可用候选；未发送上游')
  if (role.name === 'official' && !rows[0]?.official) return failure(422, 'route_preview_target_unavailable', 'official 角色只接受官方目标')
  const direct = role.direct && rows[0]?.official === true
  const candidateIds = rows.map(r => r.providerId)
  const policyView = effectivePolicy(state.cfg, { harnessId: body.harnessId, poolId: pool?.poolId })
  const decisionDefaults = state.cfg.defaults?.codexFallbackLimits || {}
  const decisionLimits = {
    maxSameProviderAttempts: decisionDefaults.maxSameProviderAttempts ?? 1,
    maxFailovers: checkedBudget.value.maxFailovers ?? decisionDefaults.maxFailovers ?? policyView.effective.requestBudget.maxFailovers ?? 2,
    maxTotalAttempts: checkedBudget.value.maxTotalAttempts ?? decisionDefaults.maxTotalAttempts ?? policyView.effective.requestBudget.maxTotalAttempts ?? 3,
    maxWaitMs: checkedBudget.value.maxWaitMs ?? decisionDefaults.maxWaitMs ?? policyView.effective.requestBudget.maxWaitMs ?? 30000,
  }
  const ledgerOptions = ledgerPolicy(candidateIds, checkedBudget.value, policyView.effective.requestBudget, state.cfg)
  const billingLedger = deps.getBillingLedger?.() || null
  const budget = moneyBudget(state, checkedBudget.value, billingLedger)
  if (budget.error) return budget.error
  const input = decisionInput(state, scenario, rows, capability, budget, { decisionLimits, limits: ledgerOptions.limits }, now)
  const decision = direct ? null : decide(input)
  const ledger = new RequestLedger({ ...ledgerOptions, now: () => now })
  if (scenario === 'cancel') ledger.cancel('caller_cancelled')
  const targetOf = row => ({ candidateId: row.providerId, connectionId: row.connections.selectedConnectionId || row.providerId, modelId: row.model, domain: row.connections.quotaScopeIds?.[0] || row.providerId })
  let ledgerExplanation = ledger.explain({ ...targetOf(rows[0]), phase: scenario === 'cancel' ? 'user_cancelled' : 'unsent' })
  if (scenario !== 'normal' && scenario !== 'cancel') {
    ledger.recordAttempt({ ...targetOf(rows[0]), phase: 'accepted' })
    const outcome = scenario === 'quota'
      ? { status: 402, outcome: 'payment_required', execution: 'rejected_before_execution', domain: targetOf(rows[0]).domain, quotaDomainExhausted: true }
      : { status: scenario === 'recovery' ? 429 : 503, outcome: scenario === 'recovery' ? 'rate_limited' : 'failed', execution: 'rejected_before_execution' }
    ledger.recordOutcome(ledger.attempts[0].attemptId, outcome)
    if (scenario === 'failover') {
      ledger.recordAttempt({ ...targetOf(rows[0]), phase: 'accepted' })
      ledger.recordOutcome(ledger.attempts[1].attemptId, outcome)
    }
    if (scenario === 'recovery') ledger.recordRecovery({ target: targetOf(rows[0]), trustedResume: true, nativeProtocol: true })
    ledgerExplanation = ledger.explain({ ...targetOf(rows[0]), phase: scenario === 'recovery' ? 'recovery' : 'accepted' })
  }
  const selectedDecision = direct ? {
    action: 'continue', code: 'MG_DIRECT_TARGET', audit: { phase: 'unsent', errorClass: ERROR_CLASS.NONE, replaySafe: null, replayReason: null }, budget: decision?.budget || budget,
  } : decision
  const rank = direct ? { ranked: [], skipped: [] } : rankCandidates(rows.map(r => r.cand), {
    now, request: { capability }, budget, healthOf: cand => healthOf(state, cand.provider, now), emergency: input.emergency,
    excludeTargets: scenario === 'failover' || scenario === 'quota' ? [rows[0].cand] : [],
  })
  const blocked = new Map()
  const addBlocked = (row, reasons) => {
    const key = row.model + '\0' + row.providerId
    const prior = blocked.get(key) || { model: row.model, provider: row.providerId, reasons: [] }
    for (const reason of reasons) if (!prior.reasons.includes(reason)) prior.reasons.push(reason)
    prior.reasons.sort()
    blocked.set(key, prior)
  }
  rows.forEach((row, index) => {
    const reasons = []
    const limit = deps.routeLimit(state, state.cfg, row.model, null)
    if (limit) reasons.push(limit.includes('上下文') ? 'context_exceeded' : 'model_quota_exhausted')
    if (row.quota.state === 'exhausted') reasons.push('model_quota_exhausted')
    if (row.connections.state === 'unavailable') reasons.push('connection_unavailable')
    if (pool && deps.virtualQuotaExceeded(state, pool)) reasons.push('pool_quota_exhausted')
    const built = buildProvider(state.cfg, row.providerId)
    const denied = targetDeny({ identity: classifyTarget(built, state.cfg), provider: built, cfg: state.cfg, path: ({ responses: '/v1/responses', anthropic: '/v1/messages', gemini: ':generateContent', cohere: '/v1/rerank' })[modelTarget(state.cfg, row.model, row.providerId).api] || '/v1/chat/completions', env: process.env })
    if (denied) reasons.push(denied.code)
    if (built._def?.apiKeyEnv && !built.keyOk) reasons.push('credential_unavailable')
    if (role.name === 'route' && row.official) reasons.push('route_gpt_forbidden')
    if (scenario === 'quota' && row.connections.quotaScopeIds?.includes(targetOf(row).domain)) reasons.push('quota_domain_exhausted')
    if (direct && index === 0 && !reasons.length) return
    if (reasons.length) addBlocked(row, reasons)
  })
  for (const item of decision?.excluded || []) {
    const row = rows.find(r => r.model === item.model && r.providerId === item.provider)
    if (row) addBlocked(row, item.reasons)
  }
  const candidateLedger = new Map()
  for (const row of rows) {
    const view = ledger.explain({ ...targetOf(row), phase: scenario === 'cancel' ? 'user_cancelled' : scenario === 'recovery' ? 'recovery' : scenario === 'normal' ? 'unsent' : 'accepted' })
    candidateLedger.set(row.model + '\0' + row.providerId, view)
    if (!view.decision.allowed) addBlocked(row, [view.decision.code])
  }
  const directRow = direct ? rows[0] : null
  let wouldSend = direct ? (directRow && !blocked.size ? [{ model: directRow.model, provider: directRow.providerId, connectionId: directRow.connections.selectedConnectionId || directRow.providerId, quotaScopeId: directRow.connections.quotaScopeIds?.[0] || null, estimatedCostUsd: directRow.estimatedCostUsd }] : []) : rank.ranked.map(e => {
    const row = rows.find(r => r.cand === e.candidate)
    return { model: e.candidate.model, provider: e.candidate.provider, connectionId: row?.connections.selectedConnectionId || row?.providerId, quotaScopeId: row?.connections.quotaScopeIds?.[0] || null, estimatedCostUsd: e.projectedCostUsd }
  })
  wouldSend = wouldSend.filter(item => !blocked.has(item.model + '\0' + item.provider) && candidateLedger.get(item.model + '\0' + item.provider)?.decision.allowed === true)
  if (selectedDecision.action === 'stop_with_error' || scenario === 'cancel') wouldSend = []
  if (scenario === 'recovery') wouldSend = ledgerExplanation.decision.allowed ? wouldSend.slice(0, 1) : []
  const replay = safeReplay(selectedDecision, ledgerExplanation)
  const quotaState = rows.map(row => ({ ...row.quota, provider: row.providerId, connection: row.connections }))
  if (pool) quotaState.unshift({ model: pool.name, provider: null, state: deps.virtualQuotaExceeded(state, pool) ? 'exhausted' : 'available', used: (state.stats.byModel?.[pool.name] || {}).tokens || 0, quota: pool.quota || 0, dailyUsed: (state.stats.daily?.[pool.name]?.[todayKey()] || {}).tokens || 0, dailyQuota: pool.dailyQuota || 0 })
  ledger.dispose()
  return {
    status: 200,
    body: {
      ok: true,
      hit: legacyPreview(state, hit?.canonicalName || model, deps).body.hit,
      preview: {
        contract: 'mg-route-preview/1', zeroUpstream: true, model, role: role.name, target: role.target,
        capability, scenario, selection: pool?.selection || 'policy_ranked', deterministic: pool?.selection !== 'weighted' && pool?.selection !== 'round_robin',
        wouldSend, blockedCandidates: [...blocked.values()].sort((a, b) => a.model.localeCompare(b.model) || a.provider.localeCompare(b.provider)),
        decision: publicDecision(selectedDecision), ledger: { policy: ledgerExplanation.policy, effective: ledgerExplanation.effective, remaining: ledgerExplanation.remaining, state: ledgerExplanation.state, decision: ledgerExplanation.decision },
        replaySafety: replay, quotaState,
        policy: { sources: policyView.sources, hardConstraints: policyView.hardConstraints },
        budget: { limits: budget.limits, spent: budget.spent || { requestUsd: 0, taskUsd: 0, dailyUsd: 0 }, decision: decision?.budget || null, source: billingLedger ? 'billing_ledger' : 'configuration' },
      },
    },
  }
}
