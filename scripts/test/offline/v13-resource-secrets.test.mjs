import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planConnection } from '../../../src/resources/connections.js'
import { planPolicy } from '../../../src/resources/policies.js'
import { handleResourceApi } from '../../../src/resources/resource-api.js'
import { createOperationStore } from '../../../src/resources/operation-store.js'
import { SECRET_MASK } from '../../../src/resources/redaction.js'
import { handleServiceApi } from '../../../src/resources/service-api.js'
import { buildProvider } from '../../../src/router.js'
import { startGateway } from './harness.mjs'

const CONNECTION_ID = 'conn_1234567890123456'
const OTHER_CONNECTION_ID = 'conn_abcdef1234567890'
const INITIAL_SECRETS = [
  'target-header-canary', 'target-proxy-user-canary', 'target-proxy-password-canary',
  'target-url-user-canary', 'target-query-canary', 'other-header-canary',
  'other-proxy-password-canary', 'defaults-header-canary', 'defaults-proxy-password-canary',
  'target-session-hmac-canary', 'defaults-session-hmac-canary',
  'target-connection-header-canary', 'target-connection-proxy-password-canary',
]
const ROTATED_SECRETS = [
  'rotated-target-header', 'rotated-target-proxy-password', 'rotated-target-url-user-canary',
  'rotated-target-query-canary', 'rotated-other-header', 'rotated-other-proxy-password',
  'rotated-defaults-header', 'rotated-defaults-proxy-password', 'rotated-bare-header',
  'rotated-bare-proxy-password', 'rotated-bare-url-user', 'rotated-target-session-hmac',
  'rotated-defaults-session-hmac', 'rotated-target-connection-header',
  'rotated-target-connection-proxy-password', 'rotated-other-connection-header',
  'rotated-other-connection-proxy-password', 'rotated-bare-session-hmac',
]

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function provider(label) {
  return {
    baseUrl: `https://${label}-url-user-canary@example.test/v1?token=${label}-query-canary#fragment`,
    proxy: `http://${label}-proxy-user-canary:${label}-proxy-password-canary@example.test:8080`,
    extraHeaders: { authorization: `Bearer ${label}-header-canary`, 'x-visible': 'kept' },
  }
}

function fixture(t, cfg, durable = true) {
  const dir = mkdtempSync(join(tmpdir(), 'mg-resource-secrets-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const state = { cfg: structuredClone(cfg), writes: [] }
  const store = durable ? createOperationStore(join(dir, 'operations'), 'local') : null
  const ctx = {
    method: 'POST', path: '/api/config/preview', body: null,
    getConfig: () => state.cfg,
    saveConfig: (payload) => {
      state.writes.push(structuredClone(payload))
      state.cfg = { ...state.cfg, ...structuredClone(payload), configVersion: (state.cfg.configVersion || 0) + 1 }
      return { version: state.cfg.configVersion }
    },
    previews: new Map(), receipts: new Map(), now: Date.now(),
    ...(store ? { operationStore: store } : {}),
  }
  return { ctx, state, store, dir }
}

async function preview(ctx, body) {
  ctx.method = 'POST'; ctx.path = '/api/config/preview'; ctx.body = body
  const response = await handleResourceApi(ctx)
  assert.equal(response.status, 200, JSON.stringify(response.body))
  return response.body
}

async function commit(ctx, method, path, plan) {
  ctx.method = method; ctx.path = path
  ctx.body = { expectedVersion: plan.expectedVersion, requestId: plan.requestId, previewId: plan.previewId, confirmToken: plan.confirmToken }
  return handleResourceApi(ctx)
}

function persistedText(dir) {
  const text = []
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.json')) text.push(readFileSync(path, 'utf8'))
    }
  }
  walk(dir)
  return text.join('\n')
}

function assertNoCanaries(text, canaries) {
  for (const canary of canaries) assert.equal(text.includes(canary), false, `persisted plaintext canary: ${canary}`)
}

