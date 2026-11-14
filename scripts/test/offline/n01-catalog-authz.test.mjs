// N01：统一目录（同代快照/证据过期/别名/角色样例）与只读配置出口的离线契约测试。
// 纯本地：无网络、不读用户配置、不写全局文件。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as C from '../../../src/codex/catalog.js'
import * as G from '../../../src/codex/catalog-generation.js'
import { createRouter } from '../../../src/router.js'
import { buildDesiredCodexConfig, exportClientTemplate, clientConfigDrift } from '../../../src/codex/config.js'

function level(effort) {
  return { effort, description: effort + ' reasoning' }
}

function officialModel(overrides = {}) {
  return {
    slug: 'gpt-test-sol',
    display_name: 'GPT Test Sol',
    description: 'Official fixture model',
    default_reasoning_level: 'low',
    supported_reasoning_levels: [level('low'), level('medium'), level('high')],
    shell_type: 'unified_exec',
    visibility: 'list',
    supported_in_api: true,
    priority: 1,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    default_reasoning_summary: 'none',
    support_verbosity: true,
    default_verbosity: 'low',
    apply_patch_tool_type: 'freeform',
    web_search_tool_type: 'text_and_image',
    truncation_policy: { mode: 'tokens', limit: 10000 },
    context_window: 200000,
    max_context_window: 400000,
    effective_context_window_percent: 95,
    experimental_supported_tools: ['clock'],
    input_modalities: ['text', 'image'],
    base_instructions: 'You are Codex, a fixture agent.',
    model_messages: { instructions_template: 'You are Codex, a fixture agent.' },
    ...overrides,
  }
}

function officialCatalog() {
  return { models: [officialModel(), officialModel({ slug: 'gpt-test-fallback', visibility: 'hide', priority: 2 })] }
}

function gatewayConfig(extra = {}) {
  return {
    providers: { 'opencode-go': { name: 'OpenCode Go' } },
    models: {
      'deepseek-v3': {
        provider: 'opencode-go', capability: 'chat', maxContext: 128000,
        effortOptions: ['low', 'medium', 'high'], reasoning: 'medium',
        alias: ['ds3', 'deepseek-latest'],
        ...(extra['deepseek-v3'] || {}),
      },
      'gpt-test-sol': { provider: 'openai' },
    },
  }
}

function build(extra = {}) {
  return C.buildCatalog({ base: officialCatalog(), config: gatewayConfig(extra) })
}

// ---------------------------------------------------------------------------
// 模型证据：来源 + 有效期（fresh/stale/not-recorded）
// ---------------------------------------------------------------------------

test('N01 证据 fresh：能力写入目录，并记录来源/有效期/新鲜度', () => {
  const built = build({
    'deepseek-v3': {
      codex: {
        capabilities: { toolMode: 'code_mode_only' },
        evidence: { toolMode: { source: 'local-mock-contract', observedAt: '2026-11-01', expiresAt: '2027-01-01' } },
      },
    },
  })
  const model = built.catalog.models.find(m => m.slug.startsWith('mg-opencode-go-deepseek-v3'))
  assert.equal(model.tool_mode, 'code_mode_only')
  const meta = built.meta.models.find(m => m.slug === model.slug)
  assert.equal(meta.evidence.freshness, 'fresh')
  assert.equal(meta.evidence.capabilities.toolMode.source, 'local-mock-contract')
  assert.equal(meta.evidence.capabilities.toolMode.freshness, 'fresh')
  assert.equal(meta.sources.capabilities.freshness, 'fresh')
  assert.equal(meta.sources.capabilities.stale.length, 0)
})

