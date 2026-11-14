// AGG-P05：多用户隔离（离线，默认关闭）。两个完全隔离的作用域，跨读/跨写/跨回退全部拒绝。
// 同时回归单用户默认：缺省 tenancy 时只有 `local`，无 actor 的旧调用仍工作，行为不变。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveTenancy, requireUserScope, createScopeStore, TENANCY_MODES, DEFAULT_SCOPE_ID,
  isTenancyError, sanitizeLogEntry,
} from '../../../src/tenancy/scope.js'
import {
  requireProviderOwnedBy, requirePublishedBindingFor, enforceKeySeparationAndNoSecretsInLogs,
  enforceQuotaAndSafeCancellation, invokeWithoutCrossTenantFallback, buildInvocationContext,
} from '../../../src/tenancy/policy.js'
import { authenticatedOperation, authorizeOperation } from '../../../src/tenancy/index.js'

const MULTI = { tenancy: { mode: 'multi', scopes: ['alpha', 'beta'] } }

function denyOf(fn) {
  try { fn() } catch (e) {
    assert.equal(isTenancyError(e), true, '必须是 typed deny：' + (e && e.code))
    assert.equal(e.deny, true)
    assert.equal(typeof e.code, 'string')
    return e
  }
  assert.fail('预期被拒绝，实际放行')
}

async function denyOfAsync(fn) {
  try { await fn() } catch (e) {
    assert.equal(isTenancyError(e), true, '必须是 typed deny：' + (e && e.code))
    return e
  }
  assert.fail('预期被拒绝，实际放行')
}

// 合成封装：只为证明「本层从不写明文」，不是真实加密。
const seal = (plaintext) => 'sealed:' + Buffer.from(plaintext, 'utf8').toString('base64')
const unseal = (sealed) => Buffer.from(sealed.slice('sealed:'.length), 'base64').toString('utf8')

function provider(id, scopeId, over) {
  return Object.assign({ id, scopeId, authDomain: 'api-key' }, over || {})
}
function binding(publicId, providerId, scopeId, over) {
  return Object.assign({ publicId, providerId, scopeId, published: true, upstreamModelId: 'vendor-model' }, over || {})
}

test('两个作用域完全隔离：配置、凭据、目录、用量、日志互不可读', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mg-tenant-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  const store = createScopeStore(root, { config: MULTI })
  const a = store.forScope(requireUserScope({ id: 'u1', scopeId: 'alpha' }, { config: MULTI }))
  const b = store.forScope(requireUserScope({ id: 'u2', scopeId: 'beta' }, { config: MULTI }))
  await a.ensure(); await b.ensure()

  await a.writeConfig('gateway.json', { marker: 'ALPHA_CONFIG' })
  await a.writeCatalog('catalog.json', { models: [{ publicId: 'mg-alpha-only' }] })
  await a.writeKey('opencodego', 'sk-ALPHA-SECRET', { seal })
  await a.recordUsage({ requests: 3, tokens: 120 })
  await a.logLine({ event: 'request', model: 'mg-alpha-only', tokens: 5, authorization: 'Bearer ALPHA-SECRET' })

  assert.deepEqual(await b.readConfig(), null)
  assert.deepEqual(await b.readCatalog(), null)
  assert.equal(await b.hasKey('opencodego'), false)
  assert.equal(await b.readKey('opencodego', { unseal }), null)
  assert.deepEqual(await b.usage(), { requests: 0, tokens: 0, errors: 0 })
  assert.deepEqual(await b.readLogs(), [])
  assert.equal(JSON.stringify(await b.describe()).includes('ALPHA'), false)

  // 各自的落地文件也互不共享（同一 provider id 不冲突）。
  await b.writeKey('opencodego', 'sk-BETA-SECRET', { seal })
  assert.equal(await a.readKey('opencodego', { unseal }), 'sk-ALPHA-SECRET')
  assert.equal(await b.readKey('opencodego', { unseal }), 'sk-BETA-SECRET')
  const alphaFiles = await readdir(join(root, 'alpha', 'keys'))
  const betaFiles = await readdir(join(root, 'beta', 'keys'))
  assert.deepEqual(alphaFiles, ['opencodego.json'])
  assert.deepEqual(betaFiles, ['opencodego.json'])
  assert.equal((await stat(join(root, 'alpha', 'keys', 'opencodego.json'))).mode & 0o777, 0o600)
  assert.equal((await stat(join(root, 'alpha'))).mode & 0o777, 0o700)
  // 密文文件里没有明文。
  const sealed = await readFile(join(root, 'alpha', 'keys', 'opencodego.json'), 'utf8')
  assert.equal(sealed.includes('sk-ALPHA-SECRET'), false)
})

