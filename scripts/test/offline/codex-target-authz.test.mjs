// M2-1 / P0-3：最终目标授权（target-authz）纯模块回归。
// 不联网、不启网关：只验证「一次规范化 -> 不可变授权记录 -> 拼装后二次校验」这条链，
// 以及域/凭据分离、第三方空白头 + 域派生会话、fail-closed 与 generation 绑定。
// 断言只比较拒绝码/URL/头名，绝不把真实 Key 写进日志；哨兵值均为虚构。
import test from 'node:test'
import assert from 'node:assert/strict'
import { upstreamUrl } from '../../../src/request.js'
import { classifyTarget } from '../../../src/codex/identity.js'
import {
  authorizeFinalTarget, assertSendTarget, canonicalizeUrlOnce, targetKeyOfUrl,
  deriveSessionIdentity, credentialModeAllowed, TARGET_DOMAINS, CREDENTIAL_MODES,
  isTargetAuthzError, DEFAULT_SESSION_SALT,
} from '../../../src/codex/target-authz.js'

const OFFICIAL_INCOMING = Object.freeze({
  authorization: 'Bearer CLIENT-OFFICIAL-TOKEN',
  'chatgpt-account-id': 'acct-CLIENT-ACCOUNT',
  'openai-beta': 'responses=experimental',
  version: '0.167.0',
  originator: 'codex_cli_rs',
  'session-id': 'sess-CLIENT-SESSION',
  'thread-id': 'thread-CLIENT-THREAD',
  'x-client-request-id': 'req-CLIENT-REQUEST',
  'x-codex-beta-features': 'multi_agent',
  'x-ordinary-client-header': 'must-be-dropped',
})

function denyOf(fn) {
  try { fn() } catch (e) {
    assert.equal(isTargetAuthzError(e), true, '必须是 typed deny')
    assert.equal(e.status, 403)
    assert.equal(e.deny, true)
    return e
  }
  assert.fail('预期被拒绝，实际放行')
}

function configWithOfficialHosts(hosts) {
  return hosts ? { defaults: { codexOfficialHosts: hosts } } : {}
}

// 第三方上游（本机回环风格，端口只是占位，不发请求）
function thirdProvider(over) {
  return Object.assign({ id: 'third', baseUrl: 'http://127.0.0.1:19001', apiKey: 'sk-THIRD-KEY' }, over || {})
}

function officialProvider(over) {
  return Object.assign({ id: 'openai', baseUrl: 'https://api.openai.com', apiKey: 'sk-OFFICIAL-KEY' }, over || {})
}

function subscriptionProvider() {
  return { id: 'chatgpt', baseUrl: 'https://chatgpt.com' }
}

function thirdBinding(provider, identity, cfg, over) {
  return Object.assign({
    generation: 7,
    origin: provider.baseUrl,
    path: '/v1/chat/completions',
    identity,
    provider,
    cfg,
    thirdPartyVerified: true,
    providerId: provider.id,
    modelBinding: { model: 'mg-third-demo', serving: 'demo-real' },
  }, over || {})
}

function thirdIntent(caller, over) {
  return Object.assign({
    domain: TARGET_DOMAINS.THIRD_PARTY,
    caller: Object.assign({
      incoming: OFFICIAL_INCOMING,
      threadId: 'thread-CLIENT-THREAD',
      sessionHeader: 'x-opencode-session',
    }, caller || {}),
  }, over || {})
}

function officialBinding(provider, identity, cfg, over) {
  return Object.assign({
    generation: 3,
    origin: provider.baseUrl,
    path: '/v1/chat/completions',
    identity,
    provider,
    cfg,
    officialVerified: true,
    providerId: provider.id,
    modelBinding: { model: 'gpt-demo', serving: 'gpt-demo' },
  }, over || {})
}

function assertNoSentinels(text, sentinels) {
  for (const s of sentinels) assert.equal(String(text).includes(s), false, '拒绝消息/头集合不得包含 ' + s)
}

