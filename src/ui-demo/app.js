// ModelGate 简约交互演示：模式 / 图表 / 设置 三个功能区。
// 只读快照 + 模式页的显式 consent 写入；不改 /ui-next、不重启网关。
import { el, clear, qs, qsa } from './js/dom.js'
import { getJson, postRaw } from './js/api.js'
import {
  DEFAULTS, applySettings, loadSettings, normalizeSettings, saveSettings,
} from './js/settings.js'
import { bucketSeries, metricAvailable, modelNames, providerMap } from './js/data.js'
import {
  MODE_ORDER, buildReconcileConfirmBody, buildReconcilePreviewBody,
  buildRollbackConfirmBody, buildRollbackPreviewBody,
  buildSwitchConfirmBody, buildSwitchPreviewBody,
  classifyModeResponse, modeMeta, snapshotOf,
} from './js/mode.js'
import { renderMode, buildModeDialog } from './js/mode-view.js'
import { renderCharts } from './js/charts-view.js'
import { renderSettings } from './js/settings-view.js'
import { fmtDuration } from './js/format.js'

const VIEWS = ['mode', 'charts', 'settings']
const initialSettings = loadSettings()
const state = {
  view: 'mode',
  settings: initialSettings,
  status: null,
  stats: null,
  modes: null,
  health: null,
  logs: [],
  errors: { status: '', stats: '', modes: '', logs: '' },
  modesUnavailable: false,
  loading: false,
  loadedAt: null,
  seq: 0,
  statsSeq: 0,
  modeUi: {
    selection: { mode: '', parentModel: '' },
    busy: false,
    error: '',
    receipt: null,
  },
  chart: {
    range: initialSettings.defaultRange,
    metric: initialSettings.defaultMetric,
    type: initialSettings.defaultChart,
    provider: '',
    model: '',
    selected: null,
  },
}

let autoTimer = null
let dialogCleanup = null

const ctx = {
  state,
  get settings () { return state.settings },
  get chartState () { return state.chart },
  get modeUi () { return state.modeUi },
  setChart,
  setModeSelection,
  updateSetting,
  replaceSettings,
  resetSettings,
  previewMode,
  confirmMode,
  reloadStats,
  reloadModes,
  loadAll,
  showToast,
}

