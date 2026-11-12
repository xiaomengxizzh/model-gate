#!/usr/bin/env node
// N03：ModelGate 管理 CLI（零第三方依赖，纯检出可直接运行）。
//
// 设计约束：
//  * 默认只操作**本机 loopback** 实例；非 loopback 目标需显式 MG_CLI_ALLOW_REMOTE=1（输出里会标注）。
//  * 只读命令（doctor/provider/model/route/client）不联网；写命令（config apply/rollback）只用 HTTP，
//    且必须显式 --plan（planId）+ confirmToken + --yes（非 TTY 时），不做隐式重试。
//  * 不打印任何凭据：管理令牌只从环境变量读取（--admin-token-env 指定变量名），不进 argv/输出/日志。
//  * 不写全局文件、不读写 ~/.codex、不碰 auth.json；配置文件只在显式 --config/MG_CONFIG 时读取。
//  * 错误统一为 {ok:false, code, error, apiVersion, nextAction?}，退出码映射稳定（见 EXIT）。
//
// 用法：node bin/mg.mjs <doctor|provider|model|route|config|client> ... [--json]
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { loadConfig, createRouter } from '../src/router.js'
import { buildCatalog, stableStringify, catalogFingerprint } from '../src/codex/catalog.js'
import { catalogViewCompleteness } from '../src/codex/catalog-generation.js'
import { exportClientTemplate } from '../src/codex/config.js'
import { classifyTarget } from '../src/codex/identity.js'
import { CODEX_API_VERSION, CODEX_API_VERSIONS } from '../src/codex/api.js'
import { PROVIDER_ID as GO_PROVIDER_ID, validate as validateGo, entryOf as goEntryOf } from '../src/providers/opencode-go.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const CLI_CONTRACT = 'modelgate.cli/1'
const DEFAULT_API_VERSION = CODEX_API_VERSION
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
const EXIT = Object.freeze({ OK: 0, ERROR: 1, UNAUTHORIZED: 2, FORBIDDEN: 3, CONFLICT: 4, NOT_FOUND: 5 })

function pkgVersion() {
  try { return String(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version || 'unknown') } catch { return 'unknown' }
}
function sha256Hex(v) { return createHash('sha256').update(String(v)).digest('hex') }
function hostOfUrl(raw) {
  try { return new URL(String(raw)).hostname.toLowerCase().replace(/^\.$/, '') } catch { return null }
}

class CliError extends Error {
  constructor(code, message, opts = {}) {
    super(message)
    this.name = 'CliError'
    this.code = code
    this.exitCode = opts.exitCode != null ? opts.exitCode : EXIT.ERROR
    this.nextAction = opts.nextAction || null
    this.status = opts.status || null
    this.requestId = opts.requestId || null
  }
}

// —— 参数解析（只做确定性形状解析，不做隐式默认值猜测）——
const BOOL_FLAGS = new Set(['json', 'yes', 'help', 'version', 'allow-create', 'no-network'])
export function parseArgv(argv) {
  const flags = {}
  const positional = []
  const args = Array.isArray(argv) ? argv.slice() : []
  for (let i = 0; i < args.length; i++) {
    const token = String(args[i])
    if (token === '--') { positional.push(...args.slice(i + 1)); break }
    if (!token.startsWith('--')) { positional.push(token); continue }
    const body = token.slice(2)
    const eq = body.indexOf('=')
    if (eq > 0) {
      const key = body.slice(0, eq)
      flags[key] = body.slice(eq + 1)
      continue
    }
    if (BOOL_FLAGS.has(body)) { flags[body] = true; continue }
    const next = args[i + 1]
    if (next == null || String(next).startsWith('--')) { flags[body] = true; continue }
    flags[body] = String(next)
    i += 1
  }
  return { flags, positional }
}

function flagString(flags, name) {
  const v = flags[name]
  return v === undefined || v === true ? null : String(v)
}

