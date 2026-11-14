// E5 智能 Fallback 决策（D4/D7）离线验收：纯函数、零网络、零真实上游。
// 覆盖：错误分类 / 请求阶段状态机 / 候选筛选 / 预算与费用闸门 / 禁用未授权与官方订阅池 /
//       有副作用不重放 / 已交付流不拼接 / 候选评分确定性。
// 断言重点：任何 stop 都不产生新调用（willIncurCost=false 且无 target），任何 failover 目标都必须已授权。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTION,
  PHASE,
  ERROR_CLASS,
  STOP,
  DEFAULT_LIMITS,
  decide,
  classifyError,
  advancePhase,
  evaluateCandidate,
  rankCandidates,
  assessReplaySafety,
  backoffMs,
  isReplayBlockedPhase,
} from '../../../src/routing/decision.js'

const NOW = 1_700_000_000_000

function cand(over = {}) {
  return Object.assign({
    model: 'mg/vendor/chat',
    provider: 'p1',
    providerKind: 'third_party',
    authorized: true,
    capability: 'chat',
    modalities: ['text'],
    contextWindow: 200000,
    tools: { types: ['function', 'local_shell'], hosted: [] },
    readability: { plaintext: true, v2Encrypted: false },
    health: { state: 'closed', errorRate: 0 },
    priority: 0,
    pricing: { paid: true },
    estimatedCostUsd: 0.02,
  }, over)
}

function budget(over = {}) {
  return Object.assign({
    limits: { requestUsd: 1, taskUsd: 5, dailyUsd: 20 },
    spent: { requestUsd: 0.1, taskUsd: 0.1, dailyUsd: 0.1 },
    enforceUnknownCost: true,
  }, over)
}

function assertNoNewCall(d) {
  assert.equal(d.willIncurCost, false, '停机/继续不得产生新调用费用，实际 ' + d.willIncurCost)
  assert.equal(d.target, null, '停机决策不得指向任何候选目标')
  assert.equal(d.retry, null, '停机决策不得带重试计划')
}

// ============================================================================
// 1. 错误分类：D4 要求必须区分的全部类别
// ============================================================================
test('classifyError：429/5xx/402/404/400/422/401/403/网络/超时/断流/取消/v2/工具副作用', () => {
  const r429 = classifyError({ status: 429, headers: { 'retry-after': '3' } }, { now: NOW })
  assert.equal(r429.cls, ERROR_CLASS.RATE_LIMITED)
  assert.equal(r429.retryAfterMs, 3000)
  assert.equal(r429.retryableSame, true)
  assert.equal(r429.failoverable, true)

  assert.equal(classifyError({ status: 500 }).cls, ERROR_CLASS.UPSTREAM)
  assert.equal(classifyError({ status: 503 }).retryableSame, true)
  assert.equal(classifyError({ status: 502 }).failoverable, true)

  const r402 = classifyError({ status: 402 })
  assert.equal(r402.cls, ERROR_CLASS.QUOTA)
  assert.equal(r402.retryableSame, false, '余额不会在退避后回来：同上游重试无意义')
  assert.equal(r402.failoverable, true, '402 可换已授权上游')

  assert.equal(classifyError({ status: 404 }).cls, ERROR_CLASS.MODEL_UNAVAILABLE)
  assert.equal(classifyError({ status: 400 }).cls, ERROR_CLASS.BAD_REQUEST)
  assert.equal(classifyError({ status: 422 }).cls, ERROR_CLASS.BAD_REQUEST)
  assert.equal(classifyError({ status: 400 }).deterministic, true)
  assert.equal(classifyError({ status: 400, upstreamFault: true }).cls, ERROR_CLASS.UPSTREAM, '上游侧 400 不算客户端参数错误')

  const r401 = classifyError({ status: 401 })
  assert.equal(r401.cls, ERROR_CLASS.AUTH)
  assert.equal(r401.retryableSame, false)
  assert.equal(r401.failoverable, true)
  assert.equal(classifyError({ status: 403 }).cls, ERROR_CLASS.AUTH)

  assert.equal(classifyError({ code: 'ECONNRESET' }).cls, ERROR_CLASS.NETWORK)
  assert.equal(classifyError({ code: 'ENOTFOUND' }).retryableSame, true)
  assert.equal(classifyError({ code: 'ETIMEDOUT' }).cls, ERROR_CLASS.TIMEOUT)
  assert.equal(classifyError({ timeout: true }).cls, ERROR_CLASS.TIMEOUT)
  assert.equal(classifyError({ streamInterrupted: true }).cls, ERROR_CLASS.STREAM_INTERRUPTED)
  assert.equal(classifyError({ code: 'ECANCELED' }).cls, ERROR_CLASS.CANCELLED)
  assert.equal(classifyError({ reason: 'client_closed' }).cls, ERROR_CLASS.CANCELLED)
  assert.equal(classifyError({ v2Unreadable: true }).cls, ERROR_CLASS.V2_UNREADABLE)
  assert.equal(classifyError({ toolSideEffect: true }).cls, ERROR_CLASS.TOOL_SIDE_EFFECT)
  assert.equal(classifyError({ status: 418 }).cls, ERROR_CLASS.BAD_REQUEST)
  assert.equal(classifyError({ status: 418 }).failoverable, false, '未知 4xx 按确定性错误处理')
  assert.equal(classifyError(null).cls, ERROR_CLASS.NONE)
  assert.equal(classifyError({}).cls, ERROR_CLASS.NONE)
})

