// MG-017 T3：Codex 原生 Responses SSE 增量适配层离线契约测试（契约 §4.2 / §8）。
// 只用内存假 res 与合成 SSE 帧：不联网、不读用户配置、不写持久文件、不启动网关。
// 覆盖：UTF-8 跨分片、CRLF/CR、多行 data、注释、flush、超长帧、并行交错工具、
// added/done/completed 三处身份一致、done 补 marker、重复 added、done 缺失、终态唯一、
// 终态后忽略、[DONE] 丢弃、usage 一次、断流 STREAM_INTERRUPTED、背压 drain、JSON/SSE 身份一致。
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  createSSEParser,
  createCodexStreamAdapter,
  isTerminalEvent,
} from '../../../src/codex-responses-stream.js'
import { restoreResponseJson } from '../../../src/codex-responses.js'
import { startGateway, startScriptedUpstream } from './harness.mjs'

// ── 路由 / 工具计划夹具（形状取契约 §4.1） ──────────────────────────────
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
      kind: 'namespace', name, namespace: 'collaboration', messagePlaintext: true, restoredName: name,
    })
  }
  for (const name of plainFunctions) {
    declared.set(name, {
      kind: 'function', name, namespace: null, messagePlaintext: false, restoredName: name,
    })
  }
  return { declared, declarations: undefined, toolChoice: undefined, lossy: [] }
}

// ── SSE 帧构造 ──────────────────────────────────────────────────────────
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

// 与 Lead 实测 Codex 0.167.0 可执行的形状一致（added 无 marker，done/completed 带 namespace+marker）。
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

// ── 假 res ──────────────────────────────────────────────────────────────
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
    log: opts.log,
    writeTimeoutMs: opts.writeTimeoutMs,
    maxBufferBytes: opts.maxBufferBytes,
  })
  return { res, adapter, usages }
}

// 把已写出的帧解析回事件（只用于测试）。
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

// ── 1. isTerminalEvent ─────────────────────────────────────────────────
test('isTerminalEvent 只认 completed/failed/incomplete', () => {
  assert.equal(isTerminalEvent('response.completed'), true)
  assert.equal(isTerminalEvent('response.failed'), true)
  assert.equal(isTerminalEvent('response.incomplete'), true)
  for (const t of ['response.created', 'response.output_item.done', 'response.output_text.delta', 'response.in_progress', '', '[DONE]', null, undefined]) {
    assert.equal(isTerminalEvent(t), false)
  }
})

// ── 2. 解析器：基础分帧、注释、空行、flush ─────────────────────────────
test('解析器：多帧增量、注释块、空行跳过', () => {
  const p = createSSEParser()
  const f1 = frame('response.created', { sequence_number: 1 })
  const f2 = frame('response.output_text.delta', { sequence_number: 2, delta: 'hi' })
  assert.deepEqual(p.push(f1 + f2), [f1, f2].map((s) => s.replace(/\n\n$/, '')))
  assert.deepEqual(p.push(': keepalive\n\n'), [': keepalive'])
  assert.deepEqual(p.push('\n\n'), [])
  assert.deepEqual(p.push(''), [])
})

test('解析器：flush 吐出未以空行结束的残帧，二次 flush 为空', () => {
  const p = createSSEParser()
  const partial = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"tail"}'
  assert.deepEqual(p.push(partial), [])
  assert.deepEqual(p.flush(), [partial])
  assert.deepEqual(p.flush(), [])
})

// ── 3. 解析器：UTF-8 多字节跨 chunk（逐字节喂） ────────────────────────
test('解析器：UTF-8 多字节被拆到多个 Buffer 分片仍完整', () => {
  const raw = Buffer.from('event: response.output_text.delta\ndata: ' +
    JSON.stringify({ type: 'response.output_text.delta', delta: '中文流式网关' }) + '\n\n')
  const p = createSSEParser()
  const blocks = []
  for (let i = 0; i < raw.length; i += 1) blocks.push(...p.push(raw.subarray(i, i + 1)))
  assert.equal(blocks.length, 1)
  assert.equal(JSON.parse(parseBlockData(blocks[0])).delta, '中文流式网关')
})

// ── 4. 解析器：CRLF / CR / CRLF 跨分片 ─────────────────────────────────
test('解析器：CRLF、CR 与跨分片 CRLF 等价', () => {
  const lf = frame('response.output_text.delta', { sequence_number: 1, delta: '行' })
  const p1 = createSSEParser()
  const crlfBlocks = p1.push(lf.replace(/\n/g, '\r\n'))
  assert.equal(crlfBlocks.length, 1)
  assert.equal(JSON.parse(parseBlockData(crlfBlocks[0])).delta, '行')

  // CRLF 恰被切在 \r 与 \n 之间（前一分片以 \r 结尾）
  const p2 = createSSEParser()
  const crlf = lf.replace(/\n/g, '\r\n')
  assert.deepEqual(p2.push(crlf.slice(0, crlf.length - 3)), [])
  assert.equal(p2.push(crlf.slice(crlf.length - 3)).length, 1)

  // 纯 CR：残帧由 flush 收尾
  const p3 = createSSEParser()
  assert.deepEqual(p3.push(lf.replace(/\n/g, '\r')), [])
  const tail = p3.flush()
  assert.equal(tail.length, 1)
  assert.equal(JSON.parse(parseBlockData(tail[0])).delta, '行')
})

