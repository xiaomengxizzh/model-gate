// 原版 Codex CLI / bundled app-server 的隔离启动器：只做进程、目录、配置与 JSONL 解析，不伪造任何
// Codex 线程或通知。所有路径来自 os.tmpdir()，用后清理；不读写用户 ~/.codex。
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const fixturesDir = fileURLToPath(new URL('.', import.meta.url))
export const catalogPath = join(fixturesDir, 'models.v2.json')

// 稳定入口（只用本机已安装二进制；不下载、不联网拉取）。
export const CLI_BIN = process.env.MG_CODEX_V2_CLI || '/home/xiaomengxizi/ai/harness/codex/cli/bin/codex'
export const APP_SERVER_BIN = process.env.MG_CODEX_V2_APP_SERVER || '/usr/lib/chatgpt/resources/codex'
export const FAKE_KEY = 'sk-offline-fixture-not-a-real-key'

export async function makeSandbox(prefix = 'mg-codex-v2-') {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  await mkdir(home, { recursive: true })
  await mkdir(workspace, { recursive: true })
  return { root, home, workspace, cleanup: async () => { await rm(root, { recursive: true, force: true }) } }
}

// 隔离 CODEX_HOME 的 config.toml：单 provider 指向 mock 上游；V2 显式开启。
export function configToml({ baseUrl, model = 'gpt-mock', extra = [], sandboxMode = 'read-only' }) {
  return [
    'model = "' + model + '"',
    'model_provider = "mgmock"',
    'approval_policy = "never"',
    'sandbox_mode = "' + sandboxMode + '"',
    'features.multi_agent_v2 = true',
    'suppress_unstable_features_warning = true',
    ...extra,
    '',
    '[model_providers.mgmock]',
    'name = "mgmock"',
    'base_url = "' + baseUrl + '/v1"',
    'wire_api = "responses"',
    'env_key = "MG_CODEX_V2_FAKE_KEY"',
    '',
  ].join('\n')
}

export async function writeHome(sandbox, opts) {
  await writeFile(join(sandbox.home, 'config.toml'), configToml(opts))
  return sandbox
}

// 启动原版 CLI 但不等待退出：调用方可以先观察 mock 侧是否已收到请求，再决定何时发信号。
// 返回的 result 与 runCli 的返回值同形（多一个 cancelled 标记）。
export function spawnCli({ args, home, workspace, env = {}, timeoutMs = 120000 }) {
  const child = spawn(CLI_BIN, args, {
    env: Object.assign({}, process.env, { CODEX_HOME: home, MG_CODEX_V2_FAKE_KEY: FAKE_KEY, NO_COLOR: '1', RUST_LOG: 'error' }, env),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (b) => { stdout += b })
  child.stderr.on('data', (b) => { stderr += b })
  let timedOut = false
  let cancelled = false
  const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL') } catch {} }, timeoutMs)
  const result = once(child, 'exit').then(([code, sig]) => {
    clearTimeout(timer)
    return { code, signal: sig, stdout, stderr, timedOut, cancelled, events: parseJsonl(stdout), child }
  })
  return { child, result, markCancelled: () => { cancelled = true } }
}

// 运行原版 CLI，返回 JSONL 事件、退出码、stderr 摘要（stderr 只保留尾部，可能含路径，不含凭据）。
export async function runCli({ args, home, workspace, env = {}, timeoutMs = 120000, cancelAfterMs }) {
  const { child, result, markCancelled } = spawnCli({ args, home, workspace, env, timeoutMs })
  let cancelTimer = null
  if (cancelAfterMs) cancelTimer = setTimeout(() => { markCancelled(); try { child.kill('SIGINT') } catch {} }, cancelAfterMs)
  const out = await result
  if (cancelTimer) clearTimeout(cancelTimer)
  return out
}

export function parseJsonl(text) {
  const out = []
  for (const line of String(text || '').split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try { out.push(JSON.parse(t)) } catch { /* 忽略非 JSON 行 */ }
  }
  return out
}

export function threadId(events) {
  const ev = events.find((e) => e.type === 'thread.started')
  return ev ? ev.thread_id : null
}

export function agentMessages(events) {
  return events.filter((e) => e.type === 'item.completed' && e.item && e.item.type === 'agent_message').map((e) => e.item.text || '')
}

export function collabItems(events) {
  return events.filter((e) => e.type === 'item.completed' && e.item && e.item.type === 'collab_tool_call').map((e) => e.item)
}

// 原生 rollout 是 Codex 自己写的（不是夹具伪造）；这里只读 session_meta/turn_context 做身份核对。
export async function readRollouts(home) {
  const base = join(home, 'sessions')
  const files = []
  async function walk(dir) {
    let entries = []
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) await walk(p)
      else if (e.name.endsWith('.jsonl')) files.push(p)
    }
  }
  await walk(base)
  const rollouts = []
  for (const file of files) {
    const raw = await readFile(file, 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    let meta = null
    let firstTurn = null
    for (const line of lines) {
      let o
      try { o = JSON.parse(line) } catch { continue }
      if (o.type === 'session_meta') meta = o.payload
      if (o.type === 'turn_context' && !firstTurn) firstTurn = o.payload
    }
    rollouts.push({ file, meta, firstTurn, lineCount: lines.length })
  }
  return rollouts
}

