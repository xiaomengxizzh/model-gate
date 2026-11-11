// Shared save flow: diff preview -> versioned save -> 409 conflict resolution -> retry.
// M4-2：差异展示脱敏、来源/版本可见、保存去抖；冲突绝不覆盖用户草稿。
import { h } from './dom.js'
import { dialog, toast, callout } from './components.js'
import { ConflictError, buildSavePayload } from './config-draft.js'
import { state, loadAll, loadConfig, phaseOf } from './store.js'
import { shortValue, maskHeaderValue } from './format.js'

const SECRET_PATH_RE = /(^|\.)(clientKey|password|secret|token|authorization|auth|apiKey|api_key|credential|session)$/i
const HEADER_PATH_RE = /(^|\.)extraHeaders(\.|$)/i

function maskProxy(value) {
  if (typeof value !== 'string' || !value) return value
  try { const u = new URL(value); if (u.username) u.username = '****'; if (u.password) u.password = '****'; return u.toString() } catch { return '已设置（已脱敏）' }
}

// 差异行脱敏：secret 只显示“已设置/已修改/已清空”，绝不显示值本身。
export function sanitizeDiff(diff) {
  return (Array.isArray(diff) ? diff : []).map((entry) => {
    const path = String(entry.path || '')
    const row = { path, before: entry.before, after: entry.after, masked: false }
    if (HEADER_PATH_RE.test(path)) {
      row.masked = true
      row.before = entry.before == null || entry.before === '' ? '未设置' : '已设置'
      row.after = entry.after == null || entry.after === '' ? '已移除' : '已修改（值已脱敏）'
      return row
    }
    if (SECRET_PATH_RE.test(path)) {
      row.masked = true
      if (path.endsWith('clientKey')) {
        row.before = entry.before === '********' ? '已设置' : (entry.before ? '已设置（迁移/旧值）' : '未设置')
        row.after = entry.after === '' ? '已清空' : (entry.after === '********' ? '未改动' : '已修改（值不显示）')
        return row
      }
      row.before = entry.before ? '已设置' : '未设置'
      row.after = entry.after ? '已修改' : '已移除'
      return row
    }
    if (/proxy$/i.test(path)) {
      row.before = maskProxy(entry.before)
      row.after = maskProxy(entry.after)
      return row
    }
    row.before = shortValue(entry.before)
    row.after = shortValue(entry.after)
    return row
  })
}

function diffTable(rows) {
  const trs = rows.slice(0, 400).map((d) => h('tr', null,
    h('td', { class: 'path', text: d.path }),
    h('td', { class: 'old', text: d.before }),
    h('td', { class: 'new', text: d.after })))
  return h('div', { class: 'table-wrap' }, h('table', { class: 'diff-table' },
    h('thead', null, h('tr', null, h('th', { text: '字段' }), h('th', { text: '原值' }), h('th', { text: '新值' }))),
    h('tbody', null, trs)))
}

// 来源与代际：让用户知道自己在改哪一代配置、目录来自哪里。
export function sourceSummary(draft) {
  const projectionVersion = Number(state.config?.configVersion ?? NaN)
  const runtimeVersion = Number(state.status?.configVersion ?? NaN)
  const catalog = state.status && state.status.codex && state.status.codex.catalog
  const catalogText = catalog
    ? ('目录来源 ' + (catalog.path || '未返回路径') + (catalog.generatedAt ? ' · 生成于 ' + catalog.generatedAt : ''))
    : '目录来源未知（/api/status 未返回 codex.catalog）'
  return '草稿基于版本 ' + (draft ? draft.baseVersion : '未知') +
    ' · 可编辑投影版本 ' + (Number.isFinite(projectionVersion) ? projectionVersion : '未知') +
    ' · 运行版本 ' + (Number.isFinite(runtimeVersion) ? runtimeVersion : '未知') +
    ' · ' + catalogText
}

// 虚拟模型有效期状态：只使用后端投影的 expiresAtState（M0-2 单一真源）。
export function expiryStates(config) {
  const list = (config && Array.isArray(config.virtualModels)) ? config.virtualModels : []
  return list.map((v) => ({
    name: v && v.name,
    state: v && v.expiresAtState ? v.expiresAtState : 'unknown',
    expiresAt: v && v.expiresAt ? v.expiresAt : '',
  }))
}

// 保存去抖：同一草稿的并发保存共享同一个 Promise，避免重复提交。
const inflight = new WeakMap()
export function saveDraft(draft) {
  if (!draft) return Promise.reject(new Error('缺少配置草稿'))
  const existing = inflight.get(draft)
  if (existing) return existing
  let promise
  promise = Promise.resolve().then(() => draft.save()).finally(() => {
    if (inflight.get(draft) === promise) inflight.delete(draft)
  })
  inflight.set(draft, promise)
  return promise
}

