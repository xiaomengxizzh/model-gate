// Codex 管理面（E6）：/api/codex/* 的纯处理器。
//
// 设计约束：
//  * 不读 req/res、不自己发响应：handleCodexApi(ctx) 返回 { status, body }，由 index.js 的
//    sendJson 落盘；唯一例外是 ctx.res.headersSent 已经被注入的鉴权函数占用时返回 null。
//  * 鉴权：ctx.requireAdmin（由 index.js 注入）返回 true/false；本模块自己写 401/403 响应体。
//  * 来源：只放行本机（loopback）；ctx.isLocal / ctx.remoteAddress / ctx.req.socket.remoteAddress
//    任一可用即可判定；显式 ctx.allowRemote === true 才放宽（默认严格）。
//  * 写入：只经 src/codex/config.js 的 plan → confirmToken → apply/rollback 链；
//    路径必须是绝对路径且 basename=config.toml；拒 auth.json / sessions / 符号链接。
//  * 审计：只记 action / path / 受控字段名 / 结果码，绝不记文件内容或令牌。
import { statSync } from 'node:fs'
import { basename, isAbsolute, normalize, sep } from 'node:path'
import {
  CONFIG_CONTRACT,
  ConfigError,
  applyConfigChange,
  describeConfigPolicy,
  planConfigApply,
  planRollback,
  rollbackConfigChange,
  sha256Hex,
} from './config.js'

export const CODEX_API_CONTRACT = 'mg-codex-api/1'
export const MAX_DIFF_ROWS = 400
const MAX_SLUG_LIMIT = 200
const DEFAULT_SLUG_LIMIT = 50

export const CODEX_API_ROUTES = Object.freeze([
  { method: 'GET', path: '/api/codex/policy', name: 'policy', write: false, desc: '字段所有权 + 目录摘要 + 路由清单' },
  { method: 'POST', path: '/api/codex/config/plan', name: 'config_plan', write: false, desc: '只读预览：diff/所有权/confirmToken，绝不写盘' },
  { method: 'POST', path: '/api/codex/config/apply', name: 'config_apply', write: true, desc: '受控写入：二次快照 + 原子写 + 备份 + 写后校验' },
  { method: 'POST', path: '/api/codex/config/rollback', name: 'config_rollback', write: true, desc: '用 .bak 回滚，并把回滚前状态另存' },
  { method: 'GET', path: '/api/codex/catalog/status', name: 'catalog_status', write: false, desc: '目录世代/计数/slugs 摘要（截断，不回全量目录）' },
])

// index.js 一行挂载用：path 是否属于 Codex 管理面。
export function isCodexApiPath (path) {
  const p = String(path || '').split('?')[0]
  return p === '/api/codex' || p.startsWith('/api/codex/')
}

// ConfigError.code → HTTP 状态。写入类失败一律 5xx，绝不回显文件内容。
const STATUS_BY_CODE = Object.freeze({
  invalid_path: 400,
  invalid_desired: 400,
  not_owned_field: 400,
  unsupported_value: 400,
  multiline_value: 400,
  duplicate_key: 400,
  duplicate_section: 400,
  unsupported_layout: 400,
  snapshot_required: 400,
  confirmation_required: 400,
  not_a_file: 400,
  forbidden_path: 403,
  symlink_refused: 403,
  config_not_found: 404,
  backup_not_found: 404,
  unmanaged_conflict: 409,
  concurrent_modification: 409,
  too_large: 413,
  stat_failed: 500,
  backup_failed: 500,
  write_failed: 500,
  verify_failed: 500,
})

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost'])

function statusFor (code) {
  return STATUS_BY_CODE[code] || 500
}

function errorBody (code, message, extra) {
  return Object.assign({ ok: false, error: message, code }, extra || {})
}

function isPlainObject (v) {
  return !!v && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v)
}

function tryJson (text) {
  try { return JSON.parse(text) } catch { return undefined }
}

