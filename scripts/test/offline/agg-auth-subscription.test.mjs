// AGG-P02：codex-subscription（P09 本机登录只读承载）契约与 typed 失败（离线）。
// 覆盖：只读不落盘、不复制 auth.json；失败原因稳定且不含 token；订阅入口四条件；
//      订阅收据构造出的头带 authorization/chatgpt-account-id，api-key 域绝不携带账号头。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readSubscriptionCredential, subscriptionPathDeny, isGatewaySubscriptionTarget,
  SubscriptionCredentialError, SUBSCRIPTION_CREDENTIAL_REASONS, SUBSCRIPTION_CREDENTIAL_UNAVAILABLE,
  SUBSCRIPTION_RESPONSES_PATH, GATEWAY_SUBSCRIPTION_HOSTS,
} from '../../../src/codex/local-subscription.js'
import {
  resolveUpstream, buildDomainHeaders, assertNoSubscriptionCredentialToThirdParty,
  isTargetAuthzError, AUTH_DOMAINS, TARGET_DOMAINS,
} from '../../../src/codex/target-authz.js'

const TOKEN = 'subscription-canary-token'

function b64url(value) { return Buffer.from(JSON.stringify(value)).toString('base64url') }
function makeToken({ exp = Math.floor(Date.now() / 1000) + 3600, marker = 'SYNTH' } = {}) {
  return b64url({ alg: 'none', typ: 'JWT' }) + '.' + b64url({ exp, marker, sub: 'synthetic' }) + '.signature-not-verified'
}

async function homeWith(authJson, raw) {
  const home = await mkdtemp(join(tmpdir(), 'mg-agg-sub-'))
  const codex = join(home, '.codex')
  await mkdir(codex, { recursive: true })
  await writeFile(join(codex, 'auth.json'), raw == null ? JSON.stringify(authJson) : raw, 'utf8')
  return { home, codex, env: { HOME: home, CODEX_HOME: codex } }
}

async function listTree(dir) {
  const out = []
  async function walk(current, prefix) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const rel = prefix ? prefix + '/' + entry.name : entry.name
      if (entry.isDirectory()) await walk(join(current, entry.name), rel)
      else out.push(rel)
    }
  }
  await walk(dir, '')
  return out.sort()
}

function reasonOf(fn) {
  try { fn() } catch (e) {
    assert.equal(e instanceof SubscriptionCredentialError, true)
    assert.equal(e.code, SUBSCRIPTION_CREDENTIAL_UNAVAILABLE)
    assert.equal(e.status, 401)
    return e.reason
  }
  assert.fail('预期失败，实际返回凭据')
}

test('本机登录态只读：返回一次性凭据，不复制/不新增/不改写 auth.json', async (t) => {
  const token = makeToken()
  const { home, codex, env } = await homeWith({ tokens: { access_token: token, account_id: 'acct-sub', refresh_token: 'unused' } })
  t.after(async () => { await rm(home, { recursive: true, force: true }) })
  const before = await listTree(codex)
  const rawBefore = await readFile(join(codex, 'auth.json'), 'utf8')

  const credential = readSubscriptionCredential({ env })
  assert.equal(credential.authorization, 'Bearer ' + token)
  assert.equal(credential.accountId, 'acct-sub')
  assert.equal(credential.source, 'codex_auth_json')
  assert.equal(typeof credential.expiresAt, 'number')

  const after = await listTree(codex)
  assert.deepEqual(after, before, '读取不得产生任何新文件（不复制、不落盘）')
  assert.equal(await readFile(join(codex, 'auth.json'), 'utf8'), rawBefore, 'auth.json 不得被改写')
  assert.equal(JSON.stringify(Object.keys(credential)).includes('refresh'), false, '绝不返回 refresh token')
})

test('失败原因是稳定 code + 脱敏 reason：缺失/损坏/无 token/过期/API Key 模式', async (t) => {
  const homes = []
  t.after(async () => { for (const h of homes) await rm(h, { recursive: true, force: true }) })

  const empty = await mkdtemp(join(tmpdir(), 'mg-agg-sub-empty-'))
  homes.push(empty)
  assert.equal(reasonOf(() => readSubscriptionCredential({ env: { HOME: empty, CODEX_HOME: join(empty, '.codex') } })), SUBSCRIPTION_CREDENTIAL_REASONS.FILE_MISSING)

  const broken = await homeWith(null, '{not json')
  homes.push(broken.home)
  assert.equal(reasonOf(() => readSubscriptionCredential({ env: broken.env })), SUBSCRIPTION_CREDENTIAL_REASONS.FILE_INVALID)

  const noToken = await homeWith({ tokens: { refresh_token: 'r' } })
  homes.push(noToken.home)
  assert.equal(reasonOf(() => readSubscriptionCredential({ env: noToken.env })), SUBSCRIPTION_CREDENTIAL_REASONS.TOKEN_MISSING)

  const apiKeyMode = await homeWith({ OPENAI_API_KEY: 'sk-api-key-mode' })
  homes.push(apiKeyMode.home)
  const apiKeyReason = reasonOf(() => readSubscriptionCredential({ env: apiKeyMode.env }))
  assert.equal(apiKeyReason, SUBSCRIPTION_CREDENTIAL_REASONS.API_KEY_MODE, 'API Key 模式不得当成订阅凭据')

  const expired = await homeWith({ tokens: { access_token: makeToken({ exp: Math.floor(Date.now() / 1000) - 60 }) } })
  homes.push(expired.home)
  assert.equal(reasonOf(() => readSubscriptionCredential({ env: expired.env })), SUBSCRIPTION_CREDENTIAL_REASONS.TOKEN_EXPIRED)

  // 错误对象本身不得带 token 或文件内容。
  try { readSubscriptionCredential({ env: apiKeyMode.env }) } catch (e) {
    assert.equal(JSON.stringify(e.message).includes('sk-api-key-mode'), false)
    assert.equal(JSON.stringify(e).includes('sk-api-key-mode'), false)
  }
})

