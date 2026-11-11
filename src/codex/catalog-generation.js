// M2-2：Codex 聚合目录的“世代”层（纯函数 + 可注入发布器，不直接读写文件/不联网）。
//
// 解决的问题（审计 P1 目录契约）：
//   1. 目录缓存只看 provider/model 名字，同名模型改了 wire 配置（api/providerModels/effortFormat/
//      maxContext/capability…）仍命中旧目录 → 读者与路由跨代。这里把“影响 wire 的配置指纹”
//      并入 cache key / generation key；配置变化必然产生新世代，世代号单调，回滚只换整代。
//   2. 并发读要固定捕获开始时的世代：CatalogGenerationRegistry.beginRead() 返回整代引用，
//      发布后旧读者仍看到旧代（注入式测试，不依赖真实并发 sleep）。
//   3. 发布必须 CAS + 原子：persistAndSwapValidatedGeneration(expectedGeneration, next, io)
//      期望代际不匹配即拒绝；io.commit 抛错时旧代保持不变。
//
// 本模块不 import fs；CLI 负责真正的文件落盘。index.js/router.js 的接线属于后续卡。
import {
  CatalogError, assertCatalog, buildCatalog, catalogFingerprint, serializeCatalog,
  sha256Hex, stableStringify,
} from './catalog.js'

export const GENERATION_SCHEMA = 'modelgate.codex-catalog.generation/1'
export const VIEW_SCHEMA = 'modelgate.codex-catalog.view/1'
export const CACHE_KEY_SCHEMA = 'modelgate.codex-catalog.cache/1'

// 运行时统计 / 凭据 / 内存视图不参与 wire 指纹：改它们不应该产生新目录世代。
export const FINGERPRINT_IGNORED_KEYS = Object.freeze([
  '_codexCatalog', '_codexCatalogError', '_keys', 'apiKey', 'apiKeySet', 'keyOk', 'hasKey', 'keySource',
  'st', 'probe', 'requests', 'errors', 'retries', 'tokens', 'today', 'hitRate', 'affinity', 'avgMs',
  'inTokens', 'outTokens', 'latencySum', 'latencyCount', 'lastError', 'openUntil', 'lastUsed', 'keyErr',
])

function sanitizeWireValue(value) {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'function' ? undefined : value
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeWireValue).filter(v => v !== undefined)
  }
  const out = {}
  for (const key of Object.keys(value).sort()) {
    if (FINGERPRINT_IGNORED_KEYS.includes(key)) continue
    if (key.charAt(0) === '_') continue
    const v = sanitizeWireValue(value[key])
    if (v !== undefined) out[key] = v
  }
  return out
}

// 影响 wire/目录内容的配置指纹：包含 provider/baseUrl/pathPrefix/api/extraHeaders 与每个模型的
// 全部声明字段（未知扩展也纳入，宁可多失效，绝不漏失效）；忽略运行时统计与凭据明文。
export function configWireFingerprint(config) {
  return sha256Hex(stableStringify(sanitizeWireValue(config === undefined ? null : config)))
}

export function buildOptionsFingerprint(options = {}) {
  const picked = {}
  for (const key of ['templateModel', 'priorityStart', 'officialProviders', 'strict', 'allowUnknownEfforts', 'format']) {
    if (options[key] !== undefined) picked[key] = options[key]
  }
  return sha256Hex(stableStringify(picked))
}

export function baseFingerprint(base) {
  if (base && typeof base.sha256 === 'string' && base.sha256) return base.sha256
  if (base && base.catalog !== undefined) return sha256Hex(stableStringify(base.catalog))
  return sha256Hex(stableStringify(base === undefined ? null : base))
}

export function generationKey({ generation, catalogDigest, configFingerprint, baseFingerprint: baseFp, optionsFingerprint }) {
  return sha256Hex(stableStringify({
    schema: GENERATION_SCHEMA,
    generation,
    catalogDigest,
    configFingerprint,
    baseFingerprint: baseFp,
    optionsFingerprint,
  }))
}

// index.js 的目录缓存键（接线时替换现在的 basePath|mtime|size|modelNames）：
// 显式包含 wire 配置指纹；同名模型改配置 → key 变化 → 重新生成新世代。
export function generationCacheKey({ basePath, baseStat, baseSha256, config, options } = {}) {
  return sha256Hex(stableStringify({
    schema: CACHE_KEY_SCHEMA,
    basePath: basePath || null,
    baseMtimeMs: baseStat && Number.isFinite(baseStat.mtimeMs) ? baseStat.mtimeMs : null,
    baseSize: baseStat && Number.isFinite(baseStat.size) ? baseStat.size : null,
    baseSha256: baseSha256 || null,
    configFingerprint: configWireFingerprint(config === undefined ? null : config),
    optionsFingerprint: buildOptionsFingerprint(options || {}),
  }))
}

