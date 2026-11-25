import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { keysDecrypt } from '../../../src/router.js'
import { planConnection, selectConnection } from '../../../src/resources/connections.js'
import { startGateway, startMockUpstream } from './harness.mjs'

async function preview(gw, body) { const response = await gw.post('/api/config/preview', body); assert.equal(response.status, 200, JSON.stringify(await response.clone().json())); return response.json() }
async function apply(gw, method, path, plan) { const response = await gw.call(path, { method, body: { expectedVersion: plan.expectedVersion, requestId: plan.requestId, previewId: plan.previewId, confirmToken: plan.confirmToken } }); assert.equal(response.status, 200, JSON.stringify(await response.clone().json())); return response.json() }

test('连接资源：稳定 ID、最后连接保护、冷却过滤与轮询', () => {
  const cfg = { configVersion: 0, providers: { mock: {} }, models: {}, _keys: {} }
  const created = planConnection(cfg, { action: 'connection.create', expectedVersion: 0, requestId: 'c1', providerId: 'mock', patch: { displayName: 'A' } })
  assert.equal(created.status, 200)
  const id = created.plan.connectionId
  assert.match(id, /^conn_/)
  const withId = { ...cfg, providers: created.plan.payload.providers, _keys: { [id]: 'a' } }
  const second = planConnection(withId, { action: 'connection.create', expectedVersion: 0, requestId: 'c2', providerId: 'mock', patch: { displayName: 'B' } })
  const both = { ...withId, providers: second.plan.payload.providers, _keys: { ...withId._keys, [second.plan.connectionId]: 'b' } }
  const removed = planConnection(both, { action: 'connection.delete', expectedVersion: 0, requestId: 'd', providerId: 'mock', connectionId: id, credentialAction: 'delete' })
  assert.equal(removed.status, 200)
  const remaining = { ...both, providers: removed.plan.payload.providers }
  assert.equal(planConnection(remaining, { action: 'connection.delete', expectedVersion: 0, requestId: 'd2', providerId: 'mock', connectionId: second.plan.connectionId, credentialAction: 'delete' }).status, 422)
  const state = { connectionHealth: { ['mock:' + id]: { openUntil: 9999 } }, connectionCursors: {} }
  assert.equal(selectConnection(state, both, 'mock', 1000).connection.connectionId, second.plan.connectionId)
  state.connectionCursors = {}
  assert.equal(selectConnection(state, both, 'mock', 10000).connection.connectionId, id)
})

test('连接运行时：真实 HTTP 多 Key 轮询、停用与同事务删除凭据', { timeout: 30000 }, async (t) => {
  const upstream = await startMockUpstream()
  const gw = await startGateway({ name: 'v13-connections', config: { providers: { mock: { baseUrl: upstream.base } }, models: { demo: { provider: 'mock' } } } })
  t.after(async () => { await gw.stop(); await upstream.stop() })
  let version = (await (await gw.get('/api/status')).json()).configVersion
  const a = await apply(gw, 'POST', '/api/connections', await preview(gw, { action: 'connection.create', expectedVersion: version, requestId: 'ca', providerId: 'mock', patch: { displayName: 'A', priority: 0 } }))
  assert.ok(a.item, JSON.stringify(a))
  version = a.configVersion
  const b = await apply(gw, 'POST', '/api/connections', await preview(gw, { action: 'connection.create', expectedVersion: version, requestId: 'cb', providerId: 'mock', patch: { displayName: 'B', priority: 0 } }))
  version = b.configVersion
  assert.equal((await gw.write('/api/keys', { id: a.item.connectionId, key: 'key-a', version })).status, 200)
  version = (await (await gw.get('/api/status')).json()).configVersion
  assert.equal((await gw.write('/api/keys', { id: b.item.connectionId, key: 'key-b', version })).status, 200)
  for (let i = 0; i < 2; i++) {
    const response = await gw.post('/v1/chat/completions', { model: 'demo', messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(response.status, 200, await response.text())
  }
  assert.deepEqual(upstream.hits.slice(-2).map((hit) => hit.headers.authorization), ['Bearer key-a', 'Bearer key-b'])

  version = (await (await gw.get('/api/status')).json()).configVersion
  const disabled = await apply(gw, 'PATCH', '/api/connections/' + a.item.connectionId, await preview(gw, { action: 'connection.update', expectedVersion: version, requestId: 'disable-a', providerId: 'mock', connectionId: a.item.connectionId, patch: { enabled: false } }))
  assert.equal(disabled.item.enabled, false)
  assert.equal((await gw.post('/v1/chat/completions', { model: 'demo', messages: [] })).status, 200)
  assert.equal(upstream.hits.at(-1).headers.authorization, 'Bearer key-b')

  version = (await (await gw.get('/api/status')).json()).configVersion
  const enabled = await apply(gw, 'PATCH', '/api/connections/' + a.item.connectionId, await preview(gw, { action: 'connection.update', expectedVersion: version, requestId: 'enable-a', providerId: 'mock', connectionId: a.item.connectionId, patch: { enabled: true } }))
  version = enabled.configVersion
  const deleted = await apply(gw, 'DELETE', '/api/connections/' + b.item.connectionId, await preview(gw, { action: 'connection.delete', expectedVersion: version, requestId: 'delete-b', providerId: 'mock', connectionId: b.item.connectionId, credentialAction: 'delete' }))
  assert.equal(deleted.item, null)
  const previousMaster = process.env.MG_KEYS_MASTER; process.env.MG_KEYS_MASTER = 'isolated-test-master'
  try { assert.equal(keysDecrypt(readFileSync(join(gw.dir, 'keys.local.json'), 'utf8'))[b.item.connectionId], undefined) } finally { if (previousMaster === undefined) delete process.env.MG_KEYS_MASTER; else process.env.MG_KEYS_MASTER = previousMaster }
})
