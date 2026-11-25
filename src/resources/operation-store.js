// Durable, scope-bound preview/operation receipts for the resource APIs.
//
// Exports: OPERATION_SCHEMA/VERSION, PREVIEW_SCHEMA/VERSION, RECEIPT_SCHEMA/VERSION,
// COMMIT_SCHEMA/VERSION, CLEANUP_SCHEMA/VERSION, OperationStoreError, and
// createOperationStore(root, scope, opts). A store is bound to one verified { scopeId, actorId }
// (a scopeId string is also accepted). opts.maxRecordsPerCategory is a positive integer (or a
// per-category object) and opts.maxTotalBytes bounds the whole owner directory.
// Methods: createPreview/readPreview, beginOperation/getOperation, startStep/completeStep/
// failStep, commitOperation/failOperation/cancelOperation, getRequestReceipt/replayRequest,
// usage/cleanup, and recover(). All methods are synchronous; use one writer per root/scope.
//
// Layout: <root>/<directoryScope||scopeId>/{previews,operations,receipts,commits}/<id>.json. Records are
// checksummed JSON, written with fsync + atomic rename at mode 0600. Plaintext confirmation
// tokens are returned only by createPreview(); disk records contain only SHA-256(token).
// Under the single-writer contract, restart removes only fully validated, correctly named
// owned temporaries left by an interrupted atomic write; unknown or malformed entries fail closed.
// Recovery rolls forward a durable commit marker, otherwise marks unfinished work
// interrupted (no step started) or unknown (a step may have committed). It never replays steps.
// Expired unconsumed previews and expired receipts without a live operation may be pruned;
// audit operations and commit markers require explicit cleanup({ operationId, confirm: true }).
// Callers must startStep() before each side effect and completeStep() only after its outcome
// is known; this module records progress but never executes or retries application work.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  chmodSync, closeSync, constants, fchmodSync, fsyncSync, fstatSync, lstatSync,
  mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeSync,
} from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'

export const PREVIEW_SCHEMA = 'modelgate-resource-preview'
export const PREVIEW_VERSION = 1
export const OPERATION_SCHEMA = 'modelgate-resource-operation'
export const OPERATION_VERSION = 1
export const RECEIPT_SCHEMA = 'modelgate-operation-request-receipt'
export const RECEIPT_VERSION = 1
export const COMMIT_SCHEMA = 'modelgate-operation-commit'
export const COMMIT_VERSION = 1
export const CLEANUP_SCHEMA = 'modelgate-operation-cleanup'
export const CLEANUP_VERSION = 1

const STORE_SCHEMA = 'modelgate-operation-store-record'
const STORE_VERSION = 1
const MAX_RECORD_BYTES = 2 * 1024 * 1024
const MAX_RECORD_FILE_BYTES = MAX_RECORD_BYTES + 1024
const DEFAULT_MAX_RECORDS_PER_CATEGORY = 10_000
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024
const CATEGORIES = Object.freeze(['previews', 'operations', 'receipts', 'commits'])
const MAX_JSON_DEPTH = 32
const DEFAULT_PREVIEW_TTL_MS = 5 * 60 * 1000
const DEFAULT_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000
const MAX_PREVIEW_TTL_MS = 15 * 60 * 1000
const MAX_RECEIPT_TTL_MS = 30 * 24 * 60 * 60 * 1000
const MAX_STEPS = 100
const PREVIEW_ID_RE = /^prv_[A-Za-z0-9_-]{43}$/
const OPERATION_ID_RE = /^op_[A-Za-z0-9_-]{43}$/
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
const HASH_RE = /^[a-f0-9]{64}$/
const SCOPE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const STEP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const OWNED_TEMP_SUFFIX_RE = /\.tmp-[1-9][0-9]*-[a-f0-9]{12}$/
const OPERATION_STATES = new Set(['pending', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted', 'unknown'])
const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'unknown'])
const STEP_STATES = new Set(['pending', 'running', 'succeeded', 'failed', 'unknown'])
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const API_STORES = new Map()
const DEFAULT_API_SCOPE = Object.freeze({ scopeId: 'local', actorId: null })
const OPERATION_ROUTE_RE = /^\/api\/(?:services|models|pools|connections|harness-bindings|harnesses|config\/backups|config\/write-operations)\/operations\/([^/]+)(?:\/cancel)?$/

export class OperationStoreError extends Error {
  constructor(code, message, options = {}) {
    super(message || code)
    this.name = 'OperationStoreError'
    this.code = code
    this.status = Number.isInteger(options.status) ? options.status : 500
    if (options.details) this.details = options.details
  }
}

function fail(code, message, status = 500, details) {
  return new OperationStoreError(code, message, { status, details })
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function cloneJson(value, depth = 0, path = 'value') {
  if (depth > MAX_JSON_DEPTH) throw fail('invalid_json_depth', path + ' exceeds the maximum depth', 400)
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw fail('invalid_json_value', path + ' must be finite', 400)
    return value
  }
  if (Array.isArray(value)) return value.map((entry, index) => cloneJson(entry, depth + 1, path + '[' + index + ']'))
  if (!isPlainObject(value)) throw fail('invalid_json_value', path + ' must be plain JSON', 400)
  const out = {}
  for (const key of Object.keys(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) {
      throw fail('invalid_reserved_key', path + ' contains a reserved key', 400)
    }
    if (key.toLowerCase() === 'confirmtoken') {
      throw fail('confirmation_token_not_storable', 'confirmToken must never be persisted', 400)
    }
    out[key] = cloneJson(value[key], depth + 1, path + '.' + key)
  }
  return out
}

function canonical(value) {
  return JSON.stringify(cloneJson(value))
}

function hashCanonical(value) {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex')
}

function sameHash(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false
  return timingSafeEqual(Buffer.from(left), Buffer.from(right))
}

function sameJson(left, right) {
  return canonical(left) === canonical(right)
}

function assertJsonSize(value) {
  if (Buffer.byteLength(canonical(value)) > MAX_RECORD_BYTES) {
    throw fail('invalid_size', 'operation store record exceeds the size limit', 400)
  }
}

function normalizeNow(value) {
  const now = Number(value)
  if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000) {
    throw fail('invalid_clock', 'now must be a finite non-negative timestamp', 400)
  }
  return now
}

function iso(value) {
  return new Date(value).toISOString()
}

function normalizeTtl(value, fallback, maximum, name) {
  const ttl = value === undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > maximum) {
    throw fail('invalid_ttl', name + ' must be an integer between 1 and ' + maximum, 400)
  }
  return ttl
}

function normalizePositiveInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0 || number > maximum) {
    throw fail('invalid_limit', name + ' must be a positive safe integer', 400)
  }
  return number
}

function normalizeRecordLimits(value) {
  if (value === undefined) {
    return Object.fromEntries(CATEGORIES.map((category) => [category, DEFAULT_MAX_RECORDS_PER_CATEGORY]))
  }
  if (isPlainObject(value)) {
    const unknown = Object.keys(value).find((key) => !CATEGORIES.includes(key))
    if (unknown) throw fail('invalid_limit', 'unknown operation record category: ' + unknown, 400)
    return Object.fromEntries(CATEGORIES.map((category) => [
      category,
      value[category] === undefined
        ? DEFAULT_MAX_RECORDS_PER_CATEGORY
        : normalizePositiveInteger(value[category], 'maxRecordsPerCategory.' + category),
    ]))
  }
  const limit = normalizePositiveInteger(value, 'maxRecordsPerCategory')
  return Object.fromEntries(CATEGORIES.map((category) => [category, limit]))
}

function normalizeRequestId(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw fail('invalid_request_id', 'requestId must be a safe 1–100 character string', 400)
  }
  return value.trim()
}

function normalizeFingerprint(value) {
  if (typeof value !== 'string' || !HASH_RE.test(value)) {
    throw fail('invalid_request_fingerprint', 'requestFingerprint must be a SHA-256 hex digest', 400)
  }
  return value
}

function normalizeScope(scope) {
  const source = typeof scope === 'string' ? { scopeId: scope } : scope
  if (!isPlainObject(source) || typeof source.scopeId !== 'string' || !SCOPE_RE.test(source.scopeId)) {
    throw fail('invalid_scope', 'scope must contain a safe scopeId', 400)
  }
  if (['__proto__', 'constructor', 'prototype'].includes(source.scopeId)) {
    throw fail('invalid_scope', 'scopeId is reserved', 400)
  }
  let actorId = null
  if (source.actorId != null) {
    if (typeof source.actorId !== 'string' || !source.actorId.trim() || source.actorId.length > 128 || /[\u0000-\u001f\u007f]/.test(source.actorId)) {
      throw fail('invalid_scope', 'actorId must be a safe 1–128 character string', 400)
    }
    actorId = source.actorId.trim()
  }
  return Object.freeze({ scopeId: source.scopeId, actorId })
}

function normalizeOwner(value) {
  if (!isPlainObject(value) || typeof value.scopeId !== 'string' || !SCOPE_RE.test(value.scopeId) ||
      !(value.actorId === null || (typeof value.actorId === 'string' && value.actorId.length > 0 && value.actorId.length <= 128))) {
    throw fail('operation_store_corrupt', 'stored owner is invalid')
  }
  return { scopeId: value.scopeId, actorId: value.actorId }
}

function assertOwner(record, owner) {
  if (record.owner.scopeId !== owner.scopeId || record.owner.actorId !== owner.actorId) {
    throw fail('operation_scope_mismatch', 'record belongs to a different scope', 403)
  }
}

function newId(prefix) {
  return prefix + randomBytes(32).toString('base64url')
}

function assertPreviewId(value) {
  if (typeof value !== 'string' || !PREVIEW_ID_RE.test(value)) throw fail('invalid_preview_id', 'invalid previewId', 400)
  return value
}

