// A2 / P01：/api/aggregation/* 处理器（只实现 handler；**不接线** src/index.js）。
//
// ADR-0003 §5：
//   GET/POST /api/aggregation/providers
//   DELETE   /api/aggregation/providers/:id
//   POST     /api/aggregation/providers/:id/sync
//   GET      /api/aggregation/models
//   GET      /api/aggregation/health
//   GET      /api/aggregation/diagnostics
//   POST     /api/aggregation/activate
//   POST     /api/aggregation/deactivate
//
// 全部要求**显式管理员**（不因回环放行），并遵守 loopback peer / Host / Origin 与 `configVersion`
// 乐观锁。处理器返回 `{ status, body }`，由主代理用既有 sendJson 输出；本模块不写 res、不写日志。
//
// activate/deactivate 属于 A3 的 Desktop 集成范围；本模块只把请求转给注入的 activation 适配器，
// 未注入时返回 501 typed code，绝不假装已实现。

import { isIP } from 'node:net'
import { RegistryError } from './registry.js'
import { DiscoveryError } from './discovery.js'
import { AggregatedCatalogError } from './catalog.js'

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1'])
const AGGREGATION_BASE = '/api/aggregation'
export const AGGREGATION_ROUTES = Object.freeze([
  'GET /api/aggregation/providers',
  'POST /api/aggregation/providers',
  'DELETE /api/aggregation/providers/:id',
  'POST /api/aggregation/providers/:id/sync',
  'GET /api/aggregation/models',
  'GET /api/aggregation/health',
  'GET /api/aggregation/diagnostics',
  'POST /api/aggregation/activate',
  'POST /api/aggregation/deactivate',
])

const bareHost = (h) => String(h || '').trim().toLowerCase().replace(/^\[|\]$/g, '')

function header(req, name) {
  const h = req && req.headers ? req.headers : {}
  const v = h[name] != null ? h[name] : h[name.toLowerCase()]
  return Array.isArray(v) ? v[0] : v
}

function tokenOf(req) {
  const ah = String(header(req, 'authorization') || '')
  if (ah.slice(0, 7).toLowerCase() === 'bearer ') return ah.slice(7).trim()
  const x = header(req, 'x-mg-admin')
  return x == null ? '' : String(x).trim()
}

function safeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

function isLoopbackPeer(req) {
  const a = (req && req.socket && req.socket.remoteAddress) || ''
  return a === '::1' || a === '127.0.0.1' || a === '::ffff:127.0.0.1' || String(a).startsWith('::ffff:127.')
}

function hostAllowed(req, cfg) {
  const raw = header(req, 'host')
  if (!raw) return true
  let name
  try { name = bareHost(new URL('http://' + raw).hostname) } catch { return false }
  if (LOOPBACK_NAMES.has(name) || isIP(name)) return true
  const server = (cfg && cfg.server) || {}
  if (server.host && bareHost(server.host) === name) return true
  return (server.allowedHosts || []).some((h) => bareHost(h) === name)
}

function originAllowed(req, cfg) {
  const raw = header(req, 'origin')
  if (!raw) return true
  if (raw === 'null') return false
  let host
  try { host = new URL(raw).host.toLowerCase() } catch { return false }
  if (host === String(header(req, 'host') || '').toLowerCase()) return true
  const list = ((cfg && cfg.server && cfg.server.allowedOrigins) || [])
    .map((o) => String(o).trim().toLowerCase().replace(/\/$/, ''))
  return list.includes(String(raw).trim().toLowerCase().replace(/\/$/, ''))
}

function denied(status, code, message) {
  return { status, body: { ok: false, code, error: message } }
}

// 显式管理员 + 回环/来源策略 + Host 校验。ctx.explicitAdmin 可由主代理的 explicitAdminOf() 提供；
// 未提供时用 ctx.adminToken 现场校验（绝不因回环而无条件放行）。
export function guardAggregation(req, ctx = {}) {
  const cfg = ctx.cfg || {}
  let explicitAdmin = ctx.explicitAdmin === true
  if (!explicitAdmin && ctx.adminToken) {
    const supplied = tokenOf(req)
    explicitAdmin = !!supplied && safeEqual(supplied, String(ctx.adminToken))
  }
  if (!explicitAdmin) return denied(403, 'aggregation_admin_required', '聚合管理接口要求显式管理员令牌')
  if (!isLoopbackPeer(req) && ctx.allowRemote !== true) {
    return denied(403, 'aggregation_loopback_required', '聚合管理接口只接受回环来源（除非显式允许远程管理）')
  }
  if (!hostAllowed(req, cfg)) return denied(403, 'aggregation_host_denied', 'Host 不在允许列表（DNS 重绑定防护）')
  if (!originAllowed(req, cfg)) return denied(403, 'aggregation_origin_denied', '跨源管理请求被拒绝')
  return null
}

