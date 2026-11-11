// M1-3a（T-LIFE-04 / T-ROUTE-02）：生产路径的一次发送、授权、账本与裁决一致性。
// 全部离线：隔离网关 + 回环 mock + 真实临时账本目录；不访问外网、不使用真实凭据。
import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startGateway, startScriptedUpstream } from './harness.mjs'
import { execute, makeAdapter } from '../../../src/request.js'
import { openLedger } from '../../../src/routing/ledger.js'

const json = () => ({ 'content-type': 'application/json' })
const chatBody = (model, extra = {}) => Object.assign({ model, messages: [{ role: 'user', content: 'hi' }] }, extra)
const CHAT_OK = (content) => JSON.stringify({
  id: 'mock', object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: content || 'pong' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
})
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, ms, message) {
  const t0 = Date.now()
  for (;;) {
    if (await fn()) return
    if (Date.now() - t0 > ms) throw new Error(message + '（等待 ' + ms + 'ms 超时）')
    await wait(20)
  }
}
async function gwLog(gw) {
  const files = (await readdir(gw.dir)).filter((f) => f.endsWith('.log'))
  const parts = await Promise.all(files.map((f) => readFile(join(gw.dir, f), 'utf8')))
  return parts.join('\n')
}
async function postChat(gw, body, headers, timeoutMs = 15000) {
  return fetch(gw.base + '/v1/chat/completions', {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, headers || {}),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
}

// ============================================================================
// 1. 强制 adapter 工厂：写后抛错但未调 onWriteBegin，execute 仍必须判 SENT_UNKNOWN
// ============================================================================
test('T-LIFE-04a execute 在真实 dispatch 前自行置位 onWriteBegin：写后异常不得退化成 UNSENT 重放', async () => {
  let calls = 0
  const raw = { async forwardOnce() { calls += 1; throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) } }
  const r1 = await execute({ overallMs: 1000, target: 'p1', maxAttempts: 3 }, raw)
  assert.equal(r1.outcome, 'SENT_UNKNOWN', 'adapter 未回调也必须按写后未知处理')
  assert.equal(r1.attemptsMade, 1, '不得重放')
  assert.equal(calls, 1)

  let calls2 = 0
  const adapter = makeAdapter(async () => { calls2 += 1; throw Object.assign(new Error('boom'), { code: 'ECONNRESET' }) })
  const r2 = await execute({ overallMs: 1000, target: 'p1', maxAttempts: 3 }, adapter)
  assert.equal(r2.outcome, 'SENT_UNKNOWN')
  assert.equal(r2.attemptsMade, 1)
  assert.equal(calls2, 1)
})

// ============================================================================
// 2. 生产路径：写后断 socket / 5xx 收到头 → 命中 1，不重放
// ============================================================================
test('T-LIFE-04b 生产路径写后断 socket：上游命中 1 次、不重放', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req) => {
    for await (const _ of req) { /* 读完请求体 */ }
    req.socket.destroy()
  })
  t.after(() => upstream.stop())
  const gw = await startGateway({
    name: 'm13a-close',
    config: {
      defaults: { retry: { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 2, jitter: 0 }, timeout: { firstByteMs: 2000, idleMs: 2000, loopMs: 3000 } },
      providers: { p1: { baseUrl: upstream.base } },
      models: { 'wire-close': { provider: 'p1', fallbacks: [] } },
    },
  })
  t.after(() => gw.stop())
  const res = await postChat(gw, chatBody('wire-close'))
  const body = await res.json()
  assert.equal(upstream.hits.length, 1, '生产路径只发一次（实际 ' + upstream.hits.length + '）')
  assert.ok(res.status >= 500, '写后未知应为失败终态：' + JSON.stringify(body))
  assert.equal(body.error.type, 'no_replay')
})

