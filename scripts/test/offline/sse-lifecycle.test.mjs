// G5 / P1-B：SSE（Responses 协议）终态唯一性与请求生命周期独立回归。
// 背景：docs/roadmap/2026-11-13-modelgate-native-delegation-resolution.md §4 P1-B 要求
//   「保持请求预算、并发槽位和上游流在完整终态之前有效」，并补齐 completed/failed/无终态/
//   上游提前 close/客户端断开/取消/整体 deadline/长首字节等场景；每条请求最多一个终态。
// 覆盖矩阵与既有套件缺口见 docs/evidence/2026-11-13-sse-lifecycle-audit.md。
//
// 全部离线自包含：OS 临时配置目录 + 动态 0 端口回环网关 + 本地 mock 上游。
// 不使用真实 Key、不访问外网、不触碰生产 8787；每个用例都断言上游命中次数，
// 以证明没有重复发送/重放（命中次数是「没有重放」的唯一可观测证据）。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { startGateway, startScriptedUpstream } from './harness.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const TERMINAL = new Set(['response.completed', 'response.failed', 'response.incomplete'])

async function drain(req) {
  for await (const _ of req) { /* 消费请求体 */ }
}

// SSE 帧构造：event: 行 + 单行 data: JSON。
function sse(event, data) {
  return 'event: ' + event + '\ndata: ' + (typeof data === 'string' ? data : JSON.stringify(data)) + '\n\n'
}
const CREATED = sse('response.created', {
  type: 'response.created',
  response: { id: 'resp_mock', object: 'response', status: 'in_progress', model: 'demo' },
})
const completed = (text = '') => sse('response.completed', {
  type: 'response.completed',
  response: { id: 'resp_mock', object: 'response', status: 'completed', model: 'demo', output: [], output_text: text },
})
const failed = (code = 'UPSTREAM_ERROR', message = 'mock failure') => sse('response.failed', {
  type: 'response.failed',
  response: { id: 'resp_mock', object: 'response', status: 'failed', model: 'demo', output: [], error: { code, message } },
  error: { code, message },
})
const delta = (text) => sse('response.output_text.delta', { type: 'response.output_text.delta', delta: text })

// 解析下游 SSE：只认 event: 行；data 内出现的 "type":"response.completed" 不得被当成事件名。
function parseStream(text) {
  const out = []
  for (const block of String(text).split(/\n\n/)) {
    if (!block.trim()) continue
    let event = ''
    const dataLines = []
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
    }
    const raw = dataLines.join('\n')
    let data = raw
    try { data = raw ? JSON.parse(raw) : null } catch { data = raw }
    out.push({ event, data, raw })
  }
  return out
}
const terminalsOf = (text) => parseStream(text).filter((e) => TERMINAL.has(e.event))

// 网关配置：单个回环 mock provider + 显式 api:"responses" + codex 投影（原生 SSE 适配层）。
// codex:{} 是必要开关：没有它原生流走逐字节管道，不会合成唯一失败终态。
function gatewayConfig(upstreamBase, opts = {}) {
  return {
    defaults: {
      retry: { maxAttempts: 1 },
      timeout: Object.assign({ firstByteMs: 5000, idleMs: 60000, overallMs: 0 }, opts.timeout || {}),
      ...(opts.concurrency ? { concurrency: opts.concurrency } : {}),
    },
    providers: { mock: { baseUrl: upstreamBase } },
    models: { demo: { provider: 'mock', api: 'responses', codex: {} } },
  }
}

async function waitFor(fn, ms, message) {
  const t0 = Date.now()
  for (;;) {
    if (await fn()) return
    if (Date.now() - t0 > ms) throw new Error(message + '（等待 ' + ms + 'ms 超时）')
    await sleep(20)
  }
}

