import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { startGateway } from './harness.mjs'

test('V13.1 A6：真实 HTTP 脱敏备份、导入预览/应用与回执', { timeout: 30000 }, async (t) => {
  const gw = await startGateway({ name: 'v13-backup-http', config: { providers: { mock: { baseUrl: 'https://example.test/v1', extraHeaders: { authorization: 'Bearer backup-secret' } } }, models: { demo: { provider: 'mock' } }, defaults: { proxyMode: 'direct' } } })
  t.after(() => gw.stop())
  await gw.write('/api/keys', { id: 'mock', key: 'fixture-key' })
  const created = await gw.post('/api/config/backups', {})
  assert.equal(created.status, 200, JSON.stringify(await created.clone().json()))
  const item = (await created.json()).item
  const backupResponse = await gw.get('/api/config/backups/' + item.backupId)
  assert.equal(backupResponse.status, 200)
  const backupText = await backupResponse.text()
  assert.equal(backupText.includes('backup-secret'), false)
  assert.equal(backupText.includes('fixture-key'), false)
  const files = readdirSync(join(gw.dir, 'backups'))
  assert.equal(files.length, 1)
  assert.equal(readFileSync(join(gw.dir, 'backups', files[0]), 'utf8').includes('backup-secret'), false)

  let version = (await (await gw.get('/api/status')).json()).configVersion
  assert.equal((await gw.write('/api/config/save', { version, defaults: { proxyMode: 'global' } })).status, 200)
  version = (await (await gw.get('/api/status')).json()).configVersion
  const backup = (await (await gw.get('/api/config/backups/' + item.backupId)).json()).item
  const preview = await gw.post('/api/config/import:preview', { backup, expectedVersion: version })
  assert.equal(preview.status, 200, JSON.stringify(await preview.clone().json()))
  const plan = await preview.json()
  assert.ok(plan.diff.updated.some((entry) => entry.path === '/defaults/proxyMode'))
  const applyBody = { planId: plan.planId, confirmToken: plan.confirmToken, expectedVersion: version, requestId: 'import-1' }
  const applied = await gw.post('/api/config/import:apply', applyBody)
  assert.equal(applied.status, 200, JSON.stringify(await applied.clone().json()))
  assert.equal((await (await gw.get('/api/config')).json()).defaults.proxyMode, 'direct')
  assert.equal((await (await gw.get('/api/status')).json()).providers[0].hasKey, true)
  const replay = await gw.post('/api/config/import:apply', applyBody)
  assert.equal(replay.status, 200)
  assert.equal((await replay.json()).configVersion, (await applied.json()).configVersion)
  assert.equal((await gw.post('/api/config/import:preview', { backup: { schema: 'bad' }, expectedVersion: version })).status, 400)
})
