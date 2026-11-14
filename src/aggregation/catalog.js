// A2 / P01：聚合目录发布。
//
// 职责（ADR-0003 §2 / §3）：
//   - 把发现快照投影成既有 Codex 目录形状，经 `src/codex/catalog-generation.js` 生成不可变世代，
//     用 `persistAndSwapValidatedGeneration()` CAS + 原子提交；校验用 `src/codex/catalog.js` 的
//     `assertCatalog()` / `assertZeroCollisions()`（通过 `buildCatalog()` 调用）。
//   - **本模块不另写 ID 生成、指纹或落盘格式**：公共 ID 只来自 `stableModelId()`；世代/指纹只来自
//     catalog-generation；版本文件与 state 只是该模块 `io` 的实现。
//   - 已发布 `mg-opencodego-*` 字节兼容：provider 段固定 `opencodego` / `console`，上游精确 ID 原样
//     作为 `models.<upstreamId>` 的键与 binding.model，绝不出现在上游请求体之外。
//   - `authorized:false` 的模型**永不发布为可调用模型**，只进诊断。
//   - 上下文窗口缺失 → 默认 fail-closed（`context_window_missing`），不编造；可选 allowMissingContext
//     时跳过并明确记诊断（仍不发布假数据）。
//   - 目录超出 Codex 可接受规模 → 自动维护本机全量目录（`full-catalog.json`），**绝不裁剪模型**。

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileDurable } from '../config-transaction.js'
import {
  CatalogError, assertCatalog, assertZeroCollisions, buildCatalog, emptyState, nextVersion,
  recordVersion, resolveRollbackTarget, serializeCatalog,
} from '../codex/catalog.js'
import { generationRecordFromBuilt, persistAndSwapValidatedGeneration } from '../codex/catalog-generation.js'

export const AGGREGATED_CATALOG_SCHEMA = 'modelgate.aggregation.catalog/1'
export const DEFAULT_CATALOG_LIMITS = Object.freeze({ maxModels: 512, maxBytes: 2 * 1024 * 1024 })
const SAFE_SEGMENT_RE = /[^A-Za-z0-9._-]+/g

export class AggregatedCatalogError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'AggregatedCatalogError'
    this.code = code
    this.details = details
  }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const safeSegment = (v) => {
  const s = String(v == null ? '' : v).replace(SAFE_SEGMENT_RE, '_')
  return s === '' || s === '.' || s === '..' ? 'local' : s
}
const scopeOf = (scopeRef) => (typeof scopeRef === 'string' ? scopeRef : (isPlainObject(scopeRef) && scopeRef.scope ? String(scopeRef.scope) : 'local'))
const datePart = (iso) => (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : new Date(0).toISOString().slice(0, 10))

export function createCatalogStateStore(options = {}) {
  const dir = options.dir
  if (!dir) throw new AggregatedCatalogError('catalog_store_dir_missing', '目录状态存储需要 dir')
  const scope = safeSegment(options.scope || 'local')
  const root = join(dir, 'aggregation', 'catalog', scope)
  const statePath = join(root, 'state.json')
  const currentPath = join(root, 'current.json')

  function readState() {
    try {
      const parsed = JSON.parse(readFileSync(statePath, 'utf8'))
      if (!isPlainObject(parsed) || !Number.isInteger(parsed.currentVersion)) return emptyState()
      return parsed
    } catch (error) {
      if (error && error.code === 'ENOENT') return emptyState()
      throw new AggregatedCatalogError('catalog_state_unreadable', '目录状态不可解析：拒绝覆盖：' + statePath)
    }
  }

  function versionPath(entry) {
    return join(root, entry.file)
  }

  function readVersionText(entry) {
    try { return readFileSync(versionPath(entry), 'utf8') } catch {
      throw new AggregatedCatalogError('catalog_version_missing', '回滚目标版本文件缺失：' + entry.file)
    }
  }

  function commit(record) {
    const current = record.state && record.state.current
    if (!current || !current.file) throw new AggregatedCatalogError('catalog_state_invalid', '世代记录缺少 state.current.file')
    mkdirSync(join(root, 'versions'), { recursive: true, mode: 0o700 })
    writeFileDurable(versionPath(current), record.text, 0o600)
    writeFileDurable(currentPath, record.text, 0o600)
    // state 最后写 = 提交点（与 scripts/codex-catalog.mjs 相同的顺序）。
    writeFileDurable(statePath, JSON.stringify(record.state, null, 2) + '\n', 0o600)
  }

  return Object.freeze({ root, statePath, currentPath, readState, readVersionText, commit, versionPath })
}

