import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, chmodSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

export function configPaths() {
  // MG_CONFIG_DIR：可选。多实例隔离时为实例指定独立配置目录（keys/stats 随之独立）；未设置=cwd/config（单实例零配置）
  const envDir = (process.env.MG_CONFIG_DIR || '').trim()
  const dir = envDir || join(process.cwd(), 'config')
  return { dir, local: join(dir, 'gateway.local.json'), keys: join(dir, 'keys.local.json'), stats: join(dir, 'stats.json'), videos: join(dir, 'videos.json') }
}

export function readJson(path, dflt = {}) {
  try { return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) } catch { return dflt }
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

// 模型解析单一入口（MG-008 余项）：探测/预热/failback/转发必须得到同一组
// { servingName(上游模型名), api(协议), effortFormat, maxTokensMax }，否则同一模型在不同路径
// 会打不同上游名/协议（典型：providerModels 覆盖只在转发生效，预热却发网关模型名 → 404）。
export function modelTarget(cfg, modelName, pid) {
  const md = (modelName && cfg && cfg.models && cfg.models[modelName]) || null
  const prov = (cfg && cfg.providers && cfg.providers[pid]) || null
  const servingName = (md && md.providerModels && md.providerModels[pid]) || modelName
  const api = (md && md.api) || (prov && prov.api) || 'openai'
  return { servingName, api, effortFormat: (md && md.effortFormat) || 'reasoning_effort', maxTokensMax: Number((md && md.maxTokensMax) || 0) || 0 }
}

export function loadConfig(opts = {}) {
  const p = configPaths()
  let mainFile = opts.configFile || (process.env.MG_CONFIG && existsSync(process.env.MG_CONFIG) ? process.env.MG_CONFIG : null)
  if (!mainFile) mainFile = join(p.dir, 'gateway.json')
  if (!existsSync(mainFile)) throw new Error('配置文件不存在: ' + mainFile)
  const base = readJson(mainFile)
  if (existsSync(p.local)) {
    const patch = readJson(p.local)
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
  base._keys = readKeys(p.keys)                // { providerId: key }，gitignored，不入库
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
  function resolve(model) {
    // 优先级：真实模型/别名 → 虚拟模型（自带 directory 快照）→ 旧 defaults.model → 默认上游兜底
    if (model && vms.has(model)) {
      const vm = vms.get(model)
      return { canonicalName: vm.name, known: true, def: { isVirtualModel: true, name: vm.name, directory: vm.directory, quota: vm.quota, dailyQuota: vm.dailyQuota, maxContext: vm.maxContext, maxConcurrent: vm.maxConcurrent, qps: vm.qps } }
    }
    if (model && virtualModel && model === virtualModel) {
      if (!defaultProvider) throw new Error('defaults.provider 未设置，无法用虚拟共用模型名: ' + model)
      return { canonicalName: virtualModel, known: true, def: { virtual: true } }
    }
    if (model) { const hit = alias.get(model); if (hit) return { canonicalName: hit.name, known: true, def: hit.def } }
    if (defaultProvider) return { canonicalName: model || '(默认)', known: !!model && alias.has(model), def: { provider: defaultProvider } }
    throw new Error('model 未在 config/models 中配置，且未设置 defaults.provider: ' + model)
  }
  return { resolve, hasVirtualModels: () => vms.size > 0 }
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
  if (!existsSync(p)) return {}
  const raw = readFileSync(p, 'utf8')
  if (raw.trimStart().startsWith('MG1:')) return keysDecrypt(raw)
  try { const o = JSON.parse(raw); return o && typeof o === 'object' ? o : {} } catch { return {} }
}
// 从盘上读取最新 keys（解密），供写路径合并使用——消除「基于内存旧副本写回」复活已删 key 的窗口
export function readKeysFresh(p) { return readKeys(p) }
