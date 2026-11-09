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
  MAX_RETRY_AFTER_MS,
} from '../../../src/retry-policy.js'
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
// 普通请求仍按 retry.maxAttempts 重试（治理不能误杀既有重试能力）。
// ============================================================================
test('普通请求仍可重试（治理不误杀既有重试能力）', { timeout: 30000 }, async (t) => {
  let hits = 0
  const upstream = await startScriptedUpstream(async (req, res) => {
    hits += 1
    if (hits === 1) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end('{"error":{"message":"temporary backend error"}}')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(CHAT_OK)
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
  assert.equal(res.status, 200, '普通请求 500 一次后应重试成功')
  assert.equal(hits, 2, '普通请求按 retry.maxAttempts 重试（实际 ' + hits + ' 次）')
})

// ============================================================================
// 非幂等（tool）请求：(a) 同上游不重试；(b) 允许沿链换一次上游/模型（可用性优先）；
// (c) 整条链只走一轮，绝不回队首重放（loopMs 远大于一轮耗时时也不出现第二轮）。
// ============================================================================
test('tool 请求：同上游不重试、可换一次上游（一轮链）、不回队首重放', { timeout: 45000 }, async (t) => {
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

  // (a)+(b) 主上游 500：不重试同一上游，但换到备用上游后成功（一轮链）
  const ok = await postChat(gw.base, toolBody)
  const okJson = await ok.json()
  assert.equal(ok.status, 200, 'tool 请求应能沿链换一次上游后成功（可用性优先）')
  assert.equal(okJson.choices[0].message.content, 'from-fallback', '应由备用上游服务')
  assert.equal(primary.hits.length, 1, 'tool 请求不得重试同一上游（retry.maxAttempts=2 也不重试，实际 ' + primary.hits.length + ' 次）')
  assert.equal(backup.hits.length, 1, '一轮链只换一次上游（实际 ' + backup.hits.length + ' 次）')

  // (c) 双失败：一轮链即收尾，不回队首重放
  mode = 'dead'
  const bad = await postChat(gw.base, toolBody)
  assert.ok(bad.status >= 500, '双失败应回上游失败状态（实际 ' + bad.status + '）')
  const total = primary.hits.length + backup.hits.length
  assert.equal(primary.hits.length, 2, '第二次请求主上游只被调用一次（实际 ' + primary.hits.length + ' 次）')
  assert.equal(backup.hits.length, 2, '第二次请求备用上游只被调用一次（实际 ' + backup.hits.length + ' 次）')
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