function resolveBaseCatalog(options, cfg) {
  if (options.base !== undefined) {
    if (!isPlainObject(options.base) || !Array.isArray(options.base.models)) {
      throw new AggregatedCatalogError('catalog_base_invalid', 'options.base 必须是 { models: [...] }')
    }
    return options.base
  }
  const path = cfg && cfg.defaults && cfg.defaults.codexCatalogBasePath
  if (!path || typeof path !== 'string') {
    throw new AggregatedCatalogError('catalog_base_missing',
      '没有官方基线目录：配置 defaults.codexCatalogBasePath 或注入 base；拒绝生成缺官方模型的“聚合目录”')
  }
  if (!existsSync(path)) throw new AggregatedCatalogError('catalog_base_missing', '官方基线目录不存在：' + path)
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new AggregatedCatalogError('catalog_base_invalid', '官方基线目录不可解析：' + path)
  }
}

// 单条快照模型 → buildCatalog 的 models.<name> 条目。name 必须是上游精确 ID。
function projectionEntry(model, provider) {
  const codex = {
    displayName: model.displayName || model.upstreamId,
    contextWindow: model.contextWindow,
  }
  // 只有上游/证据显式声明 supportsSearchTool 时才写能力；其余能力一律保守不声明。
  if (model.capabilities && model.capabilities.supportsSearchTool === true) {
    codex.capabilities = { supportsSearchTool: true }
    codex.evidence = {
      supportsSearchTool: {
        source: (model.evidence && model.evidence.source) || 'upstream_model_list',
        observedAt: datePart(model.evidence && model.evidence.observedAt),
      },
    }
  }
  return {
    provider: provider.providerSegment,
    capability: 'chat',
    maxContext: model.contextWindow,
    codex,
  }
}

// 按 provider 分层构建：同名的上游 ID 可同时存在于 go 与 console（公共 ID 段不同），
// 而 buildCatalog 的 models 映射以模型名为键，因此逐层调用它，绝不自己拼 slug。
function buildLayeredCatalog({ base, layers, options }) {
  let current = base
  let bindings = {}
  let aliases = {}
  const warnings = []
  const skipped = []
  let templateModel = null
  for (const layer of layers) {
    const config = { providers: { [layer.providerSegment]: { name: layer.name } }, models: layer.models }
    const built = buildCatalog({ base: current, config, options })
    current = built.catalog
    bindings = Object.assign(bindings, built.meta.bindings)
    aliases = Object.assign(aliases, built.meta.aliases)
    templateModel = built.meta.templateModel
    for (const w of built.meta.warnings) warnings.push(Object.assign({ layer: layer.providerSegment }, w))
    for (const s of built.meta.skipped || []) skipped.push(Object.assign({ layer: layer.providerSegment }, s))
  }
  const official = base.models.length
  const total = current.models.length
  return {
    catalog: current,
    meta: {
      templateModel,
      aliases,
      officialSlugs: base.models.map((m) => m && m.slug).filter(Boolean).sort(),
      counts: { official, thirdParty: total - official, total },
      skipped,
      models: [],
      bindings,
      warnings,
    },
  }
}

