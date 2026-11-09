import http from 'node:http'
import { readFileSync, chmodSync, existsSync, writeFileSync, copyFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { isIP } from 'node:net'
import { loadConfig, createRouter, buildProvider, resolveKey, configPaths, writeJsonAtomic, keysEncrypt, readJson, readKeysFresh, modelTarget } from './router.js'
import { createLogger } from './logger.js'
import { forward, probe, probeModel, probeChat, warm, probeEmbedding, probeRerank } from './request.js'
import { adapterFor, cacheHitMiss, mapErrorEnvelope } from './format.js'
import { isStreamResponse, writeUpstreamHeaders, relayStream, endInterruptedStream } from './sse.js'
import { forwardChain, routeLimit, virtualQuotaExceeded, acquireProvider } from './forward.js'
import { createBudget, abortedError } from './budget.js'
import { responsesToChat, chatToResponse } from './responses.js'
import { createResponsesStream } from './responses-stream.js'
import { validateEmbeddingRequest, buildEmbeddingRequest, embeddingHeaders, normalizeEmbeddingResponse, supportsEmbeddings, MAX_EMBEDDING_INPUTS } from './embeddings.js'
import { validateRerankRequest, buildRerankRequest, rerankHeaders, normalizeRerankResponse, supportsRerank } from './rerank.js'
import { supportsMedia, parseMultipartField, replaceMultipartField, isMultipart, validateSpeechRequest, validateImageRequest, mediaResponseLimit } from './media.js'
import { defaultVideoPaths, newVideoTask, upstreamTaskId, applyUpstreamStatus, clientTask, loadVideoTasks, saveVideoTasks, gcVideoTasks, findTaskByIdem, validateVideoCreate, VIDEO_POLL_MIN_MS } from './videos.js'
import { todayKey } from './shared.js'

// 数据面 Chat 入口别名：兼容 base URL 不带 /v1 的 OpenAI 兼容客户端（它们会拼 /chat/completions 或 /v1/chat/completions）
const CHAT_PATHS = new Set(['/v1/chat/completions', '/chat/completions'])
const RESPONSES_PATHS = new Set(['/v1/responses', '/responses'])
const ADMIN_PAGE = new URL('./admin.html', import.meta.url)

const FAIL_OPEN_THRESHOLD = 5       // 连续失败熔断阈值（放宽：平台偶发慢/抖不轻易熔断）
const FAIL_OPEN_COOLDOWN = 10000    // 熔断冷却 ms

// ctl = { budget, signal }（MG-002）：读 body 也受请求预算/客户端断开约束，中止时销毁源流并 reject。
function collectBody(stream, maxBytes = 64 * 1024 * 1024, ctl = null) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    const signal = (ctl && ctl.signal) || null
    const budget = (ctl && ctl.budget) || null
    const cleanup = () => {
      stream.removeListener('data', onData)
      stream.removeListener('end', onEnd)
      stream.removeListener('error', onError)
      stream.removeListener('aborted', onAborted)
      if (signal && onAbort) { try { signal.removeEventListener('abort', onAbort) } catch {} }
    }
    const onError = (err) => { cleanup(); reject(err) }
    const onAbort = () => {
      cleanup()
      // 上游 body：预算中止时立即销毁连接；客户端请求体：保留连接以便回写 504，由 handler 收尾后释放
      if (ctl && ctl.destroyOnAbort) { try { if (stream && typeof stream.destroy === 'function') stream.destroy() } catch {} }
      reject(abortedError((budget && budget.reason) || 'request_timeout'))
    }
    const onAborted = () => onError(abortedError('client_closed'))
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks)) }
    const onData = (chunk) => {
      total += chunk.length
      if (total > maxBytes) {
        cleanup()
        // Drain without retaining the body or destroying the response socket.
        stream.on('error', () => {})
        stream.resume()
        reject(new Error('body too large (' + maxBytes + ' bytes)'))
      } else chunks.push(chunk)
    }
    stream.on('data', onData)
    stream.once('end', onEnd)
    stream.once('error', onError)
    stream.once('aborted', onAborted)
    if (signal) {
      if (signal.aborted) { onAbort(); return }
      try { signal.addEventListener('abort', onAbort, { once: true }) } catch {}
    }
  })
}

// 上游偶发返回 gzip 响应却不带 content-encoding 头（如 opencodezen），会导致 usage 解析失败、统计断链

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}
function tryParse(buf) { try { return JSON.parse(buf.toString('utf8')) } catch { return null } }

function pct(arr, p) { if (!arr || !arr.length) return null; const a = [...arr].sort((x, y) => x - y); const i = Math.min(a.length - 1, Math.max(0, Math.ceil(a.length * p / 100) - 1)); return Math.round(a[i]) }
function safeTokenCmp(a, b) {
  if (!a || !b || a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}
function adminOk(req, state) {
  if (!state.adminToken) return true
  const ah = req.headers['authorization'] || ''
  if (ah.slice(0, 7).toLowerCase() === 'bearer ') return safeTokenCmp(ah.slice(7).trim(), state.adminToken)
  const x = req.headers['x-mg-admin']
  return !!x && safeTokenCmp(String(x), state.adminToken)
}
// ── 来源策略（MG-001）：Host/DNS 重绑定 + 跨源管理请求 ──
// Host 只接受 IP 字面量与白名单名字：DNS 重绑定必须借道域名，因此未经 server.allowedHosts 声明的域名一律拒绝。
// 反向代理与自定义域名通过 server.allowedHosts 显式放行，属于部署决策而不是默认放宽。
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1'])
function bareHost(h) { return String(h || '').trim().toLowerCase().replace(/^\[|\]$/g, '') }
function hostAllowed(req, cfg) {
  const raw = req.headers.host
  if (!raw) return true // HTTP/1.0 或未带 Host 的 CLI 客户端：无重绑定向量
  let name
  try { name = bareHost(new URL('http://' + raw).hostname) } catch { return false }
  if (LOOPBACK_NAMES.has(name) || isIP(name)) return true
  const server = (cfg && cfg.server) || {}
  if (server.host && bareHost(server.host) === name) return true
  return (server.allowedHosts || []).some((h) => bareHost(h) === name)
}
// Origin：缺失=非浏览器客户端（CLI/curl）；跨源网页必须显式加入 server.allowedOrigins（同源面板天然通过）。
function originAllowed(req, cfg) {
  const raw = req.headers.origin
  if (!raw) return true
  if (raw === 'null') return false
  let host
  try { host = new URL(raw).host.toLowerCase() } catch { return false }
  if (host === String(req.headers.host || '').toLowerCase()) return true
  const list = ((cfg && cfg.server && cfg.server.allowedOrigins) || []).map((o) => String(o).trim().toLowerCase().replace(/\/$/, ''))
  return list.includes(String(raw).trim().toLowerCase().replace(/\/$/, ''))
}
function isLoopbackPeer(req) {
  const a = (req.socket && req.socket.remoteAddress) || ''
  return a === '::1' || a === '127.0.0.1' || a === '::ffff:127.0.0.1' || a.startsWith('::ffff:127.')
}
function denyOrigin(res, path, msg) {
  // 管理面沿用 {error: string}；数据面沿用 {error:{message,type}}，避免同一个 403 出现两种信封
  if (path === '/api' || path.startsWith('/api/')) { sendJson(res, 403, { error: msg }); return }
  sendJson(res, 403, { error: { message: msg, type: 'forbidden' } })
}
// 数据面客户端 Key 校验：解析 Authorization: Bearer <key>，常量时间比较复用 safeTokenCmp
function clientAuthOk(req, key) {
  const ah = req.headers['authorization'] || ''
  if (ah.slice(0, 7).toLowerCase() !== 'bearer ') return false
  return safeTokenCmp(ah.slice(7).trim(), key)
}

// ── 健康 / 统计 ──
function ensureHst(state, pid) {
  if (!state.health[pid]) state.health[pid] = { fails: 0, openUntil: 0, state: 'ok' }
  return state.health[pid]
}
function healthy(hst, now) { return hst.openUntil <= now }
function markOk(state, pid) {
  const h = ensureHst(state, pid); h.fails = 0; h.state = 'ok'; h.openUntil = 0
}
function markFail(state, pid, circuit) {
  const c = circuit || {}
  const th = c.maxFailures || FAIL_OPEN_THRESHOLD
  const cd = c.openDurationMs || FAIL_OPEN_COOLDOWN
  const h = ensureHst(state, pid)
  h.fails += 1
  if (h.fails >= th) { h.state = 'open'; h.openUntil = Date.now() + cd }
  else if (h.openUntil > Date.now()) h.state = 'open'
  else h.state = 'half'
}
function effState(h, now) { return (h.state === 'open' && h.openUntil <= now) ? 'half' : h.state }
const STATS_RETENTION_DAYS = 90 // stats 历史保留窗口（天）：daily/hourly 超窗键在每次落盘时清理，防 stats.json 无界膨胀
function pruneStatsHistory(state) {
  const cutoff = todayKey(new Date(Date.now() - STATS_RETENTION_DAYS * 86400000))
  for (const bucket of [state.stats.daily, state.stats.hourly]) {
    for (const model of Object.keys(bucket || {})) {
      const days = bucket[model]
      for (const k of Object.keys(days)) if (k.split(':')[0] < cutoff) delete days[k]
      if (!Object.keys(days).length) delete bucket[model]
    }
  }
}
function tallyDaily(state, modelName, tokens, hit, miss, inTokens, outTokens) { if (!modelName) return; const now = new Date(); const k = todayKey(now); const m = state.stats.daily[modelName] || (state.stats.daily[modelName] = {}); const c = m[k] || (m[k] = { tokens: 0, hit: 0, miss: 0, inTokens: 0, outTokens: 0 }); c.tokens += tokens || 0; c.hit += hit || 0; c.miss += miss || 0; c.inTokens += inTokens || 0; c.outTokens += outTokens || 0; const hk = k + ':' + String(now.getHours()).padStart(2, '0'); const hm = state.stats.hourly[modelName] || (state.stats.hourly[modelName] = {}); const h = hm[hk] || (hm[hk] = { tokens: 0, hit: 0, miss: 0, inTokens: 0, outTokens: 0 }); h.tokens += tokens || 0; h.hit += hit || 0; h.miss += miss || 0; h.inTokens += inTokens || 0; h.outTokens += outTokens || 0 }
// 虚拟模型入口账本：serving 与入口名不同且入口是虚拟模型时，同步计入虚拟名（供其自身 quota/dailyQuota 检查）
function tallyVirtual(state, modelName, serving, tokens, inTokens, outTokens) {
  if (!modelName || !serving || modelName === serving) return
  if (!(state.cfg.virtualModels || []).some(v => v.name === modelName)) return
  const svg = state.stats.byModel[modelName] = state.stats.byModel[modelName] || { requests: 0, errors: 0 }
  svg.tokens = (svg.tokens || 0) + (tokens || 0)
  svg.inTokens = (svg.inTokens || 0) + (inTokens || 0)
  svg.outTokens = (svg.outTokens || 0) + (outTokens || 0)
  tallyDaily(state, modelName, tokens, 0, 0, inTokens, outTokens)
}
function agg(state, pid, field, delta) { if (state.stats.byProvider[pid]) state.stats.byProvider[pid][field] += delta; state.stats.global[field] += delta }

// ── 缓存降碎片化（A2 会话/上游亲和 + B5 命中率路由）──
// 记录某模型最近一次成功使用哪个上游，回填到状态，供前端展示。
function noteAffinity(state, model, pid) { if (model && pid && state.cfg.providers[pid]) { state.affinity[model] = pid; state.affinityAt[model] = Date.now() } }
// 记录某 (模型, 上游) 组合的缓存命中/未命中，用于跨模型切换后按命中率择优。
function noteCacheStat(state, model, pid, hit, miss) {
  if (!model || !pid) return
  const k = model + '\u0000' + pid
  const c = state.cacheStat[k] || (state.cacheStat[k] = { hit: 0, miss: 0, ts: Date.now() })
  c.hit += hit || 0; c.miss += miss || 0; c.ts = Date.now()
}
// 候选上游排序：优先"上次成功"的亲和上游（保持同一上游复用其厂商缓存），
// 其次按近期缓存命中率从高到低，其余保持原顺序。

function buildStatus(state) {
  const now = Date.now()
  const s = state.stats
  const providers = Object.entries(state.cfg.providers || {}).map(([id, p]) => {
    // Key 判定必须与转发链同源（resolveKey：keys 存储 → 进程环境 → 注册表实时读取）。
    // 此前这里独立只查 process.env——注册表 fallback 修复后面板仍显示「设 Key」，
    // 而转发/探活实际已能取到 key（面板显示与真实能力不同步，用户误判未生效）。
    const pk = resolveKey(state.cfg, p, id)
    const h = ensureHst(state, id)
    const o = s.byProvider[id] || { requests:0, errors:0, retries:0, latencySum:0, latencyCount:0, tokens:0 }
    return {
      id, baseUrl: p.baseUrl, hasKey: !!pk.key,
      keySource: pk.source,
      apiKeyEnv: p.apiKeyEnv || null, pathPrefix: p.pathPrefix || '', api: p.api || 'openai', extraHeaders: p.extraHeaders || {}, proxy: p.proxy || '', circuit: p.circuit || null,
      st: {
        requests: o.requests, errors: o.errors, retries: o.retries, tokens: o.tokens,
        avgMs: o.latencyCount ? Math.round(o.latencySum / o.latencyCount) : null,
        p50: pct(o.lats, 50), p95: pct(o.lats, 95),
        state: effState(h, now), openUntilMs: Math.max(0, h.openUntil - now),
        probe: o.probe || null,
      },
    }
  })
  const models = Object.entries(state.cfg.models || {}).map(([name, d]) => {
    const m = (s.byModel && s.byModel[name]) || { requests: 0, errors: 0 }
    const dk = (s.daily && s.daily[name] && s.daily[name][todayKey()]) || { tokens: 0, hit: 0, miss: 0 }
    const hitRate = (dk.hit + dk.miss) > 0 ? Math.round((dk.hit / (dk.hit + dk.miss)) * 1000) / 10 : null
    return { name, provider: d.provider, alias: d.alias || [], fallbacks: d.fallbacks || [], capability: d.capability || 'chat', maxConcurrent: d.maxConcurrent || 0, qps: d.qps || 0, reasoning: d.reasoning || '', effortOptions: d.effortOptions || [], effortFormat: d.effortFormat || '', dailyQuota: d.dailyQuota || 0, quota: d.quota || 0, maxContext: d.maxContext || 0, maxTokensMax: d.maxTokensMax || 0, api: d.api || '', providerModels: d.providerModels || {}, forceNoStream: !!d.forceNoStream, probe: m.probe || null, requests: m.requests, errors: m.errors, tokens: m.tokens || 0, today: dk.tokens || 0, hitRate, affinity: state.affinity[name] || null, avgMs: m.latencyCount ? Math.round(m.latencySum / m.latencyCount) : null }
  })
  const defaults = state.cfg.defaults || {}
  const todayTotal = models.reduce((a, m) => a + (m.today || 0), 0)
  const virtualModels = (state.cfg.virtualModels || []).map(v => {
    const m = (s.byModel && s.byModel[v.name]) || { requests: 0, errors: 0 }
    const dk = (s.daily && s.daily[v.name] && s.daily[v.name][todayKey()]) || { tokens: 0, hit: 0, miss: 0 }
    const keyId = '__mg_vm_' + v.name
    const meta = (state.cfg._keys && state.cfg._keys['__mg_vm_meta_' + v.name]) || {}
    return { name: v.name, directory: v.directory, quota: v.quota, dailyQuota: v.dailyQuota, maxContext: v.maxContext, maxConcurrent: v.maxConcurrent, qps: v.qps, keySet: !!(state.cfg._keys && state.cfg._keys[keyId]), expiresAt: meta.expiresAt || '', note: meta.note || '', requests: m.requests, errors: m.errors, tokens: m.tokens || 0, today: dk.tokens || 0, hitRate: (dk.hit + dk.miss) > 0 ? Math.round(dk.hit / (dk.hit + dk.miss) * 1000) / 10 : null }
  })
  return {
    needAuth: !!state.adminToken,
    configVersion: state.cfg.configVersion || 0,
    virtualModels,
    server: { maxBodyBytes: (state.cfg.server && state.cfg.server.maxBodyBytes) || 0, keyEncrypted: !!(process.env.MG_KEYS_MASTER) || keysFileEncrypted(state.paths.keys), host: (state.cfg.server && state.cfg.server.host) || '127.0.0.1', port: (state.cfg.server && state.cfg.server.port) || 8787 },
    startedAt: state.st.startedAt, uptimeMs: Date.now() - state.st.startedAt,
    counters: Object.assign({}, state.st.counters),
    lastServing: state.st.lastServing || null,
    global: { requests: s.global.requests, errors: s.global.errors, retries: s.global.retries, interrupts: s.global.interrupts, tokenCount: s.global.tokens, todayTokens: todayTotal, avgMs: s.global.confirmed ? Math.round(s.global.latencySum / s.global.confirmed) : null, p50: pct(s.global.lats, 50), p95: pct(s.global.lats, 95), latTrend: s.global.latTrend || [] },
    cache: { trend: state.cacheTrend || [], alert: state.cacheAlert || null },
    dialogues: Object.values(state.dialogue).filter(d => d.requests > 0).sort((a, b) => b.lastAt - a.lastAt).slice(0, 30).map(d => ({ id: d.id, named: d.named, requests: d.requests, tokens: d.tokens, hit: d.hit, miss: d.miss, hitRate: (d.hit + d.miss) > 0 ? Math.round(d.hit / (d.hit + d.miss) * 1000) / 10 : null, startAt: d.startAt, lastAt: d.lastAt })),
    providers,
    models,
    // defaults 原样返回（仅 clientKey 掩码）：否则自定义字段（affinityTtlMs / failbackProbe 等）
    // 会在任意一次配置保存后被静默丢弃（与 circuit 同源的问题）
    defaults: Object.assign({ directory: [], preheat: [], retry: {}, timeout: {}, concurrency: {}, extraHeaders: {}, proxy: '', proxyMode: 'auto' }, defaults, { clientKey: currentClientKey(state) ? '********' : '' }),
  }
}

function readLogTail(logFile, lines) {
  try {
    const text = readFileSync(logFile, 'utf8')
    const arr = text.split(/\r?\n/).filter((l) => l.length)
    return arr.slice(-Math.max(1, Math.min(lines, 5000)))
  } catch { return [] }
}
function staticModels(cfg) {
  const data = Object.keys(cfg.models || {}).map((id) => ({ id, object: 'model', owned_by: 'model-gateway', capability: ((cfg.models && cfg.models[id] && cfg.models[id].capability) || 'chat') }))
  const vm = (cfg.defaults && cfg.defaults.model) || ''
  if (vm && !data.some((m) => m.id === vm)) data.push({ id: vm, object: 'model', owned_by: 'model-gateway' })
  for (const v of cfg.virtualModels || []) if (!data.some((m) => m.id === v.name)) data.push({ id: v.name, object: 'model', owned_by: 'model-gateway' })
  return { object: 'list', data }
}

// 日志脱敏词表（MG-005）：上游 Key（环境变量/注册表/面板）、extraHeaders 值、客户端/管理令牌、代理内嵌凭据。
// 每次 reloadConfig 重新收集，热更新 Key 后立即生效，不必重启进程。
function collectSecrets(cfg) {
  const out = []
  for (const d of Object.values(cfg.providers || {})) { if (d && d.apiKeyEnv && process.env[d.apiKeyEnv]) out.push(process.env[d.apiKeyEnv]) }
  for (const d of Object.values(cfg.providers || {})) { for (const v of Object.values((d && d.extraHeaders) || {})) if (v) out.push(String(v)) }
  for (const v of Object.values(cfg._keys || {})) if (v && typeof v === 'string') out.push(v)
  if (process.env.MG_CLIENT_KEY) out.push(process.env.MG_CLIENT_KEY)
  if (process.env.MG_ADMIN_TOKEN) out.push(process.env.MG_ADMIN_TOKEN)
  const proxyUrls = [(cfg.defaults && cfg.defaults.proxy) || '']
  for (const d of Object.values(cfg.providers || {})) if (d && typeof d.proxy === 'string') proxyUrls.push(d.proxy)
  for (const u of proxyUrls) {
    try { const pu = new URL(u); if (pu.username) out.push(decodeURIComponent(pu.username)); if (pu.password) out.push(decodeURIComponent(pu.password)) } catch { /* 非法代理串由保存校验拦截 */ }
  }
  return out
}

// 容量核验（MG-006）：状态字典只保留当前配置仍在用的键。改名/删上游后旧键不会无限增长。
const STATE_MAX_CACHE_STAT = 500
function pruneStateCapacity(state) {
  const providers = state.cfg.providers || {}
  const models = state.cfg.models || {}
  const vms = new Set((state.cfg.virtualModels || []).map((v) => v.name))
  const keepModel = (n) => Object.prototype.hasOwnProperty.call(models, n) || vms.has(n)
  const keepProvider = (id) => Object.prototype.hasOwnProperty.call(providers, id)
  for (const id of Object.keys(state.health || {})) if (!keepProvider(id)) delete state.health[id]
  for (const id of Object.keys(state.throttle || {})) if (!keepProvider(id)) delete state.throttle[id]
  for (const n of Object.keys(state.throttleModel || {})) if (!keepModel(n)) delete state.throttleModel[n]
  for (const k of Object.keys(state.qpsToken || {})) if (!keepProvider(k) && !keepModel(k)) delete state.qpsToken[k]
  for (const n of Object.keys(state.affinity || {})) if (!keepModel(n)) { delete state.affinity[n]; if (state.affinityAt) delete state.affinityAt[n] }
  for (const k of Object.keys(state.cacheStat || {})) { const [m, pid] = k.split('\u0000'); if (!keepModel(m) || !keepProvider(pid)) delete state.cacheStat[k] }
  const csKeys = Object.keys(state.cacheStat || {})
  if (csKeys.length > STATE_MAX_CACHE_STAT) {
    csKeys.sort((a, b) => (state.cacheStat[a].ts || 0) - (state.cacheStat[b].ts || 0))
    for (const k of csKeys.slice(0, csKeys.length - STATE_MAX_CACHE_STAT)) delete state.cacheStat[k]
  }
  trimDialogue(state)
}

function reloadConfig(state) {
  state.cfg = loadConfig()
  state.router = createRouter(state.cfg)
  if (state.log && state.log.setSecrets) state.log.setSecrets(collectSecrets(state.cfg))
  // 管理令牌优先级：环境变量 MG_ADMIN_TOKEN > server.adminToken > 面板设置（keys.__mg_admin）
  state.adminToken = process.env.MG_ADMIN_TOKEN || (state.cfg.server && state.cfg.server.adminToken) || (state.cfg._keys && state.cfg._keys.__mg_admin) || ''
  const ids = Object.keys(state.cfg.providers || {})
  for (const id of ids) if (!state.stats.byProvider[id]) state.stats.byProvider[id] = { requests:0, errors:0, retries:0, latencySum:0, latencyCount:0, tokens:0 }
  pruneStateCapacity(state)
}
// 写盘互斥：saveConfig/saveKeys 当前为同步函数（事件循环天然串行、无交错），
// 此队列固化「读改写全程独占」语义，防止未来异步化（fs/promises）后出现交错写与 tmp 同名冲突
let _cfgWriteChain = Promise.resolve()
function withConfigWriteLock(fn) {
  const run = _cfgWriteChain.then(fn, fn)
  _cfgWriteChain = run.then(() => {}, () => {})
  return run
}
// —— 配置结构校验单一入口（MG-003）——
// 形状与保留键在这里判完再进入语义校验；任何一步失败都不写盘、不改内存。
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
// —— 投影字段剥离（MG-009 D-2）——
// /api/status 把配置与运行时统计合并在同一投影里返回；面板原样回送保存时，统计/探针字段
// 曾会被写进 gateway.local.json（probe/requests/errors/...）。这里以**显式 denylist** 剥离：
// 未识别的扩展字段仍然保留（不透明袋要求，见 docs/contracts/management-ui-projection-v1.md §3.2/§3.3）。
const PROVIDER_RUNTIME_FIELDS = new Set(['hasKey', 'keySource', 'keyOk', 'st', 'probe'])
const MODEL_RUNTIME_FIELDS = new Set(['probe', 'requests', 'errors', 'tokens', 'today', 'hitRate', 'affinity', 'avgMs', 'inTokens', 'outTokens', 'latencySum', 'latencyCount'])
function stripRuntimeFields(obj, deny) {
  const out = {}
  for (const [k, v] of Object.entries(obj || {})) if (!deny.has(k)) out[k] = v
  return out
}
function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v) }
function reservedKeyIn(obj, label) {
  for (const k of Object.keys(obj || {})) if (RESERVED_KEYS.has(k)) return { error: label + ' 含保留键名：' + k }
  return null
}
function validateConfigShape(body) {
  if (!isPlainObject(body)) return { error: '请求体必须为 JSON 对象' }
  for (const f of ['providers', 'models', 'defaults']) {
    if (body[f] === undefined) continue
    if (!isPlainObject(body[f])) return { error: f + ' 必须为对象（收到' + (Array.isArray(body[f]) ? '数组' : typeof body[f]) + '）' }
    const r = reservedKeyIn(body[f], f)
    if (r) return r
  }
  if (body.virtualModels !== undefined && !Array.isArray(body.virtualModels)) return { error: 'virtualModels 必须为数组' }
  if (body.version !== undefined && !Number.isFinite(Number(body.version))) return { error: 'version 必须为数字' }
  return null
}

