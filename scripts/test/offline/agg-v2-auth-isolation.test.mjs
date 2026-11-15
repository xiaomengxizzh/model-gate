// V2-03 / A4：订阅凭据跨域隔离（离线，纯模块 + 临时 HOME 的合成 auth.json；零网络、零真实凭据）。
//
// 覆盖 MG-R002 / MG-R008 / MG-R009 / MG-R010：
//   · 订阅 token（本机 Codex 登录 / SIWC 应用授权）只能用于同名订阅域，绝不出现在 Go（api-key）出站请求；
//   · Go key 反向也绝不进入订阅出站请求（不存在"借用"）；
//   · 跨域是**出站前**的 typed deny（不是发出去等上游 401），消息/序列化都不含 token 与账号 id；
//   · 读取本机登录态仍然只读：租约化不复制、不改写 auth.json（无损、可回滚）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AUTH_DOMAINS, TARGET_DOMAINS, resolveUpstream, buildDomainHeaders,
  assertNoSubscriptionCredentialToThirdParty, isTargetAuthzError,
} from '../../../src/codex/target-authz.js'
import {
  CREDENTIAL_ORIGINS, SUBSCRIPTION_ORIGINS, createCredentialLease, redactLease,
  assertLeaseDomain, assertLeaseForUpstream, isSubscriptionOrigin,
  credentialLeaseFromSubscription, credentialLeaseFromSiwc, credentialLeaseFromProviderKey,
  isCredentialIsolationError,
} from '../../../src/subscription/isolation.js'
import {
  readSubscriptionCredential, SUBSCRIPTION_CREDENTIAL_UNAVAILABLE,
} from '../../../src/codex/local-subscription.js'
import { enforceKeySeparationAndNoSecretsInLogs } from '../../../src/tenancy/policy.js'

const SUB_TOKEN = 'CANARY-SUBSCRIPTION-ACCESS-TOKEN'
const GO_KEY = 'sk-CANARY-OPENCODE-GO-KEY'
const SIWC_TOKEN = 'CANARY-SIWC-ACCESS-TOKEN'
const ACCOUNT_ID = 'acct-CANARY-SUBSCRIPTION'

function b64url(value) { return Buffer.from(JSON.stringify(value)).toString('base64url') }
function makeToken(marker) {
  return b64url({ alg: 'none', typ: 'JWT' }) + '.' + b64url({ exp: Math.floor(Date.now() / 1000) + 3600, marker }) + '.sig'
}

function denyOf(fn) {
  try { fn() } catch (e) {
    assert.equal(e.deny, true, '必须是 typed deny：' + (e && e.message))
    assert.equal(typeof e.code, 'string')
    return e
  }
  assert.fail('预期被拒绝，实际放行')
}

// 三张收据：Go(api-key/第三方)、codex-subscription、siwc-app。
const GO = resolveUpstream({
  providerId: 'go', model: 'mg-go-deepseek', upstreamModel: 'deepseek-v4.1-flash',
  binding: { identity: TARGET_DOMAINS.THIRD_PARTY, host: 'https://opencode.ai', apiKey: true },
})
const SUB = resolveUpstream({
  providerId: 'codex-subscription', model: 'gpt-6-luna', upstreamModel: 'gpt-6-luna',
  binding: { identity: TARGET_DOMAINS.OFFICIAL, host: 'https://chatgpt.com', gatewaySubscription: true },
})
const SIWC = resolveUpstream({
  providerId: 'siwc-app', model: 'gpt-6-luna', upstreamModel: 'gpt-6-luna',
  binding: { identity: TARGET_DOMAINS.OFFICIAL, host: 'https://api.openai.com', siwcApp: true },
})

