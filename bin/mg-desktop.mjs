#!/usr/bin/env node
// Local Desktop instance for an independently authorized ChatGPT plan and OpenCode Go.
import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { buildCatalog, asNativeDelegationParent } from '../src/codex/catalog.js'
// MG-FIX-P1-05：启动器与控制台的原生子代理配置共用同一 canonical 字节，
// 避免"启动器写 low、控制台写 medium"导致 409 三方差异（两者都是 Codex 原生配置）。
import { MANAGED_AGENT_DESCRIPTION, buildManagedAgentConfig } from '../src/codex/config.js'
import { signIn, createPlanCredential } from '../src/subscription/official.js'
import {
  resolveSubscriptionMode, buildSubscriptionProviderConfig, refreshLocalSubscriptionCredential,
} from '../src/codex/local-subscription.js'

const appState = resolve(process.env.MG_DESKTOP_STATE || join(homedir(), '.local/state/modelgate-desktop'))
const codexHome = join(appState, 'codex')
const guiHome = join(appState, 'desktop')
const gatewayHome = join(appState, 'gateway')
const port = Number(process.env.MG_DESKTOP_PORT || 18787)
// 父模型可配置：默认仍为 luna（字节兼容既有行为），MG_PARENT_MODEL 可显式设为第三方 slug
// （如 mg-opencodego-deepseek-v4-1-flash），用于 deepseek→deepseek 父子验证。
const parentModel = process.env.MG_PARENT_MODEL || 'gpt-6-luna'
const childModel = 'deepseek-v4.1-flash'
const parentProvider = 'chatgpt-plan'

// 订阅模式（所有者策略 A）：auto（默认，按本机 Codex 登录自动选择 local/app）/local/app/off。
// 判定与配置块都由 src/codex/local-subscription.js 提供（单一真源，可离线断言）。
const REFRESH_INTERVAL_MS = 5 * 60 * 1000
const refreshState = { timer: null, lastReason: null, attempts: 0, refreshed: 0 }

// 仅在 local 模式、且由本启动器显式触发时刷新过期 token；失败只打印稳定 reason，
// 绝不打印/记录 token，也绝不因此改走 app（fail-closed 留在订阅域）。
async function refreshSubscriptionCredentialOnce() {
  refreshState.attempts += 1
  try {
    const result = await refreshLocalSubscriptionCredential({ env: process.env, fetchImpl: globalThis.fetch })
    refreshState.lastReason = result.reason
    if (result.refreshed) refreshState.refreshed += 1
    return result
  } catch (error) {
    refreshState.lastReason = (error && error.reason) || (error && error.code) || 'refresh_failed'
    console.error('subscription refresh skipped: ' + refreshState.lastReason)
    return null
  }
}

function scheduleRefresh(mode) {
  if (mode !== 'local') return
  refreshState.timer = setInterval(() => { refreshSubscriptionCredentialOnce().catch(() => {}) }, REFRESH_INTERVAL_MS)
  if (typeof refreshState.timer.unref === 'function') refreshState.timer.unref()
}