// ── 5. 解析器：多行 data 与超长单帧 ────────────────────────────────────
test('解析器：多行 data 保留多行，超长单帧跨分片不截断', () => {
  const multi = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta",\ndata: "delta":"多行"}\n\n'
  const p = createSSEParser()
  const blocks = p.push(multi)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].split('\n').filter((l) => l.startsWith('data:')).length, 2)
  assert.equal(JSON.parse(parseBlockData(blocks[0])).delta, '多行')

  const bigText = 'x'.repeat(2 * 1024 * 1024)
  const big = Buffer.from(frame('response.output_text.delta', { sequence_number: 9, delta: bigText }))
  const p2 = createSSEParser()
  const out = []
  for (let i = 0; i < big.length; i += 64 * 1024) out.push(...p2.push(big.subarray(i, i + 64 * 1024)))
  assert.equal(out.length, 1)
  assert.equal(JSON.parse(parseBlockData(out[0])).delta.length, bigText.length)
})

// ── 6. 适配器：非关键帧原样透传 / 事件记录 / 响应头 ────────────────────
test('适配器：非关键帧逐字节透传、首帧写 SSE 头、events 记录', async () => {
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

test('适配器：UTF-8 中文跨 chunk 分片不损坏', async () => {
  const { res, adapter } = makeAdapter()
  const raw = frame('response.output_text.delta', { sequence_number: 2, delta: '中文流式网关' })
  const buf = Buffer.from(raw)
  const textAt = raw.indexOf('中文流式网关')
  const cut = Buffer.byteLength(raw.slice(0, textAt)) + 1 // 切在「中」的多字节中间
  await adapter.push(buf.subarray(0, cut))
  await adapter.push(buf.subarray(cut))
  assert.equal(res.frames.join(''), raw)
  assert.equal(adapter.events[0].data.delta, '中文流式网关')
})

test('适配器：无 event: 行时按 data.type 识别事件', async () => {
  const { adapter } = makeAdapter()
  const f = 'data: ' + JSON.stringify({ type: 'response.output_text.delta', sequence_number: 1, delta: 'no-event-line' }) + '\n\n'
  await adapter.push(f)
  assert.equal(adapter.events.length, 1)
  assert.equal(adapter.events[0].type, 'response.output_text.delta')
})

// ── 7. 工具身份恢复：added / done / completed 三处一致 ─────────────────
test('适配器：added 只恢复 namespace/原名，done 才补 encrypted_function_args:[]', async () => {
  const { res, adapter } = makeAdapter()
  const t = toolSequence()
  await adapter.push(t.added + t.delta + t.argsDone + t.done)
  const evs = adapter.events
  assert.equal(evs.length, 4)
  const added = evs[0]
  const done = evs[3]
  assert.equal(added.type, 'response.output_item.added')
  assert.equal(done.type, 'response.output_item.done')

  const a = added.data.item
  const d = done.data.item
  // 身份三处一致（id / call_id / output_index）
  assert.equal(a.id, d.id)
  assert.equal(a.call_id, d.call_id)
  assert.equal(added.data.output_index, 0)
  assert.equal(done.data.output_index, 0)
  // added 只恢复身份，不带 marker
  assert.equal(a.namespace, 'collaboration')
  assert.equal(a.name, 'spawn_agent')
  assert.equal(a.encrypted_function_args, undefined)
  assert.ok(!Object.prototype.hasOwnProperty.call(a, 'encrypted_function_args'))
  // done 恢复身份 + marker
  assert.equal(d.namespace, 'collaboration')
  assert.equal(d.name, 'spawn_agent')
  assert.deepEqual(d.encrypted_function_args, [])
  // arguments / call_id 原值，不重算
  assert.equal(d.arguments, '{"task_name":"w"}')
  assert.equal(d.call_id, 'call_1')
  // sequence_number 不重编号
  assert.deepEqual(evs.map((e) => e.data.sequence_number), [2, 3, 4, 5])
  // 写出的 added 帧确实无 marker；done 帧有
  const out = writtenFrames(res)
  assert.equal(out[0].data.item.encrypted_function_args, undefined)
  assert.deepEqual(out[3].data.item.encrypted_function_args, [])
})

test('适配器：并行交错工具按 output_index 保持顺序与各自身份', async () => {
  const { adapter } = makeAdapter()
  const a = toolSequence({ name: 'spawn_agent', callId: 'call_a', itemId: 'fc_a', outputIndex: 0, seqA: 2, seqD: 3, seqAD: 4, seqDone: 8 })
  const b = toolSequence({ name: 'send_message', callId: 'call_b', itemId: 'fc_b', outputIndex: 1, seqA: 3, seqD: 4, seqAD: 5, seqDone: 9 })
  const deltaA = frame('response.function_call_arguments.delta', { sequence_number: 3, item_id: 'fc_a', output_index: 0, delta: '{"task' })
  const deltaB = frame('response.function_call_arguments.delta', { sequence_number: 4, item_id: 'fc_b', output_index: 1, delta: '{"target"' })
  await adapter.push(a.added + b.added + deltaA + deltaB + b.done + a.done)
  const evs = adapter.events
  assert.deepEqual(evs.map((e) => [e.type, e.data.output_index]), [
    ['response.output_item.added', 0],
    ['response.output_item.added', 1],
    ['response.function_call_arguments.delta', 0],
    ['response.function_call_arguments.delta', 1],
    ['response.output_item.done', 1],
    ['response.output_item.done', 0],
  ])
  const addedA = evs[0].data.item
  const addedB = evs[1].data.item
  const doneB = evs[4].data.item
  const doneA = evs[5].data.item
  assert.equal(addedA.id, 'fc_a'); assert.equal(addedA.call_id, 'call_a')
  assert.equal(addedB.id, 'fc_b'); assert.equal(addedB.call_id, 'call_b')
  assert.equal(doneA.id, 'fc_a'); assert.equal(doneA.call_id, 'call_a'); assert.equal(doneA.name, 'spawn_agent')
  assert.equal(doneB.id, 'fc_b'); assert.equal(doneB.call_id, 'call_b'); assert.equal(doneB.name, 'send_message')
  assert.deepEqual(doneA.encrypted_function_args, [])
  assert.deepEqual(doneB.encrypted_function_args, [])
})

test('适配器：重复 added 原样保留身份，不重编号不吞帧', async () => {
  const { adapter } = makeAdapter()
  const t = toolSequence()
  await adapter.push(t.added + t.added)
  assert.equal(adapter.events.length, 2)
  assert.deepEqual(pickIdentity(adapter.events[0].data.item), pickIdentity(adapter.events[1].data.item))
  assert.equal(adapter.events[0].data.output_index, adapter.events[1].data.output_index)
  assert.equal(adapter.events[0].data.sequence_number, 2)
  assert.equal(adapter.events[1].data.sequence_number, 2)
})

test('适配器：done 缺失时 completed.output[] 仍恢复身份与 marker', async () => {
  const { adapter } = makeAdapter()
  const t = toolSequence()
  const completed = frame('response.completed', {
    sequence_number: 6,
    response: responseObj({ output: [t.doneItem] }),
  })
  await adapter.push(t.added + completed)
  const completedEv = adapter.events[adapter.events.length - 1]
  assert.equal(completedEv.type, 'response.completed')
  const item = completedEv.data.response.output[0]
  assert.equal(item.id, 'fc_1')
  assert.equal(item.call_id, 'call_1')
  assert.equal(item.name, 'spawn_agent')
  assert.equal(item.namespace, 'collaboration')
  assert.deepEqual(item.encrypted_function_args, [])
  assert.equal(item.arguments, '{"task_name":"w"}')
  assert.equal(adapter.terminal, 'response.completed')
})

test('适配器：普通函数工具不补 namespace/marker', async () => {
  const { adapter } = makeAdapter()
  const item = flatTool('read_file', 'call_r', 'fc_r', { arguments: '{"path":"a"}' })
  await adapter.push(frame('response.output_item.done', { sequence_number: 2, output_index: 0, item }))
  const out = adapter.events[0].data.item
  assert.equal(out.namespace, undefined)
  assert.equal(out.encrypted_function_args, undefined)
  assert.equal(out.name, 'read_file')
  assert.equal(out.call_id, 'call_r')
})

// ── 8. completed 帧与 usage ────────────────────────────────────────────
test('适配器：completed.output[] 逐项恢复，usage 只记一次且原值保留', async () => {
  const { adapter, usages } = makeAdapter()
  const usage = { input_tokens: 11, output_tokens: 7, total_tokens: 18, output_tokens_details: { reasoning_tokens: 2 } }
  const t1 = toolSequence({ name: 'spawn_agent', callId: 'call_1', itemId: 'fc_1' })
  const t2 = toolSequence({ name: 'send_message', callId: 'call_2', itemId: 'fc_2', outputIndex: 1 })
  const completed = frame('response.completed', {
    sequence_number: 9,
    response: responseObj({ output: [t1.doneItem, t2.doneItem], usage }),
  })
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

test('适配器：completed 缺 output 时补 output[] 与 output_text；缺 usage 记 0 不臆造', async () => {
  const { adapter, usages } = makeAdapter()
  const completed = frame('response.completed', {
    sequence_number: 3,
    response: { id: 'resp_up', object: 'response', status: 'completed', model: 'gpt-6.1-sol' },
  })
  await adapter.push(completed)
  const resp = adapter.events[0].data.response
  assert.deepEqual(resp.output, [])
  assert.equal(resp.output_text, '')
  assert.equal(usages.length, 1)
  assert.deepEqual(usages[0], { input_tokens: 0, output_tokens: 0, total_tokens: 0 })
  assert.equal(adapter.terminal, 'response.completed')
})

test('适配器：缺 output_text 时按 output 文本补（不伪造 item）', async () => {
  const { adapter } = makeAdapter()
  const item = { id: 'msg_1', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: '汇总', annotations: [] }] }
  const completed = frame('response.completed', { sequence_number: 2, response: responseObj({ output: [item] }) })
  await adapter.push(completed)
  assert.equal(adapter.events[0].data.response.output_text, '汇总')
  assert.equal(adapter.events[0].data.response.output[0].id, 'msg_1')
})

// ── 9. 终态唯一、终态后忽略、[DONE] 丢弃 ───────────────────────────────
test('适配器：终态后到达的帧全部忽略，usage 不重复', async () => {
  const { res, adapter, usages } = makeAdapter()
  const completed = frame('response.completed', { sequence_number: 2, response: responseObj({ usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }) })
  await adapter.push(completed)
  const framesAfterTerminal = res.frames.length
  const eventsAfterTerminal = adapter.events.length
  await adapter.push(frame('response.output_text.delta', { sequence_number: 3, delta: 'late' }))
  await adapter.push(frame('response.completed', { sequence_number: 4, response: responseObj({ usage: { input_tokens: 99 } }) }))
  await adapter.push(frame('response.failed', { sequence_number: 5, response: responseObj({ status: 'failed' }) }))
  assert.equal(res.frames.length, framesAfterTerminal)
  assert.equal(adapter.events.length, eventsAfterTerminal)
  assert.equal(usages.length, 1)
  assert.equal(adapter.terminal, 'response.completed')
})

test('适配器：Responses 流中的 [DONE] 必须被丢弃，绝不写出', async () => {
  const { res, adapter } = makeAdapter()
  await adapter.push(created(1) + 'data: [DONE]\n\n')
  const out = res.frames.join('')
  assert.ok(!out.includes('[DONE]'))
  assert.equal(adapter.events.length, 1)
  assert.equal(adapter.events[0].type, 'response.created')
})

test('适配器：response.incomplete 也是终态，usage 记 0 一次', async () => {
  const { adapter, usages } = makeAdapter()
  const incomplete = frame('response.incomplete', {
    sequence_number: 2,
    response: responseObj({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }),
  })
  await adapter.push(incomplete + frame('response.output_text.delta', { sequence_number: 3, delta: 'late' }))
  assert.equal(adapter.terminal, 'response.incomplete')
  assert.equal(adapter.events.length, 1)
  assert.equal(usages.length, 1)
  assert.deepEqual(usages[0], { input_tokens: 0, output_tokens: 0, total_tokens: 0 })
})

test('适配器：response.incomplete 的 output[] 也恢复协作工具身份（status/incomplete_details 保留）', async () => {
  const { res, adapter, usages } = makeAdapter()
  const item = flatTool('spawn_agent', 'call_inc', 'fc_inc', { arguments: '{"task_name":"w"}' })
  const incomplete = frame('response.incomplete', {
    sequence_number: 2,
    response: responseObj({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [item],
    }),
  })
  await adapter.push(incomplete)
  assert.equal(adapter.terminal, 'response.incomplete')
  assert.equal(usages.length, 1, 'usage 仍只记一次')
  const ev = adapter.events[0]
  assert.equal(ev.type, 'response.incomplete')
  assert.equal(ev.data.response.status, 'incomplete', 'status 原样保留')
  assert.deepEqual(ev.data.response.incomplete_details, { reason: 'max_output_tokens' }, 'incomplete_details 原样保留')
  const restored = ev.data.response.output[0]
  assert.equal(restored.namespace, 'collaboration', 'incomplete.output[] 恢复 namespace')
  assert.equal(restored.name, 'spawn_agent', 'incomplete.output[] 恢复原名')
  assert.deepEqual(restored.encrypted_function_args, [], '完成项 marker 恢复')
  assert.equal(restored.call_id, 'call_inc', 'call_id 原样')
  assert.equal(restored.arguments, '{"task_name":"w"}', 'arguments 原样')
  // 客户端实际收到的帧也必须是恢复后的形状（不是只在 events 里）
  const lastFrame = writtenFrames(res).pop()
  assert.equal(lastFrame.type, 'response.incomplete')
  assert.equal(lastFrame.data.response.output[0].namespace, 'collaboration')
  assert.equal(lastFrame.data.response.status, 'incomplete')
})

test('适配器：incomplete 中的普通工具项仍不带 namespace/marker', async () => {
  const { res, adapter, usages } = makeAdapter()
  const item = flatTool('read_file', 'call_inc_r', 'fc_inc_r', { arguments: '{"path":"a"}' })
  const incomplete = frame('response.incomplete', {
    sequence_number: 2,
    response: responseObj({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [item],
    }),
  })
  await adapter.push(incomplete)
  assert.equal(adapter.terminal, 'response.incomplete')
  assert.equal(usages.length, 1)
  const restored = adapter.events[0].data.response.output[0]
  assert.equal(restored.namespace, undefined, '普通工具项不注入 namespace')
  assert.equal(restored.encrypted_function_args, undefined, '普通工具项不补 marker')
  assert.equal(restored.name, 'read_file')
  assert.equal(restored.call_id, 'call_inc_r')
  const lastFrame = writtenFrames(res).pop()
  assert.equal(lastFrame.data.response.output[0].namespace, undefined)
})

// ── 10. 断流收尾：不伪造成功、不重发、usage 一次 ────────────────────────
test('适配器：终态前断流 → end() 追加 response.failed STREAM_INTERRUPTED，旧帧不重发', async () => {
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
  // 已送出的可执行 done 事件恰好一次，没有被伪造的 completed
  assert.equal(writtenFrames(res).filter((f) => f.type === 'response.output_item.done').length, 1)
  assert.equal(writtenFrames(res).filter((f) => f.type === 'response.completed').length, 0)
  // 合成失败帧序号沿用上游最后序号 +1，不重编号历史
  assert.equal(last.data.sequence_number, 6)
})

test('适配器：end() 幂等，重复调用不再追加失败帧', async () => {
  const { res, adapter } = makeAdapter()
  await adapter.push(created(1))
  await adapter.end()
  const n = res.frames.length
  await adapter.end()
  assert.equal(res.frames.length, n)
  assert.equal(adapter.events.length, 2)
})

test('适配器：显式 fail(note) 写一次 response.failed 并收尾', async () => {
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

test('适配器：终态正常后 end() 只收尾连接，不追加失败帧', async () => {
  const { res, adapter, usages } = makeAdapter()
  await adapter.push(created(1))
  await adapter.push(frame('response.completed', { sequence_number: 2, response: responseObj({ usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } }) }))
  const n = res.frames.length
  await adapter.end()
  assert.equal(res.frames.length, n)
  assert.equal(writtenFrames(res).filter((f) => f.type === 'response.failed').length, 0)
  assert.equal(res.writableEnded, true)
  assert.equal(usages.length, 1)
})

// ── 11. 拒绝优先于猜测：上游非空密文 marker ────────────────────────────
test('适配器：上游非空 encrypted_function_args 显式失败，不覆盖成空数组', async () => {
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

// ── 12. 背压 ───────────────────────────────────────────────────────────
test('适配器：res.write 返回 false 时暂停，drain 后继续', async () => {
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

test('适配器：背压等待超时 → clientStalled 错误并销毁连接', async () => {
  const res = makeRes({ writeResult: () => false })
  const { adapter } = makeAdapter({ res, writeTimeoutMs: 25 })
  await assert.rejects(adapter.push(created(1)), (e) => e && e.clientStalled === true && e.code === 'EWOULDBLOCK')
  assert.equal(res.destroyed, true)
})

test('适配器：未写出缓冲超过上限时拒绝继续写', async () => {
  const res = makeRes()
  res.writableLength = 8 * 1024 * 1024 + 1
  const { adapter } = makeAdapter({ res })
  await assert.rejects(adapter.push(created(1)), (e) => e && e.clientStalled === true)
  assert.equal(res.destroyed, true)
  assert.equal(res.frames.length, 0)
})

test('适配器：客户端已断开时 push 以 clientGone 拒绝', async () => {
  const res = makeRes()
  const { adapter } = makeAdapter({ res })
  res.destroyed = true
  await assert.rejects(adapter.push(created(1)), (e) => e && e.clientGone === true && e.code === 'ECANCELED')
})

// ── 13. JSON 与 SSE 共用同一 restoreToolItem ───────────────────────────
test('JSON 与 SSE 恢复出的工具身份字段完全相同', async () => {
  const { adapter } = makeAdapter()
  const doneItem = flatTool('spawn_agent', 'call_9', 'fc_9', { arguments: '{"task_name":"w"}' })
  await adapter.push(frame('response.output_item.done', { sequence_number: 2, output_index: 0, item: doneItem }))
  const sseItem = adapter.events[0].data.item

  const json = responseObj({ output: [flatTool('spawn_agent', 'call_9', 'fc_9', { arguments: '{"task_name":"w"}', encrypted_function_args: [] })] })
  const restored = restoreResponseJson(json, ROUTE, makePlan())
  assert.ok(!restored.rejected, JSON.stringify(restored.rejected))
  assert.deepEqual(pickIdentity(restored.json.output[0]), pickIdentity(sseItem))
})

// ── 14. 上游帧只改需要改的字段 ─────────────────────────────────────────
test('适配器：恢复工具身份时保留事件级字段与已知 item 字段', async () => {
  const { adapter } = makeAdapter()
  const item = flatTool('spawn_agent', 'call_keep', 'fc_keep', { arguments: '{"task_name":"w"}' })
  await adapter.push(frame('response.output_item.done', { sequence_number: 7, output_index: 3, item }))
  const ev = adapter.events[0]
  assert.equal(ev.data.sequence_number, 7)
  assert.equal(ev.data.output_index, 3)
  const restored = ev.data.item
  assert.equal(restored.arguments, '{"task_name":"w"}')
  assert.equal(restored.call_id, 'call_keep')
  assert.equal(restored.id, 'fc_keep')
  assert.equal(restored.status, 'completed')
  assert.equal(restored.type, 'function_call')
})

test('适配器：工具项含未知 opaque 字段时显式失败（不猜测）', async () => {
  const { res, adapter } = makeAdapter()
  const item = flatTool('spawn_agent', 'call_unknown', 'fc_unknown', { internal_meta: { keep: true } })
  await adapter.push(frame('response.output_item.done', { sequence_number: 2, output_index: 0, item }))
  const frames = writtenFrames(res)
  const last = frames[frames.length - 1]
  assert.equal(last.type, 'response.failed')
  assert.equal(last.data.error.code, 'opaque_function_args')
  assert.equal(adapter.terminal, 'response.failed')
})

// ── 15. 隔离网关端到端：真实 HTTP/SSE 接线（startGateway + startScriptedUpstream） ──
// 只使用 src/index.js 的现有接线；不伪造 Codex 线程/通知，mock 只编排模型输出。
const E2E_TIMEOUT = 30000
const jsonHeaders = () => ({ 'content-type': 'application/json' })

function toolNamed(tools, name) {
  return (Array.isArray(tools) ? tools : []).find((t) => (t && (t.name || (t.function && t.function.name))) === name) || null
}
function toolParams(tool) {
  return (tool && (tool.parameters || (tool.function && tool.function.parameters))) || null
}
async function readRequestBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8')
  try { return raw ? JSON.parse(raw) : null } catch { return raw }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }
function pilotConfig(mock) {
  return {
    defaults: {
      proxyMode: 'direct',
      retry: { maxAttempts: 1 },
      timeout: { firstByteMs: 5000, idleMs: 10000 },
      codex: { strictModelRouting: true },
    },
    providers: {
      'mock-openai': { baseUrl: mock.base, api: 'responses', apiKeyEnv: 'MG_TEST_MOCK_KEY' },
    },
    models: {
      'codex-gpt': {
        provider: 'mock-openai',
        api: 'responses',
        providerModels: { 'mock-openai': 'gpt-6.1-sol' },
        codex: { multiAgentVersion: 'v2', plaintextTools: true },
      },
    },
  }
}
const E2E_TOOLS = [
  {
    type: 'namespace', name: 'collaboration',
    tools: ['spawn_agent', 'send_message', 'followup_task'].map((name) => ({
      type: 'function', name, description: name + ' (collab)',
      parameters: {
        type: 'object',
        properties: { target: { type: 'string' }, message: { type: 'string', encrypted: true } },
        required: ['target', 'message'],
      },
    })),
  },
  { type: 'function', name: 'read_file', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
]
function codexRequestBody(stream = true) {
  return {
    model: 'codex-gpt',
    stream,
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'delegate to child' }] },
      { type: 'agent_message', author: 'root', recipient: 'child', content: [{ type: 'input_text', text: 'please spawn a worker' }] },
      { type: 'function_call', id: 'hist_fc', call_id: 'call_hist', name: 'send_message', arguments: '{"target":"child","message":"old"}', status: 'completed' },
      { type: 'function_call_output', call_id: 'call_hist', output: '{"ok":true}' },
    ],
    tools: E2E_TOOLS,
  }
}
function parsedSSE(text) {
  return String(text).split('\n\n').filter(Boolean).map((block) => {
    const lines = block.split('\n')
    const type = (lines.find((l) => l.startsWith('event:')) || '').slice(6).trim()
    const dataText = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n')
    let data = null
    try { data = dataText ? JSON.parse(dataText) : null } catch { data = dataText }
    return { type, data, raw: block }
  })
}
function writeFrames(res, frames) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  frames.forEach((f, i) => res.write(frame(f.type, Object.assign({ sequence_number: i + 1 }, f.data))))
  res.end()
}
async function startPilot(t, handler) {
  const mock = await startScriptedUpstream(handler)
  const gw = await startGateway({
    name: 'mg017sse',
    config: pilotConfig(mock),
    env: { MG_TEST_MOCK_KEY: 'sk-mock-server' },
  })
  t.after(async () => { await gw.stop(); await mock.stop() })
  return { mock, gw }
}
async function getStatus(gw) {
  const res = await gw.get('/api/status')
  assert.equal(res.status, 200)
  return res.json()
}
function terminalResponse(r) {
  return r.data && r.data.response ? r.data.response : null
}

// 上游正常协议流夹具：message 项 + 协作 spawn_agent 项 + 普通 read_file 项 + completed(usage)。
function normalUpstreamFrames() {
  const messageAdded = { id: 'msg_1', type: 'message', status: 'in_progress', role: 'assistant', content: [] }
  const messageDone = { id: 'msg_1', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'done', annotations: [] }] }
  const spawnAdded = { id: 'fc_s', type: 'function_call', status: 'in_progress', call_id: 'call_s', name: 'spawn_agent', arguments: '' }
  const spawnDone = { id: 'fc_s', type: 'function_call', status: 'completed', call_id: 'call_s', name: 'spawn_agent', arguments: '{"target":"child","message":"go"}' }
  const readAdded = { id: 'fc_r', type: 'function_call', status: 'in_progress', call_id: 'call_r', name: 'read_file', arguments: '' }
  const readDone = { id: 'fc_r', type: 'function_call', status: 'completed', call_id: 'call_r', name: 'read_file', arguments: '{"path":"a"}' }
  const completedResponse = responseObj({
    output: [messageDone, spawnDone, readDone],
    usage: { input_tokens: 4, output_tokens: 5, total_tokens: 9 },
  })
  return [
    { type: 'response.created', data: { response: responseObj({ status: 'in_progress' }) } },
    { type: 'response.output_item.added', data: { output_index: 0, item: messageAdded } },
    { type: 'response.content_part.added', data: { item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } } },
    { type: 'response.output_text.delta', data: { item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'done' } },
    { type: 'response.output_text.done', data: { item_id: 'msg_1', output_index: 0, content_index: 0, text: 'done' } },
    { type: 'response.content_part.done', data: { item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: 'done', annotations: [] } } },
    { type: 'response.output_item.done', data: { output_index: 0, item: messageDone } },
    { type: 'response.output_item.added', data: { output_index: 1, item: spawnAdded } },
    { type: 'response.function_call_arguments.delta', data: { item_id: 'fc_s', output_index: 1, delta: '{"target":"child","message":"go"}' } },
    { type: 'response.function_call_arguments.done', data: { item_id: 'fc_s', output_index: 1, arguments: '{"target":"child","message":"go"}' } },
    { type: 'response.output_item.done', data: { output_index: 1, item: spawnDone } },
    { type: 'response.output_item.added', data: { output_index: 2, item: readAdded } },
    { type: 'response.output_item.done', data: { output_index: 2, item: readDone } },
    { type: 'response.completed', data: { response: completedResponse } },
  ]
}

