// V2-REAL-3 / A4：订阅模式（策略 A）与配置生成（离线，纯模块 + 临时目录 + 子进程 configure）。
//
// 覆盖所有者决策：默认「复用本机 Codex 登录」，但必须可控、可解释、可回滚。
//   · auto/local/app/off 四模式判定与 typed 失败（local 缺登录绝不静默切 app）；
//   · 配置生成完整性：local 必写 baseUrl=chatgpt.com + responsesPath=/backend-api/codex/responses +
//     gatewaySubscription.enabled；app/off 必不写订阅字段（off 回到「需网关自有 key」）；
//   · 真实入口 bin/mg-desktop.mjs configure 在四种模式下写出的 gateway.json 与判定一致。
// 零网络：configure 只读模型缓存与本地登录文件，不发请求；token 是虚构 canary。
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  DESKTOP_SUBSCRIPTION_MODE_ENV, DESKTOP_SUBSCRIPTION_MODES,
  SUBSCRIPTION_CREDENTIAL_REASONS, CHATGPT_BASE_URL, OPENAI_API_BASE_URL, SUBSCRIPTION_RESPONSES_PATH,
  probeLocalCodexAuth, resolveSubscriptionMode, buildSubscriptionProviderConfig,
  isSubscriptionModeError,
} from '../../../src/codex/local-subscription.js'

const execFileAsync = promisify(execFile)
const ROOT = new URL('../../../', import.meta.url).pathname
const CANARY = 'CANARY-SUBSCRIPTION-ACCESS-TOKEN'

function b64url(value) { return Buffer.from(JSON.stringify(value)).toString('base64url') }
function token(exp = Math.floor(Date.now() / 1000) + 3600) {
  return b64url({ alg: 'none', typ: 'JWT' }) + '.' + b64url({ exp, sub: 'canary', marker: CANARY }) + '.sig'
}

async function homeWith(authJson) {
  const home = await mkdtemp(join(tmpdir(), 'mg-v2-real3-mode-'))
  const codex = join(home, '.codex')
  await mkdir(codex, { recursive: true })
  await writeFile(join(codex, 'auth.json'), JSON.stringify(authJson), 'utf8')
  return { home, codex, env: { HOME: home, CODEX_HOME: codex } }
}

function modeErrorOf(fn) {
  try { fn() } catch (error) {
    assert.equal(isSubscriptionModeError(error), true, '必须是 typed SubscriptionModeError：' + (error && error.message))
    assert.equal(error.deny, true)
    assert.equal(typeof error.code, 'string')
    return error
  }
  assert.fail('预期被拒绝，实际放行')
}

test('本机登录探测：只有 auth_mode=chatgpt 且有 access_token 才算可用', async (t) => {
  const homes = []
  t.after(async () => { for (const h of homes) await rm(h.home, { recursive: true, force: true }) })

  const good = await homeWith({ auth_mode: 'chatgpt', tokens: { access_token: token(), account_id: 'acct-canary' } })
  homes.push(good)
  const ok = probeLocalCodexAuth({ env: good.env })
  assert.equal(ok.available, true)
  assert.equal(ok.reason, 'local_codex_chatgpt')
  assert.equal(ok.authMode, 'chatgpt')
  assert.equal(JSON.stringify(ok).includes(CANARY), false, '探测结果不得带 token')

  const apiKeyMode = await homeWith({ auth_mode: 'apikey', tokens: {} })
  homes.push(apiKeyMode)
  const apiKey = probeLocalCodexAuth({ env: apiKeyMode.env })
  assert.equal(apiKey.available, false)
  assert.equal(apiKey.reason, SUBSCRIPTION_CREDENTIAL_REASONS.AUTH_MODE_NOT_CHATGPT)

  const noMode = await homeWith({ tokens: { access_token: token() } })
  homes.push(noMode)
  assert.equal(probeLocalCodexAuth({ env: noMode.env }).reason, SUBSCRIPTION_CREDENTIAL_REASONS.AUTH_MODE_MISSING)

  const noToken = await homeWith({ auth_mode: 'chatgpt', tokens: {} })
  homes.push(noToken)
  assert.equal(probeLocalCodexAuth({ env: noToken.env }).reason, SUBSCRIPTION_CREDENTIAL_REASONS.TOKEN_MISSING)

  const keyMode = await homeWith({ auth_mode: 'chatgpt', tokens: {}, OPENAI_API_KEY: 'sk-canary' })
  homes.push(keyMode)
  assert.equal(probeLocalCodexAuth({ env: keyMode.env }).reason, SUBSCRIPTION_CREDENTIAL_REASONS.API_KEY_MODE)

  const missing = await mkdtemp(join(tmpdir(), 'mg-v2-real3-empty-'))
  t.after(async () => { await rm(missing, { recursive: true, force: true }) })
  assert.equal(probeLocalCodexAuth({ env: { HOME: missing, CODEX_HOME: join(missing, '.codex') } }).reason, SUBSCRIPTION_CREDENTIAL_REASONS.FILE_MISSING)
})

