import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, startMockUpstream, startScriptedUpstream } from './harness.mjs'

const poolId = 'pool_1234567890abcdef'
const sentinel = 'sk-ROUTE-PREVIEW-SECRET-MUST-NOT-LEAK'
const connectionId = 'conn_1234567890abcdef'

async function fixture(t, extra = {}, env = {}, existingUpstream = null) {
  const upstream = existingUpstream || await startMockUpstream()
  const config = {
    providers: {
      p1: { baseUrl: upstream.base, costEstimateUsd: 0.1, connections: [{ connectionId, apiKeyEnv: 'MG_TEST_CONNECTION_KEY', quotaScopeId: 'quota-fixture', priority: 0 }] },
      p2: { baseUrl: upstream.base, costEstimateUsd: 0.2 },
      p3: { baseUrl: upstream.base, costEstimateUsd: 0.05 },
    },
    models: {
      alpha: { provider: 'p1', costEstimateUsd: 0.1, codex: { capabilities: {} } },
      beta: { provider: 'p2', costEstimateUsd: 0.2, codex: { capabilities: {} } },
      embed: { provider: 'p3', capability: 'embedding', costEstimateUsd: 0.01, codex: { capabilities: {} } },
    },
    defaults: {
      directory: [{ model: 'beta', mode: 'onFail', providers: ['p2'] }],
      requestBudget: { maxTotalAttempts: 4, maxFailovers: 3, maxRecoveryAttempts: 1, maxWaitMs: 5000 },
      codexFallbackLimits: { maxTotalAttempts: 3, maxFailovers: 2 },
      codexBudget: { requestUsd: 1 },
    },
    virtualModels: [{
      poolId, slug: 'mg-pool-route-fixture', name: 'route-fixture', selection: 'priority', enabled: true,
      members: [
        { modelId: 'alpha', providerId: 'p1', priority: 0, enabled: true },
        { modelId: 'beta', providerId: 'p2', priority: 1, enabled: true },
        { modelId: 'embed', providerId: 'p3', priority: 2, enabled: true },
      ],
      directory: [
        { model: 'alpha', providers: ['p1'] }, { model: 'beta', providers: ['p2'] }, { model: 'embed', providers: ['p3'] },
      ],
    }],
    harnessBindings: {
      bind_fixture: { bindingId: 'bind_fixture', harnessId: 'codex', mode: 'aggregated', roleTargets: { parent: { kind: 'native', id: 'alpha' }, child: { kind: 'pool', id: poolId }, route: { kind: 'model', id: 'beta' } } },
    },
    ...extra,
  }
  if (extra.defaults) config.defaults = { ...config.defaults, ...extra.defaults }
  const gw = await startGateway({ name: 'v13-route-preview', config, env: { MG_TEST_CONNECTION_KEY: 'synthetic-connection-key', ...env } })
  t.after(async () => { await gw.stop(); await upstream.stop() })
  return { gw, upstream }
}

test('G11 legacy {model} fields remain exact and preview stays zero-upstream', { timeout: 30000 }, async t => {
  const { gw, upstream } = await fixture(t)
  const cases = [
    [{ model: 'alpha' }, { ok: true, hit: { type: 'model', name: 'alpha', provider: 'p1', note: null } }],
    [{ model: 'route-fixture' }, { ok: true, hit: { type: 'virtual', name: 'route-fixture', directory: [
      { model: 'alpha', mode: 'afterAll', providers: ['p1'], limit: null },
      { model: 'beta', mode: 'afterAll', providers: ['p2'], limit: null },
      { model: 'embed', mode: 'afterAll', providers: ['p3'], limit: null },
    ], quota: 0, dailyQuota: 0, used: 0, quotaState: null } }],
    [{ model: 'missing' }, { ok: true, hit: { type: 'unknown', model: 'missing', note: 'model 未在 config/models 中配置，且未设置 defaults.provider: missing' } }],
  ]
  for (const [body, expected] of cases) {
    const response = await gw.post('/api/route-preview', body)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), expected)
  }
  assert.equal(upstream.hits.length, 0)
})

