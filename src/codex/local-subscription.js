// P09：本机 Codex 登录态（只读）承载父侧订阅凭据。
//
// 只在 providers.<id>.gatewaySubscription.enabled === true、网关只监听 loopback、
// 目标为官方 host 的 /backend-api/codex 时使用。读取 CODEX_HOME/auth.json（或 ~/.codex/auth.json）
// 的 tokens.access_token，仅用于官方父模型请求。
//
// 硬边界（请求路径）：只读、不刷新、不持久化；不记录 token/account id/文件正文；不交给第三方；
// 过期/缺失/API Key 模式 → subscription_credential_unavailable，零上游、不重试、不换账号。
//
// V2-REAL-3（A4，策略 A）在此基础上增加两件**纯增量**能力，且不改变上面的请求路径语义：
//   1) 订阅模式判定（auto/local/app/off）与配置生成——纯判定，不发请求、不写文件；
//   2) `refreshLocalSubscriptionCredential()`：只有当桌面启动器显式调用时才刷新过期 token，
//      写入前做 compare-and-swap，写入为同目录 0600 原子替换；请求路径仍然只读。
//   所有新增错误的 code 仍是 subscription_credential_unavailable，只有 reason 更细；永不回显 token。
import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { isLoopbackHost, isOfficialHost } from './identity.js'
import { refreshAccessToken } from '../subscription/oauth.js'

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
  AUTH_MODE_MISSING: 'auth_mode_missing',
  AUTH_MODE_NOT_CHATGPT: 'auth_mode_not_chatgpt',
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

// ————————————————————————————————————————————————————————————————————————————
// V2-REAL-3（A4）：Desktop 订阅模式（所有者策略 A —— 默认复用本机 Codex 登录）
//
//   MG_DESKTOP_SUBSCRIPTION_MODE=auto|local|app|off（默认 auto）
//     auto  —— 本机 auth.json 是 chatgpt 模式且有 access_token → local；否则 app
//     local —— 强制订阅入口：chatgpt.com + /backend-api/codex + gatewaySubscription；
//              无本机登录 → typed subscription_login_missing（fail-closed，绝不静默切 app）
//     app   —— 应用自有 OAuth：grant.json + api.openai.com；未 sign-in 由启动器明确报错
//     off   —— 不写 gatewaySubscription / responsesPath：官方请求回到「需网关自有 key」，
//              由 targetDeny 返回 typed 403 official_no_gateway_key（零上游、绝不换路径）
//
// 本段只做判定与探测：探测只读、只回 reason/布尔，**不返回也不需要 token**。
// ————————————————————————————————————————————————————————————————————————————
export const DESKTOP_SUBSCRIPTION_MODE_ENV = 'MG_DESKTOP_SUBSCRIPTION_MODE'
export const DESKTOP_SUBSCRIPTION_MODES = Object.freeze(['auto', 'local', 'app', 'off'])
export const CHATGPT_BASE_URL = 'https://chatgpt.com'
export const OPENAI_API_BASE_URL = 'https://api.openai.com'

export class SubscriptionModeError extends Error {
  constructor(code, message, extra) {
    super(message || code)
    this.name = 'SubscriptionModeError'
    this.code = String(code)
    // 非法配置 = 400；"配置与现场不一致、需要用户动作"（例如 local 模式无登录）= 409。
    this.status = extra && Number.isFinite(extra.status) ? Number(extra.status) : (this.code === 'subscription_login_missing' ? 409 : 400)
    this.deny = true
    if (extra && typeof extra === 'object') {
      if (extra.reason !== undefined) this.reason = extra.reason
      if (extra.requested !== undefined) this.requested = extra.requested
    }
  }
}

export function isSubscriptionModeError(error) {
  return !!(error && error.deny === true && error.name === 'SubscriptionModeError' && typeof error.code === 'string')
}

function modeProbe(reason, authMode) {
  return Object.freeze({ available: false, reason, authMode: authMode == null ? null : String(authMode) })
}

/**
 * 探测本机 Codex 登录（只读、不返回 token）。判定条件与策略 A 一致：
 * auth_mode === 'chatgpt' 且 tokens.access_token 非空。
 */
