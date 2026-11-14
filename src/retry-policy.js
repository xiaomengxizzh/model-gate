// 429 归因 / Retry-After 预算 / 非幂等不重放判定（G1 治理，零第三方依赖）。
// 契约见 docs/contracts/request-lifecycle-v1.md「429 / Retry-After / 非幂等不重放」。
// 本模块只做纯函数判定，不依赖其他 src 模块、不做 IO，便于离线单元测试：
//   - classifyStatus / recordAttemptOutcome / planAttemptRetry / createAttemptPolicy：
//     M1-1 单次发送的终态分类与下一次发送许可（只有 UNSENT 或可证明的前置拒绝可再发）；
//   - classify429：把上游 429 的语义分成 平台额度 / 模型容量 / 速率限流 / 未知，供错误信封与运维归因；
//   - parseRetryAfterMs / retryWaitCap / retryWaitFits：把 Retry-After 与请求剩余预算对齐，
//     保证「等得下才等，等不下就停」，绝不空等越过 deadline；
//   - isToolBearingBody：识别带工具语义（tools / tool_calls / tool 结果）的请求，
//     这类请求非幂等（可能触发生成 shell_command/apply_patch），默认不自动重放。

import { STAGES, OUTCOMES, retrySafetyOf, executionCertaintyOf, summarizeError } from './attempt-state.js'

/** 429 归因取值（错误信封的 code 由 attributionCode 派生）。 */
export const ATTRIBUTION = {
  PLATFORM_QUOTA: 'platform_quota',
  MODEL_CAPACITY: 'model_capacity',
  RATE_LIMIT: 'rate_limit',
  UNKNOWN: 'unknown',
}

/** 读取上游错误体用于归因的上限：只读 8KB，读完立即销毁连接。 */
export const MAX_ERR_BODY_BYTES = 8 * 1024

/** 单次 Retry-After 等待的硬上限（毫秒）：上游给 1h 也不能把请求挂死。 */
export const MAX_RETRY_AFTER_MS = 30000

/** 等待余量：等待必须给收尾（写响应/释放连接）留出时间，不能卡在 deadline 边界上。 */
export const RETRY_WAIT_MARGIN_MS = 50

// 只做保守的文本匹配：命中即归因，匹配不到一律 unknown，绝不臆造。
const QUOTA_RE = /(insufficient|quota|billing|balance|credit|payment|欠费|余额|额度|配额|exceeded your current quota)/i
const CAPACITY_RE = /(capacity|overload|overloaded|busy|concurren|at capacity|server is busy|系统繁忙|并发)/i
const RATE_RE = /(rate.?limit|too many requests|requests per (minute|second)|\brpm\b|\btpm\b|throttl|频率|速率)/i

/** 大小写不敏感地取一个响应头（Node 上游头多为小写，测试/代理可能给原生大小写）。 */
export function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return null
  const want = String(name).toLowerCase()
  const direct = headers[want]
  if (direct !== undefined && direct !== null) return direct
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() === want && v !== undefined && v !== null) return v
  }
  return null
}

/**
 * 解析 429 语义。
 * @param {string} bodyText 错误体文本片段（调用方限长，<= MAX_ERR_BODY_BYTES）
 * @param {object} headers  上游响应头
 * @returns {{attribution: 'platform_quota'|'model_capacity'|'rate_limit'|'unknown', hasRetryAfter: boolean}}
 */
export function classify429(bodyText, headers) {
  const text = String(bodyText == null ? '' : bodyText)
  const hasRetryAfter = headerValue(headers, 'retry-after') != null
  let attribution = ATTRIBUTION.UNKNOWN
  if (QUOTA_RE.test(text)) attribution = ATTRIBUTION.PLATFORM_QUOTA
  else if (CAPACITY_RE.test(text)) attribution = ATTRIBUTION.MODEL_CAPACITY
  else if (RATE_RE.test(text)) attribution = ATTRIBUTION.RATE_LIMIT
  else if (hasRetryAfter) attribution = ATTRIBUTION.RATE_LIMIT // 无文本但有 Retry-After：按速率限流处理
  return { attribution, hasRetryAfter }
}