test('G11 extended pool preview uses policy order and reports blocks, ledger, quota and replay', { timeout: 30000 }, async t => {
  const { gw, upstream } = await fixture(t)
  const response = await gw.post('/api/route-preview', {
    model: 'route-fixture', role: { kind: 'pool', id: poolId }, capability: 'chat', scenario: 'normal',
    budget: { maxTotalAttempts: 2, maxFailovers: 1, maxAttemptsPerCandidate: 1 }, body: sentinel,
  })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).code, 'invalid_route_preview')

  const ok = await gw.post('/api/route-preview', {
    model: 'route-fixture', role: { kind: 'pool', id: poolId }, capability: 'chat', scenario: 'normal',
    budget: { maxTotalAttempts: 2, maxFailovers: 1, maxAttemptsPerCandidate: 1 },
  })
  assert.equal(ok.status, 200)
  const result = await ok.json()
  assert.deepEqual(result.hit, { ok: true, hit: { type: 'virtual', name: 'route-fixture', directory: [
    { model: 'alpha', mode: 'afterAll', providers: ['p1'], limit: null },
    { model: 'beta', mode: 'afterAll', providers: ['p2'], limit: null },
    { model: 'embed', mode: 'afterAll', providers: ['p3'], limit: null },
  ], quota: 0, dailyQuota: 0, used: 0, quotaState: null } }.hit)
  assert.equal(result.preview.zeroUpstream, true)
  assert.deepEqual(result.preview.wouldSend.map(x => x.model), ['alpha', 'beta'], JSON.stringify(result.preview))
  assert.equal(result.preview.blockedCandidates.find(x => x.model === 'embed').reasons.includes('capability_mismatch'), true)
  assert.equal(result.preview.decision.action, 'continue')
  assert.equal(result.preview.ledger.remaining.totalAttempts, 2)
  assert.equal(result.preview.ledger.remaining.candidateAttempts, 1)
  assert.equal(result.preview.replaySafety.safe, true)
  assert.equal(result.preview.quotaState.find(x => x.model === 'alpha').state, 'available')
  assert.equal(JSON.stringify(result).includes(sentinel), false)
  assert.equal(upstream.hits.length, 0)
})

test('G11 failover, recovery, cancel and quota share decision and RequestLedger semantics', { timeout: 30000 }, async t => {
  const { gw, upstream } = await fixture(t)
  const preview = async scenario => {
    const response = await gw.post('/api/route-preview', { model: 'route-fixture', role: 'child', harnessId: 'codex', scenario })
    assert.equal(response.status, 200)
    return (await response.json()).preview
  }
  const failover = await preview('failover')
  assert.equal(failover.wouldSend.some(x => x.model === 'alpha'), false)
  assert.equal(failover.blockedCandidates.find(x => x.model === 'alpha').reasons.includes('same_target'), true)
  assert.equal(failover.ledger.state.totalAttempts, 2)
  assert.equal(failover.decision.action, 'failover')

  const recovery = await preview('recovery')
  assert.deepEqual(recovery.wouldSend.map(x => x.model), ['alpha'])
  assert.equal(recovery.ledger.state.recoveryAttempts, 1)
  assert.equal(recovery.ledger.decision.code, 'allowed')

  const cancel = await preview('cancel')
  assert.deepEqual(cancel.wouldSend, [])
  assert.equal(cancel.decision.code, 'MG_FB_CANCELLED')
  assert.equal(cancel.replaySafety.safe, false)
  assert.equal(cancel.ledger.decision.code, 'cancelled')
  assert.equal(cancel.ledger.state.cancelReason, 'caller_cancelled')

  const quota = await preview('quota')
  assert.equal(quota.ledger.state.exhaustedQuotaDomains.length, 1)
  assert.equal(quota.replaySafety.safe, true)
  assert.equal(upstream.hits.length, 0)
})

