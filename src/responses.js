// G2：OpenAI Responses API ⇄ Chat Completions 适配 + 原生 Responses 直通。
// 零第三方依赖。原则：
//  - 无法保真表达的输入明确 422，不静默丢字段；
//  - tool / custom tool 的 call_id、arguments、item 顺序按 Codex 客户端契约输出；
//  - 流式事件顺序是隐性契约：output_item.added / content_part.added 必须先于 output_text.delta。
import { randomUUID } from 'node:crypto'

export class UnsupportedResponsesInput extends Error {
  constructor(message, code = 'unsupported_responses_input') {
    super(message)
    this.name = 'UnsupportedResponsesInput'
    this.status = 422
    this.code = code
  }
}

const id = (p) => p + '_' + randomUUID()
function nowSec() { return Math.floor(Date.now() / 1000) }
function parseArgs(s) { try { return s == null || s === '' ? null : JSON.parse(s) } catch { return null } }
const ROLE_MAP = { developer: 'system', system: 'system', user: 'user', assistant: 'assistant' }

function textParts(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) throw new UnsupportedResponsesInput('responses message content must be string or array')
  const parts = []
  for (const p of content) {
    if (!p || typeof p !== 'object') throw new UnsupportedResponsesInput('invalid responses content part')
    switch (p.type) {
      case 'input_text':
      case 'output_text':
      case 'text':
        if (typeof p.text !== 'string') throw new UnsupportedResponsesInput('text part must contain string text')
        parts.push({ type: 'text', text: p.text })
        break
      case 'input_image': {
        const url = typeof p.image_url === 'string' ? p.image_url : (p.image_url && p.image_url.url)
        if (!url) throw new UnsupportedResponsesInput('input_image needs image_url')
        const img = { url }
        const detail = typeof p.image_url === 'object' ? p.image_url.detail : p.detail
        if (detail) img.detail = detail
        parts.push({ type: 'image_url', image_url: img })
        break
      }
      case 'input_file':
        throw new UnsupportedResponsesInput('input_file is not supported by the Chat wire (upload it to the provider or use a text extraction first)', 'unsupported_input_part')
      case 'refusal':
        throw new UnsupportedResponsesInput('refusal parts are output-only and cannot be sent as input', 'unsupported_input_part')
      default:
        throw new UnsupportedResponsesInput('unsupported responses content part: ' + (p.type || '(missing)'), 'unsupported_input_part')
    }
  }
  if (parts.length && parts.every(p => p.type === 'text')) return parts.map(p => p.text).join('\n')
  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text
  return parts
}

function mapTool(t, customTools) {
  if (!t || typeof t !== 'object' || typeof t.name !== 'string' || !t.name) throw new UnsupportedResponsesInput('responses tool needs a name')
  if (t.type === 'function') {
    return { type: 'function', function: { name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {}, additionalProperties: true } } }
  }
  if (t.type === 'custom') {
    // Codex custom tool（如 apply_patch）在 Chat wire 上等价于「只有一个 input 字符串参数」的 function；
    // 回写响应时再还原为 custom_tool_call，保证客户端看到的是同一种工具。
    customTools.add(t.name)
    const props = { input: { type: 'string', description: t.description || 'raw tool input' } }
    return { type: 'function', function: { name: t.name, description: t.description || '', parameters: { type: 'object', properties: props, required: ['input'] } } }
  }
  if (t.type === 'local_shell') {
    // Codex 的 local_shell 不是普通 function；Chat wire 无法承诺语义等价，明确拒绝而不是悄悄降级。
    throw new UnsupportedResponsesInput('tool type local_shell requires a native Responses upstream; set models.<name>.responsesWire="native"', 'unsupported_tool_type')
  }
  throw new UnsupportedResponsesInput('unsupported responses tool type: ' + (t.type || '(missing)'), 'unsupported_tool_type')
}

/**
 * Responses 请求体 → Chat 请求体。
 * 返回 { body, customTools, original }；不可保真转换的输入抛 UnsupportedResponsesInput(422)。
 */
