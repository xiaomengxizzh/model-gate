// Codex 聚合（D1-A）客户端页的纯数据/预览模块。
// 约束：
//  * 纯前端、零依赖、不 import 后端模块（src/codex/*），不读本地文件、不发起写请求。
//  * 这里的预览只为"让人看懂将要发生什么"；真正的写入由服务端 src/codex/config.js
//    按字段所有权 + sha256 + 确认令牌执行，浏览器不参与。
//  * 不出现 innerHTML / 不持久化任何令牌（见 offline/ui-next.test.mjs 的静态断言）。
import { h } from '../dom.js'
import { request } from '../api.js'

export const UI_CONTRACT = 'mg-codex-ui/1'
// 服务端管理面契约（与 src/codex/api.js 对齐）；探测失败时整个卡片退回 export-only。
export const API_CONTRACT = 'mg-codex-api/1'
const PROBE_TTL_MS = 15000
const ROUTE_PLAN = '/api/codex/config/plan'
const ROUTE_APPLY = '/api/codex/config/apply'
const ROUTE_ROLLBACK = '/api/codex/config/rollback'
const PROBE_PATH = '/api/codex/policy'

const probeCache = { at: 0, value: null, inflight: null }

// 身份事实（E3 实测，2026-11-11）：内置 openai 不能被 [model_providers.openai] 覆盖。
export const IDENTITY_FACTS = [
  'Codex 0.167 把 openai 列为 reserved built-in provider ID：写 [model_providers.openai] 会直接让客户端启动失败。',
  '改向内置 openai 的唯一受支持字段是顶层 openai_base_url；实测把它指向本地 mock 后，客户端会带真实 ChatGPT Bearer 与 chatgpt-account-id 发起请求并成功完成一轮对话。',
  '官方身份下客户端先发 GET {openai_base_url}/v1/models?client_version=<版本>；目录缺失或不完整时会告警并回落 fallback metadata（上下文/工具能力退化）。',
  '客户端会先尝试 WebSocket GET /v1/responses（upgrade），失败后回落 POST。',
  '请求体的 content-encoding 可能是 zstd；网关必须能接收或明确拒绝，否则表现为连接失败而不是模型错误。',
]

export const RISK_NOTES = [
  '官方凭据（Bearer / chatgpt-account-id 等）只允许走受支持的官方路径，绝不下发给第三方上游；本页不读取也不保存任何凭据。',
  '官方订阅是否允许经本地网关转发仍未核实：未获明确授权时保持官方直连，不改 openai_base_url。',
  'model_catalog_json 是"整体替换"语义：目录必须包含官方全量 + 第三方增量，缺字段客户端直接解析失败。',
  '写入不重启 Codex：配置在客户端下次启动或重载时生效；运行中的会话仍使用旧配置。',
  'auth.json 永不读取、永不写入；回滚只用 config.toml.bak。',
]

// —— 探测 GET /api/codex/policy（同源管理 API，带内存令牌；失败即回落 export-only）——
export function codexApiSnapshot () {
  return probeCache.value
}

export function resetCodexApiProbe () {
  probeCache.at = 0
  probeCache.value = null
  probeCache.inflight = null
}

// 渲染期调用：如果没有缓存也没有请求在飞，发一次探测（不阻塞、不抛错）。
function ensureProbe () {
  if (probeCache.value || probeCache.inflight) return
  probeCodexPolicy().catch(() => {})
}

function normalizeProbe (body) {
  const routes = Array.isArray(body && body.routes)
    ? body.routes.map((r) => String((r && r.path) || '')).filter(Boolean)
    : []
  const catalog = body && body.catalog && typeof body.catalog === 'object' ? body.catalog : null
  return {
    available: true,
    checkedAt: Date.now(),
    contract: body && body.contract ? String(body.contract) : null,
    contractOk: !body || !body.contract || String(body.contract) === API_CONTRACT,
    routes,
    plan: routes.includes(ROUTE_PLAN),
    apply: routes.includes(ROUTE_APPLY),
    rollback: routes.includes(ROUTE_ROLLBACK),
    policy: body && body.policy && typeof body.policy === 'object' ? body.policy : null,
    catalog,
    auth: body && body.auth && typeof body.auth === 'object' ? body.auth : null,
    write: body && body.write && typeof body.write === 'object' ? body.write : null,
  }
}

