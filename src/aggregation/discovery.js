// A2 / P01：OpenCode 模型自动发现（发现 + 同步）。
//
// 目标（MG-R003 / MG-R008，ADR-0003 §2）：
//   - 一口气穷尽账户可用的全部模型：游标分页与页码分页都支持，二者都受 `maxPages` 上限约束。
//   - **失败绝不伪装成空目录**：返回 `completeness` 三态
//     `discovery_complete` / `discovery_partial` / `discovery_failed`；
//     只有上游明确返回空目录时才允许 `snapshot.models=[]`，并在诊断里标 `empty_entitlement_confirmed`。
//   - 部分页失败 = `discovery_partial`（保留已取得的模型 + 明确 code），绝不是 complete。
//   - 重复/别名上游 ID 合并并留诊断，不静默丢模型。
//   - ETag / Last-Modified 条件请求 + 明确陈旧规则：缓存超过 maxAgeMs 时不再发校验器，强制全量。
//   - 上游精确 ID 保存在 `upstreamId`；`publicId` 复用 `stableModelId()`（provider 段 opencodego/console）。
//
// **API 形状是假设**：本模块不知道 OpenCode 的真实模型清单端点与 JSON 形状。所有候选形状都在
// `extractModels()` / `extractPagination()` 里显式登记并附诊断；任何不匹配一律 typed
// `discovery_shape_unrecognized` / `discovery_pagination_unknown`，绝不猜成“没有更多模型”。
//
// 纯模块：不读文件、不写日志；文件缓存通过注入的 snapshot store 完成。

import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileDurable } from '../config-transaction.js'
import { inlineCredentialFields } from '../router.js'
import { sha256Hex, stableModelId, stableStringify } from '../codex/catalog.js'
import { entryOf as goEntryOf } from '../providers/opencode-go.js'
import { entryOf as consoleEntryOf, resolveListUrl as consoleListUrl } from '../providers/opencode-console.js'
import { PROVIDER_SEGMENTS } from './registry.js'

export const SNAPSHOT_SCHEMA = 'modelgate.aggregation.snapshot/1'
export const CACHE_SCHEMA = 'modelgate.aggregation.discovery-cache/1'
export const COMPLETENESS = Object.freeze({
  COMPLETE: 'discovery_complete',
  PARTIAL: 'discovery_partial',
  FAILED: 'discovery_failed',
})
export const DEFAULT_MAX_PAGES = 20
export const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000
export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024
export const SERVICE_UA = 'model-gateway/0.1'

export class DiscoveryError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'DiscoveryError'
    this.code = code
    this.details = details
    this.retryable = details.retryable === true
  }
}

const lower = (v) => String(v == null ? '' : v).trim().toLowerCase()
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const positiveInt = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null)
const nowIso = (ms) => new Date(ms).toISOString()

function diagnostic(code, message, extra = {}) {
  return Object.assign({ code, severity: 'info', message }, extra)
}

function countsZero() {
  return { discovered: 0, unique: 0, authorized: 0, unauthorized: 0, notRoutable: 0, authorizationUnverified: 0, duplicates: 0, aliases: 0 }
}

// 稳定指纹：不含 observedAt（否则每次同步都会把所有模型标成 updated）。
export function modelFingerprint(model) {
  return sha256Hex(stableStringify({
    upstreamId: model.upstreamId,
    publicId: model.publicId,
    displayName: model.displayName || null,
    contextWindow: model.contextWindow == null ? null : model.contextWindow,
    capabilities: model.capabilities || null,
    authorized: model.authorized === true,
  }))
}

// ---------------------------------------------------------------------------
// 端点解析（假设显式化）
// ---------------------------------------------------------------------------

export function resolveGoListUrl(def, options = {}) {
  const d = def || {}
  if (d.modelListUrl != null && d.modelListUrl !== '') {
    return { ok: true, url: String(d.modelListUrl), host: hostOfUrl(d.modelListUrl), assumed: true, basis: 'explicit_modelListUrl' }
  }
  const entry = goEntryOf(d)
  if (!entry.ok) return { ok: false, code: entry.code, message: entry.message, assumed: true, basis: 'go_entry' }
  const root = entry.url.replace(/\/(chat\/completions|responses)$/, '')
  const url = entry.root ? root + '/v1/models' : root + '/models'
  return {
    ok: true,
    url,
    host: entry.host,
    assumed: true,
    basis: 'go_list_assumption',
    entry: entry.entry,
    warning: 'Go 模型清单端点未在厂商文档核实：按入口推导 ' + url + '（假设）',
  }
}

function hostOfUrl(raw) {
  try { return new URL(String(raw)).hostname.toLowerCase() } catch { return null }
}

export function resolveListEndpoint(provider, cfg = {}) {
  const def = provider && provider._def ? provider._def : provider
  const kind = provider && provider.kind ? provider.kind : (def && def.aggregation ? def.aggregation.kind : null)
  if (kind === 'opencode-console') {
    const resolved = consoleListUrl(Object.assign({}, def, { _cfg: cfg, modelListUrl: provider.modelListUrl || def.modelListUrl }))
    if (!resolved.ok) return resolved
    return {
      ok: true,
      url: resolved.url,
      host: resolved.host,
      assumed: true,
      basis: resolved.basis,
      entry: resolved.entry,
      warning: resolved.warning || ('Console 清单端点已实测；响应形状仍是假设：' + resolved.url),
    }
  }
  if (kind === 'opencode-go') return resolveGoListUrl(def)
  return { ok: false, code: 'discovery_provider_kind_unknown', message: '未知的聚合 provider kind：' + String(kind) }
}

// ---------------------------------------------------------------------------
// 响应形状（假设清单）
// ---------------------------------------------------------------------------

