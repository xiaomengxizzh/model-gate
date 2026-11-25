import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync,
  mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

// Managed Harness configuration adapters. Detection is metadata-only; configuration
// bodies are read only after an explicit managedRoot and a supported target path are supplied.
// The fixtures prove serialization/transactions, not real Harness protocol compatibility.
export const HARNESS_ADAPTER_CONTRACT = 'mg-harness-adapters/1'

const CONTRACT = HARNESS_ADAPTER_CONTRACT
const STORE_DIR = '.modelgate-harness-adapters'
const MAX_CONFIG_BYTES = 1024 * 1024
const MAX_STORE_METADATA_BYTES = 64 * 1024
const MAX_MODELS = 100
const DEFAULT_TTL_MS = 5 * 60 * 1000
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const BACKUP_ID_RE = /^hbk_[A-Za-z0-9_-]{16,64}$/
const TOKEN_RE = /^[A-Za-z0-9_-]{32,96}$/
const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const FORBIDDEN_OPTION_KEYS = new Set([
  'key', 'apikey', 'authtoken', 'token', 'accesstoken', 'refreshtoken', 'password',
  'passwd', 'secret', 'clientsecret', 'credential', 'credentials', 'authorization',
  'cookie', 'headers', 'extraheaders', 'raw', 'content', 'patch', 'command', 'helper',
])
const PREVIEW_KEYS = new Set([
  'harnessId', 'path', 'endpoint', 'apiKeyEnv', 'providerId', 'models', 'package', 'api',
])
const COMMON_PREVIEW_KEYS = new Set([
  'managedRoot', 'harnessId', 'harness', 'path', 'endpoint', 'baseUrl', 'apiKeyEnv', 'env',
  'providerId', 'requestId', 'now', 'ttlMs',
])
const APPLY_KEYS = new Set([
  ...COMMON_PREVIEW_KEYS, ...PREVIEW_KEYS, 'model', 'providerPackage', 'protocol',
  'confirmToken', 'previewId', 'preview', 'expectedVersion', 'beforeHash', 'afterHash',
  'backupId', 'expiresAt', 'before', 'after', 'diff', 'planHash', 'ok', 'contract',
  'format', 'capability', 'realProtocol', 'writesEnabled',
])

const ADAPTERS = Object.freeze([
  Object.freeze({
    id: 'claude-code',
    aliases: Object.freeze(['claude', 'claude code', 'claudecode', 'claude-code']),
    label: 'Claude Code',
    fileName: 'settings.json',
    defaultPath: '.claude/settings.json',
    format: 'json',
    detectionPaths: Object.freeze(['.claude/settings.json', '.claude/settings.local.json']),
    protocols: Object.freeze(['anthropic-messages']),
    defaultApiKeyEnv: 'MODELGATE_API_KEY',
  }),
  Object.freeze({
    id: 'opencode',
    aliases: Object.freeze(['opencode', 'open-code']),
    label: 'OpenCode',
    fileName: 'opencode.json',
    defaultPath: '.config/opencode/opencode.json',
    format: 'json',
    detectionPaths: Object.freeze([
      '.config/opencode/opencode.json', '.config/opencode/opencode.jsonc',
      '.opencode/opencode.json', 'opencode.json',
    ]),
    protocols: Object.freeze(['openai-compatible', 'anthropic-messages']),
    defaultApiKeyEnv: 'MODELGATE_API_KEY',
  }),
  Object.freeze({
    id: 'dsh',
    aliases: Object.freeze(['dsh', 'deepseek-harness']),
    label: 'DSH',
    fileName: 'cordis.patch.yml',
    defaultPath: '.dsh/profiles/default/cordis.patch.yml',
    format: 'yaml-subset',
    detectionPaths: Object.freeze([
      '.dsh/profiles/default/cordis.patch.yml', '.dsh/profiles/web/cordis.patch.yml',
    ]),
    protocols: Object.freeze(['openai-completions', 'openai-responses', 'anthropic-messages']),
    defaultApiKeyEnv: 'MODELGATE_API_KEY',
  }),
  Object.freeze({
    id: 'xmxz',
    aliases: Object.freeze(['xmxz']),
    label: 'xmxz',
    fileName: null,
    defaultPath: null,
    format: null,
    detectionPaths: Object.freeze([]),
    protocols: Object.freeze([]),
    defaultApiKeyEnv: null,
  }),
])

const confirmations = new Map()

class HarnessAdapterError extends Error {
  constructor (code, message, status = 400, details) {
    super(message)
    this.name = 'HarnessAdapterError'
    this.code = code
    this.status = status
    this.retryable = false
    if (details) this.details = details
  }
}

function fail (code, message, status = 400, details) {
  return new HarnessAdapterError(code, message, status, details)
}

function isPlainObject (value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function compactKey (key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, '')
}

function assertOptions (value, allowed, label = 'opts') {
  if (!isPlainObject(value)) throw fail('invalid_options', label + ' 必须是普通对象')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(value).length !== Object.keys(value).length) {
    throw fail('invalid_options', label + ' 只能包含可枚举的数据字段')
  }
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key], 'value')) {
      throw fail('invalid_options', label + ' 不能包含访问器')
    }
    if (FORBIDDEN_OPTION_KEYS.has(compactKey(key))) {
      throw fail('inline_credential_forbidden', label + ' 不接受内联凭据字段 ' + JSON.stringify(key))
    }
    if (!allowed.has(key)) throw fail('invalid_options', label + ' 包含不支持的字段')
  }
}

function adapterByKey (value) {
  const key = String(value || '').trim().toLowerCase()
  const adapter = ADAPTERS.find((item) => item.aliases.includes(key))
  if (!adapter) throw fail('unknown_harness', '未知 Harness')
  return adapter
}

function requireSupported (adapter) {
  if (adapter.id === 'xmxz') {
    throw fail('unsupported_harness', 'xmxz 已有官方路径与 ProviderProfile 合同，但 owner config 完整 schema/加载器尚未实现，保持 unsupported', 422)
  }
  return adapter
}

function publicAdapter (adapter) {
  const supported = adapter.id !== 'xmxz'
  return {
    harnessId: adapter.id,
    label: adapter.label,
    status: supported ? 'supported' : 'unsupported',
    stage: supported ? 'A6' : 'planned',
    config: supported ? {
      fileName: adapter.fileName,
      defaultPath: adapter.defaultPath,
      format: adapter.format,
      detectionPaths: [...adapter.detectionPaths],
    } : null,
    protocols: adapter.protocols.map((id) => ({
      id,
      configuration: 'fixture-verified',
      runtime: 'not-real-tested',
    })),
    verification: {
      configuration: 'fixture-verified',
      realClient: 'not-real-tested',
      realProtocol: 'not-real-tested',
    },
    ...(!supported ? { reason: '官方路径与 ProviderProfile 已核验；owner config 完整 schema/加载器缺失，不提供一键写入' } : {}),
  }
}

