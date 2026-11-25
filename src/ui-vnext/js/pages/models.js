import { api } from '../api.js'
import { h, button, tag, panel, panelHeader, notice, empty, metric, appMark, icon } from '../components/index.js'
import { openModal, field } from '../components/modal.js'

function requestId() { return crypto.randomUUID() }
function errorText(error) {
  if (error.status === 409) return '配置或模型名称已变化，请刷新后重试。'
  if (error.status === 422) return '模型仍被默认目录、模型池、其他模型或 Codex 引用，请先解绑。'
  if (error.status === 428) return '预览已过期，请重新操作。'
  return error.message || '模型操作失败'
}

export function openModelEditor(model, state, actions, preset = null) {
  const creating = !model
  const name = h('input', { required: true, value: creating ? (preset?.upstreamModelId || '') : model.name, 'aria-label': '模型公共名' })
  const provider = h('select', { required: true, 'aria-label': '模型服务' }, state.capabilities.services.map((service) => h('option', { value: service.providerId, selected: (!creating ? model.providerId : preset?.providerId) === service.providerId ? true : undefined, text: service.label })))
  const upstream = h('input', { required: true, value: creating ? (preset?.upstreamModelId || '') : model.upstreamModelId, 'aria-label': '上游模型 ID' })
  const display = h('input', { value: creating ? '' : model.displayName, 'aria-label': '模型显示名' })
  const capability = h('select', { 'aria-label': '模型能力' }, ['chat', 'embedding', 'rerank', 'audio', 'image', 'video'].map((value) => h('option', { value, selected: !creating && model.capability === value ? true : undefined, text: value })))
  const protocol = h('select', { 'aria-label': '模型协议' }, ['openai', 'responses', 'anthropic', 'gemini', 'cohere'].map((value) => h('option', { value, selected: !creating && model.api === value ? true : undefined, text: value })))
  let preview = null
  const modal = openModal({
    title: creating ? '添加模型' : '编辑 ' + model.displayName,
    body: h('div', {}, notice('稳定模型 ID', '公共名用于应用选择，上游模型 ID 用于真实服务；能力声明不等于账户权限。'), h('div', { style: { marginTop: '14px' } }, field('模型公共名', name), field('模型服务', provider), field('上游模型 ID', upstream), field('模型显示名', display), field('模型能力', capability), field('模型协议', protocol))),
    footer: [button('取消', () => modal.close()), button('预览变更', () => form.requestSubmit(), 'primary', { type: 'submit' })],
  })
  const form = h('form', { onSubmit: async (event) => {
    event.preventDefault()
    const patch = { name: name.value, providerId: provider.value, upstreamModelId: upstream.value, displayName: display.value, capability: capability.value, api: protocol.value }
    modal.setBusy(true); modal.setError('')
    try {
      preview = await api.configPreview({ action: creating ? 'model.create' : 'model.update', expectedVersion: state.capabilities.runtime.configVersion, requestId: requestId(), ...(creating ? {} : { modelId: model.modelId }), patch })
      modal.setBusy(false); modal.setError('')
      modal.setBody(notice('确认模型变更', '确认后通过现有配置事务保存；不会请求真实模型。'), h('dl', { class: 'kv' }, h('dt', {}, '稳定 ID'), h('dd', {}, preview.modelId), h('dt', {}, '公共名'), h('dd', {}, preview.after.name), h('dt', {}, '上游'), h('dd', {}, preview.after.upstreamModelId)))
      modal.setFooter(button('返回修改', () => modal.close()), button('确认保存', confirm, 'primary'))
    } catch (error) { modal.setBusy(false); modal.setError(errorText(error)) }
  } })
  modal.dialog.querySelector('.dialog-body').append(form)
  const confirm = async () => {
    if (!preview) return
    modal.setBusy(true); modal.setError('')
    const body = { expectedVersion: preview.expectedVersion, requestId: preview.requestId, previewId: preview.previewId, confirmToken: preview.confirmToken }
    try {
      if (creating) await api.createModel(body)
      else await api.updateModel(model.modelId, body)
      modal.setBusy(false); modal.close(); actions.toast('模型变更已保存', 'success')
      await actions.refresh(); actions.render()
    } catch (error) { modal.setError(errorText(error)) }
    finally { modal.setBusy(false) }
  }
}

