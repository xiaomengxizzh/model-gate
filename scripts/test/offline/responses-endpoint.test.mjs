// MG-015 /v1/responses 入口与 Chat 桥接线回归（离线）。
// 覆盖：非流式对象整形、拒绝矩阵、SSE 事件序列与终态、工具参数分片、上游错误透传、方法限制。
import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, startScriptedUpstream } from './harness.mjs'

const json = () => ({ 'content-type': 'application/json' })
const post = (gw, body) => gw.post('/v1/responses', body, json())
const CHAT_OK = { id: 'mock-1', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8')
  try { return raw ? JSON.parse(raw) : null } catch { return null }
}

function parseSSE(text) {
  const out = []
  for (const block of String(text).split('\n\n')) {
    if (!block.trim()) continue
    let event = ''
    const data = []
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      if (line.startsWith('data:')) data.push(line.slice(5).trim())
    }
    if (data.length) out.push({ event, data: data.join('\n') })
  }
  return out
}

test('Responses 非流式：Chat 桥请求整形 + response 对象 + usage 映射', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res, rec) => {
    rec.body = await readBody(req)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(CHAT_OK))
  })
  const gw = await startGateway({ name: 'mg015-basic', config: { providers: { mock: { baseUrl: upstream.base } }, models: { demo: { provider: 'mock' } } } })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const res = await post(gw, { model: 'demo', input: 'hi', instructions: 'be brief', max_output_tokens: 12 })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.object, 'response')
  assert.equal(body.model, 'demo', 'model 回写客户端请求名')
  assert.match(body.id, /^resp_/)
  assert.equal(body.status, 'completed')
  assert.equal(body.output_text, 'pong')
  assert.equal(body.usage.input_tokens, 3)
  assert.equal(body.usage.output_tokens, 2)
  assert.equal(body.usage.total_tokens, 5)

  const hit = upstream.hits[0]
  assert.equal(hit.url, '/v1/chat/completions', '桥路径上游用 Chat Completions')
  assert.equal(hit.body.model, 'demo')
  assert.equal(hit.body.messages[0].role, 'system')
  assert.equal(hit.body.messages[0].content, 'be brief')
  assert.equal(hit.body.messages[1].content, 'hi')
  assert.equal(hit.body.max_tokens, 12)
  assert.ok(!hit.body.stream, '非流式请求上游 stream=false')
})

test('Responses 拒绝矩阵：store/previous_response_id/background/托管工具 400 且不触上游', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(CHAT_OK)) })
  const gw = await startGateway({ name: 'mg015-reject', config: { providers: { mock: { baseUrl: upstream.base } }, models: { demo: { provider: 'mock' } } } })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  for (const body of [
    { model: 'demo', input: 'hi', store: true },
    { model: 'demo', input: 'hi', previous_response_id: 'resp_x' },
    { model: 'demo', input: 'hi', background: true },
    { model: 'demo', input: 'hi', tools: [{ type: 'web_search' }] },
  ]) {
    const res = await post(gw, body)
    assert.equal(res.status, 400, JSON.stringify(body))
    const j = await res.json()
    assert.equal(j.error.type, 'unsupported_parameter')
    assert.ok(j.error.message.length > 0)
  }
  assert.equal(upstream.hits.length, 0, '拒绝项不得触达上游')
})

test('Responses 流式：SSE 事件序列、无 [DONE]、文本完整', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res, rec) => {
    rec.body = await readBody(req)
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.write('data: ' + JSON.stringify({ id: 'chatcmpl-x', choices: [{ index: 0, delta: { content: 'po' } }] }) + '\n\n')
    res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'ng' } }] }) + '\n\n')
    res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n')
    res.write('data: [DONE]\n\n')
    res.end()
  })
  const gw = await startGateway({ name: 'mg015-stream', config: { providers: { mock: { baseUrl: upstream.base } }, models: { demo: { provider: 'mock' } } } })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const res = await post(gw, { model: 'demo', input: 'hi', stream: true })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') || '', /text\/event-stream/)
  const text = await res.text()
  const events = parseSSE(text)
  const types = events.map((e) => e.event)
  assert.equal(types.filter((x) => x === 'response.created').length, 1, '恰好一个 response.created')
  assert.equal(types.filter((x) => x === 'response.completed').length, 1, '恰好一个 response.completed')
  assert.ok(types.includes('response.output_text.delta'))
  assert.ok(types.includes('response.output_text.done'))
  assert.equal(text.includes('data: [DONE]'), false, 'Responses 不使用 [DONE]')
  const deltas = events.filter((e) => e.event === 'response.output_text.delta').map((e) => JSON.parse(e.data).delta).join('')
  assert.equal(deltas, 'pong')
  const donePart = events.find((e) => e.event === 'response.output_text.done')
  assert.equal(JSON.parse(donePart.data).text, 'pong')
  const completed = JSON.parse(events.find((e) => e.event === 'response.completed').data)
  assert.equal(completed.response.status, 'completed')
  assert.equal(completed.response.model, 'demo')
  const seqs = events.filter((e) => e.event.startsWith('response.')).map((e) => JSON.parse(e.data).sequence_number)
  for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1], 'sequence_number 单调递增')
  assert.equal(upstream.hits[0].body.stream, true)
  assert.equal(upstream.hits[0].body.model, 'demo')
})

test('Responses 流式工具调用：参数分片映射为 function_call 事件与 completed.output', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res, rec) => {
    rec.body = await readBody(req)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":' } }] } }] }) + '\n\n')
    res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] } }] }) + '\n\n')
    res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + '\n\n')
    res.write('data: [DONE]\n\n')
    res.end()
  })
  const gw = await startGateway({ name: 'mg015-tools', config: { providers: { mock: { baseUrl: upstream.base } }, models: { demo: { provider: 'mock' } } } })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const res = await post(gw, { model: 'demo', input: 'weather?', stream: true, tools: [{ type: 'function', name: 'get_weather', parameters: { type: 'object', properties: {} } }] })
  const text = await res.text()
  const types = parseSSE(text).map((e) => e.event)
  assert.ok(types.includes('response.function_call_arguments.done'))
  const completed = JSON.parse(parseSSE(text).find((e) => e.event === 'response.completed').data)
  const fc = completed.response.output.find((o) => o.type === 'function_call')
  assert.ok(fc, 'completed.response.output 含 function_call')
  assert.equal(fc.name, 'get_weather')
  assert.deepEqual(JSON.parse(fc.arguments), { city: 'Paris' })
  assert.equal(upstream.hits[0].body.tools[0].function.name, 'get_weather', 'tools 桥接到 Chat')
})

test('Responses 错误：上游 OpenAI 错误体透传状态码与信封', { timeout: 30000 }, async (t) => {
  const raw = { error: { message: 'raw bad request', type: 'invalid_request_error' } }
  const upstream = await startScriptedUpstream(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify(raw))
  })
  const gw = await startGateway({ name: 'mg015-error', config: { providers: { mock: { baseUrl: upstream.base } }, models: { demo: { provider: 'mock' } } } })
  t.after(async () => { await gw.stop(); await upstream.stop() })
  const res = await post(gw, { model: 'demo', input: 'hi' })
  assert.equal(res.status, 400)
  assert.deepEqual(await res.json(), raw)
})

test('Responses 方法限制：GET /v1/responses → 405', { timeout: 30000 }, async (t) => {
  const gw = await startGateway({ name: 'mg015-method' })
  t.after(() => gw.stop())
  const res = await gw.get('/v1/responses')
  assert.equal(res.status, 405)
})