// —— 配置读取（只在显式来源时读；绝不猜 HOME）——
function configSource(flags) {
  const configPath = flagString(flags, 'config') || (process.env.MG_CONFIG || '').trim() || null
  const configDir = flagString(flags, 'config-dir') || (process.env.MG_CONFIG_DIR || '').trim() || null
  return { configPath, configDir }
}
function loadGatewayConfig(flags, { required = true } = {}) {
  const src = configSource(flags)
  if (!src.configPath && !src.configDir) {
    if (!required) return { cfg: null, source: { configured: false } }
    throw new CliError('config_required', '没有配置文件来源：请显式传 --config <gateway.json> 或 --config-dir <dir>（或设置 MG_CONFIG/MG_CONFIG_DIR）', { nextAction: 'pass-explicit-config' })
  }
  const prevDir = process.env.MG_CONFIG_DIR
  try {
    if (src.configDir) process.env.MG_CONFIG_DIR = src.configDir
    const opts = src.configPath ? { configFile: src.configPath } : {}
    const cfg = loadConfig(opts)
    return { cfg, source: { configured: true, configPath: src.configPath ? true : false, configDir: !!src.configDir } }
  } catch (e) {
    throw new CliError('config_unreadable', '无法加载网关配置（' + (e && (e.code || e.message) ? (e.code || e.message) : 'unknown') + '）；未打印任何凭据或文件内容')
  } finally {
    if (src.configDir) process.env.MG_CONFIG_DIR = prevDir
  }
}

function keyPresence(cfg, id) {
  const def = (cfg.providers || {})[id] || {}
  if (cfg._keys && cfg._keys[id]) return 'store'
  if (def.apiKeyEnv && process.env[def.apiKeyEnv]) return 'env'
  if (def.apiKey) return 'config'
  return 'absent'
}

// —— doctor ——
function catalogSummary(cfg) {
  const basePath = cfg && cfg.defaults && cfg.defaults.codexCatalogBasePath
  if (!basePath || typeof basePath !== 'string') return { status: 'unknown', reason: 'codex_catalog_base_not_configured' }
  let base
  try { base = JSON.parse(readFileSync(basePath, 'utf8')) } catch {
    return { status: 'fail', reason: 'catalog_base_unreadable' }
  }
  try {
    const built = buildCatalog({ base, config: cfg })
    const bindings = built.meta.bindings || {}
    const officialSlugs = built.catalog.models.map((m) => m && m.slug).filter((s) => s && !bindings[s])
    const completeness = catalogViewCompleteness({
      models: built.catalog.models, bindings, officialSlugs,
      aliases: built.meta.aliases || {}, counts: built.meta.counts,
    })
    const staleEvidence = (built.meta.models || []).filter((m) => m && m.evidence && m.evidence.freshness === 'stale').length
    return {
      status: completeness.ok ? (staleEvidence ? 'warn' : 'ok') : 'warn',
      complete: completeness.ok,
      issues: completeness.issues,
      counts: built.meta.counts,
      warnings: (built.meta.warnings || []).length,
      staleEvidence,
      fingerprint: catalogFingerprint(built.catalog),
      readOnly: true,
    }
  } catch (e) {
    return { status: 'fail', reason: (e && e.code) ? String(e.code) : 'catalog_build_failed' }
  }
}

