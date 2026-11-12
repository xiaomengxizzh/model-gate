// P04: Codex 原生 Responses SSE 适配（定向移植 7afb4dc src/codex-responses-stream.js）。
// 纯内存假 res + 合成 SSE：不联网、不启网关、不读 HOME/auth。覆盖 UTF-8/CRLF、并行/反序分片、
// 单终态、EOF、usage once、[DONE] 丢弃、背压、identity 与 JSON 路径一致。
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  createResponsesStream,
  createCodexSSEParser,
  createCodexStreamAdapter,
  isCodexTerminalEvent,
} from '../../../src/responses-stream.js'
import { restoreResponseJson } from '../../../src/codex/interop.js'

const ROUTE = {
  alias: 'codex-gpt',
  provider: 'openai-official',
  upstreamModel: 'gpt-6.1-sol',
  api: 'responses',
  codex: {
    multiAgentVersion: 'v2',
    plaintextTools: true,
    history: { agentMessage: 'preserve', reasoning: 'preserve', compaction: 'reject' },
    namespace: 'collaboration',
  },
}

function makePlan(namespaces = ['spawn_agent', 'send_message'], plainFunctions = ['read_file']) {
  const declared = new Map()
  for (const name of namespaces) {
    declared.set(name, {
      kind: 'namespace', toolType: 'function', name, namespace: 'collaboration', messagePlaintext: true, restoredName: name,
    })
  }
  for (const name of plainFunctions) {
    declared.set(name, {
      kind: 'function', toolType: 'function', name, namespace: null, messagePlaintext: false, restoredName: name,
    })
  }
  return { declared, declarations: undefined, toolChoice: undefined, lossy: [] }
}

function frame(type, data, eol = '\n') {
  return 'event: ' + type + eol + 'data: ' + JSON.stringify(Object.assign({ type }, data)) + eol + eol
}

function responseObj(over) {
  return Object.assign({
    id: 'resp_up', object: 'response', created_at: 1760000000,
    status: 'completed', model: 'gpt-6.1-sol', output: [],
  }, over || {})
}

function flatTool(name, callId, itemId, over) {
  return Object.assign({
    id: itemId, type: 'function_call', status: 'completed',
    call_id: callId, name, arguments: '{}',
  }, over || {})
}

function created(seqn = 1) {
  return frame('response.created', { sequence_number: seqn, response: responseObj({ status: 'in_progress' }) })
}

function toolSequence(opts) {
  const o = Object.assign({ name: 'spawn_agent', callId: 'call_1', itemId: 'fc_1', outputIndex: 0, args: '{"task_name":"w"}' }, opts || {})
  const addedItem = { id: o.itemId, type: 'function_call', status: 'in_progress', call_id: o.callId, name: o.name, arguments: '' }
  const doneItem = { id: o.itemId, type: 'function_call', status: 'completed', call_id: o.callId, name: o.name, arguments: o.args }
  return {
    added: frame('response.output_item.added', { sequence_number: o.seqA || 2, output_index: o.outputIndex, item: addedItem }),
    delta: frame('response.function_call_arguments.delta', { sequence_number: o.seqD || 3, item_id: o.itemId, output_index: o.outputIndex, delta: o.args }),
    argsDone: frame('response.function_call_arguments.done', { sequence_number: o.seqAD || 4, item_id: o.itemId, output_index: o.outputIndex, arguments: o.args }),
    done: frame('response.output_item.done', { sequence_number: o.seqDone || 5, output_index: o.outputIndex, item: doneItem }),
    addedItem,
    doneItem,
  }
}

function makeRes(opts = {}) {
  const res = new EventEmitter()
  res.headersSent = false
  res.writableEnded = false
  res.destroyed = false
  res.writableLength = 0
  res.frames = []
  res.headerCalls = []
  res.writeHead = (status, headers) => {
    res.headersSent = true
    res.statusCode = status
    res.headerCalls.push({ status, headers })
  }
  res.write = (text) => {
    if (res.destroyed || res.writableEnded) throw new Error('write after end')
    res.frames.push(String(text))
    if (typeof opts.writeResult === 'function') return opts.writeResult(String(text), res) !== false
    return true
  }
  res.end = () => { res.writableEnded = true }
  res.destroy = () => {
    if (res.destroyed) return
    res.destroyed = true
    res.emit('close')
  }
  return res
}