export function listHarnessAdapters (opts = {}) {
  assertOptions(opts, new Set(['includeUnsupported']), 'listHarnessAdapters opts')
  if (Object.hasOwn(opts, 'includeUnsupported') && typeof opts.includeUnsupported !== 'boolean') {
    throw fail('invalid_options', 'includeUnsupported 必须是布尔值')
  }
  return ADAPTERS
    .filter((adapter) => opts.includeUnsupported !== false || adapter.id !== 'xmxz')
    .map(publicAdapter)
}

function resolveHome (opts) {
  const raw = Object.hasOwn(opts, 'home') ? opts.home : (process.env.HOME || homedir())
  if (typeof raw !== 'string' || !raw || raw.includes('\0') || !isAbsolute(raw)) {
    throw fail('invalid_home', 'HOME 必须是显式绝对路径')
  }
  return resolve(raw)
}

function detectCandidate (home, candidate) {
  const target = join(home, candidate)
  try {
    const stat = lstatSync(target)
    return {
      path: candidate,
      present: true,
      file: stat.isFile(),
      symlink: stat.isSymbolicLink(),
      bytes: stat.isFile() ? stat.size : null,
    }
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return { path: candidate, present: false, file: false, symlink: false, bytes: null }
    }
    return { path: candidate, present: false, file: false, symlink: false, bytes: null, state: 'unknown' }
  }
}

export function detectHarnesses (opts = {}) {
  assertOptions(opts, new Set(['home']), 'detectHarnesses opts')
  const home = resolveHome(opts)
  return ADAPTERS.map((adapter) => {
    const item = publicAdapter(adapter)
    if (adapter.id === 'xmxz') {
      return { ...item, detection: { state: 'unsupported', exists: false, configPaths: [] } }
    }
    const configPaths = adapter.detectionPaths.map((candidate) => detectCandidate(home, candidate))
    const unknown = configPaths.some((candidate) => candidate.state === 'unknown')
    const invalid = configPaths.some((candidate) => candidate.present && !candidate.file && !candidate.symlink)
    const exists = configPaths.some((candidate) => candidate.present)
    return {
      ...item,
      detection: {
        state: unknown ? 'unknown' : invalid ? 'invalid' : exists ? 'detected' : 'not_detected',
        exists,
        configPaths,
      },
    }
  })
}

function normalizeEndpoint (value) {
  if (typeof value !== 'string' || !value.trim()) throw fail('invalid_endpoint', 'endpoint 必填')
  const raw = value.trim()
  if (raw.length > 2048 || /[\u0000-\u001f\u007f]/.test(raw)) throw fail('invalid_endpoint', 'endpoint 格式非法')
  let url
  try { url = new URL(raw) } catch { throw fail('invalid_endpoint', 'endpoint 必须是完整 http(s) URL') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw fail('invalid_endpoint', 'endpoint 仅支持 http(s)')
  if (url.username || url.password) throw fail('inline_credential_forbidden', 'endpoint 不能包含账号或密码')
  if (url.search || url.hash) throw fail('invalid_endpoint', 'endpoint 不能包含 query 或 fragment')
  return url.toString().replace(/\/+$/, '')
}

function normalizeEnvName (value, fallback) {
  const raw = value === undefined ? fallback : value
  if (typeof raw !== 'string' || !ENV_NAME_RE.test(raw) || raw.length > 128) {
    throw fail('invalid_api_key_env', 'apiKeyEnv 必须是合法环境变量名（只写名称，不读取值）')
  }
  return raw
}

function normalizeProviderId (value) {
  const raw = value === undefined ? 'modelgate' : value
  if (typeof raw !== 'string' || !PROVIDER_ID_RE.test(raw) || RESERVED_KEYS.has(raw)) {
    throw fail('invalid_provider_id', 'providerId 必须是安全的小写标识')
  }
  return raw
}

function cleanText (value, label, max = 200) {
  if (typeof value !== 'string') throw fail('invalid_models', label + ' 必须是字符串')
  const out = value.trim()
  if (!out || out.length > max || /[\u0000-\u001f\u007f]/.test(out) || RESERVED_KEYS.has(out)) {
    throw fail('invalid_models', label + ' 格式非法')
  }
  return out
}

function normalizeModels (value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MODELS) {
    throw fail('invalid_models', 'models 必须是 1–100 项的非空数组')
  }
  const seen = new Set()
  return value.map((entry) => {
    let id
    let name
    if (typeof entry === 'string') {
      id = cleanText(entry, 'model id')
      name = id
    } else {
      if (!isPlainObject(entry)) throw fail('invalid_models', 'models 项必须是字符串或普通对象')
      assertOptions(entry, new Set(['id', 'modelID', 'upstreamModelId', 'name']), 'model')
      const ids = ['id', 'modelID', 'upstreamModelId'].filter((key) => Object.hasOwn(entry, key))
      if (ids.length !== 1) throw fail('invalid_models', '每个 model 必须且只能提供一个 id')
      id = cleanText(entry[ids[0]], 'model id')
      name = Object.hasOwn(entry, 'name') ? cleanText(entry.name, 'model name') : id
    }
    if (seen.has(id)) throw fail('invalid_models', 'models 不能包含重复 id')
    seen.add(id)
    return { id, name }
  })
}

function normalizeOpenCodePackage (value) {
  const raw = value === undefined ? 'openai-compatible' : value
  if (typeof raw !== 'string') throw fail('unsupported_protocol', 'OpenCode package 不受支持')
  if (['openai-compatible', '@ai-sdk/openai-compatible', 'openai', 'chat-completions'].includes(raw)) {
    return { package: '@ai-sdk/openai-compatible', protocol: 'openai-compatible', kind: 'openai-compatible' }
  }
  if (['anthropic', '@ai-sdk/anthropic', 'anthropic-messages'].includes(raw)) {
    return { package: '@ai-sdk/anthropic', protocol: 'anthropic-messages', kind: 'anthropic' }
  }
  throw fail('unsupported_protocol', 'OpenCode 仅支持 openai-compatible 或 anthropic package', 422)
}

function normalizeDshApi (value) {
  const raw = value === undefined ? 'openai-completions' : value
  if (!['openai-completions', 'openai-responses', 'anthropic-messages'].includes(raw)) {
    throw fail('unsupported_protocol', 'DSH api 必须是 openai-completions/openai-responses/anthropic-messages', 422)
  }
  return raw
}

