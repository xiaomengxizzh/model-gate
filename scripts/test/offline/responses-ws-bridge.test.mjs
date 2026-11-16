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
import { looksLikeSse } from '../../../src/responses-ws.js'

test('SSE 判定按正文前缀，不被 content-type 误标欺骗；容忍注释/keepalive/BOM', () => {
  assert.equal(looksLikeSse('event: response.created\ndata: {...}'), true)
  assert.equal(looksLikeSse('data: {"type":"response.created"}'), true)
  assert.equal(looksLikeSse('  \n data: {...}'), true, '允许前导空白')
  assert.equal(looksLikeSse(': mg-keepalive\n\ndata: {...}'), true, 'SSE 注释开头也是 SSE')
  assert.equal(looksLikeSse('\uFEFFdata: {...}'), true, '容忍 BOM')
  assert.equal(looksLikeSse('{"id":"resp_1","status":"completed"}'), false, '纯 JSON 不算 SSE')
  assert.equal(looksLikeSse(''), false)
  assert.equal(looksLikeSse(': only comments\n\n'), false, '只有注释没有事件行不算可判定 SSE')
})

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
          allFrames.push(text)
          const w = waiters.shift()
          // 有等待者时直接交付，不再入队——否则同一帧会被投递两次，泄漏到后续 until。
          if (w) { clearTimeout(w.timer); w.res(text) }
          else frames.push(text)
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

test('续轮重建闭环：previous_response_id 增量帧恢复完整历史（消息+工具调用不丢）', { timeout: 30000 }, async (t) => {
  const bodies = []
  let n = 0
  const up = await startScriptedUpstream(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const b = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    bodies.push(b)
    n++
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (n === 1) {
      // 第一轮：上游返回真实 function_call(wait_agent) + 助手消息（completed.output 权威全集）
      const fc = { type: 'function_call', id: 'fc_e2e', call_id: 'call_wait_e2e', name: 'wait_agent', arguments: '{}', status: 'completed' }
      const am = { type: 'message', id: 'am_e2e', role: 'assistant', content: [{ type: 'output_text', text: 'called' }] }
      res.end(sse([
        created('resp_fc'),
        { type: 'response.output_item.done', item: fc },
        { type: 'response.output_item.done', item: am },
        { type: 'response.completed', response: { id: 'resp_fc', status: 'completed', model: 'mock', output: [fc, am], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } },
      ]))
    } else {
      const id = 'resp_cont_' + n
      res.end(sse([created(id), completed(id, 'ok' + n)]))
    }
  })
  const gw = await startGateway({ config: responsesConfig(up.base) })
  t.after(async () => { await gw.stop(); await up.stop() })

  const ws = await wsConnect(gw.port, { headers: { 'thread-id': 'thread-e2e-1' } })
  t.after(() => ws.close())
  // 轮1：触发上游返回 function_call
  ws.send(createFrame('spawn then wait'))
  await ws.until('response.completed')
  await new Promise((r) => setTimeout(r, 30))
  // 轮2：真实 Codex 续轮形状——previous_response_id + 仅增量 input（孤儿 output + 新消息）。
  ws.send(createFrame('collect', {
    previous_response_id: 'resp_fc',
    input: [{ type: 'function_call_output', call_id: 'call_wait_e2e', output: 'CHILD_DONE' }],
  }))
  await ws.until('response.completed')
  await new Promise((r) => setTimeout(r, 30))
  // 轮3：链式续轮，历史必须包含前两轮全部 item。
  ws.send(createFrame('turn 3', {
    previous_response_id: 'resp_cont_2',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'turn 3' }] }],
  }))
  await ws.until('response.completed')

  assert.equal(bodies.length, 3)
  const turn2Input = bodies[1].input
  assert.equal(bodies[1].previous_response_id, undefined, 'previous_response_id 不得透传上游')
  // 第一轮的用户消息与助手消息必须被恢复（旧实现只注入 function_call，其余历史永久丢失）。
  assert.ok(turn2Input.some((x) => x.type === 'message' && x.role === 'user' && x.content[0].text === 'spawn then wait'), '轮1 用户消息 preserved')
  assert.ok(turn2Input.some((x) => x.id === 'am_e2e'), '轮1 助手消息 preserved')
  const calls = turn2Input.filter((x) => x.type === 'function_call').map((x) => x.call_id)
  assert.ok(calls.includes('call_wait_e2e'), '真实 function_call 被恢复')
  assert.ok(turn2Input.findIndex((x) => x.type === 'function_call' && x.call_id === 'call_wait_e2e') <
            turn2Input.findIndex((x) => x.type === 'function_call_output' && x.call_id === 'call_wait_e2e'), 'call 必须排在 output 前')
  assert.equal(turn2Input.find((x) => x.type === 'function_call_output').output, 'CHILD_DONE', 'output 内容未被改写')
  const turn3Input = bodies[2].input
  assert.ok(turn3Input.some((x) => x.type === 'message' && x.role === 'user' && x.content[0].text === 'spawn then wait'), '轮3 仍含轮1 用户消息')
  assert.ok(turn3Input.some((x) => x.type === 'function_call_output' && x.output === 'CHILD_DONE'), '轮3 仍含轮2 工具结果')
  assert.ok(turn3Input.some((x) => x.type === 'message' && x.role === 'user' && x.content[0].text === 'turn 3'), '轮3 新消息在末尾')
})

