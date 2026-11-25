import { createHash, randomBytes } from 'node:crypto'
import { listHarnessAdapters, detectHarnesses, previewHarnessConfig, applyHarnessConfig, rollbackHarnessConfig } from './harness-adapters.js'
import {
  apiOperationError, apiOperationStore, createApiPreview, executeApiWrite,
  handleApiOperationRoute, publicApiOperation, replayApiWrite,
} from './operation-store.js'

function fail(status, code, error, details) { return { status, body: { ok: false, code, error: error || code, retryable: status >= 500 || status === 409, ...(details ? { details } : {}) } } }
function managedRoot() { return String(process.env.MG_HARNESS_ROOT || '').trim() }
const PREVIEW_BINDINGS = new Map()

function adapterApplyBody(body, adapterToken, requestId, root, now) {
  const out = { ...body, confirmToken: adapterToken, requestId, managedRoot: root }
  delete out.preview
  delete out.previewId
  delete out.planHash
  if (now !== undefined) out.now = now
  return out
}

async function durableRollback(ctx, root, body) {
  const requestId = body?.requestId || 'req_' + randomBytes(16).toString('base64url')
  const previews = ctx.previews || new Map()
  const requestFingerprint = createHash('sha256').update(JSON.stringify({ method: ctx.method, path: ctx.path, body })).digest('hex')
  if (body?.requestId) {
    const prior = replayApiWrite(ctx, { receipts: ctx.receipts, requestId, requestFingerprint })
    if (prior) return prior
  }
  let preview
  try {
    preview = createApiPreview(ctx, {
      previews, requestId, now: ctx.now,
      plan: { action: 'harness.rollback', managedRoot: root, backupId: body?.backupId, harnessId: body?.harnessId, path: body?.path },
      view: { ok: true, action: 'harness.rollback', backupId: body?.backupId },
    })
  } catch (error) { return apiOperationError(error, 'harness_operation_failed') }
  const adapterBody = { ...body, managedRoot: root }
  delete adapterBody.requestId
  if (ctx.now !== undefined) adapterBody.now = ctx.now
  return executeApiWrite(ctx, {
    previews, receipts: ctx.receipts,
    previewId: preview.previewId, confirmToken: preview.confirmToken,
    requestId, requestFingerprint,
    steps: ['harness-adapter-rollback'],
    save: () => ({ value: rollbackHarnessConfig(adapterBody) }),
    responseFor: (result, operation) => ({ status: 200, body: { ...result.value, requestId, previewId: preview.previewId, ...(operation ? { operation: publicApiOperation(operation) } : {}) } }),
    failureFor: (error) => fail(error.status || 400, error.code || 'harness_adapter_failed', error.message, error.details),
  })
}

export async function handleHarnessApi(ctx) {
  const { method, path, body } = ctx
  const operationRoute = handleApiOperationRoute(ctx, method, path)
  if (operationRoute) return operationRoute
  if (method === 'GET' && path === '/api/harnesses') {
    const home = String(process.env.HOME || '').trim()
    return { status: 200, body: { contract: 'mg-harness-adapters/1', adapters: listHarnessAdapters(), detection: detectHarnesses(home ? { home } : {}), writesEnabled: !!managedRoot(), note: 'Detection is metadata-only. Configuration writes require an explicit isolated MG_HARNESS_ROOT.' } }
  }
  if (!['POST'].includes(method)) return null
  const root = managedRoot()
  if (!root) return fail(403, 'write_disabled', 'Harness 配置写入未启用：请为隔离实例设置 MG_HARNESS_ROOT')
  try {
    if (path === '/api/harnesses/preview') {
      const requestId = body?.requestId || 'req_' + randomBytes(16).toString('base64url')
      const adapterPreview = previewHarnessConfig({ ...body, requestId, managedRoot: root, ...(ctx.now !== undefined ? { now: ctx.now } : {}) })
      const store = apiOperationStore(ctx)
      if (!store) return { status: 200, body: adapterPreview }
      const { confirmToken: adapterToken, previewId: _adapterPreviewId, ...safePreview } = adapterPreview
      const created = createApiPreview(ctx, {
        requestId, now: ctx.now, ttlMs: body?.ttlMs,
        plan: { action: 'harness.apply', managedRoot: root, request: body || {}, preview: safePreview },
        view: safePreview,
      })
      PREVIEW_BINDINGS.set(created.confirmToken, { previewId: created.previewId, adapterToken, requestId, root })
      while (PREVIEW_BINDINGS.size > 200) PREVIEW_BINDINGS.delete(PREVIEW_BINDINGS.keys().next().value)
      return { status: 200, body: { ...created, backupId: adapterPreview.backupId } }
    }
    if (path === '/api/harnesses/apply') {
      const store = apiOperationStore(ctx)
      if (!store) return { status: 200, body: applyHarnessConfig({ ...body, managedRoot: root }) }
      const token = String(body?.confirmToken || '')
      const binding = PREVIEW_BINDINGS.get(token)
      const requestFingerprint = createHash('sha256').update(JSON.stringify({ method, path, body })).digest('hex')
      let requestId = body?.requestId || binding?.requestId
      if (requestId) {
        const prior = replayApiWrite(ctx, { receipts: ctx.receipts, requestId, requestFingerprint })
        if (prior) return prior
      }
      let previewId = body?.previewId || binding?.previewId
      if (!previewId) previewId = store.readPreviewByToken(token, { includePlan: true }).previewId
      const stored = store.readPreview(previewId, { includePlan: true })
      requestId ||= stored.requestId
      return executeApiWrite(ctx, {
        previews: ctx.previews, receipts: ctx.receipts,
        previewId, confirmToken: token, requestId, requestFingerprint,
        steps: ['harness-adapter-write'],
        save: () => {
          if (!binding) throw { status: 428, code: 'preview_not_found', message: 'Harness 预览意图在重启后不可重放，请重新预览' }
          return { value: applyHarnessConfig(adapterApplyBody(body || {}, binding.adapterToken, requestId, root, ctx.now)) }
        },
        responseFor: (result, operation) => ({ status: 200, body: { ...result.value, previewId, requestId, ...(operation ? { operation: publicApiOperation(operation) } : {}) } }),
        failureFor: (error) => fail(error.status || 400, error.code || 'harness_adapter_failed', error.message, error.details),
      })
    }
    if (path === '/api/harnesses/rollback') {
      if (!apiOperationStore(ctx)) return { status: 200, body: rollbackHarnessConfig({ ...body, managedRoot: root }) }
      return durableRollback(ctx, root, body || {})
    }
  } catch (error) { return fail(error.status || 400, error.code || 'harness_adapter_failed', error.message, error.details) }
  return null
}
