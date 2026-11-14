// P03：OpenCode Go Provider 适配（纯模块：不发请求、不读文件、不写日志）。
//
// 目标与边界（plan §3「OpenCode Go 接入」）：
//   1. **入口绑定**：现行 Go 入口是 /inference/go/openai/v1/{chat/completions,responses}；
//      旧 DSH route/Key 绑定的 /zen/go/v1/chat/completions 是**另一个（遗留）绑定**，不能静默互认。
//      本模块把入口判定成显式 binding，遗留入口默认拒绝（需 allowLegacy 才放行并留 warning）。
//   2. **版本/授权校验**：host 必须命中 OpenCode 白名单；必须声明 Go 入口版本；
//      必须能从 provider 配置/合成 grant 看到凭据（只判存在性，绝不返回值）。
//   3. **别名与 effort 严格映射**：本地别名 → 供应商真实模型；只接受已证实的 low/high/max，
//      未知档位给明确错误，不静默宣称生效。
//   4. **头构造**：本服务 UA；x-opencode-session 按「主体 + provider + root/child 域 + 目标域 + 线程」
//      做 HMAC 派生，绝不转发原始 Codex session-id/thread-id；缺线程引用时给请求内独立 id。
//
// 事实来源：能力只来自显式 evidence（source/version/observedAt/expiresAt），缺席即 unknown，
// 过期即 stale —— 不把「配置里写了」当成「上游已证实」。
//
// **位形证据（未独立复核厂商文档）**：本模块登记的现行 Go 位形只有
//   /inference/go/openai/v1/{chat/completions,responses}（plan §3 记录的最新文档形状）
//   /inference/go/v1/{chat/completions,responses}（本树 CHANGELOG 2026-09 记录 + 历史 live 脚本
//     baseUrl=https://opencode.ai/inference/go 再由发送层拼 /v1/…）
// 两者都登记为现行 binding（名字区分），互相不自动认作对方；/zen/go/v1 继续 legacy+deprecated。
// 其它形状（例如 /inference/go/v2）一律拒绝。**live 使用前必须以厂商文档或有效凭据下的探针确认位形**，
// 本仓库没有联网探测，不得把这里的登记当成已证实的生产事实。

import { createHmac, randomUUID } from 'node:crypto'
import { hostOf, isOpencodeGoHost } from '../codex/identity.js'

export const PROVIDER_ID = 'opencodego'
export const SERVICE_UA = 'model-gateway/0.1'
export const ENTRY_SCHEMA = 'modelgate.opencode-go.entry/1'
export const CAPABILITY_SCHEMA = 'modelgate.opencode-go.capabilities/1'

// 现行 Go 入口（与 /zen/go/... 遗留入口分属不同绑定）。两种现行位形各自一个 binding，不互认：
//   go-openai-v1 → /inference/go/openai/v1/...
//   go-v1        → /inference/go/v1/...
export const ENTRIES = Object.freeze({
  CHAT: Object.freeze({ kind: 'chat', binding: 'go-openai-v1', path: '/inference/go/openai/v1/chat/completions', legacy: false }),
  RESPONSES: Object.freeze({ kind: 'responses', binding: 'go-openai-v1', path: '/inference/go/openai/v1/responses', legacy: false }),
  CHAT_V1: Object.freeze({ kind: 'chat', binding: 'go-v1', path: '/inference/go/v1/chat/completions', legacy: false }),
  RESPONSES_V1: Object.freeze({ kind: 'responses', binding: 'go-v1', path: '/inference/go/v1/responses', legacy: false }),
  LEGACY_ZEN: Object.freeze({ kind: 'chat', binding: 'legacy-zen', path: '/zen/go/v1/chat/completions', legacy: true, deprecated: true }),
})
export const GO_ENTRY_VERSIONS = Object.freeze(['go-v1'])
export const GO_EFFORTS = Object.freeze(['low', 'high', 'max'])
export const DEFAULT_ALIAS = 'mg-opencodego-deepseek-v4-1-flash'
export const DEFAULT_VENDOR_MODEL = 'deepseek-v4.1-flash'
export const SESSION_HEADER = 'x-opencode-session'
const SESSION_VALUE_LEN = 32