function readQuery (ctx, pathWithQuery) {
  if (ctx && isPlainObject(ctx.query)) return ctx.query
  const raw = (ctx && typeof ctx.query === 'string')
    ? ctx.query
    : (String(pathWithQuery || '').includes('?') ? String(pathWithQuery).slice(String(pathWithQuery).indexOf('?') + 1) : '')
  const out = {}
  if (!raw) return out
  for (const pair of raw.replace(/^\?/, '').split('&')) {
    if (!pair) continue
    const i = pair.indexOf('=')
    const k = decodeURIComponent((i < 0 ? pair : pair.slice(0, i)).replace(/\+/g, ' '))
    const v = i < 0 ? '' : decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' '))
    out[k] = v
  }
  return out
}

function readBody (ctx) {
  if (!ctx) return undefined
  if (ctx.body !== undefined && ctx.body !== null) return typeof ctx.body === 'string' ? tryJson(ctx.body) : ctx.body
  const raw = ctx.rawBody !== undefined ? ctx.rawBody : ctx.bodyBuffer
  if (raw == null) return undefined
  if (Buffer.isBuffer(raw)) return tryJson(raw.toString('utf8'))
  if (typeof raw === 'string') return tryJson(raw)
  return undefined
}

function remoteAddressOf (ctx) {
  if (!ctx) return ''
  const direct = ctx.remoteAddress || ctx.socketRemoteAddress
  if (direct) return String(direct)
  const req = ctx.req
  if (req && req.socket && req.socket.remoteAddress) return String(req.socket.remoteAddress)
  if (ctx.socket && ctx.socket.remoteAddress) return String(ctx.socket.remoteAddress)
  return ''
}

// 本机来源判定：显式 isLocal 优先；否则用 remoteAddress；拿不到地址时按本机处理
// （管理令牌仍然强制，见 authorize），并在 policy 里如实标注判定依据。
export function resolveLocality (ctx = {}) {
  if (ctx.isLocal === true) return { local: true, source: 'ctx.isLocal' }
  if (ctx.isLocal === false) return { local: false, source: 'ctx.isLocal' }
  if (ctx.allowRemote === true) return { local: true, source: 'allowRemote' }
  const addr = remoteAddressOf(ctx)
  if (!addr) return { local: true, source: 'unknown-address' }
  const clean = addr.replace(/^::ffff:/i, '').replace(/%.*$/, '')
  return { local: LOOPBACK.has(clean) || LOOPBACK.has(addr), source: 'remoteAddress', address: addr }
}

async function authorize (ctx) {
  if (typeof ctx.requireAdmin === 'function') {
    let ok
    try {
      ok = await ctx.requireAdmin(ctx)
    } catch {
      ok = false
    }
    if (!ok) {
      // 注入的鉴权函数可能已经写过响应（index.js 现有 requireAdmin 就是这种），
      // 这时返回 null，避免二次写头。
      if (ctx.res && ctx.res.headersSent) return { ok: false, sent: true }
      return { ok: false, response: { status: 401, body: errorBody('unauthorized', '未授权：Codex 管理接口需要管理令牌（MG_ADMIN_TOKEN / server.adminToken）') } }
    }
  } else if (ctx.isAdmin !== true) {
    return { ok: false, response: { status: 401, body: errorBody('unauthorized', '未授权：未注入 requireAdmin 且未声明 isAdmin，拒绝访问（fail closed）') } }
  }
  const locality = resolveLocality(ctx)
  if (!locality.local) {
    return { ok: false, response: { status: 403, body: errorBody('remote_forbidden', '拒绝非本机来源的 Codex 管理请求：该接口只在 127.0.0.1/::1 上可用') } }
  }
  return { ok: true, locality }
}

