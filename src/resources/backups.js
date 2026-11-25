import { createHash } from 'node:crypto'

const BACKUP_SCHEMA = 'modelgate-config-backup'
const BACKUP_VERSION = 1
const PLAN_SCHEMA = 'modelgate-config-import-plan'
const PLAN_VERSION = 1
const DEFAULT_MAX_BYTES = 1024 * 1024
const DEFAULT_MAX_DEPTH = 32
const MISSING = Symbol('missing')
const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const RUNTIME_FIELDS = new Set(['_paths', '_disk'])
const PATH_FIELDS = new Set([
  'path', 'paths', 'file', 'filename', 'filepath', 'configfile', 'configpath', 'configdir',
  'backuppath', 'backupdir', 'outputpath', 'outputfile', 'outputdir', 'targetpath',
  'targetfile', 'targetdir', 'sourcepath', 'sourcefile', 'sourcedir', 'destinationpath',
  'destinationfile', 'destinationdir', 'rootpath', 'rootdir', 'arbitrarypath',
])
const ALLOWED_CONFIG_PATHS = new Set([
  'pathprefix', 'codexcatalogbasepath', 'videocreatepath', 'videostatuspath',
  'videocancelpath', 'responsespath', 'chatcompletionspath', 'embeddingspath',
  'rerankpath', 'modelspath',
])
const SENSITIVE_EXACT = new Set([
  'key', 'keys', 'apikey', 'clientkey', 'privatekey', 'publickey', 'masterkey',
  'accesskey', 'refreshkey', 'secretkey', 'signingkey', 'authkey', 'sessionkey',
  'token', 'accesstoken', 'refreshtoken', 'authtoken', 'idtoken', 'password',
  'passwd', 'secret', 'clientsecret', 'apisecret', 'credential', 'credentials',
  'auth', 'authorization', 'cookie', 'setcookie', 'oauth', 'authentication',
])
const SENSITIVE_PARTS = [
  'password', 'passwd', 'secret', 'token', 'credential', 'authorization',
  'cookie', 'apikey', 'clientkey', 'privatekey', 'masterkey', 'accesskey',
  'refreshkey', 'authkey', 'sessionkey', 'signingkey', 'authentication',
]

function fail(code, message, details) {
  const error = new TypeError(message)
  error.code = code
  if (details) Object.assign(error, details)
  return error
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function compactKey(key) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function isSensitiveKey(key) {
  const compact = compactKey(key)
  return SENSITIVE_EXACT.has(compact) || SENSITIVE_PARTS.some((part) => compact.includes(part))
}

function isMask(value) {
  return isPlainObject(value) && Object.keys(value).length === 1 && value.masked === true
}

function mask() {
  return { masked: true }
}

function assertAllowedKeys(value, allowed, code, label) {
  if (!isPlainObject(value)) throw fail(code, label + ' 必须是普通对象')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(value).length !== Object.keys(value).length) throw fail(code, label + ' 只能包含可枚举的数据字段')
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key], 'value')) throw fail(code, label + ' 不能包含访问器')
    if (!allowed.has(key)) throw fail(code, label + ' 包含不支持的字段')
  }
}

function assertExactKeys(value, allowed, code, label) {
  assertAllowedKeys(value, allowed, code, label)
  for (const key of allowed) if (!Object.hasOwn(value, key)) throw fail(code, label + ' 缺少字段: ' + key)
}

function validateFieldName(key, path, headerNames) {
  if (RESERVED_KEYS.has(key)) throw fail('invalid_reserved_key', '配置包含保留字段名')
  if (!key) throw fail('invalid_config', '配置字段名不能为空')
  if (key === '_paths' && path.length === 0) return
  if (headerNames) {
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(key)) throw fail('invalid_header_name', 'extraHeaders 包含非法 header 名称')
    return
  }
  const compact = compactKey(key)
  if (PATH_FIELDS.has(compact) || (compact.endsWith('path') && !ALLOWED_CONFIG_PATHS.has(compact))) {
    throw fail('invalid_path_field', '配置不接受任意文件路径字段')
  }
}