export function openModelDelete(model, state, actions) {
  let preview = null
  const modal = openModal({ title: '删除 ' + model.displayName, body: notice('删除前检查引用', '模型、池或 Codex 引用会阻止删除。'), footer: [button('取消', () => modal.close()), button('预览删除影响', () => run(), 'danger')] })
  const run = async () => {
    modal.setBusy(true); modal.setError('')
    try {
      preview = await api.configPreview({ action: 'model.delete', expectedVersion: state.capabilities.runtime.configVersion, requestId: requestId(), modelId: model.modelId })
      modal.setBusy(false); modal.setBody(notice('确认删除', '历史用量与日志不会因删除模型而清除。'), h('dl', { class: 'kv' }, ...Object.entries(preview.impact).map(([key, value]) => [key, Array.isArray(value) ? value.join('、') || '无' : '—'])))
      modal.setFooter(button('取消', () => modal.close()), button('确认删除', confirm, 'danger'))
    } catch (error) { modal.setBusy(false); modal.setError(errorText(error)) }
  }
  const confirm = async () => {
    modal.setBusy(true); modal.setError('')
    try {
      await api.deleteModel(model.modelId, { expectedVersion: preview.expectedVersion, requestId: preview.requestId, previewId: preview.previewId, confirmToken: preview.confirmToken })
      modal.setBusy(false); modal.close(); actions.toast('模型已删除', 'success')
      await actions.refresh(); actions.render()
    } catch (error) { modal.setError(errorText(error)) }
    finally { modal.setBusy(false) }
  }
}

export function openModelToggle(model, state, actions) {
  const enabling = model.enabled === false
  const modal = openModal({ title: (enabling ? '启用 ' : '停用 ') + model.displayName, body: notice('路由资格', enabling ? '启用后新请求可再次路由；不会自动调用模型。' : '停用后模型从 /v1/models 隐藏，直接请求返回 404。'), footer: [button('取消', () => modal.close()), button('预览变更', () => run(), 'primary')] })
  const run = async () => {
    modal.setBusy(true); modal.setError('')
    try {
      const preview = await api.configPreview({ action: 'model.update', expectedVersion: state.capabilities.runtime.configVersion, requestId: requestId(), modelId: model.modelId, patch: { enabled: enabling } })
      modal.setBusy(false); modal.setBody(notice('确认' + (enabling ? '启用' : '停用'), '此操作只改变新请求的路由资格。'))
      modal.setFooter(button('取消', () => modal.close()), button('确认', async () => {
        modal.setBusy(true); modal.setError('')
        try { await api.updateModel(model.modelId, { expectedVersion: preview.expectedVersion, requestId: preview.requestId, previewId: preview.previewId, confirmToken: preview.confirmToken }); modal.setBusy(false); modal.close(); actions.toast('模型状态已更新', 'success'); await actions.refresh(); actions.render() }
        catch (error) { modal.setError(errorText(error)); modal.setBusy(false) }
      }, 'primary'))
    } catch (error) { modal.setBusy(false); modal.setError(errorText(error)) }
  }
}

let modelQuery = ''
let modelProvider = 'all'

function discoverModels(state, actions) {
  const services = state.capabilities.services.filter((item) => item.connections?.length)
  if (!services.length) { actions.toast('请先为服务添加连接', 'error'); return }
  const serviceSelect = h('select', { 'aria-label': '发现模型的服务' }, services.map((item) => h('option', { value: item.providerId, text: item.label })))
  const connectionSelect = h('select', { 'aria-label': '发现模型的连接' })
  const resultBox = h('div', { class: 'stack' })
  const syncConnections = () => {
    const service = services.find((item) => item.providerId === serviceSelect.value)
    connectionSelect.replaceChildren(...(service?.connections || []).map((item) => h('option', { value: item.connectionId, text: item.displayName })))
  }
  syncConnections()
  serviceSelect.addEventListener('change', syncConnections)
  const modal = openModal({
    title: '从连接发现模型',
    body: h('div', { class: 'stack' }, notice('只读目录', '只读取账户目录，不自动写入模型，也不代表推理权限。'), h('div', { class: 'fieldgrid' }, h('label', { class: 'field' }, h('span', { class: 'field-label', text: '服务' }), serviceSelect), h('label', { class: 'field' }, h('span', { class: 'field-label', text: '连接' }), connectionSelect)), resultBox),
    footer: [button('关闭', () => modal.close()), button('读取目录', () => run(), 'primary')],
  })
  const run = async () => {
    const service = services.find((item) => item.providerId === serviceSelect.value)
    const connectionId = connectionSelect.value
    if (!service || !connectionId) { modal.setError('请选择有效连接'); return }
    modal.setBusy(true); modal.setError('')
    try {
      const result = await api.discoverModels(service.providerId, connectionId)
      modal.setBusy(false)
      resultBox.replaceChildren(notice('发现结果', '共 ' + result.count + ' 个模型；请逐个确认添加。'), ...result.models.map((item) => h('div', { class: 'actiontile' }, h('div', {}, h('b', { text: item.upstreamModelId })), button('添加模型', () => { modal.close(); openModelEditor(null, state, actions, { providerId: service.providerId, upstreamModelId: item.upstreamModelId }) }, 'primary'))))
    } catch (error) { modal.setBusy(false); modal.setError(error.message); resultBox.replaceChildren(notice('发现失败', error.message, 'error')) }
  }
}

