// 统一单请求执行账本（V13.1，零依赖、纯内存）。
//
// 职责边界：本模块只回答“还能不能发”并记录已经发生的事实，不选择候选、不发请求、
// 不持久化金额。持久金额仍归 src/routing/ledger.js；请求生命周期 deadline 仍归 budget.js。
// 接线时由唯一执行器在每次真实发送前调用 canSend()，发送开始时调用 recordAttempt()。
//
// 安全规则：
//   - 首次发送计入 totalAttempts；候选、连接、模型与共享额度域分别计数，取最严上限。
//   - 400/401 终态；429 同目标必须等足 Retry-After，且绝不缩短后提前发送。
//   - 只有未写出或可证明的前置拒绝解除重放封锁；已交付、工具副作用、部分提交、
//     未知提交和非幂等请求默认禁止自动重放。
//   - maxElapsedMs 是故障窗口预算，不是正常生成长度上限；null 表示无故障墙钟上限。
//     正常长生成不受 overall deadline 影响，但发送/回退/恢复/累计等待仍有硬上限。

export const REQUEST_LEDGER_VERSION = 1

export const DEFAULT_LIMITS = Object.freeze({
  maxTotalAttempts: 3,
  maxFailovers: 2,
  maxRecoveryAttempts: 1,
  maxWaitMs: 30000,
  maxElapsedMs: null,
})

export const DENY = Object.freeze({
  INVALID_TARGET: 'invalid_target',
  CANCELLED: 'cancelled',
  SUCCEEDED: 'succeeded',
  REPLAY_BLOCKED: 'replay_blocked',
  BAD_REQUEST: 'bad_request',
  AUTH_REQUIRED: 'auth_required',
  QUOTA_DOMAIN_EXHAUSTED: 'quota_domain_exhausted',
  TOTAL_ATTEMPTS: 'max_total_attempts',
  CANDIDATE_ATTEMPTS: 'max_candidate_attempts',
  CONNECTION_ATTEMPTS: 'max_connection_attempts',
  MODEL_ATTEMPTS: 'max_model_attempts',
  DOMAIN_ATTEMPTS: 'max_domain_attempts',
  FAILOVERS: 'max_failovers',
  RECOVERY_ATTEMPTS: 'max_recovery_attempts',
  TARGET_CHANGE_REQUIRED: 'target_change_required',
  RETRY_AFTER_PENDING: 'retry_after_pending',
  WAIT_BUDGET: 'max_wait_ms',
  ELAPSED_BUDGET: 'max_elapsed_ms',
  RECOVERY_TARGET: 'recovery_target_mismatch',
  TRUSTED_RESUME_REQUIRED: 'trusted_resume_required',
})

const PHASE_REPLAY_BLOCKED = new Set([
  'tool_side_effect', 'stream_delivered', 'partially_committed', 'user_cancelled',
  'tool_risk', 'partial_commit', 'delivered',
])
const VALID_PHASES = new Set([
  'unsent', 'sending', 'accepted', 'accepted_no_side_effect', 'recovery',
  ...PHASE_REPLAY_BLOCKED,
])
const TERMINAL_STATUS = Object.freeze({ 400: DENY.BAD_REQUEST, 401: DENY.AUTH_REQUIRED })

const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key)
const finite = (value) => Number.isFinite(Number(value))
const text = (value) => value == null ? '' : String(value).trim()
const abortReason = (value) => value instanceof Error
  ? 'client_closed'
  : (text(value) || 'client_closed')

function limitValue(value, fallback, name, { integer = true, nullable = false } = {}) {
  if (value === undefined) return fallback
  if (value === null && nullable) return null
  const n = Number(value)
  if (!finite(n) || n < 0 || (integer && !Number.isInteger(n))) {
    throw new TypeError(name + ' must be a non-negative integer' + (nullable ? ' or null' : ''))
  }
  return n
}

function normalizeLimits(options) {
  const input = options.limits && typeof options.limits === 'object' ? options.limits : {}
  const read = (key) => input[key] === undefined ? options[key] : input[key]
  return {
    maxTotalAttempts: limitValue(read('maxTotalAttempts'), DEFAULT_LIMITS.maxTotalAttempts, 'maxTotalAttempts'),
    maxFailovers: limitValue(read('maxFailovers'), DEFAULT_LIMITS.maxFailovers, 'maxFailovers'),
    maxRecoveryAttempts: limitValue(read('maxRecoveryAttempts'), DEFAULT_LIMITS.maxRecoveryAttempts, 'maxRecoveryAttempts'),
    maxWaitMs: limitValue(read('maxWaitMs'), DEFAULT_LIMITS.maxWaitMs, 'maxWaitMs'),
    maxElapsedMs: limitValue(read('maxElapsedMs'), DEFAULT_LIMITS.maxElapsedMs, 'maxElapsedMs', { nullable: true }),
  }
}

