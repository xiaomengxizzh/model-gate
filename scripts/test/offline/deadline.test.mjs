// MG-002 请求生命周期契约 v0 的离线验收测试（TDD / 红先）。
// 契约：docs/contracts/request-lifecycle-v1.md（AC-1..AC-7）。
// 失败原因必须是「功能缺失」：src 实现由 Lead 并行进行（src/budget.js 等），本文件只断言契约行为。
//
// 依赖的实现接口（给 Lead 的清单，详见交付报告）：
//   1) defaults.timeout.overallMs 为单次数据面请求硬上限，覆盖 body 读取/排队/CONNECT/等头/读体/流式/续传；
//   2) relayStream(client, upstream, opts) 新增 opts.writeTimeoutMs（默认 30000）与
//      opts.maxBufferBytes（默认 8MiB），在写入背压时暂停拉取上游、drain 恢复、
//      超时/超缓冲中止并返回 { clientGone: true }；
//   3) 预算耗尽：响应头未发 → 504 { error: { type: 'request_timeout' } }；
//      已进入流式 → SSE error 事件 type=stream_interrupted/code=REQUEST_TIMEOUT + [DONE]。
//
// 全部离线：OS 临时配置目录 + 动态回环端口 + 本地 mock 上游；不使用真实 Key、不访问外网。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { relayStream } from '../../../src/sse.js'
import { createBudget } from '../../../src/budget.js'
import { execute, forwardOnce, readStreamOnce } from '../../../src/request.js'
import { createDeadline, createLeasePool, DEADLINE_TIMEOUT } from '../../../src/deadline.js'
import { createAttemptPolicy } from '../../../src/retry-policy.js'
import { startGateway, startScriptedUpstream, startHangingProxy } from './harness.mjs'

const CHAT_OK = JSON.stringify({
  id: 'mock-1',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const chatBody = (extra = {}) => ({ model: 'demo', messages: [{ role: 'user', content: 'hi' }], ...extra })

function config({ overallMs = 0, firstByteMs = 5000, idleMs = 5000, retry = { maxAttempts: 1 }, proxyMode = 'direct', providers = {}, models = {} } = {}) {
  return {
    defaults: { proxyMode, retry, timeout: { firstByteMs, idleMs, overallMs } },
    providers,
    models,
  }
}

function jsonModels(extra = {}) {
  return { demo: { provider: 'mock', api: 'openai', forceNoStream: true, ...extra } }
}

async function waitFor(fn, ms, message) {
  const t0 = Date.now()
  for (;;) {
    if (await fn()) return
    if (Date.now() - t0 > ms) throw new Error(message + '（等待 ' + ms + 'ms 超时）')
    await sleep(20)
  }
}

async function withTimeout(promise, ms, message) {
  let timer = null
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); timer.unref?.() }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// 客户端在 ms 内没拿到响应就明确判失败（避免 TDD 红灯时整条用例被 node:test 超时拖住）
async function fetchWithin(url, opts, ms) {
  try {
    return await fetch(url, Object.assign({}, opts, { signal: AbortSignal.timeout(ms) }))
  } catch (err) {
    throw new Error('客户端在 ' + ms + 'ms 内没有拿到响应（契约要求预算内结束）：' + (err && err.message))
  }
}

function postChat(base, body, opts = {}) {
  return fetchWithin(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, opts.timeoutMs || 4000)
}

// 半开/挂起的上游响应：客户端（或网关）destroy 后 resolve，避免 handler 悬挂。
async function hangResponse(res, ms = 6000) {
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
    res.once('close', () => { clearTimeout(timer); resolve() })
  })
  if (!res.writableEnded && !res.destroyed) { try { res.destroy() } catch {} }
}

function parseSSE(text) {
  const out = []
  for (const block of String(text).split('\n\n')) {
    const lines = block.split('\n').filter((l) => l.startsWith('data:'))
    if (!lines.length) continue
    const data = lines.map((l) => l.slice(5).trim()).join('\n')
    if (data === '[DONE]') { out.push({ done: true }); continue }
    try { out.push(JSON.parse(data)) } catch { out.push({ raw: data }) }
  }
  return out
}

// ============================================================================
// AC-1：满队列 + 小 overallMs —— 排队中的请求按预算结束并返回 504，
//       不发起上游请求，且不破坏队列（QPS 预留令牌在取消后归还）。
// ============================================================================
test('AC-1 满队列（QPS 令牌）+ 小 overallMs：排队请求 504、不触达上游、队列可继续', { timeout: 45000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(CHAT_OK)
  })
  const gw = await startGateway({
    name: 'mg002-ac1',
    config: config({
      overallMs: 300,
      providers: { mock: { baseUrl: upstream.base } },
      // qps=1：第一个请求立即消耗唯一令牌；第二个请求排队约 1s，远超 300ms 预算
      models: jsonModels({ qps: 1 }),
    }),
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  // 前置：先消耗 QPS 令牌，构造「满队列」
  const a = await postChat(gw.base, chatBody())
  assert.equal(a.status, 200, 'AC-1 前置：首个请求正常通过（QPS 令牌被消耗）')
  assert.equal(upstream.hits.length, 1, 'AC-1 前置：首个请求触达上游一次')

  // 契约 §2.3 / AC-1：排队（QPS 令牌等待）必须受 overallMs 约束
  const t0 = Date.now()
  const b = await postChat(gw.base, chatBody(), { timeoutMs: 3000 })
  const bElapsed = Date.now() - t0
  assert.equal(b.status, 504, 'AC-1：排队超预算必须返回 504（不得等令牌刷新后继续发上游）')
  const bj = await b.json()
  assert.equal(bj.error && bj.error.type, 'request_timeout', '契约 §4.1：504 信封 type=request_timeout')
  assert.match(String(bj.error.message), /overallMs/, '契约 §4.1：文案指明 defaults.timeout.overallMs')
  assert.match(String(bj.error.message), /300/, '契约 §4.1：文案含实际预算 300ms')
  assert.ok(bElapsed < 1200, 'AC-1：预算 300ms，实际 ' + bElapsed + 'ms，必须早于 QPS 令牌约 1s 的刷新点')
  assert.equal(upstream.hits.length, 1, 'AC-1：被取消的排队请求不得发起上游请求')

  // 契约 §3 排队取消规则：预留的 QPS 令牌必须归还；队列不能被取消请求打坏
  await sleep(Math.max(0, 1100 - (Date.now() - t0)))
  const c0 = Date.now()
  const c = await postChat(gw.base, chatBody(), { timeoutMs: 3000 })
  assert.equal(c.status, 200, 'AC-1：队列未被破坏，后续请求可正常获得槽位')
  assert.ok(Date.now() - c0 < 800, '契约 §3：取消请求预留的 QPS 令牌已归还（否则后续请求还要再等约 1s）')
  assert.equal(upstream.hits.length, 2, 'AC-1：只有 A/C 触达上游，取消的 B 从未触达')

  // 契约 §3：被移除的 waiter 不得在后续 release/旧定时器唤醒时继续执行
  await sleep(400)
  assert.equal(upstream.hits.length, 2, '契约 §3：取消后的 waiter 不得在旧定时器触发后补发上游请求')
})