function assertOperationId(value) {
  if (typeof value !== 'string' || !OPERATION_ID_RE.test(value)) throw fail('invalid_operation_id', 'invalid operationId', 400)
  return value
}

function normalizeStepId(value) {
  if (typeof value !== 'string' || !STEP_ID_RE.test(value)) throw fail('invalid_step_id', 'invalid step id', 400)
  return value
}

function normalizeSteps(value) {
  const list = value === undefined ? ['config-transaction'] : value
  if (!Array.isArray(list) || list.length > MAX_STEPS) throw fail('invalid_steps', 'steps must be an array of at most ' + MAX_STEPS + ' entries', 400)
  const seen = new Set()
  return list.map((entry) => {
    const id = normalizeStepId(typeof entry === 'string' ? entry : entry?.id)
    if (seen.has(id)) throw fail('invalid_steps', 'step ids must be unique', 400)
    seen.add(id)
    return { id, state: 'pending', attempts: 0, startedAtMs: null, endedAtMs: null, result: null, error: null }
  })
}

function progressOf(steps) {
  const progress = { total: steps.length, pending: 0, running: 0, completed: 0, failed: 0, unknown: 0 }
  for (const step of steps) {
    if (step.state === 'succeeded') progress.completed += 1
    else if (step.state === 'failed') progress.failed += 1
    else if (step.state === 'unknown') progress.unknown += 1
    else progress[step.state] += 1
  }
  return progress
}

function errorOf(input, fallbackCode) {
  if (isPlainObject(input?.error)) return cloneJson(input.error)
  return {
    code: typeof input?.code === 'string' && input.code ? input.code : fallbackCode,
    message: typeof input?.message === 'string' && input.message
      ? input.message
      : (typeof input?.error === 'string' && input.error ? input.error : fallbackCode),
  }
}

function ensureDirectory(path, privateDirectory = false) {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 })
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw fail('operation_store_unavailable', 'store path is not a real directory')
    if (privateDirectory && (stat.mode & 0o077)) chmodSync(path, 0o700)
  } catch (error) {
    if (error instanceof OperationStoreError) throw error
    throw fail('operation_store_unavailable', 'cannot create or access the operation store')
  }
}

function requireDirectory(path) {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw corrupt(path, 'operation store directory is invalid')
    if (stat.mode & 0o077) chmodSync(path, 0o700)
  } catch (error) {
    if (error instanceof OperationStoreError) throw error
    if (error?.code === 'ENOENT') throw corrupt(path, 'operation store directory is missing')
    throw fail('operation_store_unavailable', 'cannot access the operation store')
  }
}

function fsyncDirectory(path) {
  let fd = null
  try {
    fd = openSync(path, constants.O_RDONLY)
    fsyncSync(fd)
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EBADF'].includes(error?.code)) throw error
  } finally {
    if (fd !== null) try { closeSync(fd) } catch {}
  }
}

function writeAll(fd, bytes) {
  let offset = 0
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset)
    if (written <= 0) throw new Error('short write')
    offset += written
  }
}

function sealRecord(payload) {
  assertJsonSize(payload)
  const body = { schema: STORE_SCHEMA, version: STORE_VERSION, payload: cloneJson(payload) }
  return { ...body, checksum: hashCanonical(body) }
}

function writeRecord(path, payload) {
  const record = sealRecord(payload)
  const bytes = Buffer.from(JSON.stringify(record))
  if (bytes.length > MAX_RECORD_BYTES + 1024) throw fail('invalid_size', 'operation store record exceeds the size limit', 400)
  ensureDirectory(dirname(path), true)
  const temporary = path + '.tmp-' + process.pid + '-' + randomBytes(6).toString('hex')
  let fd = null
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600)
    fchmodSync(fd, 0o600)
    writeAll(fd, bytes)
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(temporary, path)
    fsyncDirectory(dirname(path))
  } catch (error) {
    if (fd !== null) try { closeSync(fd) } catch {}
    try { unlinkSync(temporary) } catch {}
    if (error instanceof OperationStoreError) throw error
    throw fail('operation_store_write_failed', 'cannot atomically write the operation store')
  }
}

function corrupt(path, message = 'operation store record is corrupt') {
  return fail('operation_store_corrupt', message, 500, { file: basename(path) })
}

function readRecordMeta(path) {
  let fd = null
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || stat.size > MAX_RECORD_FILE_BYTES) throw corrupt(path)
    const bytes = readFileSync(fd)
    if (bytes.length > MAX_RECORD_FILE_BYTES) throw corrupt(path)
    const record = JSON.parse(bytes.toString('utf8'))
    if (!isPlainObject(record) || Object.keys(record).sort().join(',') !== 'checksum,payload,schema,version' ||
        record.schema !== STORE_SCHEMA || record.version !== STORE_VERSION || !HASH_RE.test(record.checksum) ||
        !isPlainObject(record.payload)) throw corrupt(path)
    const expected = hashCanonical({ schema: record.schema, version: record.version, payload: record.payload })
    if (!sameHash(record.checksum, expected)) throw corrupt(path, 'operation store checksum mismatch')
    return { payload: record.payload, bytes: bytes.length, hash: hashCanonical(record.payload) }
  } catch (error) {
    if (error instanceof OperationStoreError) throw error
    if (error?.code === 'ENOENT') return null
    throw corrupt(path)
  } finally {
    if (fd !== null) try { closeSync(fd) } catch {}
  }
}

function readRecord(path) {
  return readRecordMeta(path)?.payload ?? null
}

function recordBytes(payload) {
  const bytes = Buffer.from(JSON.stringify(sealRecord(payload)))
  if (bytes.length > MAX_RECORD_FILE_BYTES) throw fail('invalid_size', 'operation store record exceeds the size limit', 400)
  return bytes.length
}

