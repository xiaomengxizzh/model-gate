// V13.1 统一 RequestLedger 离线回归：纯内存、注入时钟、无网络/无真实 Key。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_LIMITS,
  DENY,
  RequestLedger,
  createRequestLedger,
} from '../../../src/resources/request-ledger.js'

const target = (over = {}) => ({
  candidateId: 'candidate-a',
  connectionId: 'connection-a',
  modelId: 'model-a',
  domain: 'quota-shared',
  ...over,
})

function clock(start = 0) {
  let now = start
  return {
    now: () => now,
    set(value) { now = value },
    advance(ms) { now += ms },
  }
}

function send(ledger, over = {}, outcome = {}) {
  const request = { ...target(), ...over }
  assert.equal(ledger.canSend(request), true, 'send must be authorized before recording')
  const attemptId = 'attempt-' + (ledger.totalAttempts + 1)
  ledger.recordAttempt({ ...request, attemptId })
  if (Object.keys(outcome).length) ledger.recordOutcome(attemptId, outcome)
  return attemptId
}

// ---------------------------------------------------------------------------
// 计数与防重试倍增
// ---------------------------------------------------------------------------
test('首次发送与 canSend：查询不计数，recordOutcome 不重复计数', () => {
  const c = clock(100)
  const ledger = createRequestLedger({ now: c.now })
  assert.equal(ledger.firstSend, false)
  assert.equal(ledger.canSend(target()), true)
  assert.equal(ledger.canSend(target()), true)
  assert.equal(ledger.totalAttempts, 0, 'canSend 是纯查询，不得消耗预算')
  assert.equal(ledger.firstSend, false)

  const id = send(ledger, {}, { sent: false, outcome: 'failed_unsent' })
  assert.equal(ledger.firstSend, true)
  assert.equal(ledger.firstSendAt, 100)
  assert.equal(ledger.totalAttempts, 1, '首次发送本身计入总发送次数')
  assert.deepEqual(ledger.candidateAttempts, { 'candidate-a': 1 })
  assert.deepEqual(ledger.connectionAttempts, { 'connection-a': 1 })
  assert.deepEqual(ledger.modelAttempts, { 'model-a': 1 })

  ledger.recordOutcome(id, { sent: false, outcome: 'failed_unsent' })
  ledger.recordAttempt({ ...target(), attemptId: id, sent: false, outcome: 'failed_unsent' })
  assert.equal(ledger.totalAttempts, 1, '同一 attemptId 的结果更新不得倍增')
})

test('总预算包含首次发送：首次 + 同目标重试 + 回退最多三次', () => {
  const ledger = createRequestLedger({ limits: { maxTotalAttempts: 3, maxFailovers: 1 } })
  send(ledger, {}, { sent: false, outcome: 'failed_unsent' })
  send(ledger, {}, { status: 404 })

  assert.equal(ledger.canSend(target()), false, '404 后不得重发同一目标')
  const next = target({ candidateId: 'candidate-b', connectionId: 'connection-b', modelId: 'model-b', domain: 'quota-other' })
  assert.equal(ledger.recordFailover({ from: target(), to: next }), true)
  assert.equal(ledger.canSend(next), true)
  send(ledger, next, { status: 200 })

  assert.equal(ledger.totalAttempts, 3)
  assert.equal(ledger.failovers, 1, 'recordFailover + recordAttempt 不得重复计回退')
  assert.equal(ledger.canSend(next), false)
  assert.equal(ledger.explain(next).decision.code, DENY.SUCCEEDED)
})

test('未显式 recordFailover 的实际换目标也计入 failovers，不能绕过硬上限', () => {
  const ledger = createRequestLedger({ limits: { maxTotalAttempts: 5, maxFailovers: 1 } })
  send(ledger, {}, { status: 404 })
  const second = target({ candidateId: 'b', connectionId: 'b', modelId: 'b', domain: 'other' })
  assert.equal(ledger.canSend(second), true)
  send(ledger, second, { status: 404 })
  assert.equal(ledger.failovers, 1)

  const third = target({ candidateId: 'c', connectionId: 'c', modelId: 'c', domain: 'third' })
  assert.equal(ledger.canSend(third), false)
  assert.equal(ledger.explain(third).decision.code, DENY.FAILOVERS)
})