test('classifyError：Retry-After 秒数 / HTTP-date（注入 now，确定性）/ 显式毫秒优先', () => {
  const at = new Date(NOW + 4000).toUTCString()
  assert.equal(classifyError({ status: 429, headers: { 'Retry-After': at } }, { now: NOW }).retryAfterMs, 4000)
  assert.equal(classifyError({ status: 429, retryAfterMs: 1200, headers: { 'retry-after': '9' } }).retryAfterMs, 1200)
  assert.equal(classifyError({ status: 429, headers: { 'retry-after': 'not-a-date' } }).retryAfterMs, null)
  assert.equal(classifyError({ status: 429 }).hasRetryAfter, false)
})

// ============================================================================
// 2. 请求阶段状态机：只进不退，终态不可逆
// ============================================================================
test('advancePhase：合法推进 / 非法回退 / 未知阶段 / 终态', () => {
  assert.deepEqual(advancePhase(PHASE.UNSENT, PHASE.ACCEPTED), { ok: true, phase: PHASE.ACCEPTED, from: PHASE.UNSENT })
  assert.equal(advancePhase(PHASE.ACCEPTED, PHASE.TOOL_SIDE_EFFECT).ok, true)
  assert.equal(advancePhase(PHASE.ACCEPTED, PHASE.STREAM_DELIVERED).ok, true)
  assert.equal(advancePhase(PHASE.ACCEPTED, PHASE.PARTIALLY_COMMITTED).ok, true)
  assert.equal(advancePhase(PHASE.UNSENT, PHASE.USER_CANCELLED).ok, true)
  assert.equal(advancePhase(PHASE.TOOL_SIDE_EFFECT, PHASE.ACCEPTED).ok, false, '不得从副作用阶段回退到可重放阶段')
  assert.equal(advancePhase(PHASE.STREAM_DELIVERED, PHASE.UNSENT).ok, false)
  assert.equal(advancePhase(PHASE.PARTIALLY_COMMITTED, PHASE.ACCEPTED).ok, false)
  assert.equal(advancePhase(PHASE.USER_CANCELLED, PHASE.ACCEPTED).ok, false)
  assert.equal(advancePhase('bogus', PHASE.ACCEPTED).code, STOP.PHASE_INVALID)
  assert.equal(isReplayBlockedPhase(PHASE.TOOL_SIDE_EFFECT), true)
  assert.equal(isReplayBlockedPhase(PHASE.ACCEPTED), false)
  assert.equal(isReplayBlockedPhase(PHASE.UNSENT), false)
  assert.equal(decide({ now: NOW, phase: 'bogus', error: { status: 500 } }).code, STOP.PHASE_INVALID)
})