function optionalRecord(path) {
  try {
    lstatSync(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw corrupt(path)
  }
  return readRecord(path)
}

function validateOwner(value) {
  return normalizeOwner(value)
}

function validatePreview(value, id) {
  if (!isPlainObject(value) || value.schema !== PREVIEW_SCHEMA || value.version !== PREVIEW_VERSION ||
      value.previewId !== id || !PREVIEW_ID_RE.test(id) || !HASH_RE.test(value.tokenHash) ||
      !HASH_RE.test(value.planHash) || !isPlainObject(value.plan) || !isPlainObject(value.view) ||
      !Number.isSafeInteger(value.createdAtMs) || !Number.isSafeInteger(value.expiresAtMs) || value.expiresAtMs <= value.createdAtMs ||
      !(value.consumedAtMs === null || Number.isSafeInteger(value.consumedAtMs)) ||
      !(value.operationId === null || OPERATION_ID_RE.test(value.operationId)) ||
      (value.consumedAtMs === null) !== (value.operationId === null)) throw corrupt('preview')
  validateOwner(value.owner)
  try { normalizeRequestId(value.requestId) } catch { throw corrupt('preview') }
  return value
}

function validateOperation(value, id) {
  if (!isPlainObject(value) || value.schema !== OPERATION_SCHEMA || value.version !== OPERATION_VERSION ||
      value.operationId !== id || !OPERATION_ID_RE.test(id) || !PREVIEW_ID_RE.test(value.previewId) ||
      !HASH_RE.test(value.planHash) || !HASH_RE.test(value.requestFingerprint) ||
      !OPERATION_STATES.has(value.state) || value.terminal !== TERMINAL_STATES.has(value.state) ||
      !Number.isSafeInteger(value.createdAtMs) || !Number.isSafeInteger(value.updatedAtMs) ||
      !(value.committedAtMs === null || Number.isSafeInteger(value.committedAtMs)) ||
      !(value.terminalAtMs === null || Number.isSafeInteger(value.terminalAtMs)) ||
      (value.terminal && value.terminalAtMs === null) || (!value.terminal && value.terminalAtMs !== null) ||
      (value.state === 'succeeded') !== (value.committedAtMs !== null) || !Array.isArray(value.steps) || value.steps.length > MAX_STEPS) {
    throw corrupt('operation')
  }
  validateOwner(value.owner)
  try { normalizeRequestId(value.requestId) } catch { throw corrupt('operation') }
  const seen = new Set()
  for (const step of value.steps) {
    if (!isPlainObject(step) || !STEP_ID_RE.test(step.id) || seen.has(step.id) || !STEP_STATES.has(step.state) ||
        !Number.isSafeInteger(step.attempts) || step.attempts < 0 || step.attempts > 1 ||
        !(step.startedAtMs === null || Number.isSafeInteger(step.startedAtMs)) ||
        !(step.endedAtMs === null || Number.isSafeInteger(step.endedAtMs))) throw corrupt('operation')
    seen.add(step.id)
    if ((step.state === 'pending' && (step.attempts !== 0 || step.startedAtMs !== null || step.endedAtMs !== null)) ||
        (step.state === 'running' && (step.attempts !== 1 || step.startedAtMs === null || step.endedAtMs !== null)) ||
        (['succeeded', 'failed', 'unknown'].includes(step.state) && (step.attempts !== 1 || step.startedAtMs === null || step.endedAtMs === null))) {
      throw corrupt('operation')
    }
  }
  if (!isPlainObject(value.progress) || !sameJson(value.progress, progressOf(value.steps))) throw corrupt('operation')
  for (const field of ['error', 'recovery']) {
    if (value[field] !== null && !isPlainObject(value[field])) throw corrupt('operation')
  }
  return value
}

function validateReceipt(value, requestId) {
  if (!isPlainObject(value) || value.schema !== RECEIPT_SCHEMA || value.version !== RECEIPT_VERSION ||
      value.requestId !== requestId || !HASH_RE.test(value.requestFingerprint) || !PREVIEW_ID_RE.test(value.previewId) ||
      !OPERATION_ID_RE.test(value.operationId) || !OPERATION_STATES.has(value.state) || value.terminal !== TERMINAL_STATES.has(value.state) ||
      !Number.isSafeInteger(value.createdAtMs) || !Number.isSafeInteger(value.updatedAtMs) ||
      !Number.isSafeInteger(value.expiresAtMs) || value.expiresAtMs <= value.createdAtMs) throw corrupt('receipt')
  validateOwner(value.owner)
  return value
}

function validateMarker(value, operationId) {
  if (!isPlainObject(value) || value.schema !== COMMIT_SCHEMA || value.version !== COMMIT_VERSION ||
      value.operationId !== operationId || !OPERATION_ID_RE.test(operationId) ||
      !Number.isSafeInteger(value.committedAtMs) || !HASH_RE.test(value.operationHash)) throw corrupt('commit')
  validateOwner(value.owner)
  validateOperation(value.operation, operationId)
  if (value.operation.state !== 'succeeded' || !value.operation.terminal || value.operation.committedAtMs !== value.committedAtMs ||
      !sameHash(value.operationHash, hashCanonical(value.operation))) throw corrupt('commit')
  return value
}

function validateCleanup(value, operationId) {
  if (!isPlainObject(value) || value.schema !== CLEANUP_SCHEMA || value.version !== CLEANUP_VERSION ||
      value.operationId !== operationId || !OPERATION_ID_RE.test(operationId) || !PREVIEW_ID_RE.test(value.previewId) ||
      typeof value.requestId !== 'string' || !Number.isSafeInteger(value.createdAtMs) || !isPlainObject(value.records)) throw corrupt('cleanup')
  validateOwner(value.owner)
  try { normalizeRequestId(value.requestId) } catch { throw corrupt('cleanup') }
  if (Object.keys(value.records).sort().join(',') !== 'commits,previews,receipts') throw corrupt('cleanup')
  if (!HASH_RE.test(value.records.previews)) throw corrupt('cleanup')
  for (const category of ['commits', 'receipts']) {
    if (value.records[category] !== null && !HASH_RE.test(value.records[category])) throw corrupt('cleanup')
  }
  return value
}

function publicPreview(preview, token, includePlan = false) {
  const out = {
    ...cloneJson(preview.view),
    schema: PREVIEW_SCHEMA,
    version: PREVIEW_VERSION,
    previewId: preview.previewId,
    requestId: preview.requestId,
    planHash: preview.planHash,
    expiresAt: iso(preview.expiresAtMs),
    state: preview.consumedAtMs === null ? 'pending' : 'consumed',
    scopeId: preview.owner.scopeId,
  }
  if (token) out.confirmToken = token
  if (includePlan) out.plan = cloneJson(preview.plan)
  return out
}

function publicOperation(operation) {
  return {
    schema: OPERATION_SCHEMA,
    version: OPERATION_VERSION,
    operationId: operation.operationId,
    previewId: operation.previewId,
    requestId: operation.requestId,
    planHash: operation.planHash,
    scopeId: operation.owner.scopeId,
    state: operation.state,
    terminal: operation.terminal,
    createdAt: iso(operation.createdAtMs),
    updatedAt: iso(operation.updatedAtMs),
    committedAt: operation.committedAtMs === null ? null : iso(operation.committedAtMs),
    terminalAt: operation.terminalAtMs === null ? null : iso(operation.terminalAtMs),
    progress: cloneJson(operation.progress),
    steps: cloneJson(operation.steps).map((step) => ({
      ...step,
      startedAt: step.startedAtMs === null ? null : iso(step.startedAtMs),
      endedAt: step.endedAtMs === null ? null : iso(step.endedAtMs),
    })),
    result: cloneJson(operation.result),
    error: cloneJson(operation.error),
    response: cloneJson(operation.response),
    recovery: cloneJson(operation.recovery),
  }
}

function publicOperationSummary(operation) {
  const { result, error, response, ...summary } = publicOperation(operation)
  return summary
}

function publicReceipt(receipt, now) {
  return {
    schema: RECEIPT_SCHEMA,
    version: RECEIPT_VERSION,
    requestId: receipt.requestId,
    previewId: receipt.previewId,
    operationId: receipt.operationId,
    scopeId: receipt.owner.scopeId,
    state: receipt.state,
    terminal: receipt.terminal,
    createdAt: iso(receipt.createdAtMs),
    updatedAt: iso(receipt.updatedAtMs),
    expiresAt: iso(receipt.expiresAtMs),
    expired: receipt.expiresAtMs <= now,
    response: cloneJson(receipt.response),
  }
}

export class OperationStore {
  constructor(root, scope, options = {}) {
    if (typeof root !== 'string' || !root.trim()) throw fail('invalid_root', 'root must be a non-empty path', 400)
    if (!isPlainObject(options)) throw fail('invalid_options', 'options must be an object', 400)
    this.root = resolve(root)
    if (this.root === sep) throw fail('invalid_root', 'filesystem root cannot be used as the store', 400)
    this.owner = normalizeScope(scope)
    this._now = typeof options.now === 'function' ? options.now : Date.now
    this._receiptTtlMs = normalizeTtl(options.receiptTtlMs, DEFAULT_RECEIPT_TTL_MS, MAX_RECEIPT_TTL_MS, 'receiptTtlMs')
    this._maxRecords = Object.freeze(normalizeRecordLimits(options.maxRecordsPerCategory))
    this._maxTotalBytes = options.maxTotalBytes === undefined
      ? DEFAULT_MAX_TOTAL_BYTES
      : normalizePositiveInteger(options.maxTotalBytes, 'maxTotalBytes')
    const directoryScope = options.directoryScope === undefined ? this.owner.scopeId : options.directoryScope
    if (typeof directoryScope !== 'string' || !SCOPE_RE.test(directoryScope)) throw fail('invalid_scope', 'directoryScope must be a safe scope identifier', 400)
    this.scopeDir = resolve(this.root, directoryScope)
    if (!this.scopeDir.startsWith(this.root + sep)) throw fail('invalid_scope', 'scope path escapes the store root', 400)
    this.dirs = {
      previews: join(this.scopeDir, 'previews'),
      operations: join(this.scopeDir, 'operations'),
      receipts: join(this.scopeDir, 'receipts'),
      commits: join(this.scopeDir, 'commits'),
    }
    ensureDirectory(this.root)
    let ownerExists = true
    try { lstatSync(this.scopeDir) } catch (error) {
      if (error?.code !== 'ENOENT') throw fail('operation_store_unavailable', 'cannot access the operation store')
      ownerExists = false
    }
    if (ownerExists) {
      requireDirectory(this.scopeDir)
      for (const dir of Object.values(this.dirs)) requireDirectory(dir)
    } else {
      ensureDirectory(this.scopeDir, true)
      for (const dir of Object.values(this.dirs)) ensureDirectory(dir, true)
    }
    this.recover()
  }

  _nowMs() {
    return normalizeNow(this._now())
  }

  _previewPath(id) {
    assertPreviewId(id)
    return join(this.dirs.previews, id + '.json')
  }

  _operationPath(id) {
    assertOperationId(id)
    return join(this.dirs.operations, id + '.json')
  }

  _receiptPath(requestId) {
    const normalized = normalizeRequestId(requestId)
    return join(this.dirs.receipts, createHash('sha256').update(this.owner.scopeId + '\u0000' + normalized).digest('hex') + '.json')
  }

  _markerPath(id) {
    assertOperationId(id)
    return join(this.dirs.commits, id + '.json')
  }

  _loadPreview(id) {
    const value = optionalRecord(this._previewPath(id))
    if (!value) return null
    validatePreview(value, id)
    assertOwner(value, this.owner)
    return value
  }

  _loadOperation(id) {
    const value = optionalRecord(this._operationPath(id))
    if (!value) return null
    validateOperation(value, id)
    assertOwner(value, this.owner)
    return value
  }

  _loadReceipt(requestId) {
    const value = optionalRecord(this._receiptPath(requestId))
    if (!value) return null
    validateReceipt(value, normalizeRequestId(requestId))
    assertOwner(value, this.owner)
    return value
  }

  _loadMarker(id) {
    const value = optionalRecord(this._markerPath(id))
    if (!value) return null
    validateMarker(value, id)
    assertOwner(value, this.owner)
    return value
  }

  _ids(dir, prefix, regex) {
    let names
    try { names = readdirSync(dir) } catch (error) { throw fail('operation_store_unavailable', 'cannot list the operation store') }
    return names.filter((name) => name.startsWith(prefix) && name.endsWith('.json') && regex.test(name.slice(0, -5))).map((name) => name.slice(0, -5)).sort()
  }

  _recoverStaleTemporaries() {
    const stale = []
    for (const category of CATEGORIES) {
      const dir = this.dirs[category]
      let names
      try { names = readdirSync(dir) } catch (error) { throw fail('operation_store_unavailable', 'cannot list the operation store') }
      for (const name of names.sort()) {
        if (!OWNED_TEMP_SUFFIX_RE.test(name)) continue
        const path = join(dir, name)
        const target = name.replace(OWNED_TEMP_SUFFIX_RE, '')
        let id
        if (category === 'previews') {
          if (!/^prv_[A-Za-z0-9_-]{43}\.json$/.test(target)) throw corrupt(path, 'operation store temporary filename is invalid')
          id = target.slice(0, -5)
        } else if (category === 'operations' || category === 'commits') {
          if (!/^op_[A-Za-z0-9_-]{43}\.json$/.test(target)) throw corrupt(path, 'operation store temporary filename is invalid')
          id = target.slice(0, -5)
        } else {
          if (!/^[a-f0-9]{64}\.json$/.test(target)) throw corrupt(path, 'operation store temporary filename is invalid')
          id = target.slice(0, -5)
        }
        // Under the single-writer contract an exact writeRecord temporary is stale. Its
        // generated name, regular-file type, mode, checksum, category and owner must all
        // validate before removal; anything else remains for fail-closed category checks.
        try { lstatSync(path) } catch (error) {
          if (error?.code === 'ENOENT') continue
          throw corrupt(path)
        }
        const meta = readRecordMeta(path)
        if (!meta) throw corrupt(path, 'operation store temporary disappeared during validation')
        const value = meta.payload
        if (category === 'previews') validatePreview(value, id)
        else if (category === 'operations') {
          if (value.schema === CLEANUP_SCHEMA) validateCleanup(value, id)
          else validateOperation(value, id)
        } else if (category === 'receipts') {
          validateReceipt(value, value?.requestId)
          if (this._receiptPath(value.requestId) !== join(dir, target)) throw corrupt(path, 'temporary receipt filename does not match its binding')
        } else validateMarker(value, id)
        assertOwner(value, this.owner)
        stale.push(path)
      }
    }
    return this._deletePaths(stale)
  }

  _categoryEntries(category, prefix, regex) {
    const dir = this.dirs[category]
    let names
    try { names = readdirSync(dir) } catch (error) { throw fail('operation_store_unavailable', 'cannot list the operation store') }
    const entries = []
    for (const name of names.sort()) {
      if (!name.endsWith('.json') || !name.startsWith(prefix) || !regex.test(name.slice(0, -5))) {
        throw corrupt(join(dir, name), 'operation store contains an unexpected file')
      }
      const id = name.slice(0, -5)
      const path = join(dir, name)
      const meta = readRecordMeta(path)
      if (!meta) throw corrupt(path, 'operation store record disappeared during validation')
      entries.push({ id, path, meta })
    }
    return entries
  }

  _scanStore(now) {
    let ownerEntries
    try { ownerEntries = readdirSync(this.scopeDir) } catch (error) { throw fail('operation_store_unavailable', 'cannot list the operation store') }
    for (const name of ownerEntries) {
      if (!CATEGORIES.includes(name)) throw corrupt(join(this.scopeDir, name), 'operation store contains an unexpected entry')
    }

    const staleTemporariesDeleted = this._recoverStaleTemporaries()
    const files = new Map()
    const previews = new Map()
    const operations = new Map()
    const receipts = new Map()
    const markers = new Map()
    let cleanup = null

    for (const entry of this._categoryEntries('previews', 'prv_', PREVIEW_ID_RE)) {
      validatePreview(entry.meta.payload, entry.id)
      assertOwner(entry.meta.payload, this.owner)
      previews.set(entry.id, entry.meta.payload)
      files.set(entry.path, { category: 'previews', ...entry.meta })
    }
    for (const entry of this._categoryEntries('operations', 'op_', OPERATION_ID_RE)) {
      files.set(entry.path, { category: 'operations', ...entry.meta })
      if (entry.meta.payload.schema === CLEANUP_SCHEMA) {
        if (cleanup) throw corrupt(entry.path, 'operation store has multiple cleanup journals')
        validateCleanup(entry.meta.payload, entry.id)
        assertOwner(entry.meta.payload, this.owner)
        cleanup = { journal: entry.meta.payload, path: entry.path }
      } else {
        validateOperation(entry.meta.payload, entry.id)
        assertOwner(entry.meta.payload, this.owner)
        operations.set(entry.id, entry.meta.payload)
      }
    }
    for (const entry of this._categoryEntries('receipts', '', HASH_RE)) {
      const receipt = entry.meta.payload
      validateReceipt(receipt, receipt?.requestId)
      assertOwner(receipt, this.owner)
      if (this._receiptPath(receipt.requestId) !== entry.path) throw corrupt(entry.path, 'request receipt filename does not match its binding')
      receipts.set(receipt.requestId, receipt)
      files.set(entry.path, { category: 'receipts', ...entry.meta })
    }
    for (const entry of this._categoryEntries('commits', 'op_', OPERATION_ID_RE)) {
      validateMarker(entry.meta.payload, entry.id)
      assertOwner(entry.meta.payload, this.owner)
      markers.set(entry.id, entry.meta.payload)
      files.set(entry.path, { category: 'commits', ...entry.meta })
    }

    if (cleanup) {
      const journal = cleanup.journal
      const targets = new Map([
        ['previews', new Map([[journal.previewId, { path: this._previewPath(journal.previewId), hash: journal.records.previews }]])],
        ['operations', new Map([[journal.operationId, { path: cleanup.path, hash: null }]])],
        ['receipts', new Map([[journal.requestId, { path: this._receiptPath(journal.requestId), hash: journal.records.receipts }]])],
        ['commits', new Map([[journal.operationId, { path: this._markerPath(journal.operationId), hash: journal.records.commits }]])],
      ])
      const records = { previews, operations, receipts, commits: markers }
      for (const [category, categoryTargets] of targets) {
        for (const [id, target] of categoryTargets) {
          if (category === 'operations') continue
          const file = files.get(target.path)
          if (!target.hash) {
            if (file) throw corrupt(target.path, 'cleanup journal found an unexpected target record')
          } else if (file && file.hash !== target.hash) {
            throw corrupt(target.path, 'cleanup target record changed after cleanup began')
          }
          records[category].delete(id)
        }
      }
      cleanup.targets = targets
    }

    const liveOperationIds = new Set()
    for (const [id, operation] of operations) {
      if (!operation.terminal) liveOperationIds.add(id)
      const marker = markers.get(id)
      if (marker && operation.terminal && !sameJson(operation, marker.operation)) {
        throw corrupt(this._operationPath(id), 'terminal operation conflicts with its commit marker')
      }
      const preview = previews.get(operation.previewId)
      if (!preview || preview.requestId !== operation.requestId || preview.planHash !== operation.planHash) {
        throw corrupt(this._operationPath(id), 'operation references a missing or mismatched preview')
      }
      if (preview.consumedAtMs !== null && preview.operationId !== id) {
        throw corrupt(this._previewPath(preview.previewId), 'preview is bound to another operation')
      }
    }
    for (const [id, marker] of markers) {
      if (!operations.has(id)) throw corrupt(this._markerPath(id), 'commit marker has no operation')
    }
    for (const [id, preview] of previews) {
      if (preview.consumedAtMs !== null && !operations.has(preview.operationId)) {
        throw corrupt(this._previewPath(id), 'consumed preview references a missing operation')
      }
    }
    for (const receipt of receipts.values()) {
      const operation = operations.get(receipt.operationId)
      if (!operation || operation.requestId !== receipt.requestId || operation.previewId !== receipt.previewId || operation.requestFingerprint !== receipt.requestFingerprint) {
        throw corrupt(this._receiptPath(receipt.requestId), 'request receipt references a missing or mismatched operation')
      }
    }
    return { files, previews, operations, receipts, markers, liveOperationIds, cleanup, staleTemporariesDeleted, now }
  }

  _project(inventory, writes, deletions = new Set()) {
    const files = new Map(inventory.files)
    for (const path of deletions) files.delete(path)
    for (const write of writes) {
      files.set(write.path, { category: write.category, bytes: recordBytes(write.payload), hash: hashCanonical(write.payload) })
    }
    const counts = Object.fromEntries(CATEGORIES.map((category) => [category, 0]))
    let totalBytes = 0
    for (const file of files.values()) {
      counts[file.category] += 1
      totalBytes += file.bytes
    }

    const operations = new Map(inventory.operations)
    const receipts = new Map(inventory.receipts)
    const markers = new Map(inventory.markers)
    for (const path of deletions) {
      for (const [id, operation] of operations) if (this._operationPath(id) === path) operations.delete(id)
      for (const [id, marker] of markers) if (this._markerPath(id) === path) markers.delete(id)
      for (const [requestId, receipt] of receipts) if (this._receiptPath(requestId) === path) receipts.delete(requestId)
    }
    for (const write of writes) {
      if (write.category === 'operations') {
        if (write.payload.schema === CLEANUP_SCHEMA) operations.delete(write.payload.operationId)
        else operations.set(write.payload.operationId, write.payload)
      } else if (write.category === 'receipts') receipts.set(write.payload.requestId, write.payload)
      else if (write.category === 'commits') markers.set(write.payload.operationId, write.payload)
    }

    let reservedCommitRecords = 0
    let reservedBytes = 0
    for (const operation of operations.values()) {
      if (operation.terminal || markers.has(operation.operationId)) continue
      reservedCommitRecords += 1
      const operationBytes = files.get(this._operationPath(operation.operationId))?.bytes ?? 0
      const receiptBytes = files.get(this._receiptPath(operation.requestId))?.bytes ?? 0
      // A live operation may still grow its operation/receipt and gain a commit marker.
      reservedBytes += Math.max(0, (3 * MAX_RECORD_FILE_BYTES) - operationBytes - receiptBytes)
    }
    const requiredBytes = totalBytes + reservedBytes
    for (const category of CATEGORIES) {
      const requiredRecords = counts[category] + (category === 'commits' ? reservedCommitRecords : 0)
      if (requiredRecords > this._maxRecords[category]) {
        throw fail('operation_record_limit_exceeded', 'operation store record limit exceeded for ' + category, 429, {
          category, limit: this._maxRecords[category], current: counts[category], requested: requiredRecords,
        })
      }
    }
    if (requiredBytes > this._maxTotalBytes) {
      throw fail('operation_byte_limit_exceeded', 'operation store byte limit exceeded', 507, {
        limit: this._maxTotalBytes, current: totalBytes, requested: requiredBytes, reserved: reservedBytes,
      })
    }
    return { files, counts, totalBytes, requiredBytes, reservedCommitRecords, reservedBytes }
  }

  _eligiblePrunes(inventory) {
    const deletions = new Set()
    const referencedPreviews = new Set([...inventory.operations.values()].map((operation) => operation.previewId))
    for (const [id, preview] of inventory.previews) {
      if (preview.consumedAtMs === null && preview.expiresAtMs <= inventory.now && !referencedPreviews.has(id)) {
        deletions.add(this._previewPath(id))
      }
    }
    for (const receipt of inventory.receipts.values()) {
      if (receipt.expiresAtMs <= inventory.now && !inventory.liveOperationIds.has(receipt.operationId)) {
        deletions.add(this._receiptPath(receipt.requestId))
      }
    }
    return deletions
  }

  _deletePaths(paths) {
    let deleted = 0
    const directories = new Set()
    for (const path of paths) {
      try { unlinkSync(path) } catch (error) {
        if (error?.code === 'ENOENT') continue
        throw fail('operation_store_write_failed', 'cannot remove an operation store record')
      }
      deleted += 1
      directories.add(dirname(path))
    }
    for (const directory of directories) {
      try { fsyncDirectory(directory) } catch { throw fail('operation_store_write_failed', 'cannot durably remove an operation store record') }
    }
    return deleted
  }

  _writeRecords(writes, now = this._nowMs()) {
    const inventory = this._scanStore(now)
    const deletions = this._eligiblePrunes(inventory)
    let cleanupJournal = null
    if (inventory.cleanup) {
      cleanupJournal = inventory.cleanup.path
      for (const [category, targets] of inventory.cleanup.targets) {
        if (category === 'operations') continue
        for (const target of targets.values()) deletions.add(target.path)
      }
    }
    const projectionDeletions = new Set(deletions)
    if (cleanupJournal) projectionDeletions.add(cleanupJournal)
    const projected = this._project(inventory, writes, projectionDeletions)
    let deleted = this._deletePaths(deletions)
    for (const write of writes) writeRecord(write.path, write.payload)
    if (cleanupJournal) deleted += this._deletePaths([cleanupJournal])
    return { inventory, projected, deleted: inventory.staleTemporariesDeleted + deleted }
  }

  usage() {
    const inventory = this._scanStore(this._nowMs())
    const counts = Object.fromEntries(CATEGORIES.map((category) => [category, 0]))
    let totalBytes = 0
    for (const file of inventory.files.values()) {
      counts[file.category] += 1
      totalBytes += file.bytes
    }
    return {
      records: counts,
      totalBytes,
      maxRecordsPerCategory: { ...this._maxRecords },
      maxTotalBytes: this._maxTotalBytes,
    }
  }

  _receiptFor(operation, existing = null, now = this._nowMs()) {
    return {
      schema: RECEIPT_SCHEMA,
      version: RECEIPT_VERSION,
      requestId: operation.requestId,
      requestFingerprint: operation.requestFingerprint,
      previewId: operation.previewId,
      operationId: operation.operationId,
      owner: cloneJson(operation.owner),
      state: operation.state,
      terminal: operation.terminal,
      createdAtMs: existing?.createdAtMs ?? operation.createdAtMs,
      updatedAtMs: now,
      expiresAtMs: existing?.expiresAtMs ?? operation.createdAtMs + this._receiptTtlMs,
      response: cloneJson(operation.response),
    }
  }

  _syncReceipt(operation, now = this._nowMs()) {
    const existing = this._loadReceipt(operation.requestId)
    if (existing && (existing.previewId !== operation.previewId || existing.operationId !== operation.operationId || existing.requestFingerprint !== operation.requestFingerprint)) {
      throw corrupt(this._receiptPath(operation.requestId), 'request receipt binding mismatch')
    }
    const receipt = this._receiptFor(operation, existing, now)
    if (!existing || !sameJson(existing, receipt)) {
      this._writeRecords([{ category: 'receipts', path: this._receiptPath(operation.requestId), payload: receipt }], now)
    }
    return receipt
  }

  _openOperation(id) {
    const operation = this._loadOperation(id)
    if (!operation) throw fail('operation_not_found', 'operation not found', 404)
    if (this._loadMarker(id)) throw fail('operation_already_committed', 'operation has a durable commit marker', 409)
    if (operation.terminal) throw fail('operation_terminal', 'operation is already terminal', 409)
    return operation
  }

  createPreview(input = {}) {
    if (!isPlainObject(input)) throw fail('invalid_options', 'preview input must be an object', 400)
    const now = this._nowMs()
    const requestId = normalizeRequestId(input.requestId)
    if (!isPlainObject(input.plan)) throw fail('invalid_plan', 'plan must be a plain object', 400)
    const plan = cloneJson(input.plan)
    const view = cloneJson(input.view === undefined ? {} : input.view)
    if (!isPlainObject(view)) throw fail('invalid_view', 'view must be a plain object', 400)
    const ttlMs = normalizeTtl(input.ttlMs, DEFAULT_PREVIEW_TTL_MS, MAX_PREVIEW_TTL_MS, 'ttlMs')
    const token = randomBytes(32).toString('base64url')
    const previewId = newId('prv_')
    if (canonical(plan).includes(token) || canonical(view).includes(token)) {
      throw fail('confirmation_token_not_storable', 'preview data must not contain the confirmation token', 400)
    }
    const preview = {
      schema: PREVIEW_SCHEMA,
      version: PREVIEW_VERSION,
      previewId,
      owner: cloneJson(this.owner),
      requestId,
      planHash: hashCanonical(plan),
      plan,
      view,
      tokenHash: hashToken(token),
      createdAtMs: now,
      expiresAtMs: now + ttlMs,
      consumedAtMs: null,
      operationId: null,
    }
    this._writeRecords([{ category: 'previews', path: this._previewPath(previewId), payload: preview }], now)
    return publicPreview(preview, token)
  }

  readPreview(previewId, options = {}) {
    if (!isPlainObject(options)) throw fail('invalid_options', 'options must be an object', 400)
    const preview = this._loadPreview(assertPreviewId(previewId))
    if (!preview) throw fail('preview_not_found', 'preview not found', 404)
    return publicPreview(preview, null, options.includePlan === true)
  }

  readPreviewByToken(confirmToken, options = {}) {
    if (!isPlainObject(options)) throw fail('invalid_options', 'options must be an object', 400)
    if (typeof confirmToken !== 'string' || !TOKEN_RE.test(confirmToken)) throw fail('preview_binding_mismatch', 'confirmToken is invalid', 409)
    const tokenHash = hashToken(confirmToken)
    for (const id of this._ids(this.dirs.previews, 'prv_', PREVIEW_ID_RE)) {
      const preview = this._loadPreview(id)
      if (sameHash(preview.tokenHash, tokenHash)) return publicPreview(preview, null, options.includePlan === true)
    }
    throw fail('preview_not_found', 'preview not found', 404)
  }

  bindPreviewRequestId(previewId, input = {}) {
    if (!isPlainObject(input)) throw fail('invalid_options', 'preview binding input must be an object', 400)
    const id = assertPreviewId(previewId)
    const requestId = normalizeRequestId(input.requestId)
    const token = typeof input.confirmToken === 'string' ? input.confirmToken : ''
    if (!TOKEN_RE.test(token)) throw fail('preview_binding_mismatch', 'confirmToken is invalid', 409)
    const preview = this._loadPreview(id)
    if (!preview) throw fail('preview_not_found', 'preview not found', 404)
    if (!sameHash(preview.tokenHash, hashToken(token))) throw fail('preview_binding_mismatch', 'confirmation token does not match the preview', 409)
    if (preview.consumedAtMs !== null) throw fail('preview_consumed', 'confirmation token can only be consumed once', 409)
    const now = this._nowMs()
    if (now >= preview.expiresAtMs) throw fail('preview_expired', 'preview has expired', 428)
    if (preview.requestId === requestId) return publicPreview(preview, null)
    const prior = this._loadReceipt(requestId)
    if (prior) throw fail('idempotency_conflict', 'requestId was already used for a different request', 409)
    const bound = { ...preview, requestId }
    this._writeRecords([{ category: 'previews', path: this._previewPath(id), payload: bound }], this._nowMs())
    return publicPreview(bound, null)
  }

  beginOperation(input = {}) {
    if (!isPlainObject(input)) throw fail('invalid_options', 'operation input must be an object', 400)
    const requestId = normalizeRequestId(input.requestId)
    const previewId = assertPreviewId(input.previewId)
    const token = typeof input.confirmToken === 'string' ? input.confirmToken : ''
    if (!TOKEN_RE.test(token)) throw fail('preview_binding_mismatch', 'confirmToken is invalid', 409)
    const preview = this._loadPreview(previewId)
    if (!preview) throw fail('preview_not_found', 'preview not found', 404)
    const requestFingerprint = input.requestFingerprint === undefined
      ? hashCanonical({ previewId, requestId, planHash: preview.planHash })
      : normalizeFingerprint(input.requestFingerprint)
    const prior = this._loadReceipt(requestId)
    if (prior) {
      if (prior.requestFingerprint !== requestFingerprint) throw fail('idempotency_conflict', 'requestId was already used for a different request', 409)
      const stored = this._loadOperation(prior.operationId)
      if (!stored) throw corrupt(this._operationPath(prior.operationId), 'request receipt references a missing operation')
      const marker = this._loadMarker(stored.operationId)
      const operation = marker ? marker.operation : stored
      const now = this._nowMs()
      const receipt = marker ? this._receiptFor(operation, prior, now) : prior
      if (marker) {
        try { this._syncReceipt(operation, now) } catch { /* replay remains safe without a writable receipt */ }
      }
      return { replayed: true, operation: publicOperation(operation), requestReceipt: publicReceipt(receipt, now) }
    }
    if (!sameHash(preview.tokenHash, hashToken(token))) throw fail('preview_binding_mismatch', 'confirmation token does not match the preview', 409)
    if (preview.consumedAtMs !== null) throw fail('preview_consumed', 'confirmation token can only be consumed once', 409)
    const now = this._nowMs()
    if (now >= preview.expiresAtMs) throw fail('preview_expired', 'preview has expired', 428)
    if (preview.requestId !== requestId) throw fail('preview_binding_mismatch', 'requestId does not match the preview', 409)
    const operationId = newId('op_')
    const steps = normalizeSteps(input.steps)
    const operation = {
      schema: OPERATION_SCHEMA,
      version: OPERATION_VERSION,
      operationId,
      previewId,
      owner: cloneJson(this.owner),
      requestId,
      requestFingerprint,
      planHash: preview.planHash,
      state: 'running',
      terminal: false,
      createdAtMs: now,
      updatedAtMs: now,
      committedAtMs: null,
      terminalAtMs: null,
      steps,
      progress: progressOf(steps),
      result: null,
      error: null,
      response: null,
      recovery: null,
    }
    // Plan all three records before the first write. The operation-first ordering makes a
    // crash recoverable, while quota admission (including commit headroom) happens before
    // any confirmation token is consumed or application side effect can start.
    const receipt = this._receiptFor(operation, null, now)
    const consumedPreview = { ...preview, consumedAtMs: now, operationId }
    this._writeRecords([
      { category: 'operations', path: this._operationPath(operationId), payload: operation },
      { category: 'receipts', path: this._receiptPath(requestId), payload: receipt },
      { category: 'previews', path: this._previewPath(previewId), payload: consumedPreview },
    ], now)
    return { replayed: false, operation: publicOperation(operation), requestReceipt: publicReceipt(receipt, now), plan: cloneJson(preview.plan) }
  }

  getOperation(operationId) {
    const id = assertOperationId(operationId)
    const operation = this._loadOperation(id)
    if (!operation) throw fail('operation_not_found', 'operation not found', 404)
    // The independent marker is authoritative even if a later operation/receipt write failed.
    const marker = this._loadMarker(id)
    return publicOperation(marker ? marker.operation : operation)
  }

  getRequestReceipt(requestId) {
    const receipt = this._loadReceipt(normalizeRequestId(requestId))
    if (!receipt) throw fail('request_receipt_not_found', 'request receipt not found', 404)
    return publicReceipt(receipt, this._nowMs())
  }

  replayRequest(requestId, requestFingerprint) {
    const id = normalizeRequestId(requestId)
    const fingerprint = normalizeFingerprint(requestFingerprint)
    const receipt = this._loadReceipt(id)
    if (!receipt) throw fail('request_receipt_not_found', 'request receipt not found', 404)
    if (receipt.requestFingerprint !== fingerprint) throw fail('idempotency_conflict', 'requestId was already used for a different request', 409)
    const stored = this._loadOperation(receipt.operationId)
    if (!stored) throw corrupt(this._operationPath(receipt.operationId), 'request receipt references a missing operation')
    const marker = this._loadMarker(stored.operationId)
    const operation = marker ? marker.operation : stored
    const now = this._nowMs()
    const projected = this._receiptFor(operation, receipt, now)
    if (marker) {
      try { this._syncReceipt(operation, now) } catch { /* the marker still provides a truthful replay */ }
    }
    return { replayed: true, receipt: publicReceipt(projected, now), operation: publicOperation(operation) }
  }

  _step(operation, stepId) {
    const id = normalizeStepId(stepId)
    const step = operation.steps.find((entry) => entry.id === id)
    if (!step) throw fail('step_not_found', 'operation step not found', 404)
    return step
  }

  _saveOpen(operation, now) {
    operation.updatedAtMs = now
    operation.progress = progressOf(operation.steps)
    const existing = this._loadReceipt(operation.requestId)
    if (existing && (existing.previewId !== operation.previewId || existing.operationId !== operation.operationId || existing.requestFingerprint !== operation.requestFingerprint)) {
      throw corrupt(this._receiptPath(operation.requestId), 'request receipt binding mismatch')
    }
    const receipt = this._receiptFor(operation, existing, now)
    this._writeRecords([
      { category: 'operations', path: this._operationPath(operation.operationId), payload: operation },
      { category: 'receipts', path: this._receiptPath(operation.requestId), payload: receipt },
    ], now)
    return publicOperation(operation)
  }

  startStep(operationId, stepId) {
    const operation = this._openOperation(assertOperationId(operationId))
    const step = this._step(operation, stepId)
    if (step.state === 'running') return publicOperation(operation)
    if (step.state === 'succeeded') throw fail('step_already_committed', 'committed steps are never rerun', 409)
    if (step.state !== 'pending') throw fail('step_not_pending', 'only pending steps can start', 409)
    const now = this._nowMs()
    step.state = 'running'
    step.attempts = 1
    step.startedAtMs = now
    return this._saveOpen(operation, now)
  }

  completeStep(operationId, stepId, input = {}) {
    if (!isPlainObject(input)) throw fail('invalid_options', 'step result must be an object', 400)
    const operation = this._openOperation(assertOperationId(operationId))
    const step = this._step(operation, stepId)
    if (step.state === 'succeeded') return publicOperation(operation)
    if (step.state !== 'running') throw fail('step_not_running', 'only running steps can complete', 409)
    const now = this._nowMs()
    step.state = 'succeeded'
    step.endedAtMs = now
    step.result = cloneJson(input.result === undefined ? null : input.result)
    return this._saveOpen(operation, now)
  }

  failStep(operationId, stepId, input = {}) {
    if (!isPlainObject(input)) throw fail('invalid_options', 'step error must be an object', 400)
    const operation = this._openOperation(assertOperationId(operationId))
    const step = this._step(operation, stepId)
    if (step.state === 'failed') return publicOperation(operation)
    if (step.state !== 'running') throw fail('step_not_running', 'only running steps can fail', 409)
    const now = this._nowMs()
    step.state = 'failed'
    step.endedAtMs = now
    step.error = errorOf(input, 'step_failed')
    return this._saveOpen(operation, now)
  }

  commitOperation(operationId, input = {}) {
    if (!isPlainObject(input)) throw fail('invalid_options', 'commit input must be an object', 400)
    const id = assertOperationId(operationId)
    const operation = this._loadOperation(id)
    if (!operation) throw fail('operation_not_found', 'operation not found', 404)
    const marker = this._loadMarker(id)
    if (marker) {
      const now = this._nowMs()
      const prior = this._loadReceipt(operation.requestId)
      if (prior && (prior.previewId !== marker.operation.previewId || prior.operationId !== id || prior.requestFingerprint !== marker.operation.requestFingerprint)) {
        throw corrupt(this._receiptPath(operation.requestId), 'request receipt binding mismatch')
      }
      const receipt = this._receiptFor(marker.operation, prior, now)
      const writes = []
      if (!operation.terminal || !sameJson(operation, marker.operation)) {
        writes.push({ category: 'operations', path: this._operationPath(id), payload: marker.operation })
      }
      if (!prior || !sameJson(prior, receipt)) writes.push({ category: 'receipts', path: this._receiptPath(operation.requestId), payload: receipt })
      if (writes.length) this._writeRecords(writes, now)
      return publicOperation(marker.operation)
    }
    if (operation.terminal) throw fail('operation_terminal', 'operation is already terminal', 409)
    if (operation.steps.some((step) => step.state !== 'succeeded')) {
      throw fail('operation_steps_incomplete', 'all steps must succeed before commit', 409)
    }
    const now = this._nowMs()
    const response = cloneJson(input.response === undefined ? null : input.response)
    if (isPlainObject(response?.operation) &&
        (response.operation.operationId === id || response.operation.id === id)) {
      response.operation = { ...publicOperationSummary({ ...operation, state: 'succeeded', terminal: true, committedAtMs: now, terminalAtMs: now, updatedAtMs: now }), id }
    }
    const committed = {
      ...operation,
      state: 'succeeded',
      terminal: true,
      updatedAtMs: now,
      committedAtMs: now,
      terminalAtMs: now,
      result: cloneJson(input.result === undefined ? null : input.result),
      response,
      error: null,
      progress: progressOf(operation.steps),
    }
    const commit = {
      schema: COMMIT_SCHEMA,
      version: COMMIT_VERSION,
      operationId: id,
      owner: cloneJson(this.owner),
      committedAtMs: now,
      operationHash: hashCanonical(committed),
      operation: committed,
    }
    // The marker is the commit point and is authoritative during recovery.
    // Explicit fault injection is limited to isolated tests; production never sets it.
    if (process.env.MG_OPERATION_STORE_FAULT === 'before_commit_marker') process.exit(99)
    const prior = this._loadReceipt(operation.requestId)
    if (prior && (prior.previewId !== operation.previewId || prior.operationId !== operation.operationId || prior.requestFingerprint !== operation.requestFingerprint)) {
      throw corrupt(this._receiptPath(operation.requestId), 'request receipt binding mismatch')
    }
    const receipt = this._receiptFor(committed, prior, now)
    const writes = [
      { category: 'commits', path: this._markerPath(id), payload: commit },
      { category: 'operations', path: this._operationPath(id), payload: committed },
    ]
    if (!prior || !sameJson(prior, receipt)) writes.push({ category: 'receipts', path: this._receiptPath(operation.requestId), payload: receipt })
    this._writeRecords(writes, now)
    if (process.env.MG_OPERATION_STORE_FAULT === 'commit_receipt') {
      throw fail('operation_store_write_failed', 'injected commit receipt write failure')
    }
    return publicOperation(committed)
  }

  failOperation(operationId, input = {}) {
    if (!isPlainObject(input)) throw fail('invalid_options', 'failure input must be an object', 400)
    const id = assertOperationId(operationId)
    const operation = this._loadOperation(id)
    if (!operation) throw fail('operation_not_found', 'operation not found', 404)
    if (this._loadMarker(id)) throw fail('operation_already_committed', 'operation has a durable commit marker', 409)
    if (operation.terminal && ['failed', 'unknown'].includes(operation.state)) return publicOperation(operation)
    if (operation.terminal) throw fail('operation_terminal', 'operation is already terminal', 409)
    const now = this._nowMs()
    const uncertain = operation.steps.some((step) => step.state === 'running')
    for (const step of operation.steps) {
      if (step.state === 'running') {
        step.state = 'unknown'
        step.endedAtMs = now
        step.error = { code: 'operation_outcome_unknown', message: 'process stopped before the step outcome was durable' }
      }
    }
    operation.state = uncertain ? 'unknown' : 'failed'
    operation.terminal = true
    operation.terminalAtMs = now
    operation.updatedAtMs = now
    operation.progress = progressOf(operation.steps)
    operation.error = errorOf(input, uncertain ? 'operation_outcome_unknown' : 'operation_failed')
    operation.result = cloneJson(input.result === undefined ? null : input.result)
    operation.response = cloneJson(input.response === undefined ? null : input.response)
    const prior = this._loadReceipt(operation.requestId)
    const receipt = this._receiptFor(operation, prior, now)
    this._writeRecords([
      { category: 'operations', path: this._operationPath(id), payload: operation },
      { category: 'receipts', path: this._receiptPath(operation.requestId), payload: receipt },
    ], now)
    return publicOperation(operation)
  }

  cancelOperation(operationId, input = {}) {
    if (!isPlainObject(input)) throw fail('invalid_options', 'cancellation input must be an object', 400)
    const id = assertOperationId(operationId)
    const operation = this._loadOperation(id)
    if (!operation) throw fail('operation_not_found', 'operation not found', 404)
    // Check the independent marker first: cancellation must fail closed even if the
    // operation file is stale or temporarily inconsistent.
    if (this._loadMarker(id)) throw fail('operation_already_committed', 'committed operations cannot be cancelled', 409)
    if (operation.state === 'cancelled') return publicOperation(operation)
    if (operation.terminal) throw fail('operation_terminal', 'operation is already terminal', 409)
    if (operation.steps.some((step) => step.state !== 'pending')) {
      throw fail('operation_commit_uncertain', 'only operations with no started steps can be cancelled', 409)
    }
    const now = this._nowMs()
    operation.state = 'cancelled'
    operation.terminal = true
    operation.terminalAtMs = now
    operation.updatedAtMs = now
    operation.error = errorOf(input, 'operation_cancelled')
    operation.result = cloneJson(input.result === undefined ? null : input.result)
    operation.response = cloneJson(input.response === undefined ? null : input.response)
    const prior = this._loadReceipt(operation.requestId)
    const receipt = this._receiptFor(operation, prior, now)
    this._writeRecords([
      { category: 'operations', path: this._operationPath(id), payload: operation },
      { category: 'receipts', path: this._receiptPath(operation.requestId), payload: receipt },
    ], now)
    return publicOperation(operation)
  }

  cleanup(input = {}) {
    if (!isPlainObject(input)) throw fail('invalid_options', 'cleanup input must be an object', 400)
    const now = this._nowMs()
    const inventory = this._scanStore(now)
    if (input.operationId === undefined) {
      const result = this._writeRecords([], now)
      return { operationId: null, deleted: result.deleted }
    }
    if (inventory.cleanup) this._writeRecords([], now)
    const id = assertOperationId(input.operationId)
    if (input.confirm !== true) throw fail('invalid_cleanup_confirmation', 'explicit operation cleanup requires confirm: true', 400)
    const current = this._scanStore(now)
    const operation = current.operations.get(id)
    if (!operation) throw fail('operation_not_found', 'operation not found', 404)
    if (!operation.terminal) throw fail('operation_not_terminal', 'only terminal operations can be explicitly cleaned up', 409)
    const marker = current.markers.get(id)
    const receipt = current.receipts.get(operation.requestId)
    const journal = {
      schema: CLEANUP_SCHEMA,
      version: CLEANUP_VERSION,
      operationId: id,
      previewId: operation.previewId,
      requestId: operation.requestId,
      owner: cloneJson(this.owner),
      createdAtMs: now,
      records: {
        previews: current.files.get(this._previewPath(operation.previewId)).hash,
        commits: marker ? current.files.get(this._markerPath(id)).hash : null,
        receipts: receipt ? current.files.get(this._receiptPath(operation.requestId)).hash : null,
      },
    }
    // Replacing the operation atomically with this small journal makes every later unlink
    // restart-safe. The journal itself is removed last, after all referenced records.
    this._writeRecords([{ category: 'operations', path: this._operationPath(id), payload: journal }], now)
    const result = this._writeRecords([], now)
    return { operationId: id, deleted: result.deleted }
  }

  cleanupOperation(operationId, options = {}) {
    if (!isPlainObject(options)) throw fail('invalid_options', 'cleanup options must be an object', 400)
    return this.cleanup({ ...options, operationId })
  }

  recover() {
    const now = this._nowMs()
    const inventory = this._scanStore(now)
    const deletions = this._eligiblePrunes(inventory)
    const writes = new Map()
    let recovered = 0
    let cleanupJournal = null
    if (inventory.cleanup) {
      cleanupJournal = inventory.cleanup.path
      for (const [category, targets] of inventory.cleanup.targets) {
        if (category === 'operations') continue
        for (const target of targets.values()) deletions.add(target.path)
      }
    }

    for (const [id, stored] of inventory.operations) {
      let operation = stored
      const marker = inventory.markers.get(id)
      if (marker) {
        if (!sameJson(operation, marker.operation)) {
          operation = marker.operation
          writes.set(this._operationPath(id), { category: 'operations', path: this._operationPath(id), payload: operation })
          recovered += 1
        }
      } else if (!operation.terminal) {
        const uncertain = operation.steps.some((step) => ['running', 'succeeded', 'unknown'].includes(step.state))
        operation.state = uncertain ? 'unknown' : 'interrupted'
        operation.terminal = true
        operation.terminalAtMs = now
        operation.updatedAtMs = now
        operation.recovery = {
          reason: uncertain ? 'restart_after_step_may_have_committed' : 'restart_before_any_step_started',
          at: iso(now),
          replay: 'forbidden',
        }
        for (const step of operation.steps) {
          if (step.state === 'running') {
            step.state = 'unknown'
            step.endedAtMs = now
            step.error = { code: 'operation_outcome_unknown', message: 'step outcome was not durable before restart' }
          }
        }
        operation.progress = progressOf(operation.steps)
        if (operation.error === null) operation.error = { code: operation.state, message: operation.recovery.reason }
        writes.set(this._operationPath(id), { category: 'operations', path: this._operationPath(id), payload: operation })
        recovered += 1
      }
      inventory.operations.set(id, operation)
    }

    for (const operation of inventory.operations.values()) {
      const preview = inventory.previews.get(operation.previewId)
      if (preview.consumedAtMs === null) {
        const consumed = { ...preview, consumedAtMs: operation.createdAtMs, operationId: operation.operationId }
        inventory.previews.set(preview.previewId, consumed)
        writes.set(this._previewPath(preview.previewId), { category: 'previews', path: this._previewPath(preview.previewId), payload: consumed })
        recovered += 1
      }
    }

    for (const operation of inventory.operations.values()) {
      const path = this._receiptPath(operation.requestId)
      if (deletions.has(path)) continue
      const existing = inventory.receipts.get(operation.requestId)
      const receipt = this._receiptFor(operation, existing, now)
      const wasLive = inventory.liveOperationIds.has(operation.operationId)
      const unexpired = now < operation.createdAtMs + this._receiptTtlMs
      const outcomeChanged = existing && (existing.state !== operation.state || existing.terminal !== operation.terminal ||
        !sameJson(existing.response, operation.response))
      if ((!existing && (wasLive || unexpired)) || outcomeChanged) {
        writes.set(path, { category: 'receipts', path, payload: receipt })
        inventory.receipts.set(operation.requestId, receipt)
        recovered += 1
      }
    }

    // Validate every record, reference, repair, prune and final limit before the first
    // mutation. Corruption or capacity failures therefore leave recovery write-free.
    const projectionDeletions = new Set(deletions)
    if (cleanupJournal) projectionDeletions.add(cleanupJournal)
    const projected = this._project(inventory, [...writes.values()], projectionDeletions)
    const deleted = this._deletePaths(deletions)
    for (const write of writes.values()) writeRecord(write.path, write.payload)
    if (cleanupJournal) this._deletePaths([cleanupJournal])
    return {
      previews: projected.counts.previews,
      operations: projected.counts.operations,
      receipts: projected.counts.receipts,
      recovered,
      deleted: inventory.staleTemporariesDeleted + deleted,
    }
  }
}

function apiScope(ctx) {
  const supplied = ctx.scope ?? ctx.state?.scope ?? ctx.state?.requestScope ?? DEFAULT_API_SCOPE
  const source = typeof supplied === 'string' ? { scopeId: supplied } : supplied
  if (!isPlainObject(source)) return supplied
  const actor = ctx.actor && typeof ctx.actor === 'object' ? ctx.actor : null
  return {
    scopeId: source?.scopeId ?? DEFAULT_API_SCOPE.scopeId,
    actorId: actor?.actorId ?? actor?.id ?? actor?.userId ?? source?.actorId ?? ctx.actorId ?? null,
  }
}

export function apiOperationStore(ctx = {}) {
  if (ctx.operationStore && typeof ctx.operationStore.getOperation === 'function') return ctx.operationStore
  const configRoot = ctx.operationRoot || ctx.configDir || ctx.state?.paths?.dir || process.env.MG_CONFIG_DIR
  if (typeof configRoot !== 'string' || !configRoot.trim()) return null
  const root = join(configRoot, 'resource-operations')
  const scope = apiScope(ctx)
  const directoryScope = ctx.operationNamespace || scope.scopeId
  const key = root + '\u0000' + directoryScope + '\u0000' + (scope.actorId || '')
  let store = API_STORES.get(key)
  if (!store) {
    store = createOperationStore(root, scope, { directoryScope, ...(ctx.nowFn ? { now: ctx.nowFn } : {}) })
    API_STORES.set(key, store)
  }
  return store
}

function compactApiJson(value, inArray = false) {
  if (value === undefined) return inArray ? null : undefined
  if (Array.isArray(value)) return value.map((entry) => compactApiJson(entry, true))
  if (isPlainObject(value)) {
    const out = {}
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) out[key] = compactApiJson(entry)
    }
    return out
  }
  return value
}

