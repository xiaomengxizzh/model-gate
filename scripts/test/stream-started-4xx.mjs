// 流已开始后的上游 4xx 契约：流式响应头/部分内容已发给客户端后，后续上游再返回 4xx，
// 网关不得回写 HTTP 状态码（曾抛 "Cannot write headers after they are sent"，
// 客户端只收到没有 [DONE] 的半截流），必须以流内错误事件收尾。
import http from 'node:http'
import { GW, check, snapshot, save, chat } from './utils.mjs'

const hits = { A: 0, B: 0 }
// A：半死上游——2xx + SSE 头 + 仅 role 帧（未回传 content）后断流 → 触发切下一上游
const sA = http.createServer((req, res) => {
  hits.A += 1
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write('data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n')
  setTimeout(() => res.destroy(), 400)
})
// B：拒绝上游——非流式 400（流已开始后返回它，正是历史上二次 writeHead 的触发点）
const sB = http.createServer((req, res) => {
  hits.B += 1
  const body = JSON.stringify({ error: { message: 'upstream rejected (test)', type: 'invalid_request_error' } })
  res.writeHead(400, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
})
await new Promise(r => sA.listen(0, () => r()))
await new Promise(r => sB.listen(0, () => r()))
const portA = sA.address().port
const portB = sB.address().port

// 每次运行用唯一 provider/模型名：避免上一轮留下的亲和(affinity)与连续断流计数污染本轮排序
const SUF = Math.random().toString(36).slice(2, 8)
const pA = 't-ss-' + SUF + '-a'
const pB = 't-ss-' + SUF + '-b'
const m1 = 't-ss-' + SUF + '-m1'

const base = await snapshot()
const origDefaults = JSON.parse(JSON.stringify(base.defaults))
base.providers[pA] = { baseUrl: `http://127.0.0.1:${portA}`, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai', proxy: 'direct', circuit: { maxFailures: 999, openDurationMs: 5000 } }
base.providers[pB] = { baseUrl: `http://127.0.0.1:${portB}`, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai', proxy: 'direct', circuit: null }
base.models[m1] = { provider: pA, alias: [], fallbacks: [pB], maxConcurrent: 0 }
base.defaults = {
  ...(base.defaults || {}),
  retry: { maxAttempts: 1, initialDelayMs: 10, maxDelayMs: 20 },
  timeout: Object.assign({}, (base.defaults && base.defaults.timeout) || {}, { loopMs: 8000 }),
  directory: [],
  failbackProbe: { enabled: false },
}
await save(base.providers, base.models, base.defaults)

const r = await chat(m1, true)
const txt = await r.text()
check('1·主上游 A 被尝试（流式已开始）', hits.A >= 1, { A: hits.A, B: hits.B })
check('2·A 断流后切到 B，B 返回 400', hits.B >= 1, { A: hits.A, B: hits.B })
check('3·客户端收到流内错误事件（非静默半截流）', txt.includes('stream_interrupted'), { head: txt.slice(0, 160).replace(/\n/g, ' | ') })
check('4·响应以完整 [DONE] 收尾（未因 headers 已发送而崩溃）', txt.trim().endsWith('data: [DONE]'), { tail: txt.slice(-80).replace(/\n/g, ' | ') })

const after = await snapshot()
delete after.providers[pA]; delete after.providers[pB]
delete after.models[m1]
after.defaults = origDefaults
await save(after.providers, after.models, after.defaults)
await new Promise(r => sA.close(r))
await new Promise(r => sB.close(r))