function normalizeTargetLimits(value, name) {
  if (value == null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError(name + ' must be an object')
  const out = Object.create(null)
  for (const [id, max] of Object.entries(value)) {
    if (!text(id)) throw new TypeError(name + ' contains an empty id')
    out[id] = limitValue(max, undefined, name + '.' + id)
  }
  return out
}

function normalizeTarget(raw, { required = true } = {}) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const target = {
    candidateId: text(source.candidateId),
    connectionId: text(source.connectionId),
    modelId: text(source.modelId),
    domain: text(source.domain),
  }
  const valid = (!required || (target.candidateId && target.connectionId && target.modelId)) &&
    Object.values(target).every((id) => !id || id.length <= 128)
  return { target, valid }
}

const targetKey = (target) => JSON.stringify([target.candidateId, target.connectionId, target.modelId])
const sameTarget = (a, b) => !!a && !!b && targetKey(a) === targetKey(b)

function normalizeSideEffect(value) {
  if (value === true) return 'occurred'
  const side = text(value).toLowerCase().replace(/-/g, '_')
  if (['tool', 'tool_side_effect', 'side_effect'].includes(side)) return 'occurred'
  if (side === 'nonidempotent') return 'non_idempotent'
  return side || 'none'
}

function normalizePhase(value) {
  const phase = text(value).toLowerCase()
  return phase || 'unsent'
}

function amountMicro(value) {
  const n = Number(value)
  const micro = n * 1_000_000
  if (!finite(n) || n < 0 || !Number.isSafeInteger(micro)) return null
  return micro
}

function publicCounters(map) {
  return Object.fromEntries(map)
}

/**
 * @param {object} [options]
 * @param {object} [options.limits] 上限；也可直接在 options 顶层传同名字段。
 * @param {object} [options.candidateLimits] {candidateId: maxAttempts}
 * @param {object} [options.connectionLimits] {connectionId: maxAttempts}
 * @param {object} [options.modelLimits] {modelId: maxAttempts}
 * @param {object} [options.quotaDomainLimits] {domain: maxAttempts}
 * @param {AbortSignal} [options.signal] 外部取消源。
 * @param {() => number} [options.now] 可注入时钟，测试无需真实睡眠。
 * @param {object} [options.timers] 可注入 setTimeout/clearTimeout；与注入时钟配合测试故障计时器。
 * @param {string} [options.currency] amount 的默认币种（默认 USD）；多币种以 amountByCurrency 为准。
 */
export class RequestLedger {
  constructor(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('options must be an object')
    this.limits = normalizeLimits(options)
    this.candidateLimits = normalizeTargetLimits(options.candidateLimits, 'candidateLimits')
    this.connectionLimits = normalizeTargetLimits(options.connectionLimits, 'connectionLimits')
    this.modelLimits = normalizeTargetLimits(options.modelLimits, 'modelLimits')
    this.quotaDomainLimits = normalizeTargetLimits(options.quotaDomainLimits, 'quotaDomainLimits')
    this.currency = text(options.currency).toUpperCase() || 'USD'
    this._now = typeof options.now === 'function' ? options.now : Date.now
    this._timers = options.timers || null
    this._wallClock = typeof options.now !== 'function'
    this._faultTimer = null
    this._startedAt = this._readNow()
    this._controller = new AbortController()
    this._externalSignal = options.signal || null
    this._onAbort = null
    this._attempts = []
    this._attemptById = new Map()
    this._candidateAttempts = new Map()
    this._connectionAttempts = new Map()
    this._modelAttempts = new Map()
    this._domainAttempts = new Map()
    this._amountMicroByCurrency = new Map()
    this._exhaustedDomains = new Set()
    this._failoverReservations = []
    this._recoveryReservations = []
    this._resetAttemptState()
    this._state = {
      firstSend: false,
      firstSendAt: null,
      totalAttempts: 0,
      failovers: 0,
      recoveryAttempts: 0,
      waitMs: 0,
      amountMicro: 0,
      amountUnknown: 0,
      cancelReason: null,
      succeeded: false,
      terminalReason: null,
      replayBlocked: false,
      replayReason: null,
      requestPhase: 'unsent',
      sideEffect: 'none',
      faultStartedAt: null,
      faultElapsedMs: 0,
      faultExpired: false,
      lastRetryAfterMs: null,
      violations: [],
    }
    if (this._externalSignal) {
      this._onAbort = () => this.cancel(abortReason(this._externalSignal.reason))
      if (this._externalSignal.aborted) this._onAbort()
      else {
        try { this._externalSignal.addEventListener('abort', this._onAbort, { once: true }) } catch {}
      }
    }
  }

  _readNow() {
    const n = Number(this._now())
    return finite(n) ? n : Date.now()
  }

  _resetAttemptState() {
    this._lastTarget = null
    this._lastAttemptId = null
    this._pendingRetryAfterMs = 0
    this._waitSinceAttemptMs = 0
    this._targetChangeRequired = false
  }