export const catalogPathPhaseB = join(fixturesDir, 'models.phaseb.v2.json')

// Phase B：Codex 只配一个 provider，base_url 指向隔离网关；两个模型都由网关按 alias 路由。
// 注意：不要用 --ignore-user-config（它会连 CODEX_HOME/config.toml 一起忽略），
// provider 用 -c 显式传入，避免落到 api.openai.com。
export function phaseBProviderArgs(gatewayBase) {
  return [
    '-c', 'model=codex-gpt',
    '-c', 'model_provider=mg',
    '-c', 'model_providers.mg={name="ModelGate",base_url="' + gatewayBase + '/v1",env_key="MG_CODEX_V2_FAKE_KEY",wire_api="responses"}',
    '-c', 'model_catalog_json=' + catalogPathPhaseB,
    '-c', 'features.multi_agent_v2=true',
  ]
}

export function phaseBExecArgs({ sandbox, gatewayBase, prompt, sandboxMode = 'read-only' }) {
  return ['exec', '--skip-git-repo-check', '-s', sandboxMode, '-C', sandbox.workspace, ...phaseBProviderArgs(gatewayBase), '--json', prompt]
}

export function phaseBResumeArgs({ gatewayBase, sid, prompt }) {
  return ['exec', 'resume', '--skip-git-repo-check', ...phaseBProviderArgs(gatewayBase), '--json', sid, prompt]
}

// 隔离网关配置：两个 provider 各指一个 mock；两个 codex 试点模型按 alias 固定上游。
export function phaseBGatewayConfig({ openaiBase, deepseekBase }) {
  return {
    defaults: {
      retry: { maxAttempts: 1 },
      timeout: { firstByteMs: 5000, idleMs: 5000 },
      proxyMode: 'direct',
      codex: { strictModelRouting: true },
    },
    providers: {
      'openai-mock': { baseUrl: openaiBase, api: 'responses', apiKeyEnv: 'MG_OPENAI_MOCK_KEY' },
      'deepseek-mock': { baseUrl: deepseekBase, api: 'responses', apiKeyEnv: 'MG_DEEPSEEK_MOCK_KEY' },
    },
    models: {
      'codex-gpt': {
        provider: 'openai-mock',
        api: 'responses',
        providerModels: { 'openai-mock': 'gpt-mock' },
        codex: { multiAgentVersion: 'v2', plaintextTools: true, history: { agentMessage: 'preserve', reasoning: 'preserve', compaction: 'reject' } },
      },
      'codex-deepseek': {
        provider: 'deepseek-mock',
        api: 'responses',
        providerModels: { 'deepseek-mock': 'deepseek-mock' },
        codex: { multiAgentVersion: 'v2', plaintextTools: true, history: { agentMessage: 'project', reasoning: 'drop', compaction: 'reject' } },
      },
    },
  }
}

// —— bundled app-server（组件验收）——
// JSON-RPC over stdio；只调用公开方法，不改 Codex 状态。
export async function startAppServer({ home, extraArgs = [], env = {}, timeoutMs = 60000 }) {
  const child = spawn(APP_SERVER_BIN, ['app-server', ...extraArgs], {
    env: Object.assign({}, process.env, { CODEX_HOME: home, MG_CODEX_V2_FAKE_KEY: FAKE_KEY, NO_COLOR: '1', RUST_LOG: 'error' }, env),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buffer = ''
  let stderr = ''
  const messages = []
  const waiters = new Map()
  child.stderr.on('data', (b) => { stderr += b })
  child.stdout.on('data', (b) => {
    buffer += b.toString('utf8')
    let idx
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (!line.startsWith('{')) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      messages.push(msg)
      if (msg.id !== undefined && waiters.has(msg.id)) {
        const w = waiters.get(msg.id)
        waiters.delete(msg.id)
        w.resolve(msg)
      }
    }
  })
  let seq = 0
  const request = (method, params = {}, timeout = timeoutMs) => {
    const id = ++seq
    const p = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(id); reject(new Error('app-server timeout on ' + method + '; stderr=' + stderr.slice(-400))) }, timeout)
      waiters.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v) } })
    })
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    return p
  }
  const stop = async () => {
    try { child.kill('SIGKILL') } catch {}
    await once(child, 'exit').catch(() => {})
  }
  return { child, messages, request, stop, stderr: () => stderr }
}