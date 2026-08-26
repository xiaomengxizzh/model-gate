import http from 'node:http'
import { readFileSync, chmodSync, existsSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { loadConfig, createRouter, buildProvider, configPaths, writeJsonAtomic, keysEncrypt, readJson, readKeysFresh } from './router.js'
import { createLogger } from './logger.js'
import { forward, probe, probeModel, warm } from './request.js'
import { adapterFor, cacheHitMiss } from './format.js'
import { isStreamResponse, writeUpstreamHeaders, relayStream } from './sse.js'
import { forwardChain, routeLimit, virtualQuotaExceeded } from './forward.js'
import { todayKey } from './shared.js'

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
function tallyDaily(state, modelName, tokens, hit, miss) { if (!modelName) return; const now = new Date(); const k = todayKey(now); const m = state.stats.daily[modelName] || (state.stats.daily[modelName] = {}); const c = m[k] || (m[k] = { tokens: 0, hit: 0, miss: 0 }); c.tokens += tokens || 0; c.hit += hit || 0; c.miss += miss || 0; const hk = k + ':' + String(now.getHours()).padStart(2, '0'); const hm = state.stats.hourly[modelName] || (state.stats.hourly[modelName] = {}); const h = hm[hk] || (hm[hk] = { tokens: 0, hit: 0, miss: 0 }); h.tokens += tokens || 0; h.hit += hit || 0; h.miss += miss || 0 }
// 虚拟模型入口账本：serving 与入口名不同且入口是虚拟模型时，同步计入虚拟名（供其自身 quota/dailyQuota 检查）
function tallyVirtual(state, modelName, serving, tokens) {
  if (!modelName || !serving || modelName === serving) return
  if (!(state.cfg.virtualModels || []).some(v => v.name === modelName)) return
  const svg = state.stats.byModel[modelName] = state.stats.byModel[modelName] || { requests: 0, errors: 0 }
  svg.tokens = (svg.tokens || 0) + (tokens || 0)
  tallyDaily(state, modelName, tokens, 0, 0)
}
function agg(state, pid, field, delta) { if (state.stats.byProvider[pid]) state.stats.byProvider[pid][field] += delta; state.stats.global[field] += delta }

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
      apiKeyEnv: p.apiKeyEnv || null, pathPrefix: p.pathPrefix || '', api: p.api || 'openai', extraHeaders: p.extraHeaders || {}, proxy: p.proxy || '',
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
    return { name, provider: d.provider, alias: d.alias || [], fallbacks: d.fallbacks || [], maxConcurrent: d.maxConcurrent || 0, qps: d.qps || 0, reasoning: d.reasoning || '', effortOptions: d.effortOptions || [], effortFormat: d.effortFormat || '', dailyQuota: d.dailyQuota || 0, quota: d.quota || 0, maxContext: d.maxContext || 0, probe: m.probe || null, requests: m.requests, errors: m.errors, tokens: m.tokens || 0, today: dk.tokens || 0, hitRate, affinity: state.affinity[name] || null, avgMs: m.latencyCount ? Math.round(m.latencySum / m.latencyCount) : null }
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
    global: { requests: s.global.requests, errors: s.global.errors, retries: s.global.retries, interrupts: s.global.interrupts, tokenCount: s.global.tokens, todayTokens: todayTotal, avgMs: s.global.confirmed ? Math.round(s.global.latencySum / s.global.confirmed) : null, p50: pct(s.global.lats, 50), p95: pct(s.global.lats, 95), latTrend: s.global.latTrend || [] },
    cache: { trend: state.cacheTrend || [], alert: state.cacheAlert || null },
    dialogues: Object.values(state.dialogue).filter(d => d.requests > 0).sort((a, b) => b.lastAt - a.lastAt).slice(0, 30).map(d => ({ id: d.id, named: d.named, requests: d.requests, tokens: d.tokens, hit: d.hit, miss: d.miss, hitRate: (d.hit + d.miss) > 0 ? Math.round(d.hit / (d.hit + d.miss) * 1000) / 10 : null, startAt: d.startAt, lastAt: d.lastAt })),
    providers,
    models,
    defaults: { provider: defaults.provider || null, model: defaults.model || '', clientKey: currentClientKey(state) ? '********' : '', directory: defaults.directory || [], preheat: defaults.preheat || [], retry: defaults.retry || {}, timeout: defaults.timeout || {}, concurrency: defaults.concurrency || {}, extraHeaders: defaults.extraHeaders || {}, proxy: defaults.proxy || '', proxyMode: defaults.proxyMode || 'auto' },
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
  for (const v of cfg.virtualModels || []) if (!data.some((m) => m.id === v.name)) data.push({ id: v.name, object: 'model', owned_by: 'model-gateway' })
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
// 写盘互斥：saveConfig/saveKeys 当前为同步函数（事件循环天然串行、无交错），
// 此队列固化「读改写全程独占」语义，防止未来异步化（fs/promises）后出现交错写与 tmp 同名冲突
let _cfgWriteChain = Promise.resolve()
function withConfigWriteLock(fn) {
  const run = _cfgWriteChain.then(fn, fn)
  _cfgWriteChain = run.then(() => {}, () => {})
  return run
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
  const _c = versionConflict(state, body); if (_c) return _c
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
    if (m.effortFormat != null && m.effortFormat !== '' && !['reasoning_effort', 'thinking'].includes(m.effortFormat)) return { error: '模型「' + mn + '」的 effortFormat 仅支持 reasoning_effort/thinking' }
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
  for (const [id, p] of Object.entries(providers || {})) { const { keyOk, keySource, ...rest } = p || {}; clean[id] = rest }
  // —— virtualModels 强校验（面板保存路径；loadConfig 另有容错规范化，手改坏配置不宕机）——
  const vmsIn = body.virtualModels !== undefined ? body.virtualModels : (cur.virtualModels || [])
  const vmNames = new Set()
  for (const vm of vmsIn) {
    if (!vm || typeof vm.name !== 'string' || !vm.name.trim()) return { error: '虚拟模型缺少名称' }
    const name = vm.name.trim()
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
  writeJsonAtomic(state.paths.local, { configVersion: newVersion, providers: clean, models, defaults, virtualModels: cleanVms })
  reloadConfig(state)
  return { version: newVersion }
}
function saveKeys(state, body) { return withConfigWriteLock(() => doSaveKeys(state, body)) }
async function doSaveKeys(state, body) {
  const _c = versionConflict(state, body); if (_c) return _c
  // 盘上最新 keys 合并（而非内存副本）
  const keys = Object.assign({}, readKeysFresh(state.paths.keys))
  if (body.key) keys[body.id] = body.key
  else delete keys[body.id]
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
  const r = await probeModel(prov, model)
  const o = (state.stats.byModel[model] = state.stats.byModel[model] || { requests: 0, errors: 0 })
  o.probe = { at: Date.now(), ok: r.ok, code: r.code, ms: r.ms, err: r.err || null }
  return { id: model, ok: r.ok, code: r.code, ms: r.ms, err: r.err || null }
}

// ── 按对话（会话）统计：会话 ID 优先，无 ID 按时间间隔切分兜底 ──
// 解析本次请求归属的对话 ID：优先请求头 X-Conversation-Id / X-Session-Id，其次 body session_id/conversation_id；
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

const FWD_DEPS = { ensureHst, markFail, markOk, healthy, effState: (h, now) => (h.state === 'open' && h.openUntil <= now) ? 'half' : h.state, agg, ensureSt, noteAffinity, noteCacheStat, tallyDaily, tallyVirtual, tallyDialogue, tryParse, collectBody }
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
      if (path === '/api/route-preview' && req.method === 'POST') {
        if (!await requireAdmin(req, res)) return
        const body = tryParse(await collectBody(req)) || {}
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
      if (path === '/api/logs' && req.method === 'GET') { if (!await requireAdmin(req, res)) return; const lines = parseInt(new URL(url, 'http://x').searchParams.get('lines') || '200', 10) || 200; sendJson(res, 200, { lines: readLogTail(logFile(), lines) }); return }
      if (path === '/api/config/reload' && req.method === 'POST') { if (!await requireAdmin(req, res)) return; reloadConfig(state); sendJson(res, 200, { ok: true }); return }
      if (path === '/api/config/save' && req.method === 'POST') {
        if (!await requireAdmin(req, res)) return
        const body = tryParse(await collectBody(req))
        if (!body || typeof body !== 'object') { sendJson(res, 400, { error: '请求体必须为 JSON' }); return }
        const r = await saveConfig(state, body)
        if (r.error) { sendJson(res, 400, { error: r.error }); return }
        if (r.conflict) { sendJson(res, 409, { error: '配置版本已过期（他处已保存过新版本），请刷新后重试', currentVersion: r.currentVersion }); return }
        sendJson(res, 200, { ok: true, status: buildStatus(state) }); return
      }
      if (path === '/api/keys' && req.method === 'POST') {
        if (!await requireAdmin(req, res)) return
        const body = tryParse(await collectBody(req))
        if (!body || !body.id) { sendJson(res, 400, { error: '缺少 provider id' }); return }
        const kr = await saveKeys(state, body)
        if (kr.error) { sendJson(res, 400, { error: kr.error }); return }
        if (kr.conflict) { sendJson(res, 409, { error: '配置版本已过期（他处已保存过新版本），请刷新后重试', currentVersion: kr.currentVersion }); return }
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

      // —— 数据面客户端鉴权（两阶段，Phase1 Step4）——
      // 一阶段：全局 clientKey（常规 agent 零额外开销，行为与旧版完全一致）
      const clientKey = currentClientKey(state)
      if (clientKey && !clientAuthOk(req, clientKey)) {
        // 二阶段（仅当配置了虚拟模型）：解析 body.model 逐虚拟模型 key 校验；否则按旧口径 401
        const vms = state.cfg.virtualModels || []
        if (vms.length && CHAT_PATHS.has(path) && (req.method === 'POST' || req.method === 'PUT')) {
          const bodyBuf2 = await collectBody(req, (state.cfg.server && state.cfg.server.maxBodyBytes) || 32 * 1024 * 1024)
          const body2 = bodyBuf2 && bodyBuf2.length ? tryParse(bodyBuf2) : null
          const reqModel = body2 && typeof body2.model === 'string' ? body2.model.trim() : ''
          const vm = vms.find(v => v.name === reqModel)
          const vmKey = vm ? (state.cfg._keys && state.cfg._keys['__mg_vm_' + vm.name]) : null
          if (vm && vmKey) {
            // 虚拟模型独立 Key：过期检查（元数据 expiresAt）+ 常量时间比较
            const meta = state.cfg._keys && state.cfg._keys['__mg_vm_meta_' + vm.name]
            if (meta && meta.expiresAt && Date.now() > Number(meta.expiresAt)) {
              log && log.warn('数据面鉴权拒绝(401 虚拟key已过期)', path, 'model=' + vm.name); sendJson(res, 401, { error: { message: '无效的客户端接入 Key（状态 401）', type: 'unauthorized' } }); return
            }
            if (clientAuthOk(req, vmKey)) { req.__mgBodyBuf = bodyBuf2; req.__mgBody = body2 } // 校验通过：缓存 body 供后续转发复用
            else { log && log.warn('数据面鉴权拒绝(401 虚拟key不匹配)', path, 'model=' + vm.name); sendJson(res, 401, { error: { message: '无效的客户端接入 Key（状态 401）', type: 'unauthorized' } }); return }
          } else {
            // 未命中任何「绑了 key 的虚拟模型」→ 统一 401（不区分模型不存在/key 错，防虚拟模型名枚举）
            log && log.warn('数据面鉴权拒绝(401)', path, 'ip=' + ((req.socket && req.socket.remoteAddress) || '-') + ' ua=' + String(req.headers['user-agent'] || '-').slice(0, 40)); sendJson(res, 401, { error: { message: '无效的客户端接入 Key（状态 401）', type: 'unauthorized' } }); return
          }
        } else {
          log && log.warn('数据面鉴权拒绝(401)', path, 'ip=' + ((req.socket && req.socket.remoteAddress) || '-') + ' ua=' + String(req.headers['user-agent'] || '-').slice(0, 40)); sendJson(res, 401, { error: { message: '无效的客户端接入 Key（状态 401）', type: 'unauthorized' } }); return
        }
      }

      if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) { sendJson(res, 200, staticModels(state.cfg)); return }
      const isChat = CHAT_PATHS.has(path)
      if (!path.startsWith('/v1') && !isChat) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return }

      // —— 数据面转发（二阶段鉴权已收集 body 时直接复用，流不可二次读取） ——
      let bodyBuf = req.__mgBodyBuf || null
      if (!bodyBuf && (req.method === 'POST' || req.method === 'PUT')) bodyBuf = await collectBody(req, ((state.cfg.server && state.cfg.server.maxBodyBytes) || 32 * 1024 * 1024))
      const body = req.__mgBody || (bodyBuf && bodyBuf.length ? tryParse(bodyBuf) : null)
      // 入口路径别名：把不带 /v1 的 Chat 兼容路径规范化为 /v1/chat/completions，使 base URL 填 http://127.0.0.1:8787 也被正确代理
      const fPath = (isChat && path !== '/v1/chat/completions') ? '/v1/chat/completions' : path
      const fUrl = (fPath === path) ? url : (fPath + url.slice(path.length))
      const out = await forwardChain(FWD_DEPS, state, req, fUrl, fPath, req.method, bodyBuf, body, log)
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
            if (total > 0) { agg(state, out.pid, 'tokens', total); const sm = out.serving || out.modelName; const sg = state.stats.byModel[sm] = state.stats.byModel[sm] || { requests: 0, errors: 0 }; sg.tokens = (sg.tokens || 0) + total; tallyDaily(state, sm, total, 0, 0); tallyVirtual(state, out.modelName, out.serving, total); tallyDialogue(state, out.dialogueId, total, 0, 0) }
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
  setInterval(() => { try { pruneStatsHistory(state); const q = {}; for (const [n, m] of Object.entries(state.stats.byModel || {})) q[n] = { tokens: m.tokens || 0 }; const g = state.stats.global || {}; const globalP = { requests: g.requests||0, errors: g.errors||0, retries: g.retries||0, interrupts: g.interrupts||0, tokens: g.tokens||0, latencySum: g.latencySum||0, confirmed: g.confirmed||0, lats: g.lats||[], latTrend: g.latTrend||[] }; const provP = {}; for (const [pid, o] of Object.entries(state.stats.byProvider || {})) provP[pid] = { requests: o.requests||0, errors: o.errors||0, retries: o.retries||0, latencySum: o.latencySum||0, latencyCount: o.latencyCount||0, tokens: o.tokens||0, lats: o.lats||[], probe: o.probe||null }; writeFileSync(state.paths.stats, JSON.stringify({ daily: state.stats.daily, hourly: state.stats.hourly, byModel: q, dialogue: state.dialogue, global: globalP, byProvider: provP })) } catch {} }, 30000).unref()
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