test('订阅入口契约：loopback、官方身份、/backend-api/codex、不得与 key/SIWC 混用', () => {
  const ok = { enabled: true, listenerLoopback: true, peerLoopback: true, identityKind: 'official', host: 'chatgpt.com', path: SUBSCRIPTION_RESPONSES_PATH }
  assert.equal(subscriptionPathDeny(ok), null)
  assert.equal(subscriptionPathDeny({ ...ok, enabled: false }), null, '未启用时不参与判定')

  const cases = [
    [{ listenerLoopback: false }, 'gateway_subscription_not_loopback'],
    [{ peerLoopback: false }, 'gateway_subscription_not_loopback'],
    [{ identityKind: 'thirdParty' }, 'gateway_subscription_target_not_allowed'],
    [{ host: 'api.openai.com' }, 'gateway_subscription_target_not_allowed'],
    [{ path: '/v1/responses' }, 'gateway_subscription_path_not_allowed'],
    [{ apiKeyPresent: true }, 'gateway_subscription_api_key_conflict'],
    [{ siwcApp: true }, 'auth_domain_conflict'],
  ]
  for (const [patch, code] of cases) {
    const d = subscriptionPathDeny({ ...ok, ...patch })
    assert.equal(d && d.code, code, JSON.stringify(patch))
    assert.equal(d.status, 403)
    assert.equal(d.deny, true)
    assert.equal(JSON.stringify(d).includes('Bearer'), false)
  }
  assert.equal(subscriptionPathDeny({ ...ok, host: '127.0.0.1' }), null, 'loopback 仅用于离线 mock')
  assert.equal(subscriptionPathDeny({ ...ok, path: '/backend-api/codex' }), null)

  assert.equal(isGatewaySubscriptionTarget({ kind: 'official', host: 'chatgpt.com' }, SUBSCRIPTION_RESPONSES_PATH, {}), true)
  assert.equal(isGatewaySubscriptionTarget({ kind: 'official', host: 'chatgpt.com' }, '/backend-api/codex-other', {}), false)
  assert.equal(isGatewaySubscriptionTarget({ kind: 'thirdParty', host: 'chatgpt.com' }, SUBSCRIPTION_RESPONSES_PATH, {}), false)
  assert.equal(GATEWAY_SUBSCRIPTION_HOSTS.includes('chatgpt.com'), true)
})

test('订阅收据构造头：authorization + 账号头只属于 codex-subscription；api-key 域绝不带账号头', () => {
  const sub = resolveUpstream({
    providerId: 'codex-subscription', model: 'gpt-6-luna', upstreamModel: 'gpt-6-luna',
    binding: { identity: TARGET_DOMAINS.OFFICIAL, host: 'https://chatgpt.com', gatewaySubscription: true },
  })
  const credential = { authorization: 'Bearer ' + TOKEN, accountId: 'acct-sub' }
  const headers = buildDomainHeaders(sub, { credential, incoming: { authorization: 'Bearer CLIENT', 'chatgpt-account-id': 'acct-client' } })
  assert.equal(headers.authorization, 'Bearer ' + TOKEN)
  assert.equal(headers['chatgpt-account-id'], 'acct-sub')
  assert.equal(JSON.stringify(headers).includes('CLIENT'), false)

  const keyed = resolveUpstream({
    providerId: 'openai-api', model: 'gpt-6-luna', upstreamModel: 'gpt-6-luna',
    binding: { identity: TARGET_DOMAINS.OFFICIAL, host: 'https://api.openai.com', apiKey: true },
  })
  const keyHeaders = buildDomainHeaders(keyed, { credential: { providerKey: 'sk-key', authorization: credential.authorization, accountId: credential.accountId } })
  assert.equal(keyHeaders['chatgpt-account-id'], undefined)
  assert.equal(keyHeaders.authorization, 'Bearer sk-key')

  // 同一组订阅头一旦指向第三方 host，出站前即拒绝。
  let denied
  try { assertNoSubscriptionCredentialToThirdParty(headers, 'opencode.ai', { credentialSource: AUTH_DOMAINS.CODEX_SUBSCRIPTION }) } catch (e) { denied = e }
  assert.equal(isTargetAuthzError(denied), true)
  assert.equal(denied.code, 'subscription_credential_to_third_party')
})
