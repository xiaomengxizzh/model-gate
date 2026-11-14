// 429 + Retry-After 内部排队重发（MG-004：自建隔离实例，不再读写目标网关配置）。
import { startGateway, startMockServer } from './isolate.mjs'
import { check, finish } from './utils.mjs'

let hits = 0
const up = await startMockServer((req, res) => { hits++; if (hits === 1) { res.writeHead(429, { 'retry-after': '1' }); res.end('{}'); return } res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}') })
const fx = await startGateway({
  name: 'rate429',
  config: {
    providers: { 't-thr': { baseUrl: up.base, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai' } },
    models: { 't-thr-m': { provider: 't-thr', alias: [], fallbacks: [], maxConcurrent: 0 } },
    defaults: { retry: { maxAttempts: 1, initialDelayMs: 100, maxDelayMs: 200 } },
  },
})
try {
  // 0.2.0 循环兜底后，429 对客户端透明：首请求在网关内按 Retry-After 排队并重发上游，最终 200。
  const t0 = Date.now(); const r1 = await fx.chat('t-thr-m'); const dt1 = Date.now() - t0
  check('429·首请求按 Retry-After 内部排队后成功(循环兜底)', r1.status === 200 && dt1 >= 850 && hits === 2, { status: r1.status, ms: dt1, hits })
  const t1 = Date.now(); const r2 = await fx.chat('t-thr-m'); const dt2 = Date.now() - t1
  check('429·后续请求不再等待(冷却已过)', r2.status === 200 && dt2 < 850, { ms: dt2 })
} finally {
  await fx.stop(); await up.stop()
}
finish('rate429')
