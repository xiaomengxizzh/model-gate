// G1：429 归因 / 重试预算 / 非幂等不重放 / 4xx 不盲重试。
import { startGateway, mockUpstream, check, summary, sleep, CLIENT } from './harness.mjs'

let mode = 'always429'
let primaryHits = 0
let fallbackHits = 0
const primary = await mockUpstream((req, res) => {
  primaryHits++
  if (mode === 'always429') { res.writeHead(429, { 'retry-after': '0', 'content-type': 'application/json' }); res.end('{"error":{"message":"Rate limit exceeded for requests per minute"}}'); return }
  if (mode === 'once429') {
    if (primaryHits === 1) { res.writeHead(429, { 'retry-after': '0', 'content-type': 'application/json' }); res.end('{"error":{"message":"Too many requests"}}'); return }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })); return
  }
  if (mode === '400') { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":{"message":"messages[0].content must be a string","type":"invalid_request_error"}}'); return }
  if (mode === '401') { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":{"message":"invalid api key"}}'); return }
  if (mode === '500') { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":{"message":"internal"}}'); return }
  if (mode === 'quota429') { res.writeHead(429, { 'retry-after': '0', 'content-type': 'application/json' }); res.end('{"error":{"message":"insufficient_quota: You exceeded your current quota"}}'); return }
  if (mode === 'slow429') { res.writeHead(429, { 'retry-after': '30', 'content-type': 'application/json' }); res.end('{"error":{"message":"rate limit"}}'); return }
})
const fallback = await mockUpstream((req, res) => {
  fallbackHits++
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'from-fallback' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
})

const gw = await startGateway({
  defaults: {
    budget: { maxAttempts: 3, maxMs: 5000, maxWaitMs: 800 },
    retry: { maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 20, jitter: 0 },
  },
  providers: { p1: { baseUrl: primary.url, apiKeyEnv: '', api: 'openai' }, p2: { baseUrl: fallback.url, apiKeyEnv: '', api: 'openai' } },
  models: { 'm-1': { provider: 'p1', fallbacks: ['p2'] }, 'm-solo': { provider: 'p1', fallbacks: [] }, 'm-tool': { provider: 'p1', fallbacks: ['p2'] } },
})
const post = (body) => fetch(gw.base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + CLIENT }, body: JSON.stringify(body) })
const msg = { role: 'user', content: 'hi' }

// 1) 持续 429：必须回 429（不是 502），带 Retry-After 与归因，且尝试次数有界
mode = 'always429'; primaryHits = 0; fallbackHits = 0
const t0 = Date.now()
const r1 = await post({ model: 'm-solo', messages: [msg] })
const j1 = await r1.json()
const secs1 = (Date.now() - t0) / 1000
check('持续 429 → 客户端收到 429（不吞成 502）', r1.status === 429, { status: r1.status })
check('429 保留 Retry-After 响应头', r1.headers.get('retry-after') != null, { ra: r1.headers.get('retry-after') })
check('429 归因为 rate_limit', j1.error && j1.error.attribution === 'rate_limit' && /^MG_429_/.test(j1.error.code), { code: j1.error && j1.error.code, attribution: j1.error && j1.error.attribution })
check('429 响应含 trace_id 与 attempts', !!j1.error.trace_id && j1.error.attempts <= 3, { trace: j1.error.trace_id, attempts: j1.error.attempts })
check('重试被预算封顶（上游总命中 <= 3）', primaryHits + fallbackHits <= 3, { primaryHits, fallbackHits })
check('预算内不空转（< 4s）', secs1 < 4, { secs1 })

// 2) 一次 429 后成功：网关内部按预算重试，对客户端透明
mode = 'once429'; primaryHits = 0; fallbackHits = 0
const r2 = await post({ model: 'm-solo', messages: [msg] })
const j2 = await r2.json()
check('单次 429 后恢复 → 200', r2.status === 200 && j2.choices, { status: r2.status })

// 3) 400 参数错误：不盲重试、不 fallback，原样回显
mode = '400'; primaryHits = 0; fallbackHits = 0
const r3 = await post({ model: 'm-1', messages: [msg] })
const j3 = await r3.json()
check('400 只命中上游 1 次（不重试）', primaryHits === 1 && fallbackHits === 0, { primaryHits, fallbackHits })
check('400 原样回显上游错误', r3.status === 400 && /messages\[0\]/.test(JSON.stringify(j3)), { status: r3.status })

// 4) 401：不重试、不换上游
mode = '401'; primaryHits = 0; fallbackHits = 0
const r4 = await post({ model: 'm-1', messages: [msg] })
check('401 只命中 1 次且不 fallback', r4.status === 401 && primaryHits === 1 && fallbackHits === 0, { status: r4.status, primaryHits, fallbackHits })

// 5) 普通 5xx：允许换上游（证明 fallback 未被预算改造误杀）
mode = '500'; primaryHits = 0; fallbackHits = 0
const r5 = await post({ model: 'm-1', messages: [msg] })
const j5 = await r5.json()
check('5xx 仍可切换备用上游', r5.status === 200 && j5.choices[0].message.content === 'from-fallback', { status: r5.status, primaryHits, fallbackHits })

// 6) tool 请求（非幂等）：5xx 时不自动重放，只命中原上游 1 次
mode = '500'; primaryHits = 0; fallbackHits = 0
const r6 = await post({ model: 'm-tool', messages: [{ role: 'user', content: 'run' }], tools: [{ type: 'function', function: { name: 'shell', parameters: { type: 'object', properties: {} } } }] })
check('tool 请求 5xx 不重放（上游仅 1 次，不切备用）', r6.status >= 500 && primaryHits === 1 && fallbackHits === 0, { status: r6.status, primaryHits, fallbackHits })

// 7) tool 请求 429：同样不重放，直接 429
mode = 'always429'; primaryHits = 0; fallbackHits = 0
const r7 = await post({ model: 'm-tool', messages: [{ role: 'user', content: 'run' }], tools: [{ type: 'function', function: { name: 'shell', parameters: { type: 'object', properties: {} } } }] })
check('tool 请求 429 不重放（上游仅 1 次）', r7.status === 429 && primaryHits === 1, { status: r7.status, primaryHits })

// 8) 平台额度类 429 归因区分
mode = 'quota429'; primaryHits = 0; fallbackHits = 0
const r8 = await post({ model: 'm-solo', messages: [msg] })
const j8 = await r8.json()
check('额度类 429 归因为 platform_quota', r8.status === 429 && j8.error.attribution === 'platform_quota', { status: r8.status, attribution: j8.error && j8.error.attribution })

// 9) Retry-After 超过预算可承受上限：不空等，立即 429
mode = 'slow429'; primaryHits = 0; fallbackHits = 0
const t9 = Date.now()
const r9 = await post({ model: 'm-solo', messages: [msg] })
const ms9 = Date.now() - t9
check('Retry-After 超上限 → 不等待直接 429', r9.status === 429 && ms9 < 2000, { status: r9.status, ms9 })

await gw.close()
await primary.close()
await fallback.close()
export { summary }
