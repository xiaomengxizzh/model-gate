// A3 / P03：聚合模式视图——一键接入原版 Codex Desktop、供应商与模型授权、诊断与无损退出。
//
// 约束（与 views/codex.js 一致）：
//  * 纯前端、零依赖、不 import 后端模块；不读本地文件、不写 cookie/localStorage。
//  * 浏览器没有本地文件权限：所有读写都经同源管理 API（/api/aggregation/*），
//    由服务端 src/codex/desktop-integration.js 执行"预览 → 确认 → 备份 → 原子写 → 验证"。
//  * 只渲染真实响应；发现不完整/失败时明确说"不是 0 个模型"，绝不把部分列表当全量。
//  * 409 冲突只展示三方差异，不覆盖用户改动；路由未接线时给出精确的整合说明，不假装成功。
import { h } from '../dom.js'
import {
  pageHead, card, metric, tag, callout, empty, field, dialog, confirmDialog, toast, table, kvList,
} from '../components.js'
import { state } from '../store.js'
import { request } from '../api.js'
import { fmtTime, fmtInt, safeHost } from '../format.js'

export const AGGREGATION_VIEW_CONTRACT = 'mg-ui-aggregation/1'

// ADR-0003 §5 的冻结 HTTP 面（本视图只使用这些路径）。
export const AGGREGATION_ENDPOINTS = Object.freeze({
  providers: '/api/aggregation/providers',
  provider: (id) => '/api/aggregation/providers/' + encodeURIComponent(String(id || '')),
  sync: (id) => '/api/aggregation/providers/' + encodeURIComponent(String(id || '')) + '/sync',
  models: '/api/aggregation/models',
  health: '/api/aggregation/health',
  diagnostics: '/api/aggregation/diagnostics',
  activate: '/api/aggregation/activate',
  deactivate: '/api/aggregation/deactivate',
})

const AGG = {
  fetched: false,
  loading: false,
  routeMissing: false,
  health: null,
  providers: null,
  models: null,
  diagnostics: null,
  loadedAt: 0,
  healthError: null,
  providersError: null,
  modelsError: null,
  diagnosticsError: null,
}

// —— 纯函数（可在无 DOM 环境下测试）——
export function modeLabel (mode) {
  if (mode === 'aggregated') return { label: '聚合模式已启用', kind: 'good' }
  if (mode === 'official') return { label: '官方模式', kind: 'muted' }
  return { label: '状态未知', kind: 'warn' }
}

// 发现诚实性：failed / partial / complete-empty / complete / unknown 五种状态。
// 返回值里的 countText 只在"完整目录"时才给出总数；其它情况给已获取数并明确"非完整"。
export function summarizeDiscovery (diagnostics, models) {
  const list = Array.isArray(models) ? models : (models && Array.isArray(models.models) ? models.models : [])
  const diag = diagnostics && typeof diagnostics === 'object' ? diagnostics : {}
  const discovery = diag.discovery && typeof diag.discovery === 'object' ? diag.discovery : diag
  const rawState = String(discovery.state || discovery.status || 'unknown')
  const discovered = Number.isFinite(Number(discovery.discovered)) ? Number(discovery.discovered) : list.length
  const reason = discovery.reason || discovery.error || (discovery.code ? String(discovery.code) : '')
  if (rawState === 'failed' || rawState === 'error') {
    return {
      state: 'failed',
      kind: 'bad',
      label: '发现失败',
      countText: null,
      count: null,
      detail: '没有拿到任何模型（这不是“0 个模型”）：' + (reason || '上游发现失败，原因未返回') + '。请重试同步或查看诊断码，UI 不会用空列表冒充完整目录。',
    }
  }
  if (rawState === 'partial' || discovery.complete === false || discovery.truncated === true) {
    return {
      state: 'partial',
      kind: 'warn',
      label: '发现未完成',
      countText: '已获取 ' + fmtInt(discovered) + ' 个（非完整）',
      count: discovered,
      detail: '只发现了一部分模型：' + (reason || '目录被截断或分页未完成') + '。当前列表不是完整目录，不能据此判断账号总共可用多少模型。',
    }
  }
  if (rawState === 'complete' && discovery.upstreamConfirmedEmpty === true && list.length === 0) {
    return {
      state: 'empty_confirmed',
      kind: 'muted',
      label: '上游确认无可用模型',
      countText: '0 个（上游明确返回空目录）',
      count: 0,
      detail: '上游明确返回了空授权目录；这不是发现失败，但也意味着当前账号没有任何可调用模型。',
    }
  }
  if (rawState === 'complete') {
    return {
      state: 'complete',
      kind: 'good',
      label: '完整目录',
      countText: fmtInt(list.length) + ' 个模型',
      count: list.length,
      detail: '发现已完成；以下列表是该账号授权范围内的完整目录（未授权模型单独标注，不会发布为可调用模型）。',
    }
  }
  return {
    state: 'unknown',
    kind: 'muted',
    label: '发现状态未知',
    countText: null,
    count: null,
    detail: '后端没有返回发现状态：不能把当前列表当成完整目录，也不能把空列表读成“0 个模型”。请刷新或查看诊断。',
  }
}

