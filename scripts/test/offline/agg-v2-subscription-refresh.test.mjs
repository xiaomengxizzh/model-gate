// V2-REAL-3 / A4：过期 token 刷新 + auth.json 0600 原子回写（离线，注入 fetchImpl 的本地 mock OAuth）。
//
// 契约：
//   · 只有「快过期/已过期」才刷新；未到窗口不发任何网络请求；
//   · 刷新请求走 src/subscription/oauth.js（form: grant_type=refresh_token / client_id / refresh_token，
//     redirect:'error'），端点/客户端 ID 可被显式覆盖；
//   · 回写前 compare-and-swap：读取时的内容哈希与写前复核不一致 → 放弃回写（保留用户并发改写的新内容）；
//   · 写入是同目录临时文件（0600、fsync）+ rename，不存在半截 auth.json，也不留临时文件；
//   · 任何失败都是 typed subscription_credential_unavailable（reason 细分），且错误/返回值不含 token。
// 零网络、零真实凭据：端点固定为 https 字面量，但 fetchImpl 是本文件里的本地 mock。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  refreshLocalSubscriptionCredential, SUBSCRIPTION_CREDENTIAL_UNAVAILABLE, SubscriptionCredentialError,
  SUBSCRIPTION_REFRESH_REASONS, SUBSCRIPTION_OAUTH_TOKEN_ENDPOINT, SUBSCRIPTION_OAUTH_CLIENT_DEFAULT,
} from '../../../src/codex/local-subscription.js'

const OLD_ACCESS = 'CANARY-OLD-ACCESS-TOKEN'
const OLD_REFRESH = 'CANARY-OLD-REFRESH-TOKEN'
const NEW_ACCESS = 'CANARY-NEW-ACCESS-TOKEN'
const NEW_REFRESH = 'CANARY-NEW-REFRESH-TOKEN'

function b64url(value) { return Buffer.from(JSON.stringify(value)).toString('base64url') }
function jwt(expSec, marker) {
  return b64url({ alg: 'none', typ: 'JWT' }) + '.' + b64url({ exp: expSec, sub: 'canary', marker }) + '.sig'
}
const EXPIRED = () => jwt(Math.floor(Date.now() / 1000) - 60, OLD_ACCESS)
const FRESH = () => jwt(Math.floor(Date.now() / 1000) + 3600, FRESH_MARKER)
const FRESH_MARKER = 'CANARY-FRESH-ACCESS-TOKEN'

async function homeWithAuth(body, raw) {
  const home = await mkdtemp(join(tmpdir(), 'mg-v2-real3-refresh-'))
  const codex = join(home, '.codex')
  await mkdir(codex, { recursive: true })
  const path = join(codex, 'auth.json')
  await writeFile(path, raw == null ? JSON.stringify(body) : raw, 'utf8')
  return { home, codex, path, env: { HOME: home, CODEX_HOME: codex } }
}

function mockOAuth(handler) {
  const calls = []
  const fn = async (url, init) => {
    const form = new URLSearchParams(String((init && init.body) || ''))
    const record = { url: String(url), init: init || {}, form }
    calls.push(record)
    const reply = handler(record) || { status: 200, body: {} }
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body }
  }
  fn.calls = calls
  return fn
}

const okReply = () => ({
  status: 200,
  body: {
    access_token: NEW_ACCESS,
    refresh_token: NEW_REFRESH,
    expires_in: 3600,
    token_type: 'Bearer',
    scope: 'openid profile email offline_access',
  },
})

async function refreshErrorOf(fn) {
  try { await fn() } catch (error) {
    assert.equal(error instanceof SubscriptionCredentialError, true, '必须是 SubscriptionCredentialError：' + (error && error.message))
    assert.equal(error.code, SUBSCRIPTION_CREDENTIAL_UNAVAILABLE)
    assert.equal(error.status, 401)
    assert.equal(typeof error.reason, 'string')
    return error
  }
  assert.fail('预期刷新失败，实际成功')
}

function assertNoSecrets(text, label) {
  for (const secret of [OLD_ACCESS, OLD_REFRESH, NEW_ACCESS, NEW_REFRESH]) {
    assert.equal(String(text).includes(secret), false, label + ' 不得出现 token：' + secret)
  }
}