// ============================================================================
// AC-1b（契约 §3）：客户端在 QPS 排队中断开——已预留令牌必须归还（不靠 overallMs）。
// ============================================================================
test('AC-1b 客户端在 QPS 排队中断开：预留令牌归还、队列可继续', { timeout: 45000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(CHAT_OK)
  })
  const gw = await startGateway({
    name: 'mg002-ac1b',
    config: config({
      overallMs: 0,
      providers: { mock: { baseUrl: upstream.base } },
      models: jsonModels({ qps: 1 }),
    }),
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const a = await postChat(gw.base, chatBody())
  assert.equal(a.status, 200, 'AC-1b 前置：A 消耗唯一令牌')

  // B 进入 QPS 等待后客户端断开（无 overallMs，纯取消路径）
  const bReq = http.request(gw.base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' } })
  bReq.on('error', () => {})
  bReq.end(JSON.stringify(chatBody()))
  await sleep(150)
  assert.equal(upstream.hits.length, 1, 'AC-1b 前置：B 仍在 QPS 等待，未触达上游')
  bReq.destroy()
  await sleep(1050) // 让令牌按 1 QPS 自然回填一次

  const c0 = Date.now()
  const c = await postChat(gw.base, chatBody(), { timeoutMs: 3000 })
  assert.equal(c.status, 200, 'AC-1b：取消未破坏队列')
  assert.ok(Date.now() - c0 < 800, '契约 §3：取消请求预留的 QPS 令牌已归还（否则 C 还要再等约 1s），实际 ' + (Date.now() - c0) + 'ms')
  assert.equal(upstream.hits.length, 2, 'AC-1b：只有 A/C 触达上游')
})

// ============================================================================
// AC-2：代理 CONNECT 挂起（TCP 接受但不应答）—— 预算内结束并返回 504，
//       隧道 socket 关闭。
// ============================================================================
test('AC-2 代理 CONNECT 挂起：预算内 504、隧道 socket 关闭', { timeout: 30000 }, async (t) => {
  const proxy = await startHangingProxy()
  const gw = await startGateway({
    name: 'mg002-ac2',
    config: config({
      overallMs: 500,
      proxyMode: 'auto',
      // 非回环目标 + 显式代理 → 走 CONNECT 隧道（request.js ctxFor）
      providers: { mock: { baseUrl: 'https://upstream.invalid', proxy: proxy.url } },
      models: jsonModels(),
    }),
  })
  t.after(async () => { await gw.stop(); await proxy.stop() })

  // 先发请求但不 await：先在「请求仍挂起」的时刻验证 CONNECT 隧道确实挂起（契约 §2.4 前置），
  // 再等 504 与隧道关闭。若把「504 已返回」和「隧道仍打开」绑在同一时刻会产生时序竞态。
  const t0 = Date.now()
  const req = http.request(gw.base + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
  })
  req.on('error', () => {}) // 预算耗尽后网关销毁连接，客户端可能收到 ECONNRESET
  const responseP = new Promise((resolve, reject) => {
    req.on('response', (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (d) => { raw += d })
      res.on('end', () => resolve({ status: res.statusCode, body: raw }))
      res.on('error', reject)
    })
  })
  req.end(JSON.stringify(chatBody()))

  // 1) 等本地代理收到 CONNECT 连接
  await waitFor(() => proxy.connections.length > 0, 2000, 'AC-2 前置：本地代理收到连接')
  const conn = proxy.connections[0]
  // 2) 请求仍挂起时：确实走 CONNECT 隧道，且代理不应答 → 隧道保持打开（契约 §2.4）
  assert.match(conn.data, /CONNECT /, 'AC-2 前置：确实走 CONNECT 隧道（而不是直连）')
  assert.equal(conn.closedAt, null, 'AC-2：预算未耗尽前，CONNECT 隧道应保持挂起（代理不应答）')

  // 3) 预算耗尽 → 504 信封（契约 §4.1）
  const res = await withTimeout(responseP, 3000, 'AC-2：CONNECT 挂起未在预算内以 504 收尾')
  const elapsed = Date.now() - t0
  assert.equal(res.status, 504, 'AC-2：代理 CONNECT 挂起必须在 overallMs 内以 504 收尾')
  const j = JSON.parse(res.body)
  assert.equal(j.error && j.error.type, 'request_timeout', '契约 §4.1：504 信封 type=request_timeout')
  assert.ok(elapsed < 2500, 'AC-2：预算 500ms，实际 ' + elapsed + 'ms')

  // 4) 契约 §2.4 / §3：预算耗尽要销毁上游隧道 socket
  await waitFor(() => conn.closedAt !== null, 2000, 'AC-2：预算耗尽后隧道 socket 必须被网关关闭')
})