function makeAdapter(opts = {}) {
  const res = opts.res || makeRes(opts.resOpts)
  const usages = []
  const adapter = createCodexStreamAdapter(res, {
    plan: opts.plan || makePlan(),
    route: opts.route || ROUTE,
    model: 'codex-gpt',
    id: 'resp_test',
    createdAt: 1760000000,
    onUsage: (u) => usages.push(u),
    writeTimeoutMs: opts.writeTimeoutMs,
    maxBufferBytes: opts.maxBufferBytes,
  })
  return { res, adapter, usages }
}

function writtenFrames(res) {
  return res.frames.map((raw) => {
    const lines = raw.split('\n')
    const evLine = lines.find((l) => l.startsWith('event:')) || ''
    const dataLines = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, ''))
    const data = dataLines.join('\n')
    let parsed = null
    try { parsed = data ? JSON.parse(data) : null } catch { parsed = data }
    return { raw, type: evLine.slice(6).trim(), data: parsed }
  })
}

function parseBlockData(block) {
  return block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n')
}

function pickIdentity(item) {
  return {
    id: item.id,
    type: item.type,
    call_id: item.call_id,
    name: item.name,
    namespace: item.namespace,
    arguments: item.arguments,
    encrypted_function_args: item.encrypted_function_args,
  }
}

test('P04 严格支持列表：终态仅 completed/failed/incomplete', () => {
  for (const t of ['response.completed', 'response.failed', 'response.incomplete']) assert.equal(isCodexTerminalEvent(t), true)
  for (const t of ['response.created', 'response.output_item.done', 'response.output_text.delta', 'response.in_progress', '', '[DONE]', null, undefined]) {
    assert.equal(isCodexTerminalEvent(t), false)
  }
})

test('P04 A1 Chat 桥流入口保持导出（原生适配层不替换它）', () => {
  assert.equal(typeof createResponsesStream, 'function')
  assert.equal(typeof createCodexStreamAdapter, 'function')
})

test('P04 解析器：多帧增量、注释块、空行跳过', () => {
  const p = createCodexSSEParser()
  const f1 = frame('response.created', { sequence_number: 1 })
  const f2 = frame('response.output_text.delta', { sequence_number: 2, delta: 'hi' })
  assert.deepEqual(p.push(f1 + f2), [f1, f2].map((s) => s.replace(/\n\n$/, '')))
  assert.deepEqual(p.push(': keepalive\n\n'), [': keepalive'])
  assert.deepEqual(p.push('\n\n'), [])
  assert.deepEqual(p.push(''), [])
})

test('P04 解析器：flush 吐出残帧，二次 flush 为空', () => {
  const p = createCodexSSEParser()
  const partial = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"tail"}'
  assert.deepEqual(p.push(partial), [])
  assert.deepEqual(p.flush(), [partial])
  assert.deepEqual(p.flush(), [])
})

test('P04 解析器：UTF-8 多字节逐字节分片仍完整', () => {
  const raw = Buffer.from('event: response.output_text.delta\ndata: ' + JSON.stringify({ type: 'response.output_text.delta', delta: '中文流式网关' }) + '\n\n')
  const p = createCodexSSEParser()
  const blocks = []
  for (let i = 0; i < raw.length; i += 1) blocks.push(...p.push(raw.subarray(i, i + 1)))
  assert.equal(blocks.length, 1)
  assert.equal(JSON.parse(parseBlockData(blocks[0])).delta, '中文流式网关')
})

test('P04 解析器：CRLF、纯 CR、跨分片 CRLF 等价', () => {
  const lf = frame('response.output_text.delta', { sequence_number: 1, delta: '行' })
  const p1 = createCodexSSEParser()
  const crlfBlocks = p1.push(lf.replace(/\n/g, '\r\n'))
  assert.equal(crlfBlocks.length, 1)
  assert.equal(JSON.parse(parseBlockData(crlfBlocks[0])).delta, '行')
  const crlf = lf.replace(/\n/g, '\r\n')
  const p2 = createCodexSSEParser()
  assert.deepEqual(p2.push(crlf.slice(0, crlf.length - 3)), [])
  assert.equal(p2.push(crlf.slice(crlf.length - 3)).length, 1)
  const p3 = createCodexSSEParser()
  assert.deepEqual(p3.push(lf.replace(/\n/g, '\r')), [])
  const tail = p3.flush()
  assert.equal(tail.length, 1)
  assert.equal(JSON.parse(parseBlockData(tail[0])).delta, '行')
})