// configVersion 校验：调用方显式带 version 且已过期 → 冲突；缺省视为旧版客户端，宽容放行（响应带最新 version 供自愈）
function versionConflict(state, body) {
  const cv = Number(body && body.version)
  if (body && body.version !== undefined && Number.isFinite(cv) && cv !== (state.cfg.configVersion || 0)) return { conflict: true, currentVersion: state.cfg.configVersion || 0 }
  return null
}
function saveConfig(state, body) { return withConfigWriteLock(() => doSaveConfig(state, body)) }
async function doSaveConfig(state, body) {
  const cur = state.cfg
  const _shape = validateConfigShape(body); if (_shape) return _shape
  const _c = versionConflict(state, body); if (_c) return _c
  const providers = body.providers !== undefined ? body.providers : (cur.providers || {})
  const models = body.models !== undefined ? body.models : (cur.models || {})
  // defaults 合并而非整体替换：面板等客户端只回传它认识的白名单字段，
  // 未回传字段（affinityTtlMs / failbackProbe / preheat 等自定义或扩展项）保留现有值——任何保存都不再冲掉自定义配置。
  // 代价：字段无法经保存接口删除（需要时直接编辑 gateway.local.json 或 /api/config/reload 后手改）。
  const defaults = Object.assign({}, cur.defaults || {}, body.defaults || {})
  // 客户端 Key：'********' 掩码视为未改动（不清空）；其它值（含清空 ''）写入加密 keys 库，不再明文进 local，与 provider key 同样加密落盘
  let newClientKey = null
  if (defaults && typeof defaults.clientKey === 'string' && defaults.clientKey !== '********') { newClientKey = defaults.clientKey }
  defaults.clientKey = ''
  // 掩码=未改动：若存在旧版明文 defaults.clientKey，迁移进加密 keys 库并清掉明文，避免掩码保存导致 key 丢失
  if (newClientKey == null) { const legacy = (cur.defaults && cur.defaults.clientKey) || ''; if (legacy && legacy !== '********') newClientKey = legacy }
  for (const [mn, m] of Object.entries(models)) {
    if (!providers[m.provider]) return { error: '模型「' + mn + '」引用了不存在的上游 ' + m.provider }
    for (const fb of m.fallbacks || []) if (!providers[fb]) return { error: '模型「' + mn + '」的备用上游 ' + fb + ' 不存在' }
    for (const f of ['dailyQuota','quota','maxContext']) if (m[f] != null && (!Number.isFinite(m[f]) || m[f] < 0)) return { error: '模型「' + mn + '」的 ' + f + ' 必须为非负数字（0=不限）' }
    if (m.effortFormat != null && m.effortFormat !== '' && !['reasoning_effort', 'thinking'].includes(m.effortFormat)) return { error: '模型「' + mn + '」的 effortFormat 仅支持 reasoning_effort/thinking' }
    // 协议（改革：per-model protocol）：未设置/留空 = 继承上游的 api；显式设置时须为已知协议。
    // 同一上游的不同模型可各走不同协议（如 OpenCode Zen 的 union-alpha 走 anthropic、其余走 openai）。
    if (m.api != null && m.api !== '' && !['openai', 'anthropic', 'gemini', 'cohere'].includes(String(m.api))) return { error: '模型「' + mn + '」的 api 仅支持 openai/anthropic/gemini/cohere（留空=继承上游）' }
    // per-上游模型名覆盖：{ <providerId>: <该上游侧的模型名> }
    if (m.providerModels != null && m.providerModels !== '' && (typeof m.providerModels !== 'object' || Array.isArray(m.providerModels))) return { error: '模型「' + mn + '」的 providerModels 须为 { 上游ID: 该上游模型名 } 对象' }
    for (const pOv of Object.keys(m.providerModels || {})) if (RESERVED_KEYS.has(pOv)) return { error: '模型「' + mn + '」的 providerModels 含保留键名：' + pOv }
    if (m.providerModels && typeof m.providerModels === 'object') for (const [pOv, nm] of Object.entries(m.providerModels)) { if (!providers[pOv]) return { error: '模型「' + mn + '」的 providerModels 引用了不存在的上游 ' + pOv }; if (typeof nm !== 'string' || !nm) return { error: '模型「' + mn + '」的 providerModels[' + pOv + '] 须为非空字符串' } }
    if (m.forceNoStream != null && typeof m.forceNoStream !== 'boolean') return { error: '模型「' + mn + '」的 forceNoStream 须为布尔值' }
    // 能力声明（MG-011）：chat（默认）/embedding；未知值拦截，避免拼写错误静默变成 chat
    if (m.capability != null && m.capability !== '' && !['chat', 'embedding', 'rerank', 'audio', 'image', 'video'].includes(String(m.capability))) return { error: '模型「' + mn + '」的 capability 仅支持 chat/embedding/rerank/audio/image/video' }
    // video 异步任务路径（可选）：必须以 / 开头，避免把绝对 URL 注入到转发层
    for (const k of ['videoCreatePath', 'videoStatusPath', 'videoCancelPath']) {
      if (m[k] != null && m[k] !== '' && (typeof m[k] !== 'string' || !m[k].startsWith('/'))) return { error: '模型「' + mn + '」的 ' + k + ' 必须是以 / 开头的路径' }
    }
  }
  // 单上游代理（名单）：留空/undefined=继承全局；direct/false=强制直连；否则须为合法 http(s):// 地址
  for (const [pid, p] of Object.entries(providers || {})) {
    const pr = p && p.proxy
    if (pr != null && pr !== '' && pr !== false && pr !== 'direct') {
      if (typeof pr !== 'string') return { error: '上游「' + pid + '」的 proxy 必须为 留空/direct/合法 http(s) 地址' }
      try { const pu = new URL(pr); if (!/^https?:$/.test(pu.protocol) || !pu.hostname) throw new Error('bad') } catch { return { error: '上游「' + pid + '」的 proxy 不是合法的 http(s) 代理地址: ' + pr } }
    }
  }
  if (defaults.provider && defaults.provider !== '' && !providers[defaults.provider]) return { error: '默认上游 ' + defaults.provider + ' 不存在' }
  for (const e of (defaults.directory || [])) {
    if (!e || typeof e.model !== 'string' || !e.model) return { error: '默认上游目录包含无效项（缺模型名）' }
    if (!models[e.model]) return { error: '默认上游目录引用了不存在的模型 ' + e.model }
    for (const pr of (e.providers || [])) if (pr && !providers[pr]) return { error: '默认上游目录「' + e.model + '」引用了不存在的上游 ' + pr }
  }
  for (const e of (defaults.preheat || [])) {
    if (!e || typeof e.model !== 'string' || !e.model || typeof e.system !== 'string' || !e.system) return { error: '缓存预热项需同时包含 model 与 system（预热用的长 system 前缀）' }
    if (!models[e.model]) return { error: '缓存预热引用了不存在的模型 ' + e.model }
  }
  // 上游代理：可选。空字符串/undefined=直连；非空须为合法 http(s):// 代理地址（可带 user:pass），避免垃圾值落到转发层
  if (defaults.proxy != null && defaults.proxy !== '' && defaults.proxy !== false) {
    if (typeof defaults.proxy !== 'string') return { error: 'defaults.proxy 必须为字符串或空（http://user:pass@host:port）' }
    try { const pu = new URL(defaults.proxy); if (!/^https?:$/.test(pu.protocol) || !pu.hostname) throw new Error('bad') } catch { return { error: 'defaults.proxy 不是合法的 http(s) 代理地址: ' + defaults.proxy } }
  }
  // 代理模式：auto(默认)/direct/global；其它值 400 拦截
  if (defaults.proxyMode != null && defaults.proxyMode !== '' && !['auto', 'direct', 'global'].includes(String(defaults.proxyMode))) {
    return { error: 'defaults.proxyMode 仅支持 auto（按配置）/direct（全直连）/global（全走代理）' }
  }
  const clean = {}
  for (const [id, p] of Object.entries(providers || {})) clean[id] = stripRuntimeFields(p, PROVIDER_RUNTIME_FIELDS)
  // 模型：同样剥离运行时统计/探针字段后再落盘（未知扩展字段保留）
  const cleanModels = {}
  for (const [name, m] of Object.entries(models || {})) cleanModels[name] = stripRuntimeFields(m, MODEL_RUNTIME_FIELDS)
  // —— virtualModels 强校验（面板保存路径；loadConfig 另有容错规范化，手改坏配置不宕机）——
  const vmsIn = body.virtualModels !== undefined ? body.virtualModels : (cur.virtualModels || [])
  const vmNames = new Set()
  for (const vm of vmsIn) {
    if (!vm || typeof vm.name !== 'string' || !vm.name.trim()) return { error: '虚拟模型缺少名称' }
    const name = vm.name.trim()
    if (RESERVED_KEYS.has(name)) return { error: '虚拟模型名不能使用保留键名: ' + name }
    if (vmNames.has(name)) return { error: '虚拟模型名重复: ' + name }
    vmNames.add(name)
    if (models[name]) return { error: '虚拟模型名与真实模型冲突: ' + name }
    if (defaults.model === name) return { error: '虚拟模型名与默认虚拟共用名冲突: ' + name }
    for (const [mn, m] of Object.entries(models)) for (const a of m.alias || []) if (a === name) return { error: '虚拟模型名与模型「' + mn + '」的别名冲突: ' + name }
    if (!Array.isArray(vm.directory) || !vm.directory.length) return { error: '虚拟模型「' + name + '」的目录为空' }
    for (const e of vm.directory) {
      if (!e || typeof e.model !== 'string' || !e.model) return { error: '虚拟模型「' + name + '」目录包含无效项' }
      if (!models[e.model]) return { error: '虚拟模型「' + name + '」目录引用了不存在的模型 ' + e.model }
      for (const pr of (e.providers || [])) if (pr && !providers[pr]) return { error: '虚拟模型「' + name + '」目录引用了不存在的上游 ' + pr }
    }
    for (const f of ['dailyQuota', 'quota', 'maxContext', 'maxConcurrent', 'qps']) if (vm[f] != null && (!Number.isFinite(Number(vm[f])) || Number(vm[f]) < 0)) return { error: '虚拟模型「' + name + '」的 ' + f + ' 必须为非负数字' }
  }
  const cleanVms = vmsIn.map(vm => ({ name: vm.name.trim(), directory: vm.directory.map(e => ({ model: e.model, mode: e.mode === 'onFail' ? 'onFail' : 'afterAll', providers: (e.providers || []).filter(Boolean) })), quota: Number(vm.quota) || 0, dailyQuota: Number(vm.dailyQuota) || 0, maxContext: Number(vm.maxContext) || 0, maxConcurrent: Number(vm.maxConcurrent) || 0, qps: Number(vm.qps) || 0 }))
  // 删除虚拟模型时同步清理其独立 Key 与元数据，防孤儿 key 被同名新建继承
  const removedVms = (cur.virtualModels || []).filter(v => !vmNames.has(v.name))
  // keys 库同步（一次读盘一次写）：clientKey 迁移 / 虚拟模型 meta（expiresAt/note）/ 删除清理
  const keys = Object.assign({}, readKeysFresh(state.paths.keys))
  let keysChanged = false
  if (newClientKey != null) { if (newClientKey) keys.__mg_client = newClientKey; else delete keys.__mg_client; keysChanged = true }
  for (const vmRaw of vmsIn) {
    const vmName = vmRaw.name.trim()
    const mid = '__mg_vm_meta_' + vmName
    const exp = typeof vmRaw.expiresAt === 'string' ? vmRaw.expiresAt.trim() : ''
    const note = typeof vmRaw.note === 'string' ? vmRaw.note.trim() : ''
    const want = (exp || note) ? { expiresAt: exp, note } : null
    const curMeta = keys[mid]
    if (want && (!curMeta || curMeta.expiresAt !== want.expiresAt || curMeta.note !== want.note)) { keys[mid] = want; keysChanged = true }
    else if (!want && curMeta) { delete keys[mid]; keysChanged = true }
  }
  for (const v of removedVms) {
    const kid = '__mg_vm_' + v.name, mid = '__mg_vm_meta_' + v.name
    if (kid in keys) { delete keys[kid]; keysChanged = true }
    if (mid in keys) { delete keys[mid]; keysChanged = true }
  }
  if (keysChanged) {
    const enc = keysEncrypt(keys)
    if (!enc) return { error: '无法加密 keys.local.json：缺少主密钥，已拒绝保存' }
    writeFileSync(state.paths.keys, enc)
    hardenKeyFile(state.paths.keys)
  }
  const newVersion = (cur.configVersion || 0) + 1
  // 删除墓碑（MG-003）：local 是"合并补丁"，缺键无法表达删除；累计记录被删的上游/模型名，
  // 重新加回来时撤销墓碑。虚拟模型整体替换，不需要墓碑。
  const prevLocal = readJson(state.paths.local, {}) || {}
  const prevTomb = (prevLocal._removed && typeof prevLocal._removed === 'object') ? prevLocal._removed : {}
  const removedProviders = new Set(Array.isArray(prevTomb.providers) ? prevTomb.providers : [])
  const removedModels = new Set(Array.isArray(prevTomb.models) ? prevTomb.models : [])
  for (const id of Object.keys(cur.providers || {})) if (!Object.prototype.hasOwnProperty.call(providers || {}, id)) removedProviders.add(id)
  for (const n of Object.keys(cur.models || {})) if (!Object.prototype.hasOwnProperty.call(models || {}, n)) removedModels.add(n)
  for (const id of Object.keys(providers || {})) removedProviders.delete(id)
  for (const n of Object.keys(models || {})) removedModels.delete(n)
  const localOut = { configVersion: newVersion, providers: clean, models: cleanModels, defaults, virtualModels: cleanVms }
  if (removedProviders.size || removedModels.size) localOut._removed = { providers: [...removedProviders], models: [...removedModels] }
  writeJsonAtomic(state.paths.local, localOut)
  reloadConfig(state)
  return { version: newVersion }
}
function saveKeys(state, body) { return withConfigWriteLock(() => doSaveKeys(state, body)) }
async function doSaveKeys(state, body) {
  const _c = versionConflict(state, body); if (_c) return _c
  // 盘上最新 keys 合并（而非内存副本）
  const keyId = typeof body.id === 'string' ? body.id.trim() : ''
  if (!keyId) return { error: '缺少 provider id' }
  if (RESERVED_KEYS.has(keyId)) return { error: '非法的 Key 标识：' + keyId }
  const keys = Object.assign({}, readKeysFresh(state.paths.keys))
  // Key 标识白名单（MG-009 §8.3）：投影里能表达的凭据身份才能写，避免留下 UI 无法删除的孤儿键。
  // 允许并集 = 当前上游 id ∪ 当前虚拟模型 __mg_vm_<name> ∪ 内部键 ∪ keys 库已存在条目（用于清理历史孤儿键）。
  const allowedKeyIds = new Set([
    ...Object.keys(state.cfg.providers || {}),
    ...(state.cfg.virtualModels || []).map((v) => '__mg_vm_' + v.name),
    '__mg_client', '__mg_admin',
    ...Object.keys(keys),
  ])
  if (!allowedKeyIds.has(keyId)) return { error: '未知的 Key 标识：' + keyId }
  // 内部元数据条目（__mg_vm_meta_*）只允许删除/清理，不允许把对象覆盖成字符串 Key
  if (keyId.startsWith('__mg_vm_meta_') && body.key) return { error: '内部元数据条目不可经 /api/keys 写入：' + keyId }
  if (body.key) keys[keyId] = body.key
  else delete keys[keyId]
  const enc = keysEncrypt(keys)
  if (!enc) return { error: '无法加密 keys.local.json：缺少主密钥（MG_KEYS_MASTER 未设置且自动主密钥不可用），已拒绝明文写入' }
  writeFileSync(state.paths.keys, enc)
  hardenKeyFile(state.paths.keys)
  // key 变更同样推进 configVersion（读盘合并 local 顶层，避免覆盖其他字段）
  const newVersion = (state.cfg.configVersion || 0) + 1
  writeJsonAtomic(state.paths.local, Object.assign({}, readJson(state.paths.local, {}), { configVersion: newVersion }))
  reloadConfig(state)
  return { version: newVersion }
}