function runDoctor(flags) {
  const checks = []
  const version = pkgVersion()
  checks.push({ id: 'cli.version', status: version === 'unknown' ? 'warn' : 'ok', detail: version })
  const major = Number(String(process.versions.node || '0').split('.')[0])
  checks.push({
    id: 'node.version',
    // N00 已把 engines/CI 收敛到 Linux + Node 24（>=24）；更高版本未列入首发验证范围。
    status: major >= 24 ? 'ok' : (major >= 18 ? 'warn' : 'fail'),
    detail: process.versions.node,
    note: '首发支持矩阵为 Linux + Node 24（>=24）；Node 18/20 已退役、22 不在首发验证范围',
  })
  checks.push({ id: 'management.api', status: 'ok', detail: CODEX_API_VERSION, supported: CODEX_API_VERSIONS.slice() })
  const src = configSource(flags)
  let cfg = null
  if (!src.configPath && !src.configDir) {
    checks.push({ id: 'config', status: 'unknown', detail: 'not-configured', nextAction: 'pass-explicit-config' })
  } else {
    try {
      cfg = loadGatewayConfig(flags).cfg
      checks.push({
        id: 'config', status: 'ok',
        providers: Object.keys(cfg.providers || {}).length,
        models: Object.keys(cfg.models || {}).length,
        secretValuesRead: false,
      })
    } catch (e) {
      checks.push({ id: 'config', status: 'fail', code: e.code, detail: e.message })
    }
  }
  if (cfg) {
    const catalog = catalogSummary(cfg)
    checks.push(Object.assign({ id: 'catalog' }, catalog))
    const keysPath = cfg._paths && cfg._paths.keys
    let keys = 'unknown'
    try { keys = keysPath && statSync(keysPath) ? 'present' : 'absent' } catch { keys = keysPath ? 'absent' : 'unknown' }
    checks.push({ id: 'keys', status: keys === 'present' ? 'ok' : 'unknown', detail: keys, valuesRead: false })
    const goProviders = Object.keys(cfg.providers || {}).filter((id) => id === GO_PROVIDER_ID || goEntryOf(cfg.providers[id] || {}).ok)
    checks.push({ id: 'go.providers', status: 'ok', detail: goProviders.length ? goProviders : 'none-configured' })
  }
  checks.push({ id: 'live.upstream', status: 'unknown', detail: 'no-network', note: '本命令不主动请求任何上游/账户接口' })
  checks.push({ id: 'client.real-load', status: 'unknown', detail: 'NOT_RUN', note: '真实 Codex 加载属 Q02，不在 CLI 内验证' })
  const ok = !checks.some((c) => c.status === 'fail')
  return {
    ok,
    contract: CLI_CONTRACT,
    apiVersion: DEFAULT_API_VERSION,
    version,
    noNetwork: true,
    checks,
    notChecked: ['live upstream reachability', 'real Codex client load', 'account quota'],
  }
}

// —— 只读投影 ——
function providerView(cfg, id) {
  const def = (cfg.providers || {})[id] || {}
  const models = Object.keys(cfg.models || {}).filter((m) => {
    const e = cfg.models[m]
    return e && (e.provider === id || (e.providerModels && e.providerModels[id]))
  })
  const identity = classifyTarget({ id, baseUrl: def.baseUrl, _def: def }, cfg)
  const view = {
    id,
    api: def.api || 'openai',
    host: hostOfUrl(def.baseUrl),
    models: models.length,
    keyRef: keyPresence(cfg, id),
    identity: identity.kind,
  }
  if (def.pathPrefix) view.pathPrefix = String(def.pathPrefix)
  return view
}

function providerShow(cfg, id) {
  if (!cfg.providers || !cfg.providers[id]) throw new CliError('unknown_provider', '未配置的 provider：' + id, { exitCode: EXIT.NOT_FOUND })
  const view = providerView(cfg, id)
  const def = cfg.providers[id]
  if (id === GO_PROVIDER_ID || goEntryOf(def).ok) {
    const go = validateGo(Object.assign({ id }, def), { cfg, allowLoopback: true })
    view.go = { ok: go.ok, code: go.code || null, binding: go.entry && go.entry.ok ? go.entry.entry.binding : null, warnings: go.warnings || [] }
  }
  return Object.assign(view, {
    modelNames: Object.keys(cfg.models || {}).filter((m) => {
      const e = cfg.models[m]
      return e && (e.provider === id || (e.providerModels && e.providerModels[id]))
    }).sort(),
  })
}

function modelView(cfg, name) {
  const def = (cfg.models || {})[name]
  if (!def) throw new CliError('unknown_model', '未配置的模型：' + name, { exitCode: EXIT.NOT_FOUND })
  return {
    name,
    provider: def.provider || null,
    api: def.api || null,
    alias: Array.isArray(def.alias) ? def.alias.slice() : [],
    capability: def.capability || 'chat',
    maxContext: def.maxContext || null,
    effortOptions: Array.isArray(def.effortOptions) ? def.effortOptions.slice() : [],
    reasoning: def.reasoning || null,
    providerModels: def.providerModels && typeof def.providerModels === 'object' ? Object.keys(def.providerModels).sort() : [],
  }
}

