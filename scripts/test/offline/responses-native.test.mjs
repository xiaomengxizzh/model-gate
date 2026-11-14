// MG-015 原生 Responses 透传：api:"responses" 时不走 Chat 桥；非流式 JSON/流式 SSE 原样、预算与拒绝矩阵。
import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, startScriptedUpstream } from './harness.mjs'

const json = () => ({ 'content-type': 'application/json' })
async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8')
  try { return raw ? JSON.parse(raw) : null } catch { return null }
}
const RESP = {
  id: 'resp_up',
  object: 'response',
  created_at: 1700000000,
  status: 'completed',
  model: 'vendor-model',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'pong' }] }],
  output_text: 'pong',
  usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
}

test('原生 Responses 非流式：不转换成 Chat，model 覆盖与回写、usage 记账', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res, rec) => {
    rec.body = await readBody(req)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(RESP))
  })
  const gw = await startGateway({ name: 'mg015n-basic', config: { providers: { mock: { baseUrl: upstream.base } }, models: { demo: { provider: 'mock', api: 'responses', providerModels: { mock: 'vendor-model' } } } } })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const res = await gw.post('/v1/responses', { model: 'demo', input: 'hi' }, json())
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.model, 'demo', 'model 回写客户端请求名')
  assert.equal(body.output_text, 'pong')
  const hit = upstream.hits[0]
  assert.equal(hit.url, '/v1/responses', '原生路径，不是 /v1/chat/completions')
  assert.equal(hit.body.model, 'vendor-model', 'providerModels 覆盖名生效')
  assert.equal(hit.body.input, 'hi', 'Responses input 原样透传，未被转换成 messages')
  assert.equal(hit.body.messages, undefined)
  const st = await (await gw.get('/api/status')).json()
  const m = st.models.find((x) => x.name === 'demo')
  assert.equal(m.tokens, 7, '原生 usage 计入账本')
  assert.equal(m.requests, 1)
})

test('原生 Responses 流式：SSE 事件逐字节透传（不翻译、不追加 [DONE]）', { timeout: 30000 }, async (t) => {
  const frames = 'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_up","status":"in_progress","model":"vendor-model"}}\n\n' +
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n' +
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_up","status":"completed"}}\n\n'
  const upstream = await startScriptedUpstream(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.end(frames)
  })
  const gw = await startGateway({ name: 'mg015n-stream', config: { providers: { mock: { baseUrl: upstream.base } }, models: { demo: { provider: 'mock', api: 'responses' } } } })
  t.after(async () => { await gw.stop(); await upstream.stop() })
  const res = await gw.post('/v1/responses', { model: 'demo', input: 'hi', stream: true }, json())
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') || '', /text\/event-stream/)
  const text = await res.text()
  assert.equal(text, frames, '原生 SSE 原样透传（不翻译事件/不改 model）')
  assert.equal(text.includes('data: [DONE]'), false)
})

test('原生 Responses legacy 拒绝矩阵（无 nativeContract）：明确 unsupported_native_parameter 且零上游', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(RESP)) })
  const gw = await startGateway({ name: 'mg015n-reject', config: { providers: { mock: { baseUrl: upstream.base } }, models: { demo: { provider: 'mock', api: 'responses' }, emb: { provider: 'mock', api: 'responses', capability: 'embedding' } } } })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  // M1-2：原生分支不再套用 Chat 桥的泛化 rejected；未声明 nativeContract 时
  // store/previous_response_id/background/truncation 返回明确 typedUnsupported 码。
  for (const patch of [{ store: true }, { previous_response_id: 'resp_x' }, { background: true }, { truncation: 'auto' }]) {
    const a = await gw.post('/v1/responses', Object.assign({ model: 'demo', input: 'hi' }, patch), json())
    assert.equal(a.status, 400, JSON.stringify(patch))
    const err = (await a.json()).error
    assert.equal(err.type, 'unsupported_native_parameter', JSON.stringify(patch))
    assert.match(String(err.message), /nativeContract/)
  }
  const b = await gw.post('/v1/responses', { model: 'emb', input: 'hi' }, json())
  assert.equal(b.status, 400); assert.equal((await b.json()).error.type, 'unsupported_model')
  assert.equal(upstream.hits.length, 0)
})

