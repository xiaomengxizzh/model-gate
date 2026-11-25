import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { redactProviderForConfig, redactProviderForStatus, redactDefaultsForConfig, restoreConnectionSecrets, restoreDefaultsSecrets, restoreProviderSecrets } from '../../../src/resources/redaction.js'
import { startGateway } from './harness.mjs'

const provider = {
  baseUrl: 'https://example.test/v1?token=url-secret',
  proxy: 'http://user:proxy-secret@example.test:8080',
  extraHeaders: { authorization: 'Bearer header-secret', 'x-safe': 'visible' },
  sessionHmacSecret: 'session-hmac-secret',
  connections: [{ connectionId: 'conn_1234567890123456', extraHeaders: { authorization: 'Bearer connection-header-secret' }, proxy: 'http://user:connection-proxy-secret@example.test:8080' }],
}

test('配置/状态脱敏：不回显 URL、代理或 header 秘密', () => {
  const config = redactProviderForConfig(provider)
  const status = redactProviderForStatus(provider)
  const defaults = redactDefaultsForConfig({ proxy: provider.proxy, extraHeaders: provider.extraHeaders, sessionHmacSecret: provider.sessionHmacSecret })
  const text = JSON.stringify({ config, status, defaults })
  for (const secret of ['url-secret', 'proxy-secret', 'header-secret', 'session-hmac-secret', 'connection-header-secret', 'connection-proxy-secret', 'user:']) assert.equal(text.includes(secret), false, secret)
  assert.equal(config.extraHeaders.authorization, '********')
  assert.equal(config.sessionHmacSecret, '********')
  assert.equal(config.connections[0].extraHeaders.authorization, '********')
  assert.equal(config.connections[0].proxy, '********')
  assert.equal(defaults.sessionHmacSecret, '********')
  assert.equal(status.extraHeaderCount, 2)
  assert.equal(status.proxyConfigured, true)
  assert.equal(config.baseUrlMasked, true)
})

test('掩码回写：未修改秘密保留，修改/删除按用户输入生效', () => {
  const masked = redactProviderForConfig(provider)
  assert.deepEqual(restoreProviderSecrets(masked, provider), provider)
  const changed = { ...masked, extraHeaders: { authorization: '********', 'x-safe': 'new' } }
  const restored = restoreProviderSecrets(changed, provider)
  assert.equal(restored.extraHeaders.authorization, 'Bearer header-secret')
  assert.equal(restored.extraHeaders['x-safe'], 'new')
  assert.equal(restoreProviderSecrets({ ...masked, extraHeaders: {} }, provider).extraHeaders.authorization, undefined)
})

test('HMAC 与连接秘密按当前代际恢复，不依赖预览时的值', () => {
  const masked = redactProviderForConfig(provider)
  const current = {
    ...provider,
    sessionHmacSecret: 'rotated-session-hmac-secret',
    connections: [{ ...provider.connections[0], extraHeaders: { authorization: 'Bearer rotated-connection-header' }, proxy: 'http://user:rotated-connection-proxy@example.test:8080' }],
  }
  const restored = restoreProviderSecrets(masked, current)
  assert.equal(restored.sessionHmacSecret, 'rotated-session-hmac-secret')
  assert.equal(restored.connections[0].extraHeaders.authorization, 'Bearer rotated-connection-header')
  assert.equal(restored.connections[0].proxy, 'http://user:rotated-connection-proxy@example.test:8080')
  assert.equal(restoreConnectionSecrets(masked.connections[0], current.connections[0]).proxy, current.connections[0].proxy)
  const defaults = redactDefaultsForConfig({ sessionHmacSecret: provider.sessionHmacSecret })
  assert.equal(restoreDefaultsSecrets(defaults, { sessionHmacSecret: 'rotated-default-session-hmac' }).sessionHmacSecret, 'rotated-default-session-hmac')
})

test('真实 HTTP：status/config 脱敏且掩码回存不破坏原秘密', { timeout: 20000 }, async (t) => {
  const gw = await startGateway({ name: 'v13-redaction', config: { providers: { mock: provider }, defaults: { proxy: provider.proxy, extraHeaders: provider.extraHeaders, sessionHmacSecret: provider.sessionHmacSecret } } })
  t.after(() => gw.stop())
  const statusText = JSON.stringify(await (await gw.get('/api/status')).json())
  const config = await (await gw.get('/api/config')).json()
  const configText = JSON.stringify(config)
  for (const secret of ['url-secret', 'proxy-secret', 'header-secret', 'session-hmac-secret', 'connection-header-secret', 'connection-proxy-secret']) {
    assert.equal(statusText.includes(secret), false)
    assert.equal(configText.includes(secret), false)
  }
  const version = config.configVersion
  // Defaults HMAC commit is exercised through the resource policy path; this
  // legacy save checks provider/connection masks without rewriting that field.
  const saved = await gw.write('/api/config/save', { version, providers: config.providers, defaults: { proxy: config.defaults.proxy, extraHeaders: config.defaults.extraHeaders } })
  assert.equal(saved.status, 200)
  const reloaded = await (await gw.get('/api/config')).json()
  assert.equal(reloaded.providers.mock.extraHeaders.authorization, '********')
  assert.equal(reloaded.providers.mock.sessionHmacSecret, '********')
  assert.equal(reloaded.providers.mock.connections[0].extraHeaders.authorization, '********')
  assert.equal(reloaded.providers.mock.connections[0].proxy, '********')
  assert.equal(reloaded.defaults.proxy, '********')
  assert.equal(reloaded.defaults.sessionHmacSecret, '********')
  const local = JSON.parse(readFileSync(join(gw.dir, 'gateway.local.json'), 'utf8'))
  assert.equal(local.providers.mock.sessionHmacSecret, provider.sessionHmacSecret)
  assert.equal(local.providers.mock.connections[0].extraHeaders.authorization, 'Bearer connection-header-secret')
  assert.equal(local.providers.mock.connections[0].proxy, provider.connections[0].proxy)
  assert.equal(local.defaults.sessionHmacSecret, provider.sessionHmacSecret)
  assert.equal((await gw.get('/api/status')).status, 200)
})
