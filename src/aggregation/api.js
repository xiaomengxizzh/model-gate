// 聚合模式 HTTP 适配层（主代理整合）。
//
// 背景：
//   * A2 交付了领域模块（registry / discovery / catalog）与纯 handler 工厂，签名是
//     `handler(req, body, ctx)`，返回 A2 自己的响应形状。
//   * A3 的 GUI（src/ui-next/js/views/aggregation.js）按 ADR-0003 §5 冻结了另一套响应形状：
//     /health 要 mode/detect/backup/activation，/providers 要每条记录带 modelCount/
//     authorizedCount/discoveryState，/models 要 {models, discovery}，activate 要
//     428 预览 / 422 blocked / 409 带 detail.threeWay。
//   * src/index.js 只认识 `{status, body}` 与 sendJson。
//
// 本文件就是这三者之间缺失的适配器：**不改 A2 的模块，也不改 A3 的期望**，
// 把 A2 的领域能力投影成 A3 已写死的形状；activate/deactivate 直接使用 A3 的
// desktop-integration（预览 → 确认 → 备份 → 原子写 → 写后校验），并由这里做状态码映射。
//
// 安全边界：
//   - 所有路由都要求显式管理员（explicitAdmin === true），不做「回环即管理员」放行；
//     仅回环来源（isLocal）才继续，除非入口已显式放行（isLocal 由 index.js 传入）。
//   - 不接受客户端提供的文件路径：activate 的 catalogPath 只能来自服务端已发布目录。
//   - 错误一律返回稳定 code，绝不把未知异常变成泛化 500 文本或回显凭据。
import { configPaths } from '../router.js'
import { createRegistry } from './registry.js'
import { createDiscoveryEngine, createFileSnapshotStore } from './discovery.js'
import { createAggregatedCatalog } from './catalog.js'
import { createAggregationHandlers } from './handlers.js'
import {
  DEFAULT_GATEWAY_BASE_URL,
  DesktopError,
  activate as desktopActivate,
  deactivate as desktopDeactivate,
  detect as desktopDetect,
  preview as desktopPreview,
  status as desktopStatus,
} from '../codex/desktop-integration.js'

export const AGGREGATION_API_CONTRACT = 'mg-aggregation-api/1'
const BASE = '/api/aggregation'
const SCOPE = 'local'

export function isAggregationApiPath (p) {
  const path = String(p == null ? '' : p).split('?')[0]
  return path === BASE || path.startsWith(BASE + '/')
}

function fail (status, code, message, extra) {
  return { status, body: Object.assign({ ok: false, code, error: message }, extra || {}) }
}

function gatewayBaseUrl (cfg) {
  const server = (cfg && cfg.server) || {}
  const host = String(server.host || '').trim()
  const port = Number(server.port) || 18787
  if (!host || host === '127.0.0.1' || host === 'localhost' || host === '::1') {
    return 'http://127.0.0.1:' + port
  }
  return DEFAULT_GATEWAY_BASE_URL
}

function desktopOpts (cfg, extra) {
  return Object.assign({ baseUrl: gatewayBaseUrl(cfg), disableExec: true }, extra || {})
}

function mapFailure (error) {
  if (error instanceof DesktopError) {
    return { status: Number(error.status) || 500, body: { ok: false, code: error.code || 'desktop_integration_failed', error: error.message, detail: error.detail === undefined ? null : error.detail } }
  }
  const code = (error && error.code) || 'aggregation_internal_error'
  const status = Number(error && error.status)
  return { status: Number.isFinite(status) && status >= 400 && status <= 599 ? status : 500, body: { ok: false, code, error: (error && error.message) || 'unknown' } }
}

// A2 handler 需要一个具备 method/url/headers/socket 的请求对象；入口已完成鉴权与来源校验，
// 这里合成一个只用于 guard 的只读视图，绝不把它当成真实 socket 判据。
function syntheticRequest (method, path) {
  return {
    method,
    url: path,
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
  }
}

