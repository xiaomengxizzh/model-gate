// MG-014 Video 异步任务池：创建/幂等/轮询/取消/持久化/重启恢复/GC/能力隔离/预算。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startGateway, startScriptedUpstream } from './harness.mjs'

const json = () => ({ 'content-type': 'application/json' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8')
  try { return raw ? JSON.parse(raw) : null } catch { return null }
}

function mockVideo() {
  const state = { status: 'running', result: null }
  const upstreamP = startScriptedUpstream(async (req, res, rec) => {
    if (req.method === 'POST' && rec.url === '/v1/videos') {
      rec.body = await readBody(req)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'up_1', status: 'queued' }))
      return
    }
    if (req.method === 'GET' && rec.url === '/v1/videos/up_1') {
      const body = { id: 'up_1', status: state.status }
      if (state.status === 'succeeded' && state.result) body.result = state.result
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
      return
    }
    if (req.method === 'POST' && rec.url === '/v1/videos/up_1/cancel') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'up_1', status: 'canceled' }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}')
  })
  return { state, upstreamP }
}

test('Video：创建 → 轮询 → 完成（结果与持久化）', { timeout: 45000 }, async (t) => {
  const { state, upstreamP } = mockVideo()
  const upstream = await upstreamP
  const gw = await startGateway({ name: 'mg014-basic', config: { providers: { mock: { baseUrl: upstream.base } }, models: { vid: { provider: 'mock', capability: 'video' } } } })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const created = await gw.post('/v1/videos', { model: 'vid', prompt: 'a cat' }, json())
  assert.equal(created.status, 202)
  const cj = await created.json()
  assert.match(cj.id, /^vid_/)
  assert.equal(cj.object, 'video')
  assert.equal(cj.model, 'vid')
  assert.ok(['queued', 'running'].includes(cj.status), '创建后应为 queued/running')
  assert.equal(upstream.hits[0].body.model, 'vid')
  assert.equal(upstream.hits[0].body.prompt, 'a cat')

  // 持久化
  const stored = JSON.parse(readFileSync(join(gw.dir, 'videos.json'), 'utf8'))
  assert.ok(stored.tasks[cj.id], '任务已落盘')

  // 第一次查询：上游 running
  await sleep(50)
  const s1 = await (await gw.get('/v1/videos/' + cj.id)).json()
  assert.equal(s1.status, 'running')
  assert.equal(upstream.hits.some((h) => h.method === 'GET' && h.url === '/v1/videos/up_1'), true, '查询触发上游轮询')

  // 上游完成 → 等过惰性轮询最小间隔后再查
  state.status = 'succeeded'
  state.result = { url: 'https://example.invalid/v.mp4' }
  await sleep(1700)
  const s2 = await (await gw.get('/v1/videos/' + cj.id)).json()
  assert.equal(s2.status, 'succeeded')
  assert.equal(s2.result.url, 'https://example.invalid/v.mp4')
})

test('Video：Idempotency-Key 幂等创建，不重复打上游', { timeout: 30000 }, async (t) => {
  const { upstreamP } = mockVideo()
  const upstream = await upstreamP
  const gw = await startGateway({ name: 'mg014-idem', config: { providers: { mock: { baseUrl: upstream.base } }, models: { vid: { provider: 'mock', capability: 'video' } } } })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const a = await gw.post('/v1/videos', { model: 'vid', prompt: 'x' }, Object.assign({ 'content-type': 'application/json', 'idempotency-key': 'key-1' }))
  assert.equal(a.status, 202)
  const aj = await a.json()
  const b = await gw.post('/v1/videos', { model: 'vid', prompt: 'x' }, Object.assign({ 'content-type': 'application/json', 'idempotency-key': 'key-1' }))
  assert.equal(b.status, 200, '重复幂等键返回既有任务')
  assert.equal((await b.json()).id, aj.id)
  assert.equal(upstream.hits.filter((h) => h.method === 'POST' && h.url === '/v1/videos').length, 1, '上游只创建一次')
})

test('Video：取消调用上游取消路径并落定为 canceled', { timeout: 30000 }, async (t) => {
  const { upstreamP } = mockVideo()
  const upstream = await upstreamP
  const gw = await startGateway({ name: 'mg014-cancel', config: { providers: { mock: { baseUrl: upstream.base } }, models: { vid: { provider: 'mock', capability: 'video' } } } })
  t.after(async () => { await gw.stop(); await upstream.stop() })
  const cj = await (await gw.post('/v1/videos', { model: 'vid', prompt: 'x' }, json())).json()
  const c = await gw.post('/v1/videos/' + cj.id + '/cancel', {}, json())
  assert.equal(c.status, 200)
  assert.equal((await c.json()).status, 'canceled')
  assert.equal(upstream.hits.some((h) => h.method === 'POST' && h.url === '/v1/videos/up_1/cancel'), true, '调用了上游取消')
  // 终态重复取消幂等
  assert.equal((await gw.post('/v1/videos/' + cj.id + '/cancel', {}, json())).status, 200)
})

