// Dashboard: real /api/status data only. No simulated metrics.
import { h } from '../dom.js'
import { state, deriveWarnings } from '../store.js'
import { fmtInt, fmtCompact, fmtMs, fmtPct, fmtAgo, fmtDuration, fmtTime, safeOrigin } from '../format.js'
import { pageHead, card, metric, tag, statusTag, callout, empty, table, lineChart, barChart, kvList } from '../components.js'

function healthSummary(s) {
  const providers = Array.isArray(s.providers) ? s.providers : []
  const open = providers.filter((p) => p.st && p.st.state === 'open').length
  const degraded = providers.filter((p) => p.st && (p.st.state === 'half' || p.st.state === 'degraded')).length
  const noKey = providers.filter((p) => !p.hasKey).length
  if (!providers.length) return { label: '尚未配置上游', kind: 'warn', detail: '添加 Provider 后开始路由' }
  if (open) return { label: '部分上游熔断', kind: 'bad', detail: open + ' 个上游被跳过，其余继续服务' }
  if (degraded) return { label: '部分上游降级', kind: 'warn', detail: degraded + ' 个上游处于半开/降级' }
  if (noKey) return { label: '凭据未就绪', kind: 'warn', detail: noKey + ' 个上游缺少 Key' }
  return { label: '运行正常', kind: 'good', detail: '所有已配置上游均可用' }
}

