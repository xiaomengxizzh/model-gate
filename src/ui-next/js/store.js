// Application state, data loading, and light pub/sub. Views never fetch directly.
//
// 契约：docs/contracts/ui-v3-product-status.md §5（mg-ui-product-status/1）。
// 关键点：
//  * 首页、连接页、聚合页共用同一份只读快照（/api/status + 四个 /api/aggregation/*），
//    不允许各视图再维护私有缓存，否则会出现“首页未配置、聚合页已启用”。
//  * 并发刷新用 epoch + AbortController：旧响应绝不覆盖新快照。
//  * FRESHNESS_BUDGET 内不重复请求；只有可见路由才自动刷新。
//  * 401 清空快照（含 state.product）；403 只记局部错误，不清 token。
import { api, clearToken, setUnauthorizedHandler, hasToken } from './api.js'
import { deriveProductStatus, classifyAggregationError } from './product-status.js'

// 数据阶段：idle / loading / ready / empty / error。unknown 由视图在“字段缺失”时显式渲染，
// 绝不允许把 unknown 渲染成 0 或“正常”。
export const DATA_PHASES = ['idle', 'loading', 'ready', 'empty', 'error']

// 自动刷新预算（毫秒）：超过预算且路由可见才重新读取。
export const FRESHNESS_BUDGET = Object.freeze({ aggregation: 5000, product: 8000 })

export const state = {
  auth: { needAuth: false, startedAt: 0 },
  status: null,
  config: null,
  loadedAt: 0,
  lastError: null,
  loading: false,
  view: 'overview',
  phase: { auth: 'idle', status: 'idle', config: 'idle', logs: 'idle' },
  // 产品状态投影（唯一快照）与聚合只读快照。
  product: null,
  aggregation: null,
  productPhase: null,
  productLoadedAt: 0,
  aggregationLoadedAt: 0,
}

const listeners = new Map()

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set())
  listeners.get(event).add(fn)
  return () => { listeners.get(event)?.delete(fn) }
}
export function emit(event, payload) {
  for (const fn of listeners.get(event) || []) { try { fn(payload) } catch (e) { console.error(e) } }
}

export function phaseOf(key) { return (state.phase && state.phase[key]) || 'idle' }
export function isPhase(key, value) { return phaseOf(key) === value }
export function setPhase(key, phase) {
  if (!DATA_PHASES.includes(phase)) throw new Error('unknown phase: ' + phase)
  if (!state.phase) state.phase = {}
  state.phase[key] = phase
  emit('phase', { key, phase })
}

// —— 共享快照的内部记账（不导出，避免视图直接改）——
const productListeners = new Set()
const productState = {
  epoch: 0,
  inFlight: null,
  controller: null,
  lastProductRefresh: 0,
  lastAggregationRefresh: 0,
  stale: true,
  phase: null,
  statusError: null,
  cacheKey: null,
  cached: null,
}

function documentVisible() {
  const doc = typeof document !== 'undefined' ? document : null
  return !doc || doc.visibilityState !== 'hidden'
}

// 只有当前路由真正需要的 section 才自动刷新。
// connections 同时展示官方/Go/Codex/聚合状态，因此同样属于聚合快照的可见范围。
function isVisible(section) {
  if (!documentVisible()) return false
  const view = state.view || 'overview'
  if (section === 'product') return view === 'overview' || view === 'connections'
  if (section === 'aggregation') return view === 'aggregation' || view === 'overview' || view === 'connections'
  return false
}

// —— 鉴权前置门（UX-04 R2）——
// 在 /api/auth 返回、且必要令牌就位之前，绝不发起管理面读取：
// 否则首屏会先打 /api/status（401）和 /api/aggregation/*（explicitAdmin 403），
// 控制台噪声会掩盖真实错误（A5 浏览器 UI-13 验收）。
let authGatePending = false

// app 在接线最早期调用：/api/auth 尚未 resolve。
export function markAuthPending() {
  authGatePending = true
}

