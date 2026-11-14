// E1 / D1-A：Codex 上游凭据与请求头防火墙。
//
// 三条不可越过的边界（plan §3.1 身份隔离 + E0 实测头集合）：
//  1. 第三方目标绝不接收官方专用头（authorization / chatgpt-account-id / openai-beta / version /
//     originator / session-id / thread-id / x-codex-* / x-openai-internal-* / x-client-request-id）。
//  2. 官方目标只放行白名单头，凭据**只来自网关自持 key**：客户端带来的 authorization /
//     chatgpt-account-id 一律丢弃（F01 已移除客户端官方凭据透传与 /backend-api/codex 模板）。
//  3. extraHeaders（配置层）不得覆盖/注入鉴权头——那是 E0 确认的越权面。
//
// 本模块只做**决策**（返回要转发的头 / 拒绝原因），不发请求、不记头值；日志只允许头名。

import { hostOf, isOfficialHost, isLoopbackHost } from './identity.js'

// F01：官方原生凭据透传（客户端 OAuth / chatgpt-account-id → chatgpt.com/backend-api/codex）
// 已从生产路径移除。旧开关只用于**识别旧配置并显式拒绝/提示迁移**，不再启用任何能力。
export const LEGACY_PASSTHROUGH_ENV = 'MG_CODEX_OFFICIAL_PASSTHROUGH'
// 兼容旧 import 名：语义已变为「已退役的旧开关名」。
export const PASSTHROUGH_ENV = LEGACY_PASSTHROUGH_ENV
// 官方端点允许的路径前缀：只保留 OpenAI API 直连（/v1/...）。
// /backend-api/codex（ChatGPT 订阅后端）已随凭据透传一并移除——见 F01。
export const OFFICIAL_PATH_PREFIXES = Object.freeze(['/v1/', '/v1'])

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

// 官方目标放行白名单（名字 + 前缀）。默认值即 E0/Lead 实测头集合去掉凭据类后的超集。
// F01：authorization / chatgpt-account-id 不在白名单内——官方 Authorization 只能由网关按自有 key
// 注入（forward.js / target-authz.js），任何客户端凭据都没有入口。
export const OFFICIAL_HEADER_ALLOWLIST = Object.freeze([
  'accept', 'accept-encoding', 'accept-language', 'content-type', 'user-agent',
  'originator', 'version', 'session-id', 'thread-id', 'x-client-request-id',
  'openai-beta',
])
export const OFFICIAL_HEADER_ALLOW_PREFIXES = Object.freeze(['x-codex-', 'x-openai-internal-', 'openai-'])

// 订阅身份专用头（AGG-P02）：ChatGPT 订阅凭据（本机 Codex 登录 / SIWC 应用授权）只能发给
// codex-subscription 入口。任何第三方或 API Key 目标出现这些头名即视为凭据串域。
// 名称清单与 OFFICIAL_ONLY_HEADERS 同源，不另存一份身份判定。
export const SUBSCRIPTION_IDENTITY_HEADERS = Object.freeze(['chatgpt-account-id'])
export const SUBSCRIPTION_IDENTITY_PREFIXES = Object.freeze(['chatgpt-'])

export function isSubscriptionIdentityHeader(name) {
  const n = LOWER(name)
  if (!n) return false
  return SUBSCRIPTION_IDENTITY_HEADERS.includes(n) || SUBSCRIPTION_IDENTITY_PREFIXES.some((p) => n.startsWith(p))
}

// E3 集成接口：官方直连路径可消费的头名清单。与 planTargetHeaders 使用**同一组常量**，
// 不另存一份列表（避免清单漂移）。前缀项用于 x-codex-* / x-openai-internal-* / openai-* 家族。
export const OFFICIAL_REQUEST_HEADER_NAMES = OFFICIAL_HEADER_ALLOWLIST
export const OFFICIAL_REQUEST_HEADER_PREFIXES = OFFICIAL_HEADER_ALLOW_PREFIXES

