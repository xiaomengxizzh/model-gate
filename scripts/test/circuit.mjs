import http from 'node:http'
import { GW, check, snapshot, save, chat } from './utils.mjs'
// 熔断参数可配：circuit.maxFailures=2 → 2 次失败即为 open
const up = http.createServer((req, res) => { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"busy"}') })
await new Promise(r => up.listen(0, () => r()))
const base = await snapshot(); const orig = JSON.parse(JSON.stringify(base.defaults))
base.providers['t-c'] = { baseUrl: `http://127.0.0.1:${up.address().port}`, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai', circuit: { maxFailures: 2, openDurationMs: 3000 } }
base.models['t-c-m'] = { provider: 't-c', alias: [], fallbacks: [], maxConcurrent: 0 }
base.defaults = { ...(base.defaults || {}), retry: { maxAttempts: 1, initialDelayMs: 50, maxDelayMs: 100 } }
await save(base.providers, base.models, base.defaults)
for (let i = 0; i < 3; i++) await chat('t-c-m')
const st = await (await fetch(GW + '/api/status')).json()
const h = st.providers.find(p => p.id === 't-c')
check('熔断·连续失败数=2 即 open', h.st.state === 'open' || h.st.openUntilMs > 0, { state: h.st.state, openUntilMs: h.st.openUntilMs })
const after = await snapshot(); delete after.providers['t-c']; delete after.models['t-c-m']; await save(after.providers, after.models, orig)
await new Promise(r => up.close(r))