function routeFromHash () {
  const raw = String(location.hash || '').replace(/^#\/?/, '').split(/[/?]/)[0]
  return VIEWS.includes(raw) ? raw : 'mode'
}

function navigate (view) {
  if (!VIEWS.includes(view)) return
  location.hash = '#/' + view
}

function dialogOpen () {
  const root = qs('#dialog-root')
  return !!(root && root.hidden === false && root.firstElementChild)
}

function showToast (message, tone = 'info') {
  const stack = qs('#toasts')
  if (!stack) return
  const node = el('div', { class: 'toast toast-' + tone, role: 'status' }, message)
  stack.append(node)
  while (stack.children.length > 4) stack.firstElementChild.remove()
  setTimeout(() => { try { node.remove() } catch { /* 已移除 */ } }, 3600)
}

function updateTabs () {
  for (const view of VIEWS) {
    const tab = qs('#tab-' + view)
    if (tab) {
      tab.setAttribute('aria-selected', String(view === state.view))
      tab.tabIndex = view === state.view ? 0 : -1
    }
    const panel = qs('#view-' + view)
    if (panel) panel.hidden = view !== state.view
  }
}

function effectiveTheme () {
  if (state.settings.theme === 'dark' || state.settings.theme === 'light') return state.settings.theme
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function updateTopbar () {
  const live = qs('#live-chip')
  const liveText = qs('#live-text')
  if (live && liveText) {
    if (state.errors.status) { live.dataset.state = 'bad'; liveText.textContent = '离线' }
    else if (state.status) { live.dataset.state = 'ok'; liveText.textContent = '在线' }
    else { live.dataset.state = 'loading'; liveText.textContent = '连接中' }
  }
  const modeChip = qs('#mode-chip')
  if (modeChip) {
    const snap = snapshotOf(state.modes, state.health)
    if (snap.supported && snap.known) {
      modeChip.hidden = false
      modeChip.textContent = '接入 · ' + modeMeta(snap.mode).label
      modeChip.dataset.drifted = snap.drifted ? 'true' : 'false'
    } else {
      modeChip.hidden = true
    }
  }
  const theme = qs('#theme')
  if (theme) {
    const next = effectiveTheme() === 'dark' ? '浅色' : '深色'
    theme.setAttribute('aria-label', '切换到' + next + '主题')
    theme.title = '切换到' + next + '主题'
  }
  const refresh = qs('#refresh')
  if (refresh) {
    refresh.disabled = state.loading
    refresh.setAttribute('aria-busy', state.loading ? 'true' : 'false')
  }
}

function renderCurrent ({ force = false } = {}) {
  updateTabs()
  updateTopbar()
  if (!force && dialogOpen()) return
  const root = qs('#view-' + state.view)
  if (!root) return
  clear(root)
  try {
    if (state.view === 'mode') renderMode(root, ctx)
    else if (state.view === 'charts') renderCharts(root, ctx)
    else renderSettings(root, ctx)
  } catch (error) {
    clear(root)
    root.append(el('div', { class: 'callout callout-danger' },
      el('strong', { text: '视图渲染失败：' }), ' ' + (error && error.message ? error.message : String(error))))
  }
}

function initSelection () {
  const snap = snapshotOf(state.modes, state.health)
  const selection = state.modeUi.selection
  if (!selection.mode || !MODE_ORDER.includes(selection.mode)) {
    selection.mode = snap.known ? snap.mode : 'official'
  }
  if (!selection.parentModel && snap.parentModel) selection.parentModel = snap.parentModel
  if (selection.mode === 'aggregated' && !selection.parentModel) {
    selection.parentModel = (snap.parents[0] && snap.parents[0].id) || ''
  }
}

function ensureChartMetric () {
  if (!state.stats) return
  const meta = providerMap(state.status)
  const rows = bucketSeries(state.stats, modelNames(state.stats, {
    provider: state.chart.provider, model: state.chart.model, meta,
  }))
  if (state.chart.metric === 'requests' && !metricAvailable(rows, 'requests')) state.chart.metric = 'tokens'
  if (state.chart.metric === 'hitrate' && !metricAvailable(rows, 'hitrate')) state.chart.metric = 'tokens'
}

async function loadStats () {
  const seq = ++state.statsSeq
  const days = state.chart.range
  state.errors.stats = ''
  try {
    const stats = await getJson('/api/model-stats?days=' + days)
    if (seq !== state.statsSeq || days !== state.chart.range) return
    state.stats = stats
    ensureChartMetric()
  } catch (error) {
    if (seq !== state.statsSeq || days !== state.chart.range) return
    state.stats = null
    state.errors.stats = error.message
  }
  renderCurrent()
}

async function loadLogs () {
  try {
    const data = await getJson('/api/logs?lines=' + state.settings.logLines)
    state.logs = Array.isArray(data.lines) ? data.lines : []
    state.errors.logs = ''
  } catch (error) {
    state.logs = []
    state.errors.logs = error.message
  }
  renderCurrent()
}

async function loadAll ({ silent = false } = {}) {
  const seq = ++state.seq
  state.loading = true
  updateTopbar()
  const range = state.chart.range
  const lines = state.settings.logLines
  const results = await Promise.allSettled([
    getJson('/api/status'),
    getJson('/api/model-stats?days=' + range),
    getJson('/api/aggregation/modes'),
    getJson('/api/aggregation/health'),
    getJson('/api/logs?lines=' + lines),
  ])
  if (seq !== state.seq) return
  state.loading = false
  const [status, stats, modes, health, logs] = results

  if (status.status === 'fulfilled') { state.status = status.value; state.errors.status = '' }
  else { state.status = null; state.errors.status = status.reason.message }

  if (stats.status === 'fulfilled') { state.stats = stats.value; state.errors.stats = '' }
  else { state.stats = null; state.errors.stats = stats.reason.message }

  if (modes.status === 'fulfilled') {
    state.modes = modes.value
    state.errors.modes = ''
    state.modesUnavailable = false
  } else {
    state.modes = null
    if (modes.reason.status === 404) { state.modesUnavailable = true; state.errors.modes = '' }
    else state.errors.modes = modes.reason.message
  }

  if (health.status === 'fulfilled') state.health = health.value
  else state.health = null

  if (logs.status === 'fulfilled') { state.logs = Array.isArray(logs.value.lines) ? logs.value.lines : []; state.errors.logs = '' }
  else { state.logs = []; state.errors.logs = logs.reason.message }

  initSelection()
  ensureChartMetric()
  state.loadedAt = Date.now()
  renderCurrent()
  updateTopbar()
  if (!silent && state.errors.status) showToast('网关读取失败：' + state.errors.status, 'err')
}

async function reloadModes () {
  try {
    const modes = await getJson('/api/aggregation/modes')
    let health = null
    try { health = await getJson('/api/aggregation/health') } catch { health = null }
    state.modes = modes
    state.health = health
    state.errors.modes = ''
    state.modesUnavailable = false
    initSelection()
  } catch (error) {
    if (error.status === 404) { state.modes = null; state.modesUnavailable = true; state.errors.modes = '' }
    else state.errors.modes = error.message
  }
  renderCurrent({ force: true })
}

async function reloadStats () {
  await loadStats()
  renderCurrent({ force: true })
}

function setChart (partial) {
  const rangeChanged = partial && partial.range != null && partial.range !== state.chart.range
  Object.assign(state.chart, partial || {})
  if (rangeChanged) state.chart.selected = null
  if (rangeChanged) {
    renderCurrent({ force: true })
    loadStats()
  } else {
    ensureChartMetric()
    renderCurrent({ force: true })
  }
}

function setModeSelection (partial) {
  Object.assign(state.modeUi.selection, partial || {})
  if (state.modeUi.selection.mode === 'aggregated' && !state.modeUi.selection.parentModel) {
    const snap = snapshotOf(state.modes, state.health)
    state.modeUi.selection.parentModel = (snap.parents[0] && snap.parents[0].id) || snap.parentModel || ''
  }
  renderCurrent({ force: true })
}

function restartAutoRefresh () {
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null }
  const seconds = Number(state.settings.autoRefresh) || 0
  if (seconds > 0) {
    autoTimer = setInterval(() => {
      if (document.hidden || dialogOpen()) return
      loadAll({ silent: true })
    }, seconds * 1000)
  }
}

function updateSetting (key, value) {
  const next = normalizeSettings(Object.assign({}, state.settings, { [key]: value }))
  state.settings = next
  saveSettings(next)
  applySettings(next)
  if (key === 'defaultRange') { state.chart.range = next.defaultRange; state.chart.selected = null }
  if (key === 'defaultChart') state.chart.type = next.defaultChart
  if (key === 'defaultMetric') state.chart.metric = next.defaultMetric
  if (key === 'autoRefresh') restartAutoRefresh()
  if (key === 'defaultRange') {
    renderCurrent({ force: true })
    loadStats()
    return
  }
  if (key === 'logLines') loadLogs()
  ensureChartMetric()
  renderCurrent({ force: true })
}

function replaceSettings (input) {
  const next = normalizeSettings(input)
  state.settings = next
  saveSettings(next)
  applySettings(next)
  state.chart.range = next.defaultRange
  state.chart.type = next.defaultChart
  state.chart.metric = next.defaultMetric
  state.chart.selected = null
  restartAutoRefresh()
  renderCurrent({ force: true })
  loadStats()
  loadLogs()
  showToast('设置已导入并应用', 'ok')
}

function resetSettings () {
  replaceSettings(DEFAULTS)
  showToast('已恢复默认设置', 'ok')
}

function toggleTheme () {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark'
  updateSetting('theme', next)
}

function modeDialogTitle (kind, selection) {
  if (kind === 'switch') return '预览：切换到「' + modeMeta(selection && selection.mode).label + '」'
  if (kind === 'rollback') return '预览：回滚到「' + modeMeta(selection && selection.mode).label + '」'
  return '预览：采纳当前配置为基线'
}

function openDialog ({ title, build }) {
  const root = qs('#dialog-root')
  if (!root) return
  const lastFocus = document.activeElement
  root.hidden = false
  document.body.classList.add('dialog-open')
  const panel = el('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title })
  const closeButton = el('button', { class: 'btn btn-icon', type: 'button', 'aria-label': '关闭对话框', text: '×' })
  const body = el('div', { class: 'dialog-body' })
  panel.append(
    el('div', { class: 'dialog-head' },
      el('h2', { text: title }),
      closeButton),
    body)
  root.replaceChildren(panel)

  const close = () => {
    if (dialogCleanup) { dialogCleanup(); dialogCleanup = null }
    root.hidden = true
    root.replaceChildren()
    document.body.classList.remove('dialog-open')
    if (lastFocus && typeof lastFocus.focus === 'function') { try { lastFocus.focus() } catch {} }
    renderCurrent({ force: true })
  }
  const onKey = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); close(); return }
    if (event.key !== 'Tab') return
    const focusables = qsa('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]', panel)
      .filter((node) => node.offsetParent !== null)
    if (!focusables.length) return
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }
  const onBackdrop = (event) => { if (event.target === root) close() }
  document.addEventListener('keydown', onKey, true)
  root.addEventListener('click', onBackdrop)
  closeButton.addEventListener('click', close)
  dialogCleanup = () => {
    document.removeEventListener('keydown', onKey, true)
    root.removeEventListener('click', onBackdrop)
  }
  build(body, close)
  setTimeout(() => {
    const target = panel.querySelector('button:not([disabled]), input:not([disabled]), select:not([disabled])')
    if (target) target.focus()
  }, 0)
}

