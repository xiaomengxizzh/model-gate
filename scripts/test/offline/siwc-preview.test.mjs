// P07: 合成 SIWC 本地预览原型（默认 off；仅虚构 OIDC mock；无真实 OAuth/网络/账户）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  SIWC_REQUIRED_SCOPES,
  buildLauncherEnv,
  evaluatePreviewEligibility,
  isLoopbackRedirect,
} from '../../../src/subscription/capabilities.js'
import {
  OAuthError,
  buildAuthorizationRequest,
  createPkcePair,
  exchangeAuthorizationCode,
  pkceChallengeForVerifier,
} from '../../../src/subscription/oauth.js'
import {
  createSessionManager,
  registrationKey,
} from '../../../src/subscription/session.js'
import { createOidcMock } from '../fixtures/siwc/oidc-mock.mjs'

const STATE = 'state-0123456789abcdef'
const NONCE = 'nonce-0123456789abcdef'

function previewClient(over = {}) {
  return Object.assign({
    kind: 'own-preview-client',
    version: '0.1.0-preview',
    appId: 'mg-preview',
    hostId: 'host-synthetic-1',
    loopbackOnly: true,
  }, over)
}

function makeAuth(mock, over = {}) {
  const pkce = createPkcePair()
  const state = over.state || STATE
  const nonce = over.nonce || NONCE
  const auth = buildAuthorizationRequest({
    registration: mock.registration,
    state,
    nonce,
    codeChallenge: pkce.codeChallenge,
    hostId: 'host-synthetic-1',
    appName: 'ModelGate Preview',
  })
  const authorized = mock.authorize({ state, nonce, codeChallenge: pkce.codeChallenge, scope: mock.registration.scopes })
  assert.ok(authorized.code, JSON.stringify(authorized))
  return { pkce, auth, state, nonce, code: authorized.code }
}

async function exchange(mock, auth, over = {}) {
  return exchangeAuthorizationCode(Object.assign({
    registration: mock.registration,
    code: auth.code,
    codeVerifier: auth.pkce.codeVerifier,
    state: auth.state,
    expectedState: auth.state,
    expectedNonce: auth.nonce,
    idTokenVerifier: mock.verifyIdToken,
    fetchImpl: mock.fetchImpl,
    now: mock.now(),
  }, over))
}

async function signedIn(mock, logger) {
  const auth = makeAuth(mock)
  const grant = await exchange(mock, auth)
  const manager = createSessionManager({ now: mock.now, fetchImpl: mock.fetchImpl, logger })
  manager.signIn({ registration: mock.registration, grant })
  return { auth, grant, manager }
}

test('P07 默认 off：即使客户端与注册都合格，也不暴露登录', () => {
  const mock = createOidcMock()
  const result = evaluatePreviewEligibility({ enabled: false, client: previewClient(), registration: mock.registration })
  assert.equal(result.available, false)
  assert.equal(result.loginExposed, false)
  assert.equal(result.reason, 'preview_disabled')
  assert.ok(result.reasons.includes('preview_disabled'))
})

test('P07 合格客户端 + 合格注册 + enabled 才可用', () => {
  const mock = createOidcMock()
  const result = evaluatePreviewEligibility({ enabled: true, client: previewClient(), registration: mock.registration })
  assert.equal(result.available, true)
  assert.equal(result.loginExposed, true)
  assert.equal(result.reason, 'preview_ready')
  assert.deepEqual(result.missingScopes, [])
  assert.deepEqual(result.requiredScopes, [...SIWC_REQUIRED_SCOPES])
})

test('P07 不合格客户端一律不暴露登录：缺版本/非自有预览/非 loopback', () => {
  const mock = createOidcMock()
  const cases = [
    previewClient({ kind: 'stock-codex' }),
    previewClient({ version: '' }),
    previewClient({ loopbackOnly: false }),
    null,
  ]
  for (const client of cases) {
    const result = evaluatePreviewEligibility({ enabled: true, client, registration: mock.registration })
    assert.equal(result.available, false, JSON.stringify(client))
    assert.equal(result.loginExposed, false)
  }
})

