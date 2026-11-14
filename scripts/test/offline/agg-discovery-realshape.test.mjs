// A2 / P01：真实清单形状回归（离线）。
//
// 这些用例把 2026-11-14 live 探针测到的形状固化成契约：
//   1. 上下文窗口在 `limit.context`（单数 limit），不是 `limits.context`；
//   2. `capabilities` 是对象（`tools.supported` 等），不是布尔；
//   3. `canonical_id` 是厂商规范名，不是别名，绝不能折叠模型；
//   4. 200 + text/html 必须被拒绝，绝不当成空目录；
//   5. 协议不支持的模型：发现、计数、暴露，但不发布为可调用模型；
//   6. Go 清单不随凭据变化 → authBasis=unverified，不宣称已授权。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CACHE_SCHEMA, COMPLETENESS, ROUTABLE_PROTOCOLS, contextWindowOf, createDiscoveryEngine,
  createMemorySnapshotStore, normalizeModelEntry,
} from '../../../src/aggregation/discovery.js'
import { createAggregatedCatalog } from '../../../src/aggregation/catalog.js'
import { createAggregationHandlers } from '../../../src/aggregation/handlers.js'
import { DEFAULT_MODEL_LIST_URL } from '../../../src/providers/opencode-console.js'
import {
  cacheEntry, consoleProvider, goProvider, jsonResponse, readFixture, tempDir, textResponse,
} from '../fixtures/agg-a2/helpers.mjs'
import { listing, realModelEntry } from '../fixtures/agg-a2/real-models.mjs'

const T = Date.parse('2026-11-14T12:00:00.000Z')
const CRED = 'test-key-not-real-never-log'
const BASE = readFixture('base-catalog.json')

function engine(fetchImpl, options = {}) {
  return createDiscoveryEngine({
    fetchImpl,
    cfg: {},
    cacheStore: options.cacheStore || createMemorySnapshotStore(),
    now: () => T,
    maxPages: options.maxPages || 20,
  })
}

function staticFetch(body) {
  return async () => jsonResponse(body)
}

function providersFor(catalogDir) {
  const cacheStore = createMemorySnapshotStore()
  const console = consoleProvider()
  const go = goProvider()
  const pub = createAggregatedCatalog({
    registry: { listProviders: () => [console, go] },
    cacheStore,
    dir: catalogDir,
    readConfig: () => ({ defaults: {}, server: {} }),
  })
  return { cacheStore, console, go, publisher: pub }
}

async function discoverInto(cacheStore, provider, body) {
  const result = await engine(staticFetch(body), { cacheStore }).discover(provider, { credential: CRED, scope: 'local' })
  assert.equal(result.ok, true, 'discovery 应成功：' + (result.code || ''))
  cacheStore.put('local', provider.id, cacheEntry(result.snapshot, { storedAt: T }))
  return result
}

test('上下文窗口：limit.context 为主来源，其余别名回退，缺失仍为 null', () => {
  assert.equal(contextWindowOf({ limit: { context: 200000, input: 160000, output: 32000 } }), 200000)
  assert.equal(contextWindowOf({ limits: { context: 131072 } }), 131072)
  assert.equal(contextWindowOf({ context_window_tokens: 65536 }), 65536)
  assert.equal(contextWindowOf({ context_window: 8192 }), 8192)
  assert.equal(contextWindowOf({ max_context_tokens: 4096 }), 4096)
  assert.equal(contextWindowOf({ id: 'x' }), null)

  const normalized = normalizeModelEntry({ id: 'm', name: 'M', limit: { context: 1050000 } }, { providerId: 'console', providerSegment: 'console' })
  assert.equal(normalized.ok, true)
  assert.equal(normalized.model.contextWindow, 1050000)
})

