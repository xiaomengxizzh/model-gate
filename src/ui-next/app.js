// ModelGate Next bootstrap: auth, routing, data refresh, theme.
import { clear, h } from './js/dom.js'
import { setToken, hasToken, clearToken, getToken } from './js/api.js'
import { state, loadAuth, loadAll, loadStatus, resetData, on, phaseOf, handleUnauthorized } from './js/store.js'
import { ROUTES, routeFromHash, startRouter } from './js/router.js'
import { toast, callout } from './js/components.js'
import { dirtyDraft } from './js/config-draft.js'
import * as dashboard from './js/views/dashboard.js'
import * as providers from './js/views/providers.js'
import * as models from './js/views/models.js'
import * as clients from './js/views/clients.js'
import * as observability from './js/views/observability.js'
import * as settings from './js/views/settings.js'
import * as aggregation from './js/views/aggregation.js'

const views = { overview: dashboard, providers, models, clients, observability, settings, aggregation }
let currentRoute = 'overview'
let refreshing = false

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
    const bad = open > 0 || Number(s.global?.errors) > 0
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

// 401/403：清掉所有已渲染的敏感投影（配置、目录、额度、历史），再跳登录。绝不保留 stale 数据。
export function clearControlPlaneDom() {
  const root = document.getElementById('view-root')
  if (root) clear(root)
  const dialogRoot = document.getElementById('dialog-root')
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

function renderLocked(message) {
  const root = document.getElementById('view-root')
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
  const view = views[route] || views.overview
  const root = document.getElementById('view-root')
  if (!root) return
  // 数据未到达（首次/刷新/切路由）必须先渲染 loading 骨架，不能用旧数据顶替。
  if (phaseOf('status') === 'loading' || phaseOf('config') === 'loading') { renderLoading(); return }
  clear(root)
  document.getElementById('current-view').textContent = (ROUTES.find((r) => r.id === route) || ROUTES[0]).title
  document.querySelectorAll('.nav-link').forEach((b) => {
    const on = b.dataset.route === route
    b.classList.toggle('is-active', on)
    if (on) b.setAttribute('aria-current', 'page')
    else b.removeAttribute('aria-current')
  })
  if (!state.status) {
    if (phaseOf('status') === 'error') { renderFatal(state.lastError || new Error('读取状态失败')); return }
    renderFatal(state.lastError || new Error('尚未加载状态（未知）'))
    return
  }
  try {
    view.render(root, { rerender: () => renderRoute(currentRoute) })
  } catch (e) {
    console.error(e)
    clear(root)
    root.append(callout('danger', h('strong', { text: '页面渲染失败：' }), e.message))
  }
  syncDirtyChip()
  updateChrome()
}

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
  document.querySelectorAll('.nav-link').forEach((b) => b.addEventListener('click', () => { location.hash = '#/' + b.dataset.route }))
  document.getElementById('refresh').addEventListener('click', manualRefresh)
  document.getElementById('theme-toggle').addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')
  })
  document.getElementById('auth-form').addEventListener('submit', unlock)
  on('unauthorized', onUnauthorized)
  window.addEventListener('mg:lock', () => { clearToken(); resetData(); renderFatal(new Error('控制台已锁定')); showAuth('控制台已锁定，请输入管理员令牌。') })
  window.addEventListener('beforeunload', (e) => { if (dirtyDraft()) { e.preventDefault(); e.returnValue = '' } })
  window.addEventListener('online', () => toast('网络已恢复', 'success'))
  window.addEventListener('offline', () => toast('网络已断开；控制台不会显示模拟数据', 'error'))
  startRouter((route) => {
    renderRoute(route)
    document.getElementById('view-root').focus({ preventScroll: true })
    window.scrollTo({ top: 0, behavior: 'instant' })
  })
  // Low-frequency status refresh only; config is never auto-reloaded over a draft.
  setInterval(async () => {
    if (document.visibilityState !== 'visible' || !state.status) return
    try {
      // 后台轮询必须静默：不进入 loading phase，避免把正在阅读的视图替换成骨架。
      await loadStatus({ silent: true })
      updateChrome()
      if (currentRoute === 'overview' && document.getElementById('dialog-root').hidden) renderRoute(currentRoute)
    } catch (e) {
      if (e && e.status === 401) return
    }
  }, 15000)
}

// 测试可设置 globalThis.__MG_UI_TEST__ = true 后 import 本模块，只验证导出的纯/DOM 函数，不启动引导。
if (!globalThis.__MG_UI_TEST__) {
  wire()
  bootstrap()
}
