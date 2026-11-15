// Dashboard: real /api/status data only. No simulated metrics.
import { h } from '../dom.js'
import { state, deriveWarnings } from '../store.js'
import { fmtInt, fmtCompact, fmtMs, fmtPct, fmtAgo, fmtDuration, fmtTime, safeOrigin } from '../format.js'
import { pageHead, card, metric, tag, statusTag, callout, empty, table, lineChart, kvList } from '../components.js'

// 未知计数绝不渲染为 0/null%：缺字段时给出显式“未知”。
export function errorRateText(g) {
  const requests = g ? Number(g.requests) : NaN
  if (!Number.isFinite(requests) || requests <= 0) return '未知（无请求计数）'
  const errors = Number(g.errors)
  if (!Number.isFinite(errors) || errors < 0) return '未知（错误计数缺失）'
  return '错误率 ' + (errors / requests * 100).toFixed(1) + '%'
}

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
  const health = healthSummary(s)
  const warnings = deriveWarnings()

  if (!state.config) {
    root.append(callout('warn', h('strong', { text: '配置投影未知：' }), '尚未读取 /api/config；本页不会把缺失的额度、路由或目录显示为 0/正常。'))
  }

  root.append(pageHead('网关总览', '请求表现、供应商健康与最近路由。', {
    actions: [
      h('button', { class: 'btn', type: 'button', text: '监控与诊断', onclick: () => { location.hash = '#/observability' } }),
      h('button', { class: 'btn btn-primary', type: 'button', text: '配置聚合', onclick: () => { location.hash = '#/aggregation' } }),
    ],
  }))

  root.append(h('section', { class: 'gateway-summary', 'aria-label': '实例状态' },
    h('div', { class: 'gateway-health' },
      tag(health.label, health.kind),
      h('span', { class: 'gateway-detail', text: health.detail })),
    h('div', { class: 'gateway-instance' },
      h('code', { class: 'gateway-address', text: safeOrigin(location.origin) }),
      h('span', { text: '已运行 ' + fmtDuration(s.uptimeMs) }))))

  root.append(h('section', { class: 'overview-metrics', 'aria-labelledby': 'overview-metrics-title' },
    h('h2', { id: 'overview-metrics-title', text: '请求概况' }),
    h('div', { class: 'grid grid-4' },
      metric('累计请求', fmtInt(g.requests), '当前网关进程', 'probe'),
      metric('错误请求', fmtInt(g.errors), errorRateText(g), 'warn'),
      metric('累计 Token', fmtCompact(g.tokenCount), '上游返回的用量', 'plus'),
      metric('P95 延迟', fmtMs(g.p95), '已完成请求', 'refresh'))))

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
