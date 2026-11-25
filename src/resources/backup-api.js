import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { previewImport, applyImportPlan } from './backups.js'
import { createStoredBackup, listStoredBackups, readStoredBackup, deleteStoredBackup } from './backup-store.js'
import {
  apiOperationError, apiOperationStore, createApiPreview, executeApiWrite,
  handleApiOperationRoute, publicApiOperation, replayApiWrite,
} from './operation-store.js'

function fail(status, code, error, details) { return { status, body: { ok: false, code, error: error || code, retryable: status >= 500 || status === 409, ...(details ? { details } : {}) } } }
function hash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function decode(value) { try { return decodeURIComponent(value) } catch { return null } }
function configSnapshot(cfg) { return { configVersion: cfg.configVersion || 0, providers: cfg.providers || {}, models: cfg.models || {}, defaults: cfg.defaults || {}, virtualModels: cfg.virtualModels || [] } }

async function directBackupWrite(ctx, action, save, responseFor) {
  const state = ctx.state
  state.backupPreviews ||= new Map()
  state.resourceReceipts ||= new Map()
  const body = ctx.body || {}
  const requestFingerprint = hash({ method: ctx.method, path: ctx.path, body })
  if (body.requestId) {
    const prior = replayApiWrite(ctx, { receipts: state.resourceReceipts, requestId: body.requestId, requestFingerprint })
    if (prior) return prior
  }
  let preview
  try {
    preview = createApiPreview(ctx, {
      previews: state.backupPreviews, requestId: body.requestId,
      plan: { action }, view: { ok: true, action }, now: ctx.now,
    })
  } catch (error) { return apiOperationError(error, 'backup_operation_failed') }
  return executeApiWrite(ctx, {
    previews: state.backupPreviews, receipts: state.resourceReceipts,
    previewId: preview.previewId, confirmToken: preview.confirmToken,
    requestId: preview.requestId, requestFingerprint,
    steps: [action], save, responseFor,
    failureFor: (error) => action === 'backup.delete'
      ? fail(404, 'backup_not_found', '备份不存在或不可读')
      : fail(error.status || 400, error.code || 'backup_write_failed', error.message || error.error || '备份操作失败'),
  })
}

export async function handleBackupApi(ctx) {
  const { method, path, body, getConfig, saveConfig, state, now = Date.now() } = ctx
  const operationRoute = handleApiOperationRoute(ctx, method, path)
  if (operationRoute) return operationRoute
  const root = join(state.paths.dir, 'backups')
  state.importPlans ||= new Map()
  for (const [key, value] of state.importPlans) if (value.expiresAt <= now) state.importPlans.delete(key)
  if (method === 'GET' && path === '/api/config/backups') return { status: 200, body: { contract: 'mg-config-backups/1', items: listStoredBackups(root), secretsIncluded: false } }
  if (method === 'POST' && path === '/api/config/backups') {
    const snapshot = configSnapshot(getConfig())
    return directBackupWrite(ctx, 'backup.create', () => ({ backup: createStoredBackup(snapshot, root) }), (result, operation) => {
      const backup = result.backup
      return { status: 200, body: { ok: true, contract: 'mg-config-backups/1', item: { backupId: backup.backupId, createdAt: backup.createdAt, sha256: backup.sha256, bytes: Buffer.byteLength(JSON.stringify(backup)) }, secretsIncluded: false, ...(operation ? { operation: publicApiOperation(operation) } : {}) } }
    })
  }
  if (method === 'GET' && path.startsWith('/api/config/backups/')) {
    const id = decode(path.slice('/api/config/backups/'.length))
    try { return { status: 200, body: { contract: 'mg-config-backups/1', item: readStoredBackup(root, id), secretsIncluded: false } } }
    catch { return fail(404, 'backup_not_found', '备份不存在或不可读') }
  }
  if (method === 'DELETE' && path.startsWith('/api/config/backups/')) {
    const id = decode(path.slice('/api/config/backups/'.length))
    return directBackupWrite(ctx, 'backup.delete', () => { deleteStoredBackup(root, id); return {} }, (result, operation) => ({
      status: 200, body: { ok: true, backupId: id, ...(operation ? { operation: publicApiOperation(operation) } : {}) },
    }))
  }
  if (method === 'POST' && path === '/api/config/import:preview') {
    try {
      const plan = previewImport(configSnapshot(getConfig()), body?.backup, { expectedVersion: body?.expectedVersion })
      const created = createApiPreview(ctx, {
        previews: state.importPlans, requestId: body?.requestId, plan, ttlMs: body?.ttlMs, now,
        view: { ok: true, expectedVersion: plan.expectedVersion, source: plan.source, diff: plan.diff, conflicts: plan.diff.conflicts },
      })
      return { status: 200, body: { ...created, planId: 'imp_' + created.confirmToken } }
    } catch (error) {
      if (Number.isInteger(error.status) && error.status >= 500) return apiOperationError(error, 'preview_store_failed')
      return fail(error.code === 'version_conflict' ? 409 : 400, error.code || 'invalid_backup', error.message, error.currentVersion ? { currentVersion: error.currentVersion } : undefined)
    }
  }
  if (method === 'POST' && path === '/api/config/import:apply') {
    const requestFingerprint = hash({ method, path, body })
    const prior = replayApiWrite(ctx, { receipts: state.resourceReceipts, requestId: body?.requestId, requestFingerprint })
    if (prior) return prior
    const token = String(body?.confirmToken || '')
    const durable = apiOperationStore(ctx)
    let stored
    try {
      stored = durable
        ? durable.readPreview(body.previewId || durable.readPreviewByToken(token, { includePlan: true }).previewId, { includePlan: true })
        : state.importPlans.get(token)
    } catch (error) {
      return error.code === 'preview_not_found' ? fail(428, 'preview_expired', '导入预览不存在或已过期') : apiOperationError(error)
    }
    if (!stored || (!durable && stored.expiresAt <= now)) {
      if (!durable) state.importPlans.delete(token)
      return fail(428, 'preview_expired', '导入预览不存在或已过期')
    }
    if (body.planId !== 'imp_' + token || body.previewId !== undefined && body.previewId !== stored.previewId || body.expectedVersion !== stored.plan.expectedVersion || typeof body.requestId !== 'string' || !body.requestId) return fail(409, 'preview_binding_mismatch', '导入预览绑定不匹配')
    let payload
    try {
      const merged = applyImportPlan(configSnapshot(getConfig()), stored.plan)
      payload = { expectedVersion: stored.plan.expectedVersion, providers: merged.providers, models: merged.models, defaults: merged.defaults, virtualModels: merged.virtualModels }
    } catch (error) { return fail(error.code === 'version_conflict' ? 409 : 400, error.code || 'import_failed', error.message) }
    return executeApiWrite(ctx, {
      previews: state.importPlans, receipts: state.resourceReceipts,
      previewId: stored.previewId, confirmToken: token, requestId: body.requestId,
      requestFingerprint, allowRequestIdRebind: true,
      save: () => saveConfig(payload),
      responseFor: (result, operation) => ({ status: 200, body: {
        ok: true, requestId: body.requestId, configVersion: getConfig().configVersion || 0,
        operation: operation ? publicApiOperation(operation) : { id: 'op_' + randomBytes(8).toString('hex'), state: 'succeeded' },
      } }),
      failureFor: (result) => fail(result.conflict ? 409 : result.status || 400, result.conflict ? 'version_conflict' : result.code || 'import_failed', result.error || result.message),
    })
  }
  return null
}
