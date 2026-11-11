// MG-007 生命周期：SIGTERM 优雅关闭、定时器清理、最终原子落盘、损坏 stats 恢复。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { startGateway, startMockUpstream, startScriptedUpstream } from './harness.mjs'
import { execute, forwardOnce, readStreamOnce } from '../../../src/request.js'
import { createAttemptPolicy } from '../../../src/retry-policy.js'
import { createAttempt, STAGES, retrySafetyOf } from '../../../src/attempt-state.js'
import { createDeadline, createLeasePool } from '../../../src/deadline.js'

// 退出竞态：退出事件可能早于监听注册，用轮询 + once 双保险
async function waitExit(child, ms = 8000) {
  const deadline = Date.now() + ms
  const exited = once(child, 'exit').then(([code]) => code)
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    const race = await Promise.race([exited, new Promise((r) => setTimeout(() => r('tick'), 50))])
    if (race !== 'tick') return race
  }
  if (child.exitCode === null && child.signalCode === null) { try { child.kill('SIGKILL') } catch {} ; await exited.catch(() => {}) }
  return child.exitCode
}

test('MG-007 SIGTERM：退出码 0、连接排空、统计最终落盘并在重启后恢复', { timeout: 45000 }, async (t) => {
  const upstream = await startMockUpstream()
  const dir = await mkdtemp(join(tmpdir(), 'modelgate-life-'))
  const config = {
    providers: { mock: { baseUrl: upstream.base } },
    models: { demo: { provider: 'mock', api: 'openai', forceNoStream: true } },
  }
  t.after(async () => { await upstream.stop(); await rm(dir, { recursive: true, force: true }) })

  let gw = await startGateway({ name: 'life-sigterm', dir, config })
  const chat = await gw.post('/v1/chat/completions', { model: 'demo', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(chat.status, 200)

  gw.child.kill('SIGTERM')
  const code = await waitExit(gw.child)
  assert.equal(code, 0, 'SIGTERM 后应正常退出（不是被信号杀死）')

  const stats = JSON.parse(await readFile(join(dir, 'stats.json'), 'utf8'))
  assert.equal(typeof stats.byModel, 'object')
  const demo = stats.daily.demo && stats.daily.demo[new Date().toLocaleDateString('en-CA')]
  assert.ok(demo && demo.tokens > 0, '关闭时写入了累计 token（不是空文件）')
  assert.ok(!(await readdir(dir)).some((f) => f.includes('.corrupt-')), '正常路径不产生损坏备份')

  // 同目录重启：统计从磁盘恢复
  gw = await startGateway({ name: 'life-sigterm', dir, config })
  t.after(() => gw.stop())
  const restored = await (await gw.get('/api/status')).json()
  const demoModel = restored.models.find((m) => m.name === 'demo')
  assert.ok(demoModel.today > 0, '重启后今日 token 从 stats.json 恢复')
  gw.child.kill('SIGTERM')
  assert.equal(await waitExit(gw.child), 0)
})

test('MG-007 损坏 stats：先备份再重建，网关照常启动', { timeout: 30000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'modelgate-life-corrupt-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await writeFile(join(dir, 'stats.json'), '{ this is not json')
  const gw = await startGateway({ name: 'life-corrupt', dir })
  assert.equal((await gw.get('/healthz')).status, 200)
  const names = await readdir(dir)
  assert.ok(names.some((f) => f.includes('.corrupt-')), '损坏文件被留证备份')
  gw.child.kill('SIGTERM')
  assert.equal(await waitExit(gw.child), 0)
  const rebuilt = JSON.parse(await readFile(join(dir, 'stats.json'), 'utf8'))
  assert.equal(typeof rebuilt.byModel, 'object', '关闭后写回可解析的 stats')
})

// ============================================================================
// M1-1（T-LIFE-01/02/03）：一次发送、截止时间和取消。
// 断言全部打在尝试状态机、终态分类与上游命中计数上；不依赖日志字符串。
// ============================================================================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, ms, message) {
  const t0 = Date.now()
  for (;;) {
    if (await fn()) return
    if (Date.now() - t0 > ms) throw new Error(message + '（等待 ' + ms + 'ms 超时）')
    await sleep(10)
  }
}
const CHAT_BODY = Buffer.from(JSON.stringify({ model: 'demo', messages: [{ role: 'user', content: 'hi' }] }))
const CHAT_HEADERS = { 'content-type': 'application/json' }

function chatAdapter(upstream, opts = {}) {
  return {
    async forwardOnce(attempt, ctl) {
      const result = await forwardOnce(
        { baseUrl: upstream.base },
        '/v1/chat/completions',
        'POST',
        CHAT_HEADERS,
        CHAT_BODY,
        { timeout: Object.assign({ firstByteMs: 2000, idleMs: 2000 }, opts.timeout) },
        attempt,
        ctl,
      )
      if (opts.readStream && result.stream) await readStreamOnce(result.stream, ctl.deadline)
      return result
    },
  }
}

test('T-LIFE-01 尝试阶段单调前向：写开始即 SENT_UNKNOWN、非法回退被拒绝、证据决定可否再发', () => {
  const a = createAttempt({ number: 1, target: 'p1' })
  assert.equal(a.stage, STAGES.UNSENT, '新尝试从 UNSENT 开始')
  assert.equal(retrySafetyOf(a).allowed, true, '未发送允许下一次发送')
  a.onWriteBegin()
  assert.equal(a.stage, STAGES.SENT_UNKNOWN, '写开始即 SENT_UNKNOWN（不得假设未送达）')
  assert.equal(a.wroteBody, true)
  assert.equal(retrySafetyOf(a).allowed, false, '写后无头不得再发')
  a.onResponseHeaders({ status: 200, headers: {} })
  assert.equal(a.stage, STAGES.ACCEPTED)
  assert.equal(a.onFirstSemanticEvent({ source: 'sse' }), true)
  assert.equal(a.stage, STAGES.DELIVERED)
  assert.equal(a.transition(STAGES.SENT_UNKNOWN), false, '阶段不可回退')
  assert.equal(a.stage, STAGES.DELIVERED, '非法迁移不改变状态')
  assert.equal(a.violations.length, 1, '非法迁移被记录')
  a.onToolIntent({ callId: 'call_1' })
  assert.equal(a.stage, STAGES.TOOL_RISK, '工具意图是高于 DELIVERED 的副作用风险')
  assert.equal(retrySafetyOf(a).allowed, false, '工具风险后不得再发')

  const b = createAttempt({ number: 1 })
  assert.equal(b.onKnownRejection({ kind: 'not-a-proof' }), false, '无证据的拒绝不得标记为前置拒绝')
  assert.equal(b.stage, STAGES.UNSENT)
  b.onWriteBegin()
  assert.equal(b.onKnownRejection({ proven: true, kind: 'rate_limited', status: 429 }), true, '有证据的前置拒绝可标记')
  assert.equal(b.stage, STAGES.REJECTED_BEFORE_EXECUTION)
  assert.equal(retrySafetyOf(b).allowed, true, '可证明未执行时允许下一次尝试')

  const c = createAttempt({ number: 1 })
  c.onWriteBegin()
  c.onResponseHeaders({ status: 200, headers: {} })
  assert.equal(c.onKnownRejection({ kind: 'trust_me' }), false, '未知证据不得把已受理响应降级为可重放')
  assert.equal(retrySafetyOf(c).allowed, false)
})

test('T-LIFE-02 已写出请求体后连接断开 → SENT_UNKNOWN，上游命中 1 次、不重放', { timeout: 20000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req) => {
    for await (const _ of req) { /* 读完请求体后断开，制造“已写出但无响应头” */ }
    req.socket.destroy()
  })
  t.after(() => upstream.stop())
  const adapter = chatAdapter(upstream)
  const result = await execute(
    { overallMs: 5000, target: 'p1', maxAttempts: 3 },
    adapter,
    createAttemptPolicy({ maxAttempts: 3, initialDelayMs: 5, jitter: 0 }),
  )
  assert.equal(result.outcome, 'SENT_UNKNOWN', '写后无头的网络错误必须归为 SENT_UNKNOWN（不是 UNSENT）')
  assert.equal(result.attemptsMade, 1, 'maxAttempts=3 也不得重放')
  assert.equal(upstream.hits.length, 1, '上游只被命中 1 次（核心回归：禁止重放）')
  assert.equal(result.attempts[0].stage, 'SENT_UNKNOWN')
  assert.equal(result.attempts[0].wroteBody, true)
  assert.equal(result.retryable, false)
})

