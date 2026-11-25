// AGG-P05：用户作用域（tenancy）与按作用域隔离的本地存储。**默认关闭**。
//
// 目标（MG-R009）：认证凭据、目录、额度与统计按用户隔离，跨作用域访问一律拒绝。
// 约束：本轮只提供可组合的底层原语，不接管现有路由；缺省（config.tenancy 缺失）时是
// 单用户模式，所有调用映射到唯一作用域 `local`，今日的单操作者行为不变。
//
// 存储边界：
//   root/<scopeId>/{config,keys,catalog,usage,logs}/   目录 0700，文件 0600
//   · 作用域目录只能由**已验证的 scope 对象**推导，调用方不能传任意 id 或路径。
//   · 凭据默认不落盘：必须由调用方注入 seal/unseal（复用既有 keys 存储的加密），
//     未注入即 `key_storage_unconfigured`，本层绝不写明文 secret。
//   · 日志与用量只接受结构化、已脱敏字段；请求正文/历史在默认路径上被丢弃（不上传、不落盘）。
//
// 本模块不联网、不读宿主凭据、不写用户真实 HOME。

import { constants } from 'node:fs'
import {
  lstat, mkdir, open, readFile, readdir, rename, writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

export const TENANCY_MODES = Object.freeze({ SINGLE: 'single', MULTI: 'multi' })
export const DEFAULT_SCOPE_ID = 'local'
export const SCOPE_KINDS = Object.freeze({
  CONFIG: 'config',
  KEYS: 'keys',
  CATALOG: 'catalog',
  USAGE: 'usage',
  LOGS: 'logs',
})
const KIND_VALUES = Object.freeze(Object.values(SCOPE_KINDS))
const SCOPE_ID_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/
const ENTRY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
// 内容类字段：默认既不转发也不落盘（「不上传请求正文/历史」的代码落点）。
const CONTENT_FIELDS = Object.freeze(['body', 'messages', 'input', 'history', 'prompt', 'content', 'output'])
const SECRET_FIELD_RE = /(token|secret|password|passwd|authorization|bearer|cookie|credential|api[_-]?key)/i
const REDACTED = '[redacted]'
const DEFAULT_LOG_MAX_BYTES = 1024 * 1024
const DEFAULT_LOG_MAX_RECORDS = 5000
const MAX_LOG_MAX_BYTES = 64 * 1024 * 1024
const MAX_LOG_MAX_RECORDS = 100000
const ENV_CREDENTIAL_FIELD_RE = /^api[_-]?key[_-]?env$/i
const NOFOLLOW = constants.O_NOFOLLOW || 0

export class TenancyError extends Error {
  constructor(code, message, options = {}) {
    super(message || code)
    this.name = 'TenancyError'
    this.code = String(code)
    this.status = Number.isFinite(options.status) ? options.status : 403
    this.deny = true
    if (options.scopeId) this.scopeId = String(options.scopeId)
  }
}

export function isTenancyError(err) {
  return !!(err && err.deny === true && typeof err.code === 'string' && err.name === 'TenancyError')
}

function deny(code, message, options) {
  return new TenancyError(code, message, options)
}

export function assertScopeId(scopeId) {
  const id = String(scopeId == null ? '' : scopeId).trim()
  if (!SCOPE_ID_RE.test(id)) throw deny('scope_id_invalid', '作用域 id 不合法', { status: 400 })
  return id
}

// config.tenancy 缺省 = 单用户（今日行为）；不认识的模式 fail-closed，不静默降级为 single。
export function resolveTenancy(config) {
  const raw = config && config.tenancy
  if (raw == null) {
    return Object.freeze({ mode: TENANCY_MODES.SINGLE, scopes: Object.freeze([DEFAULT_SCOPE_ID]), reason: 'default_single_user' })
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) throw deny('tenancy_config_invalid', 'tenancy 必须是对象')
  const mode = raw.mode == null ? TENANCY_MODES.SINGLE : String(raw.mode).trim().toLowerCase()
  if (mode !== TENANCY_MODES.SINGLE && mode !== TENANCY_MODES.MULTI) {
    throw deny('tenancy_mode_invalid', '未知 tenancy.mode：' + String(raw.mode))
  }
  if (mode === TENANCY_MODES.SINGLE) {
    return Object.freeze({ mode, scopes: Object.freeze([DEFAULT_SCOPE_ID]), reason: 'explicit_single_user' })
  }
  const list = Array.isArray(raw.scopes) ? raw.scopes : []
  const scopes = []
  for (const entry of list) {
    const id = assertScopeId(entry)
    if (scopes.includes(id)) throw deny('tenancy_scope_duplicate', '重复的作用域 id：' + id)
    scopes.push(id)
  }
  if (scopes.length === 0) throw deny('tenancy_scopes_missing', 'multi 模式必须显式列出 scopes')
  return Object.freeze({ mode, scopes: Object.freeze(scopes), reason: 'multi_user' })
}

function actorIdOf(actor) {
  if (!actor || typeof actor !== 'object') return ''
  for (const field of ['id', 'actorId', 'userId']) {
    if (typeof actor[field] === 'string' && actor[field].trim()) return actor[field].trim()
  }
  return ''
}

// actor -> 冻结的 scope。单用户模式下只有 `local`；请求别的作用域是 typed deny，不自动创建。
export function requireUserScope(actor, options = {}) {
  if (actor != null && (typeof actor !== 'object' || Array.isArray(actor))) {
    throw deny('actor_invalid', 'actor 必须是对象（或缺省）', { status: 400 })
  }
  const tenancy = options.tenancy || resolveTenancy(options.config)
  const requestedRaw = actor && actor.scopeId != null ? actor.scopeId : (actor && actor.scope != null ? actor.scope : null)
  const requested = requestedRaw == null ? '' : String(requestedRaw).trim()
  if (tenancy.mode === TENANCY_MODES.SINGLE) {
    if (requested !== '' && requested !== DEFAULT_SCOPE_ID) {
      throw deny('scope_not_available_in_single_user_mode', '单用户模式只允许作用域 ' + DEFAULT_SCOPE_ID + '（未启用多用户）')
    }
    return Object.freeze({ scopeId: DEFAULT_SCOPE_ID, mode: tenancy.mode, actorId: actorIdOf(actor) || DEFAULT_SCOPE_ID })
  }
  if (requested === '') throw deny('scope_required', '多用户模式必须显式提供作用域', { status: 400 })
  const id = assertScopeId(requested)
  if (!tenancy.scopes.includes(id)) throw deny('scope_unknown', '未授权的作用域：' + id, { scopeId: id })
  return Object.freeze({ scopeId: id, mode: tenancy.mode, actorId: actorIdOf(actor) || id })
}

function assertEntryName(name) {
  const n = String(name == null ? '' : name)
  if (!ENTRY_RE.test(n)) throw deny('entry_name_invalid', '作用域内文件名不合法', { status: 400 })
  return n
}

// Tenant credentials may only come from the scope's encrypted keys.local.json. Scan the
// entire merged config (not just providers): connection arrays and future nested resources
// must not be able to name a host process/user-registry variable. Values are never echoed.
export function assertTenantCredentialRefs(config) {
  const seen = new WeakSet()
  let visited = 0
  function visit(value, path, depth) {
    if (value == null || typeof value !== 'object') return
    if (depth > 32 || seen.has(value) || ++visited > 100000) {
      throw deny('tenant_config_invalid', '租户配置必须是有界且无循环的对象')
    }
    seen.add(value)
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) visit(value[i], path + '[' + i + ']', depth + 1)
    } else {
      for (const [key, child] of Object.entries(value)) {
        if (ENV_CREDENTIAL_FIELD_RE.test(key) && child != null && child !== '') {
          throw deny('tenant_env_credential_forbidden', '租户配置禁止环境变量凭据引用：' + path + '.' + key)
        }
        visit(child, path + '.' + key, depth + 1)
      }
    }
    seen.delete(value)
  }
  visit(config, 'config', 0)
  return config
}

