// ModelGate Next bootstrap: auth, routing, shared snapshots, theme.
import { clear, h } from './js/dom.js'
import { api, setToken, hasToken, clearToken } from './js/api.js'
import {
  state, loadAuth, loadAll, loadStatus, resetData, on, phaseOf, handleUnauthorized,
  productStatus, aggregationState, refreshProduct, refreshAggregation, shouldRefresh,
  invalidateProductStatus, onProductStatus, canReadControlPlane, markAuthPending,
} from './js/store.js'
import { ROUTES, routeFromHash, startRouter } from './js/router.js'
import { toast, callout, closeDialog } from './js/components.js'
import { dirtyDraft } from './js/config-draft.js'
import * as dashboard from './js/views/dashboard.js'
import * as connections from './js/views/connections.js'
import * as providers from './js/views/providers.js'
import * as models from './js/views/models.js'
import * as clients from './js/views/clients.js'
import * as observability from './js/views/observability.js'
import * as settings from './js/views/settings.js'
import * as aggregation from './js/views/aggregation.js'

// 视图注册表按 route id 组织；路由元数据（title/group）始终来自 router.js，
// 不在这里硬编码路由数组（A1 扩展 ROUTES 时本文件无需改动）。
const views = { overview: dashboard, connections, providers, models, clients, observability, settings, aggregation }
let currentRoute = 'overview'
let viewEpoch = 0
let refreshing = false
let pollTimer = null

function routeMeta(id) {
  return ROUTES.find((r) => r.id === id) || null
}
function routeTitle(id) {
  const meta = routeMeta(id)
  return (meta && (meta.title || meta.label)) || id
}
// 哪些路由消费哪份快照（契约 §5：overview/connections → product；aggregation → 聚合）。
function sectionForRoute(route) {
  if (route === 'aggregation') return 'aggregation'
  if (route === 'overview' || route === 'connections') return 'product'
  return null
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme
  try { localStorage.setItem('mg-theme', theme) } catch {}
  const btn = document.getElementById('theme-toggle')
  if (btn) btn.setAttribute('aria-label', theme === 'dark' ? '切换到浅色主题' : '切换到深色主题')
}
function initTheme() {
  let theme = ''
  try { theme = localStorage.getItem('mg-theme') || '' } catch {}
  if (!theme) theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  applyTheme(theme === 'dark' ? 'dark' : 'light')
}

function updateChrome() {
  const s = state.status
  const statusEl = document.getElementById('side-status')
  const detailEl = document.getElementById('side-detail')
  const pulse = document.getElementById('side-pulse')
  const chip = document.getElementById('conn-chip')
  const connText = document.getElementById('conn-text')
  const footTime = document.getElementById('foot-time')
  const sideVersion = document.getElementById('side-version')
  if (s) {
    const providers = Array.isArray(s.providers) ? s.providers : []
    const open = providers.filter((p) => p.st && p.st.state === 'open').length
    statusEl.textContent = open ? '部分上游熔断' : '网关在线'
    detailEl.textContent = providers.length + ' 个上游 · 配置版本 ' + (s.configVersion ?? '—')
    pulse.className = 'pulse ' + (open ? 'is-warn' : 'is-good')
    chip.className = 'conn-chip ' + (open ? 'is-warn' : 'is-good')
    connText.textContent = open ? '降级' : '已连接'
    sideVersion.textContent = 'v' + (s.configVersion ?? '—')
  } else if (state.auth && state.auth.needAuth) {
    statusEl.textContent = '等待解锁'
    detailEl.textContent = '输入管理令牌后读取本地控制面'
    pulse.className = 'pulse is-warn'
    chip.className = 'conn-chip is-warn'
    connText.textContent = '已锁定'
  } else {
    statusEl.textContent = '尚未连接'
    detailEl.textContent = '无法读取本地控制面'
    pulse.className = 'pulse is-bad'
    chip.className = 'conn-chip is-bad'
    connText.textContent = '未连接'
  }
  if (footTime) footTime.textContent = state.loadedAt ? '最近刷新 ' + new Date(state.loadedAt).toLocaleTimeString('zh-CN', { hour12: false }) : ''
}

