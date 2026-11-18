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
//
// 真机前置清单（本文件不执行，供隔离验收照做）：
//   1) 必须用隔离 client home：CODEX_HOME=<state>/codex（launcher 保证），验收前确认该目录**没有**
//      auth.json；禁止把 CODEX_HOME 指向 ~/.codex（那里有用户真实登录）。
//   2) 客户端能否校验 config.model 与本机账号模型列表：已在本机只读核查——codex-cli 0.167.0
//      （harness vendored 二进制）与桌面 app 的 codex bundle 内**均不含**
//      "not supported when using Codex with a ChatGPT account" 这类字符串，故该报错不可能由这两个
//      build 直接产生；且本配置走 managed provider（requires_openai_auth=false + env_key），
//      客户端不用 ChatGPT 凭据访问本地网关，代码层面判断"不应触发账号模型校验"。
//      但"顶层 model=mg-* 走该 provider"没有真机回执 → 标记 UNVERIFIED，需真机确认。
//   3) 判定：父请求日志 provider=opencodego / domain=thirdParty，零 model_not_found。
//   4) 本套件已如实固化：目录只声明 shell/apply_patch 工具，未声明多代理能力（multi_agent_version/
//      tool_mode），故 spawn_agent/send_input/resume_agent/wait_agent 是否下发必须真机观察。
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

test('③a MG_PARENT_MODEL=第三方聚合别名：configure 成功，gateway.json 无 defaults.model 键，别名不进官方目录', { timeout: 30000 }, async (t) => {
  const { printed, configToml, officialCatalog, clientCatalog, gateway } = await configureWith(t, {
    models: [LUNA, DEEPSEEK_PARENT], parentModel: ALIAS,
  })
  assert.equal(printed.parentModel, ALIAS)
  assert.equal(printed.alias, ALIAS, '父就是子代理同一个聚合别名')
  // 默认模型由 config.toml 的 model 承担；网关 defaults.model 是"虚拟共用模型名"
  // （router.js:357/505-507），写入聚合别名会与 binding slug 撞身份（catalog.js:1021-1038）——
  // 这里断言的是"键不存在"，不是空串/空值。
  assert.equal(Object.prototype.hasOwnProperty.call(gateway.defaults, 'model'), false, 'gateway.defaults 不得有 model 键')
  assert.equal(officialCatalog.models.some((m) => m.slug === ALIAS), false, '第三方别名绝不登记为官方目录模型')
  assert.deepEqual(officialCatalog.models.map((m) => m.slug), ['gpt-6-luna'], '官方基线退回 luna，官方父路径不变')
  assert.equal(clientCatalog.models.some((m) => m.slug === ALIAS), true, '客户端目录仍含该别名（Codex 才能按 model 发请求）')
  assert.equal(configToml.includes('model = "' + ALIAS + '"'), true)
  assert.equal(gateway.models[CHILD].provider, 'opencodego')
  assert.equal(gateway.defaults.codexOfficialProvider, 'chatgpt-plan', '官方分支未被削弱')
  // configure 成功本身即"不抛 official_slug_reuse / slug_collision"；再显式构造一次目录确认：
  const built = buildCatalog({ base: officialCatalog, config: gateway })
  assert.equal(built.meta.officialSlugs.includes(ALIAS), false)
  // 非恒真：改动前同一输入 exit 1（"catalog does not contain <alias>"）；旧版把别名塞进
  // official-models.json 时上面的 buildCatalog 会抛 official_slug_reuse。
})

test('③b 别名出现在聚合目录/绑定表：binding slug 唯一、provider=opencodego', { timeout: 30000 }, async (t) => {
  const { gateway, officialCatalog } = await configureWith(t, { models: [LUNA, DEEPSEEK_PARENT], parentModel: ALIAS })
  const built = buildCatalog({ base: officialCatalog, config: gateway })
  const slugs = Object.keys(built.meta.bindings)
  assert.deepEqual(slugs, [ALIAS], '绑定表只有该别名（父/子同别名不产生第二个 slug）')
  const binding = built.meta.bindings[ALIAS]
  assert.equal(binding.slug, ALIAS)
  assert.equal(binding.stableId, ALIAS)
  assert.equal(binding.provider, 'opencodego')
  assert.equal(binding.model, CHILD, '绑定到上游真实模型名，而不是别名自己')
  assert.equal(binding.capability, 'chat')
  assert.equal(built.catalog.models.filter((m) => m.slug === ALIAS).length, 1, '目录里同名条目唯一')
})

