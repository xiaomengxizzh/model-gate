// Responses / Codex 接入的纯映射层（MG-015）。
// 契约：docs/contracts/responses-v1.md（请求映射 §4、响应映射 §5、流式事件 §6、有损清单 §7）。
// 设计约束：
//  · 纯函数、零 import / 零第三方依赖，可被 node --test 直接 import；
//  · 只做 wire 形状映射，不读进程状态、不发请求、不碰路由（router/format/forward/index 由后续接线）；
//  · 无法表达或必须显式拒绝的字段不得静默忽略：拒绝项返回 { rejected:{code,message}, body:null }，
//    可降级项写入 lossy[]（稳定字符串代码，供日志/响应头/诊断使用）。
//
// lossy 代码（稳定字符串，测试与日志可依赖）：
//   custom_tool_format         custom tool 的 format 在 Chat 无对应语义
//   custom_tool_call_input     custom_tool_call 的自由文本 input 被编码为 {"input":...}
//   custom_tool_call_restored  回程按 ctx.customToolNames 还原 custom_tool_call
//   allowed_tools              tool_choice.allowed_tools 无法细粒度表达，降级为 auto/required
//   parallel_tool_calls        Chat 无法保证并行/串行约束
//   reasoning_summary          reasoning.summary 无对应字段（仅保留 effort）
//   non_text_part:<type>       输入 content 里的非文本 part 被丢弃
//   input_item_string          input[] 里的裸字符串被当作 user 文本
//   metadata / user            调用方元数据不向上游透传
//   unknown_field:<name>       未映射的顶层字段（不静默保留）
//   unknown_tool_choice        无法识别的 tool_choice 已降级
//
// 拒绝 code：unsupported_parameter（契约 §3.4 / §4）。

const EFFORT_NONE_ALIAS = new Set(['off', 'none', 'disabled', 'false'])
const HANDLED_REQ_FIELDS = new Set([
  'model', 'input', 'instructions', 'tools', 'tool_choice', 'max_output_tokens',
  'temperature', 'top_p', 'reasoning', 'stream',
])
const REJECT_FIELDS = ['store', 'previous_response_id', 'background', 'include', 'truncation']
const HOSTED_TOOL_TYPES = new Set([
  'web_search', 'web_search_preview', 'file_search', 'code_interpreter', 'computer_use_preview',
  'image_generation', 'mcp', 'local_shell', 'custom_tool_call_output',
])

function rid(prefix) { return prefix + Math.random().toString(36).slice(2, 12) }
function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v) }
function reject(message) { return { body: null, lossy: [], rejected: { code: 'unsupported_parameter', message } } }

// 与 src/forward.js 的 canonEffort 保持同义（off/none/disabled/false → none）
export function canonEffort(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase()
  return EFFORT_NONE_ALIAS.has(s) ? 'none' : s
}

function joinTextParts(content, lossy) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return String(content)
  let out = ''
  for (const part of content) {
    if (typeof part === 'string') { out += part; continue }
    if (!part || typeof part !== 'object') continue
    const t = part.type
    if (t === 'input_text' || t === 'output_text' || t === 'text' || t === undefined) {
      if (typeof part.text === 'string') out += part.text
      continue
    }
    lossy.push('non_text_part:' + String(t))
  }
  return out
}

function mapTools(tools, lossy) {
  if (tools == null) return undefined
  if (!Array.isArray(tools)) throw new Error('tools 须为数组')
  const out = []
  for (const t of tools) {
    if (!t || typeof t !== 'object') throw new Error('tools 项须为对象')
    const type = t.type || 'function'
    if (type === 'function') {
      const name = t.name || (t.function && t.function.name)
      if (!name) throw new Error('function tool 缺少 name')
      const description = t.description != null ? String(t.description) : (t.function && t.function.description != null ? String(t.function.description) : '')
      const parameters = t.parameters || (t.function && t.function.parameters) || { type: 'object', properties: {} }
      const fn = { name, description, parameters }
      if (typeof t.strict === 'boolean') fn.strict = t.strict
      out.push({ type: 'function', function: fn })
      continue
    }
    if (type === 'custom') {
      const name = t.name
      if (!name) throw new Error('custom tool 缺少 name')
      // Chat 无 custom tool 语义：用 function 模拟，参数固定为 { input: string }；format 有损。
      const fn = {
        name,
        description: (t.description != null ? String(t.description) : '') + '（custom tool：input 为自由文本）',
        parameters: { type: 'object', properties: { input: { type: 'string', description: '自由文本输入' } }, required: ['input'] },
      }
      out.push({ type: 'function', function: fn })
      if (t.format != null) lossy.push('custom_tool_format')
      continue
    }
    throw new Error('不支持的托管工具: ' + type)
  }
  return out
}