test('T-LIFE-03 收到响应头后断流 → 不重放（命中 1）', { timeout: 20000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'tick' } }] }) + '\n\n')
    setTimeout(() => { try { res.destroy() } catch {} }, 30)
  })
  t.after(() => upstream.stop())
  const result = await execute(
    { overallMs: 5000, target: 'p1', maxAttempts: 3 },
    chatAdapter(upstream, { readStream: true }),
    createAttemptPolicy({ maxAttempts: 3, initialDelayMs: 5, jitter: 0 }),
  )
  assert.equal(result.attemptsMade, 1, '响应头后断流不得重放')
  assert.equal(result.outcome, 'FAILED', '断流是可诊断失败终态，不是可重放的 UNSENT')
  assert.equal(result.stage, 'ACCEPTED', '断流时证据阶段为 ACCEPTED')
  assert.equal(upstream.hits.length, 1, '上游只被命中 1 次')
})

test('T-LIFE-03b 已交付首个语义事件后断流 → 仍不重放（命中 1）', { timeout: 20000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'x' } }] }) + '\n\n')
    setTimeout(() => { try { res.destroy() } catch {} }, 30)
  })
  t.after(() => upstream.stop())
  const adapter = {
    async forwardOnce(attempt, ctl) {
      const r = await forwardOnce(
        { baseUrl: upstream.base }, '/v1/chat/completions', 'POST', CHAT_HEADERS, CHAT_BODY,
        { timeout: { firstByteMs: 2000, idleMs: 2000 } }, attempt, ctl,
      )
      await readStreamOnce(r.stream, ctl.deadline, {
        onChunk(text) { if (text.includes('"delta"')) attempt.onFirstSemanticEvent({ source: 'sse' }) },
      })
      return r
    },
  }
  const result = await execute(
    { overallMs: 5000, target: 'p1', maxAttempts: 3 },
    adapter,
    createAttemptPolicy({ maxAttempts: 3, initialDelayMs: 5, jitter: 0 }),
  )
  assert.equal(result.attemptsMade, 1, '已交付后断流不得重放')
  assert.equal(result.stage, 'DELIVERED', '断流前的语义事件证据必须保留')
  assert.equal(result.delivered, true)
  assert.equal(upstream.hits.length, 1, '上游只被命中 1 次')
})

