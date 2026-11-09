// 转发链模块（Phase1 TD3 自 index.js 拆分）：routes 构建 + 三层重试 + 循环兜底 + 限流/记账协作
// 共享辅助（健康/统计/工具）由 index.js 经 deps 注入，避免双向依赖
import { gunzipSync } from 'node:zlib'
import { adapterFor, cacheHitMiss, hasTools, mapErrorEnvelope } from './format.js'
import { buildProvider, modelTarget } from './router.js'
import { isStreamResponse } from './sse.js'
import { forward } from './request.js'
import { abortedError, sleepWith } from './budget.js'
import { todayKey } from './shared.js'

const HOP_BY_HOP = new Set(['host','connection','transfer-encoding','content-length','upgrade','keep-alive','te','trailer'])
const STRIP_IN = new Set(['authorization','cookie','x-api-key','api-key','proxy-authorization','proxy-connection','x-mg-admin','x-goog-api-key','host'])
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b])

// 模型级拒绝判定：402/403/404 恒真（上游侧故障，与本次请求无关）；400 需响应体含「模型/上游不可用」语义
// （如 opencodego 的 Provider rejected / Model not supported、jiyuan 的 MODEL_DISABLED / 模型已关闭）——
// 这类换下一模型可能成功，应继续目录链而非直接抛错给客户端。真·参数错误（messages 格式/字段非法、
// max_tokens 类型等）不在此列：换模型同样失败，直接返回保留原始错误。
//
// 402 Payment Required 与 429 同源，属「这个上游现在不能服务」（账户欠费/额度停服），换下一上游立刻可能成功，
// 故视同模型级拒绝继续目录链。生产 09-11 实录：gmi 返回 {"error":"Insufficient balance","reason":"model_access_denied"}
// 时 jiyuan 恰在熔断，兜底链只剩 gmi 一个候选，402 被当作「客户端请求错误」原样透传 → dsh 整轮 turn 失败。
// 注意：402 不进 request.js 的 RETRYABLE_HTTP —— 余额不会在退避几百毫秒后回来，同上游重试纯属浪费；
// 有意义的动作是换上游（此处 continue），而非重发同一请求。
function isModelLevelRejection(status, out) {
  if (status === 402 || status === 403 || status === 404) return true
  if (status !== 400 || !out || !out.length) return false
  let text = ''
  try { text = out.toString('utf8').slice(0, 4000).toLowerCase() } catch { return false }
  return /(provider|upstream|model)[^\n]{0,80}(reject|not support|disabled|not found|does not exist|unknown|不可用|已关闭|不存在)|MODEL_DISABLED|模型(已关闭|不存在|不可用)/i.test(text)
}

// 上游侧故障判定（在 isModelLevelRejection 之前调用）：状态码落在 4xx（request.js 的 RETRYABLE_HTTP 管不到、
// forward() 不会重试），但**响应体自己在说「我这边或我的下游出错了」**——这类错误换上游/换模型立刻可能成功，
// 绝不能当「客户端请求错误」原样抛回去。
// 生产 2026-09-18 实录：atria 返回 422 `{"error":{"message":"Inference request failed.","type":"atria_api_error",
// "code":"upstream_error"}}`，网关按普通 4xx 直接抛给客户端，而目录链上还排着 qwen3.8-flash / glm-5.3-flash
// 两个健康模型没用上 → 用户那一轮 turn 直接失败（ZCode: reason=invalid_request status=422 retryable=false）。
// 与 402 属同类问题（0.5f99b4c 的修法同源）：上游侧故障不应由客户端承担。
// 刻意收窄（防过宽）：只在响应体显式含「上游出错」语义时命中；识别不出该语义的 4xx 仍按客户端错误直接返回
// ——例如 atria 自己的 400 `invalid_request "max_tokens must be an integer between 1 and 65536."` 是确定性参数错误，
// 换模型一样失败，拿去空跑整条兜底链只是浪费上游调用。
const UPSTREAM_FAULT_RE = /upstream[_\s-]?error|inference request failed|internal (server )?error|service unavailable|temporarily unavailable|overloaded|bad gateway|gateway time-?out|try again later|请稍后重试|服务(临时)?不可用/i
function isUpstreamSideFailure(status, out) {
  if (!(status >= 400 && status < 500)) return false
  // 401 鉴权（本网关自己的 key 问题）、402/403/404 模型级拒绝、429 限流：各有专道，不在此重复处理
  if (status === 401 || status === 402 || status === 403 || status === 404 || status === 429) return false
  if (!out || !out.length) return false
  let text = ''
  try { text = out.toString('utf8').slice(0, 4000) } catch { return false }
  return UPSTREAM_FAULT_RE.test(text)
}

// 解压输出上限（防 gzip 炸弹）：collectBody 的 64MB 上限管的是**压缩后**大小，而实测 gzip 压缩比
// 可达 1:1028（50MB 全同字节 → 49.8KB），不设上限最坏能解压出几十 GB；且 gunzipSync 是**同步**的，
// 会同时打爆内存并阻塞事件循环（整个网关假死）。超限时 gunzipSync 直接抛错 → 按上游失败走 fallback，不放行。
const MAX_GUNZIP_BYTES = 32 * 1024 * 1024
function maybeGunzip(buf, contentEncoding) {
  // 只要上游申报了 gzip 或魔数命中，就必须能解压成功；否则抛错让上层当作失败走 fallback，避免放行垃圾字节
  const wants = /gzip/i.test(contentEncoding || '') || (buf && buf.length >= 2 && buf[0] === GZIP_MAGIC[0] && buf[1] === GZIP_MAGIC[1])
  if (wants) return gunzipSync(buf, { maxOutputLength: MAX_GUNZIP_BYTES })
  return buf
}

