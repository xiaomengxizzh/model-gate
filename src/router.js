import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, chmodSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { isAggregateModelId, aggregatePrefixes } from './codex/identity.js'

export function configPaths() {
  // MG_CONFIG_DIR：可选。多实例隔离时为实例指定独立配置目录（keys/stats 随之独立）；未设置=cwd/config（单实例零配置）
  const envDir = (process.env.MG_CONFIG_DIR || '').trim()
  const dir = envDir || join(process.cwd(), 'config')
  return { dir, local: join(dir, 'gateway.local.json'), keys: join(dir, 'keys.local.json'), stats: join(dir, 'stats.json'), videos: join(dir, 'videos.json') }
}

export function readJson(path, dflt = {}) {
  try { return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) } catch { return dflt }
}

// F02：配置目标（gateway.local.json / keys.local.json）**损坏时必须 fail-closed**。
// 旧行为是「解析失败 → 返回 {}」：那等于静默降级（鉴权丢失），更糟的是下一次保存会基于 {}
// 写回，把用户余下的上游/模型/Key 全部写没。这里把「不存在」与「存在但不可解析」分开：
//   · ENOENT → 缺省值（首次运行）
//   · 存在但不可解析 → 抛 ConfigUnreadable（带稳定 code），由调用方拒绝启动/拒绝变更
export class ConfigUnreadable extends Error {
  constructor (code, message, details) {
    super(message)
    this.name = 'ConfigUnreadable'
    this.code = code
    if (details) this.details = details
  }
}

export function isConfigUnreadable (error) {
  return !!(error && error.name === 'ConfigUnreadable' && typeof error.code === 'string')
}

function unreadableJson (code, path, what) {
  return new ConfigUnreadable(code, what + ' 不可解析（可能被截断/外部改坏）：已拒绝加载/写入以免清空现有配置与 Key；请从备份恢复或人工修复后重试（文件保持原样：' + path + '）', { path })
}

// 严格读取 gateway.local.json：供 loadConfig 与保存路径的「读盘合并」共用同一语义。
export function readLocalConfigStrict (path, dflt = {}) {
  let text
  try { text = readFileSync(path, 'utf8') } catch (error) {
    if (error && error.code === 'ENOENT') return dflt
    throw error
  }
  let parsed
  try { parsed = JSON.parse(text.replace(/^\uFEFF/, '')) } catch { throw unreadableJson('local_config_unreadable', path, 'gateway.local.json') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw unreadableJson('local_config_unreadable', path, 'gateway.local.json（顶层必须是对象）')
  return parsed
}

// 原子写：先写临时再 rename（避免半截文件）
export function writeJsonAtomic(path, obj) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + '.' + process.pid + '.tmp'
  writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
  renameSync(tmp, path)
}

// 配置加载：gateway.json 为准 + gateway.local.json 覆盖；并读取面板写入的 keys.local.json
// virtualModels 规范化（loadConfig 容错路径）：非法项跳过并警告，不让手改坏配置宕机；面板保存路径另有强校验
function normalizeVirtualModels(vms, base) {
  const out = []
  const models = base.models || {}
  const taken = new Set(Object.keys(models))
  for (const m of Object.values(models)) for (const a of m.alias || []) taken.add(a)
  if (base.defaults && base.defaults.model) taken.add(base.defaults.model)
  for (const vm of Array.isArray(vms) ? vms : []) {
    const name = vm && typeof vm.name === 'string' ? vm.name.trim() : ''
    if (!name) { console.warn('[virtualModels] 跳过：缺少 name'); continue }
    if (taken.has(name)) { console.warn('[virtualModels] 跳过：名字与真实模型/别名/默认虚拟名冲突: ' + name); continue }
    const dir = (Array.isArray(vm.directory) ? vm.directory : []).filter(e => e && typeof e.model === 'string' && models[e.model])
    if (!dir.length) { console.warn('[virtualModels] 跳过：目录为空或引用不存在的模型: ' + name); continue }
    out.push({
      name,
      directory: dir.map(e => ({ model: e.model, mode: e.mode === 'onFail' ? 'onFail' : 'afterAll', providers: Array.isArray(e.providers) ? e.providers.filter(Boolean) : [] })),
      quota: Number(vm.quota) || 0, dailyQuota: Number(vm.dailyQuota) || 0, maxContext: Number(vm.maxContext) || 0,
      maxConcurrent: Number(vm.maxConcurrent) || 0, qps: Number(vm.qps) || 0,
    })
  }
  return out
}