function cloneJson(value, limits, path = [], ancestors = new Set(), headerNames = false) {
  if (path.length > limits.maxDepth) throw fail('invalid_depth', '配置深度超过限制')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw fail('invalid_json_value', '配置只能包含有限 JSON 数值')
    return value
  }
  if (typeof value !== 'object') throw fail('invalid_json_value', '配置只能包含 JSON 值')
  if (ancestors.has(value)) throw fail('invalid_json_value', '配置不能包含循环引用')
  if (!Array.isArray(value) && !isPlainObject(value)) throw fail('invalid_json_value', '配置只能包含普通对象和数组')

  ancestors.add(value)
  let out
  if (Array.isArray(value)) {
    const keys = Object.keys(value)
    const ownKeys = Reflect.ownKeys(value)
    if (keys.length !== value.length || ownKeys.length !== value.length + 1 || !ownKeys.includes('length')) {
      throw fail('invalid_json_value', '配置数组不能包含空洞或额外字段')
    }
    out = []
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw fail('invalid_json_value', '配置数组不能包含访问器')
      out.push(cloneJson(descriptor.value, limits, path.concat(String(index)), ancestors, false))
    }
  } else {
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Reflect.ownKeys(value).length !== Object.keys(value).length) throw fail('invalid_json_value', '配置对象只能包含可枚举的数据字段')
    out = {}
    for (const key of Object.keys(value)) {
      const descriptor = descriptors[key]
      if (!Object.hasOwn(descriptor, 'value')) throw fail('invalid_json_value', '配置对象不能包含访问器')
      validateFieldName(key, path, headerNames)
      const childHeaderNames = compactKey(key) === 'extraheaders'
      out[key] = cloneJson(descriptor.value, limits, path.concat(key), ancestors, childHeaderNames)
    }
  }
  ancestors.delete(value)
  return out
}

function assertSize(value, maxBytes, label) {
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
  if (bytes > maxBytes) throw fail('invalid_size', label + ' 超过大小限制', { bytes, maxBytes })
}

function readLimits(opts) {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw fail('invalid_options', 'maxBytes 必须是正整数')
  if (!Number.isSafeInteger(maxDepth) || maxDepth <= 0) throw fail('invalid_options', 'maxDepth 必须是正整数')
  return { maxBytes, maxDepth }
}

function configVersionOf(cfg) {
  return cfg.configVersion === undefined ? 0 : cfg.configVersion
}

function validateConfig(input, limits, { allowRuntime = false } = {}) {
  const cfg = cloneJson(input, limits)
  if (!isPlainObject(cfg)) throw fail('invalid_config', '配置顶层必须是普通对象')
  if (cfg.configVersion !== undefined && (!Number.isSafeInteger(cfg.configVersion) || cfg.configVersion < 0)) {
    throw fail('invalid_version', 'configVersion 必须是非负安全整数')
  }
  for (const key of ['server', 'providers', 'models', 'defaults']) {
    if (cfg[key] !== undefined && !isPlainObject(cfg[key])) throw fail('invalid_config', key + ' 必须是普通对象')
  }
  if (cfg.virtualModels !== undefined && !Array.isArray(cfg.virtualModels)) throw fail('invalid_config', 'virtualModels 必须是数组')
  if (!allowRuntime) {
    for (const key of RUNTIME_FIELDS) if (Object.hasOwn(cfg, key)) throw fail('invalid_path_field', '备份不接受运行时文件路径或磁盘元数据')
  }
  assertSize(cfg, limits.maxBytes, '配置')
  return cfg
}

function stripUrlUserinfo(value) {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return value
  try {
    const url = new URL(value)
    if (!url.username && !url.password) return value
    url.username = ''
    url.password = ''
    return url.toString()
  } catch {
    return value.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/?#]*@/, '$1')
  }
}

function hasUrlUserinfo(value) {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return false
  try {
    const url = new URL(value)
    return !!(url.username || url.password)
  } catch {
    return /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*@/.test(value)
  }
}

function redactValue(value, key = '', headerNames = false) {
  if (headerNames) {
    const out = {}
    for (const name of Object.keys(value)) out[name] = mask()
    return out
  }
  if (isSensitiveKey(key)) return mask()
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry))
  if (isPlainObject(value)) {
    const out = {}
    for (const [name, entry] of Object.entries(value)) out[name] = redactValue(entry, name, compactKey(name) === 'extraheaders')
    return out
  }
  return stripUrlUserinfo(value)
}

