// MG-001 来源策略回归：同源面板、无 Origin 的 CLI、跨源网页、Host/DNS 重绑定、匿名远程写入。
// 契约见 docs/reference/configuration.md「管理面来源策略」与 docs/contracts/management-api-v1.md。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { networkInterfaces } from 'node:os'
import { startGateway, startMockUpstream } from './harness.mjs'

function lanIPv4() {
  for (const list of Object.values(networkInterfaces())) for (const n of list || []) {
    if (n && n.family === 'IPv4' && !n.internal && !n.address.startsWith('169.254.')) return n.address
  }
  return null
}

// 需要自定义 Host 头时只能走原生 http（fetch 禁止设置 Host）
function raw(url, { method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
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
  assert.equal((await gw.post('/api/config/save', { defaults: { proxyMode: 'direct' } })).status, 200)
  // 同源浏览器面板：放行
  assert.equal((await gw.post('/api/config/save', {}, Object.assign({ origin }, json))).status, 200)
  // 跨源网页：拒绝（写与读都拦）
  const cross = await gw.post('/api/config/save', {}, Object.assign({ origin: 'http://evil.example' }, json))
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
  assert.equal((await gw.post('/api/config/save', {}, Object.assign({ origin: 'http://panel.lan' }, json))).status, 200)
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

test('MG-001 非回环绑定：匿名远程管理写与读被拒，配好令牌后可用，数据面保持开放', { timeout: 40000 }, async (t) => {
  const lan = lanIPv4()
  if (!lan) { t.diagnostic('本机无可用非回环 IPv4，跳过远程对端断言'); return }
  const upstream = await startMockUpstream()
  // 无令牌：远程只能读健康检查，管理面一律 403
  const anon = await startGateway({
    name: 'origin-remote-anon',
    config: {
      server: { host: '0.0.0.0' },
      providers: { mock: { baseUrl: upstream.base } },
      models: { demo: { provider: 'mock', api: 'openai', forceNoStream: true } },
    },
  })
  t.after(async () => { await anon.stop() })
  const remote = 'http://' + lan + ':' + anon.port
  assert.equal((await fetch(remote + '/healthz')).status, 200)
  const remoteStatus = await fetch(remote + '/api/status')
  assert.equal(remoteStatus.status, 403)
  assert.match((await remoteStatus.json()).error, /远程管理请求/)
  assert.equal((await fetch(remote + '/api/config/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403)
  assert.equal((await fetch(remote + '/api/admin-token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'remote-set' }) })).status, 403)
  // 本机访问同一实例仍然开放（本地初始化语义保留）
  assert.equal((await anon.get('/api/status')).status, 200)
  // 数据面不被来源策略削弱
  assert.equal((await fetch(remote + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'demo', messages: [{ role: 'user', content: 'hi' }] }) })).status, 200)
  await anon.stop()

  // 有令牌：远程带凭据可用，缺凭据 401
  const withToken = await startGateway({
    name: 'origin-remote-token',
    env: { MG_ADMIN_TOKEN: 'remote-admin' },
    config: {
      server: { host: '0.0.0.0' },
      providers: { mock: { baseUrl: upstream.base } },
      models: { demo: { provider: 'mock', api: 'openai', forceNoStream: true } },
    },
  })
  t.after(async () => { await withToken.stop(); await upstream.stop() })
  const remote2 = 'http://' + lan + ':' + withToken.port
  assert.equal((await fetch(remote2 + '/api/status')).status, 401)
  assert.equal((await fetch(remote2 + '/api/status', { headers: { authorization: 'Bearer remote-admin' } })).status, 200)
  assert.equal((await fetch(remote2 + '/api/config/save', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer remote-admin' }, body: '{}' })).status, 200)
})
