// A3 / P03：原版 Codex Desktop 一键接入的配置集成层。
//
// 契约（ADR-0003 §2 冻结）：detect / preview / activate / deactivate / status。
//  * 每次写盘都走 src/codex/config.js 的事务语义：预检快照 → 合并 → 二次快照 → 备份 →
//    原子写 → 写后校验。本模块不重写 TOML 合并、不新建第二把配置锁的语义（这里是
//    "桌面接入流程锁"，只用来串行化 activate/deactivate/recover，不替代 configVersion）。
//  * 只写 config.js 声明的 owned 字段：model_provider / openai_base_url / model /
//    model_catalog_json 与 [features] 的 multi_agent(_v2)。其余行逐字节保留。
//  * 绝不读写 auth.json；只接受显式绝对 config.toml 路径（不猜 HOME，detect 负责解析）。
//  * 写盘不算成功：写后必须通过"配置解析 + 目录存在且包含目标模型 + 网关健康"三项验证。
//  * 失败/崩溃只回滚"仍然属于我们"的字节；用户或第三方改过就返回三方差异，绝不覆盖。
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import {
  ConfigError,
  OWNED_SECTIONS,
  OWNED_TOP_LEVEL,
  RESERVED_OVERRIDE_SECTIONS,
  SENSITIVE_FIELD_RE,
  buildDesiredCodexConfig,
  commitConfigPlan,
  commitConfigRollback,
  diffConfigText,
  mergeOwnedFields,
  normalizeOwnedValue,
  planRollback,
  readOwnedFields,
  sha256Hex,
  snapshotConfigFile,
  summarizePreserved,
} from './config.js'

export const DESKTOP_CONTRACT = 'mg-codex-desktop/1'
export const STATE_SCHEMA = 'mg-codex-desktop-state/1'
export const JOURNAL_SCHEMA = 'mg-codex-desktop-journal/1'
export const MAX_CATALOG_BYTES = 4 * 1024 * 1024
export const DEFAULT_LOCK_STALE_MS = 120000
export const DEFAULT_GATEWAY_BASE_URL = 'http://127.0.0.1:18787'
export const MODES = Object.freeze(['official', 'aggregated', 'unknown'])
const MAX_CONFIG_BYTES = 512 * 1024

export class DesktopError extends Error {
  constructor (code, message, detail, status) {
    super(message)
    this.name = 'DesktopError'
    this.code = code
    this.detail = detail === undefined ? null : detail
    this.status = status === undefined ? 500 : status
  }
}

function asDesktopError (error, fallbackCode) {
  if (error instanceof DesktopError) return error
  if (error instanceof ConfigError) {
    const status = {
      concurrent_modification: 409,
      unmanaged_conflict: 409,
      duplicate_section: 422,
      duplicate_key: 422,
      unsupported_layout: 422,
      multiline_value: 422,
      too_large: 413,
    }[error.code] || 422
    return new DesktopError(error.code, error.message, error.detail, status)
  }
  return new DesktopError(fallbackCode || 'desktop_integration_failed', error && error.message ? error.message : '未知错误', null, 500)
}

// —— 路径 ——
export function resolveDesktopPaths (opts = {}) {
  const codexHome = String(opts.codexHome || process.env.CODEX_HOME || (process.env.HOME ? join(process.env.HOME, '.codex') : '')).trim()
  if (!codexHome) throw new DesktopError('config_path_unresolved', '无法确定 Codex 配置目录：请设置 CODEX_HOME 或显式传入 configPath。', null, 422)
  const configPath = resolve(String(opts.configPath || join(codexHome, 'config.toml')))
  if (basename(configPath) !== 'config.toml') {
    throw new DesktopError('invalid_config_path', '集成层只接受 config.toml：' + basename(configPath), null, 422)
  }
  if (/auth\.json/i.test(configPath)) throw new DesktopError('forbidden_path', 'auth.json 永不读写。', null, 422)
  return {
    codexHome,
    configPath,
    lockPath: configPath + '.mg-lock',
    journalPath: configPath + '.mg-journal.json',
    statePath: resolve(String(opts.statePath || join(dirname(configPath), '.modelgate-desktop-state.json'))),
  }
}

function readJsonFile (path) {
  try {
    const text = readFileSync(path, 'utf8')
    if (Buffer.byteLength(text, 'utf8') > MAX_CONFIG_BYTES) return { ok: false, reason: 'oversize' }
    return { ok: true, value: JSON.parse(text) }
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: false, reason: 'missing' }
    return { ok: false, reason: 'unreadable' }
  }
}

function writeAtomicJson (path, value, mode) {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, '.' + basename(path) + '.mg-' + process.pid + '-' + randomBytes(6).toString('hex') + '.tmp')
  let fd = null
  try {
    fd = openSync(tmp, 'wx', mode || 0o600)
    writeSync(fd, Buffer.from(JSON.stringify(value, null, 2), 'utf8'))
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(tmp, path)
  } catch (e) {
    try { if (fd != null) closeSync(fd) } catch {}
    try { unlinkSync(tmp) } catch {}
    throw new DesktopError('state_write_failed', '写入接入状态失败：' + (e && e.message ? e.message : '未知错误'), null, 500)
  }
}

// —— 流程锁：只串行化本模块的 activate/deactivate/recover，不替代 configVersion ——
function readLock (lockPath, now) {
  let st = null
  try { st = lstatSync(lockPath) } catch { return { present: false } }
  if (st.isSymbolicLink()) return { present: true, malformed: true, stale: false }
  const parsed = readJsonFile(lockPath)
  const ageMs = Math.max(0, now - Number(st.mtimeMs || 0))
  return {
    present: true,
    malformed: !parsed.ok,
    nonce: parsed.ok ? String(parsed.value.nonce || '') : null,
    pid: parsed.ok && Number.isInteger(parsed.value.pid) ? parsed.value.pid : null,
    at: parsed.ok ? Number(parsed.value.at) || null : null,
    ageMs,
    stale: ageMs > (parsed.ok && Number.isFinite(parsed.value.staleMs) ? Number(parsed.value.staleMs) : DEFAULT_LOCK_STALE_MS),
  }
}

