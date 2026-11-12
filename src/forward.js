// 转发链模块（Phase1 TD3 自 index.js 拆分）：routes 构建 + 三层重试 + 循环兜底 + 限流/记账协作
// 共享辅助（健康/统计/工具）由 index.js 经 deps 注入，避免双向依赖
import { gunzipSync } from 'node:zlib'
import { Readable } from 'node:stream'
import { randomUUID, createHash } from 'node:crypto'
import { adapterFor, cacheHitMiss, hasTools, mapErrorEnvelope } from './format.js'
import { buildProvider, modelTarget } from './router.js'
import { isStreamResponse } from './sse.js'
import { forwardOnce, execute, makeAdapter, upstreamUrl } from './request.js'
import { createDeadline } from './deadline.js'
import { abortedError, sleepWith } from './budget.js'
import { todayKey } from './shared.js'
import { isToolBearingBody, retryAfterHeader, attributionCode, retryWaitFits } from './retry-policy.js'
import { classifyTarget, isAggregateModelId } from './codex/identity.js'
import { planTargetHeaders, applyExtraHeaders, targetDeny, officialPassthroughEnabled } from './codex/auth.js'
import { detectOpaqueV2Task } from './codex/interop.js'
import { decide, advancePhase, PHASE, ACTION, STOP } from './routing/decision.js'
import { openLedger } from './routing/ledger.js'
import * as facts from './routing/facts.js'
import {
  authorizeFinalTarget, assertSendTarget, isTargetAuthzError,
  TARGET_DOMAINS, REDIRECT_POLICY,
} from './codex/target-authz.js'
import { generationAuthzBinding } from './codex/catalog-generation.js'

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

// 转发头（E1 身份域防火墙）：先按目标身份域决定哪些客户端头可以过（官方白名单 / 第三方剥离官方专用集），
// 再由网关注入自有鉴权，最后合并 extraHeaders（凭据类禁止覆盖）。判定与清单集中在 codex/auth.js。
// 兼容说明：旧的 STRIP_IN 语义（客户端授权/内部头不外流）保留在自身白名单里，行为只收紧不放宽。
export function buildHeaders(req, provider, bodyBuf, cfg, api, body, ctx) {
  const identity = (ctx && ctx.identity) || classifyTarget(provider, cfg)
  // 官方目标无自有 key 时只能走「客户端官方凭据透传」，该路径默认关闭，由 auth.js 的统一开关控制。
  const passthrough = identity.credential === 'client-passthrough' && officialPassthroughEnabled()
  // 帧层/连接层头先剔除，避免 connection 列出的自定义头继续外流（与旧 connectionHeaders 行为等价）。
  const connectionHeaders = new Set(String(req.headers.connection || '').toLowerCase().split(',').map(v => v.trim()).filter(Boolean))
  const incoming = {}
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase()
    if (HOP_BY_HOP.has(lk) || STRIP_IN.has(lk) || connectionHeaders.has(lk)) continue
    incoming[k] = v
  }
  // 凭据类头单独取：STRIP_IN 已把客户端 authorization 从 incoming 剔掉，官方透传路径需要原值，
  // 因此显式保留一份，仅当 passthrough（官方目标 + 无自有 key + 开关开启）时放回。
  const clientCredential = {}
  for (const name of ['authorization', 'chatgpt-account-id']) {
    const v = req.headers[name]
    if (v !== undefined && !connectionHeaders.has(name)) clientCredential[name] = v
  }
  const plan = planTargetHeaders({ identity, provider, cfg, incoming, passthrough })
  const headers = plan.headers
  if (passthrough) for (const [k, v] of Object.entries(clientCredential)) headers[k] = v
  headers['user-agent'] = 'model-gateway/0.1'
  if (!headers['accept']) headers['accept'] = 'application/json'
  headers['accept-encoding'] = 'identity' // 请求上游返回明文，避免 gzip 导致响应体解析失败
  // 自有 key 优先；客户端凭据透传路径不得被网关 key 覆盖（两条路互斥）。
  if (provider.apiKey && identity.credential !== 'client-passthrough') headers['authorization'] = 'Bearer ' + provider.apiKey
  const extra = Object.assign({}, (cfg.defaults || {}).extraHeaders, provider.extraHeaders)
  const extraPlan = applyExtraHeaders(headers, extra)
  if (ctx && ctx.log) {
    if (extraPlan.blocked.length) ctx.log.warn('extraHeaders 鉴权头/帧层头已拦截（仅记头名）', 'provider=' + provider.id, extraPlan.blocked.join(','))
    if (plan.dropped.length) ctx.log.info('upstream 头策略丢弃', 'provider=' + provider.id, 'identity=' + identity.kind, plan.dropped.join(','))
  }
  if (provider.id === 'opencodego') {
    const first = (v) => Array.isArray(v) ? v[0] : v
    // OpenCode Go 强制要求 x-opencode-session（缺失直接 400 MissingSessionID）。Codex 0.167 发的是
    // session-id / thread-id（官方头，转发前已被剥掉），因此这里只**派生**一个会话标识：
    // 优先客户端显式头，其次 Codex 的 session-id/thread-id 值，最后给一次性随机 id（不再发裸请求）。
    const session = first(req.headers['x-opencode-session']) || first(req.headers['x-session-id']) || first(req.headers['x-conversation-id']) ||
      first(req.headers['session-id']) || first(req.headers['thread-id']) ||
      (body && (body.session_id || body.conversation_id)) || headers['x-opencode-session'] || headers['x-session-id']
    headers['x-opencode-session'] = (session != null && String(session).trim()) ? String(session) : ('mg-' + randomUUID())
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
// 429 上游冷却上限：Retry-After 再长也只冷却这么久，避免一个上游被永久钉死（到期后正常半开放行）
const MAX_429_COOLDOWN_MS = 60000

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


// ===== E5：Codex 聚合路径的智能 Fallback（决策器接入） =====
// 只在 Codex 聚合目标上启用：def.codexAggregate / def.codexOfficial（router.js 目录解析）、
// defaults.codexFallback===true、或聚合保留前缀（isAggregateModelId）。其它请求继续走原有
// forwardChain 逻辑，行为逐字节不变。决策/阶段语义见 src/routing/decision.js 与
// docs/explanation/fallback-decision.md。
//
// 接入约定（与 E5 决策器分工）：
//   · 同上游重试由决策器 retry_same 控制（Codex 模式给 forward() 传 noRetry，避免双重重试）；
//   · 换模型/上游由决策器 failover 控制，且只允许已授权第三方候选；官方目标只在“用户直接选择的
//     官方主目标”上使用，永不作为 failover 目标（D7）；
//   · 阶段由本模块推进（首字节/工具出现/交付/取消），出现工具或托管副作用、已交付流、部分提交、
//     取消、v2 不可读时立即 stop_with_error，不重放；
//   · 日志只落决策字段（模型/供应商/错误类/阶段/动作/预算），不含令牌与请求正文。
const CODEX_FALLBACK_LIMIT_DEFAULTS = Object.freeze({ maxSameProviderAttempts: 1, maxFailovers: 2, maxTotalAttempts: 3, maxWaitMs: 30000 })

function codexFallbackEnabled(cfg, def, requested, canonical) {
  if (def && (def.codexAggregate === true || def.codexOfficial === true)) return true
  if (cfg && cfg.defaults && cfg.defaults.codexFallback === true) return true
  return isAggregateModelId(canonical || requested || '', cfg)
}

function codexLimitsOf(cfg) {
  const raw = (cfg.defaults && cfg.defaults.codexFallbackLimits) || {}
  const n = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.trunc(Number(v)) : d)
  return {
    maxSameProviderAttempts: n(raw.maxSameProviderAttempts, CODEX_FALLBACK_LIMIT_DEFAULTS.maxSameProviderAttempts),
    maxFailovers: n(raw.maxFailovers, CODEX_FALLBACK_LIMIT_DEFAULTS.maxFailovers),
    maxTotalAttempts: n(raw.maxTotalAttempts, CODEX_FALLBACK_LIMIT_DEFAULTS.maxTotalAttempts),
    maxWaitMs: Number.isFinite(Number(raw.maxWaitMs)) && Number(raw.maxWaitMs) > 0 ? Number(raw.maxWaitMs) : CODEX_FALLBACK_LIMIT_DEFAULTS.maxWaitMs,
  }
}

// 预算：只认用户显式配置的上限；spent.requestUsd 由本请求累计的估算费用提供
// （task/daily 维度未接费用账本，保持 0；文档标注）。
// N02 接线（C）：billingPolicy 是配置意图，必须同时覆盖「无账本」与「有账本」两条预算来源，
// 否则配了 'allow_unmetered' 在接入账本后会静默失效（用户只能改代码才能紧急放行）。
// 缺省/空值**不写字段** → 由 decision.js 使用自己的 fail-closed 默认
// （未配费用上限且未接账本 → 发送前拒绝 billing_unmetered、零上游）。
function billingPolicyOf(cfg) {
  const raw = (cfg.defaults && cfg.defaults.codexBudget) || {}
  const v = typeof raw.billingPolicy === 'string' ? raw.billingPolicy.trim() : ''
  return v || null
}
function withBillingPolicy(budget, policy) {
  if (!budget || !policy) return budget
  return Object.assign({}, budget, { billingPolicy: policy })
}
function codexBudgetOf(cfg, spentUsd) {
  const raw = (cfg.defaults && cfg.defaults.codexBudget) || {}
  const lim = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0)
  return withBillingPolicy({
    limits: { requestUsd: lim(raw.requestUsd), taskUsd: lim(raw.taskUsd), dailyUsd: lim(raw.dailyUsd) },
    spent: { requestUsd: Math.max(0, Number(spentUsd) || 0), taskUsd: 0, dailyUsd: 0 },
    enforceUnknownCost: raw.enforceUnknownCost === true,
  }, billingPolicyOf(cfg))
}

// 测试接缝（N02 接线证据）：预算对象构造是纯函数，导出给回归断言 billingPolicy 透传；
// 生产路径仍只经 codexBudgetForDecision 调用，不新增行为。
export function __codexBudgetOfForTest(cfg, spentUsd) { return codexBudgetOf(cfg, spentUsd) }

// 单次费用估算：models.<m>.costEstimateUsd > providers.<p>.costEstimateUsd；都未配置 = 未知。
function codexEstimateFor(cfg) {
  return (model, pid) => {
    const m = cfg.models && model ? cfg.models[model] : null
    const p = cfg.providers && pid ? cfg.providers[pid] : null
    for (const v of [m && m.costEstimateUsd, p && p.costEstimateUsd]) {
      const n = Number(v)
      if (Number.isFinite(n) && n >= 0) return n
    }
    return undefined
  }
}

// D7 手动应急：用户显式写 defaults.codexEmergency=true 或 {acknowledged:true} 才算确认。
function codexEmergencyOf(cfg) {
  const raw = cfg && cfg.defaults ? cfg.defaults.codexEmergency : null
  if (raw === true) return { acknowledged: true }
  if (raw && typeof raw === 'object' && raw.acknowledged === true) return { acknowledged: true }
  return null
}