export function responsesToChat(inputBody) {
  if (!inputBody || typeof inputBody !== 'object') throw new UnsupportedResponsesInput('responses body must be a JSON object')
  const model = typeof inputBody.model === 'string' ? inputBody.model.trim() : ''
  if (!model) throw new UnsupportedResponsesInput('responses body needs model')
  if (inputBody.previous_response_id) throw new UnsupportedResponsesInput('previous_response_id is unsupported by the stateless Chat bridge; send the full input history', 'unsupported_previous_response')
  const messages = []
  if (inputBody.instructions != null) {
    if (typeof inputBody.instructions !== 'string') throw new UnsupportedResponsesInput('instructions must be a string')
    if (inputBody.instructions) messages.push({ role: 'system', content: inputBody.instructions })
  }
  const inp = typeof inputBody.input === 'string' ? [{ role: 'user', content: inputBody.input }] : inputBody.input
  if (!Array.isArray(inp)) throw new UnsupportedResponsesInput('responses input must be a string or an array of items')
  for (const item of inp) {
    if (!item || typeof item !== 'object') throw new UnsupportedResponsesInput('invalid responses input item')
    switch (item.type) {
      case 'reasoning':
        // 上游 reasoning state 不透明，Chat wire 无对应字段；显式跳过而不是伪装成 assistant 文本。
        continue
      case 'item_reference':
        throw new UnsupportedResponsesInput('item_reference requires server-side state; send the referenced item inline', 'unsupported_item_reference')
      case 'function_call':
      case 'custom_tool_call': {
        if (typeof item.name !== 'string' || !item.name) throw new UnsupportedResponsesInput('tool call item needs name')
        const callId = item.call_id || item.id
        if (!callId) throw new UnsupportedResponsesInput('tool call item needs call_id')
        const args = item.type === 'custom_tool_call' ? JSON.stringify({ input: item.input || '' }) : (typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}))
        messages.push({ role: 'assistant', content: null, tool_calls: [{ id: callId, type: 'function', function: { name: item.name, arguments: args } }] })
        continue
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        if (!item.call_id) throw new UnsupportedResponsesInput('tool output item needs call_id')
        const out = item.output
        messages.push({ role: 'tool', tool_call_id: item.call_id, content: typeof out === 'string' ? out : JSON.stringify(out == null ? '' : out) })
        continue
      }
      case undefined:
      case 'message': {
        const role = ROLE_MAP[item.role]
        if (!role) throw new UnsupportedResponsesInput('unsupported responses role: ' + (item.role || '(missing)'))
        messages.push({ role, content: textParts(item.content) })
        continue
      }
      default:
        throw new UnsupportedResponsesInput('unsupported responses input item type: ' + item.type, 'unsupported_input_item')
    }
  }
  if (!messages.length) throw new UnsupportedResponsesInput('responses input produced no messages')
  const out = { model, messages, stream: !!inputBody.stream }
  if (out.stream && inputBody.stream_options !== false) out.stream_options = { include_usage: true }
  const customTools = new Set()
  if (Array.isArray(inputBody.tools)) {
    if (!inputBody.tools.length) throw new UnsupportedResponsesInput('tools must not be an empty array')
    out.tools = inputBody.tools.map(t => mapTool(t, customTools))
  }
  const tc = inputBody.tool_choice
  if (tc === 'none' || tc === 'auto' || tc === 'required') out.tool_choice = tc
  else if (tc && typeof tc === 'object' && (tc.type === 'function' || tc.type === 'custom') && tc.name) out.tool_choice = { type: 'function', function: { name: tc.name } }
  else if (tc != null) throw new UnsupportedResponsesInput('unsupported tool_choice', 'unsupported_tool_choice')
  if (inputBody.parallel_tool_calls != null) out.parallel_tool_calls = !!inputBody.parallel_tool_calls
  if (Number.isInteger(inputBody.max_output_tokens) && inputBody.max_output_tokens > 0) out.max_tokens = inputBody.max_output_tokens
  if (typeof inputBody.temperature === 'number') out.temperature = inputBody.temperature
  if (typeof inputBody.top_p === 'number') out.top_p = inputBody.top_p
  if (inputBody.reasoning && typeof inputBody.reasoning.effort === 'string') {
    // 上游词表不同，只透传 OpenAI 兼容档位；其它档位交给模型级 effortOptions 校验
    out.reasoning_effort = inputBody.reasoning.effort
  }
  // text.format（结构化输出）→ response_format
  const fmt = inputBody.text && inputBody.text.format
  if (fmt && typeof fmt === 'object') {
    if (fmt.type === 'json_schema') {
      out.response_format = { type: 'json_schema', json_schema: { name: fmt.name || 'response', schema: fmt.schema || {}, strict: fmt.strict !== false } }
    } else if (fmt.type === 'json_object') out.response_format = { type: 'json_object' }
    else if (fmt.type !== 'text') throw new UnsupportedResponsesInput('unsupported text.format type: ' + fmt.type)
  }
  // 明确忽略的字段（store/truncation/include/metadata/service_tier）：Chat wire 无对应语义，且不影响请求内容保真。
  return { body: out, customTools, original: inputBody }
}

