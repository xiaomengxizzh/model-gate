import test from 'node:test'
import assert from 'node:assert/strict'
import { modelImpact, planModel, publicModel } from '../../../src/resources/models.js'

const SERVICE_ID = 'svc_abcdefghijklmnop'
const MODEL_ID = 'mdl_abcdefghijklmnop'

function fixture() {
  return {
    configVersion: 7,
    providers: {
      p: {
        serviceId: SERVICE_ID,
        baseUrl: 'https://user:password@example.test/v1?token=provider-secret',
        api: 'openai',
        extraHeaders: { authorization: 'Bearer header-secret' },
      },
      q: { serviceId: 'svc_qrstuvwxyzabcdef', api: 'responses' },
    },
    models: {
      demo: {
        modelId: MODEL_ID,
        provider: 'p',
        upstreamModelId: 'up-demo',
        providerModels: { p: 'up-demo', q: 'up-demo-q' },
        alias: ['demo-alias'],
        fallbacks: ['q'],
        custom: { keep: [1, 2, 3] },
      },
      other: { provider: 'q', providerModels: { q: 'up-other' } },
    },
    defaults: {},
    virtualModels: [],
    _keys: { p: 'stored-key-secret' },
  }
}

function request(cfg, action, patch = {}, extra = {}) {
  return planModel(cfg, { action, expectedVersion: cfg.configVersion, requestId: 'req-1', patch, ...extra }, { now: 1000 })
}

function assertNoSecrets(value) {
  const text = JSON.stringify(value)
  for (const secret of ['stored-key-secret', 'provider-secret', 'header-secret', 'password', 'extraHeaders', '_keys']) {
    assert.equal(text.includes(secret), false, secret)
  }
}

test('模型资源：旧模型派生稳定 legacy 投影且不泄露扩展字段', () => {
  const cfg = {
    providers: { p: { api: 'anthropic' } },
    models: {
      demo: {
        provider: 'p',
        providerModels: { p: 'vendor-model' },
        alias: ['private-alias'],
        apiKey: 'model-key-canary',
        custom: { untouched: true },
      },
    },
  }
  assert.deepEqual(publicModel('demo', cfg.models.demo, cfg), {
    name: 'demo',
    modelId: 'legacy:demo',
    serviceId: 'legacy:p',
    providerId: 'p',
    upstreamModelId: 'vendor-model',
    displayName: 'demo',
    capability: 'chat',
    api: 'anthropic',
    enabled: true,
    metadataProvenance: 'legacy',
  })
  assert.equal(publicModel('missing', null, cfg), null)
  assert.deepEqual(publicModel('demo', cfg.models.demo, cfg), publicModel('demo', cfg.models.demo, cfg))
})

test('模型资源：显式稳定 ID、显示属性和元数据来源保持可读', () => {
  const cfg = fixture()
  const view = publicModel('demo', {
    ...cfg.models.demo,
    displayName: '演示模型',
    capability: 'embedding',
    api: 'responses',
    enabled: false,
    metadataProvenance: 'discovered',
  }, cfg)
  assert.equal(view.modelId, MODEL_ID)
  assert.equal(view.serviceId, SERVICE_ID)
  assert.equal(view.displayName, '演示模型')
  assert.equal(view.capability, 'embedding')
  assert.equal(view.api, 'responses')
  assert.equal(view.enabled, false)
  assert.equal(view.metadataProvenance, 'discovered')
})

