import { api } from '../api.js'
import { h, button, tag, notice, empty, kv } from '../components/index.js'
import { openModal, field } from '../components/modal.js'

function requestId() { return crypto.randomUUID() }
function errorText(error) { return error.status === 422 ? '不能停用或删除服务最后一个启用连接。' : error.message || '连接操作失败' }
async function refresh(state, actions) { await actions.refresh(); actions.render() }

function connectionBody(service, state, actions, manager) {
  const items = service.connections || []
  return items.length ? h('div', { class: 'stack' }, items.map((item) => h('article', { class: 'panel stack' },
    h('div', { class: 'row spread' }, h('strong', {}, item.displayName), tag(item.enabled ? '启用 · 待真实验证' : '停用', item.enabled ? 'warning' : 'danger')),
    kv([['稳定 ID', item.connectionId], ['优先级', String(item.priority)], ['最大并发', item.maxConcurrent || '继承服务'], ['额度域', item.quotaScopeId || '独立'], ['凭据', item.credentialConfigured ? '已配置' : '未配置']]),
    h('div', { class: 'row' }, button('编辑', () => openConnectionEditor(item, service, state, actions, manager), 'ghost'), button('凭据', () => openConnectionKey(item, state, actions), 'ghost'), button(item.enabled ? '停用' : '启用', () => openConnectionToggle(item, service, state, actions, manager), 'ghost'), button('删除', () => openConnectionDelete(item, service, state, actions, manager), 'ghost danger')),
  ))) : empty('尚无连接', '为服务添加第一个授权连接。')
}

export function openConnectionManager(service, state, actions) {
  const modal = openModal({ title: service.label + ' · 连接管理', body: null, footer: [button('关闭', () => modal.close()), button('添加连接', () => openConnectionEditor(null, service, state, actions, modal), 'primary')], width: '720px' })
  modal.setBody(connectionBody(service, state, actions, modal))
}

function openConnectionEditor(connection, service, state, actions, manager) {
  if (manager) manager.close()
  const creating = !connection
  const name = h('input', { required: true, value: creating ? '' : connection.displayName, 'aria-label': '连接显示名' })
  const priority = h('input', { type: 'number', min: '0', value: creating ? 0 : connection.priority, 'aria-label': '连接优先级' })
  const maxConcurrent = h('input', { type: 'number', min: '0', value: creating ? 0 : connection.maxConcurrent, 'aria-label': '连接最大并发' })
  const quota = h('input', { value: creating ? '' : connection.quotaScopeId, 'aria-label': '共享额度域' })
  const domain = h('input', { value: creating ? '' : connection.authDomain, 'aria-label': '认证域' })
  let plan = null
  const modal = openModal({ title: creating ? '添加连接' : '编辑 ' + connection.displayName, body: h('div', {}, notice('独立身份', '每个连接有独立 ID、Key、优先级、并发与额度域；不会跨身份绕过限制。'), h('div', { style: { marginTop: '14px' } }, field('连接显示名', name), field('优先级', priority), field('最大并发（0=继承）', maxConcurrent), field('共享额度域（可选）', quota), field('认证域（可选）', domain))), footer: [button('取消', () => modal.close()), button('预览变更', () => form.requestSubmit(), 'primary', { type: 'submit' })] })
  const form = h('form', { onSubmit: async (event) => {
    event.preventDefault(); modal.setBusy(true); modal.setError('')
    try {
      plan = await api.configPreview({ action: creating ? 'connection.create' : 'connection.update', expectedVersion: state.capabilities.runtime.configVersion, requestId: requestId(), providerId: service.providerId, ...(creating ? {} : { connectionId: connection.connectionId }), patch: { displayName: name.value, priority: Number(priority.value), maxConcurrent: Number(maxConcurrent.value), quotaScopeId: quota.value, authDomain: domain.value } })
      modal.setBusy(false); modal.setBody(notice('确认连接变更', '凭据需在保存后单独输入。'), kv([['连接 ID', plan.connectionId], ['显示名', plan.after.displayName], ['优先级', String(plan.after.priority)]])); modal.setFooter(button('取消', () => modal.close()), button('确认保存', confirm, 'primary'))
    } catch (error) { modal.setBusy(false); modal.setError(errorText(error)) }
  } })
  modal.dialog.querySelector('.dialog-body').append(form)
  const confirm = async () => {
    modal.setBusy(true); modal.setError('')
    try { const result = creating ? await api.createConnection({ expectedVersion: plan.expectedVersion, requestId: plan.requestId, previewId: plan.previewId, confirmToken: plan.confirmToken }) : await api.updateConnection(connection.connectionId, { expectedVersion: plan.expectedVersion, requestId: plan.requestId, previewId: plan.previewId, confirmToken: plan.confirmToken }); modal.setBusy(false); modal.close(); manager.close(); actions.toast('连接已保存', 'success'); await refresh(state, actions); const created = result.item || state.capabilities.services.find((item) => item.providerId === service.providerId)?.connections?.find((item) => item.connectionId === plan.connectionId); if (creating && created) openConnectionKey(created, state, actions) } catch (error) { modal.setError(errorText(error)) } finally { modal.setBusy(false) }
  }
}