test('候选、连接、模型、共享域预算独立，取最严上限', () => {
  const ledger = createRequestLedger({
    limits: { maxTotalAttempts: 10, maxFailovers: 10 },
    candidateLimits: { 'candidate-a': 1 },
    connectionLimits: { 'connection-a': 1 },
    modelLimits: { 'model-a': 1 },
    quotaDomainLimits: { 'quota-shared': 1 },
  })
  send(ledger, {}, { status: 404 })

  assert.equal(ledger.explain(target({ candidateId: 'b', connectionId: 'b', modelId: 'b' })).decision.code, DENY.DOMAIN_ATTEMPTS)
  assert.equal(ledger.explain(target({ candidateId: 'b', connectionId: 'b', modelId: 'model-a', domain: 'other' })).decision.code, DENY.MODEL_ATTEMPTS)
  assert.equal(ledger.explain(target({ candidateId: 'b', connectionId: 'connection-a', modelId: 'b', domain: 'other' })).decision.code, DENY.CONNECTION_ATTEMPTS)
  assert.equal(ledger.explain(target({ candidateId: 'candidate-a', connectionId: 'b', modelId: 'b', domain: 'other' })).decision.code, DENY.CANDIDATE_ATTEMPTS)
  const independent = target({ candidateId: 'b', connectionId: 'b', modelId: 'b', domain: 'other' })
  assert.equal(ledger.canSend(independent), true)
  assert.equal(ledger.remaining(independent).candidateAttempts, null, '未配置的候选上限不伪造数值')
})

// ---------------------------------------------------------------------------
// 取消、400/401、重放安全
// ---------------------------------------------------------------------------
test('取消立即禁止发送、等待、回退和恢复；外部 signal 同样生效', () => {
  const controller = new AbortController()
  const ledger = createRequestLedger({ signal: controller.signal })
  send(ledger, {}, { sent: false, outcome: 'failed_unsent' })
  const next = target({ candidateId: 'b', connectionId: 'b', modelId: 'b', domain: 'other' })

  controller.abort('client closed')
  assert.equal(ledger.cancelled, true)
  assert.equal(ledger.cancelReason, 'client closed')
  assert.equal(ledger.signal.aborted, true)
  assert.equal(ledger.canSend(target()), false)
  assert.equal(ledger.canSend(next), false)
  assert.equal(ledger.recordWait({ ms: 0 }), false)
  assert.equal(ledger.recordFailover({ from: target(), to: next }), false)
  assert.equal(ledger.recordRecovery(next), false)
  assert.equal(ledger.explain(next).decision.code, DENY.CANCELLED)
})

test('预先取消的 signal 创建后即不可发送；dispose 解除外部监听', () => {
  const controller = new AbortController()
  controller.abort()
  const stopped = createRequestLedger({ signal: controller.signal })
  assert.equal(stopped.canSend(target()), false)

  const later = new AbortController()
  const ledger = createRequestLedger({ signal: later.signal })
  ledger.dispose()
  later.abort()
  assert.equal(ledger.cancelled, false, 'dispose 后不再消费外部取消')
})

test('400 与 401 是终态：不重试、不回退，explain 给出稳定原因', () => {
  for (const [status, code] of [[400, DENY.BAD_REQUEST], [401, DENY.AUTH_REQUIRED]]) {
    const ledger = createRequestLedger()
    send(ledger, {}, { status })
    const next = target({ candidateId: 'b', connectionId: 'b', modelId: 'b', domain: 'other' })
    assert.equal(ledger.canSend(target()), false)
    assert.equal(ledger.canSend(next), false)
    assert.equal(ledger.recordFailover({ from: target(), to: next }), false)
    assert.equal(ledger.explain(next).decision.code, code)
  }
})

test('未知提交、5xx、写后断流禁止同目标重试和换目标重放', () => {
  for (const outcome of [
    { status: 500 },
    { status: 503 },
    { execution: 'unknown', error: { code: 'ECONNRESET' } },
    { outcome: 'sent_unknown' },
    { outcome: 'accepted_unknown' },
  ]) {
    const ledger = createRequestLedger()
    send(ledger, {}, outcome)
    const next = target({ candidateId: 'b', connectionId: 'b', modelId: 'b', domain: 'other' })
    assert.equal(ledger.canSend(target()), false, JSON.stringify(outcome))
    assert.equal(ledger.canSend(next), false, JSON.stringify(outcome))
    assert.equal(ledger.explain(next).decision.code, DENY.REPLAY_BLOCKED)
  }
})

