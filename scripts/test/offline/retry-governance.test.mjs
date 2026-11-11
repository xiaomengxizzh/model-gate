// 429 归因 / Retry-After 请求预算 / 非幂等不重放（G1 治理）离线验收。
// 契约：docs/contracts/request-lifecycle-v1.md §9「429 / Retry-After / 非幂等不重放」。
// 全部离线：OS 临时配置目录 + 动态回环端口 + 本地 mock 上游；不使用真实 Key、不访问外网。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  classify429,
  parseRetryAfterMs,
  isToolBearingBody,
  retryWaitCap,
  retryWaitFits,
  retryAfterHeader,
  attributionCode,
  classifyStatus,
  recordAttemptOutcome,
  planAttemptRetry,
  createAttemptPolicy,
  MAX_RETRY_AFTER_MS,
} from '../../../src/retry-policy.js'
import { createAttempt, STAGES, retrySafetyOf } from '../../../src/attempt-state.js'
import { execute } from '../../../src/request.js'
import { startGateway, startScriptedUpstream } from './harness.mjs'

const CHAT_OK = JSON.stringify({
  id: 'mock-1',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const chatBody = (model, extra = {}) => ({ model, messages: [{ role: 'user', content: 'hi' }], ...extra })

function postChat(base, body, timeoutMs = 15000) {
  return fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
}

async function waitFor(fn, ms, message) {
  const t0 = Date.now()
  for (;;) {
    if (await fn()) return
    if (Date.now() - t0 > ms) throw new Error(message + '（等待 ' + ms + 'ms 超时）')
    await sleep(20)
  }
}

// 正则表达式大小写/顺序：额度 > 容量 > 速率 > unknown（只做保守文本匹配，不臆造）
test('classify429：平台额度/模型容量/速率限流/未知 四类归因（含头大小写）', () => {
  assert.deepEqual(
    classify429('{"error":{"message":"insufficient_quota: You exceeded your current quota"}}', {}),
    { attribution: 'platform_quota', hasRetryAfter: false },
    '额度类文本 → platform_quota',
  )
  assert.equal(classify429('{"error":{"message":"The model is overloaded, server is busy"}}', {}).attribution, 'model_capacity', '容量类文本 → model_capacity')
  assert.equal(classify429('{"error":{"message":"Rate limit exceeded for requests per minute"}}', {}).attribution, 'rate_limit', '速率类文本 → rate_limit')
  assert.equal(classify429('{"error":{"message":"something odd"}}', {}).attribution, 'unknown', '匹配不到 → unknown（不臆造）')
  assert.equal(classify429('', {}).attribution, 'unknown', '空 body 且无 Retry-After → unknown')
  // 无文本但有 Retry-After：按速率限流处理；头名大小写不敏感（测试/代理可能给原生大小写）
  assert.deepEqual(classify429('', { 'Retry-After': '3' }), { attribution: 'rate_limit', hasRetryAfter: true })
  assert.equal(classify429('x', { 'retry-after': '0' }).hasRetryAfter, true, 'Retry-After: 0 也算给了信号')
})

test('parseRetryAfterMs：秒数 / 0 / HTTP-date / 非法值', () => {
  assert.equal(parseRetryAfterMs({ 'retry-after': '2' }), 2000)
  assert.equal(parseRetryAfterMs({ 'retry-after': '0' }), 0)
  assert.equal(parseRetryAfterMs({ 'retry-after': '' }), null)
  assert.equal(parseRetryAfterMs({ 'retry-after': 'not-a-date' }), null)
  assert.equal(parseRetryAfterMs({}), null)
  assert.equal(parseRetryAfterMs(null), null)
  const at = Date.now() + 3000
  const ms = parseRetryAfterMs({ 'retry-after': new Date(at).toUTCString() })
  assert.ok(ms > 1500 && ms <= 3500, 'HTTP-date 解析为剩余毫秒（实际 ' + ms + '）')
})

test('retryWaitCap/retryWaitFits：等待必须落在剩余预算内且不超过单次上限', () => {
  assert.equal(retryWaitCap(Infinity), MAX_RETRY_AFTER_MS, '无整体预算时仍受 30s 单次上限约束')
  assert.ok(retryWaitCap(800) < 800 && retryWaitCap(800) > 600, '有预算时给收尾留余量')
  assert.equal(retryWaitCap(10), 0, '预算过小 → 可等待量为 0')
  assert.equal(retryWaitFits(5000, 800), false, 'Retry-After 超出剩余预算 → 不许等')
  assert.equal(retryWaitFits(5000, Infinity), true, '无整体预算且在 30s 内 → 可以等')
  assert.equal(retryWaitFits(40000, Infinity), false, '超过单次 30s 上限 → 不许等')
  assert.equal(retryWaitFits(null, 10), true, '上游没给 Retry-After 时不受此约束（走指数退避）')
  assert.equal(retryAfterHeader(0), '0')
  assert.equal(retryAfterHeader(1500), '2', '毫秒 → 秒向上取整')
  assert.equal(retryAfterHeader(null), null, '上游没给就不臆造响应头')
  assert.equal(attributionCode('platform_quota'), 'MG_429_PLATFORM_QUOTA')
  assert.equal(attributionCode(null), 'MG_429_UNKNOWN')
})

test('isToolBearingBody：tools / input 工具项 / tool 结果 / tool_calls 均判为非幂等', () => {
  assert.equal(isToolBearingBody({ messages: [{ role: 'user', content: 'hi' }] }), false, '普通对话不算工具请求')
  assert.equal(isToolBearingBody({ tools: [] }), false, '空 tools 数组不算')
  assert.equal(isToolBearingBody({ tools: [{ type: 'function', function: { name: 'shell' } }] }), true, '带工具定义')
  assert.equal(isToolBearingBody({ input: [{ type: 'function_call', name: 'shell' }] }), true, 'Responses input 工具项')
  assert.equal(isToolBearingBody({ messages: [{ role: 'tool', content: 'ok' }] }), true, '带 tool 结果消息')
  assert.equal(isToolBearingBody({ messages: [{ role: 'assistant', tool_calls: [{ id: 'c1' }] }] }), true, '带历史 tool_calls')
  assert.equal(isToolBearingBody(null), false)
})

// ============================================================================
// 上游 429 必须原样回 HTTP 429（不吞成 502），带 Retry-After 头 + 归因 + attempts。
// ============================================================================
test('上游 429 → HTTP 429 + Retry-After + 归因（不是 502）', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res) => {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' })
    res.end('{"error":{"message":"insufficient_quota: You exceeded your current quota","type":"insufficient_quota"}}')
  })
  const gw = await startGateway({
    name: 'mg-retry-429',
    config: {
      defaults: {
        retry: { maxAttempts: 1, initialDelayMs: 10, maxDelayMs: 20, jitter: 0 },
        timeout: { firstByteMs: 2000, idleMs: 2000, loopMs: 300 },
      },
      providers: { p1: { baseUrl: upstream.base } },
      models: { m1: { provider: 'p1', fallbacks: [] } },
    },
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const res = await postChat(gw.base, chatBody('m1'))
  const j = await res.json()
  assert.equal(res.status, 429, '429 必须原样回给客户端（502 会让客户端误判为网关故障）')
  assert.equal(res.headers.get('retry-after'), '0', '必须保留 Retry-After 响应头（index.js 透传 forward 结果的 headers）')
  assert.equal(j.error && j.error.type, 'rate_limited', '信封 type=rate_limited')
  assert.equal(j.error.code, 'MG_429_PLATFORM_QUOTA', '归因反映平台额度')
  assert.equal(j.error.attribution, 'platform_quota', 'attribution 字段与 code 一致')
  assert.equal(j.error.upstream_status, 429, '保留上游原始状态码')
  assert.equal(j.error.retry_after_ms, 0, 'retry_after_ms 与上游 Retry-After 一致')
  assert.ok(Number.isInteger(j.error.attempts) && j.error.attempts >= 1, 'attempts 有界且 >=1（实际 ' + j.error.attempts + '）')
  assert.ok(upstream.hits.length >= 1 && upstream.hits.length <= 3, '重试受请求预算约束（上游命中 ' + upstream.hits.length + ' 次）')
})

// ============================================================================
// Retry-After 等得下才等：预算充足时按 Retry-After 等待后重发，对客户端透明。
// ============================================================================
test('Retry-After 在预算内 → 按等待时长重发后成功', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res, rec) => {
    if (rec.index === 0) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' })
      res.end('{"error":{"message":"Rate limit exceeded for requests per minute"}}')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(CHAT_OK)
  })
  const gw = await startGateway({
    name: 'mg-retry-honor',
    config: {
      defaults: {
        retry: { maxAttempts: 1, initialDelayMs: 10, maxDelayMs: 20, jitter: 0 },
        timeout: { firstByteMs: 2000, idleMs: 2000, overallMs: 10000, loopMs: 8000 },
      },
      providers: { p1: { baseUrl: upstream.base } },
      models: { m1: { provider: 'p1', fallbacks: [] } },
    },
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const t0 = Date.now()
  const res = await postChat(gw.base, chatBody('m1'))
  const elapsed = Date.now() - t0
  assert.equal(res.status, 200, 'Retry-After 等待后应成功（对客户端透明）')
  assert.equal(upstream.hits.length, 2, '首次 429 后重发一次（实际 ' + upstream.hits.length + ' 次）')
  assert.ok(elapsed >= 850, '必须真的按 Retry-After(1s) 等待过，实际 ' + elapsed + 'ms')
})

