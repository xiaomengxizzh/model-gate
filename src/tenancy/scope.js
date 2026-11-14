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

import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
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
      const current = await usage()
      const next = {
        requests: current.requests + (Number(delta.requests) || 0),
        tokens: current.tokens + (Number(delta.tokens) || 0),
        errors: current.errors + (Number(delta.errors) || 0),
      }
      await writeJsonPrivate(entryPath(scope, SCOPE_KINDS.USAGE, 'usage.json'), next)
      return Object.freeze(next)
    }

    async function logLine(entry) {
      const line = Object.assign({ at: new Date().toISOString(), scopeId }, sanitizeLogEntry(entry))
      const path = entryPath(scope, SCOPE_KINDS.LOGS, 'events.jsonl')
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await appendFile(path, JSON.stringify(line) + '\n', { mode: 0o600 })
      return line
    }
    async function readLogs() {
      let text = ''
      try { text = await readFile(entryPath(scope, SCOPE_KINDS.LOGS, 'events.jsonl'), 'utf8') } catch { return [] }
      return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
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
