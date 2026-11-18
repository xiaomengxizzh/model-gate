// A4 安全不变量（离线、纯判定）：补齐三组跨模块对抗用例，均使用本代理拥有的模块
//   src/providers/opencode-go.js、src/subscription/isolation.js、src/codex/target-authz.js。
//
// 不重复既有覆盖（agg-v2-auth-domains / agg-v2-auth-isolation / agg-auth-leak / p03 已覆盖普通路径）；
// 这里只钉三个直接映射本轮任务约束的对抗边界：
//   1. 显式请求【官方模型 ID】打到 Go 适配器：不得静默映射成 V2 目标 deepseek（MG-FIX-P1-03）。
//   2. 429/鉴权失败的跨域候选：授权域终态收据永不改写模型/状态码、永不切到另一授权域（无 fallback）。
//   3. 凭据（含账号/令牌）在租约、拒绝消息、错误解码的组合投影中都不出现（不泄漏）。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mapModel, readiness, identityOf, DEFAULT_VENDOR_MODEL, GO_READY_CODES,
} from '../../../src/providers/opencode-go.js'
import {
  AUTH_DOMAINS, AUTH_FAILURE_KINDS, classifyAuthDomainFailure,
  authFailureReceipt, authFailureResponse,
} from '../../../src/codex/target-authz.js'
import {
  createCredentialLease, redactLease, assertLeaseDomain,
} from '../../../src/subscription/isolation.js'
import { decodeError } from '../../../src/providers/opencode-go.js'
import { handleAggregationApi } from '../../../src/aggregation/api.js'

const GO_PROVIDER = Object.freeze({
  id: 'opencodego',
  v2Scope: 'go-single-model',
  apiKeyEnv: 'TEST_AGG_OPENCODE_KEY',
  _def: { baseUrl: 'https://opencode.ai/inference/go/openai/v1', opencodeGoVersion: 'go-v1' },
})
// 配置里只有 V2 目标别名，没有官方模型 ID。
const CFG = Object.freeze({ models: {} })

// ---------------------------------------------------------------------------
// 1. 未知/官方显式模型 ID 不得被静默路由到 deepseek
// ---------------------------------------------------------------------------
test('显式官方模型 ID 打到 Go：mapModel/identityOf/readiness 全部 typed 拒绝，绝不静默换目标模型', () => {
  const officialId = 'gpt-6-luna' // 真实父模型名，绝不能作为 Go 子代理的隐式兜底
  const mapped = mapModel(CFG, officialId)
  assert.equal(mapped.ok, false, '官方 ID 未在 config/models 声明时不得映射')
  assert.equal(mapped.code, 'opencodego_model_unmapped')
  assert.equal(mapped.vendorModel, undefined, '拒绝时不得附带任何替代模型名（尤其不能是 deepseek）')

  // 请求级身份：即使有人错把 deepseek 的公共 ID 配上官方上游 ID，也必须拒绝而不是自愈。
  const id = identityOf({ upstreamId: officialId, publicId: 'mg-opencodego-deepseek-v4-1-flash' })
  assert.equal(id.ok, false)
  assert.equal(id.code, GO_READY_CODES.MODEL_OUT_OF_SCOPE)
  assert.notEqual(id.upstreamId, DEFAULT_VENDOR_MODEL)

  const r = readiness({ provider: GO_PROVIDER, cfg: CFG, model: officialId })
  assert.equal(r.ok, false, '未知显式模型的 readiness 必须为否')
  assert.equal(r.ready, false)
  assert.equal(r.allowModelSwitch, false, '失败不得携带“可换模型”许可')
  assert.equal(r.allowProviderSwitch, false)
})

test('V2 目标模型本身可正常映射，证明拒绝来自严格策略而非全盘失效', () => {
  const mapped = mapModel(CFG, DEFAULT_VENDOR_MODEL)
  assert.equal(mapped.ok, true)
  assert.equal(mapped.vendorModel, DEFAULT_VENDOR_MODEL)
  const id = identityOf({ upstreamId: DEFAULT_VENDOR_MODEL })
  assert.equal(id.ok, true)
  assert.equal(id.outboundModel, DEFAULT_VENDOR_MODEL)
})

// ---------------------------------------------------------------------------
// 2. 429 / 鉴权失败的跨域候选：终态收据不改写、不切换
// ---------------------------------------------------------------------------
test('授权域失败收据：401/402/403/配额429 在任意域都 terminal，且不改写模型/状态、不跨域', () => {
  for (const domain of Object.values(AUTH_DOMAINS)) {
    for (const status of [401, 402, 403]) {
      const f = classifyAuthDomainFailure(status, { authDomain: domain })
      assert.equal(f.terminal, true)
      assert.equal(f.fallbackAllowed, false, domain + ' ' + status + ' 不得换域/换套餐')
      assert.equal(f.rewriteModel, false)
      assert.equal(f.rewriteStatus, false)
      assert.equal(f.authDomain, domain, '归因必须停在真实授权域')
    }
    const quota = classifyAuthDomainFailure(429, { authDomain: domain, bodyText: 'quota exceeded' })
    assert.equal(quota.kind, AUTH_FAILURE_KINDS.QUOTA_EXHAUSTED)
    assert.equal(quota.retryable, false)
    assert.equal(quota.fallbackAllowed, false)
    // 配额型 429 是终态信封，且带的是【请求所属域】，不会冒出另一授权域。
    const env = authFailureResponse(429, { authDomain: domain, bodyText: 'quota exceeded' })
    const body = JSON.parse(env.buf.toString('utf8'))
    assert.equal(body.error.authDomain, domain)
    assert.equal(body.error.fallbackAllowed, false)
    assert.equal(body.error.type, 'auth_domain_failure')
    const raw = JSON.stringify(body)
    for (const other of Object.values(AUTH_DOMAINS)) {
      if (other !== domain) assert.equal(raw.includes(other), false, '信封不得夹带其它授权域 ' + other)
    }
  }
})

