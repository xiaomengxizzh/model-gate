import http from 'node:http'
import { GW, check, snapshot, save, chat } from './utils.mjs'
// model QPS 令牌桶：qps=2 + 5 个顺序请求 → 缺令牌的请求须排队，总耗时被拉伸
const up = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}') })
await new Promise(r => up.listen(0, () => r()))
const base = await snapshot(); const orig = JSON.parse(JSON.stringify(base.defaults))
base.providers['t-q'] = { baseUrl: `http://127.0.0.1:${up.address().port}`, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai' }
base.models['t-q-m'] = { provider: 't-q', alias: [], fallbacks: [], maxConcurrent: 0, qps: 2 }
base.defaults = { ...(base.defaults || {}), concurrency: { maxPerProvider: 100 }, retry: { maxAttempts: 1, initialDelayMs: 50, maxDelayMs: 100 } }
await save(base.providers, base.models, base.defaults)
const s1 = await (await fetch(GW + '/api/status')).json()
check('model QPS·字段已存储', (s1.models.find(m => m.name === 't-q-m') || {}).qps === 2, { qps: (s1.models.find(m => m.name === 't-q-m') || {}).qps })
const t0 = Date.now()
const got = []
for (let i = 0; i < 5; i++) got.push((await chat('t-q-m')).status)
const dt = Date.now() - t0
check('model QPS·qps=2 时 5 顺序请求被限速', got.every(x => x === 200) && dt >= 600, { elapsedMs: dt, statuses: got })
const after = await snapshot(); delete after.providers['t-q']; delete after.models['t-q-m']; await save(after.providers, after.models, orig)
await new Promise(r => up.close(r))