// 智能跨模型 Fallback 决策（E5 / D4）：纯函数、零 IO、零第三方依赖，副作用安全优先。
// 契约文档：docs/explanation/fallback-decision.md；本模块尚未接入 forward.js（E5 集成由 Lead 负责）。
//
// 设计红线（违反即拒绝）：
//   1. 「没收到结果」≠「没执行」：阶段进入工具/托管副作用、已交付可见流、任务已部分提交后，
//      任何自动重放（同上游重试或换模型）一律拒绝，只能显式失败；
//   2. 候选必须显式授权；官方订阅不进通用 fallback 池（D7）；官方额度耗尽走手动应急而非自动换池；
//   3. 预算超限停机，绝不为了继续服务而"悄悄降级"到更便宜模型；
//   4. 决策只依赖注入的事实（阶段、错误、候选、预算、费用估算、健康、当前时间），
//      不读配置、不发请求、不写日志、不取墙钟，因此同一输入永远得到同一输出，可离线复现与审计。
import { headerValue } from '../retry-policy.js'

/** 决策动作：继续 / 同上游重试 / 换模型（含换上游）/ 显式失败。 */
export const ACTION = Object.freeze({
  CONTINUE: 'continue',
  RETRY_SAME: 'retry_same',
  FAILOVER: 'failover',
  STOP: 'stop_with_error',
})

/** 请求生命周期阶段（单调推进，见 advancePhase）。 */
export const PHASE = Object.freeze({
  UNSENT: 'unsent',                               // 未发送：任何候选/重试都安全
  ACCEPTED: 'accepted_no_side_effect',            // 上游已受理，但无可证副作用
  TOOL_SIDE_EFFECT: 'tool_side_effect',           // 已出现工具或 hosted 副作用
  STREAM_DELIVERED: 'stream_delivered',           // 已向客户端交付有效流/内容
  PARTIALLY_COMMITTED: 'partially_committed',     // 任务部分提交（后续轮次/会话状态已改变）
  USER_CANCELLED: 'user_cancelled',               // 用户/客户端取消
})

const VALID_PHASES = new Set(Object.values(PHASE))
const PHASE_TERMINAL = new Set([PHASE.PARTIALLY_COMMITTED, PHASE.USER_CANCELLED])
const PHASE_REPLAY_BLOCKED = new Set([PHASE.TOOL_SIDE_EFFECT, PHASE.STREAM_DELIVERED, PHASE.PARTIALLY_COMMITTED])

// 允许的阶段迁移。只允许向前推进；非法迁移必须被显式拒绝（调用方 bug 不能变成重放）。
const TRANSITIONS = Object.freeze({
  [PHASE.UNSENT]: [PHASE.ACCEPTED, PHASE.USER_CANCELLED],
  [PHASE.ACCEPTED]: [PHASE.TOOL_SIDE_EFFECT, PHASE.STREAM_DELIVERED, PHASE.PARTIALLY_COMMITTED, PHASE.USER_CANCELLED],
  [PHASE.TOOL_SIDE_EFFECT]: [PHASE.STREAM_DELIVERED, PHASE.PARTIALLY_COMMITTED, PHASE.USER_CANCELLED],
  [PHASE.STREAM_DELIVERED]: [PHASE.TOOL_SIDE_EFFECT, PHASE.PARTIALLY_COMMITTED, PHASE.USER_CANCELLED],
  [PHASE.PARTIALLY_COMMITTED]: [],
  [PHASE.USER_CANCELLED]: [],
})

/** 错误分类（与 D4 要求的"必须区分"一一对应）。 */
export const ERROR_CLASS = Object.freeze({
  NONE: 'none',
  RATE_LIMITED: 'rate_limited',
  UPSTREAM: 'upstream_unavailable',
  QUOTA: 'quota_exhausted',
  MODEL_UNAVAILABLE: 'model_unavailable',
  BAD_REQUEST: 'bad_request',
  AUTH: 'auth_failed',
  NETWORK: 'network_error',
  TIMEOUT: 'timeout',
  STREAM_INTERRUPTED: 'stream_interrupted',
  CANCELLED: 'user_cancelled',
  V2_UNREADABLE: 'v2_task_unreadable',
  TOOL_SIDE_EFFECT: 'tool_side_effect',
  UNKNOWN: 'unknown',
})

/** stop_with_error 的稳定错误码（日志/审计/UI 只认这些）。 */
export const STOP = Object.freeze({
  PHASE_INVALID: 'MG_FB_PHASE_INVALID',
  CONTINUE: 'MG_FB_CONTINUE',
  CANCELLED: 'MG_FB_CANCELLED',
  TASK_UNREADABLE: 'MG_FB_TASK_UNREADABLE',
  SIDE_EFFECT: 'MG_FB_SIDE_EFFECT_REPLAY_BLOCKED',
  STREAM_DELIVERED: 'MG_FB_STREAM_DELIVERED',
  PARTIAL_COMMIT: 'MG_FB_PARTIAL_COMMIT',
  BUDGET: 'MG_FB_BUDGET',
  NO_CANDIDATE: 'MG_FB_NO_CANDIDATE',
  ATTEMPTS: 'MG_FB_ATTEMPTS_EXHAUSTED',
  OFFICIAL_POOL: 'MG_FB_OFFICIAL_SUBSCRIPTION_EXCLUDED',
  OFFICIAL_QUOTA: 'MG_FB_OFFICIAL_QUOTA',
  RATE_LIMITED: 'MG_FB_RATE_LIMITED',
  UPSTREAM: 'MG_FB_UPSTREAM',
  QUOTA: 'MG_FB_QUOTA',
  MODEL_UNAVAILABLE: 'MG_FB_MODEL_UNAVAILABLE',
  BAD_REQUEST: 'MG_FB_BAD_REQUEST',
  AUTH: 'MG_FB_AUTH',
  NETWORK: 'MG_FB_NETWORK',
  TIMEOUT: 'MG_FB_TIMEOUT',
  STREAM_INTERRUPTED: 'MG_FB_STREAM_INTERRUPTED',
  UNKNOWN: 'MG_FB_UNKNOWN',
})

