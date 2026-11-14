// Security & Settings: instance facts, admin token, resilience defaults, versioned save, export.
import { h, clear } from '../dom.js'
import { state, loadAuth, loadAll } from '../store.js'
import { api } from '../api.js'
import { setToken, clearToken, getToken } from '../api.js'
import { ensureDraft, setDraft, peekDraft } from '../config-draft.js'
import { reviewAndSave, dirtyChip, sanitizeDiff, sourceSummary, expiryStates } from '../save-flow.js'
import { pageHead, card, callout, field, codeBlock, copyButton, kvList, tag, dialog, toast, confirmDialog } from '../components.js'
import { fmtTime, fmtDuration, fmtInt, pretty, maskHeaderValue, maskValue, clone } from '../format.js'

function numField(draft, obj, key, label, help) {
  const input = h('input', { type: 'number', min: '0', step: '1', value: obj[key] == null ? '' : String(obj[key]) })
  input.addEventListener('change', () => {
    const v = input.value === '' ? 0 : Number(input.value)
    obj[key] = Number.isFinite(v) && v >= 0 ? v : 0
    input.value = String(obj[key])
    draftChanged(draft)
  })
  return field(label, input, { help })
}
function textField(draft, obj, key, label, help, placeholder) {
  const input = h('input', { type: 'text', value: obj[key] == null ? '' : String(obj[key]), placeholder: placeholder || '' })
  input.addEventListener('change', () => { obj[key] = input.value.trim(); draftChanged(draft) })
  return field(label, input, { help })
}
function draftChanged(draft) {
  const chip = document.getElementById('dirty-chip-slot')
  if (chip) { clear(chip); const c = dirtyChip(draft.isDirty()); if (c) chip.append(c) }
  const btn = document.getElementById('save-defaults')
  if (btn) btn.disabled = !draft.isDirty()
}

// 管理面导出：脱敏后的可编辑配置投影；不包含服务端私有/凭据字段（投影本身就不含 _keys）。
export function sanitizeForExport(config) {
  const out = clone(config)
  out.defaults = out.defaults || {}
  if (out.defaults.clientKey) out.defaults.clientKey = '********'
  for (const p of Object.values(out.providers || {})) {
    if (p.extraHeaders) {
      const headers = {}
      for (const [k, v] of Object.entries(p.extraHeaders)) headers[k] = maskHeaderValue(k, v)
      p.extraHeaders = headers
    }
    if (typeof p.proxy === 'string' && p.proxy) {
      try { const u = new URL(p.proxy); if (u.username) u.username = '****'; if (u.password) u.password = '****'; p.proxy = u.toString() } catch {}
    }
  }
  return out
}
function downloadJson(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = h('a', { href: url, download: filename, style: { display: 'none' } })
  document.body.append(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1500)
  toast('已导出脱敏配置 JSON', 'success')
}

