import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { keysDecrypt } from '../../../src/router.js'
import { startGateway, startMockUpstream } from './harness.mjs'

test('V13.1 A3：真实 HTTP 服务预览→创建→编辑→引用保护→删除凭据→幂等重放', { timeout: 30000 }, async (t) => {
  const upstream = await startMockUpstream()
  const gw = await startGateway({ name: 'v13-services-http', config: {} })
  t.after(async () => { await gw.stop(); await upstream.stop() })
  let version = (await (await gw.get('/api/status')).json()).configVersion

  assert.equal((await gw.get('/api/services')).status, 200)
  assert.equal((await (await gw.get('/api/services')).json()).services.length, 0)
  assert.equal((await gw.get('/api/services/__proto__')).status, 404)
  assert.equal((await gw.get('/api/services/%E0%A4%A')).status, 400)
  const denied = await gw.post('/api/config/preview', { action: 'service.create', expectedVersion: version, requestId: 'denied', patch: { displayName: '本地服务', endpoint: upstream.base } })
  assert.equal(denied.status, 400)
  assert.match((await denied.json()).error, /禁止/)

  const preview = await gw.post('/api/config/preview', { action: 'service.create', expectedVersion: version, requestId: 'create-1', patch: { displayName: '测试服务', endpoint: upstream.base, api: 'openai', allowPrivateNetwork: true } })
  assert.equal(preview.status, 200)
  const plan = await preview.json()
  assert.match(plan.serviceId, /^svc_/)
  assert.equal(plan.requestId, 'create-1')
  const id = plan.serviceId
  const createBody = { expectedVersion: version, requestId: 'create-1', previewId: plan.previewId, confirmToken: plan.confirmToken }
  const stale = await gw.post('/api/services', { ...createBody, expectedVersion: version + 99 })
  assert.equal(stale.status, 409)
  const created = await gw.post('/api/services', createBody)
  assert.equal(created.status, 200)
  const createdBody = await created.json()
  assert.equal(createdBody.service.displayName, '测试服务')
  assert.equal(createdBody.service.serviceId, id)
  version = createdBody.configVersion

  const key = await gw.write('/api/keys', { id, key: 'fixture-service-secret', version })
  assert.equal(key.status, 200)
  version = (await (await gw.get('/api/status')).json()).configVersion
  const editPreview = await gw.post('/api/config/preview', { action: 'service.update', expectedVersion: version, requestId: 'edit-1', serviceId: id, patch: { displayName: '已编辑服务', endpoint: upstream.base, allowPrivateNetwork: true } })
  assert.equal(editPreview.status, 200)
  const editPlan = await editPreview.json()
  const edited = await gw.call('/api/services/' + encodeURIComponent(id), { method: 'PATCH', body: { expectedVersion: version, requestId: 'edit-1', previewId: editPlan.previewId, confirmToken: editPlan.confirmToken } })
  assert.equal(edited.status, 200)
  assert.equal((await edited.json()).service.displayName, '已编辑服务')
  version = (await (await gw.get('/api/status')).json()).configVersion

  const modelSave = await gw.write('/api/config/save', { version, models: { demo: { provider: id } } })
  assert.equal(modelSave.status, 200)
  version = (await (await gw.get('/api/status')).json()).configVersion
  const blocked = await gw.post('/api/config/preview', { action: 'service.delete', expectedVersion: version, requestId: 'delete-blocked', serviceId: id, credentialAction: 'delete' })
  assert.equal(blocked.status, 422)
  assert.deepEqual((await blocked.json()).details.models, ['demo'])

  const removeModel = await gw.write('/api/config/save', { version, models: {} })
  assert.equal(removeModel.status, 200)
  version = (await (await gw.get('/api/status')).json()).configVersion
  const deletePreview = await gw.post('/api/config/preview', { action: 'service.delete', expectedVersion: version, requestId: 'delete-1', serviceId: id, credentialAction: 'delete' })
  assert.equal(deletePreview.status, 200)
  const deletePlan = await deletePreview.json()
  assert.equal(deletePlan.impact.credentialPresent, true)
  const deleteBody = { expectedVersion: version, requestId: 'delete-1', previewId: deletePlan.previewId, confirmToken: deletePlan.confirmToken }
  const deleted = await gw.call('/api/services/' + encodeURIComponent(id), { method: 'DELETE', body: deleteBody })
  assert.equal(deleted.status, 200)
  const deletedBody = await deleted.json()
  assert.equal(deletedBody.service, null)
  assert.equal(deletedBody.configVersion, version + 1)
  const replay = await gw.call('/api/services/' + encodeURIComponent(id), { method: 'DELETE', body: deleteBody })
  assert.equal(replay.status, 200)
  assert.equal((await replay.json()).configVersion, deletedBody.configVersion)
  assert.equal((await gw.get('/api/services/' + encodeURIComponent(id))).status, 404)

  const previousMaster = process.env.MG_KEYS_MASTER
  process.env.MG_KEYS_MASTER = 'isolated-test-master'
  try {
    const keys = keysDecrypt(readFileSync(join(gw.dir, 'keys.local.json'), 'utf8'))
    assert.equal(keys[id], undefined, '删除凭据与配置在同一事务提交')
  } finally {
    if (previousMaster === undefined) delete process.env.MG_KEYS_MASTER
    else process.env.MG_KEYS_MASTER = previousMaster
  }
  assert.equal(upstream.hits.length, 0)
  assert.equal((await gw.get('/api/services', { origin: 'https://evil.test' })).status, 403)
})
