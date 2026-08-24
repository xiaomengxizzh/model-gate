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
    if (openaiBody.temperature != null) out.temperature = openaiBody.temperature
    if (openaiBody.top_p != null) out.top_p = openaiBody.top_p
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
    return makeOA((o && o.model) || '', text, finish, { toolCalls })
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

// ── 缓存命中/未命中 字段映射（按上游协议取数，避免各厂商字段名不一导致解析错位）──
const CACHE_FIELD = {
  openai:    { hit: ['prompt_cache_hit_tokens', 'prompt_tokens_details.cached_tokens', 'cache_read_input_tokens'], miss: ['prompt_cache_miss_tokens', 'cache_creation_input_tokens', 'prompt_tokens_details.text_tokens', 'prompt_tokens_details.audio_tokens'] },
  anthropic: { hit: ['cache_read_input_tokens'], miss: ['cache_creation_input_tokens'] },
  gemini:    { hit: [], miss: [] }, // Gemini 无标准缓存计数，返回 0
}
function pickPath(o, path) {
  let v = o
  for (const p of path.split('.')) { if (v && typeof v === 'object') v = v[p]; else return 0 }
  return typeof v === 'number' ? v : 0
}
// 返回 { hit, miss }；未识别的协议回退到 openai 语义
export function cacheHitMiss(api, usage) {
  if (!usage || typeof usage !== 'object') return { hit: 0, miss: 0 }
  const f = CACHE_FIELD[api || 'openai'] || CACHE_FIELD.openai
  let hit = 0, miss = 0
  for (const k of f.hit) hit += pickPath(usage, k)
  for (const k of f.miss) miss += pickPath(usage, k)
  // 容错：不少上游只报命中量、不报未命中量（如 OpenAI 仅 cached_tokens/text_tokens）。
  // 用「prompt 总量 − 命中量」推算未命中，避免缓存命中率被恒算成 100%。
  if (miss <= 0 && hit > 0 && typeof usage.prompt_tokens === 'number' && usage.prompt_tokens > hit) {
    miss = usage.prompt_tokens - hit
  }
  return { hit, miss }
}