test('HTTP 回落续轮与 WS 共用同一续轮缓存；缺失状态优雅降级', { timeout: 30000 }, async (t) => {
  const bodies = []
  let n = 0
  const up = await startScriptedUpstream(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    n++
    const id = 'resp_http_' + n
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse([created(id), completed(id, 'http' + n)]))
  })
  const gw = await startGateway({ config: responsesConfig(up.base) })
  t.after(async () => { await gw.stop(); await up.stop() })

  // 轮1 走 WS
  const ws = await wsConnect(gw.port)
  t.after(() => ws.close())
  ws.send(createFrame('ws turn'))
  await ws.until('response.completed')
  await new Promise((r) => setTimeout(r, 30))
  // 轮2 回落 HTTP POST，带 previous_response_id + 增量 input
  const r2 = await fetch('http://127.0.0.1:' + gw.port + '/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'ws-model', stream: true, previous_response_id: 'resp_http_1', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'http turn' }] }] }),
  })
  assert.equal(r2.status, 200)
  await r2.text()
  assert.equal(bodies.length, 2)
  assert.ok(bodies[1].input.some((x) => x.content && x.content[0] && x.content[0].text === 'ws turn'), 'HTTP 回落轮恢复 WS 轮历史')
  assert.equal(bodies[1].previous_response_id, undefined)
  // 未知 previous_response_id → 优雅降级：告警 + 剔除 prev_id 转发（不再硬 400 打断会话）
  const r3 = await fetch('http://127.0.0.1:' + gw.port + '/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'ws-model', stream: true, previous_response_id: 'resp_never_seen', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'degraded' }] }] }),
  })
  assert.equal(r3.status, 200, '状态缺失降级转发，不打断会话')
  await r3.text()
  assert.equal(bodies.length, 3)
  assert.equal(bodies[2].previous_response_id, undefined, '降级轮仍剔除 prev_id')
})

test('WS 帧控制字段不透传上游：type/generate 剔除且强制 stream:true', { timeout: 30000 }, async (t) => {
  const bodies = []
  const up = await startScriptedUpstream(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse([created('resp_fields'), completed('resp_fields', 'ok')]))
  })
  const gw = await startGateway({ config: responsesConfig(up.base) })
  t.after(async () => { await gw.stop(); await up.stop() })
  const ws = await wsConnect(gw.port)
  t.after(() => ws.close())
  const frame = createFrame('fields')
  delete frame.stream
  frame.generate = true
  ws.send(frame)
  await ws.until('response.completed')
  assert.equal(bodies[0].type, undefined, '帧类型不得进入请求体')
  assert.equal(bodies[0].generate, undefined, '预热开关不得进入请求体')
  assert.equal(bodies[0].stream, true, 'WS 轮次一律流式')
})