async function configure() {
  // local 无本机登录 / 非法模式 → typed SubscriptionModeError（fail-closed，不写配置）。
  const subscription = resolveSubscriptionMode({ env: process.env })
  const parentProviderConfig = buildSubscriptionProviderConfig(subscription.mode).provider
  const cachedPath = process.env.MG_DESKTOP_MODELS || join(homedir(), '.codex/models_cache.json')
  const models = JSON.parse(await readFile(cachedPath, 'utf8')).models
  const original = models.find((item) => item.slug === parentModel)
  if (!original) throw new Error('The Codex model catalog does not contain ' + parentModel)
  // MG-NATIVE-DELEGATION：与聚合目录发布共用同一“原生派单父模型”投影，避免两处漂移。
  const parent = asNativeDelegationParent(original)
  for (const dir of [appState, codexHome, guiHome, gatewayHome]) await mkdir(dir, { recursive: true, mode: 0o700 })
  const basePath = join(gatewayHome, 'official-models.json')
  await writeFile(basePath, JSON.stringify({ models: [parent] }), { mode: 0o600 })

  const config = {
    server: { host: '127.0.0.1', port, logFile: join(gatewayHome, 'gateway.log') },
    defaults: {
      codexCatalogBasePath: basePath, codexOfficialProvider: parentProvider,
      proxy: process.env.HTTPS_PROXY || process.env.https_proxy || '',
      timeout: { overallMs: 120000, firstByteMs: 60000, idleMs: 60000 },
    },
    providers: {
      // 官方父模型的授权来源由 MG_DESKTOP_SUBSCRIPTION_MODE 决定（默认 auto）：
      //  local —— 复用本机 Codex 登录（chatgpt.com + /backend-api/codex + gatewaySubscription），
      //           凭据由网关自己只读读取，绝不透传客户端凭据；token 过期由本启动器在 CAS 保护下刷新。
      //  app   —— 应用自有 OAuth（grant.json，`mg-desktop sign-in`）+ api.openai.com plan token。
      //  off   —— 不写订阅字段：官方请求回到「需网关自有 key」，由网关返回 typed 403，绝不换路径。
      [parentProvider]: parentProviderConfig,
      opencodego: { baseUrl: 'https://opencode.ai/inference/go', pathPrefix: '/openai', api: 'openai', apiKeyEnv: 'OPENCODE_API_KEY' },
    },
    models: {
      [childModel]: {
        provider: 'opencodego', api: 'responses', maxContext: 128000,
        reasoning: 'low', effortOptions: ['low', 'high'],
        codex: {
          plaintextTools: true, history: { agentMessage: 'project' },
          capabilities: { shellType: 'unified_exec', applyPatchToolType: 'freeform' },
          evidence: {
            shellType: { source: 'ModelGate Codex native loopback and Go tool receipt', observedAt: '2026-11-14' },
            applyPatchToolType: { source: 'ModelGate Codex catalog fixture', observedAt: '2026-11-14' },
          },
        },
      },
    },
  }
  const { catalog, meta } = buildCatalog({ base: { models: [parent] }, config })
  const alias = Object.keys(meta.bindings)[0]
  if (!alias) throw new Error('The Go alias could not be generated')
  const catalogPath = join(codexHome, 'models.json')
  await writeFile(catalogPath, JSON.stringify(catalog), { mode: 0o600 })
  const configPath = join(gatewayHome, 'gateway.json')
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 })
  // MG-P0-01 真机取证：Codex 0.167 原生子代理按目标模型 effortOptions 校验
  // model_reasoning_effort；Go DeepSeek 只声明 low/high，默认 'medium' 会导致真实 spawn 报
  // "Reasoning effort `medium` is not supported ... Supported: low, high"。这里显式取 'high'
  // （与上面子模型 effortOptions 一致），不动全局默认以免影响既有用户的托管配置字节兼容。
  const managedAgent = buildManagedAgentConfig({ model: alias, reasoningEffort: 'high' })
  const desktopConfig = `model_provider = "modelgate"
model = "${parentModel}"
model_catalog_json = ${JSON.stringify(catalogPath)}
web_search = "disabled"

[model_providers.modelgate]
name = "ModelGate"
base_url = "http://127.0.0.1:${port}/v1"
env_key = "MODELGATE_CLIENT_KEY"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false

[features]
multi_agent = true
multi_agent_v2 = false
code_mode = false

[agents.go_deepseek]
description = ${JSON.stringify(MANAGED_AGENT_DESCRIPTION)}
config_file = ${JSON.stringify(managedAgent.child.fileName)}
`
  await writeFile(join(codexHome, managedAgent.child.fileName), managedAgent.child.text, { mode: 0o600 })
  await writeFile(join(codexHome, 'config.toml'), desktopConfig, { mode: 0o600 })
  return {
    alias,
    subscriptionMode: subscription.mode,
    subscriptionReason: subscription.reason,
    subscription,
  }
}

