// AGG-P02：授权域解析与上游解析收据（离线，纯模块）。
// 覆盖：三个域各自解析到自己的 host/path；未知/冲突/不支持的授权状态是 typed error；
//      公共模型 ID 不得出现在上游；发送前 host/path 漂移拒绝；诊断不含凭据。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AUTH_DOMAINS, resolveUpstream, buildDomainHeaders, assertResolvedUpstream,
  resolvedDiagnostic, isTargetAuthzError, TARGET_DOMAINS,
} from '../../../src/codex/target-authz.js'

const SUBSCRIPTION_CRED = Object.freeze({ authorization: 'Bearer SUBSCRIPTION-CANARY', accountId: 'acct-CANARY' })
const PROVIDER_KEY = 'sk-PROVIDER-CANARY'
const SIWC_TOKEN = 'SIWC-CANARY'

function denyOf(fn) {
  try { fn() } catch (e) {
    assert.equal(isTargetAuthzError(e), true, '必须是 typed deny')
    assert.equal(e.deny, true)
    assert.equal(typeof e.code, 'string')
    assert.ok([400, 401, 403].includes(e.status), 'status 必须可映射：' + e.status)
    return e
  }
  assert.fail('预期被拒绝，实际放行')
}

function official(over) {
  return Object.assign({ identity: TARGET_DOMAINS.OFFICIAL, host: 'https://chatgpt.com', gatewaySubscription: true }, over || {})
}
function receipt(over) {
  return Object.assign({
    providerId: 'codex-subscription',
    model: 'gpt-6-luna',
    upstreamModel: 'gpt-6-luna',
    binding: official(),
  }, over || {})
}

test('三个授权域各自解析到独立 host/path，收据冻结且含六个契约字段', () => {
  const sub = resolveUpstream(receipt())
  assert.equal(sub.authDomain, AUTH_DOMAINS.CODEX_SUBSCRIPTION)
  assert.equal(sub.upstreamHost, 'chatgpt.com')
  assert.equal(sub.upstreamPath, '/backend-api/codex/responses')
  assert.equal(sub.providerId, 'codex-subscription')
  assert.equal(sub.model, 'gpt-6-luna')
  assert.equal(sub.upstreamModel, 'gpt-6-luna')
  assert.equal(Object.isFrozen(sub), true)

  const siwc = resolveUpstream({
    providerId: 'siwc', model: 'gpt-6-luna', upstreamModel: 'gpt-6-luna',
    binding: { identity: TARGET_DOMAINS.OFFICIAL, host: 'https://api.openai.com', siwcApp: true },
  })
  assert.equal(siwc.authDomain, AUTH_DOMAINS.SIWC_APP)
  assert.equal(siwc.upstreamHost, 'api.openai.com')
  assert.equal(siwc.upstreamPath, '/v1/responses')

  const keyed = resolveUpstream({
    providerId: 'openai-api', model: 'gpt-6-luna', upstreamModel: 'gpt-6-luna',
    binding: { identity: TARGET_DOMAINS.OFFICIAL, host: 'https://api.openai.com', apiKey: true },
  })
  assert.equal(keyed.authDomain, AUTH_DOMAINS.API_KEY)
  assert.equal(keyed.upstreamHost, 'api.openai.com')
  assert.equal(keyed.upstreamPath, '/v1/responses')

  const third = resolveUpstream({
    providerId: 'opencodego', model: 'mg-opencodego-deepseek-v4-1-flash', upstreamModel: 'deepseek-v4.1-flash',
    binding: { identity: TARGET_DOMAINS.THIRD_PARTY, host: 'https://opencode.ai', apiKey: true },
  })
  assert.equal(third.authDomain, AUTH_DOMAINS.API_KEY)
  assert.equal(third.upstreamHost, 'opencode.ai')

  const sets = new Set([sub.authDomain + '|' + sub.upstreamHost + sub.upstreamPath, siwc.authDomain + '|' + siwc.upstreamHost + siwc.upstreamPath, keyed.authDomain + '|' + keyed.upstreamHost + keyed.upstreamPath])
  assert.equal(sets.size, 3, '三个域不得解析到同一 host/path 组合')
})

