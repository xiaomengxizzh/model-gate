// E2 离线测试：Codex 聚合模型目录生成器（纯函数 + CLI）。
// 零第三方依赖、无网络、全部使用 OS 临时目录；不含 745KB 官方目录（按需从外部注入）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, statSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as C from '../../../src/codex/catalog.js'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const CLI = join(ROOT, 'scripts', 'codex-catalog.mjs')

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

function officialCatalog() {
  return {
    models: [
      officialModel(),
      officialModel({ slug: 'gpt-test-hidden', display_name: 'GPT Test Hidden', visibility: 'hide', priority: 2, multi_agent_version: 'v1' }),
    ],
  }
}

function gatewayConfig() {
  return {
    providers: { 'opencode-go': { name: 'OpenCode Go' } },
    models: {
      'deepseek-v3': { provider: 'opencode-go', capability: 'chat', maxContext: 128000, effortOptions: ['low', 'medium', 'high'], reasoning: 'medium' },
      'glm-5': { provider: 'opencode-go', maxContext: 200000, effortOptions: ['low', 'high'], codex: { defaultReasoningLevel: 'high', displayName: 'GLM-5 (OpenCode Go)' } },
      'text-embed': { provider: 'opencode-go', capability: 'embedding', maxContext: 8192 },
      'gpt-test-sol': { provider: 'openai' },
    },
  }
}

function tempDir(label) {
  return mkdtempSync(join(tmpdir(), 'mg-codex-catalog-' + label + '-'))
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2))
  return path
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 60000 })
}

// ---------------------------------------------------------------------------
// 输入与校验闸门
// ---------------------------------------------------------------------------

test('拒绝普通 OpenAI /v1/models 形状', () => {
  assert.throws(() => C.normalizeCatalogInput({ object: 'list', data: [{ id: 'gpt-4o' }] }), err => err.code === 'openai_list_shape')
  assert.throws(() => C.normalizeCatalogInput([{ id: 'gpt-4o' }]), err => err.code === 'catalog_shape')
  assert.throws(() => C.normalizeCatalogInput({ data: [] }), err => err.code === 'openai_list_shape')
  const ok = C.normalizeCatalogInput(officialCatalog())
  assert.equal(ok.catalog.models.length, 2)
})

test('serde 必填字段缺失时 fail-closed（supported_reasoning_levels）', () => {
  const broken = officialCatalog()
  delete broken.models[0].supported_reasoning_levels
  const result = C.validateCatalog(broken)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some(e => e.code === 'missing_required_field' && e.path === 'models[0].supported_reasoning_levels'))
  assert.throws(() => C.assertCatalog(broken), err => err.code === 'catalog_invalid' && err.details.errors.length > 0)
})

test('base_instructions 与 instructions_template 至少一个', () => {
  const broken = officialCatalog()
  delete broken.models[0].base_instructions
  delete broken.models[0].model_messages
  const result = C.validateCatalog(broken)
  assert.ok(result.errors.some(e => e.code === 'missing_instructions'))
})

test('上下文窗口是策略必填且必须为正整数', () => {
  const missing = officialCatalog()
  delete missing.models[0].context_window
  assert.ok(C.validateCatalog(missing).errors.some(e => e.code === 'missing_capability_field' && e.path.endsWith('context_window')))
  const broken = officialCatalog()
  broken.models[0].context_window = 128000.5
  assert.ok(C.validateCatalog(broken).errors.some(e => e.code === 'invalid_type' && e.path.endsWith('context_window')))
  const inverted = officialCatalog()
  inverted.models[0].max_context_window = 1000
  assert.ok(C.validateCatalog(inverted).errors.some(e => e.code === 'context_window_order'))
})

