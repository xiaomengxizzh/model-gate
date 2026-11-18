// Same-origin management API client. 管理面无令牌：同源请求直接放行，来源防护由网关的 Host/Origin + 回环绑定负责。
let unauthorizedHandler = null

export class ApiError extends Error {
  constructor(message, status, data, aborted = false) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.data = data
    // 外部取消（AbortController）不是 401，也不是超时：调用方据此丢弃旧响应。
    this.aborted = !!aborted
    this.currentVersion = data && Number.isFinite(Number(data.currentVersion)) ? Number(data.currentVersion) : null
  }
}

export function setUnauthorizedHandler(fn) { unauthorizedHandler = typeof fn === 'function' ? fn : null }

function errorMessage(data, status) {
  if (data && typeof data.error === 'string') return data.error
  if (data && data.error && typeof data.error.message === 'string') return data.error.message
  if (data && typeof data.message === 'string') return data.message
  return 'HTTP ' + status
}

function abortedError() {
  return new ApiError('请求已取消', 0, null, true)
}

export async function request(path, opts = {}) {
  const method = opts.method || 'GET'
  const headers = { accept: 'application/json' }
  if (opts.body !== undefined) headers['content-type'] = 'application/json'
  // 外部 signal（store 的 epoch 取消）与内部 25s 超时共用同一个底层 controller；
  // 两者必须区分：外部取消标记 aborted，绝不触发 unauthorizedHandler。
  const external = opts.signal && typeof opts.signal.addEventListener === 'function' ? opts.signal : null
  if (external && external.aborted) throw abortedError()
  const controller = new AbortController()
  let timedOut = false
  let cancelled = false
  const onExternalAbort = () => { cancelled = true; controller.abort() }
  if (external) external.addEventListener('abort', onExternalAbort, { once: true })
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, opts.timeoutMs || 25000)
  let res
  try {
    res = await fetch(path, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller.signal,
    })
  } catch (e) {
    if (cancelled || (external && external.aborted)) throw abortedError()
    if (timedOut || (e && e.name === 'AbortError')) throw new ApiError('请求超时（25s），本地网关可能繁忙或不可达', 0, null)
    throw new ApiError('无法连接本地网关：' + (e && e.message ? e.message : '网络错误'), 0, null)
  } finally {
    clearTimeout(timer)
    if (external) external.removeEventListener('abort', onExternalAbort)
  }
  let data = null
  const type = res.headers.get('content-type') || ''
  try { data = type.includes('application/json') ? await res.json() : await res.text() } catch { data = null }
  // 管理面已无令牌：正常路径不会再返回 401。这里保留通用兜底，供未来任何 401 统一收口（如清快照）。
  // 功能级 403（write_disabled / aggregation_loopback_required 等）必须抛给调用方，
  // 由对应视图/卡片进入局部 error 态；绝不清其它视图数据、不跳登录。
  if (res.status === 401 && opts.authEvent !== false) {
    if (unauthorizedHandler) unauthorizedHandler({ status: res.status, path })
  }
  if (!res.ok) throw new ApiError(errorMessage(data, res.status), res.status, data)
  return data
}

function aggregationPath(id, suffix) {
  return '/api/aggregation/providers/' + encodeURIComponent(String(id || '')) + (suffix || '')
}

export const api = {
  auth: (opts = {}) => request('/api/auth', Object.assign({ authEvent: false }, opts)),
  status: (opts = {}) => request('/api/status', opts),
  config: (opts = {}) => request('/api/config', opts),
  logs: (lines = 200) => request('/api/logs?lines=' + encodeURIComponent(lines)),
  modelStats: (days = 7) => request('/api/model-stats?days=' + encodeURIComponent(days)),
  nativeUsage: (days = 7) => request('/api/native-usage?days=' + encodeURIComponent(days)),
  routePreview: (model) => request('/api/route-preview', { method: 'POST', body: { model }, authEvent: false }),
  saveConfig: (body) => request('/api/config/save', { method: 'POST', body }),
  reloadConfig: () => request('/api/config/reload', { method: 'POST', body: {} }),
  saveKey: (body) => request('/api/keys', { method: 'POST', body }),
  probe: (id) => request('/api/probe', { method: 'POST', body: id ? { id } : {} }),
  modelTest: (id) => request('/api/model-test', { method: 'POST', body: id ? { id } : {} }),
  reconcileAggregation: (body) => request('/api/aggregation/reconcile', { method: 'POST', body: body === undefined ? {} : body }),

  // —— 聚合管理只读快照（首页/连接页/聚合页共用，见契约 §5）——
  aggregationHealth: (opts = {}) => request('/api/aggregation/health', opts),
  aggregationModes: (opts = {}) => request('/api/aggregation/modes', opts),
  aggregationProviders: (opts = {}) => request('/api/aggregation/providers', opts),
  aggregationModels: (opts = {}) => request('/api/aggregation/models', opts),
  aggregationDiagnostics: (opts = {}) => request('/api/aggregation/diagnostics', opts),

  // —— 聚合写操作（仍走现有管理 API；Key 只经 POST /api/keys，不进存储）——
  addAggregationProvider: (body) => request('/api/aggregation/providers', { method: 'POST', body: body === undefined ? {} : body }),
  syncAggregationProvider: (id) => request(aggregationPath(id, '/sync'), { method: 'POST', body: {} }),
  removeAggregationProvider: (id, body) => request(aggregationPath(id), { method: 'DELETE', body: body === undefined ? {} : body }),
  activateAggregation: (body) => request('/api/aggregation/activate', { method: 'POST', body: body === undefined ? {} : body }),
  deactivateAggregation: (body) => request('/api/aggregation/deactivate', { method: 'POST', body: body === undefined ? {} : body }),
  // 漂移解漂：只更新 state 基线，不写 config.toml；428 预览 → 确认后提交。
  reconcileAggregation: (body) => request('/api/aggregation/reconcile', { method: 'POST', body: body === undefined ? {} : body }),
}
