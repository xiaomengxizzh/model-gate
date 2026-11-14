// AGG-P02：凭据串域与鉴权失败语义（离线：纯模块 + 隔离网关回环 mock）。
// 覆盖：订阅身份头出现在第三方目标 -> 出站前拒绝；客户端官方头从不进入第三方上游；
//      401/403 是终态（不变成功、不换模型、不跨域重试）；诊断/日志只含 code。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startGateway, startScriptedUpstream } from './harness.mjs'
import {
  assertNoSubscriptionCredentialToThirdParty, assertDomainHeaderSeparation,
  resolveUpstream, buildDomainHeaders, authFailureReceipt, resolvedDiagnostic,
  isTargetAuthzError, AUTH_DOMAINS, TARGET_DOMAINS,
} from '../../../src/codex/target-authz.js'

const SUB_TOKEN = 'SUBSCRIPTION-CANARY-TOKEN'
const CLIENT_TOKEN = 'CLIENT-OFFICIAL-LEAK'

function denyOf(fn) {
  try { fn() } catch (e) {
    assert.equal(isTargetAuthzError(e), true)
    return e
  }
  assert.fail('预期被拒绝，实际放行')
}

function b64url(value) { return Buffer.from(JSON.stringify(value)).toString('base64url') }
function makeToken(marker) {
  return b64url({ alg: 'none', typ: 'JWT' }) + '.' + b64url({ exp: Math.floor(Date.now() / 1000) + 3600, marker, sub: 'synthetic' }) + '.signature-not-verified'
}
async function makeAuthHome(token) {
  const home = await mkdtemp(join(tmpdir(), 'mg-agg-auth-'))
  await mkdir(join(home, '.codex'), { recursive: true })
  await writeFile(join(home, '.codex', 'auth.json'), JSON.stringify({ tokens: { access_token: token, account_id: 'acct-agg' } }), 'utf8')
  return home
}
function respJson(text) {
  return JSON.stringify({ id: 'resp_mock', object: 'response', status: 'completed', model: 'mock', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], output_text: text, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } })
}
function config(officialBase, goBase, over) {
  return Object.assign({
    defaults: {
      codexOfficialHosts: ['localhost'],
      retry: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 2, jitter: 0 },
      timeout: { connectMs: 2000, firstByteMs: 2000, idleMs: 2000, overallMs: 5000, loopMs: 5000 },
    },
    providers: {
      official: { baseUrl: String(officialBase).replace('127.0.0.1', 'localhost'), codexIdentity: 'official', gatewaySubscription: { enabled: true } },
      go: { baseUrl: goBase, api: 'responses', apiKeyEnv: 'MG_AGG_A4_GO_KEY' },
    },
    models: {
      'codex-gpt': { provider: 'official', api: 'responses' },
      'codex-deepseek': { provider: 'go', api: 'responses', providerModels: { go: 'deepseek-v4.1-flash' }, codex: { plaintextTools: true, history: { agentMessage: 'project' } } },
    },
  }, over)
}

test('订阅身份头出现在第三方 host：零发送拒绝；订阅 host 放行', () => {
  const e = denyOf(() => assertNoSubscriptionCredentialToThirdParty(
    { authorization: 'Bearer ' + SUB_TOKEN, 'chatgpt-account-id': 'acct-1' }, 'opencode.ai',
  ))
  assert.equal(e.code, 'subscription_credential_to_third_party')
  assert.equal(e.message.includes(SUB_TOKEN), false, '拒绝消息不得含 token')
  assert.equal(e.message.includes('acct-1'), false, '拒绝消息不得含账号 id')

  const e2 = denyOf(() => assertNoSubscriptionCredentialToThirdParty({ 'chatgpt-account-id': 'acct-1' }, 'opencode.ai'))
  assert.equal(e2.code, 'subscription_credential_to_third_party')

  // loopback 只有在声明订阅域时才算订阅目的地（离线 mock），api-key 域不享受该例外。
  const e3 = denyOf(() => assertNoSubscriptionCredentialToThirdParty({ 'chatgpt-account-id': 'acct-1' }, '127.0.0.1:19001', { credentialSource: AUTH_DOMAINS.API_KEY }))
  assert.equal(e3.code, 'subscription_credential_to_third_party')

  assert.doesNotThrow(() => assertNoSubscriptionCredentialToThirdParty({ authorization: 'Bearer ' + SUB_TOKEN }, 'chatgpt.com'))
  assert.doesNotThrow(() => assertNoSubscriptionCredentialToThirdParty({}, 'opencode.ai'))
})

test('第三方构造的头即使被塞进订阅域标记也不会带出去', () => {
  const third = resolveUpstream({
    providerId: 'go', model: 'mg-go-x', upstreamModel: 'vendor-model',
    binding: { identity: TARGET_DOMAINS.THIRD_PARTY, host: 'https://opencode.ai', apiKey: true },
  })
  const headers = buildDomainHeaders(third, {
    incoming: { authorization: 'Bearer ' + CLIENT_TOKEN, 'chatgpt-account-id': 'acct-CLIENT' },
    credential: { providerKey: 'sk-go', accountId: 'acct-CANARY' },
  })
  assert.equal(JSON.stringify(headers).includes(CLIENT_TOKEN), false)
  assert.equal(JSON.stringify(headers).includes('acct-'), false)

  const mixed = denyOf(() => assertDomainHeaderSeparation(third, { 'chatgpt-account-id': 'acct-1' }))
  assert.equal(mixed.code, 'credential_mixing')
  const mixedKey = denyOf(() => assertDomainHeaderSeparation(resolveUpstream({
    providerId: 'codex-subscription', model: 'gpt-6-luna', upstreamModel: 'gpt-6-luna',
    binding: { identity: TARGET_DOMAINS.OFFICIAL, host: 'https://chatgpt.com', gatewaySubscription: true },
  }), { 'x-api-key': 'sk-1' }))
  assert.equal(mixedKey.code, 'credential_mixing')
})