test('assessReplaySafety：无副作用/宿主风险/预执行拒绝/已证明副作用', () => {
  assert.equal(assessReplaySafety({ phase: PHASE.UNSENT, errorClass: ERROR_CLASS.UPSTREAM }).safe, true)
  assert.equal(assessReplaySafety({ phase: PHASE.ACCEPTED, errorClass: ERROR_CLASS.UPSTREAM, request: { sideEffectRisk: 'none' } }).safe, true)
  assert.equal(assessReplaySafety({ phase: PHASE.ACCEPTED, errorClass: ERROR_CLASS.UPSTREAM, request: { sideEffectRisk: 'possible' } }).safe, false, '宿主工具 5xx 不能证明未执行')
  assert.equal(assessReplaySafety({ phase: PHASE.ACCEPTED, errorClass: ERROR_CLASS.RATE_LIMITED, request: { sideEffectRisk: 'possible' } }).safe, true, '429 是处理前拒绝')
  assert.equal(assessReplaySafety({ phase: PHASE.ACCEPTED, errorClass: ERROR_CLASS.AUTH, request: { sideEffectRisk: 'possible' } }).safe, true)
  assert.equal(assessReplaySafety({ phase: PHASE.ACCEPTED, errorClass: ERROR_CLASS.NETWORK, request: { sideEffectRisk: 'possible' } }).safe, false)
  assert.equal(assessReplaySafety({ phase: PHASE.ACCEPTED, errorClass: ERROR_CLASS.UPSTREAM, request: { sideEffectRisk: 'occurred' } }).safe, false)
  assert.equal(assessReplaySafety({ phase: PHASE.STREAM_DELIVERED, errorClass: ERROR_CLASS.UPSTREAM }).safe, false)
  assert.equal(assessReplaySafety({ phase: PHASE.ACCEPTED, errorClass: ERROR_CLASS.UPSTREAM, sideEffectProved: true }).safe, false)
})

// ============================================================================
// 3. 安全重试与换模型
// ============================================================================
test('纯文本 5xx（已受理、无副作用）→ 同上游退避重试，并给出费用预估', () => {
  const d = decide({
    now: NOW, phase: PHASE.ACCEPTED, error: { status: 503 },
    current: cand(), candidates: [], attempts: { total: 0, sameProvider: 0, failovers: 0 },
    budget: budget(), remainingMs: 60000,
  })
  assert.equal(d.action, ACTION.RETRY_SAME)
  assert.equal(d.code, 'MG_FB_RETRY_UPSTREAM')
  assert.equal(d.retry.source, 'backoff')
  assert.equal(d.retry.afterMs, backoffMs(0))
  assert.equal(d.willIncurCost, true)
  assert.ok(d.estimatedCostUsd > 0)
  assert.equal(d.budget.nextUsd, 0.02, '预算影响必须显式给出预计费用')
  assert.equal(d.audit.replaySafe, true)
})

test('429 + Retry-After 等得下 → 按 Retry-After 重试；等不下 → 直接换模型', () => {
  const fits = decide({
    now: NOW, phase: PHASE.ACCEPTED, error: { status: 429, headers: { 'retry-after': '2' } },
    current: cand(), candidates: [cand({ model: 'mg/vendor/backup', provider: 'p2' })],
    budget: budget(), remainingMs: 60000,
  })
  assert.equal(fits.action, ACTION.RETRY_SAME)
  assert.equal(fits.retry.afterMs, 2000)
  assert.equal(fits.retry.source, 'retry-after')

  const tooSlow = decide({
    now: NOW, phase: PHASE.ACCEPTED, error: { status: 429, headers: { 'retry-after': '30' } },
    current: cand(), candidates: [cand({ model: 'mg/vendor/backup', provider: 'p2' })],
    budget: budget(), remainingMs: 5000,
  })
  assert.equal(tooSlow.action, ACTION.FAILOVER, 'Retry-After 超出剩余预算时不许空等')
  assert.equal(tooSlow.target.model, 'mg/vendor/backup')
  assert.equal(tooSlow.retry, null)
})

