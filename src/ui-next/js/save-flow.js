// Shared save flow: diff preview -> versioned save -> 409 conflict resolution.
import { h, clear, mount } from './dom.js'
import { dialog, toast, callout } from './components.js'
import { ConflictError } from './config-draft.js'
import { state, loadAll, loadConfig } from './store.js'
import { shortValue } from './format.js'

function diffTable(diff) {
  const rows = diff.slice(0, 400).map((d) => h('tr', null,
    h('td', { class: 'path', text: d.path }),
    h('td', { class: 'old', text: shortValue(d.before) }),
    h('td', { class: 'new', text: shortValue(d.after) })))
  return h('div', { class: 'table-wrap' }, h('table', { class: 'diff-table' },
    h('thead', null, h('tr', null, h('th', { text: '字段' }), h('th', { text: '原值' }), h('th', { text: '新值' }))),
    h('tbody', null, rows)))
}

export function reviewAndSave(draft, opts = {}) {
  const diff = draft.diff()
  if (!diff.length) { toast('没有需要保存的更改', 'info'); return }
  const saving = h('button', { class: 'btn btn-primary', type: 'button', text: '保存 ' + diff.length + ' 项更改' })
  const body = h('div', null,
    callout('info', h('strong', { text: '保存前核对差异。' }), ' 保存会以配置版本 ' + draft.baseVersion + ' 提交；若其他窗口已保存，服务端返回 409，不会静默覆盖。'),
    diffTable(diff))
  const d = dialog({ title: '确认保存配置', desc: '只提交可编辑配置字段；未知扩展字段会原样保留。', wide: true, content: body, actions: [
    h('button', { class: 'btn', type: 'button', text: '继续编辑', onclick: () => d.close() }), saving,
  ] })
  saving.addEventListener('click', async () => {
    saving.disabled = true
    saving.textContent = '正在保存…'
    try {
      const res = await draft.save()
      d.close()
      toast('配置已保存 · 版本 ' + res.version, 'success')
      await loadAll()
      opts.onSaved && opts.onSaved(res)
    } catch (e) {
      d.close()
      if (e instanceof ConflictError) showConflict(draft, e, opts)
      else toast('保存失败：' + (e && e.message ? e.message : '未知错误'), 'error')
      opts.onError && opts.onError(e)
    }
  })
}

export function showConflict(draft, err, opts = {}) {
  const reload = h('button', { class: 'btn btn-primary', type: 'button', text: '重新加载远端配置' })
  const keep = h('button', { class: 'btn', type: 'button', text: '保留草稿，稍后人工合并' })
  const d = dialog({
    title: '配置已被其他窗口修改',
    desc: '检测到版本冲突，本次保存未写入。',
    content: h('div', null,
      callout('warn', h('strong', { text: '服务端当前版本：' }), String(err.currentVersion ?? '未知'), '；你的草稿基于版本 ', String(draft.baseVersion), '。'),
      h('p', { class: 'muted', text: '建议先重新加载远端配置，再决定是否重新应用你的修改。页面不会自动覆盖远端内容。' })),
    actions: [keep, reload],
  })
  keep.addEventListener('click', () => d.close())
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