test('能力：capabilities 对象形状与裸布尔都识别，缺席为 false', () => {
  const objectShape = normalizeModelEntry({
    id: 'm',
    capabilities: {
      tools: { supported: true },
      reasoning: { supported: true },
      structured_output: { supported: true },
      effort_updates: { supported: true },
    },
  }, { providerId: 'console', providerSegment: 'console' })
  assert.equal(objectShape.model.capabilities.tools, true)
  assert.equal(objectShape.model.capabilities.reasoning, true)
  assert.equal(objectShape.model.capabilities.structuredOutput, true)
  assert.equal(objectShape.model.capabilities.effortUpdates, true)

  const bare = normalizeModelEntry({ id: 'm2', tools: true, supports_tools: false }, { providerId: 'console', providerSegment: 'console' })
  assert.equal(bare.model.capabilities.tools, true)

  const none = normalizeModelEntry({ id: 'm3' }, { providerId: 'console', providerSegment: 'console' })
  assert.equal(none.model.capabilities.tools, false)
  assert.equal(none.model.capabilities.reasoning, false)
  assert.equal(none.model.capabilities.structuredOutput, false)
  assert.equal(none.model.capabilities.effortUpdates, false)

  const declaredFalse = normalizeModelEntry({ id: 'm4', capabilities: { tools: { supported: false } } }, { providerId: 'console', providerSegment: 'console' })
  assert.equal(declaredFalse.model.capabilities.tools, false)
})

test('canonical_id 不等于别名：两个模型共享 canonical_id 仍各自存活', async () => {
  const body = {
    object: 'list',
    data: [
      realModelEntry({ id: 'twin-a', canonicalId: 'vendor/shared-1017' }),
      realModelEntry({ id: 'twin-b', canonicalId: 'vendor/shared-1017' }),
    ],
  }
  const calls = []
  const fetchImpl = async (url) => { calls.push(url); return jsonResponse(body) }
  const result = await engine(fetchImpl).discover(consoleProvider(), { credential: CRED, scope: 's1' })
  assert.equal(result.snapshot.models.length, 2)
  assert.deepEqual(result.snapshot.models.map((m) => m.upstreamId).sort(), ['twin-a', 'twin-b'])
  const ids = result.snapshot.models.map((m) => m.publicId)
  assert.equal(new Set(ids).size, 2)
  assert.equal(result.counts.aliases, 0)
  assert.ok(!result.diagnostics.some((d) => d.code === 'alias_target_missing'))
  for (const m of result.snapshot.models) assert.equal(m.vendorCanonical, 'vendor/shared-1017')
})

test('显式 alias 字段仍然可以折叠（只有显式字段允许）', async () => {
  const body = {
    object: 'list',
    data: [
      { id: 'canonical-model', name: 'Canonical', limit: { context: 128000 } },
      { id: 'alias-model', name: 'Alias', alias_of: 'canonical-model', limit: { context: 128000 } },
    ],
  }
  const result = await engine(staticFetch(body)).discover(consoleProvider(), { credential: CRED, scope: 's1' })
  assert.equal(result.snapshot.models.length, 1)
  assert.equal(result.counts.aliases, 1)
  assert.ok(result.diagnostics.some((d) => d.code === 'alias_collapsed'))
})

test('200 + text/html：显式拒绝并报 content-type，绝不解析成空目录', async () => {
  const fetchImpl = async () => textResponse('<!doctype html><html><body>SPA</body></html>', {
    status: 200, headers: { 'content-type': 'text/html; charset=utf-8' },
  })
  const result = await engine(fetchImpl).discover(consoleProvider(), { credential: CRED, scope: 's1' })
  assert.equal(result.ok, false)
  assert.equal(result.completeness, COMPLETENESS.FAILED)
  assert.equal(result.code, 'discovery_response_invalid')
  assert.equal(result.snapshot, null)
  assert.equal(result.counts.discovered, 0)
  const diag = result.diagnostics.find((d) => d.code === 'discovery_response_invalid')
  assert.match(diag.message, /text\/html/)
  assert.equal(diag.contentType, 'text/html; charset=utf-8')
})

