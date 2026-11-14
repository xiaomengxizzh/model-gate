// A2 / P01：注册表 CAS、聚合目录发布/回滚/溢出、scope 隔离与 HTTP 守卫（离线）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createRegistry, RegistryError } from '../../../src/aggregation/registry.js'
import {
  AggregatedCatalogError, createAggregatedCatalog,
} from '../../../src/aggregation/catalog.js'
import { createDiscoveryEngine, createMemorySnapshotStore } from '../../../src/aggregation/discovery.js'
import { createAggregationHandlers } from '../../../src/aggregation/handlers.js'
import {
  cacheEntry, consoleProvider, goProvider, makeRegistryStore, readFixture, snapshotOf, tempDir,
} from '../fixtures/agg-a2/helpers.mjs'

const BASE = readFixture('base-catalog.json')

const CONSOLE_MODELS = [
  { upstreamId: 'deepseek-v4.1-flash', publicId: 'mg-console-deepseek-v4-1-flash', contextWindow: 128000 },
  { upstreamId: 'glm-5', publicId: 'mg-console-glm-5', contextWindow: 200000 },
  { upstreamId: 'gpt-4o', publicId: 'mg-console-gpt-4o', contextWindow: 128000, authorized: false },
  { upstreamId: 'qwen3-coder', publicId: 'mg-console-qwen3-coder', contextWindow: 262144 },
]

const GO_MODELS = [
  { upstreamId: 'deepseek-v4.1-flash', publicId: 'mg-opencodego-deepseek-v4-1-flash', contextWindow: 128000 },
  { upstreamId: 'glm-5', publicId: 'mg-opencodego-glm-5', contextWindow: 200000 },
  { upstreamId: 'kimi-k2', publicId: 'mg-opencodego-kimi-k2', contextWindow: 131072 },
  { upstreamId: 'minimax-m2', publicId: 'mg-opencodego-minimax-m2', contextWindow: 204800 },
]

function setup(providerSnapshots, options = {}) {
  const dir = options.dir || tempDir('mg-agg-catalog-')
  const cacheStore = createMemorySnapshotStore()
  const scope = options.scope || 'local'
  for (const { provider, models, complete } of providerSnapshots) {
    cacheStore.put(scope, provider.id, cacheEntry(snapshotOf(provider, models, { complete })))
  }
  const providers = providerSnapshots.map((p) => p.provider)
  const registry = { listProviders: () => (options.providers || providers) }
  const publisher = createAggregatedCatalog({
    registry,
    cacheStore,
    dir,
    limits: options.limits,
    readConfig: () => ({ defaults: {}, server: {} }),
  })
  return { dir, cacheStore, registry, publisher, scope }
}

function slugsOf(catalog) {
  return catalog.models.map((m) => m.slug)
}

