import http from 'node:http'
import { pipeline } from 'node:stream'
import { readFileSync, chmodSync, existsSync, copyFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename } from 'node:path'
import { gunzipSync, inflateSync, brotliDecompressSync, zstdDecompressSync } from 'node:zlib'
import { isIP } from 'node:net'
import { loadConfig, createRouter, buildProvider, resolveKey, configPaths, writeJsonAtomic, keysEncrypt, readKeysFresh, readLocalConfigStrict, isConfigUnreadable, modelTarget } from './router.js'
import { beginWrite, recoverStore, TARGET_CONFIG, TARGET_KEYS } from './config-transaction.js'
import { createLogger } from './logger.js'
import { forward, upstreamUrl, probe, probeModel, probeChat, warm, probeEmbedding, probeRerank } from './request.js'
import { adapterFor, cacheHitMiss, mapErrorEnvelope } from './format.js'
import { isStreamResponse, writeUpstreamHeaders, relayStream, endInterruptedStream } from './sse.js'
import { forwardChain, routeLimit, virtualQuotaExceeded, acquireProvider, initForwardLedger, authorizeSendTarget, scrubBody, buildHeaders } from './forward.js'
import { isToolBearingBody } from './retry-policy.js'
import { createBudget, abortedError } from './budget.js'
import { responsesToChat, chatToResponse, LEGACY_BRIDGE_COMPAT, prepareCodexNativeRequest } from './responses.js'
import { createResponsesStream, createCodexStreamAdapter } from './responses-stream.js'
import { validateEmbeddingRequest, buildEmbeddingRequest, embeddingHeaders, normalizeEmbeddingResponse, supportsEmbeddings, MAX_EMBEDDING_INPUTS } from './embeddings.js'
import { validateRerankRequest, buildRerankRequest, rerankHeaders, normalizeRerankResponse, supportsRerank } from './rerank.js'
import { supportsMedia, parseMultipartField, replaceMultipartField, isMultipart, validateSpeechRequest, validateImageRequest, mediaResponseLimit } from './media.js'
import { defaultVideoPaths, newVideoTask, upstreamTaskId, applyUpstreamStatus, clientTask, loadVideoTasks, saveVideoTasks, gcVideoTasks, findSubjectTask, videoInputHash, recoverInterruptedVideoTasks, validateVideoCreate, VIDEO_POLL_MIN_MS } from './videos.js'
import { todayKey } from './shared.js'
import { readNativeUsage, nativeUsageConfig } from './native-usage.js'
import { classifyTarget } from './codex/identity.js'
import { restoreResponseJson, detectOpaqueV2Task, detectEncryptedToolSchema } from './codex/interop.js'
// G1（2026-11-13）：codex/local-subscription.js 已删除。生产代码不读取 Codex 登录态，
// 也不再向订阅后端发送本机 token；残留 gatewaySubscription 配置在请求入口 fail-closed。
import { isTargetAuthzError, GATEWAY_SUBSCRIPTION_RETIRED_CODE, GATEWAY_SUBSCRIPTION_RETIRED_MESSAGE } from './codex/target-authz.js'
import { createCapabilityRegistry, PROVEN_OPTIONAL_CAPABILITIES } from './optional/policy.js'
import { createObservability, hashId } from './observability/events.js'
import { buildCatalog } from './codex/catalog.js'
import { generationRecordFromBuilt, toCatalogView } from './codex/catalog-generation.js'
import { microFromUsd } from './routing/facts.js'
import { planTargetHeaders, targetDeny, legacyPassthroughRequested } from './codex/auth.js'
import { handleCodexApi, isCodexApiPath } from './codex/api.js'
import { registerConfigRoot, sha256Hex } from './codex/config.js'

// 数据面 Chat 入口别名：兼容 base URL 不带 /v1 的 OpenAI 兼容客户端（它们会拼 /chat/completions 或 /v1/chat/completions）
const CHAT_PATHS = new Set(['/v1/chat/completions', '/chat/completions'])
const RESPONSES_PATHS = new Set(['/v1/responses', '/responses'])
const ADMIN_PAGE = new URL('./admin.html', import.meta.url)
// Isolated /ui-next console: serve only the frozen asset tree, no directory listing,
// no path traversal, no symlink following. Old '/' and '/admin' remain unchanged.
const UI_NEXT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.json': 'application/json; charset=utf-8',
})
function uiNextAsset(path) {
  let rel
  if (path === '/ui-next' || path === '/ui-next/') rel = 'index.html'
  else if (path.startsWith('/ui-next/')) rel = path.slice('/ui-next/'.length)
  else return null
  try { rel = decodeURIComponent(rel) } catch { return null }
  if (!rel || rel.startsWith('/') || rel.includes('\\') || rel.includes('\0')) return null
  const parts = rel.split('/')
  if (parts.some((p) => !p || p === '.' || p === '..')) return null
  if (!/^[A-Za-z0-9._/-]+$/.test(rel)) return null
  const name = parts[parts.length - 1]
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
  const type = UI_NEXT_TYPES[ext]
  if (!type) return null
  return { rel, type }
}

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

// —— 请求体压缩解码（Codex 0.167 官方路径实测 content-encoding: zstd）——
// 解压后必须删除请求上的 content-encoding：buildHeaders 会原样复制头，而 content-length 已按解压后长度重写，
// 保留旧编码声明会让上游按错误长度/编码解析。未知编码 fail-closed（415），绝不把压缩字节当 JSON 透传。
const MAX_INFLATED_BODY = 64 * 1024 * 1024
function decodeRequestBody(buf, headerValue) {
  const encs = String(headerValue || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean)
  let out = buf
  try {
    for (const enc of encs.reverse()) {
      if (enc === 'identity' || enc === '') continue
      else if (enc === 'gzip' || enc === 'x-gzip') out = gunzipSync(out, { maxOutputLength: MAX_INFLATED_BODY })
      else if (enc === 'deflate') out = inflateSync(out, { maxOutputLength: MAX_INFLATED_BODY })
      else if (enc === 'br') out = brotliDecompressSync(out, { maxOutputLength: MAX_INFLATED_BODY })
      else if (enc === 'zstd') out = zstdDecompressSync(out, { maxOutputLength: MAX_INFLATED_BODY })
      else return { error: 'unsupported content-encoding: ' + enc }
    }
  } catch (e) {
    return { error: 'invalid compressed request body: ' + ((e && e.message) || 'decode failed') }
  }
  return { buf: out }
}

// 读请求体并处理 content-encoding；解压失败/未知编码返回 {error}，由调用方回 415（不把压缩字节当 JSON）
async function readRequestBody(req, maxBytes, ctl) {
  const raw = await collectBody(req, maxBytes, ctl)
  const enc = req.headers['content-encoding']
  if (!raw || !raw.length || !enc) return { buf: raw }
  const dec = decodeRequestBody(raw, enc)
  if (dec.error) return { error: dec.error }
  delete req.headers['content-encoding']
  return { buf: dec.buf }
}

// —— D2：Codex 远端模型目录（GET /v1/models?client_version=…）——
// Codex 0.167 在官方身份下会先拉这个接口，且只接受 {"models":[完整 ModelInfo…]}；
// 旧的 {"object":"list","data":[…]} 会让客户端报 "failed to decode models response"（实测致命，resume 时直接失败）。
// 目录来源：defaults.codexCatalogBasePath 指向 codex debug models 导出的官方基线，再由 buildCatalog 合并第三方模型。
// 结果按基线文件 (mtime,size) + 模型清单指纹缓存，避免每请求重算 700KB 目录。
let _codexModelsCache = null
let _codexCatalogError = null
// 返回 { key, models, bindings, officialSlugs } 或 null；按基线文件 (mtime,size) + 模型清单缓存。
// 目录不可用不阻断普通网关功能：null → 回落到旧 /v1/models 形状与第三方目录路由。
function codexCatalogView(cfg) {
  const basePath = cfg && cfg.defaults && cfg.defaults.codexCatalogBasePath
  if (!basePath || typeof basePath !== 'string') return null
  let st = null
  try { st = statSync(basePath) } catch { return null }
  const modelsKey = JSON.stringify(Object.keys((cfg && cfg.models) || {}).sort())
  const key = basePath + '|' + st.mtimeMs + '|' + st.size + '|' + modelsKey
  if (_codexModelsCache && _codexModelsCache.key === key) return _codexModelsCache
  let view = null
  try {
    const base = JSON.parse(readFileSync(basePath, 'utf8'))
    const built = buildCatalog({ base, config: cfg })
    const bindings = built.meta.bindings || {}
    // M1-3b：目录世代记录（generation/verified/key）供 forwardChain 的 catalogScoped 授权使用；
    // 世代号由同一 cache key 的稳定哈希派生，reload 后同目录快照保持同一代。
    const generation = Math.max(1, parseInt(sha256Hex(key).slice(0, 8), 16) || 1)
    try {
      const record = generationRecordFromBuilt({ generation, built, text: JSON.stringify(built.catalog), base, config: cfg })
      view = toCatalogView(record)
    } catch (e) {
      // 世代构造失败不阻断原有目录视图，但标记 unscoped-verified，后续 authz 仍会做 URL 一致性校验。
      view = {
        key, generation,
        models: built.catalog.models,
        bindings,
        officialSlugs: built.catalog.models.map((m) => m && m.slug).filter((s) => s && !bindings[s]),
        verified: { official: true, thirdParty: true, by: 'config-declared' },
      }
    }
  } catch (e) {
    // fail-closed 但必须可诊断：错误码/消息只进日志，不进响应；不含凭据与正文。
    _codexCatalogError = (e && (e.code || e.message)) ? String(e.code || '') + ' ' + String(e.message || '') : 'catalog_build_failed'
    return null
  }
  _codexCatalogError = null
  _codexModelsCache = view
  return view
}
// M1-3b：账本/授权注入（进程内单例由 forward.js 缓存；启动与 reload 都 recover）。
function microCap(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? microFromUsd(n) : 0 }
function ledgerOptionsOf(cfg) {
  const lc = cfg && cfg.routing && cfg.routing.ledger
  if (!lc || typeof lc !== 'object' || !lc.dir) return null
  const b = (cfg.routing && cfg.routing.budget) || {}
  return {
    dir: String(lc.dir),
    currency: lc.currency ? String(lc.currency) : 'USD',
    dayZone: lc.dayZone ? String(lc.dayZone) : 'Asia/Shanghai',
    caps: {
      requestMicro: microCap(b.requestUsd),
      taskMicro: microCap(b.taskUsd),
      dayMicro: microCap(b.dailyUsd),
    },
    quoteMaxAgeMs: Number(lc.quoteMaxAgeMs) > 0 ? Number(lc.quoteMaxAgeMs) : 0,
  }
}
// 只有目录 slug（codexAggregate/codexOfficial）才把 catalogRecord 传给 forwardChain；
// 普通官方 Chat/第三方仍走 config-declared 授权（不因目录存在而强制世代）。
function catalogAuthzContext(state, model) {
  const view = state && state.cfg && state.cfg._codexCatalog
  if (!view || view.generation == null) return undefined
  let hit = null
  try { hit = state.router.resolve(model) } catch { return undefined }
  const def = hit && hit.def
  if (!def || (def.codexAggregate !== true && def.codexOfficial !== true)) return undefined
  return { catalogGeneration: view.generation, catalogRecord: view }
}
function injectedNow() {
  const n = Number(process.env.MG_TEST_NOW)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

function codexModelsPayload(state) {
  const view = codexCatalogView(state.cfg)
  return view ? view.models : null
}
function isCodexModelListRequest(req, url) {
  if (/[?&]client_version=/.test(url || '')) return true
  return !!(req.headers['x-codex-window-id'] || req.headers['x-codex-beta-features'] || req.headers['originator'] === 'codex_cli_rs' || req.headers['chatgpt-account-id'])
}

// 上游偶发返回 gzip 响应却不带 content-encoding 头（如 opencodezen），会导致 usage 解析失败、统计断链

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}
function tryParse(buf) { try { return JSON.parse(buf.toString('utf8')) } catch { return null } }

