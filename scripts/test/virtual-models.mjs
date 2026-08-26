// Phase 1 虚拟模型全矩阵集成测试（自包含：自起 mock 上游 + 隔离网关实例，零外部依赖、零真实上游消耗）
// 覆盖：configVersion 409/并发唯一成功、虚拟模型路由/404/额度/档位补校验、两阶段鉴权、删模型清 key
import { check, count } from './utils.mjs'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..', '..')
const TMP = path.join(ROOT, '.tmp-test-vm')
const PORT = 8795
const BASE = 'http://127.0.0.1:' + PORT
const ADMIN = { 'Authorization': 'Bearer devtoken', 'Content-Type': 'application/json' }
const CH = { 'Authorization': 'Bearer testkey123', 'Content-Type': 'application/json' }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// —— mock 上游：立即 200 + usage（供额度/记账断言）——
const mock = http.createServer((req, res) => {
  let b = ''; req.on('data', d => b += d); req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'm1', object: 'chat.completion', model: 'm-mock', choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }))
  })
})
await new Promise(r => mock.listen(9897, r))

// —— 隔离配置：mock provider/model + 两个虚拟模型（目录区分）——
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })
const gatewayCfg = {
  server: { host: '127.0.0.1', port: PORT },
  defaults: { provider: 'p-mock', model: 'gatemodel', clientKey: '', directory: [{ model: 'm-mock', mode: 'afterAll', providers: [] }], retry: { maxAttempts: 1 }, timeout: { connectMs: 3000, firstByteMs: 5000, idleMs: 5000 } },
  providers: { 'p-mock': { baseUrl: 'http://127.0.0.1:9897', apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai' } },
  models: { 'm-mock': { provider: 'p-mock', alias: [], fallbacks: [], maxConcurrent: 0, qps: 0, reasoning: '', effortOptions: [], dailyQuota: 0, quota: 0, maxContext: 0 } },
  virtualModels: [
    { name: 'gate-a', directory: [{ model: 'm-mock', mode: 'afterAll', providers: [] }] },
    { name: 'gate-b', directory: [{ model: 'm-mock', mode: 'afterAll', providers: [] }] },
  ],
}
fs.writeFileSync(path.join(TMP, 'gateway.json'), JSON.stringify(gatewayCfg, null, 2))

// —— 起网关子进程（隔离目录 + 测试凭据）——
const child = spawn(process.execPath, ['src/index.js'], {
  cwd: ROOT,
  env: { ...process.env, MG_CONFIG_DIR: TMP, MG_CONFIG: path.join(TMP, 'gateway.json'), MG_CLIENT_KEY: 'testkey123', MG_ADMIN_TOKEN: 'devtoken', MG_SILENT: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let ready = false
for (let i = 0; i < 40 && !ready; i++) { try { ready = (await fetch(BASE + '/healthz')).ok } catch {} ; if (!ready) await sleep(250) }

const j = async r => ({ code: r.status, ...(await r.json().catch(() => ({}))) })
const status = () => fetch(BASE + '/api/status', { headers: ADMIN }).then(j)
const save = (body) => fetch(BASE + '/api/config/save', { method: 'POST', headers: ADMIN, body: JSON.stringify(body) }).then(j)
const saveKey = (body) => fetch(BASE + '/api/keys', { method: 'POST', headers: ADMIN, body: JSON.stringify(body) }).then(j)
const chat = async (model, key, extra) => { const r = await fetch(BASE + '/v1/chat/completions', { method: 'POST', headers: { 'Authorization': 'Bearer ' + (key === undefined ? 'testkey123' : key), 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 5, ...(extra || {}) }) }); const d = await r.json().catch(() => ({})); if (r.status >= 500) console.log('  [502 body]', JSON.stringify(d).slice(0, 200)); return { code: r.status, ...d } }
const snap = (s) => ({ providers: Object.fromEntries(s.providers.map(p => [p.id, { baseUrl: p.baseUrl, apiKeyEnv: p.apiKeyEnv || '', pathPrefix: p.pathPrefix || '', extraHeaders: {}, api: p.api || 'openai' }])), models: Object.fromEntries(s.models.map(m => [m.name, { provider: m.provider, alias: [], fallbacks: [], maxConcurrent: 0, qps: 0, reasoning: '', effortOptions: m.effortOptions || [], dailyQuota: 0, quota: 0, maxContext: 0 }])), defaults: s.defaults, virtualModels: (s.virtualModels || []).map(v => ({ name: v.name, directory: v.directory, quota: v.quota, dailyQuota: v.dailyQuota, maxContext: v.maxContext, maxConcurrent: v.maxConcurrent, qps: v.qps, expiresAt: v.expiresAt || '', note: v.note || '' })) })

try {
if (!ready) {
  check('网关实例启动', false, 'healthz 超时')
} else {
  // —— Step1：configVersion ——
  let s = await status()
  check('status 暴露 configVersion', typeof s.configVersion === 'number')
  let cur = s.configVersion
  let r = await save({ ...snap(s) })
  check('缺 version 宽容放行且递增', r.code === 200 && r.status.configVersion === cur + 1)
  cur = r.status.configVersion
  r = await save({ ...snap(await status()), version: cur - 1 })
  check('过期 version 409', r.code === 409 && r.currentVersion === cur)
  const same = { ...snap(await status()), version: cur }
  const results = await Promise.all(Array.from({ length: 5 }, () => save(same)))
  check('并发 5 同 version 恰 1 成功', results.filter(x => x.code === 200).length === 1 && results.filter(x => x.code === 409).length === 4)

  // —— Step2/3：聚合/试算/路由/404/回归 ——
  s = await status()
  const ids = (await fetch(BASE + '/v1/models', { headers: CH }).then(j)).data.map(m => m.id)
  check('/v1/models 聚合虚拟模型', ids.includes('gate-a') && ids.includes('gate-b'))
  r = await fetch(BASE + '/api/route-preview', { method: 'POST', headers: ADMIN, body: JSON.stringify({ model: 'gate-a' }) }).then(j)
  check('route-preview 命中虚拟模型', r.hit?.type === 'virtual' && r.hit.name === 'gate-a')
  r = await chat('gate-a')
  check('gate-a 路由 200 且 model 回写', r.code === 200 && r.model === 'gate-a', JSON.stringify({ code: r.code, model: r.model, keys: Object.keys(r) }))
  r = await chat('no-such-model')
  check('未知名 404（已配置虚拟模型）', r.code === 404 && r.error?.type === 'unknown_model')
  r = await chat('gatemodel')
  check('gatemodel 旧入口回归', r.code === 200)
  r = await save({ ...snap(await status()), virtualModels: [{ name: 'm-mock', directory: [{ model: 'm-mock', mode: 'afterAll', providers: [] }] }] })
  check('虚拟名与真实模型冲突 400', r.code === 400 && /冲突/.test(r.error || ''))

  // —— 额度 + 档位补校验（额度断言后恢复 dailyQuota=0，避免污染后续用例）——
  let cfg = snap(await status())
  cfg.virtualModels = cfg.virtualModels.map(v => v.name === 'gate-a' ? { ...v, dailyQuota: 1 } : v)
  r = await save(cfg)
  r = await chat('gate-a')
  check('虚拟模型日额度超限 429', r.code === 429 && /额度/.test(r.error?.message || ''), 'code=' + r.code)
  cfg = snap(await status())
  cfg.virtualModels = cfg.virtualModels.map(v => v.name === 'gate-a' ? { ...v, dailyQuota: 0 } : v)
  cfg.models['m-mock'].effortOptions = ['low']
  await save(cfg)
  r = await chat('gate-a', undefined, { reasoning_effort: 'high' })
  check('链首真实模型档位补校验 400（先于额度）', r.code === 400 && /reasoning_effort/.test(r.error?.message || ''), 'code=' + r.code)
  cfg = snap(await status())
  cfg.models['m-mock'].effortOptions = []
  await save(cfg)

  // —— Step4：两阶段鉴权 ——
  const K1 = 'sk-vm-gate-a-test'
  await saveKey({ id: '__mg_vm_gate-a', key: K1 })
  r = await chat('gate-a', K1, { reasoning_effort: 'low' })
  check('gate-a+正确独立 key → 200', r.code === 200, 'code=' + r.code)
  r = await chat('gate-a', 'sk-wrong')
  check('gate-a+错 key → 401', r.code === 401)
  r = await chat('no-such', 'sk-anything')
  check('未知名+任意 key → 401 统一文案（防枚举）', r.code === 401 && r.error?.message === '无效的客户端接入 Key（状态 401）')
  r = await chat('gate-a', 'testkey123')
  check('全局 key 超级语义放行', r.code === 200)

  // —— Step5：删模型同步清 key ——
  const { pathToFileURL } = await import('node:url')
  const { readKeysFresh } = await import(pathToFileURL(path.join(ROOT, 'src', 'router.js')).href)
  await saveKey({ id: '__mg_vm_gate-b', key: 'sk-vm-gate-b-test' })
  const hadB = !!readKeysFresh(path.join(TMP, 'keys.local.json'))['__mg_vm_gate-b']
  cfg = snap(await status())
  cfg.virtualModels = cfg.virtualModels.filter(v => v.name !== 'gate-b')
  r = await save(cfg)
  check('删除虚拟模型同步清 key', r.code === 200 && hadB && !('__mg_vm_gate-b' in readKeysFresh(path.join(TMP, 'keys.local.json'))))
  s = await status()
  check('status 暴露虚拟模型 meta', (s.virtualModels || []).every(v => 'expiresAt' in v && 'note' in v && 'keySet' in v))
}
} finally {
  try { child.kill() } catch {}
  try { mock.close() } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
}
const c = count()
console.log('  （virtual-models 子结果: ' + c.pass + '/' + c.total + '）')
if (c.fail) throw new Error('virtual-models 有 ' + c.fail + ' 项失败')
