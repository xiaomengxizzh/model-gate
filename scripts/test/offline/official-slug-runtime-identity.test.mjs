// 修复「官方 slug 目录身份 vs 运行时身份」不一致（gpt-6-luna 真机 404 / Chat 桥报错）的回归套件。
// 全部离线：目录视图在测试中构造；端到端用例用回环 mock 官方上游，不触达真实 8787、不发付费请求。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRouter, codexOfficialProvider, modelTarget } from '../../../src/router.js'
import { OFFICIAL_PROVIDER_IDS } from '../../../src/codex/catalog.js'
import { classifyTarget, isOfficialTarget } from '../../../src/codex/identity.js'
import { resolveUpstreamProtocol } from '../../../src/codex/chat-compat.js'
import { responsesToChat } from '../../../src/responses.js'
import { projectThirdPartyResponsesParams } from '../../../src/index.js'
import { startGateway, startScriptedUpstream } from './harness.mjs'

const LUNA = 'gpt-6-luna'
const GO = 'mg-opencodego-deepseek-v4-1-flash'

function catalogView (over) {
  return Object.assign({
    officialSlugs: [LUNA],
    bindings: { [GO]: { slug: GO, provider: 'opencodego', model: 'deepseek-v4.1-flash', capability: 'chat' } },
    models: [], aliases: {}, retiredSlugs: [], generation: 1,
  }, over || {})
}

function cfgWith (over) {
  const o = over || {}
  return {
    defaults: Object.assign({ provider: 'opencodego', codexOfficialProvider: '' }, o.defaults || {}),
    providers: Object.assign({
      chatgptplan: { baseUrl: 'https://chatgpt.com', codexIdentity: 'official', api: 'responses' },
      opencodego: { baseUrl: 'https://opencode.ai/inference/go' },
      otherofficial: { baseUrl: 'https://api.openai.com', codexIdentity: 'official' },
    }, o.providers || {}),
    models: o.models || {},
    _codexCatalog: Object.prototype.hasOwnProperty.call(o, 'catalog') ? o.catalog : catalogView(),
  }
}

const reasonOf = (fn) => { try { fn() } catch (e) { return e } ; return null }

test('官方 slug 同名 config.models 且 provider 属 OFFICIAL_PROVIDER_IDS → 官方原生 responses，不落 Chat 桥', () => {
  assert.equal(OFFICIAL_PROVIDER_IDS.includes('chatgptplan'), true, '白名单必须来自 catalog.js 单一真源')
  const cfg = cfgWith({ models: { [LUNA]: { provider: 'chatgptplan', api: 'responses' } } })
  const hit = createRouter(cfg).resolve(LUNA)
  assert.equal(hit.known, true)
  assert.equal(hit.canonicalName, LUNA)
  assert.deepEqual(hit.def, { provider: 'chatgptplan', api: 'responses', codexOfficial: true })

  // 目标身份域 = official；协议选择 = responses（与 index.js 的 proxyOfficialResponses 分支条件逐项一致）。
  const prov = { id: 'chatgptplan', baseUrl: cfg.providers.chatgptplan.baseUrl, _def: cfg.providers.chatgptplan }
  assert.equal(classifyTarget(prov, cfg).kind, 'official')
  assert.equal(isOfficialTarget(prov, cfg), true)
  const nProto = resolveUpstreamProtocol({
    publicId: hit.canonicalName,
    upstreamId: modelTarget(cfg, LUNA, hit.def.provider).servingName,
    protocol: hit.def.api,
  })
  assert.equal(nProto.ok, true)
  assert.equal(nProto.protocol, 'responses')
  assert.equal(modelTarget(cfg, LUNA, 'chatgptplan').servingName, LUNA, '官方上游模型名就是 slug，不改写')

  // Chat 桥会拒绝 previous_response_id；官方 native 契约允许 → 证明必须走原生分支。
  const officialBody = { model: LUNA, input: 'hi', previous_response_id: 'resp_prev_offline', store: true }
  const native = responsesToChat(officialBody, { mode: 'native', nativeContract: { store: true, previous_response_id: true, background: true, truncation: true } })
  assert.equal(native.rejected, null, '官方原生路径不得拒绝续轮字段')
  const bridge = responsesToChat(officialBody)
  assert.equal(bridge.rejected && bridge.rejected.code, 'unsupported_parameter', '若误落 Chat 桥，这里就是真机报错')
})