// ============================================================================
// Retry-After 等不下（超出剩余预算/单次上限）：不空等，立即回 429 并保留 Retry-After。
// ============================================================================
test('Retry-After 超出剩余预算 → 不空等，立即 429（仅一次上游尝试）', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res) => {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '5' })
    res.end('{"error":{"message":"Rate limit exceeded"}}')
  })
  const gw = await startGateway({
    name: 'mg-retry-cap',
    config: {
      defaults: {
        retry: { maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 20, jitter: 0 },
        timeout: { firstByteMs: 2000, idleMs: 2000, overallMs: 800, loopMs: 5000 },
      },
      providers: { p1: { baseUrl: upstream.base } },
      models: { m1: { provider: 'p1', fallbacks: [] } },
    },
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const t0 = Date.now()
  const res = await postChat(gw.base, chatBody('m1'))
  const elapsed = Date.now() - t0
  const j = await res.json()
  assert.equal(res.status, 429, '预算装不下 Retry-After 时仍应回 429（而不是 504/502）')
  assert.ok(elapsed < 1500, '不得为 5s 的 Retry-After 空等（实际 ' + elapsed + 'ms，预算 800ms）')
  assert.equal(j.error.retry_after_ms, 5000, '保留上游 Retry-After 原值')
  assert.equal(res.headers.get('retry-after'), '5', 'Retry-After 头按秒回传')
  assert.equal(upstream.hits.length, 1, '等不下时不再发起第二次上游尝试（实际 ' + upstream.hits.length + ' 次）')
})

