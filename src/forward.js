// 转发链模块（Phase1 TD3 自 index.js 拆分）：routes 构建 + 三层重试 + 循环兜底 + 限流/记账协作
// 共享辅助（健康/统计/工具）由 index.js 经 deps 注入，避免双向依赖
import { gunzipSync } from 'node:zlib'
import { adapterFor, cacheHitMiss } from './format.js'
import { buildProvider } from './router.js'
import { isStreamResponse } from './sse.js'
import { forward } from './request.js'
import { todayKey } from './shared.js'

const HOP_BY_HOP = new Set(['host','connection','transfer-encoding','content-length','upgrade','keep-alive','te','trailer'])
const STRIP_IN = new Set(['authorization','cookie','x-api-key','api-key','proxy-authorization','proxy-connection'])
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
const AFFINITY_TTL_MS = 300000  // 缓存亲和有效期（可用 defaults.affinityTtlMs 覆盖）：过期后主上游可被重新试用

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

export async function forwardChain(deps, state, req, url, path, method, bodyBuf, body, log) {
  const { ensureHst, markFail, markOk, healthy, agg, ensureSt, noteAffinity, noteCacheStat, tallyDaily, tallyVirtual, tallyDialogue, tryParse, collectBody } = deps
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
    // 决策 1：已配置虚拟模型后，未知名不再静默走 defaults 链（防 key 隔离被无感绕过），明确 404
    if (!hit.known && (state.cfg.virtualModels || []).length) {
      return { kind: 'json', status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ error: { message: '未知模型名: ' + body.model + '。可用虚拟模型见 GET /v1/models', type: 'unknown_model' } })) }
    }
    requestModel = hit.canonicalName
    maxModel = hit.def.maxConcurrent || 0
    qps = hit.def.qps || 0
    // 思考强度（LiteLLM 风格）：每个模型可配允许档位列表，客户端传的档位不在列表内则本地直接拒绝，不放给上游
    const opts = hit.def.effortOptions
    if (opts && opts.length && body.reasoning_effort !== undefined && body.reasoning_effort !== null && !opts.includes(String(body.reasoning_effort))) {
      return { kind: 'json', status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ error: { message: 'reasoning_effort 不支持 ' + body.reasoning_effort + '（该模型允许：' + hit.def.effortOptions.join(', ') + '）', type: 'UnsupportedParamsError' } })) }
    }
    // 思考强度参数格式（可选，models.<名>.effortFormat）：
    //   reasoning_effort（默认）：OpenAI 风格字符串，DeepSeek/OpenAI 系；
    //   thinking：MiniMax 风格对象 { type }，如 MiniMax-M3 的 thinking:{"type":"adaptive"}。
    // 客户端入口统一为 reasoning_effort，网关按格式转换；thinking 格式下删除 reasoning_effort 避免上游混淆。
    const effFmt = hit.def.effortFormat || 'reasoning_effort'
    const effVal = body.reasoning_effort
    if (effFmt === 'thinking') {
      const val = (effVal !== undefined && effVal !== null) ? String(effVal) : (hit.def.reasoning || '')
      if (val) { body.thinking = { type: val }; delete body.reasoning_effort; injectedEffort = true }
    } else if (hit.def.reasoning && effVal === undefined) {
      // 模型配置默认值，客户端未指定时才注入（客户端自带优先）
      body.reasoning_effort = hit.def.reasoning; injectedEffort = true
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
      if (d0vm && d0vm.effortOptions && d0vm.effortOptions.length && body.reasoning_effort !== undefined && body.reasoning_effort !== null && !d0vm.effortOptions.includes(String(body.reasoning_effort))) {
        return { kind: 'json', status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ error: { message: 'reasoning_effort 不支持 ' + body.reasoning_effort + '（' + routes[0].model + ' 允许：' + d0vm.effortOptions.join(', ') + '）', type: 'UnsupportedParamsError' } })) }
      }
      // 思考强度格式透传链首真实模型：链首是 thinking 格式（如 MiniMax-M3）时，把 reasoning_effort 入口转为 thinking 对象注入
      if (d0vm && (d0vm.effortFormat || '') === 'thinking') {
        const vmVal = (body.reasoning_effort !== undefined && body.reasoning_effort !== null) ? String(body.reasoning_effort) : (d0vm.reasoning || '')
        if (vmVal) { body.thinking = { type: vmVal }; delete body.reasoning_effort; injectedEffort = true }
      }
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
        // 虚拟共用名入口透传链首真实模型的思考强度格式（链首 thinking 格式时转 thinking 对象）
        if (d0 && (d0.effortFormat || '') === 'thinking') {
          const vmVal = (body.reasoning_effort !== undefined && body.reasoning_effort !== null) ? String(body.reasoning_effort) : (d0.reasoning || '')
          if (vmVal) { body.thinking = { type: vmVal }; delete body.reasoning_effort; injectedEffort = true }
        }
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
  let last4xx = null          // 模型级拒绝（403/404）的最后一次响应：整条链全被拒绝时回它（保留上游原始错误）
  let last4xxPid = null       // last4xx 对应的上游（pid 是 for 循环块作用域，循环外取不到）
  let rejectedOnly = false    // 本轮是否只有模型级拒绝（无网络错/5xx/429）：是则不再循环重试（403 是确定性拒绝，循环无意义）
  let tried = false
  const loopMs = (cfg.defaults && cfg.defaults.timeout && cfg.defaults.timeout.loopMs) || 120000
  const loopDeadline = Date.now() + loopMs
  const _sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const chainModels = []            // 实际尝试过的 serving 模型链（跨模型兜底/循环标记，供日志/面板查看）
  try {
  // 循环兜底：整条路由链(a→b→c)一轮失败后回到队首反复尝试，直到成功 / 业务4xx / 整体超时(loopMs)
  while (Date.now() < loopDeadline) {
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
          // 按"实际响应的模型"累计其额度用量（日额度 + 累计额度）；输入/输出单独记（命中+未命中=输入）
          const sg = state.stats.byModel[serving || modelName] = state.stats.byModel[serving || modelName] || { requests: 0, errors: 0 }
          sg.tokens = (sg.tokens || 0) + (usage.total_tokens || 0)
          sg.inTokens = (sg.inTokens || 0) + (usage.prompt_tokens || 0)
          sg.outTokens = (sg.outTokens || 0) + (usage.completion_tokens || 0)
          tallyDaily(state, serving || modelName, usage.total_tokens || 0, hit, miss, usage.prompt_tokens || 0, usage.completion_tokens || 0)
          tallyVirtual(state, modelName, serving, usage.total_tokens || 0, usage.prompt_tokens || 0, usage.completion_tokens || 0)
          tallyDialogue(state, dialogueId, usage.total_tokens || 0, hit, miss)
        }
        if (api !== 'openai') { const p = tryParse(out); if (p) { let nb; try { nb = Buffer.from(JSON.stringify(adapterFor(api).fromUpstream(p))) } catch { nb = null } if (nb) out = nb } }
        // 「名字没对上」加固：跨模型兜底改写请求 model 后，响应 model 回写为客户端请求名，避免客户端续写/统计错位
        if (body && body.model && route.model && route.model !== body.model) {
          const p2 = tryParse(out)
          if (p2 && p2.model) { p2.model = body.model; out = Buffer.from(JSON.stringify(p2)) }
        }
        return { kind: 'json', status: result.status, contentType: 'application/json', body: out, pid, modelName, serving, asSSE: degraded || undefined, dialogueId, chain: chainModels.join('>') }
      }
      // 非重试错误码（4xx）：业务问题，不熔断、不 fallback，直接返回；
      // 例外：403/404 属「模型/资源级拒绝」（如上游对该模型无权限/不存在），换下一模型可能成功，记录后继续尝试而非中断
      markOk(state, pid)
      // 3xx 重定向对 Chat 端点属于异常：不跟随、不裸透传，明确转 502，避免客户端误跟随或解析错乱
      if (result.status >= 300 && result.status < 400) return { kind: 'json', status: 502, contentType: 'application/json', body: Buffer.from(JSON.stringify({ error: { message: 'upstream returned unexpected redirect (' + result.status + ')', type: 'upstream_error', status: result.status } })), pid, modelName, chain: chainModels.join('>') }
      const out = await collectBody(result.stream)
      if (result.status === 403 || result.status === 404) {
        // 模型级拒绝：记入错误统计（不熔断），保留原始响应供整链全拒时回显，继续尝试下一模型
        last4xx = { status: result.status, body: out }
        last4xxPid = pid
        lastErr = Object.assign(new Error('upstream ' + result.status + ' ' + (serving || '')), { status: result.status })
        agg(state, pid, 'errors', 1); state.st.counters.errors += 1; bm.errors += 1
        log && log.warn('provider rejected', pid, 'status ' + result.status, '-> next model')
        continue
      }
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
      rejectedOnly = false // 网络错/5xx/429：可重试类失败，允许回到队首循环
      log && log.warn('provider failed', pid, err.message, '-> next fallback')
    } finally {
      release()
    }
    } // for pid
  } // for route
  if (!cycleTried || rejectedOnly) break // 无上游被尝试，或整轮只有 403/404 模型级拒绝（确定性失败）：再循环无意义，直接收尾
  await _sleep(300)      // 一轮全败后回到队首前稍停，避免空转打爆上游
  } // while() 有界循环兜底：整条链(a→b→c)失败后回到 a 继续，直到成功 / 业务4xx / 整体超时 / 全部熔断
  // 整条链都是 403/404 模型级拒绝：回最后一个上游原始响应（比 502 更有信息量）
  if (last4xx) return { kind: 'json', status: last4xx.status, contentType: 'application/json; charset=utf-8', body: last4xx.body, pid: last4xxPid, modelName, chain: chainModels.join('>') }
  if (!tried) return { kind: 'json', status: 502, contentType: 'application/json', chain: chainModels.join('>'), body: Buffer.from(JSON.stringify({ error: { message: lastErr ? lastErr.message : 'no usable provider (无可用上游：可能未配 Key 或全部熔断)', type: 'no_provider' } })) }
  return { kind: 'json', status: 502, contentType: 'application/json', chain: chainModels.join('>'), body: Buffer.from(JSON.stringify({ error: { message: lastErr && lastErr.message ? (lastErr.message + '（已循环兜底约 ' + Math.max(1, Math.round(loopMs / 1000)) + 's）') : 'all providers failed（已循环兜底约 ' + Math.max(1, Math.round(loopMs / 1000)) + 's）', type: 'all_providers_failed' } })) }
  } finally {
    if (releaseModel) releaseModel()
  }
}