test('canonicalizeUrlOnce 与 upstreamUrl 同构：尾斜杠、/v1 去重、大小写主机、默认端口、百分号编码', () => {
  const cases = [
    [{ baseUrl: 'https://api.openai.com', pathPrefix: '' }, '/v1/chat/completions'],
    [{ baseUrl: 'https://api.openai.com/', pathPrefix: '' }, '/v1/chat/completions'],
    [{ baseUrl: 'https://api.openai.com/v1', pathPrefix: '' }, '/v1/chat/completions'],
    [{ baseUrl: 'https://API.OPENAI.COM:443', pathPrefix: '' }, '/v1/models'],
    [{ baseUrl: 'http://127.0.0.1:19001', pathPrefix: '/v1' }, '/chat/completions'],
    [{ baseUrl: 'https://api.openai.com', pathPrefix: '' }, '/v1/models?client_version=1'],
    [{ baseUrl: 'https://api.openai.com', pathPrefix: '' }, '/v1/models?q=%E4%B8%AD%E6%96%87'],
  ]
  for (const [prov, path] of cases) {
    const expected = upstreamUrl(prov, path)
    const canonical = canonicalizeUrlOnce(prov.baseUrl, path, prov.pathPrefix)
    assert.equal(canonical.href, expected.href, '规范化结果必须与 upstreamUrl 同构: ' + prov.baseUrl + ' + ' + path)
    assert.equal(canonical.key, targetKeyOfUrl(expected), 'key 必须与 upstreamUrl 一致')
    assert.equal(Object.isFrozen(canonical), true)
  }
  assert.equal(canonicalizeUrlOnce('https://API.OPENAI.COM:443/', '/v1/models').href, 'https://api.openai.com/v1/models')
  const withUserinfo = denyOf(() => canonicalizeUrlOnce('https://api.openai.com', '/v1/x', '@evil.test'))
  assert.equal(withUserinfo.code, 'target_userinfo_forbidden')
  const withFragment = denyOf(() => canonicalizeUrlOnce('https://api.openai.com', '/v1/x#frag'))
  assert.equal(withFragment.code, 'target_fragment_not_allowed')
})

test('第三方授权：最终目标固化、空白头 + 域派生会话、记录不可变', () => {
  const cfg = configWithOfficialHosts()
  const provider = thirdProvider()
  const identity = classifyTarget(provider, cfg)
  assert.equal(identity.kind, 'thirdParty')
  const authz = authorizeFinalTarget(thirdIntent(), 7, thirdBinding(provider, identity, cfg))

  assert.equal(authz.ok, true)
  assert.equal(authz.domain, TARGET_DOMAINS.THIRD_PARTY)
  assert.equal(authz.generation, 7)
  assert.equal(authz.target.href, upstreamUrl(provider, '/v1/chat/completions').href)
  assert.equal(authz.redirect, 'error', '授权记录必须带显式禁重定向标记')
  assert.equal(Object.isFrozen(authz), true)
  assert.equal(Object.isFrozen(authz.target), true)
  assert.equal(Object.isFrozen(authz.headers), true)
  assert.equal(Object.isFrozen(authz.modelBinding), true)
  assert.equal(authz.modelBinding.serving, 'demo-real')

  const names = Object.keys(authz.headers)
  assert.deepEqual(names, ['x-opencode-session'], '第三方头必须从空白构造，只加派生会话标识')
  const value = authz.headers['x-opencode-session']
  assert.match(value, /^[0-9a-f]{32}$/)
  assert.equal(authz.derivedSession.header, 'x-opencode-session')
  assert.equal(authz.derivedSession.value, value)
  assert.notEqual(value, 'thread-CLIENT-THREAD')
  assert.equal(value.includes('thread-CLIENT-THREAD'), false)

  const dumped = JSON.stringify(authz.headers)
  assertNoSentinels(dumped, ['CLIENT-OFFICIAL-TOKEN', 'acct-CLIENT-ACCOUNT', 'thread-CLIENT-THREAD', 'Bearer '])
  assert.equal(names.some((n) => n === 'authorization' || n === 'chatgpt-account-id'), false)
  assert.equal(names.some((n) => n.startsWith('codex-') || n.startsWith('x-codex-') || n.startsWith('openai-') || n.startsWith('x-openai-') || n.startsWith('chatgpt-')), false)

  // 不可变：尝试改写必须抛错，且不污染记录
  assert.throws(() => { authz.headers['authorization'] = 'Bearer EVIL' }, TypeError)
  assert.throws(() => { authz.domain = 'official' }, TypeError)
  assert.throws(() => { authz.target.href = 'https://evil.test' }, TypeError)
  assert.equal(authz.headers.authorization, undefined)
  assert.equal(authz.target.href, upstreamUrl(provider, '/v1/chat/completions').href)
})

