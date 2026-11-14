// MG-009 余项：D-6 只读配置投影 GET /api/config；D-1 面板未知字段不透明袋（静态检查）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startGateway, root } from './harness.mjs'

const json = () => ({ 'content-type': 'application/json' })

test('GET /api/config：只读配置投影（无运行时字段/无明文 Key，扩展字段保留）', { timeout: 30000 }, async (t) => {
  const cfg = {
    providers: { mock: { baseUrl: 'http://127.0.0.1:1', vendorRateClass: 'tier-a' } },
    models: { demo: { provider: 'mock', vendorCapability: 'vision', capability: 'chat' } },
    defaults: { clientKey: 'legacy-secret', vendorDefault: 'x' },
    virtualModels: [],
  }
  const gw = await startGateway({ name: 'mg009-cfg', config: cfg })
  t.after(() => gw.stop())
  const res = await gw.get('/api/config')
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.ok(Number.isInteger(body.configVersion), '带 configVersion 作为并发令牌')
  assert.equal(body.providers.mock.baseUrl, 'http://127.0.0.1:1')
  assert.equal(body.providers.mock.vendorRateClass, 'tier-a', 'providers 扩展字段保留')
  for (const k of ['hasKey', 'keySource', 'keyOk', 'st', 'probe']) assert.equal(k in body.providers.mock, false, '无 provider 运行时字段：' + k)
  assert.equal(body.models.demo.vendorCapability, 'vision', 'models 扩展字段保留')
  for (const k of ['probe', 'requests', 'errors', 'tokens', 'today', 'hitRate', 'affinity', 'avgMs']) assert.equal(k in body.models.demo, false, '无 model 运行时字段：' + k)
  assert.equal(body.defaults.clientKey, '********', 'clientKey 掩码，不返回明文')
  assert.equal(body.defaults.vendorDefault, 'x', 'defaults 扩展字段保留')
  assert.equal('_keys' in body, false, '不返回 keys 内存');
  assert.equal('_paths' in body, false, '不返回内部路径')
})

test('GET /api/config 需要管理鉴权；投影可直接用于保存并保留扩展字段', { timeout: 30000 }, async (t) => {
  const gw = await startGateway({
    name: 'mg009-cfgauth',
    env: { MG_ADMIN_TOKEN: 'admin-tok' },
    config: { providers: { mock: { baseUrl: 'http://127.0.0.1:1', vendorRateClass: 'tier-a' } }, models: { demo: { provider: 'mock', vendorCapability: 'vision' } } },
  })
  t.after(() => gw.stop())
  assert.equal((await gw.get('/api/config')).status, 401, '无令牌 401')
  const auth = { authorization: 'Bearer admin-tok' }
  const proj = await (await gw.get('/api/config', auth)).json()
  assert.equal(proj.providers.mock.vendorRateClass, 'tier-a')
  const save = await gw.post('/api/config/save', Object.assign({}, proj, { version: proj.configVersion }), Object.assign({ 'content-type': 'application/json' }, auth))
  assert.equal(save.status, 200, '投影可直接保存（含未知字段）')
  const again = await (await gw.get('/api/config', auth)).json()
  assert.equal(again.providers.mock.vendorRateClass, 'tier-a', '保存后扩展字段仍在')
  assert.equal(again.models.demo.vendorCapability, 'vision', '保存后模型扩展字段仍在')
})

test('D-1：面板使用 _extra 不透明袋并在保存时合并（静态检查）', () => {
  const html = readFileSync(join(root, 'src', 'admin.html'), 'utf8')
  assert.match(html, /function extraOf\(obj,known,drop\)/, '提供未知字段提取')
  assert.match(html, /function serializeMap\(m\)/, '提供保存序列化')
  assert.match(html, /providers:serializeMap\(C\.providers\)/, 'saveAll 使用序列化后的 providers')
  assert.match(html, /models:serializeMap\(C\.models\)/, 'saveAll 使用序列化后的 models')
  assert.match(html, /_extra:extraOf\(p,_PROVIDER_KEYS/, 'providers 构建保留未知字段')
  assert.match(html, /_extra:extraOf\(m,_MODEL_KEYS/, 'models 构建保留未知字段')
})