function selectedAlias (opts, first, second) {
  if (Object.hasOwn(opts, first) && Object.hasOwn(opts, second) && opts[first] !== opts[second]) {
    throw fail('invalid_options', first + ' 与 ' + second + ' 不一致')
  }
  return Object.hasOwn(opts, first) ? opts[first] : opts[second]
}

function normalizeIntent (adapter, opts) {
  const endpoint = normalizeEndpoint(selectedAlias(opts, 'endpoint', 'baseUrl'))
  const apiKeyEnv = normalizeEnvName(selectedAlias(opts, 'apiKeyEnv', 'env'), adapter.defaultApiKeyEnv)
  const providerId = normalizeProviderId(opts.providerId)
  const intent = { endpoint, apiKeyEnv, providerId }
  if (adapter.id === 'opencode') {
    intent.models = normalizeModels(Object.hasOwn(opts, 'models') ? opts.models : opts.model)
    Object.assign(intent, normalizeOpenCodePackage(selectedAlias(opts, 'package', 'providerPackage') ?? opts.protocol ?? opts.api))
  } else if (adapter.id === 'dsh') {
    intent.models = normalizeModels(Object.hasOwn(opts, 'models') ? opts.models : opts.model)
    intent.api = normalizeDshApi(opts.api ?? opts.protocol)
  }
  return intent
}

function resolveManagedRoot (opts) {
  if (!Object.hasOwn(opts, 'managedRoot') || typeof opts.managedRoot !== 'string' || !opts.managedRoot) {
    throw fail('write_disabled', '写入必须由调用方显式提供 managedRoot', 403)
  }
  const raw = opts.managedRoot
  if (raw.includes('\0') || !isAbsolute(raw)) throw fail('invalid_managed_root', 'managedRoot 必须是绝对路径')
  const root = resolve(raw)
  let stat
  try { stat = lstatSync(root) } catch { throw fail('managed_root_unavailable', 'managedRoot 不存在或不可访问') }
  if (stat.isSymbolicLink()) throw fail('symlink_refused', 'managedRoot 不能是符号链接', 403)
  if (!stat.isDirectory()) throw fail('invalid_managed_root', 'managedRoot 必须是目录')
  let realRoot
  try { realRoot = realpathSync(root) } catch { throw fail('managed_root_unavailable', 'managedRoot 无法解析') }
  return realRoot
}

function assertNoSymlinkComponents (root, target, { allowMissing = true, directory = false } = {}) {
  let current = target
  while (current !== root) {
    let stat = null
    try { stat = lstatSync(current) } catch (error) {
      if (!allowMissing || !error || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')) {
        throw fail('path_unavailable', '目标路径不可访问')
      }
    }
    if (stat) {
      if (stat.isSymbolicLink()) throw fail('symlink_refused', '目标路径包含符号链接', 403)
      if (current !== target && !stat.isDirectory()) throw fail('invalid_path', '目标父路径不是目录')
      if (current === target && directory && !stat.isDirectory()) throw fail('invalid_path', '目标不是目录')
      if (current === target && !directory && !stat.isFile()) throw fail('invalid_path', '目标不是普通文件')
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
}

function contextFor (root, adapter, rawPath) {
  if (typeof rawPath !== 'string' || !rawPath || rawPath.includes('\0') || rawPath.includes('\\')) {
    throw fail('invalid_path', 'path 必须是 root 内的相对路径或绝对路径')
  }
  const target = isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath)
  const rel = relative(root, target)
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    throw fail('path_traversal', 'path 越出 managedRoot')
  }
  if (rel.split(sep)[0] === STORE_DIR) throw fail('forbidden_path', 'path 不能进入 Harness 备份目录')
  if (basename(target) !== adapter.fileName) throw fail('invalid_path', 'path 文件名与 Harness adapter 不匹配')
  assertNoSymlinkComponents(root, target)
  return { root, target, relativePath: rel, adapter }
}

function managedContext (opts, adapter) {
  const root = resolveManagedRoot(opts)
  return contextFor(root, adapter, Object.hasOwn(opts, 'path') ? opts.path : adapter.defaultPath)
}

function sha256 (bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function readRegularFile (path, maxBytes, root, { missingOk = false } = {}) {
  assertNoSymlinkComponents(root, path)
  let fd = null
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  } catch (error) {
    if (missingOk && error && error.code === 'ENOENT') return { exists: false, bytes: null, hash: null, mode: null, size: 0 }
    if (error && (error.code === 'ELOOP' || error.code === 'EACCES')) throw fail('symlink_refused', '拒绝读取符号链接或不可访问目标', 403)
    throw error
  }
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || before.nlink > 1) throw fail('invalid_path', '目标必须是普通单链接文件')
    if (before.size > maxBytes) throw fail('invalid_size', '配置文件超过大小限制')
    const bytes = readFileSync(fd)
    const after = fstatSync(fd)
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino || after.dev !== before.dev) {
      throw fail('config_conflict', '配置文件在读取期间发生变化', 409)
    }
    assertNoSymlinkComponents(root, path)
    const current = lstatSync(path)
    if (current.ino !== after.ino || current.dev !== after.dev) throw fail('config_conflict', '配置文件已被替换', 409)
    return { exists: true, bytes, hash: sha256(bytes), mode: after.mode & 0o777, size: bytes.length }
  } finally {
    closeSync(fd)
  }
}

function readManaged (context) {
  return readRegularFile(context.target, MAX_CONFIG_BYTES, context.root, { missingOk: true })
}

function writeAll (fd, bytes) {
  let offset = 0
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset)
    if (!written) throw fail('transaction_failed', '文件写入没有进展', 500)
    offset += written
  }
}

function fsyncDirectory (path) {
  let fd = null
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY || 0))
    fsyncSync(fd)
  } catch {
    // Atomic rename is the commit point; directory fsync is best effort on this local store.
  } finally {
    if (fd !== null) try { closeSync(fd) } catch {}
  }
}

function ensureParent (context) {
  const parent = dirname(context.target)
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  assertNoSymlinkComponents(context.root, parent, { directory: true })
  return parent
}

function atomicWrite (context, bytes) {
  const parent = ensureParent(context)
  const temp = join(parent, '.' + basename(context.target) + '.tmp-' + process.pid + '-' + randomBytes(8).toString('hex'))
  let fd = null
  let created = false
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600)
    created = true
    fchmodSync(fd, 0o600)
    writeAll(fd, bytes)
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    assertNoSymlinkComponents(context.root, context.target)
    renameSync(temp, context.target)
    fsyncDirectory(parent)
  } catch (error) {
    if (fd !== null) try { closeSync(fd) } catch {}
    if (created) try { unlinkSync(temp) } catch {}
    throw error
  }
}

