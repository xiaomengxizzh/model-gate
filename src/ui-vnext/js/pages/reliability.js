import { h, button, tag, pageHeader, panel, panelHeader, notice, table, kv, statusStrip, sectionHead, icon } from '../components/index.js'
import { api } from '../api.js'
import { openModal, field } from '../components/modal.js'

let policy = null
function requestId() { return crypto.randomUUID() }
async function loadPolicy(actions) { if (policy) return; try { policy = await api.effectivePolicy(); actions.render() } catch { /* 全局配置仍可读 */ } }
function openPolicyEditor(state, actions) {
  const current = policy?.effective?.requestBudget || {}
  const total = h('input', { type: 'number', min: '1', max: '1000', value: current.maxTotalAttempts ?? 24, 'aria-label': '全链发送上限' })
  const failovers = h('input', { type: 'number', min: '0', max: '1000', value: current.maxFailovers ?? 20, 'aria-label': '回退上限' })
  const wait = h('input', { type: 'number', min: '0', max: '3600000', value: current.maxWaitMs ?? 30000, 'aria-label': '累计等待上限' })
  let plan = null
  const modal = openModal({ title: '调整全局请求预算', body: h('div', {}, notice('有界预算', '正常长生成可不设整体硬超时；发送、回退与累计等待始终有界。'), h('div', { style: { marginTop: '14px' } }, field('全链发送上限（含首次）', total), field('回退上限', failovers), field('累计等待上限（ms）', wait))), footer: [button('取消', () => modal.close()), button('预览变更', () => form.requestSubmit(), 'primary', { type: 'submit' })] })
  const form = h('form', { onSubmit: async (event) => { event.preventDefault(); modal.setBusy(true); try { plan = await api.configPreview({ action: 'policy.update', expectedVersion: state.capabilities.runtime.configVersion, requestId: requestId(), scopeType: 'global', overrides: { requestBudget: { maxTotalAttempts: Number(total.value), maxFailovers: Number(failovers.value), maxWaitMs: Number(wait.value) } } }); modal.setBusy(false); modal.setBody(notice('确认策略变更', '只影响新请求；在途请求保持原代际。'), kv([['发送上限', total.value], ['回退上限', failovers.value], ['等待上限', wait.value + ' ms']])); modal.setFooter(button('取消', () => modal.close()), button('确认保存', confirm, 'primary')) } catch (error) { modal.setError(error.message); modal.setBusy(false) } } })
  modal.dialog.querySelector('.dialog-body').append(form)
  const confirm = async () => { modal.setBusy(true); try { await api.savePolicy({ expectedVersion: plan.expectedVersion, requestId: plan.requestId, previewId: plan.previewId, confirmToken: plan.confirmToken }); policy = null; modal.setBusy(false); modal.close(); actions.toast('全局预算已保存', 'success'); await actions.refresh(); actions.render() } catch (error) { modal.setError(error.message); modal.setBusy(false) } }
}

function value(value, suffix = '') {
  if (value === undefined || value === null || value === '') return '未设置'
  return String(value) + suffix
}