export function buildActivateRequest (preview, consent) {
  const p = preview || {}
  return {
    consentToken: consent ? (p.consentToken || '') : '',
    expectedSha: p.expectedSha == null ? '' : String(p.expectedSha),
  }
}

export function describeThreeWay (conflict) {
  const tw = conflict && conflict.detail && conflict.detail.threeWay ? conflict.detail.threeWay : null
  if (!tw) return { available: false, rows: [], summary: '服务端未返回三方差异；未做任何写入。' }
  const rows = Array.isArray(tw.oursVsTheirs) ? tw.oursVsTheirs.filter((r) => r.kind !== 'same') : []
  return {
    available: true,
    rows,
    summary: '接入后配置被外部修改：ModelGate 保留你的改动，不覆盖。基准 ' + (tw.base ? tw.base.sha256.slice(0, 8) : '—') +
      ' · 我们写入 ' + (tw.ours ? tw.ours.sha256.slice(0, 8) : '—') + ' · 当前 ' + (tw.theirs ? tw.theirs.sha256.slice(0, 8) : '—'),
    guidance: tw.guidance || '保持现状，先手工合并。',
  }
}

function shaShort (sha) {
  return sha ? String(sha).slice(0, 12) : '—'
}

function versionCell (info) {
  if (!info) return tag('未知', 'muted')
  if (!info.found) return tag('未检测到', 'muted')
  if (info.versionState === 'known' && info.version) return tag(info.version, 'info')
  return tag(info.versionState === 'unknown' ? '版本未知' : '未探测', 'muted')
}

// —— 数据加载 ——
function looksMissingRoute (err) {
  return !!err && (err.status === 404 || (err.data && err.data.code === 'not_mounted'))
}

async function loadAggregation (ctx = {}) {
  if (AGG.loading) return
  AGG.loading = true
  const [health, providers, models, diagnostics] = await Promise.allSettled([
    request(AGGREGATION_ENDPOINTS.health),
    request(AGGREGATION_ENDPOINTS.providers),
    request(AGGREGATION_ENDPOINTS.models),
    request(AGGREGATION_ENDPOINTS.diagnostics),
  ])
  const results = { health, providers, models, diagnostics }
  AGG.routeMissing = Object.values(results).some((r) => r.status === 'rejected' && looksMissingRoute(r.reason))
  AGG.health = health.status === 'fulfilled' ? health.value : null
  AGG.providers = providers.status === 'fulfilled' ? providers.value : null
  AGG.models = models.status === 'fulfilled' ? models.value : null
  AGG.diagnostics = diagnostics.status === 'fulfilled' ? diagnostics.value : null
  AGG.healthError = health.status === 'rejected' ? health.reason : null
  AGG.providersError = providers.status === 'rejected' ? providers.reason : null
  AGG.modelsError = models.status === 'rejected' ? models.reason : null
  AGG.diagnosticsError = diagnostics.status === 'rejected' ? diagnostics.reason : null
  AGG.fetched = true
  AGG.loadedAt = Date.now()
  AGG.loading = false
  if (typeof ctx.rerender === 'function') ctx.rerender()
}

function reload (ctx) {
  AGG.fetched = false
  return loadAggregation(ctx)
}

// —— 卡片 ——
function routeNotice (ctx) {
  return callout('warn',
    h('strong', { text: '聚合接口尚未接线（404）。' }),
    ' 后端还没有把 /api/aggregation/* 挂到管理面。本视图不会伪造数据；接线需要主代理在 src/index.js 注册聚合 handler（见交付报告中的精确补丁）。',
    h('div', { class: 'toolbar', style: { marginTop: '8px' } },
      h('button', { class: 'btn btn-sm', type: 'button', text: '重新探测', onclick: () => reload(ctx) })))
}

