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
import { configPaths, resolveKey } from '../router.js'
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
  modeSnapshot,
  preview as desktopPreview,
  previewReconcile as desktopPreviewReconcile,
  previewRollback as desktopPreviewRollback,
  reconcileState as desktopReconcileState,
  rollback as desktopRollback,
  status as desktopStatus,
} from '../codex/desktop-integration.js'
import { AGGREGATION_MODES, listModeMetadata, listSelectableParents } from '../codex/profiles.js'
import { stableModelId } from '../codex/catalog.js'

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

// 发现请求的凭据来源必须与转发链同源：keys.local.json → 进程环境变量 → 用户级环境变量实时读取。
// discovery 默认只读 process.env，而进程 env 是启动快照；用户后来写入
// ~/.config/environment.d/*.conf 的 Key 在已运行实例上不可见，会导致
// "/api/status 显示 hasKey=true，但 sync 报 discovery_credential_missing"。
// 这里注入 resolveKey，让聚合发现同样能吃到环境变量（且绝不写入/回显 Key 值）。
export function providerCredentialResolver (cfg) {
  return (provider) => {
    if (!provider) return null
    if (provider.keyRef === 'none') return null
    const id = provider.id || (provider.aggregation && provider.aggregation.id)
    if (!id) return null
    const def = (cfg && cfg.providers && cfg.providers[id]) || provider._def || provider
    const resolved = resolveKey(cfg || {}, def, id)
    return resolved && resolved.key ? resolved.key : null
  }
}

