// M3-1 / T-ROUTE-01：可追溯的候选选择（纯函数、无网络、注入时钟，不使用真实 sleep）。
// 断言重点：
//   1. 能力/授权/身份/价格只能来自带 source + observedAt 的事实，未知或过期 = 不可入选；
//   2. 官方订阅不得因"便宜/健康"进入通用池；
//   3. 排序显式兼容性 > 健康 > 价格 > tieBreak，且与输入顺序无关；
//   4. STOP_RECONCILE：可能已提交且无可信续传时不得选下一个候选；
//   5. 理由/审计脱敏（key、带凭据 URL、上游原始错误体都不外泄）；
//   6. 旧形状候选（forward.js 当前传入的扁平对象）继续可用。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTION,
  EXCLUDE,
  PHASE,
  STOP,
  STOP_RECONCILE,
  decide,
  rankCandidates,
} from '../../../src/routing/decision.js'
import {
  FACT_MAX_AGE_MS,
  FACT_STATUS,
  evidence,
  factStatus,
  normalizeCandidate,
  sanitizeSource,
} from '../../../src/routing/facts.js'

const NOW = 1_700_000_000_000
const MIN = 60 * 1000
// 证据信封：只在这里出现来源与观测时间，测试里不需要 sleep 也能造出"过期"。
const ev = (value, source = 'catalog', observedAt = NOW) => evidence(value, { source, observedAt })

const CAPS = (over = {}) => Object.assign({
  capability: 'chat',
  modalities: ['text'],
  contextWindow: 128000,
  tools: { types: ['function'], hosted: [] },
  readability: { plaintext: true, v2Encrypted: true },
}, over)

// 默认构造"事实齐全且都新鲜"的候选；over 里显式写 undefined 表示"这条事实不存在"。
function factCand(over = {}) {
  const o = Object.assign({
    model: 'mg/a/chat',
    provider: 'p1',
    identity: ev({ kind: 'third_party', name: 'vendor-a' }),
    authorization: ev(true, 'config'),
    capabilities: ev(CAPS(), 'probe'),
    pricing: ev({ paid: true, estimatedCostUsd: 0.01 }, 'catalog'),
    health: ev({ state: 'closed', errorRate: 0 }, 'probe'),
    scope: undefined,
    extra: {},
  }, over)
  const facts = {}
  for (const key of ['identity', 'authorization', 'capabilities', 'pricing', 'health']) {
    if (o[key] !== undefined) facts[key] = o[key]
  }
  const out = Object.assign({ model: o.model, provider: o.provider, facts }, o.extra)
  if (o.scope != null) out.scope = o.scope
  return out
}

const REQ = (over = {}) => Object.assign({
  now: NOW,
  capability: 'chat',
  modalities: ['text'],
  promptTokens: 1000,
  tools: ['function'],
  hostedTools: [],
}, over)

const BUDGET = (over = {}) => Object.assign({
  limits: { requestUsd: 1 },
  spent: { requestUsd: 0 },
  enforceUnknownCost: true,
}, over)

function reasonsOf(decision, model) {
  const hit = decision.excluded.find((e) => e.model === model)
  assert.ok(hit, '应当存在被排除候选 ' + model + '，实际 ' + JSON.stringify(decision.excluded))
  return hit.reasons
}

// ============================================================================
// 1. 授权：未知/过期/未授权一律不入选
// ============================================================================
test('M3-1：未授权 / 授权无证据 / 授权过期的候选都不入选', () => {
  const denied = decide(REQ(), [factCand({ authorization: ev(false, 'config') })], null, null, BUDGET())
  assert.equal(denied.action, ACTION.STOP)
  assert.equal(denied.code, STOP.NO_CANDIDATE)
  assert.equal(denied.target, null)
  assert.deepEqual(reasonsOf(denied, 'mg/a/chat'), [EXCLUDE.UNAUTHORIZED])
  assert.equal(denied.excluded[0].factMode, 'evidence')

  const unknown = decide(REQ(), [factCand({ authorization: undefined })], null, null, BUDGET())
  assert.deepEqual(reasonsOf(unknown, 'mg/a/chat'), [EXCLUDE.AUTHORIZATION_UNPROVEN])

  const stale = decide(REQ(), [factCand({ authorization: ev(true, 'config', NOW - 10 * MIN) })], null, null, BUDGET())
  assert.deepEqual(reasonsOf(stale, 'mg/a/chat'), [EXCLUDE.AUTHORIZATION_UNPROVEN])

  const ok = decide(REQ(), [factCand()], null, null, BUDGET())
  assert.equal(ok.action, ACTION.CONTINUE)
  assert.equal(ok.target.model, 'mg/a/chat')
})

