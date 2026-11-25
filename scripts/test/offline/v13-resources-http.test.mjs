import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, startMockUpstream } from './harness.mjs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildCatalog } from '../../../src/codex/catalog.js'
import { createRouter } from '../../../src/router.js'

async function preview(gw, body) {
  const response = await gw.post('/api/config/preview', body)
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
  return response.json()
}
async function apply(gw, method, path, plan) {
  const response = await gw.call(path, { method, body: { expectedVersion: plan.expectedVersion, requestId: plan.requestId, previewId: plan.previewId, confirmToken: plan.confirmToken } })
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
  return response.json()
}

test('V13.1 A3/A4：模板、稳定模型与命名池真实 HTTP 生命周期', { timeout: 30000 }, async (t) => {
  const upstream = await startMockUpstream()
  const gw = await startGateway({ name: 'v13-resources', config: { providers: { mock: { baseUrl: upstream.base } } } })
  t.after(async () => { await gw.stop(); await upstream.stop() })
  const templates = await (await gw.get('/api/provider-templates?limit=100')).json()
  assert.equal(templates.total, 63)
  assert.equal(templates.items.length, 63)
  assert.equal(templates.stats.totalModelExamples, 87)
  assert.equal((await gw.get('/api/provider-templates/tpl_opencodego')).status, 200)
  assert.equal((await gw.get('/api/provider-templates/missing')).status, 404)

  let version = (await (await gw.get('/api/status')).json()).configVersion
  const modelPlan = await preview(gw, { action: 'model.create', expectedVersion: version, requestId: 'model-create', patch: { name: 'alpha', providerId: 'mock', upstreamModelId: 'upstream-alpha', displayName: 'Alpha', capability: 'chat', api: 'openai' } })
  assert.match(modelPlan.modelId, /^mdl_/)
  const model = await apply(gw, 'POST', '/api/models', modelPlan)
  assert.equal(model.item.upstreamModelId, 'upstream-alpha')
  version = model.configVersion
  const secondPlan = await preview(gw, { action: 'model.create', expectedVersion: version, requestId: 'model-create-2', patch: { name: 'beta', providerId: 'mock', upstreamModelId: 'upstream-beta' } })
  await apply(gw, 'POST', '/api/models', secondPlan)

  version = (await (await gw.get('/api/status')).json()).configVersion
  const poolPlan = await preview(gw, { action: 'pool.create', expectedVersion: version, requestId: 'pool-create', patch: { name: '日常池', selection: 'priority', members: [{ model: 'beta', priority: 0, weight: 0 }, { model: 'alpha', priority: 1, weight: 0 }], maxContext: 8192 } })
  assert.match(poolPlan.poolId, /^pool_/)
  assert.match(poolPlan.after.slug, /^mg-pool-/)
  const pool = await apply(gw, 'POST', '/api/pools', poolPlan)
  assert.ok(pool.item, JSON.stringify({ pool, list: await (await gw.get('/api/pools')).json(), plan: poolPlan }))
  assert.equal(pool.item.members[0].model, 'beta')
  const storedPool = (await (await gw.get('/api/pools/' + poolPlan.poolId)).json()).item
  assert.equal(storedPool.maxContext, undefined, 'public projection excludes quota/extension fields')
  const editable = await (await gw.get('/api/config')).json()
  editable.virtualModels.find((item) => item.poolId === poolPlan.poolId).customExtension = { kept: true }
  assert.equal((await gw.write('/api/config/save', { version: editable.configVersion, virtualModels: editable.virtualModels })).status, 200)
  const configPool = (await (await gw.get('/api/config')).json()).virtualModels.find((item) => item.poolId === poolPlan.poolId)
  assert.equal(configPool.customExtension.kept, true, 'cleanVms 保留池扩展字段')
  assert.equal(configPool.directory[0].model, 'beta')

  const route = await (await gw.post('/api/route-preview', { model: '日常池' })).json()
  assert.deepEqual(route.hit.directory.map((entry) => entry.model), ['beta', 'alpha'])
  const chat = await gw.post('/v1/chat/completions', { model: '日常池', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(chat.status, 200, await chat.text())
  assert.equal(upstream.hits.at(-1).url, '/v1/chat/completions')

  version = (await (await gw.get('/api/status')).json()).configVersion
  const disablePlan = await preview(gw, { action: 'model.update', expectedVersion: version, requestId: 'disable-alpha', modelId: modelPlan.modelId, patch: { enabled: false } })
  await apply(gw, 'PATCH', '/api/models/' + modelPlan.modelId, disablePlan)
  assert.equal((await (await gw.get('/api/config')).json()).models.alpha.enabled, false)
  assert.equal((await (await gw.get('/v1/models')).json()).data.some((item) => item.id === 'alpha'), false)
  assert.equal((await gw.post('/v1/chat/completions', { model: 'alpha', messages: [] })).status, 404)

  version = (await (await gw.get('/api/status')).json()).configVersion
  const blocked = await gw.post('/api/config/preview', { action: 'model.delete', expectedVersion: version, requestId: 'delete-alpha', modelId: modelPlan.modelId })
  assert.equal(blocked.status, 422)
  assert.deepEqual((await blocked.json()).details.virtualModels, ['日常池'])
})

test('命名池发布到 Codex 目录且 slug 与虚拟模型路由同源', () => {
  const base = JSON.parse(readFileSync(join(process.cwd(), 'config/codex-models-baseline.json'), 'utf8'))
  const cfg = {
    providers: { native: { baseUrl: 'https://example.test/v1', api: 'responses' } },
    models: { demo: { provider: 'native', api: 'responses', maxContext: 8192 } },
    virtualModels: [{ name: '日常池', poolId: 'pool_1234567890123456', slug: 'mg-pool-1234567890123456', enabled: true, members: [{ model: 'demo', providerId: 'native', priority: 0, weight: 0 }], directory: [{ model: 'demo', providers: ['native'] }] }],
  }
  const built = buildCatalog({ base, config: cfg })
  const model = built.catalog.models.find((item) => item.slug === cfg.virtualModels[0].slug)
  assert.ok(model)
  assert.equal(model.context_window, 8192)
  assert.equal(built.meta.bindings[cfg.virtualModels[0].slug], undefined)
  const hit = createRouter(cfg).resolve(cfg.virtualModels[0].slug)
  assert.equal(hit.def.isVirtualModel, true)
  assert.equal(hit.def.name, '日常池')
})
