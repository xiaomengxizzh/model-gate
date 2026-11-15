// V2-03 / A4：授权域隔离的「可归因错误」与「请求身份收据」（离线，纯模块，零网络）。
//
// 覆盖 MG-R002 / MG-R008 / MG-R009 / MG-R012 的失败语义：
//   1. 401/402/403 与配额型 429 是**授权域内**终态：不得变成功、不得跨域换候选、不得改写模型/状态码；
//   2. 速率型 429 允许同域按 Retry-After 重试，但仍禁止跨域回退（fallbackAllowed=false）；
//   3. 每条失败收据都带自己的 authDomain：Go(api-key) 的 401 不会被记成订阅域，反之亦然；
//   4. 请求身份收据必须同时钉 host + path + model：只比 host/path 会放过「换模型名」的漂移。
//
// 纯模块测试，不读取任何真实凭据、不发请求；token 全部是虚构 canary。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AUTH_DOMAINS, AUTH_FAILURE_KINDS, TARGET_DOMAINS,
  resolveUpstream, assertResolvedUpstream, assertResolvedModel, verifyRequestIdentity,
  classifyAuthDomainFailure, authFailureReceipt, authFailureOfResolved, authFailureResponse,
  resolvedDiagnostic, isTargetAuthzError,
} from '../../../src/codex/target-authz.js'

const PROVIDER_KEY = 'sk-CANARY-GO-KEY'
const SUBSCRIPTION_TOKEN = 'CANARY-SUBSCRIPTION-TOKEN'

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

// 三个授权域各一张收据：域名/host/path 全部来自 resolveUpstream 的冻结产物。
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

test('401/402/403 是授权域内终态：不换域、不换模型、不改状态码', () => {
  const cases = [
    [401, AUTH_FAILURE_KINDS.UNAUTHORIZED, 'upstream_unauthorized'],
    [402, AUTH_FAILURE_KINDS.QUOTA_EXHAUSTED, 'upstream_quota_exhausted'],
    [403, AUTH_FAILURE_KINDS.FORBIDDEN, 'upstream_forbidden'],
  ]
  for (const domain of [AUTH_DOMAINS.API_KEY, AUTH_DOMAINS.CODEX_SUBSCRIPTION, AUTH_DOMAINS.SIWC_APP]) {
    for (const [status, kind, code] of cases) {
      const r = authFailureReceipt(status, { authDomain: domain })
      assert.equal(r.status, status)
      assert.equal(r.kind, kind)
      assert.equal(r.code, code)
      assert.equal(r.authDomain, domain, '失败收据必须带自己的授权域')
      assert.equal(r.terminal, true)
      assert.equal(r.retryable, false)
      assert.equal(r.fallbackAllowed, false, '绝不静默换路由/换套餐')
      assert.equal(r.rewriteModel, false)
      assert.equal(r.rewriteStatus, false)
      assert.equal(Object.isFrozen(r), true)
      assert.equal(JSON.stringify(r).includes(PROVIDER_KEY), false)
      assert.equal(JSON.stringify(r).includes(SUBSCRIPTION_TOKEN), false)
    }
  }
  // 非授权域状态不属于本通道：不得被当成授权失败吞掉。
  for (const status of [200, 201, 302, 400, 404, 408, 500, 502, 504]) {
    assert.equal(authFailureReceipt(status, { authDomain: AUTH_DOMAINS.API_KEY }), null, 'status=' + status)
    assert.equal(classifyAuthDomainFailure(status, { authDomain: AUTH_DOMAINS.API_KEY }), null, 'status=' + status)
  }
})

