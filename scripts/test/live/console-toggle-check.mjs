#!/usr/bin/env node
// 只读复核：ModelGate 隔离实例的 R001/R007 控制台启停结果。
// 不启动进程、不写文件；仅可选访问 loopback /healthz 做交叉验证。
//
// 用法：
//   node scripts/test/live/console-toggle-check.mjs \
//     --config-dir /tmp/mg-r001-state --codex-home /tmp/mg-r001-codex \
//     [--expect-mode official|aggregated] [--expect-config-sha <sha256>] \
//     [--port 18881 --admin-token <token>] [--json]
//
// 退出码：0 = 无 FAIL；1 = 至少一项 FAIL；2 = 参数错误。
import { readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

const DAILY = {
  codex: join(homedir(), '.codex'),
  desktopState: join(homedir(), '.local/state/modelgate-desktop'),
  workspaceConfig: join(process.cwd(), 'config'),
}
const OWNED_TOP = ['model_provider', 'openai_base_url', 'model', 'model_catalog_json']
const EXPECTED_SLUGS = ['gpt-6-luna', 'mg-opencodego-deepseek-v4-1-flash']

function parseArgs (argv) {
  const out = { json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') out.json = true
    else if (a === '--config-dir') out.configDir = argv[++i]
    else if (a === '--codex-home') out.codexHome = argv[++i]
    else if (a === '--expect-mode') out.expectMode = String(argv[++i] || '')
    else if (a === '--expect-config-sha') out.expectConfigSha = String(argv[++i] || '').toLowerCase()
    else if (a === '--port') out.port = Number(argv[++i])
    else if (a === '--admin-token') out.adminToken = String(argv[++i] || '')
    else if (a === '-h' || a === '--help') { console.log('usage: --config-dir <dir> --codex-home <dir> [--expect-mode official|aggregated] [--expect-config-sha HASH] [--port N --admin-token TOKEN] [--json]'); process.exit(0) }
    else { console.error('unknown arg: ' + a); process.exit(2) }
  }
  out.configDir = String(out.configDir || process.env.MG_CONFIG_DIR || '').trim()
  out.codexHome = String(out.codexHome || process.env.CODEX_HOME || '').trim()
  if (!out.configDir || !out.codexHome) { console.error('missing --config-dir / --codex-home'); process.exit(2) }
  if (!isAbsolute(out.configDir) || !isAbsolute(out.codexHome)) { console.error('paths must be absolute'); process.exit(2) }
  if (out.expectMode && !['official', 'aggregated'].includes(out.expectMode)) { console.error('--expect-mode must be official|aggregated'); process.exit(2) }
  if (out.port !== undefined && (!Number.isInteger(out.port) || out.port < 1024 || out.port > 65535)) { console.error('invalid --port'); process.exit(2) }
  return out
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const results = []
const push = (name, status, detail) => results.push({ name, status, detail })
const inside = (p, root) => p === root || p.startsWith(root + '/')

async function readJson (path) { return JSON.parse(await readFile(path, 'utf8')) }

function modeFromConfig (text) {
  const fields = {}
  for (const line of String(text || '').split('\n')) {
    const m = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line.trim())
    if (m) fields[m[1]] = m[2].trim()
  }
  const present = OWNED_TOP.filter((k) => Object.prototype.hasOwnProperty.call(fields, k))
  const redirect = present.includes('model_provider') && present.includes('openai_base_url')
  return { mode: redirect ? 'aggregated' : 'official', fields, present }
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  const configDir = resolve(args.configDir)
  const codexHome = resolve(args.codexHome)

  // 1) 隔离性（负向）：绝不能指向日常目录或仓库 config。
  const bad = [DAILY.codex, DAILY.desktopState, DAILY.workspaceConfig].find((root) => inside(configDir, root) || inside(codexHome, root))
  push('isolation_paths', bad ? 'FAIL' : 'PASS', bad ? '指向日常/仓库目录：' + bad : configDir + ' | ' + codexHome)
  // 允许隔离目录嵌套（例如 state/codex），但两者不能相同，也不能落到上面已拒绝的日常目录。
  push('paths_separated', configDir === codexHome ? 'FAIL' : 'PASS', configDir === codexHome ? 'configDir 与 codexHome 相同' : 'configDir 与 codexHome 不同（允许隔离内嵌套）')

  // 2) 网关配置与已发布目录 fixture（离线证据，不代表真实上游）。
  let gateway = null
  try { gateway = await readJson(join(configDir, 'gateway.json')) } catch (e) { push('gateway_config', 'FAIL', 'gateway.json 不可读：' + (e && e.message)) }
  if (gateway) push('gateway_config', gateway.server && gateway.server.port ? 'PASS' : 'FAIL', 'server.port=' + (gateway.server && gateway.server.port) + ' bind=' + (gateway.server && gateway.server.host))

  let catalog = null
  try {
    const state = await readJson(join(configDir, 'aggregation/catalog/local/state.json'))
    catalog = await readJson(join(configDir, 'aggregation/catalog/local/current.json'))
    const gen = Number(state.currentVersion)
    const modelGen = Number(state.current && state.current.version)
    const slugs = (catalog.models || []).map((m) => m && m.slug).filter(Boolean)
    const missing = EXPECTED_SLUGS.filter((s) => !slugs.includes(s))
    push('catalog_fixture', Number.isInteger(gen) && gen >= 1 && gen === modelGen && missing.length === 0
      ? 'PASS' : 'FAIL',
    'generation=' + gen + ' current=' + modelGen + ' slugs=' + slugs.join(','))
  } catch (e) {
    push('catalog_fixture', 'FAIL', '目录状态不可读：' + (e && e.message))
  }

  // 3) Codex 配置模式 + 期望哈希。
  const configPath = join(codexHome, 'config.toml')
  let observed = { mode: 'official', fields: {}, present: [] }
  let configSha = ''
  try {
    const text = await readFile(configPath, 'utf8')
    configSha = sha256(Buffer.from(text, 'utf8'))
    observed = modeFromConfig(text)
    push('codex_config_mode', 'PASS', 'mode=' + observed.mode + ' observedOwned=' + observed.present.join(','))
  } catch (e) {
    if (e && e.code === 'ENOENT') push('codex_config_mode', 'PASS', 'config.toml 不存在（空白用户/已撤销）→ official')
    else push('codex_config_mode', 'FAIL', 'config.toml 不可读：' + (e && e.message))
  }
  if (args.expectMode) push('expect_mode', observed.mode === args.expectMode ? 'PASS' : 'FAIL', 'expected=' + args.expectMode + ' actual=' + observed.mode)
  if (args.expectConfigSha) push('expect_config_sha', configSha === args.expectConfigSha ? 'PASS' : 'FAIL', 'expected=' + args.expectConfigSha + ' actual=' + (configSha || '(absent)'))

  // 4) ModelGate 桌面状态与配置模式一致性 + 备份哈希。
  try {
    const state = await readJson(join(codexHome, '.modelgate-desktop-state.json'))
    const consistent = observed.mode === 'aggregated' ? state.mode === 'aggregated' : state.mode !== 'aggregated'
    push('desktop_state_consistent', consistent ? 'PASS' : 'FAIL', 'state.mode=' + state.mode + ' fileMode=' + observed.mode)
    if (state.mode === 'aggregated' && state.before && state.before.exists) {
      try {
        const bak = await readFile(codexHome + '/config.toml.bak')
        push('backup_matches_before', sha256(bak) === state.before.sha256 ? 'PASS' : 'FAIL', 'backup sha256=' + sha256(bak).slice(0, 16))
      } catch (e) { push('backup_matches_before', 'FAIL', '备份缺失：' + (e && e.message)) }
    } else {
      push('backup_matches_before', 'SKIP', '无接入前备份（空白接入或已撤销）')
    }
  } catch (e) {
    push('desktop_state_consistent', observed.mode === 'official' ? 'PASS' : 'FAIL', '状态文件不可读：' + (e && e.message))
  }

  // 5) 可选：运行中网关交叉验证（离线文件口径 vs API 口径）。
  if (args.port === undefined) push('gateway_health', 'SKIP', '未提供 --port')
  else {
    try {
      const headers = args.adminToken ? { authorization: 'Bearer ' + args.adminToken } : {}
      const res = await fetch('http://127.0.0.1:' + args.port + '/api/aggregation/health', { headers, signal: AbortSignal.timeout(1500) })
      if (!res.ok) push('gateway_health', 'FAIL', 'HTTP ' + res.status)
      else {
        const body = await res.json()
        push('gateway_health', body.mode === observed.mode ? 'PASS' : 'FAIL', 'api.mode=' + body.mode + ' file.mode=' + observed.mode + ' reason=' + body.reason)
      }
    } catch { push('gateway_health', 'SKIP', '网关未运行（连接失败）') }
  }

  const failed = results.filter((r) => r.status === 'FAIL')
  if (args.json) console.log(JSON.stringify({ configDir, codexHome, results, ok: failed.length === 0 }, null, 2))
  else {
    for (const r of results) console.log(r.status.padEnd(4) + ' ' + r.name + ' — ' + r.detail)
    console.log('---')
    console.log(failed.length === 0 ? 'OK: 无 FAIL（SKIP 项需人工确认）' : 'FAIL: ' + failed.length + ' 项')
  }
  process.exitCode = failed.length === 0 ? 0 : 1
}

main().catch((error) => { console.error('checklist error: ' + (error && error.stack ? error.stack : error)); process.exit(2) })
