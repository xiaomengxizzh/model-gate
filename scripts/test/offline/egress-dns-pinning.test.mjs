import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  forward, forwardOnce, probe, probeChat, probeEmbedding, probeModel, probeRerank, warm,
} from '../../../src/request.js'
import { pinnedLookup, validateEndpointNetwork, validateProxyNetwork } from '../../../src/resources/network-policy.js'
import { startGateway, startScriptedUpstream } from './harness.mjs'

const LOCAL = '127.0.0.1'
const PUBLIC = '192.0.2.10'
const lookupLocal = async () => [{ address: LOCAL, family: 4 }]
const chatOk = () => JSON.stringify({
  id: 'pinned-mock', object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
})

async function listen(server, host = LOCAL) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, resolve)
  })
  return server.address().port
}

async function close(server) {
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
}

async function drain(result) {
  const chunks = []
  for await (const chunk of result.stream) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function providerFor(baseUrl, extra = {}) {
  return { id: 'egress-fixture', api: 'openai', baseUrl, ...extra }
}

let tlsDir
let tlsKey
let tlsCert

before(() => {
  tlsDir = mkdtempSync(join(tmpdir(), 'mg-egress-tls-'))
  const key = join(tlsDir, 'key.pem')
  const cert = join(tlsDir, 'cert.pem')
  const generated = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1',
    '-subj', '/CN=upstream.test', '-addext', 'subjectAltName=DNS:upstream.test',
  ], { encoding: 'utf8', timeout: 15000 })
  assert.equal(generated.status, 0, generated.stderr || 'openssl fixture generation failed')
  tlsKey = readFileSync(key)
  tlsCert = readFileSync(cert)
})

after(() => {
  if (tlsDir) rmSync(tlsDir, { recursive: true, force: true })
})

test('网络策略：代理 URL 认证、私网拒绝与 socket lookup 固定', async () => {
  const proxy = await validateProxyNetwork('http://user:p%40ss@proxy.example.test:7890', {
    lookup: async () => [{ address: PUBLIC, family: 4 }],
  })
  assert.equal(proxy.error, undefined)
  assert.equal(proxy.host, 'proxy.example.test')
  assert.equal(proxy.port, 7890)
  assert.equal(proxy.auth, 'Basic ' + Buffer.from('user:p@ss').toString('base64'))
  assert.equal(proxy.value.includes('user'), false)
  const explicitDefaultPort = await validateProxyNetwork('http://proxy.example.test:80', {
    lookup: async () => [{ address: PUBLIC, family: 4 }],
  })
  assert.equal(explicitDefaultPort.port, 80, 'an explicit :80 must not become the historical fallback port')

  const lookup = proxy.lookup
  const all = []
  await new Promise((resolve, reject) => lookup('proxy.example.test', { all: true }, (err, answers) => err ? reject(err) : (all.push(...answers), resolve())))
  assert.deepEqual(all, [{ address: PUBLIC, family: 4 }])
  await assert.rejects(new Promise((resolve, reject) => lookup('other.example.test', {}, (err) => err ? reject(err) : resolve())), { code: 'ENOTFOUND' })

  const privateProxy = await validateProxyNetwork(`http://${LOCAL}:7890`, { lookup: lookupLocal })
  assert.equal(privateProxy.code, 'private_address')
  assert.equal((await validateProxyNetwork(`http://${LOCAL}:7890`, { lookup: lookupLocal, allowPrivateNetwork: true })).error, undefined)

  for (const raw of [
    'https://proxy.example.test', 'socks5://proxy.example.test', 'ftp://proxy.example.test',
    'http://proxy.example.test/path', 'http://proxy.example.test?q=1', 'http://proxy.example.test/#x',
    'http://proxy.example.test:0', 'http://proxy.example.test:', 'http://proxy.example.test:65536',
    'http://proxy.example.test?', 'http://proxy.example.test#', 'http://proxy.example.test\\@evil.test',
    'http://user:%ZZ@proxy.example.test', 'http://:secret@proxy.example.test', 'http://proxy.example.test\n',
  ]) {
    const result = await validateProxyNetwork(raw, { lookup: () => assert.fail('invalid proxy must not resolve: ' + raw) })
    assert.equal(result.code, 'invalid_proxy', raw)
  }
})

