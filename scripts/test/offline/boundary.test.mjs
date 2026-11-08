import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))

test('HTTP boundaries, virtual credentials and isolated configuration', { timeout: 20000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'modelgate-boundary-'))
  let seen, hits = 0
  const arrivals = []
  const upstream = http.createServer(async (req, res) => {
    for await (const chunk of req) {} // consume request
    hits++
    arrivals.push(Date.now())
    seen = req.headers
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }))
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  // Reserve a free local port; fail startup if another process claims it.
  const reservation = http.createServer()
  reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening')
  const port = reservation.address().port
  await new Promise(r => reservation.close(r))
  const base = `http://127.0.0.1:${port}`
  const cfg = {
    server: { host: '127.0.0.1', port, maxBodyBytes: 1024, logFile: join(dir, 'test.log') },
    defaults: { provider: 'mock', retry: { maxAttempts: 1 }, timeout: { firstByteMs: 1000, idleMs: 1000 }, proxyMode: 'direct' },
    providers: { mock: { baseUrl: `http://127.0.0.1:${upstream.address().port}` } },
    models: { demo: { provider: 'mock', api: 'openai', providerModels: { mock: 'vendor-demo' }, maxTokensMax: 10, forceNoStream: true } },
    virtualModels: [{ name: 'private', directory: [{ model: 'demo' }] }]
  }
  await writeFile(join(dir, 'gateway.json'), JSON.stringify(cfg))
  const child = spawn(process.execPath, ['src/index.js'], { cwd: root, stdio: 'ignore', env: {
    ...process.env, MG_CONFIG_DIR: dir, MG_CONFIG: join(dir, 'gateway.json'),
    MG_ADMIN_TOKEN: 'test-admin', MG_CLIENT_KEY: '', MG_MAX_BODY: '', MG_KEYS_MASTER: 'isolated-test-master'
  } })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit') }
    upstream.closeAllConnections?.()
    await new Promise(r => upstream.close(r))
    await rm(dir, { recursive: true, force: true })
  })
  let ready = false
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error('isolated gateway exited')
    try { ready = (await fetch(base + '/healthz')).ok } catch {}
    if (ready) break
    await new Promise(r => setTimeout(r, 30))
  }
  assert.ok(ready, 'isolated gateway ready')
  const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) })
  const chat = { model: 'private', messages: [{ role: 'user', content: 'hello' }] }
  const admin = { authorization: 'Bearer test-admin' }
  assert.equal((await fetch(base + '/api/status')).status, 401)
  const status = await (await fetch(base + '/api/status', { headers: admin })).json()
  const model = status.models.find(m => m.name === 'demo')
  assert.equal(model.api, 'openai')
  assert.deepEqual(model.providerModels, { mock: 'vendor-demo' })
  assert.equal(model.maxTokensMax, 10)
  assert.equal(model.forceNoStream, true)

  assert.equal((await post('/api/keys', { id: '__mg_vm_private', key: 'private-key' }, admin)).status, 200)
  for (const headers of [{}, { authorization: 'Bearer wrong-key' }]) {
    const before = hits
    assert.equal((await post('/v1/chat/completions', chat, headers)).status, 401)
    assert.equal(hits, before, 'unauthorized requests never reach upstream')
  }
  assert.equal((await post('/v1/chat/completions', chat, { authorization: 'Bearer private-key' })).status, 200)
  // With no global key, unkeyed real models retain local anonymous access.
  const rawPost = (body, headers) => new Promise((resolve, reject) => {
    const req = http.request(base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, res => {
      res.resume(); res.on('end', () => resolve({ status: res.statusCode }))
    })
    req.on('error', reject); req.end(JSON.stringify(body))
  })
  assert.equal((await rawPost({ ...chat, model: 'demo' }, {
    'x-mg-admin': 'must-not-leak', 'x-goog-api-key': 'must-not-leak', cookie: 'must-not-leak',
    connection: 'keep-alive, x-private-hop', 'x-private-hop': 'must-not-leak'
  })).status, 200)
  for (const key of ['authorization', 'x-mg-admin', 'x-goog-api-key', 'cookie', 'x-private-hop']) assert.equal(seen[key], undefined, key)
  assert.equal(seen.host, `127.0.0.1:${upstream.address().port}`)
  for (const raw of ['{bad', 'null', '[]', '"str"']) {
    assert.equal((await post('/v1/chat/completions', raw)).status, 400)
  }
  for (const path of ['/v1/chat/completions', '/api/config/save']) {
    const r = await post(path, 'x'.repeat(2048), admin)
    assert.equal(r.status, 413)
    assert.equal((await r.json()).error.type, 'payload_too_large')
  }
  assert.equal((await post('/api/config/save', { defaults: { clientKey: 'global-key' } }, admin)).status, 200)
  assert.equal((await post('/v1/chat/completions', { ...chat, model: 'demo' })).status, 401)
  assert.equal((await post('/v1/chat/completions', chat, { authorization: 'Bearer private-key' })).status, 200)
  assert.equal((await post('/v1/chat/completions', chat, { authorization: 'Bearer global-key' })).status, 200)
  assert.equal((await post('/api/config/save', { models: { demo: { provider: 'mock', qps: 5 } } }, admin)).status, 200)
  const beforeBurst = arrivals.length
  const burst = await Promise.all(Array.from({ length: 10 }, () => post('/v1/chat/completions', { ...chat, model: 'demo' }, { authorization: 'Bearer global-key' })))
  assert.ok(burst.every(r => r.status === 200))
  const times = arrivals.slice(beforeBurst)
  assert.equal(times.length, 10)
  assert.ok(times.at(-1) - times[0] >= 750, 'queued QPS reservations are staggered instead of released together')

})
