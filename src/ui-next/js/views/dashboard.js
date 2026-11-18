// 首页（UX-01）：状态驱动的"下一步"，不渲染开发者仪表盘。
//
// 数据只来自 ProductStatus 投影（docs/contracts/ui-v3-product-status.md §2/§5）：
//   * 正常集成由 A3 的 store.productStatus() 提供；也可由 ctx.product() 注入（测试/组合用）。
//   * 拿不到投影时降级为"正在读取真实状态"，绝不把未知画成已连接/已启用/0 个模型。
//   * 累计请求、错误、Token、P95、趋势、会话与上游分布已迁移到「监控与诊断」，本页只留一行入口。
import { h } from '../dom.js'
import * as store from '../store.js'
import { pageHead, card, callout, tag } from '../components.js'

// 旧套件（ui-state.test.mjs）依赖的错误率纯函数，保持原语义。
export function errorRateText (g) {
  const requests = g ? Number(g.requests) : NaN
  if (!Number.isFinite(requests) || requests <= 0) return '未知（无请求计数）'
  const errors = Number(g.errors)
  if (!Number.isFinite(errors) || errors < 0) return '未知（错误计数缺失）'
  return '错误率 ' + (errors / requests * 100).toFixed(1) + '%'
}

// 面向用户只出现"DeepSeek V4.1 Flash"，不要求理解公共/上游模型 ID（见 Lead 更正 1）。
export const GO_MODEL_DISPLAY = 'DeepSeek V4.1 Flash'

// 证据等级中文映射（契约 §2）：检测到 ≠ 已配置 ≠ 已实测；只有 runtime-verified 才是绿色。
export const EVIDENCE_TAG_LABELS = Object.freeze({
  detected: '已检测',
  configured: '已配置',
  'runtime-verified': '已实测',
  'not-tested': '未实测',
  unknown: '未知',
})

export const HOME_TECH_METRICS_ROUTE = '#/observability'

const OVERALL_TAGS = Object.freeze({
  ready: ['可正常使用', 'good'],
  action: ['需要操作', 'warn'],
  error: ['需要处理', 'bad'],
  unknown: ['状态未知', 'muted'],
  locked: ['已锁定', 'muted'],
  loading: ['读取中', 'muted'],
})

// 证据徽章只显示"比状态本身多出来的信息"：
//   detected 只说明"探测到了存在性"，不是可用结论，因此不再单独出徽章；
//   任何"待…/需要…/未知"状态都不并排 已检测/已配置/已实测，避免被读成"可以用了"。
const PENDING_LABEL = /^(待|需要|未检测到|未找到|无法|状态未知)/
export function evidenceBadge (level, item) {
  const label = String((item && item.label) || '')
  if (level === 'detected') return null
  if (level === 'unknown') return tag(EVIDENCE_TAG_LABELS.unknown, 'muted')
  if (PENDING_LABEL.test(label)) return null
  if (level === 'configured') return tag(EVIDENCE_TAG_LABELS.configured, 'accent')
  if (level === 'runtime-verified') return tag(EVIDENCE_TAG_LABELS['runtime-verified'], 'good')
  if (level === 'not-tested') return tag(EVIDENCE_TAG_LABELS['not-tested'], 'muted')
  return null
}

function stateKind (key, item) {
  const state = item && item.state
  if (key === 'official') {
    if (state === 'detected') return 'info'
    if (state === 'blocked') return 'warn'
    return 'muted'
  }
  if (key === 'go') {
    if (state === 'verified') return 'good'
    if (state === 'configured') return 'info'
    if (state === 'error') return 'bad'
    if (item && item.credentialPresent) return 'info'
    return 'muted'
  }
  if (key === 'codex') {
    if (!item || item.found !== true) return 'muted'
    if (item.restartNeeded === true) return 'warn'
    return 'info'
  }
  return 'muted'
}

function officialDetail (official) {
  if (official && typeof official.detail === 'string' && official.detail) return official.detail
  return '没有取得登录探测结果；请刷新后重试。'
}