export function createApiPreview(ctx, input = {}) {
  const now = Number.isSafeInteger(input.now) ? input.now : Date.now()
  const requestId = input.requestId === undefined || input.requestId === null || input.requestId === ''
    ? 'req_' + randomBytes(16).toString('base64url')
    : normalizeRequestId(input.requestId)
  const ttlMs = input.ttlMs === undefined ? 300000 : Number(input.ttlMs)
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_PREVIEW_TTL_MS) {
    throw fail('invalid_ttl', 'ttlMs must be an integer between 1 and ' + MAX_PREVIEW_TTL_MS, 400)
  }
  const plan = cloneJson(compactApiJson(input.plan))
  const view = cloneJson(compactApiJson(input.view || {}))
  const expiresAt = iso(now + ttlMs)
  const store = apiOperationStore(ctx)
  if (store) return store.createPreview({ requestId, plan, view, ttlMs })
  const token = randomBytes(32).toString('base64url')
  const previewId = 'prv_' + token
  const entry = { token, previewId, requestId, plan, planHash: hashCanonical(plan), expiresAt: now + ttlMs }
  input.previews?.set(token, entry)
  return { ...view, previewId, confirmToken: token, requestId, expiresAt }
}

export function apiOperationError(error, fallbackCode = 'operation_failed') {
  const status = Number.isInteger(error?.status) ? error.status : 500
  return {
    status,
    body: {
      ok: false,
      code: error?.code || fallbackCode,
      error: error?.message || fallbackCode,
      retryable: status >= 500 || status === 409 || status === 429,
      ...(error?.details ? { details: error.details } : {}),
    },
  }
}

