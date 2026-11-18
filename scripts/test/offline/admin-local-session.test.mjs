// 管理令牌删除后的回归（2026-11-18 所有者授权安全降级）。
// 原「本机管理会话令牌」功能已整体移除：端点只作空操作，不签发任何令牌。
import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway } from './harness.mjs'

test('POST /api/admin/unlock 是空操作：needAuth:false / deprecated:true，不签发令牌', { timeout: 30000 }, async (t) => {
  const gw = await startGateway({ name: 'no-token-unlock' })
  t.after(() => gw.stop())

  const res = await gw.post('/api/admin/unlock', {})
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.deepEqual(body, { ok: true, needAuth: false, deprecated: true })
  assert.equal('token' in body, false, '响应不得含任何令牌字段')
  assert.equal('expiresAt' in body, false)
  assert.equal('scope' in body, false)

  // 即使环境变量残留旧令牌，也不影响（代码不再读取）。
  const withEnv = await startGateway({ name: 'no-token-unlock-env', env: { MG_ADMIN_TOKEN: 'ignored-fixture' } })
  t.after(() => withEnv.stop())
  const envRes = await withEnv.post('/api/admin/unlock', {})
  assert.deepEqual(await envRes.json(), { ok: true, needAuth: false, deprecated: true })
  assert.equal((await (await withEnv.get('/api/auth')).json()).needAuth, false)
})

test('无会话令牌概念：管理面读写在回环直接可用，非回环仍被拒', { timeout: 30000 }, async (t) => {
  const gw = await startGateway({ name: 'no-token-boundary' })
  t.after(() => gw.stop())
  assert.equal((await gw.get('/api/aggregation/modes')).status, 200)
  assert.equal((await gw.get('/api/codex/policy')).status, 200)
  assert.equal((await gw.get('/api/auth')).status, 200)
})