// —— MG-009 D-6：只读配置投影（GET /api/config）——
// 与 /api/status 不同：只返回可编辑配置（五大业务键 + configVersion），不含运行时统计/探针/Key 明文，
// 供前端/脚本直接“读配置 → 改 → 保存”，避免从 status 反推把统计带回配置。
function configProjection(state) {
  const cfg = state.cfg
  const providers = {}
  for (const [id, p] of Object.entries(cfg.providers || {})) providers[id] = stripRuntimeFields(p, PROVIDER_RUNTIME_FIELDS)
  const models = {}
  for (const [n, m] of Object.entries(cfg.models || {})) models[n] = stripRuntimeFields(m, MODEL_RUNTIME_FIELDS)
  const defaults = Object.assign({}, cfg.defaults || {})
  // clientKey 实际存于加密 keys 库（__mg_client）；只检查 defaults 会永远回显空串，
  // 前端无法判断「已设置」并可能在保存时误清空。两者任一存在即掩码。
  if (defaults.clientKey || (cfg._keys && cfg._keys.__mg_client)) defaults.clientKey = '********'
  // expiresAt/note 存于 keys 库的 __mg_vm_meta_<name> 元数据；投影必须回显，否则 UI
  // 一次「读→改→保存」会把它们当作已删除而清空（与虚拟模型 Key 的孤儿风险同类）。
  const virtualModels = (cfg.virtualModels || []).map((v) => {
    const meta = (cfg._keys && cfg._keys['__mg_vm_meta_' + v.name]) || {}
    // T-KEY-02：expiresAt 原值 + 后端判定的状态；前端只展示，不自行比较时间。
    return { name: v.name, directory: v.directory, quota: v.quota, dailyQuota: v.dailyQuota, maxContext: v.maxContext, maxConcurrent: v.maxConcurrent, qps: v.qps, ...virtualExpiryProjection(meta.expiresAt), note: meta.note || '' }
  })
  return { configVersion: cfg.configVersion || 0, providers, models, defaults, virtualModels }
}

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
// —— P0-2：Codex 管理面入口（M4-1b）——
// 与旧 /api/* 的管理语义分开：/api/codex/* 一律要求“显式管理员”（正确管理令牌），
// 未设置令牌时不再有任何 loopback 放行；且必须在读请求体之前完成判定。
const CODEX_MANAGED_ROOT_ENV = 'MG_CODEX_MANAGED_ROOT'
const CODEX_MANAGED_ROOT_ID = 'managed-root'

function managementTokenOf(req) {
  const ah = req.headers['authorization'] || ''
  if (String(ah).slice(0, 7).toLowerCase() === 'bearer ') return String(ah).slice(7).trim()
  const x = req.headers['x-mg-admin']
  return x == null ? '' : String(x).trim()
}

// 返回 { explicitAdmin:true, adminSubject } 或 null。adminSubject 是令牌的不可逆短哈希
// （稳定、便于审计关联；日志/响应永不含令牌本体）。
function explicitAdminOf(req, state) {
  if (!state.adminToken) return null
  const supplied = managementTokenOf(req)
  if (!supplied || !safeTokenCmp(supplied, state.adminToken)) return null
  return { explicitAdmin: true, adminSubject: 'admin-' + sha256Hex(String(state.adminToken)).slice(0, 16) }
}

// 远程管理显式开关：仅 server.allowRemote=true 或 MG_ADMIN_ALLOW_REMOTE=1 时放行非回环 peer。
function remoteManagementAllowed(state) {
  const s = (state.cfg && state.cfg.server) || {}
  if (s.allowRemote === true) return true
  return /^(1|true|on)$/i.test(String(process.env.MG_ADMIN_ALLOW_REMOTE || '').trim())
}

function sendCodexDenied(res, status, code, message) {
  sendJson(res, status, { ok: false, error: message, code })
}