// 决策码后缀：与错误类别的映射保持稳定，便于日志/UI/文档引用（不用类别名直接大写，避免暴露内部命名）。
const CODE_SUFFIX = Object.freeze({
  [ERROR_CLASS.RATE_LIMITED]: 'RATE_LIMITED',
  [ERROR_CLASS.UPSTREAM]: 'UPSTREAM',
  [ERROR_CLASS.QUOTA]: 'QUOTA',
  [ERROR_CLASS.MODEL_UNAVAILABLE]: 'MODEL_UNAVAILABLE',
  [ERROR_CLASS.BAD_REQUEST]: 'BAD_REQUEST',
  [ERROR_CLASS.AUTH]: 'AUTH',
  [ERROR_CLASS.NETWORK]: 'NETWORK',
  [ERROR_CLASS.TIMEOUT]: 'TIMEOUT',
  [ERROR_CLASS.STREAM_INTERRUPTED]: 'STREAM_INTERRUPTED',
  [ERROR_CLASS.CANCELLED]: 'CANCELLED',
  [ERROR_CLASS.V2_UNREADABLE]: 'TASK_UNREADABLE',
  [ERROR_CLASS.TOOL_SIDE_EFFECT]: 'TOOL_SIDE_EFFECT',
  [ERROR_CLASS.UNKNOWN]: 'UNKNOWN',
})

const STOP_BY_CLASS = Object.freeze({
  [ERROR_CLASS.RATE_LIMITED]: STOP.RATE_LIMITED,
  [ERROR_CLASS.UPSTREAM]: STOP.UPSTREAM,
  [ERROR_CLASS.QUOTA]: STOP.QUOTA,
  [ERROR_CLASS.MODEL_UNAVAILABLE]: STOP.MODEL_UNAVAILABLE,
  [ERROR_CLASS.BAD_REQUEST]: STOP.BAD_REQUEST,
  [ERROR_CLASS.AUTH]: STOP.AUTH,
  [ERROR_CLASS.NETWORK]: STOP.NETWORK,
  [ERROR_CLASS.TIMEOUT]: STOP.TIMEOUT,
  [ERROR_CLASS.STREAM_INTERRUPTED]: STOP.STREAM_INTERRUPTED,
  [ERROR_CLASS.CANCELLED]: STOP.CANCELLED,
  [ERROR_CLASS.V2_UNREADABLE]: STOP.TASK_UNREADABLE,
  [ERROR_CLASS.TOOL_SIDE_EFFECT]: STOP.SIDE_EFFECT,
  [ERROR_CLASS.UNKNOWN]: STOP.UNKNOWN,
})

// 预执行拒绝类：上游在处理生成之前就拒绝了请求，此时"可能带工具"也不构成重放风险。
const PRE_EXECUTION_REJECT = new Set([
  ERROR_CLASS.RATE_LIMITED,
  ERROR_CLASS.QUOTA,
  ERROR_CLASS.MODEL_UNAVAILABLE,
  ERROR_CLASS.BAD_REQUEST,
  ERROR_CLASS.AUTH,
])

/** 默认可注入上限：重试/换模型次数与单次等待上限（与 src/retry-policy.js 的 30s 对齐）。 */
export const DEFAULT_LIMITS = Object.freeze({
  maxSameProviderAttempts: 1, // 同上游最多再试 1 次
  maxFailovers: 2,            // 最多换 2 次模型/上游
  maxTotalAttempts: 3,        // 本次请求总上游尝试上限
  maxWaitMs: 30000,           // Retry-After / 退避的单次等待上限
  backoffBaseMs: 200,         // 无 Retry-After 时的指数退避基数
})

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d)
const int = (v, d = 0) => {
  const n = Math.trunc(num(v, d))
  return n >= 0 ? n : d
}
const str = (v) => (v == null ? '' : String(v))
const upper = (v) => str(v).toUpperCase()

function normalizeBudget(raw) {
  const b = raw || {}
  const limits = b.limits || {}
  const spent = b.spent || {}
  return {
    limits: {
      requestUsd: num(limits.requestUsd, 0),
      taskUsd: num(limits.taskUsd, 0),
      dailyUsd: num(limits.dailyUsd, 0),
    },
    spent: {
      requestUsd: num(spent.requestUsd, 0),
      taskUsd: num(spent.taskUsd, 0),
      dailyUsd: num(spent.dailyUsd, 0),
    },
    enforceUnknownCost: b.enforceUnknownCost !== false,
  }
}

const LIMIT_KEYS = [['requestUsd', 'request'], ['taskUsd', 'task'], ['dailyUsd', 'daily']]

function limitsConfigured(budget) {
  return LIMIT_KEYS.some(([k]) => budget.limits[k] > 0)
}

/** 已耗尽（spent >= limit）的维度：任何新调用都不允许，停机而不是降级。 */
function exhaustedDimension(budget) {
  for (const [key, name] of LIMIT_KEYS) {
    const limit = budget.limits[key]
    if (limit > 0 && budget.spent[key] >= limit) return name
  }
  return null
}

