// V2-02 / A2：OpenCode Go 单模型目录回归（离线，全 mock）。
//
// 现行产品范围：所有者 2026-11-14 决议只强制支持 Go 的 `deepseek-v4.1-flash`
// （docs/product/2026-11-14-owner-scope-v2.md → MG-R003 / MG-R004）。
// 本文件证明：
//   1. GUI 添加 Go Provider（preset）后记录写入 V2 单模型 profile；
//   2. 目录只发布 1 个 Go 模型，公共 ID = mg-opencodego-deepseek-v4-1-flash，绑定真实模型
//      = deepseek-v4.1-flash（公共 ID ≠ 出站 model）；
//   3. 齐次解析（modelTarget）给出出站 model 与 api，公共 ID 绝不成为上游 model；
//   4. 越界模型显式进 outOfScope 诊断，不静默丢弃；目标缺失则 fail-closed；
//   5. 目标模型缺失/凭据缺失/会话缺失的 typed error 稳定；
//   6. 管理接口 goScope 视图与实际发布一致。
//
// 不联网、不读宿主凭据；provider 只引用环境变量名，测试从不设置真实 Key 值。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { createRegistry } from '../../../src/aggregation/registry.js'
import { createAggregatedCatalog } from '../../../src/aggregation/catalog.js'
import { createMemorySnapshotStore } from '../../../src/aggregation/discovery.js'
import { createAggregationHandlers } from '../../../src/aggregation/handlers.js'
import { modelTarget } from '../../../src/router.js'
import {
  GO_PRESET_BASE_URL,
  GO_READY_CODES,
  V2_PROFILE,
  V2_TARGET_PUBLIC_ID,
  V2_TARGET_UPSTREAM_MODEL,
  applyV2ModelScope,
  assertReady,
  identityOf,
  readiness,
  targetModelConfig,
  v2ScopeOf,
} from '../../../src/providers/opencode-go.js'
import {
  cacheEntry, goProvider, makeRegistryStore, readFixture, snapshotOf, tempDir,
} from '../fixtures/agg-a2/helpers.mjs'

const BASE = readFixture('base-catalog.json')
const BASE_MODEL_COUNT = BASE.models.length

// 真实 Go 清单形状（多模型）：V2 只交付其中 1 个。
const GO_MODELS = [
  { upstreamId: V2_TARGET_UPSTREAM_MODEL, publicId: V2_TARGET_PUBLIC_ID, contextWindow: 128000 },
  { upstreamId: 'glm-5', publicId: 'mg-opencodego-glm-5', contextWindow: 200000 },
  { upstreamId: 'kimi-k2', publicId: 'mg-opencodego-kimi-k2', contextWindow: 131072 },
  { upstreamId: 'minimax-m2', publicId: 'mg-opencodego-minimax-m2', contextWindow: 204800 },
]

function v2GoProvider(overrides = {}) {
  return goProvider(Object.assign({ v2Scope: V2_PROFILE }, overrides))
}

function publisherFor(provider, models, options = {}) {
  const dir = options.dir || tempDir('mg-v2-go-catalog-')
  const cacheStore = createMemorySnapshotStore()
  cacheStore.put(options.scope || 'local', provider.id, cacheEntry(snapshotOf(provider, models)))
  const registry = { listProviders: () => [provider] }
  const publisher = createAggregatedCatalog({
    registry,
    cacheStore,
    dir,
    limits: options.limits,
    readConfig: () => options.cfg || ({ defaults: {}, server: {} }),
  })
  return { dir, cacheStore, registry, publisher }
}

function slugsOf(publisher) {
  return publisher.readCurrent('local').catalog.models.map((m) => m.slug)
}

