// Responses ↔ Chat Completions 翻译层（聚合模式的“能发现但不通”修复件）。
//
// 目的：Codex 说 Responses，聚合上游里大量模型只提供 chat/completions（OpenCode 的
// `api['chat-completions']`）。本模块把 Responses 请求翻成 Chat 请求、把 Chat 响应/流翻回
// Responses，使这些模型从「发现但不可调用」变成可调用。**不改变**任何授权/路由判定：
// 上游模型 id 由调用方给出（ctx.upstreamModel），公共 `mg-*` id 绝不出现在上游请求体。
//
// 契约（三条缝，全部纯函数；除下列 typed error 外绝不抛异常）：
//   1. responsesToChat(body, ctx)              -> { body, warnings[] }
//   2. chatToResponse(chatJson, ctx)           -> Responses 响应对象（warnings 推入 ctx.warnings）
//   3. chatSseToResponsesSse(source, ctx)      -> AsyncIterable<{type,data}>（Responses 事件包）
//   4. resolveUpstreamProtocol(record)         -> { ok, protocol, adapter } | { ok:false, code }
//
// 设计取舍（必须显式，不许假装支持）：
//   · Chat 没有的服务端状态（store / previous_response_id / include / prompt_cache_key、
//     background / truncation、reasoning 摘要、compaction、item_reference …）一律**丢弃并告警**，
//     告警字符串点名该字段：`dropped_field:<name>` / `dropped_item:<type>`。
//   · 无法用 Chat 表达的工具（托管工具 web_search/file_search/mcp/computer_* 等）丢弃并告警
//     `unsupported_tool:<type>[:<name>]`；namespace 工具由 src/codex/interop.js 的既有可逆映射展开。
//   · 只有两类输入是**硬失败**（typed error），因为静默降级会让上下文错乱：
//       缺上游模型 id（upstream_model_missing）/ 工具结果缺 call_id（tool_call_pairing）。
//   · 流式：终态恰好一个。没有 finish_reason 也没有 [DONE] 的流 = response.failed，
//     绝不把“上游断了”当成功。
//
// 未实现（明确不在本模块范围）：anthropic-messages、google-generateContent 的翻译。
// resolveUpstreamProtocol 对它们返回 typed `unsupported_protocol`，**不回落 chat**。
//
// 测试：scripts/test/offline/agg-chat-compat.test.mjs

import { createSSEFrameDecoder } from '../sse.js'
import { finishToStatus, mapUsage } from '../responses.js'
import { planChatTools, normalizeInputToolCall, collapseToolCallName } from './interop.js'

// ── typed errors ──────────────────────────────────────────────────────────────

export const UPSTREAM_MODEL_MISSING = 'upstream_model_missing'
export const INVALID_RESPONSES_BODY = 'invalid_responses_body'
export const INVALID_CHAT_RESPONSE = 'invalid_chat_response'
export const INVALID_TOOLS = 'invalid_tools'
export const TOOL_CALL_PAIRING = 'tool_call_pairing'
export const UPSTREAM_CHAT_ERROR = 'upstream_chat_error'
export const UNSUPPORTED_PROTOCOL = 'unsupported_protocol'

export class ChatCompatError extends Error {
  constructor(code, message, detail) {
    super(message)
    this.name = 'ChatCompatError'
    this.code = code
    if (detail !== undefined) this.detail = detail
  }
}

// ── 协议名 ────────────────────────────────────────────────────────────────────

export const CHAT_COMPLETIONS = 'chat-completions'
export const RESPONSES = 'responses'
export const ANTHROPIC_MESSAGES = 'anthropic-messages'
export const GOOGLE_GENERATE_CONTENT = 'google-generateContent'

// discovery.js 用 `google-generate-content`（连字符），本模块对外用 `google-generateContent`
// （与产品契约的写法一致）。两者都接受，返回永远是后者。
const PROTOCOL_ALIASES = Object.freeze({
  openai: CHAT_COMPLETIONS,
  chat: CHAT_COMPLETIONS,
  'chat-completions': CHAT_COMPLETIONS,
  chat_completions: CHAT_COMPLETIONS,
  completions: CHAT_COMPLETIONS,
  responses: RESPONSES,
  'openai-responses': RESPONSES,
  messages: ANTHROPIC_MESSAGES,
  anthropic: ANTHROPIC_MESSAGES,
  'anthropic-messages': ANTHROPIC_MESSAGES,
  anthropic_messages: ANTHROPIC_MESSAGES,
  'generate-content': GOOGLE_GENERATE_CONTENT,
  'generate_content': GOOGLE_GENERATE_CONTENT,
  'google-generate-content': GOOGLE_GENERATE_CONTENT,
  'google-generatecontent': GOOGLE_GENERATE_CONTENT,
  google: GOOGLE_GENERATE_CONTENT,
  gemini: GOOGLE_GENERATE_CONTENT,
})

