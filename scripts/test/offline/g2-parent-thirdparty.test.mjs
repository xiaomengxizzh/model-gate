// G2 路线 A 离线回归：**第三方聚合别名**作父（MG_PARENT_MODEL=mg-opencodego-deepseek-v4-1-flash）。
//
// 真机缺陷（脱敏）：仅设 MG_PARENT_MODEL=<第三方别名> 时，configure 仍把该别名当官方缓存模型：
//   ① `models_cache.json` 里查不到别名 → 直接 "The Codex model catalog does not contain …"（exit 1）；
//   ② 若别名被写进 official-models.json → 网关启动时 buildCatalog 的 official_slug_reuse
//      （src/codex/catalog.js:1002-1004）fail-closed，目录为 null；
//   ③ 即便侥幸通过，src/router.js:453-458 对 official slug 只走 codexOfficialProvider，
//      父请求 3/3 命中 chatgpt-plan/官方域，opencodego 出站 0、thirdParty 0。
// 路线 A：把父身份判成"第三方聚合别名"——官方目录只留官方基线（luna 投影），别名只由目录绑定
// 解析到 provider=opencodego；官方分支、official_slug_reuse 守卫、router 硬分支一律不动。
//
// 纯离线：只 execFile `mg-desktop.mjs configure` + 纯函数解析（buildCatalog/createRouter/
// classifyTarget）。零服务启动、零上游请求、零真实凭据（只写 synthetic 标记串）。
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
import { createRouter } from '../../../src/router.js'
import { classifyTarget } from '../../../src/codex/identity.js'

const execFileAsync = promisify(execFile)
const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const ALIAS = 'mg-opencodego-deepseek-v4-1-flash'
const CHILD = 'deepseek-v4.1-flash'

const officialModel = (slug, priority) => ({
  slug,
  display_name: slug === 'gpt-6-luna' ? 'GPT-6 Luna' : 'DeepSeek Parent Probe',
  description: 'Official fixture model',
  default_reasoning_level: 'low',
  supported_reasoning_levels: [{ effort: 'low', description: 'low reasoning' }, { effort: 'medium', description: 'medium reasoning' }],
  shell_type: 'unified_exec',
  tool_mode: 'code_mode_only',
  use_responses_lite: true,
  multi_agent_version: 'v2',
  visibility: 'list',
  supported_in_api: true,
  priority,
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
})

const LUNA = officialModel('gpt-6-luna', 1)
const DEEPSEEK_PARENT = officialModel('deepseek-parent', 2)

async function configureWith (t, { models, parentModel, extraCache = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mg-g2-3p-parent-'))
  const modelsPath = join(root, 'models_cache.json')
  await writeFile(modelsPath, JSON.stringify({ models: [...models, ...extraCache] }), 'utf8')
  const home = join(root, 'home')
  const codex = join(home, '.codex')
  await mkdir(codex, { recursive: true })
  // synthetic 标记串：不是凭据，只为让 app 模式通过本地授权检查。
  await writeFile(join(codex, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'synthetic-offline-token' } }), 'utf8')
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  const state = join(root, 'state')
  const env = {
    ...process.env,
    HOME: home, CODEX_HOME: codex,
    MG_DESKTOP_STATE: state,
    MG_DESKTOP_MODELS: modelsPath,
    MG_DESKTOP_PORT: '18881',
    MG_DESKTOP_SUBSCRIPTION_MODE: 'app',
  }
  if (parentModel !== undefined) env.MG_PARENT_MODEL = parentModel
  else delete env.MG_PARENT_MODEL
  const { stdout } = await execFileAsync(process.execPath, [join(ROOT, 'bin/mg-desktop.mjs'), 'configure'], { env, timeout: 30000 })
  const desktopCodex = join(state, 'codex')
  return {
    printed: JSON.parse(stdout.trim()),
    configToml: await readFile(join(desktopCodex, 'config.toml'), 'utf8'),
    clientCatalog: JSON.parse(await readFile(join(desktopCodex, 'models.json'), 'utf8')),
    officialCatalog: JSON.parse(await readFile(join(state, 'gateway', 'official-models.json'), 'utf8')),
    gateway: JSON.parse(await readFile(join(state, 'gateway', 'gateway.json'), 'utf8')),
    codex: desktopCodex,
    state,
  }
}