function redactValue(key, value) {
  // 计数类数值（例如 tokens）不是凭据；只有字符串/对象才按敏感字段名脱敏。
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (SECRET_FIELD_RE.test(String(key))) return REDACTED
  if (value == null) return value
  if (typeof value === 'string') return value.length > 512 ? value.slice(0, 512) : value
  if (Array.isArray(value)) return value.length
  if (typeof value === 'object') return '[object]'
  return null
}

// 结构化日志行：丢弃正文/历史字段，敏感键按名脱敏，只保留可审计的标量与计数。
export function sanitizeLogEntry(entry) {
  const src = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {}
  const out = {}
  for (const [key, value] of Object.entries(src)) {
    const k = String(key)
    if (CONTENT_FIELDS.includes(k.toLowerCase())) continue
    out[k] = redactValue(k, value)
  }
  return out
}

function boundedLogLimit(value, fallback, max) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(1, Math.trunc(n))) : fallback
}

function logUnsafePath() {
  return deny('scope_log_unsafe_path', '租户日志路径必须是私有普通文件/目录，不能是符号链接', { status: 500 })
}

async function assertPrivateDir(path, create) {
  let st
  try { st = await lstat(path) } catch (error) {
    if (error && error.code === 'ENOENT' && create) {
      await mkdir(path, { mode: 0o700 })
      st = await lstat(path)
    } else if (error && error.code === 'ENOENT') return false
    else throw error
  }
  if (!st.isDirectory() || st.isSymbolicLink()) throw logUnsafePath()
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY || 0) | NOFOLLOW)
    const opened = await handle.stat()
    if (!opened.isDirectory()) throw logUnsafePath()
    await handle.chmod(0o700)
  } finally { if (handle) await handle.close() }
  return true
}