const lower = (v) => String(v == null ? '' : v).trim().toLowerCase()
const normalizeUrl = (v) => String(v == null ? '' : v).trim().replace(/\/+$/, '')

// 入场绑定判定：baseUrl (+ pathPrefix, + 显式 entry 覆盖) → { ok, entry, host, url }。
// 只做字符串形状判定；不解析、不联网。
export function entryOf(def) {
  const d = def || {}
  const base = normalizeUrl(d.baseUrl)
  const host = hostOf(base)
  if (!base) return { ok: false, code: 'opencodego_base_url_missing', message: 'provider.baseUrl 缺失，无法确定 Go 入口' }
  const explicit = lower(d.opencodeGoEntry)
  let url = normalizeUrl(base + normalizeUrl(d.pathPrefix))
  if (explicit) {
    if (explicit === 'chat' || explicit === 'responses') {
      return { ok: true, entry: explicit === 'chat' ? ENTRIES.CHAT : ENTRIES.RESPONSES, host, url, source: 'explicit' }
    }
    return { ok: false, code: 'opencodego_entry_invalid', message: 'opencodeGoEntry 只接受 chat/responses：' + String(d.opencodeGoEntry), host, url }
  }
  for (const entry of [ENTRIES.LEGACY_ZEN, ENTRIES.CHAT, ENTRIES.RESPONSES, ENTRIES.CHAT_V1, ENTRIES.RESPONSES_V1]) {
    if (url.endsWith(entry.path) || url === normalizeUrl(base + entry.path)) {
      return { ok: true, entry, host, url, source: 'baseUrl' }
    }
  }
  // baseUrl 只到入口目录时，chat/responses 由协议决定，二者都合法；但必须标 ambiguous（诊断可见）。
  if (url.endsWith('/inference/go/openai/v1')) return { ok: true, entry: ENTRIES.CHAT, host, url, source: 'baseUrl', ambiguous: true }
  if (url.endsWith('/inference/go/v1')) return { ok: true, entry: ENTRIES.CHAT_V1, host, url, source: 'baseUrl', ambiguous: true }
  // Desktop 现行位形：provider.baseUrl 到 /inference/go、pathPrefix=/openai（bin/mg-desktop.mjs）。
  // 该目录不含版本段，发送层再拼 /v1/…；与 go-openai-v1 是同一绑定，必须按 URL 形状识别，
  // 否则只有恰好叫 `opencodego` 的 provider 才算 Go 绑定，改个名字就丢掉 x-opencode-session。
  if (url.endsWith('/inference/go/openai')) return { ok: true, entry: ENTRIES.CHAT, host, url, source: 'baseUrl', ambiguous: true, root: true }
  // 历史 live 脚本用的是 /inference/go 根，由发送层再拼 /v1/…（本树 CHANGELOG 2026-09 记录）。
  if (url.endsWith('/inference/go')) return { ok: true, entry: ENTRIES.CHAT_V1, host, url, source: 'baseUrl', ambiguous: true, root: true }
  if (url.includes('/zen/go/')) return { ok: true, entry: ENTRIES.LEGACY_ZEN, host, url, source: 'baseUrl' }
  return { ok: false, code: 'opencodego_entry_unknown', message: 'baseUrl 不是已登记的 Go 入口（现行 /inference/go/openai/v1、/inference/go/v1，或遗留 /zen/go/v1）', host, url }
}

// 运行时判定「这个 provider 是否属于现行 Go 绑定」：显式 id 或（可识别的现行入口路径）。
// 遗留 /zen/go 只认显式 provider id，不因 URL 形状自动继承新绑定语义。
export function isGoBinding(provider) {
  const p = provider || {}
  if (p.id === PROVIDER_ID) return true
  const entry = entryOf(p._def || p)
  return entry.ok === true && entry.entry.legacy !== true
}