test('P04 解析器：多行 data 保留，超长单帧跨分片不截断', () => {
  const multi = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta",\ndata: "delta":"多行"}\n\n'
  const p = createCodexSSEParser()
  const blocks = p.push(multi)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].split('\n').filter((l) => l.startsWith('data:')).length, 2)
  assert.equal(JSON.parse(parseBlockData(blocks[0])).delta, '多行')
  const bigText = 'x'.repeat(512 * 1024)
  const big = Buffer.from(frame('response.output_text.delta', { sequence_number: 9, delta: bigText }))
  const p2 = createCodexSSEParser()
  const out = []
  for (let i = 0; i < big.length; i += 64 * 1024) out.push(...p2.push(big.subarray(i, i + 64 * 1024)))
  assert.equal(out.length, 1)
  assert.equal(JSON.parse(parseBlockData(out[0])).delta.length, bigText.length)
})

test('P04 适配器：非关键帧逐字节透传、首帧写 SSE 头、events 记录', async () => {
  const { res, adapter } = makeAdapter()
  const f1 = created(1)
  const f2 = frame('response.output_text.delta', { sequence_number: 2, item_id: 'msg_1', output_index: 0, content_index: 0, delta: '你好' })
  await adapter.push(f1 + f2)
  assert.equal(res.frames.join(''), f1 + f2)
  assert.equal(adapter.terminal, null)
  assert.equal(adapter.usage, null)
  assert.deepEqual(adapter.events.map((e) => e.type), ['response.created', 'response.output_text.delta'])
  assert.equal(adapter.events[1].data.delta, '你好')
  assert.equal(res.headerCalls.length, 1)
  assert.equal(res.headerCalls[0].status, 200)
  assert.match(String(res.headerCalls[0].headers['content-type']), /text\/event-stream/)
})

test('P04 适配器：UTF-8 中文跨 chunk 分片不损坏；无 event: 行按 data.type 识别', async () => {
  const { res, adapter } = makeAdapter()
  const raw = frame('response.output_text.delta', { sequence_number: 2, delta: '中文流式网关' })
  const buf = Buffer.from(raw)
  const cut = Buffer.byteLength(raw.slice(0, raw.indexOf('中文流式网关'))) + 1
  await adapter.push(buf.subarray(0, cut))
  await adapter.push(buf.subarray(cut))
  assert.equal(res.frames.join(''), raw)
  assert.equal(adapter.events[0].data.delta, '中文流式网关')
  const second = makeAdapter()
  await second.adapter.push('data: ' + JSON.stringify({ type: 'response.output_text.delta', sequence_number: 1, delta: 'no-event-line' }) + '\n\n')
  assert.equal(second.adapter.events[0].type, 'response.output_text.delta')
})

test('P04 适配器：added 只恢复身份，done 才补 marker；id/call_id/序号保持', async () => {
  const { res, adapter } = makeAdapter()
  const t = toolSequence()
  await adapter.push(t.added + t.delta + t.argsDone + t.done)
  const evs = adapter.events
  assert.equal(evs.length, 4)
  const a = evs[0].data.item
  const d = evs[3].data.item
  assert.equal(a.id, d.id)
  assert.equal(a.call_id, d.call_id)
  assert.equal(evs[0].data.output_index, 0)
  assert.equal(evs[3].data.output_index, 0)
  assert.equal(a.namespace, 'collaboration')
  assert.equal(a.name, 'spawn_agent')
  assert.equal(Object.prototype.hasOwnProperty.call(a, 'encrypted_function_args'), false)
  assert.equal(d.namespace, 'collaboration')
  assert.equal(d.name, 'spawn_agent')
  assert.deepEqual(d.encrypted_function_args, [])
  assert.equal(d.arguments, '{"task_name":"w"}')
  assert.equal(d.call_id, 'call_1')
  assert.deepEqual(evs.map((e) => e.data.sequence_number), [2, 3, 4, 5])
  const out = writtenFrames(res)
  assert.equal(out[0].data.item.encrypted_function_args, undefined)
  assert.deepEqual(out[3].data.item.encrypted_function_args, [])
})