/** 预算闸门：返回 null=通过，否则返回 exceededBy（request/task/daily/unknown_cost）。 */
function budgetGate(budget, candidate, cost) {
  const paid = candidate ? candidate.paid === true || (candidate.pricing && candidate.pricing.paid === true) : false
  if (!cost.known) {
    if (paid && budget.enforceUnknownCost && limitsConfigured(budget)) return 'unknown_cost'
    return null
  }
  for (const [key, name] of LIMIT_KEYS) {
    const limit = budget.limits[key]
    if (limit > 0 && budget.spent[key] + cost.usd > limit) return name
  }
  return null
}

function budgetSnapshot(budget, nextUsd) {
  const remaining = {}
  for (const [key, name] of LIMIT_KEYS) {
    remaining[name] = budget.limits[key] > 0 ? Math.max(0, budget.limits[key] - budget.spent[key]) : null
  }
  return {
    limits: Object.assign({}, budget.limits),
    spent: Object.assign({}, budget.spent),
    nextUsd: nextUsd == null ? null : nextUsd,
    remaining,
    exceededBy: null,
  }
}

function costOf(candidate, ctx) {
  if (!candidate) return { known: false, usd: null, paid: false }
  const paid = candidate.paid === true || (candidate.pricing && candidate.pricing.paid === true)
  let raw = null
  if (typeof ctx.estimateCost === 'function') {
    try {
      raw = ctx.estimateCost(candidate, { phase: ctx.phase, attempt: ctx.attempt, request: ctx.request })
    } catch {
      raw = null
    }
  } else if (candidate.estimatedCostUsd != null) {
    raw = candidate.estimatedCostUsd
  } else if (candidate.pricing && candidate.pricing.estimatedCostUsd != null) {
    raw = candidate.pricing.estimatedCostUsd
  }
  const usd = Number(raw)
  if (raw == null || !Number.isFinite(usd) || usd < 0) return { known: false, usd: null, paid }
  return { known: true, usd, paid }
}

/** 解析 Retry-After：显式 retryAfterMs 优先；其次秒数/HTTP-date（用注入的 now，保证确定性）。 */
function retryAfterOf(error, now) {
  if (!error) return null
  if (Number.isFinite(Number(error.retryAfterMs))) return Math.max(0, Number(error.retryAfterMs))
  const raw = headerValue(error.headers, 'retry-after')
  if (raw == null) return null
  const text = str(raw).trim()
  if (!text) return null
  if (/^\d+$/.test(text)) return Number(text) * 1000
  const at = Date.parse(text)
  if (!Number.isNaN(at)) return Math.max(0, at - now)
  return null
}

/**
 * 错误分类：把上游/传输层事实归一成稳定类别，并给出"可同上游重试/可换模型/确定性"判定。
 * @param {object} error {status, headers, retryAfterMs, code, cancelled, timeout, streamInterrupted, v2Unreadable, toolSideEffect, upstreamFault}
 * @param {{now?: number}} [opts]
 */
export function classifyError(error, opts = {}) {
  const e = error || {}
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : 0
  const status = Number.isFinite(Number(e.status)) ? Number(e.status) : null
  const retryAfterMs = retryAfterOf(e, now)

  const cancelled =
    e.cancelled === true || e.clientCancelled === true || e.reason === 'client_closed' ||
    e.aborted === 'client_closed' || str(e.code) === 'ECANCELED'
  const v2Unreadable = e.v2Unreadable === true || str(e.code) === 'v2_encrypted_task_unsupported'
  const toolSideEffect = e.toolSideEffect === true || e.sideEffect === 'occurred' || str(e.code) === 'TOOL_SIDE_EFFECT'
  const streamInterrupted = e.streamInterrupted === true || e.interrupted === true || str(e.code) === 'STREAM_INTERRUPTED'
  const timeout = e.timeout === true || str(e.code) === 'ETIMEDOUT' || e.reason === 'request_timeout'
  const network = e.networkError === true || ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH'].includes(str(e.code))

  let cls = ERROR_CLASS.NONE
  if (cancelled) cls = ERROR_CLASS.CANCELLED
  else if (v2Unreadable) cls = ERROR_CLASS.V2_UNREADABLE
  else if (toolSideEffect) cls = ERROR_CLASS.TOOL_SIDE_EFFECT
  else if (streamInterrupted) cls = ERROR_CLASS.STREAM_INTERRUPTED
  else if (timeout) cls = ERROR_CLASS.TIMEOUT
  else if (network) cls = ERROR_CLASS.NETWORK
  else if (status === 429) cls = ERROR_CLASS.RATE_LIMITED
  else if (status === 402) cls = ERROR_CLASS.QUOTA
  else if (status === 404) cls = ERROR_CLASS.MODEL_UNAVAILABLE
  else if (status === 401 || status === 403) cls = ERROR_CLASS.AUTH
  else if (status === 408) cls = ERROR_CLASS.TIMEOUT
  else if (status === 400 || status === 422) cls = e.upstreamFault === true ? ERROR_CLASS.UPSTREAM : ERROR_CLASS.BAD_REQUEST
  else if (status != null && status >= 500 && status <= 599) cls = ERROR_CLASS.UPSTREAM
  else if (status != null && status >= 400 && status < 500) cls = ERROR_CLASS.BAD_REQUEST
  else if (e.transport === true || e.errorType === 'network') cls = ERROR_CLASS.NETWORK
  else if (e != null && Object.keys(e).length) cls = ERROR_CLASS.UNKNOWN

  const retryableSame = [
    ERROR_CLASS.RATE_LIMITED, ERROR_CLASS.UPSTREAM, ERROR_CLASS.NETWORK,
    ERROR_CLASS.TIMEOUT, ERROR_CLASS.STREAM_INTERRUPTED,
  ].includes(cls)
  const failoverable = retryableSame || [
    ERROR_CLASS.QUOTA, ERROR_CLASS.MODEL_UNAVAILABLE, ERROR_CLASS.AUTH,
  ].includes(cls)
  const deterministic = [ERROR_CLASS.BAD_REQUEST, ERROR_CLASS.V2_UNREADABLE, ERROR_CLASS.CANCELLED].includes(cls)

  return {
    cls,
    status,
    retryAfterMs,
    hasRetryAfter: retryAfterMs != null,
    retryableSame,
    failoverable,
    deterministic,
    stopCode: STOP_BY_CLASS[cls] || STOP.UNKNOWN,
  }
}

