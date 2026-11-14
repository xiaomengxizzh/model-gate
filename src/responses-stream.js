// Responses 流式桥（M1-2）：把 relayStream 产生的 OpenAI Chat SSE 帧翻译成 Responses 事件。
// 复用 relayStream 的续传/空闲看门狗/预算/背压能力；本模块只做“帧翻译 + 终态”。
//
// M1-2 修复的协议保真问题：
//  · 同一 item 的 add/delta/done/completed.output 使用同一 id（不再每次重新编号）；
//  · 工具 delta 按 call_id 增量累加（不同 call_id 交错出现不串线），closing 时只补发未发送的尾部；
//  · 终态恰好一个：completed 与 failed 互斥，[DONE] 之后到达的帧不再产生事件；
//  · 文本/工具条目的 event output_index 与 completed.response.output 顺序一致。
import { EventEmitter } from 'node:events'
import { createSSEFrameDecoder, relayStream } from './sse.js'
import { makeSSEWriter, mapUsage } from './responses.js'
import { collapseToolCallName, restoreToolItem, restoreResponseJson } from './codex/interop.js'

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

// —— Codex 原生 Responses SSE 适配层（P04，定向移植 7afb4dc src/codex-responses-stream.js） ——
//
// 与上方 createResponsesStream（Chat → Responses 桥）严格分层：本适配层只服务**原生 Responses 上游**，
// 不做 Chat 翻译、不共用桥的有损默认；A1 的 SSE 解码（sse.js createSSEFrameDecoder）与发送逻辑保持不变。
//
// 职责：
//   1) 工具身份恢复：response.output_item.added/done 的 item 走与 JSON 路径同一个 restoreToolItem；
//      added 只恢复 namespace/原名，done 才补 encrypted_function_args: []；
//   2) 完成项恢复：response.completed/incomplete 的 response.output[] 走 restoreResponseJson；
//   3) 终态与 usage：completed/failed/incomplete 唯一终态，此后帧全部忽略；usage 每响应只回调一次，
//      缺失记 0，不臆造；终态前断流 → 合成 response.failed STREAM_INTERRUPTED，不自动重发。
// 其它字段（id / output_index / call_id / sequence_number / arguments）保持上游值，不重排、不重编号。
//
// 严格支持列表：终态仅 response.completed / response.failed / response.incomplete；其余帧原样透传。
// 背压复用 30s / 8MiB 语义；Responses 协议不使用 [DONE]，收到即丢弃、不写回客户端。
//
// 测试：scripts/test/offline/codex-v2-stream.test.mjs。

const WRITE_WAIT_MS = 30000
const MAX_CLIENT_BUFFER_BYTES = 8 * 1024 * 1024
const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache',
  'transfer-encoding': 'chunked',
}
const TERMINAL_TYPES = new Set(['response.completed', 'response.failed', 'response.incomplete'])
// 客户端中断/取消的本地终态：不是上游帧，也绝不写进已断开的连接。
// 与 'response.failed' 区分开，避免把"用户取消"记成"上游故障"（熔断/错误计数）。
export const RESPONSE_CANCELED = 'response.canceled'
export const CLIENT_CANCELED_CODE = 'CLIENT_CANCELED'

// 契约 §4.2：终态事件判定（唯一真源，适配器与调用方共用）。
export function isCodexTerminalEvent(type) {
  return typeof type === 'string' && TERMINAL_TYPES.has(type)
}

/**
 * 原生 Responses SSE 解析器：复用 A1 的 createSSEFrameDecoder（UTF-8 跨 chunk、CRLF/CR/LF、
 * 1MiB 单帧 / 2MiB 缓冲上限）。本包装只把 flush 的尾部文本变成"一个待处理块"，
 * 保持契约 §4.2 的 push/flush 接口；不另造一套解码器。
 */
