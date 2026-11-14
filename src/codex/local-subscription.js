// P09：本机 Codex 登录态（只读）承载父侧订阅凭据。
//
// 只在 providers.<id>.gatewaySubscription.enabled === true、网关只监听 loopback、
// 目标为官方 host 的 /backend-api/codex 时使用。读取 CODEX_HOME/auth.json（或 ~/.codex/auth.json）
// 的 tokens.access_token，仅用于官方父模型请求。
//
// 硬边界：只读、不刷新、不持久化；不记录 token/account id/文件正文；不交给第三方；
// 过期/缺失/API Key 模式 → subscription_credential_unavailable，零上游、不重试、不换账号。
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { isLoopbackHost, isOfficialHost } from './identity.js'

export const SUBSCRIPTION_CREDENTIAL_UNAVAILABLE = 'subscription_credential_unavailable'
export const GATEWAY_SUBSCRIPTION_HOSTS = Object.freeze(['chatgpt.com', 'chat.openai.com'])
// codex-subscription 域只有一个入口：官方订阅后端 /backend-api/codex（默认 responses 子路径）。
export const SUBSCRIPTION_ENTRY = '/backend-api/codex'
export const SUBSCRIPTION_RESPONSES_PATH = '/backend-api/codex/responses'
const MAX_AUTH_BYTES = 1024 * 1024
const EXPIRY_SKEW_MS = 30000

// 稳定、脱敏的失败原因：对外仍是同一个 code/status（既有调用方与测试不变），
// 内部诊断可以据此区分「没登录 / 文件坏了 / 过期 / 这是 API Key 模式」，且永不含 token 或路径。
export const SUBSCRIPTION_CREDENTIAL_REASONS = Object.freeze({
  HOME_UNRESOLVED: 'codex_home_unresolved',
  FILE_MISSING: 'auth_file_missing',
  FILE_UNREADABLE: 'auth_file_unreadable',
  FILE_TOO_LARGE: 'auth_file_too_large',
  FILE_INVALID: 'auth_file_invalid',
  TOKEN_MISSING: 'access_token_missing',
  TOKEN_EXPIRED: 'access_token_expired',
  API_KEY_MODE: 'api_key_mode',
})

export class SubscriptionCredentialError extends Error {
  constructor(message, reason) {
    super(message || '本机 Codex 登录凭据不可用')
    this.name = 'SubscriptionCredentialError'
    this.code = SUBSCRIPTION_CREDENTIAL_UNAVAILABLE
    this.status = 401
    if (reason) this.reason = String(reason)
  }
}
function unavailable(reason) { throw new SubscriptionCredentialError(undefined, reason) }

function authPathFromEnv(env) {
  const e = env || process.env || {}
  const home = typeof e.HOME === 'string' ? e.HOME.trim() : ''
  const codexHome = typeof e.CODEX_HOME === 'string' && e.CODEX_HOME.trim() !== '' ? e.CODEX_HOME.trim() : (home ? join(home, '.codex') : '')
  if (codexHome === '') unavailable(SUBSCRIPTION_CREDENTIAL_REASONS.HOME_UNRESOLVED)
  return join(codexHome, 'auth.json')
}
function decodeJwtPayload(token) {
  const parts = String(token).split('.')
  if (parts.length !== 3) return null
  try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) } catch { return null }
}
function tokenFrom(value) {
  if (typeof value !== 'string') return ''
  const v = value.trim()
  return v === '' ? '' : v.replace(/^Bearer\s+/i, '')
}

/** 只读本机 Codex auth.json；返回一次性凭据对象，任何失败均抛同一稳定 code。 */
export function readSubscriptionCredential(options = {}) {
  const env = options.env || process.env || {}
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now()
  const path = authPathFromEnv(env)
  let raw
  try {
    const st = statSync(path)
    if (!st.isFile()) unavailable(SUBSCRIPTION_CREDENTIAL_REASONS.FILE_UNREADABLE)
    if (st.size > MAX_AUTH_BYTES) unavailable(SUBSCRIPTION_CREDENTIAL_REASONS.FILE_TOO_LARGE)
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if (error instanceof SubscriptionCredentialError) throw error
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) unavailable(SUBSCRIPTION_CREDENTIAL_REASONS.FILE_MISSING)
    unavailable(SUBSCRIPTION_CREDENTIAL_REASONS.FILE_UNREADABLE)
  }
  let parsed
  try { parsed = JSON.parse(raw) } catch { unavailable(SUBSCRIPTION_CREDENTIAL_REASONS.FILE_INVALID) }
  if (!parsed || typeof parsed !== 'object') unavailable(SUBSCRIPTION_CREDENTIAL_REASONS.FILE_INVALID)
  const tokens = parsed.tokens && typeof parsed.tokens === 'object' ? parsed.tokens : (parsed.auth && typeof parsed.auth === 'object' ? parsed.auth : parsed)
  const accessToken = tokenFrom(tokens.access_token || tokens.accessToken || parsed.access_token || parsed.accessToken)
  // API Key 模式的 Codex 登录没有订阅 token：这是「域不匹配」，不是「凭据过期」，绝不回退成 API Key。
  if (accessToken === '') {
    unavailable(parsed.OPENAI_API_KEY || parsed.api_key || parsed.apiKey
      ? SUBSCRIPTION_CREDENTIAL_REASONS.API_KEY_MODE
      : SUBSCRIPTION_CREDENTIAL_REASONS.TOKEN_MISSING)
  }
  const accountId = tokens.account_id || tokens.accountId || tokens.chatgpt_account_id || parsed.account_id || parsed.chatgpt_account_id || ''
  const claims = decodeJwtPayload(accessToken)
  const expSec = claims && Number(claims.exp)
  const expiresAt = Number.isFinite(expSec) && expSec > 0 ? expSec * 1000 : null
  if (expiresAt !== null && expiresAt <= now + EXPIRY_SKEW_MS) unavailable(SUBSCRIPTION_CREDENTIAL_REASONS.TOKEN_EXPIRED)
  return {
    authorization: 'Bearer ' + accessToken,
    accountId: typeof accountId === 'string' ? accountId : '',
    expiresAt,
    source: 'codex_auth_json',
  }
}

