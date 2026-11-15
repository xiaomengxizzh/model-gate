// V2-REAL-3 / A4：订阅入口守卫（离线，真实网关子进程 + 本地 mock 上游，零真实上游）。
//
// 四条不可绕过的边界（每条都断言 typed code + 零上游命中）：
//   1. 未开 gatewaySubscription 时，/backend-api/codex 入口必须 official_path_not_allowlisted；
//   2. 第三方 provider 声明 gatewaySubscription → 403，绝不借用官方身份；
//   3. off 模式（不写订阅字段、无网关自有 key）请求官方模型 → typed 403 official_no_gateway_key；
//   4. local 模式 + 过期/缺失本机登录 → 401 subscription_credential_unavailable，不静默改走 app。
// 说明：mock 上游用回环地址替代真实 host，只为**可测量零上游**；模式/凭据形状与生成配置一致。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startGateway, startScriptedUpstream } from './harness.mjs'
import { buildSubscriptionProviderConfig, SUBSCRIPTION_RESPONSES_PATH } from '../../../src/codex/local-subscription.js'

function b64url(value) { return Buffer.from(JSON.stringify(value)).toString('base64url') }
function jwt(expSec) {
  return b64url({ alg: 'none', typ: 'JWT' }) + '.' + b64url({ exp: expSec, sub: 'canary' }) + '.sig'
}

function baseConfig(over = {}) {
  return Object.assign({
    defaults: {
      codexOfficialHosts: ['localhost'],
      retry: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 2, jitter: 0 },
      timeout: { connectMs: 2000, firstByteMs: 2000, idleMs: 2000, overallMs: 5000, loopMs: 5000 },
    },
    providers: {},
    models: {},
  }, over)
}

function responsesJson(text) {
  return JSON.stringify({
    id: 'resp_mock', object: 'response', status: 'completed', model: 'mock',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
    output_text: text, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  })
}

test('未开 gatewaySubscription：/backend-api/codex 入口 → official_path_not_allowlisted，零上游', { timeout: 30000 }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'mg-v2-real3-guard1-'))
  const upstream = await startScriptedUpstream(async (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(responsesJson('MUST-NOT-BE-SENT'))
  })
  const cfg = baseConfig({
    providers: {
      official: { baseUrl: upstream.base, codexIdentity: 'official' },
      go: { baseUrl: upstream.base, api: 'responses', apiKeyEnv: 'MG_V2_REAL3_GO_KEY' },
    },
    models: {
      'gpt-6-luna': { provider: 'official', api: 'responses', responsesPath: SUBSCRIPTION_RESPONSES_PATH },
      'go-child': { provider: 'go', api: 'responses', providerModels: { go: 'deepseek-v4.1-flash' } },
    },
  })
  // baseUrl 用回环 host，因此把回环加进官方白名单（真实 local 模式用 chatgpt.com）。
  cfg.defaults.codexOfficialHosts = ['localhost', '127.0.0.1']
  const gw = await startGateway({ name: 'v2-real3-guard1', env: { HOME: home, MG_V2_REAL3_GO_KEY: 'sk-canary' }, config: cfg })
  t.after(async () => { await gw.stop(); await upstream.stop(); await rm(home, { recursive: true, force: true }) })

  const res = await gw.post('/v1/responses', { model: 'gpt-6-luna', input: 'hi' })
  assert.equal(res.status, 403)
  const body = await res.json()
  assert.equal(body.error.code, 'official_path_not_allowlisted', JSON.stringify(body))
  assert.equal(upstream.hits.length, 0, '拒绝必须发生在任何出站请求之前')
})