test('过期 token：mock OAuth 刷新成功，0600 原子回写且保留其它字段', async (t) => {
  const fixture = await homeWithAuth({
    auth_mode: 'chatgpt',
    last_refresh: '2020-01-01T00:00:00.000Z',
    tokens: { access_token: EXPIRED(), refresh_token: OLD_REFRESH, account_id: 'acct-canary', id_token: 'CANARY-ID-TOKEN' },
    user_preference: { theme: 'dark' },
  })
  t.after(async () => { await rm(fixture.home, { recursive: true, force: true }) })
  const fetchImpl = mockOAuth(() => okReply())

  const before = await stat(fixture.path)
  const result = await refreshLocalSubscriptionCredential({ env: fixture.env, fetchImpl })
  assert.equal(result.refreshed, true)
  assert.equal(result.reason, SUBSCRIPTION_REFRESH_REASONS.REFRESHED)
  assert.equal(result.rotated, true, '上游轮换 refresh_token 必须如实反映')
  assert.equal(Number.isFinite(result.expiresAt), true)
  assertNoSecrets(JSON.stringify(result), '刷新返回值')
  assert.equal(Object.isFrozen(result), true)

  // 请求形状：走 oauth.js 的 refresh_token 授权，参数只含必要项。
  assert.equal(fetchImpl.calls.length, 1)
  const call = fetchImpl.calls[0]
  assert.equal(call.url, SUBSCRIPTION_OAUTH_TOKEN_ENDPOINT)
  assert.equal(call.form.get('grant_type'), 'refresh_token')
  assert.equal(call.form.get('refresh_token'), OLD_REFRESH)
  assert.equal(call.form.get('client_id'), SUBSCRIPTION_OAUTH_CLIENT_DEFAULT)
  assert.equal(call.init.redirect, 'error')
  assert.equal(call.init.method, 'POST')

  const written = JSON.parse(await readFile(fixture.path, 'utf8'))
  assert.equal(written.tokens.access_token, NEW_ACCESS)
  assert.equal(written.tokens.refresh_token, NEW_REFRESH)
  assert.equal(written.tokens.account_id, 'acct-canary', '账号 id 保留')
  assert.equal(written.tokens.id_token, 'CANARY-ID-TOKEN', 'id_token 保留（不臆造、不清空）')
  assert.equal(written.auth_mode, 'chatgpt')
  assert.deepEqual(written.user_preference, { theme: 'dark' }, '未知字段原样保留')
  assert.notEqual(written.last_refresh, '2020-01-01T00:00:00.000Z', 'last_refresh 必须更新')

  const after = await stat(fixture.path)
  assert.equal(after.mode & 0o777, 0o600, 'auth.json 必须是 0600')
  assert.equal(after.ino !== before.ino || after.mtimeMs !== before.mtimeMs, true, '必须是原子替换（inode/mtime 变化）')
  const leftovers = (await readdir(fixture.codex)).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [], '不得残留临时文件')
})

test('未到刷新窗口：不发网络请求，也不改写文件', async (t) => {
  const fixture = await homeWithAuth({
    auth_mode: 'chatgpt',
    tokens: { access_token: FRESH(), refresh_token: OLD_REFRESH, account_id: 'acct' },
  })
  t.after(async () => { await rm(fixture.home, { recursive: true, force: true }) })
  const rawBefore = await readFile(fixture.path, 'utf8')
  const fetchImpl = mockOAuth(() => okReply())
  const result = await refreshLocalSubscriptionCredential({ env: fixture.env, fetchImpl })
  assert.equal(result.refreshed, false)
  assert.equal(result.reason, SUBSCRIPTION_REFRESH_REASONS.NOT_EXPIRED)
  assert.equal(fetchImpl.calls.length, 0, '未过期不得联网')
  assert.equal(await readFile(fixture.path, 'utf8'), rawBefore)
})

