// M5-1 / T-AGENT-01：UHR 推理契约与回执（纯函数，无网络，注入时间，不使用真实 sleep）。
// 断言重点：
//   1. 四类引用（caller/scope/request/attempt）只以哈希出现，明文/密钥不外泄；
//   2. 只接受授权作用域与授权候选集；越权候选、超时间/费用预算 ⇒ 稳定拒绝码；
//   3. 终态与 M1-1 attempt 阶段一一对应；未知用量必须 unknown，不得填 0；
//   4. exact route 与裁决目标/上游实见三方一致（上游看到的 = 回执写的）；
//   5. 回执不可变、同输入同输出（幂等）。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ATTEMPT_PHASE,
  REJECT,
  ROUTE_FIELDS,
  TERMINAL,
  UHR_CONTRACT,
  hashRef,
  modelgateInfer,
  usageMustBeUnknown,
} from '../../../src/routing/inference-receipt.js'

const NOW = 1_700_000_000_000
const ROUTE = { model: 'mg/a/chat', provider: 'p1', protocol: 'openai-chat', generation: 'gpt-5' }
const OFFICIAL_ROUTE = { model: 'official/gpt', provider: 'openai', protocol: 'openai-chat', generation: 'gpt-5', providerKind: 'official_subscription' }

function base(over = {}) {
  const input = {
    caller: { ref: 'uhr-session-1', kind: 'uhr' },
    scope: {
      ref: 'task-scope-9',
      authorized: true,
      expiresAt: NOW + 60_000,
      currency: 'USD',
      candidates: [{ model: 'mg/a/chat', provider: 'p1' }],
    },
    request: { id: 'req-abc', submittedAt: NOW },
    budget: { timeMs: 5_000, costMicro: 10_000, currency: 'USD' },
    attempts: [{ attemptId: 'att-1', phase: 'succeeded', route: ROUTE, startedAt: NOW, finishedAt: NOW + 1_200 }],
    decision: { action: 'continue', code: 'MG_FB_CONTINUE', target: { model: 'mg/a/chat', provider: 'p1' } },
    usage: { verified: true, inputTokens: 100, outputTokens: 20, costMicro: 300 },
  }
  return Object.assign(input, over)
}

const attempt = (phase, over = {}) => Object.assign(
  { attemptId: 'att-' + phase, phase, route: ROUTE, startedAt: NOW, finishedAt: NOW + 500 },
  over,
)

// ============================================================================
// 1. 正常回执 + 四类引用脱敏
// ============================================================================
test('M5-1：成功回执关联四类引用，且对外只有哈希（明文不外泄）', () => {
  const r = modelgateInfer(base())
  assert.equal(r.ok, true)
  assert.equal(r.contract, UHR_CONTRACT)
  assert.equal(r.terminal, TERMINAL.SUCCEEDED)
  assert.equal(r.unknownUsage, false)

  assert.match(r.refs.callerRef, /^caller_[a-f0-9]{24}$/)
  assert.match(r.refs.scopeRef, /^scope_[a-f0-9]{24}$/)
  assert.match(r.refs.requestId, /^req_[a-f0-9]{24}$/)
  assert.equal(r.refs.attemptIds.length, 1)
  assert.match(r.refs.attemptIds[0], /^att_[a-f0-9]{24}$/)
  // 哈希可复算，便于把日志与回执对起来。
  assert.equal(r.refs.callerRef, hashRef('caller', 'uhr-session-1'))
  assert.equal(r.refs.requestId, hashRef('req', 'req-abc'))
  // 明文一律不出现。
  const json = JSON.stringify(r)
  for (const raw of ['uhr-session-1', 'task-scope-9', 'req-abc', 'att-1']) {
    assert.ok(!json.includes(raw), '回执不得包含明文引用 ' + raw)
  }
  assert.deepEqual(r.usage, {
    known: true, inputTokens: 100, outputTokens: 20, totalTokens: 120,
    costMicro: 300, currency: 'USD', unit: 'micro', source: 'upstream',
  })
})

// ============================================================================
// 2. 作用域/身份拒绝
// ============================================================================
test('M5-1：缺失身份、未授权作用域、过期作用域 ⇒ 稳定拒绝码', () => {
  assert.equal(modelgateInfer(base({ caller: {} })).code, REJECT.IDENTITY)
  assert.equal(modelgateInfer(base({ scope: { ref: 's', expiresAt: NOW + 1 } })).code, REJECT.SCOPE)
  assert.equal(modelgateInfer(base({ scope: Object.assign({}, base().scope, { authorized: false }) })).code, REJECT.SCOPE)
  const expired = modelgateInfer(base({ scope: Object.assign({}, base().scope, { expiresAt: NOW - 1 }) }))
  assert.equal(expired.code, REJECT.SCOPE)
  assert.equal(expired.ok, false)
  assert.ok(Object.isFrozen(expired), '拒绝结果同样不可变')
})

