import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startGateway } from './harness.mjs'
import { createOperationStore } from '../../../src/resources/operation-store.js'
import { handleServiceApi } from '../../../src/resources/service-api.js'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mg-operation-http-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function files(root) {
  const out = []
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) visit(path)
      else out.push(path)
    }
  }
  visit(root)
  return out
}

async function servicePreview(gw, body) {
  const response = await gw.post('/api/config/preview', body)
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
  return response.json()
}

function serviceBody(plan, extra = {}) {
  return { expectedVersion: plan.expectedVersion, requestId: plan.requestId, previewId: plan.previewId, confirmToken: plan.confirmToken, ...extra }
}

async function modelPreview(gw, requestId, name) {
  const version = (await (await gw.get('/api/status')).json()).configVersion
  const response = await gw.post('/api/config/preview', {
    action: 'model.create', expectedVersion: version, requestId,
    patch: { name, providerId: 'mock', upstreamModelId: 'upstream-' + name },
  })
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
  return response.json()
}

function modelBody(plan) {
  return { expectedVersion: plan.expectedVersion, requestId: plan.requestId, previewId: plan.previewId, confirmToken: plan.confirmToken }
}

function fingerprint(method, path, body) {
  return createHash('sha256').update(JSON.stringify({ method, path, body })).digest('hex')
}

