import { h, button, tag, pageHeader, panel, notice, kv, appMark, icon, modeLabel } from '../components/index.js'
import { renderHarnessAdapters } from './harnesses.js'

let appQuery = ''
let appFilter = 'available'

function targetLabel(state, mode) {
  if (mode === 'official') return '官方默认'
  const draft = state.codexDrafts || {}
  const target = mode === 'route' ? draft.route?.target : draft.aggregated?.target
  if (!target) return '未配置'
  if (target.kind === 'pool') return state.pools?.items?.find((item) => (item.poolId || item.slug) === target.id)?.name || '模型池已失效'
  return state.models?.items?.find((item) => item.modelId === target.id)?.displayName || '模型已失效'
}

function matchesApp(label, detail) {
  return !appQuery || (label + ' ' + detail).toLowerCase().includes(appQuery.toLowerCase())
}

export function renderHarness(state, actions) {
  const caps = state.capabilities
  const health = state.aggregation || {}
  const mode = health.mode || caps.aggregation.mode || 'unknown'
  const showCodex = (appFilter === 'all' || appFilter === 'available') && matchesApp('Codex', '官方登录 父子代理')
  const showGeneric = (appFilter === 'all' || appFilter === 'available') && matchesApp('其他应用 API', '自定义 Base URL 通用接入')
  return h('div', { class: 'page' },
    pageHeader('应用接入', '从正在使用的 AI 工具开始。', button('刷新检测', actions.refresh, 'ghost', {}, icon('refresh'))),
    h('div', { class: 'grid g2' },
      panel('继续使用 Codex',
        h('p', { class: 'muted', text: '当前：' + modeLabel(mode) + ' · ' + targetLabel(state, mode) }),
        h('div', { class: 'actions mt' }, button('管理接入', () => actions.navigate('mode'), 'primary'), button('快速切换', () => actions.navigate('mode'), 'ghost'), button('连接诊断', () => actions.navigate('reliability'), 'ghost')),
      ),
      panel('第一次使用？',
        h('p', { class: 'muted', text: '先连接模型服务，再选择应用。无需手工编辑配置文件。' }),
        h('div', { class: 'actions mt' }, button('连接模型服务', () => actions.navigate('services'), 'primary'), button('管理模型池', () => actions.navigate('pools'), 'ghost')),
      ),
    ),
    h('div', { class: 'sectionhead' },
      h('h2', { text: '应用目录' }),
      h('div', { class: 'toolbar' },
        h('input', { class: 'search', type: 'search', value: appQuery, placeholder: '搜索应用', 'aria-label': '搜索应用', onInput: (event) => { appQuery = event.target.value; actions.render() } }),
        h('div', { class: 'seg', role: 'group', 'aria-label': '应用筛选' }, [['available', '现有入口'], ['planned', '规划中'], ['all', '全部']].map(([value, label]) => button(label, () => { appFilter = value; actions.render() }, 'ghost', { class: appFilter === value ? 'active' : '', 'aria-pressed': appFilter === value ? 'true' : 'false' }))),
      ),
    ),
    showCodex || showGeneric ? h('div', { class: 'harnessgrid' },
      showCodex ? h('article', { class: 'panel harnesscard' },
        h('div', { class: 'between' }, h('div', { class: 'row' }, appMark('>_'), h('div', {}, h('h3', { text: 'Codex' }), h('small', { class: 'muted', text: '已有接入 · 待验收' }))), tag(modeLabel(mode), 'accent')),
        h('p', { class: 'muted', text: '保留原生界面、官方登录与父子代理能力。' }),
        h('div', { class: 'kv' },
          h('dt', {}, h('span', { text: '已保存模式' })), h('dd', {}, modeLabel(mode)),
          h('dt', {}, h('span', { text: '模型目标' })), h('dd', {}, targetLabel(state, mode)),
        ),
        h('div', { class: 'actions' }, button('管理接入', () => actions.navigate('mode'), 'primary')),
      ) : null,
      showGeneric ? h('article', { class: 'panel harnesscard' },
        h('div', { class: 'between' }, h('div', { class: 'row' }, appMark('API'), h('div', {}, h('h3', { text: '其他应用 / API' }), h('small', { class: 'muted', text: '手动接入' })))),
        h('p', { class: 'muted', text: '适合支持自定义模型服务的应用和开发工具。' }),
        h('div', { class: 'kv' },
          h('dt', {}, h('span', { text: '模型目标' })), h('dd', {}, '按客户端配置'),
        ),
        h('div', { class: 'actions' }, button('配置接入目标', () => actions.navigate('clients'), 'primary')),
      ) : null,
    ) : emptyApp(),
    renderHarnessAdapters(actions, appFilter, appQuery),
    h('details', { class: 'plain-details' }, h('summary', { text: '接入说明与自动配置边界' }), notice('真实边界', '检测到客户端只表示配置路径存在，不代表模型权限、额度、工具调用或原生压缩已通过。所有写入必须先预览并确认。', 'warn')),
    state.errors.aggregation ? notice('聚合状态读取失败', state.errors.aggregation.message, 'error') : null,
  )
}

function emptyApp() {
  return h('div', { class: 'empty' }, h('h2', { text: '没有匹配应用' }), h('p', { text: '尝试清除搜索或切换筛选条件。' }))
}