function statusCard (ctx) {
  const health = AGG.health || {}
  const detect = health.detect || health.desktop || {}
  const activation = health.activation || {}
  const mode = health.mode || (detect.config && detect.config.mode) || 'unknown'
  const m = modeLabel(mode)
  const needsRestart = !!(health.needsRestart || activation.needsRestart)
  const backup = health.backup || activation.backup || { available: false }
  const canToggle = !AGG.routeMissing
  const button = mode === 'aggregated'
    ? h('button', { class: 'btn btn-danger', type: 'button', disabled: !canToggle, text: '退出聚合模式', onclick: () => beginDeactivate(ctx) })
    : h('button', { class: 'btn btn-primary', type: 'button', disabled: !canToggle, text: '进入聚合模式', onclick: () => beginActivate(ctx) })

  const body = h('div', null,
    callout('info',
      h('strong', { text: '一次性确认：' }),
      ' 进入聚合模式只改 ModelGate 拥有的 4 个顶层字段与 [features] 的 2 个白名单键；写入前展示差异并要你确认一次，写入后自动验证网关与目录。不编辑 TOML、不碰 auth.json、不重启你的 Codex。'),
    h('div', { class: 'toolbar', style: { margin: '4px 0 10px' } },
      tag(m.label, m.kind),
      tag(AGG.health ? '网关 ' + (health.gateway && health.gateway.status ? 'HTTP ' + health.gateway.status : (health.gateway && health.gateway.ok ? '健康' : '未返回')) : '健康接口未返回', health.gateway && (health.gateway.ok !== false) ? 'good' : 'warn'),
      needsRestart ? tag('需要重启 Codex 生效', 'warn') : null),
    kvList([
      ['配置路径', h('span', { class: 'mono-break', text: detect.configPath || health.configPath || '未返回' })],
      ['Codex CLI', h('div', { class: 'flex flex-wrap' }, versionCell(detect.cli), h('span', { class: 'hint', text: detect.cli && detect.cli.path ? detect.cli.path : '未检测到 codex 可执行文件' }))],
      ['Codex Desktop', h('div', { class: 'flex flex-wrap' }, versionCell(detect.desktop), h('span', { class: 'hint', text: detect.desktop && detect.desktop.path ? detect.desktop.path : '未检测到 Desktop 可执行文件' }))],
      ['配置状态', h('span', { text: (detect.config && detect.config.reason) || health.reason || '未知' })],
      ['接入前备份', backup.available ? h('span', { class: 'mono-break', text: (backup.path || '') + ' · ' + (backup.matches ? '与接入前快照一致' : '快照不一致（不可回滚）') }) : h('span', { class: 'muted', text: '无（尚未接入，或接入前文件不存在）' })],
      ['最近一次结果', activation.lastApply ? h('span', { text: (activation.lastApply.ok ? '成功' : '失败 · ' + (activation.lastApply.code || '未知')) + (activation.lastApply.at ? ' · ' + fmtTime(activation.lastApply.at) : '') }) : h('span', { class: 'muted', text: '尚无记录' })],
    ]),
    needsRestart
      ? callout('warn', h('strong', { text: '需要重启 Codex：' }), ' 配置在客户端下次启动或重载时生效；运行中的会话仍使用旧配置。请先完全退出 Codex Desktop，再重新打开，然后在新会话的模型选择器里核对官方模型与聚合模型。')
      : null,
    h('div', { class: 'toolbar', style: { marginTop: '10px' } }, button))

  return card('聚合模式与 Desktop 接入',
    '选择聚合模式后由 ModelGate 自动完成配置、备份与验证；退出时只回滚它自己改过的字节。',
    body,
    { foot: '契约 mg-codex-desktop/1 · 写入 = config.js 事务（sha256 + 备份 + 原子写 + 写后校验）· 浏览器不接触本地文件' })
}

function providerRowActions (provider, ctx) {
  const id = provider && (provider.id || provider.providerId)
  return h('div', { class: 'flex flex-wrap' },
    h('button', { class: 'btn btn-sm', type: 'button', text: '同步', onclick: () => syncProvider(id, ctx) }),
    h('button', { class: 'btn btn-sm btn-danger', type: 'button', text: '移除', onclick: () => removeProvider(id, ctx) }))
}