test('429 分域：配额语义是终态，速率语义允许同域重试但禁止跨域回退', () => {
  const quota = classifyAuthDomainFailure(429, {
    authDomain: AUTH_DOMAINS.API_KEY,
    bodyText: '{"error":{"message":"Insufficient balance: 余额不足","code":"insufficient_quota"}}',
    retryAfterMs: 3000,
  })
  assert.equal(quota.kind, AUTH_FAILURE_KINDS.QUOTA_EXHAUSTED)
  assert.equal(quota.code, 'upstream_quota_exhausted')
  assert.equal(quota.terminal, true)
  assert.equal(quota.retryable, false, '额度耗尽不能在毫秒级退避里恢复')
  assert.equal(quota.fallbackAllowed, false)
  assert.equal(quota.retryAfterMs, 3000, '保留上游给的 Retry-After 供诊断，但不据此换域')
  // 配额型 429 也是授权域终态，可被接线卡的统一终态判定接住。
  assert.equal(authFailureReceipt(429, { authDomain: AUTH_DOMAINS.API_KEY, bodyText: 'quota exceeded' }).kind, AUTH_FAILURE_KINDS.QUOTA_EXHAUSTED)

  const rate = classifyAuthDomainFailure(429, {
    authDomain: AUTH_DOMAINS.API_KEY,
    bodyText: '{"error":{"message":"Rate limit reached for requests per minute (rpm)"}}',
    retryAfterMs: 1200,
  })
  assert.equal(rate.kind, AUTH_FAILURE_KINDS.RATE_LIMITED)
  assert.equal(rate.code, 'upstream_rate_limited')
  assert.equal(rate.retryable, true, '速率限流可在同一域内按 Retry-After 重试')
  assert.equal(rate.fallbackAllowed, false, '即使可重试也不得跨域换套餐')
  assert.equal(rate.rewriteModel, false)
  // 速率型 429 不是授权终态：不占用「授权失败」通道（既有 429/Retry-After 路径不变）。
  assert.equal(authFailureReceipt(429, { authDomain: AUTH_DOMAINS.API_KEY, bodyText: 'rate limit' }), null)

  // 无文本的 429 默认按速率处理（保守：留在本域，不升级成配额终态）。
  const bare = classifyAuthDomainFailure(429, { authDomain: AUTH_DOMAINS.API_KEY })
  assert.equal(bare.kind, AUTH_FAILURE_KINDS.RATE_LIMITED)
  assert.equal(bare.retryAfterMs, null, '不臆造 Retry-After')
})

test('失败归因使用收据自带的授权域：Go 的 401 不会被记成订阅域', () => {
  const goFailure = authFailureOfResolved(GO, 401)
  const subFailure = authFailureOfResolved(SUB, 401)
  const siwcFailure = authFailureOfResolved(SIWC, 401)
  assert.equal(goFailure.authDomain, AUTH_DOMAINS.API_KEY)
  assert.equal(subFailure.authDomain, AUTH_DOMAINS.CODEX_SUBSCRIPTION)
  assert.equal(siwcFailure.authDomain, AUTH_DOMAINS.SIWC_APP)
  // 同一个 HTTP 状态，三个域可区分：这就是「分域处理」的全部意义。
  assert.equal(new Set([goFailure.authDomain, subFailure.authDomain, siwcFailure.authDomain]).size, 3)
  for (const f of [goFailure, subFailure, siwcFailure]) {
    assert.equal(f.fallbackAllowed, false)
    assert.equal(f.status, 401)
  }
  assert.equal(authFailureOfResolved(GO, 200), null)

  // 未知授权域是调用方 bug：typed 400，绝不静默当成某个域。
  const bad = denyOf(() => classifyAuthDomainFailure(401, { authDomain: 'chatgpt-plan' }))
  assert.equal(bad.code, 'auth_domain_invalid')
  assert.equal(bad.status, 400)
  // 非法 status 不是授权失败。
  assert.equal(classifyAuthDomainFailure('401abc', { authDomain: AUTH_DOMAINS.API_KEY }), null)
})