test('枚举与类型校验（visibility/shell_type/priority/truncation）', () => {
  const bad = officialCatalog()
  bad.models[0].visibility = 'weird'
  bad.models[0].shell_type = 'weird'
  bad.models[0].priority = 1.5
  bad.models[0].truncation_policy = { mode: 'weird', limit: 0 }
  const result = C.validateCatalog(bad)
  const codes = result.errors.map(e => e.path + ':' + e.code)
  assert.ok(codes.some(c => c.startsWith('models[0].visibility:invalid_enum')))
  assert.ok(codes.some(c => c.startsWith('models[0].shell_type:invalid_enum')))
  assert.ok(codes.some(c => c.startsWith('models[0].priority:invalid_type')))
  assert.ok(codes.some(c => c.includes('truncation_policy.mode:invalid_enum')))
  assert.ok(codes.some(c => c.includes('truncation_policy.limit:invalid_type')))
})

test('重复 slug 被拒绝', () => {
  const dup = officialCatalog()
  dup.models.push(officialModel())
  const result = C.validateCatalog(dup)
  assert.ok(result.errors.some(e => e.code === 'duplicate_slug' && e.path === 'models[2].slug'))
})

test('默认推理档位必须受支持', () => {
  const bad = officialCatalog()
  bad.models[0].default_reasoning_level = 'ultra'
  assert.ok(C.validateCatalog(bad).errors.some(e => e.code === 'default_reasoning_level_unsupported'))
})

// ---------------------------------------------------------------------------
// 稳定 ID 与合并
// ---------------------------------------------------------------------------

test('稳定聚合 ID：可预测、不可重绑定、非法输入报错', () => {
  assert.equal(C.stableModelId('opencode-go', 'deepseek/v3'), 'mg-opencode-go-deepseek-v3')
  assert.equal(C.stableModelId('OpenCode Go', 'DeepSeek V3'), 'mg-opencode-go-deepseek-v3')
  assert.throws(() => C.stableModelId('', 'x'), err => err.code === 'stable_id_invalid')
  assert.throws(() => C.stableModelId('p', '///'), err => err.code === 'stable_id_invalid')
})

test('完整 ModelInfo 合并：官方直通 + 第三方补充，绑定可追溯', () => {
  const built = C.buildCatalog({ base: officialCatalog(), config: gatewayConfig() })
  assert.equal(built.catalog.models.length, 4)
  assert.deepEqual(built.catalog.models[0], officialCatalog().models[0])
  assert.deepEqual(built.catalog.models[1], officialCatalog().models[1])

  const deepseek = built.catalog.models.find(m => m.slug === 'mg-opencode-go-deepseek-v3')
  assert.ok(deepseek)
  assert.equal(deepseek.display_name, 'deepseek-v3 (OpenCode Go)')
  assert.equal(deepseek.context_window, 128000)
  assert.equal(deepseek.max_context_window, 128000)
  assert.deepEqual(deepseek.supported_reasoning_levels.map(l => l.effort), ['low', 'medium', 'high'])
  assert.equal(deepseek.default_reasoning_level, 'medium')
  assert.deepEqual(deepseek.input_modalities, ['text'])
  assert.equal(deepseek.visibility, 'list')
  assert.equal(deepseek.supported_in_api, true)
  assert.equal(deepseek.priority, 3, '第三方 priority 从官方最大值 +1 开始')
  assert.equal(deepseek.base_instructions, 'You are Codex, a fixture agent.', '指令从官方模板继承')
  assert.equal(deepseek.multi_agent_version, 'v2', '客户端行为字段从模板继承')
  assert.equal(deepseek.comp_hash, undefined, '不继承官方 comp_hash')

  const binding = built.meta.bindings['mg-opencode-go-deepseek-v3']
  assert.equal(binding.provider, 'opencode-go')
  assert.equal(binding.model, 'deepseek-v3')
  assert.equal(built.meta.counts.official, 2)
  assert.equal(built.meta.counts.thirdParty, 2)

  const meta = built.meta.models.find(m => m.slug === 'mg-opencode-go-deepseek-v3')
  assert.equal(meta.templateModel, 'gpt-test-sol')
  assert.equal(meta.sources.contextWindow.confidence, 'declared')
  assert.equal(meta.sources.contextWindow.origin, 'models.deepseek-v3.maxContext')
  assert.equal(meta.sources.reasoningLevels.origin, 'models.deepseek-v3.effortOptions')
  assert.equal(meta.sources.baseInstructions.confidence, 'inherited')
  assert.ok(C.validateCatalog(built.catalog).ok, '生成结果自身必须通过校验闸门')
})