// 启动期登记受控自管根（默认关闭）。登记失败只警告并保持关闭（fail closed），不回显路径细节。
function setupCodexManagedRoot(state) {
  state.managedRoot = false
  const raw = String(process.env[CODEX_MANAGED_ROOT_ENV] || '').trim()
  if (!raw) return
  try {
    registerConfigRoot({ id: CODEX_MANAGED_ROOT_ID, path: raw, mode: 'managed' })
    state.managedRoot = true
    state.log && state.log.info('Codex 受控写入已启用（managed root 已登记，id=' + CODEX_MANAGED_ROOT_ID + '）')
  } catch (e) {
    state.log && state.log.warn('MG_CODEX_MANAGED_ROOT 无法登记，Codex 受控写入保持关闭', (e && e.code) ? e.code : 'invalid_managed_root')
  }
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
      // G1：订阅代理能力已不存在，gatewaySubscription 恒 false；残留旧配置另以
      // gatewaySubscriptionRetired 暴露给诊断/面板提示迁移，不表示可用。
      gatewaySubscription: false,
      gatewaySubscriptionRetired: !!(p.gatewaySubscription && p.gatewaySubscription.enabled === true),
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
    const _provApi = ((state.cfg.providers || {})[d.provider] || {}).api || 'openai'
    const _effectiveApi = d.api || _provApi
    const dk = (s.daily && s.daily[name] && s.daily[name][todayKey()]) || { tokens: 0, hit: 0, miss: 0 }
    const hitRate = (dk.hit + dk.miss) > 0 ? Math.round((dk.hit / (dk.hit + dk.miss)) * 1000) / 10 : null
    return { name, provider: d.provider, alias: d.alias || [], fallbacks: d.fallbacks || [], capability: d.capability || 'chat', maxConcurrent: d.maxConcurrent || 0, qps: d.qps || 0, reasoning: d.reasoning || '', effortOptions: d.effortOptions || [], effortFormat: d.effortFormat || '', dailyQuota: d.dailyQuota || 0, quota: d.quota || 0, maxContext: d.maxContext || 0, maxTokensMax: d.maxTokensMax || 0, api: d.api || '', effectiveApi: _effectiveApi, hostedTools: _effectiveApi === 'responses' ? 'native' : 'chat-bridge-lossy', providerModels: d.providerModels || {}, forceNoStream: !!d.forceNoStream, probe: m.probe || null, requests: m.requests, errors: m.errors, tokens: m.tokens || 0, today: dk.tokens || 0, hitRate, affinity: state.affinity[name] || null, avgMs: m.latencyCount ? Math.round(m.latencySum / m.latencyCount) : null }
  })
  const defaults = state.cfg.defaults || {}
  const todayTotal = models.reduce((a, m) => a + (m.today || 0), 0)
  const virtualModels = (state.cfg.virtualModels || []).map(v => {
    const m = (s.byModel && s.byModel[v.name]) || { requests: 0, errors: 0 }
    const dk = (s.daily && s.daily[v.name] && s.daily[v.name][todayKey()]) || { tokens: 0, hit: 0, miss: 0 }
    const keyId = '__mg_vm_' + v.name
    const meta = (state.cfg._keys && state.cfg._keys['__mg_vm_meta_' + v.name]) || {}
    return { name: v.name, directory: v.directory, quota: v.quota, dailyQuota: v.dailyQuota, maxContext: v.maxContext, maxConcurrent: v.maxConcurrent, qps: v.qps, keySet: !!(state.cfg._keys && state.cfg._keys[keyId]), ...virtualExpiryProjection(meta.expiresAt), note: meta.note || '', requests: m.requests, errors: m.errors, tokens: m.tokens || 0, today: dk.tokens || 0, hitRate: (dk.hit + dk.miss) > 0 ? Math.round(dk.hit / (dk.hit + dk.miss) * 1000) / 10 : null }
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
    nativeUsage: (() => { const n = nativeUsageConfig(state.cfg); return { enabled: n.enabled, dirLabel: n.label } })(),
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
  // D2：把 Codex 目录视图挂到配置上（只读派生，不进配置文件）。目录不可用时为 null，
  // 聚合/官方 slug 将解析为 unknown（fail-closed），普通第三方路由不受影响。
  state.cfg._codexCatalog = codexCatalogView(state.cfg)
  if (!state.cfg._codexCatalog && state.cfg.defaults && state.cfg.defaults.codexCatalogBasePath && state.log) {
    state.log.warn('Codex 目录不可用，官方/聚合模型将按未知模型处理', _codexCatalogError || '')
  }
  state.router = createRouter(state.cfg)
  // M1-3b：热重载同步账本配置（dir/caps 变化时 forward.js 缓存按 spec 区分）。
  state.ledgerOptions = ledgerOptionsOf(state.cfg)
  initForwardLedger(state.cfg, { ledgerOptions: state.ledgerOptions }, state.log)
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
// M0-2b：虚拟模型元数据三态。整个 virtualModels 省略、或数组里的 vm 对象省略 expiresAt/note，都必须 KEEP；
// 只有字段显式出现在补丁里且值为空才是 EXPLICIT_CLEAR。删除虚拟模型（不在数组里）仍由调用方清理 key+meta。
export function planVirtualMetaUpdate(rawVm, presence, currentMeta) {
  const current = currentMeta && typeof currentMeta === 'object' ? currentMeta : null
  if (presence === 'omitted') return { action: 'KEEP_CURRENT_META', meta: current }
  const vm = rawVm && typeof rawVm === 'object' ? rawVm : {}
  const hasExpires = Object.prototype.hasOwnProperty.call(vm, 'expiresAt')
  const hasNote = Object.prototype.hasOwnProperty.call(vm, 'note')
  if (!hasExpires && !hasNote) return { action: 'KEEP_CURRENT_META', meta: current }
  let expiresAt = current && typeof current.expiresAt === 'string' ? current.expiresAt : ''
  let note = current && typeof current.note === 'string' ? current.note : ''
  if (hasExpires) {
    const parsed = parseVirtualExpiry(vm.expiresAt)
    if (parsed.kind === 'invalid') return { action: 'INVALID_400', code: parsed.code }
    expiresAt = parsed.kind === 'valid'
      ? (parsed.source === 'legacy_local_date' ? String(vm.expiresAt).trim() : parsed.normalized)
      : ''
  }
  if (hasNote) note = typeof vm.note === 'string' ? vm.note.trim() : ''
  const meta = (expiresAt || note) ? { expiresAt, note } : null
  return { action: meta ? 'UPDATE' : 'EXPLICIT_CLEAR', meta }
}

// M0-3：把事务错误映射为管理 API 的结构化错误（不含 Key/配置正文）。
function transactionFailure(error) {
  const code = (error && error.code) || 'transaction_failed'
  if (code === 'store_locked') return { error: '配置写入被拒绝：另一个写者持有配置锁（不排队）', status: 409, code }
  if (code === 'store_conflict') return { error: '配置已被外部修改（磁盘指纹不一致）：已停止写入并保留现场；请人工核对或先 /api/config/reload', status: 409, code }
  if (code === 'injected_fault') return { error: '配置事务被中断（故障注入）', status: 500, code }
  // F02：坏状态一律 fail-closed，且返回稳定 code 供运维定位；消息不含任何 Key/配置正文。
  if (code === 'lock_unreadable') return { error: '配置写锁文件损坏（不可解析）：已停止写入以免并发覆盖；请人工检查并删除配置目录下的 ' + 'config-txn.lock 后重试', status: 409, code }
  if (code === 'keys_unreadable') return { error: 'keys.local.json 损坏或无法解密：已拒绝读写以免清空现有 Key；请恢复主密钥或从备份恢复后重试', status: 409, code }
  if (code === 'key_encryption_unavailable') return { error: '主密钥不可用，无法加密写入 keys.local.json：已拒绝保存（不会退回明文）', status: 500, code }
  if (code === 'local_config_unreadable') return { error: 'gateway.local.json 损坏：已拒绝读写以免清空现有配置；请人工修复或从备份恢复后重试', status: 409, code }
  return { error: '配置事务失败：' + ((error && error.message) || 'unknown'), status: 500, code }
}

function beginStoreWrite(state) {
  return beginWrite(state.paths, { expected: state.cfg && state.cfg._disk, log: state.log })
}

async function doSaveConfig(state, body) {
  const cur = state.cfg
  const _shape = validateConfigShape(body); if (_shape) return _shape
  const _c = versionConflict(state, body); if (_c) return _c
  // M0-3：目录级单写者锁 + 中断恢复 + 磁盘指纹校验。拿不到锁或磁盘被外部修改都立即拒绝（不排队）。
  let tx
  try { tx = beginStoreWrite(state) } catch (error) { return transactionFailure(error) }
  try {
  const providers = body.providers !== undefined ? body.providers : (cur.providers || {})
  const models = body.models !== undefined ? body.models : (cur.models || {})
  // defaults 合并而非整体替换：面板等客户端只回传它认识的白名单字段，
  // 未回传字段（affinityTtlMs / failbackProbe / preheat 等自定义或扩展项）保留现有值——任何保存都不再冲掉自定义配置。
  // 代价：字段无法经保存接口删除（需要时直接编辑 gateway.local.json 或 /api/config/reload 后手改）。
  const defaults = Object.assign({}, cur.defaults || {}, body.defaults || {})
  // 客户端 Key 三态（P0-1）：先看**原始补丁**是否自有该字段（早于 defaults 合并），再决定保留/迁移/清空/替换/拒绝。
  // 任何情况下都不把明文写进 local：落盘的 defaults.clientKey 恒为 ''，真值只进加密 keys 库。
  const clientKeyPlan = planClientKeyUpdate(body, cur)
  if (clientKeyPlan.action === 'INVALID_400') {
    return { error: 'defaults.clientKey 必须为非空字符串（省略该字段或回传掩码 ' + CLIENT_KEY_MASK + ' 表示保持现有 Key；显式清空请发送空字符串）' }
  }
  let newClientKey = null
  if (clientKeyPlan.action === 'EXPLICIT_CLEAR') newClientKey = ''
  else if (clientKeyPlan.action === 'MIGRATE_EXISTING_VALUE' || clientKeyPlan.action === 'REPLACE_WITH_SEALED') newClientKey = clientKeyPlan.value
  defaults.clientKey = ''
  for (const [mn, m] of Object.entries(models)) {
    if (!providers[m.provider]) return { error: '模型「' + mn + '」引用了不存在的上游 ' + m.provider }
    for (const fb of m.fallbacks || []) if (!providers[fb]) return { error: '模型「' + mn + '」的备用上游 ' + fb + ' 不存在' }
    for (const f of ['dailyQuota','quota','maxContext']) if (m[f] != null && (!Number.isFinite(m[f]) || m[f] < 0)) return { error: '模型「' + mn + '」的 ' + f + ' 必须为非负数字（0=不限）' }
    if (m.effortFormat != null && m.effortFormat !== '' && !['reasoning_effort', 'thinking'].includes(m.effortFormat)) return { error: '模型「' + mn + '」的 effortFormat 仅支持 reasoning_effort/thinking' }
    // 协议（改革：per-model protocol）：未设置/留空 = 继承上游的 api；显式设置时须为已知协议。
    // 同一上游的不同模型可各走不同协议（如 OpenCode Zen 的 union-alpha 走 anthropic、其余走 openai）。
    if (m.api != null && m.api !== '' && !['openai', 'anthropic', 'gemini', 'cohere', 'responses'].includes(String(m.api))) return { error: '模型「' + mn + '」的 api 仅支持 openai/anthropic/gemini/cohere/responses（留空=继承上游）' }
    // per-上游模型名覆盖：{ <providerId>: <该上游侧的模型名> }
    if (m.providerModels != null && m.providerModels !== '' && (typeof m.providerModels !== 'object' || Array.isArray(m.providerModels))) return { error: '模型「' + mn + '」的 providerModels 须为 { 上游ID: 该上游模型名 } 对象' }
    for (const pOv of Object.keys(m.providerModels || {})) if (RESERVED_KEYS.has(pOv)) return { error: '模型「' + mn + '」的 providerModels 含保留键名：' + pOv }
    if (m.providerModels && typeof m.providerModels === 'object') for (const [pOv, nm] of Object.entries(m.providerModels)) { if (!providers[pOv]) return { error: '模型「' + mn + '」的 providerModels 引用了不存在的上游 ' + pOv }; if (typeof nm !== 'string' || !nm) return { error: '模型「' + mn + '」的 providerModels[' + pOv + '] 须为非空字符串' } }
    if (m.forceNoStream != null && typeof m.forceNoStream !== 'boolean') return { error: '模型「' + mn + '」的 forceNoStream 须为布尔值' }
    // 能力声明（MG-011）：chat（默认）/embedding；未知值拦截，避免拼写错误静默变成 chat
    if (m.capability != null && m.capability !== '' && !['chat', 'embedding', 'rerank', 'audio', 'image', 'video'].includes(String(m.capability))) return { error: '模型「' + mn + '」的 capability 仅支持 chat/embedding/rerank/audio/image/video' }
    if (m.codex != null) {
      if (!isPlainObject(m.codex)) return { error: '模型「' + mn + '」的 codex 必须为对象' }
      if (m.codex.multiAgentVersion != null && m.codex.multiAgentVersion !== 'v2') return { error: '模型「' + mn + '」的 codex.multiAgentVersion 仅支持 v2' }
      if (m.codex.plaintextTools != null && typeof m.codex.plaintextTools !== 'boolean') return { error: '模型「' + mn + '」的 codex.plaintextTools 必须为布尔值' }
      if (m.codex.namespace != null && m.codex.namespace !== 'collaboration') return { error: '模型「' + mn + '」的 codex.namespace 仅支持 collaboration' }
      if (m.codex.history != null) {
        if (!isPlainObject(m.codex.history)) return { error: '模型「' + mn + '」的 codex.history 必须为对象' }
        const h = m.codex.history
        if (h.agentMessage != null && !['preserve', 'project', 'reject'].includes(h.agentMessage)) return { error: '模型「' + mn + '」的 codex.history.agentMessage 仅支持 preserve/project/reject' }
        if (h.reasoning != null && !['preserve', 'drop', 'reject'].includes(h.reasoning)) return { error: '模型「' + mn + '」的 codex.history.reasoning 仅支持 preserve/drop/reject' }
        if (h.compaction != null && !['reject', 'drop'].includes(h.compaction)) return { error: '模型「' + mn + '」的 codex.history.compaction 仅支持 reject/drop' }
        if (h.controls != null && !['drop', 'preserve', 'reject'].includes(h.controls)) return { error: '模型「' + mn + '」的 codex.history.controls 仅支持 drop/preserve/reject' }
      }
    }
    // video 异步任务路径（可选）：必须以 / 开头，避免把绝对 URL 注入到转发层
    for (const k of ['videoCreatePath', 'videoStatusPath', 'videoCancelPath']) {
      if (m[k] != null && m[k] !== '' && (typeof m[k] !== 'string' || !m[k].startsWith('/'))) return { error: '模型「' + mn + '」的 ' + k + ' 必须是以 / 开头的路径' }
    }
  }
  // 单上游代理（名单）：留空/undefined=继承全局；direct/false=强制直连；否则须为合法 http(s):// 地址
  for (const [pid, p] of Object.entries(providers || {})) {
    if (p && p.gatewaySubscription != null) {
      if (!isPlainObject(p.gatewaySubscription)) return { error: '上游「' + pid + '」的 gatewaySubscription 必须为对象' }
      if (p.gatewaySubscription.enabled != null && typeof p.gatewaySubscription.enabled !== 'boolean') return { error: '上游「' + pid + '」的 gatewaySubscription.enabled 必须为布尔值' }
    }
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
  // F04：可选端点能力开关。只允许「已证实」的 5 类能力；未知能力名一律 400
  // （防止用户以为配了新能力就生效，也防止把拼写错误当开关）。
  if (defaults.optionalEndpoints !== undefined) {
    const oe = defaults.optionalEndpoints
    if (!oe || typeof oe !== 'object' || Array.isArray(oe)) {
      return { error: 'defaults.optionalEndpoints 必须是对象：{ embedding|rerank|audio|image|video: false | { enabled, reason } }' }
    }
    for (const [cap, val] of Object.entries(oe)) {
      if (!PROVEN_OPTIONAL_CAPABILITIES.includes(cap)) {
        return { error: 'defaults.optionalEndpoints 含未证实的可选能力：' + cap + '（只允许 ' + PROVEN_OPTIONAL_CAPABILITIES.join('/') + '）' }
      }
      if (val === true || val === false) continue
      if (!val || typeof val !== 'object' || Array.isArray(val)) return { error: '可选能力「' + cap + '」的开关必须是布尔或 { enabled, reason }' }
      if (val.enabled !== undefined && typeof val.enabled !== 'boolean') return { error: '可选能力「' + cap + '」的 enabled 必须是布尔' }
      if (val.reason !== undefined && typeof val.reason !== 'string') return { error: '可选能力「' + cap + '」的 reason 必须是字符串' }
    }
  }
  const clean = {}
  for (const [id, p] of Object.entries(providers || {})) clean[id] = stripRuntimeFields(p, PROVIDER_RUNTIME_FIELDS)
  // 模型：同样剥离运行时统计/探针字段后再落盘（未知扩展字段保留）
  const cleanModels = {}
  for (const [name, m] of Object.entries(models || {})) cleanModels[name] = stripRuntimeFields(m, MODEL_RUNTIME_FIELDS)
  // —— virtualModels 强校验（面板保存路径；loadConfig 另有容错规范化，手改坏配置不宕机）——
  // M0-2b：区分「整个 virtualModels 省略」与「数组内某字段省略」——前者不得触碰任何 meta。
  const vmPresence = body.virtualModels === undefined ? 'omitted' : 'present'
  const vmsIn = vmPresence === 'present' ? body.virtualModels : (cur.virtualModels || [])
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
    // T-KEY-02：只有补丁显式自带 expiresAt 时才校验；省略=保留（见下方 planVirtualMetaUpdate）。
    if (vmPresence === 'present' && Object.prototype.hasOwnProperty.call(vm, 'expiresAt')) {
      const parsedExpiry = parseVirtualExpiry(vm.expiresAt)
      if (parsedExpiry.kind === 'invalid') {
        return { error: '虚拟模型「' + name + '」的 Key 过期时间无效（code: ' + parsedExpiry.code + '；支持毫秒值、带时区 ISO8601、旧 datetime-local YYYY-MM-DDTHH:mm）' }
      }
    }
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
    const plan = planVirtualMetaUpdate(vmPresence === 'present' ? vmRaw : null, vmPresence, keys[mid])
    if (plan.action === 'INVALID_400') {
      return { error: '虚拟模型「' + vmName + '」的 Key 过期时间无效（code: ' + plan.code + '）' }
    }
    if (plan.action === 'KEEP_CURRENT_META') continue
    if (plan.action === 'EXPLICIT_CLEAR') {
      if (mid in keys) { delete keys[mid]; keysChanged = true }
      continue
    }
    const curMeta = keys[mid]
    if (!curMeta || curMeta.expiresAt !== plan.meta.expiresAt || curMeta.note !== plan.meta.note) {
      keys[mid] = plan.meta
      keysChanged = true
    }
  }
  for (const v of removedVms) {
    const kid = '__mg_vm_' + v.name, mid = '__mg_vm_meta_' + v.name
    if (kid in keys) { delete keys[kid]; keysChanged = true }
    if (mid in keys) { delete keys[mid]; keysChanged = true }
  }
  let keysContent = null
  if (keysChanged) {
    keysContent = keysEncrypt(keys)
    // F02：旧明文 → 加密写失败时必须整体拒绝（不得退回明文，也不得只写一半）。
    // 这是服务端凭据材料问题，用 500 + 稳定 code，避免客户端当成参数错误反复重试。
    if (!keysContent) return { error: '无法加密 keys.local.json：主密钥不可用，已拒绝保存（不会退回明文写入）', status: 500, code: 'key_encryption_unavailable' }
  }
  const newVersion = (cur.configVersion || 0) + 1
  // 删除墓碑（MG-003）：local 是"合并补丁"，缺键无法表达删除；累计记录被删的上游/模型名，
  // 重新加回来时撤销墓碑。虚拟模型整体替换，不需要墓碑。
  // F02：读盘合并必须用严格读取——损坏的 local 绝不能被当成 {} 再写回（会清空用户配置）。
  const prevLocal = readLocalConfigStrict(state.paths.local, {}) || {}
  const prevTomb = (prevLocal._removed && typeof prevLocal._removed === 'object') ? prevLocal._removed : {}
  const removedProviders = new Set(Array.isArray(prevTomb.providers) ? prevTomb.providers : [])
  const removedModels = new Set(Array.isArray(prevTomb.models) ? prevTomb.models : [])
  for (const id of Object.keys(cur.providers || {})) if (!Object.prototype.hasOwnProperty.call(providers || {}, id)) removedProviders.add(id)
  for (const n of Object.keys(cur.models || {})) if (!Object.prototype.hasOwnProperty.call(models || {}, n)) removedModels.add(n)
  for (const id of Object.keys(providers || {})) removedProviders.delete(id)
  for (const n of Object.keys(models || {})) removedModels.delete(n)
  const localOut = { configVersion: newVersion, providers: clean, models: cleanModels, defaults, virtualModels: cleanVms }
  if (removedProviders.size || removedModels.size) localOut._removed = { providers: [...removedProviders], models: [...removedModels] }
  // M0-3：两个目标作为同一代际提交（每个目标都 rename + fsync 目录；journal/commit marker 保证中断后可恢复）。
  const files = { [TARGET_CONFIG]: JSON.stringify(localOut, null, 2) }
  if (keysContent != null) files[TARGET_KEYS] = keysContent
  tx.commit({ files, operation: 'config.save', publish: () => reloadConfig(state) })
  if (keysContent != null) hardenKeyFile(state.paths.keys)
  // 管理员审计：只记录动作 + 配置代际，绝不记录 Key 值。
  if (state.log) state.log.info('审计：配置保存', 'version=' + newVersion, 'clientKeyAction=' + clientKeyPlan.action)
  return { version: newVersion }
  } catch (error) {
    return transactionFailure(error)
  } finally {
    tx.release()
  }
}
function saveKeys(state, body) { return withConfigWriteLock(() => doSaveKeys(state, body)) }
async function doSaveKeys(state, body) {
  const _c = versionConflict(state, body); if (_c) return _c
  // M0-3：keys 与 configVersion 属于同一代际，必须一起提交或一起回滚。
  let tx
  try { tx = beginStoreWrite(state) } catch (error) { return transactionFailure(error) }
  try {
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
  if (!enc) return { error: '无法加密 keys.local.json：主密钥不可用（MG_KEYS_MASTER 未设置且自动主密钥不可用），已拒绝明文写入', status: 500, code: 'key_encryption_unavailable' }
  // key 变更同样推进 configVersion（读盘合并 local 顶层，避免覆盖其他字段）
  const newVersion = (state.cfg.configVersion || 0) + 1
  const localOut = Object.assign({}, readLocalConfigStrict(state.paths.local, {}), { configVersion: newVersion })
  tx.commit({ files: { [TARGET_KEYS]: enc, [TARGET_CONFIG]: JSON.stringify(localOut, null, 2) }, operation: 'keys.save', publish: () => reloadConfig(state) })
  hardenKeyFile(state.paths.keys)
  return { version: newVersion }
  } catch (error) {
    return transactionFailure(error)
  } finally {
    tx.release()
  }
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

// —— M0-2 / T-KEY-01：客户端 Key 三态（省略或掩码=保留；''=显式清空；非空值=替换）——
// P0-1 根因：先合并 defaults 再判空，会让"省略该字段的补丁"继承历史空串并被误判为显式清空。
// 因此判定必须基于**原始补丁**的 hasOwnProperty（早于任何 defaults 合并），并由调用方按 action 执行写盘。
export const CLIENT_KEY_MASK = '********'
export const CLIENT_KEY_ACTIONS = Object.freeze(['KEEP', 'MIGRATE_EXISTING_VALUE', 'EXPLICIT_CLEAR', 'INVALID_400', 'REPLACE_WITH_SEALED'])
// 掩码识别必须先 trim：API 直连可能发 '********  '，不能把它当真实 Key 写入（否则数据面被锁死）。
export function isClientKeyMaskValue(value) {
  return typeof value === 'string' && /^\s*\*{8}\s*$/.test(value)
}
export function isValidClientKeyValue(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8192) return false
  if (value.trim().length === 0) return false
  return !/[\u0000-\u001f\u007f]/.test(value)
}
export function planClientKeyUpdate(patch, current) {
  const cfg = current || {}
  const sealed = cfg._keys && cfg._keys.__mg_client
  const legacy = cfg.defaults && cfg.defaults.clientKey
  const hasSealed = typeof sealed === 'string' && sealed.length > 0
  const hasLegacy = typeof legacy === 'string' && legacy.length > 0 && !isClientKeyMaskValue(legacy)
  const patchDefaults = patch && isPlainObject(patch.defaults) ? patch.defaults : null
  const present = !!patchDefaults && Object.prototype.hasOwnProperty.call(patchDefaults, 'clientKey')
  const value = present ? patchDefaults.clientKey : undefined
  if (!present || isClientKeyMaskValue(value)) {
    if (hasSealed) return { action: 'KEEP' }
    if (hasLegacy) return { action: 'MIGRATE_EXISTING_VALUE', value: legacy }
    return { action: 'KEEP' }
  }
  if (value === '') return { action: 'EXPLICIT_CLEAR' }
  if (!isValidClientKeyValue(value)) return { action: 'INVALID_400', code: 'invalid_client_key' }
  return { action: 'REPLACE_WITH_SEALED', value }
}

// —— M0-2 / T-KEY-02：虚拟 Key 过期时间单一真源 ——
// 支持：毫秒值（number 或 10~16 位数字串）、带时区 ISO8601、旧 datetime-local（YYYY-MM-DDTHH:mm，按本机时区解释）、
// 旧日期 YYYY-MM-DD（本机零点，兼容历史配置）。无时区的秒级 ISO 无法确定时区 → 判歧义拒绝。
// 非法/歧义：保存返回 400 且不落盘；鉴权一律 deny 并在日志给出 diagnostic code。
export const EXPIRY_FORMATS = Object.freeze(['epoch_ms', 'iso_zoned', 'legacy_local_datetime', 'legacy_local_date'])
function expiryInvalid(code) { return { kind: 'invalid', code } }
function makeExpiry(epochMs, source) {
  if (!Number.isFinite(epochMs) || Math.abs(epochMs) > 8.64e15) return expiryInvalid('expiry_out_of_range')
  return { kind: 'valid', epochMs, normalized: new Date(epochMs).toISOString(), source }
}
function daysInMonth(year, month) { return new Date(Date.UTC(year, month, 0)).getUTCDate() }
function validYmd(year, month, day) {
  return Number.isInteger(year) && Number.isInteger(month) && Number.isInteger(day) &&
    month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month) && year >= 1970 && year <= 9999
}
export function parseVirtualExpiry(persisted) {
  if (persisted === undefined || persisted === null) return { kind: 'none' }
  if (typeof persisted === 'number') {
    if (!Number.isFinite(persisted)) return expiryInvalid('expiry_not_finite')
    return makeExpiry(persisted, 'epoch_ms')
  }
  if (typeof persisted !== 'string') return expiryInvalid('expiry_unsupported_type')
  const raw = persisted.trim()
  if (raw === '') return { kind: 'none' }
  if (/^\d{10,16}$/.test(raw)) return makeExpiry(Number(raw), 'epoch_ms')
  const zoned = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(raw)
  if (zoned) {
    const year = +zoned[1]; const month = +zoned[2]; const day = +zoned[3]
    const hour = +zoned[4]; const minute = +zoned[5]
    const second = zoned[6] === undefined ? 0 : +zoned[6]
    const milli = zoned[7] === undefined ? 0 : Number((zoned[7] + '00').slice(0, 3))
    if (!validYmd(year, month, day) || hour > 23 || minute > 59 || second > 59) return expiryInvalid('expiry_invalid_calendar')
    const offsetMin = zoned[8] === 'Z' ? 0 : (zoned[8][0] === '-' ? -1 : 1) * (Number(zoned[8].slice(1, 3)) * 60 + Number(zoned[8].slice(4, 6)))
    if (Math.abs(offsetMin) > 14 * 60) return expiryInvalid('expiry_invalid_offset')
    const epochMs = Date.UTC(year, month - 1, day, hour, minute, second, milli) - offsetMin * 60000
    const back = new Date(epochMs + offsetMin * 60000)
    if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day ||
        back.getUTCHours() !== hour || back.getUTCMinutes() !== minute || back.getUTCSeconds() !== second) {
      return expiryInvalid('expiry_invalid_calendar')
    }
    return makeExpiry(epochMs, 'iso_zoned')
  }
  const local = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(raw)
  if (local) {
    const year = +local[1]; const month = +local[2]; const day = +local[3]; const hour = +local[4]; const minute = +local[5]
    if (!validYmd(year, month, day) || hour > 23 || minute > 59) return expiryInvalid('expiry_invalid_calendar')
    const dt = new Date(year, month - 1, day, hour, minute, 0, 0)
    if (dt.getFullYear() !== year || dt.getMonth() !== month - 1 || dt.getDate() !== day || dt.getHours() !== hour || dt.getMinutes() !== minute) {
      return expiryInvalid('expiry_invalid_calendar')
    }
    return makeExpiry(dt.getTime(), 'legacy_local_datetime')
  }
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
  if (dateOnly) {
    const year = +dateOnly[1]; const month = +dateOnly[2]; const day = +dateOnly[3]
    if (!validYmd(year, month, day)) return expiryInvalid('expiry_invalid_calendar')
    const dt = new Date(year, month - 1, day, 0, 0, 0, 0)
    if (dt.getFullYear() !== year || dt.getMonth() !== month - 1 || dt.getDate() !== day) return expiryInvalid('expiry_invalid_calendar')
    return makeExpiry(dt.getTime(), 'legacy_local_date')
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(raw)) return expiryInvalid('expiry_ambiguous_timezone')
  return expiryInvalid('expiry_unrecognized_format')
}
// 到期判定：沿用既有 now > expiresAt 语义（到期瞬间仍视为有效）。nowMs 可注入，便于边界测试。
export function isVirtualKeyExpired(persisted, nowMs = Date.now()) {
  const parsed = parseVirtualExpiry(persisted)
  if (parsed.kind === 'none') return { expired: false, state: 'none', parsed }
  if (parsed.kind === 'invalid') return { expired: true, state: 'invalid', code: parsed.code, parsed }
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now()
  const expired = now > parsed.epochMs
  return { expired, state: expired ? 'expired' : 'valid', epochMs: parsed.epochMs, parsed }
}
// 投影：返回存储原值 + 后端判定的状态（前端只展示，不自行比较时间）。
export function virtualExpiryProjection(persisted, nowMs = Date.now()) {
  const parsed = parseVirtualExpiry(persisted)
  const state = parsed.kind === 'none' ? 'none' : parsed.kind === 'invalid' ? 'invalid' : (Number(nowMs) > parsed.epochMs ? 'expired' : 'valid')
  const out = { expiresAt: typeof persisted === 'string' ? persisted : '', expiresAtState: state, expiresAtMs: parsed.kind === 'valid' ? parsed.epochMs : null }
  if (parsed.kind === 'invalid') out.expiresAtDiagnostic = parsed.code
  return out
}

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
// —— F04：可选端点能力门 ——
// config：defaults.optionalEndpoints = { embedding|rerank|audio|image|video: false | { enabled:false, reason? } }。
// 语义：已证实的 5 类能力默认启用（既有行为）；显式关闭 → 501 optional_endpoint_disabled 且零上游请求；
// 未证实的能力名在保存时被 400 拒绝（只放行经配置的旧能力）。
function optionalRegistryOf(cfg) {
  const raw = (cfg.defaults && cfg.defaults.optionalEndpoints) || {}
  const overrides = {}
  for (const cap of PROVEN_OPTIONAL_CAPABILITIES) {
    const v = raw[cap]
    if (v === false) overrides[cap] = { enabled: false, reason: 'disabled_by_config' }
    else if (v && typeof v === 'object' && v.enabled === false) overrides[cap] = { enabled: false, reason: (typeof v.reason === 'string' && v.reason.trim()) ? v.reason.trim() : 'disabled_by_config' }
  }
  return createCapabilityRegistry(overrides)
}
function optionalGate(state, res, capability) {
  const st = optionalRegistryOf(state.cfg).stateOf(capability)
  if (st.enabled) return false
  sendJson(res, 501, {
    error: {
      message: '可选端点「' + capability + '」未启用（可用 defaults.optionalEndpoints 显式开启；未证实的可选能力默认关闭）',
      type: 'capability_disabled',
      code: 'optional_endpoint_disabled',
      capability,
      reason: st.reason,
    },
  })
  return true
}

