// Responses 流式桥（MG-015）：把 relayStream 产生的 OpenAI Chat SSE 帧翻译成 Responses 事件。
// 复用 relayStream 的续传/空闲看门狗/预算/背压能力，本模块只做“帧翻译 + 终态”。
import { EventEmitter } from 'node:events'
import { relayStream } from './sse.js'
import { makeSSEWriter, mapUsage } from './responses.js'

const WRITE_WAIT_MS = 30000

function clientGoneError() { const e = new Error('client closed'); e.code = 'ECANCELED'; e.clientGone = true; return e }

// 把 writer 产出的帧写到真实 res；write 返回 false 时由 relayStream 等待 sink 的 drain 事件。
function makeSink(res, writer, onText, onToolCall, onDone) {
  const sink = new EventEmitter()
  let buf = ''
  let closed = false
  sink.destroyed = false
  sink.writableEnded = false
  sink.writableLength = 0
  const fail = () => { if (!closed) { closed = true; sink.destroyed = true; sink.emit('close') } }
  const writeRes = (frames) => {
    if (!frames) return true
    if (res.destroyed || res.writableEnded) return true
    try { return res.write(frames) } catch { fail(); return true }
  }
  const handleFrame = (frame) => {
    const dataLines = frame.split('\n').filter((l) => l.startsWith('data:'))
    if (!dataLines.length) return '' // 注释/keepalive：由调用方原样透传
    const data = dataLines.map((l) => l.slice(5).trim()).join('\n')
    if (data === '[DONE]') { onDone(); return '' }
    let obj; try { obj = JSON.parse(data) } catch { return '' }
    const choice = obj && Array.isArray(obj.choices) && obj.choices[0]
    if (!choice) return ''
    let out = ''
    const delta = choice.delta || {}
    if (typeof delta.content === 'string' && delta.content !== '') { onText(delta.content); out += writer.textDelta(delta.content) }
    if (Array.isArray(delta.tool_calls)) for (const tc of delta.tool_calls) onToolCall(tc)
    return out
  }
  sink.write = (txt) => {
    if (sink.destroyed) return true
    buf += String(txt)
    let out = ''
    let i
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, i)
      buf = buf.slice(i + 2)
      if (frame === '') continue
      if (!frame.split('\n').every((l) => l === '' || l.startsWith(':'))) out += handleFrame(frame)
      else out += frame + '\n\n' // keepalive 注释透传
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
 * 首个 relay/oneShot 时才写响应头与 response.created（保证 forwardChain 的首个上游确定后再开始）。
 */
export function createResponsesStream(res, opts = {}) {
  const writer = makeSSEWriter({ model: opts.model, id: opts.id, createdAt: opts.createdAt })
  const createdAt = Number.isFinite(opts.createdAt) ? opts.createdAt : Math.floor(Date.now() / 1000)
  const model = opts.model || ''
  let started = false
  let finalized = false
  let usage = null
  let text = ''
  const toolCalls = new Map() // index → { call_id, name, args }
  let textSent = false
  const sink = makeSink(res, writer, (t) => { text += t; textSent = true }, (tc) => {
    const i = Number.isInteger(tc.index) ? tc.index : 0
    const cur = toolCalls.get(i) || { call_id: '', name: '', args: '' }
    if (tc.id) cur.call_id = tc.id
    if (tc.function && tc.function.name) cur.name = tc.function.name
    if (tc.function && typeof tc.function.arguments === 'string') cur.args += tc.function.arguments
    toolCalls.set(i, cur)
  }, () => finalizeCompleted())
  function start() {
    if (started) return
    started = true
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'transfer-encoding': 'chunked' })
    res.write(writer.created())
  }
  function buildResponse(status) {
    const output = []
    if (text !== '' || toolCalls.size === 0) output.push({ id: writer.id + '_msg', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] })
    const calls = [...toolCalls.values()]
    for (const c of calls) output.push({ id: writer.id + '_fc_' + c.call_id, type: 'function_call', status: 'completed', call_id: c.call_id, name: c.name, arguments: c.args })
    const r = { id: writer.id, object: 'response', created_at: createdAt, status: status || 'completed', model, output, output_text: text, usage: mapUsage(usage) }
    return r
  }
  function finalizeCompleted() {
    if (finalized) return
    finalized = true
    start()
    let frames = ''
    if (text !== '' || toolCalls.size > 0) {
      // 文本：一次 endMessage 输出完整文本（delta 已实时发过）
      frames += writer.endMessage(text)
      for (const c of toolCalls.values()) {
        frames += writer.beginToolCall({ call_id: c.call_id, name: c.name, type: 'function_call' })
        if (c.args) frames += writer.toolArgsDelta(c.args)
        frames += writer.endToolCall(c.args)
      }
    }
    frames += writer.completed(buildResponse('completed'))
    if (!res.destroyed && !res.writableEnded) { try { res.write(frames) } catch {} }
    // relayStream 会在 done 后调用 sink.end()，这里不主动 end，保持单一出口
  }
  return {
    writer,
    get started() { return started },
    get text() { return text },
    get usage() { return usage },
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
      start()
      let frames = ''
      const outText = chatJson && chatJson.choices && chatJson.choices[0] && chatJson.choices[0].message && typeof chatJson.choices[0].message.content === 'string' ? chatJson.choices[0].message.content : ''
      const msg = chatJson && chatJson.choices && chatJson.choices[0] && chatJson.choices[0].message
      if (outText !== '') { text = outText; frames += writer.textDelta(outText) }
      frames += writer.endMessage(outText)
      const tcs = (msg && Array.isArray(msg.tool_calls)) ? msg.tool_calls : []
      for (const tc of tcs) {
        const name = tc.function && tc.function.name
        const args = tc.function && typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify((tc.function && tc.function.arguments) || {})
        frames += writer.beginToolCall({ call_id: tc.id, name, type: 'function_call' })
        frames += writer.toolArgsDelta(args)
        frames += writer.endToolCall(args)
      }
      const resp = buildResponse('completed')
      if (ctx.customToolNames && ctx.customToolNames.length) { /* 有损：custom 工具类型无法从 Chat 还原，保持 function_call */ }
      frames += writer.completed(resp)
      if (!res.destroyed && !res.writableEnded) { try { res.write(frames) } catch {} ; try { res.end() } catch {} }
      finalized = true
    },
    fail(note, extra = {}) {
      if (finalized || res.destroyed || res.writableEnded) return
      finalized = true
      start()
      const code = extra.timeout ? 'REQUEST_TIMEOUT' : 'STREAM_INTERRUPTED'
      try { res.write(writer.failed({ code, message: String(note || 'upstream stream interrupted') })) } catch {}
      try { res.end() } catch {}
    },
  }
}