function openModePreview (kind, selection, preview) {
  openDialog({
    title: modeDialogTitle(kind, selection),
    build: (body, close) => buildModeDialog(body, close, ctx, { kind, selection, preview }),
  })
}

async function previewMode (kind, selection) {
  if (state.modeUi.busy) return
  state.modeUi.busy = true
  state.modeUi.error = ''
  renderCurrent({ force: true })
  const endpoint = kind === 'switch' ? '/api/aggregation/switch' : kind === 'rollback' ? '/api/aggregation/rollback' : '/api/aggregation/reconcile'
  const body = kind === 'switch'
    ? buildSwitchPreviewBody(selection && selection.mode, selection && selection.parentModel)
    : kind === 'rollback'
      ? buildRollbackPreviewBody()
      : buildReconcilePreviewBody()
  try {
    const response = await postRaw(endpoint, body)
    const result = classifyModeResponse(response.status, response.data)
    state.modeUi.busy = false
    if ((result.kind === 'preview' || result.kind === 'blocked') && result.preview) {
      state.modeUi.error = result.kind === 'blocked' ? (result.message || '前置条件未满足') : ''
      renderCurrent({ force: true })
      openModePreview(kind, selection, result.preview)
      return
    }
    state.modeUi.error = result.kind === 'blocked'
      ? ((result.blocked || []).map((b) => (b && (b.message || b.code)) || 'blocked').join('；') || result.message || '前置条件未满足')
      : result.message || '没有取得预览（服务端未返回 428 preview）'
    renderCurrent({ force: true })
  } catch (error) {
    state.modeUi.busy = false
    state.modeUi.error = error && error.message ? error.message : String(error)
    renderCurrent({ force: true })
  }
}

