// M2-1 / P0-3：码克斯聚合的「最终目标授权」纯模块（不发请求、不读全局、不接线）。
//
// 背景（审计 P0-3）：官方分支在**拼装 URL 之前**用 identity.host + path 判定，而实际发送由
// src/request.js 的 upstreamUrl() 另行拼装（baseUrl + pathPrefix + path，含 /v1 去重容错）。
// 于是「授权对象」与「实际发送对象」可能不一致：baseUrl 末尾的 @evil.test、pathPrefix 注入、
// /v1 双重前缀、query 漂移等都能让发送目标越过授权判定。
//
// 本模块的唯一职责：把「最终要发送的绝对 URL」在**一次规范化**后固化成不可变授权记录，
// 并提供 assertSendTarget(authz, urlUsed) 让接线卡在真正发送前做第二次校验。接线后调用链是：
//   authorizeFinalTarget(intent, catalogGeneration, binding) -> authz（冻结）
//   assertSendTarget(authz, upstreamUrl(provider, path))     -> 不一致即 typed deny
//
// 三条边界（与 plan §3.1 / §4 对齐）：
//   1. 身份域（official / thirdParty）与凭据模式（provider-key / official-subscription / none）
//      是两件独立的事：官方 host 不等于可以拿订阅身份去计费端点，也不等于第三方可以继承官方头。
//   2. 第三方头从**空白**构造，只加本域 HMAC 派生的会话标识；官方 authorization / 账号 id /
//      原 thread id 一律不得出现。
//   3. 未知身份、未经验证的目标、baseUrl 与实际 host 不一致、目录 generation 不匹配：全部零发送。
//
// 本模块不写日志、不抛含头值/密钥的消息；deny 只带 host/路径/拒绝码。

import { createHmac } from 'node:crypto'
import { classifyTarget, isLoopbackHost, isOfficialHost, IDENTITY_KINDS } from './identity.js'
import {
  CREDENTIAL_HEADERS, OFFICIAL_ONLY_HEADERS, OFFICIAL_ONLY_PREFIXES,
  OFFICIAL_PATH_PREFIXES, planTargetHeaders, legacyPassthroughRequested,
} from './auth.js'

export const TARGET_DOMAINS = Object.freeze({ OFFICIAL: 'official', THIRD_PARTY: 'thirdParty' })
// F01：OFFICIAL_SUBSCRIPTION（客户端官方订阅凭据 / 订阅后端路径）已退役。
// 常量保留只为把旧调用方识别出来并给出 typed deny（credential_mode_retired），绝不回落到可用状态。
// G1（2026-11-13）：GATEWAY_SUBSCRIPTION（网关读本机 Codex 登录态并代理订阅后端）已退役，
// 不再保留为可用模式。旧调用方传 gatewaySubscription=true 或 credentialMode='gateway-subscription'
// 时，由 credentialModeAllowed/officialIngressPolicy 给出 gateway_subscription_retired typed deny。
export const CREDENTIAL_MODES = Object.freeze({
  PROVIDER_KEY: 'provider-key',
  OFFICIAL_SUBSCRIPTION: 'official-subscription',
  NONE: 'none',
})
// 显式不跟随重定向：授权记录里带这个标记，接线卡必须把它映射到请求选项（redirect: 'error'）。
export const REDIRECT_POLICY = 'error'
export const DEFAULT_SESSION_SALT = 'mg-codex-session-v1'
const SESSION_VALUE_LEN = 32

// typed deny：status/code/message 可直接映射成 403 错误体；消息永不含头值或 key。
export class TargetAuthzError extends Error {
  constructor(code, message, extra) {
    super(message)
    this.name = 'TargetAuthzError'
    this.code = code
    this.status = 403
    this.deny = true
    if (extra) Object.assign(this, extra)
  }
}

function deny(code, message, extra) {
  return new TargetAuthzError(code, message, extra)
}

export function isTargetAuthzError(err) {
  return !!(err && err.deny === true && typeof err.code === 'string')
}

