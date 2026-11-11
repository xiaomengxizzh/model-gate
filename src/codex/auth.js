// E1 / D1-A：Codex 上游凭据与请求头防火墙。
//
// 三条不可越过的边界（plan §3.1 身份隔离 + E0 实测头集合）：
//  1. 第三方目标绝不接收官方专用头（authorization / chatgpt-account-id / openai-beta / version /
//     originator / session-id / thread-id / x-codex-* / x-openai-internal-* / x-client-request-id）。
//  2. 官方目标只放行白名单头；客户端官方凭据仅在显式开启透传时转发（默认关闭 = fail-closed）。
//  3. extraHeaders（配置层）不得覆盖/注入鉴权头——那是 E0 确认的越权面。
//
// 本模块只做**决策**（返回要转发的头 / 拒绝原因），不发请求、不记头值；日志只允许头名。

import { hostOf, isOfficialHost } from './identity.js'

export const PASSTHROUGH_ENV = 'MG_CODEX_OFFICIAL_PASSTHROUGH'
// 官方端点允许的路径前缀：OpenAI API（/v1/...）与 ChatGPT 后端的 Codex 路径。
export const OFFICIAL_PATH_PREFIXES = Object.freeze(['/v1/', '/v1', '/backend-api/codex'])

// 凭据类：任何身份域都不得由 extraHeaders 注入/覆盖，第三方域也必须剥掉客户端带来的。
export const CREDENTIAL_HEADERS = Object.freeze([
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie',
  'x-api-key', 'api-key', 'x-goog-api-key', 'chatgpt-account-id',
])

// Codex 官方路径专用头（官方域保留，第三方域必须消失）。
export const OFFICIAL_ONLY_HEADERS = Object.freeze([
  'authorization', 'chatgpt-account-id', 'openai-beta', 'version', 'originator',
  'session-id', 'thread-id', 'x-client-request-id',
])
// 前缀规则：chatgpt-*、openai-*、x-codex-*、x-openai-*（含 x-openai-internal-codex-responses-lite）。
export const OFFICIAL_ONLY_PREFIXES = Object.freeze(['chatgpt-', 'openai-', 'x-codex-', 'x-openai-'])
// WebSocket/帧层头：网关不做协议升级，任何身份域都不转发。
export const WS_PREFIX = 'sec-websocket-'
const FRAME_HEADERS = Object.freeze([
  'host', 'connection', 'content-length', 'transfer-encoding', 'upgrade',
  'keep-alive', 'te', 'trailer', 'proxy-connection',
])

// 官方目标放行白名单（名字 + 前缀）。默认值即 E0/Lead 实测头集合的超集。
export const OFFICIAL_HEADER_ALLOWLIST = Object.freeze([
  'accept', 'accept-encoding', 'accept-language', 'content-type', 'user-agent',
  'originator', 'version', 'session-id', 'thread-id', 'x-client-request-id',
  'openai-beta', 'chatgpt-account-id', 'authorization',
])
export const OFFICIAL_HEADER_ALLOW_PREFIXES = Object.freeze(['x-codex-', 'x-openai-internal-', 'openai-'])

// E3 集成接口：官方透传代理可消费的头名清单。与 planTargetHeaders 使用**同一组常量**，
// 不另存一份列表（避免清单漂移）。前缀项用于 x-codex-* / x-openai-internal-* / openai-* 家族。
export const OFFICIAL_REQUEST_HEADER_NAMES = OFFICIAL_HEADER_ALLOWLIST
export const OFFICIAL_REQUEST_HEADER_PREFIXES = OFFICIAL_HEADER_ALLOW_PREFIXES

export function isOfficialRequestHeader(name) {
  const n = LOWER(name)
  if (!n) return false
  return OFFICIAL_HEADER_ALLOWLIST.includes(n) || allowlistHas(OFFICIAL_HEADER_ALLOW_PREFIXES, n)
}

// E3 集成接口：基于客户端请求生成官方上游头（供 index.js 官方透传代理直接使用）。
// 契约：只做白名单过滤 + 基础头补齐，**不含** provider.apiKey（透传路径的身份来自客户端官方凭据）。
export function buildOfficialHeaders(req, payloadLen) {
  const incoming = (req && req.headers) || {}
  const plan = planTargetHeaders({ identity: { kind: 'official', credential: 'client-passthrough' }, incoming, provider: {}, passthrough: true })
  const headers = plan.headers
  headers['user-agent'] = 'model-gateway/0.1'
  if (!headers['accept']) headers['accept'] = 'application/json'
  headers['accept-encoding'] = 'identity'
  const len = Number(payloadLen)
  if (Number.isFinite(len) && len > 0) headers['content-length'] = len
  return headers
}

const LOWER = (v) => String(v == null ? '' : v).trim().toLowerCase()

function allowlistHas(list, name) { return list.some((p) => name.startsWith(p)) }

// 客户端官方凭据透传：默认关闭，只有显式 MG_CODEX_OFFICIAL_PASSTHROUGH=1|true|on 才开。
export function officialPassthroughEnabled(env) {
  const src = env || (typeof process !== 'undefined' ? process.env : {}) || {}
  const v = LOWER(src[PASSTHROUGH_ENV])
  return v === '1' || v === 'true' || v === 'on'
}

