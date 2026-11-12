// SIWC 自有预览客户端的能力门（P07 原型）。
//
// 边界：默认 off；没有满足条件的自有客户端就不暴露登录。真实 OAuth / 真实账户 / 真实端点均不在本模块执行。
// 该模块只做纯判定与环境构造：不读 HOME/auth、不联网、不写文件。
//
// 证据边界：官方 SIWC 文档描述的是预览契约；本仓库没有真实注册/工作区/客户端资格，
// 因此 scope 名称、端点与资格都只作为**合成合同**测试，真实资格 UNKNOWN。

export const SIWC_PREVIEW_VERSION = 1
export const SIWC_REQUIRED_SCOPES = Object.freeze(['resource.invoke', 'chatgpt.tokens.use.direct'])
export const SIWC_ALLOWED_LAUNCH_TARGETS = Object.freeze(['app-server'])

const SAFE_ENV_KEYS = new Set(['PATH', 'HOME', 'TMPDIR', 'TMP', 'LANG', 'LC_ALL', 'TZ', 'USER', 'SHELL'])

export function isLoopbackRedirect(uri) {
  if (typeof uri !== 'string' || uri === '') return false
  let u
  try { u = new URL(uri) } catch { return false }
  if (u.protocol !== 'http:') return false
  if (u.username !== '' || u.password !== '') return false
  const host = u.hostname
  return host === '127.0.0.1' || host === '::1' || host === '[::1]' || host === 'localhost'
}

function isHttpsUrl(value) {
  if (typeof value !== 'string' || value === '') return false
  let u
  try { u = new URL(value) } catch { return false }
  return u.protocol === 'https:' && u.username === '' && u.password === ''
}

export function evaluatePreviewEligibility(input = {}) {
  const enabled = input.enabled === true
  const client = input.client && typeof input.client === 'object' ? input.client : null
  const registration = input.registration && typeof input.registration === 'object' ? input.registration : null
  const requiredScopes = Array.isArray(input.requiredScopes) && input.requiredScopes.length ? input.requiredScopes : SIWC_REQUIRED_SCOPES
  const reasons = []

  if (!enabled) reasons.push('preview_disabled')
  if (!client || client.kind !== 'own-preview-client') reasons.push('client_not_qualified')
  else {
    if (typeof client.version !== 'string' || client.version === '') reasons.push('client_version_missing')
    if (typeof client.appId !== 'string' || client.appId === '') reasons.push('client_app_id_missing')
    if (typeof client.hostId !== 'string' || client.hostId === '') reasons.push('client_host_id_missing')
    if (client.loopbackOnly !== true) reasons.push('client_not_loopback_only')
  }
  if (!registration) reasons.push('registration_missing')
  else {
    if (typeof registration.accountId !== 'string' || registration.accountId === '') reasons.push('registration_account_missing')
    if (typeof registration.workspaceId !== 'string' || registration.workspaceId === '') reasons.push('registration_workspace_missing')
    if (typeof registration.clientId !== 'string' || registration.clientId === '') reasons.push('registration_client_missing')
    if (!isHttpsUrl(registration.issuer)) reasons.push('registration_issuer_not_https')
    if (!isHttpsUrl(registration.authorizationEndpoint)) reasons.push('registration_authorize_not_https')
    if (!isHttpsUrl(registration.tokenEndpoint)) reasons.push('registration_token_not_https')
    if (!isLoopbackRedirect(registration.redirectUri)) reasons.push('registration_redirect_not_loopback')
  }
  const haveScopes = registration && Array.isArray(registration.scopes) ? registration.scopes : []
  const missingScopes = requiredScopes.filter((scope) => !haveScopes.includes(scope))
  if (registration && missingScopes.length) reasons.push('missing_scope')

  const available = reasons.length === 0
  return {
    version: SIWC_PREVIEW_VERSION,
    mode: 'siwc_preview',
    available,
    loginExposed: available,
    reason: available ? 'preview_ready' : reasons[0],
    reasons,
    missingScopes,
    requiredScopes: requiredScopes.slice(),
  }
}

function safeBaseEnv(baseEnv) {
  const out = {}
  if (!baseEnv || typeof baseEnv !== 'object') return out
  for (const [key, value] of Object.entries(baseEnv)) {
    if (!SAFE_ENV_KEYS.has(key)) continue
    if (typeof value !== 'string') continue
    out[key] = value
  }
  return out
}

/**
 * 隔离 launcher/工具环境：令牌只注入允许的 app-server 子进程。
 * 任何 tool/shell/mcp 目标都拿不到 access/refresh token；refresh token 永不进入环境变量。
 * baseEnv 只按白名单复制，避免宿主 OPENAI_ / CODEX_ / SIWC_ 前缀变量泄入子进程。
 */
export function buildLauncherEnv({ target, grant, baseEnv } = {}) {
  const env = safeBaseEnv(baseEnv)
  if (!SIWC_ALLOWED_LAUNCH_TARGETS.includes(target)) {
    return { target: String(target || ''), env, tokenExposed: false, refreshTokenExposed: false, reason: 'target_not_allowed' }
  }
  const accessToken = grant && typeof grant.accessToken === 'string' ? grant.accessToken : ''
  if (accessToken === '') {
    return { target, env, tokenExposed: false, refreshTokenExposed: false, reason: 'lease_missing' }
  }
  env.SIWC_ACCESS_TOKEN = accessToken
  return { target, env, tokenExposed: true, refreshTokenExposed: false, reason: 'ok' }
}

export function redactGrantForStatus(record) {
  const grant = record && record.grant ? record.grant : null
  return {
    status: record ? (record.revoked ? 'SIGNED_OUT' : (grant ? 'SIGNED_IN' : 'SIGN_IN_REQUIRED')) : 'SIGN_IN_REQUIRED',
    expiresAt: grant && Number.isFinite(grant.expiresAt) ? grant.expiresAt : null,
    scopes: grant && Array.isArray(grant.scope) ? grant.scope.slice() : [],
    hasAccessToken: !!(grant && grant.accessToken),
    hasRefreshToken: !!(grant && grant.refreshToken),
  }
}