test('真实 HTTP：每次建连只解析一次，socket 使用已验证答案并保留 Host', async () => {
  const hits = []
  const server = http.createServer((req, res) => {
    hits.push({ host: req.headers.host, url: req.url })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(chatOk())
  })
  const port = await listen(server)
  let lookups = 0
  try {
    const provider = providerFor(`http://pinned-${process.pid}.test:${port}`, { allowPrivateNetwork: true })
    const result = await forwardOnce(provider, '/v1/chat/completions', 'GET', {}, null, {}, null, {
      lookup: async () => {
        lookups += 1
        return [{ address: lookups === 1 ? LOCAL : '127.0.0.2', family: 4 }]
      },
    })
    assert.equal(result.status, 200)
    assert.match(await drain(result), /pong/)
    assert.equal(lookups, 1, 'pinned socket must not issue a second rebinding lookup')
    assert.deepEqual(hits, [{ host: `pinned-${process.pid}.test:${port}`, url: '/v1/chat/completions' }])
  } finally { await close(server) }
})

test('真实 HTTP：显式私网策略零发送，旧单用户缺省兼容本地上游', async () => {
  for (const address of [
    '169.254.169.254', '192.0.0.192', '168.63.129.16', 'fd00:ec2::254',
    '64:ff9b:1:7f00:0:1::', '2002:7f00:1::', '2001:0:a00:1:0:ffff:a9fe:a9fe',
  ]) {
    const host = address.includes(':') ? `[${address}]` : address
    assert.equal((await validateEndpointNetwork(`http://${host}`)).code, 'private_address', address)
  }
  let hits = 0
  const server = http.createServer((req, res) => { hits += 1; res.end('ok') })
  const port = await listen(server)
  try {
    for (const allowPrivateNetwork of [false, 'true', 1]) {
      const provider = providerFor(`http://${LOCAL}:${port}`, { allowPrivateNetwork })
      await assert.rejects(forwardOnce(provider, '/v1/test', 'GET', {}, null), { code: 'private_address' })
    }
    const legacy = await forwardOnce(providerFor(`http://${LOCAL}:${port}`), '/v1/test', 'GET', {}, null)
    assert.equal(legacy.status, 200)
    await drain(legacy)
    assert.equal(hits, 1, 'legacy single-user provider retains loopback compatibility')

    const mixed = providerFor(`http://mixed-${process.pid}.test:${port}`, { allowPrivateNetwork: false })
    await assert.rejects(forwardOnce(mixed, '/v1/test', 'GET', {}, null, {}, null, {
      lookup: async () => [{ address: PUBLIC, family: 4 }, { address: '169.254.169.254', family: 4 }],
    }), { code: 'private_address' })
    assert.equal(hits, 1, 'one private answer rejects the whole address set')

    const allowed = await forwardOnce(providerFor(`http://${LOCAL}:${port}`, { allowPrivateNetwork: true }), '/v1/test', 'GET', {}, null)
    assert.equal(allowed.status, 200)
    await drain(allowed)
    assert.equal(hits, 2)
  } finally { await close(server) }
})

test('真实 HTTP：重试逐次重新校验，302 不自动跟随', async () => {
  let hits = 0
  let lookups = 0
  const server = http.createServer((req, res) => {
    hits += 1
    if (hits === 1) { res.writeHead(503); res.end('retry') } else { res.end('ok') }
  })
  const port = await listen(server)
  try {
    const provider = providerFor(`http://retry-${process.pid}.test:${port}`, { allowPrivateNetwork: true })
    const result = await forward(provider, '/v1/test', 'GET', {}, null, {
      retry: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 1, jitter: 0 },
    }, null, { lookup: async () => { lookups += 1; return [{ address: LOCAL, family: 4 }] } })
    assert.equal(result.status, 200)
    await drain(result)
    assert.equal(hits, 2)
    assert.equal(lookups, 2, 'every real attempt revalidates immediately before send')
  } finally { await close(server) }

  let redirectHits = 0
  const target = http.createServer((req, res) => { redirectHits += 1; res.end('must-not-follow') })
  const targetPort = await listen(target)
  const redirector = http.createServer((req, res) => {
    res.writeHead(302, { location: `http://${LOCAL}:${targetPort}/redirected` })
    res.end()
  })
  const redirectPort = await listen(redirector)
  try {
    const result = await forwardOnce(providerFor(`http://${LOCAL}:${redirectPort}`, { allowPrivateNetwork: true }), '/v1/test', 'GET', {}, null)
    assert.equal(result.status, 302)
    await drain(result)
    assert.equal(redirectHits, 0)
  } finally { await close(target); await close(redirector) }
})