// Go 文案不复用 product.go.detail 中的"不显示为已验证/0 个模型"等否定句，避免歧义。
function goDetail (go) {
  const item = go || {}
  const supported = item.supported !== false
  if (item.state === 'verified') {
    return '已完成一次命中 ' + GO_MODEL_DISPLAY + ' 的真实请求，可用于原版 Codex。'
  }
  if (item.state === 'error') {
    return '已保存 Go 供应商，但最近一次同步失败。请更新 Key 或重试同步；失败不会当作成功。'
  }
  if (item.level === 'configured') {
    return item.targetModelConfigured
      ? 'Key 与目标模型 ' + GO_MODEL_DISPLAY + ' 均已保存；还没有真实推理证据。'
      : 'Key 已保存；目标模型 ' + GO_MODEL_DISPLAY + ' 还没有配置到目录中，请继续完成接入。'
  }
  if (item.state === 'unknown' || !supported) {
    return '当前实例没有聚合管理接口（404），无法判断 Go 连接状态；请确认 ModelGate 版本。'
  }
  if (item.label === '状态未知') {
    return '聚合管理接口拒绝了本次读取（权限/来源），无法确认 Go 连接状态。'
  }
  if (!item.credentialPresent) {
    return '还没有接入 OpenCode Go；填入 API Key 即可自动配置 ' + GO_MODEL_DISPLAY + '。'
  }
  if (item.targetModelConfigured) {
    return '还没有取得 Go 的真实推理证据；请刷新或查看高级诊断。'
  }
  return '还没有配置 ' + GO_MODEL_DISPLAY + '；请继续完成接入。'
}

function codexDetail (codex) {
  const item = codex || {}
  if (!item.found) {
    return item.detail || '没有检测到原版 Codex Desktop；请确认安装路径，或到高级诊断查看探测结果。'
  }
  if (item.restartNeeded === true) {
    return '配置已保存，但客户端仍在用写入前启动的配置。请完全退出 Codex Desktop（不是只关窗口）再重新打开。'
  }
  if (item.restartNeeded === false) {
    return '检测到客户端在写入后启动过，新配置已加载；请在模型选择器里核对官方模型与 ' + GO_MODEL_DISPLAY + '。'
  }
  return '检测到原版 Codex；没有取得重启判定，请按需完全退出并重新打开。'
}

function aggregationDetail (agg) {
  const item = agg || {}
  if (item.supported === false) {
    return '当前实例没有聚合管理接口（404）；这是版本不兼容，不是聚合开关的问题。请确认 ModelGate 版本。'
  }
  if (item.mode === 'aggregated') {
    const backup = item.backupAvailable === true
      ? '已有可恢复备份。'
      : item.backupAvailable === false
        ? '未发现可恢复备份。'
        : '备份状态未知。'
    const restart = item.needsRestart === true ? '需要重新打开 Codex 后才生效。' : ''
    return 'Codex 配置已指向 ModelGate；官方 GPT 与 ' + GO_MODEL_DISPLAY + ' 都通过原版 Codex 使用。' + backup + restart
  }
  if (item.mode === 'route') {
    const restart = item.needsRestart === true ? '请完全退出并重新打开 Codex 才能使用新模式（退出后也要重启）。' : ''
    return 'Codex 配置走纯 DeepSeek 路由，不发起 GPT 调用。' + restart
  }
  if (item.mode === 'official') {
    return '当前是官方直连模式，不经 ModelGate，使用 Codex 官方默认配置。'
  }
  if (item.drifted === true) return '检测到配置漂移，请重新检测；不显示成直连。'
  return '没有取得可识别的接入方式；请刷新重试或查看高级诊断。'
}

function overallTag (overall) {
  const preset = OVERALL_TAGS[overall && overall.level] || OVERALL_TAGS.unknown
  return tag(preset[0], preset[1])
}