test('作用域与路径不可伪造：未注册 id、跨级路径、未知域一律拒绝', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mg-tenant-path-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  const store = createScopeStore(root, { config: MULTI })
  assert.equal(denyOf(() => store.forScope({ scopeId: '../alpha' })).code, 'scope_id_invalid')
  assert.equal(denyOf(() => store.forScope({ scopeId: 'gamma' })).code, 'scope_unknown')
  assert.equal(denyOf(() => store.forScope(null)).code, 'scope_invalid')
  assert.equal(denyOf(() => requireUserScope({ scopeId: 'gamma' }, { config: MULTI })).code, 'scope_unknown')
  assert.deepEqual(store.listScopes(), ['alpha', 'beta'])
})

test('默认不保存、不记录任何 secret 或请求正文', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mg-tenant-secret-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  const store = createScopeStore(root, { config: MULTI })
  const a = store.forScope(requireUserScope({ scopeId: 'alpha' }, { config: MULTI }))
  await a.ensure()

  assert.equal((await denyOfAsync(() => a.writeKey('go', 'sk-plain'))).code, 'key_storage_unconfigured')
  await a.writeKey('go', 'sk-plain', { seal })
  assert.equal((await denyOfAsync(() => a.readKey('go'))).code, 'key_storage_unconfigured', '无 unseal 时不得把密文当凭据')

  const line = await a.logLine({
    event: 'request', authorization: 'Bearer SECRET', apiKey: 'sk-SECRET', tokens: 7,
    body: { prompt: 'PRIVATE BODY' }, messages: [{ role: 'user', content: 'PRIVATE' }], history: ['x'],
  })
  assert.equal(JSON.stringify(line).includes('SECRET'), false)
  assert.equal(JSON.stringify(line).includes('PRIVATE'), false)
  assert.equal(line.tokens, 7, '计数不是 secret')
  const logs = JSON.stringify(await a.readLogs())
  assert.equal(logs.includes('PRIVATE'), false)
  assert.equal(logs.includes('SECRET'), false)

  assert.deepEqual(sanitizeLogEntry({ input: 'x', output: 'y', content: 'z', model: 'm' }), { model: 'm' })
})