test('跳过非 chat / disabled / 官方直连 provider', () => {
  const config = gatewayConfig()
  config.models['off-model'] = { provider: 'opencode-go', maxContext: 1000, disabled: true }
  const built = C.buildCatalog({ base: officialCatalog(), config })
  const skipped = built.meta.skipped.map(s => s.model + ':' + s.reason)
  assert.ok(skipped.includes('text-embed:non_chat_capability:embedding'))
  assert.ok(skipped.includes('gpt-test-sol:official_provider_passthrough'))
  assert.ok(skipped.includes('off-model:disabled'))
  assert.ok(!built.catalog.models.some(m => m.slug.includes('text-embed')))
})

test('遮蔽官方模型 ID 被拒绝', () => {
  const config = gatewayConfig()
  config.models['gpt-test-sol'] = { provider: 'opencode-go', maxContext: 1000 }
  assert.throws(() => C.buildCatalog({ base: officialCatalog(), config }), err => err.code === 'official_slug_reuse')
})

test('第三方上下文未知时拒绝生成（不猜数字）', () => {
  const config = gatewayConfig()
  delete config.models['deepseek-v3'].maxContext
  assert.throws(() => C.buildCatalog({ base: officialCatalog(), config }), err => err.code === 'third_party_context_missing')
})

test('codex 覆盖：上下文、模态、档位、优先级可显式声明；未知字段拒绝', () => {
  const config = gatewayConfig()
  config.models['glm-5'].codex = {
    contextWindow: 300000,
    maxContextWindow: 300000,
    modalities: ['text', 'image'],
    reasoningLevels: [{ effort: 'low', description: 'fast' }, { effort: 'max', description: 'deep' }],
    defaultReasoningLevel: 'max',
    priority: 7,
    multiAgentVersion: 'v1',
  }
  const built = C.buildCatalog({ base: officialCatalog(), config })
  const glm = built.catalog.models.find(m => m.slug === 'mg-opencode-go-glm-5')
  assert.equal(glm.context_window, 300000)
  assert.equal(glm.max_context_window, 300000)
  assert.deepEqual(glm.input_modalities, ['text', 'image'])
  assert.deepEqual(glm.supported_reasoning_levels.map(l => l.effort), ['low', 'max'])
  assert.equal(glm.default_reasoning_level, 'max')
  assert.equal(glm.priority, 7)
  assert.equal(glm.multi_agent_version, 'v1')
  const meta = built.meta.models.find(m => m.slug === 'mg-opencode-go-glm-5')
  assert.equal(meta.sources.inputModalities.confidence, 'declared')

  config.models['glm-5'].codex = { contexWindow: 1 }
  assert.throws(() => C.buildCatalog({ base: officialCatalog(), config }), err => err.code === 'unknown_override_field')
})

test('未声明推理档位时按 assumed 生成并留下警告', () => {
  const config = gatewayConfig()
  delete config.models['deepseek-v3'].effortOptions
  delete config.models['deepseek-v3'].reasoning
  const built = C.buildCatalog({ base: officialCatalog(), config })
  const deepseek = built.catalog.models.find(m => m.slug === 'mg-opencode-go-deepseek-v3')
  assert.deepEqual(deepseek.supported_reasoning_levels.map(l => l.effort), ['medium'])
  assert.equal(deepseek.default_reasoning_level, 'medium')
  assert.ok(built.meta.warnings.some(w => w.code === 'assumed_reasoning_levels' && w.path === 'models.deepseek-v3'))
  const meta = built.meta.models.find(m => m.slug === 'mg-opencode-go-deepseek-v3')
  assert.equal(meta.sources.reasoningLevels.confidence, 'assumed')
})

test('模板模型可注入，缺失时明确报错', () => {
  const built = C.buildCatalog({ base: officialCatalog(), config: gatewayConfig(), options: { templateModel: 'gpt-test-hidden' } })
  assert.equal(built.meta.templateModel, 'gpt-test-hidden')
  const clone = built.catalog.models.find(m => m.slug === 'mg-opencode-go-deepseek-v3')
  assert.equal(clone.multi_agent_version, 'v1')
  assert.throws(() => C.buildCatalog({ base: officialCatalog(), config: gatewayConfig(), options: { templateModel: 'nope' } }), err => err.code === 'template_model_missing')
})