export function acquireDesktopLock (opts = {}) {
  const { lockPath } = resolveDesktopPaths(opts)
  const now = Number.isFinite(opts.now) ? Number(opts.now) : Date.now()
  const staleMs = Number.isFinite(opts.staleMs) ? Number(opts.staleMs) : DEFAULT_LOCK_STALE_MS
  const nonce = randomBytes(12).toString('hex')
  const payload = JSON.stringify({ schema: DESKTOP_CONTRACT + '/lock', nonce, pid: process.pid, at: now, staleMs })
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd = null
    try {
      fd = openSync(lockPath, 'wx', 0o600)
      writeSync(fd, Buffer.from(payload, 'utf8'))
      fsyncSync(fd)
      closeSync(fd)
      fd = null
      return {
        ok: true,
        nonce,
        path: lockPath,
        release: () => {
          const current = readJsonFile(lockPath)
          if (!current.ok || String(current.value.nonce) !== nonce) return false
          try { unlinkSync(lockPath) } catch { return false }
          return true
        },
      }
    } catch (e) {
      try { if (fd != null) closeSync(fd) } catch {}
      if (!e || e.code !== 'EEXIST') throw new DesktopError('lock_failed', '获取接入流程锁失败：' + (e && e.message ? e.message : '未知错误'), null, 500)
      const lock = readLock(lockPath, now)
      if (lock.stale) {
        try { unlinkSync(lockPath) } catch {}
        continue
      }
      throw new DesktopError('lock_held', '另一个 ModelGate 操作正在进行（接入流程锁未释放），请稍后重试。', { lockPath: lockPath, stale: false }, 409)
    }
  }
  throw new DesktopError('lock_held', '接入流程锁无法获取。', null, 409)
}

function readConfigText (target) {
  const snap = snapshotConfigFile(target)
  if (!snap.exists) return { snap, text: '', owned: readOwnedFields('') }
  const text = readFileSync(target, 'utf8')
  if (Buffer.byteLength(text, 'utf8') > MAX_CONFIG_BYTES) {
    throw new DesktopError('config_too_large', 'config.toml 超过 ' + MAX_CONFIG_BYTES + ' 字节，拒绝自动接入。', null, 413)
  }
  return { snap, text, owned: readOwnedFields(text) }
}

// —— 配置状态分类：official / aggregated / unknown ——
// official：没有把请求改向任何第三方的 owned 字段（或只存在我们写入前的默认值）。
// aggregated：openai_base_url 指向本机回环 + 本地目录存在，或状态记录与当前字节一致。
// unknown：用户自己指向非回环地址、文件损坏/超限/符号链接等——给明确路径，不猜。
export function classifyConfigState (opts = {}) {
  const paths = resolveDesktopPaths(opts)
  const baseUrl = String(opts.baseUrl || DEFAULT_GATEWAY_BASE_URL).replace(/\/+$/, '')
  let st = null
  try { st = lstatSync(paths.configPath) } catch {}
  if (st && st.isSymbolicLink()) return { mode: 'unknown', reason: 'symlink_config', exists: true, sha256: null, size: null }
  if (!st) return { mode: 'official', reason: 'config_absent', exists: false, sha256: null, size: null }
  let snap
  let text
  try {
    snap = snapshotConfigFile(paths.configPath)
    text = readFileSync(paths.configPath, 'utf8')
  } catch (e) {
    return { mode: 'unknown', reason: e && e.code ? e.code : 'unreadable', exists: true, sha256: null, size: null }
  }
  let owned
  try {
    owned = readOwnedFields(text)
  } catch (e) {
    return { mode: 'unknown', reason: e && e.code ? e.code : 'parse_failed', exists: true, sha256: snap.sha256, size: snap.size }
  }
  const state = loadState(paths)
  if (state && state.mode === 'aggregated' && snap.sha256 === state.appliedSha) {
    return { mode: 'aggregated', reason: 'state_record_match', exists: true, sha256: snap.sha256, size: snap.size }
  }
  const rawUrl = normalizeOwnedValue(owned.topLevel.openai_base_url)
  const rawCatalog = normalizeOwnedValue(owned.topLevel.model_catalog_json)
  const url = typeof rawUrl === 'string' ? rawUrl.trim() : ''
  const catalog = typeof rawCatalog === 'string' ? rawCatalog.trim() : ''
  if (!url && !catalog) return { mode: 'official', reason: 'no_redirect_fields', exists: true, sha256: snap.sha256, size: snap.size }
  const loopback = isLoopbackUrl(url) || String(baseUrl) === url.replace(/\/+$/, '')
  if (loopback && catalog) return { mode: 'aggregated', reason: 'loopback_redirect_with_catalog', exists: true, sha256: snap.sha256, size: snap.size }
  return { mode: 'unknown', reason: 'third_party_redirect', exists: true, sha256: snap.sha256, size: snap.size }
}

function isLoopbackUrl (value) {
  try {
    const u = new URL(String(value))
    const host = u.hostname.replace(/^\[|\]$/g, '')
    return u.protocol === 'http:' && (host === '127.0.0.1' || host === 'localhost' || host === '::1')
  } catch { return false }
}

// —— 状态与崩溃日志 ——
function loadState (paths) {
  const parsed = readJsonFile(paths.statePath)
  if (!parsed.ok) return null
  const v = parsed.value
  if (!v || v.schema !== STATE_SCHEMA || !MODES.includes(String(v.mode))) return null
  return v
}

function saveState (paths, record) {
  writeAtomicJson(paths.statePath, Object.assign({ schema: STATE_SCHEMA }, record), 0o600)
}

function journalPhase (paths) {
  const parsed = readJsonFile(paths.journalPath)
  if (!parsed.ok) return null
  const v = parsed.value
  if (!v || v.schema !== JOURNAL_SCHEMA) return { malformed: true }
  return v
}

