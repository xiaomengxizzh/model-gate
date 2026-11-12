// Codex 管理面（E6）：/api/codex/* 的纯处理器。
//
// 设计约束：
//  * 不读 req/res、不自己发响应：handleCodexApi(ctx) 返回 { status, body }，由 index.js 的
//    sendJson 落盘；唯一例外是 ctx.res.headersSent 已经被注入的鉴权函数占用时返回 null。
//  * 鉴权：只认显式管理员（ctx.explicitAdmin===true 或 ctx.requireExplicitAdmin()===true）。
//    旧 requireAdmin 的“实例未设置 adminToken ⇒ true”语义已删除，不再作为放行依据。
//  * 来源：只放行本机（loopback）；ctx.isLocal / ctx.remoteAddress / ctx.req.socket.remoteAddress
//    任一可用即可判定；显式 ctx.allowRemote === true 才放宽（默认严格）。
//  * 文件选择：只接受服务端登记后的不透明 root/backup id；调用方路径与原始 TOML 一律拒绝。
//  * 写入：plan（白名单字段差异+脱敏）→ confirmToken（绑定管理员/root/代际/操作/TTL）→ apply；
//    apply/rollback 在普通产品模式（ctx.managedRoot!==true 或根 mode=readonly）一律 403 disabled。
//  * 审计：只记 action / root / 受控字段名 / 结果码，绝不记文件内容、路径、令牌或 hash。
import { statSync } from 'node:fs'
import { basename, isAbsolute, normalize, sep } from 'node:path'
import {
  CONFIG_CONTRACT,
  ConfigError,
  applyConfigForRoot,
  describeConfigPolicy,
  exportOwnedFieldsForRoot,
  normalizeOwnedValue,
  planConfigForRoot,
  planRollbackForRoot,
  redactValue,
  rollbackConfigForRoot,
  SENSITIVE_FIELD_RE,
  sha256Hex,
} from './config.js'

export const CODEX_API_CONTRACT = 'mg-codex-api/1'
// N03：管理 API 版本化。请求可用 x-mg-api-version 声明；不支持则 400（绝不按旧形状猜）。
export const CODEX_API_VERSION = 'mg-management/1'
export const CODEX_API_VERSIONS = Object.freeze([CODEX_API_VERSION])
export const CODEX_ROUTE_KIND = Object.freeze({ MANAGEMENT: 'management', READONLY: 'readonly' })
export const MAX_DIFF_ROWS = 400
const API_VERSION_HEADER = 'x-mg-api-version'

// 统一错误信封的稳定 nextAction（管理 CLI/控制台据此给操作建议）。
const NEXT_ACTIONS = Object.freeze({
  admin_auth_required: 'set-admin-token-and-send-x-mg-admin',
  explicit_admin_required: 'set-admin-token-and-send-x-mg-admin',
  remote_forbidden: 'use-loopback-or-explicit-allow-remote',
  unsupported_api_version: 'upgrade-client-or-pin-supported-api-version',
  plan_id_required: 'run-config-plan-first',
  plan_id_mismatch: 'rerun-config-plan',
  confirmation_required: 'rerun-config-plan',
  confirmation_expired: 'rerun-config-plan',
  concurrent_modification: 're-plan-on-latest-generation',
  unmanaged_conflict: 'manual-review-preserved-lines',
  write_disabled: 'enable-managed-root-explicitly',
  root_changed: 're-plan-after-root-change',
})

// 版本协商：只认已发布版本；未声明按当前版本处理（向后兼容），声明了但未知即拒绝。
export function negotiateApiVersion (ctx = {}) {
  const headerValue = (ctx && ctx.apiVersion != null)
    ? ctx.apiVersion
    : (ctx && ctx.req && ctx.req.headers ? ctx.req.headers[API_VERSION_HEADER] : undefined)
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue
  const version = raw == null || String(raw).trim() === '' ? CODEX_API_VERSION : String(raw).trim()
  if (!CODEX_API_VERSIONS.includes(version)) {
    return {
      ok: false,
      version,
      response: {
        status: 400,
        body: errorBody('unsupported_api_version', '不支持的管理 API 版本：' + version + '（支持：' + CODEX_API_VERSIONS.join(', ') + '）'),
      },
    }
  }
  return { ok: true, version }
}

