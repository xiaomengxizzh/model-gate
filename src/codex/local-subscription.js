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
const MAX_AUTH_BYTES = 1024 * 1024
const EXPIRY_SKEW_MS = 30000

export class SubscriptionCredentialError extends Error {
  constructor(message) {
    super(message || '本机 Codex 登录凭据不可用')
    this.name = 'SubscriptionCredentialError'
    this.code = SUBSCRIPTION_CREDENTIAL_UNAVAILABLE
    this.status = 401
  }
}
function unavailable() { throw new SubscriptionCredentialError() }

function authPathFromEnv(env) {
  const e = env || process.env || {}
  const home = typeof e.HOME === 'string' ? e.HOME.trim() : ''
  const codexHome = typeof e.CODEX_HOME === 'string' && e.CODEX_HOME.trim() !== '' ? e.CODEX_HOME.trim() : (home ? join(home, '.codex') : '')
  if (codexHome === '') unavailable()
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
    if (!st.isFile() || st.size > MAX_AUTH_BYTES) unavailable()
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if (error instanceof SubscriptionCredentialError) throw error
    unavailable()
  }
  let parsed
  try { parsed = JSON.parse(raw) } catch { unavailable() }
  if (!parsed || typeof parsed !== 'object') unavailable()
  const tokens = parsed.tokens && typeof parsed.tokens === 'object' ? parsed.tokens : (parsed.auth && typeof parsed.auth === 'object' ? parsed.auth : parsed)
  const accessToken = tokenFrom(tokens.access_token || tokens.accessToken || parsed.access_token || parsed.accessToken)
  if (accessToken === '') unavailable()
  const accountId = tokens.account_id || tokens.accountId || tokens.chatgpt_account_id || parsed.account_id || parsed.chatgpt_account_id || ''
  const claims = decodeJwtPayload(accessToken)
  const expSec = claims && Number(claims.exp)
  const expiresAt = Number.isFinite(expSec) && expSec > 0 ? expSec * 1000 : null
  if (expiresAt !== null && expiresAt <= now + EXPIRY_SKEW_MS) unavailable()
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
  return String(path || '').startsWith('/backend-api/codex')
}
