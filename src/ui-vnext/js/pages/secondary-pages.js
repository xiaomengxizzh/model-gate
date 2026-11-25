import { api } from '../api.js'
import { h, button, tag, pageHeader, panel, panelHeader, notice, empty, table, kv, metric, appMark, statusStrip, sectionHead, icon } from '../components/index.js'
import { renderModelsPanel } from './models.js'
import { renderPools, showPoolTab } from './pools.js'
import { renderReliability } from './reliability.js'
import { openConnectionManager, openConnectionKey } from './connections.js'
import { openModal, field } from '../components/modal.js'
import { openServiceEditor } from './services.js'

let connectionQuery = ''
let connectionStatus = 'all'
let routeModel = ''
let routeKind = 'chat'
let routeCondition = 'ok'
let routeResult = null
let routeError = null
let routeBusy = false
let routeController = null
let logs = null
let logError = null
let logQuery = ''
let logLevel = 'all'
let logStatus = 'all'

function query(name) { return new URLSearchParams(String(location.hash).split('?')[1] || '').get(name) || '' }
function serviceOf(state) { return state.capabilities.services.find((item) => item.providerId === query('service')) }
function connectionOf(state) { return serviceOf(state)?.connections?.find((item) => item.connectionId === query('connection')) }

export function renderServiceDetail(state, actions) {
  const service = serviceOf(state)
  if (!service) return h('div', { class: 'page' }, pageHeader('服务详情', '服务不存在或已被删除。'), button('返回模型服务', () => actions.navigate('services'), 'primary'))
  const models = (state.models?.items || []).filter((model) => model.serviceId === service.serviceId)
  const connections = service.connections || []
  const filtered = connections.filter((item) => (connectionStatus === 'all' || (connectionStatus === 'enabled' ? item.enabled : !item.enabled)) && (item.displayName + ' ' + item.connectionId).toLowerCase().includes(connectionQuery.toLowerCase()))
  const relatedPools = (state.pools?.items || []).filter((pool) => pool.members.some((member) => member.providerId === service.providerId))
  return h('div', { class: 'page' },
    pageHeader(service.label, service.providerId + ' · ' + service.api, button('返回模型服务', () => actions.navigate('services'), 'ghost'), button('编辑服务', () => openServiceEditor(service, state, actions), 'primary')),
    h('div', { class: 'grid g3' },
      metric('启用连接', connections.filter((item) => item.enabled).length, '独立身份与并发槽位'),
      metric('关联模型', models.length, '真实模型目录'),
      metric('凭据状态', service.credential === 'configured' ? '已配置' : '未配置', '不代表真实推理通过'),
    ),
    h('div', { class: 'service-layout9 mt' },
      panel(null,
        panelHeader('连接列表', '每个连接有独立 Key、优先级、并发与额度域。', button('管理连接', () => openConnectionManager(service, state, actions), 'primary')),
        h('div', { class: 'toolbar' }, h('input', { class: 'search', type: 'search', value: connectionQuery, placeholder: '搜索连接', 'aria-label': '搜索连接', onInput: (event) => { connectionQuery = event.target.value; actions.render() } }), h('select', { 'aria-label': '连接状态筛选', value: connectionStatus, onChange: (event) => { connectionStatus = event.target.value; actions.render() } }, h('option', { value: 'all', text: '全部状态' }), h('option', { value: 'enabled', text: '已启用' }), h('option', { value: 'disabled', text: '已停用' }))),
        h('div', { class: 'scroll9' }, filtered.length ? table([{ label: '连接' }, { label: '优先级' }, { label: '并发' }, { label: '额度域' }, { label: '操作' }], filtered.map((connection) => [h('div', {}, h('strong', {}, connection.displayName), h('small', { class: 'muted', text: connection.connectionId })), connection.priority, connection.maxConcurrent || '继承', connection.quotaScopeId || '独立', h('a', { href: '#/account-detail?service=' + encodeURIComponent(service.providerId) + '&connection=' + encodeURIComponent(connection.connectionId), text: '详情' })]), { label: '服务连接' }) : empty('没有匹配连接', connectionQuery ? '尝试清除搜索条件。' : '添加连接后才能使用独立凭据与额度域。')),
      ),
      h('aside', { class: 'stack' },
        panel('服务概况', kv([['稳定 ID', service.serviceId], ['Provider', service.providerId], ['协议', service.api], ['状态', service.enabled === false ? '已停用' : '已启用'], ['模板来源', service.templateId || '未记录']])),
        panel('关联模型池', relatedPools.length ? h('div', { class: 'stack' }, relatedPools.map((pool) => h('div', { class: 'actiontile' }, h('div', {}, h('b', { text: pool.name }), h('small', { class: 'muted', text: pool.members.length + ' 个候选' })), button('查看', () => actions.navigate('pools'), 'ghost')))) : empty('尚无关联模型池', '池成员包含此服务时会显示在这里。')),
        panel('服务模型', h('p', { class: 'muted', text: models.length + ' 个模型已登记。' }), button('查看模型', () => actions.navigate('service-models'), 'ghost')),
      ),
    ),
    notice('验证边界', '服务已配置与熔断状态不代表模型权限、额度或真实推理通过。', 'warn'),
  )
}