// 崩溃恢复（在持锁时调用）：
//  applying → 已写入但未验证：字节仍是我们的就恢复原文件；不是就保留并报告冲突。
//  verified → 已通过验证但没来得及落状态：补写状态，视为成功。
export function recoverInterruptedApply (opts = {}) {
  const paths = resolveDesktopPaths(opts)
  const journal = journalPhase(paths)
  if (!journal) return { recovered: 'none' }
  if (journal.malformed) {
    try { unlinkSync(paths.journalPath) } catch {}
    return { recovered: 'discarded_malformed_journal' }
  }
  let current = null
  try { current = snapshotConfigFile(paths.configPath) } catch { current = null }
  if (journal.phase === 'verified') {
    saveState(paths, {
      mode: 'aggregated',
      before: journal.before || null,
      applied: journal.applied || null,
      appliedSha: journal.applied ? journal.applied.sha256 : null,
      beforeSha: journal.before ? journal.before.sha256 : null,
      backupPath: journal.backupPath || null,
      desired: journal.desired || null,
      appliedAt: journal.at || null,
      lastApply: journal.lastApply || { ok: true, recoveredAfterCrash: true, at: Date.now() },
    })
    try { unlinkSync(paths.journalPath) } catch {}
    return { recovered: 'finalized_verified' }
  }
  // phase === 'applying'
  if (current && current.exists && journal.applied && current.sha256 === journal.applied.sha256) {
    const restored = restoreIfOurs(paths, journal)
    if (restored.ok) {
      saveState(paths, {
        mode: 'official',
        before: journal.before || null,
        applied: null,
        appliedSha: null,
        beforeSha: journal.before ? journal.before.sha256 : null,
        backupPath: journal.backupPath || null,
        desired: null,
        appliedAt: null,
        lastApply: { ok: false, code: 'interrupted_apply_recovered', recoveredAfterCrash: true, at: Date.now() },
      })
      try { unlinkSync(paths.journalPath) } catch {}
      return { recovered: 'restored_after_crash', sha: restored.sha }
    }
    return { recovered: 'conflict', reason: 'restore_failed', detail: restored.detail || null }
  }
  if (current && current.exists && journal.before && current.sha256 === journal.before.sha256) {
    try { unlinkSync(paths.journalPath) } catch {}
    return { recovered: 'nothing_written' }
  }
  if (journal.before && journal.before.exists === false && current && !current.exists) {
    try { unlinkSync(paths.journalPath) } catch {}
    return { recovered: 'nothing_written' }
  }
  return {
    recovered: 'conflict',
    reason: 'external_modification_since_crash',
    detail: { currentSha: current && current.sha256 ? current.sha256 : null, journalAppliedSha: journal.applied ? journal.applied.sha256 : null },
  }
}

function restoreIfOurs (paths, journal) {
  const current = snapshotConfigFile(paths.configPath)
  if (!journal.applied || current.sha256 !== journal.applied.sha256) return { ok: false, detail: 'not_ours' }
  if (journal.before && journal.before.exists === false) {
    try { unlinkSync(paths.configPath) } catch (e) { return { ok: false, detail: e && e.message } }
    return { ok: true, sha: '' }
  }
  if (!journal.backupPath) return { ok: false, detail: 'backup_missing' }
  try {
    const backupBytes = readFileSync(journal.backupPath)
    const backupSha = sha256Hex(backupBytes)
    if (journal.before && backupSha !== journal.before.sha256) return { ok: false, detail: 'backup_mismatch' }
    const plan = planRollback({ path: paths.configPath, backupPath: journal.backupPath })
    const result = commitConfigRollback(plan)
    return { ok: true, sha: result.after.sha256 }
  } catch (e) {
    return { ok: false, detail: e && e.message ? e.message : 'restore_failed' }
  }
}

// —— 探测：CLI / Desktop / 配置 / 备份 ——
const CLI_CANDIDATES = ['~/.local/bin/codex', '/usr/local/bin/codex', '/usr/bin/codex', '/opt/homebrew/bin/codex']
const DESKTOP_CANDIDATES = ['/usr/bin/chatgpt', '/usr/lib/chatgpt/ChatGPT', '/opt/ChatGPT/ChatGPT', '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT']

function expandHome (p) {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

function existingPath (candidates) {
  for (const raw of candidates) {
    if (!raw) continue
    const p = expandHome(String(raw))
    try {
      if (existsSync(p)) {
        let real = p
        try { real = realpathSync(p) } catch {}
        return { found: true, path: real, requested: p }
      }
    } catch {}
  }
  return { found: false, path: null, requested: null }
}

function probeCliVersion (binPath) {
  const cached = versionCache.get('cli:' + binPath)
  if (cached && Date.now() - cached.at < VERSION_TTL_MS) return cached.value
  let value
  try {
    const out = execFileSync(binPath, ['--version'], {
      timeout: 1500,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: process.env.HOME || '' },
    })
    const m = /(\d+\.\d+\.\d+)/.exec(String(out || ''))
    value = m ? { version: m[1], source: 'codex --version' } : { version: null, source: 'unparsed' }
  } catch {
    value = { version: null, source: 'probe_failed' }
  }
  versionCache.set('cli:' + binPath, { at: Date.now(), value })
  return value
}

const VERSION_TTL_MS = 5 * 60 * 1000
const versionCache = new Map()

// Desktop 二进制不执行（会拉起 GUI）：只从同目录的版本文件/package.json 读取，读不到就 unknown。
function probeDesktopVersion (binPath) {
  const cached = versionCache.get('desktop:' + binPath)
  if (cached && Date.now() - cached.at < VERSION_TTL_MS) return cached.value
  const dir = dirname(binPath)
  let value = { version: null, source: 'not_read' }
  for (const candidate of [join(dir, 'version'), join(dir, 'VERSION'), join(dir, 'resources/app/package.json'), join(dir, '..', 'resources/app/package.json')]) {
    try {
      if (!existsSync(candidate)) continue
      const text = readFileSync(candidate, 'utf8')
      const m = /"version"\s*:\s*"([^"]+)"/.exec(text) || /^v?(\d+\.\d+\.\d+)/m.exec(text)
      if (m) { value = { version: m[1], source: basename(candidate) }; break }
    } catch {}
  }
  versionCache.set('desktop:' + binPath, { at: Date.now(), value })
  return value
}

function backupSummary (paths, state, current) {
  if (!state || !state.backupPath) return { available: false, path: null, sha256: null, matches: false }
  let exists = false
  let sha = null
  try {
    const bytes = readFileSync(state.backupPath)
    exists = true
    sha = sha256Hex(bytes)
  } catch { exists = false }
  return {
    available: exists,
    path: exists ? state.backupPath : null,
    sha256: sha,
    matches: !!(exists && state.beforeSha && sha === state.beforeSha),
    baseExistsHint: current ? current.exists : null,
  }
}

