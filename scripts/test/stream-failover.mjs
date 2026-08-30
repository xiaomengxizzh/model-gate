// 流式「头 2xx + 立刻断流」故障转移契约：上游返回 2xx/event-stream 后一个 token 都没回传就断流，
// 网关应识别为失败并继续模型链——同一模型切备用上游、跨模型切目录下一模型。
// 关键：未回传内容 → 可安全重发（无重复风险），不得死等续传。
import http from 'node:http'
import { GW, check, snapshot, save, chat, streamDeltaText } from './utils.mjs'

const hits = { A: 0, B: 0 }
// A：半死上游——2xx + SSE 头 + 仅 role 帧（0 content）后立刻断流
const sA = http.createServer((req, res) => {
  hits.A += 1
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write('data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n')
  res.destroy()
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
const portA = sA.address().port; const portB = sB.address().port

const base = await snapshot()
const origDefaults = JSON.parse(JSON.stringify(base.defaults))
base.providers['t-sf-a'] = { baseUrl: `http://127.0.0.1:${portA}`, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai', proxy: 'direct', circuit: { maxFailures: 999, openDurationMs: 5000 } }
base.providers['t-sf-b'] = { baseUrl: `http://127.0.0.1:${portB}`, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai', proxy: 'direct', circuit: null }
base.models['t-sf-m1'] = { provider: 't-sf-a', alias: [], fallbacks: ['t-sf-b'], maxConcurrent: 0 }  // 场景1：主 A 备 B
base.models['t-sf-m3'] = { provider: 't-sf-a', alias: [], fallbacks: [], maxConcurrent: 0 }            // 场景2：仅 A，无备用
base.models['t-sf-m2'] = { provider: 't-sf-b', alias: [], fallbacks: [], maxConcurrent: 0 }
base.defaults = {
  ...(base.defaults || {}),
  retry: { maxAttempts: 1, initialDelayMs: 10, maxDelayMs: 20 },
  directory: [{ model: 't-sf-m3' }, { model: 't-sf-m2' }],  // 场景2 模型级兜底链：m3 → m2
  failbackProbe: { enabled: false },
}
await save(base.providers, base.models, base.defaults)

// —— 场景 1：同模型主上游「假成功断流」→ 切备用上游 ——
const r1 = await chat('t-sf-m1')
const txt1 = await r1.text()
const delta1 = streamDeltaText(txt1)
check('1·主上游被尝试过（命中 A）', hits.A >= 1, { A: hits.A, B: hits.B })
check('1b·备用上游被使用（切到 B）', hits.B >= 1, { A: hits.A, B: hits.B })
check('1c·最终收到完整响应内容（ok-B）', r1.status === 200 && delta1.includes('ok-B'), { status: r1.status, delta: delta1 })

// —— 场景 2：模型无备用且主上游断流 → 切目录下一模型 ——
const r2 = await chat('t-sf-m3')
const txt2 = await r2.text()
const delta2 = streamDeltaText(txt2)
check('2·跨模型切换：m3(A 断流) → m2(B) 成功', r2.status === 200 && delta2.includes('ok-B'), { status: r2.status, delta: delta2 })

// —— 场景 3：半死上游被计入失败（errors 增加；maxFailures=999 避免熔断残留影响下次运行）——
const st = await (await fetch(GW + '/api/status')).json()
const hA = st.providers.find(p => p.id === 't-sf-a')
check('3·半死上游被计入失败（不再被当成成功）', !hA || (hA.st && hA.st.errors > 0), { a: hA && hA.st })

const after = await snapshot()
delete after.providers['t-sf-a']; delete after.providers['t-sf-b']
delete after.models['t-sf-m1']; delete after.models['t-sf-m3']; delete after.models['t-sf-m2']
after.defaults = origDefaults
await save(after.providers, after.models, after.defaults)
await new Promise(r => sA.close(r))
await new Promise(r => sB.close(r))
