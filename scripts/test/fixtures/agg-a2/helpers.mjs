// A2 离线夹具辅助：只读 JSON fixture + 合成 provider 记录 + 隔离注册表存储。
// 不联网、不读宿主凭据；所有 provider 的 keyRef 都是环境变量名，测试从不设置真实值。
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FIXTURE_DIR = fileURLToPath(new URL('.', import.meta.url))

export function readFixture(name) {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8'))
}

export function consoleProvider(overrides = {}) {
  return Object.assign({
    id: 'console',
    kind: 'opencode-console',
    providerSegment: 'console',
    name: 'OpenCode Console',
    baseUrl: 'https://opencode.ai/console/v1',
    api: 'openai',
    pathPrefix: '',
    apiKeyEnv: 'TEST_AGG_OPENCODE_KEY',
    keyRef: 'env:TEST_AGG_OPENCODE_KEY',
    modelListUrl: null,
    pagination: { style: 'auto' },
    enabled: true,
  }, overrides)
}

export function goProvider(overrides = {}) {
  return Object.assign({
    id: 'opencodego',
    kind: 'opencode-go',
    providerSegment: 'opencodego',
    name: 'OpenCode Go',
    baseUrl: 'https://opencode.ai/inference/go/openai/v1',
    api: 'openai',
    pathPrefix: '',
    apiKeyEnv: 'TEST_AGG_OPENCODE_KEY',
    keyRef: 'env:TEST_AGG_OPENCODE_KEY',
    modelListUrl: null,
    pagination: { style: 'auto' },
    enabled: true,
  }, overrides)
}

export function jsonResponse(body, options = {}) {
  const headers = Object.assign({ 'content-type': 'application/json' }, options.headers || {})
  if (options.status === 304) return new Response(null, { status: 304, headers })
  return new Response(JSON.stringify(body), { status: options.status || 200, headers })
}

export function textResponse(text, options = {}) {
  return new Response(String(text), { status: options.status || 200, headers: options.headers || {} })
}

// 隔离的 gateway 配置目录：gateway.json 是基线，gateway.local.json 由注册表写入。
// readConfig 模拟 loadConfig 的 merge 语义（不做 keys 解密）。
export function makeRegistryStore() {
  const dir = mkdtempSync(join(tmpdir(), 'mg-agg-registry-'))
  const gatewayPath = join(dir, 'gateway.json')
  const localPath = join(dir, 'gateway.local.json')
  writeFileSync(gatewayPath, JSON.stringify({ providers: {}, models: {}, defaults: {}, virtualModels: [] }))
  const paths = {
    dir,
    local: localPath,
    keys: join(dir, 'keys.local.json'),
    stats: join(dir, 'stats.json'),
    videos: join(dir, 'videos.json'),
  }
  const readConfig = () => {
    const base = JSON.parse(readFileSync(gatewayPath, 'utf8'))
    let local = {}
    try { local = JSON.parse(readFileSync(localPath, 'utf8')) } catch { local = {} }
    return Object.assign({}, base, {
      providers: Object.assign({}, base.providers || {}, local.providers || {}),
      models: Object.assign({}, base.models || {}, local.models || {}),
      defaults: Object.assign({}, base.defaults || {}, local.defaults || {}),
      virtualModels: local.virtualModels !== undefined ? local.virtualModels : (base.virtualModels || []),
      configVersion: Number(local.configVersion) || 0,
    })
  }
  const readLocal = () => JSON.parse(readFileSync(localPath, 'utf8'))
  return { dir, paths, readConfig, readLocal, gatewayPath, localPath }
}

export function tempDir(prefix = 'mg-agg-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  mkdirSync(dir, { recursive: true })
  return dir
}

// 从 fixture 构造一个“完整发现快照”，用于只测目录投影的用例。
export function snapshotOf(provider, models, options = {}) {
  return {
    schema: 'modelgate.aggregation.snapshot/1',
    providerId: provider.id,
    providerKind: provider.kind,
    providerSegment: provider.providerSegment,
    scope: options.scope || 'local',
    endpoint: { host: 'opencode.ai', path: '/console/v1/models', assumed: true, basis: 'test_fixture' },
    observedAt: options.observedAt || '2026-11-14T00:00:00.000Z',
    validatedAt: options.observedAt || '2026-11-14T00:00:00.000Z',
    freshness: 'fresh',
    completeness: options.complete === false ? 'discovery_partial' : 'discovery_complete',
    complete: options.complete !== false,
    emptyConfirmed: options.emptyConfirmed === true,
    models: models.map((m) => Object.assign({
      publicId: null,
      providerId: provider.id,
      displayName: m.upstreamId,
      contextWindow: 128000,
      capabilities: { tools: false, supportsSearchTool: false, supportsWebsockets: false },
      authorized: true,
      authBasis: 'listed',
      evidence: { source: 'test_fixture', observedAt: '2026-11-14' },
    }, m)),
    counts: { discovered: models.length, unique: models.length, authorized: models.filter((m) => m.authorized !== false).length, unauthorized: models.filter((m) => m.authorized === false).length, duplicates: 0, aliases: 0 },
  }
}

export function cacheEntry(snapshot, options = {}) {
  return {
    schema: 'modelgate.aggregation.discovery-cache/1',
    storedAt: options.storedAt || Date.parse('2026-11-14T00:00:00.000Z'),
    etag: options.etag || null,
    lastModified: options.lastModified || null,
    snapshot,
  }
}