// ============================================================================
// G5-SSE-01：response.completed 是唯一终态，终态后的 completed/failed 帧必须被丢弃。
// 同时证明终态到达后网关不再读上游（连接被销毁），且整条请求只命中上游一次。
// ============================================================================
test('G5-SSE-01 response.completed 唯一终态：终态后的 completed/failed 帧被丢弃，上游命中 1 次', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res) => {
    await drain(req)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(CREATED + delta('hello') + completed('hello'))
    // 终态之后的上游异常帧：不得再进入下游，也不得产生第二个终态。
    res.write(completed('LATE_COMPLETED'))
    res.write(failed('LATE_FAILED', 'late failure'))
    res.end()
  })
  const gw = await startGateway({ name: 'g5-sse-01', config: gatewayConfig(upstream.base) })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const res = await gw.post('/v1/responses', { model: 'demo', input: 'hi', stream: true })
  assert.equal(res.status, 200, '已进入流式后状态码保持 200')
  const text = await res.text()
  const terms = terminalsOf(text)
  assert.equal(terms.length, 1, '下游必须只看到 1 个终态（实际 ' + terms.length + '）')
  assert.equal(terms[0].event, 'response.completed', '唯一终态是 response.completed')
  assert.equal(terms[0].data.response.status, 'completed')
  assert.equal(text.includes('LATE_COMPLETED'), false, '终态后的 completed 帧不得写回下游')
  assert.equal(text.includes('LATE_FAILED'), false, '终态后的 failed 帧不得写回下游')
  assert.equal(upstream.hits.length, 1, '整条请求只命中上游 1 次（无重放/无重试）')
  await waitFor(() => upstream.hits[0].closedAt !== null, 2500, '终态到达后必须停止读取并销毁上游流')
  await sleep(250)
  assert.equal(upstream.hits.length, 1, '终态后不得再次命中上游')
})

// ============================================================================
// G5-SSE-02：response.failed 是唯一终态；上游随后再发 completed 也不得追加 completed。
// ============================================================================
test('G5-SSE-02 response.failed 唯一终态：不再追加 completed，上游命中 1 次', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res) => {
    await drain(req)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(CREATED)
    res.write(failed('UPSTREAM_ERROR', 'mock upstream failure'))
    res.write(completed('AFTER_FAILED'))
    res.end()
  })
  const gw = await startGateway({ name: 'g5-sse-02', config: gatewayConfig(upstream.base) })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const res = await gw.post('/v1/responses', { model: 'demo', input: 'hi', stream: true })
  assert.equal(res.status, 200, '流式失败不改已发出的 200')
  const text = await res.text()
  const terms = terminalsOf(text)
  assert.equal(terms.length, 1, '下游必须只看到 1 个终态（实际 ' + terms.length + '）')
  assert.equal(terms[0].event, 'response.failed', '唯一终态是 response.failed')
  assert.equal(terms[0].data.response.status, 'failed')
  assert.equal(terms[0].data.error.code, 'UPSTREAM_ERROR', '上游错误码原样保留')
  assert.equal(text.includes('AFTER_FAILED'), false, '失败终态之后不得再补 completed')
  assert.equal(upstream.hits.length, 1, '整条请求只命中上游 1 次')
  await sleep(250)
  assert.equal(upstream.hits.length, 1, '失败终态后不得重试/重放')
})

// ============================================================================
// G5-SSE-03：上游提前 close（无终态）→ 合成唯一 response.failed(STREAM_INTERRUPTED)，
// 不自动重发、不重放（上游命中保持 1 次）。
// ============================================================================
test('G5-SSE-03 无终态上游提前 close：合成唯一 response.failed(STREAM_INTERRUPTED)，不重放', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res) => {
    await drain(req)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(CREATED + delta('partial'))
    res.end() // 没有 response.completed/failed/incomplete 就结束
  })
  const gw = await startGateway({ name: 'g5-sse-03', config: gatewayConfig(upstream.base) })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const res = await gw.post('/v1/responses', { model: 'demo', input: 'hi', stream: true })
  assert.equal(res.status, 200)
  const text = await res.text()
  const terms = terminalsOf(text)
  assert.equal(terms.length, 1, '无终态断流必须恰好补 1 个失败终态（实际 ' + terms.length + '）')
  assert.equal(terms[0].event, 'response.failed')
  assert.equal(terms[0].data.error.code, 'STREAM_INTERRUPTED', '断流错误码必须是 STREAM_INTERRUPTED')
  assert.equal(text.includes('response.completed'), false, '断流不得伪造 completed')
  assert.equal(upstream.hits.length, 1, '断流后不得自动重发（上游命中 1 次）')
  await waitFor(() => upstream.hits[0].closedAt !== null, 2500, '上游连接必须已关闭')
  await sleep(300)
  assert.equal(upstream.hits.length, 1, '断流后不得重连/重放')
})

