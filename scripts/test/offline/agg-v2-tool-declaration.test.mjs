// V2 真机缺陷回归（MG-R005/R006，2026-11-15）：Codex 对第三方 Go 模型不下发 function tools。
//
// 本机离线探针（真实 codex-cli 0.167.0-alpha.3.2 + 127.0.0.1 mock，零付费）结论：
//   · use_responses_lite=true → 请求体没有 tools（真机 tools:None 的根因）；
//   · shell_type='disabled' → 有 tools，但没有 exec_command；
//   · shell_type=unified_exec/shell_command/local/default → tools 含 exec_command + write_stdin；
//   · tool_mode='code_mode_only' → 不下发 exec_command（被 code-cell exec/wait 取代）；
//   · apply_patch_tool_type='freeform' → 额外下发 apply_patch。
//
// 本套件断言 ModelGate 生成的 ModelInfo 对第三方 Responses 路由给出正确工具声明，
// 且绝不把官方 ChatGPT 专属能力（use_responses_lite / code_mode_only）继承给第三方。
import test from 'node:test'
import assert from 'node:assert/strict'
import * as C from '../../../src/codex/catalog.js'

function level(effort) { return { effort, description: effort } }

function officialModel(overrides = {}) {
  return Object.assign({
    slug: 'gpt-test-sol',
    display_name: 'GPT Test Sol',
    description: 'Official fixture model',
    default_reasoning_level: 'low',
    supported_reasoning_levels: [level('low'), level('medium')],
    shell_type: 'unified_exec',
    visibility: 'list',
    supported_in_api: true,
    priority: 1,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    support_verbosity: true,
    default_verbosity: 'low',
    apply_patch_tool_type: 'freeform',
    web_search_tool_type: 'text_and_image',
    truncation_policy: { mode: 'tokens', limit: 10000 },
    context_window: 200000,
    max_context_window: 400000,
    experimental_supported_tools: [],
    input_modalities: ['text'],
    use_responses_lite: true,
    base_instructions: 'You are Codex, a fixture agent.',
  }, overrides)
}

function build(modelEntry, providerEntry = { name: 'OpenCode Go', api: 'responses' }) {
  return C.buildCatalog({
    base: { models: [officialModel()] },
    config: {
      providers: { 'opencode-go': providerEntry },
      models: { 'deepseek-v4.1-flash': modelEntry },
    },
  })
}

function generated(built) {
  return built.catalog.models.find(m => m.slug.startsWith('mg-opencode-go-deepseek-v4-1-flash'))
}

function metaOf(built) {
  return built.meta.models.find(m => m.model === 'deepseek-v4.1-flash')
}

test('第三方 Responses 路由：声明 unified_exec，Codex 才会下发 exec_command', () => {
  const built = build({ provider: 'opencode-go', capability: 'chat', maxContext: 1000000, api: 'responses' })
  const model = generated(built)
  assert.equal(model.shell_type, 'unified_exec')
  assert.equal(metaOf(built).sources.toolAccess.mode, 'function_tools')
  assert.equal(metaOf(built).sources.toolAccess.confidence, 'protocol-derived')
  assert.match(metaOf(built).sources.toolAccess.evidence, /exec_command/)
})

test('provider 级 api=responses 同样触发工具声明（模型条目无需重复 api）', () => {
  const built = build({ provider: 'opencode-go', capability: 'chat', maxContext: 1000000 })
  assert.equal(generated(built).shell_type, 'unified_exec')
})

test('plaintextTools=true 的第三方路由触发工具声明', () => {
  const built = build({
    provider: 'opencode-go', capability: 'chat', maxContext: 1000000,
    codex: { plaintextTools: true, history: { agentMessage: 'project', reasoning: 'drop', compaction: 'reject' } },
  }, { name: 'OpenCode Go', api: 'openai' })
  assert.equal(generated(built).shell_type, 'unified_exec')
})