const IMPLEMENTED_PROTOCOLS = new Set([CHAT_COMPLETIONS, RESPONSES])
const PUBLIC_ID_RE = /^mg[-_/]/i

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v) }
function isNonEmptyString(v) { return typeof v === 'string' && v.trim() !== '' }
function rid(prefix) { return prefix + Math.random().toString(36).slice(2, 12) }
function canonProtocolName(v) {
  const key = String(v == null ? '' : v).trim().toLowerCase()
  return PROTOCOL_ALIASES[key] || ''
}

/**
 * 选择上游协议。返回:
 *   { ok:true, protocol, adapter, model, upstreamModel, assumed }
 *   { ok:false, code:'unsupported_protocol', protocol, model, message }
 *
 * · `protocol` 缺失（无证据）时按 chat-completions 处理，但 `assumed:true` 显式标注——
 *   这是网关既有的默认（provider.api 缺省 openai），不是对 anthropic/google 的静默回落。
 * · anthropic-messages / google-generateContent 在本任务**没有适配器**：
 *   返回 ok:false + typed code，绝不返回一个只做 chat 的 adapter。
 */
export function resolveUpstreamProtocol(modelRecord) {
  const record = isPlainObject(modelRecord) ? modelRecord : {}
  const model = record.publicId || record.model || record.upstreamId || ''
  const upstreamModel = record.upstreamId || record.upstreamModel || (PUBLIC_ID_RE.test(model) ? '' : model) || ''
  const raw = record.protocol != null ? record.protocol : record.api
  if (raw == null || String(raw).trim() === '') {
    return { ok: true, protocol: CHAT_COMPLETIONS, adapter: chatAdapter(), model, upstreamModel, assumed: true, warnings: ['protocol_unspecified'] }
  }
  const protocol = canonProtocolName(raw)
  if (!protocol) {
    return {
      ok: false,
      code: UNSUPPORTED_PROTOCOL,
      protocol: String(raw),
      model,
      upstreamModel,
      warnings: [],
      message: '未知上游协议 ' + String(raw) + '，不猜测、不回落 chat',
    }
  }
  if (!IMPLEMENTED_PROTOCOLS.has(protocol)) {
    return {
      ok: false,
      code: UNSUPPORTED_PROTOCOL,
      protocol,
      model,
      upstreamModel,
      warnings: [],
      message: '协议 ' + protocol + ' 没有适配器（本任务只实现 chat-completions）；拒绝把 ' + (model || '(未知模型)') + ' 静默当 chat 路由',
    }
  }
  return {
    ok: true,
    protocol,
    // responses = 原生透传，不需要翻译；adapter 明确为 null，避免调用方误以为要转发。
    adapter: protocol === CHAT_COMPLETIONS ? chatAdapter() : null,
    model,
    upstreamModel,
    assumed: false,
    warnings: [],
  }
}

function chatAdapter() {
  return Object.freeze({
    protocol: CHAT_COMPLETIONS,
    toUpstream: responsesToChat,
    fromUpstream: chatToResponse,
    fromStream: chatSseToResponsesSse,
  })
}

// ── ctx.warnings 收集 ─────────────────────────────────────────────────────────

function warningsOf(ctx) {
  return isPlainObject(ctx) && Array.isArray(ctx.warnings) ? ctx.warnings : null
}
function warn(list, code) {
  if (list && !list.includes(code)) list.push(code)
}

// ── 1) Responses 请求 → Chat 请求 ────────────────────────────────────────────

// Chat 认得的纯文本 part 名（Responses 用 input_text/output_text，Chat 用 text）。
const TEXT_PART_TYPES = new Set(['input_text', 'output_text', 'text', 'text_delta'])
// 明确丢弃并告警的顶层字段：Chat 没有对应语义，或网关不维护该服务端状态。
const DROPPED_TOP_LEVEL = new Set([
  'store', 'previous_response_id', 'include', 'prompt_cache_key',
  'background', 'truncation', 'metadata', 'user', 'text', 'reasoning',
  'conversation', 'service_tier', 'safety_identifier', 'max_tool_calls', 'verbosity',
])
// 已映射的顶层字段（其余一律 dropped_field:<name>）。
const HANDLED_TOP_LEVEL = new Set([
  'model', 'input', 'instructions', 'tools', 'tool_choice',
  'max_output_tokens', 'temperature', 'top_p', 'stream', 'parallel_tool_calls',
])