test('拼装后二次校验：合法 upstreamUrl 通过；path/query/host/port/相对路径漂移全部拒绝', () => {
  const cfg = configWithOfficialHosts()
  const provider = thirdProvider()
  const identity = classifyTarget(provider, cfg)
  const authz = authorizeFinalTarget(thirdIntent(), 7, thirdBinding(provider, identity, cfg))

  assert.equal(assertSendTarget(authz, upstreamUrl(provider, '/v1/chat/completions')), authz, '相同目标必须通过')
  // 大小写/显式默认端口经同一次规范化后等价，按同一目标放行（避免误杀 upstreamUrl 的合法输出）。
  assert.equal(assertSendTarget(authz, 'HTTP://127.0.0.1:19001/v1/chat/completions'), authz)

  const drift = [
    ['pathPrefix 双拼导致 /v1/v1', upstreamUrl(Object.assign({}, provider, { pathPrefix: '/v1' }), '/v1/chat/completions')],
    ['query 漂移', upstreamUrl(provider, '/v1/chat/completions?x=1')],
    ['host 漂移', 'http://127.0.0.2:19001/v1/chat/completions'],
    ['port 漂移', 'http://127.0.0.1:19002/v1/chat/completions'],
    ['path 漂移', 'http://127.0.0.1:19001/v1/responses'],
    ['scheme 漂移', 'https://127.0.0.1:19001/v1/chat/completions'],
  ]
  for (const [label, used] of drift) {
    const err = denyOf(() => assertSendTarget(authz, used))
    assert.equal(err.code, 'send_target_drift', label)
    assert.equal(String(err.message).includes('sk-'), false)
  }
  assert.equal(denyOf(() => assertSendTarget(authz, '/v1/chat/completions')).code, 'send_target_not_absolute')
  assert.equal(denyOf(() => assertSendTarget(null, upstreamUrl(provider, '/v1/chat/completions'))).code, 'authz_record_invalid')
  assert.equal(denyOf(() => targetKeyOfUrl('https://api.openai.com@evil.test/v1/x')).code, 'send_target_userinfo_forbidden')
})

test('拼装前允许 + 拼装后漂移（官方）：@ 注入 / 主机后缀 / 双重 /v1 / query 均拒绝', () => {
  const cfg = configWithOfficialHosts()
  const provider = officialProvider()
  const identity = classifyTarget(provider, cfg)
  const authz = authorizeFinalTarget({ domain: TARGET_DOMAINS.OFFICIAL, caller: { incoming: OFFICIAL_INCOMING } }, 3, officialBinding(provider, identity, cfg))

  assert.equal(assertSendTarget(authz, upstreamUrl(provider, '/v1/chat/completions')), authz)
  // 官方 https 默认端口显式书写经规范化等价，放行；端口实际改变则拒绝。
  assert.equal(assertSendTarget(authz, 'https://api.openai.com:443/v1/chat/completions'), authz)
  assert.equal(denyOf(() => assertSendTarget(authz, 'https://api.openai.com:8443/v1/chat/completions')).code, 'send_target_drift')
  assert.equal(denyOf(() => assertSendTarget(authz, 'http://api.openai.com:443/v1/chat/completions')).code, 'send_target_drift', 'scheme 改变必须拒绝')

  const userinfo = denyOf(() => assertSendTarget(authz, upstreamUrl(Object.assign({}, provider, { pathPrefix: '@evil.test' }), '/v1/chat/completions')))
  assert.ok(['send_target_userinfo_forbidden', 'send_target_drift'].includes(userinfo.code), 'userinfo 注入必须拒绝')
  assert.equal(denyOf(() => assertSendTarget(authz, upstreamUrl({ baseUrl: 'https://api.openai.com.evil.test' }, '/v1/chat/completions'))).code, 'send_target_drift')
  assert.equal(denyOf(() => assertSendTarget(authz, upstreamUrl(Object.assign({}, provider, { baseUrl: 'https://api.openai.com/v1' }), '/v1/v1/chat/completions'))).code, 'send_target_drift')
  assert.equal(denyOf(() => assertSendTarget(authz, upstreamUrl(provider, '/v1/chat/completions?x=1'))).code, 'send_target_drift')
})