test('N01 证据过期：不写入能力字段，保留 stale 证据与 warning（stale ≠ proven）', () => {
  const built = build({
    'deepseek-v3': {
      codex: {
        capabilities: { toolMode: 'code_mode_only' },
        evidence: { toolMode: { source: 'local-mock-contract', observedAt: '2026-09-01', expiresAt: '2026-10-01' } },
      },
    },
  })
  const model = built.catalog.models.find(m => m.slug.startsWith('mg-opencode-go-deepseek-v3'))
  assert.equal(model.tool_mode, undefined, '过期证据不得继续支撑能力声明')
  const meta = built.meta.models.find(m => m.slug === model.slug)
  assert.equal(meta.evidence.freshness, 'stale')
  assert.ok(Object.keys(meta.evidence.stale).length > 0, '过期证据仍保留可观察记录')
  assert.equal(meta.sources.capabilities.freshness, 'stale')
  assert.ok(meta.warnings.some(w => w.code === 'capability_evidence_stale'))
  assert.ok(built.meta.warnings.some(w => w.code === 'capability_evidence_stale'))
})

test('N01 证据未写有效期：能力保留但标 not-recorded，便于管理面观察', () => {
  const built = build({
    'deepseek-v3': {
      codex: {
        capabilities: { toolMode: 'code_mode_only' },
        evidence: { toolMode: { source: 'local-mock-contract', observedAt: '2026-11-01' } },
      },
    },
  })
  const model = built.catalog.models.find(m => m.slug.startsWith('mg-opencode-go-deepseek-v3'))
  assert.equal(model.tool_mode, 'code_mode_only')
  const meta = built.meta.models.find(m => m.slug === model.slug)
  assert.equal(meta.evidence.freshness, 'not-recorded')
  assert.equal(meta.evidence.capabilities.toolMode.freshness, 'not-recorded')
})

test('N01 证据格式非法（expiresAt 非日期）fail-closed', () => {
  assert.throws(() => build({
    'deepseek-v3': {
      codex: {
        capabilities: { toolMode: 'code_mode_only' },
        evidence: { toolMode: { source: 's', observedAt: '2026-11-01', expiresAt: 'later' } },
      },
    },
  }), err => err.code === 'capability_evidence_invalid')
})

// ---------------------------------------------------------------------------
// 同代目录：别名、完整性、快照 pin
// ---------------------------------------------------------------------------

test('N01 目录视图携带同代别名，并通过完整性判据', () => {
  const rec = G.buildGenerationRecord({ generation: 5, base: officialCatalog(), config: gatewayConfig() })
  const view = G.toCatalogView(rec)
  assert.equal(view.complete, true)
  const slug = Object.keys(view.bindings).find(s => view.bindings[s].model === 'deepseek-v3')
  assert.equal(view.aliases.ds3.model, slug, '别名必须指向目录内同代 ID，而不是另一套命名')
  assert.equal(view.aliases.ds3.sourceModel, 'deepseek-v3')
  assert.equal(view.aliases['deepseek-latest'].model, slug)
  assert.equal(G.catalogViewCompleteness(view).ok, true)

  const bad = G.catalogViewCompleteness(Object.assign({}, view, { models: [] }))
  assert.equal(bad.ok, false)
  assert.ok(bad.issues.includes('models_empty'))
})

test('N01 快照 pin：不可变、同代判定、拒绝不完整目录', () => {
  const rec = G.buildGenerationRecord({ generation: 5, base: officialCatalog(), config: gatewayConfig() })
  const snap = G.pinCatalogSnapshot(rec)
  assert.equal(snap.generation, 5)
  assert.equal(snap.key, rec.key)
  assert.equal(snap.complete, true)
  assert.equal(Object.isFrozen(snap), true)
  assert.equal(Object.isFrozen(snap.view), true)
  assert.equal(G.sameCatalogGeneration(snap, G.pinCatalogSnapshot(rec)), true)

  const rec6 = G.buildGenerationRecord({ generation: 6, base: officialCatalog(), config: gatewayConfig({ 'deepseek-v3': { displayName: 'x' } }) })
  assert.equal(G.sameCatalogGeneration(snap, G.pinCatalogSnapshot(rec6)), false)

  const broken = Object.assign({}, G.toCatalogView(rec), { complete: false, models: [], incompleteReasons: ['models_empty'] })
  assert.throws(() => G.pinCatalogSnapshot(broken), err => err.code === 'catalog_snapshot_incomplete')
  // 显式 allowIncomplete 只用于诊断，不用于路由（路由端仍会拒绝）。
  const brokenSnap = G.pinCatalogSnapshot(broken, { allowIncomplete: true })
  assert.equal(brokenSnap.complete, false)
})