test('模型级 api 覆盖 provider 级 api：显式 openai 路由不声明 shell 工具', () => {
  const built = build({ provider: 'opencode-go', capability: 'chat', maxContext: 128000, api: 'openai' },
    { name: 'OpenCode Go', api: 'responses' })
  assert.equal(generated(built).shell_type, 'disabled')
})

test('非 Responses / 未声明原生工具的第三方模型保持 disabled（不谎报工具能力）', () => {
  const built = build({ provider: 'opencode-go', capability: 'chat', maxContext: 128000 },
    { name: 'OpenCode Chat', api: 'openai' })
  const model = generated(built)
  assert.equal(model.shell_type, 'disabled')
  assert.equal(metaOf(built).sources.toolAccess.mode, 'none')
})

test('负向：第三方默认不得继承 use_responses_lite / tool_mode（官方 ChatGPT 专属）', () => {
  const built = build({ provider: 'opencode-go', capability: 'chat', maxContext: 1000000, api: 'responses' })
  const model = generated(built)
  assert.equal(Object.prototype.hasOwnProperty.call(model, 'use_responses_lite'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(model, 'tool_mode'), false)
  assert.notEqual(model.tool_mode, 'code_mode_only')
})

test('负向：官方模板的 code_mode_only / responses_lite 不被复制到第三方', () => {
  const base = { models: [officialModel({ slug: 'gpt-mode', tool_mode: 'code_mode_only', use_responses_lite: true })] }
  const built = C.buildCatalog({
    base,
    config: {
      providers: { 'opencode-go': { name: 'OpenCode Go', api: 'responses' } },
      models: { 'deepseek-v4.1-flash': { provider: 'opencode-go', capability: 'chat', maxContext: 1000000 } },
    },
  })
  const model = built.catalog.models.find(m => m.slug.startsWith('mg-opencode-go'))
  assert.equal(model.tool_mode, undefined)
  assert.equal(model.use_responses_lite, undefined)
  // 官方条目原样保留（不因第三方修复被改写）
  const official = built.catalog.models.find(m => m.slug === 'gpt-mode')
  assert.equal(official.tool_mode, 'code_mode_only')
  assert.equal(official.use_responses_lite, true)
})

test('显式 capabilities.shellType 覆盖默认（含 opt-out=disabled）', () => {
  const built = build({
    provider: 'opencode-go', capability: 'chat', maxContext: 1000000, api: 'responses',
    codex: {
      capabilities: { shellType: 'disabled' },
      evidence: { shellType: { source: 'local:test', observedAt: '2026-11-15' } },
    },
  })
  const model = generated(built)
  assert.equal(model.shell_type, 'disabled')
  assert.equal(metaOf(built).sources.toolAccess.mode, 'none')
  assert.equal(metaOf(built).sources.toolAccess.origin, 'models.deepseek-v4.1-flash.codex.capabilities.shellType')
})

test('useResponsesLite=true 与原生工具路由冲突 → fail-closed（本机探针 tools:None）', () => {
  assert.throws(() => build({
    provider: 'opencode-go', capability: 'chat', maxContext: 1000000, api: 'responses',
    codex: {
      capabilities: { useResponsesLite: true },
      evidence: { useResponsesLite: { source: 'local:test', observedAt: '2026-11-15' } },
    },
  }), err => err.code === 'responses_lite_disables_function_tools')
})

test('显式 code_mode_only + 原生工具路由：保留用户声明但给出可观察 warning', () => {
  const built = build({
    provider: 'opencode-go', capability: 'chat', maxContext: 1000000, api: 'responses',
    codex: {
      capabilities: { toolMode: 'code_mode_only' },
      evidence: { toolMode: { source: 'local:test', observedAt: '2026-11-15' } },
    },
  })
  assert.ok(built.meta.warnings.some(w => w.code === 'code_mode_tool_mode_hides_shell_tools'))
})
