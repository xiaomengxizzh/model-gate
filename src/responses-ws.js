// Responses WebSocket 桥接（Codex 原生 WS 传输消除首轮重连）。
//
// 设计要点（与 docs/evidence/2026-11-16-general-codex-websocket-bridge.md 对应）：
//   1. 只在 server.on('upgrade') 上处理 /v1/responses、/responses 的 WebSocket 升级；
//      其余路径保持原行为（拒绝升级），不干扰任何既有 upgrade 消费者。
//   2. 网关不实现"另一套 Responses 协议"：每个 response.create 帧都被重放进
//      同一个进程的 POST /v1/responses，复用既有鉴权/路由/工具修复/计费链路。
//      因此绝不存在"WS 走一条弱化的旁路"这一风险。
//   3. WebSocket 握手/帧层的头（upgrade、connection、sec-websocket-*）绝不转发给上游；
//      Authorization 等客户端凭据只交给本进程 POST 入口，由其原有 auth 策略决定如何使用。
//   4. SSE 的 data: 负载按原 JSON 文本逐条作为 WS text frame 发出，不重新序列化、不改写事件。
//      终止事件为 response.completed / response.failed / response.incomplete / error。
//   5. 无第三方依赖：WS 帧解析/编码用 node:crypto + node:net 原语实现，服务端帧不掩码，
//      客户端帧强制掩码校验（未掩码一律 1002 关闭）。

import http from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import { mergeContinuationInput, normalizeContinuationInput, recordWarmupContinuation } from './responses-continuation.js'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
export const RESPONSES_WS_PATHS = Object.freeze(new Set(['/v1/responses', '/responses']))
const TERMINAL_EVENTS = new Set(['response.completed', 'response.failed', 'response.incomplete'])
const OPCODE = Object.freeze({ CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa })

// 续轮历史重建已下沉到 POST 入口（src/responses-continuation.js）：WS 重放与 HTTP 回落
// 共用同一条续轮缓存，按 response.id 重建完整 input+output。本模块不再自持工具调用缓存
// （旧实现只补 function_call、不补其余历史项，且回落/淘汰/重启即失效——2026-11-16 审计 P0）。

// 逐跳头与 WS 握手头一律不重放进内部 POST；authorization / x-codex-* / openai-beta 等保留。
// 轮次级客户端提示（turn-metadata/routing-hint/client-request-id）只在 upgrade 时刻有效，
// 同 socket 后续轮次复用会失真——一律剔除（2026-11-16 审计 P2）。
const STRIP_HEADERS = new Set([
  'host', 'connection', 'upgrade', 'content-length', 'transfer-encoding',
  'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions',
  'sec-websocket-protocol', 'accept', 'accept-encoding', 'content-encoding', 'te', 'trailer',
  'x-codex-turn-metadata', 'x-codex-routing-hint', 'x-client-request-id',
])

function wsAccept(key) {
  return createHash('sha1').update(String(key) + WS_GUID).digest('base64')
}

function keyIsValid(key) {
  if (typeof key !== 'string' || key.length !== 24) return false
  const buf = Buffer.from(key, 'base64')
  return buf.length === 16 && buf.toString('base64') === key
}

// 镜像 src/index.js 的 hostAllowed / originAllowed（只用于 upgrade 阶段；内部 POST 会再校验一次）。
function hostAllowed(req, cfg) {
  const raw = req.headers.host
  if (!raw) return true
  let name
  try { name = String(new URL('http://' + raw).hostname).replace(/^\[|\]$/g, '').toLowerCase() } catch { return false }
  if (name === 'localhost' || name === '127.0.0.1' || name === '::1' || isIP(name)) return true
  const server = (cfg && cfg.server) || {}
  if (server.host && String(server.host).replace(/^\[|\]$/g, '').toLowerCase() === name) return true
  return (server.allowedHosts || []).some((h) => String(h).replace(/^\[|\]$/g, '').toLowerCase() === name)
}
function originAllowed(req, cfg) {
  const raw = req.headers.origin
  if (!raw || raw === 'null') return false
  let host
  try { host = new URL(raw).host.toLowerCase() } catch { return false }
  if (host === String(req.headers.host || '').toLowerCase()) return true
  const list = ((cfg && cfg.server && cfg.server.allowedOrigins) || []).map((o) => String(o).trim().toLowerCase().replace(/\/$/, ''))
  return list.includes(String(raw).trim().toLowerCase().replace(/\/$/, ''))
}