test('Video：重启恢复任务与轮询；GC 清理过期任务', { timeout: 60000 }, async (t) => {
  const { state, upstreamP } = mockVideo()
  const upstream = await upstreamP
  const cfg = { providers: { mock: { baseUrl: upstream.base } }, models: { vid: { provider: 'mock', capability: 'video' } } }
  const dir = await mkdtemp(join(tmpdir(), 'mg014-restart-'))   // 显式目录：stop 不删除，供重启复用
  let gw = await startGateway({ name: 'mg014-restart', dir, config: cfg })
  t.after(async () => { try { await gw.stop() } catch {} ; await upstream.stop(); await rm(dir, { recursive: true, force: true }) })
  const cj = await (await gw.post('/v1/videos', { model: 'vid', prompt: 'x' }, json())).json()
  await gw.stop()

  // 重启（同一配置目录）：任务应仍在
  gw = await startGateway({ name: 'mg014-restart', dir, config: cfg })
  const s1 = await (await gw.get('/v1/videos/' + cj.id)).json()
  assert.equal(s1.id, cj.id, '重启后任务恢复')
  state.status = 'succeeded'; state.result = { url: 'https://example.invalid/r.mp4' }
  await sleep(1700)
  const s2 = await (await gw.get('/v1/videos/' + cj.id)).json()
  assert.equal(s2.status, 'succeeded', '重启后继续轮询到完成')

  // 注入过期任务后重启：终态超保留期删除、非终态超 24h 判 failed
  await gw.stop()
  const file = join(gw.dir, 'videos.json')
  const now = Date.now()
  writeFileSync(file, JSON.stringify({ version: 1, tasks: {
    old_done: { id: 'old_done', object: 'video', model: 'vid', provider: 'mock', status: 'succeeded', createdAt: now - 9 * 864e5, updatedAt: now - 9 * 864e5, lastPollAt: 0 },
    old_pending: { id: 'old_pending', object: 'video', model: 'vid', provider: 'mock', status: 'running', upstreamId: 'up_2', createdAt: now - 25 * 3600e3, updatedAt: now - 25 * 3600e3, lastPollAt: now },
  } }))
  gw = await startGateway({ name: 'mg014-restart', dir: gw.dir, config: cfg })
  t.after(async () => { await gw.stop() })
  assert.equal((await gw.get('/v1/videos/old_done')).status, 404, '超保留期终态被 GC')
  const pending = await (await gw.get('/v1/videos/old_pending')).json()
  assert.equal(pending.status, 'failed', '超 24h 非终态判 failed')
})

test('Video 能力隔离与不支持协议', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}') })
  const gw = await startGateway({
    name: 'mg014-cap',
    config: { providers: { mock: { baseUrl: upstream.base }, ant: { baseUrl: upstream.base, api: 'anthropic' } }, models: { vid: { provider: 'mock', capability: 'video' }, vidant: { provider: 'ant', capability: 'video' }, chat: { provider: 'mock' } } },
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })
  assert.equal((await gw.post('/v1/videos', { model: 'chat', prompt: 'x' }, json())).status, 400)
  assert.equal((await gw.post('/v1/chat/completions', { model: 'vid', messages: [{ role: 'user', content: 'hi' }] }, json())).status, 400)
  const ant = await gw.post('/v1/videos', { model: 'vidant', prompt: 'x' }, json())
  assert.equal(ant.status, 502)
  assert.equal(upstream.hits.length, 0, '隔离/不支持协议均不触达上游')
})

test('Video 校验与预算：缺 prompt 400；慢创建受 overallMs 约束 → 504', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    await new Promise((resolve) => { res.on('close', resolve); setTimeout(resolve, 4000).unref?.() })
    if (!res.writableEnded && !res.destroyed) { try { res.destroy() } catch {} }
  })
  const gw = await startGateway({
    name: 'mg014-budget',
    config: {
      defaults: { retry: { maxAttempts: 1 }, timeout: { firstByteMs: 5000, idleMs: 5000, overallMs: 300 } },
      providers: { mock: { baseUrl: upstream.base } },
      models: { vid: { provider: 'mock', capability: 'video' } },
    },
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })
  assert.equal((await gw.post('/v1/videos', { model: 'vid' }, json())).status, 400, '缺 prompt')
  const t0 = Date.now()
  const res = await gw.post('/v1/videos', { model: 'vid', prompt: 'x' }, json())
  assert.equal(res.status, 504)
  assert.equal((await res.json()).error.type, 'request_timeout')
  assert.ok(Date.now() - t0 < 2500)
})