function assertSafeImportValue(value, key = '', headerNames = false) {
  if (isMask(value)) return
  if (headerNames) {
    for (const entry of Object.values(value)) if (!isMask(entry)) throw fail('unsafe_backup_secret', '备份中的 extraHeaders 值必须已脱敏')
    return
  }
  if (isSensitiveKey(key)) throw fail('unsafe_backup_secret', '备份包含未脱敏的凭据字段')
  if (hasUrlUserinfo(value)) throw fail('unsafe_url_userinfo', '备份 URL 不能包含 userinfo')
  if (Array.isArray(value)) {
    for (const entry of value) assertSafeImportValue(entry)
    return
  }
  if (isPlainObject(value)) {
    for (const [name, entry] of Object.entries(value)) assertSafeImportValue(entry, name, compactKey(name) === 'extraheaders')
  }
}

function resolveCreatedAt(opts) {
  const raw = opts.createdAt ?? opts.now ?? new Date()
  const date = raw instanceof Date ? raw : new Date(raw)
  if (!Number.isFinite(date.getTime())) throw fail('invalid_created_at', 'createdAt 必须是有效日期')
  return date.toISOString()
}

function validateCreatedAt(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw fail('invalid_created_at', 'createdAt 必须是 ISO8601 UTC 时间')
  }
  const date = new Date(value)
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw fail('invalid_created_at', 'createdAt 必须是有效 ISO8601 UTC 时间')
  return value
}

/**
 * Create a deterministic, JSON-only backup envelope. Secret fields and every
 * extraHeaders value become {masked:true}; URL userinfo is removed. No I/O.
 * Options: maxBytes, maxDepth, now|createdAt.
 */
export function createBackup(cfg, opts = {}) {
  assertAllowedKeys(opts, new Set(['maxBytes', 'maxDepth', 'now', 'createdAt']), 'invalid_options', '备份选项')
  const limits = readLimits(opts)
  const validated = validateConfig(cfg, limits, { allowRuntime: true })
  const config = redactValue(validated)
  delete config._paths
  delete config._disk
  const backup = {
    schema: BACKUP_SCHEMA,
    version: BACKUP_VERSION,
    createdAt: resolveCreatedAt(opts),
    config,
  }
  assertSize(backup, limits.maxBytes, '备份')
  return backup
}

function validateBackup(candidate, limits) {
  const backup = cloneJson(candidate, { ...limits, maxDepth: Math.min(Number.MAX_SAFE_INTEGER, limits.maxDepth + 1) })
  assertExactKeys(backup, new Set(['schema', 'version', 'createdAt', 'config']), 'invalid_backup', '备份信封')
  if (backup.schema !== BACKUP_SCHEMA) throw fail('unsupported_backup_schema', '不支持的备份 schema')
  if (backup.version !== BACKUP_VERSION) throw fail('unsupported_backup_version', '不支持的备份版本')
  validateCreatedAt(backup.createdAt)
  const config = validateConfig(backup.config, limits)
  assertSafeImportValue(config)
  assertSize(backup, limits.maxBytes, '备份')
  return { schema: backup.schema, version: backup.version, createdAt: backup.createdAt, config }
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue)
  if (isPlainObject(value)) {
    const out = {}
    for (const [key, entry] of Object.entries(value)) out[key] = cloneValue(entry)
    return out
  }
  return value
}

function equalValue(left, right) {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((entry, index) => equalValue(entry, right[index]))
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)
    return leftKeys.length === rightKeys.length && leftKeys.every((key) => Object.hasOwn(right, key) && equalValue(left[key], right[key]))
  }
  return false
}