function mapToolChoice(choice, lossy) {
  if (choice == null) return undefined
  if (choice === 'auto' || choice === 'required' || choice === 'none') return choice
  if (typeof choice === 'string') { lossy.push('unknown_tool_choice'); return 'auto' }
  if (!isPlainObject(choice)) { lossy.push('unknown_tool_choice'); return 'auto' }
  if (choice.type === 'function' || choice.type === 'custom') {
    const name = choice.name || (choice.function && choice.function.name)
    if (!name) { lossy.push('unknown_tool_choice'); return 'auto' }
    if (choice.type === 'custom') lossy.push('custom_tool_choice')
    return { type: 'function', function: { name } }
  }
  if (choice.type === 'allowed_tools') {
    // Chat 无法表达允许列表：按 mode 降级为 auto/required，并显式记录有损。
    lossy.push('allowed_tools')
    const mode = choice.mode || 'auto'
    return mode === 'required' ? 'required' : 'auto'
  }
  lossy.push('unknown_tool_choice')
  return 'auto'
}

function mergeAssistantToolCalls(messages, toolCalls) {
  const last = messages[messages.length - 1]
  if (last && last.role === 'assistant' && Array.isArray(last.tool_calls) && last.content === undefined) {
    last.tool_calls.push(...toolCalls)
    return
  }
  messages.push({ role: 'assistant', tool_calls: toolCalls })
}

/**
 * Responses 请求 → Chat Completions 请求（Chat 桥）。
 * 返回 { body, lossy, rejected }：
 *  · 成功: rejected === null；body 为 Chat 请求体；
 *  · 拒绝: body === null，rejected = { code:'unsupported_parameter', message }，lossy 保留已发现项。
 * 抛出仅在 tools 形状非法等客户端 bug；调用方应按 400 处理。
 */