/**
 * 阶段迁移：只允许向前。非法迁移返回 {ok:false, code}，调用方必须按失败处理，不能当作重放许可。
 */
export function advancePhase(phase, event) {
  const from = phase == null ? PHASE.UNSENT : str(phase)
  const to = str(event)
  if (!VALID_PHASES.has(from) || !VALID_PHASES.has(to)) {
    return { ok: false, code: STOP.PHASE_INVALID, from, to }
  }
  if ((TRANSITIONS[from] || []).includes(to)) return { ok: true, phase: to, from }
  return { ok: false, code: STOP.PHASE_INVALID, from, to }
}

/** 该阶段是否已不允许任何自动重放。 */
export function isReplayBlockedPhase(phase) {
  return PHASE_REPLAY_BLOCKED.has(str(phase)) || PHASE_TERMINAL.has(str(phase))
}

function normalizeRequest(raw) {
  const r = raw || {}
  const tools = Array.isArray(r.tools) ? r.tools.map(str) : []
  const hostedTools = Array.isArray(r.hostedTools) ? r.hostedTools.map(str) : []
  const modalities = Array.isArray(r.modalities) ? r.modalities.map(str) : []
  let risk = str(r.sideEffectRisk)
  if (risk !== 'none' && risk !== 'possible' && risk !== 'occurred') risk = hostedTools.length ? 'possible' : 'none'
  return {
    capability: r.capability || 'chat',
    promptTokens: num(r.promptTokens, 0),
    modalities,
    tools,
    hostedTools,
    requiresV2TaskRead: r.requiresV2TaskRead === true,
    sideEffectRisk: risk,
    streaming: r.streaming === true,
  }
}

// 健康状态可注入：默认读候选自带的 health 快照；接入方可用 healthOf(candidate) 覆盖
// （接现有熔断器/流中断计数/外部探活时不必把状态复制进候选）。
function healthOf(candidate, ctx) {
  if (typeof ctx.healthOf === 'function') {
    try {
      const h = ctx.healthOf(candidate)
      if (h && typeof h === 'object') return h
    } catch { /* 注入器异常按"无健康信息"处理，fail-open 到候选自带快照 */ }
  }
  return candidate && candidate.health
}

function healthAt(health, now) {
  const h = health || {}
  const state = str(h.state) || 'closed'
  if (state === 'open') {
    const until = num(h.cooldownUntilMs, 0)
    if (until > now) return 'open'
    return 'half_open' // 冷却到点放行一次探测（与 forward.js 熔断语义一致）
  }
  return state === 'half_open' ? 'half_open' : 'closed'
}

const sameTarget = (a, b) => !!(a && b && str(a.model) === str(b.model) && str(a.provider) === str(b.provider))

/**
 * 评估单个候选是否可用。纯函数：只读 ctx，不改候选。
 * @returns {{eligible:boolean, reasons:string[], score:number|null, projectedCostUsd:number|null, costKnown:boolean}}
 */
export function evaluateCandidate(candidate, ctx = {}) {
  const c = candidate || {}
  const request = ctx.request || {}
  const now = num(ctx.now, 0)
  const reasons = []

  if (c.authorized !== true) reasons.push('unauthorized')
  if (str(c.providerKind) === 'official_subscription') reasons.push('official_subscription_excluded')
  if (str(c.scope) === 'emergency' && !(ctx.emergency && ctx.emergency.acknowledged === true)) {
    reasons.push('emergency_not_acknowledged')
  }
  const excluded = Array.isArray(ctx.excludeTargets) ? ctx.excludeTargets : []
  if (excluded.some((t) => sameTarget(t, c))) reasons.push('same_target')
  const tried = Array.isArray(ctx.triedTargets) ? ctx.triedTargets : []
  if (tried.some((t) => sameTarget(t, c))) reasons.push('already_tried')

  const wantCap = request.capability || 'chat'
  if (str(c.capability || 'chat') !== str(wantCap)) reasons.push('capability_mismatch')

  if (Array.isArray(request.modalities) && request.modalities.length) {
    const have = Array.isArray(c.modalities) ? c.modalities.map(str) : []
    if (!request.modalities.every((m) => have.includes(m))) reasons.push('modality_unsupported')
  }

  const needTokens = num(request.promptTokens, 0)
  const windowTokens = num(c.contextWindow, 0)
  if (needTokens > 0 && windowTokens > 0 && needTokens > windowTokens) reasons.push('context_exceeded')
  else if (needTokens > 0 && windowTokens <= 0 && ctx.requireVerifiedContext === true) reasons.push('context_unverified')

  if (request.requiresV2TaskRead === true && !(c.readability && c.readability.v2Encrypted === true)) {
    reasons.push('task_unreadable')
  }

  const haveTools = c.tools && Array.isArray(c.tools.types) ? c.tools.types.map(str) : null
  if (Array.isArray(request.tools) && request.tools.length) {
    if (!haveTools || !request.tools.every((t) => haveTools.includes(t))) reasons.push('tools_unsupported')
  }
  const haveHosted = c.tools && Array.isArray(c.tools.hosted) ? c.tools.hosted.map(str) : []
  if (Array.isArray(request.hostedTools) && request.hostedTools.length) {
    if (!request.hostedTools.every((t) => haveHosted.includes(t))) reasons.push('hosted_tools_unsupported')
  }

  const healthState = healthAt(healthOf(c, ctx), now)
  if (healthState === 'open') reasons.push('unhealthy')
  else if (healthState === 'half_open' && ctx.allowHalfOpen === false) reasons.push('unhealthy')

  const cost = costOf(c, Object.assign({}, ctx, { request }))
  if (ctx.budget) {
    const exceededBy = budgetGate(ctx.budget, c, cost)
    if (exceededBy) reasons.push(exceededBy === 'unknown_cost' ? 'cost_unknown' : 'budget_exceeded')
  }

  if (reasons.length) return { eligible: false, reasons, score: null, projectedCostUsd: cost.usd, costKnown: cost.known }

  const priority = num(c.priority, 0)
  const errorRate = Math.min(1, Math.max(0, num(c.health && c.health.errorRate, 0)))
  const halfOpenPenalty = healthState === 'half_open' ? 100 : 0
  const costPenalty = cost.known ? cost.usd * 1000 : 0
  const score = Math.round((priority * 1000 + halfOpenPenalty + errorRate * 10 + costPenalty) * 1e6) / 1e6
  return { eligible: true, reasons: [], score, projectedCostUsd: cost.usd, costKnown: cost.known }
}