// 转发头：剥离客户端授权/敏感头，统一由网关注入鉴权，防止绕过
function buildHeaders(req, provider, bodyBuf, cfg, api, body) {
  const headers = {}
  const connectionHeaders = new Set(String(req.headers.connection || '').toLowerCase().split(',').map(v => v.trim()))
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase()
    if (HOP_BY_HOP.has(lk) || STRIP_IN.has(lk) || connectionHeaders.has(lk)) continue
    headers[k] = v
  }
  headers['user-agent'] = 'model-gateway/0.1'
  if (!headers['accept']) headers['accept'] = 'application/json'
  headers['accept-encoding'] = 'identity' // 请求上游返回明文，避免 gzip 导致响应体解析失败
  if (provider.apiKey) headers['authorization'] = 'Bearer ' + provider.apiKey
  const extra = Object.assign({}, (cfg.defaults || {}).extraHeaders, provider.extraHeaders)
  for (const [k, v] of Object.entries(extra)) headers[k.toLowerCase()] = v
  if (provider.id === 'opencodego') {
    const first = (v) => Array.isArray(v) ? v[0] : v
    const session = first(req.headers['x-opencode-session']) || first(req.headers['x-session-id']) || first(req.headers['x-conversation-id']) ||
      (body && (body.session_id || body.conversation_id)) || headers['x-opencode-session'] || headers['x-session-id']
    if (session != null && String(session).trim()) headers['x-opencode-session'] = String(session)
  }
  // 协议专属头（per-model protocol 改革的下游：协议换掉后鉴权头也得跟着换）。
  // Anthropic Messages API 认 x-api-key 且强制 anthropic-version（多数 OpenAI 兼容中转也接受 Bearer，
  // 但官方端点缺 version 直接 400 "anthropic-version is required"）。这里两者都给，兼容性最大。
  if (api === 'anthropic') {
    if (!headers['anthropic-version']) headers['anthropic-version'] = '2023-06-01'
    if (provider.apiKey && !headers['x-api-key']) headers['x-api-key'] = provider.apiKey
  } else if (api === 'gemini') {
    if (provider.apiKey && !headers['x-goog-api-key']) headers['x-goog-api-key'] = provider.apiKey
  }
  if (bodyBuf && bodyBuf.length) headers['content-length'] = bodyBuf.length
  return headers
}
function orderCandidates(state, model, providers) {
  const rate = (pid) => { const c = state.cacheStat && state.cacheStat[model + '\u0000' + pid]; return (c && (c.hit + c.miss) > 0) ? c.hit / (c.hit + c.miss) : null }
  // 缓存亲和带有效期：过期后不再强制优先，让配置里的主上游有机会被重新试用（上游恢复后自动回流）；0=不过期
  const rawTtl = state.cfg && state.cfg.defaults && state.cfg.defaults.affinityTtlMs
  const ttl = (rawTtl === 0 || rawTtl === '0') ? 0 : (Number.isFinite(Number(rawTtl)) ? Number(rawTtl) : AFFINITY_TTL_MS)
  const at = state.affinityAt && state.affinityAt[model]
  const fav = state.affinity && state.affinity[model]
  const favLive = fav && (ttl <= 0 || (at && (Date.now() - at) < ttl))
  return providers.slice().sort((a, b) => {
    if (favLive) { if (a === fav) return -1; if (b === fav) return 1 }
    const sa = rate(a), sb = rate(b)
    if (sa != null && sb != null) return sb - sa
    if (sa != null) return -1
    if (sb != null) return 1
    return 0
  })
}

const DIALOGUE_GAP_MS = 300000 // 无会话 ID 时，间隔超过 5 分钟视为新对话
const STREAM_DROP_THRESHOLD = 3 // 同一上游连续流式中断 >= 该值，后续请求绕开它（不被 markOk 重置）
// 连续断流绕开的冷却时长：到点后放行一次半开探测，避免上游「一断流就永久出局」（可用 defaults.streamDropCooldownMs 覆盖）
const STREAM_DROP_COOLDOWN_MS = 60000
const AFFINITY_TTL_MS = 300000  // 缓存亲和有效期（可用 defaults.affinityTtlMs 覆盖）：过期后主上游可被重新试用

// ===== 思考强度（effort）：入站归一化 + 出口 per-route 整形 =====
// thinking.type 值映射：OpenAI 系档位词（off/low/high…）→ 上游 thinking.type 词表
// （开启/关闭/自动 = enabled/disabled/auto）。未命中映射的值原样透传（如 MiniMax 的 adaptive）。
const THINKING_TYPE_MAP = { none: 'disabled', off: 'disabled', minimal: 'enabled', low: 'enabled', medium: 'enabled', high: 'enabled', xhigh: 'enabled', disabled: 'disabled', enabled: 'enabled', auto: 'auto' }
// 「关闭思考」的等价拼写：各家客户端用词不一（OpenRouter/OpenAI Responses 系 `reasoning_effort:"none"`、
// ZCode 内置模板 `{"reasoning":{"effort":"none"}}`、MiniMax 系 `thinking.type:"disabled"`、
// 本地 models.<名>.effortOptions 里惯用 `"off"`）。统一归一到 **'none'**——这是 OpenAI/Responses/OpenRouter
// 的官方档位词，也是这些上游唯一认的关闭拼写。
// 方向别搞反（2026-09-17 纠错）：首版归一到 'off' 后 openrouter 回 400
// `reasoning_effort: Invalid option: expected one of "max"|"xhigh"|"high"|"medium"|"low"|"minimal"|"none"`
// ——该词表里**没有 off、只有 none**。本地 effortOptions 里写 'off' 不影响：白名单比较两侧同过 canonEffort，
// 'off' 与 'none' 视为同一档；出口 thinking 形态再经 THINKING_TYPE_MAP 转 'disabled'。
const EFFORT_NONE_ALIAS = new Set(['off', 'disabled', 'false'])
export function canonEffort(v) { const s = String(v == null ? '' : v).trim().toLowerCase(); return EFFORT_NONE_ALIAS.has(s) ? 'none' : s }

// 入站归一化：把客户端带来的思考强度收拢成网关唯一入口形态（平面 reasoning_effort）。
// 背景（生产 2026-09-17 实录）：ZCode CLI 按 OpenRouter 惯例发**嵌套** `reasoning:{effort}`，网关此前没有任何
// 入站字段处理、也无出站白名单，于是原样透传——OpenRouter 认得该字段所以打主上游一切正常，一旦 429 兜底到
// 严格上游（jiyuan/tokenrhythm，LiteLLM 内核字段白名单校验）就 400 `UNKNOWN_FIELD 未知请求字段：reasoning.effort`，
// 症状是「平时不报、只在兜底时炸」，极难归因。
// 处理：effort 取值并入 reasoning_effort（客户端已显式给出平面字段时以平面字段为准），嵌套 reasoning 对象一律剔除
// （含 summary——OpenAI chat 协议无对应位置，且它正是严格上游的拒绝点）；关闭类拼写归一为 off。
export function normalizeEffortInput(body) {
  if (!body || typeof body !== 'object') return null
  const notes = []
  const r = body.reasoning
  if (r && typeof r === 'object' && !Array.isArray(r)) {
    const raw = r.effort
    const eff = (raw === undefined || raw === null || String(raw).trim() === '') ? null : String(raw).trim()
    const flat = (body.reasoning_effort === undefined || body.reasoning_effort === null || String(body.reasoning_effort).trim() === '') ? null : String(body.reasoning_effort).trim()
    if (eff !== null && flat === null) { body.reasoning_effort = eff; notes.push('reasoning.effort=' + eff + ' -> reasoning_effort=' + eff) }
    else notes.push('剔除嵌套 reasoning 对象' + (eff !== null ? '（保留客户端显式 reasoning_effort=' + flat + '）' : ''))
    delete body.reasoning
  }
  const cur = (body.reasoning_effort === undefined || body.reasoning_effort === null) ? null : String(body.reasoning_effort).trim()
  if (cur !== null) {
    const c = canonEffort(cur)
    if (c !== cur) { body.reasoning_effort = c; notes.push('reasoning_effort ' + cur + ' -> ' + c + '（关闭思考的同义拼写归一）') }
  }
  return notes.length ? notes.join('；') : null
}

