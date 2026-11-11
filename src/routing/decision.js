// 智能跨模型 Fallback 决策（E5 / D4 / M3-1）：纯函数、零 IO、零第三方依赖，副作用安全优先。
// 契约文档：docs/explanation/fallback-decision.md；已经接入 forward.js 的 Codex 聚合路径（E5）。
//
// 设计红线（违反即拒绝）：
//   1. 「没收到结果」≠「没执行」：阶段进入工具/托管副作用、已交付可见流、任务已部分提交后，
//      任何自动重放（同上游重试或换模型）一律拒绝，只能显式失败；
//   2. 候选必须显式授权；官方订阅不进通用 fallback 池（D7）；官方额度耗尽走手动应急而非自动换池；
//   3. 预算超限停机，绝不为了继续服务而"悄悄降级"到更便宜模型；
//   4. 决策只依赖注入的事实（阶段、错误、候选、预算、费用估算、健康、当前时间），
//      不读配置、不发请求、不写日志、不取墙钟，因此同一输入永远得到同一输出，可离线复现与审计。
//
// M3-1（T-ROUTE-01）加固：候选选择必须"可追溯"——
//   · 候选能力不得伪造：能力（工具/多模态/搜索/patch/hosted tools）只能来自带 source + observedAt
//     的显式事实（candidate.facts，见 src/routing/facts.js）；未知/过期 = 不可入选，绝不默认继承；
//   · 事实新鲜度：健康/价格等事实超过 maxAgeMs 即按未知处理（注入时钟，测试不用真实 sleep）；
//   · 官方订阅身份候选不得因"看起来便宜/健康"被通用请求选中；
//   · 排序：显式兼容性 > 健康 > 价格 > 配置 tieBreak，同分用 model/provider 字典序打破，
//     与输入顺序无关（不依赖对象键顺序，也不用输入下标兜底）；
//   · 理由可诊断且脱敏：只回稳定原因码/类别/状态，绝不回显 key、带凭据 URL、上游原始错误体；
//   · STOP_RECONCILE：上一次尝试可能已提交且无可信续传 ⇒ 不选下一个候选，先对账；
//   · 向后兼容：旧形状（forward.js 当前传入的扁平候选）继续按原语义工作，由 legacy 兼容层处理。
import { headerValue } from '../retry-policy.js'
import {
  FACT,
  FACT_MAX_AGE_MS,
  FACT_SOURCE,
  FACT_STATUS,
  normalizeCandidate,
  normalizeHealthValue,
  readFact,
  resolveHealth,
  sanitizeSource,
} from './facts.js'

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
  DEADLINE: 'MG_FB_DEADLINE',
  RECONCILE: 'MG_FB_STOP_RECONCILE',
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

/**
 * STOP_RECONCILE 的稳定表达。动作仍是 stop_with_error（动作集合 4 值是与既有调用方/测试的
 * 硬契约，不新增第 5 个动作），但错误码单独区分：语义是"先对账，不要选下一个候选"。
 */
export const STOP_RECONCILE = Object.freeze({ action: ACTION.STOP, code: STOP.RECONCILE, stopReason: 'reconcile_required' })

/**
 * 候选被排除的稳定原因码。日志/审计/测试只引用这些码，不要引用人类可读句子。
 * legacy 与 evidence 两种形状共用同一套码，语义有细微差别的两个码单独列出：
 *   cost_unknown  = 旧形状：付费候选但没有费用估算（历史语义）
 *   quote_unknown = 事实模式：没有任何带来源与时间的报价，而存在费用上限
 */