function providersCard (ctx) {
  const payload = AGG.providers || {}
  const list = Array.isArray(payload) ? payload : (Array.isArray(payload.providers) ? payload.providers : [])
  const rows = list.map((p) => ({
    id: p.id || p.providerId || '—',
    kind: p.kind || p.type || '—',
    base: safeHost(p.baseUrl || ''),
    models: Number.isFinite(Number(p.modelCount)) ? fmtInt(p.modelCount) : (p.modelCount == null ? '未知' : String(p.modelCount)),
    authorized: Number.isFinite(Number(p.authorizedCount)) ? fmtInt(p.authorizedCount) : '未知',
    state: p.discoveryState || p.state || 'unknown',
    actions: providerRowActions(p, ctx),
  }))
  const add = h('button', { class: 'btn btn-primary', type: 'button', text: '添加 OpenCode 供应商', onclick: () => openProviderDialog(ctx) })
  const body = rows.length
    ? h('div', null,
      table([
        { label: '供应商', render: (r) => h('span', { class: 'mono', text: r.id }) },
        { label: '类型', render: (r) => tag(r.kind, 'muted') },
        { label: '主机', render: (r) => h('span', { class: 'mono-break', text: r.base || '—' }) },
        { label: '模型', render: (r) => h('span', { text: r.models }) },
        { label: '已授权', render: (r) => h('span', { text: r.authorized }) },
        { label: '发现状态', render: (r) => tag(r.state === 'complete' ? '完整' : r.state === 'failed' ? '失败' : r.state, r.state === 'complete' ? 'good' : r.state === 'failed' ? 'bad' : 'warn') },
        { label: '操作', render: (r) => r.actions },
      ], rows),
      h('div', { class: 'toolbar', style: { marginTop: '10px' } }, add))
    : h('div', null,
      empty('还没有添加聚合供应商', '添加 OpenCode Console 或 OpenCode Go 后，ModelGate 会自动发现该账号授权范围内的全部模型。',
        h('button', { class: 'btn btn-primary', type: 'button', text: '添加第一个供应商', onclick: () => openProviderDialog(ctx) })))
  return card('聚合供应商', '每个供应商独立授权域；同步只读取目录，不发起推理。',
    AGG.providersError ? callout('danger', h('strong', { text: '供应商列表读取失败：' }), AGG.providersError.message || '未知错误') : body,
    { foot: '来源 GET /api/aggregation/providers · ' + (AGG.loadedAt ? '读取于 ' + fmtTime(AGG.loadedAt) : '尚未读取') })
}

function modelRows () {
  const payload = AGG.models || {}
  const list = Array.isArray(payload) ? payload : (Array.isArray(payload.models) ? payload.models : [])
  return list.map((m) => ({
    publicId: m.publicId || m.id || m.name || '—',
    providerId: m.providerId || '—',
    upstreamId: m.upstreamId || '—',
    displayName: m.displayName || m.display_name || '',
    authorized: m.authorized === true,
    evidence: m.evidence && m.evidence.source ? (m.evidence.source + (m.evidence.observedAt ? ' · ' + m.evidence.observedAt : '')) : '无证据',
    context: Number.isFinite(Number(m.contextWindow)) ? fmtInt(m.contextWindow) : '未知',
  }))
}

function modelsCard () {
  const summary = summarizeDiscovery(AGG.diagnostics, AGG.models)
  const rows = modelRows()
  const body = h('div', null,
    callout(summary.kind === 'bad' ? 'danger' : summary.kind === 'warn' ? 'warn' : 'info',
      h('strong', { text: summary.label + '：' }), ' ' + summary.detail),
    h('div', { class: 'toolbar', style: { margin: '2px 0 10px' } },
      tag(summary.countText || '数量未知（不按 0 显示）', summary.kind),
      tag('状态 ' + summary.state, 'muted')),
    AGG.modelsError
      ? callout('danger', h('strong', { text: '模型目录读取失败：' }), AGG.modelsError.message || '未知错误', h('p', { class: 'hint', text: '失败不等于“0 个模型”；请根据诊断重试。' }))
      : (rows.length
          ? table([
            { label: '公共 ID', render: (r) => h('span', { class: 'mono-break', text: r.publicId }) },
            { label: '供应商', render: (r) => h('span', { class: 'mono', text: r.providerId }) },
            { label: '上游 ID', render: (r) => h('span', { class: 'mono-break muted', text: r.upstreamId }) },
            { label: '授权', render: (r) => tag(r.authorized ? '可用' : '无权使用（不发布）', r.authorized ? 'good' : 'bad') },
            { label: '上下文', render: (r) => h('span', { text: r.context }) },
            { label: '证据', render: (r) => h('span', { class: 'hint', text: r.evidence }) },
          ], rows)
          : (summary.state === 'complete' || summary.state === 'empty_confirmed'
              ? empty('没有可调用模型', summary.state === 'empty_confirmed' ? '上游明确返回空授权目录。' : '发现已完成，但目录为空。')
              : empty('模型清单不可用', '发现尚未完成或未知；这里不显示“0 个模型”。')))
  )
  return card('模型授权与目录', '只发布账号有权使用且带证据的模型；未授权条目仅用于诊断。',
    body,
    { foot: '来源 GET /api/aggregation/models + /diagnostics · 数量口径以发现状态为准，部分发现不显示为全量' })
}

