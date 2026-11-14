// A2 / P01：聚合 Provider 注册表。
//
// 边界（ADR-0003 §2 / §6）：
//   - Provider 记录**只**持久化在既有 gateway 配置里（`gateway.local.json` 的 providers 映射），
//     复用 `src/config-transaction.js` 的目录级写锁 + 磁盘指纹 + 原子 rename 事务；
//     不新建第二配置库、第二把锁或第二套版本号。
//   - 每次写入推进既有 `configVersion`：调用方带 `version` 且过期即 409（`version_conflict`
//     并回传 `currentVersion`），与 `src/index.js` 的保存路径同语义。
//   - 记录里**绝不**保存明文 Key：只接受 `apiKeyEnv`（变量名）或 `keyRef`（`provider-key` /
//     `env:<NAME>` / `none`）。内联 `apiKey`/`token`/`secret` 一律拒绝。
//   - kind 段固定：`opencode-go` → provider 段 `opencodego`（已发布 `mg-opencodego-*` 字节兼容），
//     `opencode-console` → `console`。`chatgpt-plan` 由别处管理，这里只保留枚举位，不接管。
//
// 导出签名是冻结契约：`listProviders()`、`getProvider(id)`、`addProvider(cfg)`、`removeProvider(id)`。
// 为了让这些零参/单参函数有可注入的存储，模块提供 `configureRegistry()` 绑定默认实例，
// 同时导出 `createRegistry()` 供测试使用隔离目录。

import { beginWrite, fingerprint, TARGET_CONFIG } from '../config-transaction.js'
import { configPaths, loadConfig, readLocalConfigStrict, INLINE_CREDENTIAL_FIELDS } from '../router.js'
import { isOpencodeGoHost } from '../codex/identity.js'

export const REGISTRY_SCHEMA = 'modelgate.aggregation.provider/1'
export const PROVIDER_KINDS = Object.freeze(['opencode-go', 'opencode-console', 'chatgpt-plan'])
export const MANAGED_KINDS = Object.freeze(['opencode-go', 'opencode-console'])

// kind → 公共模型 ID 的 provider 段。`go` 必须是 `opencodego`（已发布 ID 不可改），
// console 用 `console`（ADR §3）。只在这里映射，绝不另写 ID 生成器。
export const PROVIDER_SEGMENTS = Object.freeze({
  'opencode-go': 'opencodego',
  'opencode-console': 'console',
})

const PROVIDER_RUNTIME_FIELDS = Object.freeze(['hasKey', 'keySource', 'keyOk', 'st', 'probe'])
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const ID_RE = /^[a-z][a-z0-9_-]{0,63}$/
// 内联凭据字段清单与 router 共用一份：注册表拒绝接受，启动诊断对已持久化的配置告警。
const SECRET_FIELDS = INLINE_CREDENTIAL_FIELDS

export class RegistryError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'RegistryError'
    this.code = code
    this.details = details
  }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const lower = (v) => String(v == null ? '' : v).trim().toLowerCase()

function reject(code, message, details) {
  throw new RegistryError(code, message, details)
}

// 删除运行时统计字段：local 只保存配置，不回写 hasKey/probe/st 等内存投影。
function stripRuntimeProvider(p) {
  const out = {}
  for (const [k, v] of Object.entries(p || {})) if (!PROVIDER_RUNTIME_FIELDS.includes(k)) out[k] = v
  return out
}

function validateBaseUrl(baseUrl, cfg) {
  let parsed
  try {
    parsed = new URL(String(baseUrl))
  } catch {
    reject('provider_base_url_invalid', 'provider.baseUrl 不是合法 URL：' + String(baseUrl))
  }
  const host = parsed.hostname.toLowerCase()
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
  if (parsed.protocol !== 'https:' && !(loopback && parsed.protocol === 'http:')) {
    reject('provider_base_url_insecure', 'provider.baseUrl 必须是 https（回环可用 http）：' + String(baseUrl))
  }
  if (!isOpencodeGoHost(host, cfg) && !loopback) {
    reject('provider_host_not_allowlisted', 'provider.baseUrl host 不在 OpenCode 白名单：' + host)
  }
  return { host, loopback }
}

