// 简约演示预览服务器：静态白名单、CSP、fixture 代理与路径穿越拒绝。
// 不依赖运行中的 8787，不启动真实网关。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { root } from './harness.mjs'

async function reservePort () {
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise((r) => server.close(r))
  return port
}

function raw (port, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('ui-demo preview: static whitelist + fixture + traversal guard', { timeout: 15000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mg-ui-demo-preview-'))
  const fixturePath = join(dir, 'fixture.json')
  await writeFile(fixturePath, JSON.stringify({
    '/api/status': {
      needAuth: false, configVersion: 7, startedAt: 1, uptimeMs: 1000,
      counters: { requests: 1, errors: 0, retries: 0, interrupts: 0 },
      global: { requests: 1, errors: 0, tokenCount: 10, todayTokens: 10, p50: 1, p95: 1 },
      providers: [], models: [], virtualModels: [], dialogues: [], lastServing: null,
      server: { host: '127.0.0.1', port: 1 },
    },
  }))
  const port = await reservePort()
  const child = spawn(process.execPath, ['scripts/ui-demo-preview.mjs', '--port', String(port), '--fixture', fixturePath], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (b) => { stderr += String(b) })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await new Promise((r) => { if (child.exitCode !== null || child.signalCode !== null) r(); else child.once('exit', r) })
    await rm(dir, { recursive: true, force: true })
  })

  const deadline = Date.now() + 5000
  let up = false
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('preview exited: ' + stderr)
    try { const r = await raw(port, '/'); if (r.status === 200) { up = true; break } } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 50))
  }
  assert.ok(up, 'preview 应在 5s 内就绪：' + stderr)

  const page = await raw(port, '/')
  assert.equal(page.status, 200)
  assert.match(page.body, /网关总览/)
  assert.match(String(page.headers['content-security-policy']), /default-src 'none'/)
  assert.equal(page.headers['x-content-type-options'], 'nosniff')

  const css = await raw(port, '/styles.css')
  assert.equal(css.status, 200)
  assert.match(String(css.headers['content-type']), /text\/css/)

  const status = await raw(port, '/api/status')
  assert.equal(status.status, 200)
  assert.equal(JSON.parse(status.body).configVersion, 7, 'fixture 命中 /api/status')

  const missing = await raw(port, '/api/model-stats?days=1')
  assert.equal(missing.status, 404, 'fixture 未提供的 API 明确 404，不回落真实网关')

  const traversal = await raw(port, '/%2e%2e/package.json')
  assert.equal(traversal.status, 404, '编码穿越必须拒绝')
  const hidden = await raw(port, '/.preview/secret.json')
  assert.equal(hidden.status, 404, '隐藏路径必须拒绝')
  const post = await raw(port, '/', 'POST')
  assert.equal(post.status, 405, '静态层只接受 GET/HEAD')
})