function writeRaw(socket, text) {
  try { if (!socket.destroyed) socket.write(text) } catch {}
}
function rejectUpgrade(socket, status, reason, contentType = 'text/plain; charset=utf-8') {
  const body = reason || 'unauthorized'
  writeRaw(socket, 'HTTP/1.1 ' + status + ' ' + reasonPhrase(status) + '\r\n' +
    'Content-Type: ' + contentType + '\r\n' +
    'Content-Length: ' + Buffer.byteLength(body) + '\r\n' +
    'Cache-Control: no-store\r\n' +
    'Connection: close\r\n\r\n' + body)
  try { socket.end() } catch {}
}
function reasonPhrase(status) {
  return ({ 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 426: 'Upgrade Required', 500: 'Internal Server Error' })[status] || 'Error'
}

// —— WS 连接：服务端帧不掩码；客户端帧强制掩码 ——
class WsPeer {
  constructor(socket, { maxMessageBytes, onMessage, onClose, log }) {
    this.socket = socket
    this.maxMessageBytes = maxMessageBytes
    this.onMessage = onMessage
    this.onClose = onClose
    this.log = log
    this.closed = false
    this.closing = false
    this.buffer = Buffer.alloc(0)
    this.fragments = []
    this.fragmentOpcode = null
    this.fragmentBytes = 0
    this.chain = Promise.resolve()
    this.controller = null
    this.turnActive = false
    this.turnDone = true
    this.turnOutput = []
    this.turnResponseId = null
    this.finishTurn = null
    socket.on('data', (chunk) => this._onData(chunk))
    socket.on('error', () => this._teardown())
    socket.on('close', () => this._teardown())
    // 客户端半关闭（FIN）：立即收尾在途轮次，不留僵尸连接（2026-11-16 审计 P1）。
    socket.on('end', () => { this._teardown(); try { socket.end() } catch {} })
    this.pingTimer = setInterval(() => {
      if (this.closed || this.closing || socket.destroyed) return
      this._enqueue(OPCODE.PING, Buffer.alloc(0)).catch(() => {})
    }, 60000)
    if (this.pingTimer.unref) this.pingTimer.unref()
  }

