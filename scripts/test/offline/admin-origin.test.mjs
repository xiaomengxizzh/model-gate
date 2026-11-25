// MG-001 来源策略回归：同源面板、无 Origin 的 CLI、跨源网页、Host/DNS 重绑定、匿名远程写入。
// 契约见 docs/reference/configuration.md「管理面来源策略」与 docs/contracts/management-api-v1.md。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { startGateway, startMockUpstream } from './harness.mjs'

// 需要自定义 Host 头/源地址时只能走原生 http（fetch 禁止设置 Host，也不能指定 localAddress）
async function rawConfirmedWrite(base, payload, options) {
  const headers = { 'content-type': 'application/json' }
  const current = JSON.parse((await raw(base + '/api/status', { ...options, headers })).body)
  const requestId = 'remote-preview-' + Math.random().toString(36).slice(2)
  const previewResponse = await raw(base + '/api/config/write:preview', { ...options, method: 'POST', headers, body: JSON.stringify({ ...payload, action: 'config.save', expectedVersion: current.configVersion, requestId }) })
  const plan = JSON.parse(previewResponse.body)
  if (previewResponse.status !== 200) return previewResponse
  return raw(base + '/api/config/save', { ...options, method: 'POST', headers, body: JSON.stringify({ ...payload, expectedVersion: plan.expectedVersion, requestId, previewId: plan.previewId, confirmToken: plan.confirmToken }) })
}
function raw(url, { method = 'GET', headers = {}, body = '', localAddress } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers, localAddress }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => resolve({ status: res.statusCode, body: data }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

test('MG-001 回环实例：同源放行、跨源与坏 Host 拒绝、CLI 无 Origin 放行', { timeout: 30000 }, async (t) => {
  const gw = await startGateway({ name: 'origin-loopback' })
  t.after(() => gw.stop())
  const origin = gw.base
  const json = { 'content-type': 'application/json' }

  // 无 Origin 的 CLI 客户端：放行
  assert.equal((await gw.write('/api/config/save', { defaults: { proxyMode: 'direct' } })).status, 200)
  // 同源浏览器面板：放行
  assert.equal((await gw.write('/api/config/save', {}, Object.assign({ origin }, json))).status, 200)
  // 跨源网页：拒绝（写与读都拦）
  const cross = await gw.write('/api/config/save', {}, Object.assign({ origin: 'http://evil.example' }, json))
  assert.equal(cross.status, 403)
  assert.match((await cross.json()).error, /跨源/)
  assert.equal((await gw.get('/api/status', { origin: 'http://evil.example' })).status, 403)
  // Origin: null（sandbox iframe / file://）同样拒绝
  assert.equal((await gw.get('/api/status', { origin: 'null' })).status, 403)
  // Host 非 IP 字面量且未列入白名单：DNS 重绑定防护拒绝
  const rebind = await raw(gw.base + '/api/status', { headers: { host: 'attacker.example' } })
  assert.equal(rebind.status, 403)
  assert.match(rebind.body, /Host/)
  // 正常 Host（IP 字面量）仍然放行
  assert.equal((await raw(gw.base + '/api/status', { headers: { host: '127.0.0.1:' + gw.port } })).status, 200)
})

test('MG-001 显式白名单：allowedHosts / allowedOrigins 是唯一放行入口', { timeout: 30000 }, async (t) => {
  const gw = await startGateway({
    name: 'origin-allowlist',
    config: { server: { allowedHosts: ['panel.lan'], allowedOrigins: ['http://panel.lan'] } },
  })
  t.after(() => gw.stop())
  const json = { 'content-type': 'application/json' }
  assert.equal((await raw(gw.base + '/api/status', { headers: { host: 'panel.lan' } })).status, 200)
  assert.equal((await gw.write('/api/config/save', {}, Object.assign({ origin: 'http://panel.lan' }, json))).status, 200)
  // 白名单之外依旧拒绝
  assert.equal((await raw(gw.base + '/api/status', { headers: { host: 'other.lan' } })).status, 403)
  assert.equal((await gw.get('/api/status', { origin: 'https://panel.lan' })).status, 403)
})

test('MG-001 数据面：跨源网页不能借网关凭据发请求，非浏览器调用不受影响', { timeout: 30000 }, async (t) => {
  const upstream = await startMockUpstream()
  const gw = await startGateway({
    name: 'origin-data',
    config: {
      providers: { mock: { baseUrl: upstream.base } },
      models: { demo: { provider: 'mock', api: 'openai', forceNoStream: true } },
    },
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })
  const json = { 'content-type': 'application/json' }
  const chat = { model: 'demo', messages: [{ role: 'user', content: 'hi' }] }
  assert.equal((await gw.post('/v1/chat/completions', chat, json)).status, 200)
  assert.equal((await gw.post('/v1/chat/completions', chat, Object.assign({ origin: gw.base }, json))).status, 200)
  const blocked = await gw.post('/v1/chat/completions', chat, Object.assign({ origin: 'http://evil.example' }, json))
  assert.equal(blocked.status, 403)
  const blockedBody = await blocked.json()
  assert.equal(blockedBody.error.type, 'forbidden')
  assert.match(blockedBody.error.message, /跨源/)
})

test('MG-001 远程对端：无令牌下远程管理一律 403；allowRemote 才放行；数据面保持开放', { timeout: 40000 }, async (t) => {
  // 网关只绑 127.0.0.1，绝不对全网卡监听（默认套件不得暴露 LAN 端口）。
  // 用 127.0.0.2 作为客户端源地址模拟"非回环对端"：网关的 isLoopbackPeer 只认 127.0.0.1/::1。
  const REMOTE_SRC = '127.0.0.2'
  const upstream = await startMockUpstream()
  // 管理面无令牌：远程只能读健康检查，管理面一律 403（新的安全下界）
  const anon = await startGateway({
    name: 'origin-remote-anon',
    config: {
      providers: { mock: { baseUrl: upstream.base } },
      models: { demo: { provider: 'mock', api: 'openai', forceNoStream: true } },
    },
  })
  t.after(async () => { await anon.stop(); await upstream.stop() })
  assert.equal((await raw(anon.base + '/healthz', { localAddress: REMOTE_SRC })).status, 200)
  const remoteStatus = await raw(anon.base + '/api/status', { localAddress: REMOTE_SRC })
  assert.equal(remoteStatus.status, 403)
  assert.match(remoteStatus.body, /远程管理请求/)
  assert.equal((await raw(anon.base + '/api/config/save', { localAddress: REMOTE_SRC, method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403)
  assert.equal((await raw(anon.base + '/api/codex/policy', { localAddress: REMOTE_SRC })).status, 403)
  assert.equal((await raw(anon.base + '/api/admin-token', { localAddress: REMOTE_SRC, method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404, '管理令牌端点已删除')
  // 本机访问同一实例仍然开放
  assert.equal((await anon.get('/api/status')).status, 200)
  // 数据面不被来源策略削弱
  assert.equal((await raw(anon.base + '/v1/chat/completions', { localAddress: REMOTE_SRC, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'demo', messages: [{ role: 'user', content: 'hi' }] }) })).status, 200)

  // 显式 allowRemote：远程无令牌也可用（管理面无令牌下的显式放宽）
  const allowed = await startGateway({
    name: 'origin-remote-allowed',
    env: { MG_ADMIN_ALLOW_REMOTE: '1' },
    config: {
      providers: { mock: { baseUrl: upstream.base } },
      models: { demo: { provider: 'mock', api: 'openai', forceNoStream: true } },
    },
  })
  t.after(async () => { await allowed.stop() })
  assert.equal((await raw(allowed.base + '/api/status', { localAddress: REMOTE_SRC })).status, 200)
  assert.equal((await rawConfirmedWrite(allowed.base, {}, { localAddress: REMOTE_SRC })).status, 200)
})
