// 尝试阶段状态机（M1-1）：单次上游发送的生命周期，纯内存、无 IO、无时钟。
// 契约：docs/contracts/request-lifecycle-v1.md（M1 扩展：SENT_UNKNOWN / ACCEPTED / DELIVERED / 副作用未知）。
//
// 设计要点：
//  - 阶段只前向单调（UNSENT → SENT_UNKNOWN → ACCEPTED → …），非法迁移不改变状态，
//    只记录 violations 供测试与诊断；任何路径都不得回退阶段。
//  - 写开始（onWriteBegin）即 SENT_UNKNOWN：此后网络错误不得再被当作 UNSENT 重放。
//  - REJECTED_BEFORE_EXECUTION 必须有证据（provider 证明未执行：连接前置失败、
//    429 前置限流、402 未支付、404 模型不存在等）；没有证据一律按未知提交处理。
//  - 工具意图/部分提交（TOOL_RISK / PARTIAL_COMMIT）是高于 DELIVERED 的副作用风险证据，
//    终止后不得重放。
//  - 终态（terminal）是独立字段，不覆盖诊断阶段：SENT_UNKNOWN / TOOL_RISK 等证据阶段保留。

export const STAGES = Object.freeze({
  UNSENT: 'UNSENT',
  SENT_UNKNOWN: 'SENT_UNKNOWN',
  ACCEPTED: 'ACCEPTED',
  REJECTED_BEFORE_EXECUTION: 'REJECTED_BEFORE_EXECUTION',
  DELIVERED: 'DELIVERED',
  TOOL_RISK: 'TOOL_RISK',
  PARTIAL_COMMIT: 'PARTIAL_COMMIT',
})

// 单调证据序（不是业务时间顺序）：收到响应头后才可能「证明前置拒绝」，
// 因此 REJECTED_BEFORE_EXECUTION 排在 ACCEPTED 之后，避免把已受理响应回退成未执行。
export const STAGE_RANK = Object.freeze({
  [STAGES.UNSENT]: 0,
  [STAGES.SENT_UNKNOWN]: 1,
  [STAGES.ACCEPTED]: 2,
  [STAGES.REJECTED_BEFORE_EXECUTION]: 3,
  [STAGES.DELIVERED]: 4,
  [STAGES.TOOL_RISK]: 5,
  [STAGES.PARTIAL_COMMIT]: 5,
})

const ALLOWED = Object.freeze({
  [STAGES.UNSENT]: [STAGES.SENT_UNKNOWN, STAGES.REJECTED_BEFORE_EXECUTION],
  [STAGES.SENT_UNKNOWN]: [STAGES.ACCEPTED, STAGES.REJECTED_BEFORE_EXECUTION],
  [STAGES.ACCEPTED]: [STAGES.REJECTED_BEFORE_EXECUTION, STAGES.DELIVERED, STAGES.TOOL_RISK, STAGES.PARTIAL_COMMIT],
  [STAGES.REJECTED_BEFORE_EXECUTION]: [],
  [STAGES.DELIVERED]: [STAGES.TOOL_RISK, STAGES.PARTIAL_COMMIT],
  [STAGES.TOOL_RISK]: [],
  [STAGES.PARTIAL_COMMIT]: [],
})

export const OUTCOMES = Object.freeze({
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  FAILED_UNSENT: 'FAILED_UNSENT',
  SENT_UNKNOWN: 'SENT_UNKNOWN',
  TOOL_RISK: 'TOOL_RISK',
  PARTIAL_COMMIT: 'PARTIAL_COMMIT',
  REJECTED_BEFORE_EXECUTION: 'REJECTED_BEFORE_EXECUTION',
  CANCELLED: 'CANCELLED',
  CANCELLED_UNSENT: 'CANCELLED_UNSENT',
  DEADLINE_EXCEEDED: 'DEADLINE_EXCEEDED',
  DENIED: 'DENIED',
  STOPPED: 'STOPPED',
})

// 可以证明「供应商在真正执行前就拒绝」的证据种类（仅这些允许把 SENT_UNKNOWN 降级为
// REJECTED_BEFORE_EXECUTION；其他错误一律按执行状态未知处理）。
// F03：发送授权/目标的统一错误状态表（单一真源）。
// 之前各处自造数字（403/502/409/504），本表把「拒绝码 → HTTP 状态」固定下来，
// 供 index.js / target-authz 的拒绝信封与回归断言共用；新增码必须在这里登记。
export const ERROR_STATUS_TABLE = Object.freeze({
  // 目标授权（一律 403，零发送）
  target_denied: 403,
  target_identity_unknown: 403,
  domain_identity_mismatch: 403,
  send_target_drift: 403,
  catalog_generation_missing: 403,
  target_not_verified: 403,
  credential_missing: 403,
  credential_mode_retired: 403,
  official_passthrough_retired: 403,
  official_no_gateway_key: 403,
  official_path_not_allowlisted: 403,
  official_host_not_allowlisted: 403,
  official_target_insecure_scheme: 403,
  official_credential_missing: 403,
  // 路由/模型
  unknown_model: 404,
  catalog_binding_invalid: 404,
  // 上游与传输
  upstream_redirect_rejected: 502,
  all_providers_failed: 502,
  request_timeout: 504,
  // 本地配置写锁（与非发送路径共用的冲突语义）
  store_locked: 409,
  store_conflict: 409,
})

