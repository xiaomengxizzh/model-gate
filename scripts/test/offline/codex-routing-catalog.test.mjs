// E2×E3 路由整合（task-6）：router.resolve 认识 Codex 目录的两类 slug（官方 / 聚合），
// 同时保持 E1 的严格闸门（mg-/mg/ 未命中 404，不回退 defaults.provider）。
// 全部离线：目录视图直接在测试里构造（cfg._codexCatalog），不依赖真实 745KB 目录文件；
// 唯一端到端用例使用极小合成基线 + 本地 mock 上游 + OS 临时目录。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRouter, modelTarget, codexBindingFor, isCodexOfficialSlug } from '../../../src/router.js'
import { buildCatalog } from '../../../src/codex/catalog.js'
import * as G from '../../../src/codex/catalog-generation.js'
import { startGateway, startScriptedUpstream } from './harness.mjs'

const OFFICIAL_SLUG = 'gpt-test-sol'
const BINDING_SLUG = 'mg-third-vendor-chat'

function catalogView(over) {
  return Object.assign({
    officialSlugs: [OFFICIAL_SLUG],
    bindings: { [BINDING_SLUG]: { slug: BINDING_SLUG, provider: 'third', model: 'vendor-chat', capability: 'chat' } },
    models: [],
  }, over || {})
}

function cfgWith(over) {
  const cfg = {
    defaults: Object.assign({ provider: 'third', codexOfficialProvider: 'official' }, (over && over.defaults) || {}),
    providers: Object.assign({ official: { baseUrl: 'https://api.openai.com' }, third: { baseUrl: 'http://127.0.0.1:9' } }, (over && over.providers) || {}),
    models: (over && over.models) || {},
    _codexCatalog: over && Object.prototype.hasOwnProperty.call(over, 'catalog') ? over.catalog : catalogView(),
  }
  return cfg
}

const reasonOf = (fn) => {
  try { fn() } catch (e) { return e }
  return null
}

test('官方 slug：不在 config.models 也能解析为官方 responses 路由', () => {
  const r = createRouter(cfgWith())
  const hit = r.resolve(OFFICIAL_SLUG)
  assert.equal(hit.canonicalName, OFFICIAL_SLUG)
  assert.equal(hit.known, true)
  assert.deepEqual(hit.def, { provider: 'official', api: 'responses', codexOfficial: true })
  // 官方模型名就是 slug，上游名不得被改写
  assert.equal(modelTarget(cfgWith(), OFFICIAL_SLUG, 'official').servingName, OFFICIAL_SLUG)
})

test('聚合 slug：绑定 provider + 原模型名，providerModels/servingModel 供转发与探活共用', () => {
  const cfg = cfgWith()
  const r = createRouter(cfg)
  const hit = r.resolve(BINDING_SLUG)
  assert.equal(hit.known, true)
  assert.deepEqual(hit.def, {
    provider: 'third',
    api: 'openai',
    providerModels: { third: 'vendor-chat' },
    codexAggregate: true,
    servingModel: 'vendor-chat',
    capability: 'chat',
  })
  const target = modelTarget(cfg, BINDING_SLUG, 'third')
  assert.equal(target.servingName, 'vendor-chat', '上游必须收到绑定里的原模型名')
  assert.equal(target.api, 'openai')
  // 其它上游不套用本绑定映射（避免同名不同源）
  assert.equal(modelTarget(cfg, BINDING_SLUG, 'other').servingName, BINDING_SLUG)
  assert.equal(codexBindingFor(cfg, BINDING_SLUG).model, 'vendor-chat')
  assert.equal(isCodexOfficialSlug(cfg, OFFICIAL_SLUG), true)
})

test('聚合 slug 继承原模型能力声明（协议/思考强度/输出上限）', () => {
  const cfg = cfgWith({ models: { 'vendor-chat': { provider: 'third', api: 'openai', effortFormat: 'thinking', maxTokensMax: 4096 } } })
  const hit = createRouter(cfg).resolve(BINDING_SLUG)
  assert.equal(hit.def.providerModels.third, 'vendor-chat')
  const target = modelTarget(cfg, BINDING_SLUG, 'third')
  assert.equal(target.effortFormat, 'thinking')
  assert.equal(target.maxTokensMax, 4096)
})