test('同上游重试次数用尽 → 换模型；换模型次数也用尽 → 显式失败（不无限重放）', () => {
  const failover = decide({
    now: NOW, phase: PHASE.ACCEPTED, error: { status: 500 },
    current: cand(), candidates: [cand({ model: 'mg/vendor/backup', provider: 'p2' })],
    attempts: { total: 1, sameProvider: 1, failovers: 0 }, budget: budget(),
  })
  assert.equal(failover.action, ACTION.FAILOVER)
  assert.equal(failover.code, 'MG_FB_FAILOVER_UPSTREAM')

  const exhausted = decide({
    now: NOW, phase: PHASE.ACCEPTED, error: { status: 500 },
    current: cand(), candidates: [cand({ model: 'mg/vendor/backup', provider: 'p2' })],
    attempts: { total: 3, sameProvider: 1, failovers: 2 }, budget: budget(),
  })
  assert.equal(exhausted.action, ACTION.STOP)
  assert.equal(exhausted.code, STOP.ATTEMPTS)
  assertNoNewCall(exhausted)
})

test('402/404/401 不重试同上游但可换已授权候选；400 确定性拒绝不换模型', () => {
  const candidates = [cand({ model: 'mg/vendor/backup', provider: 'p2' })]
  for (const [status, action, cls] of [[402, ACTION.FAILOVER, 'QUOTA'], [404, ACTION.FAILOVER, 'MODEL_UNAVAILABLE'], [401, ACTION.FAILOVER, 'AUTH']]) {
    const d = decide({ now: NOW, phase: PHASE.ACCEPTED, error: { status }, current: cand(), candidates, budget: budget() })
    assert.equal(d.action, action, status + ' 应换模型')
    assert.equal(d.code, 'MG_FB_FAILOVER_' + cls)
    assert.ok(d.target && d.target.model === 'mg/vendor/backup')
  }
  const bad = decide({ now: NOW, phase: PHASE.ACCEPTED, error: { status: 400 }, current: cand(), candidates, budget: budget() })
  assert.equal(bad.action, ACTION.STOP)
  assert.equal(bad.code, STOP.BAD_REQUEST)
  assertNoNewCall(bad)
})

test('候选池只有未授权项 → 停机且零费用（绝不使用未授权候选）', () => {
  const d = decide({
    now: NOW, phase: PHASE.ACCEPTED, error: { status: 500 },
    current: cand(),
    candidates: [cand({ model: 'mg/other/cheap', provider: 'p2', authorized: false, estimatedCostUsd: 0 })],
    budget: budget(), attempts: { total: 1, sameProvider: 1, failovers: 0 },
  })
  assert.equal(d.action, ACTION.STOP)
  assert.equal(d.code, STOP.NO_CANDIDATE)
  assertNoNewCall(d)
  assert.deepEqual(d.audit.board.skipped[0].reasons, ['unauthorized'])
})

test('官方订阅永不进通用 fallback 池（D7）：即使更便宜/更健康也不可选', () => {
  const official = cand({
    model: 'official/gpt', provider: 'openai', providerKind: 'official_subscription',
    estimatedCostUsd: 0, priority: -100,
  })
  const thirdParty = cand({ model: 'mg/vendor/paid', provider: 'p2', estimatedCostUsd: 0.5 })
  const picked = decide({ now: NOW, phase: PHASE.ACCEPTED, error: { status: 500 }, current: cand(), candidates: [official, thirdParty], budget: budget(), attempts: { total: 1, sameProvider: 1, failovers: 0 } })
  assert.equal(picked.action, ACTION.FAILOVER)
  assert.equal(picked.target.model, 'mg/vendor/paid', '官方订阅不得作为通用备用池')
  assert.deepEqual(picked.audit.board.skipped.find((s) => s.model === 'official/gpt').reasons, ['official_subscription_excluded'])

  const onlyOfficial = decide({ now: NOW, phase: PHASE.ACCEPTED, error: { status: 500 }, current: cand(), candidates: [official], budget: budget(), attempts: { total: 1, sameProvider: 1, failovers: 0 } })
  assert.equal(onlyOfficial.action, ACTION.STOP)
  assert.equal(onlyOfficial.code, STOP.NO_CANDIDATE)
  assertNoNewCall(onlyOfficial)
})