  _teardown() {
    if (this.closed) return
    this.closed = true
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null }
    if (this.controller) { try { this.controller.abort() } catch {} this.controller = null }
    try { if (this.onClose) this.onClose() } catch {}
  }

  _close(code, reason) {
    if (this.closed || this.closing) return
    // 同步置 closing：同一 chunk 内后续帧立即停止 dispatch，绝不在判死连接上再触发付费轮次。
    this.closing = true
    const reasonBuf = Buffer.from(String(reason || ''), 'utf8')
    const payload = Buffer.alloc(2 + reasonBuf.length)
    payload.writeUInt16BE(code, 0)
    reasonBuf.copy(payload, 2)
    this._enqueue(0x8, payload).finally(() => {
      this._teardown()
      try { this.socket.end() } catch {}
    })
  }

  _onData(chunk) {
    if (this.closed || this.closing) return
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (!this.closed && !this.closing) {
      const frame = this._parseFrame()
      if (!frame) break
      this._handleFrame(frame)
    }
  }

  _parseFrame() {
    const b = this.buffer
    if (b.length < 2) return null
    const fin = (b[0] & 0x80) !== 0
    const rsv = b[0] & 0x70
    const opcode = b[0] & 0x0f
    const masked = (b[1] & 0x80) !== 0
    let len = b[1] & 0x7f
    let offset = 2
    if (len === 126) {
      if (b.length < offset + 2) return null
      len = b.readUInt16BE(offset); offset += 2
    } else if (len === 127) {
      if (b.length < offset + 8) return null
      const hi = b.readUInt32BE(offset)
      if (hi !== 0) { this._close(1009, 'frame too large'); return null }
      len = b.readUInt32BE(offset + 4); offset += 8
    }
    if (!masked) { this._close(1002, 'client frames must be masked'); return null }
    if (len > this.maxMessageBytes) { this._close(1009, 'message too large'); return null }
    if (b.length < offset + 4 + len) return null
    const mask = b.subarray(offset, offset + 4); offset += 4
    const payload = Buffer.from(b.subarray(offset, offset + len))
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]
    this.buffer = b.subarray(offset + len)
    return { fin, rsv, opcode, payload }
  }

  _handleFrame(frame) {
    const { fin, rsv, opcode, payload } = frame
    if (rsv !== 0) { this._close(1002, 'RSV bits must be zero'); return }
    if (opcode >= 0x8) {
      // 控制帧必须 FIN 且载荷 ≤125（RFC 6455 §5.5）。
      if (!fin || payload.length > 125) { this._close(1002, 'invalid control frame'); return }
      if (opcode === OPCODE.CLOSE) { this._close(1000, ''); return }
      if (opcode === OPCODE.PING) { this._enqueue(OPCODE.PONG, Buffer.from(payload)).catch(() => {}); return }
      return // PONG
    }
    if (opcode === OPCODE.BINARY) { this._close(1003, 'binary frames not supported'); return }
    if (opcode === OPCODE.CONT) {
      if (this.fragmentOpcode === null) { this._close(1002, 'unexpected continuation'); return }
      this.fragments.push(payload)
      this.fragmentBytes += payload.length
      if (this.fragmentBytes > this.maxMessageBytes) { this._close(1009, 'message too large'); return }
      if (fin) {
        const buf = Buffer.concat(this.fragments)
        this.fragments = []; this.fragmentOpcode = null; this.fragmentBytes = 0
        this._dispatchText(buf)
      }
      return
    }
    if (opcode === OPCODE.TEXT) {
      // 分片进行中收到新数据帧 = 协议错误，绝不静默丢弃旧分片。
      if (this.fragmentOpcode !== null) { this._close(1002, 'new data frame during fragmentation'); return }
      if (!fin) {
        this.fragmentOpcode = opcode
        this.fragments = [payload]
        this.fragmentBytes = payload.length
        return
      }
      this._dispatchText(payload)
      return
    }
    this._close(1002, 'unsupported opcode')
  }

  _dispatchText(buf) {
    let text
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf) } catch {
      this._close(1007, 'invalid UTF-8 payload')
      return
    }
    this._dispatch(text)
  }

  _dispatch(text) {
    Promise.resolve()
      .then(() => this.onMessage(text))
      .catch((err) => {
        this.log && this.log.warn && this.log.warn('responses-ws turn error', (err && err.message) || 'unknown')
        this.sendJson({ type: 'error', error: { message: (err && err.message) || 'internal error', type: 'internal_error' } }).catch(() => {})
      })
  }

  _enqueue(opcode, payload) {
    this.chain = this.chain.then(() => this._sendFrame(opcode, payload))
    return this.chain
  }
  _sendFrame(opcode, payload) {
    if (this.closed || this.socket.destroyed) return Promise.resolve()
    let header
    const len = payload.length
    if (len < 126) {
      header = Buffer.alloc(2); header[1] = len
    } else if (len < 65536) {
      header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2)
    } else {
      header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2)
    }
    header[0] = 0x80 | opcode
    const frame = Buffer.concat([header, payload])
    return new Promise((resolve) => {
      try {
        if (this.socket.write(frame)) resolve()
        else this.socket.once('drain', resolve)
      } catch { resolve() }
    })
  }
  sendText(text) { return this._enqueue(OPCODE.TEXT, Buffer.from(String(text), 'utf8')) }
  sendJson(obj) { return this.sendText(JSON.stringify(obj)) }
}