export function renderReliability(state, actions, heading = {}) {
  loadPolicy(actions)
  const cfg = state.capabilities.reliability
  const features = state.capabilities.features.filter((feature) => ['unified-request-budget', 'named-pools', 'bidirectional-bindings', 'native-compaction', 'codex-three-modes'].includes(feature.id))
  return h('div', { class: 'page' },
    pageHeader(heading.title || '稳定性策略', heading.description || '让网关处理断线和临时故障。默认推荐设置，必要时按应用调整。', button('调整全局预算', () => openPolicyEditor(state, actions), 'primary', {}, icon('settings'))),
    statusStrip(
      ['生效范围', '全局配置', 'good'],
      ['策略来源', policy ? policy.sources.map((source) => source.scopeType + ':' + source.scopeId).join(' → ') : '后端默认值', 'good'],
      ['真实校准', '待真实故障链', 'warn'],
    ),
    h('div', { class: 'grid g3' }, [
      ['balanced', '推荐', '兼顾等待与稳定性，适合日常使用'],
      ['stable', '稳定优先', '长任务允许更多有界重试与等待'],
      ['fast', '响应优先', '尽早返回失败，避免长时间等待'],
    ].map(([id, name, description]) => h('button', { type: 'button', class: 'modecard', disabled: true, 'aria-label': name + '预设待真实校准' }, h('span', { class: 'radio', 'aria-hidden': 'true' }), h('small', { class: 'mono', text: id.toUpperCase() }), h('h2', { text: name }), h('p', { text: description })))),
    h('div', { class: 'grid policygrid mt' },
      h('div', { class: 'stack' },
        panel('失败重试', h('div', { class: 'policyfield' }, h('div', {}, h('b', { text: '最大重试次数' }), h('small', { text: '不包括首次请求；实际次数由后端安全策略限制。' })), h('span', { class: 'tag accent', text: value(cfg.retry.maxAttempts, ' 次') })), h('div', { class: 'policyfield' }, h('div', {}, h('b', { text: '请求超时' }), h('small', { text: '正常长生成可不设整体硬超时；故障窗口另计。' })), h('span', { class: 'tag accent', text: value(cfg.timeout.overallMs, ' ms') })), h('div', { class: 'policyfield' }, h('div', {}, h('b', { text: '退避方式' }), h('small', { text: '遇到暂时故障时延长等待间隔。' })), h('span', { class: 'tag', text: '指数退避' })), h('div', { class: 'policyfield' }, h('div', {}, h('b', { text: '尊重 429 限流等待' }), h('small', { text: '不吞掉 Retry-After，不盲目重复请求。' })), tag('固定开启', 'good'))),
        panel('断线与续传', h('div', { class: 'policyfield' }, h('div', {}, h('b', { text: '可信断流恢复' }), h('small', { text: '仅未交付且协议支持时恢复；工具与已交付流禁止重放。' })), tag('安全门禁', 'good')), h('div', { class: 'policyfield' }, h('div', {}, h('b', { text: '最大恢复尝试' }), h('small', { text: '达到上限后保留错误，等待用户处理。' })), h('span', { class: 'tag accent', text: value(cfg.defaults?.streamReconnectMax ?? 2, ' 次') })), h('div', { class: 'policyfield' }, h('div', {}, h('b', { text: '原生上下文压缩' }), h('small', { text: '由 Harness 自身负责，不由 ModelGate 自建压缩。' })), tag('保留原生', 'good'))),
        panel('故障回退', h('div', { class: 'policyfield' }, h('div', {}, h('b', { text: '允许已配置的兼容备用模型' }), h('small', { text: '只在明确授权、身份及协议兼容时考虑。' })), tag('按候选授权', 'accent')), h('div', { class: 'actions' }, button('高级路由规则', () => actions.navigate('routing'), 'ghost'))),
      ),
      h('div', { class: 'stack' },
        panel('统一请求预算', kv([
          ['全链发送上限', value(cfg.requestBudget.maxTotalAttempts ?? 24, ' 次（含首次）')],
          ['候选上限', value(cfg.requestBudget.maxAttemptsPerCandidate ?? Math.max(cfg.retry.maxAttempts || 3, (cfg.codexFallbackLimits.maxSameProviderAttempts || 0) + 1), ' 次')],
          ['回退上限', value(cfg.requestBudget.maxFailovers ?? 20, ' 次')],
          ['累计等待上限', value(cfg.requestBudget.maxWaitMs ?? 30000, ' ms')],
          ['正常生成整体超时', cfg.timeout.overallMs ? value(cfg.timeout.overallMs, ' ms') : '不设硬上限'],
        ]), h('p', { class: 'muted small mt', text: cfg.lastRequest ? '最近请求：' + cfg.lastRequest.state.totalAttempts + ' 次发送、' + cfg.lastRequest.state.failovers + ' 次回退、' + cfg.lastRequest.state.waitMs + ' ms 等待' : '尚无真实请求账本。' })),
        panel('当前策略摘要', kv([
          ['重试', value(cfg.retry.maxAttempts, ' 次以内')],
          ['初始退避', value(cfg.retry.initialDelayMs, ' ms')],
          ['最大退避', value(cfg.retry.maxDelayMs, ' ms')],
          ['Codex 总尝试', value(cfg.codexFallbackLimits.maxTotalAttempts, ' 次')],
          ['Codex 最大等待', value(cfg.codexFallbackLimits.maxWaitMs, ' ms')],
        ]), h('div', { class: 'actions mt' }, button('调整全局预算', () => openPolicyEditor(state, actions), 'primary'), button('放弃修改', () => actions.toast('全局配置未修改', 'success'), 'ghost'))),
        panel('超时、并发与熔断', kv([
          ['连接超时', value(cfg.timeout.connectMs, ' ms')],
          ['首字节超时', value(cfg.timeout.firstByteMs, ' ms')],
          ['空闲超时', value(cfg.timeout.idleMs, ' ms')],
          ['循环上限', value(cfg.timeout.loopMs, ' ms')],
          ['每供应商并发', value(cfg.concurrency.maxPerProvider)],
          ['会话亲和 TTL', value(cfg.concurrency.affinityTtlMs, ' ms')],
        ])),
      ),
    ),
    sectionHead('可靠性能力'),
    panel(null, table([{ label: '能力' }, { label: '阶段' }, { label: '代码状态' }, { label: '证据 / 缺口' }], features.map((feature) => [feature.id, feature.stage, tag(feature.available ? '路径存在' : '未接线', feature.available ? 'success' : 'warning'), feature.reason || feature.evidence]), { label: '可靠性能力矩阵' })),
    panel('始终生效的安全边界',
      h('div', { class: 'actiontile' }, h('div', {}, h('b', { text: '不重复执行工具' }), h('small', { text: '工具可能产生副作用时，禁止危险重放。' }))),
      h('div', { class: 'actiontile' }, h('div', {}, h('b', { text: '不静默丢失上下文' }), h('small', { text: '续轮缺失时明确提示，不伪造历史。' }))),
      h('div', { class: 'actiontile' }, h('div', {}, h('b', { text: '不偷偷更换模型' }), h('small', { text: '官方与第三方隔离，禁止未经授权的替换。' }))),
      notice('安全底线', '401 不反复重试；共享额度耗尽不无意义轮换；429 不提前发送；非幂等、未知提交与已执行工具不自动重放。原生压缩只由 Codex 执行。', 'error'),
    ),
  )
}
