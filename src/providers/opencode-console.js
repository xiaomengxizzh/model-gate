// A2 / P01：OpenCode Console Provider 适配（纯模块：不发请求、不读文件、不写日志）。
//
// 与 `src/providers/opencode-go.js` 同一套纪律：
//   1. **入口绑定**：baseUrl + pathPrefix 必须命中已登记位形，未知位形一律 fail-closed，
//      绝不放宽到“猜测路径”。
//   2. **位形是假设，不是事实**：本模块不知道 OpenCode Console 的真实模型清单 / 推理端点形状。
//      登记的 `/console/v1`、`/console/openai/v1`、`/zen/v1` 只是**显式假设**，每条 validate
//      都会带 `console_entry_assumed` 警告；真实使用前必须由所有者批准的 live 探针核对。
//   3. **别名严格映射**：Console 没有默认别名；只有配置显式声明（models / providerModels /
//      alias）或本次发现快照明确列出的上游 ID 才放行，其它一律 typed error。
//   4. **头构造**：本服务 UA + 域派生会话标识（HMAC），绝不转发原始 Codex session-id/thread-id。
//   5. **错误/用量/流终态**：只给稳定 code 与短 message，绝不回显凭据；usage 只认上游实际值。
//
// 证据：能力只来自显式 evidence（source/observedAt/expiresAt），缺席 = unknown，过期 = stale。

import { createHmac, randomUUID } from 'node:crypto'
import { hostOf, isOpencodeGoHost } from '../codex/identity.js'
import { classifyStreamTerminal, parseRetryAfter, usageOf } from './opencode-go.js'

// 公共 ID 的 provider 段固定为 `console`（ADR §3），也是网关 providers 映射里的键。
export const PROVIDER_ID = 'console'
export const KIND = 'opencode-console'
export const ENTRY_SCHEMA = 'modelgate.opencode-console.entry/1'
export const CAPABILITY_SCHEMA = 'modelgate.opencode-console.capabilities/1'
export const MODEL_LIST_SCHEMA = 'modelgate.opencode-console.models/1'
export const SERVICE_UA = 'model-gateway/0.1'
export const SESSION_HEADER = 'x-opencode-session'
export const CONSOLE_EFFORTS = Object.freeze(['low', 'medium', 'high', 'max'])
export const CONSOLE_API_VERSIONS = Object.freeze(['console-v1'])
const SESSION_VALUE_LEN = 32

// 位形假设（未复核厂商文档）：每个 binding 一个 modelsPath。`assumed:true` 是显式标记，
// 不是注释装饰——discovery 会把它写进每条诊断。
export const ENTRIES = Object.freeze({
  CONSOLE_CHAT: Object.freeze({ kind: 'chat', binding: 'console-v1', path: '/console/v1/chat/completions', assumed: true, listed: true }),
  CONSOLE_RESPONSES: Object.freeze({ kind: 'responses', binding: 'console-v1', path: '/console/v1/responses', assumed: true, listed: true }),
  CONSOLE_OPENAI_CHAT: Object.freeze({ kind: 'chat', binding: 'console-openai-v1', path: '/console/openai/v1/chat/completions', assumed: true, listed: true }),
  CONSOLE_OPENAI_RESPONSES: Object.freeze({ kind: 'responses', binding: 'console-openai-v1', path: '/console/openai/v1/responses', assumed: true, listed: true }),
  ZEN_CHAT: Object.freeze({ kind: 'chat', binding: 'zen-v1', path: '/zen/v1/chat/completions', assumed: true, listed: true }),
  ZEN_RESPONSES: Object.freeze({ kind: 'responses', binding: 'zen-v1', path: '/zen/v1/responses', assumed: true, listed: true }),
})

const lower = (v) => String(v == null ? '' : v).trim().toLowerCase()
const normalizeUrl = (v) => String(v == null ? '' : v).trim().replace(/\/+$/, '')

