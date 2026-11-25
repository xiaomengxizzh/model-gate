import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway } from './harness.mjs'

async function preview(gw, body) { const response = await gw.post('/api/config/preview', body); assert.equal(response.status, 200, JSON.stringify(await response.clone().json())); return response.json() }
async function apply(gw, method, path, plan) { const response = await gw.call(path, { method, body: { expectedVersion: plan.expectedVersion, requestId: plan.requestId, previewId: plan.previewId, confirmToken: plan.confirmToken } }); assert.equal(response.status, 200, JSON.stringify(await response.clone().json())); return response.json() }

test('应用绑定资源：真实 HTTP 创建、查询、删除保护与解除', { timeout: 30000 }, async (t) => {
  const gw = await startGateway({ name: 'v13-bindings', config: { providers: { mock: { baseUrl: 'http://127.0.0.1:1/v1' } }, models: { demo: { provider: 'mock', maxContext: 8192 } } } })
  t.after(() => gw.stop())
  let version = (await (await gw.get('/api/status')).json()).configVersion
  const pool = await apply(gw, 'POST', '/api/pools', await preview(gw, { action: 'pool.create', expectedVersion: version, requestId: 'pool', patch: { name: 'bound-pool', members: [{ model: 'demo' }] } }))
  const poolId = pool.item.poolId
  version = pool.configVersion
  const binding = await apply(gw, 'POST', '/api/harness-bindings', await preview(gw, { action: 'binding.create', expectedVersion: version, requestId: 'binding', patch: { harnessId: 'opencode', instanceId: 'default', mode: 'api', roleTargets: { route: { kind: 'pool', id: poolId } } } }))
  assert.equal(binding.item.verification, 'desired-only')
  assert.equal((await (await gw.get('/api/harness-bindings')).json()).items.length, 1)
  version = binding.configVersion
  const blocked = await gw.post('/api/config/preview', { action: 'pool.delete', expectedVersion: version, requestId: 'delete-pool', poolId })
  assert.equal(blocked.status, 422)
  assert.equal((await blocked.json()).details.harnessBindings.length, 1)
  const removedBinding = await apply(gw, 'DELETE', '/api/harness-bindings/' + binding.item.bindingId, await preview(gw, { action: 'binding.delete', expectedVersion: version, requestId: 'delete-binding', bindingId: binding.item.bindingId }))
  assert.equal(removedBinding.item, null)
  version = removedBinding.configVersion
  const removedPool = await apply(gw, 'DELETE', '/api/pools/' + poolId, await preview(gw, { action: 'pool.delete', expectedVersion: version, requestId: 'delete-pool-2', poolId }))
  assert.equal(removedPool.item, null)
})