test('协议分类：messages/generate-content 不可路由，openai/responses 可路由', async () => {
  const fixture = readFixture('real-console-models.json')
  const result = await engine(staticFetch(fixture)).discover(consoleProvider(), { credential: CRED, scope: 's1' })
  const byId = new Map(result.snapshot.models.map((m) => [m.upstreamId, m]))
  assert.equal(byId.get('fixture-openai-chat').protocol, 'openai')
  assert.equal(byId.get('fixture-openai-chat').routable, true)
  assert.equal(byId.get('fixture-openai-chat').apiBaseUrl, 'https://opencode.ai/inference/openai/v1')
  assert.equal(byId.get('fixture-openai-responses').protocol, 'responses')
  assert.equal(byId.get('fixture-openai-responses').routable, true)
  assert.equal(byId.get('fixture-anthropic-messages').protocol, 'anthropic-messages')
  assert.equal(byId.get('fixture-anthropic-messages').routable, false)
  assert.equal(byId.get('fixture-google-generate').protocol, 'google-generate-content')
  assert.equal(byId.get('fixture-google-generate').routable, false)
  assert.deepEqual(ROUTABLE_PROTOCOLS, ['openai', 'responses'])
  assert.equal(result.counts.notRoutable, 2)
  const diag = result.diagnostics.find((d) => d.code === 'discovered_not_routable')
  assert.equal(diag.count, 2)
  assert.deepEqual(diag.upstreamIds.sort(), ['fixture-anthropic-messages', 'fixture-google-generate'])
})

test('Go 授权：清单不随凭据变化 → authBasis=unverified；Console 仍是 listed', async () => {
  const goModels = readFixture('real-go-models.json')
  const go = await engine(staticFetch(goModels)).discover(goProvider(), { credential: CRED, scope: 's1' })
  assert.equal(go.snapshot.models.length, 2)
  for (const m of go.snapshot.models) {
    assert.equal(m.authBasis, 'unverified')
    assert.equal(m.authorized, true)
  }
  assert.equal(go.counts.authorizationUnverified, 2)
  assert.ok(go.diagnostics.some((d) => d.code === 'authorization_unverified_from_listing'))
  assert.ok(!go.diagnostics.some((d) => d.code === 'authorization_inferred_from_listing'))

  const consoleModels = readFixture('real-console-models.json')
  const con = await engine(staticFetch(consoleModels)).discover(consoleProvider(), { credential: CRED, scope: 's1' })
  for (const m of con.snapshot.models) assert.equal(m.authBasis, 'listed')
  assert.equal(con.counts.authorizationUnverified, 0)
  assert.ok(con.diagnostics.some((d) => d.code === 'authorization_inferred_from_listing'))
})

test('发布：真实形状 + 全协议可路由 → 1 官方 + 50 + 30 = 81，无 context_window_missing', async () => {
  const dir = tempDir('mg-agg-realshape-')
  const { cacheStore, console, go, publisher } = providersFor(dir)
  await discoverInto(cacheStore, console, listing(50, { nonRoutable: 0 }))
  await discoverInto(cacheStore, go, listing(30, { scope: 'go', nonRoutable: 0 }))
  const res = await publisher.publish('local', { base: BASE })
  assert.equal(res.modelCount, 81)
  assert.equal(res.reconciliation.discovered, 80)
  assert.equal(res.reconciliation.published, 80)
  assert.equal(res.reconciliation.missingContext, 0)
  assert.equal(res.reconciliation.notRoutable, 0)
  assert.ok(!res.diagnostics.some((d) => d.code === 'context_window_missing'))
  const slugs = res.reconciliation.modelIds
  assert.equal(new Set(slugs).size, slugs.length)
  assert.equal(slugs.filter((s) => s.startsWith('mg-console-')).length, 50)
  assert.equal(slugs.filter((s) => s.startsWith('mg-opencodego-')).length, 30)
})