// 支持的模型数组位置（按顺序探测）：
//   [ ... ]                         裸数组
//   { data: [...] }                 OpenAI /v1/models 形状
//   { models: [...] }               Codex catalog 形状
//   { items: [...] }                常见 REST 分页
//   { result: [...] } / { result: { data|models|items: [...] } }
//   { objects: [...] }
export function extractModels(body) {
  if (Array.isArray(body)) return { ok: true, models: body, shape: 'array' }
  if (!isPlainObject(body)) return { ok: false, code: 'discovery_shape_unrecognized', message: '响应不是对象/数组：' + typeof body }
  for (const key of ['data', 'models', 'items', 'objects']) {
    if (Array.isArray(body[key])) return { ok: true, models: body[key], shape: key }
  }
  if (Array.isArray(body.result)) return { ok: true, models: body.result, shape: 'result' }
  if (isPlainObject(body.result)) {
    for (const key of ['data', 'models', 'items']) {
      if (Array.isArray(body.result[key])) return { ok: true, models: body.result[key], shape: 'result.' + key }
    }
  }
  return { ok: false, code: 'discovery_shape_unrecognized', message: '响应中找不到模型数组（data/models/items/result）' }
}

function headerOf(res, name) {
  const h = res && res.headers
  if (!h) return null
  if (typeof h.get === 'function') return h.get(name)
  return h[name] != null ? h[name] : (h[name.toLowerCase()] != null ? h[name.toLowerCase()] : null)
}

// 分页形状（假设）：
//   游标：next_cursor / nextCursor / pagination.next_cursor / (has_more && cursor)
//   页码：next_page / nextPage / pagination.next_page / page.next 数字 / has_next
//   链接：next 为字符串（必须同源 + 白名单 host，绝不跨源转发凭据）
//   终止：has_more=false / has_next=false / next=null / total + 当前页已耗尽
export function extractPagination(body, headers, state) {
  const page = state.page || 1
  const pageSize = state.pageSize || null
  const p = isPlainObject(body) && isPlainObject(body.pagination) ? body.pagination : {}
  const pick = (...vals) => vals.find((v) => v !== undefined && v !== null)
  const cursor = pick(body.next_cursor, body.nextCursor, p.next_cursor, p.nextCursor,
    (body.has_more === true || p.has_more === true) ? body.cursor : undefined,
    (body.hasMore === true || p.hasMore === true) ? body.cursor : undefined)
  const hasMoreRaw = pick(body.has_more, body.hasMore, p.has_more, p.hasMore, body.has_next, body.hasNext, p.has_next, p.hasNext)
  const hasMore = hasMoreRaw === undefined ? null : (hasMoreRaw === true)
  const nextUrl = typeof body.next === 'string' ? body.next : (typeof p.next === 'string' ? p.next : null)
  const nextPageRaw = pick(body.next_page, body.nextPage, p.next_page, p.nextPage,
    typeof body.next === 'number' ? body.next : undefined,
    typeof p.next === 'number' ? p.next : undefined)
  const nextPage = positiveInt(nextPageRaw)
  const total = positiveInt(pick(body.total, p.total, body.total_count, body.totalCount))
  const perPage = positiveInt(pick(body.per_page, body.perPage, p.per_page, p.perPage, body.pageSize, p.pageSize)) || pageSize
  let hasNext = hasMore
  if (hasNext === null && total !== null && perPage !== null) hasNext = page * perPage < total
  if (hasNext === null && (cursor !== undefined || nextPage !== null || nextUrl)) hasNext = true
  if (hasNext === null) hasNext = false
  if (hasNext && cursor === undefined && nextPage === null && !nextUrl) {
    return { ok: false, code: 'discovery_pagination_unknown', message: '上游声称还有下一页，但没有 cursor/next_page/next 可用；拒绝当作已穷尽' }
  }
  return { ok: true, hasNext, cursor: cursor === undefined ? null : String(cursor), nextPage, nextUrl, total, perPage }
}

function appendQuery(url, params) {
  const u = new URL(String(url))
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined) u.searchParams.set(k, String(v))
  }
  return u.toString()
}

function sameOrigin(a, b) {
  try {
    const x = new URL(a); const y = new URL(b)
    return x.protocol === y.protocol && x.host === y.host
  } catch { return false }
}

// ---------------------------------------------------------------------------
// 单条模型规范化
// ---------------------------------------------------------------------------

const DENY_WORDS = new Set(['none', 'disabled', 'denied', 'forbidden', 'unavailable', 'revoked'])

// 上游 `api` 映射键 → 统一协议名。2026-11-14 实测：opencode 清单每个模型带
// `api: { 'chat-completions'|'responses'|'messages'|'generate-content': { base_url } }`。
const PROTOCOL_BY_API_KEY = Object.freeze({
  'chat-completions': 'openai',
  responses: 'responses',
  messages: 'anthropic-messages',
  'generate-content': 'google-generate-content',
})

// 本网关的 Console/Go 适配器只实现 openai（chat-completions）与 responses 两种协议；
// 其它协议的模型可以“被发现”，但不能发布成可调用模型（否则就是过度承诺）。
export const ROUTABLE_PROTOCOLS = Object.freeze(['openai', 'responses'])

// `{supported:true}` 与裸布尔都算“已声明支持”。
const declared = (v) => v === true || (isPlainObject(v) && v.supported === true)

// 协议探测：优先按上游 api 键；未知形状返回 {protocol:null, routable:true}，
// 保持旧 fixture（无 api 字段）的向后兼容——没有证据就不否定可路由性。
function protocolOf(raw) {
  const api = isPlainObject(raw.api) ? raw.api : null
  if (!api) {
    const explicit = typeof raw.protocol === 'string' ? raw.protocol.trim().toLowerCase() : ''
    if (explicit) return { protocol: explicit, routable: ROUTABLE_PROTOCOLS.includes(explicit), apiBaseUrl: null }
    return { protocol: null, routable: true, apiBaseUrl: null }
  }
  for (const [key, protocol] of Object.entries(PROTOCOL_BY_API_KEY)) {
    const entry = api[key]
    if (entry === undefined || entry === null) continue
    const baseUrl = isPlainObject(entry) && typeof entry.base_url === 'string' ? entry.base_url : null
    return { protocol, routable: ROUTABLE_PROTOCOLS.includes(protocol), apiBaseUrl: baseUrl, apiKey: key }
  }
  return { protocol: 'unknown', routable: false, apiBaseUrl: null }
}

// 上下文窗口：`limit.context`（单数 limit，实测真实形状）优先，其余别名作为回退。
export function contextWindowOf(raw) {
  if (!isPlainObject(raw)) return null
  const candidates = [
    isPlainObject(raw.limit) ? raw.limit.context : null,
    raw.context_window_tokens,
    raw.contextWindowTokens,
    raw.context_window,
    raw.contextWindow,
    raw.context_length,
    raw.contextLength,
    raw.max_context_tokens,
    isPlainObject(raw.limits) ? raw.limits.context : null,
  ]
  for (const c of candidates) {
    const n = positiveInt(c)
    if (n !== null) return n
  }
  return null
}

