// 流式「头 2xx + 立刻断流」故障转移契约：上游返回 2xx/event-stream 后一个 token 都没回传就断流，
// 网关应识别为失败并继续模型链——同一模型切备用上游、跨模型切目录下一模型。
// 关键：未回传内容 → 可安全重发（无重复风险），不得死等续传。
import http from 'node:http'
import { GW, check, snapshot, save, chat, streamDeltaText } from './utils.mjs'

const hits = { A: 0, B: 0, C: 0, E: 0 }
// A：半死上游——2xx + SSE 头 + 仅 role 帧（0 content）后断流（延迟 600ms 确保走 relay 中断路径，而非连接失败）
const sA = http.createServer((req, res) => {
  hits.A += 1
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write('data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n')
  setTimeout(() => res.destroy(), 600)
})
// C：回答中断流——已回传 content（"half-"）后断流（streamInterruptOnContent=true 时应也切，客户端将收到 half-+ok-B 拼接）
const sC = http.createServer((req, res) => {
  hits.C += 1
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write('data: {"choices":[{"delta":{"role":"assistant","content":"half-"},"finish_reason":null}]}\n\n')
  setTimeout(() => res.destroy(), 600) // 给网关时间收到并中继 half-，再断（否则等价于连接失败，测不到 relay 中断路径）
})
// E：同 C（回答中断流），独立上游供场景 5 使用（无亲和/命中率记录，确保先被尝试）
const sE = http.createServer((req, res) => {
  hits.E += 1
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write('data: {"choices":[{"delta":{"role":"assistant","content":"ee-"},"finish_reason":null}]}\n\n')
  setTimeout(() => res.destroy(), 600)
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
await new Promise(r => sC.listen(0, () => r()))
await new Promise(r => sE.listen(0, () => r()))
const portA = sA.address().port; const portB = sB.address().port; const portC = sC.address().port; const portE = sE.address().port

const base = await snapshot()
const origDefaults = JSON.parse(JSON.stringify(base.defaults))
base.providers['t-sf-a'] = { baseUrl: `http://127.0.0.1:${portA}`, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai', proxy: 'direct', circuit: { maxFailures: 999, openDurationMs: 5000 } }
base.providers['t-sf-b'] = { baseUrl: `http://127.0.0.1:${portB}`, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai', proxy: 'direct', circuit: null }
base.providers['t-sf-c'] = { baseUrl: `http://127.0.0.1:${portC}`, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai', proxy: 'direct', circuit: { maxFailures: 999, openDurationMs: 5000 } }
base.providers['t-sf-e'] = { baseUrl: `http://127.0.0.1:${portE}`, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai', proxy: 'direct', circuit: { maxFailures: 999, openDurationMs: 5000 } }
base.models['t-sf-m1'] = { provider: 't-sf-a', alias: [], fallbacks: ['t-sf-b'], maxConcurrent: 0 }  // 场景1：主 A 备 B
base.models['t-sf-m3'] = { provider: 't-sf-a', alias: [], fallbacks: [], maxConcurrent: 0 }            // 场景2：仅 A，无备用
base.models['t-sf-m2'] = { provider: 't-sf-b', alias: [], fallbacks: [], maxConcurrent: 0 }
base.models['t-sf-m4'] = { provider: 't-sf-c', alias: [], fallbacks: ['t-sf-b'], maxConcurrent: 0 }  // 场景4：C 回答中断流
base.models['t-sf-m5'] = { provider: 't-sf-e', alias: [], fallbacks: ['t-sf-b'], maxConcurrent: 0 }  // 场景5：E 回答中断流（独立，无亲和残留）
base.defaults = {
  ...(base.defaults || {}),
  retry: { maxAttempts: 1, initialDelayMs: 10, maxDelayMs: 20 },
  directory: [{ model: 't-sf-m3' }, { model: 't-sf-m2' }],  // 场景2 模型级兜底链：m3 → m2
  failbackProbe: { enabled: false },
  streamInterruptOnContent: true,  // 场景4：已回传 content 后中断也切（用户策略）
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

// —— 场景 4：回答（content）已回传后中断 → streamInterruptOnContent=true 时也切备用 ——
const r4 = await chat('t-sf-m4')
const txt4 = await r4.text()
const delta4 = streamDeltaText(txt4)
check('4·回答中断流也切：m4(C 断流) → B 成功', r4.status === 200 && delta4.includes('ok-B'), { status: r4.status, delta: delta4 })
check('4b·拼接证据：客户端收到 half-(C) + ok-B(B)', delta4.includes('half-') && delta4.includes('ok-B'), { delta: delta4 })

// —— 场景 5：配置关（streamInterruptOnContent=false）→ 已回传内容后中断不切、发错误事件收尾 ——
const before5 = hits.B
base.defaults = { ...base.defaults, streamInterruptOnContent: false }
await save(base.providers, base.models, base.defaults)
const stCfg = await (await fetch(GW + '/api/status')).json()
check('5c·配置确实已改为 false', stCfg.defaults && stCfg.defaults.streamInterruptOnContent === false, { v: stCfg.defaults && stCfg.defaults.streamInterruptOnContent })
const r5 = await chat('t-sf-m5')  // m5：独立上游 E（无亲和/命中率残留），配置 false → E 中断后应报错收尾、不切 B
const txt5 = await r5.text()
check('5·配置关时回答中断不切（B 未再被用）', hits.B === before5, { B: hits.B, before: before5 })
check('5b·客户端收到流内错误事件（非静默）', txt5.includes('stream_interrupted'), { hasError: txt5.includes('stream_interrupted'), head: txt5.slice(0, 200).replace(/\n/g, ' | ') })

const after = await snapshot()
delete after.providers['t-sf-a']; delete after.providers['t-sf-b']; delete after.providers['t-sf-c']; delete after.providers['t-sf-e']
delete after.models['t-sf-m1']; delete after.models['t-sf-m3']; delete after.models['t-sf-m2']; delete after.models['t-sf-m4']; delete after.models['t-sf-m5']
after.defaults = origDefaults
await save(after.providers, after.models, after.defaults)
await new Promise(r => sA.close(r))
await new Promise(r => sB.close(r))
await new Promise(r => sC.close(r))
await new Promise(r => sE.close(r))
