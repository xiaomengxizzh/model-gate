import { api } from '../api.js'
import { h, button, tag, pageHeader, panel, panelHeader, notice, empty, table, kv, appMark, sectionHead, icon } from '../components/index.js'
import { openModal, field } from '../components/modal.js'
import { renderModelsPanel } from './models.js'
import { openConnectionManager } from './connections.js'

let tab = 'connected'
let query = ''
let templates = null
let templateQuery = ''
let templateError = null

function requestId() { return crypto.randomUUID() }

function errorText(error) {
  if (error.status === 409) return '配置已被其他程序修改，未覆盖。请关闭弹窗并刷新后重试。'
  if (error.status === 428) return '预览已过期或已使用，请关闭弹窗并重新操作。'
  if (error.status === 422) return '服务仍被引用，不能删除。请先处理列出的模型、池或应用引用。'
  return error.message || '操作失败'
}

function openKeyDialog(service, state, actions) {
  const input = h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', required: true, 'aria-label': 'API 凭据', placeholder: '输入 API Key' })
  const previewNote = h('p', { class: 'muted small', text: '' })
  let preview = null
  const modal = openModal({
    title: '配置 ' + (service.displayName || service.label || service.providerId) + ' 的凭据',
    body: h('div', {},
      notice('凭据边界', 'Key 只提交到本机后端加密存储，不进入 localStorage、URL、日志或导出。'),
      h('div', { style: { marginTop: '14px' } }, field('API Key', input, '编辑时留空并关闭不会更改现有凭据。')),
      previewNote,
    ),
    footer: [button('取消', () => modal.close()), button('预览凭据变更', () => form.requestSubmit(), 'primary', { type: 'submit' })],
  })
  const form = h('form', { onSubmit: async (event) => {
    event.preventDefault()
    if (!input.value) { modal.setError('请输入 API Key'); return }
    modal.setBusy(true); modal.setError('')
    try {
      if (!preview) {
        preview = await api.writePreview({
          action: 'keys.update', expectedVersion: state.capabilities.runtime.configVersion,
          requestId: requestId(), id: service.providerId, key: input.value,
        })
        previewNote.textContent = '预览已生成：仅更新此服务的加密凭据，配置代际 ' + preview.expectedVersion + '。请确认安全保存。'
        modal.setFooter(button('取消', () => modal.close()), button('确认安全保存', () => form.requestSubmit(), 'primary', { type: 'submit' }))
        return
      }
      await api.saveKey({
        id: service.providerId, key: input.value, expectedVersion: preview.expectedVersion,
        requestId: preview.requestId, previewId: preview.previewId, confirmToken: preview.confirmToken,
      })
      input.value = ''
      modal.setBusy(false)
      modal.close()
      actions.toast('凭据已由后端加密保存', 'success')
      await actions.refresh()
      actions.render()
    } catch (error) { modal.setError(errorText(error)) }
    finally { modal.setBusy(false) }
  } })
  const body = modal.dialog.querySelector('.dialog-body')
  body.append(form)
}

