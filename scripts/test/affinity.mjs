// 缓存亲和（affinity）有效期契约：provider=A(主) + B(备)，先让 A 故障使流量切到 B，再恢复 A。
// 期望：TTL(defaults.affinityTtlMs) 内保持亲和 B 不抖动；TTL 过期后亲和失效，请求回流到配置首位 A。
// 目的：避免"上游恢复后因亲和粘性永不回流"——故障时自动切备，恢复后自动切回。
// MG-004：自建隔离实例（OS 临时配置目录 + 动态回环端口 + 本地 mock），不再读写目标网关配置。
import { startGateway, startMockServer } from './isolate.mjs'
import { check, finish } from './utils.mjs'

const hits = { A: 0, B: 0 }
const down = { A: false, B: false }
const mkServer = (name) => startMockServer((req, res) => {
  hits[name] += 1
  if (down[name]) { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"busy"}'); return }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({
    id: 'x', object: 'chat.completion', created: 0, model: 't-ttl-m',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok-' + name }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }))
})
const sA = await mkServer('A'); const sB = await mkServer('B')

const fx = await startGateway({
  name: 'affinity',
  config: {
    providers: {
      't-ttl-a': { baseUrl: sA.base, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai', proxy: 'direct', circuit: null },
      't-ttl-b': { baseUrl: sB.base, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai', proxy: 'direct', circuit: null },
    },
    models: { 't-ttl-m': { provider: 't-ttl-a', alias: [], fallbacks: ['t-ttl-b'], maxConcurrent: 0 } },
    defaults: { retry: { maxAttempts: 1, initialDelayMs: 10, maxDelayMs: 20 }, affinityTtlMs: 800 },
  },
})
try {
  // 1) 首请求：主上游 A 正常 → 应命中 A
  await fx.chat('t-ttl-m')
  check('1·首请求命中主上游 A', hits.A === 1, { A: hits.A, B: hits.B })

  // 2) A 挂掉 → 流量切到 B（命中即成功，affinity 记录为 B）
  down.A = true
  await fx.chat('t-ttl-m')
  check('2·主上游故障后切到备用 B', hits.B === 1, { A: hits.A, B: hits.B })

  // 3) A 恢复；未超 TTL 时亲和仍粘住 B（验证 TTL 未到期不会乱切）
  down.A = false
  await fx.chat('t-ttl-m')
  check('3·TTL 未到期时仍保持亲和 B（不抖动）', hits.B === 2, { A: hits.A, B: hits.B })

  // 4) 等待 TTL 过期 → 亲和失效 → 最后一次请求应回流到配置首位 A（用增量断言，不依赖绝对计数）
  const before = { A: hits.A, B: hits.B }
  await new Promise(r => setTimeout(r, 1200))
  await fx.chat('t-ttl-m')
  check('4·TTL 过期后回流主上游 A', hits.A === before.A + 1 && hits.B === before.B, { A: hits.A, B: hits.B, before })
} finally {
  await fx.stop(); await sA.stop(); await sB.stop()
}
finish('affinity')