// baseUrl (+ pathPrefix, + 显式 consoleEntry) → { ok, entry, host, url, source }。
export function entryOf(def) {
  const d = def || {}
  const base = normalizeUrl(d.baseUrl)
  const host = hostOf(base)
  if (!base) return { ok: false, code: 'opencodeconsole_base_url_missing', message: 'provider.baseUrl 缺失，无法确定 Console 入口' }
  const explicit = lower(d.consoleEntry)
  let url = normalizeUrl(base + normalizeUrl(d.pathPrefix))
  const wantKind = explicit === 'chat' || explicit === 'responses' ? explicit : null
  if (explicit && !wantKind) {
    return { ok: false, code: 'opencodeconsole_entry_invalid', message: 'consoleEntry 只接受 chat/responses：' + String(d.consoleEntry), host, url }
  }
  // 1) 完整端点
  for (const entry of Object.values(ENTRIES)) {
    if (entry.kind !== (wantKind || entry.kind)) continue
    if (url.endsWith(entry.path)) {
      return { ok: true, entry, host, url, source: 'baseUrl' }
    }
  }
  // 2) 只到入口目录：chat 为默认，标 ambiguous（真实协议由 provider.api 决定）。
  const dirs = [
    { suffix: '/console/openai/v1', binding: 'console-openai-v1' },
    { suffix: '/console/v1', binding: 'console-v1' },
    { suffix: '/zen/v1', binding: 'zen-v1' },
    { suffix: '/console', binding: 'console-v1', root: true },
    { suffix: '/zen', binding: 'zen-v1', root: true },
  ]
  for (const dir of dirs) {
    if (!url.endsWith(dir.suffix)) continue
    const entry = dir.binding === 'console-v1'
      ? ENTRIES.CONSOLE_CHAT
      : (dir.binding === 'console-openai-v1' ? ENTRIES.CONSOLE_OPENAI_CHAT : ENTRIES.ZEN_CHAT)
    if (wantKind === 'responses') {
      const responses = dir.binding === 'console-v1'
        ? ENTRIES.CONSOLE_RESPONSES
        : (dir.binding === 'console-openai-v1' ? ENTRIES.CONSOLE_OPENAI_RESPONSES : ENTRIES.ZEN_RESPONSES)
      return { ok: true, entry: responses, host, url, source: 'baseUrl', ambiguous: true, root: !!dir.root }
    }
    return { ok: true, entry, host, url, source: 'baseUrl', ambiguous: true, root: !!dir.root }
  }
  return {
    ok: false,
    code: 'opencodeconsole_entry_unknown',
    message: 'baseUrl 不是已登记的 Console 入口（假设位形：/console/v1、/console/openai/v1、/zen/v1；真实形状待 live 探针确认）',
    host,
    url,
  }
}

// 实测定论（2026-11-14，所有者批准的只读探针）：
//   - `https://opencode.ai/zen/v1/models` → 200 application/json（真实清单）
//   - `https://opencode.ai/console/v1/models`、`https://opencode.ai/console/openai/v1/models`
//     → **200 text/html**（网页 SPA，不是 API）：按入口推导会得到一个“看起来成功”的 HTML 页面。
// 因此 Console 的默认清单端点固定为 zen；只有操作者显式配置 modelListUrl，或目标是回环/自定义
// 已登记 host（隔离测试）时，才按入口推导。
export const DEFAULT_MODEL_LIST_URL = 'https://opencode.ai/zen/v1/models'