function buildDeps (cfg, log, reload) {
  const dir = configPaths().dir
  const registry = createRegistry({ log, reload })
  const cacheStore = createFileSnapshotStore({ dir })
  const discovery = createDiscoveryEngine({ registry, cacheStore, cfg: cfg || {} })
  const catalog = createAggregatedCatalog({ registry, cacheStore, dir, readConfig: () => (cfg || {}) })
  const handlers = createAggregationHandlers({ registry, discovery, catalog, readConfig: () => (cfg || {}), activation: null })
  return { registry, discovery, catalog, handlers }
}

// 写成功后把磁盘上的新配置带回进程内存：复用入口注入的 reload（即 /api/config/reload 用的
// 同一个 reloadConfig），绝不另建第二条重载路径。没有注入或重载失败时如实报告 needsRestart，
// 不谎称已生效——聚合模式的收据闸门读的是内存 cfg，这里说谎等于让闸门继续用旧配置。
function runtimeReload (ctx) {
  if (typeof ctx.reload !== 'function') return { applied: false, needsRestart: true, reason: 'reload_unavailable' }
  try {
    ctx.reload()
    return { applied: true, needsRestart: false, reason: null }
  } catch (error) {
    return { applied: false, needsRestart: true, reason: (error && error.code) || 'reload_failed' }
  }
}

function snapshotOf (deps, providerId) {
  const cached = deps.discovery.cacheStore.get(SCOPE, providerId)
  return cached && cached.snapshot ? cached.snapshot : null
}

function attemptOf (deps, providerId) {
  const store = deps.discovery.cacheStore
  return typeof store.lastAttempt === 'function' ? store.lastAttempt(SCOPE, providerId) : null
}

function providerViews (deps) {
  return deps.registry.listProviders().map((p) => {
    const snap = snapshotOf(deps, p.id)
    const attempt = attemptOf(deps, p.id)
    let modelCount = null
    let authorizedCount = null
    if (snap) {
      modelCount = Array.isArray(snap.models) ? snap.models.length : 0
      authorizedCount = snap.models.filter((m) => m && m.authorized === true).length
    }
    const discoveryState = snap
      ? (snap.complete === true ? 'complete' : 'partial')
      : (attempt && attempt.code ? 'failed' : 'unknown')
    return {
      id: p.id,
      kind: p.kind,
      baseUrl: p.baseUrl,
      modelCount,
      authorizedCount,
      discoveryState,
    }
  })
}

function emptyDiscovery (state, reason) {
  return { state: state || 'unknown', complete: false, discovered: 0, reason: reason || null }
}

function discoverySummary (deps) {
  const providers = deps.registry.listProviders()
  if (!providers.length) return emptyDiscovery('unknown', '尚未配置聚合供应商')
  const snaps = []
  const attempts = []
  for (const p of providers) {
    const snap = snapshotOf(deps, p.id)
    if (snap) snaps.push(snap)
    const attempt = attemptOf(deps, p.id)
    if (attempt) attempts.push(attempt)
  }
  if (!snaps.length) {
    if (!attempts.length) return emptyDiscovery('unknown', 'discovery_not_run')
    return emptyDiscovery('failed', attempts[0].code || 'discovery_failed')
  }
  const discovered = snaps.reduce((n, s) => n + (Array.isArray(s.models) ? s.models.length : 0), 0)
  const partial = snaps.find((s) => s.complete !== true)
  if (partial) {
    return { state: 'partial', complete: false, discovered, reason: partial.code || 'discovery_incomplete', truncated: true }
  }
  const emptyConfirmed = snaps.length === providers.length && snaps.every((s) => s.emptyConfirmed === true && s.models.length === 0)
  return {
    state: 'complete',
    complete: true,
    discovered,
    reason: null,
    upstreamConfirmedEmpty: emptyConfirmed,
    // 若部分 provider 从未同步，整体仍不是完整目录。
    providersComplete: snaps.length === providers.length,
  }
}

function modelRows (deps) {
  const rows = []
  for (const p of deps.registry.listProviders()) {
    const snap = snapshotOf(deps, p.id)
    if (!snap) continue
    for (const m of snap.models) {
      rows.push({
        publicId: m.publicId,
        providerId: m.providerId || p.id,
        upstreamId: m.upstreamId,
        displayName: m.displayName,
        contextWindow: Number.isInteger(m.contextWindow) ? m.contextWindow : null,
        capabilities: m.capabilities || { tools: false, supportsSearchTool: false, supportsWebsockets: false },
        authorized: m.authorized === true,
        evidence: m.evidence || { source: 'unknown', observedAt: null },
      })
    }
  }
  return rows
}