// ---------------------------------------------------------------------------
// 差异摘要与绑定冲突
// ---------------------------------------------------------------------------

test('差异摘要：新增/移除/变更字段 + 长字符串摘要', () => {
  const prev = { models: [officialModel(), officialModel({ slug: 'old-model', display_name: 'Old' })] }
  const next = { models: [officialModel({ context_window: 210000 }), officialModel({ slug: 'new-model', display_name: 'New' })] }
  const diff = C.diffCatalogs(prev, next)
  assert.deepEqual(diff.added, ['new-model'])
  assert.deepEqual(diff.removed, ['old-model'])
  assert.equal(diff.changed.length, 1)
  assert.deepEqual(diff.changed[0].fields.context_window, { from: 200000, to: 210000 })
  const longChange = C.diffCatalogs({ models: [officialModel({ base_instructions: 'x'.repeat(300) })] }, { models: [officialModel({ base_instructions: 'y'.repeat(500) })] })
  assert.match(String(longChange.changed[0].fields.base_instructions.from), /^<string len=300 sha256:/)
  assert.match(String(longChange.changed[0].fields.base_instructions.to), /^<string len=500 sha256:/)
})

test('同一聚合 ID 指向不同 provider/model 时识别为重绑定冲突', () => {
  const first = C.buildCatalog({ base: officialCatalog(), config: gatewayConfig() })
  const changed = gatewayConfig()
  changed.models['deepseek-v3'] = { provider: 'OpenCode-Go', maxContext: 128000 }
  const second = C.buildCatalog({ base: officialCatalog(), config: changed })
  const diff = C.diffBindings(first.meta.bindings, second.meta.bindings)
  assert.equal(diff.conflicts.length, 1)
  assert.equal(diff.conflicts[0].slug, 'mg-opencode-go-deepseek-v3')
})

// ---------------------------------------------------------------------------
// 版本化与回滚
// ---------------------------------------------------------------------------

test('版本记录、历史上限与回滚目标解析', () => {
  let state = C.emptyState()
  for (let version = 1; version <= 5; version++) {
    state = C.recordVersion(state, {
      version,
      file: 'versions/v' + String(version).padStart(6, '0') + '-aaaaaaaa.json',
      sha256: 'a'.repeat(64),
      generatedAt: '2026-11-11T00:00:0' + version + '.000Z',
      format: 'catalog-json',
      counts: { official: 2, thirdParty: 1, total: 3 },
      sourceFingerprint: { combined: 'f'.repeat(64) },
      bindings: { 'mg-p-m': { slug: 'mg-p-m', provider: 'p', model: 'm' } },
    }, { historyLimit: 3 })
  }
  assert.equal(state.currentVersion, 5)
  assert.equal(state.history.length, 3)
  assert.deepEqual(state.history.map(h => h.version), [5, 4, 3])
  assert.equal(C.resolveRollbackTarget(state, 'prev').version, 4)
  assert.equal(C.resolveRollbackTarget(state, '3').version, 3)
  assert.equal(C.resolveRollbackTarget(state, 'v000004').version, 4)
  assert.equal(C.resolveRollbackTarget(state, 'a'.repeat(8)).version, 5)
  assert.throws(() => C.resolveRollbackTarget(state, '99'), err => err.code === 'rollback_target_missing')
  const retired = C.retireBindings(state, ['mg-p-m'], 6)
  assert.equal(retired.retiredBindings['mg-p-m'].retiredAtVersion, 6)
})

// ---------------------------------------------------------------------------
// 序列化
// ---------------------------------------------------------------------------