// ============================================================================
// G5-SSE-04：客户端在流式中途断开 → 上游 socket 销毁、不写终态（连接不可写）、
// 不计上游错误/中断，且并发槽位在断开后归还（后续请求可立刻命中上游）。
// ============================================================================
test('G5-SSE-04 客户端流中断开：上游 socket 关闭、零上游错误、槽位可复用', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res, rec) => {
    await drain(req)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (rec.index > 0) { res.write(CREATED + completed('second')); res.end(); return }
    res.write(CREATED)
    const iv = setInterval(() => {
      if (res.destroyed || res.writableEnded) { clearInterval(iv); return }
      res.write(delta('tick'))
    }, 40)
    iv.unref?.()
    res.on('close', () => clearInterval(iv))
  })
  const gw = await startGateway({
    name: 'g5-sse-04',
    config: gatewayConfig(upstream.base, { concurrency: { maxPerProvider: 1 } }),
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  // 用底层 http.ClientRequest，读到首帧后直接 destroy 连接（真实客户端断开）。
  await new Promise((resolve, reject) => {
    const req = http.request(gw.base + '/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }, (res) => {
      res.once('data', () => { res.destroy(); resolve() })
      res.on('error', () => {})
    })
    req.on('error', () => {})
    req.end(JSON.stringify({ model: 'demo', input: 'hi', stream: true }))
    req.setTimeout(4000, () => { req.destroy(); reject(new Error('前置失败：4s 内没有收到流式首帧')) })
  })

  await waitFor(() => upstream.hits[0].closedAt !== null, 2500, '客户端断开后必须销毁上游流')
  await sleep(300)
  assert.equal(upstream.hits.length, 1, '客户端已断开，不得重连/重放（上游命中 1 次）')
  const st = await (await gw.get('/api/status')).json()
  assert.equal(st.global.errors, 0, '客户端断开不计上游错误')
  assert.equal(st.counters.interrupts, 0, '客户端断开不计流中断')

  // 槽位复用：maxPerProvider=1 时，断开后连接若不释放，这里会一直排队（表现为无上游命中）。
  const ok = await gw.post('/v1/responses', { model: 'demo', input: 'hi', stream: true })
  const text = await ok.text()
  assert.equal(ok.status, 200)
  assert.equal(terminalsOf(text).length, 1)
  assert.equal(upstream.hits.length, 2, '断开后槽位必须归还：后续请求恰好再命中上游 1 次')
})