function normalizeBase(base) {
  if (base && base.catalog !== undefined) return base
  return { catalog: base, sha256: sha256Hex(stableStringify(base === undefined ? null : base)) }
}

function freezeRecord(record) {
  return Object.freeze(record)
}

// 由已构建/已序列化的目录生成不可变世代记录（CLI 复用，避免二次 buildCatalog）。
export function generationRecordFromBuilt({ generation, built, text, base = null, config = null, options = {}, format = 'catalog-json', verified = null }) {
  if (!Number.isInteger(generation) || generation < 1) {
    throw new CatalogError('invalid_generation', 'generation 必须是 >=1 的整数：' + JSON.stringify(generation))
  }
  if (!built || !built.catalog || !Array.isArray(built.catalog.models)) {
    throw new CatalogError('invalid_generation', '缺少已构建的目录')
  }
  if (typeof text !== 'string' || !text) throw new CatalogError('invalid_generation', '缺少序列化后的目录文本')
  const parsed = JSON.parse(text)
  assertCatalog(parsed, { source: 'generation catalog' })
  const digest = sha256Hex(text)
  const cfgFp = configWireFingerprint(config === undefined ? null : config)
  const baseFp = baseFingerprint(base)
  const optFp = buildOptionsFingerprint(options)
  const key = generationKey({ generation, catalogDigest: digest, configFingerprint: cfgFp, baseFingerprint: baseFp, optionsFingerprint: optFp })
  return freezeRecord({
    schema: GENERATION_SCHEMA,
    generation,
    key,
    digest,
    text,
    format,
    catalog: built.catalog,
    meta: built.meta,
    counts: built.meta.counts,
    configFingerprint: cfgFp,
    baseFingerprint: baseFp,
    optionsFingerprint: optFp,
    catalogFingerprint: catalogFingerprint(built.catalog),
    verified: Object.freeze(Object.assign({ catalog: true, official: true, thirdParty: true, by: 'catalog-generation', generation }, verified || {})),
  })
}

export function buildGenerationRecord({ generation, base, config = null, options = {}, format = 'catalog-json', verified = null }) {
  const normalized = normalizeBase(base)
  const built = buildCatalog({ base: normalized.catalog, config, options })
  const text = serializeCatalog(built.catalog, { format })
  return generationRecordFromBuilt({ generation, built, text, base: normalized, config, options, format, verified })
}

// 目录视图：/v1/models 投影、router.resolve、管理面 status 共用同一份（同一 generation/key）。
export function toCatalogView(record, options = {}) {
  if (!record || !record.catalog || !Array.isArray(record.catalog.models)) {
    throw new CatalogError('invalid_generation', 'toCatalogView 需要合法的世代记录')
  }
  const bindings = (record.meta && record.meta.bindings) || {}
  const officialSlugs = record.catalog.models.map(m => m && m.slug).filter(s => s && !bindings[s]).sort()
  const retiredSource = options.retiredSlugs || Object.keys(options.retiredBindings || {})
  const retiredSlugs = [...new Set(retiredSource.filter(s => typeof s === 'string' && s))].sort()
  return Object.freeze({
    schema: VIEW_SCHEMA,
    key: record.key,
    generation: record.generation,
    configFingerprint: record.configFingerprint,
    catalogFingerprint: record.catalogFingerprint,
    models: record.catalog.models,
    bindings,
    officialSlugs,
    retiredSlugs,
    verified: record.verified,
    counts: record.counts,
  })
}

// 未知 / 已下架（墓碑）/ 别名指向墓碑 / 别名目标缺失：全部 hard reject，绝不回落默认模型。
export function resolveCatalogId(view, id, options = {}) {
  const name = typeof id === 'string' ? id.trim() : ''
  const bindings = (view && view.bindings) || {}
  const officials = new Set((view && view.officialSlugs) || [])
  const retired = new Set([...((view && view.retiredSlugs) || []), ...Object.keys(options.retiredBindings || {})])
  if (!name) throw new CatalogError('unknown_catalog_id', '模型 ID 为空，拒绝回落默认模型', { id: id === undefined ? null : id })
  // 墓碑优先于任何现存条目：已下架 ID 即使仍出现在旧视图里也必须 hard reject。
  if (retired.has(name)) {
    throw new CatalogError('retired_catalog_id', '模型 ID ' + name + ' 已下架（墓碑），拒绝回落默认模型', { id: name })
  }
  if (bindings[name]) return { id: name, kind: 'binding', binding: bindings[name] }
  if (officials.has(name)) return { id: name, kind: 'official' }
  const aliases = options.aliases || (view && view.aliases) || {}
  if (Object.prototype.hasOwnProperty.call(aliases, name)) {
    const raw = aliases[name]
    const target = raw && typeof raw === 'object' ? raw.model : raw
    if (typeof target !== 'string' || !target) throw new CatalogError('alias_target_missing', '别名 ' + name + ' 没有有效目标', { id: name })
    if (retired.has(target)) throw new CatalogError('alias_to_retired_id', '别名 ' + name + ' 指向已下架的模型 ID ' + target, { id: name, target })
    if (bindings[target]) return { id: name, kind: 'alias', target, binding: bindings[target] }
    if (officials.has(target)) return { id: name, kind: 'alias', target }
    throw new CatalogError('alias_target_missing', '别名 ' + name + ' 指向不存在的模型 ID ' + target, { id: name, target })
  }
  throw new CatalogError('unknown_catalog_id', '目录外模型 ID ' + name + '，拒绝回落默认模型', { id: name })
}