test('provider 归属、已发布绑定、凭据分离：跨租户一律拒绝', () => {
  const alpha = requireUserScope({ scopeId: 'alpha' }, { config: MULTI })
  const beta = requireUserScope({ scopeId: 'beta' }, { config: MULTI })

  assert.equal(requireProviderOwnedBy(alpha, provider('go', 'alpha')).id, 'go')
  assert.equal(denyOf(() => requireProviderOwnedBy(alpha, provider('go', 'beta'))).code, 'provider_not_owned')
  assert.equal(denyOf(() => requireProviderOwnedBy(alpha, { id: 'go' })).code, 'provider_owner_unknown')
  assert.equal(denyOf(() => requireProviderOwnedBy(alpha, null)).code, 'provider_missing')

  const catalog = { 'mg-alpha-only': binding('mg-alpha-only', 'go', 'alpha'), 'mg-beta-only': binding('mg-beta-only', 'go', 'beta') }
  assert.equal(requirePublishedBindingFor(alpha, provider('go', 'alpha'), 'mg-alpha-only', catalog).publicId, 'mg-alpha-only')
  const cross = denyOf(() => requirePublishedBindingFor(beta, provider('go', 'beta'), 'mg-alpha-only', catalog))
  assert.equal(cross.code, 'binding_cross_scope')
  assert.equal(denyOf(() => requirePublishedBindingFor(beta, provider('go', 'beta'), 'nope', catalog)).status, 404)
  assert.equal(denyOf(() => requirePublishedBindingFor(alpha, provider('go', 'alpha'), 'mg-alpha-only', { 'mg-alpha-only': binding('mg-alpha-only', 'go', 'alpha', { published: false }) })).code, 'binding_not_published')
  assert.equal(denyOf(() => requirePublishedBindingFor(alpha, provider('go', 'alpha'), 'mg-alpha-only', { 'mg-alpha-only': binding('mg-alpha-only', 'go', 'alpha', { authorized: false }) })).code, 'binding_not_authorized')
  assert.equal(denyOf(() => requirePublishedBindingFor(alpha, provider('go', 'alpha'), 'mg-alpha-only', { 'mg-alpha-only': binding('mg-alpha-only', 'other', 'alpha') })).code, 'binding_provider_mismatch')

  assert.deepEqual(
    enforceKeySeparationAndNoSecretsInLogs(alpha, provider('go', 'alpha', { authDomain: 'api-key' }), { authDomain: 'api-key' }),
    { scopeId: 'alpha', providerId: 'go', authDomain: 'api-key' },
  )
  assert.equal(denyOf(() => enforceKeySeparationAndNoSecretsInLogs(alpha, provider('sub', 'alpha', { authDomain: 'codex-subscription' }), { providerKeyPresent: true })).code, 'credential_mixing_subscription_provider_key')
  assert.equal(denyOf(() => enforceKeySeparationAndNoSecretsInLogs(alpha, provider('go', 'alpha'), { authDomain: 'api-key', subscriptionCredentialPresent: true })).code, 'credential_mixing_api_key_subscription')
  assert.equal(denyOf(() => enforceKeySeparationAndNoSecretsInLogs(alpha, provider('go', 'alpha', { authDomain: 'nope' }))).code, 'auth_domain_unknown')
})

test('额度与取消：软阈值不静默放行；取消发生在发送前即终止', () => {
  const alpha = requireUserScope({ scopeId: 'alpha' }, { config: MULTI })
  const p = provider('go', 'alpha')
  const b = binding('mg-alpha-only', 'go', 'alpha')
  assert.doesNotThrow(() => enforceQuotaAndSafeCancellation(alpha, p, b, { limit: 10, used: 9 }))
  assert.equal(denyOf(() => enforceQuotaAndSafeCancellation(alpha, p, b, { limit: 10, used: 10 })).code, 'quota_exceeded')
  assert.equal(denyOf(() => enforceQuotaAndSafeCancellation(alpha, p, b, { limit: 10, used: 10 })).status, 429)
  assert.equal(denyOf(() => enforceQuotaAndSafeCancellation(alpha, p, b, null, { signal: { aborted: true } })).code, 'cancelled_before_send')
})

test('单次调用：不得带 fallback/候选列表；失败不重试、不换 provider', async () => {
  let calls = 0
  const ok = await invokeWithoutCrossTenantFallback(async (ctx) => { calls += 1; return ctx.providerId }, { providerId: 'go' })
  assert.equal(ok, 'go')
  assert.equal(calls, 1)
  assert.equal((await denyOfAsync(() => invokeWithoutCrossTenantFallback(async () => 'x', { providerId: 'go', fallbacks: ['other'] }))).code, 'cross_tenant_fallback_forbidden')
  assert.equal((await denyOfAsync(() => invokeWithoutCrossTenantFallback(async () => 'x', { providers: ['a', 'b'] }))).code, 'cross_tenant_fallback_forbidden')

  const boom = new Error('upstream 401')
  boom.code = 'upstream_unauthorized'
  calls = 0
  await assert.rejects(
    () => invokeWithoutCrossTenantFallback(async () => { calls += 1; throw boom }, { providerId: 'go' }),
    (e) => e === boom,
  )
  assert.equal(calls, 1, '401/403 不触发第二次调用')
})

