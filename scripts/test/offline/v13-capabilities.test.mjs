import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCapabilities } from '../../../src/capabilities.js'

function fixture() {
  return {
    cfg: {
      configVersion: 7,
      providers: {
        mock: { baseUrl: 'https://user:password@example.test/v1?token=secret', api: 'openai', extraHeaders: { authorization: 'Bearer header-secret' }, proxy: 'http://proxy-user:proxy-pass@example.test' },
      },
      models: { demo: { provider: 'mock', alias: ['alias-demo'], capability: 'chat' } },
      virtualModels: [{ name: 'daily', directory: [{ model: 'demo', mode: 'onFail', providers: ['mock'] }], maxContext: 8192 }],
      defaults: { retry: { maxAttempts: 3 }, timeout: { overallMs: 0 } },
      _keys: { mock: 'stored-secret' },
    },
    st: { startedAt: 123 },
    health: { mock: { state: 'open', openUntil: 500 } },
  }
}

test('capabilities：固定六项导航、稳定资源投影与能力诚实性', () => {
  const out = buildCapabilities(fixture(), { now: 1000, commitSha: 'test-sha', nodeVersion: 'v24.test' })
  assert.equal(out.contract, 'mg-capabilities/1')
  assert.deepEqual(out.navigation.primary.map((item) => item.label), ['应用接入', '模型服务', '模型池', '用量分析', '稳定性策略', '设置'])
  assert.equal(out.services[0].label, 'mock')
  assert.equal(out.services[0].credential, 'configured')
  assert.equal(out.services[0].health, 'half')
  assert.equal(out.services[0].baseUrl, 'https://example.test/v1')
  assert.equal(out.models[0].serviceId, 'mock')
  assert.equal(out.pools[0].candidates[0].model, 'demo')
  assert.equal(out.features.find((item) => item.id === 'named-pools').available, true)
  assert.equal(out.features.find((item) => item.id === 'native-compaction').evidence, 'protocol-boundary-only; real-verification-blocked')
})

test('capabilities：响应不包含 Key、认证头、代理凭据、URL 查询或文件路径', () => {
  const text = JSON.stringify(buildCapabilities(fixture(), { now: 1000, commitSha: null }))
  for (const secret of ['stored-secret', 'header-secret', 'Bearer header-secret', 'proxy-pass', 'proxy-user', 'password', 'token=secret']) assert.equal(text.includes(secret), false, secret)
  assert.equal(text.includes('extraHeaders'), false)
  assert.equal(text.includes('proxy'), false)
})

test('capabilities：空配置显示空集合而不是虚假运行成功', () => {
  const out = buildCapabilities({ cfg: { providers: {}, models: {}, virtualModels: [], defaults: {} }, st: { startedAt: 1 }, health: {} }, { now: 1, commitSha: null })
  assert.deepEqual(out.services, [])
  assert.deepEqual(out.models, [])
  assert.deepEqual(out.pools, [])
  assert.equal(out.aggregation.mode, 'unknown')
  assert.equal(out.ui.writeOperations, false)
})