function audit (ctx, action, info = {}) {
  const log = ctx && ctx.log
  if (!log) return
  const parts = ['audit', 'codex', action]
  if (info.path) parts.push('path=' + info.path)
  if (info.fields && info.fields.length) parts.push('fields=' + info.fields.slice(0, 20).join(','))
  parts.push('result=' + (info.result || 'ok'))
  const line = parts.join(' ')
  try {
    if (typeof log.info === 'function') log.info(line)
    else if (typeof log.audit === 'function') log.audit(line)
  } catch {}
}

// —— 路径护栏（config.js 会再校验一次；这里是显式拒绝语义 + 稳定错误码）——
export function validateCodexConfigPath (rawPath) {
  const raw = typeof rawPath === 'string' ? rawPath.trim() : ''
  if (!raw) return { ok: false, status: 400, code: 'invalid_path', message: '必须提供显式的 config.toml 绝对路径（服务端不读 HOME、不猜默认值）' }
  if (/[\u0000-\u001f]/.test(raw)) return { ok: false, status: 400, code: 'invalid_path', message: '路径包含控制字符，已拒绝' }
  if (!isAbsolute(raw)) return { ok: false, status: 400, code: 'invalid_path', message: '必须使用绝对路径' }
  const name = basename(raw)
  if (name.toLowerCase() === 'auth.json') return { ok: false, status: 403, code: 'forbidden_path', message: 'auth.json 永不读写：官方凭据文件不属于管理面职责' }
  if (name !== 'config.toml') return { ok: false, status: 400, code: 'invalid_path', message: '目标文件名必须是 config.toml（收到 ' + name + '）' }
  const normalized = normalize(raw)
  const segments = normalized.split(sep)
  if (segments.includes('..')) return { ok: false, status: 400, code: 'invalid_path', message: '路径包含 .. 段，已拒绝' }
  if (segments.some((s) => s.toLowerCase() === 'sessions')) return { ok: false, status: 403, code: 'forbidden_path', message: '拒绝 Codex sessions 目录下的路径' }
  if (raw !== normalized) return { ok: false, status: 400, code: 'invalid_path', message: '请提供规范化后的绝对路径' }
  return { ok: true, path: normalized }
}

// —— 目录摘要：只回计数/世代/截断后的 slug，绝不回 700KB 全量目录 ——
function clampLimit (value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SLUG_LIMIT
  return Math.min(MAX_SLUG_LIMIT, Math.floor(n))
}

export function summarizeCodexCatalog (cfg, opts = {}) {
  const limit = clampLimit(opts.limit)
  const defaults = (cfg && cfg.defaults) || {}
  const basePath = typeof defaults.codexCatalogBasePath === 'string' ? defaults.codexCatalogBasePath : ''
  const view = cfg && isPlainObject(cfg._codexCatalog) ? cfg._codexCatalog : null
  const out = {
    contract: 'modelgate.codex-catalog/1',
    source: 'cfg._codexCatalog',
    available: !!view,
    basePathConfigured: !!basePath,
    basePathName: basePath ? basename(basePath) : null,
    limit,
  }
  if (!view) {
    out.reason = basePath ? 'catalog_unavailable' : 'not_configured'
    out.generation = null
    out.stale = null
    out.counts = null
    out.officialSlugs = []
    out.thirdParty = []
    return out
  }
  const bindings = isPlainObject(view.bindings) ? view.bindings : {}
  const models = Array.isArray(view.models) ? view.models : []
  const officialSlugs = Array.isArray(view.officialSlugs) ? view.officialSlugs.filter((s) => typeof s === 'string') : []
  const thirdPartySlugs = Object.keys(bindings)
  out.generation = sha256Hex(String(view.key || '')).slice(0, 12)
  out.counts = { official: officialSlugs.length, thirdParty: thirdPartySlugs.length, total: models.length }
  out.officialSlugCount = officialSlugs.length
  out.officialSlugs = officialSlugs.slice(0, limit)
  out.officialSlugsTruncated = officialSlugs.length > limit
  out.thirdPartySlugCount = thirdPartySlugs.length
  out.thirdParty = thirdPartySlugs.slice(0, limit).map((slug) => {
    const b = bindings[slug] || {}
    return {
      slug,
      provider: typeof b.provider === 'string' ? b.provider : null,
      model: typeof b.model === 'string' ? b.model : null,
      capability: typeof b.capability === 'string' ? b.capability : null,
    }
  })
  out.thirdPartyTruncated = thirdPartySlugs.length > limit
  out.stale = detectStale(view, basePath)
  return out
}

