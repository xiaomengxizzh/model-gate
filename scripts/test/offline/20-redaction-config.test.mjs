// G1：管理面/日志/错误体脱敏、掩码回写保护、configVersion 409 与并发保存。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startGateway, mockUpstream, check, summary, ADMIN } from './harness.mjs'

const SECRET = 'sk-offline-supersecret-123456'
process.env.MOCK_ENV_NAME = 'sk-env-only-key-000111'   // provider 通过环境变量取 Key（不落配置）
const PROXY_PASS = 'proxy-pass-should-not-leak'

const up = await mockUpstream((req, res) => {
  res.writeHead(400, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: { message: 'bad credentials ' + SECRET } }))
})

const gw = await startGateway({
  providers: {
    p1: {
      baseUrl: up.url, apiKeyEnv: 'MOCK_ENV_NAME', api: 'openai',
      extraHeaders: { authorization: 'Bearer ' + SECRET, 'x-custom': 'plainvalue' },
      proxy: 'http://proxyuser:' + PROXY_PASS + '@127.0.0.1:7890',
    },
  },
  models: { 'm-1': { provider: 'p1' } },
})

// 1) /api/status 脱敏
const stRaw = await (await gw.adminFetch('/api/status')).text()
check('status 不含明文密钥', !stRaw.includes(SECRET), { leaked: stRaw.includes(SECRET) })
check('status 不含代理密码', !stRaw.includes(PROXY_PASS), { leaked: stRaw.includes(PROXY_PASS) })
const st = JSON.parse(stRaw)
const p1 = st.providers.find(p => p.id === 'p1')
check('敏感头值掩码为 ****', p1.extraHeaders.authorization === '****', { v: p1.extraHeaders.authorization })
check('非敏感头保留原值', p1.extraHeaders['x-custom'] === 'plainvalue', { v: p1.extraHeaders['x-custom'] })
check('代理 userinfo 掩码、host:port 保留', p1.proxy.includes('****') && p1.proxy.includes('127.0.0.1:7890'), { proxy: p1.proxy })
check('apiKeyEnv 仅暴露变量名', p1.apiKeyEnv === 'MOCK_ENV_NAME', { v: p1.apiKeyEnv })

// 2) 掩码回写：保存后盘上仍是真实值
const ver = st.configVersion
const saveBody = { version: ver, providers: st.providers.reduce((a, p) => { a[p.id] = { baseUrl: p.baseUrl, apiKeyEnv: p.apiKeyEnv, api: p.api, extraHeaders: p.extraHeaders, proxy: p.proxy }; return a }, {}), models: { 'm-1': { provider: 'p1' } }, defaults: st.defaults }
const saveRes = await gw.adminFetch('/api/config/save', { method: 'POST', body: JSON.stringify(saveBody) })
const saveJson = await saveRes.json()
check('掩码保存成功并推进版本', saveRes.status === 200 && saveJson.status.configVersion === ver + 1, { status: saveRes.status, cv: saveJson.status && saveJson.status.configVersion })
const onDisk = JSON.parse(readFileSync(join(gw.dir, 'gateway.local.json'), 'utf8'))
check('掩码未被写成真实配置值', onDisk.providers.p1.extraHeaders.authorization === 'Bearer ' + SECRET, { v: onDisk.providers.p1.extraHeaders.authorization })
check('代理密码未被掩码覆盖', onDisk.providers.p1.proxy.includes(PROXY_PASS), { v: onDisk.providers.p1.proxy })

// 3) 并发保存：同一版本号只允许一个成功，另一个 409
const status2 = await (await gw.adminFetch('/api/status')).json()
const provs2 = {}; for (const p of status2.providers) provs2[p.id] = { baseUrl: p.baseUrl, apiKeyEnv: p.apiKeyEnv, api: p.api, extraHeaders: p.extraHeaders, proxy: p.proxy }
const mods2 = {}; for (const m of status2.models) mods2[m.name] = { provider: m.provider, alias: m.alias, fallbacks: m.fallbacks }
const bodyBase = { version: status2.configVersion, providers: provs2, models: mods2, defaults: status2.defaults }
const [a, b] = await Promise.all([
  gw.adminFetch('/api/config/save', { method: 'POST', body: JSON.stringify(bodyBase) }),
  gw.adminFetch('/api/config/save', { method: 'POST', body: JSON.stringify(bodyBase) }),
])
const codes = [a.status, b.status].sort()
check('并发同版本保存：一个 200 + 一个 409', codes[0] === 200 && codes[1] === 409, { codes })
const conflict = a.status === 409 ? await a.json() : await b.json()
check('409 返回 currentVersion 供自愈', typeof conflict.currentVersion === 'number', { conflict })

// 4) 上游 4xx 回显脱敏
const r = await gw.chat({ model: 'm-1', messages: [{ role: 'user', content: 'x' }] })
const rb = await r.text()
check('错误体回显已脱敏', r.status === 400 && !rb.includes(SECRET) && /bad credentials/.test(rb), { status: r.status, hasSecret: rb.includes(SECRET), body: rb.slice(0, 300) })

// 5) Key 入库：状态只报 hasKey，不泄明文；落盘加密
const kr = await gw.adminFetch('/api/keys', { method: 'POST', body: JSON.stringify({ id: 'p1', key: 'sk-live-provider-key-98765' }) })
const ks = await kr.json()
check('/api/keys 保存成功且 status 无明文', kr.status === 200 && !JSON.stringify(ks).includes('sk-live-provider-key-98765'), { status: kr.status })
const keysOnDisk = readFileSync(join(gw.dir, 'keys.local.json'), 'utf8')
check('keys.local.json 加密落盘（MG1:）', keysOnDisk.trimStart().startsWith('MG1:') && !keysOnDisk.includes('sk-live-provider-key-98765'), { prefix: keysOnDisk.slice(0, 4) })

// 6) 日志不落密钥
const logs = await (await gw.adminFetch('/api/logs?lines=500')).json()
check('日志中无明文密钥', !JSON.stringify(logs).includes(SECRET) && !JSON.stringify(logs).includes('sk-live-provider-key-98765'), { lines: (logs.lines || []).length })

await gw.close()
await up.close()
export { summary }