function contentText(content, warnings, where) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) {
    warnings.push('dropped_content_shape:' + where)
    return ''
  }
  let out = ''
  for (const part of content) {
    if (typeof part === 'string') { out += part; continue }
    if (!isPlainObject(part)) { warnings.push('dropped_content_shape:' + where); continue }
    const type = typeof part.type === 'string' ? part.type : ''
    if (TEXT_PART_TYPES.has(type) || (type === '' && typeof part.text === 'string')) {
      if (typeof part.text === 'string') out += part.text
      continue
    }
    warnings.push('unsupported_content_part:' + (type || 'unknown'))
  }
  return out
}

// user 内容可以是文本，也可以带图片。图片只在能表示为 image_url 时保留；
// file_id / 其它托管引用无法用 Chat 表达 → 丢弃并告警（绝不伪造 URL）。
// 只有文本时收敛成一条字符串（兼容面最广）；出现图片才升级为 Chat 的 content 数组。
function userContent(content, warnings) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) { warnings.push('dropped_content_shape:user'); return '' }
  const blocks = []
  let hasImage = false
  let text = ''
  for (const part of content) {
    if (typeof part === 'string') { text += part; blocks.push({ type: 'text', text: part }); continue }
    if (!isPlainObject(part)) { warnings.push('dropped_content_shape:user'); continue }
    const type = typeof part.type === 'string' ? part.type : ''
    if (type === 'input_image' || type === 'image_url' || type === 'image') {
      const image = isPlainObject(part.image_url) ? part.image_url : null
      const url = image && typeof image.url === 'string' ? image.url
        : (typeof part.image_url === 'string' ? part.image_url : '')
      if (!url) {
        warnings.push('dropped_image_part:file_id')
        continue
      }
      const block = { type: 'image_url', image_url: { url } }
      if (image && typeof image.detail === 'string') block.image_url.detail = image.detail
      blocks.push(block)
      hasImage = true
      continue
    }
    if (TEXT_PART_TYPES.has(type) || (type === '' && typeof part.text === 'string')) {
      const t = typeof part.text === 'string' ? part.text : ''
      text += t
      if (t !== '') blocks.push({ type: 'text', text: t })
      continue
    }
    // input_file / input_audio / 未知 part：Chat 无对等表达。
    warnings.push('unsupported_content_part:' + (type || 'unknown'))
  }
  if (!hasImage) return text
  return blocks
}

function assistantToolCall(item, warnings) {
  const type = item.type
  const name = typeof item.name === 'string' ? item.name : ''
  if (!name) throw new ChatCompatError(TOOL_CALL_PAIRING, type + ' 缺少 name，无法翻译成 Chat tool_calls')
  let callName = name
  if (item.namespace != null) {
    try { callName = normalizeInputToolCall(item).name } catch (e) {
      throw new ChatCompatError(INVALID_TOOLS, 'namespace 工具名展开失败: ' + String((e && e.message) || e))
    }
  }
  let callId = typeof item.call_id === 'string' ? item.call_id : ''
  let args
  if (type === 'custom_tool_call') {
    const raw = item.input == null ? '' : String(item.input)
    args = JSON.stringify({ input: raw })
    warnings.push('custom_tool_call_input')
  } else {
    args = item.arguments
  }
  if (typeof args !== 'string') args = JSON.stringify(args == null ? {} : args)
  if (!callId) {
    // Chat 要求 tool_calls[].id 与随后的 tool 消息配对；没有 id 就无法可靠配对。
    throw new ChatCompatError(TOOL_CALL_PAIRING, type + ' 缺少 call_id，无法与 function_call_output 配对')
  }
  return { id: callId, type: 'function', function: { name: callName, arguments: args } }
}

// 连续 system 片段合并进同一条（instructions + developer 消息 + 多条 system）：内容不丢，
// 且不会给上游留下“两条相邻 system”这种最容易 400 的形状。
function pushSystem(messages, text) {
  if (text === '') return
  const last = messages[messages.length - 1]
  if (last && last.role === 'system' && typeof last.content === 'string') {
    last.content = last.content === '' ? text : last.content + '\n\n' + text
    return
  }
  messages.push({ role: 'system', content: text })
}

