// 三种接入模式（直连 official / 路由 route / 聚合 aggregated）核心层离线测试。
// 零网络、零真实密钥：所有 fixture 只含合成占位串；所有网关探测通过注入桩完成。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OFFICIAL_PROVIDER_IDS, buildCatalog, selectThirdPartyModels } from '../../../src/codex/catalog.js'
import {
  OWNED_SECTIONS,
  buildDesiredCodexConfig,
  buildManagedAgentConfig,
  buildManagedProviderSection,
  unmanagedFingerprint,
  withManagedAgentDesired,
} from '../../../src/codex/config.js'
import {
  MODES,
  STATE_SCHEMA,
  activate,
  classifyConfigState,
  computeRestartState,
  deactivate,
  planModeTransition,
  preview,
  previewReconcile,
  reconcileState,
  status,
} from '../../../src/codex/desktop-integration.js'
import {
  AGGREGATION_MODES,
  DEFAULT_PARENT_MODEL,
  DEEPSEEK_CHILD_MODEL,
  ROUTE_MODEL,
  listSelectableParents,
  modeDescriptor,
  resolveModeTarget,
} from '../../../src/codex/profiles.js'

const SYNTHETIC_CATALOG_PATH = '/tmp/mg-three-mode-synthetic-catalog.json'
const USER_CONFIG = [
  '# modelgate three-mode fixture',
  'model = "gpt-6-luna"',
  '',
  '[projects."/home/dev/x"]',
  'trust_level = "trusted"',
  '',
].join('\n')

