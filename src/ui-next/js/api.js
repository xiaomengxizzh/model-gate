// Same-origin management API client. Token lives in module memory only.
let token = ''
let unauthorizedHandler = null

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.data = data
    this.currentVersion = data && Number.isFinite(Number(data.currentVersion)) ? Number(data.currentVersion) : null
  }
}

export function setToken(value) { token = String(value || '').trim() }
export function getToken() { return token }
export function clearToken() { token = '' }
export function hasToken() { return !!token }
export function setUnauthorizedHandler(fn) { unauthorizedHandler = typeof fn === 'function' ? fn : null }

function errorMessage(data, status) {
  if (data && typeof data.error === 'string') return data.error
  if (data && data.error && typeof data.error.message === 'string') return data.error.message
  if (data && typeof data.message === 'string') return data.message
  return 'HTTP ' + status
}

export async function request(path, opts = {}) {
  const method = opts.method || 'GET'
  const headers = { accept: 'application/json' }
  if (token) headers.authorization = 'Bearer ' + token
  if (opts.body !== undefined) headers['content-type'] = 'application/json'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || 25000)
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
    clearTimeout(timer)
    if (e && e.name === 'AbortError') throw new ApiError('请求超时（25s），本地网关可能繁忙或不可达', 0, null)
    throw new ApiError('无法连接本地网关：' + (e && e.message ? e.message : '网络错误'), 0, null)
  }
  clearTimeout(timer)
  let data = null
  const type = res.headers.get('content-type') || ''
  try { data = type.includes('application/json') ? await res.json() : await res.text() } catch { data = null }
  if (res.status === 401 && opts.authEvent !== false) {
    if (unauthorizedHandler) unauthorizedHandler()
  }
  if (!res.ok) throw new ApiError(errorMessage(data, res.status), res.status, data)
  return data
}

export const api = {
  auth: () => request('/api/auth', { authEvent: false }),
  status: () => request('/api/status'),
  config: () => request('/api/config'),
  logs: (lines = 200) => request('/api/logs?lines=' + encodeURIComponent(lines)),
  modelStats: (days = 7) => request('/api/model-stats?days=' + encodeURIComponent(days)),
  routePreview: (model) => request('/api/route-preview', { method: 'POST', body: { model }, authEvent: false }),
  saveConfig: (body) => request('/api/config/save', { method: 'POST', body }),
  reloadConfig: () => request('/api/config/reload', { method: 'POST', body: {} }),
  saveKey: (body) => request('/api/keys', { method: 'POST', body }),
  probe: (id) => request('/api/probe', { method: 'POST', body: id ? { id } : {} }),
  modelTest: (id) => request('/api/model-test', { method: 'POST', body: id ? { id } : {} }),
  setAdminToken: (value) => request('/api/admin-token', { method: 'POST', body: { token: value } }),
}
