import { el, clear, callout, badge, append } from './dom.js'
import { shortSha } from './format.js'
import { MODE_ORDER, modeMeta, snapshotOf, previewSummary } from './mode.js'

function valueText (value) {
  if (value == null) return '—'
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) } catch { return String(value) }
}

function diffTone (kind) {
  return ({ add: ['新增', 'info'], remove: ['删除', 'warn'], del: ['删除', 'warn'], change: ['修改', 'warn'], update: ['修改', 'warn'] })[kind] || [String(kind || '变更'), 'muted']
}

function modeBadgeTone (mode) {
  return ({ official: 'muted', route: 'info', aggregated: 'accent' })[mode] || 'muted'
}

function currentPanel (snap, ctx) {
  const m = modeMeta(snap.mode)
  const restart = snap.health && snap.health.detect && snap.health.detect.restart
  const restartText = snap.needsRestart
    ? '需要完全退出并重开 Codex'
    : restart && restart.needed === false
      ? '已检测到重启'
      : '重启状态未知'

  const title = el('div', {},
    el('p', { class: 'eyebrow', text: 'CURRENT MODE / 当前接入方式' }),
    el('h2', {}, m.label, ' ', badge(snap.known ? '已识别' : '未知', snap.known ? modeBadgeTone(snap.mode) : 'warn')),
    el('p', { class: 'panel-sub', text: m.detail }))

  const status = el('div', { class: 'mode-current-meta' },
    snap.drifted ? badge('配置漂移', 'warn') : badge('基线一致', 'ok'),
    badge(restartText, snap.needsRestart ? 'warn' : restart && restart.needed === false ? 'ok' : 'muted'))

  const head = el('div', { class: 'panel-head' }, title, status)

  const facts = el('dl', { class: 'mode-facts' })
  facts.append(
    el('div', {}, el('dt', { text: '父模型' }), el('dd', { text: snap.parentModel || '—' })),
    el('div', {}, el('dt', { text: '子模型' }), el('dd', { text: snap.childModel || '—' })),
    el('div', {}, el('dt', { text: '上一模式' }), el('dd', { text: snap.previousMode ? modeMeta(snap.previousMode).label : '—' })),
    el('div', {}, el('dt', { text: '配置 SHA' }), el('dd', { class: 'mono', title: snap.appliedSha || '', text: shortSha(snap.appliedSha, ctx.settings.showTechnical) })),
    el('div', {}, el('dt', { text: '变更入口' }), el('dd', { class: 'mono', text: '~/.codex/config.toml' })))

  return el('section', { class: 'panel mode-current' }, head, facts)
}
function modeCards (snap, selection, ctx) {
  return el('fieldset', { class: 'mode-fieldset' },
    el('legend', { class: 'sr-only', text: '选择目标接入方式' }),
    MODE_ORDER.map((id) => {
      const meta = modeMeta(id)
      const checked = selection.mode === id
      const isCurrent = snap.mode === id
      const input = el('input', {
        type: 'radio', name: 'mode-choice', value: id, checked,
        onchange: () => ctx.setModeSelection({ mode: id }),
      })
      return el('label', { class: 'mode-card' + (checked ? ' is-checked' : '') + (isCurrent ? ' is-current' : '') },
        input,
        el('span', { class: 'mode-card-body' },
          el('span', { class: 'mode-card-head' },
            el('b', { text: meta.label }),
            isCurrent ? badge('当前', 'ok') : null),
          el('span', { class: 'mode-card-desc', text: meta.detail }),
          el('span', { class: 'mode-card-meta', text: meta.meta })))
    }))
}

function parentControl (snap, selection, ctx) {
  if (selection.mode !== 'aggregated') return null
  const parents = snap.parents
  const value = selection.parentModel || snap.parentModel || (parents[0] && parents[0].id) || ''
  if (!parents.length) {
    return callout('warn', el('strong', { text: '没有可选父模型：' }), ' 目录未提供候选；服务端会使用默认父模型。')
  }
  const selected = parents.find((p) => p.id === value) || parents[0]
  const select = el('select', { class: 'select', 'aria-label': '聚合父模型' },
    parents.map((p) => el('option', { value: p.id, selected: p.id === value, text: p.label + (p.realTest === 'PASS_REAL' ? '' : '（未实测）') })))
  select.addEventListener('change', () => ctx.setModeSelection({ parentModel: select.value }))
  return el('div', { class: 'field parent-field' },
    el('span', { class: 'field-label', text: '聚合父模型' }),
    select,
    selected.realTest === 'PASS_REAL'
      ? badge('PASS_REAL', 'ok')
      : badge('UNVERIFIED', 'warn'),
    el('p', { class: 'hint', text: '父模型只影响聚合模式的 GPT 侧；子模型固定为 DeepSeek 目标。' }))
}