/**
 * 候选排序：先按硬过滤（授权/可读性/工具/上下文/模态/健康/预算），再按确定性评分。
 * 同分用 model/provider 字典序打破，保证与输入顺序无关。
 */
export function rankCandidates(candidates, ctx = {}) {
  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : []
  const evaluated = list.map((candidate, index) => Object.assign({ candidate, index }, evaluateCandidate(candidate, ctx)))
  const ranked = evaluated
    .filter((e) => e.eligible)
    .sort((a, b) => (a.score - b.score) || str(a.candidate.model).localeCompare(str(b.candidate.model)) ||
      str(a.candidate.provider).localeCompare(str(b.candidate.provider)) || (a.index - b.index))
  const skipped = evaluated
    .filter((e) => !e.eligible)
    .map((e) => ({ model: e.candidate.model == null ? null : str(e.candidate.model), provider: e.candidate.provider == null ? null : str(e.candidate.provider), reasons: e.reasons.slice() }))
  return { ranked, skipped }
}

/** 指数退避（确定性、无抖动）：attempt 从 0 开始；上限 maxWaitMs。 */
export function backoffMs(attempt, baseMs = DEFAULT_LIMITS.backoffBaseMs, maxWaitMs = DEFAULT_LIMITS.maxWaitMs) {
  const n = int(attempt, 0)
  const base = Math.max(1, num(baseMs, DEFAULT_LIMITS.backoffBaseMs))
  return Math.min(num(maxWaitMs, DEFAULT_LIMITS.maxWaitMs), base * Math.pow(2, n))
}

/**
 * 主决策入口。
 * @param {object} input
 *   now, phase, error, request, current, candidates, attempts{total,sameProvider,failovers},
 *   limits{...}, budget{limits,spent,enforceUnknownCost}, estimateCost(candidate, ctx),
 *   remainingMs, emergency{acknowledged}, triedTargets, allowHalfOpen, requireVerifiedContext
 * @returns {{action, code, reason, userAction, target, retry, willIncurCost, estimatedCostUsd, budget, audit}}
 */