test('持久服务操作：重启重放、冲突、一次性确认、过期与已提交取消', { timeout: 30000 }, async (t) => {
  const dir = fixture(t)
  const config = {}
  let gw = await startGateway({ name: 'operation-service', dir, config })
  t.after(() => gw.stop())
  const plan = await servicePreview(gw, {
    action: 'service.create', expectedVersion: 0, requestId: 'service-durable',
    patch: { displayName: 'Durable', endpoint: 'http://127.0.0.1:49321', allowPrivateNetwork: true },
  })
  const body = serviceBody(plan)
  const applied = await gw.post('/api/services', body)
  assert.equal(applied.status, 200, JSON.stringify(await applied.clone().json()))
  const first = await applied.json()
  assert.equal(first.operation.state, 'succeeded')
  assert.match(first.operation.operationId, /^op_[A-Za-z0-9_-]{43}$/)
  const failedPlan = await servicePreview(gw, {
    action: 'service.update', expectedVersion: first.configVersion, requestId: 'service-failed-replay', serviceId: plan.serviceId,
    patch: { displayName: 'Durable' },
  })
  const noopPlan = await servicePreview(gw, {
    action: 'service.update', expectedVersion: first.configVersion, requestId: 'service-noop', serviceId: plan.serviceId,
    patch: { displayName: 'Intermediate' },
  })
  const noop = await gw.call('/api/services/' + plan.serviceId, { method: 'PATCH', body: serviceBody(noopPlan) })
  assert.equal(noop.status, 200)
  const currentVersion = (await noop.json()).configVersion
  const failedBody = serviceBody(failedPlan)
  const failed = await gw.call('/api/services/' + plan.serviceId, { method: 'PATCH', body: failedBody })
  assert.equal(failed.status, 409, JSON.stringify({ firstVersion: first.configVersion, currentVersion, failed: await failed.clone().json() }))
  const failedReceipt = await failed.json()
  assert.equal(failedReceipt.code, 'version_conflict')
  const failedReplay = await gw.call('/api/services/' + plan.serviceId, { method: 'PATCH', body: failedBody })
  assert.equal(failedReplay.status, 409)
  assert.deepEqual(await failedReplay.json(), failedReceipt)
  const root = join(dir, 'resource-operations')
  for (const kind of ['previews', 'operations', 'receipts', 'commits']) {
    assert.ok(readdirSync(join(root, 'local', kind)).length > 0, kind)
  }
  for (const path of files(root)) assert.equal(readFileSync(path, 'utf8').includes(plan.confirmToken), false)

  const replay = await gw.post('/api/services', body)
  assert.equal(replay.status, 200)
  assert.deepEqual(await replay.json(), first)
  const conflict = await gw.post('/api/services', { ...body, expectedVersion: 99 })
  assert.equal(conflict.status, 409)
  assert.equal((await conflict.json()).code, 'idempotency_conflict')
  const reused = await gw.post('/api/services', { ...body, requestId: 'different-request' })
  assert.equal(reused.status, 409)
  assert.equal((await gw.get('/api/services/' + plan.serviceId)).status, 200)
  const cancelled = await gw.post('/api/services/operations/' + first.operation.operationId + '/cancel', {})
  assert.equal(cancelled.status, 409)
  assert.equal((await cancelled.json()).code, 'operation_already_committed')

  const expired = await servicePreview(gw, {
    action: 'service.update', expectedVersion: currentVersion, requestId: 'service-expired', serviceId: plan.serviceId,
    patch: { displayName: 'Expired' }, ttlMs: 1,
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  const expiredApply = await gw.call('/api/services/' + plan.serviceId, { method: 'PATCH', body: serviceBody(expired) })
  assert.equal(expiredApply.status, 428)
  assert.equal((await expiredApply.json()).code, 'preview_expired')

  await gw.stop()
  gw = await startGateway({ name: 'operation-service-restart', dir, config })
  const restarted = await gw.post('/api/services', body)
  assert.equal(restarted.status, 200)
  assert.deepEqual(await restarted.json(), first)
  assert.equal((await (await gw.get('/api/services/' + plan.serviceId)).json()).service.displayName, 'Intermediate')
})

test('持久资源操作：重启标记 interrupted/unknown、HTTP 预提交取消且绝不重跑', { timeout: 30000 }, async (t) => {
  const dir = fixture(t)
  const config = { providers: { mock: { baseUrl: 'http://127.0.0.1:49321' } } }
  let gw = await startGateway({ name: 'operation-resource', dir, config })
  t.after(() => gw.stop())
  const root = join(dir, 'resource-operations')
  const store = createOperationStore(root, { scopeId: 'local', actorId: null })

  const runningPlan = await modelPreview(gw, 'model-running', 'running-model')
  const runningBody = modelBody(runningPlan)
  const running = store.beginOperation({
    previewId: runningPlan.previewId, confirmToken: runningPlan.confirmToken, requestId: runningPlan.requestId,
    requestFingerprint: fingerprint('POST', '/api/models', runningBody), steps: ['config-transaction'],
  })
  store.startStep(running.operation.operationId, 'config-transaction')

  const idlePlan = await modelPreview(gw, 'model-idle', 'idle-model')
  const idleBody = modelBody(idlePlan)
  const idle = store.beginOperation({
    previewId: idlePlan.previewId, confirmToken: idlePlan.confirmToken, requestId: idlePlan.requestId,
    requestFingerprint: fingerprint('POST', '/api/models', idleBody), steps: ['config-transaction'],
  })
  await gw.stop()
  gw = await startGateway({ name: 'operation-resource-restart', dir, config })

  const runningState = await (await gw.get('/api/models/operations/' + running.operation.operationId)).json()
  assert.equal(runningState.operation.state, 'unknown')
  assert.equal(runningState.operation.recovery.replay, 'forbidden')
  const idleState = await (await gw.get('/api/models/operations/' + idle.operation.operationId)).json()
  assert.equal(idleState.operation.state, 'interrupted')
  const runningReplay = await gw.post('/api/models', runningBody)
  assert.equal(runningReplay.status, 500)
  assert.equal((await runningReplay.json()).code, 'operation_not_replayable')
  const idleReplay = await gw.post('/api/models', idleBody)
  assert.equal(idleReplay.status, 500)
  assert.equal((await idleReplay.json()).operation.state, 'interrupted')
  assert.equal((await (await gw.get('/api/models')).json()).items.some((item) => item.name === 'running-model'), false)

  const cancelPlan = await modelPreview(gw, 'model-cancel', 'cancelled-model')
  const cancelled = store.beginOperation({
    previewId: cancelPlan.previewId, confirmToken: cancelPlan.confirmToken, requestId: cancelPlan.requestId,
    requestFingerprint: fingerprint('POST', '/api/models', modelBody(cancelPlan)), steps: ['config-transaction'],
  })
  const cancelResponse = await gw.post('/api/models/operations/' + cancelled.operation.operationId + '/cancel', { reason: 'owner-cancelled' })
  assert.equal(cancelResponse.status, 200, JSON.stringify(await cancelResponse.clone().json()))
  assert.equal((await cancelResponse.json()).operation.state, 'cancelled')
  assert.throws(
    () => createOperationStore(root, { scopeId: 'local', actorId: 'other-actor' }),
    (error) => error.code === 'operation_scope_mismatch',
  )
})

test('配置提交后回执失败：返回 commit marker 事实，不伪称回滚', { timeout: 30000 }, async (t) => {
  const dir = fixture(t)
  const config = {}
  let gw = await startGateway({ name: 'operation-receipt-fault', dir, config, env: { MG_OPERATION_STORE_FAULT: 'commit_receipt' } })
  t.after(() => gw.stop())
  const plan = await servicePreview(gw, {
    action: 'service.create', expectedVersion: 0, requestId: 'receipt-fault',
    patch: { displayName: 'Committed', endpoint: 'http://127.0.0.1:49321', allowPrivateNetwork: true },
  })
  const body = serviceBody(plan)
  const applied = await gw.post('/api/services', body)
  assert.equal(applied.status, 500, JSON.stringify(await applied.clone().json()))
  const failure = await applied.json()
  assert.equal(failure.code, 'operation_receipt_write_failed')
  assert.deepEqual(failure.details, { outcome: 'committed', commitMarker: true, receipt: 'unknown', cause: 'operation_store_write_failed' })
  assert.equal((await gw.get('/api/services/' + plan.serviceId)).status, 200)
  const operation = await (await gw.get('/api/services/operations/' + failure.operation.operationId)).json()
  assert.equal(operation.operation.state, 'succeeded')

  await gw.stop()
  gw = await startGateway({ name: 'operation-receipt-restart', dir, config, env: { MG_OPERATION_STORE_FAULT: '' } })
  const replay = await gw.post('/api/services', body)
  assert.equal(replay.status, 200, JSON.stringify(await replay.clone().json()))
  const receipt = await replay.json()
  assert.equal(receipt.operation.state, 'succeeded')
  assert.equal((await (await gw.get('/api/services/' + plan.serviceId)).json()).service.displayName, 'Committed')
})

test('持久备份与导入：重启后创建/导入均重放原安全回执', { timeout: 30000 }, async (t) => {
  const dir = fixture(t)
  const config = { providers: { mock: { baseUrl: 'https://example.test/v1' } }, models: { demo: { provider: 'mock' } }, defaults: { proxyMode: 'direct' } }
  let gw = await startGateway({ name: 'operation-backup', dir, config })
  t.after(() => gw.stop())
  const createBody = { requestId: 'backup-create-durable' }
  const created = await gw.post('/api/config/backups', createBody)
  assert.equal(created.status, 200, JSON.stringify(await created.clone().json()))
  const createReceipt = await created.json()
  const backup = (await (await gw.get('/api/config/backups/' + createReceipt.item.backupId)).json()).item
  const version = (await (await gw.get('/api/status')).json()).configVersion
  assert.equal((await gw.write('/api/config/save', { version, defaults: { proxyMode: 'global' } })).status, 200)
  const importVersion = (await (await gw.get('/api/status')).json()).configVersion
  const preview = await gw.post('/api/config/import:preview', { backup, expectedVersion: importVersion, requestId: 'backup-import-durable' })
  assert.equal(preview.status, 200, JSON.stringify(await preview.clone().json()))
  const plan = await preview.json()
  const applyBody = { planId: plan.planId, previewId: plan.previewId, confirmToken: plan.confirmToken, expectedVersion: importVersion, requestId: 'backup-import-durable' }
  const applied = await gw.post('/api/config/import:apply', applyBody)
  assert.equal(applied.status, 200, JSON.stringify(await applied.clone().json()))
  const importReceipt = await applied.json()

  await gw.stop()
  gw = await startGateway({ name: 'operation-backup-restart', dir, config })
  const createReplay = await gw.post('/api/config/backups', createBody)
  assert.equal(createReplay.status, 200)
  assert.deepEqual(await createReplay.json(), createReceipt)
  assert.equal((await (await gw.get('/api/config/backups')).json()).items.length, 1)
  const importReplay = await gw.post('/api/config/import:apply', applyBody)
  assert.equal(importReplay.status, 200)
  assert.deepEqual(await importReplay.json(), importReceipt)
  assert.equal((await (await gw.get('/api/config')).json()).defaults.proxyMode, 'direct')
  const cancel = await gw.post('/api/config/backups/operations/' + importReceipt.operation.operationId + '/cancel', {})
  assert.equal(cancel.status, 409)
})

test('Harness 持久意图与回执：正常应用/回滚重放，确认令牌不落盘', { timeout: 30000 }, async (t) => {
  const dir = fixture(t)
  const home = join(dir, 'home')
  mkdirSync(join(home, '.claude'), { recursive: true })
  const original = JSON.stringify({ env: { KEEP: 'yes' }, permissions: { allow: ['Read'] } }, null, 2)
  writeFileSync(join(home, '.claude/settings.json'), original)
  const gw = await startGateway({ name: 'operation-harness', dir, env: { HOME: home, MG_HARNESS_ROOT: home } })
  t.after(() => gw.stop())
  const preview = await gw.post('/api/harnesses/preview', { harnessId: 'claude-code', endpoint: 'http://127.0.0.1:8787', apiKeyEnv: 'MODELGATE_API_KEY', requestId: 'harness-durable' })
  assert.equal(preview.status, 200, JSON.stringify(await preview.clone().json()))
  const plan = await preview.json()
  for (const path of files(join(dir, 'resource-operations'))) assert.equal(readFileSync(path, 'utf8').includes(plan.confirmToken), false)
  const body = { previewId: plan.previewId, confirmToken: plan.confirmToken, requestId: plan.requestId }
  const applied = await gw.post('/api/harnesses/apply', body)
  assert.equal(applied.status, 200, JSON.stringify(await applied.clone().json()))
  const receipt = await applied.json()
  assert.equal(receipt.operation.state, 'succeeded')
  const replay = await gw.post('/api/harnesses/apply', body)
  assert.equal(replay.status, 200)
  assert.deepEqual(await replay.json(), receipt)
  const rollbackBody = { backupId: plan.backupId, harnessId: 'claude-code', requestId: 'harness-rollback-durable' }
  const rolled = await gw.post('/api/harnesses/rollback', rollbackBody)
  assert.equal(rolled.status, 200, JSON.stringify(await rolled.clone().json()))
  const rollbackReceipt = await rolled.json()
  const rollbackReplay = await gw.post('/api/harnesses/rollback', rollbackBody)
  assert.equal(rollbackReplay.status, 200)
  assert.deepEqual(await rollbackReplay.json(), rollbackReceipt)
  assert.equal(readFileSync(join(home, '.claude/settings.json'), 'utf8'), original)
})

test('Harness 适配器结果后崩溃：无 commit marker，重启未知且禁止重跑写入', { timeout: 30000 }, async (t) => {
  const dir = fixture(t)
  const home = join(dir, 'home')
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.claude/settings.json'), '{}')
  let gw = await startGateway({ name: 'operation-harness-crash', dir, env: { HOME: home, MG_HARNESS_ROOT: home, MG_OPERATION_STORE_FAULT: 'before_commit_marker' } })
  t.after(() => gw.stop())
  const preview = await gw.post('/api/harnesses/preview', { harnessId: 'claude-code', endpoint: 'http://127.0.0.1:8787', requestId: 'harness-crash' })
  assert.equal(preview.status, 200, JSON.stringify(await preview.clone().json()))
  const plan = await preview.json()
  const body = { previewId: plan.previewId, confirmToken: plan.confirmToken, requestId: plan.requestId }
  await assert.rejects(gw.post('/api/harnesses/apply', body))
  await gw.stop()
  const changed = readFileSync(join(home, '.claude/settings.json'), 'utf8')
  assert.match(changed, /ANTHROPIC_BASE_URL/)
  const operationsDir = join(dir, 'resource-operations/local/operations')
  const operationFile = readdirSync(operationsDir).find((name) => name.endsWith('.json'))
  const operationId = JSON.parse(readFileSync(join(operationsDir, operationFile), 'utf8')).payload.operationId
  assert.equal(readdirSync(join(dir, 'resource-operations/local/commits')).length, 0)

  gw = await startGateway({ name: 'operation-harness-crash-restart', dir, env: { HOME: home, MG_HARNESS_ROOT: home, MG_OPERATION_STORE_FAULT: '' } })
  const state = await (await gw.get('/api/services/operations/' + operationId)).json()
  assert.equal(state.operation.state, 'unknown')
  assert.equal(state.operation.recovery.replay, 'forbidden')
  const replay = await gw.post('/api/harnesses/apply', body)
  assert.equal(replay.status, 500)
  assert.equal((await replay.json()).code, 'operation_not_replayable')
  assert.equal(readFileSync(join(home, '.claude/settings.json'), 'utf8'), changed)
})

test('兼容与作用域：无配置根保留内存链，显式 actor/scope 不可跨用预览', { timeout: 30000 }, async (t) => {
  const dir = fixture(t)
  const previous = process.env.MG_CONFIG_DIR
  delete process.env.MG_CONFIG_DIR
  t.after(() => {
    if (previous === undefined) delete process.env.MG_CONFIG_DIR
    else process.env.MG_CONFIG_DIR = previous
  })
  let cfg = { configVersion: 0, providers: {}, models: {}, defaults: {}, virtualModels: [] }
  const previews = new Map()
  const receipts = new Map()
  const base = {
    getConfig: () => cfg,
    saveConfig: async (payload) => { cfg = { ...cfg, ...payload, configVersion: cfg.configVersion + 1 }; return {} },
    previews, receipts,
  }
  const preview = await handleServiceApi({ ...base, method: 'POST', path: '/api/config/preview', body: {
    action: 'service.create', expectedVersion: 0, requestId: 'memory-request',
    patch: { displayName: 'Memory', endpoint: 'http://127.0.0.1:49321', allowPrivateNetwork: true },
  } })
  assert.equal(preview.status, 200)
  const plan = preview.body
  const body = serviceBody(plan)
  const applied = await handleServiceApi({ ...base, method: 'POST', path: '/api/services', body })
  assert.equal(applied.status, 200)
  assert.equal(receipts.size, 1)
  assert.deepEqual(await handleServiceApi({ ...base, method: 'POST', path: '/api/services', body }), applied)

  const configDir = join(dir, 'scope-config')
  let writes = 0
  const scopedBase = {
    configDir, state: { paths: { dir: configDir } }, getConfig: () => cfg,
    saveConfig: async () => { writes += 1; return {} }, previews: new Map(), receipts: new Map(),
  }
  const alpha = await handleServiceApi({ ...scopedBase, scope: { scopeId: 'alpha', actorId: 'alice' }, method: 'POST', path: '/api/config/preview', body: {
    action: 'service.create', expectedVersion: cfg.configVersion, requestId: 'alpha-request',
    patch: { displayName: 'Alpha', endpoint: 'http://127.0.0.1:49321', allowPrivateNetwork: true },
  } })
  assert.equal(alpha.status, 200)
  const cross = await handleServiceApi({ ...scopedBase, scope: { scopeId: 'beta', actorId: 'bob' }, method: 'POST', path: '/api/services', body: serviceBody(alpha.body) })
  assert.equal(cross.status, 428)
  assert.equal(writes, 0)
})