export async function probeCodexPolicy (opts = {}) {
  const ttl = Number.isFinite(opts.ttlMs) ? opts.ttlMs : PROBE_TTL_MS
  if (!opts.force && probeCache.value && Date.now() - probeCache.at < ttl) return probeCache.value
  if (probeCache.inflight) return probeCache.inflight
  probeCache.inflight = (async () => {
    let value
    try {
      const body = await request(PROBE_PATH)
      value = normalizeProbe(body)
    } catch (e) {
      const status = e && Number.isFinite(e.status) ? e.status : 0
      value = {
        available: false,
        checkedAt: Date.now(),
        status,
        reason: status === 401 ? 'unauthorized' : status === 403 ? 'remote_forbidden' : status === 404 ? 'not_mounted' : 'unreachable',
        detail: status === 401
          ? '管理令牌缺失或失效：先解锁控制面再刷新本页。'
          : status === 403
            ? '服务端拒绝本机以外的来源（该接口只在本机开放）。'
            : status === 404
              ? '服务端还没有挂载 /api/codex/*（路由未就绪），本页只导出、不写盘。'
              : '无法连接本地网关或接口未就绪（' + (e && e.message ? e.message : '未知错误') + '），本页只导出、不写盘。',
      }
    } finally {
      probeCache.inflight = null
    }
    probeCache.value = value
    probeCache.at = Date.now()
    return value
  })()
  return probeCache.inflight
}

// 字段所有权：modelgate = 受控写入；external = 只读保留；external-forbidden = 禁止出现/禁止触碰。
export const FIELD_OWNERS = [
  { path: 'model_provider', scope: '顶层', owner: 'modelgate', note: '必须是 "openai"（D1-A 内置身份）' },
  { path: 'openai_base_url', scope: '顶层', owner: 'modelgate', note: '指向 ModelGate 根地址；客户端自行追加 /v1/...' },
  { path: 'model', scope: '顶层', owner: 'modelgate', note: '聚合模型 ID（稳定、不复用旧 ID 指向新供应商）' },
  { path: 'model_catalog_json', scope: '顶层', owner: 'modelgate', note: '本地完整 Codex 目录的绝对路径' },
  { path: 'features.multi_agent / features.multi_agent_v2', scope: '[features]', owner: 'modelgate', note: '仅这两个 feature 键在所有权声明内' },
  { path: '[model_providers.openai]', scope: '段', owner: 'external-forbidden', note: 'reserved built-in provider ID：不得写，写了客户端启动失败' },
  { path: '[mcp_servers.*]', scope: '段', owner: 'external', note: '只读保留，配置写入不修改' },
  { path: '[projects.*] / approval_policy / sandbox_mode', scope: '权限与信任', owner: 'external', note: '只读保留，配置写入不修改' },
  { path: 'auth.json', scope: '文件', owner: 'external-forbidden', note: '官方凭据文件：永不读取、永不写入' },
]

export function ownerLabel (owner) {
  if (owner === 'modelgate') return { label: '受控可写', kind: 'info' }
  if (owner === 'external-forbidden') return { label: '禁止触碰', kind: 'bad' }
  return { label: '只读保留', kind: 'muted' }
}

function tomlValue (value) {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return JSON.stringify(String(value))
}

export function gatewayOrigin () {
  try { return String(location.origin || '') } catch { return '' }
}

// 模板只包含所有权字段 + 注释：粘贴即可人工合并，不含任何凭据。
export function codexIdentityTemplate (opts = {}) {
  const base = String(opts.openaiBaseUrl || '').trim() || '<ModelGate 根地址，例如 http://127.0.0.1:8787>'
  const model = String(opts.model || '').trim() || '<聚合模型 ID>'
  const catalog = String(opts.modelCatalogJsonPath || '').trim() || '<model_catalog_json 绝对路径>'
  const lines = [
    '# ModelGate｜Codex 聚合（D1-A 内置 openai 身份）',
    '# 只写入下面这些字段；其余行（MCP / projects / 权限 / 未知字段 / 注释）必须原样保留。',
    '# 禁止写 [model_providers.openai]：Codex 把 openai 视为 reserved built-in provider ID，',
    '# 覆盖它会让客户端直接启动失败（0.167 实测）。改向只经 openai_base_url。',
    '# 也不要写 auth.json：官方登录凭据由客户端自己管理。',
    'model_provider = "openai"',
    'openai_base_url = ' + tomlValue(base),
    'model = ' + tomlValue(model),
    'model_catalog_json = ' + tomlValue(catalog),
  ]
  if (opts.features && typeof opts.features === 'object') {
    lines.push('', '[features]')
    for (const [k, v] of Object.entries(opts.features)) lines.push(k + ' = ' + tomlValue(v))
  }
  return lines.join('\n')
}

