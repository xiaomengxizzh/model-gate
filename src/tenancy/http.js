// MG-R009：单进程多租户 HTTP 调度。身份只来自注入的 resolveActor，或根配置中显式声明、
// 仅用于测试的 x-mg-test-* 映射；x-scope 以及任意请求头永远不是授权来源。
import { resolve } from 'node:path'
import { createScopeStore, DEFAULT_SCOPE_ID, requireUserScope, resolveTenancy, TenancyError } from './scope.js'

const TEST_HEADER_RE = /^x-mg-test-[a-z0-9-]+$/
const PUBLIC_PATHS = new Set(['/', '/favicon.ico', '/admin', '/admin.html'])
const TENANT_UNSUPPORTED_PREFIXES = ['/api/codex', '/api/aggregation', '/api/harnesses']

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function fail(status, code, message) {
  const error = new TenancyError(code, message, { status })
  error.type = code
  return error
}

function normalizeTestHeaders(raw, tenancy) {
  if (raw == null) return Object.freeze({})
  if (!isPlainObject(raw)) throw fail(400, 'tenancy_test_headers_invalid', 'tenancy.testHeaders 必须是对象')
  const out = {}
  for (const [name, entries] of Object.entries(raw)) {
    const header = String(name).toLowerCase()
    if (!TEST_HEADER_RE.test(header)) throw fail(400, 'tenancy_test_header_invalid', '测试身份头仅允许 x-mg-test-* 名称')
    if (!isPlainObject(entries)) throw fail(400, 'tenancy_test_header_invalid', '测试身份映射必须是对象')
    out[header] = {}
    for (const [identity, value] of Object.entries(entries)) {
      if (!identity || identity.length > 128) throw fail(400, 'tenancy_test_identity_invalid', '测试身份标识不合法')
      const actor = typeof value === 'string'
        ? { id: identity, scopeId: value }
        : value && isPlainObject(value) && typeof value.scopeId === 'string'
          ? { id: identity, scopeId: value.scopeId, ...(value.role ? { role: String(value.role) } : {}) }
          : null
      if (!actor) throw fail(400, 'tenancy_test_actor_invalid', '测试身份必须映射到显式 scopeId')
      requireUserScope(actor, { tenancy })
      if (actor.role != null && !['admin', 'user'].includes(actor.role)) throw fail(400, 'tenancy_test_role_invalid', '测试身份 role 仅允许 admin/user')
      out[header][identity] = Object.freeze(actor)
    }
  }
  return Object.freeze(out)
}

export function validateRootControlConfig(cfg, configDir) {
  const tenancy = resolveTenancy(cfg)
  if (tenancy.mode !== 'multi') return { tenancy, root: null, testHeaders: Object.freeze({}) }
  for (const key of ['providers', 'models', 'virtualModels', 'policies', 'harnessBindings', 'routing']) {
    if (cfg[key] && typeof cfg[key] === 'object' && Object.keys(cfg[key]).length) {
      throw fail(400, 'tenancy_root_resources_forbidden', '多租户根配置只能列出 scopes，不能存放租户资源：' + key)
    }
  }
  if (cfg.defaults && Object.keys(cfg.defaults).length) throw fail(400, 'tenancy_root_defaults_forbidden', '多租户根配置不能存放租户 defaults')
  if (cfg._keys && Object.keys(cfg._keys).length) throw fail(400, 'tenancy_root_secrets_forbidden', '多租户根配置不能存放 Key')
  const rawRoot = cfg.tenancy && cfg.tenancy.root
  if (typeof rawRoot !== 'string' || !rawRoot.trim()) throw fail(400, 'tenancy_root_missing', 'multi 模式必须显式配置 tenancy.root')
  const root = resolve(configDir, rawRoot.trim())
  const store = createScopeStore(root, { tenancy })
  const testHeaders = normalizeTestHeaders(cfg.tenancy.testHeaders, tenancy)
  return { tenancy, root: store.root, testHeaders }
}

async function actorFromRequest(req, options) {
  if (typeof options.resolveActor === 'function') return { actor: await options.resolveActor(req) }
  for (const [header, identities] of Object.entries(options.testHeaders)) {
    const raw = req.headers[header]
    if (raw == null) continue
    if (Array.isArray(raw)) return { error: fail(403, 'actor_invalid', '测试身份头不合法') }
    const actor = identities[String(raw)]
    if (!actor) return { error: fail(403, 'actor_unknown', '未知身份') }
    return { actor }
  }
  return { actor: null }
}