test('e2e：codex 试点流式请求经网关恢复工具身份，顺序保持、无 [DONE]、usage 只记一次', { timeout: E2E_TIMEOUT }, async (t) => {
  const expected = normalUpstreamFrames()
  const { mock, gw } = await startPilot(t, async (req, res, rec) => {
    rec.body = await readRequestBody(req)
    writeFrames(res, expected)
  })

  const res = await gw.post('/v1/responses', codexRequestBody(true), jsonHeaders())
  assert.equal(res.status, 200)
  assert.match(String(res.headers.get('content-type')), /text\/event-stream/)
  const text = await res.text()
  assert.equal(text.includes('[DONE]'), false, 'Responses 流不得出现 [DONE]')

  const got = parsedSSE(text)
  assert.deepEqual(got.map((e) => e.type), expected.map((e) => e.type), '事件顺序与上游一致')
  assert.deepEqual(got.map((e) => e.data.sequence_number), expected.map((e, i) => i + 1), 'sequence_number 不重编号')

  const addedSpawn = got.find((r) => r.type === 'response.output_item.added' && r.data.item && r.data.item.name === 'spawn_agent')
  const doneSpawn = got.find((r) => r.type === 'response.output_item.done' && r.data.item && r.data.item.name === 'spawn_agent')
  const doneRead = got.find((r) => r.type === 'response.output_item.done' && r.data.item && r.data.item.name === 'read_file')
  assert.ok(addedSpawn && doneSpawn && doneRead, '协作/普通工具完成项都在客户端流中')
  assert.equal(addedSpawn.data.item.namespace, 'collaboration', 'added 恢复 namespace')
  assert.equal(addedSpawn.data.item.encrypted_function_args, undefined, 'added 不带 marker')
  assert.equal(addedSpawn.data.item.id, doneSpawn.data.item.id, 'added/done id 一致')
  assert.equal(addedSpawn.data.item.call_id, doneSpawn.data.item.call_id, 'added/done call_id 一致')
  assert.equal(doneSpawn.data.item.namespace, 'collaboration', 'done 恢复 namespace')
  assert.deepEqual(doneSpawn.data.item.encrypted_function_args, [], 'done 补 marker')
  assert.equal(doneSpawn.data.item.arguments, '{"target":"child","message":"go"}', 'arguments 原样')
  assert.equal(doneRead.data.item.namespace, undefined, '普通工具项不被注入 namespace')
  assert.equal(doneRead.data.item.encrypted_function_args, undefined, '普通工具项不被注入 marker')

  const completed = got.find((r) => r.type === 'response.completed')
  const output = terminalResponse(completed).output
  assert.deepEqual(output.map((i) => i.id), ['msg_1', 'fc_s', 'fc_r'], 'completed.output[] 顺序保持')
  const outSpawn = output.find((i) => i.name === 'spawn_agent')
  const outRead = output.find((i) => i.name === 'read_file')
  assert.equal(outSpawn.namespace, 'collaboration')
  assert.deepEqual(outSpawn.encrypted_function_args, [])
  assert.equal(outSpawn.id, doneSpawn.data.item.id, 'completed 与 done 身份一致')
  assert.equal(outSpawn.call_id, doneSpawn.data.item.call_id)
  assert.equal(outRead.namespace, undefined)
  assert.equal(outRead.encrypted_function_args, undefined)
  assert.equal(output.filter((i) => i.type === 'message').length, 1, 'message 项保留')

  // 上游收到的请求：工具明文声明（namespace 扁平化、encrypted 删除）；history 默认 preserve 保留 agent_message。
  assert.equal(mock.hits.length, 1)
  const upBody = mock.hits[0].body
  assert.equal(upBody.model, 'gpt-6.1-sol', 'providerModels 覆盖名')
  assert.equal((upBody.tools || []).some((x) => x.type === 'namespace'), false, 'namespace 工具已扁平化')
  const declaredSpawn = toolNamed(upBody.tools, 'spawn_agent')
  assert.ok(declaredSpawn, '上游收到 spawn_agent 明文声明')
  assert.equal('encrypted' in toolParams(declaredSpawn).properties.message, false, '声明删除 message.encrypted')
  assert.equal(upBody.input.some((x) => x && x.type === 'agent_message'), true, 'preserve 路由保留明文 agent_message')
  assert.ok(upBody.input.find((x) => x && x.type === 'function_call' && x.call_id === 'call_hist'), '历史 function_call 保留')

  // usage：一个响应只记账一次（9，而不是 18）
  const status = await getStatus(gw)
  const model = status.models.find((m) => m.name === 'codex-gpt')
  const provider = status.providers.find((p) => p.id === 'mock-openai')
  assert.equal(model.tokens, 9, '模型 tokens 只累加一次')
  assert.equal(provider.st.tokens, 9, 'provider tokens 只累加一次')
  assert.equal(status.global.tokenCount, 9, '全局 tokenCount 只累加一次')
  assert.equal(model.requests, 1)
})