function openConnectionToggle(connection, service, state, actions, manager) {
  const enabling = !connection.enabled
  const modal = openModal({ title: (enabling ? '启用 ' : '停用 ') + connection.displayName, body: notice('路由资格', enabling ? '启用后参与新请求轮换。' : '停用后不再接收新请求；最后一个启用连接不可停用。'), footer: [button('取消', () => modal.close()), button('预览变更', () => run(), 'primary')] })
  const run = async () => {
    modal.setBusy(true); modal.setError('')
    try { const plan = await api.configPreview({ action: 'connection.update', expectedVersion: state.capabilities.runtime.configVersion, requestId: requestId(), providerId: service.providerId, connectionId: connection.connectionId, patch: { enabled: enabling } }); modal.setBusy(false); modal.setFooter(button('取消', () => modal.close()), button('确认', async () => { modal.setBusy(true); try { await api.updateConnection(connection.connectionId, { expectedVersion: plan.expectedVersion, requestId: plan.requestId, previewId: plan.previewId, confirmToken: plan.confirmToken }); modal.setBusy(false); modal.close(); manager.close(); actions.toast('连接状态已更新', 'success'); await refresh(state, actions) } catch (error) { modal.setError(errorText(error)); modal.setBusy(false) } }, 'primary')) } catch (error) { modal.setBusy(false); modal.setError(errorText(error)) }
  }
}

function openConnectionDelete(connection, service, state, actions, manager) {
  let action = 'delete'
  const modal = openModal({ title: '删除 ' + connection.displayName, body: h('div', {}, notice('凭据策略', '删除连接可选择同时删除后端凭据；最后一个启用连接会被阻止。'), h('label', { class: 'checkbox-field' }, h('input', { type: 'checkbox', checked: true, onChange: (event) => { action = event.target.checked ? 'delete' : 'retain' } }), h('span', {}, '同时删除凭据（推荐）'))), footer: [button('取消', () => modal.close()), button('预览删除', () => run(), 'danger')] })
  const run = async () => {
    modal.setBusy(true); modal.setError('')
    try { const plan = await api.configPreview({ action: 'connection.delete', expectedVersion: state.capabilities.runtime.configVersion, requestId: requestId(), providerId: service.providerId, connectionId: connection.connectionId, credentialAction: action }); modal.setBusy(false); modal.setBody(notice('确认删除', '服务其它连接与历史记录不受影响。')); modal.setFooter(button('取消', () => modal.close()), button('确认删除', async () => { modal.setBusy(true); try { await api.deleteConnection(connection.connectionId, { expectedVersion: plan.expectedVersion, requestId: plan.requestId, previewId: plan.previewId, confirmToken: plan.confirmToken }); modal.setBusy(false); modal.close(); manager.close(); actions.toast('连接已删除', 'success'); await refresh(state, actions) } catch (error) { modal.setError(errorText(error)); modal.setBusy(false) } }, 'danger')) } catch (error) { modal.setBusy(false); modal.setError(errorText(error)) }
  }
}

export function openConnectionKey(connection, state, actions) {
  const input = h('input', { type: 'password', autocomplete: 'off', required: true, 'aria-label': '连接 API Key' })
  const previewNote = h('p', { class: 'muted small', text: '' })
  let preview = null
  const modal = openModal({ title: connection.displayName + ' · 凭据', body: h('div', {}, notice('独立加密存储', 'Key 只进入后端加密 Key 库，不进入浏览器存储。'), h('div', { style: { marginTop: '14px' } }, field('API Key', input)), previewNote), footer: [button('取消', () => modal.close()), button('预览凭据变更', () => form.requestSubmit(), 'primary', { type: 'submit' })] })
  const form = h('form', { onSubmit: async (event) => {
    event.preventDefault()
    if (!input.value) { modal.setError('请输入连接 API Key'); return }
    modal.setBusy(true); modal.setError('')
    try {
      if (!preview) {
        preview = await api.writePreview({
          action: 'keys.update', expectedVersion: state.capabilities.runtime.configVersion,
          requestId: requestId(), id: connection.credentialKeyId || connection.connectionId, key: input.value,
        })
        previewNote.textContent = '预览已生成：仅更新此连接的加密凭据，配置代际 ' + preview.expectedVersion + '。请确认安全保存。'
        modal.setFooter(button('取消', () => modal.close()), button('确认安全保存', () => form.requestSubmit(), 'primary', { type: 'submit' }))
        return
      }
      await api.saveKey({
        id: connection.credentialKeyId || connection.connectionId, key: input.value,
        expectedVersion: preview.expectedVersion, requestId: preview.requestId,
        previewId: preview.previewId, confirmToken: preview.confirmToken,
      })
      input.value = ''
      modal.setBusy(false)
      modal.close()
      actions.toast('连接凭据已加密保存', 'success')
      await refresh(state, actions)
    } catch (error) { modal.setError(error.message) }
    finally { modal.setBusy(false) }
  } })
  modal.dialog.querySelector('.dialog-body').append(form)
}
