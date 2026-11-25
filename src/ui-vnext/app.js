import { state, refresh, subscribe, selectDraftMode, updateDraft, restoreStaleDrafts, discardDrafts } from './js/store.js'
import { startRouter, routeFromHash, routePath, routeKey, primaryRoute, breadcrumbTrail, titleOf, rememberPosition, restorePosition } from './js/router.js'
import { getPreferences, applyPreferences, savePreferences } from './js/preferences.js'
import { h, button, icon, errorState, loading } from './js/components/index.js'
import { renderCodexPanel, renderModePage } from './js/pages/mode.js'
import { renderHarness } from './js/pages/harness.js'
import { renderServices } from './js/pages/services.js'
import { renderPools } from './js/pages/pools.js'
import { renderUsage } from './js/pages/usage.js'
import { renderReliability } from './js/pages/reliability.js'
import { renderSettings } from './js/pages/settings.js'
import { renderServiceDetail, renderAccountDetail, renderPoolTab, renderAdvanced } from './js/pages/secondary-pages.js'

const MAIN_IDS = ['harness', 'services', 'pools', 'usage', 'reliability', 'settings']
const LABELS = ['应用接入', '模型服务', '模型池', '用量分析', '稳定性策略', '设置']
const RENDERERS = { harness: renderHarness, mode: renderModePage, services: renderServices, pools: renderPools, usage: renderUsage, reliability: renderReliability, settings: renderSettings }
const main = document.getElementById('main')
let route = routeFromHash()
let currentRouteKey = routeKey()
let routeEpoch = 0
let rendering = false
let renderQueued = false

function captureFocus() {
  const active = document.activeElement
  if (!(active instanceof HTMLElement) || active === document.body || active === main || !main.contains(active) || document.querySelector('dialog[open]')) return null
  const parts = []
  for (let node = active; node && node !== main; node = node.parentElement) {
    const sameTag = [...node.parentElement.children].filter((child) => child.localName === node.localName)
    parts.unshift(node.localName + (sameTag.length > 1 ? ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')' : ''))
  }
  const selection = typeof active.selectionStart === 'number' ? { start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection } : null
  return { selector: parts.join(' > '), selection }
}

function restoreFocus(snapshot) {
  if (!snapshot) return
  const active = main.querySelector(snapshot.selector)
  if (!(active instanceof HTMLElement) || active.disabled) return
  active.focus({ preventScroll: true })
  if (snapshot.selection && typeof active.setSelectionRange === 'function') {
    try { active.setSelectionRange(snapshot.selection.start, snapshot.selection.end, snapshot.selection.direction) } catch { /* Some input types do not expose a selection. */ }
  }
}

function toast(message, tone = '') {
  const stack = document.getElementById('toasts')
  stack.classList.remove('hidden')
  stack.replaceChildren(h('div', { class: 'toasttext14', role: tone === 'error' ? 'alert' : 'status', text: message }))
  stack.classList.toggle('error', tone === 'error')
  stack.classList.toggle('success', tone === 'success')
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => { stack.classList.add('hidden'); stack.replaceChildren() }, 4500)
}