function baseConfig() {
  return {
    configVersion: 7,
    providers: {
      target: {
        ...provider('target'),
        sessionHmacSecret: 'target-session-hmac-canary',
        connections: [
          {
            connectionId: CONNECTION_ID, credentialKeyId: CONNECTION_ID, displayName: 'before', enabled: true, priority: 0,
            extraHeaders: { authorization: 'Bearer target-connection-header-canary' },
            proxy: 'http://target-connection-proxy-user:target-connection-proxy-password-canary@example.test:8080',
          },
          { connectionId: OTHER_CONNECTION_ID, credentialKeyId: OTHER_CONNECTION_ID, displayName: 'other', enabled: true, priority: 1, proxy: 'direct', extraHeaders: {} },
        ],
      },
      other: provider('other'),
      bare: { baseUrl: 'https://bare.example.test/v1', proxy: 'direct', extraHeaders: {} },
    },
    defaults: {
      proxy: 'http://defaults-proxy-user:defaults-proxy-password@example.test:8080',
      extraHeaders: { authorization: 'Bearer defaults-header-canary' },
      sessionHmacSecret: 'defaults-session-hmac-canary',
      custom: { keep: true },
    },
    models: {}, policies: {}, _keys: {},
  }
}

test('connection plans persist masks and commit restores current provider secrets, including concurrent rotation', async (t) => {
  const { ctx, state, store, dir } = fixture(t, baseConfig())
  const plan = await preview(ctx, {
    action: 'connection.update', expectedVersion: 7, requestId: 'connection-secrets', providerId: 'target',
    connectionId: CONNECTION_ID, patch: { displayName: 'after' },
  })
  const stored = store.readPreview(plan.previewId, { includePlan: true }).plan
  assert.equal(stored.payload.providers.target.extraHeaders.authorization, SECRET_MASK)
  assert.equal(stored.payload.providers.target.proxy, SECRET_MASK)
  assert.equal(stored.payload.providers.target.sessionHmacSecret, SECRET_MASK)
  assert.equal(stored.payload.providers.target.baseUrl, 'https://example.test/v1')
  assert.equal(stored.payload.providers.target.baseUrlMasked, true)
  assert.equal(stored.payload.providers.target.connections[0].extraHeaders.authorization, SECRET_MASK)
  assert.equal(stored.payload.providers.target.connections[0].proxy, SECRET_MASK)
  assert.equal(stored.payload.providers.target.connections[1].proxy, 'direct')
  assert.deepEqual(stored.payload.providers.target.connections[1].extraHeaders, {})
  assert.equal(stored.payload.providers.bare.proxy, 'direct')
  assert.deepEqual(stored.payload.providers.bare.extraHeaders, {})
  assertNoCanaries(persistedText(dir), INITIAL_SECRETS)

  state.cfg.providers.target.extraHeaders.authorization = 'Bearer rotated-target-header'
  state.cfg.providers.target.proxy = 'http://rotated-target-proxy-user:rotated-target-proxy-password@example.test:8080'
  state.cfg.providers.target.baseUrl = 'https://rotated-target-url-user-canary@example.test/v1?token=rotated-target-query-canary'
  state.cfg.providers.target.sessionHmacSecret = 'rotated-target-session-hmac'
  state.cfg.providers.target.connections[0].extraHeaders.authorization = 'Bearer rotated-target-connection-header'
  state.cfg.providers.target.connections[0].proxy = 'http://rotated-target-connection-proxy-user:rotated-target-connection-proxy-password@example.test:8080'
  state.cfg.providers.target.connections[1].extraHeaders.authorization = 'Bearer rotated-other-connection-header'
  state.cfg.providers.target.connections[1].proxy = 'http://rotated-other-connection-proxy-user:rotated-other-connection-proxy-password@example.test:8080'
  state.cfg.providers.target.connections.reverse()
  state.cfg.providers.other.extraHeaders.authorization = 'Bearer rotated-other-header'
  state.cfg.providers.other.proxy = 'http://other-proxy-user:rotated-other-proxy-password@example.test:8080'
  state.cfg.providers.bare.extraHeaders.authorization = 'Bearer rotated-bare-header'
  state.cfg.providers.bare.proxy = 'http://bare-proxy-user:rotated-bare-proxy-password@example.test:8080'
  state.cfg.providers.bare.baseUrl = 'https://rotated-bare-url-user@example.test/v1?token=rotated-bare-query'
  state.cfg.providers.bare.sessionHmacSecret = 'rotated-bare-session-hmac'
  state.cfg.defaults.extraHeaders.authorization = 'Bearer rotated-defaults-header'
  state.cfg.defaults.proxy = 'http://defaults-proxy-user:rotated-defaults-proxy-password@example.test:8080'
  state.cfg.defaults.sessionHmacSecret = 'rotated-defaults-session-hmac'

  const response = await commit(ctx, 'PATCH', '/api/connections/' + CONNECTION_ID, plan)
  assert.equal(response.status, 200, JSON.stringify(response.body))
  assert.equal(state.writes.length, 1)
  const saved = state.writes[0]
  assert.equal(saved.providers.target.connections[0].displayName, 'after')
  assert.equal(saved.providers.target.extraHeaders.authorization, 'Bearer rotated-target-header')
  assert.equal(saved.providers.target.proxy, 'http://rotated-target-proxy-user:rotated-target-proxy-password@example.test:8080')
  assert.equal(saved.providers.target.baseUrl, 'https://rotated-target-url-user-canary@example.test/v1?token=rotated-target-query-canary')
  assert.equal(saved.providers.target.sessionHmacSecret, 'rotated-target-session-hmac')
  assert.equal(saved.providers.target.connections[0].extraHeaders.authorization, 'Bearer rotated-target-connection-header')
  assert.equal(saved.providers.target.connections[0].proxy, 'http://rotated-target-connection-proxy-user:rotated-target-connection-proxy-password@example.test:8080')
  assert.equal(saved.providers.target.connections[1].extraHeaders.authorization, 'Bearer rotated-other-connection-header')
  assert.equal(saved.providers.target.connections[1].proxy, 'http://rotated-other-connection-proxy-user:rotated-other-connection-proxy-password@example.test:8080')
  const built = buildProvider(state.cfg, 'target', state.cfg.providers.target.connections[0])
  assert.equal(built.extraHeaders.authorization, 'Bearer rotated-target-connection-header')
  assert.equal(built.proxy, 'http://rotated-target-connection-proxy-user:rotated-target-connection-proxy-password@example.test:8080')
  assert.equal(saved.providers.other.extraHeaders.authorization, 'Bearer rotated-other-header')
  assert.equal(saved.providers.other.proxy, 'http://other-proxy-user:rotated-other-proxy-password@example.test:8080')
  assert.equal(saved.providers.bare.extraHeaders.authorization, 'Bearer rotated-bare-header')
  assert.equal(saved.providers.bare.proxy, 'http://bare-proxy-user:rotated-bare-proxy-password@example.test:8080')
  assert.equal(saved.providers.bare.baseUrl, 'https://rotated-bare-url-user@example.test/v1?token=rotated-bare-query')
  assert.equal(saved.providers.bare.sessionHmacSecret, 'rotated-bare-session-hmac')
  assert.equal(saved.defaults, undefined)
  assertNoCanaries(persistedText(dir), [...INITIAL_SECRETS, ...ROTATED_SECRETS])
})