// 版本/授权校验。opts: { cfg, grant, model, allowLegacy, allowLoopback, now }
//   grant = { keyRef: 'provider-key'|'env'|'none', hasCredential?: boolean }，只判存在性。
export function validate(def, opts = {}) {
  const d = def || {}
  const entry = entryOf(d)
  if (!entry.ok) return { ok: false, code: entry.code, message: entry.message, entry, warnings: [] }
  const warnings = []
  const host = entry.host
  const hostAllowed = isOpencodeGoHost(host, opts.cfg) ||
    (opts.allowLoopback === true && (host === '127.0.0.1' || host === 'localhost' || host === '::1'))
  if (!hostAllowed) {
    return { ok: false, code: 'opencodego_host_not_allowlisted', message: 'Go 入口 host 不在白名单：' + String(host || '?') + '（opencode.ai；隔离测试可显式 allowLoopback）', entry, warnings }
  }
  if (entry.entry.legacy) {
    if (opts.allowLegacy !== true) {
      return { ok: false, code: 'opencodego_legacy_entry_denied', message: '遗留 Go 入口（/zen/go/...）与被授权的新绑定不是同一入口；需显式 allowLegacy 才放行', entry, warnings }
    }
    warnings.push({ code: 'legacy_zen_entry', message: '使用遗留 /zen/go/... 入口：仅限已存在绑定的兼容路径，不作为新绑定' })
  }
  const api = d.api === undefined || d.api === '' ? 'openai' : String(d.api)
  if (api !== 'openai' && api !== 'responses') {
    return { ok: false, code: 'opencodego_api_unsupported', message: 'Go provider.api 只能是 openai/responses：' + api, entry, warnings }
  }
  if (entry.ambiguous) {
    warnings.push({
      code: 'entry_shape_ambiguous',
      message: '入口只到目录（' + entry.url + '）：chat/responses 未显式区分；live 前请用厂商文档/探针确认位形',
    })
  }
  const version = d.opencodeGoVersion == null || d.opencodeGoVersion === '' ? 'unversioned' : String(d.opencodeGoVersion)
  if (!GO_ENTRY_VERSIONS.includes(version)) {
    if (version === 'unversioned') warnings.push({ code: 'entry_version_unversioned', message: '未声明 opencodeGoVersion；按已识别入口继续，但版本证据缺失' })
    else return { ok: false, code: 'opencodego_version_unsupported', message: '不支持的 Go 入口版本：' + version + '（已证明：' + GO_ENTRY_VERSIONS.join(', ') + '）', entry, warnings }
  }
  const grant = opts.grant || null
  const hasCredential = !!(grant && grant.hasCredential === true) ||
    !!(grant && typeof grant.keyRef === 'string' && grant.keyRef && grant.keyRef !== 'none') ||
    typeof d.apiKey === 'string' && d.apiKey.length > 0 ||
    typeof d.apiKeyEnv === 'string' && d.apiKeyEnv.length > 0
  if (!hasCredential) warnings.push({ code: 'credential_unresolved', message: '未看到 Go 凭据引用；实际发送会按无凭据处理（不继承任何客户端/官方凭据）' })
  const mapped = opts.model === undefined ? null : mapModel(opts.cfg, opts.model)
  if (mapped && mapped.ok === false) {
    return { ok: false, code: mapped.code, message: mapped.message, entry, warnings }
  }
  return {
    ok: true,
    code: null,
    entry,
    version,
    host,
    hasCredential,
    model: mapped ? mapped.vendorModel : null,
    warnings,
  }
}

// 模型别名 → 供应商真实模型。严格映射：只有配置里显式声明（providerModels/alias/upstreamModel）才认。
export function mapModel(cfg, model) {
  const name = typeof model === 'string' ? model.trim() : ''
  if (!name) return { ok: false, code: 'opencodego_model_missing', message: '缺少模型名' }
  if (name === DEFAULT_VENDOR_MODEL) return { ok: true, vendorModel: name, declaration: 'vendor' }
  if (name === DEFAULT_ALIAS) {
    // 本地别名只在配置确实声明了它时成立，否则不擅自把某个供应商模型塞给别名。
    const declared = cfg && cfg.models && cfg.models[defaultAliasEntryName(cfg, name)]
    if (!declared) return { ok: false, code: 'opencodego_alias_undeclared', message: '别名 ' + name + ' 未在 config/models 声明，拒绝隐式映射' }
  }
  const models = (cfg && cfg.models) || {}
  const hit = findModel(models, name)
  if (!hit) return { ok: false, code: 'opencodego_model_unmapped', message: '模型 ' + name + ' 未在 config/models 声明为 ' + PROVIDER_ID + ' 的模型/别名' }
  const [entryName, entry] = hit
  const vendor = (entry.providerModels && entry.providerModels[PROVIDER_ID]) || entry.upstreamModel || entryName
  return { ok: true, vendorModel: String(vendor), declaration: 'config', modelName: entryName }
}