// ============================================================================
// 3. 候选授权（含官方订阅 D7）
// ============================================================================
test('M5-1：越权候选与未授权的官方订阅候选都拒绝（不静默降级）', () => {
  const foreign = modelgateInfer(base({
    attempts: [attempt('succeeded', { route: Object.assign({}, ROUTE, { model: 'mg/rogue' }) })],
  }))
  assert.equal(foreign.code, REJECT.CANDIDATE)
  assert.equal(foreign.details.candidate, 'mg/rogue|p1')

  const officialScope = {
    ref: 'scope-official',
    authorized: true,
    expiresAt: NOW + 60_000,
    currency: 'USD',
    candidates: [{ model: 'official/gpt', provider: 'openai' }],
  }
  const officialAttempt = attempt('succeeded', { route: OFFICIAL_ROUTE })
  const denied = modelgateInfer(base({
    scope: officialScope,
    attempts: [officialAttempt],
    decision: { action: 'continue', code: 'MG_FB_CONTINUE', target: { model: 'official/gpt', provider: 'openai' } },
  }))
  assert.equal(denied.code, REJECT.CANDIDATE, '官方订阅未显式授权时不得进入通用推理回执')

  const allowed = modelgateInfer(base({
    scope: Object.assign({}, officialScope, { allowOfficial: true }),
    attempts: [officialAttempt],
    decision: { action: 'continue', code: 'MG_FB_CONTINUE', target: { model: 'official/gpt', provider: 'openai' } },
    expectedRoute: OFFICIAL_ROUTE,
  }))
  assert.equal(allowed.ok, true)
  assert.equal(allowed.route.providerKind, 'official_subscription')
})

// ============================================================================
// 4. 预算：时间与费用
// ============================================================================
test('M5-1：超时间预算 / 超费用预算 ⇒ 拒绝码，且数字如实回显', () => {
  const slow = modelgateInfer(base({ budget: { timeMs: 100, costMicro: 10_000, currency: 'USD' } }))
  assert.equal(slow.code, REJECT.TIME_BUDGET)
  assert.equal(slow.details.timeMs, 100)
  assert.equal(slow.details.elapsedMs, 1_200)

  const over = modelgateInfer(base({ budget: { timeMs: 5_000, costMicro: 100, currency: 'USD' } }))
  assert.equal(over.code, REJECT.COST_BUDGET)
  assert.equal(over.details.budgetMicro, 100)
  assert.equal(over.details.actualMicro, 300)

  assert.equal(modelgateInfer(base({ budget: { timeMs: 0, costMicro: 10, currency: 'USD' } })).code, REJECT.TIME_BUDGET)
  assert.equal(modelgateInfer(base({ budget: { costMicro: 10, currency: 'USD' } })).code, REJECT.BAD_REQUEST)
  // 币种必须显式且一致：不做汇率换算。
  assert.equal(modelgateInfer(base({ budget: { timeMs: 5_000, costMicro: 10_000, currency: 'EUR' } })).code, REJECT.CURRENCY)
  assert.equal(modelgateInfer(base({ budget: { timeMs: 5_000, costMicro: 10_000 } })).code, REJECT.CURRENCY)
})

// ============================================================================
// 5. 终态映射（与 M1-1 阶段一一对应）
// ============================================================================
test('M5-1：六种 attempt 阶段映射到六个终态；未知阶段拒绝', () => {
  const cases = [
    [ATTEMPT_PHASE.SUCCEEDED, TERMINAL.SUCCEEDED],
    [ATTEMPT_PHASE.FAILED, TERMINAL.FAILED],
    [ATTEMPT_PHASE.CANCELLED_UNSENT, TERMINAL.CANCELLED_UNSENT],
    [ATTEMPT_PHASE.SENT_UNKNOWN, TERMINAL.SENT_UNKNOWN],
    [ATTEMPT_PHASE.TOOL_RISK, TERMINAL.TOOL_RISK],
    [ATTEMPT_PHASE.STOP_RECONCILE, TERMINAL.STOP_RECONCILE],
  ]
  for (const [phase, terminal] of cases) {
    const r = modelgateInfer(base({ attempts: [attempt(phase)] }))
    assert.equal(r.ok, true, phase)
    assert.equal(r.terminal, terminal, phase)
  }
  // 大写阶段也接受（大小写不敏感），但未知阶段必须拒绝。
  assert.equal(modelgateInfer(base({ attempts: [attempt('SUCCEEDED')] })).terminal, TERMINAL.SUCCEEDED)
  const bogus = modelgateInfer(base({ attempts: [attempt('queued')] }))
  assert.equal(bogus.code, REJECT.BAD_REQUEST)
  assert.equal(bogus.details.received, 'queued')
})

