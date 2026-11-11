// UHR 推理契约与回执（M5-1 / T-AGENT-01）：纯函数、零 IO、零第三方依赖。
// 契约文档：docs/contracts/uhr-inference-v1.md
//
// 职责边界：本模块不选候选、不发请求、不记账。它接收"已经发生的事"（M3-1 的裁决结果、
// M3-2 的账本 receipt、以及每个 attempt 的阶段与真实路由），校验收敛条件，产出一份
// **不可变、可复算、脱敏**的回执。回执要能回答四个问题：
//   1. 谁（caller / scope）在什么授权下发起了这次推理；
//   2. 用了哪个授权候选、精确到 model/provider/protocol/generation（上游看到的 = 回执写的）；
//   3. 终态是什么（与 M1-1 的 attempt 阶段一一对应）；
//   4. 用量是多少 —— 不知道就明确写 unknown，绝不填 0。
//
// 硬约束：
//   · 只接受授权作用域与授权候选集；越权候选、超时间/费用预算 ⇒ 稳定拒绝码，不静默降级；
//   · 未知用量输出 usage: 'unknown'；只有"确证未发出"（CANCELLED_UNSENT）才是已知的 0；
//   · 四类引用（caller/scope/request/attempt）一律 sha256 派生短 id，明文不外泄；
//   · 同输入同输出（无墙钟、无随机），回执深度冻结，并给出 receiptHash 供比对。
import { createHash } from 'node:crypto'
import { STOP } from './decision.js'
import { LEDGER_STATUS } from './ledger.js'

export const UHR_CONTRACT = 'uhr-inference-v1'
export const UHR_VERSION = 1

/** 终态集合：与 M1-1 的 attempt 阶段一一对应。 */
export const TERMINAL = Object.freeze({
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  CANCELLED_UNSENT: 'CANCELLED_UNSENT',
  SENT_UNKNOWN: 'SENT_UNKNOWN',
  TOOL_RISK: 'TOOL_RISK',
  STOP_RECONCILE: 'STOP_RECONCILE',
})

/** attempt 阶段（M1-1 口径，小写；输入大小写不敏感）。 */
export const ATTEMPT_PHASE = Object.freeze({
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED_UNSENT: 'cancelled_unsent',
  SENT_UNKNOWN: 'sent_unknown',
  TOOL_RISK: 'tool_risk',
  STOP_RECONCILE: 'stop_reconcile',
})

const PHASES = new Set(Object.values(ATTEMPT_PHASE))
// 真正把字节发给上游的阶段：cancelled_unsent 不算 sent。
const SENT_PHASES = new Set([
  ATTEMPT_PHASE.SUCCEEDED, ATTEMPT_PHASE.FAILED,
  ATTEMPT_PHASE.SENT_UNKNOWN, ATTEMPT_PHASE.TOOL_RISK,
])
const PHASE_TO_TERMINAL = Object.freeze({
  [ATTEMPT_PHASE.SUCCEEDED]: TERMINAL.SUCCEEDED,
  [ATTEMPT_PHASE.FAILED]: TERMINAL.FAILED,
  [ATTEMPT_PHASE.CANCELLED_UNSENT]: TERMINAL.CANCELLED_UNSENT,
  [ATTEMPT_PHASE.SENT_UNKNOWN]: TERMINAL.SENT_UNKNOWN,
  [ATTEMPT_PHASE.TOOL_RISK]: TERMINAL.TOOL_RISK,
  [ATTEMPT_PHASE.STOP_RECONCILE]: TERMINAL.STOP_RECONCILE,
})
// 用量在这些终态下按定义不可证：必须输出 unknown。
const USAGE_MUST_BE_UNKNOWN = new Set([TERMINAL.SENT_UNKNOWN, TERMINAL.STOP_RECONCILE])

/** 拒绝码（稳定；日志/测试/接线只认这些）。 */
export const REJECT = Object.freeze({
  BAD_REQUEST: 'UHR_REJECT_BAD_REQUEST',
  IDENTITY: 'UHR_REJECT_IDENTITY',
  SCOPE: 'UHR_REJECT_SCOPE',
  CANDIDATE: 'UHR_REJECT_CANDIDATE',
  TIME_BUDGET: 'UHR_REJECT_TIME_BUDGET',
  COST_BUDGET: 'UHR_REJECT_COST_BUDGET',
  ROUTE_MISMATCH: 'UHR_REJECT_ROUTE_MISMATCH',
  USAGE_MISMATCH: 'UHR_REJECT_USAGE_MISMATCH',
  CURRENCY: 'UHR_REJECT_CURRENCY',
})

