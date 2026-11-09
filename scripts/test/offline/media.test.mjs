// MG-013 Audio / Image：multipart 原样转发、二进制响应、能力隔离、体积上限、预算与取消。
import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, startScriptedUpstream } from './harness.mjs'
import { parseMultipartField } from '../../../src/media.js'

const json = () => ({ 'content-type': 'application/json' })
async function readRaw(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return Buffer.concat(chunks)
}
function modelOf(rec) { return rec.ctype && rec.raw ? parseMultipartField(rec.raw, rec.ctype, 'model') : null }

test('Audio speech：JSON 请求、二进制响应透传与记账', { timeout: 30000 }, async (t) => {
  const audio = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x11])
  const upstream = await startScriptedUpstream(async (req, res, rec) => {
    const raw = await readRaw(req)
    rec.raw = raw; rec.ctype = req.headers['content-type']; rec.body = JSON.parse(raw.toString('utf8'))
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': audio.length })
    res.end(audio)
  })
  const gw = await startGateway({ name: 'mg013-tts', config: { providers: { mock: { baseUrl: upstream.base } }, models: { tts: { provider: 'mock', capability: 'audio' } } } })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const res = await gw.post('/v1/audio/speech', { model: 'tts', input: 'hello', voice: 'alloy', response_format: 'mp3' }, json())
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') || '', /audio\/mpeg/)
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), audio, '二进制响应逐字节透传')
  const hit = upstream.hits[0]
  assert.equal(hit.url, '/v1/audio/speech')
  assert.equal(hit.body.model, 'tts')
  assert.equal(hit.body.input, 'hello')
  const st = await (await gw.get('/api/status')).json()
  assert.equal(st.models.find((m) => m.name === 'tts').requests, 1)
})

test('Audio transcription：multipart 原样转发，路由字段 model 正确解析', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res, rec) => {
    const raw = await readRaw(req)
    rec.raw = raw; rec.ctype = req.headers['content-type']
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ text: 'hello world' }))
  })
  const gw = await startGateway({ name: 'mg013-stt', config: { providers: { mock: { baseUrl: upstream.base } }, models: { stt: { provider: 'mock', capability: 'audio' } } } })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const form = new FormData()
  form.append('model', 'stt')
  form.append('file', new Blob([Buffer.from('RIFFfake')], { type: 'audio/wav' }), 'a.wav')
  const res = await fetch(gw.base + '/v1/audio/transcriptions', { method: 'POST', body: form })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { text: 'hello world' })
  const hit = upstream.hits[0]
  assert.match(hit.ctype, /^multipart\/form-data; boundary=/)
  assert.equal(modelOf(hit), 'stt', 'multipart 内的 model 字段被正确解析并发往上游')
  assert.ok(hit.raw.includes(Buffer.from('RIFFfake')), '文件字节原样转发')
})

test('Image generations：JSON 透传、usage 记账与模型发现', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res, rec) => {
    const raw = await readRaw(req)
    rec.raw = raw; rec.ctype = req.headers['content-type']; rec.body = JSON.parse(raw.toString('utf8'))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ created: 1700000000, data: [{ b64_json: 'AA==' }], usage: { input_tokens: 5, output_tokens: 10, total_tokens: 15 } }))
  })
  const gw = await startGateway({ name: 'mg013-img', config: { providers: { mock: { baseUrl: upstream.base } }, models: { img: { provider: 'mock', capability: 'image' } } } })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const res = await gw.post('/v1/images/generations', { model: 'img', prompt: 'a cat', n: 1, size: '256x256', response_format: 'b64_json' }, json())
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.data[0].b64_json, 'AA==')
  assert.equal(upstream.hits[0].url, '/v1/images/generations')
  assert.equal(upstream.hits[0].body.model, 'img')
  const st = await (await gw.get('/api/status')).json()
  const m = st.models.find((x) => x.name === 'img')
  assert.equal(m.capability, 'image')
  assert.equal(m.requests, 1)
  assert.equal(m.tokens, 15, '图片 usage token 计入账本')
})