async function main() {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid ModelGate Desktop port')
  const action = process.argv[2]
  if (!['sign-in', 'configure', 'launch'].includes(action)) throw new Error('Usage: node bin/mg-desktop.mjs sign-in|configure|launch')
  if (action === 'sign-in') {
    await signIn(appState, (url) => promisify(execFile)('xdg-open', [url]).catch(() => { throw new Error('Could not open the system browser') }))
    console.log('ChatGPT plan connected.')
    return
  }
  const { alias, subscription } = await configure()
  if (action === 'configure') {
    console.log(JSON.stringify({
      codexHome, guiHome, gatewayHome, port, parentModel, childModel, alias,
      subscriptionMode: subscription.mode,
      subscriptionReason: subscription.reason,
      subscriptionLocalAuthAvailable: subscription.localAuthAvailable,
      subscriptionLocalAuthReason: subscription.localAuthReason,
    }))
    return
  }
  if (!process.env.OPENCODE_API_KEY) throw new Error('Missing OpenCode Go key in OPENCODE_API_KEY')
  // 父模型凭据按模式准备：app 用应用授权（未 sign-in 明确报错）；local 由网关只读本机登录，
  // 启动器只负责在 CAS 保护下刷新过期 token；off 不注入任何凭据（官方请求由网关 typed 403）。
  let accessToken = null
  if (subscription.mode === 'app') {
    try {
      await readFile(join(appState, 'grant.json'), 'utf8')
    } catch {
      throw new Error('MG_DESKTOP_SUBSCRIPTION_MODE=app 需要应用自有 OAuth 授权：请先运行 node bin/mg-desktop.mjs sign-in，或改用 MG_DESKTOP_SUBSCRIPTION_MODE=off（需网关自有 key）。')
    }
    accessToken = createPlanCredential(appState)
  } else if (subscription.mode === 'local') {
    // 过期则刷新（失败只打印 reason，仍留在订阅域；网关随后会返回 typed 401，不静默换路径）。
    await refreshSubscriptionCredentialOnce()
    scheduleRefresh(subscription.mode)
  }
  process.env.MG_CONFIG_DIR = gatewayHome
  process.env.MG_CLIENT_KEY = randomBytes(32).toString('hex')
  process.env.MG_ADMIN_TOKEN = randomBytes(32).toString('hex')
  const { start } = await import('../src/index.js')
  const gw = await start({
    chatgptPlan: subscription.mode === 'app' ? { providerId: parentProvider, accessToken } : undefined,
    rejectBindFailure: true,
  })
  console.log('ModelGate Desktop gateway ready at http://127.0.0.1:' + port + ' (' + parentModel + ' / ' + alias + ', subscription=' + subscription.mode + ')')
  const desktopEnv = { ...process.env, CODEX_HOME: codexHome, MODELGATE_CLIENT_KEY: process.env.MG_CLIENT_KEY }
  for (const name of ['OPENCODE_API_KEY', 'MG_CLIENT_KEY', 'MG_ADMIN_TOKEN', 'MG_CONFIG_DIR', 'OPENAI_API_KEY',
    'OPENAI_BASE_URL', 'CODEX_API_KEY', 'SIWC_ACCESS_TOKEN', 'CODEX_THREAD_ID']) delete desktopEnv[name]
  const desktop = spawn(process.env.MG_DESKTOP_EXECUTABLE || 'chatgpt',
    ['--user-data-dir=' + guiHome], { env: desktopEnv, stdio: 'ignore' })
  const stopDesktop = () => desktop.kill('SIGTERM')
  process.once('SIGINT', stopDesktop)
  process.once('SIGTERM', stopDesktop)
  try {
    await new Promise((resolve, reject) => {
      desktop.once('error', reject)
      desktop.once('exit', (status) => status === 0 ? resolve() : reject(new Error('Codex Desktop exited with status ' + status)))
    })
  } finally {
    process.off('SIGINT', stopDesktop)
    process.off('SIGTERM', stopDesktop)
    if (refreshState.timer) clearInterval(refreshState.timer)
    await gw.close()
  }
}

main().catch((error) => {
  const typed = error && error.deny === true && typeof error.code === 'string'
  const message = typed
    ? '[' + error.code + '] ' + error.message
    : (error.code === 'ENOENT' ? 'Required local configuration or ChatGPT grant is missing. Run sign-in first.' : error.message)
  console.error(message)
  process.exitCode = 1
})