// 测试与显式解锁路径使用；loadAuth 成功时也会自动解除。
export function markAuthResolved() {
  authGatePending = false
}

export function canReadControlPlane() {
  if (authGatePending) return false
  if (!state.auth) return false
  if (state.auth.needAuth === true && !hasToken()) return false
  return true
}

function isAuthed() {
  if (!state.auth) return false
  return state.auth.needAuth === false || hasToken()
}

function fulfillment(result) {
  return result && result.status === 'fulfilled' ? result.value : null
}

export function freshnessOf(section, now = Date.now()) {
  const key = section === 'aggregation' ? 'aggregation' : 'product'
  const loadedAt = key === 'aggregation'
    ? (state.aggregation && state.aggregation.loadedAt) || 0
    : productState.lastProductRefresh || 0
  const budgetMs = FRESHNESS_BUDGET[key]
  const ageMs = loadedAt ? Math.max(0, now - loadedAt) : null
  return {
    section: key,
    loadedAt,
    budgetMs,
    ageMs,
    fresh: !!loadedAt && ageMs <= budgetMs,
    stale: !loadedAt || ageMs > budgetMs,
  }
}

// 仅当 section 当前可见且超出 freshness 预算时才需要刷新。
export function shouldRefresh(section, now = Date.now()) {
  if (section !== 'product' && section !== 'aggregation') return false
  if (!canReadControlPlane()) return false
  if (!isVisible(section)) return false
  if (productState.stale) return true
  return freshnessOf(section, now).stale
}

function productInput(now = Date.now()) {
  const aggregation = state.aggregation || null
  const aggregationError = (aggregation && aggregation.error) || null
  return {
    authenticatedAdmin: isAuthed(),
    loading: !state.status && !state.lastError && !productState.lastProductRefresh && !productState.statusError,
    phase: productState.phase,
    status: state.status,
    config: state.config,
    aggregation,
    aggregationError,
    // 状态请求自身的失败单独上报，避免把来源混进"聚合不支持"判断。
    statusError: productState.statusError || null,
    statusLoadedAt: state.loadedAt,
    now,
  }
}

function cacheKeyOf(input) {
  return [
    input.authenticatedAdmin,
    input.loading,
    input.phase,
    input.status,
    input.config,
    input.aggregation,
    input.aggregationError,
    input.statusError,
    input.statusLoadedAt,
  ]
}

function sameKey(a, b) {
  return !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
}

// 当前快照的产品投影。同一份快照（字段引用与阶段都没变）不重复派生。
export function productStatus() {
  const input = productInput()
  const key = cacheKeyOf(input)
  if (productState.cached && sameKey(productState.cacheKey, key)) return productState.cached
  const value = deriveProductStatus(input)
  productState.cacheKey = key
  productState.cached = value
  state.product = value
  return value
}

function notifyProduct() {
  const ps = productStatus()
  emit('product', ps)
  for (const fn of productListeners) { try { fn(ps) } catch (e) { console.error(e) } }
  return ps
}

function publishProduct(reason) {
  productState.cached = null
  productState.cacheKey = null
  const ps = productStatus()
  emit('product', ps)
  if (reason) emit('product:update', { reason, product: ps })
  for (const fn of productListeners) { try { fn(ps) } catch (e) { console.error(e) } }
  return ps
}

function notifyProductCleared(reason) {
  emit('product', null)
  if (reason) emit('product:invalidate', { reason, cleared: true })
  for (const fn of productListeners) { try { fn(null) } catch (e) { console.error(e) } }
}

// 每次新快照或 invalidate 后调用；返回取消订阅函数。
export function onProductStatus(fn) {
  if (typeof fn !== 'function') return () => {}
  productListeners.add(fn)
  return () => { productListeners.delete(fn) }
}

// 标脏并通知订阅者（路由返回/启停完成/401/online）。数据本身保留，
// 但下一次 refreshProduct 不再受 freshness 预算限制。
export function invalidateProductStatus(reason) {
  productState.stale = true
  emit('product:invalidate', { reason: reason || 'invalidated' })
  return notifyProduct()
}