test('P04 适配器：并行/反序分片按 output_index 保持顺序与各自身份', async () => {
  const { adapter } = makeAdapter()
  const a = toolSequence({ name: 'spawn_agent', callId: 'call_a', itemId: 'fc_a', outputIndex: 0, seqA: 2, seqD: 3, seqAD: 4, seqDone: 8 })
  const b = toolSequence({ name: 'send_message', callId: 'call_b', itemId: 'fc_b', outputIndex: 1, seqA: 3, seqD: 4, seqAD: 5, seqDone: 9 })
  const deltaA = frame('response.function_call_arguments.delta', { sequence_number: 3, item_id: 'fc_a', output_index: 0, delta: '{"task' })
  const deltaB = frame('response.function_call_arguments.delta', { sequence_number: 4, item_id: 'fc_b', output_index: 1, delta: '{"target"' })
  await adapter.push(a.added + b.added + deltaA + deltaB + b.done + a.done)
  assert.deepEqual(adapter.events.map((e) => [e.type, e.data.output_index]), [
    ['response.output_item.added', 0],
    ['response.output_item.added', 1],
    ['response.function_call_arguments.delta', 0],
    ['response.function_call_arguments.delta', 1],
    ['response.output_item.done', 1],
    ['response.output_item.done', 0],
  ])
  const evs = adapter.events
  assert.equal(evs[0].data.item.id, 'fc_a')
  assert.equal(evs[1].data.item.id, 'fc_b')
  assert.equal(evs[4].data.item.name, 'send_message')
  assert.equal(evs[5].data.item.name, 'spawn_agent')
  assert.deepEqual(evs[4].data.item.encrypted_function_args, [])
  assert.deepEqual(evs[5].data.item.encrypted_function_args, [])
})

test('P04 适配器：重复 added 不重编号不吞帧', async () => {
  const { adapter } = makeAdapter()
  const t = toolSequence()
  await adapter.push(t.added + t.added)
  assert.equal(adapter.events.length, 2)
  assert.deepEqual(pickIdentity(adapter.events[0].data.item), pickIdentity(adapter.events[1].data.item))
  assert.equal(adapter.events[0].data.sequence_number, 2)
  assert.equal(adapter.events[1].data.sequence_number, 2)
})

test('P04 适配器：done 缺失时 completed.output[] 仍恢复身份与 marker', async () => {
  const { adapter } = makeAdapter()
  const t = toolSequence()
  await adapter.push(t.added + frame('response.completed', { sequence_number: 6, response: responseObj({ output: [t.doneItem] }) }))
  const item = adapter.events[adapter.events.length - 1].data.response.output[0]
  assert.equal(item.id, 'fc_1')
  assert.equal(item.call_id, 'call_1')
  assert.equal(item.name, 'spawn_agent')
  assert.equal(item.namespace, 'collaboration')
  assert.deepEqual(item.encrypted_function_args, [])
  assert.equal(item.arguments, '{"task_name":"w"}')
  assert.equal(adapter.terminal, 'response.completed')
})

test('P04 适配器：普通函数工具不补 namespace/marker', async () => {
  const { adapter } = makeAdapter()
  const item = flatTool('read_file', 'call_r', 'fc_r', { arguments: '{"path":"a"}' })
  await adapter.push(frame('response.output_item.done', { sequence_number: 2, output_index: 0, item }))
  const out = adapter.events[0].data.item
  assert.equal(out.namespace, undefined)
  assert.equal(out.encrypted_function_args, undefined)
  assert.equal(out.name, 'read_file')
  assert.equal(out.call_id, 'call_r')
})

