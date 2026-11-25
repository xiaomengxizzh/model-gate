export class ApiError extends Error {
  constructor(message, status, data, aborted = false) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.data = data
    this.aborted = aborted
  }
}

export async function request(path, opts = {}) {
  const controller = new AbortController()
  const external = opts.signal
  let timedOut = false
  let cancelled = false
  const onAbort = () => { cancelled = true; controller.abort() }
  if (external) {
    if (external.aborted) throw new ApiError('请求已取消', 0, null, true)
    external.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, opts.timeoutMs || 12000)
  try {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: { accept: 'application/json' },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller.signal,
    })
    const type = res.headers.get('content-type') || ''
    const data = type.includes('application/json') ? await res.json() : await res.text()
    if (!res.ok) {
      const message = data && typeof data.error === 'string' ? data.error : 'HTTP ' + res.status
      throw new ApiError(message, res.status, data)
    }
    return data
  } catch (error) {
    if (cancelled || (external && external.aborted)) throw new ApiError('请求已取消', 0, null, true)
    if (error instanceof ApiError) throw error
    if (timedOut) throw new ApiError('请求超时，本地网关可能繁忙或不可达', 0, null)
    throw new ApiError('无法连接本地网关，请确认隔离实例正在运行', 0, null)
  } finally {
    clearTimeout(timer)
    if (external) external.removeEventListener('abort', onAbort)
  }
}

export const api = {
  capabilities: (opts) => request('/api/capabilities', opts),
  aggregationHealth: (opts) => request('/api/aggregation/health', opts),
  modelStats: (days = 7, opts) => request('/api/model-stats?days=' + encodeURIComponent(days), opts),
  usageSummary: (days = 7, opts) => request('/api/usage/summary?days=' + encodeURIComponent(days), opts),
  structuredLogs: (query = '') => request('/api/logs/structured?' + query),
  nativeUsage: (days = 7, opts) => request('/api/native-usage?days=' + encodeURIComponent(days), opts),
  routePreview: (model, opts) => request('/api/route-preview', { ...opts, method: 'POST', body: { model } }),
  services: (opts) => request('/api/services', opts),
  configPreview: (body, opts) => request('/api/config/preview', { ...opts, method: 'POST', body }),
  createService: (body) => request('/api/services', { method: 'POST', body }),
  updateService: (id, body) => request('/api/services/' + encodeURIComponent(id), { method: 'PATCH', body }),
  deleteService: (id, body) => request('/api/services/' + encodeURIComponent(id), { method: 'DELETE', body }),
  saveKey: (body) => request('/api/keys', { method: 'POST', body }),
  writePreview: (body) => request('/api/config/write:preview', { method: 'POST', body }),
  providerTemplates: (query = '') => request('/api/provider-templates?' + query),
  models: (opts) => request('/api/models', opts),
  discoverModels: (providerId, connectionId) => request('/api/connections/' + encodeURIComponent(providerId) + '/' + encodeURIComponent(connectionId) + '/discover', { method: 'POST', body: {} }),
  pools: (opts) => request('/api/pools', opts),
  createModel: (body) => request('/api/models', { method: 'POST', body }),
  updateModel: (id, body) => request('/api/models/' + encodeURIComponent(id), { method: 'PATCH', body }),
  deleteModel: (id, body) => request('/api/models/' + encodeURIComponent(id), { method: 'DELETE', body }),
  createPool: (body) => request('/api/pools', { method: 'POST', body }),
  updatePool: (id, body) => request('/api/pools/' + encodeURIComponent(id), { method: 'PATCH', body }),
  deletePool: (id, body) => request('/api/pools/' + encodeURIComponent(id), { method: 'DELETE', body }),
  backups: (opts) => request('/api/config/backups', opts),
  backup: (id) => request('/api/config/backups/' + encodeURIComponent(id)),
  createBackup: () => request('/api/config/backups', { method: 'POST', body: {} }),
  importPreview: (body) => request('/api/config/import:preview', { method: 'POST', body }),
  importApply: (body) => request('/api/config/import:apply', { method: 'POST', body }),
  createConnection: (body) => request('/api/connections', { method: 'POST', body }),
  updateConnection: (id, body) => request('/api/connections/' + encodeURIComponent(id), { method: 'PATCH', body }),
  deleteConnection: (id, body) => request('/api/connections/' + encodeURIComponent(id), { method: 'DELETE', body }),
  switchAggregation: (body) => request('/api/aggregation/switch', { method: 'POST', body }),
  rollbackAggregation: (body) => request('/api/aggregation/rollback', { method: 'POST', body }),
  effectivePolicy: (query = '') => request('/api/policies/effective' + query),
  savePolicy: (body) => request('/api/policies', { method: 'POST', body }),
  harnesses: () => request('/api/harnesses'),
  harnessPreview: (body) => request('/api/harnesses/preview', { method: 'POST', body }),
  harnessApply: (body) => request('/api/harnesses/apply', { method: 'POST', body }),
  harnessRollback: (body) => request('/api/harnesses/rollback', { method: 'POST', body }),
  bindings: (opts) => request('/api/harness-bindings', opts),
  createBinding: (body) => request('/api/harness-bindings', { method: 'POST', body }),
  updateBinding: (id, body) => request('/api/harness-bindings/' + encodeURIComponent(id), { method: 'PATCH', body }),
  deleteBinding: (id, body) => request('/api/harness-bindings/' + encodeURIComponent(id), { method: 'DELETE', body }),
}