test('官方额度耗尽（402）走手动应急：未确认 → 停机，不自动进第三方池', () => {
  const current = cand({ model: 'official/gpt', provider: 'openai', providerKind: 'official_subscription' })
  const thirdParty = cand({ model: 'mg/vendor/backup', provider: 'p2', scope: 'emergency' })
  const stopped = decide({ now: NOW, phase: PHASE.ACCEPTED, error: { status: 402 }, current, candidates: [thirdParty], budget: budget() })
  assert.equal(stopped.action, ACTION.STOP)
  assert.equal(stopped.code, STOP.OFFICIAL_QUOTA)
  assertNoNewCall(stopped)

  const acked = decide({
    now: NOW, phase: PHASE.ACCEPTED, error: { status: 402 }, current, candidates: [thirdParty],
    budget: budget(), emergency: { acknowledged: true },
  })
  assert.equal(acked.action, ACTION.FAILOVER, '用户显式确认后才允许应急切换')
  assert.equal(acked.target.model, 'mg/vendor/backup')
  assert.deepEqual(acked.audit.emergency, { acknowledged: true })
})

test('应急范围候选未确认 → 过滤；确认后才可用', () => {
  const emergencyCand = cand({ model: 'mg/emergency/only', provider: 'p3', scope: 'emergency' })
  const denied = decide({ now: NOW, phase: PHASE.ACCEPTED, error: { status: 500 }, current: cand(), candidates: [emergencyCand], budget: budget(), attempts: { total: 1, sameProvider: 1, failovers: 0 } })
  assert.equal(denied.action, ACTION.STOP)
  assert.equal(denied.code, STOP.NO_CANDIDATE)
  assert.deepEqual(denied.audit.board.skipped[0].reasons, ['emergency_not_acknowledged'])
  const allowed = decide({
    now: NOW, phase: PHASE.ACCEPTED, error: { status: 500 }, current: cand(), candidates: [emergencyCand],
    budget: budget(), emergency: { acknowledged: true }, attempts: { total: 1, sameProvider: 1, failovers: 0 },
  })
  assert.equal(allowed.action, ACTION.FAILOVER)
  assert.equal(allowed.target.model, 'mg/emergency/only')
})

// ============================================================================
// 4. 副作用 / 已交付流 / 部分提交 / 取消 / v2 不可读：一律禁止重放
// ============================================================================
test('已出现工具副作用 → 任何错误都停机，零新调用（禁止重复外部操作）', () => {
  for (const error of [{ status: 429, headers: { 'retry-after': '1' } }, { status: 500 }, { code: 'ECONNRESET' }, { status: 402 }]) {
    const d = decide({
      now: NOW, phase: PHASE.TOOL_SIDE_EFFECT, error, current: cand(),
      candidates: [cand({ model: 'mg/backup', provider: 'p2' })], budget: budget(), remainingMs: 60000,
    })
    assert.equal(d.action, ACTION.STOP, '副作用阶段不得重试/换模型（错误 ' + JSON.stringify(error) + '）')
    assert.equal(d.code, STOP.SIDE_EFFECT)
    assertNoNewCall(d)
    assert.equal(d.audit.replaySafe, false)
  }
})

test('宿主工具风险 + 5xx → 停机；同风险 + 429 → 允许重试（处理前拒绝）', () => {
  const request = { hostedTools: ['web_search'], promptTokens: 1000 }
  const uncertain = decide({
    now: NOW, phase: PHASE.ACCEPTED, error: { status: 503 }, request, current: cand(),
    candidates: [cand({ model: 'mg/backup', provider: 'p2' })], budget: budget(),
  })
  assert.equal(uncertain.action, ACTION.STOP)
  assert.equal(uncertain.code, STOP.SIDE_EFFECT)
  assertNoNewCall(uncertain)

  const limited = decide({
    now: NOW, phase: PHASE.ACCEPTED, error: { status: 429, headers: { 'retry-after': '1' } }, request, current: cand(),
    candidates: [], budget: budget(), remainingMs: 60000,
  })
  assert.equal(limited.action, ACTION.RETRY_SAME)
})

test('已交付有效流 → 停机，不拼接另一模型输出伪装无中断', () => {
  const d = decide({
    now: NOW, phase: PHASE.STREAM_DELIVERED, error: { streamInterrupted: true }, current: cand(),
    candidates: [cand({ model: 'mg/backup', provider: 'p2' })], budget: budget(),
  })
  assert.equal(d.action, ACTION.STOP)
  assert.equal(d.code, STOP.STREAM_DELIVERED)
  assertNoNewCall(d)
})

