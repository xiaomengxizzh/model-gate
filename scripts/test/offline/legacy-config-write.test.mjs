// Legacy /api/config/save and /api/keys must use durable preview/confirm/CAS.
// Synthetic credentials only; inspect operation JSON to prove plaintext never persists.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startGateway } from './harness.mjs'
import { start } from '../../../src/index.js'

const SECRET = 'sk-legacy-preview-must-not-persist-0001'
const HEADER_SECRET = 'header-secret-must-not-persist-0002'
const PROXY_SECRET = 'proxy-secret-must-not-persist-0003'

async function version(gw) {
  return (await (await gw.get('/api/status')).json()).configVersion
}
async function preview(gw, action, body) {
  const response = await gw.post('/api/config/write:preview', { action, expectedVersion: await version(gw), requestId: 'req-' + Math.random().toString(36).slice(2), ...body })
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
  return response.json()
}
function applyBody(plan, payload) {
  return { ...payload, expectedVersion: plan.expectedVersion, requestId: plan.requestId, previewId: plan.previewId, confirmToken: plan.confirmToken }
}
async function operationText(dir) {
  const root = join(dir, 'resource-operations')
  const files = []
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) await walk(child)
      else if (entry.name.endsWith('.json')) files.push(await readFile(child, 'utf8'))
    }
  }
  await walk(root)
  return files.join('\n')
}

test('legacy writes reject direct apply and preview/apply binds payload, CAS and durable receipt', { timeout: 30000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mg-legacy-write-contract-'))
  const gw = await startGateway({ name: 'legacy-write-contract', dir, config: { providers: { mock: { baseUrl: 'http://127.0.0.1:1/v1' } }, models: { demo: { provider: 'mock' } } } })
  t.after(async () => { await gw.stop(); await rm(dir, { recursive: true, force: true }) })
  const before = await version(gw)
  assert.equal((await gw.post('/api/config/save', { version: before, defaults: { proxyMode: 'direct' } })).status, 428)
  assert.equal((await gw.post('/api/keys', { id: 'mock', key: SECRET, version: before })).status, 428)
  assert.equal(await version(gw), before)

  const payload = {
    version: before,
    defaults: { clientKey: SECRET, proxy: 'http://user:' + PROXY_SECRET + '@127.0.0.1:8080', extraHeaders: { authorization: HEADER_SECRET } },
  }
  const plan = await preview(gw, 'config.save', payload)
  assert.equal(plan.action, 'config.save')
  assert.deepEqual(plan.summary.fields, ['defaults'])
  assert.equal(plan.summary.credentialAction, 'REPLACE_WITH_SEALED')
  assert.match(plan.summary.credentialFingerprint, /^[a-f0-9]{64}$/)
  const diskAfterPreview = await operationText(gw.dir)
  for (const secret of [SECRET, HEADER_SECRET, PROXY_SECRET, plan.confirmToken]) assert.equal(diskAfterPreview.includes(secret), false, 'preview JSON must not contain plaintext or token')

  const tampered = await gw.post('/api/config/save', applyBody(plan, { ...payload, defaults: { proxyMode: 'global' } }))
  assert.equal(tampered.status, 409)
  assert.equal((await tampered.json()).code, 'preview_binding_mismatch')
  assert.equal(await version(gw), before)

  const body = applyBody(plan, payload)
  const applied = await gw.post('/api/config/save', body)
  assert.equal(applied.status, 200, JSON.stringify(await applied.clone().json()))
  const receipt = await applied.json()
  assert.equal(receipt.configVersion, before + 1)
  assert.equal(receipt.operation.state, 'succeeded')
  assert.equal(JSON.stringify(receipt).includes(SECRET), false)
  const operation = await (await gw.get('/api/config/write-operations/operations/' + receipt.operation.operationId)).json()
  assert.equal(operation.operation.state, 'succeeded')
  const diskAfterCommit = await operationText(gw.dir)
  for (const secret of [SECRET, HEADER_SECRET, PROXY_SECRET, plan.confirmToken]) assert.equal(diskAfterCommit.includes(secret), false, 'receipt/commit JSON must not contain plaintext or token')

  const replay = await gw.post('/api/config/save', body)
  assert.equal(replay.status, 200)
  assert.deepEqual(await replay.json(), receipt)
  assert.equal(await version(gw), before + 1, 'replay must not increment configVersion')
  const wrongToken = await gw.post('/api/config/save', { ...body, confirmToken: 'x'.repeat(43) })
  assert.equal(wrongToken.status, 409, 'receipt replay is bound to the original confirmation token')
  assert.equal((await wrongToken.json()).code, 'idempotency_conflict')
  const conflict = await gw.post('/api/config/save', { ...body, requestId: 'req-different' })
  assert.equal(conflict.status, 409, 'a consumed preview cannot be rebound to another requestId')

  await gw.stop()
  const restarted = await startGateway({ name: 'legacy-write-restart', dir: gw.dir })
  t.after(() => restarted.stop())
  const restartedReplay = await restarted.post('/api/config/save', body)
  assert.equal(restartedReplay.status, 200)
  assert.deepEqual(await restartedReplay.json(), receipt)
  assert.equal(await version(restarted), before + 1)
})