test('fail-closed：unknown / 未验证 / host 冲突 / generation 不匹配零发送，消息不含密钥', () => {
  const cfg = configWithOfficialHosts()
  const sentinel = 'sk-SENTINEL-MUST-NOT-LEAK'

  const unknownProvider = { id: 'shadow', baseUrl: 'https://evil.test', apiKey: sentinel, codexIdentity: 'official' }
  const unknownIdentity = classifyTarget(unknownProvider, cfg)
  assert.equal(unknownIdentity.kind, 'unknown')
  const unknown = denyOf(() => authorizeFinalTarget(
    { domain: TARGET_DOMAINS.OFFICIAL, caller: { incoming: OFFICIAL_INCOMING } },
    3,
    officialBinding(unknownProvider, unknownIdentity, cfg, { path: '/v1/chat/completions' })
  ))
  assert.equal(unknown.code, 'target_identity_unknown')
  assertNoSentinels(unknown.message, [sentinel, 'CLIENT-OFFICIAL-TOKEN', 'acct-CLIENT-ACCOUNT'])

  const third = thirdProvider()
  const thirdIdentity = classifyTarget(third, cfg)
  assert.equal(denyOf(() => authorizeFinalTarget(thirdIntent(), 7, thirdBinding(third, thirdIdentity, cfg, { thirdPartyVerified: false }))).code, 'target_not_verified')

  const official = officialProvider()
  const officialIdentity = classifyTarget(official, cfg)
  assert.equal(denyOf(() => authorizeFinalTarget({ domain: TARGET_DOMAINS.OFFICIAL, caller: { incoming: OFFICIAL_INCOMING } }, 3, officialBinding(official, officialIdentity, cfg, { officialVerified: false }))).code, 'target_not_verified')

  // 声明 official 的 identity 与拼装后的实际 host 不符（pathPrefix 追加主机后缀）
  const conflict = denyOf(() => authorizeFinalTarget(
    { domain: TARGET_DOMAINS.OFFICIAL, caller: { incoming: OFFICIAL_INCOMING } },
    3,
    officialBinding(official, officialIdentity, cfg, { pathPrefix: '.evil.test' })
  ))
  assert.equal(conflict.code, 'base_url_host_mismatch')
  assertNoSentinels(conflict.message, [sentinel, 'CLIENT-OFFICIAL-TOKEN'])

  assert.equal(denyOf(() => authorizeFinalTarget(thirdIntent(), 8, thirdBinding(third, thirdIdentity, cfg))).code, 'generation_mismatch')
  assert.equal(denyOf(() => authorizeFinalTarget(thirdIntent(), null, thirdBinding(third, thirdIdentity, cfg))).code, 'catalog_generation_missing')
  assert.equal(denyOf(() => authorizeFinalTarget({ domain: 'bogus' }, 7, thirdBinding(third, thirdIdentity, cfg))).code, 'intent_domain_invalid')
  assert.equal(denyOf(() => authorizeFinalTarget(Object.assign(thirdIntent(), { official: true }), 7, thirdBinding(third, thirdIdentity, cfg))).code, 'intent_domain_conflict')
  // identity 会被默认分类为 thirdParty，但 intent 声明 official：域不一致
  assert.equal(denyOf(() => authorizeFinalTarget({ domain: TARGET_DOMAINS.OFFICIAL, caller: { incoming: OFFICIAL_INCOMING } }, 7, thirdBinding(third, thirdIdentity, cfg, { officialVerified: true }))).code, 'domain_identity_mismatch')
})

