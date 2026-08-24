import http from 'node:http'
import { check, snapshot, save, chat } from './utils.mjs'

// provider 级并发上限（默认 8，测试时设为 4）
{
  let active = 0, maxAct = 0
  const up = http.createServer((req, res) => { active++; maxAct = Math.max(maxAct, active); setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); active-- }, 160) })
  await new Promise(r => up.listen(0, () => r()))
  const base = await snapshot(); const orig = JSON.parse(JSON.stringify(base.defaults))
  base.providers['t-slow'] = { baseUrl: `http://127.0.0.1:${up.address().port}`, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai' }
  base.models['t-slow-m'] = { provider: 't-slow', alias: [], fallbacks: [], maxConcurrent: 0 }
  base.defaults = { ...(base.defaults || {}), concurrency: { maxPerProvider: 4 }, retry: { maxAttempts: 1, initialDelayMs: 100, maxDelayMs: 200 } }
  await save(base.providers, base.models, base.defaults)
  const got = await Promise.all(Array.from({ length: 12 }, () => chat('t-slow-m').then(r => r.status)))
  check('provider 并发·最大并行<=4 且 12 请求全成功', maxAct <= 4 && got.every(x => x === 200) && got.length === 12, { maxAct })
  const after = await snapshot(); delete after.providers['t-slow']; delete after.models['t-slow-m']; await save(after.providers, after.models, orig)
  await new Promise(r => up.close(r))
}

// model 级并发上限（maxConcurrent=2）
{
  let active = 0, maxAct = 0
  const up = http.createServer((req, res) => { active++; maxAct = Math.max(maxAct, active); setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); active-- }, 140) })
  await new Promise(r => up.listen(0, () => r()))
  const base = await snapshot(); const orig = JSON.parse(JSON.stringify(base.defaults))
  base.providers['t-mc'] = { baseUrl: `http://127.0.0.1:${up.address().port}`, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai' }
  base.models['t-mc-m'] = { provider: 't-mc', alias: [], fallbacks: [], maxConcurrent: 2 }
  await save(base.providers, base.models, base.defaults)
  const got = await Promise.all(Array.from({ length: 6 }, () => chat('t-mc-m').then(r => r.status)))
  check('model 并发·最大并行<=2 且全成功', maxAct <= 2 && got.every(x => x === 200), { maxAct })
  const after = await snapshot(); delete after.providers['t-mc']; delete after.models['t-mc-m']; await save(after.providers, after.models, orig)
  await new Promise(r => up.close(r))
}