// 从请求提取决策所需的能力/工具/可读性事实。宿主托管工具按“可能已产生副作用”处理。
function codexRequestInfoOf(body) {
  const tools = Array.isArray(body && body.tools) ? body.tools : []
  const types = []
  const hosted = []
  for (const t of tools) {
    const ty = String((t && t.type) || '')
    if (ty === 'function' || ty === 'custom' || ty === 'local_shell') { if (!types.includes(ty)) types.push(ty) }
    else if (ty) { if (!hosted.includes(ty)) hosted.push(ty) }
  }
  const input = Array.isArray(body && body.input) ? body.input : []
  for (const it of input) {
    const ty = String((it && it.type) || '')
    if (/function_call|custom_tool_call/.test(ty) && !types.includes('function')) types.push('function')
  }
  const v2 = detectOpaqueV2Task(body)
  return {
    capability: 'chat',
    promptTokens: estPromptTokens(body),
    modalities: [],
    tools: types,
    hostedTools: hosted,
    requiresV2TaskRead: v2.opaque === true,
    sideEffectRisk: hosted.length ? 'possible' : 'none',
    streaming: body && body.stream === true,
  }
}

// 候选能力只来自配置/目录声明，绝不复制请求 tools（审计 P1 / T-ROUTE-01）。
// 未声明 capabilities ⇒ 工具能力为空（请求带工具时该候选不可入选），而不是"请求需要什么就支持什么"。
function codexCapabilitiesOf(cfg, model) {
  const md = cfg.models && model ? cfg.models[model] : null
  const codex = md && md.codex && typeof md.codex === 'object' ? md.codex : {}
  const declared = codex.capabilities && typeof codex.capabilities === 'object' ? codex.capabilities : null
  const contextWindow = Number((md && md.maxContext) || codex.contextWindow || 0) || 0
  const modalities = Array.isArray(codex.modalities) ? codex.modalities.map(String) : []
  return {
    capability: (md && md.capability) || 'chat',
    contextWindow,
    modalities,
    tools: { types: declared ? ['function', 'custom'] : [], hosted: [] },
    readability: { plaintext: true, v2Encrypted: false },
  }
}

function codexCandidateFor(cfg, model, pid, now, primary) {
  const built = buildProvider(cfg, pid)
  const identity = classifyTarget(built, cfg)
  const official = identity.kind === 'official'
  const md = cfg.models && model ? cfg.models[model] : null
  const keyMissing = !!(built._def && built._def.apiKeyEnv && !built.keyOk)
  const bag = {
    authorization: facts.evidence(!official && !keyMissing, { source: facts.FACT_SOURCE.CONFIG, observedAt: now }),
    identity: facts.evidence({
      kind: official ? 'official_subscription' : 'third_party',
      name: model || '',
      scope: primary ? 'primary' : 'fallback',
    }, { source: facts.FACT_SOURCE.CONFIG, observedAt: now }),
    capabilities: facts.evidence(codexCapabilitiesOf(cfg, model), {
      source: md && md.codex ? facts.FACT_SOURCE.CATALOG : facts.FACT_SOURCE.CONFIG,
      observedAt: now,
    }),
  }
  let price = null
  for (const v of [md && md.costEstimateUsd, cfg.providers && cfg.providers[pid] && cfg.providers[pid].costEstimateUsd]) {
    const n = Number(v)
    if (Number.isFinite(n) && n >= 0) { price = n; break }
  }
  if (price != null) bag.pricing = facts.evidence({ usd: price, worstCaseUsd: price, paid: price > 0 }, { source: facts.FACT_SOURCE.CONFIG, observedAt: now })
  const cand = facts.candidate({ model, provider: pid, facts: bag, scope: primary ? 'primary' : 'fallback' })
  // 决策器仍用 providerKind 判定"官方额度耗尽走手动应急"（D7），证据模式候选补上同一事实。
  cand.providerKind = official ? 'official_subscription' : 'third_party'
  cand.authorized = !official && !keyMissing
  return cand
}

function codexBuildCandidates(cfg, routes, now) {
  const out = []
  for (let ri = 0; ri < routes.length; ri++) {
    const route = routes[ri]
    const provs = Array.isArray(route.providers) ? route.providers : []
    for (let pi = 0; pi < provs.length; pi++) {
      const pid = provs[pi]
      if (!pid || !cfg.providers[pid]) continue
      out.push(codexCandidateFor(cfg, route.model, pid, now, ri === 0 && pi === 0))
    }
  }
  return out
}

// 只扫描工具类事件名（不解析正文、不落日志），用于把“流里出现过 tool_call”标成副作用阶段。
const CODEX_TOOL_EVENT_RE = /"(tool_calls|function_call|custom_tool_call|local_shell_call|web_search_call|computer_call|file_search_call|code_interpreter_call|mcp_call)"/
// 仅 Codex 聚合路径使用的流包装：透传每个 chunk，顺带探测工具事件；不影响背压/销毁语义。
function codexTapStream(stream, onTool) {
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') return stream
  const wrapper = {
    statusCode: stream.statusCode,
    headers: stream.headers,
    on(ev, fn) { if (typeof stream.on === 'function') stream.on(ev, fn); return wrapper },
    once(ev, fn) { if (typeof stream.once === 'function') stream.once(ev, fn); return wrapper },
    removeListener(ev, fn) { if (typeof stream.removeListener === 'function') stream.removeListener(ev, fn); return wrapper },
    destroy(...args) { try { stream.destroy && stream.destroy(...args) } catch {} },
    get destroyed() { return !!stream.destroyed },
    async *[Symbol.asyncIterator]() {
      for await (const chunk of stream) {
        try { if (CODEX_TOOL_EVENT_RE.test(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))) onTool() } catch {}
        yield chunk
      }
    },
  }
  return wrapper
}

// 决策错误到 HTTP 状态：保留上游可执行语义，未知一律 502。
function codexStopStatus(code, upstreamStatus) {
  const c = String(code || '')
  if (c === 'MG_FB_RATE_LIMITED') return 429
  if (c === 'MG_FB_BUDGET' || c === 'MG_FB_QUOTA' || c === 'MG_FB_OFFICIAL_QUOTA') return 402
  if (c === 'MG_FB_TASK_UNREADABLE') return 422
  if (c === 'MG_FB_TIMEOUT') return 504
  if (c === 'MG_FB_SIDE_EFFECT_REPLAY_BLOCKED' || c === 'MG_FB_STREAM_DELIVERED' || c === 'MG_FB_PARTIAL_COMMIT') return 409
  if (c === 'MG_FB_BAD_REQUEST') return Number.isFinite(upstreamStatus) ? upstreamStatus : 400
  if (c === 'MG_FB_AUTH') return Number.isFinite(upstreamStatus) ? upstreamStatus : 403
  if (c === 'MG_FB_MODEL_UNAVAILABLE') return Number.isFinite(upstreamStatus) ? upstreamStatus : 404
  return 502
}

// ============================================================================
// M1-3a：生产发送层
//   授权（authorizeFinalTarget + assertSendTarget，官方 fail-closed）
//   → 持久预留（ledger.reserve，只有 duplicate===false 才发）
//   → execute/forwardOnce（同一单调 deadline，单次发送，写前置位 onWriteBegin）
//   → 账本收尾（settle/release/markUnknown）
// 任何在写开始之后的异常都不得重放；调用方只会在 REJECTED_BEFORE_EXECUTION / UNSENT 上继续下一跳。
// ============================================================================

const LEDGER_CACHE = new Map()
let LEDGER_DIAGNOSTIC = null

function ledgerSpecOf(cfg, opts) {
  const injected = opts && opts.ledgerOptions
  const lc = injected || (cfg && cfg.routing && cfg.routing.ledger)
  if (!lc || typeof lc !== 'object' || !lc.dir) return null
  return {
    dir: String(lc.dir),
    currency: lc.currency ? String(lc.currency) : 'USD',
    dayZone: lc.dayZone ? String(lc.dayZone) : 'Asia/Shanghai',
    caps: lc.caps && typeof lc.caps === 'object' ? lc.caps : {},
    quoteMaxAgeMs: Number(lc.quoteMaxAgeMs) > 0 ? Number(lc.quoteMaxAgeMs) : 0,
  }
}

function openLedgerFor(cfg, opts, log) {
  if (opts && opts.ledger) return opts.ledger
  const spec = ledgerSpecOf(cfg, opts)
  if (!spec) return null
  const key = JSON.stringify(spec)
  const hit = LEDGER_CACHE.get(key)
  if (hit) return hit
  const ledger = openLedger(Object.assign({}, spec, opts && Number.isFinite(Number(opts.now)) ? { now: () => Number(opts.now) } : {}))
  const recovered = ledger.recover()
  LEDGER_DIAGNOSTIC = {
    dir: spec.dir,
    recovered: recovered.recovered,
    inflightMicro: recovered.inflightMicro,
    unknownMicro: recovered.unknownMicro,
    inflight: recovered.inflight.length,
    unknown: recovered.unknown.length,
  }
  log && log.info('ledger recovered', 'dir=' + spec.dir, 'inflight=' + recovered.inflight.length, 'unknown=' + recovered.unknown.length, 'inflightMicro=' + recovered.inflightMicro, 'unknownMicro=' + recovered.unknownMicro)
  LEDGER_CACHE.set(key, ledger)
  return ledger
}

/** 启动自检（M1-3b 可在 index 启动时调用）：打开账本并 recover 在途/未知预留。 */
export function initForwardLedger(cfg, opts = {}, log) {
  try { return openLedgerFor(cfg, opts, log) } catch (e) { log && log.warn('ledger init failed', String((e && e.code) || 'error')); return null }
}
export function forwardLedgerDiagnostic() { return LEDGER_DIAGNOSTIC }

function costLimitsOf(cfg) {
  const b = (cfg && cfg.routing && cfg.routing.budget) || {}
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0)
  return { requestUsd: n(b.requestUsd), taskUsd: n(b.taskUsd), dailyUsd: n(b.dailyUsd) }
}

function limitsMicroOf(limits) {
  return {
    requestMicro: facts.microFromUsd(limits.requestUsd),
    taskMicro: facts.microFromUsd(limits.taskUsd),
    dayMicro: facts.microFromUsd(limits.dailyUsd),
  }
}

function typedSendError(code, message, extra = {}) {
  const e = new Error(message)
  e.code = code
  e.type = extra.type || code
  if (extra.status != null) e.status = extra.status
  if (extra.noReplay != null) e.noReplay = extra.noReplay
  if (extra.possiblyCommitted != null) e.possiblyCommitted = extra.possiblyCommitted
  if (extra.receipt) e.receipt = extra.receipt
  if (extra.retryAfter != null) e.retryAfter = extra.retryAfter
  if (extra.attribution) e.attribution = extra.attribution
  if (extra.bodyText != null) e.bodyText = extra.bodyText
  if (extra.deny != null) e.deny = extra.deny
  return e
}