test('官方 slug 缺 defaults.codexOfficialProvider / 上游不存在：fail-closed，绝不回退 defaults.provider', () => {
  const noDecl = cfgWith({ defaults: { provider: 'third', codexOfficialProvider: '' } })
  const e1 = reasonOf(() => createRouter(noDecl).resolve(OFFICIAL_SLUG))
  assert.equal(e1 && e1.code, 'unknown_model')
  assert.equal(e1.reason, 'official_provider_missing')
  assert.equal(e1.status, 404)

  const missingProvider = cfgWith({ providers: { official: undefined } })
  const e2 = reasonOf(() => createRouter(missingProvider).resolve(OFFICIAL_SLUG))
  assert.equal(e2 && e2.reason, 'official_provider_missing')
})

test('绑定损坏 / 上游不存在：fail-closed（catalog_binding_invalid），不回退默认上游', () => {
  const broken = cfgWith({ catalog: catalogView({ bindings: { [BINDING_SLUG]: { model: 'vendor-chat' } } }) })
  const e1 = reasonOf(() => createRouter(broken).resolve(BINDING_SLUG))
  assert.equal(e1 && e1.code, 'unknown_model')
  assert.equal(e1.reason, 'catalog_binding_invalid')

  const unknownProvider = cfgWith({ catalog: catalogView({ bindings: { [BINDING_SLUG]: { slug: BINDING_SLUG, provider: 'ghost', model: 'vendor-chat' } } }) })
  assert.equal(reasonOf(() => createRouter(unknownProvider).resolve(BINDING_SLUG)).reason, 'catalog_binding_invalid')
})

test('冲突检测：目录 slug 同时被 config.models/别名声明 → 判 unknown（两侧都不静默胜出）', () => {
  const officialClash = cfgWith({ models: { [OFFICIAL_SLUG]: { provider: 'third' } } })
  const e1 = reasonOf(() => createRouter(officialClash).resolve(OFFICIAL_SLUG))
  assert.equal(e1 && e1.code, 'unknown_model')
  assert.equal(e1.reason, 'catalog_slug_conflicts_with_models')

  const bindingClash = cfgWith({ models: { [BINDING_SLUG]: { provider: 'third' } } })
  const e2 = reasonOf(() => createRouter(bindingClash).resolve(BINDING_SLUG))
  assert.equal(e2 && e2.reason, 'catalog_slug_conflicts_with_models')
})

test('严格性不变：mg-/mg/ 未命中仍 404，无目录时与 E1 完全一致', () => {
  for (const noCatalog of [cfgWith({ catalog: null }), cfgWith({ catalog: undefined })]) {
    const r = createRouter(noCatalog)
    for (const ghost of ['mg-ghost-model', 'mg/ghost/model']) {
      const e = reasonOf(() => r.resolve(ghost))
      assert.equal(e && e.code, 'unknown_model', ghost)
      assert.equal(e.status, 404)
      assert.equal(e.aggregate, true)
    }
    // 非保留前缀的未知模型维持旧兜底
    assert.deepEqual(r.resolve('legacy-unknown').def, { provider: 'third' })
    // 已配置模型与别名不受影响
    assert.equal(createRouter(cfgWith({ catalog: null, models: { m: { provider: 'third', alias: ['mm'] } } })).resolve('mm').canonicalName, 'm')
  }
  // 有目录但 mg- 前缀不在 bindings 里 → 仍 404，且不会借用目录里的官方/provider
  const withCatalog = createRouter(cfgWith())
  const e = reasonOf(() => withCatalog.resolve('mg-ghost-model'))
  assert.equal(e && e.code, 'unknown_model')
  assert.equal(e.reason, undefined)
})