test('非官方 provider 同名声明仍是身份冲突 → 404，不放行', () => {
  const cfg = cfgWith({ models: { [LUNA]: { provider: 'opencodego', api: 'responses' } } })
  const e = reasonOf(() => createRouter(cfg).resolve(LUNA))
  assert.equal(e && e.code, 'unknown_model')
  assert.equal(e.reason, 'catalog_slug_conflicts_with_models')
  assert.equal(e.status, 404)
})

test('codexOfficialProvider 缺省回退同名官方条目；显式值优先；不猜身份', () => {
  const cfg = cfgWith({ models: { [LUNA]: { provider: 'chatgptplan', api: 'responses' } } })
  assert.equal(codexOfficialProvider(cfg), '', '未给模型名时不得猜测')
  assert.equal(codexOfficialProvider(cfg, LUNA), 'chatgptplan', '缺省回退到同名官方 provider')
  assert.equal(createRouter(cfg).resolve(LUNA).def.provider, 'chatgptplan')

  const explicit = cfgWith({
    defaults: { codexOfficialProvider: 'otherofficial' },
    models: { [LUNA]: { provider: 'chatgptplan', api: 'responses' } },
  })
  assert.equal(codexOfficialProvider(explicit, LUNA), 'otherofficial', '显式配置优先')
  assert.equal(createRouter(explicit).resolve(LUNA).def.provider, 'otherofficial')

  const nonOfficial = cfgWith({ models: { [LUNA]: { provider: 'opencodego' } } })
  assert.equal(codexOfficialProvider(nonOfficial, LUNA), '', '非官方 provider 不参与回退')
})

test('不回归：OpenCode Go 聚合 slug 仍解析到 opencodego / thirdParty', () => {
  const cfg = cfgWith({ models: { [LUNA]: { provider: 'chatgptplan', api: 'responses' } } })
  const hit = createRouter(cfg).resolve(GO)
  assert.equal(hit.def.provider, 'opencodego')
  assert.equal(hit.def.codexAggregate, true)
  assert.equal(hit.def.codexOfficial, undefined)
  assert.equal(hit.def.servingModel, 'deepseek-v4.1-flash')
  const prov = { id: 'opencodego', baseUrl: cfg.providers.opencodego.baseUrl, _def: cfg.providers.opencodego }
  assert.equal(classifyTarget(prov, cfg).kind, 'thirdParty')
})

test('host 白名单收敛：与 identity.js 单一真源一致（chat.openai.com 官方；*.chatgpt.com 不再自动官方）', () => {
  const body = { previous_response_id: 'resp_prev', reasoning: { effort: 'none', context: 'all_turns' } }
  const chatOpenAI = projectThirdPartyResponsesParams(body, { baseUrl: 'https://chat.openai.com' })
  assert.deepEqual(chatOpenAI.dropped, [], 'identity 默认白名单含 chat.openai.com，必须逐字透传')
  const subdomain = projectThirdPartyResponsesParams(body, { baseUrl: 'https://foo.chatgpt.com' })
  assert.ok(subdomain.dropped.includes('reasoning.context'), 'identity 默认白名单不含 *.chatgpt.com，按第三方剔除')
  const officialDeclared = projectThirdPartyResponsesParams(body, { baseUrl: 'https://chatgpt.com', codexIdentity: 'official' })
  assert.deepEqual(officialDeclared.dropped, [])
})