function diagnosticsRows (deps) {
  const rows = []
  for (const p of deps.registry.listProviders()) {
    const snap = snapshotOf(deps, p.id)
    const attempt = attemptOf(deps, p.id)
    if (snap) {
      rows.push({
        level: snap.complete === true ? 'info' : 'warn',
        code: snap.complete === true ? 'discovery_complete' : 'discovery_incomplete',
        message: p.id + '：' + (snap.models.length) + ' 个模型（' + (snap.completeness || 'unknown') + '）',
        at: snap.observedAt || null,
        providerId: p.id,
      })
    } else if (attempt) {
      rows.push({
        level: 'error',
        code: attempt.code || 'discovery_failed',
        message: p.id + '：最近一次发现失败（' + (attempt.completeness || 'unknown') + '）',
        at: attempt.at || null,
        providerId: p.id,
      })
    } else {
      rows.push({
        level: 'warn',
        code: 'discovery_not_run',
        message: p.id + '：尚未同步，模型数量未知（不是 0）',
        at: null,
        providerId: p.id,
      })
    }
  }
  try {
    const current = deps.catalog.readCurrent(SCOPE)
    if (current.catalog) {
      rows.push({
        level: 'info',
        code: 'catalog_published',
        message: '已发布目录 generation ' + current.generation + ' · ' + (current.catalog.models ? current.catalog.models.length : 0) + ' 个模型',
        at: null,
      })
    }
  } catch {
    rows.push({ level: 'error', code: 'catalog_state_unreadable', message: '已发布目录状态不可读取', at: null })
  }
  return rows
}

function normalizeProviderInput (body) {
  const raw = body && body.provider && typeof body.provider === 'object' ? body.provider : body
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const kindMap = {
    console: 'opencode-console',
    'opencode-console': 'opencode-console',
    go: 'opencode-go',
    'opencode-go': 'opencode-go',
  }
  const kind = kindMap[String(raw.kind || '').trim().toLowerCase()] || raw.kind
  const segment = kind === 'opencode-console' ? 'console' : kind === 'opencode-go' ? 'opencodego' : null
  let id = raw.id == null ? '' : String(raw.id).trim()
  // GUI 的占位符与注册表固定段不一致时，只把「明显是 kind 别名」的 ID 归一到固定段；
  // 其它自定义 ID 原样交给注册表，由它给出 typed 错误，绝不静默改名。
  if (segment && (!id || id === 'opencode-console' || id === 'opencode-go' || id === 'console' || id === 'go')) id = segment
  const version = raw.configVersion !== undefined ? raw.configVersion : raw.version
  return {
    id,
    kind,
    baseUrl: raw.baseUrl,
    apiKeyEnv: raw.apiKeyEnv,
    apiKey: raw.apiKey,
    version: version === undefined ? undefined : Number(version),
  }
}

function liftVersionConflict (out) {
  if (out && out.body && out.body.code === 'version_conflict' && out.body.currentVersion === undefined) {
    const current = out.body.details && out.body.details.currentVersion
    if (current !== undefined) out.body.currentVersion = current
  }
  return out
}

function pickModel (catalog, cfg, requested) {
  const models = catalog && Array.isArray(catalog.models) ? catalog.models : []
  const slugs = models.map((m) => m && (m.slug || m.id)).filter(Boolean)
  const want = String(requested || '').trim()
  if (want && slugs.includes(want)) return want
  const fallback = cfg && cfg.defaults && cfg.defaults.model ? String(cfg.defaults.model) : ''
  if (fallback && slugs.includes(fallback)) return fallback
  return slugs[0] || fallback || null
}