test('T-LIFE-04c 生产路径 5xx 收到响应头：命中 1 次、不换候选', { timeout: 30000 }, async (t) => {
  const primary = await startScriptedUpstream(async (req, res) => { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":{"message":"overloaded"}}') })
  const backup = await startScriptedUpstream(async (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(CHAT_OK('backup')) })
  t.after(async () => { await primary.stop(); await backup.stop() })
  const gw = await startGateway({
    name: 'm13a-5xx',
    config: {
      defaults: { retry: { maxAttempts: 2 }, timeout: { firstByteMs: 2000, idleMs: 2000, loopMs: 3000 } },
      providers: { p1: { baseUrl: primary.base }, p2: { baseUrl: backup.base } },
      models: { 'mg-wire-5xx': { provider: 'p1', fallbacks: ['p2'] } },
    },
  })
  t.after(() => gw.stop())
  const res = await postChat(gw, chatBody('mg-wire-5xx'))
  assert.equal(primary.hits.length, 1)
  assert.equal(backup.hits.length, 0, '5xx 收到头不得换候选重放')
  assert.equal(res.status, 502)
})

// ============================================================================
// 3. 工具意图后断流 → 命中 1；402/404/429（未执行）才允许下一跳
// ============================================================================
test('T-LIFE-04d 工具意图后断流：命中 1、一次流内终态、不换候选', { timeout: 30000 }, async (t) => {
  const tool = 'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{}' } }] } }] }) + '\n\n'
  const primary = await startScriptedUpstream(async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.write(tool)
    setTimeout(() => { try { res.destroy() } catch {} }, 20)
  })
  const backup = await startScriptedUpstream(async (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(CHAT_OK('backup')) })
  t.after(async () => { await primary.stop(); await backup.stop() })
  const gw = await startGateway({
    name: 'm13a-tool',
    config: {
      defaults: { retry: { maxAttempts: 1 }, timeout: { firstByteMs: 2000, idleMs: 2000, loopMs: 3000 }, codexFallbackLimits: { maxSameProviderAttempts: 0, maxFailovers: 2, maxTotalAttempts: 3 } },
      providers: { p1: { baseUrl: primary.base }, p2: { baseUrl: backup.base } },
      models: { 'mg-wire-tool': { provider: 'p1', fallbacks: ['p2'], codex: { capabilities: { shellType: 'disabled' } } } },
    },
  })
  t.after(() => gw.stop())
  const res = await postChat(gw, chatBody('mg-wire-tool', { stream: true, tools: [{ type: 'function', function: { name: 'shell' } }] }))
  assert.equal(res.status, 200, '流已开始：状态码保持 200')
  const text = await res.text()
  assert.match(text, /stream_interrupted/)
  assert.equal(primary.hits.length, 1)
  assert.equal(backup.hits.length, 0, '工具副作用后不得换候选')
})

test('T-LIFE-04e 402/404/429（证明未执行）才允许下一跳', { timeout: 45000 }, async (t) => {
  for (const status of [402, 404]) {
    const primary = await startScriptedUpstream(async (req, res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'pre-execution reject' } })) })
    const backup = await startScriptedUpstream(async (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(CHAT_OK('backup')) })
    t.after(async () => { await primary.stop(); await backup.stop() })
    const gw = await startGateway({
      name: 'm13a-' + status,
      config: {
        defaults: { retry: { maxAttempts: 1 }, timeout: { firstByteMs: 2000, idleMs: 2000, loopMs: 3000 }, codexFallbackLimits: { maxSameProviderAttempts: 0, maxFailovers: 2, maxTotalAttempts: 3 } },
        providers: { p1: { baseUrl: primary.base }, p2: { baseUrl: backup.base } },
        models: { ['mg-wire-' + status]: { provider: 'p1', fallbacks: ['p2'] } },
      },
    })
    t.after(() => gw.stop())
    const res = await postChat(gw, chatBody('mg-wire-' + status))
    assert.equal(res.status, 200, status + ' 是前置拒绝，允许换候选')
    assert.equal(primary.hits.length, 1)
    assert.equal(backup.hits.length, 1)
    await gw.stop()
  }

  // 429：同上游 Retry-After 预算内允许重试，仍保留 429 语义（此处在第二次成功）。
  const primary = await startScriptedUpstream(async (req, res, rec) => {
    if (rec.index === 0) { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' }); res.end('{"error":{"message":"Rate limit exceeded"}}'); return }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(CHAT_OK('after-429'))
  })
  t.after(() => primary.stop())
  const gw = await startGateway({
    name: 'm13a-429',
    config: {
      defaults: { retry: { maxAttempts: 1 }, timeout: { firstByteMs: 2000, idleMs: 2000, loopMs: 3000 }, codexFallbackLimits: { maxSameProviderAttempts: 1, maxFailovers: 2, maxTotalAttempts: 3 } },
      providers: { p1: { baseUrl: primary.base } },
      models: { 'mg-wire-429': { provider: 'p1', fallbacks: [] } },
    },
  })
  t.after(() => gw.stop())
  const res = await postChat(gw, chatBody('mg-wire-429'))
  assert.equal(res.status, 200)
  assert.equal(primary.hits.length, 2, '429 已证明未执行：允许按 Retry-After 重试一次')
})