test('G11 route role, explicit Target and official direct role resolve without fallback guessing', { timeout: 30000 }, async t => {
  const upstream = await startMockUpstream()
  const { gw } = await fixture(t, {
    providers: {
      p1: { baseUrl: upstream.base, costEstimateUsd: 0.1, connections: [{ connectionId, apiKeyEnv: 'MG_TEST_CONNECTION_KEY', quotaScopeId: 'quota-fixture', priority: 0 }] },
      p2: { baseUrl: upstream.base, costEstimateUsd: 0.2 },
      p3: { baseUrl: upstream.base, costEstimateUsd: 0.05 },
      official: { baseUrl: 'https://chatgpt.com', codexIdentity: 'official', api: 'responses', apiKeyEnv: 'MG_TEST_OFFICIAL_KEY' },
    },
    models: {
      alpha: { provider: 'p1', costEstimateUsd: 0.1, codex: { capabilities: {} } },
      beta: { provider: 'p2', costEstimateUsd: 0.2, codex: { capabilities: {} } },
      embed: { provider: 'p3', capability: 'embedding', costEstimateUsd: 0.01, codex: { capabilities: {} } },
      'gpt-6-luna': { provider: 'official', api: 'responses', codexOfficial: true },
    },
    defaults: { codexOfficialProvider: 'official', codexBudget: { requestUsd: 1 } },
  }, { MG_TEST_OFFICIAL_KEY: sentinel }, upstream)
  const official = await gw.post('/api/route-preview', { model: 'gpt-6-luna', role: 'official' })
  assert.equal(official.status, 200, JSON.stringify(await official.clone().json()))
  const officialPreview = (await official.json()).preview
  assert.equal(officialPreview.decision.code, 'MG_DIRECT_TARGET')
  assert.deepEqual(officialPreview.wouldSend.map(x => x.provider), ['official'])
  assert.equal(JSON.stringify(officialPreview).includes(sentinel), false)

  const routed = await gw.post('/api/route-preview', { model: 'alpha', role: 'route', harnessId: 'codex' })
  assert.equal(routed.status, 200)
  const routedPreview = (await routed.json()).preview
  assert.deepEqual(routedPreview.wouldSend.map(x => x.model), ['beta'], JSON.stringify(routedPreview))
  const forbiddenGpt = await gw.post('/api/route-preview', { model: 'gpt-6-luna', role: 'route', target: { kind: 'model', id: 'gpt-6-luna' } })
  assert.equal(forbiddenGpt.status, 200)
  const forbiddenPreview = (await forbiddenGpt.json()).preview
  assert.deepEqual(forbiddenPreview.wouldSend, [])
  assert.equal(forbiddenPreview.blockedCandidates.some(item => item.reasons.includes('route_gpt_forbidden')), true)
  const target = await gw.post('/api/route-preview', { model: 'alpha', role: { kind: 'model', id: 'beta' } })
  assert.equal(target.status, 200)
  assert.equal((await target.json()).preview.target.kind, 'model')

  const native = await gw.post('/api/route-preview', { model: 'alpha', role: { kind: 'native', id: 'beta' } })
  assert.equal(native.status, 200, JSON.stringify(await native.clone().json()))
  const nativeResult = await native.json()
  assert.deepEqual(nativeResult.preview.target, { kind: 'native', id: 'beta' })
  assert.deepEqual(nativeResult.hit, { type: 'model', name: 'beta', provider: 'p2', note: null })
  assert.deepEqual(nativeResult.preview.wouldSend.map(x => x.model), ['beta'], JSON.stringify(nativeResult))

  const nativeDirectOfficial = await gw.post('/api/route-preview', { model: 'alpha', role: { kind: 'native', id: 'gpt-6-luna' } })
  assert.equal(nativeDirectOfficial.status, 200, JSON.stringify(await nativeDirectOfficial.clone().json()))
  const nativeDirectOfficialPreview = (await nativeDirectOfficial.json()).preview
  assert.deepEqual(nativeDirectOfficialPreview.target, { kind: 'native', id: 'gpt-6-luna' })
  assert.equal(nativeDirectOfficialPreview.decision.code, 'MG_DIRECT_TARGET')
  assert.deepEqual(nativeDirectOfficialPreview.wouldSend.map(x => x.model), ['gpt-6-luna'])

  const nativeOfficial = await gw.post('/api/route-preview', { model: 'alpha', role: 'route', target: { kind: 'native', id: 'gpt-6-luna' } })
  assert.equal(nativeOfficial.status, 200, JSON.stringify(await nativeOfficial.clone().json()))
  const nativeOfficialPreview = (await nativeOfficial.json()).preview
  assert.deepEqual(nativeOfficialPreview.target, { kind: 'native', id: 'gpt-6-luna' })
  assert.deepEqual(nativeOfficialPreview.wouldSend, [])
  assert.equal(nativeOfficialPreview.blockedCandidates.some(item => item.model === 'gpt-6-luna' && item.reasons.includes('route_gpt_forbidden')), true)
  assert.equal(upstream.hits.length, 0)
})

test('G11 native role targets fail closed for unknown and disabled models', { timeout: 30000 }, async t => {
  const { gw, upstream } = await fixture(t, {
    models: {
      alpha: { provider: 'p1', costEstimateUsd: 0.1, codex: { capabilities: {} } },
      beta: { provider: 'p2', costEstimateUsd: 0.2, codex: { capabilities: {} } },
      disabled: { provider: 'p2', enabled: false, codex: { capabilities: {} } },
    },
    defaults: { provider: 'p2', codexBudget: { requestUsd: 1 } },
  })
  const cases = [
    [{ model: 'alpha', role: { kind: 'native', id: 'missing' } }, 'route_preview_target_unavailable'],
    [{ model: 'alpha', role: { kind: 'native', id: 'disabled' } }, 'route_preview_unresolved'],
  ]
  for (const [body, code] of cases) {
    const response = await gw.post('/api/route-preview', body)
    assert.equal(response.status, 422, JSON.stringify(await response.clone().json()))
    const result = await response.json()
    assert.equal(result.code, code)
    assert.equal(result.retryable, false)
  }
  assert.equal(upstream.hits.length, 0)
})