function diagnosticsCard () {
  const payload = AGG.diagnostics || {}
  const list = Array.isArray(payload) ? payload : (Array.isArray(payload.diagnostics) ? payload.diagnostics : [])
  const rows = list.map((d, i) => ({
    level: d.level || d.severity || 'info',
    code: d.code || '—',
    message: d.message || d.detail || '',
    at: d.at ? fmtTime(d.at) : '—',
    key: i,
  }))
  return card('诊断', '只显示稳定诊断码与主机/路径；不含 token、cookie 或 auth.json 内容。',
    AGG.diagnosticsError
      ? callout('danger', h('strong', { text: '诊断读取失败：' }), AGG.diagnosticsError.message || '未知错误')
      : (rows.length
          ? table([
            { label: '级别', render: (r) => tag(r.level, r.level === 'error' ? 'bad' : r.level === 'warn' ? 'warn' : 'muted') },
            { label: '代码', render: (r) => h('span', { class: 'mono', text: r.code }) },
            { label: '说明', render: (r) => h('span', { class: 'muted', text: r.message }) },
            { label: '时间', render: (r) => h('span', { class: 'muted', text: r.at }) },
          ], rows)
          : empty('暂无诊断', '当前没有诊断记录；这不代表已经验证过真实 Desktop。')),
    { foot: '来源 GET /api/aggregation/diagnostics' })
}

// —— 交互 ——
function openProviderDialog (ctx) {
  const idInput = h('input', { type: 'text', autocomplete: 'off', placeholder: '例如 opencode-console' })
  const kindSelect = h('select', null,
    h('option', { value: 'console', text: 'OpenCode Console' }),
    h('option', { value: 'go', text: 'OpenCode Go' }))
  const baseInput = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'https://…（供应商端点，不含 Key）' })
  const envInput = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: '例如 OPENCODE_API_KEY（只填变量名）' })
  const err = h('p', { class: 'field-error', role: 'alert' })
  const save = h('button', { class: 'btn btn-primary', type: 'button', text: '添加并发现' })
  const content = h('div', null,
    callout('info', h('strong', { text: '授权仍由你完成：' }), ' 这里只登记供应商与凭据变量名，不会代你登录，也不会回显 Key。'),
    field('供应商 ID', idInput, { help: '唯一配置键；保存后作为 providerId。' }),
    field('类型', kindSelect, { help: 'Console 与 Go 使用不同的授权域，不能互相替代。' }),
    field('端点', baseInput, { help: '必须是 http(s) 地址；不要把 Key 写进 URL。' }),
    field('apiKeyEnv', envInput, { help: '环境变量名，不是 Key 值。' }),
    err)
  const d = dialog({ title: '添加 OpenCode 供应商', desc: '保存会推进 configVersion；冲突返回 409，不会覆盖其它窗口的修改。', content, actions: [
    h('button', { class: 'btn', type: 'button', text: '取消', onclick: () => d.close() }), save,
  ] })
  save.addEventListener('click', async () => {
    err.textContent = ''
    const id = idInput.value.trim()
    const baseUrl = baseInput.value.trim()
    const problems = []
    if (!id) problems.push('供应商 ID 不能为空')
    if (!/^https?:\/\//i.test(baseUrl)) problems.push('端点必须以 http:// 或 https:// 开头')
    if (problems.length) { err.textContent = problems.join('；'); return }
    save.disabled = true
    save.textContent = '保存中…'
    try {
      await request(AGGREGATION_ENDPOINTS.providers, {
        method: 'POST',
        body: {
          id,
          kind: kindSelect.value,
          baseUrl,
          apiKeyEnv: envInput.value.trim(),
          configVersion: Number(state.config && state.config.configVersion) || 0,
        },
      })
      d.close()
      toast('供应商已添加，正在发现模型', 'success')
      await reload(ctx)
    } catch (e) {
      save.disabled = false
      save.textContent = '添加并发现'
      if (e && e.status === 409) err.textContent = '配置版本冲突（服务端版本 ' + (e.currentVersion == null ? '未知' : e.currentVersion) + '）：请刷新后重试，本页不会覆盖。'
      else if (e && e.status === 428) err.textContent = '添加供应商需要一次显式确认；请刷新后重试。'
      else err.textContent = '添加失败：' + (e && e.message ? e.message : '未知错误')
    }
  })
}