test('未知授权状态是 typed error，绝不当作 API Key', () => {
  const e = denyOf(() => resolveUpstream(receipt({ binding: { identity: TARGET_DOMAINS.OFFICIAL, host: 'https://api.openai.com' } })))
  // 对外沿用既有 code（官方无 key / 无授权域），reason 标明「未知授权状态」。
  assert.equal(e.code, 'official_no_gateway_key')
  assert.equal(e.reason, 'auth_state_unknown')
  assert.equal(e.status, 403)
  assert.match(e.message, /绝不按 API Key 处理/)

  const unknown = denyOf(() => resolveUpstream(receipt({ binding: { identity: 'unknown', host: 'https://api.openai.com' } })))
  assert.equal(unknown.code, 'target_identity_unknown')

  const missing = denyOf(() => resolveUpstream(receipt({ binding: { identity: TARGET_DOMAINS.OFFICIAL, host: 'https://api.openai.com', gatewaySubscription: true, apiKey: true } })))
  assert.equal(missing.code, 'auth_domain_ambiguous')
})

test('授权域声明必须与凭据声明一致；第三方不得声明订阅/SIWC 域', () => {
  const declared = denyOf(() => resolveUpstream(receipt({ binding: official({ authDomain: AUTH_DOMAINS.SIWC_APP }) })))
  assert.equal(declared.code, 'auth_domain_declared_unsupported')

  const invalid = denyOf(() => resolveUpstream(receipt({ binding: official({ authDomain: 'codex-owned-chatgpt' }) })))
  assert.equal(invalid.code, 'auth_domain_invalid')
  assert.equal(invalid.status, 400)

  const thirdSub = denyOf(() => resolveUpstream({
    providerId: 'go', model: 'mg-go-x', upstreamModel: 'vendor-model',
    binding: { identity: TARGET_DOMAINS.THIRD_PARTY, host: 'https://opencode.ai', gatewaySubscription: true },
  }))
  assert.equal(thirdSub.code, 'auth_domain_not_allowed_for_third_party')

  const thirdSiwc = denyOf(() => resolveUpstream({
    providerId: 'go', model: 'mg-go-x', upstreamModel: 'vendor-model',
    binding: { identity: TARGET_DOMAINS.THIRD_PARTY, host: 'https://opencode.ai', siwcApp: true },
  }))
  assert.equal(thirdSiwc.code, 'auth_domain_not_allowed_for_third_party')
})

test('公共/聚合模型 ID 不得出现在上游；跨域 host 与路径漂移在发送前拒绝', () => {
  const leak = denyOf(() => resolveUpstream({
    providerId: 'go', model: 'mg-go-deepseek', upstreamModel: 'mg-go-deepseek',
    binding: { identity: TARGET_DOMAINS.THIRD_PARTY, host: 'https://opencode.ai', apiKey: true },
  }))
  assert.equal(leak.code, 'public_model_id_in_upstream')
  assert.equal(leak.message.includes('mg-go-deepseek'), true)

  const wrongHost = denyOf(() => resolveUpstream(receipt({ binding: official({ host: 'https://api.openai.com' }) })))
  assert.equal(wrongHost.code, 'codex_subscription_host_not_allowed')

  const wrongPath = denyOf(() => resolveUpstream(receipt({ binding: official({ upstreamPath: '/v1/responses' }) })))
  assert.equal(wrongPath.code, 'codex_subscription_path_not_allowed')

  const keyOnSubscriptionHost = denyOf(() => resolveUpstream(receipt({ binding: { identity: TARGET_DOMAINS.OFFICIAL, host: 'https://chatgpt.com', apiKey: true } })))
  assert.equal(keyOnSubscriptionHost.code, 'auth_domain_host_mismatch')

  const userinfo = denyOf(() => resolveUpstream(receipt({ binding: official({ host: 'https://user:pass@chatgpt.com' }) })))
  assert.equal(userinfo.code, 'target_userinfo_forbidden')
  assert.equal(userinfo.status, 403)

  const resolved = resolveUpstream(receipt())
  const driftHost = denyOf(() => assertResolvedUpstream(resolved, 'https://api.openai.com/backend-api/codex/responses'))
  assert.equal(driftHost.code, 'send_target_drift')
  const driftPath = denyOf(() => assertResolvedUpstream(resolved, 'https://chatgpt.com/v1/responses'))
  assert.equal(driftPath.code, 'send_target_drift')
  const driftQuery = denyOf(() => assertResolvedUpstream(resolved, 'https://chatgpt.com/backend-api/codex/responses?x=1'))
  assert.equal(driftQuery.code, 'send_target_drift')
  assert.equal(assertResolvedUpstream(resolved, 'https://chatgpt.com/backend-api/codex/responses').authDomain, AUTH_DOMAINS.CODEX_SUBSCRIPTION)
})

