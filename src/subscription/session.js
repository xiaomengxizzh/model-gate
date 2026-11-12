// SIWC 自有预览客户端的本地会话管理（P07 原型）。
//
// 职责：按 (账户, workspace) 独立存放授权；scope 校验；并发续期单飞；轮换 refresh token 只存最新；
// 撤销/登出；状态脱敏。默认 off 与登录暴露判定在 capabilities.js，真实 OAuth 交换在 oauth.js。
//
// 边界：不读凭据存储 / 真实 HOME / 真实会话；不访问真实网络（fetchImpl 必须注入）；不写配置文件。
// 本模块是隔离预览原型，不能替代原版 Codex/Desktop 的官方登录，也不把 mock 当真实资格。

import { redactGrantForStatus, SIWC_REQUIRED_SCOPES } from './capabilities.js'
import { assertRegistration, OAuthError, refreshAccessToken, revokeToken } from './oauth.js'

export function createMemoryGrantStore() {
  const map = new Map()
  return {
    get(key) { return map.get(key) || null },
    set(key, record) { map.set(key, record); return record },
    delete(key) { return map.delete(key) },
    keys() { return [...map.keys()] },
    get size() { return map.size },
  }
}

export function registrationKey(registration) {
  assertRegistration(registration)
  // 不按邮箱合并：account + workspace 是独立授权域。
  return registration.accountId + '\u0000' + registration.workspaceId
}

function normalizeScopes(grant) {
  return grant && Array.isArray(grant.scope) ? grant.scope.slice() : []
}

function requiredScopesOf(registration) {
  return Array.isArray(registration.requiredScopes) && registration.requiredScopes.length
    ? registration.requiredScopes
    : SIWC_REQUIRED_SCOPES
}

function missingScopes(registration, grant) {
  const have = normalizeScopes(grant)
  return requiredScopesOf(registration).filter((scope) => !have.includes(scope))
}

export function createSessionManager(options = {}) {
  const store = options.store || createMemoryGrantStore()
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const skewMs = Number.isFinite(options.skewMs) ? Number(options.skewMs) : 60_000
  const fetchImpl = options.fetchImpl
  const logger = options.logger && typeof options.logger.warn === 'function' ? options.logger : null
  const inflight = new Map()

  function warn(code) {
    if (logger) { try { logger.warn('siwc_session', code) } catch { /* logger must not break auth */ } }
  }

  function leaseOf(record, key) {
    const grant = record.grant
    return {
      status: 'OK',
      registrationKey: key,
      accessToken: grant.accessToken,
      expiresAt: grant.expiresAt,
      scopes: normalizeScopes(grant),
      endpoint: typeof record.registration.resourceEndpoint === 'string' ? record.registration.resourceEndpoint : '',
      allowRedirect: false,
      fixedOrigin: true,
    }
  }

  function signIn({ registration, grant } = {}) {
    assertRegistration(registration)
    if (!grant || typeof grant !== 'object' || typeof grant.accessToken !== 'string' || grant.accessToken === '') {
      throw new OAuthError('invalid_grant', '缺少可用的 access token')
    }
    const missing = missingScopes(registration, grant)
    if (missing.length) throw new OAuthError('missing_scope', '授权缺少必需 scope', { missingScopes: missing })
    const key = registrationKey(registration)
    store.set(key, { registration, grant, revoked: false })
    return { status: 'SIGNED_IN', registrationKey: key, scopes: normalizeScopes(grant) }
  }

  async function refreshSingleFlight(key, registration) {
    const existing = inflight.get(key)
    if (existing) return existing
    const task = (async () => {
      const record = store.get(key)
      if (!record || !record.grant || record.revoked) return { status: 'SIGN_IN_REQUIRED' }
      if (now() + skewMs < record.grant.expiresAt) return leaseOf(record, key)
      try {
        const grant = await refreshAccessToken({ registration: record.registration, grant: record.grant, fetchImpl, now: now() })
        const fresh = store.get(key)
        // 登出/撤销可能发生在刷新途中：不得把新 token 写回已停止 admission 的记录。
        if (!fresh || fresh.revoked || !fresh.grant) return { status: 'SIGN_IN_REQUIRED' }
        store.set(key, { registration: fresh.registration, grant, revoked: false })
        return leaseOf({ registration: fresh.registration, grant }, key)
      } catch (error) {
        const code = error instanceof OAuthError ? error.code : 'refresh_failed'
        warn(code)
        if (code === 'invalid_grant' || code === 'invalid_client' || code === 'revoked') {
          store.delete(key)
          return { status: 'SIGN_IN_REQUIRED', reason: code }
        }
        if (code === 'missing_scope') return { status: 'SCOPE_MISSING', reason: code, missingScopes: error.missingScopes || [] }
        // 网络/5xx/未知：保留 grant，等下一次请求重试；不自动切账号、不清理用户的登录。
        return { status: 'TEMPORARILY_UNAVAILABLE', reason: code }
      }
    })().finally(() => { inflight.delete(key) })
    inflight.set(key, task)
    return task
  }

  async function getSession(registration) {
    assertRegistration(registration)
    const key = registrationKey(registration)
    const record = store.get(key)
    if (!record || !record.grant || record.revoked) return { status: 'SIGN_IN_REQUIRED' }
    if (now() + skewMs < record.grant.expiresAt) return leaseOf(record, key)
    return refreshSingleFlight(key, registration)
  }

  async function logout(registration) {
    assertRegistration(registration)
    const key = registrationKey(registration)
    const record = store.get(key)
    if (!record) return { status: 'SIGNED_OUT', registrationKey: key, registrationRetained: false, remoteRevocation: 'not_applicable' }
    // 先停止 admission（撤销后的并发 getSession 不再拿租约），再做有界远端撤销。
    store.set(key, { registration: record.registration, grant: null, revoked: true })
    const result = record.grant ? await revokeToken({ registration: record.registration, grant: record.grant, fetchImpl }) : { ok: false, remote: 'not_applicable' }
    store.set(key, { registration: record.registration, grant: null, revoked: true })
    return {
      status: 'SIGNED_OUT',
      registrationKey: key,
      registrationRetained: true,
      remoteRevocation: result.remote === 'confirmed' ? 'confirmed' : 'unconfirmed',
    }
  }

  function status(registration) {
    assertRegistration(registration)
    const key = registrationKey(registration)
    return Object.assign(redactGrantForStatus(store.get(key)), { registrationKey: key })
  }

  return { signIn, getSession, logout, status, store, get inflightCount() { return inflight.size } }
}
