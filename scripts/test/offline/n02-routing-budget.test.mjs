// N02：路由/限流/预算收口（无预算设施拒发计费路径、账本不混币、重复请求一次、边界）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ACTION, EXCLUDE, STOP, decide } from '../../../src/routing/decision.js'
import { evidence, budgetFromLedger } from '../../../src/routing/facts.js'
import { LEDGER_ERROR, openLedger } from '../../../src/routing/ledger.js'
import { retryWaitFits } from '../../../src/retry-policy.js'

const NOW = 1_700_000_000_000
const ev = (value, source = 'catalog') => evidence(value, { source, observedAt: NOW })
const CAPS = { capability: 'chat', modalities: ['text'], contextWindow: 128000, tools: { types: ['function'], hosted: [] }, readability: { plaintext: true, v2Encrypted: true } }
function cand(over = {}) {
  const o = Object.assign({
    model: 'mg/a/chat', provider: 'p1',
    identity: ev({ kind: 'third_party', name: 'vendor-a' }),
    authorization: ev(true, 'config'),
    capabilities: ev(CAPS, 'probe'),
    pricing: ev({ paid: true, estimatedCostUsd: 0.01 }, 'catalog'),
    health: ev({ state: 'closed', errorRate: 0 }, 'probe'),
  }, over);
  const facts = {};
  for (const key of ['identity', 'authorization', 'capabilities', 'pricing', 'health']) if (o[key] !== undefined) facts[key] = o[key];
  return { model: o.model, provider: o.provider, facts };
}
const REQ = { now: NOW, capability: 'chat', modalities: ['text'], promptTokens: 1000, tools: ['function'], hostedTools: [] };
const reasonsOf = (d, m) => (d.excluded.find((e) => e.model === m) || {}).reasons || [];

// —— 无预算设施：付费路径必须拒发，除非显式声明 allow_unmetered ——
test('N02 无预算设施：付费候选被拒（billing_unmetered），免费候选与显式声明放行', () => {
  const noFacility = { enforceUnknownCost: true };
  const blocked = decide(REQ, [cand()], null, null, noFacility);
  assert.equal(blocked.action, ACTION.STOP);
  assert.equal(blocked.code, STOP.BUDGET_EXCEEDED, '无预算设施也属预算类停机，不能笼统 no_candidate');
  assert.deepEqual(reasonsOf(blocked, 'mg/a/chat'), [EXCLUDE.BILLING_UNMETERED]);
  assert.equal(blocked.budget.billingPolicy, 'fail_closed_if_unmetered');
  assert.equal(blocked.budget.metered, false);

  // 免费（已知 usd=0）不受影响
  const free = decide(REQ, [cand({ pricing: ev({ paid: false, estimatedCostUsd: 0 }, 'catalog') })], null, null, noFacility);
  assert.equal(free.action, ACTION.CONTINUE);

  // 显式声明允许未计量：放行，但审计面必须写明策略
  const declared = decide(REQ, [cand()], null, null, { billingPolicy: 'allow_unmetered' });
  assert.equal(declared.action, ACTION.CONTINUE);
  assert.equal(declared.budget.billingPolicy, 'allow_unmetered');

  // 有上限就是有设施：不受本闸门影响（其余预算规则照旧）
  const metered = decide(REQ, [cand()], null, null, { limits: { requestUsd: 1 }, spent: { requestUsd: 0 }, enforceUnknownCost: true });
  assert.equal(metered.action, ACTION.CONTINUE);
  assert.equal(metered.budget.metered, true);
});

test('N02 无预算设施：legacy 候选自述 paid/未知价也不得走计费路径', () => {
  const legacyPaid = { model: 'mg/legacy', provider: 'p1', providerKind: 'third_party', authorized: true, capability: 'chat', modalities: ['text'], tools: { types: ['function'], hosted: [] }, paid: true, health: { state: 'closed' } };
  const d = decide(REQ, [legacyPaid], null, null, undefined);
  assert.equal(d.action, ACTION.STOP);
  assert.deepEqual(reasonsOf(d, 'mg/legacy'), [EXCLUDE.BILLING_UNMETERED]);
  const declared = decide(REQ, [legacyPaid], null, null, { allowUnmetered: true });
  assert.equal(declared.action, ACTION.CONTINUE);
});

