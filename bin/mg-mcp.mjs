#!/usr/bin/env node
// G3：ModelGate 本地 MCP 委派服务（stdio，JSON-RPC 2.0 换行分隔）。
//
// 用途：让用户自己的 Codex CLI/Desktop（GPT 父模型直连官方服务）通过本机 stdio MCP 工具
// 把子任务委派给 OpenCode Go（deepseek-v4.1-flash）。这是**工具驱动的外部 worker 委派**，
// 不是 Codex 原生 `spawn_agent` 跨供应商子线程，也不会把 ChatGPT 订阅包装成通用 API。
//
// 边界：
//   · 只读网关自己的配置（config/gateway.local.json + keys.local.json 或环境变量）取 OpenCode Go 凭据；
//     绝不读取 Codex 的 auth.json / CODEX_HOME。
//   · stdout 只输出 JSON-RPC 响应；日志一律走 stderr。
//   · 任务状态持久化在 MG_MCP_STATE_DIR（默认 <configDir>/mcp）。
//
// 用法：node bin/mg-mcp.mjs [--doctor]
import { createInterface } from 'node:readline'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadConfig } from '../src/router.js'
import { validate as validateGo } from '../src/providers/opencode-go.js'
import { createTaskStore } from '../src/mcp/delegation-store.js'
import { createDelegationServer } from '../src/mcp/delegation-server.js'
import { createWorkspaceTools, DEFAULT_TOOLS } from '../src/mcp/delegation-tools.js'
import { MCP_CONTRACT, SERVER_NAME, SERVER_VERSION } from '../src/mcp/delegation-contract.js'

const stderrLog = {
  info: (...parts) => process.stderr.write('[mg-mcp] ' + parts.join(' ') + '\n'),
  warn: (...parts) => process.stderr.write('[mg-mcp][warn] ' + parts.join(' ') + '\n'),
  error: (...parts) => process.stderr.write('[mg-mcp][error] ' + parts.join(' ') + '\n'),
}

function envStr(name, dflt) {
  const v = process.env[name]
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : dflt
}
function envInt(name, dflt) {
  const n = Number(envStr(name, ''))
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : dflt
}

export function resolveRuntime() {
  const cfg = loadConfig()
  const providerId = envStr('MG_MCP_PROVIDER', 'opencodego')
  const model = envStr('MG_MCP_MODEL', 'deepseek-v4.1-flash')
  const workspaceRoot = resolve(envStr('MG_MCP_WORKSPACE', process.cwd()))
  const configDir = (cfg._paths && cfg._paths.dir) || join(process.cwd(), 'config')
  const stateDir = resolve(envStr('MG_MCP_STATE_DIR', join(configDir, 'mcp')))
  const def = (cfg.providers || {})[providerId]
  if (!def) {
    return { ok: false, code: 'provider_not_configured', message: 'provider 未配置：' + providerId }
  }
  const v = validateGo(def, { cfg, model, allowLoopback: true })
  if (!v.ok) return { ok: false, code: v.code, message: v.message }
  const toolsEnv = envStr('MG_MCP_TOOLS', '')
  let enabled = DEFAULT_TOOLS.slice()
  if (toolsEnv === 'none') enabled = []
  else if (toolsEnv) enabled = toolsEnv.split(',').map((s) => s.trim()).filter(Boolean)
  let workspaceTools = null
  if (enabled.length) {
    try { workspaceTools = createWorkspaceTools({ root: workspaceRoot, enabled }) } catch (error) {
      return { ok: false, code: 'workspace_invalid', message: String(error && error.message) }
    }
  }
  const taskDir = join(stateDir, 'tasks')
  mkdirSync(taskDir, { recursive: true, mode: 0o700 })
  const store = createTaskStore({ dir: taskDir })
  const reconciled = store.reconcile()
  const server = createDelegationServer({
    cfg,
    store,
    providerId,
    model,
    workspaceRoot,
    workspaceTools,
    maxConcurrent: envInt('MG_MCP_MAX_CONCURRENT', 2),
    maxSteps: envInt('MG_MCP_MAX_STEPS', 0) || undefined,
    reasoningEffort: envStr('MG_MCP_REASONING', ''),
    principal: envStr('MG_MCP_PRINCIPAL', 'local-mcp'),
    log: stderrLog,
  })
  return {
    ok: true,
    cfg,
    server,
    store,
    stateDir,
    providerId,
    model,
    workspaceRoot,
    workspaceTools: enabled,
    warnings: v.warnings || [],
    reconciled,
  }
}

async function main() {
  const runtime = resolveRuntime()
  if (!runtime.ok) {
    process.stderr.write('[mg-mcp][error] 启动失败：' + runtime.code + ' ' + runtime.message + '\n')
    process.exitCode = 2
    return
  }
  const doctor = {
    contract: MCP_CONTRACT,
    server: { name: SERVER_NAME, version: SERVER_VERSION },
    provider: runtime.providerId,
    model: runtime.model,
    workspaceRoot: runtime.workspaceRoot,
    workspaceTools: runtime.workspaceTools,
    stateDir: runtime.stateDir,
    warnings: runtime.warnings,
    reconciled: runtime.reconciled,
    stats: runtime.store.stats(),
  }
  if (process.argv.includes('--doctor')) {
    process.stdout.write(JSON.stringify(doctor, null, 2) + '\n')
    return
  }
  stderrLog.info('ready', 'provider=' + runtime.providerId, 'model=' + runtime.model, 'tasks=' + runtime.store.stats().tasks)
  if (runtime.reconciled.length) stderrLog.warn('启动对账：' + runtime.reconciled.length + ' 个在途回合被标记 UNKNOWN（不重发）')

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  let closing = false
  const close = async () => {
    if (closing) return
    closing = true
    try { rl.close() } catch {}
    try { await runtime.server.shutdown() } catch {}
    process.exitCode = 0
  }
  process.on('SIGINT', () => { close() })
  process.on('SIGTERM', () => { close() })

  for await (const line of rl) {
    const text = line.trim()
    if (text === '') continue
    let msg
    try { msg = JSON.parse(text) } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n')
      continue
    }
    let response
    try {
      response = await runtime.server.handle(msg)
    } catch (error) {
      stderrLog.error('handler threw', String((error && error.message) || error))
      response = { jsonrpc: '2.0', id: msg && msg.id !== undefined ? msg.id : null, error: { code: -32603, message: 'Internal error' } }
    }
    if (response) process.stdout.write(JSON.stringify(response) + '\n')
  }
}

main().catch((error) => {
  stderrLog.error('fatal', String((error && error.stack) || error))
  process.exitCode = 1
})
