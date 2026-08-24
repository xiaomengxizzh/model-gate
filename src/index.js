import http from 'node:http'
import { readFileSync, chmodSync, existsSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { loadConfig, createRouter, buildProvider, configPaths, writeJsonAtomic , keysEncrypt } from './router.js'
import { createLogger } from './logger.js'
import { forward, probe, probeModel, warm } from './request.js'
import { adapterFor, cacheHitMiss } from './format.js'
import { isStreamResponse, writeUpstreamHeaders, relayStream } from './sse.js'

const HOP_BY_HOP = new Set(['host','connection','transfer-encoding','content-length','upgrade','keep-alive','te','trailer'])
const STRIP_IN = new Set(['authorization','cookie','x-api-key','api-key','proxy-authorization','proxy-connection'])
const STREAM_DROP_THRESHOLD = 3 // 同一上游连续流式中断 >= 该值，后续请求绕开它（不被 markOk 重置）
// 数据面 Chat 入口别名：兼容 base URL 不带 /v1 的 OpenAI 兼容客户端（它们会拼 /chat/completions 或 /v1/chat/completions）
const CHAT_PATHS = new Set(['/v1/chat/completions', '/chat/completions'])
const ADMIN_PAGE = new URL('./admin.html', import.meta.url)

const FAIL_OPEN_THRESHOLD = 5       // 连续失败熔断阈值（放宽：平台偶发慢/抖不轻易熔断）
const FAIL_OPEN_COOLDOWN = 10000    // 熔断冷却 ms

async function collectBody(stream, maxBytes = 64 * 1024 * 1024) {
  const chunks = []
  let total = 0
  for await (const c of stream) {
    total += c.length
    if (total > maxBytes) throw new Error('body too large (' + maxBytes + ' bytes)')
    chunks.push(c)
  }
  return Buffer.concat(chunks)
}

// 上游偶发返回 gzip 响应却不带 content-encoding 头（如 opencodezen），会导致 usage 解析失败、统计断链
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b])
function maybeGunzip(buf, contentEncoding) {
  // 只要上游申报了 gzip 或魔数命中，就必须能解压成功；否则抛错让上层当作失败走 fallback，避免放行垃圾字节
  const wants = /gzip/i.test(contentEncoding || '') || (buf && buf.length >= 2 && buf[0] === GZIP_MAGIC[0] && buf[1] === GZIP_MAGIC[1])
  if (wants) return gunzipSync(buf)
  return buf
}