async function doProbe(state, id) {
  const prov = buildProvider(state.cfg, id)
  const r = await probe(prov)
  const o = (state.stats.byProvider[id] = state.stats.byProvider[id] || { requests:0, errors:0, retries:0, latencySum:0, latencyCount:0, tokens:0 })
  o.probe = { at: Date.now(), ok: r.ok, code: r.code, ms: r.ms, err: r.err || null }
  return { id, ok: r.ok, code: r.code, ms: r.ms, err: r.err || null }
}

// 模型连通测试：用真实模型名向其上游发最小请求，判断能否真正调用
async function doProbeModel(state, model) {
  const def = (state.cfg.models || {})[model]
  if (!def) return { id: model, ok: false, err: '未知模型' }
  let prov
  try { prov = buildProvider(state.cfg, def.provider) } catch (e) { return { id: model, ok: false, err: e.message } }
  if (prov._def.apiKeyEnv && !prov.keyOk && !prov.apiKey) return { id: model, ok: false, err: '上游未配置 Key，无法鉴权' }
  const target = modelTarget(state.cfg, model, def.provider)
  // 能力感知探测（MG-011/012/013）：embedding → /v1/embeddings，rerank → /v1|v2/rerank；
  // audio/image 会真实产生计费媒体，明确不做在线探测；其余走 chat 补全
  const cap = def.capability || 'chat'
  if (cap === 'audio' || cap === 'image' || cap === 'video') return { id: model, ok: false, err: '该能力不提供在线探测（避免产生计费媒体生成）' }
  const r = cap === 'embedding' ? await probeEmbedding(prov, model, target.api, target.servingName)
    : cap === 'rerank' ? await probeRerank(prov, model, target.api, target.servingName)
    : await probeModel(prov, model, target.api, target.servingName)
  const o = (state.stats.byModel[model] = state.stats.byModel[model] || { requests: 0, errors: 0 })
  o.probe = { at: Date.now(), ok: r.ok, code: r.code, ms: r.ms, err: r.err || null }
  return { id: model, ok: r.ok, code: r.code, ms: r.ms, err: r.err || null }
}

// ── 按对话（会话）统计：会话 ID 优先，无 ID 按时间间隔切分兜底 ──
// 解析本次请求归属的对话 ID：优先请求头 X-Conversation-Id / X-Session-Id，其次 body session_id/conversation_id；
// 指标口径（MG-006）：
//   request = 一次进入转发的客户端请求（每个对话 +1 一次，与尝试次数无关）
//   attempt = 每次上游尝试（byProvider.requests / retries）
//   completion = 拿到可交付结果的请求（latencyCount/confirmed）
// token/缓存回调可能对同一请求触发多次，因此只累加数值、绝不重复计请求数。
function ensureDialogue(state, id) {
  const now = Date.now()
  let d = state.dialogue[id]
  if (!d) { d = state.dialogue[id] = { id, requests: 0, tokens: 0, hit: 0, miss: 0, startAt: now, lastAt: now, named: !id.startsWith('conv-') } }
  return d
}
function trimDialogue(state) {
  const keys = Object.keys(state.dialogue)
  if (keys.length <= 80) return
  // 容量保护：保留最近 50 个（含当前无 ID 对话）
  const victims = keys.filter((k) => state.dialogue[k] !== state.dUnnamed).sort((a, b) => state.dialogue[a].lastAt - state.dialogue[b].lastAt).slice(0, keys.length - 50)
  for (const k of victims) delete state.dialogue[k]
}
function tallyDialogueRequest(state, id) {
  if (!id) return
  const d = ensureDialogue(state, id)
  d.requests += 1
  d.lastAt = Date.now()
  trimDialogue(state)
}
function tallyDialogue(state, id, tokens, hit, miss) {
  if (!id) return
  const d = ensureDialogue(state, id)
  d.tokens += tokens || 0
  d.hit += hit || 0
  d.miss += miss || 0
  d.lastAt = Date.now()
  trimDialogue(state)
}