// ===== Codex 目录（E2×E3）：官方 slug 与聚合 slug =====
// index.js 在加载/重载配置时把 E2 生成的目录视图注入 cfg._codexCatalog：
//   { officialSlugs: string[], bindings: { [slug]: { slug, provider, model, capability } }, models: ModelInfo[] }
// 本模块**只消费内存视图**：不读文件、不生成目录、不校验 ModelInfo（那是 src/codex/catalog.js 的职责）。
// 目录缺失/为 null 时，下面所有分支都不生效 → 与 E1 的语义逐字节一致。
function codexCatalogOf(cfg) {
  const cat = cfg && cfg._codexCatalog
  return (cat && typeof cat === 'object') ? cat : null
}
export function codexCatalogBindings(cfg) {
  const cat = codexCatalogOf(cfg)
  const b = cat && cat.bindings
  return (b && typeof b === 'object') ? b : {}
}
// 单个聚合 slug 的绑定；非法条目返回 null（由 resolve 负责 fail-closed）。
export function codexBindingFor(cfg, model) {
  if (typeof model !== 'string' || !model) return null
  const b = codexCatalogBindings(cfg)[model]
  if (!b || typeof b !== 'object' || !b.provider) return null
  return {
    slug: typeof b.slug === 'string' && b.slug ? b.slug : model,
    provider: String(b.provider),
    model: typeof b.model === 'string' && b.model ? b.model : model,
    capability: typeof b.capability === 'string' && b.capability ? b.capability : 'chat',
  }
}
export function codexOfficialSlugSet(cfg) {
  const cat = codexCatalogOf(cfg)
  const list = cat && Array.isArray(cat.officialSlugs) ? cat.officialSlugs : []
  return new Set(list.filter((s) => typeof s === 'string' && s))
}
export function isCodexOfficialSlug(cfg, model) {
  return typeof model === 'string' && !!model && codexOfficialSlugSet(cfg).has(model)
}
// 官方 slug 的上游 provider：只认 defaults.codexOfficialProvider（不猜、不按名字推断）。
export function codexOfficialProvider(cfg) {
  const v = cfg && cfg.defaults && cfg.defaults.codexOfficialProvider
  return typeof v === 'string' ? v.trim() : ''
}

// 模型解析单一入口（MG-008 余项）：探测/预热/failback/转发必须得到同一组
// { servingName(上游模型名), api(协议), effortFormat, maxTokensMax }，否则同一模型在不同路径
// 会打不同上游名/协议（典型：providerModels 覆盖只在转发生效，预热却发网关模型名 → 404）。
export function modelTarget(cfg, modelName, pid) {
  const mdDirect = (modelName && cfg && cfg.models && cfg.models[modelName]) || null
  // 聚合 slug 不在 config.models：上游模型名取目录绑定里的原模型名（仅对绑定自己的上游生效），
  // 协议/思考强度/输出上限仍继承原模型条目，避免「目录模型能力退化」。
  const binding = mdDirect ? null : codexBindingFor(cfg, modelName)
  const md = mdDirect || (binding && cfg && cfg.models && cfg.models[binding.model]) || null
  const prov = (cfg && cfg.providers && cfg.providers[pid]) || null
  const servingName = (mdDirect && mdDirect.providerModels && mdDirect.providerModels[pid]) ||
    (binding && (!pid || binding.provider === pid) ? binding.model : null) ||
    (md && md.providerModels && md.providerModels[pid]) ||
    modelName
  const api = (md && md.api) || (binding && binding.capability === 'chat' ? 'openai' : null) || (prov && prov.api) || 'openai'
  return { servingName, api, effortFormat: (md && md.effortFormat) || 'reasoning_effort', maxTokensMax: Number((md && md.maxTokensMax) || 0) || 0 }
}

