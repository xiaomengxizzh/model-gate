// F01｜官方原生凭据透传的关闭边界（native-boundary）。
//
// 背景：生产路径 /backend-api/codex 的「客户端官方凭据透传」已移除。本套件只证明**边界**：
//   1. 第三方目标零收到：合成 OAuth / 账户头 / opaque 字段（x-codex-*、x-openai-internal-*、chatgpt-*）
//      一个都到不了第三方上游，且日志不含其值；
//   2. 官方内部目标零发送：旧开关残留 + 官方目标无网关自有 key → 403（typed 码 + 迁移提示），
//      零上游请求、零第三方改投；
//   3. 302 禁跟随：官方上游返回 3xx 时网关 502 收口，绝不把请求/凭据送到 Location；
//   4. 官方直连仍可用：网关自有 key 是唯一凭据来源，客户端凭据不进入头集合。
// 全部离线：本地 mock 上游 + 动态回环端口 + OS 临时配置目录；不使用真实凭据/上游。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { startGateway, startScriptedUpstream } from './harness.mjs'
import {
  OFFICIAL_PATH_PREFIXES, planTargetHeaders, targetDeny,
  legacyPassthroughRequested, officialPassthroughEnabled,
} from '../../../src/codex/auth.js'
import { classifyTarget } from '../../../src/codex/identity.js'
import { CREDENTIAL_MODES, TARGET_DOMAINS, credentialModeAllowed } from '../../../src/codex/target-authz.js'
import { scanAuthBoundary } from './auth-boundary-scan.mjs'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

// 合成凭据/opaque 字段：值全部虚构，只用于断言「存在/不存在」，绝不出现在任何日志或报告里。
const SYNTHETIC = Object.freeze({
  oauth: 'SYNTHETIC-OAUTH-ACCESS-TOKEN-0001',
  account: 'SYNTHETIC-ACCOUNT-ID-0003',
  opaque: 'SYNTHETIC-OPAQUE-PAYLOAD-0004',
})
const SYNTHETIC_HEADERS = Object.freeze({
  authorization: 'Bearer ' + SYNTHETIC.oauth,
  'chatgpt-account-id': SYNTHETIC.account,
  'openai-beta': 'responses=experimental',
  version: '0.167.0',
  originator: 'codex_cli_rs',
  'session-id': 'SYNTHETIC-SESSION-0005',
  'thread-id': 'SYNTHETIC-THREAD-0006',
  'x-client-request-id': 'SYNTHETIC-REQUEST-0007',
  'x-codex-beta-features': 'multi_agent',
  'x-codex-turn-metadata': SYNTHETIC.opaque,
  'x-codex-window-id': 'win-0008',
  'x-codex-routing-hint': 'hint',
  'x-openai-internal-codex-responses-lite': '1',
  'x-ordinary-client-header': 'kept',
})
// 凭据类：任何身份域都不得由客户端带入（官方域只允许网关按自有 key 注入 authorization）。
const SYNTHETIC_CREDENTIAL_HEADERS = Object.freeze(['authorization', 'chatgpt-account-id'])
// 官方专用/opaque 字段：官方域按白名单保留，第三方域必须一个都不剩。
const SYNTHETIC_OFFICIAL_ONLY_HEADERS = Object.freeze([
  'authorization', 'chatgpt-account-id',
  'openai-beta', 'version', 'originator', 'session-id', 'thread-id',
  'x-client-request-id', 'x-codex-beta-features', 'x-codex-turn-metadata',
  'x-codex-window-id', 'x-codex-routing-hint', 'x-openai-internal-codex-responses-lite',
])
const SYNTHETIC_VALUES = Object.freeze([SYNTHETIC.oauth, SYNTHETIC.account, SYNTHETIC.opaque, 'SYNTHETIC-SESSION-0005', 'SYNTHETIC-THREAD-0006'])
const THIRD_KEY = 'gw-third-synthetic-key'

const CHAT = { model: 'demo', messages: [{ role: 'user', content: 'hi' }] }
// 官方 mock 用 localhost（白名单只放行 localhost），第三方 mock 用 127.0.0.1：
// 否则「127.0.0.1 在白名单里」会把第三方也判成官方域，测试就失去意义。
const OFFICIAL_HOSTS = ['localhost']
const officialBase = (up) => 'http://localhost:' + up.port
const cfgWithHosts = { defaults: { codexOfficialHosts: OFFICIAL_HOSTS } }

function assertNoSyntheticValues(text, where) {
  for (const value of SYNTHETIC_VALUES) assert.equal(text.includes(value), false, where + ' 不得包含合成凭据值 ' + value)
}

function readLogOf(gw) {
  const names = readdirSync(gw.dir).filter((n) => n.endsWith('.log')).sort()
  return names.map((n) => readFileSync(join(gw.dir, n), 'utf8')).join('\n')
}

