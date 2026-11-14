// E5 接入验收：Codex 聚合路径的阶段状态机 + 安全 Fallback（forward.js 集成层）。
// 全部离线：本地 mock 上游 + 动态端口 + OS 临时配置目录；不访问外网、不使用真实 Key。
// 断言重点：
//   · 429 → retry_same（同上游重试，命中次数 = 决策）；
//   · 5xx/402/404 → failover 到已授权第三方候选；
//   · tool_call 后断流 / 内容已交付后断流 → stop，绝不换上游重放；
//   · 官方 402 未确认应急 → stop；确认后才 failover；
//   · 官方候选永不进通用 fallback 池；预算耗尽停机不降级；
//   · 非聚合模型保持旧 forwardChain 行为（零回归由全量 npm test 覆盖）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { startGateway, startScriptedUpstream } from './harness.mjs'

const CHAT_OK = (content) => JSON.stringify({
  id: 'mock', object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: content || 'pong' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
})
const chatBody = (model, extra = {}) => Object.assign({ model, messages: [{ role: 'user', content: 'hi' }] }, extra)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
// 日志按天分文件（<base>-YYYY-MM-DD.log）：读目录内全部 .log 拼接。
async function gwLog(gw) {
  const files = (await readdir(gw.dir)).filter((f) => f.endsWith('.log'))
  const parts = await Promise.all(files.map((f) => readFile(join(gw.dir, f), 'utf8')))
  return parts.join('\n')
}

function baseDefaults(over = {}) {
  return Object.assign({
    retry: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 2, jitter: 0 },
    timeout: { firstByteMs: 4000, idleMs: 4000, loopMs: 4000 },
    codexFallbackLimits: { maxSameProviderAttempts: 0, maxFailovers: 2, maxTotalAttempts: 3, maxWaitMs: 30000 },
  }, over)
}

async function startGw(t, name, cfg, deps) {
  const gw = await startGateway(Object.assign({ name, config: cfg }, deps || {}))
  t.after(async () => { await gw.stop() })
  return gw
}

async function postChat(gw, body, signal, timeoutMs = 15000) {
  return fetch(gw.base + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal || AbortSignal.timeout(timeoutMs),
  })
}

const sse = (obj) => 'data: ' + JSON.stringify(obj) + '\n\n'
const textDelta = (txt) => sse({ choices: [{ delta: { content: txt } }] })
const toolCallDelta = () => sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{}' } }] } }] })

// ============================================================================
// 1. 429 → retry_same（同上游等 Retry-After 后重试，不换模型）
// ============================================================================
test('429 + Retry-After → retry_same 同上游重试后成功（命中 2 次 p1 / 0 次 p2）', { timeout: 30000 }, async (t) => {
  const primary = await startScriptedUpstream(async (req, res, rec) => {
    if (rec.index === 0) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' })
      res.end('{"error":{"message":"Rate limit exceeded","type":"rate_limit"}}')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(CHAT_OK())
  })
  const backup = await startScriptedUpstream(async (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(CHAT_OK('backup')) })
  t.after(async () => { await primary.stop(); await backup.stop() })
  const gw = await startGw(t, 'mg-fb-429', {
    defaults: baseDefaults({ codexFallbackLimits: { maxSameProviderAttempts: 1, maxFailovers: 2, maxTotalAttempts: 3, maxWaitMs: 30000 } }),
    providers: { p1: { baseUrl: primary.base }, p2: { baseUrl: backup.base } },
    models: { 'mg-fb-429': { provider: 'p1', fallbacks: ['p2'] } },
  })
  const res = await postChat(gw, chatBody('mg-fb-429'))
  const text = await res.text()
  assert.equal(res.status, 200, '重试后应成功：' + text.slice(0, 300))
  assert.equal(primary.hits.length, 2, '决策 retry_same：同上游恰好重试一次（实际 ' + primary.hits.length + '）')
  assert.equal(backup.hits.length, 0, 'retry_same 不得换上游（实际 ' + backup.hits.length + '）')
})