// ============================================================================
// 4. 账本：发送前持久预留、结算、重启后不重复扣费/不重放
// ============================================================================
test('T-LIFE-04f 每次发送前已有持久预留，成功后结算', { timeout: 45000 }, async (t) => {
  const ledgerDir = await mkdtemp(join(tmpdir(), 'm13a-ledger-'))
  t.after(() => rm(ledgerDir, { recursive: true, force: true }))
  let reservedBeforeRespond = false
  const upstream = await startScriptedUpstream(async (req, res) => {
    try {
      const raw = await readFile(join(ledgerDir, 'ledger.json'), 'utf8')
      const state = JSON.parse(raw)
      reservedBeforeRespond = Object.values(state.attempts || {}).some((a) => a.status === 'reserved')
    } catch { reservedBeforeRespond = false }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(CHAT_OK())
  })
  t.after(() => upstream.stop())
  const gw = await startGateway({
    name: 'm13a-ledger',
    config: {
      defaults: { retry: { maxAttempts: 1 }, timeout: { firstByteMs: 2000, idleMs: 2000, loopMs: 3000 } },
      providers: { p1: { baseUrl: upstream.base } },
      models: { 'wire-ledger': { provider: 'p1', costEstimateUsd: 0.001 } },
      routing: { ledger: { dir: ledgerDir, currency: 'USD' } },
    },
  })
  t.after(() => gw.stop())
  const res = await postChat(gw, chatBody('wire-ledger'), { 'x-request-id': 'req-ledger-1' })
  assert.equal(res.status, 200)
  assert.equal(reservedBeforeRespond, true, '上游收到请求前，账本里必须已有 reserved attempt')
  const state = JSON.parse(await readFile(join(ledgerDir, 'ledger.json'), 'utf8'))
  const attempts = Object.values(state.attempts || {})
  assert.equal(attempts.length, 1)
  assert.equal(attempts[0].status, 'settled', '成功后必须结算（不留在 reserved/unknown）')
})