test('① 未设 MG_PARENT_MODEL：默认 luna，official-models.json 与改动前同形（无新增 defaults.model）', { timeout: 30000 }, async (t) => {
  const { printed, configToml, officialCatalog, gateway } = await configureWith(t, { models: [LUNA, DEEPSEEK_PARENT] })
  assert.equal(printed.parentModel, 'gpt-6-luna')
  // 改动前该文件就是 {models:[asNativeDelegationParent(官方父)]}；任何多写的模型都会改变客户端目录。
  assert.deepEqual(officialCatalog, { models: [asNativeDelegationParent(LUNA)] })
  // gateway defaults 键集与改动前完全一致（新增 defaults.model 会被这条抓到：它会改变语义，
  // 见 router.js:357/505-507 —— defaults.model 是"虚拟共用模型名"）。
  assert.deepEqual(Object.keys(gateway.defaults).sort(), ['codexCatalogBasePath', 'codexOfficialProvider', 'proxy', 'timeout'])
  assert.equal(gateway.defaults.codexOfficialProvider, 'chatgpt-plan')
  assert.equal(configToml.includes('model_provider = "modelgate"'), true)
  assert.equal(configToml.includes('model = "gpt-6-luna"'), true)
  assert.equal(configToml.includes('requires_openai_auth = false'), true)
})

test('② MG_PARENT_MODEL=官方 slug：沿用旧行为，父仍登记为官方目录模型', { timeout: 30000 }, async (t) => {
  const { printed, configToml, officialCatalog, gateway } = await configureWith(t, {
    models: [LUNA, DEEPSEEK_PARENT], parentModel: 'deepseek-parent',
  })
  assert.equal(printed.parentModel, 'deepseek-parent')
  assert.deepEqual(officialCatalog.models.map((m) => m.slug), ['deepseek-parent'], '官方缓存里的父仍按官方模型投影')
  assert.equal(gateway.defaults.codexOfficialProvider, 'chatgpt-plan', '官方父仍走官方 provider')
  assert.equal(configToml.includes('model = "deepseek-parent"'), true)
  // 非恒真：若把"只要不等于 childAlias 就当官方"写成"只要设了 env 就走第三方"，
  // 这里会变成 [luna] 而断言失败。
})

test('③ MG_PARENT_MODEL=第三方聚合别名：别名不进 official-models.json，且不抛 official_slug_reuse', { timeout: 30000 }, async (t) => {
  const { printed, configToml, officialCatalog, clientCatalog, gateway } = await configureWith(t, {
    models: [LUNA, DEEPSEEK_PARENT], parentModel: ALIAS,
  })
  assert.equal(printed.parentModel, ALIAS)
  assert.equal(printed.alias, ALIAS, '父就是子代理同一个聚合别名')
  assert.equal(officialCatalog.models.some((m) => m.slug === ALIAS), false, '第三方别名绝不登记为官方目录模型')
  assert.deepEqual(officialCatalog.models.map((m) => m.slug), ['gpt-6-luna'], '官方基线退回 luna，官方父路径不变')
  assert.equal(clientCatalog.models.some((m) => m.slug === ALIAS), true, '客户端目录仍含该别名（Codex 才能按 model 发请求）')
  assert.equal(configToml.includes('model = "' + ALIAS + '"'), true)
  assert.equal(gateway.models[CHILD].provider, 'opencodego')
  assert.equal(gateway.defaults.codexOfficialProvider, 'chatgpt-plan', '官方分支未被削弱')
  // 非恒真：改动前同一输入 exit 1（"catalog does not contain <alias>"）；旧版把别名塞进
  // official-models.json 时，下一步 buildCatalog 会抛 official_slug_reuse（见 ⑤ 的 buildCatalog 调用）。
})

