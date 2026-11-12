// Codex 原生 Responses SSE 增量适配层（MG-017 T3，契约 §4.2 / §8）。
//
// 职责边界：上游已经说 Responses 协议，本模块**不做协议翻译**，只做三件必要的事：
//   1) 工具身份恢复：response.output_item.added / done 的 item 走与 JSON 路径**同一个**
//      restoreToolItem；added 只恢复 namespace/原名，done 才补 encrypted_function_args: []；
//   2) 完成项恢复：response.completed.response.output[] 走 restoreResponseJson（逐项同源恢复）；
//   3) 终态与 usage 记账：completed/failed/incomplete 任一到达即锁定终态，之后的帧全部忽略；
//      usage 每个响应只回调一次，缺失记 0，不臆造。
// 其它字段（id / output_index / call_id / sequence_number / arguments / 未知 item 字段）一律保持
// 上游值，不重排、不重编号；未命中的帧按原样透传（含注释/keepalive）。
//
// 传输层语义：
//   · 增量解析 UTF-8（StringDecoder，多字节可跨 chunk）、CRLF/CR/LF、多行 data、注释、单帧跨 chunk；
//   · 背压：res.write() === false → 等 drain；30s 超时或未写出缓冲 > 8MiB 即按 clientStalled 拒绝，
//     并销毁连接（复用 responses-stream.js makeSink / sse.js relayStream 的 30s/8MiB 语义）；
//   · 断流：终态前 end() → fail('upstream stream ended without terminal event')，追加
//     response.failed {code:'STREAM_INTERRUPTED'}，不自动重发、不伪造成功；
//   · Responses 协议不使用 [DONE]：收到即丢弃，绝不写回客户端。
//
// 不 import src/sse.js、src/responses-stream.js 的私有实现；只复用其语义。
import { StringDecoder } from 'node:string_decoder'
import { restoreToolItem, restoreResponseJson } from './codex-responses.js'

const WRITE_WAIT_MS = 30000
const MAX_CLIENT_BUFFER_BYTES = 8 * 1024 * 1024
const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache',
  'transfer-encoding': 'chunked',
}
const TERMINAL_TYPES = new Set(['response.completed', 'response.failed', 'response.incomplete'])

// 契约 §4.2：终态事件判定（唯一真源，适配器与调用方共用）。
export function isTerminalEvent(type) {
  return typeof type === 'string' && TERMINAL_TYPES.has(type)
}

/**
 * 缓冲式增量 SSE 解析器（契约 §4.2）。
 * push(chunk) 接收 Buffer / Uint8Array / string，返回**完整** SSE 事件块（含 event:/data: 行，
 * 行尾统一为 \n，不含结尾空行）；flush() 收尾半帧并吐出解码器残留。
 * 空行分帧、连续空行与纯空块跳过；注释块作为普通块返回（由调用方决定透传）。
 */
export function createSSEParser() {
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  let heldCR = false // 尾部未决的 \r：可能是 CRLF 的前半，也可能是 CR 行尾，等下一 chunk/flush 再定

  function decodeChunk(chunk) {
    if (chunk == null) return ''
    if (typeof chunk === 'string') return chunk
    if (Buffer.isBuffer(chunk)) return decoder.write(chunk)
    if (chunk instanceof Uint8Array) return decoder.write(Buffer.from(chunk))
    return String(chunk)
  }

  // CRLF / CR / LF 统一为 \n；跨 chunk 的 \r 先挂起，避免把 CRLF 拆成两行。
  function normalize(text) {
    if (text === '' && !heldCR) return ''
    let s = heldCR ? '\r' + text : text
    heldCR = false
    if (s.endsWith('\r')) { heldCR = true; s = s.slice(0, -1) }
    return s.replace(/\r\n?/g, '\n')
  }

  function drain() {
    const frames = []
    let at
    while ((at = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, at)
      buffer = buffer.slice(at + 2)
      if (block.trim() !== '') frames.push(block)
    }
    return frames
  }

  return {
    push(chunk) {
      buffer += normalize(decodeChunk(chunk))
      return drain()
    },
    flush() {
      const rest = decoder.end()
      if (rest) buffer += normalize(rest)
      if (heldCR) { buffer += '\n'; heldCR = false }
      const frames = drain()
      if (buffer !== '') {
        const block = buffer.replace(/\n+$/, '')
        buffer = ''
        if (block.trim() !== '') frames.push(block)
      }
      return frames
    },
  }
}

function clientGoneError() {
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

  const parser = createSSEParser()
  const events = []
  let terminal = null
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
      const onClose = () => { if (settled) return; settled = true; cleanup(); reject(clientGoneError()) }
      const onError = () => { if (settled) return; settled = true; cleanup(); reject(clientGoneError()) }
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
    if (!res || res.destroyed || res.writableEnded) throw clientGoneError()
    if (bufferedLength() > maxBufferBytes) {
      try { if (typeof res.destroy === 'function') res.destroy() } catch {}
      throw writeStalledError()
    }
    ensureHeaders()
    let ok = true
    try { ok = res.write(text) } catch { throw clientGoneError() }
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
        const restored = callRestore(restoreResponseJson, original, route, plan)
        if (restored.rejected) { await rejectFrame(restored.rejected, type); return }
        const restoredJson = isObject(restored.json) ? restored.json : original
        const response = type === 'response.completed' ? finalizeCompleted(restoredJson) : restoredJson
        data = Object.assign({}, payload, { response })
        outBlock = rebuildBlock(block, type, data)
      }
    }
    // usage 只在终态记一次；completed 缺失 usage 记 0，不臆造 reasoning/缓存字段。
    recordUsage(isObject(data.response) ? data.response.usage : null)
    terminal = type
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
    const restored = callRestore(restoreToolItem, item, route, plan)
    if (restored.rejected) { await rejectFrame(restored.rejected, type); return }
    const nextItem = Object.assign({}, isObject(restored.item) ? restored.item : item)
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
    if (isTerminalEvent(type)) { await handleTerminal(type, block, payload); return }
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
    recordUsage(null) // 断流也保证 usage 只回调一次（记 0，不臆造上游用量）
    events.push({ type: 'response.failed', data, synthetic: true })
    try {
      await sendRaw('event: response.failed\ndata: ' + JSON.stringify(data) + '\n\n')
    } catch (err) {
      warn('codex 流：写失败帧时客户端不可写', String((err && (err.code || err.message)) || err))
    }
    ended = true
    finishRes()
  }

  return {
    push,
    end,
    fail,
    events,
    get terminal() { return terminal },
    get usage() { return usage },
    get droppedDoneFrames() { return droppedDone },
  }
}
