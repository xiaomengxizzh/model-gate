import test from 'node:test'
import assert from 'node:assert/strict'
import { planService, serviceImpact } from '../../../src/resources/services.js'
import { handleServiceApi } from '../../../src/resources/service-api.js'
import { validateEndpointNetwork } from '../../../src/resources/network-policy.js'

const lookup = async () => [{ address: '192.0.2.10', family: 4 }]

function cfg() {
  return {
    configVersion: 3,
    providers: { legacy: { baseUrl: 'https://example.test/v1', displayName: '旧服务' } },
    models: { demo: { provider: 'legacy' } },
    virtualModels: [{ name: 'daily', directory: [{ model: 'demo', providers: ['legacy'] }] }],
    defaults: {},
    _keys: { legacy: 'secret-value' },
  }
}

test('服务资源：创建预览生成稳定 ID、版本绑定且不内联凭据', async () => {
  const out = await planService(cfg(), { action: 'service.create', expectedVersion: 3, requestId: 'r1', patch: { displayName: '新服务', endpoint: 'https://example.test/v1', api: 'openai', region: 'global' } }, { now: 1, lookup })
  assert.equal(out.status, 200)
  assert.match(out.plan.serviceId, /^svc_/)
  assert.equal(out.plan.expectedVersion, 3)
  assert.equal(out.plan.payload.providers[out.plan.serviceId].serviceId, out.plan.serviceId)
  assert.equal(JSON.stringify(out.plan).includes('secret-value'), false)
  assert.match((await validateEndpointNetwork('http://127.0.0.1:8787/v1')).error, /禁止/)
  assert.match((await validateEndpointNetwork('http://169.254.169.254/latest')).error, /禁止/)
  assert.match((await validateEndpointNetwork('file:///etc/passwd')).error, /http/)
})

test('服务资源：过期版本 409、未知服务 404、删除引用 422', async () => {
  assert.equal((await planService(cfg(), { action: 'service.create', expectedVersion: 2, requestId: 'r', patch: {} })).status, 409)
  assert.equal((await planService(cfg(), { action: 'service.update', expectedVersion: 3, requestId: 'r', serviceId: 'missing', patch: {} })).status, 404)
  const removed = await planService(cfg(), { action: 'service.delete', expectedVersion: 3, requestId: 'r', serviceId: 'legacy', credentialAction: 'delete' })
  assert.equal(removed.status, 422)
  assert.equal(removed.code, 'service_referenced')
  assert.deepEqual(removed.details.models, ['demo'])
  assert.deepEqual(removed.details.pools, ['daily'])
})

test('服务资源：无引用删除可选择同事务删除或保留凭据', async () => {
  const base = cfg()
  base.models = {}
  base.virtualModels = []
  const deleted = await planService(base, { action: 'service.delete', expectedVersion: 3, requestId: 'r1', serviceId: 'legacy', credentialAction: 'delete' })
  assert.equal(deleted.status, 200)
  assert.deepEqual(deleted.plan.payload.deleteProviderCredentials, ['legacy'])
  assert.equal(deleted.plan.payload.providers.legacy, undefined)
  const retained = await planService(base, { action: 'service.delete', expectedVersion: 3, requestId: 'r2', serviceId: 'legacy', credentialAction: 'retain' })
  assert.equal(retained.status, 200)
  assert.equal(retained.plan.payload.deleteProviderCredentials, undefined)
  assert.equal(serviceImpact(base, 'legacy').credentialPresent, true)
})

test('服务资源：域名解析到私网时拒绝，显式授权持久化且更新可继承', async () => {
  const body = { action: 'service.create', expectedVersion: 3, requestId: 'private', patch: { displayName: '本地', endpoint: 'http://localhost:8787/v1', allowPrivateNetwork: true } }
  const denied = await planService(cfg(), { ...body, patch: { ...body.patch, allowPrivateNetwork: false } }, { lookup: async () => [{ address: '127.0.0.1', family: 4 }] })
  assert.equal(denied.status, 400)
  assert.equal(denied.code, 'invalid_service')
  const created = await planService(cfg(), body, { lookup: async () => [{ address: '127.0.0.1', family: 4 }] })
  assert.equal(created.status, 200)
  assert.equal(created.plan.payload.providers[created.plan.serviceId].allowPrivateNetwork, true)
  const next = { ...cfg(), providers: created.plan.payload.providers, configVersion: 4 }
  const updated = await planService(next, { action: 'service.update', expectedVersion: 4, requestId: 'inherit', serviceId: created.plan.serviceId, patch: { endpoint: 'http://localhost:8787/v2' } }, { lookup: async () => [{ address: '127.0.0.1', family: 4 }] })
  assert.equal(updated.status, 200)
  assert.equal(updated.plan.payload.providers[created.plan.serviceId].allowPrivateNetwork, true)
  const revoked = await planService(next, { action: 'service.update', expectedVersion: 4, requestId: 'revoke', serviceId: created.plan.serviceId, patch: { allowPrivateNetwork: false } }, { lookup: async () => [{ address: '127.0.0.1', family: 4 }] })
  assert.equal(revoked.status, 400)
})