// index.js 的 view.key = basePath + '|' + mtimeMs + '|' + size + '|' + modelsKey：
// 用它和当前文件 stat 对比，给出诚实的 stale 判定（拿不到就 null，不编造）。
function detectStale (view, basePath) {
  const key = typeof view.key === 'string' ? view.key : ''
  if (!key) return null
  const parts = key.split('|')
  if (parts.length < 4) return null
  if (basePath && parts[0] !== basePath) return null
  const mtime = Number(parts[1])
  const size = Number(parts[2])
  if (!Number.isFinite(mtime) || !Number.isFinite(size)) return null
  try {
    const st = statSync(parts[0])
    return !(Math.abs(Number(st.mtimeMs) - mtime) < 1 && Number(st.size) === size)
  } catch {
    return null
  }
}

function capDiff (diff) {
  const rows = Array.isArray(diff) ? diff : []
  if (rows.length <= MAX_DIFF_ROWS) return { diff: rows, diffTruncated: false, diffTotal: rows.length }
  return { diff: rows.slice(0, MAX_DIFF_ROWS), diffTruncated: true, diffTotal: rows.length }
}

function configErrorResponse (e) {
  const code = e && e.code ? String(e.code) : 'internal_error'
  const message = e && e.message ? String(e.message) : 'Codex 配置操作失败'
  return { status: statusFor(code), body: errorBody(code, message) }
}

function okBody (obj) {
  return Object.assign({ ok: true, contract: CODEX_API_CONTRACT, configContract: CONFIG_CONTRACT }, obj)
}

function requireObject (body, label) {
  if (!isPlainObject(body)) return { ok: false, status: 400, body: errorBody('invalid_body', label + ' 必须是 JSON 对象') }
  return { ok: true, body }
}

// —— 各端点 ——
function handlePolicy (ctx, query) {
  const catalog = summarizeCodexCatalog(ctx.cfg, { limit: query.limit })
  const locality = resolveLocality(ctx)
  return {
    status: 200,
    body: okBody({
      policy: describeConfigPolicy(),
      catalog,
      write: {
        available: true,
        plan: '/api/codex/config/plan',
        apply: '/api/codex/config/apply',
        rollback: '/api/codex/config/rollback',
        requiresConfirmToken: true,
        requiresExpectedSnapshot: true,
        neverWritesAuthJson: true,
        restartsClient: false,
      },
      auth: { adminRequired: true, localOnly: !(ctx.allowRemote === true), localitySource: locality.source },
      paths: { requiredBasename: 'config.toml', absoluteOnly: true, forbidden: ['auth.json', 'sessions/**'] },
      routes: CODEX_API_ROUTES.map((r) => ({ method: r.method, path: r.path, write: r.write, desc: r.desc })),
      audit: { fields: ['action', 'path', 'fields', 'result'], storesContent: false },
      ui: { probePath: '/api/codex/policy', exportOnlyFallback: true },
    }),
  }
}

