// Responses 流式桥（M1-2）：把 relayStream 产生的 OpenAI Chat SSE 帧翻译成 Responses 事件。
// 复用 relayStream 的续传/空闲看门狗/预算/背压能力；本模块只做“帧翻译 + 终态”。
//
// M1-2 修复的协议保真问题：
//  · 同一 item 的 add/delta/done/completed.output 使用同一 id（不再每次重新编号）；
//  · 工具 delta 按 call_id 增量累加（不同 call_id 交错出现不串线），closing 时只补发未发送的尾部；
//  · 终态恰好一个：completed 与 failed 互斥，[DONE] 之后到达的帧不再产生事件；
//  · 文本/工具条目的 event output_index 与 completed.response.output 顺序一致。
import { EventEmitter } from 'node:events'
import { relayStream } from './sse.js'
import { makeSSEWriter, mapUsage } from './responses.js'
import { collapseToolCallName } from './codex/interop.js'

function clientGoneError() { const e = new Error('client closed'); e.code = 'ECANCELED'; e.clientGone = true; return e }

// 把 writer 产出的帧写到真实 res；write 返回 false 时由 relayStream 等待 sink 的 drain 事件。
// handlers: { isFinalized(), onText(t), onToolCall(tc), onDone() }，回调返回要追加的 SSE 帧。
function makeSink(res, writer, handlers) {
  const sink = new EventEmitter()
  let buf = ''
  let closed = false
  sink.destroyed = false
  sink.writableEnded = false
  sink.writableLength = 0
  sink.gone = false
  const fail = () => { if (!closed) { closed = true; sink.gone = true; sink.destroyed = true; sink.emit('close') } }
  const writeRes = (frames) => {
    if (!frames) return true
    if (res.destroyed || res.writableEnded) return true
    try { return res.write(frames) } catch { fail(); return true }
  }
  const handleFrame = (frame) => {
    if (handlers.isFinalized()) return ''
    const dataLines = frame.split('\n').filter((l) => l.startsWith('data:'))
    if (!dataLines.length) return '' // 注释/keepalive：由调用方原样透传
    const data = dataLines.map((l) => l.slice(5).trim()).join('\n')
    if (data === '[DONE]') { handlers.onDone(); return '' }
    let obj; try { obj = JSON.parse(data) } catch { return '' }
    const choice = obj && Array.isArray(obj.choices) && obj.choices[0]
    if (!choice) return ''
    let out = ''
    const delta = choice.delta || {}
    if (typeof delta.content === 'string' && delta.content !== '') out += handlers.onText(delta.content) || ''
    if (Array.isArray(delta.tool_calls)) for (const tc of delta.tool_calls) out += handlers.onToolCall(tc) || ''
    return out
  }
  sink.write = (txt) => {
    if (sink.destroyed || handlers.isFinalized()) return true
    buf += String(txt)
    let out = ''
    let i
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, i)
      buf = buf.slice(i + 2)
      if (frame === '') continue
      const lines = frame.split('\n')
      if (lines.every((l) => l === '' || l.startsWith(':'))) out += frame + '\n\n' // keepalive 注释透传
      else out += handleFrame(frame)
      if (handlers.isFinalized()) { buf = ''; break }
    }
    sink.writableLength = typeof res.writableLength === 'number' ? res.writableLength : 0
    return writeRes(out)
  }
  sink.end = () => { sink.writableEnded = true; if (!res.writableEnded && !res.destroyed) { try { res.end() } catch {} } }
  sink.destroy = () => { fail(); try { res.destroy() } catch {} }
  res.on('drain', () => sink.emit('drain'))
  res.on('close', () => { if (!res.writableEnded) fail() })
  return sink
}

/**
 * createResponsesStream(res, { model, id, createdAt })
 * 返回会话：relay(upstream, relayOpts) → relayStream 结果 + finish；fail(note)；oneShot(chatJson)。
 * 首个 relay/oneShot/fail 时才写响应头与 response.created。
 */