async function syncProvider (id, ctx) {
  if (!id || id === '—') return
  const ok = await confirmDialog({
    title: '同步供应商 · ' + id,
    message: '将向该供应商读取授权模型目录（GET /v1/models），不发推理请求。若上游受限或分页未完成，界面会明确标注“发现未完成”。',
    confirmLabel: '开始同步',
  })
  if (!ok) return
  try {
    const res = await request(AGGREGATION_ENDPOINTS.sync(id), { method: 'POST', body: {}, timeoutMs: 60000 })
    const changed = res && res.changed ? res.changed : null
    toast(changed ? '同步完成：新增 ' + (changed.added || 0) + ' / 移除 ' + (changed.removed || 0) + ' / 更新 ' + (changed.updated || 0) : '同步完成', 'success')
    await reload(ctx)
  } catch (e) {
    toast('同步失败：' + (e && e.message ? e.message : '未知错误') + '（失败不等于 0 个模型）', 'error')
    await loadAggregation(ctx)
  }
}

async function removeProvider (id, ctx) {
  if (!id || id === '—') return
  const ok = await confirmDialog({
    title: '移除供应商 · ' + id,
    message: '只从聚合注册表移除该供应商；不会删除你已有的 Codex 登录，也不会改动其它供应商。若正在聚合模式中使用它，请先退出聚合或换模型。',
    confirmLabel: '移除',
    danger: true,
  })
  if (!ok) return
  try {
    await request(AGGREGATION_ENDPOINTS.provider(id), { method: 'DELETE' })
    toast('已移除供应商', 'success')
    await reload(ctx)
  } catch (e) {
    toast('移除失败：' + (e && e.message ? e.message : '未知错误'), 'error')
  }
}

function showRestartPrompt (extra) {
  const d = dialog({
    title: '接入已通过验证',
    desc: '配置已写入并通过网关/目录/解析三项验证；Codex 需要重启后才会读取新配置。',
    content: h('div', null,
      extra ? callout('good', h('strong', { text: '验证结果：' }), extra) : null,
      h('ol', { style: { margin: '6px 0 0 18px', padding: 0 } },
        h('li', { text: '完全退出 Codex Desktop（不是只关窗口）。' }),
        h('li', { text: '重新打开 Codex Desktop，进入一个新会话。' }),
        h('li', { text: '在模型选择器里依次核对官方模型与每个 OpenCode 模型都能被选中。' }),
        h('li', { text: '各发一条最小消息，回到「监控与诊断」核对请求落到正确供应商。' }))),
    actions: [h('button', { class: 'btn btn-primary', type: 'button', text: '我知道了', onclick: () => d.close() })],
  })
}

function diffRowsTable (rows) {
  return table([
    { label: '字段', render: (r) => h('span', { class: 'mono', text: r.path }) },
    { label: '变更', render: (r) => tag(r.kind === 'add' ? '新增' : r.kind === 'replace' ? '覆盖' : '不变', r.kind === 'replace' ? 'warn' : r.kind === 'add' ? 'info' : 'muted') },
    { label: '当前值', render: (r) => h('span', { class: 'mono-break muted', text: r.from == null ? '—（文件中没有）' : r.from }) },
    { label: '写入后', render: (r) => h('span', { class: 'mono-break', text: r.to }) },
  ], rows)
}