test('每个域从空白构造头：客户端官方头/凭据头不继承，域之间零头泄漏', () => {
  const sub = resolveUpstream(receipt())
  const incoming = {
    authorization: 'Bearer CLIENT-LEAK',
    'chatgpt-account-id': 'acct-CLIENT-LEAK',
    'openai-beta': 'responses=experimental',
    'x-ordinary-client-header': 'drop-me',
  }
  const subHeaders = buildDomainHeaders(sub, { incoming, credential: SUBSCRIPTION_CRED })
  assert.equal(subHeaders.authorization, 'Bearer SUBSCRIPTION-CANARY')
  assert.equal(subHeaders['chatgpt-account-id'], 'acct-CANARY')
  assert.equal(subHeaders['x-ordinary-client-header'], undefined)
  assert.equal(JSON.stringify(subHeaders).includes('CLIENT-LEAK'), false)

  const siwc = resolveUpstream({
    providerId: 'siwc', model: 'gpt-6-luna', upstreamModel: 'gpt-6-luna',
    binding: { identity: TARGET_DOMAINS.OFFICIAL, host: 'https://api.openai.com', siwcApp: true },
  })
  const siwcHeaders = buildDomainHeaders(siwc, { incoming, siwcToken: SIWC_TOKEN })
  assert.equal(siwcHeaders.authorization, 'Bearer ' + SIWC_TOKEN)
  assert.equal(siwcHeaders['chatgpt-account-id'], undefined, 'siwc-app 不得携带 Codex 账号头')

  const third = resolveUpstream({
    providerId: 'go', model: 'mg-go-x', upstreamModel: 'vendor-model',
    binding: { identity: TARGET_DOMAINS.THIRD_PARTY, host: 'https://opencode.ai', apiKey: true },
  })
  const thirdHeaders = buildDomainHeaders(third, { incoming, credential: { providerKey: PROVIDER_KEY, accountId: 'acct-CANARY' } })
  assert.equal(thirdHeaders.authorization, 'Bearer ' + PROVIDER_KEY)
  assert.equal(thirdHeaders['chatgpt-account-id'], undefined)
  assert.equal(thirdHeaders['openai-beta'], undefined)
  assert.equal(JSON.stringify(thirdHeaders).includes('SUBSCRIPTION-CANARY'), false)

  const officialKey = resolveUpstream({
    providerId: 'openai-api', model: 'gpt-6-luna', upstreamModel: 'gpt-6-luna',
    binding: { identity: TARGET_DOMAINS.OFFICIAL, host: 'https://api.openai.com', apiKey: true },
  })
  const officialKeyHeaders = buildDomainHeaders(officialKey, { incoming, credential: { providerKey: PROVIDER_KEY } })
  assert.equal(officialKeyHeaders.authorization, 'Bearer ' + PROVIDER_KEY)
  assert.equal(officialKeyHeaders['chatgpt-account-id'], undefined)
  assert.equal(JSON.stringify(officialKeyHeaders).includes('CLIENT-LEAK'), false)
})

test('官方 api-key 缺 key 是 typed 403；订阅域缺本机登录凭据是 typed 401', () => {
  const officialKey = resolveUpstream({
    providerId: 'openai-api', model: 'gpt-6-luna', upstreamModel: 'gpt-6-luna',
    binding: { identity: TARGET_DOMAINS.OFFICIAL, host: 'https://api.openai.com', apiKey: true },
  })
  const noKey = denyOf(() => buildDomainHeaders(officialKey, {}))
  assert.equal(noKey.code, 'official_credential_missing')
  assert.equal(noKey.status, 403)

  const sub = resolveUpstream(receipt())
  const noCred = denyOf(() => buildDomainHeaders(sub, {}))
  assert.equal(noCred.code, 'subscription_credential_unavailable')
  assert.equal(noCred.status, 401)
})

test('诊断投影只含 provider/域/host/path/模型，绝不含 token/账号值', () => {
  const sub = resolveUpstream(receipt())
  const diag = resolvedDiagnostic(sub)
  assert.deepEqual(Object.keys(diag).sort(), ['authDomain', 'credentialPresent', 'model', 'providerId', 'upstreamHost', 'upstreamModel', 'upstreamPath'])
  const text = JSON.stringify(diag)
  assert.equal(text.includes('SUBSCRIPTION-CANARY'), false)
  assert.equal(text.includes('acct-CANARY'), false)
})