test('速率型 429 同域可重试，但仍不产生 fallback 收据、不改写模型', () => {
  for (const domain of Object.values(AUTH_DOMAINS)) {
    const rate = classifyAuthDomainFailure(429, { authDomain: domain, bodyText: 'rate limit reached' })
    assert.equal(rate.kind, AUTH_FAILURE_KINDS.RATE_LIMITED)
    assert.equal(rate.retryable, true, '同域内允许退避重试')
    assert.equal(rate.fallbackAllowed, false, '可重试 ≠ 可跨域换套餐')
    assert.equal(rate.rewriteModel, false)
    assert.equal(authFailureReceipt(429, { authDomain: domain, bodyText: 'rate limit reached' }), null)
  }
})

// ---------------------------------------------------------------------------
// 3. 凭据不泄漏：租约 / 拒绝消息 / 错误解码的组合投影
// ---------------------------------------------------------------------------
test('凭据不泄漏：租约序列化、跨域拒绝消息、上游错误解码都不含令牌/账号/凭据片段', () => {
  const token = 'LEASE_TOKEN_SENTINEL_9f3a7c'
  const account = 'acct-sentinel-7742'
  const lease = createCredentialLease({
    origin: AUTH_DOMAINS.CODEX_SUBSCRIPTION, token, accountId: account, source: 'codex_auth_json',
  })
  assert.equal(JSON.stringify(lease).includes(token), false, '租约 JSON 不得带令牌')
  assert.equal(JSON.stringify(lease).includes(account), false, '租约 JSON 不得带账号')
  assert.equal(JSON.stringify(redactLease(lease)).includes(token), false)
  assert.equal(Object.keys(JSON.parse(JSON.stringify(lease))).includes('token'), false)

  // 跨域拒绝消息只带域名，不带令牌或账号。
  let denied
  try { assertLeaseDomain(lease, AUTH_DOMAINS.API_KEY) } catch (e) { denied = e }
  assert.ok(denied && denied.deny === true, '跨域必须是 typed deny')
  assert.equal(denied.code, 'credential_domain_mismatch')
  assert.equal(denied.message.includes(token), false)
  assert.equal(denied.message.includes(account), false)

  // 上游错误正文里的 Bearer / sk- / JWT 一律脱敏。
  const err = decodeError(401, 'Bearer ' + token + ' sk-synthetic12345678 eyJhbGciOi.secret.payload', {})
  for (const secret of [token, 'sk-synthetic12345678', 'eyJhbGciOi.secret.payload']) {
    assert.equal(err.message.includes(secret), false, '错误解码不得回显 ' + secret)
  }
  assert.match(err.message, /Bearer \*\*\*/)
})

// ---------------------------------------------------------------------------
// 4. 管理面写操作：缺显式管理员 / 非回环来源一律 403（ MG-FIX-P1-04 的安全下界）
//    守卫在 api.js 入口（MAIN 拥有，本测试只读调用、不改产品代码）；admin-origin.test.mjs
//    另在真实 HTTP 层覆盖 Origin/Host 跨源，这里补的是 handler 层的 typed 拒绝。
// ---------------------------------------------------------------------------
const WRITE_CTX = {
  method: 'POST',
  path: '/api/aggregation/providers',
  cfg: { defaults: {}, providers: {}, models: {}, configVersion: 0 },
  log: null,
  rawBody: JSON.stringify({ provider: { kind: 'go', apiKeyEnv: 'MG_TEST_KEY' } }),
}

test('模块侧：无显式管理员标记的聚合写被 403 拒绝（模块鉴权源码不变）', async () => {
  const out = await handleAggregationApi(Object.assign({}, WRITE_CTX, {
    explicitAdmin: false, isLocal: true,
  }))
  assert.equal(out.status, 403)
  assert.equal(out.body.code, 'explicit_admin_required')
  assert.equal(out.body.ok, false)
})

test('非回环来源的聚合写被 403 拒绝（回环地址不等于永久管理员）', async () => {
  const out = await handleAggregationApi(Object.assign({}, WRITE_CTX, {
    explicitAdmin: true, isLocal: false,
  }))
  assert.equal(out.status, 403)
  assert.equal(out.body.code, 'aggregation_loopback_required')
  assert.equal(out.body.ok, false)
})