function validateModelListUrl(raw, cfg) {
  if (raw === undefined || raw === null || raw === '') return null
  let parsed
  try {
    parsed = new URL(String(raw))
  } catch {
    reject('provider_model_list_url_invalid', 'aggregation.modelListUrl 不是合法 URL')
  }
  const host = parsed.hostname.toLowerCase()
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
  if (parsed.username || parsed.password) {
    reject('provider_model_list_url_credential', 'aggregation.modelListUrl 不得内嵌凭据')
  }
  if (parsed.protocol !== 'https:' && !(loopback && parsed.protocol === 'http:')) {
    reject('provider_model_list_url_insecure', 'aggregation.modelListUrl 必须是 https（回环可用 http）')
  }
  if (!isOpencodeGoHost(host, cfg) && !loopback) {
    reject('provider_host_not_allowlisted', 'aggregation.modelListUrl host 不在 OpenCode 白名单：' + host)
  }
  return String(raw)
}

// 输入规范化：返回可直接写进 providers 映射的条目（含 aggregation 元数据）。
// cfg 只用于白名单判定，不读 Key 值。
export function normalizeProviderConfig(input, cfg = {}) {
  if (!isPlainObject(input)) reject('provider_invalid', 'addProvider 需要一个 provider 配置对象')
  for (const field of Object.keys(input)) {
    if (SECRET_FIELDS.includes(field) && input[field] != null && input[field] !== '') {
      // 接受一个自己不会读取的字段 = 静默失败（上游会以未鉴权发送）。这里直接拒绝，
      // 并把两条受支持的通路写清楚：keys.local.json，或 apiKeyEnv 指向的环境变量名。
      reject('provider_key_inline_forbidden',
        '拒绝内联凭据字段 `' + field + '`：该值不会被读取，也不允许写入配置/目录/日志。'
        + '请改用 ① keys.local.json（config/keys.local.json，经面板/CLI 写入）或 ② provider.apiKeyEnv 指定环境变量名')
    }
  }
  const kind = lower(input.kind)
  if (!PROVIDER_KINDS.includes(kind)) {
    reject('provider_kind_unknown', 'provider.kind 只能是 ' + PROVIDER_KINDS.join(' / ') + '：' + String(input.kind))
  }
  if (!MANAGED_KINDS.includes(kind)) {
    reject('provider_kind_managed_elsewhere', 'provider.kind=' + kind + ' 由其他代理管理，聚合发现不接管')
  }
  const segment = PROVIDER_SEGMENTS[kind]
  const id = input.id === undefined || input.id === null || input.id === '' ? segment : String(input.id).trim()
  if (!ID_RE.test(id)) reject('provider_id_invalid', 'provider.id 必须匹配 ^[a-z][a-z0-9_-]{0,63}$：' + id)
  if (id !== segment) {
    reject('provider_id_kind_mismatch',
      'provider.id 必须等于 kind 对应的固定段 ' + segment + '（已发布公共 ID 不可重编号），收到 ' + id)
  }
  const baseUrl = String(input.baseUrl == null ? '' : input.baseUrl).trim()
  if (!baseUrl) reject('provider_base_url_missing', 'provider.baseUrl 缺失')
  const { host } = validateBaseUrl(baseUrl, cfg)
  const api = input.api == null || input.api === '' ? 'openai' : String(input.api)
  if (api !== 'openai' && api !== 'responses') {
    reject('provider_api_unsupported', 'provider.api 只能是 openai/responses：' + api)
  }
  if (input.pathPrefix != null && typeof input.pathPrefix !== 'string') {
    reject('provider_path_prefix_invalid', 'provider.pathPrefix 必须是字符串')
  }
  let apiKeyEnv = null
  if (input.apiKeyEnv != null && input.apiKeyEnv !== '') {
    const name = String(input.apiKeyEnv).trim()
    if (!ENV_NAME_RE.test(name)) reject('provider_api_key_env_invalid', 'apiKeyEnv 必须是合法环境变量名（不读值）：' + name)
    apiKeyEnv = name
  }
  let keyRef = input.keyRef == null || input.keyRef === '' ? null : String(input.keyRef).trim()
  if (keyRef != null) {
    const ok = keyRef === 'provider-key' || keyRef === 'none' ||
      (/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(keyRef))
    if (!ok) reject('provider_key_ref_invalid', 'keyRef 只能是 provider-key / none / env:<NAME>：' + keyRef)
  }
  if (!keyRef) keyRef = apiKeyEnv ? 'env:' + apiKeyEnv : 'provider-key'
  const modelListUrl = validateModelListUrl(input.modelListUrl, cfg)
  const pagination = normalizePagination(input.pagination)
  return {
    baseUrl,
    api,
    ...(input.pathPrefix ? { pathPrefix: String(input.pathPrefix) } : {}),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    aggregation: {
      schema: REGISTRY_SCHEMA,
      kind,
      id,
      providerSegment: segment,
      name: input.name == null || input.name === '' ? defaultName(kind) : String(input.name).trim(),
      keyRef,
      modelListUrl,
      pagination,
      enabled: input.enabled !== false,
      host,
    },
  }
}

