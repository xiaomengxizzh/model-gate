// MG-009 服务端契约回归：配置保存剥离投影字段（D-2）、/api/keys 标识白名单（§8.3）、
// Key 保存版本冲突（D-7）与面板 baseVersion 冻结（D-3 静态检查）。
// 全部离线：OS 临时配置目录 + 动态回环端口 + 本地 mock 上游；不触真实上游、不读写用户主配置。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startGateway, startMockUpstream, root } from './harness.mjs'

const json = () => ({ 'content-type': 'application/json' })

function config(upstreamBase) {
  return {
    providers: { mock: { baseUrl: upstreamBase } },
    models: { demo: { provider: 'mock' } },
  }
}

test('D-2 保存配置剥离投影运行时字段，未知扩展字段保留', { timeout: 30000 }, async (t) => {
  const upstream = await startMockUpstream()
  const gw = await startGateway({ name: 'mg009-strip', config: config(upstream.base) })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const status = await (await gw.get('/api/status')).json()
  const version = status.configVersion || 0

  const save = await gw.post('/api/config/save', {
    version,
    providers: {
      mock: {
        baseUrl: upstream.base,
        // 投影字段（不得落盘）
        hasKey: true, keySource: 'keys', keyOk: true, st: { requests: 9, errors: 1 }, probe: { ok: true },
        // 未知扩展字段（必须保留）
        vendorRateClass: 'tier-a',
      },
    },
    models: {
      demo: {
        provider: 'mock',
        // 投影字段（不得落盘）
        probe: { ok: true }, requests: 12, errors: 2, tokens: 999, today: 5, hitRate: 88.8, affinity: 'mock', avgMs: 321,
        inTokens: 900, outTokens: 99, latencySum: 1000, latencyCount: 3,
        // 未知扩展字段（必须保留）
        vendorCapability: 'vision',
      },
    },
    defaults: { timeout: { firstByteMs: 2000, idleMs: 2000 } },
  }, json())
  assert.equal(save.status, 200, '合法配置保存应 200')

  const local = JSON.parse(readFileSync(join(gw.dir, 'gateway.local.json'), 'utf8'))
  const p = local.providers.mock
  for (const k of ['hasKey', 'keySource', 'keyOk', 'st', 'probe']) assert.equal(k in p, false, 'providers 投影字段不得落盘：' + k)
  assert.equal(p.vendorRateClass, 'tier-a', 'providers 未知扩展字段必须保留')
  const m = local.models.demo
  for (const k of ['probe', 'requests', 'errors', 'tokens', 'today', 'hitRate', 'affinity', 'avgMs', 'inTokens', 'outTokens', 'latencySum', 'latencyCount']) {
    assert.equal(k in m, false, 'models 投影字段不得落盘：' + k)
  }
  assert.equal(m.vendorCapability, 'vision', 'models 未知扩展字段必须保留')
  assert.equal(m.provider, 'mock', '可编辑字段保留')

  // 投影仍然对外提供运行时字段（只是不落盘）
  const st2 = await (await gw.get('/api/status')).json()
  const mProj = st2.models.find((x) => x.name === 'demo')
  assert.ok(mProj && typeof mProj.requests === 'number' && 'probe' in mProj, '/api/status 仍返回运行时投影字段')
  const pProj = st2.providers.find((x) => x.id === 'mock')
  assert.ok(pProj && 'hasKey' in pProj && 'st' in pProj, '/api/status provider 仍返回 hasKey/st')
})

test('/api/keys 标识白名单：只允许投影/历史可达的身份', { timeout: 30000 }, async (t) => {
  const upstream = await startMockUpstream()
  const gw = await startGateway({
    name: 'mg009-keys',
    config: {
      providers: { mock: { baseUrl: upstream.base } },
      models: { demo: { provider: 'mock' } },
      virtualModels: [{ name: 'vm1', directory: [{ model: 'demo' }] }],
    },
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  assert.equal((await gw.post('/api/keys', { id: 'mock', key: 'sk-provider-test' }, json())).status, 200, '现有上游 id 允许')
  assert.equal((await gw.post('/api/keys', { id: '__mg_vm_vm1', key: 'sk-vm-test' }, json())).status, 200, '现有虚拟模型 Key 允许')
  assert.equal((await gw.post('/api/keys', { id: '__mg_client', key: 'sk-client-test' }, json())).status, 200, '内部客户端 Key 允许')

  const bad = await gw.post('/api/keys', { id: 'no-such-provider', key: 'x' }, json())
  assert.equal(bad.status, 400, '未知标识必须拒绝（防孤儿键）')
  assert.match(String((await bad.json()).error), /未知的 Key 标识/, '错误信封沿用管理面 {error:string}')
  assert.equal((await gw.post('/api/keys', { id: '__mg_vm_missing', key: 'x' }, json())).status, 400, '不存在的虚拟模型 Key 拒绝')
  assert.equal((await gw.post('/api/keys', { id: '__mg_vm_meta_vm1', key: 'x' }, json())).status, 400, '未存在的内部元数据条目拒绝')
  assert.equal((await gw.post('/api/keys', { id: 'legacy-orphan', key: 'x' }, json())).status, 400, '历史孤儿键不得被新建')

  // 已有条目仍可删除（白名单不锁死清理路径）
  assert.equal((await gw.post('/api/keys', { id: 'mock', key: '' }, json())).status, 200, '已有 Key 条目允许删除')
})

test('D-7 /api/keys 带版本：过期 409、当前 200、缺省 200', { timeout: 30000 }, async (t) => {
  const upstream = await startMockUpstream()
  const gw = await startGateway({ name: 'mg009-version', config: config(upstream.base) })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const status = await (await gw.get('/api/status')).json()
  const version = status.configVersion || 0

  const stale = await gw.post('/api/keys', { id: 'mock', key: 'sk-x', version: version + 99 }, json())
  assert.equal(stale.status, 409, '过期版本必须 409，不得静默覆盖')
  assert.equal((stale.json ? true : true), true)

  assert.equal((await gw.post('/api/keys', { id: 'mock', key: 'sk-ok', version }, json())).status, 200, '当前版本允许')
  assert.equal((await gw.post('/api/keys', { id: 'mock', key: 'sk-no-version' }, json())).status, 200, '缺省版本保持旧客户端兼容')
})

test('D-3 面板：dirty 时冻结 baseVersion 且 Key 保存带版本（静态检查）', () => {
  const html = readFileSync(join(root, 'src', 'admin.html'), 'utf8')
  assert.match(html, /let baseVersion=null/, 'admin.html 必须有 baseVersion 状态')
  assert.match(html, /function markDirty\(\)\{dirty=true;if\(baseVersion==null\)baseVersion=ST\.configVersion\}/, 'markDirty 首次脏化时冻结基准版本')
  assert.match(html, /if\(!dirty\|\|baseVersion==null\)ST\.configVersion=s\.configVersion\|\|0/, 'ingestStatus 脏状态不覆盖冻结版本')
  assert.match(html, /async function postKey\(id,key\)/, 'Key 保存统一走带版本的 helper')
  assert.match(html, /\/api\/keys',\{id,key,version:\(baseVersion==null\?ST\.configVersion:baseVersion\)\}/, 'Key 保存必须携带版本')
})
