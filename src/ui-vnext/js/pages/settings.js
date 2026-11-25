import { h, button, tag, pageHeader, panel, panelHeader, notice, kv, table, empty, icon } from '../components/index.js'
import { api } from '../api.js'
import { openModal } from '../components/modal.js'
import { getPreferences } from '../preferences.js'

let backups = null
let backupError = null
let logs = null
let logError = null
let logQuery = ''
let settingsTab = 'general'
function requestId() { return crypto.randomUUID() }
async function loadBackups(actions) {
  if (backups) return
  try { backups = (await api.backups()).items; actions.render() } catch (error) { backupError = error; actions.render() }
}
function downloadBackup(id, actions) {
  api.backup(id).then((result) => {
    const blob = new Blob([JSON.stringify(result.item, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = h('a', { href: url, download: id + '.json' })
    document.body.append(link); link.click(); link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }).catch((error) => actions.toast(error.message, 'error'))
}
function importBackup(state, actions, backup) {
  let plan = null
  const modal = openModal({ title: '导入配置预览', body: notice('尚未写入', '正在比较备份与当前配置；凭据需要重新授权或保留本地值。'), footer: [button('取消', () => modal.close())] })
  api.importPreview({ backup, expectedVersion: state.capabilities.runtime.configVersion }).then((result) => {
    plan = result
    const diff = result.diff
    modal.setBody(notice('确认导入', '应用将通过现有配置事务提交，并保留当前本地凭据。'), kv([['新增', String(diff.added.length)], ['更新', String(diff.updated.length)], ['删除', String(diff.removed.length)], ['冲突', String(diff.conflicts.length)]]))
    modal.setFooter(button('取消', () => modal.close()), button('确认导入', confirm, 'primary', { disabled: diff.conflicts.length > 0 }))
  }).catch((error) => { modal.setError(error.message); modal.setBody(notice('导入预览失败', error.message, 'error')) })
  const confirm = async () => {
    modal.setBusy(true); modal.setError('')
    try { await api.importApply({ planId: plan.planId, confirmToken: plan.confirmToken, expectedVersion: plan.expectedVersion, requestId: requestId() }); modal.setBusy(false); modal.close(); backups = null; actions.toast('配置已从备份恢复', 'success'); await actions.refresh(); actions.render() }
    catch (error) { modal.setError(error.message) }
    finally { modal.setBusy(false) }
  }
}

export function renderSettings(state, actions) {
  loadBackups(actions)
  const caps = state.capabilities
  const prefs = getPreferences()
  const theme = h('select', { 'aria-label': '界面主题', value: prefs.theme, onChange: (event) => actions.preferences({ ...prefs, theme: event.target.value }) }, [h('option', { value: 'dark', text: '深色' }), h('option', { value: 'light', text: '浅色' }), h('option', { value: 'system', text: '跟随系统' })])
  const density = h('select', { 'aria-label': '界面密度', value: prefs.density, onChange: (event) => actions.preferences({ ...prefs, density: event.target.value }) }, [h('option', { value: 'comfortable', text: '舒适' }), h('option', { value: 'compact', text: '紧凑' })])
  const backupPanel = panel('配置备份与恢复',
    h('div', { class: 'stack' },
      notice('默认排除秘密', '备份不包含 API Key、令牌、自定义认证头值或代理凭据；导入时保留本地凭据或要求重新授权。'),
      h('div', { class: 'row' }, button('创建脱敏备份', async () => { try { await api.createBackup(); backups = null; actions.toast('脱敏备份已创建', 'success'); actions.render() } catch (error) { actions.toast(error.message, 'error') } }, 'primary', {}, icon('plus')), h('label', { class: 'button ghost' }, '选择备份文件预览', h('input', { type: 'file', accept: 'application/json,.json', style: { display: 'none' }, onChange: async (event) => { const file = event.target.files?.[0]; if (!file) return; try { importBackup(state, actions, JSON.parse(await file.text())) } catch (error) { actions.toast('备份文件无法读取：' + error.message, 'error') } event.target.value = '' } }))),
      backupError ? notice('备份列表读取失败', backupError.message, 'error') : backups ? h('div', { class: 'stack' }, backups.length ? backups.map((item) => h('div', { class: 'actiontile' }, h('div', {}, h('b', { text: item.backupId }), h('small', { class: 'muted', text: item.createdAt + ' · ' + item.bytes + ' bytes · 无秘密' })), h('div', { class: 'row' }, button('下载', () => downloadBackup(item.backupId, actions), 'ghost'), button('恢复预览', async () => { try { importBackup(state, actions, (await api.backup(item.backupId)).item) } catch (error) { actions.toast(error.message, 'error') } }, 'ghost')))) : h('p', { class: 'muted', text: '尚无备份。' })) : h('p', { class: 'muted', text: '正在读取备份列表…' }),
    ),
  )
  const diagnosticsPanel = panel('诊断日志',
    h('div', { class: 'stack' },
      notice('脱敏查询', '只查询网关已脱敏的文本日志与有界事件；不包含请求正文或凭据。'),
      h('div', { class: 'toolbar' }, h('input', { class: 'search', type: 'search', value: logQuery, placeholder: '搜索 traceId、级别或消息', 'aria-label': '搜索诊断日志', onInput: (event) => { logQuery = event.target.value } }), button('查询', async () => { try { logs = await api.structuredLogs('limit=100&q=' + encodeURIComponent(logQuery)); logError = null; actions.render() } catch (error) { logError = error; actions.render() } }, 'primary'), button('导出 JSON', () => {
        if (!logs) return
        const blob = new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' })
        const url = URL.createObjectURL(blob); const link = h('a', { href: url, download: 'modelgate-diagnostics.json' }); document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000)
      }, 'secondary', { disabled: !logs })),
      logError ? notice('日志查询失败', logError.message, 'error') : logs ? table([{ label: '时间' }, { label: '级别' }, { label: '消息' }], logs.items.map((item) => [item.timestamp, item.level, item.message]), { label: '诊断日志' }) : empty('尚未查询', '输入 traceId 或消息关键词后查询。'),
    ),
  )
  const content = settingsTab === 'service' ? h('div', { class: 'stack' },
    panel('服务与运行', kv([['监听地址', '127.0.0.1:8787'], ['产品版本', caps.build.packageVersion], ['Node', caps.build.node], ['运行入口', caps.ui.productionEntry], ['服务写操作', caps.ui.serviceWriteOperations ? '预览/确认/事务已接线' : '未接线']]), notice('生产边界', '启停、端口变更和 systemd 操作由本机服务管理器处理；此页面不执行操作系统命令。', 'warn')),
    backupPanel,
  ) : settingsTab === 'config' ? h('div', { class: 'stack' },
    panel('高级管理', h('p', { class: 'muted', text: '高级功能已接入当前 V13.1 前端，不再跳转旧控制台。' }), h('div', { class: 'grid g2 mt' }, caps.navigation.advanced.map((item) => h('a', { class: 'button ghost', href: item.route }, item.label)))),
    backupPanel,
    panel('能力清单', h('div', { class: 'row' }, caps.features.map((feature) => tag(feature.id + ' · ' + feature.stage, feature.available ? 'success' : 'warning')))),
  ) : settingsTab === 'diagnostics' ? h('div', { class: 'stack' }, diagnosticsPanel, panel('控制面信息', kv([['产品版本', caps.build.packageVersion], ['Node', caps.build.node], ['源码 SHA', caps.build.commitSha || '未注入（不猜测）'], ['配置版本', String(caps.runtime.configVersion)], ['当前入口', caps.ui.defaultEntry], ['生产入口', caps.ui.productionEntry]]))) : h('div', { class: 'stack' },
    panel('常规与外观',
      h('div', { class: 'settingrow' }, h('div', {}, h('b', { text: '界面主题' }), h('small', { text: '明暗主题切换' })), theme),
      h('div', { class: 'settingrow' }, h('div', {}, h('b', { text: '显示密度' }), h('small', { text: '紧凑模式压缩表格与面板间距' })), density),
      h('div', { class: 'settingrow' }, h('div', {}, h('b', { text: '配置写入确认' }), h('small', { text: '必须预览后显式确认' })), tag('固定开启', 'good')),
      notice('本地偏好', '只保存主题、密度、界面偏好及非敏感接入草稿；Key、consent token、配置正文不进入 localStorage。'),
    ),
    panel('控制面信息', kv([['产品版本', caps.build.packageVersion], ['Node', caps.build.node], ['源码 SHA', caps.build.commitSha || '未注入（不猜测）'], ['配置版本', String(caps.runtime.configVersion)], ['当前入口', caps.ui.defaultEntry], ['生产入口', caps.ui.productionEntry], ['服务写操作', caps.ui.serviceWriteOperations ? '预览/确认/事务已接线' : '未接线'], ['其他写操作', caps.ui.writeOperations ? '可用' : '未接线']])),
  )
  return h('div', { class: 'page' },
    pageHeader('设置', '外观、服务状态、配置备份与诊断集中管理。'),
    h('div', { class: 'settingslayout' },
      panel(null, h('div', { class: 'subnav' }, [['general', '常规与外观'], ['service', '服务与运行'], ['config', '配置与备份'], ['diagnostics', '诊断与验收']].map(([id, label]) => button(label, () => { settingsTab = id; actions.render() }, 'ghost', { class: settingsTab === id ? 'active' : '', 'aria-pressed': settingsTab === id ? 'true' : 'false' })))),
      content,
    ),
  )
}