// 连续 function_call 合并进同一条 assistant 消息；已有 assistant 文本时挂到该条上
//（Chat 允许 assistant.content + tool_calls，避免出现连续两条 assistant 消息）。
function appendToolCalls(messages, calls) {
  const last = messages[messages.length - 1]
  if (last && last.role === 'assistant') {
    last.tool_calls = (last.tool_calls || []).concat(calls)
    if (last.content === undefined) last.content = null
    return
  }
  messages.push({ role: 'assistant', content: null, tool_calls: calls.slice() })
}

function mapToolChoice(choice, warnings) {
  if (choice == null) return undefined
  if (choice === 'auto' || choice === 'none' || choice === 'required') return choice
  if (!isPlainObject(choice)) { warnings.push('unknown_tool_choice'); return undefined }
  if (choice.type === 'function' || choice.type === 'custom') {
    const raw = typeof choice.name === 'string' ? choice.name
      : (isPlainObject(choice.function) && typeof choice.function.name === 'string' ? choice.function.name : '')
    if (!raw) { warnings.push('unknown_tool_choice'); return undefined }
    let name = raw
    if (choice.namespace != null) {
      try { name = normalizeInputToolCall({ name: raw, namespace: choice.namespace }).name } catch { warnings.push('unknown_tool_choice'); return undefined }
    }
    if (choice.type === 'custom') warnings.push('custom_tool_choice')
    return { type: 'function', function: { name } }
  }
  if (choice.type === 'allowed_tools') {
    // Chat 只能表达 auto/none/required，没有“仅允许子集”的写法；降级但明确告警，绝不假装作用域仍在。
    warnings.push('tool_choice_downgraded:allowed_tools')
    return choice.mode === 'required' ? 'required' : 'auto'
  }
  warnings.push('unknown_tool_choice')
  return undefined
}

function resolveUpstreamModelOf(body, ctx) {
  const explicit = isPlainObject(ctx) && typeof ctx.upstreamModel === 'string' ? ctx.upstreamModel.trim() : ''
  if (explicit) return explicit
  const requested = typeof body.model === 'string' ? body.model.trim() : ''
  if (!requested) throw new ChatCompatError(UPSTREAM_MODEL_MISSING, '缺少上游模型 id（ctx.upstreamModel）')
  if (PUBLIC_ID_RE.test(requested)) {
    throw new ChatCompatError(UPSTREAM_MODEL_MISSING, '公共模型 id ' + requested + ' 不能发往上游；调用方必须提供 ctx.upstreamModel')
  }
  return requested
}

/**
 * Responses 请求 → Chat Completions 请求。
 * ctx: { upstreamModel, warnings?: string[] }
 * 返回 { body, warnings }；warnings 是稳定字符串代码，点名每个被丢弃/降级的字段。
 * 硬失败只有：请求体不是对象、缺上游模型 id、function_call 缺 call_id、tools 形状非法。
 */
