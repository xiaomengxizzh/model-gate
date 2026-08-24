import http from 'node:http'
import { check, snapshot, save, chat } from './utils.mjs'
let first = true
const up = http.createServer((req, res) => { if (first) { first = false; res.writeHead(429, { 'retry-after': '1' }); res.end('{}'); return } res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}') })
await new Promise(r => up.listen(0, () => r()))
const base = await snapshot(); const orig = JSON.parse(JSON.stringify(base.defaults))
base.providers['t-thr'] = { baseUrl: `http://127.0.0.1:${up.address().port}`, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai' }
base.models['t-thr-m'] = { provider: 't-thr', alias: [], fallbacks: [], maxConcurrent: 0 }
base.defaults = { ...(base.defaults || {}), retry: { maxAttempts: 1, initialDelayMs: 100, maxDelayMs: 200 } }
await save(base.providers, base.models, base.defaults)
const r1 = await chat('t-thr-m'); const t0 = Date.now(); const r2 = await chat('t-thr-m'); const dt = Date.now() - t0
check('429·首请求被拦截', r1.status === 502 || r1.status === 429, { first: r1.status })
check('429·后续请求按 Retry-After 排队', dt >= 850, { waitMs: dt })
check('429·排队后成功', r2.status === 200, { status: r2.status })
const after = await snapshot(); delete after.providers['t-thr']; delete after.models['t-thr-m']; await save(after.providers, after.models, orig)
await new Promise(r => up.close(r))