/** exact route 的字段集合（四个都要一致，缺一不可）。 */
export const ROUTE_FIELDS = Object.freeze(['model', 'provider', 'protocol', 'generation'])

const REF_PREFIX = Object.freeze({ caller: 'caller', scope: 'scope', req: 'req', att: 'att' })
const SAFE_REF_RE = /^[A-Za-z0-9_.:-]{1,64}$/
const ROUTE_VALUE_RE = /^[A-Za-z0-9_.:/-]{1,200}$/
// 审计 detail 允许 '|'（候选标签形如 model|provider），但不允许空白/引号/路径分隔后的任意文本。
const DETAIL_VALUE_RE = /^[A-Za-z0-9_.:|\/-]{1,200}$/
// 注意边界：'task-...' 含子串 'sk-'，无边界匹配会把正常标签误判成凭据。
const SECRETISH_RE = /(^|[^A-Za-z0-9_-])(sk-[A-Za-z0-9_-]{8,}|bearer\s+|api[_-]?key|password|passwd|secret)/i
const DETAIL_KEYS = new Set([
  'reason', 'model', 'provider', 'protocol', 'generation', 'candidate',
  'deadlineAt', 'elapsedMs', 'timeMs', 'budgetMicro', 'actualMicro', 'currency',
  'attemptId', 'status', 'expected', 'received', 'field', 'count', 'limit',
  'usageSource', 'terminal',
])

const toStr = (v) => (v == null ? '' : String(v))
const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const isMicro = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

function sha256Hex(text) {
  // 只依赖 node 内置；这里用同步 API，保证纯函数语义（无 IO）。
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

/**
 * 四类引用一律哈希：'caller_' / 'scope_' / 'req_' / 'att_' + sha256 前 24 hex。
 * 前缀让日志里一眼看出引用种类；明文只存在于各自模块内部。
 */
export function hashRef(kind, raw) {
  const prefix = REF_PREFIX[kind]
  if (!prefix) throw new TypeError('未知引用种类: ' + toStr(kind))
  const text = toStr(raw)
  if (!text) throw new TypeError('引用值不能为空（' + kind + '）')
  return prefix + '_' + sha256Hex(kind + ':' + text).slice(0, 24)
}

/** 深度冻结：回执不可变是契约的一部分（调用方修改必须抛错，而不是悄悄生效）。 */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

/** 规范化 JSON：键排序，用于 digest/receiptHash 的确定性。 */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  const keys = Object.keys(value).sort()
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}'
}

function label(value) {
  const text = toStr(value).trim()
  if (!text) return null
  if (SECRETISH_RE.test(text) || text.length > 120) return 'redacted'
  return text
}

function safeDetails(raw) {
  const out = {}
  if (!isPlain(raw)) return out
  for (const [key, value] of Object.entries(raw)) {
    if (!DETAIL_KEYS.has(key)) continue
    if (value == null) continue
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
    else if (typeof value === 'boolean') out[key] = value
    else if (typeof value === 'string' && (SAFE_REF_RE.test(value) || DETAIL_VALUE_RE.test(value))) out[key] = value
  }
  return out
}

function rejection(code, reason, details) {
  return deepFreeze({
    ok: false,
    contract: UHR_CONTRACT,
    version: UHR_VERSION,
    code,
    reason,
    details: safeDetails(details),
  })
}

function normalizeCurrency(value) {
  const text = toStr(value).trim().toUpperCase()
  return /^[A-Z]{3,8}$/.test(text) ? text : null
}

function normalizeRoute(route) {
  if (!isPlain(route)) return { ok: false, code: REJECT.BAD_REQUEST, reason: 'attempt.route 缺失' }
  const out = {}
  for (const field of ROUTE_FIELDS) {
    const value = toStr(route[field]).trim()
    if (!value) return { ok: false, code: REJECT.BAD_REQUEST, reason: 'route 缺少字段 ' + field, field }
    if (!ROUTE_VALUE_RE.test(value)) return { ok: false, code: REJECT.BAD_REQUEST, reason: 'route 字段 ' + field + ' 含不允许的字符', field }
    if (SECRETISH_RE.test(value)) return { ok: false, code: REJECT.BAD_REQUEST, reason: 'route 字段 ' + field + ' 看起来像凭据，拒绝写入回执', field }
    out[field] = value
  }
  out.providerKind = label(route.providerKind) || null
  return { ok: true, route: out }
}