function hardenKeyFile(path) {
  if (!existsSync(path)) return
  try {
    if (process.platform === 'win32') { const u = process.env.USERNAME || 'Everyone'; spawnSync('icacls', [path, '/inheritance:r', '/grant:r', u + ':(F)'], { stdio: 'ignore' }) }
    else { chmodSync(path, 0o600) }
  } catch { /* 尽力而为，失败不阻断 */ }
}
function ensureSt(state, pid) {
  if (!state.stats.byProvider[pid]) state.stats.byProvider[pid] = { requests:0, errors:0, retries:0, latencySum:0, latencyCount:0, tokens:0, lats: [] }
  if (!state.stats.byProvider[pid].lats) state.stats.byProvider[pid].lats = []
  return state.stats.byProvider[pid]
}

function keysFileEncrypted(path) { try { return readFileSync(path, 'utf8').trimStart().startsWith('MG1:') } catch { return false } }
// 数据面客户端 Key：环境变量优先，其次加密 keys 库（__mg_client），最后兼容旧 defaults.clientKey
function currentClientKey(state) { return process.env.MG_CLIENT_KEY || (state.cfg._keys && state.cfg._keys.__mg_client) || (state.cfg.defaults && state.cfg.defaults.clientKey) || '' }

// —— MG-013 媒体上游代理：multipart 原样转发 / 二进制响应 / 体积上限 / 预算与取消 / fallback ——
async function handleMediaProxy(state, budget, log, opts) {
  const { path, modelName, def, binary, makePayload, contentType } = opts
  const limit = mediaResponseLimit(state.cfg)
  const candidates = [def.provider, ...(def.fallbacks || [])].filter(Boolean)
  let lastErr = null
  for (const pid of candidates) {
    if (!state.cfg.providers[pid]) continue
    const prov = buildProvider(state.cfg, pid)
    if (!healthy(ensureHst(state, pid), Date.now())) { lastErr = new Error('provider ' + pid + ' 熔断中'); continue }
    if (prov._def.apiKeyEnv && !prov.keyOk) { lastErr = new Error('provider ' + pid + ' 未配置 Key'); continue }
    const target = modelTarget(state.cfg, modelName, pid)
    if (!supportsMedia(target.api)) { lastErr = new Error('上游协议 ' + target.api + ' 不支持媒体桥接'); continue }
    const payload = makePayload(target)
    const headers = { 'content-type': contentType, 'user-agent': 'model-gateway/0.1', accept: binary ? '*/*' : 'application/json', 'accept-encoding': 'identity' }
    const extra = Object.assign({}, (state.cfg.defaults && state.cfg.defaults.extraHeaders) || {}, prov.extraHeaders || {})
    for (const [k, v] of Object.entries(extra)) headers[String(k).toLowerCase()] = v
    if (prov.apiKey) headers.authorization = 'Bearer ' + prov.apiKey
    headers['content-length'] = payload.length
    let release = null
    try {
      release = await acquireProvider(state, pid, state.cfg, budget.signal)
      const up = await forward(prov, path, 'POST', headers, payload, state.cfg.defaults || {}, log, { budget, signal: budget.signal })
      if (up.ok) {
        let buf
        try {
          buf = await collectBody(up.stream, limit, { budget, signal: budget.signal, destroyOnAbort: true })
        } catch (e) {
          if (e && e.aborted) throw e
          if (/too large/i.test(String(e && e.message))) {
            return { status: 502, contentType: 'application/json; charset=utf-8', buf: Buffer.from(JSON.stringify({ error: { message: '媒体响应超过上限 ' + limit + ' bytes', type: 'media_too_large' } })) }
          }
          throw e
        }
        const ct = (up.headers && up.headers['content-type']) || (binary ? 'application/octet-stream' : 'application/json; charset=utf-8')
        state.st.counters.requests += 1
        agg(state, pid, 'requests', 1)
        const sg = state.stats.byModel[modelName] = state.stats.byModel[modelName] || { requests: 0, errors: 0 }
        sg.requests = (sg.requests || 0) + 1
        if (!binary) {
          const j = tryParse(buf)
          const usage = (j && j.usage) || {}
          const tokens = Number(usage.total_tokens) > 0 ? Number(usage.total_tokens) : (Number(usage.prompt_tokens) > 0 ? Number(usage.prompt_tokens) : 0)
          if (tokens > 0) { sg.tokens = (sg.tokens || 0) + tokens; agg(state, pid, 'tokens', tokens); tallyDaily(state, modelName, tokens, 0, 0, tokens, 0) }
        }
        markOk(state, pid); noteAffinity(state, modelName, pid)
        return { status: up.status, contentType: ct, buf }
      }
      const ebuf = await collectBody(up.stream, 1024 * 1024, { budget, signal: budget.signal, destroyOnAbort: true })
      const mapped = mapErrorEnvelope(target.api, up.status, ebuf) || ebuf
      if (up.status === 402 || up.status === 403 || up.status === 404 || up.status === 429 || up.status >= 500) {
        lastErr = new Error('upstream ' + up.status)
        agg(state, pid, 'errors', 1); state.st.counters.errors += 1
        markFail(state, pid, prov.circuit)
        continue
      }
      return { status: up.status || 502, contentType: 'application/json; charset=utf-8', buf: mapped }
    } catch (err) {
      if (err && err.aborted) throw err
      lastErr = err
      agg(state, pid, 'errors', 1); state.st.counters.errors += 1
      markFail(state, pid, prov.circuit)
    } finally { if (release) release() }
  }
  return { status: 502, contentType: 'application/json; charset=utf-8', buf: Buffer.from(JSON.stringify({ error: { message: '媒体上游失败：' + (lastErr ? lastErr.message : 'all providers failed'), type: 'all_providers_failed' } })) }
}

// —— MG-014 Video 异步任务池（ADR-0001）：创建/轮询/取消；上游只桥接 OpenAI 兼容 ——
function videoJsonHeaders(state, provider, payloadLen) {
  const headers = { 'content-type': 'application/json', 'user-agent': 'model-gateway/0.1', accept: 'application/json', 'accept-encoding': 'identity' }
  const extra = Object.assign({}, (state.cfg.defaults && state.cfg.defaults.extraHeaders) || {}, (provider && provider.extraHeaders) || {})
  for (const [k, v] of Object.entries(extra)) headers[String(k).toLowerCase()] = v
  if (provider && provider.apiKey) headers.authorization = 'Bearer ' + provider.apiKey
  if (payloadLen) headers['content-length'] = payloadLen
  return headers
}
function saveVideos(state, log) { try { saveVideoTasks(state.paths.videos, state.videos) } catch (e) { log && log.warn('videos 落盘失败', e.message) } }

async function createVideoTask(state, budget, log, opts) {
  const { modelName, def, body, idem } = opts
  const paths = defaultVideoPaths(def)
  const candidates = [def.provider, ...(def.fallbacks || [])].filter(Boolean)
  let lastErr = null
  for (const pid of candidates) {
    if (!state.cfg.providers[pid]) continue
    const prov = buildProvider(state.cfg, pid)
    if (!healthy(ensureHst(state, pid), Date.now())) { lastErr = new Error('provider ' + pid + ' 熔断中'); continue }
    if (prov._def.apiKeyEnv && !prov.keyOk) { lastErr = new Error('provider ' + pid + ' 未配置 Key'); continue }
    const target = modelTarget(state.cfg, modelName, pid)
    if (target.api !== 'openai') { lastErr = new Error('上游协议 ' + target.api + ' 不支持 video'); continue }
    const payload = Buffer.from(JSON.stringify(Object.assign({}, body, { model: target.servingName })))
    const headers = videoJsonHeaders(state, prov, payload.length)
    let release = null
    try {
      release = await acquireProvider(state, pid, state.cfg, budget.signal)
      const up = await forward(prov, paths.createPath, 'POST', headers, payload, state.cfg.defaults || {}, log, { budget, signal: budget.signal })
      const outBuf = await collectBody(up.stream, 1024 * 1024, { budget, signal: budget.signal, destroyOnAbort: true })
      if (up.ok) {
        const j = tryParse(outBuf)
        const task = newVideoTask({ model: modelName, provider: pid, idem, prompt: body.prompt })
        task.upstreamId = upstreamTaskId(j)
        applyUpstreamStatus(task, j)
        if (!task.upstreamId && task.status === 'queued') task.error = 'upstream 未返回任务 id，无法轮询'
        state.videos[task.id] = task
        state.st.counters.requests += 1
        agg(state, pid, 'requests', 1)
        const sg = state.stats.byModel[modelName] = state.stats.byModel[modelName] || { requests: 0, errors: 0 }
        sg.requests = (sg.requests || 0) + 1
        markOk(state, pid); noteAffinity(state, modelName, pid)
        saveVideos(state, log)
        return { ok: true, task }
      }
      const mapped = mapErrorEnvelope(target.api, up.status, outBuf) || outBuf
      if (up.status === 402 || up.status === 403 || up.status === 404 || up.status === 429 || up.status >= 500) {
        lastErr = new Error('upstream ' + up.status)
        agg(state, pid, 'errors', 1); state.st.counters.errors += 1
        markFail(state, pid, prov.circuit)
        continue
      }
      return { ok: false, status: up.status || 502, contentType: 'application/json; charset=utf-8', buf: mapped }
    } catch (err) {
      if (err && err.aborted) throw err
      lastErr = err
      agg(state, pid, 'errors', 1); state.st.counters.errors += 1
      markFail(state, pid, prov.circuit)
    } finally { if (release) release() }
  }
  return { ok: false, status: 502, contentType: 'application/json; charset=utf-8', buf: Buffer.from(JSON.stringify({ error: { message: 'video 上游失败：' + (lastErr ? lastErr.message : 'all providers failed'), type: 'all_providers_failed' } })) }
}

async function pollVideoTask(state, task, log) {
  if (!task) return task
  task.lastPollAt = Date.now()
  if (['succeeded', 'failed', 'canceled'].includes(task.status)) { saveVideos(state, log); return task }
  const def = state.cfg.models && state.cfg.models[task.model]
  if (!def) { task.status = 'failed'; task.error = '模型已删除'; task.updatedAt = Date.now(); saveVideos(state, log); return task }
  let prov = null
  try { prov = buildProvider(state.cfg, task.provider) } catch { prov = null }
  if (!prov) { task.status = 'failed'; task.error = '上游已删除'; task.updatedAt = Date.now(); saveVideos(state, log); return task }
  if (!task.upstreamId) { task.updatedAt = Date.now(); saveVideos(state, log); return task }
  const paths = defaultVideoPaths(def)
  const path = paths.statusPath.replace('{id}', encodeURIComponent(task.upstreamId))
  try {
    const up = await forward(prov, path, 'GET', videoJsonHeaders(state, prov, 0), null, state.cfg.defaults || {}, log)
    const buf = await collectBody(up.stream, 1024 * 1024, { destroyOnAbort: true })
    if (up.ok) applyUpstreamStatus(task, tryParse(buf))
    else if (up.status === 404) { task.status = 'failed'; task.error = '上游任务不存在'; task.updatedAt = Date.now() }
    else task.error = 'poll HTTP ' + up.status
  } catch (e) { task.error = 'poll failed: ' + (e && (e.message || e.code) ? (e.message || e.code) : e) }
  task.lastPollAt = Date.now(); task.updatedAt = Date.now()
  saveVideos(state, log)
  return task
}

async function cancelVideoTask(state, task, log) {
  if (!task) return task
  if (task.status === 'succeeded' || task.status === 'failed' || task.status === 'canceled') return task
  const def = state.cfg.models && state.cfg.models[task.model]
  if (def && task.upstreamId) {
    const paths = defaultVideoPaths(def)
    let prov = null
    try { prov = buildProvider(state.cfg, task.provider) } catch { prov = null }
    if (prov) {
      const path = paths.cancelPath.replace('{id}', encodeURIComponent(task.upstreamId))
      try {
        const up = await forward(prov, path, 'POST', videoJsonHeaders(state, prov, 0), null, state.cfg.defaults || {}, log)
        try { await collectBody(up.stream, 1024 * 1024, { destroyOnAbort: true }) } catch {}
      } catch (e) { log && log.warn('video 上游取消失败（本地仍标记 canceled）', e.message || e.code) }
    }
  }
  task.status = 'canceled'; task.updatedAt = Date.now(); saveVideos(state, log)
  return task
}