test('域与凭据分离：订阅身份不得用于 API Key 计费端点或第三方目标', () => {
  const cfg = configWithOfficialHosts()

  // 官方无自有 key = 订阅身份；目标却是 api.openai.com 计费端点
  const sub = subscriptionProvider()
  const subIdentity = classifyTarget(sub, cfg)
  assert.equal(subIdentity.kind, 'official')
  assert.equal(subIdentity.credential, 'client-passthrough')
  const billingProvider = { id: 'openai-nokey', baseUrl: 'https://api.openai.com' }
  const billingIdentity = classifyTarget(billingProvider, cfg)
  assert.equal(billingIdentity.credential, 'client-passthrough')
  const billing = denyOf(() => authorizeFinalTarget(
    { domain: TARGET_DOMAINS.OFFICIAL, caller: { incoming: OFFICIAL_INCOMING, officialSubscription: true, passthroughEnabled: true } },
    3,
    officialBinding(billingProvider, billingIdentity, cfg, { path: '/v1/chat/completions' })
  ))
  assert.equal(billing.code, 'official_subscription_on_billing_path')

  // 第三方显式要求订阅身份 = 越权
  const third = thirdProvider()
  const thirdIdentity = classifyTarget(third, cfg)
  assert.equal(denyOf(() => authorizeFinalTarget(thirdIntent({ credentialMode: CREDENTIAL_MODES.OFFICIAL_SUBSCRIPTION, officialSubscription: true, passthroughEnabled: true }), 7, thirdBinding(third, thirdIdentity, cfg))).code, 'credential_mode_forbidden')

  // 订阅凭据透传未开启：fail-closed（官方无 key 且未显式声明订阅）
  assert.equal(denyOf(() => authorizeFinalTarget(
    { domain: TARGET_DOMAINS.OFFICIAL, caller: { incoming: OFFICIAL_INCOMING, officialSubscription: false, passthroughEnabled: false } },
    3,
    officialBinding(billingProvider, billingIdentity, cfg, { path: '/v1/chat/completions' })
  )).code, 'credential_mode_forbidden')

  // 直接调用凭据模式判定
  const target = canonicalizeUrlOnce('https://api.openai.com', '/v1/chat/completions')
  assert.equal(credentialModeAllowed(TARGET_DOMAINS.THIRD_PARTY, target, { credentialMode: CREDENTIAL_MODES.OFFICIAL_SUBSCRIPTION }).code, 'credential_mode_forbidden')
  assert.equal(credentialModeAllowed(TARGET_DOMAINS.OFFICIAL, target, { credentialMode: CREDENTIAL_MODES.OFFICIAL_SUBSCRIPTION, officialSubscription: true, passthroughEnabled: true }).code, 'official_subscription_on_billing_path')
  assert.equal(credentialModeAllowed(TARGET_DOMAINS.THIRD_PARTY, target, { credentialMode: CREDENTIAL_MODES.NONE }), null)
})

test('官方订阅入口（/backend-api/codex）：放行客户端官方凭据，其余官方头按白名单', () => {
  const cfg = configWithOfficialHosts()
  const provider = subscriptionProvider()
  const identity = classifyTarget(provider, cfg)
  const authz = authorizeFinalTarget(
    { domain: TARGET_DOMAINS.OFFICIAL, caller: { incoming: OFFICIAL_INCOMING, officialSubscription: true, passthroughEnabled: true } },
    3,
    officialBinding(provider, identity, cfg, { path: '/backend-api/codex/responses' })
  )
  assert.equal(authz.credentialMode, CREDENTIAL_MODES.OFFICIAL_SUBSCRIPTION)
  assert.equal(authz.headers.authorization, 'Bearer CLIENT-OFFICIAL-TOKEN')
  assert.equal(authz.headers['chatgpt-account-id'], 'acct-CLIENT-ACCOUNT')
  assert.equal(authz.headers['openai-beta'], 'responses=experimental')
  assert.equal(authz.headers['x-codex-beta-features'], 'multi_agent')
  assert.equal(authz.headers['x-ordinary-client-header'], undefined, '白名单外头必须丢弃')
  assert.equal(authz.redirect, 'error')
  assert.equal(assertSendTarget(authz, upstreamUrl(provider, '/backend-api/codex/responses')), authz)
})