function showConsent (preview, ctx) {
  const rows = (preview && Array.isArray(preview.rows)) ? preview.rows : []
  const conflicts = (preview && Array.isArray(preview.conflicts)) ? preview.conflicts : []
  const preserved = preview && preview.preserved ? preview.preserved : {}
  const confirm = h('button', { class: 'btn btn-primary', type: 'button', text: '确认并写入 ' + (rows.filter((r) => r.kind !== 'same').length) + ' 项' })
  const body = h('div', null,
    callout('info', h('strong', { text: '只写 ModelGate 拥有的字段：' }), ' 其它行（MCP / projects / 权限 / 注释 / 你自己的 [model_providers.*]）逐字节保留。写入前会再次校验 sha256；期间若文件被改，会中止而不是覆盖。'),
    preview && preview.firstRun ? callout('warn', h('strong', { text: '首次设置：' }), ' 将在 Codex 用户级配置中新增下面这些字段。') : null,
    conflicts.length ? callout('warn', h('strong', { text: '将覆盖 ' + conflicts.length + ' 个已有值：' }), conflicts.map((c) => c.path).join('、')) : null,
    diffRowsTable(rows),
    h('p', { class: 'hint', text: '只读保留：顶层 ' + ((preserved.topLevelKeys || []).join('、') || '无') + ' · 段 ' + ((preserved.sections || []).join('、') || '无') + (preserved.mcpServers && preserved.mcpServers.length ? ' · MCP ' + preserved.mcpServers.join('、') : '') }),
    (preview && preview.warnings && preview.warnings.length) ? callout('warn', h('strong', { text: '注意：' }), preview.warnings.join(' ')) : null,
    preview && preview.catalog ? h('p', { class: 'hint', text: '目录：' + (preview.catalog.ok ? preview.catalog.modelCount + ' 个模型（含目标模型）' : '当前不可用（' + preview.catalog.state + '）：' + (preview.catalog.reason || '')) }) : null,
    h('p', { class: 'hint', text: '写入后会自动验证：配置解析 + 目录含目标模型 + 网关 /healthz；任何一项失败会自动回滚到写入前字节。' }))
  const d = dialog({ title: '确认进入聚合模式', desc: '这是一次性确认；退出聚合时只回滚 ModelGate 改过的字节。', wide: true, content: body, actions: [
    h('button', { class: 'btn', type: 'button', text: '取消', onclick: () => d.close() }), confirm,
  ] })
  confirm.addEventListener('click', async () => {
    confirm.disabled = true
    confirm.textContent = '写入并验证中…'
    try {
      const res = await request(AGGREGATION_ENDPOINTS.activate, { method: 'POST', body: buildActivateRequest(preview, true), timeoutMs: 60000 })
      d.close()
      toast('聚合模式已启用并通过验证', 'success')
      await reload(ctx)
      showRestartPrompt(res && res.verification ? ('配置 ' + shaShort(res.sha) + ' · 目录 ' + (res.verification.catalog ? res.verification.catalog.modelCount + ' 个模型' : '已校验') + ' · 网关 ' + (res.verification.gateway ? res.verification.gateway.status : '已校验')) : null)
    } catch (e) {
      d.close()
      if (e && e.status === 409) {
        toast('预览后配置已被修改，已中止；请重新预览', 'error')
        await loadAggregation(ctx)
        return
      }
      toast('接入失败：' + (e && e.message ? e.message : '未知错误'), 'error')
      await loadAggregation(ctx)
    }
  })
}

async function beginActivate (ctx) {
  try {
    const res = await request(AGGREGATION_ENDPOINTS.activate, { method: 'POST', body: {} })
    // 后端也可能直接返回 {ok:false,code:'consent_required',preview}（200 或 428）。
    if (res && res.code === 'consent_required' && res.preview) { showConsent(res.preview, ctx); return }
    if (res && res.ok) { await reload(ctx); showRestartPrompt(null); return }
    toast('服务端未返回可用的预览', 'error')
  } catch (e) {
    const data = e && e.data ? e.data : null
    if ((e && e.status === 428) || (data && data.code === 'consent_required')) {
      if (data && data.preview) { showConsent(data.preview, ctx); return }
      toast('需要确认，但服务端未返回预览内容', 'error')
      return
    }
    if (e && e.status === 409) { toast('另一个操作正在进行或配置已被修改，请稍后重试', 'error'); await loadAggregation(ctx); return }
    if (e && e.status === 404) { AGG.routeMissing = true; ctx.rerender && ctx.rerender(); return }
    toast('无法开始接入：' + (e && e.message ? e.message : '未知错误'), 'error')
  }
}

function showThreeWay (conflict, ctx) {
  const tw = describeThreeWay(conflict)
  const body = h('div', null,
    callout('warn', h('strong', { text: '拒绝覆盖：' }), ' 接入后配置文件被用户或其他程序修改过。ModelGate 不会为了退出聚合而覆盖这些改动。'),
    h('p', { class: 'hint', text: tw.summary }),
    tw.available && tw.rows.length
      ? table([
        { label: '行', render: (r) => h('span', { class: 'mono', text: String(r.afterNo == null ? r.beforeNo : r.afterNo) }) },
        { label: '差异', render: (r) => tag(r.kind === 'add' ? '新增' : r.kind === 'del' ? '删除' : '修改', r.kind === 'del' ? 'bad' : r.kind === 'add' ? 'info' : 'warn') },
        { label: '当前内容', render: (r) => h('span', { class: 'mono-break', text: r.text || '' }) },
      ], tw.rows)
      : empty('没有可展示的行级差异', tw.summary),
    h('p', { class: 'hint', text: tw.guidance }))
  const d = dialog({ title: '配置冲突（409）· 未写入', desc: '先手工合并，再重新检测；本对话框没有“强制覆盖”。', wide: true, content: body, actions: [
    h('button', { class: 'btn', type: 'button', text: '关闭', onclick: () => d.close() }),
    h('button', { class: 'btn btn-primary', type: 'button', text: '重新检测', onclick: async () => { d.close(); await loadAggregation(ctx) } }),
  ] })
}