// Check every owned path component before creating the next one. A symlinked scope or
// logs directory must be rejected before any append/rename can touch its outside target.
async function ensureLogDir(base, path, create = true) {
  const relative = path.slice(base.length)
  let current = base
  if (!await assertPrivateDir(current, create)) return false
  for (const part of relative.split(sep).filter(Boolean)) {
    current = join(current, part)
    if (!await assertPrivateDir(current, create)) return false
  }
  return true
}

async function assertPrivateFile(path) {
  let st
  try { st = await lstat(path) } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
  if (!st.isFile() || st.isSymbolicLink()) throw logUnsafePath()
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | NOFOLLOW)
    const opened = await handle.stat()
    if (!opened.isFile()) throw logUnsafePath()
    await handle.chmod(0o600)
    return opened
  } finally { if (handle) await handle.close() }
}

async function readPrivateFile(path, maxBytes = MAX_LOG_MAX_BYTES) {
  if (!await assertPrivateFile(path)) return ''
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | NOFOLLOW)
    const st = await handle.stat()
    if (!st.isFile()) throw logUnsafePath()
    await handle.chmod(0o600)
    if (st.size <= maxBytes) return await handle.readFile({ encoding: 'utf8' })
    // Legacy files may predate rotation. Read only a bounded tail and discard a partial
    // first line rather than loading an unbounded log into memory.
    const start = st.size - maxBytes
    const buffer = Buffer.alloc(maxBytes)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, start)
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    const newline = text.indexOf('\n')
    return newline < 0 ? '' : text.slice(newline + 1)
  } finally { if (handle) await handle.close() }
}

async function syncDir(path) {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY || 0))
    await handle.sync()
  } catch { /* directory fsync is not available on every supported platform */ }
  finally { if (handle) await handle.close() }
}

async function writeJsonPrivate(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = path + '.' + process.pid + '.' + Date.now() + '.tmp'
  await writeFile(tmp, JSON.stringify(value), { mode: 0o600 })
  await rename(tmp, path)
}

async function readJsonOrNull(path) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return null }
}