export function codexExportPlan (opts = {}) {
  return {
    contract: UI_CONTRACT,
    identity: 'D1-A built-in openai (openai_base_url redirect)',
    generatedAt: new Date().toISOString(),
    gateway: { openaiBaseUrl: String(opts.openaiBaseUrl || ''), endpoints: ['GET /v1/models?client_version=…', 'WebSocket GET /v1/responses (upgrade)', 'POST /v1/responses'] },
    desired: {
      topLevel: {
        model_provider: 'openai',
        openai_base_url: String(opts.openaiBaseUrl || ''),
        model: String(opts.model || ''),
        model_catalog_json: String(opts.modelCatalogJsonPath || ''),
      },
      ...(opts.features ? { sections: { features: opts.features } } : {}),
    },
    ownership: FIELD_OWNERS,
    serverContract: 'mg-codex-config/1',
    writePolicy: 'export-only：本页不写盘；写入需服务端 plan → confirmToken → apply（sha256 + .bak + 回滚）',
    fileHash: null,
    fileHashNote: '浏览器无法读取本地 config.toml 的 sha256；真实写入时由服务端在临时/本地路径上重新计算。',
    notices: IDENTITY_FACTS.concat(RISK_NOTES),
    notRun: ['未在真实 ~/.codex/config.toml 上写入', '未重启 Codex 客户端', '未验证真实官方账号下的目录加载'],
  }
}

// —— 极简只读扫描：顶层键 + 段内键。仅用于预览，不做 TOML 完整语义 ——
export function scanConfigText (text) {
  const src = String(text == null ? '' : text)
  const lines = src.split(/\r?\n/)
  const topLevel = []
  const sections = []
  const sectionMap = {}
  let current = null
  let reservedOverride = null
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const header = /^\[\[?([^\[\]]+)\]\]?$/.exec(trimmed)
    if (header) {
      current = { name: header[1].trim(), line: i + 1, keys: [] }
      sections.push(current)
      sectionMap[current.name] = current
      if (current.name === 'model_providers.openai') reservedOverride = current
      continue
    }
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*([\s\S]*)$/.exec(trimmed)
    if (!kv) continue
    const entry = { key: kv[1], raw: kv[2].trim(), line: i + 1, section: current ? current.name : '' }
    if (current) current.keys.push(entry)
    else topLevel.push(entry)
  }
  return { topLevel, sections, sectionMap, reservedOverride, lineCount: lines.length - (lines[lines.length - 1] === '' ? 1 : 0) }
}

// 预览：把"模板会改哪些行"逐字段摆出来；不生成合并后的整份文件（避免假装的 TOML 合并）。
export function previewOwnedChange (pastedText, opts = {}) {
  const scan = scanConfigText(pastedText)
  const desiredTop = {
    model_provider: opts.modelProvider || 'openai',
    openai_base_url: String(opts.openaiBaseUrl || ''),
    model: String(opts.model || ''),
    model_catalog_json: String(opts.modelCatalogJsonPath || ''),
  }
  const rows = []
  for (const [key, value] of Object.entries(desiredTop)) {
    if (!value) continue
    const existing = scan.topLevel.find((e) => e.key === key) || null
    const next = tomlValue(value)
    rows.push({
      path: key,
      owner: 'modelgate',
      kind: existing ? (existing.raw === next ? 'same' : 'replace') : 'add',
      from: existing ? existing.raw : null,
      to: next,
      line: existing ? existing.line : null,
    })
  }
  const featureSec = scan.sectionMap.features || null
  if (opts.features && typeof opts.features === 'object') {
    for (const [key, value] of Object.entries(opts.features)) {
      const existing = featureSec ? featureSec.keys.find((e) => e.key === key) || null : null
      const next = tomlValue(value)
      rows.push({
        path: 'features.' + key,
        owner: 'modelgate',
        kind: existing ? (existing.raw === next ? 'same' : 'replace') : 'add',
        from: existing ? existing.raw : null,
        to: next,
        line: existing ? existing.line : null,
      })
    }
  }
  const preserved = {
    topLevelKeys: scan.topLevel.filter((e) => !Object.prototype.hasOwnProperty.call(desiredTop, e.key)).map((e) => e.key),
    sections: scan.sections.filter((s) => s.name !== 'features').map((s) => s.name),
    mcpServers: scan.sections.filter((s) => s.name.startsWith('mcp_servers.')).map((s) => s.name.slice('mcp_servers.'.length)),
  }
  const blocked = []
  if (scan.reservedOverride) {
    blocked.push('[model_providers.openai] 出现在第 ' + scan.reservedOverride.line + ' 行：该段是 reserved built-in provider ID，会让客户端启动失败。本工具不会删改它，请手工移除后再写入。')
  }
  const conflicts = []
  for (const row of rows) {
    if (row.kind !== 'replace') continue
    conflicts.push(row.path + ' 已有值 ' + row.from + '，将被替换为 ' + row.to)
  }
  return {
    ok: blocked.length === 0,
    rows,
    preserved,
    blocked,
    conflicts,
    empty: !String(pastedText || '').trim(),
    scan: { lineCount: scan.lineCount, sectionCount: scan.sections.length },
  }
}