test('global policy plans persist masks and commit restores current defaults secrets', async (t) => {
  const cfg = baseConfig()
  const { ctx, state, store, dir } = fixture(t, cfg)
  const plan = await preview(ctx, {
    action: 'policy.update', expectedVersion: 7, requestId: 'policy-secrets', scopeType: 'global',
    overrides: { requestBudget: { maxTotalAttempts: 9 } },
  })
  const stored = store.readPreview(plan.previewId, { includePlan: true }).plan
  assert.equal(stored.payload.defaults.proxy, SECRET_MASK)
  assert.equal(stored.payload.defaults.extraHeaders.authorization, SECRET_MASK)
  assert.equal(stored.payload.defaults.sessionHmacSecret, SECRET_MASK)
  assertNoCanaries(persistedText(dir), INITIAL_SECRETS)

  state.cfg.defaults.extraHeaders.authorization = 'Bearer rotated-defaults-header'
  state.cfg.defaults.proxy = 'http://defaults-proxy-user:rotated-defaults-proxy-password@example.test:8080'
  state.cfg.defaults.sessionHmacSecret = 'rotated-defaults-session-hmac'
  state.cfg.providers.other.extraHeaders.authorization = 'Bearer rotated-other-header'
  const response = await commit(ctx, 'POST', '/api/policies', plan)
  assert.equal(response.status, 200, JSON.stringify(response.body))
  assert.equal(state.writes[0].defaults.extraHeaders.authorization, 'Bearer rotated-defaults-header')
  assert.equal(state.writes[0].defaults.proxy, 'http://defaults-proxy-user:rotated-defaults-proxy-password@example.test:8080')
  assert.equal(state.writes[0].defaults.sessionHmacSecret, 'rotated-defaults-session-hmac')
  assert.equal(state.writes[0].defaults.requestBudget.maxTotalAttempts, 9)
  assert.deepEqual(state.writes[0].defaults.custom, { keep: true })
  assert.equal(state.writes[0].providers, undefined)
  assertNoCanaries(persistedText(dir), [...INITIAL_SECRETS, ...ROTATED_SECRETS])
})