function routeExplain(cfg, model) {
  const router = createRouter(cfg)
  try {
    const hit = router.resolve(model)
    return {
      model,
      resolved: true,
      canonicalName: hit.canonicalName,
      provider: hit.def && hit.def.provider ? hit.def.provider : null,
      api: hit.def && hit.def.api ? hit.def.api : null,
      servingModel: hit.def && hit.def.servingModel ? hit.def.servingModel : null,
      virtual: !!(hit.def && hit.def.isVirtualModel),
      codexAggregate: !!(hit.def && hit.def.codexAggregate),
      codexOfficial: !!(hit.def && hit.def.codexOfficial),
      catalogGeneration: hit.catalogGeneration != null ? hit.catalogGeneration : null,
    }
  } catch (e) {
    return {
      model,
      resolved: false,
      code: e && e.code ? String(e.code) : 'unresolved_model',
      reason: e && e.reason ? String(e.reason) : null,
      status: e && e.status ? Number(e.status) : null,
      message: e && e.message ? String(e.message).slice(0, 200) : '模型无法解析',
      zeroUpstream: true,
    }
  }
}

// —— HTTP（只 loopback；写操作不做隐式重试）——
function assertLoopbackTarget(baseUrl) {
  const host = hostOfUrl(baseUrl)
  if (!host) throw new CliError('invalid_base_url', '管理 API base URL 非法：' + String(baseUrl || ''))
  if (LOOPBACK.has(host)) return { host, remote: false }
  if (/^(1|true|on)$/i.test(String(process.env.MG_CLI_ALLOW_REMOTE || '').trim())) return { host, remote: true }
  throw new CliError('remote_target_forbidden', '拒绝非 loopback 管理目标：' + host + '（确需远程请显式设置 MG_CLI_ALLOW_REMOTE=1）', { nextAction: 'use-loopback' })
}
function adminToken(flags) {
  const envName = flagString(flags, 'admin-token-env') || 'MG_ADMIN_TOKEN'
  const token = String(process.env[envName] || '').trim()
  if (!token) throw new CliError('admin_token_missing', '未设置管理令牌环境变量 ' + envName + '（令牌不进 argv/输出）', { exitCode: EXIT.UNAUTHORIZED, nextAction: 'set-admin-token-env' })
  return { token, envName }
}
function exitForStatus(status) {
  if (status === 401) return EXIT.UNAUTHORIZED
  if (status === 403) return EXIT.FORBIDDEN
  if (status === 404) return EXIT.NOT_FOUND
  if (status === 409) return EXIT.CONFLICT
  return EXIT.ERROR
}
async function callApi({ baseUrl, token, apiVersion, method, path, body }) {
  const target = assertLoopbackTarget(baseUrl)
  let res
  try {
    res = await fetch(new URL(path, baseUrl), {
      method,
      headers: Object.assign(
        { 'x-mg-admin': token, 'x-mg-api-version': apiVersion, accept: 'application/json' },
        body === undefined ? {} : { 'content-type': 'application/json' },
      ),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    })
  } catch (e) {
    throw new CliError('management_unreachable', '无法连接管理 API（' + String(baseUrl) + '）：' + (e && e.name === 'TimeoutError' ? 'timeout' : (e && e.code) || 'network_error'), { nextAction: 'check-gateway' })
  }
  let payload = null
  try { payload = await res.json() } catch { payload = null }
  if (!res.ok) {
    const code = payload && payload.code ? String(payload.code) : 'management_http_' + res.status
    const message = payload && (payload.error || payload.message) ? String(payload.error || payload.message).slice(0, 300) : '管理 API 返回 HTTP ' + res.status
    throw new CliError(code, message, {
      exitCode: exitForStatus(res.status),
      status: res.status,
      nextAction: payload && payload.nextAction ? String(payload.nextAction) : null,
      requestId: payload && payload.requestId ? String(payload.requestId) : null,
    })
  }
  if (!payload || typeof payload !== 'object') throw new CliError('management_invalid_response', '管理 API 返回的不是 JSON 对象')
  if (target.remote) payload.remoteTarget = true
  return payload
}