  get signal() { return this._controller.signal }
  get startedAt() { return this._startedAt }
  get firstSend() { return this._state.firstSend }
  get firstSendAt() { return this._state.firstSendAt }
  get totalAttempts() { return this._state.totalAttempts }
  get candidateAttempts() { return publicCounters(this._candidateAttempts) }
  get connectionAttempts() { return publicCounters(this._connectionAttempts) }
  get modelAttempts() { return publicCounters(this._modelAttempts) }
  get attemptsByCandidate() { return this.candidateAttempts }
  get attemptsByConnection() { return this.connectionAttempts }
  get failovers() { return this._state.failovers }
  get recoveryAttempts() { return this._state.recoveryAttempts }
  get waitMs() { return this._state.waitMs }
  get elapsedMs() { return Math.max(0, this._readNow() - this._startedAt) }
  get faultElapsedMs() { this._syncFault(); return this._state.faultElapsedMs }
  get faultExpired() { return this._state.faultExpired }
  get amount() {
    if (this._state.amountUnknown > 0 || this._amountMicroByCurrency.size > 1) return null
    return this._state.amountMicro / 1_000_000
  }
  get amountByCurrency() {
    return Object.fromEntries([...this._amountMicroByCurrency].map(([currency, micro]) => [currency, micro / 1_000_000]))
  }
  get amountUnknown() { return this._state.amountUnknown }
  get cancelReason() { return this._state.cancelReason }
  get cancelled() { return this._state.cancelReason !== null }
  get succeeded() { return this._state.succeeded }
  get exhaustedQuotaDomains() { return [...this._exhaustedDomains] }
  get attempts() { return this._attempts.map((attempt) => Object.freeze({ ...attempt, target: { ...attempt.target } })) }

  _syncFault() {
    const s = this._state
    if (s.faultStartedAt != null) {
      const now = this._readNow()
      s.faultElapsedMs += Math.max(0, now - s.faultStartedAt)
      s.faultStartedAt = now
    }
  }

  _startFault() {
    const s = this._state
    if (s.faultStartedAt == null && !s.succeeded && !this.cancelled) s.faultStartedAt = this._readNow()
  }

  _stopFault() {
    this._syncFault()
    this._state.faultStartedAt = null
    if (this._faultTimer != null) {
      const timers = this._timers || globalThis
      try { timers.clearTimeout(this._faultTimer) } catch {}
      this._faultTimer = null
    }
  }

  _armFaultTimer() {
    if (!this._wallClock && !this._timers) return
    if (this.limits.maxElapsedMs == null || this._state.faultStartedAt == null || this._faultTimer != null) return
    const timers = this._timers || globalThis
    const delay = Math.max(0, this.limits.maxElapsedMs - this._state.faultElapsedMs)
    this._faultTimer = timers.setTimeout(() => {
      this._faultTimer = null
      if (this._state.faultStartedAt == null) return
      this._syncFault()
      const remaining = this.limits.maxElapsedMs - this._state.faultElapsedMs
      if (remaining > 0) { this._armFaultTimer(); return }
      this._state.faultExpired = true
      this._state.faultStartedAt = null
      try { this._controller.abort('fault_budget_exceeded') } catch {}
    }, Math.min(delay, 2_147_483_647))
    if (this._faultTimer && typeof this._faultTimer.unref === 'function') this._faultTimer.unref()
  }

  _increment(map, id) {
    if (id) map.set(id, (map.get(id) || 0) + 1)
  }

  _remainingAt(target, now) {
    this._syncFault()
    const remaining = {
      totalAttempts: Math.max(0, this.limits.maxTotalAttempts - this._state.totalAttempts),
      failovers: Math.max(0, this.limits.maxFailovers - this._state.failovers),
      recoveryAttempts: Math.max(0, this.limits.maxRecoveryAttempts - this._state.recoveryAttempts),
      waitMs: Math.max(0, this.limits.maxWaitMs - this._state.waitMs),
      elapsedMs: this.limits.maxElapsedMs == null ? null : Math.max(0, this.limits.maxElapsedMs - this._state.faultElapsedMs),
      candidateAttempts: null,
      connectionAttempts: null,
      modelAttempts: null,
      domainAttempts: null,
      elapsedMsTotal: this.elapsedMs,
      faultElapsedMs: this._state.faultElapsedMs,
    }
    if (target) {
      const dimensions = [
        ['candidateAttempts', this.candidateLimits, this._candidateAttempts, target.candidateId],
        ['connectionAttempts', this.connectionLimits, this._connectionAttempts, target.connectionId],
        ['modelAttempts', this.modelLimits, this._modelAttempts, target.modelId],
        ['domainAttempts', this.quotaDomainLimits, this._domainAttempts, target.domain],
      ]
      for (const [name, limits, counts, id] of dimensions) {
        if (id && own(limits, id)) remaining[name] = Math.max(0, limits[id] - (counts.get(id) || 0))
      }
    }
    return remaining
  }