function defaultAliasEntryName(cfg, alias) {
  const models = (cfg && cfg.models) || {}
  for (const [name, entry] of Object.entries(models)) {
    if (Array.isArray(entry && entry.alias) && entry.alias.includes(alias)) return name
  }
  return alias
}

function findModel(models, name) {
  for (const [entryName, entry] of Object.entries(models)) {
    if (!entry || typeof entry !== 'object') continue
    if (entryName === name) return [entryName, entry]
    if (Array.isArray(entry.alias) && entry.alias.includes(name)) return [entryName, entry]
  }
  return null
}

// effort 严格映射：仅已证实的 low/high/max；关闭/未知档位给明确错误（不静默掉契约）。
export function mapEffort(effort, opts = {}) {
  const allowed = Array.isArray(opts.allowed) && opts.allowed.length ? opts.allowed.map(lower) : GO_EFFORTS.slice()
  const raw = lower(effort)
  if (!raw) return { ok: false, code: 'opencodego_effort_missing', message: '缺少 reasoning effort' }
  const canon = raw === 'off' || raw === 'none' || raw === 'disabled' ? 'none' : raw
  if (!allowed.includes(canon)) {
    return { ok: false, code: 'opencodego_effort_unsupported', message: 'Go 未证实该推理档位：' + canon + '（已证实：' + allowed.join(', ') + '）' }
  }
  return { ok: true, effort: canon }
}

// 能力事实：只从显式 evidence 推出，带来源/版本/有效期/新鲜度。
// evidence = { source, version, observedAt, expiresAt, facts: { stream, tools, parallelTools, usage, efforts } }
export function capabilities(evidence, opts = {}) {
  const now = Number.isFinite(opts.now) ? Number(opts.now) : Date.now()
  const e = evidence && typeof evidence === 'object' ? evidence : null
  const base = {
    schema: CAPABILITY_SCHEMA,
    model: opts.model || DEFAULT_VENDOR_MODEL,
    source: e && typeof e.source === 'string' ? e.source : null,
    version: e && typeof e.version === 'string' ? e.version : null,
    observedAt: e && typeof e.observedAt === 'string' ? e.observedAt : null,
    expiresAt: e && typeof e.expiresAt === 'string' ? e.expiresAt : null,
  }
  if (!e || !base.source || !base.observedAt) {
    return Object.freeze(Object.assign(base, {
      freshness: 'unknown', proven: false, facts: Object.freeze({}),
      note: '无显式能力证据：stream/tools/usage/effort 一律 unknown，不得对外宣称支持',
    }))
  }
  const expiresMs = base.expiresAt ? Date.parse(base.expiresAt) : NaN
  if (Number.isFinite(expiresMs) && expiresMs <= now) {
    return Object.freeze(Object.assign(base, {
      freshness: 'stale', proven: false, facts: Object.freeze({}),
      note: '能力证据已过期（expiresAt=' + base.expiresAt + '）：按未知处理，需重新取证',
    }))
  }
  const f = e.facts && typeof e.facts === 'object' ? e.facts : {}
  const facts = {}
  for (const key of ['stream', 'tools', 'parallelTools', 'usage']) {
    if (typeof f[key] === 'boolean') facts[key] = f[key]
  }
  if (Array.isArray(f.efforts)) {
    const efforts = f.efforts.map(lower).filter((v) => GO_EFFORTS.includes(v))
    facts.efforts = Object.freeze([...new Set(efforts)])
  }
  return Object.freeze(Object.assign(base, {
    freshness: 'fresh',
    proven: Object.keys(facts).length > 0,
    facts: Object.freeze(facts),
    note: null,
  }))
}

