import { api } from '../api.js'
import { h, button, tag, pageHeader, panel, panelHeader, notice, empty, table, kv, metric, icon } from '../components/index.js'
import { openModal, field } from '../components/modal.js'

let selected = ''
let query = ''
let preview = null
let previewError = null
let previewModel = ''
let busy = false
let previewController = null
let poolTab = 'members'

function requestId() { return crypto.randomUUID() }
function errorText(error) {
  if (error.status === 409) return '配置、名称或版本已变化，请刷新后重试。'
  if (error.status === 422) return '池成员不足或池仍被应用引用，不能完成操作。'
  if (error.status === 428) return '预览已过期，请重新操作。'
  return error.message || '模型池操作失败'
}

export function openPoolEditor(pool, state, actions, duplicate = null) {
  const source = duplicate || pool
  const creating = !pool
  const name = h('input', { required: true, value: creating ? (source?.name ? source.name + ' 副本' : '') : source.name, 'aria-label': '模型池名称' })
  const selection = h('select', { 'aria-label': '池选择方式' }, [['priority', '顺序优先'], ['weighted', '按权重'], ['round_robin', '轮询']].map(([value, label]) => h('option', { value, selected: (creating ? source?.selection : source.selection) === value ? true : undefined, text: label })))
  const candidates = h('div', { class: 'pool-candidate-picker' }, (state.models?.items || []).map((model) => {
    const existing = source?.members?.find((member) => member.model === model.name)
    const checkbox = h('input', { type: 'checkbox', value: model.name, checked: !!existing, 'aria-label': '选择 ' + model.name })
    const priority = h('input', { type: 'number', min: '0', value: existing?.priority ?? 0, 'aria-label': model.name + ' 优先级' })
    const weight = h('input', { type: 'number', min: '1', max: '100', value: existing?.weight || 1, 'aria-label': model.name + ' 权重' })
    return h('label', { class: 'candidate-choice' }, checkbox, h('span', {}, model.displayName), priority, weight)
  }))
  let plan = null
  const modal = openModal({
    title: creating ? (source ? '复制模型池' : '新建模型池') : '编辑 ' + source.name,
    body: h('div', {}, field('模型池名称', name), field('选择方式', selection), h('h3', {}, '候选模型'), candidates, notice('选择与回退', '至少选择一个模型。权重只在“按权重”时生效；失败回退仍需后端预算与安全策略允许。')),
    footer: [button('取消', () => modal.close()), button('预览变更', () => form.requestSubmit(), 'primary', { type: 'submit' })],
  })
  const form = h('form', { onSubmit: async (event) => {
    event.preventDefault()
    const members = [...candidates.querySelectorAll('.candidate-choice')].filter((row) => row.querySelector('input[type="checkbox"]').checked).map((row, index) => {
      const model = row.querySelector('input[type="checkbox"]').value
      return { model, priority: Number(row.querySelector('input[type="number"]').value), weight: selection.value === 'weighted' ? Number(row.querySelectorAll('input[type="number"]')[1].value) : 0 }
    })
    if (!members.length) { modal.setError('至少选择一个候选模型'); return }
    modal.setBusy(true); modal.setError('')
    try {
      plan = await api.configPreview({ action: creating ? 'pool.create' : 'pool.update', expectedVersion: state.capabilities.runtime.configVersion, requestId: requestId(), ...(creating ? {} : { poolId: source.poolId || source.slug }), patch: { name: name.value, selection: selection.value, members } })
      modal.setBusy(false); modal.setBody(notice('确认模型池变更', '成员将同步到现有虚拟模型目录，不建立平行路由。'), kv([['稳定 ID', plan.poolId], ['访问别名', plan.after.slug], ['候选数', String(plan.after.members.length)], ['选择方式', plan.after.selection]]))
      modal.setFooter(button('返回修改', () => modal.close()), button('确认保存', confirm, 'primary'))
    } catch (error) { modal.setBusy(false); modal.setError(errorText(error)) }
  } })
  modal.dialog.querySelector('.dialog-body').append(form)
  const confirm = async () => {
    modal.setBusy(true); modal.setError('')
    const body = { expectedVersion: plan.expectedVersion, requestId: plan.requestId, previewId: plan.previewId, confirmToken: plan.confirmToken }
    try {
      if (creating) await api.createPool(body)
      else await api.updatePool(source.poolId || source.slug, body)
      modal.setBusy(false); modal.close(); actions.toast('模型池已保存', 'success')
      await actions.refresh(); actions.render()
    } catch (error) { modal.setError(errorText(error)) }
    finally { modal.setBusy(false) }
  }
}