export function setProductPhase(phase) {
  const next = phase == null ? null : String(phase)
  // 允许的写相位：冲突、写入中、等待授权确认（428 预览态由投影进入 preview_pending）。
  if (next !== null && next !== 'conflict' && next !== 'write_in_progress' && next !== 'preview_pending') {
    throw new Error('unknown product phase: ' + phase)
  }
  productState.phase = next
  state.productPhase = next
  return publishProduct('phase')
}

// 首页/连接页/聚合页共用的聚合只读快照；freshness 由 FRESHNESS_BUDGET 计算。
export function aggregationState() {
  const agg = state.aggregation
  if (!agg) return null
  return {
    health: agg.health,
    providers: agg.providers,
    models: agg.models,
    diagnostics: agg.diagnostics,
    error: agg.error,
    loadedAt: agg.loadedAt,
    freshness: freshnessOf('aggregation'),
  }
}

function pickAggregationError(errors) {
  if (!Array.isArray(errors) || !errors.length) return null
  return errors.find((e) => classifyAggregationError(e).kind === 'unsupported') ||
    errors.find((e) => e && e.status === 403) ||
    errors[0]
}

function cancelProductRequest() {
  productState.epoch += 1
  const controller = productState.controller
  productState.controller = null
  productState.inFlight = null
  if (controller) { try { controller.abort() } catch {} }
}

function startProductRefresh(opts) {
  const epoch = productState.epoch + 1
  productState.epoch = epoch
  if (productState.controller) { try { productState.controller.abort() } catch {} }
  const controller = new AbortController()
  productState.controller = controller
  if (!opts.silent && !opts.reuseStatus) setPhase('status', 'loading')

  const signal = controller.signal
  const statusPromise = opts.reuseStatus && state.status
    ? Promise.resolve(state.status)
    : api.status({ signal })

  const promise = (async () => {
    try {
      // 并行读 /api/status 与聚合四接口；单个失败不影响其它结果。
      const results = await Promise.allSettled([
        statusPromise,
        api.aggregationHealth({ signal }),
        api.aggregationProviders({ signal }),
        api.aggregationModels({ signal }),
        api.aggregationDiagnostics({ signal }),
      ])
      if (epoch !== productState.epoch) return state.product
      const [statusResult, healthResult, providersResult, modelsResult, diagnosticsResult] = results
      const aggregationResults = results.slice(1)
      const failures = aggregationResults
        .filter((r) => r.status === 'rejected')
        .map((r) => r.reason)
        .filter(Boolean)
      const statusFailure = statusResult.status === 'rejected' ? statusResult.reason : null
      const sessionExpired = (statusFailure && statusFailure.status === 401) || failures.some((e) => e && e.status === 401)
      const cancelled = failures.some((e) => e && e.aborted === true)
      // 401 已触发 store.handleUnauthorized（快照被清空），旧请求不得写回任何数据。
      if (sessionExpired || cancelled) return state.product

      const status = statusResult.status === 'fulfilled' ? statusResult.value : null
      const nextAt = Date.now()
      if (statusResult.status === 'fulfilled') {
        state.status = status
        state.loadedAt = nextAt
        state.lastError = null
        productState.statusError = null
        if (!opts.silent) setPhase('status', status ? 'ready' : 'empty')
        emit('status', status)
      } else {
        // 断网/超时：不保留旧的成功快照，投影进入 recoverable_error（见契约 §8）。
        state.status = null
        state.loadedAt = 0
        state.lastError = statusFailure
        productState.statusError = statusFailure
        if (!opts.silent) setPhase('status', 'error')
      }

      const error = pickAggregationError(failures)
      const unsupported = !!error && classifyAggregationError(error).kind === 'unsupported'
      state.aggregation = {
        health: fulfillment(healthResult),
        providers: fulfillment(providersResult),
        models: fulfillment(modelsResult),
        diagnostics: fulfillment(diagnosticsResult),
        error,
        unsupported,
        loadedAt: nextAt,
      }
      state.aggregationLoadedAt = nextAt
      emit('aggregation', state.aggregation)

      if (!statusFailure) {
        productState.stale = false
        productState.lastProductRefresh = nextAt
        productState.lastAggregationRefresh = nextAt
        state.productLoadedAt = nextAt
      } else {
        productState.stale = true
        productState.lastProductRefresh = 0
        productState.lastAggregationRefresh = 0
      }
      return publishProduct(opts.reason)
    } catch (e) {
      if (epoch !== productState.epoch) return state.product
      state.lastError = e
      productState.statusError = e
      productState.stale = true
      return publishProduct(opts.reason)
    } finally {
      if (epoch === productState.epoch) {
        productState.inFlight = null
        productState.controller = null
      }
    }
  })()
  productState.inFlight = promise
  return promise
}