test('T-LIFE-03c 工具意图已观测后失败 → TOOL_RISK，不重放（命中 1）', { timeout: 20000 }, async (t) => {
  const TOOL_EVENT = 'data: ' + JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'shell', arguments: '{"cmd":"ls"}' } }] } }],
  }) + '\n\n'
  const upstream = await startScriptedUpstream(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.write(TOOL_EVENT)
    setTimeout(() => { try { res.destroy() } catch {} }, 30)
  })
  t.after(() => upstream.stop())
  const adapter = {
    async forwardOnce(attempt, ctl) {
      const r = await forwardOnce(
        { baseUrl: upstream.base }, '/v1/chat/completions', 'POST', CHAT_HEADERS, CHAT_BODY,
        { timeout: { firstByteMs: 2000, idleMs: 2000 } }, attempt, ctl,
      )
      let sawTool = false
      await readStreamOnce(r.stream, ctl.deadline, {
        onChunk(text) {
          if (!sawTool && text.includes('tool_calls')) {
            sawTool = true
            attempt.onToolIntent({ source: 'sse', callId: 'call_1' })
            return false
          }
        },
      })
      if (!sawTool) throw new Error('测试前置：未观测到工具意图')
      throw Object.assign(new Error('tool stream interrupted'), { code: 'ECONNRESET' })
    },
  }
  const result = await execute(
    { overallMs: 5000, target: 'p1', maxAttempts: 3, nonIdempotent: true },
    adapter,
    createAttemptPolicy({ maxAttempts: 3, initialDelayMs: 5, jitter: 0 }),
  )
  assert.equal(result.outcome, 'TOOL_RISK', '工具意图后失败必须终止为 TOOL_RISK')
  assert.equal(result.stage, 'TOOL_RISK')
  assert.equal(result.attemptsMade, 1, '工具风险不得重放')
  assert.equal(upstream.hits.length, 1, '上游只被命中 1 次')
  assert.equal(result.nonIdempotent, true)
})