// ============================================================================
// 429 是限流不是故障：不得打开熔断。
// ============================================================================
test('连续 429 不打开熔断（不 markFail）', { timeout: 45000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res) => {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' })
    res.end('{"error":{"message":"Rate limit exceeded for requests per minute"}}')
  })
  const gw = await startGateway({
    name: 'mg-retry-circuit',
    config: {
      defaults: {
        retry: { maxAttempts: 1, initialDelayMs: 10, maxDelayMs: 20, jitter: 0 },
        timeout: { firstByteMs: 2000, idleMs: 2000, loopMs: 300 },
      },
      providers: { p1: { baseUrl: upstream.base } },
      models: { m1: { provider: 'p1', fallbacks: [] } },
    },
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  for (let i = 0; i < 6; i++) {
    const res = await postChat(gw.base, chatBody('m1'))
    assert.equal(res.status, 429, '第 ' + (i + 1) + ' 次 429 仍应回 429')
  }
  const st = await (await gw.get('/api/status')).json()
  const p = st.providers.find((x) => x.id === 'p1')
  assert.ok(p, '状态里应有 p1')
  assert.notEqual(p.st.state, 'open', '429 不得打开熔断（实际 state=' + p.st.state + '）')
  assert.equal(p.st.openUntilMs, 0, '429 不得设置冷却窗口')
  assert.ok(p.st.errors >= 6, '429 仍计入错误统计（账目不被吞），实际 ' + p.st.errors)
})