function pointer(path) {
  return path.length ? '/' + path.map((part) => part.replace(/~/g, '~0').replace(/\//g, '~1')).join('/') : ''
}

function containsSensitive(value, key = '', headerNames = false) {
  if (isMask(value)) return false
  if (headerNames || compactKey(key) === 'extraheaders') return isPlainObject(value) && Object.keys(value).length > 0
  if (isSensitiveKey(key)) return true
  if (Array.isArray(value)) return value.some((entry) => containsSensitive(entry))
  if (isPlainObject(value)) return Object.entries(value).some(([name, entry]) => containsSensitive(entry, name, compactKey(name) === 'extraheaders'))
  return false
}

function preserveOmittedKey(key, path, headerNames) {
  if (path.length === 0 && RUNTIME_FIELDS.has(key)) return true
  return !headerNames && isSensitiveKey(key)
}

function collectMaskedConflicts(value, path, conflicts) {
  if (isMask(value)) {
    conflicts.push({ path: pointer(path), reason: 'masked_value_unavailable' })
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectMaskedConflicts(entry, path.concat(String(index)), conflicts))
    return
  }
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) collectMaskedConflicts(entry, path.concat(key), conflicts)
  }
}

function diffValues(before, after, path, key, headerNames, diff) {
  if (isMask(after)) {
    if (before === MISSING) diff.conflicts.push({ path: pointer(path), reason: 'masked_value_unavailable' })
    return
  }
  if (before === MISSING) {
    diff.added.push({ path: pointer(path), after: redactValue(after, key, headerNames) })
    collectMaskedConflicts(after, path, diff.conflicts)
    return
  }
  if (after === MISSING) {
    diff.removed.push({ path: pointer(path), before: redactValue(before, key, headerNames) })
    if (containsSensitive(before, key, headerNames)) {
      diff.conflicts.push({ path: pointer(path), reason: 'sensitive_removal', before: redactValue(before, key, headerNames) })
    }
    return
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const common = Math.min(before.length, after.length)
    for (let index = 0; index < common; index += 1) diffValues(before[index], after[index], path.concat(String(index)), '', false, diff)
    for (let index = common; index < after.length; index += 1) diffValues(MISSING, after[index], path.concat(String(index)), '', false, diff)
    for (let index = common; index < before.length; index += 1) diffValues(before[index], MISSING, path.concat(String(index)), '', false, diff)
    return
  }
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    for (const name of keys) {
      if (path.length === 0 && name === 'configVersion') continue
      const childPath = path.concat(name)
      const childHeaders = compactKey(name) === 'extraheaders'
      if (!Object.hasOwn(after, name)) {
        if (!preserveOmittedKey(name, path, headerNames)) diffValues(before[name], MISSING, childPath, name, childHeaders, diff)
      } else {
        diffValues(Object.hasOwn(before, name) ? before[name] : MISSING, after[name], childPath, name, childHeaders, diff)
      }
    }
    return
  }
  if (equalValue(before, after)) return
  if (containsSensitive(before, key, headerNames)) {
    diff.conflicts.push({
      path: pointer(path),
      reason: 'sensitive_shape_conflict',
      before: redactValue(before, key, headerNames),
      after: redactValue(after, key, headerNames),
    })
    return
  }
  diff.updated.push({
    path: pointer(path),
    before: redactValue(before, key, headerNames),
    after: redactValue(after, key, headerNames),
  })
}