// ============================================================================
// 2. 5xx → failover 到已授权第三方候选
// ============================================================================
test('5xx（已收到响应头）→ 一次终态，不换候选重放（p2 命中 0）', { timeout: 30000 }, async (t) => {
  const primary = await startScriptedUpstream(async (req, res) => { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":{"message":"overloaded"}}') })
  const backup = await startScriptedUpstream(async (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(CHAT_OK('backup')) })
  t.after(async () => { await primary.stop(); await backup.stop() })
  const gw = await startGw(t, 'mg-fb-5xx', {
    defaults: baseDefaults(),
    providers: { p1: { baseUrl: primary.base }, p2: { baseUrl: backup.base } },
    models: { 'mg-fb-5xx': { provider: 'p1', fallbacks: ['p2'] } },
  })
  const res = await postChat(gw, chatBody('mg-fb-5xx'))
  const body = await res.json()
  assert.equal(res.status, 502, JSON.stringify(body).slice(0, 300))
  assert.equal(primary.hits.length, 1)
  assert.equal(backup.hits.length, 0, '5xx 已收到响应头：不得换候选重放')
  assert.equal(body.error.code, 'MG_FB_STOP_RECONCILE', '账本/副作用未知时先对账')
})

// ============================================================================
// 3. 402 / 404 → failover（不同上游重试无意义，直接换）
// ============================================================================
test('402 → failover（不重试同上游）；404 → failover 到已授权候选', { timeout: 30000 }, async (t) => {
  for (const [status, model] of [[402, 'mg-fb-402'], [404, 'mg-fb-404']]) {
    const primary = await startScriptedUpstream(async (req, res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'upstream rejected' } })) })
    const backup = await startScriptedUpstream(async (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(CHAT_OK('backup')) })
    t.after(async () => { await primary.stop(); await backup.stop() })
    const gw = await startGw(t, 'mg-fb-' + status, {
      defaults: baseDefaults(),
      providers: { p1: { baseUrl: primary.base }, p2: { baseUrl: backup.base } },
      models: { [model]: { provider: 'p1', fallbacks: ['p2'] } },
    })
    const res = await postChat(gw, chatBody(model))
    const text = await res.text()
    assert.equal(res.status, 200, status + ' 应换到备用成功：' + text.slice(0, 300))
    assert.equal(primary.hits.length, 1, status + ' 不得重试同上游（实际 ' + primary.hits.length + '）')
    assert.equal(backup.hits.length, 1, status + ' 应换到备用（实际 ' + backup.hits.length + '）')
    await gw.stop()
  }
})

// ============================================================================
// 4. tool_call 后断流 → stop（工具副作用优先于可用性，禁止换模型重放）
// ============================================================================
test('tool_call 后断流 → stop_with_error，不换上游（p2 命中 0）', { timeout: 30000 }, async (t) => {
  const primary = await startScriptedUpstream(async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.write(toolCallDelta())
    await wait(20)
    res.destroy()
  })
  const backup = await startScriptedUpstream(async (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(CHAT_OK('backup')) })
  t.after(async () => { await primary.stop(); await backup.stop() })
  const gw = await startGw(t, 'mg-fb-tool', {
    defaults: baseDefaults(),
    providers: { p1: { baseUrl: primary.base }, p2: { baseUrl: backup.base } },
    models: { 'mg-fb-tool': { provider: 'p1', fallbacks: ['p2'], codex: { capabilities: { shellType: 'disabled' } } } },
  })
  const res = await postChat(gw, chatBody('mg-fb-tool', { stream: true, tools: [{ type: 'function', function: { name: 'shell' } }] }))
  const text = await res.text()
  assert.equal(res.status, 200, '流已开始：状态码 200，错误以流内事件收尾')
  assert.match(text, /stream_interrupted/, '应收到流内错误事件：' + text.slice(0, 300))
  assert.equal(backup.hits.length, 0, '出现 tool_call 后不得换上游重放（实际 ' + backup.hits.length + '）')
  // 审计日志：只记决策字段，不含请求正文/凭据
  const log = await gwLog(gw)
  assert.match(log, /codex fallback decision/, '应记录决策审计行')
  assert.match(log, /tool_side_effect|不重放/, '日志应含工具副作用/不重放证据')
  assert.ok(!/sk-[A-Za-z0-9]/.test(log), '日志不得含凭据')
})

