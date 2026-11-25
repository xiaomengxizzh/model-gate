import { api } from '../api.js'
import { h, button, tag, panel, panelHeader, notice, kv, appMark } from '../components/index.js'
import { openModal, field } from '../components/modal.js'

let registry = null
let error = null
function requestId() { return crypto.randomUUID() }
async function load(actions) { if (registry) return; try { registry = await api.harnesses(); actions.render() } catch (reason) { error = reason; actions.render() } }
function configure(adapter, actions) {
  const endpoint = h('input', { required: true, type: 'url', value: location.origin, 'aria-label': 'Harness 网关地址' })
  let plan = null
  const modal = openModal({ title: '配置 ' + adapter.label, body: h('div', {}, notice('隔离写入', '只写显式 MG_HARNESS_ROOT 内的配置；真实客户端兼容性尚未验收。'), h('div', { style: { marginTop: '14px' } }, field('网关地址', endpoint, '凭据仅写环境变量名 MODELGATE_API_KEY，不写 Key 值。'))), footer: [button('取消', () => modal.close()), button('预览配置', () => form.requestSubmit(), 'primary', { type: 'submit' })] })
  const form = h('form', { onSubmit: async (event) => { event.preventDefault(); modal.setBusy(true); try { plan = await api.harnessPreview({ harnessId: adapter.harnessId, endpoint: endpoint.value, requestId: requestId() }); modal.setBusy(false); modal.setBody(notice('确认写入', '应用后如第三方修改配置，回滚会拒绝覆盖。'), kv([[' Harness', adapter.label], ['配置文件', plan.path], ['能力证据', plan.capability + ' / ' + plan.realProtocol]])); modal.setFooter(button('取消', () => modal.close()), button('确认应用', confirm, 'primary')) } catch (reason) { modal.setError(reason.message); modal.setBusy(false) } } })
  modal.dialog.querySelector('.dialog-body').append(form)
  const confirm = async () => { modal.setBusy(true); try { await api.harnessApply({ confirmToken: plan.confirmToken, requestId: plan.requestId }); modal.setBusy(false); modal.setBody(notice('配置已应用', '请重开对应 Harness；真实协议与账号尚未验收。'), kv([['备份 ID', plan.backupId], ['重启', '需要完全退出并重开 Harness']])); modal.setFooter(button('关闭', () => modal.close()), button('回滚', async () => { try { await api.harnessRollback({ backupId: plan.backupId, harnessId: adapter.harnessId }); modal.setBody(notice('已回滚', '配置文件已恢复到应用前字节。')); modal.setFooter(button('完成', () => modal.close(), 'primary')) } catch (reason) { modal.setError(reason.message) } }, 'danger')) } catch (reason) { modal.setError(reason.message); modal.setBusy(false) } }
}

export function renderHarnessAdapters(actions, filter = 'all', query = '') {
  load(actions)
  if (error) return panel('其他应用', notice('适配器读取失败', error.message, 'error'))
  if (!registry) return panel('其他应用', h('p', { class: 'muted' }, '正在读取本机 Harness 检测结果…'))
  const detections = new Map(registry.detection.map((item) => [item.harnessId, item.detection]))
  if (filter === 'available') return null
  const adapters = registry.adapters.filter((adapter) => (!query || (adapter.label + ' ' + adapter.protocols.map((protocol) => protocol.id).join(' ')).toLowerCase().includes(query.toLowerCase())))
  return panel(null,
    panelHeader('其他应用 / API', '按真实检测与适配器状态显示；未实现的应用不会伪装成一键接入。'),
    adapters.length ? h('div', { class: 'catalog12-grid' }, adapters.map((adapter) => h('article', { class: 'panel catalog12-card' },
      h('div', { class: 'row spread' }, h('div', { class: 'row' }, appMark(adapter.label.slice(0, 2)), h('div', {}, h('h3', { text: adapter.label }), h('small', { class: 'muted', text: adapter.protocols.map((protocol) => protocol.id).join(' / ') || '协议未知' }))), tag(adapter.status === 'supported' ? '配置适配器 · 未真机验收' : '暂不支持', adapter.status === 'supported' ? 'warning' : 'danger')),
      h('div', { class: 'kv' },
        h('dt', {}, h('span', { text: '本机检测' })), h('dd', {}, detections.get(adapter.harnessId)?.state || 'unknown'),
        h('dt', {}, h('span', { text: '协议' })), h('dd', {}, adapter.protocols.map((protocol) => protocol.id).join(' / ') || '未知'),
      ),
      adapter.status === 'supported' ? h('div', { class: 'actions' }, button('配置预览', () => configure(adapter, actions), 'primary', { disabled: !registry.writesEnabled })) : h('p', { class: 'muted small', text: adapter.reason }),
    ))) : empty('没有匹配应用', '当前筛选下没有可显示的应用适配器。'),
    registry.writesEnabled ? null : notice('写入未启用', '当前实例未设置 MG_HARNESS_ROOT；只能检测，不能修改本机 Harness 配置。', 'warn'),
  )
}