export function responsesToChat(input) {
  const req = isPlainObject(input) ? input : null
  const lossy = []
  if (!req) return { body: null, lossy, rejected: { code: 'unsupported_parameter', message: '请求体必须是 JSON 对象' } }

  // —— 契约 §3.4 / §4：必须显式拒绝的能力，不得静默忽略 ——
  if (req.store === true) return reject('store 不支持：网关不保存响应（store=true）')
  if (req.previous_response_id != null && String(req.previous_response_id).trim() !== '') return reject('previous_response_id 不支持：网关不维护响应续轮')
  if (req.background === true) return reject('background 不支持：网关不提供后台任务')
  if (req.include != null) {
    // 真实客户端（Codex/DSH）固定发 include:["reasoning.encrypted_content"]。网关本就不产生加密推理，
    // 该项语义上等于"没有可返回的东西"——整条拒绝会让 Responses 桥对真实客户端完全不可用
    // （2026-11-09 实测 DSH 0.2.2-rc.1 因此 400）。因此只接受"丢弃后不影响正确性"的项并记 lossy；
    // 其余（图片/托管产物/未知项）仍旧显式拒绝，避免静默丢掉客户端要求的产物。
    if (!Array.isArray(req.include)) return reject('include 必须是字符串数组')
    const DROPPABLE_INCLUDE = ['reasoning.encrypted_content', 'output_text.logprobs']
    for (const item of req.include) {
      if (typeof item !== 'string' || !DROPPABLE_INCLUDE.includes(item)) {
        return reject('include 不支持: ' + String(item) + '（仅接受可安全丢弃的 ' + DROPPABLE_INCLUDE.join(' / ') + '）')
      }
    }
    if (req.include.length) lossy.push('include_dropped:' + req.include.join(','))
  }
  if (req.truncation != null && req.truncation !== 'disabled') return reject('truncation 不支持：网关不截断对话（仅接受 disabled）')

  const messages = []
  if (typeof req.instructions === 'string' && req.instructions !== '') messages.push({ role: 'system', content: req.instructions })
  else if (Array.isArray(req.instructions)) {
    const text = joinTextParts(req.instructions, lossy)
    if (text !== '') messages.push({ role: 'system', content: text })
  }

  if (typeof req.input === 'string') {
    messages.push({ role: 'user', content: req.input })
  } else if (Array.isArray(req.input)) {
    for (const item of req.input) {
      if (typeof item === 'string') { lossy.push('input_item_string'); messages.push({ role: 'user', content: item }); continue }
      if (!isPlainObject(item)) return reject('input 数组包含非法项')
      const type = item.type
      if (type === 'function_call_output') {
        const out = joinTextParts(item.output, lossy)
        messages.push({ role: 'tool', tool_call_id: item.call_id || '', content: out })
        continue
      }
      if (type === 'function_call' || type === 'custom_tool_call') {
        const name = item.name || ''
        if (!name) return reject('function_call 缺少 name')
        let args = item.arguments
        if (type === 'custom_tool_call') {
          const raw = item.input == null ? '' : String(item.input)
          args = JSON.stringify({ input: raw })
          lossy.push('custom_tool_call_input')
        }
        if (typeof args !== 'string') args = JSON.stringify(args == null ? {} : args)
        mergeAssistantToolCalls(messages, [{
          id: item.call_id || rid('call_'),
          type: 'function',
          function: { name, arguments: args },
        }])
        continue
      }
      if (type === 'message' || item.role) {
        let role = item.role || 'user'
        if (role === 'developer') role = 'system'
        if (role === 'tool') {
          messages.push({ role: 'tool', tool_call_id: item.tool_call_id || item.call_id || '', content: joinTextParts(item.content, lossy) })
          continue
        }
        if (!['user', 'assistant', 'system'].includes(role)) return reject('不支持的 input role: ' + role)
        messages.push({ role, content: joinTextParts(item.content, lossy) })
        continue
      }
      return reject('不支持的 input item 类型: ' + String(type || '(缺 type)'))
    }
  } else if (req.input != null) {
    return reject('input 须为字符串或数组')
  }

  let tools
  try { tools = mapTools(req.tools, lossy) } catch (e) { return reject(e.message) }
  let toolChoice
  try { toolChoice = mapToolChoice(req.tool_choice, lossy) } catch (e) { return reject(e.message) }

  const body = { messages }
  if (req.model != null) body.model = req.model
  if (tools !== undefined) body.tools = tools
  if (toolChoice !== undefined) body.tool_choice = toolChoice
  if (req.max_output_tokens != null && Number.isFinite(Number(req.max_output_tokens))) body.max_tokens = Number(req.max_output_tokens)
  if (req.temperature != null) body.temperature = req.temperature
  if (req.top_p != null) body.top_p = req.top_p
  if (req.stream != null) body.stream = !!req.stream

  if (isPlainObject(req.reasoning)) {
    if (req.reasoning.effort != null && String(req.reasoning.effort).trim() !== '') body.reasoning_effort = canonEffort(req.reasoning.effort)
    if (req.reasoning.summary != null) lossy.push('reasoning_summary')
  } else if (req.reasoning != null) {
    lossy.push('unknown_field:reasoning')
  }
  if (req.metadata != null) lossy.push('metadata')
  if (req.user != null) lossy.push('user')
  if (req.parallel_tool_calls === false) lossy.push('parallel_tool_calls')
  if (req.text != null) lossy.push('unknown_field:text')
  for (const k of Object.keys(req)) {
    if (HANDLED_REQ_FIELDS.has(k) || REJECT_FIELDS.includes(k)) continue
    if (k === 'metadata' || k === 'user' || k === 'parallel_tool_calls' || k === 'text') continue
    lossy.push('unknown_field:' + k)
  }

  return { body, lossy, rejected: null }
}

// Chat usage → Responses usage（契约 §5：无来源写 0，不臆造 reasoning_tokens）
export function mapUsage(chatUsage) {
  const u = isPlainObject(chatUsage) ? chatUsage : {}
  const input = Number(u.prompt_tokens) > 0 ? Number(u.prompt_tokens) : (Number(u.input_tokens) > 0 ? Number(u.input_tokens) : 0)
  const output = Number(u.completion_tokens) > 0 ? Number(u.completion_tokens) : (Number(u.output_tokens) > 0 ? Number(u.output_tokens) : 0)
  const total = Number(u.total_tokens) > 0 ? Number(u.total_tokens) : input + output
  const cached = (u.prompt_tokens_details && Number(u.prompt_tokens_details.cached_tokens)) || Number(u.prompt_cache_hit_tokens) || 0
  const reasoning = (u.completion_tokens_details && Number(u.completion_tokens_details.reasoning_tokens)) || 0
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: total,
    input_tokens_details: { cached_tokens: cached > 0 ? cached : 0 },
    output_tokens_details: { reasoning_tokens: reasoning > 0 ? reasoning : 0 },
  }
}