test('矛盾证据 fail-closed：不能仅凭 failed_unsent 文案覆盖 sent=true', () => {
  const ledger = createRequestLedger()
  send(ledger, {}, { sent: true, outcome: 'failed_unsent' })
  assert.equal(ledger.canSend(target()), false)
  assert.equal(ledger.explain(target()).decision.code, DENY.REPLAY_BLOCKED)
})

test('只有证明未写出才允许传输重试；status 本身不能证明 5xx 未执行', () => {
  const ledger = createRequestLedger({ limits: { maxTotalAttempts: 2 } })
  send(ledger, {}, { sent: false, outcome: 'failed_unsent', execution: 'not_sent' })
  assert.equal(ledger.canSend(target()), true)
  send(ledger, {}, { sent: false, outcome: 'failed_unsent' })
  assert.equal(ledger.canSend(target()), false)
  assert.equal(ledger.explain(target()).decision.code, DENY.TOTAL_ATTEMPTS)
})

test('非幂等与工具副作用：首次可发，之后即使 429 前置拒绝也不自动重放', () => {
  for (const sideEffect of ['non_idempotent', 'non-idempotent']) {
    const ledger = createRequestLedger({ limits: { maxTotalAttempts: 5, maxFailovers: 5 } })
    assert.equal(ledger.canSend({ ...target(), sideEffect }), true, '首次发送仍须允许')
    send(ledger, { sideEffect }, { status: 429, retryAfterMs: 0 })
    const next = target({ candidateId: 'b', connectionId: 'b', modelId: 'b', domain: 'other' })
    assert.equal(ledger.canSend(target()), false, sideEffect)
    assert.equal(ledger.canSend(next), false, sideEffect)
    assert.equal(ledger.explain(next).decision.code, DENY.REPLAY_BLOCKED)
  }

  for (const sideEffect of ['occurred', 'tool_side_effect']) {
    const ledger = createRequestLedger()
    assert.equal(ledger.canSend({ ...target(), sideEffect }), false, '已发生副作用不得再发')
    send(ledger, {}, { status: 429, retryAfterMs: 0, sideEffect })
    const next = target({ candidateId: 'b', connectionId: 'b', modelId: 'b', domain: 'other' })
    assert.equal(ledger.canSend(target()), false, sideEffect)
    assert.equal(ledger.canSend(next), false, sideEffect)
  }

  const ledger = createRequestLedger()
  send(ledger, { nonIdempotent: true }, { status: 429, retryAfterMs: 0 })
  assert.equal(ledger.canSend(target()), false, 'nonIdempotent 布尔形态也不能被 429 洗白')
})

test('已交付流、工具阶段、部分提交、用户取消阶段均封锁重放', () => {
  for (const phase of ['stream_delivered', 'tool_side_effect', 'partially_committed', 'user_cancelled']) {
    const ledger = createRequestLedger()
    send(ledger, {}, { phase })
    assert.equal(ledger.canSend(target()), false, phase)
    assert.equal(ledger.explain(target()).decision.code, phase === 'user_cancelled' ? DENY.CANCELLED : DENY.REPLAY_BLOCKED)
  }
})

// ---------------------------------------------------------------------------
// Retry-After / 等待 / 故障墙钟预算
// ---------------------------------------------------------------------------
test('仅给 retryAfterMs 也按 429 前置限流处理，不会绕过等待', () => {
  const ledger = createRequestLedger({ limits: { maxTotalAttempts: 2, maxWaitMs: 1000 } })
  send(ledger, {}, { retryAfterMs: 1000 })
  assert.equal(ledger.canSend(target()), false)
  assert.equal(ledger.recordWait({ waitMs: 1000 }), true)
  assert.equal(ledger.canSend(target()), true)
})

test('429 Retry-After：不足额等待不许提前发，等待不得缩短，等足后才放行', () => {
  const ledger = createRequestLedger({ limits: { maxTotalAttempts: 2, maxWaitMs: 5000 } })
  send(ledger, {}, { status: 429, retryAfterMs: 5000 })
  assert.equal(ledger.canSend(target()), false)
  assert.equal(ledger.explain(target()).decision.code, DENY.RETRY_AFTER_PENDING)
  assert.equal(ledger.recordWait({ ms: 4999 }), false, '不得缩短 Retry-After')
  assert.equal(ledger.waitMs, 0, '拒绝的等待不得计数')
  assert.equal(ledger.recordWait({ ms: 5000 }), true)
  assert.equal(ledger.waitMs, 5000)
  assert.equal(ledger.canSend(target()), true)
})