test('订阅租约不能用于 Go 出站：出站前 typed deny，且不构造任何头', () => {
  const subLease = createCredentialLease({ origin: AUTH_DOMAINS.CODEX_SUBSCRIPTION, token: 'Bearer ' + SUB_TOKEN, accountId: ACCOUNT_ID })
  const e = denyOf(() => buildDomainHeaders(GO, {
    credential: { lease: subLease, providerKey: GO_KEY, authorization: 'Bearer ' + SUB_TOKEN, accountId: ACCOUNT_ID },
  }))
  assert.equal(e.code, 'credential_domain_mismatch')
  assert.equal(e.status, 403)
  assert.equal(e.origin, AUTH_DOMAINS.CODEX_SUBSCRIPTION)
  assert.equal(e.authDomain, AUTH_DOMAINS.API_KEY)
  for (const secret of [SUB_TOKEN, GO_KEY, ACCOUNT_ID]) {
    assert.equal(JSON.stringify({ m: e.message, ...e }).includes(secret), false, '拒绝内容不得含凭据：' + secret)
  }

  // 反向同样成立：Go key 租约不得用于订阅收据。
  const goLease = credentialLeaseFromProviderKey(GO_KEY, { source: 'panel' })
  const back = denyOf(() => buildDomainHeaders(SUB, { credential: { lease: goLease } }))
  assert.equal(back.code, 'credential_domain_mismatch')
  // 直接校验（不经 buildDomainHeaders）也要拒绝。
  assert.equal(denyOf(() => assertLeaseDomain(subLease, AUTH_DOMAINS.API_KEY)).code, 'credential_domain_mismatch')
  assert.equal(denyOf(() => assertLeaseDomain(goLease, AUTH_DOMAINS.CODEX_SUBSCRIPTION)).code, 'credential_domain_mismatch')
})

test('同域租约放行：订阅 token 只在订阅出站，Go key 只在 Go 出站，互不出现', () => {
  const subLease = credentialLeaseFromSubscription({ authorization: 'Bearer ' + SUB_TOKEN, accountId: ACCOUNT_ID, source: 'codex_auth_json' })
  const subHeaders = buildDomainHeaders(SUB, { credential: { lease: subLease, authorization: 'Bearer ' + SUB_TOKEN, accountId: ACCOUNT_ID } })
  assert.equal(subHeaders.authorization, 'Bearer ' + SUB_TOKEN)
  assert.equal(subHeaders['chatgpt-account-id'], ACCOUNT_ID)
  assert.equal(JSON.stringify(subHeaders).includes(GO_KEY), false, '订阅出站不得出现 Go key')

  const goLease = credentialLeaseFromProviderKey(GO_KEY)
  const goHeaders = buildDomainHeaders(GO, { credential: { lease: goLease, providerKey: GO_KEY } })
  assert.equal(goHeaders.authorization, 'Bearer ' + GO_KEY)
  assert.equal(goHeaders['chatgpt-account-id'], undefined, 'Go 出站不得出现订阅账号头')
  assert.equal(JSON.stringify(goHeaders).includes(SUB_TOKEN), false, 'Go 出站不得出现订阅 token')

  // SIWC 是第三个独立域：既不能走订阅，也不能走 api-key。
  const siwcLease = credentialLeaseFromSiwc(SIWC_TOKEN)
  assert.equal(denyOf(() => assertLeaseDomain(siwcLease, AUTH_DOMAINS.CODEX_SUBSCRIPTION)).code, 'credential_domain_mismatch')
  assert.equal(denyOf(() => assertLeaseDomain(siwcLease, AUTH_DOMAINS.API_KEY)).code, 'credential_domain_mismatch')
  assert.doesNotThrow(() => assertLeaseDomain(siwcLease, AUTH_DOMAINS.SIWC_APP))
  const siwcHeaders = buildDomainHeaders(SIWC, { siwcToken: SIWC_TOKEN, credential: { lease: siwcLease } })
  assert.equal(siwcHeaders.authorization, 'Bearer ' + SIWC_TOKEN)
  assert.equal(siwcHeaders['chatgpt-account-id'], undefined)
})

test('租约不泄漏：不可枚举 token、toJSON 脱敏、诊断字段只有域与布尔', () => {
  const lease = createCredentialLease({
    origin: AUTH_DOMAINS.CODEX_SUBSCRIPTION, token: 'Bearer ' + SUB_TOKEN,
    accountId: ACCOUNT_ID, expiresAt: Date.now() + 60000, scope: 'local', source: 'codex_auth_json',
  })
  assert.equal(Object.isFrozen(lease), true)
  assert.equal(Object.keys(lease).includes('token'), false, 'token 不得参与枚举')
  assert.equal(JSON.stringify(lease).includes(SUB_TOKEN), false, 'JSON 序列化不得带 token')
  assert.equal(JSON.stringify({ lease }).includes(SUB_TOKEN), false)
  assert.equal(JSON.stringify(lease).includes(ACCOUNT_ID), false, '账号原值也不得进入序列化')
  assert.equal(lease.token, 'Bearer ' + SUB_TOKEN, '需要时仍可显式读取')

  const redacted = redactLease(lease)
  assert.deepEqual(Object.keys(redacted).sort(), ['accountIdPresent', 'expiresAt', 'origin', 'scope', 'source'])
  assert.equal(redacted.origin, AUTH_DOMAINS.CODEX_SUBSCRIPTION)
  assert.equal(redacted.accountIdPresent, true)
  assert.equal(JSON.stringify(redacted).includes(SUB_TOKEN), false)
  assert.equal(JSON.stringify(redacted).includes(ACCOUNT_ID), false)

  // 非法租约一律 typed deny，绝不"无租约等于放行"。
  assert.equal(denyOf(() => createCredentialLease({ origin: 'chatgpt-plan', token: 'x' })).code, 'credential_origin_invalid')
  assert.equal(denyOf(() => createCredentialLease({ origin: AUTH_DOMAINS.API_KEY })).code, 'credential_token_missing')
  assert.equal(denyOf(() => assertLeaseDomain(null, AUTH_DOMAINS.API_KEY)).code, 'credential_lease_missing')
  const expired = createCredentialLease({ origin: AUTH_DOMAINS.API_KEY, token: GO_KEY, expiresAt: 1 })
  const expiredError = denyOf(() => assertLeaseDomain(expired, AUTH_DOMAINS.API_KEY, { now: Date.now() }))
  assert.equal(expiredError.code, 'credential_lease_expired')
  assert.equal(expiredError.status, 401, '过期按未授权处理，而不是换域')
  assert.equal(isCredentialIsolationError(expiredError), true)
})