export function responsesToChat(responsesBody, ctx = {}) {
  const warnings = []
  const req = responsesBody
  if (!isPlainObject(req)) throw new ChatCompatError(INVALID_RESPONSES_BODY, '请求体必须是 JSON 对象')
  const model = resolveUpstreamModelOf(req, ctx)
  const messages = []

  if (isNonEmptyString(req.instructions)) pushSystem(messages, req.instructions)
  else if (Array.isArray(req.instructions)) {
    const text = contentText(req.instructions, warnings, 'instructions')
    pushSystem(messages, text)
  } else if (req.instructions != null) {
    warnings.push('dropped_field:instructions')
  }

  if (typeof req.input === 'string') {
    messages.push({ role: 'user', content: req.input })
  } else if (Array.isArray(req.input)) {
    for (const item of req.input) {
      if (typeof item === 'string') {
        warnings.push('input_item_string')
        messages.push({ role: 'user', content: item })
        continue
      }
      if (!isPlainObject(item)) throw new ChatCompatError(INVALID_RESPONSES_BODY, 'input 数组包含非对象项')
      const type = item.type
      if (type === 'message' || (type == null && item.role != null)) {
        let role = typeof item.role === 'string' ? item.role : 'user'
        if (role === 'developer') { role = 'system'; warnings.push('developer_role_as_system') }
        if (role === 'tool') {
          const callId = typeof item.tool_call_id === 'string' ? item.tool_call_id : (typeof item.call_id === 'string' ? item.call_id : '')
          if (!callId) throw new ChatCompatError(TOOL_CALL_PAIRING, 'role:tool 消息缺少 tool_call_id')
          messages.push({ role: 'tool', tool_call_id: callId, content: contentText(item.content, warnings, 'tool') })
          continue
        }
        if (role !== 'system' && role !== 'user' && role !== 'assistant') {
          warnings.push('dropped_item:message:' + String(role))
          continue
        }
        const content = role === 'user'
          ? userContent(item.content, warnings)
          : contentText(item.content, warnings, role)
        if (role === 'system' && typeof content === 'string') pushSystem(messages, content)
        else messages.push({ role, content })
        continue
      }
      if (type === 'function_call' || type === 'custom_tool_call') {
        appendToolCalls(messages, [assistantToolCall(item, warnings)])
        continue
      }
      if (type === 'function_call_output' || type === 'custom_tool_call_output') {
        const callId = typeof item.call_id === 'string' ? item.call_id : ''
        if (!callId) throw new ChatCompatError(TOOL_CALL_PAIRING, type + ' 缺少 call_id，无法与 tool_calls 配对')
        const output = typeof item.output === 'string' ? item.output
          : (Array.isArray(item.output) ? contentText(item.output, warnings, 'tool_output')
            : (item.output == null ? '' : JSON.stringify(item.output)))
        messages.push({ role: 'tool', tool_call_id: callId, content: output })
        continue
      }
      if (type === 'reasoning') { warnings.push('dropped_item:reasoning'); continue }
      // compaction / item_reference / agent_message / configuration_update / additional_tools / 未知
      warnings.push('dropped_item:' + String(type || '(missing_type)'))
    }
  } else if (req.input != null) {
    throw new ChatCompatError(INVALID_RESPONSES_BODY, 'input 须为字符串或数组')
  }

  const body = { model, messages }

  if (req.tools != null) {
    let plan
    try { plan = planChatTools(req.tools, { onUnsupported: 'drop' }) } catch (e) {
      throw new ChatCompatError(INVALID_TOOLS, 'tools 无法翻译: ' + String((e && e.message) || e))
    }
    for (const code of plan.lossy) warn(warnings, code)
    for (const u of plan.unsupported) {
      warnings.push('unsupported_tool:' + String(u.toolType || 'unknown') + (u.toolName ? ':' + u.toolName : ''))
    }
    if (plan.chatTools) body.tools = plan.chatTools
  }
  const toolChoice = mapToolChoice(req.tool_choice, warnings)
  if (toolChoice !== undefined) body.tool_choice = toolChoice
  if (typeof req.parallel_tool_calls === 'boolean') body.parallel_tool_calls = req.parallel_tool_calls

  if (req.max_output_tokens != null) {
    const n = Number(req.max_output_tokens)
    if (Number.isFinite(n) && n > 0) body.max_tokens = n
    else warnings.push('dropped_field:max_output_tokens')
  }
  if (typeof req.temperature === 'number') body.temperature = req.temperature
  if (typeof req.top_p === 'number') body.top_p = req.top_p
  if (typeof req.stream === 'boolean') body.stream = req.stream

  for (const key of Object.keys(req)) {
    if (HANDLED_TOP_LEVEL.has(key)) continue
    if (DROPPED_TOP_LEVEL.has(key)) { warnings.push('dropped_field:' + key); continue }
    // 未知顶层字段：绝不透传（可能改变语义），但必须点名告警，不静默。
    warnings.push('dropped_field:' + key)
  }

  return { body, warnings }
}

// ── 2) Chat 响应 → Responses 响应 ────────────────────────────────────────────

function chatText(message) {
  const c = isPlainObject(message) ? message.content : undefined
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    let out = ''
    for (const p of c) {
      if (typeof p === 'string') out += p
      else if (isPlainObject(p) && typeof p.text === 'string') out += p.text
    }
    return out
  }
  return c == null ? '' : String(c)
}

/**
 * Chat Completions 响应 JSON → Responses 响应对象。
 * ctx: { model?, id?, createdAt?, warnings?: string[] }
 *  · model 回写客户端请求名（ctx.model 优先），绝不泄漏上游 chatcmpl 身份；
 *  · choices 多于 1：只用 choices[0]，并往 ctx.warnings 里记 multiple_choices:<n>（绝不伪造额外 output）；
 *  · finish_reason=length → incomplete/max_output_tokens；content_filter → incomplete/content_filter。
 * 失败只抛 typed error（upstream_chat_error / invalid_chat_response）。
 */