export function normalizeModelEntry(raw, context) {
  const issues = []
  if (typeof raw === 'string') raw = { id: raw }
  if (!isPlainObject(raw)) return { ok: false, issues: [diagnostic('model_entry_invalid', '模型条目不是对象/字符串')] }
  const upstreamIdRaw = raw.id != null ? raw.id
    : (raw.model_id != null ? raw.model_id : (raw.modelId != null ? raw.modelId : (raw.slug != null ? raw.slug : raw.name)))
  const upstreamId = typeof upstreamIdRaw === 'string' ? upstreamIdRaw.trim() : ''
  if (!upstreamId) return { ok: false, issues: [diagnostic('model_id_missing', '模型条目缺少 id/model/slug')] }
  let authorized = true
  // 授权依据：显式字段优先；否则由调用方决定“仅因出现在清单而视为可用”的基线——
  // Console 的清单按授权过滤（实测 anon 86 / auth 50，auth ⊂ anon）→ `listed`；
  // Go 的清单与是否携带凭据完全一致（30/30）→ `unverified`，不得声称已证明授权。
  let authBasis = context.listedAuthBasis || 'listed'
  const access = lower(raw.access)
  const status = lower(raw.status)
  if (raw.authorized === false || raw.enabled === false || raw.allowed === false ||
      DENY_WORDS.has(access) || DENY_WORDS.has(status) ||
      (isPlainObject(raw.permissions) && raw.permissions.chat === false)) {
    authorized = false
    authBasis = 'explicit_denied'
  } else if (raw.authorized === true) {
    authBasis = 'explicit_allowed'
  }
  const contextWindow = contextWindowOf(raw)
  const caps = isPlainObject(raw.capabilities) ? raw.capabilities : {}
  const capabilities = Object.freeze({
    tools: declared(raw.tools) || declared(raw.supports_tools) || declared(caps.tools),
    reasoning: declared(raw.reasoning) || declared(raw.supports_reasoning) || declared(raw.supportsReasoning) || declared(caps.reasoning),
    structuredOutput: declared(raw.structured_output) || declared(raw.structuredOutput) || declared(caps.structured_output) || declared(caps.structuredOutput),
    // `effort_updates` 表示上游会在同一会话内更新推理档位（真实形状为 {supported:boolean}）。
    effortUpdates: declared(raw.effort_updates) || declared(raw.effortUpdates) || declared(caps.effort_updates) || declared(caps.effortUpdates),
    supportsSearchTool: declared(raw.supports_search_tool) || declared(raw.supportsSearchTool) || declared(caps.supportsSearchTool) || declared(caps.search),
    supportsWebsockets: declared(raw.supports_websockets) || declared(raw.supportsWebsockets) || declared(caps.supportsWebsockets) || declared(caps.websockets),
  })
  const displayName = (typeof raw.display_name === 'string' && raw.display_name.trim())
    || (typeof raw.displayName === 'string' && raw.displayName.trim())
    || (typeof raw.name === 'string' && raw.name.trim())
    || upstreamId
  // 只有**显式别名**字段才能折叠模型。`canonical_id` 是厂商规范名（例如
  // `deepseek/deepseek-v4.1-flash-1017`），不是本清单里的另一个模型 ID，绝不能当作 aliasOf：
  // 一旦上游把某个 canonical_id 写成清单里已存在的 ID，就会把两个不同模型静默合并成一个。
  const aliasOf = (typeof raw.alias_of === 'string' && raw.alias_of.trim())
    || (typeof raw.aliasOf === 'string' && raw.aliasOf.trim())
    || (typeof raw.duplicate_of === 'string' && raw.duplicate_of.trim())
    || (typeof raw.duplicateOf === 'string' && raw.duplicateOf.trim())
    || null
  const vendorCanonical = (typeof raw.canonical_id === 'string' && raw.canonical_id.trim())
    || (typeof raw.canonicalId === 'string' && raw.canonicalId.trim())
    || (typeof raw.vendorCanonical === 'string' && raw.vendorCanonical.trim())
    || null
  const routing = protocolOf(raw)
  const aliases = Array.isArray(raw.aliases) ? raw.aliases.filter((a) => typeof a === 'string' && a.trim()).map((a) => a.trim()) : []
  let publicId = null
  try {
    publicId = stableModelId(context.providerSegment, upstreamId)
  } catch {
    issues.push(diagnostic('public_id_invalid', '无法为上游 ID 生成稳定公共 ID', { upstreamId }))
  }
  return {
    ok: true,
    issues,
    model: {
      publicId,
      providerId: context.providerId,
      upstreamId,
      displayName,
      contextWindow,
      capabilities,
      authorized,
      authBasis,
      aliasOf,
      aliases,
      vendorCanonical,
      protocol: routing.protocol,
      routable: routing.routable,
      apiBaseUrl: routing.apiBaseUrl,
      evidence: { source: context.source, observedAt: context.observedAt },
    },
  }
}