test('租约 + 收据联合校验：loopback 例外只给订阅域且必须显式开启', () => {
  const subLease = credentialLeaseFromSubscription({ authorization: 'Bearer ' + SUB_TOKEN })
  const goLease = credentialLeaseFromProviderKey(GO_KEY)
  const loopSub = Object.freeze({ authDomain: AUTH_DOMAINS.CODEX_SUBSCRIPTION, upstreamHost: '127.0.0.1:19091' })
  const loopGo = Object.freeze({ authDomain: AUTH_DOMAINS.API_KEY, upstreamHost: '127.0.0.1:19091' })

  assert.equal(denyOf(() => assertLeaseForUpstream(subLease, loopSub)).code, 'credential_lease_loopback_forbidden')
  assert.doesNotThrow(() => assertLeaseForUpstream(subLease, loopSub, { allowLoopbackMock: true }))
  // api-key 来源永远不享受 loopback 例外。
  assert.equal(denyOf(() => assertLeaseForUpstream(goLease, loopGo, { allowLoopbackMock: true })).code, 'credential_lease_loopback_forbidden')
  // 真实 host 正常放行；缺收据是 typed deny。
  assert.doesNotThrow(() => assertLeaseForUpstream(subLease, SUB))
  assert.equal(denyOf(() => assertLeaseForUpstream(subLease, {})).code, 'credential_lease_target_invalid')
  // 来源域与收据域不一致时，先于 loopback 判定失败。
  assert.equal(denyOf(() => assertLeaseForUpstream(subLease, GO)).code, 'credential_domain_mismatch')
})

test('来源层防线：即使头名看不出订阅特征，订阅租约也不得发往第三方 host', () => {
  // 只有 authorization（头名层无法判断来源）；靠租约来源域拦住。
  const lease = credentialLeaseFromSubscription({ authorization: 'Bearer ' + SUB_TOKEN })
  const e = denyOf(() => assertNoSubscriptionCredentialToThirdParty({ authorization: 'Bearer ' + SUB_TOKEN }, 'opencode.ai', { lease }))
  assert.equal(e.code, 'subscription_credential_to_third_party')
  assert.equal(JSON.stringify({ m: e.message, ...e }).includes(SUB_TOKEN), false)
  // 订阅入口放行；api-key 租约发往第三方是正常业务。
  assert.doesNotThrow(() => assertNoSubscriptionCredentialToThirdParty({ authorization: 'Bearer ' + SUB_TOKEN }, 'chatgpt.com', { lease }))
  assert.doesNotThrow(() => assertNoSubscriptionCredentialToThirdParty({ authorization: 'Bearer ' + GO_KEY }, 'opencode.ai', {
    lease: credentialLeaseFromProviderKey(GO_KEY),
  }))
  assert.equal(isSubscriptionOrigin(CREDENTIAL_ORIGINS.CODEX_SUBSCRIPTION), true)
  assert.equal(isSubscriptionOrigin(CREDENTIAL_ORIGINS.API_KEY), false)
  assert.deepEqual(SUBSCRIPTION_ORIGINS.slice().sort(), [AUTH_DOMAINS.CODEX_SUBSCRIPTION, AUTH_DOMAINS.SIWC_APP].sort())
})

