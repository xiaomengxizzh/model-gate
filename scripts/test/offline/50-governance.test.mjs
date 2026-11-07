// G1/G3：虚拟模型独立 Key / 配额、/v1/models 能力声明、/api/capabilities 契约、defaults 未知字段保留。
import { startGateway, mockUpstream, check, summary, CLIENT, ADMIN } from './harness.mjs'

const up = await mockUpstream((req, res, body) => {
  const j = JSON.parse(body || '{}')
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ model: j.model, choices: [{ message: { role: 'assistant', content: 'vm-ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }))
})

const gw = await startGateway({
  defaults: { customFlag: true, proxyMode: 'auto' },
  providers: { p1: { baseUrl: up.url, apiKeyEnv: '', api: 'openai' } },
  models: { m1: { provider: 'p1' } },
  virtualModels: [{ name: 'gate-a', directory: [{ model: 'm1', mode: 'afterAll', providers: [] }], quota: 5 }],
})
const call = (model, key, path = '/v1/chat/completions', extra = {}) => fetch(gw.base + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: key === null ? '' : 'Bearer ' + key },
  body: JSON.stringify(Object.assign({ model, messages: [{ role: 'user', content: 'x' }] }, extra)),
})

// 1. 设虚拟模型独立 Key
const ks = await gw.adminFetch('/api/keys', { method: 'POST', body: JSON.stringify({ id: '__mg_vm_gate-a', key: 'vm-key-1' }) })
check('虚拟模型 Key 写入成功', ks.status === 200, { status: ks.status })

// 2. 错误的 Key → 401（不泄露模型是否存在）
const r1 = await call('gate-a', 'global-wrong')
check('虚拟模型错误 Key → 401', r1.status === 401, { status: r1.status })

// 3. 正确虚拟 Key → 200 且路由到目录内模型
const r2 = await call('gate-a', 'vm-key-1')
const j2 = await r2.json()
check('虚拟模型独立 Key 路由成功', r2.status === 200 && j2.choices[0].message.content === 'vm-ok', { status: r2.status })

// 4. 全局 clientKey 仍可用（回归）
const r3 = await call('m1', CLIENT)
check('全局 clientKey 对真实模型仍可用', r3.status === 200, { status: r3.status })

// 5. 虚拟模型配额（首次已消耗 5 tokens，二次应 429）
const r4 = await call('gate-a', 'vm-key-1')
const j4 = await r4.json()
check('虚拟模型额度耗尽 → 429 quota_exceeded', r4.status === 429 && /quota_exceeded|额度/.test(JSON.stringify(j4)), { status: r4.status, body: j4 })

// 6. /v1/models 列出虚拟模型并声明能力
const models = await (await fetch(gw.base + '/v1/models', { headers: { authorization: 'Bearer ' + CLIENT } })).json()
const vm = models.data.find(m => m.id === 'gate-a')
check('/v1/models 列出虚拟模型且含 capabilities', !!vm && vm.capabilities && vm.capabilities.responses === true, { vm })

// 7. /api/capabilities 契约
const capRes = await gw.adminFetch('/api/capabilities')
const cap = await capRes.json()
check('/api/capabilities 返回契约版本与入口', capRes.status === 200 && cap.contract === 'management-api-v1' && Array.isArray(cap.endpoints.responses), { contract: cap.contract })
check('/api/capabilities 不含任何密钥字段', !JSON.stringify(cap).includes(CLIENT) && !JSON.stringify(cap).includes(ADMIN), {})

// 8. defaults 未知字段在部分保存后仍保留
const st = await (await gw.adminFetch('/api/status')).json()
const save = await gw.adminFetch('/api/config/save', { method: 'POST', body: JSON.stringify({ version: st.configVersion, defaults: { proxyMode: 'direct' } }) })
const st2 = await (await gw.adminFetch('/api/status')).json()
check('defaults 未回传字段（customFlag）保存后保留', save.status === 200 && st2.defaults.customFlag === true && st2.defaults.proxyMode === 'direct', { saved: save.status, customFlag: st2.defaults.customFlag, proxyMode: st2.defaults.proxyMode })

await gw.close()
await up.close()
export { summary }