test('默认上下文不含正文/历史，也不上传', () => {
  const alpha = requireUserScope({ scopeId: 'alpha' }, { config: MULTI })
  const p = provider('go', 'alpha')
  const b = binding('mg-alpha-only', 'go', 'alpha')
  const ctx = buildInvocationContext(alpha, p, b, { body: { prompt: 'SECRET' }, history: [{ role: 'user' }] })
  assert.equal(ctx.body, null)
  assert.equal(ctx.history, null)
  assert.equal(ctx.upload, false)
  assert.equal(ctx.telemetry, 'local-only')
  assert.equal(JSON.stringify(ctx).includes('SECRET'), false)
  assert.equal(buildInvocationContext(alpha, p, b, { allowRequestBody: true, body: { prompt: 'X' } }).body.prompt, 'X')
})

test('默认单用户：只有 local，无 actor 的旧调用不变，其它作用域拒绝', async (t) => {
  assert.equal(resolveTenancy({}).mode, TENANCY_MODES.SINGLE)
  assert.deepEqual(resolveTenancy({}).scopes, [DEFAULT_SCOPE_ID])
  assert.equal(resolveTenancy({ tenancy: { mode: 'single' } }).mode, 'single')
  assert.equal(denyOf(() => resolveTenancy({ tenancy: { mode: 'cluster' } })).code, 'tenancy_mode_invalid')

  assert.equal(requireUserScope(null).scopeId, DEFAULT_SCOPE_ID)
  assert.equal(requireUserScope(undefined).scopeId, DEFAULT_SCOPE_ID)
  assert.equal(requireUserScope({ scopeId: DEFAULT_SCOPE_ID }).scopeId, DEFAULT_SCOPE_ID)
  assert.equal(denyOf(() => requireUserScope({ scopeId: 'alice' })).code, 'scope_not_available_in_single_user_mode')

  const root = await mkdtemp(join(tmpdir(), 'mg-tenant-single-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  const store = createScopeStore(root, {})
  assert.deepEqual(store.listScopes(), [DEFAULT_SCOPE_ID])
  const local = store.forScope(requireUserScope(null))
  await local.ensure()
  await local.writeConfig('gateway.json', { ok: true })
  assert.deepEqual(await local.readConfig(), { ok: true })
  assert.equal(denyOf(() => store.forScope({ scopeId: 'alice' })).code, 'scope_unknown')

  // 旧配置的 provider 没有 scope 字段：单用户下视为 local，不因新增原语而改变行为。
  const legacyProvider = { id: 'opencodego', authDomain: 'api-key' }
  assert.equal(requireProviderOwnedBy(requireUserScope(null), legacyProvider).id, 'opencodego')
  const catalog = { 'mg-opencodego-x': { publicId: 'mg-opencodego-x', providerId: 'opencodego', published: true, upstreamModelId: 'vendor' } }
  const result = await authenticatedOperation(null, 'opencodego', 'mg-opencodego-x', {
    providers: { opencodego: legacyProvider }, catalog, invoke: async (ctx) => ({ model: ctx.modelPublicId, upload: ctx.upload }),
  })
  assert.deepEqual(result.result, { model: 'mg-opencodego-x', upload: false })
  assert.equal(result.scope.scopeId, DEFAULT_SCOPE_ID)
  assert.deepEqual(authorizeOperation(null, 'opencodego', 'mg-opencodego-x', { providers: { opencodego: legacyProvider }, catalog }).logFields,
    { scopeId: DEFAULT_SCOPE_ID, providerId: 'opencodego', authDomain: 'api-key' })
})