test('service plans mask HMAC and connection secrets and commit keeps concurrent rotations', async (t) => {
  const cfg = baseConfig()
  cfg.providers.target.baseUrl = 'https://target.example.test/v1'
  const { ctx, state, store, dir } = fixture(t, cfg)
  ctx.method = 'POST'; ctx.path = '/api/config/preview'
  ctx.body = { action: 'service.update', expectedVersion: 7, requestId: 'service-secrets', serviceId: 'target', patch: { displayName: 'after', endpoint: 'http://127.0.0.1:49321/v1', allowPrivateNetwork: true } }
  const previewResponse = await handleServiceApi(ctx)
  assert.equal(previewResponse.status, 200, JSON.stringify(previewResponse.body))
  const plan = previewResponse.body
  const stored = store.readPreview(plan.previewId, { includePlan: true }).plan
  assert.equal(stored.payload.providers.target.sessionHmacSecret, SECRET_MASK)
  assert.equal(stored.payload.providers.target.connections[0].extraHeaders.authorization, SECRET_MASK)
  assert.equal(stored.payload.providers.target.connections[0].proxy, SECRET_MASK)
  assertNoCanaries(persistedText(dir), INITIAL_SECRETS)

  state.cfg.providers.target.sessionHmacSecret = 'rotated-target-session-hmac'
  state.cfg.providers.target.connections[0].extraHeaders.authorization = 'Bearer rotated-target-connection-header'
  state.cfg.providers.target.connections[0].proxy = 'http://rotated-target-connection-proxy-user:rotated-target-connection-proxy-password@example.test:8080'
  state.cfg.providers.target.connections[1].extraHeaders.authorization = 'Bearer rotated-other-connection-header'
  state.cfg.providers.target.connections[1].proxy = 'http://rotated-other-connection-proxy-user:rotated-other-connection-proxy-password@example.test:8080'
  ctx.method = 'PATCH'; ctx.path = '/api/services/target'
  ctx.body = { expectedVersion: plan.expectedVersion, requestId: plan.requestId, previewId: plan.previewId, confirmToken: plan.confirmToken }
  const response = await handleServiceApi(ctx)
  assert.equal(response.status, 200, JSON.stringify(response.body))
  const saved = state.writes[0].providers.target
  assert.equal(saved.baseUrl, 'http://127.0.0.1:49321/v1', 'service endpoint edits remain effective')
  assert.equal(saved.sessionHmacSecret, 'rotated-target-session-hmac')
  assert.equal(saved.connections[0].extraHeaders.authorization, 'Bearer rotated-target-connection-header')
  assert.equal(saved.connections[0].proxy, 'http://rotated-target-connection-proxy-user:rotated-target-connection-proxy-password@example.test:8080')
  assert.equal(saved.connections[1].extraHeaders.authorization, 'Bearer rotated-other-connection-header')
  assert.equal(saved.connections[1].proxy, 'http://rotated-other-connection-proxy-user:rotated-other-connection-proxy-password@example.test:8080')
  assertNoCanaries(persistedText(dir), [...INITIAL_SECRETS, ...ROTATED_SECRETS])
})