async function startJsonUpstream(hits, body) {
  return startScriptedUpstream(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    hits.push({ method: req.method, url: req.url, headers: req.headers })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  })
}

// —— 单元边界 ——

test('路径白名单：/backend-api/codex 已移除，官方只剩 /v1', () => {
  assert.equal(OFFICIAL_PATH_PREFIXES.some((p) => p.includes('backend-api')), false, '订阅后端路径不得留在白名单')
  const official = { id: 'o', baseUrl: 'http://localhost:9', apiKey: 'gw-key', _def: {} }
  const identity = classifyTarget(official, cfgWithHosts)
  assert.equal(identity.kind, 'official')
  assert.equal(targetDeny({ identity, provider: official, cfg: cfgWithHosts, path: '/backend-api/codex/responses', env: {} }).code, 'official_path_not_allowlisted')
  assert.equal(targetDeny({ identity, provider: official, cfg: cfgWithHosts, path: '/v1/responses', env: {} }), null)
})

test('凭据分类：官方无 key = none（不再产生 client-passthrough）', () => {
  const noKey = classifyTarget({ id: 'o', baseUrl: 'https://api.openai.com' }, {})
  assert.equal(noKey.kind, 'official')
  assert.equal(noKey.credential, 'none')
  const withKey = classifyTarget({ id: 'o', baseUrl: 'https://api.openai.com', apiKey: 'gw-key' }, {})
  assert.equal(withKey.credential, 'provider-key')
})

test('头计划：合成 OAuth/账户/opaque 字段在官方与第三方域都进不了头集合（旧 passthrough 参数被忽略）', () => {
  const official = planTargetHeaders({ identity: { kind: 'official', credential: 'provider-key' }, provider: {}, incoming: SYNTHETIC_HEADERS })
  const officialRetired = planTargetHeaders({ identity: { kind: 'official', credential: 'provider-key' }, provider: {}, incoming: SYNTHETIC_HEADERS, passthrough: true })
  const third = planTargetHeaders({ identity: { kind: 'thirdParty' }, provider: {}, incoming: SYNTHETIC_HEADERS })
  for (const [label, plan] of [['official', official], ['official+legacy-passthrough', officialRetired], ['thirdParty', third]]) {
    for (const name of SYNTHETIC_CREDENTIAL_HEADERS) {
      assert.equal(plan.headers[name], undefined, label + ' 头集合不得含凭据头 ' + name)
    }
    assert.equal(plan.dropped.includes('authorization'), true, label + ' 必须把 authorization 记为丢弃头名')
    assert.equal(JSON.stringify(plan.headers).includes(SYNTHETIC.oauth), false, label + ' 头值不得泄漏合成 OAuth')
  }
  // 第三方：官方专用/opaque 字段一个都不剩
  for (const name of SYNTHETIC_OFFICIAL_ONLY_HEADERS) {
    assert.equal(third.headers[name], undefined, '第三方头集合不得含 ' + name)
  }
  // 官方：白名单内非凭据头保留，白名单外的普通头丢弃
  assert.equal(official.headers['openai-beta'], 'responses=experimental')
  assert.equal(official.headers['x-codex-turn-metadata'], SYNTHETIC.opaque)
  assert.equal(official.headers['x-ordinary-client-header'], undefined)
  // 普通客户端头不误伤（第三方保留）
  assert.equal(third.headers['x-ordinary-client-header'], 'kept')
})

test('旧开关只做识别：legacyPassthroughRequested 判真，officialPassthroughEnabled 恒为 false（模板已删除）', () => {
  assert.equal(legacyPassthroughRequested({ MG_CODEX_OFFICIAL_PASSTHROUGH: '1' }), true)
  assert.equal(legacyPassthroughRequested({ MG_CODEX_OFFICIAL_PASSTHROUGH: 'on' }), true)
  assert.equal(legacyPassthroughRequested({ MG_CODEX_OFFICIAL_PASSTHROUGH: '0' }), false)
  assert.equal(legacyPassthroughRequested({}), false)
  assert.equal(officialPassthroughEnabled({ MG_CODEX_OFFICIAL_PASSTHROUGH: '1' }), false, '退役后不存在「打开」状态')
  const authSrc = readFileSync(join(ROOT, 'src/codex/auth.js'), 'utf8')
  assert.equal(/export function buildOfficialHeaders/.test(authSrc), false, '旧模板必须删除，避免未来调用方误用')
})