test('G11 preview candidate order matches real execution decision path', { timeout: 30000 }, async t => {
  const sentModels = []
  const upstream = await startScriptedUpstream(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    sentModels.push(body.model)
    if (sentModels.length < 3) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' })
      res.end('{}')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'ok', object: 'response', status: 'completed', output: [] }))
  })
  const gw = await startGateway({ name: 'v13-route-preview-parity', config: {
    providers: { p1: { baseUrl: upstream.base }, p2: { baseUrl: upstream.base } },
    models: {
      alpha: { provider: 'p1', costEstimateUsd: 0.1, codex: { capabilities: {} } },
      beta: { provider: 'p2', costEstimateUsd: 0.2, codex: { capabilities: {} } },
    },
    defaults: {
      directory: [{ model: 'beta', providers: ['p2'] }], codexFallback: true,
      codexBudget: { requestUsd: 1 }, retry: { maxAttempts: 1 },
      requestBudget: { maxTotalAttempts: 3, maxFailovers: 2, maxWaitMs: 1000 },
    },
  } })
  t.after(async () => { await gw.stop(); await upstream.stop() })
  const preview = await gw.post('/api/route-preview', { model: 'alpha', scenario: 'normal' })
  assert.equal(preview.status, 200, JSON.stringify(await preview.clone().json()))
  const order = (await preview.json()).preview.wouldSend.map(x => x.model)
  assert.deepEqual(order, ['alpha', 'beta'])
  assert.equal(upstream.hits.length, 0)
  const executed = await gw.post('/v1/responses', { model: 'alpha', input: 'hi', stream: false })
  assert.equal(executed.status, 200, JSON.stringify(await executed.clone().json()))
  assert.deepEqual(sentModels, ['alpha', 'alpha', 'beta'])
})

test('G11 budget exhaustion blocks sends and reports exact ledger limits', { timeout: 30000 }, async t => {
  const { gw, upstream } = await fixture(t)
  for (const budget of [{ maxTotalAttempts: 0 }, { requestUsd: 0.01 }]) {
    const response = await gw.post('/api/route-preview', { model: 'route-fixture', role: 'child', harnessId: 'codex', budget })
    assert.equal(response.status, 200)
    const preview = (await response.json()).preview
    assert.deepEqual(preview.wouldSend, [])
    assert.equal(preview.blockedCandidates.length > 0, true)
  }
  assert.equal(upstream.hits.length, 0)
})

test('G11 quota projection uses live usage and preview adds no upstream hit', { timeout: 30000 }, async t => {
  const { gw, upstream } = await fixture(t, {
    virtualModels: [{
      poolId, slug: 'mg-pool-route-fixture', name: 'route-fixture', selection: 'priority', enabled: true, quota: 1,
      directory: [{ model: 'alpha', providers: ['p1'] }, { model: 'beta', providers: ['p2'] }],
    }],
  })
  const executed = await gw.post('/v1/chat/completions', { model: 'route-fixture', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(executed.status, 200)
  const before = upstream.hits.length
  const response = await gw.post('/api/route-preview', { model: 'route-fixture', role: 'child', harnessId: 'codex' })
  assert.equal(response.status, 200)
  const preview = (await response.json()).preview
  assert.equal(preview.quotaState.find(x => x.model === 'route-fixture').state, 'exhausted')
  assert.deepEqual(preview.wouldSend, [])
  assert.equal(preview.blockedCandidates.every(x => x.reasons.includes('pool_quota_exhausted')), true)
  assert.equal(upstream.hits.length, before)
})

test('G11 unknown role/capability/scenario/budget fail closed with stable codes and no echo', { timeout: 30000 }, async t => {
  const { gw, upstream } = await fixture(t)
  const cases = [
    [{ model: 'alpha', role: 'admin-secret-role' }, 'invalid_role'],
    [{ model: 'alpha', capability: 'thinking' }, 'invalid_capability'],
    [{ model: 'alpha', scenario: 'retry-forever' }, 'invalid_scenario'],
    [{ model: 'alpha', budget: { maxTotalAttempts: -1 } }, 'invalid_budget'],
    [{ model: 'alpha', budget: { secret: sentinel } }, 'invalid_budget'],
    [{ model: 'alpha', budget: { maxTotalAttempts: 1.5 } }, 'invalid_budget'],
    [{ model: 'alpha', budget: { requestUsd: 1e12 } }, 'invalid_budget'],
    [{ model: 'alpha', role: 'route', target: { kind: 'model', id: 'beta', secret: sentinel } }, 'invalid_role'],
    [{ model: 'alpha', role: { kind: 'pool', id: sentinel } }, 'route_preview_target_unavailable'],
  ]
  for (const [body, code] of cases) {
    const response = await gw.post('/api/route-preview', body)
    assert.equal(response.status, code.startsWith('route_preview') ? 422 : 400)
    const result = await response.json()
    assert.equal(result.code, code)
    assert.equal(result.retryable, false)
    assert.equal(JSON.stringify(result).includes(sentinel), false)
  }
  assert.equal(upstream.hits.length, 0)
})