export function detect (opts = {}) {
  const paths = resolveDesktopPaths(opts)
  const gatewayBaseUrl = String(opts.baseUrl || process.env.MG_DESKTOP_GATEWAY || DEFAULT_GATEWAY_BASE_URL).replace(/\/+$/, '')
  let current = null
  try { current = snapshotConfigFile(paths.configPath) } catch { current = null }
  const state = loadState(paths)
  const classification = classifyConfigState({ configPath: paths.configPath, baseUrl: gatewayBaseUrl })
  const lock = readLock(paths.lockPath, Date.now())

  const cliEnvPath = String(opts.cliPath || process.env.MG_CODEX_CLI || '').trim()
  const cli = existingPath(cliEnvPath ? [cliEnvPath, ...CLI_CANDIDATES] : CLI_CANDIDATES)
  let cliInfo = { found: cli.found, path: cli.path, version: null, versionState: cli.found ? 'unknown' : 'not_found', source: null }
  if (cli.found) {
    if (opts.disableExec === true) {
      cliInfo.source = 'exec_disabled'
    } else {
      const probed = probeCliVersion(cli.path)
      cliInfo = Object.assign(cliInfo, { version: probed.version, versionState: probed.version ? 'known' : 'unknown', source: probed.source })
    }
  }

  const desktopEnvPath = String(opts.desktopPath || process.env.MG_DESKTOP_EXECUTABLE || '').trim()
  const desktop = existingPath(desktopEnvPath ? [desktopEnvPath, ...DESKTOP_CANDIDATES] : DESKTOP_CANDIDATES)
  let desktopInfo = { found: desktop.found, path: desktop.path, version: null, versionState: desktop.found ? 'unknown' : 'not_found', source: null }
  if (desktop.found) {
    const probed = opts.disableExec === true ? { version: null, source: 'exec_disabled' } : probeDesktopVersion(desktop.path)
    desktopInfo = Object.assign(desktopInfo, { version: probed.version, versionState: probed.version ? 'known' : 'unknown', source: probed.source })
  }

  return {
    contract: DESKTOP_CONTRACT,
    ok: true,
    codexHome: paths.codexHome,
    configPath: paths.configPath,
    gateway: { baseUrl: gatewayBaseUrl, loopback: isLoopbackUrl(gatewayBaseUrl) },
    config: Object.assign({}, classification, {
      exists: !!(current && current.exists),
      size: current ? current.size : 0,
      mtimeMs: current ? current.mtimeMs : 0,
      fileMode: current ? current.mode : 0,
    }),
    cli: cliInfo,
    desktop: desktopInfo,
    state: state
      ? { mode: state.mode, appliedAt: state.appliedAt || null, appliedSha: state.appliedSha || null, lastApply: state.lastApply || null }
      : null,
    backup: backupSummary(paths, state, current),
    lock: { present: lock.present, stale: !!lock.stale },
    journal: journalPhase(paths) ? { present: true } : { present: false },
    needsRestart: classification.mode === 'aggregated',
  }
}

// —— 预览 ——
function renderTomlValue (value) {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  throw new DesktopError('unsupported_value', '不支持的配置值类型：' + typeof value, null, 422)
}

function consentTokenFor (target, beforeSha, afterSha) {
  return sha256Hex(DESKTOP_CONTRACT + '\n' + target + '\n' + beforeSha + '\n' + afterSha)
}

function buildDesired (opts) {
  try {
    const built = buildDesiredCodexConfig({
      openaiBaseUrl: opts.baseUrl,
      model: opts.model,
      modelCatalogJsonPath: opts.catalogPath,
      features: opts.features,
    })
    return built.desired
  } catch (e) {
    throw asDesktopError(e, 'invalid_desired')
  }
}

function ownedRows (existing, desired) {
  const rows = []
  for (const [key, value] of Object.entries(desired.topLevel || {})) {
    const entry = existing.topLevel[key] || { present: false, raw: '' }
    const to = renderTomlValue(value)
    rows.push({
      path: key,
      owner: 'modelgate',
      kind: !entry.present ? 'add' : (entry.raw === to ? 'same' : 'replace'),
      from: entry.present ? entry.raw : null,
      to,
    })
  }
  for (const [name, keys] of Object.entries(desired.sections || {})) {
    for (const [key, value] of Object.entries(keys)) {
      const entry = (existing.sections[name] && existing.sections[name].keys[key]) || { present: false, raw: '' }
      const to = renderTomlValue(value)
      rows.push({
        path: name + '.' + key,
        owner: 'modelgate',
        kind: !entry.present ? 'add' : (entry.raw === to ? 'same' : 'replace'),
        from: entry.present ? entry.raw : null,
        to,
      })
    }
  }
  return rows
}

function catalogSummary (catalogPath, model, opts = {}) {
  const path = String(catalogPath || '').trim()
  if (!path) return { ok: false, state: 'missing_path', path: null, bytes: 0, modelCount: 0, targetPresent: false, reason: '未提供 model_catalog_json 路径' }
  let st = null
  try { st = statSync(path) } catch { return { ok: false, state: 'missing_file', path, bytes: 0, modelCount: 0, targetPresent: false, reason: '目录文件不存在' } }
  if (!st.isFile()) return { ok: false, state: 'not_a_file', path, bytes: 0, modelCount: 0, targetPresent: false, reason: '目录路径不是普通文件' }
  if (st.size > MAX_CATALOG_BYTES) return { ok: false, state: 'overflow', path, bytes: st.size, modelCount: 0, targetPresent: false, reason: '目录超过 ' + MAX_CATALOG_BYTES + ' 字节上限' }
  let parsed
  try { parsed = JSON.parse(readFileSync(path, 'utf8')) } catch { return { ok: false, state: 'invalid_json', path, bytes: st.size, modelCount: 0, targetPresent: false, reason: '目录不是合法 JSON' } }
  const models = parsed && Array.isArray(parsed.models) ? parsed.models : null
  if (!models) return { ok: false, state: 'invalid_shape', path, bytes: st.size, modelCount: 0, targetPresent: false, reason: '目录缺少 models 数组' }
  const slugs = models.map((m) => (m && (m.slug || m.id || m.model)) || null).filter(Boolean)
  const target = String(model || '').trim()
  const targetPresent = target ? slugs.includes(target) : false
  return {
    ok: models.length > 0 && (opts.requireModelInCatalog === false || targetPresent),
    state: models.length === 0 ? 'empty' : (targetPresent ? 'present' : 'target_missing'),
    path,
    bytes: st.size,
    modelCount: models.length,
    targetPresent,
    reason: models.length === 0 ? '目录为空（客户端会回落到 fallback metadata）' : (targetPresent ? null : '目录中没有目标模型 ' + target),
  }
}

