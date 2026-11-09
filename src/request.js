import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { URL } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { adapterFor, embeddingAdapterFor } from './format.js'
import { abortedError, sleepWith } from './budget.js'
import { classify429, parseRetryAfterMs, retryWaitCap, MAX_ERR_BODY_BYTES } from './retry-policy.js'

// 上游连接复用（keep-alive）：减少每次 TLS/TCP 握手，改善连接体验与延迟
const HTTP_AGENT = new http.Agent({ keepAlive: true, maxSockets: 64 })
const HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 64 })
function agentFor(provider) { return /^https:/i.test(provider.baseUrl) ? HTTPS_AGENT : HTTP_AGENT }
function applyProviderHeaders(headers, provider) {
  for (const [name, value] of Object.entries((provider && provider.extraHeaders) || {})) {
    if (value != null && value !== '') headers[String(name).toLowerCase()] = String(value)
  }
  // OpenCode Go requires the OpenCode-specific session header. Older gateway
  // configs used x-session-id; keep accepting it as the configured fallback.
  if (provider && provider.id === 'opencodego' && !headers['x-opencode-session']) {
    headers['x-opencode-session'] = headers['x-session-id'] || 'mg-opencodego-bridge'
  }
  return headers
}
// 协议鉴权头（探测/预热/failback/模型测试共用）：Anthropic 认 x-api-key + anthropic-version，
// Gemini 认 x-goog-api-key，其余走 Bearer。与 forward.js buildHeaders 的协议头规则保持一致。
export function protocolHeaders(headers, provider, api) {
  if (provider.apiKey) headers.authorization = 'Bearer ' + provider.apiKey
  if (api === 'anthropic') {
    if (!headers['anthropic-version']) headers['anthropic-version'] = '2023-06-01'
    if (provider.apiKey && !headers['x-api-key']) headers['x-api-key'] = provider.apiKey
  } else if (api === 'gemini') {
    if (provider.apiKey && !headers['x-goog-api-key']) headers['x-goog-api-key'] = provider.apiKey
  }
  return headers
}
// 按协议整形最小请求：api 非 openai 时用适配器生成 path/body（模型名与字段跟着协议走）。
export function protocolRequest(api, openaiBody) {
  const adapter = adapterFor(api)
  return adapter ? adapter.build(openaiBody) : { path: '/v1/chat/completions', body: openaiBody }
}