export function isOfficialRequestHeader(name) {
  const n = LOWER(name)
  if (!n) return false
  return OFFICIAL_HEADER_ALLOWLIST.includes(n) || allowlistHas(OFFICIAL_HEADER_ALLOW_PREFIXES, n)
}

// F01：旧模板 buildOfficialHeaders() 已删除。它按「客户端官方凭据透传」生成上游头，
// 而该链路（含 /backend-api/codex 默认路径）已从生产移除；留一个会返回客户端凭据头的函数
// 只会让未来的调用方误用旧能力。需要官方头请走 planTargetHeaders + 网关自有 key。

const LOWER = (v) => String(v == null ? '' : v).trim().toLowerCase()

function allowlistHas(list, name) { return list.some((p) => name.startsWith(p)) }

// 兼容导出：F01 之后**永远返回 false**。客户端官方凭据透传不再可用，不存在「打开」的状态；
// 保留函数名只为不给旧 import 抛错（行为与退役前默认值一致 = fail-closed）。
export function officialPassthroughEnabled() {
  return false
}

// 旧开关是否被显式设置（1/true/on）。仅用于**拒绝 + 迁移提示**，绝不启用任何能力。
export function legacyPassthroughRequested(env) {
  const src = env || (typeof process !== 'undefined' ? process.env : {}) || {}
  const v = LOWER(src[LEGACY_PASSTHROUGH_ENV])
  return v === '1' || v === 'true' || v === 'on'
}

function dropByPolicy(name) {
  return FRAME_HEADERS.includes(name) || name.startsWith(WS_PREFIX)
}

// 计算要发往上游的头集合。
//   identity: classifyTarget() 结果
//   o.passthrough 已退役（F01）：任何值都被忽略，客户端凭据永不进入头集合。
// 返回 { headers, dropped }；dropped 只含头名，供脱敏审计。
export function planTargetHeaders(opts) {
  const o = opts || {}
  const identity = o.identity || { kind: 'unknown' }
  const provider = o.provider || {}
  const def = provider._def || provider
  const incoming = o.incoming || {}
  const headers = {}
  const dropped = []

  if (identity.kind === 'official') {
    for (const [k, v] of Object.entries(incoming)) {
      const name = LOWER(k)
      if (!name) continue
      if (dropByPolicy(name)) { dropped.push(name); continue }
      const allowed = OFFICIAL_HEADER_ALLOWLIST.includes(name) || allowlistHas(OFFICIAL_HEADER_ALLOW_PREFIXES, name)
      if (!allowed) { dropped.push(name); continue }
      // 凭据类即使在白名单误配时也不得从客户端进入（守卫不依赖清单内容）。
      if (CREDENTIAL_HEADERS.includes(name)) { dropped.push(name); continue }
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

function safePathname(pathPrefix, path) {
  const joined = String(pathPrefix || '') + String(path || '')
  const cut = joined.split('#')[0].split('?')[0]
  return cut.startsWith('/') ? cut : '/' + cut
}

// 目标是否允许被使用。返回 null = 允许；否则返回 { status, code, message }（消息内绝不含头值）。
//   env 仅用于识别「旧开关仍存在」并给出迁移提示；不得把 env 之外的运行时状态塞进判定。
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
  // F01：官方目标只认网关自有 key。无 key = 零发送，并给旧配置明确的迁移提示。
  const hasGatewayKey = !!provider.apiKey || identity.credential === 'provider-key'
  if (!hasGatewayKey) {
    if (legacyPassthroughRequested(o.env)) {
      return deny('official_passthrough_retired', '客户端官方凭据透传（MG_CODEX_OFFICIAL_PASSTHROUGH + /backend-api/codex）已移除（F01）：官方目标必须配置网关自有 key。请删除该环境变量并为 provider 配置 apiKeyEnv 或面板 Key。')
    }
    return deny('official_no_gateway_key', '官方目标未配置网关自有 key：F01 起不再透传客户端官方凭据，请配置 apiKeyEnv（环境变量/面板 Key）后重试。')
  }
  return null
}