// ============================================================================
// G5-SSE-05（2026-11-13 修复的回归）：请求预算/并发槽位必须保持到 SSE 终态。
// maxPerProvider=1 时，第一个流未产生终态前，第二个请求只能排队，绝不触达上游；
// 首个终态落地后槽位释放，第二个请求才命中上游（总命中 = 2，每请求 1 次）。
// ============================================================================
test('G5-SSE-05 并发槽位在终态前不释放：第二个请求排队到首个终态', { timeout: 30000 }, async (t) => {
  let releaseGate
  let gateOpen = false
  const gate = new Promise((resolve) => { releaseGate = () => { gateOpen = true; resolve() } })
  const upstream = await startScriptedUpstream(async (req, res, rec) => {
    await drain(req)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (rec.index === 0) {
      res.write(CREATED)
      // 终态由测试显式放行；若测试失败/客户端断开则跟随 close 结束，避免悬挂。
      await Promise.race([gate, new Promise((resolve) => res.once('close', resolve))])
      if (!res.destroyed && !res.writableEnded) res.write(completed('first'))
      if (!res.destroyed && !res.writableEnded) res.end()
      return
    }
    res.write(CREATED + completed('second'))
    res.end()
  })
  const gw = await startGateway({
    name: 'g5-sse-05',
    config: gatewayConfig(upstream.base, { concurrency: { maxPerProvider: 1 } }),
  })
  t.after(async () => { try { releaseGate() } catch {} ; await gw.stop(); await upstream.stop() })

  const first = await gw.post('/v1/responses', { model: 'demo', input: 'hi', stream: true })
  assert.equal(first.status, 200)
  const reader = first.body.getReader()
  const firstChunk = await reader.read()
  assert.equal(firstChunk.done, false, '首个请求必须已开始流出首帧')
  assert.equal(upstream.hits.length, 1, '首个流式请求已命中上游 1 次')

  let secondSettled = false
  const second = gw.post('/v1/responses', { model: 'demo', input: 'hi', stream: true })
    .then(async (r) => { secondSettled = true; return { status: r.status, text: await r.text() } })

  await sleep(350)
  assert.equal(upstream.hits.length, 1, '首个流未终态时，第二个请求不得触达上游（槽位被占用）')
  assert.equal(secondSettled, false, '首个流未终态时，第二个请求必须仍在排队')
  assert.equal(gateOpen, false, '前置：终态尚未放行')

  releaseGate()
  // 读完首个流并断言唯一终态。
  let firstText = new TextDecoder().decode(firstChunk.value || new Uint8Array())
  for (;;) {
    const part = await reader.read()
    if (part.done) break
    firstText += new TextDecoder().decode(part.value)
  }
  const firstTerms = terminalsOf(firstText)
  assert.equal(firstTerms.length, 1, '首个请求必须恰好 1 个终态')
  assert.equal(firstTerms[0].event, 'response.completed')

  const secondResult = await second
  assert.equal(secondResult.status, 200)
  const secondTerms = terminalsOf(secondResult.text)
  assert.equal(secondTerms.length, 1, '第二个请求必须恰好 1 个终态')
  assert.equal(secondTerms[0].event, 'response.completed')
  assert.equal(upstream.hits.length, 2, '两个请求各自恰好命中上游 1 次（无重复发送）')
})

// ============================================================================
// G5-SSE-06：取消（客户端在首字节前主动 abort）→ 不写终态、上游连接销毁、
// 不计上游错误，且槽位归还（后续请求可继续命中上游）。
// ============================================================================
test('G5-SSE-06 取消（首字节前 abort）：不写终态、上游销毁、零错误、槽位归还', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res, rec) => {
    await drain(req)
    if (rec.index === 0) {
      // 首字节前挂起：不写任何响应头/帧，等待客户端断开或兜底超时。
      await new Promise((resolve) => { res.once('close', resolve); setTimeout(resolve, 5000).unref?.() })
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(CREATED + completed('after-cancel'))
    res.end()
  })
  const gw = await startGateway({
    name: 'g5-sse-06',
    config: gatewayConfig(upstream.base, { concurrency: { maxPerProvider: 1 } }),
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const ac = new AbortController()
  const pending = fetch(gw.base + '/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'demo', input: 'hi', stream: true }),
    signal: ac.signal,
  })
  await waitFor(() => upstream.hits.length === 1, 3000, '取消前置：请求未命中上游')
  ac.abort()
  await assert.rejects(pending, (err) => err && (err.name === 'AbortError' || err.name === 'TimeoutError'), '取消必须以客户端中止结束')
  await waitFor(() => upstream.hits[0].closedAt !== null, 2500, '取消后必须销毁上游连接')
  await sleep(300)
  assert.equal(upstream.hits.length, 1, '取消后不得重试/重放（上游仍只命中 1 次）')
  const st = await (await gw.get('/api/status')).json()
  assert.equal(st.global.errors, 0, '取消不计上游错误')

  // 槽位归还：maxPerProvider=1 时若取消路径泄漏槽位，后续请求无法命中上游。
  const after = await gw.post('/v1/responses', { model: 'demo', input: 'hi', stream: true })
  const text = await after.text()
  assert.equal(after.status, 200)
  assert.equal(terminalsOf(text).length, 1)
  assert.equal(upstream.hits.length, 2, '取消后槽位必须归还：后续请求恰好再命中上游 1 次')
})