// ---------- 上游 HTTP 代理（CONNECT 隧道，零第三方依赖） ----------
// provider.proxy 形如 http://user:pass@host:port。仅用于非回环上游（本地 3050/9877 等自动直连）。
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0'])
function normalizeProxy(proxy) {
  if (proxy && typeof proxy === 'object') return { host: proxy.host, port: Number(proxy.port) || 7890, auth: proxy.auth || null }
  if (typeof proxy === 'string' && proxy) {
    try {
      const u = new URL(proxy)
      if (!u.hostname) return null
      return { host: u.hostname, port: Number(u.port) || 7890, auth: (u.username ? 'Basic ' + Buffer.from(decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password || '')).toString('base64') : null) }
    } catch { return null }
  }
  return null
}
// 经代理打开一条到目标:端口的 TLS 隧道（HTTP CONNECT）。
// MG-002：CONNECT 阶段此前无任何超时，代理接受 TCP 但不应答 CONNECT 会永久挂起，
// 连请求级 deadline 都兜不住（预算在 request 生命周期之外）。这里接受 signal + 墙钟超时。
function connectViaProxy(targetHost, targetPort, p, opts = {}) {
  return new Promise((resolve, reject) => {
    const signal = opts.signal || null
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 0
    const raw = net.connect(p.port, p.host)
    let settled = false
    let timer = null
    const onAbort = () => fail(abortedError((opts.budget && opts.budget.reason) || 'request_timeout', 'proxy CONNECT aborted'))
    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null }
      if (signal && onAbort) { try { signal.removeEventListener('abort', onAbort) } catch { } }
    }
    const fail = (e) => { if (settled) return; settled = true; cleanup(); try { raw.destroy() } catch { } ; reject(e) }
    if (signal) {
      if (signal.aborted) { fail(abortedError('request_timeout', 'proxy CONNECT aborted')); return }
      try { signal.addEventListener('abort', onAbort, { once: true }) } catch { }
    }
    if (timeoutMs) timer = setTimeout(() => fail(Object.assign(new Error('proxy CONNECT timeout (' + timeoutMs + 'ms)'), { code: 'ETIMEDOUT', status: 504 })), timeoutMs)
    raw.on('error', (e) => fail(new Error('proxy error: ' + (e && e.message))))
    raw.once('connect', () => {
      let r = 'CONNECT ' + targetHost + ':' + targetPort + ' HTTP/1.1\r\nHost: ' + targetHost + ':' + targetPort + '\r\n'
      if (p.auth) r += 'Proxy-Authorization: ' + p.auth + '\r\n'
      r += '\r\n'
      raw.write(r)
    })
    let buf = Buffer.alloc(0)
    raw.on('data', (d) => {
      if (settled) return
      buf = Buffer.concat([buf, d])
      const idx = buf.indexOf('\r\n\r\n'); if (idx === -1) return
      raw.removeAllListeners('data')
      const line = buf.slice(0, idx).toString('utf8').split('\r\n')[0]
      const code = parseInt(line.split(' ')[1] || '', 10)
      if (code !== 200) { fail(new Error('proxy CONNECT failed: ' + line)); return }
      const tlsSock = tls.connect({ socket: raw, servername: targetHost })
      tlsSock.once('secureConnect', () => { if (settled) { try { tlsSock.destroy() } catch { } ; return } settled = true; cleanup(); resolve(tlsSock) })
      tlsSock.on('error', (e) => fail(e))
    })
  })
}
const PROXY_CACHE = new Map()
function proxyAgentFor(proxy) {
  const p = normalizeProxy(proxy); if (!p) return null
  const key = JSON.stringify(p)
  let e = PROXY_CACHE.get(key); if (e) return e
  const make = (isHttps) => {
    const Base = isHttps ? https.Agent : http.Agent
    const ag = new Base({ keepAlive: true, maxSockets: 64 })
    if (isHttps) ag.createConnection = (options, cb) => {
      // 每请求的取消/预算上下文通过自定义请求选项传入（Node 会把 reqOpts 透传给 createConnection）。
      const ctl = options._mgCtl || {}
      const remaining = ctl.budget ? ctl.budget.remaining() : Infinity
      const capMs = Number(ctl.connectMs) > 0 ? Number(ctl.connectMs) : 0
      const timeoutMs = Number.isFinite(remaining) ? (capMs > 0 ? Math.min(capMs, remaining) : remaining) : capMs
      connectViaProxy(options.host, Number(options.port) || 443, p, { signal: ctl.signal, timeoutMs, budget: ctl.budget }).then((s) => cb(null, s), (er) => cb(er))
    }
    return ag
  }
  e = { host: p.host, port: p.port, https: make(true), http: make(false) }
  PROXY_CACHE.set(key, e)
  return e
}
// 统一构建请求上下文：按是否回环 + 是否配置代理，决定直连还是走代理。
//  - https 目标经代理：CONNECT 隧道（origin-form 路径 + 保持目标 host 供 SNI/Host）
//  - http 目标经代理：absolute-form（path 为完整 URL + 注入 Host 头）
function ctxFor(provider, url, method, headers, ctl) {
  const isHttps = url.protocol === 'https:'
  const mod = isHttps ? https : http
  const proxy = (provider && provider.proxy && !LOOPBACK.has(url.hostname)) ? proxyAgentFor(provider.proxy) : null
  if (proxy) {
    if (isHttps) return { mod, reqOpts: { method, hostname: url.hostname, port: url.port || 443, path: url.pathname + url.search, headers, agent: proxy.https, _mgCtl: ctl } }
    return { mod, reqOpts: { method, hostname: proxy.host, port: proxy.port, path: url.href, headers: Object.assign({}, headers, { host: url.host }), agent: proxy.http } }
  }
  return { mod, reqOpts: { method, hostname: url.hostname, port: url.port || (isHttps ? 443 : 80), path: url.pathname + url.search, headers, agent: isHttps ? HTTPS_AGENT : HTTP_AGENT } }
}