function validateData (value, depth = 0) {
  if (depth > 50) throw fail('invalid_config', '配置嵌套过深')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (Array.isArray(value)) {
    for (const item of value) validateData(item, depth + 1)
    return
  }
  if (!isPlainObject(value)) throw fail('invalid_config', '配置包含不支持的数据类型')
  for (const key of Object.keys(value)) {
    if (RESERVED_KEYS.has(key)) throw fail('invalid_reserved_key', '配置包含保留字段名')
    validateData(value[key], depth + 1)
  }
}

function parseJsonConfig (bytes) {
  let value
  try { value = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')) } catch { throw fail('invalid_config', '现有 JSON 配置无法解析') }
  if (!isPlainObject(value)) throw fail('invalid_config', '现有 JSON 配置顶层必须是对象')
  validateData(value)
  return value
}

function objectField (parent, key) {
  if (!Object.hasOwn(parent, key)) parent[key] = {}
  if (!isPlainObject(parent[key])) throw fail('invalid_config', '现有配置字段 ' + key + ' 必须是对象')
  return parent[key]
}

function envReference (name) {
  return '{env:' + name + '}'
}

function mergeClaude (before, intent) {
  const after = before.exists ? parseJsonConfig(before.bytes) : {}
  const env = objectField(after, 'env')
  env.ANTHROPIC_BASE_URL = intent.endpoint
  env.ANTHROPIC_AUTH_TOKEN = envReference(intent.apiKeyEnv)
  return Buffer.from(JSON.stringify(after, null, 2) + '\n')
}

function mergeOpenCode (before, intent) {
  const after = before.exists ? parseJsonConfig(before.bytes) : {}
  const providers = objectField(after, 'providers')
  const provider = objectField(providers, intent.providerId)
  for (const key of ['apiKey', 'key', 'token', 'authToken', 'credentials']) {
    if (Object.hasOwn(provider, key)) throw fail('inline_credential_forbidden', '现有 OpenCode provider 包含内联凭据字段')
  }
  const options = objectField(provider, 'options')
  provider.package = intent.package
  options.baseURL = intent.endpoint
  options.apiKey = envReference(intent.apiKeyEnv)
  provider.models = Object.fromEntries(intent.models.map((model) => [model.id, { name: model.name }]))
  return Buffer.from(JSON.stringify(after, null, 2) + '\n')
}

function stripYamlComment (text) {
  let quote = null
  let escaped = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quote) {
      if (escaped) escaped = false
      else if (quote === '"' && char === '\\') escaped = true
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '#' && (index === 0 || /\s/.test(text[index - 1]))) return text.slice(0, index).trimEnd()
  }
  return text.trimEnd()
}

function splitYamlFlow (text) {
  const parts = []
  let start = 0
  let quote = null
  let escaped = false
  let square = 0
  let curly = 0
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quote) {
      if (escaped) escaped = false
      else if (quote === '"' && char === '\\') escaped = true
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '[') square++
    else if (char === ']') square--
    else if (char === '{') curly++
    else if (char === '}') curly--
    else if (char === ',' && square === 0 && curly === 0) {
      parts.push(text.slice(start, index).trim())
      start = index + 1
    }
    if (square < 0 || curly < 0) throw fail('unsupported_yaml', '现有 YAML flow 格式不平衡')
  }
  if (quote || square || curly) throw fail('unsupported_yaml', '现有 YAML flow 格式不完整')
  parts.push(text.slice(start).trim())
  return parts
}

function splitYamlKey (text) {
  let quote = null
  let escaped = false
  let square = 0
  let curly = 0
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quote) {
      if (escaped) escaped = false
      else if (quote === '"' && char === '\\') escaped = true
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '[') square++
    else if (char === ']') square--
    else if (char === '{') curly++
    else if (char === '}') curly--
    else if (char === ':' && square === 0 && curly === 0 && (index + 1 === text.length || /\s/.test(text[index + 1]))) {
      return [text.slice(0, index).trim(), text.slice(index + 1).trim()]
    }
  }
  return null
}

function yamlScalar (text) {
  const raw = text.trim()
  if (!raw) return null
  if (raw.startsWith('"')) {
    try { return JSON.parse(raw) } catch { throw fail('unsupported_yaml', '现有 YAML 双引号标量无效') }
  }
  if (raw.startsWith("'")) {
    if (raw.length < 2 || !raw.endsWith("'")) throw fail('unsupported_yaml', '现有 YAML 单引号标量无效')
    return raw.slice(1, -1).replace(/''/g, "'")
  }
  if (raw.startsWith('[')) {
    if (!raw.endsWith(']')) throw fail('unsupported_yaml', '现有 YAML 数组无效')
    const inner = raw.slice(1, -1).trim()
    return inner ? splitYamlFlow(inner).map(yamlScalar) : []
  }
  if (raw.startsWith('{')) {
    if (!raw.endsWith('}')) throw fail('unsupported_yaml', '现有 YAML 对象无效')
    const inner = raw.slice(1, -1).trim()
    const out = {}
    if (!inner) return out
    for (const part of splitYamlFlow(inner)) {
      const pair = splitYamlKey(part)
      if (!pair) throw fail('unsupported_yaml', '现有 YAML flow 对象无效')
      const key = yamlScalar(pair[0])
      if (typeof key !== 'string' || RESERVED_KEYS.has(key) || Object.hasOwn(out, key)) throw fail('unsupported_yaml', '现有 YAML 对象键无效或重复')
      out[key] = yamlScalar(pair[1])
    }
    return out
  }
  if (/^[!&*|>]/.test(raw)) throw fail('unsupported_yaml', '现有 YAML 含不支持的标签、锚点或多行标量')
  if (raw === 'null' || raw === '~') return null
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw)) {
    const number = Number(raw)
    if (Number.isFinite(number)) return number
  }
  return raw
}

function yamlKey (text) {
  const key = yamlScalar(text)
  if (typeof key !== 'string' || !key || RESERVED_KEYS.has(key)) throw fail('unsupported_yaml', '现有 YAML 键无效')
  return key
}