test('M5-1：终态优先级 —— 工具风险 > 对账 > 已发送未知 > 未发送 > 成功/失败', () => {
  const mixed = modelgateInfer(base({
    attempts: [attempt('succeeded'), attempt('tool_risk', { attemptId: 'att-2' })],
  }))
  assert.equal(mixed.terminal, TERMINAL.TOOL_RISK)

  const reconcile = modelgateInfer(base({
    attempts: [attempt('sent_unknown'), attempt('stop_reconcile', { attemptId: 'att-2' })],
  }))
  assert.equal(reconcile.terminal, TERMINAL.STOP_RECONCILE)

  const unknown = modelgateInfer(base({ attempts: [attempt('sent_unknown')] }))
  assert.equal(unknown.terminal, TERMINAL.SENT_UNKNOWN)

  const failed = modelgateInfer(base({ attempts: [attempt('failed')] }))
  assert.equal(failed.terminal, TERMINAL.FAILED)
})

// ============================================================================
// 6. 用量：未知必须 unknown，未发送才是已知 0
// ============================================================================
test('M5-1：未知用量输出 unknown（不得填 0）；仅 CANCELLED_UNSENT 是已知 0', () => {
  const sentUnknown = modelgateInfer(base({
    attempts: [attempt('sent_unknown')],
    usage: { verified: true, inputTokens: 100, outputTokens: 20, costMicro: 300 },
  }))
  assert.equal(sentUnknown.terminal, TERMINAL.SENT_UNKNOWN)
  assert.equal(sentUnknown.usage, 'unknown')
  assert.equal(sentUnknown.unknownUsage, true)
  assert.equal(usageMustBeUnknown(TERMINAL.SENT_UNKNOWN), true)

  const noUsage = modelgateInfer(base({ attempts: [attempt('failed')], usage: undefined }))
  assert.equal(noUsage.usage, 'unknown')
  assert.equal(noUsage.unknownUsage, true)
  // cost 与 usage 分离：不知道 token 时也不臆造 token 数。
  assert.equal(noUsage.cost.known, false)

  const cancelled = modelgateInfer(base({ attempts: [attempt('cancelled_unsent')], usage: undefined }))
  assert.equal(cancelled.terminal, TERMINAL.CANCELLED_UNSENT)
  assert.deepEqual(cancelled.usage, {
    known: true, inputTokens: 0, outputTokens: 0, totalTokens: 0,
    costMicro: 0, currency: 'USD', unit: 'micro', source: 'not_sent',
  })
  assert.equal(cancelled.unknownUsage, false)
  assert.equal(cancelled.cost.source, 'not_sent')
})

// ============================================================================
// 7. exact route：裁决目标 / 上游实见
// ============================================================================
test('M5-1：exact route 与裁决目标、上游实见逐字段一致（不一致即拒绝）', () => {
  const ok = modelgateInfer(base({
    decision: { action: 'continue', code: 'MG_FB_CONTINUE', target: { model: 'mg/a/chat', provider: 'p1', protocol: 'openai-chat', generation: 'gpt-5' } },
    expectedRoute: ROUTE,
  }))
  assert.equal(ok.ok, true)
  for (const field of ROUTE_FIELDS) assert.equal(ok.route[field], ROUTE[field], field)
  assert.equal(ok.routeExact, true)

  for (const field of ROUTE_FIELDS) {
    const tampered = Object.assign({}, ROUTE, { [field]: field === 'model' ? 'mg/b/chat' : 'other-value' })
    const r = modelgateInfer(base({ expectedRoute: tampered }))
    assert.equal(r.code, REJECT.ROUTE_MISMATCH, field)
    assert.equal(r.details.field, field)
  }

  const decisionDrift = modelgateInfer(base({
    decision: { action: 'failover', code: 'MG_FB_FAILOVER_UPSTREAM', target: { model: 'mg/b/chat', provider: 'p1' } },
  }))
  assert.equal(decisionDrift.code, REJECT.ROUTE_MISMATCH)

  // route 字段缺失或像凭据都不行。
  const incomplete = modelgateInfer(base({ attempts: [attempt('succeeded', { route: { model: 'mg/a/chat', provider: 'p1' } })] }))
  assert.equal(incomplete.code, REJECT.BAD_REQUEST)
  const secretish = modelgateInfer(base({ attempts: [attempt('succeeded', { route: Object.assign({}, ROUTE, { generation: 'sk-live-LEAK-123456' }) })] }))
  assert.equal(secretish.code, REJECT.BAD_REQUEST)
})