// 头构造：本服务 UA + 域派生会话标识。绝不复制客户端官方头/原始线程 id。
// opts: { req, body, provider, cfg, principalRef, scope, salt, now }
export function newHeaders(opts = {}) {
  const req = opts.req || {}
  const provider = opts.provider || {}
  const cfg = opts.cfg || {}
  const headers = (req.headers && typeof req.headers === 'object') ? req.headers : {}
  const first = (name) => {
    const v = headers[name]
    return Array.isArray(v) ? v[0] : v
  }
  const threadId = String(
    first('thread-id') || first('session-id') || first('x-session-id') || first('x-conversation-id') ||
    (opts.body && (opts.body.session_id || opts.body.conversation_id)) || ''
  ).trim()
  const scopeRaw = lower(first('x-mg-session-scope') || opts.scope)
  const scope = scopeRaw === 'child' ? 'child' : 'root'
  const principal = String(opts.principalRef == null ? '' : opts.principalRef).trim()
  const def = provider._def || provider
  const entry = entryOf(def)
  const domain = (entry.ok ? entry.url : normalizeUrl(def.baseUrl)) + '|' + (provider.id || PROVIDER_ID)
  const wantsSalt = opts.salt != null ? opts.salt
    : (def.sessionHmacSecret != null ? def.sessionHmacSecret
      : ((cfg.defaults && cfg.defaults.sessionHmacSecret != null) ? cfg.defaults.sessionHmacSecret : null))
  const salt = wantsSalt != null && String(wantsSalt).length > 0 ? String(wantsSalt) : ephemeralSalt()
  let value
  let mode
  if (threadId) {
    value = createHmac('sha256', salt)
      .update([PROVIDER_ID, domain, principal, scope, threadId].join('\u0000'))
      .digest('base64url')
      .slice(0, SESSION_VALUE_LEN)
    if (value === threadId) {
      // 理论不可达（HMAC 输出形状不同），留作 fail-closed 断言：绝不把原线程 id 当会话标识。
      value = 'mg-' + randomUUID()
      mode = 'request'
    } else {
      mode = 'derived'
    }
  } else {
    value = 'mg-' + randomUUID()
    mode = 'request'
  }
  return {
    headers: Object.freeze({ 'user-agent': SERVICE_UA, [SESSION_HEADER]: value }),
    session: Object.freeze({ header: SESSION_HEADER, value, mode, scope, domain, hasPrivateSalt: wantsSalt != null }),
  }
}

let _ephemeralSalt = null
function ephemeralSalt() {
  // 无显式私有盐时用进程内一次性随机盐：同一进程内同线程稳定（会话亲和），跨重启/跨域不可关联，
  // 且绝不退化成「常量盐」或「原样转发线程 id」。
  if (!_ephemeralSalt) _ephemeralSalt = randomUUID()
  return _ephemeralSalt
}

// 请求体整形：模型名严格换到供应商模型；流式补 include_usage 以便拿到真实用量。
export function encode(body, opts = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, code: 'opencodego_body_invalid', message: '请求体必须是对象' }
  }
  const out = Object.assign({}, body)
  const notes = []
  if (opts.vendorModel) {
    if (opts.vendorModel === body.model) notes.push('model=' + opts.vendorModel)
    out.model = opts.vendorModel
  }
  if (out.stream === true) {
    if (out.stream_options == null) {
      out.stream_options = { include_usage: true }
      notes.push('stream_options.include_usage=true')
    }
  }
  return { ok: true, body: out, notes }
}

// 上游用量：只认上游实际返回的 usage；没有就是 unknown（不估算、不拿字符数冒充 token）。
export function usageOf(payload, opts = {}) {
  const u = payload && typeof payload === 'object' ? (payload.usage || (payload.response && payload.response.usage) || null) : null
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null)
  const input = u ? (num(u.prompt_tokens) != null ? num(u.prompt_tokens) : num(u.input_tokens)) : null
  const output = u ? (num(u.completion_tokens) != null ? num(u.completion_tokens) : num(u.output_tokens)) : null
  const total = u ? num(u.total_tokens) : null
  if (input == null && output == null && total == null) {
    return Object.freeze({ kind: 'unknown', input: null, output: null, total: null, source: null, reason: 'upstream_usage_missing' })
  }
  return Object.freeze({ kind: 'actual', input, output, total: total != null ? total : (input != null && output != null ? input + output : null), source: 'upstream' })
}