test('N02 账本不混币：非 USD 账本视图不得喂给 USD 决策器', () => {
  const eurUsage = { currency: 'EUR', unit: 'micro', requestMicro: 100, taskMicro: 0, dayMicro: 0 };
  assert.throws(() => budgetFromLedger(eurUsage, { currency: 'EUR' }), (e) => e.code === 'FACT_BUDGET_CURRENCY_MISMATCH');
  assert.throws(() => budgetFromLedger(eurUsage), (e) => e.code === 'FACT_BUDGET_CURRENCY_MISMATCH');
  const usdUsage = { currency: 'USD', unit: 'micro', requestMicro: 500_000, taskMicro: 0, dayMicro: 0 };
  const b = budgetFromLedger(usdUsage, { currency: 'USD', limitsMicro: { requestMicro: 1_000_000 } });
  assert.equal(b.currency, 'USD');
  assert.equal(b.unit, 'usd');
  assert.equal(b.spent.requestUsd, 0.5);
  assert.equal(b.limits.requestUsd, 1);
});

// —— 重复请求仅一次（账本幂等）与重启恢复 ——
test('N02 重复请求仅一次 + 重启后可对账（不双记、不释放 unknown）', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mg-n02-ledger-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = { requestId: 'req-dup', requestDigest: 'digest-dup', taskRef: 'task-1', candidate: { model: 'mg/a', provider: 'p1' } };
  const q = { amountMicro: 1000, currency: 'USD', version: 'q1' };
  const led = openLedger({ dir });
  const r1 = await led.reserve(Object.assign({}, base, { quote: q }));
  const r2 = await led.reserve(Object.assign({}, base, { quote: q }));
  assert.equal(r2.duplicate, true);
  assert.equal(r2.attemptId, r1.attemptId);
  await led.markUnknown(r1.attemptId);
  // unknown 不得静默释放：release 必须显式 verifiedNotExecuted，否则拒绝。
  await assert.rejects(() => led.release(r1.attemptId), (e) => e.code === LEDGER_ERROR.BAD_REQUEST);
  const before = led.usage({ requestId: 'req-dup', taskRef: 'task-1' });
  assert.ok(before.requestMicro > 0, 'unknown 继续占额度，不填 0');
  const reopened = openLedger({ dir });
  const after = reopened.usage({ requestId: 'req-dup', taskRef: 'task-1' });
  assert.equal(after.requestMicro, before.requestMicro, '重启不得把已发/未知请求释放');
  assert.equal(after.currency, 'USD');
});

// —— 延时边界：Retry-After 与剩余预算的边界必须精确 ——
test('N02 429 deadline 边界：等得起/等不起按安全余量精确分界', () => {
  // 实现刻意保留 RETRY_WAIT_MARGIN_MS 安全余量：剩余预算 1000ms 时不允许等满 1000ms。
  assert.equal(retryWaitFits(900, 1000), true);
  assert.equal(retryWaitFits(1000, 1000), false, '等满剩余预算不留余量 → 拒绝');
  assert.equal(retryWaitFits(1001, 1000), false);
  assert.equal(retryWaitFits(0, 0), true);
  assert.equal(retryWaitFits(10, 0), false);
});

// —— 跨身份域零命中：官方订阅候选不得因便宜进入第三方通用池 ——
test('N02 跨域零命中：官方候选不进入通用池，第三人候选不受影响', () => {
  const official = cand({ model: 'mg/official', provider: 'openai', identity: ev({ kind: 'official_subscription', name: 'gpt' }) });
  const d = decide(REQ, [official], null, null, { limits: { requestUsd: 1 }, spent: { requestUsd: 0 }, enforceUnknownCost: true });
  assert.equal(d.action, ACTION.STOP);
  assert.ok(reasonsOf(d, 'mg/official').includes(EXCLUDE.OFFICIAL));
});
