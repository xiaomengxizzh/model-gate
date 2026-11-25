import { readFileSync } from 'node:fs'
import { resolveKey } from './router.js'
import { nativeUsageConfig } from './native-usage.js'
import { listConnections } from './resources/connections.js'

const packageInfo = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const PRIMARY_NAV = Object.freeze([
  { id: 'harness', label: '应用接入' },
  { id: 'services', label: '模型服务' },
  { id: 'pools', label: '模型池' },
  { id: 'usage', label: '用量分析' },
  { id: 'reliability', label: '稳定性策略' },
  { id: 'settings', label: '设置' },
])
const ADVANCED_NAV = Object.freeze([
  { id: 'models', label: '高级模型目录', route: '#/models' },
  { id: 'routing', label: '手动路由', route: '#/routing' },
  { id: 'clients', label: '客户端密钥', route: '#/clients' },
  { id: 'logs', label: '请求日志', route: '#/logs' },
])
const FEATURES = Object.freeze([
  { id: 'read-only-control-plane', available: true, stage: 'A2', evidence: 'source+http' },
  { id: 'provider-templates', available: false, stage: 'A3', evidence: 'static-catalog-only', reason: '模板尚未版本化为生产资源' },
  { id: 'service-lifecycle', available: true, stage: 'A3', evidence: 'source+http; create-edit-delete only', reason: '启停、模板授权与通用发现尚未实现' },
  { id: 'connection-lifecycle', available: true, stage: 'A3', evidence: 'source+http; independent-key-runtime', reason: 'OAuth/授权流程与真实额度校准未实现' },
  { id: 'model-lifecycle', available: true, stage: 'A3', evidence: 'source+http; create-update-delete only', reason: '通用发现、账户权限与目录迁移未实现' },
  { id: 'named-pools', available: true, stage: 'A4', evidence: 'source+http; virtualModels extension', reason: '双向应用引用与账户调度未实现' },
  { id: 'bidirectional-bindings', available: true, stage: 'A4/A5', evidence: 'source+http; desired-bindings-and-codex-role-targets', reason: '通用 Harness 实际应用仍依赖各自适配器' },
  { id: 'unified-request-budget', available: true, stage: 'A4', evidence: 'source+http; single-request-ledger', reason: '应用/池继承与真实流量校准仍待完成' },
  { id: 'effective-policy', available: true, stage: 'A4', evidence: 'source+http; scoped-inheritance', reason: '真实流量校准与全部 Harness 覆盖待完成' },
  { id: 'codex-three-modes', available: true, stage: 'A5', evidence: 'source; real-verification-blocked' },
  { id: 'native-compaction', available: true, stage: 'A5', evidence: 'protocol-boundary-only; real-verification-blocked' },
  { id: 'structured-usage', available: true, stage: 'A6', evidence: 'source+http; logical-attempt-token-summary', reason: '费用/额度与全部维度仍未知' },
  { id: 'structured-logs', available: true, stage: 'A6', evidence: 'source+http; redacted-text-and-event-projection', reason: '持久 trace 存储与完整保留期仍待实现' },
  { id: 'backup-restore', available: true, stage: 'A6', evidence: 'source+http; sanitized-file-store', reason: '通知中心与密钥重新授权流程未实现' },
  { id: 'harness-adapters', available: true, stage: 'A6', evidence: 'source+fixture; claude-opencode-dsh', reason: '真实客户端/协议未测；xmxz owner config 完整 schema/加载器缺失，保持 unsupported；写入需隔离 MG_HARNESS_ROOT' },
])

function safeBaseUrl(value) {
  try {
    const url = new URL(String(value || ''))
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return ''
  }
}

function healthOf(state, id, now) {
  const h = state.health && state.health[id]
  if (!h) return 'unknown'
  if (h.state === 'open' && h.openUntil <= now) return 'half'
  return h.state === 'open' || h.state === 'half' ? h.state : 'ok'
}