// 转发头：剥离客户端授权/敏感头，统一由网关注入鉴权，防止绕过
function buildHeaders(req, provider, bodyBuf, cfg) {
  const headers = {}
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase()
    if (HOP_BY_HOP.has(lk) || STRIP_IN.has(lk)) continue
    headers[k] = v
  }
  headers['user-agent'] = 'model-gateway/0.1'
  if (!headers['accept']) headers['accept'] = 'application/json'
  headers['accept-encoding'] = 'identity' // 请求上游返回明文，避免 gzip 导致响应体解析失败
  if (provider.apiKey) headers['authorization'] = 'Bearer ' + provider.apiKey
  const extra = Object.assign({}, (cfg.defaults || {}).extraHeaders, provider.extraHeaders)
  for (const [k, v] of Object.entries(extra)) headers[k.toLowerCase()] = v
  if (bodyBuf && bodyBuf.length) headers['content-length'] = bodyBuf.length
  return headers
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}
function tryParse(buf) { try { return JSON.parse(buf.toString('utf8')) } catch { return null } }

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
function maxConcur(cfg) { return (cfg.defaults && cfg.defaults.concurrency && cfg.defaults.concurrency.maxPerProvider) || 8 }
function throttleOf(state, pid) {
  if (!state.throttle[pid]) state.throttle[pid] = { max: maxConcur(state.cfg), inFlight: 0, wait: [], rateUntil: 0 }
  return state.throttle[pid]
}
// 每 provider 并发信号量 + 429 排队（rateUntil 内新请求等待）
async function acquireProvider(state, pid, cfg) {
  const th = throttleOf(state, pid)
  const r = th.rateUntil
  if (r > Date.now()) await new Promise((s) => setTimeout(s, Math.min(r - Date.now(), 60000)))
  if (th.inFlight >= th.max) await new Promise((s) => th.wait.push(s))
  th.inFlight += 1
  return () => { th.inFlight -= 1; if (th.wait.length) (th.wait.shift())() }
}
function pct(arr, p) { if (!arr || !arr.length) return null; const a = [...arr].sort((x, y) => x - y); const i = Math.min(a.length - 1, Math.max(0, Math.ceil(a.length * p / 100) - 1)); return Math.round(a[i]) }
function rateWait(state, name, qps) {
  const now = Date.now()
  const cap = Math.max(1, Math.ceil(qps))
  let q = state.qpsToken[name]
  if (!q) q = state.qpsToken[name] = { tokens: cap, last: now }
  const refill = (now - q.last) * qps / 1000
  q.tokens = Math.min(cap, q.tokens + refill)
  q.last = now
  if (q.tokens >= 1) { q.tokens -= 1; return }
  const need = 1 - q.tokens
  q.tokens = 0
  return new Promise((res) => setTimeout(res, Math.max(0, Math.round((need / qps) * 1000))))
}
function modelThrottleOf(state, name, max) { if (!state.throttleModel[name]) state.throttleModel[name] = { max, inFlight: 0, wait: [] }; return state.throttleModel[name] }
async function acquireSem(th) { if (th.inFlight >= th.max) await new Promise((s) => th.wait.push(s)); th.inFlight += 1; return () => { th.inFlight -= 1; if (th.wait.length) (th.wait.shift())() } }
function todayKey(d) { const x = d || new Date(); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0') }
function tallyDaily(state, modelName, tokens, hit, miss) { if (!modelName) return; const now = new Date(); const k = todayKey(now); const m = state.stats.daily[modelName] || (state.stats.daily[modelName] = {}); const c = m[k] || (m[k] = { tokens: 0, hit: 0, miss: 0 }); c.tokens += tokens || 0; c.hit += hit || 0; c.miss += miss || 0; const hk = k + ':' + String(now.getHours()).padStart(2, '0'); const hm = state.stats.hourly[modelName] || (state.stats.hourly[modelName] = {}); const h = hm[hk] || (hm[hk] = { tokens: 0, hit: 0, miss: 0 }); h.tokens += tokens || 0; h.hit += hit || 0; h.miss += miss || 0 }
function agg(state, pid, field, delta) { if (state.stats.byProvider[pid]) state.stats.byProvider[pid][field] += delta; state.stats.global[field] += delta }
// 粗略估计 prompt 的 token 数（用于 maxContext 判断）：中文/全角按 1 字≈1 token，其它按约 4 字符≈1 token
function estPromptTokens(body) {
  let t = 0
  for (const m of (body && body.messages) || []) {
    const c = m && m.content
    const parts = typeof c === 'string' ? [c] : (Array.isArray(c) ? c.map((x) => (x && (x.text || x.content || '')) || '') : [])
    for (const s of parts) {
      for (let i = 0; i < s.length; i++) {
        const ch = s.codePointAt(i)
        if ((ch >= 0x3400 && ch <= 0x4DBF) || (ch >= 0x4E00 && ch <= 0x9FFF) || (ch >= 0xFF00 && ch <= 0xFFEF)) t += 1
        else t += 0.25
        if (ch > 0xFFFF) i++
      }
    }
  }
  return Math.ceil(t) + 8
}
// 模型额度/上下文判定：命中则返回原因，否则 null（超限的模型在路由中被跳过并切到下一模型）
function routeLimit(state, cfg, model, body) {
  if (!model) return null
  const md = cfg.models && cfg.models[model]; if (!md) return null
  if (md.quota > 0 && ((state.stats.byModel[model] && state.stats.byModel[model].tokens) || 0) >= md.quota) return '总额度已用尽'
  if (md.dailyQuota > 0 && ((state.stats.daily[model] && state.stats.daily[model][todayKey()] && state.stats.daily[model][todayKey()].tokens) || 0) >= md.dailyQuota) return '今日额度已用尽'
  if (md.maxContext > 0 && body && body.messages && estPromptTokens(body) >= md.maxContext) return '超出上下文上限'
  return null
}

// ── 缓存降碎片化（A2 会话/上游亲和 + B5 命中率路由）──
// 记录某模型最近一次成功使用哪个上游，回填到状态，供前端展示。
function noteAffinity(state, model, pid) { if (model && pid && state.cfg.providers[pid]) state.affinity[model] = pid }
// 记录某 (模型, 上游) 组合的缓存命中/未命中，用于跨模型切换后按命中率择优。
function noteCacheStat(state, model, pid, hit, miss) {
  if (!model || !pid) return
  const k = model + '\u0000' + pid
  const c = state.cacheStat[k] || (state.cacheStat[k] = { hit: 0, miss: 0, ts: Date.now() })
  c.hit += hit || 0; c.miss += miss || 0; c.ts = Date.now()
}
// 候选上游排序：优先"上次成功"的亲和上游（保持同一上游复用其厂商缓存），
// 其次按近期缓存命中率从高到低，其余保持原顺序。
function orderCandidates(state, model, providers) {
  const rate = (pid) => { const c = state.cacheStat && state.cacheStat[model + '\u0000' + pid]; return (c && (c.hit + c.miss) > 0) ? c.hit / (c.hit + c.miss) : null }
  const fav = state.affinity && state.affinity[model]
  return providers.slice().sort((a, b) => {
    if (fav) { if (a === fav) return -1; if (b === fav) return 1 }
    const sa = rate(a), sb = rate(b)
    if (sa != null && sb != null) return sb - sa
    if (sa != null) return -1
    if (sb != null) return 1
    return 0
  })
}

function buildStatus(state) {
  const now = Date.now()
  const s = state.stats
  const providers = Object.entries(state.cfg.providers || {}).map(([id, p]) => {
    const keyOk = !!(state.cfg._keys && state.cfg._keys[id]) || !!(p.apiKeyEnv && process.env[p.apiKeyEnv])
    const h = ensureHst(state, id)
    const o = s.byProvider[id] || { requests:0, errors:0, retries:0, latencySum:0, latencyCount:0, tokens:0 }
    return {
      id, baseUrl: p.baseUrl, hasKey: keyOk,
      keySource: (state.cfg._keys && state.cfg._keys[id]) ? 'keys' : (p.apiKeyEnv ? 'env' : null),
      apiKeyEnv: p.apiKeyEnv || null, pathPrefix: p.pathPrefix || '', api: p.api || 'openai', extraHeaders: p.extraHeaders || {},
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
    return { name, provider: d.provider, alias: d.alias || [], fallbacks: d.fallbacks || [], maxConcurrent: d.maxConcurrent || 0, qps: d.qps || 0, reasoning: d.reasoning || '', effortOptions: d.effortOptions || [], dailyQuota: d.dailyQuota || 0, quota: d.quota || 0, maxContext: d.maxContext || 0, probe: m.probe || null, requests: m.requests, errors: m.errors, tokens: m.tokens || 0, today: dk.tokens || 0, hitRate, affinity: state.affinity[name] || null, avgMs: m.latencyCount ? Math.round(m.latencySum / m.latencyCount) : null }
  })
  const defaults = state.cfg.defaults || {}
  const todayTotal = models.reduce((a, m) => a + (m.today || 0), 0)
  return {
    needAuth: !!state.adminToken,
    server: { maxBodyBytes: (state.cfg.server && state.cfg.server.maxBodyBytes) || 0, keyEncrypted: !!(process.env.MG_KEYS_MASTER) || keysFileEncrypted(state.paths.keys), host: (state.cfg.server && state.cfg.server.host) || '127.0.0.1', port: (state.cfg.server && state.cfg.server.port) || 8787 },
    startedAt: state.st.startedAt, uptimeMs: Date.now() - state.st.startedAt,
    counters: Object.assign({}, state.st.counters),
    global: { requests: s.global.requests, errors: s.global.errors, retries: s.global.retries, interrupts: s.global.interrupts, tokenCount: s.global.tokens, todayTokens: todayTotal, avgMs: s.global.confirmed ? Math.round(s.global.latencySum / s.global.confirmed) : null, p50: pct(s.global.lats, 50), p95: pct(s.global.lats, 95), latTrend: s.global.latTrend || [] },
    cache: { trend: state.cacheTrend || [], alert: state.cacheAlert || null },
    dialogues: Object.values(state.dialogue).filter(d => d.requests > 0).sort((a, b) => b.lastAt - a.lastAt).slice(0, 30).map(d => ({ id: d.id, named: d.named, requests: d.requests, tokens: d.tokens, hit: d.hit, miss: d.miss, hitRate: (d.hit + d.miss) > 0 ? Math.round(d.hit / (d.hit + d.miss) * 1000) / 10 : null, startAt: d.startAt, lastAt: d.lastAt })),
    providers,
    models,
    defaults: { provider: defaults.provider || null, model: defaults.model || '', clientKey: currentClientKey(state) ? '********' : '', directory: defaults.directory || [], preheat: defaults.preheat || [], retry: defaults.retry || {}, timeout: defaults.timeout || {}, concurrency: defaults.concurrency || {}, extraHeaders: defaults.extraHeaders || {} },
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
  const data = Object.keys(cfg.models || {}).map((id) => ({ id, object: 'model', owned_by: 'model-gateway' }))
  const vm = (cfg.defaults && cfg.defaults.model) || ''
  if (vm && !data.some((m) => m.id === vm)) data.push({ id: vm, object: 'model', owned_by: 'model-gateway' })
  return { object: 'list', data }
}

function reloadConfig(state) {
  state.cfg = loadConfig()
  state.router = createRouter(state.cfg)
  // 管理令牌优先级：环境变量 MG_ADMIN_TOKEN > server.adminToken > 面板设置（keys.__mg_admin）
  state.adminToken = process.env.MG_ADMIN_TOKEN || (state.cfg.server && state.cfg.server.adminToken) || (state.cfg._keys && state.cfg._keys.__mg_admin) || ''
  const ids = Object.keys(state.cfg.providers || {})
  for (const id of ids) if (!state.stats.byProvider[id]) state.stats.byProvider[id] = { requests:0, errors:0, retries:0, latencySum:0, latencyCount:0, tokens:0 }
}
function saveConfig(state, body) {
  const cur = state.cfg
  const providers = body.providers !== undefined ? body.providers : (cur.providers || {})
  const models = body.models !== undefined ? body.models : (cur.models || {})
  const defaults = body.defaults !== undefined ? body.defaults : (cur.defaults || {})
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
  const clean = {}
  for (const [id, p] of Object.entries(providers || {})) { const { keyOk, keySource, ...rest } = p || {}; clean[id] = rest }
  if (newClientKey != null) {
    const keys = Object.assign({}, cur._keys)
    if (newClientKey) keys.__mg_client = newClientKey
    else delete keys.__mg_client
    const enc = keysEncrypt(keys)
    if (!enc) return { error: '无法加密 keys.local.json：缺少主密钥，已拒绝保存 clientKey' }
    writeFileSync(state.paths.keys, enc)
    hardenKeyFile(state.paths.keys)
  }
  writeJsonAtomic(state.paths.local, { providers: clean, models, defaults })
  reloadConfig(state)
  return {}
}
function saveKeys(state, body) {
  const keys = Object.assign({}, state.cfg._keys)
  if (body.key) keys[body.id] = body.key
  else delete keys[body.id]
  const enc = keysEncrypt(keys)
  if (!enc) return { error: '无法加密 keys.local.json：缺少主密钥（MG_KEYS_MASTER 未设置且自动主密钥不可用），已拒绝明文写入' }
  writeFileSync(state.paths.keys, enc)
  hardenKeyFile(state.paths.keys)
  reloadConfig(state)
  return {}
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
  const r = await probeModel(prov, model)
  const o = (state.stats.byModel[model] = state.stats.byModel[model] || { requests: 0, errors: 0 })
  o.probe = { at: Date.now(), ok: r.ok, code: r.code, ms: r.ms, err: r.err || null }
  return { id: model, ok: r.ok, code: r.code, ms: r.ms, err: r.err || null }
}

// ── 按对话（会话）统计：会话 ID 优先，无 ID 按时间间隔切分兜底 ──
const DIALOGUE_GAP_MS = 300000 // 无会话 ID 时，间隔超过 5 分钟视为新对话
// 解析本次请求归属的对话 ID：优先请求头 X-Conversation-Id / X-Session-Id，其次 body session_id/conversation_id；
// 都没有则复用「当前无 ID 对话」（间隔 ≤ 阈值），否则新建 conv-<时间戳> 对话。
function resolveDialogue(state, req, body) {
  const h = req.headers || {}
  const named = h['x-conversation-id'] || h['x-session-id'] || (body && (body.session_id || body.conversation_id))
  if (named && String(named).trim()) return String(named).trim()
  const now = Date.now()
  if (state.dUnnamed && (now - state.dUnnamed.lastAt) <= DIALOGUE_GAP_MS) return state.dUnnamed.id
  const id = 'conv-' + now
  state.dUnnamed = state.dialogue[id] = { id, requests: 0, tokens: 0, hit: 0, miss: 0, startAt: now, lastAt: now, named: false }
  return id
}
function tallyDialogue(state, id, tokens, hit, miss) {
  if (!id) return
  const now = Date.now()
  let d = state.dialogue[id]
  if (!d) { d = state.dialogue[id] = { id, requests: 0, tokens: 0, hit: 0, miss: 0, startAt: now, lastAt: now, named: !id.startsWith('conv-') } }
  d.requests += 1
  d.tokens += tokens || 0
  d.hit += hit || 0
  d.miss += miss || 0
  d.lastAt = now
  // 容量保护：对话过多时清掉最旧的（保留最近 50 个 + 当前无 ID 对话）
  const keys = Object.keys(state.dialogue)
  if (keys.length > 80) {
    const victims = keys.filter(k => state.dialogue[k] !== state.dUnnamed).sort((a, b) => state.dialogue[a].lastAt - state.dialogue[b].lastAt).slice(0, keys.length - 50)
    for (const k of victims) delete state.dialogue[k]
  }
}

// 转发：按路由序列（本模型 + fallbackModels 多上游）尝试 + 熔断，跨模型换名改写
async function forwardChain(state, req, url, path, method, bodyBuf, body, log) {
  const cfg = state.cfg
  let routes = []
  let maxModel = 0
  let qps = 0
  let injectedEffort = false
  let requestModel = null
  const dir = (cfg.defaults && cfg.defaults.directory) || []
  const dialogueId = resolveDialogue(state, req, body)
  if (body && body.model) {
    const hit = state.router.resolve(body.model)
    requestModel = hit.canonicalName
    maxModel = hit.def.maxConcurrent || 0
    qps = hit.def.qps || 0
    // 思考强度（LiteLLM 风格）：每个模型可配允许档位列表，客户端传的档位不在列表内则本地直接拒绝，不放给上游
    const opts = hit.def.effortOptions
    if (opts && opts.length && body.reasoning_effort !== undefined && body.reasoning_effort !== null && !opts.includes(String(body.reasoning_effort))) {
      return { kind: 'json', status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ error: { message: 'reasoning_effort 不支持 ' + body.reasoning_effort + '（该模型允许：' + hit.def.effortOptions.join(', ') + '）', type: 'UnsupportedParamsError' } })) }
    }
    // 模型配置默认值，客户端未指定时才注入（客户端自带优先）
    if (hit.def.reasoning && body.reasoning_effort === undefined) { body.reasoning_effort = hit.def.reasoning; injectedEffort = true }
    if (hit.def.virtual) {
      // 虚拟共用模型名：等价「未指定模型」，走 defaults.directory 默认链（首项即真实默认模型），
      // 把真实模型名发给上游；否则会把虚拟名透传上去导致 "Model <虚拟名> is not supported"
      if (dir.length) {
        for (const e of dir) { if (e && typeof e.model === 'string' && e.model) { const _m = cfg.models && cfg.models[e.model]; routes.push({ model: e.model, mode: (e.mode === 'onFail' ? 'onFail' : 'afterAll'), providers: (e.providers && e.providers.length ? e.providers.filter(Boolean) : (_m ? [ _m.provider, ...(_m.fallbacks || []) ].filter(Boolean) : [])) }) } }
        const d0 = routes[0] && cfg.models && cfg.models[routes[0].model]
        if (d0) { maxModel = d0.maxConcurrent || 0; qps = d0.qps || 0 }
      } else {
        routes.push({ model: null, providers: [hit.def.provider].filter(Boolean) })
        if (!(cfg.defaults && cfg.defaults.provider)) return { kind: 'json', status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ error: { message: '未指定默认上游（请配置 defaults.provider 或 defaults.directory）', type: 'missing_model' } })) }
      }
    } else {
      // 路由序列：先本模型自身上游，再按 defaults.directory 顺序做跨模型兜底（首个为默认）
      routes.push({ model: requestModel, mode: 'afterAll', providers: [hit.def.provider, ...(hit.def.fallbacks || [])].filter(Boolean) })
      for (const e of dir) {
        if (!e || typeof e.model !== 'string' || !e.model || e.model === requestModel) continue
        if (routes.some((r) => r.model === e.model)) continue
        const _m = cfg.models && cfg.models[e.model]
        routes.push({ model: e.model, mode: (e.mode === 'onFail' ? 'onFail' : 'afterAll'), providers: (e.providers && e.providers.length ? e.providers.filter(Boolean) : (_m ? [ _m.provider, ...(_m.fallbacks || []) ].filter(Boolean) : [])) })
      }
    }
  } else {
    // 默认路径：直接走 defaults.directory（首项即默认模型），否则用 defaults.provider
    if (dir.length) {
      for (const e of dir) { if (e && typeof e.model === 'string' && e.model) { const _m = cfg.models && cfg.models[e.model]; routes.push({ model: e.model, mode: (e.mode === 'onFail' ? 'onFail' : 'afterAll'), providers: (e.providers && e.providers.length ? e.providers.filter(Boolean) : (_m ? [ _m.provider, ...(_m.fallbacks || []) ].filter(Boolean) : [])) }) } }
      const d0 = routes[0] && cfg.models && cfg.models[routes[0].model]
      if (d0) { maxModel = d0.maxConcurrent || 0; qps = d0.qps || 0 }
    } else {
      routes.push({ model: null, providers: [cfg.defaults && cfg.defaults.provider].filter(Boolean) })
      if (!(cfg.defaults && cfg.defaults.provider)) return { kind: 'json', status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ error: { message: '\u672a\u6307\u5b9a model\uff0c\u4e14\u672a\u8bbe\u7f6e\u9ed8\u8ba4\u4e0a\u6e38\uff08\u8bf7\u5728\u9762\u677f\u300c\u9ed8\u8ba4\u4e0a\u6e38\u300d\u4e2d\u9009\u62e9\uff09', type: 'missing_model' } })) }
    }
  }
  const started = Date.now()
  const modelName = (body && body.model) || (routes[0] && routes[0].model) || (cfg.defaults && cfg.defaults.provider) || (routes[0] && routes[0].providers && routes[0].providers[0]) || null
  const bm = state.stats.byModel[modelName] = state.stats.byModel[modelName] || { requests: 0, errors: 0 }

  let releaseModel = null
  if (maxModel > 0) releaseModel = await acquireSem(modelThrottleOf(state, modelName, maxModel))
  if (qps > 0) await rateWait(state, modelName, qps)
  let lastErr = null
  let tried = false
  const loopMs = (cfg.defaults && cfg.defaults.timeout && cfg.defaults.timeout.loopMs) || 120000
  const loopDeadline = Date.now() + loopMs
  const _sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const chainModels = []            // 实际尝试过的 serving 模型链（跨模型兜底/循环标记，供日志/面板查看）
  try {
  // 循环兜底：整条路由链(a→b→c)一轮失败后回到队首反复尝试，直到成功 / 业务4xx / 整体超时(loopMs)
  while (Date.now() < loopDeadline) {
    let cycleTried = false
    for (const route of routes) {
      const serving = route.model
    const lim = routeLimit(state, cfg, serving, body)
    if (lim) { log && log.warn('skip model (' + lim + ')', serving || '-', '-> next'); continue } // 额度/上下文超限：自动断连并按目录切换到下一模型
    const provs = (route.mode === 'onFail') ? route.providers.slice(0, 1) : orderCandidates(state, route.model, route.providers)
    for (const pid of provs) {
    if (!pid || !cfg.providers[pid]) continue
    const prov = buildProvider(cfg, pid)
    const h = ensureHst(state, pid)
    if (!healthy(h, Date.now())) { markFail(state, pid, prov.circuit); continue } // 熔断中：跳过，视为失败推进
    if ((h.streamDrops || 0) >= STREAM_DROP_THRESHOLD) { log && log.warn('skip provider (流中断过多，绕开)', pid); markFail(state, pid, prov.circuit); continue } // 连续流式中断过多：绕开该上游，走其他上游/模型
    if (prov._def.apiKeyEnv && !prov.keyOk) { log && log.warn('skip provider (no key)', pid); continue }
    tried = true
    cycleTried = true
    if (chainModels[chainModels.length - 1] !== serving) chainModels.push(serving)
    agg(state, pid, 'requests', 1); state.st.counters.requests += 1; bm.requests += 1
    // 跨模型兜底：把发给上游的 model 名改写为该兜底模型名
    const routeBody = (route.model && body && route.model !== body.model) ? Object.assign({}, body, { model: route.model }) : body
    let turl = url, tbuf = bodyBuf, api = prov.api
    let degraded = false
    if (api !== 'openai' && routeBody) { const ad = adapterFor(api); const r = ad.build(routeBody); if ((routeBody.tools || routeBody.tool_choice) && routeBody.stream) { r.body.stream = false; degraded = true } turl = r.path; tbuf = Buffer.from(JSON.stringify(r.body)) }
    else if ((injectedEffort || routeBody !== body) && routeBody) tbuf = Buffer.from(JSON.stringify(routeBody))
    const headers = buildHeaders(req, prov, tbuf, cfg)
    const release = await acquireProvider(state, pid, cfg)
    const attemptStart = Date.now()
    try {
      const result = await forward(prov, turl, req.method, headers, tbuf, cfg.defaults || {}, log)
      const latency = Date.now() - attemptStart
      const o = ensureSt(state, pid)
      o.latencySum += latency; o.latencyCount += 1
      o.lats.push(latency); if (o.lats.length > 200) o.lats.shift()
      state.stats.global.latencySum += latency; state.stats.global.confirmed += 1
      state.stats.global.lats.push(latency); if (state.stats.global.lats.length > 200) state.stats.global.lats.shift()
      bm.latencySum = (bm.latencySum || 0) + latency; bm.latencyCount = (bm.latencyCount || 0) + 1
      agg(state, pid, 'retries', result.retries || 0)
      if (result.ok) {
        markOk(state, pid)
        noteAffinity(state, serving || route.model, pid) // 记录本次成功上游，供后续请求保持亲和、复用其缓存
        if (isStreamResponse(result)) {
          const reconnector = async () => {
            const again = await forward(prov, turl, req.method, headers, tbuf, cfg.defaults || {}, log)
            if (!again.ok) throw new Error('reconnect status ' + again.status)
            return again.stream
          }
          return { kind: 'stream', res: result, pid, modelName, serving, api, reconnect: reconnector, dialogueId, chain: chainModels.join('>') }
        }
        let out = await collectBody(result.stream)
        out = maybeGunzip(out, result.headers && result.headers['content-encoding'])
        const parsed = tryParse(out)
        const usage = parsed && parsed.usage
        if (usage) {
          const c = cacheHitMiss(api, usage)
          const hit = c.hit, miss = c.miss
          noteCacheStat(state, serving || modelName, pid, hit, miss) // 按(模型,上游)记录缓存命中，供命中率路由与趋势告警使用
          agg(state, pid, 'tokens', usage.total_tokens || 0); state.stats.global.tokens += usage.total_tokens || 0
          // 按"实际响应的模型"累计其额度用量（日额度 + 累计额度）
          const sg = state.stats.byModel[serving || modelName] = state.stats.byModel[serving || modelName] || { requests: 0, errors: 0 }
          sg.tokens = (sg.tokens || 0) + (usage.total_tokens || 0)
          tallyDaily(state, serving || modelName, usage.total_tokens || 0, hit, miss)
          tallyDialogue(state, dialogueId, usage.total_tokens || 0, hit, miss)
        }
        if (api !== 'openai') { const p = tryParse(out); if (p) { let nb; try { nb = Buffer.from(JSON.stringify(adapterFor(api).fromUpstream(p))) } catch { nb = null } if (nb) out = nb } }
        // 「名字没对上」加固：跨模型兜底改写请求 model 后，响应 model 回写为客户端请求名，避免客户端续写/统计错位
        if (body && body.model && route.model && route.model !== body.model) {
          const p2 = tryParse(out)
          if (p2 && p2.model) { p2.model = body.model; out = Buffer.from(JSON.stringify(p2)) }
        }
        return { kind: 'json', status: result.status, contentType: 'application/json', body: out, pid, modelName, asSSE: degraded || undefined, dialogueId, chain: chainModels.join('>') }
      }
      // 非重试错误码（4xx）：业务问题，不熔断、不 fallback，直接返回
      markOk(state, pid)
      // 3xx 重定向对 Chat 端点属于异常：不跟随、不裸透传，明确转 502，避免客户端误跟随或解析错乱
      if (result.status >= 300 && result.status < 400) return { kind: 'json', status: 502, contentType: 'application/json', body: Buffer.from(JSON.stringify({ error: { message: 'upstream returned unexpected redirect (' + result.status + ')', type: 'upstream_error', status: result.status } })), pid, modelName, chain: chainModels.join('>') }
      const out = await collectBody(result.stream)
      if (out.length) return { kind: 'json', status: result.status, contentType: 'application/json; charset=utf-8', body: out, pid, modelName, chain: chainModels.join('>') }
      return { kind: 'json', status: result.status || 502, contentType: 'application/json', body: Buffer.from(JSON.stringify({ error: { message: 'gateway upstream error', type: 'upstream_error', status: result.status } })), pid, modelName }
    } catch (err) {
      const latency = Date.now() - attemptStart
      const o = ensureSt(state, pid)
      o.latencySum += latency; o.latencyCount += 1
      o.lats.push(latency); if (o.lats.length > 200) o.lats.shift()
      state.stats.global.latencySum += latency; state.stats.global.confirmed += 1
      state.stats.global.lats.push(latency); if (state.stats.global.lats.length > 200) state.stats.global.lats.shift()
      bm.latencySum = (bm.latencySum || 0) + latency; bm.latencyCount = (bm.latencyCount || 0) + 1
      agg(state, pid, 'errors', 1); state.st.counters.errors += 1; bm.errors += 1
      agg(state, pid, 'retries', err.retries || 0)
      if (err.status === 429) { const th = throttleOf(state, pid); th.rateUntil = Date.now() + (err.retryAfter || 3000) }
      markFail(state, pid, prov && prov.circuit)
      lastErr = err
      log && log.warn('provider failed', pid, err.message, '-> next fallback')
    } finally {
      release()
    }
    } // for pid
  } // for route
  if (!cycleTried) break // 整轮没有任何上游被真正尝试（全熔断/无 key/全额度跳过）：再循环无意义，直接收尾
  await _sleep(300)      // 一轮全败后回到队首前稍停，避免空转打爆上游
  } // while() 有界循环兜底：整条链(a→b→c)失败后回到 a 继续，直到成功 / 业务4xx / 整体超时 / 全部熔断
  if (!tried) return { kind: 'json', status: 502, contentType: 'application/json', chain: chainModels.join('>'), body: Buffer.from(JSON.stringify({ error: { message: lastErr ? lastErr.message : 'no usable provider (无可用上游：可能未配 Key 或全部熔断)', type: 'no_provider' } })) }
  return { kind: 'json', status: 502, contentType: 'application/json', chain: chainModels.join('>'), body: Buffer.from(JSON.stringify({ error: { message: lastErr && lastErr.message ? (lastErr.message + '（已循环兜底约 ' + Math.max(1, Math.round(loopMs / 1000)) + 's）') : 'all providers failed（已循环兜底约 ' + Math.max(1, Math.round(loopMs / 1000)) + 's）', type: 'all_providers_failed' } })) }
  } finally {
    if (releaseModel) releaseModel()
  }
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