function handleConfigPlan (ctx, body) {
  const shaped = requireObject(body, '请求体')
  if (!shaped.ok) return shaped
  const pathCheck = validateCodexConfigPath(shaped.body.path)
  if (!pathCheck.ok) return { status: pathCheck.status, body: errorBody(pathCheck.code, pathCheck.message) }
  if (!isPlainObject(shaped.body.desired)) return { status: 400, body: errorBody('invalid_body', 'desired 必须是对象：{ topLevel, sections? }') }
  try {
    const plan = planConfigApply({
      path: pathCheck.path,
      desired: shaped.body.desired,
      allowCreate: shaped.body.allowCreate === true,
    })
    const merged = capDiff(plan.diff)
    audit(ctx, 'config_plan', { path: plan.path, fields: (plan.changed || []).map((c) => c.path), result: 'ok' })
    return {
      status: 200,
      body: okBody({
        path: plan.path,
        before: plan.before,
        after: plan.after,
        existing: plan.existing,
        changed: plan.changed,
        warnings: plan.warnings,
        preserved: plan.preserved,
        createdSections: plan.createdSections,
        diff: merged.diff,
        diffTruncated: merged.diffTruncated,
        diffTotal: merged.diffTotal,
        confirmToken: plan.confirmToken,
        backupPath: plan.backupPath,
        requiresConfirmation: true,
        wrote: false,
      }),
    }
  } catch (e) {
    if (e instanceof ConfigError) {
      audit(ctx, 'config_plan', { path: pathCheck.path, result: e.code })
      return configErrorResponse(e)
    }
    throw e
  }
}

function handleConfigApply (ctx, body) {
  const shaped = requireObject(body, '请求体')
  if (!shaped.ok) return shaped
  const pathCheck = validateCodexConfigPath(shaped.body.path)
  if (!pathCheck.ok) return { status: pathCheck.status, body: errorBody(pathCheck.code, pathCheck.message) }
  if (!isPlainObject(shaped.body.desired)) return { status: 400, body: errorBody('invalid_body', 'desired 必须是对象：{ topLevel, sections? }') }
  if (!isPlainObject(shaped.body.expected)) {
    return { status: 400, body: errorBody('snapshot_required', '必须提供 expected 快照 { exists, size, sha256 }（先调用 /config/plan）') }
  }
  if (typeof shaped.body.confirmToken !== 'string' || !shaped.body.confirmToken.trim()) {
    return { status: 400, body: errorBody('confirmation_required', '必须提供 plan 返回的 confirmToken；缺令牌的写入一律拒绝') }
  }
  try {
    const result = applyConfigChange({
      path: pathCheck.path,
      desired: shaped.body.desired,
      expected: shaped.body.expected,
      confirmToken: shaped.body.confirmToken,
      allowCreate: shaped.body.allowCreate === true,
    })
    let rollback = null
    if (result.backupPath) {
      try {
        const rp = planRollback({ path: result.path, backupPath: result.backupPath })
        rollback = { backupPath: rp.backupPath, expectedSha256: result.after.sha256, confirmToken: rp.confirmToken, restoreSha256: rp.restore.sha256 }
      } catch { rollback = null }
    }
    audit(ctx, 'config_apply', { path: result.path, fields: (result.changed || []).map((c) => c.path), result: 'ok' })
    return {
      status: 200,
      body: okBody({
        path: result.path,
        before: result.before,
        after: result.after,
        changed: result.changed,
        warnings: result.warnings,
        preserved: result.preserved,
        createdSections: result.createdSections,
        backupPath: result.backupPath,
        rollback,
        restartsClient: false,
        wrote: true,
      }),
    }
  } catch (e) {
    if (e instanceof ConfigError) {
      audit(ctx, 'config_apply', { path: pathCheck.path, result: e.code })
      return configErrorResponse(e)
    }
    throw e
  }
}

