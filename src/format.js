// 协议适配：OpenAI ⇄ Anthropic / Gemini（文本对话 + function calling）
function joinContent(c) {
  if (c == null) return ''
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : (p && p.text) || '')).join('\n')
  return String(c)
}
function makeOA(model, text, finish, extra) {
  const msg = { role: 'assistant', content: text }
  if (extra && extra.toolCalls && extra.toolCalls.length) msg.tool_calls = extra.toolCalls
  return { id: 'chatcmpl-' + Math.random().toString(36).slice(2, 10), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: model || '', choices: [{ index: 0, message: msg, finish_reason: finish || 'stop' }], usage: (extra && extra.usage) || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }
}
function hasTools(b) { return !!(b && (b.tools || b.tool_choice)) }

// ================= Anthropic =================
const anthropic = {
  build(openaiBody) {
    const messages = []; let system = ''; const id2name = {}
    for (const m of openaiBody.messages || []) {
      const text = joinContent(m.content)
      if (m.role === 'system') { system = system ? system + '\n' + text : text; continue }
      if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        const parts = text ? [{ type: 'text', text }] : []
        for (const tc of m.tool_calls) { id2name[tc.id] = tc.function.name; parts.push({ type: 'tool_use', id: tc.id || ('tc_' + Math.random().toString(36).slice(2, 8)), name: tc.function.name, input: safeJSON(tc.function.arguments) }) }
        messages.push({ role: 'assistant', content: parts }); continue
      }
      if (m.role === 'tool') {
        messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id || (Object.keys(id2name)[0] || ''), content: text }] }); continue
      }
      messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: text })
    }
    const out = { model: openaiBody.model, max_tokens: openaiBody.max_tokens || openaiBody.max_completion_tokens || 4096, messages }
    if (system) out.system = system
    const _th = thinkingSpec(openaiBody)
    if (openaiBody.temperature != null) out.temperature = openaiBody.temperature
    if (openaiBody.top_p != null) out.top_p = openaiBody.top_p
    if (_th) {
      // Anthropic extended thinking 硬约束：
      //  · temperature / top_p 必须为 1 或整个省略（开了思考再传其它值，官方报错；
      //    OpenCode Zen 类中转容忍度高，但网关侧统一按官方口径剔除以保证跨上游一致）；
      //  · max_tokens 必须严格大于 budget_tokens，否则 Anthropic 报 "budget_tokens must be less than max_tokens"。
      // 注意：思考 token 计入输出计费，但**不占用** max_tokens 的回答预算——Anthropic 的 max_tokens 是回答上限。
      delete out.temperature
      delete out.top_p
      if (!(Number(out.max_tokens) > _th.budget_tokens)) out.max_tokens = _th.budget_tokens + 1024
      out.thinking = _th
    }
    if (openaiBody.stop != null) out.stop_sequences = Array.isArray(openaiBody.stop) ? openaiBody.stop : [openaiBody.stop]
    if (Array.isArray(openaiBody.tools) && openaiBody.tools.length) out.tools = openaiBody.tools.map((t) => ({ name: t.function.name, description: (t.function.description || '') + '', input_schema: t.function.parameters || { type: 'object', properties: {} } }))
    if (openaiBody.tool_choice) out.tool_choice = mapChoice(openaiBody.tool_choice)
    if (openaiBody.stream != null) out.stream = openaiBody.stream
    return { path: '/v1/messages', body: out }
  },
  fromUpstream(o) {
    let text = '', toolCalls = []
    for (const p of ((o && o.content) || [])) {
      if (typeof p === 'string') { text += p; continue }
      if (p.type === 'text') text += p.text || ''
      if (p.type === 'tool_use') toolCalls.push({ id: p.id || '', type: 'function', function: { name: p.name || '', arguments: JSON.stringify(p.input || {}) } })
    }
    const finish = toolCalls.length ? 'tool_calls' : ((o && o.stop_reason) || 'stop')
    // usage：Anthropic 原生字段（input/output_tokens、cache_read_input_tokens）必须带上——
    // 网关的缓存命中统计 cacheHitMiss('anthropic') 直接读这几个字段；只给 OpenAI 风格三件套会让计费/命中率全变 0。
    const au = (o && o.usage) || {}
    const inT = Number(au.input_tokens) || 0, outT = Number(au.output_tokens) || 0
    const usage = Object.assign({}, au, { prompt_tokens: inT, completion_tokens: outT, total_tokens: inT + outT })
    return makeOA((o && o.model) || '', text, finish, { toolCalls, usage })
  },
  extractStreamContent(dataStr) { try { const j = JSON.parse(dataStr); const d = j && j.delta; return (d && typeof d.text === 'string') ? d.text : '' } catch { return '' } },
}
function mapChoice(c) {
  if (c === 'none') return { type: 'none' }
  if (c === 'required' || c === 'auto') return { type: c === 'required' ? 'any' : 'auto' }
  if (c && c.type === 'function' && c.function && c.function.name) return { type: 'tool', name: c.function.name }
  return { type: 'auto' }
}
function safeJSON(s) { if (s == null) return {}; try { return typeof s === 'string' ? JSON.parse(s) : s } catch { return {} } }