test('任务部分提交 → 停机，不重复提交', () => {
  const d = decide({ now: NOW, phase: PHASE.PARTIALLY_COMMITTED, error: { status: 500 }, current: cand(), candidates: [cand({ model: 'mg/backup', provider: 'p2' })], budget: budget() })
  assert.equal(d.action, ACTION.STOP)
  assert.equal(d.code, STOP.PARTIAL_COMMIT)
  assertNoNewCall(d)
})

test('用户取消 → 停机且零费用；即便还有可用候选也不重放', () => {
  const d = decide({
    now: NOW, phase: PHASE.ACCEPTED, error: { code: 'ECANCELED' }, current: cand(),
    candidates: [cand({ model: 'mg/backup', provider: 'p2' })], budget: budget(),
  })
  assert.equal(d.action, ACTION.STOP)
  assert.equal(d.code, STOP.CANCELLED)
  assertNoNewCall(d)
  const byPhase = decide({ now: NOW, phase: PHASE.USER_CANCELLED, error: { status: 500 }, current: cand(), candidates: [cand()], budget: budget() })
  assert.equal(byPhase.code, STOP.CANCELLED)
})

test('v2 加密任务不可读 → 显式失败，不换上游（D3×D4）', () => {
  const d = decide({
    now: NOW, phase: PHASE.ACCEPTED, error: { v2Unreadable: true }, current: cand(),
    candidates: [cand({ model: 'mg/vendor/readable', provider: 'p2', readability: { plaintext: true, v2Encrypted: true } })],
    budget: budget(),
  })
  assert.equal(d.action, ACTION.STOP)
  assert.equal(d.code, STOP.TASK_UNREADABLE)
  assertNoNewCall(d)
  const filtered = rankCandidates([cand({ readability: { v2Encrypted: false } })], { request: { requiresV2TaskRead: true } })
  assert.equal(filtered.ranked.length, 0)
  assert.deepEqual(filtered.skipped[0].reasons, ['task_unreadable'])
})

// ============================================================================
// 5. 预算：超限停机，不降级；费用估算可注入
// ============================================================================
test('日预算已耗尽 → 停机且不使用更便宜候选（不降级）', () => {
  const d = decide({
    now: NOW, phase: PHASE.ACCEPTED, error: { status: 500 }, current: cand(),
    candidates: [cand({ model: 'mg/cheap', provider: 'p2', estimatedCostUsd: 0.0001 })],
    budget: budget({ spent: { requestUsd: 0, taskUsd: 0, dailyUsd: 20 } }),
  })
  assert.equal(d.action, ACTION.STOP)
  assert.equal(d.code, STOP.BUDGET)
  assert.equal(d.budget.exceededBy, 'daily')
  assertNoNewCall(d)
})

test('重试预计费用突破单请求预算 → 停机（不是换便宜模型）', () => {
  const d = decide({
    now: NOW, phase: PHASE.ACCEPTED, error: { status: 500 }, current: cand({ estimatedCostUsd: 0.02 }),
    candidates: [cand({ model: 'mg/cheap', provider: 'p2', estimatedCostUsd: 0 })],
    budget: budget({ spent: { requestUsd: 0.99, taskUsd: 0, dailyUsd: 0 } }),
  })
  assert.equal(d.action, ACTION.STOP)
  assert.equal(d.code, STOP.BUDGET)
  assert.equal(d.budget.exceededBy, 'request')
  assertNoNewCall(d)
})

test('费用未知的付费候选在预算闸门下 fail-closed（可显式关闭）', () => {
  const noEstimate = cand({ estimatedCostUsd: undefined, pricing: { paid: true } })
  const stopped = decide({
    now: NOW, phase: PHASE.ACCEPTED, error: { status: 500 }, current: noEstimate,
    candidates: [], budget: budget(),
  })
  assert.equal(stopped.action, ACTION.STOP)
  assert.equal(stopped.code, STOP.BUDGET)
  assert.equal(stopped.budget.exceededBy, 'unknown_cost')
  assertNoNewCall(stopped)

  const allowed = decide({
    now: NOW, phase: PHASE.ACCEPTED, error: { status: 500 }, current: noEstimate,
    candidates: [], budget: budget({ enforceUnknownCost: false }),
  })
  assert.equal(allowed.action, ACTION.RETRY_SAME)
  assert.equal(allowed.estimatedCostUsd, null)
})

