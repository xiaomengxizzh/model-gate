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
import { classifyTarget, isLoopbackHost, isOfficialHost, isAggregateModelId, IDENTITY_KINDS } from './identity.js'
import {
  CREDENTIAL_HEADERS, OFFICIAL_ONLY_HEADERS, OFFICIAL_ONLY_PREFIXES,
  OFFICIAL_PATH_PREFIXES, planTargetHeaders, legacyPassthroughRequested,
  isSubscriptionIdentityHeader,
} from './auth.js'
import {
  GATEWAY_SUBSCRIPTION_HOSTS, SUBSCRIPTION_RESPONSES_PATH, isSubscriptionEntryPath,
} from './local-subscription.js'
import { SIWC_UPSTREAM_HOST, SIWC_RESPONSES_PATH, SIWC_AUTH_DOMAIN } from '../subscription/domain.js'

export const TARGET_DOMAINS = Object.freeze({ OFFICIAL: 'official', THIRD_PARTY: 'thirdParty' })
// F01：OFFICIAL_SUBSCRIPTION（客户端官方订阅凭据 / /backend-api/codex）已退役。
// 常量保留只为把旧调用方识别出来并给出 typed deny（credential_mode_retired），绝不回落到可用状态。
export const CREDENTIAL_MODES = Object.freeze({
  PROVIDER_KEY: 'provider-key',
  OFFICIAL_SUBSCRIPTION: 'official-subscription',
  GATEWAY_SUBSCRIPTION: 'gateway-subscription',
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
  if (!officialPathnameAllowed(target.pathname) && !(o.gatewaySubscription === true && (target.pathname === '/backend-api/codex' || target.pathname.startsWith('/backend-api/codex/')))) {
    return deny('official_path_not_allowlisted', '官方目标路径不在白名单：' + target.pathname + '（允许 ' + OFFICIAL_PATH_PREFIXES.join(', ') + '）')
  }
  return null
}

// —— 域与凭据分离 ——
// provider-key   = 网关自持 API Key（唯一可用凭据，官方/第三方同规则）
// official-subscription = 已退役（F01）：任何声明都返回 credential_mode_retired + 迁移提示
// none           = 无凭据（第三方宁可 401，官方必须 fail-closed）
const RETIRED_CREDENTIAL_HINT = '客户端官方订阅凭据透传（official-subscription / MG_CODEX_OFFICIAL_PASSTHROUGH / /backend-api/codex）已移除（F01）：请为官方目标配置网关自有 key（apiKeyEnv 或面板 Key）。'
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
  if (mode === CREDENTIAL_MODES.GATEWAY_SUBSCRIPTION) {
    if (domain !== TARGET_DOMAINS.OFFICIAL) return deny('credential_mode_forbidden', 'gatewaySubscription 只允许官方目标')
    if (s.gatewaySubscription !== true) return deny('gateway_subscription_not_enabled', '未开启 gatewaySubscription')
    return null
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
    if (s.gatewaySubscription === true) return CREDENTIAL_MODES.GATEWAY_SUBSCRIPTION
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
  if (!officialPathnameAllowed(target.pathname) && !(o.credentialMode === CREDENTIAL_MODES.GATEWAY_SUBSCRIPTION && (target.pathname === '/backend-api/codex' || target.pathname.startsWith('/backend-api/codex/')))) {
    return deny('official_path_not_allowlisted', '官方目标路径不在白名单：' + target.pathname)
  }
  if (o.credentialMode === CREDENTIAL_MODES.OFFICIAL_SUBSCRIPTION) {
    return deny('credential_mode_retired', RETIRED_CREDENTIAL_HINT)
  }
  if (o.credentialMode === CREDENTIAL_MODES.GATEWAY_SUBSCRIPTION && !(target.pathname === '/backend-api/codex' || target.pathname.startsWith('/backend-api/codex/'))) {
    return deny('gateway_subscription_ingress_not_allowed', 'gatewaySubscription 只允许 /backend-api/codex 入口：' + target.pathname)
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
  const plan = planTargetHeaders({ identity: { kind: 'official', credential: 'provider-key' }, provider: {}, incoming: c.incoming || {} })
  const headers = plan.headers
  if (cred.mode === CREDENTIAL_MODES.PROVIDER_KEY) {
    if (cred.token == null || String(cred.token) === '') throw deny('official_credential_missing', '官方目标缺少自有 key')
    headers.authorization = 'Bearer ' + String(cred.token)
  } else if (cred.mode !== CREDENTIAL_MODES.GATEWAY_SUBSCRIPTION) {
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
  const shapeDeny = allowedSchemeHostPortPath(target, domain, { cfg, gatewaySubscription: credentialMode === CREDENTIAL_MODES.GATEWAY_SUBSCRIPTION })
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

// ————————————————————————————————————————————————————————————————————————————
// AGG-P02：授权域（AuthDomain）与上游解析收据
//
// 三个授权域互斥且互不替代（ADR-0003 §2、产品契约 MG-R002/MG-R008/R009）：
//   codex-subscription —— 复用本机已有 Codex 登录态，入口 chatgpt.com/backend-api/codex（P09）
//   siwc-app           —— Sign in with ChatGPT 的独立应用授权，入口 api.openai.com/v1/responses
//   api-key            —— 网关自持上游 key
//
// resolveUpstream(receipt) 是**唯一**做域决策的地方：域、host、path、模型映射一次定型为冻结收据，
// 之后的头构造、发送前校验、诊断投影都只消费这张收据，不再二次推断。
// 本层不读凭据、不发请求、不写日志；deny 只带 host/路径/稳定 code，绝不带 token。
// ————————————————————————————————————————————————————————————————————————————

export const AUTH_DOMAINS = Object.freeze({
  CODEX_SUBSCRIPTION: 'codex-subscription',
  SIWC_APP: SIWC_AUTH_DOMAIN,
  API_KEY: 'api-key',
})
const AUTH_DOMAIN_VALUES = Object.freeze(Object.values(AUTH_DOMAINS))
const API_KEY_DEFAULT_PATH = '/v1/responses'

// 凭据**来源域** → 出站**授权域**的唯一比较点：租约（src/subscription/isolation.js）与头构造
// 共用这一个函数，避免两处各写一份"订阅能不能发到第三方"的判定而漂移。
// 跨域即 typed 403；消息只带域名，绝不含 token / 账号 id。
export function assertCredentialOriginDomain(origin, authDomain) {
  const o = String(origin == null ? '' : origin).trim().toLowerCase()
  if (!AUTH_DOMAIN_VALUES.includes(o)) {
    throw deny('credential_origin_invalid', '未知的凭据来源域：' + (o || '?'), { status: 400 })
  }
  const target = String(authDomain == null ? '' : authDomain).trim().toLowerCase()
  if (!AUTH_DOMAIN_VALUES.includes(target)) {
    throw deny('auth_domain_invalid', '未知的授权域：' + (target || '?'), { status: 400 })
  }
  if (o !== target) {
    throw deny('credential_domain_mismatch', '凭据来源域 ' + o + ' 不得用于 ' + target + ' 出站请求：订阅与 api-key 凭据互不串域', {
      origin: o, authDomain: target,
    })
  }
  return target
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function normalizeIdentity(value) {
  const kind = value && typeof value === 'object' ? value.kind : value
  const v = String(kind == null ? '' : kind).trim().toLowerCase()
  if (v === 'official') return TARGET_DOMAINS.OFFICIAL
  if (v === 'thirdparty' || v === 'third-party' || v === 'third_party') return TARGET_DOMAINS.THIRD_PARTY
  return IDENTITY_KINDS.UNKNOWN
}

// host 规范化：接受 host[:port]、baseUrl 或完整 URL；返回 { host, hostname } 或 { error }。
function hostParts(value) {
  const raw = String(value == null ? '' : value).trim()
  if (!raw) return { error: 'missing' }
  let url
  try {
    url = raw.includes('://') ? new URL(raw) : new URL('https://' + raw)
  } catch { return { error: 'invalid' } }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: 'scheme' }
  if (url.username || url.password) return { error: 'userinfo' }
  const hostname = url.hostname.toLowerCase()
  if (!hostname) return { error: 'invalid' }
  return { host: url.host.toLowerCase(), hostname, port: url.port }
}

// 无法安全规范化的 host 一律 typed deny：userinfo/scheme 是越权面（403），缺字段是请求错误（400）。
function requireHost(value) {
  const hp = hostParts(value)
  if (hp.error === 'userinfo') throw deny('target_userinfo_forbidden', '上游 host 不得包含 userinfo（@ 注入）')
  if (hp.error === 'scheme') throw deny('target_scheme_not_allowed', '上游目标只允许 http(s)')
  if (hp.error === 'missing') throw deny('upstream_host_missing', '解析收据缺少上游 host', { status: 400 })
  if (hp.error) throw deny('upstream_host_invalid', '上游 host 无法解析', { status: 400 })
  return hp
}

function isSubscriptionHostName(hostname) {
  return GATEWAY_SUBSCRIPTION_HOSTS.includes(hostname) || isLoopbackHost(hostname)
}

function assertSafeUpstreamPath(path) {
  const p = String(path == null ? '' : path)
  if (!p.startsWith('/')) throw deny('upstream_path_invalid', '上游路径必须以 / 开头')
  if (p.includes('?')) throw deny('upstream_path_invalid', '上游路径不得包含查询串')
  if (p.includes('#')) throw deny('upstream_path_invalid', '上游路径不得包含 fragment')
  if (p.startsWith('//')) throw deny('target_path_not_allowed', '上游路径不得以 // 开头（协议相对）')
  if (/(^|\/)\.\.(\/|$)/.test(p)) throw deny('target_path_traversal', '上游路径不得包含 .. 穿越段')
  return p
}

function assertReceiptModelIds(model, upstreamModel, cfg) {
  if (isAggregateModelId(upstreamModel, cfg)) {
    throw deny('public_model_id_in_upstream', '上游模型 ID 不得使用聚合/公共 ID：' + upstreamModel + '（公共 ID 只用于本地目录与计费归属）')
  }
  if (upstreamModel.includes('?') || upstreamModel.includes('#')) {
    throw deny('upstream_model_invalid', '上游模型 ID 不得包含查询串或 fragment')
  }
  return { model, upstreamModel }
}

// 解析收据 -> 冻结的上游收据。receipt:
//   { providerId, model, upstreamModel,
//     binding: { identity, host|baseUrl, upstreamPath?, gatewaySubscription?, siwcApp?, apiKey?,
//                authDomain?, cfg? } }
// 成功返回 { providerId, authDomain, upstreamHost, upstreamPath, model, upstreamModel, ... }（冻结）。
// 失败抛 TargetAuthzError：code 稳定、status 401/403/400、deny=true，消息不含凭据。
export function resolveUpstream(receipt) {
  const r = receipt && typeof receipt === 'object' ? receipt : {}
  const providerId = nonEmptyString(r.providerId) ? String(r.providerId).trim() : ''
  if (!providerId) throw deny('receipt_provider_missing', '上游解析收据缺少 providerId', { status: 400 })
  const model = nonEmptyString(r.model) ? String(r.model).trim() : ''
  if (!model) throw deny('receipt_model_missing', '上游解析收据缺少公共模型 ID', { status: 400 })
  const upstreamModel = nonEmptyString(r.upstreamModel) ? String(r.upstreamModel).trim() : ''
  if (!upstreamModel) throw deny('receipt_upstream_model_missing', '上游解析收据缺少上游模型 ID（不得用公共 ID 代替）', { status: 400 })

  const binding = r.binding && typeof r.binding === 'object' ? r.binding : {}
  const cfg = binding.cfg && typeof binding.cfg === 'object' ? binding.cfg : {}
  assertReceiptModelIds(model, upstreamModel, cfg)

  const identity = normalizeIdentity(binding.identity)
  if (identity === IDENTITY_KINDS.UNKNOWN) {
    throw deny('target_identity_unknown', '上游目标身份无法确认（' + String(binding.identityReason || 'unknown') + '），已按 fail-closed 拒绝')
  }

  const enabled = Object.freeze({
    [AUTH_DOMAINS.CODEX_SUBSCRIPTION]: binding.gatewaySubscription === true,
    [AUTH_DOMAINS.SIWC_APP]: binding.siwcApp === true,
    [AUTH_DOMAINS.API_KEY]: binding.apiKey === true,
  })

  // 第三方域只能走 api-key：订阅/SIWC 域在第三方声明即拒绝（绝不「借用」官方身份）。
  if (identity === TARGET_DOMAINS.THIRD_PARTY) {
    if (enabled[AUTH_DOMAINS.CODEX_SUBSCRIPTION] || enabled[AUTH_DOMAINS.SIWC_APP]) {
      const which = enabled[AUTH_DOMAINS.CODEX_SUBSCRIPTION] ? AUTH_DOMAINS.CODEX_SUBSCRIPTION : AUTH_DOMAINS.SIWC_APP
      throw deny('auth_domain_not_allowed_for_third_party', '第三方上游不得声明授权域 ' + which + '：订阅/SIWC 凭据绝不出现在非官方上游')
    }
  }

  let authDomain
  const declaredRaw = binding.authDomain
  if (declaredRaw != null && declaredRaw !== '') {
    const declared = String(declaredRaw).trim().toLowerCase()
    if (!AUTH_DOMAIN_VALUES.includes(declared)) {
      throw deny('auth_domain_invalid', '未知授权域声明：' + declared, { status: 400 })
    }
    if (identity === TARGET_DOMAINS.THIRD_PARTY) {
      if (declared !== AUTH_DOMAINS.API_KEY) throw deny('auth_domain_not_allowed_for_third_party', '第三方上游只能声明 ' + AUTH_DOMAINS.API_KEY)
    } else if (enabled[declared] !== true) {
      throw deny('auth_domain_declared_unsupported', '声明的授权域缺少对应凭据声明：' + declared)
    }
    authDomain = declared
  } else if (identity === TARGET_DOMAINS.THIRD_PARTY) {
    // 第三方没有可用凭据时仍属 api-key 域（上游可回 401）：这是既有语义，不把「无凭据」当成另一个域。
    authDomain = AUTH_DOMAINS.API_KEY
  } else {
    const candidates = AUTH_DOMAIN_VALUES.filter((d) => enabled[d] === true)
    if (candidates.length === 0) {
      // F01 旧声明仍要给出「已退役」而不是含糊的缺凭据（保持既有对外 code）。
      if (legacyPassthroughRequested(binding.env || {})) throw deny('official_passthrough_retired', RETIRED_CREDENTIAL_HINT)
      if (binding.credentialMode === CREDENTIAL_MODES.OFFICIAL_SUBSCRIPTION || binding.officialSubscription === true) {
        throw deny('credential_mode_retired', RETIRED_CREDENTIAL_HINT)
      }
      // 沿用既有对外 code（官方无 key 即无可用授权），但语义是「没有任何授权域」：
      // reason 记录 ADR-0003 §4(2) 的未知授权状态，绝不按 API Key 处理。
      throw deny('official_no_gateway_key', '官方目标未声明任何授权域（codex-subscription / siwc-app / api-key）：绝不按 API Key 处理', { reason: 'auth_state_unknown' })
    }
    if (candidates.length > 1) {
      throw deny('auth_domain_ambiguous', '同一 provider 声明了多个授权域（' + candidates.join(', ') + '）：授权域互斥，请显式选择一个')
    }
    authDomain = candidates[0]
  }

  const hp = requireHost(binding.host != null ? binding.host : binding.baseUrl)

  let upstreamPath
  if (authDomain === AUTH_DOMAINS.CODEX_SUBSCRIPTION) {
    if (!isSubscriptionHostName(hp.hostname)) {
      throw deny('codex_subscription_host_not_allowed', 'codex-subscription 只允许官方订阅 host：' + hp.hostname + '（允许 ' + GATEWAY_SUBSCRIPTION_HOSTS.join(', ') + '，本机 mock 可用 loopback）')
    }
    upstreamPath = binding.upstreamPath == null ? SUBSCRIPTION_RESPONSES_PATH : assertSafeUpstreamPath(binding.upstreamPath)
    if (!isSubscriptionEntryPath(upstreamPath)) {
      throw deny('codex_subscription_path_not_allowed', 'codex-subscription 只允许 /backend-api/codex 入口：' + upstreamPath)
    }
  } else if (authDomain === AUTH_DOMAINS.SIWC_APP) {
    if (hp.hostname !== SIWC_UPSTREAM_HOST && !isLoopbackHost(hp.hostname)) {
      throw deny('siwc_app_host_not_allowed', 'siwc-app 只允许 ' + SIWC_UPSTREAM_HOST + '：' + hp.hostname)
    }
    if (binding.upstreamPath != null && String(binding.upstreamPath) !== SIWC_RESPONSES_PATH) {
      throw deny('siwc_app_path_not_allowed', 'siwc-app 只允许 ' + SIWC_RESPONSES_PATH + '：' + String(binding.upstreamPath))
    }
    upstreamPath = SIWC_RESPONSES_PATH
  } else {
    if (GATEWAY_SUBSCRIPTION_HOSTS.includes(hp.hostname)) {
      throw deny('auth_domain_host_mismatch', '订阅 host 不接受 api-key 域：' + hp.hostname)
    }
    upstreamPath = assertSafeUpstreamPath(binding.upstreamPath == null ? API_KEY_DEFAULT_PATH : binding.upstreamPath)
    if (identity === TARGET_DOMAINS.OFFICIAL) {
      const allowed = OFFICIAL_PATH_PREFIXES.some((p) => upstreamPath === p || upstreamPath.startsWith(p.endsWith('/') ? p : p + '/'))
      if (!allowed) throw deny('official_path_not_allowlisted', '官方目标路径不在白名单：' + upstreamPath)
    }
  }

  const credentialPresent = authDomain === AUTH_DOMAINS.API_KEY ? enabled[AUTH_DOMAINS.API_KEY] : true
  const credentialSource = authDomain === AUTH_DOMAINS.CODEX_SUBSCRIPTION ? 'codex-subscription'
    : authDomain === AUTH_DOMAINS.SIWC_APP ? 'siwc-app'
      : (enabled[AUTH_DOMAINS.API_KEY] ? 'provider-key' : 'none')

  return Object.freeze({
    providerId,
    authDomain,
    upstreamHost: hp.host,
    upstreamPath,
    model,
    upstreamModel,
    // 以下为实现附加字段（契约允许增加内部字段），不得用于替代上面的六个冻结字段。
    identityKind: identity,
    credentialSource,
    credentialPresent,
    redirect: REDIRECT_POLICY,
  })
}

function assertResolvedShape(resolved) {
  if (!resolved || typeof resolved !== 'object' || !AUTH_DOMAIN_VALUES.includes(resolved.authDomain) ||
      !nonEmptyString(resolved.providerId) || !nonEmptyString(resolved.upstreamHost) ||
      !nonEmptyString(resolved.upstreamPath) || !nonEmptyString(resolved.model) || !nonEmptyString(resolved.upstreamModel)) {
    throw deny('authz_receipt_invalid', '上游收据无效（必须是 resolveUpstream 的产物）')
  }
  return resolved
}

// 发送前二次校验：实际 URL 必须与收据的 host/path 完全一致（scheme 只允许 https，loopback 可 http）。
// opts.model 给出时要同时核对上游模型名（请求身份收据 = host + path + model 三者同源）。
export function assertResolvedUpstream(resolved, urlUsed, opts = {}) {
  const r = assertResolvedShape(resolved)
  const actualKey = targetKeyOfUrl(urlUsed)
  let url
  try { url = new URL(actualKey) } catch { throw deny('send_target_not_absolute', '实际发送目标不是绝对 URL') }
  const host = url.host.toLowerCase()
  if (host !== r.upstreamHost) {
    throw deny('send_target_drift', '实际发送 host 与收据不一致：authorized=' + r.upstreamHost + ' actual=' + host, {
      expected: r.upstreamHost, actual: host,
    })
  }
  if (url.pathname !== r.upstreamPath) {
    throw deny('send_target_drift', '实际发送路径与收据不一致：authorized=' + r.upstreamPath + ' actual=' + url.pathname, {
      expected: r.upstreamPath, actual: url.pathname,
    })
  }
  if (url.search) throw deny('send_target_drift', '实际发送目标带查询串，与收据不一致：' + r.upstreamPath)
  if (url.protocol !== 'https:' && !isLoopbackHost(url.hostname)) {
    throw deny('send_target_scheme_not_allowed', '非 loopback 上游必须走 https：' + r.upstreamHost)
  }
  if (opts && opts.model !== undefined && opts.model !== null) assertResolvedModel(r, opts.model)
  return r
}

// 订阅凭据绝不进入非订阅上游：头名层（chatgpt-*）+ 域标记层（authorization 来自订阅域）双重拦截。
// loopback 只有在本调用已声明订阅域时才视为订阅目的地（离线 mock），api-key 域不享受该例外。
export function assertNoSubscriptionCredentialToThirdParty(headers, upstreamHost, opts = {}) {
  const h = headers && typeof headers === 'object' ? headers : {}
  const hp = requireHost(upstreamHost)
  const subscriptionDomain = opts.credentialSource === AUTH_DOMAINS.CODEX_SUBSCRIPTION || opts.credentialSource === AUTH_DOMAINS.SIWC_APP
  // 来源层（比头名层更强）：租约自己声明是订阅凭据时，只要目的地不是订阅入口就拒绝——
  // 即使头集合里看不出订阅特征（例如订阅 token 被当成了普通 authorization）。
  const leaseOrigin = String((opts.lease && opts.lease.origin) || '').trim().toLowerCase()
  const leaseSubscription = leaseOrigin === AUTH_DOMAINS.CODEX_SUBSCRIPTION || leaseOrigin === AUTH_DOMAINS.SIWC_APP
  const official = isOfficialHost(hp.hostname, opts.cfg || {})
  const destination = official || GATEWAY_SUBSCRIPTION_HOSTS.includes(hp.hostname) || (subscriptionDomain && isLoopbackHost(hp.hostname))
  if (destination) return headers
  if (leaseSubscription) {
    throw deny('subscription_credential_to_third_party', '订阅来源租约不得发往非订阅上游：' + hp.host, { host: hp.host, origin: leaseOrigin })
  }
  for (const name of Object.keys(h)) {
    if (isSubscriptionIdentityHeader(name)) {
      throw deny('subscription_credential_to_third_party', '订阅身份头不得发往非订阅上游：' + name + ' → ' + hp.host, { header: name, host: hp.host })
    }
  }
  if (subscriptionDomain && Object.prototype.hasOwnProperty.call(h, 'authorization')) {
    throw deny('subscription_credential_to_third_party', '订阅域凭据不得发往非订阅上游：' + hp.host, { host: hp.host })
  }
  return headers
}

// 域内头不得混用：api-key 域不带订阅头；订阅域不带 provider key 头；siwc-app 不带账号头。
export function assertDomainHeaderSeparation(resolved, headers) {
  const r = assertResolvedShape(resolved)
  const h = headers && typeof headers === 'object' ? headers : {}
  const names = Object.keys(h).map((n) => String(n).toLowerCase())
  const hasSubscriptionHeader = names.some(isSubscriptionIdentityHeader)
  const hasProviderKeyHeader = names.includes('x-api-key') || names.includes('api-key')
  if (r.authDomain === AUTH_DOMAINS.API_KEY) {
    if (hasSubscriptionHeader) throw deny('credential_mixing', 'api-key 域出现订阅身份头：' + names.filter(isSubscriptionIdentityHeader).join(','))
    return headers
  }
  if (hasProviderKeyHeader) throw deny('credential_mixing', r.authDomain + ' 域出现 provider key 头')
  if (r.authDomain === AUTH_DOMAINS.SIWC_APP && hasSubscriptionHeader) {
    throw deny('credential_mixing', 'siwc-app 域出现 Codex 订阅身份头：两者入口与 audience 各自独立')
  }
  return headers
}

// 按域从空白构造发往上游的头；凭据按域注入，绝不继承客户端原头。
//   codex-subscription：只加 authorization + 可选 chatgpt-account-id（来自只读本机登录态）
//   siwc-app          ：只加 Authorization: Bearer <SIWC access token>
//   api-key           ：官方走白名单复制，第三方从空白构造（仅域派生会话头）
export function buildDomainHeaders(resolved, opts = {}) {
  const r = assertResolvedShape(resolved)
  const incoming = opts.incoming && typeof opts.incoming === 'object' ? opts.incoming : {}
  const cred = opts.credential && typeof opts.credential === 'object' ? opts.credential : {}
  // 凭据来源域租约（A4）：调用方只要带了租约，就必须与收据的授权域一致；不一致时零发送拒绝，
  // 绝不"先发出去再看上游 401"。没有租约时仍走既有的头名/域标记防线（向后兼容）。
  if (cred.lease && typeof cred.lease === 'object') assertCredentialOriginDomain(cred.lease.origin, r.authDomain)
  const target = { origin: 'https://' + r.upstreamHost }
  const caller = {
    incoming,
    threadId: opts.threadId,
    sessionHeader: opts.sessionHeader,
    sessionSalt: opts.sessionSalt,
  }
  const headers = {}
  if (r.authDomain === AUTH_DOMAINS.CODEX_SUBSCRIPTION) {
    const base = buildAllowlistedHeaders(TARGET_DOMAINS.OFFICIAL, caller, { mode: CREDENTIAL_MODES.GATEWAY_SUBSCRIPTION, target })
    if (!nonEmptyString(cred.authorization)) {
      throw deny('subscription_credential_unavailable', 'codex-subscription 缺少本机登录凭据；请先在 Codex 中登录', { status: 401 })
    }
    Object.assign(headers, base)
    headers.authorization = String(cred.authorization)
    if (nonEmptyString(cred.accountId)) headers['chatgpt-account-id'] = String(cred.accountId)
  } else if (r.authDomain === AUTH_DOMAINS.SIWC_APP) {
    if (!nonEmptyString(opts.siwcToken)) {
      throw deny('siwc_token_missing', 'siwc-app 缺少应用授权令牌；请完成 Sign in with ChatGPT', { status: 401 })
    }
    Object.assign(headers, buildAllowlistedHeaders(TARGET_DOMAINS.OFFICIAL, caller, {
      mode: CREDENTIAL_MODES.PROVIDER_KEY, token: String(opts.siwcToken), target,
    }))
  } else {
    const thirdParty = r.identityKind === TARGET_DOMAINS.THIRD_PARTY
    if (!thirdParty && !nonEmptyString(cred.providerKey)) {
      throw deny('official_credential_missing', '官方 api-key 域缺少网关自有 key', { status: 403 })
    }
    Object.assign(headers, buildAllowlistedHeaders(thirdParty ? TARGET_DOMAINS.THIRD_PARTY : TARGET_DOMAINS.OFFICIAL, caller, {
      mode: nonEmptyString(cred.providerKey) ? CREDENTIAL_MODES.PROVIDER_KEY : CREDENTIAL_MODES.NONE,
      token: nonEmptyString(cred.providerKey) ? String(cred.providerKey) : undefined,
      target,
    }))
    // 第三方头从空白构造：官方/客户端 authorization 已经在上一步被丢弃，这里只注入本域 key。
    if (thirdParty && nonEmptyString(cred.providerKey)) headers.authorization = 'Bearer ' + String(cred.providerKey)
  }
  headers['user-agent'] = 'model-gateway/0.1'
  headers['accept-encoding'] = 'identity'
  assertDomainHeaderSeparation(r, headers)
  assertNoSubscriptionCredentialToThirdParty(headers, r.upstreamHost, { credentialSource: r.authDomain })
  return Object.freeze(headers)
}

// 诊断投影：只含 provider/域/host/path/模型与「凭据是否存在」，绝不含 token/账号/文件内容。
export function resolvedDiagnostic(resolved) {
  const r = assertResolvedShape(resolved)
  return Object.freeze({
    providerId: r.providerId,
    authDomain: r.authDomain,
    upstreamHost: r.upstreamHost,
    upstreamPath: r.upstreamPath,
    model: r.model,
    upstreamModel: r.upstreamModel,
    credentialPresent: r.credentialPresent === true,
  })
}

// ————————————————————————————————————————————————————————————————————————————
// A4（V2-03）：授权域内失败归因（401/402/403/429）与「请求身份收据」（host + path + model）
//
// 背景（MG-R002/R008/R009/R012）：
//   · 401/403 是**授权域内**的终态（key/登录/权限），不是「这个模型不可用」；402 与配额型 429
//     是同一授权域的额度终态。这类失败一旦被降级成「换候选」，计费身份、套餐归属与错误归因
//     就全部变成另一个域的，属于静默换路由/换套餐 —— 明确禁止。
//   · 速率型 429 可以在**同一域**内按 Retry-After/退避重试，但仍不得跨域回退、不得换模型。
//   · 收据只钉 host/path 会放过「换模型名」的漂移，因此请求身份收据必须同时钉 host/path/model。
// 本层仍是纯判定：不读凭据、不发请求、不写日志；消息/收据只带稳定 code 与域名。
// ————————————————————————————————————————————————————————————————————————————

export const AUTH_FAILURE_KINDS = Object.freeze({
  UNAUTHORIZED: 'unauthorized',        // 401：key 无效 / 本机登录失效
  FORBIDDEN: 'forbidden',              // 403：无权限 / 账号或套餐被拒
  QUOTA_EXHAUSTED: 'quota_exhausted',  // 402、或语义为额度的 429：该授权域额度用尽
  RATE_LIMITED: 'rate_limited',        // 429：速率限流（域内可重试，不得跨域回退）
})

// 只做保守文本匹配：命中即归因，匹配不到不臆造（与 retry-policy 的 429 归因同源语义）。
const QUOTA_BODY_RE = /(insufficient|quota|billing|balance|credit|payment|欠费|余额|额度|配额|exhausted|exceeded your current quota)/i
const RATE_BODY_RE = /(rate.?limit|too many requests|requests per (minute|second)|\brpm\b|\btpm\b|throttl|频率|速率)/i

function authDomainArgument(opts) {
  const o = opts || {}
  const raw = o.authDomain != null ? o.authDomain : o.credentialSource
  if (raw == null || raw === '') return null
  const v = String(raw).trim().toLowerCase()
  if (!AUTH_DOMAIN_VALUES.includes(v)) {
    throw deny('auth_domain_invalid', '未知授权域：' + v, { status: 400 })
  }
  return v
}

function finiteMs(value) {
  if (value == null) return null
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return null
  return n
}

/**
 * 上游鉴权/额度失败的域内归因（单一真源）。
 * @param {number} status 上游 HTTP 状态（401/402/403/429）
 * @param {{authDomain?:string, bodyText?:string, retryAfterMs?:number, headers?:object}} [opts]
 * @returns {null | Readonly<{kind,code,status,authDomain,terminal,retryable,retryAfterMs,
 *   fallbackAllowed,rewriteModel,rewriteStatus}>} 非授权域状态返回 null（其他错误走各自通道）
 */
export function classifyAuthDomainFailure(status, opts = {}) {
  const s = Number(status)
  if (!Number.isInteger(s)) return null
  if (s !== 401 && s !== 402 && s !== 403 && s !== 429) return null
  const authDomain = authDomainArgument(opts)
  const base = Object.freeze({
    status: s,
    authDomain,
    terminal: true,
    // 任何授权域失败都不得改写模型/状态码，也不得自动换到另一个授权域或套餐。
    fallbackAllowed: false,
    rewriteModel: false,
    rewriteStatus: false,
  })
  if (s === 401) {
    return Object.freeze(Object.assign({}, base, { kind: AUTH_FAILURE_KINDS.UNAUTHORIZED, code: 'upstream_unauthorized', retryable: false, retryAfterMs: null }))
  }
  if (s === 403) {
    return Object.freeze(Object.assign({}, base, { kind: AUTH_FAILURE_KINDS.FORBIDDEN, code: 'upstream_forbidden', retryable: false, retryAfterMs: null }))
  }
  const retryAfterMs = finiteMs(opts && opts.retryAfterMs)
  if (s === 402) {
    return Object.freeze(Object.assign({}, base, { kind: AUTH_FAILURE_KINDS.QUOTA_EXHAUSTED, code: 'upstream_quota_exhausted', retryable: false, retryAfterMs }))
  }
  // 429：额度语义 → 终态（不准靠换域/换套餐继续）；速率语义 → 同域可重试，但仍不跨域。
  const body = String((opts && opts.bodyText) || '')
  const quota = QUOTA_BODY_RE.test(body) || (!RATE_BODY_RE.test(body) && (opts && opts.assumeQuota === true))
  if (quota) {
    return Object.freeze(Object.assign({}, base, { kind: AUTH_FAILURE_KINDS.QUOTA_EXHAUSTED, code: 'upstream_quota_exhausted', retryable: false, retryAfterMs }))
  }
  return Object.freeze(Object.assign({}, base, { kind: AUTH_FAILURE_KINDS.RATE_LIMITED, code: 'upstream_rate_limited', retryable: true, retryAfterMs }))
}

// 401/402/403 与「配额型 429」是授权域终态：不得变成成功、不得重试到另一域、不得改写模型或状态码。
// 速率型 429 不在此列（它有同域重试通道），但仍由 classifyAuthDomainFailure 给出 fallbackAllowed=false。
// 接线卡必须原样使用本收据：FALLBACK 判定应为 `if (authFailureReceipt(status, opts) === null) → 允许换候选`。
export function authFailureReceipt(status, opts = {}) {
  const classified = classifyAuthDomainFailure(status, opts)
  if (!classified) return null
  if (classified.kind === AUTH_FAILURE_KINDS.RATE_LIMITED) return null
  return classified
}

/**
 * 用**收据自带的授权域**归因上游失败：域不来自调用方猜测，避免把 Go 的 401 记成订阅域错误。
 * @param {object} resolved resolveUpstream() 的产物
 */
export function authFailureOfResolved(resolved, status, opts = {}) {
  const r = assertResolvedShape(resolved)
  return classifyAuthDomainFailure(status, Object.assign({}, opts, { authDomain: r.authDomain }))
}

/**
 * 接线卡的一行式终态信封：命中授权域终态时返回可直接下发的响应，
 * 未命中返回 null（调用方继续走既有的模型级拒绝/换候选逻辑）。
 *
 * 用途（A4/V2-03）：上游 401/402/403 与配额型 429 必须**按真实域**返回给客户端，
 * 而不是被兜底链吞成 502 all_providers_failed、更不是换到另一个候选/套餐继续发。
 * 信封只含稳定 code / 域名 / 类别，不含上游正文、token、账号 id。
 */
export function authFailureResponse(status, opts = {}) {
  const receipt = authFailureReceipt(status, opts)
  if (!receipt) return null
  const domain = receipt.authDomain || 'unknown'
  const body = {
    error: {
      code: receipt.code,
      type: 'auth_domain_failure',
      kind: receipt.kind,
      authDomain: receipt.authDomain,
      status: receipt.status,
      terminal: true,
      fallbackAllowed: false,
      message: '上游授权失败（' + domain + '）：' + receipt.kind + '；按真实授权域返回，不换路由/不换套餐/不改模型',
    },
  }
  return Object.freeze({
    handled: true,
    status: receipt.status,
    contentType: 'application/json; charset=utf-8',
    buf: Buffer.from(JSON.stringify(body)),
  })
}

// —— 请求身份收据：host + path + model 三者必须与收据完全一致 ——
// 上游模型名漂移（例如把公共/聚合 ID、别名或另一个模型名发出去）与 host/path 漂移同等严重：
// 它会让「计费/能力/压缩路径」全部落在未授权目标上，因此单独给稳定 code。
export function assertResolvedModel(resolved, modelSent) {
  const r = assertResolvedShape(resolved)
  const m = nonEmptyString(modelSent) ? String(modelSent).trim() : ''
  if (!m) throw deny('send_model_missing', '实际发送模型缺失，无法与收据核对', { status: 400 })
  if (m !== r.upstreamModel) {
    throw deny('send_model_drift', '实际发送模型与收据不一致：authorized=' + r.upstreamModel + ' actual=' + m, {
      expected: r.upstreamModel,
      actual: m,
    })
  }
  return r
}

/**
 * 一次校验「真正要发出去的东西」：URL(host/port/path/query) + 上游模型名。
 * 返回冻结的请求身份收据（只含 provider/域/host/path/模型，不含任何凭据）。
 */
export function verifyRequestIdentity(resolved, request = {}) {
  const r = assertResolvedShape(resolved)
  if (request.urlUsed === undefined || request.urlUsed === null) {
    throw deny('send_target_not_absolute', '缺少实际发送 URL，无法核对请求身份', { status: 400 })
  }
  assertResolvedUpstream(r, request.urlUsed)
  // 请求身份收据不接受「模型未知」：无法核对就是请求错误（assertResolvedUpstream 的
  // opts.model 是向后兼容的可选校验，这里必须强制要求模型名）。
  assertResolvedModel(r, request.model)
  return Object.freeze({
    providerId: r.providerId,
    authDomain: r.authDomain,
    upstreamHost: r.upstreamHost,
    upstreamPath: r.upstreamPath,
    model: r.model,
    upstreamModel: r.upstreamModel,
  })
}