test('two previews at one version enforce CAS and key preview stores only action/fingerprint', { timeout: 30000 }, async (t) => {
  const gw = await startGateway({ name: 'legacy-write-cas', config: { providers: { mock: { baseUrl: 'http://127.0.0.1:1/v1' } } } })
  t.after(() => gw.stop())
  const v = await version(gw)
  const first = await preview(gw, 'config.save', { defaults: { proxyMode: 'direct' } })
  const second = await preview(gw, 'config.save', { defaults: { proxyMode: 'global' } })
  assert.equal((await gw.post('/api/config/save', applyBody(first, { defaults: { proxyMode: 'direct' } }))).status, 200)
  const stale = await gw.post('/api/config/save', applyBody(second, { defaults: { proxyMode: 'global' } }))
  assert.equal(stale.status, 409)
  const staleBody = await stale.json()
  assert.equal(staleBody.code, 'version_conflict')
  assert.equal(staleBody.currentVersion, v + 1)
  const staleOperation = await (await gw.get('/api/config/write-operations/operations/' + staleBody.operation.operationId)).json()
  assert.equal(staleOperation.operation.state, 'failed')
  assert.equal((await (await gw.get('/api/config')).json()).defaults.proxyMode, 'direct')

  const keyPlan = await preview(gw, 'keys.update', { id: 'mock', key: SECRET })
  assert.equal(keyPlan.summary.credentialAction, 'set')
  assert.match(keyPlan.summary.credentialFingerprint, /^[a-f0-9]{64}$/)
  assert.equal(JSON.stringify(keyPlan).includes(SECRET), false)
  const keyBody = applyBody(keyPlan, { id: 'mock', key: SECRET })
  const keyReceipt = await gw.post('/api/keys', keyBody)
  assert.equal(keyReceipt.status, 200)
  assert.equal(JSON.stringify(await keyReceipt.clone().json()).includes(SECRET), false)
  assert.equal((await operationText(gw.dir)).includes(SECRET), false)
  const wrongKey = await gw.post('/api/keys', { ...keyBody, requestId: 'key-other-request' })
  assert.equal(wrongKey.status, 409)
  const changedKeyPlan = await preview(gw, 'keys.update', { id: 'mock', key: SECRET + '-next' })
  const changed = await gw.post('/api/keys', applyBody(changedKeyPlan, { id: 'mock', key: SECRET + '-different' }))
  assert.equal(changed.status, 409)
  assert.equal((await changed.json()).code, 'preview_binding_mismatch')
})