function authzContextOf(opts) {
  const c = (opts && opts.authzContext) || {}
  const record = c.catalogRecord || (opts && opts.catalogRecord) || null
  const generation = c.catalogGeneration != null
    ? c.catalogGeneration
    : (record && record.generation != null ? record.generation : (opts && opts.catalogGeneration != null ? opts.catalogGeneration : null))
  const binding = typeof c.generationAuthzBinding === 'function' ? c.generationAuthzBinding : generationAuthzBinding
  return { record, generation, binding }
}

// 每次实际发送前的最终目标授权：官方没有目录世代 ⇒ fail-closed；第三方无目录记录时用配置声明的
// thirdPartyVerified（generation=unscoped，写入日志/审计），不冒充官方目录证据。
export function authorizeSendTarget({ cfg, provider, pid, path, req, opts, log, catalogScoped }) {
  const identity = classifyTarget(provider, cfg)
  const ac = authzContextOf(opts)
  const official = identity.kind === 'official'
  const domain = official ? TARGET_DOMAINS.OFFICIAL
    : (identity.kind === 'thirdParty' ? TARGET_DOMAINS.THIRD_PARTY : null)
  if (!domain) {
    throw typedSendError('target_identity_unknown', '上游目标身份无法确认，已按 fail-closed 拒绝发送', { status: 403, deny: true })
  }
  // 目录世代只有在"本次请求确实由 Codex 目录解析参与"时才强制；普通配置链（含官方 Chat 直连）
  // 使用可审计的 config-declared 世代，仍然必须产出授权记录并做 assertSendTarget（P0-3 真身）。
  const scoped = catalogScoped === true
  if (scoped && (!ac.record || ac.generation == null)) {
    throw typedSendError('catalog_generation_missing', '目录解析参与但缺少 catalog generation 记录：按 fail-closed 拒绝发送', { status: 403, deny: true })
  }
  let generation
  let binding
  if (ac.record && ac.generation != null) {
    generation = ac.generation
    binding = ac.binding(ac.record, {
      domain, origin: provider.baseUrl, path, pathPrefix: provider.pathPrefix,
      identity, provider, cfg, providerId: pid, modelBinding: {},
    })
  } else {
    generation = 'config-declared'
    binding = {
      generation,
      origin: provider.baseUrl, path, pathPrefix: provider.pathPrefix,
      identity, provider, cfg, providerId: pid, modelBinding: {},
      officialVerified: official, thirdPartyVerified: true,
    }
    log && log.info('send authz generation=config-declared (unscoped)', 'provider=' + pid, 'domain=' + domain)
  }
  // 配置声明官方直连（没有目录世代参与）：凭据模式按"网关自持 key"或"客户端官方凭据透传"处理。
  // target-authz 的订阅模式只允许 /backend-api/codex 入口；Chat 直连的官方白名单头由 buildHeaders
  // 的既有规则承载，但最终目标仍然必须通过 authorizeFinalTarget/assertSendTarget（P0-3 真身）。
  const incoming = req && req.headers ? req.headers : {}
  const incomingAuth = Array.isArray(incoming.authorization) ? incoming.authorization[0] : incoming.authorization
  const configDeclaredOfficial = official && !scoped
  const passthroughToken = configDeclaredOfficial && !provider.apiKey && identity.credential === 'client-passthrough' && typeof incomingAuth === 'string'
    ? incomingAuth.replace(/^Bearer\s+/i, '').trim()
    : ''
  const intent = {
    domain,
    official,
    caller: {
      incoming,
      threadId: opts && opts.threadId,
      sessionHeader: opts && opts.sessionHeader,
      sessionSalt: opts && opts.sessionSalt,
      // 官方凭据透传的调用方身份由目标分类推出，避免把"客户端官方凭据"误判成无凭据。
      officialSubscription: !!(opts && opts.officialSubscription === true) || identity.credential === 'client-passthrough',
      passthroughEnabled: opts && opts.passthroughEnabled != null
        ? opts.passthroughEnabled === true
        : officialPassthroughEnabled(),
      ...(passthroughToken ? { providerKey: passthroughToken, credentialMode: 'provider-key' } : {}),
    },
  }
  const baseAuthz = authorizeFinalTarget(intent, generation, binding)
  // 二次校验：实际拼装出来的 URL 必须与授权记录逐字段一致（scheme/host/port/path/query）。
  assertSendTarget(baseAuthz, upstreamUrl(provider, path))
  return configDeclaredOfficial ? Object.freeze(Object.assign({}, baseAuthz, { configDeclared: true })) : baseAuthz
}

// 授权记录是身份/凭据的单一真源；在它之上只补协议/传输必需头。
// 第三方自有 key 由本层按 provider.apiKey 注入（target-authz 的第三方头集合只承载域派生的会话标识）。
function buildAuthorizedHeaders(req, provider, bodyBuf, cfg, api, body, identity, authz, log) {
  const base = buildHeaders(req, provider, bodyBuf, cfg, api, body, { identity, log })
  if (identity.kind === 'official' && authz && authz.configDeclared === true) {
    // 配置声明官方直连：沿用既有官方头白名单/自有 key 规则（授权记录仍负责目标一致性）。
    const h = Object.assign({}, base)
    h['content-type'] = 'application/json'
    h['content-length'] = bodyBuf ? bodyBuf.length : 0
    h['accept-encoding'] = 'identity'
    return h
  }
  const headers = Object.assign({}, base, authz && authz.headers ? authz.headers : {})
  if (identity.kind !== 'official' && provider.apiKey && !headers.authorization) headers.authorization = 'Bearer ' + provider.apiKey
  if (identity.kind === 'official') {
    // 官方只认授权记录里的凭据方式：清掉 base 可能带出的其它 Authorization，再按记录写回。
    headers.authorization = undefined
    delete headers.authorization
    const auth = authz && authz.headers ? authz.headers.authorization : null
    if (auth) headers.authorization = auth
  }
  headers['content-type'] = 'application/json'
  headers['content-length'] = bodyBuf ? bodyBuf.length : 0
  headers['accept-encoding'] = 'identity'
  return headers
}

// 账本幂等键：同 requestId + 同请求体 + 同目标 ⇒ 同一笔账；换候选是新的 digest（允许 failover），
// 但同候选的重放会被 duplicate 挡住。
function sendIdentityOf(req, opts, bodyBuf, model, pid) {
  const header = (name) => {
    const v = req && req.headers ? req.headers[name] : null
    return Array.isArray(v) ? v[0] : v
  }
  const requestId = (opts && opts.requestId) || header('x-request-id') || randomUUID()
  const bodyHash = createHash('sha256').update(bodyBuf || Buffer.alloc(0)).digest('hex')
  const digest = createHash('sha256').update(bodyHash + '|' + String(model || '') + '|' + String(pid || '')).digest('hex')
  const taskRef = (opts && opts.taskRef) || header('x-mg-task') || null
  return { requestId: String(requestId), requestDigest: digest, taskRef: taskRef == null ? null : String(taskRef) }
}

function quoteFor(cfg, model, pid, now, ledger) {
  const md = cfg.models && model ? cfg.models[model] : null
  const pd = cfg.providers && pid ? cfg.providers[pid] : null
  let usd = null
  for (const v of [md && md.costEstimateUsd, pd && pd.costEstimateUsd]) {
    const n = Number(v)
    if (Number.isFinite(n) && n >= 0) { usd = n; break }
  }
  if (usd == null || !Number.isFinite(usd)) return null
  const micro = facts.microFromUsd(usd)
  const version = ('q1:' + String(now)).slice(0, 64)
  return { amountMicro: micro, worstCaseMicro: micro, currency: ledger.currency, version, quotedAt: now }
}

async function reserveAttempt({ cfg, opts, req, bodyBuf, model, pid, ledger, log }) {
  if (!ledger) return null
  const ident = sendIdentityOf(req, opts, bodyBuf, model, pid)
  const now = Number.isFinite(Number(opts && opts.now)) ? Number(opts.now) : Date.now()
  const quote = quoteFor(cfg, model, pid, now, ledger)
  if (!quote) {
    throw typedSendError('quote_unknown', '账本已启用但缺少 pricing 证据：无法报价，拒绝发送', { status: 503 })
  }
  let receipt
  try {
    receipt = await ledger.reserve({
      requestId: ident.requestId,
      requestDigest: ident.requestDigest,
      taskRef: ident.taskRef,
      candidate: { model, provider: pid },
      quote,
    })
  } catch (e) {
    const err = typedSendError(e && e.code ? String(e.code) : 'ledger_reserve_failed', '账本预留失败：拒绝发送（' + String((e && e.code) || 'error') + '）', { status: 402 })
    err.ledger = e
    throw err
  }
  if (receipt && receipt.duplicate === true) {
    throw typedSendError('MG_FB_STOP_RECONCILE', '同一请求已启动过（账本幂等命中）：禁止重放，先对账', {
      status: 409, noReplay: true, possiblyCommitted: true, receipt,
    })
  }
  log && log.info('ledger reserved', 'model=' + (model || '-'), 'provider=' + pid, 'attempt=' + String(receipt.attemptId).slice(0, 12), 'quoteMicro=' + receipt.quoteMicro)
  return receipt
}

async function closeoutLedger(ledger, receipt, action, log) {
  if (!ledger || !receipt) return receipt
  try {
    if (action === 'settled') return await ledger.settle(receipt.attemptId, { actualMicro: receipt.quoteMicro, currency: receipt.currency })
    if (action === 'released') return await ledger.release(receipt.attemptId, { verifiedNotExecuted: true })
    return await ledger.markUnknown(receipt.attemptId)
  } catch (e) {
    // 收尾失败不改变已经发生的上游事实；保留 reserved/unknown 让恢复流程对账。
    log && log.warn('ledger closeout failed', 'attempt=' + String(receipt.attemptId).slice(0, 12), 'code=' + String((e && e.code) || 'error'))
    return receipt
  }
}

// 错误信封/日志兜底：上游错误体可能回显请求内容或 Key，网关不得原样回给客户端/落盘。
const SECRET_TEXT_RE = /\b(?:sk|rk|pk)-[A-Za-z0-9._-]{8,}\b|Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi
function scrubSecretText(text) { return String(text == null ? '' : text).replace(SECRET_TEXT_RE, '****') }
function scrubBody(buf) {
  if (!buf || !buf.length) return buf
  try {
    const s = buf.toString('utf8')
    const t = scrubSecretText(s)
    return t === s ? buf : Buffer.from(t, 'utf8')
  } catch { return buf }
}

const ATTEMPT_TOOL_EVENT_RE = /"(tool_calls|function_call|custom_tool_call|local_shell_call|web_search_call|computer_call|file_search_call|code_interpreter_call|mcp_call)"/