function makeHandler(state) {
  const log = state.log
  const logFile = () => state.cfg.server && state.cfg.server.logFile
  async function requireAdmin(req, res) {
    if (adminOk(req, state)) return true
    sendJson(res, 401, { error: '未授权：请在控制面板设置管理令牌（MG_ADMIN_TOKEN）' })
    return false
  }
  return async function handler(req, res) {
    const path = (req.url || '/').split('?')[0]
    const url = req.url || '/'
    try {
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
        const body = tryParse(await collectBody(req)) || {}
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
      if (path === '/api/model-stats' && req.method === 'GET') { if (!await requireAdmin(req, res)) return; const days = Math.min(90, Math.max(1, parseInt(new URL(url, 'http://x').searchParams.get('days') || '7', 10) || 7)); const out = {}; const now = new Date(); const modelNames = Object.keys(state.cfg.models || {}); if (days === 1) { for (const name of modelNames) { const mh = state.stats.hourly[name] || {}; const arr = []; for (let i2 = 23; i2 >= 0; i2--) { const hd = new Date(now.getTime() - i2 * 3600 * 1000); const hk = todayKey(hd) + ':' + String(hd.getHours()).padStart(2, '0'); const c = mh[hk]; arr.push({ date: String(hd.getHours()).padStart(2, '0') + ':00', tokens: c ? c.tokens : 0, hitRate: (c && (c.hit + c.miss) > 0) ? Math.round((c.hit / (c.hit + c.miss)) * 1000) / 10 : null }) } out[name] = arr } } else { for (const name of modelNames) { const md = state.stats.daily[name] || {}; const arr = []; for (let i2 = days - 1; i2 >= 0; i2--) { const d = new Date(now); d.setDate(d.getDate() - i2); const k = todayKey(d); const c = md[k]; arr.push({ date: k, tokens: c ? c.tokens : 0, hitRate: (c && (c.hit + c.miss) > 0) ? Math.round((c.hit / (c.hit + c.miss)) * 1000) / 10 : null }) } out[name] = arr } } sendJson(res, 200, { days, mode: days === 1 ? 'hourly' : 'daily', models: out }); return }
      if (path === '/api/logs' && req.method === 'GET') { if (!await requireAdmin(req, res)) return; const lines = parseInt(new URL(url, 'http://x').searchParams.get('lines') || '200', 10) || 200; sendJson(res, 200, { lines: readLogTail(logFile(), lines) }); return }
      if (path === '/api/config/reload' && req.method === 'POST') { if (!await requireAdmin(req, res)) return; reloadConfig(state); sendJson(res, 200, { ok: true }); return }
      if (path === '/api/config/save' && req.method === 'POST') {
        if (!await requireAdmin(req, res)) return
        const body = tryParse(await collectBody(req))
        if (!body || typeof body !== 'object') { sendJson(res, 400, { error: '请求体必须为 JSON' }); return }
        const r = saveConfig(state, body)
        if (r.error) { sendJson(res, 400, { error: r.error }); return }
        sendJson(res, 200, { ok: true, status: buildStatus(state) }); return
      }
      if (path === '/api/keys' && req.method === 'POST') {
        if (!await requireAdmin(req, res)) return
        const body = tryParse(await collectBody(req))
        if (!body || !body.id) { sendJson(res, 400, { error: '缺少 provider id' }); return }
        const kr = saveKeys(state, body)
        if (kr.error) { sendJson(res, 400, { error: kr.error }); return }
        sendJson(res, 200, { ok: true, status: buildStatus(state) }); return
      }
      if (path === '/api/probe' && req.method === 'POST') {
        if (!await requireAdmin(req, res)) return
        const body = tryParse(await collectBody(req)) || {}
        const ids = body.id ? [String(body.id)] : Object.keys(state.cfg.providers || {})
        const results = []
        for (const id of ids) if (state.cfg.providers[id]) results.push(await doProbe(state, id))
        sendJson(res, 200, { ok: true, results, status: buildStatus(state) }); return
      }
      if (path === '/api/model-test' && req.method === 'POST') {
        if (!await requireAdmin(req, res)) return
        const body = tryParse(await collectBody(req)) || {}
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

      // —— 数据面客户端鉴权：配置了 clientKey 则校验 Bearer，否则向后兼容不鉴权 ——
      const clientKey = currentClientKey(state)
      if (clientKey && !clientAuthOk(req, clientKey)) { log && log.warn('数据面鉴权拒绝(401)', path, 'ip=' + ((req.socket && req.socket.remoteAddress) || '-') + ' ua=' + String(req.headers['user-agent'] || '-').slice(0, 40)); sendJson(res, 401, { error: { message: '无效的客户端接入 Key（状态 401）', type: 'unauthorized' } }); return }

      if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) { sendJson(res, 200, staticModels(state.cfg)); return }
      const isChat = CHAT_PATHS.has(path)
      if (!path.startsWith('/v1') && !isChat) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return }

      // —— 数据面转发（无鉴权保护，鉴权交给各上游 key） ——
      const bodyBuf = req.method === 'POST' || req.method === 'PUT' ? await collectBody(req, ((state.cfg.server && state.cfg.server.maxBodyBytes) || 32 * 1024 * 1024)) : null
      const body = bodyBuf && bodyBuf.length ? tryParse(bodyBuf) : null
      // 入口路径别名：把不带 /v1 的 Chat 兼容路径规范化为 /v1/chat/completions，使 base URL 填 http://127.0.0.1:8787 也被正确代理
      const fPath = (isChat && path !== '/v1/chat/completions') ? '/v1/chat/completions' : path
      const fUrl = (fPath === path) ? url : (fPath + url.slice(path.length))
      const out = await forwardChain(state, req, fUrl, fPath, req.method, bodyBuf, body, log)
      // 请求级日志：记录每次数据面请求的请求模型/实际服务模型/上游与结果，便于定位空响应与连接问题（不含消息正文/密钥）
      const reqModel = (body && body.model) || '-'
      const _chain = (n) => n || ''
      if (out.kind === 'stream') {
        log.info('data ' + req.method + ' ' + fPath + ' model=' + reqModel + ' serving=' + (out.serving || out.modelName || '-') + ' provider=' + (out.pid || '-') + ' chain=' + _chain(out.chain) + ' stream')
      } else {
        log.info('data ' + req.method + ' ' + fPath + ' -> ' + (out.status || '-') + ' model=' + reqModel + ' serving=' + (out.serving || out.modelName || '-') + ' provider=' + (out.pid || '-') + ' chain=' + _chain(out.chain))
        if (out.kind === 'json' && out.status >= 200 && out.status < 300 && out.body && out.body.length) {
          const _j = tryParse(out.body)
          const _cs = (_j && Array.isArray(_j.choices)) ? _j.choices : []
          const _has = _cs.some((c) => { const m = c && c.message; return m && typeof m.content === 'string' && m.content.length })
          if (!_has) log.warn('data 2xx 无正文内容 model=' + reqModel + ' serving=' + (out.serving || out.modelName || '-') + ' provider=' + (out.pid || '-'))
        }
      }
      if (out.kind === 'stream') {
        writeUpstreamHeaders(res, out.res)
        await relayStream(res, out.res.stream, {
          idleMs: (state.cfg.defaults && state.cfg.defaults.timeout && state.cfg.defaults.timeout.idleMs) || 0,
          maxReconnects: 2, log, reconnect: out.reconnect,
          protocol: out.api || 'openai', extract: (out.api && out.api !== 'openai') ? adapterFor(out.api).extractStreamContent : undefined,
          rewriteModel: (body && body.model) || null, // 「名字没对上」：响应 model 回写为客户端请求名
          onTokens: (n, usage) => {
            const total = (usage && typeof usage.total_tokens === 'number' && usage.total_tokens > 0) ? usage.total_tokens : n
            if (total > 0) { agg(state, out.pid, 'tokens', total); const sm = out.serving || out.modelName; const sg = state.stats.byModel[sm] = state.stats.byModel[sm] || { requests: 0, errors: 0 }; sg.tokens = (sg.tokens || 0) + total; tallyDaily(state, sm, total, 0, 0); tallyDialogue(state, out.dialogueId, total, 0, 0) }
          },
          onUsage: (u) => { const c = cacheHitMiss(out.api, u); if (c.hit > 0 || c.miss > 0) { const sm = out.serving || out.modelName; noteCacheStat(state, sm, out.pid, c.hit, c.miss); tallyDaily(state, sm, 0, c.hit, c.miss); tallyDialogue(state, out.dialogueId, 0, c.hit, c.miss) } },
          onEnd: (info) => {
            if (!info) return
            const sm = out.serving || out.modelName
            const h = ensureHst(state, out.pid)
            if (info.interrupted) {
              state.st.counters.interrupts += 1; state.stats.global.interrupts += 1
              agg(state, out.pid, 'errors', 1); state.st.counters.errors += 1
              const sg = state.stats.byModel[sm] = state.stats.byModel[sm] || { requests: 0, errors: 0 }
              sg.errors = (sg.errors || 0) + 1
              // 独立连续中断计数（markOk 不会重置它）：连续多次流中断让路由绕开该上游
              h.streamDrops = (h.streamDrops || 0) + 1
              log && log.warn('sse 流中断(续传' + ((info.reconnects || 0)) + '次仍失败)，已计入中断+上游错误，该上游累计连续中断 ' + h.streamDrops, 'model=' + sm + ' provider=' + (out.pid || '-'), 'chain=' + (out.chain || '-'))
            } else {
              h.streamDrops = 0 // 正常完成一次流：重置连续中断计数
            }
          },
        })
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
      res.writeHead(out.status, { 'content-type': out.contentType }); res.end(out.body)
    } catch (err) {
      state.st.counters.errors += 1
      log && log.error('route failed', path, '->', err.message)
      if (!res.headersSent) { const tooBig = /too large/i.test(String(err.message || '')); sendJson(res, tooBig ? 413 : 502, { error: { message: err.message || String(err), type: tooBig ? 'payload_too_large' : 'gateway_error' } }) }
      else if (!res.destroyed) { try { res.end() } catch {} }
    }
  }
}