// —— config 写路径 ——
function readDesiredFlag(flags) {
  const raw = flagString(flags, 'desired')
  if (!raw) throw new CliError('desired_required', '缺少 --desired（JSON 文本或 @文件）')
  let text = raw
  if (raw.startsWith('@')) {
    try { text = readFileSync(raw.slice(1), 'utf8') } catch { throw new CliError('desired_unreadable', '无法读取 --desired 文件（不打印路径内容）') }
  }
  let parsed
  try { parsed = JSON.parse(text) } catch { throw new CliError('desired_invalid', '--desired 必须是合法 JSON 对象') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new CliError('desired_invalid', '--desired 必须是 JSON 对象 { topLevel, sections? }')
  const desired = parsed && parsed.desired ? parsed.desired : parsed
  if (!desired || typeof desired !== 'object' || Array.isArray(desired) || !desired.topLevel) {
    throw new CliError('desired_invalid', '--desired 缺少 topLevel（只接受白名单字段声明，不接受原始 TOML）')
  }
  return desired
}
function jsonFlag(flags, name) {
  const raw = flagString(flags, name)
  if (!raw) return undefined
  let text = raw
  if (raw.startsWith('@')) {
    try { text = readFileSync(raw.slice(1), 'utf8') } catch { throw new CliError(name + '_unreadable', '无法读取 --' + name + ' 文件') }
  }
  try { return JSON.parse(text) } catch { throw new CliError(name + '_invalid', '--' + name + ' 必须是合法 JSON') }
}
async function configPlan(flags) {
  const baseUrl = requiredFlag(flags, 'base-url')
  assertLoopbackTarget(baseUrl)
  const { token } = adminToken(flags)
  const root = requiredFlag(flags, 'root')
  const desired = readDesiredFlag(flags)
  const expected = jsonFlag(flags, 'expected')
  const body = { root, desired }
  if (expected !== undefined) body.expected = expected
  if (flags['allow-create'] === true) body.allowCreate = true
  const plan = await callApi({ baseUrl, token, apiVersion: flagString(flags, 'api-version') || DEFAULT_API_VERSION, method: 'POST', path: '/api/codex/config/plan', body })
  return {
    ok: true,
    planId: plan.planId || null,
    generation: plan.generation,
    root: plan.root,
    wrote: false,
    before: plan.before,
    after: plan.after,
    redactedDiff: plan.redactedDiff || plan.changed || [],
    warnings: plan.warnings || [],
    preserved: plan.preserved,
    confirmToken: plan.confirmToken || null,
    expiresAt: plan.expiresAt || null,
    requiresConfirmation: true,
    apiVersion: plan.apiVersion || DEFAULT_API_VERSION,
  }
}
async function confirmOrThrow(flags, action) {
  if (flags.yes === true) return
  if (!process.stdin.isTTY) {
    throw new CliError('confirmation_required', action + ' 是非 TTY 写操作：必须显式传 --yes（或用交互终端逐次确认）', { nextAction: 'rerun-with-yes' })
  }
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = await rl.question('确认执行 ' + action + '？输入 yes 继续：')
    if (String(answer).trim().toLowerCase() !== 'yes') throw new CliError('confirmation_declined', '用户取消：未执行任何写入')
  } finally { rl.close() }
}
async function configApply(flags) {
  const baseUrl = requiredFlag(flags, 'base-url')
  assertLoopbackTarget(baseUrl)
  const planId = requiredFlag(flags, 'plan')
  const confirmToken = requiredFlag(flags, 'confirm-token')
  const { token } = adminToken(flags)
  const root = requiredFlag(flags, 'root')
  const desired = readDesiredFlag(flags)
  const expected = jsonFlag(flags, 'expected')
  if (!expected) throw new CliError('snapshot_required', 'apply 必须带 --expected（plan 返回的 before 快照），不做盲写')
  await confirmOrThrow(flags, 'config apply（写入受控 config.toml）')
  const out = await callApi({
    baseUrl, token, apiVersion: flagString(flags, 'api-version') || DEFAULT_API_VERSION, method: 'POST',
    path: '/api/codex/config/apply', body: { root, desired, expected, confirmToken, planId },
  })
  return {
    ok: true,
    planId,
    generation: out.generation,
    wrote: out.wrote === true,
    before: out.before,
    after: out.after,
    redactedDiff: out.changed || [],
    backupId: out.backupId || null,
    rollback: out.rollback || null,
    warnings: out.warnings || [],
    restartsClient: out.restartsClient === false ? false : out.restartsClient,
    apiVersion: out.apiVersion || DEFAULT_API_VERSION,
  }
}
async function configRollback(flags) {
  const baseUrl = requiredFlag(flags, 'base-url')
  assertLoopbackTarget(baseUrl)
  const planId = requiredFlag(flags, 'plan')
  const confirmToken = requiredFlag(flags, 'confirm-token')
  const backupId = requiredFlag(flags, 'backup-id')
  const expectedSha256 = requiredFlag(flags, 'expected-sha256')
  const { token } = adminToken(flags)
  const root = requiredFlag(flags, 'root')
  await confirmOrThrow(flags, 'config rollback（用备份覆盖受控 config.toml）')
  const out = await callApi({
    baseUrl, token, apiVersion: flagString(flags, 'api-version') || DEFAULT_API_VERSION, method: 'POST',
    path: '/api/codex/config/rollback', body: { root, backupId, expectedSha256, confirmToken, planId },
  })
  return { ok: true, planId, backupId: out.backupId, safetyBackupId: out.safetyBackupId || null, before: out.before, after: out.after, wrote: out.wrote === true }
}