test('请求身份收据：host / path / model 任一漂移都拒绝，三者一致才放行', () => {
  const url = 'https://opencode.ai/v1/responses'
  const identity = verifyRequestIdentity(GO, { urlUsed: url, model: 'deepseek-v4.1-flash' })
  assert.deepEqual(Object.keys(identity), ['providerId', 'authDomain', 'upstreamHost', 'upstreamPath', 'model', 'upstreamModel'])
  assert.equal(identity.authDomain, AUTH_DOMAINS.API_KEY)
  assert.equal(identity.upstreamHost, 'opencode.ai')
  assert.equal(identity.upstreamPath, '/v1/responses')
  assert.equal(identity.model, 'mg-go-deepseek')
  assert.equal(identity.upstreamModel, 'deepseek-v4.1-flash')
  assert.equal(Object.isFrozen(identity), true)
  assert.equal(JSON.stringify(identity).includes(PROVIDER_KEY), false)

  // host 漂移
  const hostDrift = denyOf(() => verifyRequestIdentity(GO, { urlUsed: 'https://evil.example/v1/responses', model: 'deepseek-v4.1-flash' }))
  assert.equal(hostDrift.code, 'send_target_drift')
  assert.equal(String(hostDrift.message).includes(PROVIDER_KEY), false)
  // 端口漂移
  const portDrift = denyOf(() => verifyRequestIdentity(GO, { urlUsed: 'https://opencode.ai:8443/v1/responses', model: 'deepseek-v4.1-flash' }))
  assert.equal(portDrift.code, 'send_target_drift')
  // path 漂移
  const pathDrift = denyOf(() => verifyRequestIdentity(GO, { urlUsed: 'https://opencode.ai/v1/chat/completions', model: 'deepseek-v4.1-flash' }))
  assert.equal(pathDrift.code, 'send_target_drift')
  // query 漂移（收据不接受未授权查询串）
  const queryDrift = denyOf(() => verifyRequestIdentity(GO, { urlUsed: 'https://opencode.ai/v1/responses?model=other', model: 'deepseek-v4.1-flash' }))
  assert.equal(queryDrift.code, 'send_target_drift')

  // model 漂移：只比 host/path 的旧校验会放过它
  const modelDrift = denyOf(() => verifyRequestIdentity(GO, { urlUsed: url, model: 'deepseek-v4.1-flash-pro' }))
  assert.equal(modelDrift.code, 'send_model_drift')
  assert.equal(modelDrift.expected, 'deepseek-v4.1-flash')
  assert.equal(modelDrift.actual, 'deepseek-v4.1-flash-pro')
  // 公共/聚合 ID 绝不能作为上游模型名发出去（既有的 resolveUpstream 层也会拒绝）
  const publicId = denyOf(() => verifyRequestIdentity(GO, { urlUsed: url, model: 'mg-go-deepseek' }))
  assert.equal(publicId.code, 'send_model_drift')
  assert.equal(String(publicId.message).includes(PROVIDER_KEY), false)

  // 缺模型不是「等价通过」：无法核对就是请求错误。
  const missing = denyOf(() => verifyRequestIdentity(GO, { urlUsed: url }))
  assert.equal(missing.code, 'send_model_missing')
  assert.equal(missing.status, 400)
  const missingUrl = denyOf(() => verifyRequestIdentity(GO, { model: 'deepseek-v4.1-flash' }))
  assert.equal(missingUrl.code, 'send_target_not_absolute')

  // 单独使用 assertResolvedModel 时与收据契约一致；空白字符串不算合法模型名。
  assert.equal(assertResolvedModel(GO, ' deepseek-v4.1-flash ').upstreamModel, 'deepseek-v4.1-flash')
  assert.equal(denyOf(() => assertResolvedModel(GO, '   ')).code, 'send_model_missing')

  // assertResolvedUpstream 的 opts.model 是可选的向后兼容扩展：不给就只校 host/path。
  assert.doesNotThrow(() => assertResolvedUpstream(GO, url))
  assert.equal(denyOf(() => assertResolvedUpstream(GO, url, { model: 'other-model' })).code, 'send_model_drift')
})