export function publicApiOperation(operation) {
  return { ...operation, id: operation.operationId }
}

function replayOperation(operation) {
  const safe = publicApiOperation(operation)
  if (operation.response && operation.terminal) {
    const status = Number.isInteger(operation.result?.httpStatus)
      ? operation.result.httpStatus
      : operation.state === 'succeeded' ? 200 : operation.state === 'cancelled' ? 409 : 500
    return { status, body: operation.response }
  }
  const status = operation.state === 'running' ? 409 : 500
  return {
    status,
    body: {
      ok: false,
      code: operation.state === 'running' ? 'operation_in_progress' : 'operation_not_replayable',
      error: operation.state === 'running' ? '操作仍在执行，未产生可重放回执' : '操作未产生成功回执，禁止重新执行',
      retryable: status >= 500 || status === 409,
      operation: safe,
    },
  }
}

function receiptFailure(operation, error) {
  const safe = publicApiOperation(operation)
  return {
    status: 500,
    body: {
      ok: false,
      code: 'operation_receipt_write_failed',
      error: '操作已形成 commit marker，但回执未能可靠持久化；未执行回滚',
      retryable: true,
      operation: safe,
      details: { outcome: 'committed', commitMarker: true, receipt: 'unknown', cause: error?.code || 'operation_store_write_failed' },
    },
  }
}

