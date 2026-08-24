import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

export function configPaths() {
  const dir = join(process.cwd(), 'config')
  return { dir, local: join(dir, 'gateway.local.json'), keys: join(dir, 'keys.local.json'), stats: join(dir, 'stats.json') }
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
    base.defaults = Object.assign({}, base.defaults, patch.defaults)
  }
  base._keys = readKeys(p.keys)                // { providerId: key }，gitignored，不入库
  base._paths = p
  return base
}

// key 解析：面板 keys.local.json 优先，其次环境变量
export function resolveKey(cfg, def, id) {
  if (cfg._keys && cfg._keys[id]) return { key: cfg._keys[id], source: 'keys' }
  if (def.apiKeyEnv && process.env[def.apiKeyEnv]) return { key: process.env[def.apiKeyEnv], source: 'env' }
  return { key: '', source: null }
}

export function buildProvider(cfg, id) {
  const def = (cfg.providers || {})[id]
  if (!def) throw new Error('unknown provider: ' + id)
  const pk = resolveKey(cfg, def, id)
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
  function resolve(model) {
    if (model && virtualModel && model === virtualModel) {
      if (!defaultProvider) throw new Error('defaults.provider 未设置，无法用虚拟共用模型名: ' + model)
      return { canonicalName: virtualModel, def: { provider: defaultProvider, virtual: true } }
    }
    if (model) { const hit = alias.get(model); if (hit) return { canonicalName: hit.name, def: hit.def } }
    if (defaultProvider) return { canonicalName: model || '(默认)', def: { provider: defaultProvider } }
    throw new Error('model 未在 config/models 中配置，且未设置 defaults.provider: ' + model)
  }
  return { resolve }
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
