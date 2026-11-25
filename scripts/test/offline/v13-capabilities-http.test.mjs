import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, startMockUpstream } from './harness.mjs'

test('V13.1 A2：真实隔离 HTTP 能力投影、静态预览与旧入口并存', { timeout: 30000 }, async (t) => {
  const upstream = await startMockUpstream()
  const gw = await startGateway({
    name: 'v13-capabilities-http',
    env: { MG_BUILD_SHA: '48325bf0027e583108c66677c7dec15fd5007228' },
    config: {
      providers: { mock: { baseUrl: upstream.base, extraHeaders: { authorization: 'Bearer canary-secret' }, proxy: 'http://u:p@127.0.0.1:9999' } },
      models: { demo: { provider: 'mock' }, disabled: { provider: 'mock', enabled: false } },
      virtualModels: [{ name: 'daily', directory: [{ model: 'demo' }] }],
    },
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const response = await gw.get('/api/capabilities')
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /application\/json/)
  const body = await response.json()
  assert.equal(body.contract, 'mg-capabilities/1')
  assert.equal(body.build.commitSha, '48325bf0027e583108c66677c7dec15fd5007228')
  assert.equal(body.navigation.primary.length, 6)
  assert.equal(body.services.length, 1)
  assert.equal(body.models.length, 2)
  assert.equal(body.pools[0].candidateCount, 1)
  assert.equal(body.ui.writeOperations, false)
  const text = JSON.stringify(body)
  for (const secret of ['canary-secret', 'http://u:p', 'extraHeaders']) assert.equal(text.includes(secret), false)
  assert.equal(upstream.hits.length, 0, '只读 capabilities 不触发上游')

  assert.equal((await gw.call('/api/capabilities', { method: 'HEAD' })).status, 200)
  assert.equal((await gw.post('/api/capabilities', {})).status, 404)
  assert.equal((await gw.get('/api/capabilities', { origin: 'https://evil.test' })).status, 403)

  for (const path of ['/ui-vnext', '/ui-vnext/', '/ui-vnext/app.js', '/ui-vnext/styles.css']) {
    const asset = await gw.get(path)
    assert.equal(asset.status, 200, path)
    assert.equal(asset.headers.get('cache-control'), 'no-store')
    assert.match(asset.headers.get('content-security-policy'), /script-src 'self'/)
  }
  assert.equal((await gw.get('/ui-vnext/%2e%2e/index.js')).status, 404)
  const root = await fetch(gw.base + '/', { redirect: 'manual' })
  assert.equal(root.status, 302)
  assert.equal(root.headers.get('location'), '/ui-vnext/')
  assert.equal((await gw.get('/ui-next/')).status, 200)
  assert.equal((await gw.get('/healthz')).status, 200)
})
