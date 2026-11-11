// MG-015 /v1/responses 入口与 Chat 桥接线回归（离线）。
// 覆盖：非流式对象整形、拒绝矩阵、SSE 事件序列与终态、工具参数分片、上游错误透传、方法限制。
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { createResponsesStream } from '../../../src/responses-stream.js'
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

test('Responses 拒绝矩阵：store/previous_response_id/background 400 且不触上游（托管工具改为丢弃放行）', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res, rec) => {
    rec.body = await readBody(req)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(CHAT_OK))
  })
  const gw = await startGateway({ name: 'mg015-reject', config: { providers: { mock: { baseUrl: upstream.base } }, models: { demo: { provider: 'mock' } } } })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  for (const body of [
    { model: 'demo', input: 'hi', store: true },
    { model: 'demo', input: 'hi', previous_response_id: 'resp_x' },
    { model: 'demo', input: 'hi', background: true },
  ]) {
    const res = await post(gw, body)
    assert.equal(res.status, 400, JSON.stringify(body))
    const j = await res.json()
    assert.equal(j.error.type, 'unsupported_parameter')
    assert.ok(j.error.message.length > 0)
  }
  assert.equal(upstream.hits.length, 0, '拒绝项不得触达上游')

  // 托管工具（Codex 固定发送 web_search / namespace）不再整条拒绝：丢弃后照常转发
  const ok = await post(gw, { model: 'demo', input: 'hi', tools: [{ type: 'function', name: 'f1', parameters: { type: 'object', properties: {} } }, { type: 'web_search' }, { type: 'namespace', name: 'ns' }] })
  assert.equal(ok.status, 200, '托管工具应丢弃放行，不得 400')
  assert.equal(upstream.hits.length, 1, '丢弃后仍应正常触达上游一次')
  const sent = upstream.hits[0].body
  assert.equal(sent.tools.length, 1, '上游只收到可表达的 function tool')
  assert.equal(sent.tools[0].function.name, 'f1')
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

// ============================================================================
// M1-2（T-SSE-02）：流式桥的 item id / callId 配对 / 唯一终态；入口拒绝零上游
// ============================================================================
function fakeStreamRes() {
  const res = new EventEmitter()
  res.chunks = []
  res.statusCode = null
  res.headers = null
  res.writableLength = 0
  res.writableEnded = false
  res.destroyed = false
  res.writeHead = (code, headers) => { res.statusCode = code; res.headers = headers }
  res.write = (s) => { res.chunks.push(String(s)); return true }
  res.end = (s) => { if (s) res.chunks.push(String(s)); res.writableEnded = true }
  res.destroy = () => { res.destroyed = true; res.emit('close') }
  return res
}
function parseResponsesSSE(text) {
  return String(text).split('\n\n').filter((b) => b.trim() !== '').map((block) => {
    let event = ''
    let data = ''
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      if (line.startsWith('data:')) data = (data ? data + '\n' : '') + line.slice(5).trim()
    }
    return { event, data: data ? JSON.parse(data) : null }
  })
}
const chatFrame = (obj) => 'data: ' + JSON.stringify(obj) + '\n\n'

