// 连续断流绕开的 half-open 恢复契约：
// 上游连续流中断达阈值后应被绕开（冷却期内不再给它送流量），但冷却到点后必须放行一次探测——
// 否则「一断流就永久出局」：该上游既拿不到流量也永无机会自证恢复，整条兜底链退化成单点上游。
// 每个场景用独立模型名：绕开亲和/命中率排序残留，保证每轮都按配置顺序先试主上游 A。
import http from 'node:http'
import { GW, check, snapshot, save, chat, streamDeltaText } from './utils.mjs'

const hits = { A: 0, B: 0 }
// A：半死上游——2xx + SSE 头 + 仅 role 帧（0 content）后断流
const sA = http.createServer((req, res) => {
  hits.A += 1
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write('data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n')
  setTimeout(() => res.destroy(), 400)
})
// B：正常上游——完整 SSE
const sB = http.createServer((req, res) => {
  hits.B += 1
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write('data: {"choices":[{"delta":{"role":"assistant","content":"ok-B"},"finish_reason":null}]}\n\n')
  res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":2,"total_tokens":4}}\n\n')
  res.write('data: [DONE]\n\n')
  res.end()
})
await new Promise(r => sA.listen(0, () => r()))
await new Promise(r => sB.listen(0, () => r()))
const portA = sA.address().port
const portB = sB.address().port

// 每次运行用唯一 provider/模型名：避免上一轮留下的亲和(affinity)与连续断流计数污染本轮排序
const SUF = Math.random().toString(36).slice(2, 8)
const pA = 't-sd-' + SUF + '-a'
const pB = 't-sd-' + SUF + '-b'
const m = (n) => 't-sd-' + SUF + '-m' + n

const base = await snapshot()
const origDefaults = JSON.parse(JSON.stringify(base.defaults))
base.providers[pA] = { baseUrl: `http://127.0.0.1:${portA}`, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai', proxy: 'direct', circuit: { maxFailures: 999, openDurationMs: 5000 } }
base.providers[pB] = { baseUrl: `http://127.0.0.1:${portB}`, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai', proxy: 'direct', circuit: null }
for (const n of ['1', '2', '3', '4', '5']) base.models[m(n)] = { provider: pA, alias: [], fallbacks: [pB], maxConcurrent: 0 }
base.defaults = {
  ...(base.defaults || {}),
  retry: { maxAttempts: 1, initialDelayMs: 10, maxDelayMs: 20 },
  timeout: Object.assign({}, (base.defaults && base.defaults.timeout) || {}, { loopMs: 15000 }),
  directory: [],
  failbackProbe: { enabled: false },
  streamInterruptOnContent: true,
  streamDropCooldownMs: 800, // 冷却 0.8s：测试不必干等默认 60s
}
await save(base.providers, base.models, base.defaults)

const ask = async (n) => { const r = await chat(m(n), true); const t = await r.text(); return { status: r.status, delta: streamDeltaText(t) } }

// 1-3：连续三次请求让 A 的连续断流计数达到阈值
const r1 = await ask(1)
const r2 = await ask(2)
const r3 = await ask(3)
check('1·三次断流请求均切备用上游成功', [r1, r2, r3].every(r => r.status === 200 && r.delta.includes('ok-B')), { d: [r1.delta, r2.delta, r3.delta] })
check('2·A 被尝试过（累计三次断流）', hits.A >= 3, { A: hits.A, B: hits.B })

// 3：冷却期内 → A 应被绕开，不再给它送流量
const aBefore4 = hits.A
const r4 = await ask(4)
check('3·冷却期内绕开 A（A 未被请求）', hits.A === aBefore4, { A: hits.A, before: aBefore4 })
check('3b·绕开后仍由 B 正常应答', r4.status === 200 && r4.delta.includes('ok-B'), { delta: r4.delta })

// 4：冷却到点 → half-open 放行一次探测（回归点：修复前 A 被永久钉死，此处 A 计数不再增长）
await new Promise(r => setTimeout(r, 1000))
const aBefore5 = hits.A
const r5 = await ask(5)
check('4·冷却结束后 half-open 放行 A（A 重新被尝试）', hits.A > aBefore5, { A: hits.A, before: aBefore5 })
check('4b·探测仍失败时切 B 成功（不中断服务）', r5.status === 200 && r5.delta.includes('ok-B'), { delta: r5.delta })

const after = await snapshot()
delete after.providers[pA]; delete after.providers[pB]
for (const n of ['1', '2', '3', '4', '5']) delete after.models[m(n)]
after.defaults = origDefaults
await save(after.providers, after.models, after.defaults)
await new Promise(r => sA.close(r))
await new Promise(r => sB.close(r))