test('P07 缺 scope / 非 loopback 注册 / 非 https issuer 都会拒绝', () => {
  const mock = createOidcMock()
  const missing = Object.assign({}, mock.registration, { scopes: ['resource.invoke'] })
  const r1 = evaluatePreviewEligibility({ enabled: true, client: previewClient(), registration: missing })
  assert.equal(r1.available, false)
  assert.deepEqual(r1.missingScopes, ['chatgpt.tokens.use.direct'])
  const badRedirect = Object.assign({}, mock.registration, { redirectUri: 'https://evil.example/callback' })
  const r2 = evaluatePreviewEligibility({ enabled: true, client: previewClient(), registration: badRedirect })
  assert.equal(r2.available, false)
  assert.ok(r2.reasons.includes('registration_redirect_not_loopback'))
  const badIssuer = Object.assign({}, mock.registration, { issuer: 'http://issuer.synthetic.example' })
  const r3 = evaluatePreviewEligibility({ enabled: true, client: previewClient(), registration: badIssuer })
  assert.equal(r3.available, false)
  assert.ok(r3.reasons.includes('registration_issuer_not_https'))
  assert.equal(isLoopbackRedirect('http://127.0.0.1:49152/callback'), true)
  assert.equal(isLoopbackRedirect('http://localhost:49152/callback'), true)
  assert.equal(isLoopbackRedirect('https://127.0.0.1:49152/callback'), false)
  assert.equal(isLoopbackRedirect('http://127.0.0.1:49152/callback?x=1'), true)
})

