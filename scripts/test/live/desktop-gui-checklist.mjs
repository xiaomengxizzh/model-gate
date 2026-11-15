#!/usr/bin/env node
// 只读检查器：原版 Codex Desktop 隔离验收实例的状态与证据自检。
// 不启动/停止任何进程、不写文件、不访问网络（仅可选 loopback /healthz）。
//
// 用法：
//   node scripts/test/live/desktop-gui-checklist.mjs \
//     --state /tmp/mg-desktop-gui-accept [--port 18873] [--expect-daily-sha <sha256>] [--json]
//
// 退出码：0 = 无 FAIL；1 = 至少一项 FAIL；2 = 参数错误。
import { readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

const DAILY_STATE = join(homedir(), '.local/state/modelgate-desktop')
const DAILY_CODEX = join(homedir(), '.codex')
const EXPECTED_SLUGS = ['gpt-6-luna', 'mg-opencodego-deepseek-v4-1-flash']

function parseArgs (argv) {
  const out = { json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') out.json = true
    else if (a === '--state') out.state = argv[++i]
    else if (a === '--port') out.port = Number(argv[++i])
    else if (a === '--expect-daily-sha') out.expectDailySha = String(argv[++i] || '').toLowerCase()
    else if (a === '-h' || a === '--help') { console.log('usage: --state <dir> [--port N] [--expect-daily-sha HASH] [--json]'); process.exit(0) }
    else { console.error('unknown arg: ' + a); process.exit(2) }
  }
  out.state = String(out.state || process.env.MG_DESKTOP_STATE || '').trim()
  if (!out.state) { console.error('missing --state (or MG_DESKTOP_STATE)'); process.exit(2) }
  if (!isAbsolute(out.state)) { console.error('--state must be an absolute path'); process.exit(2) }
  if (out.port !== undefined && (!Number.isInteger(out.port) || out.port < 1024 || out.port > 65535)) {
    console.error('--port must be an integer in 1024..65535'); process.exit(2)
  }
  return out
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const results = []
const push = (name, status, detail) => results.push({ name, status, detail })

function readText (path) {
  return readFile(path, 'utf8')
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  const state = resolve(args.state)

  // 1) 隔离性：状态目录绝不能是日常目录，也不能包含 ~/.codex 作为 CODEX_HOME。
  const underDailyState = state === DAILY_STATE || state.startsWith(DAILY_STATE + '/')
  const underDailyCodex = state === DAILY_CODEX || state.startsWith(DAILY_CODEX + '/')
  if (underDailyState || underDailyCodex) {
    push('state_isolation', 'FAIL', '状态目录指向日常目录：' + state)
  } else {
    try { await stat(state); push('state_isolation', 'PASS', state) } catch { push('state_isolation', 'FAIL', '状态目录不存在：' + state) }
  }

  // 2) 生成配置：modelgate provider + 官方父模型 + 目录路径在隔离目录内。
  const configPath = join(state, 'codex/config.toml')
  let configText = ''
  try { configText = await readText(configPath) } catch { push('codex_config', 'FAIL', '缺少 ' + configPath) }
  if (configText) {
    const fields = {}
    for (const line of configText.split('\n')) {
      const m = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line.trim())
      if (m) fields[m[1]] = m[2].trim()
    }
    const ok = fields.model_provider === '"modelgate"' && fields.model === '"gpt-6-luna"' && typeof fields.model_catalog_json === 'string'
    push('codex_config', ok ? 'PASS' : 'FAIL',
      'model_provider=' + (fields.model_provider || 'missing') + ' model=' + (fields.model || 'missing') + ' catalog=' + (fields.model_catalog_json || 'missing'))
    if (fields.model_catalog_json) {
      const catalog = fields.model_catalog_json.replace(/^"|"$/g, '')
      push('catalog_in_isolated_state', catalog.startsWith(state + '/') ? 'PASS' : 'FAIL', catalog)
    }
  }

  // 3) 目录同时含官方模型与 Go 单模型（slug 口径）。
  const modelsPath = join(state, 'codex/models.json')
  try {
    const catalog = JSON.parse(await readText(modelsPath))
    const slugs = (catalog.models || []).map((m) => m && m.slug).filter(Boolean)
    const missing = EXPECTED_SLUGS.filter((s) => !slugs.includes(s))
    push('catalog_models', missing.length ? 'FAIL' : 'PASS', missing.length ? '缺少 ' + missing.join(',') : 'slugs=' + slugs.join(','))
  } catch (e) {
    push('catalog_models', 'FAIL', '无法读取 models.json：' + (e && e.message))
  }

  // 4) 网关配置：端口一致、存在官方订阅 provider 与 Go provider。
  try {
    const gw = JSON.parse(await readText(join(state, 'gateway/gateway.json')))
    const portOk = args.port === undefined || Number(gw.server && gw.server.port) === args.port
    const providers = Object.entries(gw.providers || {})
    const official = providers.find(([, p]) => p && p.gatewaySubscription && p.gatewaySubscription.enabled === true)
    const go = providers.find(([, p]) => p && /opencode/i.test(String(p.baseUrl || '')))
    push('gateway_config', portOk && official && go ? 'PASS' : 'FAIL',
      'port=' + (gw.server && gw.server.port) + ' officialProvider=' + (official ? official[0] : 'missing') + ' goProvider=' + (go ? go[0] : 'missing'))
  } catch (e) {
    push('gateway_config', 'FAIL', '无法读取 gateway.json：' + (e && e.message))
  }

  // 5) 日常配置未被改写（必须显式给基线；否则只报告实际哈希，不判通过）。
  try {
    const daily = sha256(await readFile(join(DAILY_CODEX, 'config.toml')))
    if (args.expectDailySha) {
      push('daily_config_unchanged', daily === args.expectDailySha ? 'PASS' : 'FAIL', 'sha256=' + daily)
    } else {
      push('daily_config_unchanged', 'SKIP', '未提供 --expect-daily-sha；实际 sha256=' + daily)
    }
  } catch (e) {
    push('daily_config_unchanged', 'SKIP', '无法读取 ~/.codex/config.toml：' + (e && e.message))
  }

  // 6) 网关健康 + 请求回执（网关未运行则 SKIP，不判失败）。
  if (args.port === undefined) {
    push('gateway_health', 'SKIP', '未提供 --port')
  } else {
    try {
      const res = await fetch('http://127.0.0.1:' + args.port + '/healthz', { signal: AbortSignal.timeout(1500) })
      push('gateway_health', res.ok ? 'PASS' : 'FAIL', 'HTTP ' + res.status)
      const stats = JSON.parse(await readText(join(state, 'gateway/stats.json')))
      const byModel = Object.keys(stats.byModel || {})
      push('gateway_requests', byModel.length ? 'PASS' : 'SKIP', 'byModel=' + (byModel.join(',') || '(none)'))
    } catch {
      push('gateway_health', 'SKIP', '网关未运行（连接失败）；如需回执先 launch')
    }
  }

  const failed = results.filter((r) => r.status === 'FAIL')
  if (args.json) {
    console.log(JSON.stringify({ state, port: args.port === undefined ? null : args.port, results, ok: failed.length === 0 }, null, 2))
  } else {
    for (const r of results) console.log(r.status.padEnd(4) + ' ' + r.name + ' — ' + r.detail)
    console.log('---')
    console.log(failed.length === 0 ? 'OK: 无 FAIL（SKIP 项需人工确认）' : 'FAIL: ' + failed.length + ' 项')
  }
  process.exitCode = failed.length === 0 ? 0 : 1
}

main().catch((error) => { console.error('checklist error: ' + (error && error.stack ? error.stack : error)); process.exit(2) })
