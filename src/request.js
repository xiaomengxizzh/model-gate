import http from 'node:http'
import https from 'node:https'
import { URL } from 'node:url'
import { gunzipSync } from 'node:zlib'

// 上游连接复用（keep-alive）：减少每次 TLS/TCP 握手，改善连接体验与延迟
const HTTP_AGENT = new http.Agent({ keepAlive: true, maxSockets: 64 })
const HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 64 })
function agentFor(provider) { return /^https:/i.test(provider.baseUrl) ? HTTPS_AGENT : HTTP_AGENT }

const RETRYABLE_HTTP = new Set([408, 409, 425, 429, 500, 502, 503, 504])
function isRetryableCode(c) { return RETRYABLE_HTTP.has(c) }

const NET_ERR_CODES = [ 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ECONNABORTED', 'UND_ERR_SOCKET' ]
function isRetryableNetErr(err) {
  const c = err && err.code
  return !c || NET_ERR_CODES.includes(c)
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

function parseRetryAfter(headers) {
  const ra = headers && (headers['retry-after'])
  if (ra == null) return null
  const n = parseInt(String(ra), 10)
  if (!isNaN(n) && n >= 0) return n * 1000
  const dt = Date.parse(String(ra))
  if (!isNaN(dt)) return Math.max(0, dt - Date.now())
  return null
}

// 单次转发（全双工，流式）。resolve: 收到上游响应头即返回 stream
function single(provider, url, method, headers, bodyBuf, timeout) {
  return new Promise((resolve, reject) => {
    const isHttps = provider.baseUrl.startsWith('https://')
    const mod = isHttps ? https : http
    const reqOpts = {
      method, hostname: url.hostname, port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search, headers, agent: isHttps ? HTTPS_AGENT : HTTP_AGENT,
    }
    let settled = false
    const req = mod.request(reqOpts, (res) => {
      settled = true
      clearTimeout(firstByteTimer)
      resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, headers: res.headers, stream: res, retryAfter: parseRetryAfter(res.headers) })
    })
    const firstByteTimer = setTimeout(() => req.destroy(new Error('first-byte timeout')), timeout.firstByteMs)
    req.setTimeout(timeout.connectMs, () => req.destroy(Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' })))
    req.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(firstByteTimer)
      reject(err)
    })
    if (bodyBuf && bodyBuf.length) req.write(bodyBuf)
    req.end()
  })
}

async function settle(attempt, cfg, last) {
  const ra = last && last.retryAfter
  if (ra != null) await sleep(ra + Math.random() * 40)
  else {
    const base = Math.min(cfg.maxDelayMs, cfg.initialDelayMs * Math.pow(2, attempt - 1))
    await sleep(base + base * (cfg.jitter || 0) * Math.random())
  }
}

/**
 * 转发 + 指数退避重试。契约（供外层 fallback/熔断）：
 *  - resolve { ok:true }         → 2xx，可直接透传
 *  - resolve { ok:false }        → 非重试错误码（业务 4xx）：外层直接返回、不熔断、不 fallback
 *  - reject(err)                 → 网络错或 5xx/429 重试耗尽：视为 provider 不可用（err.status 表示状态码）
 * 重试次数附在结果/错误 .retries。
 */
export async function forward(provider, path, method, headers, bodyBuf, opts = {}, log) {
  const url = new URL(provider.baseUrl + (provider.pathPrefix || '') + path)
  const retry = Object.assign({ maxAttempts: 1, initialDelayMs: 500, maxDelayMs: 8000, jitter: 0.2 }, opts.retry)
  const timeout = Object.assign({ connectMs: 10000, firstByteMs: 60000 }, opts.timeout)
  const overallMs = timeout.overallMs || 0
  const t0 = Date.now()

  let last
  for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
    if (overallMs && Date.now() - t0 > overallMs) { const e = new Error('overall timeout (' + overallMs + 'ms)'); e.status = 408; e.retries = attempt - 1; e.providerFail = true; throw e }
    try {
      const result = await single(provider, url, method, headers, bodyBuf, timeout)
      if (result.ok || !isRetryableCode(result.status)) { result.retries = attempt - 1; return result }
      last = result
      log && log.warn('upstream retryable status', result.status, 'attempt', attempt, '/', retry.maxAttempts)
    } catch (err) {
      last = err
      if (!isRetryableNetErr(err)) throw err            // 非网络类致命错，直接抛
      if (attempt >= retry.maxAttempts) throw err        // 重试耗尽 → provider 失败
      log && log.warn('upstream error', err.code || err.message, 'attempt', attempt, '/', retry.maxAttempts)
    }
    if (attempt < retry.maxAttempts) await settle(attempt, retry, last)
  }
  // 可重试状态码耗尽 → 抛 provider 失败
  const fail = new Error('upstream failed: ' + (last && last.status))
  fail.status = last.status
  fail.retries = retry.maxAttempts - 1
  fail.retryAfter = (last && last.retryAfter) || null
  fail.providerFail = true
  throw fail
}