function maxConcur(cfg) { return (cfg.defaults && cfg.defaults.concurrency && cfg.defaults.concurrency.maxPerProvider) || 8 }
function throttleOf(state, pid) {
  if (!state.throttle[pid]) state.throttle[pid] = { max: maxConcur(state.cfg), inFlight: 0, wait: [], rateUntil: 0 }
  return state.throttle[pid]
}
// 可取消等待：signal 中止时从 waiter 队列移除并 reject，避免「已取消仍在排队/醒来后继续发请求」。
function waitSlot(queue, signal) {
  if (!signal) return new Promise((resolve) => queue.push(resolve))
  if (signal.aborted) return Promise.reject(abortedError('request_timeout'))
  return new Promise((resolve, reject) => {
    const waiter = () => { cleanup(); resolve() }
    const cleanup = () => { try { signal.removeEventListener('abort', onAbort) } catch {} }
    const onAbort = () => {
      const i = queue.indexOf(waiter)
      if (i !== -1) queue.splice(i, 1)
      cleanup()
      reject(abortedError('request_timeout'))
    }
    queue.push(waiter)
    try { signal.addEventListener('abort', onAbort, { once: true }) } catch { cleanup() }
  })
}
function wakeSlot(queue) { if (queue.length) (queue.shift())() }

// 每 provider 并发信号量 + 429 排队（rateUntil 内新请求等待）
export async function acquireProvider(state, pid, cfg, signal) {
  const th = throttleOf(state, pid)
  const r = th.rateUntil
  if (r > Date.now()) await sleepWith(Math.min(r - Date.now(), 60000), signal)
  let woke = false
  if (th.inFlight >= th.max) { await waitSlot(th.wait, signal); woke = true }
  // 取消可能发生在被唤醒与占用槽位之间：此时不占槽、不再发请求；把刚拿到的槽位交给下一个 waiter
  if (signal && signal.aborted) { if (woke) wakeSlot(th.wait); throw abortedError('request_timeout') }
  th.inFlight += 1
  return () => { th.inFlight -= 1; wakeSlot(th.wait) }
}
function rateWait(state, name, qps, signal) {
  const now = Date.now()
  const cap = Math.max(1, Math.ceil(qps))
  let q = state.qpsToken[name]
  if (!q) q = state.qpsToken[name] = { tokens: cap, last: now }
  const refill = (now - q.last) * qps / 1000
  q.tokens = Math.min(cap, q.tokens + refill)
  q.last = now
  // Reserve each queued request's token. Keeping negative balances prevents
  // concurrent waiters from all consuming the same future refill.
  q.tokens -= 1
  const refund = () => { q.tokens += 1 }
  if (q.tokens >= 0) return Promise.resolve(refund)
  // 取消时归还预留令牌，避免一次取消把令牌余额永久打成负数
  return sleepWith(Math.max(0, Math.ceil((-q.tokens / qps) * 1000)), signal).then(() => refund, (e) => { q.tokens += 1; throw e })
}
function modelThrottleOf(state, name, max) { if (!state.throttleModel[name]) state.throttleModel[name] = { max, inFlight: 0, wait: [] }; return state.throttleModel[name] }
async function acquireSem(th, signal) {
  let woke = false
  if (th.inFlight >= th.max) { await waitSlot(th.wait, signal); woke = true }
  if (signal && signal.aborted) { if (woke) wakeSlot(th.wait); throw abortedError('request_timeout') }
  th.inFlight += 1
  return () => { th.inFlight -= 1; wakeSlot(th.wait) }
}

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
// 虚拟模型入口额度检查：账本按虚拟名独立记账（目录内各模型消耗同时计入），超限返回文案
export function virtualQuotaExceeded(state, vmDef) {
  const used = (state.stats.byModel[vmDef.name] && state.stats.byModel[vmDef.name].tokens) || 0
  if (vmDef.quota > 0 && used >= vmDef.quota) return '总额度已用尽'
  const dk = state.stats.daily[vmDef.name] && state.stats.daily[vmDef.name][todayKey()]
  if (vmDef.dailyQuota > 0 && dk && (dk.tokens || 0) >= vmDef.dailyQuota) return '今日额度已用尽'
  return null
}

export function routeLimit(state, cfg, model, body) {
  if (!model) return null
  const md = cfg.models && cfg.models[model]; if (!md) return null
  if (md.quota > 0 && ((state.stats.byModel[model] && state.stats.byModel[model].tokens) || 0) >= md.quota) return '总额度已用尽'
  if (md.dailyQuota > 0 && ((state.stats.daily[model] && state.stats.daily[model][todayKey()] && state.stats.daily[model][todayKey()].tokens) || 0) >= md.dailyQuota) return '今日额度已用尽'
  if (md.maxContext > 0 && body && body.messages && estPromptTokens(body) >= md.maxContext) return '超出上下文上限'
  return null
}

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