// F04：可选端点的调用主体（不落 Key 原文）。数据面鉴权只有一把全局 client Key 或无鉴权匿名；
// 主体取「鉴权来源 + Key 的 sha256 前缀」：同 Key 稳定、不可逆、跨主体不可关联。
function optionalSubjectOf(state, req) {
  const key = currentClientKey(state)
  if (!key) return 'anonymous'
  const auth = String((req && req.headers && req.headers.authorization) || '').replace(/^Bearer\s+/i, '').trim()
  if (!auth || auth !== key) return 'anonymous'
  try { return 'client:' + sha256Hex(auth).slice(0, 16) } catch { return 'client:hashed' }
}

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
  const { modelName, def, body, idem, subject, inputHash } = opts
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
        // F04：任务记录主体与输入指纹；日志只记模型/主体前缀，绝不记 prompt 正文。
        const task = newVideoTask({ model: modelName, provider: pid, idem, subject, inputHash, prompt: body.prompt })
        log && log.info('video create ok', 'model=' + modelName, 'provider=' + pid, 'subject=' + (subject || '-'), 'promptLen=' + (typeof body.prompt === 'string' ? body.prompt.length : 0))
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

// —— F03：下游响应头白名单（R1 2c4f2a9 的移植） ——
// 「上游能影响哪些客户端响应头」必须由网关决定，不能把上游头集合直接并进 writeHead。
// 当前只放行 retry-after（429 治理需要）；其余（set-cookie / location / transfer-encoding /
// content-length / x-* / 安全策略头）一律丢弃，且拒绝含控制字符的值。
const DOWNSTREAM_HEADER_ALLOWLIST = Object.freeze(['retry-after'])
export function sanitizeDownstreamHeaders (headers) {
  const out = {}
  for (const [k, v] of Object.entries(headers || {})) {
    const name = String(k || '').trim().toLowerCase()
    if (!DOWNSTREAM_HEADER_ALLOWLIST.includes(name)) continue
    if (v === undefined || v === null || (typeof v !== 'string' && typeof v !== 'number')) continue
    const value = String(v)
    if (!value || /[\r\n\0]/.test(value)) continue
    out[name] = value
  }
  return out
}