// ============================================================================
// AC-3：慢上游响应头（超过预算）—— 预算内 504；上游连接销毁；不再重试/切换。
// ============================================================================
test('AC-3 慢上游响应头：预算内 504、上游连接销毁、不重试', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res) => { await hangResponse(res) })
  const gw = await startGateway({
    name: 'mg002-ac3',
    config: config({
      overallMs: 300,
      firstByteMs: 4000,
      retry: { maxAttempts: 3 }, // 契约 §2.5：预算耗尽后不得再重试
      providers: { mock: { baseUrl: upstream.base } },
      models: jsonModels(),
    }),
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const t0 = Date.now()
  const res = await postChat(gw.base, chatBody(), { timeoutMs: 3000 })
  const elapsed = Date.now() - t0
  assert.equal(res.status, 504, 'AC-3：慢响应头超预算必须 504（而不是等 firstByteMs 后 502）')
  const j = await res.json()
  assert.equal(j.error && j.error.type, 'request_timeout', '契约 §4.1：504 信封 type=request_timeout')
  assert.ok(elapsed < 2500, 'AC-3：预算 300ms，实际 ' + elapsed + 'ms')
  assert.equal(upstream.hits.length, 1, 'AC-3 / 契约 §2.5：预算耗尽后不再发起重试')
  await waitFor(() => upstream.hits[0].closedAt !== null, 2000, 'AC-3：上游连接必须被销毁')
  assert.equal(upstream.hits[0].aborted, true, 'AC-3：上游响应未完成即被中止（不是等它自己结束）')
})

// ============================================================================
// AC-3b（契约 §2.6）：慢上游响应体（非流式）—— 上游头已到但体未读完，
//        整体预算仍然生效；响应头尚未发给客户端 → 504，上游连接销毁。
// ============================================================================
test('AC-3b 慢上游响应体：非流式读体受预算约束，504 且上游销毁', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.write('{"id":"mock-1",')
    const iv = setInterval(() => {
      if (res.destroyed || res.writableEnded) { clearInterval(iv); return }
      res.write(' ')
    }, 100)
    iv.unref?.()
    res.on('close', () => clearInterval(iv))
  })
  const gw = await startGateway({
    name: 'mg002-ac3b',
    config: config({
      overallMs: 400,
      firstByteMs: 4000,
      providers: { mock: { baseUrl: upstream.base } },
      models: jsonModels(),
    }),
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const t0 = Date.now()
  const res = await postChat(gw.base, chatBody(), { timeoutMs: 3000 })
  const elapsed = Date.now() - t0
  assert.equal(res.status, 504, '契约 §2.6 / §4.1：读非流式响应体超预算，响应头未发给客户端 → 504')
  const j = await res.json()
  assert.equal(j.error && j.error.type, 'request_timeout', '契约 §4.1：504 信封 type=request_timeout')
  assert.ok(elapsed < 2500, 'AC-3b：预算 400ms，实际 ' + elapsed + 'ms')
  assert.equal(upstream.hits.length, 1, 'AC-3b：不重试')
  await waitFor(() => upstream.hits[0].closedAt !== null, 2000, 'AC-3b：读取中途必须销毁上游连接')
})

// ============================================================================
// AC-4a：客户端在「排队」中断开 —— waiter 移除、信号量归还、不发起上游请求。
// ============================================================================
test('AC-4a 客户端在模型并发队列中断开：waiter 移除、不触达上游、槽位可复用', { timeout: 45000 }, async (t) => {
  let releaseFirst = null
  const firstGate = new Promise((r) => { releaseFirst = r })
  const upstream = await startScriptedUpstream(async (req, res, rec) => {
    if (rec.index === 0) await firstGate
    res.setHeader('content-type', 'application/json')
    res.end(CHAT_OK)
  })
  const gw = await startGateway({
    name: 'mg002-ac4a',
    config: config({
      overallMs: 0, // 不依赖预算：本用例只验证客户端断开取消
      providers: { mock: { baseUrl: upstream.base } },
      models: jsonModels({ maxConcurrent: 1 }),
    }),
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  // A 占住唯一模型槽位（上游挂起）
  const aReq = http.request(gw.base + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
  })
  aReq.on('error', () => {})
  const aStatus = new Promise((resolve) => { aReq.on('response', (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)) }) })
  aReq.end(JSON.stringify(chatBody()))
  await waitFor(() => upstream.hits.length === 1, 3000, 'AC-4a 前置：A 触达上游并占住槽位')

  // B 进入队列后客户端主动断开
  const bReq = http.request(gw.base + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
  })
  bReq.on('error', () => {})
  bReq.end(JSON.stringify(chatBody()))
  await sleep(200)
  bReq.destroy()
  assert.equal(upstream.hits.length, 1, 'AC-4a 前置：B 仍在队列中，未触达上游')

  releaseFirst()
  assert.equal(await aStatus, 200, 'AC-4a 前置：A 正常完成并释放槽位')

  // 契约 §3：被取消的 waiter 不得在 release 后醒来继续执行
  await sleep(500)
  assert.equal(upstream.hits.length, 1, 'AC-4a / 契约 §3：排队中断开的请求不得在 release 后被唤醒并补发上游请求')

  // 契约 §3：释放恰好一次、槽位归还 → 后继请求正常
  const c = await postChat(gw.base, chatBody())
  assert.equal(c.status, 200, 'AC-4a：取消未泄漏信号量，后续请求可正常获得槽位')
  assert.equal(upstream.hits.length, 2, 'AC-4a：只有 A/C 触达上游')
})

// ============================================================================
// AC-4b：客户端在「上游等待」中断开 —— 上游 socket 关闭、不再重试。
// ============================================================================
test('AC-4b 客户端在上游等待中断开：上游 socket 关闭、不重试', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res) => { await hangResponse(res) })
  const gw = await startGateway({
    name: 'mg002-ac4b',
    config: config({
      overallMs: 0,
      firstByteMs: 4000,
      retry: { maxAttempts: 3 },
      providers: { mock: { baseUrl: upstream.base } },
      models: jsonModels(),
    }),
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const req = http.request(gw.base + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
  })
  req.on('error', () => {})
  req.end(JSON.stringify(chatBody()))
  await waitFor(() => upstream.hits.length === 1, 3000, 'AC-4b 前置：请求已到达上游')

  req.destroy() // 客户端断开（响应头仍未到）

  // 契约 §3：客户端断开 → 立即销毁上游 socket，不写响应、不计上游失败、不重试
  await waitFor(() => upstream.hits[0].closedAt !== null, 2500, 'AC-4b / 契约 §3：客户端断开后必须销毁上游 socket（而不是等 firstByteMs）')
  await sleep(400)
  assert.equal(upstream.hits.length, 1, 'AC-4b / 契约 §3：客户端断开后不得继续发起重试')
})