  remaining(target = {}) {
    const normalized = normalizeTarget(target, { required: false })
    return this._remainingAt(normalized.target, this._readNow())
  }

  _deny(code, detail = {}) {
    return { allowed: false, code, reason: code, ...detail }
  }

  _checkSend(input) {
    const { target, valid } = normalizeTarget(input)
    if (!valid) return this._deny(DENY.INVALID_TARGET)
    const phase = normalizePhase(input.phase)
    if (!VALID_PHASES.has(phase)) return this._deny(DENY.INVALID_TARGET, { reason: 'invalid_phase' })
    const requestedSideEffect = normalizeSideEffect(input.sideEffect)
    const s = this._state
    const recoveryReserved = phase === 'recovery'
      ? this._recoveryReservations.find((row) => sameTarget(row.target, target))
      : null
    const trustedResume = !!(recoveryReserved && recoveryReserved.trustedResume)
    if (this.cancelled) return this._deny(DENY.CANCELLED, { cancelReason: s.cancelReason })
    if (s.succeeded) return this._deny(DENY.SUCCEEDED)
    if (s.terminalReason) return this._deny(s.terminalReason)
    if (PHASE_REPLAY_BLOCKED.has(phase) || PHASE_REPLAY_BLOCKED.has(s.requestPhase) ||
        (s.replayBlocked && !trustedResume) || requestedSideEffect === 'occurred' ||
        (s.totalAttempts > 0 && (['non_idempotent', 'occurred'].includes(s.sideEffect) ||
          ['non_idempotent', 'occurred'].includes(requestedSideEffect) || input.nonIdempotent === true))) {
      return this._deny(DENY.REPLAY_BLOCKED, { replayReason: s.replayReason || 'phase:' + phase })
    }
    if (target.domain && this._exhaustedDomains.has(target.domain)) return this._deny(DENY.QUOTA_DOMAIN_EXHAUSTED, { domain: target.domain })

    const remaining = this._remainingAt(target, this._readNow())
    if (remaining.totalAttempts <= 0) return this._deny(DENY.TOTAL_ATTEMPTS, { remaining })
    for (const [key, code] of [
      ['candidateAttempts', DENY.CANDIDATE_ATTEMPTS],
      ['connectionAttempts', DENY.CONNECTION_ATTEMPTS],
      ['modelAttempts', DENY.MODEL_ATTEMPTS],
      ['domainAttempts', DENY.DOMAIN_ATTEMPTS],
    ]) {
      if (remaining[key] != null && remaining[key] <= 0) return this._deny(code, { remaining })
    }
    if (remaining.elapsedMs != null && remaining.elapsedMs <= 0) return this._deny(DENY.ELAPSED_BUDGET, { remaining })
    if (s.faultExpired) return this._deny(DENY.ELAPSED_BUDGET, { remaining })

    const changed = !!this._lastTarget && !sameTarget(this._lastTarget, target)
    const failoverReserved = this._failoverReservations.some((row) => sameTarget(row.to, target))
    if (changed && !failoverReserved) {
      if (remaining.failovers <= 0) return this._deny(DENY.FAILOVERS, { remaining })
    }
    if (!changed && this._targetChangeRequired) return this._deny(DENY.TARGET_CHANGE_REQUIRED, { remaining })

    if (phase === 'recovery') {
      if (!recoveryReserved && remaining.recoveryAttempts <= 0) return this._deny(DENY.RECOVERY_ATTEMPTS, { remaining })
      if (!sameTarget(this._lastTarget, target)) return this._deny(DENY.RECOVERY_TARGET, { remaining })
      if (s.replayBlocked && !trustedResume) return this._deny(DENY.TRUSTED_RESUME_REQUIRED, { remaining })
    }

    if (!changed && this._pendingRetryAfterMs > this._waitSinceAttemptMs) {
      const needed = this._pendingRetryAfterMs - this._waitSinceAttemptMs
      if (needed > remaining.waitMs || (remaining.elapsedMs != null && needed > remaining.elapsedMs)) {
        return this._deny(DENY.WAIT_BUDGET, { remaining, retryAfterMs: this._pendingRetryAfterMs, waitedMs: this._waitSinceAttemptMs })
      }
      return this._deny(DENY.RETRY_AFTER_PENDING, {
        remaining,
        retryAfterMs: this._pendingRetryAfterMs,
        waitedMs: this._waitSinceAttemptMs,
      })
    }
    return { allowed: true, code: 'allowed', reason: 'allowed', target, phase, remaining }
  }

  /** 纯许可查询，不计数、不预留。发送与 recordAttempt 之间不应插入 await。 */
  canSend(input = {}) {
    return this._checkSend(input).allowed
  }

  _assertTarget(input) {
    const { target, valid } = normalizeTarget(input)
    if (!valid) throw new TypeError('candidateId, connectionId and modelId are required (<=128 chars each)')
    return target
  }

