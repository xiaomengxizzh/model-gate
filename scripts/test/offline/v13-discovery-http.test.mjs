import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, startMockUpstream } from './harness.mjs'
import { discoverConnection } from '../../../src/resources/discovery.js'

test('连接模型发现：真实 HTTP 使用独立 Key 拉取目录且不自动写模型', { timeout: 20000 }, async (t) => {
  const upstream = await startMockUpstream()
  const connectionId = 'conn_1234567890123456'
  const gw = await startGateway({ name: 'v13-discovery', config: { providers: { mock: { baseUrl: upstream.base, allowPrivateNetwork: true, connections: [{ connectionId, credentialKeyId: connectionId, enabled: true }] } }, models: {} } })
  t.after(async () => { await gw.stop(); await upstream.stop() })
  assert.equal((await gw.write('/api/keys', { id: connectionId, key: 'discovery-key' })).status, 200)
  const response = await gw.post('/api/connections/mock/' + connectionId + '/discover', {})
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
  const body = await response.json()
  assert.deepEqual(body.models.map((item) => item.upstreamModelId), ['vendor-model'])
  assert.equal(body.upstreamCalls, 1)
  assert.equal(body.networkPolicy, 'dns-revalidated-pinned')
  assert.equal(upstream.hits[0].headers.authorization, 'Bearer discovery-key')
  assert.equal((await (await gw.get('/api/models')).json()).items.length, 0)
})

function discoveryConfig(baseUrl, allowPrivateNetwork = false) {
  return { providers: { mock: { baseUrl, allowPrivateNetwork } }, models: {}, defaults: {} }
}

function catalogResponse() {
  return { ok: true, status: 200, body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ data: [{ id: 'vendor-model' }] }))); controller.close() } }) }
}

test('连接模型发现：未显式授权私网时零上游调用，DNS 失败同样失败关闭', async () => {
  let calls = 0
  const fetchImpl = async () => { calls++; return catalogResponse() }
  for (const [lookup, code] of [
    [async () => [{ address: '127.0.0.1', family: 4 }], 'private_address'],
    [async () => { throw new Error('DNS failed') }, 'dns_error'],
  ]) {
    await assert.rejects(discoverConnection(discoveryConfig('http://service.example.test'), 'mock', '', { fetchImpl, lookup }), (error) => error.code === code)
  }
  assert.equal(calls, 0)
})

test('连接模型发现：每次尝试重新解析，重绑定在请求前拒绝', async () => {
  let lookups = 0
  let calls = 0
  const opts = {
    lookup: async () => [{ address: ++lookups === 1 ? '192.0.2.10' : '169.254.169.254', family: 4 }],
    requestImpl: async () => { calls++; return catalogResponse() },
  }
  const cfg = discoveryConfig('https://service.example.test/v1')
  const first = await discoverConnection(cfg, 'mock', '', opts)
  assert.equal(first.count, 1)
  await assert.rejects(discoverConnection(cfg, 'mock', '', opts), (error) => error.code === 'private_address')
  assert.equal(lookups, 2)
  assert.equal(calls, 1)
})

test('连接模型发现：原生 HTTP 请求固定到本次验证地址', { timeout: 20000 }, async (t) => {
  const upstream = await startMockUpstream()
  t.after(() => upstream.stop())
  const cfg = discoveryConfig('http://fixture.localhost:' + upstream.port + '/v1', true)
  const result = await discoverConnection(cfg, 'mock', '', { lookup: async () => [{ address: '127.0.0.1', family: 4 }] })
  assert.equal(result.count, 1)
  assert.equal(result.networkPolicy, 'dns-revalidated-pinned')
  assert.equal(upstream.hits.length, 1)
  assert.equal(upstream.hits[0].url, '/v1/models')
})

test('连接模型发现：注入 fetch 明确披露无法固定 socket 的残余 TOCTOU', async () => {
  const result = await discoverConnection(discoveryConfig('https://service.example.test'), 'mock', '', {
    lookup: async () => [{ address: '192.0.2.10', family: 4 }],
    fetchImpl: async () => catalogResponse(),
  })
  assert.equal(result.networkPolicy, 'dns-revalidated-unpinned')
  assert.match(result.note, /TOCTOU/)
})