function saveErrorDialog(draft, err, opts) {
  const message = err && err.message ? err.message : '未知错误'
  const retry = h('button', { class: 'btn btn-primary', type: 'button', text: '重试保存' })
  const cancel = h('button', { class: 'btn', type: 'button', text: '稍后再试', onclick: () => d.close() })
  const d = dialog({
    title: '保存失败',
    desc: '本次没有写入；草稿与版本号保持不变，可以重试。',
    content: h('div', null,
      callout('danger', h('strong', { text: '错误：' }), message),
      h('p', { class: 'muted', text: '重试会复用同一草稿与同一 baseVersion；保存按钮在请求进行中会被禁用，不会重复提交。' })),
    actions: [cancel, retry],
  })
  retry.addEventListener('click', async () => {
    retry.disabled = true
    retry.textContent = '正在重试…'
    try {
      const res = await saveDraft(draft)
      d.close()
      toast('配置已保存 · 版本 ' + res.version, 'success')
      await loadAll()
      opts.onSaved && opts.onSaved(res)
    } catch (e) {
      d.close()
      if (e instanceof ConflictError) showConflict(draft, e, opts)
      else saveErrorDialog(draft, e, opts)
      opts.onError && opts.onError(e)
    }
  })
}

export function reviewAndSave(draft, opts = {}) {
  const diff = draft.diff()
  if (!diff.length) { toast('没有需要保存的更改', 'info'); return }
  const rows = sanitizeDiff(diff)
  const saving = h('button', { class: 'btn btn-primary', type: 'button', text: '保存 ' + diff.length + ' 项更改' })
  const expiries = expiryStates(state.config)
  const body = h('div', null,
    callout('info', h('strong', { text: '保存前核对差异。' }), ' ' + sourceSummary(draft)),
    diffTable(rows),
    expiries.length
      ? h('p', { class: 'hint', text: '虚拟模型有效期状态（后端判定）：' + expiries.map((e) => e.name + '=' + e.state).join(' · ') })
      : null,
    h('p', { class: 'hint', text: '只提交可编辑配置字段；未编辑的字段（例如客户端 Key）不会出现在请求体里。未知扩展字段会原样保留。' }))
  const d = dialog({ title: '确认保存配置', desc: '服务端按版本号校验；若其他窗口已保存，会返回 409，不会静默覆盖。', wide: true, content: body, actions: [
    h('button', { class: 'btn', type: 'button', text: '继续编辑', onclick: () => d.close() }), saving,
  ] })
  saving.addEventListener('click', async () => {
    saving.disabled = true
    saving.textContent = '正在保存…'
    try {
      const res = await saveDraft(draft)
      d.close()
      toast('配置已保存 · 版本 ' + res.version, 'success')
      await loadAll()
      opts.onSaved && opts.onSaved(res)
    } catch (e) {
      d.close()
      if (e instanceof ConflictError) showConflict(draft, e, opts)
      else saveErrorDialog(draft, e, opts)
      opts.onError && opts.onError(e)
    }
  })
}

export function showConflict(draft, err, opts = {}) {
  const reload = h('button', { class: 'btn', type: 'button', text: '重新加载远端配置（放弃草稿）' })
  const keep = h('button', { class: 'btn', type: 'button', text: '保留草稿，稍后合并' })
  const retry = h('button', { class: 'btn btn-primary', type: 'button', text: '重试保存' })
  const d = dialog({
    title: '配置已被其他窗口修改',
    desc: '检测到版本冲突，本次保存未写入；你的草稿保持不变。',
    content: h('div', null,
      callout('warn', h('strong', { text: '服务端当前版本：' }), String(err.currentVersion ?? '未知'), '；你的草稿基于版本 ', String(draft.baseVersion), '。'),
      h('p', { class: 'muted', text: '重试会用同一草稿再次提交（若远端仍变化会继续 409）；重新加载才会用服务端值替换草稿 —— 页面不会自动覆盖远端内容，也不会自动丢弃你的输入。' })),
    actions: [keep, reload, retry],
  })
  keep.addEventListener('click', () => d.close())
  retry.addEventListener('click', async () => {
    retry.disabled = true
    retry.textContent = '正在重试…'
    try {
      const res = await saveDraft(draft)
      d.close()
      toast('配置已保存 · 版本 ' + res.version, 'success')
      await loadAll()
      opts.onSaved && opts.onSaved(res)
    } catch (e) {
      retry.disabled = false
      retry.textContent = '重试保存'
      if (e instanceof ConflictError) {
        d.close()
        showConflict(draft, e, opts)
      } else {
        d.close()
        saveErrorDialog(draft, e, opts)
      }
    }
  })
  reload.addEventListener('click', async () => {
    reload.disabled = true
    try {
      await loadConfig()
      draft.reload(state.config)
      d.close()
      toast('已加载远端配置，未保存的本地更改已放弃', 'success')
      opts.onReloaded && opts.onReloaded()
    } catch (e) {
      toast('重新加载失败：' + e.message, 'error')
      reload.disabled = false
    }
  })
}

export function dirtyChip(isDirty) {
  return isDirty ? h('span', { class: 'tag tag-warn', id: 'dirty-chip' }, h('span', { class: 'tag-dot' }), '有未保存更改') : null
}

export { buildSavePayload, maskHeaderValue, phaseOf }