  _applySideEffect(value) {
    const side = normalizeSideEffect(value)
    const rank = { none: 0, idempotent: 0, possible: 1, unknown: 2, non_idempotent: 3, occurred: 4 }
    if ((rank[side] || 0) >= (rank[this._state.sideEffect] || 0)) this._state.sideEffect = side
    if (side === 'non_idempotent' && this._state.totalAttempts > 0) {
      this._state.replayBlocked = true
      this._state.replayReason = 'non_idempotent'
    }
  }

  _blockReplay(reason) {
    this._state.replayBlocked = true
    if (!this._state.replayReason) this._state.replayReason = reason
  }

  _validateAmount(input) {
    if (input.amountMicro === undefined && input.amount === undefined) return
    if (input.amountMicro === undefined && input.amount === null) return
    const micro = input.amountMicro !== undefined
      ? (Number.isSafeInteger(Number(input.amountMicro)) && Number(input.amountMicro) >= 0 ? Number(input.amountMicro) : null)
      : amountMicro(input.amount)
    if (micro == null) throw new TypeError('amount must be a finite non-negative number (at most micro precision)')
    const currency = text(input.currency).toUpperCase() || this.currency
    if (!/^[A-Z]{3,8}$/.test(currency)) throw new TypeError('currency must be a 3-8 letter code')
    if (!Number.isSafeInteger(this._state.amountMicro + micro)) throw new TypeError('amount total exceeds safe integer micro')
  }

  _recordAmount(input, attempt = null) {
    const hasAmount = input.amountMicro !== undefined || input.amount !== undefined
    if (!hasAmount || (attempt && attempt.amountRecorded)) return
    const unknown = input.amountMicro === undefined && input.amount === null
    if (unknown) {
      if (attempt && attempt.amountUnknown) return
      this._state.amountUnknown += 1
      if (attempt) { attempt.amountUnknown = true; attempt.amountRecorded = true }
      return
    }
    const micro = input.amountMicro !== undefined
      ? (Number.isSafeInteger(Number(input.amountMicro)) && Number(input.amountMicro) >= 0 ? Number(input.amountMicro) : null)
      : amountMicro(input.amount)
    if (micro == null) throw new TypeError('amount must be a finite non-negative number (at most micro precision)')
    const currency = text(input.currency).toUpperCase() || this.currency
    if (!/^[A-Z]{3,8}$/.test(currency)) throw new TypeError('currency must be a 3-8 letter code')
    if (!Number.isSafeInteger(this._state.amountMicro + micro)) throw new TypeError('amount total exceeds safe integer micro')
    this._amountMicroByCurrency.set(currency, (this._amountMicroByCurrency.get(currency) || 0) + micro)
    this._state.amountMicro += micro
    if (attempt) {
      if (attempt.amountUnknown) this._state.amountUnknown = Math.max(0, this._state.amountUnknown - 1)
      attempt.amountUnknown = false
      attempt.amountRecorded = true
      attempt.amount = micro / 1_000_000
      attempt.currency = currency
    }
  }