test('Retry-After 超过累计等待或故障剩余预算：不等待、不提前发', () => {
  const waitLedger = createRequestLedger({ limits: { maxWaitMs: 1000 } })
  send(waitLedger, {}, { status: 429, retryAfterMs: 1001 })
  assert.equal(waitLedger.recordWait({ ms: 1001 }), false)
  assert.equal(waitLedger.canSend(target()), false)
  assert.equal(waitLedger.explain(target()).decision.code, DENY.WAIT_BUDGET)

  const c = clock()
  const elapsedLedger = createRequestLedger({ now: c.now, limits: { maxElapsedMs: 1000 } })
  send(elapsedLedger, {}, { status: 429, retryAfterMs: 1001 })
  assert.equal(elapsedLedger.recordWait({ ms: 1001 }), false)
  assert.equal(elapsedLedger.canSend(target()), false)
  assert.equal(elapsedLedger.explain(target()).decision.code, DENY.WAIT_BUDGET)
})

test('累计 waitMs 是硬上限，不能按每次等待反复重置', () => {
  const ledger = createRequestLedger({ limits: { maxTotalAttempts: 4, maxWaitMs: 6000 } })
  send(ledger, {}, { status: 429, retryAfterMs: 4000 })
  assert.equal(ledger.recordWait({ ms: 4000 }), true)
  send(ledger, {}, { status: 429, retryAfterMs: 4000 })
  assert.equal(ledger.recordWait({ ms: 4000 }), false)
  assert.equal(ledger.waitMs, 4000)
  assert.equal(ledger.remaining(target()).waitMs, 2000)
  assert.equal(ledger.canSend(target()), false)
})

test('429 可切独立域而无需空等；同域目标仍受 Retry-After 约束', () => {
  const ledger = createRequestLedger({ limits: { maxFailovers: 1, maxWaitMs: 1000 } })
  send(ledger, {}, { status: 429, retryAfterMs: 5000 })
  const other = target({ candidateId: 'b', connectionId: 'b', modelId: 'b', domain: 'other' })
  assert.equal(ledger.canSend(other), true)
  assert.equal(ledger.recordFailover({ from: target(), to: other }), true)
  assert.equal(ledger.canSend(other), true, '独立域无需等待原目标 Retry-After')
})

test('正常长任务无整体 deadline；maxElapsedMs 只限制故障窗口', () => {
  const c = clock()
  const ledger = createRequestLedger({ now: c.now, limits: { maxTotalAttempts: 2, maxFailovers: 1, maxElapsedMs: 100 } })
  assert.equal(ledger.limits.maxElapsedMs, 100)
  ledger.recordAttempt({ ...target(), attemptId: 'long' })
  c.advance(10 * 60 * 1000)
  ledger.recordOutcome('long', { status: 404, at: c.now })
  assert.equal(ledger.elapsedMs, 600000)
  assert.equal(ledger.faultElapsedMs, 0, '十分钟正常执行不得计入故障预算')

  const next = target({ candidateId: 'b', connectionId: 'b', modelId: 'b', domain: 'other' })
  c.advance(99)
  assert.equal(ledger.canSend(next), true)
  c.advance(2)
  assert.equal(ledger.canSend(next), false)
  assert.equal(ledger.explain(next).decision.code, DENY.ELAPSED_BUDGET)
})

test('故障墙钟预算到期会 abort 恢复信号，不影响首次正常生成', () => {
  const c = clock()
  let fire = null
  let cleared = false
  const ledger = createRequestLedger({
    now: c.now,
    timers: {
      setTimeout(fn, ms) { assert.equal(ms, 100); fire = fn; return 1 },
      clearTimeout() { cleared = true },
    },
    limits: { maxTotalAttempts: 2, maxElapsedMs: 100 },
  })
  ledger.recordAttempt({ ...target(), attemptId: 'normal' })
  c.advance(100000)
  assert.equal(fire, null, '正常长生成不得提前启动故障计时器')
  ledger.recordOutcome('normal', { sent: false, outcome: 'failed_unsent', at: c.now })
  assert.equal(ledger.recordWait(0), true)
  assert.equal(typeof fire, 'function')
  assert.equal(ledger.signal.aborted, false)
  c.advance(101)
  fire()
  assert.equal(ledger.signal.aborted, true)
  assert.equal(ledger.signal.reason, 'fault_budget_exceeded')
  assert.equal(ledger.faultExpired, true)
  assert.equal(ledger.cancelReason, null, '故障预算到期不等于用户取消')
  assert.equal(ledger.canSend(target()), false)
  assert.equal(ledger.explain(target()).decision.code, DENY.ELAPSED_BUDGET)
  assert.equal(cleared, false, '到期回调本身无需再 clearTimeout')
})