test('401/403 是终态：不改写成功、不改模型、不跨域回退', () => {
  for (const status of [401, 403]) {
    const r = authFailureReceipt(status)
    assert.equal(r.status, status)
    assert.equal(r.terminal, true)
    assert.equal(r.retryable, false)
    assert.equal(r.fallbackAllowed, false)
    assert.equal(r.rewriteModel, false)
    assert.equal(r.rewriteStatus, false)
    assert.equal(Object.isFrozen(r), true)
  }
  assert.equal(authFailureReceipt(200), null)
  assert.equal(authFailureReceipt(500), null)
})

test('诊断与拒绝消息只含稳定 code / host，不含 token 或账号值', () => {
  const sub = resolveUpstream({
    providerId: 'codex-subscription', model: 'gpt-6-luna', upstreamModel: 'gpt-6-luna',
    binding: { identity: TARGET_DOMAINS.OFFICIAL, host: 'https://chatgpt.com', gatewaySubscription: true },
  })
  const text = JSON.stringify(resolvedDiagnostic(sub))
  assert.equal(text.includes('Bearer'), false)
  assert.equal(text.includes(SUB_TOKEN), false)

  const e = denyOf(() => resolveUpstream({
    providerId: 'go', model: 'mg-go-x', upstreamModel: 'mg-go-x',
    binding: { identity: TARGET_DOMAINS.THIRD_PARTY, host: 'https://opencode.ai', apiKey: true, providerKey: 'sk-SHOULD-NOT-APPEAR' },
  }))
  assert.equal(e.message.includes('sk-SHOULD-NOT-APPEAR'), false)
})

test('网关：第三方 provider 声明 gatewaySubscription -> 403 且零上游；token 不进日志', { timeout: 30000 }, async (t) => {
  const token = makeToken('AGG_A4_LEAK')
  const home = await makeAuthHome(token)
  const dead = await startScriptedUpstream(async (req, res) => { res.writeHead(200); res.end(respJson('must-not-hit')) })
  const cfg = config(dead.base, dead.base)
  cfg.providers.bad = { baseUrl: dead.base, codexIdentity: 'thirdParty', gatewaySubscription: { enabled: true }, api: 'responses' }
  cfg.models.bad = { provider: 'bad', api: 'responses' }
  const gw = await startGateway({ name: 'agg-a4-leak', env: { HOME: home, CODEX_HOME: join(home, '.codex') }, config: cfg })
  t.after(async () => { await gw.stop(); await dead.stop(); await rm(home, { recursive: true, force: true }) })

  const res = await gw.post('/v1/responses', { model: 'bad', input: 'hi' })
  assert.equal(res.status, 403)
  const err = (await res.json()).error
  assert.equal(err.code, 'gateway_subscription_target_not_allowed')
  assert.equal(dead.hits.length, 0, '拒绝必须发生在任何出站请求之前')
  assert.equal(gw.stderr().includes(token), false)
  assert.equal(gw.stderr().includes('AGG_A4_LEAK'), false)
})

test('网关：客户端 chatgpt-account-id / authorization 不进入第三方上游', { timeout: 30000 }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'mg-agg-a4-empty-'))
  const dead = await startScriptedUpstream(async (req, res) => { res.writeHead(500); res.end('{}') })
  const goHits = []
  const go = await startScriptedUpstream(async (req, res, rec) => {
    for await (const _ of req) { /* drain */ }
    goHits.push(rec)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(respJson('GO_OK'))
  })
  const gw = await startGateway({ name: 'agg-a4-headers', env: { HOME: home, MG_AGG_A4_GO_KEY: 'sk-go-test' }, config: config(dead.base, go.base) })
  t.after(async () => { await gw.stop(); await dead.stop(); await go.stop(); await rm(home, { recursive: true, force: true }) })

  const res = await gw.post('/v1/responses', { model: 'codex-deepseek', input: 'hi' }, {
    authorization: 'Bearer ' + CLIENT_TOKEN,
    'chatgpt-account-id': 'acct-CLIENT-LEAK',
    'openai-beta': 'responses=experimental',
  })
  assert.equal(res.status, 200)
  assert.equal(goHits.length, 1)
  const sent = goHits[0].headers
  assert.equal(sent['chatgpt-account-id'], undefined)
  assert.equal(sent['openai-beta'], undefined)
  assert.notEqual(sent.authorization, 'Bearer ' + CLIENT_TOKEN)
  assert.equal(sent.authorization, 'Bearer sk-go-test')
  assert.equal(dead.hits.length, 0)
  assert.equal(JSON.stringify(gw.stderr()).includes(CLIENT_TOKEN), false)
})