export function renderModelsPanel(state, actions, serviceId = '') {
  if (state.errors.models) return panel('服务模型', notice('模型读取失败', state.errors.models.message, 'error'))
  const models = state.models?.items || []
  const services = state.capabilities.services
  const filtered = models.filter((model) => (serviceId ? model.serviceId === serviceId : (modelProvider === 'all' || model.serviceId === modelProvider)) && (model.name + ' ' + model.displayName + ' ' + model.upstreamModelId).toLowerCase().includes(modelQuery.toLowerCase()))
  return panel(null,
    panelHeader('模型目录', '上游模型、聚合别名、协议能力与验证等级。', button('添加模型', () => openModelEditor(null, state, actions), 'primary', {}, icon('plus'))),
    h('div', { class: 'grid g3' },
      metric('目录模型', models.length, '真实后端模型'),
      metric('启用模型', models.filter((model) => model.enabled).length, '当前路由资格'),
      metric('证据参考', models.filter((model) => model.verification && model.verification !== 'unverified').length, '不等于真实推理通过'),
    ),
    h('div', { class: 'toolbar mt' },
      h('input', { class: 'search', type: 'search', value: modelQuery, placeholder: '搜索模型 ID、名称或角色', 'aria-label': '搜索模型', onInput: (event) => { modelQuery = event.target.value; actions.render() } }),
      h('select', { 'aria-label': '模型服务筛选', value: modelProvider, onChange: (event) => { modelProvider = event.target.value; actions.render() } }, h('option', { value: 'all', text: '全部服务' }), ...services.map((service) => h('option', { value: service.serviceId, text: service.label }))),
      button('从连接发现', () => discoverModels(state, actions), 'ghost'),
    ),
    filtered.length ? h('div', { class: 'catalog12-grid' }, filtered.map((model) => h('article', { class: 'panel catalog12-card' },
      h('div', { class: 'row spread' }, h('div', { class: 'row' }, appMark(model.displayName.slice(0, 2)), h('div', {}, h('h3', { text: model.displayName }), h('small', { class: 'mono muted', text: model.name }))), tag(model.enabled ? '启用' : '停用', model.enabled ? 'good' : 'danger')),
      h('div', { class: 'kv' },
        h('dt', {}, h('span', { text: '服务' })), h('dd', {}, model.serviceId),
        h('dt', {}, h('span', { text: '上游 ID' })), h('dd', {}, model.upstreamModelId),
        h('dt', {}, h('span', { text: '协议' })), h('dd', {}, model.api),
        h('dt', {}, h('span', { text: '能力' })), h('dd', {}, tag(model.capability)),
      ),
      h('div', { class: 'actions' }, button('编辑', () => openModelEditor(model, state, actions), 'ghost'), button('详情', () => actions.toast('稳定 ID：' + model.modelId, 'success'), 'ghost'), button(model.enabled ? '停用' : '启用', () => openModelToggle(model, state, actions), 'ghost'), button('删除', () => openModelDelete(model, state, actions), 'ghost danger')),
    ))) : empty(modelQuery || modelProvider !== 'all' ? '没有匹配的模型' : '尚未添加模型', modelQuery || modelProvider !== 'all' ? '尝试清除搜索或服务筛选。' : '先添加服务，再添加真实上游模型 ID。'),
  )
}