// ============================================================================
// 2. 能力：只能来自候选自己的证据，不得从需求/官方模板继承
// ============================================================================
test('M3-1：能力未证明（缺失/无信封/过期）不得入选，且不从需求复制', () => {
  // 顶层 tools.types 与需求一致，但没有 facts.capabilities：这曾经是"能力来自需求"的伪造路径。
  const inherited = factCand({ capabilities: undefined, extra: { tools: { types: ['function'], hosted: [] } } })
  // 事实存在但没带来源/观测时间：不算证据。
  const bare = factCand({ capabilities: { capability: 'chat', tools: { types: ['function'] } } })
  const stale = factCand({ capabilities: ev(CAPS(), 'probe', NOW - 48 * 60 * MIN) })

  for (const [label, cand] of [['缺失', inherited], ['无信封', bare], ['过期', stale]]) {
    const d = decide(REQ(), [cand], null, null, BUDGET())
    assert.equal(d.action, ACTION.STOP, label)
    assert.deepEqual(reasonsOf(d, cand.model), [EXCLUDE.CAPABILITY_UNPROVEN], label)
  }

  // 证据存在但确实不覆盖需求：给出具体原因，而不是含糊的"未知"。
  const partial = factCand({ capabilities: ev(CAPS({ tools: { types: ['function'], hosted: [] } }), 'probe') })
  const ex = decide(REQ({ hostedTools: ['web_search'], modalities: ['text', 'image'] }), [partial], null, null, BUDGET())
  assert.deepEqual(reasonsOf(ex, 'mg/a/chat'), ['modality_unsupported', 'hosted_tools_unsupported'])
})

// ============================================================================
// 3. 健康：冷却中排除；过期按未知（降权而非冒充故障）
// ============================================================================
test('M3-1：冷却中的候选不入选；冷却到点按 half-open 放行一次探测', () => {
  const cooling = factCand({ health: ev({ state: 'open', cooldownUntilMs: NOW + 5 * MIN, errorRate: 1 }, 'probe') })
  const d = decide(REQ(), [cooling], null, null, BUDGET())
  assert.deepEqual(reasonsOf(d, 'mg/a/chat'), [EXCLUDE.UNHEALTHY])

  const cooled = factCand({ health: ev({ state: 'open', cooldownUntilMs: NOW - 1, errorRate: 1 }, 'probe') })
  const ok = decide(REQ(), [cooled], null, null, BUDGET())
  assert.equal(ok.action, ACTION.CONTINUE)
  assert.equal(ok.target.model, 'mg/a/chat')
})

test('M3-1：过期健康事实按未知处理（不排除、但排在已知健康之后）', () => {
  const stale = factCand({ model: 'mg/stale', provider: 'p1', health: ev({ state: 'closed', errorRate: 0 }, 'probe', NOW - 10 * MIN) })
  const fresh = factCand({ model: 'mg/fresh', provider: 'p2', health: ev({ state: 'closed', errorRate: 0 }, 'probe', NOW) })
  const req = { capability: 'chat', modalities: ['text'], tools: ['function'], hostedTools: [] }
  const { ranked } = rankCandidates([stale, fresh], { now: NOW, request: req })
  assert.equal(ranked.length, 2, '过期健康不等于故障，不得直接排除')
  assert.equal(ranked[0].candidate.model, 'mg/fresh', '未知健康必须排在已知健康之后')
  assert.deepEqual(ranked[1].warnings, ['health_stale'])

  const d = decide(REQ(), [stale, fresh], null, null, BUDGET())
  assert.deepEqual(d.audit.facts.warnings, ['health_stale'])
  assert.equal(d.target.model, 'mg/fresh')
})