// 思考强度 → Anthropic extended thinking 的 token 预算档位表。
// Anthropic 侧 thinking 只有一个可调旋钮 budget_tokens（思考专用预算，独立于 max_tokens 之外，
// 但必须 < max_tokens）。客户端统一入口仍是 OpenAI 风格的 reasoning_effort，网关在此做档位→预算映射。
const THINK_BUDGET = { minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 32768, enabled: 8192, on: 8192, adaptive: 8192 }
const THINK_OFF = ['off', 'none', 'disabled', 'false']
function thinkingSpec(openaiBody) {
  const thIn = openaiBody && openaiBody.thinking
  if (thIn && typeof thIn === 'object') {
    const t = String(thIn.type || 'enabled')
    if (THINK_OFF.includes(t)) return null
    const budget = Number(thIn.budget_tokens) > 0 ? Number(thIn.budget_tokens) : (THINK_BUDGET[t] || THINK_BUDGET.enabled)
    return { type: 'enabled', budget_tokens: budget }
  }
  if (thIn === true) return { type: 'enabled', budget_tokens: THINK_BUDGET.enabled }
  const eff = openaiBody && openaiBody.reasoning_effort
  if (eff == null) return null
  const lvl = String(eff)
  if (THINK_OFF.includes(lvl)) return null
  return { type: 'enabled', budget_tokens: THINK_BUDGET[lvl] || THINK_BUDGET.enabled }
}

// ================= Gemini =================
const gemini = {
  build(openaiBody) {
    const contents = []; let system = ''; const id2name = {}
    for (const m of openaiBody.messages || []) {
      const text = joinContent(m.content)
      if (m.role === 'system') { system = system ? system + '\n' + text : text; continue }
      if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        const parts = []; if (text) parts.push({ text }); for (const tc of m.tool_calls) { id2name[tc.id] = tc.function.name; parts.push({ functionCall: { name: tc.function.name, args: safeJSON(tc.function.arguments) } }) }
        contents.push({ role: 'model', parts }); continue
      }
      if (m.role === 'tool') { const name = id2name[m.tool_call_id] || 'fn'; contents.push({ role: 'user', parts: [{ functionResponse: { name, response: { result: text } } }] }); continue }
      contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text }] })
    }
    const gc = {}
    if (openaiBody.temperature != null) gc.temperature = openaiBody.temperature
    if (openaiBody.top_p != null) gc.topP = openaiBody.top_p
    const mt = openaiBody.max_tokens || openaiBody.max_completion_tokens; if (mt) gc.maxOutputTokens = mt
    const out = { contents }
    if (system) out.systemInstruction = { parts: [{ text: system }] }
    if (Object.keys(gc).length) out.generationConfig = gc
    if (Array.isArray(openaiBody.tools) && openaiBody.tools.length) out.tools = [{ functionDeclarations: openaiBody.tools.map((t) => ({ name: t.function.name, description: (t.function.description || '') + '', parameters: t.function.parameters || { type: 'object', properties: {} } })) }]
    const model = encodeURIComponent(openaiBody.model || 'model')
    const suffix = hasTools(openaiBody) ? ':generateContent' : (openaiBody.stream ? ':streamGenerateContent?alt=sse' : ':generateContent')
    return { path: '/v1beta/models/' + model + suffix, body: out }
  },
  fromUpstream(o) {
    const cand = o && o.candidates && o.candidates[0]
    let text = '', toolCalls = []
    for (const p of ((cand && cand.content && cand.content.parts) || [])) {
      if (p.text) text += p.text
      if (p.functionCall) toolCalls.push({ id: 'call_' + Math.random().toString(36).slice(2, 10), type: 'function', function: { name: p.functionCall.name || '', arguments: JSON.stringify(p.functionCall.args || {}) } })
    }
    return makeOA((o && o.model) || '', text, toolCalls.length ? 'tool_calls' : 'stop', { toolCalls })
  },
  extractStreamContent(dataStr) { try { const j = JSON.parse(dataStr); const c = j && j.candidates && j.candidates[0]; const p = c && c.content && c.content.parts && c.content.parts[0]; return (p && typeof p.text === 'string') ? p.text : '' } catch { return '' } },
}