// 刷新产品快照（status + 聚合四接口，共享一次在途请求）。
// - 并发调用（未 force）合并为同一个 Promise；
// - force 会递增 epoch 并 abort 被超越的请求；
// - 预算内且未标脏时直接返回当前投影，不产生新 fetch。
export function refreshProduct(opts = {}) {
  const section = opts.section === 'aggregation' ? 'aggregation' : 'product'
  const force = opts.force === true
  // 鉴权未确定或缺令牌：不发起任何 /api/status 或 /api/aggregation/* 读取（含 force）。
  if (!canReadControlPlane()) return Promise.resolve(state.product)
  if (productState.inFlight && !force) return productState.inFlight
  if (!force) {
    if (!isVisible(section)) return Promise.resolve(productStatus())
    if (!productState.stale && freshnessOf(section, Date.now()).fresh) return Promise.resolve(productStatus())
  }
  return startProductRefresh({
    reason: opts.reason || 'manual',
    reuseStatus: opts.reuseStatus === true,
    silent: opts.silent === true,
  })
}

// 聚合页专用入口：同一份共享快照，按 aggregation 预算判断。
export function refreshAggregation(opts = {}) {
  return refreshProduct(Object.assign({}, opts, { section: 'aggregation' }))
}

export async function loadAuth() {
  // resolve 之前一律视为未确定：管理面读取保持关闭。
  authGatePending = true
  setPhase('auth', 'loading')
  try {
    const data = await api.auth()
    state.auth = { needAuth: !!data.needAuth, startedAt: Number(data.startedAt) || 0 }
    authGatePending = false
    setPhase('auth', 'ready')
    return state.auth
  } catch (e) {
    setPhase('auth', 'error')
    throw e
  }
}

export async function loadStatus(opts = {}) {
  if (!canReadControlPlane()) return state.status
  if (!opts.silent) setPhase('status', 'loading')
  try {
    const status = await api.status()
    state.status = status
    state.loadedAt = Date.now()
    state.lastError = null
    productState.statusError = null
    if (!opts.silent) setPhase('status', status ? 'ready' : 'empty')
    emit('status', status)
    publishProduct()
    return status
  } catch (e) {
    state.lastError = e
    productState.statusError = e
    if (!opts.silent) setPhase('status', 'error')
    publishProduct()
    throw e
  }
}

export async function loadConfig() {
  if (!canReadControlPlane()) return state.config
  setPhase('config', 'loading')
  try {
    const config = await api.config()
    state.config = config
    setPhase('config', config ? 'ready' : 'empty')
    emit('config', config)
    publishProduct()
    return config
  } catch (e) {
    state.lastError = e
    setPhase('config', 'error')
    publishProduct()
    throw e
  }
}

