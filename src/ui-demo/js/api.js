export class ApiError extends Error {
  constructor (message, status, data) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.data = data
  }
}

export function errorMessage (data, status) {
  if (data && typeof data.error === 'string') return data.error
  if (data && data.error && typeof data.error.message === 'string') return data.error.message
  if (data && typeof data.message === 'string') return data.message
  if (data && data.code) return String(data.code)
  return 'HTTP ' + status
}

export async function request (path, opts = {}) {
  const method = opts.method || 'GET'
  const timeoutMs = opts.timeoutMs || (method === 'GET' ? 8000 : 20000)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const headers = { accept: 'application/json' }
    if (opts.body !== undefined) headers['content-type'] = 'application/json'
    const res = await fetch(path, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      cache: 'no-store',
      credentials: 'same-origin',
      signal: ctrl.signal,
    })
    const text = await res.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = text }
    return { ok: res.ok, status: res.status, data }
  } catch (e) {
    if (e && e.name === 'AbortError') throw new ApiError('请求超时（' + Math.round(timeoutMs / 1000) + 's）', 0, null)
    throw new ApiError('无法连接本地网关：' + ((e && e.message) || '网络错误'), 0, null)
  } finally {
    clearTimeout(timer)
  }
}

export async function getJson (path, opts = {}) {
  const r = await request(path, opts)
  if (!r.ok) throw new ApiError(errorMessage(r.data, r.status), r.status, r.data)
  return r.data
}

export async function postRaw (path, body, opts = {}) {
  return request(path, Object.assign({}, opts, { method: 'POST', body: body === undefined ? {} : body }))
}