function openPoolDelete(pool, state, actions) {
  let plan = null
  const modal = openModal({ title: '删除 ' + pool.name, body: notice('删除前检查引用', 'Codex 或应用引用会阻止删除；在途请求数量未知。'), footer: [button('取消', () => modal.close()), button('预览删除影响', () => run(), 'danger')] })
  const run = async () => {
    modal.setBusy(true); modal.setError('')
    try {
      plan = await api.configPreview({ action: 'pool.delete', expectedVersion: state.capabilities.runtime.configVersion, requestId: requestId(), poolId: pool.poolId || pool.slug })
      modal.setBusy(false); modal.setBody(notice('确认删除', '历史用量与日志保留。'), kv([['Codex 引用', plan.impact.codexBindings.join('、') || '无'], ['应用引用', plan.impact.harnessBindings.join('、') || '无'], ['在途请求', '未知；不影响已启动请求']]))
      modal.setFooter(button('取消', () => modal.close()), button('确认删除', confirm, 'danger'))
    } catch (error) { modal.setBusy(false); modal.setError(errorText(error)) }
  }
  const confirm = async () => {
    modal.setBusy(true); modal.setError('')
    try { await api.deletePool(pool.poolId || pool.slug, { expectedVersion: plan.expectedVersion, requestId: plan.requestId, previewId: plan.previewId, confirmToken: plan.confirmToken }); modal.setBusy(false); modal.close(); actions.toast('模型池已删除', 'success'); await actions.refresh(); actions.render() }
    catch (error) { modal.setError(errorText(error)) }
    finally { modal.setBusy(false) }
  }
}

function openBindingEditor(pool, state, actions, binding = null) {
  const creating = !binding
  const harness = h('select', { 'aria-label': '绑定应用' }, [['codex', 'Codex'], ['claude-code', 'Claude Code'], ['opencode', 'OpenCode'], ['dsh', 'DSH']].map(([value, label]) => h('option', { value, text: label })))
  const role = h('select', { 'aria-label': '接入角色' }, [['route', '纯路由'], ['child', '子模型'], ['parent', '父模型']].map(([value, label]) => h('option', { value, text: label })))
  let plan = null
  const modal = openModal({ title: creating ? '添加应用引用' : '编辑应用引用', body: h('div', {}, notice('期望引用', '创建稳定 desired 引用；Codex 仍需在接入页预览应用，其他 Harness 需各自适配器验收。'), h('div', { style: { marginTop: '14px' } }, field('应用', harness), field('角色', role))), footer: [button('取消', () => modal.close()), button('预览引用', () => form.requestSubmit(), 'primary', { type: 'submit' })] })
  const form = h('form', { onSubmit: async (event) => { event.preventDefault(); modal.setBusy(true); try { plan = await api.configPreview({ action: creating ? 'binding.create' : 'binding.update', expectedVersion: state.capabilities.runtime.configVersion, requestId: requestId(), ...(creating ? {} : { bindingId: binding.bindingId }), patch: { harnessId: harness.value, instanceId: 'default', mode: harness.value === 'codex' ? (role.value === 'child' ? 'aggregated' : 'route') : 'api', roleTargets: { [role.value]: { kind: 'pool', id: pool.poolId || pool.slug } } } }); modal.setBusy(false); modal.setBody(notice('确认引用', '此操作保存期望绑定，不冒充适配器已实际生效。'), kv([['应用', harness.value], ['角色', role.value], ['模型池', pool.name]])); modal.setFooter(button('取消', () => modal.close()), button('确认保存', confirm, 'primary')) } catch (error) { modal.setError(error.message); modal.setBusy(false) } } })
  modal.dialog.querySelector('.dialog-body').append(form)
  const confirm = async () => { modal.setBusy(true); try { if (creating) await api.createBinding({ expectedVersion: plan.expectedVersion, requestId: plan.requestId, previewId: plan.previewId, confirmToken: plan.confirmToken }); else await api.updateBinding(binding.bindingId, { expectedVersion: plan.expectedVersion, requestId: plan.requestId, previewId: plan.previewId, confirmToken: plan.confirmToken }); modal.setBusy(false); modal.close(); actions.toast('应用引用已保存', 'success'); await actions.refresh(); actions.render() } catch (error) { modal.setError(error.message); modal.setBusy(false) } }
}
function deleteBinding(binding, state, actions) {
  const modal = openModal({ title: '解除应用引用', body: notice('确认解除', '只删除期望引用，不撤销外部 Harness 已写入的配置。'), footer: [button('取消', () => modal.close()), button('预览解除', () => run(), 'danger')] })
  const run = async () => { modal.setBusy(true); try { const plan = await api.configPreview({ action: 'binding.delete', expectedVersion: state.capabilities.runtime.configVersion, requestId: requestId(), bindingId: binding.bindingId }); modal.setBusy(false); modal.setFooter(button('取消', () => modal.close()), button('确认解除', async () => { modal.setBusy(true); try { await api.deleteBinding(binding.bindingId, { expectedVersion: plan.expectedVersion, requestId: plan.requestId, previewId: plan.previewId, confirmToken: plan.confirmToken }); modal.setBusy(false); modal.close(); actions.toast('应用引用已解除', 'success'); await actions.refresh(); actions.render() } catch (error) { modal.setError(error.message); modal.setBusy(false) } }, 'danger')) } catch (error) { modal.setError(error.message); modal.setBusy(false) } }
}