// ============================================================================
// 8. 与 M3-2 账本 receipt 的连接
// ============================================================================
test('M5-1：账本 receipt 决定已知费用；链路/币种/金额不一致必须拒绝', () => {
  const settled = modelgateInfer(base({
    usage: undefined,
    ledger: { attemptId: 'att-1', status: 'settled', actualMicro: 250, currency: 'USD' },
  }))
  assert.equal(settled.ok, true)
  assert.equal(settled.cost.known, true)
  assert.equal(settled.cost.micro, 250)
  assert.equal(settled.cost.source, 'ledger')
  assert.equal(settled.usage, 'unknown', '账本知道钱、但不知道 token ⇒ usage 仍是 unknown')
  assert.equal(settled.unknownUsage, true)

  const inFlight = modelgateInfer(base({
    usage: undefined,
    ledger: { attemptId: 'att-1', status: 'unknown', actualMicro: null, currency: 'USD' },
  }))
  assert.equal(inFlight.usage, 'unknown')
  assert.equal(inFlight.cost.known, false)

  const mismatch = modelgateInfer(base({
    usage: { verified: true, inputTokens: 1, outputTokens: 1, costMicro: 999 },
    ledger: { attemptId: 'att-1', status: 'settled', actualMicro: 250, currency: 'USD' },
  }))
  assert.equal(mismatch.code, REJECT.USAGE_MISMATCH)

  const detached = modelgateInfer(base({ ledger: { attemptId: 'att-other', status: 'settled', actualMicro: 1, currency: 'USD' } }))
  assert.equal(detached.code, REJECT.BAD_REQUEST, '账本 attemptId 不在回执 attempt 列表里 = 链路不完整')

  const currency = modelgateInfer(base({ ledger: { attemptId: 'att-1', status: 'settled', actualMicro: 1, currency: 'EUR' } }))
  assert.equal(currency.code, REJECT.CURRENCY)
})

// ============================================================================
// 9. 脱敏
// ============================================================================
test('M5-1：回执/拒绝理由都不含密钥、URL 凭据或原始标识', () => {
  const SENTINEL = 'sk-live-SENTINEL-55555'
  const leaky = modelgateInfer(base({
    caller: { ref: SENTINEL, kind: 'uhr' },
    scope: Object.assign({}, base().scope, { ref: SENTINEL }),
    request: { id: SENTINEL, submittedAt: NOW },
    attempts: [attempt('succeeded', { attemptId: SENTINEL })],
    usage: { verified: true, inputTokens: 1, outputTokens: 1, costMicro: 1 },
  }))
  assert.equal(leaky.ok, true)
  assert.ok(!JSON.stringify(leaky).includes('SENTINEL'), '回执不得回显凭据')

  // 拒绝路径同样不允许回显（例如未授权候选里带 URL 凭据的 provider）。
  const rejected = modelgateInfer(base({
    attempts: [attempt('succeeded', { route: Object.assign({}, ROUTE, { provider: 'https://user:' + SENTINEL + '@up.example' }) })],
  }))
  assert.equal(rejected.ok, false)
  assert.ok(!JSON.stringify(rejected).includes('SENTINEL'), '拒绝理由不得回显凭据：' + JSON.stringify(rejected))
})

// ============================================================================
// 10. 不可变 + 幂等
// ============================================================================
test('M5-1：回执深度冻结，同输入同输出（含键顺序无关的 receiptHash）', () => {
  const r = modelgateInfer(base())
  assert.equal(Object.isFrozen(r), true)
  assert.equal(Object.isFrozen(r.refs), true)
  assert.equal(Object.isFrozen(r.route), true)
  assert.equal(Object.isFrozen(r.attempts), true)
  assert.equal(Object.isFrozen(r.attempts[0]), true)
  assert.throws(() => { r.refs.callerRef = 'tampered' }, TypeError)

  const again = modelgateInfer(base())
  assert.deepEqual(again, r)
  assert.equal(again.receiptHash, r.receiptHash)
  assert.match(r.receiptHash, /^[a-f0-9]{64}$/)

  // 对象键顺序不影响结果（canonical JSON）。
  const reordered = JSON.parse(JSON.stringify(base()))
  const shuffled = {
    usage: reordered.usage,
    decision: reordered.decision,
    attempts: reordered.attempts,
    budget: reordered.budget,
    request: reordered.request,
    scope: reordered.scope,
    caller: reordered.caller,
  }
  assert.equal(modelgateInfer(shuffled).receiptHash, r.receiptHash)
})

test('M5-1：没有 attempt 的回执不是回执（拒绝），且拒绝码集合稳定', () => {
  const empty = modelgateInfer(base({ attempts: [] }))
  assert.equal(empty.code, REJECT.BAD_REQUEST)
  assert.equal(empty.contract, UHR_CONTRACT)
  assert.ok(Object.isFrozen(empty))
  const codes = Object.values(REJECT)
  assert.equal(new Set(codes).size, codes.length, '拒绝码必须唯一且稳定')
})