// ============================================================================
// AC-4c：客户端在「流式中途」断开 —— 上游 socket 关闭、不续传。
// ============================================================================
test('AC-4c 客户端在流式中途断开：上游 socket 关闭、不续传', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const iv = setInterval(() => {
      if (res.destroyed || res.writableEnded) { clearInterval(iv); return }
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'x' } }] }) + '\n\n')
    }, 50)
    iv.unref?.()
    res.on('close', () => clearInterval(iv))
  })
  const gw = await startGateway({
    name: 'mg002-ac4c',
    config: config({
      overallMs: 0,
      idleMs: 60000,
      providers: { mock: { baseUrl: upstream.base } },
      models: { demo: { provider: 'mock', api: 'openai' } },
    }),
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  await new Promise((resolve, reject) => {
    const req = http.request(gw.base + '/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
    }, (res) => {
      res.once('data', () => { res.destroy(); resolve() })
      res.on('error', () => {})
    })
    req.on('error', () => {})
    req.end(JSON.stringify(chatBody({ stream: true })))
    req.setTimeout(4000, () => { req.destroy(); reject(new Error('AC-4c 前置：未收到流式数据')) })
  })

  // 契约 §3 / §2.7：流式中途客户端断开 → 上游流销毁；已断开的客户端不触发续传
  await waitFor(() => upstream.hits[0].closedAt !== null, 2500, 'AC-4c / 契约 §3：流式中途客户端断开后必须销毁上游流')
  await sleep(400)
  assert.equal(upstream.hits.length, 1, 'AC-4c / 契约 §2.7：客户端已断开，不得续传重连')
  // M1：客户端断开不得计入上游中断/错误（健康面板与错误率不被污染）
  const st = await (await gw.get('/api/status')).json()
  assert.equal(st.global.errors, 0, '契约 §3：客户端断开不计上游错误')
  assert.equal(st.counters.interrupts, 0, '契约 §3：客户端断开不计流中断')
})

// ============================================================================
// AC-5：流式阶段预算耗尽 —— 客户端收到 SSE error 事件 + [DONE]；
//       上游流销毁；不再续传。
// ============================================================================
test('AC-5 流式阶段预算耗尽：SSE error(REQUEST_TIMEOUT) + [DONE]、上游销毁、不续传', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const iv = setInterval(() => {
      if (res.destroyed || res.writableEnded) { clearInterval(iv); return }
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'tick' } }] }) + '\n\n')
    }, 80)
    iv.unref?.()
    res.on('close', () => clearInterval(iv))
  })
  const gw = await startGateway({
    name: 'mg002-ac5',
    config: config({
      overallMs: 400,
      idleMs: 60000, // 排除 idle 看门狗，确保是整体预算触发
      providers: { mock: { baseUrl: upstream.base } },
      models: { demo: { provider: 'mock', api: 'openai' } },
    }),
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const t0 = Date.now()
  const res = await postChat(gw.base, chatBody({ stream: true }), { timeoutMs: 5000 })
  assert.equal(res.status, 200, '契约 §4.2：已进入流式，响应头/状态码不撤回（仍为 200）')
  const text = await res.text()
  const elapsed = Date.now() - t0
  assert.ok(elapsed < 3000, 'AC-5：预算 400ms，实际 ' + elapsed + 'ms，必须预算内收尾')

  const events = parseSSE(text)
  const errors = events.filter((e) => e && e.error)
  // 契约 §4.2：data: {"error":{"message":"...","type":"stream_interrupted","code":"REQUEST_TIMEOUT"}}
  assert.equal(errors.length, 1, 'AC-5 / 契约 §4.2：流式预算耗尽必须恰好一个 SSE error 事件')
  assert.equal(errors[0].error.type, 'stream_interrupted', 'AC-5 / 契约 §4.2：error.type=stream_interrupted')
  assert.equal(errors[0].error.code, 'REQUEST_TIMEOUT', 'AC-5 / 契约 §4.2：error.code=REQUEST_TIMEOUT')
  assert.ok(String(errors[0].error.message).length > 0, 'AC-5 / 契约 §4.2：error.message 非空')

  const doneIdx = text.indexOf('data: [DONE]')
  const errIdx = text.indexOf('"stream_interrupted"')
  assert.ok(doneIdx !== -1, 'AC-5 / 契约 §4.2：必须发送 data: [DONE]')
  assert.ok(errIdx !== -1 && doneIdx > errIdx, 'AC-5 / 契约 §4.2：顺序为 error 事件之后 [DONE]')
  assert.ok(events.filter((e) => e && e.done).length === 1, 'AC-5：恰好一个 [DONE]')

  await waitFor(() => upstream.hits[0].closedAt !== null, 2000, 'AC-5 / 契约 §3：预算耗尽必须销毁上游流')
  await sleep(400)
  assert.equal(upstream.hits.length, 1, 'AC-5 / 契约 §2.7：预算耗尽后不得续传重连')
})

// ============================================================================
// AC-6（确定性单元测试）：SSE 背压。
// 不依赖内核 socket 缓冲：自造 client（write 返回 false、手动 emit drain）与自造上游 async-iterable。
// ============================================================================
const SSE_DATA = (i) => 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'c' + i } }] }) + '\n\n'
const SSE_DONE = 'data: [DONE]\n\n'

function fakeClient(acceptWrites = true) {
  const client = new EventEmitter()
  client.writes = []
  client.destroyed = false
  client.writableEnded = false
  client.writableLength = 0
  client.acceptWrites = acceptWrites
  client.write = (chunk) => {
    client.writes.push(String(chunk))
    client.writableLength += Buffer.byteLength(String(chunk))
    return client.acceptWrites
  }
  client.end = () => { client.writableEnded = true }
  client.destroy = () => { client.destroyed = true; client.emit('close') }
  return client
}

function fakeUpstream(pulls, chunks) {
  const stream = {
    destroyed: false,
    destroy() { stream.destroyed = true },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        if (stream.destroyed) return
        pulls.n += 1
        yield chunk
      }
    },
  }
  return stream
}