const FWD_DEPS = { ensureHst, markFail, markOk, healthy, effState: (h, now) => (h.state === 'open' && h.openUntil <= now) ? 'half' : h.state, agg, ensureSt, noteAffinity, noteCacheStat, tallyDaily, tallyVirtual, tallyDialogue, tallyDialogueRequest, tryParse, collectBody }
function makeHandler(state) {
  const log = state.log
  const logFile = () => state.cfg.server && state.cfg.server.logFile
  async function requireAdmin(req, res) {
    if (!adminOk(req, state)) {
      sendJson(res, 401, { error: '未授权：请在控制面板设置管理令牌（MG_ADMIN_TOKEN）' })
      return false
    }
    // 未配置令牌时的"本地初始化"不能延伸到网络：远程管理请求必须先有令牌（MG-001）
    if (!state.adminToken && !isLoopbackPeer(req)) {
      sendJson(res, 403, { error: '拒绝远程管理请求：本实例未启用管理令牌，管理 API 仅允许本机访问；请先在本机设置 MG_ADMIN_TOKEN（或 server.adminToken）' })
      return false
    }
    return true
  }
  return async function handler(req, res) {
    const path = (req.url || '/').split('?')[0]
    const url = req.url || '/'
    const isApi = path === '/api' || path.startsWith('/api/')
    let budget = null
    let responsesMode = false
    let responsesMeta = null
    let responsesSession = null
    try {
      // 来源校验：先 Host（DNS 重绑定），再 Origin（跨源网页）。两者都只放行显式声明的部署形态。
      if (!hostAllowed(req, state.cfg)) { denyOrigin(res, path, 'Host 不被接受：' + String(req.headers.host || '') + '（DNS 重绑定防护；反向代理/自定义域名请加入 server.allowedHosts）'); return }
      if ((isApi && !originAllowed(req, state.cfg)) || (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin && !originAllowed(req, state.cfg))) {
        denyOrigin(res, path, '跨源请求被拒绝：' + String(req.headers.origin || '') + '（同源或 server.allowedOrigins 白名单之外）')
        return
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && path === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return }
      if (req.method === 'GET' && path === '/favicon.ico') { res.writeHead(204); res.end(); return }
      if (req.method === 'GET' && (path === '/' || path === '/admin' || path === '/admin.html')) {
        let html
        try { html = readFileSync(ADMIN_PAGE, 'utf8') } catch { html = '<h1>admin 页面缺失：src/admin.html 未找到</h1>' }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(html); return
      }
      if (path === '/api/auth' && req.method === 'GET') { sendJson(res, 200, { needAuth: !!state.adminToken, startedAt: state.st.startedAt }); return }

      // 面板设置管理令牌：写入加密 keys 库并热生效。未启用鉴权时开放（本地初始化）；已启用时需携带当前令牌。
      if (path === '/api/admin-token' && req.method === 'POST') {
        if (state.adminToken && !adminOk(req, state)) { sendJson(res, 401, { error: '未授权：修改管理令牌需携带当前令牌' }); return }
        if (!state.adminToken && !isLoopbackPeer(req)) { sendJson(res, 403, { error: '拒绝远程初始化：未启用管理令牌时只允许本机设置令牌（MG_ADMIN_TOKEN）' }); return }
        const body = tryParse(await collectBody(req, (state.cfg.server && state.cfg.server.maxBodyBytes) || 32 * 1024 * 1024)) || {}
        const token = typeof body.token === 'string' ? body.token.trim() : ''
        const keys = Object.assign({}, state.cfg._keys)
        if (token) keys.__mg_admin = token
        else delete keys.__mg_admin
        const enc = keysEncrypt(keys)
        if (!enc) { sendJson(res, 400, { error: '无法加密 keys.local.json：缺少主密钥，已拒绝写入' }); return }
        writeFileSync(state.paths.keys, enc)
        hardenKeyFile(state.paths.keys)
        reloadConfig(state)
        sendJson(res, 200, { ok: true, needAuth: !!state.adminToken })
        return
      }

      if (path === '/api/status' && req.method === 'GET') { if (!await requireAdmin(req, res)) return; sendJson(res, 200, buildStatus(state)); return }
      if (path === '/api/model-stats' && req.method === 'GET') { if (!await requireAdmin(req, res)) return; const days = Math.min(90, Math.max(1, parseInt(new URL(url, 'http://x').searchParams.get('days') || '7', 10) || 7)); const out = {}; const now = new Date(); const modelNames = Object.keys(state.cfg.models || {}); const pt = (c) => ({ tokens: c ? c.tokens : 0, inTokens: c ? (c.inTokens || 0) : 0, outTokens: c ? (c.outTokens || 0) : 0, hit: c ? (c.hit || 0) : 0, miss: c ? (c.miss || 0) : 0, hitRate: (c && (c.hit + c.miss) > 0) ? Math.round((c.hit / (c.hit + c.miss)) * 1000) / 10 : null }); if (days === 1) { for (const name of modelNames) { const mh = state.stats.hourly[name] || {}; const arr = []; for (let i2 = 23; i2 >= 0; i2--) { const hd = new Date(now.getTime() - i2 * 3600 * 1000); const hk = todayKey(hd) + ':' + String(hd.getHours()).padStart(2, '0'); arr.push(Object.assign({ date: String(hd.getHours()).padStart(2, '0') + ':00' }, pt(mh[hk]))) } out[name] = arr } } else { for (const name of modelNames) { const md = state.stats.daily[name] || {}; const arr = []; for (let i2 = days - 1; i2 >= 0; i2--) { const d = new Date(now); d.setDate(d.getDate() - i2); const k = todayKey(d); arr.push(Object.assign({ date: k }, pt(md[k]))) } out[name] = arr } } sendJson(res, 200, { days, mode: days === 1 ? 'hourly' : 'daily', models: out }); return }
      if (path === '/api/route-preview' && req.method === 'POST') {
        if (!await requireAdmin(req, res)) return
        const body = tryParse(await collectBody(req, (state.cfg.server && state.cfg.server.maxBodyBytes) || 32 * 1024 * 1024)) || {}
        const model = String(body.model || '').trim()
        if (!model) { sendJson(res, 400, { error: '缺少 model' }); return }
        let hit
        try { hit = state.router.resolve(model) } catch (e) { sendJson(res, 200, { ok: true, hit: { type: 'unknown', model, note: e.message } }); return }
        const vms = state.cfg.virtualModels || []
        if (hit.def.isVirtualModel) {
          const items = hit.def.directory.map(e => {
            const _m = state.cfg.models
            const provs = (e.providers && e.providers.length ? e.providers : (_m && _m[e.model] ? [_m[e.model].provider, ...(_m[e.model].fallbacks || [])] : []))
            return { model: e.model, mode: e.mode, providers: provs, limit: routeLimit(state, state.cfg, e.model, null) }
          })
          sendJson(res, 200, { ok: true, hit: { type: 'virtual', name: hit.def.name, directory: items, quota: hit.def.quota, dailyQuota: hit.def.dailyQuota, used: (state.stats.byModel[hit.def.name] || {}).tokens || 0, quotaState: virtualQuotaExceeded(state, hit.def) } }); return
        }
        if (hit.def.virtual) { sendJson(res, 200, { ok: true, hit: { type: 'defaults', name: hit.canonicalName, directory: state.cfg.defaults.directory || [] } }); return }
        sendJson(res, 200, { ok: true, hit: { type: hit.known ? 'model' : 'unknown', name: hit.canonicalName, provider: hit.def.provider || null, note: hit.known ? null : (vms.length ? '将返回 404（已配置虚拟模型）' : '将走默认上游兜底') } }); return
      }
      if (path === '/api/logs' && req.method === 'GET') { if (!await requireAdmin(req, res)) return; const lines = parseInt(new URL(url, 'http://x').searchParams.get('lines') || '200', 10) || 200; sendJson(res, 200, { lines: readLogTail((log && log.file) ? log.file() : logFile(), lines) }); return }
      if (path === '/api/config/reload' && req.method === 'POST') { if (!await requireAdmin(req, res)) return; reloadConfig(state); sendJson(res, 200, { ok: true }); return }
      if (path === '/api/config/save' && req.method === 'POST') {
        if (!await requireAdmin(req, res)) return
        const body = tryParse(await collectBody(req, (state.cfg.server && state.cfg.server.maxBodyBytes) || 32 * 1024 * 1024))
        if (!isPlainObject(body)) { sendJson(res, 400, { error: '请求体必须为 JSON 对象' }); return }
        const r = await saveConfig(state, body)
        if (r.error) { sendJson(res, 400, { error: r.error }); return }
        if (r.conflict) { sendJson(res, 409, { error: '配置版本已过期（他处已保存过新版本），请刷新后重试', currentVersion: r.currentVersion }); return }
        sendJson(res, 200, { ok: true, status: buildStatus(state) }); return
      }
      if (path === '/api/keys' && req.method === 'POST') {
        if (!await requireAdmin(req, res)) return
        const body = tryParse(await collectBody(req, (state.cfg.server && state.cfg.server.maxBodyBytes) || 32 * 1024 * 1024))
        if (!body || !body.id) { sendJson(res, 400, { error: '缺少 provider id' }); return }
        const kr = await saveKeys(state, body)
        if (kr.error) { sendJson(res, 400, { error: kr.error }); return }
        if (kr.conflict) { sendJson(res, 409, { error: '配置版本已过期（他处已保存过新版本），请刷新后重试', currentVersion: kr.currentVersion }); return }
        sendJson(res, 200, { ok: true, status: buildStatus(state) }); return
      }
      if (path === '/api/probe' && req.method === 'POST') {
        if (!await requireAdmin(req, res)) return
        const body = tryParse(await collectBody(req, (state.cfg.server && state.cfg.server.maxBodyBytes) || 32 * 1024 * 1024)) || {}
        const ids = body.id ? [String(body.id)] : Object.keys(state.cfg.providers || {})
        const results = []
        for (const id of ids) if (state.cfg.providers[id]) results.push(await doProbe(state, id))
        sendJson(res, 200, { ok: true, results, status: buildStatus(state) }); return
      }
      if (path === '/api/model-test' && req.method === 'POST') {
        if (!await requireAdmin(req, res)) return
        const body = tryParse(await collectBody(req, (state.cfg.server && state.cfg.server.maxBodyBytes) || 32 * 1024 * 1024)) || {}
        const id = String(body.id || '')
        if (id) {
          if (!(state.cfg.models || {})[id]) { sendJson(res, 400, { error: '未知模型: ' + id }); return }
          const r = await doProbeModel(state, id)
          sendJson(res, 200, { ok: true, result: r, status: buildStatus(state) }); return
        }
        // 无 id → 批量测全部模型（与 /api/probe 对齐）
        const results = []
        for (const mid of Object.keys(state.cfg.models || {})) results.push(await doProbeModel(state, mid))
        sendJson(res, 200, { ok: true, results, status: buildStatus(state) }); return
      }

      // —— 数据面请求预算（MG-002）：从进入数据面起算，覆盖排队/代理 CONNECT/读 body/等头/流式/续传 ——
      const _to = (state.cfg.defaults && state.cfg.defaults.timeout) || {}
      budget = createBudget({ overallMs: _to.overallMs || 0 })
      const onClientGone = () => { if (!res.writableEnded) budget.abort('client_closed') }
      try { res.on('close', onClientGone); req.on('aborted', onClientGone) } catch {}
      if (res.destroyed || req.aborted) budget.abort('client_closed')   // 注册监听前已断开：立即取消

      // Global credentials grant access to every model. A virtual credential only
      // grants its named entry, including when no global credential is configured.
      const clientKey = currentClientKey(state)
      const globalAuthorized = clientKey && clientAuthOk(req, clientKey)
      if (!globalAuthorized) {
        let vm = null
        const vms = state.cfg.virtualModels || []
        if (vms.length && (CHAT_PATHS.has(path) || RESPONSES_PATHS.has(path)) && (req.method === 'POST' || req.method === 'PUT')) {
          req.__mgBodyBuf = await collectBody(req, (state.cfg.server && state.cfg.server.maxBodyBytes) || 32 * 1024 * 1024, { budget, signal: budget.signal })
          req.__mgBody = tryParse(req.__mgBodyBuf)
          const model = req.__mgBody && req.__mgBody.model
          vm = vms.find(v => v.name === (typeof model === 'string' ? model.trim() : ''))
        }
        const vmKey = vm && state.cfg._keys && state.cfg._keys['__mg_vm_' + vm.name]
        const meta = vm && state.cfg._keys && state.cfg._keys['__mg_vm_meta_' + vm.name]
        const expired = meta && meta.expiresAt && Date.now() > Number(meta.expiresAt)
        if ((clientKey || vmKey) && !(vmKey && !expired && clientAuthOk(req, vmKey))) {
          sendJson(res, 401, { error: { message: '无效的客户端接入 Key（状态 401）', type: 'unauthorized' } })
          return
        }
      }

      if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) { sendJson(res, 200, staticModels(state.cfg)); return }

      // —— MG-011：POST /v1/embeddings（能力声明 + 上游适配 + 记账 + 熔断/回退） ——
      if (path === '/v1/embeddings') {
        if (req.method !== 'POST') { sendJson(res, 405, { error: { message: '仅支持 POST /v1/embeddings', type: 'invalid_request_error' } }); return }
        const ebuf = await collectBody(req, ((state.cfg.server && state.cfg.server.maxBodyBytes) || 32 * 1024 * 1024), { budget, signal: budget.signal })
        const ebody = tryParse(ebuf)
        const verr = validateEmbeddingRequest(ebody)
        if (verr) { sendJson(res, 400, { error: { message: verr.error, type: 'invalid_request_error' } }); return }
        const hit = state.router.resolve(ebody.model)
        if (!hit.known && (state.cfg.virtualModels || []).length) { sendJson(res, 404, { error: { message: '未知模型名: ' + ebody.model + '。可用虚拟模型见 GET /v1/models', type: 'unknown_model' } }); return }
        const edef = hit.def || null
        if (!edef || edef.isVirtualModel || edef.virtual) { sendJson(res, 400, { error: { message: '虚拟模型/默认共用名不支持 embeddings', type: 'unsupported_model' } }); return }
        const cap = edef.capability || 'chat'
        if (cap !== 'embedding') { sendJson(res, 400, { error: { message: '模型 ' + hit.canonicalName + ' 不是 embedding 模型（capability=' + cap + '）', type: 'unsupported_model' } }); return }
        const candidates = [edef.provider, ...(edef.fallbacks || [])].filter(Boolean)
        let lastErr = null
        for (const pid of candidates) {
          if (!state.cfg.providers[pid]) continue
          const prov = buildProvider(state.cfg, pid)
          if (!healthy(ensureHst(state, pid), Date.now())) { lastErr = new Error('provider ' + pid + ' 熔断中'); continue }
          if (prov._def.apiKeyEnv && !prov.keyOk) { lastErr = new Error('provider ' + pid + ' 未配置 Key'); continue }
          const target = modelTarget(state.cfg, hit.canonicalName, pid)
          if (!supportsEmbeddings(target.api)) { lastErr = new Error('上游协议 ' + target.api + ' 不支持 embeddings'); continue }
          const spec = buildEmbeddingRequest(target.api, Object.assign({}, ebody, { model: target.servingName }))
          const payload = Buffer.from(JSON.stringify(spec.body))
          const headers = embeddingHeaders(state.cfg, prov, target.api, payload)
          let release = null
          try {
            release = await acquireProvider(state, pid, state.cfg, budget.signal)
            const up = await forward(prov, spec.path, 'POST', headers, payload, state.cfg.defaults || {}, log, { budget, signal: budget.signal })
            const outBuf = await collectBody(up.stream, undefined, { budget, signal: budget.signal, destroyOnAbort: true })
            if (up.ok) {
              const j = tryParse(outBuf)
              const norm = normalizeEmbeddingResponse(target.api, j, hit.canonicalName)
              const usage = (j && j.usage) || (norm && norm.usage) || {}
              const tokens = Number(usage.total_tokens) > 0 ? Number(usage.total_tokens) : (Number(usage.prompt_tokens) > 0 ? Number(usage.prompt_tokens) : 0)
              state.st.counters.requests += 1
              agg(state, pid, 'requests', 1)   // agg 同时累加 global 与 provider，避免重复计数
              const sg = state.stats.byModel[hit.canonicalName] = state.stats.byModel[hit.canonicalName] || { requests: 0, errors: 0 }
              sg.requests = (sg.requests || 0) + 1
              if (tokens > 0) { sg.tokens = (sg.tokens || 0) + tokens; agg(state, pid, 'tokens', tokens); tallyDaily(state, hit.canonicalName, tokens, 0, 0, tokens, 0) }
              markOk(state, pid); noteAffinity(state, hit.canonicalName, pid)
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(norm)); return
            }
            const mapped = mapErrorEnvelope(target.api, up.status, outBuf) || outBuf
            // 402/403/404/429/5xx 视为该上游不可用 → 记录并切 fallback；其余 4xx 是请求参数/模型级确定性错误，直接回
            if (up.status === 402 || up.status === 403 || up.status === 404 || up.status === 429 || up.status >= 500) {
              lastErr = new Error('upstream ' + up.status)
              agg(state, pid, 'errors', 1); state.st.counters.errors += 1
              markFail(state, pid, prov.circuit)
              continue
            }
            res.writeHead(up.status || 502, { 'content-type': 'application/json; charset=utf-8' }); res.end(mapped); return
          } catch (err) {
            if (err && err.aborted) throw err
            lastErr = err
            agg(state, pid, 'errors', 1); state.st.counters.errors += 1
            markFail(state, pid, prov.circuit)
          } finally { if (release) release() }
        }
        sendJson(res, 502, { error: { message: 'embeddings 上游失败：' + (lastErr ? lastErr.message : 'all providers failed'), type: 'all_providers_failed' } }); return
      }

      // —— MG-012：POST /v1/rerank（capability=rerank；OpenAI 兼容 /v1/rerank 与 Cohere /v2/rerank） ——
      if (path === '/v1/rerank' || path === '/rerank') {
        if (req.method !== 'POST') { sendJson(res, 405, { error: { message: '仅支持 POST /v1/rerank', type: 'invalid_request_error' } }); return }
        const rbuf = await collectBody(req, ((state.cfg.server && state.cfg.server.maxBodyBytes) || 32 * 1024 * 1024), { budget, signal: budget.signal })
        const rbody = tryParse(rbuf)
        const rerr = validateRerankRequest(rbody)
        if (rerr) { sendJson(res, 400, { error: { message: rerr.error, type: 'invalid_request_error' } }); return }
        const rhit = state.router.resolve(rbody.model)
        if (!rhit.known && (state.cfg.virtualModels || []).length) { sendJson(res, 404, { error: { message: '未知模型名: ' + rbody.model, type: 'unknown_model' } }); return }
        const rdef = rhit.def || null
        if (!rdef || rdef.isVirtualModel || rdef.virtual) { sendJson(res, 400, { error: { message: '虚拟模型/默认共用名不支持 rerank', type: 'unsupported_model' } }); return }
        const rcap = rdef.capability || 'chat'
        if (rcap !== 'rerank') { sendJson(res, 400, { error: { message: '模型 ' + rhit.canonicalName + ' 不是 rerank 模型（capability=' + rcap + '）', type: 'unsupported_model' } }); return }
        const rcands = [rdef.provider, ...(rdef.fallbacks || [])].filter(Boolean)
        let rLastErr = null
        for (const pid of rcands) {
          if (!state.cfg.providers[pid]) continue
          const prov = buildProvider(state.cfg, pid)
          if (!healthy(ensureHst(state, pid), Date.now())) { rLastErr = new Error('provider ' + pid + ' 熔断中'); continue }
          if (prov._def.apiKeyEnv && !prov.keyOk) { rLastErr = new Error('provider ' + pid + ' 未配置 Key'); continue }
          const target = modelTarget(state.cfg, rhit.canonicalName, pid)
          if (!supportsRerank(target.api)) { rLastErr = new Error('上游协议 ' + target.api + ' 不支持 rerank'); continue }
          const spec = buildRerankRequest(target.api, Object.assign({}, rbody, { model: target.servingName }))
          const payload = Buffer.from(JSON.stringify(spec.body))
          const headers = rerankHeaders(state.cfg, prov, target.api, payload)
          let release = null
          try {
            release = await acquireProvider(state, pid, state.cfg, budget.signal)
            const up = await forward(prov, spec.path, 'POST', headers, payload, state.cfg.defaults || {}, log, { budget, signal: budget.signal })
            const outBuf = await collectBody(up.stream, undefined, { budget, signal: budget.signal, destroyOnAbort: true })
            if (up.ok) {
              const j = tryParse(outBuf)
              const norm = normalizeRerankResponse(target.api, j, rhit.canonicalName, { topN: rbody.top_n })
              const usage = (j && j.usage) || {}
              const tokens = Number(usage.total_tokens) > 0 ? Number(usage.total_tokens) : (Number(usage.prompt_tokens) > 0 ? Number(usage.prompt_tokens) : 0)
              state.st.counters.requests += 1
              agg(state, pid, 'requests', 1)
              const sg = state.stats.byModel[rhit.canonicalName] = state.stats.byModel[rhit.canonicalName] || { requests: 0, errors: 0 }
              sg.requests = (sg.requests || 0) + 1
              if (tokens > 0) { sg.tokens = (sg.tokens || 0) + tokens; agg(state, pid, 'tokens', tokens); tallyDaily(state, rhit.canonicalName, tokens, 0, 0, tokens, 0) }
              markOk(state, pid); noteAffinity(state, rhit.canonicalName, pid)
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(norm)); return
            }
            const mapped = mapErrorEnvelope(target.api, up.status, outBuf) || outBuf
            if (up.status === 402 || up.status === 403 || up.status === 404 || up.status === 429 || up.status >= 500) {
              rLastErr = new Error('upstream ' + up.status)
              agg(state, pid, 'errors', 1); state.st.counters.errors += 1
              markFail(state, pid, prov.circuit)
              continue
            }
            res.writeHead(up.status || 502, { 'content-type': 'application/json; charset=utf-8' }); res.end(mapped); return
          } catch (err) {
            if (err && err.aborted) throw err
            rLastErr = err
            agg(state, pid, 'errors', 1); state.st.counters.errors += 1
            markFail(state, pid, prov.circuit)
          } finally { if (release) release() }
        }
        sendJson(res, 502, { error: { message: 'rerank 上游失败：' + (rLastErr ? rLastErr.message : 'all providers failed'), type: 'all_providers_failed' } }); return
      }

      // —— MG-013：Audio / Image 媒体桥接（multipart 原样转发、二进制响应、体积/预算/取消） ——
      if (path === '/v1/audio/speech' || path === '/v1/audio/transcriptions' || path === '/v1/images/generations' || path === '/v1/images/edits') {
        if (req.method !== 'POST') { sendJson(res, 405, { error: { message: '仅支持 POST ' + path, type: 'invalid_request_error' } }); return }
        const multipartPath = path.endsWith('/transcriptions') || path.endsWith('/edits')
        const ctype = String(req.headers['content-type'] || (multipartPath ? '' : 'application/json'))
        const maxBody = (state.cfg.server && state.cfg.server.maxBodyBytes) || 32 * 1024 * 1024
        let raw = null
        let body = null
        let modelName = ''
        if (multipartPath) {
          if (!isMultipart(ctype)) { sendJson(res, 400, { error: { message: '需要 multipart/form-data（含 model 字段与文件）', type: 'invalid_request_error' } }); return }
          raw = await collectBody(req, maxBody, { budget, signal: budget.signal })
          modelName = parseMultipartField(raw, ctype, 'model') || ''
          if (!modelName) { sendJson(res, 400, { error: { message: 'multipart 缺少 model 字段', type: 'invalid_request_error' } }); return }
        } else {
          raw = await collectBody(req, maxBody, { budget, signal: budget.signal })
          body = tryParse(raw)
          const verr = path === '/v1/audio/speech' ? validateSpeechRequest(body) : validateImageRequest(body)
          if (verr) { sendJson(res, 400, { error: { message: verr.error, type: 'invalid_request_error' } }); return }
          modelName = body.model
        }
        const mhit = state.router.resolve(modelName)
        if (!mhit.known && (state.cfg.virtualModels || []).length) { sendJson(res, 404, { error: { message: '未知模型名: ' + modelName + '。可用虚拟模型见 GET /v1/models', type: 'unknown_model' } }); return }
        const mdef = mhit.def || null
        if (!mdef || mdef.isVirtualModel || mdef.virtual) { sendJson(res, 400, { error: { message: '虚拟模型/默认共用名不支持媒体能力', type: 'unsupported_model' } }); return }
        const wantCap = path.startsWith('/v1/audio/') ? 'audio' : 'image'
        const haveCap = mdef.capability || 'chat'
        if (haveCap !== wantCap) { sendJson(res, 400, { error: { message: '模型 ' + mhit.canonicalName + ' 的能力是 ' + haveCap + '，不能用于 ' + wantCap + ' 入口', type: 'unsupported_model' } }); return }
        const binary = path === '/v1/audio/speech'
        const result = await handleMediaProxy(state, budget, log, {
          path,
          modelName: mhit.canonicalName,
          def: mdef,
          binary,
          contentType: ctype || 'application/json',
          // per-上游模型名覆盖：JSON 重建；multipart 只替换 model 字段，文件字节不动
          makePayload: (target) => multipartPath
            ? (replaceMultipartField(raw, ctype, 'model', target.servingName) || raw)
            : Buffer.from(JSON.stringify(Object.assign({}, body, { model: target.servingName }))),
        })
        res.writeHead(result.status, { 'content-type': result.contentType, 'content-length': result.buf.length })
        res.end(result.buf); return
      }

      // —— MG-014：Video 异步任务池（ADR-0001）：创建 / 列表 / 查询 / 取消 ——
      if (path === '/v1/videos' && req.method === 'POST') {
        const vmax = (state.cfg.server && state.cfg.server.maxBodyBytes) || 32 * 1024 * 1024
        const vbuf = await collectBody(req, vmax, { budget, signal: budget.signal })
        const vbody = tryParse(vbuf)
        const verr = validateVideoCreate(vbody)
        if (verr) { sendJson(res, 400, { error: { message: verr.error, type: 'invalid_request_error' } }); return }
        const vhit = state.router.resolve(vbody.model)
        if (!vhit.known && (state.cfg.virtualModels || []).length) { sendJson(res, 404, { error: { message: '未知模型名: ' + vbody.model + '。可用虚拟模型见 GET /v1/models', type: 'unknown_model' } }); return }
        const vdef = vhit.def || null
        if (!vdef || vdef.isVirtualModel || vdef.virtual) { sendJson(res, 400, { error: { message: '虚拟模型/默认共用名不支持 video', type: 'unsupported_model' } }); return }
        const vcap = vdef.capability || 'chat'
        if (vcap !== 'video') { sendJson(res, 400, { error: { message: '模型 ' + vhit.canonicalName + ' 不是 video 模型（capability=' + vcap + '）', type: 'unsupported_model' } }); return }
        const idem = String(req.headers['idempotency-key'] || '').trim() || null
        const existing = findTaskByIdem(state.videos, idem)
        if (existing) { sendJson(res, 200, clientTask(existing)); return }   // 幂等：同 key 不重复创建/不重复计上游
        const created = await createVideoTask(state, budget, log, { modelName: vhit.canonicalName, def: vdef, body: vbody, idem })
        if (created.ok) { sendJson(res, 202, clientTask(created.task)); return }
        res.writeHead(created.status, { 'content-type': created.contentType }); res.end(created.buf); return
      }
      if (path === '/v1/videos' && req.method === 'GET') {
        const list = Object.values(state.videos).sort((a, b) => b.createdAt - a.createdAt).slice(0, 50).map(clientTask)
        sendJson(res, 200, { object: 'list', data: list }); return
      }
      const vmatch = /^\/v1\/videos\/([^/]+)(\/cancel)?$/.exec(path)
      if (vmatch) {
        const vid = decodeURIComponent(vmatch[1])
        const task = state.videos[vid]
        if (!task) { sendJson(res, 404, { error: { message: '未知视频任务: ' + vid, type: 'not_found' } }); return }
        if (vmatch[2] === '/cancel') {
          if (req.method !== 'POST') { sendJson(res, 405, { error: { message: '仅支持 POST /v1/videos/:id/cancel', type: 'invalid_request_error' } }); return }
          await cancelVideoTask(state, task, log)
          sendJson(res, 200, clientTask(task)); return
        }
        if (req.method !== 'GET') { sendJson(res, 405, { error: { message: '仅支持 GET /v1/videos/:id', type: 'invalid_request_error' } }); return }
        if (!['succeeded', 'failed', 'canceled'].includes(task.status) && Date.now() - (task.lastPollAt || 0) >= VIDEO_POLL_MIN_MS) await pollVideoTask(state, task, log)
        sendJson(res, 200, clientTask(task)); return
      }
      const isChat = CHAT_PATHS.has(path)
      const isResponses = RESPONSES_PATHS.has(path)
      if (!path.startsWith('/v1') && !isChat && !isResponses) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return }
      if (isResponses && req.method !== 'POST') { sendJson(res, 405, { error: { message: '仅支持 POST /v1/responses', type: 'invalid_request_error' } }); return }

      // —— 数据面转发（二阶段鉴权已收集 body 时直接复用，流不可二次读取） ——
      let bodyBuf = req.__mgBodyBuf || null
      if (!bodyBuf && (req.method === 'POST' || req.method === 'PUT')) bodyBuf = await collectBody(req, ((state.cfg.server && state.cfg.server.maxBodyBytes) || 32 * 1024 * 1024), { budget, signal: budget.signal })
      let body = req.__mgBody || (bodyBuf && bodyBuf.length ? tryParse(bodyBuf) : null)
      if ((isChat || isResponses) && (!body || typeof body !== 'object' || Array.isArray(body))) {
        sendJson(res, 400, { error: { message: '请求体必须为 JSON 对象', type: 'invalid_request_error' } })
        return
      }
      // —— MG-015：/v1/responses 入口（Chat 桥）。原生 api:"responses" 透传尚未实现，见契约 §3 ——
      if (isResponses) {
        const conv = responsesToChat(body)
        if (conv.rejected) {
          sendJson(res, 400, { error: { message: conv.rejected.message, type: conv.rejected.code || 'unsupported_parameter' } })
          return
        }
        responsesMode = true
        responsesMeta = {
          model: body.model,
          stream: !!body.stream,
          customToolNames: (Array.isArray(body.tools) ? body.tools : []).filter((t) => t && t.type === 'custom' && typeof t.name === 'string').map((t) => t.name),
          lossy: conv.lossy || [],
        }
        if (responsesMeta.lossy.length) log && log.info('responses 有损转换', responsesMeta.lossy.slice(0, 20).join(','))
        // 关键：既换内存 body，也换 bodyBuf —— forwardChain 对 OpenAI 上游默认透传原始 bodyBuf
        body = conv.body
        bodyBuf = Buffer.from(JSON.stringify(body))
      }
      // 入口路径别名：把不带 /v1 的 Chat 兼容路径/Responses 桥统一规范化为 /v1/chat/completions 发给上游
      const fPath = ((isChat || isResponses) && path !== '/v1/chat/completions') ? '/v1/chat/completions' : path
      const fUrl = (fPath === path) ? url : (fPath + url.slice(path.length))
      // 中继参数（Chat 与 Responses 共用）：token/缓存记账按 meta 里的实际上游/模型归属
      const relayOptsFor = (m, reconnect) => ({
        idleMs: (state.cfg.defaults && state.cfg.defaults.timeout && state.cfg.defaults.timeout.idleMs) || 0,
        maxReconnects: 2, log, reconnect, signal: budget.signal, budget,
        protocol: m.api || 'openai', extract: (m.api && m.api !== 'openai') ? adapterFor(m.api).extractStreamContent : undefined, extractFinish: (m.api && m.api !== 'openai') ? adapterFor(m.api).extractStreamFinish : undefined,
        rewriteModel: m.rewriteModel || null, // 「名字没对上」：响应 model 回写为客户端请求名
        onTokens: (n, usage) => {
          const _u = usage || {}; const _inTk = (typeof _u.prompt_tokens === 'number' && _u.prompt_tokens > 0 ? _u.prompt_tokens : 0) || (typeof _u.input_tokens === 'number' && _u.input_tokens > 0 ? _u.input_tokens : 0); const _outTk = (typeof _u.completion_tokens === 'number' && _u.completion_tokens > 0 ? _u.completion_tokens : 0) || (typeof _u.output_tokens === 'number' && _u.output_tokens > 0 ? _u.output_tokens : 0); const total = (typeof _u.total_tokens === 'number' && _u.total_tokens > 0 ? _u.total_tokens : 0) || (_inTk + _outTk) || n
          // 输入/输出 token：流末 usage 有则取（多数 OpenAI 兼容上游流末帧带），无则记 0（不臆造）；命中+未命中=输入
          if (total > 0) { agg(state, m.pid, 'tokens', total); const sm = m.serving || m.modelName; const sg = state.stats.byModel[sm] = state.stats.byModel[sm] || { requests: 0, errors: 0 }; sg.tokens = (sg.tokens || 0) + total; sg.inTokens = (sg.inTokens || 0) + _inTk; sg.outTokens = (sg.outTokens || 0) + _outTk; tallyDaily(state, sm, total, 0, 0, _inTk, _outTk); tallyVirtual(state, m.modelName, m.serving, total, _inTk, _outTk); tallyDialogue(state, m.dialogueId, total, 0, 0) }
        },
        onUsage: (u) => { const c = cacheHitMiss(m.api, u); if (c.hit > 0 || c.miss > 0) { const sm = m.serving || m.modelName; noteCacheStat(state, sm, m.pid, c.hit, c.miss); tallyDaily(state, sm, 0, c.hit, c.miss); tallyDialogue(state, m.dialogueId, 0, c.hit, c.miss) } },
        // onEnd 的 markOk/markFail/streamDrops/中断统计已移入 forward.js 流式分支（按 relay 结局决策是否切下一上游/模型）
      })
      // 流式中继注入：forward.js 在模型链循环内等待 relay 结局，未回传内容的断流可继续切下一上游/模型
      const streamRelay = async (result, meta) => {
        const m = meta || {}
        if (responsesMode) {
          if (!responsesSession) responsesSession = createResponsesStream(res, { model: responsesMeta.model })
          const opts = relayOptsFor(m, m.reconnect)
          opts.rewriteModel = null // Responses 的 model 由 writer/响应对象回写
          return responsesSession.relay(result.stream, opts)
        }
        if (!res.headersSent) writeUpstreamHeaders(res, result) // 切换上游后的第二次 relay：响应头已随首个上游发出，不可重写
        const r = await relayStream(res, result.stream, relayOptsFor(m, m.reconnect))
        return Object.assign({}, r, { finish: (note) => endInterruptedStream(res, note, r ? r.reconnects : 0) })
      }
      const out = await forwardChain(FWD_DEPS, state, req, fUrl, fPath, req.method, bodyBuf, body, log, streamRelay, budget)
      // 请求级日志：记录每次数据面请求的请求模型/实际服务模型/上游与结果，便于定位空响应与连接问题（不含消息正文/密钥）
      const reqModel = (body && body.model) || '-'
      const _chain = (n) => n || ''
      if (out.kind === 'stream-done' || out.kind === 'stream-interrupted' || out.kind === 'stream') {
        log.info('data ' + req.method + ' ' + path + ' model=' + reqModel + ' serving=' + (out.serving || out.modelName || '-') + ' provider=' + (out.pid || '-') + ' chain=' + _chain(out.chain) + ' stream')
        state.st.lastServing = { model: out.serving || out.modelName || '-', provider: out.pid || '-', at: Date.now() }
      } else {
        log.info('data ' + req.method + ' ' + path + ' -> ' + (out.status || '-') + ' model=' + reqModel + ' serving=' + (out.serving || out.modelName || '-') + ' provider=' + (out.pid || '-') + ' chain=' + _chain(out.chain))
        if (out.status >= 200 && out.status < 300) state.st.lastServing = { model: out.serving || out.modelName || '-', provider: out.pid || '-', at: Date.now() }
        if (out.kind === 'json' && out.status >= 200 && out.status < 300 && out.body && out.body.length) {
          const _j = tryParse(out.body)
          const _cs = (_j && Array.isArray(_j.choices)) ? _j.choices : []
          const _has = _cs.some((c) => { const m = c && c.message; return m && typeof m.content === 'string' && m.content.length })
          if (!_has) log.warn('data 2xx 无正文内容 model=' + reqModel + ' serving=' + (out.serving || out.modelName || '-') + ' provider=' + (out.pid || '-'))
        }
      }
      // —— MG-015：Responses 结果整形（非流式对象 / 降级单帧 / 流式终态 / 错误） ——
      if (responsesMode) {
        if (out.kind === 'aborted') return
        if (out.kind === 'stream-done') return
        if (out.kind === 'stream-interrupted') {
          if (responsesSession) { responsesSession.fail(out.note || '上游流式响应中断', { timeout: !!out.timeout }); return }
          sendJson(res, 502, { error: { message: out.note || '上游流式响应中断', type: 'stream_interrupted' } }); return
        }
        if (out.kind === 'stream') {
          // 兼容路径（未注入 streamRelay 的异常分支）：直接桥接上游流
          if (!responsesSession) responsesSession = createResponsesStream(res, { model: responsesMeta.model })
          await responsesSession.relay(out.res.stream, Object.assign(relayOptsFor(out, out.reconnect), { rewriteModel: null }))
          return
        }
        if (out.kind === 'json') {
          const chat = tryParse(out.body)
          if (out.status >= 200 && out.status < 300) {
            if (responsesMeta.stream) {
              // 客户端要流式但上游给的是 JSON（forceNoStream/降级）：以单帧事件交付
              if (!responsesSession) responsesSession = createResponsesStream(res, { model: responsesMeta.model })
              responsesSession.oneShot(chat, { customToolNames: responsesMeta.customToolNames })
              return
            }
            const resp = chatToResponse(chat, { model: responsesMeta.model, customToolNames: responsesMeta.customToolNames })
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(resp)); return
          }
          res.writeHead(out.status || 502, { 'content-type': out.contentType || 'application/json; charset=utf-8' }); res.end(out.body); return
        }
        return
      }
      if (out.kind === 'aborted') return   // 客户端已断开/请求已取消：连接不可写，不产生响应
      if (out.kind === 'stream') {
        writeUpstreamHeaders(res, out.res)
        await relayStream(res, out.res.stream, {
          idleMs: (state.cfg.defaults && state.cfg.defaults.timeout && state.cfg.defaults.timeout.idleMs) || 0,
          maxReconnects: 2, log, reconnect: out.reconnect, signal: budget.signal, budget,
          protocol: out.api || 'openai', extract: (out.api && out.api !== 'openai') ? adapterFor(out.api).extractStreamContent : undefined, extractFinish: (out.api && out.api !== 'openai') ? adapterFor(out.api).extractStreamFinish : undefined,
          rewriteModel: (body && body.model) || null, // 「名字没对上」：响应 model 回写为客户端请求名
          onTokens: (n, usage) => {
            const _u = usage || {}; const _inTk = (typeof _u.prompt_tokens === 'number' && _u.prompt_tokens > 0 ? _u.prompt_tokens : 0) || (typeof _u.input_tokens === 'number' && _u.input_tokens > 0 ? _u.input_tokens : 0); const _outTk = (typeof _u.completion_tokens === 'number' && _u.completion_tokens > 0 ? _u.completion_tokens : 0) || (typeof _u.output_tokens === 'number' && _u.output_tokens > 0 ? _u.output_tokens : 0); const total = (typeof _u.total_tokens === 'number' && _u.total_tokens > 0 ? _u.total_tokens : 0) || (_inTk + _outTk) || n
            // 输入/输出 token：流末 usage 有则取（多数 OpenAI 兼容上游流末帧带），无则记 0（不臆造）；命中+未命中=输入
            const inTk = _inTk
            const outTk = _outTk
            if (total > 0) { agg(state, out.pid, 'tokens', total); const sm = out.serving || out.modelName; const sg = state.stats.byModel[sm] = state.stats.byModel[sm] || { requests: 0, errors: 0 }; sg.tokens = (sg.tokens || 0) + total; sg.inTokens = (sg.inTokens || 0) + inTk; sg.outTokens = (sg.outTokens || 0) + outTk; tallyDaily(state, sm, total, 0, 0, inTk, outTk); tallyVirtual(state, out.modelName, out.serving, total, inTk, outTk); tallyDialogue(state, out.dialogueId, total, 0, 0) }
          },
          onUsage: (u) => { const c = cacheHitMiss(out.api, u); if (c.hit > 0 || c.miss > 0) { const sm = out.serving || out.modelName; noteCacheStat(state, sm, out.pid, c.hit, c.miss); tallyDaily(state, sm, 0, c.hit, c.miss); tallyDialogue(state, out.dialogueId, 0, c.hit, c.miss) } },
          onEnd: (info) => {
            if (!info) return
            const sm = out.serving || out.modelName
            const h = ensureHst(state, out.pid)
            if (info.clientGone) return   // 客户端主动断开：既非上游成功也非上游失败，留给下一请求自行判定，避免误熔断
            if (info.interrupted) {
              state.st.counters.interrupts += 1; state.stats.global.interrupts += 1
              agg(state, out.pid, 'errors', 1); state.st.counters.errors += 1
              const sg = state.stats.byModel[sm] = state.stats.byModel[sm] || { requests: 0, errors: 0 }
              sg.errors = (sg.errors || 0) + 1
              // 独立连续中断计数（markOk 不会重置它）：连续多次流中断让路由绕开该上游
              h.streamDrops = (h.streamDrops || 0) + 1
              h.streamDropAt = Date.now() // 冷却计时起点（配合 forward.js 的 half-open 探测）
              // 流中断按上游失败计入熔断（与请求头阶段失败同口径）：连续 maxFailures 次中断即拉闸，
              // 后续请求切到备用上游/下一模型。markOk 已延后到流成功结束才调用，间歇性「头 2xx」不再清零失败计数
              const pdef = (state.cfg.providers && state.cfg.providers[out.pid]) || null
              markFail(state, out.pid, (pdef && pdef.circuit) || null)
              log && log.warn('sse 流中断(续传' + ((info.reconnects || 0)) + '次仍失败)，已计入中断+上游错误+熔断失败，该上游累计连续中断 ' + h.streamDrops, 'model=' + sm + ' provider=' + (out.pid || '-'), 'chain=' + (out.chain || '-'))
            } else {
              h.streamDrops = 0 // 正常完成一次流：重置连续中断计数
              markOk(state, out.pid) // 流完整走完才算成功
              noteAffinity(state, sm, out.pid) // 成功上游亲和在流结束时才落定
            }
          },
        })
        return
      }
      if (out.kind === 'stream-done') {
        return // 流已由 forward 内部 relay 完成（正常结束，客户端连接已收尾），无需再处理
      }
      if (out.kind === 'stream-interrupted') {
        // forward 在「配置关」路径已调 relay.finish 收尾；流已开始后的全链失败等路径未收尾——此处兜底
        if (!res.writableEnded && !res.destroyed) endInterruptedStream(res, out.note || '上游流式响应中断', out.reconnects || 0, out.timeout ? { type: 'stream_interrupted', code: 'REQUEST_TIMEOUT' } : null)
        return
      }
      if (out.kind === 'json' && out.asSSE) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'transfer-encoding': 'chunked', 'cache-control': 'no-cache' })
        const m = tryParse(out.body) || {}
        const msg0 = (m.choices && m.choices[0]) || {}
        const message = msg0.message || {}
        if (message.content) res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: message.content } }] }) + '\n\n')
        if (message.tool_calls && message.tool_calls.length) { let i = 0; for (const tc of message.tool_calls) res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [Object.assign({ index: i++ }, tc)] } }] }) + '\n\n') }
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: msg0.finish_reason || 'stop' }] }) + '\n\n')
        res.write('data: [DONE]\n\n')
        return res.end()
      }
      // 防御：响应头已发出（流式已开始/已收尾）时不能再 writeHead，否则抛 ERR_HTTP_HEADERS_SENT，
      // 客户端只拿到半截流。此时只能以流内错误事件收尾（forward 正常路径已避免走到这里）。
      if (res.headersSent || res.writableEnded) {
        log && log.warn('json 响应无法回写（响应头已发出）status=' + out.status + ' kind=' + out.kind)
        if (!res.writableEnded && !res.destroyed) endInterruptedStream(res, '上游响应中断（流已开始后无法回写状态码 ' + out.status + '）', 0)
        return
      }
      res.writeHead(out.status, { 'content-type': out.contentType }); res.end(out.body)
    } catch (err) {
      if (err && err.aborted) {
        // 预算耗尽/客户端断开：不算网关路由失败，按契约 §4 收尾
        log && log.warn('request aborted', err.reason || err.message, path)
        if (!res.headersSent) {
          if (err.reason === 'client_closed' || res.destroyed) return   // 客户端已断：不写
          const _to2 = (state.cfg.defaults && state.cfg.defaults.timeout) || {}
          sendJson(res, 504, { error: { message: '请求超时：超出整体预算 ' + (_to2.overallMs || 0) + 'ms（defaults.timeout.overallMs）', type: 'request_timeout' } })
          if (!req.complete) res.once('finish', () => setImmediate(() => { try { req.destroy() } catch {} }))   // 慢 body：响应后释放半截连接
        } else if (!res.writableEnded && !res.destroyed) {
          if (responsesMode && responsesSession) responsesSession.fail('请求超出整体预算 ' + ((state.cfg.defaults && state.cfg.defaults.timeout && state.cfg.defaults.timeout.overallMs) || 0) + 'ms（defaults.timeout.overallMs）', { timeout: true })
          else endInterruptedStream(res, '请求超出整体预算', 0, { type: 'stream_interrupted', code: 'REQUEST_TIMEOUT' })
        }
        return
      }
      state.st.counters.errors += 1
      log && log.error('route failed', path, '->', err.message)
      if (!res.headersSent) { const tooBig = /too large/i.test(String(err.message || '')); sendJson(res, tooBig ? 413 : 502, { error: { message: err.message || String(err), type: tooBig ? 'payload_too_large' : 'gateway_error' } }) }
      else if (!res.destroyed) { try { res.end() } catch {} }
    } finally {
      if (budget) { try { budget.dispose() } catch {} }
    }
  }
}

