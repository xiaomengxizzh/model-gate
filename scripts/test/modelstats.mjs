// 每模型天级 token/缓存统计：上游返回带缓存的 usage → /api/model-stats 聚合正确
// MG-004：自建隔离实例，不再读写目标网关配置。
import { startGateway, startMockServer } from './isolate.mjs'
import { check, finish } from './utils.mjs'

const up = await startMockServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { total_tokens: 100, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20 } })) })
const fx = await startGateway({
  name: 'modelstats',
  config: {
    providers: { 't-ms': { baseUrl: up.base, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai' } },
    models: { 't-ms-m': { provider: 't-ms', alias: [], fallbacks: [], maxConcurrent: 0 } },
  },
})
try {
  const r1 = await fx.chat('t-ms-m')
  check('modelstats·上游响应成功', r1.status === 200, { status: r1.status })
  const st = await (await fx.get('/api/model-stats?days=1', fx.admin)).json()
  const arr = (st.models['t-ms-m']) || []
  const today = arr[arr.length - 1]
  check('modelstats·天级 token 聚合', today && today.tokens >= 100, { tokens: today && today.tokens })
  check('modelstats·缓存命中率(hit/miss)', today && today.hitRate != null && today.hitRate >= 79 && today.hitRate <= 81, { hitRate: today && today.hitRate })
} finally {
  await fx.stop(); await up.stop()
}
finish('modelstats')
