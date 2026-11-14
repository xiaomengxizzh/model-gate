import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startGateway, startScriptedUpstream } from './harness.mjs'

// D2×D1 一致性：/v1/models 与路由必须同源；模型下架后立即 404 且零上游。
// 自包含：合成官方基线写入本用例的 OS 临时目录（不再依赖 /tmp/mg-e0 外部夹具，也不 skip）。

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

test('目录与路由同源：/v1/models 列出聚合 slug，下架后 404 且零上游', { timeout: 60000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mg-codex-coherence-'))
  const basePath = join(dir, 'catalog-base.json')
  writeFileSync(basePath, JSON.stringify({ models: [officialModel(), officialModel({ slug: 'gpt-test-hidden', display_name: 'GPT Test Hidden', visibility: 'hide', priority: 2 })] }))

  const hits = []
  const up = await startScriptedUpstream(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    hits.push({ model: JSON.parse(Buffer.concat(chunks).toString('utf8')).model })
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ id: 'c1', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
  })
  const gw = await startGateway({
    env: { MG_ADMIN_TOKEN: '' },
    config: {
      providers: { third: { baseUrl: up.base + '/v1', api: 'openai' } },
      models: {
        alpha: { provider: 'third', api: 'openai', maxContext: 128000 },
        beta: { provider: 'third', api: 'openai', maxContext: 128000 },
      },
      defaults: { model: '', codexOfficialProvider: '', codexCatalogBasePath: basePath },
    },
  })
  t.after(async () => { await gw.stop(); await up.stop(); rmSync(dir, { recursive: true, force: true }) })

  const models1 = await gw.get('/v1/models?client_version=0.167.0').then((r) => r.json())
  const slugs1 = (models1.models || []).map((m) => m.slug)
  assert.ok(slugs1.includes('gpt-test-sol'), '官方基线条目必须保留：' + slugs1.slice(0, 5))
  assert.ok(slugs1.includes('mg-third-alpha'), '目录应包含 mg-third-alpha：' + slugs1.slice(-3))
  assert.ok(slugs1.includes('mg-third-beta'), '目录应包含 mg-third-beta')

  const ok = await gw.call('/v1/responses', { method: 'POST', body: { model: 'mg-third-alpha', input: 'hi', stream: false } })
  assert.equal(ok.status, 200)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].model, 'alpha', '上游必须收到原始模型名，而不是 slug')

  // 下架 beta：改配置文件后 reload
  const cfgPath = join(gw.dir, 'gateway.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
  delete cfg.models.beta
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const reload = await gw.call('/api/config/reload', { method: 'POST' })
  assert.equal(reload.status, 200)

  const models2 = await gw.get('/v1/models?client_version=0.167.0').then((r) => r.json())
  const slugs2 = (models2.models || []).map((m) => m.slug)
  assert.ok(!slugs2.includes('mg-third-beta'), '下架后目录不得再列出 beta')
  assert.ok(slugs2.includes('mg-third-alpha'), 'alpha 仍应存在')
  assert.ok(models2.models.length < models1.models.length, '整代替换语义：条目数应减少')

  const before = hits.length
  const gone = await gw.call('/v1/responses', { method: 'POST', body: { model: 'mg-third-beta', input: 'hi', stream: false } })
  assert.equal(gone.status, 404)
  const body = await gone.json()
  assert.equal(body.error.type, 'unknown_model')
  assert.equal(hits.length, before, '下架的聚合 ID 必须零上游请求')
})