function activationOptions (cfg, body, deps) {
  const opts = desktopOpts(cfg)
  let catalog = null
  try {
    const current = deps.catalog.readCurrent(SCOPE)
    if (current.catalog) {
      opts.catalogPath = current.path
      catalog = current.catalog
    }
  } catch { /* 目录不可读时交给 preview 报 catalog_path_required，不伪造路径 */ }
  opts.model = pickModel(catalog, cfg, body && body.model)
  return opts
}

async function handleHealth (cfg, deps) {
  const st = desktopStatus(desktopOpts(cfg))
  const det = desktopDetect(desktopOpts(cfg))
  return {
    status: 200,
    body: {
      ok: true,
      mode: st.mode,
      reason: st.reason || null,
      needsRestart: st.needsRestart === true,
      detect: det,
      backup: det.backup || st.backup || { available: false },
      activation: {
        appliedSha: (det.state && det.state.appliedSha) || null,
        lastApply: st.lastApply || null,
        needsRestart: st.needsRestart === true,
      },
    },
  }
}

async function handleSync (method, path, body, ctx, deps) {
  const req = syntheticRequest(method, path)
  const out = await deps.handlers.syncProvider(req, body, {
    cfg: ctx.cfg,
    explicitAdmin: true,
    allowRemote: true,
    scope: SCOPE,
    configVersion: ctx.cfg && ctx.cfg.configVersion,
    params: ctx.params,
  })
  liftVersionConflict(out)
  if (out.status !== 200 && out.status !== 207) return out
  if (!out.body || out.body.applied !== true) return out
  try {
    const published = await deps.catalog.publish(SCOPE, { cfg: ctx.cfg })
    out.body.catalog = {
      generation: published.version,
      modelCount: published.modelCount,
      catalogRef: published.catalogRef,
      diagnostics: published.diagnostics,
    }
    return out
  } catch (error) {
    // 发现成功但目录发布失败：保持 502 + 稳定 code，绝不谎称已可用。
    return fail(502, (error && error.code) || 'catalog_publish_failed', (error && error.message) || '聚合目录发布失败', {
      changed: out.body.changed,
      completeness: out.body.completeness,
      diagnostics: out.body.diagnostics,
      catalogError: { code: (error && error.code) || 'catalog_publish_failed' },
    })
  }
}