test('AC-6a SSE 背压：write=false 后暂停拉取上游，drain 后恢复（契约 §5）', { timeout: 15000 }, async () => {
  const pulls = { n: 0 }
  const client = fakeClient(false) // 第一次写就返回 false
  const stream = fakeUpstream(pulls, [SSE_DATA(0), SSE_DATA(1), SSE_DONE])

  const p = relayStream(client, stream, {
    idleMs: 0, maxReconnects: 0,
    writeTimeoutMs: 5000, maxBufferBytes: 8 * 1024 * 1024,
  })
  await sleep(150)

  // 契约 §5：res.write() 返回 false 后必须暂停读取上游流（不再拉取下一个 chunk）
  assert.equal(pulls.n, 1, '契约 §5：write=false 后上游只被拉取一次，不得继续读')
  assert.equal(client.writes.some((w) => w.includes('[DONE]')), false, '契约 §5：背压期间不得继续排空/写入 [DONE]')

  // 恢复消费：drain 后应继续拉取上游直到结束
  client.writableLength = 0
  client.acceptWrites = true
  client.emit('drain')

  const r = await withTimeout(p, 5000, '契约 §5：emit(drain) 后中继没有恢复')
  assert.equal(pulls.n, 3, '契约 §5：drain 后恢复读取上游（3 个 chunk 全部拉取）')
  assert.ok(client.writes.some((w) => w.includes('[DONE]')), '契约 §5：恢复后正常收尾 [DONE]')
  assert.equal(r.completed, true, '契约 §5：背压恢复后流正常完成')
})

test('AC-6b SSE 背压：等待 drain 超时 → 中止并销毁客户端/上游（契约 §5 WRITE_WAIT_MS）', { timeout: 15000 }, async () => {
  const pulls = { n: 0 }
  const client = fakeClient(false) // 永不 drain
  const stream = fakeUpstream(pulls, [SSE_DATA(0), SSE_DATA(1), SSE_DATA(2), SSE_DONE])

  const t0 = Date.now()
  const r = await withTimeout(relayStream(client, stream, {
    idleMs: 0, maxReconnects: 0,
    writeTimeoutMs: 80, maxBufferBytes: 8 * 1024 * 1024,
  }), 3000, '契约 §5：writeTimeoutMs 超时后中继没有中止')

  assert.ok(Date.now() - t0 < 2500, '契约 §5：等待 drain 超时（80ms）应很快中止，实际 ' + (Date.now() - t0) + 'ms')
  assert.equal(client.destroyed, true, '契约 §5：等待超时视为客户端不再消费，销毁客户端连接')
  assert.equal(stream.destroyed, true, '契约 §5：同时销毁上游流')
  assert.equal(r && r.clientGone, true, '契约 §5 / §3：按 client_closed 记账（不计上游失败）')
  assert.ok(pulls.n < 4, '契约 §5：中止后不得继续拉取上游（实际 ' + pulls.n + '）')
})

test('AC-6c SSE 背压：未写出缓冲超限 → 立即中止，禁止无界缓冲（契约 §5 MAX_CLIENT_BUFFER_BYTES）', { timeout: 15000 }, async () => {
  const pulls = { n: 0 }
  const client = fakeClient(true)
  // 模拟已被慢客户端堆住的未写出缓冲（超过上限）：网关必须在继续读上游前中止，而不是无界缓冲
  client.writableLength = 500
  const chunks = []
  for (let i = 0; i < 10; i++) chunks.push(SSE_DATA(i))
  chunks.push(SSE_DONE)
  const stream = fakeUpstream(pulls, chunks)

  const r = await withTimeout(relayStream(client, stream, {
    idleMs: 0, maxReconnects: 0,
    writeTimeoutMs: 5000, maxBufferBytes: 200,
  }), 2000, '契约 §5：缓冲超限后中继没有立即中止')

  assert.equal(client.destroyed, true, '契约 §5：writableLength 超过上限立即中止客户端连接')
  assert.equal(stream.destroyed, true, '契约 §5：同时销毁上游流')
  assert.equal(r && r.clientGone, true, '契约 §5 / §3：缓冲超限按 client_closed 记账')
  assert.ok(pulls.n <= 1, '契约 §5：超限立即中止，不再继续拉取上游（实际 ' + pulls.n + '）')
  assert.ok(client.writes.length <= 1, '契约 §5：禁止无界缓冲，不得继续把上游 chunk 写入客户端（实际写入 ' + client.writes.length + ' 次）')
})

test('AC-6d SSE 背压：等待 drain 期间客户端断开 → 立即中止（契约 §5 / §3）', { timeout: 15000 }, async () => {
  const pulls = { n: 0 }
  const client = fakeClient(false)
  const stream = fakeUpstream(pulls, [SSE_DATA(0), SSE_DATA(1), SSE_DONE])

  const p = relayStream(client, stream, {
    idleMs: 0, maxReconnects: 0,
    writeTimeoutMs: 5000, maxBufferBytes: 8 * 1024 * 1024,
  })
  await sleep(120)
  assert.equal(stream.destroyed, false, '契约 §5 前置：尚未超时，仍在等待 drain')

  // 客户端断开（不经过本实现的 destroy()，模拟对端关闭）
  client.destroyed = true
  client.emit('close')

  const r = await withTimeout(p, 3000, '契约 §5：背压等待中客户端断开后中继没有结束')
  assert.equal(stream.destroyed, true, '契约 §5：背压等待期间必须响应客户端断开并销毁上游')
  assert.equal(r && r.clientGone, true, '契约 §3：按 client_closed 记账')
})