// SSE 增量解析：把 data: 行拼为 JSON 文本回调；与 OpenAI Responses SSE 形状一致。
function sseParser(onEvent) {
  let buf = ''
  return (chunk) => {
    buf += chunk.toString('utf8').replace(/\r\n/g, '\n')
    let at
    while ((at = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, at)
      buf = buf.slice(at + 2)
      let data = ''
      for (const line of raw.split('\n')) {
        if (line.startsWith('data:')) data += (data ? '\n' : '') + line.slice(5).replace(/^ /, '')
      }
      if (data) onEvent(data)
    }
  }
}

function buildPostHeaders(upgradeReq, targetHost, targetPort, bodyText) {
  const headers = {}
  for (const [name, value] of Object.entries(upgradeReq.headers || {})) {
    const n = String(name).toLowerCase()
    if (STRIP_HEADERS.has(n) || n.startsWith('sec-websocket-')) continue
    if (value !== undefined) headers[n] = value
  }
  headers.host = targetHost + ':' + targetPort
  headers['content-type'] = 'application/json'
  headers.accept = 'text/event-stream'
  headers['accept-encoding'] = 'identity' // 内部环回不做压缩，避免 SSE 被编码后无法逐事件解析
  headers['content-length'] = Buffer.byteLength(bodyText)
  return headers
}

function errorFrame(status, payload, log) {
  let message = 'upstream request failed'
  let type = 'upstream_error'
  let detail = null
  let parsed = null
  try { parsed = JSON.parse(payload) } catch {}
  if (parsed && parsed.error) {
    message = String(parsed.error.message || message)
    type = String(parsed.error.type || type)
    detail = parsed.error
  } else if (parsed && typeof parsed === 'object') {
    // 官方后端错误可能不带 error 包裹层；只取安全的消息字段，绝不回显 body 全文/凭据。
    const code = parsed.code != null ? String(parsed.code) : ''
    const msg = parsed.message != null ? String(parsed.message) : ''
    if (msg || code) { message = (code ? code + ': ' : '') + msg.slice(0, 300); detail = { code: code || undefined, message: msg.slice(0, 300), type: 'upstream_error' } }
  }
  if (status >= 500) message = 'upstream_error: ' + status
  if (log && log.warn) {
    const keys = parsed && typeof parsed === 'object' ? Object.keys(parsed).slice(0, 12).join(',') : ''
    log.warn('responses-ws internal POST failed', 'status=' + status, 'bodyKeys=' + keys)
  }
  return { type: 'error', status, error: detail || { message, type } }
}