test('本机登录态 → 租约：只读、无损，订阅可用而 Go 出站被拒', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'mg-v2-a4-lease-'))
  const codex = join(home, '.codex')
  await mkdir(codex, { recursive: true })
  const authPath = join(codex, 'auth.json')
  const token = makeToken('A4_LEASE')
  const raw = JSON.stringify({ tokens: { access_token: token, account_id: ACCOUNT_ID, refresh_token: 'never-used' } })
  await writeFile(authPath, raw, 'utf8')
  t.after(async () => { await rm(home, { recursive: true, force: true }) })

  const credential = readSubscriptionCredential({ env: { HOME: home, CODEX_HOME: codex } })
  const lease = credentialLeaseFromSubscription(credential)
  assert.equal(lease.origin, AUTH_DOMAINS.CODEX_SUBSCRIPTION)
  assert.equal(lease.token, credential.authorization)
  assert.equal(JSON.stringify(lease).includes(token), false, '租约序列化不得带真实 token')
  assert.equal(JSON.stringify(redactLease(lease)).includes(ACCOUNT_ID), false)

  // 读 + 租约化都必须是只读的：auth.json 字节与目录内容不变（无损回滚前提）。
  assert.equal(await readFile(authPath, 'utf8'), raw, 'auth.json 不得被改写')
  const headers = buildDomainHeaders(SUB, { credential: { lease, authorization: credential.authorization, accountId: credential.accountId } })
  assert.equal(headers.authorization, credential.authorization)
  assert.equal(headers['chatgpt-account-id'], ACCOUNT_ID)

  const denied = denyOf(() => buildDomainHeaders(GO, { credential: { lease, providerKey: GO_KEY } }))
  assert.equal(denied.code, 'credential_domain_mismatch')
  assert.equal(JSON.stringify({ m: denied.message, ...denied }).includes(token), false)
  assert.equal(JSON.stringify({ m: denied.message, ...denied }).includes(ACCOUNT_ID), false)

  // 缺少登录态时仍是订阅域自己的 typed 401，不会被改写成别的域。
  const emptyHome = await mkdtemp(join(tmpdir(), 'mg-v2-a4-lease-empty-'))
  t.after(async () => { await rm(emptyHome, { recursive: true, force: true }) })
  let failure = null
  try { readSubscriptionCredential({ env: { HOME: emptyHome, CODEX_HOME: join(emptyHome, '.codex') } }) } catch (e) { failure = e }
  assert.equal(failure && failure.code, SUBSCRIPTION_CREDENTIAL_UNAVAILABLE)
  assert.equal(failure && failure.status, 401)
  assert.equal(isTargetAuthzError(failure), false, '订阅凭据缺失不是目标授权拒绝（域不同）')
})

test('租户授权链：凭据来源域与授权域不一致即拒绝（复用同一判定，不新增第二份清单）', () => {
  const scope = Object.freeze({ scopeId: 'local', mode: 'single', actorId: 'local' })
  const provider = Object.freeze({ id: 'go', scopeId: 'local' })
  // 同域通过：api-key 来源用于 api-key 域。
  const fields = enforceKeySeparationAndNoSecretsInLogs(scope, provider, {
    authDomain: AUTH_DOMAINS.API_KEY, credentialOrigin: AUTH_DOMAINS.API_KEY,
  })
  assert.deepEqual(Object.keys(fields).sort(), ['authDomain', 'providerId', 'scopeId'], '可写日志字段只有 id 与域名')

  // 订阅来源被塞进 api-key 域：租户层直接拒绝，错误仍是 TenancyError 且 code 与授权层一致。
  let typed = null
  try {
    enforceKeySeparationAndNoSecretsInLogs(scope, provider, {
      authDomain: AUTH_DOMAINS.API_KEY, credentialOrigin: AUTH_DOMAINS.CODEX_SUBSCRIPTION,
    })
  } catch (e) { typed = e }
  assert.equal(typed && typed.name, 'TenancyError')
  assert.equal(typed && typed.code, 'credential_domain_mismatch')
  assert.equal(typed && typed.status, 403)
  assert.equal(typed && typed.deny, true)
  assert.equal(JSON.stringify({ m: typed.message, ...typed }).includes(SUB_TOKEN), false)

  // 未知来源域是调用方 bug：400，不静默当成某个域。
  let invalid = null
  try {
    enforceKeySeparationAndNoSecretsInLogs(scope, provider, { authDomain: AUTH_DOMAINS.API_KEY, credentialOrigin: 'chatgpt-plan' })
  } catch (e) { invalid = e }
  assert.equal(invalid && invalid.code, 'credential_origin_invalid')
  assert.equal(invalid && invalid.status, 400)
})