  /**
   * 记录一次真实发送。相同 attemptId 重复调用只更新结果，不重复计数。
   * 常规接线：发送前 canSend()，发送开始时 recordAttempt()，结束时 recordOutcome()。
   * input.sent=false 表示连接/授权等前置失败，请求字节从未写出。
   */
  recordAttempt(input = {}) {
    const target = this._assertTarget(input)
    const phase = normalizePhase(input.phase || 'sending')
    if (!VALID_PHASES.has(phase)) throw new TypeError('invalid phase')
    const attemptId = text(input.attemptId) || ('attempt-' + (this._state.totalAttempts + 1))
    if (attemptId.length > 128) throw new TypeError('attemptId too long')
    const prior = this._attemptById.get(attemptId)
    if (prior) {
      if (!sameTarget(prior.target, target)) throw new TypeError('attemptId target mismatch')
      return this.recordOutcome(attemptId, input)
    }

    this._validateAmount(input)
    const at = finite(input.at) ? Number(input.at) : this._readNow()
    const changed = !!this._lastTarget && !sameTarget(this._lastTarget, target)
    const failoverIndex = changed
      ? this._failoverReservations.findIndex((row) => sameTarget(row.to, target))
      : -1
    if (changed && failoverIndex < 0) {
      this._state.failovers += 1
      this._startFault()
    } else if (failoverIndex >= 0) {
      this._failoverReservations.splice(failoverIndex, 1)
    }
    const recoveryIndex = phase === 'recovery'
      ? this._recoveryReservations.findIndex((row) => sameTarget(row.target, target))
      : -1
    if (phase === 'recovery') {
      if (recoveryIndex >= 0) this._recoveryReservations.splice(recoveryIndex, 1)
      else this._state.recoveryAttempts += 1
      this._startFault()
    }
    if (changed || phase === 'recovery' || this._state.faultStartedAt != null) this._armFaultTimer()

    this._state.firstSend = true
    if (this._state.firstSendAt == null) this._state.firstSendAt = at
    this._state.totalAttempts += 1
    this._increment(this._candidateAttempts, target.candidateId)
    this._increment(this._connectionAttempts, target.connectionId)
    this._increment(this._modelAttempts, target.modelId)
    this._increment(this._domainAttempts, target.domain)
    this._lastTarget = { ...target }
    this._lastAttemptId = attemptId
    this._pendingRetryAfterMs = 0
    this._waitSinceAttemptMs = 0
    this._targetChangeRequired = false

    const attempt = {
      attemptId,
      number: this._state.totalAttempts,
      target,
      startedAt: at,
      endedAt: null,
      phase,
      sideEffect: normalizeSideEffect(input.sideEffect),
      sent: input.sent !== false,
      status: null,
      outcome: null,
      execution: null,
      retryAfterMs: null,
      amount: null,
      currency: null,
      amountRecorded: false,
      amountUnknown: false,
    }
    this._attempts.push(attempt)
    this._attemptById.set(attemptId, attempt)
    this._applySideEffect(input.sideEffect)
    if (input.nonIdempotent === true) this._applySideEffect('non_idempotent')
    if (['non_idempotent', 'occurred'].includes(this._state.sideEffect)) this._blockReplay(this._state.sideEffect)
    if (PHASE_REPLAY_BLOCKED.has(phase)) this._blockReplay('phase:' + phase)
    this._recordAmount(input, attempt)

    // 默认“已发出且结果未知”：必须先由 recordOutcome 证明未执行，才能解除封锁。
    this._blockReplay('submission_unknown')
    if (Object.keys(input).some((key) => ['status', 'outcome', 'result', 'error', 'execution', 'retryAfterMs'].includes(key))) {
      return this.recordOutcome(attemptId, input)
    }
    return Object.freeze({ ...attempt, target: { ...target } })
  }

  /** 更新同一次发送的终态；不增加发送、回退、恢复或金额计数。 */
  recordOutcome(attemptId, input = {}) {
    const attempt = this._attemptById.get(text(attemptId))
    if (!attempt) throw new TypeError('unknown attemptId')
    this._validateAmount(input)
    const at = finite(input.at) ? Number(input.at) : this._readNow()
    const status = finite(input.status) ? Number(input.status) : null
    const outcome = text(input.outcome || (input.result && input.result.outcome)).toLowerCase() ||
      (finite(input.retryAfterMs) ? 'rate_limited' : null)
    const execution = text(input.execution || (input.result && input.result.execution)).toLowerCase() || null
    const phase = normalizePhase(input.phase || attempt.phase)
    if (!VALID_PHASES.has(phase)) throw new TypeError('invalid phase')
    attempt.endedAt = at
    attempt.status = status
    attempt.outcome = outcome
    attempt.execution = execution
    attempt.phase = phase
    attempt.sent = input.sent === undefined ? attempt.sent : input.sent !== false
    attempt.sideEffect = normalizeSideEffect(input.sideEffect === undefined ? attempt.sideEffect : input.sideEffect)
    this._recordAmount(input, attempt)
    this._state.requestPhase = phase
    this._applySideEffect(input.sideEffect === undefined ? attempt.sideEffect : input.sideEffect)
    if (input.nonIdempotent === true) this._applySideEffect('non_idempotent')
    if (PHASE_REPLAY_BLOCKED.has(phase)) this._blockReplay('phase:' + phase)

    const terminal = TERMINAL_STATUS[status]
    if (terminal) {
      this._state.terminalReason = terminal
      return Object.freeze({ ...attempt, target: { ...attempt.target } })
    }

    const success = outcome === 'success' || outcome === 'succeeded' || (status >= 200 && status < 300)
    if (success) {
      this._state.succeeded = true
      this._state.terminalReason = DENY.SUCCEEDED
      this._stopFault()
      return Object.freeze({ ...attempt, target: { ...attempt.target } })
    }

    const cancelled = outcome === 'cancelled' || outcome === 'canceled' || phase === 'user_cancelled'
    if (cancelled) {
      this.cancel(text(input.cancelReason) || 'cancelled')
      return Object.freeze({ ...attempt, target: { ...attempt.target } })
    }

    this._startFault()
    const provenUnsent = attempt.sent === false
    const provenRejection = execution === 'rejected_before_execution' || outcome === 'rejected_before_execution' ||
      outcome === 'rate_limited' || status === 429 || status === 402 || status === 404
    if (provenUnsent || (provenRejection && !['non_idempotent', 'occurred'].includes(this._state.sideEffect))) {
      this._state.replayBlocked = false
      this._state.replayReason = null
    } else {
      this._blockReplay(execution === 'unknown' || execution === 'accepted_unknown' ? 'submission_unknown' : 'outcome:' + (outcome || execution || status || 'unknown'))
    }

    if (status === 429 || outcome === 'rate_limited') {
      const raw = input.retryAfterMs !== undefined ? input.retryAfterMs : (input.result && input.result.retryAfterMs)
      const retryAfterMs = finite(raw) ? Math.max(0, Number(raw)) : 0
      attempt.retryAfterMs = retryAfterMs
      this._pendingRetryAfterMs = retryAfterMs
      this._state.lastRetryAfterMs = retryAfterMs
      this._waitSinceAttemptMs = 0
    }
    if (status === 402 || status === 404 || outcome === 'model_unavailable' || outcome === 'payment_required') {
      this._targetChangeRequired = true
    }
    const domain = text(input.domain) || attempt.target.domain
    if (domain && (input.quotaDomainExhausted === true || input.sharedQuotaExhausted === true || input.quotaExhausted === true)) {
      this._exhaustedDomains.add(domain)
    }
    return Object.freeze({ ...attempt, target: { ...attempt.target } })
  }