// —— F03：核心发送的「冻结目标」授权（Responses 旁路封口） ——
// proxyOfficialResponses / proxyNativeResponses 曾直接 request.forward()，绕过 target-authz：
// 无冻结目标、无二次 assert、无 catalog 绑定。现在两处都在发送前走同一入口：
//   authorizeSendTarget(...) → 冻结目标（含 codified deny）
//   assertSendTarget(authz, upstreamUrl(provider, path)) → 授权对象 == 实际发送对象
// 授权失败零发送，返回统一错误信封（不含头值/Key）。
function authorizeProxySend (state, prov, pid, path, req, log, opts) {
  try {
    const authz = authorizeSendTarget({ cfg: state.cfg, provider: prov, pid, path, req, log, catalogScoped: false, opts: Object.assign({}, opts || {}) })
    assertProxySendTarget(authz, prov, path)
    return { authz }
  } catch (error) {
    const typed = isTargetAuthzError(error)
    return {
      denied: {
        status: (error && error.status) || 403,
        code: (error && error.code) || 'target_denied',
        message: '上游目标未通过发送授权：' + String((error && error.message) || error).slice(0, 300),
        typed,
      },
    }
  }
}
function assertProxySendTarget (authz, prov, path) {
  // authorizeSendTarget 内部已 assert 一次；这里再按「本次实际拼装的 URL」复核，
  // 防止未来有人在两者之间改写 provider/path。
  const actual = upstreamUrl(prov, path).href
  const expected = authz && authz.target ? authz.target.key : null
  const parsed = new URL(actual)
  const key = parsed.origin + parsed.pathname + parsed.search
  if (!expected || key !== expected) {
    const error = new Error('实际发送目标与授权目标不一致（' + (expected || 'missing') + ' != ' + key + '）')
    error.code = 'send_target_drift'
    error.status = 403
    error.deny = true
    throw error
  }
  return authz
}
function proxyDeniedResult (denied) {
  return {
    status: denied.status,
    contentType: 'application/json; charset=utf-8',
    buf: Buffer.from(JSON.stringify({ error: { message: denied.message, code: denied.code, type: 'target_denied' } })),
  }
}

// —— E3 / D1-A：官方身份直连代理（F01 后只剩「网关自有 key」一条路；G1 移除订阅代理） ——
// 只在 classifyTarget()==='official' 时使用。客户端官方凭据（OAuth / chatgpt-account-id）不再透传，
// 订阅后端入口也不再是允许路径：无网关自有 key 时 targetDeny 直接 fail-closed。
// 稳定错误码/迁移提示由 target-authz 单一导出（GATEWAY_SUBSCRIPTION_RETIRED_CODE/MESSAGE）。
// 官方请求不重试（可能有工具/托管副作用），3xx 一律拒绝（不跟随重定向、不把凭据带到 Location）。
// —— P09：Codex 原生 V2 能力与响应投影 ——
function defaultCodexCaps(official) {
  return official
    ? { multiAgentVersion: 'v2', plaintextTools: false, history: { agentMessage: 'preserve', reasoning: 'preserve', compaction: 'reject' }, namespace: 'collaboration' }
    : { multiAgentVersion: 'v2', plaintextTools: false, history: { agentMessage: 'project', reasoning: 'drop', compaction: 'reject' }, namespace: 'collaboration' }
}
function needsCodexProjection(body, def) {
  return !!(def && def.codex && typeof def.codex === 'object')
}
function buildCodexRoute(state, hit, def, prov) {
  const target = modelTarget(state.cfg, hit.canonicalName, def.provider)
  const official = !!prov && classifyTarget(prov, state.cfg).kind === 'official'
  const declared = def && def.codex && typeof def.codex === 'object' ? def.codex : null
  const base = defaultCodexCaps(official)
  const codex = Object.assign({}, base, declared || {})
  codex.history = Object.assign({}, base.history, (declared && declared.history) || {})
  codex.official = official
  if (!codex.namespace) codex.namespace = 'collaboration'
  return { alias: hit.canonicalName, provider: def.provider, upstreamModel: target.servingName, api: 'responses', codex }
}
function tallyResponsesUsage(state, modelName, pid, sg, usage) {
  const u = usage || {}
  const input = Number(u.input_tokens) > 0 ? Number(u.input_tokens) : 0
  const output = Number(u.output_tokens) > 0 ? Number(u.output_tokens) : 0
  const total = Number(u.total_tokens) > 0 ? Number(u.total_tokens) : input + output
  if (total > 0) {
    sg.tokens = (sg.tokens || 0) + total
    sg.inTokens = (sg.inTokens || 0) + input
    sg.outTokens = (sg.outTokens || 0) + output
    agg(state, pid, 'tokens', total)
    tallyDaily(state, modelName, total, 0, 0, input, output)
  }
  return total
}
function restoreCodexJsonBuffer(buf, route, plan) {
  if (!route || !plan) return { ok: true, json: null }
  const j = tryParse(buf)
  if (!j || typeof j !== 'object') return { ok: true, json: null }
  const restored = restoreResponseJson(j, route, plan)
  if (restored.rejected) return { ok: false, rejected: restored.rejected }
  return { ok: true, json: restored.json, lossy: restored.lossy || [] }
}
async function streamCodexResponse(state, budget, log, opts) {
  const { up, res, route, plan, model, modelName, pid, sg, prov } = opts
  const adapter = createCodexStreamAdapter(res, {
    plan, route, model, log,
    softRestore: !(route && route.codex && route.codex.official === true),
    onUsage: (usage) => tallyResponsesUsage(state, modelName, pid, sg, usage),
  })
  const destroyUp = () => { try { up.stream.destroy() } catch { /* ignore */ } }
  const onAbort = () => destroyUp()
  if (budget.signal.aborted) onAbort()
  else budget.signal.addEventListener('abort', onAbort, { once: true })
  res.once('close', onAbort)
  // The caller owns the request budget and provider permit until the relay settles.
  try {
    for await (const chunk of up.stream) {
      await adapter.push(chunk)
      if (adapter.terminal) break
    }
    await adapter.end()
  } catch {
    destroyUp()
    if (!budget.cancelled()) {
      const timedOut = budget.timedOut()
      if (timedOut && !res.headersSent) throw abortedError('request_timeout')
      await adapter.fail(timedOut ? 'request exceeded overall timeout' : 'upstream stream interrupted', { timeout: timedOut })
    }
  } finally {
    budget.signal.removeEventListener('abort', onAbort)
    res.removeListener('close', onAbort)
  }
  if (!budget.expired()) {
    if (adapter.terminal === 'response.failed') {
      agg(state, pid, 'errors', 1); state.st.counters.errors += 1
      if (prov) markFail(state, pid, prov.circuit)
    } else { markOk(state, pid); noteAffinity(state, modelName, pid) }
  }
  return { streamed: true }
}
function opaqueRejectionCode(opaque) {
  const signals = opaque && Array.isArray(opaque.signals) ? opaque.signals : []
  if (signals.some((s) => s && s.kind === 'agent_message')) return 'opaque_agent_message'
  return 'v2_encrypted_task_unsupported'
}
function checkThirdPartyOpaque(state, nProv, nDef, body) {
  if (!nProv || classifyTarget(nProv, state.cfg).kind === 'official') return null
  const opaque = detectOpaqueV2Task(body)
  const plaintext = !!(nDef && nDef.codex && nDef.codex.plaintextTools === true)
  const projectPlaintext = !!(nDef && nDef.codex && nDef.codex.history && nDef.codex.history.agentMessage === 'project')
  // Explicit plaintextTools + agentMessage=project is the supported projection mode:
  // encrypted agent_message history is opaque, so its readable text parts are kept and
  // the encrypted parts are dropped before the request reaches Go. This is not decryption.
  if (opaque.opaque && !(plaintext && projectPlaintext)) {
    return { status: 400, code: opaqueRejectionCode(opaque), message: '第三方目标收到不可读密文：网关拒绝发送（不解密/不删除/不降级）' }
  }
  if (!plaintext && detectEncryptedToolSchema(body && body.tools)) return { status: 400, code: 'encrypted_tool_schema', message: '第三方目标含 encrypted:true 工具 schema，但未声明 plaintextTools=true' }
  return null
}