test('③c 缓存里也出现该别名时仍按第三方父处理（不因缓存污染退回 official_slug_reuse）', { timeout: 30000 }, async (t) => {
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

test('④ 解析层：请求 model=别名（defaults.model 未设）→ provider=opencodego、domain=thirdParty，非 chatgpt-plan', { timeout: 30000 }, async (t) => {
  const { gateway, officialCatalog, configToml } = await configureWith(t, { models: [LUNA, DEEPSEEK_PARENT], parentModel: ALIAS })
  assert.equal(Object.prototype.hasOwnProperty.call(gateway.defaults, 'model'), false, '前置：网关侧无默认模型兜底')
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
  // 纯解析层：请求体只带 model=别名，其余走 defaults（provider 未设 → 不允许兜底，必须由目录绑定解析）。
  const resolved = router.resolve(ALIAS)
  assert.equal(resolved.def.provider, 'opencodego')
  assert.notEqual(resolved.def.provider, 'chatgpt-plan', '绝不能落到官方 provider')
  assert.equal(resolved.def.codexOfficial, undefined, '不是官方透传')
  assert.equal(resolved.def.codexAggregate, true)
  assert.equal(resolved.def.servingModel, CHILD)
  assert.deepEqual(resolved.def.providerModels, { opencodego: CHILD })
  // 发送域判定（src/forward.js:628-636 用的同一函数）→ domain=thirdParty，不是 official。
  const thirdParty = classifyTarget(gateway.providers[resolved.def.provider], gateway)
  assert.equal(thirdParty.kind, 'thirdParty')
  assert.equal(thirdParty.host, 'opencode.ai')
  const official = classifyTarget(gateway.providers['chatgpt-plan'], gateway)
  assert.equal(official.kind, 'official', '官方 provider 仍是官方域')
  assert.notEqual(thirdParty.kind, official.kind)
  // 官方与第三方身份不混：别名必须不在 officialSlugs 中，否则 router.js:454 会改走官方 provider。
  assert.equal(built.meta.officialSlugs.includes(ALIAS), false)
  assert.equal(built.meta.officialSlugs.includes('gpt-6-luna'), true)

  // ── 3d 工具路由：nativeToolRoute=true（catalog.js:704-707 的 effectiveApi/plaintextTools 条件）──
  // 先断言该条件本身成立：api='responses' 且 plaintextTools=true（两条都为真，任一条即可）。
  const childCfg = gateway.models[CHILD]
  assert.equal(childCfg.api, 'responses')
  assert.equal(childCfg.codex.plaintextTools, true)
  assert.equal(childCfg.api === 'responses' || childCfg.codex.plaintextTools === true, true, 'nativeToolRoute 前置条件')
  // 可观测载体是 meta.models[].sources.toolAccess（catalog.js:868-880）：只在原生工具路由下给出
  // function_tools + unified_exec；非原生路由会退化成 shell_type='disabled' 且把 shell_type 记入保守字段。
  const entryMeta = built.meta.models.find((m) => m.slug === ALIAS)
  assert.ok(entryMeta, '别名有 meta（来源/证据可审计）')
  assert.equal(entryMeta.sources.toolAccess.mode, 'function_tools')
  assert.equal(entryMeta.sources.toolAccess.shellType, 'unified_exec')
  assert.equal(entryMeta.sources.toolAccess.useResponsesLite, false)
  assert.equal(entryMeta.sources.toolAccess.origin, 'models.' + CHILD + '.codex.capabilities.shellType')
  assert.equal(entryMeta.sources.toolAccess.confidence, 'declared', 'shell_type 来自显式 capabilities 声明')
  assert.equal(entryMeta.sources.clientBehavior.fields.includes('shell_type'), false, 'shell_type 不是保守默认值（nativeToolRoute=true 的判别）')
  const aliasEntry = built.catalog.models.find((m) => m.slug === ALIAS)
  assert.equal(aliasEntry.shell_type, 'unified_exec', '拿到 exec_command/write_stdin')
  assert.equal(aliasEntry.apply_patch_tool_type, 'freeform', '拿到 apply_patch')
  assert.notEqual(aliasEntry.shell_type, 'disabled')

  // ── V1 派单工具（spawn_agent / send_input / resume_agent / wait_agent）的真实声明层级 ──
  // 事实（不粉饰）：客户端只有在 [features] multi_agent=true 且模型条目声明了多代理版本/工具模式时，
  // 才会发布 V1 协作工具；官方 luna 正是被 asNativeDelegationParent 投影成
  // tool_mode=direct + multi_agent_version=v1 + use_responses_lite=false（catalog.js:84-99）。
  // 第三方别名走 buildThirdPartyEntry 的保守骨架：未声明这三项 → 真机是否出现 spawn_agent 未知。
  assert.equal(aliasEntry.multi_agent_version, undefined, '目录未声明多代理版本（第三方保守骨架）')
  assert.equal(aliasEntry.tool_mode, undefined, '目录未声明 tool_mode')
  assert.equal(aliasEntry.supports_search_tool, undefined, '目录未声明 supports_search_tool')
  assert.equal(configToml.includes('[features]'), true)
  assert.equal(configToml.includes('multi_agent = true'), true, '只声明了客户端特性开关，不是模型级多代理能力')
  // 结论（真机前置条件）：网关层已证明"能拿到 function tools"，但"能拿到 V1 派单工具"没有任何一层
  // 声明——缺的是模型目录的多代理能力声明（models.<child>.codex.capabilities.multiAgentVersion /
  // toolMode），不是网关路由。按"能力声明需证据"，本改动不补写；真机必须先观察 tools 是否含 spawn_agent。
  // 非恒真：若别名留在 official-models.json，resolve 返回 {provider:'chatgpt-plan', api:'responses',
  // codexOfficial:true}，上面 provider/domain 断言全部失败；更早一步 buildCatalog 会抛 official_slug_reuse。
})

test('⑤ 该别名作父时子代理仍生成：child 指向 Go 别名、effort=high；父子同别名不撞 slug', { timeout: 30000 }, async (t) => {
  const { printed, configToml, codex, clientCatalog, gateway, officialCatalog } = await configureWith(t, {
    models: [LUNA, DEEPSEEK_PARENT], parentModel: ALIAS,
  })
  assert.equal(printed.alias, ALIAS)
  assert.equal(printed.parentModel, ALIAS, '父与子落在同一个聚合别名上（本用例核心场景）')
  assert.equal(configToml.includes('[agents.go_deepseek]'), true, 'managed agent 段仍在')
  const childFile = readdirSync(codex).find((f) => f.endsWith('.toml') && f !== 'config.toml')
  assert.ok(childFile, 'managed agent child TOML 存在')
  const childToml = await readFile(join(codex, childFile), 'utf8')
  assert.equal(childToml.includes('model = ' + JSON.stringify(ALIAS)), true, '子代理目标仍是 Go 别名')
  assert.equal(childToml.includes('model_reasoning_effort = "high"'), true, '子代理 effort=high 不受母身份切换影响')
  // 父子同别名不产生身份冲突：目录里该 slug 唯一，绑定表也唯一（重复即 slug_collision / binding 覆盖）。
  assert.equal(clientCatalog.models.filter((m) => m.slug === ALIAS).length, 1)
  const built = buildCatalog({ base: officialCatalog, config: gateway })
  assert.deepEqual(Object.keys(built.meta.bindings), [ALIAS])
  assert.equal(built.meta.counts.thirdParty, 1)
  // 非恒真：若把第三方父当成官方模型，official-models.json 只会剩别名（无 luna），
  // buildCatalog 直接 official_slug_reuse，本用例在 configure 阶段就 exit 1。
})