export function openServiceEditor(service, state, actions, template = null) {
  const creating = !service
  const serviceName = creating ? (template?.name || '') : service.displayName || service.label || service.providerId
  const templateProtocol = { 'openai-chat': 'openai', 'openai-responses': 'responses', 'anthropic-messages': 'anthropic', 'google-gemini': 'gemini', cohere: 'cohere' }[template?.protocol] || 'openai'
  const name = h('input', { required: true, maxlength: 80, value: creating ? serviceName : serviceName, 'aria-label': '服务显示名称' })
  const endpoint = h('input', { required: true, type: 'url', value: creating ? (template?.baseUrl || '') : service.endpoint || service.baseUrl || '', 'aria-label': '服务地址', placeholder: 'https://api.example.com/v1' })
  const protocol = h('select', { 'aria-label': '服务协议' }, ['openai', 'responses', 'anthropic', 'gemini', 'cohere'].map((apiName) => h('option', { value: apiName, selected: (creating ? templateProtocol : service.api) === apiName ? true : undefined, text: apiName })))
  const region = h('input', { maxlength: 40, value: creating ? '' : service.region, 'aria-label': '区域（可选）', placeholder: 'global' })
  const local = h('input', { type: 'checkbox', 'aria-label': '允许本地或私有网络地址' })
  const enabled = h('input', { type: 'checkbox', checked: creating || service.enabled !== false, 'aria-label': '启用服务' })
  let patch = null
  let preview = null
  const modal = openModal({
    title: creating ? (template ? '使用模板 · ' + template.name : '连接模型服务') : '编辑 ' + serviceName,
    body: h('div', {},
      notice('先预览再写入', '服务使用稳定 ID。创建不会自动加入模型池，也不会请求真实上游。'),
      h('div', { style: { marginTop: '14px' } },
        field('服务显示名称', name),
        field('服务地址', endpoint, '仅支持 http(s)；地址不能包含账号或密码。'),
        field('协议', protocol),
        field('区域（可选）', region),
        h('label', { class: 'checkbox-field' }, local, h('span', {}, '允许本地或私有网络地址（仅连接你拥有或获授权的服务）')),
        h('label', { class: 'checkbox-field' }, enabled, h('span', {}, '启用服务（停用后新请求不再路由到该服务）')),
      ),
    ),
    footer: [button('取消', () => modal.close()), button('预览变更', () => form.requestSubmit(), 'primary', { type: 'submit' })],
  })
  const form = h('form', { onSubmit: async (event) => {
    event.preventDefault()
    patch = { displayName: name.value, endpoint: endpoint.value, api: protocol.value, region: region.value, allowPrivateNetwork: local.checked, enabled: enabled.checked, ...(template ? { templateId: template.templateId } : {}) }
    modal.setBusy(true); modal.setError('')
    try {
      preview = await api.configPreview({ action: creating ? 'service.create' : 'service.update', expectedVersion: state.capabilities.runtime.configVersion, requestId: requestId(), ...(creating ? {} : { serviceId: service.providerId }), patch })
      modal.setBusy(false)
      modal.setBody(
        notice('预览结果', '以下变更尚未写入。确认时将重新校验版本与预览绑定。'),
        h('div', { class: 'impact-list' },
          h('div', {}, h('strong', {}, '服务 ID'), h('span', { text: preview.serviceId })),
          h('div', {}, h('strong', {}, '显示名称'), h('span', { text: preview.after.displayName })),
          h('div', {}, h('strong', {}, '地址'), h('span', { text: preview.after.endpoint })),
          h('div', {}, h('strong', {}, '协议'), h('span', { text: preview.after.api })),
        ),
      )
      modal.setFooter(button('取消', () => modal.close()), button('确认' + (creating ? '创建' : '保存'), confirm, 'primary'))
    } catch (error) { modal.setBusy(false); modal.setError(errorText(error)) }
  } })
  modal.dialog.querySelector('.dialog-body').append(form)
  const confirm = async () => {
    if (!preview) return
    modal.setBusy(true); modal.setError('')
    const body = { expectedVersion: preview.expectedVersion, requestId: preview.requestId, previewId: preview.previewId, confirmToken: preview.confirmToken }
    try {
      const result = creating ? await api.createService(body) : await api.updateService(service.providerId, body)
      modal.setBusy(false)
      modal.close()
      actions.toast(creating ? '服务已创建；请单独配置凭据' : '服务变更已保存', 'success')
      await actions.refresh()
      actions.render()
      if (creating && result.service) openKeyDialog(result.service, state.capabilities ? { capabilities: { runtime: { configVersion: result.configVersion } } } : state, actions)
    } catch (error) { modal.setError(errorText(error)) }
    finally { modal.setBusy(false) }
  }
}

