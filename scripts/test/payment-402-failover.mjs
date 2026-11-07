// 402 Payment Required 故障转移契约（生产 09-11 实录）：
// 上游账户欠费/额度停服时返回 402（gmi 现场文案 {"error":"Insufficient balance","reason":"model_access_denied"}），
// 网关应视同 403/404 继续目录链切下一上游/模型，而非把 402 当作「客户端请求错误」原样透传。
// 同时明确：402 不进 RETRYABLE_HTTP —— 余额不会在退避几百毫秒后回来，同上游重发纯属浪费，
// 有意义的动作是换上游。故断言「上游只被尝试一次」。
// 背景：dsh 走 gatemodel 通道，jiyuan 熔断 + gmi 欠费时兜底链只剩 gmi 一个候选，
// 402 直接透传导致整轮 turn 失败（dsh 侧 status=402 retryable=false）。
import http from 'node:http'
import { GW, check, snapshot, save, chat } from './utils.mjs'

// 名字带随机后缀：上游亲和（affinity）按模型名记在网关内存里、跨 run 存活，
// 固定名字会让上一次 run 留下的亲和把备用上游排到队首，「主上游被尝试」的断言随 run 次序漂移。
const SFX = Math.random().toString(36).slice(2, 8)
const A = 't-p402-a-' + SFX, B = 't-p402-b-' + SFX, C = 't-p402-c-' + SFX
const M1 = 't-p402-m1-' + SFX, M2 = 't-p402-m2-' + SFX

const hits = { A: 0, B: 0, C: 0 }
const PAYLOAD = JSON.stringify({ error: 'Insufficient balance', reason: 'model_access_denied' })
// A：账户欠费 402——gmi 现场实证文案，主上游
const sA = http.createServer((req, res) => {
  hits.A += 1
  res.writeHead(402, { 'content-type': 'application/json' })
  res.end(PAYLOAD)
})
// B：备用上游——正常 200
const sB = http.createServer((req, res) => {
  hits.B += 1
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model: M1, choices: [{ index: 0, message: { role: 'assistant', content: 'ok-B' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
})
// C：单上游 402——整链没有可用替代，应原样回 402 而不是 502
const sC = http.createServer((req, res) => {
  hits.C += 1
  res.writeHead(402, { 'content-type': 'application/json' })
  res.end(PAYLOAD)
})
await new Promise(r => sA.listen(0, () => r()))
await new Promise(r => sB.listen(0, () => r()))
await new Promise(r => sC.listen(0, () => r()))
const portA = sA.address().port; const portB = sB.address().port; const portC = sC.address().port

const base = await snapshot()
const origDefaults = JSON.parse(JSON.stringify(base.defaults))
base.providers[A] = { baseUrl: `http://127.0.0.1:${portA}`, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai', proxy: 'direct', circuit: null }
base.providers[B] = { baseUrl: `http://127.0.0.1:${portB}`, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai', proxy: 'direct', circuit: null }
base.providers[C] = { baseUrl: `http://127.0.0.1:${portC}`, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai', proxy: 'direct', circuit: null }
// 场景 1：m1 主上游 A（欠费 402）→ 应切备用 B
base.models[M1] = { provider: A, alias: [], fallbacks: [B], maxConcurrent: 0 }
// 场景 2：m2 只有 C（402），无备用 → 应原样回 402
base.models[M2] = { provider: C, alias: [], fallbacks: [], maxConcurrent: 0 }
base.defaults = {
  ...(base.defaults || {}),
  // maxAttempts>1 才能验出「402 没走同上游重试」：若 402 被误纳入 RETRYABLE_HTTP，A 会被撞 3 次
  retry: { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 20 },
  directory: [], // 清掉默认目录链，避免 402 切到真实上游导致断言不可控
  failbackProbe: { enabled: false },
}
await save(base.providers, base.models, base.defaults)

// —— 场景 1：主上游 402 → 切备用上游 ——
const r1 = await chat(M1)
const t1 = await r1.text()
check('1·402 切备用：m1(A 欠费 402) → B 成功', r1.status === 200 && t1.includes('ok-B'), { status: r1.status, body: t1.slice(0, 120) })
check('1b·A 确实被尝试过', hits.A >= 1, { A: hits.A })
check('1c·A 只被尝试 1 次（402 不触发同上游重试，maxAttempts=3 也不该重发）', hits.A === 1, { A: hits.A })

// —— 场景 2：整链 402 → 原样透传 402 + 保留上游原始错误体 ——
const before2 = hits.B
const r2 = await chat(M2)
const t2 = await r2.text()
check('2·整链 402：m2(C 单上游 402) → 透传 402（非 502）', r2.status === 402, { status: r2.status })
check('2b·上游原始错误体保留', t2.includes('Insufficient balance'), { body: t2.slice(0, 160) })
check('2c·C 只被尝试 1 次（不空转到 loopMs）', hits.C === 1, { C: hits.C })
check('2d·未误用备用 B', hits.B === before2, { B: hits.B, before: before2 })

const after = await snapshot()
delete after.providers[A]; delete after.providers[B]; delete after.providers[C]
delete after.models[M1]; delete after.models[M2]
after.defaults = origDefaults
await save(after.providers, after.models, after.defaults)
await new Promise(r => sA.close(r))
await new Promise(r => sB.close(r))
await new Promise(r => sC.close(r))