export function buildCapabilities(state, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now()
  const cfg = state.cfg || {}
  const providers = cfg.providers || {}
  const models = cfg.models || {}
  const services = Object.entries(providers).map(([id, p]) => {
    const key = resolveKey(cfg, p, id)
    return {
      id,
      serviceId: typeof p.serviceId === 'string' && p.serviceId ? p.serviceId : 'legacy:' + id,
      providerId: id,
      label: p.displayName || id,
      baseUrl: safeBaseUrl(p.baseUrl),
      api: p.api || 'openai',
      enabled: p.enabled !== false,
      credential: key.key ? 'configured' : key.source === 'absent' ? 'missing' : 'unknown',
      keySource: key.source || 'absent',
      health: healthOf(state, id, now),
      modelCount: Object.values(models).filter((m) => m && m.provider === id).length,
      connections: listConnections(cfg, id),
    }
  })
  const modelList = Object.entries(models).map(([name, m]) => ({
    name,
    label: name,
    serviceId: m.provider || '',
    api: m.api || (providers[m.provider] && providers[m.provider].api) || 'openai',
    capability: m.capability || 'chat',
    aliases: Array.isArray(m.alias) ? [...m.alias] : [],
    enabled: m.enabled !== false,
  }))
  const pools = (cfg.virtualModels || []).map((pool) => ({
    name: pool.name,
    label: pool.name,
    kind: 'legacy-virtual-model',
    candidateCount: Array.isArray(pool.directory) ? pool.directory.length : 0,
    candidates: Array.isArray(pool.directory) ? pool.directory.map((entry) => ({ model: entry.model, mode: entry.mode || 'afterAll', providers: Array.isArray(entry.providers) ? [...entry.providers] : [] })) : [],
    maxContext: Number(pool.maxContext) || 0,
    keySet: !!(cfg._keys && cfg._keys['__mg_vm_' + pool.name]),
    verification: 'configured',
  }))
  const native = nativeUsageConfig(cfg)
  return {
    contract: 'mg-capabilities/1',
    product: 'model-gateway',
    generatedAt: new Date(now).toISOString(),
    build: {
      packageVersion: packageInfo.version,
      node: opts.nodeVersion || process.version,
      commitSha: opts.commitSha === undefined ? (process.env.MG_BUILD_SHA || null) : opts.commitSha,
    },
    runtime: { configVersion: cfg.configVersion || 0, startedAt: state.st.startedAt, ...(cfg._tenancyScope ? { tenancy: { mode: 'multi', scopeId: cfg._tenancyScope } } : {}) },
    sections: PRIMARY_NAV.map((item) => ({
      id: item.id,
      label: item.label,
      route: '#/' + item.id,
      state: 'ready',
      endpoint: item.id === 'usage' ? '/api/model-stats' : '/api/capabilities',
      checkedAt: new Date(now).toISOString(),
    })),
    features: [...FEATURES.map((feature) => ({ ...feature })), ...(cfg._tenancyScope ? [{ id: 'single-instance-multi-tenancy', available: true, stage: 'MG-R009', evidence: 'source+http-fixture', reason: '按已认证 scope 隔离运行时；宿主级 Codex/聚合/Harness 管理未接入' }] : [])],
    navigation: {
      primary: PRIMARY_NAV.map((item) => ({ ...item })),
      advanced: ADVANCED_NAV.map((item) => ({ ...item })),
    },
    services,
    models: modelList,
    pools,
    usage: { gateway: 'available', native: cfg._tenancyScope ? 'disabled' : native.enabled ? 'enabled' : 'disabled' },
    reliability: {
      retry: { ...((cfg.defaults && cfg.defaults.retry) || {}) },
      timeout: { ...((cfg.defaults && cfg.defaults.timeout) || {}) },
      concurrency: { ...((cfg.defaults && cfg.defaults.concurrency) || {}) },
      codexFallbackLimits: { ...((cfg.defaults && cfg.defaults.codexFallbackLimits) || {}) },
      requestBudget: { ...((cfg.defaults && cfg.defaults.requestBudget) || {}) },
      lastRequest: state.lastRequestBudget || null,
      effectivePolicy: false,
    },
    aggregation: { supported: true, mode: 'unknown' },
    ui: {
      preview: true,
      defaultEntry: '/ui-vnext/',
      productionEntry: '/ui-vnext/',
      writeOperations: false,
      serviceWriteOperations: true,
      pollingMs: 15000,
    },
  }
}