// 数据阶段展示：loading 用骨架提示，error 用可重试错误页；不允许把未知状态渲染成 0/正常。
export function renderLoading() {
  const root = document.getElementById('view-root')
  if (!root) return
  clear(root)
  root.append(h('header', { class: 'page-head' }, h('div', null,
    h('p', { class: 'eyebrow', text: 'CONTROL PLANE / LOADING' }),
    h('h1', { text: '正在读取控制面…' }),
    h('p', { text: '只读取真实管理 API；在响应返回前不会显示任何缓存或模拟数据。' }))),
    callout('info', h('strong', { text: 'loading：' }), ' 状态、配置与目录尚未返回，页面不展示 0 或“正常”占位。'))
  updateChrome()
}

// 401 会话失效：清掉所有已渲染的敏感投影（配置、目录、额度、历史），再跳登录。
// 403 功能级拒绝不进这里，由对应视图局部提示。
export function clearControlPlaneDom() {
  const root = document.getElementById('view-root')
  if (root) clear(root)
  const dialogRoot = document.getElementById('dialog-root')
  // 401/锁定清屏：先摘掉 dialog 的全局监听与焦点归还，再清空，避免 Escape 监听残留到下一次弹窗。
  if (dialogRoot) { try { closeDialog() } catch { /* 无活动弹窗时忽略 */ } }
  if (dialogRoot) { clear(dialogRoot); dialogRoot.hidden = true }
  const chip = document.getElementById('dirty-top')
  if (chip && chip.remove) chip.remove()
  const err = document.getElementById('auth-error')
  if (err) err.textContent = ''
}

export function onUnauthorized(info) {
  const status = info && info.status
  const message = status === 403 ? '管理请求被拒绝（403）：来源/令牌校验未通过，请重新输入管理令牌。' : '管理令牌已失效，请重新输入。'
  clearControlPlaneDom()
  renderLocked(message)
  showAuth(message)
  updateChrome()
}

// 供 api/store 之外的显式入口（例如测试或窗口锁定事件）一次性完成：清状态 + 清 DOM + 跳登录。
export function handleUnauthorizedUi(info) {
  handleUnauthorized(info)
  onUnauthorized(info)
}

// 弹窗是否打开；打开中的表单不得被轮询/快照刷新重建（契约 §5 第 5 条）。
function isDialogOpen() {
  const root = document.getElementById('dialog-root')
  return !!(root && !root.hidden && root.firstElementChild)
}
// 编辑态 = 弹窗打开或存在未保存草稿。刷新可以继续读状态，但不得重建视图。
export function isEditing() {
  return isDialogOpen() || dirtyDraft()
}

function renderLocked(message) {
  const root = document.getElementById('view-root')
  if (!root) return
  clear(root)
  root.append(h('header', { class: 'page-head' }, h('div', null,
    h('p', { class: 'eyebrow', text: 'CONTROL PLANE / LOCKED' }),
    h('h1', { text: '控制面已锁定' }),
    h('p', { text: '请输入管理员令牌解锁。令牌仅保存在本标签页内存，不会写入持久存储。' }))),
    callout('info', h('strong', { text: '只读保护：' }), ' 解锁前不会读取状态、配置、日志或任何上游数据。'),
    h('button', { class: 'btn btn-primary', type: 'button', text: '输入管理员令牌', onclick: () => showAuth(message) }))
  updateChrome()
}
function renderFatal(err) {
  const root = document.getElementById('view-root')
  if (!root) return
  clear(root)
  root.append(h('div', { class: 'page-head' }, h('div', null,
    h('p', { class: 'eyebrow', text: 'CONNECTION' }),
    h('h1', { text: '无法连接本地网关' }),
    h('p', { text: '控制台只使用真实 API 数据，不会显示模拟指标。请确认网关正在运行，然后重试。' }))),
    callout('danger', h('strong', { text: '错误：' }), err && err.message ? err.message : '未知连接错误'),
    h('button', { class: 'btn btn-primary', type: 'button', text: '重试连接', onclick: () => bootstrap(true) }))
  updateChrome()
}

function syncDirtyChip() {
  const host = document.querySelector('.top-actions')
  if (!host) return
  const old = document.getElementById('dirty-top')
  if (old) old.remove()
  if (dirtyDraft()) {
    const chip = h('button', { class: 'tag tag-warn', id: 'dirty-top', type: 'button', title: '有未保存的配置草稿，点击前往设置', text: '未保存更改' })
    chip.addEventListener('click', () => { location.hash = '#/settings' })
    host.insertBefore(chip, host.querySelector('#refresh'))
  }
}