// ① 总体结论：label + detail + 结论标签。
export function buildOverall (product) {
  if (!product) {
    return [callout('info',
      h('strong', { text: '正在读取真实状态。' }),
      ' 取得只读快照前，本页不给出任何连接成功结论。')]
  }
  const overall = product.overall || {}
  return [h('section', {
    class: 'card overall-card' + (overall.level ? ' is-' + overall.level : ''),
    'data-overall': overall.level || 'unknown',
  },
  h('div', { class: 'card-body' },
    h('div', { class: 'home-overall-top' },
      h('p', { class: 'eyebrow', text: '总体状态' }),
      overallTag(overall)),
    h('h2', { class: 'home-overall-title', text: overall.label || '状态未知' }),
    h('p', { class: 'home-overall-detail', text: overall.detail || '没有取得总体结论。' })))]
}

// 行结构：名称独立一行；状态值、模型名、说明各自成行并允许换行（360px 不出现半截模型名）。
function statusRow ({ key, title, item, detail, level, model }) {
  const badge = evidenceBadge(level || (item && item.level), item)
  return h('div', { class: 'status-row is-' + stateKind(key, item), 'data-status': key, role: 'group' },
    h('div', { class: 'status-row-main' },
      h('span', { class: 'status-row-label', text: title }),
      h('span', { class: 'status-row-value', text: (item && item.label) || '状态未知' }),
      model ? h('span', { class: 'status-row-detail home-status-model', text: model }) : null,
      h('p', { class: 'status-row-detail', text: detail })),
    badge ? h('div', { class: 'home-status-tags' }, badge) : null)
}

// ② 三条连接状态行：ChatGPT 套餐 / OpenCode Go / Codex Desktop，每行都带证据等级。
export function buildStatusRows (product) {
  if (!product) return []
  const official = product.official || {}
  const go = product.go || {}
  const codex = product.codex || {}
  return [
    statusRow({
      key: 'official',
      title: 'ChatGPT 套餐',
      item: official,
      detail: officialDetail(official),
      level: official.level,
    }),
    statusRow({
      key: 'go',
      title: 'OpenCode Go',
      item: go,
      detail: goDetail(go),
      level: go.level,
      model: GO_MODEL_DISPLAY,
    }),
    statusRow({
      key: 'codex',
      title: 'Codex Desktop',
      item: codex,
      detail: codexDetail(codex),
      level: codex.detectionLevel || codex.level,
    }),
  ]
}

export function buildAggregationCard (product) {
  const agg = (product && product.aggregation) || {}
  const modeText = agg.mode === 'aggregated' ? '聚合（GPT 父 + DeepSeek 子）'
    : agg.mode === 'route' ? '路由（纯 DeepSeek，无 GPT）'
      : agg.mode === 'official' ? '官方直连（不经 ModelGate）'
        : '状态未知'
  const modeKind = agg.mode === 'aggregated' ? 'good' : agg.mode === 'route' ? 'info' : agg.mode === 'official' ? 'muted' : 'warn'
  return card('接入方式', '只用用户能理解的方式描述当前接入方式与可恢复性。',
    h('div', { class: 'list' },
      h('div', { class: 'list-row', 'data-status': 'aggregation' },
        h('div', { class: 'grow' },
          h('div', { class: 'primary', text: agg.label || '状态未知' }),
          h('div', { class: 'secondary', text: aggregationDetail(agg) })),
        h('div', { class: 'flex' }, tag(modeText, modeKind)))))
}

function revealAuth () {
  const overlay = document.getElementById('auth-overlay')
  if (!overlay) return
  overlay.hidden = false
  const input = document.getElementById('admin-token')
  if (input && typeof input.focus === 'function') setTimeout(() => input.focus(), 20)
}

function refreshProduct (ctx) {
  if (ctx && typeof ctx.refreshProduct === 'function') {
    Promise.resolve(ctx.refreshProduct()).catch(() => {})
    return
  }
  if (typeof store.refreshProduct === 'function') {
    Promise.resolve(store.refreshProduct({ reason: 'home-primary' })).catch(() => {})
    return
  }
  const button = document.getElementById('refresh')
  if (button && typeof button.click === 'function') { button.click(); return }
  if (typeof location !== 'undefined' && location && typeof location.reload === 'function') location.reload()
}