export function decide(input = {}) {
  const opts = input || {}
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : 0
  const phaseRaw = opts.phase == null ? PHASE.UNSENT : str(opts.phase)
  const phase = VALID_PHASES.has(phaseRaw) ? phaseRaw : null
  const request = normalizeRequest(opts.request)
  const budget = normalizeBudget(opts.budget)
  const limits = Object.assign({}, DEFAULT_LIMITS, opts.limits || {})
  const attempts = {
    total: int(opts.attempts && opts.attempts.total, 0),
    sameProvider: int(opts.attempts && opts.attempts.sameProvider, 0),
    failovers: int(opts.attempts && opts.attempts.failovers, 0),
  }
  const remainingMs = Number.isFinite(Number(opts.remainingMs)) ? Number(opts.remainingMs) : null
  const emergency = opts.emergency && opts.emergency.acknowledged === true ? { acknowledged: true } : null
  const err = classifyError(opts.error, { now })
  const current = opts.current || null
  const candidates = Array.isArray(opts.candidates) ? opts.candidates.filter(Boolean) : []
  const triedTargets = Array.isArray(opts.triedTargets) ? opts.triedTargets.filter(Boolean) : []
  const ctx = {
    now, phase, request, budget, emergency,
    estimateCost: typeof opts.estimateCost === 'function' ? opts.estimateCost : null,
    healthOf: typeof opts.healthOf === 'function' ? opts.healthOf : null,
    allowHalfOpen: opts.allowHalfOpen !== false,
    requireVerifiedContext: opts.requireVerifiedContext === true,
  }

  const audit = {
    policy: 'E5/D4/D7',
    phase,
    errorClass: err.cls,
    errorStatus: err.status,
    replaySafe: null,
    replayReason: null,
    attempts: Object.assign({}, attempts),
    limits: {
      maxSameProviderAttempts: int(limits.maxSameProviderAttempts, DEFAULT_LIMITS.maxSameProviderAttempts),
      maxFailovers: int(limits.maxFailovers, DEFAULT_LIMITS.maxFailovers),
      maxTotalAttempts: int(limits.maxTotalAttempts, DEFAULT_LIMITS.maxTotalAttempts),
      maxWaitMs: num(limits.maxWaitMs, DEFAULT_LIMITS.maxWaitMs),
    },
    board: {
      current: current ? { model: str(current.model), provider: str(current.provider) } : null,
      supplied: candidates.length,
      eligible: 0,
      skipped: [],
    },
    request: {
      capability: request.capability,
      promptTokens: request.promptTokens,
      tools: request.tools.length,
      hostedTools: request.hostedTools.length,
      requiresV2TaskRead: request.requiresV2TaskRead,
      sideEffectRisk: request.sideEffectRisk,
      streaming: request.streaming,
    },
    emergency: emergency ? { acknowledged: true } : null,
    costGate: {
      limitsConfigured: limitsConfigured(budget),
      unknownCostPolicy: budget.enforceUnknownCost ? 'fail_closed' : 'allow',
    },
  }

  const out = (action, fields = {}) => {
    const costKnown = fields.costKnown === true
    const usd = costKnown ? num(fields.estimatedCostUsd, 0) : null
    const snap = budgetSnapshot(budget, usd)
    if (fields.exceededBy) snap.exceededBy = fields.exceededBy
    return {
      action,
      code: fields.code || STOP.CONTINUE,
      reason: fields.reason || '',
      userAction: fields.userAction || '',
      target: fields.target || null,
      retry: fields.retry || null,
      willIncurCost: fields.willIncurCost === true,
      estimatedCostUsd: usd,
      budget: snap,
      audit,
    }
  }

  if (phase == null) {
    return out(ACTION.STOP, {
      code: STOP.PHASE_INVALID,
      reason: '未知请求阶段: ' + phaseRaw + '（阶段必须显式且只进不退）',
      userAction: '修复调用方阶段跟踪后再重试；不得把未知阶段当作可重放',
    })
  }

  // 1) 无错误：要么是发送前的候选选择（continue 带目标），要么是已有进展（continue 无新调用）。
  if (err.cls === ERROR_CLASS.NONE) {
    if (phase === PHASE.UNSENT) {
      const exhausted = exhaustedDimension(budget)
      if (exhausted) {
        return out(ACTION.STOP, {
          code: STOP.BUDGET, exceededBy: exhausted,
          reason: '预算已耗尽（' + exhausted + '），禁止为了继续服务而自动降级候选',
          userAction: '调整预算授权或新建任务；不要用更便宜的候选绕过上限',
        })
      }
      const ctxPick = Object.assign({}, ctx, { excludeTargets: [], triedTargets })
      const { ranked, skipped } = rankCandidates(candidates, ctxPick)
      audit.board.skipped = skipped
      audit.board.eligible = ranked.length
      if (!ranked.length) {
        return out(ACTION.STOP, {
          code: STOP.NO_CANDIDATE,
          reason: candidates.length
            ? '候选池无可用项（授权/能力/上下文/工具/健康/预算过滤后为空）'
            : '没有提供任何候选模型',
          userAction: '检查模型目录、供应商授权与预算配置',
        })
      }
      const best = ranked[0]
      return out(ACTION.CONTINUE, {
        code: STOP.CONTINUE,
        reason: '发送前候选选择完成（按确定性评分取首个可用候选）',
        userAction: '无需操作：网关按已授权候选放行',
        target: { model: str(best.candidate.model), provider: str(best.candidate.provider), score: best.score },
        willIncurCost: true,
        estimatedCostUsd: best.projectedCostUsd,
        costKnown: best.costKnown,
      })
    }
    return out(ACTION.CONTINUE, {
      code: STOP.CONTINUE,
      reason: '请求已在阶段 ' + phase + '，无新错误，不触发任何新调用',
      userAction: '无需操作',
    })
  }

  // 2) 用户取消：不再发起任何上游调用，也不把取消当故障重放。
  if (phase === PHASE.USER_CANCELLED || err.cls === ERROR_CLASS.CANCELLED) {
    audit.replaySafe = false
    audit.replayReason = 'user_cancelled'
    return out(ACTION.STOP, {
      code: STOP.CANCELLED,
      reason: '用户/客户端已取消请求，禁止自动重放',
      userAction: '如需继续请重新发起请求',
    })
  }

  // 3) v2 加密任务不可读：换任何上游都读不懂密文，只能显式失败（D3×D4）。
  if (err.cls === ERROR_CLASS.V2_UNREADABLE) {
    audit.replaySafe = false
    audit.replayReason = 'v2_task_unreadable'
    return out(ACTION.STOP, {
      code: STOP.TASK_UNREADABLE,
      reason: '任务含无法读取的 v2 加密内容，备用模型同样不可读，自动换上游无意义',
      userAction: '在主线程以明文任务重试，或按 D3 的受支持途径重建任务',
    })
  }

  // 4) 已进入不可重放阶段：任何错误都只能显式失败。
  if (phase === PHASE.TOOL_SIDE_EFFECT || err.cls === ERROR_CLASS.TOOL_SIDE_EFFECT) {
    audit.replaySafe = false
    audit.replayReason = 'phase:tool_side_effect'
    return out(ACTION.STOP, {
      code: STOP.SIDE_EFFECT,
      reason: '已出现工具或 hosted 副作用，重放可能重复执行外部操作，自动重试/换模型一律禁止',
      userAction: '人工确认副作用后新建任务；不得自动重放',
    })
  }
  if (phase === PHASE.STREAM_DELIVERED) {
    audit.replaySafe = false
    audit.replayReason = 'phase:stream_delivered'
    return out(ACTION.STOP, {
      code: STOP.STREAM_DELIVERED,
      reason: '已向客户端交付有效内容/流，拼接另一个模型的输出会伪装成无中断',
      userAction: '请新建请求；不要在同一响应内混入其他模型输出',
    })
  }
  if (phase === PHASE.PARTIALLY_COMMITTED) {
    audit.replaySafe = false
    audit.replayReason = 'phase:partially_committed'
    return out(ACTION.STOP, {
      code: STOP.PARTIAL_COMMIT,
      reason: '任务已部分提交（会话/后续轮次状态已改变），自动重放会造成重复提交',
      userAction: '检查会话状态后手动继续',
    })
  }

  // 5) 预算耗尽：停机，不降级。
  const exhausted = exhaustedDimension(budget)
  if (exhausted) {
    return out(ACTION.STOP, {
      code: STOP.BUDGET, exceededBy: exhausted,
      reason: '预算已耗尽（' + exhausted + '），停机而不是自动降级到更便宜的候选',
      userAction: '调整预算授权或新建任务',
    })
  }

  // 6) 确定性客户端错误：换模型也一样失败，立即返回（不空跑候选链）。
  if (err.cls === ERROR_CLASS.BAD_REQUEST) {
    return out(ACTION.STOP, {
      code: STOP.BAD_REQUEST,
      reason: '请求参数/格式被上游确定性拒绝（HTTP ' + (err.status == null ? '?' : err.status) + '），换模型不能修复',
      userAction: '修正请求参数后重试',
    })
  }

  // 7) 官方额度耗尽：D7 要求手动应急，不能自动进第三方池。
  if (current && str(current.providerKind) === 'official_subscription' && err.cls === ERROR_CLASS.QUOTA && !emergency) {
    return out(ACTION.STOP, {
      code: STOP.OFFICIAL_QUOTA,
      reason: '官方订阅额度耗尽：D7 只允许用户手动确认后进入第三方应急，禁止自动换池',
      userAction: '如需应急，请显式确认进入第三方应急模式；否则等官方额度恢复',
    })
  }

  // 8) 重放安全评估：阶段/副作用风险不允许时，重试与换模型都不成立。
  const replay = assessReplaySafety({
    phase,
    errorClass: err.cls,
    request,
    sideEffectProved: opts.sideEffectProved === true,
  })
  audit.replaySafe = replay.safe
  audit.replayReason = replay.reason
  if (!replay.safe) {
    return out(ACTION.STOP, {
      code: STOP.SIDE_EFFECT,
      reason: '重放不安全（' + replay.reason + '）：既不能同上游重试，也不能换模型',
      userAction: '人工确认是否已发生副作用后再新建任务',
    })
  }

  // 9) 同上游重试：仅当错误可重试、次数未用尽、Retry-After/退避在预算内且费用闸门通过。
  if (err.retryableSame && attempts.sameProvider < limits.maxSameProviderAttempts && attempts.total < limits.maxTotalAttempts) {
    const wait = retryWait(err, attempts.sameProvider, { now, remainingMs, maxWaitMs: limits.maxWaitMs, backoffBaseMs: limits.backoffBaseMs })
    if (wait.fits) {
      const cost = costOf(current, Object.assign({}, ctx, { attempt: attempts.sameProvider + 1 }))
      const exceededBy = budgetGate(budget, current, cost)
      if (exceededBy) {
        return out(ACTION.STOP, {
          code: STOP.BUDGET, exceededBy,
          reason: '重试预计费用将突破预算（' + exceededBy + '），按 D4 停机而不降级',
          userAction: '调整预算授权或新建任务',
        })
      }
      return out(ACTION.RETRY_SAME, {
        code: 'MG_FB_RETRY_' + (CODE_SUFFIX[err.cls] || upper(err.cls)),
        reason: '错误 ' + err.cls + ' 可重试；同上游第 ' + (attempts.sameProvider + 1) + '/' + limits.maxSameProviderAttempts + ' 次，等待 ' + wait.afterMs + 'ms',
        userAction: '网关按 Retry-After/退避自动重试，客户端无需操作',
        retry: { afterMs: wait.afterMs, attempt: attempts.sameProvider + 1, source: wait.source },
        willIncurCost: true,
        estimatedCostUsd: cost.usd,
        costKnown: cost.known,
      })
    }
    audit.attempts.waitBlocked = wait.reason
  }

  // 10) 换模型/换上游：只用已授权的普通候选；官方订阅与未确认应急候选由过滤器排除。
  if (err.failoverable && attempts.failovers < limits.maxFailovers && attempts.total < limits.maxTotalAttempts) {
    const ctxPick = Object.assign({}, ctx, {
      excludeTargets: current ? [current] : [],
      triedTargets,
      attempt: attempts.failovers + 1,
    })
    const { ranked, skipped } = rankCandidates(candidates, ctxPick)
    audit.board.skipped = skipped
    audit.board.eligible = ranked.length
    if (ranked.length) {
      const best = ranked[0]
      const exceededBy = budgetGate(budget, best.candidate, { known: best.costKnown, usd: best.projectedCostUsd })
      if (exceededBy) {
        return out(ACTION.STOP, {
          code: STOP.BUDGET, exceededBy,
          reason: '最佳候选的费用将突破预算（' + exceededBy + '），停机而不降级',
          userAction: '调整预算授权或新建任务',
        })
      }
      return out(ACTION.FAILOVER, {
        code: 'MG_FB_FAILOVER_' + (CODE_SUFFIX[err.cls] || upper(err.cls)),
        reason: '错误 ' + err.cls + ' 在其余候选上可恢复；换到已授权候选 ' + str(best.candidate.model) + '（评分 ' + best.score + '）',
        userAction: '网关自动切换已授权候选，客户端无需操作',
        target: { model: str(best.candidate.model), provider: str(best.candidate.provider), score: best.score },
        willIncurCost: true,
        estimatedCostUsd: best.projectedCostUsd,
        costKnown: best.costKnown,
      })
    }
    if (candidates.length) {
      return out(ACTION.STOP, {
        code: STOP.NO_CANDIDATE,
        reason: '候选池无可用备用（授权/可读性/工具/上下文/模态/健康/预算过滤后为空）',
        userAction: '检查模型目录、供应商授权与预算配置；不得自动使用未授权或官方订阅候选',
      })
    }
  }

  // 11) 无路可走：次数用尽或没有候选，按错误类别回显稳定错误码。
  if (err.retryableSame && (attempts.sameProvider >= limits.maxSameProviderAttempts || attempts.total >= limits.maxTotalAttempts)) {
    return out(ACTION.STOP, {
      code: STOP.ATTEMPTS,
      reason: '重试/换模型次数已达上限（sameProvider=' + attempts.sameProvider + ', failovers=' + attempts.failovers + ', total=' + attempts.total + '），停止以避免无限重放',
      userAction: '稍后手动重试',
    })
  }
  return out(ACTION.STOP, {
    code: err.stopCode,
    reason: '错误 ' + err.cls + ' 无法安全恢复（no safe retry/failover）',
    userAction: userActionFor(err.cls),
  })
}