test('③b 缓存里也出现该别名时仍按第三方父处理（不因缓存污染退回 official_slug_reuse）', { timeout: 30000 }, async (t) => {
  // 真机缺陷 ②的形态：该别名曾被写进 official-models.json 并被当成官方 slug。
  // 这里进一步把别名放进 models_cache，确认身份判定来自"生成规则"而不是"缓存成员资格"。
  const polluted = Object.assign({}, officialModel(ALIAS, 3))
  const { officialCatalog, clientCatalog } = await configureWith(t, {
    models: [LUNA, DEEPSEEK_PARENT], parentModel: ALIAS, extraCache: [polluted],
  })
  assert.equal(officialCatalog.models.some((m) => m.slug === ALIAS), false)
  assert.deepEqual(officialCatalog.models.map((m) => m.slug), ['gpt-6-luna'])
  assert.equal(clientCatalog.models.some((m) => m.slug === ALIAS), true)
})

test('④ 解析层：该别名解析为 provider=opencodego、domain=thirdParty；官方目标仍 official', { timeout: 30000 }, async (t) => {
  const { gateway, officialCatalog } = await configureWith(t, { models: [LUNA, DEEPSEEK_PARENT], parentModel: ALIAS })
  // 复刻 src/index.js:169-205 的目录视图构造（纯函数，不启服务）。
  const built = buildCatalog({ base: officialCatalog, config: gateway })
  gateway._codexCatalog = {
    models: built.catalog.models,
    bindings: built.meta.bindings,
    officialSlugs: built.meta.officialSlugs,
    aliases: built.meta.aliases,
    generation: 1,
  }
  const router = createRouter(gateway)
  const resolved = router.resolve(ALIAS)
  assert.equal(resolved.def.provider, 'opencodego')
  assert.equal(resolved.def.codexOfficial, undefined, '不是官方透传')
  assert.equal(resolved.def.codexAggregate, true)
  assert.equal(resolved.def.servingModel, CHILD)
  assert.deepEqual(resolved.def.providerModels, { opencodego: CHILD })
  // 发送域判定（src/forward.js:628-636 用的同一函数）。
  const thirdParty = classifyTarget(gateway.providers.opencodego, gateway)
  assert.equal(thirdParty.kind, 'thirdParty')
  assert.equal(thirdParty.host, 'opencode.ai')
  const official = classifyTarget(gateway.providers['chatgpt-plan'], gateway)
  assert.equal(official.kind, 'official', '官方 provider 仍是官方域')
  // 官方与第三方身份不混：别名必须不在 officialSlugs 中，否则 router.js:454 会改走官方 provider。
  assert.equal(built.meta.officialSlugs.includes(ALIAS), false)
  assert.equal(built.meta.officialSlugs.includes('gpt-6-luna'), true)
  // 非恒真：若别名留在 official-models.json，registry 的 officialSlugs 会含它，resolve 返回
  // {provider:'chatgpt-plan', api:'responses', codexOfficial:true}，上面 4 条断言全部失败；
  // 更早一步 buildCatalog 还会抛 official_slug_reuse。
})

test('⑤ 该别名作父时子代理仍生成：child 指向 Go 别名、effort=high、父/子同身份不同注入', { timeout: 30000 }, async (t) => {
  const { printed, configToml, codex } = await configureWith(t, { models: [LUNA, DEEPSEEK_PARENT], parentModel: ALIAS })
  assert.equal(printed.alias, ALIAS)
  assert.equal(configToml.includes('[agents.go_deepseek]'), true, 'managed agent 段仍在')
  const childFile = readdirSync(codex).find((f) => f.endsWith('.toml') && f !== 'config.toml')
  assert.ok(childFile, 'managed agent child TOML 存在')
  const childToml = await readFile(join(codex, childFile), 'utf8')
  assert.equal(childToml.includes('model = ' + JSON.stringify(ALIAS)), true, '子代理目标仍是 Go 别名')
  assert.equal(childToml.includes('model_reasoning_effort = "high"'), true, '子代理 effort=high 不受母身份切换影响')
  // 非恒真：若把第三方父当成官方模型，official-models.json 只会剩别名（无 luna），
  // buildCatalog 直接 official_slug_reuse，本用例在 configure 阶段就 exit 1。
})