// stats 落盘（MG-007）：定时写与关闭写共用同一实现；原子写避免半截文件。
function writeStats(state) {
  pruneStatsHistory(state)
  // 模型统计字典硬上限：长期改名/试用模型不应让 stats.json 无界增长
  const bmKeys = Object.keys(state.stats.byModel || {})
  if (bmKeys.length > 500) {
    bmKeys.sort((a, b) => ((state.stats.byModel[b].tokens || 0) - (state.stats.byModel[a].tokens || 0)))
    for (const n of bmKeys.slice(500)) delete state.stats.byModel[n]
  }
  const q = {}
  for (const [n, m] of Object.entries(state.stats.byModel || {})) q[n] = { tokens: m.tokens || 0, inTokens: m.inTokens || 0, outTokens: m.outTokens || 0 }
  const g = state.stats.global || {}
  const globalP = { requests: g.requests||0, errors: g.errors||0, retries: g.retries||0, interrupts: g.interrupts||0, tokens: g.tokens||0, latencySum: g.latencySum||0, confirmed: g.confirmed||0, lats: g.lats||[], latTrend: g.latTrend||[] }
  const provP = {}
  for (const [pid, o] of Object.entries(state.stats.byProvider || {})) provP[pid] = { requests: o.requests||0, errors: o.errors||0, retries: o.retries||0, latencySum: o.latencySum||0, latencyCount: o.latencyCount||0, tokens: o.tokens||0, lats: o.lats||[], probe: o.probe||null }
  writeJsonAtomic(state.paths.stats, { daily: state.stats.daily, hourly: state.stats.hourly, byModel: q, dialogue: state.dialogue, global: globalP, byProvider: provP, lastServing: (state.st && state.st.lastServing) || null })
}