test('T-SSE-02a 流式桥：两个 callId 交错 delta 不串线、item id 贯穿完成帧、恰好一个 completed', { timeout: 15000 }, async () => {
  const res = fakeStreamRes()
  const session = createResponsesStream(res, { model: 'demo', id: 'resp_multi', createdAt: 1700000000 })
  const chunks = [
    chatFrame({ choices: [{ delta: { content: 'po' } }] }),
    chatFrame({ choices: [{ delta: { content: 'ng' } }] }),
    chatFrame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'fa', arguments: '{"a":' } }] } }] }),
    chatFrame({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_b', function: { name: 'fb', arguments: '{"b":' } }] } }] }),
    chatFrame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }] }),
    chatFrame({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '2}' } }] } }] }),
    chatFrame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }),
    'data: [DONE]\n\n',
  ]
  const result = await session.relay(Readable.from(chunks), { idleMs: 0, maxReconnects: 0, noEventMs: 0 })
  assert.equal(result.completed, true)
  const evs = parseResponsesSSE(res.chunks.join(''))
  const types = evs.map((e) => e.event)
  assert.equal(types.filter((t) => t === 'response.created').length, 1)
  assert.equal(types.filter((t) => t === 'response.completed').length, 1, '恰好一个 completed 终态')
  assert.equal(types.filter((t) => t === 'response.failed').length, 0)
  assert.equal(types.includes('response.output_text.done'), true)

  const adds = evs.filter((e) => e.event === 'response.output_item.added').map((e) => e.data.item)
  assert.deepEqual(adds.map((i) => i.id), ['resp_multi_msg', 'resp_multi_fc_call_a', 'resp_multi_fc_call_b'], 'item id 稳定且可预测')
  const textDeltas = evs.filter((e) => e.event === 'response.output_text.delta')
  assert.deepEqual(textDeltas.map((e) => e.data.item_id), ['resp_multi_msg', 'resp_multi_msg'])
  assert.deepEqual(textDeltas.map((e) => e.data.delta), ['po', 'ng'])
  const textDone = evs.find((e) => e.event === 'response.output_text.done')
  assert.equal(textDone.data.item_id, 'resp_multi_msg')
  assert.equal(textDone.data.text, 'pong', '文本终态必须完整（delta 累加而非最后一片）')
  const msgDone = evs.filter((e) => e.event === 'response.output_item.done' && e.data.item.type === 'message')
  assert.equal(msgDone[0].data.item.id, 'resp_multi_msg', 'message item id 贯穿 done')

  const argDeltas = evs.filter((e) => e.event === 'response.function_call_arguments.delta')
  assert.deepEqual(argDeltas.map((e) => [e.data.item_id, e.data.delta]), [
    ['resp_multi_fc_call_a', '{"a":'], ['resp_multi_fc_call_b', '{"b":'],
    ['resp_multi_fc_call_a', '1}'], ['resp_multi_fc_call_b', '2}'],
  ], '交错 delta 必须回到各自 item，不得串线')
  const argDone = evs.filter((e) => e.event === 'response.function_call_arguments.done')
  assert.deepEqual(argDone.map((e) => [e.data.item_id, e.data.arguments]), [
    ['resp_multi_fc_call_a', '{"a":1}'], ['resp_multi_fc_call_b', '{"b":2}'],
  ])
  const completed = evs.find((e) => e.event === 'response.completed').data.response
  assert.deepEqual(completed.output.map((o) => o.id), ['resp_multi_msg', 'resp_multi_fc_call_a', 'resp_multi_fc_call_b'], 'completed.output 与 item 事件同 id')
  assert.deepEqual(completed.output.filter((o) => o.type === 'function_call').map((o) => [o.call_id, o.arguments]), [
    ['call_a', '{"a":1}'], ['call_b', '{"b":2}'],
  ])
  assert.equal(completed.output_text, 'pong')
  assert.equal(res.writableEnded, true)
})

test('T-SSE-02b 半截流：恰好一个 response.failed、无 completed；重复 finish 不写第二次', { timeout: 15000 }, async () => {
  const res = fakeStreamRes()
  const session = createResponsesStream(res, { model: 'demo', id: 'resp_half', createdAt: 1700000000 })
  const upstream = (async function* () {
    yield chatFrame({ choices: [{ delta: { content: 'x' } }] })
    throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
  })()
  const result = await session.relay(upstream, { idleMs: 0, maxReconnects: 0, noEventMs: 0 })
  assert.equal(result.interrupted, true)
  result.finish('half stream')
  result.finish('half stream again')
  const evs = parseResponsesSSE(res.chunks.join(''))
  const types = evs.map((e) => e.event)
  assert.equal(types.filter((t) => t === 'response.failed').length, 1, '半截流恰好一个失败终态')
  assert.equal(types.filter((t) => t === 'response.completed').length, 0, '失败后不得再写 completed')
  const failed = evs.find((e) => e.event === 'response.failed')
  assert.equal(failed.data.error.code, 'STREAM_INTERRUPTED')
})