// —— 目录 fixture（从 codex-catalog.test.mjs 复刻的最小合法官方模型）——
function level (effort) { return { effort, description: effort + ' reasoning' } }
function officialModel (overrides = {}) {
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
function officialCatalog () {
  return { models: [officialModel(), officialModel({ slug: 'gpt-test-hidden', visibility: 'hide', priority: 2 })] }
}

// —— 桌面 fixture ——
function makeFixture (initialText = USER_CONFIG) {
  const root = mkdtempSync(join(tmpdir(), 'mg-three-mode-'))
  const configPath = join(root, 'config.toml')
  const catalogPath = join(root, 'catalog.json')
  const statePath = join(root, '.modelgate-desktop-state.json')
  const managedAgentPath = join(root, 'go-deepseek.toml')
  writeFileSync(configPath, initialText)
  writeFileSync(catalogPath, JSON.stringify({
    models: [{ slug: DEFAULT_PARENT_MODEL }, { slug: ROUTE_MODEL }, { slug: DEEPSEEK_CHILD_MODEL }],
  }))
  const baseOpts = Object.freeze({
    configPath,
    catalogPath,
    statePath,
    managedAgentPath,
    baseUrl: 'http://127.0.0.1:8787',
    clientProbe: false,
    verifyGateway: async () => ({ ok: true, status: 200 }),
  })
  return {
    root, configPath, catalogPath, statePath, managedAgentPath, baseOpts,
    readState: () => JSON.parse(readFileSync(statePath, 'utf8')),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

function writeState (f, record) {
  writeFileSync(f.statePath, JSON.stringify(Object.assign({ schema: STATE_SCHEMA }, record)))
}

// ---------------------------------------------------------------------------
// 1. 目录隔离
// ---------------------------------------------------------------------------
test('目录隔离：坏模型进 invalidModels、目录仍构建、alias 存在；默认严格仍抛错', () => {
  const base = officialCatalog()
  const config = {
    providers: { 'opencode-go': { name: 'OpenCode Go' } },
    models: {
      'good-model': { provider: 'opencode-go', maxContext: 128000, alias: ['go-good'], codex: { contextWindow: 128000 } },
      'bad-model': { provider: 'opencode-go' }, // 缺少正整数上下文窗口
    },
  }
  assert.throws(() => buildCatalog({ base, config }), (e) => e && e.code === 'third_party_context_missing')
  let seen = null
  const built = buildCatalog({
    base, config,
    options: { skipInvalidModels: true, onInvalidModel: (rec) => { seen = rec } },
  })
  assert.equal(built.invalidModels.length, 1)
  assert.equal(built.invalidModels[0].model, 'bad-model')
  assert.equal(built.invalidModels[0].provider, 'opencode-go')
  assert.equal(built.invalidModels[0].code, 'third_party_context_missing')
  assert.ok(seen && seen.code === 'third_party_context_missing')
  assert.ok(built.meta.aliases['go-good'], '好模型的 alias 仍随目录发布')
  assert.ok(built.catalog.models.some((m) => m.slug === built.meta.aliases['go-good'].model))
  assert.ok(built.catalog.models.every((m) => m.slug !== 'mg-opencodego-bad-model'))
})

test('chatgptplan 归位：官方套餐 provider 走 passthrough，11 个 gpt-* 不被当第三方报 official_slug_reuse', () => {
  assert.equal(OFFICIAL_PROVIDER_IDS.includes('chatgptplan'), true,
    'chatgptplan 必须在 OFFICIAL_PROVIDER_IDS，否则官方 gpt-* 会被误判为第三方')
  // 用真实配置里的 chatgptplan 形态：11 个官方 slug 作为 models.*，provider=chatgptplan。
  const officialNames = ['gpt-6-luna', 'gpt-6-sol', 'gpt-5.6-luna', 'gpt-6-astra', 'codex-auto-review']
  const cfg = {
    providers: { chatgptplan: { name: 'ChatGPT Plan' } },
    models: Object.fromEntries(officialNames.map((name) => [name, { provider: 'chatgptplan' }])),
  }
  const { selected, skipped } = selectThirdPartyModels(cfg)
  assert.equal(selected.length, 0, 'chatgptplan 下的官方模型不得进入第三方构建')
  for (const s of skipped) {
    assert.equal(s.reason, 'official_provider_passthrough')
  }
  // 即便与官方 slug 同名也不会触发 official_slug_reuse（ passthrough 先于同名判定）。
  const built = buildCatalog({ base: officialCatalog(), config: cfg })
  assert.equal(built.invalidModels.length, 0)
  assert.equal(built.meta.counts.thirdParty, 0)
})

// ---------------------------------------------------------------------------
// 2. managed 段字节（回环信任、无 Key）
// ---------------------------------------------------------------------------
test('managed 段字节：回环信任字段齐全，无 env_key / bearer token / 明文密钥', () => {
  const sec = buildManagedProviderSection({ openaiBaseUrl: 'http://127.0.0.1:8787' })
  const m = sec.sections['model_providers.modelgate']
  assert.equal(m.name, 'ModelGate')
  assert.equal(m.base_url, 'http://127.0.0.1:8787/v1')
  assert.equal(m.wire_api, 'responses')
  assert.equal(m.requires_openai_auth, false)
  assert.equal(m.supports_websockets, false)
  assert.equal('env_key' in m, false)
  assert.equal('experimental_bearer_token' in m, false)
  assert.equal(sec.sections['model_providers.modelgate.capabilities'].remote_compaction, 'unsupported')
  assert.deepEqual([...OWNED_SECTIONS['model_providers.modelgate']].sort(),
    ['base_url', 'name', 'requires_openai_auth', 'supports_websockets', 'wire_api'])
  assert.equal(/sk-[A-Za-z0-9_-]{8,}/.test(JSON.stringify(sec)), false)
})

// ---------------------------------------------------------------------------
// 3. 父/子解耦
// ---------------------------------------------------------------------------
test('父/子解耦：gpt-parent 父 luna 子 deepseek 别名；route 父子同为路由别名', () => {
  assert.deepEqual([...AGGREGATION_MODES], ['official', 'route', 'aggregated'])
  assert.deepEqual([...MODES], ['official', 'route', 'aggregated', 'unknown'])
  const agg = resolveModeTarget({ mode: 'aggregated' })
  assert.equal(agg.parentModel, DEFAULT_PARENT_MODEL)
  assert.equal(agg.childModel, DEEPSEEK_CHILD_MODEL)
  assert.equal(agg.model, DEFAULT_PARENT_MODEL)
  assert.equal(agg.providerMode, 'builtin-openai')
  const route = resolveModeTarget({ mode: 'route' })
  assert.equal(route.parentModel, ROUTE_MODEL)
  assert.equal(route.childModel, ROUTE_MODEL)
  assert.equal(route.model, ROUTE_MODEL)
  assert.equal(route.providerMode, 'managed-provider')

  const built = buildDesiredCodexConfig({
    openaiBaseUrl: 'http://127.0.0.1:8787',
    model: agg.parentModel,
    modelCatalogJsonPath: SYNTHETIC_CATALOG_PATH,
  })
  const withChild = withManagedAgentDesired(built.desired, {
    model: agg.parentModel,
    agentModel: agg.childModel,
  })
  assert.equal(withChild.topLevel.model, DEFAULT_PARENT_MODEL, '父仍是顶层 luna')
  const child = buildManagedAgentConfig({ model: agg.childModel })
  assert.match(child.child.text, new RegExp(DEEPSEEK_CHILD_MODEL.replace('.', '\\.')))
  assert.equal(modeDescriptor(agg).includes('child=deepseek-v4.1-flash'), true)
})

test('父模型候选：只列 visibility=list 且 supported_in_api，luna 可真机其余 UNVERIFIED', () => {
  const catalog = {
    models: [
      officialModel({ slug: DEFAULT_PARENT_MODEL }),
      officialModel({ slug: 'gpt-other', display_name: 'Other' }),
      officialModel({ slug: 'gpt-hidden', visibility: 'hide' }),
      officialModel({ slug: 'gpt-noapi', supported_in_api: false }),
    ],
  }
  const list = listSelectableParents(catalog)
  assert.deepEqual(list.map((m) => m.slug), [DEFAULT_PARENT_MODEL, 'gpt-other'])
  assert.equal(list[0].realTest, 'ALLOWED_FOR_REAL_TEST')
  assert.equal(list[1].realTest, 'UNVERIFIED')
})

// ---------------------------------------------------------------------------
// 4. 三形态分类 + drifted
// ---------------------------------------------------------------------------
test('classifyConfigState：official / aggregated / route / unknown 三路判定', () => {
  const officialText = 'model = "gpt-6-luna"\nmodel_provider = "openai"\n'
  const aggregatedText = [
    'model_provider = "openai"',
    'openai_base_url = "http://127.0.0.1:8787"',
    'model = "gpt-6-luna"',
    'model_catalog_json = "' + SYNTHETIC_CATALOG_PATH + '"',
    '',
  ].join('\n')
  const routeText = [
    'model_provider = "modelgate"',
    'model = "' + ROUTE_MODEL + '"',
    'model_catalog_json = "' + SYNTHETIC_CATALOG_PATH + '"',
    '',
    '[model_providers.modelgate]',
    'name = "ModelGate"',
    'base_url = "http://127.0.0.1:8787/v1"',
    'wire_api = "responses"',
    'requires_openai_auth = false',
    'supports_websockets = false',
    '',
    '[model_providers.modelgate.capabilities]',
    'remote_compaction = "unsupported"',
    '',
  ].join('\n')
  const unknownText = 'model_provider = "openai"\nopenai_base_url = "https://remote.example"\nmodel_catalog_json = "/tmp/c.json"\n'
  const cases = [
    [officialText, 'official'],
    [aggregatedText, 'aggregated'],
    [routeText, 'route'],
    [unknownText, 'unknown'],
  ]
  for (const [text, expected] of cases) {
    const f = makeFixture(text)
    try {
      assert.equal(classifyConfigState({ configPath: f.configPath, baseUrl: 'http://127.0.0.1:8787' }).mode, expected)
    } finally { f.cleanup() }
  }
})

test('classifyConfigState：sha 漂移仍识别形态并标 drifted=true', () => {
  const f = makeFixture('model_provider = "openai"\nopenai_base_url = "http://127.0.0.1:8787"\nmodel = "gpt-6-luna"\nmodel_catalog_json = "' + SYNTHETIC_CATALOG_PATH + '"\n')
  try {
    writeState(f, { mode: 'aggregated', appliedSha: 'deadbeef-not-the-current-sha' })
    const c = classifyConfigState({ configPath: f.configPath, baseUrl: 'http://127.0.0.1:8787' })
    assert.equal(c.mode, 'aggregated')
    assert.equal(c.drifted, true)
  } finally { f.cleanup() }
})

// ---------------------------------------------------------------------------
// 5. 三形态两两切换 / 回滚 / 重启 / 删除行
// ---------------------------------------------------------------------------
test('三形态切换：未管理行逐字节保留，删除行出现在 rows，previous 可回滚，退出仍需重启', async (t) => {
  const f = makeFixture()
  t.after(f.cleanup)
  const beforeFingerprint = unmanagedFingerprint(readFileSync(f.configPath, 'utf8'))

  // official → aggregated
  const pAgg = preview({ ...f.baseOpts, mode: 'aggregated', parentModel: DEFAULT_PARENT_MODEL })
  assert.equal(pAgg.ok, true)
  assert.equal(pAgg.fromMode, 'official')
  assert.equal(pAgg.toMode, 'aggregated')
  const agg = await activate({ ...f.baseOpts, mode: 'aggregated', parentModel: DEFAULT_PARENT_MODEL, consentToken: pAgg.consentToken, expectedSha: pAgg.expectedSha })
  assert.equal(agg.ok, true)
  assert.equal(agg.mode, 'aggregated')
  assert.equal(unmanagedFingerprint(readFileSync(f.configPath, 'utf8')), beforeFingerprint)
  assert.equal(f.readState().previous.mode, 'official')
  assert.match(readFileSync(f.managedAgentPath, 'utf8'), new RegExp(DEEPSEEK_CHILD_MODEL.replace('.', '\\.')))

  // aggregated → route（先恢复旧 owned 再合入新 owned）
  const pRoute = preview({ ...f.baseOpts, mode: 'route' })
  assert.equal(pRoute.ok, true)
  assert.ok(pRoute.rows.some((r) => r.kind === 'remove'), '切换必须展示删除行')
  const route = await activate({ ...f.baseOpts, mode: 'route', consentToken: pRoute.consentToken, expectedSha: pRoute.expectedSha })
  assert.equal(route.ok, true)
  assert.equal(route.mode, 'route')
  const routeText = readFileSync(f.configPath, 'utf8')
  assert.equal(unmanagedFingerprint(routeText), beforeFingerprint)
  assert.match(routeText, /^model_provider = "modelgate"$/m)
  assert.match(routeText, /^base_url = "http:\/\/127\.0\.0\.1:8787\/v1"$/m)
  assert.equal(/^openai_base_url = /m.test(routeText), false, '路由模式不应残留内置改向键')
  assert.equal(f.readState().previous.mode, 'aggregated')
  assert.equal(f.readState().parentModel, ROUTE_MODEL)
  assert.equal(f.readState().childModel, ROUTE_MODEL)
  assert.equal(route.needsRestart, true)

  // route → official（退出）可回滚到 previous 且提示重启
  const exit = await deactivate({ configPath: f.configPath, statePath: f.statePath, managedAgentPath: f.managedAgentPath, expectedSha: route.sha })
  assert.equal(exit.ok, true)
  assert.equal(exit.mode, 'official')
  assert.equal(readFileSync(f.configPath, 'utf8'), USER_CONFIG, '逐字节回到接入前配置')
  const s = status({ configPath: f.configPath, statePath: f.statePath, managedAgentPath: f.managedAgentPath, clientProbe: false })
  assert.equal(s.mode, 'official')
  assert.equal(s.needsRestart, true)
  assert.equal(s.restart.reason, 'exited_to_official')
  assert.equal(f.readState().previous.mode, 'route')
})

test('planModeTransition：纯函数保留未管理行并给出 remove 行', () => {
  const fromDesired = {
    topLevel: { model_provider: 'modelgate', model: ROUTE_MODEL, model_catalog_json: SYNTHETIC_CATALOG_PATH },
    sections: { 'model_providers.modelgate': { name: 'ModelGate', base_url: 'http://127.0.0.1:8787/v1' } },
  }
  const toDesired = {
    topLevel: { model_provider: 'openai', openai_base_url: 'http://127.0.0.1:8787', model: DEFAULT_PARENT_MODEL, model_catalog_json: SYNTHETIC_CATALOG_PATH },
    sections: {},
  }
  const currentText = [
    'model_provider = "modelgate"',
    'model = "' + ROUTE_MODEL + '"',
    'model_catalog_json = "' + SYNTHETIC_CATALOG_PATH + '"',
    '',
    '[model_providers.modelgate]',
    'name = "ModelGate"',
    'base_url = "http://127.0.0.1:8787/v1"',
    '',
    '[projects."/home/dev/x"]',
    'trust_level = "trusted"',
    '',
  ].join('\n')
  const planned = planModeTransition({
    baseText: '',
    currentText,
    baseExists: false,
    fromDesired,
    toDesired,
  })
  assert.equal(planned.ok, true)
  assert.ok(planned.rows.some((r) => r.kind === 'remove' && r.path === 'model_providers.modelgate.base_url'))
  assert.equal(unmanagedFingerprint(planned.text), unmanagedFingerprint(currentText))
  assert.equal(/^\[model_providers\.modelgate\]$/m.test(planned.text), false)
})

// ---------------------------------------------------------------------------
// 6. consentToken 绑定
// ---------------------------------------------------------------------------
test('consentToken：mode / parentModel / beforeSha 任一变化即失配（428）', async (t) => {
  const f = makeFixture()
  t.after(f.cleanup)
  const pAgg = preview({ ...f.baseOpts, mode: 'aggregated', parentModel: DEFAULT_PARENT_MODEL })
  const pRoute = preview({ ...f.baseOpts, mode: 'route' })
  const pOther = preview({ ...f.baseOpts, mode: 'aggregated', parentModel: 'gpt-6-luna-other' })
  assert.notEqual(pAgg.consentToken, pRoute.consentToken, 'mode 变化必须改变令牌')
  assert.notEqual(pAgg.consentToken, pOther.consentToken, 'parentModel 变化必须改变令牌')

  await assert.rejects(
    () => activate({ ...f.baseOpts, mode: 'route', consentToken: pAgg.consentToken, expectedSha: pAgg.expectedSha }),
    (e) => e && e.code === 'consent_required' && e.status === 428,
  )
  // 文件字节未变
  assert.equal(readFileSync(f.configPath, 'utf8'), USER_CONFIG)
})

// ---------------------------------------------------------------------------
// 7. reconcile 后 deactivate 不再 409
// ---------------------------------------------------------------------------
test('对账：appliedSha 漂移后 reconcileState 使 deactivate 成功而非 409', async (t) => {
  const f = makeFixture()
  t.after(f.cleanup)
  const p = preview({ ...f.baseOpts, mode: 'aggregated', parentModel: DEFAULT_PARENT_MODEL })
  const activated = await activate({ ...f.baseOpts, mode: 'aggregated', parentModel: DEFAULT_PARENT_MODEL, consentToken: p.consentToken, expectedSha: p.expectedSha })
  assert.equal(activated.ok, true)

  // 模拟本机漂移：用户加了一行注释，但 state.appliedSha 仍是旧值。
  writeFileSync(f.configPath, readFileSync(f.configPath, 'utf8') + '# local drift\n')
  const currentSha = (await import('node:crypto')).createHash('sha256').update(readFileSync(f.configPath)).digest('hex')
  const rec = f.readState()
  writeState(f, Object.assign({}, rec, { appliedSha: 'stale-sha' }))

  const pre = previewReconcile({ ...f.baseOpts, mode: 'aggregated' })
  assert.equal(pre.ok, true)
  assert.equal(pre.needsReconcile, true)
  assert.ok(pre.reasons.includes('applied_sha_mismatch'))
  const out = reconcileState({ ...f.baseOpts, mode: 'aggregated' })
  assert.equal(out.changed, true)
  assert.ok(existsSync(f.statePath + '.bak'))
  const deactivated = await deactivate({ configPath: f.configPath, statePath: f.statePath, managedAgentPath: f.managedAgentPath })
  assert.equal(deactivated.ok, true, '对账后退出不应再被 409 卡住')
})

test('对账：备份损坏后 reconcileState 使 deactivate 退化为只撤销自有键而非 409', async (t) => {
  const f = makeFixture()
  t.after(f.cleanup)
  const p = preview({ ...f.baseOpts, mode: 'aggregated', parentModel: DEFAULT_PARENT_MODEL })
  const activated = await activate({ ...f.baseOpts, mode: 'aggregated', parentModel: DEFAULT_PARENT_MODEL, consentToken: p.consentToken, expectedSha: p.expectedSha })
  assert.equal(activated.ok, true)

  const rec = f.readState()
  if (rec.backupPath) writeFileSync(rec.backupPath, 'corrupted-backup-not-original')

  const pre = previewReconcile({ ...f.baseOpts, mode: 'aggregated' })
  assert.equal(pre.needsReconcile, true)
  assert.ok(pre.reasons.includes('backup_sha_mismatch'))
  const out = reconcileState({ ...f.baseOpts, mode: 'aggregated' })
  assert.equal(out.changed, true)
  const deactivated = await deactivate({ configPath: f.configPath, statePath: f.statePath, managedAgentPath: f.managedAgentPath })
  assert.equal(deactivated.ok, true)
  assert.equal(deactivated.selective, true)
})

// ---------------------------------------------------------------------------
// 8. 重启门禁回归（含退出）
// ---------------------------------------------------------------------------
test('computeRestartState：official 不重启，route/aggregated 重启，退出重新提示重启', () => {
  const now = 1000
  assert.equal(computeRestartState({ mode: 'official', now }).needed, false)
  assert.equal(computeRestartState({ mode: 'official', now }).reason, 'not_aggregated')
  assert.equal(computeRestartState({ mode: 'route', appliedAt: now, client: { running: false }, now }).needed, true)
  assert.equal(computeRestartState({ mode: 'aggregated', appliedAt: now, client: { running: false }, now }).needed, true)
  const exited = computeRestartState({ mode: 'official', exitedAt: now + 10, lastAction: 'deactivate', now })
  assert.equal(exited.needed, true)
  assert.equal(exited.reason, 'exited_to_official')
})
