import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway } from './harness.mjs'

const TOKEN = 'ui-contract-token'
const AUTH = { authorization: 'Bearer ' + TOKEN }

function seedConfig () {
  return {
    defaults: { proxyMode: 'direct', clientKey: '', affinityTtlMs: 4321 },
    providers: {
      mock: {
        baseUrl: 'http://127.0.0.1:1',
        api: 'openai',
        apiKeyEnv: '',
        extraHeaders: { 'x-session-id': 'session-abc' },
        pluginField: { keep: true },
      },
    },
    models: {
      demo: { provider: 'mock', capability: 'chat', alias: ['demo-alias'], pluginModelField: 'keep-me' },
    },
    virtualModels: [{
      name: 'gatemodel', directory: [{ model: 'demo', mode: 'afterAll', providers: ['mock'] }],
      quota: 0, dailyQuota: 0, maxContext: 0, maxConcurrent: 0, qps: 0,
    }],
  }
}

test('UI contract: /api/config is editable, lossless and versioned', { timeout: 30000 }, async (t) => {
  const gw = await startGateway({ name: 'ui-contract', env: { MG_ADMIN_TOKEN: TOKEN }, config: seedConfig() })
  t.after(() => gw.stop())

  const first = await gw.get('/api/config', AUTH)
  assert.equal(first.status, 200)
  const cfg = await first.json()
  assert.equal(typeof cfg.configVersion, 'number')
  assert.equal(cfg.providers.mock.pluginField.keep, true, 'unknown provider fields preserved')
  assert.equal(cfg.models.demo.pluginModelField, 'keep-me', 'unknown model fields preserved')
  assert.equal(cfg.defaults.affinityTtlMs, 4321, 'unknown defaults preserved')
  assert.equal(cfg.virtualModels[0].expiresAt, '', 'virtual expiresAt projected')
  assert.equal(cfg.virtualModels[0].note, '', 'virtual note projected')
  assert.equal(cfg.virtualModels[0].expiresAtState, 'none', 'virtual expiresAtState projected by backend')
  assert.equal(cfg.virtualModels[0].expiresAtMs, null, 'virtual expiresAtMs projected by backend')
  assert.equal(Object.hasOwn(cfg.providers.mock, 'hasKey'), false)
  assert.equal(Object.hasOwn(cfg.providers.mock, 'st'), false)
  assert.equal(Object.hasOwn(cfg, '_keys'), false)

  // Edit the projection in place (as the UI does), add virtual metadata and save with the version.
  cfg.virtualModels[0].expiresAt = '2026-12-31'
  cfg.virtualModels[0].note = 'ui-contract'
  cfg.models.demo.alias = ['demo-alias', 'demo-2']
  const save = await gw.post('/api/config/save', {
    version: cfg.configVersion,
    providers: cfg.providers,
    models: cfg.models,
    defaults: cfg.defaults,
    virtualModels: cfg.virtualModels,
  }, AUTH)
  assert.equal(save.status, 200)
  const saved = await save.json()
  assert.equal(saved.ok, true)
  assert.ok(saved.status.configVersion > cfg.configVersion)

  const second = await (await gw.get('/api/config', AUTH)).json()
  assert.equal(second.virtualModels[0].expiresAt, '2026-12-31', 'expiresAt survives round-trip')
  assert.equal(second.virtualModels[0].note, 'ui-contract', 'note survives round-trip')
  assert.deepEqual(second.models.demo.alias, ['demo-alias', 'demo-2'])
  assert.equal(second.providers.mock.pluginField.keep, true)
  assert.equal(second.defaults.affinityTtlMs, 4321)

  // Stale version must 409 and must not write.
  const stale = await gw.post('/api/config/save', { version: cfg.configVersion, defaults: { proxyMode: 'auto' } }, AUTH)
  assert.equal(stale.status, 409)
  const conflict = await stale.json()
  assert.equal(conflict.currentVersion, second.configVersion)
  const third = await (await gw.get('/api/config', AUTH)).json()
  assert.equal(third.configVersion, second.configVersion, '409 did not advance version')
  assert.equal(third.defaults.proxyMode, 'direct', '409 did not change configuration')
})

test('UI contract: secrets never echoed and keys are versioned separately', { timeout: 30000 }, async (t) => {
  const gw = await startGateway({ name: 'ui-secrets', env: { MG_ADMIN_TOKEN: TOKEN }, config: seedConfig() })
  t.after(() => gw.stop())
  const before = await (await gw.get('/api/config', AUTH)).json()
  const keySave = await gw.post('/api/keys', { id: 'mock', key: 'sk-ui-contract-secret-9000', version: before.configVersion }, AUTH)
  assert.equal(keySave.status, 200)
  const after = await (await gw.get('/api/config', AUTH)).json()
  assert.ok(after.configVersion > before.configVersion, 'key save advances configVersion')

  const status = await (await gw.get('/api/status', AUTH)).json()
  const provider = status.providers.find((p) => p.id === 'mock')
  assert.equal(provider.hasKey, true)
  assert.equal(provider.keyOk, undefined)
  const statusText = JSON.stringify(status)
  assert.equal(statusText.includes('sk-ui-contract-secret-9000'), false, 'status must not echo the key')
  assert.equal(JSON.stringify(after).includes('sk-ui-contract-secret-9000'), false, 'config projection must not echo the key')

  // clientKey is write-only: masked on read, not stored in plaintext in the projection.
  const cfg = await (await gw.get('/api/config', AUTH)).json()
  cfg.defaults.clientKey = 'client-secret-value-42'
  const saved = await gw.post('/api/config/save', { version: cfg.configVersion, defaults: cfg.defaults }, AUTH)
  assert.equal(saved.status, 200)
  const reread = await (await gw.get('/api/config', AUTH)).json()
  assert.equal(reread.defaults.clientKey, '********', 'clientKey masked on read')
  assert.equal(JSON.stringify(reread).includes('client-secret-value-42'), false)
})