/**
 * 构造 UHR 推理回执（纯函数）。
 *
 * 输入（uhrReceipt）：
 *   caller { ref, kind? }            调用者（明文不外泄，输出哈希）
 *   scope  { ref, authorized, expiresAt, currency, candidates:[{model,provider}], allowOfficial? }
 *   request{ id, digest?, submittedAt }
 *   budget { timeMs | deadlineAt, costMicro, currency }
 *   attempts: [{ attemptId, phase, route:{model,provider,protocol,generation,providerKind?}, startedAt, finishedAt }]
 *   decision?  M3-1 决策结果（只用 action/code/target）
 *   ledger?    M3-2 账本 receipt（status/actualMicro/currency/attemptId）
 *   usage?     'unknown' | { verified:true, inputTokens, outputTokens, costMicro, currency }
 *   expectedRoute? 上游实际收到的路由（与 attempt.route 三方对齐）
 * @returns {object} 冻结回执（ok:true）或冻结拒绝（ok:false + 稳定 code）
 */
export function modelgateInfer(uhrReceipt, options = {}) {
  const input = isPlain(uhrReceipt) ? uhrReceipt : null
  if (!input) return rejection(REJECT.BAD_REQUEST, 'uhrReceipt 必须是对象')

  const caller = isPlain(input.caller) ? input.caller : {}
  const scope = isPlain(input.scope) ? input.scope : {}
  const request = isPlain(input.request) ? input.request : {}
  const budgetIn = isPlain(input.budget) ? input.budget : {}
  const attemptsIn = Array.isArray(input.attempts) ? input.attempts : []
  const decision = isPlain(input.decision) ? input.decision : null
  const ledger = isPlain(input.ledger) ? input.ledger : null

  // 1) 调用者与作用域引用（明文只在本函数参数里出现，输出只有哈希）。
  const callerRefRaw = toStr(caller.ref).trim()
  const scopeRefRaw = toStr(scope.ref).trim()
  const requestIdRaw = toStr(request.id).trim()
  if (!callerRefRaw) return rejection(REJECT.IDENTITY, '缺少 caller.ref')
  if (!scopeRefRaw) return rejection(REJECT.SCOPE, '缺少 scope.ref')
  if (!requestIdRaw) return rejection(REJECT.BAD_REQUEST, '缺少 request.id')
  if (attemptsIn.length === 0) return rejection(REJECT.BAD_REQUEST, '回执必须至少包含一个 attempt')

  const submittedAt = Number(request.submittedAt)
  if (!Number.isFinite(submittedAt)) return rejection(REJECT.BAD_REQUEST, 'request.submittedAt 必须是毫秒时间戳')

  // 2) 作用域授权与候选集。
  if (scope.authorized !== true) return rejection(REJECT.SCOPE, '任务作用域未授权（scope.authorized !== true）')
  const expiresAt = Number(scope.expiresAt)
  if (!Number.isFinite(expiresAt)) return rejection(REJECT.SCOPE, 'scope.expiresAt 缺失')
  if (expiresAt <= submittedAt) return rejection(REJECT.SCOPE, '任务作用域在发起前就已过期', { deadlineAt: expiresAt })

  const scopeCurrency = normalizeCurrency(scope.currency)
  if (!scopeCurrency) return rejection(REJECT.CURRENCY, 'scope.currency 必须是显式币种')

  const authorized = new Map()
  const authorizedLabels = []
  for (const cand of Array.isArray(scope.candidates) ? scope.candidates : []) {
    if (!isPlain(cand)) continue
    const model = label(cand.model)
    const provider = label(cand.provider)
    if (!model || !provider) continue
    const key = model + '|' + provider
    if (!authorized.has(key)) {
      authorized.set(key, { model, provider })
      authorizedLabels.push(key)
    }
  }
  if (!authorized.size) return rejection(REJECT.CANDIDATE, '授权候选集为空')

  // 3) 预算（时间 + 费用），币种必须一致（不做换算）。
  const budgetCurrency = normalizeCurrency(budgetIn.currency)
  if (!budgetCurrency) return rejection(REJECT.CURRENCY, 'budget.currency 必须是显式币种')
  if (budgetCurrency !== scopeCurrency) {
    return rejection(REJECT.CURRENCY, 'budget 与 scope 币种不一致：拒绝隐式换算', { currency: scopeCurrency })
  }
  const costBudgetMicro = budgetIn.costMicro
  if (!isMicro(costBudgetMicro)) return rejection(REJECT.COST_BUDGET, 'budget.costMicro 必须是非负整数最小单位')
  let timeMs = Number(budgetIn.timeMs)
  let deadlineAt = Number(budgetIn.deadlineAt)
  if (Number.isFinite(deadlineAt)) {
    timeMs = deadlineAt - submittedAt
  } else if (Number.isFinite(timeMs)) {
    deadlineAt = submittedAt + timeMs
  } else {
    return rejection(REJECT.BAD_REQUEST, '缺少时间预算（timeMs 或 deadlineAt）')
  }
  if (!Number.isFinite(timeMs) || timeMs <= 0) {
    return rejection(REJECT.TIME_BUDGET, '时间预算必须为正', { timeMs })
  }

  // 4) attempts：阶段、路由、时间线。
  const attempts = []
  const phases = []
  let lastFinishedAt = Number.NEGATIVE_INFINITY
  for (const raw of attemptsIn) {
    if (!isPlain(raw)) return rejection(REJECT.BAD_REQUEST, 'attempt 必须是对象')
    const attemptIdRaw = toStr(raw.attemptId).trim()
    if (!attemptIdRaw) return rejection(REJECT.BAD_REQUEST, 'attempt.attemptId 缺失')
    const phase = toStr(raw.phase).trim().toLowerCase()
    if (!PHASES.has(phase)) return rejection(REJECT.BAD_REQUEST, '未知 attempt 阶段（必须与 M1-1 对齐）', { received: phase || 'missing' })
    const routeNorm = normalizeRoute(raw.route)
    if (!routeNorm.ok) return rejection(routeNorm.code, routeNorm.reason, routeNorm)
    const sent = SENT_PHASES.has(phase)
    const startedAt = Number(raw.startedAt)
    const finishedAt = Number(raw.finishedAt)
    if (sent && !Number.isFinite(startedAt)) return rejection(REJECT.BAD_REQUEST, '已发送 attempt 必须给 startedAt')
    if (Number.isFinite(finishedAt)) lastFinishedAt = Math.max(lastFinishedAt, finishedAt)
    attempts.push({
      attemptId: hashRef('att', attemptIdRaw),
      phase,
      terminal: PHASE_TO_TERMINAL[phase],
      sent,
      route: routeNorm.route,
      startedAt: Number.isFinite(startedAt) ? startedAt : null,
      finishedAt: Number.isFinite(finishedAt) ? finishedAt : null,
    })
    phases.push(phase)
  }

  const finishedAt = Number.isFinite(lastFinishedAt) ? lastFinishedAt : Number(input.finishedAt)
  if (!Number.isFinite(finishedAt)) return rejection(REJECT.BAD_REQUEST, '缺少 finishedAt（最后一个 attempt 或 receipt.finishedAt）')
  if (finishedAt < submittedAt) return rejection(REJECT.BAD_REQUEST, 'finishedAt 早于 submittedAt', { deadlineAt })
  const elapsedMs = finishedAt - submittedAt
  if (elapsedMs > timeMs) {
    // 超时间预算：明确拒绝，而不是给一份"看起来正常"的回执。
    return rejection(REJECT.TIME_BUDGET, '实际耗时超出时间预算', { timeMs, elapsedMs })
  }

  // 5) 终态（优先级：工具风险 > 对账 > 已发送未知 > 未发送 > 成功 > 失败）。
  let terminal = TERMINAL.FAILED
  if (phases.includes(ATTEMPT_PHASE.TOOL_RISK)) terminal = TERMINAL.TOOL_RISK
  else if (phases.includes(ATTEMPT_PHASE.STOP_RECONCILE) || (decision && decision.code === STOP.RECONCILE)) terminal = TERMINAL.STOP_RECONCILE
  else if (phases.includes(ATTEMPT_PHASE.SENT_UNKNOWN)) terminal = TERMINAL.SENT_UNKNOWN
  else if (!phases.some((p) => SENT_PHASES.has(p))) terminal = TERMINAL.CANCELLED_UNSENT
  else if (phases[phases.length - 1] === ATTEMPT_PHASE.SUCCEEDED) terminal = TERMINAL.SUCCEEDED

  if (terminal === TERMINAL.SUCCEEDED && !phases.includes(ATTEMPT_PHASE.SUCCEEDED)) {
    return rejection(REJECT.BAD_REQUEST, '终态 SUCCEEDED 但没有任何 succeeded attempt')
  }

  // 6) 路由一致性：attempt.route 必须都在授权候选集内，且与裁决目标/上游实见三方一致。
  const lastAttempt = attempts[attempts.length - 1]
  const route = lastAttempt.route
  for (const attempt of attempts) {
    const key = attempt.route.model + '|' + attempt.route.provider
    const hit = authorized.get(key)
    if (!hit) {
      return rejection(REJECT.CANDIDATE, 'attempt 使用了未授权候选', { candidate: key })
    }
    const official = attempt.route.providerKind === 'official_subscription' || attempt.route.providerKind === 'official'
    if (official && scope.allowOfficial !== true) {
      return rejection(REJECT.CANDIDATE, '官方订阅候选未获授权进入通用推理', { candidate: key })
    }
  }
  if (decision && isPlain(decision.target)) {
    for (const field of ['model', 'provider']) {
      const want = toStr(decision.target[field]).trim()
      if (want && want !== route[field]) {
        return rejection(REJECT.ROUTE_MISMATCH, '回执路由与裁决目标不一致', {
          field, expected: want, received: route[field],
        })
      }
    }
    for (const field of ['protocol', 'generation']) {
      const want = toStr(decision.target[field]).trim()
      if (want && want !== route[field]) {
        return rejection(REJECT.ROUTE_MISMATCH, '回执路由与裁决目标不一致', {
          field, expected: want, received: route[field],
        })
      }
    }
  }
  if (isPlain(input.expectedRoute)) {
    for (const field of ROUTE_FIELDS) {
      const want = toStr(input.expectedRoute[field]).trim()
      if (want && want !== route[field]) {
        return rejection(REJECT.ROUTE_MISMATCH, '回执路由与上游实见路由不一致（上游看到的 = 回执写的）', {
          field, expected: want, received: route[field],
        })
      }
    }
  }

  // 7) 用量与费用：未知就是 unknown；只有确证未发出才是已知 0。
  const usageIn = input.usage
  const ledgerStatus = ledger ? toStr(ledger.status) : ''
  const ledgerAttemptHash = ledger && toStr(ledger.attemptId).trim() ? hashRef('att', toStr(ledger.attemptId).trim()) : null
  if (ledgerAttemptHash && !attempts.some((a) => a.attemptId === ledgerAttemptHash)) {
    return rejection(REJECT.BAD_REQUEST, '账本 receipt 的 attemptId 不在本次回执的 attempt 列表里（链路不完整）')
  }
  const ledgerCurrency = ledger && ledger.currency != null ? normalizeCurrency(ledger.currency) : null
  if (ledgerCurrency && ledgerCurrency !== budgetCurrency) {
    return rejection(REJECT.CURRENCY, '账本币种与预算币种不一致：拒绝隐式换算', { currency: budgetCurrency })
  }

  const ledgerSettled = ledgerStatus === LEDGER_STATUS.SETTLED
  const ledgerReleased = ledgerStatus === LEDGER_STATUS.RELEASED
  const ledgerCostMicro = ledgerSettled && isMicro(ledger.actualMicro) ? ledger.actualMicro : null
  const ledgerCostKnown = ledgerSettled && ledgerCostMicro != null

  let tokensKnown = false
  let inputTokens = null
  let outputTokens = null
  let usageCostMicro = null
  let usageVerified = false
  if (isPlain(usageIn)) {
    inputTokens = usageIn.inputTokens
    outputTokens = usageIn.outputTokens
    usageCostMicro = usageIn.costMicro
    usageVerified = usageIn.verified === true
    tokensKnown = isMicro(inputTokens) && isMicro(outputTokens)
    if (usageIn.costMicro != null && !isMicro(usageIn.costMicro)) {
      return rejection(REJECT.BAD_REQUEST, 'usage.costMicro 必须是非负整数最小单位')
    }
  }

  let costKnown = false
  let costMicro = null
  let costSource = 'unknown'
  if (terminal === TERMINAL.CANCELLED_UNSENT) {
    costKnown = true
    costMicro = 0
    costSource = 'not_sent'
  } else if (ledgerCostKnown) {
    costKnown = true
    costMicro = ledgerCostMicro
    costSource = 'ledger'
  } else if (ledgerReleased) {
    costKnown = true
    costMicro = 0
    costSource = 'ledger_released'
  } else if (usageVerified && isMicro(usageCostMicro)) {
    costKnown = true
    costMicro = usageCostMicro
    costSource = 'upstream'
  }
  // 账本已结算 + 上游用量都给时，两边必须一致（不一致说明记账口径错了，不能糊过去）。
  if (ledgerCostKnown && usageVerified && isMicro(usageCostMicro) && usageCostMicro !== ledgerCostMicro) {
    return rejection(REJECT.USAGE_MISMATCH, '上游用量与账本结算金额不一致', {
      actualMicro: ledgerCostMicro, expected: usageCostMicro, currency: budgetCurrency,
    })
  }
  if (costKnown && costMicro > costBudgetMicro) {
    // 超费用预算：明确拒绝（数字如实回显，不静默降级、不改选更便宜候选）。
    return rejection(REJECT.COST_BUDGET, '实际费用超出费用预算', {
      budgetMicro: costBudgetMicro, actualMicro: costMicro, currency: budgetCurrency,
    })
  }

  const usageKnown = terminal === TERMINAL.CANCELLED_UNSENT ||
    (usageVerified && tokensKnown && costKnown && !USAGE_MUST_BE_UNKNOWN.has(terminal))

  const usage = usageKnown
    ? {
      known: true,
      inputTokens: terminal === TERMINAL.CANCELLED_UNSENT ? 0 : inputTokens,
      outputTokens: terminal === TERMINAL.CANCELLED_UNSENT ? 0 : outputTokens,
      totalTokens: terminal === TERMINAL.CANCELLED_UNSENT ? 0 : inputTokens + outputTokens,
      costMicro: terminal === TERMINAL.CANCELLED_UNSENT ? 0 : costMicro,
      currency: budgetCurrency,
      unit: 'micro',
      source: terminal === TERMINAL.CANCELLED_UNSENT ? 'not_sent' : costSource,
    }
    : 'unknown'

  const refs = {
    callerRef: hashRef('caller', callerRefRaw),
    callerKind: label(caller.kind) || null,
    scopeRef: hashRef('scope', scopeRefRaw),
    requestId: hashRef('req', requestIdRaw),
    attemptIds: attempts.map((a) => a.attemptId),
  }

  const body = {
    ok: true,
    contract: UHR_CONTRACT,
    version: UHR_VERSION,
    refs,
    terminal,
    unknownUsage: usage === 'unknown',
    usage,
    cost: { known: costKnown, micro: costKnown ? costMicro : null, currency: budgetCurrency, unit: 'micro', source: costSource },
    route,
    routeExact: true,
    attempts,
    budget: { timeMs, costMicro: costBudgetMicro, currency: budgetCurrency },
    window: { submittedAt, finishedAt, elapsedMs, deadlineAt },
    authorization: { candidates: authorizedLabels, officialAllowed: scope.allowOfficial === true, scopeExpiresAt: expiresAt },
    decision: decision ? { action: label(decision.action), code: label(decision.code) } : null,
    ledger: ledger
      ? {
        attemptId: ledgerAttemptHash,
        status: label(ledger.status),
        actualMicro: ledgerCostMicro,
        currency: ledgerCurrency,
      }
      : null,
  }
  return deepFreeze(Object.assign(body, { receiptHash: sha256Hex(canonicalJson(body)) }))
}

/** 便捷判定：某终态是否允许已知用量（契约自检/接线用）。 */
export function usageMustBeUnknown(terminal) {
  return USAGE_MUST_BE_UNKNOWN.has(toStr(terminal))
}

export { TERMINAL as TERMINALS }