function dropByPolicy(name) {
  return FRAME_HEADERS.includes(name) || name.startsWith(WS_PREFIX)
}

// 计算要发往上游的头集合。
//   identity: classifyTarget() 结果
//   passthrough: 本次是否透传客户端官方凭据（仅 official + client-passthrough + 开关开启）
// 返回 { headers, dropped }；dropped 只含头名，供脱敏审计。
export function planTargetHeaders(opts) {
  const o = opts || {}
  const identity = o.identity || { kind: 'unknown' }
  const provider = o.provider || {}
  const def = provider._def || provider
  const incoming = o.incoming || {}
  const passthrough = !!o.passthrough
  const headers = {}
  const dropped = []

  if (identity.kind === 'official') {
    for (const [k, v] of Object.entries(incoming)) {
      const name = LOWER(k)
      if (!name) continue
      if (dropByPolicy(name)) { dropped.push(name); continue }
      const allowed = OFFICIAL_HEADER_ALLOWLIST.includes(name) || allowlistHas(OFFICIAL_HEADER_ALLOW_PREFIXES, name)
      if (!allowed) { dropped.push(name); continue }
      // 官方域内客户端凭据只在透传开启且本次走客户端身份时才通过。
      if (name === 'authorization' || name === 'chatgpt-account-id') {
        if (!passthrough) { dropped.push(name); continue }
      }
      headers[name] = v
    }
    return { headers, dropped }
  }

  // thirdParty / unknown：先按官方专用集剥，再按 provider 显式 allowlist 有选择地放行非凭据头。
  const reallow = (Array.isArray(def.forwardClientHeaders) ? def.forwardClientHeaders : []).map(LOWER).filter(Boolean)
  for (const [k, v] of Object.entries(incoming)) {
    const name = LOWER(k)
    if (!name) continue
    const officialOnly = OFFICIAL_ONLY_HEADERS.includes(name) || allowlistHas(OFFICIAL_ONLY_PREFIXES, name)
    const credential = CREDENTIAL_HEADERS.includes(name)
    const policyDrop = dropByPolicy(name)
    if (policyDrop || credential || officialOnly) {
      // 只有「非凭据、非帧层」的官方专用头允许被 provider.forwardClientHeaders 显式放回。
      if (!policyDrop && !credential && reallow.includes(name)) { headers[name] = v; continue }
      dropped.push(name)
      continue
    }
    headers[name] = v
  }
  return { headers, dropped }
}

// extraHeaders 合并守卫：凭据类与帧层头一律忽略（只回传被拦头名，便于审计日志）。
export function applyExtraHeaders(headers, extra) {
  const blocked = []
  for (const [k, v] of Object.entries(extra || {})) {
    const name = LOWER(k)
    if (!name) continue
    if (CREDENTIAL_HEADERS.includes(name) || dropByPolicy(name)) { blocked.push(name); continue }
    headers[name] = v
  }
  return { blocked }
}

function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
}

function safePathname(pathPrefix, path) {
  const joined = String(pathPrefix || '') + String(path || '')
  const cut = joined.split('#')[0].split('?')[0]
  return cut.startsWith('/') ? cut : '/' + cut
}

// 目标是否允许被使用。返回 null = 允许；否则返回 { status, code, message }（消息内绝不含头值）。
//   env 仅用于读取官方透传开关；不得把 env 之外的运行时状态塞进判定。
export function targetDeny(opts) {
  const o = opts || {}
  const identity = o.identity || { kind: 'unknown' }
  const provider = o.provider || {}
  const def = provider._def || provider
  const cfg = o.cfg || {}
  const deny = (code, message) => ({ status: 403, code, message })

  if (identity.kind === 'unknown') {
    return deny('target_identity_unknown', '上游目标身份无法确认（' + (identity.reason || 'unknown') + '），已按 fail-closed 拒绝：' + (provider.id || '?') + '。请检查 baseUrl 与 codexIdentity 声明是否一致。')
  }
  if (identity.kind !== 'official') return null

  const host = identity.host || hostOf(def.baseUrl)
  if (!isOfficialHost(host, cfg)) {
    return deny('official_host_not_allowlisted', '官方目标主机不在白名单：' + (host || '?') + '（defaults.codexOfficialHosts 可显式扩白名单）。')
  }
  const scheme = identity.scheme || ''
  if (scheme !== 'https:' && !isLoopbackHost(host)) {
    return deny('official_target_insecure_scheme', '官方目标必须走 https：' + host + '（当前 ' + (scheme || 'unknown') + '）。')
  }
  const pathname = safePathname(def.pathPrefix, o.path)
  if (!OFFICIAL_PATH_PREFIXES.some((p) => pathname === p || pathname.startsWith(p.endsWith('/') ? p : p + '/'))) {
    return deny('official_path_not_allowlisted', '官方目标路径不在白名单：' + pathname + '（允许 ' + OFFICIAL_PATH_PREFIXES.join(', ') + '）。')
  }
  if (identity.credential === 'client-passthrough' && !officialPassthroughEnabled(o.env)) {
    return deny('official_passthrough_disabled', '官方目标无网关自有 key，且客户端官方凭据透传未开启（默认关闭，需显式设置 ' + PASSTHROUGH_ENV + '=1）。')
  }
  return null
}