function renderNav(caps) {
  const path = routePath()
  const selected = primaryRoute(route, path.query)
  const nav = document.getElementById('primary-nav')
  const items = MAIN_IDS.map((id, index) => h('button', {
    type: 'button', class: 'navbtn' + (selected === id ? ' active' : ''), 'data-route': id,
    'aria-label': LABELS[index], 'aria-current': selected === id ? 'page' : undefined,
    onClick: () => { location.hash = '#/' + id },
  }, icon(id), h('span', { text: LABELS[index] })))
  nav.replaceChildren(h('div', { class: 'navgroup', text: '工作台' }), ...items.slice(0, 4), h('div', { class: 'navgroup', text: '系统' }), ...items.slice(4))
  const advanced = caps ? caps.navigation.advanced : []
  document.getElementById('advanced-links').replaceChildren(...advanced.map((item) => {
    const id = item.route.replace(/^#\//, '')
    return h('a', { href: item.route, text: item.label, 'aria-current': route === id ? 'page' : undefined })
  }))
}

function renderBreadcrumb() {
  const path = routePath()
  const trail = breadcrumbTrail(route, path.query)
  document.getElementById('breadcrumb').replaceChildren(...trail.flatMap((item, index) => [
    ...(index ? [h('span', { class: 'crumb-sep9', 'aria-hidden': 'true', text: '/' })] : []),
    index === trail.length - 1 ? h('span', { class: 'crumb-current9', 'aria-current': 'page', text: item.label }) : h('a', { href: item.href, text: item.label }),
  ]))
  document.title = titleOf(route) + ' · ModelGate Desktop V13.1'
}

function renderSidebar() {
  const node = document.getElementById('gateway-state')
  const labels = { loading: '正在连接', ready: '控制面已连接', partial: '部分数据不可用', error: '控制面错误', offline: '网关离线' }
  node.dataset.state = state.phase
  node.replaceChildren(h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', { text: labels[state.phase] || '状态未知' }))
  document.getElementById('gateway-detail').textContent = state.checkedAt ? '快照 ' + new Date(state.checkedAt).toLocaleTimeString('zh-CN') : (state.errors.core ? state.errors.core.message : '尚未取得快照')
  const runtime = document.getElementById('runtime-tag')
  runtime.textContent = state.capabilities ? 'v' + state.capabilities.build.packageVersion + ' · 配置代际 ' + state.capabilities.runtime.configVersion : '未取得版本'
}

function render() {
  if (rendering) { renderQueued = true; return }
  rendering = true
  const top = main.scrollTop
  const focus = captureFocus()
  try {
    renderNav(state.capabilities)
    renderBreadcrumb()
    renderSidebar()
    if (!state.capabilities) {
      main.replaceChildren(state.errors.core ? errorState(state.errors.core, doRefresh) : loading())
      return
    }
    const actions = {
      navigate: (id) => { location.hash = '#/' + id },
      refresh: doRefresh,
      render,
      route: () => route,
      routeEpoch: () => routeEpoch,
      toast,
      selectDraftMode,
      updateDraft,
      restoreStaleDrafts,
      discardDrafts,
      preferences: (prefs) => {
        const result = savePreferences(prefs)
        toast(result.ok ? '界面偏好已保存' : '偏好仅用于当前页面：浏览器存储不可用', result.ok ? 'success' : 'error')
        render()
      },
    }
    const content = route === 'service-detail' ? renderServiceDetail(state, actions)
      : route === 'account-detail' ? renderAccountDetail(state, actions)
      : route === 'pool-strategy' ? renderPoolTab(state, actions, 'strategy')
      : route === 'pool-apps' ? renderPoolTab(state, actions, 'apps')
      : route === 'pool-test' ? renderPoolTab(state, actions, 'test')
      : ['service-models', 'models', 'routing', 'reliability-detail', 'clients', 'logs'].includes(route) ? renderAdvanced(state, actions, route)
      : RENDERERS[route](state, actions)
    main.replaceChildren(content)
    restoreFocus(focus)
    requestAnimationFrame(() => { main.scrollTop = top })
  } finally {
    rendering = false
    if (renderQueued) {
      renderQueued = false
      requestAnimationFrame(render)
    }
  }
}

function doRefresh() {
  return refresh().then(render)
}

function changeRoute(next) {
  const nextKey = routeKey()
  if (next === route && nextKey === currentRouteKey) { render(); return }
  rememberPosition(currentRouteKey, main.scrollTop)
  route = next
  currentRouteKey = nextKey
  routeEpoch += 1
  render()
  requestAnimationFrame(() => { main.scrollTop = restorePosition(currentRouteKey) })
}

applyPreferences(getPreferences())
renderNav(null)
renderBreadcrumb()
document.getElementById('refresh').addEventListener('click', doRefresh)
document.getElementById('theme-toggle').addEventListener('click', () => {
  const current = document.documentElement.dataset.theme
  const prefs = getPreferences()
  const result = savePreferences({ ...prefs, theme: current === 'dark' ? 'light' : 'dark' })
  toast(result.ok ? '主题已切换' : '主题已应用于当前页面，但无法保存', result.ok ? 'success' : 'error')
})
document.getElementById('advanced-nav').addEventListener('toggle', (event) => {
  const prefs = getPreferences()
  const result = savePreferences({ ...prefs, advanced: event.target.open })
  if (!result.ok) toast('高级导航偏好无法保存', 'error')
})
subscribe(render)
startRouter(changeRoute)
doRefresh()
setInterval(() => { if (!document.hidden && state.capabilities) doRefresh() }, 15000)
