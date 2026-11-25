// Tenant configs may never reference process-environment credentials, including
// nested connections[].apiKeyEnv. Uses an isolated in-process HTTP fixture.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { start } from '../../../src/index.js'

const ENV_NAME = 'SHARED_TENANT_CREDENTIAL'
const CONNECTION_ID = 'conn_0123456789abcdef'

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600 })
}

async function reservePort() {
  const server = http.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

function tenantConfig() {
  return {
    providers: {
      mock: {
        baseUrl: 'http://127.0.0.1:49321',
        connections: [{ connectionId: CONNECTION_ID, displayName: 'Tenant connection', credentialKeyId: CONNECTION_ID }],
      },
    },
    models: {},
    defaults: { proxyMode: 'direct' },
    virtualModels: [],
  }
}

async function fixture(t, initialConfig = tenantConfig()) {
  const root = await mkdtemp(join(tmpdir(), 'mg-tenant-env-'))
  const port = await reservePort()
  const rootFile = join(root, 'gateway.json')
  const tenantFile = join(root, 'tenants/alpha/config/gateway.json')
  await writeJson(rootFile, {
    server: { host: '127.0.0.1', port, maxBodyBytes: 65536, logFile: join(root, 'control.log') },
    tenancy: { mode: 'multi', scopes: ['alpha'], root: 'tenants' },
  })
  await writeJson(tenantFile, initialConfig)
  let gateway = null
  t.after(async () => {
    if (gateway) await gateway.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
  })
  const boot = async () => {
    gateway = await start({
      paths: { dir: root, local: join(root, 'gateway.local.json'), keys: join(root, 'keys.local.json') },
      configFile: rootFile,
      resolveActor: () => ({ id: 'alpha-admin', scopeId: 'alpha', role: 'admin' }),
      silent: true,
      rejectBindFailure: true,
    })
    return 'http://127.0.0.1:' + gateway.server.address().port
  }
  const call = async (base, path, body) => {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: 'Bearer alpha-admin', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: response.status, json: await response.json() }
  }
  return { root, tenantFile, boot, call }
}

test('tenant load fails closed for nested connections[].apiKeyEnv', { timeout: 30000 }, async (t) => {
  const config = tenantConfig()
  config.providers.mock.connections[0].apiKeyEnv = ENV_NAME
  const fx = await fixture(t, config)
  const base = await fx.boot()
  const response = await fx.call(base, '/api/status')
  assert.equal(response.status, 503)
  assert.equal(response.json.code, 'tenant_env_credential_forbidden')
  assert.equal(JSON.stringify(response.json).includes(ENV_NAME), false)
  await assert.rejects(readFile(join(fx.root, 'tenants/alpha/config/gateway.local.json'), 'utf8'), { code: 'ENOENT' })
})

test('tenant reload rejects recursive env references and retains the last valid runtime', { timeout: 30000 }, async (t) => {
  const fx = await fixture(t)
  const base = await fx.boot()
  const before = await fx.call(base, '/api/status')
  assert.equal(before.status, 200)
  const changed = tenantConfig()
  changed.providers.mock.connections[0].apiKeyEnv = ENV_NAME
  await writeJson(fx.tenantFile, changed)
  const rejected = await fx.call(base, '/api/config/reload', {})
  assert.equal(rejected.status, 403)
  assert.equal(rejected.json.code, 'tenant_env_credential_forbidden')
  assert.equal(JSON.stringify(rejected.json).includes(ENV_NAME), false)
  const after = await fx.call(base, '/api/status')
  assert.equal(after.status, 200)
  assert.equal(after.json.configVersion, before.json.configVersion)
  assert.equal(after.json.providers[0].id, 'mock')
})

test('tenant legacy config, service and connection write validation recursively rejects apiKeyEnv', { timeout: 30000 }, async (t) => {
  const fx = await fixture(t)
  const base = await fx.boot()
  const status = await fx.call(base, '/api/status')
  assert.equal(status.status, 200)
  const expectedVersion = status.json.configVersion
  const config = await fx.call(base, '/api/config')
  config.json.providers.mock.connections[0].apiKeyEnv = ENV_NAME
  const legacy = await fx.call(base, '/api/config/write:preview', {
    action: 'config.save', expectedVersion, requestId: 'tenant-env-config', providers: config.json.providers,
  })
  assert.equal(legacy.status, 403)
  assert.equal(legacy.json.code, 'tenant_env_credential_forbidden')
  assert.equal(JSON.stringify(legacy.json).includes(ENV_NAME), false)

  const service = await fx.call(base, '/api/config/preview', {
    action: 'service.create', expectedVersion, requestId: 'tenant-env-service',
    patch: { displayName: 'Forbidden', endpoint: 'http://127.0.0.1:49321', allowPrivateNetwork: true, metadata: { connections: [{ apiKeyEnv: ENV_NAME }] } },
  })
  assert.equal(service.status, 403)
  assert.equal(service.json.code, 'tenant_env_credential_forbidden')

  const connection = await fx.call(base, '/api/config/preview', {
    action: 'connection.update', expectedVersion, requestId: 'tenant-env-connection',
    providerId: 'mock', connectionId: CONNECTION_ID,
    patch: { displayName: 'Forbidden', metadata: { nested: [{ apiKeyEnv: ENV_NAME }] } },
  })
  assert.equal(connection.status, 403)
  assert.equal(connection.json.code, 'tenant_env_credential_forbidden')
  assert.equal((await fx.call(base, '/api/status')).json.configVersion, expectedVersion)
  const persisted = JSON.parse(await readFile(fx.tenantFile, 'utf8'))
  assert.equal(persisted.providers.mock.connections[0].apiKeyEnv, undefined)

  const valid = await fx.call(base, '/api/config/preview', {
    action: 'connection.update', expectedVersion, requestId: 'tenant-valid-connection',
    providerId: 'mock', connectionId: CONNECTION_ID, patch: { displayName: 'Allowed' },
  })
  assert.equal(valid.status, 200, JSON.stringify(valid.json))
})
