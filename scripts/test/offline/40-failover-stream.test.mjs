// G1/G2：模型级拒绝继续目录链、5xx 熔断与半开恢复、断流不伪装成功、客户端取消传播。
import { startGateway, mockUpstream, check, summary, readSse, sseStart, sseWrite, sleep, CLIENT } from './harness.mjs'

let mode = 'ok'
let hits = 0
const up = await mockUpstream((req, res, body) => {
  hits++
  const j = JSON.parse(body || '{}')
  if (mode === '403' && j.model === 'm-a') { res.writeHead(403, { 'content-type': 'application/json' }); res.end('{"error":{"message":"model not allowed"}}'); return }
  if (mode === '500' && j.model === 'm-a') { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":{"message":"boom"}}'); return }
  if (mode === 'drop' && j.model === 'm-ok') {
    sseStart(res)
    sseWrite(res, { choices: [{ index: 0, delta: { content: 'partial' } }] })
    setTimeout(() => { try { res.destroy() } catch {} }, 30)
    return
  }
  if (j.stream) {
    sseStart(res)
    for (const t of ['a', 'b']) sseWrite(res, { choices: [{ index: 0, delta: { content: t } }] })
    sseWrite(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } })
    sseWrite(res, '[DONE]')
    res.end()
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ model: j.model, choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
})

const gw = await startGateway({
  defaults: {
    affinityTtlMs: 1,
    retry: { maxAttempts: 1, initialDelayMs: 10, maxDelayMs: 20 },
    budget: { maxAttempts: 4, maxMs: 4000, maxWaitMs: 300 },
    directory: [{ model: 'm-ok', mode: 'afterAll' }],
  },
  providers: {
    p1: { baseUrl: up.url, apiKeyEnv: '', api: 'openai', circuit: { maxFailures: 2, openDurationMs: 300 } },
    p2: { baseUrl: up.url, apiKeyEnv: '', api: 'openai' },
  },
  models: { 'm-a': { provider: 'p1' }, 'm-ok': { provider: 'p2' } },
})
const chat = (body) => fetch(gw.base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + CLIENT }, body: JSON.stringify(body) })
const msg = { role: 'user', content: 'x' }

// 1. 403 模型级拒绝 → 继续目录链到下一模型，响应 model 回写请求名
mode = '403'; hits = 0
const r1 = await chat({ model: 'm-a', messages: [msg] })
const j1 = await r1.json()
check('403 模型级拒绝继续目录链并成功', r1.status === 200 && j1.choices[0].message.content === 'ok' && j1.model === 'm-a', { status: r1.status, model: j1.model, hits })

// 2. 5xx 熔断：连续失败达到阈值后跳过该上游
mode = '500'; hits = 0
const r2a = await chat({ model: 'm-a', messages: [msg] })
const r2b = await chat({ model: 'm-a', messages: [msg] })
const h = gw.state.health.p1
check('5xx 达阈值后熔断打开', r2a.status === 200 && r2b.status === 200 && h.state === 'open' && h.fails >= 2, { state: h.state, fails: h.fails })
const beforeSkip = hits
const r2c = await chat({ model: 'm-a', messages: [msg] })
check('熔断期间跳过故障上游直接走备用', r2c.status === 200 && hits === beforeSkip + 1, { status: r2c.status, delta: hits - beforeSkip })
await sleep(380)
mode = 'ok'
const r2d = await chat({ model: 'm-a', messages: [msg] })
check('冷却后半开探测成功并恢复', r2d.status === 200 && gw.state.health.p1.state === 'ok', { state: gw.state.health.p1.state })

// 3. Chat 断流（无 [DONE]）：必须显式 stream_interrupted，不得伪装成功
mode = 'drop'; hits = 0
const r3 = await chat({ model: 'm-ok', messages: [msg], stream: true })
const { text } = await readSse(r3)
check('Chat 断流 → 客户端收到 stream_interrupted + [DONE]', /stream_interrupted/.test(text) && /\[DONE\]/.test(text), { tail: text.slice(-160) })

// 4. Responses 断流：response.failed，不得 response.completed
const r4 = await fetch(gw.base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + CLIENT }, body: JSON.stringify({ model: 'm-ok', input: 'x', stream: true }) })
const s4 = await r4.text()
check('Responses 断流 → response.failed（无 response.completed）', r4.status === 200 && /response\.failed/.test(s4) && !/response\.completed/.test(s4), { hasFailed: /response\.failed/.test(s4), hasCompleted: /response\.completed/.test(s4) })

// 5. 客户端取消：中止后网关不崩、上游被销毁，后续请求正常
mode = 'ok'
const ac = new AbortController()
const r5 = await fetch(gw.base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + CLIENT }, body: JSON.stringify({ model: 'm-ok', messages: [msg], stream: true }), signal: ac.signal })
const reader = r5.body.getReader()
await reader.read()
ac.abort()
await sleep(120)
const health = await fetch(gw.base + '/healthz')
const r5b = await chat({ model: 'm-ok', messages: [msg] })
check('客户端取消后网关健康且后续请求正常', health.status === 200 && r5b.status === 200, { health: health.status, status: r5b.status })

// 6. 客户端取消不进程崩溃：/api/status 仍可读
const st = await gw.adminFetch('/api/status')
check('取消后管理面仍可读', st.status === 200, { status: st.status })

await gw.close()
await up.close()
export { summary }