export function renderRoute(route) {
  currentRoute = route
  state.view = route
  const view = views[route] || views.overview
  const root = document.getElementById('view-root')
  if (!root) return
  // 数据未到达（首次/刷新/切路由）必须先渲染 loading 骨架，不能用旧数据顶替。
  if (phaseOf('status') === 'loading' || phaseOf('config') === 'loading') { renderLoading(); return }
  clear(root)
  const titleEl = document.getElementById('current-view')
  if (titleEl) titleEl.textContent = routeTitle(route)
  document.querySelectorAll('.nav-link').forEach((b) => {
    const on = b.dataset.route === route
    b.classList.toggle('is-active', on)
    if (on) b.setAttribute('aria-current', 'page')
    else b.removeAttribute('aria-current')
  })
  if (!state.status) {
    if (phaseOf('status') === 'error') { renderFatal(state.lastError || new Error('读取状态失败')); return }
    // 鉴权尚未确定/等待解锁：保持 loading 骨架，不显示"读取失败"，更不发管理面请求。
    if (!canReadControlPlane()) { renderLoading(); return }
    renderFatal(state.lastError || new Error('尚未加载状态（未知）'))
    return
  }
  try {
    // 视图只渲染共享快照，不自行推导/自建缓存（契约 §5）。
    view.render(root, {
      rerender: () => renderRoute(currentRoute),
      // A1/A2 的视图按契约消费 store；这里同时提供函数与当前值两种形态，避免重复推导。
      product: () => productStatus(),
      productStatus: () => productStatus(),
      aggregation: aggregationState(),
      aggregationState: () => aggregationState(),
      refreshProduct: (opts = {}) => refreshProduct(Object.assign({ reason: 'view' }, opts)),
      refreshAggregation: (opts = {}) => refreshAggregation(Object.assign({ reason: 'view' }, opts)),
      // P1-04：首页“解锁聚合管理”主操作 → 本机临时管理会话；无此端点时视图降级到设置页。
      unlockAdmin: (action) => unlockAdminLocal(action),
    })
  } catch (e) {
    console.error(e)
    clear(root)
    root.append(callout('danger', h('strong', { text: '页面渲染失败：' }), e.message))
  }
  syncDirtyChip()
  updateChrome()
}

// 路由切换/返回时按需刷新：只在超过 freshness 预算时读取；离开的响应不得回写当前视图。
async function refreshForRoute(route, opts = {}) {
  const section = sectionForRoute(route)
  if (!section) return null
  // 鉴权未确定或缺令牌时不读取、也不重绘（首屏由 bootstrap 的 loading/锁定页接管）。
  if (!canReadControlPlane()) return null
  const force = opts.force === true
  if (!force && !shouldRefresh(section)) return null
  const epoch = viewEpoch
  const reason = opts.reason || ('route:' + route)
  try {
    const ps = section === 'aggregation'
      ? await refreshAggregation({ reason, force, silent: opts.silent === true })
      : await refreshProduct({ reason, force, silent: opts.silent === true })
    if (epoch !== viewEpoch || currentRoute !== route) return ps
    if (!canReadControlPlane()) return ps
    if (!isEditing()) renderRoute(route)
    return ps
  } catch (e) {
    if (e && e.status === 401) return null
    if (canReadControlPlane() && epoch === viewEpoch && currentRoute === route && !isEditing()) renderRoute(route)
    return null
  }
}

// 15s 轮询（以及测试/窗口事件显式调用）：
//  * 仅页面可见且超过 freshness 预算才刷新；
//  * 只读 API，绝不写配置、绝不触发真实模型推理；
//  * 弹窗或未保存草稿打开时不重建视图。
export async function pollRefresh(opts = {}) {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return null
  // 未解锁/鉴权未确定时轮询必须完全静默：不产生任何管理面请求。
  if (!canReadControlPlane()) return null
  const section = sectionForRoute(currentRoute)
  if (!section) return null
  const force = opts.force === true
  if (!force && !shouldRefresh(section)) return null
  const epoch = viewEpoch
  const route = currentRoute
  try {
    if (section === 'product') {
      // 后台轮询必须静默：不进入 loading phase，避免把正在阅读的视图替换成骨架。
      let statusOk = true
      try {
        await loadStatus({ silent: true })
      } catch (e) {
        statusOk = false
        if (e && e.status === 401) return null
      }
      // 读取 status 期间路由已离开：不再为旧路由发起聚合刷新（旧响应也不回写视图）。
      if (epoch !== viewEpoch || currentRoute !== route) return null
      await refreshProduct({
        reason: opts.reason || 'poll',
        force: true,
        reuseStatus: statusOk && !!state.status,
        silent: true,
      })
    } else {
      await refreshAggregation({ reason: opts.reason || 'poll', force: true, silent: true })
    }
    if (epoch !== viewEpoch || currentRoute !== route) return null
    if (!isEditing()) renderRoute(route)
    updateChrome()
    return productStatus()
  } catch (e) {
    if (e && e.status === 401) return null
    return null
  }
}