test('compare-and-swap：刷新期间文件被并发改写 → 放弃回写并保留新内容', async (t) => {
  const fixture = await homeWithAuth({
    auth_mode: 'chatgpt',
    tokens: { access_token: EXPIRED(), refresh_token: OLD_REFRESH },
  })
  t.after(async () => { await rm(fixture.home, { recursive: true, force: true }) })
  const concurrent = JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'CONCURRENT-USER-TOKEN', refresh_token: 'CONCURRENT-RT' }, marker: 'concurrent-write' })
  const error = await refreshErrorOf(() => refreshLocalSubscriptionCredential({
    env: fixture.env,
    fetchImpl: mockOAuth(() => okReply()),
    beforeCommit: async () => { await writeFile(fixture.path, concurrent, 'utf8') },
  }))
  assert.equal(error.reason, SUBSCRIPTION_REFRESH_REASONS.CONCURRENT_CHANGE)
  assertNoSecrets(JSON.stringify({ m: error.message, reason: error.reason, code: error.code }), 'CAS 错误')
  assert.equal(await readFile(fixture.path, 'utf8'), concurrent, '并发改写优先，不得被刷新结果覆盖')
  const leftovers = (await readdir(fixture.codex)).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [])
})

test('并发删除文件同样放弃回写（不重建用户登录态）', async (t) => {
  const fixture = await homeWithAuth({ auth_mode: 'chatgpt', tokens: { access_token: EXPIRED(), refresh_token: OLD_REFRESH } })
  t.after(async () => { await rm(fixture.home, { recursive: true, force: true }) })
  const error = await refreshErrorOf(() => refreshLocalSubscriptionCredential({
    env: fixture.env,
    fetchImpl: mockOAuth(() => okReply()),
    beforeCommit: async () => { await rm(fixture.path, { force: true }) },
  }))
  assert.equal(error.reason, SUBSCRIPTION_REFRESH_REASONS.CONCURRENT_CHANGE)
  await assert.rejects(readFile(fixture.path, 'utf8'), '不得重建被删除的 auth.json')
})

test('刷新被拒绝 / 网络失败：typed 失败、文件字节不变、不残留临时文件', async (t) => {
  const cases = [
    ['invalid_grant', mockOAuth(() => ({ status: 400, body: { error: 'invalid_grant' } })), (reason) => assert.match(reason, /refresh_invalid_grant/)],
    ['server_error', mockOAuth(() => ({ status: 503, body: { error: 'server_error' } })), (reason) => assert.match(reason, /refresh_/)],
    ['network_down', async () => { throw new Error('ECONNREFUSED') }, (reason) => assert.equal(reason, 'refresh_network_unavailable')],
  ]
  for (const [label, fetchImpl, check] of cases) {
    const fixture = await homeWithAuth({
      auth_mode: 'chatgpt',
      tokens: { access_token: EXPIRED(), refresh_token: OLD_REFRESH },
      marker: label,
    })
    t.after(async () => { await rm(fixture.home, { recursive: true, force: true }) })
    const rawBefore = await readFile(fixture.path, 'utf8')
    const error = await refreshErrorOf(() => refreshLocalSubscriptionCredential({ env: fixture.env, fetchImpl }))
    check(error.reason)
    assertNoSecrets(JSON.stringify({ m: error.message, reason: error.reason }), label + ' 错误')
    assert.equal(await readFile(fixture.path, 'utf8'), rawBefore, label + ' 失败不得改写 auth.json')
    assert.deepEqual((await readdir(fixture.codex)).filter((n) => n.endsWith('.tmp')), [], label + ' 不得残留临时文件')
  }
})

