// Responses WebSocket 桥接离线回归（不触达真实上游/真实凭据）。
//
// 证明：
//   1. Codex 风格的 WS 握手成功，GET upgrade 不再拿到 404（首轮 5/7 次重连的根因）；
//   2. 每个 response.create 帧被重放进同一 POST /v1/responses，SSE 事件原样逐帧转发，终止于 response.completed；
//   3. WS 握手头/逐跳头绝不出现在上游请求；Authorization 只交给本进程 POST 入口；
//   4. generate:false 本地预热（零上游调用）；同 socket 续轮；response.interrupt 取消；
//   5. 内部 POST 的 401 以 error 帧回传，不绕过客户端 Key；
//   6. server.responsesWebSocket=false 时回退到"无 WS 桥"行为（回滚开关可用）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { randomBytes } from 'node:crypto'
import { startGateway, startScriptedUpstream } from './harness.mjs'

function sse(events) {
  return events.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join('')
}
function created(id) { return { type: 'response.created', response: { id, status: 'in_progress', output: [] } } }
function delta(id, text) { return { type: 'response.output_text.delta', delta: text, item_id: 'msg_1' } }
function completed(id, text) {
  return {
    type: 'response.completed',
    response: { id, status: 'completed', model: 'mock', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } },
  }
}

// 最小 WS 客户端（无第三方依赖）：实现握手、客户端帧掩码、服务端帧解析。
function wsConnect(port, { path = '/v1/responses', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64')
    const socket = net.connect(port, '127.0.0.1')
    let buf = Buffer.alloc(0)
    let upgraded = false
    const frames = []
    const allFrames = []
    const waiters = []
    let settled = false

    const client = {
      socket,
      frames,
      allFrames,
      send(frame) {
        const payload = Buffer.from(typeof frame === 'string' ? frame : JSON.stringify(frame), 'utf8')
        const mask = randomBytes(4)
        let header
        if (payload.length < 126) { header = Buffer.alloc(2); header[1] = 0x80 | payload.length }
        else if (payload.length < 65536) { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2) }
        else { header = Buffer.alloc(10); header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(payload.length), 2) }
        header[0] = 0x81
        const masked = Buffer.from(payload)
        for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3]
        socket.write(Buffer.concat([header, mask, masked]))
      },
      nextFrame(timeoutMs = 5000) {
        if (frames.length) return Promise.resolve(frames.shift())
        return new Promise((res, rej) => {
          const entry = { res, rej }
          const timer = setTimeout(() => {
            const i = waiters.indexOf(entry)
            if (i >= 0) waiters.splice(i, 1)
            rej(new Error('frame timeout'))
          }, timeoutMs)
          entry.timer = timer
          waiters.push(entry)
        })
      },
      async until(type, timeoutMs = 5000) {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
          const text = await this.nextFrame(Math.max(1, deadline - Date.now()))
          const obj = JSON.parse(text)
          if (obj.type === type) return obj
        }
        throw new Error('frame type not seen: ' + type)
      },
      close() { try { socket.destroy() } catch {} },
    }

    socket.on('connect', () => {
      const lines = [
        'GET ' + path + ' HTTP/1.1',
        'Host: 127.0.0.1:' + port,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: ' + key,
        'Sec-WebSocket-Version: 13',
        ...Object.entries(headers).map(([k, v]) => k + ': ' + v),
        '', '',
      ]
      socket.write(lines.join('\r\n'))
    })
    socket.on('error', (err) => { if (!settled) { settled = true; reject(err) } })
    socket.on('close', () => {
      for (const w of waiters.splice(0)) { clearTimeout(w.timer); w.rej(new Error('socket closed')) }
    })
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      if (!upgraded) {
        const at = buf.indexOf('\r\n\r\n')
        if (at < 0) return
        const head = buf.subarray(0, at).toString('utf8')
        buf = buf.subarray(at + 4)
        upgraded = true
        const m = /HTTP\/1\.1 (\d+)/.exec(head)
        if (!m || m[1] !== '101') {
          settled = true
          reject(new Error('handshake rejected: ' + head.split('\r\n')[0]))
          socket.destroy()
          return
        }
        settled = true
        resolve(client)
      }
      while (buf.length >= 2) {
        const opcode = buf[0] & 0x0f
        const masked = (buf[1] & 0x80) !== 0
        let len = buf[1] & 0x7f
        let off = 2
        if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4 }
        else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10 }
        if (masked || buf.length < off + len) break
        const payload = buf.subarray(off, off + len)
        buf = buf.subarray(off + len)
        if (opcode === 0x1) {
          const text = payload.toString('utf8')
          frames.push(text)
          allFrames.push(text)
          const w = waiters.shift()
          if (w) { clearTimeout(w.timer); w.res(text) }
        } else if (opcode === 0x8) {
          socket.end()
        }
      }
    })
  })
}

function responsesConfig(upBase, over = {}) {
  return {
    defaults: { retry: { maxAttempts: 1 }, timeout: { firstByteMs: 4000, idleMs: 4000, overallMs: 10000 }, proxyMode: 'direct' },
    providers: { mock: { baseUrl: upBase, api: 'responses' } },
    models: { 'ws-model': { provider: 'mock', api: 'responses' } },
    ...over,
  }
}
function createFrame(text, over = {}) {
  return { type: 'response.create', model: 'ws-model', stream: true, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }], ...over }
}