// 去重 + 别名折叠：同一 canonical 只保留一条；authorized 采用 AND（宁可少宣称，不越权）。
function finalizeModels(entries, context, diagnostics) {
  const idSet = new Set(entries.map((m) => m.upstreamId))
  const aliasOwner = new Map()
  for (const m of entries) {
    for (const alias of m.aliases) {
      if (alias !== m.upstreamId && !aliasOwner.has(alias)) aliasOwner.set(alias, m.upstreamId)
    }
  }
  const byCanonical = new Map()
  let duplicates = 0
  let aliases = 0
  for (const m of entries) {
    let canonical = m.upstreamId
    if (m.aliasOf) {
      if (idSet.has(m.aliasOf)) {
        canonical = m.aliasOf
        aliases += 1
        diagnostics.push(diagnostic('alias_collapsed', '上游别名 ID 折叠到 canonical', { alias: m.upstreamId, canonical: m.aliasOf }))
      } else {
        diagnostics.push(diagnostic('alias_target_missing', '别名指向的 canonical 不在本次清单中', { alias: m.upstreamId, target: m.aliasOf, severity: 'warning' }))
      }
    } else if (aliasOwner.has(m.upstreamId)) {
      canonical = aliasOwner.get(m.upstreamId)
      aliases += 1
      diagnostics.push(diagnostic('alias_collapsed', '上游别名 ID 折叠到 canonical', { alias: m.upstreamId, canonical }))
    }
    const prev = byCanonical.get(canonical)
    if (!prev) {
      byCanonical.set(canonical, Object.assign({}, m, { canonicalId: canonical }))
      continue
    }
    duplicates += 1
    diagnostics.push(diagnostic('duplicate_upstream_id', '上游清单重复返回同一模型 ID（已合并）', { upstreamId: canonical }))
    byCanonical.set(canonical, Object.assign({}, prev, {
      authorized: prev.authorized === true && m.authorized === true,
      authBasis: prev.authBasis === m.authBasis ? prev.authBasis : 'conflicting_duplicates',
      capabilities: Object.freeze({
        tools: prev.capabilities.tools || m.capabilities.tools,
        reasoning: prev.capabilities.reasoning || m.capabilities.reasoning,
        structuredOutput: prev.capabilities.structuredOutput || m.capabilities.structuredOutput,
        effortUpdates: prev.capabilities.effortUpdates || m.capabilities.effortUpdates,
        supportsSearchTool: prev.capabilities.supportsSearchTool || m.capabilities.supportsSearchTool,
        supportsWebsockets: prev.capabilities.supportsWebsockets || m.capabilities.supportsWebsockets,
      }),
      // 可路由性采用 AND：任何一条重复条目说不可路由，就不对外宣称可调用。
      routable: prev.routable !== false && m.routable !== false,
      contextWindow: prev.contextWindow != null ? prev.contextWindow : m.contextWindow,
    }))
    if (prev.authorized !== m.authorized) {
      diagnostics.push(diagnostic('duplicate_authorization_conflict', '重复条目授权状态冲突：按更保守的 false 处理', { upstreamId: canonical, severity: 'warning' }))
    }
  }
  const models = [...byCanonical.values()]
    .map((m) => Object.freeze(m))
    .sort((a, b) => String(a.publicId || a.upstreamId).localeCompare(String(b.publicId || b.upstreamId)))
  return {
    models,
    counts: {
      discovered: entries.length,
      unique: models.length,
      authorized: models.filter((m) => m.authorized).length,
      unauthorized: models.filter((m) => !m.authorized).length,
      // 已发现但本网关协议不支持、因而不得发布为可调用模型的条目：显式计数，绝不静默丢弃。
      notRoutable: models.filter((m) => m.routable === false).length,
      // 授权未被上游证明（仅因出现在清单里）的条目数。
      authorizationUnverified: models.filter((m) => m.authBasis === 'unverified').length,
      duplicates,
      aliases,
    },
  }
}

// ---------------------------------------------------------------------------
// 失败/成功信封
// ---------------------------------------------------------------------------

function failureResult(code, message, details = {}) {
  const diag = diagnostic(code, message, Object.assign({ severity: 'error' }, details.diagnostic || {}))
  return {
    ok: false,
    completeness: COMPLETENESS.FAILED,
    code,
    error: { code, message, retryable: details.retryable === true },
    retryable: details.retryable === true,
    snapshot: null,
    diagnostics: [...(details.diagnostics || []), diag],
    counts: countsZero(),
  }
}

function partialResult(state, code, message, details = {}) {
  return {
    ok: false,
    completeness: COMPLETENESS.PARTIAL,
    code,
    error: { code, message, retryable: details.retryable === true },
    retryable: details.retryable === true,
    snapshot: state.snapshot,
    diagnostics: [...state.diagnostics, diagnostic(code, message, Object.assign({ severity: 'warning' }, details.diagnostic || {}))],
    counts: state.counts,
    etag: null,
    lastModified: null,
  }
}

function classifyHttp(status, retryAfterMs) {
  if (status === 401) return { code: 'discovery_auth_failed', message: '上游拒绝凭据（401）：Key 无效/过期；这不是空模型目录', retryable: false }
  if (status === 403) return { code: 'discovery_forbidden', message: '上游拒绝访问（403）：账户/工作区无该目录权限', retryable: false }
  if (status === 404) return { code: 'discovery_endpoint_missing', message: '模型清单端点不存在（404）：入口形状是假设，需 live 探针确认', retryable: false }
  if (status === 429) return { code: 'discovery_rate_limited', message: '上游限流（429）', retryable: retryAfterMs != null && retryAfterMs > 0 }
  if (status >= 500) return { code: 'discovery_upstream_error', message: '上游错误（' + status + '）', retryable: true }
  return { code: 'discovery_http_error', message: '上游返回非 2xx（' + status + '）', retryable: false }
}

function parseRetryAfterMs(res) {
  const raw = headerOf(res, 'retry-after')
  if (raw == null) return null
  const s = String(raw).trim()
  if (/^\d+$/.test(s)) return Number(s) * 1000
  const at = Date.parse(s)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null
}

// ---------------------------------------------------------------------------
// 缓存存储
// ---------------------------------------------------------------------------

export function createMemorySnapshotStore() {
  const map = new Map()
  const key = (scope, id) => String(scope) + '\u0000' + String(id)
  return {
    get(scope, id) { return map.get(key(scope, id)) || null },
    put(scope, id, entry) { map.set(key(scope, id), entry); return entry },
    putAttempt(scope, id, attempt) { map.set(key(scope, id) + '\u0001attempt', attempt); return attempt },
    lastAttempt(scope, id) { return map.get(key(scope, id) + '\u0001attempt') || null },
    clear() { map.clear() },
    _map: map,
  }
}

const SAFE_SEGMENT_RE = /[^A-Za-z0-9._-]+/g
function safeSegment(v) {
  const s = String(v == null ? '' : v).replace(SAFE_SEGMENT_RE, '_')
  return s === '' || s === '.' || s === '..' ? '_' : s
}

