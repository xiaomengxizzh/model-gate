// 流已开始后的上游 4xx 契约：流式响应头/部分内容已发给客户端后，后续上游再返回 4xx，
// 网关不得回写 HTTP 状态码（曾抛 "Cannot write headers after they are sent"，
// 客户端只收到没有 [DONE] 的半截流），必须以流内错误事件收尾。
// MG-004：自建隔离实例，不再读写目标网关配置。
import { startGateway, startMockServer } from './isolate.mjs'
import { check, finish } from './utils.mjs'

const hits = { A: 0, B: 0 }
// A：半死上游——2xx + SSE 头 + 仅 role 帧（未回传 content）后断流 → 触发切下一上游
const sA = await startMockServer((req, res) => {
  hits.A += 1
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write('data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n')
  setTimeout(() => res.destroy(), 400)
})
// B：拒绝上游——非流式 400（流已开始后返回它，正是历史上二次 writeHead 的触发点）
const sB = await startMockServer((req, res) => {
  hits.B += 1
  const body = JSON.stringify({ error: { message: 'upstream rejected (test)', type: 'invalid_request_error' } })
  res.writeHead(400, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
})

const pA = 't-ss-a'
const pB = 't-ss-b'
const m1 = 't-ss-m1'
const fx = await startGateway({
  name: 'stream-started-4xx',
  config: {
    providers: {
      [pA]: { baseUrl: sA.base, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai', proxy: 'direct', circuit: { maxFailures: 999, openDurationMs: 5000 } },
      [pB]: { baseUrl: sB.base, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai', proxy: 'direct', circuit: null },
    },
    models: { [m1]: { provider: pA, alias: [], fallbacks: [pB], maxConcurrent: 0 } },
    defaults: {
      retry: { maxAttempts: 1, initialDelayMs: 10, maxDelayMs: 20 },
      timeout: { loopMs: 8000 },
      directory: [],
      failbackProbe: { enabled: false },
    },
  },
})
try {
  const r = await fx.chat(m1, true)
  const txt = await r.text()
  check('1·主上游 A 被尝试（流式已开始）', hits.A >= 1, { A: hits.A, B: hits.B })
  check('2·A 断流后切到 B，B 返回 400', hits.B >= 1, { A: hits.A, B: hits.B })
  check('3·客户端收到流内错误事件（非静默半截流）', txt.includes('stream_interrupted'), { head: txt.slice(0, 160).replace(/\n/g, ' | ') })
  check('4·响应以完整 [DONE] 收尾（未因 headers 已发送而崩溃）', txt.trim().endsWith('data: [DONE]'), { tail: txt.slice(-80).replace(/\n/g, ' | ') })
} finally {
  await fx.stop(); await sA.stop(); await sB.stop()
}
finish('stream-started-4xx')