function openDeleteDialog(service, state, actions) {
  let credentialAction = 'delete'
  let preview = null
  const deleteRadio = h('input', { type: 'radio', name: 'credential-action', value: 'delete', checked: true })
  const retainRadio = h('input', { type: 'radio', name: 'credential-action', value: 'retain' })
  const modal = openModal({
    title: '删除 ' + (service.displayName || service.label || service.providerId),
    body: h('div', {},
      notice('删除前检查影响', '模型、模型池、Codex 目录或聚合引用会阻止删除。'),
      h('fieldset', { style: { border: 0, padding: 0, margin: '14px 0' } },
        h('legend', {}, '凭据处理'),
        h('label', { class: 'checkbox-field' }, deleteRadio, h('span', {}, '同时删除后端保存的凭据（推荐）')),
        h('label', { class: 'checkbox-field' }, retainRadio, h('span', {}, '保留凭据供以后重新授权使用')),
      ),
    ),
    footer: [button('取消', () => modal.close()), button('预览删除影响', () => previewDelete(), 'danger')],
  })
  const previewDelete = async () => {
    credentialAction = deleteRadio.checked ? 'delete' : 'retain'
    modal.setBusy(true); modal.setError('')
    try {
      preview = await api.configPreview({ action: 'service.delete', expectedVersion: state.capabilities.runtime.configVersion, requestId: requestId(), serviceId: service.providerId, credentialAction })
      modal.setBusy(false)
      const impact = preview.impact
      modal.setBody(
        notice('确认删除', '此操作将通过现有配置事务提交，可阻止时不会写入。'),
        kv([
          ['关联模型', impact.models.length ? impact.models.join('、') : '无'],
          ['关联模型池', impact.pools.length ? impact.pools.join('、') : '无'],
          ['Codex 目录绑定', impact.codexBindings.length ? impact.codexBindings.join('、') : '无'],
          ['凭据', credentialAction === 'delete' ? '同事务删除' : '保留'],
        ]),
      )
      modal.setFooter(button('取消', () => modal.close()), button('确认删除', confirmDelete, 'danger'))
    } catch (error) { modal.setBusy(false); modal.setError(errorText(error)) }
  }
  const confirmDelete = async () => {
    if (!preview) return
    modal.setBusy(true); modal.setError('')
    try {
      await api.deleteService(service.providerId, { expectedVersion: preview.expectedVersion, requestId: preview.requestId, previewId: preview.previewId, confirmToken: preview.confirmToken })
      modal.setBusy(false)
      modal.close(); actions.toast('服务已删除', 'success')
      await actions.refresh(); actions.render()
    } catch (error) { modal.setError(errorText(error)) }
    finally { modal.setBusy(false) }
  }
}