export function createFileSnapshotStore(options = {}) {
  const dir = options.dir
  if (!dir) throw new DiscoveryError('discovery_store_dir_missing', '文件快照存储需要 dir')
  const pathFor = (scope, id) => join(dir, 'aggregation', 'snapshots', safeSegment(scope), safeSegment(id) + '.json')
  return {
    get(scope, id) {
      try {
        const parsed = JSON.parse(readFileSync(pathFor(scope, id), 'utf8'))
        return parsed && parsed.schema === CACHE_SCHEMA ? parsed : null
      } catch (error) {
        if (error && error.code === 'ENOENT') return null
        // 派生缓存损坏：返回 null 触发全量刷新，但绝不把它当“无模型”。
        return null
      }
    },
    put(scope, id, entry) {
      const path = pathFor(scope, id)
      mkdirSync(join(dir, 'aggregation', 'snapshots', safeSegment(scope)), { recursive: true, mode: 0o700 })
      writeFileDurable(path, JSON.stringify(entry), 0o600)
      return entry
    },
    putAttempt(scope, id, attempt) {
      const path = pathFor(scope, id).replace(/\.json$/, '.attempt.json')
      mkdirSync(join(dir, 'aggregation', 'snapshots', safeSegment(scope)), { recursive: true, mode: 0o700 })
      writeFileDurable(path, JSON.stringify(attempt), 0o600)
      return attempt
    },
    lastAttempt(scope, id) {
      try { return JSON.parse(readFileSync(pathFor(scope, id).replace(/\.json$/, '.attempt.json'), 'utf8')) } catch { return null }
    },
    pathFor,
  }
}

// ---------------------------------------------------------------------------
// 发现引擎
// ---------------------------------------------------------------------------