/** 解析 Retry-After：纯秒数或 HTTP-date；无法解析返回 null（= 上游没给可用信号）。 */
export function parseRetryAfterMs(headers) {
  const raw = headerValue(headers, 'retry-after')
  if (raw == null) return null
  const s = String(raw).trim()
  if (!s) return null
  const n = parseInt(s, 10)
  if (/^\d+$/.test(s) && !isNaN(n)) return n * 1000
  const dt = Date.parse(s)
  if (!isNaN(dt)) return Math.max(0, dt - Date.now())
  return null
}

/**
 * 本次请求最多可接受的 Retry-After 等待量（毫秒）。
 * @param {number} remainingMs 请求剩余预算；Infinity = 无整体预算
 * @param {number} maxWaitMs   单次等待上限（默认 MAX_RETRY_AFTER_MS）
 */
export function retryWaitCap(remainingMs, maxWaitMs = MAX_RETRY_AFTER_MS) {
  const hard = Number(maxWaitMs) > 0 ? Number(maxWaitMs) : MAX_RETRY_AFTER_MS
  if (!Number.isFinite(remainingMs)) return hard
  return Math.max(0, Math.min(hard, remainingMs - RETRY_WAIT_MARGIN_MS))
}

/** Retry-After 是否还在本次请求可承受范围内（false = 不许等，立即收尾/换上游）。 */
export function retryWaitFits(retryAfterMs, remainingMs, maxWaitMs = MAX_RETRY_AFTER_MS) {
  if (retryAfterMs == null) return true
  const ms = Number(retryAfterMs)
  if (!Number.isFinite(ms) || ms <= 0) return true
  return ms <= retryWaitCap(remainingMs, maxWaitMs)
}

/** 429 的 Retry-After 响应头值（秒，整数）。null = 上游没给，不臆造。 */
export function retryAfterHeader(ms) {
  if (ms == null) return null
  const n = Number(ms)
  if (!Number.isFinite(n)) return null
  return String(n <= 0 ? 0 : Math.ceil(n / 1000))
}

/** 429 错误信封里的稳定业务码：MG_429_<ATTRIBUTION>。 */
export function attributionCode(attribution) {
  const a = String(attribution || ATTRIBUTION.UNKNOWN).toUpperCase()
  return 'MG_429_' + a
}

/**
 * 请求是否携带工具语义（非幂等）：工具定义、Responses 的 input 工具项、或消息里已有
 * tool_calls / role=tool 的工具结果。这类请求自动重放可能重复触发客户端已执行的工具。
 */
export function isToolBearingBody(body) {
  if (!body || typeof body !== 'object') return false
  if (Array.isArray(body.tools) && body.tools.length) return true
  if (Array.isArray(body.input) && body.input.some((it) => it && typeof it === 'object' && /tool_call|function_call/.test(String(it.type || '')))) return true
  if (Array.isArray(body.messages) && body.messages.some((m) => m && (m.role === 'tool' || (Array.isArray(m.tool_calls) && m.tool_calls.length)))) return true
  return false
}

// ---------------------------------------------------------------------------
// M1-1：单次发送的终态分类与重试许可
// 关键规则（审计 P1）：不按 HTTP status 单独推导可安全重放。只有
//   - UNSENT（请求未写出），或
//   - REJECTED_BEFORE_EXECUTION（供应商可证明前置拒绝：429 前置限流 / 402 未支付 /
//     404 模型不存在 / 4xx 参数拒绝 / 连接前置失败）
// 才允许下一次发送；SENT_UNKNOWN / ACCEPTED / DELIVERED / TOOL_RISK / PARTIAL_COMMIT
// 一律终止为可诊断终态，不得隐式重放。
// ---------------------------------------------------------------------------

/**
 * HTTP 状态分类（仅作为证据输入，不单独决定重放）：
 *  - 2xx：成功；
 *  - 429：已证实的前置限流（未执行），保留 Retry-After/归因，独立于熔断；
 *  - 402 / 404：明确未执行（未支付 / 模型不存在），允许换候选；
 *  - 401/403 与其他 4xx：业务拒绝，原样归一、不重试；
 *  - 408/409/425/5xx：已收到响应头但执行状态未知 → 不可安全重放；
 *  - 3xx：不自动跟随，也不重放。
 */