// 包住上游流：首个 data 事件 = DELIVERED，出现工具事件 = TOOL_RISK；不解析正文、不落日志。
function attemptTapStream(stream, attempt, onTool) {
  if (!stream || typeof attempt !== 'object' || !attempt) return stream
  let first = true
  const wrapper = {
    statusCode: stream.statusCode,
    headers: stream.headers,
    on(ev, fn) { if (typeof stream.on === 'function') stream.on(ev, fn); return wrapper },
    once(ev, fn) { if (typeof stream.once === 'function') stream.once(ev, fn); return wrapper },
    removeListener(ev, fn) { if (typeof stream.removeListener === 'function') stream.removeListener(ev, fn); return wrapper },
    destroy(...args) { try { stream.destroy && stream.destroy(...args) } catch {} },
    get destroyed() { return !!stream.destroyed },
    async *[Symbol.asyncIterator]() {
      for await (const chunk of stream) {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        if (first && /^data:\s*\{/.test(text.trimStart())) {
          first = false
          attempt.onFirstSemanticEvent({ source: 'stream' })
        }
        if (ATTEMPT_TOOL_EVENT_RE.test(text)) {
          attempt.onToolIntent({ source: 'stream' })
          if (typeof onTool === 'function') { try { onTool() } catch {} }
        }
        yield chunk
      }
    },
  }
  return wrapper
}

/**
 * 单次实际发送：授权 → 预留 → execute/forwardOnce → 账本收尾。
 * 返回 { result, receipt }，其中 result 兼容既有 forward() 形状：
 *   - 2xx：{ ok,status,headers,stream? , relay? , body? }
 *   - 前置拒绝 4xx（402/404/429/400/...）：{ ok:false,status,headers,stream,bodyText,retryAfter }
 * 写后无头/5xx/断流/工具风险：抛 noReplay typed error，调用方不得再发。
 */
async function authorizedSendOnce(input) {
  const {
    cfg, provider, pid, path, req, method, bodyBuf, opts, log, model,
    streamRelay, streamMeta, api, budget, signal, collectBody, nonIdempotent,
  } = input
  if (budget && typeof budget.expired === 'function' && budget.expired()) {
    throw abortedError((budget && budget.reason) || 'request_timeout', 'request budget exceeded before send')
  }
  const ledger = openLedgerFor(cfg, opts, log)
  const limits = costLimitsOf(cfg)
  if (!ledger && (limits.requestUsd > 0 || limits.taskUsd > 0 || limits.dailyUsd > 0)) {
    throw typedSendError('ledger_required_for_cost_limits', '配置了费用上限但没有账本：拒绝发送（无法强制上限）', { status: 503 })
  }
  // M1-3c：目标形状/授权先于账本预留 —— 非规范配置必须在产生任何 attempt 之前被拒绝。
  const authz = authorizeSendTarget({ cfg, provider, pid, path, req, opts, log, catalogScoped: input.catalogScoped === true })
  const identity = classifyTarget(provider, cfg)
  const headers = buildAuthorizedHeaders(req, provider, bodyBuf, cfg, api, input.body, identity, authz, log)
  const budgetRemaining = budget && typeof budget.remaining === 'function' ? Number(budget.remaining()) : 0
  const deadline = createDeadline({
    // Infinity（无 overallMs）= 不设整体 deadline；不能把 Infinity 传给 setTimeout（会退化成 1ms 立即超时）。
    overallMs: Number.isFinite(budgetRemaining) && budgetRemaining > 0 ? budgetRemaining : 0,
    signal: signal || null,
    now: opts && opts.now,
    timers: opts && opts.timers,
  })
  const receipt = await reserveAttempt({ cfg, opts, req, bodyBuf, model, pid, ledger, log })
  let relayResult = null
  const factory = typeof input.adapterFactory === 'function' ? input.adapterFactory : makeAdapter
  const adapter = factory(async (attempt) => {
    const res = await forwardOnce(provider, path, method, headers, bodyBuf, {
      timeout: (cfg.defaults && cfg.defaults.timeout) || {},
      redirect: REDIRECT_POLICY,
    }, attempt, { deadline, signal: deadline.signal })
    if (streamMeta && typeof streamMeta.onHeaders === 'function') { try { streamMeta.onHeaders(res) } catch {} }
    if (!res.ok) return res
    if (isStreamResponse(res) && typeof streamRelay === 'function') {
      const tapped = attemptTapStream(res.stream, attempt, streamMeta && streamMeta.onTool)
      relayResult = await streamRelay(Object.assign({}, res, { stream: tapped }), Object.assign({}, streamMeta, {
        // 单一 attempt 只发一次：断流不重连（旧 reconnect 会重放整个请求）。
        reconnect: async () => null,
      }))
      return Object.assign({}, res, { stream: null, relay: relayResult })
    }
    if (res.stream && typeof collectBody === 'function') {
      const out = await collectBody(res.stream, undefined, { budget, signal, destroyOnAbort: true })
      return Object.assign({}, res, { stream: null, body: out })
    }
    return res
  })
  let exec
  try {
    exec = await execute({
      deadline,
      signal: deadline.signal,
      target: { model, provider: pid },
      maxAttempts: 1,
      nonIdempotent: !!nonIdempotent,
    }, adapter)
  } catch (e) {
    const closed = await closeoutLedger(ledger, receipt, 'unknown', log)
    const err = e && e.aborted ? e : typedSendError('send_failed', '发送失败：' + String((e && e.message) || 'unknown'), { status: 502, noReplay: true, possiblyCommitted: true, receipt: closed })
    if (err !== e) { err.cause = e }
    err.noReplay = true
    err.possiblyCommitted = true
    err.receipt = closed
    throw err
  } finally { try { deadline.dispose() } catch {} }

  // budget.signal 的 parent abort 在 createDeadline 里只能看到"被取消"；若 budget 明确是超时，
  // 必须还原为 DEADLINE_EXCEEDED（否则会错误地以 499/client_closed 收尾）。
  const outcome = exec.outcome === 'CANCELLED' && budget && typeof budget.timedOut === 'function' && budget.timedOut()
    ? 'DEADLINE_EXCEEDED'
    : exec.outcome
  const attempt = exec.attempts[0] || null
  const sent = !!(attempt && attempt.wroteBody)
  let action = 'unknown'
  if (outcome === 'SUCCEEDED') action = 'settled'
  else if (outcome === 'REJECTED_BEFORE_EXECUTION' || outcome === 'CANCELLED_UNSENT' || outcome === 'FAILED_UNSENT') action = 'released'
  else if (outcome === 'CANCELLED' || outcome === 'DEADLINE_EXCEEDED') action = sent ? 'unknown' : 'released'
  const closed = await closeoutLedger(ledger, receipt, action, log)
  if (closed && closed.status != null) exec.ledgerReceipt = closed

  const fr = exec.result || {}
  if (outcome === 'SUCCEEDED') {
    return {
      receipt: closed,
      authz,
      result: Object.assign({}, fr, {
        ok: true,
        status: fr.status || exec.status,
        headers: fr.headers || null,
        stream: fr.stream || null,
        relay: fr.relay || null,
        streamed: !!fr.relay,
        retries: 0,
      }),
    }
  }
  if (outcome === 'REJECTED_BEFORE_EXECUTION') {
    const bodyBufOut = fr.bodyBuf || Buffer.from(fr.bodyText || '', 'utf8')
    if (Number(fr.status) === 429) {
      // 429 保留状态码 + Retry-After/归因，交回既有 429 收尾路径；账本已按"未执行"release。
      const err = typedSendError('MG_FB_RATE_LIMITED', '上游限流（429）', {
        status: 429,
        retryAfter: fr.retryAfter != null ? fr.retryAfter : (exec.retryAfterMs != null ? exec.retryAfterMs : null),
        attribution: exec.attribution || null,
        bodyText: fr.bodyText || '',
      })
      err.receipt = closed
      err.noReplay = false
      throw err
    }
    const stream = Readable.from(bodyBufOut && bodyBufOut.length ? [bodyBufOut] : [])
    return {
      receipt: closed,
      authz,
      result: {
        ok: false,
        status: fr.status || exec.status,
        headers: fr.headers || null,
        stream,
        bodyText: fr.bodyText || '',
        retryAfter: fr.retryAfter != null ? fr.retryAfter : (exec.retryAfterMs != null ? exec.retryAfterMs : null),
        attribution: exec.attribution || null,
        retries: 0,
      },
    }
  }
  // 取消/超时：交回既有 aborted 收尾（504 request_timeout 或 aborted），不伪装成上游故障。
  if (outcome === 'CANCELLED' || outcome === 'DEADLINE_EXCEEDED') {
    const err = abortedError(outcome === 'CANCELLED' ? 'client_closed' : 'request_timeout', outcome === 'CANCELLED' ? 'request canceled' : 'request timeout')
    err.receipt = closed
    throw err
  }
  // 写后无头 / 已交付后断流 / 工具风险 / 5xx 收到头：一律一次终态，不重放。
  const possiblyCommitted = sent || outcome === 'TOOL_RISK' || outcome === 'SENT_UNKNOWN'
  const code = outcome === 'TOOL_RISK' ? 'MG_FB_SIDE_EFFECT_REPLAY_BLOCKED'
    : outcome === 'SENT_UNKNOWN' ? 'MG_FB_STREAM_INTERRUPTED'
      : outcome === 'CANCELLED' ? 'MG_FB_CANCELLED'
        : outcome === 'DEADLINE_EXCEEDED' ? 'MG_FB_DEADLINE'
          : 'MG_FB_UPSTREAM'
  const err = typedSendError(code, '上游已写出请求但未完成可安全重放的响应：终止而不重放（' + outcome + '）', {
    status: outcome === 'CANCELLED' ? 499 : (outcome === 'DEADLINE_EXCEEDED' ? 504 : (fr.status >= 500 ? 502 : 409)),
    noReplay: true,
    possiblyCommitted,
    receipt: closed,
    retryAfter: exec.retryAfterMs != null ? exec.retryAfterMs : null,
    attribution: exec.attribution || null,
    bodyText: fr.bodyText || '',
  })
  err.execOutcome = outcome
  err.execStage = exec.stage
  err.relay = relayResult
  err.attempt = attempt
  throw err
}

export async function forwardChain(deps, state, req, url, path, method, bodyBuf, body, log, streamRelay, budget, opts = {}) {
  const { ensureHst, markFail, markOk, healthy, agg, ensureSt, noteAffinity, noteCacheStat, tallyDaily, tallyVirtual, tallyDialogue, tallyDialogueRequest, tryParse, collectBody } = deps
  const cfg = state.cfg
  const budgetSignal = (budget && budget.signal) || null
  // M1-3a：账本启用/费用上限 fail-closed。没有账本却配置了费用上限 ⇒ 零发送（审计：上限不能对着 spent=0 判）。
  let ledger = null
  try { ledger = openLedgerFor(cfg, opts, log) } catch (e) {
    return { kind: 'json', status: 503, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ error: { message: '账本不可用：拒绝发送（fail-closed）', type: 'ledger_unavailable', code: String((e && e.code) || 'ledger_unavailable') } })) }
  }
  const sendLimits = costLimitsOf(cfg)
  if (!ledger && (sendLimits.requestUsd > 0 || sendLimits.taskUsd > 0 || sendLimits.dailyUsd > 0)) {
    return { kind: 'json', status: 503, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ error: { message: '配置了费用上限但没有账本：拒绝发送（无法强制上限）', type: 'ledger_required_for_cost_limits', code: 'ledger_required_for_cost_limits' } })) }
  }
  const headerValue = (name) => { const v = req && req.headers ? req.headers[name] : null; return Array.isArray(v) ? v[0] : v }
  const ledgerRequestId = String((opts && opts.requestId) || headerValue('x-request-id') || randomUUID())
  const ledgerTaskRef = (opts && opts.taskRef) || headerValue('x-mg-task') || null
  // 非幂等不重放（G1）：带工具语义的请求（tools / tool_calls / tool 结果）重放可能重复触发
  // 客户端已执行的工具（shell_command / apply_patch）。策略：同一上游只发一次（forward 的 noRetry）、
  // 整条链最多走一轮（可换上游/模型，但绝不回队首重放）；opts.noReplay 可显式覆盖
  // （true=强制不重放，false=显式允许）。
  const noReplay = opts.noReplay != null ? !!opts.noReplay : isToolBearingBody(body)
  // 剩余请求预算（无预算/overallMs=0 = Infinity）：429 冷却与 Retry-After 等待都不得越过它
  const remainingBudgetMs = () => (budget ? budget.remaining() : Infinity)
  const overallMsCfg = (cfg.defaults && cfg.defaults.timeout && cfg.defaults.timeout.overallMs) || 0
  const timeoutBody = () => Buffer.from(JSON.stringify({ error: { message: '请求超时：超出整体预算 ' + overallMsCfg + 'ms（defaults.timeout.overallMs）', type: 'request_timeout' } }))
  const abortedResult = () => (budget && budget.reason === 'client_closed')
    ? { kind: 'aborted' }
    : { kind: 'json', status: 504, contentType: 'application/json', body: timeoutBody() }
  let routes = []
  let codexDef = null // Codex 聚合目标（目录 slug）的 def，用于启用 E5 决策器
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
    let hit
    try { hit = state.router.resolve(body.model) } catch (e) {
      // E1：聚合保留 ID 未命中（router 已判定不回退）→ 404 + 稳定错误码 + 可用 ID，绝不落默认上游。
      if (e && e.code === 'unknown_model') {
        return { kind: 'json', status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ error: { message: e.message, type: 'unknown_model', code: 'unknown_model', model: body.model, available: e.available || [] } })) }
      }
      throw e
    }
    // 决策 1：已配置虚拟模型后，未知名不再静默走 defaults 链（防 key 隔离被无感绕过），明确 404
    if (!hit.known && (state.cfg.virtualModels || []).length) {
      return { kind: 'json', status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ error: { message: '未知模型名: ' + body.model + '。可用虚拟模型见 GET /v1/models', type: 'unknown_model' } })) }
    }
    requestModel = hit.canonicalName
    codexDef = hit.def
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
  // E5：Codex 聚合路径启用决策器；其它请求 codex=null，下方所有 codex 分支短路，原有行为不变。
  let codex = null
  const codexNow = Number.isFinite(Number(opts && opts.now)) ? Number(opts.now) : Date.now()
  // 目录世代是否参与本次路由：显式 authzContext/catalogRecord，或 Codex 目录聚合目标。
  const catalogScoped = !!(opts && (opts.authzContext || opts.catalogRecord || opts.catalogGeneration != null)) ||
    !!(codexDef && (codexDef.codexAggregate === true || codexDef.codexOfficial === true))
  if (codexFallbackEnabled(cfg, codexDef, body && body.model, requestModel)) {
    const codexRequest = codexRequestInfoOf(body)
    const codexEstimate = codexEstimateFor(cfg)
    codex = {
      request: codexRequest,
      candidates: codexBuildCandidates(cfg, routes, codexNow),
      phase: PHASE.UNSENT,
      attempts: { total: 0, sameProvider: 0, failovers: 0 },
      spentUsd: 0,
      limits: codexLimitsOf(cfg),
      emergency: codexEmergencyOf(cfg),
      tried: [],
      toolCallSeen: false,
      estimate: (cand) => (cand ? codexEstimate(cand.model, cand.provider) : undefined),
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
  let last429 = null          // 最后一次 429 限流（归因/Retry-After）：链或预算结束时回 429，不再吞成 502
  let upstreamHits = 0        // 本次请求已发起的上游尝试次数（含同上游重试；429 响应的 attempts 字段）
  let tried = false
  let streamStarted = false   // 流式已开始（响应头已发给客户端）：此后不能再写 json 状态码，失败只能以流内错误事件收尾
  const loopMs = (cfg.defaults && cfg.defaults.timeout && cfg.defaults.timeout.loopMs) || 120000
  // 模型链循环上限进一步被请求级整体预算钳制（MG-002）：预算小于 loopMs 时以预算为准
  const loopDeadline = (budget && budget.deadlineAt != null) ? Math.min(Date.now() + loopMs, budget.deadlineAt) : Date.now() + loopMs
  const chainModels = []            // 实际尝试过的 serving 模型链（跨模型兜底/循环标记，供日志/面板查看）
  // —— E5 决策器运行时（codex=null 时全部短路；非聚合路径零改动）——
  const codexCandidateOf = (model, pid) => {
    if (!codex) return null
    const hitCand = codex.candidates.find((c) => c.model === model && c.provider === pid)
    return hitCand || (cfg.providers[pid] ? codexCandidateFor(cfg, model, pid, codexNow, false) : null)
  }
  const codexAdvance = (to, why) => {
    if (!codex) return false
    const r = advancePhase(codex.phase, to)
    if (r.ok) { codex.phase = r.phase; return true }
    log && log.warn('codex phase rejected', codex.phase + '->' + to, why || '')
    return false
  }
  const decisionLimitsMicro = limitsMicroOf(sendLimits)
  const codexBudgetForDecision = () => {
    const policy = billingPolicyOf(cfg)
    if (ledger) {
      try {
        return withBillingPolicy(facts.budgetFromLedger(ledger.usage({ requestId: ledgerRequestId, taskRef: ledgerTaskRef }), {
          limitsMicro: decisionLimitsMicro,
          currency: ledger.currency,
          enforceUnknownCost: true,
        }), policy)
      } catch { /* 账本视图不可用：退回旧预算（仍受上面的 fail-closed 保护） */ }
    }
    return codexBudgetOf(cfg, codex.spentUsd)
  }
  const codexDecide = (o = {}) => {
    if (!codex) return null
    const d = decide({
      now: Date.now(),
      phase: codex.phase,
      error: o.error || null,
      request: codex.request,
      current: o.current || null,
      candidates: codex.candidates,
      triedTargets: codex.tried,
      attempts: codex.attempts,
      limits: codex.limits,
      lastAttempt: o.lastAttempt || null,
      budget: codexBudgetForDecision(),
      estimateCost: (cand) => codex.estimate(cand),
      remainingMs: remainingBudgetMs(),
      emergency: codex.emergency,
      healthOf: (cand) => {
        const h = ensureHst(state, cand.provider)
        const open = !healthy(h, Date.now()) || (h.streamDrops || 0) >= STREAM_DROP_THRESHOLD
        return open ? { state: 'open', cooldownUntilMs: h.openUntil || 0 } : { state: 'closed' }
      },
    })
    // 审计日志：只记决策字段，不含令牌/正文
    log && log.info('codex fallback decision', 'action=' + d.action, 'code=' + d.code, 'phase=' + d.audit.phase, 'error=' + d.audit.errorClass, 'model=' + ((o.current && o.current.model) || '-'), 'provider=' + ((o.current && o.current.provider) || '-'), 'target=' + ((d.target && (d.target.model + '/' + d.target.provider)) || '-'), 'budgetNextUsd=' + (d.budget.nextUsd == null ? '?' : d.budget.nextUsd))
    return d
  }
  const codexStopResult = (d, o = {}) => {
    const upstreamStatus = d.audit.errorStatus
    if (o.streamStarted) {
      return { kind: 'stream-interrupted', pid: o.pid || null, modelName: o.modelName || modelName, serving: o.serving, chain: chainModels.join('>'), note: d.reason, code: d.code, phase: d.audit.phase, reconnects: 0 }
    }
    const raMs = o.retryAfterMs != null ? Number(o.retryAfterMs) : null
    const status = codexStopStatus(d.code, upstreamStatus)
    const headers = (status === 429 && raMs != null) ? { 'retry-after': String(Math.ceil(Math.max(0, raMs) / 1000)) } : undefined
    return {
      kind: 'json', status, contentType: 'application/json; charset=utf-8', headers,
      pid: o.pid || null, modelName, serving: o.serving, chain: chainModels.join('>'),
      body: Buffer.from(JSON.stringify({ error: {
        message: d.reason, type: 'codex_fallback', code: d.code, action: d.action,
        phase: d.audit.phase, user_action: d.userAction,
        upstream_status: upstreamStatus == null ? null : upstreamStatus,
        retry_after_ms: raMs,
      } })),
    }
  }
  const codexWaitRetry = async (d) => {
    const ms = d && d.retry && Number.isFinite(Number(d.retry.afterMs)) ? Number(d.retry.afterMs) : null
    if (ms == null || ms > remainingBudgetMs()) return false
    try { await sleepWith(ms, budgetSignal); return true } catch { return false }
  }
  const codexMarkTried = (model, pid) => {
    if (!codex) return
    if (!codex.tried.some((t) => t.model === model && t.provider === pid)) codex.tried.push({ model, provider: pid })
  }
  // M1-3a：裁决目标 = 实际执行目标。初始裁决给出首个 target；failover/retry_same 后
  // forcedTarget 让路由循环只允许命中该 target（不匹配的候选直接跳过，绝不偷换）。
  let forcedTarget = null
  let forcedTargetMisses = 0
  if (codex) {
    const primaryPid = routes[0] && routes[0].providers && routes[0].providers[0]
    const primaryProv = primaryPid ? buildProvider(cfg, primaryPid) : null
    const primaryOfficial = primaryProv ? classifyTarget(primaryProv, cfg).kind === 'official' : false
    // 官方主目标是"用户直接选择"，不进入通用 fallback 排名（D7）；其授权由 authorizeFinalTarget 另行 fail-closed。
    if (!primaryOfficial) {
      const d0 = codexDecide({})
      if (d0 && d0.action === ACTION.STOP) {
        // 候选全被预算/报价门排除时，用 402 MG_FB_BUDGET 表达"超预算停机"，而不是泛化 502。
        const budgetExcluded = Array.isArray(d0.excluded) && d0.excluded.some((x) => Array.isArray(x.reasons) &&
          x.reasons.some((r) => /budget|cost|quote/.test(String(r))))
        if (d0.code === STOP.BUDGET || /BUDGET/.test(String(d0.code || '')) || (d0.code === STOP.NO_CANDIDATE && budgetExcluded)) {
          return { kind: 'json', status: 402, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ error: { message: '候选池因预算/报价不足不可用：禁止降级到更便宜候选', type: 'codex_fallback', code: STOP.BUDGET, action: ACTION.STOP, phase: d0.audit.phase } })), pid: null, modelName, chain: '' }
        }
        return codexStopResult(d0, {})
      }
      if (d0 && d0.target) forcedTarget = { model: d0.target.model, provider: d0.target.provider }
    }
  }
  try {
  // 循环兜底：整条路由链(a→b→c)一轮失败后回到队首反复尝试，直到成功 / 业务4xx / 整体超时(loopMs)
  outer: while (Date.now() < loopDeadline) {
    if (budget && budget.expired()) { lastErr = abortedError((budget && budget.reason) || 'request_timeout'); refundQps(); break }
    let cycleTried = false
    rejectedOnly = true // 每轮重置：遇到可重试类失败（catch）即置 false；整轮只有 403/404 则维持 true → 轮末 break
    for (let ri = 0; ri < routes.length; ri++) {
      const route = routes[ri]
      const serving = route.model
    const lim = routeLimit(state, cfg, serving, body)
    if (lim) { log && log.warn('skip model (' + lim + ')', serving || '-', '-> next'); continue } // 额度/上下文超限：自动断连并按目录切换到下一模型
    const provs = (route.mode === 'onFail') ? route.providers.slice(0, 1) : orderCandidates(state, route.model, route.providers)
    for (let pi = 0; pi < provs.length; pi++) {
    const pid = provs[pi]
    if (!pid || !cfg.providers[pid]) continue
    if (forcedTarget && (route.model !== forcedTarget.model || pid !== forcedTarget.provider)) continue
    if (forcedTarget) forcedTarget = null
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
    // E5：Codex 聚合路径 = 主目标 + 已授权第三方；官方订阅只作为用户直接选择的主目标，绝不进 fallback 池（D7）。
    const isPrimaryTarget = ri === 0 && pi === 0
    const codexCand = codex ? codexCandidateOf(serving, pid) : null
    if (codex && !isPrimaryTarget) {
      if (classifyTarget(prov, cfg).kind === 'official') {
        log && log.warn('codex fallback: 官方订阅不进通用池，跳过', 'provider=' + pid, 'model=' + (serving || '-'))
        continue
      }
      const candAuthorized = codexCand
        ? (codexCand.facts && codexCand.facts.authorization ? codexCand.facts.authorization.value === true : codexCand.authorized === true)
        : false
      if (codexCand && candAuthorized !== true) {
        log && log.warn('codex fallback: 候选未授权，跳过', 'provider=' + pid, 'model=' + (serving || '-'))
        continue
      }
    }
    tried = true
    cycleTried = true
    if (codex) {
      codex.attempts.total += 1
      const _estUsd = codexCand ? codex.estimate(codexCand) : undefined
      if (Number.isFinite(_estUsd)) codex.spentUsd += _estUsd
    }
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
    // E1 身份域门禁（fail-closed）：官方目标做 host/scheme/path 白名单校验，未知身份直接拒绝；
    // 官方凭据透传默认关闭。拒绝发生在任何上游 I/O 之前，且错误消息不含头值。
    const identity = classifyTarget(prov, cfg)
    const denied = targetDeny({ identity, provider: prov, cfg, path: turl, env: process.env })
    if (denied) {
      log && log.warn('上游目标身份拒绝', 'provider=' + pid, 'identity=' + identity.kind, 'code=' + denied.code, 'model=' + (serving || '-'))
      return { kind: 'json', status: denied.status, contentType: 'application/json', body: Buffer.from(JSON.stringify({ error: { message: denied.message, type: 'identity_denied', code: denied.code } })), pid, modelName, serving, api, chain: chainModels.join('>') }
    }
    // M1-3a：headers 由授权记录（identity/凭据单一真源）在 authorizedSendOnce 内构造。
    // 429 冷却（rateUntil）：只有剩余预算等得下才等；等不下就跳过该上游并记 429 归因
    // （全部上游都在冷却 → 收尾回 429 + Retry-After，而不是为了等冷却把客户端挂死或误报 502）
    const cooldownWaitMs = Math.max(0, throttleOf(state, pid).rateUntil - Date.now())
    if (cooldownWaitMs > 0 && !retryWaitFits(cooldownWaitMs, remainingBudgetMs())) {
      if (!last429) last429 = { pid, retryAfter: cooldownWaitMs, attribution: 'rate_limit', bodyText: '' }
      log && log.warn('skip provider (429 冷却超出剩余预算)', pid, Math.ceil(cooldownWaitMs / 1000) + 's')
      continue
    }
    let release = null
    try { release = await acquireProvider(state, pid, cfg, budgetSignal) } catch (e) {
      if (e && e.aborted) { lastErr = e; refundQps(); log && log.warn('request aborted (queued)', e.reason || e.message); break outer }
      throw e
    }
    const attemptStart = Date.now()
    try {
      upstreamAttempted = true
      const sent = await authorizedSendOnce({
        cfg, provider: prov, pid, path: turl, req, method: req.method,
        bodyBuf: tbuf, body: routeBody, opts: Object.assign({}, opts, { ledger }),
        log, model: serving, api, budget, signal: budgetSignal, collectBody,
        nonIdempotent: noReplay || !!codex, catalogScoped,
        adapterFactory: opts && opts.adapterFactory,
        streamRelay,
        streamMeta: {
          pid, modelName, serving: serving || modelName, api, dialogueId,
          rewriteModel: (body && body.model) || null, chain: chainModels.join('>'),
          onHeaders: codex ? () => { if (codex.phase === PHASE.UNSENT) codexAdvance(PHASE.ACCEPTED, 'upstream responded') } : null,
          onTool: codex ? () => { codex.toolCallSeen = true; codexAdvance(PHASE.TOOL_SIDE_EFFECT, 'tool_call in stream') } : null,
        },
      })
      const result = sent.result
      if (codex && codex.phase === PHASE.UNSENT) codexAdvance(PHASE.ACCEPTED, 'upstream responded')
      upstreamHits += (result.retries || 0) + 1
      const latency = Date.now() - attemptStart
      const o = ensureSt(state, pid)
      o.latencySum += latency; o.latencyCount += 1
      o.lats.push(latency); if (o.lats.length > 200) o.lats.shift()
      state.stats.global.latencySum += latency; state.stats.global.confirmed += 1
      state.stats.global.lats.push(latency); if (state.stats.global.lats.length > 200) state.stats.global.lats.shift()
      bm.latencySum = (bm.latencySum || 0) + latency; bm.latencyCount = (bm.latencyCount || 0) + 1
      agg(state, pid, 'retries', result.retries || 0)
      if (result.ok) {
        if (result.streamed || (isStreamResponse(result) && typeof streamRelay === 'function')) {
          streamStarted = true
          // 流式：relay 已在 authorizedSendOnce 内完成（attemptTapStream 已标 DELIVERED/TOOL_RISK）。
          let relay = result.relay
          if (!relay) {
            // 兼容分支：未经过 authorizedSendOnce 的旧调用（streamRelay 注入但 result 未标记）
            const reconnector = async () => null // M1-3a：断流不重连/不重放
            relay = await streamRelay(result, {
              pid, modelName, serving: serving || modelName, api, dialogueId, reconnect: reconnector,
              rewriteModel: (body && body.model) || null, chain: chainModels.join('>'),
            })
          }
          const sm = serving || modelName
          const h = ensureHst(state, pid)
          if (relay && relay.clientGone) {
            // 客户端断开/写停滞：不是上游失败——不计中断、不计错误、不动熔断/streamDrops，也不再切上游
            if (codex) codexAdvance(PHASE.USER_CANCELLED, 'client gone')
            log && log.info('sse 客户端已断开/停止消费，结束该请求', 'model=' + sm, 'provider=' + pid)
            return { kind: 'aborted' }
          }
          if (relay && relay.timedOut && !relay.completed) {
            if (codex && relay.contentSent) codexAdvance(PHASE.STREAM_DELIVERED, 'content delivered then budget timeout')
            log && log.warn('请求超出整体预算（流式阶段）', 'model=' + sm, 'provider=' + pid, 'overallMs=' + overallMsCfg)
            return { kind: 'stream-interrupted', pid, modelName, serving, api, dialogueId, timeout: true, chain: chainModels.join('>'), note: '请求超出整体预算 ' + overallMsCfg + 'ms（defaults.timeout.overallMs）', reconnects: relay.reconnects || 0 }
          }
          if (relay && relay.completed) {
            if (codex) codexAdvance(PHASE.STREAM_DELIVERED, 'stream completed')
            h.streamDrops = 0
            markOk(state, pid)
            noteAffinity(state, sm, pid)
            return { kind: 'stream-done', pid, modelName, serving, api, dialogueId, chain: chainModels.join('>') }
          }
          // 流中断：M1-3a 起一次终态，绝不重放（半截流同样不得隐式重放）。
          state.st.counters.interrupts += 1; state.stats.global.interrupts += 1
          agg(state, pid, 'errors', 1); state.st.counters.errors += 1
          const sg = state.stats.byModel[sm] = state.stats.byModel[sm] || { requests: 0, errors: 0 }
          sg.errors = (sg.errors || 0) + 1
          h.streamDrops = (h.streamDrops || 0) + 1
          h.streamDropAt = Date.now()
          markFail(state, pid, prov.circuit)
          if (codex) {
            if (relay && relay.contentSent) codexAdvance(PHASE.STREAM_DELIVERED, 'content delivered before interruption')
            else if (codex.toolCallSeen) codexAdvance(PHASE.TOOL_SIDE_EFFECT, 'tool call before interruption')
          }
          const _note = '上游流式响应中断：禁止重放同一请求'
          if (relay && relay.finish) relay.finish(_note)
          log && log.warn('sse 流中断：一次终态，不重放', 'model=' + sm + ' provider=' + pid, 'chain=' + chainModels.join('>'))
          return { kind: 'stream-interrupted', pid, modelName, serving, api, dialogueId, chain: chainModels.join('>'), note: _note }
        }
        markOk(state, pid)
        ensureHst(state, pid).streamDrops = 0 // 非流式请求完整成功同样代表上游健康：解除连续断流绕开
        noteAffinity(state, serving || route.model, pid) // 非流式响应已完整收到：记录本次成功上游，供后续请求保持亲和、复用其缓存
        let out = result.body != null ? result.body : await collectBody(result.stream, undefined, { budget, signal: budgetSignal, destroyOnAbort: true })
        out = maybeGunzip(out, result.headers && result.headers['content-encoding'])
        const parsed = tryParse(out)
        // E5：非流式 2xx 也推进阶段；命工具调用按副作用处理（请求已结束，仅用于审计与后续轮次判定）。
        if (codex) {
          const _msg = parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message
          const _items = parsed && Array.isArray(parsed.output) ? parsed.output : []
          const _hasTool = !!(_msg && Array.isArray(_msg.tool_calls) && _msg.tool_calls.length) ||
            _items.some((it) => it && /function_call|custom_tool_call|local_shell_call|web_search_call|mcp_call|computer_call/.test(String(it.type || '')))
          codexAdvance(_hasTool ? PHASE.TOOL_SIDE_EFFECT : PHASE.STREAM_DELIVERED, 'non-stream response')
        }
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
      // —— M1-3a：ok:false 只可能是前置拒绝（402/404 或其它 4xx；429 已在发送层抛错）——
      // 只允许 402/404 进入下一候选；其余业务 4xx 原样归一终态，不换模型、不重放。
      if (result.status !== 402 && result.status !== 404) {
        let out = Buffer.alloc(0)
        if (result.stream) { try { out = await collectBody(result.stream, undefined, { budget, signal: budgetSignal, destroyOnAbort: true }) } catch {} }
        if (!out.length && result.bodyText) out = Buffer.from(result.bodyText, 'utf8')
        // 供应商侧业务拒绝（422 upstream_error 等）：已收到完整响应且明确归类为"上游侧故障、未执行"，
        // 属于可证明前置拒绝 → 同 attempt 不重发，但允许换下一候选（审计 P1 只禁止重放，不禁止换候选）。
        if (isUpstreamSideFailure(result.status, out)) {
          last4xx = { status: result.status, body: scrubBody(mapErrorEnvelope(api, result.status, out) || out) }
          last4xxPid = pid
          last429 = null
          lastErr = Object.assign(new Error('upstream-side ' + result.status + ' ' + (serving || '')), { status: result.status })
          agg(state, pid, 'errors', 1); state.st.counters.errors += 1; bm.errors += 1
          markFail(state, pid, prov.circuit)
          log && log.warn('上游侧故障（已收头、可证明未执行）', 'provider=' + pid, 'status ' + result.status, '-> next candidate')
          if (codex) {
            const _d = codexDecide({ error: { status: result.status, upstreamFault: true }, current: codexCand })
            if (_d.action === ACTION.STOP) return codexStopResult(_d, { pid, modelName, serving })
            codexMarkTried(serving || route.model, pid)
            if (_d.action === ACTION.FAILOVER) { codex.attempts.failovers += 1; forcedTarget = _d.target ? { model: _d.target.model, provider: _d.target.provider } : null }
            if (_d.action === ACTION.RETRY_SAME) { codex.attempts.sameProvider += 1; forcedTarget = { model: serving, provider: pid }; if (await codexWaitRetry(_d)) { pi -= 1; continue } }
          }
          continue
        }
        markOk(state, pid)
        agg(state, pid, 'errors', 1); state.st.counters.errors += 1; bm.errors += 1
        log && log.warn('upstream 4xx（不可安全重放）', 'provider=' + pid, 'status=' + result.status)
        // Codex 聚合路径用决策器的稳定错误码收尾（400→MG_FB_BAD_REQUEST 等）；非聚合仍原样归一。
        if (codex) {
          const _d = codexDecide({ error: { status: result.status }, current: codexCand })
          if (_d && _d.action === ACTION.STOP) return codexStopResult(_d, { pid, modelName, serving })
        }
        return { kind: 'json', status: result.status, contentType: 'application/json; charset=utf-8', body: scrubBody(mapErrorEnvelope(api, result.status, out) || out), pid, modelName, chain: chainModels.join('>') }
      }
      // 402/404 = 可证明未执行（前置拒绝）：允许换下一候选，但仍受决策/账本对账约束。
      const rejectedBody = result.stream ? await collectBody(result.stream, undefined, { budget, signal: budgetSignal, destroyOnAbort: true }) : Buffer.from(result.bodyText || '', 'utf8')
      last4xx = { status: result.status, body: scrubBody(mapErrorEnvelope(api, result.status, rejectedBody) || rejectedBody) }
      last4xxPid = pid
      last429 = null
      lastErr = Object.assign(new Error('upstream rejected ' + result.status + ' ' + (serving || '')), { status: result.status })
      agg(state, pid, 'errors', 1); state.st.counters.errors += 1; bm.errors += 1
      log && log.warn('provider rejected (pre-execution)', pid, 'status ' + result.status, '-> next candidate')
      if (codex) {
        const _d = codexDecide({ error: { status: result.status }, current: codexCand })
        if (_d.action === ACTION.STOP) return codexStopResult(_d, { pid, modelName, serving })
        codexMarkTried(serving || route.model, pid)
        if (_d.action === ACTION.FAILOVER) { codex.attempts.failovers += 1; forcedTarget = _d.target ? { model: _d.target.model, provider: _d.target.provider } : null }
        if (_d.action === ACTION.RETRY_SAME) { codex.attempts.sameProvider += 1; forcedTarget = { model: serving, provider: pid }; if (await codexWaitRetry(_d)) { pi -= 1; continue } }
      }
      continue
      // 非重试错误码（4xx）：业务问题，不熔断、不 fallback，直接返回；
      // 例外：403/404 属「模型/资源级拒绝」（如上游对该模型无权限/不存在），换下一模型可能成功，记录后继续尝试而非中断
      markOk(state, pid)
      // 3xx 重定向对 Chat 端点属于异常：不跟随、不裸透传，明确转 502，避免客户端误跟随或解析错乱
      if (result.status >= 300 && result.status < 400) {
        if (codex) {
          const _d = codexDecide({ error: { status: result.status }, current: codexCand })
          if (_d.action === ACTION.STOP) return codexStopResult(_d, { pid, modelName, serving, streamStarted })
          codexMarkTried(serving || route.model, pid)
          if (_d.action === ACTION.FAILOVER) { codex.attempts.failovers += 1; forcedTarget = _d.target ? { model: _d.target.model, provider: _d.target.provider } : null }
          if (_d.action === ACTION.RETRY_SAME) { codex.attempts.sameProvider += 1; forcedTarget = { model: serving, provider: pid }; if (await codexWaitRetry(_d)) { pi -= 1; continue } }
          continue
        }
        // 流已开始：写不了 502 头，按上游失败继续链（不改 rejectedOnly——3xx/4xx 是确定性拒绝，重发同一请求无意义，轮末即收尾）
        if (streamStarted) { lastErr = Object.assign(new Error('upstream redirect ' + result.status), { status: result.status }); continue }
        return { kind: 'json', status: 502, contentType: 'application/json', body: Buffer.from(JSON.stringify({ error: { message: 'upstream returned unexpected redirect (' + result.status + ')', type: 'upstream_error', status: result.status } })), pid, modelName, chain: chainModels.join('>') }
      }
      const out = await collectBody(result.stream, undefined, { budget, signal: budgetSignal, destroyOnAbort: true })
      // 流已开始（响应头/部分内容已发给客户端）后，json 状态码再也写不回去：按上游失败继续切下一上游，
      // 全链失败时由收尾逻辑以流内错误事件结束。此前此处直接 return json，index.js 二次 writeHead
      // 抛 "Cannot write headers after they are sent"，客户端只拿到没有 [DONE] 的半截流。
      if (streamStarted) {
        if (codex) {
          const _d = codexDecide({ error: { status: result.status }, current: codexCand })
          if (_d.action === ACTION.STOP) return codexStopResult(_d, { streamStarted: true, pid, modelName, serving })
          codexMarkTried(serving || route.model, pid)
          if (_d.action === ACTION.FAILOVER) { codex.attempts.failovers += 1; forcedTarget = _d.target ? { model: _d.target.model, provider: _d.target.provider } : null }
          if (_d.action === ACTION.RETRY_SAME) { codex.attempts.sameProvider += 1; forcedTarget = { model: serving, provider: pid }; if (await codexWaitRetry(_d)) { pi -= 1; continue } }
          continue
        }
        // 不置 rejectedOnly=false：4xx 是确定性拒绝，链走完一轮即可收尾，不必重复空转到 loopMs
        lastErr = Object.assign(new Error('upstream ' + result.status + ' ' + (serving || '')), { status: result.status })
        agg(state, pid, 'errors', 1); state.st.counters.errors += 1; bm.errors += 1
        log && log.warn('流已开始后上游返回 ' + result.status + '，按断流继续切下一上游', 'provider=' + pid, 'model=' + (serving || '-'))
        continue
      }
      if (isUpstreamSideFailure(result.status, out)) {
        if (codex) {
          const _d = codexDecide({ error: { status: result.status, upstreamFault: true }, current: codexCand })
          if (_d.action === ACTION.STOP) return codexStopResult(_d, { pid, modelName, serving })
          codexMarkTried(serving || route.model, pid)
          if (_d.action === ACTION.FAILOVER) { codex.attempts.failovers += 1; forcedTarget = _d.target ? { model: _d.target.model, provider: _d.target.provider } : null }
          if (_d.action === ACTION.RETRY_SAME) { codex.attempts.sameProvider += 1; forcedTarget = { model: serving, provider: pid }; if (await codexWaitRetry(_d)) { pi -= 1; continue } }
          continue
        }
        // 上游侧故障（4xx 但语义是「我/我的下游出错了」，见 isUpstreamSideFailure 注释）：
        // 计为**真·失败**（进熔断计数——反复这么报的上游该被冷却，而不是每笔请求都白撞一次），
        // 保留原始响应供整链全败时回显真实错误，继续目录链下一上游/模型。
        // 不改 rejectedOnly：一轮走完即收尾，不必空转到 loopMs（与 403/404 的取舍一致）。
        last4xx = { status: result.status, body: mapErrorEnvelope(api, result.status, out) || out }
        last4xxPid = pid
        last429 = null // 最后失败不是 429：不把更早的 429 当归因回给客户端
        lastErr = Object.assign(new Error('upstream-side ' + result.status + ' ' + (serving || '')), { status: result.status })
        agg(state, pid, 'errors', 1); state.st.counters.errors += 1; bm.errors += 1
        markFail(state, pid, prov.circuit)
        log && log.warn('上游侧故障(4xx 语义为上游出错)', 'provider=' + pid, 'status ' + result.status, '-> next provider/model', out.length ? 'bodyBytes=' + out.length : '')
        continue
      }
      if (isModelLevelRejection(result.status, out)) {
        if (codex) {
          const _d = codexDecide({ error: { status: result.status }, current: codexCand })
          if (_d.action === ACTION.STOP) return codexStopResult(_d, { pid, modelName, serving })
          codexMarkTried(serving || route.model, pid)
          if (_d.action === ACTION.FAILOVER) { codex.attempts.failovers += 1; forcedTarget = _d.target ? { model: _d.target.model, provider: _d.target.provider } : null }
          if (_d.action === ACTION.RETRY_SAME) { codex.attempts.sameProvider += 1; forcedTarget = { model: serving, provider: pid }; if (await codexWaitRetry(_d)) { pi -= 1; continue } }
          continue
        }
        // 模型级拒绝（403/404，或 400 且响应体含「模型/上游不可用」语义）：
        // 记入错误统计（不熔断），保留原始响应供整链全拒时回显，继续尝试下一模型。
        // 注：opencodego 等上游对「模型不可用」也返回 400（Provider rejected / Model not supported），
        // 若按普通 4xx 直接返回，jiyuan 故障期间目录链会在 opencodego 处断掉，客户端只拿到 400 而非自动切到 MiniMax 等后续模型。
        last4xx = { status: result.status, body: mapErrorEnvelope(api, result.status, out) || out }
        last4xxPid = pid
        last429 = null // 最后失败不是 429：不把更早的 429 当归因回给客户端
        lastErr = Object.assign(new Error('upstream ' + result.status + ' ' + (serving || '')), { status: result.status })
        agg(state, pid, 'errors', 1); state.st.counters.errors += 1; bm.errors += 1
        log && log.warn('provider rejected (model-level)', pid, 'status ' + result.status, '-> next model', out && out.length ? 'bodyBytes=' + out.length : '')
        continue
      }
      if (out.length) {
        if (codex) {
          const _d = codexDecide({ error: { status: result.status }, current: codexCand })
          if (_d.action === ACTION.STOP) return codexStopResult(_d, { pid, modelName, serving })
          codexMarkTried(serving || route.model, pid)
          if (_d.action === ACTION.FAILOVER) { codex.attempts.failovers += 1; forcedTarget = _d.target ? { model: _d.target.model, provider: _d.target.provider } : null }
          if (_d.action === ACTION.RETRY_SAME) { codex.attempts.sameProvider += 1; forcedTarget = { model: serving, provider: pid }; if (await codexWaitRetry(_d)) { pi -= 1; continue } }
          continue
        }
        // 其余 4xx（真·参数/请求错误）：直接返回保留原始错误，不再尝试下一模型（换模型同样会失败）
        log && log.warn('upstream ' + result.status, 'provider=' + pid, 'model=' + (serving || '-'), 'bodyBytes=' + out.length)
        // 非 OpenAI 上游的原生错误信封 → OpenAI 形状回给客户端（状态码与原始 body 保留在日志里）
        return { kind: 'json', status: result.status, contentType: 'application/json; charset=utf-8', body: scrubBody(mapErrorEnvelope(api, result.status, out) || out), pid, modelName, chain: chainModels.join('>') }
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
      // 目标授权拒绝：零发送语义，typed deny，不熔断、不换候选。
      if (err && err.deny) {
        log && log.warn('send target denied', 'provider=' + pid, 'code=' + err.code)
        return { kind: 'json', status: err.status || 403, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ error: { message: err.message, type: 'target_denied', code: err.code } })), pid, modelName, chain: chainModels.join('>') }
      }
      // 账本 fail-closed / 报价缺失：不发送、不换候选。
      if (err && (err.code === 'ledger_required_for_cost_limits' || err.code === 'quote_unknown' || err.code === 'ledger_reserve_failed' || err.ledger)) {
        log && log.warn('ledger blocked send', 'provider=' + pid, 'code=' + err.code)
        return { kind: 'json', status: err.status || 503, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ error: { message: err.message, type: err.type || err.code, code: err.code } })), pid, modelName, chain: chainModels.join('>') }
      }
      // M1-3a：写后无头 / 5xx 收到头 / 已交付后断流 / 工具风险 ⇒ 一次终态，绝不换候选重放。
      if (err && err.noReplay) {
        const latency = Date.now() - attemptStart
        const o = ensureSt(state, pid)
        o.latencySum += latency; o.latencyCount += 1
        o.lats.push(latency); if (o.lats.length > 200) o.lats.shift()
        state.stats.global.latencySum += latency; state.stats.global.confirmed += 1
        state.stats.global.lats.push(latency); if (state.stats.global.lats.length > 200) state.stats.global.lats.shift()
        bm.latencySum = (bm.latencySum || 0) + latency; bm.latencyCount = (bm.latencyCount || 0) + 1
        agg(state, pid, 'errors', 1); state.st.counters.errors += 1; bm.errors += 1
        upstreamHits += 1
        if (err.execOutcome !== 'TOOL_RISK') markFail(state, pid, prov && prov.circuit)
        lastErr = err
        last429 = null
        rejectedOnly = false
        if (codex) {
          const _d = codexDecide({
            error: { status: err.status || null, code: err.code, streamInterrupted: err.execOutcome === 'SENT_UNKNOWN' },
            current: codexCand,
            lastAttempt: { possiblyCommitted: err.possiblyCommitted === true, trustedResume: null },
          })
          if (_d && _d.action === ACTION.STOP) {
            if (err.relay && err.relay.finish) err.relay.finish(_d.reason)
            return codexStopResult(_d, { pid, modelName, serving, streamStarted: !!err.relay })
          }
        }
        if (streamStarted || err.relay) {
          if (err.relay && err.relay.finish) err.relay.finish(err.message)
          return { kind: 'stream-interrupted', pid, modelName, serving, api, dialogueId, chain: chainModels.join('>'), note: err.message }
        }
        const status = err.execOutcome === 'SENT_UNKNOWN' ? 502 : (err.status && err.status >= 500 ? 502 : (err.status && err.status >= 400 && err.status < 500 ? err.status : 409))
        return { kind: 'json', status, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ error: { message: err.message, type: 'no_replay', code: err.code } })), pid, modelName, chain: chainModels.join('>') }
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
      upstreamHits += (err.retries || 0) + 1 // 失败的上游尝试同样计入 attempts（含同上游重试）
      if (err.status === 429) {
        // 429 是限流/额度语义，不是上游故障：只做上游级冷却（Retry-After），不 markFail、不熔断。
        // 保留原始归因与 Retry-After；链或预算结束时由收尾逻辑回 HTTP 429，不再吞成 502。
        const th = throttleOf(state, pid)
        const raMs = err.retryAfter != null ? err.retryAfter : (last429 && last429.retryAfter != null ? last429.retryAfter : 1000)
        th.rateUntil = Date.now() + Math.min(raMs, MAX_429_COOLDOWN_MS)
        const prev = last429 && last429.pid === pid ? last429 : null
        last429 = {
          pid,
          retryAfter: err.retryAfter != null ? err.retryAfter : (prev && prev.retryAfter != null ? prev.retryAfter : null),
          attribution: err.attribution || (prev && prev.attribution) || 'unknown',
          bodyText: err.bodyText || (prev && prev.bodyText) || '',
        }
        lastErr = err
        rejectedOnly = false // 429 属可重试类失败：允许换下一个上游/模型
        log && log.warn('provider rate-limited (429)', pid, 'attribution=' + last429.attribution, 'retryAfter=' + last429.retryAfter + 'ms', '-> next provider/model')
        // Retry-After 等不下（剩余预算/单次上限不足）：本轮不再尝试该上游（冷却已置位），但**不**终止整条链——
        // 让链继续换下一个上游/模型（429 归因已记录，最终仍以 429 收尾）；不空等、不越过 deadline。
        if (!retryWaitFits(last429.retryAfter, remainingBudgetMs())) log && log.warn('429 retry-after 超出剩余预算，跳过该上游并继续换上游')
      } else {
        // 5xx / 网络错 / 408 等才是上游故障：计入熔断；最后失败不是 429，就不得把更早的 429 当归因回给客户端
        markFail(state, pid, prov && prov.circuit)
        lastErr = err
        last429 = null
        rejectedOnly = false // 可重试类失败，允许回到队首循环
        log && log.warn('provider failed', pid, err.message, '-> next fallback')
      }
      // 非幂等（tool）请求在这里**不** break：同一上游不重试已由 forward 的 noRetry 保证，
      // 允许沿链换下一个上游/模型再试一次（可用性优先）；本轮走完由下方 noReplay break 收尾，绝不回队首。
      // E5：Codex 聚合路径的错误由决策器裁决（429/5xx/网络/超时），只允许它给出的 retry_same / failover。
      if (codex) {
        const _derr = {
          status: err && err.status != null ? err.status : null,
          retryAfterMs: err && err.retryAfter != null ? err.retryAfter : null,
          code: err && err.code,
          timeout: !!(err && (err.code === 'ETIMEDOUT' || err.reason === 'request_timeout' || err.status === 408)),
        }
        const _d = codexDecide({ error: _derr, current: codexCand })
        if (_d.action === ACTION.STOP) {
          return codexStopResult(_d, { streamStarted, pid, modelName, serving, retryAfterMs: _derr.retryAfterMs })
        }
        codexMarkTried(serving || route.model, pid)
        if (_d.action === ACTION.FAILOVER) { codex.attempts.failovers += 1; forcedTarget = _d.target ? { model: _d.target.model, provider: _d.target.provider } : null }
        if (_d.action === ACTION.RETRY_SAME) {
          codex.attempts.sameProvider += 1
          forcedTarget = { model: serving, provider: pid }
          if (await codexWaitRetry(_d)) { pi -= 1; continue }
        }
      }
    } finally {
      release()
    }
    } // for pid
  } // for route
  if (forcedTarget) {
    // failover target 可能在 f 本轮已经遍历过的位置：允许重新从链首走一轮（最多 2 次），
    // 但绝不能偷换成别的候选。
    forcedTargetMisses += 1
    if (forcedTargetMisses <= 2) continue
    return { kind: 'json', status: 502, contentType: 'application/json; charset=utf-8', pid: null, modelName, chain: chainModels.join('>'), body: Buffer.from(JSON.stringify({ error: { message: '裁决目标不在可执行候选链中：拒绝改用其它候选', type: 'codex_fallback', code: STOP.NO_CANDIDATE } })) }
  }
  forcedTargetMisses = 0
  // 非幂等（tool）请求：整条链最多走一轮（每个上游至多一次尝试，可换上游/模型），绝不回队首重放
  if (noReplay) break
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
  // 429 收尾（G1）：上游限流/额度不是网关故障 —— 保留 429 + Retry-After + 归因 + attempts，
  // 绝不吞成 502（否则客户端无法区分「网关坏了」和「过一会儿再来」）。流已开始时只能走流内错误事件。
  if (last429 && !streamStarted) {
    const raSec = retryAfterHeader(last429.retryAfter)
    const attempts = upstreamHits
    log && log.warn('请求以 429 收尾', 'provider=' + (last429.pid || '-'), 'attribution=' + last429.attribution, 'retryAfter=' + last429.retryAfter + 'ms', 'attempts=' + attempts)
    return {
      kind: 'json',
      status: 429,
      contentType: 'application/json; charset=utf-8',
      headers: raSec != null ? { 'retry-after': raSec } : undefined,
      pid: last429.pid,
      modelName,
      chain: chainModels.join('>'),
      body: Buffer.from(JSON.stringify({
        error: {
          message: '上游限流（429）：' + last429.attribution + '，已按请求预算停止重试',
          type: 'rate_limited',
          code: attributionCode(last429.attribution),
          attribution: last429.attribution,
          upstream_status: 429,
          retry_after_ms: last429.retryAfter != null ? last429.retryAfter : null,
          attempts,
        },
      })),
    }
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