test('两种输出格式都是 Codex ModelsResponse 形状且同源', () => {
  const built = C.buildCatalog({ base: officialCatalog(), config: gatewayConfig() })
  const catalogJson = C.serializeCatalog(built.catalog, { format: 'catalog-json' })
  const codexModels = C.serializeCatalog(built.catalog, { format: 'codex-models' })
  assert.equal(catalogJson, codexModels, 'Codex 0.167 对两条路径使用同一 ModelsResponse 结构')
  const parsed = JSON.parse(catalogJson)
  assert.deepEqual(Object.keys(parsed), ['models'])
  assert.equal(parsed.models.length, 4)
  assert.equal(C.catalogFingerprint(built.catalog), C.catalogFingerprint(JSON.parse(catalogJson)))
  assert.throws(() => C.serializeCatalog(built.catalog, { format: 'openai-list' }), err => err.code === 'invalid_format')
})

// ---------------------------------------------------------------------------
// CLI 端到端
// ---------------------------------------------------------------------------

function cliFixture(label) {
  const dir = tempDir(label)
  const base = writeJson(join(dir, 'catalog.json'), officialCatalog())
  const models = writeJson(join(dir, 'gateway.json'), gatewayConfig())
  const out = join(dir, 'out', 'catalog.json')
  const state = join(dir, 'out', '.codex-catalog')
  return { dir, base, models, out, state }
}