async function proxyOfficialResponses(state, budget, log, opts) {
  const { req, body, modelName, def, res, codexRoute, codexPlan } = opts
  const candidates = [def.provider, ...(def.fallbacks || [])].filter(Boolean)
  const jsonError = (status, code, message, type) => ({
    status,
    contentType: 'application/json; charset=utf-8',
    buf: Buffer.from(JSON.stringify({ error: { message, code, type: type || 'official_target_rejected' } })),
  })
  const singleShot = isToolBearingBody(body)
  let lastErr = null
  for (const pid of candidates) {
    if (!state.cfg.providers[pid]) continue
    const prov = buildProvider(state.cfg, pid)
    const pdef = prov._def || {}
    const identity = classifyTarget(prov, state.cfg)
    // G1（2026-11-13）：本机 Codex 登录态订阅代理已退役。残留 enabled=true 必须 fail-closed：
    // 稳定错误码 + 零上游请求，不得回落到 gateway key、第三方候选或任何其它凭据。
    if (pdef.gatewaySubscription && pdef.gatewaySubscription.enabled === true) {
      log && log.warn('gatewaySubscription 已退役，拒绝发送', 'provider=' + pid)
      return jsonError(403, GATEWAY_SUBSCRIPTION_RETIRED_CODE, GATEWAY_SUBSCRIPTION_RETIRED_MESSAGE)
    }
    // 官方目标只允许官方候选：绝不因故障把官方请求递给第三方（身份串线）。
    if (identity.kind !== 'official') { lastErr = new Error('候选上游不是官方目标：' + pid); continue }
    const upstreamPath = (typeof def.responsesPath === 'string' && def.responsesPath) || (typeof pdef.responsesPath === 'string' && pdef.responsesPath) || '/v1/responses'
    const deny = targetDeny({ identity, provider: prov, cfg: state.cfg, path: upstreamPath, env: process.env })
    if (deny) {
      log && log.warn('官方目标被拒绝', deny.code, pid)
      return jsonError(deny.status, deny.code, deny.message)
    }
    const target = modelTarget(state.cfg, modelName, pid)
    const payload = Buffer.from(JSON.stringify(Object.assign({}, body, { model: target.servingName })))
    if (!prov.apiKey) {
      return jsonError(403, 'official_no_gateway_key', '官方目标未配置网关自有 key（客户端官方凭据透传已移除）')
    }
    const plan = planTargetHeaders({ identity, provider: prov, cfg: state.cfg, incoming: req.headers })
    const dropped = plan.dropped
    const headers = Object.assign({}, plan.headers, {
      'content-type': 'application/json',
      'content-length': payload.length,
      'accept-encoding': 'identity',
      authorization: 'Bearer ' + prov.apiKey,
    })
    if (dropped.length) log && log.info('官方目标丢弃头（仅名称）', dropped.slice(0, 20).join(','))
    const gate = authorizeProxySend(state, prov, pid, upstreamPath, req, log)
    if (gate.denied) {
      log && log.warn('官方目标发送授权被拒绝', gate.denied.code, pid)
      return proxyDeniedResult(gate.denied)
    }
    let release = null
    try {
      release = await acquireProvider(state, pid, state.cfg, budget.signal)
      const up = await forward(prov, upstreamPath, 'POST', headers, payload, state.cfg.defaults || {}, log, { budget, signal: budget.signal, noRetry: true })
      if (up.status >= 300 && up.status < 400) {
        try { await collectBody(up.stream, 1024 * 1024, { budget, signal: budget.signal, destroyOnAbort: true }) } catch {}
        agg(state, pid, 'errors', 1); state.st.counters.errors += 1
        log && log.warn('官方目标返回重定向，已拒绝跟随', 'provider=' + pid, 'status=' + up.status)
        return jsonError(502, 'upstream_redirect_rejected', '官方上游返回重定向（' + up.status + '），网关拒绝跟随', 'upstream_error')
      }
      if (up.ok) {
        state.st.counters.requests += 1
        agg(state, pid, 'requests', 1)
        const sg = state.stats.byModel[modelName] = state.stats.byModel[modelName] || { requests: 0, errors: 0 }
        sg.requests = (sg.requests || 0) + 1
        markOk(state, pid); noteAffinity(state, modelName, pid)
        const ct = (up.headers && up.headers['content-type']) || 'application/json; charset=utf-8'
        if (/text\/event-stream/i.test(ct)) {
          if (codexRoute && codexPlan) return await streamCodexResponse(state, budget, log, { up, res, route: codexRoute, plan: codexPlan, model: body.model, modelName, pid, sg, prov })
          writeUpstreamHeaders(res, up)
          await streamRawResponses(res, up.stream, budget)
          return { streamed: true }
        }
        const buf = await collectBody(up.stream, 128 * 1024 * 1024, { budget, signal: budget.signal, destroyOnAbort: true })
        const restored = restoreCodexJsonBuffer(buf, codexRoute, codexPlan)
        if (!restored.ok) return jsonError(502, restored.rejected.code || 'codex_restore_rejected', restored.rejected.message || 'Codex 原生响应恢复失败', 'codex_restore_rejected')
        if (restored.json) return { status: up.status, contentType: ct, buf: Buffer.from(JSON.stringify(restored.json)) }
        return { status: up.status, contentType: ct, buf }
      }
      const ebuf = await collectBody(up.stream, 1024 * 1024, { budget, signal: budget.signal, destroyOnAbort: true })
      agg(state, pid, 'errors', 1); state.st.counters.errors += 1
      markFail(state, pid, prov.circuit)
      return { status: up.status || 502, contentType: 'application/json; charset=utf-8', buf: scrubBody(ebuf) }
    } catch (err) {
      if (err && err.aborted) throw err
      lastErr = err
      agg(state, pid, 'errors', 1); state.st.counters.errors += 1
      markFail(state, pid, prov.circuit)
      // 工具历史/已发状态：不得跨候选重放。
      if (singleShot || (err && err.noReplay)) {
        return jsonError(502, err && err.code ? err.code : 'no_replay', '上游失败且请求含工具历史/已发状态：终止而不换候选重放')
      }
    } finally { if (release) release() }
  }
  return jsonError(502, 'all_providers_failed', '官方上游失败：' + (lastErr ? lastErr.message : 'all providers failed'), 'all_providers_failed')
}

// —— MG-015 原生 Responses 透传：模型显式 api:"responses" 时，不做 Chat 桥转换 ——
// 非流式：JSON 原样透传并把响应 model 回写客户端请求名；流式：上游 SSE 原样管道（不翻译事件、不改 model）。
// 仍复用 forward 的 retry/timeout 与请求预算；错误体原样/映射透传。
async function proxyNativeResponses(state, budget, log, opts) {
  const { req, body, modelName, def, wantStream, res, codexRoute, codexPlan } = opts
  const candidates = [def.provider, ...(def.fallbacks || [])].filter(Boolean)
  const upstreamPath = (typeof def.responsesPath === 'string' && def.responsesPath) ? def.responsesPath : '/v1/responses'
  const singleShot = isToolBearingBody(body)
  let lastErr = null
  for (const pid of candidates) {
    if (!state.cfg.providers[pid]) continue
    const prov = buildProvider(state.cfg, pid)
    if (!healthy(ensureHst(state, pid), Date.now())) { lastErr = new Error('provider ' + pid + ' 熔断中'); continue }
    if (prov._def.apiKeyEnv && !prov.keyOk) { lastErr = new Error('provider ' + pid + ' 未配置 Key'); continue }
    const target = modelTarget(state.cfg, modelName, pid)
    const payload = Buffer.from(JSON.stringify(Object.assign({}, body, { model: target.servingName })))
    // Native third-party requests still need the provider protocol headers, including
    // OpenCode Go's x-opencode-session; videoJsonHeaders only supplies media headers.
    const headers = buildHeaders(req, prov, payload, state.cfg, 'responses', body, { identity: classifyTarget(prov, state.cfg), log })
    headers['content-type'] = 'application/json'
    headers['content-length'] = payload.length
    const gate = authorizeProxySend(state, prov, pid, upstreamPath, req, log)
    if (gate.denied) {
      log && log.warn('responses 目标发送授权被拒绝', gate.denied.code, pid)
      return proxyDeniedResult(gate.denied)
    }
    let release = null
    try {
      release = await acquireProvider(state, pid, state.cfg, budget.signal)
      const up = await forward(prov, upstreamPath, 'POST', headers, payload, state.cfg.defaults || {}, log, { budget, signal: budget.signal, noRetry: true })
      if (up.status >= 300 && up.status < 400) {
        try { await collectBody(up.stream, 1024 * 1024, { budget, signal: budget.signal, destroyOnAbort: true }) } catch {}
        agg(state, pid, 'errors', 1); state.st.counters.errors += 1
        log && log.warn('responses 目标返回重定向，已拒绝跟随', 'provider=' + pid, 'status=' + up.status)
        return { status: 502, contentType: 'application/json; charset=utf-8', buf: Buffer.from(JSON.stringify({ error: { message: '上游返回重定向（' + up.status + '），网关拒绝跟随', code: 'upstream_redirect_rejected', type: 'upstream_error' } })) }
      }
      if (up.ok) {
        state.st.counters.requests += 1
        agg(state, pid, 'requests', 1)
        const sg = state.stats.byModel[modelName] = state.stats.byModel[modelName] || { requests: 0, errors: 0 }
        sg.requests = (sg.requests || 0) + 1
        markOk(state, pid); noteAffinity(state, modelName, pid)
        const ct = (up.headers && up.headers['content-type']) || 'application/json; charset=utf-8'
        if (/text\/event-stream/i.test(ct)) {
          if (codexRoute && codexPlan) return await streamCodexResponse(state, budget, log, { up, res, route: codexRoute, plan: codexPlan, model: body.model, modelName, pid, sg, prov })
          writeUpstreamHeaders(res, up)
          await streamRawResponses(res, up.stream, budget)
          return { streamed: true }
        }
        const buf = await collectBody(up.stream, ((state.cfg.server && state.cfg.server.maxBodyBytes) || 32 * 1024 * 1024) * 4, { budget, signal: budget.signal, destroyOnAbort: true })
        const restored = restoreCodexJsonBuffer(buf, codexRoute, codexPlan)
        if (!restored.ok) return { status: 502, contentType: 'application/json; charset=utf-8', buf: Buffer.from(JSON.stringify({ error: { message: restored.rejected.message || 'Codex 原生响应恢复失败', code: restored.rejected.code || 'codex_restore_rejected', type: 'codex_restore_rejected' } })) }
        const j = restored.json || tryParse(buf)
        if (j && typeof j === 'object') {
          if (typeof j.model === 'string') j.model = body.model
          tallyResponsesUsage(state, modelName, pid, sg, j.usage || {})
          return { status: up.status, contentType: ct, buf: Buffer.from(JSON.stringify(j)) }
        }
        return { status: up.status, contentType: ct, buf }
      }
      const ebuf = await collectBody(up.stream, 1024 * 1024, { budget, signal: budget.signal, destroyOnAbort: true })
      const mapped = scrubBody(mapErrorEnvelope(target.api, up.status, ebuf) || ebuf)
      if (singleShot) {
        return { status: up.status || 502, contentType: 'application/json; charset=utf-8', buf: mapped }
      }
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
      if (singleShot || (err && err.noReplay)) {
        return { status: 502, contentType: 'application/json; charset=utf-8', buf: Buffer.from(JSON.stringify({ error: { message: '上游失败且请求含工具历史/已发状态：终止而不换候选重放', code: err && err.code ? err.code : 'no_replay', type: 'no_replay' } })) }
      }
    } finally { if (release) release() }
  }
  return { status: 502, contentType: 'application/json; charset=utf-8', buf: Buffer.from(JSON.stringify({ error: { message: 'responses 上游失败：' + (lastErr ? lastErr.message : 'all providers failed'), type: 'all_providers_failed' } })) }
}