export function createDiscoveryEngine(options = {}) {
  const cacheStore = options.cacheStore || createMemorySnapshotStore()
  const registry = options.registry || null
  const fetchImpl = options.fetchImpl || (typeof globalThis.fetch === 'function' ? globalThis.fetch : null)
  const nowFn = typeof options.now === 'function' ? options.now : () => Date.now()
  const defaultMaxPages = positiveInt(options.maxPages) || DEFAULT_MAX_PAGES
  const maxAgeMs = positiveInt(options.maxAgeMs) || DEFAULT_MAX_AGE_MS
  const maxResponseBytes = positiveInt(options.maxResponseBytes) || DEFAULT_MAX_RESPONSE_BYTES
  const resolveCredential = typeof options.resolveCredential === 'function' ? options.resolveCredential : null
  const cfg = options.cfg || {}

  function credentialFor(provider, opts) {
    if (opts.credential != null) return String(opts.credential)
    if (resolveCredential) return resolveCredential(provider)
    const ref = provider && provider.keyRef
    if (ref === 'none') return null
    if (provider && provider.apiKeyEnv && process.env[provider.apiKeyEnv]) return process.env[provider.apiKeyEnv]
    return null
  }

  async function discover(provider, opts = {}) {
    const startedAt = nowFn()
    const maxPages = positiveInt(opts.maxPages) || positiveInt(provider && provider.pagination && provider.pagination.maxPages) || defaultMaxPages
    const scope = opts.scope || 'local'
    if (!provider) return failureResult('discovery_provider_missing', 'discover 需要 provider 记录')
    const kind = provider.kind || (provider.aggregation && provider.aggregation.kind)
    if (!kind) return failureResult('discovery_provider_kind_unknown', 'provider 缺少 kind')
    const providerId = provider.id || (provider.aggregation && provider.aggregation.id)
    const providerSegment = provider.providerSegment || PROVIDER_SEGMENTS[kind]
    if (!providerSegment) return failureResult('discovery_provider_kind_unknown', 'provider kind 没有公共 ID 段：' + kind)
    const endpoint = resolveListEndpoint(provider, cfg)
    if (!endpoint.ok) {
      return failureResult(endpoint.code || 'discovery_endpoint_unresolved', endpoint.message || '无法解析模型清单端点')
    }
    if (endpoint.host && !isAllowedHost(endpoint.host, cfg) && !(opts.allowLoopback === true && isLoopback(endpoint.host))) {
      return failureResult('discovery_host_not_allowlisted', '模型清单 host 不在白名单：' + endpoint.host)
    }
    // 内联 apiKey 永远不会被读取（Key 只来自 keys.local.json / apiKeyEnv）。配置里带了它，
    // 就必须让操作者看到“这个字段被忽略”，否则上游静默未鉴权、只报 requires an API key。
    const providerDef = (cfg && cfg.providers && cfg.providers[providerId]) || provider._def || {}
    const inlineFields = inlineCredentialFields(providerDef)
    const inlineDiag = inlineFields.length
      ? diagnostic('inline_api_key_ignored',
        'provider ' + providerId + ' 配置了内联凭据字段 `' + inlineFields[0] + '`，但该值不会被读取：'
        + '请改用 keys.local.json 或 provider.apiKeyEnv（稳定 code：inline_api_key_ignored）',
        { severity: 'warning', providerId, field: inlineFields[0] })
      : null
    const credential = credentialFor(provider, opts)
    if (!credential && opts.allowAnonymous !== true) {
      return failureResult('discovery_credential_missing', '没有可用凭据引用；拒绝把“未鉴权”当成“账户没有模型”',
        { retryable: false, diagnostics: inlineDiag ? [inlineDiag] : [] })
    }
    if (!fetchImpl && !opts.fetchImpl) return failureResult('discovery_transport_missing', '没有可用的 fetch 实现')
    const doFetch = opts.fetchImpl || fetchImpl
    const baseHeaders = { 'user-agent': SERVICE_UA, accept: 'application/json' }
    if (credential) baseHeaders.authorization = 'Bearer ' + credential

    const cacheEntry = normalizeCache(opts.cache)
    const cacheFresh = cacheEntry && (startedAt - (cacheEntry.storedAt || 0)) <= maxAgeMs
    const diagnostics = [diagnostic('discovery_started', '开始发现', { providerId, scope, maxPages })]
    if (inlineDiag) diagnostics.push(inlineDiag)
    if (endpoint.assumed) {
      diagnostics.push(diagnostic('endpoint_assumed', endpoint.warning || '模型清单端点是显式假设', { severity: 'warning', url: endpoint.url }))
      diagnostics.push(diagnostic('entry_assumption_unverified', '未复核厂商文档；live 前需所有者批准探针', { severity: 'warning' }))
    }

    let url = endpoint.url
    let pageNo = 1
    const rawModels = []
    const pages = []
    let etag = null
    let lastModified = null
    const observedAt = nowIso(startedAt)

    while (true) {
      if (pageNo > maxPages) {
        const state = buildSnapshotState({ provider, providerId, providerSegment, endpoint, scope, rawModels, diagnostics, observedAt, complete: false })
        return partialResult(state, 'discovery_max_pages_exceeded',
          '分页达到 maxPages=' + maxPages + ' 仍未穷尽；结果不完整，禁止当作全量目录',
          { diagnostic: { maxPages, pagesFetched: pages.length } })
      }
      const headers = Object.assign({}, baseHeaders)
      if (pageNo === 1 && cacheFresh && cacheEntry) {
        if (cacheEntry.etag) headers['if-none-match'] = cacheEntry.etag
        if (cacheEntry.lastModified) headers['if-modified-since'] = cacheEntry.lastModified
      }
      let res
      try {
        res = await doFetch(url, { method: 'GET', headers, signal: opts.signal })
      } catch (error) {
        if (pageNo === 1) {
          return failureResult('discovery_transport_error', '请求模型清单失败：' + ((error && error.name) || 'network'), { retryable: true })
        }
        const state = buildSnapshotState({ provider, providerId, providerSegment, endpoint, scope, rawModels, diagnostics, observedAt, complete: false })
        return partialResult(state, 'discovery_transport_error',
          '第 ' + pageNo + ' 页请求失败；已取得的模型不代表全量',
          { retryable: true, diagnostic: { page: pageNo } })
      }
      const status = Number(res && res.status) || 0
      if (res && res.url && !sameOrigin(res.url, endpoint.url)) {
        return failureResult('discovery_cross_origin_redirect', '上游把请求重定向到不同源：拒绝携带凭据继续')
      }
      if (status === 304) {
        if (pageNo !== 1) {
          return failureResult('discovery_cache_partial_mismatch', '分页中途收到 304：缓存只能代表整份快照，拒绝拼接')
        }
        if (!cacheEntry || !cacheEntry.snapshot) {
          return failureResult('discovery_cache_missing', '收到 304 但没有可用快照缓存')
        }
        if (cacheEntry.snapshot.providerId !== providerId || cacheEntry.snapshot.endpoint.host !== endpoint.host) {
          return failureResult('discovery_cache_scope_mismatch', '304 命中的缓存属于另一个 provider/端点，拒绝复用')
        }
        const revalidated = Object.freeze(Object.assign({}, cacheEntry.snapshot, {
          freshness: 'revalidated',
          validatedAt: nowIso(nowFn()),
        }))
        return {
          ok: true,
          completeness: COMPLETENESS.COMPLETE,
          snapshot: revalidated,
          diagnostics: [...diagnostics, diagnostic('cache_revalidated', 'ETag/Last-Modified 命中：上游确认目录未变', { etag: cacheEntry.etag || null })],
          counts: revalidated.counts,
          etag: cacheEntry.etag || null,
          lastModified: cacheEntry.lastModified || null,
          revalidated: true,
        }
      }
      if (status < 200 || status >= 300) {
        const classified = classifyHttp(status, parseRetryAfterMs(res))
        if (pageNo === 1) {
          return failureResult(classified.code, classified.message, { retryable: classified.retryable, diagnostic: { status } })
        }
        const state = buildSnapshotState({ provider, providerId, providerSegment, endpoint, scope, rawModels, diagnostics, observedAt, complete: false })
        return partialResult(state, 'discovery_page_failed', '第 ' + pageNo + ' 页失败（' + classified.code + '）；已取得 ' + rawModels.length + ' 条不代表全量',
          { retryable: classified.retryable, diagnostic: { page: pageNo, status } })
      }
      if (pageNo === 1) {
        etag = headerOf(res, 'etag')
        lastModified = headerOf(res, 'last-modified')
      }
      // 200 + text/html 是一个真实陷阱：错误的端点会返回网页（SPA）而不是模型清单。
      // 绝不要把 HTML 解析成“空目录”。
      const contentType = lower(headerOf(res, 'content-type'))
      if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
        const message = '模型清单返回 HTML（content-type: ' + (contentType || '?') + '）：该端点很可能是网页而不是 API，拒绝解析'
        if (pageNo === 1) {
          return failureResult('discovery_response_invalid', message, { diagnostic: { page: pageNo, status, contentType } })
        }
        const state = buildSnapshotState({ provider, providerId, providerSegment, endpoint, scope, rawModels, diagnostics, observedAt, complete: false })
        return partialResult(state, 'discovery_page_invalid', '第 ' + pageNo + ' 页返回 HTML；已取得的模型不代表全量', { diagnostic: { page: pageNo, status, contentType } })
      }
      let text
      try { text = await res.text() } catch (error) {
        if (pageNo === 1) return failureResult('discovery_response_unreadable', '无法读取上游响应体：' + ((error && error.name) || 'read_error'), { retryable: true })
        const state = buildSnapshotState({ provider, providerId, providerSegment, endpoint, scope, rawModels, diagnostics, observedAt, complete: false })
        return partialResult(state, 'discovery_page_unreadable', '第 ' + pageNo + ' 页响应体无法读取', { retryable: true, diagnostic: { page: pageNo } })
      }
      if (typeof text === 'string' && text.length > maxResponseBytes) {
        if (pageNo === 1) return failureResult('discovery_response_too_large', '模型清单响应超过 ' + maxResponseBytes + ' 字节，拒绝截断解析')
        const state = buildSnapshotState({ provider, providerId, providerSegment, endpoint, scope, rawModels, diagnostics, observedAt, complete: false })
        return partialResult(state, 'discovery_page_too_large', '第 ' + pageNo + ' 页超过 ' + maxResponseBytes + ' 字节', { diagnostic: { page: pageNo } })
      }
      let body
      try { body = JSON.parse(text) } catch {
        if (pageNo === 1) return failureResult('discovery_response_invalid', '模型清单不是合法 JSON，拒绝当作空目录')
        const state = buildSnapshotState({ provider, providerId, providerSegment, endpoint, scope, rawModels, diagnostics, observedAt, complete: false })
        return partialResult(state, 'discovery_page_invalid', '第 ' + pageNo + ' 页不是合法 JSON；已取得的模型不代表全量', { diagnostic: { page: pageNo } })
      }
      const extracted = extractModels(body)
      if (!extracted.ok) {
        if (pageNo === 1) return failureResult(extracted.code, extracted.message, { diagnostic: { page: pageNo } })
        const state = buildSnapshotState({ provider, providerId, providerSegment, endpoint, scope, rawModels, diagnostics, observedAt, complete: false })
        return partialResult(state, 'discovery_page_shape_unrecognized', '第 ' + pageNo + ' 页形状无法识别：' + extracted.message, { diagnostic: { page: pageNo } })
      }
      pages.push({ page: pageNo, shape: extracted.shape, count: extracted.models.length })
      rawModels.push(...extracted.models)
      const paging = extractPagination(body, res.headers, { page: pageNo, pageSize: provider.pagination && provider.pagination.pageSize })
      if (!paging.ok) {
        const state = buildSnapshotState({ provider, providerId, providerSegment, endpoint, scope, rawModels, diagnostics, observedAt, complete: false })
        return partialResult(state, paging.code, paging.message, { diagnostic: { page: pageNo } })
      }
      if (!paging.hasNext) break
      if (pageNo === maxPages) {
        const state = buildSnapshotState({ provider, providerId, providerSegment, endpoint, scope, rawModels, diagnostics, observedAt, complete: false })
        return partialResult(state, 'discovery_max_pages_exceeded',
          '分页达到 maxPages=' + maxPages + ' 且上游仍有下一页；结果不完整',
          { diagnostic: { maxPages, pagesFetched: pages.length } })
      }
      let nextUrl
      if (paging.nextUrl) {
        if (!sameOrigin(paging.nextUrl, endpoint.url)) {
          return failureResult('discovery_pagination_cross_origin', '分页 next 链接跨源：拒绝携带凭据跟随')
        }
        nextUrl = paging.nextUrl
      } else if (paging.cursor !== null) {
        const param = (provider.pagination && provider.pagination.cursorParam) || 'cursor'
        nextUrl = appendQuery(endpoint.url, { [param]: paging.cursor })
      } else if (paging.nextPage !== null) {
        const pageParam = (provider.pagination && provider.pagination.pageParam) || 'page'
        const sizeParam = (provider.pagination && provider.pagination.sizeParam) || 'per_page'
        const params = { [pageParam]: paging.nextPage }
        if (paging.perPage) params[sizeParam] = paging.perPage
        nextUrl = appendQuery(endpoint.url, params)
      } else {
        const state = buildSnapshotState({ provider, providerId, providerSegment, endpoint, scope, rawModels, diagnostics, observedAt, complete: false })
        return partialResult(state, 'discovery_pagination_unknown', '有下一页但无法构造下一页 URL', { diagnostic: { page: pageNo } })
      }
      if (nextUrl === url) {
        const state = buildSnapshotState({ provider, providerId, providerSegment, endpoint, scope, rawModels, diagnostics, observedAt, complete: false })
        return partialResult(state, 'discovery_pagination_stuck', '下一页 URL 与当前页相同：分页游标没有前进', { diagnostic: { page: pageNo } })
      }
      url = nextUrl
      pageNo += 1
    }

    const state = buildSnapshotState({ provider, providerId, providerSegment, endpoint, scope, rawModels, diagnostics, observedAt, complete: true, pages, etag, lastModified })
    if (state.snapshot.models.length === 0) {
      // 只有上游明确返回空数组、且分页显示没有更多，才允许空目录；并且必须标“上游证实”。
      state.diagnostics.push(diagnostic('empty_entitlement_confirmed',
        '上游明确返回空模型数组（分页已穷尽）：这是上游证实的空授权目录，不是发现失败'))
      state.snapshot = Object.freeze(Object.assign({}, state.snapshot, { emptyConfirmed: true }))
    }
    return {
      ok: true,
      completeness: COMPLETENESS.COMPLETE,
      snapshot: state.snapshot,
      diagnostics: state.diagnostics,
      counts: state.counts,
      etag,
      lastModified,
    }
  }

  function buildSnapshotState({ provider, providerId, providerSegment, endpoint, scope, rawModels, diagnostics, observedAt, complete, pages = [], etag = null, lastModified = null }) {
    const entryDiagnostics = []
    const entries = []
    const providerKind = provider.kind || (provider.aggregation && provider.aggregation.kind) || null
    // 授权基线：Console 清单按授权过滤 → listed；Go 清单与是否带凭据完全一致 → unverified。
    const listedAuthBasis = providerKind === 'opencode-go' ? 'unverified' : 'listed'
    for (const raw of rawModels) {
      const normalized = normalizeModelEntry(raw, {
        providerId,
        providerSegment,
        listedAuthBasis,
        source: 'model_list:' + endpoint.host + safePath(endpoint.url),
        observedAt,
      })
      if (normalized.issues && normalized.issues.length) entryDiagnostics.push(...normalized.issues)
      if (normalized.ok) entries.push(normalized.model)
    }
    diagnostics.push(...entryDiagnostics)
    const fin = finalizeModels(entries, { providerSegment }, diagnostics)
    const inferredAuth = fin.models.filter((m) => m.authorized && m.authBasis === 'listed').length
    if (inferredAuth > 0) {
      diagnostics.push(diagnostic('authorization_inferred_from_listing',
        '有 ' + inferredAuth + ' 个模型仅因出现在账户清单而视为可用（authBasis=listed）；未看到逐模型授权字段',
        { severity: 'warning', count: inferredAuth }))
    }
    const unverifiedAuth = fin.models.filter((m) => m.authorized && m.authBasis === 'unverified').length
    if (unverifiedAuth > 0) {
      diagnostics.push(diagnostic('authorization_unverified_from_listing',
        '有 ' + unverifiedAuth + ' 个模型出现在清单里，但该清单不随凭据变化（匿名/鉴权结果一致），无法证明账户授权：按未核实处理，不宣称已授权',
        { severity: 'warning', count: unverifiedAuth, basis: 'unverified' }))
    }
    const notRoutable = fin.models.filter((m) => m.routable === false)
    if (notRoutable.length > 0) {
      diagnostics.push(diagnostic('discovered_not_routable',
        '有 ' + notRoutable.length + ' 个模型已发现但其协议本网关不支持：保留在快照中，不发布为可调用模型',
        {
          severity: 'warning',
          count: notRoutable.length,
          protocols: [...new Set(notRoutable.map((m) => m.protocol || 'unknown'))].sort(),
          upstreamIds: notRoutable.map((m) => m.upstreamId),
        }))
    }
    for (const m of fin.models) {
      if (m.contextWindow == null) {
        diagnostics.push(diagnostic('context_window_missing', '模型缺少上下文窗口：发布时会 fail-closed，不编造', { severity: 'warning', upstreamId: m.upstreamId, publicId: m.publicId }))
      }
    }
    const invalidEntries = entryDiagnostics.filter((d) => d.code === 'model_id_missing' || d.code === 'model_entry_invalid').length
    const completeFinal = complete && invalidEntries === 0
    if (complete && invalidEntries > 0) {
      diagnostics.push(diagnostic('model_entries_invalid', '有 ' + invalidEntries + ' 条模型条目无法解析；清单不完整', { severity: 'warning', count: invalidEntries }))
    }
    const snapshot = Object.freeze({
      schema: SNAPSHOT_SCHEMA,
      providerId,
      providerKind: provider.kind || (provider.aggregation && provider.aggregation.kind) || null,
      providerSegment,
      scope,
      endpoint: { host: endpoint.host, path: safePath(endpoint.url), assumed: endpoint.assumed === true, basis: endpoint.basis || null },
      observedAt,
      validatedAt: observedAt,
      freshness: 'fresh',
      etag: etag || null,
      lastModified: lastModified || null,
      completeness: completeFinal ? COMPLETENESS.COMPLETE : COMPLETENESS.PARTIAL,
      complete: completeFinal,
      pages,
      models: fin.models,
      counts: fin.counts,
    })
    return { snapshot, diagnostics, counts: fin.counts }
  }

  async function sync(providerId, opts = {}) {
    const scope = opts.scope || 'local'
    const provider = opts.provider || (registry && typeof registry.getProvider === 'function' ? registry.getProvider(providerId) : null)
    if (!provider) {
      return Object.assign(failureResult('discovery_provider_unknown', '注册表里没有该聚合 Provider：' + String(providerId)), {
        changed: { added: [], removed: [], updated: [], retainedPrevious: true },
        applied: false,
      })
    }
    const previous = cacheStore.get(scope, provider.id)
    const result = await discover(provider, Object.assign({}, opts, { scope, cache: opts.cache !== undefined ? opts.cache : previous }))
    // 不完整结果不参与 added/removed 计算：否则“第 2 页失败”会被读成“模型被删除”。
    const changed = result.ok && result.completeness === COMPLETENESS.COMPLETE
      ? diffSnapshots(previous && previous.snapshot, result.snapshot)
      : { added: [], removed: [], updated: [], partial: true }
    const at = nowIso(nowFn())
    if (result.ok && result.completeness === COMPLETENESS.COMPLETE && result.snapshot) {
      cacheStore.put(scope, provider.id, {
        schema: CACHE_SCHEMA,
        storedAt: nowFn(),
        etag: result.etag || null,
        lastModified: result.lastModified || null,
        snapshot: result.snapshot,
      })
      return Object.assign({}, result, { changed, applied: true })
    }
    const attempt = {
      schema: CACHE_SCHEMA,
      at,
      completeness: result.completeness,
      code: result.code || null,
      diagnostics: (result.diagnostics || []).map((d) => d.code),
      modelsSeen: result.snapshot ? result.snapshot.models.length : 0,
    }
    cacheStore.putAttempt(scope, provider.id, attempt)
    return Object.assign({}, result, { changed, applied: false, retainedPrevious: !!(previous && previous.snapshot) })
  }

  return Object.freeze({ discover, sync, cacheStore, maxPages: defaultMaxPages, maxAgeMs })
}