export function createCodexSSEParser(opts = {}) {
  const decoder = createSSEFrameDecoder(opts)
  const nonEmpty = (block) => typeof block === 'string' && block.trim() !== ''
  return {
    push(chunk) { return decoder.push(chunk).filter(nonEmpty) },
    flush() {
      const tail = decoder.flush()
      if (typeof tail !== 'string' || tail.trim() === '') return []
      // A1 解码器的 flush 只返回尾部原文；这里统一行尾并按空行切块，保留"残帧由调用方决定中断"的语义。
      const normalized = tail.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      return normalized.split(/\n{2,}/).map((block) => block.replace(/^\n+|\n+$/g, '')).filter(nonEmpty)
    },
  }
}

function codexClientGoneError() {
  const e = new Error('client closed')
  e.code = 'ECANCELED'
  e.clientGone = true
  return e
}
function writeStalledError() {
  const e = new Error('client write stalled')
  e.code = 'EWOULDBLOCK'
  e.clientStalled = true
  return e
}
function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v) }
function zeroUsage() { return { input_tokens: 0, output_tokens: 0, total_tokens: 0 } }

// 拆一个 SSE 块：事件名与 data 行（多行 data 以 \n 拼接，符合 SSE 语义）。
function parseBlock(block) {
  const lines = block.split('\n')
  const dataLines = []
  let eventName = ''
  let hasData = false
  for (const line of lines) {
    if (line === '' || line.startsWith(':')) continue
    const at = line.indexOf(':')
    const field = at === -1 ? line : line.slice(0, at)
    let value = at === -1 ? '' : line.slice(at + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') eventName = value
    else if (field === 'data') { dataLines.push(value); hasData = true }
  }
  return { eventName, data: dataLines.join('\n'), hasData }
}

// 改写 data 行，保留 event:/id:/retry:/注释等其它行；缺失 event: 行时补上事件名。
function rebuildBlock(block, type, payload) {
  const out = []
  let dataWritten = false
  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) { out.push(line); continue }
    const at = line.indexOf(':')
    const field = at === -1 ? line : line.slice(0, at)
    if (field === 'data') {
      if (!dataWritten) { out.push('data: ' + JSON.stringify(payload)); dataWritten = true }
      continue
    }
    out.push(line)
  }
  if (!dataWritten) out.push('data: ' + JSON.stringify(payload))
  if (!out.some((l) => l.startsWith('event:'))) out.unshift('event: ' + type)
  return out.join('\n')
}

/**
 * 原生 Responses SSE → Codex 可执行帧的增量适配器（契约 §4.2）。
 * 返回 { push(chunk): Promise<void>, end(): Promise<void>, fail(note, extra): Promise<void>,
 *        events, terminal, usage }；push 由调用方 await，因此天然把背压传回上游读取循环。
 * 额外可选参数 writeTimeoutMs / maxBufferBytes 只为离线测试收紧阈值，默认遵循 §8（30s / 8MiB）。
 */
