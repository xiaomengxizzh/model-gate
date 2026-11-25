import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, startScriptedUpstream } from './harness.mjs'

function chat(gw, model) {
  return gw.post('/v1/chat/completions', { model, messages: [{ role: 'user', content: 'in-flight fixture' }] })
}

async function preview(gw, body) {
  const response = await gw.post('/api/config/preview', body)
  return { status: response.status, body: await response.json() }
}

function applyBody(plan) {
  return { expectedVersion: plan.expectedVersion, requestId: plan.requestId, previewId: plan.previewId, confirmToken: plan.confirmToken }
}

test('U04 在途请求：删除预览与确认均阻断，完成后释放且固定代纪不受影响', { timeout: 30000 }, async (t) => {
  let release
  let gate
  const waiting = new Promise((resolve) => { release = resolve })
  const upstream = await startScriptedUpstream(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    gate = release
    await waiting
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'in-flight', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
  })
  t.after(() => upstream.stop())
  const pool = { poolId: 'pool_abcdefghijklmnop', slug: 'mg-pool-abcdefghijklmnop', name: 'active-pool', selection: 'priority', members: [{ model: 'demo', providerId: 'mock' }], directory: [{ model: 'demo', providers: ['mock'] }] }
  const gw = await startGateway({
    name: 'v13-in-flight',
    config: {
      providers: { mock: { baseUrl: upstream.base, allowPrivateNetwork: true } },
      models: { demo: { provider: 'mock' } },
      virtualModels: [pool],
      defaults: { retry: { maxAttempts: 1 }, timeout: { firstByteMs: 5000, idleMs: 5000 }, proxyMode: 'direct' },
    },
  })
  t.after(() => gw.stop())
  const version = (await (await gw.get('/api/status')).json()).configVersion

  const first = chat(gw, 'active-pool')
  while (!gate) await new Promise((resolve) => setTimeout(resolve, 10))
  const serviceDelete = await preview(gw, { action: 'service.delete', expectedVersion: version, requestId: 'service-active', serviceId: 'mock', credentialAction: 'retain' })
  assert.equal(serviceDelete.status, 422)
  assert.equal(serviceDelete.body.code, 'service_in_flight')
  assert.equal(serviceDelete.body.details.count, 1, JSON.stringify(serviceDelete.body))
  const modelDelete = await preview(gw, { action: 'model.delete', expectedVersion: version, requestId: 'model-active', name: 'demo' })
  assert.equal(modelDelete.status, 422)
  assert.equal(modelDelete.body.code, 'model_in_flight')
  const poolDelete = await preview(gw, { action: 'pool.delete', expectedVersion: version, requestId: 'pool-active', poolId: pool.poolId })
  assert.equal(poolDelete.status, 422, JSON.stringify(poolDelete.body))
  assert.equal(poolDelete.body.code, 'pool_in_flight')
  assert.equal(JSON.stringify(serviceDelete.body).includes('in-flight fixture'), false)

  release()
  assert.equal((await first).status, 200)
  const idleService = await preview(gw, { action: 'service.delete', expectedVersion: version, requestId: 'service-idle', serviceId: 'mock', credentialAction: 'retain' })
  assert.equal(idleService.status, 422, 'model reference still blocks service deletion')
  assert.equal(idleService.body.code, 'service_referenced')
  assert.equal(idleService.body.details.inFlight.count, 0)

  await gw.stop()
  await upstream.stop()
  let releaseSecond
  const secondGate = new Promise((resolve) => { releaseSecond = resolve })
  const slow = await startScriptedUpstream(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    await secondGate
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'second', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'second' }, finish_reason: 'stop' }] }))
  })
  t.after(() => slow.stop())
  const raceGw = await startGateway({
    name: 'v13-in-flight-race',
    config: {
      providers: { mock: { baseUrl: slow.base, allowPrivateNetwork: true } },
      models: { demo: { provider: 'mock' } }, virtualModels: [],
      defaults: { retry: { maxAttempts: 1 }, timeout: { firstByteMs: 5000, idleMs: 5000 }, proxyMode: 'direct' },
    },
  })
  t.after(() => raceGw.stop())
  const raceVersion = (await (await raceGw.get('/api/status')).json()).configVersion
  const racePreview = await preview(raceGw, { action: 'model.delete', expectedVersion: raceVersion, requestId: 'model-confirm-race', name: 'demo' })
  assert.equal(racePreview.status, 200)
  const pending = chat(raceGw, 'demo')
  while (slow.hits.length === 0) await new Promise((resolve) => setTimeout(resolve, 10))
  const blocked = await raceGw.call('/api/models/demo', { method: 'DELETE', body: applyBody(racePreview.body) })
  assert.equal(blocked.status, 422, JSON.stringify(await blocked.clone().json()))
  assert.equal((await blocked.json()).code, 'model_in_flight')
  assert.equal((await (await raceGw.get('/api/models/demo')).json()).item.name, 'demo')
  releaseSecond()
  assert.equal((await pending).status, 200)
  const after = await preview(raceGw, { action: 'model.delete', expectedVersion: raceVersion, requestId: 'model-after', name: 'demo' })
  assert.equal(after.status, 200)
  assert.equal(after.body.impact.inFlight.count, 0)
})