test('T-LIFE-04g 进程被 kill 后重启：同请求不重复扣费、不重放', { timeout: 60000 }, async (t) => {
  const ledgerDir = await mkdtemp(join(tmpdir(), 'm13a-kill-'))
  t.after(() => rm(ledgerDir, { recursive: true, force: true }))
  let release = null
  const upstream = await startScriptedUpstream(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    await new Promise((resolve) => { release = resolve })
    if (!res.destroyed) { try { res.writeHead(200, { 'content-type': 'application/json' }); res.end(CHAT_OK()) } catch {} }
  })
  t.after(async () => { if (release) release(); await upstream.stop() })
  const config = {
    defaults: { retry: { maxAttempts: 1 }, timeout: { firstByteMs: 10000, idleMs: 10000, loopMs: 10000 } },
    providers: { p1: { baseUrl: upstream.base } },
    models: { 'wire-kill': { provider: 'p1', costEstimateUsd: 0.002 } },
    routing: { ledger: { dir: ledgerDir, currency: 'USD' } },
  }
  const dir = await mkdtemp(join(tmpdir(), 'm13a-kill-cfg-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  let gw = await startGateway({ name: 'm13a-kill', dir, config })
  const pending = postChat(gw, chatBody('wire-kill'), { 'x-request-id': 'req-kill-1' }, 30000).catch(() => null)
  await waitFor(() => upstream.hits.length === 1, 5000, '第一次请求到达上游')
  gw.child.kill('SIGKILL')
  await once(gw.child, 'exit')
  await pending
  if (release) { release(); release = null }

  const ledger1 = openLedger({ dir: ledgerDir })
  const rec = ledger1.recover()
  assert.equal(rec.inflight.length, 1, '被杀时请求必须留下 reserved 在途记录')
  assert.equal(rec.unknown.length, 0)
  assert.equal(Object.keys(JSON.parse(await readFile(join(ledgerDir, 'ledger.json'), 'utf8')).attempts).length, 1, '不得重复记账')

  gw = await startGateway({ name: 'm13a-kill', dir, config })
  t.after(() => gw.stop())
  const second = await postChat(gw, chatBody('wire-kill'), { 'x-request-id': 'req-kill-1' }, 15000)
  assert.equal(second.status, 409, '同请求重复启动必须被账本幂等挡住')
  assert.equal(upstream.hits.length, 1, '重启后不得重放上游请求')
  const rec2 = openLedger({ dir: ledgerDir }).recover()
  assert.equal(rec2.inflight.length + rec2.unknown.length, 1, '账本仍只有一笔，不重复扣费')
})

// ============================================================================
// 5. 授权漂移 / 能力未证实 / 无账本却有上限 → 零发送
// ============================================================================
test('T-ROUTE-02a 授权漂移（baseUrl userinfo）→ typed deny、零上游', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(CHAT_OK()) })
  t.after(() => upstream.stop())
  const drifted = upstream.base.replace('http://', 'http://user:pass@') // 规范 URL 解析后 host 不变但带 userinfo → 必须拒绝
  const gw = await startGateway({
    name: 'm13a-drift',
    config: {
      defaults: { retry: { maxAttempts: 1 }, timeout: { firstByteMs: 2000, idleMs: 2000, loopMs: 3000 } },
      providers: { p1: { baseUrl: drifted } },
      models: { 'wire-drift': { provider: 'p1' } },
    },
  })
  t.after(() => gw.stop())
  const res = await postChat(gw, chatBody('wire-drift'))
  assert.equal(res.status, 403)
  assert.equal((await res.json()).error.code, 'target_userinfo_forbidden')
  assert.equal(upstream.hits.length, 0, '授权拒绝必须零发送')
})

test('T-ROUTE-02b 能力未证实的候选不出现在执行序列；无账本却配置上限 → 拒绝发送', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(CHAT_OK()) })
  t.after(() => upstream.stop())
  const gw = await startGateway({
    name: 'm13a-unproven',
    config: {
      defaults: { retry: { maxAttempts: 1 }, timeout: { firstByteMs: 2000, idleMs: 2000, loopMs: 3000 } },
      providers: { p1: { baseUrl: upstream.base } },
      // 聚合模型声明了 fallback，但没有 codex.capabilities 证据：带工具的请求不得发送。
      models: { 'mg-wire-unproven': { provider: 'p1', fallbacks: [] } },
    },
  })
  t.after(() => gw.stop())
  const res = await postChat(gw, chatBody('mg-wire-unproven', { tools: [{ type: 'function', function: { name: 'shell' } }] }))
  assert.ok(res.status >= 500)
  assert.equal(upstream.hits.length, 0, '能力未证实不得进入执行序列')

  const gw2 = await startGateway({
    name: 'm13a-ledger-required',
    config: {
      defaults: { retry: { maxAttempts: 1 }, timeout: { firstByteMs: 2000, idleMs: 2000, loopMs: 3000 } },
      providers: { p1: { baseUrl: upstream.base } },
      models: { 'wire-limit': { provider: 'p1', costEstimateUsd: 0.01 } },
      routing: { budget: { requestUsd: 0.05 } },
    },
  })
  t.after(() => gw2.stop())
  const r2 = await postChat(gw2, chatBody('wire-limit'))
  assert.equal(r2.status, 503)
  assert.equal((await r2.json()).error.code, 'ledger_required_for_cost_limits')
  assert.equal(upstream.hits.length, 0, '没有账本不可能强制费用上限：必须零发送')
})