export function probeLocalCodexAuth(options = {}) {
  const env = options.env || process.env || {}
  let path
  try { path = authPathFromEnv(env) } catch (error) {
    return modeProbe(error && error.reason ? error.reason : SUBSCRIPTION_CREDENTIAL_REASONS.HOME_UNRESOLVED)
  }
  let raw
  try {
    const st = statSync(path)
    if (!st.isFile()) return modeProbe(SUBSCRIPTION_CREDENTIAL_REASONS.FILE_UNREADABLE)
    if (st.size > MAX_AUTH_BYTES) return modeProbe(SUBSCRIPTION_CREDENTIAL_REASONS.FILE_TOO_LARGE)
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return modeProbe(SUBSCRIPTION_CREDENTIAL_REASONS.FILE_MISSING)
    return modeProbe(SUBSCRIPTION_CREDENTIAL_REASONS.FILE_UNREADABLE)
  }
  let parsed
  try { parsed = JSON.parse(raw) } catch { return modeProbe(SUBSCRIPTION_CREDENTIAL_REASONS.FILE_INVALID) }
  if (!parsed || typeof parsed !== 'object') return modeProbe(SUBSCRIPTION_CREDENTIAL_REASONS.FILE_INVALID)
  const authMode = typeof parsed.auth_mode === 'string' ? parsed.auth_mode.trim().toLowerCase() : null
  if (authMode !== 'chatgpt') {
    return modeProbe(authMode == null ? SUBSCRIPTION_CREDENTIAL_REASONS.AUTH_MODE_MISSING : SUBSCRIPTION_CREDENTIAL_REASONS.AUTH_MODE_NOT_CHATGPT, authMode)
  }
  const tokens = parsed.tokens && typeof parsed.tokens === 'object' ? parsed.tokens : {}
  const accessToken = tokenFrom(tokens.access_token || tokens.accessToken)
  if (accessToken === '') {
    return modeProbe(parsed.OPENAI_API_KEY || parsed.api_key || parsed.apiKey
      ? SUBSCRIPTION_CREDENTIAL_REASONS.API_KEY_MODE
      : SUBSCRIPTION_CREDENTIAL_REASONS.TOKEN_MISSING, authMode)
  }
  return Object.freeze({ available: true, reason: 'local_codex_chatgpt', authMode })
}

/**
 * 解析订阅模式（纯判定，probe 可注入以便离线测试）。
 * 返回冻结描述：实际 mode、来源 requested、原因、是否用本机登录/应用授权、是否写订阅字段。
 * local 模式缺登录、或 requested 非法时抛 typed SubscriptionModeError（绝不静默降级）。
 */