function safePath(raw) {
  try {
    const u = new URL(String(raw))
    return u.pathname
  } catch { return null }
}

function isLoopback(host) {
  const h = lower(host).replace(/^\[|\]$/g, '')
  return h === '127.0.0.1' || h === 'localhost' || h === '::1'
}

function isAllowedHost(host, cfg) {
  const h = lower(host)
  if (isLoopback(h)) return true
  const raw = cfg && cfg.defaults && cfg.defaults.opencodeGoHosts
  const list = Array.isArray(raw) && raw.length ? raw.map(lower) : ['opencode.ai']
  return list.includes(h)
}

function normalizeCache(cache) {
  if (!cache) return null
  if (cache.schema === CACHE_SCHEMA && cache.snapshot) return cache
  if (cache.schema === SNAPSHOT_SCHEMA) return { schema: CACHE_SCHEMA, storedAt: Date.parse(cache.observedAt) || 0, etag: cache.etag || null, lastModified: cache.lastModified || null, snapshot: cache }
  return null
}

export function diffSnapshots(previous, next) {
  const prevModels = new Map(((previous && previous.models) || []).map((m) => [m.upstreamId, m]))
  const nextModels = new Map(((next && next.models) || []).map((m) => [m.upstreamId, m]))
  const added = [...nextModels.keys()].filter((id) => !prevModels.has(id)).sort()
  const removed = [...prevModels.keys()].filter((id) => !nextModels.has(id)).sort()
  const updated = []
  for (const [id, model] of nextModels) {
    const prev = prevModels.get(id)
    if (!prev) continue
    if (modelFingerprint(prev) !== modelFingerprint(model)) updated.push(id)
  }
  return { added, removed, updated: updated.sort() }
}

// 模块级默认引擎（主代理用 configureDiscovery 绑定；测试用 createDiscoveryEngine）。
let _defaultEngine = null
export function configureDiscovery(options = {}) {
  _defaultEngine = createDiscoveryEngine(options)
  return _defaultEngine
}
export function getDiscoveryEngine() { return _defaultEngine }
function requireEngine() {
  if (!_defaultEngine) throw new DiscoveryError('discovery_not_configured', '发现引擎未配置：先 configureDiscovery({ registry, cacheStore })')
  return _defaultEngine
}
export function discover(provider, opts) { return requireEngine().discover(provider, opts) }
export function sync(providerId, opts) { return requireEngine().sync(providerId, opts) }