test('真实 HTTP：DNS 阶段遵守 AbortSignal，不产生上游连接', async () => {
  const controller = new AbortController()
  let resolved = false
  const pending = forwardOnce(providerFor(`http://abort-${process.pid}.test`), '/v1/test', 'GET', {}, null, {}, null, {
    signal: controller.signal,
    lookup: async () => {
      resolved = true
      return new Promise(() => {})
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(resolved, true)
  controller.abort()
  await assert.rejects(pending, (err) => err.aborted === true && err.code === 'ETIMEDOUT')
})

test('HTTP forward proxy：固定目标 authority，保留 Host 与代理认证', async () => {
  const seen = []
  const proxy = http.createServer((req, res) => {
    seen.push({ url: req.url, host: req.headers.host, auth: req.headers['proxy-authorization'] })
    req.resume()
    res.end('ok')
  })
  const port = await listen(proxy)
  try {
    const provider = providerFor('http://upstream.test:8080', {
      allowPrivateNetwork: true,
      proxy: `http://user:pass@${LOCAL}:${port}`,
    })
    const result = await forwardOnce(provider, '/v1/test?q=1', 'GET', {}, null, {}, null, { lookup: lookupLocal })
    assert.equal(result.status, 200)
    await drain(result)
    assert.deepEqual(seen, [{
      url: `http://${LOCAL}:8080/v1/test?q=1`,
      host: 'upstream.test:8080',
      auth: 'Basic ' + Buffer.from('user:pass').toString('base64'),
    }])
  } finally { await close(proxy) }
})

test('HTTP forward proxy：私网代理与非法协议失败关闭且零连接', async () => {
  let connections = 0
  const proxy = net.createServer((socket) => { connections += 1; socket.destroy() })
  const port = await listen(proxy)
  try {
    await assert.rejects(forwardOnce(providerFor(`http://${PUBLIC}:8080`, { allowPrivateNetwork: false, proxy: `http://${LOCAL}:${port}` }), '/v1/test', 'GET', {}, null), { code: 'private_address' })
    await assert.rejects(forwardOnce(providerFor(`http://${PUBLIC}:8080`, { proxy: 'https://proxy.example.test' }), '/v1/test', 'GET', {}, null), { code: 'invalid_proxy' })
    assert.equal(connections, 0)
  } finally { await close(proxy) }
})

test('CONNECT proxy：目标 IP 固定、SNI/Host 原名保留，挂起隧道可取消', async () => {
  const connects = []
  const sockets = new Set()
  const proxy = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    let data = ''
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8')
      if (!data.includes('\r\n\r\n')) return
      connects.push(data)
      socket.write('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n')
    })
  })
  const port = await listen(proxy)
  const provider = providerFor('https://upstream.test:8443', {
    allowPrivateNetwork: true,
    proxy: `http://user:pass@${LOCAL}:${port}`,
  })
  try {
    await assert.rejects(forwardOnce(provider, '/v1/test', 'GET', {}, null, {}, null, { lookup: lookupLocal }), /proxy CONNECT failed: HTTP\/1\.1 502/)
    assert.match(connects[0], /^CONNECT 127\.0\.0\.1:8443 HTTP\/1\.1/)
    assert.doesNotMatch(connects[0], /CONNECT upstream\.test/)
    assert.match(connects[0], /Proxy-Authorization: Basic /)
  } finally { await close(proxy) }

  let hangClosed = false
  const hanging = net.createServer((socket) => {
    socket.resume()
    socket.on('close', () => { hangClosed = true })
    socket.on('error', () => {})
  })
  const hangPort = await listen(hanging)
  const controller = new AbortController()
  try {
    const pending = forwardOnce(providerFor('https://upstream.test:8443', {
      allowPrivateNetwork: true,
      proxy: `http://${LOCAL}:${hangPort}`,
    }), '/v1/test', 'GET', {}, null, {}, null, { signal: controller.signal, lookup: lookupLocal })
    await new Promise((resolve) => setTimeout(resolve, 20))
    controller.abort()
    await assert.rejects(pending, (err) => err.aborted === true)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(hangClosed, true)
  } finally { await close(hanging) }
})