export function resolveSubscriptionMode(options = {}) {
  const env = options.env || process.env || {}
  const raw = options.mode !== undefined ? options.mode : env[DESKTOP_SUBSCRIPTION_MODE_ENV]
  const requested = raw == null || String(raw).trim() === '' ? 'auto' : String(raw).trim().toLowerCase()
  if (!DESKTOP_SUBSCRIPTION_MODES.includes(requested)) {
    throw new SubscriptionModeError('subscription_mode_invalid', '未知订阅模式：' + String(raw) + '（允许 auto/local/app/off）', { requested })
  }
  const probe = () => (typeof options.probe === 'function'
    ? options.probe()
    : probeLocalCodexAuth({ env }))
  const describe = (mode, reason, localAuth) => Object.freeze({
    requested,
    mode,
    reason,
    localAuthAvailable: localAuth.available === true,
    localAuthReason: localAuth.reason == null ? null : String(localAuth.reason),
    usesLocalAuth: mode === 'local',
    usesPlanToken: mode === 'app',
    writesSubscriptionFields: mode === 'local',
  })
  if (requested === 'off') return describe('off', 'explicit_off', { available: false })
  if (requested === 'app') return describe('app', 'explicit_app', { available: false })
  const localAuth = probe()
  if (requested === 'local') {
    if (!localAuth.available) {
      throw new SubscriptionModeError('subscription_login_missing',
        'local 模式要求本机 Codex 登录（CODEX_HOME/auth.json：auth_mode=chatgpt 且 tokens.access_token 非空），当前状态：' + String(localAuth.reason || 'unknown') +
        '。请先在 Codex 中登录，或显式改用 MG_DESKTOP_SUBSCRIPTION_MODE=off（需网关自有 key）或 app（应用自有 OAuth）。',
        { reason: localAuth.reason || null, requested })
    }
    return describe('local', 'explicit_local', localAuth)
  }
  return localAuth.available
    ? describe('local', 'auto_local_login', localAuth)
    : describe('app', 'auto_no_local_login', localAuth)
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

/**
 * 按已解析的模式生成官方父 provider 的配置块（写配置的唯一真源）。
 *   local：baseUrl=chatgpt.com + responsesPath=/backend-api/codex/responses + gatewaySubscription.enabled
 *   app / off：baseUrl=api.openai.com，且**不写** responsesPath / gatewaySubscription
 * off 与 app 的 provider 形状相同、运行时凭据来源不同（off 不注入 plan token）。
 */
export function buildSubscriptionProviderConfig(mode, options = {}) {
  const m = String(mode == null ? '' : mode).trim().toLowerCase()
  if (!['local', 'app', 'off'].includes(m)) {
    throw new SubscriptionModeError('subscription_mode_invalid', '未知运行模式：' + String(mode) + '（允许 local/app/off）', { requested: mode })
  }
  const provider = m === 'local'
    ? {
      baseUrl: CHATGPT_BASE_URL,
      codexIdentity: 'official',
      responsesPath: SUBSCRIPTION_RESPONSES_PATH,
      gatewaySubscription: { enabled: true },
    }
    : { baseUrl: OPENAI_API_BASE_URL, codexIdentity: 'official' }
  return Object.freeze({
    provider: deepFreeze(provider),
    meta: Object.freeze({
      mode: m,
      usesLocalAuth: m === 'local',
      usesPlanToken: m === 'app',
      writesSubscriptionFields: m === 'local',
      responsesPath: m === 'local' ? SUBSCRIPTION_RESPONSES_PATH : null,
    }),
  })
}

// ————————————————————————————————————————————————————————————————————————————
// V2-REAL-3（A4）：过期 token 刷新 + auth.json 0600 原子回写（compare-and-swap）
//
// 调用者只有桌面启动器（bin/mg-desktop.mjs）：网关请求路径仍然只读（readSubscriptionCredential
// 绝不写盘）。刷新失败一律抛 subscription_credential_unavailable（reason 更细），不写文件、
// 不回显 token/refresh token/文件正文。
//
// CAS 语义（防并发改写用户登录态）：
//   1. 读取时记录内容 sha256；
//   2. 刷新在**内存**里完成后，先重读文件复核 sha256（可选 beforeCommit 钩子在此前运行）；
//   3. 内容已变化 → 放弃回写，抛 auth_file_concurrent_change（保留新的只读语义）；
//   4. 未变化 → 同目录临时文件（0600、fsync）→ rename 原子替换 → 目录里不残留半截文件。
// ————————————————————————————————————————————————————————————————————————————
export const SUBSCRIPTION_OAUTH_CLIENT_ENV = 'MG_CODEX_OAUTH_CLIENT_ID'
// Codex CLI 的 OAuth **公开客户端 ID**（非密钥）；允许用 MG_CODEX_OAUTH_CLIENT_ID 覆盖。
export const SUBSCRIPTION_OAUTH_CLIENT_DEFAULT = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const SUBSCRIPTION_OAUTH_TOKEN_ENDPOINT_ENV = 'MG_CODEX_OAUTH_TOKEN_ENDPOINT'
export const SUBSCRIPTION_OAUTH_TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token'
export const SUBSCRIPTION_OAUTH_ISSUER = 'https://auth.openai.com'
export const SUBSCRIPTION_OAUTH_REDIRECT_URI = 'http://localhost:1455/auth/callback'
export const SUBSCRIPTION_OAUTH_SCOPES = Object.freeze(['openid', 'profile', 'email', 'offline_access'])

export const SUBSCRIPTION_REFRESH_REASONS = Object.freeze({
  NOT_EXPIRED: 'not_expired',
  REFRESHED: 'refreshed',
  REFRESH_TOKEN_MISSING: 'refresh_token_missing',
  REFRESH_FAILED: 'refresh_failed',
  CONCURRENT_CHANGE: 'auth_file_concurrent_change',
  WRITE_FAILED: 'auth_file_write_failed',
  SYMLINK_REFUSED: 'auth_file_symlink_refused',
})

function sha256Of(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function refreshUnavailable(reason) {
  return new SubscriptionCredentialError(undefined, reason)
}

function tokensOf(parsed) {
  if (parsed && parsed.tokens && typeof parsed.tokens === 'object') return parsed.tokens
  if (parsed && parsed.auth && typeof parsed.auth === 'object') return parsed.auth
  return parsed && typeof parsed === 'object' ? parsed : {}
}

function authFileSnapshot(path) {
  let st
  let raw
  try {
    st = lstatSync(path)
    if (st.isSymbolicLink()) throw refreshUnavailable(SUBSCRIPTION_REFRESH_REASONS.SYMLINK_REFUSED)
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
  return Object.freeze({ raw, parsed, sig: Object.freeze({ sha256: sha256Of(raw), size: st.size, mode: st.mode & 0o777 }) })
}

// CAS 复核：内容哈希变化即放弃回写（并发改写优先于我们的刷新结果）。
function assertFileUnchanged(path, snapshot) {
  let raw
  try {
    if (lstatSync(path).isSymbolicLink()) throw refreshUnavailable(SUBSCRIPTION_REFRESH_REASONS.SYMLINK_REFUSED)
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if (error instanceof SubscriptionCredentialError) throw error
    throw refreshUnavailable(SUBSCRIPTION_REFRESH_REASONS.CONCURRENT_CHANGE)
  }
  if (sha256Of(raw) !== snapshot.sig.sha256) throw refreshUnavailable(SUBSCRIPTION_REFRESH_REASONS.CONCURRENT_CHANGE)
}

// 同目录 0600 临时文件 + fsync + rename：要么是旧文件，要么是完整新文件，不存在半截 auth.json。
function writeAuthAtomic(path, value) {
  const temporary = join(dirname(path), '.auth.json.' + process.pid + '.' + randomBytes(6).toString('hex') + '.tmp')
  let fd = null
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeSync(fd, JSON.stringify(value))
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(temporary, path)
  } catch (error) {
    if (fd !== null) { try { closeSync(fd) } catch { /* ignore */ } }
    try { unlinkSync(temporary) } catch { /* ignore */ }
    throw refreshUnavailable(SUBSCRIPTION_REFRESH_REASONS.WRITE_FAILED)
  }
}

function codexOAuthRegistration(input) {
  const { env, parsed, tokens, accessToken, options } = input
  const nonEmpty = (v) => typeof v === 'string' && v.trim() !== ''
  const claims = decodeJwtPayload(accessToken)
  const accountId = tokenFrom(tokens.account_id || tokens.accountId || tokens.chatgpt_account_id || parsed.account_id) ||
    (claims && typeof claims.sub === 'string' ? claims.sub : '') || 'codex-local'
  const clientId = nonEmpty(options.clientId) ? String(options.clientId).trim()
    : (nonEmpty(env[SUBSCRIPTION_OAUTH_CLIENT_ENV]) ? String(env[SUBSCRIPTION_OAUTH_CLIENT_ENV]).trim() : SUBSCRIPTION_OAUTH_CLIENT_DEFAULT)
  const tokenEndpoint = nonEmpty(options.tokenEndpoint) ? String(options.tokenEndpoint).trim()
    : (nonEmpty(env[SUBSCRIPTION_OAUTH_TOKEN_ENDPOINT_ENV]) ? String(env[SUBSCRIPTION_OAUTH_TOKEN_ENDPOINT_ENV]).trim() : SUBSCRIPTION_OAUTH_TOKEN_ENDPOINT)
  return {
    accountId,
    workspaceId: accountId,
    clientId,
    issuer: SUBSCRIPTION_OAUTH_ISSUER,
    authorizationEndpoint: SUBSCRIPTION_OAUTH_ISSUER + '/oauth/authorize',
    tokenEndpoint,
    redirectUri: SUBSCRIPTION_OAUTH_REDIRECT_URI,
    scopes: SUBSCRIPTION_OAUTH_SCOPES.slice(),
    requiredScopes: ['openid'],
  }
}

/**
 * 刷新本机 Codex 订阅 token（仅供桌面启动器显式调用）。
 * @returns {Readonly<{refreshed:boolean, reason:string, expiresAt:number|null, rotated:boolean}>}
 *          不返回、不记录 token；未到刷新窗口时不做任何网络请求。
 * @throws SubscriptionCredentialError（code=subscription_credential_unavailable，reason 细分）
 */
export async function refreshLocalSubscriptionCredential(options = {}) {
  const env = options.env || process.env || {}
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now()
  const skewMs = Number.isFinite(options.skewMs) ? Math.max(0, Number(options.skewMs)) : EXPIRY_SKEW_MS
  const path = authPathFromEnv(env)
  const snapshot = authFileSnapshot(path)
  const tokens = tokensOf(snapshot.parsed)
  const accessToken = tokenFrom(tokens.access_token || tokens.accessToken || snapshot.parsed.access_token)
  if (accessToken === '') {
    unavailable(snapshot.parsed.OPENAI_API_KEY || snapshot.parsed.api_key || snapshot.parsed.apiKey
      ? SUBSCRIPTION_CREDENTIAL_REASONS.API_KEY_MODE
      : SUBSCRIPTION_CREDENTIAL_REASONS.TOKEN_MISSING)
  }
  const claims = decodeJwtPayload(accessToken)
  const expSec = claims && Number(claims.exp)
  const expiresAt = Number.isFinite(expSec) && expSec > 0 ? expSec * 1000 : null
  if (expiresAt !== null && expiresAt > now + skewMs) {
    return Object.freeze({ refreshed: false, reason: SUBSCRIPTION_REFRESH_REASONS.NOT_EXPIRED, expiresAt, rotated: false })
  }
  const refreshToken = tokenFrom(tokens.refresh_token || tokens.refreshToken || snapshot.parsed.refresh_token)
  if (refreshToken === '') unavailable(SUBSCRIPTION_REFRESH_REASONS.REFRESH_TOKEN_MISSING)

  let grant
  try {
    grant = await refreshAccessToken({
      registration: codexOAuthRegistration({ env, parsed: snapshot.parsed, tokens, accessToken, options }),
      grant: { refreshToken, scope: SUBSCRIPTION_OAUTH_SCOPES.slice(), expiresAt },
      fetchImpl: options.fetchImpl,
      now,
    })
  } catch (error) {
    const reason = error && typeof error.code === 'string' && /^[a-z0-9_]{1,40}$/.test(error.code)
      ? 'refresh_' + error.code
      : SUBSCRIPTION_REFRESH_REASONS.REFRESH_FAILED
    throw refreshUnavailable(reason)
  }

  // 只在内存里构造新文档；未知字段原样保留（不重写用户其它 Codex 配置）。
  const nextTokens = Object.assign({}, tokens)
  nextTokens.access_token = grant.accessToken
  if (typeof grant.refreshToken === 'string' && grant.refreshToken !== '' && grant.refreshToken !== refreshToken) {
    nextTokens.refresh_token = grant.refreshToken
  }
  const nextDoc = Object.assign({}, snapshot.parsed, {
    tokens: nextTokens,
    last_refresh: new Date(now).toISOString(),
  })
  if (typeof options.beforeCommit === 'function') await options.beforeCommit({ expiresAt: grant.expiresAt, reason: SUBSCRIPTION_REFRESH_REASONS.REFRESHED })
  // CAS：刷新期间文件被并发改动 → 放弃回写，保留用户的登录态。
  assertFileUnchanged(path, snapshot)
  writeAuthAtomic(path, nextDoc)
  return Object.freeze({
    refreshed: true,
    reason: SUBSCRIPTION_REFRESH_REASONS.REFRESHED,
    expiresAt: grant.expiresAt,
    rotated: grant.rotated === true,
  })
}
