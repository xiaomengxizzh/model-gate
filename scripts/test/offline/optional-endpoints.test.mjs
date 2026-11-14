// M1-4a / T-OPTIONAL-01：可选端点的共用策略入口。
// 覆盖：能力默认关闭、身份 401、429 保留状态与 Retry-After（不折叠 502）、取消一次终态、
// 本地限流、每类端点共用同一入口。全部进程内，无网络。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CAPABILITY_DISABLED,
  CAPABILITY_ENABLED,
  OPTIONAL_POLICY_IMPLEMENTATION,
  PROVEN_OPTIONAL_CAPABILITIES,
  canceledResult,
  createCapabilityRegistry,
  createOptionalEndpointPolicy,
  createRateLimiter,
  defaultClassifyStatus,
  parseRetryAfterSeconds,
  resolveOptionalIdentity,
} from '../../../src/optional/policy.js'
import { createEmbeddingPolicy } from '../../../src/embeddings.js'
import { createRerankPolicy } from '../../../src/rerank.js'
import { createMediaPolicy } from '../../../src/media.js'

const okSend = (status = 200, headers = {}, body = { ok: true }) => async () => ({ status, headers, body })
const target = { provider: 'mock', path: '/v1/optional', model: 'm' }

test('能力注册表：已证实能力默认 ENABLED；未证实的新端点默认 DISABLED 且明确 501（不是 404）', async () => {
  const registry = createCapabilityRegistry()
  for (const capability of PROVEN_OPTIONAL_CAPABILITIES) {
    const state = registry.stateOf(capability)
    assert.equal(state.enabled, true)
    assert.equal(state.reason, null)
  }
  const unknown = registry.stateOf('brand-new-capability')
  assert.equal(unknown.enabled, false)
  assert.equal(unknown.reason, 'unproven_capability')
  assert.equal(CAPABILITY_ENABLED, 'ENABLED')
  assert.equal(CAPABILITY_DISABLED, 'DISABLED')
  assert.throws(() => registry.set('brand-new-capability', true), /unproven capability/)

  const policy = createOptionalEndpointPolicy({ capability: 'brand-new-capability', registry, send: okSend() })
  const result = await policy.execute({ subjectId: 's1', body: {}, target })
  assert.equal(result.ok, false)
  assert.equal(result.status, 501, '未证实的可选端点必须显式拒绝，不能静默 404/放行')
  assert.equal(result.error.code, 'optional_endpoint_disabled')
  assert.equal(result.error.capability, 'brand-new-capability')

  const disabled = createCapabilityRegistry({ embedding: { enabled: false, reason: 'contract_not_signed_off' } })
  const disabledPolicy = createOptionalEndpointPolicy({ capability: 'embedding', registry: disabled, send: okSend() })
  const refused = await disabledPolicy.execute({ subjectId: 's1', body: { model: 'm', input: 'x' }, target })
  assert.equal(refused.status, 501)
  assert.equal(refused.error.reason, 'contract_not_signed_off')
})

test('身份解析单一实现：缺少可识别主体 → 401（所有端点一致）', async () => {
  assert.deepEqual(resolveOptionalIdentity({}), { ok: false, status: 401, error: { type: 'unauthorized', code: 'missing_subject', message: '可选端点需要可识别的调用主体（客户端 Key / 虚拟 Key / 显式身份）' } })
  assert.equal(resolveOptionalIdentity({ keyId: 'vm-a' }).subjectId, 'vm-a')
  for (const factory of [createEmbeddingPolicy, createRerankPolicy, (o) => createMediaPolicy('audio', o), (o) => createMediaPolicy('image', o)]) {
    const policy = factory({ send: okSend() })
    const result = await policy.execute({ body: {}, target })
    assert.equal(result.status, 401)
    assert.equal(result.error.code, 'missing_subject')
  }
})