function retryWait(err, attempt, opts) {
  const maxWaitMs = num(opts.maxWaitMs, DEFAULT_LIMITS.maxWaitMs)
  const remainingMs = opts.remainingMs
  let afterMs
  let source
  if (err.cls === ERROR_CLASS.RATE_LIMITED && err.retryAfterMs != null) {
    afterMs = Math.max(0, err.retryAfterMs)
    source = 'retry-after'
  } else {
    afterMs = backoffMs(attempt, opts.backoffBaseMs, maxWaitMs)
    source = 'backoff'
  }
  if (afterMs > maxWaitMs) {
    return { fits: false, afterMs, source, reason: 'wait_exceeds_max:' + afterMs + '>' + maxWaitMs }
  }
  if (remainingMs != null && afterMs > remainingMs) {
    return { fits: false, afterMs, source, reason: 'wait_exceeds_budget:' + afterMs + '>' + remainingMs }
  }
  return { fits: true, afterMs, source }
}

/**
 * 重放安全性：结合阶段与请求的副作用风险，判断"同上游重试/换模型"是否被允许。
 * 规则：
 *   - 未发送 → 安全；
 *   - 已受理但无副作用风险（纯文本）→ 安全；
 *   - 已受理但存在 hosted/托管副作用风险 → 只有"上游在处理前就拒绝"的错误类别才安全；
 *   - 其它（工具副作用/已交付流/部分提交/已证明副作用）→ 一律不安全。
 */