test('费用估算接口可注入，且注入结果进入决策与审计', () => {
  let calls = 0
  const d = decide({
    now: NOW, phase: PHASE.ACCEPTED, error: { status: 429, headers: { 'retry-after': '1' } },
    current: cand(), candidates: [], budget: budget(), remainingMs: 60000,
    estimateCost: (candidate) => { calls += 1; return candidate.model === 'mg/vendor/chat' ? 0.031 : 0.9 },
  })
  assert.equal(d.action, ACTION.RETRY_SAME)
  assert.equal(d.estimatedCostUsd, 0.031)
  assert.equal(d.budget.nextUsd, 0.031)
  assert.ok(calls >= 1)
})

// ============================================================================
// 6. 候选筛选与确定性
// ============================================================================
test('候选筛选：授权/能力/模态/上下文/工具/健康逐项给出原因', () => {
  const ctx = { now: NOW, request: { capability: 'chat', modalities: ['text', 'image'], promptTokens: 128000, tools: ['function'], hostedTools: ['web_search'] } }
  const ev = evaluateCandidate(cand({ modalities: ['text'], contextWindow: 32000 }), ctx)
  assert.equal(ev.eligible, false)
  assert.deepEqual(ev.reasons, ['modality_unsupported', 'context_exceeded', 'hosted_tools_unsupported'])
  assert.deepEqual(evaluateCandidate(cand({ capability: 'embedding', contextWindow: 32000 }), ctx).reasons, ['capability_mismatch', 'modality_unsupported', 'context_exceeded', 'hosted_tools_unsupported'])
  assert.deepEqual(evaluateCandidate(cand({ tools: undefined }), ctx).reasons, ['modality_unsupported', 'tools_unsupported', 'hosted_tools_unsupported'])
  assert.deepEqual(evaluateCandidate(cand({ health: { state: 'open', cooldownUntilMs: NOW + 5000 } }), ctx).reasons, ['modality_unsupported', 'hosted_tools_unsupported', 'unhealthy'])
  const halfOpen = evaluateCandidate(cand({ health: { state: 'open', cooldownUntilMs: NOW - 1 } }), Object.assign({}, ctx, { allowHalfOpen: false, request: { capability: 'chat' } }))
  assert.deepEqual(halfOpen.reasons, ['unhealthy'])
})

test('健康状态可注入：注入器判定不健康时该候选被过滤（不必复制状态进候选）', () => {
  const d = decide({
    now: NOW, phase: PHASE.UNSENT, candidates: [cand({ model: 'mg/flaky', provider: 'p2' })], budget: budget(),
    healthOf: (candidate) => (candidate.model === 'mg/flaky' ? { state: 'open', cooldownUntilMs: NOW + 1000, errorRate: 1 } : { state: 'closed' }),
  })
  assert.equal(d.action, ACTION.STOP)
  assert.equal(d.code, STOP.NO_CANDIDATE)
  assert.deepEqual(d.audit.board.skipped[0].reasons, ['unhealthy'])
  const ok = decide({
    now: NOW, phase: PHASE.UNSENT, candidates: [cand({ model: 'mg/flaky', provider: 'p2', health: { state: 'open', cooldownUntilMs: NOW + 1000 } })], budget: budget(),
    healthOf: () => ({ state: 'closed', errorRate: 0 }),
  })
  assert.equal(ok.action, ACTION.CONTINUE, '注入器优先于候选快照')
})

