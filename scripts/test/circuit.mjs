// 熔断参数可配：circuit.maxFailures=2 → 2 次失败即为 open
// 契约三条：① 连续失败达阈值即 open；② 冷却期内被绕开；③ **冷却到点必须放行一次半开探测**。
// ③ 来自生产 09-11 实录：跳过 open 上游时若顺手再调 markFail，markFail 会把 openUntil 重置为
// now+cd，而每个请求都会走到跳过分支 —— 冷却窗口被无限续期，只要流量不断上游就永无翻身机会，
// 整条兜底链退化成单点（jiyuan 熔断后其承载的 qwen3.8-flash/glm-5.3-flash 被永久排除，
// 链上只剩 gmi，gmi 一欠费即整链失败）。对照 ② 的 streamDrops 绕开分支：那里明确不调 markFail。
// MG-004：自建隔离实例，不再读写目标网关配置。
import { startGateway, startMockServer } from './isolate.mjs'
import { check, finish } from './utils.mjs'

let hits = 0
const up = await startMockServer((req, res) => { hits++; res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"busy"}') })
const CD = 3000
const fx = await startGateway({
  name: 'circuit',
  config: {
    providers: { 't-c': { baseUrl: up.base, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai', proxy: 'direct', circuit: { maxFailures: 2, openDurationMs: CD } } },
    models: { 't-c-m': { provider: 't-c', alias: [], fallbacks: [], maxConcurrent: 0 } },
    // directory 必须清空：否则 503 之后默认目录里的真模型会把请求兜成 200，
    // 「链路一定打在测试上游」的前提不成立，断言随环境/配置漂移（本机实录）。夹具默认已是空目录。
    defaults: { retry: { maxAttempts: 1, initialDelayMs: 50, maxDelayMs: 100 }, directory: [] },
  },
})
try {
  for (let i = 0; i < 3; i++) await fx.chat('t-c-m')
  const st = await fx.status()
  const h = st.providers.find(p => p.id === 't-c')
  check('熔断·连续失败数=2 即 open', h.st.state === 'open' || h.st.openUntilMs > 0, { state: h.st.state, openUntilMs: h.st.openUntilMs, hits })

  // 冷却期内持续打流量：到点后上游必须被重新尝试一次。
  // 若跳过分支调了 markFail（bug），每次请求都把 openUntil 推回 now+CD，hits 全程不增 → 断言失败。
  const hitsAtOpen = hits
  const tOpen = Date.now()
  let retried = 0; let firstRetryMs = null
  while (Date.now() - tOpen < CD + 2500) {
    await fx.chat('t-c-m')
    if (hits > hitsAtOpen) { retried = hits - hitsAtOpen; firstRetryMs = Date.now() - tOpen; break }
  }
  check('熔断·冷却到点后放行半开探测（冷却不被持续流量续期）', retried >= 1, { retried, firstRetryMs, CD, hits, hitsAtOpen })
} finally {
  await fx.stop(); await up.stop()
}
finish('circuit')