export function renderAccountDetail(state, actions) {
  const service = serviceOf(state)
  const connection = connectionOf(state)
  if (!service || !connection) return h('div', { class: 'page' }, pageHeader('连接详情', '连接不存在或已被删除。'), button('返回服务', () => actions.navigate('services'), 'primary'))
  return h('div', { class: 'page' },
    pageHeader(connection.displayName, service.label + ' · ' + connection.connectionId, button('返回服务详情', () => { location.hash = '#/service-detail?service=' + encodeURIComponent(service.providerId) }, 'ghost'), button('管理连接', () => openConnectionManager(service, state, actions), 'primary')),
    statusStrip(['状态', connection.enabled ? '启用 · 待真实验证' : '停用', connection.enabled ? 'good' : 'bad'], ['优先级', String(connection.priority), 'good'], ['额度域', connection.quotaScopeId || '独立', 'good']),
    h('div', { class: 'grid g2' },
      panel('身份与容量', kv([['稳定 ID', connection.connectionId], ['状态', connection.enabled ? '启用 · 待真实验证' : '停用'], ['优先级', String(connection.priority)], ['最大并发', connection.maxConcurrent || '继承服务'], ['共享额度域', connection.quotaScopeId || '独立'], ['认证域', connection.authDomain || '独立']])),
      panel('凭据与权限', kv([['凭据', connection.credentialConfigured ? '已配置' : '未配置'], ['模型权限', connection.modelIds?.length ? connection.modelIds.join('、') : '服务目录范围'], ['验证', connection.verification]]), button('更新凭据', () => openConnectionKey(connection, state, actions), 'primary')),
    ),
    panel('故障处理与删除', h('p', { class: 'muted', text: '连接轮换、冷却和并发按连接 ID 隔离；不会跨身份绕过套餐限制。最后一个启用连接不可停用或删除。' }), h('div', { class: 'actions mt' }, button('管理连接', () => openConnectionManager(service, state, actions), 'ghost'), button('查看服务模型', () => actions.navigate('service-models'), 'ghost'))),
    notice('独立身份', '连接轮换、冷却和并发按连接 ID 隔离；不会跨身份绕过套餐限制。', 'warn'),
  )
}

export function renderPoolTab(state, actions, tab) {
  showPoolTab(tab)
  return renderPools(state, actions)
}

function genericAccess(state, actions) {
  const pools = state.capabilities.pools || []
  const select = h('select', { 'aria-label': '通用接入模型池' }, pools.map((pool) => h('option', { value: pool.slug || pool.name, text: pool.name })))
  const model = () => select.value || (pools[0]?.slug || pools[0]?.name || '')
  const modal = openModal({ title: '通用 API 接入', body: h('div', {}, notice('客户端 Key', '如模型池配置了独立 Key，由客户端安全保存；不要粘贴到日志或截图。'), h('div', { style: { marginTop: '14px' } }, field('模型池', select)), kv([['Base URL', location.origin + '/v1'], ['Model', model()]])), footer: [button('关闭', () => modal.close()), button('复制地址', async () => { try { await navigator.clipboard.writeText(location.origin + '/v1'); actions.toast('Base URL 已复制', 'success') } catch { actions.toast('复制失败，请手动选择文本', 'error') } }, 'primary')] })
  select.addEventListener('change', () => { const values = modal.dialog.querySelectorAll('.kv dd'); if (values[1]) values[1].textContent = model() })
}