// M0-3：磁盘指纹（存在性 + sha256），随内存 cfg 保存；配置事务用它判断「内存代际是否仍是磁盘代际」。
// 只存哈希，不存正文/Key。
function readFileIfExists(path) {
  try { return readFileSync(path) } catch (error) { if (error && error.code === 'ENOENT') return null; throw error }
}
function rawFingerprint(buf) {
  return buf == null ? { exists: false, hash: null, size: 0 } : { exists: true, hash: createHash('sha256').update(buf).digest('hex'), size: buf.length }
}
function keysFromRaw(raw, path) {
  if (raw == null) return {}
  const text = raw.toString('utf8')
  if (!text.trim()) return {} // 空文件 = 尚未写入任何 Key（与「损坏」区分）
  if (text.trimStart().startsWith('MG1:')) {
    try { return keysDecrypt(text) } catch (error) {
      throw new ConfigUnreadable('keys_unreadable', 'keys.local.json 无法解密（主密钥不匹配或密文损坏）：已拒绝加载以免清空现有 Key；请恢复对应主密钥或从备份恢复。' + (error && error.message ? '（' + error.message + '）' : ''), { path })
    }
  }
  let parsed
  try { parsed = JSON.parse(text.replace(/^\uFEFF/, '')) } catch {
    throw unreadableJson('keys_unreadable', path || 'keys.local.json', 'keys.local.json')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw unreadableJson('keys_unreadable', path || 'keys.local.json', 'keys.local.json（顶层必须是对象）')
  return parsed
}

export function loadConfig(opts = {}) {
  const p = configPaths()
  let mainFile = opts.configFile || (process.env.MG_CONFIG && existsSync(process.env.MG_CONFIG) ? process.env.MG_CONFIG : null)
  if (!mainFile) mainFile = join(p.dir, 'gateway.json')
  if (!existsSync(mainFile)) throw new Error('配置文件不存在: ' + mainFile)
  const base = readJson(mainFile)
  const localRaw = readFileIfExists(p.local)
  if (localRaw != null) {
    // F02：存在但不可解析 → 拒绝启动（不降级到 base 配置）。
    const patch = readLocalConfigStrict(p.local, {})
    base.providers = Object.assign({}, base.providers, patch.providers)
    base.models = Object.assign({}, base.models, patch.models)
    // 删除墓碑：patch 只做合并，缺键无法表达"删除"，因此保存时显式记录被删的上游/模型名（MG-003）
    if (patch._removed && typeof patch._removed === 'object') {
      for (const id of (Array.isArray(patch._removed.providers) ? patch._removed.providers : [])) delete base.providers[id]
      for (const n of (Array.isArray(patch._removed.models) ? patch._removed.models : [])) delete base.models[n]
    }
    base.defaults = Object.assign({}, base.defaults, patch.defaults)
    base.configVersion = Number(patch.configVersion) || 0
    if (patch.virtualModels !== undefined) base.virtualModels = patch.virtualModels
  }
  base.virtualModels = normalizeVirtualModels(base.virtualModels, base)
  const keysRaw = readFileIfExists(p.keys)     // 一次读盘：解析与指纹用同一份字节
  base._keys = keysFromRaw(keysRaw, p.keys)    // { providerId: key }，gitignored，不入库；损坏时抛 keys_unreadable
  base._disk = { local: rawFingerprint(localRaw), keys: rawFingerprint(keysRaw) }
  base._paths = p
  return base
}

// key 解析：面板 keys.local.json 优先，其次环境变量
// 用户级环境变量实时读取（绕过进程启动快照）：
// 进程 env 是启动时的副本，用户之后新增的变量对已运行进程不可见；这里实时查用户级环境拿最新值。
//  - Windows：查注册表 HKCU\Environment（reg query）
//  - Linux/POSIX：先查 systemd 用户管理器环境（systemctl --user show-environment，其中已含
//    ~/.config/environment.d/*.conf 的内容）；未命中再直接解析 environment.d 文件，使
//    「改完配置文件即生效」不必依赖 daemon-reload 或重启网关。
// 带 TTL 缓存——spawnSync/读盘有毫秒级开销且 resolveKey 在每请求路径上，不能裸调；正负值都缓存
// （找不到也缓存，避免高频空查）。改完变量最多 ~60s 生效。
const _userEnvCache = new Map() // name -> { value: string|null, at: number }
const USER_ENV_TTL_MS = 60000
// 离线测试注入点：默认 null，走真实 systemctl/注册表/environment.d。测试注入后仍复用同一份
// TTL 缓存与变量名白名单，因此"缓存与负缓存"语义可以被确定性覆盖，不需要等待 60s 或触碰真实 Key。
let _userEnvReaderForTest = null
export function __setUserEnvReaderForTest(fn) { _userEnvReaderForTest = typeof fn === 'function' ? fn : null }
export function __clearUserEnvCache() { _userEnvCache.clear() }
// systemd show-environment 对环境值做 shell 兼容转义（含空格/引号时包双引号并转义内部字符），此处还原
function unquoteEnvValue(raw) {
  const s = String(raw).trim()
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') return s.slice(1, -1).replace(/\\(["\\$`])/g, '$1')
  return s
}
// 直接解析 ~/.config/environment.d/*.conf（按文件名排序，后者覆盖前者），作为 user manager 未刷新的兜底
export function readEnvironmentDir(name, baseDir) {
  const dir = baseDir || join(homedir(), '.config', 'environment.d')
  let files
  try { files = readdirSync(dir).filter((f) => f.endsWith('.conf')).sort() } catch { return null }
  let value = null
  for (const f of files) {
    let text
    try { text = readFileSync(join(dir, f), 'utf8') } catch { continue }
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const eq = t.indexOf('=')
      if (eq <= 0 || t.slice(0, eq).trim() !== name) continue
      const v = unquoteEnvValue(t.slice(eq + 1))
      if (v) value = v
    }
  }
  return value
}
function readUserEnv(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null // 变量名白名单字符，防注入
  const now = Date.now()
  const cached = _userEnvCache.get(name)
  if (cached && now - cached.at < USER_ENV_TTL_MS) return cached.value
  let value = null
  try {
    if (_userEnvReaderForTest) {
      value = _userEnvReaderForTest(name)
    } else if (process.platform === 'win32') {
      const r = spawnSync('reg', ['query', 'HKCU\\Environment', '/v', name], { encoding: 'utf8', timeout: 3000 })
      const line = (r.stdout || '').split(/\r?\n/).find((l) => l.includes('REG_SZ') || l.includes('REG_EXPAND_SZ'))
      if (line) {
        const idx = line.indexOf('REG_')
        const raw = line.slice(line.indexOf('SZ', idx) + 2).trim()
        if (raw) value = raw
      }
    } else {
      const r = spawnSync('systemctl', ['--user', 'show-environment'], { encoding: 'utf8', timeout: 3000 })
      if (r.status === 0 && r.stdout) {
        const pfx = name + '='
        const line = r.stdout.split('\n').find((l) => l.startsWith(pfx))
        if (line) value = unquoteEnvValue(line.slice(pfx.length))
      }
      if (!value) value = readEnvironmentDir(name)
    }
  } catch { value = null }
  _userEnvCache.set(name, { value, at: now })
  return value
}