test('multi-tenancy legacy previews and receipts bind req.mgActor scope and actor', { timeout: 30000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mg-legacy-tenancy-'))
  const reservation = http.createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const port = reservation.address().port
  await new Promise((resolve) => reservation.close(resolve))
  const priorMaster = process.env.MG_KEYS_MASTER
  process.env.MG_KEYS_MASTER = 'isolated-legacy-tenancy-master'
  let gateway = null
  t.after(async () => {
    if (gateway) await gateway.close()
    if (priorMaster === undefined) delete process.env.MG_KEYS_MASTER; else process.env.MG_KEYS_MASTER = priorMaster
    await rm(root, { recursive: true, force: true })
  })
  const rootFile = join(root, 'gateway.json')
  await writeFile(rootFile, JSON.stringify({ server: { host: '127.0.0.1', port, maxBodyBytes: 65536, logFile: join(root, 'control.log') }, tenancy: { mode: 'multi', scopes: ['alpha', 'beta'], root: 'tenants' } }))
  for (const scope of ['alpha', 'beta']) {
    const dir = join(root, 'tenants', scope, 'config')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'gateway.json'), JSON.stringify({ providers: { mock: { baseUrl: 'http://127.0.0.1:1/v1' } }, models: {}, defaults: { proxyMode: 'direct' } }))
  }
  const actors = { alice: { id: 'alice', scopeId: 'alpha', role: 'admin' }, bob: { id: 'bob', scopeId: 'alpha', role: 'admin' }, carol: { id: 'carol', scopeId: 'beta', role: 'admin' } }
  gateway = await start({
    paths: { dir: root, local: join(root, 'gateway.local.json'), keys: join(root, 'keys.local.json') },
    configFile: rootFile, resolveActor: (req) => actors[String(req.headers.authorization || '').replace('Bearer ', '')] || null,
    silent: true, rejectBindFailure: true,
  })
  const base = 'http://127.0.0.1:' + gateway.server.address().port
  const call = async (actor, path, body) => {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + actor, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, body: await response.json() }
  }
  const v = (await call('alice', '/api/status')).body.configVersion
  const created = await call('alice', '/api/config/write:preview', { action: 'keys.update', expectedVersion: v, requestId: 'alice-key', id: 'mock', key: SECRET })
  assert.equal(created.status, 200)
  const body = { id: 'mock', key: SECRET, expectedVersion: v, requestId: created.body.requestId, previewId: created.body.previewId, confirmToken: created.body.confirmToken }
  assert.equal((await call('bob', '/api/keys', body)).status, 428, 'same scope, different actor cannot consume preview')
  assert.equal((await call('carol', '/api/keys', body)).status, 428, 'different scope cannot consume preview')
  const applied = await call('alice', '/api/keys', body)
  assert.equal(applied.status, 200)
  assert.equal(applied.body.operation.scopeId, 'alpha')
  const persisted = await operationText(join(root, 'tenants/alpha/config'))
  assert.match(persisted, /"actorId":"alice"/)
  assert.doesNotMatch(persisted, /"actorId":"bob"/)
  assert.equal(persisted.includes(SECRET), false)
})

test('legacy key commit receipt failure remains committed and replays after restart', { timeout: 30000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mg-legacy-commit-'))
  const config = { providers: { mock: { baseUrl: 'http://127.0.0.1:1/v1' } } }
  let gw = await startGateway({ name: 'legacy-commit-fault', dir, config, env: { MG_OPERATION_STORE_FAULT: 'commit_receipt' } })
  t.after(async () => { await gw.stop(); await rm(dir, { recursive: true, force: true }) })
  const plan = await preview(gw, 'keys.update', { id: 'mock', key: SECRET })
  const body = applyBody(plan, { id: 'mock', key: SECRET })
  const failed = await gw.post('/api/keys', body)
  assert.equal(failed.status, 500)
  const failure = await failed.json()
  assert.equal(failure.code, 'operation_receipt_write_failed')
  assert.deepEqual(failure.details, { outcome: 'committed', commitMarker: true, receipt: 'unknown', cause: 'operation_store_write_failed' })
  assert.equal((await (await gw.get('/api/status')).json()).providers[0].hasKey, true)
  await gw.stop()
  gw = await startGateway({ name: 'legacy-commit-restart', dir, config, env: { MG_OPERATION_STORE_FAULT: '' } })
  const replay = await gw.post('/api/keys', body)
  assert.equal(replay.status, 200)
  assert.equal((await replay.json()).operation.state, 'succeeded')
})