// 原生 Responses 流：逐字节管道（pipeline 负责背压），预算中止/客户端断开时销毁上游。
function streamRawResponses(res, upstreamStream, budget) {
  return new Promise((resolve) => {
    let done = false
    const finish = () => { if (!done) { done = true; cleanup(); resolve() } }
    const onAbort = () => { try { upstreamStream.destroy() } catch {} ; finish() }
    const onClose = () => { try { upstreamStream.destroy() } catch {} ; finish() }
    const cleanup = () => {
      try { res.removeListener('close', onClose) } catch {}
      if (budget && budget.signal) { try { budget.signal.removeEventListener('abort', onAbort) } catch {} }
    }
    if (budget && budget.signal) {
      if (budget.signal.aborted) { onAbort(); return }
      try { budget.signal.addEventListener('abort', onAbort, { once: true }) } catch {}
    }
    try { res.once('close', onClose) } catch {}
    pipeline(upstreamStream, res, () => finish())
  })
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
    // N06：每个数据面请求一条 request 收据（引用一律 sha256 派生；终态按 (requestId,terminal) 去重）。
    let obsRequestId = null
    let obsRecorded = false
    if (state.observability && (path.startsWith('/v1/') || path === '/v1')) {
      try { obsRequestId = hashId(req.headers['x-request-id'] || (process.pid + ':' + Date.now() + ':' + Math.random())) } catch { obsRequestId = null }
    }
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
      if ((req.method === 'GET' || req.method === 'HEAD') && (path === '/ui-next' || path.startsWith('/ui-next/'))) {
        const asset = uiNextAsset(path)
        let data = null
        if (asset) { try { data = readFileSync(new URL('./ui-next/' + asset.rel, import.meta.url)) } catch { data = null } }
        if (!data) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('not found'); return }
        res.writeHead(200, {
          'content-type': asset.type,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
          'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
        })
        if (req.method === 'HEAD') res.end()
        else res.end(data)
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
      // E6 管理面：/api/codex/*（P0-2 / M4-1b）。
      // 顺序硬约束：Host/Origin 已在上面全局校验 → 可信 peer → 显式管理员 → 才读 body → 派发。
      // 未设置 adminToken 时这里没有任何 loopback 放行：/api/codex/* 一律 403 explicit_admin_required。
      if (isCodexApiPath(path)) {
        if (!isLoopbackPeer(req) && !remoteManagementAllowed(state)) {
          log && log.warn('codex admin denied', 'remote_forbidden', path)
          sendCodexDenied(res, 403, 'remote_forbidden', '拒绝非本机来源的 Codex 管理请求：只有回环或显式 allowRemote 可用')
          return
        }
        const admin = explicitAdminOf(req, state)
        if (!admin) {
          log && log.warn('codex admin denied', 'explicit_admin_required', path)
          sendCodexDenied(res, 403, 'explicit_admin_required', 'Codex 管理接口要求显式管理员令牌（未设置/未携带/错误令牌一律拒绝）')
          return
        }
        const rawBody = (req.method === 'POST')
          ? await collectBody(req, (state.cfg.server && state.cfg.server.maxBodyBytes) || 32 * 1024 * 1024)
          : undefined
        // 入口已完成 Host/Origin/peer/显式管理员校验；isLocal=true 让模块侧不再重复用 socket 判来源
        // （allowRemote 场景下 peer 非回环，但入口已显式放行）。
        const out = await handleCodexApi({ method: req.method, url, path, cfg: state.cfg, log, req, res, rawBody, explicitAdmin: admin.explicitAdmin, adminSubject: admin.adminSubject, managedRoot: state.managedRoot === true, isLocal: true })
        if (out) sendJson(res, out.status, out.body)
        return
      }

      // 面板设置管理令牌：写入加密 keys 库并热生效。未启用鉴权时开放（本地初始化）；已启用时需携带当前令牌。
      if (path === '/api/admin-token' && req.method === 'POST') {
        if (state.adminToken && !adminOk(req, state)) { sendJson(res, 401, { error: '未授权：修改管理令牌需携带当前令牌' }); return }
        if (!state.adminToken && !isLoopbackPeer(req)) { sendJson(res, 403, { error: '拒绝远程初始化：未启用管理令牌时只允许本机设置令牌（MG_ADMIN_TOKEN）' }); return }
        const body = tryParse(await collectBody(req, (state.cfg.server && state.cfg.server.maxBodyBytes) || 32 * 1024 * 1024)) || {}
        const token = typeof body.token === 'string' ? body.token.trim() : ''
        let tx
        try { tx = beginStoreWrite(state) } catch (error) { const f = transactionFailure(error); sendJson(res, f.status, { error: f.error, code: f.code }); return }
        try {
          const keys = Object.assign({}, readKeysFresh(state.paths.keys))
          if (token) keys.__mg_admin = token
          else delete keys.__mg_admin
          const enc = keysEncrypt(keys)
          if (!enc) { sendJson(res, 400, { error: '无法加密 keys.local.json：缺少主密钥，已拒绝写入' }); return }
          tx.commit({ files: { [TARGET_KEYS]: enc }, operation: 'admin.token', publish: () => reloadConfig(state) })
          hardenKeyFile(state.paths.keys)
          sendJson(res, 200, { ok: true, needAuth: !!state.adminToken })
        } catch (error) {
          const f = transactionFailure(error)
          sendJson(res, f.status, { error: f.error, code: f.code })
        } finally {
          tx.release()
        }
        return
      }

      if (path === '/api/status' && req.method === 'GET') { if (!await requireAdmin(req, res)) return; sendJson(res, 200, buildStatus(state)); return }
      if (path === '/api/native-usage' && req.method === 'GET') {
        if (!await requireAdmin(req, res)) return
        const days = Math.min(90, Math.max(1, parseInt(new URL(url, 'http://x').searchParams.get('days') || '7', 10) || 7))
        sendJson(res, 200, await readNativeUsage(state.cfg, days))
        return
      }
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
      if (path === '/api/observability/events' && req.method === 'GET') {
        if (!await requireAdmin(req, res)) return
        const q = new URL(url, 'http://x').searchParams
        try {
          sendJson(res, 200, state.observability.page({ cursor: q.get('cursor'), limit: q.get('limit') }))
        } catch (error) {
          sendJson(res, 400, { error: '分页参数无效：' + ((error && error.message) || 'cursor/limit'), code: (error && error.code) || 'observability_page_invalid' })
        }
        return
      }
      if (path === '/api/observability/stream' && req.method === 'GET') {
        if (!await requireAdmin(req, res)) return
        // 短期 SSE：先重放有界历史快照，再转发新事件；不持久化、不回放正文。
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        const write = (event) => {
          if (res.writableEnded || res.destroyed) return
          try { res.write('event: ' + event.kind + '\ndata: ' + JSON.stringify(event) + '\n\n') } catch {}
        }
        for (const ev of state.observability.page({ limit: 100 }).items) write(ev)
        const unsubscribe = state.observability.subscribe(write)
        const timer = setInterval(() => { if (!res.writableEnded && !res.destroyed) { try { res.write(': keepalive\n\n') } catch {} } }, 15000)
        if (typeof timer.unref === 'function') timer.unref()
        const close = () => { try { clearInterval(timer) } catch {} ; try { unsubscribe() } catch {} }
        try { res.once('close', close); res.once('finish', close) } catch {}
        return
      }
      if (path === '/api/logs' && req.method === 'GET') { if (!await requireAdmin(req, res)) return; const lines = parseInt(new URL(url, 'http://x').searchParams.get('lines') || '200', 10) || 200; sendJson(res, 200, { lines: readLogTail((log && log.file) ? log.file() : logFile(), lines) }); return }
      if (path === '/api/config' && req.method === 'GET') { if (!await requireAdmin(req, res)) return; sendJson(res, 200, configProjection(state)); return }
      if (path === '/api/config/reload' && req.method === 'POST') {
        if (!await requireAdmin(req, res)) return
        try { recoverStore(state.paths) } catch (error) { const f = transactionFailure(error); sendJson(res, f.status, { error: f.error, code: f.code }); return }
        try {
          reloadConfig(state)
        } catch (error) {
          // F02：磁盘坏状态（如 keys/local 不可解析）不得降级为「空配置/空 Key」，
          // 也不能退化成通用 502；返回稳定 code，内存状态保持重载前的可用代际。
          const f = transactionFailure(error)
          sendJson(res, f.status, { error: f.error, code: f.code })
          return
        }
        sendJson(res, 200, { ok: true })
        return
      }
      if (path === '/api/config/save' && req.method === 'POST') {
        if (!await requireAdmin(req, res)) return
        const body = tryParse(await collectBody(req, (state.cfg.server && state.cfg.server.maxBodyBytes) || 32 * 1024 * 1024))
        if (!isPlainObject(body)) { sendJson(res, 400, { error: '请求体必须为 JSON 对象' }); return }
        const r = await saveConfig(state, body)
        if (r.error) { sendJson(res, r.status || 400, { error: r.error, ...(r.code ? { code: r.code } : {}) }); return }
        if (r.conflict) { sendJson(res, 409, { error: '配置版本已过期（他处已保存过新版本），请刷新后重试', currentVersion: r.currentVersion }); return }
        sendJson(res, 200, { ok: true, status: buildStatus(state) }); return
      }
      if (path === '/api/keys' && req.method === 'POST') {
        if (!await requireAdmin(req, res)) return
        const body = tryParse(await collectBody(req, (state.cfg.server && state.cfg.server.maxBodyBytes) || 32 * 1024 * 1024))
        if (!body || !body.id) { sendJson(res, 400, { error: '缺少 provider id' }); return }
        const kr = await saveKeys(state, body)
        if (kr.error) { sendJson(res, kr.status || 400, { error: kr.error, ...(kr.code ? { code: kr.code } : {}) }); return }
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
          const rb = await readRequestBody(req, (state.cfg.server && state.cfg.server.maxBodyBytes) || 32 * 1024 * 1024, { budget, signal: budget.signal })
          if (rb.error) { sendJson(res, 415, { error: { message: rb.error, type: 'invalid_request_error' } }); return }
          req.__mgBodyBuf = rb.buf
          req.__mgBody = tryParse(req.__mgBodyBuf)
          const model = req.__mgBody && req.__mgBody.model
          vm = vms.find(v => v.name === (typeof model === 'string' ? model.trim() : ''))
        }
        const vmKey = vm && state.cfg._keys && state.cfg._keys['__mg_vm_' + vm.name]
        const meta = vm && state.cfg._keys && state.cfg._keys['__mg_vm_meta_' + vm.name]
        // T-KEY-02：单一真源解析过期时间；非法/歧义值 deny（不再因 Number() NaN 永久放行）。
        const expiry = isVirtualKeyExpired(meta && meta.expiresAt)
        if (vmKey && expiry.state === 'invalid' && state.log) state.log.warn('虚拟模型 Key 过期时间无效，已拒绝放行', 'model=' + (vm && vm.name), 'code=' + expiry.code)
        if ((clientKey || vmKey) && !(vmKey && !expiry.expired && clientAuthOk(req, vmKey))) {
          sendJson(res, 401, { error: { message: '无效的客户端接入 Key（状态 401）', type: 'unauthorized' } })
          return
        }
      }

      if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
        // Codex 只认 {"models":[ModelInfo…]}；普通 OpenAI 客户端继续拿旧 list 形状（向后兼容）。
        if (isCodexModelListRequest(req, url)) {
          const models = codexModelsPayload(state)
          if (models) { sendJson(res, 200, { models }); return }
        }
        sendJson(res, 200, staticModels(state.cfg)); return
      }

      // —— MG-011：POST /v1/embeddings（能力声明 + 上游适配 + 记账 + 熔断/回退） ——
      if (path === '/v1/embeddings') {
        // F04：能力门先于读请求体/解析路由：关闭时 501 且零上游调用。
        if (optionalGate(state, res, 'embedding')) return
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
        if (optionalGate(state, res, 'rerank')) return
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
        if (optionalGate(state, res, path.startsWith('/v1/audio/') ? 'audio' : 'image')) return
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
        if (optionalGate(state, res, 'video')) return
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
        const subject = optionalSubjectOf(state, req)
        const inputHash = videoInputHash(Object.assign({}, vbody, { model: vhit.canonicalName }))
        // F04：幂等键按**主体域**隔离——不同主体用同一个 Idempotency-Key 绝不复用他人任务
        // （旧实现 findTaskByIdem 全局查找 = 跨主体任务泄漏）。同主体同键同输入 → 复用；
        // 同键不同输入 → 409（不静默换内容），且**零上游调用**。
        const existing = findSubjectTask(state.videos, subject, idem)
        if (existing) {
          if (existing.inputHash && existing.inputHash !== inputHash) {
            sendJson(res, 409, { error: { message: '幂等键已用于不同输入，拒绝创建', type: 'idempotency_conflict', code: 'idempotency_key_reused' } })
            return
          }
          sendJson(res, 200, clientTask(existing)); return
        }
        const created = await createVideoTask(state, budget, log, { modelName: vhit.canonicalName, def: vdef, body: vbody, idem, subject, inputHash })
        if (created.ok) { sendJson(res, 202, clientTask(created.task)); return }
        res.writeHead(created.status, { 'content-type': created.contentType }); res.end(created.buf); return
      }
      if (path === '/v1/videos' && req.method === 'GET') {
        if (optionalGate(state, res, 'video')) return
        const subject = optionalSubjectOf(state, req)
        // F04：有主体的任务只对该主体可见（旧任务无 subject 字段，保持可见以兼容历史数据）。
        const list = Object.values(state.videos)
          .filter((t) => !t.subject || t.subject === subject)
          .sort((a, b) => b.createdAt - a.createdAt).slice(0, 50).map(clientTask)
        sendJson(res, 200, { object: 'list', data: list }); return
      }
      const vmatch = /^\/v1\/videos\/([^/]+)(\/cancel)?$/.exec(path)
      if (vmatch && optionalGate(state, res, 'video')) return
      if (vmatch) {
        const vid = decodeURIComponent(vmatch[1])
        const task = state.videos[vid]
        // F04：跨主体访问按「不存在」处理（不泄露他人任务是否存在）。
        if (task && task.subject && task.subject !== optionalSubjectOf(state, req)) {
          sendJson(res, 404, { error: { message: '未知视频任务: ' + vid, type: 'not_found' } }); return
        }
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
      if (isResponses && req.method !== 'POST') {
        // Codex 0.167 会先尝试 WebSocket（GET /v1/responses + upgrade）。网关不做协议升级：
        // 必须明确 404 让客户端回落到 HTTPS（实测日志 "unexpected status 404" 后 POST 成功），
        // 不能 405/挂起，也绝不把 upgrade 帧头转发给任何上游。
        if (req.method === 'GET' && String(req.headers.upgrade || '').toLowerCase() === 'websocket') {
          sendJson(res, 404, { error: { message: 'WebSocket transport not supported by gateway; fall back to HTTPS', type: 'ws_not_supported' } })
          return
        }
        sendJson(res, 405, { error: { message: '仅支持 POST /v1/responses', type: 'invalid_request_error' } })
        return
      }

      // —— 数据面转发（二阶段鉴权已收集 body 时直接复用，流不可二次读取） ——
      let bodyBuf = req.__mgBodyBuf || null
      if (!bodyBuf && (req.method === 'POST' || req.method === 'PUT')) {
        const rb = await readRequestBody(req, ((state.cfg.server && state.cfg.server.maxBodyBytes) || 32 * 1024 * 1024), { budget, signal: budget.signal })
        if (rb.error) { sendJson(res, 415, { error: { message: rb.error, type: 'invalid_request_error' } }); return }
        bodyBuf = rb.buf
      }
      let body = req.__mgBody || (bodyBuf && bodyBuf.length ? tryParse(bodyBuf) : null)
      if ((isChat || isResponses) && (!body || typeof body !== 'object' || Array.isArray(body))) {
        sendJson(res, 400, { error: { message: '请求体必须为 JSON 对象', type: 'invalid_request_error' } })
        return
      }
      // —— MG-015：/v1/responses 入口（Chat 桥）。原生 api:"responses" 透传尚未实现，见契约 §3 ——
      if (isResponses) {
        // 原生 Responses 透传（MG-015）：模型显式 api:"responses" 时不做 Chat 桥转换
        // resolve 在缺 model 且无 defaults.provider 时会抛错：此处静默回落到 Chat 桥，由 forwardChain 给出统一错误
        let nHit = null
        try { nHit = state.router.resolve(body.model) } catch { nHit = null }
        const nDef = nHit && nHit.def
        // D1-A：解析到官方上游（内置 openai 身份，由 openai_base_url 指到网关）→ 官方透传代理。
        // 判定只认 codex/identity.classifyTarget（单一真源），不按 provider 名字猜。
        if (nDef && !nDef.isVirtualModel && !nDef.virtual && nDef.provider && state.cfg.providers[nDef.provider]) {
          const nProv = buildProvider(state.cfg, nDef.provider)
          if (classifyTarget(nProv, state.cfg).kind === 'official') {
            const nconvOfficial = responsesToChat(body, { mode: 'native' })
            if (nconvOfficial.rejected) { sendJson(res, 400, { error: { message: nconvOfficial.rejected.message, type: nconvOfficial.rejected.code || 'unsupported_parameter' } }); return }
            let codexRoute = null
            let codexPlan = null
            if (needsCodexProjection(body, nDef)) {
              codexRoute = buildCodexRoute(state, nHit, nDef, nProv)
              const prep = prepareCodexNativeRequest(body, codexRoute)
              if (prep.rejected) { sendJson(res, 400, { error: { message: prep.rejected.message, code: prep.rejected.code, type: prep.rejected.code || 'unsupported_parameter' } }); return }
              if (prep.lossy && prep.lossy.length) log && log.info('codex native lossy', prep.lossy.slice(0, 20).join(','))
              body = prep.body
              codexPlan = prep.plan
            }
            const noutOfficial = await proxyOfficialResponses(state, budget, log, { req, body, modelName: nHit.canonicalName, def: nDef, res, codexRoute, codexPlan })
            if (noutOfficial && noutOfficial.streamed) return
            res.writeHead(noutOfficial.status, { 'content-type': noutOfficial.contentType }); res.end(noutOfficial.buf); return
          }
        }
        if (nDef && !nDef.isVirtualModel && !nDef.virtual && nDef.api === 'responses') {
          const nconv = responsesToChat(body, { mode: 'native' })
          if (nconv.rejected) { sendJson(res, 400, { error: { message: nconv.rejected.message, type: nconv.rejected.code || 'unsupported_parameter' } }); return }
          if ((nDef.capability || 'chat') !== 'chat') { sendJson(res, 400, { error: { message: '模型 ' + nHit.canonicalName + ' 的能力不是 chat，不能用于 /v1/responses', type: 'unsupported_model' } }); return }
          const nProv = state.cfg.providers[nDef.provider] ? buildProvider(state.cfg, nDef.provider) : null
          // G1：残留 gatewaySubscription 配置在任何目标身份下都必须 fail-closed（零上游、不降级）。
          if (nProv && nProv._def && nProv._def.gatewaySubscription && nProv._def.gatewaySubscription.enabled === true) {
            sendJson(res, 403, { error: { message: GATEWAY_SUBSCRIPTION_RETIRED_MESSAGE, code: GATEWAY_SUBSCRIPTION_RETIRED_CODE, type: 'official_target_rejected' } })
            return
          }
          const opaqueReject = checkThirdPartyOpaque(state, nProv, nDef, body)
          if (opaqueReject) { sendJson(res, opaqueReject.status, { error: { message: opaqueReject.message, code: opaqueReject.code, type: 'codex_native_rejected' } }); return }
          let codexRoute = null
          let codexPlan = null
          if (needsCodexProjection(body, nDef)) {
            codexRoute = buildCodexRoute(state, nHit, nDef, nProv)
            const prep = prepareCodexNativeRequest(body, codexRoute)
            if (prep.rejected) { sendJson(res, 400, { error: { message: prep.rejected.message, code: prep.rejected.code, type: prep.rejected.code || 'unsupported_parameter' } }); return }
            if (prep.lossy && prep.lossy.length) log && log.info('codex native lossy', prep.lossy.slice(0, 20).join(','))
            body = prep.body
            codexPlan = prep.plan
          }
          // Third-party native upstreams already speak Responses. The request body is
          // projected; the response adapter restores namespace identities when the
          // upstream returns flattened calls. softRestore only applies to terminal
          // metadata for third-party routes, so a completed stream is not turned into
          // a synthetic STREAM_INTERRUPTED by an over-strict restore.
          const nout = await proxyNativeResponses(state, budget, log, { req, body, modelName: nHit.canonicalName, def: nDef, wantStream: !!body.stream, res, codexRoute, codexPlan })
          if (nout && nout.streamed) return
          res.writeHead(nout.status, { 'content-type': nout.contentType }); res.end(nout.buf); return
        }
        // M1-3b：把隐式默认改为显式选择——这是为旧客户端/Codex CLI 保留的已知有损兼容模式；
        // 严格默认入口是 bridge()，未来可切换。
        const conv = responsesToChat(body, LEGACY_BRIDGE_COMPAT)
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
      const out = await forwardChain(FWD_DEPS, state, req, fUrl, fPath, req.method, bodyBuf, body, log, streamRelay, budget, {
        ledgerOptions: state.ledgerOptions,
        authzContext: catalogAuthzContext(state, body && body.model),
        now: injectedNow(),
        adapterFactory: state.adapterFactory,
      })
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
          res.writeHead(out.status || 502, Object.assign({ 'content-type': out.contentType || 'application/json; charset=utf-8' }, sanitizeDownstreamHeaders(out.headers))); res.end(out.body); return
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
      res.writeHead(out.status, Object.assign({ 'content-type': out.contentType }, sanitizeDownstreamHeaders(out.headers))); res.end(out.body)
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
      // N06：终态只记一次（status>=500 → FAILED；499 → CANCELLED_UNSENT；4xx → FAILED；2xx → SUCCEEDED）。
      // 用量在这一层无法确证 → usage 'unknown'（绝不填 0）。
      if (state.observability && obsRequestId && !obsRecorded) {
        obsRecorded = true
        try {
          const code = res.statusCode || 0
          const terminal = code === 499 ? 'CANCELLED_UNSENT' : (code >= 400 ? 'FAILED' : 'SUCCEEDED')
          state.observability.recordTerminal({ requestId: obsRequestId, terminal, status: code })
        } catch { /* 观测不得影响请求结果 */ }
      }
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
  // M0-3：先恢复中断事务再读配置；无法判定（外部修改/元数据损坏）时保留现场并 fail-closed。
  const bootPaths = configPaths()
  let recovery = { status: 'clean' }
  try {
    recovery = recoverStore(bootPaths)
  } catch (error) {
    const payload = JSON.stringify({ code: (error && error.code) || 'recovery_failed', message: (error && error.message) || 'unknown', details: (error && error.details) || null })
    process.stderr.write('[config-transaction] RECOVERY_FAILED ' + payload + '\n')
    throw new Error('配置事务恢复失败（fail-closed）：' + ((error && error.code) || 'recovery_failed'))
  }
  let cfg
  try {
    cfg = opts.config ? loadConfig({ configFile: opts.config }) : loadConfig()
  } catch (error) {
    // F02：配置目标损坏时拒绝启动，不降级到「空配置/空 Key」。
    if (isConfigUnreadable(error)) {
      process.stderr.write('[config] CONFIG_UNREADABLE ' + JSON.stringify({ code: error.code, message: error.message }) + '\n')
      const refused = new Error('配置/Key 文件损坏，已拒绝启动（fail-closed，不降级）：' + error.code)
      refused.code = error.code
      throw refused
    }
    throw error
  }
  const mb = process.env.MG_MAX_BODY ? parseInt(process.env.MG_MAX_BODY, 10) : 0
  if (mb > 0) cfg.server = Object.assign({}, cfg.server || {}, { maxBodyBytes: mb })
  // 收集所有密钥值供日志脱敏：环境变量 Key + 面板 Key + extraHeaders 值 + 客户端/管理令牌 + 代理内嵌凭据
  const log = createLogger({ logFile: cfg.server && cfg.server.logFile, silent: opts.silent, secrets: collectSecrets(cfg) })
  if (recovery.status !== 'clean') log.warn('配置事务恢复', 'status=' + recovery.status, recovery.opId ? 'opId=' + recovery.opId : '')
  // F01：旧开关只做迁移提示，不再启用任何能力（官方目标请求会按 official_passthrough_retired 拒绝）。
  if (legacyPassthroughRequested(process.env)) {
    log.warn('MG_CODEX_OFFICIAL_PASSTHROUGH 已退役：客户端官方凭据透传与 /backend-api/codex 已移除；请删除该变量并为官方 provider 配置 apiKeyEnv/面板 Key')
  }
  // 启动与热重载必须同源注入 Codex 目录视图：否则官方 slug 会按「未知非保留前缀」回落 defaults.provider（跨身份串线）。
  cfg._codexCatalog = codexCatalogView(cfg)
  if (!cfg._codexCatalog && cfg.defaults && cfg.defaults.codexCatalogBasePath) {
    log.warn('Codex 目录不可用，官方/聚合模型将按未知模型处理', _codexCatalogError || '')
  }
  // M1-3b：账本进程单例 + 启动 recover（在途/未知预留计数写入日志与状态）。
  const ledgerOptions = ledgerOptionsOf(cfg)
  initForwardLedger(cfg, { ledgerOptions }, log)
  const pids = (() => { const o = {}; for (const id of Object.keys(cfg.providers || {})) o[id] = { requests:0, errors:0, retries:0, latencySum:0, latencyCount:0, tokens:0 }; return o })()
  const state = {
    cfg, log, router: createRouter(cfg),
    ledgerOptions,
    adapterFactory: opts.adapterFactory,
    adminToken: process.env.MG_ADMIN_TOKEN || (cfg.server && cfg.server.adminToken) || (cfg._keys && cfg._keys.__mg_admin) || '',
    paths: cfg._paths || configPaths(),
    // N06：运行时可观测收据（有界内存 ring；request/attempt/usage 三类事件，终态去重）。
    observability: createObservability({ capacity: (cfg.defaults && cfg.defaults.observability && cfg.defaults.observability.capacity) || undefined }),
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
  for (const [pid, p] of Object.entries(cfg.providers || {})) {
    // G1：旧配置可继续加载，但请求会 fail-closed；启动时明确提示迁移，避免误以为能力仍可用。
    if (p && p.gatewaySubscription && p.gatewaySubscription.enabled === true) log.warn('gatewaySubscription 已退役：该 provider 的请求将返回 403 gateway_subscription_retired（零上游），请删除该配置并为官方目标配置自有 apiKeyEnv/面板 Key', 'provider=' + pid)
  }
  // P0-2：受控自管 Codex 配置根只在显式环境开关下登记（默认关闭）；失败保持关闭。
  setupCodexManagedRoot(state)
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
  try {
    state.videos = loadVideoTasks(state.paths.videos)
    // F04：重启恢复——PENDING_SEND（进程在上游结果未知时死亡）一律转 UNKNOWN，
    // 只允许查状态/人工核对，绝不再次 create（避免重复计费/重复生成）。
    if (recoverInterruptedVideoTasks(state.videos)) {
      try { saveVideoTasks(state.paths.videos, state.videos) } catch (e) { log && log.warn('videos 恢复落盘失败', e.message) }
      log && log.info('videos 启动恢复：pending_send → unknown（禁止重复创建）')
    }
  } catch (e) { state.videos = {}; log && log.warn('videos.json 读取失败，按空任务池启动', e.message) }
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