test('maxElapsedMs=null：正常长生成不限时长，但故障次数/回退/等待仍有界', () => {
  assert.equal(DEFAULT_LIMITS.maxElapsedMs, null)
  const c = clock()
  const ledger = createRequestLedger({ now: c.now, limits: { maxElapsedMs: null, maxTotalAttempts: 2, maxFailovers: 1, maxWaitMs: 100 } })
  ledger.recordAttempt({ ...target(), attemptId: 'long' })
  c.advance(24 * 60 * 60 * 1000)
  ledger.recordOutcome('long', { sent: false, outcome: 'failed_unsent', at: c.now })
  assert.equal(ledger.canSend(target()), true)
  assert.equal(ledger.remaining(target()).elapsedMs, null)
  assert.equal(ledger.explain(target()).ui.normalGeneration, 'unbounded_by_this_ledger')
  send(ledger, {}, { sent: false, outcome: 'failed_unsent' })
  assert.equal(ledger.canSend(target()), false, '无墙钟上限不等于无发送次数上限')
})

// ---------------------------------------------------------------------------
// 共享额度域与恢复
// ---------------------------------------------------------------------------
test('明确共享 quotaDomain 耗尽跳过整域，独立域仍可发送', () => {
  const ledger = createRequestLedger({ limits: { maxFailovers: 3 } })
  send(ledger, {}, { status: 402, quotaDomainExhausted: true })
  const sameDomain = target({ candidateId: 'b', connectionId: 'b', modelId: 'b' })
  const independent = target({ candidateId: 'c', connectionId: 'c', modelId: 'c', domain: 'independent' })
  assert.deepEqual(ledger.exhaustedQuotaDomains, ['quota-shared'])
  assert.equal(ledger.canSend(sameDomain), false)
  assert.equal(ledger.explain(sameDomain).decision.code, DENY.QUOTA_DOMAIN_EXHAUSTED)
  assert.equal(ledger.canSend(independent), true)
})

test('exhaustQuotaDomain 可阻止尚未尝试的整域；空 domain 报错', () => {
  const ledger = createRequestLedger()
  ledger.exhaustQuotaDomain('account-family')
  assert.equal(ledger.canSend(target({ domain: 'account-family' })), false)
  assert.throws(() => ledger.exhaustQuotaDomain(''), TypeError)
})

test('恢复次数有硬上限且不重复计数；默认只能恢复原目标', () => {
  const ledger = createRequestLedger({ limits: { maxTotalAttempts: 3, maxRecoveryAttempts: 1 } })
  send(ledger, {}, { sent: false, outcome: 'failed_unsent' })
  const other = target({ candidateId: 'b', connectionId: 'b', modelId: 'b', domain: 'other' })
  assert.equal(ledger.recordRecovery(other), false, '原生恢复不得偷换目标')
  assert.equal(ledger.recordRecovery(target()), true)
  assert.equal(ledger.recoveryAttempts, 1)
  assert.equal(ledger.canSend({ ...target(), phase: 'recovery' }), true)
  send(ledger, { phase: 'recovery' }, { sent: false, outcome: 'failed_unsent' })
  assert.equal(ledger.recoveryAttempts, 1, '登记与发送不得重复计恢复')
  assert.equal(ledger.recordRecovery(target()), false)
  assert.equal(ledger.canSend({ ...target(), phase: 'recovery' }), false)
  assert.equal(ledger.explain({ ...target(), phase: 'recovery' }).decision.code, DENY.RECOVERY_ATTEMPTS)
})

test('未知提交只有可信原生续传可恢复，普通重放仍禁止', () => {
  const ledger = createRequestLedger({ limits: { maxTotalAttempts: 2, maxRecoveryAttempts: 1 } })
  send(ledger, {}, { outcome: 'sent_unknown', execution: 'unknown' })
  assert.equal(ledger.recordRecovery(target()), false)
  assert.equal(ledger.canSend({ ...target(), phase: 'recovery' }), false)
  assert.equal(ledger.recordRecovery({ target: target(), trustedResume: true, nativeProtocol: true }), true)
  assert.equal(ledger.canSend({ ...target(), phase: 'recovery' }), true)
  send(ledger, { phase: 'recovery' }, { status: 200 })
  assert.equal(ledger.succeeded, true)
})