export function resolveKey(cfg, def, id) {
  if (cfg._keys && cfg._keys[id]) return { key: cfg._keys[id], source: 'keys' }
  if (def.apiKeyEnv) {
    const envVal = process.env[def.apiKeyEnv]
    if (envVal) return { key: envVal, source: 'env' }
    // 进程环境没有 → fallback 实时读注册表用户级变量：进程 env 是启动快照，用户在系统里
    // 新增的变量（如新接上游的 API key）对已运行进程不可见，此前只能重启网关（且须连托盘一起
    // 重启，否则拉活的网关继承托盘旧环境）才能生效。实时查注册表让「配完 key 就能用」。
    const regVal = readUserEnv(def.apiKeyEnv)
    if (regVal) return { key: regVal, source: 'env-registry' }
  }
  return { key: '', source: null }
}

export function buildProvider(cfg, id) {
  const def = (cfg.providers || {})[id]
  if (!def) throw new Error('unknown provider: ' + id)
  const pk = resolveKey(cfg, def, id)
  // 上游 HTTP 代理（三模式）：defaults.proxyMode = auto(默认) | direct | global。
  //  - auto   ：现状——per-provider `proxy` > defaults.proxy > 环境变量；单上游显式 `direct`/`false` 关闭（强制直连）；
  //             单上游留空/缺省 = 继承 defaults.proxy（全局）；
  //  - direct ：全部直连，无视任何 proxy 配置（含单上游关闭/全局/环境变量）；
  //  - global ：非回环上游强制走默认代理（defaults.proxy 或环境变量），忽略单上游设置（含 direct）；
  // 回环目标在任何模式下由 request.js 的 ctxFor 自动直连（本地上游不被代理掐死）。
  const envProxy = (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy) || ''
  const mode = (cfg.defaults && cfg.defaults.proxyMode) || 'auto'
  let proxy
  if (mode === 'direct') proxy = ''
  else if (mode === 'global') proxy = (cfg.defaults && cfg.defaults.proxy) || envProxy
  else {
    if (def.proxy === 'direct' || def.proxy === false) proxy = ''
    else proxy = def.proxy || ((cfg.defaults && cfg.defaults.proxy) || envProxy)
  }
  return {
    id,
    api: def.api || 'openai',
    circuit: def.circuit || null,
    baseUrl: String(def.baseUrl || '').replace(/\/+$/, ''),
    pathPrefix: def.pathPrefix || '',
    extraHeaders: def.extraHeaders || {},
    apiKey: pk.key,
    keyOk: !!pk.key,
    keySource: pk.source,
    proxy: String(proxy || ''),
    _def: def,
  }
}