function requiredFlag(flags, name) {
  const v = flagString(flags, name)
  if (!v) throw new CliError(name.replace(/-/g, '_') + '_required', '缺少 --' + name)
  return v
}

function clientExport(flags) {
  const { cfg } = loadGatewayConfig(flags, { required: false })
  const baseUrl = flagString(flags, 'base-url') || (cfg && cfg.server && cfg.server.host && cfg.server.port
    ? 'http://' + (cfg.server.host === '0.0.0.0' ? '127.0.0.1' : cfg.server.host) + ':' + cfg.server.port
    : null)
  if (!baseUrl) throw new CliError('base_url_required', '缺少 --base-url（或提供含 server.host/port 的网关配置）')
  const model = flagString(flags, 'model') || (cfg && cfg.defaults && cfg.defaults.model) || ''
  if (!model) throw new CliError('model_required', '缺少 --model（或配置 defaults.model）')
  const aliases = []
  if (cfg) {
    for (const [name, entry] of Object.entries(cfg.models || {})) {
      for (const alias of (entry && Array.isArray(entry.alias) ? entry.alias : [])) aliases.push({ alias, model: name })
    }
  }
  return exportClientTemplate({
    openaiBaseUrl: baseUrl,
    model,
    modelCatalogJsonPath: flagString(flags, 'catalog-path') || undefined,
    profile: flagString(flags, 'profile') || undefined,
    role: flagString(flags, 'role') || undefined,
    aliases,
  })
}