test('e2e：上游终态前断流 → 客户端收到 response.failed STREAM_INTERRUPTED，无伪造 completed', { timeout: E2E_TIMEOUT }, async (t) => {
  const partial = normalUpstreamFrames().slice(0, 11) // 到 spawn_agent done，无 completed
  const { gw } = await startPilot(t, async (req, res, rec) => {
    rec.body = await readRequestBody(req)
    writeFrames(res, partial)
    // 注意：没有 completed/failed/incomplete，直接 end()
  })

  const res = await gw.post('/v1/responses', codexRequestBody(true), jsonHeaders())
  assert.equal(res.status, 200)
  const text = await res.text()
  assert.equal(text.includes('[DONE]'), false)
  const got = parsedSSE(text)
  assert.deepEqual(got.map((e) => e.type), partial.map((e) => e.type).concat('response.failed'), '终态缺失由 response.failed 收尾')
  const last = got[got.length - 1]
  assert.equal(last.type, 'response.failed')
  assert.equal(last.data.error.code, 'STREAM_INTERRUPTED')
  assert.match(String(last.data.error.message), /terminal/i)
  assert.equal(got.filter((e) => e.type === 'response.completed').length, 0, '不得伪造 completed')
  assert.equal(got.filter((e) => e.type === 'response.output_item.done').length, 2, '已送出的完成项不重发')
})