// 错误映射：429 区分短时限流 / 订阅额度（Extra Usage）/ 网关侧限流；证据不足报 unknown。
// 返回值不含上游正文/头值，只给稳定 code 与短 message（≤200 字符，便于排查但不回显敏感内容）。
export function decodeError(status, bodyText, headers, opts = {}) {
  const code = Number(status) || 0
  const text = String(bodyText == null ? '' : bodyText).slice(0, 4000)
  const retryAfterRaw = headers && (headers['retry-after'] || headers['Retry-After'])
  const retryAfterMs = parseRetryAfter(retryAfterRaw, opts.now)
  const lowerText = text.toLowerCase()
  const message = redactBody(text)
  if (code === 401) return { status: code, code: 'opencodego_auth_failed', retryable: false, quota: 'unknown', retryAfterMs, message, nextAction: 'check-provider-credential' }
  if (code === 403) return { status: code, code: 'opencodego_forbidden', retryable: false, quota: 'unknown', retryAfterMs, message, nextAction: 'check-workspace-authorization' }
  if (code === 429) {
    const quotaHint = /quota|usage limit|usage_limit|extra usage|insufficient|balance|额度|套餐/.test(lowerText)
    const shortWindow = retryAfterMs != null && retryAfterMs > 0 && retryAfterMs <= 5 * 60 * 1000
    const quota = quotaHint ? 'exhausted' : (shortWindow ? 'short' : 'unknown')
    return {
      status: code,
      code: quota === 'exhausted' ? 'opencodego_quota_exhausted' : (quota === 'short' ? 'opencodego_rate_limited' : 'opencodego_rate_limited_unknown'),
      retryable: quota === 'short',
      quota,
      retryAfterMs,
      message,
      nextAction: quota === 'exhausted' ? 'check-official-usage' : (quota === 'short' ? 'retry-after' : 'inspect-round-robin'),
    }
  }
  if (code === 402) return { status: code, code: 'opencodego_payment_required', retryable: false, quota: 'exhausted', retryAfterMs, message, nextAction: 'check-official-usage' }
  if (code >= 500) return { status: code, code: 'opencodego_upstream_error', retryable: true, quota: 'unknown', retryAfterMs, message, nextAction: 'retry-with-deadline' }
  if (code === 400) return { status: code, code: 'opencodego_bad_request', retryable: false, quota: 'unknown', retryAfterMs, message, nextAction: 'fix-request' }
  return { status: code, code: 'opencodego_error', retryable: false, quota: 'unknown', retryAfterMs, message, nextAction: 'inspect' }
}

export function parseRetryAfter(raw, now) {
  const v = Array.isArray(raw) ? raw[0] : raw
  if (v == null) return null
  const s = String(v).trim()
  if (!s) return null
  if (/^\d+$/.test(s)) return Number(s) * 1000
  const at = Date.parse(s)
  if (!Number.isFinite(at)) return null
  const base = Number.isFinite(now) ? Number(now) : Date.now()
  return Math.max(0, at - base)
}

function redactBody(text) {
  const firstLine = String(text || '').split(/\r?\n/)[0].trim()
  const trimmed = firstLine.length > 200 ? firstLine.slice(0, 200) + '…' : firstLine
  // 兜底：绝不把疑似凭据片段带出（sk-/Bearer/eyJ...）。
  return trimmed.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***').replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer ***').replace(/eyJ[A-Za-z0-9._-]{8,}/g, '***')
}

// 流式终止判定：EOF 不能冒充成功；工具/正文已出帧后也不能当「未发送」。
export function classifyStreamTerminal(events) {
  let sawFinish = false
  let sawTool = false
  let sawDelta = false
  let sawUsage = false
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || typeof ev !== 'object') continue
    if (ev.finish_reason || ev.type === 'response.completed') sawFinish = true
    if (ev.usage) sawUsage = true
    if (ev.tool_calls || (ev.type === 'response.output_item.added' && ev.item && ev.item.type === 'function_call')) sawTool = true
    if (ev.delta || ev.content) sawDelta = true
  }
  return Object.freeze({
    sawFinish,
    sawTool,
    sawDelta,
    sawUsage,
    emitted: sawTool || sawDelta,
    ok: sawFinish,
    code: sawFinish ? null : 'opencodego_stream_incomplete',
  })
}