export function classifyStatus(status) {
  const n = Number(status)
  const base = { status: Number.isInteger(n) ? n : null, swapAllowed: false, providerExecuted: null, business: false }
  if (!Number.isInteger(n) || n < 100) return Object.assign(base, { class: 'unknown', retrySafety: 'unsafe', business: true })
  if (n >= 200 && n < 300) return Object.assign(base, { class: 'success', retrySafety: 'unsafe', providerExecuted: true })
  if (n === 429) return Object.assign(base, { class: 'rate_limited', retrySafety: 'rejected_before_execution', providerExecuted: false, retryAfterRelevant: true })
  if (n === 402) return Object.assign(base, { class: 'payment_required', retrySafety: 'rejected_before_execution', providerExecuted: false, swapAllowed: true })
  if (n === 404) return Object.assign(base, { class: 'model_unavailable', retrySafety: 'rejected_before_execution', providerExecuted: false, swapAllowed: true })
  if (n === 401 || n === 403) return Object.assign(base, { class: 'auth_rejected', retrySafety: 'rejected_before_execution', providerExecuted: false, business: true })
  if (n === 408 || n === 409 || n === 425) return Object.assign(base, { class: 'transient_request', retrySafety: 'unsafe' })
  if (n >= 300 && n < 400) return Object.assign(base, { class: 'redirect', retrySafety: 'unsafe' })
  if (n >= 400 && n < 500) return Object.assign(base, { class: 'business_4xx', retrySafety: 'rejected_before_execution', providerExecuted: false, business: true })
  if (n >= 500) return Object.assign(base, { class: 'upstream_failure', retrySafety: 'unsafe' })
  return Object.assign(base, { class: 'unknown', retrySafety: 'unsafe', business: true })
}

// 可重试的传输层错误（仅当请求尚未写出时才会被用于同目标退避重试）。
const RETRYABLE_TRANSPORT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
  'ECONNABORTED', 'UND_ERR_SOCKET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EAI_FAIL',
])

export function isRetryableTransportError(err) {
  if (!err || err.aborted) return false
  const code = err.code
  if (!code) return true // 无 code 的传输错误按可重试处理（与既有 forward 语义一致）
  return RETRYABLE_TRANSPORT_CODES.has(code)
}

function errorEnvelope(type, detail = {}) {
  return Object.assign({ type }, detail)
}

function transportEnvelope(error) {
  return errorEnvelope('transport_error', {
    code: (error && error.code) || null,
    message: String((error && error.message) || 'transport error').slice(0, 200),
  })
}

/**
 * 把一次尝试的结果/异常记录为执行器可用的终态分类（会通过 attempt 回调记录证据）。
 * 返回 { outcome, terminal, retrySameTarget, swapAllowed, needsSwitch, countsAsProviderFailure, ... }。
 * terminal=true 表示执行器必须立即收尾，不得再发。
 */