function blockedFromConfigError (error) {
  if (error instanceof ConfigError) return [{ code: error.code, message: error.message }]
  throw error
}

export function preview (opts = {}) {
  const paths = resolveDesktopPaths(opts)
  const gatewayBaseUrl = String(opts.baseUrl || process.env.MG_DESKTOP_GATEWAY || DEFAULT_GATEWAY_BASE_URL).replace(/\/+$/, '')
  const desired = buildDesired({ baseUrl: gatewayBaseUrl, model: opts.model, catalogPath: opts.catalogPath, features: opts.features })
  let before
  let beforeText = ''
  let existing
  let merged
  try {
    before = snapshotConfigFile(paths.configPath)
    beforeText = before.exists ? readFileSync(paths.configPath, 'utf8') : ''
    existing = readOwnedFields(beforeText)
    merged = mergeOwnedFields(beforeText, desired)
  } catch (error) {
    const blocked = blockedFromConfigError(error)
    const snap = { exists: false, size: 0, sha256: '', mtimeMs: 0 }
    try { Object.assign(snap, snapshotConfigFile(paths.configPath)) } catch {}
    return {
      contract: DESKTOP_CONTRACT,
      ok: false,
      state: 'corrupted',
      mode: 'unknown',
      configPath: paths.configPath,
      before: { exists: snap.exists, size: snap.size, sha256: snap.sha256, mtimeMs: snap.mtimeMs },
      expectedSha: snap.exists ? snap.sha256 : '',
      after: { exists: false, size: 0, sha256: '' },
      desired,
      rows: [],
      changed: [],
      conflicts: blocked.map((b) => ({ path: '$config', reason: b.code, message: b.message })),
      blocked,
      warnings: ['配置文件无法按受控 TOML 子集解析：本产品不会猜写，也不会覆盖。请先人工修复或移走该文件。'],
      preserved: null,
      consentRequired: true,
      consentToken: null,
      firstRun: false,
      alreadyAggregated: false,
      catalog: catalogSummary(opts.catalogPath, opts.model, opts),
    }
  }
  const rows = ownedRows(existing, desired)
  const afterText = merged.text
  const afterSha = sha256Hex(Buffer.from(afterText, 'utf8'))
  const expectedSha = before.exists ? before.sha256 : ''
  const firstRun = !before.exists || !rows.some((r) => r.kind === 'same')
  const preserved = summarizePreserved(beforeText || '')
  const blocked = []
  const conflicts = []
  const warnings = merged.warnings.slice()
  for (const sec of preserved.reservedOverrides) {
    blocked.push({
      code: 'reserved_provider_override',
      message: '检测到 [' + sec + ']：Codex 把 openai 视为 reserved built-in provider ID，该段会让客户端启动失败。本产品不删改它；请先在 Codex 配置里移除该段，再回到本页接入。',
    })
  }
  for (const row of rows) {
    if (row.kind !== 'replace') continue
    conflicts.push({ path: row.path, from: row.from, to: row.to, reason: 'overwrite' })
  }
  if (preserved.sections.some((n) => n === 'model_providers.modelgate')) {
    warnings.push('检测到 [model_providers.modelgate]（可能来自早期原型）：本产品使用内置 openai 身份，不写入该段，原样保留。')
  }
  const catalog = catalogSummary(opts.catalogPath, opts.model, opts)
  if (!String(opts.catalogPath || '').trim()) blocked.push({ code: 'catalog_path_required', message: '必须先由网关生成聚合模型目录（model_catalog_json 绝对路径），否则客户端会回落到不完整目录。' })
  else if (!catalog.ok && catalog.state !== 'missing_file') warnings.push('目录当前不可用（' + catalog.state + '）：' + catalog.reason)
  const consentRequired = blocked.length === 0 && (firstRun || conflicts.length > 0)
  return {
    contract: DESKTOP_CONTRACT,
    ok: blocked.length === 0,
    state: blocked.length ? 'blocked' : (rows.every((r) => r.kind === 'same') ? 'already_aggregated' : 'ready'),
    mode: classifyConfigState({ configPath: paths.configPath, baseUrl: gatewayBaseUrl }).mode,
    configPath: paths.configPath,
    before: { exists: before.exists, size: before.size, sha256: before.sha256, mtimeMs: before.mtimeMs },
    expectedSha,
    after: { exists: true, size: Buffer.byteLength(afterText, 'utf8'), sha256: afterSha },
    desired,
    rows,
    changed: merged.changed,
    conflicts,
    blocked,
    warnings,
    preserved,
    consentRequired,
    consentToken: blocked.length ? null : consentTokenFor(paths.configPath, expectedSha, afterSha),
    firstRun: !before.exists,
    alreadyAggregated: rows.every((r) => r.kind === 'same'),
    catalog,
  }
}

// —— 验证 ——
async function defaultGatewayProbe (baseUrl) {
  const startedAt = Date.now()
  try {
    const res = await fetch(String(baseUrl).replace(/\/+$/, '') + '/healthz', { signal: AbortSignal.timeout(2000) })
    return { ok: res.ok, status: res.status, checkedAt: startedAt, ms: Date.now() - startedAt }
  } catch (e) {
    return { ok: false, status: 0, checkedAt: startedAt, ms: Date.now() - startedAt, error: e && e.message ? e.message : 'unreachable' }
  }
}