export function start(opts = {}) {
  const cfg = opts.config ? loadConfig({ configFile: opts.config }) : loadConfig()
  const mb = process.env.MG_MAX_BODY ? parseInt(process.env.MG_MAX_BODY, 10) : 0
  if (mb > 0) cfg.server = Object.assign({}, cfg.server || {}, { maxBodyBytes: mb })
  // 收集所有密钥值供日志脱敏：环境变量 Key + 面板 Key + extraHeaders 值 + 客户端/管理令牌，确保永不落日志
  const secretList = []
  for (const d of Object.values(cfg.providers || {})) { if (d && d.apiKeyEnv && process.env[d.apiKeyEnv]) secretList.push(process.env[d.apiKeyEnv]) }
  for (const d of Object.values(cfg.providers || {})) { for (const v of Object.values((d && d.extraHeaders) || {})) if (v && String(v).length >= 3) secretList.push(String(v)) }
  for (const v of Object.values(cfg._keys || {})) { if (v) secretList.push(v) }
  if (process.env.MG_CLIENT_KEY) secretList.push(process.env.MG_CLIENT_KEY)
  if (process.env.MG_ADMIN_TOKEN) secretList.push(process.env.MG_ADMIN_TOKEN)
  const log = createLogger({ logFile: cfg.server && cfg.server.logFile, silent: opts.silent, secrets: secretList })
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
    cacheStat: {},       // "模型\0上游" → { hit, miss }（命中率路由）
    cacheTrend: [],      // 全局缓存命中率趋势样本 { t, v }（告警基线）
    cacheAlert: null,    // 最近一次命中率骤降告警
    dialogue: {},        // 对话维度统计：id -> { requests, tokens, hit, miss, startAt, lastAt, named }
    dUnnamed: null,      // 无会话 ID 时的当前兜底对话（按间隔切分）
    stats: { global: { requests:0, errors:0, retries:0, interrupts:0, tokens:0, latencySum:0, confirmed:0, lats: [], latTrend: [] }, byProvider: pids, byModel: {}, daily: {}, hourly: {} },
  }
  try { const _sf = state.paths.stats; const _j = existsSync(_sf) ? JSON.parse(readFileSync(_sf, 'utf8') || '{}') : {}; state.stats.daily = Object.assign({}, state.stats.daily, _j.daily || {}); state.stats.hourly = Object.assign({}, state.stats.hourly, _j.hourly || {}); for (const [n, t] of Object.entries(_j.byModel || {})) { state.stats.byModel[n] = Object.assign(state.stats.byModel[n] || { requests: 0, errors: 0 }, { tokens: (t && t.tokens) || 0 }) }; const _dlg = _j.dialogue || {}; for (const k of Object.keys(_dlg)) state.dialogue[k] = _dlg[k]; let _u = null; for (const k of Object.keys(state.dialogue)) { if (k.startsWith('conv-') && (!_u || state.dialogue[k].lastAt > _u.lastAt)) _u = state.dialogue[k] } state.dUnnamed = _u || null; const _g = _j.global || {}; for (const k of ['requests','errors','retries','interrupts','tokens','latencySum','confirmed']) if (typeof _g[k] === 'number') state.stats.global[k] = _g[k]; if (Array.isArray(_g.lats)) state.stats.global.lats = _g.lats; if (Array.isArray(_g.latTrend)) state.stats.global.latTrend = _g.latTrend; for (const [pid, po] of Object.entries(_j.byProvider || {})) { const o = ensureSt(state, pid); for (const k of ['requests','errors','retries','latencySum','latencyCount','tokens']) if (typeof po[k] === 'number') o[k] = po[k]; if (Array.isArray(po.lats)) o.lats = po.lats; if (po.probe) o.probe = po.probe } } catch { /* 统计文件缺失/损坏则从空开始 */ }
  setInterval(() => { try { const q = {}; for (const [n, m] of Object.entries(state.stats.byModel || {})) q[n] = { tokens: m.tokens || 0 }; const g = state.stats.global || {}; const globalP = { requests: g.requests||0, errors: g.errors||0, retries: g.retries||0, interrupts: g.interrupts||0, tokens: g.tokens||0, latencySum: g.latencySum||0, confirmed: g.confirmed||0, lats: g.lats||[], latTrend: g.latTrend||[] }; const provP = {}; for (const [pid, o] of Object.entries(state.stats.byProvider || {})) provP[pid] = { requests: o.requests||0, errors: o.errors||0, retries: o.retries||0, latencySum: o.latencySum||0, latencyCount: o.latencyCount||0, tokens: o.tokens||0, lats: o.lats||[], probe: o.probe||null }; writeFileSync(state.paths.stats, JSON.stringify({ daily: state.stats.daily, hourly: state.stats.hourly, byModel: q, dialogue: state.dialogue, global: globalP, byProvider: provP })) } catch {} }, 30000).unref()
  setInterval(() => { const l = state.stats.global.lats; const avg = (l && l.length) ? Math.round(l.reduce((a, b) => a + b, 0) / l.length) : 0; const tr = state.stats.global.latTrend; tr.push({ t: Date.now(), v: avg }); if (tr.length > 80) tr.shift() }, 10000).unref()
  // B4 主动缓存预热：按 defaults.preheat 周期向模型上游发送带长 system 前缀的最小请求，保持厂商 prefix cache 存活
  ;(() => { const lastWarm = {}; setInterval(async () => {
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
      const r = await warm(prov, e.model, e.system, state.cfg.defaults || {}, log)
      log && (r.ok ? log.info('preheat ok', e.model, 'status ' + r.status) : log.warn('preheat fail', e.model, r.status || r.err || '-'))
    }
  }, 15000).unref() })()
  // B5 缓存命中率趋势 + 骤降告警：近期命中率相对基线明显下滑时告警（通常因模型/上游切换导致缓存碎片化）
  ;(() => { setInterval(() => {
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
  if (state.adminToken) log.info('管理 API 已启用令牌保护（MG_ADMIN_TOKEN）')
  else log.warn('未设置 MG_ADMIN_TOKEN：管理 API(/api/*)无鉴权裸露，仅建议绑定回环地址使用')
  hardenKeyFile(state.paths.keys)
  const server = opts.server || http.createServer(makeHandler(state))
  const host = (cfg.server && cfg.server.host) || '127.0.0.1'
  const port = (cfg.server && cfg.server.port) || 8787
  server.on('error', (err) => { log.error('server error', err.message); process.exitCode = 1 })
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      log.info('model-gateway 已启动: http://' + host + ':' + port + '  (健康检查 /healthz, 控制面板 /)')
      resolve({ cfg, log, server, router: state.router, st: state.st })
    })
  })
}

const MAIN_HREF = process.argv[1] ? (await import('node:url')).pathToFileURL(process.argv[1]).href : ''
if (import.meta.url === MAIN_HREF && basename(process.argv[1] || '').toLowerCase() === 'index.js') {
  start().catch((err) => { console.error('fatal:', err.message); process.exit(1) })
}