export function render(root) {
  const s = state.status || {}
  const g = s.global || {}
  const providers = Array.isArray(s.providers) ? s.providers : []
  const models = Array.isArray(s.models) ? s.models : []
  const virtualModels = Array.isArray(s.virtualModels) ? s.virtualModels : []
  const health = healthSummary(s)
  const warnings = deriveWarnings()

  root.append(pageHead('一切模型，尽在掌控。', '本地优先的模型网关控制面：查看真实请求指标、上游健康、路由结果与需要关注的配置问题。', {
    eyebrow: 'GATEWAY / OVERVIEW',
    actions: [
      h('button', { class: 'btn', type: 'button', text: '查看监控与诊断', onclick: () => { location.hash = '#/observability' } }),
      h('button', { class: 'btn btn-primary', type: 'button', text: '管理上游供应商', onclick: () => { location.hash = '#/providers' } }),
    ],
  }))

  root.append(h('section', { class: 'hero' },
    h('div', null,
      h('div', { class: 'hero-badge' }, h('span', { class: 'pulse is-' + (health.kind === 'good' ? 'good' : health.kind === 'bad' ? 'bad' : 'warn') }), h('span', { text: health.label })),
      h('h2', { text: 'ModelGate · 本地控制面' }),
      h('p', { text: health.detail + ' · 配置版本 ' + (s.configVersion ?? '—') + ' · 已运行 ' + fmtDuration(s.uptimeMs) })),
    h('div', { class: 'text-right' },
      h('div', { class: 'mono', style: { fontSize: '12px', color: '#cfe9e4' }, text: safeOrigin(location.origin) }),
      h('div', { style: { marginTop: '8px', fontSize: '11px', color: '#9fc3c6' }, text: providers.length + ' 个上游 · ' + models.length + ' 个真实模型 · ' + virtualModels.length + ' 个虚拟入口' }))))

  root.append(h('div', { class: 'grid grid-4' },
    metric('累计请求', fmtInt(g.requests), '数据来自进程内真实计数', 'probe'),
    metric('错误请求', fmtInt(g.errors), providers.length ? '错误率 ' + fmtPct((Number(g.requests) ? Number(g.errors) / Number(g.requests) * 100 : 0)) : '暂无请求', 'warn'),
    metric('累计 Token', fmtCompact(g.tokenCount), '来自上游 usage 的真实累计', 'plus'),
    metric('P95 延迟', fmtMs(g.p95), '按已确认完成的请求样本', 'refresh')))

  const trendCard = card('请求延迟趋势', '最近的真实延迟采样，单位毫秒',
    g.latTrend && g.latTrend.length ? lineChart(g.latTrend, { label: '最近请求延迟趋势', format: fmtMs }) : empty('暂无延迟趋势', '网关尚未累积足够的完成请求样本。'))
  const healthCard = card('上游健康', '状态来自网关熔断器与真实请求结果', providers.length
    ? h('div', { class: 'list' }, providers.slice(0, 8).map((p) => h('div', { class: 'list-row' },
      h('div', { class: 'grow' },
        h('div', { class: 'primary', text: p.id }),
        h('div', { class: 'secondary', text: (p.api || 'openai') + ' · ' + fmtInt(p.st?.requests) + ' 请求 · ' + fmtInt(p.st?.errors) + ' 错误 · ' + fmtMs(p.st?.p95) })),
      h('div', { class: 'flex' },
        !p.hasKey ? tag('缺 Key', 'warn') : null,
        statusTag(p.st?.state && p.st.state !== 'ok' ? p.st.state : 'ok')))))
    : empty('尚未配置上游', '在「上游供应商」添加 Provider 后，这里会显示健康状态。'))

  root.append(h('div', { class: 'grid grid-main' }, trendCard, healthCard))

  const lastServing = s.lastServing
  const dialogues = Array.isArray(s.dialogues) ? s.dialogues : []
  const routeCard = card('最近路由', '最后一次真实完成的模型路由与会话', h('div', null,
    lastServing ? h('div', { class: 'callout is-good' }, h('span', { class: 'callout-icon', text: '✓' }), h('div', null, h('strong', { text: lastServing.model || '—' }), ' → ', h('span', { class: 'mono', text: lastServing.provider || '—' }), ' · ', h('span', { class: 'muted', text: fmtAgo(lastServing.at) }))) : callout('info', '还没有完成过模型请求。发起第一个请求后，这里会出现真实路由结果。'),
    dialogues.length ? table([
      { label: '会话', render: (d) => h('span', { class: 'mono', text: d.named || d.id || '匿名' }) },
      { label: '请求', className: 'num', render: (d) => fmtInt(d.requests) },
      { label: 'Token', className: 'num', render: (d) => fmtCompact(d.tokens) },
      { label: '命中率', className: 'num', render: (d) => d.hitRate == null ? '—' : fmtPct(d.hitRate) },
      { label: '最近', render: (d) => h('span', { class: 'muted', text: fmtAgo(d.lastAt) }) },
    ], dialogues.slice(0, 6), { emptyTitle: '暂无会话记录' }) : null))

  const noticeCard = card('需要关注', '仅根据当前真实状态推导，不触发探活', h('div', null,
    warnings.length ? h('div', { class: 'list' }, warnings.slice(0, 6).map((w) => h('div', { class: 'list-row' }, h('div', { class: 'grow' }, h('div', { class: 'primary', text: w.title }), h('div', { class: 'secondary', text: w.detail })), tag(w.kind === 'danger' ? '需处理' : '注意', w.kind === 'danger' ? 'bad' : 'warn')))) : callout('good', '当前没有从状态快照中发现需要处理的配置或运行异常。'),
    s.cache && s.cache.alert ? callout('warn', h('strong', { text: '缓存提醒：' }), s.cache.alert.msg || '命中率发生变化') : null))

  root.append(h('div', { class: 'grid grid-main' }, routeCard, noticeCard))

  const providerRows = providers.map((p) => ({ id: p.id, requests: p.st?.requests || 0, errors: p.st?.errors || 0 }))
  const requestCard = card('上游请求分布', '按 Provider 的真实累计请求量', providers.length
    ? h('div', null,
      h('div', { class: 'list' }, providers.map((p) => {
        const req = Number(p.st?.requests) || 0
        const err = Number(p.st?.errors) || 0
        const rate = req ? err / req * 100 : 0
        return h('div', { class: 'list-row' },
          h('div', { class: 'grow' }, h('div', { class: 'primary', text: p.id }), h('div', { class: 'secondary', text: fmtInt(req) + ' 请求 / ' + fmtInt(err) + ' 错误' })),
          tag(fmtPct(rate), rate > 20 ? 'bad' : rate > 5 ? 'warn' : 'good'))
      })))
    : empty('暂无可统计的上游'))
  const infoCard = card('实例信息', '来自 /api/status', kvList([
    ['绑定', (s.server?.host || '—') + ':' + (s.server?.port || '—')],
    ['配置版本', String(s.configVersion ?? '—')],
    ['管理令牌', state.auth.needAuth ? '已启用' : '未启用（仅本机可管理）'],
    ['Key 加密', s.server?.keyEncrypted ? '已启用' : '未确认'],
    ['启动时间', fmtTime(s.startedAt)],
    ['最近刷新', fmtAgo(state.loadedAt)],
  ]))
  root.append(h('div', { class: 'grid grid-main' }, requestCard, infoCard))
}