async function verifyAll (opts, paths, desired, expectedAfterSha) {
  const gatewayBaseUrl = String(opts.baseUrl || DEFAULT_GATEWAY_BASE_URL).replace(/\/+$/, '')
  const verification = { ok: false, config: null, catalog: null, gateway: null, needsRestart: true, verifiedAt: Date.now() }
  // 1) 配置解析校验：owned 字段逐字段相等 + 未管理的行逐字节一致。
  const text = readFileSync(paths.configPath, 'utf8')
  const owned = readOwnedFields(text)
  const mismatches = []
  for (const [key, value] of Object.entries(desired.topLevel || {})) {
    const want = renderTomlValue(value)
    const got = owned.topLevel[key] && owned.topLevel[key].present ? owned.topLevel[key].raw : null
    if (got !== want) mismatches.push({ path: key, expected: want, actual: got })
  }
  for (const [name, keys] of Object.entries(desired.sections || {})) {
    for (const [key, value] of Object.entries(keys)) {
      const want = renderTomlValue(value)
      const entry = owned.sections[name] && owned.sections[name].keys[key]
      const got = entry && entry.present ? entry.raw : null
      if (got !== want) mismatches.push({ path: name + '.' + key, expected: want, actual: got })
    }
  }
  const snap = snapshotConfigFile(paths.configPath)
  if (mismatches.length || snap.sha256 !== expectedAfterSha) {
    verification.config = { ok: false, sha256: snap.sha256, mismatches }
    throw new DesktopError('config_verify_failed', '写入后的 config.toml 未通过字段校验。', { verification }, 502)
  }
  verification.config = { ok: true, sha256: snap.sha256, size: snap.size, owned: Object.keys(desired.topLevel || {}) }

  // 2) 目录校验：存在、可解析、包含目标模型、未超上限。
  const catalog = catalogSummary(opts.catalogPath, opts.model, opts)
  if (!catalog.ok) {
    verification.catalog = catalog
    const code = catalog.state === 'overflow' ? 'catalog_overflow' : 'catalog_verify_failed'
    throw new DesktopError(code, '聚合目录未通过验证：' + catalog.reason, { catalog }, catalog.state === 'overflow' ? 413 : 502)
  }
  verification.catalog = catalog

  // 3) 网关健康：写盘后必须真实可达，不能"写完就报成功"。
  const probe = typeof opts.verifyGateway === 'function'
    ? await opts.verifyGateway({ baseUrl: gatewayBaseUrl, configPath: paths.configPath })
    : await defaultGatewayProbe(gatewayBaseUrl)
  if (!probe || probe.ok !== true) {
    verification.gateway = probe || { ok: false, status: 0 }
    throw new DesktopError('gateway_unreachable', '网关健康检查未通过：配置已写入但网关不可达，客户端接入不会生效。', { verification }, 502)
  }
  verification.gateway = probe
  verification.ok = true
  return verification
}

