// A4（V2-03）：订阅凭据的**跨域租约**——凭据来源域与出站目标域必须一致。
//
// 背景（MG-R002 / MG-R008 / MG-R009）：
//   默认保留用户既有的 ChatGPT 登录与套餐；OpenCode Go 用自己独立的 api-key 授权域。
//   现有防线在两层：头名层（chatgpt-* 只能是订阅头）与域标记层（credentialSource 来自收据）。
//   但「把一个订阅 token 当作 provider key 传进 api-key 域」在头名层是看不出来的——它就是一个
//   合法的 `authorization`。因此这里给凭据加**来源域租约**：读凭据的一方声明 origin，
//   构造出站头的一方必须用 assertLeaseDomain() 兑换；跨域即 typed deny。
//
// 边界：纯判定，不读文件、不发请求、不写日志；租约对象冻结，token 不可枚举、不进入 toJSON，
// 任何拒绝消息只带稳定 code 与域名，绝不含 token / 账号 id。
//
// 与「不改变凭据授权原则」一致：本模块不禁止读取本机登录态（那是 src/codex/local-subscription.js
// 的只读职责），只禁止**跨域使用**它；读取失败/缺失仍是那边的 typed 401，不在这里变成别的域。

import { AUTH_DOMAINS, assertCredentialOriginDomain } from '../codex/target-authz.js'

// 来源域取值与授权域一一对应：**只引用** target-authz 的 AUTH_DOMAINS（它自己从
// subscription/domain.js 取 siwc-app），不在这里写第二份字面量。
export const CREDENTIAL_ORIGINS = Object.freeze({
  CODEX_SUBSCRIPTION: AUTH_DOMAINS.CODEX_SUBSCRIPTION,
  SIWC_APP: AUTH_DOMAINS.SIWC_APP,
  API_KEY: AUTH_DOMAINS.API_KEY,
})

export const SUBSCRIPTION_ORIGINS = Object.freeze([CREDENTIAL_ORIGINS.CODEX_SUBSCRIPTION, CREDENTIAL_ORIGINS.SIWC_APP])

export function isSubscriptionOrigin(origin) {
  return SUBSCRIPTION_ORIGINS.includes(String(origin == null ? '' : origin).trim().toLowerCase())
}

export class CredentialIsolationError extends Error {
  constructor(code, message, extra) {
    super(message || code)
    this.name = 'CredentialIsolationError'
    this.code = String(code)
    this.status = 403
    this.deny = true
    if (extra && typeof extra === 'object') {
      for (const key of ['origin', 'authDomain', 'upstreamHost', 'accountIdPresent']) {
        if (extra[key] !== undefined) this[key] = extra[key]
      }
    }
  }
}

export function isCredentialIsolationError(err) {
  return !!(err && err.deny === true && err.name === 'CredentialIsolationError' && typeof err.code === 'string')
}

