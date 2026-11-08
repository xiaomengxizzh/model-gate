// 流式「头 2xx + 立刻断流」故障转移契约：上游返回 2xx/event-stream 后一个 token 都没回传就断流，
// 网关应识别为失败并继续模型链——同一模型切备用上游、跨模型切目录下一模型。
// 关键：未回传内容 → 可安全重发（无重复风险），不得死等续传。
// MG-004：自建隔离实例，不再读写目标网关配置；场景 5 的「配置关」用第二个隔离实例表达（原实现改目标网关配置）。
import { startGateway, startMockServer } from './isolate.mjs'
import { check, finish, streamDeltaText } from './utils.mjs'

const hits = { A: 0, B: 0, C: 0, E: 0 }
// A：半死上游——2xx + SSE 头 + 仅 role 帧（0 content）后断流（延迟 600ms 确保走 relay 中断路径，而非连接失败）
const sA = await startMockServer((req, res) => {
  hits.A += 1
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write('data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n')
  setTimeout(() => res.destroy(), 600)
})
// C：回答中断流——已回传 content（"half-"）后断流（streamInterruptOnContent=true 时应也切，客户端将收到 half-+ok-B 拼接）
const sC = await startMockServer((req, res) => {
  hits.C += 1
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write('data: {"choices":[{"delta":{"role":"assistant","content":"half-"},"finish_reason":null}]}\n\n')
  setTimeout(() => res.destroy(), 600)
})
// E：同 C（回答中断流），独立上游供场景 5 使用（无亲和/命中率记录，确保先被尝试）
const sE = await startMockServer((req, res) => {
  hits.E += 1
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write('data: {"choices":[{"delta":{"role":"assistant","content":"ee-"},"finish_reason":null}]}\n\n')
  setTimeout(() => res.destroy(), 600)
})
// B：正常上游——完整 SSE
const sB = await startMockServer((req, res) => {
  hits.B += 1
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write('data: {"choices":[{"delta":{"role":"assistant","content":"ok-B"},"finish_reason":null}]}\n\n')
  res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":2,"total_tokens":4}}\n\n')
  res.write('data: [DONE]\n\n')
  res.end()
})

const providers = {
  't-sf-a': { baseUrl: sA.base, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai', proxy: 'direct', circuit: { maxFailures: 999, openDurationMs: 5000 } },
  't-sf-b': { baseUrl: sB.base, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai', proxy: 'direct', circuit: null },
  't-sf-c': { baseUrl: sC.base, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai', proxy: 'direct', circuit: { maxFailures: 999, openDurationMs: 5000 } },
  't-sf-e': { baseUrl: sE.base, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai', proxy: 'direct', circuit: { maxFailures: 999, openDurationMs: 5000 } },
}
const models = {
  't-sf-m1': { provider: 't-sf-a', alias: [], fallbacks: ['t-sf-b'], maxConcurrent: 0 },  // 场景1：主 A 备 B
  't-sf-m3': { provider: 't-sf-a', alias: [], fallbacks: [], maxConcurrent: 0 },            // 场景2：仅 A，无备用
  't-sf-m2': { provider: 't-sf-b', alias: [], fallbacks: [], maxConcurrent: 0 },
  't-sf-m4': { provider: 't-sf-c', alias: [], fallbacks: ['t-sf-b'], maxConcurrent: 0 },  // 场景4：C 回答中断流
  't-sf-m5': { provider: 't-sf-e', alias: [], fallbacks: ['t-sf-b'], maxConcurrent: 0 },  // 场景5：E 回答中断流（独立，无亲和残留）
}

const fx = await startGateway({
  name: 'stream-failover',
  config: {
    providers, models,
    defaults: {
      retry: { maxAttempts: 1, initialDelayMs: 10, maxDelayMs: 20 },
      timeout: { loopMs: 15000 },
      directory: [{ model: 't-sf-m3' }, { model: 't-sf-m2' }],  // 场景2 模型级兜底链：m3 → m2
      failbackProbe: { enabled: false },
      streamInterruptOnContent: true,  // 场景4：已回传 content 后中断也切（用户策略）
    },
  },
})
try {
  // —— 场景 1：同模型主上游「假成功断流」→ 切备用上游 ——
  const r1 = await fx.chat('t-sf-m1')
  const txt1 = await r1.text()
  const delta1 = streamDeltaText(txt1)
  check('1·主上游被尝试过（命中 A）', hits.A >= 1, { A: hits.A, B: hits.B })
  check('1b·备用上游被使用（切到 B）', hits.B >= 1, { A: hits.A, B: hits.B })
  check('1c·最终收到完整响应内容（ok-B）', r1.status === 200 && delta1.includes('ok-B'), { status: r1.status, delta: delta1 })

  // —— 场景 2：模型无备用且主上游断流 → 切目录下一模型 ——
  const r2 = await fx.chat('t-sf-m3')
  const txt2 = await r2.text()
  const delta2 = streamDeltaText(txt2)
  check('2·跨模型切换：m3(A 断流) → m2(B) 成功', r2.status === 200 && delta2.includes('ok-B'), { status: r2.status, delta: delta2 })

  // —— 场景 3：半死上游被计入失败（errors 增加；maxFailures=999 避免熔断残留影响下次运行）——
  const st = await fx.status()
  const hA = st.providers.find(p => p.id === 't-sf-a')
  check('3·半死上游被计入失败（不再被当成成功）', !hA || (hA.st && hA.st.errors > 0), { a: hA && hA.st })

  // —— 场景 4：回答（content）已回传后中断 → streamInterruptOnContent=true 时也切备用 ——
  const r4 = await fx.chat('t-sf-m4')
  const txt4 = await r4.text()
  const delta4 = streamDeltaText(txt4)
  check('4·回答中断流也切：m4(C 断流) → B 成功', r4.status === 200 && delta4.includes('ok-B'), { status: r4.status, delta: delta4 })
  check('4b·拼接证据：客户端收到 half-(C) + ok-B(B)', delta4.includes('half-') && delta4.includes('ok-B'), { delta: delta4 })
} finally {
  await fx.stop()
}

// —— 场景 5：配置关（streamInterruptOnContent=false）→ 已回传内容后中断不切、发错误事件收尾 ——
const before5 = hits.B
const fx2 = await startGateway({
  name: 'stream-failover-off',
  config: {
    providers, models,
    defaults: {
      retry: { maxAttempts: 1, initialDelayMs: 10, maxDelayMs: 20 },
      timeout: { loopMs: 8000 },
      directory: [],
      failbackProbe: { enabled: false },
      streamInterruptOnContent: false,
    },
  },
})
try {
  const stCfg = await fx2.status()
  check('5c·配置确实已改为 false', stCfg.defaults && stCfg.defaults.streamInterruptOnContent === false, { v: stCfg.defaults && stCfg.defaults.streamInterruptOnContent })
  const r5 = await fx2.chat('t-sf-m5')  // m5：独立上游 E（无亲和/命中率残留），配置 false → E 中断后应报错收尾、不切 B
  const txt5 = await r5.text()
  check('5·配置关时回答中断不切（B 未再被用）', hits.B === before5, { B: hits.B, before: before5 })
  check('5b·客户端收到流内错误事件（非静默）', txt5.includes('stream_interrupted'), { hasError: txt5.includes('stream_interrupted'), head: txt5.slice(0, 200).replace(/\n/g, ' | ') })
} finally {
  await fx2.stop()
}
await sA.stop(); await sB.stop(); await sC.stop(); await sE.stop()
finish('stream-failover')
