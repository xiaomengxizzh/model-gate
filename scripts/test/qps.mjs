// model QPS 令牌桶：qps=2 + 5 个顺序请求 → 缺令牌的请求须排队，总耗时被拉伸
// MG-004：自建隔离实例，不再读写目标网关配置。
import { startGateway, startMockServer } from './isolate.mjs'
import { check, finish } from './utils.mjs'

const up = await startMockServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}') })
const fx = await startGateway({
  name: 'qps',
  config: {
    providers: { 't-q': { baseUrl: up.base, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai' } },
    models: { 't-q-m': { provider: 't-q', alias: [], fallbacks: [], maxConcurrent: 0, qps: 2 } },
    defaults: { concurrency: { maxPerProvider: 100 }, retry: { maxAttempts: 1, initialDelayMs: 50, maxDelayMs: 100 } },
  },
})
try {
  const s1 = await fx.status()
  check('model QPS·字段已存储', (s1.models.find(m => m.name === 't-q-m') || {}).qps === 2, { qps: (s1.models.find(m => m.name === 't-q-m') || {}).qps })
  const t0 = Date.now()
  const got = []
  for (let i = 0; i < 5; i++) got.push((await fx.chat('t-q-m')).status)
  const dt = Date.now() - t0
  check('model QPS·qps=2 时 5 顺序请求被限速', got.every(x => x === 200) && dt >= 600, { elapsedMs: dt, statuses: got })
} finally {
  await fx.stop(); await up.stop()
}
finish('qps')