// ============================================================================
// 6. 裁决目标 = 实际执行目标；日志/错误信封无密钥与上游正文片段
// ============================================================================
test('T-ROUTE-02c 裁决 target 与上游实际收到的 model/provider 逐字段一致', { timeout: 30000 }, async (t) => {
  const bodies = []
  const primary = await startScriptedUpstream(async (req, res) => { res.writeHead(402, { 'content-type': 'application/json' }); res.end('{"error":{"message":"quota"}}') })
  const backup = await startScriptedUpstream(async (req, res, rec) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    rec.body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    bodies.push(rec.body)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(CHAT_OK('backup'))
  })
  t.after(async () => { await primary.stop(); await backup.stop() })
  const gw = await startGateway({
    name: 'm13a-target',
    config: {
      defaults: { retry: { maxAttempts: 1 }, timeout: { firstByteMs: 2000, idleMs: 2000, loopMs: 3000 }, codexFallbackLimits: { maxSameProviderAttempts: 0, maxFailovers: 2, maxTotalAttempts: 3 } },
      providers: { p1: { baseUrl: primary.base }, p2: { baseUrl: backup.base } },
      models: { 'mg-wire-target': { provider: 'p1', fallbacks: ['p2'] } },
    },
  })
  t.after(() => gw.stop())
  const res = await postChat(gw, chatBody('mg-wire-target'))
  assert.equal(res.status, 200)
  const log = await gwLog(gw)
  const line = log.split('\n').find((l) => l.includes('codex fallback decision') && l.includes('action=failover'))
  assert.ok(line, '应有 failover 决策审计行：' + log.slice(-400))
  const target = (line.match(/target=([^\s]+)/) || [])[1]
  assert.equal(target, 'mg-wire-target/p2', '裁决 target 必须是备用模型/p2')
  assert.equal(bodies.length, 1, '只应有一次备用上游调用')
  assert.equal(bodies[0].model, 'mg-wire-target', '上游实际收到的 model 必须等于裁决 target.model')
  assert.equal(primary.hits.length, 1)
  assert.equal(backup.hits.length, 1)
})

test('T-ROUTE-02d 日志与错误信封不含密钥哨兵/上游正文片段', { timeout: 30000 }, async (t) => {
  const SENTINEL = 'sk-live-SENTINEL-123456'
  const upstream = await startScriptedUpstream(async (req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'bad ' + SENTINEL + ' body-fragment-should-not-leak' } }))
  })
  t.after(() => upstream.stop())
  const gw = await startGateway({
    name: 'm13a-secret',
    config: {
      defaults: { retry: { maxAttempts: 1 }, timeout: { firstByteMs: 2000, idleMs: 2000, loopMs: 3000 } },
      providers: { p1: { baseUrl: upstream.base } },
      models: { 'wire-secret': { provider: 'p1' } },
    },
  })
  t.after(() => gw.stop())
  const res = await postChat(gw, chatBody('wire-secret'))
  const text = await res.text()
  assert.equal(text.includes(SENTINEL), false, '错误信封不得回显密钥哨兵')
  const log = await gwLog(gw)
  assert.equal(log.includes(SENTINEL), false, '日志不得含密钥哨兵')
  assert.equal(log.includes('body-fragment-should-not-leak'), false, '日志不得含上游正文片段')
})
