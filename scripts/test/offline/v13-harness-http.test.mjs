import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startGateway } from './harness.mjs'

test('Harness HTTP：隔离根目录预览→应用→回滚，默认无写入权限', { timeout: 30000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mg-harness-http-'))
  const home = join(dir, 'home')
  mkdirSync(join(home, '.claude'), { recursive: true })
  const original = JSON.stringify({ env: { KEEP: 'yes' }, permissions: { allow: ['Read'] } }, null, 2)
  writeFileSync(join(home, '.claude/settings.json'), original)
  const gw = await startGateway({ name: 'v13-harness-http', dir, env: { HOME: home, MG_HARNESS_ROOT: home } })
  t.after(() => gw.stop())
  const list = await (await gw.get('/api/harnesses')).json()
  assert.equal(list.writesEnabled, true)
  const xmxz = list.adapters.find((item) => item.harnessId === 'xmxz')
  assert.equal(xmxz.status, 'unsupported')
  assert.equal(xmxz.config, null)
  assert.match(xmxz.reason, /owner config 完整 schema\/加载器缺失/)
  const preview = await gw.post('/api/harnesses/preview', { harnessId: 'claude-code', endpoint: 'http://127.0.0.1:8787', apiKeyEnv: 'MODELGATE_API_KEY', requestId: 'h1' })
  assert.equal(preview.status, 200, JSON.stringify(await preview.clone().json()))
  const plan = await preview.json()
  assert.equal(plan.realProtocol, 'not-real-tested')
  const applied = await gw.post('/api/harnesses/apply', { confirmToken: plan.confirmToken, requestId: 'h1' })
  assert.equal(applied.status, 200, JSON.stringify(await applied.clone().json()))
  const text = readFileSync(join(home, '.claude/settings.json'), 'utf8')
  assert.match(text, /ANTHROPIC_BASE_URL/)
  assert.equal(text.includes('MODELGATE_API_KEY'), true)
  assert.equal(text.includes('apiKey'), false)
  const rolled = await gw.post('/api/harnesses/rollback', { backupId: plan.backupId, harnessId: 'claude-code' })
  assert.equal(rolled.status, 200, JSON.stringify(await rolled.clone().json()))
  assert.equal(readFileSync(join(home, '.claude/settings.json'), 'utf8'), original)

  const locked = await startGateway({ name: 'v13-harness-locked', env: { HOME: home, MG_HARNESS_ROOT: '' } })
  t.after(() => locked.stop())
  assert.equal((await locked.post('/api/harnesses/preview', { harnessId: 'claude-code', endpoint: 'http://127.0.0.1:8787' })).status, 403)
  assert.equal(existsSync(join(home, '.claude/settings.json')), true)
})