test('模型资源：创建生成 mdl_ 稳定 ID、单源 payload 且默认值诚实', () => {
  const cfg = fixture()
  cfg.models = {}
  const original = structuredClone(cfg)
  const out = request(cfg, 'model.create', {
    name: 'new-model',
    providerId: 'p',
    upstreamModelId: 'vendor-new',
    providerModels: { q: 'vendor-alternate' },
    maxContext: 128000,
    maxTokensMax: 8192,
  })
  assert.equal(out.status, 200)
  const { plan } = out
  assert.match(plan.modelId, /^mdl_[A-Za-z0-9_-]{16,64}$/)
  assert.equal(plan.name, 'new-model')
  assert.equal(plan.expectedVersion, 7)
  assert.equal(plan.requestId, 'req-1')
  assert.equal(plan.expiresAt, new Date(301000).toISOString())
  assert.equal(plan.before, null)
  assert.equal(plan.after.modelId, plan.modelId)
  assert.equal(plan.after.serviceId, SERVICE_ID)
  assert.equal(plan.after.providerId, 'p')
  assert.equal(plan.after.upstreamModelId, 'vendor-new')
  assert.equal(plan.after.displayName, 'new-model')
  assert.equal(plan.after.capability, 'chat')
  assert.equal(plan.after.api, 'openai')
  assert.equal(plan.after.enabled, true)
  assert.equal(plan.after.metadataProvenance, 'manual')
  assert.deepEqual(Object.keys(plan.payload).sort(), ['expectedVersion', 'models'])
  assert.deepEqual(plan.payload.models['new-model'].providerModels, { p: 'vendor-new', q: 'vendor-alternate' })
  assert.equal(plan.payload.models['new-model'].maxContext, 128000)
  assert.equal(plan.payload.models['new-model'].maxTokensMax, 8192)
  assert.equal(plan.payload.models['new-model'].serviceId, undefined, 'serviceId 从 provider 派生，不建立第二存储')
  assert.deepEqual(cfg, original)

  const second = request(cfg, 'model.create', { name: 'second', providerId: 'p', upstreamModelId: 'vendor-second' })
  assert.equal(second.status, 200)
  assert.notEqual(second.plan.modelId, plan.modelId)
})

test('模型资源：更新按 serviceId/name 定位并保留未知字段、映射和稳定 ID', () => {
  const cfg = fixture()
  const original = structuredClone(cfg)
  const byId = request(cfg, 'model.update', {
    displayName: '已编辑',
    upstreamModelId: 'vendor-edited',
    enabled: false,
    maxContext: 64000,
  }, { serviceId: MODEL_ID, requestId: 'edit-id' })
  assert.equal(byId.status, 200)
  assert.equal(byId.plan.before.modelId, MODEL_ID)
  assert.equal(byId.plan.after.modelId, MODEL_ID)
  assert.equal(byId.plan.after.upstreamModelId, 'vendor-edited')
  assert.equal(byId.plan.after.enabled, false)
  const stored = byId.plan.payload.models.demo
  assert.deepEqual(stored.custom, { keep: [1, 2, 3] })
  assert.deepEqual(stored.alias, ['demo-alias'])
  assert.deepEqual(stored.fallbacks, ['q'])
  assert.deepEqual(stored.providerModels, { p: 'vendor-edited', q: 'up-demo-q' })
  assert.equal(stored.maxContext, 64000)
  assert.deepEqual(byId.plan.payload.models.other, cfg.models.other)
  assert.deepEqual(cfg, original)

  const renamed = request(cfg, 'model.update', { name: 'renamed' }, { name: 'demo', requestId: 'edit-name' })
  assert.equal(renamed.status, 200)
  assert.equal(renamed.plan.modelId, MODEL_ID)
  assert.equal(renamed.plan.after.modelId, MODEL_ID)
  assert.equal(renamed.plan.after.name, 'renamed')
  assert.equal(renamed.plan.payload.models.demo, undefined)
  assert.deepEqual(renamed.plan.payload.models.renamed.custom, { keep: [1, 2, 3] })
  assert.equal(publicModel('renamed', renamed.plan.payload.models.renamed, cfg).modelId, MODEL_ID)
})

test('模型资源：更新保留既有 provenance，并拒绝重复公共名和重复服务目标', () => {
  const cfg = fixture()
  cfg.models.demo.metadataProvenance = 'discovered'
  const preserved = request(cfg, 'model.update', { displayName: '保留来源' }, { serviceId: MODEL_ID })
  assert.equal(preserved.status, 200)
  assert.equal(preserved.plan.after.metadataProvenance, 'discovered')

  const duplicateName = request(cfg, 'model.update', { name: 'other' }, { serviceId: MODEL_ID })
  assert.equal(duplicateName.status, 409)
  assert.equal(duplicateName.code, 'model_name_conflict')

  const duplicateTarget = request(cfg, 'model.create', { name: 'copy', providerId: 'p', upstreamModelId: 'up-demo' })
  assert.equal(duplicateTarget.status, 409)
  assert.equal(duplicateTarget.code, 'model_target_conflict')

  const duplicateOverride = request(cfg, 'model.create', {
    name: 'copy', providerId: 'p', upstreamModelId: 'unique', providerModels: { q: 'up-other' },
  })
  assert.equal(duplicateOverride.status, 409)
  assert.equal(duplicateOverride.code, 'model_target_conflict')
})