export function renderClients(state, actions) {
  const pools = state.capabilities.pools || []
  const mode = state.aggregation?.mode || state.capabilities.aggregation.mode || 'unknown'
  return h('div', { class: 'page' },
    pageHeader('API 与密钥', '客户端凭据只显示是否设置，不返回 Key 值。', button('通用 API 接入', () => genericAccess(state, actions), 'primary'), button('管理模型池', () => actions.navigate('pools'), 'secondary')),
    h('div', { class: 'grid g2' },
      panel('统一 API 地址', kv([['Base URL', location.origin + '/v1'], ['认证方式', '客户端密钥 / 本机受控接入']]), h('div', { class: 'actions mt' }, button('复制地址', async () => { try { await navigator.clipboard.writeText(location.origin + '/v1'); actions.toast('Base URL 已复制', 'success') } catch { actions.toast('复制失败，请手动选择文本', 'error') } }, 'ghost'), button('查看接入示例', () => { const modal = openModal({ title: '客户端接入示例', body: h('pre', { text: 'OPENAI_BASE_URL=' + location.origin + '/v1\nOPENAI_API_KEY=<由真实网关配置>\nMODEL=<真实模型目录中的 ID>' }), footer: [button('关闭', () => modal.close(), 'primary')] }) }, 'ghost'))),
      panel('Codex 接入', kv([['当前配置', mode], ['官方登录', '由 Codex 原生管理'], ['客户端重启', '真实状态未知']]), button('打开模式配置', () => actions.navigate('mode'), 'ghost')),
    ),
    sectionHead('客户端入口'),
    panel(null, pools.length ? table([{ label: '入口' }, { label: '候选', numeric: true }, { label: 'Key' }, { label: '操作' }], pools.map((pool) => [pool.name, pool.candidateCount, tag(pool.keySet ? '已设置' : '未设置', pool.keySet ? 'success' : 'warning'), button('管理', () => actions.navigate('pools'), 'ghost')]), { label: '客户端入口' }) : empty('尚无客户端入口', '创建模型池后可配置独立 Key 与额度。')),
    notice('安全边界', 'Key 通过预览确认流程提交到后端加密库，不进入 URL、localStorage 或导出。当前后端没有独立客户端生命周期 API，因此不显示伪造的新增、编辑或删除动作。', 'warn'),
  )
}

function filteredLogs() {
  return (logs?.items || []).filter((item) => (logLevel === 'all' || item.level === logLevel) && (logStatus === 'all' || (logStatus === 'error' ? ['error', 'warn'].includes(item.level) : item.level === logStatus)))
}