export function chatToResponse(chatJson, ctx = {}) {
  const warnings = warningsOf(ctx)
  if (!isPlainObject(chatJson)) throw new ChatCompatError(INVALID_CHAT_RESPONSE, 'Chat 响应必须是 JSON 对象')
  if (isPlainObject(chatJson.error)) {
    const e = chatJson.error
    throw new ChatCompatError(
      typeof e.code === 'string' && e.code ? e.code : UPSTREAM_CHAT_ERROR,
      '上游返回错误: ' + String(e.message || e.type || 'unknown'),
    )
  }
  const choices = Array.isArray(chatJson.choices) ? chatJson.choices : null
  if (!choices || choices.length === 0) throw new ChatCompatError(INVALID_CHAT_RESPONSE, 'Chat 响应缺少 choices[0]')
  const choice = isPlainObject(choices[0]) ? choices[0] : {}
  if (choices.length > 1) warn(warnings, 'multiple_choices:' + choices.length)
  const message = isPlainObject(choice.message) ? choice.message : {}
  const text = chatText(message)
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
  const fs = finishToStatus(choice.finish_reason)

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
  for (const tc of toolCalls) {
    const fn = isPlainObject(tc) && isPlainObject(tc.function) ? tc.function : {}
    const rawName = typeof fn.name === 'string' ? fn.name : ''
    const args = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments == null ? {} : fn.arguments)
    const collapsed = collapseToolCallName(rawName)
    const item = {
      id: rid('fc_'),
      type: 'function_call',
      status: 'completed',
      call_id: typeof tc.id === 'string' ? tc.id : '',
      name: collapsed.name,
      arguments: args,
    }
    if (collapsed.namespace) item.namespace = collapsed.namespace
    output.push(item)
  }

  const response = {
    id: (isNonEmptyString(ctx.id) ? ctx.id : '') || rid('resp_'),
    object: 'response',
    created_at: Number.isFinite(ctx.createdAt) ? ctx.createdAt : (Number(chatJson.created) || Math.floor(Date.now() / 1000)),
    status: fs.status,
    model: (isNonEmptyString(ctx.model) ? ctx.model : '') || (typeof chatJson.model === 'string' ? chatJson.model : ''),
    output,
    output_text: text,
    usage: mapUsage(chatJson.usage),
  }
  if (fs.incomplete_details) response.incomplete_details = fs.incomplete_details
  return response
}

// ── 3) Chat SSE → Responses SSE ──────────────────────────────────────────────

function dataOf(frame) {
  const lines = []
  for (const line of String(frame).split('\n')) {
    if (line.startsWith('data:')) lines.push(line.slice(5).replace(/^ /, ''))
  }
  return lines.join('\n')
}

/**
 * Chat Completions SSE → Responses 事件异步迭代器。
 * source 产出原始 SSE 文本（string / Buffer / Uint8Array）；本函数自带帧解码（UTF-8、CRLF）。
 * 每个产出是 { type, data }（data 含 type + sequence_number），用 src/responses.js 的
 * encodeSSE() 就能变成 wire 帧。
 *
 * 顺序：created → (output_item.added → …delta…) × N → 每个 item 恰好一次 output_item.done
 *       → 恰好一个终态（completed | incomplete | failed）。
 * · 文本：output_item.added → content_part.added → output_text.delta* → output_text.done
 *         → content_part.done → output_item.done
 * · 工具：output_item.added → function_call_arguments.delta* → function_call_arguments.done
 *         → output_item.done（不同 call 严格分开，不合并、不重排）
 * 失败：非 JSON 帧 = malformed_chunk；choices 不是数组 = malformed_chunk；
 *       流在既无 finish_reason 又无 [DONE] 的情况下结束 = stream_truncated（绝不静默成功）。
 */