// —— 一步规范化 ——
// 与 src/request.js upstreamUrl() 完全同构（baseUrl 尾斜杠、/v1 双拼去重、URL 构造的大小写/
// 默认端口/百分号规范化），然后固化成不可变快照。禁止 userinfo 与 fragment（发送时不会出现，
// 出现即视为漂移/注入）。只允许 http(s)。
export function canonicalizeUrlOnce(origin, path, pathPrefix) {
  const raw = String(origin == null ? '' : origin).trim()
  if (!raw) throw deny('canonicalize_failed', '缺少上游 origin/baseUrl')
  // M1-3c：baseUrl 只允许纯 origin+path；查询串/fragment 会改变授权对象与发送对象的一致性含义。
  if (raw.includes('?')) throw deny('target_query_not_allowed', 'baseUrl 不得包含查询串（请放到 path 或配置的 pathPrefix 之外）')
  if (raw.includes('#')) throw deny('target_fragment_not_allowed', 'baseUrl 不得包含 fragment')
  let base = raw.replace(/\/+$/, '')
  const p = String(path == null ? '' : path)
  if (p.charAt(0) !== '/') throw deny('canonicalize_failed', '上游路径必须以 / 开头')
  if (p.startsWith('/v1/') && base.endsWith('/v1')) base = base.slice(0, -3)
  const prefix = pathPrefix == null ? '' : String(pathPrefix)
  // M1-3c：pathPrefix 必须是干净的绝对路径段（禁止查询/fragment/穿越/协议相对 URL/双拼）。
  if (prefix) {
    if (prefix.includes('?')) throw deny('target_query_not_allowed', 'pathPrefix 不得包含查询串')
    if (prefix.includes('#')) throw deny('target_fragment_not_allowed', 'pathPrefix 不得包含 fragment')
    // 保留既有的安全细分：@ / . 开头的前缀会让 URL 拼装产生 userinfo 或 host 后缀，
    // 交由后面的 userinfo / declared-host 校验给出更精确的拒绝码；其它非 / 开头一律 canonicalize_failed。
    if (!prefix.startsWith('/') && !prefix.startsWith('@') && !prefix.startsWith('.')) throw deny('canonicalize_failed', 'pathPrefix 必须以 / 开头')
    if (prefix.startsWith('//')) throw deny('target_path_not_allowed', 'pathPrefix 不得以 // 开头（协议相对 URL）')
    if (/(^|\/)\.\.(\/|$)/.test(prefix)) throw deny('target_path_traversal', 'pathPrefix 不得包含 .. 路径穿越段')
    if (p.startsWith(prefix)) throw deny('target_path_duplicated', 'pathPrefix 与请求 path 重复（会造成双拼前缀）')
  }
  let url
  try { url = new URL(base + prefix + p) } catch (e) { throw deny('canonicalize_failed', '上游目标 URL 无法解析') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw deny('target_scheme_not_allowed', '上游目标只允许 http(s)，当前 ' + url.protocol)
  }
  if (url.username || url.password) throw deny('target_userinfo_forbidden', '上游目标不得包含 userinfo（@ 注入）')
  if (url.hash) throw deny('target_fragment_not_allowed', '上游目标不得包含 fragment')
  return freezeTarget(url)
}

function freezeTarget(url) {
  const hostname = url.hostname.toLowerCase()
  const port = url.port
  const host = hostname + (port ? ':' + port : '')
  const origin = url.protocol + '//' + host
  const key = origin + url.pathname + url.search
  return Object.freeze({
    href: url.href,
    protocol: url.protocol,
    scheme: url.protocol.slice(0, -1),
    hostname,
    host,
    port,
    pathname: url.pathname,
    search: url.search,
    origin,
    key,
  })
}