test('P04 适配器：completed.output[] 逐项恢复，usage 只记一次且原值保留', async () => {
  const { adapter, usages } = makeAdapter()
  const usage = { input_tokens: 11, output_tokens: 7, total_tokens: 18, output_tokens_details: { reasoning_tokens: 2 } }
  const t1 = toolSequence({ name: 'spawn_agent', callId: 'call_1', itemId: 'fc_1' })
  const t2 = toolSequence({ name: 'send_message', callId: 'call_2', itemId: 'fc_2', outputIndex: 1 })
  const completed = frame('response.completed', { sequence_number: 9, response: responseObj({ output: [t1.doneItem, t2.doneItem], usage }) })
  await adapter.push(t1.added + t2.added + completed)
  assert.equal(adapter.terminal, 'response.completed')
  assert.equal(usages.length, 1)
  assert.deepEqual(usages[0], usage)
  assert.deepEqual(adapter.usage, usage)
  const output = adapter.events[adapter.events.length - 1].data.response.output
  assert.equal(output.length, 2)
  for (const item of output) {
    assert.equal(item.namespace, 'collaboration')
    assert.deepEqual(item.encrypted_function_args, [])
  }
  assert.deepEqual(output.map((i) => i.call_id), ['call_1', 'call_2'])
})

test('P04 适配器：completed 缺 output/output_text/usage 时补空并记 0，不臆造', async () => {
  const { adapter, usages } = makeAdapter()
  await adapter.push(frame('response.completed', { sequence_number: 3, response: { id: 'resp_up', object: 'response', status: 'completed', model: 'gpt-6.1-sol' } }))
  const resp = adapter.events[0].data.response
  assert.deepEqual(resp.output, [])
  assert.equal(resp.output_text, '')
  assert.equal(usages.length, 1)
  assert.deepEqual(usages[0], { input_tokens: 0, output_tokens: 0, total_tokens: 0 })
  assert.equal(adapter.terminal, 'response.completed')
})

test('P04 适配器：缺 output_text 时按 output 文本补，不伪造 item', async () => {
  const { adapter } = makeAdapter()
  const item = { id: 'msg_1', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: '汇总', annotations: [] }] }
  await adapter.push(frame('response.completed', { sequence_number: 2, response: responseObj({ output: [item] }) }))
  assert.equal(adapter.events[0].data.response.output_text, '汇总')
  assert.equal(adapter.events[0].data.response.output[0].id, 'msg_1')
})

test('P04 适配器：终态后帧全部忽略，usage 不重复', async () => {
  const { res, adapter, usages } = makeAdapter()
  const completed = frame('response.completed', { sequence_number: 2, response: responseObj({ usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }) })
  await adapter.push(completed)
  const framesAfter = res.frames.length
  const eventsAfter = adapter.events.length
  await adapter.push(frame('response.output_text.delta', { sequence_number: 3, delta: 'late' }))
  await adapter.push(frame('response.completed', { sequence_number: 4, response: responseObj({ usage: { input_tokens: 99 } }) }))
  await adapter.push(frame('response.failed', { sequence_number: 5, response: responseObj({ status: 'failed' }) }))
  assert.equal(res.frames.length, framesAfter)
  assert.equal(adapter.events.length, eventsAfter)
  assert.equal(usages.length, 1)
  assert.equal(adapter.terminal, 'response.completed')
})

test('P04 适配器：Responses 流中的 [DONE] 丢弃，不写出', async () => {
  const { res, adapter } = makeAdapter()
  await adapter.push(created(1) + 'data: [DONE]\n\n')
  assert.ok(!res.frames.join('').includes('[DONE]'))
  assert.equal(adapter.events.length, 1)
  assert.equal(adapter.events[0].type, 'response.created')
})

test('P04 适配器：response.incomplete 是终态，output[] 恢复身份且 status/details 保留', async () => {
  const { res, adapter, usages } = makeAdapter()
  const item = flatTool('spawn_agent', 'call_inc', 'fc_inc', { arguments: '{"task_name":"w"}' })
  const incomplete = frame('response.incomplete', {
    sequence_number: 2,
    response: responseObj({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [item] }),
  })
  await adapter.push(incomplete + frame('response.output_text.delta', { sequence_number: 3, delta: 'late' }))
  assert.equal(adapter.terminal, 'response.incomplete')
  assert.equal(adapter.events.length, 1)
  assert.equal(usages.length, 1)
  assert.deepEqual(usages[0], { input_tokens: 0, output_tokens: 0, total_tokens: 0 })
  const ev = adapter.events[0]
  assert.equal(ev.data.response.status, 'incomplete')
  assert.deepEqual(ev.data.response.incomplete_details, { reason: 'max_output_tokens' })
  const restored = ev.data.response.output[0]
  assert.equal(restored.namespace, 'collaboration')
  assert.equal(restored.name, 'spawn_agent')
  assert.deepEqual(restored.encrypted_function_args, [])
  assert.equal(restored.call_id, 'call_inc')
  const lastFrame = writtenFrames(res).pop()
  assert.equal(lastFrame.type, 'response.incomplete')
  assert.equal(lastFrame.data.response.output[0].namespace, 'collaboration')
})

