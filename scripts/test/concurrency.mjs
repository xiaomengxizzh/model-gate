// provider / model 级并发上限（MG-004：每个场景自建隔离实例，不再读写目标网关配置）。
import { startGateway, startMockServer } from './isolate.mjs'
import { check, finish } from './utils.mjs'

// provider 级并发上限（默认 8，测试时设为 4）
{
  let active = 0, maxAct = 0
  const up = await startMockServer((req, res) => { active++; maxAct = Math.max(maxAct, active); setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); active-- }, 160) })
  const fx = await startGateway({
    name: 'concurrency-provider',
    config: {
      providers: { 't-slow': { baseUrl: up.base, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai' } },
      models: { 't-slow-m': { provider: 't-slow', alias: [], fallbacks: [], maxConcurrent: 0 } },
      defaults: { concurrency: { maxPerProvider: 4 }, retry: { maxAttempts: 1, initialDelayMs: 100, maxDelayMs: 200 } },
    },
  })
  try {
    const got = await Promise.all(Array.from({ length: 12 }, () => fx.chat('t-slow-m').then(r => r.status)))
    check('provider 并发·最大并行<=4 且 12 请求全成功', maxAct <= 4 && got.every(x => x === 200) && got.length === 12, { maxAct })
  } finally {
    await fx.stop(); await up.stop()
  }
}

// model 级并发上限（maxConcurrent=2）
{
  let active = 0, maxAct = 0
  const up = await startMockServer((req, res) => { active++; maxAct = Math.max(maxAct, active); setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); active-- }, 140) })
  const fx = await startGateway({
    name: 'concurrency-model',
    config: {
      providers: { 't-mc': { baseUrl: up.base, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai' } },
      models: { 't-mc-m': { provider: 't-mc', alias: [], fallbacks: [], maxConcurrent: 2 } },
      defaults: { retry: { maxAttempts: 1, initialDelayMs: 100, maxDelayMs: 200 } },
    },
  })
  try {
    const got = await Promise.all(Array.from({ length: 6 }, () => fx.chat('t-mc-m').then(r => r.status)))
    check('model 并发·最大并行<=2 且全成功', maxAct <= 2 && got.every(x => x === 200), { maxAct })
  } finally {
    await fx.stop(); await up.stop()
  }
}
finish('concurrency')