// —— 激活 ——
export async function activate (opts = {}) {
  const paths = resolveDesktopPaths(opts)
  const gatewayBaseUrl = String(opts.baseUrl || DEFAULT_GATEWAY_BASE_URL).replace(/\/+$/, '')
  let lock
  try {
    lock = acquireDesktopLock({ configPath: paths.configPath, now: opts.now, staleMs: opts.staleMs })
  } catch (e) {
    throw asDesktopError(e, 'lock_failed')
  }
  try {
    const recovery = recoverInterruptedApply({ configPath: paths.configPath })
    const before = snapshotConfigFile(paths.configPath)
    const beforeText = before.exists ? readFileSync(paths.configPath, 'utf8') : ''
    if (opts.expectedSha !== undefined && opts.expectedSha !== null && String(opts.expectedSha) !== String(before.exists ? before.sha256 : '')) {
      throw new DesktopError('concurrent_modification', '预览后 config.toml 已被修改（sha256 不一致），本次接入已中止，请重新预览。', {
        expected: String(opts.expectedSha), actual: before.exists ? before.sha256 : null,
      }, 409)
    }
    let desired
    try {
      desired = buildDesired({ baseUrl: gatewayBaseUrl, model: opts.model, catalogPath: opts.catalogPath, features: opts.features })
    } catch (e) { throw asDesktopError(e, 'invalid_desired') }
    let merged
    try {
      merged = mergeOwnedFields(beforeText, desired)
    } catch (e) { throw asDesktopError(e, 'config_unsupported') }
    const preserved = summarizePreserved(beforeText)
    if (preserved.reservedOverrides.length) {
      throw new DesktopError('reserved_provider_override',
        '检测到 [' + preserved.reservedOverrides.join('], [') + ']：reserved built-in provider ID 会让 Codex 启动失败；本产品不删改它，请先手工移除。',
        { sections: preserved.reservedOverrides }, 422)
    }
    const afterText = merged.text
    const afterSha = sha256Hex(Buffer.from(afterText, 'utf8'))
    const noChange = merged.changed.length === 0 && before.exists
    if (!noChange) {
      const wantToken = consentTokenFor(paths.configPath, before.exists ? before.sha256 : '', afterSha)
      if (!opts.consentToken || String(opts.consentToken) !== wantToken) {
        throw new DesktopError('consent_required', '写入前必须显式确认：请先调用预览并把 consentToken 与 expectedSha 一起回传。', {
          expectedSha: before.exists ? before.sha256 : '', afterSha, consentTokenHint: wantToken,
        }, 428)
      }
    }
    const stateBefore = {
      exists: before.exists,
      sha256: before.exists ? before.sha256 : '',
      size: before.size,
      mtimeMs: before.mtimeMs,
    }
    if (noChange) {
      const verification = await verifyAll(Object.assign({}, opts, { baseUrl: gatewayBaseUrl }), paths, desired, afterSha)
      // 幂等：保留第一次接入时记录的 before/backup，绝不用"聚合后的文件"覆盖回滚基线。
      const previous = loadState(paths)
      const keepBaseline = previous && previous.mode === 'aggregated' && previous.before
      saveState(paths, {
        mode: 'aggregated',
        before: keepBaseline ? previous.before : stateBefore,
        applied: { sha256: afterSha, size: Buffer.byteLength(afterText, 'utf8') },
        appliedSha: afterSha,
        beforeSha: keepBaseline ? previous.beforeSha : stateBefore.sha256,
        backupPath: keepBaseline ? previous.backupPath || null : null,
        desired,
        appliedAt: keepBaseline && previous.appliedAt ? previous.appliedAt : Date.now(),
        lastApply: { ok: true, idempotent: true, at: Date.now(), verification: summarizeVerification(verification) },
      })
      return { ok: true, changed: false, idempotent: true, sha: afterSha, backupPath: keepBaseline ? previous.backupPath || null : null, verification, recovery, mode: 'aggregated' }
    }
    const journalBase = {
      schema: JOURNAL_SCHEMA,
      phase: 'applying',
      at: Date.now(),
      pid: process.pid,
      before: stateBefore,
      applied: { sha256: afterSha, size: Buffer.byteLength(afterText, 'utf8') },
      backupPath: null,
      desired,
    }
    writeAtomicJson(paths.journalPath, journalBase, 0o600)
    let committed
    try {
      committed = commitConfigPlan({
        target: paths.configPath,
        before,
        beforeText,
        after: { exists: true, size: Buffer.byteLength(afterText, 'utf8'), sha256: afterSha },
        afterText,
        changed: merged.changed,
        warnings: merged.warnings,
        preserved: merged.preserved,
        createdSections: merged.createdSections,
      })
    } catch (e) {
      // commitConfigPlan 自身在写后校验失败时会尝试恢复；这里统一给出可诊断错误。
      const restored = restoreIfOurs(paths, Object.assign({}, journalBase, { backupPath: null }))
      try { unlinkSync(paths.journalPath) } catch {}
      throw new DesktopError('apply_failed', e && e.message ? e.message : '写入失败', { restored: restored.ok }, 500)
    }
    journalBase.backupPath = committed.backupPath || null
    writeAtomicJson(paths.journalPath, journalBase, 0o600)
    if (typeof opts.hooks?.afterWrite === 'function') await opts.hooks.afterWrite({ configPath: paths.configPath, afterSha })
    let verification
    try {
      verification = await verifyAll(Object.assign({}, opts, { baseUrl: gatewayBaseUrl }), paths, desired, afterSha)
    } catch (error) {
      const failure = asDesktopError(error, 'verification_failed')
      const restored = restoreIfOurs(paths, journalBase)
      try { unlinkSync(paths.journalPath) } catch {}
      saveState(paths, {
        mode: restored.ok ? 'official' : 'unknown',
        before: stateBefore,
        applied: null,
        appliedSha: null,
        beforeSha: stateBefore.sha256,
        backupPath: journalBase.backupPath,
        desired: null,
        appliedAt: null,
        lastApply: { ok: false, code: failure.code, at: Date.now(), restored: restored.ok, restoredSha: restored.sha || null },
      })
      throw new DesktopError(failure.code, failure.message, Object.assign({}, failure.detail || {}, {
        restored: restored.ok,
        restoredSha: restored.sha || null,
        restoreDetail: restored.detail || null,
      }), failure.status)
    }
    // 先落"已验证"再落状态：两者之间崩溃由 recoverInterruptedApply 补齐，不会重复写盘。
    journalBase.phase = 'verified'
    journalBase.lastApply = { ok: true, idempotent: false, at: Date.now(), verification: summarizeVerification(verification) }
    writeAtomicJson(paths.journalPath, journalBase, 0o600)
    saveState(paths, {
      mode: 'aggregated',
      before: stateBefore,
      applied: { sha256: afterSha, size: Buffer.byteLength(afterText, 'utf8') },
      appliedSha: afterSha,
      beforeSha: stateBefore.sha256,
      backupPath: journalBase.backupPath,
      desired,
      appliedAt: Date.now(),
      lastApply: { ok: true, at: Date.now(), verification: summarizeVerification(verification) },
    })
    try { unlinkSync(paths.journalPath) } catch {}
    return {
      ok: true,
      changed: true,
      idempotent: false,
      sha: afterSha,
      backupPath: journalBase.backupPath,
      verification,
      recovery,
      mode: 'aggregated',
    }
  } finally {
    lock.release()
  }
}

function summarizeVerification (v) {
  return {
    ok: v.ok,
    configSha: v.config ? v.config.sha256 : null,
    modelCount: v.catalog ? v.catalog.modelCount : null,
    catalogState: v.catalog ? v.catalog.state : null,
    gatewayStatus: v.gateway ? v.gateway.status : null,
  }
}

// —— 退出聚合（只回滚我们改过的字节）——
function redactDiffRows (rows) {
  return rows.map((row) => {
    const m = /^(\s*)([A-Za-z0-9_.-]+)\s*=\s*([\s\S]*)$/.exec(String(row.text || ''))
    if (m && SENSITIVE_FIELD_RE.test(m[2])) {
      return Object.assign({}, row, { text: m[1] + m[2] + ' = <redacted>', redacted: true })
    }
    return Object.assign({}, row, { redacted: false })
  })
}

export function threeWayDiff (baseText, oursText, theirsText) {
  return {
    contract: DESKTOP_CONTRACT + '/three-way',
    base: { sha256: sha256Hex(String(baseText || '')), size: Buffer.byteLength(String(baseText || ''), 'utf8') },
    ours: { sha256: sha256Hex(String(oursText || '')), size: Buffer.byteLength(String(oursText || ''), 'utf8') },
    theirs: { sha256: sha256Hex(String(theirsText || '')), size: Buffer.byteLength(String(theirsText || ''), 'utf8') },
    oursVsTheirs: redactDiffRows(diffConfigText(oursText, theirsText)).slice(0, 400),
    baseVsTheirs: redactDiffRows(diffConfigText(baseText, theirsText)).slice(0, 400),
    guidance: '保持现状，不覆盖你的修改。确认三方差异后，可先手工合并，再重新预览接入或退出。',
  }
}