export function renderServices(state, actions) {
  const caps = state.capabilities
  const canWrite = caps.features.find((feature) => feature.id === 'service-lifecycle')?.available === true
  const filtered = caps.services.filter((service) => (service.id + ' ' + service.label + ' ' + service.api + ' ' + (service.endpoint || service.baseUrl || '')).toLowerCase().includes(query.toLowerCase()))
  const search = h('input', { class: 'search', type: 'search', value: query, placeholder: '搜索服务、地址或协议', 'aria-label': '搜索模型服务', onInput: (event) => { query = event.target.value; actions.render() } })
  const tabs = h('div', { class: 'catalog12-tabs', role: 'tablist', 'aria-label': '模型服务视图' },
    button('我的服务 ' + caps.services.length, () => { tab = 'connected'; actions.render() }, 'ghost', { role: 'tab', 'aria-selected': tab === 'connected' ? 'true' : 'false', class: tab === 'connected' ? 'active' : '' }),
    button('服务模型 ' + (state.models?.items?.length || 0), () => { tab = 'models'; actions.render() }, 'ghost', { role: 'tab', 'aria-selected': tab === 'models' ? 'true' : 'false', class: tab === 'models' ? 'active' : '' }),
    button('服务目录', () => { tab = 'directory'; actions.render() }, 'ghost', { role: 'tab', 'aria-selected': tab === 'directory' ? 'true' : 'false', class: tab === 'directory' ? 'active' : '' }),
  )
  let content
  if (tab === 'models') content = renderModelsPanel(state, actions)
  else if (tab === 'directory') {
    if (!templates && !templateError) {
      api.providerTemplates('limit=100').then((result) => { templates = result.items; actions.render() }).catch((error) => { templateError = error; actions.render() })
    }
    const items = (templates || []).filter((item) => (item.name + item.category + item.protocol + item.modelsExample.join(' ')).toLowerCase().includes(templateQuery.toLowerCase()))
    content = panel(null,
      panelHeader('服务目录 · 63 个设计模板', '模板不是实时账户目录；模型权限与额度必须按连接发现。', tag('非实时账户目录', 'warning')),
      h('div', { class: 'toolbar' }, h('input', { class: 'search', type: 'search', value: templateQuery, placeholder: '搜索模板、协议或示例模型', 'aria-label': '搜索服务模板', onInput: (event) => { templateQuery = event.target.value; actions.render() } })),
      templateError ? notice('模板读取失败', templateError.message, 'error') : !templates ? empty('正在读取模板…', '只读取本地版本化目录。') : h('div', { class: 'catalog12-grid' }, items.map((item) => h('article', { class: 'panel catalog12-card' },
        h('div', { class: 'row spread' }, h('div', { class: 'row' }, appMark(item.name.slice(0, 2)), h('div', {}, h('h3', { text: item.name }), h('small', { class: 'muted', text: item.category + ' · ' + item.region }))), tag(item.status, item.status === 'existing-adapter-unverified' ? 'accent' : 'warning')),
        h('small', { class: 'muted', text: item.protocol + ' · ' + item.authKind }),
        h('p', { class: 'small', text: item.modelsExample.length ? '示例：' + item.modelsExample.slice(0, 3).join('、') : '模型需按账户发现' }),
        h('div', { class: 'actions' }, button('使用模板', () => openServiceEditor(null, state, actions, item), 'primary')),
      ))),
    )
  } else {
    content = panel(null,
      panelHeader('我的服务', '连接、凭据来源与可用模型统一管理。', tag(String(caps.services.length) + ' 个服务', 'accent')),
      h('div', { class: 'toolbar' }, search),
      filtered.length ? h('div', { class: 'catalog12-grid' }, filtered.map((service) => h('article', { class: 'panel catalog12-card' },
        h('div', { class: 'row spread' }, h('div', { class: 'row' }, appMark(service.label.slice(0, 2)), h('div', {}, h('h3', {}, h('a', { href: '#/service-detail?service=' + encodeURIComponent(service.providerId), text: service.label })), h('small', { class: 'mono muted', text: service.providerId }))), tag(service.enabled === false ? '已停用' : '已启用', service.enabled === false ? 'danger' : 'good')),
        h('div', { class: 'kv' },
          h('dt', {}, h('span', { text: '协议' })), h('dd', {}, service.api),
          h('dt', {}, h('span', { text: '凭据' })), h('dd', {}, tag(service.credential === 'configured' ? '已配置' : service.credential === 'missing' ? '未配置' : '无法确认', service.credential === 'configured' ? 'success' : 'warning')),
          h('dt', {}, h('span', { text: '状态' })), h('dd', {}, tag(service.health === 'ok' ? '可用候选' : service.health === 'open' ? '熔断中' : service.health === 'half' ? '半开' : '未知', service.health === 'ok' ? 'success' : 'warning')),
          h('dt', {}, h('span', { text: '模型' })), h('dd', {}, String(service.modelCount)),
        ),
        h('div', { class: 'actions' }, button('编辑', () => openServiceEditor(service, state, actions), 'ghost'), button('连接 ' + (service.connections?.length || 0), () => openConnectionManager(service, state, actions), 'ghost'), button('凭据', () => openKeyDialog(service, state, actions), 'ghost'), button('删除', () => openDeleteDialog(service, state, actions), 'ghost danger')),
      ))) : empty(query ? '没有匹配的服务' : '尚未配置服务', query ? '尝试清除搜索条件。' : '点击“连接模型服务”，先预览再写入真实配置。', button('清除搜索', () => { query = ''; actions.render() }, 'ghost')),
    )
  }
  return h('div', { class: 'page' },
    pageHeader('模型服务', '连接你的 AI 套餐或 API，模型与参数尽量自动发现。', button('连接模型服务', () => openServiceEditor(null, state, actions), 'primary', { disabled: !canWrite }, icon('plus'))),
    h('div', { class: 'toolbar' }, tabs, tab === 'directory' ? null : search),
    content,
    sectionHead('自动配置', tag('先发现，再确认', 'accent')),
    h('div', { class: 'grid g3' },
      panel('模型目录', h('p', { class: 'muted', text: '查看可用模型，调整启用状态及别名。' }), h('div', { class: 'actions mt' }, button('高级管理', () => actions.navigate('models'), 'ghost'))),
      panel('模型池', h('p', { class: 'muted', text: '将多个服务的模型组合为一个候选集合。' }), h('div', { class: 'actions mt' }, button('管理模型池', () => actions.navigate('pools'), 'ghost'))),
      panel('通用 API 接入', h('p', { class: 'muted', text: '其他工具需要时才查看地址和密钥管理。' }), h('div', { class: 'actions mt' }, button('查看接入', () => actions.navigate('clients'), 'ghost'))),
    ),
    notice('状态说明', '“已配置”只表示后端能解析凭据引用；“可用候选”只表示熔断状态，不代表模型权限、额度或真实推理已验证。', 'warn'),
  )
}