function defaultName(kind) {
  return kind === 'opencode-go' ? 'OpenCode Go' : 'OpenCode Console'
}

function normalizePagination(raw) {
  if (raw === undefined || raw === null) return { style: 'auto' }
  if (!isPlainObject(raw)) reject('provider_pagination_invalid', 'provider.pagination 必须是对象')
  const style = lower(raw.style || 'auto')
  if (!['auto', 'cursor', 'page', 'none'].includes(style)) {
    reject('provider_pagination_invalid', 'provider.pagination.style 只能是 auto/cursor/page/none：' + String(raw.style))
  }
  const out = { style }
  for (const [key, max] of [['pageSize', 1000], ['maxPages', 100]]) {
    if (raw[key] !== undefined) {
      if (!Number.isInteger(raw[key]) || raw[key] < 1 || raw[key] > max) {
        reject('provider_pagination_invalid', 'provider.pagination.' + key + ' 必须是 1..' + max + ' 的整数')
      }
      out[key] = raw[key]
    }
  }
  for (const key of ['cursorParam', 'pageParam', 'sizeParam']) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== 'string' || !ENV_NAME_RE.test(raw[key])) {
        reject('provider_pagination_invalid', 'provider.pagination.' + key + ' 必须是合法参数名')
      }
      out[key] = raw[key]
    }
  }
  return out
}

// provider 映射条目 → 聚合记录（对外只读形态）。
export function recordOf(id, entry) {
  const agg = entry && isPlainObject(entry.aggregation) ? entry.aggregation : null
  if (!agg || agg.schema !== REGISTRY_SCHEMA) return null
  return Object.freeze({
    id: String(agg.id || id),
    kind: agg.kind,
    providerSegment: agg.providerSegment || PROVIDER_SEGMENTS[agg.kind],
    name: agg.name || defaultName(agg.kind),
    baseUrl: entry.baseUrl,
    api: entry.api || 'openai',
    pathPrefix: entry.pathPrefix || '',
    apiKeyEnv: entry.apiKeyEnv || null,
    keyRef: agg.keyRef || (entry.apiKeyEnv ? 'env:' + entry.apiKeyEnv : 'provider-key'),
    modelListUrl: agg.modelListUrl || null,
    pagination: agg.pagination || { style: 'auto' },
    enabled: agg.enabled !== false,
    host: agg.host || null,
    addedAt: agg.addedAt || null,
    updatedAt: agg.updatedAt || null,
    configured: true,
  })
}