// 实际发送目标 -> 规范化比较键（不再做 /v1 去重或任何拼装；只做 URL 解析的等价规范化）。
export function targetKeyOfUrl(urlUsed) {
  let url
  if (urlUsed instanceof URL) url = urlUsed
  else if (typeof urlUsed === 'string') {
    try { url = new URL(urlUsed) } catch (e) { throw deny('send_target_not_absolute', '实际发送目标不是绝对 URL') }
  } else if (urlUsed && typeof urlUsed.href === 'string') {
    try { url = new URL(urlUsed.href) } catch (e) { throw deny('send_target_not_absolute', '实际发送目标不是绝对 URL') }
  } else {
    throw deny('send_target_not_absolute', '实际发送目标不是绝对 URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw deny('send_target_scheme_not_allowed', '实际发送目标协议不合法')
  if (url.username || url.password) throw deny('send_target_userinfo_forbidden', '实际发送目标含 userinfo')
  if (url.hash) throw deny('send_target_fragment_forbidden', '实际发送目标含 fragment')
  return freezeTarget(url).key
}

// 拼装后二次校验：只比较 scheme+host+port+pathname+query。
// 大小写 host / 显式默认端口经 URL 解析后等价，按“同一次规范化”放行（否则会误杀 upstreamUrl()
// 的合法输出）；host、port、path、query、scheme 任何实际改变都拒绝。
export function assertSendTarget(authz, urlUsed) {
  if (!authz || authz.ok !== true || typeof authz.targetKey !== 'string' || !authz.target) {
    throw deny('authz_record_invalid', '授权记录无效（必须是 authorizeFinalTarget 的产物）')
  }
  if (authz.redirect !== REDIRECT_POLICY) throw deny('redirect_policy_missing', '授权记录缺少禁重定向标记')
  const actualKey = targetKeyOfUrl(urlUsed)
  if (actualKey !== authz.targetKey) {
    throw deny('send_target_drift', '实际发送目标与授权目标不一致，已拒绝发送（authorized=' + authz.target.origin + authz.target.pathname + ' actual=' + actualKey.split('?')[0] + '）', {
      expected: authz.target.origin + authz.target.pathname,
      actual: actualKey.split('?')[0],
    })
  }
  return authz
}

// —— scheme / host / port / path 白名单 ——
function officialPathnameAllowed(pathname) {
  return OFFICIAL_PATH_PREFIXES.some((p) => pathname === p || pathname.startsWith(p.endsWith('/') ? p : p + '/'))
}

export function allowedSchemeHostPortPath(target, domain, opts) {
  const o = opts || {}
  if (domain !== TARGET_DOMAINS.OFFICIAL && domain !== TARGET_DOMAINS.THIRD_PARTY) {
    return deny('intent_domain_invalid', '未知身份域：' + String(domain))
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return deny('target_scheme_not_allowed', '上游目标只允许 http(s)，当前 ' + target.protocol)
  }
  if (domain === TARGET_DOMAINS.THIRD_PARTY) return null
  if (target.protocol !== 'https:' && !isLoopbackHost(target.hostname)) {
    return deny('official_target_insecure_scheme', '官方目标必须走 https：' + target.hostname + '（当前 ' + target.protocol + '）。')
  }
  if (!isOfficialHost(target.hostname, o.cfg || {})) {
    return deny('official_host_not_allowlisted', '官方目标主机不在白名单：' + target.hostname + '（defaults.codexOfficialHosts 可显式扩白名单）。')
  }
  if (target.port && !isLoopbackHost(target.hostname)) {
    return deny('official_port_not_allowlisted', '官方目标只允许默认端口：' + target.host + '（本机回环可用自定义端口）。')
  }
  // G1：订阅后端入口已随本机登录态代理一并退役，官方目标只剩 /v1。
  if (!officialPathnameAllowed(target.pathname)) {
    return deny('official_path_not_allowlisted', '官方目标路径不在白名单：' + target.pathname + '（允许 ' + OFFICIAL_PATH_PREFIXES.join(', ') + '）')
  }
  return null
}

// —— 域与凭据分离 ——
// provider-key   = 网关自持 API Key（唯一可用凭据，官方/第三方同规则）
// official-subscription = 已退役（F01）：任何声明都返回 credential_mode_retired + 迁移提示
// none           = 无凭据（第三方宁可 401，官方必须 fail-closed）
const RETIRED_CREDENTIAL_HINT = '客户端官方订阅凭据透传（official-subscription / MG_CODEX_OFFICIAL_PASSTHROUGH / 订阅后端入口）已移除（F01）：请为官方目标配置网关自有 key（apiKeyEnv 或面板 Key）。'
// G1：gatewaySubscription 退役码与迁移提示。消息只描述迁移动作，不暗示任何读取本机登录态的能力仍可用。
// 导出给请求入口（index.js）与转发链（forward.js）复用，避免同一稳定错误码出现多份字面量。
export const GATEWAY_SUBSCRIPTION_RETIRED_CODE = 'gateway_subscription_retired'
export const GATEWAY_SUBSCRIPTION_RETIRED_MESSAGE = 'gatewaySubscription（本机 Codex 登录态反向代理）已于 2026-11-13 退役（G1）：网关不再读取 Codex 登录态，也不会向订阅后端发送本机 token。请为官方目标配置网关自有 key（apiKeyEnv 或面板 Key）。'
const GATEWAY_SUBSCRIPTION_HINT = GATEWAY_SUBSCRIPTION_RETIRED_MESSAGE
export function credentialModeAllowed(domain, target, callerScope) {
  const s = callerScope || {}
  const mode = s.credentialMode
  // 旧字段显式拒绝：即使调用方仍传 officialSubscription/passthroughEnabled，也绝不回落到可用状态。
  if (s.officialSubscription === true || s.passthroughEnabled === true) {
    return deny('official_passthrough_retired', RETIRED_CREDENTIAL_HINT)
  }
  if (mode === CREDENTIAL_MODES.OFFICIAL_SUBSCRIPTION) {
    return deny('credential_mode_retired', RETIRED_CREDENTIAL_HINT)
  }
  // G1：旧模式/旧开关一律 typed retired，绝不回落到 provider-key 或 none 的可用状态。
  if (mode === 'gateway-subscription' || s.gatewaySubscription === true) {
    return deny(GATEWAY_SUBSCRIPTION_RETIRED_CODE, GATEWAY_SUBSCRIPTION_HINT)
  }
  if (![CREDENTIAL_MODES.PROVIDER_KEY, CREDENTIAL_MODES.NONE].includes(mode)) {
    return deny('credential_mode_invalid', '凭据模式不合法：' + String(mode))
  }
  const hasKey = s.hasProviderKey === true || (typeof s.providerKey === 'string' && s.providerKey.length > 0)
  if (domain === TARGET_DOMAINS.THIRD_PARTY) {
    if (mode === CREDENTIAL_MODES.PROVIDER_KEY && !hasKey) {
      return deny('credential_missing', '第三方目标声明使用自有 key，但未提供 key')
    }
    return null
  }
  if (domain !== TARGET_DOMAINS.OFFICIAL) return deny('intent_domain_invalid', '未知身份域：' + String(domain))
  if (mode === CREDENTIAL_MODES.NONE) {
    // 旧开关仍在环境里 → 给迁移提示，而不是含糊的「缺凭据」。
    if (s.legacyPassthrough === true) return deny('official_passthrough_retired', RETIRED_CREDENTIAL_HINT)
    return deny('official_credential_missing', '官方目标必须配置网关自有 key（F01 已移除客户端官方凭据透传）')
  }
  if (!hasKey) return deny('credential_missing', '官方目标声明使用自有 key，但未提供 key')
  return null
}

// 目录世代校验的单一入口：generation 必须与本次命令携带的 catalogGeneration 完全一致，
// 且对应域的 verified 标志必须为 true（来源是目录世代记录，见 catalog-generation.generationAuthzBinding）。
export function assertGenerationBinding(binding, catalogGeneration, domain) {
  const b = binding || {}
  if (catalogGeneration == null || b.generation == null) {
    throw deny('catalog_generation_missing', '缺少目录 generation（授权与目录快照必须绑定）')
  }
  if (b.generation !== catalogGeneration) {
    throw deny('generation_mismatch', '目录 generation 与授权绑定不一致：authz=' + String(catalogGeneration) + ' binding=' + String(b.generation))
  }
  if (domain !== TARGET_DOMAINS.OFFICIAL && domain !== TARGET_DOMAINS.THIRD_PARTY) {
    throw deny('intent_domain_invalid', '未知身份域：' + String(domain))
  }
  if (domain === TARGET_DOMAINS.OFFICIAL) {
    if (b.officialVerified !== true) throw deny('target_not_verified', '官方目标未经目录 generation 校验（officialVerified!=true）')
  } else if (b.thirdPartyVerified !== true) {
    throw deny('target_not_verified', '第三方目标未经目录 generation 校验（thirdPartyVerified!=true）')
  }
  return b
}

export function resolveCredentialMode(domain, identity, callerScope) {
  const s = callerScope || {}
  if (s.credentialMode) return s.credentialMode
  const hasKey = s.hasProviderKey === true || (typeof s.providerKey === 'string' && s.providerKey.length > 0) ||
    !!(identity && identity.credential === 'provider-key')
  if (domain === TARGET_DOMAINS.OFFICIAL) {
    // G1：gatewaySubscription 不再是可解析的凭据模式；残留声明留给 credentialModeAllowed 识别并拒绝。
    if (hasKey) return CREDENTIAL_MODES.PROVIDER_KEY
    // F01：官方无 key 只剩 NONE（fail-closed）；旧订阅声明仍被识别成 OFFICIAL_SUBSCRIPTION，
    // 以便 credentialModeAllowed 给出「已退役」而不是含糊的「缺凭据」。
    if (s.officialSubscription === true || s.passthroughEnabled === true || !!(identity && identity.credential === 'client-passthrough')) return CREDENTIAL_MODES.OFFICIAL_SUBSCRIPTION
    return CREDENTIAL_MODES.NONE
  }
  return hasKey ? CREDENTIAL_MODES.PROVIDER_KEY : CREDENTIAL_MODES.NONE
}

// 官方入口策略（拼装后的最终 URL 上执行）：显式关闭、scheme/host/path、订阅入口三者之一不满足即拒绝。
export function officialIngressPolicy(domain, target, opts) {
  const o = opts || {}
  if (domain !== TARGET_DOMAINS.OFFICIAL) return deny('official_ingress_domain_invalid', '官方入口策略只适用于 official 域')
  if (o.officialIngress === false) return deny('official_ingress_disabled', '官方入口已显式关闭（binding.officialIngress=false）')
  if (target.protocol !== 'https:' && !isLoopbackHost(target.hostname)) {
    return deny('official_target_insecure_scheme', '官方目标必须走 https：' + target.hostname)
  }
  if (!isOfficialHost(target.hostname, o.cfg || {})) {
    return deny('official_host_not_allowlisted', '官方目标主机不在白名单：' + target.hostname)
  }
  // G1：订阅代理退役后，官方入口只允许 /v1；旧模式/旧开关先给 retired，不进入路径判定。
  if (o.credentialMode === 'gateway-subscription' || o.gatewaySubscription === true) {
    return deny(GATEWAY_SUBSCRIPTION_RETIRED_CODE, GATEWAY_SUBSCRIPTION_HINT)
  }
  if (!officialPathnameAllowed(target.pathname)) {
    return deny('official_path_not_allowlisted', '官方目标路径不在白名单：' + target.pathname)
  }
  if (o.credentialMode === CREDENTIAL_MODES.OFFICIAL_SUBSCRIPTION) {
    return deny('credential_mode_retired', RETIRED_CREDENTIAL_HINT)
  }
  return null
}

// —— 第三方域派生会话标识 ——
// 输入只来自客户端线程标识，输出是 HMAC(盐, "scheme://host:port|thread") 的前 32 hex：
//   · 同一供应商、同一线程 → 稳定可重复（便于上游会话亲和）
//   · 不同供应商域 → 完全不同的值，无法跨域关联（断言不同域结果不同且不含原 thread id）
export function deriveSessionIdentity(caller, target) {
  const c = caller || {}
  const header = c.sessionHeader == null ? '' : String(c.sessionHeader).trim().toLowerCase()
  if (!header) return null
  if (!/^[a-z0-9][a-z0-9-]*$/.test(header)) throw deny('session_header_invalid', '会话头名不合法：' + header)
  const source = sourceThreadId(c)
  if (!source) return null
  if (!target || !target.origin) throw deny('session_domain_missing', '派生会话标识缺少目标域')
  const salt = c.sessionSalt == null ? DEFAULT_SESSION_SALT : c.sessionSalt
  if (typeof salt !== 'string' && !Buffer.isBuffer(salt)) throw deny('session_salt_invalid', '会话派生盐必须是字符串或 Buffer')
  if (typeof salt === 'string' && !salt) throw deny('session_salt_invalid', '会话派生盐不得为空')
  const value = createHmac('sha256', salt).update(target.origin + '|' + source).digest('hex').slice(0, SESSION_VALUE_LEN)
  if (value === source) throw deny('session_derivation_failed', '派生会话标识不得等于原线程 id')
  return Object.freeze({ header, value })
}

function sourceThreadId(caller) {
  const c = caller || {}
  if (c.threadId != null && String(c.threadId).trim()) return String(c.threadId).trim()
  const incoming = c.incoming || {}
  for (const name of ['thread-id', 'session-id']) {
    const raw = incoming[name]
    const v = Array.isArray(raw) ? raw[0] : raw
    if (v != null && String(v).trim()) return String(v).trim()
  }
  return ''
}

function assertThirdPartyHeaderSafety(headers) {
  for (const name of Object.keys(headers)) {
    const blocked = CREDENTIAL_HEADERS.includes(name) || OFFICIAL_ONLY_HEADERS.includes(name) ||
      OFFICIAL_ONLY_PREFIXES.some((p) => name.startsWith(p)) || name.startsWith('codex-')
    if (blocked) throw deny('third_party_header_leak', '第三方头集合出现官方/凭据头：' + name)
  }
}

// 第三方：从空白构造，只放域派生会话标识；官方：按白名单复制，凭据按模式注入。
export function buildAllowlistedHeaders(domain, caller, targetCredential) {
  const c = caller || {}
  const cred = targetCredential || {}
  if (domain === TARGET_DOMAINS.THIRD_PARTY) {
    const headers = {}
    const derived = deriveSessionIdentity(c, cred.target)
    if (derived) headers[derived.header] = derived.value
    assertThirdPartyHeaderSafety(headers)
    return headers
  }
  if (domain !== TARGET_DOMAINS.OFFICIAL) throw deny('intent_domain_invalid', '未知身份域：' + String(domain))
  if (cred.mode === CREDENTIAL_MODES.OFFICIAL_SUBSCRIPTION) throw deny('credential_mode_retired', RETIRED_CREDENTIAL_HINT)
  if (cred.mode === 'gateway-subscription') throw deny(GATEWAY_SUBSCRIPTION_RETIRED_CODE, GATEWAY_SUBSCRIPTION_HINT)
  const plan = planTargetHeaders({ identity: { kind: 'official', credential: 'provider-key' }, provider: {}, incoming: c.incoming || {} })
  const headers = plan.headers
  if (cred.mode === CREDENTIAL_MODES.PROVIDER_KEY) {
    if (cred.token == null || String(cred.token) === '') throw deny('official_credential_missing', '官方目标缺少自有 key')
    headers.authorization = 'Bearer ' + String(cred.token)
  } else {
    throw deny('official_credential_missing', '官方目标缺少可用凭据')
  }
  headers['user-agent'] = 'model-gateway/0.1'
  headers['accept-encoding'] = 'identity'
  return headers
}

// —— 主入口 ——
// intent:  { domain: 'official'|'thirdParty', official?: boolean,
//            caller: { incoming?, threadId?, sessionHeader?, sessionSalt?, providerKey?,
//                      hasProviderKey?, officialSubscription?, passthroughEnabled?, credentialMode? } }
// binding: { generation, origin, path, pathPrefix?, identity?, provider?, cfg?, officialVerified?,
//            thirdPartyVerified?, officialIngress?, modelBinding?, providerId?, credential?, env? }
// catalogGeneration: 目录快照 generation；必须与 binding.generation 完全一致。
// 成功返回冻结记录；失败抛 TargetAuthzError（code/status=403/deny=true）。
// 兼容：只给 intent.official 布尔时按它推导 domain；binding.path 缺省时回退 intent.path。
export function authorizeFinalTarget(intent, catalogGeneration, binding) {
  const i = intent || {}
  const b = binding || {}
  const domain = i.domain || (i.official === true ? TARGET_DOMAINS.OFFICIAL : (i.official === false ? TARGET_DOMAINS.THIRD_PARTY : undefined))
  if (domain !== TARGET_DOMAINS.OFFICIAL && domain !== TARGET_DOMAINS.THIRD_PARTY) {
    throw deny('intent_domain_invalid', '未知身份域：' + String(domain))
  }
  if (i.official !== undefined && (i.official === true) !== (domain === TARGET_DOMAINS.OFFICIAL)) {
    throw deny('intent_domain_conflict', 'intent.official 与 intent.domain 冲突')
  }
  assertGenerationBinding(b, catalogGeneration, domain)
  const cfg = b.cfg || {}
  const providerLike = Object.assign({}, b.provider || {}, {
    baseUrl: b.provider && b.provider.baseUrl != null ? b.provider.baseUrl : b.origin,
    pathPrefix: b.provider && b.provider.pathPrefix != null ? b.provider.pathPrefix : b.pathPrefix,
  })
  const identity = b.identity || classifyTarget(providerLike, cfg)
  if (!identity || identity.kind === IDENTITY_KINDS.UNKNOWN) {
    throw deny('target_identity_unknown', '上游目标身份无法确认（' + String((identity && identity.reason) || 'unknown') + '），已按 fail-closed 拒绝')
  }
  if (identity.kind !== domain) {
    throw deny('domain_identity_mismatch', '声明身份域与目标分类不一致：intent=' + domain + ' identity=' + identity.kind)
  }
  const target = canonicalizeUrlOnce(b.origin, b.path != null ? b.path : i.path, b.pathPrefix)
  const declaredHost = identity.host ? String(identity.host).toLowerCase() : ''
  if (declaredHost && target.hostname !== declaredHost) {
    throw deny('base_url_host_mismatch', 'baseUrl 声明的 host 与实际拼装目标不一致：declared=' + declaredHost + ' actual=' + target.hostname)
  }
  const scope = callerScopeOf(i, b, identity)
  const credentialMode = resolveCredentialMode(domain, identity, scope)
  const shapeDeny = allowedSchemeHostPortPath(target, domain, { cfg })
  if (shapeDeny) throw shapeDeny
  const credScope = Object.assign({}, scope, { credentialMode })
  const credDeny = credentialModeAllowed(domain, target, credScope)
  if (credDeny) throw credDeny
  if (domain === TARGET_DOMAINS.OFFICIAL) {
    const policyDeny = officialIngressPolicy(domain, target, Object.assign({}, b, { cfg, credentialMode }))
    if (policyDeny) throw policyDeny
  }

  const token = credentialMode === CREDENTIAL_MODES.PROVIDER_KEY ? providerToken(scope, b) : ''
  if (credentialMode === CREDENTIAL_MODES.PROVIDER_KEY && !token) throw deny('credential_missing', '声明使用自有 key，但未提供 key')
  const caller = Object.assign({}, scope, { incoming: (i.caller && i.caller.incoming) || (i.callerScope && i.callerScope.incoming) || b.incoming || {} })
  const headers = buildAllowlistedHeaders(domain, caller, { mode: credentialMode, token, target })
  const derivedSession = domain === TARGET_DOMAINS.THIRD_PARTY ? deriveSessionIdentity(caller, target) : null
  const providerId = b.providerId || (b.provider && b.provider.id) || (typeof b.provider === 'string' ? b.provider : null)
  const authz = {
    ok: true,
    domain,
    generation: catalogGeneration,
    target,
    targetKey: target.key,
    redirect: REDIRECT_POLICY,
    credentialMode,
    headers: Object.freeze(headers),
    modelBinding: Object.freeze(Object.assign({}, b.modelBinding || {})),
    providerId: providerId == null ? null : String(providerId),
    derivedSession,
  }
  return Object.freeze(authz)
}

function callerScopeOf(intent, binding, identity) {
  const c = Object.assign({}, intent.callerScope || {}, intent.caller || {})
  const cred = binding.credential || {}
  const prov = binding.provider || {}
  const def = prov._def || {}
  const providerHasKey = !!(prov.apiKey || def.apiKey || (identity && identity.credential === 'provider-key'))
  return Object.freeze({
    providerKey: c.providerKey !== undefined ? c.providerKey : binding.providerKey,
    hasProviderKey: c.hasProviderKey === true || providerHasKey,
    officialSubscription: c.officialSubscription === true,
    passthroughEnabled: c.passthroughEnabled === true,
    // 旧环境开关只用于「已退役」提示，不参与任何放行判断。
    legacyPassthrough: legacyPassthroughRequested(binding.env || (typeof process !== 'undefined' ? process.env : {})),
    credentialMode: c.credentialMode || cred.mode || null,
    // G1：只用于识别旧调用方的退役声明（typed deny），不参与任何放行判断。
    gatewaySubscription: c.gatewaySubscription === true,
    incoming: c.incoming || binding.incoming || null,
    threadId: c.threadId,
    sessionHeader: c.sessionHeader,
    sessionSalt: c.sessionSalt,
  })
}

function providerToken(scope, binding) {
  if (scope && typeof scope.providerKey === 'string' && scope.providerKey) return scope.providerKey
  const cred = binding.credential || {}
  if (typeof cred.token === 'string' && cred.token) return cred.token
  const prov = binding.provider || {}
  if (typeof prov.apiKey === 'string' && prov.apiKey) return prov.apiKey
  const def = prov._def || {}
  if (typeof def.apiKey === 'string' && def.apiKey) return def.apiKey
  return ''
}