  /**
   * 记录已承诺/已完成的等待。返回 false 且不计数表示预算不足或想缩短 Retry-After。
   * 同目标 429 的等待必须累计达到 pending Retry-After；换独立目标无需等待。
   */
  recordWait(input = {}) {
    if (typeof input === 'number') input = { ms: input }
    const ms = Number(input.ms === undefined ? input.waitMs : input.ms)
    if (!finite(ms) || ms < 0) throw new TypeError('ms must be a finite non-negative number')
    if (this.cancelled || this._state.succeeded || this._state.terminalReason || this._state.replayBlocked) return false
    const remaining = this._remainingAt(this._lastTarget, this._readNow())
    if (ms > remaining.waitMs || (remaining.elapsedMs != null && ms > remaining.elapsedMs)) return false
    const upstream = input.retryAfterMs === undefined ? this._pendingRetryAfterMs : Number(input.retryAfterMs)
    if (finite(upstream) && upstream > this._waitSinceAttemptMs && ms < upstream - this._waitSinceAttemptMs) return false
    this._startFault()
    this._armFaultTimer()
    this._state.waitMs += ms
    this._waitSinceAttemptMs += ms
    if (finite(input.retryAfterMs)) this._state.lastRetryAfterMs = Math.max(0, Number(input.retryAfterMs))
    return true
  }

  /** 登记一次已裁决的候选/连接/模型切换；真正发送时消费，不重复计数。 */
  recordFailover(input = {}) {
    if (this.cancelled || this._state.succeeded || this._state.terminalReason || this._state.replayBlocked) return false
    const from = this._lastTarget || this._assertTarget(input.from || input)
    const to = this._assertTarget(input.to || input)
    if (sameTarget(from, to)) return false
    if (this._state.failovers >= this.limits.maxFailovers) return false
    if (to.domain && this._exhaustedDomains.has(to.domain)) return false
    const remaining = this._remainingAt(to, this._readNow())
    if (remaining.totalAttempts <= 0 || remaining.failovers <= 0) return false
    if (remaining.elapsedMs != null && remaining.elapsedMs <= 0) return false
    this._state.failovers += 1
    this._startFault()
    this._armFaultTimer()
    this._failoverReservations.push({ from: { ...from }, to: { ...to } })
    return true
  }

  /**
   * 登记一次恢复探活/原生续传。默认必须保持原目标；未知提交只有显式
   * trustedResume + nativeProtocol 才能按原生恢复协议继续，而非重放请求。
   */
  recordRecovery(input = {}) {
    if (this.cancelled || this._state.succeeded || this._state.terminalReason) return false
    const target = this._assertTarget(input.target || input)
    if (!sameTarget(this._lastTarget, target)) return false
    if (this._state.recoveryAttempts >= this.limits.maxRecoveryAttempts) return false
    const remaining = this._remainingAt(target, this._readNow())
    if (remaining.totalAttempts <= 0 || (remaining.elapsedMs != null && remaining.elapsedMs <= 0)) return false
    const trustedResume = input.trustedResume === true && input.nativeProtocol === true
    if (this._state.replayBlocked && !trustedResume) return false
    this._state.recoveryAttempts += 1
    this._startFault()
    this._armFaultTimer()
    this._recoveryReservations.push({ target: { ...target }, trustedResume })
    return true
  }

  /** 显式标记共享额度域耗尽；之后该域的所有候选/连接/模型都不可发送。 */
  exhaustQuotaDomain(domain) {
    const id = text(domain)
    if (!id) throw new TypeError('domain required')
    this._exhaustedDomains.add(id)
    return true
  }

  cancel(reason = 'cancelled') {
    if (this.cancelled || this._state.succeeded) return false
    this._state.cancelReason = text(reason) || 'cancelled'
    this._stopFault()
    try { this._controller.abort() } catch {}
    return true
  }

