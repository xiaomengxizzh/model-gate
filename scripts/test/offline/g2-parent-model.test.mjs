// 启动器默认父模型可配置（纯离线：execFile bin/mg-desktop.mjs configure，零真实请求）。
//
// 钉死：
//   ① 默认（无 MG_PARENT_MODEL）：字节兼容 gpt-6-luna；
//   ② MG_PARENT_MODEL=mg-opencodego-deepseek-v4-1-flash：显式设为 deepseek slug，
//      用于后续 deepseek→deepseek 真机验证；writes config.toml model = 该 slug；
//   ③ 子代理配置逻辑不变（managed agent child 仍指向 Go 别名，effort=high）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

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

test('④ 已知边界：把子代理生成的聚合别名 slug 直接当父会因 official_slug_reuse 被拒（非本改动引入）', { timeout: 30000 }, async (t) => {
  // 约束事实（如实记录）：models.deepseek-v4.1-flash + provider opencodego 会由 buildCatalog 生成
  // 聚合 ID mg-opencodego-deepseek-v4-1-flash；若把同一字符串设为官方父 slug，catalog 身份零碰撞
  // 守卫（catalog.js:1002-1004）在写配置前 fail-closed。这是目录身份不变量，不是父模型可配置改动
  // 的回归；deepseek→deepseek 真机验证应选用不同的父 slug（如 ② 的 deepseek-parent）。
  const aliasAsParent = MODEL_CACHE.models.map((m) => Object.assign({}, m, {
    slug: m.slug === 'deepseek-parent' ? 'mg-opencodego-deepseek-v4-1-flash' : m.slug,
  }))
  const root = await mkdtemp(join(tmpdir(), 'mg-g2-parent-collision-'))
  const modelsPath = join(root, 'models_cache.json')
  await writeFile(modelsPath, JSON.stringify({ models: aliasAsParent }), 'utf8')
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  const env = {
    ...process.env,
    HOME: root, CODEX_HOME: join(root, '.codex'),
    MG_DESKTOP_STATE: join(root, 'state'), MG_DESKTOP_MODELS: modelsPath,
    MG_DESKTOP_SUBSCRIPTION_MODE: 'app', MG_PARENT_MODEL: 'mg-opencodego-deepseek-v4-1-flash',
  }
  await assert.rejects(
    execFileAsync(process.execPath, [join(ROOT, 'bin/mg-desktop.mjs'), 'configure'], { env, timeout: 30000 }),
    (err) => /official_slug_reuse|与官方 slug 冲突/.test(String(err.stderr || err.message || '')),
    '父 slug 与聚合子别名冲突时 fail-closed，不写配置'
  )
})