// ============================================================================
// 4. 价格：未知/过期 + 有费用上限 ⇒ 排除；越过上限（含最坏情况）⇒ 排除
// ============================================================================
test('M3-1：价格未知或过期且有费用上限时不得入选；没有上限才允许未知价格', () => {
  const noQuote = factCand({ pricing: undefined })
  const d = decide(REQ(), [noQuote], null, null, BUDGET())
  assert.deepEqual(reasonsOf(d, 'mg/a/chat'), [EXCLUDE.QUOTE_UNKNOWN])

  const staleQuote = factCand({ pricing: ev({ paid: true, estimatedCostUsd: 0.01 }, 'catalog', NOW - 24 * 60 * MIN) })
  const stale = decide(REQ(), [staleQuote], null, null, BUDGET())
  assert.deepEqual(reasonsOf(stale, 'mg/a/chat'), [EXCLUDE.QUOTE_UNKNOWN])

  // 没有配置任何费用上限：未知价格不构成排除理由（排序时仍然靠后）。
  const open = decide(REQ(), [noQuote], null, null, { limits: {}, spent: {}, enforceUnknownCost: true })
  assert.equal(open.action, ACTION.CONTINUE)

  // 显式关闭 fail-closed：允许未知价格（既有语义的逃生门）。
  const relaxed = decide(REQ(), [noQuote], null, null, BUDGET({ enforceUnknownCost: false }))
  assert.equal(relaxed.action, ACTION.CONTINUE)
  assert.equal(relaxed.estimatedCostUsd, null)
})

test('M3-1：超预算与最坏情况超预算都不入选', () => {
  const over = factCand({ pricing: ev({ paid: true, estimatedCostUsd: 0.6 }, 'catalog') })
  const d = decide(REQ(), [over], null, null, BUDGET({ limits: { requestUsd: 0.5 }, spent: { requestUsd: 0 } }))
  assert.deepEqual(reasonsOf(d, 'mg/a/chat'), [EXCLUDE.BUDGET_EXCEEDED])
  assert.equal(d.code, STOP.NO_CANDIDATE)

  const worst = factCand({ pricing: ev({ paid: true, estimatedCostUsd: 0.1, worstCaseUsd: 0.9 }, 'catalog') })
  const w = decide(REQ(), [worst], null, null, BUDGET({ limits: { requestUsd: 0.5 }, spent: { requestUsd: 0 } }))
  assert.deepEqual(reasonsOf(w, 'mg/a/chat'), [EXCLUDE.WORST_CASE_EXCEEDS_BUDGET])
})

// ============================================================================
// 5. 官方订阅/身份隔离
// ============================================================================
test('M3-1：官方订阅身份候选不得因便宜/健康进入通用池', () => {
  const official = factCand({
    model: 'official/gpt',
    provider: 'openai',
    identity: ev({ kind: 'official_subscription', name: 'openai' }),
    pricing: ev({ paid: false, estimatedCostUsd: 0 }, 'catalog'),
    health: ev({ state: 'closed', errorRate: 0 }, 'probe'),
    extra: { tieBreak: -100 },
  })
  const third = factCand({ model: 'mg/vendor/paid', provider: 'p2', pricing: ev({ paid: true, estimatedCostUsd: 0.5 }, 'catalog') })

  const d = decide(REQ(), [official, third], null, null, BUDGET())
  assert.equal(d.action, ACTION.CONTINUE)
  assert.equal(d.target.model, 'mg/vendor/paid')
  assert.deepEqual(reasonsOf(d, 'official/gpt'), [EXCLUDE.OFFICIAL])

  const only = decide(REQ(), [official], null, null, BUDGET())
  assert.equal(only.action, ACTION.STOP)
  assert.equal(only.code, STOP.NO_CANDIDATE)
  assert.equal(only.target, null)
})