// —— 输出 ——
function emit(payload, flags, textLines) {
  if (flags.json === true) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n')
    return
  }
  const lines = typeof textLines === 'function' ? textLines(payload) : (Array.isArray(textLines) ? textLines : [])
  process.stdout.write(lines.join('\n') + (lines.length ? '\n' : ''))
}
function fail(err, flags) {
  const payload = {
    ok: false,
    code: err && err.code ? String(err.code) : 'cli_error',
    error: err && err.message ? String(err.message).slice(0, 400) : 'unknown error',
    contract: CLI_CONTRACT,
    apiVersion: DEFAULT_API_VERSION,
  }
  if (err && err.status) payload.status = err.status
  if (err && err.nextAction) payload.nextAction = err.nextAction
  if (err && err.requestId) payload.requestId = err.requestId
  if (flags && flags.json === true) process.stdout.write(JSON.stringify(payload, null, 2) + '\n')
  else process.stderr.write('错误 [' + payload.code + '] ' + payload.error + (payload.nextAction ? '（建议：' + payload.nextAction + '）' : '') + '\n')
  return err && err.exitCode != null ? err.exitCode : EXIT.ERROR
}

const USAGE = [
  'ModelGate 管理 CLI（modelgate.cli/1）',
  '  node bin/mg.mjs --version   # 打印 CLI 契约/包版本/管理 API 版本（不读配置、不联网）',
  '',
  '只读（不联网）：',
  '  node bin/mg.mjs doctor --json [--config <gateway.json>] [--config-dir <dir>]',
  '  node bin/mg.mjs provider list|show <id> [--json] [--config ...]',
  '  node bin/mg.mjs model list|show <name> [--json] [--config ...]',
  '  node bin/mg.mjs route explain --model <name> [--json] [--config ...]',
  '  node bin/mg.mjs client codex export [--base-url <url>] [--model <id>] [--json]',
  '',
  '管理写路径（loopback + 管理令牌环境变量 + planId 绑定）：',
  '  node bin/mg.mjs config plan --base-url <url> --root <id> --desired @patch.json [--expected @snap.json] [--json]',
  '  node bin/mg.mjs config apply --base-url <url> --root <id> --plan <planId> --confirm-token <token> --desired @patch.json --expected @snap.json --yes',
  '  node bin/mg.mjs config rollback --base-url <url> --root <id> --plan <planId> --confirm-token <token> --backup-id <id> --expected-sha256 <sha> --yes',
  '',
  '管理令牌只从环境变量读取（默认 MG_ADMIN_TOKEN，--admin-token-env 可改）；令牌不进 argv/输出。',
  '默认只允许 loopback 目标；非 loopback 需显式 MG_CLI_ALLOW_REMOTE=1。',
].join('\n')