test('P04 适配器：incomplete 中普通工具项不带 namespace/marker', async () => {
  const { adapter, usages } = makeAdapter()
  const item = flatTool('read_file', 'call_inc_r', 'fc_inc_r', { arguments: '{"path":"a"}' })
  const incomplete = frame('response.incomplete', { sequence_number: 2, response: responseObj({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [item] }) })
  await adapter.push(incomplete)
  assert.equal(usages.length, 1)
  const restored = adapter.events[0].data.response.output[0]
  assert.equal(restored.namespace, undefined)
  assert.equal(restored.encrypted_function_args, undefined)
  assert.equal(restored.name, 'read_file')
})

test('P04 适配器：终态前 EOF → 合成 response.failed STREAM_INTERRUPTED，不重发旧帧', async () => {
  const { res, adapter, usages } = makeAdapter()
  const t = toolSequence()
  await adapter.push(created(1) + t.added + t.done)
  const before = res.frames.length
  await adapter.end()
  const frames = writtenFrames(res)
  assert.equal(res.frames.length, before + 1)
  const last = frames[frames.length - 1]
  assert.equal(last.type, 'response.failed')
  assert.equal(last.data.error.code, 'STREAM_INTERRUPTED')
  assert.match(String(last.data.error.message), /terminal/i)
  assert.equal(adapter.terminal, 'response.failed')
  assert.equal(res.writableEnded, true)
  assert.equal(usages.length, 1)
  assert.deepEqual(usages[0], { input_tokens: 0, output_tokens: 0, total_tokens: 0 })
  assert.equal(writtenFrames(res).filter((f) => f.type === 'response.output_item.done').length, 1)
  assert.equal(writtenFrames(res).filter((f) => f.type === 'response.completed').length, 0)
  assert.equal(last.data.sequence_number, 6)
})

test('P04 适配器：end() 幂等；终态后 end() 不追加失败帧', async () => {
  const first = makeAdapter()
  await first.adapter.push(created(1))
  await first.adapter.end()
  const n = first.res.frames.length
  await first.adapter.end()
  assert.equal(first.res.frames.length, n)
  const second = makeAdapter()
  await second.adapter.push(frame('response.completed', { sequence_number: 2, response: responseObj({ usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } }) }))
  const m = second.res.frames.length
  await second.adapter.end()
  assert.equal(second.res.frames.length, m)
  assert.equal(writtenFrames(second.res).filter((f) => f.type === 'response.failed').length, 0)
})

test('P04 适配器：显式 fail 写一次，重复 fail 幂等', async () => {
  const { res, adapter, usages } = makeAdapter()
  await adapter.push(created(1))
  await adapter.fail('upstream socket reset', {})
  const frames = writtenFrames(res)
  const last = frames[frames.length - 1]
  assert.equal(last.type, 'response.failed')
  assert.equal(last.data.error.code, 'STREAM_INTERRUPTED')
  assert.match(last.data.error.message, /socket reset/)
  assert.equal(res.writableEnded, true)
  assert.equal(usages.length, 1)
  await adapter.fail('again', {})
  assert.equal(writtenFrames(res).filter((f) => f.type === 'response.failed').length, 1)
})