test('M3-1：请求点名身份时，身份不符或无法证明即排除', () => {
  const other = factCand({ identity: ev({ kind: 'third_party', name: 'vendor-b' }) })
  const d = decide(REQ({ identity: 'vendor-a' }), [other], null, null, BUDGET())
  assert.deepEqual(reasonsOf(d, 'mg/a/chat'), [EXCLUDE.IDENTITY_CONFLICT])

  const unknown = factCand({ identity: undefined })
  const u = decide(REQ({ identity: 'vendor-a' }), [unknown], null, null, BUDGET())
  assert.deepEqual(reasonsOf(u, 'mg/a/chat'), [EXCLUDE.IDENTITY_UNPROVEN])
})

// ============================================================================
// 6. 排序确定性（不依赖输入顺序/对象键顺序）
// ============================================================================
test('M3-1：同分排序确定性——打乱输入顺序得到同一候选', () => {
  const a = factCand({ model: 'mg/zeta', provider: 'p1' })
  const b = factCand({ model: 'mg/alpha', provider: 'p1' })
  const c = factCand({ model: 'mg/mid', provider: 'p1' })
  const perms = [[a, b, c], [c, b, a], [b, a, c], [c, a, b], [a, c, b], [b, c, a]]
  const picks = perms.map((list) => decide(REQ(), list, null, null, BUDGET()).target)
  for (const pick of picks) assert.equal(pick.model, 'mg/alpha', '同分必须按 model 码点字典序稳定打破')
  assert.deepEqual(picks[0], picks[5])
  // 审计输出（含排除列表顺序）也必须与输入顺序无关。
  const auditA = decide(REQ(), [a, b, c], null, null, BUDGET())
  const auditB = decide(REQ(), [c, a, b], null, null, BUDGET())
  assert.deepEqual(auditA.excluded, auditB.excluded)
  assert.deepEqual(auditA.audit, auditB.audit)

  // 价格优先于配置 tieBreak 与字典序：更便宜的候选胜出（不是"更便宜就无视健康"）。
  const cheap = factCand({ model: 'mg/zzz-cheap', provider: 'p1', pricing: ev({ paid: true, estimatedCostUsd: 0.001 }, 'catalog') })
  assert.equal(decide(REQ(), [a, b, cheap], null, null, BUDGET()).target.model, 'mg/zzz-cheap')

  // 显式兼容性优先于价格：请求点名的目标即使更贵也排第一。
  const preferred = decide(REQ({ preferredTarget: { model: 'mg/zeta' } }), [a, cheap], null, null, BUDGET())
  assert.equal(preferred.target.model, 'mg/zeta')

  // 同一输入两次必须完全一致。
  assert.deepEqual(decide(REQ(), [a, b, c], null, null, BUDGET()), decide(REQ(), [a, b, c], null, null, BUDGET()))
})

// ============================================================================
// 7. STOP_RECONCILE：可能已提交且无可信续传 ⇒ 不选下一个候选
// ============================================================================
test('M3-1：STOP_RECONCILE —— 可能已提交且无可信续传时不得换下一个候选', () => {
  const cands = [factCand(), factCand({ model: 'mg/b/chat', provider: 'p2' })]
  const d = decide(REQ(), cands, null, { possiblyCommitted: true }, BUDGET())
  assert.equal(d.action, ACTION.STOP)
  assert.equal(d.code, STOP.RECONCILE)
  assert.equal(d.target, null)
  assert.equal(d.retry, null)
  assert.equal(d.willIncurCost, false)
  assert.deepEqual(d.audit.reconcile, { possiblyCommitted: true, trustedResume: false })

  // 契约常量：动作仍是 stop_with_error（动作集合保持 4 值），但错误码可区分。
  assert.equal(STOP_RECONCILE.action, ACTION.STOP)
  assert.equal(STOP_RECONCILE.code, STOP.RECONCILE)
  assert.equal(STOP_RECONCILE.stopReason, 'reconcile_required')
  assert.equal(Object.values(ACTION).length, 4)

  const resumed = decide(REQ(), cands, null, { possiblyCommitted: true, trustedResume: { trusted: true } }, BUDGET())
  assert.equal(resumed.action, ACTION.CONTINUE)
  assert.equal(resumed.target.model, 'mg/a/chat')

  const notCommitted = decide(REQ(), cands, null, { possiblyCommitted: false }, BUDGET())
  assert.equal(notCommitted.action, ACTION.CONTINUE)
})