// 调用方是否显式声明了管理 API 版本（mg-management/1 契约）。未声明的旧调用方保留
// confirmToken-only 兼容语义（deprecated），但一旦声明版本，写操作必须绑定 planId。
export function apiVersionDeclared (ctx = {}) {
  const v = ctx && ctx.apiVersion != null
    ? ctx.apiVersion
    : (ctx && ctx.req && ctx.req.headers ? ctx.req.headers[API_VERSION_HEADER] : undefined)
  const raw = Array.isArray(v) ? v[0] : v
  return raw != null && String(raw).trim() !== ''
}

// 写操作绑定 planId：由 confirmToken 单向派生（不引入新 secret，不可逆，不能跨 plan 复用）。
export function planIdFor (confirmToken) {
  const token = String(confirmToken == null ? '' : confirmToken)
  if (!token) return null
  return 'pl_' + sha256Hex('mg-management-plan:' + token).slice(0, 24)
}
const MAX_SLUG_LIMIT = 200
const DEFAULT_SLUG_LIMIT = 50

// 每个路由都要求显式管理员（explicitAdmin）；"未设置 adminToken 即放行" 的旧语义已删除。
// write=true 的路由还要求 ctx.managedRoot === true 且登记根 mode=managed（普通产品模式 403 disabled）。
export const CODEX_API_ROUTES = Object.freeze([
  { method: 'GET', path: '/api/codex/policy', name: 'policy', kind: CODEX_ROUTE_KIND.READONLY, write: false, explicitAdmin: true, desc: '字段所有权 + 目录摘要 + 路由清单' },
  { method: 'POST', path: '/api/codex/config/plan', name: 'config_plan', kind: CODEX_ROUTE_KIND.READONLY, write: false, explicitAdmin: true, desc: '只读预览：白名单字段差异/脱敏值/planId+confirmToken，绝不写盘' },
  { method: 'POST', path: '/api/codex/config/apply', name: 'config_apply', kind: CODEX_ROUTE_KIND.MANAGEMENT, write: true, explicitAdmin: true, desc: '受控写入：二次快照 + 原子写 + 备份 + 写后校验（仅 managed，必须回传 planId）' },
  { method: 'POST', path: '/api/codex/config/rollback', name: 'config_rollback', kind: CODEX_ROUTE_KIND.MANAGEMENT, write: true, explicitAdmin: true, desc: '按不透明 backupId 回滚（仅 managed，必须回传 planId），回滚前状态另存' },
  { method: 'GET', path: '/api/codex/config/export', name: 'config_export', kind: CODEX_ROUTE_KIND.READONLY, write: false, explicitAdmin: true, desc: '只回所拥有字段的归一化投影（无保留行/无凭据）' },
  { method: 'GET', path: '/api/codex/catalog/status', name: 'catalog_status', kind: CODEX_ROUTE_KIND.READONLY, write: false, explicitAdmin: true, desc: '目录世代/计数/slugs 摘要（截断，不回全量目录）' },
])

export const EXPLICIT_ADMIN_OPERATIONS = Object.freeze(CODEX_API_ROUTES.map((r) => r.name))

// 入口侧（M4-1b）与测试共用：该操作是否必须已通过显式管理员认证。
export function requiresExplicitAdmin (operation) {
  return EXPLICIT_ADMIN_OPERATIONS.includes(String(operation || ''))
}

// index.js 一行挂载用：path 是否属于 Codex 管理面。
export function isCodexApiPath (path) {
  const p = String(path || '').split('?')[0]
  return p === '/api/codex' || p.startsWith('/api/codex/')
}