// 目录世代/加载状态：优先用 /api/codex/policy 的目录摘要，其次 /api/status；
// 两者都没有真实字段时给 UNKNOWN —— 不编造"已加载"。
export function catalogState (status) {
  ensureProbe()
  const snap = codexApiSnapshot()
  const c = snap && snap.available && snap.catalog ? snap.catalog : null
  if (c) {
    if (!c.available) {
      return {
        known: false,
        label: 'UNKNOWN',
        kind: 'muted',
        generation: null,
        loadedAt: null,
        detail: c.reason === 'not_configured'
          ? '服务端没有配置 codexCatalogBasePath：目录未生成，官方身份下客户端会告警并回落 fallback metadata。'
          : '服务端目录不可用（生成失败或基线文件缺失），客户端会回落 fallback metadata。',
        source: '/api/codex/policy',
      }
    }
    const counts = c.counts && typeof c.counts === 'object' ? c.counts : null
    const stale = c.stale === true ? '（基线文件已变化：服务端视图可能是旧的）' : c.stale === false ? '（与基线文件一致）' : ''
    return {
      known: true,
      label: 'GEN ' + String(c.generation || '—'),
      kind: c.stale === true ? 'warn' : 'info',
      generation: c.generation || null,
      counts,
      stale: c.stale === null || c.stale === undefined ? null : !!c.stale,
      detail: '服务端目录世代 ' + String(c.generation || '—') + '：官方 ' + (counts ? counts.official : '?') + ' / 聚合 ' + (counts ? counts.thirdParty : '?') + ' / 合计 ' + (counts ? counts.total : '?') + stale + '。客户端是否已重新加载仍需真实客户端证据（本页不探测进程）。',
      source: '/api/codex/policy',
    }
  }
  const s = status && typeof status === 'object' ? status : {}
  const codex = s.codex && typeof s.codex === 'object' ? s.codex : null
  const catalog = (codex && codex.catalog) || s.codexCatalog || null
  if (!catalog || typeof catalog !== 'object') {
    return {
      known: false,
      label: 'UNKNOWN',
      kind: 'muted',
      generation: null,
      loadedAt: null,
      detail: snap && !snap.available
        ? '管理接口未就绪（' + (snap.reason || 'unavailable') + '），且 /api/status 没有目录世代字段：无法判断客户端是否加载了当前目录。不要把它当成"已生效"。'
        : '当前 /api/status 没有目录世代字段：无法判断客户端是否加载了当前目录。不要把它当成"已生效"。',
      source: 'GET /api/status',
    }
  }
  const generation = catalog.generation != null ? String(catalog.generation) : (catalog.version != null ? String(catalog.version) : null)
  const loadedAt = catalog.loadedAt || catalog.publishedAt || null
  const modelCount = Number(catalog.modelCount != null ? catalog.modelCount : catalog.models)
  if (!generation) {
    return { known: false, label: 'UNKNOWN', kind: 'muted', generation: null, loadedAt: loadedAt || null, detail: '/api/status 有目录对象但缺少 generation/version：世代不可判定。', source: 'GET /api/status' }
  }
  return {
    known: true,
    label: 'GEN ' + generation,
    kind: 'info',
    generation,
    loadedAt: loadedAt || null,
    modelCount: Number.isFinite(modelCount) ? modelCount : null,
    detail: '服务端报告的目录世代；客户端是否已重新加载仍需真实客户端证据（本页不探测进程）。',
    source: 'GET /api/status',
  }
}