function parseYamlSubset (text) {
  const lines = []
  for (const [index, original] of text.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    if (original.includes('\t')) throw fail('unsupported_yaml', '现有 YAML 使用制表符缩进')
    const cleaned = stripYamlComment(original)
    if (!cleaned.trim() || cleaned.trim() === '---' || cleaned.trim() === '...') continue
    const indent = cleaned.length - cleaned.trimStart().length
    lines.push({ indent, text: cleaned.trimStart(), line: index + 1 })
  }
  if (!lines.length) return null
  let cursor = 0

  function assign (object, keyText, valueText, parentIndent) {
    const key = yamlKey(keyText)
    if (Object.hasOwn(object, key)) throw fail('unsupported_yaml', '现有 YAML 包含重复键')
    if (valueText) object[key] = yamlScalar(valueText)
    else if (cursor < lines.length && lines[cursor].indent > parentIndent) object[key] = parseBlock(lines[cursor].indent)
    else object[key] = null
  }

  function parseMapping (indent) {
    const out = {}
    while (cursor < lines.length && lines[cursor].indent === indent) {
      const line = lines[cursor]
      if (line.text === '-' || line.text.startsWith('- ')) break
      const pair = splitYamlKey(line.text)
      if (!pair) throw fail('unsupported_yaml', '现有 YAML 含不支持的块标量或语法')
      cursor++
      assign(out, pair[0], pair[1], indent)
    }
    return out
  }

  function parseSequence (indent) {
    const out = []
    while (cursor < lines.length && lines[cursor].indent === indent) {
      const line = lines[cursor]
      if (line.text !== '-' && !line.text.startsWith('- ')) break
      const rest = line.text === '-' ? '' : line.text.slice(2).trim()
      cursor++
      if (!rest) {
        out.push(cursor < lines.length && lines[cursor].indent > indent ? parseBlock(lines[cursor].indent) : null)
        continue
      }
      const pair = splitYamlKey(rest)
      if (!pair) {
        out.push(yamlScalar(rest))
        if (cursor < lines.length && lines[cursor].indent > indent) throw fail('unsupported_yaml', '现有 YAML 序列标量后存在不支持的内容')
        continue
      }
      const item = {}
      assign(item, pair[0], pair[1], indent + 2)
      if (cursor < lines.length && lines[cursor].indent > indent) {
        const extra = parseMapping(lines[cursor].indent)
        for (const [key, value] of Object.entries(extra)) {
          if (Object.hasOwn(item, key)) throw fail('unsupported_yaml', '现有 YAML 序列对象包含重复键')
          item[key] = value
        }
      }
      out.push(item)
    }
    return out
  }

  function parseBlock (indent) {
    const line = lines[cursor]
    return line.text === '-' || line.text.startsWith('- ') ? parseSequence(indent) : parseMapping(indent)
  }

  const value = parseBlock(lines[0].indent)
  if (cursor !== lines.length) throw fail('unsupported_yaml', '现有 YAML 缩进或语法不受支持')
  validateData(value)
  return value
}

function yamlQuotedKey (key) {
  return /^[A-Za-z0-9_.-]+$/.test(key) ? key : JSON.stringify(key)
}

function yamlScalarOut (value) {
  if (value === null) return 'null'
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  if (typeof value === 'string') return JSON.stringify(value)
  throw fail('unsupported_yaml', '无法序列化 YAML 值')
}

function isScalar (value) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value)
}

function emitYaml (value, indent = 0) {
  const padding = ' '.repeat(indent)
  const lines = []
  if (Array.isArray(value)) {
    if (!value.length) return [padding + '[]']
    for (const item of value) {
      if (isPlainObject(item) && Object.keys(item).length) {
        const entries = Object.entries(item)
        const [firstKey, firstValue] = entries[0]
        const key = yamlQuotedKey(firstKey)
        if (isScalar(firstValue)) lines.push(padding + '- ' + key + ': ' + yamlScalarOut(firstValue))
        else if (Array.isArray(firstValue) && !firstValue.length) lines.push(padding + '- ' + key + ': []')
        else if (isPlainObject(firstValue) && !Object.keys(firstValue).length) lines.push(padding + '- ' + key + ': {}')
        else {
          lines.push(padding + '- ' + key + ':')
          lines.push(...emitYaml(firstValue, indent + 4))
        }
        if (entries.length > 1) lines.push(...emitYaml(Object.fromEntries(entries.slice(1)), indent + 2))
      } else if (isScalar(item)) lines.push(padding + '- ' + yamlScalarOut(item))
      else if (Array.isArray(item) && !item.length) lines.push(padding + '- []')
      else if (isPlainObject(item) && !Object.keys(item).length) lines.push(padding + '- {}')
      else throw fail('unsupported_yaml', '无法序列化 YAML 序列项')
    }
    return lines
  }
  if (isPlainObject(value)) {
    if (!Object.keys(value).length) return [padding + '{}']
    for (const [key, item] of Object.entries(value)) {
      const renderedKey = yamlQuotedKey(key)
      if (isScalar(item)) lines.push(padding + renderedKey + ': ' + yamlScalarOut(item))
      else if (Array.isArray(item) && !item.length) lines.push(padding + renderedKey + ': []')
      else if (isPlainObject(item) && !Object.keys(item).length) lines.push(padding + renderedKey + ': {}')
      else {
        lines.push(padding + renderedKey + ':')
        lines.push(...emitYaml(item, indent + 2))
      }
    }
    return lines
  }
  return [padding + yamlScalarOut(value)]
}

function mergeDsh (before, intent) {
  const parsed = before.exists ? parseYamlSubset(before.bytes.toString('utf8')) : null
  const after = parsed === null ? [] : parsed
  if (!Array.isArray(after)) throw fail('invalid_config', 'DSH cordis.patch.yml 顶层必须是补丁条目数组')
  const matches = after.filter((entry) => isPlainObject(entry) && entry.id === 'llm-pi-ai')
  if (matches.length > 1) throw fail('invalid_config', 'DSH 配置包含重复 llm-pi-ai 条目')
  let entry = matches[0]
  if (!entry) {
    entry = { id: 'llm-pi-ai', config: {} }
    after.push(entry)
  }
  const config = objectField(entry, 'config')
  const providers = objectField(config, 'providers')
  const provider = objectField(providers, intent.providerId)
  for (const key of ['apiKey', 'key', 'token', 'authToken', 'credentials']) {
    if (Object.hasOwn(provider, key)) throw fail('inline_credential_forbidden', '现有 DSH provider 包含内联凭据字段')
  }
  if (Object.hasOwn(provider, 'models') && !Array.isArray(provider.models)) {
    throw fail('invalid_config', '现有 DSH provider.models 必须是数组')
  }
  provider.apiKeyEnv = intent.apiKeyEnv
  provider.api = intent.api
  provider.baseURL = intent.endpoint
  provider.models = intent.models.map((model) => ({ id: model.id }))
  return Buffer.from(emitYaml(after).join('\n') + '\n')
}

function serializeIntent (adapter, before, intent) {
  if (adapter.id === 'claude-code') return mergeClaude(before, intent)
  if (adapter.id === 'opencode') return mergeOpenCode(before, intent)
  return mergeDsh(before, intent)
}