export function createRouter(cfg) {
  const models = cfg.models || {}
  const alias = new Map()
  for (const [name, def] of Object.entries(models)) {
    alias.set(name, { name, def })
    for (const a of def.alias || []) alias.set(a, { name, def })
  }
  const defaultProvider = cfg.defaults && cfg.defaults.provider
  const virtualModel = cfg.defaults && cfg.defaults.model
  const vms = new Map((cfg.virtualModels || []).map(v => [v.name, v]))
  // 聚合保留 ID 未命中：明确 404 unknown_model，**绝不**回退 defaults.provider。
  // 错误对象自带 code/status/available，forward.js 与 /api/route-preview 据此给出稳定错误码；
  // 不在这里直接猜上游——「同名不同源」的静默改绑正是 D1 禁止的行为。
  function unknownAggregate(model) {
    const available = [...alias.keys()].filter((name) => isAggregateModelId(name, cfg)).sort().slice(0, 50)
    const e = new Error('未知聚合模型 ID: ' + model + '（聚合保留 ID 未在 config/models 显式声明即 404，不回退默认上游 defaults.provider）')
    e.code = 'unknown_model'
    e.status = 404
    e.aggregate = true
    e.model = model
    e.prefixes = aggregatePrefixes(cfg)
    e.available = available
    return e
  }
  // 目录视图按引用缓存：index.js 可能在 createRouter 之后才注入/替换 cfg._codexCatalog
  // （加载顺序与热重载都不可依赖），因此按对象引用失效，而不是在构造时快照。
  let catCache = null
  let catSource
  // N01：catalog() 现在可以吃一个**固定快照**（pin）。传入快照时不再读 cfg._codexCatalog，
  // 因此同一请求从解析到授权始终使用同一代目录（同代生成/授权，不混代）。
  function snapshotView(snapshot) {
    if (snapshot == null) return null
    const view = snapshot.view || snapshot
    const generation = snapshot.generation != null ? snapshot.generation : view && view.generation
    if (view && view.complete === false) {
      throw catalogError('*', 'catalog_snapshot_incomplete', '目录快照不完整，拒绝路由（零上游）：' + (view.incompleteReasons || []).join(','))
    }
    if (!view || !Array.isArray(view.models) || !view.models.length || !Number.isInteger(generation)) {
      throw catalogError('*', 'catalog_snapshot_invalid', '目录快照缺少模型或代际，拒绝路由（零上游）')
    }
    return { view, generation }
  }
  function catalog(snapshot) {
    const pinned = snapshotView(snapshot)
    if (pinned) {
      const view = pinned.view
      return {
        officials: new Set((view.officialSlugs || []).filter((s) => typeof s === 'string' && s)),
        bindings: (view.bindings && typeof view.bindings === 'object') ? view.bindings : {},
        aliases: (view.aliases && typeof view.aliases === 'object') ? view.aliases : {},
        retired: new Set((view.retiredSlugs || []).filter((s) => typeof s === 'string' && s)),
        generation: pinned.generation,
        key: view.key || (snapshot && snapshot.key) || null,
      }
    }
    const src = cfg && cfg._codexCatalog
    if (catSource === src && catCache) return catCache
    catSource = src
    catCache = {
      officials: codexOfficialSlugSet(cfg),
      bindings: codexCatalogBindings(cfg),
      aliases: (src && src.aliases && typeof src.aliases === 'object') ? src.aliases : {},
      retired: new Set(((src && src.retiredSlugs) || []).filter((s) => typeof s === 'string' && s)),
      generation: src && Number.isInteger(src.generation) ? src.generation : null,
      key: (src && src.key) || null,
    }
    return catCache
  }
  // 目录 slug 无法安全路由（身份冲突 / 上游缺失 / 绑定损坏）：**fail-closed**。
  // 用 unknown_model 404 而非静默回落 defaults.provider —— 静默改绑正是 D1 禁止的行为；
  // reason 供日志/诊断区分具体原因（不把上游细节当客户端可执行提示）。
  function catalogError(model, reason, message) {
    const e = new Error(message)
    e.code = 'unknown_model'
    e.status = 404
    e.reason = reason
    e.model = model
    e.available = [...alias.keys()].filter((name) => isAggregateModelId(name, cfg)).sort().slice(0, 50)
    return e
  }
  function resolveCatalogSlug(model, snapshot) {
    const cat = catalog(snapshot)
    // N01：墓碑优先于一切现存条目 —— 下架模型即便仍出现在旧视图/旧缓存里，也零上游拒绝。
    if (cat.retired.has(model)) throw catalogError(model, 'catalog_slug_retired', '目录模型 ' + model + ' 已下架（墓碑），拒绝路由且零上游请求')
    // N01：同代别名（来自目录 meta）。别名指向墓碑/不存在目标 => fail-closed，不回落默认上游。
    if (Object.prototype.hasOwnProperty.call(cat.aliases, model)) {
      const raw = cat.aliases[model]
      const target = raw && typeof raw === 'object' ? raw.model : raw
      if (typeof target !== 'string' || !target) throw catalogError(model, 'alias_target_missing', '目录别名 ' + model + ' 没有有效目标')
      if (cat.retired.has(target)) throw catalogError(model, 'alias_to_retired_id', '目录别名 ' + model + ' 指向已下架模型 ' + target)
      const resolved = resolveCatalogSlug(target, snapshot)
      if (!resolved) throw catalogError(model, 'alias_target_missing', '目录别名 ' + model + ' 指向不存在的目录模型 ' + target)
      const wrapped = Object.assign({}, resolved, { canonicalName: model, aliasTarget: target })
      if (snapshot) wrapped.catalogGeneration = snapshot.generation != null ? snapshot.generation : cat.generation
      else if (cat.generation != null) wrapped.catalogGeneration = cat.generation
      return wrapped
    }
    const isOfficial = cat.officials.has(model)
    const rawBinding = cat.bindings[model]
    const hasBinding = !!(rawBinding && typeof rawBinding === 'object')
    if (!isOfficial && !hasBinding) return null
    // 1) 目录 slug 与 config.models/别名同名 → 身份不确定（同名不同源），fail-closed，绝不让任何一侧静默胜出。
    const clash = alias.get(model)
    if (clash) throw catalogError(model, 'catalog_slug_conflicts_with_models', '目录 slug ' + model + ' 同时被 config/models（' + clash.name + '）声明，身份冲突已拒绝路由')
    // 2) 官方 slug：只走 defaults.codexOfficialProvider 指向的官方上游，api=responses（原生透传）。
    if (isOfficial) {
      const pid = codexOfficialProvider(cfg)
      if (!pid) throw catalogError(model, 'official_provider_missing', '官方目录模型 ' + model + ' 需要 defaults.codexOfficialProvider 指定官方上游')
      if (!cfg.providers || !cfg.providers[pid]) throw catalogError(model, 'official_provider_missing', '官方目录模型 ' + model + ' 指向的上游 ' + pid + ' 未配置')
      return { canonicalName: model, known: true, catalogGeneration: genOf(cat), def: { provider: pid, api: 'responses', codexOfficial: true } }
    }
    // 3) 聚合 slug：绑定来自**本次解析的那一代目录**（不重读 cfg._codexCatalog），
    //    否则固定快照解析会被新代目录的 bindings 污染（混代）。providerModels 让转发/探活/预热共用同一映射。
    if (!rawBinding || typeof rawBinding.provider !== 'string' || !rawBinding.provider) {
      throw catalogError(model, 'catalog_binding_invalid', '聚合目录模型 ' + model + ' 的绑定损坏（缺少 provider）')
    }
    const binding = {
      slug: typeof rawBinding.slug === 'string' && rawBinding.slug ? rawBinding.slug : model,
      provider: rawBinding.provider,
      model: typeof rawBinding.model === 'string' && rawBinding.model ? rawBinding.model : model,
      capability: typeof rawBinding.capability === 'string' && rawBinding.capability ? rawBinding.capability : 'chat',
    }
    if (!cfg.providers || !cfg.providers[binding.provider]) throw catalogError(model, 'catalog_binding_invalid', '聚合目录模型 ' + model + ' 绑定的上游 ' + binding.provider + ' 未配置')
    return {
      canonicalName: model,
      known: true,
      catalogGeneration: genOf(cat),
      catalogKey: cat.key || null,
      def: {
        provider: binding.provider,
        api: 'openai',
        providerModels: { [binding.provider]: binding.model },
        codexAggregate: true,
        servingModel: binding.model,
        capability: binding.capability,
      },
    }
  }
  function genOf(cat) {
    return cat && Number.isInteger(cat.generation) ? cat.generation : null
  }
  // opts.snapshot：调用方固定的目录快照（N01 同代解析）。缺省时沿用旧的「读 cfg._codexCatalog」行为。
  function resolve(model, opts = {}) {
    const snapshot = opts && opts.snapshot ? opts.snapshot : null
    // 优先级：虚拟模型 → 旧 defaults.model → 目录 slug（官方/聚合）→ 真实模型/别名
    //          → 聚合保留 ID 严格闸门 → 默认上游兜底（旧接口兼容）
    if (model && vms.has(model)) {
      const vm = vms.get(model)
      return { canonicalName: vm.name, known: true, def: { isVirtualModel: true, name: vm.name, directory: vm.directory, quota: vm.quota, dailyQuota: vm.dailyQuota, maxContext: vm.maxContext, maxConcurrent: vm.maxConcurrent, qps: vm.qps } }
    }
    if (model && virtualModel && model === virtualModel) {
      if (!defaultProvider) throw new Error('defaults.provider 未设置，无法用虚拟共用模型名: ' + model)
      return { canonicalName: virtualModel, known: true, def: { virtual: true } }
    }
    // 目录 slug 必须先于 alias：否则「官方 slug 被 config.models 同名声明」会被静默解析成第三方模型。
    if (model) { const catHit = resolveCatalogSlug(model, snapshot); if (catHit) return catHit }
    if (model) { const hit = alias.get(model); if (hit) return { canonicalName: hit.name, known: true, def: hit.def } }
    // 聚合保留前缀（默认 mg-/mg/，可用 defaults.aggregatePrefixes 覆盖）：未命中即硬失败。
    // 已配置的聚合 ID 在上一步就已返回，因此这条只影响「下架/拼错/同名不同源」的 ID。
    if (isAggregateModelId(model, cfg)) throw unknownAggregate(model)
    if (defaultProvider) return { canonicalName: model || '(默认)', known: !!model && alias.has(model), def: { provider: defaultProvider } }
    throw new Error('model 未在 config/models 中配置，且未设置 defaults.provider: ' + model)
  }
  // 固定快照解析：先自证快照完整/同代，再走同一套目录解析；不可用即 fail-closed（零上游）。
  function resolvePinned(model, snapshot) {
    const cat = catalog(snapshot)
    const hit = resolve(model, { snapshot })
    return Object.assign({}, hit, { catalogGeneration: genOf(cat), catalogKey: cat.key || null })
  }
  return { resolve, resolvePinned, hasVirtualModels: () => vms.size > 0 }
}
// 机器级主密钥：优先取 MG_KEYS_MASTER，否则自动生成并持久化到用户目录，保证 keys.local.json 永远加密落盘
function machineMaster() {
  const dir = join(homedir(), '.model-gateway')
  const p = join(dir, 'master.key')
  try {
    mkdirSync(dir, { recursive: true })
    if (existsSync(p)) { const v = readFileSync(p, 'utf8').trim(); if (v) return v }
    const gen = randomBytes(32).toString('base64url')
    writeFileSync(p, gen, 'utf8')
    if (process.platform === 'win32') { const u = process.env.USERNAME || 'Everyone'; spawnSync('icacls', [p, '/inheritance:r', '/grant:r', u + ':(F)'], { stdio: 'ignore' }) }
    else chmodSync(p, 0o600)
    return gen
  } catch { return null }
}
export function keyMaster() {
  const m = process.env.MG_KEYS_MASTER
  return (m && m.length) ? m : machineMaster()
}
export function keysEncrypt(obj) {
  const m = keyMaster(); if (!m) return null
  const k = createHash('sha256').update(m).digest()
  const iv = randomBytes(12)
  const cip = createCipheriv('aes-256-gcm', k, iv)
  const enc = Buffer.concat([cip.update(JSON.stringify(obj || {}), 'utf8'), cip.final()])
  return 'MG1:' + iv.toString('base64url') + '.' + cip.getAuthTag().toString('base64url') + '.' + enc.toString('base64url')
}
export function keysDecrypt(raw) {
  const m = keyMaster(); if (!m) throw new Error('keys.local.json 已加密，但未设置 MG_KEYS_MASTER，无法解密')
  const k = createHash('sha256').update(m).digest()
  const [ivb, tagb, encb] = raw.trim().slice(4).split('.')
  const d = createDecipheriv('aes-256-gcm', k, Buffer.from(ivb, 'base64url'))
  d.setAuthTag(Buffer.from(tagb, 'base64url'))
  const pt = Buffer.concat([d.update(Buffer.from(encb, 'base64url')), d.final()])
  return JSON.parse(pt.toString('utf8'))
}
function readKeys(p) {
  try { return keysFromRaw(readFileSync(p), p) } catch (error) { if (error && error.code === 'ENOENT') return {}; throw error }
}
// 从盘上读取最新 keys（解密），供写路径合并使用——消除「基于内存旧副本写回」复活已删 key 的窗口
export function readKeysFresh(p) { return readKeys(p) }
