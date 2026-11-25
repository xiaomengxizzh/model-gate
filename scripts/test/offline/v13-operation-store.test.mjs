import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  COMMIT_SCHEMA, COMMIT_VERSION, CLEANUP_SCHEMA, CLEANUP_VERSION,
  OPERATION_SCHEMA, OPERATION_VERSION,
  PREVIEW_SCHEMA, PREVIEW_VERSION, RECEIPT_SCHEMA, RECEIPT_VERSION,
  createOperationStore,
} from '../../../src/resources/operation-store.js'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mg-operation-store-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function clock(initial = 1_700_000_000_000) {
  const state = { now: initial }
  return { now: () => state.now, set: (value) => { state.now = value } }
}

function scope(scopeId = 'alpha', actorId = 'alice') {
  return { scopeId, actorId }
}

function throwsCode(fn, code, status) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code)
    if (status !== undefined) assert.equal(error.status, status)
    return true
  })
}

function allFiles(root) {
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

function payload(path) {
  return JSON.parse(readFileSync(path, 'utf8')).payload
}

function snapshot(root) {
  return allFiles(root).map((path) => {
    const stat = statSync(path, { bigint: true })
    return { path, bytes: readFileSync(path).toString('hex'), mode: stat.mode, mtimeNs: stat.mtimeNs }
  })
}

function canonicalHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function writeSealed(path, value) {
  const body = { schema: 'modelgate-operation-store-record', version: 1, payload: value }
  writeFileSync(path, JSON.stringify({ ...body, checksum: canonicalHash(body) }), { mode: 0o600 })
}

function crashPreviewWrite(root, point) {
  const moduleUrl = new URL('../../../src/resources/operation-store.js', import.meta.url).href
  const script = `
    import fs from 'node:fs'
    import { syncBuiltinESMExports } from 'node:module'
    const rename = fs.renameSync
    fs.renameSync = (...args) => {
      if (process.env.MG_TEST_CRASH_POINT === 'before') process.exit(99)
      rename(...args)
      process.exit(99)
    }
    syncBuiltinESMExports()
    const { createOperationStore } = await import(process.env.MG_TEST_MODULE_URL)
    createOperationStore(process.env.MG_TEST_ROOT, { scopeId: 'alpha', actorId: 'alice' })
      .createPreview({ requestId: 'crash-write', plan: {} })
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, MG_TEST_ROOT: root, MG_TEST_MODULE_URL: moduleUrl, MG_TEST_CRASH_POINT: point },
    encoding: 'utf8',
  })
  assert.equal(child.status, 99, child.stderr || String(child.error || 'write did not stop at ' + point))
}

function previewPath(root, previewId, scopeId = 'alpha') {
  return join(root, scopeId, 'previews', previewId + '.json')
}

function operationPath(root, operationId, scopeId = 'alpha') {
  return join(root, scopeId, 'operations', operationId + '.json')
}

function makePreview(store, requestId, extra = {}) {
  return store.createPreview({
    requestId,
    plan: { action: 'service.update', payload: { providers: { demo: { baseUrl: 'https://example.test/v1' } } } },
    view: { before: { note: 'old' }, after: { note: 'new' }, impact: { inFlight: 'fixed-generation' } },
    ...extra,
  })
}

test('预览：schema/version、0600 原子文件、token 仅以 SHA256 落盘', (t) => {
  const root = fixture(t)
  const store = createOperationStore(root, scope(), { now: clock().now })
  const preview = makePreview(store, 'request-secret')

  assert.equal(preview.schema, PREVIEW_SCHEMA)
  assert.equal(preview.version, PREVIEW_VERSION)
  assert.match(preview.previewId, /^prv_[A-Za-z0-9_-]{43}$/)
  assert.match(preview.confirmToken, /^[A-Za-z0-9_-]{43}$/)
  assert.notEqual(preview.confirmToken, preview.previewId.slice(4))
  assert.equal(preview.state, 'pending')

  const path = previewPath(root, preview.previewId)
  const raw = readFileSync(path, 'utf8')
  const record = payload(path)
  assert.equal(record.schema, PREVIEW_SCHEMA)
  assert.equal(record.version, PREVIEW_VERSION)
  assert.equal(record.tokenHash, createHash('sha256').update(preview.confirmToken).digest('hex'))
  assert.equal(raw.includes(preview.confirmToken), false)
  assert.equal(raw.includes('confirmToken'), false)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.equal(statSync(join(root, 'alpha')).mode & 0o777, 0o700)
  for (const file of allFiles(root)) {
    assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.equal(file.includes('.tmp-'), false)
  }

  const safe = store.readPreview(preview.previewId)
  assert.equal(Object.hasOwn(safe, 'confirmToken'), false)
  assert.equal(Object.hasOwn(safe, 'tokenHash'), false)
  assert.deepEqual(store.readPreview(preview.previewId, { includePlan: true }).plan, {
    action: 'service.update', payload: { providers: { demo: { baseUrl: 'https://example.test/v1' } } },
  })
})

test('作用域：preview、operation、request receipt 与 actor 所有权隔离', (t) => {
  const root = fixture(t)
  const alpha = createOperationStore(root, scope('alpha', 'alice'), { now: clock().now })
  const beta = createOperationStore(root, scope('beta', 'bob'), { now: clock().now })
  const preview = makePreview(alpha, 'alpha-request')
  const begun = alpha.beginOperation({ previewId: preview.previewId, confirmToken: preview.confirmToken, requestId: 'alpha-request', steps: [] })

  throwsCode(() => beta.readPreview(preview.previewId), 'preview_not_found')
  throwsCode(() => beta.getOperation(begun.operation.operationId), 'operation_not_found')
  throwsCode(() => beta.getRequestReceipt('alpha-request'), 'request_receipt_not_found')
  throwsCode(() => beta.beginOperation({ previewId: preview.previewId, confirmToken: preview.confirmToken, requestId: 'alpha-request', steps: [] }), 'preview_not_found')
  throwsCode(() => createOperationStore(root, scope('alpha', 'mallory')), 'operation_scope_mismatch')

  const betaPreview = makePreview(beta, 'beta-request')
  assert.equal(betaPreview.scopeId, 'beta')
  assert.equal(beta.readPreview(betaPreview.previewId).scopeId, 'beta')
})

test('过期：到期边界拒绝确认且不消费 preview', (t) => {
  const root = fixture(t)
  const time = clock(1000)
  const store = createOperationStore(root, scope(), { now: time.now })
  const valid = makePreview(store, 'valid-until-1099', { ttlMs: 100 })
  const expired = makePreview(store, 'expired-at-1100', { ttlMs: 100 })

  time.set(1099)
  assert.equal(store.beginOperation({ previewId: valid.previewId, confirmToken: valid.confirmToken, requestId: 'valid-until-1099', steps: [] }).replayed, false)
  time.set(1100)
  throwsCode(() => store.beginOperation({ previewId: expired.previewId, confirmToken: expired.confirmToken, requestId: 'expired-at-1100', steps: [] }), 'preview_expired')
  assert.equal(store.readPreview(expired.previewId).state, 'pending')
  throwsCode(() => store.beginOperation({ previewId: expired.previewId, confirmToken: expired.confirmToken, requestId: 'expired-at-1100', steps: [] }), 'preview_expired')
})

test('确认令牌：仅消费一次；同 requestId 重放不返回执行计划', (t) => {
  const root = fixture(t)
  const store = createOperationStore(root, scope(), { now: clock().now })
  const preview = makePreview(store, 'request-once')
  const input = { previewId: preview.previewId, confirmToken: preview.confirmToken, requestId: 'request-once', steps: ['write'] }
  const first = store.beginOperation(input)
  assert.equal(first.replayed, false)
  assert.deepEqual(first.plan, store.readPreview(preview.previewId, { includePlan: true }).plan)

  const replay = store.beginOperation(input)
  assert.equal(replay.replayed, true)
  assert.equal(Object.hasOwn(replay, 'plan'), false)
  assert.equal(replay.operation.operationId, first.operation.operationId)

  const other = makePreview(store, 'request-twice')
  throwsCode(() => store.beginOperation({ previewId: preview.previewId, confirmToken: preview.confirmToken, requestId: 'request-twice', steps: [] }), 'preview_consumed')
  throwsCode(() => store.beginOperation({ previewId: other.previewId, confirmToken: preview.confirmToken, requestId: 'request-twice', steps: [] }), 'preview_binding_mismatch')
})

test('重启：preview 与 requestId 回执持久；过期后重放仍只返回原 operation', (t) => {
  const root = fixture(t)
  const time = clock()
  const preview = makePreview(createOperationStore(root, scope(), { now: time.now }), 'restart-request', { ttlMs: 10 })
  const fingerprint = 'a'.repeat(64)
  const input = { previewId: preview.previewId, confirmToken: preview.confirmToken, requestId: 'restart-request', requestFingerprint: fingerprint, steps: ['write'] }
  const first = createOperationStore(root, scope(), { now: time.now })
  const begun = first.beginOperation(input)
  first.startStep(begun.operation.operationId, 'write')
  first.completeStep(begun.operation.operationId, 'write', { result: { written: true } })
  const committed = first.commitOperation(begun.operation.operationId, { result: { configVersion: 8 }, response: { ok: true, configVersion: 8 } })
  for (const file of allFiles(root)) {
    assert.equal(readFileSync(file, 'utf8').includes(preview.confirmToken), false)
  }

  time.set(time.now() + 20_000)
  const restarted = createOperationStore(root, scope(), { now: time.now })
  assert.equal(restarted.readPreview(preview.previewId).state, 'consumed')
  const replay = restarted.replayRequest('restart-request', fingerprint)
  assert.equal(replay.replayed, true)
  assert.equal(replay.operation.state, 'succeeded')
  assert.deepEqual(replay.receipt.response, { ok: true, configVersion: 8 })
  assert.equal(replay.receipt.schema, RECEIPT_SCHEMA)
  assert.equal(replay.receipt.version, RECEIPT_VERSION)
  assert.equal(restarted.beginOperation(input).replayed, true)
  throwsCode(() => restarted.replayRequest('restart-request', 'b'.repeat(64)), 'idempotency_conflict')

  const pendingPath = previewPath(root, preview.previewId)
  assert.equal(readFileSync(pendingPath, 'utf8').includes(preview.confirmToken), false)
  assert.equal(committed.state, 'succeeded')
})

test('进度与终态：步骤不可重跑、未完成不可提交、取消仅限未开始', (t) => {
  const root = fixture(t)
  const store = createOperationStore(root, scope(), { now: clock().now })
  const preview = makePreview(store, 'progress-request')
  const begun = store.beginOperation({ previewId: preview.previewId, confirmToken: preview.confirmToken, requestId: 'progress-request', steps: ['prepare', 'write'] })
  const id = begun.operation.operationId
  assert.equal(begun.operation.schema, OPERATION_SCHEMA)
  assert.equal(begun.operation.version, OPERATION_VERSION)
  assert.deepEqual(begun.operation.progress, { total: 2, pending: 2, running: 0, completed: 0, failed: 0, unknown: 0 })

  assert.equal(store.startStep(id, 'prepare').progress.running, 1)
  assert.equal(store.completeStep(id, 'prepare', { result: { ready: true } }).progress.completed, 1)
  throwsCode(() => store.startStep(id, 'prepare'), 'step_already_committed')
  throwsCode(() => store.commitOperation(id), 'operation_steps_incomplete')
  throwsCode(() => store.cancelOperation(id), 'operation_commit_uncertain')

  const cancelPreview = makePreview(store, 'cancel-request')
  const cancelId = store.beginOperation({ previewId: cancelPreview.previewId, confirmToken: cancelPreview.confirmToken, requestId: 'cancel-request', steps: ['write'] }).operation.operationId
  assert.equal(store.cancelOperation(cancelId, { reason: 'user_cancelled' }).state, 'cancelled')
  assert.equal(createOperationStore(root, scope(), { now: clock().now }).getOperation(cancelId).state, 'cancelled')

  const failPreview = makePreview(store, 'fail-request')
  const failId = store.beginOperation({ previewId: failPreview.previewId, confirmToken: failPreview.confirmToken, requestId: 'fail-request', steps: ['write'] }).operation.operationId
  store.startStep(failId, 'write')
  assert.equal(store.failOperation(failId, { code: 'writer_crashed' }).state, 'unknown')
  assert.equal(store.getOperation(failId).steps[0].state, 'unknown')
})

test('已提交取消：独立 commit marker fail-closed，并支持 marker 前滚恢复', (t) => {
  const root = fixture(t)
  const store = createOperationStore(root, scope(), { now: clock().now })
  const preview = makePreview(store, 'committed-request')
  const id = store.beginOperation({ previewId: preview.previewId, confirmToken: preview.confirmToken, requestId: 'committed-request', steps: [] }).operation.operationId
  const path = operationPath(root, id)
  const beforeCommit = readFileSync(path)
  const committed = store.commitOperation(id, { result: { committed: true }, response: { ok: true } })
  assert.equal(committed.state, 'succeeded')
  throwsCode(() => store.cancelOperation(id), 'operation_already_committed')
  throwsCode(() => store.failOperation(id), 'operation_already_committed')

  const marker = payload(join(root, 'alpha', 'commits', id + '.json'))
  assert.equal(marker.schema, COMMIT_SCHEMA)
  assert.equal(marker.version, COMMIT_VERSION)
  assert.equal(statSync(join(root, 'alpha', 'commits', id + '.json')).mode & 0o777, 0o600)

  // Simulate a crash after the marker rename but before the operation rename.
  writeFileSync(path, beforeCommit, { mode: 0o600 })
  throwsCode(() => store.cancelOperation(id), 'operation_already_committed')
  const restarted = createOperationStore(root, scope(), { now: clock().now })
  assert.equal(restarted.getOperation(id).state, 'succeeded')
  assert.deepEqual(restarted.getOperation(id).result, { committed: true })
})

test('未知恢复：已开始步骤保留事实且终态禁止重放，未开始步骤标记 interrupted', (t) => {
  const root = fixture(t)
  const store = createOperationStore(root, scope(), { now: clock().now })
  const preview = makePreview(store, 'unknown-request')
  const id = store.beginOperation({ previewId: preview.previewId, confirmToken: preview.confirmToken, requestId: 'unknown-request', steps: ['first', 'second'] }).operation.operationId
  store.startStep(id, 'first')
  store.completeStep(id, 'first', { result: { committed: true } })
  store.startStep(id, 'second')

  const idlePreview = makePreview(store, 'idle-request')
  const idleId = store.beginOperation({ previewId: idlePreview.previewId, confirmToken: idlePreview.confirmToken, requestId: 'idle-request', steps: ['later'] }).operation.operationId

  const restarted = createOperationStore(root, scope(), { now: clock().now })
  const recovered = restarted.getOperation(id)
  assert.equal(recovered.state, 'unknown')
  assert.equal(recovered.terminal, true)
  assert.equal(recovered.steps[0].state, 'succeeded')
  assert.deepEqual(recovered.steps[0].result, { committed: true })
  assert.equal(recovered.steps[1].state, 'unknown')
  assert.equal(recovered.recovery.replay, 'forbidden')
  throwsCode(() => restarted.startStep(id, 'first'), 'operation_terminal')
  throwsCode(() => restarted.completeStep(id, 'second'), 'operation_terminal')
  assert.equal(restarted.getOperation(idleId).state, 'interrupted')
})

test('原子损坏：校验失败保留原文件并 fail-closed，不静默重建', (t) => {
  const root = fixture(t)
  const store = createOperationStore(root, scope(), { now: clock().now })
  const preview = makePreview(store, 'corrupt-request')
  const path = previewPath(root, preview.previewId)
  const original = readFileSync(path)

  const malformed = Buffer.from('{"schema":')
  writeFileSync(path, malformed, { mode: 0o600 })
  throwsCode(() => createOperationStore(root, scope(), { now: clock().now }), 'operation_store_corrupt')
  assert.deepEqual(readFileSync(path), malformed)

  writeFileSync(path, original, { mode: 0o600 })
  const changed = JSON.parse(original.toString('utf8'))
  changed.payload.view.after.note = 'tampered'
  const tampered = Buffer.from(JSON.stringify(changed))
  writeFileSync(path, tampered, { mode: 0o600 })
  throwsCode(() => createOperationStore(root, scope(), { now: clock().now }), 'operation_store_corrupt')
  assert.deepEqual(readFileSync(path), tampered)

  writeFileSync(path, original, { mode: 0o600 })
  assert.equal(createOperationStore(root, scope(), { now: clock().now }).readPreview(preview.previewId).requestId, 'corrupt-request')
  assert.equal(allFiles(root).some((file) => file.includes('.tmp-')), false)
})

test('崩溃残留：rename 前重启删除完整 owned 临时文件，不发布半条 preview', (t) => {
  const root = fixture(t)
  createOperationStore(root, scope(), { now: clock().now })
  crashPreviewWrite(root, 'before')

  const dir = join(root, 'alpha', 'previews')
  const names = readdirSync(dir)
  assert.equal(names.length, 1)
  assert.match(names[0], /^prv_[A-Za-z0-9_-]{43}\.json\.tmp-[1-9][0-9]*-[a-f0-9]{12}$/)
  const temporary = join(dir, names[0])
  assert.equal(statSync(temporary).mode & 0o777, 0o600)

  const restarted = createOperationStore(root, scope(), { now: clock().now })
  assert.equal(existsSync(temporary), false)
  assert.deepEqual(restarted.usage().records, { previews: 0, operations: 0, receipts: 0, commits: 0 })
})

test('崩溃残留：rename 后重启保留完整 preview，不留下临时文件', (t) => {
  const root = fixture(t)
  createOperationStore(root, scope(), { now: clock().now })
  crashPreviewWrite(root, 'after')

  const dir = join(root, 'alpha', 'previews')
  const names = readdirSync(dir)
  assert.equal(names.length, 1)
  assert.match(names[0], /^prv_[A-Za-z0-9_-]{43}\.json$/)

  const restarted = createOperationStore(root, scope(), { now: clock().now })
  assert.equal(restarted.readPreview(names[0].slice(0, -5)).requestId, 'crash-write')
  assert.equal(readdirSync(dir).some((name) => name.includes('.tmp-')), false)
})

test('崩溃残留：未知文件保持 fail-closed 且不得删除', (t) => {
  const root = fixture(t)
  createOperationStore(root, scope(), { now: clock().now })
  const path = join(root, 'alpha', 'previews', 'unknown.txt')
  writeFileSync(path, 'keep me', { mode: 0o600 })

  throwsCode(() => createOperationStore(root, scope(), { now: clock().now }), 'operation_store_corrupt')
  assert.equal(readFileSync(path, 'utf8'), 'keep me')
})

test('崩溃残留：owned 临时文件名对应的符号链接不得删除或跟随', (t) => {
  const root = fixture(t)
  const store = createOperationStore(root, scope(), { now: clock().now })
  const preview = makePreview(store, 'symlink-request')
  const target = previewPath(root, preview.previewId)
  const original = readFileSync(target)
  const temporary = target + '.tmp-4242-abcdef012345'
  symlinkSync(target, temporary)

  throwsCode(() => createOperationStore(root, scope(), { now: clock().now }), 'operation_store_corrupt')
  assert.equal(lstatSync(temporary).isSymbolicLink(), true)
  assert.deepEqual(readFileSync(target), original)
})

test('崩溃残留：畸形或非文件 owned 临时项保持 fail-closed 且原样保留', (t) => {
  const root = fixture(t)
  createOperationStore(root, scope(), { now: clock().now })
  const dir = join(root, 'alpha', 'previews')
  const malformed = join(dir, 'prv_' + 'a'.repeat(43) + '.json.tmp-4242-abcdef012345')
  const bytes = Buffer.from('{"schema":')
  writeFileSync(malformed, bytes, { mode: 0o600 })

  throwsCode(() => createOperationStore(root, scope(), { now: clock().now }), 'operation_store_corrupt')
  assert.deepEqual(readFileSync(malformed), bytes)

  rmSync(malformed)
  mkdirSync(malformed)
  throwsCode(() => createOperationStore(root, scope(), { now: clock().now }), 'operation_store_corrupt')
  assert.equal(lstatSync(malformed).isDirectory(), true)
})

test('容量：分类记录超限返回 429，拒绝操作不消费 preview，终态记录不静默删除', (t) => {
  const root = fixture(t)
  const options = {
    now: clock().now,
    maxRecordsPerCategory: { previews: 2, operations: 1, receipts: 1, commits: 1 },
  }
  const store = createOperationStore(root, scope(), options)
  const first = makePreview(store, 'quota-first')
  const second = makePreview(store, 'quota-second')
  const begun = store.beginOperation({
    previewId: first.previewId, confirmToken: first.confirmToken, requestId: 'quota-first', steps: [],
  })
  const before = snapshot(root)
  throwsCode(() => createOperationStore(root, scope(), {
    ...options,
    maxRecordsPerCategory: { ...options.maxRecordsPerCategory, previews: 1 },
  }), 'operation_record_limit_exceeded', 429)
  assert.deepEqual(snapshot(root), before)
  throwsCode(() => store.beginOperation({
    previewId: second.previewId, confirmToken: second.confirmToken, requestId: 'quota-second', steps: [],
  }), 'operation_record_limit_exceeded', 429)
  assert.deepEqual(snapshot(root), before)
  assert.equal(store.readPreview(second.previewId).state, 'pending')

  store.cancelOperation(begun.operation.operationId)
  throwsCode(() => store.beginOperation({
    previewId: second.previewId, confirmToken: second.confirmToken, requestId: 'quota-second', steps: [],
  }), 'operation_record_limit_exceeded', 429)
  assert.equal(store.getOperation(begun.operation.operationId).state, 'cancelled')
  throwsCode(() => store.cleanup({ operationId: begun.operation.operationId }), 'invalid_cleanup_confirmation', 400)
  store.cleanupOperation(begun.operation.operationId, { confirm: true })
  assert.equal(store.beginOperation({
    previewId: second.previewId, confirmToken: second.confirmToken, requestId: 'quota-second', steps: [],
  }).replayed, false)
})

test('容量：总字节超限返回 507，恢复超限 fail-closed 且不产生部分写入', (t) => {
  const root = fixture(t)
  const store = createOperationStore(root, scope(), { now: clock().now })
  const preview = makePreview(store, 'bytes-first', { plan: { payload: 'x'.repeat(12_000) } })
  const used = store.usage().totalBytes
  assert.ok(used > 12_000)
  const bounded = createOperationStore(root, scope(), { now: clock().now, maxTotalBytes: used })
  const before = snapshot(root)
  throwsCode(() => bounded.createPreview({ requestId: 'bytes-second', plan: { payload: 'y'.repeat(12_000) } }), 'operation_byte_limit_exceeded', 507)
  assert.deepEqual(snapshot(root), before)
  throwsCode(() => createOperationStore(root, scope(), { now: clock().now, maxTotalBytes: used - 1 }), 'operation_byte_limit_exceeded', 507)
  assert.deepEqual(snapshot(root), before)
  assert.equal(bounded.readPreview(preview.previewId).requestId, 'bytes-first')
})

test('容量：新操作预留 commit 空间，超限时确认令牌与回执均不变', (t) => {
  const root = fixture(t)
  const store = createOperationStore(root, scope(), { now: clock().now, maxTotalBytes: 7 * 1024 * 1024 })
  const first = makePreview(store, 'headroom-first')
  const second = makePreview(store, 'headroom-second')
  const begun = store.beginOperation({
    previewId: first.previewId, confirmToken: first.confirmToken, requestId: 'headroom-first', steps: ['write'],
  })
  const before = snapshot(root)
  throwsCode(() => store.beginOperation({
    previewId: second.previewId, confirmToken: second.confirmToken, requestId: 'headroom-second', steps: ['write'],
  }), 'operation_byte_limit_exceeded', 507)
  assert.deepEqual(snapshot(root), before)
  assert.equal(store.readPreview(second.previewId).state, 'pending')
  throwsCode(() => store.getRequestReceipt('headroom-second'), 'request_receipt_not_found')
  store.cancelOperation(begun.operation.operationId)
  assert.equal(store.beginOperation({
    previewId: second.previewId, confirmToken: second.confirmToken, requestId: 'headroom-second', steps: ['write'],
  }).replayed, false)
})

test('清理：仅剪除过期未消费 preview 和无 live operation 引用的过期回执', (t) => {
  const root = fixture(t)
  const time = clock(1000)
  const store = createOperationStore(root, scope(), { now: time.now, receiptTtlMs: 100 })
  const expiredPreview = makePreview(store, 'expired-unconsumed', { ttlMs: 10 })
  const terminalPreview = makePreview(store, 'terminal-receipt')
  const terminalId = store.beginOperation({
    previewId: terminalPreview.previewId, confirmToken: terminalPreview.confirmToken, requestId: 'terminal-receipt', steps: [],
  }).operation.operationId
  store.cancelOperation(terminalId)
  const livePreview = makePreview(store, 'live-receipt')
  const liveId = store.beginOperation({
    previewId: livePreview.previewId, confirmToken: livePreview.confirmToken, requestId: 'live-receipt', steps: ['write'],
  }).operation.operationId

  time.set(1011)
  store.cleanup()
  throwsCode(() => store.readPreview(expiredPreview.previewId), 'preview_not_found')
  assert.equal(store.getRequestReceipt('terminal-receipt').expired, false)

  time.set(1200)
  store.cleanup()
  throwsCode(() => store.getRequestReceipt('terminal-receipt'), 'request_receipt_not_found')
  assert.equal(store.getRequestReceipt('live-receipt').expired, true)
  assert.equal(store.getOperation(terminalId).state, 'cancelled')
  assert.equal(store.getOperation(liveId).state, 'running')
  const before = snapshot(root)
  throwsCode(() => store.cleanup({ operationId: liveId, confirm: true }), 'operation_not_terminal', 409)
  assert.deepEqual(snapshot(root), before)

  store.failOperation(liveId)
  store.cleanup()
  throwsCode(() => store.getRequestReceipt('live-receipt'), 'request_receipt_not_found')
  assert.equal(store.getOperation(liveId).state, 'failed')
  const restarted = createOperationStore(root, scope(), { now: time.now, receiptTtlMs: 100 })
  assert.deepEqual(restarted.usage().records, { previews: 2, operations: 2, receipts: 0, commits: 0 })
})

test('清理：commit marker 与终态操作仅由显式操作删除，清理 journal 可重启完成', (t) => {
  const root = fixture(t)
  const time = clock(1000)
  const store = createOperationStore(root, scope(), { now: time.now, receiptTtlMs: 100 })
  const preview = makePreview(store, 'committed-cleanup')
  const id = store.beginOperation({
    previewId: preview.previewId, confirmToken: preview.confirmToken, requestId: 'committed-cleanup', steps: [],
  }).operation.operationId
  store.commitOperation(id, { response: { ok: true } })
  time.set(2000)
  const restarted = createOperationStore(root, scope(), { now: time.now, receiptTtlMs: 100 })
  assert.deepEqual(restarted.usage().records, { previews: 1, operations: 1, receipts: 0, commits: 1 })
  restarted.cleanup({ operationId: id, confirm: true })
  assert.deepEqual(restarted.usage().records, { previews: 0, operations: 0, receipts: 0, commits: 0 })
  assert.deepEqual(createOperationStore(root, scope(), { now: time.now }).usage().records, restarted.usage().records)

  const second = makePreview(restarted, 'journal-cleanup')
  const secondId = restarted.beginOperation({
    previewId: second.previewId, confirmToken: second.confirmToken, requestId: 'journal-cleanup', steps: [],
  }).operation.operationId
  restarted.cancelOperation(secondId)
  const operation = payload(operationPath(root, secondId))
  const previewRecord = payload(previewPath(root, second.previewId))
  const receiptRecord = payload(join(root, 'alpha', 'receipts', readdirSync(join(root, 'alpha', 'receipts'))[0]))
  writeSealed(operationPath(root, secondId), {
    schema: CLEANUP_SCHEMA,
    version: CLEANUP_VERSION,
    operationId: secondId,
    previewId: second.previewId,
    requestId: second.requestId,
    owner: operation.owner,
    createdAtMs: time.now(),
    records: {
      previews: canonicalHash(previewRecord),
      commits: null,
      receipts: canonicalHash(receiptRecord),
    },
  })
  const recovered = createOperationStore(root, scope(), { now: time.now })
  assert.deepEqual(recovered.usage().records, { previews: 0, operations: 0, receipts: 0, commits: 0 })
})

test('恢复：过期但被操作引用的未消费 preview 不得剪除，先补绑定再终态化', (t) => {
  const root = fixture(t)
  const time = clock(1000)
  const store = createOperationStore(root, scope(), { now: time.now })
  const preview = makePreview(store, 'referenced-preview', { ttlMs: 10 })
  const id = store.beginOperation({
    previewId: preview.previewId, confirmToken: preview.confirmToken, requestId: 'referenced-preview', steps: ['write'],
  }).operation.operationId
  const path = previewPath(root, preview.previewId)
  const unbound = payload(path)
  writeSealed(path, { ...unbound, consumedAtMs: null, operationId: null })
  time.set(2000)
  const restarted = createOperationStore(root, scope(), { now: time.now })
  assert.equal(restarted.readPreview(preview.previewId).state, 'consumed')
  assert.equal(restarted.getOperation(id).state, 'interrupted')
})

test('恢复：稳定存储不重写；损坏或超限时不得先写 interrupted 恢复记录', (t) => {
  const root = fixture(t)
  const time = clock()
  const store = createOperationStore(root, scope(), { now: time.now })
  const stable = makePreview(store, 'stable-restart')
  const beforeStable = snapshot(root)
  assert.deepEqual(store.recover(), { previews: 1, operations: 0, receipts: 0, recovered: 0, deleted: 0 })
  createOperationStore(root, scope(), { now: time.now })
  assert.deepEqual(snapshot(root), beforeStable)
  assert.equal(store.readPreview(stable.previewId).state, 'pending')

  const runningPreview = makePreview(store, 'corrupt-recovery')
  const runningId = store.beginOperation({
    previewId: runningPreview.previewId, confirmToken: runningPreview.confirmToken, requestId: 'corrupt-recovery', steps: ['write'],
  }).operation.operationId
  store.startStep(runningId, 'write')
  const corruptPath = previewPath(root, stable.previewId)
  const original = readFileSync(corruptPath)
  writeFileSync(corruptPath, '{broken', { mode: 0o600 })
  const corrupted = snapshot(root)
  throwsCode(() => createOperationStore(root, scope(), { now: time.now }), 'operation_store_corrupt')
  assert.deepEqual(snapshot(root), corrupted)
  writeFileSync(corruptPath, original, { mode: 0o600 })

  const beforeLimit = snapshot(root)
  throwsCode(() => createOperationStore(root, scope(), { now: time.now, maxTotalBytes: 1 }), 'operation_byte_limit_exceeded', 507)
  assert.deepEqual(snapshot(root), beforeLimit)
  assert.equal(createOperationStore(root, scope(), { now: time.now }).getOperation(runningId).state, 'unknown')
})

test('限制：无效配置在创建 owner 目录前拒绝，缺失目录按损坏处理', (t) => {
  const root = fixture(t)
  throwsCode(() => createOperationStore(root, scope(), { maxRecordsPerCategory: 0 }), 'invalid_limit', 400)
  throwsCode(() => createOperationStore(root, scope(), { maxRecordsPerCategory: { unknown: 1 } }), 'invalid_limit', 400)
  throwsCode(() => createOperationStore(root, scope(), { maxTotalBytes: 0 }), 'invalid_limit', 400)
  assert.deepEqual(readdirSync(root), [])

  const store = createOperationStore(root, scope(), { now: clock().now })
  makePreview(store, 'missing-directory')
  rmSync(join(root, 'alpha', 'previews'), { recursive: true })
  throwsCode(() => createOperationStore(root, scope(), { now: clock().now }), 'operation_store_corrupt')
  assert.throws(() => statSync(join(root, 'alpha', 'previews')), { code: 'ENOENT' })
})