// 探测上游可用性（在线检活）：GET {base}{prefix}/v1/models，单次不重试
export function probe(provider) {
  const isHttps = provider.baseUrl.startsWith('https://')
  const mod = isHttps ? https : http
  const url = new URL(provider.baseUrl + (provider.pathPrefix || '') + '/v1/models')
  return new Promise((resolve) => {
    const headers = { 'user-agent': 'model-gateway/0.1', accept: 'application/json' }
    if (provider.apiKey) headers.authorization = 'Bearer ' + provider.apiKey
    const started = Date.now()
    const req = mod.request({
      method: 'GET', hostname: url.hostname, port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search, headers, agent: isHttps ? HTTPS_AGENT : HTTP_AGENT,
    }, (res) => {
      res.resume()
      // 检活语义=可达性：只要拿到 HTTP 响应（含 4xx/5xx）即视为"通"，避免把慢/401 误判为不通；
      // 只有超时/拒连/DNS 失败才算不通。code 保留给界面展示实际状态码。
      resolve({ ok: true, code: res.statusCode, ms: Date.now() - started })
    })
    req.setTimeout(20000, () => req.destroy(Object.assign(new Error('probe timeout'), { code: 'ETIMEDOUT' })))
    req.on('error', (err) => resolve({ ok: false, code: null, ms: Date.now() - started, err: err.code || err.message }))
    req.end()
  })
}

// 缓存预热：向模型上游发送一个携带长 system 前缀的最小请求（max_tokens=1），保持厂商侧 prefix cache 存活。
// 在「预热」语义下只关心能否成功送达（拿到 2xx 响应头），不读响应体、不累计额度，避免污染配额统计。
export function warm(provider, model, systemPrompt, opts = {}, log) {
  const isHttps = provider.baseUrl.startsWith('https://')
  const mod = isHttps ? https : http
  const url = new URL(provider.baseUrl + (provider.pathPrefix || '') + '/v1/chat/completions')
  const headers = { 'content-type': 'application/json', 'user-agent': 'model-gateway/0.1', accept: 'application/json' }
  if (provider.apiKey) headers.authorization = 'Bearer ' + provider.apiKey
  const payload = Buffer.from(JSON.stringify({ model: model, messages: [{ role: 'system', content: systemPrompt }], max_tokens: 1, stream: false }))
  headers['content-length'] = payload.length
  const to = Object.assign({ connectMs: 10000, firstByteMs: 60000 }, (opts && opts.timeout) || {})
  const started = Date.now()
  return new Promise((resolve) => {
    const req = mod.request({ method: 'POST', hostname: url.hostname, port: url.port || (isHttps ? 443 : 80), path: url.pathname + url.search, headers, agent: isHttps ? HTTPS_AGENT : HTTP_AGENT }, (res) => {
      res.resume(); res.destroy() // 只需状态码，立即释放，不读响应
      const ok = res.statusCode >= 200 && res.statusCode < 300
      if (!ok && log) log.warn('preheat status', res.statusCode)
      resolve({ ok, status: res.statusCode, ms: Date.now() - started })
    })
    req.setTimeout(to.connectMs, () => req.destroy(Object.assign(new Error('preheat timeout'), { code: 'ETIMEDOUT' })))
    req.on('error', (err) => resolve({ ok: false, status: null, ms: Date.now() - started, err: err.code || err.message }))
    req.write(payload)
    req.end()
  })
}

// 模型连通测试：向该模型所属上游发一个极小量的真实 chat 请求（max_tokens=1），验证"这个模型名能真正被调用"
// 返回 { ok, code, ms, err, body }，body 为响应首片段用于展示后端告警。
export function probeModel(provider, model) {
  const isHttps = provider.baseUrl.startsWith('https://')
  const mod = isHttps ? https : http
  const url = new URL(provider.baseUrl + (provider.pathPrefix || '') + '/v1/chat/completions')
  const headers = { 'content-type': 'application/json', 'user-agent': 'model-gateway/0.1', accept: 'application/json', 'accept-encoding': 'identity' }
  if (provider.apiKey) headers.authorization = 'Bearer ' + provider.apiKey
  const payload = Buffer.from(JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }))
  headers['content-length'] = payload.length
  return new Promise((resolve) => {
    const started = Date.now()
    const req = mod.request({ method: 'POST', hostname: url.hostname, port: url.port || (isHttps ? 443 : 80), path: url.pathname + url.search, headers }, (res) => {
      res.setTimeout(20000, () => res.destroy())
      const c = []
      res.on('data', (d) => c.push(d))
      res.on('end', () => {
        const raw = Buffer.concat(c)
        // 兼容上游缺 content-encoding 头但仍返回 gzip：按魔数 1f 8b 尝试解压，避免 JSON 解析/统计断链
        const buf = (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) ? (() => { try { return gunzipSync(raw) } catch { return raw } })() : raw
        const text = buf.toString('utf8').trim()
        const ok = res.statusCode >= 200 && res.statusCode < 300
        resolve({ ok, code: res.statusCode, ms: Date.now() - started, err: ok ? null : (text.slice(0, 120) || ('HTTP ' + res.statusCode)) })
      })
    })
    // 90s：思考型模型（如 stealth/ox-alpha）响应 5s~90s+ 波动，且上游代理内部重试期间不发字节；30s 会把可用模型误报成 ETIMEDOUT
    req.setTimeout(90000, () => req.destroy(Object.assign(new Error('probe timeout'), { code: 'ETIMEDOUT' })))
    req.on('error', (err) => resolve({ ok: false, code: null, ms: Date.now() - started, err: err.code || err.message }))
    req.write(payload)
    req.end()
  })
}