test('T-SSE-02c 取消/预算：客户端断开只销毁上游且不写二次终态；预算终态恰好一次', { timeout: 15000 }, async () => {
  // 客户端断开（取消）：Responses 契约 §6.7 不为已断开的客户端伪造终态；上游必须销毁且不重连。
  const res = fakeStreamRes()
  let wakeCancel = null
  const upstream = {
    destroyed: false,
    destroy() { this.destroyed = true; if (wakeCancel) wakeCancel() },
    async *[Symbol.asyncIterator]() {
      yield chatFrame({ choices: [{ delta: { content: 'first' } }] })
      const stopped = new Promise((resolve) => { wakeCancel = resolve })
      res.emit('close') // 客户端断开：relayStream 会同步 destroy 上游
      await stopped
    },
  }
  const session = createResponsesStream(res, { model: 'demo', id: 'resp_cancel' })
  const result = await session.relay(upstream, { idleMs: 0, maxReconnects: 0, noEventMs: 0 })
  assert.equal(result.clientGone, true)
  assert.equal(upstream.destroyed, true, '取消必须销毁上游')
  const cancelTypes = parseResponsesSSE(res.chunks.join('')).map((e) => e.event)
  assert.equal(cancelTypes.includes('response.failed'), false, '客户端已断开时不得再写终态')
  assert.equal(cancelTypes.includes('response.completed'), false)
  session.fail('after cancel')
  assert.equal(parseResponsesSSE(res.chunks.join('')).length, cancelTypes.length, '断开后的 finish 不得补写第二次终态')

  // 预算/服务端取消（客户端仍可写）：失败终态恰好一次，code=REQUEST_TIMEOUT。
  const res2 = fakeStreamRes()
  const controller = new AbortController()
  const budget = { timedOut: () => true, signal: controller.signal }
  let wakeTimeout = null
  const hung = {
    destroyed: false,
    destroy() { this.destroyed = true; if (wakeTimeout) wakeTimeout() },
    async *[Symbol.asyncIterator]() { await new Promise((resolve) => { wakeTimeout = resolve }) },
  }
  const session2 = createResponsesStream(res2, { model: 'demo', id: 'resp_timeout' })
  const p = session2.relay(hung, { idleMs: 0, maxReconnects: 0, noEventMs: 0, signal: controller.signal, budget })
  setTimeout(() => controller.abort(), 10)
  const r2 = await p
  r2.finish('timeout', { timeout: true })
  r2.finish('timeout again', { timeout: true })
  const types2 = parseResponsesSSE(res2.chunks.join('')).map((e) => e.event)
  assert.equal(types2.filter((t) => t === 'response.failed').length, 1)
  assert.equal(types2.filter((t) => t === 'response.completed').length, 0)
  const failed = parseResponsesSSE(res2.chunks.join('')).find((e) => e.event === 'response.failed')
  assert.equal(failed.data.error.code, 'REQUEST_TIMEOUT')
})

test('M1-2 入口：孤儿 tool_output / v2 顶层密文在发送前 400，零上游命中', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(CHAT_OK))
  })
  const gw = await startGateway({ name: 'mg015-bridge-guard', config: { providers: { mock: { baseUrl: upstream.base } }, models: { demo: { provider: 'mock' } } } })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const orphan = await post(gw, {
    model: 'demo',
    input: [
      { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{}' },
      { type: 'function_call_output', call_id: 'ghost', output: 'x' },
    ],
  })
  assert.equal(orphan.status, 400)
  assert.equal((await orphan.json()).error.type, 'tool_pairing_invalid')
  assert.equal(upstream.hits.length, 0, '配对失败不得触达上游')

  const v2 = await post(gw, { model: 'demo', input: 'hi', encrypted_content: 'CIPHER-VALUE' })
  assert.equal(v2.status, 400)
  const v2err = (await v2.json()).error
  assert.equal(v2err.type, 'v2_encrypted_task_unsupported')
  assert.equal(JSON.stringify(v2err).includes('CIPHER-VALUE'), false, '错误不得回显密文')
  assert.equal(upstream.hits.length, 0, 'v2 密文不得触达上游')
})

test('M1-2 入口：桥流式断流 → 恰好一个 response.failed，无 completed', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'po' } }] }) + '\n\n')
    setTimeout(() => { try { res.destroy() } catch {} }, 30)
  })
  const gw = await startGateway({ name: 'mg015-bridge-half', config: { providers: { mock: { baseUrl: upstream.base } }, models: { demo: { provider: 'mock' } } } })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const res = await post(gw, { model: 'demo', input: 'hi', stream: true })
  assert.equal(res.status, 200)
  const text = await res.text()
  const events = parseSSE(text)
  const types = events.map((e) => e.event)
  assert.equal(types.filter((x) => x === 'response.created').length, 1)
  assert.equal(types.filter((x) => x === 'response.failed').length, 1, '断流恰好一个失败终态')
  assert.equal(types.filter((x) => x === 'response.completed').length, 0, '断流不得再写 completed')
  assert.equal(text.includes('data: [DONE]'), false, 'Responses 协议不使用 [DONE]')
})