export function recordAttemptOutcome(input = {}) {
  const { attempt, result, error, deadline } = input
  if (!attempt) throw new TypeError('recordAttemptOutcome: attempt required')
  const timedOut = !!(deadline && typeof deadline.timedOut === 'function' && deadline.timedOut())
  const cancelled = !!(deadline && typeof deadline.cancelled === 'function' && deadline.cancelled())
  const aborted = timedOut || cancelled || !!(error && error.aborted)

  if (result) {
    const status = Number(result.status)
    attempt.status = Number.isInteger(status) ? status : Number(result.status)
    if (result.headers) attempt.headers = result.headers
    if (attempt.stage === STAGES.UNSENT) attempt.onWriteBegin({ inferred: true, hasBody: result.wroteBody !== false })
    attempt.onResponseHeaders({ status: attempt.status, headers: attempt.headers })
    if (result.ok === true || (Number.isFinite(status) && status >= 200 && status < 300)) {
      attempt.onTerminal({ ok: true, kind: 'succeeded', status })
      return {
        outcome: OUTCOMES.SUCCEEDED,
        terminal: true,
        status,
        headers: attempt.headers || null,
        result,
        retrySameTarget: false,
        swapAllowed: false,
        needsSwitch: false,
        countsAsProviderFailure: false,
        execution: attempt.semanticEvents ? 'delivered' : 'accepted',
        delivered: attempt.delivered,
      }
    }
    const cls = classifyStatus(status)
    if (cls.retrySafety === 'rejected_before_execution') {
      attempt.onKnownRejection({ proven: true, kind: cls.class, status })
    }
    if (status === 429) {
      const bodyText = String(result.bodyText || '')
      const cls429 = classify429(bodyText, attempt.headers || {})
      const rawRetryAfter = result.retryAfter !== undefined && result.retryAfter !== null
        ? Number(result.retryAfter)
        : parseRetryAfterMs(attempt.headers || {})
      attempt.attribution = cls429.attribution
      attempt.retryAfterMs = Number.isFinite(rawRetryAfter) ? Math.max(0, rawRetryAfter) : null
      attempt.hasRetryAfter = cls429.hasRetryAfter
      attempt.onTerminal({ ok: false, kind: 'rate_limited', status })
      return {
        outcome: OUTCOMES.REJECTED_BEFORE_EXECUTION,
        terminal: false,
        status,
        headers: attempt.headers || null,
        retrySameTarget: true,
        swapAllowed: false,
        needsSwitch: false,
        countsAsProviderFailure: false,
        circuit: 'unaffected',
        execution: 'rejected_before_execution',
        attribution: cls429.attribution,
        attributionCode: attributionCode(cls429.attribution),
        retryAfterMs: attempt.retryAfterMs,
        hasRetryAfter: cls429.hasRetryAfter,
        bodyText: bodyText.slice(0, MAX_ERR_BODY_BYTES),
        error: errorEnvelope('rate_limited', {
          code: attributionCode(cls429.attribution),
          attribution: cls429.attribution,
          upstream_status: status,
          retry_after_ms: attempt.retryAfterMs,
          message: bodyText.slice(0, 200) || 'upstream rate limited',
        }),
      }
    }
    if (status === 402 || status === 404) {
      const bodyText = String(result.bodyText || '')
      attempt.onTerminal({ ok: false, kind: cls.class, status })
      return {
        outcome: OUTCOMES.REJECTED_BEFORE_EXECUTION,
        terminal: false,
        status,
        headers: attempt.headers || null,
        retrySameTarget: false,
        swapAllowed: true,
        needsSwitch: true,
        countsAsProviderFailure: false,
        circuit: 'unaffected',
        execution: 'rejected_before_execution',
        businessError: true,
        errorClass: cls.class,
        bodyText: bodyText.slice(0, MAX_ERR_BODY_BYTES),
        error: errorEnvelope(status === 402 ? 'payment_required' : 'model_unavailable', {
          upstream_status: status,
          attribution: status === 402 ? 'payment_required' : 'model_unavailable',
          message: bodyText.slice(0, 200) || ('HTTP ' + status),
        }),
      }
    }
    if (cls.retrySafety === 'rejected_before_execution') {
      const bodyText = String(result.bodyText || '')
      attempt.onTerminal({ ok: false, kind: cls.class, status })
      return {
        outcome: OUTCOMES.REJECTED_BEFORE_EXECUTION,
        terminal: true,
        status,
        headers: attempt.headers || null,
        retrySameTarget: false,
        swapAllowed: false,
        needsSwitch: false,
        countsAsProviderFailure: false,
        execution: 'rejected_before_execution',
        businessError: true,
        errorClass: cls.class,
        bodyText: bodyText.slice(0, MAX_ERR_BODY_BYTES),
        error: errorEnvelope('upstream_client_error', {
          upstream_status: status,
          message: bodyText.slice(0, 200) || ('HTTP ' + status),
        }),
      }
    }
    // 3xx / 5xx：响应头已到，执行状态未知。不得按状态码推导可安全重放。
    attempt.onTerminal({ ok: false, kind: cls.class, status })
    return {
      outcome: OUTCOMES.FAILED,
      terminal: true,
      status,
      headers: attempt.headers || null,
      retrySameTarget: false,
      swapAllowed: false,
      needsSwitch: false,
      countsAsProviderFailure: cls.class === 'upstream_failure',
      execution: 'accepted_unknown',
      errorClass: cls.class,
      error: errorEnvelope('upstream_failure', {
        upstream_status: status,
        message: (String(result.bodyText || '').slice(0, 200)) || ('HTTP ' + status),
      }),
    }
  }

  const errSummary = summarizeError(error)
  attempt.error = errSummary
  if (aborted) {
    const isCancel = cancelled || (error && error.reason === 'client_closed') || (!timedOut && !(deadline && deadline.timedOut()) && !!(error && error.aborted))
    attempt.cancelled = isCancel
    attempt.timedOut = !isCancel
    attempt.onTerminal({ ok: false, kind: isCancel ? 'cancelled' : 'deadline', error })
    const noSend = attempt.stage === STAGES.UNSENT
    return {
      outcome: isCancel ? (noSend ? OUTCOMES.CANCELLED_UNSENT : OUTCOMES.CANCELLED) : OUTCOMES.DEADLINE_EXCEEDED,
      terminal: true,
      retrySameTarget: false,
      swapAllowed: false,
      needsSwitch: false,
      countsAsProviderFailure: false,
      circuit: 'unaffected',
      execution: executionCertaintyOf(attempt),
      error: isCancel
        ? errorEnvelope('client_closed', { code: 'ECANCELED', aborted: true })
        : errorEnvelope('request_timeout', { code: 'ETIMEDOUT', aborted: true }),
    }
  }
  if (attempt.stage === STAGES.UNSENT) {
    attempt.onTerminal({ ok: false, kind: 'unsent_error', error })
    return {
      outcome: OUTCOMES.FAILED_UNSENT,
      terminal: false,
      retrySameTarget: isRetryableTransportError(error),
      swapAllowed: false,
      needsSwitch: false,
      countsAsProviderFailure: true,
      execution: 'not_sent',
      errorClass: (error && error.code) || 'transport_error',
      error: transportEnvelope(error),
    }
  }
  if (attempt.stage === STAGES.SENT_UNKNOWN) {
    attempt.onTerminal({ ok: false, kind: 'sent_unknown', error })
    return {
      outcome: OUTCOMES.SENT_UNKNOWN,
      terminal: true,
      retrySameTarget: false,
      swapAllowed: false,
      needsSwitch: false,
      countsAsProviderFailure: true,
      execution: 'unknown',
      errorClass: (error && error.code) || 'transport_error',
      error: transportEnvelope(error),
    }
  }
  if (attempt.stage === STAGES.TOOL_RISK || attempt.stage === STAGES.PARTIAL_COMMIT) {
    const riskOutcome = attempt.stage === STAGES.TOOL_RISK ? OUTCOMES.TOOL_RISK : OUTCOMES.PARTIAL_COMMIT
    attempt.onTerminal({ ok: false, kind: 'side_effect_risk', error })
    return {
      outcome: riskOutcome,
      terminal: true,
      retrySameTarget: false,
      swapAllowed: false,
      needsSwitch: false,
      countsAsProviderFailure: true,
      execution: executionCertaintyOf(attempt),
      errorClass: (error && error.code) || 'side_effect_risk',
      error: transportEnvelope(error),
    }
  }
  if (attempt.stage === STAGES.DELIVERED) {
    attempt.onTerminal({ ok: false, kind: 'interrupted_after_delivery', error })
    return {
      outcome: OUTCOMES.FAILED,
      terminal: true,
      retrySameTarget: false,
      swapAllowed: false,
      needsSwitch: false,
      countsAsProviderFailure: true,
      execution: 'delivered',
      delivered: true,
      error: transportEnvelope(error),
    }
  }
  if (attempt.stage === STAGES.ACCEPTED) {
    attempt.onTerminal({ ok: false, kind: 'interrupted_after_headers', error })
    return {
      outcome: OUTCOMES.FAILED,
      terminal: true,
      retrySameTarget: false,
      swapAllowed: false,
      needsSwitch: false,
      countsAsProviderFailure: true,
      execution: 'accepted_unknown',
      error: transportEnvelope(error),
    }
  }
  if (attempt.stage === STAGES.REJECTED_BEFORE_EXECUTION) {
    attempt.onTerminal({ ok: false, kind: 'rejected_before_execution', error })
    return {
      outcome: OUTCOMES.REJECTED_BEFORE_EXECUTION,
      terminal: false,
      retrySameTarget: false,
      swapAllowed: false,
      needsSwitch: false,
      countsAsProviderFailure: false,
      execution: 'rejected_before_execution',
      error: transportEnvelope(error),
    }
  }
  return {
    outcome: OUTCOMES.FAILED,
    terminal: true,
    retrySameTarget: false,
    swapAllowed: false,
    needsSwitch: false,
    countsAsProviderFailure: true,
    execution: executionCertaintyOf(attempt),
    error: transportEnvelope(error),
  }
}