// ============================================================================
// AC-6e（契约 §5）：背压等待期间仍需响应 noEventMs 看门狗，不能死等 30s 写入超时。
// ============================================================================
test('AC-6e 背压等待期间 noEventMs 看门狗生效：快速中止而非等满 writeTimeoutMs', { timeout: 15000 }, async () => {
  const pulls = { n: 0 }
  const client = fakeClient(false) // 永不 drain
  const stream = fakeUpstream(pulls, [SSE_DATA(0), SSE_DATA(1), SSE_DONE])
  const t0 = Date.now()
  await withTimeout(relayStream(client, stream, {
    idleMs: 0, noEventMs: 150, maxReconnects: 0, writeTimeoutMs: 5000,
  }), 3000, '契约 §5：背压等待中看门狗没有打断 drain 等待')
  const elapsed = Date.now() - t0
  assert.ok(elapsed < 1500, '契约 §5：backpressure 等待应被 noEventMs(150) 打断，实际 ' + elapsed + 'ms（若接近 5000 说明未响应）')
  assert.equal(stream.destroyed, true, '契约 §5：看门狗判死后销毁上游流')
})

// ============================================================================
// AC-4e（契约 §4.2 / §6）：已完成流（[DONE]）即使终止帧写入瞬间预算到期，也不得判 timedOut。
// ============================================================================
test('AC-4e 已完成流不判超时：终止帧写入瞬间预算到期仍为 completed', { timeout: 15000 }, async () => {
  const b = createBudget({ overallMs: 0 })
  const client = fakeClient(true)
  const origWrite = client.write
  client.write = (chunk) => {
    const ok = origWrite.call(client, chunk)
    if (String(chunk).includes('[DONE]')) b.abort('request_timeout') // 模拟终止帧写入瞬间预算截止
    return ok
  }
  const stream = fakeUpstream({ n: 0 }, [SSE_DATA(0), SSE_DONE])
  const res = await withTimeout(relayStream(client, stream, { idleMs: 0, maxReconnects: 0, signal: b.signal, budget: b }), 3000, '契约 §6：终止帧写入后中继没有结束')
  assert.equal(res.completed, true, '契约 §6：已收到 [DONE] 必须为 completed')
  assert.equal(res.timedOut, false, '契约 §6：已完成流不得判为 timedOut')
})

// ============================================================================
// AC-4d（分类）：客户端断开与预算耗尽必须区分——client_closed 不得记为 timedOut。
// ============================================================================
test('AC-4d 分类：client_closed 与 request_timeout 不混淆（单元）', { timeout: 15000 }, async () => {
  // 客户端断开
  const b1 = createBudget({ overallMs: 0 })
  const c1 = fakeClient(false)
  const s1 = fakeUpstream({ n: 0 }, [SSE_DATA(0), SSE_DONE])
  const p1 = relayStream(c1, s1, { idleMs: 0, maxReconnects: 0, signal: b1.signal, budget: b1, writeTimeoutMs: 5000 })
  await sleep(50)
  b1.abort('client_closed')
  const r1 = await withTimeout(p1, 3000, '契约 §3：客户端断开后中继没有结束')
  assert.equal(r1.clientGone, true, '契约 §3：客户端断开按 clientGone 记账')
  assert.equal(r1.timedOut, false, '契约 §3：客户端断开不得误记为预算耗尽')

  // 预算耗尽
  const b2 = createBudget({ overallMs: 60 })
  const c2 = fakeClient(false)
  const s2 = fakeUpstream({ n: 0 }, [SSE_DATA(0), SSE_DONE])
  const p2 = relayStream(c2, s2, { idleMs: 0, maxReconnects: 0, signal: b2.signal, budget: b2, writeTimeoutMs: 5000 })
  const r2 = await withTimeout(p2, 3000, '契约 §4.2：预算耗尽后中继没有结束')
  assert.equal(r2.timedOut, true, '契约 §4.2：预算耗尽按 timedOut 记账')
  assert.equal(r2.clientGone, false, '契约 §4.2：预算耗尽不得误记为客户端断开')
})

// ============================================================================
// AC-7：慢 body —— 读取客户端请求 body 受预算约束，超时 504 并释放连接。
// ============================================================================
test('AC-7 慢请求 body：读取受预算约束，504 且释放连接', { timeout: 30000 }, async (t) => {
  const gw = await startGateway({
    name: 'mg002-ac7',
    config: config({
      overallMs: 300,
      providers: { mock: { baseUrl: 'http://127.0.0.1:1' } }, // 不应被触达
      models: jsonModels(),
    }),
  })
  t.after(async () => { await gw.stop() })

  const payload = JSON.stringify(chatBody())
  const req = http.request(gw.base + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
  })
  req.on('error', () => {}) // 504 后网关销毁连接，客户端可能收到 EPIPE/ECONNRESET
  let socketClosed = false
  req.on('socket', (s) => s.on('close', () => { socketClosed = true }))

  const responseP = new Promise((resolve, reject) => {
    req.on('response', (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (d) => { raw += d })
      res.on('end', () => resolve({ status: res.statusCode, body: raw }))
      res.on('error', reject)
    })
  })
  req.write(payload.slice(0, 20)) // 半截 body，永不 end

  const t0 = Date.now()
  const res = await withTimeout(responseP, 3000, 'AC-7：慢 body 没有在预算内返回 504')
  assert.equal(res.status, 504, 'AC-7 / 契约 §2.1 / §4.1：读 body 超预算 → 504')
  const j = JSON.parse(res.body)
  assert.equal(j.error && j.error.type, 'request_timeout', '契约 §4.1：504 信封 type=request_timeout')
  assert.ok(Date.now() - t0 < 2500, 'AC-7：预算 300ms，实际 ' + (Date.now() - t0) + 'ms')

  // 契约 §3：释放连接（销毁请求 socket），不得留下半截 body 的悬挂连接
  await waitFor(() => socketClosed || req.destroyed, 2000, 'AC-7 / 契约 §3：慢 body 超时后必须释放连接')
})