test('目录结构与注入时序：懒失效（先建 router 后注入也生效）与畸形目录安全', () => {
  const cfg = cfgWith({ catalog: null })
  const r = createRouter(cfg)
  assert.equal(reasonOf(() => r.resolve(BINDING_SLUG)).code, 'unknown_model', '未注入前按 E1 严格语义')
  // index.js 在 createRouter 之后注入（加载顺序不保证）
  cfg._codexCatalog = catalogView()
  assert.equal(r.resolve(BINDING_SLUG).def.providerModels.third, 'vendor-chat', '注入后立即生效')
  cfg._codexCatalog = null
  assert.equal(reasonOf(() => r.resolve(BINDING_SLUG)).code, 'unknown_model', '卸载后立即回退 E1 语义')

  const malformed = cfgWith({ catalog: { officialSlugs: 'nope', bindings: null, models: null } })
  const rm = createRouter(malformed)
  assert.deepEqual(rm.resolve('legacy-unknown').def, { provider: 'third' }, '畸形目录不崩、不改变旧兜底')
  const malformedOfficial = rm.resolve(OFFICIAL_SLUG)
  assert.equal(malformedOfficial.known, false)
  assert.deepEqual(malformedOfficial.def, { provider: 'third' }, '畸形目录不把任何 slug 误判为官方')

  const nonString = cfgWith({ catalog: { officialSlugs: [null, 42, OFFICIAL_SLUG], bindings: { [BINDING_SLUG]: null } } })
  const rn = createRouter(nonString)
  assert.equal(rn.resolve(OFFICIAL_SLUG).def.codexOfficial, true, '非字符串条目被过滤')
  assert.equal(reasonOf(() => rn.resolve(BINDING_SLUG)).aggregate, true, '空绑定按聚合未命中 404')
})

test('回归：普通模型的 providerModels 映射仍优先于任何目录推断', () => {
  const cfg = cfgWith({ models: { 'vendor-chat': { provider: 'third', providerModels: { third: 'vendor/real-name' } } } })
  assert.equal(modelTarget(cfg, 'vendor-chat', 'third').servingName, 'vendor/real-name')
  assert.equal(modelTarget(cfg, 'unknown-plain', 'third').servingName, 'unknown-plain')
})

// ---------------------------------------------------------------------------
// 端到端：合成基线目录 → index.js 注入 _codexCatalog → 转发/回写
// ---------------------------------------------------------------------------

function level(effort) { return { effort, description: effort + ' reasoning' } }

function officialModel(overrides = {}) {
  return {
    slug: OFFICIAL_SLUG,
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
    include_skills_usage_instructions: false,
    include_plugin_usage_instructions: false,
    include_apps_usage_instructions: false,
    default_reasoning_summary: 'none',
    support_verbosity: true,
    default_verbosity: 'low',
    apply_patch_tool_type: 'freeform',
    web_search_tool_type: 'text_and_image',
    truncation_policy: { mode: 'tokens', limit: 10000 },
    supports_image_detail_original: true,
    context_window: 200000,
    max_context_window: 400000,
    comp_hash: '1000',
    effective_context_window_percent: 95,
    experimental_supported_tools: ['clock'],
    input_modalities: ['text', 'image'],
    supports_search_tool: true,
    supports_experimental_context: false,
    use_responses_lite: true,
    supports_reasoning_effort_updates: true,
    node_repl_auto_review_required: true,
    node_repl_disabled: false,
    tool_mode: 'code_mode_only',
    multi_agent_version: 'v2',
    multi_agent_reasoning_effort: 'high',
    base_instructions: 'You are Codex, a fixture agent.',
    model_messages: { instructions_template: 'You are Codex, a fixture agent.' },
    ...overrides,
  }
}