export async function* chatSseToResponsesSse(source, ctx = {}) {
  const warnings = warningsOf(ctx)
  const responseId = (isNonEmptyString(ctx.id) ? ctx.id : '') || rid('resp_')
  const createdAt = Number.isFinite(ctx.createdAt) ? ctx.createdAt : Math.floor(Date.now() / 1000)
  const requestedModel = isNonEmptyString(ctx.model) ? ctx.model : ''
  let model = requestedModel

  let seq = 0
  let nextIndex = 0
  const items = [] // 有序：{ kind:'message'|'function_call', ... , open:boolean }
  let textItem = null
  const toolItems = new Map() // chat index / call_id / name → item
  let usage = null
  let finishReason = null
  let sawDone = false
  let terminal = false
  let upstreamModelSeen = ''

  const ev = (type, data) => ({ type, data: Object.assign({ type, sequence_number: ++seq }, data) })
  const baseResponse = (status) => ({
    id: responseId, object: 'response', created_at: createdAt, status,
    model: model || upstreamModelSeen, output: [],
  })

  yield ev('response.created', { response: baseResponse('in_progress') })

  const openText = () => {
    if (textItem) return []
    const item = { kind: 'message', id: rid('msg_'), outIndex: nextIndex++, text: '', open: true }
    textItem = item
    items.push(item)
    return [
      ev('response.output_item.added', {
        output_index: item.outIndex,
        item: { id: item.id, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
      }),
      ev('response.content_part.added', {
        item_id: item.id, output_index: item.outIndex, content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      }),
    ]
  }
  const closeText = () => {
    if (!textItem || !textItem.open) return []
    const item = textItem
    item.open = false
    textItem = null
    return [
      ev('response.output_text.done', { item_id: item.id, output_index: item.outIndex, content_index: 0, text: item.text }),
      ev('response.content_part.done', {
        item_id: item.id, output_index: item.outIndex, content_index: 0,
        part: { type: 'output_text', text: item.text, annotations: [] },
      }),
      ev('response.output_item.done', {
        output_index: item.outIndex,
        item: { id: item.id, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: item.text, annotations: [] }] },
      }),
    ]
  }
  const openTool = (tc) => {
    const fn = isPlainObject(tc.function) ? tc.function : {}
    const key = Number.isInteger(tc.index) ? 'i:' + tc.index : (isNonEmptyString(tc.id) ? 'id:' + tc.id : 'n:' + String(fn.name || ''))
    const existing = toolItems.get(key)
    if (existing) {
      if (!existing.callId && isNonEmptyString(tc.id)) existing.callId = tc.id
      if (!existing.name && isNonEmptyString(fn.name)) existing.name = fn.name
      return { item: existing, frames: [] }
    }
    const item = {
      kind: 'function_call', id: rid('fc_'), outIndex: nextIndex++,
      callId: isNonEmptyString(tc.id) ? tc.id : '', name: isNonEmptyString(fn.name) ? fn.name : '',
      args: '', open: true,
    }
    toolItems.set(key, item)
    items.push(item)
    const itemAdded = { id: item.id, type: 'function_call', status: 'in_progress', call_id: item.callId, name: item.name, arguments: '' }
    const frames = []
    // 文本 item 先收口，保证 output_index / done 顺序与协议一致。
    frames.push(...closeText())
    frames.push(ev('response.output_item.added', { output_index: item.outIndex, item: itemAdded }))
    return { item, frames }
  }
  const closeTool = (item) => {
    if (!item || !item.open) return []
    item.open = false
    const collapsed = collapseToolCallName(item.name)
    const finalItem = { id: item.id, type: 'function_call', status: 'completed', call_id: item.callId, name: collapsed.name, arguments: item.args }
    if (collapsed.namespace) finalItem.namespace = collapsed.namespace
    return [
      ev('response.function_call_arguments.done', { item_id: item.id, output_index: item.outIndex, arguments: item.args }),
      ev('response.output_item.done', { output_index: item.outIndex, item: finalItem }),
    ]
  }
  const buildOutput = () => items.map((item) => {
    if (item.kind === 'message') {
      return { id: item.id, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: item.text, annotations: [] }] }
    }
    const collapsed = collapseToolCallName(item.name)
    const out = { id: item.id, type: 'function_call', status: 'completed', call_id: item.callId, name: collapsed.name, arguments: item.args }
    if (collapsed.namespace) out.namespace = collapsed.namespace
    return out
  })
  const fail = (code, message) => {
    terminal = true
    const error = { code, message }
    return ev('response.failed', {
      response: Object.assign(baseResponse('failed'), { output: [], error }),
      error,
    })
  }

  const decoder = createSSEFrameDecoder(ctx.decoderOpts || {})
  const handleFrame = function* (frame) {
    const data = dataOf(frame)
    if (data === '') return
    if (data === '[DONE]') { sawDone = true; return }
    let chunk
    try { chunk = JSON.parse(data) } catch {
      yield fail('malformed_chunk', '上游 SSE 帧不是合法 JSON')
      return
    }
    if (!isPlainObject(chunk)) { yield fail('malformed_chunk', '上游 SSE 帧不是 JSON 对象'); return }
    if (isPlainObject(chunk.error)) {
      const e = chunk.error
      yield fail(typeof e.code === 'string' && e.code ? e.code : UPSTREAM_CHAT_ERROR, '上游流错误: ' + String(e.message || e.type || 'unknown'))
      return
    }
    if (!requestedModel && typeof chunk.model === 'string' && chunk.model !== '') upstreamModelSeen = chunk.model
    if (isPlainObject(chunk.usage)) usage = chunk.usage
    const choices = chunk.choices
    if (!Array.isArray(choices)) { yield fail('malformed_chunk', '上游 SSE 帧缺少 choices'); return }
    if (choices.length === 0) return // usage-only 帧（stream_options.include_usage）
    if (choices.length > 1) warn(warnings, 'multiple_choices:' + choices.length)
    const choice = isPlainObject(choices[0]) ? choices[0] : {}
    const delta = isPlainObject(choice.delta) ? choice.delta : {}
    if (typeof choice.finish_reason === 'string' && choice.finish_reason !== '') finishReason = choice.finish_reason

    if (typeof delta.content === 'string' && delta.content !== '') {
      for (const frameOut of openText()) yield frameOut
      textItem.text += delta.content
      yield ev('response.output_text.delta', {
        item_id: textItem.id, output_index: textItem.outIndex, content_index: 0, delta: delta.content,
      })
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        if (!isPlainObject(tc)) continue
        const opened = openTool(tc)
        for (const frameOut of opened.frames) yield frameOut
        const fn = isPlainObject(tc.function) ? tc.function : {}
        const argDelta = typeof fn.arguments === 'string' ? fn.arguments
          : (fn.arguments == null ? '' : JSON.stringify(fn.arguments))
        if (argDelta === '') continue
        opened.item.args += argDelta
        yield ev('response.function_call_arguments.delta', {
          item_id: opened.item.id, output_index: opened.item.outIndex, delta: argDelta,
        })
      }
    }
  }

  try {
    for await (const chunk of source) {
      if (terminal) return
      let frames
      try { frames = decoder.push(chunk) } catch (e) {
        yield fail(typeof e.code === 'string' && e.code ? e.code : 'malformed_chunk', String((e && e.message) || e))
        return
      }
      for (const frame of frames) {
        for (const out of handleFrame(frame)) yield out
        if (terminal) return
      }
      if (sawDone) break
    }
  } catch (e) {
    if (!terminal) yield fail(typeof e.code === 'string' && e.code ? e.code : 'stream_error', String((e && e.message) || e))
    return
  }
  if (terminal) return

  if (!sawDone) {
    // 尾部残帧不合成半截事件：flush 只用于判断“上游到底结束没有”。
    try { decoder.flush() } catch { /* 尾部超限按截断处理 */ }
  }

  // 没有任何终态证据（无 finish_reason、无 [DONE]）= 截断，绝不能当成功。
  if (!sawDone && finishReason === null) {
    yield fail('stream_truncated', '上游流在没有 finish_reason 也没有 [DONE] 的情况下结束')
    return
  }

  for (const item of items) {
    if (!item.open) continue
    const frames = item.kind === 'message' ? closeText() : closeTool(item)
    for (const frameOut of frames) yield frameOut
  }

  const output = buildOutput()
  const fs = finishToStatus(finishReason)
  const response = Object.assign(baseResponse(fs.status), {
    output,
    output_text: output.filter((o) => o.type === 'message').map((o) => o.content.map((c) => c.text).join('')).join(''),
    usage: mapUsage(usage),
  })
  if (fs.incomplete_details) {
    response.incomplete_details = fs.incomplete_details
    terminal = true
    yield ev('response.incomplete', { response })
    return
  }
  terminal = true
  yield ev('response.completed', { response })
}

// ── 内部小工具导出（测试/接线用，不改变上面三条缝的语义） ──────────────────

/** 把 {type,data} 事件包编码成 wire 帧，与 src/responses.js 的 encodeSSE 等价（本模块自带一份避免循环依赖）。 */
export function encodeResponsesEvent(event) {
  const e = isPlainObject(event) ? event : {}
  return 'event: ' + String(e.type) + '\ndata: ' + JSON.stringify(e.data) + '\n\n'
}