// ============================================================================
// M1-1（T-LIFE-02）：单调 deadline 单一来源，覆盖排队等待、连接、写体、读头、流读取
// 与重试等待；等待可被取消唤醒，绝不越过截止时间。确定性部分用注入时钟。
// ============================================================================
function createFakeClock(start = 1000) {
  let now = start
  let seq = 0
  const timers = new Map()
  const clock = {
    start,
    now: () => now,
    timers: {
      setTimeout(fn, ms) {
        const id = ++seq
        timers.set(id, { id, at: now + Math.max(0, Number(ms) || 0), fn })
        return { id, unref() {} }
      },
      clearTimeout(handle) { if (handle && handle.id != null) timers.delete(handle.id) },
    },
    pending() { return [...timers.values()] },
    nextAt() {
      let at = Infinity
      for (const t of timers.values()) at = Math.min(at, t.at)
      return Number.isFinite(at) ? at : null
    },
    advanceTo(at) {
      now = Math.max(now, at)
      for (;;) {
        let due = null
        for (const t of timers.values()) {
          if (t.at > now) continue
          if (!due || t.at < due.at || (t.at === due.at && t.id < due.id)) due = t
        }
        if (!due) break
        timers.delete(due.id)
        due.fn()
      }
    },
    advance(ms) { clock.advanceTo(now + Math.max(0, ms)) },
    async drive(promise, label = 'execute') {
      let settled = false
      let value
      let failure
      const tracked = promise.then((v) => { settled = true; value = v }, (e) => { settled = true; failure = e })
      for (let steps = 0; steps < 500 && !settled; steps++) {
        await new Promise((r) => setImmediate(r))
        if (settled) break
        const next = clock.nextAt()
        if (next == null) {
          await new Promise((r) => setImmediate(r))
          if (settled) break
          if (clock.nextAt() == null) throw new Error(label + '：没有待触发的定时器但执行未结束')
          continue
        }
        clock.advanceTo(next)
      }
      await tracked
      if (failure) throw failure
      return value
    },
  }
  return clock
}

test('T-LIFE-02a 单调 deadline 钳制等待：5000ms 等待在 100ms 预算处醒来（注入时钟）', async () => {
  const clock = createFakeClock()
  const deadline = createDeadline({ overallMs: 100, now: clock.now, timers: clock.timers })
  const waiting = deadline.wait(5000)
  const scheduled = clock.pending().map((t) => t.at - clock.now())
  assert.ok(scheduled.length >= 1, '等待必须排定时器')
  assert.equal(Math.max(...scheduled), 100, '不得按 5000ms 排等待（必须被剩余预算钳制）')
  clock.advance(100)
  const result = await waiting
  assert.equal(result.ok, false, '预算耗尽时等待不得成功')
  assert.equal(result.reason, DEADLINE_TIMEOUT)
  assert.equal(result.waitedMs, 100, '实际等待恰好是剩余预算')
  assert.equal(deadline.timedOut(), true)
  assert.equal(deadline.expired(), true)
})

test('T-LIFE-02b 排队等待消耗同一 deadline：到期唤醒、waiter 移除、令牌不泄漏', async () => {
  const clock = createFakeClock()
  const pool = createLeasePool({ concurrency: 1, now: clock.now, timers: clock.timers })
  const holder = await pool.acquire(createDeadline({ overallMs: 0, now: clock.now, timers: clock.timers }))
  assert.equal(pool.active(), 1)
  const waiterDeadline = createDeadline({ overallMs: 500, now: clock.now, timers: clock.timers })
  const waiter = pool.acquire(waiterDeadline).then(() => null, (err) => err)
  assert.equal(pool.waiting(), 1, '第二个请求进入排队')
  clock.advance(500)
  const err = await waiter
  assert.ok(err && err.aborted, '排队超 deadline 必须被唤醒并中止')
  assert.equal(err.reason, DEADLINE_TIMEOUT)
  assert.equal(pool.waiting(), 0, '超时的 waiter 已移出队列')
  assert.equal(pool.active(), 1, '持有者槽位不受影响')
  holder.release()
  assert.equal(pool.active(), 0)
  const fresh = await pool.acquire(createDeadline({ overallMs: 0, now: clock.now, timers: clock.timers }))
  assert.equal(typeof fresh.release, 'function', '队列未被破坏，后续可正常获得令牌')
  fresh.release()
})

test('T-LIFE-02b2 排队等待被取消唤醒：CANCELLED 原因、waiter 移除、令牌归还', async () => {
  const clock = createFakeClock()
  const pool = createLeasePool({ concurrency: 1, now: clock.now, timers: clock.timers })
  const holder = await pool.acquire(createDeadline({ overallMs: 0, now: clock.now, timers: clock.timers }))
  const controller = new AbortController()
  const deadline = createDeadline({ overallMs: 0, signal: controller.signal, now: clock.now, timers: clock.timers })
  const waiter = pool.acquire(deadline).then(() => null, (err) => err)
  assert.equal(pool.waiting(), 1)
  controller.abort()
  const err = await waiter
  assert.ok(err && err.aborted && err.reason === 'client_closed', '取消必须立即唤醒等待者')
  assert.equal(pool.waiting(), 0)
  assert.equal(pool.active(), 1)
  holder.release()
  assert.equal(pool.active(), 0, '取消的 waiter 没有泄漏令牌')
})

test('T-LIFE-02c 连接/读响应头阶段超时：同一 deadline 中止、不重试、上游连接销毁', { timeout: 20000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000)
      timer.unref?.()
      res.once('close', () => { clearTimeout(timer); resolve() })
    })
  })
  t.after(() => upstream.stop())
  const adapter = {
    forwardOnce(attempt, ctl) {
      return forwardOnce(
        { baseUrl: upstream.base }, '/v1/chat/completions', 'POST',
        { 'content-type': 'application/json' },
        Buffer.from(JSON.stringify({ model: 'demo', messages: [{ role: 'user', content: 'hi' }] })),
        { timeout: { firstByteMs: 5000, idleMs: 5000 } }, attempt, ctl,
      )
    },
  }
  const t0 = Date.now()
  const result = await execute(
    { overallMs: 150, target: 'p1', maxAttempts: 3 },
    adapter,
    createAttemptPolicy({ maxAttempts: 3, initialDelayMs: 5, jitter: 0 }),
  )
  const elapsed = Date.now() - t0
  assert.equal(result.outcome, 'DEADLINE_EXCEEDED', '读头阶段预算耗尽必须按 deadline 终态收尾')
  assert.equal(result.attemptsMade, 1, 'deadline 耗尽不得再重试')
  assert.equal(upstream.hits.length, 1, '上游只被命中一次')
  assert.equal(result.deadline.timedOut, true)
  assert.ok(elapsed < 1200, '预算 150ms，实际 ' + elapsed + 'ms，不得出现超 deadline 的额外等待')
  await waitFor(() => upstream.hits[0].closedAt !== null, 2000, '超时后上游连接必须销毁')
})

