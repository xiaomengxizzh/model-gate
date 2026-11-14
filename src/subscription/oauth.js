// SIWC 自有预览客户端的合成 OAuth 流程（P07 原型）。
//
// 只实现公开契约的必要校验：state / nonce / PKCE(S256) / aud / iss / exp / scope / 刷新轮换 / 撤销。
// 不打开真实浏览器、不访问真实 OAuth 端点、不读凭据存储、不写真实 HOME；所有网络调用必须注入 fetchImpl。
//
// 证据边界：真实 issuer/client_id/scope/端点与资格未验证（UNKNOWN）；本模块的 scope 名称是合成合同标签。
// ID token 签名必须由调用方注入 idTokenVerifier；默认缺失即 fail closed，绝不把未验签的 token 当登录成功。

import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto'
import { isLoopbackRedirect, SIWC_REQUIRED_SCOPES } from './capabilities.js'

export const SIWC_MAX_EXPIRES_IN_SEC = 24 * 60 * 60
export const SIWC_CLOCK_SKEW_SEC = 60

export class OAuthError extends Error {
  constructor(code, message, options = {}) {
    super(String(message || code))
    this.name = 'OAuthError'
    this.code = String(code || 'oauth_error')
    this.transient = options.transient === true
    this.missingScopes = Array.isArray(options.missingScopes) ? options.missingScopes.slice() : []
    this.status = Number.isFinite(options.status) ? options.status : 0
  }
}

function fail(code, message, options) { throw new OAuthError(code, message, options) }

function b64url(buf) { return Buffer.from(buf).toString('base64url') }
function isNonEmptyString(v) { return typeof v === 'string' && v.trim() !== '' }
function isHttpsUrl(v) {
  if (!isNonEmptyString(v)) return false
  let u
  try { u = new URL(v) } catch { return false }
  return u.protocol === 'https:' && u.username === '' && u.password === ''
}
function parseScope(value) {
  if (Array.isArray(value)) return value.filter(isNonEmptyString)
  if (typeof value === 'string') return value.split(/\s+/).filter(Boolean)
  return []
}

export function pkceChallengeForVerifier(verifier) {
  if (typeof verifier !== 'string' || verifier.length < 43 || verifier.length > 128) {
    fail('invalid_pkce_verifier', 'PKCE verifier 必须为 43..128 字符')
  }
  return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}

export function createPkcePair(options = {}) {
  const rng = typeof options.randomBytes === 'function' ? options.randomBytes : nodeRandomBytes
  const raw = rng(32)
  if (!raw || typeof raw.length !== 'number' || raw.length < 32) fail('invalid_randomness', 'PKCE 随机源不足 32 字节')
  const codeVerifier = b64url(raw)
  return { codeVerifier, codeChallenge: pkceChallengeForVerifier(codeVerifier), method: 'S256' }
}

export function assertRegistration(registration) {
  if (!registration || typeof registration !== 'object') fail('invalid_registration', '缺少注册记录')
  for (const field of ['accountId', 'workspaceId', 'clientId']) {
    if (!isNonEmptyString(registration[field])) fail('invalid_registration', '注册缺少 ' + field)
  }
  if (!isHttpsUrl(registration.issuer)) fail('invalid_registration', 'issuer 必须是 https')
  if (!isHttpsUrl(registration.authorizationEndpoint)) fail('invalid_registration', 'authorizationEndpoint 必须是 https')
  if (!isHttpsUrl(registration.tokenEndpoint)) fail('invalid_registration', 'tokenEndpoint 必须是 https')
  if (registration.revocationEndpoint != null && !isHttpsUrl(registration.revocationEndpoint)) fail('invalid_registration', 'revocationEndpoint 必须是 https')
  if (registration.resourceEndpoint != null && !isHttpsUrl(registration.resourceEndpoint)) fail('invalid_registration', 'resourceEndpoint 必须是 https')
  if (!isLoopbackRedirect(registration.redirectUri)) fail('invalid_registration', 'redirectUri 必须是 loopback http（禁止开放重定向）')
  if (!Array.isArray(registration.scopes) || registration.scopes.length === 0) fail('invalid_registration', '注册缺少 scopes')
  return registration
}

/**
 * 构造 loopback 浏览器授权 URL。state/nonce/codeChallenge 由调用方生成并保存；
 * 本函数不生成 state/nonce、不打开浏览器、不访问网络。
 */