// 启停聚合等写操作完成后由 A2 调用：强制失效 + 立即刷新共享快照（也支持 window 事件）。
export async function notifyAggregationChanged(reason = 'aggregation-changed') {
  invalidateProductStatus(reason)
  // 令牌失效/未解锁时只标脏，不读取；解锁后的路由刷新会取到新快照。
  if (!canReadControlPlane()) return state.product
  const route = currentRoute
  const epoch = viewEpoch
  const section = sectionForRoute(route)
  try {
    const ps = section === 'aggregation'
      ? await refreshAggregation({ reason, force: true })
      : await refreshProduct({ reason, force: true })
    if (section && epoch === viewEpoch && currentRoute === route && !isEditing() && state.status) renderRoute(route)
    return ps
  } catch (e) {
    if (e && e.status === 401) return null
    return productStatus()
  }
}
export const invalidateAndRefresh = notifyAggregationChanged

function showAuth(message) {
  const overlay = document.getElementById('auth-overlay')
  if (!overlay) return
  overlay.hidden = false
  const err = document.getElementById('auth-error')
  err.textContent = message || ''
  const input = document.getElementById('admin-token')
  if (input) setTimeout(() => input.focus(), 40)
}
function hideAuth() { const o = document.getElementById('auth-overlay'); if (o) o.hidden = true }

export async function bootstrap(rethrow = false) {
  initTheme()
  updateChrome()
  // 首屏在任何一个 API 返回前就显示 loading 骨架（不显示 0/旧缓存）。
  renderLoading()
  try {
    const auth = await loadAuth()
    if (auth.needAuth && !hasToken()) { renderLocked(); showAuth(); return }
    await loadAll()
    // 首屏同时建立共享快照（status 复用刚读到的结果，聚合四接口并行补齐）。
    await refreshProduct({ reason: 'bootstrap', force: true, reuseStatus: true })
    hideAuth()
    renderRoute(routeFromHash())
  } catch (e) {
    if (e && e.status === 401) { renderLocked(); showAuth('需要有效的管理员令牌'); return }
    if (rethrow) throw e
    renderFatal(e)
  }
}

async function manualRefresh() {
  if (refreshing) return
  if (dirtyDraft() && !window.confirm('当前有未保存的配置草稿。刷新会读取远端最新状态，但草稿仍保留；之后保存会提示版本冲突。继续刷新？')) return
  refreshing = true
  const btn = document.getElementById('refresh')
  if (btn) btn.disabled = true
  try {
    // 刷新期间必须显示 loading 骨架：先启动加载（同步置 loading phase），再渲染骨架。
    const running = loadAll()
    renderLoading()
    await running
    await refreshProduct({ reason: 'manual', force: true, reuseStatus: true })
    hideAuth()
    renderRoute(currentRoute)
    toast('已读取网关最新状态', 'success')
  } catch (e) {
    if (e && e.status === 401) { renderLocked(); showAuth('令牌已失效或未通过验证'); return }
    renderRoute(currentRoute)
    toast('刷新失败：' + e.message, 'error')
  } finally {
    refreshing = false
    if (btn) btn.disabled = false
  }
}