test('P07 PKCE S256：challenge 可验证，错误 verifier 被 mock 拒绝', async () => {
  const pkce = createPkcePair()
  assert.match(pkce.codeVerifier, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(pkce.codeChallenge, pkceChallengeForVerifier(pkce.codeVerifier))
  const mock = createOidcMock()
  const auth = makeAuth(mock)
  await assert.rejects(exchange(mock, auth, { codeVerifier: createPkcePair().codeVerifier }), (e) => e instanceof OAuthError && e.code === 'token_exchange_failed')
})

test('P07 授权 URL 固定公开合同：state/nonce/PKCE/scope/loopback，无 client_secret', () => {
  const mock = createOidcMock()
  const pkce = createPkcePair()
  const { url } = buildAuthorizationRequest({
    registration: mock.registration,
    state: STATE,
    nonce: NONCE,
    codeChallenge: pkce.codeChallenge,
    hostId: 'host-synthetic-1',
    appName: 'ModelGate Preview',
  })
  const u = new URL(url)
  assert.equal(u.protocol, 'https:')
  assert.equal(u.searchParams.get('response_type'), 'code')
  assert.equal(u.searchParams.get('client_id'), mock.registration.clientId)
  assert.equal(u.searchParams.get('redirect_uri'), mock.registration.redirectUri)
  assert.equal(u.searchParams.get('scope'), SIWC_REQUIRED_SCOPES.join(' '))
  assert.equal(u.searchParams.get('state'), STATE)
  assert.equal(u.searchParams.get('nonce'), NONCE)
  assert.equal(u.searchParams.get('code_challenge'), pkce.codeChallenge)
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(u.searchParams.get('mg_host_id'), 'host-synthetic-1')
  assert.equal(u.searchParams.get('mg_app_name'), 'ModelGate Preview')
  assert.equal(u.searchParams.has('client_secret'), false)
  assert.equal(url.includes('client_secret'), false)
})

test('P07 state 不匹配在出网前拒绝', async () => {
  const mock = createOidcMock()
  const auth = makeAuth(mock)
  await assert.rejects(exchange(mock, auth, { state: 'state-other-0123456789' }), (e) => e.code === 'invalid_state')
  assert.equal(mock.tokenCalls, 0)
})

test('P07 nonce / aud / exp 校验', async () => {
  const nonceMock = createOidcMock()
  const nonceAuth = makeAuth(nonceMock)
  await assert.rejects(exchange(nonceMock, nonceAuth, { expectedNonce: 'nonce-other-0123456789' }), (e) => e.code === 'invalid_nonce')

  const audMock = createOidcMock({ tokenAudience: 'other-client' })
  const audAuth = makeAuth(audMock)
  await assert.rejects(exchange(audMock, audAuth), (e) => e.code === 'invalid_audience')

  const expMock = createOidcMock({ idTokenExpOffset: -7200 })
  const expAuth = makeAuth(expMock)
  await assert.rejects(exchange(expMock, expAuth), (e) => e.code === 'expired_id_token')
})

test('P07 授权缺少必需 scope 时拒绝，且不入 session', async () => {
  const mock = createOidcMock({ grantScopes: ['resource.invoke'] })
  const auth = makeAuth(mock)
  await assert.rejects(exchange(mock, auth), (e) => e.code === 'missing_scope' && e.missingScopes.includes('chatgpt.tokens.use.direct'))
  const manager = createSessionManager({ now: mock.now, fetchImpl: mock.fetchImpl })
  assert.throws(() => manager.signIn({ registration: mock.registration, grant: { accessToken: 'x', refreshToken: 'y', scope: ['resource.invoke'] } }), (e) => e.code === 'missing_scope')
  assert.equal(manager.store.size, 0)
})

test('P07 成功登录：scope 校验、独立 key、固定 endpoint、lease 不含 refresh token', async () => {
  const mock = createOidcMock()
  const { grant, manager } = await signedIn(mock)
  assert.deepEqual(grant.scope, [...SIWC_REQUIRED_SCOPES])
  const lease = await manager.getSession(mock.registration)
  assert.equal(lease.status, 'OK')
  assert.equal(lease.accessToken, grant.accessToken)
  assert.equal(lease.endpoint, mock.registration.resourceEndpoint)
  assert.equal(lease.allowRedirect, false)
  assert.equal(lease.fixedOrigin, true)
  assert.equal(Object.prototype.hasOwnProperty.call(lease, 'refreshToken'), false)
  assert.equal(registrationKey(mock.registration), mock.registration.accountId + '\u0000' + mock.registration.workspaceId)
})

test('P07 状态与日志脱敏：access/refresh token 不出现在 status/日志', async () => {
  const logs = []
  const logger = { warn: (...args) => logs.push(args.join(' ')) }
  const mock = createOidcMock()
  const { grant, manager } = await signedIn(mock, logger)
  const status = manager.status(mock.registration)
  const serialized = JSON.stringify(status) + '\n' + logs.join('\n')
  assert.equal(serialized.includes(grant.accessToken), false)
  assert.equal(serialized.includes(grant.refreshToken), false)
  assert.equal(status.hasAccessToken, true)
  assert.equal(status.hasRefreshToken, true)
  assert.equal(status.status, 'SIGNED_IN')
})

test('P07 并发续期单飞：5 个 getSession 只触发一次 refresh，全部拿到新 token', async () => {
  const mock = createOidcMock()
  const { grant, manager } = await signedIn(mock)
  mock.advance(3600 * 1000) // 到期窗口内（skew 60s）
  const before = mock.refreshCalls
  const results = await Promise.all(Array.from({ length: 5 }, () => manager.getSession(mock.registration)))
  assert.equal(mock.refreshCalls - before, 1)
  assert.equal(results.every((r) => r.status === 'OK'), true)
  assert.equal(new Set(results.map((r) => r.accessToken)).size, 1)
  assert.notEqual(results[0].accessToken, grant.accessToken)
  const stored = manager.store.get(registrationKey(mock.registration))
  assert.equal(typeof stored.grant.refreshToken, 'string')
  assert.equal(mock.refreshTokenCount, 1, '轮换后只保留最新 refresh token')
})

test('P07 轮换：旧 refresh token 失效，只有最新 token 可再次续期', async () => {
  const mock = createOidcMock()
  const { manager } = await signedIn(mock)
  mock.advance(3600 * 1000)
  const first = await manager.getSession(mock.registration)
  assert.equal(first.status, 'OK')
  const stored1 = manager.store.get(registrationKey(mock.registration)).grant.refreshToken
  mock.advance(3600 * 1000)
  const second = await manager.getSession(mock.registration)
  assert.equal(second.status, 'OK')
  assert.notEqual(second.accessToken, first.accessToken)
  assert.equal(mock.refreshTokenCount, 1)
  assert.notEqual(manager.store.get(registrationKey(mock.registration)).grant.refreshToken, stored1)
})

test('P07 暂时断网：保留 grant，返回 TEMPORARILY_UNAVAILABLE；恢复后可续期', async () => {
  const mock = createOidcMock()
  const { manager } = await signedIn(mock)
  mock.advance(3600 * 1000)
  mock.refreshNetworkDown = true
  const down = await manager.getSession(mock.registration)
  assert.equal(down.status, 'TEMPORARILY_UNAVAILABLE')
  assert.equal(manager.store.get(registrationKey(mock.registration)).grant != null, true, '不得因临时失败清理登录')
  mock.refreshNetworkDown = false
  const up = await manager.getSession(mock.registration)
  assert.equal(up.status, 'OK')
})

test('P07 invalid_grant / revoked：清理 token 并回到 SIGN_IN_REQUIRED', async () => {
  const invalid = createOidcMock()
  const a = await signedIn(invalid)
  invalid.invalidateRefreshTokens()
  invalid.advance(3600 * 1000)
  const r1 = await a.manager.getSession(invalid.registration)
  assert.equal(r1.status, 'SIGN_IN_REQUIRED')
  assert.equal(a.manager.store.get(registrationKey(invalid.registration)), null)

  const revoked = createOidcMock()
  const b = await signedIn(revoked)
  revoked.revokeAllRefreshTokens()
  revoked.advance(3600 * 1000)
  const r2 = await b.manager.getSession(revoked.registration)
  assert.equal(r2.status, 'SIGN_IN_REQUIRED')
})

test('P07 登出：先停止 admission、再撤销、清 token、保留注册', async () => {
  const mock = createOidcMock()
  const { manager } = await signedIn(mock)
  const out = await manager.logout(mock.registration)
  assert.equal(out.status, 'SIGNED_OUT')
  assert.equal(out.remoteRevocation, 'confirmed')
  assert.equal(out.registrationRetained, true)
  assert.equal(mock.revokeCalls, 1)
  assert.equal((await manager.getSession(mock.registration)).status, 'SIGN_IN_REQUIRED')
  const record = manager.store.get(registrationKey(mock.registration))
  assert.ok(record)
  assert.equal(record.grant, null)
  assert.equal(record.registration.accountId, mock.registration.accountId)
})

test('P07 登出时撤销端点不可达：标 unconfirmed，但本地 token 必须清理', async () => {
  const mock = createOidcMock()
  const { manager } = await signedIn(mock)
  mock.revokeNetworkDown = true
  const out = await manager.logout(mock.registration)
  assert.equal(out.status, 'SIGNED_OUT')
  assert.equal(out.remoteRevocation, 'unconfirmed')
  assert.equal((await manager.getSession(mock.registration)).status, 'SIGN_IN_REQUIRED')
  assert.equal(manager.store.get(registrationKey(mock.registration)).grant, null)
})

test('P07 账户/工作区隔离：同 account 不同 workspace 各自独立，登出一个不影响另一个', async () => {
  const a = createOidcMock({ workspaceId: 'ws-alpha' })
  const b = createOidcMock({ workspaceId: 'ws-beta' })
  assert.notEqual(registrationKey(a.registration), registrationKey(b.registration))
  const manager = createSessionManager({ now: a.now, fetchImpl: a.fetchImpl })
  const authA = makeAuth(a)
  const grantA = await exchange(a, authA)
  manager.signIn({ registration: a.registration, grant: grantA })
  const authB = makeAuth(b)
  const grantB = await exchange(b, authB)
  manager.signIn({ registration: b.registration, grant: grantB })
  const leaseA = await manager.getSession(a.registration)
  const leaseB = await manager.getSession(b.registration)
  assert.notEqual(leaseA.accessToken, leaseB.accessToken)
  await manager.logout(a.registration)
  assert.equal((await manager.getSession(a.registration)).status, 'SIGN_IN_REQUIRED')
  assert.equal((await manager.getSession(b.registration)).status, 'OK')
})

test('P07 隔离 launcher/工具环境：令牌只给 app-server，tool/shell/mcp 拿不到，refresh 永不入 env', async () => {
  const mock = createOidcMock()
  const { grant } = await signedIn(mock)
  const baseEnv = { PATH: '/usr/bin', HOME: '/home/synthetic', OPENAI_API_KEY: 'sk-host-canary', CODEX_HOME: '/tmp/codex', SIWC_ACCESS_TOKEN: 'stale' }
  const appServer = buildLauncherEnv({ target: 'app-server', grant, baseEnv })
  assert.equal(appServer.tokenExposed, true)
  assert.equal(appServer.env.SIWC_ACCESS_TOKEN, grant.accessToken)
  assert.equal(Object.prototype.hasOwnProperty.call(appServer.env, 'OPENAI_API_KEY'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(appServer.env, 'CODEX_HOME'), false)
  assert.equal(JSON.stringify(appServer).includes(grant.refreshToken), false)
  for (const target of ['tool', 'shell', 'mcp', 'unknown']) {
    const env = buildLauncherEnv({ target, grant, baseEnv })
    assert.equal(env.tokenExposed, false)
    assert.equal(JSON.stringify(env).includes(grant.accessToken), false)
    assert.equal(JSON.stringify(env).includes(grant.refreshToken), false)
  }
})

test('P07 模块静态边界：不直接联网、不读 HOME/auth、无真实 OpenAI 端点', () => {
  const files = [
    '../../../src/subscription/capabilities.js',
    '../../../src/subscription/oauth.js',
    '../../../src/subscription/session.js',
  ]
  for (const file of files) {
    const path = fileURLToPath(new URL(file, import.meta.url))
    const source = readFileSync(path, 'utf8')
    assert.doesNotMatch(source, /from\s+['"]node:(http|https|net|tls|dns|child_process)['"]/, path)
    assert.doesNotMatch(source, /\bfetch\s*\(/, path)
    assert.doesNotMatch(source, /process\.env|os\.homedir|auth\.json/, path)
    assert.doesNotMatch(source, /api\.openai\.com|auth\.openai\.com|chatgpt\.com/, path)
  }
  const mockPath = fileURLToPath(new URL('../fixtures/siwc/oidc-mock.mjs', import.meta.url))
  const mockSource = readFileSync(mockPath, 'utf8')
  assert.doesNotMatch(mockSource, /from\s+['"]node:(http|https|net|tls|dns|child_process)['"]/)
  assert.doesNotMatch(mockSource, /api\.openai\.com|auth\.openai\.com|chatgpt\.com/)
  assert.match(mockSource, /issuer\.synthetic\.example/)
})

test('P07 错误对象不回显 token/正文', async () => {
  const mock = createOidcMock()
  const auth = makeAuth(mock)
  const error = await exchange(mock, auth, { code: 'wrong-code' }).catch((e) => e)
  assert.ok(error instanceof OAuthError)
  const serialized = JSON.stringify({ code: error.code, message: error.message, missingScopes: error.missingScopes })
  assert.doesNotMatch(serialized, /at_|rt_|code_/)
})