function toolItem(tc, customTools, status = 'completed') {
  const fn = (tc && tc.function) || {}
  const callId = tc && tc.id ? tc.id : id('call')
  const name = fn.name || ''
  if (customTools && customTools.has(name)) {
    const decoded = parseArgs(fn.arguments)
    const text = decoded && typeof decoded.input === 'string' ? decoded.input : (typeof fn.arguments === 'string' ? fn.arguments : '')
    return { id: id('ctc'), type: 'custom_tool_call', status, call_id: callId, name, input: text }
  }
  return { id: id('fc'), type: 'function_call', status, call_id: callId, name, arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {}) }
}

function usageOf(u) {
  if (!u || typeof u !== 'object') return null
  const inTok = Number(u.prompt_tokens) || Number(u.input_tokens) || 0
  const outTok = Number(u.completion_tokens) || Number(u.output_tokens) || 0
  const total = Number(u.total_tokens) || (inTok + outTok)
  const cached = (u.prompt_tokens_details && Number(u.prompt_tokens_details.cached_tokens)) || Number(u.prompt_cache_hit_tokens) || 0
  const usage = { input_tokens: inTok, output_tokens: outTok, total_tokens: total }
  if (cached > 0) usage.input_tokens_details = { cached_tokens: cached }
  return usage
}

/** 非流式 Chat 响应 → Responses 响应对象。 */
export function chatToResponses(o, requestedModel, customTools) {
  const choice = o && o.choices && o.choices[0]
  if (!choice) throw new Error('upstream chat response has no choices')
  const msg = choice.message || {}
  const output = []
  if (typeof msg.content === 'string' && msg.content.length) {
    output.push({ id: id('msg'), type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: msg.content, annotations: [] }] })
  } else if (Array.isArray(msg.content)) {
    const text = msg.content.map(p => (p && (p.text || '')) || '').join('')
    if (text) output.push({ id: id('msg'), type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] })
  }
  for (const tc of (msg.tool_calls || [])) output.push(toolItem(tc, customTools))
  const finish = choice.finish_reason
  return {
    id: id('resp'),
    object: 'response',
    created_at: nowSec(),
    status: 'completed',
    model: requestedModel || o.model || '',
    output,
    output_text: output.filter(i => i.type === 'message').map(i => i.content.map(c => c.text).join('')).join(''),
    usage: usageOf(o.usage) || { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    error: null,
    incomplete_details: finish === 'length' ? { reason: 'max_output_tokens' } : null,
  }
}

function emptyResponse(model) {
  return { id: id('resp'), object: 'response', created_at: nowSec(), status: 'in_progress', model: model || '', output: [], error: null, incomplete_details: null }
}

/**
 * Chat SSE 流 → Responses SSE 流。
 * 事件顺序契约（Codex/DSH 依赖）：
 *   response.created → response.in_progress →
 *   (message) output_item.added → content_part.added → output_text.delta* → output_text.done → content_part.done → output_item.done →
 *   (tool) output_item.added → function_call_arguments.delta* → function_call_arguments.done → output_item.done →
 *   response.completed | response.failed
 * 任何已回传给客户端的内容都不会被重放；上游失败以 response.failed 明确收尾。
 */
