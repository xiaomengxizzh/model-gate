// 启动器默认父模型可配置（纯离线：execFile bin/mg-desktop.mjs configure，零真实请求）。
//
// 钉死：
//   ① 默认（无 MG_PARENT_MODEL）：字节兼容 gpt-6-luna；
//   ② MG_PARENT_MODEL=deepseek-parent（官方缓存里的另一个 slug）：父仍是官方模型，
//      写 config.toml model = 该 slug（第三方聚合别名作父见 g2-parent-thirdparty.test.mjs）；
//   ③ 子代理配置逻辑不变（managed agent child 仍指向 Go 别名，effort=high）；
//   ④ 身份守卫未削弱：聚合别名出现在官方基线目录里仍被 official_slug_reuse 拒绝
//      （第三方别名作父的路线 A 在 g2-parent-thirdparty.test.mjs 单独覆盖）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { buildCatalog, asNativeDelegationParent } from '../../../src/codex/catalog.js'

const execFileAsync = promisify(execFile)
const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

const MODEL_CACHE = {
  models: [{
    slug: 'gpt-6-luna',
    display_name: 'GPT-6 Luna',
    description: 'Official fixture model',
    default_reasoning_level: 'low',
    supported_reasoning_levels: [{ effort: 'low', description: 'low reasoning' }, { effort: 'medium', description: 'medium reasoning' }],
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
    base_instructions: 'You are Codex.',
  }, {
    // 用作可配置父的 deepseek slug：刻意不同于子代理生成的聚合别名
    // mg-opencodego-deepseek-v4-1-flash（后者由 buildCatalog 从 models.deepseek-v4.1-flash +
    // opencodego 生成，若同时作为官方父会触发 official_slug_reuse——见本文件末尾的约束测试）。
    slug: 'deepseek-parent',
    display_name: 'DeepSeek Parent Probe',
    description: 'Third-party native fixture parent',
    default_reasoning_level: 'low',
    supported_reasoning_levels: [{ effort: 'low', description: 'low reasoning' }, { effort: 'medium', description: 'medium reasoning' }],
    shell_type: 'unified_exec',
    visibility: 'list',
    supported_in_api: true,
    priority: 2,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    support_verbosity: true,
    default_verbosity: 'low',
    apply_patch_tool_type: 'freeform',
    web_search_tool_type: 'text_and_image',
    truncation_policy: { mode: 'tokens', limit: 10000 },
    context_window: 128000,
    max_context_window: 128000,
    experimental_supported_tools: [],
    input_modalities: ['text'],
    base_instructions: 'You are Codex.',
  }],
}

async function configureWith (t, { parentModelEnv, slugs, extraEnv } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mg-g2-parent-'))
  const modelsPath = join(root, 'models_cache.json')
  await writeFile(modelsPath, JSON.stringify(slugs ? MODEL_CACHE : { models: MODEL_CACHE.models.filter((m) => m.slug === 'gpt-6-luna') }), 'utf8')
  const home = join(root, 'home')
  const codex = join(home, '.codex')
  await mkdir(codex, { recursive: true })
  await writeFile(join(codex, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'synthetic-offline-token', account_id: 'acct-canary' } }), 'utf8')
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  const state = join(root, 'state')
  const env = {
    ...process.env,
    HOME: home, CODEX_HOME: codex,
    MG_DESKTOP_STATE: state,
    MG_DESKTOP_MODELS: modelsPath,
    MG_DESKTOP_PORT: '18879',
    MG_DESKTOP_SUBSCRIPTION_MODE: 'app',
    ...(extraEnv || {}),
  }
  if (parentModelEnv !== undefined) env.MG_PARENT_MODEL = parentModelEnv
  else delete env.MG_PARENT_MODEL
  const { stdout } = await execFileAsync(process.execPath, [join(ROOT, 'bin/mg-desktop.mjs'), 'configure'], { env, timeout: 30000 })
  const printed = JSON.parse(stdout.trim())
  const desktopCodex = join(state, 'codex')
  const desktopToml = await readFile(join(desktopCodex, 'config.toml'), 'utf8')
  return { printed, desktopToml, state, codex: desktopCodex, root }
}