// ---------------------------------------------------------------------------
// 路由：固定快照（同代）、下架零上游、别名同代解析
// ---------------------------------------------------------------------------

function routerFixture() {
  const rec = G.buildGenerationRecord({ generation: 7, base: officialCatalog(), config: gatewayConfig() })
  const view = G.toCatalogView(rec)
  const cfg = { defaults: { codexOfficialProvider: 'official' }, providers: { 'opencode-go': { baseUrl: 'http://127.0.0.1:1' }, official: {} }, models: gatewayConfig().models, _codexCatalog: view }
  return { rec, view, cfg, slug: Object.keys(view.bindings).find(s => view.bindings[s].model === 'deepseek-v3') }
}

test('N01 固定快照：目录换代后，旧快照仍按旧代解析（不混代）', () => {
  const { view, cfg, slug } = routerFixture()
  const router = createRouter(cfg)
  const snap = G.pinCatalogSnapshot(view)
  const before = router.resolve(slug, { snapshot: snap })
  assert.equal(before.catalogGeneration, 7)
  assert.equal(before.def.provider, 'opencode-go')
  assert.equal(before.def.servingModel, 'deepseek-v3')

  // 换代：新视图不再包含该 slug（模拟下架/改名）。
  cfg._codexCatalog = Object.freeze({
    key: 'new-key', generation: 8, models: [{ slug: 'gpt-test-sol' }],
    bindings: {}, officialSlugs: ['gpt-test-sol'], aliases: {}, retiredSlugs: [], complete: true,
  })
  const pinned = G.pinCatalogSnapshot(view)
  assert.equal(router.resolvePinned(slug, pinned).catalogGeneration, 7, '固定快照必须仍用 7 代')
  assert.throws(() => router.resolve(slug), err => err.code === 'unknown_model', '未固定时不得用下架后的目录继续解析')
})

test('N01 下架模型零上游：墓碑优先，且不回落默认上游', () => {
  const { view, cfg, slug } = routerFixture()
  const router = createRouter(cfg)
  const retiredView = G.toCatalogView(G.buildGenerationRecord({ generation: 9, base: officialCatalog(), config: gatewayConfig() }), { retiredSlugs: [slug] })
  assert.equal(retiredView.retiredSlugs.includes(slug), true)
  const snap = G.pinCatalogSnapshot(retiredView)
  assert.throws(() => router.resolvePinned(slug, snap), err => err.code === 'unknown_model' && err.reason === 'catalog_slug_retired' && err.status === 404)
  // 把同样的墓碑视图装进 live 配置：非固定解析也必须零上游拒绝，且不回落 defaults.provider。
  cfg._codexCatalog = retiredView
  const router2 = createRouter(cfg)
  assert.throws(() => router2.resolve(slug), err => err.code === 'unknown_model' && err.reason === 'catalog_slug_retired')
})

test('N01 同代别名解析：返回 aliasTarget + generation，目标缺失/墓碑 fail-closed', () => {
  const { view, cfg } = routerFixture()
  const router = createRouter(cfg)
  const snap = G.pinCatalogSnapshot(view)
  const slug = Object.keys(view.bindings).find(s => view.bindings[s].model === 'deepseek-v3')
  const hit = router.resolvePinned('ds3', snap)
  assert.equal(hit.canonicalName, 'ds3')
  assert.equal(hit.aliasTarget, slug)
  assert.equal(hit.catalogGeneration, 7)
  assert.equal(hit.def.servingModel, 'deepseek-v3')

  // 别名指向墓碑（构造快照，绕过完整性判据的 pin 以便命中路由器自己的 fail-closed 分支）
  const base = { generation: 7, key: view.key, view: Object.assign({}, view, { retiredSlugs: [slug] }) }
  assert.throws(() => router.resolvePinned('ds3', base), err => err.reason === 'catalog_slug_retired' || err.reason === 'alias_to_retired_id')

  const missing = { generation: 7, key: view.key, view: Object.assign({}, view, { aliases: { ghost: { model: 'no-such-model' } }, retiredSlugs: [] }) }
  assert.throws(() => router.resolvePinned('ghost', missing), err => err.reason === 'alias_target_missing')
})