// 并发读固定捕获世代：beginRead 后发布新代，旧读者仍见旧代；发布按 CAS + 单调递增。
export class CatalogGenerationRegistry {
  constructor(record = null) {
    this._current = record || null
    this._highWater = record && Number.isInteger(record.generation) ? record.generation : 0
  }
  current() { return this._current }
  beginRead() {
    const record = this._current
    return Object.freeze({ generation: record ? record.generation : 0, record })
  }
  publish(record, options = {}) {
    if (!record || !Number.isInteger(record.generation)) {
      throw new CatalogError('invalid_generation', '发布记录缺少整数 generation')
    }
    const current = this._current ? this._current.generation : 0
    if (options.expectedGeneration !== undefined && Number(options.expectedGeneration) !== current) {
      throw new CatalogError('generation_conflict',
        '目录世代 CAS 失败：期望 ' + options.expectedGeneration + '，当前 ' + current,
        { expected: options.expectedGeneration, current })
    }
    if (record.generation <= this._highWater) {
      throw new CatalogError('generation_not_monotonic',
        '目录世代必须单调递增：新 ' + record.generation + ' 不大于已发布最高 ' + this._highWater)
    }
    this._current = record
    this._highWater = record.generation
    return record
  }
  // 回滚 = 整代替换（不修改任何已发布记录），高水位不回落，后续发布继续单调。
  rollbackTo(record) {
    this._current = record || null
    return this._current
  }
}

// 原子发布（CAS）：io = { readState(), commit(next) }。
// expectedGeneration 与当前不一致 → generation_conflict；commit 抛错时旧代保持。
export function persistAndSwapValidatedGeneration(expectedGeneration, next, io) {
  if (!io || typeof io.readState !== 'function' || typeof io.commit !== 'function') {
    throw new CatalogError('invalid_generation_io', 'persistAndSwapValidatedGeneration 需要 { readState, commit }')
  }
  const state = io.readState()
  const current = Number.isInteger(state && state.currentVersion) ? state.currentVersion : 0
  if (Number(expectedGeneration) !== current) {
    throw new CatalogError('generation_conflict',
      '目录世代 CAS 失败：期望 ' + expectedGeneration + '，当前 ' + current,
      { expected: expectedGeneration, current })
  }
  if (!next || !Number.isInteger(next.generation)) {
    throw new CatalogError('invalid_generation', '发布记录缺少整数 generation')
  }
  if (next.generation <= current) {
    throw new CatalogError('generation_not_monotonic',
      '目录世代必须单调递增：新 ' + next.generation + ' 不大于当前 ' + current)
  }
  if (!next.state || next.state.currentVersion !== next.generation) {
    throw new CatalogError('invalid_generation', 'next.state.currentVersion 必须等于 next.generation')
  }
  if (typeof next.key !== 'string' || !next.key || typeof next.digest !== 'string' || !next.digest) {
    throw new CatalogError('invalid_generation', '发布记录缺少 key/digest')
  }
  io.commit(next)
  return next
}

// 接线辅助：由世代记录生成 authorizeFinalTarget 的 binding，verified 标志只有一个来源（记录本身）。
export function generationAuthzBinding(record, options = {}) {
  const verified = (record && record.verified) || {}
  const domain = options.domain
  return Object.freeze({
    generation: record ? record.generation : null,
    catalogKey: record ? record.key : null,
    officialVerified: domain === 'official' && verified.official === true,
    thirdPartyVerified: domain === 'thirdParty' && verified.thirdParty === true,
    origin: options.origin,
    path: options.path,
    pathPrefix: options.pathPrefix,
    identity: options.identity || null,
    provider: options.provider || null,
    cfg: options.cfg || {},
    modelBinding: options.modelBinding || {},
    providerId: options.providerId || null,
  })
}