export function adapterFor(api) {
  if (api === 'anthropic') return anthropic
  if (api === 'gemini') return gemini
  return null
}
export { makeOA, hasTools }

// ── 缓存命中/未命中 字段映射（四桶互斥模型，按上游协议精确取数）──
// 命中率口径（业界标准，DeepSeek 官方文档 + DeepSeek Harness 交叉验证）：
//   hitRate = cacheRead / (cacheRead + cacheWrite + uncachedInput)
//   计费 prompt = cacheRead(命中) + cacheWrite(写入缓存) + uncachedInput(未缓存)，三者互斥不重叠；
//   cacheWrite 是「本次首次写入缓存」，属未命中侧，一并计入分母。
// 各协议字段语义（2026-08 调研确认）：
//   DeepSeek  : prompt_cache_hit_tokens(命中) + prompt_cache_miss_tokens(未命中) = prompt_tokens（两者都直接给）
//   OpenAI    : prompt_tokens_details.cached_tokens(命中)；prompt_tokens **包含** cached → 未命中 = prompt_tokens − cached
//   OpenRouter: 同 OpenAI（另报 cache_write_tokens=本次新写入缓存，属未命中侧）
//   Anthropic : cache_read_input_tokens(命中)；cache_creation_input_tokens(写缓存) + input_tokens(断点后未缓存) = 未命中
//   Gemini    : usageMetadata.cachedContentTokenCount(命中)；promptTokenCount 含 cached → 未命中 = prompt − cached
function num(v) { return (typeof v === 'number' && Number.isFinite(v) && v > 0) ? v : 0 }
function pickPath(o, path) {
  let v = o
  for (const p of path.split('.')) { if (v && typeof v === 'object') v = v[p]; else return 0 }
  return num(v)
}
// 返回 { hit, miss }；hit=缓存命中，miss=未命中（=未缓存 + 写入缓存）。未识别的协议回退到 openai 语义。
export function cacheHitMiss(api, usage) {
  if (!usage || typeof usage !== 'object') return { hit: 0, miss: 0 }
  const a = api || 'openai'

  // Anthropic：总输入 = read + creation + input_tokens；未命中 = creation + input_tokens（input_tokens 是「最后一个缓存断点之后」未缓存部分）
  if (a === 'anthropic') {
    const read = num(usage.cache_read_input_tokens)
    const creation = num(usage.cache_creation_input_tokens)
    const input = num(usage.input_tokens)
    return { hit: read, miss: creation + input }
  }

  // Gemini：命中在 usageMetadata.cachedContentTokenCount；promptTokenCount 含 cached
  if (a === 'gemini') {
    const um = usage.usageMetadata || {}
    const hit = num(um.cachedContentTokenCount)
    const prompt = num(um.promptTokenCount)
    return { hit, miss: Math.max(0, prompt - hit) }
  }

  // openai 兼容（DeepSeek / OpenAI / OpenRouter / opencode zen）
  const promptTokens = num(usage.prompt_tokens)
  // 命中：优先 OpenAI/OpenRouter 的 cached_tokens，回退 DeepSeek 的 prompt_cache_hit_tokens（两者语义相同，一般不同时出现）
  const cacheRead = pickPath(usage, 'prompt_tokens_details.cached_tokens') || num(usage.prompt_cache_hit_tokens)
  // 写入缓存（OpenRouter / GPT-5.6+ 才报；DeepSeek 不报）——属未命中侧
  const cacheWrite = pickPath(usage, 'prompt_tokens_details.cache_write_tokens')
  // DeepSeek 独立未命中字段（最准确，直接给全，优先采用）
  const dMiss = num(usage.prompt_cache_miss_tokens)

  // 有任一缓存字段才进入计算；否则无法判断，返回 0/0（面板显示 —，不虚报）
  if (cacheRead > 0 || cacheWrite > 0 || dMiss > 0) {
    // 未命中：DeepSeek 报独立 miss 时直接用；否则用「prompt_tokens − cacheRead」减法
    // （prompt_tokens 含缓存命中，减出互斥的未命中，自然包含 cacheWrite 与未缓存部分）
    const miss = dMiss > 0 ? dMiss : Math.max(0, promptTokens - cacheRead)
    return { hit: cacheRead, miss }
  }

  // 无任何缓存字段但有 prompt 总量：视为本次全部未缓存（hit=0, miss=prompt），命中率归 0 而非悬空 "—"
  if (promptTokens > 0) return { hit: 0, miss: promptTokens }
  return { hit: 0, miss: 0 }
}