test('e2e：客户端在流中断开 → 网关销毁上游连接且不记上游失败', { timeout: E2E_TIMEOUT }, async (t) => {
  const created = { type: 'response.created', data: { response: responseObj({ status: 'in_progress' }) } }
  const spawnAdded = { type: 'response.output_item.added', data: { output_index: 0, item: { id: 'fc_s', type: 'function_call', status: 'in_progress', call_id: 'call_s', name: 'spawn_agent', arguments: '' } } }
  const { mock, gw } = await startPilot(t, async (req, res, rec) => {
    rec.body = await readRequestBody(req)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(frame(created.type, Object.assign({ sequence_number: 1 }, created.data)))
    res.write(frame(spawnAdded.type, Object.assign({ sequence_number: 2 }, spawnAdded.data)))
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 8000)
      res.once('close', () => { clearTimeout(timer); resolve() })
    })
    try { res.end() } catch {}
  })

  const ac = new AbortController()
  const response = await fetch(gw.base + '/v1/responses', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(codexRequestBody(true)),
    signal: ac.signal,
  })
  assert.equal(response.status, 200)
  const reader = response.body.getReader()
  const first = await reader.read()
  assert.ok(first.value && first.value.length > 0, '至少收到首个 SSE 分片')
  ac.abort()
  try { await reader.cancel() } catch {}

  const deadline = Date.now() + 5000
  while (Date.now() < deadline && !(mock.hits[0] && mock.hits[0].closedAt)) await sleep(25)
  assert.ok(mock.hits[0] && mock.hits[0].closedAt, '客户端断开后网关销毁上游连接（closedAt 有值）')

  await sleep(300) // 等网关取消分支收尾
  const status = await getStatus(gw)
  assert.equal(status.counters.errors, 0, 'client_closed 不记上游失败（全局计数器）')
  assert.equal(status.global.errors, 0, 'client_closed 不记上游失败（global）')
  const provider = status.providers.find((p) => p.id === 'mock-openai')
  assert.equal(provider.st.errors, 0, 'client_closed 不记 provider 失败')
  const model = status.models.find((m) => m.name === 'codex-gpt')
  assert.equal(model.errors, 0, 'client_closed 不记模型失败')
  assert.equal(model.tokens || 0, 0, '取消不产生 usage 记账')
})

test('e2e：上游终态后重复帧被忽略，usage 仍只记一次', { timeout: E2E_TIMEOUT }, async (t) => {
  const frames = normalUpstreamFrames()
  const completed = frames[frames.length - 1]
  const { gw } = await startPilot(t, async (req, res, rec) => {
    rec.body = await readRequestBody(req)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(frame(completed.type, Object.assign({ sequence_number: 14 }, completed.data)))
    res.write(frame(completed.type, Object.assign({ sequence_number: 15 }, completed.data)))
    res.end()
  })

  const res = await gw.post('/v1/responses', codexRequestBody(true), jsonHeaders())
  const text = await res.text()
  const got = parsedSSE(text)
  assert.deepEqual(got.map((e) => e.type), ['response.completed'], '终态后的重复帧被忽略')
  assert.equal(text.includes('[DONE]'), false)
  const status = await getStatus(gw)
  assert.equal(status.models.find((m) => m.name === 'codex-gpt').tokens, 9, '重复终态不重复记账')
  assert.equal(status.global.tokenCount, 9)
})
