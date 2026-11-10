// MG-008 余项：模型解析一致性（探测/预热/failback/转发共用 modelTarget）与非 OpenAI 错误信封映射。
// 全部离线：本地 mock 上游；不触真实上游、不读写用户主配置。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { modelTarget } from '../../../src/router.js'
import { warm, probeChat } from '../../../src/request.js'
import { mapErrorEnvelope } from '../../../src/format.js'
import { startGateway, startScriptedUpstream } from './harness.mjs'

const json = () => ({ 'content-type': 'application/json' })

async function withMock(handler, run) {
  const seen = []
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const rec = { method: req.method, path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }
    seen.push(rec)
    await handler(req, res, rec)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const provider = { id: 'p', baseUrl: 'http://127.0.0.1:' + server.address().port, api: 'openai', apiKey: 'test-key', extraHeaders: { 'x-extra': 'yes' } }
  try { await run(provider, seen) } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)) }
}

test('modelTarget：providerModels/api 优先级与探测/预热/failback 同一来源', () => {
  const cfg = {
    providers: { p1: { api: 'anthropic' }, p2: { api: 'openai' } },
    models: {
      m: { provider: 'p1', api: 'gemini', providerModels: { p1: 'vendor/m' }, effortFormat: 'thinking', maxTokensMax: 128 },
      n: { provider: 'p2' },
    },
  }
  assert.deepEqual(modelTarget(cfg, 'm', 'p1'), { servingName: 'vendor/m', api: 'gemini', effortFormat: 'thinking', maxTokensMax: 128 }, '模型 api 覆盖上游 api；覆盖名生效')
  assert.deepEqual(modelTarget(cfg, 'm', 'p2'), { servingName: 'm', api: 'gemini', effortFormat: 'thinking', maxTokensMax: 128 }, '未配置覆盖名时回落模型名')
  assert.deepEqual(modelTarget(cfg, 'n', 'p2'), { servingName: 'n', api: 'openai', effortFormat: 'reasoning_effort', maxTokensMax: 0 }, '未设置 api 时继承上游')
  assert.deepEqual(modelTarget(cfg, null, 'p1'), { servingName: null, api: 'anthropic', effortFormat: 'reasoning_effort', maxTokensMax: 0 }, '无模型名时仅取上游协议')
})

test('warm（预热）按模型协议与上游模型名整形：Anthropic', async () => {
  await withMock((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}') }, async (provider, seen) => {
    const r = await warm(provider, 'gw-model', 'LONG-SYSTEM', { api: 'anthropic', upstreamModel: 'vendor/model-x' })
    assert.equal(r.ok, true)
    assert.equal(seen[0].path, '/v1/messages', '预热走 Messages API（不是 chat 路径）')
    assert.equal(seen[0].body.model, 'vendor/model-x', '预热使用 providerModels 覆盖名')
    assert.equal(seen[0].body.system, 'LONG-SYSTEM')
    assert.equal(seen[0].body.messages[0].role, 'user', 'Anthropic 需要至少一条非 system 消息')
    assert.equal(seen[0].headers['x-api-key'], 'test-key')
    assert.equal(seen[0].headers['anthropic-version'], '2023-06-01')
  })
})

test('warm（预热）按模型协议与上游模型名整形：Gemini', async () => {
  await withMock((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}') }, async (provider, seen) => {
    const r = await warm(provider, 'gw-model', 'LONG-SYSTEM', { api: 'gemini', upstreamModel: 'gemini-x' })
    assert.equal(r.ok, true)
    assert.match(seen[0].path, /\/v1beta\/models\/gemini-x:generateContent/, '预热走 generateContent 且使用覆盖名')
    assert.equal(seen[0].body.systemInstruction.parts[0].text, 'LONG-SYSTEM')
    assert.equal(seen[0].headers['x-goog-api-key'], 'test-key')
  })
})

test('probeChat（failback）按模型协议与上游模型名探活：Anthropic SSE', async () => {
  await withMock((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('event: message_start\ndata: {"type":"message_start"}\n\n')
  }, async (provider, seen) => {
    const r = await probeChat(provider, 'gw-model', 'ping', { api: 'anthropic', upstreamModel: 'vendor/model-x' })
    assert.equal(r.ok, true, '收到首条 data 事件即判恢复')
    assert.equal(seen[0].path, '/v1/messages', 'failback 走 Messages API')
    assert.equal(seen[0].body.model, 'vendor/model-x', 'failback 使用覆盖名')
    assert.equal(seen[0].body.stream, true)
    assert.equal(seen[0].headers['x-api-key'], 'test-key')
  })
})

test('mapErrorEnvelope：原生错误映射为 OpenAI 信封，OpenAI 形状不动', () => {
  const a = mapErrorEnvelope('anthropic', 400, Buffer.from(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad thing' } })))
  assert.deepEqual(JSON.parse(a.toString()), { error: { message: 'bad thing', type: 'upstream_error', code: 'invalid_request_error' } })
  const g = mapErrorEnvelope('gemini', 400, Buffer.from(JSON.stringify({ error: { code: 400, message: 'bad thing', status: 'INVALID_ARGUMENT' } })))
  assert.deepEqual(JSON.parse(g.toString()), { error: { message: 'bad thing', type: 'upstream_error', code: 'INVALID_ARGUMENT' } })
  assert.equal(mapErrorEnvelope('anthropic', 400, Buffer.from(JSON.stringify({ error: { message: 'x', type: 'invalid_request_error' } }))), null, 'OpenAI 形状透传')
  assert.equal(mapErrorEnvelope('openai', 400, Buffer.from(JSON.stringify({ error: { message: 'x' } }))), null, 'OpenAI 上游不映射')
})

test('集成：Anthropic 上游 400 原生错误 → 客户端收到 OpenAI 信封与原始状态码', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad thing' } }))
  })
  const gw = await startGateway({
    name: 'mg008-env',
    config: { providers: { mock: { baseUrl: upstream.base, api: 'anthropic' } }, models: { demo: { provider: 'mock' } } },
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })
  const res = await gw.post('/v1/chat/completions', { model: 'demo', messages: [{ role: 'user', content: 'hi' }] }, json())
  assert.equal(res.status, 400, '保留原始状态码')
  const body = await res.json()
  assert.equal(body.error.message, 'bad thing')
  assert.equal(body.error.type, 'upstream_error')
  assert.equal(upstream.hits[0].url, '/v1/messages', '请求确实走了 Anthropic 协议')
})

test('集成：OpenAI 上游错误体原样透传（不误映射）', { timeout: 30000 }, async (t) => {
  const raw = { error: { message: 'raw error', type: 'invalid_request_error' } }
  const upstream = await startScriptedUpstream(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify(raw))
  })
  const gw = await startGateway({
    name: 'mg008-passthrough',
    config: { providers: { mock: { baseUrl: upstream.base } }, models: { demo: { provider: 'mock' } } },
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })
  const res = await gw.post('/v1/chat/completions', { model: 'demo', messages: [{ role: 'user', content: 'hi' }] }, json())
  assert.equal(res.status, 400)
  assert.deepEqual(await res.json(), raw)
})