// ============================================================================
// 5. 已交付内容后断流 → stop（不得拼接另一模型输出）
// ============================================================================
test('内容已交付后断流 → stop_with_error，不换上游（p2 命中 0）', { timeout: 30000 }, async (t) => {
  const primary = await startScriptedUpstream(async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.write(textDelta('已经交付的内容'))
    await wait(20)
    res.destroy()
  })
  const backup = await startScriptedUpstream(async (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(CHAT_OK('backup')) })
  t.after(async () => { await primary.stop(); await backup.stop() })
  const gw = await startGw(t, 'mg-fb-stream', {
    defaults: baseDefaults(),
    providers: { p1: { baseUrl: primary.base }, p2: { baseUrl: backup.base } },
    models: { 'mg-fb-stream': { provider: 'p1', fallbacks: ['p2'] } },
  })
  const res = await postChat(gw, chatBody('mg-fb-stream', { stream: true }))
  const text = await res.text()
  assert.match(text, /已经交付的内容/)
  assert.match(text, /stream_interrupted/)
  assert.equal(backup.hits.length, 0, '已交付内容后不得换上游（实际 ' + backup.hits.length + '）')
})

// ============================================================================
// 6. 官方 402 未确认应急 → stop；确认后 → failover
// ============================================================================
test('官方 402 未确认应急 → stop；确认 codexEmergency 后才 failover 到第三方（config-declared official）', { timeout: 30000 }, async (t) => {
  const official = await startScriptedUpstream(async (req, res) => { res.writeHead(402, { 'content-type': 'application/json' }); res.end('{"error":{"message":"quota exhausted"}}') })
  const third = await startScriptedUpstream(async (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(CHAT_OK('third')) })
  t.after(async () => { await official.stop(); await third.stop() })

  const officialBase = official.base.replace('127.0.0.1', 'localhost')
  const env = { MG_TEST_OFFICIAL_KEY: 'test-official-key' }
  const cfg = (extra) => ({
    defaults: baseDefaults(Object.assign({
      codexOfficialHosts: ['localhost'],
      directory: [{ model: 'mg-third-model', providers: ['p2'] }],
    }, extra)),
    providers: {
      off: { baseUrl: officialBase, apiKeyEnv: 'MG_TEST_OFFICIAL_KEY' },
      p2: { baseUrl: third.base },
    },
    models: { 'mg-official-model': { provider: 'off' }, 'mg-third-model': { provider: 'p2' } },
  })

  const stopped = await startGw(t, 'mg-fb-off', cfg({}), { env })
  const r1 = await postChat(stopped, chatBody('mg-official-model'))
  const b1 = await r1.json()
  assert.equal(r1.status, 402, JSON.stringify(b1))
  assert.equal(b1.error.code, 'MG_FB_OFFICIAL_QUOTA')
  assert.equal(official.hits.length, 1)
  assert.equal(third.hits.length, 0, '未确认应急时不得自动进第三方池')
  await stopped.stop()

  official.hits.length = 0
  const acked = await startGw(t, 'mg-fb-off-ack', cfg({ codexEmergency: { acknowledged: true } }), { env })
  const r2 = await postChat(acked, chatBody('mg-official-model'))
  const text2 = await r2.text()
  assert.equal(r2.status, 200, text2.slice(0, 300))
  assert.equal(official.hits.length, 1)
  assert.equal(third.hits.length, 1, '确认应急后应切到第三方')
})