// 模型清单 URL：显式 modelListUrl 优先；opencode.ai 上默认走实测的 zen 端点；
// 回环/自定义 host 仍按入口推导（否则隔离测试无法指向本地假上游）。
export function resolveListUrl(def) {
  const d = def || {}
  if (d.modelListUrl != null && d.modelListUrl !== '') {
    const host = hostOf(d.modelListUrl)
    const allowed = isOpencodeGoHost(host, d._cfg || {}) ||
      (d.allowLoopback === true && (host === '127.0.0.1' || host === 'localhost' || host === '::1'))
    if (!allowed) {
      return { ok: false, code: 'opencodeconsole_list_host_not_allowlisted', message: 'modelListUrl host 不在白名单：' + String(host || '?'), host }
    }
    return { ok: true, url: String(d.modelListUrl), host, assumed: true, basis: 'explicit_modelListUrl' }
  }
  const entry = entryOf(d)
  if (entry.ok && entry.host !== 'opencode.ai') {
    const root = entry.entry.root ? entry.url + '/v1' : entry.url.replace(/\/(chat\/completions|responses)$/, '')
    return { ok: true, url: root + '/models', host: entry.host, assumed: true, basis: 'console_entry_assumption', entry: entry.entry }
  }
  return {
    ok: true,
    url: DEFAULT_MODEL_LIST_URL,
    host: hostOf(DEFAULT_MODEL_LIST_URL),
    assumed: true,
    basis: 'console_default_model_list',
    entry: entry.ok ? entry.entry : null,
    warning: 'Console 清单端点已实测为 ' + DEFAULT_MODEL_LIST_URL + '（2026-11-14 live 探针）；按入口推导的 /console/v1/models 返回 HTML',
  }
}

// 版本/授权校验。opts: { cfg, grant, model, allowLoopback, now }
export function validate(def, opts = {}) {
  const d = def || {}
  const entry = entryOf(d)
  if (!entry.ok) return { ok: false, code: entry.code, message: entry.message, entry, warnings: [] }
  const warnings = [{
    code: 'console_entry_assumed',
    message: 'Console 入口形状是显式假设（' + entry.entry.binding + '）：未复核厂商文档，live 前必须用所有者批准的探针确认',
  }]
  const host = entry.host
  const hostAllowed = isOpencodeGoHost(host, opts.cfg) ||
    (opts.allowLoopback === true && (host === '127.0.0.1' || host === 'localhost' || host === '::1'))
  if (!hostAllowed) {
    return { ok: false, code: 'opencodeconsole_host_not_allowlisted', message: 'Console 入口 host 不在白名单：' + String(host || '?'), entry, warnings }
  }
  const api = d.api === undefined || d.api === '' ? 'openai' : String(d.api)
  if (api !== 'openai' && api !== 'responses') {
    return { ok: false, code: 'opencodeconsole_api_unsupported', message: 'Console provider.api 只能是 openai/responses：' + api, entry, warnings }
  }
  if (entry.ambiguous) {
    warnings.push({ code: 'entry_shape_ambiguous', message: '入口只到目录（' + entry.url + '）：chat/responses 未显式区分' })
  }
  const version = d.consoleApiVersion == null || d.consoleApiVersion === '' ? 'unversioned' : String(d.consoleApiVersion)
  if (!CONSOLE_API_VERSIONS.includes(version)) {
    if (version === 'unversioned') warnings.push({ code: 'entry_version_unversioned', message: '未声明 consoleApiVersion；按已识别入口继续，但版本证据缺失' })
    else return { ok: false, code: 'opencodeconsole_version_unsupported', message: '不支持的 Console 入口版本：' + version + '（已证明：' + CONSOLE_API_VERSIONS.join(', ') + '）', entry, warnings }
  }
  const grant = opts.grant || null
  const hasCredential = !!(grant && grant.hasCredential === true) ||
    !!(grant && typeof grant.keyRef === 'string' && grant.keyRef && grant.keyRef !== 'none') ||
    typeof d.apiKey === 'string' && d.apiKey.length > 0 ||
    typeof d.apiKeyEnv === 'string' && d.apiKeyEnv.length > 0
  if (!hasCredential) warnings.push({ code: 'credential_unresolved', message: '未看到 Console 凭据引用；实际发送会按无凭据处理（不继承任何客户端/官方凭据）' })
  const mapped = opts.model === undefined ? null : mapModel(opts.cfg, opts.model, opts)
  if (mapped && mapped.ok === false) {
    return { ok: false, code: mapped.code, message: mapped.message, entry, warnings }
  }
  return { ok: true, code: null, entry, version, host, hasCredential, model: mapped ? mapped.vendorModel : null, warnings }
}