function versionConflict(ctx, body) {
  if (body && body.version !== undefined && Number.isFinite(Number(body.version)) &&
      ctx.configVersion !== undefined && ctx.configVersion !== null &&
      Number(body.version) !== Number(ctx.configVersion || 0)) {
    return { status: 409, body: { ok: false, code: 'version_conflict', error: '配置版本已过期', currentVersion: Number(ctx.configVersion || 0) } }
  }
  return null
}

function mapError(error) {
  const code = error && error.code
  if (error instanceof RegistryError || error instanceof DiscoveryError || error instanceof AggregatedCatalogError) {
    const status = code === 'version_conflict' ? 409
      : code === 'provider_not_found' ? 404
        : code === 'provider_exists' || code === 'provider_id_in_use' || code === 'provider_kind_already_configured' ? 409
          : code === 'registry_not_configured' || code === 'discovery_not_configured' || code === 'catalog_not_configured' ? 503
            : 400
    return { status, body: { ok: false, code, error: error.message, details: error.details || undefined } }
  }
  const raw = (error && error.code) || 'aggregation_internal_error'
  return { status: 500, body: { ok: false, code: raw, error: (error && error.message) || 'unknown' } }
}

function scopeOf(ctx, body) {
  return (body && body.scope) || ctx.scope || 'local'
}

function providerIdFrom(ctx, body, req) {
  return (ctx.params && ctx.params.id) || (body && body.id) || (req && req.params && req.params.id) || null
}