export function buildAuthorizationRequest({ registration, state, nonce, codeChallenge, hostId, appName } = {}) {
  assertRegistration(registration)
  if (!isNonEmptyString(state) || state.length < 16 || state.length > 256) fail('invalid_state', 'state 必须为 16..256 字符')
  if (!isNonEmptyString(nonce) || nonce.length < 16 || nonce.length > 256) fail('invalid_nonce', 'nonce 必须为 16..256 字符')
  if (typeof codeChallenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) fail('invalid_pkce_challenge', 'codeChallenge 必须是 S256 base64url')
  if (!isNonEmptyString(hostId)) fail('invalid_host_id', '缺少稳定 hostId')
  if (!isNonEmptyString(appName)) fail('invalid_app_name', '缺少真实应用标识')

  const url = new URL(registration.authorizationEndpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', registration.clientId)
  url.searchParams.set('redirect_uri', registration.redirectUri)
  url.searchParams.set('scope', registration.scopes.join(' '))
  url.searchParams.set('state', state)
  url.searchParams.set('nonce', nonce)
  url.searchParams.set('code_challenge', codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  if (isNonEmptyString(registration.resource)) url.searchParams.set('resource', registration.resource)
  url.searchParams.set('mg_host_id', hostId)
  url.searchParams.set('mg_app_name', appName)
  return { url: url.toString(), state, nonce, redirectUri: registration.redirectUri }
}

async function postForm(fetchImpl, endpoint, params) {
  if (typeof fetchImpl !== 'function') fail('network_not_configured', '未注入 fetchImpl；本原型不直接联网')
  let res
  try {
    res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      redirect: 'error',
    })
  } catch {
    fail('network_unavailable', '授权服务不可达', { transient: true })
  }
  if (!res || typeof res !== 'object') fail('invalid_token_response', '授权服务返回非法响应')
  let body = null
  try { body = typeof res.json === 'function' ? await res.json() : (res.body || null) } catch { body = null }
  return { ok: res.ok === true || (Number(res.status) >= 200 && Number(res.status) < 300), status: Number(res.status) || 0, body: body && typeof body === 'object' ? body : {} }
}

function validateClaims(claims, { registration, expectedNonce, now }) {
  if (!claims || typeof claims !== 'object') fail('invalid_id_token', '缺少 ID token claims')
  if (claims.iss !== registration.issuer) fail('invalid_issuer', 'ID token issuer 不匹配')
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!aud.includes(registration.clientId)) fail('invalid_audience', 'ID token audience 不匹配')
  if (claims.nonce !== expectedNonce) fail('invalid_nonce', 'ID token nonce 不匹配')
  const nowSec = Math.floor(now / 1000)
  if (!Number.isFinite(claims.exp) || claims.exp <= nowSec) fail('expired_id_token', 'ID token 已过期')
  if (Number.isFinite(claims.iat) && claims.iat > nowSec + SIWC_CLOCK_SKEW_SEC) fail('invalid_id_token', 'ID token iat 在未来')
  return claims
}

/**
 * 合成授权码交换。返回的 grant 含 token，调用方只能交给 session 的私有存储；
 * 任何错误都不包含 token/正文，日志与状态必须脱敏。
 */
export async function exchangeAuthorizationCode(input = {}) {
  const { registration, code, codeVerifier, state, expectedState, expectedNonce, idTokenVerifier, fetchImpl, now = Date.now() } = input
  assertRegistration(registration)
  if (!isNonEmptyString(expectedState) || !isNonEmptyString(state) || state !== expectedState) fail('invalid_state', 'state 不匹配（可能的 CSRF/串线）')
  if (!isNonEmptyString(expectedNonce)) fail('invalid_nonce', '缺少预期 nonce')
  if (!isNonEmptyString(code)) fail('invalid_authorization_code', '缺少授权码')
  if (typeof codeVerifier !== 'string' || codeVerifier.length < 43) fail('invalid_pkce_verifier', '缺少合法 PKCE verifier')
  if (typeof idTokenVerifier !== 'function') fail('id_token_verification_unavailable', '缺少 ID token 验签器；拒绝未验签登录')

  const res = await postForm(fetchImpl, registration.tokenEndpoint, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: registration.redirectUri,
    client_id: registration.clientId,
    code_verifier: codeVerifier,
  })
  if (!res.ok) fail('token_exchange_failed', '授权码交换被拒绝', { status: res.status })

  const body = res.body
  if (!isNonEmptyString(body.access_token)) fail('invalid_token_response', '缺少 access_token')
  if (!isNonEmptyString(body.refresh_token)) fail('invalid_token_response', '缺少 refresh_token')
  if (typeof body.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer') fail('invalid_token_response', 'token_type 不是 Bearer')
  const expiresIn = Number(body.expires_in)
  if (!Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > SIWC_MAX_EXPIRES_IN_SEC) fail('invalid_token_response', 'expires_in 非法')

  let claims
  try {
    claims = await idTokenVerifier(body.id_token, { registration, nonce: expectedNonce })
  } catch {
    fail('invalid_id_token', 'ID token 验签失败')
  }
  validateClaims(claims, { registration, expectedNonce, now })

  const scope = parseScope(body.scope)
  const required = Array.isArray(registration.requiredScopes) && registration.requiredScopes.length ? registration.requiredScopes : SIWC_REQUIRED_SCOPES
  const missing = required.filter((s) => !scope.includes(s))
  if (missing.length) fail('missing_scope', '授权缺少必需 scope', { missingScopes: missing })

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    tokenType: 'Bearer',
    scope,
    expiresAt: now + expiresIn * 1000,
    issuedAt: now,
    idClaims: claims,
  }
}