function findModel(models, name) {
  for (const [entryName, entry] of Object.entries(models || {})) {
    if (!entry || typeof entry !== 'object') continue
    if (entryName === name) return [entryName, entry]
    if (Array.isArray(entry.alias) && entry.alias.includes(name)) return [entryName, entry]
  }
  return null
}

// 公共模型/别名 → 上游真实 ID。严格：只有显式声明或本次发现快照列出才认。
// opts: { upstreamIds?: string[] | Set<string>, providerModels?: {console: string} }
export function mapModel(cfg, model, opts = {}) {
  const name = typeof model === 'string' ? model.trim() : ''
  if (!name) return { ok: false, code: 'opencodeconsole_model_missing', message: '缺少模型名' }
  const upstream = opts.upstreamIds
  const upstreamListed = upstream instanceof Set ? upstream.has(name) : (Array.isArray(upstream) ? upstream.includes(name) : false)
  if (upstreamListed) return { ok: true, vendorModel: name, declaration: 'discovered' }
  const models = (cfg && cfg.models) || {}
  const hit = findModel(models, name)
  if (!hit) {
    return {
      ok: false,
      code: 'opencodeconsole_model_unmapped',
      message: '模型 ' + name + ' 未在 config/models 声明，也不在本次发现快照中；拒绝隐式映射',
    }
  }
  const [entryName, entry] = hit
  if (entry.provider !== undefined && entry.provider !== PROVIDER_ID) {
    return { ok: false, code: 'opencodeconsole_model_provider_mismatch', message: '模型 ' + name + ' 属于 provider ' + entry.provider + '，不是 ' + PROVIDER_ID }
  }
  if (entryName === name && Array.isArray(entry.alias) && entry.alias.includes(name) && !entry.providerModels) {
    // 别名指回自身但未声明上游映射：拒绝，避免把别名当上游 ID。
    return { ok: false, code: 'opencodeconsole_alias_undeclared', message: '别名 ' + name + ' 未声明 upstreamModel/providerModels，拒绝隐式映射' }
  }
  const vendor = (entry.providerModels && entry.providerModels[PROVIDER_ID]) || entry.upstreamModel || entryName
  return { ok: true, vendorModel: String(vendor), declaration: 'config', modelName: entryName }
}

// effort 严格映射：只接受已声明档位；未知即错误，不静默掉档。
export function mapEffort(effort, opts = {}) {
  const allowed = Array.isArray(opts.allowed) && opts.allowed.length ? opts.allowed.map(lower) : CONSOLE_EFFORTS.slice()
  const raw = lower(effort)
  if (!raw) return { ok: false, code: 'opencodeconsole_effort_missing', message: '缺少 reasoning effort' }
  const canon = raw === 'off' || raw === 'none' || raw === 'disabled' ? 'none' : raw
  if (!allowed.includes(canon)) {
    return { ok: false, code: 'opencodeconsole_effort_unsupported', message: 'Console 未证实该推理档位：' + canon + '（已证实：' + allowed.join(', ') + '）' }
  }
  return { ok: true, effort: canon }
}

// 能力事实：显式 evidence 才证明；缺席 unknown，过期 stale。与 Go 同构。
export function capabilities(evidence, opts = {}) {
  const now = Number.isFinite(opts.now) ? Number(opts.now) : Date.now()
  const e = evidence && typeof evidence === 'object' ? evidence : null
  const base = {
    schema: CAPABILITY_SCHEMA,
    model: opts.model || null,
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
    const efforts = f.efforts.map(lower).filter((v) => CONSOLE_EFFORTS.includes(v))
    facts.efforts = Object.freeze([...new Set(efforts)])
  }
  return Object.freeze(Object.assign(base, {
    freshness: 'fresh', proven: Object.keys(facts).length > 0, facts: Object.freeze(facts), note: null,
  }))
}