export function createScopeStore(root, options = {}) {
  const base = resolve(String(root == null ? '' : root))
  if (!base || base === sep) throw deny('scope_root_invalid', '作用域根目录无效', { status: 400 })
  const tenancy = options.tenancy || resolveTenancy(options.config)
  const logMaxBytes = boundedLogLimit(options.logMaxBytes, DEFAULT_LOG_MAX_BYTES, MAX_LOG_MAX_BYTES)
  const logMaxRecords = boundedLogLimit(options.logMaxRecords, DEFAULT_LOG_MAX_RECORDS, MAX_LOG_MAX_RECORDS)
  // scope usage/log 的读改写必须串行；并发请求不能交叉轮转或互相覆盖。
  let usageWriteChain = Promise.resolve()
  const logWriteChains = new Map()
  const logStates = new Map()

  function scopeDir(scope) {
    const id = scope && typeof scope === 'object' ? assertScopeId(scope.scopeId) : ''
    if (!id) throw deny('scope_invalid', '需要 requireUserScope() 的产物', { status: 400 })
    if (!tenancy.scopes.includes(id)) throw deny('scope_unknown', '未授权的作用域：' + id, { scopeId: id })
    const dir = resolve(base, id)
    if (dir !== join(base, id) || !dir.startsWith(base + sep)) throw deny('scope_path_escape', '作用域路径越界', { scopeId: id })
    return dir
  }

  function entryPath(scope, kind, name) {
    if (!KIND_VALUES.includes(kind)) throw deny('scope_kind_invalid', '未知的作用域存储类别：' + String(kind), { status: 400 })
    return join(scopeDir(scope), kind, assertEntryName(name))
  }

  // 现有网关配置事务要求 config/keys 同目录、同代际提交。租户运行时从已验证的
  // scopeDir 派生这组路径；keys/stats/videos/logs 仍全部位于该 scope 自己的根下。
  function runtimePaths(scope) {
    const root = scopeDir(scope)
    const dir = join(root, SCOPE_KINDS.CONFIG)
    return Object.freeze({
      dir,
      local: join(dir, 'gateway.local.json'),
      keys: join(dir, 'keys.local.json'),
      stats: join(root, SCOPE_KINDS.USAGE, 'stats.json'),
      videos: join(root, SCOPE_KINDS.USAGE, 'videos.json'),
      logs: join(root, SCOPE_KINDS.LOGS, 'gateway.log'),
    })
  }

  async function ensure(scope) {
    for (const kind of KIND_VALUES) await mkdir(join(scopeDir(scope), kind), { recursive: true, mode: 0o700 })
  }

  function forScope(scope) {
    const dir = scopeDir(scope)
    const scopeId = scope.scopeId

    function readConfig(name = 'gateway.json') { return readJsonOrNull(entryPath(scope, SCOPE_KINDS.CONFIG, name)) }
    function writeConfig(name, value) { return writeJsonPrivate(entryPath(scope, SCOPE_KINDS.CONFIG, name), value) }
    function readCatalog(name = 'catalog.json') { return readJsonOrNull(entryPath(scope, SCOPE_KINDS.CATALOG, name)) }
    function writeCatalog(name, value) { return writeJsonPrivate(entryPath(scope, SCOPE_KINDS.CATALOG, name), value) }

    function keyPath(providerId) {
      return entryPath(scope, SCOPE_KINDS.KEYS, assertEntryName(providerId) + '.json')
    }
    // 凭据只在调用方提供 seal 时落盘（密文）；本层不实现加密，默认拒绝写 secret。
    async function writeKey(providerId, plaintext, opts = {}) {
      if (typeof opts.seal !== 'function') throw deny('key_storage_unconfigured', '未配置凭据封装函数：本层默认不写任何 secret')
      if (typeof plaintext !== 'string' || plaintext === '') throw deny('key_invalid', '凭据必须是非空字符串', { status: 400 })
      const sealed = await opts.seal(plaintext, { scopeId, providerId })
      if (typeof sealed !== 'string' || sealed === '' || sealed.includes(plaintext)) {
        throw deny('key_seal_invalid', '封装结果无效（不得包含明文）', { status: 500 })
      }
      await writeJsonPrivate(keyPath(providerId), { v: 1, providerId: String(providerId), sealed })
    }
    async function readKey(providerId, opts = {}) {
      const record = await readJsonOrNull(keyPath(providerId))
      if (!record || typeof record.sealed !== 'string') return null
      if (typeof opts.unseal !== 'function') throw deny('key_storage_unconfigured', '未配置凭据解封函数：拒绝返回密文当凭据')
      const plaintext = await opts.unseal(record.sealed, { scopeId, providerId })
      if (typeof plaintext !== 'string' || plaintext === '') throw deny('key_unseal_failed', '凭据解封失败', { status: 500 })
      return plaintext
    }
    async function hasKey(providerId) {
      const record = await readJsonOrNull(keyPath(providerId))
      return !!(record && typeof record.sealed === 'string')
    }

    async function usage() {
      const record = await readJsonOrNull(entryPath(scope, SCOPE_KINDS.USAGE, 'usage.json'))
      return Object.freeze({
        requests: Number(record && record.requests) || 0,
        tokens: Number(record && record.tokens) || 0,
        errors: Number(record && record.errors) || 0,
      })
    }
    async function recordUsage(delta = {}) {
      const run = usageWriteChain.then(async () => {
        const current = await usage()
        const next = {
          requests: current.requests + (Number(delta.requests) || 0),
          tokens: current.tokens + (Number(delta.tokens) || 0),
          errors: current.errors + (Number(delta.errors) || 0),
        }
        await writeJsonPrivate(entryPath(scope, SCOPE_KINDS.USAGE, 'usage.json'), next)
        return Object.freeze(next)
      })
      usageWriteChain = run.then(() => {}, () => {})
      return run
    }

    function logPaths() {
      const path = entryPath(scope, SCOPE_KINDS.LOGS, 'events.jsonl')
      return { path, archive: path + '.1', dir: dirname(path) }
    }

    async function loadLogState(paths) {
      const state = logStates.get(scopeId)
      if (state) return state
      const st = await assertPrivateFile(paths.path)
      const text = await readPrivateFile(paths.path, logMaxBytes)
      const next = { bytes: st ? st.size : 0, records: text.split('\n').filter(Boolean).length }
      logStates.set(scopeId, next)
      return next
    }

    async function appendLogLine(paths, text) {
      const current = await assertPrivateFile(paths.path)
      await assertPrivateFile(paths.archive)
      const state = await loadLogState(paths)
      const bytes = Buffer.byteLength(text)
      const records = text.split('\n').filter(Boolean).length
      if (bytes > logMaxBytes || records > logMaxRecords) {
        throw deny('log_record_too_large', '单条租户日志超过保留上限', { status: 500 })
      }
      if (current && (state.bytes + bytes > logMaxBytes || state.records + records > logMaxRecords)) {
        // rename is atomic and replaces the previous .1; there is never more than one
        // rotated segment. Check the destination first so a symlink is rejected, not followed.
        await rename(paths.path, paths.archive)
        await syncDir(paths.dir)
        state.bytes = 0
        state.records = 0
      }
      let handle
      try {
        handle = await open(paths.path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | NOFOLLOW, 0o600)
        const st = await handle.stat()
        if (!st.isFile()) throw logUnsafePath()
        await handle.chmod(0o600)
        await handle.writeFile(text, { encoding: 'utf8' })
        await handle.sync()
        state.bytes += bytes
        state.records += records
      } finally { if (handle) await handle.close() }
    }

    async function logLine(entry) {
      const line = Object.assign({ at: new Date().toISOString(), scopeId }, sanitizeLogEntry(entry))
      const text = JSON.stringify(line) + '\n'
      const paths = logPaths()
      const previous = logWriteChains.get(scopeId) || Promise.resolve()
      const run = previous.catch(() => {}).then(async () => {
        await ensureLogDir(base, paths.dir)
        await appendLogLine(paths, text)
      })
      logWriteChains.set(scopeId, run.catch(() => {}))
      await run
      return line
    }

    async function readLogs() {
      const paths = logPaths()
      const previous = logWriteChains.get(scopeId)
      if (previous) await previous
      if (!await ensureLogDir(base, paths.dir, false)) return []
      const segments = []
      for (const path of [paths.archive, paths.path]) {
        const text = await readPrivateFile(path, logMaxBytes)
        segments.push(...text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean))
      }
      return segments
    }

    // 对外描述：只有计数与文件名，没有凭据值、没有正文。
    async function describe() {
      const keyNames = []
      const names = await readKeyNames(scope)
      keyNames.push(...names)
      const u = await usage()
      return Object.freeze({
        scopeId,
        mode: scope.mode || tenancy.mode,
        keys: Object.freeze(keyNames),
        usage: u,
      })
    }

    return Object.freeze({
      scopeId,
      mode: scope.mode || tenancy.mode,
      dir,
      runtimePaths: () => runtimePaths(scope),
      flush: async () => {
        await usageWriteChain
        await logWriteChains.get(scopeId)
      },
      ensure: () => ensure(scope),
      readConfig,
      writeConfig,
      readCatalog,
      writeCatalog,
      writeKey,
      readKey,
      hasKey,
      usage,
      recordUsage,
      logLine,
      readLogs,
      describe,
    })
  }

  async function readKeyNames(scope) {
    try {
      const names = await readdir(join(scopeDir(scope), SCOPE_KINDS.KEYS))
      return names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).sort()
    } catch { return [] }
  }

  return Object.freeze({
    root: base,
    tenancy,
    forScope,
    ensureScope: (scope) => ensure(scope),
    listScopes: () => tenancy.scopes.slice(),
  })
}