export async function refreshAccessToken(input = {}) {
  const { registration, grant, fetchImpl, now = Date.now() } = input
  assertRegistration(registration)
  if (!grant || !isNonEmptyString(grant.refreshToken)) fail('invalid_grant', '缺少 refresh token')
  const res = await postForm(fetchImpl, registration.tokenEndpoint, {
    grant_type: 'refresh_token',
    refresh_token: grant.refreshToken,
    client_id: registration.clientId,
  })
  if (!res.ok) {
    const error = typeof res.body.error === 'string' ? res.body.error : 'refresh_failed'
    const transient = res.status >= 500 || error === 'temporarily_unavailable' || error === 'server_error'
    fail(error === 'invalid_grant' || error === 'invalid_client' ? 'invalid_grant' : 'refresh_failed', '刷新被拒绝', { transient, status: res.status })
  }
  const body = res.body
  if (!isNonEmptyString(body.access_token)) fail('invalid_token_response', '刷新缺少 access_token')
  const expiresIn = Number(body.expires_in)
  if (!Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > SIWC_MAX_EXPIRES_IN_SEC) fail('invalid_token_response', '刷新 expires_in 非法')
  const scope = body.scope != null ? parseScope(body.scope) : (Array.isArray(grant.scope) ? grant.scope.slice() : [])
  const required = Array.isArray(registration.requiredScopes) && registration.requiredScopes.length ? registration.requiredScopes : SIWC_REQUIRED_SCOPES
  const missing = required.filter((s) => !scope.includes(s))
  if (missing.length) fail('missing_scope', '刷新后的授权缺少必需 scope', { missingScopes: missing })
  const refreshToken = isNonEmptyString(body.refresh_token) ? body.refresh_token : grant.refreshToken
  return {
    ...grant,
    accessToken: body.access_token,
    refreshToken,
    tokenType: 'Bearer',
    scope,
    expiresAt: now + expiresIn * 1000,
    issuedAt: now,
    rotated: isNonEmptyString(body.refresh_token),
  }
}

/** 有界撤销；网络失败不让登出失败，但必须标 remote_revocation_unconfirmed。 */
export async function revokeToken(input = {}) {
  const { registration, grant, fetchImpl } = input
  if (!registration || !isNonEmptyString(registration.revocationEndpoint)) return { ok: false, remote: 'unconfirmed', reason: 'no_revocation_endpoint' }
  const token = grant && isNonEmptyString(grant.refreshToken) ? grant.refreshToken : (grant && isNonEmptyString(grant.accessToken) ? grant.accessToken : '')
  if (token === '') return { ok: false, remote: 'unconfirmed', reason: 'no_token' }
  if (typeof fetchImpl !== 'function') return { ok: false, remote: 'unconfirmed', reason: 'network_not_configured' }
  try {
    const res = await fetchImpl(registration.revocationEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, token_type_hint: grant.refreshToken ? 'refresh_token' : 'access_token', client_id: registration.clientId }).toString(),
      redirect: 'error',
    })
    const status = Number(res && res.status) || 0
    return { ok: status >= 200 && status < 300, remote: status >= 200 && status < 300 ? 'confirmed' : 'unconfirmed', status }
  } catch {
    return { ok: false, remote: 'unconfirmed', reason: 'network_unavailable' }
  }
}