test('P04 适配器：上游非空 encrypted_function_args 显式失败，不覆盖成 []', async () => {
  const { res, adapter, usages } = makeAdapter()
  const opaque = flatTool('spawn_agent', 'call_x', 'fc_x', { encrypted_function_args: ['ciphertext'] })
  await adapter.push(frame('response.output_item.done', { sequence_number: 2, output_index: 0, item: opaque }))
  const frames = writtenFrames(res)
  const last = frames[frames.length - 1]
  assert.equal(last.type, 'response.failed')
  assert.equal(last.data.error.code, 'opaque_function_args')
  assert.equal(adapter.terminal, 'response.failed')
  assert.equal(usages.length, 1)
  assert.ok(!res.frames.join('').includes('ciphertext'))
  assert.equal(frames.filter((f) => f.type === 'response.output_item.done').length, 0)
})

test('P04 适配器：工具项未知字段显式失败（不猜测）', async () => {
  const { adapter } = makeAdapter()
  const item = flatTool('spawn_agent', 'call_unknown', 'fc_unknown', { internal_meta: { keep: true } })
  await adapter.push(frame('response.output_item.done', { sequence_number: 2, output_index: 0, item }))
  assert.equal(adapter.terminal, 'response.failed')
  assert.equal(adapter.events[adapter.events.length - 1].data.error.code, 'opaque_function_args')
})

test('P04 背压：write false 暂停，drain 后继续', async () => {
  let blockOnce = true
  const res = makeRes({ writeResult: () => { if (blockOnce) { blockOnce = false; return false } return true } })
  const { adapter } = makeAdapter({ res })
  let settled = false
  const p = adapter.push(created(1) + created(2)).then(() => { settled = true })
  await new Promise((r) => setImmediate(r))
  assert.equal(settled, false)
  assert.equal(res.frames.length, 1)
  res.emit('drain')
  await p
  assert.equal(settled, true)
  assert.equal(res.frames.length, 2)
})

test('P04 背压：等待超时 → clientStalled，未写出缓冲超限 → 拒绝，客户端断开 → clientGone', async () => {
  const timed = makeAdapter({ res: makeRes({ writeResult: () => false }), writeTimeoutMs: 25 })
  await assert.rejects(timed.adapter.push(created(1)), (e) => e && e.clientStalled === true && e.code === 'EWOULDBLOCK')
  assert.equal(timed.res.destroyed, true)

  const big = makeRes()
  big.writableLength = 8 * 1024 * 1024 + 1
  const limited = makeAdapter({ res: big })
  await assert.rejects(limited.adapter.push(created(1)), (e) => e && e.clientStalled === true)
  assert.equal(big.destroyed, true)
  assert.equal(big.frames.length, 0)

  const gone = makeRes()
  const adapterGone = makeAdapter({ res: gone })
  gone.destroyed = true
  await assert.rejects(adapterGone.adapter.push(created(1)), (e) => e && e.clientGone === true && e.code === 'ECANCELED')
})

test('P04 JSON 与 SSE 恢复出的工具身份字段完全相同', async () => {
  const { adapter } = makeAdapter()
  const doneItem = flatTool('spawn_agent', 'call_9', 'fc_9', { arguments: '{"task_name":"w"}' })
  await adapter.push(frame('response.output_item.done', { sequence_number: 2, output_index: 0, item: doneItem }))
  const sseItem = adapter.events[0].data.item
  const json = responseObj({ output: [flatTool('spawn_agent', 'call_9', 'fc_9', { arguments: '{"task_name":"w"}', encrypted_function_args: [] })] })
  const restored = restoreResponseJson(json, ROUTE, makePlan())
  assert.ok(!restored.rejected, JSON.stringify(restored.rejected))
  assert.deepEqual(pickIdentity(restored.json.output[0]), pickIdentity(sseItem))
})

test('P04 适配器：恢复身份时保留事件级字段与已知 item 字段', async () => {
  const { adapter } = makeAdapter()
  const item = flatTool('spawn_agent', 'call_keep', 'fc_keep', { arguments: '{"task_name":"w"}' })
  await adapter.push(frame('response.output_item.done', { sequence_number: 7, output_index: 3, item }))
  const ev = adapter.events[0]
  assert.equal(ev.data.sequence_number, 7)
  assert.equal(ev.data.output_index, 3)
  assert.equal(ev.data.item.arguments, '{"task_name":"w"}')
  assert.equal(ev.data.item.call_id, 'call_keep')
  assert.equal(ev.data.item.id, 'fc_keep')
  assert.equal(ev.data.item.status, 'completed')
  assert.equal(ev.data.item.type, 'function_call')
})