export async function loadAll() {
  if (!canReadControlPlane()) return { status: state.status, config: state.config }
  state.loading = true
  setPhase('status', 'loading')
  setPhase('config', 'loading')
  try {
    const [status, config] = await Promise.all([api.status(), api.config()])
    state.status = status
    state.config = config
    state.loadedAt = Date.now()
    state.lastError = null
    productState.statusError = null
    setPhase('status', status ? 'ready' : 'empty')
    setPhase('config', config ? 'ready' : 'empty')
    emit('status', status)
    emit('config', config)
    emit('data', { status, config })
    publishProduct()
    return { status, config }
  } catch (e) {
    state.lastError = e
    productState.statusError = e
    setPhase('status', 'error')
    setPhase('config', 'error')
    emit('error', e)
    publishProduct()
    throw e
  } finally {
    state.loading = false
  }
}

export function resetData() {
  cancelProductRequest()
  state.status = null
  state.config = null
  state.loadedAt = 0
  state.lastError = null
  state.product = null
  state.aggregation = null
  state.productLoadedAt = 0
  state.aggregationLoadedAt = 0
  state.productPhase = null
  state.phase = { auth: state.auth ? 'idle' : 'idle', status: 'idle', config: 'idle', logs: 'idle' }
  productState.stale = true
  productState.phase = null
  productState.statusError = null
  productState.lastProductRefresh = 0
  productState.lastAggregationRefresh = 0
  productState.cached = null
  productState.cacheKey = null
  emit('reset')
  notifyProductCleared('reset')
}

// 401 的统一收口：清 token、清敏感状态（含产品快照）、通知界面跳登录。
// 403 不进入这里：功能级权限由视图做局部错误。
export function handleUnauthorized(info) {
  clearToken()
  resetData()
  emit('unauthorized', info || {})
}

// api 层一旦遇到 401 就调用这里；store 导入即生效，不依赖 app 是否接线。
setUnauthorizedHandler((info) => handleUnauthorized(info))

export function configVersion() {
  return Number(state.config?.configVersion ?? state.status?.configVersion ?? 0)
}

// 运行时字段缺失时给视图一个显式的“未知”，而不是 0。
export function unknownIfMissing(value, formatter) {
  if (value == null || value === '' || (typeof value === 'number' && !Number.isFinite(value))) return '未知'
  return formatter ? formatter(value) : value
}

// Derived operational warnings used by Dashboard/Settings. All from real state.
export function deriveWarnings() {
  const out = []
  const s = state.status
  const c = state.config
  if (!s) return out
  if (!state.auth.needAuth) out.push({ kind: 'warn', title: '管理面未启用令牌', detail: '仅本机可管理。若网关绑定非回环地址，请设置 MG_ADMIN_TOKEN 或 server.adminToken。' })
  const providers = Array.isArray(s.providers) ? s.providers : []
  const models = Array.isArray(s.models) ? s.models : []
  if (!providers.length) out.push({ kind: 'warn', title: '尚未配置任何上游', detail: '请先在「上游供应商」新增 Provider，再配置模型。' })
  if (!models.length) out.push({ kind: 'warn', title: '模型目录为空', detail: '网关当前没有可路由的真实模型。' })
  const noKey = providers.filter((p) => !p.hasKey)
  if (noKey.length) out.push({ kind: 'warn', title: noKey.length + ' 个上游缺少凭据', detail: noKey.map((p) => p.id).join('、') + ' 将无法发起真实请求。' })
  const open = providers.filter((p) => p.st && p.st.state === 'open')
  if (open.length) out.push({ kind: 'danger', title: open.length + ' 个上游处于熔断', detail: open.map((p) => p.id).join('、') + ' 暂时被跳过，冷却结束后半开放行。' })
  const g = s.global || {}
  if (Number(g.requests) > 0 && Number(g.errors) / Number(g.requests) > 0.2) out.push({ kind: 'warn', title: '错误率偏高', detail: '累计错误 ' + g.errors + ' / 请求 ' + g.requests + '，请到「监控与诊断」查看日志。' })
  if (c && s.configVersion != null && Number(c.configVersion) !== Number(s.configVersion)) out.push({ kind: 'warn', title: '配置版本不一致', detail: '可编辑配置版本 ' + c.configVersion + ' 与运行版本 ' + s.configVersion + ' 不同，请刷新。' })
  return out
}