test('429：保留状态与 Retry-After，不折叠成 502；5xx 才折叠为 502', async () => {
  assert.equal(parseRetryAfterSeconds({ 'retry-after': '7' }), 7)
  assert.equal(parseRetryAfterSeconds({ 'Retry-After': '1.2' }), 2)
  assert.ok(parseRetryAfterSeconds({ 'retry-after': new Date(Date.now() + 5000).toUTCString() }) >= 4)
  assert.equal(parseRetryAfterSeconds({}), null)
  assert.equal(defaultClassifyStatus(429, { 'retry-after': '9' }).status, 429)
  assert.equal(defaultClassifyStatus(500, {}).status, 502)

  const policy = createOptionalEndpointPolicy({ capability: 'rerank', send: okSend(429, { 'retry-after': '11' }) })
  const result = await policy.execute({ subjectId: 's1', body: { model: 'm', query: 'q', documents: ['d'] }, target })
  assert.equal(result.ok, false)
  assert.equal(result.status, 429, '429 必须原样保留，不得折叠成 502')
  assert.equal(result.retryAfterSec, 11)
  assert.equal(result.upstreamStatus, 429)
  assert.equal(result.error.type, 'rate_limited')

  const boom = createOptionalEndpointPolicy({ capability: 'rerank', send: okSend(503, {}) })
  const down = await boom.execute({ subjectId: 's1', body: { model: 'm', query: 'q', documents: ['d'] }, target })
  assert.equal(down.status, 502)
})

test('取消：一次终态，迟到的上游结果被忽略；已取消的 signal 直接返回 499', async () => {
  let release
  const controller = new AbortController()
  const policy = createOptionalEndpointPolicy({
    capability: 'audio',
    send: async () => new Promise((resolve) => { release = () => resolve({ status: 200, body: { late: true } }) }),
  })
  const pending = policy.execute({ subjectId: 's1', body: { model: 'm', input: 'hi' }, target, signal: controller.signal })
  await new Promise((r) => setTimeout(r, 5))
  controller.abort()
  const result = await pending
  assert.deepEqual(result, canceledResult())
  assert.equal(result.status, 499)
  assert.equal(result.error.type, 'canceled')
  release()
  // 迟到的结果不会产生第二个终态（结果对象已经是第一次取消的值）
  const controller2 = new AbortController()
  controller2.abort()
  const again = await policy.execute({ subjectId: 's1', body: { model: 'm', input: 'hi' }, target, signal: controller2.signal })
  assert.equal(again.status, 499)
  assert.equal(again.error.code, 'request_canceled')
})

test('本地限流：按主体+能力计数，超限 429 带 Retry-After 秒数', async () => {
  let clock = 1000
  const limiter = createRateLimiter({ limit: 2, windowMs: 60000, now: () => clock })
  const policy = createOptionalEndpointPolicy({ capability: 'image', rateLimiter: limiter, send: okSend() })
  const body = { model: 'm', prompt: 'p' }
  assert.equal((await policy.execute({ subjectId: 's1', body, target })).ok, true)
  assert.equal((await policy.execute({ subjectId: 's1', body, target })).ok, true)
  const blocked = await policy.execute({ subjectId: 's1', body, target })
  assert.equal(blocked.status, 429)
  assert.equal(blocked.error.code, 'local_rate_limited')
  assert.ok(blocked.retryAfterSec >= 1)
  assert.equal((await policy.execute({ subjectId: 's2', body, target })).ok, true, '不同主体互不影响')
  clock += 61000
  assert.equal((await policy.execute({ subjectId: 's1', body, target })).ok, true, '窗口过后恢复')
})

test('每类可选端点都走同一策略实现，仅声明差异', async () => {
  const cases = [
    ['embedding', createEmbeddingPolicy({ send: okSend() }), { model: 'e', input: 'x' }],
    ['rerank', createRerankPolicy({ send: okSend() }), { model: 'r', query: 'q', documents: ['d'] }],
    ['audio', createMediaPolicy('audio', { send: okSend() }), { model: 'a', input: 'hi' }],
    ['image', createMediaPolicy('image', { send: okSend() }), { model: 'i', prompt: 'p' }],
  ]
  for (const [capability, policy, body] of cases) {
    assert.equal(policy.capability, capability)
    assert.equal(policy.implementation, OPTIONAL_POLICY_IMPLEMENTATION, capability + ' 必须复用同一入口')
    const result = await policy.execute({ subjectId: 's1', body, target })
    assert.equal(result.ok, true, capability + ' 正常路径')
    assert.equal(result.status, 200)
    assert.equal(result.subjectId, 's1')
    const invalid = await policy.execute({ subjectId: 's1', body: {}, target })
    assert.equal(invalid.status, 400, capability + ' 校验差异仍然生效')
  }
  assert.throws(() => createMediaPolicy('video', { send: okSend() }), /audio or image/)
  assert.equal(createEmbeddingPolicy().capability, 'embedding')
})