function collectDiff (before, after, format) {
  const added = []
  const removed = []
  const changed = []
  const limit = 200
  function addTree (value, path) {
    if (added.length > limit) return
    if (isPlainObject(value) && Object.keys(value).length) {
      for (const key of Object.keys(value).sort()) addTree(value[key], path ? path + '.' + key : key)
    } else if (Array.isArray(value) && value.length) {
      value.forEach((item, index) => addTree(item, path + '[' + index + ']'))
    } else added.push(path || '$')
  }
  function removeTree (value, path) {
    if (removed.length > limit) return
    if (isPlainObject(value) && Object.keys(value).length) {
      for (const key of Object.keys(value).sort()) removeTree(value[key], path ? path + '.' + key : key)
    } else if (Array.isArray(value) && value.length) {
      value.forEach((item, index) => removeTree(item, path + '[' + index + ']'))
    } else removed.push(path || '$')
  }
  function visit (left, right, path) {
    if (added.length + removed.length + changed.length > limit) return
    if (isPlainObject(left) && isPlainObject(right)) {
      const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()
      for (const key of keys) {
        const next = path ? path + '.' + key : key
        if (!Object.hasOwn(left, key)) addTree(right[key], next)
        else if (!Object.hasOwn(right, key)) removeTree(left[key], next)
        else visit(left[key], right[key], next)
      }
      return
    }
    if (Array.isArray(left) && Array.isArray(right)) {
      const length = Math.max(left.length, right.length)
      for (let index = 0; index < length; index++) {
        const next = path + '[' + index + ']'
        if (index >= left.length) addTree(right[index], next)
        else if (index >= right.length) removeTree(left[index], next)
        else visit(left[index], right[index], next)
      }
      return
    }
    if (left !== right) changed.push(path || '$')
  }
  const parsed = before.exists
    ? (format === 'yaml-subset' ? (parseYamlSubset(before.bytes.toString('utf8')) ?? []) : parseJsonConfig(before.bytes))
    : (format === 'yaml-subset' ? [] : {})
  visit(parsed, after, '')
  return { redacted: true, valueDisclosure: false, added, removed, changed }
}

function normalizedNow (opts) {
  const now = Object.hasOwn(opts, 'now') ? opts.now : Date.now()
  if (!Number.isFinite(now) || !Number.isSafeInteger(Math.trunc(now))) throw fail('invalid_options', 'now 必须是有限整数时间戳')
  return Math.trunc(now)
}

function requestIdOf (opts) {
  if (!Object.hasOwn(opts, 'requestId')) return null
  if (typeof opts.requestId !== 'string' || !opts.requestId.trim() || opts.requestId.length > 100 || /[\u0000-\u001f\u007f]/.test(opts.requestId)) {
    throw fail('invalid_request_id', 'requestId 必须是 1–100 字符的安全标识')
  }
  return opts.requestId.trim()
}

function hashBefore (before) {
  return before.exists ? before.hash : null
}

function fileMetadata (exists, hash, size, mode) {
  return { exists, hash, bytes: exists ? size : 0, mode: exists ? mode : null }
}

export function previewHarnessConfig (opts = {}) {
  const allowed = adapterAllowedPreviewKeys(opts)
  const adapter = requireSupported(harnessFromOpts(opts))
  assertOptions(opts, allowed, 'previewHarnessConfig opts')
  const intent = normalizeIntent(adapter, opts)
  const context = managedContext(opts, adapter)
  const before = readManaged(context)
  const beforeFormat = adapter.format
  const afterBytes = serializeIntent(adapter, { ...before, format: beforeFormat }, intent)
  if (afterBytes.length > MAX_CONFIG_BYTES) throw fail('invalid_size', '生成的配置超过大小限制')
  const beforeHash = hashBefore(before)
  const afterHash = sha256(afterBytes)
  const expectedVersion = before.exists ? 1 : 0
  const confirmToken = randomBytes(32).toString('base64url')
  const previewId = 'prv_' + confirmToken
  const backupId = 'hbk_' + randomBytes(16).toString('base64url')
  const now = normalizedNow(opts)
  const ttlMs = Object.hasOwn(opts, 'ttlMs') ? opts.ttlMs : DEFAULT_TTL_MS
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 15 * 60 * 1000) throw fail('invalid_options', 'ttlMs 必须是 1–900000 的整数')
  const expiresAtMs = now + ttlMs
  const requestId = requestIdOf(opts)
  const planHash = sha256(JSON.stringify({
    contract: CONTRACT, harnessId: adapter.id, path: context.relativePath,
    beforeHash, afterHash, expectedVersion, backupId, intent,
  }))
  confirmations.set(confirmToken, {
    token: confirmToken, confirmToken, previewId, backupId, planHash, harnessId: adapter.id,
    path: context.relativePath, relativePath: context.relativePath, root: context.root,
    beforeHash, afterHash, expectedVersion, expiresAt: new Date(expiresAtMs).toISOString(),
    expiresAtMs, requestId, intent, afterBytes, used: false,
  })
  return {
    ok: true,
    contract: CONTRACT,
    harnessId: adapter.id,
    path: context.relativePath,
    format: adapter.format,
    previewId,
    confirmToken,
    planHash,
    backupId,
    expectedVersion,
    expiresAt: new Date(expiresAtMs).toISOString(),
    requestId,
    before: fileMetadata(before.exists, before.hash, before.size, before.mode),
    after: fileMetadata(true, afterHash, afterBytes.length, 0o600),
    beforeHash,
    afterHash,
    diff: collectDiff(before, adapter.format === 'yaml-subset' ? parseYamlSubset(afterBytes.toString('utf8')) : parseJsonConfig(afterBytes), beforeFormat),
    capability: 'fixture-verified',
    realProtocol: 'not-real-tested',
    writesEnabled: true,
  }
}

function harnessFromOpts (opts) {
  if (!isPlainObject(opts)) throw fail('invalid_options', 'opts 必须是普通对象')
  const value = selectedAlias(opts, 'harnessId', 'harness')
  if (value === undefined) throw fail('invalid_options', 'harnessId 必填')
  return adapterByKey(value)
}

function adapterAllowedPreviewKeys (opts) {
  const adapter = harnessFromOpts(opts)
  const allowed = new Set(COMMON_PREVIEW_KEYS)
  if (adapter.id === 'opencode') {
    for (const key of PREVIEW_KEYS) allowed.add(key)
    for (const key of ['model', 'providerPackage', 'protocol']) allowed.add(key)
  } else if (adapter.id === 'dsh') {
    for (const key of ['models', 'model', 'api', 'protocol']) allowed.add(key)
  }
  return allowed
}