export function assessReplaySafety({ phase, errorClass, request, sideEffectProved } = {}) {
  const p = str(phase) || PHASE.UNSENT
  const cls = str(errorClass) || ERROR_CLASS.NONE
  if (PHASE_REPLAY_BLOCKED.has(p) || PHASE_TERMINAL.has(p)) return { safe: false, reason: 'phase:' + p }
  if (sideEffectProved === true) return { safe: false, reason: 'side_effect_proved' }
  if (p === PHASE.UNSENT) return { safe: true, reason: 'unsent' }
  const risk = (request && request.sideEffectRisk) || 'none'
  if (risk === 'occurred') return { safe: false, reason: 'side_effect_occurred' }
  if (risk === 'possible') {
    return PRE_EXECUTION_REJECT.has(cls)
      ? { safe: true, reason: 'pre_execution_rejection' }
      : { safe: false, reason: 'side_effect_uncertain' }
  }
  return { safe: true, reason: 'no_side_effect_tools' }
}

function userActionFor(cls) {
  switch (cls) {
    case ERROR_CLASS.RATE_LIMITED: return '稍后重试；网关不会空等超出预算的 Retry-After'
    case ERROR_CLASS.QUOTA: return '为该供应商充值或改用已授权其他候选'
    case ERROR_CLASS.AUTH: return '检查该供应商的凭据与权限（不要用官方凭据顶替第三方）'
    case ERROR_CLASS.MODEL_UNAVAILABLE: return '检查模型目录是否仍含该模型；必要时换已授权模型'
    case ERROR_CLASS.UPSTREAM: return '稍后重试或改用已授权备用候选'
    case ERROR_CLASS.NETWORK: return '检查网络/代理后重试'
    case ERROR_CLASS.TIMEOUT: return '稍后重试；可调大请求预算'
    case ERROR_CLASS.STREAM_INTERRUPTED: return '重新发起请求（已交付内容不会回滚）'
    case ERROR_CLASS.CANCELLED: return '如需继续请重新发起请求'
    case ERROR_CLASS.V2_UNREADABLE: return '在主线程以明文任务重试'
    case ERROR_CLASS.TOOL_SIDE_EFFECT: return '人工确认副作用后新建任务'
    default: return '查看最小化审计信息后人工处理'
  }
}