/**
 * 下一次发送的等待/停止计划（纯函数）：
 *  - 429 有 Retry-After：装得下才等（retryWaitCap/retryWaitFits），装不下立即终态；
 *  - UNSENT 传输错误：同目标指数退避，等待同样受剩余预算钳制；
 *  - 可证明前置拒绝（402/404）：仅在策略允许且有下一候选时换目标；
 *  - 其余终态：stop。
 * rng 可注入，测试可用固定值避免随机性。
 */
export function planAttemptRetry(input = {}) {
  const outcome = input.outcome || null
  const attemptsMade = Math.max(0, Number(input.attemptsMade) || 0)
  const maxAttempts = Math.max(1, Number(input.maxAttempts) || 1)
  const remainingMs = input.remainingMs === undefined ? Infinity : Number(input.remainingMs)
  const maxRetryAfterMs = Number(input.maxRetryAfterMs) > 0 ? Number(input.maxRetryAfterMs) : MAX_RETRY_AFTER_MS
  const initialDelayMs = Number.isFinite(Number(input.initialDelayMs)) ? Math.max(0, Number(input.initialDelayMs)) : 500
  const maxDelayMs = Number.isFinite(Number(input.maxDelayMs)) ? Math.max(0, Number(input.maxDelayMs)) : 8000
  const jitter = Number.isFinite(Number(input.jitter)) ? Math.max(0, Number(input.jitter)) : 0
  const rng = typeof input.rng === 'function' ? input.rng : Math.random

  if (!outcome) return { stop: true, reason: 'no_outcome' }
  if (outcome.terminal) return { stop: true, reason: 'terminal', outcome: outcome.outcome }
  if (attemptsMade >= maxAttempts) return { stop: true, reason: 'attempts_exhausted', outcome: outcome.outcome }
  if (Number.isFinite(remainingMs) && remainingMs <= 0) return { stop: true, reason: 'deadline_exceeded', outcome: outcome.outcome }

  const retryAfterMs = outcome.retryAfterMs
  if (retryAfterMs != null) {
    if (!retryWaitFits(retryAfterMs, remainingMs, maxRetryAfterMs)) {
      return { stop: true, reason: 'retry_after_over_budget', outcome: outcome.outcome, retryAfterMs }
    }
    const cap = retryWaitCap(remainingMs, maxRetryAfterMs)
    return { stop: false, waitMs: Math.max(0, Math.min(Number(retryAfterMs), cap)), retryAfter: true, switchTarget: false }
  }

  if (outcome.needsSwitch) {
    if (!input.allowCandidateSwitch || !input.hasNextCandidate) {
      return { stop: true, reason: 'no_candidate', outcome: outcome.outcome }
    }
    return { stop: false, waitMs: 0, switchTarget: true }
  }

  if (outcome.outcome === OUTCOMES.REJECTED_BEFORE_EXECUTION) {
    if (!outcome.retrySameTarget) return { stop: true, reason: 'rejected_non_retryable', outcome: outcome.outcome }
    // 429 无 Retry-After / 无法解析：按指数退避（仍受同一 deadline 钳制）
  } else if (outcome.outcome === OUTCOMES.FAILED_UNSENT) {
    if (!outcome.retrySameTarget) return { stop: true, reason: 'non_retryable_error', outcome: outcome.outcome }
  } else {
    return { stop: true, reason: 'unsafe_to_retry', outcome: outcome.outcome }
  }

  const base = Math.min(maxDelayMs, initialDelayMs * Math.pow(2, Math.max(0, attemptsMade - 1)))
  const backoff = base + base * jitter * rng()
  const cap = Number.isFinite(remainingMs) ? Math.max(0, remainingMs - 1) : Infinity
  if (backoff >= cap) return { stop: true, reason: 'deadline_exceeded', outcome: outcome.outcome }
  return { stop: false, waitMs: Math.min(backoff, cap), retryAfter: false, switchTarget: false }
}