test('T-LIFE-02d 写请求体阶段受同一 deadline 约束：大 body 挂起仍按时中止', { timeout: 20000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res) => {
    req.once('close', () => { try { res.destroy() } catch {} })
    req.once('error', () => { try { res.destroy() } catch {} })
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000)
      timer.unref?.()
      req.once('close', () => { clearTimeout(timer); resolve() })
      req.once('error', () => { clearTimeout(timer); resolve() })
    })
  })
  t.after(() => upstream.stop())
  const bigBody = Buffer.alloc(2 * 1024 * 1024, 0x7b)
  const adapter = {
    forwardOnce(attempt, ctl) {
      return forwardOnce(
        { baseUrl: upstream.base }, '/v1/chat/completions', 'POST',
        { 'content-type': 'application/json' }, bigBody,
        { timeout: { firstByteMs: 5000, idleMs: 5000 } }, attempt, ctl,
      )
    },
  }
  const t0 = Date.now()
  const result = await execute({ overallMs: 150, target: 'p1', maxAttempts: 1 }, adapter, createAttemptPolicy({ maxAttempts: 1 }))
  const elapsed = Date.now() - t0
  assert.equal(result.outcome, 'DEADLINE_EXCEEDED')
  assert.equal(result.attempts[0].writeStarted, true, '写阶段开始即记录证据')
  assert.equal(result.attempts[0].wroteBody, true)
  assert.equal(result.attempts[0].receivedHeaders, false, '写体阶段仍无响应头')
  assert.equal(result.deadline.timedOut, true)
  assert.equal(result.attemptsMade, 1, '写体超时不得重试')
  assert.equal(upstream.hits.length, 1, '上游只收到一次请求')
  assert.ok(elapsed < 1200, '写体阶段不得越过 deadline，实际 ' + elapsed + 'ms')
})

test('T-LIFE-02e 流读取阶段受同一 deadline 约束：超时销毁流、一次终态、不重放', { timeout: 20000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const iv = setInterval(() => {
      if (res.destroyed || res.writableEnded) { clearInterval(iv); return }
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'tick' } }] }) + '\n\n')
    }, 40)
    iv.unref?.()
    res.on('close', () => clearInterval(iv))
  })
  t.after(() => upstream.stop())
  const adapter = {
    async forwardOnce(attempt, ctl) {
      const r = await forwardOnce(
        { baseUrl: upstream.base }, '/v1/chat/completions', 'POST',
        { 'content-type': 'application/json' },
        Buffer.from(JSON.stringify({ model: 'demo', messages: [{ role: 'user', content: 'hi' }], stream: true })),
        { timeout: { firstByteMs: 5000, idleMs: 5000 } }, attempt, ctl,
      )
      await readStreamOnce(r.stream, ctl.deadline, {
        onChunk(text) { if (text.includes('"delta"')) attempt.onFirstSemanticEvent({ source: 'sse' }) },
      })
      return r
    },
  }
  const t0 = Date.now()
  const result = await execute({ overallMs: 200, target: 'p1', maxAttempts: 3 }, adapter, createAttemptPolicy({ maxAttempts: 3 }))
  const elapsed = Date.now() - t0
  assert.equal(result.outcome, 'DEADLINE_EXCEEDED', '流读取预算耗尽按 deadline 终态收尾')
  assert.equal(result.attemptsMade, 1, '流读取超时不得重放')
  assert.ok(elapsed < 1500, '流读取不得越过 deadline 太久，实际 ' + elapsed + 'ms')
  await waitFor(() => upstream.hits[0].closedAt !== null, 2000, '流读取超时必须销毁上游流')
})

test('T-LIFE-02f 429 Retry-After 等待计入同一 deadline（注入时钟）', async () => {
  const clock = createFakeClock()
  let hits = 0
  const adapter = {
    async forwardOnce(attempt) {
      hits += 1
      attempt.onWriteBegin()
      if (hits === 1) {
        attempt.onResponseHeaders({ status: 429, headers: { 'retry-after': '2' } })
        return { ok: false, status: 429, headers: { 'retry-after': '2' }, retryAfter: 2000, bodyText: 'Rate limit exceeded' }
      }
      attempt.onResponseHeaders({ status: 200, headers: {} })
      return { ok: true, status: 200, headers: {} }
    },
  }
  const fit = await clock.drive(execute(
    { overallMs: 10000, target: 'p1', maxAttempts: 2, now: clock.now, timers: clock.timers },
    adapter,
    createAttemptPolicy({ maxAttempts: 2, jitter: 0 }),
  ))
  assert.equal(fit.outcome, 'SUCCEEDED', '预算装得下 Retry-After → 等待后重发成功')
  assert.equal(hits, 2)
  assert.equal(fit.waitedMs, 2000, '等待量等于 Retry-After')
  assert.equal(clock.now() - clock.start, 2000, '等待消耗同一单调 deadline 的时间')

  const clock2 = createFakeClock()
  let hits2 = 0
  const adapter2 = {
    async forwardOnce(attempt) {
      hits2 += 1
      attempt.onWriteBegin()
      attempt.onResponseHeaders({ status: 429, headers: { 'retry-after': '5' } })
      return { ok: false, status: 429, headers: { 'retry-after': '5' }, retryAfter: 5000, bodyText: 'Rate limit exceeded' }
    },
  }
  const noFit = await clock2.drive(execute(
    { overallMs: 800, target: 'p1', maxAttempts: 3, now: clock2.now, timers: clock2.timers },
    adapter2,
    createAttemptPolicy({ maxAttempts: 3, jitter: 0 }),
  ))
  assert.equal(noFit.outcome, 'REJECTED_BEFORE_EXECUTION', '预算装不下 Retry-After → 立即终态')
  assert.equal(hits2, 1, '不得为装不下的 Retry-After 再发一次')
  assert.equal(noFit.waitedMs, 0, '绝不空等越过 deadline')
  assert.equal(noFit.retryAfterMs, 5000, '保留上游 Retry-After 原值')
  assert.equal(clock2.now() - clock2.start, 0, '没有发生额外等待')
})