test('发布：未授权模型永不可调用，公共 ID 与上游 ID 精确', async () => {
  const { dir, publisher } = setup([{ provider: consoleProvider(), models: CONSOLE_MODELS }])
  try {
    const res = await publisher.publish('local', { base: BASE })
    assert.equal(res.version, 1)
    assert.equal(res.modelCount, 4)
    assert.equal(res.catalogRef.generation, 1)
    assert.deepEqual(slugsOf(publisher.readCurrent('local').catalog).sort(), [
      'gpt-test-sol', 'mg-console-deepseek-v4-1-flash', 'mg-console-glm-5', 'mg-console-qwen3-coder',
    ])
    assert.ok(!slugsOf(publisher.readCurrent('local').catalog).includes('mg-console-gpt-4o'))
    assert.ok(res.diagnostics.some((d) => d.code === 'unauthorized_excluded' && d.publicId === 'mg-console-gpt-4o'))
    assert.equal(res.reconciliation.discovered, 4)
    assert.equal(res.reconciliation.published, 3)
    const published = JSON.parse(readFileSync(join(res.catalogRef.path), 'utf8'))
    const deepseek = published.models.find((m) => m.slug === 'mg-console-deepseek-v4-1-flash')
    assert.equal(deepseek.context_window, 128000)
    assert.equal(deepseek.shell_type, 'disabled')
    assert.equal(deepseek.support_verbosity, false)
    assert.equal(deepseek.supports_search_tool, undefined)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('分层发布：go 与 console 同名上游 ID 各自得到独立公共 ID', async () => {
  const { dir, publisher } = setup([
    { provider: goProvider(), models: GO_MODELS },
    { provider: consoleProvider(), models: CONSOLE_MODELS },
  ])
  try {
    const res = await publisher.publish('local', { base: BASE })
    assert.equal(res.modelCount, 8)
    const slugs = slugsOf(publisher.readCurrent('local').catalog)
    assert.ok(slugs.includes('mg-opencodego-deepseek-v4-1-flash'))
    assert.ok(slugs.includes('mg-console-deepseek-v4-1-flash'))
    assert.ok(slugs.includes('mg-opencodego-glm-5'))
    assert.ok(slugs.includes('mg-console-glm-5'))
    const current = publisher.readCurrent('local')
    assert.ok(current.bindings['mg-opencodego-deepseek-v4-1-flash'])
    assert.ok(current.bindings['mg-console-deepseek-v4-1-flash'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('目录溢出：自动维护本机全量目录，绝不裁剪', async () => {
  const { dir, publisher } = setup([{ provider: consoleProvider(), models: CONSOLE_MODELS }], {
    limits: { maxModels: 3, maxBytes: 10 * 1024 * 1024 },
  })
  try {
    const res = await publisher.publish('local', { base: BASE })
    assert.equal(res.catalogRef.mode, 'local-full-catalog')
    assert.equal(res.modelCount, 4)
    assert.equal(existsSync(res.catalogRef.fullCatalogPath), true)
    const full = JSON.parse(readFileSync(res.catalogRef.fullCatalogPath, 'utf8'))
    assert.equal(full.models.length, 4)
    assert.ok(res.diagnostics.some((d) => d.code === 'catalog_overflow_local_full'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('回滚：整代替换到上一代内容，世代号继续单调', async () => {
  const { dir, cacheStore, publisher } = setup([{ provider: consoleProvider(), models: CONSOLE_MODELS }])
  try {
    const first = await publisher.publish('local', { base: BASE })
    const firstSlugs = slugsOf(publisher.readCurrent('local').catalog).sort()
    cacheStore.put('local', 'console', cacheEntry(snapshotOf(consoleProvider(), CONSOLE_MODELS.slice(0, 2))))
    const second = await publisher.publish('local', { base: BASE })
    assert.equal(second.modelCount, 3)
    assert.notDeepEqual(slugsOf(publisher.readCurrent('local').catalog).sort(), firstSlugs)

    const rolled = publisher.rollback('local', 'prev')
    assert.equal(rolled.version, 3)
    assert.deepEqual(slugsOf(publisher.readCurrent('local').catalog).sort(), firstSlugs)
    assert.ok(rolled.diagnostics.some((d) => d.code === 'catalog_rolled_back' && d.to === first.version))
    const state = publisher.status('local').state
    assert.equal(state.currentVersion, 3)
    assert.equal(state.highWaterVersion, 3)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('上下文窗口缺失：默认 fail-closed，不写世代', async () => {
  const models = [{ upstreamId: 'no-context-model', publicId: 'mg-console-no-context-model', contextWindow: null }]
  const { dir, publisher } = setup([{ provider: consoleProvider(), models }])
  try {
    await assert.rejects(() => publisher.publish('local', { base: BASE }), (err) => {
      assert.equal(err.code, 'context_window_missing')
      assert.equal(err.details.models[0].upstreamId, 'no-context-model')
      return true
    })
    assert.equal(publisher.status('local').state.currentVersion, 0)
    const allowed = await publisher.publish('local', { base: BASE, allowMissingContext: true })
    assert.equal(allowed.modelCount, 1)
    assert.ok(allowed.diagnostics.some((d) => d.code === 'context_window_missing'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('发现不完整/缺少快照：拒绝发布漏模型的目录', async () => {
  const { dir, publisher } = setup([{ provider: consoleProvider(), models: CONSOLE_MODELS, complete: false }])
  try {
    await assert.rejects(() => publisher.publish('local', { base: BASE }), (err) => err.code === 'discovery_incomplete')
  } finally { rmSync(dir, { recursive: true, force: true }) }

  const dir2 = tempDir('mg-agg-catalog-')
  try {
    const publisher2 = createAggregatedCatalog({
      registry: { listProviders: () => [consoleProvider()] },
      cacheStore: createMemorySnapshotStore(),
      dir: dir2,
      readConfig: () => ({ defaults: {}, server: {} }),
    })
    await assert.rejects(() => publisher2.publish('local', { base: BASE }), (err) => err.code === 'discovery_snapshot_missing')
  } finally { rmSync(dir2, { recursive: true, force: true }) }
})

test('scope 隔离：两个 scope 各自独立目录与世代', async () => {
  const dir = tempDir('mg-agg-catalog-')
  try {
    const cacheStore = createMemorySnapshotStore()
    cacheStore.put('a', 'console', cacheEntry(snapshotOf(consoleProvider(), CONSOLE_MODELS)))
    cacheStore.put('b', 'console', cacheEntry(snapshotOf(consoleProvider(), CONSOLE_MODELS.slice(0, 2))))
    const publisher = createAggregatedCatalog({
      registry: { listProviders: () => [consoleProvider()] },
      cacheStore,
      dir,
      readConfig: () => ({ defaults: {}, server: {} }),
    })
    const a = await publisher.publish('a', { base: BASE })
    const b = await publisher.publish('b', { base: BASE })
    assert.equal(a.modelCount, 4)
    assert.equal(b.modelCount, 3)
    assert.notEqual(publisher.status('a').root, publisher.status('b').root)
    assert.equal(publisher.readCurrent('a').catalog.models.length, 4)
    assert.equal(publisher.readCurrent('b').catalog.models.length, 3)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('注册表：写入 gateway.local.json、版本 CAS、墓碑删除、拒绝内联 Key', () => {
  const store = makeRegistryStore()
  try {
    const registry = createRegistry({ paths: store.paths, readConfig: store.readConfig })
    const added = registry.addProvider({ kind: 'opencode-console', baseUrl: 'https://opencode.ai/console/v1', apiKeyEnv: 'TEST_AGG_KEY' })
    assert.equal(added.version, 1)
    assert.equal(added.kind, 'opencode-console')
    assert.equal(added.providerSegment, 'console')
    assert.equal(registry.listProviders().length, 1)
    assert.equal(registry.getProvider('console').apiKeyEnv, 'TEST_AGG_KEY')

    assert.throws(
      () => registry.addProvider({ kind: 'opencode-go', baseUrl: 'https://opencode.ai/inference/go/openai/v1', apiKeyEnv: 'TEST_AGG_KEY', version: 0 }),
      (err) => err instanceof RegistryError && err.code === 'version_conflict' && err.details.currentVersion === 1)

    const go = registry.addProvider({ kind: 'opencode-go', baseUrl: 'https://opencode.ai/inference/go/openai/v1', apiKeyEnv: 'TEST_AGG_KEY', version: 1 })
    assert.equal(go.version, 2)
    assert.equal(registry.listProviders().length, 2)

    assert.throws(
      () => registry.addProvider({ kind: 'opencode-console', baseUrl: 'https://opencode.ai/console/v1', apiKey: 'sk-' + 'should-never-be-stored' }),
      (err) => err.code === 'provider_key_inline_forbidden')

    assert.throws(
      () => registry.addProvider({ kind: 'opencode-console', baseUrl: 'https://evil.example/console/v1' }),
      (err) => err.code === 'provider_host_not_allowlisted')

    const removed = registry.removeProvider('console')
    assert.equal(removed.version, 3)
    assert.equal(registry.listProviders().length, 1)
    const local = store.readLocal()
    assert.deepEqual(Object.keys(local.providers), ['opencodego'])
    assert.deepEqual(local._removed.providers, ['console'])
    assert.equal(local.configVersion, 3)
    assert.ok(!JSON.stringify(local).includes('sk-' + 'should-never-be-stored'))
  } finally { rmSync(store.dir, { recursive: true, force: true }) }
})

function fakeReq(options = {}) {
  return {
    method: options.method || 'GET',
    url: options.url || '/api/aggregation/providers',
    headers: Object.assign({ host: '127.0.0.1:18787' },
      options.token ? { authorization: 'Bearer ' + options.token } : {},
      options.headers || {}),
    socket: { remoteAddress: options.remote || '127.0.0.1' },
  }
}

test('HTTP 守卫：显式管理员 + 回环 + Origin + 版本', async () => {
  const store = makeRegistryStore()
  try {
    const registry = createRegistry({ paths: store.paths, readConfig: store.readConfig })
    const cacheStore = createMemorySnapshotStore()
    const discovery = createDiscoveryEngine({ fetchImpl: async () => { throw new Error('no network') }, registry, cacheStore })
    const catalog = createAggregatedCatalog({
      registry, cacheStore, dir: store.dir, readConfig: () => ({ configVersion: 0, defaults: {}, server: {} }),
    })
    const handlers = createAggregationHandlers({ registry, discovery, catalog, readConfig: () => ({ configVersion: 0, defaults: {}, server: {} }) })
    const ctx = { adminToken: 'admin-secret', configVersion: 0, cfg: { server: {} } }

    const noToken = handlers.listProviders(fakeReq(), null, ctx)
    assert.equal(noToken.status, 403)
    assert.equal(noToken.body.code, 'aggregation_admin_required')

    const ok = handlers.listProviders(fakeReq({ token: 'admin-secret' }), null, ctx)
    assert.equal(ok.status, 200)
    assert.deepEqual(ok.body.providers, [])

    const remote = handlers.listProviders(fakeReq({ token: 'admin-secret', remote: '10.0.0.5' }), null, ctx)
    assert.equal(remote.status, 403)
    assert.equal(remote.body.code, 'aggregation_loopback_required')

    const evilOrigin = handlers.listProviders(fakeReq({ token: 'admin-secret', headers: { origin: 'https://evil.example' } }), null, ctx)
    assert.equal(evilOrigin.status, 403)
    assert.equal(evilOrigin.body.code, 'aggregation_origin_denied')

    const stale = handlers.addProvider(fakeReq({ method: 'POST', token: 'admin-secret' }), {
      version: 9,
      provider: { kind: 'opencode-console', baseUrl: 'https://opencode.ai/console/v1', apiKeyEnv: 'TEST_AGG_KEY' },
    }, ctx)
    assert.equal(stale.status, 409)
    assert.equal(stale.body.code, 'version_conflict')

    const created = handlers.addProvider(fakeReq({ method: 'POST', token: 'admin-secret' }), {
      version: 0,
      provider: { kind: 'opencode-console', baseUrl: 'https://opencode.ai/console/v1', apiKeyEnv: 'TEST_AGG_KEY' },
    }, ctx)
    assert.equal(created.status, 201)
    assert.equal(created.body.provider.id, 'console')

    const activation = await handlers.activate(fakeReq({ method: 'POST', token: 'admin-secret' }), {}, ctx)
    assert.equal(activation.status, 501)
    assert.equal(activation.body.code, 'aggregation_activation_not_configured')
  } finally { rmSync(store.dir, { recursive: true, force: true }) }
})

test('注册表文件布局：没有第二配置库/第二版本号', () => {
  const store = makeRegistryStore()
  try {
    const registry = createRegistry({ paths: store.paths, readConfig: store.readConfig })
    registry.addProvider({ kind: 'opencode-console', baseUrl: 'https://opencode.ai/console/v1', apiKeyEnv: 'TEST_AGG_KEY' })
    assert.equal(existsSync(store.localPath), true)
    assert.equal(existsSync(store.paths.keys), false)
    const local = store.readLocal()
    assert.equal(local.configVersion, 1)
    assert.equal(local.providers.console.aggregation.schema, 'modelgate.aggregation.provider/1')
    assert.equal(local.providers.console.aggregation.keyRef, 'env:TEST_AGG_KEY')
  } finally { rmSync(store.dir, { recursive: true, force: true }) }
})