export function createAggregatedCatalog(options = {}) {
  const registry = options.registry
  const cacheStore = options.cacheStore
  const dir = options.dir
  const readConfig = typeof options.readConfig === 'function' ? options.readConfig : null
  const limits = Object.assign({}, DEFAULT_CATALOG_LIMITS, options.limits || {})
  const nowFn = typeof options.now === 'function' ? options.now : () => Date.now()
  const format = options.format || 'catalog-json'
  if (!registry || typeof registry.listProviders !== 'function') {
    throw new AggregatedCatalogError('catalog_registry_missing', '聚合目录需要 registry')
  }
  if (!cacheStore || typeof cacheStore.get !== 'function') {
    throw new AggregatedCatalogError('catalog_cache_missing', '聚合目录需要发现快照缓存')
  }
  if (!dir) throw new AggregatedCatalogError('catalog_store_dir_missing', '聚合目录需要状态目录 dir')

  function storeFor(scope) {
    return createCatalogStateStore({ dir, scope })
  }

  function collectLayers(scope, opts = {}) {
    const cfg = opts.cfg || (readConfig ? readConfig() : {})
    const providers = registry.listProviders().filter((p) => p.enabled !== false)
    if (!providers.length) {
      throw new AggregatedCatalogError('provider_none_configured', '没有已启用的聚合 Provider：先 add provider 并 sync')
    }
    const layers = []
    const diagnostics = []
    const unauthorized = []
    const missingContext = []
    const snapshotMeta = []
    for (const provider of providers) {
      const entry = cacheStore.get(scope, provider.id)
      if (!entry || !entry.snapshot) {
        throw new AggregatedCatalogError('discovery_snapshot_missing',
          'Provider ' + provider.id + ' 没有发现快照：拒绝发布一个漏掉该 provider 全部模型的目录',
          { providerId: provider.id })
      }
      const snapshot = entry.snapshot
      if (snapshot.complete !== true || snapshot.completeness !== 'discovery_complete') {
        throw new AggregatedCatalogError('discovery_incomplete',
          'Provider ' + provider.id + ' 的最近发现不完整（' + String(snapshot.completeness) + '）：拒绝发布不完整目录',
          { providerId: provider.id, completeness: snapshot.completeness })
      }
      const models = {}
      for (const model of snapshot.models) {
        if (!model.authorized) {
          unauthorized.push({ providerId: provider.id, upstreamId: model.upstreamId, publicId: model.publicId })
          continue
        }
        if (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0) {
          missingContext.push({ providerId: provider.id, upstreamId: model.upstreamId, publicId: model.publicId })
          continue
        }
        if (Object.prototype.hasOwnProperty.call(models, model.upstreamId)) {
          throw new AggregatedCatalogError('upstream_id_duplicate_in_snapshot',
            '快照内重复 upstreamId：' + model.upstreamId, { providerId: provider.id, upstreamId: model.upstreamId })
        }
        models[model.upstreamId] = projectionEntry(model, provider)
      }
      layers.push({ providerId: provider.id, providerSegment: provider.providerSegment, name: provider.name, models, snapshot })
      snapshotMeta.push({
        providerId: provider.id,
        kind: provider.kind,
        observedAt: snapshot.observedAt,
        endpointAssumed: snapshot.endpoint ? snapshot.endpoint.assumed === true : false,
        models: snapshot.models.length,
        emptyConfirmed: snapshot.emptyConfirmed === true,
      })
    }
    if (missingContext.length && opts.allowMissingContext !== true) {
      throw new AggregatedCatalogError('context_window_missing',
        '模型缺少上下文窗口，拒绝编造后发布：' + missingContext.map((m) => m.publicId || m.upstreamId).join(', '),
        { models: missingContext })
    }
    for (const m of missingContext) {
      diagnostics.push({ code: 'context_window_missing', severity: 'warning', message: '缺少上下文窗口，未发布（未编造）', upstreamId: m.upstreamId, publicId: m.publicId, providerId: m.providerId })
    }
    for (const m of unauthorized) {
      diagnostics.push({ code: 'unauthorized_excluded', severity: 'info', message: '账户无权使用：存档但不发布为可调用模型', upstreamId: m.upstreamId, publicId: m.publicId, providerId: m.providerId })
    }
    // 跨层公共 ID 预检（buildCatalog 也会判，但这里给出聚合层诊断）。
    const seen = new Map()
    for (const layer of layers) {
      for (const [upstreamId, entry] of Object.entries(layer.models)) {
        const slug = `mg-${String(layer.providerSegment).toLowerCase()}-${String(upstreamId).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`
        const prior = seen.get(slug)
        if (prior && (prior.providerId !== layer.providerId || prior.upstreamId !== upstreamId)) {
          throw new AggregatedCatalogError('public_id_collision',
            '两个上游模型映射到同一公共 ID ' + slug + '：' + prior.providerId + '/' + prior.upstreamId + ' 与 ' + layer.providerId + '/' + upstreamId,
            { slug, left: prior, right: { providerId: layer.providerId, upstreamId } })
        }
        seen.set(slug, { providerId: layer.providerId, upstreamId })
      }
    }
    return { cfg, layers, diagnostics, unauthorized, missingContext, snapshotMeta }
  }

  async function publish(scopeRef, opts = {}) {
    const scope = scopeOf(scopeRef)
    const collected = collectLayers(scope, opts)
    const base = resolveBaseCatalog(opts, collected.cfg)
    const layered = buildLayeredCatalog({ base, layers: collected.layers, options: opts.buildOptions || {} })
    // 显式再过一次零碰撞/目录校验（buildCatalog 内部已做；这里保证聚合层的身份名也参与）。
    const identityConfig = { models: {} }
    for (const layer of collected.layers) {
      for (const [name, entry] of Object.entries(layer.models)) {
        // buildCatalog 以 name 为键；同名跨层会覆盖，但零碰撞只看配置身份名，覆盖不影响判定。
        identityConfig.models[name] = entry
      }
    }
    try {
      assertZeroCollisions(identityConfig, { retiredSlugs: opts.retiredSlugs })
      assertCatalog(layered.catalog, { source: 'aggregated catalog' })
    } catch (error) {
      if (error instanceof CatalogError) {
        throw new AggregatedCatalogError(error.code || 'catalog_invalid', error.message, error.details || {})
      }
      throw error
    }
    const text = serializeCatalog(layered.catalog, { format })
    const store = storeFor(scope)
    const state = store.readState()
    const generation = nextVersion(state)
    const record = generationRecordFromBuilt({
      generation,
      built: layered,
      text,
      base,
      config: { aggregation: { layers: collected.layers.map((l) => ({ providerId: l.providerId, models: Object.keys(l.models) })) } },
      options: opts.buildOptions || {},
      format,
      verified: { discovery: 'recorded_snapshot', realUpstream: false, aggregatedBy: 'A2' },
    })
    const byteLength = Buffer.byteLength(text, 'utf8')
    const overflow = layered.catalog.models.length > limits.maxModels || byteLength > limits.maxBytes
    const fullCatalogPath = join(store.root, 'full-catalog.json')
    if (overflow) writeFileDurable(fullCatalogPath, text, 0o600)
    const nextState = recordVersion(state, {
      version: generation,
      file: join('versions', `v${String(generation).padStart(6, '0')}-${record.digest.slice(0, 8)}.json`),
      sha256: record.digest,
      generatedAt: new Date(nowFn()).toISOString(),
      format,
      counts: layered.meta.counts,
      sourceFingerprint: { layers: collected.snapshotMeta },
      key: record.key,
      configFingerprint: record.configFingerprint,
      catalogFingerprint: record.catalogFingerprint,
      bindings: layered.meta.bindings,
      verified: record.verified,
    })
    const next = { generation, key: record.key, digest: record.digest, state: nextState, verified: record.verified, record }
    persistAndSwapValidatedGeneration(state.currentVersion, next, {
      readState: () => store.readState(),
      commit: (rec) => store.commit(rec.record ? Object.assign({}, rec.record, { state: rec.state }) : rec),
    })
    const modelIds = layered.catalog.models.map((m) => m.slug)
    const diagnostics = [
      {
        code: 'catalog_published',
        severity: 'info',
        message: overflow ? '聚合目录已发布；规模超出本机上限，已自动维护全量本机目录（未裁剪）' : '聚合目录已发布',
        generation,
        counts: layered.meta.counts,
        byteLength,
        providers: collected.snapshotMeta,
        modelIds,
      },
      ...collected.diagnostics,
    ]
    if (layered.meta.warnings.length) {
      const codes = {}
      for (const w of layered.meta.warnings) codes[w.code] = (codes[w.code] || 0) + 1
      diagnostics.push({ code: 'catalog_warnings', severity: 'warning', message: '目录生成警告（按 code 汇总）', counts: codes })
    }
    if (overflow) {
      diagnostics.push({
        code: 'catalog_overflow_local_full',
        severity: 'warning',
        message: '目录超过 Codex 可接受规模假设；已写本机全量目录，绝不让用户手工裁剪',
        limits: { maxModels: limits.maxModels, maxBytes: limits.maxBytes },
        modelCount: layered.catalog.models.length,
        byteLength,
        fullCatalogPath,
      })
    }
    const catalogRef = {
      scope,
      generation,
      version: generation,
      key: record.key,
      digest: record.digest,
      sha256: record.digest,
      path: store.currentPath,
      versionPath: store.versionPath(nextState.current),
      mode: overflow ? 'local-full-catalog' : 'standard',
      format,
      fullCatalogPath: overflow ? fullCatalogPath : null,
      byteLength,
      modelCount: layered.catalog.models.length,
      counts: layered.meta.counts,
    }
    return {
      catalogRef,
      version: generation,
      modelCount: layered.catalog.models.length,
      diagnostics,
      reconciliation: {
        discovered: collected.snapshotMeta.reduce((n, p) => n + p.models, 0),
        published: layered.catalog.models.length - base.models.length,
        official: base.models.length,
        unauthorized: collected.unauthorized.length,
        missingContext: collected.missingContext.length,
        modelIds,
        providers: collected.snapshotMeta,
      },
    }
  }

  function rollback(scopeRef, selector = 'prev') {
    const scope = scopeOf(scopeRef)
    const store = storeFor(scope)
    const state = store.readState()
    if (!state.current) throw new AggregatedCatalogError('no_previous_version', '没有已发布目录可回滚')
    const target = resolveRollbackTarget(state, selector)
    const text = store.readVersionText(target)
    let catalog
    try { catalog = JSON.parse(text) } catch { throw new AggregatedCatalogError('catalog_version_invalid', '回滚目标不是合法 JSON') }
    try { assertCatalog(catalog, { source: 'rollback target' }) } catch (error) {
      if (error instanceof CatalogError) throw new AggregatedCatalogError(error.code || 'catalog_invalid', '回滚目标未通过校验：' + error.message)
      throw error
    }
    const generation = nextVersion(state)
    const built = {
      catalog,
      meta: {
        templateModel: null,
        aliases: {},
        officialSlugs: [],
        counts: target.counts || { official: 0, thirdParty: catalog.models.length, total: catalog.models.length },
        skipped: [],
        models: [],
        bindings: target.bindings || {},
        warnings: [],
      },
    }
    const record = generationRecordFromBuilt({
      generation,
      built,
      text,
      config: { rollback: { from: state.currentVersion, to: target.version } },
      format: state.current.format || format,
      verified: { discovery: 'rollback', realUpstream: false, aggregatedBy: 'A2' },
    })
    const nextState = recordVersion(state, {
      version: generation,
      file: join('versions', `v${String(generation).padStart(6, '0')}-${record.digest.slice(0, 8)}.json`),
      sha256: record.digest,
      generatedAt: new Date(nowFn()).toISOString(),
      format: state.current.format || format,
      counts: built.meta.counts,
      sourceFingerprint: { rollbackFrom: state.currentVersion, rollbackTo: target.version },
      key: record.key,
      configFingerprint: record.configFingerprint,
      catalogFingerprint: record.catalogFingerprint,
      bindings: target.bindings || {},
      verified: record.verified,
    })
    const next = { generation, key: record.key, digest: record.digest, state: nextState, verified: record.verified, record }
    persistAndSwapValidatedGeneration(state.currentVersion, next, {
      readState: () => store.readState(),
      commit: (rec) => store.commit(rec.record ? Object.assign({}, rec.record, { state: rec.state }) : rec),
    })
    return {
      catalogRef: {
        scope,
        generation,
        version: generation,
        key: record.key,
        digest: record.digest,
        sha256: record.digest,
        path: store.currentPath,
        versionPath: store.versionPath(nextState.current),
        mode: 'rollback',
        format: state.current.format || format,
      },
      version: generation,
      modelCount: catalog.models.length,
      diagnostics: [{
        code: 'catalog_rolled_back',
        severity: 'info',
        message: '整代替换回滚：内容取自 v' + target.version + '，以新世代 v' + generation + ' 发布',
        from: state.currentVersion,
        to: target.version,
        generation,
      }],
    }
  }

  function status(scopeRef) {
    const scope = scopeOf(scopeRef)
    const store = storeFor(scope)
    const state = store.readState()
    return { scope, state, current: state.current || null, root: store.root }
  }

  // 已发布目录的只读视图（GET /api/aggregation/models 用）。不触发发现或发布。
  function readCurrent(scopeRef) {
    const scope = scopeOf(scopeRef)
    const store = storeFor(scope)
    const state = store.readState()
    if (!state.current) return { scope, generation: 0, catalog: null, counts: null, path: store.currentPath }
    let catalog
    try {
      catalog = JSON.parse(store.readVersionText(state.current))
    } catch (error) {
      if (error instanceof AggregatedCatalogError) throw error
      throw new AggregatedCatalogError('catalog_current_unreadable', '当前已发布目录不可解析')
    }
    return { scope, generation: state.current.version, catalog, counts: state.current.counts || null, path: store.currentPath, bindings: state.current.bindings || {} }
  }

  return Object.freeze({ publish, rollback, status, readCurrent, limits })
}

let _defaultCatalog = null
export function configureAggregatedCatalog(options = {}) {
  _defaultCatalog = createAggregatedCatalog(options)
  return _defaultCatalog
}
export function getAggregatedCatalog() { return _defaultCatalog }
export async function publishAggregatedCatalog(scopeRef, opts) {
  if (!_defaultCatalog) throw new AggregatedCatalogError('catalog_not_configured', '聚合目录发布器未配置：先 configureAggregatedCatalog({ registry, cacheStore, dir })')
  return _defaultCatalog.publish(scopeRef, opts)
}
export function rollbackAggregatedCatalog(scopeRef, selector) {
  if (!_defaultCatalog) throw new AggregatedCatalogError('catalog_not_configured', '聚合目录发布器未配置')
  return _defaultCatalog.rollback(scopeRef, selector)
}
