// G1 状态码矩阵：404 模型级继续链、408 超时、409 可重试、422 参数错误直通、5xx 有界。
import { startGateway, mockUpstream, check, summary, CLIENT } from './harness.mjs'

let mode = 'ok'
let hits = 0
const up = await mockUpstream((req, res, body) => {
  const j = JSON.parse(body || '{}')
  hits++
  if (mode === '404' && j.model === 'm-bad') { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":{"message":"model not found"}}'); return }
  if (mode === '408') { res.writeHead(408, { 'content-type': 'application/json' }); res.end('{"error":{"message":"request timeout"}}'); return }
  if (mode === '409once' && hits === 1) { res.writeHead(409, { 'content-type': 'application/json' }); res.end('{"error":{"message":"concurrent update, retry"}}'); return }
  if (mode === '422') { res.writeHead(422, { 'content-type': 'application/json' }); res.end('{"error":{"message":"max_tokens too large","type":"invalid_request_error"}}'); return }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ model: j.model, choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
})

const gw = await startGateway({
  defaults: { retry: { maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 20, jitter: 0 }, budget: { maxAttempts: 3, maxMs: 3000, maxWaitMs: 200 }, directory: [{ model: 'm-ok', mode: 'afterAll' }] },
  providers: { p1: { baseUrl: up.url, apiKeyEnv: '', api: 'openai' } },
  models: { 'm-bad': { provider: 'p1' }, 'm-ok': { provider: 'p1' } },
})
const chat = (model) => fetch(gw.base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + CLIENT }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'x' }] }) })

// 404 模型级拒绝 → 继续目录链
mode = '404'; hits = 0
const r1 = await chat('m-bad')
const j1 = await r1.json()
check('404 模型级拒绝继续目录链并成功', r1.status === 200 && j1.choices && j1.model === 'm-bad', { status: r1.status, model: j1.model })

// 408 超时：有界重试后回 408（不吞成 502）
mode = '408'; hits = 0
const r2 = await chat('m-ok')
const j2 = await r2.json()
check('408 超时有界重试后回 408', r2.status === 408 && j2.error.code === 'MG_UPSTREAM_TIMEOUT' && hits <= 3, { status: r2.status, hits })

// 409 可重试：一次冲突后成功
mode = '409once'; hits = 0
const r3 = await chat('m-ok')
check('409 冲突重试后成功', r3.status === 200 && hits === 2, { status: r3.status, hits })

// 422 参数错误：不重试、原样直通
mode = '422'; hits = 0
const r4 = await chat('m-ok')
const j4 = await r4.json()
check('422 参数错误不重试且原样回显', r4.status === 422 && hits === 1 && /max_tokens/.test(JSON.stringify(j4)), { status: r4.status, hits })

await gw.close()
await up.close()
export { summary }