function sameJson (left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function assertApplyIntent (opts, plan) {
  const adapter = adapterByKey(plan.harnessId)
  if (Object.hasOwn(opts, 'endpoint') || Object.hasOwn(opts, 'baseUrl')) {
    if (normalizeEndpoint(selectedAlias(opts, 'endpoint', 'baseUrl')) !== plan.intent.endpoint) throw fail('preview_binding_mismatch', 'apply endpoint 与预览不一致', 409)
  }
  if (Object.hasOwn(opts, 'apiKeyEnv') || Object.hasOwn(opts, 'env')) {
    if (normalizeEnvName(selectedAlias(opts, 'apiKeyEnv', 'env'), adapter.defaultApiKeyEnv) !== plan.intent.apiKeyEnv) throw fail('preview_binding_mismatch', 'apply apiKeyEnv 与预览不一致', 409)
  }
  if (Object.hasOwn(opts, 'providerId') && normalizeProviderId(opts.providerId) !== plan.intent.providerId) {
    throw fail('preview_binding_mismatch', 'apply providerId 与预览不一致', 409)
  }
  if (Object.hasOwn(opts, 'models') || Object.hasOwn(opts, 'model')) {
    const models = normalizeModels(Object.hasOwn(opts, 'models') ? opts.models : opts.model)
    if (!sameJson(models, plan.intent.models)) throw fail('preview_binding_mismatch', 'apply models 与预览不一致', 409)
  }
  if (adapter.id === 'opencode' && (Object.hasOwn(opts, 'package') || Object.hasOwn(opts, 'providerPackage') || Object.hasOwn(opts, 'protocol') || Object.hasOwn(opts, 'api'))) {
    const selected = normalizeOpenCodePackage(selectedAlias(opts, 'package', 'providerPackage') ?? opts.protocol ?? opts.api)
    if (selected.package !== plan.intent.package) throw fail('preview_binding_mismatch', 'apply package 与预览不一致', 409)
  }
  if (adapter.id === 'dsh' && (Object.hasOwn(opts, 'api') || Object.hasOwn(opts, 'protocol'))) {
    if (normalizeDshApi(opts.api ?? opts.protocol) !== plan.intent.api) throw fail('preview_binding_mismatch', 'apply api 与预览不一致', 409)
  }
}

function assertReceiptBinding (receipt, plan) {
  if (!isPlainObject(receipt)) throw fail('preview_binding_mismatch', 'preview 必须是预览回执对象', 409)
  const fields = ['previewId', 'confirmToken', 'planHash', 'backupId', 'harnessId', 'path', 'expectedVersion', 'beforeHash', 'afterHash', 'expiresAt']
  for (const field of fields) {
    if (Object.hasOwn(receipt, field) && receipt[field] !== plan[field]) {
      throw fail('preview_binding_mismatch', 'preview 字段 ' + field + ' 与确认令牌绑定不一致', 409)
    }
  }
}

function storeDirectory (root, { create = false } = {}) {
  const directory = join(root, STORE_DIR)
  assertNoSymlinkComponents(root, directory, { directory: true })
  if (create) mkdirSync(directory, { recursive: true, mode: 0o700 })
  assertNoSymlinkComponents(root, directory, { directory: true })
  let stat
  try { stat = lstatSync(directory) } catch {
    if (create) throw fail('store_unavailable', '无法创建 Harness 备份目录', 500)
    throw fail('backup_not_found', 'backupId 不存在', 404)
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw fail('symlink_refused', 'Harness 备份目录不是普通目录', 403)
  return directory
}

function writeExclusive (path, bytes, root) {
  let fd = null
  let created = false
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600)
    created = true
    fchmodSync(fd, 0o600)
    writeAll(fd, bytes)
    fsyncSync(fd)
    closeSync(fd)
    fd = null
  } catch (error) {
    if (fd !== null) try { closeSync(fd) } catch {}
    if (created) try { unlinkSync(path) } catch {}
    if (error && error.code === 'EEXIST') throw fail('store_conflict', 'backupId 已存在', 409)
    throw error
  }
}

function createBackup (plan, before, createdAt) {
  const directory = storeDirectory(plan.root, { create: true })
  const rawPath = join(directory, plan.backupId + '.bin')
  const metadataPath = join(directory, plan.backupId + '.json')
  const raw = before.exists ? before.bytes : Buffer.alloc(0)
  writeExclusive(rawPath, raw, plan.root)
  const metadata = {
    schema: 'modelgate-harness-backup', version: 1, backupId: plan.backupId,
    harnessId: plan.harnessId, relativePath: plan.relativePath, existed: before.exists,
    beforeHash: plan.beforeHash, afterHash: plan.afterHash, beforeBytes: raw.length,
    afterBytes: plan.afterBytes.length, expectedVersion: plan.expectedVersion,
    planHash: plan.planHash, createdAt,
  }
  try {
    writeExclusive(metadataPath, Buffer.from(JSON.stringify(metadata, null, 2) + '\n'), plan.root)
  } catch (error) {
    try { unlinkSync(rawPath) } catch {}
    throw error
  }
  fsyncDirectory(directory)
}

function readBackupMetadata (root, backupId) {
  const directory = storeDirectory(root)
  const metadataPath = join(directory, backupId + '.json')
  const rawPath = join(directory, backupId + '.bin')
  const file = readRegularFile(metadataPath, MAX_STORE_METADATA_BYTES, root)
  let metadata
  try { metadata = JSON.parse(file.bytes.toString('utf8')) } catch { throw fail('invalid_backup', 'backup 元数据损坏') }
  const allowed = new Set([
    'schema', 'version', 'backupId', 'harnessId', 'relativePath', 'existed',
    'beforeHash', 'afterHash', 'beforeBytes', 'afterBytes', 'expectedVersion', 'planHash', 'createdAt',
  ])
  assertOptions(metadata, allowed, 'backup metadata')
  if (metadata.schema !== 'modelgate-harness-backup' || metadata.version !== 1 || metadata.backupId !== backupId ||
      typeof metadata.relativePath !== 'string' || typeof metadata.existed !== 'boolean' ||
      !Number.isSafeInteger(metadata.beforeBytes) || metadata.beforeBytes < 0 || metadata.beforeBytes > MAX_CONFIG_BYTES ||
      !Number.isSafeInteger(metadata.afterBytes) || metadata.afterBytes < 0 || metadata.afterBytes > MAX_CONFIG_BYTES ||
      !Number.isSafeInteger(metadata.expectedVersion) || metadata.expectedVersion < 0 ||
      !(metadata.existed ? typeof metadata.beforeHash === 'string' && /^[a-f0-9]{64}$/.test(metadata.beforeHash) : metadata.beforeHash === null) ||
      typeof metadata.afterHash !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.afterHash) ||
      typeof metadata.planHash !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.planHash) ||
      typeof metadata.createdAt !== 'string') {
    throw fail('invalid_backup', 'backup 元数据契约无效')
  }
  const adapter = requireSupported(adapterByKey(metadata.harnessId))
  const context = contextFor(root, adapter, metadata.relativePath)
  const raw = readRegularFile(rawPath, MAX_CONFIG_BYTES, root)
  if (raw.size !== metadata.beforeBytes || (metadata.existed ? raw.hash !== metadata.beforeHash : raw.size !== 0)) {
    throw fail('invalid_backup', 'backup 原字节校验失败')
  }
  return { metadata, context, bytes: raw.bytes }
}