test('模型资源：删除逐一检查默认目录、模型池、fallback、providerModels 和 Codex 引用', () => {
  const cases = [
    ['defaults', (cfg) => { cfg.defaults.directory = [{ model: 'demo' }] }, ['demo']],
    ['virtualModels', (cfg) => { cfg.virtualModels = [{ name: 'pool-a', directory: [{ model: 'demo' }] }] }, ['pool-a']],
    ['fallbacks', (cfg) => { cfg.models.other.fallbacks = ['demo'] }, ['other']],
    ['providerModels', (cfg) => { cfg.models.other.providerModels.demo = 'legacy-reference' }, ['other']],
    ['codexBindings', (cfg) => { cfg._codexCatalog = { bindings: { slug: { slug: 'slug', model: 'demo', provider: 'p' } } } }, ['slug']],
    ['codexBindings', (cfg) => { cfg._codexCatalog = { bindings: { stable: { slug: 'stable', modelId: MODEL_ID, provider: 'p' } } } }, ['stable']],
    ['virtualModels', (cfg) => { cfg.virtualModels = [{ name: 'stable-pool', members: [{ modelId: MODEL_ID }] }] }, ['stable-pool']],
  ]
  for (const [field, mutate, expected] of cases) {
    const cfg = fixture()
    mutate(cfg)
    const impact = modelImpact(cfg, 'demo')
    assert.deepEqual(impact[field], expected, field)
    const out = request(cfg, 'model.delete', {}, { serviceId: MODEL_ID })
    assert.equal(out.status, 422, field)
    assert.equal(out.code, 'model_referenced')
    assert.deepEqual(out.details[field], expected, field)
    assert.equal(out.plan, undefined)
  }
})

test('模型资源：无引用删除只移除目标模型，重命名引用模型返回 422', () => {
  const cfg = fixture()
  const deleted = request(cfg, 'model.delete', {}, { name: 'demo' })
  assert.equal(deleted.status, 200)
  assert.equal(deleted.plan.modelId, MODEL_ID)
  assert.equal(deleted.plan.after, null)
  assert.equal(deleted.plan.payload.models.demo, undefined)
  assert.deepEqual(deleted.plan.payload.models.other, cfg.models.other)
  assert.deepEqual(Object.keys(deleted.plan.payload).sort(), ['expectedVersion', 'models'])

  cfg.defaults.directory = [{ model: 'demo' }]
  const renamed = request(cfg, 'model.update', { name: 'renamed' }, { serviceId: MODEL_ID })
  assert.equal(renamed.status, 422)
  assert.equal(renamed.code, 'model_referenced')
})