test('T-LIFE-04 挂起队列中的请求被取消 → CANCELLED_UNSENT，且不影响其他请求', { timeout: 20000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"id":"mock-1"}')
  })
  t.after(() => upstream.stop())
  const pool = createLeasePool({ concurrency: 1 })
  const holder = await pool.acquire(createDeadline({ overallMs: 0 }))
  assert.equal(pool.active(), 1)

  const controller = new AbortController()
  const queued = execute(
    {
      overallMs: 5000,
      signal: controller.signal,
      target: 'p1',
      acquire: (permit, deadline) => pool.acquire(deadline),
    },
    chatAdapter(upstream),
    createAttemptPolicy({ maxAttempts: 1 }),
  )
  await waitFor(() => pool.waiting() === 1, 2000, '请求进入排队')
  assert.equal(upstream.hits.length, 0, '排队中不得触达上游')
  controller.abort()
  const cancelled = await queued
  assert.equal(cancelled.outcome, 'CANCELLED_UNSENT', '排队中取消 → CANCELLED_UNSENT')
  assert.equal(cancelled.attemptsMade, 0, '取消发生在发送前，没有尝试记录')
  assert.equal(cancelled.deadline.cancelled, true)
  assert.equal(pool.waiting(), 0, '取消的 waiter 已移出队列')
  assert.equal(pool.active(), 1, '持有者槽位未被取消影响')
  assert.equal(upstream.hits.length, 0, '取消的请求从未触达上游')

  holder.release()
  assert.equal(pool.active(), 0)
  const next = await execute(
    { overallMs: 5000, target: 'p1', acquire: (permit, deadline) => pool.acquire(deadline) },
    chatAdapter(upstream),
    createAttemptPolicy({ maxAttempts: 1 }),
  )
  assert.equal(next.outcome, 'SUCCEEDED', '取消不影响后续请求')
  assert.equal(upstream.hits.length, 1)
  assert.equal(pool.active(), 0, '租约已归还')
})

test('T-LIFE-05 并发/限流令牌在异常路径归还（finally 语义）', { timeout: 20000 }, async (t) => {
  const pool = createLeasePool({ concurrency: 1 })
  const counting = (hits) => ({
    async forwardOnce(attempt) {
      hits.n += 1
      attempt.onWriteBegin()
      throw Object.assign(new Error('upstream exploded before headers'), { code: 'ECONNRESET' })
    },
  })
  const hits = { n: 0 }
  const result = await execute(
    { overallMs: 3000, target: 'p1', acquire: (permit, deadline) => pool.acquire(deadline) },
    counting(hits),
    createAttemptPolicy({ maxAttempts: 1 }),
  )
  assert.equal(result.outcome, 'SENT_UNKNOWN')
  assert.equal(hits.n, 1)
  assert.equal(pool.active(), 0, '异常路径也必须归还令牌')
  assert.equal(pool.waiting(), 0)

  const ok = {
    async forwardOnce(attempt) {
      attempt.onWriteBegin()
      attempt.onResponseHeaders({ status: 200, headers: {} })
      return { ok: true, status: 200, headers: {} }
    },
  }
  const next = await execute(
    { overallMs: 3000, target: 'p1', acquire: (permit, deadline) => pool.acquire(deadline) },
    ok,
    createAttemptPolicy({ maxAttempts: 1 }),
  )
  assert.equal(next.outcome, 'SUCCEEDED', '令牌归还后后续请求可正常执行')
  assert.equal(pool.active(), 0)
})

test('T-LIFE-06 取消独立于失败：退避等待中取消 → 一次 CANCELLED 终态，不再发送', { timeout: 20000 }, async () => {
  let hits = 0
  const controller = new AbortController()
  const adapter = {
    async forwardOnce() {
      hits += 1
      throw Object.assign(new Error('dns failure before send'), { code: 'ENOTFOUND' })
    },
  }
  const running = execute(
    {
      overallMs: 5000,
      signal: controller.signal,
      target: 'p1',
      maxAttempts: 3,
      retry: { initialDelayMs: 300, maxDelayMs: 300, jitter: 0 },
    },
    adapter,
    createAttemptPolicy({ maxAttempts: 3, initialDelayMs: 300, maxDelayMs: 300, jitter: 0 }),
  )
  setTimeout(() => controller.abort(), 40)
  const result = await running
  assert.equal(result.outcome, 'CANCELLED', '退避等待中取消返回取消终态')
  assert.equal(result.attemptsMade, 1, '取消不得触发下一次尝试')
  assert.equal(hits, 1, '取消后上游/适配器只被调用一次')
  assert.equal(result.deadline.cancelled, true)
  assert.equal(result.error.type, 'client_closed')
  assert.equal(result.countsAsProviderFailure, false, '取消不触发熔断归因')
})