function authorizedScope(actor, tenancy) {
  if (!actor || typeof actor !== 'object' || Array.isArray(actor)) throw fail(401, 'actor_required', '需要可信身份')
  if (typeof actor.scopeId !== 'string' || !actor.scopeId.trim()) throw fail(403, 'actor_scope_missing', '身份未授权访问任何作用域')
  try { return requireUserScope(actor, { tenancy }) } catch (error) {
    if (error instanceof TenancyError) throw fail(403, 'actor_scope_unknown', '身份作用域未授权')
    throw error
  }
}

function isPublicRequest(req) {
  const path = (req.url || '/').split('?')[0]
  if ((req.method === 'GET' || req.method === 'HEAD') && PUBLIC_PATHS.has(path)) return true
  return (req.method === 'GET' || req.method === 'HEAD') &&
    (path === '/ui-next' || path.startsWith('/ui-next/') || path === '/ui-vnext' || path.startsWith('/ui-vnext/'))
}

// 返回 false 表示公共静态请求，交给单用户处理器中的静态分支；其余请求全部先鉴权。
export function createTenancyDispatcher(options) {
  const cfg = options.config
  const control = options.control || validateRootControlConfig(cfg, options.configDir)
  const store = createScopeStore(control.root, { tenancy: control.tenancy })
  const states = new Map()
  const runtimes = new Map()
  const startedAt = Date.now()
  const publicState = { cfg, log: options.log, st: { startedAt, counters: {} }, tenancyDispatcher: true }

  async function dispatch(req, res, next) {
    if (isPublicRequest(req)) return next()
    const path = (req.url || '/').split('?')[0]
    let resolved
    try { resolved = await actorFromRequest(req, { resolveActor: options.resolveActor, testHeaders: control.testHeaders }) } catch {
      return options.sendJson(res, 401, { ok: false, code: 'actor_resolution_failed', error: { message: '身份解析失败', type: 'unauthorized' } })
    }
    if (resolved.error) {
      const error = resolved.error
      return options.sendJson(res, error.status, { ok: false, code: error.code, error: { message: error.message, type: 'forbidden' } })
    }
    let scope
    try { scope = authorizedScope(resolved.actor, control.tenancy) } catch (error) {
      return options.sendJson(res, error.status || 403, { ok: false, code: error.code || 'actor_forbidden', error: { message: error.message, type: 'forbidden' } })
    }
    const actor = Object.freeze({ ...resolved.actor, scopeId: scope.scopeId, actorId: scope.actorId })
    req.mgActor = actor
    req.mgScope = scope

    if (path === '/api/tenancy/scopes' && req.method === 'GET') {
      if (actor.role !== 'admin') return options.sendJson(res, 403, { ok: false, code: 'admin_required', error: { message: '需要管理员身份', type: 'forbidden' } })
      return options.sendJson(res, 200, { contract: 'mg-tenancy/1', mode: 'multi', scopes: store.listScopes(), currentScope: scope.scopeId })
    }
    if (path === '/api/tenancy' && req.method === 'GET') {
      const activeState = states.get(scope.scopeId)
      if (activeState && activeState.tenantActiveRequests > 0) {
        await new Promise((resolve) => { activeState.tenantIdleWaiters ||= []; activeState.tenantIdleWaiters.push(resolve) })
      }
      const scoped = store.forScope(scope)
      await scoped.flush()
      const usage = await scoped.usage()
      return options.sendJson(res, 200, { contract: 'mg-tenancy/1', mode: 'multi', scopeId: scope.scopeId, actorId: scope.actorId, usage })
    }
    if (TENANT_UNSUPPORTED_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix + '/'))) {
      return options.sendJson(res, 403, { ok: false, code: 'tenant_path_not_available', error: { message: '该宿主级管理路径未接入租户隔离', type: 'forbidden' } })
    }

    let state = states.get(scope.scopeId)
    if (!state) {
      try {
        const runtime = options.createRuntime(scope)
        state = runtime.state
        state.scope = scope
        state.actor = actor
        state.scopeStore = store.forScope(scope)
        states.set(scope.scopeId, state)
        runtimes.set(scope.scopeId, runtime)
      } catch (error) {
        options.log && options.log.warn('tenant runtime denied', 'scope=' + scope.scopeId, 'code=' + String(error && error.code || 'runtime_failed'))
        return options.sendJson(res, 503, { ok: false, code: String(error && error.code || 'tenant_runtime_unavailable'), error: { message: '租户运行时不可用', type: 'tenant_runtime_unavailable' } })
      }
    }
    state.actor = actor
    return next(state)
  }

  async function close() {
    await Promise.all([...states.values()].map((state) => state.scopeStore.flush()))
    await Promise.all([...runtimes.values()].map((runtime) => options.closeRuntime(runtime)))
  }

  return Object.freeze({ mode: 'multi', control, store, publicState, dispatch, close, defaultScopeId: DEFAULT_SCOPE_ID })
}