export function showPoolTab(tab) { poolTab = ['members', 'strategy', 'apps', 'test'].includes(tab) ? tab : 'members' }

export function renderPools(state, actions) {
  const pools = state.pools?.items || []
  if (!pools.some((pool) => (pool.poolId || pool.slug || pool.name) === selected)) selected = pools[0] ? (pools[0].poolId || pools[0].slug || pools[0].name) : ''
  const pool = pools.find((item) => (item.poolId || item.slug || item.name) === selected)
  const refs = (state.bindings?.items || []).filter((binding) => Object.values(binding.roleTargets || {}).some((target) => target.id === pool?.poolId || target.id === pool?.slug || target.id === pool?.name))
  const filtered = pools.filter((item) => item.name.toLowerCase().includes(query.toLowerCase()))
  const search = h('input', { class: 'search', type: 'search', value: query, placeholder: '搜索模型池', 'aria-label': '搜索模型池', onInput: (event) => { query = event.target.value; actions.render() } })
  return h('div', { class: 'page' },
    pageHeader('模型池', '组合候选、设置选择与回退，并查看应用引用。', button('新建模型池', () => openPoolEditor(null, state, actions), 'primary', {}, icon('plus'))),
    state.errors.pools ? notice('模型池读取失败', state.errors.pools.message, 'error') : null,
    h('div', { class: 'pool-layout' },
      h('aside', { class: 'pool-sidebar' },
        panel('我的模型池 ' + pools.length,
          search,
          h('div', { class: 'pool-list', style: { marginTop: '12px' } }, filtered.length ? filtered.map((item) => h('button', { type: 'button', class: 'pool-item pool-card', 'aria-pressed': (item.poolId || item.slug || item.name) === selected ? 'true' : 'false', onClick: () => { previewController?.abort(); selected = item.poolId || item.slug || item.name; preview = null; previewError = null; actions.render() } }, h('strong', { text: item.name }), h('small', { text: item.members.length + ' 个候选 · ' + item.selection }))) : empty('没有模型池', query ? '没有匹配结果。' : '新建池并添加候选。')),
        ),
        panel('应用引用', h('div', { class: 'metric-value numeric', text: refs.length }), h('p', { class: 'muted small', text: refs.length ? '当前池已被应用引用，删除前会展示影响。' : '当前池尚无应用引用。' })),
      ),
      pool ? h('div', { class: 'pool-detail' },
        panel(null,
          h('div', { class: 'pool-head' },
            h('div', {}, h('h2', { text: pool.name }), h('small', { class: 'mono muted', text: pool.poolId || pool.slug || '旧虚拟模型' })),
            h('div', { class: 'row' }, tag(pool.poolId ? '稳定池 ID' : '旧虚拟模型', pool.poolId ? 'accent' : 'warning'), tag(pool.enabled ? '已启用 · 未推理验收' : '已停用', pool.enabled ? 'warning' : 'danger'), button('编辑', () => openPoolEditor(pool, state, actions), 'ghost'), button('复制', () => openPoolEditor(null, state, actions, pool), 'ghost'), button('删除', () => openPoolDelete(pool, state, actions), 'ghost danger')),
          ),
          h('div', { class: 'pool-metrics' },
            metric('候选模型', pool.members.length, '当前池成员'),
            metric('模型服务', new Set(pool.members.map((member) => member.providerId)).size, '按 provider 去重'),
            metric('应用引用', refs.length, 'desired 绑定'),
          ),
          h('div', { class: 'tabs8', role: 'tablist', 'aria-label': '模型池详情', style: { marginTop: '14px' } },
            button('候选模型', () => { poolTab = 'members'; actions.render() }, 'ghost', { role: 'tab', 'aria-selected': poolTab === 'members' ? 'true' : 'false', class: poolTab === 'members' ? 'active' : '' }),
            button('选择与回退', () => { poolTab = 'strategy'; actions.render() }, 'ghost', { role: 'tab', 'aria-selected': poolTab === 'strategy' ? 'true' : 'false', class: poolTab === 'strategy' ? 'active' : '' }),
            button('应用引用 ' + refs.length, () => { poolTab = 'apps'; actions.render() }, 'ghost', { role: 'tab', 'aria-selected': poolTab === 'apps' ? 'true' : 'false', class: poolTab === 'apps' ? 'active' : '' }),
            button('模拟测试', () => { poolTab = 'test'; actions.render() }, 'ghost', { role: 'tab', 'aria-selected': poolTab === 'test' ? 'true' : 'false', class: poolTab === 'test' ? 'active' : '' }),
          ),
          h('div', { class: 'pool-body8' },
            poolTab === 'members' ? h('div', { class: 'member-scroll' }, table([{ label: '模型 / 服务' }, { label: '顺序', numeric: true }, { label: '权重', numeric: true }, { label: '状态' }], pool.members.map((member) => [
              h('div', {}, h('strong', { text: member.model }), h('small', { class: 'muted', text: member.providerId })),
              member.priority,
              member.weight,
              tag(member.enabled ? '候选已配置' : '已停用', member.enabled ? 'warning' : 'danger'),
            ]), { label: pool.name + '候选模型' })) : null,
            poolTab === 'strategy' ? h('div', { class: 'stack' }, notice('选择与回退', '顺序优先、权重或轮询已接入运行时；应用/Harness 覆盖与硬约束在稳定性页查看。'), button('调整全局预算', () => actions.navigate('reliability'), 'primary')) : null,
            poolTab === 'apps' ? h('div', { class: 'stack' },
              notice('期望引用', '引用稳定保存；实际生效取决于对应 Harness 适配器，Codex 请在接入页预览应用。'),
              refs.length ? refs.map((binding) => h('div', { class: 'actiontile' }, h('div', {}, h('b', { text: binding.harnessId + ' · ' + Object.keys(binding.roleTargets).join(',') }), h('small', { class: 'muted', text: binding.verification + ' · desired ' + binding.desiredRevision })), h('div', { class: 'row' }, button('编辑', () => openBindingEditor(pool, state, actions, binding), 'ghost'), button('解除', () => deleteBinding(binding, state, actions), 'ghost danger')))) : empty('尚无应用引用', '创建引用后，删除池会显示影响预览。'),
              button('添加应用引用', () => openBindingEditor(pool, state, actions), 'primary'),
            ) : null,
            poolTab === 'test' ? notice('无副作用预演', '在下方输入模型或模型池名称。预演复用真实路由解析器，不请求上游、不执行工具、不消耗额度。') : null,
          ),
        ),
        panel('无副作用路由预演',
          h('p', { class: 'muted', text: '调用同一后端解析器，只显示命中结果，不请求上游、不执行工具、不消耗额度。' }),
          h('form', { class: 'toolbar mt', onSubmit: async (event) => {
            event.preventDefault()
            if (busy || !previewModel.trim()) return
            const controller = new AbortController()
            const requestEpoch = actions.routeEpoch?.()
            previewController = controller
            busy = true; preview = null; previewError = null; actions.render()
            try {
              const result = await api.routePreview(previewModel.trim(), { signal: controller.signal })
              if (actions.routeEpoch?.() !== requestEpoch) return
              preview = result
              actions.toast('预演完成：未请求上游', 'success')
            } catch (error) {
              if (error.aborted || actions.routeEpoch?.() !== requestEpoch) return
              previewError = error
              actions.toast(error.message, 'error')
            } finally {
              if (previewController === controller) previewController = null
              busy = false
              if (actions.routeEpoch?.() === requestEpoch) actions.render()
            }
          } },
            h('input', { class: 'search', required: true, value: previewModel, placeholder: '输入模型或模型池名称', 'aria-label': '预演模型名称', disabled: busy, onInput: (event) => { previewModel = event.target.value } }),
            button(busy ? '正在预演…' : '运行预演', null, 'primary', { type: 'submit', disabled: busy }),
            busy ? button('取消预演', () => previewController?.abort(), 'ghost') : null,
          ),
          previewError ? notice('预演失败', previewError.message, 'error') : null,
          preview ? panel(null, kv([['命中类型', preview.hit.type], ['名称', preview.hit.name || preview.hit.model || '—'], ['候选顺序', Array.isArray(preview.hit.directory) ? preview.hit.directory.map((entry) => entry.model).join(' → ') : '—'], ['上游调用', '0']])) : null,
        ),
      ) : panel('模型池详情', empty('尚未选择模型池', '新建池并添加候选模型。')),
    ),
    notice('应用引用', '双向 Harness 绑定与统一恢复预算已接线；此页不把旧虚拟模型或规划引用称为已生效。', 'warn'),
  )
}