test('Image edits：multipart 转发与响应透传', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res, rec) => {
    const raw = await readRaw(req)
    rec.raw = raw; rec.ctype = req.headers['content-type']
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ created: 1, data: [{ url: 'https://example.invalid/i.png' }] }))
  })
  const gw = await startGateway({ name: 'mg013-edit', config: { providers: { mock: { baseUrl: upstream.base } }, models: { img: { provider: 'mock', capability: 'image' } } } })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const form = new FormData()
  form.append('model', 'img')
  form.append('prompt', 'add a hat')
  form.append('image', new Blob([Buffer.from('PNGfake')], { type: 'image/png' }), 'a.png')
  const res = await fetch(gw.base + '/v1/images/edits', { method: 'POST', body: form })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).data[0].url, 'https://example.invalid/i.png')
  assert.equal(modelOf(upstream.hits[0]), 'img')
})

test('媒体能力隔离：audio/image 与 chat/其他能力互斥', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}') })
  const gw = await startGateway({
    name: 'mg013-cap',
    config: { providers: { mock: { baseUrl: upstream.base } }, models: { tts: { provider: 'mock', capability: 'audio' }, img: { provider: 'mock', capability: 'image' }, chat: { provider: 'mock' }, emb: { provider: 'mock', capability: 'embedding' } } },
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })
  assert.equal((await gw.post('/v1/audio/speech', { model: 'img', input: 'x' }, json())).status, 400)
  assert.equal((await gw.post('/v1/images/generations', { model: 'tts', prompt: 'x' }, json())).status, 400)
  assert.equal((await gw.post('/v1/audio/speech', { model: 'chat', input: 'x' }, json())).status, 400)
  assert.equal((await gw.post('/v1/chat/completions', { model: 'tts', messages: [{ role: 'user', content: 'hi' }] }, json())).status, 400)
  assert.equal((await gw.post('/v1/embeddings', { model: 'img', input: 'x' }, json())).status, 400)
  assert.equal(upstream.hits.length, 0, '能力隔离拒绝不得触达上游')
})

test('不支持的桥接明确拒绝：Anthropic 上游 audio → 502 且不触上游', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}') })
  const gw = await startGateway({ name: 'mg013-ant', config: { providers: { mock: { baseUrl: upstream.base, api: 'anthropic' } }, models: { tts: { provider: 'mock', capability: 'audio' } } } })
  t.after(async () => { await gw.stop(); await upstream.stop() })
  const res = await gw.post('/v1/audio/speech', { model: 'tts', input: 'x' }, json())
  assert.equal(res.status, 502)
  assert.equal((await res.json()).error.type, 'all_providers_failed')
  assert.equal(upstream.hits.length, 0)
})

test('媒体响应体积上限：超过 defaults.mediaMaxResponseBytes → 502 media_too_large', { timeout: 30000 }, async (t) => {
  const big = Buffer.alloc(4096, 7)
  const upstream = await startScriptedUpstream(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': big.length })
    res.end(big)
  })
  const gw = await startGateway({
    name: 'mg013-size',
    config: {
      defaults: { retry: { maxAttempts: 1 }, timeout: { firstByteMs: 5000, idleMs: 5000 }, mediaMaxResponseBytes: 1024 },
      providers: { mock: { baseUrl: upstream.base } },
      models: { tts: { provider: 'mock', capability: 'audio' } },
    },
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })
  const res = await gw.post('/v1/audio/speech', { model: 'tts', input: 'x' }, json())
  assert.equal(res.status, 502)
  assert.equal((await res.json()).error.type, 'media_too_large')
})

test('媒体预算：慢上游受 overallMs 约束 → 504，且 multipart 缺 model 返回 400', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res) => {
    await new Promise((resolve) => { res.on('close', resolve); setTimeout(resolve, 4000).unref?.() })
    if (!res.writableEnded && !res.destroyed) { try { res.destroy() } catch {} }
  })
  const gw = await startGateway({
    name: 'mg013-budget',
    config: {
      defaults: { retry: { maxAttempts: 1 }, timeout: { firstByteMs: 5000, idleMs: 5000, overallMs: 300 } },
      providers: { mock: { baseUrl: upstream.base } },
      models: { tts: { provider: 'mock', capability: 'audio' } },
    },
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })
  const t0 = Date.now()
  const res = await gw.post('/v1/audio/speech', { model: 'tts', input: 'x' }, json())
  assert.equal(res.status, 504)
  assert.equal((await res.json()).error.type, 'request_timeout')
  assert.ok(Date.now() - t0 < 2500)

  const form = new FormData()
  form.append('file', new Blob([Buffer.from('x')], { type: 'audio/wav' }), 'a.wav')
  const bad = await fetch(gw.base + '/v1/audio/transcriptions', { method: 'POST', body: form })
  assert.equal(bad.status, 400, 'multipart 缺 model → 400')
})