// 该用例同时是 E2 目录 → index.js 注入 → router 消费 → forward 转发的整链证据。
// 注意：index.js 目前只在 reloadConfig 注入 _codexCatalog（启动路径没有），因此这里显式触发
// /api/config/reload；启动注入缺口已作为 P0 反馈给 Lead（不在 task-6 写集内）。
test('端到端：目录注入后聚合 slug 上游名/回写，官方 slug 走 /v1/responses，目录 404 严格', { timeout: 30000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mg-codex-routing-'))
  const basePath = join(dir, 'codex-base.json')
  writeFileSync(basePath, JSON.stringify({ models: [officialModel()] }))

  const modelCfg = {
    providers: { gateway: { name: 'ModelGate' } },
    models: { 'vendor-chat': { provider: 'gateway', capability: 'chat', maxContext: 128000 } },
    defaults: { codexOfficialProvider: 'official', codexCatalogBasePath: basePath },
  }
  const built = buildCatalog({ base: { models: [officialModel()] }, config: modelCfg })
  const slug = built.meta.bindings && Object.keys(built.meta.bindings)[0]
  assert.ok(slug, '目录应生成至少一个聚合 slug')

  const seen = []
  const third = await startScriptedUpstream(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    seen.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model: 'vendor-chat', choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
  })
  const officialSeen = []
  const official = await startScriptedUpstream(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    officialSeen.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'resp-1', object: 'response', model: OFFICIAL_SLUG, output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } }))
  })

  const gw = await startGateway({
    name: 'mg-codex-routing',
    config: {
      providers: { gateway: { baseUrl: third.base, apiKeyEnv: '' }, official: { baseUrl: official.base, apiKeyEnv: '' } },
      models: { 'vendor-chat': { provider: 'gateway', capability: 'chat', maxContext: 128000 } },
      defaults: { provider: 'gateway', codexOfficialProvider: 'official', codexCatalogBasePath: basePath },
    },
  })
  t.after(async () => { await gw.stop(); await third.stop(); await official.stop(); rmSync(dir, { recursive: true, force: true }) })

  // 目录 → 注入 → 路由（reload 是 index.js 当前的注入点）
  assert.equal((await gw.post('/api/config/reload', {})).status, 200)

  // 1) 聚合 slug：上游收到绑定里的原模型名，响应 model 回写 slug
  const chat = await gw.post('/v1/chat/completions', { model: slug, messages: [{ role: 'user', content: 'hi' }] }, { 'content-type': 'application/json' })
  assert.equal(chat.status, 200)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, '/v1/chat/completions')
  assert.equal(seen[0].body.model, 'vendor-chat', '上游模型名必须是 binding.model')
  const chatBody = await chat.json()
  assert.equal(chatBody.model, slug, '响应 model 必须回写为聚合 slug（rewriteModel 机制）')

  // 2) 官方 slug：走原生 /v1/responses 且模型名不变
  const resp = await gw.post('/v1/responses', { model: OFFICIAL_SLUG, input: 'hi', stream: false }, { 'content-type': 'application/json' })
  assert.equal(resp.status, 200)
  assert.equal(officialSeen.length, 1)
  assert.equal(officialSeen[0].url, '/v1/responses', '官方 slug 必须走 responses 原生路径')
  assert.equal(officialSeen[0].body.model, OFFICIAL_SLUG)

  // 3) mg- 前缀未命中：404 unknown_model，零上游请求（不回退默认上游）
  const hitsBefore = seen.length
  const ghost = await gw.post('/v1/chat/completions', { model: 'mg-ghost-model', messages: [{ role: 'user', content: 'hi' }] }, { 'content-type': 'application/json' })
  assert.equal(ghost.status, 404)
  assert.equal((await ghost.json()).error.type, 'unknown_model')
  assert.equal(seen.length, hitsBefore, '严格 404 不产生上游请求')
})

// M2-2：注入“带世代”的目录视图后，router 的路由语义不变；未知/墓碑仍是 hard 404。
// （retiredSlugs 的硬拒绝判定在 catalog-generation.resolveCatalogId 中；router 接线属后续卡。）
test('M2-2：世代视图不改变路由语义；未知/墓碑 ID 仍 404 且不回退默认上游', () => {
  const record = G.buildGenerationRecord({
    generation: 9,
    base: { models: [officialModel()] },
    config: { providers: { third: { baseUrl: 'http://127.0.0.1:9' } }, models: { 'vendor-chat': { provider: 'third', maxContext: 128000 } } },
  })
  const view = G.toCatalogView(record, { retiredSlugs: ['mg-third-gone'] })
  assert.equal(view.generation, 9)
  assert.equal(view.key, record.key)

  const cfg = cfgWith({ catalog: view })
  const r = createRouter(cfg)
  assert.deepEqual(r.resolve('gpt-test-sol').def, { provider: 'official', api: 'responses', codexOfficial: true })
  assert.equal(r.resolve('mg-third-vendor-chat').def.codexAggregate, true)

  // 未知 ID / 已下架（视图里无绑定）都走聚合保留前缀硬闸门：404，不回落 defaults.provider
  const retiredView = G.toCatalogView(record, { retiredSlugs: ['mg-third-vendor-chat'] })
  const retiredCfg = cfgWith({ catalog: Object.assign({}, retiredView, { bindings: {} }) })
  const rr = createRouter(retiredCfg)
  for (const id of ['mg-third-vendor-chat', 'mg-third-gone', 'mg-ghost-model']) {
    const e = reasonOf(() => rr.resolve(id))
    assert.equal(e && e.code, 'unknown_model', id)
    assert.equal(e.status, 404)
  }
  assert.deepEqual(rr.resolve('legacy-unknown').def, { provider: 'third' }, '非保留前缀仍维持旧兜底')
})
