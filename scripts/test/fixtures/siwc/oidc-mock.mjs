// 虚构 OIDC / SIWC 公开 API mock（P07 夹具）。
//
// 只在内存中模拟 authorize/token/refresh/revoke；不监听端口、不联网、不写文件。
// 端点、client_id、scope 均为合成合同标签，不代表真实 OpenAI 资格或真实端点。
// 测试通过注入 fetchImpl 使用本 mock；src/subscription/oauth.js 不含真实网络调用。

import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto'
import { pkceChallengeForVerifier } from '../../../../src/subscription/oauth.js'
import { SIWC_REQUIRED_SCOPES } from '../../../../src/subscription/capabilities.js'

function b64url(value) {
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url')
}
function parseScope(value) {
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string' && v !== '')
  if (typeof value === 'string') return value.split(/\s+/).filter(Boolean)
  return []
}
function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

export function createOidcMock(options = {}) {
  const clientId = options.clientId || 'mg-preview-client'
  const issuer = options.issuer || 'https://issuer.synthetic.example'
  const accountId = options.accountId || 'acct-synthetic-1'
  const workspaceId = options.workspaceId || 'ws-synthetic-1'
  const scopes = Array.isArray(options.scopes) ? options.scopes.slice() : SIWC_REQUIRED_SCOPES.slice()
  const requiredScopes = Array.isArray(options.requiredScopes) ? options.requiredScopes.slice() : scopes.slice()
  const secret = options.secret || 'synthetic-oidc-hmac-secret'
  const redirectUri = options.redirectUri || 'http://127.0.0.1:49152/callback'
  const tokenAudience = options.tokenAudience || clientId
  const idTokenExpOffset = Number.isFinite(options.idTokenExpOffset) ? options.idTokenExpOffset : 0
  const idTokenIatOffset = Number.isFinite(options.idTokenIatOffset) ? options.idTokenIatOffset : 0
  const grantScopes = Array.isArray(options.grantScopes) ? options.grantScopes.slice() : null
  let clock = Number.isFinite(options.now) ? options.now : Date.parse('2026-11-12T12:00:00Z')
  const now = () => clock
  const advance = (ms) => { clock += Number(ms) || 0 }

  const codes = new Map()
  const refreshTokens = new Map()
  const counters = { code: 0, access: 0, refresh: 0 }
  const calls = { token: 0, refresh: 0, revoke: 0 }
  const state = {
    tokenNetworkDown: false,
    refreshNetworkDown: false,
    revokeNetworkDown: false,
  }

  const registration = {
    accountId,
    workspaceId,
    clientId,
    issuer,
    authorizationEndpoint: issuer + '/authorize',
    tokenEndpoint: issuer + '/token',
    revocationEndpoint: issuer + '/revoke',
    resourceEndpoint: 'https://api.synthetic.example/v1',
    resource: 'https://api.synthetic.example/v1',
    redirectUri,
    scopes,
    requiredScopes,
  }

  function signIdToken(claims) {
    const header = b64url({ alg: 'HS256', typ: 'JWT' })
    const payload = b64url(claims)
    const signature = createHmac('sha256', secret).update(header + '.' + payload).digest('base64url')
    return header + '.' + payload + '.' + signature
  }

  function verifyIdToken(token) {
    if (typeof token !== 'string') throw new Error('missing id_token')
    const parts = token.split('.')
    if (parts.length !== 3) throw new Error('malformed id_token')
    const expected = createHmac('sha256', secret).update(parts[0] + '.' + parts[1]).digest()
    const actual = Buffer.from(parts[2], 'base64url')
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error('bad id_token signature')
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  }

  function issueTokens({ nonce, scope, includeRefresh = true }) {
    const accessToken = 'at_' + (++counters.access) + '_' + randomBytes(8).toString('hex')
    const refreshToken = 'rt_' + (++counters.refresh) + '_' + randomBytes(8).toString('hex')
    const nowSec = Math.floor(now() / 1000)
    const claims = {
      iss: issuer,
      aud: tokenAudience,
      sub: accountId,
      nonce,
      workspace_id: workspaceId,
      iat: nowSec + idTokenIatOffset,
      exp: nowSec + 3600 + idTokenExpOffset,
    }
    if (includeRefresh) refreshTokens.set(refreshToken, { scope: scope.slice(), revoked: false })
    return {
      access_token: accessToken,
      refresh_token: includeRefresh ? refreshToken : undefined,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: scope.join(' '),
      id_token: signIdToken(claims),
    }
  }

  function authorize({ state: authState, nonce, codeChallenge, scope, redirectUri: requestedRedirect } = {}) {
    if (typeof authState !== 'string' || authState === '' || typeof nonce !== 'string' || nonce === '' || typeof codeChallenge !== 'string' || codeChallenge === '') {
      return { error: 'invalid_request' }
    }
    if (requestedRedirect && requestedRedirect !== redirectUri) return { error: 'invalid_redirect_uri' }
    const requested = parseScope(scope && scope.length ? scope : scopes)
    const missing = requiredScopes.filter((s) => !requested.includes(s))
    if (missing.length) return { error: 'invalid_scope', missing }
    const code = 'code_' + (++counters.code) + '_' + randomBytes(6).toString('hex')
    codes.set(code, { nonce, codeChallenge, scope: requested, used: false, expiresAt: now() + 60_000 })
    return { code, state: authState, nonce }
  }

  function token(params) {
    calls.token += 1
    if (state.tokenNetworkDown) throw new Error('synthetic token endpoint network down')
    if (params.grant_type === 'authorization_code') {
      const record = codes.get(params.code)
      if (!record || record.used || record.expiresAt <= now()) return jsonResponse(400, { error: 'invalid_grant' })
      if (params.redirect_uri !== redirectUri) return jsonResponse(400, { error: 'invalid_grant' })
      if (params.client_id !== clientId) return jsonResponse(400, { error: 'invalid_client' })
      let challenge
      try { challenge = pkceChallengeForVerifier(params.code_verifier) } catch { return jsonResponse(400, { error: 'invalid_grant' }) }
      if (challenge !== record.codeChallenge) return jsonResponse(400, { error: 'invalid_grant' })
      record.used = true
      const effectiveScope = grantScopes || record.scope
      return jsonResponse(200, issueTokens({ nonce: record.nonce, scope: effectiveScope }))
    }
    if (params.grant_type === 'refresh_token') {
      calls.refresh += 1
      if (state.refreshNetworkDown) throw new Error('synthetic refresh network down')
      const record = refreshTokens.get(params.refresh_token)
      if (!record || record.revoked) return jsonResponse(400, { error: 'invalid_grant' })
      refreshTokens.delete(params.refresh_token)
      const effectiveScope = grantScopes || record.scope
      return jsonResponse(200, issueTokens({ nonce: 'refresh-nonce', scope: effectiveScope }))
    }
    return jsonResponse(400, { error: 'unsupported_grant_type' })
  }

  function revoke(params) {
    calls.revoke += 1
    if (state.revokeNetworkDown) throw new Error('synthetic revoke network down')
    if (typeof params.token === 'string' && refreshTokens.has(params.token)) {
      const record = refreshTokens.get(params.token)
      record.revoked = true
      refreshTokens.delete(params.token)
    }
    return jsonResponse(200, {})
  }

  async function fetchImpl(url, opts = {}) {
    const parsed = new URL(String(url))
    const params = Object.fromEntries(new URLSearchParams(String(opts.body || '')))
    if (parsed.pathname.endsWith('/token')) return token(params)
    if (parsed.pathname.endsWith('/revoke')) return revoke(params)
    return jsonResponse(404, { error: 'not_found' })
  }

  function invalidateRefreshTokens() { refreshTokens.clear() }
  function revokeAllRefreshTokens() { for (const record of refreshTokens.values()) record.revoked = true }

  return {
    registration,
    now,
    advance,
    authorize,
    verifyIdToken,
    fetchImpl,
    invalidateRefreshTokens,
    revokeAllRefreshTokens,
    get refreshCalls() { return calls.refresh },
    get tokenCalls() { return calls.token },
    get revokeCalls() { return calls.revoke },
    get refreshTokenCount() { return refreshTokens.size },
    set tokenNetworkDown(v) { state.tokenNetworkDown = !!v },
    set refreshNetworkDown(v) { state.refreshNetworkDown = !!v },
    set revokeNetworkDown(v) { state.revokeNetworkDown = !!v },
  }
}