test('服务资源：DNS 失败在预览阶段失败关闭', async () => {
  const out = await planService(cfg(), { action: 'service.create', expectedVersion: 3, requestId: 'dns', patch: { displayName: '新服务', endpoint: 'https://example.test/v1' } }, { lookup: async () => { throw new Error('DNS failed') } })
  assert.equal(out.status, 400)
  assert.match(out.error, /解析失败/)
})

test('服务资源：预览脱敏继承凭据，确认时从当前配置恢复且不落盘明文', async () => {
  let current = cfg()
  current.providers.legacy.extraHeaders = { Authorization: 'Bearer inherited-header-secret', 'X-Token': 'inherited-token-secret' }
  current.providers.legacy.proxy = 'http://proxy-user:proxy-secret@proxy.example.test:8080'
  let saved = null
  const ctx = {
    method: 'POST', path: '/api/config/preview', body: { action: 'service.update', expectedVersion: 3, requestId: 'redacted-plan', serviceId: 'legacy', patch: { displayName: '改名' } },
    getConfig: () => current,
    saveConfig: async (payload) => { saved = payload; current = { ...current, ...payload, configVersion: 4 }; return {} },
    previews: new Map(), receipts: new Map(), lookup,
  }
  const preview = await handleServiceApi(ctx)
  assert.equal(preview.status, 200)
  const persisted = JSON.stringify(preview.body)
  for (const secret of ['inherited-header-secret', 'inherited-token-secret', 'proxy-user', 'proxy-secret']) assert.equal(persisted.includes(secret), false)
  const applied = await handleServiceApi({ ...ctx, method: 'PATCH', path: '/api/services/legacy', body: {
    expectedVersion: 3, requestId: 'redacted-plan', previewId: preview.body.previewId, confirmToken: preview.body.confirmToken,
  } })
  assert.equal(applied.status, 200, JSON.stringify(applied.body))
  assert.equal(saved.providers.legacy.extraHeaders.Authorization, 'Bearer inherited-header-secret')
  assert.equal(saved.providers.legacy.extraHeaders['X-Token'], 'inherited-token-secret')
  assert.equal(saved.providers.legacy.proxy, current.providers.legacy.proxy)
})

test('服务资源：确认写入前重新解析 DNS，重绑定拒绝且不消耗预览或保存', async () => {
  let current = cfg()
  let saves = 0
  let lookups = 0
  const ctx = {
    method: 'POST', path: '/api/config/preview', body: { action: 'service.create', expectedVersion: 3, requestId: 'rebind', patch: { displayName: '服务', endpoint: 'https://example.test/v1' } },
    getConfig: () => current,
    saveConfig: async (payload) => { saves++; current = { ...current, ...payload, configVersion: 4 }; return {} },
    previews: new Map(), receipts: new Map(), now: 1,
    lookup: async () => [{ address: ++lookups === 1 ? '192.0.2.10' : '127.0.0.1', family: 4 }],
  }
  const preview = await handleServiceApi(ctx)
  assert.equal(preview.status, 200)
  const plan = preview.body
  const write = { method: 'POST', path: '/api/services', body: { expectedVersion: 3, requestId: 'rebind', previewId: plan.previewId, confirmToken: plan.confirmToken } }
  const blocked = await handleServiceApi({ ...ctx, ...write })
  assert.equal(blocked.status, 400)
  assert.equal(blocked.body.code, 'private_address')
  assert.equal(saves, 0)
  assert.equal(ctx.previews.size, 1)
  ctx.lookup = lookup
  const saved = await handleServiceApi({ ...ctx, ...write })
  assert.equal(saved.status, 200)
  assert.equal(saves, 1)
})