test('模型资源：版本、定位、保留键和 patch 校验失败且不修改配置', () => {
  const cfg = fixture()
  const original = structuredClone(cfg)
  assert.equal(planModel(cfg, null).status, 400)
  assert.equal(request(cfg, 'model.list').code, 'unsupported_preview_action')
  assert.equal(planModel(cfg, { action: 'model.create', expectedVersion: 6, requestId: 'r', patch: {} }).status, 409)
  assert.equal(planModel(cfg, { action: 'model.create', expectedVersion: 7, patch: {} }).code, 'invalid_request_id')
  assert.equal(request(cfg, 'model.update', {}, { serviceId: '__proto__' }).status, 404)
  assert.equal(request(cfg, 'model.update', {}, { serviceId: MODEL_ID, name: 'other' }).status, 404)
  assert.equal(request(cfg, 'model.update', {}, { serviceId: 'mdl_missing' }).status, 404)

  const invalidPatches = [
    { name: '__proto__', providerId: 'p', upstreamModelId: 'up' },
    { name: 'new', providerId: 'missing', upstreamModelId: 'up' },
    { name: 'new', providerId: 'p', upstreamModelId: 'up', api: 'chat-completions' },
    { name: 'new', providerId: 'p', upstreamModelId: 'up', capability: 'reasoning' },
    { name: 'new', providerId: 'p', upstreamModelId: 'up', enabled: 'false' },
    { name: 'new', providerId: 'p', upstreamModelId: 'up', maxContext: -1 },
    { name: 'new', providerId: 'p', upstreamModelId: 'up', providerModels: [] },
    { name: 'new', providerId: 'p', upstreamModelId: 'up', providerModels: { missing: 'up' } },
    { name: 'new', providerId: 'p', upstreamModelId: 'up', providerModels: { constructor: 'up' } },
    { name: 'new', providerId: 'p', upstreamModelId: 'up', unknownField: true },
    { name: null, providerId: 'p', upstreamModelId: 'up' },
    { name: 'new', providerId: null, upstreamModelId: 'up' },
  ]
  for (const patch of invalidPatches) assert.equal(request(cfg, 'model.create', patch).status, 400, JSON.stringify(patch))
  assert.equal(request(cfg, 'model.create', { name: 'demo', providerId: 'p', upstreamModelId: 'unique' }).code, 'model_name_conflict')
  assert.deepEqual(cfg, original)
})

test('模型资源：serviceId 与 name/modelId 组合定位，服务内多模型需消歧', () => {
  const cfg = fixture()
  const combined = request(cfg, 'model.update', { displayName: '组合定位' }, { serviceId: SERVICE_ID, name: 'demo' })
  assert.equal(combined.status, 200)
  assert.equal(combined.plan.modelId, MODEL_ID)

  const byModelId = request(cfg, 'model.update', { displayName: '稳定 ID 定位' }, { modelId: MODEL_ID })
  assert.equal(byModelId.status, 200)
  assert.equal(byModelId.plan.name, 'demo')

  cfg.models.sibling = { provider: 'p', providerModels: { p: 'up-sibling' } }
  const ambiguous = request(cfg, 'model.update', { displayName: '需消歧' }, { serviceId: SERVICE_ID })
  assert.equal(ambiguous.status, 409)
  assert.equal(ambiguous.code, 'model_id_conflict')
  assert.equal(request(cfg, 'model.update', { displayName: '已消歧' }, { serviceId: SERVICE_ID, name: 'demo' }).status, 200)
})

test('模型资源：重复稳定 ID 定位失败关闭，legacy ID 重命名后保持稳定', () => {
  const cfg = fixture()
  cfg.models.other.modelId = MODEL_ID
  assert.equal(request(cfg, 'model.update', {}, { serviceId: MODEL_ID }).code, 'model_id_conflict')

  const legacy = {
    configVersion: 1,
    providers: { p: { api: 'openai' } },
    models: { old: { provider: 'p', custom: 'keep' } },
  }
  assert.equal(publicModel('old', legacy.models.old, legacy).modelId, 'legacy:old')
  const out = request(legacy, 'model.update', { name: 'new' }, { name: 'old' })
  assert.equal(out.status, 200)
  assert.equal(out.plan.modelId, 'legacy:old')
  assert.equal(out.plan.payload.models.new.modelId, 'legacy:old')
  assert.equal(out.plan.payload.models.new.custom, 'keep')
})

test('模型资源：创建、更新、删除和公共投影均不包含凭据或服务秘密', () => {
  const cfg = fixture()
  const created = request(cfg, 'model.create', { name: 'safe', providerId: 'p', upstreamModelId: 'vendor-safe' })
  const updated = request(cfg, 'model.update', { displayName: '安全名称' }, { serviceId: MODEL_ID })
  const deleted = request(cfg, 'model.delete', {}, { serviceId: MODEL_ID })
  for (const out of [created, updated, deleted]) {
    assert.equal(out.status, 200)
    assertNoSecrets(out)
  }
  const projected = publicModel('demo', { ...cfg.models.demo, apiKey: 'model-key-canary', extraHeaders: { authorization: 'Bearer x' } }, cfg)
  assert.equal(JSON.stringify(projected).includes('model-key-canary'), false)
  assert.equal(JSON.stringify(projected).includes('extraHeaders'), false)
  assertNoSecrets(projected)
})