function deny(code, message, extra) {
  return new CredentialIsolationError(code, message, extra)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * 创建凭据租约（来源域 + 令牌 + 可选账号/过期信息）。
 * token 以不可枚举属性保存：JSON.stringify/诊断投影不会带出它，需要时必须读 lease.token。
 */
export function createCredentialLease(input = {}) {
  const rawOrigin = input.origin != null ? input.origin : input.originDomain
  const origin = String(rawOrigin == null ? '' : rawOrigin).trim().toLowerCase()
  if (!Object.values(AUTH_DOMAINS).includes(origin)) {
    throw deny('credential_origin_invalid', '未知的凭据来源域：' + (origin || '?'), { origin: origin || null })
  }
  if (!nonEmptyString(input.token)) {
    throw deny('credential_token_missing', '凭据租约缺少令牌', { origin })
  }
  const lease = {
    origin,
    scope: nonEmptyString(input.scope) ? String(input.scope).trim() : null,
    accountId: nonEmptyString(input.accountId) ? String(input.accountId).trim() : null,
    expiresAt: Number.isFinite(Number(input.expiresAt)) ? Number(input.expiresAt) : null,
    source: nonEmptyString(input.source) ? String(input.source).trim() : origin,
  }
  Object.defineProperty(lease, 'token', {
    value: String(input.token), enumerable: false, configurable: false, writable: false,
  })
  // 显式 toJSON：即使有人把它塞进日志对象，也只留来源域与「有/无账号、是否过期」。
  Object.defineProperty(lease, 'toJSON', {
    value: () => redactLease(lease), enumerable: false, configurable: false, writable: false,
  })
  return Object.freeze(lease)
}

/** 脱敏投影：只有来源域、是否有账号、过期时间；没有 token，也没有账号原值。 */
export function redactLease(lease) {
  const l = lease && typeof lease === 'object' ? lease : {}
  return Object.freeze({
    origin: nonEmptyString(l.origin) ? String(l.origin) : null,
    scope: nonEmptyString(l.scope) ? String(l.scope) : null,
    accountIdPresent: nonEmptyString(l.accountId),
    expiresAt: Number.isFinite(Number(l.expiresAt)) ? Number(l.expiresAt) : null,
    source: nonEmptyString(l.source) ? String(l.source) : null,
  })
}

/**
 * 租约能否用于某个授权域的出站请求。单一真源：域名比较委托给
 * target-authz.assertCredentialOriginDomain（与头构造共用同一判定）。
 * @returns {object} 租约本身（链式使用）
 */
export function assertLeaseDomain(lease, authDomain, opts = {}) {
  const l = lease && typeof lease === 'object' ? lease : null
  if (!l) throw deny('credential_lease_missing', '缺少凭据租约：无法证明凭据来源域')
  if (!nonEmptyString(l.origin)) throw deny('credential_lease_invalid', '凭据租约缺少来源域')
  if (!nonEmptyString(l.token)) throw deny('credential_lease_invalid', '凭据租约缺少令牌', { origin: l.origin })
  const o = opts || {}
  if (l.expiresAt != null && Number.isFinite(o.now) && Number(l.expiresAt) <= Number(o.now)) {
    // 过期不是「换域」的理由：直接 typed 401 让调用方走各自的重新登录路径。
    const e = deny('credential_lease_expired', '凭据租约已过期（' + String(l.origin) + '）', { origin: l.origin })
    e.status = 401
    throw e
  }
  assertCredentialOriginDomain(l.origin, authDomain)
  return l
}

/**
 * 租约 + 收据 + 实际 host 的联合校验（出站前一次定型）。
 * loopback 例外只对**订阅来源**生效，且必须显式 allowLoopbackMock（离线 mock 专用）；
 * api-key 来源永远不享受该例外（绝不因为目标是本机就把订阅/其他域混过去）。
 */
export function assertLeaseForUpstream(lease, resolved, opts = {}) {
  const r = resolved && typeof resolved === 'object' ? resolved : {}
  if (!nonEmptyString(r.authDomain) || !nonEmptyString(r.upstreamHost)) {
    throw deny('credential_lease_target_invalid', '缺少已冻结的上游收据（authDomain/upstreamHost）')
  }
  const l = assertLeaseDomain(lease, r.authDomain, opts)
  const host = String(r.upstreamHost).trim().toLowerCase()
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]' || host.startsWith('127.0.0.1:') || host.startsWith('localhost:')
  if (loopback && !(opts.allowLoopbackMock === true && isSubscriptionOrigin(l.origin))) {
    throw deny('credential_lease_loopback_forbidden', '凭据租约不允许用于本机回环目标（仅订阅域离线 mock 例外）：' + host, { origin: l.origin, upstreamHost: host })
  }
  return l
}

/**
 * 把只读本机登录凭据（readSubscriptionCredential 的产物）包装成租约。
 * 不复制 token 进日志；refresh token 从不出现（上游只返回 access token）。
 */
export function credentialLeaseFromSubscription(credential, opts = {}) {
  const c = credential && typeof credential === 'object' ? credential : {}
  return createCredentialLease({
    origin: AUTH_DOMAINS.CODEX_SUBSCRIPTION,
    token: c.authorization,
    accountId: c.accountId,
    expiresAt: c.expiresAt,
    source: nonEmptyString(c.source) ? c.source : 'codex_auth_json',
    scope: opts.scope,
  })
}

/** SIWC 应用授权令牌 → 租约（入口/令牌都由 subscription/session 提供）。 */
export function credentialLeaseFromSiwc(accessToken, opts = {}) {
  return createCredentialLease({
    origin: AUTH_DOMAINS.SIWC_APP,
    token: accessToken,
    accountId: opts.accountId,
    expiresAt: opts.expiresAt,
    source: nonEmptyString(opts.source) ? opts.source : 'siwc_oauth',
    scope: opts.scope,
  })
}

/** 网关自持上游 key → 租约（Go / 官方 API Key 同属 api-key 域）。 */
export function credentialLeaseFromProviderKey(providerKey, opts = {}) {
  return createCredentialLease({
    origin: AUTH_DOMAINS.API_KEY,
    token: providerKey,
    source: nonEmptyString(opts.source) ? opts.source : 'gateway-config',
    scope: opts.scope,
  })
}