test('N01 不完整快照：路由前 fail-closed（零上游）', () => {
  const { cfg } = routerFixture()
  const router = createRouter(cfg)
  const snap = { generation: 7, key: 'k', view: { generation: 7, models: [], complete: false, incompleteReasons: ['models_empty'] } }
  assert.throws(() => router.resolvePinned('anything', snap), err => err.code === 'unknown_model' && err.reason === 'catalog_snapshot_incomplete')
  assert.throws(() => router.resolvePinned('anything', { generation: 7, key: 'k', view: { generation: 7, models: [], complete: true } }), err => err.reason === 'catalog_snapshot_invalid')
})

// ---------------------------------------------------------------------------
// 客户端出口：只读模板 + 可观察 drift
// ---------------------------------------------------------------------------

test('N01 只读模板：profile/别名/显式角色样例，明确标注 provider 覆盖不支持', () => {
  const tpl = exportClientTemplate({
    openaiBaseUrl: 'http://127.0.0.1:9999', model: 'mg-opencode-go-deepseek-v3',
    modelCatalogJsonPath: '/tmp/isolated/catalog.json', profile: 'mg-aggregate',
    role: 'mg-readonly-child', aliases: [{ alias: 'ds3', model: 'deepseek-v3' }],
  })
  assert.equal(tpl.readOnly, true)
  assert.equal(tpl.writesFiles, false)
  assert.match(tpl.text, /model = "mg-opencode-go-deepseek-v3"/)
  assert.match(tpl.text, /model_provider = "openai"/)
  assert.match(tpl.text, /openai_base_url = "http:\/\/127\.0\.0\.1:9999"/)
  assert.match(tpl.text, /model_catalog_json = "\/tmp\/isolated\/catalog\.json"/)
  assert.match(tpl.text, /# alias ds3 -> deepseek-v3/)
  assert.match(tpl.text, /# name = "mg-readonly-child"/)
  assert.equal(tpl.samples.role.providerOverride, 'unsupported')
  assert.ok(tpl.samples.role.reason.includes('inherits-provider'))
  assert.ok(tpl.notes.some(n => n.includes('只读模板')))
})

test('N01 可观察 drift：逐字段对比，匹配=零 drift、改值=可观察且脱敏', () => {
  const opts = { openaiBaseUrl: 'http://127.0.0.1:9999', model: 'mg-opencode-go-deepseek-v3' }
  const desired = buildDesiredCodexConfig(opts)
  const matching = [
    'model = "mg-opencode-go-deepseek-v3"',
    'model_provider = "openai"',
    'openai_base_url = "http://127.0.0.1:9999"',
  ].join('\n') + '\n'
  const clean = clientConfigDrift({ desired: desired.desired, actualText: matching })
  assert.equal(clean.drift, false)
  assert.deepEqual(clean.fields, [])
  assert.equal(clean.readOnly, true)

  const drifted = clientConfigDrift({ desired: desired.desired, actualText: matching.replace('mg-opencode-go-deepseek-v3', 'gpt-some-other') })
  assert.equal(drifted.drift, true)
  assert.deepEqual(drifted.fields.map(f => f.path), ['model'])
  assert.equal(drifted.fields[0].actual, 'gpt-some-other')
  assert.equal(drifted.fields[0].expected, 'mg-opencode-go-deepseek-v3')

  const missing = clientConfigDrift({ desired: desired.desired, actualText: '' })
  assert.equal(missing.drift, true)
  assert.ok(missing.fields.some(f => f.path === 'openai_base_url' && f.actual === null))
})
