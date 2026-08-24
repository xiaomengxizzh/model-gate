import { GW, check, snapshot, save, chat } from './utils.mjs'
// 空 model 且未设默认上游 → 显式 400
const base = await snapshot(); const orig = JSON.parse(JSON.stringify(base.defaults))
const wasNull = base.defaults.provider ? base.defaults.provider : null
base.defaults = { ...base.defaults, provider: null }
await save(base.providers, base.models, base.defaults)
const r = await fetch(GW + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) })
const tx = await r.text()
check('空 model·显式 400(missing_model)', r.status === 400 && tx.includes('missing_model'), { status: r.status })
// 恢复
const after = await snapshot(); after.defaults = orig; await save(after.providers, after.models, orig)