test('模式矩阵：auto 按登录自动选择，local/app/off 显式且不互相静默降级', async (t) => {
  const good = await homeWith({ auth_mode: 'chatgpt', tokens: { access_token: token() } })
  t.after(async () => { await rm(good.home, { recursive: true, force: true }) })
  const noLogin = { HOME: good.home + '-nope', CODEX_HOME: join(good.home + '-nope', '.codex') }

  // auto：有本机登录 → local；无 → app。
  const autoLocal = resolveSubscriptionMode({ env: good.env })
  assert.equal(autoLocal.requested, 'auto')
  assert.equal(autoLocal.mode, 'local')
  assert.equal(autoLocal.reason, 'auto_local_login')
  assert.equal(autoLocal.usesLocalAuth, true)
  assert.equal(autoLocal.usesPlanToken, false)
  const autoApp = resolveSubscriptionMode({ env: noLogin })
  assert.equal(autoApp.mode, 'app')
  assert.equal(autoApp.reason, 'auto_no_local_login')
  assert.equal(autoApp.usesPlanToken, true)

  // 显式 local：有登录 → local；无登录 → typed subscription_login_missing（不静默切 app）。
  assert.equal(resolveSubscriptionMode({ env: good.env, mode: 'local' }).mode, 'local')
  const missingLogin = modeErrorOf(() => resolveSubscriptionMode({ env: noLogin, mode: 'local' }))
  assert.equal(missingLogin.code, 'subscription_login_missing')
  assert.equal(missingLogin.reason, SUBSCRIPTION_CREDENTIAL_REASONS.FILE_MISSING)
  assert.match(missingLogin.message, /MG_DESKTOP_SUBSCRIPTION_MODE=off/)
  assert.equal(missingLogin.message.includes(CANARY), false)

  // app / off 是纯显式：即使本机有登录也不改变，且 off 不做本地登录探测。
  let probed = 0
  assert.equal(resolveSubscriptionMode({ mode: 'app' }).mode, 'app')
  const off = resolveSubscriptionMode({ mode: 'off', probe: () => { probed += 1; return { available: true } } })
  assert.equal(off.mode, 'off')
  assert.equal(off.writesSubscriptionFields, false)
  assert.equal(probed, 0, 'off 不应探测本地登录')

  // 环境变量入口与大小写/空白容错。
  assert.equal(resolveSubscriptionMode({ env: { [DESKTOP_SUBSCRIPTION_MODE_ENV]: ' OFF ' } }).mode, 'off')
  assert.equal(DESKTOP_SUBSCRIPTION_MODES.join(','), 'auto,local,app,off')
  const invalid = modeErrorOf(() => resolveSubscriptionMode({ mode: 'subscription' }))
  assert.equal(invalid.code, 'subscription_mode_invalid')
  assert.equal(invalid.status, 400, '非法配置是 400；需要用户动作的 local 缺登录才是 409')
})

test('配置生成：local 写全订阅字段，app/off 绝不写订阅字段', () => {
  const local = buildSubscriptionProviderConfig('local')
  assert.deepEqual(local.provider, {
    baseUrl: CHATGPT_BASE_URL,
    codexIdentity: 'official',
    responsesPath: SUBSCRIPTION_RESPONSES_PATH,
    gatewaySubscription: { enabled: true },
  })
  assert.equal(local.provider.baseUrl, 'https://chatgpt.com')
  assert.equal(local.provider.responsesPath, '/backend-api/codex/responses')
  assert.equal(local.meta.writesSubscriptionFields, true)
  assert.equal(local.meta.usesPlanToken, false)

  for (const mode of ['app', 'off']) {
    const built = buildSubscriptionProviderConfig(mode)
    assert.equal(built.provider.baseUrl, OPENAI_API_BASE_URL)
    assert.equal(built.provider.codexIdentity, 'official')
    assert.equal('responsesPath' in built.provider, false, mode + ' 不得写 responsesPath')
    assert.equal('gatewaySubscription' in built.provider, false, mode + ' 不得写 gatewaySubscription')
    assert.equal(built.meta.usesPlanToken, mode === 'app')
    assert.equal(built.meta.writesSubscriptionFields, false)
  }
  // 冻结：配置块不可被下游就地改写（防止"看起来写了订阅字段"）。
  assert.equal(Object.isFrozen(local.provider), true)
  assert.equal(Object.isFrozen(local.provider.gatewaySubscription), true)
  assert.equal(modeErrorOf(() => buildSubscriptionProviderConfig('auto')).code, 'subscription_mode_invalid')
})