test('V2 目录：Go 只发布 1 个目标模型，公共 ID 与真实模型分离', async () => {
  const { dir, publisher } = publisherFor(v2GoProvider(), GO_MODELS)
  try {
    const res = await publisher.publish('local', { base: BASE })
    const slugs = slugsOf(publisher)
    const goSlugs = slugs.filter((s) => s.startsWith('mg-opencodego-'))
    assert.deepEqual(goSlugs, [V2_TARGET_PUBLIC_ID], 'Go 只允许发布目标模型')
    assert.equal(res.modelCount, BASE_MODEL_COUNT + 1, '官方基线模型必须保留')
    assert.ok(slugs.includes('gpt-test-sol'), '官方基线模型不得因聚合被裁剪')

    // 绑定：公共 ID → provider 段 + 真实上游模型名。
    const binding = publisher.readCurrent('local').bindings[V2_TARGET_PUBLIC_ID]
    assert.ok(binding, '公共 ID 必须有目录绑定')
    assert.equal(binding.provider, 'opencodego')
    assert.equal(binding.model, V2_TARGET_UPSTREAM_MODEL, '绑定 model 必须是真实模型名')

    // 齐次解析：出站 model 来自绑定，不是公共 ID。
    const cfg = {
      providers: { opencodego: { baseUrl: GO_PRESET_BASE_URL } },
      models: { [V2_TARGET_UPSTREAM_MODEL]: targetModelConfig() },
      _codexCatalog: { bindings: publisher.readCurrent('local').bindings },
    }
    const target = modelTarget(cfg, V2_TARGET_PUBLIC_ID, 'opencodego')
    assert.equal(target.servingName, V2_TARGET_UPSTREAM_MODEL, '请求级身份：出站 model = 真实模型')
    assert.equal(target.api, 'responses', 'Codex 原生路径用 Responses 协议')
    assert.notEqual(target.servingName, V2_TARGET_PUBLIC_ID, '公共 ID 绝不作为上游 model 发送')

    // 越界模型显式记录（不是静默丢弃）。
    const v2 = res.reconciliation.v2Scope
    assert.equal(v2.enforced, true)
    assert.deepEqual(v2.publishedModelIds, [V2_TARGET_PUBLIC_ID])
    assert.equal(v2.outOfScopeCount, 3)
    assert.deepEqual(v2.outOfScopeIds.slice().sort(), ['glm-5', 'kimi-k2', 'minimax-m2'])

    const diag = res.diagnostics.find((d) => d.code === 'v2_scope_excluded')
    assert.ok(diag, '必须产出 v2_scope_excluded 诊断')
    assert.equal(diag.level || diag.severity, 'info')
    assert.equal(diag.count, 3)
    assert.ok(diag.items.some((i) => i.upstreamId === 'glm-5'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('V2 目录：目标模型缺失时 fail-closed，绝不发布空 Go 层冒充可用', async () => {
  const others = GO_MODELS.filter((m) => m.upstreamId !== V2_TARGET_UPSTREAM_MODEL)
  const { dir, publisher } = publisherFor(v2GoProvider(), others)
  try {
    await assert.rejects(
      () => publisher.publish('local', { base: BASE }),
      (err) => err.code === 'v2_target_model_missing' && /deepseek-v4\.1-flash/.test(err.message))
    // 显式允许时也只发布 0 个 Go 模型，并且有诊断，不编造。
    const res = await publisher.publish('local', { base: BASE, allowMissingTarget: true })
    assert.equal(res.modelCount, BASE_MODEL_COUNT)
    assert.equal(slugsOf(publisher).filter((s) => s.startsWith('mg-opencodego-')).length, 0)
    assert.ok(res.diagnostics.some((d) => d.code === 'v2_target_model_missing'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('历史 provider（无 v2Scope）保持 V1 全量行为：profile 是显式开关', async () => {
  const { dir, publisher } = publisherFor(goProvider(), GO_MODELS)
  try {
    const res = await publisher.publish('local', { base: BASE })
    const goSlugs = slugsOf(publisher).filter((s) => s.startsWith('mg-opencodego-'))
    assert.equal(goSlugs.length, GO_MODELS.length, '没有显式 profile 的历史记录不被静默改变')
    assert.equal(res.reconciliation.v2Scope.enforced, false)
    assert.equal(res.diagnostics.filter((d) => d.code === 'v2_scope_excluded').length, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('GUI 路径：preset 添加 Go Provider → 记录 V2 profile → 只发布 1 个模型', async () => {
  const store = makeRegistryStore()
  try {
    const registry = createRegistry({ paths: store.paths, readConfig: store.readConfig })
    // 只给 preset + 凭据引用，不给 baseUrl：模板只提供已登记位形。
    const added = registry.addProvider({ preset: 'opencode-go', apiKeyEnv: 'SYNTH_V2_GO_KEY', version: 0 })
    assert.equal(added.id, 'opencodego', '公共 ID 段固定，不可重编号')
    assert.equal(added.baseUrl, GO_PRESET_BASE_URL)
    assert.equal(added.v2Scope, V2_PROFILE, 'GUI 新增的 Go Provider 默认进入 V2 单模型 profile')
    assert.equal(v2ScopeOf(added).enforced, true)

    // 磁盘上只保存引用，不保存 Key 值。
    const local = store.readLocal()
    assert.equal(JSON.stringify(local).includes('sk-'), false)
    assert.equal(local.providers.opencodego.aggregation.v2Scope, V2_PROFILE)
    assert.equal(local.providers.opencodego.apiKeyEnv, 'SYNTH_V2_GO_KEY')

    // 用注册表记录发布目录：仍只有目标模型。
    const dir = tempDir('mg-v2-go-gui-')
    const cacheStore = createMemorySnapshotStore()
    cacheStore.put('local', 'opencodego', cacheEntry(snapshotOf(added, GO_MODELS)))
    const publisher = createAggregatedCatalog({
      registry: { listProviders: () => registry.listProviders() },
      cacheStore,
      dir,
      readConfig: () => ({ defaults: {}, server: {} }),
    })
    try {
      const res = await publisher.publish('local', { base: BASE })
      assert.deepEqual(
        slugsOf(publisher).filter((s) => s.startsWith('mg-opencodego-')),
        [V2_TARGET_PUBLIC_ID])
      assert.equal(res.reconciliation.v2Scope.outOfScopeCount, GO_MODELS.length - 1)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  } finally { rmSync(store.dir, { recursive: true, force: true }) }
})

test('preset 校验：未知 preset / kind 不匹配 / 非法 v2Scope 一律拒绝', () => {
  const store = makeRegistryStore()
  try {
    const registry = createRegistry({ paths: store.paths, readConfig: store.readConfig })
    assert.throws(() => registry.addProvider({ preset: 'opencode-console', apiKeyEnv: 'X_KEY' }),
      (err) => err.code === 'provider_preset_unknown')
    assert.throws(() => registry.addProvider({ preset: 'opencode-go', kind: 'opencode-console', baseUrl: 'https://opencode.ai/console/v1' }),
      (err) => err.code === 'provider_preset_kind_mismatch')
    assert.throws(() => registry.addProvider({ preset: 'opencode-go', v2Scope: 'full-magic' }),
      (err) => err.code === 'provider_v2_scope_invalid')
    assert.throws(() => registry.addProvider({ kind: 'opencode-console', baseUrl: 'https://opencode.ai/console/v1', v2Scope: V2_PROFILE }),
      (err) => err.code === 'provider_v2_scope_unsupported' || err.code === 'provider_v2_scope_kind_unsupported')
    assert.deepEqual(Object.keys(store.readConfig().providers || {}), [], '被拒绝的输入不得落盘')
  } finally { rmSync(store.dir, { recursive: true, force: true }) }
})

test('typed 错误：凭据缺失/模型越界/公共 ID 不一致/会话缺失，code 稳定且仍禁止换模型', () => {
  const provider = v2GoProvider({ keyRef: 'provider-key' })

  // 凭据缺失：只判存在性，不回显引用值，也不静默继承别的凭据。
  const noKeyProvider = Object.assign(goProvider(), { keyRef: 'none', apiKeyEnv: undefined })
  const noCred = readiness({ provider: noKeyProvider })
  assert.equal(noCred.ok, false)
  assert.equal(noCred.code, GO_READY_CODES.CREDENTIAL)
  assert.equal(noCred.ready, false)
  assert.equal(noCred.allowProviderSwitch, false)
  assert.equal(noCred.allowModelSwitch, false)

  // 越界模型：不给“就近映射”，直接 typed。
  const outOfScope = identityOf({ upstreamId: 'glm-5', publicId: 'mg-opencodego-glm-5' })
  assert.equal(outOfScope.ok, false)
  assert.equal(outOfScope.code, GO_READY_CODES.MODEL_OUT_OF_SCOPE)
  assert.match(outOfScope.message, /deepseek-v4\.1-flash/)

  // 公共 ID 不一致（例如被手工改名）：拒绝，不自愈。
  const mismatch = identityOf({ upstreamId: V2_TARGET_UPSTREAM_MODEL, publicId: 'mg-opencodego-deepseek-v9' })
  assert.equal(mismatch.ok, false)
  assert.equal(mismatch.code, 'opencodego_public_id_mismatch')

  // 一致时出站 model 恒为真实模型名。
  const good = identityOf({ upstreamId: V2_TARGET_UPSTREAM_MODEL, publicId: V2_TARGET_PUBLIC_ID })
  assert.equal(good.ok, true)
  assert.equal(good.outboundModel, V2_TARGET_UPSTREAM_MODEL)

  // 就绪的 provider：ready 且仍声明不换模型/供应商。
  const ok = readiness({ provider, model: V2_TARGET_UPSTREAM_MODEL })
  assert.equal(ok.ok, true)
  assert.equal(ok.ready, true)
  assert.equal(ok.allowModelSwitch, false)
  assert.equal(ok.allowProviderSwitch, false)

  // 会话策略 = client-required 时，没有线程引用必须 typed 失败（不许跨请求常量冒充会话）。
  assert.throws(
    () => assertReady({ provider, sessionPolicy: 'client-required', request: { headers: {} } }),
    (err) => err.name === 'GoError' && err.code === GO_READY_CODES.SESSION && err.allowProviderSwitch === false)
  // 有线程引用时通过。
  assert.equal(assertReady({
    provider,
    sessionPolicy: 'client-required',
    request: { headers: { 'thread-id': 'thread-1' } },
  }).ready, true)
})

test('V2 配置：目标模型声明跨供应商 fallbacks → 目录发布 fail-closed', async () => {
  const provider = v2GoProvider()
  const cfg = {
    defaults: {},
    server: {},
    models: { [V2_TARGET_UPSTREAM_MODEL]: { provider: 'opencodego', fallbacks: ['gpt-official-ish'] } },
  }
  const { dir, publisher } = publisherFor(provider, GO_MODELS, { cfg })
  try {
    await assert.rejects(
      () => publisher.publish('local', { base: BASE }),
      (err) => err.code === 'v2_cross_provider_fallback_forbidden' &&
        /禁止静默换上游/.test(err.message) &&
        Array.isArray(err.details.fallbacks) && err.details.fallbacks.includes('gpt-official-ish'))
  } finally { rmSync(dir, { recursive: true, force: true }) }

  // 同 provider 的 fallback（等价于同上游重试）不算跨供应商，不受影响。
  const sameCfg = { defaults: {}, server: {}, models: { [V2_TARGET_UPSTREAM_MODEL]: { provider: 'opencodego', fallbacks: ['opencodego'] } } }
  const ok = publisherFor(v2GoProvider(), GO_MODELS, { cfg: sameCfg })
  try {
    const res = await ok.publisher.publish('local', { base: BASE })
    assert.deepEqual(res.reconciliation.v2Scope.publishedModelIds, [V2_TARGET_PUBLIC_ID])
  } finally { rmSync(ok.dir, { recursive: true, force: true }) }
})

test('applyV2ModelScope：越界清单完整且目标唯一', () => {
  const applied = applyV2ModelScope(GO_MODELS, v2GoProvider())
  assert.equal(applied.enforced, true)
  assert.equal(applied.published.length, 1)
  assert.equal(applied.published[0].upstreamId, V2_TARGET_UPSTREAM_MODEL)
  assert.equal(applied.targetPresent, true)
  assert.deepEqual(applied.outOfScope.map((m) => m.upstreamId).sort(), ['glm-5', 'kimi-k2', 'minimax-m2'])

  const noTarget = applyV2ModelScope(GO_MODELS.slice(1), v2GoProvider())
  assert.equal(noTarget.targetPresent, false)
  assert.equal(noTarget.published.length, 0)
})

test('管理接口 goScope：与实际发布一致，越界模型显式列出', async () => {
  const provider = v2GoProvider()
  const { dir, cacheStore, registry, publisher } = publisherFor(provider, GO_MODELS)
  try {
    await publisher.publish('local', { base: BASE })
    const handlers = createAggregationHandlers({
      registry,
      discovery: { cacheStore },
      catalog: publisher,
      readConfig: () => ({ defaults: {}, server: {} }),
    })
    const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } }
    const models = handlers.listModels(req, {}, { explicitAdmin: true })
    assert.equal(models.status, 200)
    assert.ok(models.body.goScope, '必须暴露 goScope 视图')
    assert.equal(models.body.goScope.target.publicId, V2_TARGET_PUBLIC_ID)
    assert.equal(models.body.goScope.target.upstreamModel, V2_TARGET_UPSTREAM_MODEL)
    const row = models.body.goScope.providers[0]
    assert.equal(row.profile, V2_PROFILE)
    assert.equal(row.enforced, true)
    assert.deepEqual(row.published.map((m) => m.publicId), [V2_TARGET_PUBLIC_ID])
    assert.deepEqual(row.outOfScope.map((m) => m.upstreamId).sort(), ['glm-5', 'kimi-k2', 'minimax-m2'])

    const health = handlers.health(req, {}, { explicitAdmin: true })
    const hrow = health.body.providers.find((p) => p.id === 'opencodego')
    assert.equal(hrow.v2Scope.profile, V2_PROFILE)
    assert.equal(hrow.v2Scope.targetPresent, true)
    assert.equal(hrow.v2Scope.outOfScope, 3)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