export async function relayChatAsResponses(client, stream, opts = {}) {
  const model = opts.model || ''
  const customTools = opts.customTools || new Set()
  const idleMs = opts.idleMs || 60000
  const log = opts.log || null
  const response = emptyResponse(model)
  let seq = 0
  let started = false
  let textStarted = false
  let text = ''
  let textItem = null
  let textIndex = -1
  let usage = null
  let done = false
  let clientGone = false
  let contentSent = false
  let buffer = ''
  let upstreamErr = null
  const toolByIndex = new Map()   // index -> {id,name,arguments,item,outputIndex,added,lastArgs}
  let idleTimer = null

  const canSend = () => !client.destroyed && !client.writableEnded
  const send = (type, data) => {
    if (!canSend()) return
    contentSent = true
    client.write('event: ' + type + '\ndata: ' + JSON.stringify(Object.assign({ type, sequence_number: seq++ }, data || {})) + '\n\n')
  }
  const start = () => {
    if (started) return
    started = true
    if (!client.headersSent) {
      client.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no',
      })
    }
    send('response.created', { response: Object.assign({}, response, { output: [] }) })
    send('response.in_progress', { response: Object.assign({}, response, { output: [] }) })
  }
  const startText = () => {
    if (textStarted) return
    start()
    textStarted = true
    textIndex = response.output.length
    textItem = { id: id('msg'), type: 'message', status: 'in_progress', role: 'assistant', content: [] }
    response.output.push(textItem)
    send('response.output_item.added', { output_index: textIndex, item: Object.assign({}, textItem) })
    send('response.content_part.added', { item_id: textItem.id, output_index: textIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
  }
  const armIdle = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => { upstreamErr = upstreamErr || new Error('upstream stream idle timeout'); try { stream.destroy() } catch {} }, idleMs)
    if (idleTimer.unref) idleTimer.unref()
  }
  const handleData = (dataStr) => {
    if (!dataStr) return
    if (dataStr.trim() === '[DONE]') { done = true; return }
    let o
    try { o = JSON.parse(dataStr) } catch { return }
    if (o && o.error) {
      upstreamErr = new Error(typeof o.error === 'string' ? o.error : (o.error.message || 'upstream SSE error'))
      return
    }
    if (o && o.usage) usage = o.usage
    for (const c of (o && o.choices) || []) {
      const d = c.delta || c.message || {}
      if (typeof d.content === 'string' && d.content.length) {
        startText()
        text += d.content
        send('response.output_text.delta', { item_id: textItem.id, output_index: textIndex, content_index: 0, delta: d.content })
      }
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const idx = Number.isInteger(tc.index) ? tc.index : 0
          let t = toolByIndex.get(idx)
          if (!t) { t = { id: '', name: '', arguments: '', item: null, outputIndex: -1, added: false, doneArgs: false }; toolByIndex.set(idx, t) }
          if (tc.id) t.id = tc.id
          if (tc.function && typeof tc.function.name === 'string' && tc.function.name) t.name += tc.function.name
          if (tc.function && typeof tc.function.arguments === 'string' && tc.function.arguments) t.arguments += tc.function.arguments
        }
      }
    }
  }
  const flushTool = (t, success) => {
    if (!t || !t.name) return
    if (!t.item) {
      t.item = toolItem({ id: t.id || id('call'), function: { name: t.name, arguments: t.arguments } }, customTools, 'in_progress')
      t.outputIndex = response.output.length
      response.output.push(t.item)
      send('response.output_item.added', { output_index: t.outputIndex, item: Object.assign({}, t.item) })
      t.added = true
    }
    const isCustom = t.item.type === 'custom_tool_call'
    if (isCustom) {
      if (t.arguments) send('response.custom_tool_call_input.delta', { item_id: t.item.id, output_index: t.outputIndex, delta: t.arguments })
      send('response.custom_tool_call_input.done', { item_id: t.item.id, output_index: t.outputIndex, input: t.arguments })
      t.item.input = t.arguments
    } else {
      if (t.arguments) send('response.function_call_arguments.delta', { item_id: t.item.id, output_index: t.outputIndex, delta: t.arguments })
      send('response.function_call_arguments.done', { item_id: t.item.id, output_index: t.outputIndex, arguments: t.arguments })
      t.item.arguments = t.arguments
    }
    t.item.status = success ? 'completed' : 'incomplete'
    send('response.output_item.done', { output_index: t.outputIndex, item: Object.assign({}, t.item) })
  }
  const finish = (success) => {
    clearTimeout(idleTimer)
    if (!started) start()
    if (textStarted) {
      send('response.output_text.done', { item_id: textItem.id, output_index: textIndex, content_index: 0, text })
      const part = { type: 'output_text', text, annotations: [] }
      send('response.content_part.done', { item_id: textItem.id, output_index: textIndex, content_index: 0, part })
      textItem.status = 'completed'
      textItem.content = [part]
      send('response.output_item.done', { output_index: textIndex, item: Object.assign({}, textItem) })
    }
    const sorted = [...toolByIndex.entries()].sort((a, b) => a[0] - b[0])
    for (const [, t] of sorted) flushTool(t, success)
    if (usage) response.usage = usageOf(usage)
    if (success) {
      response.status = 'completed'
      response.output_text = text
      send('response.completed', { response })
    } else {
      response.status = 'failed'
      response.error = { code: 'upstream_stream_error', message: String((upstreamErr && upstreamErr.message) || 'upstream stream ended without response.completed') }
      send('response.failed', { response })
    }
    if (!client.destroyed && !client.writableEnded) { try { client.end() } catch {} }
  }

  const onClose = () => {
    if (clientGone) return
    clientGone = true
    clearTimeout(idleTimer)
    try { stream.destroy() } catch {}
    log && log.warn('responses 客户端已断开，销毁上游流')
  }
  if (typeof client.on === 'function') { try { client.on('close', onClose); client.on('error', onClose) } catch {} }

  armIdle()
  try {
    for await (const chunk of stream) {
      if (clientGone || client.destroyed) break
      armIdle()
      buffer += (typeof chunk === 'string' ? chunk : chunk.toString('utf8')).replace(/\r\n/g, '\n')
      let at
      while ((at = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, at)
        buffer = buffer.slice(at + 2)
        const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n')
        handleData(data)
        if (done || upstreamErr) break
      }
      if (done || upstreamErr) break
    }
  } catch (e) {
    if (!clientGone) upstreamErr = upstreamErr || e
  }
  clearTimeout(idleTimer)
  if (clientGone) {
    if (typeof client.removeListener === 'function') { try { client.removeListener('close', onClose); client.removeListener('error', onClose) } catch {} }
    return { completed: false, contentSent, clientGone: true, reconnects: 0 }
  }
  finish(done && !upstreamErr)
  if (typeof client.removeListener === 'function') { try { client.removeListener('close', onClose); client.removeListener('error', onClose) } catch {} }
  return { completed: !!(done && !upstreamErr), contentSent, clientGone: false, reconnects: 0 }
}