export function createAggregationHandlers(deps = {}) {
  const registry = deps.registry
  const discovery = deps.discovery
  const catalog = deps.catalog
  const activation = deps.activation || null
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()

  function ctxCfg(ctx) {
    return ctx.cfg || (deps.readConfig ? deps.readConfig() : {})
  }

  // 配置代际：主代理通常直接传 ctx.configVersion；缺省时从同一配置读取，读不到就不做乐观锁校验。
  function currentVersion(ctx) {
    if (ctx.configVersion !== undefined && ctx.configVersion !== null) return Number(ctx.configVersion)
    if (typeof deps.readConfig === 'function') {
      try { return Number(deps.readConfig().configVersion || 0) } catch { return undefined }
    }
    return undefined
  }

  // GET /api/aggregation/providers
  function listProviders(req, body, ctx = {}) {
    const g = guardAggregation(req, Object.assign({ cfg: ctxCfg(ctx) }, ctx))
    if (g) return g
    return { status: 200, body: { ok: true, configVersion: currentVersion(ctx), providers: registry.listProviders() } }
  }

  // POST /api/aggregation/providers
  function addProvider(req, body, ctx = {}) {
    const g = guardAggregation(req, Object.assign({ cfg: ctxCfg(ctx) }, ctx))
    if (g) return g
    const v = versionConflict({ configVersion: currentVersion(ctx) }, body)
    if (v) return v
    const input = body && body.provider ? Object.assign({}, body.provider, { version: body.version }) : body
    if (!input || typeof input !== 'object') return denied(400, 'provider_invalid', '请求体需要 provider 对象')
    try {
      const record = registry.addProvider(input)
      return { status: 201, body: { ok: true, provider: record, configVersion: record.version } }
    } catch (error) { return mapError(error) }
  }

  // DELETE /api/aggregation/providers/:id
  function removeProvider(req, body, ctx = {}) {
    const g = guardAggregation(req, Object.assign({ cfg: ctxCfg(ctx) }, ctx))
    if (g) return g
    const v = versionConflict({ configVersion: currentVersion(ctx) }, body)
    if (v) return v
    const id = providerIdFrom(ctx, body, req)
    if (!id) return denied(400, 'provider_id_missing', '缺少 provider id')
    try {
      const out = registry.removeProvider(id)
      return { status: 200, body: { ok: true, removed: out.id, configVersion: out.version } }
    } catch (error) { return mapError(error) }
  }

  // POST /api/aggregation/providers/:id/sync
  async function syncProvider(req, body, ctx = {}) {
    const g = guardAggregation(req, Object.assign({ cfg: ctxCfg(ctx) }, ctx))
    if (g) return g
    const v = versionConflict({ configVersion: currentVersion(ctx) }, body)
    if (v) return v
    const id = providerIdFrom(ctx, body, req)
    if (!id) return denied(400, 'provider_id_missing', '缺少 provider id')
    try {
      const result = await discovery.sync(id, { scope: scopeOf(ctx, body) })
      return {
        status: result.ok ? 200 : (result.completeness === 'discovery_partial' ? 207 : 502),
        body: {
          ok: result.ok,
          completeness: result.completeness,
          code: result.code || null,
          providerId: id,
          counts: result.counts,
          changed: result.changed,
          applied: result.applied === true,
          retainedPrevious: result.retainedPrevious === true,
          diagnostics: result.diagnostics,
        },
      }
    } catch (error) { return mapError(error) }
  }

  // GET /api/aggregation/models
  function listModels(req, body, ctx = {}) {
    const g = guardAggregation(req, Object.assign({ cfg: ctxCfg(ctx) }, ctx))
    if (g) return g
    try {
      const scope = scopeOf(ctx, body)
      const notRoutable = notRoutableOf(scope)
      const current = catalog.readCurrent(scope)
      if (!current.catalog) return { status: 200, body: { ok: true, generation: 0, models: [], counts: null, published: false, notRoutable } }
      return {
        status: 200,
        body: {
          ok: true,
          generation: current.generation,
          counts: current.counts,
          models: current.catalog.models,
          modelIds: current.catalog.models.map((m) => m.slug),
          bindings: current.bindings,
          // 已发现但协议不支持、因此不可调用的模型：显式计数 + ID，绝不静默丢弃。
          notRoutable,
        },
      }
    } catch (error) { return mapError(error) }
  }

  // 快照里“已发现但不可路由”的模型汇总：{ count, byProvider: { id: [upstreamId] } }。
  function notRoutableOf(scope) {
    const byProvider = {}
    let count = 0
    const providers = typeof registry.listProviders === 'function' ? registry.listProviders() : []
    for (const p of providers) {
      const cached = discovery.cacheStore ? discovery.cacheStore.get(scope, p.id) : null
      const models = cached && cached.snapshot && Array.isArray(cached.snapshot.models) ? cached.snapshot.models : []
      const ids = models.filter((m) => m.routable === false).map((m) => m.upstreamId)
      if (ids.length) { byProvider[p.id] = ids; count += ids.length }
    }
    return { count, byProvider, note: '已发现但本网关协议不支持：保留在快照，不发布为可调用模型' }
  }

  // GET /api/aggregation/health
  function health(req, body, ctx = {}) {
    const g = guardAggregation(req, Object.assign({ cfg: ctxCfg(ctx) }, ctx))
    if (g) return g
    const scope = scopeOf(ctx, body)
    const providers = registry.listProviders().map((p) => {
      const cached = discovery.cacheStore ? discovery.cacheStore.get(scope, p.id) : null
      const attempt = discovery.cacheStore && typeof discovery.cacheStore.lastAttempt === 'function'
        ? discovery.cacheStore.lastAttempt(scope, p.id) : null
      const models = cached && cached.snapshot && Array.isArray(cached.snapshot.models) ? cached.snapshot.models : []
      const notRoutable = models.filter((m) => m.routable === false)
      return {
        id: p.id,
        kind: p.kind,
        enabled: p.enabled,
        snapshotAt: cached && cached.snapshot ? cached.snapshot.observedAt : null,
        snapshotComplete: cached && cached.snapshot ? cached.snapshot.complete === true : false,
        models: cached && cached.snapshot ? cached.snapshot.models.length : 0,
        routable: models.length - notRoutable.length,
        // 授权依据计数：unverified 表示“清单不随凭据变化，无法证明账户授权”。
        authorization: {
          unverified: models.filter((m) => m.authBasis === 'unverified').length,
          listed: models.filter((m) => m.authBasis === 'listed').length,
          explicitAllowed: models.filter((m) => m.authBasis === 'explicit_allowed').length,
          explicitDenied: models.filter((m) => m.authBasis === 'explicit_denied').length,
        },
        notRoutable: { count: notRoutable.length, ids: notRoutable.map((m) => m.upstreamId) },
        lastAttempt: attempt ? { at: attempt.at, completeness: attempt.completeness, code: attempt.code || null } : null,
      }
    })
    let published = null
    try {
      const st = catalog.status(scope)
      published = st.current ? { generation: st.current.version, counts: st.current.counts || null } : null
    } catch { published = null }
    return {
      status: 200,
      body: {
        ok: providers.every((p) => p.snapshotComplete || p.lastAttempt === null),
        scope,
        configVersion: currentVersion(ctx),
        providers,
        published,
        // 顶层汇总，便于健康检查直接看出“发现了但用不了”的模型，而不是靠翻每个 provider。
        notRoutable: notRoutableOf(scope),
        authorizationUnverified: providers.reduce((n, p) => n + p.authorization.unverified, 0),
        checkedAt: new Date(now()).toISOString(),
      },
    }
  }

  // GET /api/aggregation/diagnostics
  function diagnostics(req, body, ctx = {}) {
    const g = guardAggregation(req, Object.assign({ cfg: ctxCfg(ctx) }, ctx))
    if (g) return g
    const scope = scopeOf(ctx, body)
    const providers = registry.listProviders().map((p) => {
      const cached = discovery.cacheStore ? discovery.cacheStore.get(scope, p.id) : null
      const attempt = discovery.cacheStore && typeof discovery.cacheStore.lastAttempt === 'function'
        ? discovery.cacheStore.lastAttempt(scope, p.id) : null
      return {
        id: p.id,
        kind: p.kind,
        endpoint: cached && cached.snapshot ? cached.snapshot.endpoint : null,
        completeness: cached && cached.snapshot ? cached.snapshot.completeness : null,
        counts: cached && cached.snapshot ? cached.snapshot.counts : null,
        cache: cached ? { storedAt: new Date(cached.storedAt).toISOString(), etag: cached.etag || null } : null,
        lastAttempt: attempt || null,
      }
    })
    let current = null
    try { current = catalog.status(scope).current } catch { current = null }
    return { status: 200, body: { ok: true, scope, providers, published: current } }
  }

  async function activate(req, body, ctx = {}) {
    const g = guardAggregation(req, Object.assign({ cfg: ctxCfg(ctx) }, ctx))
    if (g) return g
    if (!activation || typeof activation.activate !== 'function') {
      return denied(501, 'aggregation_activation_not_configured', 'Desktop 一键接入由 A3 提供；本处理器只转交，不假装已实现')
    }
    const v = versionConflict({ configVersion: currentVersion(ctx) }, body)
    if (v) return v
    try { return { status: 200, body: await activation.activate(body || {}, ctx) } } catch (error) { return mapError(error) }
  }

  async function deactivate(req, body, ctx = {}) {
    const g = guardAggregation(req, Object.assign({ cfg: ctxCfg(ctx) }, ctx))
    if (g) return g
    if (!activation || typeof activation.deactivate !== 'function') {
      return denied(501, 'aggregation_activation_not_configured', 'Desktop 一键退出由 A3 提供；本处理器只转交，不假装已实现')
    }
    const v = versionConflict({ configVersion: currentVersion(ctx) }, body)
    if (v) return v
    try { return { status: 200, body: await activation.deactivate(body || {}, ctx) } } catch (error) { return mapError(error) }
  }

  return Object.freeze({
    listProviders,
    addProvider,
    removeProvider,
    syncProvider,
    listModels,
    health,
    diagnostics,
    activate,
    deactivate,
  })
}