test('durable resource previews survive restart and restore HMAC/connection secrets into config', { timeout: 40000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mg-resource-secret-restart-'))
  let gw = null
  t.after(async () => {
    if (gw) await gw.stop()
    rmSync(dir, { recursive: true, force: true })
  })
  gw = await startGateway({ name: 'resource-secret-restart', dir, config: baseConfig() })
  let version = (await (await gw.get('/api/status')).json()).configVersion
  const connectionPreview = await gw.post('/api/config/preview', {
    action: 'connection.update', expectedVersion: version, requestId: 'restart-connection', providerId: 'target',
    connectionId: CONNECTION_ID, patch: { displayName: 'after' },
  })
  assert.equal(connectionPreview.status, 200, JSON.stringify(await connectionPreview.clone().json()))
  const connectionPlan = await connectionPreview.json()
  assertNoCanaries(persistedText(join(dir, 'resource-operations')), INITIAL_SECRETS)
  await gw.stop()
  gw = await startGateway({ name: 'resource-secret-restart', dir, config: baseConfig() })
  let response = await gw.call('/api/connections/' + CONNECTION_ID, { method: 'PATCH', body: { expectedVersion: version, requestId: 'restart-connection', previewId: connectionPlan.previewId, confirmToken: connectionPlan.confirmToken } })
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
  version = (await response.json()).configVersion
  let local = JSON.parse(readFileSync(join(dir, 'gateway.local.json'), 'utf8'))
  assert.equal(local.providers.target.sessionHmacSecret, 'target-session-hmac-canary')
  assert.equal(local.providers.target.connections[0].extraHeaders.authorization, 'Bearer target-connection-header-canary')
  assert.equal(local.providers.target.connections[0].proxy, 'http://target-connection-proxy-user:target-connection-proxy-password-canary@example.test:8080')

  const policyPreview = await gw.post('/api/config/preview', { action: 'policy.update', expectedVersion: version, requestId: 'restart-policy', scopeType: 'global', overrides: { retry: { maxAttempts: 4 } } })
  assert.equal(policyPreview.status, 200, JSON.stringify(await policyPreview.clone().json()))
  const policyPlan = await policyPreview.json()
  assertNoCanaries(persistedText(join(dir, 'resource-operations')), INITIAL_SECRETS)
  await gw.stop()
  gw = await startGateway({ name: 'resource-secret-restart', dir, config: baseConfig() })
  response = await gw.post('/api/policies', { expectedVersion: version, requestId: 'restart-policy', previewId: policyPlan.previewId, confirmToken: policyPlan.confirmToken })
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
  await gw.stop()
  gw = await startGateway({ name: 'resource-secret-restart', dir, config: baseConfig() })
  local = JSON.parse(readFileSync(join(dir, 'gateway.local.json'), 'utf8'))
  assert.equal(local.defaults.sessionHmacSecret, 'defaults-session-hmac-canary')
  assert.equal(local.providers.target.connections[0].extraHeaders.authorization, 'Bearer target-connection-header-canary')
  assert.equal(local.providers.target.connections[0].proxy, 'http://target-connection-proxy-user:target-connection-proxy-password-canary@example.test:8080')
  assert.equal(local.providers.target.connections[0].displayName, 'after')
  assert.equal(local.defaults.retry.maxAttempts, 4)
  const projection = await (await gw.get('/api/config')).json()
  assert.equal(projection.providers.target.sessionHmacSecret, SECRET_MASK)
  assert.equal(projection.providers.target.connections[0].extraHeaders.authorization, SECRET_MASK)
  assert.equal(projection.providers.target.connections[0].proxy, SECRET_MASK)
  assert.equal(projection.defaults.sessionHmacSecret, SECRET_MASK)
  assertNoCanaries(JSON.stringify(projection), INITIAL_SECRETS)
  assertNoCanaries(persistedText(join(dir, 'resource-operations')), INITIAL_SECRETS)
})