test('官方自有 key：注入网关 key，客户端官方凭据不透传（两条路互斥）', () => {
  const cfg = configWithOfficialHosts()
  const provider = officialProvider()
  const identity = classifyTarget(provider, cfg)
  const authz = authorizeFinalTarget({ domain: TARGET_DOMAINS.OFFICIAL, caller: { incoming: OFFICIAL_INCOMING } }, 3, officialBinding(provider, identity, cfg))
  assert.equal(authz.credentialMode, CREDENTIAL_MODES.PROVIDER_KEY)
  assert.equal(authz.headers.authorization, 'Bearer sk-OFFICIAL-KEY')
  assert.equal(authz.headers['chatgpt-account-id'], undefined, '自有 key 路径不得混入客户端账号头')
  assert.equal(authz.headers['openai-beta'], 'responses=experimental')
  assert.equal(authz.headers['user-agent'], 'model-gateway/0.1')
  assert.equal(authz.headers['accept-encoding'], 'identity')
})

test('第三方派生会话：同域稳定、跨域不可关联、不泄露原线程 id', () => {
  const cfg = configWithOfficialHosts()
  const p1 = thirdProvider({ id: 'p1', baseUrl: 'http://127.0.0.1:19001' })
  const p2 = thirdProvider({ id: 'p2', baseUrl: 'http://127.0.0.1:19003' })
  const i1 = classifyTarget(p1, cfg)
  const i2 = classifyTarget(p2, cfg)
  const a1 = authorizeFinalTarget(thirdIntent(), 7, thirdBinding(p1, i1, cfg))
  const a1b = authorizeFinalTarget(thirdIntent(), 7, thirdBinding(p1, i1, cfg))
  const a2 = authorizeFinalTarget(thirdIntent(), 7, thirdBinding(p2, i2, cfg))

  assert.equal(a1.headers['x-opencode-session'], a1b.headers['x-opencode-session'], '同一供应商同一线程必须稳定')
  assert.notEqual(a1.headers['x-opencode-session'], a2.headers['x-opencode-session'], '不同域不得关联')
  const v1 = a1.headers['x-opencode-session']
  const v2 = a2.headers['x-opencode-session']
  assert.equal(v1.includes('thread-CLIENT-THREAD'), false)
  assert.equal(v2.includes('thread-CLIENT-THREAD'), false)
  for (let i = 0; i + 8 <= 32; i++) {
    assert.equal(v2.includes(v1.slice(i, i + 8)), false, '不同域的派生值不得共享 8 位片段')
  }

  // 盐不同 -> 值不同；没有线程标识 -> 不发明会话头
  const salted = deriveSessionIdentity({ threadId: 'thread-CLIENT-THREAD', sessionHeader: 'x-opencode-session', sessionSalt: 'other-salt' }, a1.target)
  assert.notEqual(salted.value, v1)
  assert.equal(deriveSessionIdentity({ sessionHeader: 'x-opencode-session' }, a1.target), null)
  assert.equal(deriveSessionIdentity({ threadId: 't', sessionHeader: 'x-opencode-session' }, a1.target).header, 'x-opencode-session')
  assert.equal(deriveSessionIdentity({ threadId: 't', sessionHeader: 'x-opencode-session' }, a1.target).value.length, 32)
  assert.equal(DEFAULT_SESSION_SALT.length > 0, true)
})