export async function deactivate (opts = {}) {
  const paths = resolveDesktopPaths(opts)
  let lock
  try {
    lock = acquireDesktopLock({ configPath: paths.configPath, now: opts.now, staleMs: opts.staleMs })
  } catch (e) {
    throw asDesktopError(e, 'lock_failed')
  }
  try {
    const recovery = recoverInterruptedApply({ configPath: paths.configPath })
    const state = loadState(paths)
    if (!state || state.mode !== 'aggregated' || !state.before) {
      throw new DesktopError('not_aggregated', '当前不是由 ModelGate 管理的聚合配置，没有可回滚的备份。', { mode: state ? state.mode : null }, 409)
    }
    const current = snapshotConfigFile(paths.configPath)
    const currentSha = current.exists ? current.sha256 : ''
    const baseText = state.before.exists ? readBackupText(state, paths) : ''
    const desired = state.desired || {}
    let oursText = baseText
    try { oursText = mergeOwnedFields(baseText, desired).text } catch { oursText = null }
    const conflictDetail = () => {
      const theirsText = current.exists ? readFileSync(paths.configPath, 'utf8') : ''
      return {
        threeWay: threeWayDiff(baseText, oursText == null ? theirsText : oursText, theirsText),
        appliedSha: state.appliedSha || null,
        currentSha: currentSha || null,
      }
    }
    if (opts.expectedSha !== undefined && opts.expectedSha !== null && String(opts.expectedSha) !== String(currentSha)) {
      throw new DesktopError('concurrent_modification', '退出前检测到配置已被修改（sha256 与页面看到的不一致），未做任何写入。', Object.assign({ expected: String(opts.expectedSha), actual: currentSha || null }, conflictDetail()), 409)
    }
    if (currentSha !== state.appliedSha || !oursText) {
      throw new DesktopError('concurrent_modification', '配置在接入后被用户或其他程序修改过。为不覆盖你的改动，已中止退出；请在界面查看三方差异后手工处理。', conflictDetail(), 409)
    }
    let result
    if (!state.before.exists) {
      try { unlinkSync(paths.configPath) } catch (e) {
        throw new DesktopError('restore_failed', '删除接入时新建的 config.toml 失败：' + (e && e.message ? e.message : '未知错误'), null, 500)
      }
      result = { sha: '', restoredFrom: null, removed: true }
    } else {
      if (!state.backupPath || !existsSync(state.backupPath)) {
        throw new DesktopError('backup_missing', '备份文件不存在，无法无损回滚；为安全起见未做任何写入。', { backupPath: state.backupPath || null }, 409)
      }
      const backupSha = sha256Hex(readFileSync(state.backupPath))
      if (state.beforeSha && backupSha !== state.beforeSha) {
        throw new DesktopError('backup_mismatch', '备份内容与接入前快照不一致（备份被替换或损坏），未做任何写入。', { expected: state.beforeSha, actual: backupSha }, 409)
      }
      const plan = planRollback({ path: paths.configPath, backupPath: state.backupPath })
      const committed = commitConfigRollback(plan)
      if (state.beforeSha && committed.after.sha256 !== state.beforeSha) {
        throw new DesktopError('restore_verify_failed', '回滚后 sha256 与接入前快照不一致；原状态已保存在 ' + committed.safetyBackupPath, { sha: committed.after.sha256 }, 502)
      }
      result = { sha: committed.after.sha256, restoredFrom: committed.restoredFrom, safetyBackupPath: committed.safetyBackupPath, removed: false }
    }
    saveState(paths, {
      mode: 'official',
      before: state.before,
      applied: null,
      appliedSha: null,
      beforeSha: state.beforeSha || null,
      backupPath: state.backupPath || null,
      desired: null,
      appliedAt: null,
      lastApply: { ok: true, action: 'deactivate', at: Date.now(), restoredSha: result.sha },
    })
    return { ok: true, mode: 'official', sha: result.sha, restoredFrom: result.restoredFrom, removed: result.removed, verification: { ok: true, sha: result.sha }, recovery }
  } finally {
    lock.release()
  }
}

function readBackupText (state, paths) {
  if (!state.backupPath) throw new DesktopError('backup_missing', '缺少接入前备份，无法计算三方差异。', null, 409)
  try {
    const text = readFileSync(state.backupPath, 'utf8')
    if (state.before && state.before.sha256 && sha256Hex(text) !== state.before.sha256) {
      throw new DesktopError('backup_mismatch', '备份内容与接入前快照不一致。', null, 409)
    }
    return text
  } catch (e) {
    if (e instanceof DesktopError) throw e
    throw new DesktopError('backup_missing', '读取接入前备份失败：' + (e && e.message ? e.message : '未知错误'), null, 409)
  }
}

// —— 状态 ——
export function status (opts = {}) {
  const paths = resolveDesktopPaths(opts)
  const state = loadState(paths)
  let recovery = { recovered: 'none' }
  const lock = readLock(paths.lockPath, Date.now())
  if (!lock.present) {
    try {
      const held = acquireDesktopLock({ configPath: paths.configPath })
      try { recovery = recoverInterruptedApply({ configPath: paths.configPath }) } finally { held.release() }
    } catch { recovery = { recovered: 'skipped', reason: 'lock_busy' } }
  }
  const current = snapshotConfigFile(paths.configPath)
  const classification = classifyConfigState({ configPath: paths.configPath, baseUrl: opts.baseUrl })
  const fresh = loadState(paths)
  return {
    contract: DESKTOP_CONTRACT,
    ok: true,
    mode: classification.mode,
    reason: classification.reason,
    configPath: paths.configPath,
    config: { exists: current.exists, sha256: current.exists ? current.sha256 : '', size: current.size, mtimeMs: current.mtimeMs },
    backup: backupSummary(paths, fresh, current),
    lastApply: fresh && fresh.lastApply ? fresh.lastApply : null,
    appliedAt: fresh ? fresh.appliedAt || null : null,
    lock: { present: readLock(paths.lockPath, Date.now()).present },
    journal: { present: !!journalPhase(paths) },
    recovery,
    needsRestart: classification.mode === 'aggregated',
  }
}

// 供 HTTP 适配层一次性构造：五个导出之外的内部契约（不改变冻结签名）。
export const DESKTOP_POLICY = Object.freeze({
  contract: DESKTOP_CONTRACT,
  ownedTopLevel: OWNED_TOP_LEVEL.slice(),
  ownedSections: Object.fromEntries(Object.entries(OWNED_SECTIONS).map(([k, v]) => [k, v.slice()])),
  reservedOverrideSections: RESERVED_OVERRIDE_SECTIONS.slice(),
  maxCatalogBytes: MAX_CATALOG_BYTES,
  verification: ['config-parse-owned-fields', 'catalog-present-and-parseable', 'gateway-health'],
  forbidden: ['auth.json', 'model_providers.openai', 'default_subagent_model（不在所有权声明内）'],
})