export function renderMode (host, ctx) {
  const { state } = ctx
  const snap = snapshotOf(state.modes, state.health)
  const selection = ctx.modeUi.selection && ctx.modeUi.selection.mode
    ? ctx.modeUi.selection
    : { mode: snap.known ? snap.mode : 'official', parentModel: snap.parentModel }
  clear(host)

  host.append(el('section', { class: 'page-head' },
    el('div', {},
      el('p', { class: 'eyebrow', text: 'MODE / 接入方式' }),
      el('h1', { text: '模式' }),
      el('p', { class: 'lede', text: '在官方直连、纯路由、聚合之间切换。预览不写入；确认后才改 Codex 配置，切换后必须完全退出并重开 Codex。' })),
    el('div', { class: 'head-actions' },
      el('span', { class: 'meta-pill', text: '来源 /api/aggregation/modes' }),
      el('button', { class: 'btn', type: 'button', onclick: () => ctx.reloadModes(), text: '重新检测' }))))

  if (state.errors.modes) {
    host.append(callout('danger',
      el('strong', { text: '读取接入方式失败：' }), ' ' + state.errors.modes,
      el('div', { class: 'toolbar' }, el('button', { class: 'btn', type: 'button', onclick: () => ctx.reloadModes(), text: '重试' }))))
  }

  if (state.modesUnavailable) {
    host.append(callout('warn',
      el('strong', { text: '当前实例不支持三模式接口：' }),
      ' /api/aggregation/modes 返回 404。这里只展示只读快照，不显示可点的切换按钮。'))
  }

  if (!state.modes && !state.errors.modes) {
    host.append(el('section', { class: 'panel' }, el('p', { class: 'muted', text: '正在读取接入方式…' })))
    return
  }

  if (state.modes) {
    host.append(currentPanel(snap, ctx))
  }

  if (snap.drifted) {
    host.append(callout('warn',
      el('strong', { text: '检测到配置漂移：' }),
      ' Codex 的 config.toml 与 ModelGate 记录的基线不一致，/switch 与 /rollback 会返回 409。可以先「采纳当前配置为基线」：只更新 state，不改 config.toml 内容、不切换模式。',
      el('div', { class: 'toolbar' },
        el('button', {
          class: 'btn btn-primary', type: 'button', disabled: ctx.modeUi.busy,
          onclick: () => ctx.previewMode('reconcile', null),
          text: '预览对齐配置',
        }))))
  }

  const canSwitch = !!state.modes && !state.modesUnavailable && !snap.drifted &&
    selection.mode !== snap.mode && !ctx.modeUi.busy
  const previous = snap.previousMode && snap.previousMode !== snap.mode ? snap.previousMode : ''
  const canRollback = !!state.modes && !state.modesUnavailable && !snap.drifted && !!previous && !ctx.modeUi.busy

  host.append(el('section', { class: 'panel mode-selector' },
    el('div', { class: 'panel-head' },
      el('div', {},
        el('h2', { text: '切换接入方式' }),
        el('p', { class: 'panel-sub', text: '先预览差异，再勾选确认；服务端用一次性 consentToken 写入。' }))),
    modeCards(snap, selection, ctx),
    parentControl(snap, selection, ctx),
    el('div', { class: 'toolbar mode-actions' },
      el('button', {
        class: 'btn btn-primary', type: 'button', disabled: !canSwitch,
        title: !state.modes ? '尚未读取到接入方式' : snap.drifted ? '配置漂移，先对齐基线' : selection.mode === snap.mode ? '当前已是该模式' : '',
        onclick: () => ctx.previewMode('switch', { mode: selection.mode, parentModel: selection.parentModel }),
        text: ctx.modeUi.busy ? '处理中…' : '预览切换',
      }),
      previous
        ? el('button', {
          class: 'btn', type: 'button', disabled: !canRollback,
          onclick: () => ctx.previewMode('rollback', { mode: previous }),
          text: '预览回滚到「' + modeMeta(previous).label + '」',
        })
        : el('span', { class: 'muted', text: '没有可回滚的上一模式。' })),
    el('p', { class: 'hint', text: '切换只改 ModelGate 拥有的 TOML 字段；不编辑 auth.json，不启动/重启 Codex。' })))

  if (ctx.modeUi.receipt) {
    const r = ctx.modeUi.receipt
    host.append(callout('info',
      el('strong', { text: '最近一次操作已返回：' }),
      ' 模式 ' + modeMeta(r.mode || snap.mode).label + '。' +
      (r.restart && r.restart.needed === true
        ? ' 请完全退出并重新打开 Codex Desktop 后才会生效。'
        : ' 服务端未返回需要重启的结论，请以「重新检测」为准。'),
      r.sha ? el('p', { class: 'mono hint', text: '写入 SHA：' + shortSha(r.sha, ctx.settings.showTechnical) }) : null,
      el('div', { class: 'toolbar' },
        el('button', { class: 'btn', type: 'button', onclick: () => ctx.reloadModes(), text: '重新检测' }))))
  }

  if (ctx.modeUi.error) {
    host.append(callout('danger', el('strong', { text: '操作未完成：' }), ' ' + ctx.modeUi.error))
  }
}