// ============================================================================
// G5-SSE-07：整体 deadline 在流中触发 → 恰好一个失败终态（REQUEST_TIMEOUT），
// 不重复写终态、不续传，预算计时在流式期间持续有效（非提前释放/提前 dispose）。
// ============================================================================
test('G5-SSE-07 整体 deadline 在流中触发：恰好一个 response.failed(REQUEST_TIMEOUT)，不重复终态', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res) => {
    await drain(req)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(CREATED)
    // 首个事件后静默挂起：只有请求预算能收尾（idleMs 拉长以排除空闲看门狗）。
    await new Promise((resolve) => { res.once('close', resolve); setTimeout(resolve, 4000).unref?.() })
    if (!res.destroyed && !res.writableEnded) { try { res.destroy() } catch {} }
  })
  const gw = await startGateway({
    name: 'g5-sse-07',
    config: gatewayConfig(upstream.base, { timeout: { firstByteMs: 5000, idleMs: 60000, overallMs: 600 } }),
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const t0 = Date.now()
  const res = await gw.post('/v1/responses', { model: 'demo', input: 'hi', stream: true })
  assert.equal(res.status, 200, '已进入流式，状态码不撤回')
  const text = await res.text()
  const elapsed = Date.now() - t0
  assert.ok(elapsed < 3000, '预算 600ms，实际 ' + elapsed + 'ms，必须在预算内收尾')

  const terms = terminalsOf(text)
  assert.equal(terms.length, 1, '预算耗尽必须恰好 1 个终态（实际 ' + terms.length + '）')
  assert.equal(terms[0].event, 'response.failed', '流内预算耗尽以单个失败终态收尾')
  assert.equal(terms[0].data.error.code, 'REQUEST_TIMEOUT', '错误码必须是 REQUEST_TIMEOUT')
  assert.equal(text.includes('response.completed'), false, '超时不得再补 completed')

  await waitFor(() => upstream.hits[0].closedAt !== null, 2500, '预算耗尽必须销毁上游流')
  await sleep(300)
  assert.equal(upstream.hits.length, 1, '预算耗尽后不得续传/重放（上游命中 1 次）')
  const st = await (await gw.get('/api/status')).json()
  assert.equal(st.global.errors, 0, '预算耗尽不计上游失败')
})

// ============================================================================
// G5-SSE-08：长首字节（TTFB 接近 firstByteMs 但未超）→ 正常流式收尾，唯一 completed。
// 证明长首字节不会被误判为超时/中断，也不会产生重复终态或重发。
// ============================================================================
test('G5-SSE-08 长首字节：TTFB 500ms 仍未超 firstByteMs，得到唯一 completed 终态', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res) => {
    await drain(req)
    await sleep(500) // 长首字节：响应头与首帧都晚到
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(CREATED)
    await sleep(80)
    res.write(delta('slow'))
    res.write(completed('slow'))
    res.end()
  })
  const gw = await startGateway({
    name: 'g5-sse-08',
    config: gatewayConfig(upstream.base, { timeout: { firstByteMs: 3000, idleMs: 3000, overallMs: 0 } }),
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const t0 = Date.now()
  const res = await gw.post('/v1/responses', { model: 'demo', input: 'hi', stream: true })
  const text = await res.text()
  const elapsed = Date.now() - t0
  assert.equal(res.status, 200)
  assert.ok(elapsed >= 450, '长首字节场景实际 ' + elapsed + 'ms，应确实晚于 450ms 到达')
  const terms = terminalsOf(text)
  assert.equal(terms.length, 1, '长首字节场景必须恰好 1 个终态（实际 ' + terms.length + '）')
  assert.equal(terms[0].event, 'response.completed')
  assert.equal(terms[0].data.response.output_text, 'slow')
  assert.equal(upstream.hits.length, 1, '长首字节不得触发重发（上游命中 1 次）')
})
