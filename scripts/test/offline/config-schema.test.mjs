// MG-003 配置结构契约：形状/保留键/版本冲突/删除墓碑。
// 契约见 docs/contracts/management-api-v1.md「保存语义」与「已知偏离」。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startGateway, startMockUpstream } from './harness.mjs'

const json = (extra) => Object.assign({ 'content-type': 'application/json' }, extra)
const bodyOf = (s) => s

test('MG-003 形状与保留键：非法输入返回 400 且不写盘、不改内存', { timeout: 30000 }, async (t) => {
  const upstream = await startMockUpstream()
  const gw = await startGateway({
    name: 'schema-shape',
    config: {
      providers: { p1: { baseUrl: upstream.base } },
      models: { m1: { provider: 'p1' } },
    },
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const before = await (await gw.get('/api/status')).json()
  const localBefore = await readFile(join(gw.dir, 'gateway.local.json'), 'utf8').catch(() => '')

  const bad = [
    ['数组请求体', '[]'],
    ['null 请求体', 'null'],
    ['字符串请求体', '"x"'],
    ['providers 为数组', JSON.stringify({ providers: [] })],
    ['models 为字符串', JSON.stringify({ models: 'x' })],
    ['defaults 为数组', JSON.stringify({ defaults: [] })],
    ['virtualModels 为对象', JSON.stringify({ virtualModels: {} })],
    ['version 非数字', JSON.stringify({ version: 'abc' })],
    ['providers 含保留键 __proto__', '{"providers":{"__proto__":{"baseUrl":"http://evil.example"}}}'],
    ['models 含保留键 constructor', JSON.stringify({ models: { constructor: { provider: 'p1' } } })],
    ['providerModels 含保留键', '{"models":{"m1":{"provider":"p1","providerModels":{"__proto__":"x"}}}}'],
    ['虚拟模型名重复', JSON.stringify({ virtualModels: [{ name: 'v', directory: [{ model: 'm1' }] }, { name: 'v', directory: [{ model: 'm1' }] }] })],
    ['虚拟模型目录为空', JSON.stringify({ virtualModels: [{ name: 'v2', directory: [] }] })],
  ]
  for (const [label, rawOrBody] of bad) {
    const r = await gw.post('/api/config/save', rawOrBody, json())
    assert.equal(r.status, 400, label + ' 应返回 400')
    const body = await r.json()
    assert.equal(typeof body.error, 'string', label + ' 应带错误说明')
  }

  // 未写盘、未改内存、未污染原型
  const after = await (await gw.get('/api/status')).json()
  assert.equal(after.configVersion, before.configVersion)
  const localAfter = await readFile(join(gw.dir, 'gateway.local.json'), 'utf8').catch(() => '')
  assert.equal(localAfter, localBefore)
  assert.equal({}.baseUrl, undefined)
  assert.equal(Object.prototype.baseUrl, undefined)
})

test('MG-003 并发保存：同一 version 只有一个成功，另一个 409', { timeout: 30000 }, async (t) => {
  const gw = await startGateway({ name: 'schema-version' })
  t.after(() => gw.stop())
  const v = (await (await gw.get('/api/status')).json()).configVersion
  const results = await Promise.all([
    gw.post('/api/config/save', { version: v, defaults: { proxyMode: 'direct' } }, json()),
    gw.post('/api/config/save', { version: v, defaults: { proxyMode: 'direct' } }, json()),
  ])
  const codes = results.map((r) => r.status).sort((a, b) => a - b)
  assert.deepEqual(codes, [200, 409])
  const conflict = results.find((r) => r.status === 409)
  assert.equal(typeof (await conflict.json()).currentVersion, 'number')
})

test('MG-003 删除语义：删除的上游/模型重启后不复活，重新加回则恢复', { timeout: 45000 }, async (t) => {
  const upstream = await startMockUpstream()
  const dir = await mkdtemp(join(tmpdir(), 'modelgate-schema-dir-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const config = {
    providers: { p1: { baseUrl: upstream.base }, p2: { baseUrl: upstream.base } },
    models: { m1: { provider: 'p1' }, m2: { provider: 'p2' } },
  }
  let gw = await startGateway({ name: 'schema-del', dir, config })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  // 删除 m2（保留 m1）
  assert.equal((await gw.post('/api/config/save', { models: { m1: { provider: 'p1' } } }, json())).status, 200)
  let st = await (await gw.get('/api/status')).json()
  assert.deepEqual(st.models.map((m) => m.name), ['m1'])

  // 重启：local 是合并补丁，若无墓碑 m2 会从 gateway.json 复活
  await gw.stop()
  gw = await startGateway({ name: 'schema-del', dir })
  st = await (await gw.get('/api/status')).json()
  assert.deepEqual(st.models.map((m) => m.name), ['m1'], '删除的模型重启后不应复活')
  assert.deepEqual(st.providers.map((p) => p.id).sort(), ['p1', 'p2'])

  // 重新加回 m2：墓碑撤销，重启后仍在
  assert.equal((await gw.post('/api/config/save', { models: { m1: { provider: 'p1' }, m2: { provider: 'p2' } } }, json())).status, 200)
  await gw.stop()
  gw = await startGateway({ name: 'schema-del', dir })
  st = await (await gw.get('/api/status')).json()
  assert.deepEqual(st.models.map((m) => m.name).sort(), ['m1', 'm2'])

  // 删除上游 p2（m2 引用它，需同时删除 m2）
  assert.equal((await gw.post('/api/config/save', { providers: { p1: { baseUrl: upstream.base } }, models: { m1: { provider: 'p1' } } }, json())).status, 200)
  await gw.stop()
  gw = await startGateway({ name: 'schema-del', dir })
  st = await (await gw.get('/api/status')).json()
  assert.deepEqual(st.providers.map((p) => p.id), ['p1'])
})

test('MG-003 keys 标识：保留键与空 id 被拒', { timeout: 25000 }, async (t) => {
  const gw = await startGateway({ name: 'schema-keys' })
  t.after(() => gw.stop())
  assert.equal((await gw.post('/api/keys', { id: '   ', key: 'k' })).status, 400)
  assert.equal((await gw.post('/api/keys', { id: '__proto__', key: 'k' })).status, 400)
  assert.equal((await gw.post('/api/keys', { id: 'constructor', key: 'k' })).status, 400)
  assert.equal((await gw.post('/api/keys', { id: 'p1', key: 'k' })).status, 200)
})