// 写盘能力：以 /api/codex/policy 的探测结果为唯一判据；浏览器始终不直接写文件。
// status 参数保留是为了调用方签名兼容（clients.js 传 state.status），本函数不再读它。
export function writePathState (status) {
  void status
  ensureProbe()
  const snap = codexApiSnapshot()
  if (snap && snap.available) {
    const ready = !!(snap.plan && snap.apply)
    return {
      ready,
      label: ready ? '服务端受控写入就绪' : '接口部分就绪（仅导出）',
      kind: ready ? 'good' : 'warn',
      contract: snap.contract,
      routes: snap.routes,
      detail: ready
        ? '服务端已提供 plan → confirmToken → apply/rollback（sha256 二次快照 + tmp+rename + .bak + 回滚）。浏览器没有本地文件访问权限：导出内容与路径需由你交给服务端，且不会重启客户端。'
        : '服务端只暴露了部分路由（' + (snap.routes.join(' / ') || '无') + '）：本页仍只导出。',
      source: '/api/codex/policy',
    }
  }
  if (snap && !snap.available) {
    return { ready: false, label: '仅导出（接口未就绪）', kind: 'warn', reason: snap.reason, detail: snap.detail }
  }
  if (probeCache.inflight) {
    return { ready: false, label: '正在探测 /api/codex/policy…', kind: 'muted', detail: '探测完成后本页会显示服务端是否已提供受控写入；在此之前只导出。' }
  }
  // 探测既没有结果也没有请求在飞（例如浏览器禁用了 fetch）：按接口未就绪处理，只导出。
  return {
    ready: false,
    label: '仅导出（接口未就绪）',
    kind: 'warn',
    detail: '没有拿到 /api/codex/policy 的可用响应：本页只导出模板与计划 JSON，不发起任何写请求，也不重启客户端。',
  }
}

// 字段所有者表：服务端 policy 可用时以服务端声明为准，否则用本地常量。
export function ownershipRows () {
  ensureProbe()
  const snap = codexApiSnapshot()
  const policy = snap && snap.available ? snap.policy : null
  if (!policy) return FIELD_OWNERS
  const rows = []
  for (const key of Array.isArray(policy.ownedTopLevel) ? policy.ownedTopLevel : []) {
    rows.push({ path: key, scope: '顶层', owner: 'modelgate', note: '服务端声明所有权的顶层字段' })
  }
  const sections = policy.ownedSections && typeof policy.ownedSections === 'object' ? policy.ownedSections : {}
  for (const [name, keys] of Object.entries(sections)) {
    if (!Array.isArray(keys)) continue
    for (const k of keys) rows.push({ path: name + '.' + k, scope: '[' + name + ']', owner: 'modelgate', note: '服务端声明所有权的 feature 键' })
  }
  for (const sec of Array.isArray(policy.reservedOverrideSections) ? policy.reservedOverrideSections : []) {
    rows.push({ path: '[' + sec + ']', scope: '段', owner: 'external-forbidden', note: 'reserved built-in provider ID：写了客户端启动失败' })
  }
  if (!rows.length) return FIELD_OWNERS
  rows.push({ path: '[mcp_servers.*]', scope: '段', owner: 'external', note: '只读保留，配置写入不修改' })
  rows.push({ path: '[projects.*] / approval_policy / sandbox_mode', scope: '权限与信任', owner: 'external', note: '只读保留，配置写入不修改' })
  rows.push({ path: 'auth.json', scope: '文件', owner: 'external-forbidden', note: '官方凭据文件：永不读取、永不写入' })
  return rows
}

// 小工具：导出文本/JSON（Blob 下载，不落 localStorage）
export function downloadText (filename, text, mime) {
  const blob = new Blob([String(text == null ? '' : text)], { type: mime || 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = h('a', { href: url, download: filename, style: { display: 'none' } })
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1500)
}

export function downloadJson (filename, obj) {
  downloadText(filename, JSON.stringify(obj, null, 2), 'application/json;charset=utf-8')
}