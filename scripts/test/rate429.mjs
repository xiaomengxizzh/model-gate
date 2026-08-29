import http from 'node:http'
import { check, snapshot, save, chat } from './utils.mjs'
let hits = 0
const up = http.createServer((req, res) => { hits++; if (hits === 1) { res.writeHead(429, { 'retry-after': '1' }); res.end('{}'); return } res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}') })
await new Promise(r => up.listen(0, () => r()))
const base = await snapshot(); const orig = JSON.parse(JSON.stringify(base.defaults))
base.providers['t-thr'] = { baseUrl: `http://127.0.0.1:${up.address().port}`, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai' }
base.models['t-thr-m'] = { provider: 't-thr', alias: [], fallbacks: [], maxConcurrent: 0 }
base.defaults = { ...(base.defaults || {}), retry: { maxAttempts: 1, initialDelayMs: 100, maxDelayMs: 200 } }
await save(base.providers, base.models, base.defaults)
// 0.2.0 循环兜底后，429 对客户端透明：首请求在网关内按 Retry-After 排队并重发上游，最终 200。
const t0 = Date.now(); const r1 = await chat('t-thr-m'); const dt1 = Date.now() - t0
check('429·首请求按 Retry-After 内部排队后成功(循环兜底)', r1.status === 200 && dt1 >= 850 && hits === 2, { status: r1.status, ms: dt1, hits })
const t1 = Date.now(); const r2 = await chat('t-thr-m'); const dt2 = Date.now() - t1
check('429·后续请求不再等待(冷却已过)', r2.status === 200 && dt2 < 850, { ms: dt2 })
const after = await snapshot(); delete after.providers['t-thr']; delete after.models['t-thr-m']; await save(after.providers, after.models, orig)
await new Promise(r => up.close(r))