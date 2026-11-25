import { api } from '../api.js'
import { h, button, tag, panel, panelHeader, notice, kv, statusStrip, pageHeader, icon } from '../components/index.js'
import { openModal } from '../components/modal.js'
import { dirtyModes, emptyDrafts, OFFICIAL_PARENT } from '../drafts.js'

let busy = false
const LABELS = { official: '官方直连', route: '纯路由', aggregated: '聚合模式' }

function targetOptions(state) {
  return [
    { value: '', label: '请选择模型或模型池' },
    ...(state.models?.items || []).filter((model) => model.enabled).map((model) => ({ value: 'model:' + model.modelId, label: '模型 · ' + model.displayName })),
    ...(state.pools?.items || []).filter((pool) => pool.enabled).map((pool) => ({ value: 'pool:' + (pool.poolId || pool.slug), label: '模型池 · ' + pool.name })),
  ]
}

function targetFromValue(value) {
  if (!value) return null
  const index = value.indexOf(':')
  const kind = value.slice(0, index)
  if (!['model', 'pool'].includes(kind)) throw new Error('草稿目标无效，请重新选择')
  return { kind, id: value.slice(index + 1) }
}

function requestBody(draft) {
  const body = { mode: draft.mode }
  if (draft.mode === 'route') body.routeTarget = targetFromValue(draft.route.target)
  if (draft.mode === 'aggregated') { body.parentModel = OFFICIAL_PARENT; body.childTarget = targetFromValue(draft.aggregated.target) }
  return body
}

function storageError(reason) {
  const messages = {
    read: '浏览器无法读取本地草稿。当前修改仍可在本页使用，但刷新后可能丢失。',
    write: '浏览器拒绝保存本地草稿。当前修改仅保留在本页，刷新后可能丢失。',
    remove: '浏览器未能删除已存草稿；当前草稿仍保留，请恢复存储访问后重试放弃。',
    invalid: '本地草稿格式无效，已隔离，不会自动填入表单。',
    target: '本地草稿引用的模型或池已不可用，已隔离该目标，请重新选择。',
  }
  return messages[reason] || '本地草稿存储不可用，当前修改仅保留在本页。'
}

function confirmDiscard(state, actions) {
  const stale = state.codexDraftStatus === 'stale'
  const changed = dirtyModes(state.codexDrafts)
  const modal = openModal({
    title: stale ? '确认放弃过期草稿' : '确认放弃模式草稿',
    body: h('div', { class: 'stack' },
      notice('不会撤销已提交配置', '仅删除此浏览器中未提交的接入方式选择；已保存的 Codex 配置不受影响。'),
      kv([
        ['草稿来源', stale ? '旧配置代际' : '当前配置代际'],
        ['包含方式', stale ? '过期草稿（未自动恢复）' : (changed.map((mode) => LABELS[mode]).join('、') || '无未提交选择')],
      ]),
    ),
    footer: [button('保留草稿', () => modal.close()), button('确认放弃', () => {
      modal.close()
      const result = actions.discardDrafts()
      actions.toast(result.ok ? '模式草稿已放弃' : '未能清除浏览器中的草稿，请查看本地存储提示', result.ok ? 'success' : 'error')
      actions.render()
    }, 'danger')],
  })
}

async function apply(state, actions, plan, body, rollback = false) {
  const selectedMode = state.codexDrafts.mode
  const modal = openModal({
    title: rollback ? '确认回滚' : '确认接入变更',
    body: h('div', {}, notice('预览尚未写入', '确认后将通过现有 Codex 配置事务提交；完成后必须完全退出并重开 Codex GUI。'), kv([['目标方式', rollback ? plan.preview.previousMode || '上一方式' : LABELS[selectedMode]], ['当前方式', state.aggregation?.mode || '无法确认'], ['预期配置 SHA', plan.preview.expectedSha || '—']])),
    footer: [button('取消', () => modal.close()), button('确认提交', () => confirm(), 'primary')],
  })
  const confirm = async () => {
    modal.setBusy(true); modal.setError('')
    try {
      const result = rollback
        ? await api.rollbackAggregation({ consentToken: plan.preview.consentToken, expectedSha: plan.preview.expectedSha })
        : await api.switchAggregation({ ...body, consentToken: plan.preview.consentToken, expectedSha: plan.preview.expectedSha })
      if (!rollback) actions.discardDrafts(selectedMode)
      modal.setBusy(false)
      modal.setBody(notice('配置已提交', 'ModelGate 已验证写入，但尚未证明 Codex 已重启生效。'), kv([['当前方式', result.mode || plan.preview.toMode || '—'], ['配置 SHA', result.appliedSha || plan.preview.expectedSha || '—'], ['重启', '需要完全退出并重开 Codex GUI']]))
      modal.setFooter(button('完成', () => modal.close(), 'primary'))
      actions.toast('接入配置已提交，等待 Codex 重启验证', 'success')
      await actions.refresh(); actions.render()
    } catch (error) { modal.setError(error.message); modal.setBody(notice('提交失败', error.message, 'error')); modal.setBusy(false) }
  }
}