function handleConfigRollback (ctx, body) {
  const shaped = requireObject(body, '请求体')
  if (!shaped.ok) return shaped
  const pathCheck = validateCodexConfigPath(shaped.body.path)
  if (!pathCheck.ok) return { status: pathCheck.status, body: errorBody(pathCheck.code, pathCheck.message) }
  const backupPath = shaped.body.backupPath
  if (typeof backupPath !== 'string' || !isAbsolute(backupPath)) {
    return { status: 400, body: errorBody('invalid_path', '必须提供备份文件绝对路径（config.toml.bak）') }
  }
  const normalizedBackup = normalize(backupPath)
  if (!(normalizedBackup === pathCheck.path + '.bak' || normalizedBackup.startsWith(pathCheck.path + '.bak'))) {
    return { status: 400, body: errorBody('invalid_path', '备份路径必须位于 ' + pathCheck.path + '.bak* 名下，拒绝读取任意文件') }
  }
  if (typeof shaped.body.expectedSha256 !== 'string' || !shaped.body.expectedSha256.trim()) {
    return { status: 400, body: errorBody('snapshot_required', '必须提供 expectedSha256（当前文件 sha256），回滚不做盲写') }
  }
  if (typeof shaped.body.confirmToken !== 'string' || !shaped.body.confirmToken.trim()) {
    return { status: 400, body: errorBody('confirmation_required', '必须提供 planRollback 派生出的 confirmToken；缺令牌的回滚一律拒绝') }
  }
  try {
    const result = rollbackConfigChange({
      path: pathCheck.path,
      backupPath,
      expectedSha256: shaped.body.expectedSha256,
      confirmToken: shaped.body.confirmToken,
      allowCreate: shaped.body.allowCreate === true,
    })
    audit(ctx, 'config_rollback', { path: result.path, result: 'ok' })
    return {
      status: 200,
      body: okBody({
        path: result.path,
        restoredFrom: result.restoredFrom,
        safetyBackupPath: result.safetyBackupPath,
        before: result.before,
        after: result.after,
        restartsClient: false,
        wrote: true,
      }),
    }
  } catch (e) {
    if (e instanceof ConfigError) {
      audit(ctx, 'config_rollback', { path: pathCheck.path, result: e.code })
      return configErrorResponse(e)
    }
    throw e
  }
}

function handleCatalogStatus (ctx, query) {
  const catalog = summarizeCodexCatalog(ctx.cfg, { limit: query.limit })
  audit(ctx, 'catalog_status', { result: catalog.available ? 'ok' : (catalog.reason || 'unavailable') })
  return { status: 200, body: okBody({ catalog, readOnly: true, fullCatalogReturned: false }) }
}

/**
 * Codex 管理面统一入口。
 * @param {object} ctx { method, path, url?, query?, body?|rawBody?, cfg, state?, log?, requireAdmin?, isLocal?, remoteAddress?, req?, res?, allowRemote? }
 * @returns {Promise<{status:number, body:object}|null>} null = 响应已由注入的鉴权函数写过
 */
export async function handleCodexApi (ctx = {}) {
  const method = String(ctx.method || 'GET').toUpperCase()
  const rawPath = String(ctx.path || ctx.url || '/')
  const path = rawPath.split('?')[0]
  const query = readQuery(ctx, rawPath)

  const auth = await authorize(ctx)
  if (!auth.ok) return auth.sent ? null : auth.response

  const route = CODEX_API_ROUTES.find((r) => r.path === path)
  if (!route) {
    audit(ctx, 'unknown', { path, result: 'not_found' })
    return { status: 404, body: errorBody('unknown_endpoint', '未知的 Codex 管理接口：' + path) }
  }
  if (route.method !== method) {
    audit(ctx, route.name, { path, result: 'method_not_allowed' })
    return { status: 405, body: errorBody('method_not_allowed', '该接口只支持 ' + route.method) }
  }

  if (route.name === 'policy') return handlePolicy(ctx, query)
  if (route.name === 'catalog_status') return handleCatalogStatus(ctx, query)

  const body = readBody(ctx)
  if (body === undefined) return { status: 400, body: errorBody('invalid_body', '请求体必须是合法 JSON 对象') }
  if (route.name === 'config_plan') return handleConfigPlan(ctx, body)
  if (route.name === 'config_apply') return handleConfigApply(ctx, body)
  if (route.name === 'config_rollback') return handleConfigRollback(ctx, body)
  return { status: 404, body: errorBody('unknown_endpoint', '未知的 Codex 管理接口：' + path) }
}