/** 只允许官方 host 的订阅入口；loopback 例外仅用于本机 mock/测试。 */
export function isGatewaySubscriptionTarget(identity, path, cfg) {
  if (!identity || identity.kind !== 'official') return false
  const host = String(identity.host || '').toLowerCase()
  if (!isOfficialHost(host, cfg)) return false
  if (!GATEWAY_SUBSCRIPTION_HOSTS.includes(host) && !isLoopbackHost(host)) return false
  return isSubscriptionEntryPath(path)
}

export function isSubscriptionEntryPath(path) {
  const p = String(path == null ? '' : path)
  return p === SUBSCRIPTION_ENTRY || p.startsWith(SUBSCRIPTION_ENTRY + '/')
}

// —— codex-subscription 路径契约（纯判定，零发送） ——
// 把 P09 现有的四条硬边界收成一个可复用、可测试的 typed deny，供 resolveUpstream/接线复用：
//   loopback 监听 + loopback 客户端、官方身份、订阅入口路径、不得与 api-key / siwc-app 混用。
// 返回 null = 通过；否则 { status:403, code, message, deny:true }，消息只含 host/路径，绝不含凭据。
export const SUBSCRIPTION_PATH_CODES = Object.freeze({
  NOT_LOOPBACK: 'gateway_subscription_not_loopback',
  TARGET_NOT_ALLOWED: 'gateway_subscription_target_not_allowed',
  PATH_NOT_ALLOWED: 'gateway_subscription_path_not_allowed',
  API_KEY_CONFLICT: 'gateway_subscription_api_key_conflict',
  DOMAIN_CONFLICT: 'auth_domain_conflict',
})

export function subscriptionPathDeny(opts = {}) {
  const o = opts
  if (o.enabled !== true) return null
  const deny = (code, message) => ({ status: 403, code, message, deny: true })
  if (o.listenerLoopback !== true || o.peerLoopback !== true) {
    return deny(SUBSCRIPTION_PATH_CODES.NOT_LOOPBACK, 'gatewaySubscription 只允许 loopback 监听与 loopback 客户端')
  }
  if (o.siwcApp === true) {
    return deny(SUBSCRIPTION_PATH_CODES.DOMAIN_CONFLICT, '同一 provider 同时声明 gatewaySubscription 与 SIWC 应用授权：授权域互斥，请移除其一')
  }
  if (o.apiKeyPresent === true) {
    return deny(SUBSCRIPTION_PATH_CODES.API_KEY_CONFLICT, 'gatewaySubscription 与网关自有 key 同时存在：计费身份会混用，请移除其一')
  }
  if (o.identityKind !== 'official') {
    return deny(SUBSCRIPTION_PATH_CODES.TARGET_NOT_ALLOWED, 'gatewaySubscription 只允许官方目标（当前身份域：' + String(o.identityKind || 'unknown') + '）')
  }
  const host = String(o.host == null ? '' : o.host).trim().toLowerCase()
  if (!GATEWAY_SUBSCRIPTION_HOSTS.includes(host) && !isLoopbackHost(host)) {
    return deny(SUBSCRIPTION_PATH_CODES.TARGET_NOT_ALLOWED, 'gatewaySubscription 只允许官方订阅 host：' + (host || '?') + '（允许 ' + GATEWAY_SUBSCRIPTION_HOSTS.join(', ') + '，本机 mock 可用 loopback）')
  }
  const path = String(o.path == null ? '' : o.path)
  if (!isSubscriptionEntryPath(path)) {
    return deny(SUBSCRIPTION_PATH_CODES.PATH_NOT_ALLOWED, 'gatewaySubscription 只允许 ' + SUBSCRIPTION_ENTRY + ' 入口：' + (path || '?'))
  }
  return null
}