function level (effort) { return { effort, description: effort + ' reasoning' } }
function lunaCatalogModel () {
  return {
    slug: LUNA, display_name: 'GPT Luna', description: 'Official fixture model',
    default_reasoning_level: 'low', supported_reasoning_levels: [level('low'), level('medium')],
    shell_type: 'unified_exec', visibility: 'list', supported_in_api: true, priority: 1,
    additional_speed_tiers: [], service_tiers: [], availability_nux: null, upgrade: null,
    include_skills_usage_instructions: false, include_plugin_usage_instructions: false,
    include_apps_usage_instructions: false, default_reasoning_summary: 'none',
    support_verbosity: true, default_verbosity: 'low', apply_patch_tool_type: 'freeform',
    web_search_tool_type: 'text_and_image', truncation_policy: { mode: 'tokens', limit: 10000 },
    supports_image_detail_original: true, context_window: 200000, max_context_window: 400000,
    comp_hash: '1000', effective_context_window_percent: 95,
    experimental_supported_tools: [], input_modalities: ['text', 'image'],
    supports_search_tool: true, supports_experimental_context: false,
    use_responses_lite: true, supports_reasoning_effort_updates: true,
    node_repl_auto_review_required: false, node_repl_disabled: false,
    tool_mode: 'code_mode_only', multi_agent_version: 'v2', multi_agent_reasoning_effort: 'high',
    base_instructions: 'You are Codex, a fixture agent.',
    model_messages: { instructions_template: 'You are Codex, a fixture agent.' },
  }
}

test('端到端：真实 luna 官方请求（带 previous_response_id）走官方 Responses 原生路径，不触发 Chat 桥', { timeout: 30000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mg-offslug-luna-'))
  const basePath = join(dir, 'codex-base.json')
  writeFileSync(basePath, JSON.stringify({ models: [lunaCatalogModel()] }))

  const officialSeen = []
  const official = await startScriptedUpstream(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    officialSeen.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'resp-1', object: 'response', model: LUNA, output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } }))
  })
  const gw = await startGateway({
    name: 'mg-offslug-luna',
    env: { MG_TEST_OFFICIAL_KEY: 'isolated-official-test-key' },
    config: {
      server: { p0bFailClosedOnReconstructMiss: false },
      providers: {
        chatgptplan: {
          baseUrl: official.base, codexIdentity: 'official', api: 'responses',
          apiKeyEnv: 'MG_TEST_OFFICIAL_KEY',
        },
      },
      models: { [LUNA]: { provider: 'chatgptplan', api: 'responses' } },
      // 关键：没有 defaults.codexOfficialProvider —— 验证缺省回退到 config.models 的官方 provider。
      defaults: { model: '', codexOfficialHosts: ['localhost', '127.0.0.1'], codexCatalogBasePath: basePath },
    },
  })
  t.after(async () => { await gw.stop(); await official.stop(); rmSync(dir, { recursive: true, force: true }) })
  assert.equal((await gw.post('/api/config/reload', {})).status, 200)

  const resp = await gw.post('/v1/responses', {
    model: LUNA,
    input: 'hi',
    previous_response_id: 'resp_prev_offline',
    store: true,
    reasoning: { effort: 'none', context: 'all_turns' },
    text: { verbosity: 'low' },
  }, { 'content-type': 'application/json' })
  assert.equal(resp.status, 200, '带续轮字段的 luna 请求不得被 Chat 桥 400 拒绝')
  assert.equal(officialSeen.length, 1, '必须恰好命中一次官方上游')
  assert.equal(officialSeen[0].url, '/v1/responses', '必须走官方原生 Responses 路径（非 Chat 桥）')
  assert.equal(officialSeen[0].body.model, LUNA)
  assert.deepEqual(officialSeen[0].body.reasoning, { effort: 'none', context: 'all_turns' }, '官方目标逐字透传 ChatGPT 专属参数')
  assert.deepEqual(officialSeen[0].body.text, { verbosity: 'low' })
  const json = await resp.json()
  assert.equal(json.model, LUNA, '响应 model 回写为官方 slug')
})