// ============================================================================
// 7. 官方候选永不进通用 fallback 池（即使被列进 defaults.directory）
// ============================================================================
test('官方候选被列进目录兜底也不会被 failover 选中（p3 命中 0）', { timeout: 30000 }, async (t) => {
  const p1 = await startScriptedUpstream(async (req, res) => { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{}') })
  const p2 = await startScriptedUpstream(async (req, res) => { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{}') })
  const p3 = await startScriptedUpstream(async (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(CHAT_OK('official')) })
  t.after(async () => { await p1.stop(); await p2.stop(); await p3.stop() })
  const gw = await startGw(t, 'mg-fb-pool', {
    defaults: baseDefaults({ codexOfficialHosts: ['localhost'], directory: [{ model: 'mg-dir-official', providers: ['p3'] }] }),
    providers: { p1: { baseUrl: p1.base }, p2: { baseUrl: p2.base }, p3: { baseUrl: p3.base.replace('127.0.0.1', 'localhost'), apiKeyEnv: 'MG_TEST_OFFICIAL_KEY' } },
    models: { 'mg-fb-pool': { provider: 'p1', fallbacks: ['p2'] }, 'mg-dir-official': { provider: 'p3' } },
  }, { env: { MG_TEST_OFFICIAL_KEY: 'test-official-key' } })
  const res = await postChat(gw, chatBody('mg-fb-pool'))
  const body = await res.json()
  assert.equal(res.status, 502, '写后失败一次终态：' + JSON.stringify(body).slice(0, 300))
  assert.equal(p1.hits.length, 1)
  assert.equal(p2.hits.length, 0, 'M1-3a：5xx 收到头不得换候选重放')
  assert.equal(p3.hits.length, 0, '官方订阅不得进入通用 fallback 池（实际 ' + p3.hits.length + '）')
})

// ============================================================================
// 8. 预算耗尽 → 停机不降级（p2 命中 0）
// ============================================================================
test('预算耗尽 → stop MG_FB_BUDGET，不换便宜候选（p2 命中 0）', { timeout: 30000 }, async (t) => {
  const primary = await startScriptedUpstream(async (req, res) => { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{}') })
  const backup = await startScriptedUpstream(async (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(CHAT_OK('backup')) })
  t.after(async () => { await primary.stop(); await backup.stop() })
  const gw = await startGw(t, 'mg-fb-budget', {
    defaults: baseDefaults({ codexBudget: { requestUsd: 0.01 } }),
    providers: { p1: { baseUrl: primary.base }, p2: { baseUrl: backup.base } },
    models: { 'mg-fb-budget': { provider: 'p1', fallbacks: ['p2'], costEstimateUsd: 0.02 } },
  })
  const res = await postChat(gw, chatBody('mg-fb-budget'))
  const body = await res.json()
  assert.equal(res.status, 402, JSON.stringify(body).slice(0, 300))
  assert.equal(body.error.code, 'MG_FB_BUDGET')
  assert.equal(primary.hits.length, 0, 'M1-3a：超预算在发送前停机（不再先发一次再判 spent）')
  assert.equal(backup.hits.length, 0, '超预算停机不降级（实际 ' + backup.hits.length + '）')
})

// ============================================================================
// 9. 400 确定性拒绝 → stop（不空跑候选链）
// ============================================================================
test('400 确定性拒绝 → stop MG_FB_BAD_REQUEST，不换模型（p2 命中 0）', { timeout: 30000 }, async (t) => {
  const primary = await startScriptedUpstream(async (req, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":{"message":"invalid parameter"}}') })
  const backup = await startScriptedUpstream(async (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(CHAT_OK('backup')) })
  t.after(async () => { await primary.stop(); await backup.stop() })
  const gw = await startGw(t, 'mg-fb-400', {
    defaults: baseDefaults(),
    providers: { p1: { baseUrl: primary.base }, p2: { baseUrl: backup.base } },
    models: { 'mg-fb-400': { provider: 'p1', fallbacks: ['p2'] } },
  })
  const res = await postChat(gw, chatBody('mg-fb-400'))
  const body = await res.json()
  assert.equal(res.status, 400)
  assert.equal(body.error.code, 'MG_FB_BAD_REQUEST')
  assert.equal(backup.hits.length, 0, '确定性 400 不换模型（实际 ' + backup.hits.length + '）')
})

// ============================================================================
// 10. 非聚合模型保持旧行为（零回归的集成侧证据）
// ============================================================================
test('非聚合模型 5xx 仍走旧 forwardChain 兜底（决策器不介入）', { timeout: 30000 }, async (t) => {
  const primary = await startScriptedUpstream(async (req, res) => { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{}') })
  const backup = await startScriptedUpstream(async (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(CHAT_OK('backup')) })
  t.after(async () => { await primary.stop(); await backup.stop() })
  const gw = await startGw(t, 'mg-legacy', {
    defaults: baseDefaults(),
    providers: { p1: { baseUrl: primary.base }, p2: { baseUrl: backup.base } },
    models: { 'legacy-model': { provider: 'p1', fallbacks: ['p2'] } },
  })
  const res = await postChat(gw, chatBody('legacy-model'))
  assert.equal(res.status, 502, 'M1-3a：非聚合链同样不得在收到响应头后重放')
  assert.equal(primary.hits.length, 1)
  assert.equal(backup.hits.length, 0, '旧显式链也复用同一"不重放"安全检查')
  const log = await gwLog(gw)
  assert.doesNotMatch(log, /codex fallback decision/, '非聚合路径不得触发决策器')
})