export function replayApiWrite(ctx, input = {}) {
  const store = apiOperationStore(ctx)
  if (store) {
    try {
      const prior = store.replayRequest(input.requestId, input.requestFingerprint)
      return replayOperation(prior.operation)
    } catch (error) {
      if (error?.code === 'request_receipt_not_found') return null
      return apiOperationError(error)
    }
  }
  const prior = input.receipts?.get(input.requestId)
  if (!prior) return null
  return prior.requestFingerprint === input.requestFingerprint
    ? { status: 200, body: prior.body }
    : { status: 409, body: { ok: false, code: 'idempotency_conflict', error: 'requestId 已用于不同请求', retryable: true } }
}

export async function executeApiWrite(ctx, input = {}) {
  const {
    previews, receipts, previewId, confirmToken, requestId, requestFingerprint,
    save, responseFor, failureFor, steps = ['config-transaction'], allowRequestIdRebind = false,
  } = input
  const store = apiOperationStore(ctx)
  const now = Number.isSafeInteger(ctx.now) ? ctx.now : Date.now()
  if (!store) {
    const prior = receipts?.get(requestId)
    if (prior) return prior.requestFingerprint === requestFingerprint
      ? { status: 200, body: prior.body }
      : { status: 409, body: { ok: false, code: 'idempotency_conflict', error: 'requestId 已用于不同请求', retryable: true } }
    const stored = previews?.get(confirmToken)
    if (!stored || stored.expiresAt <= now) {
      const expired = !!stored && stored.expiresAt <= now
      if (expired) previews?.delete(confirmToken)
      return { status: 428, body: { ok: false, code: expired ? 'preview_expired' : confirmToken ? 'preview_expired' : 'confirmation_required', error: '预览不存在、已使用或已过期，请重新预览', retryable: false } }
    }
    previews?.delete(confirmToken)
    let result
    try { result = await save() } catch (error) { return failureFor(error, null) }
    if (result?.error || result?.conflict) return failureFor(result, null)
    const out = responseFor(result, null)
    receipts?.set(requestId, { requestFingerprint, expiresAt: now + 86400000, body: out.body })
    return out
  }

  let begun
  try {
    if (allowRequestIdRebind) {
      try {
        const prior = store.replayRequest(requestId, requestFingerprint)
        return replayOperation(prior.operation)
      } catch (error) {
        if (error?.code !== 'request_receipt_not_found') throw error
      }
      const current = store.readPreview(previewId, { includePlan: true })
      if (current.requestId !== requestId) store.bindPreviewRequestId(previewId, { confirmToken, requestId })
    }
    begun = store.beginOperation({ previewId, confirmToken, requestId, requestFingerprint, steps })
  } catch (error) {
    return apiOperationError(error)
  }
  if (begun.replayed) return replayOperation(begun.operation)
  const operationId = begun.operation.operationId
  const stepId = steps[0]
  const fail = (error) => {
    const out = failureFor(error, begun.operation)
    try { store.failStep(operationId, stepId, { code: out.body?.code || 'operation_failed', message: out.body?.error || 'operation_failed' }) } catch {}
    try { store.failOperation(operationId, { code: out.body?.code || 'operation_failed', message: out.body?.error || 'operation_failed', response: out.body, result: { httpStatus: out.status } }) } catch {}
    return out
  }
  try {
    store.startStep(operationId, stepId)
    let result
    try { result = await save() } catch (error) { return fail(error) }
    if (result?.error || result?.conflict) return fail(result)
    const out = responseFor(result, begun.operation)
    store.completeStep(operationId, stepId, { result: { configVersion: out.body?.configVersion ?? null } })
    try {
      const committed = store.commitOperation(operationId, { result: { httpStatus: out.status, configVersion: out.body?.configVersion ?? null }, response: out.body })
      return { status: out.status, body: committed.response }
    } catch (error) {
      const committed = store.getOperation(operationId)
      if (committed.state === 'succeeded') return receiptFailure(committed, error)
      throw error
    }
  } catch (error) {
    let operation = begun.operation
    try { operation = store.getOperation(operationId) } catch {}
    if (operation.state === 'succeeded') return receiptFailure(operation, error)
    try {
      store.failOperation(operationId, { code: error?.code || 'operation_outcome_unknown', message: error?.message || '操作结果未知，禁止自动重放', response: {
        ok: false, code: error?.code || 'operation_outcome_unknown', error: error?.message || '操作结果未知，禁止自动重放', retryable: true,
      }, result: { httpStatus: 500 } })
    } catch {}
    return {
      status: 500,
      body: {
        ok: false,
        code: error?.code || 'operation_outcome_unknown',
        error: error?.message || '操作结果未知，禁止自动重放',
        retryable: true,
        operation: publicApiOperation(operation),
        details: { replay: 'forbidden', rollback: 'not_attempted' },
      },
    }
  }
}

export function handleApiOperationRoute(ctx, method, path) {
  const match = OPERATION_ROUTE_RE.exec(path)
  if (!match) return null
  let operationId
  try { operationId = decodeURIComponent(match[1]) } catch { operationId = null }
  if (!operationId || !OPERATION_ID_RE.test(operationId)) {
    return { status: 400, body: { ok: false, code: 'invalid_operation_id', error: 'operationId 无效', retryable: false } }
  }
  const cancelling = method === 'POST' && path.endsWith('/cancel')
  if (method !== 'GET' && !cancelling) return null
  const store = apiOperationStore(ctx)
  if (!store) return { status: 503, body: { ok: false, code: 'operation_store_unavailable', error: '持久操作存储未配置', retryable: false } }
  try {
    const operation = cancelling
      ? store.cancelOperation(operationId, { code: 'operation_cancelled', message: String(ctx.body?.reason || 'operation cancelled') })
      : store.getOperation(operationId)
    return { status: 200, body: { ok: true, operation: publicApiOperation(operation) } }
  } catch (error) {
    return apiOperationError(error, 'operation_request_failed')
  }
}

export function createOperationStore(root, scope, options = {}) {
  return new OperationStore(root, scope, options)
}

export default createOperationStore