export function renderCodexPanel(state, actions) {
  const draft = state.codexDrafts || emptyDrafts()
  const selectedDraft = draft[draft.mode] || emptyDrafts()[draft.mode]
  const current = state.aggregation?.mode || 'unknown'
  const stale = state.codexDraftStatus === 'stale'
  const blocked = stale || busy
  const options = targetOptions(state)
  const changed = dirtyModes(state.codexDrafts)
  const target = h('select', { 'aria-label': '第三方角色目标', dataset: { draftTarget: selectedDraft.target }, disabled: blocked, onChange: (event) => { actions.updateDraft(draft.mode, { target: event.target.value }); actions.render() } }, options.map((item) => h('option', { value: item.value, text: item.label, selected: item.value === selectedDraft.target })))
  // Options must exist before assigning the selected value; otherwise the browser
  // silently falls back to the placeholder even when a draft was restored.
  target.value = selectedDraft.target
  const parent = h('input', { value: OFFICIAL_PARENT, 'aria-label': '官方父模型', readonly: true, disabled: blocked })
  return h('section', { class: 'panel codex-panel' },
    panelHeader('Codex 接入配置', '选择接入方式并预览真实差异；确认后必须完全退出并重开 Codex。', tag(changed.length ? '有未提交草稿' : '真实预览 · 确认后写入', changed.length ? 'warning' : 'accent')),
    statusStrip(
      ['当前配置', LABELS[current] || '无法确认', current === 'unknown' ? 'warn' : 'good'],
      ['配置漂移', state.aggregation?.drifted ? '已检测到' : '未检测到', state.aggregation?.drifted ? 'bad' : 'good'],
      ['实际生效', restartLabel(state), 'warn'],
    ),
    h('div', { class: 'stack', dataset: { draftStatus: state.codexDraftStatus } },
      stale ? notice('草稿版本已过期', '后端配置代际已变化，旧草稿不会自动覆盖当前表单。可明确恢复并重新预览，或放弃旧草稿。', 'error') : null,
      state.codexDraftStatus === 'error' ? notice('本地草稿不可用', storageError(state.codexDraftError), 'error') : null,
      stale ? h('div', { class: 'row' }, button('保留并恢复旧草稿', () => { actions.restoreStaleDrafts(); actions.render() }, 'primary'), button('放弃旧草稿', () => confirmDiscard(state, actions), 'danger')) : null,
      !stale && changed.length ? notice('未提交的本地草稿', '已选方式：' + changed.map((item) => LABELS[item]).join('、') + '。往返页面、前进后退或刷新后可恢复；放弃前会再次确认。') : null,
      h('div', { class: 'grid g3' }, [
        ['official', 'DIRECT', '保留官方登录及套餐，不经网关'],
        ['route', 'ROUTE', '父子均为 DeepSeek，零 GPT 出站目标'],
        ['aggregated', 'AGGREGATION', '官方 GPT 父模型 + 第三方子模型'],
      ].map(([value, code, description]) => h('button', {
        type: 'button', class: 'modecard' + (draft.mode === value ? ' active' : ''), role: 'radio', 'aria-checked': draft.mode === value ? 'true' : 'false', disabled: blocked,
        onClick: () => { actions.selectDraftMode(value); actions.render() },
      }, h('span', { class: 'radio', 'aria-hidden': 'true' }), h('small', { class: 'mono', text: code }), h('h2', { text: LABELS[value] }), h('p', { text: description })))),
      h('div', { class: 'grid g2 mt' },
        panel(null,
          panelHeader('模型与接入配置', '修改目标配置，预览后才可应用。', tag('目标：' + LABELS[draft.mode], 'accent')),
          draft.mode === 'aggregated' ? h('div', { class: 'fieldgrid' },
            h('label', { class: 'field' }, h('span', { class: 'field-label', text: '父模型供应商' }), h('input', { value: 'ChatGPT 套餐', readonly: true, disabled: blocked })),
            h('label', { class: 'field' }, h('span', { class: 'field-label', text: '官方父模型（真实测试仅 GPT-6 Luna）' }), parent),
          ) : null,
          draft.mode !== 'official' ? h('label', { class: 'field' }, h('span', { class: 'field-label', text: draft.mode === 'route' ? '父 / 子共同目标' : '第三方子目标' }), target, h('small', { class: 'field-hint', text: '官方直连不进入第三方池；纯路由不允许 GPT 出站。' })) : null,
          draft.mode === 'official' ? notice('官方直连', '退出 ModelGate 接入配置，保留 Codex 官方登录与默认行为。') : null,
          h('div', { class: 'actions mt' },
            button('预览并应用', async () => {
              if (busy || stale) return
              if (draft.mode !== 'official' && !selectedDraft.target) { actions.toast('请先选择模型或模型池', 'error'); return }
              busy = true; actions.render()
              try { const body = requestBody(draft); let result; try { result = await api.switchAggregation(body) } catch (error) { if (error.status !== 428) throw error; result = error.data } if (result.status !== 428) throw new Error('后端未返回预览'); await apply(state, actions, result, body) }
              catch (error) { actions.toast(error.message, 'error') }
              finally { busy = false; actions.render() }
            }, 'primary', { disabled: blocked }, icon('check')),
            button('回滚上一方式', async () => {
              if (busy || stale) return
              busy = true
              try { let result; try { result = await api.rollbackAggregation({}) } catch (error) { if (error.status !== 428) throw error; result = error.data } if (result.status !== 428) throw new Error('没有可回滚预览'); await apply(state, actions, result, null, true) }
              catch (error) { actions.toast(error.message, 'error') }
              finally { busy = false; actions.render() }
            }, 'secondary', { disabled: blocked }),
            changed.length || stale ? button('放弃全部草稿', () => confirmDiscard(state, actions), 'ghost') : null,
          ),
          h('p', { class: 'muted small mt', text: '本地仅保存接入方式、已选模型/池与固定官方父模型；Key、token、consent 和配置正文永不写入 localStorage。' }),
        ),
        h('div', { class: 'stack' },
          panel('目标连接拓扑', h('div', { class: 'flow11' },
            h('div', { class: 'flow-node11' }, h('b', { text: 'Codex' }), h('small', { text: '原生 Harness' })),
            h('span', { text: '→' }),
            h('div', { class: 'flow-node11' }, h('b', { text: draft.mode === 'official' ? 'OpenAI' : 'ModelGate' }), h('small', { text: draft.mode === 'official' ? '官方直连' : '本地网关' })),
            draft.mode !== 'official' ? h('span', { text: '→' }) : null,
            draft.mode !== 'official' ? h('div', { class: 'flow-node11' }, h('b', { text: draft.mode === 'route' ? 'DeepSeek' : '官方父 + 子池' }), h('small', { text: draft.mode === 'route' ? '零 GPT' : '身份分流' })) : null,
          )),
          panel('运行与验证状态', kv([
            ['网关服务', '已连接'],
            ['Codex 实际生效', restartLabel(state)],
            ['原生压缩', '由 Codex 执行'],
            ['官方多轮续轮', '以真实回执为准'],
          ]), h('div', { class: 'actions mt' }, button('查看诊断', () => actions.navigate('logs'), 'ghost'))),
          notice('原生能力边界', '父子调度、工具、同子续轮和压缩由 Codex 原生执行；ModelGate 不自建 Agent Team 或压缩。'),
        ),
      ),
    ),
  )
}

export function renderModePage(state, actions) {
  return h('div', { class: 'page' },
    pageHeader('Codex 接入配置', '官方直连、纯路由与聚合模式；所有变更先预览，确认后需重开 Codex。', button('返回应用接入', () => actions.navigate('harness'), 'ghost')),
    renderCodexPanel(state, actions),
    panel('实现与验证边界', h('div', { class: 'grid g3' },
      panel('原生父子代理', h('p', { class: 'muted', text: '由 Codex 原生 Harness 调度，ModelGate 只负责身份分流与协议转换。' })),
      panel('同子续轮', h('p', { class: 'muted', text: '保留真实 response ID 与工具调用记录；缺失时明确失败，不伪造历史。' })),
      panel('原生压缩', h('p', { class: 'muted', text: '由 Codex 执行；ModelGate 不自建摘要、Agent Team 或压缩。' })),
    )),
  )
}

function restartLabel() {
  return '需要完全退出并重开 Codex'
}