function buildDeps (cfg, log, reload) {
  const dir = configPaths().dir
  const registry = createRegistry({ log, reload })
  const cacheStore = createFileSnapshotStore({ dir })
  const discovery = createDiscoveryEngine({
    registry,
    cacheStore,
    cfg: cfg || {},
    resolveCredential: providerCredentialResolver(cfg),
  })
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
  const missing = []
  for (const p of providers) {
    const snap = snapshotOf(deps, p.id)
    if (snap) snaps.push(snap)
    else missing.push(p.id)
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
  // MG-FIX-P2-08：任一已配置 provider 没有可信快照就不能宣布整体 complete。
  // “未知”不等于“空白”，更不等于“完整”：避免 UI 显示假的“准备就绪”。
  if (missing.length) {
    return { state: 'partial', complete: false, discovered, reason: 'providers_not_synced', missingProviders: missing, truncated: true }
  }
  const emptyConfirmed = snaps.length === providers.length && snaps.every((s) => s.emptyConfirmed === true && s.models.length === 0)
  return {
    state: 'complete',
    complete: true,
    discovered,
    reason: null,
    upstreamConfirmedEmpty: emptyConfirmed,
    providersComplete: true,
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

// 输入规范化：把 GUI/调用方提供的形状收敛成注册表能接受的字段。
//   * preset 透传是 A2/UX-02 的唯一后端改动：注册表用已登记位形（baseUrl/api/name/v2Scope/id 段）
//     补全，普通用户因此只需提交一个 Key。模板只填「缺失」的字段，显式字段仍然优先。
//   * 只写真正提供的字段：Object.assign 语义下显式 undefined 会覆盖模板字段（把 preset 的
//     kind/baseUrl 抹成 undefined），因此不能把空 id/kind/baseUrl 塞进请求。
//   * 内联 apiKey 继续原样交给注册表，由 registry 抛出 provider_key_inline_forbidden；
//     Key 的唯一写入通道仍是 POST /api/keys。
export function normalizeProviderInput (body) {
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
  const preset = raw.preset == null ? '' : String(raw.preset).trim()
  const out = {}
  if (preset) out.preset = preset
  if (id) out.id = id
  if (kind != null && String(kind).trim() !== '') out.kind = kind
  if (raw.baseUrl != null && String(raw.baseUrl).trim() !== '') out.baseUrl = raw.baseUrl
  if (raw.apiKeyEnv != null && String(raw.apiKeyEnv).trim() !== '') out.apiKeyEnv = raw.apiKeyEnv
  if (raw.apiKey != null) out.apiKey = raw.apiKey
  // 接管既有非聚合 Go 上游（只补聚合元数据）：仅显式 true 才透传，绝不隐式接管。
  if (raw.adopt === true) out.adopt = true
  if (version !== undefined) out.version = Number(version)
  return out
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
  if (want) {
    // MG-FIX-P1-03：用户显式指定目标模型时，必须能在当前目录里找到它。
    // 目录缺失该 ID 时绝不静默回退到默认/目录首项（可能是官方 GPT），
    // 而是 fail-closed：稳定 422 并要求重新同步，零配置写入、零模型出站。
    if (!slugs.includes(want)) {
      throw new DesktopError(
        'requested_model_unavailable',
        '请求的目标模型不在当前聚合目录中，拒绝静默切换到其它模型；请重新同步目录后重试',
        { requested: want, available: slugs },
        422,
      )
    }
    return want
  }
  // 未显式指定模型才允许默认：cfg.defaults.model → 目录首项。
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
  opts.catalog = catalog
  return opts
}

// 三模式切换选项：在普通接入选项上补 mode/parentModel。route 固定父模型；
// aggregated 显式 parentModel 时让 model 与父保持一致，避免预览与实际写入不一致。
function resolveRoleTarget(cfg, catalog, target, label) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) throw new DesktopError('invalid_role_target', label + ' 必须是 model 或 pool 目标', null, 422)
  const kind = String(target.kind || '')
  const id = String(target.id || '').trim()
  if (!id) throw new DesktopError('invalid_role_target', label + ' 缺少稳定 ID', null, 422)
  const slugs = new Set((catalog?.models || []).map((model) => model.slug).filter(Boolean))
  if (kind === 'model') {
    const entry = Object.entries(cfg.models || {}).find(([name, def]) => name === id || def.modelId === id)
    if (!entry || entry[1].enabled === false) throw new DesktopError('role_target_unavailable', label + ' 模型不存在或已停用', { target }, 422)
    const slug = [entry[0], stableModelId(entry[1].provider, entry[0])].find((candidate) => slugs.has(candidate))
    if (!slug) throw new DesktopError('role_target_unavailable', label + ' 模型尚未发布到当前 Codex 目录', { target }, 422)
    return { kind, id, slug }
  }
  if (kind === 'pool') {
    const pool = (cfg.virtualModels || []).find((item) => item.poolId === id || item.slug === id || item.name === id)
    const slug = pool?.slug || pool?.name || ''
    if (!pool || pool.enabled === false || !slugs.has(slug)) throw new DesktopError('role_target_unavailable', label + ' 模型池不存在、已停用或尚未发布目录', { target }, 422)
    return { kind, id: pool.poolId || id, slug }
  }
  throw new DesktopError('invalid_role_target', label + ' kind 仅支持 model/pool', null, 422)
}

function switchOptions (cfg, body, deps) {
  const opts = activationOptions(cfg, body, deps)
  const mode = String((body && body.mode) || '').trim()
  if (AGGREGATION_MODES.includes(mode)) {
    opts.mode = mode
    const parent = body && body.parentModel != null ? String(body.parentModel).trim() : ''
    if (parent) {
      opts.parentModel = parent
      if (mode !== 'route') opts.model = parent
    }
    if (mode === 'route' && (body.routeTarget || body.childTarget)) {
      const role = resolveRoleTarget(cfg, opts.catalog, body.routeTarget || body.childTarget, '纯路由目标')
      opts.routeTarget = role
      opts.model = role.slug
      opts.parentModel = role.slug
      opts.agentModel = role.slug
    } else if (mode === 'aggregated' && body.childTarget) {
      const role = resolveRoleTarget(cfg, opts.catalog, body.childTarget, '聚合子目标')
      opts.childTarget = role
      opts.agentModel = role.slug
    } else if (mode === 'official' && (body.routeTarget || body.childTarget)) {
      throw new DesktopError('official_target_forbidden', '官方直连不接受第三方模型或模型池目标', null, 422)
    }
  }
  return opts
}

async function handleHealth (cfg, deps, ctx) {
  const st = desktopStatus(desktopOpts(cfg))
  const det = desktopDetect(desktopOpts(cfg))
  const snap = modeSnapshot(Object.assign(desktopOpts(cfg), { cfg }))
  // 目录运行时健康：只读本地目录，不触发网络；由入口注入 codexCatalogHealth，缺省时降级为 null。
  let catalogRuntime = null
  try {
    if (ctx && typeof ctx.catalogRuntime === 'function') catalogRuntime = ctx.catalogRuntime()
    else if (ctx && ctx.catalogRuntime) catalogRuntime = ctx.catalogRuntime
    else if (deps && typeof deps.catalogRuntime === 'function') catalogRuntime = deps.catalogRuntime()
    else if (deps && deps.catalogRuntime) catalogRuntime = deps.catalogRuntime
  } catch { catalogRuntime = { ok: false, error: 'catalog_runtime_unavailable' } }
  return {
    status: 200,
    body: {
      ok: true,
      mode: st.mode,
      reason: st.reason || null,
      // previousMode 复用 state.previous.mode 的投影：前端「回到上一模式」按钮读这个字段。
      previousMode: snap.previousMode,
      drifted: snap.drifted === true,
      needsRestart: st.needsRestart === true,
      detect: det,
      backup: det.backup || st.backup || { available: false },
      activation: {
        appliedSha: (det.state && det.state.appliedSha) || null,
        lastApply: st.lastApply || null,
        needsRestart: st.needsRestart === true,
      },
      catalogRuntime,
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
    if (rest === '/health' && method === 'GET') return await handleHealth(ctx.cfg, deps, ctx)

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

    // —— 三模式（official / route / aggregated）契约面 ——
    // GET /modes：只读投影，复用 classifyConfigState（经 modeSnapshot）与目录候选父模型。
    if (rest === '/modes' && method === 'GET') {
      const snap = modeSnapshot(Object.assign(desktopOpts(ctx.cfg), { cfg: ctx.cfg }))
      let parents = []
      try {
        const current = deps.catalog.readCurrent(SCOPE)
        parents = listSelectableParents(current.catalog).map((p) => ({
          id: p.slug, label: p.displayName, realTest: p.realTest,
        }))
      } catch { /* 目录不可读时返回空候选，前端会给出默认已签收父模型，不伪造目录 */ }
      const available = listModeMetadata().map((m) => Object.assign({}, m, {
        selectableParents: m.id === 'aggregated' ? parents : [],
      }))
      return {
        status: 200,
        body: {
          current: { mode: snap.mode, parentModel: snap.parentModel, childModel: snap.childModel },
          available,
          // 兼容前端 selectableParentModels() 的两种读取形状（modes[] / selectableParents）。
          modes: available,
          selectableParents: parents,
          previousMode: snap.previousMode,
          drifted: snap.drifted,
          appliedSha: snap.appliedSha,
        },
      }
    }

    // POST /switch：无 token → 428 + preview（删除行 / before·after sha / token）；带 token → 写入。
    if (rest === '/switch' && method === 'POST') {
      const mode = String((body && body.mode) || '').trim()
      if (!AGGREGATION_MODES.includes(mode)) {
        return fail(422, 'invalid_mode', '未知接入方式：只接受 official / route / aggregated', {
          allowed: AGGREGATION_MODES.slice(),
        })
      }
      if (modeSnapshot(Object.assign(desktopOpts(ctx.cfg), { cfg: ctx.cfg })).drifted) {
        return fail(409, 'config_drifted', '配置已被修改（sha 漂移），拒绝切换；请重新检测后再操作')
      }
      const opts = switchOptions(ctx.cfg, body, deps)
      const token = body && body.consentToken ? String(body.consentToken) : ''
      if (!token) {
        const p = desktopPreview(opts)
        if (!p.ok) {
          return fail(422, (p.blocked && p.blocked[0] && p.blocked[0].code) || 'activation_blocked', '切换被前置条件阻止，未做任何写入', {
            blocked: p.blocked || [], preview: p,
          })
        }
        return {
          status: 428,
          body: {
            ok: false,
            code: 'consent_required',
            preview: Object.assign({}, p, {
              beforeSha: p.before && p.before.sha256 ? p.before.sha256 : p.expectedSha,
              afterSha: p.after && p.after.sha256 ? p.after.sha256 : null,
              restartPreview: { needed: true, reason: 'mode_change_requires_restart' },
            }),
          },
        }
      }
      const applied = await desktopActivate(Object.assign({}, opts, {
        consentToken: token,
        expectedSha: body && body.expectedSha !== undefined ? String(body.expectedSha) : undefined,
      }))
      const restart = applied && applied.restart ? applied.restart : { needed: true, reason: 'mode_change_requires_restart' }
      return {
        status: 200,
        body: Object.assign({ ok: true }, applied, {
          mode: applied && applied.mode ? applied.mode : mode,
          restart: { needed: restart.needed === true, reason: restart.reason || null },
          reload: runtimeReload(ctx),
        }),
      }
    }

    // POST /rollback：无 token → 428 + preview；带 token → 回到 state.previous.mode。
    // 无 previous / 漂移 / 备份缺失由 previewRollback 抛 typed 409，mapFailure 原样映射。
    if (rest === '/rollback' && method === 'POST') {
      const opts = activationOptions(ctx.cfg, body, deps)
      const token = body && body.consentToken ? String(body.consentToken) : ''
      if (!token) {
        const p = desktopPreviewRollback(opts)
        return {
          status: 428,
          body: {
            ok: false,
            code: 'consent_required',
            preview: Object.assign({}, p, {
              beforeSha: p.before && p.before.sha256 ? p.before.sha256 : p.expectedSha,
              afterSha: p.afterSha || (p.after && p.after.sha256 ? p.after.sha256 : null),
              restartPreview: { needed: true, reason: 'mode_change_requires_restart' },
            }),
          },
        }
      }
      const out = await desktopRollback(Object.assign({}, opts, {
        consentToken: token,
        expectedSha: body && body.expectedSha !== undefined ? String(body.expectedSha) : undefined,
      }))
      const restart = out && out.restart ? out.restart : { needed: true, reason: 'mode_change_requires_restart' }
      return {
        status: 200,
        body: Object.assign({ ok: true }, out, {
          restart: { needed: restart.needed === true, reason: restart.reason || null },
          reload: runtimeReload(ctx),
        }),
      }
    }

    // POST /reconcile：漂移解漂。无 token → 428 + 脱敏 preview（当前配置自有字段 vs state.desired、
    // before/after sha、consentToken、expectedSha）；带 token → 只更新 state 基线。
    // 铁律：reconcile 绝不写 config.toml，只写 state 的 appliedSha/desired 基线，不切模式。
    // 显式管理员 + 回环/Host/Origin 门禁由 handleAggregationApi 入口统一执行，本路由原样继承。
    if (rest === '/reconcile' && method === 'POST') {
      const opts = desktopOpts(ctx.cfg)
      const token = body && body.consentToken ? String(body.consentToken) : ''
      if (!token) {
        const p = desktopPreviewReconcile(opts)
        return {
          status: 428,
          body: {
            ok: false,
            code: 'consent_required',
            preview: Object.assign({}, p, {
              beforeSha: p.baselineFromSha || '',
              afterSha: p.baselineToSha || '',
            }),
            note: '采纳当前配置作为新基线：只更新 state 文件，不修改 config.toml 内容、不切换接入方式、不改 model/provider、不触碰 auth.json。',
          },
        }
      }
      const out = desktopReconcileState(Object.assign({}, opts, {
        consentToken: token,
        expectedSha: body && body.expectedSha !== undefined ? String(body.expectedSha) : undefined,
      }))
      const snap = modeSnapshot(Object.assign(desktopOpts(ctx.cfg), { cfg: ctx.cfg }))
      return {
        status: 200,
        body: Object.assign({ ok: true }, out, {
          mode: snap.mode,
          drifted: snap.drifted === true,
          // config.toml 字节没变，无需重载进程内配置；只需前端重新拉取快照。
          reload: { applied: false, needsRestart: false, reason: 'state_only_no_config_change' },
        }),
      }
    }

    if (rest === '' || rest === '/') return fail(404, 'aggregation_route_unknown', '未知聚合路由：' + method + ' ' + path)
    return fail(404, 'aggregation_route_unknown', '未知聚合路由：' + method + ' ' + path)
  } catch (error) {
    return mapFailure(error)
  }
}