test('SSE 正文以注释开头且 content-type 误标 json：仍逐帧转发并有终态', { timeout: 30000 }, async (t) => {
  const up = await startScriptedUpstream(async (req, res) => {
    for await (const c of req) {}
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(': mg-keepalive\n\n' + sse([created('resp_sniff'), completed('resp_sniff', 'sniffed')]))
  })
  const gw = await startGateway({ config: responsesConfig(up.base) })
  t.after(async () => { await gw.stop(); await up.stop() })
  const ws = await wsConnect(gw.port)
  t.after(() => ws.close())
  ws.send(createFrame('sniff'))
  const done = await ws.until('response.completed')
  assert.equal(done.response.id, 'resp_sniff')
})

test('200 空 body / 无法判定前缀：必回 error 终态，绝不挂死', { timeout: 30000 }, async (t) => {
  const up = await startScriptedUpstream(async (req, res) => {
    for await (const c of req) {}
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('')
  })
  const gw = await startGateway({ config: responsesConfig(up.base) })
  t.after(async () => { await gw.stop(); await up.stop() })
  const ws = await wsConnect(gw.port)
  t.after(() => ws.close())
  ws.send(createFrame('empty'))
  const err = await ws.until('error')
  assert.equal(err.status, 502)
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
  // 真实 Codex 在收到终态后等待服务端收尾再发下一轮；留一个 tick 让 turnActive 复位。
  await new Promise((r) => setTimeout(r, 30))
  // Codex 续轮在 input 里重放完整历史（而非依赖网关持有 response 状态）。
  ws.send(createFrame('turn 2', {
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'turn 1' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok1' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'turn 2' }] },
    ],
  }))
  await ws.until('response.completed')
  // 全量套件高负载下，第二帧可能早于服务端 turnActive 复位到达；轮询等待续轮落地，避免时序假阴性。
  const deadline = Date.now() + 3000
  while (n < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
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
  // incomplete 之后不得再有任何上游事件帧（双终态防护）。
  await new Promise((r) => setTimeout(r, 80))
  const after = ws.allFrames.map((f) => JSON.parse(f).type)
  const lastTerminal = after.lastIndexOf('response.incomplete')
  assert.equal(after.slice(lastTerminal + 1).filter((x) => x.startsWith('response.')).length, 0, 'incomplete 后不得再转发响应事件')
})

test('response.interrupt 保留已流式的部分输出，不以空 output 抹掉', { timeout: 30000 }, async (t) => {
  const up = await startScriptedUpstream(async (req, res) => {
    for await (const c of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(sse([
      created('resp_partial'),
      { type: 'response.output_item.done', item: { type: 'message', id: 'msg_partial', role: 'assistant', content: [{ type: 'output_text', text: 'partial work' }] } },
    ]))
    // 不 end：等待 interrupt。
  })
  const gw = await startGateway({ config: responsesConfig(up.base) })
  t.after(async () => { await gw.stop(); await up.stop() })
  const ws = await wsConnect(gw.port)
  t.after(() => ws.close())
  ws.send(createFrame('partial'))
  await ws.until('response.output_item.done')
  ws.send({ type: 'response.interrupt', response_id: 'resp_partial' })
  const incomplete = await ws.until('response.incomplete')
  assert.equal(incomplete.response.id, 'resp_partial')
  assert.ok(Array.isArray(incomplete.response.output) && incomplete.response.output.some((i) => i.id === 'msg_partial'), '部分输出必须保留在 incomplete.output')
})

test('客户端半关闭（FIN）收尾在途轮次，不留僵尸连接', { timeout: 30000 }, async (t) => {
  let aborted = false
  const up = await startScriptedUpstream(async (req, res) => {
    for await (const c of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(sse([created('resp_fin')]))
    res.on('close', () => { if (!res.writableEnded) aborted = true })
  })
  const gw = await startGateway({ config: responsesConfig(up.base) })
  t.after(async () => { await gw.stop(); await up.stop() })
  const ws = await wsConnect(gw.port)
  ws.send(createFrame('fin'))
  await ws.until('response.created')
  ws.socket.end() // 客户端 FIN（半关闭）
  const deadline = Date.now() + 3000
  while (!aborted && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
  assert.equal(aborted, true, 'FIN 后在途上游请求必须被中止')
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