export function start(opts = {}) {
  const cfg = opts.config ? loadConfig({ configFile: opts.config }) : loadConfig()
  const mb = process.env.MG_MAX_BODY ? parseInt(process.env.MG_MAX_BODY, 10) : 0
  if (mb > 0) cfg.server = Object.assign({}, cfg.server || {}, { maxBodyBytes: mb })
  // 收集所有密钥值供日志脱敏：环境变量 Key + 面板 Key + extraHeaders 值 + 客户端/管理令牌 + 代理内嵌凭据
  const log = createLogger({ logFile: cfg.server && cfg.server.logFile, silent: opts.silent, secrets: collectSecrets(cfg) })
  const pids = (() => { const o = {}; for (const id of Object.keys(cfg.providers || {})) o[id] = { requests:0, errors:0, retries:0, latencySum:0, latencyCount:0, tokens:0 }; return o })()
  const state = {
    cfg, log, router: createRouter(cfg),
    adminToken: process.env.MG_ADMIN_TOKEN || (cfg.server && cfg.server.adminToken) || (cfg._keys && cfg._keys.__mg_admin) || '',
    paths: cfg._paths || configPaths(),
    st: { startedAt: Date.now(), uses: {}, counters: { requests: 0, errors: 0, retries: 0, interrupts: 0 } },
    health: {},
    throttle: {},
    throttleModel: {},
    qpsToken: {},
    affinity: {},        // 模型 → 最近一次成功上游（缓存亲和）
    affinityAt: {},      // 模型 → 上述亲和的记录时间（配合 AFFINITY_TTL_MS 做过期，超时后主上游可被重新试用）
    cacheStat: {},       // "模型\0上游" → { hit, miss }（命中率路由）
    cacheTrend: [],      // 全局缓存命中率趋势样本 { t, v }（告警基线）
    cacheAlert: null,    // 最近一次命中率骤降告警
    videos: {},          // Video 异步任务池（ADR-0001）：id -> task；持久化到 <config>/videos.json
    dialogue: {},        // 对话维度统计：id -> { requests, tokens, hit, miss, startAt, lastAt, named }
    dUnnamed: null,      // 无会话 ID 时的当前兜底对话（按间隔切分）
    stats: { global: { requests:0, errors:0, retries:0, interrupts:0, tokens:0, latencySum:0, confirmed:0, lats: [], latTrend: [] }, byProvider: pids, byModel: {}, daily: {}, hourly: {} },
  }
  const timers = []
  const every = (ms, fn) => { const h = setInterval(fn, ms); h.unref(); timers.push(h); return h }
  try {
    const _sf = state.paths.stats
    let _j = {}
    if (existsSync(_sf)) {
      const raw = readFileSync(_sf, 'utf8') || '{}'
      try { _j = JSON.parse(raw) } catch (e) {
        // 损坏的 stats 先留证再重建（MG-007）：不让一次坏文件把历史统计静默清零
        try { copyFileSync(_sf, _sf + '.corrupt-' + Date.now()) } catch {}
        log.warn('stats 文件损坏，已备份并重建', e.message)
        _j = {}
      }
    } state.st.lastServing = _j.lastServing || null; state.stats.daily = Object.assign({}, state.stats.daily, _j.daily || {}); state.stats.hourly = Object.assign({}, state.stats.hourly, _j.hourly || {}); for (const [n, t] of Object.entries(_j.byModel || {})) { state.stats.byModel[n] = Object.assign(state.stats.byModel[n] || { requests: 0, errors: 0 }, { tokens: (t && t.tokens) || 0, inTokens: (t && t.inTokens) || 0, outTokens: (t && t.outTokens) || 0 }) }; const _dlg = _j.dialogue || {}; for (const k of Object.keys(_dlg)) state.dialogue[k] = _dlg[k]; let _u = null; for (const k of Object.keys(state.dialogue)) { if (k.startsWith('conv-') && (!_u || state.dialogue[k].lastAt > _u.lastAt)) _u = state.dialogue[k] } state.dUnnamed = _u || null; const _g = _j.global || {}; for (const k of ['requests','errors','retries','interrupts','tokens','latencySum','confirmed']) if (typeof _g[k] === 'number') state.stats.global[k] = _g[k]; if (Array.isArray(_g.lats)) state.stats.global.lats = _g.lats; if (Array.isArray(_g.latTrend)) state.stats.global.latTrend = _g.latTrend; for (const [pid, po] of Object.entries(_j.byProvider || {})) { const o = ensureSt(state, pid); for (const k of ['requests','errors','retries','latencySum','latencyCount','tokens']) if (typeof po[k] === 'number') o[k] = po[k]; if (Array.isArray(po.lats)) o.lats = po.lats; if (po.probe) o.probe = po.probe } } catch { /* 统计文件缺失/损坏则从空开始 */ }
  every(30000, () => { try { writeStats(state) } catch (e) { log && log.warn('stats 写盘失败', e.message) } })
  // —— MG-014 Video 任务池：加载 + GC + 后台轮询（ADR-0001；文件损坏不阻塞启动） ——
  try { state.videos = loadVideoTasks(state.paths.videos) } catch (e) { state.videos = {}; log && log.warn('videos.json 读取失败，按空任务池启动', e.message) }
  try { if (gcVideoTasks(state.videos)) saveVideoTasks(state.paths.videos, state.videos) } catch {}
  every(5000, async () => {
    if (state.closed) return
    for (const t of Object.values(state.videos)) {
      if (!t || ['succeeded', 'failed', 'canceled'].includes(t.status)) continue
      if (Date.now() - (t.lastPollAt || 0) < 5000) continue
      await pollVideoTask(state, t, log)
    }
  })
  every(3600000, () => { if (state.closed) return; if (gcVideoTasks(state.videos)) saveVideos(state, log) })
  every(10000, () => { const l = state.stats.global.lats; const avg = (l && l.length) ? Math.round(l.reduce((a, b) => a + b, 0) / l.length) : 0; const tr = state.stats.global.latTrend; tr.push({ t: Date.now(), v: avg }); if (tr.length > 80) tr.shift() })
  // B4 主动缓存预热：按 defaults.preheat 周期向模型上游发送带长 system 前缀的最小请求，保持厂商 prefix cache 存活
  ;(() => { const lastWarm = {}; setInterval(async () => {
    if (state.closed) return
    const ph = (state.cfg.defaults && state.cfg.defaults.preheat) || []
    if (!ph.length) return
    const now = Date.now()
    for (const e of ph) {
      if (!e || typeof e.model !== 'string' || !e.model || typeof e.system !== 'string' || !e.system) continue
      const md = state.cfg.models && state.cfg.models[e.model]; if (!md) continue
      const everyMs = Number(e.everyMs) > 0 ? Number(e.everyMs) : 5 * 60 * 1000
      if (now - (lastWarm[e.model] || 0) < everyMs) continue
      lastWarm[e.model] = now
      let prov; try { prov = buildProvider(state.cfg, md.provider) } catch { continue }
      if (prov._def.apiKeyEnv && !prov.keyOk) continue
      // MG-008：预热与转发共用模型解析（api/上游模型名），避免非 OpenAI 上游与 providerModels 覆盖名失效
      const target = modelTarget(state.cfg, e.model, md.provider)
      const r = await warm(prov, e.model, e.system, Object.assign({}, state.cfg.defaults || {}, { api: target.api, upstreamModel: target.servingName }), log)
      log && (r.ok ? log.info('preheat ok', e.model, 'status ' + r.status) : log.warn('preheat fail', e.model, r.status || r.err || '-'))
    }
  }, 15000).unref() })()
  // 主上游回切探活（failback）：模型当前由备用上游服务时，周期性向主上游发最小请求；
  // 连续 successStreak 次成功后把亲和切回主上游，让下一个请求回到主上游——上游恢复即自动回流，不必等亲和 TTL 过期。
  // 只在"降级中"才探活（affinity 指向非主上游），正常态零开销；探活用 probeChat（真实 chat、user 消息、
  // max_tokens=1、stream:true、不计额度）——按真实流式形态判定恢复，避免「头 2xx + 流中断」的上游被误判已恢复。
  ;(() => {
    const streak = {}   // 模型 → 连续探活成功次数
    const lastAt = {}   // 模型 → 上次探活时间
    setInterval(async () => {
      if (state.closed) return
      const fb = (state.cfg.defaults && state.cfg.defaults.failbackProbe) || {}
      if (fb.enabled === false) return
      const everyMs = Number(fb.everyMs) > 0 ? Number(fb.everyMs) : 30000
      const need = Number(fb.successStreak) > 0 ? Number(fb.successStreak) : 2
      const sys = typeof fb.system === 'string' && fb.system ? fb.system : 'ping'
      const now = Date.now()
      for (const [name, md] of Object.entries(state.cfg.models || {})) {
        const primary = md && md.provider
        const cur = state.affinity && state.affinity[name]
        if (!primary || !cur || cur === primary) continue            // 正用主上游：无需探活
        if (now - (lastAt[name] || 0) < everyMs) continue
        lastAt[name] = now
        let prov; try { prov = buildProvider(state.cfg, primary) } catch { continue }
        if (prov._def.apiKeyEnv && !prov.keyOk) continue
        if (!healthy(ensureHst(state, primary), now)) continue       // 主上游熔断中：交给熔断半开处理，避免打架
        // MG-008：failback 探活与转发共用模型解析（api/上游模型名），否则非 OpenAI 上游/覆盖名会被误判未恢复
        const target = modelTarget(state.cfg, name, primary)
        const r = await probeChat(prov, name, sys, Object.assign({}, state.cfg.defaults || {}, { api: target.api, upstreamModel: target.servingName }), log)  // user 消息探活：LiteLLM 层拒 system-only（400），warm 的 system 前缀不适用
        if (r.ok) {
          streak[name] = (streak[name] || 0) + 1
          if (streak[name] >= need) {
            // 亲和直接置为主上游（而非清除）：无亲和时路由会退化为按缓存命中率排序，
            // 高命中的备用上游（如 opencodego 缓存热）会把主上游挤到后面——「清除」等于把回切换成碰运气
            state.affinity[name] = primary; state.affinityAt[name] = Date.now(); streak[name] = 0
            log && log.info('failback 主上游已恢复，亲和切回主上游', name, '→', primary)
          }
        } else if (streak[name]) streak[name] = 0
      }
    }, 5000).unref()   // 扫描粒度 5s：让 everyMs 可配到秒级（实际间隔取 everyMs 与本粒度较大者）
  })()
  // B5 缓存命中率趋势 + 骤降告警：近期命中率相对基线明显下滑时告警（通常因模型/上游切换导致缓存碎片化）
  ;(() => { setInterval(() => {
    if (state.closed) return
    let tHit = 0, tMiss = 0
    for (const m of Object.values(state.stats.daily || {})) { for (const c of Object.values(m || {})) { tHit += (c && c.hit) || 0; tMiss += (c && c.miss) || 0 } }
    const tot = tHit + tMiss
    if (tot <= 0) return
    const rate = tHit / tot
    state.cacheTrend.push({ t: Date.now(), v: Math.round(rate * 1000) / 10 })
    if (state.cacheTrend.length > 240) state.cacheTrend.shift()
    if (state.cacheTrend.length >= 24) {
      const half = Math.max(1, Math.floor(state.cacheTrend.length / 2))
      const hist = state.cacheTrend.slice(0, half).reduce((a, x) => a + x.v, 0) / half
      const win = state.cacheTrend.slice(-12); const recent = win.reduce((a, x) => a + x.v, 0) / win.length
      if (recent >= 30 && (hist - recent) >= 20) {
        const alert = { at: Date.now(), type: 'cache_hit_drop', from: Math.round(hist), now: Math.round(recent), msg: '缓存命中率骤降：' + Math.round(recent) + '%（此前基线 ' + Math.round(hist) + '%），可能因模型/上游切换导致缓存碎片化' }
        if (!state.cacheAlert || state.cacheAlert.at !== alert.at) { state.cacheAlert = alert; log && log.warn(alert.msg) }
      } else if (state.cacheAlert && recent > hist - 10) state.cacheAlert = null
    }
  }, 30000).unref() })()
  const bindHost = String((cfg.server && cfg.server.host) || '127.0.0.1').toLowerCase()
  const loopbackBind = bindHost === '::1' || bindHost === 'localhost' || bindHost.startsWith('127.')
  if (state.adminToken) log.info('管理 API 已启用令牌保护（MG_ADMIN_TOKEN）')
  else if (loopbackBind) log.warn('未设置 MG_ADMIN_TOKEN：管理 API 仅允许本机访问（远程管理请求返回 403）')
  else log.error('非回环绑定 ' + bindHost + ' 且未设置管理令牌：远程管理 API 将被拒绝（403），数据面仍按客户端 Key 策略开放')
  hardenKeyFile(state.paths.keys)
  const server = opts.server || http.createServer(makeHandler(state))
  const host = (cfg.server && cfg.server.host) || '127.0.0.1'
  const port = (cfg.server && cfg.server.port) || 8787
  server.on('error', (err) => { log.error('server error', err.message); process.exitCode = 1 })
  // 统一关闭接口（MG-007）：停定时器 → 排空连接（带超时兜底）→ 最终原子落盘。
  // 幂等：重复调用返回同一个 promise，SIGTERM 与测试代码可以安全各调一次。
  let closing = null
  function close(closeOpts = {}) {
    if (closing) return closing
    closing = (async () => {
      state.closed = true
      for (const t of timers) clearInterval(t)
      timers.length = 0
      const timeoutMs = Number(closeOpts.timeoutMs) > 0 ? Number(closeOpts.timeoutMs) : 3000
      await new Promise((resolve) => {
        const finish = () => resolve()
        const timer = setTimeout(finish, timeoutMs)
        if (timer.unref) timer.unref()
        server.close(() => { clearTimeout(timer); finish() })
        if (server.closeIdleConnections) server.closeIdleConnections()
        // 已建立的 keep-alive 连接不会自己结束：短暂宽限后强制关闭，避免关闭被挂起的流拖住
        const force = setTimeout(() => { if (server.closeAllConnections) server.closeAllConnections() }, 50)
        if (force.unref) force.unref()
      })
      try { writeStats(state) } catch (e) { log && log.warn('关闭时统计落盘失败', e.message) }
      try { saveVideoTasks(state.paths.videos, state.videos) } catch (e) { log && log.warn('关闭时 video 任务落盘失败', e.message) }
      log && log.info('model-gateway 已关闭，统计已落盘')
    })()
    return closing
  }
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      log.info('model-gateway 已启动: http://' + host + ':' + port + '  (健康检查 /healthz, 控制面板 /)')
      resolve({ cfg, log, server, router: state.router, st: state.st, state, close })
    })
  })
}

const MAIN_HREF = process.argv[1] ? (await import('node:url')).pathToFileURL(process.argv[1]).href : ''
if (import.meta.url === MAIN_HREF && basename(process.argv[1] || '').toLowerCase() === 'index.js') {
  // 信号处理：SIGTERM/SIGINT 走统一关闭（停定时器 → 排空连接 → 统计落盘），退出码 0；
  // 关闭超过 5s 仍未完成则强制退出，避免 systemd stop 超时后 SIGKILL 丢掉最终落盘。
  start().then((gw) => {
    const shutdown = (sig) => {
      const hard = setTimeout(() => { console.error('shutdown timeout:', sig); process.exit(1) }, 5000)
      if (hard.unref) hard.unref()
      gw.close().then(() => process.exit(0), (err) => { console.error('shutdown failed:', err.message); process.exit(1) })
    }
    process.once('SIGTERM', () => shutdown('SIGTERM'))
    process.once('SIGINT', () => shutdown('SIGINT'))
  }).catch((err) => { console.error('fatal:', err.message); process.exit(1) })
}