export function statusForErrorCode (code) {
  return Object.prototype.hasOwnProperty.call(ERROR_STATUS_TABLE, code) ? ERROR_STATUS_TABLE[code] : 502
}

export const PRE_EXECUTION_EVIDENCE = Object.freeze([
  'connect_refused',
  'dns_failure',
  'tls_failure',
  'preflight_rejected',
  'rate_limited',
  'payment_required',
  'model_unavailable',
  'auth_rejected',
  'validation_rejected',
])

export function isValidStage(stage) { return Object.prototype.hasOwnProperty.call(STAGE_RANK, stage) }

function cleanEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') return null
  const out = {}
  for (const key of ['reason', 'kind', 'status', 'proven', 'code', 'detail']) {
    if (evidence[key] !== undefined && evidence[key] !== null) out[key] = evidence[key]
  }
  return Object.keys(out).length ? out : null
}

/**
 * 创建一次尝试记录。adapter.forwardOnce 通过 attempt 上的回调推进阶段；
 * 执行器只根据记录的证据做分类，不轻信 HTTP 状态码。
 */
export function createAttempt(opts = {}) {
  const attempt = {
    number: Number(opts.number) || 1,
    target: opts.target === undefined ? null : opts.target,
    nonIdempotent: opts.nonIdempotent === true,
    stage: STAGES.UNSENT,
    history: [{ stage: STAGES.UNSENT, reason: 'created', evidence: null }],
    violations: [],
    wroteBody: false,
    writeStarted: false,
    receivedHeaders: false,
    semanticEvents: 0,
    toolIntent: null,
    partialCommit: null,
    status: null,
    headers: null,
    rejection: null,
    attribution: null,
    retryAfterMs: null,
    hasRetryAfter: false,
    error: null,
    terminal: null,
    delivered: false,
  }

  const transition = (next, evidence) => {
    if (!isValidStage(next)) {
      attempt.violations.push({ type: 'unknown_stage', next: String(next) })
      return false
    }
    if (next === attempt.stage) return true
    const allowed = ALLOWED[attempt.stage] || []
    if (!allowed.includes(next) || STAGE_RANK[next] < STAGE_RANK[attempt.stage]) {
      attempt.violations.push({ type: 'illegal_transition', from: attempt.stage, to: next, evidence: cleanEvidence(evidence) })
      return false
    }
    attempt.stage = next
    attempt.history.push({ stage: next, reason: (evidence && evidence.reason) || null, evidence: cleanEvidence(evidence) })
    return true
  }

  attempt.transition = transition

  // 写开始：请求字节可能已交给 socket，此后不能假设未送达。
  attempt.onWriteBegin = (detail) => {
    attempt.writeStarted = true
    attempt.wroteBody = true
    return transition(STAGES.SENT_UNKNOWN, Object.assign({ reason: 'write_begin' }, detail || {}))
  }

  // 供应商可证明的前置拒绝（仅在有证据时调用；无证据不要调用）。
  attempt.onKnownRejection = (evidence = {}) => {
    const proven = evidence.proven === true || PRE_EXECUTION_EVIDENCE.includes(evidence.kind)
    if (!proven) {
      attempt.violations.push({ type: 'rejection_without_evidence', evidence: cleanEvidence(evidence) })
      return false
    }
    if (attempt.stage !== STAGES.UNSENT && attempt.stage !== STAGES.SENT_UNKNOWN && attempt.stage !== STAGES.ACCEPTED) {
      attempt.violations.push({ type: 'rejection_after_delivery', from: attempt.stage, evidence: cleanEvidence(evidence) })
      return false
    }
    attempt.rejection = cleanEvidence(evidence)
    return transition(STAGES.REJECTED_BEFORE_EXECUTION, Object.assign({ reason: 'known_rejection', proven: true }, evidence))
  }

  attempt.onResponseHeaders = (detail = {}) => {
    attempt.receivedHeaders = true
    if (detail.status !== undefined) attempt.status = Number(detail.status)
    if (detail.headers !== undefined) attempt.headers = detail.headers || null
    return transition(STAGES.ACCEPTED, { reason: 'response_headers', status: attempt.status })
  }

  attempt.onFirstSemanticEvent = (detail = {}) => {
    attempt.semanticEvents += 1
    attempt.delivered = true
    return transition(STAGES.DELIVERED, Object.assign({ reason: 'semantic_event' }, detail || {}))
  }

  attempt.onToolIntent = (detail = {}) => {
    attempt.toolIntent = cleanEvidence(detail) || { reason: 'tool_intent' }
    return transition(STAGES.TOOL_RISK, Object.assign({ reason: 'tool_intent' }, detail || {}))
  }

  attempt.onPartialCommit = (detail = {}) => {
    attempt.partialCommit = cleanEvidence(detail) || { reason: 'partial_commit' }
    return transition(STAGES.PARTIAL_COMMIT, Object.assign({ reason: 'partial_commit' }, detail || {}))
  }

  // 终态独立记录，不覆盖诊断阶段（尤其不把 TOOL_RISK/SENT_UNKNOWN 抹成 FAILED）。
  attempt.onTerminal = (detail = {}) => {
    attempt.terminal = {
      ok: detail.ok === true,
      kind: detail.kind || (detail.ok === true ? 'succeeded' : 'failed'),
      status: detail.status === undefined ? attempt.status : Number(detail.status),
      error: detail.error ? summarizeError(detail.error) : null,
    }
    return true
  }

  return attempt
}