const RETRYABLE_HTTP = new Set([408, 409, 425, 429, 500, 502, 503, 504])
function isRetryableCode(c) { return RETRYABLE_HTTP.has(c) }

const NET_ERR_CODES = [ 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ECONNABORTED', 'UND_ERR_SOCKET' ]
function isRetryableNetErr(err) {
  if (err && err.aborted) return false   // 预算耗尽/客户端断开：不是上游网络故障，不重试
  const c = err && err.code
  return !c || NET_ERR_CODES.includes(c)
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

// Retry-After 解析与「是否等得下」的判定统一在 retry-policy.js（429 归因与等待预算同源）。
function parseRetryAfter(headers) { return parseRetryAfterMs(headers) }

// 读一小段错误体用于 429 归因（限 8KB，读完立即销毁）：既不让上游大错误体打爆内存，
// 也不因为已经读了一部分就让连接悬挂；预算中止时立刻销毁。
async function readSmall(stream, signal, limit = MAX_ERR_BODY_BYTES) {
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') return ''
  const chunks = []
  let n = 0
  const onAbort = () => { try { stream.destroy && stream.destroy() } catch {} }
  if (signal) {
    if (signal.aborted) return ''
    try { signal.addEventListener('abort', onAbort, { once: true }) } catch {}
  }
  try {
    for await (const c of stream) {
      chunks.push(c)
      n += c.length
      if (n >= limit) break
    }
  } catch { /* 半截错误体不影响状态码语义 */ } finally {
    if (signal) { try { signal.removeEventListener('abort', onAbort) } catch {} }
  }
  try { stream.destroy && stream.destroy() } catch {}
  return Buffer.concat(chunks).toString('utf8').slice(0, limit)
}

// 单次转发（全双工，流式）。resolve: 收到上游响应头即返回 stream
// ctl = { signal, budget, connectMs }：整体预算中止时立即销毁在途请求。
function single(provider, url, method, headers, bodyBuf, timeout, ctl = {}) {
  const signal = ctl.signal || null
  const budget = ctl.budget || null
  return new Promise((resolve, reject) => {
    const remaining = budget ? budget.remaining() : Infinity
    // 剩余预算已耗尽：不再建连
    if (budget && budget.expired()) { reject(abortedError((budget && budget.reason) || 'request_timeout')); return }
    const effFirstByte = Number.isFinite(remaining) ? Math.min(timeout.firstByteMs, Math.max(0, remaining)) : timeout.firstByteMs
    const effIdle = Number.isFinite(remaining) ? Math.min(timeout.idleMs || 60000, Math.max(1, remaining)) : (timeout.idleMs || 60000)
    const { mod, reqOpts } = ctxFor(provider, url, method, headers, Object.assign({}, ctl, { connectMs: effFirstByte }))
    let settled = false
    let firstByteTimer = null
    const cleanup = () => {
      if (firstByteTimer) { clearTimeout(firstByteTimer); firstByteTimer = null }
      if (signal && onAbort) { try { signal.removeEventListener('abort', onAbort) } catch { } }
    }
    const onAbort = () => req.destroy(abortedError(reasonOf(budget)))
    const req = mod.request(reqOpts, (res) => {
      settled = true
      cleanup()
      // 头到达后转入空闲检测（idleMs）：思考型上游首 token 前可静默数十秒，
      // 沿用 connectMs 会把活连接误杀在 15s（connectMs 只该管建连阶段）
      req.setTimeout(effIdle, () => req.destroy(Object.assign(new Error('upstream idle'), { code: 'ETIMEDOUT' })))
      resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, headers: res.headers, stream: res, retryAfter: parseRetryAfter(res.headers) })
    })
    // 若第一阶段上限实际由请求预算钳制（预算更小），超时必须按预算中止语义上报（504 request_timeout），
    // 否则 firstByte 定时器会先于预算定时器触发，被当成普通网络超时 → 502 provider 失败。
    const budgetBoundFirstByte = budget && Number.isFinite(remaining) && remaining <= Number(timeout.firstByteMs)
    firstByteTimer = setTimeout(() => req.destroy(budgetBoundFirstByte ? abortedError(reasonOf(budget), 'overall timeout') : new Error('first-byte timeout')), effFirstByte)
    // 建连+等响应头阶段：总时长由 firstByteTimer 墙钟兜底，socket 静默上限对齐 firstByteMs，
    // 避免慢思考上游被更短的 connect 空闲定时器提前掐断
    req.setTimeout(effFirstByte, () => req.destroy(Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' })))
    if (signal) {
      if (signal.aborted) { req.destroy(abortedError(reasonOf(budget))); return }
      try { signal.addEventListener('abort', onAbort, { once: true }) } catch { }
    }
    req.on('error', (err) => {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    })
    if (bodyBuf && bodyBuf.length) req.write(bodyBuf)
    req.end()
  })
}

function reasonOf(budget) { return (budget && budget.reason) || 'request_timeout' }

async function settle(attempt, cfg, last, signal, capMs) {
  const ra = last && last.retryAfter
  if (ra != null) {
    // 调用方已用 retryWaitCap/retryWaitFits 确认「等得下」；这里再按 cap 钳一次，绝不越过 deadline
    const ms = Number.isFinite(capMs) ? Math.min(ra, capMs) : ra
    await sleepWith(Math.max(0, ms) + Math.random() * 40, signal)
  } else {
    const base = Math.min(cfg.maxDelayMs, cfg.initialDelayMs * Math.pow(2, attempt - 1))
    await sleepWith(base + base * (cfg.jitter || 0) * Math.random(), signal)
  }
}

// 上游 URL 拼接（规范化）：baseUrl 约定不带版本段（网关自动拼 /v1/...），但大量 OpenAI 兼容
// 服务的文档示例是带 /v1 的（如 https://api.openai.com/v1），用户照抄即踩 /v1/v1/ 双拼 404
// （生产 09-04 实录：kuaipao.pro/v1 → Invalid URL (POST /v1/v1/chat/completions)）。
// 此处容错：baseUrl 尾斜杠归一；base 已以 /v1 结尾且 path 又以 /v1/ 开头时去掉 base 的版本段。
export function upstreamUrl(provider, path) {
  let base = String(provider.baseUrl || '').replace(/\/+$/, '')
  const p = String(path || '')
  if (/^\/v1\//.test(p) && /\/v1$/.test(base)) base = base.replace(/\/v1$/, '')
  return new URL(base + (provider.pathPrefix || '') + p)
}

/**
 * 转发 + 指数退避重试。契约（供外层 fallback/熔断）：
 *  - resolve { ok:true }         → 2xx，可直接透传
 *  - resolve { ok:false }        → 非重试错误码（业务 4xx）：外层直接返回、不熔断、不 fallback
 *  - reject(err)                 → 网络错或 5xx/429 重试耗尽：视为 provider 不可用（err.status 表示状态码）
 * 重试次数附在结果/错误 .retries；429 额外带 .attribution / .retryAfter / .bodyText，供外层
 * 回 HTTP 429 + Retry-After（不再吞成 502），且 429 不算 provider 故障（不熔断）。
 *
 * opts.noRetry：非幂等（tool/tool 结果）请求 → 同上游只发一次，绝不自动重放。
 * Retry-After：只有能在本次请求剩余预算内等完才等（retryWaitFits）；等不下立即停止重试，
 * 把最后一次状态/归因/Retry-After 上抛，由外层决定换上游或回 429 —— 绝不空等越过 deadline。
 */
export async function forward(provider, path, method, headers, bodyBuf, opts = {}, log, ctl = {}) {
  const url = upstreamUrl(provider, path)
  const retry = Object.assign({ maxAttempts: 1, initialDelayMs: 500, maxDelayMs: 8000, jitter: 0.2 }, opts.retry)
  const timeout = Object.assign({ connectMs: 10000, firstByteMs: 60000, idleMs: 60000 }, opts.timeout)
  const overallMs = timeout.overallMs || 0
  const budget = ctl.budget || null
  const signal = ctl.signal || (budget && budget.signal) || null
  const noRetry = opts.noRetry === true
  const maxAttempts = noRetry ? 1 : Math.max(1, retry.maxAttempts)
  // 单次 Retry-After 等待上限：显式配置 > 默认 30s（与剩余预算取小，见 retryWaitCap）
  const maxWaitMs = Number(opts.maxRetryAfterMs) > 0 ? Number(opts.maxRetryAfterMs) : 0
  const t0 = Date.now()
  // 统一 deadline：请求级预算优先；无预算时沿用 overallMs（既有语义），两者都是硬上限
  const deadlineAt = budget && budget.deadlineAt != null ? budget.deadlineAt : (overallMs ? t0 + overallMs : null)
  const timeoutErr = (attempt, detail) => { const e = abortedError((budget && budget.reason) || 'request_timeout', detail); e.retries = attempt - 1; return e }
  // 剩余预算（无预算/无 deadline = Infinity）：Retry-After 等待不得越过它
  const remainingMs = () => {
    const a = budget ? budget.remaining() : Infinity
    const b = deadlineAt != null ? Math.max(0, deadlineAt - Date.now()) : Infinity
    return Math.min(a, b)
  }

  let last
  let attemptsMade = 0
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attemptsMade = attempt
    if (budget && budget.expired()) throw timeoutErr(attempt)
    if (deadlineAt != null && Date.now() >= deadlineAt) throw timeoutErr(attempt, 'overall timeout (' + Math.round(deadlineAt - t0) + 'ms)')
    try {
      const result = await single(provider, url, method, headers, bodyBuf, timeout, Object.assign({}, ctl, { budget }))
      if (result.ok || !isRetryableCode(result.status)) { result.retries = attempt - 1; return result }
      // 可重试状态：读一小段错误体做归因（429 平台额度/容量/速率），读完即销毁连接
      const bodyText = await readSmall(result.stream, signal)
      const cls = classify429(bodyText, result.headers)
      last = {
        status: result.status,
        retryAfter: result.retryAfter,
        attribution: result.status === 429 ? cls.attribution : null,
        hasRetryAfter: cls.hasRetryAfter,
        bodyText,
      }
      log && log.warn('upstream retryable status', result.status, 'attempt', attempt, '/', maxAttempts, last.attribution ? 'attribution=' + last.attribution : '')
    } catch (err) {
      last = err
      if (err && err.aborted) { err.retries = attempt - 1; throw err }   // 预算/客户端取消：立即收尾，不重试不熔断
      if (!isRetryableNetErr(err)) throw err            // 非网络类致命错，直接抛
      if (attempt >= maxAttempts) { err.retries = attempt - 1; throw err }   // 重试耗尽 → provider 失败（带 .retries 供外层记账）
      log && log.warn('upstream error', err.code || err.message, 'attempt', attempt, '/', maxAttempts)
    }
    if (attempt < maxAttempts) {
      const ra = last && last.retryAfter
      if (ra != null) {
        // Retry-After 必须在剩余预算内：等得下才等（并按 cap 钳制），等不下就停止重试，
        // 把最后一次状态/归因/Retry-After 上抛 —— 不空等、不越过 overall deadline。
        const cap = retryWaitCap(remainingMs(), maxWaitMs)
        if (ra > cap) {
          log && log.warn('retry-after 超出剩余预算，停止重试', ra + 'ms', 'cap=' + Math.round(cap) + 'ms')
          break
        }
        await settle(attempt, retry, last, signal, cap)
        continue
      }
      await settle(attempt, retry, last, signal)
    }
  }
  // 可重试状态码耗尽（或 Retry-After 等不下）→ 抛 provider 失败；429 保留归因供外层回 429
  const fail = new Error('upstream failed: ' + (last && last.status))
  fail.status = last && last.status
  fail.retries = Math.max(0, attemptsMade - 1)
  fail.retryAfter = (last && last.retryAfter != null) ? last.retryAfter : null
  fail.attribution = (last && last.attribution) || null
  fail.bodyText = (last && last.bodyText) || ''
  fail.providerFail = true
  throw fail
}

// 探测上游可用性（在线检活）：GET {base}{prefix}/v1/models，单次不重试
export function probe(provider) {
  const url = upstreamUrl(provider, '/v1/models')
  const { mod, reqOpts } = ctxFor(provider, url, 'GET', {})
  return new Promise((resolve) => {
    const headers = applyProviderHeaders({ 'user-agent': 'model-gateway/0.1', accept: 'application/json' }, provider)
    if (provider.apiKey) headers.authorization = 'Bearer ' + provider.apiKey
    reqOpts.headers = headers
    const started = Date.now()
    const req = mod.request(reqOpts, (res) => {
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
  // MG-008：预热与转发共用模型解析（api/上游模型名），否则 anthropic/gemini 上游会被打到 chat 路径，
  // providerModels 覆盖名也会失效（发网关名 → 上游 404）。
  const api = (opts && opts.api) || provider.api || 'openai'
  const upstreamModel = (opts && opts.upstreamModel) || model
  const messages = [{ role: 'system', content: systemPrompt }]
  if (adapterFor(api)) messages.push({ role: 'user', content: 'ping' }) // Anthropic/Gemini 要求至少一条非 system 消息
  const spec = protocolRequest(api, { model: upstreamModel, messages, max_tokens: 1, stream: false })
  const url = upstreamUrl(provider, spec.path)
  const headers = protocolHeaders(applyProviderHeaders({ 'content-type': 'application/json', 'user-agent': 'model-gateway/0.1', accept: 'application/json' }, provider), provider, api)
  const payload = Buffer.from(JSON.stringify(spec.body))
  headers['content-length'] = payload.length
  const { mod, reqOpts } = ctxFor(provider, url, 'POST', headers)
  const to = Object.assign({ connectMs: 10000, firstByteMs: 60000 }, (opts && opts.timeout) || {})
  const started = Date.now()
  return new Promise((resolve) => {
    const req = mod.request(reqOpts, (res) => {
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

// 主上游回切探活：与 warm 同构，但消息用 user 角色——部分上游/聚合网关的 LiteLLM
// 层拒绝 system-only 请求（400 LITELLM_ERROR），system 前缀探活会永远失败。
// 按真实使用形态（stream:true）判定"恢复"：仅回 2xx 头不算数，流式上游必须收到首条 SSE 数据才算可用，
// 否则间歇性「头 2xx + 流中断」的上游会被探活误判为已恢复、亲和被切回故障主上游（回切后又立刻断流）。
// 兼容返回 JSON 的上游（非 event-stream 的 2xx 直接视为恢复）。
export function probeChat(provider, model, message, opts = {}, log) {
  // MG-008：failback 探活与转发共用模型解析（api/上游模型名），否则非 OpenAI 上游/覆盖名会被误判"未恢复"。
  const api = (opts && opts.api) || provider.api || 'openai'
  const upstreamModel = (opts && opts.upstreamModel) || model
  const spec = protocolRequest(api, { model: upstreamModel, messages: [{ role: 'user', content: message || 'ping' }], max_tokens: 1, stream: true })
  const url = upstreamUrl(provider, spec.path)
  const headers = protocolHeaders(applyProviderHeaders({ 'content-type': 'application/json', 'user-agent': 'model-gateway/0.1', accept: 'text/event-stream' }, provider), provider, api)
  const payload = Buffer.from(JSON.stringify(spec.body))
  headers['content-length'] = payload.length
  const { mod, reqOpts } = ctxFor(provider, url, 'POST', headers)
  const to = Object.assign({ connectMs: 10000, firstByteMs: 60000 }, (opts && opts.timeout) || {})
  const started = Date.now()
  return new Promise((resolve) => {
    let settled = false
    let timer = null
    const finish = (ok, code, err) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ ok, status: code, ms: Date.now() - started, err: err || null }) }
    // 响应头到达后等待首条 SSE 数据的窗口：流式上游连接成功却长时间不发事件=不可用
    const req = mod.request(reqOpts, (res) => {
      const okStatus = res.statusCode >= 200 && res.statusCode < 300
      const isSse = /(text|application)\/event-stream/i.test((res.headers['content-type'] || ''))
      if (!okStatus) { res.resume(); finish(false, res.statusCode, 'HTTP ' + res.statusCode); return }
      if (!isSse) { res.resume(); finish(true, res.statusCode, null); return } // 兼容返回 JSON 的非流式上游
      timer = setTimeout(() => { try { res.destroy() } catch { } finish(false, res.statusCode, 'no stream event') }, 15000)
      let buf = ''
      res.on('data', (d) => {
        if (settled) { try { res.destroy() } catch { } return }
        buf += d.toString('utf8')
        if (/data:/.test(buf)) { finish(true, res.statusCode, null); try { res.destroy() } catch { } } // 收到首条 SSE 事件即判恢复
      })
      res.on('error', (e) => finish(false, res.statusCode, (e && e.code) || e.message))
      res.on('end', () => finish(false, res.statusCode, 'sse ended without data'))
    })
    req.setTimeout(to.connectMs, () => req.destroy(Object.assign(new Error('failback probe timeout'), { code: 'ETIMEDOUT' })))
    req.on('error', (err) => finish(false, null, err.code || err.message))
    req.write(payload)
    req.end()
  })
}

// 非 chat 能力探测的通用 POST（MG-011/012）：路径/请求体由调用方给出，2xx 即通，响应体上限 1MiB。
function probeJsonUpstream(provider, api, path, bodyObj) {
  const url = upstreamUrl(provider, path)
  const headers = protocolHeaders(applyProviderHeaders({ 'content-type': 'application/json', 'user-agent': 'model-gateway/0.1', accept: 'application/json', 'accept-encoding': 'identity' }, provider), provider, api)
  const payload = Buffer.from(JSON.stringify(bodyObj))
  headers['content-length'] = payload.length
  const { mod, reqOpts } = ctxFor(provider, url, 'POST', headers)
  return new Promise((resolve) => {
    const started = Date.now()
    let settled = false
    const done = (o) => { if (!settled) { settled = true; resolve(o) } }
    const req = mod.request(reqOpts, (res) => {
      res.setTimeout(90000, () => res.destroy())
      const c = []; let total = 0
      res.on('data', (d) => { total += d.length; if (total > 1024 * 1024) { try { res.destroy() } catch {} ; done({ ok: false, code: res.statusCode, ms: Date.now() - started, err: 'probe response too large' }); return } c.push(d) })
      res.on('end', () => {
        const text = Buffer.concat(c).toString('utf8').trim()
        const ok = res.statusCode >= 200 && res.statusCode < 300
        done({ ok, code: res.statusCode, ms: Date.now() - started, err: ok ? null : (text.slice(0, 120) || ('HTTP ' + res.statusCode)) })
      })
      res.on('error', (e) => done({ ok: false, code: res.statusCode, ms: Date.now() - started, err: (e && e.code) || (e && e.message) || 'response error' }))
    })
    req.setTimeout(90000, () => req.destroy(Object.assign(new Error('probe timeout'), { code: 'ETIMEDOUT' })))
    req.on('error', (err) => done({ ok: false, code: null, ms: Date.now() - started, err: err.code || err.message }))
    req.write(payload)
    req.end()
  })
}

// embedding 模型连通测试（MG-011）：向 embeddings 端点发单条 input，2xx 即通；用于 /api/model-test。
export function probeEmbedding(provider, model, api = provider.api || 'openai', upstreamModel = model) {
  const adapter = embeddingAdapterFor(api)
  const spec = adapter ? adapter.build({ model: upstreamModel, input: ['ping'] }) : { path: '/v1/embeddings', body: { model: upstreamModel, input: ['ping'] } }
  return probeJsonUpstream(provider, api, spec.path, spec.body)
}

// rerank 模型连通测试（MG-012）：query/documents 各一条，2xx 即通。
export function probeRerank(provider, model, api = provider.api || 'openai', upstreamModel = model) {
  const path = api === 'cohere' ? '/v2/rerank' : '/v1/rerank'
  return probeJsonUpstream(provider, api, path, { model: upstreamModel, query: 'ping', documents: ['ping'] })
}

// 模型连通测试：向该模型所属上游发一个极小量的真实 chat 请求（max_tokens=1），验证"这个模型名能真正被调用"
// 返回 { ok, code, ms, err, body }，body 为响应首片段用于展示后端告警。
export function probeModel(provider, model, api = provider.api || 'openai', upstreamModel = model) {
  const request = protocolRequest(api, { model: upstreamModel, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false })
  const url = upstreamUrl(provider, request.path)
  const headers = protocolHeaders(applyProviderHeaders({ 'content-type': 'application/json', 'user-agent': 'model-gateway/0.1', accept: 'application/json', 'accept-encoding': 'identity' }, provider), provider, api)
  const payload = Buffer.from(JSON.stringify(request.body))
  headers['content-length'] = payload.length
  const { mod, reqOpts } = ctxFor(provider, url, 'POST', headers)
  return new Promise((resolve) => {
    const started = Date.now()
    let settled = false
    const done = (o) => { if (!settled) { settled = true; resolve(o) } }
    const req = mod.request(reqOpts, (res) => {
      res.setTimeout(20000, () => res.destroy())
      const c = []
      let total = 0
      res.on('data', (d) => {
        // 探测响应体上限：上游（尤其不可信中转站）可返回超大 body 打爆内存；超限即判失败并释放连接
        total += d.length
        if (total > 8 * 1024 * 1024) { try { res.destroy() } catch { } ; done({ ok: false, code: res.statusCode, ms: Date.now() - started, err: 'probe response body too large (>8MB)' }); return }
        c.push(d)
      })
      res.on('end', () => {
        const raw = Buffer.concat(c)
        // 兼容上游缺 content-encoding 头但仍返回 gzip：按魔数 1f 8b 尝试解压，避免 JSON 解析/统计断链。
        // 解压同样要带上限，否则探测路径也会被 gzip 炸弹打成 OOM（与 forward.js 的 maybeGunzip 同源风险）。
        const buf = (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) ? (() => { try { return gunzipSync(raw, { maxOutputLength: 8 * 1024 * 1024 }) } catch { return raw } })() : raw
        const text = buf.toString('utf8').trim()
        const ok = res.statusCode >= 200 && res.statusCode < 300
        done({ ok, code: res.statusCode, ms: Date.now() - started, err: ok ? null : (text.slice(0, 120) || ('HTTP ' + res.statusCode)) })
      })
      res.on('error', (e) => done({ ok: false, code: res.statusCode, ms: Date.now() - started, err: (e && e.code) || (e && e.message) || 'response error' }))
    })
    // 90s：思考型模型（如 stealth/ox-alpha）响应 5s~90s+ 波动，且上游代理内部重试期间不发字节；30s 会把可用模型误报成 ETIMEDOUT
    req.setTimeout(90000, () => req.destroy(Object.assign(new Error('probe timeout'), { code: 'ETIMEDOUT' })))
    req.on('error', (err) => done({ ok: false, code: null, ms: Date.now() - started, err: err.code || err.message }))
    req.write(payload)
    req.end()
  })
}