// 可选辅助：按 ADR 路径分发到 handler（主代理也可以自行 switch）。
export function dispatchAggregationRoute(req, body, ctx = {}) {
  const handlers = ctx.handlers || null
  if (!handlers) return denied(503, 'aggregation_handlers_missing', '未注入聚合处理器')
  const method = String(req && req.method || 'GET').toUpperCase()
  const path = String(req && req.url || '').split('?')[0]
  if (!path.startsWith(AGGREGATION_BASE)) return denied(404, 'aggregation_route_unknown', '不是聚合路由')
  const rest = path.slice(AGGREGATION_BASE.length)
  if (rest === '/providers' && method === 'GET') return handlers.listProviders(req, body, ctx)
  if (rest === '/providers' && method === 'POST') return handlers.addProvider(req, body, ctx)
  const match = rest.match(/^\/providers\/([^/]+)(\/sync)?$/)
  if (match) {
    const id = decodeURIComponent(match[1])
    const nextCtx = Object.assign({}, ctx, { params: { id } })
    if (match[2] && method === 'POST') return handlers.syncProvider(req, body, nextCtx)
    if (!match[2] && method === 'DELETE') return handlers.removeProvider(req, body, nextCtx)
  }
  if (rest === '/models' && method === 'GET') return handlers.listModels(req, body, ctx)
  if (rest === '/health' && method === 'GET') return handlers.health(req, body, ctx)
  if (rest === '/diagnostics' && method === 'GET') return handlers.diagnostics(req, body, ctx)
  if (rest === '/activate' && method === 'POST') return handlers.activate(req, body, ctx)
  if (rest === '/deactivate' && method === 'POST') return handlers.deactivate(req, body, ctx)
  return denied(404, 'aggregation_route_unknown', '未知聚合路由：' + method + ' ' + path)
}