// ---------------------------------------------------------------------------
// 金额、explain、输入校验
// ---------------------------------------------------------------------------
test('金额按币种累计，同 attempt 更新不双记，未知金额不伪装为零', () => {
  const ledger = createRequestLedger({ limits: { maxTotalAttempts: 3, maxFailovers: 1 } })
  const id = send(ledger, {}, { sent: false, outcome: 'failed_unsent', amount: 1.25, currency: 'USD' })
  ledger.recordOutcome(id, { amount: 1.25, currency: 'USD', sent: false, outcome: 'failed_unsent' })
  send(ledger, { amountMicro: 500000, currency: 'USD' }, { status: 429, retryAfterMs: 0 })
  send(ledger, { amount: 2, currency: 'EUR' }, { status: 200 })
  assert.equal(ledger.amount, null, '多币种不得隐式汇率求和')
  assert.deepEqual(ledger.amountByCurrency, { USD: 1.75, EUR: 2 })
  assert.equal(ledger.amountUnknown, 0)

  const unknown = createRequestLedger()
  unknown.recordAttempt({ ...target(), attemptId: 'unknown-cost', amount: null })
  assert.equal(unknown.amountUnknown, 1, '未知金额必须显式未知，不能按 0 入账')
  assert.equal(unknown.amount, null)
  assert.equal(unknown.amountByCurrency.USD, undefined)
})

test('explain 返回有效策略、剩余预算与 UI 故障口径，不含请求正文', () => {
  const ledger = createRequestLedger({
    limits: { maxTotalAttempts: 4, maxElapsedMs: 2000 },
    candidateLimits: { 'candidate-a': 2 },
  })
  const view = ledger.explain({ ...target(), secret: 'do-not-copy', body: { messages: ['private'] } })
  assert.equal(view.policy.limits.maxTotalAttempts, 4)
  assert.equal(view.effective.maxCandidateAttempts, 2)
  assert.equal(view.effective.maxTotalAttempts, 2, '有效总预算取全局与目标维度最严值')
  assert.deepEqual(view.limitingDimensions, ['maxCandidateAttempts'])
  assert.equal(view.policy.maxElapsedScope, 'fault_window')
  assert.equal(view.policy.normalGenerationDeadlineMs, null)
  assert.equal(view.policy.retryAfterPolicy, 'never_shorten')
  assert.equal(view.remaining.totalAttempts, 4)
  assert.equal(view.ui.remainingFaultMs, 2000)
  assert.equal(view.decision.allowed, true)
  assert.equal(JSON.stringify(view).includes('do-not-copy'), false)
  assert.equal(JSON.stringify(view).includes('private'), false)
})

test('非法上限、目标、等待与金额 fail-fast', () => {
  assert.throws(() => createRequestLedger({ limits: { maxTotalAttempts: -1 } }), TypeError)
  assert.throws(() => createRequestLedger({ limits: { maxFailovers: 1.5 } }), TypeError)
  assert.throws(() => createRequestLedger({ limits: { maxElapsedMs: Infinity } }), TypeError)
  assert.throws(() => createRequestLedger({ candidateLimits: [] }), TypeError)
  const ledger = new RequestLedger()
  assert.equal(ledger.canSend({ candidateId: 'only-one' }), false)
  assert.equal(ledger.explain({ candidateId: 'only-one' }).decision.code, DENY.INVALID_TARGET)
  assert.throws(() => ledger.recordAttempt({ candidateId: 'only-one' }), TypeError)
  assert.throws(() => ledger.recordWait({ ms: -1 }), TypeError)
  assert.throws(() => ledger.recordWait({ ms: NaN }), TypeError)
  assert.throws(() => ledger.recordAttempt({ ...target(), amount: -1 }), TypeError)
  assert.throws(() => ledger.recordAttempt({ ...target(), amount: 0.0000004 }), TypeError, '不得静默舍入到 micro 以下')
  assert.throws(() => ledger.recordAttempt({ ...target(), amount: 1, currency: 'not-a-currency' }), TypeError)
  assert.equal(ledger.totalAttempts, 0, '非法金额必须在计数前拒绝')
  assert.equal(ledger.firstSend, false)
  assert.deepEqual(ledger.amountByCurrency, {})
  assert.throws(() => ledger.recordOutcome('missing', { status: 200 }), TypeError)
})
