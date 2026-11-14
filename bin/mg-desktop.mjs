#!/usr/bin/env node
// Local Desktop instance for an independently authorized ChatGPT plan and OpenCode Go.
import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { buildCatalog } from '../src/codex/catalog.js'
import { signIn, createPlanCredential } from '../src/subscription/official.js'

const appState = resolve(process.env.MG_DESKTOP_STATE || join(homedir(), '.local/state/modelgate-desktop'))
const codexHome = join(appState, 'codex')
const guiHome = join(appState, 'desktop')
const gatewayHome = join(appState, 'gateway')
const port = Number(process.env.MG_DESKTOP_PORT || 18787)
const parentModel = 'gpt-6-luna'
const childModel = 'deepseek-v4.1-flash'
const parentProvider = 'chatgpt-plan'

async function configure() {
  const cachedPath = process.env.MG_DESKTOP_MODELS || join(homedir(), '.codex/models_cache.json')
  const models = JSON.parse(await readFile(cachedPath, 'utf8')).models
  const original = models.find((item) => item.slug === parentModel)
  if (!original) throw new Error('The Codex model catalog does not contain ' + parentModel)
  const parent = { ...original, tool_mode: 'direct', multi_agent_version: 'v1', supports_search_tool: false, use_responses_lite: false }
  const instructions = original.base_instructions || original.model_messages?.instructions_template
  parent.base_instructions = instructions
  delete parent.model_messages
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
      [parentProvider]: { baseUrl: 'https://api.openai.com', codexIdentity: 'official' },
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
description = "Native Codex worker using OpenCode Go DeepSeek V4.1 Flash"
config_file = "go-deepseek.toml"
`
  await writeFile(join(codexHome, 'go-deepseek.toml'), `model = "${alias}"\nmodel_reasoning_effort = "low"\n`, { mode: 0o600 })
  await writeFile(join(codexHome, 'config.toml'), desktopConfig, { mode: 0o600 })
  return { alias }
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
  const { alias } = await configure()
  if (action === 'configure') {
    console.log(JSON.stringify({ codexHome, guiHome, gatewayHome, port, parentModel, childModel, alias }))
    return
  }
  if (!process.env.OPENCODE_API_KEY) throw new Error('Missing OpenCode Go key in OPENCODE_API_KEY')
  const accessToken = createPlanCredential(appState)
  process.env.MG_CONFIG_DIR = gatewayHome
  process.env.MG_CLIENT_KEY = randomBytes(32).toString('hex')
  process.env.MG_ADMIN_TOKEN = randomBytes(32).toString('hex')
  const { start } = await import('../src/index.js')
  const gw = await start({ chatgptPlan: { providerId: parentProvider, accessToken }, rejectBindFailure: true })
  console.log('ModelGate Desktop gateway ready at http://127.0.0.1:' + port + ' (' + parentModel + ' / ' + alias + ')')
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
    await gw.close()
  }
}

main().catch((error) => {
  const message = error.code === 'ENOENT' ? 'Required local configuration or ChatGPT grant is missing. Run sign-in first.' : error.message
  console.error(message)
  process.exitCode = 1
})