export const EXCLUDE = Object.freeze({
  UNAUTHORIZED: 'unauthorized',
  AUTHORIZATION_UNPROVEN: 'authorization_unproven',
  OFFICIAL: 'official_subscription_excluded',
  IDENTITY_UNPROVEN: 'identity_unproven',
  IDENTITY_CONFLICT: 'identity_conflict',
  EMERGENCY_UNACKED: 'emergency_not_acknowledged',
  SAME_TARGET: 'same_target',
  ALREADY_TRIED: 'already_tried',
  CAPABILITY_UNPROVEN: 'capability_unproven',
  CAPABILITY_MISMATCH: 'capability_mismatch',
  MODALITY_UNSUPPORTED: 'modality_unsupported',
  CONTEXT_EXCEEDED: 'context_exceeded',
  CONTEXT_UNVERIFIED: 'context_unverified',
  TASK_UNREADABLE: 'task_unreadable',
  TOOLS_UNSUPPORTED: 'tools_unsupported',
  HOSTED_TOOLS_UNSUPPORTED: 'hosted_tools_unsupported',
  UNHEALTHY: 'unhealthy',
  COST_UNKNOWN: 'cost_unknown',
  QUOTE_UNKNOWN: 'quote_unknown',
  BUDGET_EXCEEDED: 'budget_exceeded',
  WORST_CASE_EXCEEDS_BUDGET: 'worst_case_exceeds_budget',
  BUDGET_UNVERIFIED: 'budget_unverified',
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
const clamp01 = (v) => Math.min(1, Math.max(0, num(v, 0)))
// 按码点比较（不用 localeCompare：排序结果不能随宿主 locale 变化）。
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
// 没有可信时钟时一律不允许把事实当新鲜：runDecision 用 clockProvided=false 显式声明，
// 直接调用（evaluateCandidate/rankCandidates）没给 now 时也按"无时钟"处理。
const clockForFact = (ctx, now) => (ctx && ctx.clockProvided === false ? NaN : Number.isFinite(Number(ctx && ctx.now)) ? now : NaN)
const factView = (f) => ({
  status: f.status,
  source: sanitizeSource(f.source),
  observedAt: f.observedAt == null ? null : f.observedAt,
  ageMs: f.ageMs == null ? null : f.ageMs,
})

const LIMIT_KEYS = [['requestUsd', 'request'], ['taskUsd', 'task'], ['dailyUsd', 'daily']]

// 费用账本可注入：budget.ledger 可以是 { taskUsd, dailyUsd } 或 () => ({ taskUsd, dailyUsd })。
// 目的：M3-1 之前 task/daily 的 spent 恒为 0（等于假装"没花过钱"），配置了上限也不生效。
function budgetLedger(raw) {
  const l = raw && raw.ledger
  if (!l) return null
  if (typeof l === 'function') {
    try {
      const v = l()
      return v && typeof v === 'object' ? v : null
    } catch {
      return null
    }
  }
  return typeof l === 'object' ? l : null
}

function normalizeBudget(raw) {
  const b = raw || {}
  const limits = b.limits && typeof b.limits === 'object'
    ? b.limits
    : { requestUsd: b.requestUsd, taskUsd: b.taskUsd, dailyUsd: b.dailyUsd }
  const spentRaw = b.spent && typeof b.spent === 'object' ? b.spent : (b.spentUsd && typeof b.spentUsd === 'object' ? b.spentUsd : {})
  const ledger = budgetLedger(b)
  const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k)
  const spent = {}
  const spendKnown = {}
  const spendSource = {}
  for (const [key] of LIMIT_KEYS) {
    if (has(spentRaw, key)) {
      spent[key] = num(spentRaw[key], 0)
      spendKnown[key] = true
      spendSource[key] = 'spent'
    } else if (has(ledger, key)) {
      spent[key] = num(ledger[key], 0)
      spendKnown[key] = true
      spendSource[key] = 'ledger'
    } else {
      // 缺失 ≠ 0：配置了上限却不知道已花多少，只能按"不可验证"处理（见 unverifiedSpendDimension）。
      spent[key] = 0
      spendKnown[key] = false
      spendSource[key] = 'unset'
    }
  }
  return {
    limits: {
      requestUsd: num(limits.requestUsd, 0),
      taskUsd: num(limits.taskUsd, 0),
      dailyUsd: num(limits.dailyUsd, 0),
    },
    spent,
    spendKnown,
    spendSource,
    enforceUnknownCost: b.enforceUnknownCost !== false,
  }
}

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

/**
 * 无法验证的已花费维度：request 维度由本次请求自己累计（可算），task/daily 需要外部账本。
 * 配置了 task/daily 上限但既没给 spent 也没给 ledger ⇒ 不能假装 spent=0。
 */
function unverifiedSpendDimension(budget) {
  for (const [key, name] of LIMIT_KEYS) {
    if (name === 'request') continue
    if (budget.limits[key] > 0 && budget.spendKnown[key] === false) return name
  }
  return null
}

/**
 * 预算闸门：返回 null=通过，否则返回稳定的 exceededBy（request/task/daily/unknown_cost/
 * unverified_spend/worst_case_exceeds_budget）。
 */
function budgetGate(budget, candidate, cost, opts = {}) {
  const evidence = opts.evidence === true
  if (budget.enforceUnknownCost) {
    const unverified = unverifiedSpendDimension(budget)
    if (unverified) return 'unverified_spend'
  }
  if (!cost.known) {
    if (budget.enforceUnknownCost && limitsConfigured(budget)) {
      // 有费用上限却没有任何可信报价 ⇒ 排除。证据模式下不区分候选自称免费与否：
      // "不知道多少钱"就是"不知道"，不能靠候选自述的 paid 洗白。
      if (evidence) return 'unknown_cost'
      const paid = candidate ? candidate.paid === true || (candidate.pricing && candidate.pricing.paid === true) : false
      if (paid) return 'unknown_cost'
    }
    return null
  }
  for (const [key, name] of LIMIT_KEYS) {
    const limit = budget.limits[key]
    if (limit > 0 && budget.spent[key] + cost.usd > limit) return name
  }
  // 最坏情况上界：只有"比点估计更贵"时才单独报（等于点估计时按普通超预算报告，避免换一个名字）。
  const worst = Number(cost.worstCaseUsd)
  if (Number.isFinite(worst) && worst > cost.usd) {
    for (const [key] of LIMIT_KEYS) {
      const limit = budget.limits[key]
      if (limit > 0 && budget.spent[key] + worst > limit) return 'worst_case_exceeds_budget'
    }
  }
  return null
}

/** 闸门 token → 候选排除原因码。 */
function reasonForGate(token, evidence) {
  if (token === 'unknown_cost') return evidence ? EXCLUDE.QUOTE_UNKNOWN : EXCLUDE.COST_UNKNOWN
  if (token === 'unverified_spend') return EXCLUDE.BUDGET_UNVERIFIED
  if (token === 'worst_case_exceeds_budget') return EXCLUDE.WORST_CASE_EXCEEDS_BUDGET
  return EXCLUDE.BUDGET_EXCEEDED
}

function budgetSnapshot(budget, nextUsd) {
  const remaining = {}
  for (const [key, name] of LIMIT_KEYS) {
    remaining[name] = budget.limits[key] > 0 ? Math.max(0, budget.limits[key] - budget.spent[key]) : null
  }
  return {
    limits: Object.assign({}, budget.limits),
    spent: Object.assign({}, budget.spent),
    spendKnown: Object.assign({}, budget.spendKnown || {}),
    spendSource: Object.assign({}, budget.spendSource || {}),
    nextUsd: nextUsd == null ? null : nextUsd,
    remaining,
    exceededBy: null,
  }
}

function injectedCost(candidate, ctx) {
  if (typeof ctx.estimateCost !== 'function') return null
  try {
    const raw = ctx.estimateCost(candidate, { phase: ctx.phase, attempt: ctx.attempt, request: ctx.request })
    const usd = Number(raw)
    if (raw == null || !Number.isFinite(usd) || usd < 0) return null
    return usd
  } catch {
    return null
  }
}

/** 旧形状（legacy）费用：注入的估算 > candidate.estimatedCostUsd > candidate.pricing.estimatedCostUsd。 */
function costOf(candidate, ctx) {
  if (!candidate) return { known: false, usd: null, paid: false, worstCaseUsd: null, status: FACT_STATUS.LEGACY, source: null }
  const paid = candidate.paid === true || (candidate.pricing && candidate.pricing.paid === true)
  let raw = null
  const injected = injectedCost(candidate, ctx)
  if (injected != null) {
    raw = injected
  } else if (candidate.estimatedCostUsd != null) {
    raw = candidate.estimatedCostUsd
  } else if (candidate.pricing && candidate.pricing.estimatedCostUsd != null) {
    raw = candidate.pricing.estimatedCostUsd
  }
  const usd = Number(raw)
  if (raw == null || !Number.isFinite(usd) || usd < 0) {
    return { known: false, usd: null, paid, worstCaseUsd: null, status: FACT_STATUS.LEGACY, source: null }
  }
  return { known: true, usd, paid, worstCaseUsd: null, status: FACT_STATUS.LEGACY, source: injected != null ? 'estimateCost' : 'candidate_field' }
}

/**
 * 价格事实。证据模式：报价必须带 source + observedAt 且在 maxAgeMs 内；过期/缺失 = 未知。
 * 注入的 estimateCost 是调用方在当下算出的实时估算，优先于缓存报价（与 healthOf 同理），
 * 其可信度由调用方负责；缓存事实一律要求来源与观测时间。
 */
function pricingOf(norm, ctx) {
  const c = norm.raw || {}
  if (norm.mode !== 'evidence') return costOf(c, ctx)
  const now = num(ctx.now, 0)
  const f = readFact(norm, FACT.PRICING, { now: clockForFact(ctx, now), maxAgeMs: ctx.maxAgeMs })
  const value = f.status === FACT_STATUS.PROVEN && f.value && typeof f.value === 'object' ? f.value : null
  const paid = !!(value && value.paid === true)
  const worstRaw = value ? (value.worstCaseUsd != null ? value.worstCaseUsd : value.worstUsd) : null
  const worst = Number(worstRaw)
  const worstCaseUsd = Number.isFinite(worst) && worst >= 0 ? worst : null
  const base = {
    known: false,
    usd: null,
    worstCaseUsd,
    paid,
    status: f.status,
    source: sanitizeSource(f.source),
    observedAt: f.observedAt == null ? null : f.observedAt,
    reason: f.reason || null,
  }
  const injected = injectedCost(c, ctx)
  if (injected != null) {
    return Object.assign(base, {
      known: true,
      usd: injected,
      worstCaseUsd: worstCaseUsd == null ? injected : worstCaseUsd,
      status: FACT_STATUS.PROVEN,
      source: 'estimateCost',
      live: true,
      reason: null,
    })
  }
  if (!value) return base
  const rawUsd = value.estimatedCostUsd != null ? value.estimatedCostUsd : value.usd
  const usd = rawUsd == null ? NaN : Number(rawUsd)
  if (!Number.isFinite(usd) || usd < 0) return base
  return Object.assign(base, { known: true, usd, worstCaseUsd: worstCaseUsd == null ? usd : worstCaseUsd })
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
    // 身份约束：请求点名了身份（如 'vendor-a'）时，候选必须能证明自己就是它。
    identity: str(r.identity),
    // 显式兼容性/偏好目标：优先于健康与价格（用户/配置明确点名）。
    preferredTarget: r.preferredTarget && typeof r.preferredTarget === 'object'
      ? { model: str(r.preferredTarget.model), provider: str(r.preferredTarget.provider) }
      : null,
  }
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

/**
 * 健康快照解析。优先级：healthOf 注入 > healthInput 注入（见 decide 位置参数）> 候选 facts.health
 * > 旧形状候选自带快照。
 * 返回 { status, value, source, observedAt, ageMs, reason }；status 非 proven/legacy 即"未知"。
 */
function healthSnapshot(norm, ctx, now) {
  const c = norm.raw || {}
  if (typeof ctx.healthOf === 'function') {
    const live = resolveHealth(ctx.healthOf, c, { now, maxAgeMs: ctx.maxAgeMs })
    if (live) return live
  }
  if (ctx.healthInput != null) {
    const live = resolveHealth(ctx.healthInput, c, { now, maxAgeMs: ctx.maxAgeMs })
    if (live) return live
  }
  if (norm.mode === 'evidence') {
    const f = readFact(norm, FACT.HEALTH, { now: clockForFact(ctx, now), maxAgeMs: ctx.maxAgeMs })
    if (f.status === FACT_STATUS.PROVEN) {
      return {
        status: f.status,
        reason: null,
        value: normalizeHealthValue(f.value),
        source: f.source,
        observedAt: f.observedAt,
        ageMs: f.ageMs,
      }
    }
    return {
      status: f.status,
      reason: f.reason || 'health_unknown',
      value: null,
      source: f.source == null ? null : f.source,
      observedAt: f.observedAt == null ? null : f.observedAt,
      ageMs: f.ageMs == null ? null : f.ageMs,
    }
  }
  // 旧形状：候选自带快照没有观测时间。保持既有语义（以 now 解释 cooldownUntilMs）。
  return { status: FACT_STATUS.LEGACY, reason: null, value: c.health || null, source: 'candidate_snapshot', observedAt: null, ageMs: null }
}

const sameTarget = (a, b) => !!(a && b && str(a.model) === str(b.model) && str(a.provider) === str(b.provider))

// 偏好目标允许只写 model 或只写 provider（只写其一即按其一匹配）。
function matchesTarget(pref, c) {
  if (!pref || !c) return false
  const pm = str(pref.model)
  const pp = str(pref.provider)
  if (!pm && !pp) return false
  if (pm && pm !== str(c.model)) return false
  if (pp && pp !== str(c.provider)) return false
  return true
}

const HEALTH_RANK = Object.freeze({ closed: 0, half_open: 1, unknown: 2 })

/** 显式兼容性：0 = 请求/配置点名了该候选（或候选显式声明兼容），1 = 只是可用。 */
function compatibilityRank(c, request, ctx) {
  const pref = (request && request.preferredTarget) || (ctx && ctx.preferredTarget) || null
  if (pref && matchesTarget(pref, c)) return 0
  const list = Array.isArray(request && request.explicitTargets) ? request.explicitTargets : []
  if (list.some((t) => matchesTarget(t, c))) return 0
  if (c && (c.explicitCompatibility === true || c.compatibility === 'explicit')) return 0
  return 1
}

const tieBreakOf = (c) => num(c && c.tieBreak, num(c && c.priority, 0))

/**
 * 排序键的紧凑编码：仅供日志/诊断（forward.js 会把 score 写日志）。
 * 真实排序以 rank 元组为准（见 compareEvaluations）；数值编码只是让人一眼看出量级差异。
 */
function scoreOf(rank) {
  const priceTier = rank.priceKnown ? Math.min(num(rank.priceUsd, 0), 999999) * 100 : 99999900
  const tie = Math.max(-99, Math.min(99, num(rank.tieBreak, 0)))
  return rank.compat * 1e13 +
    (HEALTH_RANK[rank.health] || 0) * 1e11 +
    clamp01(rank.errorRate) * 1e10 +
    priceTier +
    tie
}

function comparePrice(a, b) {
  if (a.priceKnown && b.priceKnown) return a.priceUsd - b.priceUsd
  if (a.priceKnown) return -1
  if (b.priceKnown) return 1
  return 0
}

// 排序：显式兼容性 > 健康（状态，再错误率）> 价格 > 配置 tieBreak > model/provider 字典序。
// 最后两级保证"同分也不依赖输入顺序/对象键顺序"。
function compareEvaluations(a, b) {
  const ra = a.rank
  const rb = b.rank
  return (ra.compat - rb.compat) ||
    (HEALTH_RANK[ra.health] - HEALTH_RANK[rb.health]) ||
    (ra.errorRate - rb.errorRate) ||
    comparePrice(ra, rb) ||
    (ra.tieBreak - rb.tieBreak) ||
    cmpStr(ra.model, rb.model) ||
    cmpStr(ra.provider, rb.provider)
}

/**
 * 评估单个候选是否可用。纯函数：只读 ctx，不改候选。
 *
 * 两种形状：
 *   · evidence（candidate.facts 存在）：一切能力/授权/身份/价格都必须带 source + observedAt，
 *     未知或过期即不可入选（未知 ≠ 支持）；健康未知只降权不排除（避免没有探活的部署直接瘫掉）。
 *   · legacy（无 facts）：保持历史语义（调用方显式声明的字段可信），用于 forward.js 现有形状。
 *
 * @returns {{eligible:boolean, reasons:string[], warnings:string[], score:number|null,
 *            projectedCostUsd:number|null, costKnown:boolean, rank:object,
 *            factMode:string, provenance:object}}
 */
export function evaluateCandidate(candidate, ctx = {}) {
  const norm = normalizeCandidate(candidate, { now: ctx.now })
  const c = norm.raw
  const request = ctx.request || {}
  const now = num(ctx.now, 0)
  const evidence = norm.mode === 'evidence'
  const factOpts = { now: clockForFact(ctx, now), maxAgeMs: ctx.maxAgeMs }
  const reasons = []
  const warnings = []
  const provenance = {
    mode: norm.mode,
    authorization: null,
    identity: null,
    capabilities: null,
    pricing: null,
    health: null,
  }

  // 1) 授权：证据模式要求"带来源与观测时间的显式授权"；缺证据 = 未授权（未知 ≠ 已授权）。
  if (evidence) {
    const f = readFact(norm, FACT.AUTHORIZATION, factOpts)
    provenance.authorization = factView(f)
    if (f.status !== FACT_STATUS.PROVEN) reasons.push(EXCLUDE.AUTHORIZATION_UNPROVEN)
    else if (f.value !== true) reasons.push(EXCLUDE.UNAUTHORIZED)
  } else {
    provenance.authorization = { status: FACT_STATUS.LEGACY, source: FACT_SOURCE.LEGACY_DECLARED, observedAt: null, ageMs: null }
    if (c.authorized !== true) reasons.push(EXCLUDE.UNAUTHORIZED)
  }

  // 2) 身份：官方订阅永不进通用池（D7）；请求点名身份时必须能被证明（否则就是身份冲突/未知）。
  let identityKind = null
  let identityName = null
  let identityScope = null
  if (evidence) {
    const f = readFact(norm, FACT.IDENTITY, factOpts)
    const v = f.status === FACT_STATUS.PROVEN && f.value && typeof f.value === 'object' ? f.value : null
    identityKind = v ? str(v.kind) : null
    identityName = v ? str(v.name) : null
    identityScope = v ? str(v.scope) : null
    provenance.identity = Object.assign(factView(f), { kind: identityKind })
    const wantIdentity = str(request.identity)
    if (f.status !== FACT_STATUS.PROVEN) reasons.push(EXCLUDE.IDENTITY_UNPROVEN)
    else if (identityKind === 'official_subscription') reasons.push(EXCLUDE.OFFICIAL)
    else if (wantIdentity && identityName !== wantIdentity) reasons.push(EXCLUDE.IDENTITY_CONFLICT)
  } else {
    identityKind = str(c.providerKind)
    identityName = str(c.identity)
    identityScope = str(c.scope)
    provenance.identity = { status: FACT_STATUS.LEGACY, source: FACT_SOURCE.LEGACY_DECLARED, kind: identityKind || null }
    if (identityKind === 'official_subscription') reasons.push(EXCLUDE.OFFICIAL)
    const wantIdentity = str(request.identity)
    // 旧形状没有身份证据，只在"双方都写了且不一致"时判冲突（不改变既有放行语义）。
    if (wantIdentity && identityName && identityName !== wantIdentity) reasons.push(EXCLUDE.IDENTITY_CONFLICT)
  }

  // 3) 应急范围：未确认的应急候选不得进入自动链路。
  const scope = identityScope || str(c.scope)
  if (scope === 'emergency' && !(ctx.emergency && ctx.emergency.acknowledged === true)) {
    reasons.push(EXCLUDE.EMERGENCY_UNACKED)
  }

  // 4) 当前目标/已尝试目标：不得重复打同一个目标（可能重复外部操作）。
  const excluded = Array.isArray(ctx.excludeTargets) ? ctx.excludeTargets : []
  if (excluded.some((t) => sameTarget(t, c))) reasons.push(EXCLUDE.SAME_TARGET)
  const tried = Array.isArray(ctx.triedTargets) ? ctx.triedTargets : []
  if (tried.some((t) => sameTarget(t, c))) reasons.push(EXCLUDE.ALREADY_TRIED)

  // 5) 能力：证据模式只认候选自己的带时间证据；绝不从需求/官方模板继承。
  const wantCap = request.capability || 'chat'
  if (evidence) {
    const f = readFact(norm, FACT.CAPABILITIES, factOpts)
    provenance.capabilities = factView(f)
    if (f.status !== FACT_STATUS.PROVEN || !f.value || typeof f.value !== 'object') {
      // 未知/过期/形状不对 ⇒ 一律不可入选：请求需要能力时，没有证据就等于没有能力。
      reasons.push(EXCLUDE.CAPABILITY_UNPROVEN)
    } else {
      const caps = f.value
      if (str(caps.capability || 'chat') !== str(wantCap)) reasons.push(EXCLUDE.CAPABILITY_MISMATCH)

      if (Array.isArray(request.modalities) && request.modalities.length) {
        const have = Array.isArray(caps.modalities) ? caps.modalities.map(str) : []
        if (!request.modalities.every((m) => have.includes(m))) reasons.push(EXCLUDE.MODALITY_UNSUPPORTED)
      }

      const needTokens = num(request.promptTokens, 0)
      const windowTokens = num(caps.contextWindow, 0)
      if (needTokens > 0 && windowTokens > 0 && needTokens > windowTokens) reasons.push(EXCLUDE.CONTEXT_EXCEEDED)
      else if (needTokens > 0 && windowTokens <= 0 && ctx.requireVerifiedContext === true) reasons.push(EXCLUDE.CONTEXT_UNVERIFIED)

      if (request.requiresV2TaskRead === true && !(caps.readability && caps.readability.v2Encrypted === true)) {
        reasons.push(EXCLUDE.TASK_UNREADABLE)
      }

      const haveTools = caps.tools && Array.isArray(caps.tools.types) ? caps.tools.types.map(str) : null
      if (Array.isArray(request.tools) && request.tools.length) {
        if (!haveTools || !request.tools.every((t) => haveTools.includes(t))) reasons.push(EXCLUDE.TOOLS_UNSUPPORTED)
      }
      const haveHosted = caps.tools && Array.isArray(caps.tools.hosted) ? caps.tools.hosted.map(str) : []
      if (Array.isArray(request.hostedTools) && request.hostedTools.length) {
        if (!request.hostedTools.every((t) => haveHosted.includes(t))) reasons.push(EXCLUDE.HOSTED_TOOLS_UNSUPPORTED)
      }
    }
  } else {
    provenance.capabilities = { status: FACT_STATUS.LEGACY, source: FACT_SOURCE.LEGACY_DECLARED, observedAt: null, ageMs: null }
    // 旧形状：调用方显式声明（forward.js 的 E4 interop 层负责拒绝不可表达工具）。
    if (str(c.capability || 'chat') !== str(wantCap)) reasons.push(EXCLUDE.CAPABILITY_MISMATCH)

    if (Array.isArray(request.modalities) && request.modalities.length) {
      const have = Array.isArray(c.modalities) ? c.modalities.map(str) : []
      if (!request.modalities.every((m) => have.includes(m))) reasons.push(EXCLUDE.MODALITY_UNSUPPORTED)
    }

    const needTokens = num(request.promptTokens, 0)
    const windowTokens = num(c.contextWindow, 0)
    if (needTokens > 0 && windowTokens > 0 && needTokens > windowTokens) reasons.push(EXCLUDE.CONTEXT_EXCEEDED)
    else if (needTokens > 0 && windowTokens <= 0 && ctx.requireVerifiedContext === true) reasons.push(EXCLUDE.CONTEXT_UNVERIFIED)

    if (request.requiresV2TaskRead === true && !(c.readability && c.readability.v2Encrypted === true)) {
      reasons.push(EXCLUDE.TASK_UNREADABLE)
    }

    const haveTools = c.tools && Array.isArray(c.tools.types) ? c.tools.types.map(str) : null
    if (Array.isArray(request.tools) && request.tools.length) {
      if (!haveTools || !request.tools.every((t) => haveTools.includes(t))) reasons.push(EXCLUDE.TOOLS_UNSUPPORTED)
    }
    const haveHosted = c.tools && Array.isArray(c.tools.hosted) ? c.tools.hosted.map(str) : []
    if (Array.isArray(request.hostedTools) && request.hostedTools.length) {
      if (!request.hostedTools.every((t) => haveHosted.includes(t))) reasons.push(EXCLUDE.HOSTED_TOOLS_UNSUPPORTED)
    }
  }

  // 6) 健康：冷却中/熔断中不可入选；未知（缺失/过期）只降权，并在 warnings 里显式说明。
  const snapshot = healthSnapshot(norm, ctx, now)
  provenance.health = {
    status: snapshot.status,
    source: sanitizeSource(snapshot.source),
    observedAt: snapshot.observedAt == null ? null : snapshot.observedAt,
    ageMs: snapshot.ageMs == null ? null : snapshot.ageMs,
  }
  const healthState = snapshot.status === FACT_STATUS.PROVEN || snapshot.status === FACT_STATUS.LEGACY
    ? healthAt(snapshot.value, now)
    : 'unknown'
  if (healthState === 'open') reasons.push(EXCLUDE.UNHEALTHY)
  else if (healthState === 'half_open' && ctx.allowHalfOpen === false) reasons.push(EXCLUDE.UNHEALTHY)
  else if (healthState === 'unknown') warnings.push(snapshot.reason === 'stale' ? 'health_stale' : 'health_unknown')

  // 7) 费用/预算：价格未知且存在费用上限 ⇒ 排除；最坏情况超限同样排除。
  const cost = pricingOf(norm, Object.assign({}, ctx, { request }))
  provenance.pricing = {
    status: cost.status == null ? null : cost.status,
    source: sanitizeSource(cost.source),
    known: cost.known === true,
    observedAt: cost.observedAt == null ? null : cost.observedAt,
  }
  if (ctx.budget) {
    const exceededBy = budgetGate(ctx.budget, c, cost, { evidence })
    if (exceededBy) reasons.push(reasonForGate(exceededBy, evidence))
  }

  const rank = {
    compat: compatibilityRank(c, request, ctx),
    health: healthState,
    errorRate: evidence
      ? clamp01(snapshot.status === FACT_STATUS.PROVEN && snapshot.value ? snapshot.value.errorRate : 0)
      : clamp01(c.health && c.health.errorRate),
    priceKnown: cost.known === true,
    priceUsd: cost.known === true ? num(cost.usd, 0) : null,
    tieBreak: tieBreakOf(c),
    model: str(c.model),
    provider: str(c.provider),
  }
  const eligible = reasons.length === 0
  return {
    eligible,
    reasons,
    warnings,
    score: eligible ? scoreOf(rank) : null,
    projectedCostUsd: cost.usd == null ? null : cost.usd,
    costKnown: cost.known === true,
    rank,
    factMode: norm.mode,
    provenance,
  }
}

/** 汇总评估里的警告码（确定性排序，便于日志比对）。 */
function collectWarnings(evaluations) {
  const set = new Set()
  for (const e of evaluations) {
    for (const w of (e && Array.isArray(e.warnings) ? e.warnings : [])) set.add(w)
  }
  return Array.from(set).sort()
}

/**
 * 候选排序：先按硬过滤（授权/身份/能力证据/上下文/工具/健康/费用/预算），再按确定性排序键。
 * 同分用 model/provider 码点字典序打破，保证与输入顺序、对象键顺序无关。
 */
export function rankCandidates(candidates, ctx = {}) {
  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : []
  const evaluated = list.map((candidate, index) => Object.assign({ candidate, index }, evaluateCandidate(candidate, ctx)))
  const ranked = evaluated.filter((e) => e.eligible).sort(compareEvaluations)
  const skipped = evaluated
    .filter((e) => !e.eligible)
    .map((e) => ({
      model: e.candidate.model == null ? null : str(e.candidate.model),
      provider: e.candidate.provider == null ? null : str(e.candidate.provider),
      reasons: e.reasons.slice(),
      warnings: (e.warnings || []).slice(),
      factMode: e.factMode,
    }))
    // 排除列表也按 (model, provider, 原因) 稳定排序：同一候选集合无论输入顺序如何，审计输出一致。
    .sort((a, b) => cmpStr(str(a.model), str(b.model)) ||
      cmpStr(str(a.provider), str(b.provider)) ||
      cmpStr(a.reasons.join(','), b.reasons.join(',')))
  return { ranked, skipped }
}

/** 指数退避（确定性、无抖动）：attempt 从 0 开始；上限 maxWaitMs。 */
export function backoffMs(attempt, baseMs = DEFAULT_LIMITS.backoffBaseMs, maxWaitMs = DEFAULT_LIMITS.maxWaitMs) {
  const n = int(attempt, 0)
  const base = Math.max(1, num(baseMs, DEFAULT_LIMITS.backoffBaseMs))
  return Math.min(num(maxWaitMs, DEFAULT_LIMITS.maxWaitMs), base * Math.pow(2, n))
}

/**
 * 对账闸门（STOP_RECONCILE）：上一次尝试可能已经在上游执行，但没有可信续传凭据时，
 * 既不能同上游重试，也不能换下一个候选——先确认上游是否已提交，再决定。
 * 只读 lastAttempt 的布尔事实；其余字段（可能含错误体/URL/凭据）一律不进入输出。
 */
function reconcileGate(lastAttempt) {
  const a = lastAttempt && typeof lastAttempt === 'object' ? lastAttempt : null
  if (!a) return { stop: false, audit: null }
  const possiblyCommitted = a.possiblyCommitted === true || a.committed === true || a.committed === 'possible' || a.sideEffectPossible === true
  const resume = a.trustedResume
  const trustedResume = resume === true ||
    (!!resume && typeof resume === 'object' && (resume.trusted === true || resume.ok === true))
  const audit = { possiblyCommitted, trustedResume }
  return { stop: possiblyCommitted && !trustedResume, audit }
}

/**
 * 主决策入口（向后兼容签名）：decide(input) —— 既有调用方（src/forward.js）继续使用。
 * M3-1 新增位置参数签名：decide(request, candidateFacts, health, lastAttempt, budget, options?)。
 * 两者映射到同一内部实现，行为差异只来自输入形状。
 */
export function decide(...args) {
  if (args.length >= 2) return decidePositional(args)
  return runDecision(args[0] || {})
}

/** M3-1 位置参数入口：把 (request, candidateFacts, health, lastAttempt, budget) 规整成内部输入。 */
function decidePositional(args) {
  const requestRaw = args[0] && typeof args[0] === 'object' ? args[0] : {}
  const candidateFacts = args[1]
  const healthInput = args[2]
  const lastAttempt = args[3] && typeof args[3] === 'object' ? args[3] : null
  const budget = args[4]
  const options = args[5] && typeof args[5] === 'object' ? args[5] : {}
  const now = Number.isFinite(Number(requestRaw.now)) ? Number(requestRaw.now)
    : Number.isFinite(Number(options.now)) ? Number(options.now) : undefined
  const pick = (key) => (requestRaw[key] !== undefined ? requestRaw[key] : options[key])
  return runDecision({
    now,
    phase: requestRaw.phase == null ? PHASE.UNSENT : requestRaw.phase,
    error: requestRaw.error || options.error || null,
    request: requestRaw,
    current: requestRaw.current || options.current || null,
    candidates: candidateFacts,
    healthInput: healthInput == null ? null : healthInput,
    lastAttempt,
    budget: budget || options.budget,
    attempts: pick('attempts'),
    limits: pick('limits'),
    triedTargets: pick('triedTargets'),
    emergency: pick('emergency'),
    estimateCost: typeof requestRaw.estimateCost === 'function' ? requestRaw.estimateCost : options.estimateCost,
    allowHalfOpen: options.allowHalfOpen,
    requireVerifiedContext: options.requireVerifiedContext,
    maxAgeMs: pick('maxAgeMs'),
    remainingMs: pick('remainingMs'),
    callerCancelled: requestRaw.callerCancelled === true || options.callerCancelled === true,
    deadlineExpired: requestRaw.deadlineExpired === true || options.deadlineExpired === true,
  })
}

/**
 * 内部实现（旧形状 decide(input) 的字段语义不变）。
 * @param {object} input
 *   now, phase, error, request, current, candidates, attempts{total,sameProvider,failovers},
 *   limits{...}, budget{limits,spent,spendKnown,ledger,enforceUnknownCost}, estimateCost(candidate, ctx),
 *   remainingMs, emergency{acknowledged}, triedTargets, allowHalfOpen, requireVerifiedContext,
 *   lastAttempt{possiblyCommitted,trustedResume}, callerCancelled, deadlineExpired,
 *   healthOf(candidate), healthInput, maxAgeMs
 * @returns {{action, code, reason, userAction, target, retry, willIncurCost, estimatedCostUsd,
 *            budget, excluded, audit}}
 */
function runDecision(input = {}) {
  const opts = input || {}
  const clockProvided = Number.isFinite(Number(opts.now))
  const now = clockProvided ? Number(opts.now) : 0
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
    clockProvided,
    maxAgeMs: opts.maxAgeMs,
    estimateCost: typeof opts.estimateCost === 'function' ? opts.estimateCost : null,
    healthOf: typeof opts.healthOf === 'function' ? opts.healthOf : null,
    healthInput: opts.healthInput == null ? null : opts.healthInput,
    allowHalfOpen: opts.allowHalfOpen !== false,
    requireVerifiedContext: opts.requireVerifiedContext === true,
    preferredTarget: request.preferredTarget,
  }

  const factModes = { evidence: 0, legacy: 0 }
  for (const cand of candidates) factModes[normalizeCandidate(cand, { now }).mode] += 1

  const audit = {
    policy: 'E5/D4/D7/M3-1',
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
    // M3-1：事实与新鲜度的审计面。只记状态/来源名字，绝不记事实值（值里可能有凭据类字段）。
    facts: {
      clockProvided,
      maxAgeMs: opts.maxAgeMs == null ? Object.assign({}, FACT_MAX_AGE_MS) : opts.maxAgeMs,
      candidates: factModes,
      warnings: [],
    },
    reconcile: null,
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
      excluded: Array.isArray(fields.excluded) ? fields.excluded : [],
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

  // M3-0：取消与截止先于一切候选/重放判断——超时或已取消的请求不该再花一次上游调用。
  if (opts.callerCancelled === true) {
    audit.replaySafe = false
    audit.replayReason = 'caller_cancelled'
    return out(ACTION.STOP, {
      code: STOP.CANCELLED,
      reason: '调用方已取消请求，禁止再选择候选或自动重放',
      userAction: '如需继续请重新发起请求',
    })
  }
  if (opts.deadlineExpired === true) {
    audit.replaySafe = false
    audit.replayReason = 'deadline_expired'
    return out(ACTION.STOP, {
      code: STOP.DEADLINE,
      reason: '请求截止时间已到，禁止为超时请求再选候选或重放',
      userAction: '如需继续请新建请求（新预算/新截止）',
    })
  }

  // M3-1：可能已提交但无可信续传 ⇒ 先对账。这里绝不选"下一个候选"。
  const reconcile = reconcileGate(opts.lastAttempt)
  audit.reconcile = reconcile.audit
  if (reconcile.stop) {
    audit.replaySafe = false
    audit.replayReason = 'possibly_committed'
    return out(ACTION.STOP, {
      code: STOP.RECONCILE,
      reason: '上一次尝试可能已在上游执行，且不存在可信续传凭据：禁止换下一个候选，先对账是否已提交',
      userAction: '先确认上游任务/会话是否已提交（对账），确认后再手动重试；不要自动切换候选',
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
      audit.facts.warnings = collectWarnings(ranked.concat(skipped))
      if (!ranked.length) {
        return out(ACTION.STOP, {
          code: STOP.NO_CANDIDATE,
          reason: candidates.length
            ? '候选池无可用项（授权/身份/能力证据/上下文/工具/健康/费用/预算过滤后为空）'
            : '没有提供任何候选模型',
          userAction: '检查模型目录、供应商授权、事实新鲜度与预算配置',
          excluded: skipped,
        })
      }
      const best = ranked[0]
      return out(ACTION.CONTINUE, {
        code: STOP.CONTINUE,
        reason: '发送前候选选择完成（按确定性排序取首个可用候选）',
        userAction: '无需操作：网关按已授权候选放行',
        target: { model: str(best.candidate.model), provider: str(best.candidate.provider), score: best.score },
        willIncurCost: true,
        estimatedCostUsd: best.projectedCostUsd,
        costKnown: best.costKnown,
        excluded: skipped,
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
      const cost = pricingOf(normalizeCandidate(current, { now }), Object.assign({}, ctx, { attempt: attempts.sameProvider + 1 }))
      const evidenceCurrent = normalizeCandidate(current, { now }).mode === 'evidence'
      const exceededBy = budgetGate(budget, current, cost, { evidence: evidenceCurrent })
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
    audit.facts.warnings = collectWarnings(ranked.concat(skipped))
    if (ranked.length) {
      const best = ranked[0]
      const exceededBy = budgetGate(budget, best.candidate, { known: best.costKnown, usd: best.projectedCostUsd }, { evidence: best.factMode === 'evidence' })
      if (exceededBy) {
        return out(ACTION.STOP, {
          code: STOP.BUDGET, exceededBy,
          reason: '最佳候选的费用将突破预算（' + exceededBy + '），停机而不降级',
          userAction: '调整预算授权或新建任务',
          excluded: skipped,
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
        excluded: skipped,
      })
    }
    if (candidates.length) {
      return out(ACTION.STOP, {
        code: STOP.NO_CANDIDATE,
        reason: '候选池无可用备用（授权/身份/能力证据/可读性/工具/上下文/模态/健康/费用/预算过滤后为空）',
        userAction: '检查模型目录、供应商授权、事实新鲜度与预算配置；不得自动使用未授权或官方订阅候选',
        excluded: skipped,
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