test('候选评分确定性：打乱输入顺序仍选同一最优，同输入两次结果完全相同', () => {
  const cheapHealthy = cand({ model: 'mg/a', provider: 'p1', estimatedCostUsd: 0.01 })
  const expensive = cand({ model: 'mg/b', provider: 'p2', estimatedCostUsd: 0.5 })
  const flaky = cand({ model: 'mg/c', provider: 'p3', estimatedCostUsd: 0.01, health: { state: 'closed', errorRate: 0.9 } })
  const input = {
    now: NOW, phase: PHASE.ACCEPTED, error: { status: 500 }, current: cand({ model: 'mg/current' }),
    candidates: [expensive, flaky, cheapHealthy], budget: budget(),
    attempts: { total: 1, sameProvider: 1, failovers: 0 },
  }
  const a = decide(input)
  const b = decide(Object.assign({}, input, { candidates: [cheapHealthy, expensive, flaky] }))
  assert.equal(a.action, ACTION.FAILOVER)
  assert.equal(a.target.model, 'mg/a')
  assert.equal(b.target.model, 'mg/a', '评分必须与候选顺序无关')
  assert.deepEqual(a, decide(input), '同输入必须完全确定')
  assert.deepEqual(a.audit.board.skipped, b.audit.board.skipped)
})

test('triedTargets：已尝试过的候选不再被选中，防止重复外部操作', () => {
  const d = decide({
    now: NOW, phase: PHASE.ACCEPTED, error: { status: 500 }, current: cand(),
    candidates: [cand({ model: 'mg/tried', provider: 'p2' })],
    triedTargets: [{ model: 'mg/tried', provider: 'p2' }],
    budget: budget(), attempts: { total: 1, sameProvider: 1, failovers: 0 },
  })
  assert.equal(d.action, ACTION.STOP)
  assert.equal(d.code, STOP.NO_CANDIDATE)
  assert.deepEqual(d.audit.board.skipped[0].reasons, ['already_tried'])
  assertNoNewCall(d)
})

test('发送前选候选（continue）：只选已授权健康候选，并给出费用', () => {
  const d = decide({
    now: NOW, phase: PHASE.UNSENT, candidates: [cand({ model: 'mg/bad', provider: 'p2', authorized: false }), cand({ model: 'mg/ok', provider: 'p3' })],
    budget: budget(),
  })
  assert.equal(d.action, ACTION.CONTINUE)
  assert.equal(d.code, STOP.CONTINUE)
  assert.equal(d.target.model, 'mg/ok')
  assert.equal(d.willIncurCost, true)
  assert.equal(d.audit.board.skipped[0].reasons[0], 'unauthorized')
  const empty = decide({ now: NOW, phase: PHASE.UNSENT, candidates: [], budget: budget() })
  assert.equal(empty.action, ACTION.STOP)
  assert.equal(empty.code, STOP.NO_CANDIDATE)
  assertNoNewCall(empty)
})

// ============================================================================
// 7. 审计与脱敏
// ============================================================================
test('决策结果不含凭据与请求正文（最小化审计）', () => {
  const secretCand = cand({ apiKey: 'sk-secret-should-not-leak', extraHeaders: { authorization: 'Bearer sk-secret-should-not-leak' } })
  const d = decide({
    now: NOW, phase: PHASE.ACCEPTED, error: { status: 500, bodyText: 'prompt=secret-prompt-body' },
    current: secretCand, candidates: [cand({ model: 'mg/backup', provider: 'p2', apiKey: 'sk-secret-should-not-leak' })],
    request: { tools: ['function'], promptTokens: 100, sideEffectRisk: 'none' },
    budget: budget(),
  })
  const json = JSON.stringify(d)
  assert.ok(!json.includes('sk-secret-should-not-leak'), '决策/审计不得回显上游凭据')
  assert.ok(!json.includes('secret-prompt-body'), '决策/审计不得回显请求正文/错误正文')
  assert.equal(d.audit.request.tools, 1)
  assert.equal(d.audit.errorClass, ERROR_CLASS.UPSTREAM)
})

test('默认上限与常量契约稳定（供文档/接入方引用）', () => {
  assert.deepEqual(DEFAULT_LIMITS, {
    maxSameProviderAttempts: 1, maxFailovers: 2, maxTotalAttempts: 3, maxWaitMs: 30000, backoffBaseMs: 200,
  })
  assert.equal(backoffMs(0), 200)
  assert.equal(backoffMs(3), 1600)
  assert.equal(backoffMs(99), DEFAULT_LIMITS.maxWaitMs)
  assert.equal(Object.values(ACTION).length, 4)
})