// P1-04：没有全局管理令牌时，聚合 API 返回 403 explicit_admin_required。
// 通过本机临时管理会话解锁（POST /api/admin/unlock），token 只在模块内存；
// 端点缺失(404)或被拒(403)时如实提示并降级，不重复轮询造成死循环。
async function unlockAdminLocal() {
  try {
    const res = await api.adminUnlock()
    if (!res || res.ok !== true || !res.token) throw new Error('解锁响应缺少可用的管理会话令牌')
    setToken(res.token)
    await loadAll()
    await refreshProduct({ reason: 'admin-unlock', force: true, reuseStatus: true })
    renderRoute(currentRoute)
    toast('聚合管理已在本机解锁', 'success')
  } catch (e) {
    const status = e && e.status
    if (status === 404) {
      toast('当前网关版本尚不支持本机解锁；请在「安全与设置」写入 MG_ADMIN_TOKEN', 'error')
      if (typeof location !== 'undefined') location.hash = '#/settings?section=admin-token'
    } else if (status === 403) {
      toast('本机解锁被拒绝（403）：' + ((e && e.message) || '来源或 Host 校验未通过'), 'error')
    } else {
      toast('解锁失败：' + ((e && e.message) || '未知错误'), 'error')
    }
  }
}

async function unlock(e) {
  e.preventDefault()
  const input = document.getElementById('admin-token')
  const err = document.getElementById('auth-error')
  const value = input.value.trim()
  if (!value) { err.textContent = '请输入管理员令牌'; return }
  setToken(value)
  input.value = ''
  err.textContent = ''
  try {
    await loadAll()
    await refreshProduct({ reason: 'unlock', force: true, reuseStatus: true })
    hideAuth()
    renderRoute(currentRoute)
    toast('控制面已解锁', 'success')
  } catch (e2) {
    clearToken()
    if (e2 && e2.status === 401) err.textContent = '令牌未通过验证，请检查后重试。'
    else err.textContent = '连接失败：' + (e2 && e2.message ? e2.message : '未知错误')
  }
}

function wire() {
  // 模块接线早于 bootstrap 的 /api/auth：先关闸，防止 router 首跳提前读管理面（401/403 噪声）。
  markAuthPending()
  document.querySelectorAll('.nav-link').forEach((b) => b.addEventListener('click', () => { location.hash = '#/' + b.dataset.route }))
  document.getElementById('refresh').addEventListener('click', manualRefresh)
  document.getElementById('theme-toggle').addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')
  })
  document.getElementById('auth-form').addEventListener('submit', unlock)
  on('unauthorized', onUnauthorized)
  // 快照变化只更新外壳（侧栏/时间）；视图级重绘由当前路由的刷新流程控制。
  onProductStatus(() => updateChrome())
  window.addEventListener('mg:lock', () => { clearToken(); resetData(); renderFatal(new Error('控制台已锁定')); showAuth('控制台已锁定，请输入管理员令牌。') })
  window.addEventListener('beforeunload', (e) => { if (dirtyDraft()) { e.preventDefault(); e.returnValue = '' } })
  window.addEventListener('online', () => {
    toast('网络已恢复', 'success')
    // 服务恢复后强制失效，超过预算与否都重新读取真实状态。
    invalidateProductStatus('online')
    refreshForRoute(currentRoute, { force: true, reason: 'online' }).catch(() => {})
  })
  window.addEventListener('offline', () => toast('网络已断开；控制台不会显示模拟数据', 'error'))
  // A2 启停聚合后可直接调用导出函数，也可派发事件；两条路径都强制失效 + 刷新。
  window.addEventListener('mg:aggregation-changed', (e) => {
    const reason = (e && e.detail && e.detail.reason) || 'aggregation-changed'
    notifyAggregationChanged(reason).catch(() => {})
  })
  window.addEventListener('mg:product-invalidate', (e) => {
    const reason = (e && e.detail && e.detail.reason) || 'product-invalidate'
    invalidateProductStatus(reason)
    refreshForRoute(currentRoute, { force: true, reason }).catch(() => {})
  })
  startRouter((route) => {
    viewEpoch += 1
    state.view = route
    renderRoute(route)
    const root = document.getElementById('view-root')
    if (root && root.focus) root.focus({ preventScroll: true })
    window.scrollTo({ top: 0, behavior: 'instant' })
    refreshForRoute(route).catch(() => {})
  })
  // 低频、只读、按 freshness 预算的状态刷新；配置永不自动重载（保护草稿）。
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = setInterval(() => { pollRefresh().catch(() => {}) }, 15000)
}

// 测试可设置 globalThis.__MG_UI_TEST__ = true 后 import 本模块，只验证导出的纯/DOM 函数，不启动引导。
if (!globalThis.__MG_UI_TEST__) {
  wire()
  bootstrap()
}