test('无法刷新时的 typed 失败：缺 refresh_token / API Key 模式 / 符号链接 / 文件缺失', async (t) => {
  const expiredNoRefresh = await homeWithAuth({ auth_mode: 'chatgpt', tokens: { access_token: EXPIRED() } })
  t.after(async () => { await rm(expiredNoRefresh.home, { recursive: true, force: true }) })
  const fetchImpl = mockOAuth(() => okReply())
  const noRefresh = await refreshErrorOf(() => refreshLocalSubscriptionCredential({ env: expiredNoRefresh.env, fetchImpl }))
  assert.equal(noRefresh.reason, SUBSCRIPTION_REFRESH_REASONS.REFRESH_TOKEN_MISSING)
  assert.equal(fetchImpl.calls.length, 0, '缺 refresh_token 时不得联网')

  const apiKeyMode = await homeWithAuth({ auth_mode: 'chatgpt', OPENAI_API_KEY: 'sk-canary-key' })
  t.after(async () => { await rm(apiKeyMode.home, { recursive: true, force: true }) })
  const keyError = await refreshErrorOf(() => refreshLocalSubscriptionCredential({ env: apiKeyMode.env, fetchImpl }))
  assert.equal(keyError.reason, 'api_key_mode', 'API Key 模式不是订阅凭据，绝不刷新/改域')
  assertNoSecrets(JSON.stringify(keyError), 'API Key 模式错误')

  // 符号链接：拒绝写穿目标（不把用户真实文件改成我们的内容）。
  const real = await homeWithAuth({ auth_mode: 'chatgpt', tokens: { access_token: EXPIRED(), refresh_token: OLD_REFRESH } })
  t.after(async () => { await rm(real.home, { recursive: true, force: true }) })
  const linkHome = await mkdtemp(join(tmpdir(), 'mg-v2-real3-link-'))
  t.after(async () => { await rm(linkHome, { recursive: true, force: true }) })
  const linkCodex = join(linkHome, '.codex')
  await mkdir(linkCodex, { recursive: true })
  await symlink(real.path, join(linkCodex, 'auth.json'))
  const rawReal = await readFile(real.path, 'utf8')
  const linkError = await refreshErrorOf(() => refreshLocalSubscriptionCredential({
    env: { HOME: linkHome, CODEX_HOME: linkCodex }, fetchImpl: mockOAuth(() => okReply()),
  }))
  assert.equal(linkError.reason, SUBSCRIPTION_REFRESH_REASONS.SYMLINK_REFUSED)
  assert.equal(await readFile(real.path, 'utf8'), rawReal, '符号链接目标不得被改写')

  const missingHome = await mkdtemp(join(tmpdir(), 'mg-v2-real3-missing-'))
  t.after(async () => { await rm(missingHome, { recursive: true, force: true }) })
  const missing = await refreshErrorOf(() => refreshLocalSubscriptionCredential({
    env: { HOME: missingHome, CODEX_HOME: join(missingHome, '.codex') }, fetchImpl,
  }))
  assert.equal(missing.reason, 'auth_file_missing')
})

test('端点与客户端 ID 可显式覆盖（仍必须是 https），且不把 token 写进错误', async (t) => {
  const fixture = await homeWithAuth({ auth_mode: 'chatgpt', tokens: { access_token: EXPIRED(), refresh_token: OLD_REFRESH } })
  t.after(async () => { await rm(fixture.home, { recursive: true, force: true }) })
  const fetchImpl = mockOAuth(() => okReply())
  await refreshLocalSubscriptionCredential({
    env: { ...fixture.env, MG_CODEX_OAUTH_CLIENT_ID: 'oaiapp_canary_client', MG_CODEX_OAUTH_TOKEN_ENDPOINT: 'https://oauth-canary.example/token' },
    fetchImpl,
  })
  assert.equal(fetchImpl.calls[0].url, 'https://oauth-canary.example/token')
  assert.equal(fetchImpl.calls[0].form.get('client_id'), 'oaiapp_canary_client')

  // http 端点被注册校验拒绝 → typed refresh 失败，不发请求、不写文件。
  const again = await homeWithAuth({ auth_mode: 'chatgpt', tokens: { access_token: EXPIRED(), refresh_token: OLD_REFRESH } })
  t.after(async () => { await rm(again.home, { recursive: true, force: true }) })
  const rawBefore = await readFile(again.path, 'utf8')
  const insecure = mockOAuth(() => okReply())
  const error = await refreshErrorOf(() => refreshLocalSubscriptionCredential({
    env: { ...again.env, MG_CODEX_OAUTH_TOKEN_ENDPOINT: 'http://127.0.0.1:9/token' }, fetchImpl: insecure,
  }))
  assert.match(error.reason, /refresh_/)
  assert.equal(insecure.calls.length, 0, '非 https 端点必须 fail-closed，不联网')
  assert.equal(await readFile(again.path, 'utf8'), rawBefore)
})
