import http from 'node:http'
import { GW, check, snapshot, save, chat } from './utils.mjs'
// 每模型天级 token/缓存统计：上游返回带缓存的 usage → /api/model-stats 聚合正确
const up = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { total_tokens: 100, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20 } })) })
await new Promise(r => up.listen(0, () => r()))
const base = await snapshot(); const orig = JSON.parse(JSON.stringify(base.defaults))
base.providers['t-ms'] = { baseUrl: `http://127.0.0.1:${up.address().port}`, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai' }
base.models['t-ms-m'] = { provider: 't-ms', alias: [], fallbacks: [], maxConcurrent: 0 }
await save(base.providers, base.models, base.defaults)
const r1 = await chat('t-ms-m')
check('modelstats·上游响应成功', r1.status === 200, { status: r1.status })
const st = await (await fetch(GW + '/api/model-stats?days=1')).json()
const arr = (st.models['t-ms-m']) || []
const today = arr[arr.length - 1]
check('modelstats·天级 token 聚合', today && today.tokens >= 100, { tokens: today && today.tokens })
check('modelstats·缓存命中率(hit/miss)', today && today.hitRate != null && today.hitRate >= 79 && today.hitRate <= 81, { hitRate: today && today.hitRate })
const after = await snapshot(); delete after.providers['t-ms']; delete after.models['t-ms-m']; await save(after.providers, after.models, orig)
await new Promise(r => up.close(r))