  /** 释放外部 AbortSignal 监听；不影响已记录状态。 */
  dispose() {
    if (this._externalSignal && this._onAbort) {
      try { this._externalSignal.removeEventListener('abort', this._onAbort) } catch {}
    }
    this._onAbort = null
  }

  snapshot() {
    this._syncFault()
    return {
      version: REQUEST_LEDGER_VERSION,
      firstSend: this._state.firstSend,
      firstSendAt: this._state.firstSendAt,
      totalAttempts: this._state.totalAttempts,
      attemptsByCandidate: this.candidateAttempts,
      attemptsByConnection: this.connectionAttempts,
      attemptsByModel: this.modelAttempts,
      attemptsByQuotaDomain: publicCounters(this._domainAttempts),
      failovers: this._state.failovers,
      recoveryAttempts: this._state.recoveryAttempts,
      waitMs: this._state.waitMs,
      elapsedMs: this.elapsedMs,
      faultElapsedMs: this._state.faultElapsedMs,
      faultExpired: this._state.faultExpired,
      amount: this.amount,
      amountByCurrency: this.amountByCurrency,
      amountUnknown: this._state.amountUnknown,
      cancelReason: this._state.cancelReason,
      succeeded: this._state.succeeded,
      terminalReason: this._state.terminalReason,
      replayBlocked: this._state.replayBlocked,
      replayReason: this._state.replayReason,
      phase: this._state.requestPhase,
      sideEffect: this._state.sideEffect,
      exhaustedQuotaDomains: this.exhaustedQuotaDomains,
      pendingRetryAfterMs: this._pendingRetryAfterMs,
      waitedSinceAttemptMs: this._waitSinceAttemptMs,
      pendingFailovers: this._failoverReservations.length,
      pendingRecoveries: this._recoveryReservations.length,
      violations: this._state.violations.slice(),
      attempts: this.attempts,
    }
  }

  /** 给有效策略 API / UI 的同一事实视图；不包含请求正文、凭据或上游原始错误。 */
  explain(input = {}) {
    const request = input.target && typeof input.target === 'object' ? { ...input, ...input.target } : input
    const { target, valid } = normalizeTarget(request, { required: false })
    const decision = valid ? this._checkSend(request) : this._deny(DENY.INVALID_TARGET)
    const remaining = this._remainingAt(target, this._readNow())
    const effective = { ...this.limits }
    const limitingDimensions = []
    if (target) {
      const dimensions = []
      for (const [name, limits, id] of [
        ['maxCandidateAttempts', this.candidateLimits, target.candidateId],
        ['maxConnectionAttempts', this.connectionLimits, target.connectionId],
        ['maxModelAttempts', this.modelLimits, target.modelId],
        ['maxDomainAttempts', this.quotaDomainLimits, target.domain],
      ]) {
        const value = id && own(limits, id) ? limits[id] : null
        effective[name] = value
        if (value != null) dimensions.push([name, value])
      }
      const values = [this.limits.maxTotalAttempts, ...dimensions.map(([, value]) => value)]
      effective.maxTotalAttempts = Math.min(...values)
      for (const [name, value] of dimensions) if (value === effective.maxTotalAttempts) limitingDimensions.push(name)
      if (this.limits.maxTotalAttempts === effective.maxTotalAttempts) limitingDimensions.push('maxTotalAttempts')
    }
    return {
      version: REQUEST_LEDGER_VERSION,
      policy: {
        limits: { ...this.limits },
        candidateLimits: { ...this.candidateLimits },
        connectionLimits: { ...this.connectionLimits },
        modelLimits: { ...this.modelLimits },
        quotaDomainLimits: { ...this.quotaDomainLimits },
        maxElapsedScope: 'fault_window',
        normalGenerationDeadlineMs: null,
        retryAfterPolicy: 'never_shorten',
        replayPolicy: 'fail_closed_until_proven_unsent_or_pre_execution_rejection',
      },
      effective,
      effectivePolicy: effective,
      limitingDimensions,
      state: this.snapshot(),
      remaining,
      decision: {
        allowed: decision.allowed,
        code: decision.code,
        reason: decision.reason,
        cancelReason: decision.cancelReason || null,
        replayReason: decision.replayReason || null,
        domain: decision.domain || null,
        retryAfterMs: decision.retryAfterMs ?? null,
        waitedMs: decision.waitedMs ?? null,
      },
      ui: {
        normalGeneration: 'unbounded_by_this_ledger',
        faultBudget: this.limits.maxElapsedMs == null ? 'count_bounded_no_wall_deadline' : 'wall_clock_bounded',
        faultBudgetMs: this.limits.maxElapsedMs,
        remainingFaultMs: remaining.elapsedMs,
        faultExpired: this._state.faultExpired,
        cancelled: this.cancelled,
      },
    }
  }
}

export function createRequestLedger(options = {}) {
  return new RequestLedger(options)
}

export default createRequestLedger