export function createRegistry(options = {}) {
  const paths = options.paths || configPaths()
  const readConfig = () => (typeof options.readConfig === 'function' ? options.readConfig() : loadConfig())
  const reload = typeof options.reload === 'function' ? options.reload : () => {}
  const log = options.log || null

  function currentConfig() {
    try {
      return readConfig()
    } catch (error) {
      reject('registry_config_unreadable', '无法读取网关配置，注册表拒绝写入：' + ((error && error.message) || 'unknown'))
    }
  }

  function listProviders() {
    const cfg = currentConfig()
    const out = []
    for (const [id, entry] of Object.entries((cfg && cfg.providers) || {})) {
      const rec = recordOf(id, entry)
      if (rec) out.push(rec)
    }
    return out.sort((a, b) => a.id.localeCompare(b.id))
  }

  function getProvider(id) {
    const key = String(id == null ? '' : id).trim()
    if (!key) return null
    const cfg = currentConfig()
    const entry = cfg && cfg.providers && cfg.providers[key]
    return entry ? recordOf(key, entry) : null
  }

  // 单写事务：读配置 → 版本 CAS 预检 → 变更 providers → 原子提交 TARGET_CONFIG。
  function commitProviders(mutate, expectedVersion) {
    const cfg = currentConfig()
    const version = Number(cfg.configVersion) || 0
    if (expectedVersion !== undefined && expectedVersion !== null && Number(expectedVersion) !== version) {
      reject('version_conflict', '配置版本冲突：期望 ' + expectedVersion + '，当前 ' + version, { currentVersion: version })
    }
    const local = readLocalConfigStrict(paths.local, {}) || {}
    const providers = {}
    for (const [id, entry] of Object.entries(cfg.providers || {})) providers[id] = stripRuntimeProvider(entry)
    const removed = new Set(Array.isArray(local._removed && local._removed.providers) ? local._removed.providers : [])
    const result = mutate({ providers, removed, cfg })
    const nextVersion = version + 1
    const localOut = Object.assign({}, local, {
      configVersion: nextVersion,
      providers,
    })
    if (removed.size) {
      localOut._removed = Object.assign({}, local._removed || {}, { providers: [...removed].sort() })
    } else if (localOut._removed) {
      const rest = Object.assign({}, localOut._removed)
      delete rest.providers
      if (Object.keys(rest).length) localOut._removed = rest
      else delete localOut._removed
    }
    // 优先用 loadConfig 产出的磁盘指纹（读盘与指纹同代）；注入式测试则现场取指纹。
    const expected = cfg._disk || fingerprint(paths)
    let tx
    try {
      tx = beginWrite(paths, { expected, log })
    } catch (error) {
      throw registryTransactionError(error)
    }
    try {
      tx.commit({
        files: { [TARGET_CONFIG]: JSON.stringify(localOut, null, 2) },
        operation: 'aggregation.provider.save',
        publish: reload,
      })
    } catch (error) {
      throw registryTransactionError(error)
    } finally {
      tx.release()
    }
    return { version: nextVersion, result }
  }

  function addProvider(input) {
    const cfg = currentConfig()
    const normalized = normalizeProviderConfig(input, cfg)
    const expectedVersion = input && input.version !== undefined ? input.version : options.expectedVersion
    const id = normalized.aggregation.id
    if (cfg.providers && cfg.providers[id] && recordOf(id, cfg.providers[id])) {
      reject('provider_exists', '聚合 Provider 已存在：' + id)
    }
    if (cfg.providers && cfg.providers[id] && !recordOf(id, cfg.providers[id])) {
      reject('provider_id_in_use', 'provider id 已被非聚合上游占用：' + id)
    }
    const sameKind = listProviders().find((p) => p.kind === normalized.aggregation.kind && p.id !== id)
    if (sameKind) {
      reject('provider_kind_already_configured',
        '已存在同 kind 的聚合 Provider（' + sameKind.id + '）；公共 ID 段 ' + normalized.aggregation.providerSegment + ' 只允许一个来源',
        { existing: sameKind.id })
    }
    const now = new Date().toISOString()
    const entry = Object.assign({}, normalized, {
      aggregation: Object.assign({}, normalized.aggregation, { addedAt: now, updatedAt: now }),
    })
    const { version } = commitProviders(({ providers, removed }) => {
      providers[id] = entry
      removed.delete(id)
      return entry
    }, expectedVersion)
    return Object.assign({}, recordOf(id, entry), { version })
  }

  function removeProvider(id) {
    const key = String(id == null ? '' : id).trim()
    const cfg = currentConfig()
    const entry = cfg.providers && cfg.providers[key]
    const rec = entry ? recordOf(key, entry) : null
    if (!rec) {
      reject('provider_not_found', '聚合适配 Provider 不存在：' + key)
    }
    const { version } = commitProviders(({ providers, removed }) => {
      delete providers[key]
      removed.add(key)
      return { removed: key }
    }, options.expectedVersion)
    return { removed: true, id: key, version }
  }

  return Object.freeze({ listProviders, getProvider, addProvider, removeProvider, paths })
}

function registryTransactionError(error) {
  if (error instanceof RegistryError) return error
  const code = (error && error.code) || 'registry_transaction_failed'
  if (code === 'store_locked') return new RegistryError('registry_locked', '配置正被另一个写者持有锁', { cause: code })
  if (code === 'store_conflict') return new RegistryError('version_conflict', '配置磁盘指纹与读取时不一致，拒绝覆盖', { cause: code })
  return new RegistryError(code, '配置事务失败：' + ((error && error.message) || 'unknown'))
}

let _defaultRegistry = null

export function configureRegistry(options = {}) {
  _defaultRegistry = createRegistry(options)
  return _defaultRegistry
}

export function getRegistry() {
  return _defaultRegistry
}

function requireRegistry() {
  if (!_defaultRegistry) {
    reject('registry_not_configured', '聚合注册表未配置：主代理需先 configureRegistry({ paths, readConfig, reload })')
  }
  return _defaultRegistry
}

// —— 冻结签名（ADR §2）：模块级默认实例 ——
export function listProviders() { return requireRegistry().listProviders() }
export function getProvider(id) { return requireRegistry().getProvider(id) }
export function addProvider(cfg) { return requireRegistry().addProvider(cfg) }
export function removeProvider(id) { return requireRegistry().removeProvider(id) }