export function createCodexStreamAdapter(res, opts = {}) {
  const options = opts || {}
  const plan = isObject(options.plan) && options.plan.declared ? options.plan : { declared: new Map(), declarations: undefined, toolChoice: undefined, lossy: [] }
  const route = isObject(options.route) ? options.route : {}
  const model = typeof options.model === 'string' ? options.model : ''
  const responseId = typeof options.id === 'string' && options.id !== '' ? options.id : ('resp_gateway_' + Date.now().toString(36))
  const createdAt = Number.isFinite(options.createdAt) ? options.createdAt : Math.floor(Date.now() / 1000)
  const onUsage = typeof options.onUsage === 'function' ? options.onUsage : null
  const log = options.log && typeof options.log.warn === 'function' ? options.log : null
  const writeWaitMs = Number(options.writeTimeoutMs) > 0 ? Number(options.writeTimeoutMs) : WRITE_WAIT_MS
  const maxBufferBytes = Number(options.maxBufferBytes) > 0 ? Number(options.maxBufferBytes) : MAX_CLIENT_BUFFER_BYTES
  const softRestore = options.softRestore === true

  const parser = createCodexSSEParser()
  const events = []
  let terminal = null
  let terminalCode = null
  let usage = null
  let usageReported = false
  let ended = false
  let lastSeq = 0
  let droppedDone = 0

  function warn(...args) { if (log) { try { log.warn(...args) } catch {} } }
  function bufferedLength() { return typeof res.writableLength === 'number' ? res.writableLength : 0 }

  function ensureHeaders() {
    if (!res || typeof res.writeHead !== 'function' || res.headersSent) return
    try { res.writeHead(200, SSE_HEADERS) } catch {}
  }

  function finishRes() {
    if (!res || res.destroyed || res.writableEnded) return
    try { if (typeof res.end === 'function') res.end() } catch {}
  }

  // 等待 drain：同时响应 close/error；超时按 clientStalled 判死并销毁连接。
  function waitDrain() {
    return new Promise((resolve, reject) => {
      let timer = null
      let settled = false
      const cleanup = () => {
        if (timer) { clearTimeout(timer); timer = null }
        try { res.removeListener('drain', onDrain) } catch {}
        try { res.removeListener('close', onClose) } catch {}
        try { res.removeListener('error', onError) } catch {}
      }
      const onDrain = () => { if (settled) return; settled = true; cleanup(); resolve() }
      const onClose = () => { if (settled) return; settled = true; cleanup(); reject(codexClientGoneError()) }
      const onError = () => { if (settled) return; settled = true; cleanup(); reject(codexClientGoneError()) }
      timer = setTimeout(() => {
        if (settled) return
        settled = true
        cleanup()
        warn('codex 流：客户端写阻塞超时', 'writableLength=' + bufferedLength(), 'waitedMs=' + writeWaitMs)
        try { if (typeof res.destroy === 'function') res.destroy() } catch {}
        reject(writeStalledError())
      }, writeWaitMs)
      try {
        res.once('drain', onDrain)
        res.once('close', onClose)
        res.once('error', onError)
      } catch {}
    })
  }

  // 写客户端（背压感知）；调用方必须 await，才能在 write=false 时暂停上游读取。
  async function sendRaw(text) {
    if (!res || res.destroyed || res.writableEnded) throw codexClientGoneError()
    if (bufferedLength() > maxBufferBytes) {
      try { if (typeof res.destroy === 'function') res.destroy() } catch {}
      throw writeStalledError()
    }
    ensureHeaders()
    let ok = true
    try { ok = res.write(text) } catch { throw codexClientGoneError() }
    if (ok === false) {
      await waitDrain()
      if (!res.destroyed && bufferedLength() > maxBufferBytes) {
        try { if (typeof res.destroy === 'function') res.destroy() } catch {}
        throw writeStalledError()
      }
    }
  }

  function recordUsage(raw) {
    if (usageReported) return
    usageReported = true
    usage = isObject(raw) ? Object.assign({}, raw) : zeroUsage()
    if (onUsage) {
      try { onUsage(usage) } catch (e) {
        warn('codex 流：onUsage 回调异常', String((e && e.message) || e))
      }
    }
  }

  // restoreToolItem / restoreResponseJson 是契约冻结的纯函数；异常一律当显式拒绝，绝不猜测。
  function callRestore(fn, ...args) {
    try { return fn(...args) || {} } catch (e) {
      return { rejected: { code: 'restore_failed', message: String((e && e.message) || e) } }
    }
  }

  function finalizeCompleted(response) {
    const out = Object.assign({}, response)
    if (!Array.isArray(out.output)) out.output = []
    if (typeof out.output_text !== 'string') {
      // 契约 §4.2：缺失 output 时补 output_text。只从已完成 output 文本聚合，不伪造 item。
      let text = ''
      for (const item of out.output) {
        if (!isObject(item) || item.type !== 'message' || !Array.isArray(item.content)) continue
        for (const part of item.content) {
          if (isObject(part) && part.type === 'output_text' && typeof part.text === 'string') text += part.text
        }
      }
      out.output_text = text
    }
    return out
  }

  async function rejectFrame(rejected, type) {
    const r = isObject(rejected) ? rejected : {}
    const code = typeof r.code === 'string' && r.code ? r.code : 'unsupported_item'
    const message = typeof r.message === 'string' && r.message ? r.message : ('拒绝无法保真的流式帧：' + String(type))
    warn('codex 流：拒绝帧 ' + String(type) + '（' + code + '）', message)
    await fail(message, { code })
  }

  async function handleTerminal(type, block, payload) {
    let data = payload
    let outBlock = block
    // completed 与 incomplete 的 response.output[] 都可能带可执行/需恢复的完成项：
    // 两者都走同一个 restoreResponseJson（身份一致）；failed 没有可执行 output，保持原样。
    // incomplete 只做身份恢复，不补 output_text、不改 status/incomplete_details（那些字段原样保留）。
    if (type === 'response.completed' || type === 'response.incomplete') {
      const original = payload.response
      if (isObject(original)) {
        let restored = null
        try { restored = callRestore(restoreResponseJson, original, route, plan) } catch (e) {
          if (!softRestore) throw e
          warn('codex 流：终态恢复异常，按原始终态透传', String((e && e.message) || e))
        }
        if (restored && restored.rejected) {
          if (!softRestore) { await rejectFrame(restored.rejected, type); return }
          warn('codex 流：终态恢复被拒绝，按原始终态透传', restored.rejected.code || 'restore_rejected')
          data = payload
          outBlock = block
        } else if (restored) {
          const restoredJson = isObject(restored.json) ? restored.json : original
          const response = type === 'response.completed' ? finalizeCompleted(restoredJson) : restoredJson
          data = Object.assign({}, payload, { response })
          outBlock = rebuildBlock(block, type, data)
        }
      }
    }
    // usage 只在终态记一次；completed 缺失 usage 记 0，不臆造 reasoning/缓存字段。
    recordUsage(isObject(data.response) ? data.response.usage : null)
    terminal = type
    if (type === 'response.completed') terminalCode = 'completed'
    else if (type === 'response.incomplete') terminalCode = 'incomplete'
    else {
      const err = isObject(data.error) ? data.error : (isObject(data.response) && isObject(data.response.error) ? data.response.error : null)
      terminalCode = err && typeof err.code === 'string' && err.code ? err.code : 'response_failed'
    }
    events.push({ type, data })
    await sendRaw(outBlock + '\n\n')
  }

  async function handleToolItem(type, block, payload) {
    const item = payload.item
    if (!isObject(item)) {
      events.push({ type, data: payload })
      await sendRaw(block + '\n\n')
      return
    }
    let restored = null
    try { restored = callRestore(restoreToolItem, item, route, plan) } catch (e) {
      if (!softRestore) throw e
      warn('codex 流：工具项恢复异常，按原始项透传', String((e && e.message) || e))
    }
    if (restored && restored.rejected) {
      if (!softRestore) { await rejectFrame(restored.rejected, type); return }
      warn('codex 流：工具项恢复被拒绝，按原始项透传', restored.rejected.code || 'restore_rejected')
      restored = { item }
    }
    const nextItem = Object.assign({}, isObject(restored && restored.item) ? restored.item : item)
    // §4.2：id / call_id 保持上游值；恢复器即使有偏差也不允许适配层重编号身份。
    if (Object.prototype.hasOwnProperty.call(item, 'id')) nextItem.id = item.id
    if (Object.prototype.hasOwnProperty.call(item, 'call_id')) nextItem.call_id = item.call_id
    // added 只恢复身份/namespace；marker 属于完成态，done 才允许出现（含恢复器补的 []）。
    if (type === 'response.output_item.added') delete nextItem.encrypted_function_args
    const data = Object.assign({}, payload, { item: nextItem })
    events.push({ type, data })
    await sendRaw(rebuildBlock(block, type, data) + '\n\n')
  }

  async function handleBlock(block) {
    if (!block || block.trim() === '') return
    const parsed = parseBlock(block)
    if (!parsed.hasData) { // 注释 / id / retry 等无 data 的块：原样透传（keepalive 不丢）
      await sendRaw(block + '\n\n')
      return
    }
    if (parsed.data === '[DONE]') {
      droppedDone += 1
      warn('codex 流：丢弃 Responses 协议不使用的 [DONE] 帧')
      return
    }
    let payload
    try { payload = JSON.parse(parsed.data) } catch {
      // 非 JSON data 帧（未知扩展/垃圾）：保持逐字节透传，由客户端自行判断。
      await sendRaw(block + '\n\n')
      return
    }
    if (!isObject(payload)) { await sendRaw(block + '\n\n'); return }
    const type = parsed.eventName || (typeof payload.type === 'string' ? payload.type : '')
    if (typeof payload.sequence_number === 'number' && Number.isFinite(payload.sequence_number)) lastSeq = payload.sequence_number
    if (isCodexTerminalEvent(type)) { await handleTerminal(type, block, payload); return }
    if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      await handleToolItem(type, block, payload)
      return
    }
    events.push({ type, data: payload })
    await sendRaw(block + '\n\n')
  }

  async function push(chunk) {
    if (ended || terminal) return
    for (const block of parser.push(chunk)) {
      if (terminal) return
      await handleBlock(block)
    }
  }

  async function end() {
    if (ended) { finishRes(); return }
    ended = true
    let blocks = []
    try { blocks = parser.flush() } catch { blocks = [] }
    for (const block of blocks) {
      if (terminal) break
      await handleBlock(block)
    }
    if (!terminal) {
      await fail('upstream stream ended without terminal event', {})
      return
    }
    finishRes()
  }

  async function fail(note, extra) {
    if (terminal) { finishRes(); return }
    const e = isObject(extra) ? extra : {}
    const code = e.timeout ? 'REQUEST_TIMEOUT' : (typeof e.code === 'string' && e.code ? e.code : 'STREAM_INTERRUPTED')
    const message = String(note || 'upstream stream interrupted')
    const error = { code, message }
    const sequence = lastSeq + 1
    const data = {
      type: 'response.failed',
      sequence_number: sequence,
      response: {
        id: responseId,
        object: 'response',
        created_at: createdAt,
        status: 'failed',
        model,
        output: [],
        error,
      },
      error,
    }
    terminal = 'response.failed'
    terminalCode = code
    recordUsage(null) // 断流也保证 usage 只回调一次（记 0，不臆造上游用量）
    // 客户端已断开/已 end：不写帧（不可达），但终态照样只记录一次。
    const delivered = !!res && !res.destroyed && !res.writableEnded
    events.push({ type: 'response.failed', data, synthetic: true, delivered })
    if (delivered) {
      try {
        await sendRaw('event: response.failed\ndata: ' + JSON.stringify(data) + '\n\n')
      } catch (err) {
        warn('codex 流：写失败帧时客户端不可写', String((err && (err.code || err.message)) || err))
      }
    }
    ended = true
    finishRes()
  }

  /**
   * 客户端中断/取消（父代理按 Esc、连接被关闭、请求被 abort）：仍然必须落到**唯一**终态，
   * 否则下游看不到任何终态、预算/槽位也无法按终态释放。取消不是上游故障：
   * 这里记录本地终态 RESPONSE_CANCELED + CLIENT_CANCELED，不写 response.failed 帧，
   * 避免把用户取消计入 provider 错误/熔断。
   */
  async function cancel(note) {
    if (terminal) { finishRes(); return }
    const message = String(note || 'client canceled before terminal state')
    terminal = RESPONSE_CANCELED
    terminalCode = CLIENT_CANCELED_CODE
    ended = true
    recordUsage(null)
    events.push({
      type: RESPONSE_CANCELED,
      data: {
        type: RESPONSE_CANCELED,
        response: { id: responseId, object: 'response', created_at: createdAt, status: 'canceled', model, output: [], error: { code: CLIENT_CANCELED_CODE, message } },
        error: { code: CLIENT_CANCELED_CODE, message },
      },
      synthetic: true,
      delivered: false,
    })
    warn('codex 流：客户端中断，记录唯一取消终态', message)
    finishRes()
  }

  // 客户端连接关闭且尚未终态 → 唯一取消终态（不写帧）。终态之后的 close 是正常收尾，不重复记录。
  if (res && typeof res.on === 'function') {
    try { res.on('close', () => { if (!terminal) { cancel('client closed before terminal state').catch(() => {}) } }) } catch {}
  }

  return {
    push,
    end,
    fail,
    cancel,
    events,
    get terminal() { return terminal },
    get terminalCode() { return terminalCode },
    get usage() { return usage },
    get droppedDoneFrames() { return droppedDone },
  }
}