async function beginDeactivate (ctx) {
  const health = AGG.health || {}
  const activation = health.activation || {}
  const expectedSha = activation.appliedSha || (health.config && health.config.sha256) || ''
  const ok = await confirmDialog({
    title: '退出聚合模式',
    message: '将把 config.toml 恢复到接入前的字节（仅限 ModelGate 改过的部分）。若期间你手工改过配置，会返回 409 + 三方差异，不会覆盖。',
    confirmLabel: '退出聚合',
    danger: true,
  })
  if (!ok) return
  try {
    await request(AGGREGATION_ENDPOINTS.deactivate, { method: 'POST', body: { expectedSha }, timeoutMs: 60000 })
    toast('已退出聚合模式，配置已恢复到接入前', 'success')
    await reload(ctx)
  } catch (e) {
    if (e && e.status === 409 && e.data && e.data.detail && e.data.detail.threeWay) { showThreeWay(e, ctx); return }
    if (e && e.status === 409) { toast('无法退出：' + (e.message || '配置已被修改'), 'error'); await loadAggregation(ctx); return }
    toast('退出失败：' + (e && e.message ? e.message : '未知错误'), 'error')
  }
}

export function render (root, ctx = {}) {
  if (!AGG.fetched && !AGG.loading) loadAggregation(ctx)
  const loading = !AGG.fetched && AGG.loading
  root.append(pageHead('聚合模式', '一次点击把官方 Codex 与 OpenCode 模型放进同一个 Desktop 模型选择器；自动配置、备份、验证与无损退出。', {
    eyebrow: 'AGGREGATION / DESKTOP',
    actions: [
      h('button', { class: 'btn', type: 'button', text: '重新检测', onclick: () => { AGG.fetched = false; loadAggregation(ctx) } }),
      h('button', { class: 'btn', type: 'button', text: '上游供应商', onclick: () => { location.hash = '#/providers' } }),
    ],
  }))
  if (loading) {
    root.append(callout('info', h('strong', { text: '正在读取聚合状态与 Desktop 探测结果…' }), ' 在响应返回前不显示 0、不显示“已连接”。'))
    return
  }
  if (AGG.routeMissing) root.append(routeNotice(ctx))
  if (AGG.healthError && !AGG.routeMissing) {
    root.append(callout('danger', h('strong', { text: '聚合健康接口读取失败：' }), AGG.healthError.message || '未知错误',
      h('div', { class: 'toolbar', style: { marginTop: '8px' } }, h('button', { class: 'btn btn-sm', type: 'button', text: '重试', onclick: () => { AGG.fetched = false; loadAggregation(ctx) } }))))
  }
  root.append(h('div', { class: 'grid grid-4' },
    metric('模式', (AGG.health && AGG.health.mode === 'aggregated') ? '聚合' : (AGG.health && AGG.health.mode === 'official') ? '官方' : '未知', '来自服务端配置分类', 'check'),
    metric('供应商', AGG.providers ? fmtInt((Array.isArray(AGG.providers) ? AGG.providers : (AGG.providers.providers || [])).length) : '未知', '来自聚合注册表', 'plus'),
    metric('模型（口径见下）', summarizeDiscovery(AGG.diagnostics, AGG.models).countText || '未知', '部分/失败时不显示为全量', 'probe'),
    metric('备份', AGG.health && AGG.health.backup && AGG.health.backup.available ? '可用' : '无', '接入前字节快照', 'key')))
  root.append(statusCard(ctx))
  root.append(providersCard(ctx))
  root.append(modelsCard())
  root.append(diagnosticsCard())
  root.append(callout('warn',
    h('strong', { text: '本页不冒充真实验收：' }),
    ' UI 只能证明接口返回与配置事务成功；原版 Desktop 模型选择器是否出现全部模型、每个模型是否落到正确供应商，必须在真实 GUI 中按交付报告的手动脚本核对（PASS_MOCK ≠ PASS_REAL）。'))
  root.append(h('p', { class: 'page-note', text: '数据来源：' + AGGREGATION_ENDPOINTS.health + ' / providers / models / diagnostics；操作走 activate / deactivate。读取于 ' + (AGG.loadedAt ? fmtTime(AGG.loadedAt) : '—') + '。' }))
}