/**
 * 默认策略：单请求内最多 maxAttempts 次发送；可选 candidates 用于
 * 「已证明未执行」（402/404/前置限流）时切换候选。策略实例按请求创建（有内部状态）。
 */
export function createAttemptPolicy(opts = {}) {
  const maxAttempts = Math.max(1, Math.floor(Number(opts.maxAttempts) || 1))
  const candidates = Array.isArray(opts.candidates) && opts.candidates.length ? opts.candidates.slice() : null
  const allowCandidateSwitch = opts.allowCandidateSwitch !== false
  const retryOpts = {
    maxRetryAfterMs: Number(opts.maxRetryAfterMs) > 0 ? Number(opts.maxRetryAfterMs) : MAX_RETRY_AFTER_MS,
    initialDelayMs: Number.isFinite(Number(opts.initialDelayMs)) ? Number(opts.initialDelayMs) : 500,
    maxDelayMs: Number.isFinite(Number(opts.maxDelayMs)) ? Number(opts.maxDelayMs) : 8000,
    jitter: Number.isFinite(Number(opts.jitter)) ? Number(opts.jitter) : 0.2,
    rng: typeof opts.rng === 'function' ? opts.rng : undefined,
    allowCandidateSwitch,
  }
  let nextCandidate = 0
  return {
    maxAttempts,
    candidates,
    hasBudgetForAnotherAttempt(context) {
      if (!context || context.attempts.length >= maxAttempts) return false
      const last = context.last
      if (!last) return true
      if (last.retrySameTarget) return true
      if (last.needsSwitch) return !!(candidates && nextCandidate < candidates.length)
      return false
    },
    next(context) {
      if (!context.attempts.length) {
        const target = candidates ? candidates[0] : (context.target === undefined ? null : context.target)
        if (candidates) nextCandidate = 1
        return { stop: false, attempt: 1, target }
      }
      const last = context.last
      if (!last) return { stop: true, outcome: OUTCOMES.STOPPED, reason: 'no_outcome' }
      if (last.needsSwitch) {
        if (!candidates || nextCandidate >= candidates.length) {
          return { stop: true, outcome: last.outcome, reason: 'no_candidate' }
        }
        return { stop: false, attempt: context.attempts.length + 1, target: candidates[nextCandidate++] }
      }
      if (!last.retrySameTarget) {
        return { stop: true, outcome: last.outcome, reason: 'unsafe_to_retry' }
      }
      const target = candidates ? candidates[Math.max(0, nextCandidate - 1)] : (context.target === undefined ? null : context.target)
      return { stop: false, attempt: context.attempts.length + 1, target }
    },
    recordOutcome(args) { return recordAttemptOutcome(args) },
    planRetry({ context, outcome, remainingMs }) {
      return planAttemptRetry({
        outcome,
        attemptsMade: context.attempts.length,
        maxAttempts,
        remainingMs,
        hasNextCandidate: !!(candidates && nextCandidate < candidates.length),
        ...retryOpts,
      })
    },
  }
}