export async function main(argv = process.argv.slice(2)) {
  const { flags, positional } = parseArgv(argv)
  if (flags.version === true) {
    // 版本自证：CLI 契约 + 包版本 + 管理 API 契约，无需配置/网络。
    process.stdout.write('modelgate.cli/1 version ' + pkgVersion() + ' api ' + DEFAULT_API_VERSION + '\n')
    return EXIT.OK
  }
  if (flags.help === true || positional.length === 0) {
    process.stdout.write(USAGE + '\n')
    return positional.length === 0 && flags.help !== true ? EXIT.ERROR : EXIT.OK
  }
  const [command, sub] = positional
  try {
    if (command === 'doctor') {
      const out = runDoctor(flags)
      emit(out, flags, (p) => {
        const lines = ['ModelGate doctor  v' + p.version + '  api=' + p.apiVersion, 'network: none']
        for (const c of p.checks) lines.push('  [' + c.status + '] ' + c.id + (c.detail !== undefined ? ' — ' + (typeof c.detail === 'string' ? c.detail : JSON.stringify(c.detail)) : ''))
        lines.push(p.ok ? 'result: PASS（离线检查）' : 'result: FAIL（见上）')
        return lines
      })
      return out.ok ? EXIT.OK : EXIT.ERROR
    }
    if (command === 'provider' || command === 'model' || command === 'route') {
      if (command === 'route' && sub !== 'explain') throw new CliError('usage', 'route 只支持 explain：node bin/mg.mjs route explain --model <name>')
      if (command !== 'route' && sub !== 'list' && sub !== 'show') throw new CliError('usage', command + ' 只支持 list|show')
      const { cfg } = loadGatewayConfig(flags)
      if (command === 'provider') {
        const ids = Object.keys(cfg.providers || {}).sort()
        if (sub === 'list') {
          const out = { ok: true, providers: ids.map((id) => providerView(cfg, id)), readOnly: true }
          emit(out, flags, (p) => ['providers:', ...p.providers.map((x) => '  ' + x.id + '  api=' + x.api + '  host=' + (x.host || '?') + '  models=' + x.models + '  key=' + x.keyRef)])
          return EXIT.OK
        }
        const id = positional[2]
        if (!id) throw new CliError('usage', 'provider show 需要 provider id')
        const out = providerShow(cfg, id)
        emit({ ok: true, provider: out, readOnly: true }, flags, (p) => ['provider: ' + p.provider.id, '  host: ' + (p.provider.host || '?'), '  models: ' + p.provider.modelNames.join(', ')])
        return EXIT.OK
      }
      if (command === 'model') {
        const names = Object.keys(cfg.models || {}).sort()
        if (sub === 'list') {
          const out = { ok: true, models: names.map((n) => modelView(cfg, n)), readOnly: true }
          emit(out, flags, (p) => ['models:', ...p.models.map((m) => '  ' + m.name + '  provider=' + (m.provider || '?') + '  aliases=' + (m.alias.join(',') || '-'))])
          return EXIT.OK
        }
        const name = positional[2]
        if (!name) throw new CliError('usage', 'model show 需要模型名')
        emit({ ok: true, model: modelView(cfg, name), readOnly: true }, flags, (p) => ['model: ' + p.model.name, '  provider: ' + (p.model.provider || '?'), '  aliases: ' + (p.model.alias.join(',') || '-')])
        return EXIT.OK
      }
      const modelName = flagString(flags, 'model')
      if (!modelName) throw new CliError('model_required', 'route explain 需要 --model <name>')
      const explained = routeExplain(cfg, modelName)
      emit(Object.assign({ ok: explained.resolved, readOnly: true }, { route: explained }), flags, (p) => {
        const r = p.route
        if (!r.resolved) return ['route: ' + r.model + '  UNRESOLVED', '  code: ' + r.code, '  reason: ' + (r.reason || '-'), '  zero upstream: true']
        return ['route: ' + r.model, '  canonical: ' + r.canonicalName, '  provider: ' + (r.provider || '?'), '  serving: ' + (r.servingModel || r.model), '  aggregate: ' + r.codexAggregate, '  catalogGeneration: ' + (r.catalogGeneration == null ? '-' : r.catalogGeneration)]
      })
      return explained.resolved ? EXIT.OK : (explained.status === 404 ? EXIT.NOT_FOUND : EXIT.ERROR)
    }
    if (command === 'client') {
      if (sub !== 'codex') throw new CliError('usage', 'client 只支持 codex export')
      const action = positional[2]
      if (action !== 'export') throw new CliError('usage', 'client codex 只支持 export')
      const tpl = clientExport(flags)
      emit(tpl, flags, (p) => [p.text.trimEnd()])
      return EXIT.OK
    }
    if (command === 'config') {
      if (sub === 'plan') {
        const out = await configPlan(flags)
        emit(out, flags, (p) => ['plan: ' + p.planId, 'generation: ' + p.generation, 'wrote: false', 'diff rows: ' + p.redactedDiff.length])
        return EXIT.OK
      }
      if (sub === 'apply') {
        const out = await configApply(flags)
        emit(out, flags, (p) => ['applied plan ' + p.planId, 'generation: ' + p.generation, 'backup: ' + (p.backupId || '-')])
        return EXIT.OK
      }
      if (sub === 'rollback') {
        const out = await configRollback(flags)
        emit(out, flags, (p) => ['rolled back ' + p.backupId, 'safety backup: ' + (p.safetyBackupId || '-')])
        return EXIT.OK
      }
      throw new CliError('usage', 'config 只支持 plan|apply|rollback')
    }
    throw new CliError('usage', '未知命令：' + command + '（运行 node bin/mg.mjs --help）')
  } catch (e) {
    return fail(e, flags)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => { process.exitCode = code }).catch((e) => { process.exitCode = fail(e, { json: process.argv.includes('--json') }) })
}