// ============================================================================
// 8. 脱敏：key / 带凭据 URL / 上游错误体都不进决策与审计
// ============================================================================
test('M3-1：理由与审计脱敏（凭据、带凭据 URL、上游原始错误体不外泄）', () => {
  const SENTINEL = 'sk-live-SENTINEL-123456'
  const leaky = factCand({
    authorization: ev(true, SENTINEL),
    extra: {
      apiKey: SENTINEL,
      headers: { authorization: 'Bearer ' + SENTINEL },
      baseURL: 'https://user:' + SENTINEL + '@up.example/v1?key=' + SENTINEL,
    },
  })
  const d = decide(
    REQ({ identity: 'vendor-a' }),
    [leaky, factCand({ model: 'mg/b/chat', provider: 'p2' })],
    { default: { state: 'closed' } },
    { possiblyCommitted: false, lastErrorBody: 'upstream said: ' + SENTINEL },
    BUDGET(),
  )
  const json = JSON.stringify(d)
  assert.ok(!json.includes('SENTINEL'), '决策/审计不得回显凭据或上游错误体：' + json)
  assert.equal(d.audit.errorClass, 'none')
  assert.equal(d.target.model, 'mg/a/chat')
  assert.equal(sanitizeSource(SENTINEL), 'redacted')
  assert.equal(sanitizeSource('catalog'), 'catalog')
})

// ============================================================================
// 9. 预算：task/daily 已花费不可验证时不得假装 0
// ============================================================================
test('M3-1：task/daily 已花费不可验证时 fail-closed，可注入账本', () => {
  const cand = factCand()
  const blind = decide(REQ(), [cand], null, null, { limits: { taskUsd: 1 }, spent: {}, enforceUnknownCost: true })
  assert.deepEqual(reasonsOf(blind, 'mg/a/chat'), [EXCLUDE.BUDGET_UNVERIFIED])

  const led = decide(REQ(), [cand], null, null, { limits: { taskUsd: 1 }, spent: {}, ledger: { taskUsd: 0.2 }, enforceUnknownCost: true })
  assert.equal(led.action, ACTION.CONTINUE)
  assert.equal(led.budget.spent.taskUsd, 0.2)
  assert.equal(led.budget.spendSource.taskUsd, 'ledger')

  // request 维度由本次请求自己累计，缺省不算"不可验证"。
  const onlyReq = decide(REQ(), [cand], null, null, { limits: { requestUsd: 1 }, spent: {}, enforceUnknownCost: true })
  assert.equal(onlyReq.action, ACTION.CONTINUE)
})

// ============================================================================
// 10. 取消/截止：先于候选选择
// ============================================================================
test('M3-1：调用方取消或截止已到时，不选任何候选', () => {
  const cancel = decide(REQ({ callerCancelled: true }), [factCand()], null, null, BUDGET())
  assert.equal(cancel.action, ACTION.STOP)
  assert.equal(cancel.code, STOP.CANCELLED)
  assert.equal(cancel.target, null)
  assert.equal(cancel.willIncurCost, false)

  const late = decide(REQ({ deadlineExpired: true }), [factCand()], null, null, BUDGET())
  assert.equal(late.action, ACTION.STOP)
  assert.equal(late.code, STOP.DEADLINE)
  assert.equal(late.target, null)
})