// Chat finish_reason → Responses 终态（契约 §5）
export function finishToStatus(finishReason) {
  if (finishReason === 'length') return { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }
  if (finishReason === 'content_filter') return { status: 'incomplete', incomplete_details: { reason: 'content_filter' } }
  return { status: 'completed', incomplete_details: null }
}

function chatMessageText(message) {
  if (!message) return ''
  const c = message.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    let out = ''
    for (const p of c) {
      if (typeof p === 'string') out += p
      else if (p && typeof p.text === 'string') out += p.text
    }
    return out
  }
  return c == null ? '' : String(c)
}

/**
 * Chat Completions 响应 JSON → Responses 响应对象（契约 §5）。
 * ctx: { model?, id?, createdAt?, customToolNames?: string[], lossy?: string[] }
 *  · model 一律回写为客户端请求名（ctx.model 优先）；
 *  · tool_calls 每个 → function_call item；ctx.customToolNames 命中时还原为 custom_tool_call 并记有损；
 *  · finish_reason=length/content_filter → status=incomplete + incomplete_details。
 */
export function chatToResponse(chatJson, ctx = {}) {
  const chat = isPlainObject(chatJson) ? chatJson : {}
  const choice = (Array.isArray(chat.choices) && chat.choices[0]) || {}
  const message = choice.message || {}
  const text = chatMessageText(message)
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
  const fs = finishToStatus(choice.finish_reason)
  const lossy = Array.isArray(ctx.lossy) ? ctx.lossy : null
  const output = []
  if (text !== '' || toolCalls.length === 0) {
    output.push({
      id: rid('msg_'),
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    })
  }
  const customNames = Array.isArray(ctx.customToolNames) ? ctx.customToolNames : []
  for (const tc of toolCalls) {
    const fn = tc && tc.function ? tc.function : {}
    const name = fn.name || ''
    const args = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments == null ? {} : fn.arguments)
    if (customNames.includes(name)) {
      let raw = args
      try { const parsed = JSON.parse(args); if (parsed && typeof parsed.input === 'string') raw = parsed.input } catch { /* keep args */ }
      output.push({ id: rid('ctc_'), type: 'custom_tool_call', status: 'completed', call_id: tc.id || '', name, input: raw })
      if (lossy) lossy.push('custom_tool_call_restored')
      continue
    }
    output.push({
      id: rid('fc_'),
      type: 'function_call',
      status: 'completed',
      call_id: tc.id || '',
      name,
      arguments: args,
    })
  }
  const response = {
    id: ctx.id || rid('resp_'), // 契约 §5：id 必须是 resp_<gateway-id>，不得沿用上游 chatcmpl id
    object: 'response',
    created_at: Number.isFinite(ctx.createdAt) ? ctx.createdAt : (Number(chat.created) || Math.floor(Date.now() / 1000)),
    status: fs.status,
    model: ctx.model || chat.model || '',
    output,
    output_text: text,
    usage: mapUsage(chat.usage),
  }
  if (fs.incomplete_details) response.incomplete_details = fs.incomplete_details
  return response
}

// SSE 帧编码：每个事件一帧（event 行 + data 行 + 空行）；Responses 协议不使用 [DONE]。
export function encodeSSE(event) {
  return 'event: ' + event.type + '\ndata: ' + JSON.stringify(event.data) + '\n\n'
}

/**
 * Responses 流式事件写入器（契约 §6）。
 * 每次方法调用返回一个或多个完整 SSE 帧字符串，可直接 res.write()；events 暴露已产生事件供测试/日志。
 * 顺序（文本）：created → output_item.added → content_part.added → output_text.delta* →
 *              output_text.done → content_part.done → output_item.done → completed
 * 顺序（工具）：created → output_item.added(function_call) → function_call_arguments.delta* →
 *              function_call_arguments.done → output_item.done → completed
 * 失败：failed() 只发 response.failed（不再发 completed）；sequence_number 从 1 单调递增。
 */