test('发布：协议不支持的 20 个模型被排除但显式计数，绝不静默丢弃', async () => {
  const dir = tempDir('mg-agg-realshape-')
  const { cacheStore, console, go, publisher } = providersFor(dir)
  // 实测比例：console 50 条中 14 条非 openai（9 messages + 5 generate-content）；
  // go 30 条中 6 条（5 messages + 1 generate-content）。
  await discoverInto(cacheStore, console, listing(50, { nonRoutable: 14, anthropic: 9 }))
  await discoverInto(cacheStore, go, listing(30, { scope: 'go', nonRoutable: 6, anthropic: 5 }))
  const res = await publisher.publish('local', { base: BASE })
  assert.equal(res.modelCount, 61)
  assert.equal(res.reconciliation.discovered, 80)
  assert.equal(res.reconciliation.published, 60)
  assert.equal(res.reconciliation.notRoutable, 20)
  assert.equal(res.reconciliation.notRoutableIds.length, 20)
  assert.equal(res.reconciliation.missingContext, 0)
  const diag = res.diagnostics.find((d) => d.code === 'discovered_not_routable')
  assert.equal(diag.count, 20)
  // 非可路由模型不得出现在已发布目录里（按精确公共 ID 判定，避免后缀误判）。
  for (const item of diag.items) assert.ok(!res.reconciliation.modelIds.includes(item.publicId), item.publicId + ' 不应被发布')
})

test('HTTP 面：/models 与 /health 暴露 discovered-but-not-routable 的计数与 ID', async () => {
  const dir = tempDir('mg-agg-realshape-')
  const { cacheStore, console, go, publisher } = providersFor(dir)
  await discoverInto(cacheStore, console, listing(50, { nonRoutable: 14, anthropic: 9 }))
  await discoverInto(cacheStore, go, listing(30, { scope: 'go', nonRoutable: 6, anthropic: 5 }))
  await publisher.publish('local', { base: BASE })
  const handlers = createAggregationHandlers({
    registry: { listProviders: () => [console, go] },
    discovery: { cacheStore },
    catalog: publisher,
    readConfig: () => ({ defaults: {}, server: {} }),
  })
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } }
  const models = handlers.listModels(req, {}, { explicitAdmin: true })
  assert.equal(models.status, 200)
  assert.equal(models.body.notRoutable.count, 20)
  assert.equal(models.body.notRoutable.byProvider.console.length, 14)
  assert.equal(models.body.notRoutable.byProvider.opencodego.length, 6)
  assert.match(models.body.notRoutable.note, /不发布/)

  const health = handlers.health(req, {}, { explicitAdmin: true })
  assert.equal(health.status, 200)
  assert.equal(health.body.notRoutable.count, 20)
  const goHealth = health.body.providers.find((p) => p.id === 'opencodego')
  assert.equal(goHealth.notRoutable.count, 6)
  assert.equal(goHealth.routable, 24)
  assert.equal(goHealth.authorization.unverified, 30)
  assert.equal(health.body.authorizationUnverified, 30)
})

test('向后兼容：没有 routable 字段的旧快照仍按可路由处理', async () => {
  const dir = tempDir('mg-agg-realshape-')
  const { cacheStore, console, publisher } = providersFor(dir)
  const legacy = {
    object: 'list',
    data: [
      { id: 'legacy-a', name: 'Legacy A', context_window: 128000 },
      { id: 'legacy-b', name: 'Legacy B', context_window: 200000 },
    ],
  }
  await discoverInto(cacheStore, console, legacy)
  const entry = cacheStore.get('local', 'console')
  const snap = Object.assign({}, entry.snapshot, {
    models: entry.snapshot.models.map((m) => Object.assign({}, m, { routable: undefined, protocol: undefined })),
  })
  cacheStore.put('local', 'console', Object.assign({}, entry, { snapshot: snap }))
  const go = goProvider()
  const pub = createAggregatedCatalog({
    registry: { listProviders: () => [console] },
    cacheStore,
    dir,
    readConfig: () => ({ defaults: {}, server: {} }),
  })
  const res = await pub.publish('local', { base: BASE })
  assert.equal(res.reconciliation.published, 2)
  assert.equal(res.reconciliation.notRoutable, 0)
})

test('console 默认清单端点是实测 zen 端点', () => {
  assert.equal(DEFAULT_MODEL_LIST_URL, 'https://opencode.ai/zen/v1/models')
})