test('原生 Responses 错误与预算：上游错误体透传；慢上游 → 504', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res, rec) => {
    if (rec.index === 0) {
      for await (const _ of req) { /* drain */ }
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'bad', type: 'invalid_request_error' } })); return
    }
    await new Promise((resolve) => { res.on('close', resolve); setTimeout(resolve, 4000).unref?.() })
    if (!res.writableEnded && !res.destroyed) { try { res.destroy() } catch {} }
  })
  const gw = await startGateway({
    name: 'mg015n-budget',
    config: {
      defaults: { retry: { maxAttempts: 1 }, timeout: { firstByteMs: 5000, idleMs: 5000, overallMs: 300 } },
      providers: { mock: { baseUrl: upstream.base } },
      models: { demo: { provider: 'mock', api: 'responses' } },
    },
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })
  const e = await gw.post('/v1/responses', { model: 'demo', input: 'hi' }, json())
  assert.equal(e.status, 400)
  assert.deepEqual(await e.json(), { error: { message: 'bad', type: 'invalid_request_error' } })
  const t0 = Date.now()
  const slow = await gw.post('/v1/responses', { model: 'demo', input: 'hi' }, json())
  assert.equal(slow.status, 504)
  assert.equal((await slow.json()).error.type, 'request_timeout')
  assert.ok(Date.now() - t0 < 2500)
})

test('Codex 投影原生流等待延迟完成帧，并保持请求预算至流结束', { timeout: 30000 }, async (t) => {
  const created = 'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_up","status":"in_progress"}}\n\n'
  const completed = 'event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response: RESP }) + '\n\n'
  const upstream = await startScriptedUpstream(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(created)
    await new Promise((resolve) => setTimeout(resolve, 80))
    res.end(completed)
  })
  const gw = await startGateway({
    name: 'native-codex-projected',
    config: {
      providers: { mock: { baseUrl: upstream.base } },
      models: { demo: { provider: 'mock', api: 'responses', codex: { plaintextTools: true } } },
    },
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const res = await gw.post('/v1/responses', { model: 'demo', input: 'hi', stream: true }, json())
  assert.equal(res.status, 200)
  const text = await res.text()
  assert.match(text, /event: response\.created/)
  assert.match(text, /event: response\.completed/)
  assert.doesNotMatch(text, /event: response\.failed/)
  assert.equal(upstream.hits.length, 1)
  assert.equal(upstream.hits[0].aborted, false)
})

test('Codex 投影拒绝只有信封和密文的当前任务，零上游请求', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res) => {
    await readBody(req)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(RESP))
  })
  const gw = await startGateway({
    name: 'native-codex-opaque',
    config: {
      providers: { mock: { baseUrl: upstream.base } },
      models: { demo: { provider: 'mock', api: 'responses', codex: { plaintextTools: true } } },
    },
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const res = await gw.post('/v1/responses', {
    model: 'demo',
    stream: true,
    input: [{
      type: 'agent_message',
      content: [
        { type: 'input_text', text: 'Message Type: NEW_TASK\nTask name: /root/worker\nSender: /root\nPayload:\n' },
        { type: 'encrypted_content', encrypted_content: 'synthetic-opaque-task' },
      ],
    }],
  }, json())
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.equal(body.error.code, 'opaque_agent_message')
  assert.doesNotMatch(JSON.stringify(body), /synthetic-opaque-task/)
  assert.equal(upstream.hits.length, 0)
})

test('Codex 投影原生流按下游是否已开流返回 504 或一次超时终态', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res, hit) => {
    await readBody(req)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (hit.index === 0) res.flushHeaders()
    else res.write('event: response.created\ndata: {"type":"response.created"}\n\n')
  })
  const gw = await startGateway({
    name: 'native-codex-stream-timeout',
    config: {
      defaults: { timeout: { firstByteMs: 5000, idleMs: 5000, overallMs: 500 } },
      providers: { mock: { baseUrl: upstream.base } },
      models: { demo: { provider: 'mock', api: 'responses', codex: {} } },
    },
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const request = { model: 'demo', input: 'hi', stream: true }
  const beforeStream = await gw.post('/v1/responses', request, json())
  assert.equal(beforeStream.status, 504)
  assert.equal((await beforeStream.json()).error.type, 'request_timeout')

  const res = await gw.post('/v1/responses', request, json())
  assert.equal(res.status, 200)
  const text = await res.text()
  assert.match(text, /event: response\.created/)
  assert.equal((text.match(/event: response\.failed/g) || []).length, 1)
  assert.match(text, /"code":"REQUEST_TIMEOUT"/)
  assert.equal(upstream.hits.length, 2)
})