export async function forwardChain(deps, state, req, url, path, method, bodyBuf, body, log, streamRelay, budget) {
  const { ensureHst, markFail, markOk, healthy, agg, ensureSt, noteAffinity, noteCacheStat, tallyDaily, tallyVirtual, tallyDialogue, tallyDialogueRequest, tryParse, collectBody } = deps
  const cfg = state.cfg
  const budgetSignal = (budget && budget.signal) || null
  const overallMsCfg = (cfg.defaults && cfg.defaults.timeout && cfg.defaults.timeout.overallMs) || 0
  const timeoutBody = () => Buffer.from(JSON.stringify({ error: { message: '请求超时：超出整体预算 ' + overallMsCfg + 'ms（defaults.timeout.overallMs）', type: 'request_timeout' } }))
  const abortedResult = () => (budget && budget.reason === 'client_closed')
    ? { kind: 'aborted' }
    : { kind: 'json', status: 504, contentType: 'application/json', body: timeoutBody() }
  let routes = []
  let maxModel = 0
  let qps = 0
  let bodyDirty = false        // body 已被网关改写（入站归一化 / 思考强度整形 / 跨模型兜底）：tbuf 必须重新序列化，不能沿用客户端原缓冲
  let entryDefaultEffort = null // 入口模型（虚拟入口取链首）配置的默认思考档位：客户端没给档位时才启用
  let requestModel = null
  const dir = (cfg.defaults && cfg.defaults.directory) || []
  // 入站归一化：嵌套 reasoning:{effort} → 平面 reasoning_effort（严格上游不认嵌套对象，见 normalizeEffortInput 注释）
  const effNote = normalizeEffortInput(body)
  if (effNote && log) log.warn('思考强度入站归一化', effNote)
  if (effNote) bodyDirty = true
  const dialogueId = resolveDialogue(state, req, body)
  // 一次客户端请求只计一次对话请求数（token/缓存回调各自累加数值，不再 +1）
  if (dialogueId && typeof tallyDialogueRequest === 'function') tallyDialogueRequest(state, dialogueId)
  if (body && body.model) {
    const hit = state.router.resolve(body.model)
    // 决策 1：已配置虚拟模型后，未知名不再静默走 defaults 链（防 key 隔离被无感绕过），明确 404
    if (!hit.known && (state.cfg.virtualModels || []).length) {
      return { kind: 'json', status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ error: { message: '未知模型名: ' + body.model + '。可用虚拟模型见 GET /v1/models', type: 'unknown_model' } })) }
    }
    requestModel = hit.canonicalName
    // 能力隔离（MG-011/012）：非 chat 能力不得从对话入口调用（embedding/rerank 各有专属入口）
    if (!hit.def.isVirtualModel && !hit.def.virtual && (hit.def.capability || 'chat') !== 'chat') {
      const _cap = hit.def.capability || 'chat'
      const _where = _cap === 'embedding' ? '请调用 /v1/embeddings' : (_cap === 'rerank' ? '请调用 /v1/rerank' : '请使用对应能力入口')
      return { kind: 'json', status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ error: { message: '模型 ' + (hit.def.name || hit.canonicalName) + ' 的能力是 ' + _cap + '，不能用于对话（' + _where + '）', type: 'unsupported_model' } })) }
    }
    maxModel = hit.def.maxConcurrent || 0
    qps = hit.def.qps || 0
    // 思考强度（LiteLLM 风格）：每个模型可配允许档位列表，客户端传的档位不在列表内则本地直接拒绝，不放给上游。
    // 白名单两侧都过 canonEffort 归一后比较（off/none/disabled/false 同义），避免「关闭思考」换个拼写就判非法。
    // 注意：这里只做**取值**校验（档位是否存在）；字段**形态**（平面 reasoning_effort 还是 thinking 对象）
    // 下沉到每条路由按目标模型自身 effortFormat 决定（见 for(route) 内「思考强度 per-route 整形」）。
    const opts = hit.def.effortOptions
    if (opts && opts.length && body.reasoning_effort !== undefined && body.reasoning_effort !== null && !opts.some((o) => canonEffort(o) === canonEffort(body.reasoning_effort))) {
      return { kind: 'json', status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ error: { message: 'reasoning_effort 不支持 ' + body.reasoning_effort + '（该模型允许：' + hit.def.effortOptions.join(', ') + '）', type: 'UnsupportedParamsError' } })) }
    }
    if (hit.def.isVirtualModel) {
      // 用自身 directory 快照建 routes（providers 空时回退模型默认上游+fallbacks，与 defaults 分支同构）
      for (const e of hit.def.directory) {
        if (!e || typeof e.model !== 'string' || !e.model) continue
        const _m = cfg.models && cfg.models[e.model]
        routes.push({ model: e.model, mode: e.mode, providers: (e.providers && e.providers.length ? e.providers.filter(Boolean) : (_m ? [_m.provider, ...(_m.fallbacks || [])].filter(Boolean) : [])) })
      }
      if (!routes.length) return { kind: 'json', status: 502, contentType: 'application/json', body: Buffer.from(JSON.stringify({ error: { message: '虚拟模型 ' + hit.def.name + ' 的目录无可路由模型', type: 'no_route' } })) }
      // 决策 3 连锁：虚拟模型透传思考强度，但用链首真实模型自身的 effortOptions 补本地校验（廉价参数检查先行于额度判断）
      const d0vm = routes[0] && cfg.models && cfg.models[routes[0].model]
      if (d0vm && d0vm.effortOptions && d0vm.effortOptions.length && body.reasoning_effort !== undefined && body.reasoning_effort !== null && !d0vm.effortOptions.some((o) => canonEffort(o) === canonEffort(body.reasoning_effort))) {
        return { kind: 'json', status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ error: { message: 'reasoning_effort 不支持 ' + body.reasoning_effort + '（' + routes[0].model + ' 允许：' + d0vm.effortOptions.join(', ') + '）', type: 'UnsupportedParamsError' } })) }
      }
      // 思考强度格式不再在此处按链首转换：改为每条路由按目标模型自身 effortFormat 整形（见 for(route) 内）。
      // 链首形态只用于决定「客户端没给档位时是否注入链首的配置默认」，保持既有语义不变。
      if (d0vm && (d0vm.effortFormat || '') === 'thinking' && d0vm.reasoning) entryDefaultEffort = d0vm.reasoning
      // 入口上下文约束（虚拟模型自身的 maxContext，区别于目录内各模型自己的限制）
      if (hit.def.maxContext > 0 && body.messages && estPromptTokens(body) >= hit.def.maxContext) {
        return { kind: 'json', status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ error: { message: '超出虚拟模型 ' + hit.def.name + ' 的上下文上限 (' + hit.def.maxContext + ')', type: 'context_limit' } })) }
      }
      // 虚拟模型自身额度 = 入口总额度（目录内各模型消耗计入虚拟名账本）：超限拒绝服务，而非切目录（目录切换是模型级故障语义）
      const vq = virtualQuotaExceeded(state, hit.def)
      if (vq) return { kind: 'json', status: 429, contentType: 'application/json', body: Buffer.from(JSON.stringify({ error: { message: '虚拟模型 ' + hit.def.name + ' ' + vq, type: 'quota_exceeded' } })) }
    } else if (hit.def.virtual) {
      // 虚拟共用模型名：等价「未指定模型」，走 defaults.directory 默认链（首项即真实默认模型），
      // 把真实模型名发给上游；否则会把虚拟名透传上去导致 "Model <虚拟名> is not supported"
      if (dir.length) {
        for (const e of dir) { if (e && typeof e.model === 'string' && e.model) { const _m = cfg.models && cfg.models[e.model]; routes.push({ model: e.model, mode: (e.mode === 'onFail' ? 'onFail' : 'afterAll'), providers: (e.providers && e.providers.length ? e.providers.filter(Boolean) : (_m ? [ _m.provider, ...(_m.fallbacks || []) ].filter(Boolean) : [])) }) } }
        const d0 = routes[0] && cfg.models && cfg.models[routes[0].model]
        if (d0) { maxModel = d0.maxConcurrent || 0; qps = d0.qps || 0 }
        // 思考强度格式同样下沉到 per-route 整形；此处仅沿用既有语义：链首是 thinking 形态且有配置默认时才注入默认档位
        if (d0 && (d0.effortFormat || '') === 'thinking' && d0.reasoning) entryDefaultEffort = d0.reasoning
        if (cfg.defaults && cfg.defaults.reasoning) entryDefaultEffort = cfg.defaults.reasoning
      } else {
        routes.push({ model: null, providers: [hit.def.provider].filter(Boolean) })
        if (!(cfg.defaults && cfg.defaults.provider)) return { kind: 'json', status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ error: { message: '未指定默认上游（请配置 defaults.provider 或 defaults.directory）', type: 'missing_model' } })) }
      }
    } else {
      // 路由序列：先本模型自身上游，再按 defaults.directory 顺序做跨模型兜底（首个为默认）
      // 真实模型入口：客户端没给档位时，用本模型配置的 reasoning 默认值（客户端自带优先）
      entryDefaultEffort = hit.def.reasoning || null
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
  // 思考强度取值（单一真源）：客户端显式档位 > 入口模型（虚拟入口即链首）的配置默认值。
  // 字段**形态**不在此处决定——每条路由按目标模型自身 effortFormat 整形，见下方 for(route) 内。
  const _clientEff = (body && body.reasoning_effort !== undefined && body.reasoning_effort !== null && String(body.reasoning_effort).trim() !== '') ? canonEffort(body.reasoning_effort) : null
  const gwEffort = _clientEff !== null ? _clientEff : (entryDefaultEffort ? canonEffort(entryDefaultEffort) : null)
  const started = Date.now()
  const modelName = (body && body.model) || (routes[0] && routes[0].model) || (cfg.defaults && cfg.defaults.provider) || (routes[0] && routes[0].providers && routes[0].providers[0]) || null
  const bm = state.stats.byModel[modelName] = state.stats.byModel[modelName] || { requests: 0, errors: 0 }

  let releaseModel = null
  let qpsRefund = null            // QPS 令牌归还闭包（MG-002 §3：取消且未发上游时必须归还）
  let upstreamAttempted = false   // 是否真的发起过上游请求（决定取消时是否归还令牌）
  const refundQps = () => { if (qpsRefund && !upstreamAttempted) { qpsRefund(); qpsRefund = null } }
  try {
    if (maxModel > 0) releaseModel = await acquireSem(modelThrottleOf(state, modelName, maxModel), budgetSignal)
    if (qps > 0) qpsRefund = await rateWait(state, modelName, qps, budgetSignal)
  } catch (e) {
    if (releaseModel) { releaseModel(); releaseModel = null }
    if (e && e.aborted) { refundQps(); return abortedResult() }
    throw e
  }
  let lastErr = null
  let last4xx = null          // 模型级拒绝（403/404）的最后一次响应：整条链全被拒绝时回它（保留上游原始错误）
  let last4xxPid = null       // last4xx 对应的上游（pid 是 for 循环块作用域，循环外取不到）
  let rejectedOnly = false    // 本轮是否只有模型级拒绝（无网络错/5xx/429）：是则不再循环重试（403 是确定性拒绝，循环无意义）
  let tried = false
  let streamStarted = false   // 流式已开始（响应头已发给客户端）：此后不能再写 json 状态码，失败只能以流内错误事件收尾
  const loopMs = (cfg.defaults && cfg.defaults.timeout && cfg.defaults.timeout.loopMs) || 120000
  // 模型链循环上限进一步被请求级整体预算钳制（MG-002）：预算小于 loopMs 时以预算为准
  const loopDeadline = (budget && budget.deadlineAt != null) ? Math.min(Date.now() + loopMs, budget.deadlineAt) : Date.now() + loopMs
  const chainModels = []            // 实际尝试过的 serving 模型链（跨模型兜底/循环标记，供日志/面板查看）
  try {
  // 循环兜底：整条路由链(a→b→c)一轮失败后回到队首反复尝试，直到成功 / 业务4xx / 整体超时(loopMs)
  outer: while (Date.now() < loopDeadline) {
    if (budget && budget.expired()) { lastErr = abortedError((budget && budget.reason) || 'request_timeout'); refundQps(); break }
    let cycleTried = false
    rejectedOnly = true // 每轮重置：遇到可重试类失败（catch）即置 false；整轮只有 403/404 则维持 true → 轮末 break
    for (const route of routes) {
      const serving = route.model
    const lim = routeLimit(state, cfg, serving, body)
    if (lim) { log && log.warn('skip model (' + lim + ')', serving || '-', '-> next'); continue } // 额度/上下文超限：自动断连并按目录切换到下一模型
    const provs = (route.mode === 'onFail') ? route.providers.slice(0, 1) : orderCandidates(state, route.model, route.providers)
    for (const pid of provs) {
    if (!pid || !cfg.providers[pid]) continue
    const prov = buildProvider(cfg, pid)
    const h = ensureHst(state, pid)
    if (!healthy(h, Date.now())) {
      // 熔断中：跳过该上游并推进。此处**不得**调 markFail——markFail 在 fails>=th 时会执行
      // openUntil = now + cd，而每个请求都会走到这里，等于把冷却窗口无限续期：只要流量不断，
      // 上游永远等不到半开，整条兜底链退化成单点。
      // 生产 09-11 实录：jiyuan 两次流中断熔断后剩余冷却被钉在 120s（实测 openDurationMs=1500
      // 时 6s 内上游零次被重试），其承载的 qwen3.8-flash/glm-5.3-flash 被永久排除，
      // 链上只剩 gmi 的 MiniMax-M3，gmi 一欠费整条链即断。
      // 与下方 streamDrops 绕开分支同理（那里注释已点名 jiyuan）：healthy() 只要求 openUntil 过期，
      // 不加 markFail 时冷却到点自然放行一次，收敛由真实探测结果决定。
      log && log.warn('skip provider (熔断中)', pid, '剩余冷却 ' + Math.ceil((h.openUntil - Date.now()) / 1000) + 's')
      continue
    }
    if ((h.streamDrops || 0) >= STREAM_DROP_THRESHOLD) {
      // 连续流式中断过多：冷却期内绕开该上游（走其他上游/模型）；冷却到点后放行一次半开探测——
      // 探测成功即解除（streamDrops 归零），再断流则重新计时。绕开时不再 markFail：否则熔断被反复续期，
      // 上游既拿不到流量也永无翻身机会，整条兜底链会退化成单点（jiyuan 一挂，opencodego 早被钉死）。
      const dropCd = Number(cfg.defaults && cfg.defaults.streamDropCooldownMs) > 0 ? Number(cfg.defaults.streamDropCooldownMs) : STREAM_DROP_COOLDOWN_MS
      const since = Date.now() - (h.streamDropAt || 0)
      if (since < dropCd) { log && log.warn('skip provider (流中断过多，绕开)', pid, '剩余冷却 ' + Math.ceil((dropCd - since) / 1000) + 's'); continue }
      h.streamDrops = STREAM_DROP_THRESHOLD - 1 // 半开：本轮放行一次（再断流会 +1 回到阈值并重新计时）
      log && log.warn('half-open 放行上游（连续断流冷却结束，探测一次）', pid)
    }
    if (prov._def.apiKeyEnv && !prov.keyOk) { log && log.warn('skip provider (no key)', pid); continue }
    tried = true
    cycleTried = true
    if (chainModels[chainModels.length - 1] !== serving) chainModels.push(serving)
    agg(state, pid, 'requests', 1); state.st.counters.requests += 1; bm.requests += 1
    // 跨模型兜底：把发给上游的 model 名改写为该兜底模型名。
    // 改革（protocol-per-model）：同一上游的不同模型可以各走不同协议（如 OpenCode Zen 的 union-alpha
    // 只接受 Anthropic /v1/messages，同上游其它模型走 OpenAI /v1/chat/completions），因此协议的落点从
    // 「上游」下沉到「模型」：models.<名>.api > providers.<pid>.api > openai（缺省仍走上游级设置，向后兼容）。
    const _md = (cfg.models && route.model && cfg.models[route.model]) || null
    // per-上游模型名覆盖（可选）：同一模型在不同上游叫不同名字（如 union-alpha 在 OpenRouter 侧为
    // stealth/union-alpha），跨上游兜底时不映射会拿到 404，备用等于没有。
    // 单一解析入口（MG-008）：探测/预热/failback/转发共用 modelTarget，避免同名不同路。
    const _target = modelTarget(cfg, route.model, pid)
    const servingName = _target.servingName
    let routeBody = (servingName && body && servingName !== body.model) ? Object.assign({}, body, { model: servingName }) : body
    // max_tokens 归一化（按目标模型的输出上限收敛）：不同上游对取值范围的容忍度不同，网关原样透传会让
    // 严格上游把整个请求判为参数非法，而 400 属请求参数类错误、换模型也一样失败——不清掉就会拖垮整条兜底链。
    //   · 非正整数 / 非整数（如 0、负数）：删除该字段，交由上游取默认。多数上游把 0 当「不限」，
    //     但 Atria 直接 400 "max_tokens must be an integer between 1 and 65536"。
    //   · 超过 models.<模型名>.maxTokensMax（可选；缺省 / 0 = 不限制）：钳到该上限。
    if (body && body.max_tokens !== undefined && body.max_tokens !== null) {
      const _mt = Number(body.max_tokens)
      const _cap = Number((_md && _md.maxTokensMax) || 0) || 0
      let _fix = null
      if (!Number.isFinite(_mt) || !Number.isInteger(_mt) || _mt <= 0) _fix = 'drop'
      else if (_cap > 0 && _mt > _cap) _fix = _cap
      if (_fix !== null) {
        if (routeBody === body) routeBody = Object.assign({}, body)
        if (_fix === 'drop') { delete routeBody.max_tokens; log && log.warn('max_tokens 归一化(删除非法值)', pid, '原值=' + body.max_tokens + ' -> 交由上游取默认') }
        else { routeBody.max_tokens = _fix; log && log.warn('max_tokens 归一化(钳制)', pid, _mt + ' -> ' + _fix + ' (模型上限)') }
      }
    }
    // 思考强度 per-route 整形（潜伏项修复）：字段**形态**由本路由模型自身的 effortFormat 决定。
    // 此前只在入口按「请求模型 / 链首模型」的形态注入一次，而 body 是各路由共享的——一旦兜底切到
    // effortFormat 不同的模型就形态错配：链首 reasoning_effort、兜底模型 thinking（union-alpha → qwen3.8-flash）
    // 时后者拿不到自己认的字段；反向（链首 thinking、兜底 reasoning_effort）则多送一个它不认的对象。
    // 取值不动（客户端显式档位 > 入口默认档位），只换形态；两字段互斥，避免同一个 body 同时带两者。
    if (gwEffort) {
      const _fmt = (_md && _md.effortFormat) || 'reasoning_effort'
      if (_fmt === 'thinking') {
        const _mapped = THINKING_TYPE_MAP[gwEffort] || gwEffort
        const _curType = (routeBody.thinking && typeof routeBody.thinking === 'object') ? String(routeBody.thinking.type == null ? '' : routeBody.thinking.type) : null
        if (_curType !== _mapped || routeBody.reasoning_effort !== undefined) {
          if (routeBody === body) routeBody = Object.assign({}, body)
          routeBody.thinking = Object.assign({}, (routeBody.thinking && typeof routeBody.thinking === 'object') ? routeBody.thinking : {}, { type: _mapped })
          delete routeBody.reasoning_effort
          bodyDirty = true
        }
      } else {
        const _curFlat = (routeBody.reasoning_effort === undefined || routeBody.reasoning_effort === null) ? null : String(routeBody.reasoning_effort)
        if (_curFlat !== gwEffort || routeBody.thinking !== undefined) {
          if (routeBody === body) routeBody = Object.assign({}, body)
          routeBody.reasoning_effort = gwEffort
          delete routeBody.thinking
          bodyDirty = true
        }
      }
    }
    let turl = url, tbuf = bodyBuf
    const api = _target.api
    let degraded = false
    // 上游不给流时的降级（可选 models.<名>.forceNoStream）：
    // 实测 OpenCode Zen 的 union-alpha —— 流式请求返回 200 + content-type: text/event-stream，
    // 但整个 SSE 体零字节随即关闭。客户端是 OpenCode 等原生客户端时看得懂；通用 OpenAI 客户端只会
    // 「头 2xx + 立刻断流」，被网关判成假成功去切下一上游，白等一个首字节周期。
    // 开了本开关：网关改为非流式向上游取完整结果，再借 asSSE 通道以单帧 SSE + [DONE] 交付。
    if ((_md && _md.forceNoStream) && routeBody && routeBody.stream) {
      if (routeBody === body) routeBody = Object.assign({}, body)
      routeBody.stream = false
      degraded = true
      log && log.warn('流式降级(forceNoStream)', pid, 'model=' + (serving || '-') + ' -> 非流式拉取后以 SSE 交付')
    }
    if (api !== 'openai' && routeBody) { const ad = adapterFor(api); const r = ad.build(routeBody); if ((hasTools(routeBody) || routeBody.tool_choice) && routeBody.stream) { r.body.stream = false; degraded = true } turl = r.path; tbuf = Buffer.from(JSON.stringify(r.body)) }
    else if ((bodyDirty || routeBody !== body) && routeBody) tbuf = Buffer.from(JSON.stringify(routeBody))
    const headers = buildHeaders(req, prov, tbuf, cfg, api, body)
    let release = null
    try { release = await acquireProvider(state, pid, cfg, budgetSignal) } catch (e) {
      if (e && e.aborted) { lastErr = e; refundQps(); log && log.warn('request aborted (queued)', e.reason || e.message); break outer }
      throw e
    }
    const attemptStart = Date.now()
    try {
      upstreamAttempted = true
      const result = await forward(prov, turl, req.method, headers, tbuf, cfg.defaults || {}, log, { budget, signal: budgetSignal })
      const latency = Date.now() - attemptStart
      const o = ensureSt(state, pid)
      o.latencySum += latency; o.latencyCount += 1
      o.lats.push(latency); if (o.lats.length > 200) o.lats.shift()
      state.stats.global.latencySum += latency; state.stats.global.confirmed += 1
      state.stats.global.lats.push(latency); if (state.stats.global.lats.length > 200) state.stats.global.lats.shift()
      bm.latencySum = (bm.latencySum || 0) + latency; bm.latencyCount = (bm.latencyCount || 0) + 1
      agg(state, pid, 'retries', result.retries || 0)
      if (result.ok) {
        if (isStreamResponse(result)) {
          streamStarted = true
          // 流式：成败延后到流结束统一判定（streamRelay 内 relay，返回流结局）。
          // 不能在响应头阶段 markOk——头 2xx 不代表流能走完，故障上游「头 2xx + 流中断」若在此刻被洗白，
          // 熔断计数永远攒不齐，后续请求被亲和钉在故障主上游，「切备用/切下一模型」形同虚设。
          const reconnector = async () => {
            const again = await forward(prov, turl, req.method, headers, tbuf, cfg.defaults || {}, log, { budget, signal: budgetSignal })
            if (!again.ok) throw new Error('reconnect status ' + again.status)
            return again.stream
          }
          if (typeof streamRelay !== 'function') {
            // 兼容兜底：未注入 relay（异常路径）按旧行为直接交付，由调用方处理
            return { kind: 'stream', res: result, pid, modelName, serving, api, reconnect: reconnector, dialogueId, chain: chainModels.join('>') }
          }
          const relay = await streamRelay(result, {
            pid, modelName, serving: serving || modelName, api, dialogueId, reconnect: reconnector,
            rewriteModel: (body && body.model) || null, chain: chainModels.join('>'),
          })
          const sm = serving || modelName
          const h = ensureHst(state, pid)
          if (relay && relay.clientGone) {
            // 客户端断开/写停滞：不是上游失败——不计中断、不计错误、不动熔断/streamDrops，也不再切上游
            log && log.info('sse 客户端已断开/停止消费，结束该请求', 'model=' + sm, 'provider=' + pid)
            return { kind: 'aborted' }
          }
          if (relay && relay.timedOut && !relay.completed) {
            // 整体预算在流式阶段耗尽：不再续传/切上游，以流内错误事件收尾（客户端可感知）
            log && log.warn('请求超出整体预算（流式阶段）', 'model=' + sm, 'provider=' + pid, 'overallMs=' + overallMsCfg)
            return { kind: 'stream-interrupted', pid, modelName, serving, api, dialogueId, timeout: true, chain: chainModels.join('>'), note: '请求超出整体预算 ' + overallMsCfg + 'ms（defaults.timeout.overallMs）', reconnects: relay.reconnects || 0 }
          }
          if (relay.completed) {
            // 流完整结束（含续传成功）：正常计成功
            h.streamDrops = 0
            markOk(state, pid)
            noteAffinity(state, sm, pid)
            return { kind: 'stream-done', pid, modelName, serving, api, dialogueId, chain: chainModels.join('>') }
          }
          // 流中断：计入中断 + 错误统计 + 连续中断计数
          state.st.counters.interrupts += 1; state.stats.global.interrupts += 1
          agg(state, pid, 'errors', 1); state.st.counters.errors += 1
          const sg = state.stats.byModel[sm] = state.stats.byModel[sm] || { requests: 0, errors: 0 }
          sg.errors = (sg.errors || 0) + 1
          h.streamDrops = (h.streamDrops || 0) + 1
          h.streamDropAt = Date.now() // 冷却计时起点：配合 half-open 让上游有机会自证恢复
          markFail(state, pid, prov.circuit) // 走到这里说明是上游侧中断（clientGone 已在上方提前返回）
          const _note = '断流续传' + (relay.reconnects || 0) + '次仍失败，结束'
          if (relay.contentSent && (cfg.defaults && cfg.defaults.streamInterruptOnContent) !== true) {
            // 正式回答（content）已回传后中断且未开「中断也切」：重发会让客户端收到「半截旧回答 + 新回答」拼接——发错误事件收尾（客户端可干净重试）
            if (relay.finish) relay.finish(_note)
            return { kind: 'stream-interrupted', pid, modelName, serving, api, dialogueId, chain: chainModels.join('>') }
          }
          // 未回传内容（「头 2xx + 立刻断流」= 假成功）或已回传但 streamInterruptOnContent=true（用户接受拼接重复）：
          // 均视为该上游失败，继续模型链（下一 provider / 下一模型）——客户端连接保持，下一上游的流继续写同一连接
          log && log.warn('sse 流中断(续传' + (relay.reconnects || 0) + '次仍失败)' + (relay.contentSent ? '，已回传内容按策略切换' : '，未回传内容切下一上游'), 'model=' + sm + ' provider=' + pid, 'chain=' + chainModels.join('>'))
          continue
        }
        markOk(state, pid)
        ensureHst(state, pid).streamDrops = 0 // 非流式请求完整成功同样代表上游健康：解除连续断流绕开
        noteAffinity(state, serving || route.model, pid) // 非流式响应已完整收到：记录本次成功上游，供后续请求保持亲和、复用其缓存
        let out = await collectBody(result.stream, undefined, { budget, signal: budgetSignal, destroyOnAbort: true })
        out = maybeGunzip(out, result.headers && result.headers['content-encoding'])
        const parsed = tryParse(out)
        const usage = parsed && parsed.usage
        if (usage) {
          // usage 字段归一化：此处拿到的是**上游原始响应**（非 openai 协议的转换在下面才做），
          // 字段名随协议而异 —— Anthropic 用 input_tokens / output_tokens（**没有** total_tokens），
          // Gemini 用 usageMetadata.promptTokenCount / candidatesTokenCount。
          // 不归一化则 token 记账全部落到 `usage.total_tokens || 0` = 0：
          // 表现是面板与托盘的 token 数纹丝不动、只有 requests 在涨（2026-09-17 union-alpha 实测）。
          // 注意 cacheHitMiss 仍要吃**原始** usage（它内部按协议取缓存字段），故原始对象不动、只改取数。
          const _n = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0) ? v : 0
          const _um = usage.usageMetadata || {}
          const _in = _n(usage.prompt_tokens) || _n(usage.input_tokens) || _n(_um.promptTokenCount)
          const _out = _n(usage.completion_tokens) || _n(usage.output_tokens) || _n(_um.candidatesTokenCount)
          const _tot = _n(usage.total_tokens) || _n(_um.totalTokenCount) || (_in + _out)
          const c = cacheHitMiss(api, usage)
          const hit = c.hit, miss = c.miss
          noteCacheStat(state, serving || modelName, pid, hit, miss) // 按(模型,上游)记录缓存命中，供命中率路由与趋势告警使用
          agg(state, pid, 'tokens', _tot); state.stats.global.tokens += _tot
          // 按"实际响应的模型"累计其额度用量（日额度 + 累计额度）；输入/输出单独记（命中+未命中=输入）
          const sg = state.stats.byModel[serving || modelName] = state.stats.byModel[serving || modelName] || { requests: 0, errors: 0 }
          sg.tokens = (sg.tokens || 0) + _tot
          sg.inTokens = (sg.inTokens || 0) + _in
          sg.outTokens = (sg.outTokens || 0) + _out
          tallyDaily(state, serving || modelName, _tot, hit, miss, _in, _out)
          tallyVirtual(state, modelName, serving, _tot, _in, _out)
          tallyDialogue(state, dialogueId, _tot, hit, miss)
        }
        if (api !== 'openai') { const p = tryParse(out); if (p) { let nb; try { nb = Buffer.from(JSON.stringify(adapterFor(api).fromUpstream(p))) } catch { nb = null } if (nb) out = nb } }
        // 「名字没对上」加固：跨模型兜底改写请求 model 后，响应 model 回写为客户端请求名，避免客户端续写/统计错位
        if (body && body.model && servingName && servingName !== body.model) {
          const p2 = tryParse(out)
          if (p2 && p2.model) { p2.model = body.model; out = Buffer.from(JSON.stringify(p2)) }
        }
        return { kind: 'json', status: result.status, contentType: 'application/json', body: out, pid, modelName, serving, asSSE: degraded || undefined, dialogueId, chain: chainModels.join('>') }
      }
      // 非重试错误码（4xx）：业务问题，不熔断、不 fallback，直接返回；
      // 例外：403/404 属「模型/资源级拒绝」（如上游对该模型无权限/不存在），换下一模型可能成功，记录后继续尝试而非中断
      markOk(state, pid)
      // 3xx 重定向对 Chat 端点属于异常：不跟随、不裸透传，明确转 502，避免客户端误跟随或解析错乱
      if (result.status >= 300 && result.status < 400) {
        // 流已开始：写不了 502 头，按上游失败继续链（不改 rejectedOnly——3xx/4xx 是确定性拒绝，重发同一请求无意义，轮末即收尾）
        if (streamStarted) { lastErr = Object.assign(new Error('upstream redirect ' + result.status), { status: result.status }); continue }
        return { kind: 'json', status: 502, contentType: 'application/json', body: Buffer.from(JSON.stringify({ error: { message: 'upstream returned unexpected redirect (' + result.status + ')', type: 'upstream_error', status: result.status } })), pid, modelName, chain: chainModels.join('>') }
      }
      const out = await collectBody(result.stream, undefined, { budget, signal: budgetSignal, destroyOnAbort: true })
      // 流已开始（响应头/部分内容已发给客户端）后，json 状态码再也写不回去：按上游失败继续切下一上游，
      // 全链失败时由收尾逻辑以流内错误事件结束。此前此处直接 return json，index.js 二次 writeHead
      // 抛 "Cannot write headers after they are sent"，客户端只拿到没有 [DONE] 的半截流。
      if (streamStarted) {
        // 不置 rejectedOnly=false：4xx 是确定性拒绝，链走完一轮即可收尾，不必重复空转到 loopMs
        lastErr = Object.assign(new Error('upstream ' + result.status + ' ' + (serving || '')), { status: result.status })
        agg(state, pid, 'errors', 1); state.st.counters.errors += 1; bm.errors += 1
        log && log.warn('流已开始后上游返回 ' + result.status + '，按断流继续切下一上游', 'provider=' + pid, 'model=' + (serving || '-'))
        continue
      }
      if (isUpstreamSideFailure(result.status, out)) {
        // 上游侧故障（4xx 但语义是「我/我的下游出错了」，见 isUpstreamSideFailure 注释）：
        // 计为**真·失败**（进熔断计数——反复这么报的上游该被冷却，而不是每笔请求都白撞一次），
        // 保留原始响应供整链全败时回显真实错误，继续目录链下一上游/模型。
        // 不改 rejectedOnly：一轮走完即收尾，不必空转到 loopMs（与 403/404 的取舍一致）。
        last4xx = { status: result.status, body: mapErrorEnvelope(api, result.status, out) || out }
        last4xxPid = pid
        lastErr = Object.assign(new Error('upstream-side ' + result.status + ' ' + (serving || '')), { status: result.status })
        agg(state, pid, 'errors', 1); state.st.counters.errors += 1; bm.errors += 1
        markFail(state, pid, prov.circuit)
        log && log.warn('上游侧故障(4xx 语义为上游出错)', 'provider=' + pid, 'status ' + result.status, '-> next provider/model', out.length ? 'body=' + out.toString('utf8', 0, 300).replace(/\n/g, ' ') : '')
        continue
      }
      if (isModelLevelRejection(result.status, out)) {
        // 模型级拒绝（403/404，或 400 且响应体含「模型/上游不可用」语义）：
        // 记入错误统计（不熔断），保留原始响应供整链全拒时回显，继续尝试下一模型。
        // 注：opencodego 等上游对「模型不可用」也返回 400（Provider rejected / Model not supported），
        // 若按普通 4xx 直接返回，jiyuan 故障期间目录链会在 opencodego 处断掉，客户端只拿到 400 而非自动切到 MiniMax 等后续模型。
        last4xx = { status: result.status, body: mapErrorEnvelope(api, result.status, out) || out }
        last4xxPid = pid
        lastErr = Object.assign(new Error('upstream ' + result.status + ' ' + (serving || '')), { status: result.status })
        agg(state, pid, 'errors', 1); state.st.counters.errors += 1; bm.errors += 1
        log && log.warn('provider rejected (model-level)', pid, 'status ' + result.status, '-> next model', out && out.length ? 'body=' + out.toString('utf8', 0, 300).replace(/\n/g, ' ') : '')
        continue
      }
      if (out.length) {
        // 其余 4xx（真·参数/请求错误）：直接返回保留原始错误，不再尝试下一模型（换模型同样会失败）
        log && log.warn('upstream ' + result.status, 'provider=' + pid, 'model=' + (serving || '-'), 'body=' + out.toString('utf8', 0, 300).replace(/\n/g, ' '))
        // 非 OpenAI 上游的原生错误信封 → OpenAI 形状回给客户端（状态码与原始 body 保留在日志里）
        return { kind: 'json', status: result.status, contentType: 'application/json; charset=utf-8', body: mapErrorEnvelope(api, result.status, out) || out, pid, modelName, chain: chainModels.join('>') }
      }
      return { kind: 'json', status: result.status || 502, contentType: 'application/json', body: Buffer.from(JSON.stringify({ error: { message: 'gateway upstream error', type: 'upstream_error', status: result.status } })), pid, modelName }
    } catch (err) {
      // 预算耗尽/客户端取消：不是上游故障——不记错误、不熔断、不重试，直接结束模型链
      if (err && err.aborted) {
        lastErr = err
        refundQps()
        log && log.warn('request aborted', err.reason || err.message, 'model=' + (serving || '-'), 'provider=' + pid, '-> stop chain')
        break outer
      }
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
      rejectedOnly = false // 网络错/5xx/429：可重试类失败，允许回到队首循环
      log && log.warn('provider failed', pid, err.message, '-> next fallback')
    } finally {
      release()
    }
    } // for pid
  } // for route
  if (!cycleTried || rejectedOnly) break // 无上游被尝试，或整轮只有 403/404 模型级拒绝（确定性失败）：再循环无意义，直接收尾
  try { await sleepWith(300, budgetSignal) } catch (e) { if (!(e && e.aborted)) throw e; lastErr = e; refundQps(); break }      // 一轮全败后回到队首前稍停；取消时立即退出
  } // while() 有界循环兜底：整条链(a→b→c)失败后回到 a 继续，直到成功 / 业务4xx / 整体超时 / 全部熔断
  // 预算耗尽/客户端取消优先于其他收尾：不把取消伪装成上游 502
  if ((lastErr && lastErr.aborted) || (budget && budget.expired())) {
    refundQps()
    if (budget && budget.reason === 'client_closed') return { kind: 'aborted' }
    if (streamStarted) return { kind: 'stream-interrupted', pid: null, modelName, timeout: true, chain: chainModels.join('>'), note: '请求超出整体预算 ' + overallMsCfg + 'ms（defaults.timeout.overallMs）', reconnects: 0 }
    return abortedResult()
  }
  // 整条链都是 403/404 模型级拒绝：回最后一个上游原始响应（比 502 更有信息量）
  if (last4xx && !streamStarted) return { kind: 'json', status: last4xx.status, contentType: 'application/json; charset=utf-8', body: last4xx.body, pid: last4xxPid, modelName, chain: chainModels.join('>') }
  if (!tried) return { kind: 'json', status: 502, contentType: 'application/json', chain: chainModels.join('>'), body: Buffer.from(JSON.stringify({ error: { message: lastErr ? lastErr.message : 'no usable provider (无可用上游：可能未配 Key 或全部熔断)', type: 'no_provider' } })) }
  // 流已开始（响应头已发）后的全链失败：不能再写 json 状态码，以流内错误事件收尾（index.js 对 stream-interrupted 兜底收尾）
  if (streamStarted) return { kind: 'stream-interrupted', pid: last4xxPid, modelName, chain: chainModels.join('>'), note: lastErr && lastErr.message ? (lastErr.message + '（已循环兜底约 ' + Math.max(1, Math.round(loopMs / 1000)) + 's）') : 'all providers failed（已循环兜底约 ' + Math.max(1, Math.round(loopMs / 1000)) + 's）', reconnects: 0 }
  return { kind: 'json', status: 502, contentType: 'application/json', chain: chainModels.join('>'), body: Buffer.from(JSON.stringify({ error: { message: lastErr && lastErr.message ? (lastErr.message + '（已循环兜底约 ' + Math.max(1, Math.round(loopMs / 1000)) + 's）') : 'all providers failed（已循环兜底约 ' + Math.max(1, Math.round(loopMs / 1000)) + 's）', type: 'all_providers_failed' } })) }
  } finally {
    if (releaseModel) releaseModel()
  }
}