// 头构造：UA + 域派生会话标识（provider=console 参与 HMAC）。绝不复制客户端官方头。
export function newHeaders(opts = {}) {
  const req = opts.req || {}
  const provider = opts.provider || {}
  const cfg = opts.cfg || {}
  const headers = (req.headers && typeof req.headers === 'object') ? req.headers : {}
  const first = (name) => (Array.isArray(headers[name]) ? headers[name][0] : headers[name])
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
    mode = value === threadId ? 'request' : 'derived'
    if (value === threadId) value = 'mg-' + randomUUID()
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
  if (!_ephemeralSalt) _ephemeralSalt = randomUUID()
  return _ephemeralSalt
}

// 请求体整形：只把 body.model 换成上游真实 ID；流式补 include_usage。
export function encode(body, opts = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, code: 'opencodeconsole_body_invalid', message: '请求体必须是对象' }
  }
  const out = Object.assign({}, body)
  const notes = []
  if (opts.vendorModel) {
    if (opts.vendorModel === body.model) notes.push('model=' + opts.vendorModel)
    out.model = opts.vendorModel
  }
  if (out.stream === true && out.stream_options == null) {
    out.stream_options = { include_usage: true }
    notes.push('stream_options.include_usage=true')
  }
  return { ok: true, body: out, notes }
}

// 错误映射：不含上游正文/头值；404 明确表示“入口假设不成立”，不得读成空模型目录。
export function decodeError(status, bodyText, headers, opts = {}) {
  const code = Number(status) || 0
  const text = String(bodyText == null ? '' : bodyText).slice(0, 4000)
  const retryAfterRaw = headers && (headers['retry-after'] || headers['Retry-After'])
  const retryAfterMs = parseRetryAfter(retryAfterRaw, opts.now)
  const lowerText = text.toLowerCase()
  const message = redactBody(text)
  if (code === 401) return { status: code, code: 'opencodeconsole_auth_failed', retryable: false, quota: 'unknown', retryAfterMs, message, nextAction: 'check-provider-credential' }
  if (code === 403) return { status: code, code: 'opencodeconsole_forbidden', retryable: false, quota: 'unknown', retryAfterMs, message, nextAction: 'check-workspace-authorization' }
  if (code === 404) return { status: code, code: 'opencodeconsole_endpoint_not_found', retryable: false, quota: 'unknown', retryAfterMs, message, nextAction: 'verify-console-entry-assumption' }
  if (code === 429) {
    const quotaHint = /quota|usage limit|usage_limit|extra usage|insufficient|balance|额度|套餐/.test(lowerText)
    const shortWindow = retryAfterMs != null && retryAfterMs > 0 && retryAfterMs <= 5 * 60 * 1000
    const quota = quotaHint ? 'exhausted' : (shortWindow ? 'short' : 'unknown')
    return {
      status: code,
      code: quota === 'exhausted' ? 'opencodeconsole_quota_exhausted' : (quota === 'short' ? 'opencodeconsole_rate_limited' : 'opencodeconsole_rate_limited_unknown'),
      retryable: quota === 'short',
      quota,
      retryAfterMs,
      message,
      nextAction: quota === 'exhausted' ? 'check-official-usage' : (quota === 'short' ? 'retry-after' : 'inspect-round-robin'),
    }
  }
  if (code === 402) return { status: code, code: 'opencodeconsole_payment_required', retryable: false, quota: 'exhausted', retryAfterMs, message, nextAction: 'check-official-usage' }
  if (code >= 500) return { status: code, code: 'opencodeconsole_upstream_error', retryable: true, quota: 'unknown', retryAfterMs, message, nextAction: 'retry-with-deadline' }
  if (code === 400) return { status: code, code: 'opencodeconsole_bad_request', retryable: false, quota: 'unknown', retryAfterMs, message, nextAction: 'fix-request' }
  return { status: code, code: 'opencodeconsole_error', retryable: false, quota: 'unknown', retryAfterMs, message, nextAction: 'inspect' }
}

function redactBody(text) {
  const firstLine = String(text || '').split(/\r?\n/)[0].trim()
  const trimmed = firstLine.length > 200 ? firstLine.slice(0, 200) + '…' : firstLine
  return trimmed
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer ***')
    .replace(/eyJ[A-Za-z0-9._-]{8,}/g, '***')
}

export { classifyStreamTerminal, parseRetryAfter, usageOf }