// ============================================================================
// 11. 事实归一化契约（纯函数，注入时钟）
// ============================================================================
test('M3-1：事实新鲜度判定与形状契约（注入时钟，不 sleep）', () => {
  assert.equal(factStatus(ev(1, 'catalog', NOW - 4 * MIN), { now: NOW, maxAgeMs: 5 * MIN }).status, FACT_STATUS.PROVEN)
  assert.equal(factStatus(ev(1, 'catalog', NOW - 6 * MIN), { now: NOW, maxAgeMs: 5 * MIN }).status, FACT_STATUS.EXPIRED)
  assert.equal(factStatus({ value: 1, observedAt: NOW }, { now: NOW }).status, FACT_STATUS.MALFORMED)
  assert.equal(factStatus({ value: 1, source: 'catalog' }, { now: NOW }).status, FACT_STATUS.MALFORMED)
  assert.equal(factStatus({ value: 1, source: 'catalog', observedAt: NOW }, { now: NaN }).status, FACT_STATUS.MISSING)
  assert.equal(factStatus(42, { now: NOW }).status, FACT_STATUS.MISSING)

  assert.equal(normalizeCandidate({ model: 'm', provider: 'p', facts: {} }).mode, 'evidence')
  assert.equal(normalizeCandidate({ model: 'm', provider: 'p' }).mode, 'legacy')
  assert.ok(FACT_MAX_AGE_MS.health <= FACT_MAX_AGE_MS.capabilities)

  // 没有可信时钟时不许把事实当新鲜：全部按未知处理（fail-closed）。
  const noClock = decide({ capability: 'chat', tools: ['function'] }, [factCand()], null, null, BUDGET())
  assert.equal(noClock.action, ACTION.STOP)
  assert.equal(noClock.code, STOP.NO_CANDIDATE)
  assert.equal(noClock.target, null)
  assert.equal(noClock.audit.facts.clockProvided, false)
  // 直接调用排序函数时没给 now，同样不得把事实当新鲜。
  const direct = rankCandidates([factCand()], { request: { capability: 'chat' } })
  assert.equal(direct.ranked.length, 0)
  assert.ok(direct.skipped[0].reasons.includes(EXCLUDE.IDENTITY_UNPROVEN))
})

// ============================================================================
// 12. 向后兼容：旧形状候选与旧单对象签名继续可用
// ============================================================================
test('M3-1：旧形状候选（无 facts）继续按原语义入选', () => {
  const legacy = {
    model: 'mg/legacy/chat',
    provider: 'p1',
    providerKind: 'third_party',
    authorized: true,
    capability: 'chat',
    modalities: ['text'],
    tools: { types: ['function'], hosted: [] },
    estimatedCostUsd: 0.02,
    health: { state: 'closed' },
    priority: 0,
  }
  // 位置参数签名 + 旧候选：legacy 兼容层放行，不要求 facts。
  const pos = decide(REQ(), [legacy], null, null, BUDGET())
  assert.equal(pos.action, ACTION.CONTINUE)
  assert.equal(pos.target.model, 'mg/legacy/chat')
  assert.equal(pos.excluded.length, 0)

  // 旧单对象签名：错误分类与换模型链路不变。
  const old = decide({
    now: NOW,
    phase: PHASE.ACCEPTED,
    error: { status: 500 },
    current: Object.assign({}, legacy, { model: 'mg/cur' }),
    candidates: [factCand()],
    budget: BUDGET(),
    attempts: { total: 1, sameProvider: 1, failovers: 0 },
  })
  assert.equal(old.action, ACTION.FAILOVER)
  assert.equal(old.target.model, 'mg/a/chat')

  // 旧形状的排除原因码保持不变（forward.js 日志/既有测试依赖）。
  const oldSkip = decide({
    now: NOW,
    phase: PHASE.UNSENT,
    candidates: [Object.assign({}, legacy, { authorized: false })],
    budget: BUDGET(),
  })
  assert.deepEqual(oldSkip.audit.board.skipped[0].reasons, ['unauthorized'])
})