function summaryRow (label, value) {
  return el('div', { class: 'preview-row' },
    el('dt', { text: label }),
    el('dd', { class: 'mono', text: value }))
}

export function buildModeDialog (body, close, ctx, action) {
  const { kind, selection, preview } = action
  const summary = previewSummary(preview)
  const meta = kind === 'switch' ? modeMeta(selection && selection.mode) : kind === 'rollback' ? modeMeta(selection && selection.mode) : null
  const showTech = ctx.settings.showTechnical
  const confirmLabel = kind === 'switch' ? '确认切换' : kind === 'rollback' ? '确认回滚' : '确认采纳'
  const consent = el('input', { type: 'checkbox', id: 'mode-consent' })
  const confirm = el('button', { class: 'btn btn-primary', type: 'button', disabled: true, text: confirmLabel })
  const errorHost = el('div')
  const canConfirm = summary.consentToken && summary.blocked.length === 0

  const diffRows = summary.rows.slice(0, 60).map((row) => {
    const [label, tone] = diffTone(row.kind)
    return el('tr', {},
      el('td', { class: 'mono', text: String(row.path || '—') }),
      el('td', {}, badge(label, tone)),
      el('td', { class: 'mono wrap', title: valueText(row.from), text: valueText(row.from).slice(0, 80) }),
      el('td', { class: 'mono wrap', title: valueText(row.to), text: valueText(row.to).slice(0, 80) }))
  })

  // 逐行 TOML 差异是真正落盘的内容（服务端 changed[]）；字段级 rows 只是摘要。
  const lineRows = summary.lineChanges.slice(0, 80).map((line) => {
    const added = line.kind === 'add'
    const no = added ? line.afterNo : line.beforeNo
    return el('tr', {},
      el('td', {}, badge(added ? '新增' : '删除', added ? 'info' : 'warn')),
      el('td', { class: 'num mono', text: no == null ? '—' : String(no) }),
      el('td', { class: 'mono wrap', text: String(line.text || '').slice(0, 120) }))
  })

  const blocks = [
    el('p', { class: 'dialog-lede', text: kind === 'reconcile'
      ? '只更新 state 基线，不修改 config.toml 内容、不切换接入方式、不改 model/provider、不触碰 auth.json。'
      : '这次预览没有写入任何内容。确认后只改 ModelGate 拥有的字段；其它行逐字节保留。' }),
    summary.firstRun ? callout('warn', el('strong', { text: '首次设置：' }), ' 会在 Codex 用户级配置中新增这些字段。') : null,
    summary.blocked.length
      ? callout('danger', el('strong', { text: '前置条件未满足：' }), summary.blocked.map((b) => (b && (b.message || b.code)) || 'blocked').join('；'))
      : null,
    !summary.consentToken
      ? callout('warn', el('strong', { text: '缺少确认令牌：' }), ' 服务端没有返回 consentToken；请关闭后重新预览。')
      : null,
    el('dl', { class: 'preview-summary' },
      summaryRow('变更行', '+' + summary.addedLines + ' / −' + summary.removedLines),
      summaryRow('字段差异', String(summary.rows.length) + ' 个'),
      summaryRow('当前 SHA', shortSha(summary.beforeSha, showTech)),
      summaryRow('写入后 SHA', shortSha(summary.afterSha, showTech)),
      summaryRow('备份', summary.backupAvailable ? '可用' : '无'),
      summaryRow('冲突', summary.conflicts.length ? String(summary.conflicts.length) + ' 个' : '无')),
    summary.conflicts.length ? callout('warn', el('strong', { text: '将覆盖已有值：' }), summary.conflicts.join('、')) : null,
    summary.warnings.length ? callout('warn', el('strong', { text: '注意：' }), summary.warnings.join(' ')) : null,
    summary.agentChild && summary.agentChild.action && summary.agentChild.action !== 'none'
      ? callout('info', el('strong', { text: '原生子代理配置：' }), summary.agentChild.action + ' · ' + (summary.agentChild.fileName || 'go-deepseek.toml'))
      : null,
    summary.catalog
      ? el('p', { class: 'hint', text: '目录：' + (summary.catalog.ok ? (summary.catalog.modelCount + ' 个模型（含目标模型）') : ('当前不可用：' + (summary.catalog.reason || summary.catalog.state || '未知'))) })
      : null,
    lineRows.length
      ? el('details', { class: 'diff-block', open: '' },
        el('summary', { text: '逐行配置差异（' + summary.lineChanges.length + ' 行）' }),
        el('div', { class: 'table-scroll dialog-diff' }, el('table', {},
          el('thead', {}, el('tr', {},
            el('th', { scope: 'col', text: '变更' }),
            el('th', { scope: 'col', class: 'num', text: '行号' }),
            el('th', { scope: 'col', text: '内容' }))),
          el('tbody', {}, ...lineRows))))
      : null,
    diffRows.length
      ? el('details', { class: 'diff-block' },
        el('summary', { text: '字段级摘要（' + summary.rows.length + ' 项）' }),
        el('div', { class: 'table-scroll dialog-diff' }, el('table', {},
          el('thead', {}, el('tr', {},
            el('th', { scope: 'col', text: '字段' }),
            el('th', { scope: 'col', text: '变更' }),
            el('th', { scope: 'col', text: '当前值' }),
            el('th', { scope: 'col', text: '写入后' }))),
          el('tbody', {}, ...diffRows))))
      : el('p', { class: 'muted', text: '预览没有返回字段级差异；仍会按服务端结果写入。' }),
    kind === 'reconcile'
      ? null
      : callout('warn', el('strong', { text: '需要重启 Codex：' }), ' 切换/回滚后必须完全退出并重新打开 Codex Desktop（不是只关窗口）才会生效。'),
    el('div', { class: 'consent-row' },
      consent,
      el('label', { for: 'mode-consent', text: kind === 'reconcile'
        ? '我已了解：只更新基线，不修改 config.toml 内容'
        : '我已了解：需要完全退出并重开 Codex Desktop' })),
    errorHost,
    el('div', { class: 'dialog-actions' },
      el('button', { class: 'btn', type: 'button', onclick: close, text: '取消（不写入）' }),
      confirm),
  ]
  append(body, blocks)

  consent.addEventListener('change', () => { confirm.disabled = !(consent.checked && canConfirm) })
  if (!canConfirm) confirm.disabled = true

  confirm.addEventListener('click', async () => {
    if (!consent.checked || !canConfirm) return
    confirm.disabled = true
    confirm.textContent = kind === 'reconcile' ? '写入基线中…' : '写入并验证中…'
    clear(errorHost)
    try {
      const result = await ctx.confirmMode(kind, selection, preview)
      if (result.kind === 'applied') { close(); return }
      const message = result.kind === 'preview'
        ? '确认令牌已失效或被重新签发；请关闭后重新预览。'
        : result.kind === 'conflict'
          ? (result.message || '配置在预览后被修改（409）；请关闭后重新检测。')
          : result.kind === 'blocked'
            ? '前置条件未满足：' + (result.blocked || []).map((b) => (b && (b.message || b.code)) || 'blocked').join('；')
            : (result.message || '写入失败。')
      errorHost.append(callout('danger', el('strong', { text: '未写入：' }), ' ' + message))
      if (result.kind === 'preview' || result.kind === 'conflict') {
        confirm.textContent = '需要重新预览'
        confirm.disabled = true
      } else {
        confirm.textContent = confirmLabel
        confirm.disabled = false
      }
    } catch (error) {
      errorHost.append(callout('danger', el('strong', { text: '未写入：' }), ' ' + (error && error.message ? error.message : String(error))))
      confirm.textContent = confirmLabel
      confirm.disabled = false
    }
  })
}