// ConfigError.code → HTTP 状态。写入类失败一律 5xx，绝不回显文件内容。
const STATUS_BY_CODE = Object.freeze({
  invalid_path: 400,
  path_not_allowed: 400,
  raw_content_not_allowed: 400,
  invalid_root_id: 400,
  invalid_root_mode: 400,
  invalid_backup_id: 400,
  invalid_operation: 400,
  invalid_confirmation_binding: 400,
  admin_subject_required: 403,
  explicit_admin_required: 403,
  write_disabled: 403,
  unknown_config_root: 404,
  backup_scope_mismatch: 403,
  root_changed: 409,
  root_unavailable: 404,
  confirmation_expired: 400,
  confirmation_binding_mismatch: 409,
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
  const key = String(code == null ? '' : code)
  const base = { ok: false, error: message, code: key, apiVersion: CODEX_API_VERSION }
  if (NEXT_ACTIONS[key]) base.nextAction = NEXT_ACTIONS[key]
  return Object.assign(base, extra || {})
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

// 显式管理员（P0-2）：只认 ctx.explicitAdmin === true 或受控 ctx.requireExplicitAdmin() === true。
// 旧 ctx.requireAdmin 的 “实例未设置 adminToken ⇒ true” 不再能作为放行依据；它仍可被调用以
// 让入口侧写自己的 401 响应，但本模块不会因为它的返回值为 true 而放行。
async function authorize (ctx) {
  let explicit = !!(ctx && ctx.explicitAdmin === true)
  if (!explicit && ctx && typeof ctx.requireExplicitAdmin === 'function') {
    try { explicit = (await ctx.requireExplicitAdmin(ctx)) === true } catch { explicit = false }
  }
  if (!explicit && ctx && typeof ctx.requireAdmin === 'function') {
    try { await ctx.requireAdmin(ctx) } catch {}
  }
  if (!explicit) {
    if (ctx && ctx.res && ctx.res.headersSent) return { ok: false, sent: true }
    return {
      ok: false,
      response: {
        status: 403,
        body: errorBody('explicit_admin_required', 'Codex 管理接口要求显式管理员会话：未设置/未验证管理令牌时一律拒绝（旧“无 token 即放行”语义已移除）'),
      },
    }
  }
  const locality = resolveLocality(ctx)
  if (!locality.local) {
    return { ok: false, response: { status: 403, body: errorBody('remote_forbidden', '拒绝非本机来源的 Codex 管理请求：该接口只在 127.0.0.1/::1 上可用') } }
  }
  const adminSubject = String((ctx && (ctx.adminSubject || ctx.adminPrincipal)) || '').trim()
  return { ok: true, locality, adminSubject }
}

// —— P0-2 请求形状护栏：只接受不透明 root/backup id，绝不接受调用方路径或原始 TOML ——
const CALLER_PATH_FIELDS = Object.freeze(['path', 'file', 'filePath', 'backupPath'])
const CALLER_RAW_FIELDS = Object.freeze(['toml', 'content', 'rawToml', 'rawContent', 'document'])

function rejectCallerPathOrRaw (body) {
  if (!body || typeof body !== 'object') return null
  for (const key of CALLER_PATH_FIELDS) {
    if (body[key] !== undefined && body[key] !== null) {
      return { status: 400, body: errorBody('path_not_allowed', '管理面只接受服务端登记后的不透明 root id；调用方提供的路径一律拒绝（' + key + '）') }
    }
  }
  for (const key of CALLER_RAW_FIELDS) {
    if (body[key] !== undefined && body[key] !== null) {
      return { status: 400, body: errorBody('raw_content_not_allowed', '管理面不接受原始 TOML/文件内容；只接受白名单字段声明（desired）') }
    }
  }
  return null
}

function rootIdOf (body) {
  if (!body || typeof body.root !== 'string' || !body.root.trim()) return ''
  const id = body.root.trim()
  if (id.includes('/') || id.includes('\\') || id.includes('..')) return ''
  return id
}

function requireManagedContext (ctx) {
  if (ctx && ctx.managedRoot === true) return null
  return { status: 403, body: errorBody('write_disabled', '普通产品模式下 apply/rollback 关闭；只有受控自管 fixture（ctx.managedRoot=true 且登记根 mode=managed）才启用') }
}

function normalizeChangedValue (field, raw) {
  let text = String(raw === undefined || raw === null ? '' : raw).trim()
  const leaf = String(field || '').split('.').pop()
  const eq = text.indexOf('=')
  if (eq > 0 && text.slice(0, eq).trim() === leaf) text = text.slice(eq + 1).trim()
  const value = normalizeOwnedValue({ present: true, raw: text })
  return redactValue(field, value)
}

function sanitizeChanged (changed) {
  return (Array.isArray(changed) ? changed : []).slice(0, MAX_DIFF_ROWS).map((c) => {
    const field = String(c && c.path ? c.path : '')
    const from = c && c.from !== undefined && c.from !== null ? normalizeChangedValue(field, c.from) : null
    const to = c && c.to !== undefined && c.to !== null ? normalizeChangedValue(field, c.to) : null
    return { field, from, to, redacted: SENSITIVE_FIELD_RE.test(field), owner: 'modelgate' }
  })
}

function sanitizeWarnings (warnings) {
  return (Array.isArray(warnings) ? warnings : []).slice(0, 20).map((w) => String(w).slice(0, 300))
}

function preservedSummary (preserved) {
  const p = preserved || {}
  return {
    topLevelKeyCount: Array.isArray(p.topLevelKeys) ? p.topLevelKeys.length : 0,
    sectionCount: Array.isArray(p.sections) ? p.sections.length : 0,
    mcpServerNames: (Array.isArray(p.mcpServers) ? p.mcpServers : []).slice(0, 20),
    hasProjects: p.hasProjects === true,
    hasPermissions: p.hasPermissions === true,
    reservedOverrides: (Array.isArray(p.reservedOverrides) ? p.reservedOverrides : []).slice(0, 10),
  }
}

function audit (ctx, action, info = {}) {
  const log = ctx && ctx.log
  if (!log) return
  const parts = ['audit', 'codex', action]
  if (info.root) parts.push('root=' + info.root)
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
  return Object.assign({ ok: true, contract: CODEX_API_CONTRACT, configContract: CONFIG_CONTRACT, apiVersion: CODEX_API_VERSION }, obj)
}

function requireObject (body, label) {
  if (!isPlainObject(body)) return { ok: false, status: 400, body: errorBody('invalid_body', label + ' 必须是 JSON 对象') }
  return { ok: true, body }
}

// —— 各端点 ——
function handlePolicy (ctx, query, auth) {
  const catalog = summarizeCodexCatalog(ctx.cfg, { limit: query.limit })
  const locality = resolveLocality(ctx)
  const managed = ctx.managedRoot === true
  return {
    status: 200,
    body: okBody({
      policy: describeConfigPolicy(),
      catalog,
      write: {
        available: managed,
        applyEnabled: managed,
        rollbackEnabled: managed,
        plan: '/api/codex/config/plan',
        apply: '/api/codex/config/apply',
        rollback: '/api/codex/config/rollback',
        export: '/api/codex/config/export',
        requiresExplicitAdmin: true,
        requiresManagedRoot: true,
        requiresConfirmToken: true,
        requiresExpectedSnapshot: true,
        rootIdRequired: true,
        neverWritesAuthJson: true,
        restartsClient: false,
      },
      auth: { explicitAdminRequired: true, adminSubjectBound: !!(auth && auth.adminSubject), localOnly: !(ctx.allowRemote === true), localitySource: locality.source },
      paths: {
        rootIdRequired: true,
        opaqueRootIdsOnly: true,
        callerPathsRejected: true,
        rawTomlRejected: true,
        requiredBasenameAtRegistration: 'config.toml',
        forbidden: ['auth.json', 'sessions/**'],
      },
      apiVersion: CODEX_API_VERSION,
      apiVersions: CODEX_API_VERSIONS.slice(),
      routes: CODEX_API_ROUTES.map((r) => ({ method: r.method, path: r.path, name: r.name, kind: r.kind, write: r.write, explicitAdmin: r.explicitAdmin === true, requiresPlanId: r.write === true, desc: r.desc })),
      audit: { fields: ['action', 'root', 'fields', 'result'], storesContent: false, storesTokens: false },
      ui: { probePath: '/api/codex/policy', exportOnlyFallback: true },
    }),
  }
}

function handleConfigPlan (ctx, body, auth) {
  const shaped = requireObject(body, '请求体')
  if (!shaped.ok) return shaped
  const rejected = rejectCallerPathOrRaw(shaped.body)
  if (rejected) return rejected
  const rootId = rootIdOf(shaped.body)
  if (!rootId) return { status: 400, body: errorBody('invalid_root_id', '必须提供 root：服务端登记后的不透明 id（不接受路径/原始 TOML）') }
  if (!isPlainObject(shaped.body.desired)) return { status: 400, body: errorBody('invalid_body', 'desired 必须是对象：{ topLevel, sections? }') }
  if (!auth.adminSubject) return { status: 403, body: errorBody('admin_subject_required', 'plan 必须绑定显式管理员身份（adminSubject）') }
  try {
    const plan = planConfigForRoot({
      rootId,
      adminSubject: auth.adminSubject,
      desired: shaped.body.desired,
      expected: shaped.body.expected,
      allowCreate: shaped.body.allowCreate === true,
      now: ctx.now,
      ttlMs: ctx.confirmationTtlMs,
    })
    audit(ctx, 'config_plan', { root: rootId, fields: (plan.changed || []).map((c) => c.path), result: 'ok' })
    return {
      status: 200,
      body: okBody({
        root: rootId,
        generation: plan.generation,
        before: { exists: plan.before.exists, size: plan.before.size, sha256: plan.before.sha256, mtimeMs: plan.before.mtimeMs },
        after: { size: plan.after.size, sha256: plan.after.sha256 },
        existing: plan.existing,
        changed: sanitizeChanged(plan.changed),
        redactedDiff: sanitizeChanged(plan.changed),
        warnings: sanitizeWarnings(plan.warnings),
        preserved: preservedSummary(plan.preserved),
        createdSections: plan.createdSections,
        // N03：写操作绑定 planId（由 confirmToken 单向派生）；confirmToken 仍是唯一确认凭据。
        planId: planIdFor(plan.confirmToken),
        confirmToken: plan.confirmToken,
        expiresAt: plan.expiresAt,
        requiresConfirmation: true,
        wrote: false,
      }),
    }
  } catch (e) {
    if (e instanceof ConfigError) {
      audit(ctx, 'config_plan', { root: rootId, result: e.code })
      return configErrorResponse(e)
    }
    throw e
  }
}

function handleConfigApply (ctx, body, auth) {
  const shaped = requireObject(body, '请求体')
  if (!shaped.ok) return shaped
  const rejected = rejectCallerPathOrRaw(shaped.body)
  if (rejected) return rejected
  const rootId = rootIdOf(shaped.body)
  if (!rootId) return { status: 400, body: errorBody('invalid_root_id', '必须提供 root：服务端登记后的不透明 id（不接受路径/原始 TOML）') }
  const notManaged = requireManagedContext(ctx)
  if (notManaged) return notManaged
  if (!isPlainObject(shaped.body.desired)) return { status: 400, body: errorBody('invalid_body', 'desired 必须是对象：{ topLevel, sections? }') }
  if (!isPlainObject(shaped.body.expected)) {
    return { status: 400, body: errorBody('snapshot_required', '必须提供 expected 快照 { exists, size, sha256, mtimeMs }（先调用 /config/plan）') }
  }
  if (typeof shaped.body.confirmToken !== 'string' || !shaped.body.confirmToken.trim()) {
    return { status: 400, body: errorBody('confirmation_required', '必须提供 plan 返回的 confirmToken；缺令牌的写入一律拒绝') }
  }
  // N03：写操作绑定 planId —— 缺 planId 400；planId 与 confirmToken 不属于同一 plan → 409。
  const planId = typeof shaped.body.planId === 'string' ? shaped.body.planId.trim() : ''
  if (apiVersionDeclared(ctx)) {
    if (!planId) return { status: 400, body: errorBody('plan_id_required', 'mg-management/1 的 apply 必须回传 /config/plan 的 planId；写操作一律绑定 plan') }
  }
  if (planId && planId !== planIdFor(shaped.body.confirmToken)) {
    return { status: 409, body: errorBody('plan_id_mismatch', 'planId 与 confirmToken 不属于同一 plan（可能已重新 plan），拒绝写入') }
  }
  if (!auth.adminSubject) return { status: 403, body: errorBody('admin_subject_required', 'apply 必须绑定显式管理员身份（adminSubject）') }
  try {
    const result = applyConfigForRoot({
      rootId,
      adminSubject: auth.adminSubject,
      desired: shaped.body.desired,
      expected: shaped.body.expected,
      confirmToken: shaped.body.confirmToken,
      allowCreate: shaped.body.allowCreate === true,
      now: ctx.now,
    })
    let rollback = null
    if (result.backupId) {
      try {
        const rp = planRollbackForRoot({ rootId, adminSubject: auth.adminSubject, backupId: result.backupId, now: ctx.now, ttlMs: ctx.confirmationTtlMs })
        rollback = { backupId: rp.backupId, planId: planIdFor(rp.confirmToken), confirmToken: rp.confirmToken, expiresAt: rp.expiresAt, expectedSha256: rp.expectedSha256 }
      } catch { rollback = null }
    }
    audit(ctx, 'config_apply', { root: rootId, fields: (result.changed || []).map((c) => c.path), result: 'ok' })
    return {
      status: 200,
      body: okBody({
        root: rootId,
        generation: result.generation,
        before: { exists: result.before.exists, size: result.before.size, sha256: result.before.sha256 },
        after: { size: result.after.size, sha256: result.after.sha256 },
        changed: sanitizeChanged(result.changed),
        warnings: sanitizeWarnings(result.warnings),
        preserved: preservedSummary(result.preserved),
        createdSections: result.createdSections,
        backupId: result.backupId,
        rollback,
        restartsClient: false,
        wrote: true,
      }),
    }
  } catch (e) {
    if (e instanceof ConfigError) {
      audit(ctx, 'config_apply', { root: rootId, result: e.code })
      return configErrorResponse(e)
    }
    throw e
  }
}

function handleConfigRollback (ctx, body, auth) {
  const shaped = requireObject(body, '请求体')
  if (!shaped.ok) return shaped
  const rejected = rejectCallerPathOrRaw(shaped.body)
  if (rejected) return rejected
  const rootId = rootIdOf(shaped.body)
  if (!rootId) return { status: 400, body: errorBody('invalid_root_id', '必须提供 root：服务端登记后的不透明 id') }
  const notManaged = requireManagedContext(ctx)
  if (notManaged) return notManaged
  if (typeof shaped.body.backupId !== 'string' || !shaped.body.backupId.trim()) {
    return { status: 400, body: errorBody('invalid_backup_id', '必须提供 apply 返回的不透明 backupId（不接受路径）') }
  }
  if (typeof shaped.body.expectedSha256 !== 'string' || !shaped.body.expectedSha256.trim()) {
    return { status: 400, body: errorBody('snapshot_required', '必须提供 expectedSha256（当前文件 sha256），回滚不做盲写') }
  }
  if (typeof shaped.body.confirmToken !== 'string' || !shaped.body.confirmToken.trim()) {
    return { status: 400, body: errorBody('confirmation_required', '必须提供 planRollback 派生出的 confirmToken；缺令牌的回滚一律拒绝') }
  }
  const rollbackPlanId = typeof shaped.body.planId === 'string' ? shaped.body.planId.trim() : ''
  if (apiVersionDeclared(ctx)) {
    if (!rollbackPlanId) return { status: 400, body: errorBody('plan_id_required', 'mg-management/1 的 rollback 必须回传 apply 返回的 rollback.planId；回滚一律绑定 plan') }
  }
  if (rollbackPlanId && rollbackPlanId !== planIdFor(shaped.body.confirmToken)) {
    return { status: 409, body: errorBody('plan_id_mismatch', 'planId 与 rollback confirmToken 不属于同一 plan，拒绝回滚') }
  }
  if (!auth.adminSubject) return { status: 403, body: errorBody('admin_subject_required', 'rollback 必须绑定显式管理员身份（adminSubject）') }
  try {
    const result = rollbackConfigForRoot({
      rootId,
      adminSubject: auth.adminSubject,
      backupId: shaped.body.backupId,
      expectedSha256: shaped.body.expectedSha256,
      confirmToken: shaped.body.confirmToken,
      now: ctx.now,
    })
    audit(ctx, 'config_rollback', { root: rootId, result: 'ok' })
    return {
      status: 200,
      body: okBody({
        root: rootId,
        backupId: result.backupId,
        safetyBackupId: result.safetyBackupId,
        before: { sha256: result.before.sha256 },
        after: { sha256: result.after.sha256, size: result.after.size },
        restartsClient: false,
        wrote: true,
      }),
    }
  } catch (e) {
    if (e instanceof ConfigError) {
      audit(ctx, 'config_rollback', { root: rootId, result: e.code })
      return configErrorResponse(e)
    }
    throw e
  }
}

// export：只回“声明所有权”字段的归一化投影；不读/不返回保留行原文。
function handleConfigExport (ctx, query, auth) {
  const rootId = rootIdOf({ root: query.root })
  if (!rootId) return { status: 400, body: errorBody('invalid_root_id', '必须提供 root：服务端登记后的不透明 id') }
  try {
    const out = exportOwnedFieldsForRoot({ rootId })
    audit(ctx, 'config_export', { root: rootId, result: 'ok' })
    return {
      status: 200,
      body: okBody({
        root: rootId,
        generation: out.generation,
        exists: out.exists,
        owned: out.owned,
        readOnly: true,
        fullFileReturned: false,
        retainedLinesReturned: false,
      }),
    }
  } catch (e) {
    if (e instanceof ConfigError) {
      audit(ctx, 'config_export', { root: rootId, result: e.code })
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

  // 1) 授权先于任何 body 读取（readBody 只在鉴权+版本+路由校验通过后调用）。
  const auth = await authorize(ctx)
  if (!auth.ok) return auth.sent ? null : auth.response
  // 2) 版本协商同样先于 body：不支持的客户端形状直接拒绝，绝不按旧形状猜。
  const version = negotiateApiVersion(ctx)
  if (!version.ok) return version.response

  const route = CODEX_API_ROUTES.find((r) => r.path === path)
  if (!route) {
    audit(ctx, 'unknown', { path, result: 'not_found' })
    return { status: 404, body: errorBody('unknown_endpoint', '未知的 Codex 管理接口：' + path) }
  }
  if (route.method !== method) {
    audit(ctx, route.name, { path, result: 'method_not_allowed' })
    return { status: 405, body: errorBody('method_not_allowed', '该接口只支持 ' + route.method) }
  }

  if (route.name === 'policy') return handlePolicy(ctx, query, auth)
  if (route.name === 'catalog_status') return handleCatalogStatus(ctx, query)
  // export 走 GET query，无请求体；鉴权先于任何文件读取。
  if (route.name === 'config_export') return handleConfigExport(ctx, query, auth)

  const body = readBody(ctx)
  if (body === undefined) return { status: 400, body: errorBody('invalid_body', '请求体必须是合法 JSON 对象') }
  if (route.name === 'config_plan') return handleConfigPlan(ctx, body, auth)
  if (route.name === 'config_apply') return handleConfigApply(ctx, body, auth)
  if (route.name === 'config_rollback') return handleConfigRollback(ctx, body, auth)
  return { status: 404, body: errorBody('unknown_endpoint', '未知的 Codex 管理接口：' + path) }
}