export async function handleAggregationApi (ctx = {}) {
  const method = String(ctx.method || 'GET').toUpperCase()
  const path = String(ctx.path || ctx.url || '').split('?')[0]
  if (!isAggregationApiPath(path)) return null

  // 1) 显式管理员 + 本机来源。未通过时不解析 body。
  if (ctx.explicitAdmin !== true) {
    return fail(403, 'explicit_admin_required', '聚合管理接口要求显式管理员令牌')
  }
  if (ctx.isLocal !== true) {
    return fail(403, 'aggregation_loopback_required', '聚合管理接口只接受回环来源')
  }

  // 2) body 只在鉴权后解析；空 body 视为 {}。
  let body = {}
  const raw = ctx.rawBody
  if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
    try {
      const parsed = JSON.parse(String(raw))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return fail(400, 'invalid_body', '请求体必须是 JSON 对象')
      }
      body = parsed
    } catch {
      return fail(400, 'invalid_json', '请求体不是合法 JSON')
    }
  }

  const rest = path.slice(BASE.length)
  let deps
  try {
    deps = buildDeps(ctx.cfg, ctx.log, ctx.reload)
  } catch (error) {
    return fail(503, (error && error.code) || 'aggregation_not_configured', (error && error.message) || '聚合模块未配置')
  }

  try {
    if (rest === '/health' && method === 'GET') return await handleHealth(ctx.cfg, deps)

    if (rest === '/providers' && method === 'GET') {
      return { status: 200, body: { providers: providerViews(deps) } }
    }

    if (rest === '/providers' && method === 'POST') {
      const input = normalizeProviderInput(body)
      if (!input) return fail(400, 'provider_invalid', '请求体需要 provider 对象')
      const req = syntheticRequest(method, path)
      const out = await deps.handlers.addProvider(req, input, {
        cfg: ctx.cfg,
        explicitAdmin: true,
        allowRemote: true,
        configVersion: ctx.cfg && ctx.cfg.configVersion,
      })
      liftVersionConflict(out)
      if (out.status === 201 && out.body) {
        return { status: 201, body: { ok: true, provider: out.body.provider, configVersion: out.body.configVersion, reload: runtimeReload(ctx) } }
      }
      return out
    }

    const providerMatch = rest.match(/^\/providers\/([^/]+)(\/sync)?$/)
    if (providerMatch) {
      const id = decodeURIComponent(providerMatch[1])
      const nextCtx = { cfg: ctx.cfg, params: { id } }
      if (providerMatch[2] && method === 'POST') {
        return await handleSync(method, path, body, nextCtx, deps)
      }
      if (!providerMatch[2] && method === 'DELETE') {
        const req = syntheticRequest(method, path)
        const out = await deps.handlers.removeProvider(req, body, {
          cfg: ctx.cfg,
          explicitAdmin: true,
          allowRemote: true,
          configVersion: ctx.cfg && ctx.cfg.configVersion,
          params: { id },
        })
        liftVersionConflict(out)
        if (out && out.status === 200 && out.body && out.body.ok === true) {
          return { status: 200, body: Object.assign({}, out.body, { reload: runtimeReload(ctx) }) }
        }
        return out
      }
    }

    if (rest === '/models' && method === 'GET') {
      let catalog = null
      try {
        const current = deps.catalog.readCurrent(SCOPE)
        catalog = current.catalog
      } catch (error) {
        return fail(500, (error && error.code) || 'catalog_state_unreadable', (error && error.message) || '目录状态不可读取')
      }
      const discovery = discoverySummary(deps)
      const models = modelRows(deps)
      // 从未同步但已有已发布目录时，用目录投影（只读、不重新发现）补齐只读视图。
      if (!models.length && catalog) {
        const bindings = (deps.catalog.readCurrent(SCOPE).bindings) || {}
        for (const m of catalog.models || []) {
          const slug = m && (m.slug || m.id)
          if (!slug) continue
          const b = bindings[slug] || {}
          models.push({
            publicId: slug,
            providerId: b.provider || null,
            upstreamId: b.model || null,
            displayName: (m.display_name || m.displayName || slug),
            contextWindow: Number.isInteger(m.context_window) ? m.context_window : null,
            capabilities: { tools: false, supportsSearchTool: false, supportsWebsockets: false },
            authorized: true,
            evidence: { source: 'published_catalog', observedAt: null },
          })
        }
      }
      return { status: 200, body: { models, discovery } }
    }

    if (rest === '/diagnostics' && method === 'GET') {
      return { status: 200, body: { diagnostics: diagnosticsRows(deps) } }
    }

    if (rest === '/activate' && method === 'POST') {
      const opts = activationOptions(ctx.cfg, body, deps)
      const token = body && body.consentToken ? String(body.consentToken) : ''
      if (!token) {
        const p = desktopPreview(opts)
        if (!p.ok) {
          return fail(422, (p.blocked && p.blocked[0] && p.blocked[0].code) || 'activation_blocked', '接入被前置条件阻止，未做任何写入', {
            blocked: p.blocked || [],
            preview: p,
          })
        }
        return { status: 428, body: { ok: false, code: 'consent_required', preview: p } }
      }
      const applied = await desktopActivate(Object.assign({}, opts, {
        consentToken: token,
        expectedSha: body && body.expectedSha !== undefined ? String(body.expectedSha) : undefined,
      }))
      return { status: 200, body: Object.assign({ ok: true }, applied, { reload: runtimeReload(ctx) }) }
    }

    if (rest === '/deactivate' && method === 'POST') {
      const out = await desktopDeactivate(Object.assign(desktopOpts(ctx.cfg), {
        expectedSha: body && body.expectedSha !== undefined ? String(body.expectedSha) : undefined,
      }))
      return { status: 200, body: Object.assign({ ok: true }, out, { reload: runtimeReload(ctx) }) }
    }

    if (rest === '' || rest === '/') return fail(404, 'aggregation_route_unknown', '未知聚合路由：' + method + ' ' + path)
    return fail(404, 'aggregation_route_unknown', '未知聚合路由：' + method + ' ' + path)
  } catch (error) {
    return mapFailure(error)
  }
}