function exportLogs(items) {
  const blob = new Blob([JSON.stringify(items, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = h('a', { href: url, download: 'modelgate-diagnostics.json' })
  document.body.append(link); link.click(); link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function openLogDetail(item, actions) {
  const modal = openModal({ title: '日志详情', body: h('div', {}, kv(Object.entries(item).filter(([key]) => !['message', 'detail', 'body'].includes(key)).slice(0, 20)), h('h3', { class: 'mt', text: '脱敏消息' }), h('pre', { text: item.message || '—' })), footer: [button('关闭', () => modal.close(), 'primary')] })
  actions.toast('已打开后端真实日志记录', 'success')
}

export function renderLogs(state, actions) {
  const items = filteredLogs()
  return h('div', { class: 'page' },
    pageHeader('请求日志', '查询已脱敏的文本日志与有界事件，不包含请求正文或凭据。', button('导出 JSON', () => exportLogs(items), 'ghost', { disabled: !items.length }, icon('download'))),
    h('div', { class: 'grid g3' },
      metric('匹配记录', logs ? items.length : '未查询', '当前筛选范围'),
      metric('警告 / 错误', logs ? items.filter((item) => ['warn', 'error'].includes(item.level)).length : '未查询', '后端结构化事件'),
      metric('查询上限', '100', '避免无界读取'),
    ),
    panel('诊断查询',
      h('div', { class: 'toolbar' }, h('input', { class: 'search', type: 'search', value: logQuery, placeholder: '搜索 traceId、级别或消息', 'aria-label': '搜索请求日志', onInput: (event) => { logQuery = event.target.value } }), h('select', { 'aria-label': '日志级别', value: logLevel, onChange: (event) => { logLevel = event.target.value; actions.render() } }, h('option', { value: 'all', text: '全部级别' }), h('option', { value: 'info', text: 'info' }), h('option', { value: 'warn', text: 'warn' }), h('option', { value: 'error', text: 'error' })), h('select', { 'aria-label': '日志状态', value: logStatus, onChange: (event) => { logStatus = event.target.value; actions.render() } }, h('option', { value: 'all', text: '全部状态' }), h('option', { value: 'error', text: '警告 / 错误' }), h('option', { value: 'info', text: 'info' })), button('查询', async () => { try { logs = await api.structuredLogs('limit=100&q=' + encodeURIComponent(logQuery) + (logLevel === 'all' ? '' : '&level=' + encodeURIComponent(logLevel))); logError = null; actions.render() } catch (error) { logError = error; actions.render() } }, 'primary')),
      logError ? notice('查询失败', logError.message, 'error') : logs ? items.length ? table([{ label: '时间' }, { label: '级别' }, { label: '消息' }, { label: '操作' }], items.map((item) => [item.timestamp, tag(item.level, item.level === 'error' ? 'danger' : item.level === 'warn' ? 'warning' : 'accent'), item.message, button('详情', () => openLogDetail(item, actions), 'ghost')]), { label: '请求日志' }) : empty('没有匹配记录', '尝试清除搜索或级别筛选。') : empty('尚未查询', '输入 traceId 或消息关键词后查询。'),
    ),
  )
}

export function renderRouting(state, actions) {
  const pools = state.pools?.items || []
  return h('div', { class: 'page' },
    pageHeader('手动路由', '高级规则与模型池共用同一后端决策器。', tag('规则 CRUD 未实现', 'warning')),
    notice('真实只读预演', '当前后端没有独立路由规则 CRUD。本页只展示已配置模型池，并提供与执行同核的零上游预演；不显示伪造的新建、编辑或删除规则动作。', 'warn'),
    h('div', { class: 'grid g2' },
      h('div', { class: 'stack' },
        panel('已配置路由目标', pools.length ? h('div', { class: 'stack' }, pools.map((pool) => h('div', { class: 'actiontile' }, h('div', {}, h('b', { text: pool.name }), h('small', { class: 'muted', text: pool.members.map((member) => member.model).join(' → ') })), tag(pool.selection, 'accent')))) : empty('尚无路由目标', '先创建模型池。')),
        panel('请求治理', kv([['400 / 401', '确定性拒绝，不自动重放'], ['429', '尊重真实 Retry-After'], ['工具 / 未知提交', '禁止危险重放'], ['身份域', '不静默跨官方与第三方']])),
      ),
      panel('路由决策预览',
        h('div', { class: 'fieldgrid' },
          h('label', { class: 'field' }, h('span', { class: 'field-label', text: '请求模型' }), h('input', { value: routeModel, placeholder: '模型或模型池名称', 'aria-label': '预演模型名称', onInput: (event) => { routeModel = event.target.value } })),
          h('label', { class: 'field' }, h('span', { class: 'field-label', text: '请求类型' }), h('select', { 'aria-label': '请求类型', value: routeKind, onChange: (event) => { routeKind = event.target.value } }, h('option', { value: 'chat', text: 'Chat Completions' }), h('option', { value: 'responses', text: 'Responses' }), h('option', { value: 'tools', text: '带工具调用' }))),
          h('label', { class: 'field' }, h('span', { class: 'field-label', text: '上游条件' }), h('select', { 'aria-label': '上游条件', value: routeCondition, onChange: (event) => { routeCondition = event.target.value } }, h('option', { value: 'ok', text: '正常' }), h('option', { value: '429', text: '429 限流' }), h('option', { value: 'down', text: '连接失败' }))),
        ),
        h('div', { class: 'actions' }, button(routeBusy ? '正在预演…' : '生成真实决策', async () => {
          if (routeBusy || !routeModel.trim()) { actions.toast('请输入模型或模型池名称', 'error'); return }
          const controller = new AbortController()
          const epoch = actions.routeEpoch?.()
          routeController = controller
          routeBusy = true; routeResult = null; routeError = null; actions.render()
          try {
            const result = await api.routePreview(routeModel.trim(), { signal: controller.signal })
            if (actions.routeEpoch?.() !== epoch) return
            routeResult = result
            actions.toast('预演完成：未请求上游', 'success')
          } catch (error) {
            if (error.aborted || actions.routeEpoch?.() !== epoch) return
            routeError = error
          } finally {
            if (routeController === controller) routeController = null
            routeBusy = false
            if (actions.routeEpoch?.() === epoch) actions.render()
          }
        }, 'primary', { disabled: routeBusy }), routeBusy ? button('取消预演', () => routeController?.abort(), 'ghost') : null),
        routeError ? notice('预演失败', routeError.message, 'error') : null,
        routeResult ? panel(null, kv([['命中类型', routeResult.hit.type], ['名称', routeResult.hit.name || routeResult.hit.model || '—'], ['候选顺序', Array.isArray(routeResult.hit.directory) ? routeResult.hit.directory.map((entry) => entry.model).join(' → ') : '—'], ['上游调用', '0']])) : empty('尚未预演', '输入真实模型或模型池名称。'),
      ),
    ),
  )
}

export function renderAdvanced(state, actions, kind) {
  if (kind === 'models') return h('div', { class: 'page' }, pageHeader('高级模型目录', '模型公共名、稳定 ID 与上游 ID 分离。'), renderModelsPanel(state, actions))
  if (kind === 'service-models') return h('div', { class: 'page' }, pageHeader('服务模型', '当前服务的真实模型目录。'), renderModelsPanel(state, actions, serviceOf(state)?.serviceId))
  if (kind === 'routing') return renderRouting(state, actions)
  if (kind === 'reliability-detail') return renderReliability(state, actions, { title: '稳定性详细', description: '高级规则与模型池共用同一后端决策器。' })
  if (kind === 'clients') return renderClients(state, actions)
  return renderLogs(state, actions)
}