export function render(root, ctx = {}) {
  const s = state.status || {}
  const c = state.config || {}
  if (!state.config) {
    root.append(pageHead('安全与设置', '配置投影尚未读取；本页不显示伪造的默认值。', { eyebrow: 'GOVERNANCE / SETTINGS' }))
    root.append(callout('warn', h('strong', { text: '未知：' }), 'GET /api/config 尚未返回；无法展示可编辑配置、草稿差异或导出。'))
    return
  }
  const d = ensureDraft(c)
  const rerender = ctx.rerender || (() => { location.hash = '#/settings' })

  root.append(pageHead('安全与设置', '核对实例信息、管理令牌、韧性参数与配置事务。所有写操作都经过同源管理 API 与版本校验。', {
    eyebrow: 'GOVERNANCE / SETTINGS',
    actions: [h('button', { class: 'btn', type: 'button', text: '重新加载配置', onclick: async () => {
      try { await api.reloadConfig(); await loadAll(); toast('配置已从磁盘重新加载', 'success'); rerender() } catch (e) { toast('重新加载失败：' + e.message, 'error') }
    } })],
  }))

  const info = card('实例信息', '来自 /api/status 与 /api/config', kvList([
    ['访问地址', location.origin],
    ['绑定主机', s.server?.host || '—'],
    ['端口', String(s.server?.port || '—')],
    ['进程启动', fmtTime(s.startedAt)],
    ['运行时长', fmtDuration(s.uptimeMs)],
    ['配置版本', String(c.configVersion ?? s.configVersion ?? '—')],
    ['管理令牌', state.auth.needAuth ? '已启用' : '未启用'],
    ['密钥文件加密', s.server?.keyEncrypted ? '已启用' : '未确认'],
    ['目录来源', s.codex && s.codex.catalog ? ((s.codex.catalog.path || '路径未知') + (s.codex.catalog.generatedAt ? ' · ' + s.codex.catalog.generatedAt : '')) : '目录来源未知'],
  ]))

  const tokenInput = h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: '输入新令牌（留空则清除面板令牌）' })
  const tokenBtn = h('button', { class: 'btn', type: 'button', text: '更新管理令牌' })
  tokenBtn.addEventListener('click', async () => {
    const value = tokenInput.value.trim()
    const ok = await confirmDialog({
      title: value ? '更新管理令牌' : '清除面板管理令牌',
      message: value ? '更新后，当前会话会立即使用新令牌；其他已打开的控制台需要重新输入。' : '将清除由面板写入的令牌。若环境变量 MG_ADMIN_TOKEN 存在，管理面仍会要求认证。',
      confirmLabel: '确认更新', danger: true,
    })
    if (!ok) return
    tokenBtn.disabled = true
    try {
      const res = await api.setAdminToken(value)
      if (value) setToken(value)
      tokenInput.value = ''
      const auth = await loadAuth()
      toast(res.needAuth ? '令牌设置已提交；管理面需要认证' : '管理令牌已清除', 'success')
      if (!res.needAuth) { try { await loadAll() } catch {} }
      rerender()
    } catch (e) {
      toast('令牌更新失败：' + e.message, 'error')
      tokenBtn.disabled = false
    }
  })
  const lockBtn = h('button', { class: 'btn', type: 'button', text: '锁定当前控制台', onclick: () => { clearToken(); window.dispatchEvent(new CustomEvent('mg:lock')) } })
  const tokenCard = card('管理令牌', '令牌只保存在本标签页内存，不写入浏览器持久存储',
    h('div', null,
      callout('info', '令牌优先级：环境变量 MG_ADMIN_TOKEN → server.adminToken → 面板写入。环境变量存在时，面板令牌不会覆盖它。'),
      field('新管理员令牌', tokenInput, { help: '至少建议 16 个字符；不要把真实令牌粘贴到日志或截图。' }),
      h('div', { class: 'flex flex-wrap' }, tokenBtn, lockBtn)),
    { foot: h('span', { text: state.auth.needAuth ? '当前：需要管理员令牌' : '当前：未启用令牌（仅本机可管理）' }) })

  root.append(h('div', { class: 'grid grid-main' }, info, tokenCard))

  // Resilience defaults (editable through the same versioned config transaction).
  const retry = (d.data.defaults.retry = d.data.defaults.retry || {})
  const timeout = (d.data.defaults.timeout = d.data.defaults.timeout || {})
  const concurrency = (d.data.defaults.concurrency = d.data.defaults.concurrency || {})
  const proxySel = h('select', null, ['auto', 'direct', 'global'].map((v) => h('option', { value: v, selected: (d.data.defaults.proxyMode || 'auto') === v, text: v })))
  proxySel.addEventListener('change', () => { d.data.defaults.proxyMode = proxySel.value; draftChanged(d) })
  const saveBtn = h('button', { class: 'btn btn-primary', id: 'save-defaults', type: 'button', text: '查看变更并保存', disabled: !d.isDirty() })
  saveBtn.addEventListener('click', () => reviewAndSave(d, { onSaved: () => { setDraft(null); rerender() }, onError: () => draftChanged(d) }))
  const paramsBody = h('div', null,
    h('div', { class: 'grid grid-3' },
      numField(d, retry, 'maxAttempts', '单上游最大尝试次数', 'retry.maxAttempts；0 或 1 表示不重试'),
      numField(d, retry, 'initialDelayMs', '初始退避（ms）', 'retry.initialDelayMs'),
      numField(d, retry, 'maxDelayMs', '最大退避（ms）', 'retry.maxDelayMs')),
    h('div', { class: 'grid grid-3' },
      numField(d, timeout, 'connectMs', '建连超时（ms）', 'timeout.connectMs'),
      numField(d, timeout, 'firstByteMs', '首字节超时（ms）', 'timeout.firstByteMs'),
      numField(d, timeout, 'idleMs', '空闲超时（ms）', 'timeout.idleMs')),
    h('div', { class: 'grid grid-3' },
      numField(d, timeout, 'overallMs', '整体预算（ms，0=不限）', 'timeout.overallMs；覆盖排队、上游与中继'),
      numField(d, timeout, 'loopMs', '目录链兜底循环（ms）', 'timeout.loopMs'),
      numField(d, concurrency, 'maxPerProvider', '每上游并发', 'concurrency.maxPerProvider')),
    h('div', { class: 'grid grid-2' },
      field('代理模式', proxySel, { help: 'auto=按上游配置；direct=全部直连；global=非回环上游走全局代理' }),
      textField(d, d.data.defaults, 'proxy', '全局代理地址', '留空=继承环境变量；支持 http(s)://user:pass@host:port')),
    h('div', { class: 'flex flex-wrap mt-3', style: { justifyContent: 'space-between' } },
      h('div', { class: 'flex', id: 'dirty-chip-slot' }, dirtyChip(d.isDirty())),
      h('div', { class: 'flex' },
        h('button', { class: 'btn', type: 'button', text: '放弃更改', onclick: () => { d.reset(); rerender() } }),
        saveBtn)))
  const params = card('请求韧性参数', '修改后不会立即生效，需保存配置并重新加载路由', paramsBody,
    { foot: h('span', { text: '保存会推进 configVersion；并发修改返回 409，不会静默覆盖。' }) })
  root.append(h('div', { class: 'mt-4' }, params))

  const nativeSave = h('button', { class: 'btn btn-primary', type: 'button', text: '保存采集路径' })
  nativeSave.addEventListener('click', () => reviewAndSave(d, { onSaved: () => { setDraft(null); rerender() }, onError: () => draftChanged(d) }))
  const nu = s.nativeUsage || {}
  const nativeCard = card('原生 / 直连用量采集（只读）', '只汇总 Codex 本地会话日志的 token 计数；不读取消息内容，也不代理原生流量',
    h('div', null,
      callout('info', h('strong', { text: '为什么需要它：' }), ' 原生 ChatGPT/直连流量不经过网关，网关无法统计。开启后从 Codex sessions 日志只读汇总，并在「监控与诊断」中与代理流量分开展示。'),
      textField(d, d.data.defaults, 'nativeUsageDir', 'Codex sessions 目录', '例如 ~/.codex/sessions；留空或 off 关闭。只读取 session_meta/turn_context/token_count，不读取消息正文。', '~/.codex/sessions'),
      h('div', { class: 'flex flex-wrap mt-2' }, nativeSave),
      h('p', { class: 'hint', text: '当前生效：' + (nu.enabled ? '已启用 · ' + (nu.dirLabel || '—') : '未启用') + '。保存后需重新读取状态。' })),
    { foot: h('span', { text: '该目录由网关进程用户读取；不要指向包含凭据的目录。' }) })
  root.append(h('div', { class: 'mt-4' }, nativeCard))

  // 生效配置 vs 草稿：只展示脱敏差异（secret 只显示已设置/已修改），并附后端有效期状态。
  const draftDiff = d.isDirty() ? sanitizeDiff(d.diff()) : []
  const expiries = expiryStates(c)
  const diffCard = card('生效配置 vs 草稿', '保存前核对；来源与版本见下，敏感值只显示状态不显示值。',
    h('div', null,
      callout('info', h('strong', { text: '来源：' }), ' ' + sourceSummary(d)),
      draftDiff.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'diff-table' },
          h('thead', null, h('tr', null, h('th', { text: '字段' }), h('th', { text: '生效值' }), h('th', { text: '草稿值' }))),
          h('tbody', null, draftDiff.slice(0, 200).map((row) => h('tr', null,
            h('td', { class: 'path', text: row.path }),
            h('td', { class: 'old', text: row.before }),
            h('td', { class: 'new', text: row.after }))))))
        : callout('good', '草稿与生效配置一致，没有待保存差异。'),
      expiries.length
        ? h('p', { class: 'hint', text: '虚拟模型有效期（后端 expiresAtState）：' + expiries.map((e) => e.name + '=' + e.state).join(' · ') })
        : null),
    { foot: '差异只在本标签页计算，不发送到服务端；保存请求只包含被动过的字段（未编辑字段不出现）。' })
  root.append(h('div', { class: 'mt-4' }, diffCard))

  const tx = card('配置事务与导出', '当前可编辑配置投影，不含明文 Key',
    h('div', null,
      callout('info', 'GET /api/config 只返回可编辑字段与 configVersion；运行时统计与凭据不在其中。保存时必须携带读取时的版本号。'),
      h('div', { class: 'flex flex-wrap' },
        copyButton(JSON.stringify({ configVersion: c.configVersion, providers: Object.keys(c.providers || {}).length, models: Object.keys(c.models || {}).length }), '复制版本摘要'),
        h('button', { class: 'btn', type: 'button', text: '导出管理配置投影（脱敏）', onclick: () => downloadJson('modelgate-config-' + (c.configVersion ?? 0) + '.json', sanitizeForExport(c)) }),
        h('button', { class: 'btn', type: 'button', text: '查看原始配置', onclick: () => dialog({ title: '只读配置投影', desc: '敏感 header 与代理凭据在前端显示时仍按原值；请勿截图分享。', wide: true, content: codeBlock(pretty(c)) }) }))))

  const backup = card('备份与恢复', '当前后端没有备份/恢复管理 API',
    h('div', null,
      callout('info', h('strong', { text: '旧面板仍可用：' }), ' /admin（旧 UI）作为回退入口保留。退役条件：核心操作与本页等价、双跑通过、真实浏览器 E2E 有证据；在此之前不得删除旧面板。'),
      callout('warn', h('strong', { text: '恢复功能未实现，页面不会伪装成功。' }), ' 网关配置以原子写落盘；需要回滚时请使用文件系统备份（git 不跟踪 gateway.local.json 与 keys.local.json）。'),
      h('p', { class: 'hint', text: '可安全导出的只有脱敏编辑配置；密钥文件加密后不应随普通备份外传。恢复操作应在停机窗口内由运维手动完成，并保留旧文件。' })))

  root.append(h('div', { class: 'grid grid-main mt-4' }, tx, backup))
}