test('CLI：生成 -> 版本递增 -> 差异 -> 回滚 -> 状态陈旧检测', () => {
  const fx = cliFixture('e2e')
  try {
    const first = runCli(['--base', fx.base, '--models', fx.models, '--out', fx.out, '--state-dir', fx.state, '--json'])
    assert.equal(first.status, 0, first.stderr)
    const firstJson = JSON.parse(first.stdout)
    assert.equal(firstJson.version, 1)
    assert.equal(firstJson.counts.total, 4)
    assert.ok(existsSync(fx.out))
    assert.ok(existsSync(join(fx.state, 'state.json')))
    const v1Text = readFileSync(fx.out, 'utf8')
    assert.deepEqual(Object.keys(JSON.parse(v1Text)), ['models'])

    const config2 = gatewayConfig()
    config2.models['kimi-k2'] = { provider: 'opencode-go', maxContext: 256000, effortOptions: ['low', 'high'] }
    writeJson(fx.models, config2)
    const second = runCli(['--base', fx.base, '--models', fx.models, '--out', fx.out, '--state-dir', fx.state, '--json'])
    assert.equal(second.status, 0, second.stderr)
    const secondJson = JSON.parse(second.stdout)
    assert.equal(secondJson.version, 2)
    assert.deepEqual(secondJson.diff.added, ['mg-opencode-go-kimi-k2'])
    assert.equal(secondJson.diff.counts.changed, 0)

    const rollback = runCli(['--rollback', 'prev', '--out', fx.out, '--state-dir', fx.state, '--json'])
    assert.equal(rollback.status, 0, rollback.stderr)
    assert.equal(JSON.parse(rollback.stdout).to, 1)
    assert.equal(readFileSync(fx.out, 'utf8'), v1Text, '回滚后字节级恢复上一版本')

    writeFileSync(fx.out, v1Text + '\n')
    const status = runCli(['--status', '--out', fx.out, '--state-dir', fx.state, '--json'])
    assert.equal(status.status, 0, status.stderr)
    const statusJson = JSON.parse(status.stdout)
    assert.equal(statusJson.out.clientMayBeStale, true)
    assert.equal(statusJson.currentVersion, 1)
  } finally {
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

test('CLI：--dry-run 不落盘', () => {
  const fx = cliFixture('dry')
  try {
    const result = runCli(['--base', fx.base, '--models', fx.models, '--out', fx.out, '--state-dir', fx.state, '--dry-run', '--json'])
    assert.equal(result.status, 0, result.stderr)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.dryRun, true)
    assert.equal(payload.version, 1)
    assert.ok(!existsSync(fx.out))
    assert.ok(!existsSync(fx.state))
  } finally {
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

test('CLI：校验失败 fail-closed（退出码 3，不产出半成品）', () => {
  const fx = cliFixture('invalid')
  try {
    const broken = officialCatalog()
    delete broken.models[0].supported_reasoning_levels
    writeJson(fx.base, broken)
    const result = runCli(['--base', fx.base, '--models', fx.models, '--out', fx.out, '--state-dir', fx.state])
    assert.equal(result.status, 3)
    assert.match(result.stderr, /supported_reasoning_levels/)
    assert.ok(!existsSync(fx.out))
    assert.ok(!existsSync(join(fx.state, 'state.json')))
  } finally {
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

test('CLI：聚合 ID 重绑定 fail-closed（退出码 4）', () => {
  const fx = cliFixture('rebind')
  try {
    writeJson(fx.models, gatewayConfig())
    const first = runCli(['--base', fx.base, '--models', fx.models, '--out', fx.out, '--state-dir', fx.state])
    assert.equal(first.status, 0, first.stderr)

    const changed = gatewayConfig()
    changed.providers['OpenCode-Go'] = { name: 'OpenCode Go' }
    changed.models['deepseek-v3'] = { provider: 'OpenCode-Go', capability: 'chat', maxContext: 128000, effortOptions: ['low', 'high'] }
    writeJson(fx.models, changed)
    const second = runCli(['--base', fx.base, '--models', fx.models, '--out', fx.out, '--state-dir', fx.state])
    assert.equal(second.status, 4, second.stderr + second.stdout)
    assert.match(second.stderr, /stable_id_rebinding/)
    const state = JSON.parse(readFileSync(join(fx.state, 'state.json'), 'utf8'))
    assert.equal(state.currentVersion, 1, '冲突时状态不推进')
  } finally {
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

test('CLI：拒绝写入 ~/.codex', () => {
  const fx = cliFixture('guard')
  try {
    const forbidden = join(homedir(), '.codex', 'catalog.json')
    const result = runCli(['--base', fx.base, '--out', forbidden, '--state-dir', fx.state])
    assert.equal(result.status, 2)
    assert.match(result.stderr, /拒绝写入 ~\/.codex/)
  } finally {
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

test('CLI：--strict 把警告升级为错误（退出码 3）', () => {
  const fx = cliFixture('strict')
  try {
    const config = gatewayConfig()
    delete config.models['deepseek-v3'].effortOptions
    delete config.models['deepseek-v3'].reasoning
    writeJson(fx.models, config)
    const loose = runCli(['--base', fx.base, '--models', fx.models, '--out', fx.out, '--state-dir', fx.state])
    assert.equal(loose.status, 0, loose.stderr)
    rmSync(fx.out, { force: true })
    const strict = runCli(['--base', fx.base, '--models', fx.models, '--out', fx.out, '--state-dir', join(fx.dir, 'out2', 'state'), '--strict'])
    assert.equal(strict.status, 3, strict.stderr)
    assert.match(strict.stderr, /strict_warnings/)
    assert.ok(!existsSync(fx.out), 'strict 失败时不得重新写出目录')
  } finally {
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

test('CLI：--verify-codex 缺少 codex 时 fail-closed（退出码 6，不发布）', () => {
  const fx = cliFixture('verify')
  try {
    const result = runCli(['--base', fx.base, '--models', fx.models, '--out', fx.out, '--state-dir', fx.state, '--verify-codex', '--codex-bin', join(fx.dir, 'no-such-codex')])
    assert.equal(result.status, 6)
    assert.match(result.stderr, /codex_verify_failed/)
    assert.ok(!existsSync(fx.out))
    assert.ok(!existsSync(join(fx.state, 'state.json')))
  } finally {
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

test('CLI：真实 codex 可解析生成物（离线，需 MG_CODEX_VERIFY=1）', { skip: process.env.MG_CODEX_VERIFY !== '1' }, () => {
  const fx = cliFixture('codex')
  try {
    const result = runCli(['--base', fx.base, '--models', fx.models, '--out', fx.out, '--state-dir', fx.state, '--verify-codex', '--codex-bin', process.env.MG_CODEX_BIN || 'codex', '--json'])
    assert.equal(result.status, 0, result.stderr + result.stdout)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.verified.by, 'codex debug models')
    assert.equal(payload.verified.modelCount, payload.counts.total)
    const status = runCli(['--status', '--out', fx.out, '--state-dir', fx.state, '--json'])
    assert.equal(JSON.parse(status.stdout).published.verified.modelCount, payload.counts.total)
  } finally {
    rmSync(fx.dir, { recursive: true, force: true })
  }
})