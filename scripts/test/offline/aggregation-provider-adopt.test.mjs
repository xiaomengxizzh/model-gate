// 接管既有 Go 上游（adopt）：把聚合元数据补进已存在的非聚合 provider，不新建第二套凭据。
//
// 背景：真实用户机上常见 V1 时代的 providers.opencodego（apiKeyEnv + 模型已指向它）。
// 聚合注册表要求 id 固定为段名 opencodego，直接 add 会 409 provider_id_in_use，
// 导致"向导一上来就失败"。adopt 只补元数据，保留 baseUrl/api/apiKeyEnv 与既有模型绑定。
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { createRegistry } from '../../../src/aggregation/registry.js'
import { makeRegistryStore } from '../fixtures/agg-a2/helpers.mjs'

const GO_BASE = 'https://opencode.ai/inference/go'

function storeWithLegacy (overrides = {}) {
  const store = makeRegistryStore()
  const legacy = Object.assign({
    baseUrl: GO_BASE,
    api: 'openai',
    apiKeyEnv: 'OPENCODE_API_KEY',
  }, overrides)
  writeFileSync(store.gatewayPath, JSON.stringify({
    providers: { opencodego: legacy },
    models: { 'deepseek-v4.1-flash': { provider: 'opencodego', api: 'openai', alias: [] } },
    defaults: {},
    virtualModels: [],
  }))
  return store
}

test('adopt：接管既有 Go 上游，保留 baseUrl/apiKeyEnv 与模型，只补聚合元数据', () => {
  const store = storeWithLegacy()
  const registry = createRegistry({ paths: store.paths, readConfig: store.readConfig })
  assert.deepEqual(registry.listProviders(), [], '接管前：既有上游不是聚合 Provider')

  // 未声明 adopt 时仍必须明确拒绝（不静默接管）。
  assert.throws(() => registry.addProvider({ preset: 'opencode-go', version: 0 }),
    (err) => err.code === 'provider_id_in_use')

  const adopted = registry.addProvider({ preset: 'opencode-go', adopt: true, version: 0 })
  assert.equal(adopted.id, 'opencodego')
  assert.equal(adopted.adopted, true)
  assert.equal(adopted.kind, 'opencode-go')
  assert.equal(adopted.baseUrl, GO_BASE, 'baseUrl 保持用户既有值，不被 preset 覆盖')
  assert.equal(adopted.apiKeyEnv, 'OPENCODE_API_KEY')
  assert.equal(adopted.keyRef, 'env:OPENCODE_API_KEY', '凭据引用沿用既有 apiKeyEnv')
  assert.equal(adopted.v2Scope, 'go-single-model')
  assert.equal(registry.listProviders().length, 1)

  const local = store.readLocal()
  assert.equal(local.providers.opencodego.aggregation.schema, 'modelgate.aggregation.provider/1')
  assert.equal(local.providers.opencodego.aggregation.adopted, true)
  // 接管只写 providers；models 仍留在基线文件里且绑定不变（不得被改写或复制进 local）。
  assert.equal(local.models, undefined, 'adopt 不得写入/覆盖 models')
  const base = JSON.parse(JSON.stringify(store.readConfig()))
  assert.equal(store.readConfig().models['deepseek-v4.1-flash'].provider, 'opencodego', '既有模型绑定不得被改写')
  assert.equal(base.providers.opencodego.baseUrl, GO_BASE)
})

test('adopt：内联凭据/已聚合/非法 host 一律 typed 拒绝', () => {
  const withSecret = storeWithLegacy({ apiKey: 'inline-should-be-rejected' })
  const reg1 = createRegistry({ paths: withSecret.paths, readConfig: withSecret.readConfig })
  assert.throws(() => reg1.addProvider({ preset: 'opencode-go', adopt: true, version: 0 }),
    (err) => err.code === 'provider_key_inline_forbidden')

  const wrongHost = storeWithLegacy({ baseUrl: 'https://evil.example.com/v1' })
  const reg2 = createRegistry({ paths: wrongHost.paths, readConfig: wrongHost.readConfig })
  assert.throws(() => reg2.addProvider({ preset: 'opencode-go', adopt: true, version: 0 }),
    (err) => err.code === 'provider_host_not_allowlisted')
})

test('adopt：已带聚合元数据的上游仍按 provider_exists 拒绝（不得重复接管）', () => {
  const store = makeRegistryStore()
  const registry = createRegistry({ paths: store.paths, readConfig: store.readConfig })
  registry.addProvider({ preset: 'opencode-go', apiKeyEnv: 'SYNTH_GO_KEY', version: 0 })
  assert.throws(() => registry.addProvider({ preset: 'opencode-go', adopt: true, version: 1 }),
    (err) => err.code === 'provider_exists')
})