test('resource patches reject explicit secret changes and reject plaintext injected into a commit plan', async (t) => {
  const cfg = baseConfig()
  const rejectedConnection = planConnection(cfg, {
    action: 'connection.update', expectedVersion: 7, requestId: 'reject-connection-secret', providerId: 'target',
    connectionId: CONNECTION_ID, patch: { extraHeaders: { authorization: 'explicit-header-canary' } },
  })
  assert.equal(rejectedConnection.status, 400)
  const rejectedPolicy = planPolicy(cfg, {
    action: 'policy.update', expectedVersion: 7, requestId: 'reject-policy-secret', scopeType: 'global',
    overrides: { extraHeaders: { authorization: 'explicit-header-canary' } },
  })
  assert.equal(rejectedPolicy.status, 400)
  assert.equal(rejectedPolicy.code, 'credential_channel_required')

  const tamperedCases = [
    { kind: 'connection', field: 'providerHeader' },
    { kind: 'connection', field: 'providerHmac' },
    { kind: 'connection', field: 'connectionHeader' },
    { kind: 'connection', field: 'connectionProxy' },
    { kind: 'policy', field: 'defaultsHeader' },
    { kind: 'policy', field: 'defaultsHmac' },
  ]
  for (const { kind, field } of tamperedCases) {
    const { ctx, state } = fixture(t, cfg, false)
    const plan = kind === 'connection'
      ? await preview(ctx, { action: 'connection.update', expectedVersion: 7, requestId: 'tampered-connection-' + field, providerId: 'target', connectionId: CONNECTION_ID, patch: { displayName: 'after' } })
      : await preview(ctx, { action: 'policy.update', expectedVersion: 7, requestId: 'tampered-policy-' + field, scopeType: 'global', overrides: { retry: { maxAttempts: 4 } } })
    const entry = ctx.previews.get(plan.confirmToken)
    assert.ok(entry && object(entry.plan.payload))
    if (field === 'providerHeader') entry.plan.payload.providers.target.extraHeaders.authorization = 'explicit-header-canary'
    if (field === 'providerHmac') entry.plan.payload.providers.target.sessionHmacSecret = 'explicit-hmac-canary'
    if (field === 'connectionHeader') entry.plan.payload.providers.target.connections[0].extraHeaders.authorization = 'explicit-connection-header-canary'
    if (field === 'connectionProxy') entry.plan.payload.providers.target.connections[0].proxy = 'http://explicit-connection-proxy-canary@example.test:8080'
    if (field === 'defaultsHeader') entry.plan.payload.defaults.extraHeaders.authorization = 'explicit-header-canary'
    if (field === 'defaultsHmac') entry.plan.payload.defaults.sessionHmacSecret = 'explicit-hmac-canary'
    const response = kind === 'connection'
      ? await commit(ctx, 'PATCH', '/api/connections/' + CONNECTION_ID, plan)
      : await commit(ctx, 'POST', '/api/policies', plan)
    assert.equal(response.status, 400, JSON.stringify(response.body))
    assert.equal(response.body.code, 'credential_channel_required')
    assert.equal(state.writes.length, 0)
  }
})