test('WS 握手成功；SSE 事件逐帧转发；握手头不转发上游', { timeout: 30000 }, async (t) => {
  const hits = []
  const up = await startScriptedUpstream(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    hits.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse([created('resp_ws_1'), delta('resp_ws_1', 'Hello'), completed('resp_ws_1', 'Hello')]))
  })
  const gw = await startGateway({ config: responsesConfig(up.base) })
  t.after(async () => { await gw.stop(); await up.stop() })

  const ws = await wsConnect(gw.port)
  t.after(() => ws.close())
  ws.send(createFrame('hi', { __probe: 'keep' }))
  const done = await ws.until('response.completed')
  assert.equal(done.response.id, 'resp_ws_1')
  const types = ws.allFrames.map((f) => JSON.parse(f).type)
  assert.deepEqual(types, ['response.created', 'response.output_text.delta', 'response.completed'])

  assert.equal(hits.length, 1, '一次 response.create = 一次内部 POST')
  assert.equal(hits[0].url, '/v1/responses')
  assert.equal(JSON.parse(hits[0].body).model, 'ws-model')
  for (const name of ['upgrade', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions']) {
    assert.equal(hits[0].headers[name], undefined, 'WS 握手头不得转发上游: ' + name)
  }
  assert.notEqual(String(hits[0].headers.connection || '').toLowerCase(), 'upgrade', 'connection 不得保留 upgrade 语义')
})

test('generate:false 本地预热，零上游调用；同 socket 可续传下一轮', { timeout: 30000 }, async (t) => {
  let n = 0
  const inputSizes = []
  const up = await startScriptedUpstream(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    n++
    inputSizes.push(Array.isArray(body.input) ? body.input.length : 0)
    const id = 'resp_ws_' + n
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse([created(id), completed(id, 'ok' + n)]))
  })
  const gw = await startGateway({ config: responsesConfig(up.base) })
  t.after(async () => { await gw.stop(); await up.stop() })

  const ws = await wsConnect(gw.port)
  t.after(() => ws.close())
  ws.send(createFrame('', { generate: false }))
  const warmDone = await ws.until('response.completed')
  assert.match(warmDone.response.id, /^resp_mgws_/)
  assert.deepEqual(warmDone.response.usage, { input_tokens: 0, output_tokens: 0, total_tokens: 0 })
  assert.equal(n, 0, '预热不得触达上游')

  ws.send(createFrame('turn 1'))
  await ws.until('response.completed')
  // Codex 续轮在 input 里重放完整历史（而非依赖网关持有 response 状态）。
  ws.send(createFrame('turn 2', {
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'turn 1' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok1' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'turn 2' }] },
    ],
  }))
  await ws.until('response.completed')
  assert.equal(n, 2)
  assert.deepEqual(inputSizes, [1, 3], '续轮的完整 input 原样重放')
})

test('response.interrupt 取消在途轮次，回 accepted + incomplete', { timeout: 30000 }, async (t) => {
  let aborted = false
  const up = await startScriptedUpstream(async (req, res) => {
    for await (const c of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(sse([created('resp_ws_abort')]))
    res.on('close', () => { if (!res.writableEnded) aborted = true })
    // 故意不 end：等待客户端 interrupt 触发中断。
  })
  const gw = await startGateway({ config: responsesConfig(up.base) })
  t.after(async () => { await gw.stop(); await up.stop() })

  const ws = await wsConnect(gw.port)
  t.after(() => ws.close())
  ws.send(createFrame('slow'))
  await ws.until('response.created')
  ws.send({ type: 'response.interrupt', response_id: 'resp_ws_abort' })
  const accepted = await ws.until('response.interrupt.accepted')
  assert.equal(accepted.response_id, 'resp_ws_abort')
  const incomplete = await ws.until('response.incomplete')
  assert.equal(incomplete.response.status, 'incomplete')
  assert.equal(incomplete.response.incomplete_details.reason, 'interrupted')
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(aborted, true, '内部 POST 必须被真正中止')
})

test('内部 POST 的 401 以 error 帧回传，不绕过客户端 Key', { timeout: 30000 }, async (t) => {
  let hits = 0
  const up = await startScriptedUpstream(async (req, res) => {
    hits++
    for await (const c of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'resp_never', status: 'completed', output: [] }))
  })
  const gw = await startGateway({ config: responsesConfig(up.base), env: { MG_CLIENT_KEY: 'ws-client-key' } })
  t.after(async () => { await gw.stop(); await up.stop() })

  // WS 握手本身不验 Key；每个 create 帧走内部 POST，仍受客户端 Key 约束。
  const ws = await wsConnect(gw.port)
  t.after(() => ws.close())
  ws.send(createFrame('no key'))
  const err = await ws.until('error')
  assert.equal(err.status, 401)
  assert.equal(hits, 0, '未授权轮次不得触达上游')
})

test('回滚开关：server.responsesWebSocket=false 时不接受升级', { timeout: 30000 }, async (t) => {
  const up = await startScriptedUpstream(async (req, res) => { for await (const c of req) {} res.end('{}') })
  const gw = await startGateway({ config: responsesConfig(up.base, { server: { responsesWebSocket: false } }) })
  t.after(async () => { await gw.stop(); await up.stop() })
  await assert.rejects(wsConnect(gw.port), /handshake rejected|ECONNRESET|socket hang up|closed/)
})

test('非法 WS 帧 JSON 返回 error 帧而不是崩溃', { timeout: 30000 }, async (t) => {
  const up = await startScriptedUpstream(async (req, res) => { for await (const c of req) {} res.end('{}') })
  const gw = await startGateway({ config: responsesConfig(up.base) })
  t.after(async () => { await gw.stop(); await up.stop() })
  const ws = await wsConnect(gw.port)
  t.after(() => ws.close())
  ws.send('{not json')
  const err = await ws.until('error')
  assert.match(err.error.message, /invalid WebSocket frame JSON/)
})