test('凭据模式：official-subscription 与旧声明一律 typed deny（不静默启用）', () => {
  const target = { hostname: 'api.openai.com', host: 'api.openai.com', pathname: '/v1/responses' }
  assert.equal(credentialModeAllowed(TARGET_DOMAINS.OFFICIAL, target, { credentialMode: CREDENTIAL_MODES.OFFICIAL_SUBSCRIPTION }).code, 'credential_mode_retired')
  assert.equal(credentialModeAllowed(TARGET_DOMAINS.THIRD_PARTY, target, { credentialMode: CREDENTIAL_MODES.OFFICIAL_SUBSCRIPTION }).code, 'credential_mode_retired')
  assert.equal(credentialModeAllowed(TARGET_DOMAINS.OFFICIAL, target, { credentialMode: CREDENTIAL_MODES.NONE, officialSubscription: true }).code, 'official_passthrough_retired')
  assert.equal(credentialModeAllowed(TARGET_DOMAINS.OFFICIAL, target, { credentialMode: CREDENTIAL_MODES.NONE, legacyPassthrough: true }).code, 'official_passthrough_retired')
  assert.equal(credentialModeAllowed(TARGET_DOMAINS.OFFICIAL, target, { credentialMode: CREDENTIAL_MODES.NONE }).code, 'official_credential_missing')
})

test('不读取登录态：递归扫描全部 src，不碰 auth.json / CODEX_HOME / local-subscription', () => {
  // F01 回归教训：旧断言只扫 auth.js/identity.js/index.js，漏掉了 src/codex/local-subscription.js。
  // 现在由 auth-boundary-scan 递归扫描 src/**/*.js：CODEX_HOME 读取、auth.json 读取、
  // local-subscription 引用、订阅后端路径字面量、~/.codex 目录拼装都会失败。
  const violations = scanAuthBoundary(ROOT)
  assert.deepEqual(violations, [], '生产代码认证边界违规:\n' + violations.join('\n'))
  assert.equal(existsSync(join(ROOT, 'src/codex/local-subscription.js')), false, 'local-subscription.js 必须删除，而不是留在生产树里')
  const indexSrc = readFileSync(join(ROOT, 'src/index.js'), 'utf8')
  assert.equal(/from\s+['"][^'"]*local-subscription/.test(indexSrc), false, 'src/index.js 不得再 import local-subscription.js')
  // 退役模式不得回流：旧常量既不能导出，也不能被授权层识别成可用模式。
  assert.equal(Object.prototype.hasOwnProperty.call(CREDENTIAL_MODES, 'GATEWAY_SUBSCRIPTION'), false, 'GATEWAY_SUBSCRIPTION 模式必须从 CREDENTIAL_MODES 移除')
})

// —— 集成边界 ——

test('集成：第三方零收到 + 官方内部目标零发送（旧开关残留、无自有 key）', { timeout: 30000 }, async (t) => {
  const officialHits = []
  const thirdHits = []
  const official = await startScriptedUpstream(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    officialHits.push({ url: req.url, headers: req.headers })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'r1', object: 'response', status: 'completed', model: 'gpt-official-test', output: [] }))
  })
  const third = await startJsonUpstream(thirdHits, { id: 'c1', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
  const gw = await startGateway({
    name: 'f01-native-boundary',
    env: { MG_CODEX_OFFICIAL_PASSTHROUGH: '1', MG_TEST_THIRD_KEY: THIRD_KEY },   // 旧开关残留：必须被拒绝，而不是被尊重
    config: {
      defaults: { provider: 'third', codexOfficialHosts: OFFICIAL_HOSTS },
      providers: {
        official: { baseUrl: officialBase(official), codexIdentity: 'official' },   // 无自有 key
        third: { baseUrl: third.base, apiKeyEnv: 'MG_TEST_THIRD_KEY' },
      },
      models: { 'gpt-official-test': { provider: 'official', api: 'responses' }, demo: { provider: 'third' } },
    },
  })
  t.after(async () => { await gw.stop(); await official.stop(); await third.stop() })

  // 1) 官方内部目标：旧开关 + 无 key → 拒绝且零发送
  const officialRes = await gw.call('/v1/responses', { method: 'POST', headers: SYNTHETIC_HEADERS, body: { model: 'gpt-official-test', input: 'hi' } })
  assert.equal(officialRes.status, 403)
  const officialJson = await officialRes.json()
  assert.equal(officialJson.error.code, 'official_passthrough_retired')
  assert.match(officialJson.error.message, /已移除/, '拒绝消息必须说明能力已移除')
  assert.equal(officialHits.length, 0, '官方内部目标零发送')
  assert.equal(thirdHits.length, 0, '拒绝不得改投第三方')

  // 2) 第三方目标：同一批合成头 → 零收到（只有网关注入的自有 key）
  const thirdRes = await gw.call('/v1/chat/completions', { method: 'POST', headers: SYNTHETIC_HEADERS, body: CHAT })
  assert.equal(thirdRes.status, 200)
  assert.equal(thirdHits.length, 1)
  const seen = thirdHits[0].headers
  for (const name of SYNTHETIC_OFFICIAL_ONLY_HEADERS.filter((n) => n !== 'authorization')) {
    assert.equal(seen[name], undefined, '第三方上游不得收到 ' + name)
  }
  assert.equal(seen['x-ordinary-client-header'], 'kept', '非敏感客户端头不应被误伤')
  assert.equal(seen.authorization, 'Bearer ' + THIRD_KEY, '第三方只收网关自有 key')
  assert.equal(seen['sec-websocket-key'], undefined)

  // 3) 全链路日志脱敏：合成凭据值一个都不出现
  const log = readLogOf(gw)
  assertNoSyntheticValues(log, '网关日志')
})

