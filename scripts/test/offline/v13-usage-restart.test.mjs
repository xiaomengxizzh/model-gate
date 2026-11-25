import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startGateway, startMockUpstream } from './harness.mjs'

test('用量累计在真实进程重启后保留', { timeout: 30000 }, async (t) => {
  const upstream = await startMockUpstream()
  const dir = mkdtempSync(join(tmpdir(), 'mg-usage-restart-'))
  const config = { providers: { mock: { baseUrl: upstream.base } }, models: { demo: { provider: 'mock' } } }
  let gw = await startGateway({ name: 'usage-restart', dir, config })
  assert.equal((await gw.post('/v1/chat/completions', { model: 'demo', messages: [] })).status, 200)
  await gw.stop()
  gw = await startGateway({ name: 'usage-restart', dir, config })
  t.after(async () => { await gw.stop(); await upstream.stop() })
  const usage = await (await gw.get('/api/usage/summary')).json()
  assert.equal(usage.gateway.logicalRequests, 1)
  assert.equal(usage.gateway.completedRequests, 1)
  assert.equal(usage.gateway.upstreamAttempts, 1)
})
