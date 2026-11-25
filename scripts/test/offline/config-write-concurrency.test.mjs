// Confirmed writes must compare expectedVersion only after entering the global
// config write lock. Synthetic fixtures only; no production config or upstream.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startGateway } from './harness.mjs'
import { keysDecrypt } from '../../../src/router.js'

async function version(gw) {
  return (await (await gw.get('/api/status')).json()).configVersion
}

async function preview(gw, body) {
  const response = await gw.post('/api/config/preview', body)
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
  return response.json()
}

function applyBody(plan) {
  return {
    expectedVersion: plan.expectedVersion,
    requestId: plan.requestId,
    previewId: plan.previewId,
    confirmToken: plan.confirmToken,
  }
}

function assertOneWinner(responses, expectedVersion) {
  assert.equal(responses.filter((response) => response.status === 200).length, 1)
  assert.equal(responses.filter((response) => response.status === 409).length, responses.length - 1)
  const winner = responses.find((response) => response.status === 200)
  const loser = responses.find((response) => response.status === 409)
  assert.equal(winner.json.configVersion, expectedVersion + 1)
  for (const response of responses.filter((entry) => entry.status === 409)) {
    assert.equal(response.json.code, 'version_conflict')
    assert.equal(response.json.currentVersion ?? response.json.details?.currentVersion, expectedVersion + 1)
  }
  return { winner: winner.json, loser: loser.json }
}

test('concurrent confirmed service creates cannot both overwrite the same snapshot', { timeout: 30000 }, async (t) => {
  const gw = await startGateway({ name: 'cas-service-concurrency', config: {} })
  t.after(() => gw.stop())
  const expectedVersion = await version(gw)
  const plans = []
  for (const index of [0, 1, 2, 3, 4, 5, 6, 7]) {
    plans.push(await preview(gw, {
      action: 'service.create', expectedVersion, requestId: 'service-race-' + index,
      patch: { displayName: 'Service ' + index, endpoint: 'http://127.0.0.1:' + (49321 + index), allowPrivateNetwork: true },
    }))
  }
  const responses = await Promise.all(plans.map((plan) => gw.post('/api/services', applyBody(plan)).then(async (response) => ({ status: response.status, json: await response.json() }))))
  const { winner } = assertOneWinner(responses, expectedVersion)
  const services = (await (await gw.get('/api/services')).json()).services
  assert.equal(services.length, 1)
  assert.equal(services[0].serviceId, winner.service.serviceId)
  assert.equal(await version(gw), expectedVersion + 1)
  const persisted = JSON.parse(readFileSync(join(gw.dir, 'gateway.local.json'), 'utf8'))
  assert.deepEqual(Object.keys(persisted.providers), [winner.service.serviceId])
  assert.equal(persisted.configVersion, expectedVersion + 1)
})

test('concurrent confirmed connection updates cannot restore the losing snapshot', { timeout: 30000 }, async (t) => {
  const connectionId = 'conn_0123456789abcdef'
  const gw = await startGateway({
    name: 'cas-connection-concurrency',
    config: { providers: { mock: { baseUrl: 'http://127.0.0.1:49321', connections: [{ connectionId, displayName: 'Before', credentialKeyId: connectionId }] } } },
  })
  t.after(() => gw.stop())
  const expectedVersion = await version(gw)
  const plans = []
  for (const index of [0, 1, 2, 3, 4, 5, 6, 7]) {
    plans.push(await preview(gw, {
      action: 'connection.update', expectedVersion, requestId: 'connection-race-' + index,
      providerId: 'mock', connectionId, patch: { displayName: 'Winner ' + index },
    }))
  }
  const responses = await Promise.all(plans.map((plan) => gw.call('/api/connections/' + connectionId, { method: 'PATCH', body: applyBody(plan) }).then(async (response) => ({ status: response.status, json: await response.json() }))))
  const { winner } = assertOneWinner(responses, expectedVersion)
  const item = (await (await gw.get('/api/connections/' + connectionId)).json()).item
  assert.equal(item.displayName, winner.item.displayName)
  assert.equal(await version(gw), expectedVersion + 1)
  const persisted = JSON.parse(readFileSync(join(gw.dir, 'gateway.local.json'), 'utf8'))
  assert.equal(persisted.providers.mock.connections[0].displayName, winner.item.displayName)
  assert.equal(persisted.configVersion, expectedVersion + 1)
})

test('concurrent confirmed legacy key writes persist only the CAS winner', { timeout: 30000 }, async (t) => {
  const gw = await startGateway({ name: 'cas-legacy-key-concurrency', config: { providers: { mock: { baseUrl: 'http://127.0.0.1:49321' } } } })
  t.after(() => gw.stop())
  const expectedVersion = await version(gw)
  const secrets = Array.from({ length: 8 }, (_, index) => 'sk-cas-winner-' + index + '-0001')
  const plans = []
  for (const [index, key] of secrets.entries()) {
    const response = await gw.post('/api/config/write:preview', {
      action: 'keys.update', expectedVersion, requestId: 'key-race-' + index, id: 'mock', key,
    })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    plans.push(await response.json())
  }
  const responses = await Promise.all(plans.map((plan, index) => gw.post('/api/keys', { ...applyBody(plan), id: 'mock', key: secrets[index] }).then(async (response) => ({ status: response.status, json: await response.json() }))))
  const { winner } = assertOneWinner(responses, expectedVersion)
  assert.equal(winner.configVersion, expectedVersion + 1)
  assert.equal(await version(gw), expectedVersion + 1)
  const priorMaster = process.env.MG_KEYS_MASTER
  process.env.MG_KEYS_MASTER = 'isolated-test-master'
  try {
    const keys = keysDecrypt(readFileSync(join(gw.dir, 'keys.local.json'), 'utf8'))
    const winnerIndex = responses.findIndex((response) => response.status === 200)
    assert.equal(keys.mock, secrets[winnerIndex])
  } finally {
    if (priorMaster === undefined) delete process.env.MG_KEYS_MASTER
    else process.env.MG_KEYS_MASTER = priorMaster
  }
  const persisted = JSON.parse(readFileSync(join(gw.dir, 'gateway.local.json'), 'utf8'))
  assert.equal(persisted.configVersion, expectedVersion + 1)
})