test('集成：官方直连 302 禁跟随 —— 502 收口、Location 零命中、响应不带 Location', { timeout: 30000 }, async (t) => {
  const sinkHits = []
  const sink = await startJsonUpstream(sinkHits, { id: 'leak', object: 'chat.completion', choices: [] })
  const officialHits = []
  const official = await startScriptedUpstream(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    officialHits.push({ url: req.url, headers: req.headers })
    res.writeHead(302, { location: sink.base + '/v1/responses' })
    res.end()
  })
  const gw = await startGateway({
    name: 'f01-native-redirect',
    env: { MG_TEST_OFFICIAL_KEY: 'gw-official-redirect-key' },
    config: {
      defaults: { provider: 'official', codexOfficialHosts: OFFICIAL_HOSTS },
      providers: { official: { baseUrl: officialBase(official), codexIdentity: 'official', apiKeyEnv: 'MG_TEST_OFFICIAL_KEY' } },
      models: { 'gpt-official-test': { provider: 'official', api: 'responses' } },
    },
  })
  t.after(async () => { await gw.stop(); await official.stop(); await sink.stop() })

  const res = await gw.call('/v1/responses', { method: 'POST', headers: SYNTHETIC_HEADERS, body: { model: 'gpt-official-test', input: 'hi' } })
  assert.equal(res.status, 502, '官方上游 3xx 必须按上游错误收口，不能把 3xx 交给客户端跟随')
  assert.equal(res.headers.get('location'), null, '响应不得携带上游 Location')
  const json = await res.json()
  assert.equal(json.error.code, 'upstream_redirect_rejected')
  assert.equal(officialHits.length, 1, '只命中原始官方上游一次')
  assert.equal(sinkHits.length, 0, 'Location 目标零命中（禁跟随）')
  // 客户端凭据从未离开网关：上游只看到网关自有 key
  assert.equal(officialHits[0].headers.authorization, 'Bearer gw-official-redirect-key')
  assert.equal(officialHits[0].headers['chatgpt-account-id'], undefined)
  const log = readLogOf(gw)
  assertNoSyntheticValues(log, '重定向路径日志')
})

test('集成：官方直连保留（自有 key 200），客户端凭据零透传、白名单外层丢弃', { timeout: 30000 }, async (t) => {
  const officialHits = []
  const official = await startScriptedUpstream(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    officialHits.push({ url: req.url, headers: req.headers })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'r1', object: 'response', status: 'completed', model: 'gpt-official-test', output: [] }))
  })
  const gw = await startGateway({
    name: 'f01-native-direct',
    env: { MG_TEST_OFFICIAL_KEY: 'gw-official-direct-key' },
    config: {
      defaults: { provider: 'official', codexOfficialHosts: OFFICIAL_HOSTS },
      providers: { official: { baseUrl: officialBase(official), codexIdentity: 'official', apiKeyEnv: 'MG_TEST_OFFICIAL_KEY' } },
      models: { 'gpt-official-test': { provider: 'official', api: 'responses' } },
    },
  })
  t.after(async () => { await gw.stop(); await official.stop() })

  const res = await gw.call('/v1/responses', { method: 'POST', headers: SYNTHETIC_HEADERS, body: { model: 'gpt-official-test', input: 'hi' } })
  assert.equal(res.status, 200, '官方直连（网关自有 key）必须保留可用')
  assert.equal(officialHits.length, 1)
  const seen = officialHits[0].headers
  assert.equal(seen.authorization, 'Bearer gw-official-direct-key', '官方 Authorization 只来自网关自有 key')
  assert.equal(seen['chatgpt-account-id'], undefined, '客户端账户头零透传')
  assert.equal(seen['x-codex-turn-metadata'], SYNTHETIC.opaque, '白名单内 opaque 头按策略保留（非凭据）')
  assert.equal(seen['x-ordinary-client-header'], undefined, '官方白名单外的客户端头必须丢弃')
})