test('第三方 provider 声明 gatewaySubscription → 403，零上游', { timeout: 30000 }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'mg-v2-real3-guard2-'))
  const upstream = await startScriptedUpstream(async (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(responsesJson('MUST-NOT-BE-SENT'))
  })
  const cfg = baseConfig({
    providers: {
      evil: { baseUrl: upstream.base, codexIdentity: 'thirdParty', api: 'responses', gatewaySubscription: { enabled: true }, apiKeyEnv: 'MG_V2_REAL3_GO_KEY' },
    },
    models: { 'go-child': { provider: 'evil', api: 'responses', providerModels: { evil: 'deepseek-v4.1-flash' } } },
  })
  const gw = await startGateway({ name: 'v2-real3-guard2', env: { HOME: home, MG_V2_REAL3_GO_KEY: 'sk-canary' }, config: cfg })
  t.after(async () => { await gw.stop(); await upstream.stop(); await rm(home, { recursive: true, force: true }) })

  const res = await gw.post('/v1/responses', { model: 'go-child', input: 'hi' })
  assert.equal(res.status, 403)
  const body = await res.json()
  assert.equal(body.error.code, 'gateway_subscription_target_not_allowed', JSON.stringify(body))
  assert.equal(upstream.hits.length, 0, '非官方上游不得承载订阅身份')
})

test('off 模式：官方模型无网关自有 key → typed 403 official_no_gateway_key，零上游', { timeout: 30000 }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'mg-v2-real3-guard3-'))
  const upstream = await startScriptedUpstream(async (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(responsesJson('MUST-NOT-BE-SENT'))
  })
  // off 模式生成的 provider 形状（api.openai.com + 无 responsesPath/gatewaySubscription），
  // 只把 baseUrl 换回环 mock 以便测量"零上游"；不注入任何 key。
  const off = buildSubscriptionProviderConfig('off').provider
  const cfg = baseConfig({
    providers: { official: Object.assign({}, off, { baseUrl: upstream.base }) },
    models: { 'gpt-6-luna': { provider: 'official', api: 'responses' } },
  })
  cfg.defaults.codexOfficialHosts = ['localhost', '127.0.0.1', 'api.openai.com']
  const gw = await startGateway({ name: 'v2-real3-guard3', env: { HOME: home }, config: cfg })
  t.after(async () => { await gw.stop(); await upstream.stop(); await rm(home, { recursive: true, force: true }) })

  const res = await gw.post('/v1/responses', { model: 'gpt-6-luna', input: 'hi' })
  assert.equal(res.status, 403)
  const body = await res.json()
  assert.equal(body.error.code, 'official_no_gateway_key', JSON.stringify(body))
  assert.equal(upstream.hits.length, 0, 'off 模式绝不静默走别的路径')
})

test('local 模式：过期本机登录 → 401 subscription_credential_unavailable，零上游、不改走 app', { timeout: 30000 }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'mg-v2-real3-guard4-'))
  const codex = join(home, '.codex')
  await mkdir(codex, { recursive: true })
  await writeFile(join(codex, 'auth.json'), JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { access_token: jwt(Math.floor(Date.now() / 1000) - 120), refresh_token: 'CANARY-RT', account_id: 'acct-canary' },
  }), 'utf8')
  const upstream = await startScriptedUpstream(async (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(responsesJson('MUST-NOT-BE-SENT'))
  })
  const local = buildSubscriptionProviderConfig('local').provider
  const cfg = baseConfig({
    providers: { official: Object.assign({}, local, { baseUrl: upstream.base }) },
    models: { 'gpt-6-luna': { provider: 'official', api: 'responses' } },
  })
  cfg.defaults.codexOfficialHosts = ['localhost', '127.0.0.1', 'chatgpt.com']
  const gw = await startGateway({ name: 'v2-real3-guard4', env: { HOME: home, CODEX_HOME: codex }, config: cfg })
  t.after(async () => { await gw.stop(); await upstream.stop(); await rm(home, { recursive: true, force: true }) })

  const res = await gw.post('/v1/responses', { model: 'gpt-6-luna', input: 'hi' })
  assert.equal(res.status, 401)
  const body = await res.json()
  assert.equal(body.error.code, 'subscription_credential_unavailable', JSON.stringify(body))
  assert.equal(upstream.hits.length, 0, '凭据不可用必须零上游')
  assert.equal(gw.stderr().includes('CANARY-RT'), false, '日志不得含 refresh token')
  assert.equal(gw.stderr().includes(jwt(Math.floor(Date.now() / 1000) - 120)), false, '日志不得含 access token')
})