export function makeSSEWriter(opts = {}) {
  const responseId = opts.id || rid('resp_')
  const model = opts.model || ''
  const createdAt = Number.isFinite(opts.createdAt) ? opts.createdAt : Math.floor(Date.now() / 1000)
  const events = []
  let seq = 0
  let nextIndex = 0
  let textState = null
  let toolState = null

  function baseResponse(status) {
    return { id: responseId, object: 'response', created_at: createdAt, status: status || 'in_progress', model, output: [] }
  }
  function emit(type, data) {
    seq += 1
    const ev = { type, data: Object.assign({ type, sequence_number: seq }, data) }
    events.push(ev)
    return ev
  }
  function one(type, data) { return encodeSSE(emit(type, data)) }
  function ensureText(itemId) {
    if (textState) return ''
    const outIndex = nextIndex++
    const id = itemId || rid('msg_')
    textState = { id, outIndex, text: '' }
    return one('response.output_item.added', {
      output_index: outIndex,
      item: { id, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
    }) + one('response.content_part.added', {
      item_id: id, output_index: outIndex, content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    })
  }
  function ensureTool() {
    if (!toolState) throw new Error('toolArgsDelta/endToolCall 之前必须先 beginToolCall')
    return toolState
  }

  return {
    id: responseId,
    model,
    events,
    get sequenceNumber() { return seq },

    created() { return one('response.created', { response: baseResponse('in_progress') }) },
    inProgress() { return one('response.in_progress', { response: baseResponse('in_progress') }) },

    beginMessage(itemId) { return ensureText(itemId) },
    textDelta(delta) {
      const d = delta == null ? '' : String(delta)
      let frames = ensureText(null)
      textState.text += d
      frames += one('response.output_text.delta', {
        item_id: textState.id, output_index: textState.outIndex, content_index: 0, delta: d,
      })
      return frames
    },
    endMessage(text) {
      let frames = ensureText(null)
      const finalText = text == null ? textState.text : String(text)
      frames += one('response.output_text.done', {
        item_id: textState.id, output_index: textState.outIndex, content_index: 0, text: finalText,
      })
      frames += one('response.content_part.done', {
        item_id: textState.id, output_index: textState.outIndex, content_index: 0,
        part: { type: 'output_text', text: finalText, annotations: [] },
      })
      frames += one('response.output_item.done', {
        output_index: textState.outIndex,
        item: { id: textState.id, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: finalText, annotations: [] }] },
      })
      textState = null
      return frames
    },

    beginToolCall(call) {
      const c = call || {}
      const outIndex = nextIndex++
      const id = c.id || rid(c.type === 'custom_tool_call' ? 'ctc_' : 'fc_')
      toolState = { id, outIndex, callId: c.call_id || c.callId || '', name: c.name || '', args: '', type: c.type || 'function_call' }
      return one('response.output_item.added', {
        output_index: outIndex,
        item: { id, type: toolState.type, status: 'in_progress', call_id: toolState.callId, name: toolState.name, arguments: '' },
      })
    },
    toolArgsDelta(delta) {
      const t = ensureTool()
      const d = delta == null ? '' : String(delta)
      t.args += d
      return one('response.function_call_arguments.delta', {
        item_id: t.id, output_index: t.outIndex, delta: d,
      })
    },
    endToolCall(argumentsText) {
      const t = ensureTool()
      const finalArgs = argumentsText == null ? t.args : String(argumentsText)
      let frames = one('response.function_call_arguments.done', {
        item_id: t.id, output_index: t.outIndex, arguments: finalArgs,
      })
      frames += one('response.output_item.done', {
        output_index: t.outIndex,
        item: { id: t.id, type: t.type, status: 'completed', call_id: t.callId, name: t.name, arguments: finalArgs },
      })
      toolState = null
      return frames
    },

    completed(response) {
      const r = response || baseResponse('completed')
      return one('response.completed', { response: Object.assign({}, r, { status: r.status || 'completed' }) })
    },
    failed(error) {
      const e = isPlainObject(error) ? error : { code: 'gateway_error', message: String(error == null ? 'stream failed' : error) }
      const err = { code: e.code || 'gateway_error', message: e.message || 'stream failed' }
      const resp = Object.assign(baseResponse('failed'), { error: err })
      return one('response.failed', { response: resp, error: err })
    },
  }
}