test('① 默认父模型字节兼容 gpt-6-luna（未设 MG_PARENT_MODEL）', { timeout: 30000 }, async (t) => {
  const { printed, desktopToml } = await configureWith(t)
  assert.equal(printed.parentModel, 'gpt-6-luna', '默认父模型仍为 luna')
  assert.equal(desktopToml.includes('model = "gpt-6-luna"'), true, 'config.toml 默认 model 行为 luna')
})

test('② MG_PARENT_MODEL 可显式把父设为 deepseek slug（deepseek→deepseek 验证前置）', { timeout: 30000 }, async (t) => {
  const { printed, desktopToml } = await configureWith(t, { parentModelEnv: 'deepseek-parent', slugs: true })
  assert.equal(printed.parentModel, 'deepseek-parent', '父模型切到 deepseek slug')
  assert.equal(desktopToml.includes('model = "deepseek-parent"'), true, 'config.toml model 为 deepseek slug')
  assert.equal(desktopToml.includes('model = "gpt-6-luna"'), false, '不再回落到 luna')
})

test('③ 子代理配置逻辑不变：managed agent child 仍指向 Go 别名且 effort=high', { timeout: 30000 }, async (t) => {
  const { printed, desktopToml, codex } = await configureWith(t, { parentModelEnv: 'deepseek-parent', slugs: true })
  assert.ok(printed.alias, 'Go 子代理别名仍生成')
  assert.equal(desktopToml.includes('[agents.go_deepseek]'), true, 'managed agent 段仍在')
  // 子代理 effort 写在独立的 child TOML（由 buildManagedAgentConfig 生成），不在 desktop config.toml。
  const files = readdirSync(codex)
  const childFile = files.find((f) => f.endsWith('.toml') && f !== 'config.toml')
  assert.ok(childFile, 'managed agent child TOML 存在')
  const childToml = await readFile(join(codex, childFile), 'utf8')
  assert.equal(childToml.includes('model_reasoning_effort = "high"'), true, '子代理 effort=high 未被父模型切换影响')
  assert.equal(childToml.includes('model = ' + JSON.stringify(printed.alias)), true, '子代理目标仍是 Go 别名')
})

test('④ 身份守卫未削弱：把聚合别名写进官方基线目录仍被 official_slug_reuse 拒绝', { timeout: 30000 }, async () => {
  // 路线 A（g2-parent-thirdparty.test.mjs）改的是"configure 不再把第三方父别名当官方模型"，
  // **不是**放宽守卫：只要 mg-* 别名还出现在 official-models.json（官方基线）里，
  // catalog.js:1002-1004 的身份零碰撞守卫就必须继续 fail-closed。
  const officialLuna = asNativeDelegationParent(MODEL_CACHE.models[0])
  const aliasAsOfficial = asNativeDelegationParent(Object.assign({}, MODEL_CACHE.models[0], {
    slug: 'mg-opencodego-deepseek-v4-1-flash',
    display_name: 'Alias smuggled into official catalog',
  }))
  const config = {
    defaults: { codexOfficialProvider: 'chatgpt-plan' },
    providers: { opencodego: {} },
    models: { 'deepseek-v4.1-flash': { provider: 'opencodego', api: 'responses', maxContext: 128000, reasoning: 'low', effortOptions: ['low', 'high'] } },
  }
  assert.throws(
    () => buildCatalog({ base: { models: [officialLuna, aliasAsOfficial] }, config }),
    (err) => err.code === 'official_slug_reuse',
    '官方目录与聚合 ID 同名必须 fail-closed（守卫未因路线 A 放宽）'
  )
})