function runAction (action, ctx) {
  const kind = action && action.kind
  if (kind === 'unlock') { revealAuth(); return }
  if (kind === 'local-admin-unlock') {
    if (ctx && typeof ctx.unlockAdmin === 'function') { ctx.unlockAdmin(action); return }
    // 尚未接线（或旧实例无该端点）：如实降级到设置页，不静默重试造成死循环。
    if (typeof location !== 'undefined') location.hash = '#/settings?section=admin-token'
    return
  }
  if (kind === 'retry' || kind === 'reload') { refreshProduct(ctx); return }
  if (kind === 'wait') return
  if (action && action.route) location.hash = action.route
}

// ④ 唯一主 CTA + ⑤ 不抢主操作的次级入口。
export function buildPrimaryAction (product, ctx = {}) {
  const p = product || {}
  const primary = p.primary || { id: 'wait', label: '正在读取状态…', kind: 'wait', detail: '' }
  const button = h('button', {
    class: 'btn btn-primary btn-lg primary-action-button',
    type: 'button',
    'data-primary-cta': primary.id || 'primary',
    text: primary.label,
  })
  if (primary.kind === 'wait') button.disabled = true
  button.addEventListener('click', () => runAction(primary, ctx))
  const secondary = Array.isArray(p.secondary) ? p.secondary : []
  const secondaryButtons = secondary.map((action) => {
    const b = h('button', {
      class: 'btn btn-ghost',
      type: 'button',
      'data-secondary-cta': action.id || '',
      text: action.label,
    })
    b.addEventListener('click', () => runAction(action, ctx))
    return b
  })
  return [h('section', { class: 'home-cta', 'aria-label': '下一步操作' },
    h('div', { class: 'primary-action' },
      button,
      primary.detail ? h('p', { class: 'primary-action-detail', text: primary.detail }) : null),
    secondaryButtons.length ? h('div', { class: 'home-cta-secondary' }, secondaryButtons) : null)]
}

// 技术指标入口：一行指向监控与诊断，不在首页重复渲染长表。
export function buildTechMetricsNote () {
  return h('p', { class: 'home-tech-note' },
    '技术指标已移至「', h('a', { href: HOME_TECH_METRICS_ROUTE, text: '监控与诊断' }), '」。')
}

function resolveProduct (ctx) {
  if (ctx && typeof ctx.product === 'function') {
    try { return ctx.product() || null } catch { return null }
  }
  if (ctx && ctx.product) return ctx.product
  if (store && typeof store.productStatus === 'function') {
    try { return store.productStatus() || null } catch { return null }
  }
  if (store && store.state && store.state.product) return store.state.product
  return null
}

export function render (root, ctx = {}) {
  const product = resolveProduct(ctx)
  const loading = !product || product.state === 'loading'
  const locked = !!(product && product.state === 'locked')

  root.append(pageHead('一切模型，尽在掌控。', '先确认三项连接状态；本页只保留结论和下一步，技术指标在「监控与诊断」。', {
    eyebrow: 'MODELGATE / 首页',
  }))
  root.append(...buildOverall(product))

  // P1-04：只读视图给出准确原因与解锁方式，避免用户反复点刷新陷入死循环。
  if (product && product.state === 'needs_admin_token') {
    const reason = product.readOnlyReason || {}
    root.append(callout('info', h('strong', { text: '当前为只读视图。' }),
      ' 聚合管理接口返回 403' + (reason.code ? '（' + reason.code + '）' : '') +
      '，因此这里既不读取也不写入聚合配置；Codex 侧已经生效的配置不受影响。' +
      '点击“解锁聚合管理”可在本机开启临时管理会话；需要远程/多设备管理时可在设置里写入 MG_ADMIN_TOKEN。解锁前不会发起任何写操作。'))
  }

  if (product && !loading && !locked) {
    // 主操作紧跟总体结论：360×800 / 768×900 首屏可见，不靠缩小字号或隐藏状态行。
    root.append(...buildPrimaryAction(product, ctx))
    root.append(card('连接状态', '证据等级来自只读快照：检测到不等于已实测。', h('div', { class: 'home-status-list' }, buildStatusRows(product))))
    root.append(buildAggregationCard(product))
  } else if (product) {
    root.append(...buildPrimaryAction(product, ctx))
  }

  root.append(buildTechMetricsNote())
}