async function confirmMode (kind, selection, preview) {
  const endpoint = kind === 'switch' ? '/api/aggregation/switch' : kind === 'rollback' ? '/api/aggregation/rollback' : '/api/aggregation/reconcile'
  const body = kind === 'switch'
    ? buildSwitchConfirmBody(preview, selection && selection.mode, selection && selection.parentModel)
    : kind === 'rollback'
      ? buildRollbackConfirmBody(preview)
      : buildReconcileConfirmBody(preview)
  const response = await postRaw(endpoint, body)
  const result = classifyModeResponse(response.status, response.data)
  if (result.kind === 'applied') {
    state.modeUi.receipt = Object.assign({}, result.receipt, {
      mode: result.receipt.mode || (selection && selection.mode) || '',
    })
    state.modeUi.error = ''
    showToast(kind === 'reconcile' ? '基线已更新；未修改 config.toml' : '已写入；请完全退出并重开 Codex', 'ok')
    await loadAll({ silent: true })
  }
  return result
}

function bind () {
  const refresh = qs('#refresh')
  if (refresh) refresh.addEventListener('click', () => loadAll())
  const theme = qs('#theme')
  if (theme) theme.addEventListener('click', toggleTheme)
  const tablist = qs('.tabs')
  if (tablist) {
    tablist.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const index = VIEWS.indexOf(state.view)
      const next = event.key === 'Home' ? 0
        : event.key === 'End' ? VIEWS.length - 1
          : event.key === 'ArrowLeft' ? (index - 1 + VIEWS.length) % VIEWS.length
            : (index + 1) % VIEWS.length
      navigate(VIEWS[next])
      const tab = qs('#tab-' + VIEWS[next])
      if (tab) tab.focus()
    })
  }
  window.addEventListener('hashchange', () => {
    state.view = routeFromHash()
    renderCurrent({ force: true })
    window.scrollTo({ top: 0, behavior: 'auto' })
  })
  if (window.matchMedia) {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    if (media.addEventListener) media.addEventListener('change', () => { updateTopbar() })
  }
}

function init () {
  applySettings(state.settings)
  if (!location.hash || !VIEWS.includes(routeFromHash())) {
    try { history.replaceState(null, '', '#/mode') } catch { location.hash = '#/mode' }
  }
  state.view = routeFromHash()
  bind()
  updateTabs()
  updateTopbar()
  restartAutoRefresh()
  renderCurrent({ force: true })
  loadAll()
}

init()