function runTurn(peer, { server, state, log }, frame, upgradeReq) {
  const addr = server.address()
  const bound = addr && typeof addr === 'object' ? addr.address : '127.0.0.1'
  const targetHost = (!bound || bound === '0.0.0.0') ? '127.0.0.1' : (bound === '::' ? '[::1]' : (isIP(bound) === 6 ? '[' + bound + ']' : bound))
  const targetPort = addr && typeof addr === 'object' ? addr.port : (state.cfg.server && state.cfg.server.port) || 8787
  const body = Object.assign({}, frame)
  const warmupState = peer.warmup
  if (warmupState && warmupState.id === body.previous_response_id && warmupState.model === body.model) {
    if (warmupState.input.length && (body.input == null || typeof body.input === 'string' || Array.isArray(body.input))) {
      body.input = mergeContinuationInput(warmupState.input, body.input)
    }
  } else {
    peer.warmup = null
  }
  // WS 帧控制字段不属于 Responses 请求体：type 是帧类型，generate 是预热开关。
  // 漏删会把它们透传给上游（审计 P1）；WS 轮次一律流式，强制 stream:true。
  delete body.type
  delete body.generate
  body.stream = true
  // 续轮历史重建在内部 POST 入口统一完成（responses-continuation），此处不再注入工具调用。
  const bodyText = JSON.stringify(body)
  const headers = buildPostHeaders(upgradeReq, targetHost, targetPort, bodyText)
  const controller = new AbortController()
  peer.controller = controller
  peer.turnActive = true
  peer.turnDone = false
  peer.turnOutput = []
  peer.turnResponseId = null
  let finished = false

  const finish = () => {
    if (finished) return
    finished = true
    peer.controller = null
    peer.turnActive = false
    peer.turnDone = true
  }
  peer.finishTurn = finish

  const req = http.request({
    host: targetHost.replace(/^\[|\]$/g, ''),
    port: targetPort,
    path: '/v1/responses',
    method: 'POST',
    headers,
    agent: false,
    signal: controller.signal,
  })

  req.on('response', (upstream) => {
    const status = upstream.statusCode || 502
    if (status !== 200) {
      const chunks = []
      upstream.on('data', (c) => chunks.push(c))
      upstream.on('end', () => {
        const payload = Buffer.concat(chunks).toString('utf8').slice(0, 64 * 1024)
        peer.sendJson(errorFrame(status, payload, log)).finally(finish)
      })
      upstream.on('error', () => {
        if (!finished) peer.sendJson(errorFrame(status, '', log)).finally(finish)
      })
      return
    }
    // SSE 事件转发（终止事件同步收尾，避免同分块多帧时 end 误判追加 failed）：
    const onEvent = (text) => {
      if (finished) return
      let obj = null
      try { obj = JSON.parse(text) } catch {}
      const type = obj ? String(obj.type || '') : ''
      // 累积本轮真实 output：interrupt 时回传部分输出，绝不以空 output 抹掉已流式内容。
      if (obj) {
        if (obj.response && typeof obj.response.id === 'string') peer.turnResponseId = obj.response.id
        if (type === 'response.output_item.done' && obj.item) peer.turnOutput.push(obj.item)
        if (TERMINAL_EVENTS.has(type) && obj.response && Array.isArray(obj.response.output)) peer.turnOutput = obj.response.output
      }
      if (type === 'response.completed') peer.warmup = null
      if (TERMINAL_EVENTS.has(type)) finish()
      peer.sendText(text).catch(() => finish())
    }
    const ctype = String(upstream.headers['content-type'] || '').toLowerCase()
    const chunks = []
    let parse = ctype.includes('text/event-stream') ? sseParser(onEvent) : null
    let sniffed = ctype.includes('text/event-stream') // 声明为 SSE 直接按 SSE 走
    upstream.on('data', (c) => {
      if (!sniffed) {
        // 网关部分 Responses 路径把 SSE 字节标成 application/json。按首个分块正文探测：
        // 以 event:/data:（含前置注释/keepalive/BOM）开头即 SSE；否则累积为纯 JSON 响应。
        chunks.push(c)
        const head = Buffer.concat(chunks).slice(0, 512).toString('utf8').replace(/^\uFEFF/, '').replace(/^\s+/, '')
        if (looksLikeSse(head) || /^\{/.test(head)) {
          sniffed = true
          if (/^\{/.test(head)) {
            // 纯 JSON：累积完再合成；下方 end 分支处理。
            parse = false
          } else {
            parse = sseParser(onEvent)
            for (const buffered of chunks) parse(buffered)
            chunks.length = 0
          }
        }
        return
      }
      if (parse === false) { chunks.push(c); return }
      parse(c)
    })
    upstream.on('end', () => {
      if (finished) return
      // parse===null（空 body / 无法判定前缀）与 parse===false（纯 JSON）统一走 JSON 合成；
      // 解析失败必须回 error 终态——任何路径都绝不让客户端无终态挂死（审计 P1）。
      if (parse === false || parse === null) {
        const rawText = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')
        let response = null
        try { response = JSON.parse(rawText) } catch {}
        if (!response || typeof response !== 'object') {
          peer.sendJson(errorFrame(502, '', log)).finally(finish)
          return
        }
        const id = response.id || ('resp_mgws_' + randomBytes(12).toString('hex'))
        const base = Object.assign({}, response, { id, status: response.status || 'completed' })
        peer.warmup = null
        peer.sendJson({ type: 'response.created', response: base })
          .then(() => peer.sendJson({ type: 'response.completed', response: base }))
          .finally(finish)
        return
      }
      if (parse) parse('data: ' + JSON.stringify({ type: 'response.failed', response: { status: 'failed', output: [] } }) + '\n\n')
      if (!finished) finish()
    })
    upstream.on('error', () => {
      if (!finished) peer.sendJson(errorFrame(502, '', log)).finally(finish)
    })
  })
  req.on('error', (err) => {
    if (controller.signal.aborted) { finish(); return }
    peer.sendJson(errorFrame(502, JSON.stringify({ error: { message: (err && err.message) || 'internal request failed', type: 'internal_error' } }), log)).finally(finish)
  })
  try { req.end(bodyText) } catch (err) {
    peer.sendJson(errorFrame(400, JSON.stringify({ error: { message: (err && err.message) || 'bad request', type: 'invalid_request_error' } }), log)).finally(finish)
  }
}

function warmup(peer, frame) {
  const id = 'resp_mgws_' + randomBytes(12).toString('hex')
  // Only this socket can reuse the unvalidated warmup input. The POST still
  // authenticates and validates the combined request before it reaches an upstream.
  peer.warmup = { id, model: frame.model, input: normalizeContinuationInput(frame.input) }
  // Keep the empty marker so the POST can resolve the warmup response ID.
  recordWarmupContinuation({ responseId: id, model: frame.model || '' })
  peer.sendJson({ type: 'response.created', response: { id, status: 'in_progress', model: frame.model || '', output: [] } })
  peer.sendJson({
    type: 'response.completed',
    response: { id, status: 'completed', model: frame.model || '', output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
  }).catch(() => {})
}

function onMessageFactory(ctx, upgradeReq) {
  const { state, log } = ctx
  return async (text) => {
    let frame
    try { frame = JSON.parse(text) } catch {
      await ctx.peer.sendJson({ type: 'error', error: { message: 'invalid WebSocket frame JSON', type: 'invalid_request_error' } })
      return
    }
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
      await ctx.peer.sendJson({ type: 'error', error: { message: 'WebSocket frame must be an object', type: 'invalid_request_error' } })
      return
    }
    switch (frame.type) {
      case 'response.processed':
        return // 消费确认，无需回帧
      case 'response.create':
        // Codex WS 预热帧的可靠信号是帧内 generate===false（header 的 request_kind=prewarm
        // 在真实轮次上也会出现，不能用于判断，否则真实推理被短路成空响应 → 0 tokens）。
        if (ctx.peer.turnActive) {
          await ctx.peer.sendJson({ type: 'error', error: { message: 'a turn is already in flight on this socket', type: 'busy' } })
          return
        }
        if (frame.generate === false) { warmup(ctx.peer, frame); return }
        runTurn(ctx.peer, ctx, frame, upgradeReq)
        return
      case 'response.interrupt': {
        const controller = ctx.peer.controller
        if (!controller) {
          await ctx.peer.sendJson({ type: 'response.interrupt.failed', response_id: frame.response_id || null })
          return
        }
        const rid = frame.response_id || ctx.peer.turnResponseId || null
        const partial = ctx.peer.turnOutput.slice()
        // 先停止转发再回 incomplete：否则排队中的上游事件会在 incomplete 之后继续写出，
        // 造成 WS 双终态（审计 P2）。部分输出原样回传，绝不以空 output 抹掉已流式内容。
        if (ctx.peer.finishTurn) ctx.peer.finishTurn()
        await ctx.peer.sendJson({ type: 'response.interrupt.accepted', response_id: rid })
        await ctx.peer.sendJson({
          type: 'response.incomplete',
          response: { id: rid, status: 'incomplete', incomplete_details: { reason: 'interrupted' }, output: partial },
        })
        try { controller.abort() } catch {}
        return
      }
      default:
        await ctx.peer.sendJson({ type: 'error', error: { message: 'unknown WebSocket frame type: ' + String(frame.type), type: 'invalid_request_error' } })
    }
  }
}

function handleUpgrade(req, socket, head, ctx) {
  const { server, state, log } = ctx
  const path = (req.url || '/').split('?')[0]
  if (!RESPONSES_WS_PATHS.has(path)) {
    // 保持原有语义：其它 upgrade 路径不属于本模块管辖，直接拒绝而非挂起。
    rejectUpgrade(socket, 404, 'not found')
    return
  }
  if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || String(req.headers['sec-websocket-version'] || '') !== '13' || !keyIsValid(req.headers['sec-websocket-key'])) {
    rejectUpgrade(socket, 400, 'invalid websocket handshake')
    return
  }
  if (!hostAllowed(req, state.cfg) || (req.headers.origin && !originAllowed(req, state.cfg))) {
    log && log.warn && log.warn('responses-ws upgrade denied', 'origin_or_host')
    rejectUpgrade(socket, 403, 'forbidden')
    return
  }
  const accept = wsAccept(req.headers['sec-websocket-key'])
  let handshake = 'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n'
  const protocol = String(req.headers['sec-websocket-protocol'] || '')
  if (protocol) handshake += 'Sec-WebSocket-Protocol: ' + protocol.split(',')[0].trim() + '\r\n'
  handshake += '\r\n'
  writeRaw(socket, handshake)

  const maxBody = (state.cfg.server && state.cfg.server.maxBodyBytes) || 32 * 1024 * 1024
  const wsCtx = { server, state, log, peer: null }
  const peer = new WsPeer(socket, {
    maxMessageBytes: maxBody,
    log,
    onMessage: null,
    onClose: () => { if (wsCtx.peer && wsCtx.peer.controller) { try { wsCtx.peer.controller.abort() } catch {} } },
  })
  wsCtx.peer = peer
  peer.onMessage = onMessageFactory(wsCtx, req)
  log && log.info && log.info('responses-ws upgrade accepted', 'path=' + path)
  if (head && head.length) peer._onData(head)
}

// 挂载/卸载：卸载时恢复"无 upgrade 监听"的原行为（Node 会销毁 upgrade socket）。
export function attachResponsesWebSocket(server, { state, log = null, enabled = true } = {}) {
  if (!enabled) return () => {}
  const onUpgrade = (req, socket, head) => {
    try { handleUpgrade(req, socket, head, { server, state, log }) }
    catch (err) {
      log && log.warn && log.warn('responses-ws upgrade failed', (err && err.message) || 'unknown')
      try { socket.destroy() } catch {}
    }
  }
  server.on('upgrade', onUpgrade)
  return () => server.off('upgrade', onUpgrade)
}

// 按正文前缀判定是否为 SSE（网关某些 Responses 路径把 SSE 字节误标为 application/json，不能只信 content-type）。
// 容忍 BOM、前置空白与 SSE 注释行（如 `: mg-keepalive`）——注释开头也是合法 SSE 流。
export function looksLikeSse (headText) {
  const text = String(headText || '').replace(/^\uFEFF/, '')
  for (const line of text.split('\n')) {
    const t = line.replace(/^\s+/, '').replace(/\r$/, '')
    if (t === '' || t.startsWith(':')) continue
    return /^(event:|data:|id:|retry:)/.test(t)
  }
  return false
}

export { WsPeer, sseParser, wsAccept }