export function createResponsesStream(res, opts = {}) {
  const writer = makeSSEWriter({ model: opts.model, id: opts.id, createdAt: opts.createdAt })
  const createdAt = Number.isFinite(opts.createdAt) ? opts.createdAt : Math.floor(Date.now() / 1000)
  const model = opts.model || ''
  const textItemId = writer.id + '_msg'
  let started = false
  let finalized = false
  let usage = null
  let text = ''
  let textSent = false
  let messageStarted = false
  let toolOrdinal = 0
  const order = [] // { kind:'message' } | { kind:'tool', state }
  const toolCalls = new Map() // callId（或 idx:<n>）→ 工具状态
  const indexToKey = new Map() // Chat 流的 tool_calls[].index → call_id

  function start() {
    if (started) return
    started = true
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'transfer-encoding': 'chunked' })
    res.write(writer.created())
  }

  function beginTool(st) {
    if (st.begun) return ''
    st.begun = true
    order.push({ kind: 'tool', state: st })
    return writer.beginToolCall({ id: st.itemId, call_id: st.callId, name: st.name, type: 'function_call' })
  }
  function finishTool(st) {
    if (st.ended) return ''
    let frames = ''
    if (!st.begun) frames += beginTool(st)
    if (st.emitted < st.args.length) {
      const rest = st.args.slice(st.emitted)
      frames += writer.toolArgsDelta(rest, { itemId: st.itemId, callId: st.callId || undefined })
      st.emitted = st.args.length
    }
    frames += writer.endToolCall(st.args, { itemId: st.itemId, callId: st.callId || undefined })
    st.ended = true
    return frames
  }
  function writeText(t) {
    if (typeof t !== 'string' || t === '') return ''
    text += t
    textSent = true
    if (!messageStarted) { messageStarted = true; order.push({ kind: 'message' }) }
    return writer.textDelta(t, { itemId: textItemId })
  }
  function writeToolCall(tc) {
    if (!tc || typeof tc !== 'object') return ''
    const idx = Number.isInteger(tc.index) ? tc.index : 0
    let callId = typeof tc.id === 'string' ? tc.id : ''
    if (callId) indexToKey.set(idx, callId)
    else callId = indexToKey.get(idx) || ''
    const key = callId || ('idx:' + idx)
    let st = toolCalls.get(key)
    if (!st) {
      st = {
        key, callId, name: '', args: '', emitted: 0,
        itemId: writer.id + '_fc_' + (callId || ('call' + (toolOrdinal++))),
        begun: false, ended: false,
      }
      toolCalls.set(key, st)
    }
    const fn = tc.function || {}
    if (typeof fn.name === 'string' && fn.name && !st.name) st.name = fn.name
    const argDelta = typeof fn.arguments === 'string'
      ? fn.arguments
      : (fn.arguments != null ? JSON.stringify(fn.arguments) : '')
    st.args += argDelta
    let frames = ''
    if (!st.begun && (st.name || st.args)) frames += beginTool(st)
    if (st.begun && argDelta) {
      frames += writer.toolArgsDelta(argDelta, { itemId: st.itemId, callId: st.callId || undefined })
      st.emitted += argDelta.length
    }
    return frames
  }
  function finishMessage() {
    if (text !== '' || toolCalls.size === 0) {
      if (!messageStarted) { messageStarted = true; order.push({ kind: 'message' }) }
      return writer.beginMessage(textItemId) + writer.endMessage(text, { itemId: textItemId })
    }
    return ''
  }
  function buildResponse(status) {
    const output = []
    for (const ref of order) {
      if (ref.kind === 'message') {
        output.push({
          id: textItemId, type: 'message', status: 'completed', role: 'assistant',
          content: [{ type: 'output_text', text, annotations: [] }],
        })
        continue
      }
      const st = ref.state
      const collapsed = collapseToolCallName(st.name)
      const item = {
        id: st.itemId, type: 'function_call', status: 'completed',
        call_id: st.callId, name: collapsed.name, arguments: st.args,
      }
      if (collapsed.namespace) item.namespace = collapsed.namespace
      output.push(item)
    }
    return {
      id: writer.id, object: 'response', created_at: createdAt, status: status || 'completed',
      model, output, output_text: text, usage: mapUsage(usage),
    }
  }
  function finalizeCompleted() {
    if (finalized) return
    finalized = true
    if (sink.gone) return // 客户端已断开：不为不可写连接伪造完成/失败终态
    start()
    let frames = ''
    frames += finishMessage()
    for (const st of toolCalls.values()) frames += finishTool(st)
    frames += writer.completed(buildResponse('completed'))
    if (!res.destroyed && !res.writableEnded) { try { res.write(frames) } catch {} }
    // relayStream 会在 done 后调用 sink.end()，这里不主动 end，保持单一出口
  }
  // 唯一失败终态出口：与 completed 互斥；客户端已断开/已 end 时不再写（不可达），
  // 重复调用幂等（fail 第二次直接返回）。
  function fail(note, extra = {}) {
    if (finalized || sink.gone || res.destroyed || res.writableEnded) return
    finalized = true
    start()
    const code = extra.timeout ? 'REQUEST_TIMEOUT' : 'STREAM_INTERRUPTED'
    try { res.write(writer.failed({ code, message: String(note || 'upstream stream interrupted') })) } catch {}
    try { res.end() } catch {}
  }

  const sink = makeSink(res, writer, {
    isFinalized: () => finalized,
    onText: writeText,
    onToolCall: writeToolCall,
    onDone: finalizeCompleted,
  })

  return {
    writer,
    get started() { return started },
    get text() { return text },
    get usage() { return usage },
    get finalized() { return finalized },
    start,
    relay(upstream, relayOpts = {}) {
      start()
      const o = Object.assign({}, relayOpts)
      const userOnUsage = o.onUsage
      const userOnEnd = o.onEnd
      o.onUsage = (u) => { usage = u || usage; if (userOnUsage) userOnUsage(u) }
      o.onEnd = (info) => { if (userOnEnd) userOnEnd(info) }
      return relayStream(sink, upstream, o).then((r) => Object.assign({}, r, {
        textSent,
        finish: (note) => fail(note, { timeout: r && r.timedOut }),
      }))
    },
    oneShot(chatJson, ctx = {}) {
      if (finalized || res.destroyed || res.writableEnded) return
      start()
      let frames = ''
      const message = chatJson && chatJson.choices && chatJson.choices[0] && chatJson.choices[0].message
      const outText = message && typeof message.content === 'string' ? message.content : ''
      const tcs = (message && Array.isArray(message.tool_calls)) ? message.tool_calls : []
      text = outText
      textSent = outText !== ''
      if (outText !== '' || tcs.length === 0) {
        messageStarted = true
        order.push({ kind: 'message' })
        frames += writer.beginMessage(textItemId)
        if (outText !== '') frames += writer.textDelta(outText, { itemId: textItemId })
        frames += writer.endMessage(outText, { itemId: textItemId })
      }
      for (let i = 0; i < tcs.length; i++) {
        const tc = tcs[i] || {}
        const callId = tc.id || ('call_' + i)
        const fn = tc.function || {}
        const name = fn.name || ''
        const args = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments == null ? {} : fn.arguments)
        const itemId = writer.id + '_fc_' + callId
        const st = { key: callId, callId, name, args, emitted: args.length, itemId, begun: true, ended: false }
        toolCalls.set(callId, st)
        order.push({ kind: 'tool', state: st })
        frames += writer.beginToolCall({ id: itemId, call_id: callId, name, type: 'function_call' })
        if (args) frames += writer.toolArgsDelta(args, { itemId, callId })
        frames += writer.endToolCall(args, { itemId, callId })
        st.ended = true
      }
      frames += writer.completed(buildResponse('completed'))
      if (!res.destroyed && !res.writableEnded) { try { res.write(frames) } catch {} ; try { res.end() } catch {} }
      finalized = true
    },
    fail,
  }
}
