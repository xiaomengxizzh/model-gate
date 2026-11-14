// 缓存亲和（affinity）有效期回归：provider=A(主) + B(备)。
//
// 为什么旧夹具（scripts/test/affinity.mjs）过期：
//   旧夹具用 "A 返回 503" 期望同一请求内切到 B。当前契约（request-lifecycle §9.4/§9.5 + M1-3a）
//   规定 "收到 5xx 响应头即一次终态、不换候选"（回归见 forward-wiring.test.mjs T-LIFE-04c），
//   所以旧期望 2/3 必然失败、1 空过。
//
//   也不存在 "响应头之前的传输失败 → 同一请求切备用" 的合法路径：
//   src/forward.js 的 makeAdapter 在 forwardOnce 之前调用 attempt.onWriteBegin，连接被拒/对端
//   destroy 都会落 SENT_UNKNOWN → noReplay（探针实测：A destroy/closed-port 时 3 轮均 502 no_replay，
//   B 命中 0）。因此本夹具改用当前语义下**合法**的跨请求切换路径：
//     A 返回 503 → 本次请求 502 一次终态，同时 A 熔断（circuit.maxFailures=1）；
//     下一次请求跳过熔断中的 A → B 成功并写入 affinity；
//     TTL 内继续粘住 B；TTL 过期且 A 冷却结束后回流 A。
//
// 目的：验证 affinityTtlMs 既不提前抖动、也不会在上游恢复后永久粘住备用。
// 只使用自建隔离实例（OS 临时配置目录 + 动态回环端口 + 本地 mock），不读写目标网关配置。
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, startMockServer } from '../isolate.mjs'

const hits = { A: 0, B: 0 }
const down = { A: false }
let fx = null
let sA = null
let sB = null

const okBody = (name) => JSON.stringify({
  id: 'x', object: 'chat.completion', created: 0, model: 't-ttl-m',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok-' + name }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
})

before(async () => {
  sA = await startMockServer((req, res) => {
    hits.A += 1
    if (down.A) { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"busy"}'); return }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(okBody('A'))
  })
  sB = await startMockServer((req, res) => {
    hits.B += 1
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(okBody('B'))
  })
  // circuit.maxFailures=1：一次 503 即让 A 进入冷却；openDurationMs 大于紧随其后的两步请求，
  // 但小于 TTL 过期后的等待，确保第 5 步能半开探测 A。
  fx = await startGateway({
    name: 'affinity',
    config: {
      providers: {
        't-ttl-a': { baseUrl: sA.base, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai', proxy: 'direct', circuit: { maxFailures: 1, openDurationMs: 3000 } },
        't-ttl-b': { baseUrl: sB.base, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai', proxy: 'direct', circuit: null },
      },
      models: { 't-ttl-m': { provider: 't-ttl-a', alias: [], fallbacks: ['t-ttl-b'], maxConcurrent: 0 } },
      defaults: {
        retry: { maxAttempts: 1, initialDelayMs: 10, maxDelayMs: 20 },
        affinityTtlMs: 800,
        timeout: { connectMs: 2000, firstByteMs: 2000, idleMs: 2000, loopMs: 5000, overallMs: 5000 },
      },
    },
  })
})

after(async () => {
  if (fx) await fx.stop()
  if (sA) await sA.stop()
  if (sB) await sB.stop()
})

async function chat() {
  const r = await fx.chat('t-ttl-m')
  return { status: r.status, body: await r.text() }
}

test('1·首请求命中主上游 A', async () => {
  const r = await chat()
  assert.equal(r.status, 200)
  assert.deepEqual(hits, { A: 1, B: 0 })
})

test('2·A 503 为单次终态：A 命中 +1、B 零命中、请求 502（T-LIFE-04c）', async () => {
  down.A = true
  const before = { A: hits.A, B: hits.B }
  const r = await chat()
  assert.equal(r.status, 502)
  assert.equal(hits.A, before.A + 1)
  assert.equal(hits.B, before.B, '5xx 收到头不得换候选重放')
})

test('3·熔断后的下一请求切到备用 B', async () => {
  down.A = false
  const before = { A: hits.A, B: hits.B }
  const r = await chat()
  assert.equal(r.status, 200)
  assert.equal(hits.B, before.B + 1)
  assert.equal(hits.A, before.A, 'A 仍在熔断冷却，不应被尝试')
})

test('4·TTL 未到期时保持亲和 B（不抖动）', async () => {
  const before = { A: hits.A, B: hits.B }
  const r = await chat()
  assert.equal(r.status, 200)
  assert.equal(hits.B, before.B + 1)
  assert.equal(hits.A, before.A)
})

test('5·TTL 过期且 A 冷却结束后回流主上游 A', async () => {
  const before = { A: hits.A, B: hits.B }
  await new Promise((resolve) => setTimeout(resolve, 3500))
  const r = await chat()
  assert.equal(r.status, 200)
  assert.equal(hits.A, before.A + 1)
  assert.equal(hits.B, before.B)
})