/** 原生 Responses 上游直通：只做字节中继 + 终态判定，不改写事件。 */
export async function relayNativeResponses(client, stream, opts = {}) {
  const idleMs = opts.idleMs || 60000
  let completed = false, clientGone = false, contentSent = false
  let tail = ''
  let timer = null
  if (!client.headersSent) client.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => { try { stream.destroy() } catch {} }, idleMs); if (timer.unref) timer.unref() }
  const onClose = () => { clientGone = true; clearTimeout(timer); try { stream.destroy() } catch {} }
  if (typeof client.on === 'function') { try { client.on('close', onClose) } catch {} }
  arm()
  try {
    for await (const chunk of stream) {
      if (client.destroyed) { clientGone = true; break }
      arm()
      client.write(chunk)
      contentSent = true
      tail = (tail + chunk.toString('utf8')).slice(-32000)
      if (/"type"\s*:\s*"response\.completed"/.test(tail)) completed = true
    }
  } catch { /* 半截流：调用方按 completed=false 处理 */ }
  clearTimeout(timer)
  if (typeof client.removeListener === 'function') { try { client.removeListener('close', onClose) } catch {} }
  if (!clientGone && !client.writableEnded) { try { client.end() } catch {} }
  return { completed, clientGone, contentSent, reconnects: 0 }
}

export function responsesError(status, code, message, extra = {}) {
  return { status, body: Object.assign({ error: { message, type: status === 422 ? 'invalid_request_error' : 'gateway_error', code, param: null } }, extra) }
}