test('HTTPS 直连：保留原主机名 SNI，TLS 对端为固定地址', async () => {
  let servername = null
  const server = https.createServer({
    key: tlsKey,
    cert: tlsCert,
    SNICallback: (name, callback) => {
      servername = name
      callback(null, tls.createSecureContext({ key: tlsKey, cert: tlsCert }))
    },
  }, (req, res) => res.end('ok'))
  const port = await listen(server)
  let lookups = 0
  try {
    await assert.rejects(forwardOnce(providerFor(`https://sni-${process.pid}.test:${port}`, { allowPrivateNetwork: true }), '/v1/test', 'GET', {}, null, {}, null, {
      lookup: async () => { lookups += 1; return [{ address: LOCAL, family: 4 }] },
    }), (err) => /self-signed|self signed|DEPTH_ZERO_SELF_SIGNED_CERT/i.test(err.message))
    assert.equal(servername, `sni-${process.pid}.test`)
    assert.equal(lookups, 1)
  } finally { await close(server) }
})

test('探测/预热/模型测试同样 fail-closed，显式授权后走固定 transport', async () => {
  let hits = 0
  const server = http.createServer((req, res) => {
    hits += 1
    req.resume()
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
  const port = await listen(server)
  const calls = (provider) => [
    probe(provider), warm(provider, 'm', 'ping'), probeChat(provider, 'm', 'ping'),
    probeModel(provider, 'm'), probeEmbedding(provider, 'm'), probeRerank(provider, 'm'),
  ]
  try {
    const denied = await Promise.all(calls(providerFor(`http://${LOCAL}:${port}`, { allowPrivateNetwork: false })))
    assert.equal(hits, 0)
    for (const result of denied) {
      assert.equal(result.ok, false)
      assert.equal(result.err, 'private_address')
    }
    const allowed = await Promise.all(calls(providerFor(`http://${LOCAL}:${port}`, { allowPrivateNetwork: true })))
    assert.equal(hits, 6)
    for (const result of allowed) assert.equal(result.ok, true)
  } finally { await close(server) }
})

test('生产 Chat 链路：显式策略拒绝回环上游，授权后真实转发成功', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(chatOk())
  })
  t.after(() => upstream.stop())
  const makeConfig = (allowPrivateNetwork) => ({
    defaults: { proxyMode: 'direct', retry: { maxAttempts: 1 }, timeout: { firstByteMs: 2000, idleMs: 2000 } },
    providers: { mock: { baseUrl: upstream.base, allowPrivateNetwork } },
    models: { demo: { provider: 'mock' } },
  })
  const post = (gw) => fetch(gw.base + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'demo', messages: [{ role: 'user', content: 'hi' }] }),
  })
  const denied = await startGateway({ name: 'egress-deny', config: makeConfig(false) })
  t.after(() => denied.stop())
  assert.equal((await post(denied)).status, 502)
  assert.equal(upstream.hits.length, 0)

  const allowed = await startGateway({ name: 'egress-allow', config: makeConfig(true) })
  t.after(() => allowed.stop())
  const response = await post(allowed)
  assert.equal(response.status, 200)
  assert.match(await response.text(), /pong/)
  assert.equal(upstream.hits.length, 1)
})

test('网络策略：AbortSignal 取消 DNS 等待并清理监听器', async () => {
  const controller = new AbortController()
  const pending = validateEndpointNetwork('http://abort-policy.test', {
    signal: controller.signal,
    lookup: () => new Promise(() => {}),
  })
  controller.abort()
  const result = await pending
  assert.equal(result.code, 'aborted')
  assert.equal(result.aborted, true)
  assert.equal((await validateEndpointNetwork('http://[::1]', { allowPrivateNetwork: true })).error, undefined)
})