function sortDiff(diff) {
  const byPath = (left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  diff.added.sort(byPath)
  diff.updated.sort(byPath)
  diff.removed.sort(byPath)
  diff.conflicts.sort((left, right) => byPath(left, right) || (left.reason < right.reason ? -1 : left.reason > right.reason ? 1 : 0))
  return diff
}

function makeDiff(current, candidate) {
  const diff = { added: [], updated: [], removed: [], conflicts: [] }
  diffValues(current, candidate, [], '', false, diff)
  return sortDiff(diff)
}

function mergeValues(before, after, key, headerNames) {
  if (isMask(after)) return before === MISSING ? MISSING : cloneValue(before)
  if (isPlainObject(after)) {
    if (before !== MISSING && !isPlainObject(before)) {
      if (containsSensitive(before, key, headerNames)) return cloneValue(before)
      before = {}
    }
    const source = isPlainObject(before) ? before : {}
    const out = {}
    for (const [name, entry] of Object.entries(after)) {
      const merged = mergeValues(Object.hasOwn(source, name) ? source[name] : MISSING, entry, name, compactKey(name) === 'extraheaders')
      if (merged !== MISSING) out[name] = merged
    }
    for (const [name, entry] of Object.entries(source)) {
      if (!Object.hasOwn(after, name) && preserveOmittedKey(name, [], headerNames)) out[name] = cloneValue(entry)
    }
    return out
  }
  if (Array.isArray(after)) {
    if (!Array.isArray(before)) return cloneValue(after)
    return after.map((entry, index) => {
      const merged = mergeValues(index < before.length ? before[index] : MISSING, entry, '', false)
      return merged === MISSING ? null : merged
    })
  }
  if (before !== MISSING && !isPlainObject(before) && !Array.isArray(before) && containsSensitive(before, key, headerNames)) return cloneValue(before)
  return cloneValue(after)
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function planPayload(plan) {
  return {
    expectedVersion: plan.expectedVersion,
    nextVersion: plan.nextVersion,
    source: plan.source,
    candidate: plan.candidate,
    diff: plan.diff,
    limits: plan.limits,
  }
}

/**
 * Preview an import without I/O. expectedVersion defaults to the current
 * configVersion and is always bound into the returned plan. Diff paths are
 * JSON Pointers. Masked values retain the current local value; a missing local
 * value is reported as a conflict and prevents apply until re-authorized.
 */
export function previewImport(currentCfg, candidate, opts = {}) {
  assertAllowedKeys(opts, new Set(['maxBytes', 'maxDepth', 'expectedVersion']), 'invalid_options', '导入预览选项')
  const limits = readLimits(opts)
  const current = validateConfig(currentCfg, limits, { allowRuntime: true })
  const backup = validateBackup(candidate, limits)
  const currentVersion = configVersionOf(current)
  const expectedVersion = Object.hasOwn(opts, 'expectedVersion') ? opts.expectedVersion : currentVersion
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw fail('invalid_expected_version', 'expectedVersion 必须是非负安全整数')
  if (expectedVersion !== currentVersion) throw fail('version_conflict', '配置版本已过期，请刷新后重试', { currentVersion })
  if (expectedVersion === Number.MAX_SAFE_INTEGER) throw fail('invalid_expected_version', '配置版本无法继续递增')
  const diff = makeDiff(current, backup.config)
  const plan = {
    schema: PLAN_SCHEMA,
    version: PLAN_VERSION,
    expectedVersion,
    nextVersion: expectedVersion + 1,
    source: { schema: backup.schema, version: backup.version, createdAt: backup.createdAt },
    candidate: backup.config,
    diff,
    limits,
  }
  plan.planHash = hash(planPayload(plan))
  return plan
}

function validPointer(path) {
  if (path === '') return true
  if (typeof path !== 'string' || !path.startsWith('/')) return false
  return path.slice(1).split('/').every((part) => !/~(?:[^01]|$)/.test(part))
}

function cloneDiff(input, limits) {
  assertExactKeys(input, new Set(['added', 'updated', 'removed', 'conflicts']), 'invalid_import_plan', '导入差异')
  const out = { added: [], updated: [], removed: [], conflicts: [] }
  for (const kind of Object.keys(out)) {
    if (!Array.isArray(input[kind])) throw fail('invalid_import_plan', '导入差异类别必须是数组')
    for (const entry of input[kind]) {
      const allowed = kind === 'added' ? new Set(['path', 'after'])
        : kind === 'removed' ? new Set(['path', 'before'])
          : kind === 'updated' ? new Set(['path', 'before', 'after'])
            : new Set(['path', 'reason', 'before', 'after'])
      if (!isPlainObject(entry) || !validPointer(entry.path)) throw fail('invalid_import_plan', '导入差异路径必须是 JSON Pointer')
      const descriptors = Object.getOwnPropertyDescriptors(entry)
      if (Reflect.ownKeys(entry).length !== Object.keys(entry).length) throw fail('invalid_import_plan', '导入差异只能包含可枚举的数据字段')
      for (const key of Object.keys(entry)) {
        if (!allowed.has(key) || !Object.hasOwn(descriptors[key], 'value')) throw fail('invalid_import_plan', '导入差异包含不支持的字段')
      }
      if (!Object.hasOwn(entry, 'path') || (kind === 'added' && !Object.hasOwn(entry, 'after')) ||
          (kind === 'removed' && !Object.hasOwn(entry, 'before')) ||
          (kind === 'updated' && (!Object.hasOwn(entry, 'before') || !Object.hasOwn(entry, 'after'))) ||
          (kind === 'conflicts' && (typeof entry.reason !== 'string' || !entry.reason))) {
        throw fail('invalid_import_plan', '导入差异条目形状非法')
      }
      const cloned = { path: entry.path }
      if (kind === 'conflicts') cloned.reason = entry.reason
      if (Object.hasOwn(entry, 'before')) cloned.before = cloneJson(entry.before, limits)
      if (Object.hasOwn(entry, 'after')) cloned.after = cloneJson(entry.after, limits)
      out[kind].push(cloned)
    }
  }
  return out
}

function validatePlan(plan) {
  assertExactKeys(plan, new Set([
    'schema', 'version', 'expectedVersion', 'nextVersion', 'source', 'candidate', 'diff', 'limits', 'planHash',
  ]), 'invalid_import_plan', '导入计划')
  if (plan.schema !== PLAN_SCHEMA || plan.version !== PLAN_VERSION) throw fail('invalid_import_plan', '导入计划 schema 或版本非法')
  if (!Number.isSafeInteger(plan.expectedVersion) || plan.expectedVersion < 0 || !Number.isSafeInteger(plan.nextVersion) ||
      plan.nextVersion !== plan.expectedVersion + 1) throw fail('invalid_import_plan', '导入计划版本绑定非法')
  assertExactKeys(plan.source, new Set(['schema', 'version', 'createdAt']), 'invalid_import_plan', '导入来源')
  if (plan.source.schema !== BACKUP_SCHEMA || plan.source.version !== BACKUP_VERSION) throw fail('invalid_import_plan', '导入来源版本非法')
  validateCreatedAt(plan.source.createdAt)
  assertExactKeys(plan.limits, new Set(['maxBytes', 'maxDepth']), 'invalid_import_plan', '导入限制')
  const limits = readLimits(plan.limits)
  const backup = validateBackup({
    schema: plan.source.schema,
    version: plan.source.version,
    createdAt: plan.source.createdAt,
    config: plan.candidate,
  }, limits)
  const diff = cloneDiff(plan.diff, limits)
  if (typeof plan.planHash !== 'string' || !/^[a-f0-9]{64}$/.test(plan.planHash)) throw fail('invalid_import_plan', '导入计划哈希非法')
  const normalized = {
    expectedVersion: plan.expectedVersion,
    nextVersion: plan.nextVersion,
    source: { schema: backup.schema, version: backup.version, createdAt: backup.createdAt },
    candidate: backup.config,
    diff,
    limits,
  }
  if (hash(planPayload(normalized)) !== plan.planHash) throw fail('plan_binding_mismatch', '导入计划已被修改')
  return { backup, diff, limits, expectedVersion: plan.expectedVersion, nextVersion: plan.nextVersion }
}

/** Apply a previewed import purely in memory, returning a new config object. */
export function applyImportPlan(currentCfg, plan) {
  const validatedPlan = validatePlan(plan)
  const current = validateConfig(currentCfg, validatedPlan.limits, { allowRuntime: true })
  const currentVersion = configVersionOf(current)
  if (currentVersion !== validatedPlan.expectedVersion) throw fail('version_conflict', '配置版本已过期，请刷新后重试', { currentVersion })
  const currentDiff = makeDiff(current, validatedPlan.backup.config)
  if (!equalValue(currentDiff, validatedPlan.diff)) throw fail('preview_conflict', '预览后配置已变化，请重新生成导入预览')
  if (currentDiff.conflicts.length) {
    throw fail('import_conflict', '导入包含需要重新授权的凭据冲突', { paths: currentDiff.conflicts.map((entry) => entry.path) })
  }
  const candidate = cloneValue(validatedPlan.backup.config)
  delete candidate.configVersion
  const merged = mergeValues(current, candidate, '', false)
  merged.configVersion = validatedPlan.nextVersion
  return validateConfig(merged, validatedPlan.limits, { allowRuntime: true })
}