/** 执行上下文：一次外部请求内所有尝试的累计证据。 */
export function createExecutionContext(opts = {}) {
  return {
    requestId: opts.requestId === undefined ? null : opts.requestId,
    target: opts.target === undefined ? null : opts.target,
    nonIdempotent: opts.nonIdempotent === true,
    attempts: [],
    waitedMs: 0,
    last: null,
    get stage() {
      if (!this.attempts.length) return STAGES.UNSENT
      return this.attempts[this.attempts.length - 1].stage
    },
  }
}

export function latestAttempt(context) {
  if (!context || !Array.isArray(context.attempts) || !context.attempts.length) return null
  return context.attempts[context.attempts.length - 1]
}

/**
 * 下一次发送是否被证据允许：只有 UNSENT（未发出）或 REJECTED_BEFORE_EXECUTION
 * （供应商证明前置拒绝）为 true；SENT_UNKNOWN / ACCEPTED / DELIVERED / TOOL_RISK /
 * PARTIAL_COMMIT 一律 false（不得再发）。
 */
export function retrySafetyOf(attempt) {
  if (!attempt) return { allowed: true, reason: 'never_sent', stage: STAGES.UNSENT }
  if (attempt.stage === STAGES.UNSENT) return { allowed: true, reason: 'unsent', stage: attempt.stage }
  if (attempt.stage === STAGES.REJECTED_BEFORE_EXECUTION) {
    return { allowed: true, reason: 'rejected_before_execution', stage: attempt.stage }
  }
  return {
    allowed: false,
    reason: attempt.stage === STAGES.SENT_UNKNOWN ? 'sent_unknown' : 'execution_observed',
    stage: attempt.stage,
    toolRisk: attempt.stage === STAGES.TOOL_RISK || attempt.stage === STAGES.PARTIAL_COMMIT || !!attempt.toolIntent,
  }
}

/** 执行确定性：给日志/终态用的可诊断分类（不参与重放判定本身）。 */
export function executionCertaintyOf(attempt) {
  if (!attempt) return 'not_sent'
  switch (attempt.stage) {
    case STAGES.UNSENT: return 'not_sent'
    case STAGES.REJECTED_BEFORE_EXECUTION: return 'rejected_before_execution'
    case STAGES.SENT_UNKNOWN: return 'unknown'
    case STAGES.ACCEPTED: return 'accepted_unknown'
    case STAGES.DELIVERED: return 'delivered'
    case STAGES.TOOL_RISK: return 'tool_risk'
    case STAGES.PARTIAL_COMMIT: return 'partial_commit'
    default: return 'unknown'
  }
}

export function summarizeError(err) {
  if (!err) return null
  return {
    name: err.name || 'Error',
    code: err.code || null,
    status: err.status === undefined ? null : err.status,
    message: String(err.message || err).slice(0, 300),
    aborted: err.aborted === true,
    reason: err.reason || null,
  }
}

/** 尝试摘要：只保留必要证据，避免把正文/凭据带进日志或错误信封。 */
export function summarizeAttempt(attempt) {
  const safety = retrySafetyOf(attempt)
  return {
    number: attempt.number,
    target: attempt.target,
    stage: attempt.stage,
    writeStarted: attempt.writeStarted,
    wroteBody: attempt.wroteBody,
    receivedHeaders: attempt.receivedHeaders,
    semanticEvents: attempt.semanticEvents,
    toolRisk: attempt.stage === STAGES.TOOL_RISK || attempt.stage === STAGES.PARTIAL_COMMIT || !!attempt.toolIntent,
    status: attempt.status,
    rejection: attempt.rejection,
    attribution: attempt.attribution,
    retryAfterMs: attempt.retryAfterMs,
    terminal: attempt.terminal,
    retrySafety: safety,
    execution: executionCertaintyOf(attempt),
    error: attempt.error,
    violations: attempt.violations.length ? attempt.violations.slice() : [],
  }
}