// ============================================================================
// M1-3a：旧「普通请求 5xx 按 retry.maxAttempts 重试」断言编码的是审计 P1「上游重放」，
// 按 plan §3.1 改为：收到响应头后同一 attempt 只发一次，绝不靠 HTTP status 推导可安全重放。
// ============================================================================
test('普通请求 5xx 收到响应头 → 一次终态，不按 retry.maxAttempts 重放', { timeout: 30000 }, async (t) => {
  let hits = 0
  const upstream = await startScriptedUpstream(async (req, res) => {
    hits += 1
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end('{"error":{"message":"temporary backend error"}}')
  })
  const gw = await startGateway({
    name: 'mg-retry-plain',
    config: {
      defaults: {
        retry: { maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 20, jitter: 0 },
        timeout: { firstByteMs: 2000, idleMs: 2000, loopMs: 600 },
      },
      providers: { p1: { baseUrl: upstream.base } },
      models: { m1: { provider: 'p1', fallbacks: [] } },
    },
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const res = await postChat(gw.base, chatBody('m1'))
  assert.equal(res.status, 502, '5xx 收到响应头是一次终态（不再重试）')
  assert.equal(hits, 1, '同一 attempt 只发一次（实际 ' + hits + ' 次）')
  const body = await res.json()
  assert.equal(body.error.type, 'no_replay')
})

// ============================================================================
// 非幂等（tool）请求：(a) 同上游不重试；(b) 允许沿链换一次上游/模型（可用性优先）；
// (c) 整条链只走一轮，绝不回队首重放（loopMs 远大于一轮耗时时也不出现第二轮）。
// ============================================================================
test('tool 请求：写后失败不重试、不换上游、不回队首重放（M1-3a 收紧）', { timeout: 45000 }, async (t) => {
  const TOOL_REPLY = JSON.stringify({
    id: 'mock-2',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: 'from-fallback' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })
  let mode = 'fallback' // fallback = 主上游恒 500 / 备用成功；dead = 双失败
  const primary = await startScriptedUpstream(async (req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end('{"error":{"message":"backend exploded"}}')
  })
  const backup = await startScriptedUpstream(async (req, res) => {
    if (mode === 'dead') {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end('{"error":{"message":"backend exploded"}}')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(TOOL_REPLY)
  })
  const gw = await startGateway({
    name: 'mg-retry-noreplay',
    config: {
      defaults: {
        // maxAttempts=2 用于证明「同上游不重试」；loopMs=5000 用于证明「不回队首重放」
        retry: { maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 20, jitter: 0 },
        timeout: { firstByteMs: 2000, idleMs: 2000, loopMs: 5000 },
      },
      providers: { p1: { baseUrl: primary.base }, p2: { baseUrl: backup.base } },
      models: { 'm-tool': { provider: 'p1', fallbacks: ['p2'] } },
    },
  })
  t.after(async () => { await gw.stop(); await primary.stop(); await backup.stop() })
  const tools = [{ type: 'function', function: { name: 'shell', parameters: { type: 'object', properties: {} } } }]
  const toolBody = chatBody('m-tool', { tools })

  // (a) 主上游 500（已收到响应头）：一次终态，不重试同上游、也不换备用上游。
  const first = await postChat(gw.base, toolBody)
  assert.equal(first.status, 502, 'tool 请求写后失败一次终态')
  assert.equal(primary.hits.length, 1, '同上游只发一次（实际 ' + primary.hits.length + ' 次）')
  assert.equal(backup.hits.length, 0, '收到响应头后不得换上游重放（实际 ' + backup.hits.length + ' 次）')

  // (c) 再请求一次：仍然一轮即收尾，不回队首重放
  const bad = await postChat(gw.base, toolBody)
  assert.ok(bad.status >= 500, '再次失败仍是一次终态（实际 ' + bad.status + '）')
  const total = primary.hits.length + backup.hits.length
  assert.equal(primary.hits.length, 2, '第二次请求主上游只被调用一次（实际 ' + primary.hits.length + ' 次）')
  assert.equal(backup.hits.length, 0, '第二次请求也不得换上游（实际 ' + backup.hits.length + ' 次）')
  await sleep(400)
  assert.equal(primary.hits.length + backup.hits.length, total, '不得回队首重放整条链（400ms 后无新增上游调用）')
})

// ============================================================================
// 预算耗尽：仍按 MG-002 回 504 request_timeout，且不计上游失败/不熔断（429 治理不得破坏取消语义）。
// ============================================================================
test('预算耗尽 → 504 request_timeout，不计上游失败、不熔断', { timeout: 30000 }, async (t) => {
  const upstream = await startScriptedUpstream(async (req, res) => {
    await new Promise((resolve) => { const timer = setTimeout(resolve, 3000); timer.unref?.() })
    if (!res.destroyed && !res.writableEnded) { try { res.destroy() } catch {} }
  })
  const gw = await startGateway({
    name: 'mg-retry-budget',
    config: {
      defaults: {
        retry: { maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 20, jitter: 0 },
        timeout: { firstByteMs: 5000, idleMs: 5000, overallMs: 400 },
      },
      providers: { p1: { baseUrl: upstream.base } },
      models: { m1: { provider: 'p1', fallbacks: [] } },
    },
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const t0 = Date.now()
  const res = await postChat(gw.base, chatBody('m1'), 5000)
  const elapsed = Date.now() - t0
  assert.equal(res.status, 504, '预算耗尽仍是 504（不得被 429 治理改写）')
  const j = await res.json()
  assert.equal(j.error && j.error.type, 'request_timeout', '504 信封 type=request_timeout')
  assert.ok(elapsed < 2500, '预算 400ms，实际 ' + elapsed + 'ms')
  assert.equal(upstream.hits.length, 1, '预算耗尽后不再重试（实际 ' + upstream.hits.length + ' 次）')

  const st = await (await gw.get('/api/status')).json()
  const p = st.providers.find((x) => x.id === 'p1')
  assert.equal(p.st.errors, 0, '取消/超时不计上游失败（实际 errors=' + p.st.errors + '）')
  assert.notEqual(p.st.state, 'open', '取消/超时不得熔断')
  assert.equal(st.global.errors, 0, '全局错误计数不得被取消污染')
  await waitFor(() => upstream.hits[0].closedAt !== null, 2500, '预算耗尽后必须销毁上游连接')
})

// ============================================================================
// M1-1（T-LIFE-03）：一次发送的状态分类、429 预算与归因、非幂等不重放。
// 断言打在状态机、终态分类与适配器/上游命中计数上，不依赖日志字符串。
// ============================================================================
test('T-LIFE-03a 状态分类：402/404 证明未执行可换候选；5xx/业务 4xx 不得推导可安全重放', () => {
  const p402 = classifyStatus(402)
  assert.equal(p402.retrySafety, 'rejected_before_execution')
  assert.equal(p402.swapAllowed, true, '402 未支付：明确未执行，允许换候选')
  const p404 = classifyStatus(404)
  assert.equal(p404.retrySafety, 'rejected_before_execution')
  assert.equal(p404.swapAllowed, true, '404 模型不存在：明确未执行，允许换候选')
  assert.equal(classifyStatus(429).retrySafety, 'rejected_before_execution')
  assert.equal(classifyStatus(429).retryAfterRelevant, true)
  for (const status of [500, 502, 503, 504]) {
    const c = classifyStatus(status)
    assert.equal(c.retrySafety, 'unsafe', status + ' 已收到响应头，执行状态未知 → 不可安全重放')
    assert.equal(c.swapAllowed, false)
  }
  assert.equal(classifyStatus(400).class, 'business_4xx')
  assert.equal(classifyStatus(401).class, 'auth_rejected')
  assert.equal(classifyStatus(422).class, 'business_4xx')

  // 5xx：ACCEPTED 证据 + FAILED 终态，绝不允许再发
  const a500 = createAttempt({ number: 1 })
  a500.onWriteBegin()
  a500.onResponseHeaders({ status: 500, headers: {} })
  const out500 = recordAttemptOutcome({ attempt: a500, result: { ok: false, status: 500, headers: {}, bodyText: 'backend exploded' } })
  assert.equal(out500.outcome, 'FAILED')
  assert.equal(out500.terminal, true, '5xx 必须立即终态')
  assert.equal(out500.retrySameTarget, false)
  assert.equal(out500.countsAsProviderFailure, true, '5xx 仍计入 provider 失败')
  assert.equal(a500.stage, STAGES.ACCEPTED)
  assert.equal(retrySafetyOf(a500).allowed, false, '已受理响应后不得重放')

  // 业务 4xx：原样归一、终态；不换候选也不重试
  const a400 = createAttempt({ number: 1 })
  a400.onWriteBegin()
  a400.onResponseHeaders({ status: 400, headers: {} })
  const out400 = recordAttemptOutcome({ attempt: a400, result: { ok: false, status: 400, headers: {}, bodyText: '{"error":{"message":"bad request"}}' } })
  assert.equal(out400.outcome, 'REJECTED_BEFORE_EXECUTION')
  assert.equal(out400.terminal, true, '不可归类业务 4xx 原样归一，不自动重试')
  assert.equal(out400.businessError, true)
  assert.equal(out400.status, 400)

  // 402 / 404：可证明未执行 → 允许换候选（不是重放同一目标）
  const a402 = createAttempt({ number: 1 })
  a402.onWriteBegin()
  a402.onResponseHeaders({ status: 402, headers: {} })
  const out402 = recordAttemptOutcome({ attempt: a402, result: { ok: false, status: 402, headers: {}, bodyText: 'payment required' } })
  assert.equal(out402.outcome, 'REJECTED_BEFORE_EXECUTION')
  assert.equal(out402.terminal, false)
  assert.equal(out402.needsSwitch, true)
  assert.equal(out402.swapAllowed, true)
  assert.equal(retrySafetyOf(a402).allowed, true, '证明未执行时允许下一次尝试（换候选）')

  const a404 = createAttempt({ number: 1 })
  a404.onWriteBegin()
  a404.onResponseHeaders({ status: 404, headers: {} })
  const out404 = recordAttemptOutcome({ attempt: a404, result: { ok: false, status: 404, headers: {}, bodyText: 'model not found' } })
  assert.equal(out404.needsSwitch, true)
  assert.equal(out404.businessError, true)
})

test('T-LIFE-03b 429 Retry-After 预算判定：装得下才等、装不下立即终态（纯函数）', () => {
  const base = { outcome: 'REJECTED_BEFORE_EXECUTION', terminal: false, retrySameTarget: true }
  const fits = planAttemptRetry({ outcome: Object.assign({ retryAfterMs: 2000 }, base), attemptsMade: 1, maxAttempts: 2, remainingMs: 10000 })
  assert.equal(fits.stop, false)
  assert.equal(fits.waitMs, 2000, '按上游 Retry-After 等待')
  assert.equal(fits.retryAfter, true)

  const notFits = planAttemptRetry({ outcome: Object.assign({ retryAfterMs: 5000 }, base), attemptsMade: 1, maxAttempts: 2, remainingMs: 800 })
  assert.equal(notFits.stop, true, '预算装不下必须停止（不空等越过 deadline）')
  assert.equal(notFits.reason, 'retry_after_over_budget')
  assert.equal(notFits.retryAfterMs, 5000, '保留 Retry-After 原值供外层回 429')

  const exhausted = planAttemptRetry({ outcome: Object.assign({ retryAfterMs: 0 }, base), attemptsMade: 2, maxAttempts: 2, remainingMs: 10000 })
  assert.equal(exhausted.stop, true)
  assert.equal(exhausted.reason, 'attempts_exhausted')

  const unknown = planAttemptRetry({
    outcome: { outcome: 'SENT_UNKNOWN', terminal: true, retrySameTarget: false },
    attemptsMade: 1, maxAttempts: 5, remainingMs: 10000,
  })
  assert.equal(unknown.stop, true, '执行状态未知一律停止')
})

test('T-LIFE-03c 429 归因与熔断解耦：attribution/code 保留、不计 provider 失败', () => {
  const a = createAttempt({ number: 1 })
  a.onWriteBegin()
  a.onResponseHeaders({ status: 429, headers: { 'retry-after': '3' } })
  const out = recordAttemptOutcome({
    attempt: a,
    result: {
      ok: false, status: 429, headers: { 'retry-after': '3' }, retryAfter: 3000,
      bodyText: '{"error":{"message":"Rate limit exceeded for requests per minute"}}',
    },
  })
  assert.equal(out.outcome, 'REJECTED_BEFORE_EXECUTION')
  assert.equal(out.terminal, false)
  assert.equal(out.retrySameTarget, true, '429 是已证实的前置限流，可在预算内重发')
  assert.equal(out.attribution, 'rate_limit')
  assert.equal(out.attributionCode, 'MG_429_RATE_LIMIT')
  assert.equal(out.retryAfterMs, 3000)
  assert.equal(out.retryAfterHeader, undefined, '信封头由终态统一派生，不在分类层臆造')
  assert.equal(out.countsAsProviderFailure, false, '429 不是 provider 故障（不熔断）')
  assert.equal(out.circuit, 'unaffected')
  assert.equal(a.stage, STAGES.REJECTED_BEFORE_EXECUTION)
  assert.equal(a.attribution, 'rate_limit')
})

test('T-LIFE-03d 工具请求：SENT_UNKNOWN 一律不重放；402 证明未执行仍可换候选', { timeout: 20000 }, async () => {
  // 1) 工具请求 + 写后无头：即使 maxAttempts=3 也只发一次
  let hits = 0
  const sentUnknown = {
    async forwardOnce(attempt) {
      hits += 1
      attempt.onWriteBegin()
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
    },
  }
  const first = await execute(
    { overallMs: 3000, target: 'p1', maxAttempts: 3, body: { tools: [{ type: 'function', function: { name: 'shell' } }] } },
    sentUnknown,
    createAttemptPolicy({ maxAttempts: 3, initialDelayMs: 5, jitter: 0 }),
  )
  assert.equal(first.outcome, 'SENT_UNKNOWN')
  assert.equal(first.nonIdempotent, true)
  assert.equal(first.attemptsMade, 1, '工具请求写后无头不得重放')
  assert.equal(hits, 1)

  // 2) 402（证明未执行）+ 候选链：换到下一候选后成功
  const targets = []
  const switchAdapter = {
    async forwardOnce(attempt, ctl) {
      targets.push(ctl.target)
      attempt.onWriteBegin()
      if (ctl.target === 'p1') {
        attempt.onResponseHeaders({ status: 402, headers: {} })
        return { ok: false, status: 402, headers: {}, bodyText: 'payment required' }
      }
      attempt.onResponseHeaders({ status: 200, headers: {} })
      return { ok: true, status: 200, headers: {} }
    },
  }
  const switched = await execute(
    { overallMs: 3000, target: 'p1', candidates: ['p1', 'p2'], maxAttempts: 2 },
    switchAdapter,
    createAttemptPolicy({ maxAttempts: 2, candidates: ['p1', 'p2'] }),
  )
  assert.equal(switched.outcome, 'SUCCEEDED', '402 明确未执行时允许换候选')
  assert.deepEqual(targets, ['p1', 'p2'])
  assert.equal(switched.attempts[0].stage, STAGES.REJECTED_BEFORE_EXECUTION)
  assert.equal(switched.attempts[1].stage, STAGES.ACCEPTED)

  // 3) 402 无候选：终态保留可换候选归因，但不重发同一目标
  let noCandidateHits = 0
  const dead402 = {
    async forwardOnce(attempt) {
      noCandidateHits += 1
      attempt.onWriteBegin()
      attempt.onResponseHeaders({ status: 402, headers: {} })
      return { ok: false, status: 402, headers: {}, bodyText: 'payment required' }
    },
  }
  const terminal = await execute(
    { overallMs: 3000, target: 'p1', maxAttempts: 3 },
    dead402,
    createAttemptPolicy({ maxAttempts: 3 }),
  )
  assert.equal(terminal.outcome, 'REJECTED_BEFORE_EXECUTION')
  assert.equal(terminal.attemptsMade, 1)
  assert.equal(noCandidateHits, 1, '没有候选时不得重发同一目标')
  assert.equal(terminal.swapAllowed, true, '保留“可换候选”的分类供上层决策')
  assert.equal(terminal.status, 402)
  assert.equal(terminal.countsAsProviderFailure, false)
})

test('T-LIFE-03e 工具请求遇 429 前置限流：可等待重发（已证明未执行）', { timeout: 20000 }, async () => {
  let hits = 0
  const adapter = {
    async forwardOnce(attempt) {
      hits += 1
      attempt.onWriteBegin()
      if (hits === 1) {
        attempt.onResponseHeaders({ status: 429, headers: { 'retry-after': '0' } })
        return { ok: false, status: 429, headers: { 'retry-after': '0' }, retryAfter: 0, bodyText: 'Rate limit exceeded' }
      }
      attempt.onResponseHeaders({ status: 200, headers: {} })
      return { ok: true, status: 200, headers: {} }
    },
  }
  const result = await execute(
    { overallMs: 5000, target: 'p1', maxAttempts: 2, nonIdempotent: true },
    adapter,
    createAttemptPolicy({ maxAttempts: 2, jitter: 0 }),
  )
  assert.equal(result.outcome, 'SUCCEEDED', '429 已证实未执行，工具请求也可在预算内重发')
  assert.equal(hits, 2)
  assert.equal(result.attempts[0].stage, STAGES.REJECTED_BEFORE_EXECUTION)
})

test('T-LIFE-03f 5xx 已收到响应头：即使 maxAttempts>1 也只命中一次（不按状态码推导可重放）', { timeout: 20000 }, async () => {
  let hits = 0
  const adapter = {
    async forwardOnce(attempt) {
      hits += 1
      attempt.onWriteBegin()
      attempt.onResponseHeaders({ status: 503, headers: {} })
      return { ok: false, status: 503, headers: {}, bodyText: 'service unavailable' }
    },
  }
  const result = await execute(
    { overallMs: 5000, target: 'p1', maxAttempts: 3 },
    adapter,
    createAttemptPolicy({ maxAttempts: 3, initialDelayMs: 5, jitter: 0 }),
  )
  assert.equal(result.outcome, 'FAILED')
  assert.equal(result.stage, STAGES.ACCEPTED)
  assert.equal(result.attemptsMade, 1, '5xx 不得自动重放')
  assert.equal(hits, 1)
  assert.equal(result.status, 503)
  assert.equal(result.countsAsProviderFailure, true)
})