test('三个授权域的收据互不借用：域名/host/path/模型各自独立且可诊断', () => {
  const receipts = [GO, SUB, SIWC]
  assert.deepEqual(receipts.map((r) => r.authDomain), [AUTH_DOMAINS.API_KEY, AUTH_DOMAINS.CODEX_SUBSCRIPTION, AUTH_DOMAINS.SIWC_APP])
  assert.equal(new Set(receipts.map((r) => r.upstreamHost)).size, 3, '三个域必须落在不同 host')
  assert.equal(new Set(receipts.map((r) => r.providerId)).size, 3)

  for (const r of receipts) {
    const diag = resolvedDiagnostic(r)
    assert.equal(diag.authDomain, r.authDomain)
    assert.equal(diag.upstreamHost, r.upstreamHost)
    assert.equal(diag.upstreamPath, r.upstreamPath)
    assert.equal(diag.upstreamModel, r.upstreamModel)
    assert.equal(typeof diag.credentialPresent, 'boolean')
    const text = JSON.stringify(diag)
    for (const secret of [PROVIDER_KEY, SUBSCRIPTION_TOKEN, 'Bearer', 'sk-']) {
      assert.equal(text.includes(secret), false, '诊断投影不得含凭据：' + secret)
    }
  }

  // 订阅域的凭据不可用到 api-key / siwc 域；订阅收据也不能把模型名改写成第三方模型。
  const crossModel = denyOf(() => verifyRequestIdentity(SUB, { urlUsed: 'https://chatgpt.com/backend-api/codex/responses', model: 'deepseek-v4.1-flash' }))
  assert.equal(crossModel.code, 'send_model_drift')
  assert.doesNotThrow(() => verifyRequestIdentity(SUB, { urlUsed: 'https://chatgpt.com/backend-api/codex/responses', model: 'gpt-6-luna' }))
})

test('一行式终态信封：授权域失败按真实域返回，未被吞成 all_providers_failed', () => {
  for (const [status, code] of [[401, 'upstream_unauthorized'], [402, 'upstream_quota_exhausted'], [403, 'upstream_forbidden']]) {
    const envelope = authFailureResponse(status, { authDomain: AUTH_DOMAINS.API_KEY })
    assert.equal(envelope.handled, true)
    assert.equal(envelope.status, status, '必须保留上游真实状态码')
    assert.equal(envelope.contentType, 'application/json; charset=utf-8')
    const parsed = JSON.parse(envelope.buf.toString('utf8'))
    assert.equal(parsed.error.code, code)
    assert.equal(parsed.error.type, 'auth_domain_failure')
    assert.equal(parsed.error.authDomain, AUTH_DOMAINS.API_KEY)
    assert.equal(parsed.error.terminal, true)
    assert.equal(parsed.error.fallbackAllowed, false)
    assert.equal(Object.isFrozen(envelope), true)
    for (const secret of [PROVIDER_KEY, SUBSCRIPTION_TOKEN, 'Bearer']) {
      assert.equal(envelope.buf.toString('utf8').includes(secret), false, '信封不得含凭据：' + secret)
    }
  }
  // 配额型 429 同样是终态；速率型 429 交给既有的 Retry-After 通道（返回 null，不抢）。
  assert.equal(authFailureResponse(429, { authDomain: AUTH_DOMAINS.API_KEY, bodyText: 'quota exceeded' }).status, 429)
  assert.equal(authFailureResponse(429, { authDomain: AUTH_DOMAINS.API_KEY, bodyText: 'rate limit reached' }), null)
  assert.equal(authFailureResponse(200, { authDomain: AUTH_DOMAINS.API_KEY }), null)
  assert.equal(authFailureResponse(500, { authDomain: AUTH_DOMAINS.API_KEY }), null)
  assert.equal(authFailureResponse(404, { authDomain: AUTH_DOMAINS.API_KEY }), null, '模型不可用仍走模型级通道')
})
