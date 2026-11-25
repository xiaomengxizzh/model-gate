import test from 'node:test'
import assert from 'node:assert/strict'
import { effectivePolicy, planPolicy } from '../../../src/resources/policies.js'
import { startGateway } from './harness.mjs'

test('有效策略：全局→Harness→池取最严预算并保留硬约束', () => {
  const cfg = { defaults: { requestBudget: { maxTotalAttempts: 24, maxWaitMs: 30000 }, retry: { maxAttempts: 3 } }, policies: { 'harness:codex': { revision: 1, overrides: { requestBudget: { maxTotalAttempts: 8, maxWaitMs: 10000 } } }, 'pool:daily': { revision: 2, overrides: { requestBudget: { maxTotalAttempts: 4 } } } } }
  const out = effectivePolicy(cfg, { harnessId: 'codex', poolId: 'daily' })
  assert.equal(out.effective.requestBudget.maxTotalAttempts, 4)
  assert.equal(out.effective.requestBudget.maxWaitMs, 10000)
  assert.equal(out.sources.length, 3)
  assert.equal(out.effective.hardConstraints.routeModeGptOutbound, 0)
})

test('策略真实 HTTP：预览→确认→生效查询→旧配置保留', { timeout: 20000 }, async (t) => {
  const gw = await startGateway({ name: 'v13-policy', config: { defaults: { retry: { maxAttempts: 2 }, custom: { keep: true } } } })
  t.after(() => gw.stop())
  const version = (await (await gw.get('/api/status')).json()).configVersion
  const preview = await gw.post('/api/config/preview', { action: 'policy.update', expectedVersion: version, requestId: 'p1', scopeType: 'global', overrides: { requestBudget: { maxTotalAttempts: 7, maxWaitMs: 1234 } } })
  assert.equal(preview.status, 200, JSON.stringify(await preview.clone().json()))
  const plan = await preview.json()
  const applied = await gw.post('/api/policies', { expectedVersion: version, requestId: 'p1', previewId: plan.previewId, confirmToken: plan.confirmToken })
  assert.equal(applied.status, 200, JSON.stringify(await applied.clone().json()))
  const effective = await (await gw.get('/api/policies/effective?harnessId=codex')).json()
  assert.equal(effective.effective.requestBudget.maxTotalAttempts, 7)
  assert.equal(effective.effective.requestBudget.maxWaitMs, 1234)
  assert.equal((await (await gw.get('/api/config')).json()).defaults.custom.keep, true)
})
