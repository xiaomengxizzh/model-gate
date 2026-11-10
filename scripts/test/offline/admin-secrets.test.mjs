// MG-016 管理面秘密边界回归：状态/日志/磁盘不得出现明文 Key，Key 只以掩码或布尔位暴露。
// 契约正文见 docs/contracts/management-api-v1.md「敏感字段」一节。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startGateway, startMockUpstream } from './harness.mjs'

const PROVIDER_KEY = 'sk-secret-provider-123456'
const CLIENT_KEY = 'sk-secret-client-654321'
const VM_KEY = 'sk-secret-virtual-999'
const ADMIN_SECRET = 'sk-secret-admin-777'
const SECRETS = [PROVIDER_KEY, CLIENT_KEY, VM_KEY, ADMIN_SECRET]

const STATUS_KEYS = ['needAuth', 'configVersion', 'virtualModels', 'server', 'startedAt', 'uptimeMs', 'counters', 'lastServing', 'global', 'cache', 'dialogues', 'providers', 'models', 'defaults']

test('管理 API：状态、日志与磁盘均不泄露明文凭据', { timeout: 30000 }, async (t) => {
  const upstream = await startMockUpstream()
  const gw = await startGateway({
    name: 'contract-secrets',
    config: {
      providers: { mock: { baseUrl: upstream.base } },
      models: { demo: { provider: 'mock', api: 'openai' } },
      virtualModels: [{ name: 'private', directory: [{ model: 'demo' }] }],
    },
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  // 本地初始化窗口内写入三类凭据：上游 Key、客户端 Key、虚拟模型独立 Key
  assert.equal((await gw.post('/api/keys', { id: 'mock', key: PROVIDER_KEY })).status, 200)
  assert.equal((await gw.post('/api/config/save', { defaults: { clientKey: CLIENT_KEY } })).status, 200)
  assert.equal((await gw.post('/api/keys', { id: '__mg_vm_private', key: VM_KEY })).status, 200)

  const res = await gw.get('/api/status')
  assert.equal(res.status, 200)
  const text = await res.text()
  const status = JSON.parse(text)

  // ① 顶层字段齐备（契约 schema 的前提）
  for (const key of STATUS_KEYS) assert.ok(key in status, 'status 缺少字段 ' + key)

  // ② 明文永不出现；Key 只以 hasKey/keySource/keySet 表达
  for (const secret of SECRETS) assert.ok(!text.includes(secret), '状态快照泄露凭据: ' + secret.slice(0, 12))
  const provider = status.providers.find((p) => p.id === 'mock')
  assert.equal(provider.hasKey, true)
  assert.equal(provider.keySource, 'keys')
  assert.equal('apiKey' in provider, false)
  assert.equal('key' in provider, false)

  // ③ 客户端 Key 以掩码回显；回存掩码不丢 Key
  assert.equal(status.defaults.clientKey, '********')
  assert.equal((await gw.post('/api/config/save', { defaults: { clientKey: '********' } })).status, 200)
  const afterMask = await (await gw.get('/api/status')).json()
  assert.equal(afterMask.defaults.clientKey, '********')

  // ④ 虚拟模型只暴露 keySet，不暴露 Key 本身
  const vm = afterMask.virtualModels.find((v) => v.name === 'private')
  assert.equal(vm.keySet, true)
  assert.equal('key' in vm, false)

  // ⑤ keys.local.json 加密落盘，磁盘上无明文
  const keysFile = await readFile(join(gw.dir, 'keys.local.json'), 'utf8')
  assert.ok(keysFile.trimStart().startsWith('MG1:'), 'keys.local.json 应为 MG1: 密文')
  for (const secret of SECRETS) assert.ok(!keysFile.includes(secret), '磁盘 keys 泄露凭据: ' + secret.slice(0, 12))

  // ⑥ 日志滚动内容不含凭据
  const logs = await (await gw.get('/api/logs?lines=500')).json()
  const logText = logs.lines.join('\n')
  for (const secret of SECRETS) assert.ok(!logText.includes(secret), '日志泄露凭据: ' + secret.slice(0, 12))

  // ⑦ 管理令牌本身不经任何响应回显
  assert.equal((await gw.post('/api/admin-token', { token: ADMIN_SECRET })).status, 200)
  const locked = await gw.get('/api/status', { authorization: 'Bearer ' + ADMIN_SECRET })
  assert.equal(locked.status, 200)
  const lockedText = await locked.text()
  for (const secret of SECRETS) assert.ok(!lockedText.includes(secret), '加锁后的状态快照泄露凭据')
  const authText = await (await gw.get('/api/auth')).text()
  assert.ok(!authText.includes(ADMIN_SECRET), '/api/auth 不得回显令牌')
})