export function applyHarnessConfig (opts = {}) {
  assertOptions(opts, APPLY_KEYS, 'applyHarnessConfig opts')
  const root = resolveManagedRoot(opts)
  const token = opts.confirmToken ?? opts.preview?.confirmToken
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) throw fail('preview_required', 'confirmToken 必填', 428)
  const plan = confirmations.get(token)
  if (!plan) throw fail('preview_not_found', 'confirmToken 不存在或已失效', 428)
  if (plan.used) throw fail('confirm_token_used', 'confirmToken 只能使用一次', 409)
  if (plan.root !== root) throw fail('preview_binding_mismatch', 'confirmToken 与 managedRoot 不匹配', 409)
  if (Object.hasOwn(opts, 'preview')) assertReceiptBinding(opts.preview, plan)
  if (Object.hasOwn(opts, 'harnessId') || Object.hasOwn(opts, 'harness')) {
    if (adapterByKey(selectedAlias(opts, 'harnessId', 'harness')).id !== plan.harnessId) throw fail('preview_binding_mismatch', 'apply Harness 与预览不一致', 409)
  }
  const bindings = {
    previewId: 'previewId', planHash: 'planHash', backupId: 'backupId', expectedVersion: 'expectedVersion',
    beforeHash: 'beforeHash', afterHash: 'afterHash', expiresAt: 'expiresAt',
  }
  for (const [option, field] of Object.entries(bindings)) {
    if (Object.hasOwn(opts, option) && opts[option] !== plan[field]) {
      throw fail('preview_binding_mismatch', 'apply ' + option + ' 与预览绑定不一致', 409)
    }
  }
  if (Object.hasOwn(opts, 'requestId')) {
    const requestId = opts.requestId === null ? null : requestIdOf(opts)
    if (requestId !== plan.requestId) throw fail('preview_binding_mismatch', 'apply requestId 与预览不一致', 409)
  }
  const now = normalizedNow(opts)
  if (now >= plan.expiresAtMs) throw fail('preview_expired', '预览已过期，请重新预览', 428)
  assertApplyIntent(opts, plan)
  const adapter = requireSupported(adapterByKey(plan.harnessId))
  const context = contextFor(root, adapter, Object.hasOwn(opts, 'path') ? opts.path : plan.relativePath)
  if (context.relativePath !== plan.relativePath) throw fail('preview_binding_mismatch', 'apply path 与预览不一致', 409)
  plan.used = true
  const before = readManaged(context)
  if (hashBefore(before) !== plan.beforeHash) throw fail('config_conflict', '配置在预览后已变化，请重新预览', 409, { currentHash: hashBefore(before) })
  const createdAt = new Date(now).toISOString()
  createBackup(plan, before, createdAt)
  try {
    atomicWrite(context, plan.afterBytes)
    const written = readManaged(context)
    if (written.hash !== plan.afterHash || written.mode !== 0o600) throw fail('transaction_failed', '写入后校验失败', 500)
  } catch (error) {
    try {
      if (before.exists) atomicWrite(context, before.bytes)
      else {
        assertNoSymlinkComponents(root, context.target)
        unlinkSync(context.target)
      }
    } catch {}
    if (error && error.code) throw error
    throw fail('transaction_failed', 'Harness 配置写入失败', 500)
  }
  return {
    ok: true,
    contract: CONTRACT,
    harnessId: plan.harnessId,
    path: plan.relativePath,
    previewId: plan.previewId,
    backupId: plan.backupId,
    expectedVersion: plan.expectedVersion + 1,
    beforeHash: plan.beforeHash,
    afterHash: plan.afterHash,
    appliedAt: createdAt,
    needsRestart: true,
    capability: 'fixture-verified',
    realProtocol: 'not-real-tested',
  }
}

export function rollbackHarnessConfig (opts = {}) {
  assertOptions(opts, new Set(['managedRoot', 'backupId', 'path', 'harnessId', 'harness', 'now']), 'rollbackHarnessConfig opts')
  const root = resolveManagedRoot(opts)
  if (typeof opts.backupId !== 'string' || !BACKUP_ID_RE.test(opts.backupId)) throw fail('invalid_backup_id', 'backupId 必须是模块返回的不透明标识')
  const { metadata, context, bytes } = readBackupMetadata(root, opts.backupId)
  if (Object.hasOwn(opts, 'path') && resolve(root, opts.path) !== context.target) throw fail('preview_binding_mismatch', 'rollback path 与 backupId 不匹配', 409)
  if (Object.hasOwn(opts, 'harnessId') || Object.hasOwn(opts, 'harness')) {
    if (adapterByKey(selectedAlias(opts, 'harnessId', 'harness')).id !== metadata.harnessId) throw fail('preview_binding_mismatch', 'rollback Harness 与 backupId 不匹配', 409)
  }
  const now = normalizedNow(opts)
  const current = readManaged(context)
  const currentHash = hashBefore(current)
  if (current.exists === metadata.existed && currentHash === metadata.beforeHash) {
    if (current.exists) {
      assertNoSymlinkComponents(root, context.target)
      chmodSync(context.target, 0o600)
    }
    return {
      ok: true, contract: CONTRACT, restored: true, alreadyRestored: true,
      backupId: opts.backupId, harnessId: metadata.harnessId, path: metadata.relativePath,
      hash: metadata.beforeHash, rolledBackAt: new Date(now).toISOString(), needsRestart: true,
      capability: 'fixture-verified', realProtocol: 'not-real-tested',
    }
  }
  if (current.exists !== true || currentHash !== metadata.afterHash) {
    throw fail('rollback_conflict', '配置已被第三方修改，拒绝覆盖；当前 hash 与 applied hash 不一致', 409, { currentHash })
  }
  if (metadata.existed) atomicWrite(context, bytes)
  else {
    assertNoSymlinkComponents(root, context.target)
    unlinkSync(context.target)
    fsyncDirectory(dirname(context.target))
  }
  return {
    ok: true,
    contract: CONTRACT,
    restored: true,
    alreadyRestored: false,
    backupId: opts.backupId,
    harnessId: metadata.harnessId,
    path: metadata.relativePath,
    hash: metadata.beforeHash,
    expectedVersion: metadata.expectedVersion,
    rolledBackAt: new Date(now).toISOString(),
    needsRestart: true,
    capability: 'fixture-verified',
    realProtocol: 'not-real-tested',
  }
}
