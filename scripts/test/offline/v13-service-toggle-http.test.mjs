import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, startMockUpstream } from './harness.mjs'

test('服务启停：真实 HTTP 停用后模型隐藏且零上游，启用后恢复', { timeout: 20000 }, async (t) => {
  const upstream = await startMockUpstream()
  const gw = await startGateway({ name: 'v13-service-toggle', config: { providers: { mock: { baseUrl: upstream.base, allowPrivateNetwork: true } }, models: { demo: { provider: 'mock' } } } })
  t.after(async () => { await gw.stop(); await upstream.stop() })
  let version = (await (await gw.get('/api/status')).json()).configVersion
  const preview = await gw.post('/api/config/preview', { action: 'service.update', expectedVersion: version, requestId: 'disable', serviceId: 'mock', patch: { enabled: false } })
  assert.equal(preview.status, 200)
  const plan = await preview.json()
  const applied = await gw.call('/api/services/mock', { method: 'PATCH', body: { expectedVersion: version, requestId: 'disable', previewId: plan.previewId, confirmToken: plan.confirmToken } })
  assert.equal(applied.status, 200)
  assert.equal((await (await gw.get('/v1/models')).json()).data.some((item) => item.id === 'demo'), false)
  assert.equal((await gw.post('/v1/chat/completions', { model: 'demo', messages: [] })).status, 404)
  assert.equal(upstream.hits.length, 0)
  version = (await (await gw.get('/api/status')).json()).configVersion
  const enablePreview = await gw.post('/api/config/preview', { action: 'service.update', expectedVersion: version, requestId: 'enable', serviceId: 'mock', patch: { enabled: true } })
  const enablePlan = await enablePreview.json()
  assert.equal((await gw.call('/api/services/mock', { method: 'PATCH', body: { expectedVersion: version, requestId: 'enable', previewId: enablePlan.previewId, confirmToken: enablePlan.confirmToken } })).status, 200)
  assert.equal((await gw.post('/v1/chat/completions', { model: 'demo', messages: [] })).status, 200)
  assert.equal(upstream.hits.length, 1)
})