test('真实入口：bin/mg-desktop.mjs configure 四种模式写出的 gateway.json 与判定一致', { timeout: 60000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mg-v2-real3-configure-'))
  const modelsPath = join(root, 'models_cache.json')
  // Codex 0.167 的模型缓存 serde 必填字段（与 scripts/test/offline/agg-v2-compaction-protocol 同形）。
  await writeFile(modelsPath, JSON.stringify({
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
    }],
  }), 'utf8')
  const home = join(root, 'home')
  const codex = join(home, '.codex')
  await mkdir(codex, { recursive: true })
  await writeFile(join(codex, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: token(), account_id: 'acct-canary' } }), 'utf8')
  t.after(async () => { await rm(root, { recursive: true, force: true }) })

  async function configureWith(mode, extraEnv = {}) {
    const state = join(root, 'state-' + mode)
    const env = {
      ...process.env,
      HOME: home,
      CODEX_HOME: codex,
      MG_DESKTOP_STATE: state,
      MG_DESKTOP_MODELS: modelsPath,
      MG_DESKTOP_PORT: '18877',
      ...(mode === 'auto' ? {} : { MG_DESKTOP_SUBSCRIPTION_MODE: mode }),
      ...extraEnv,
    }
    if (mode === 'auto') delete env.MG_DESKTOP_SUBSCRIPTION_MODE
    const { stdout } = await execFileAsync(process.execPath, [join(ROOT, 'bin/mg-desktop.mjs'), 'configure'], { env, timeout: 30000 })
    const printed = JSON.parse(stdout.trim())
    const config = JSON.parse(await readFile(join(state, 'gateway', 'gateway.json'), 'utf8'))
    const desktopToml = await readFile(join(state, 'codex', 'config.toml'), 'utf8')
    return { printed, config, desktopToml }
  }

  // auto + 本机登录 → local：三个订阅字段齐全。
  const auto = await configureWith('auto')
  assert.equal(auto.printed.subscriptionMode, 'local')
  assert.equal(auto.printed.subscriptionReason, 'auto_local_login')
  const autoProvider = auto.config.providers['chatgpt-plan']
  assert.equal(autoProvider.baseUrl, 'https://chatgpt.com')
  assert.equal(autoProvider.responsesPath, '/backend-api/codex/responses')
  assert.deepEqual(autoProvider.gatewaySubscription, { enabled: true })
  assert.equal(auto.config.providers.opencodego.baseUrl, 'https://opencode.ai/inference/go')
  assert.equal(JSON.stringify(auto.config).includes(CANARY), false, '配置不得含 token')
  assert.equal(auto.desktopToml.includes('gpt-6-luna'), true)

  // 显式 app：api.openai.com 且不写订阅字段。
  const app = await configureWith('app')
  assert.equal(app.printed.subscriptionMode, 'app')
  const appProvider = app.config.providers['chatgpt-plan']
  assert.equal(appProvider.baseUrl, 'https://api.openai.com')
  assert.equal('responsesPath' in appProvider, false)
  assert.equal('gatewaySubscription' in appProvider, false)

  // 显式 off：同样不写订阅字段（运行时回到"需网关自有 key"）。
  const off = await configureWith('off')
  assert.equal(off.printed.subscriptionMode, 'off')
  const offProvider = off.config.providers['chatgpt-plan']
  assert.equal(offProvider.baseUrl, 'https://api.openai.com')
  assert.equal('responsesPath' in offProvider, false)
  assert.equal('gatewaySubscription' in offProvider, false)

  // 显式 local + 无本机登录 → fail-closed：非零退出且不写任何配置。
  const noLoginHome = join(root, 'home-nologin')
  await mkdir(join(noLoginHome, '.codex'), { recursive: true })
  const state = join(root, 'state-local-missing')
  let failure = null
  try {
    await execFileAsync(process.execPath, [join(ROOT, 'bin/mg-desktop.mjs'), 'configure'], {
      env: {
        ...process.env, HOME: noLoginHome, CODEX_HOME: join(noLoginHome, '.codex'),
        MG_DESKTOP_STATE: state, MG_DESKTOP_MODELS: modelsPath, MG_DESKTOP_SUBSCRIPTION_MODE: 'local',
      },
      timeout: 30000,
    })
  } catch (error) { failure = error }
  assert.ok(failure, 'local 模式无登录必须非零退出')
  assert.match(String(failure.stderr || ''), /subscription_login_missing|local 模式要求本机 Codex 登录/)
  await assert.rejects(readFile(join(state, 'gateway', 'gateway.json'), 'utf8'), 'fail-closed 时不得写出配置')
})
