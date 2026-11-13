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
//
// E4（v2 子代理互操作，src/codex/interop.js）新增稳定代码：
//   unsupported_tool                工具无法用 Chat 表达（托管工具 / 空 namespace / 展开失败）
//   v2_encrypted_task_unsupported   请求含加密 v2 子代理任务（encrypted_content / encrypted_task_id），
//                                   Chat 桥无法保证可读 -> 显式拒绝；不解析/不删除/不伪造密文
//   tool_call_missing_call_id       历史里的 function_call 缺 call_id（无法保证配对）
// 命名空间工具在桥方向展开为 `mg_ns__<namespace>__<tool>`，回程（JSON 与 SSE 事件）还原 name+namespace。

import {
  UNSUPPORTED_TOOL,
  V2_ENCRYPTED_TASK_UNSUPPORTED,
  planChatTools,
  normalizeInputToolCall,
  collapseToolCallName,
  collapseResponseOutputItems,
  detectOpaqueV2Task,
  flattenAgentMessage,
  analyzeToolPairs,
  validateCodexResponsesEnvelope,
  buildToolPlan,
  projectOrderedHistory,
} from './codex/interop.js'

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
// ── M1-2：严格的纯原语默认 + 有名字的旧客户端兼容预设 ──
// bridge() 是纯原语：无法用 Chat 表达的请求默认 typedUnsupported；调用方必须显式选择有损模式。
// responsesToChat() 是产品便捷入口（src/index.js 当前直接调用）：默认携带下面的 LEGACY_BRIDGE_COMPAT，
// 保持旧客户端/Codex CLI 的连续性；M1-3 接线时改为显式选择（见 docs/contracts/responses-v1.md §3.5）。
export const LEGACY_BRIDGE_COMPAT = Object.freeze({
  onUnsupportedTool: 'drop',
  allowLossy: true,
})

export const UNSUPPORTED_NATIVE_PARAMETER = 'unsupported_native_parameter'
export const UNSUPPORTED_FIELD = 'unsupported_field'
export const UNSUPPORTED_CONTROL_ITEM = 'unsupported_control_item'
export const UNSUPPORTED_ALLOWED_TOOLS = 'unsupported_allowed_tools'
export const UNSUPPORTED_TOOL_CHOICE = 'unsupported_tool_choice'
export const TOOL_PAIRING_INVALID = 'tool_pairing_invalid'
export const OPAQUE_CONTINUATION_UNSUPPORTED = 'opaque_continuation_unsupported'

// 文档化的可接受有损项（在两种模式下都只记 lossy，不阻断）：
// metadata/user 不是语义内容；parallel_tool_calls/reasoning.summary 是尽力而为的约束/提示；
// text 是输出格式提示。未知字段不在此列（默认拒绝）。
const KNOWN_LOSSY_FIELDS = new Set(['metadata', 'user', 'parallel_tool_calls', 'text'])
const NATIVE_GATED_FIELDS = ['store', 'previous_response_id', 'background', 'truncation']
const PAIRING_BLOCKING_CODES = new Set(['tool_output_without_call', 'tool_output_missing_call_id', 'duplicate_call_id'])

function lossyMode(opts) {
  if (!opts || typeof opts !== 'object') return false
  if (opts.onUnsupportedTool === 'reject') return false
  if (opts.allowLossy === false) return false
  return opts.allowLossy === true || opts.onUnsupportedTool === 'drop' || opts.lossy === true
}

function nativeFieldPresent(req, field) {
  if (field === 'store') return req.store === true
  if (field === 'background') return req.background === true
  if (field === 'truncation') return req.truncation != null && req.truncation !== 'disabled'
  if (field === 'previous_response_id') return req.previous_response_id != null && String(req.previous_response_id).trim() !== ''
  return false
}

// nativeContract 由实际目标上游能力显式驱动：未提供 = 不能假设支持（明确 typedUnsupported）；
// 提供后按 supported/supportedFields 白名单，或 unsupported/unsupportedFields 黑名单，
// 或 contract.<field> === true 逐项放行。
function nativeContractAllows(contract, field) {
  if (!contract || typeof contract !== 'object') return false
  if (Array.isArray(contract.supported)) return contract.supported.includes(field)
  if (Array.isArray(contract.supportedFields)) return contract.supportedFields.includes(field)
  if (Array.isArray(contract.unsupported)) return !contract.unsupported.includes(field) && contract[field] !== false
  if (Array.isArray(contract.unsupportedFields)) return !contract.unsupportedFields.includes(field) && contract[field] !== false
  return contract[field] === true
}

function nativeGate(req, opts) {
  const contract = opts && opts.nativeContract
  for (const field of NATIVE_GATED_FIELDS) {
    if (!nativeFieldPresent(req, field)) continue
    if (nativeContractAllows(contract, field)) continue
    const why = contract
      ? 'nativeContract 未声明该能力'
      : '未提供 nativeContract（不能假设目标上游支持）'
    return {
      body: null,
      lossy: [],
      rejected: {
        code: UNSUPPORTED_NATIVE_PARAMETER,
        message: '原生 Responses 目标不支持 ' + field + '：' + why + '；请显式声明 nativeContract 或改用 Chat 桥',
      },
    }
  }
  return null
}

function scanOpaqueKeys(value, out, depth) {
  if (depth > 8 || value == null || typeof value !== 'object') return
  if (Array.isArray(value)) { for (const v of value) scanOpaqueKeys(v, out, depth + 1); return }
  for (const [key, v] of Object.entries(value)) {
    if (key === 'encrypted_content' || key === 'encrypted_task_id' || key.startsWith('encrypted_')) { out.push(key); continue }
    scanOpaqueKeys(v, out, depth + 1)
  }
}

// v2 密文的顶层/嵌套扫描（interop.detectOpaqueV2Task 只覆盖 input 项；这里补齐请求体其它位置）。
function detectTopLevelOpaque(req) {
  const fields = []
  for (const [key, value] of Object.entries(req)) {
    if (key === 'input') continue
    scanOpaqueKeys({ [key]: value }, fields, 0)
  }
  return fields
}

// “不透明 agent 任务 / 跨域 opaque continuation”：Chat 无法读取或可靠表达，
// 必须在发送前拒绝，不能 flatten 成 user 文本或静默丢弃。
function detectOpaqueContinuation(req) {
  const input = Array.isArray(req.input) ? req.input : []
  for (const item of input) {
    if (!isPlainObject(item)) continue
    if (item.type === 'agent_message') {
      const parts = Array.isArray(item.content) ? item.content : []
      const nonText = parts.filter((p) => isPlainObject(p) && typeof p.type === 'string' && !['input_text', 'output_text', 'text'].includes(p.type))
      if (nonText.length) {
        return { kind: 'agent_message_non_text', itemId: typeof item.id === 'string' ? item.id : '', partTypes: [...new Set(nonText.map((p) => p.type))] }
      }
      if (item.opaque === true || item.continuation != null || item.opaque_continuation != null) {
        return { kind: 'agent_message_opaque', itemId: typeof item.id === 'string' ? item.id : '' }
      }
    }
    if (item.type === 'item_reference' || item.type === 'continuation' || item.type === 'opaque_continuation') {
      return { kind: String(item.type), itemId: typeof item.id === 'string' ? item.id : '' }
    }
  }
  if (req.continuation != null || req.opaque_continuation != null) return { kind: 'top_level_continuation' }
  return null
}

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

// tools[] -> Chat tools[]：委托 src/codex/interop.js 做可逆展开。
// 返回 { tools, unsupported, aliases, rejected }：
//  · namespace 分组展开为 `mg_ns__<ns>__<tool>` function（回程由 chatToResponse/SSE writer 还原）；
//  · 托管工具逐项产出 unsupported_tool 错误码 + 兼容 lossy tool_dropped:<type>（不静默丢弃）；
//  · onUnsupported:'reject' 时整条 rejected（code=unsupported_tool），默认 drop 以保持真实 Codex 可用。
function mapTools(tools, lossy, opts) {
  if (tools == null) return { tools: undefined, unsupported: [], aliases: [], rejected: null }
  // 纯原语默认严格：托管工具/未知工具类型不能用 Chat 表达 → unsupported_tool；
  // 只有显式有损模式（LEGACY_BRIDGE_COMPAT / onUnsupportedTool:'drop' / allowLossy:true）才丢弃。
  const plan = planChatTools(tools, { onUnsupported: lossyMode(opts) ? 'drop' : 'reject' })
  for (const code of plan.lossy) lossy.push(code)
  return { tools: plan.chatTools, unsupported: plan.unsupported, aliases: plan.aliases, rejected: plan.rejected }
}

function allowedNamesOf(choice) {
  const list = Array.isArray(choice.allowed_tools) ? choice.allowed_tools
    : (Array.isArray(choice.tools) ? choice.tools : null)
  if (!list) return null
  const names = []
  for (const item of list) {
    if (typeof item === 'string') { names.push(item); continue }
    if (!isPlainObject(item)) return null
    let name = typeof item.name === 'string' ? item.name
      : (item.function && typeof item.function.name === 'string' ? item.function.name : '')
    if (!name) return null
    if (item.namespace != null) {
      try { name = normalizeInputToolCall({ name, namespace: item.namespace }).name } catch { return null }
    }
    names.push(name)
  }
  return names
}

// 返回 { choice } 或 { rejected }；allowed_tools 只有在“允许列表恰好等于当前全部 Chat 工具”
// 时才能用 auto/required 精确表达。子集一律不降级为 auto（否则会把作用域放宽），
// 默认 typedUnsupported；显式有损模式才允许降级并记 allowed_tools。
function mapToolChoice(choice, lossy, opts, keptToolNames) {
  if (choice == null) return { choice: undefined }
  if (choice === 'auto' || choice === 'required' || choice === 'none') return { choice }
  if (typeof choice === 'string') { lossy.push('unknown_tool_choice'); return { choice: 'auto' } }
  if (!isPlainObject(choice)) { lossy.push('unknown_tool_choice'); return { choice: 'auto' } }
  if (choice.type === 'function' || choice.type === 'custom') {
    const name = choice.name || (choice.function && choice.function.name)
    if (!name) { lossy.push('unknown_tool_choice'); return { choice: 'auto' } }
    if (choice.type === 'custom') lossy.push('custom_tool_choice')
    return { choice: { type: 'function', function: { name } } }
  }
  if (choice.type === 'allowed_tools') {
    const names = allowedNamesOf(choice)
    const kept = new Set(keptToolNames || [])
    const mode = choice.mode === 'required' ? 'required' : 'auto'
    if (names == null) {
      if (!lossyMode(opts)) {
        return { rejected: { code: UNSUPPORTED_ALLOWED_TOOLS, message: 'tool_choice.allowed_tools 形状无法解析，不能在不放宽作用域的前提下用 Chat 表达' } }
      }
      lossy.push('allowed_tools')
      return { choice: mode }
    }
    if (names.length === 0) {
      if (mode === 'required') {
        if (!lossyMode(opts)) return { rejected: { code: UNSUPPORTED_ALLOWED_TOOLS, message: 'allowed_tools 为空且 mode=required，Chat 无法表达' } }
        lossy.push('allowed_tools')
        return { choice: 'required' }
      }
      return { choice: 'none' }
    }
    const exact = names.length === kept.size && names.every((n) => kept.has(n))
    if (exact) return { choice: mode }
    if (!lossyMode(opts)) {
      return { rejected: { code: UNSUPPORTED_ALLOWED_TOOLS, message: 'tool_choice.allowed_tools 只允许工具子集；Chat 无法精确表达该作用域，拒绝以免放宽允许范围（可显式开启有损模式）' } }
    }
    lossy.push('allowed_tools')
    return { choice: mode }
  }
  lossy.push('unknown_tool_choice')
  return { choice: 'auto' }
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
 * 纯原语（M1-2）：Responses 请求 → Chat Completions 请求（Chat 桥）。
 * 默认严格：托管工具、控制项、未知字段、无法精确表达的 allowed_tools 作用域、
 * 不透明 continuation、配对不自洽的结果 → typedUnsupported，绝不静默丢弃/放宽。
 * 显式有损选项：{ onUnsupportedTool:'drop' } 或 { allowLossy:true }（有损项写入 lossy[]）。
 * opts.mode:'native'：只做原生目标契约校验；input/tools 原样交给上游，不受 Chat 桥限制。
 *   nativeContract: { store:true, previous_response_id:true, background:true, truncation:true }
 *   或 { supported:[...] } / { unsupported:[...] }；未提供 = 不能假设支持。
 * 返回 { body, lossy, rejected, unsupported, aliases, pairing, mode, signals? }。
 */
export function bridge(input, opts = {}) {
  const req = isPlainObject(input) ? input : null
  const lossy = []
  const fail = (code, message) => ({ body: null, lossy, rejected: { code, message } })
  if (!req) return fail('unsupported_parameter', '请求体必须是 JSON 对象')
  const mode = opts && opts.mode === 'native' ? 'native' : 'bridge'

  // 原生透传：上游自己解释 input/tools；字段支持性由 nativeContract 显式驱动，
  // 不把 Chat 桥的 v2/托管工具限制误加到原生分支。
  if (mode === 'native') {
    const gate = nativeGate(req, opts)
    if (gate) return { body: null, lossy, rejected: gate.rejected, unsupported: [], aliases: [], pairing: null, mode }
    return { body: null, lossy, rejected: null, unsupported: [], aliases: [], pairing: null, mode }
  }

  // —— Chat 桥契约 §3.4 / §4：必须显式拒绝的能力，不得静默忽略 ——
  if (req.store === true) return fail('unsupported_parameter', 'store 不支持：网关不保存响应（store=true）')
  if (req.previous_response_id != null && String(req.previous_response_id).trim() !== '') return fail('unsupported_parameter', 'previous_response_id 不支持：网关不维护响应续轮')
  if (req.background === true) return fail('unsupported_parameter', 'background 不支持：网关不提供后台任务')
  if (req.include != null) {
    // 真实客户端（Codex/DSH）固定发 include:["reasoning.encrypted_content"]。网关本就不产生加密推理，
    // 该项语义上等于"没有可返回的东西"——整条拒绝会让 Responses 桥对真实客户端完全不可用
    // （2026-11-09 实测 DSH 0.2.2-rc.1 因此 400）。因此只接受"丢弃后不影响正确性"的项并记 lossy；
    // 其余（图片/托管产物/未知项）仍旧显式拒绝，避免静默丢掉客户端要求的产物。
    if (!Array.isArray(req.include)) return fail('unsupported_parameter', 'include 必须是字符串数组')
    const DROPPABLE_INCLUDE = ['reasoning.encrypted_content', 'output_text.logprobs']
    for (const item of req.include) {
      if (typeof item !== 'string' || !DROPPABLE_INCLUDE.includes(item)) {
        return fail('unsupported_parameter', 'include 不支持: ' + String(item) + '（仅接受可安全丢弃的 ' + DROPPABLE_INCLUDE.join(' / ') + '）')
      }
    }
    if (req.include.length) lossy.push('include_dropped:' + req.include.join(','))
  }
  if (req.truncation != null && req.truncation !== 'disabled') return fail('unsupported_parameter', 'truncation 不支持：网关不截断对话（仅接受 disabled）')

  // E4 v2：加密子代理任务不可读 -> 显式错误；不解析/不删除/不伪造密文，也不静默降级 v1。
  // M1-2：除 input 项外，请求体顶层/其它嵌套位置的 encrypted_* 也必须扫到。
  const opaque = detectOpaqueV2Task(req)
  const topOpaque = detectTopLevelOpaque(req)
  if (opaque.opaque || topOpaque.length) {
    const kinds = [...new Set([
      ...opaque.signals.filter((s) => s.encrypted).map((s) => s.kind),
      ...topOpaque.map((k) => 'top_level:' + k),
    ])].join(',')
    return {
      body: null,
      lossy,
      rejected: {
        code: V2_ENCRYPTED_TASK_UNSUPPORTED,
        message: 'v2 子代理任务不可读：请求含加密的 ' + kinds + '（encrypted_content/encrypted_task_id）。网关不解析、不删除、不伪造密文，Chat 桥无法保证任务可读；请改用官方原生 Responses 上游，或取得授权后以明文重新委派。',
      },
      unsupported: [],
      aliases: [],
      pairing: null,
      signals: opaque.signals,
      mode,
    }
  }

  // M1-2：opaque agent 任务 / 跨域 opaque continuation 在发送前拒绝（不能 flatten 或丢弃）。
  const opaqueContinuation = detectOpaqueContinuation(req)
  if (opaqueContinuation) {
    const detail = opaqueContinuation.itemId ? '（item ' + opaqueContinuation.itemId + '）' : ''
    return {
      body: null,
      lossy,
      rejected: {
        code: OPAQUE_CONTINUATION_UNSUPPORTED,
        message: '不透明/跨域 continuation 无法用 Chat 桥可靠表达' + detail + '：网关不解析、不删除、不伪造；请改用原生 Responses 上游或先将任务明文化。',
      },
      unsupported: [],
      aliases: [],
      pairing: null,
      signals: [opaqueContinuation],
      mode,
    }
  }

  // call_id 配对诊断（M1-2）：孤儿 tool_output / 缺 call_id 的结果 / 重复 call_id 必须阻断发送，
  // 只记 lossy 会让工具结果错配到别的调用上。tool_call_without_output 不算致命（可能是待执行调用）。
  const pairing = analyzeToolPairs(req.input)
  const pairingBlock = pairing.problems.filter((p) => PAIRING_BLOCKING_CODES.has(p.code))
  if (pairingBlock.length) {
    return {
      body: null,
      lossy,
      rejected: {
        code: TOOL_PAIRING_INVALID,
        message: '工具调用配对不自洽：' + pairingBlock.map((p) => p.code).join(',') + '；拒绝发送以避免错配工具结果',
      },
      unsupported: [],
      aliases: [],
      pairing,
      mode,
    }
  }

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
      if (!isPlainObject(item)) return fail('unsupported_parameter', 'input 数组包含非法项')
      const type = item.type
      if (type === 'agent_message') {
        // 已通过 detectOpaqueV2Task：这里只剩可读文本（加密项在上面已显式拒绝，绝不解密）。
        // Codex v2 历史里的 agent_message 是"代理间消息"事件；Chat 无此 item 类型，降级为一条 user 消息，
        // 保留 author/recipient 标注并显式记 lossy，不假装等价。
        lossy.push('agent_message_text_flattened')
        messages.push({ role: 'user', content: flattenAgentMessage(item) })
        continue
      }
      if (type === 'function_call_output') {
        const out = joinTextParts(item.output, lossy)
        if (!item.call_id) lossy.push('tool_output_missing_call_id')
        messages.push({ role: 'tool', tool_call_id: item.call_id || '', content: out })
        continue
      }
      if (type === 'function_call' || type === 'custom_tool_call') {
        const name = item.name || ''
        if (!name) return fail('unsupported_parameter', 'function_call 缺少 name')
        let callName = name
        if (item.namespace != null) {
          // Codex 0.167 命名空间调用：{type:'function_call', name:'wait_agent', namespace:'collaboration'}
          // Chat 只能看到扁平名，必须与 tools 展开名一致，回程再还原。
          try { callName = normalizeInputToolCall(item).name } catch (e) {
            return { body: null, lossy, rejected: { code: UNSUPPORTED_TOOL, message: e.message }, unsupported: [], aliases: [], pairing: null, mode }
          }
          lossy.push('namespace_tool_input:' + String(item.namespace))
        }
        if (!item.call_id) lossy.push('tool_call_missing_call_id')
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
          function: { name: callName, arguments: args },
        }])
        continue
      }
      // Codex 0.167 的 resume 请求会带非对话型控制项：configuration_update（模型/配置变更）与
      // additional_tools（工具集变更）。Chat 协议没有对应表达，且它们不是用户内容——显式丢弃并记 lossy，
      // 否则同一线程切模型会被 400 直接卡死（E3 实测 turn2 失败原因）。不静默、不伪造。
      if (type === 'configuration_update' || type === 'additional_tools') {
        // M1-2：控制项默认 typedUnsupported；只有调用方显式选择有损模式才丢弃（记 input_dropped:<type>）。
        if (!lossyMode(opts)) {
          return fail(UNSUPPORTED_CONTROL_ITEM, '控制项 ' + String(type) + ' 无法用 Chat 协议表达；如需丢弃须显式开启有损模式（onUnsupportedTool:"drop" 或 allowLossy:true）')
        }
        lossy.push('input_dropped:' + String(type))
        continue
      }
      if (type === 'message' || item.role) {
        let role = item.role || 'user'
        if (role === 'developer') role = 'system'
        if (role === 'tool') {
          messages.push({ role: 'tool', tool_call_id: item.tool_call_id || item.call_id || '', content: joinTextParts(item.content, lossy) })
          continue
        }
        if (!['user', 'assistant', 'system'].includes(role)) return fail('unsupported_parameter', '不支持的 input role: ' + role)
        messages.push({ role, content: joinTextParts(item.content, lossy) })
        continue
      }
      return fail('unsupported_parameter', '不支持的 input item 类型: ' + String(type || '(缺 type)'))
    }
  } else if (req.input != null) {
    return fail('unsupported_parameter', 'input 须为字符串或数组')
  }

  let tools
  let unsupported = []
  let aliases = []
  try {
    const plan = mapTools(req.tools, lossy, opts)
    if (plan.rejected) return { body: null, lossy, rejected: plan.rejected, unsupported: plan.unsupported, aliases: plan.aliases, pairing, mode }
    tools = plan.tools
    unsupported = plan.unsupported
    aliases = plan.aliases
  } catch (e) { return fail('unsupported_parameter', e.message) }
  let toolChoice
  try {
    const mapped = mapToolChoice(req.tool_choice, lossy, opts, (tools || []).map((x) => x.function.name))
    if (mapped.rejected) return { body: null, lossy, rejected: mapped.rejected, unsupported, aliases, pairing, mode }
    toolChoice = mapped.choice
  } catch (e) { return fail('unsupported_parameter', e.message) }
  // tool_choice 点名了不存在/未下发的工具：默认拒绝（不能把作用域改成 auto），有损模式才降级并记录。
  if (toolChoice && typeof toolChoice === 'object' && toolChoice.function) {
    const kept = new Set((tools || []).map((x) => x.function.name))
    if (!kept.has(toolChoice.function.name)) {
      if (!lossyMode(opts)) {
        return { body: null, lossy, rejected: { code: UNSUPPORTED_TOOL_CHOICE, message: 'tool_choice 点名了不存在/未下发的工具 ' + toolChoice.function.name + '；拒绝以免放宽工具作用域' }, unsupported, aliases, pairing, mode }
      }
      lossy.push('tool_choice_dropped:' + toolChoice.function.name)
      toolChoice = 'auto'
    }
  }

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
    if (KNOWN_LOSSY_FIELDS.has(k)) continue
    // 未知顶层字段默认 typedUnsupported，不再静默丢进 lossy；显式有损模式才允许丢弃。
    if (!lossyMode(opts)) {
      return { body: null, lossy, rejected: { code: UNSUPPORTED_FIELD, message: '未知字段 ' + k + ' 无法映射到 Chat 协议；拒绝静默丢弃（可显式开启有损模式）' }, unsupported, aliases, pairing, mode }
    }
    lossy.push('unknown_field:' + k)
  }

  return { body, lossy, rejected: null, unsupported, aliases, pairing, mode }
}

/**
 * 产品便捷入口（src/index.js 当前直接调用）：默认携带 LEGACY_BRIDGE_COMPAT。
 * 该预设已知有损（托管工具/控制项/未知字段会被丢弃并记 lossy），仅为旧客户端与 Codex CLI
 * 的连续性保留；M1-3 接线时应改为显式选择。新代码请调用 bridge()（严格默认）或显式传 opts。
 */
export function responsesToChat(input, opts = {}) {
  return bridge(input, Object.assign({}, LEGACY_BRIDGE_COMPAT, opts))
}

/**
 * Codex 原生 V2 请求投影（P02，定向移植 7afb4dc）。
 *
 * 调用点（Lead/N01 接线）：只对显式声明 codex 路由的 `api:"responses"` 模型使用；
 * 返回的 body 是发给**单一上游**的副本，原 body 不被修改。
 *   · 信封拒绝矩阵（store/background/previous_response_id/truncation/include）；
 *   · 本轮工具声明投影（collaboration namespace 扁平化、三消息工具去 encrypted 标记）；
 *   · 有序历史投影（agent_message 仅可证明明文才投影；reasoning/compaction/控制项按 route 策略）；
 *   · 工具 call_id 配对；非空 encrypted_function_args、未知密文、不可读 agent_message 在发送前拒绝。
 *
 * generation 边界：plan 只由**本请求**的 tools 构建，restore 也只接受本请求 plan；
 * 不缓存跨请求工具身份，不把上一代 namespace 映射用于下一代。
 *
 * 返回 { body, plan, lossy, rejected }；rejected 非空时调用方必须 400 且零上游请求。
 * include / client_metadata 等字段不在本函数中删除（由接线层按目标能力与凭据边界处理）。
 */
export function prepareCodexNativeRequest(body, route) {
  const lossy = []
  const fail = (rejected) => ({ body: null, plan: null, lossy, rejected })
  if (!isPlainObject(body)) return fail({ code: 'invalid_envelope', message: '请求体必须是 JSON 对象' })
  try {
    const env = validateCodexResponsesEnvelope(body)
    for (const code of env.lossy || []) lossy.push(code)
    if (!env.ok) return fail(env.rejected)
    const planned = buildToolPlan(body.tools, route, body.tool_choice)
    for (const code of planned.lossy || []) lossy.push(code)
    if (planned.rejected) return fail(planned.rejected)
    const history = projectOrderedHistory(body.input, route, planned.plan)
    for (const code of history.lossy || []) lossy.push(code)
    if (history.rejected) return fail(history.rejected)
    const projected = Object.assign({}, body)
    projected.input = history.input
    // OpenCode Go rejects portable-only top-level controls that are specific to the
    // official target. They carry no conversation content, so drop them for third-party
    // native routes; keep them for the official branch.
    if (!(route && route.codex && route.codex.official === true)) {
      delete projected.access_programs
      delete projected.prompt_cache_key
    }
    if (planned.plan.declarations !== undefined) projected.tools = planned.plan.declarations
    else delete projected.tools
    if (planned.plan.toolChoice !== undefined) projected.tool_choice = planned.plan.toolChoice
    else delete projected.tool_choice
    return { body: projected, plan: planned.plan, lossy, rejected: null }
  } catch (e) {
    // 投影是纯函数；任何未预期异常都按发送前拒绝处理，绝不带着半投影 body 出网。
    const message = String((e && e.message) || e).slice(0, 200)
    return fail({ code: 'projection_failed', message: '原生 V2 请求投影失败: ' + message })
  }
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
    // E4：上游返回的扁平展开名（mg_ns__<ns>__<tool>）必须还原 name+namespace，
    // 否则 Codex 会按"未知工具"执行；这是可逆映射的回程一半。
    const collapsed = collapseToolCallName(name)
    const item = {
      id: rid('fc_'),
      type: 'function_call',
      status: 'completed',
      call_id: tc.id || '',
      name: collapsed.name,
      arguments: args,
    }
    if (collapsed.namespace) item.namespace = collapsed.namespace
    output.push(item)
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
  // 多工具状态：按 item id / call_id 双键索引。Chat 流的多个 tool_call 可以交错出现，
  // 不能只保留一个 toolState，否则第二个 call 的 delta 会串到第一个 item 上。
  const toolStates = new Map()
  let lastToolKey = null

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
  function toolStateOf(callOpts = {}) {
    const key = callOpts.itemId || callOpts.id || callOpts.callId || callOpts.call_id
    if (key != null) {
      const hit = toolStates.get(key)
      if (hit) return hit
    }
    if (lastToolKey != null) {
      const hit = toolStates.get(lastToolKey)
      if (hit) return hit
    }
    throw new Error('toolArgsDelta/endToolCall 之前必须先 beginToolCall')
  }
  function dropToolState(t) {
    for (const key of t.keys) toolStates.delete(key)
    if (lastToolKey != null && t.keys.includes(lastToolKey)) lastToolKey = null
  }

  return {
    id: responseId,
    model,
    events,
    get sequenceNumber() { return seq },

    created() { return one('response.created', { response: baseResponse('in_progress') }) },
    inProgress() { return one('response.in_progress', { response: baseResponse('in_progress') }) },

    beginMessage(itemId) { return ensureText(itemId) },
    textDelta(delta, callOpts = {}) {
      const d = delta == null ? '' : String(delta)
      // 同一 message item 的 id 必须贯穿 delta/done/completed.output：调用方传入 itemId 后不再重新编号。
      let frames = ensureText(callOpts.itemId || callOpts.id || null)
      textState.text += d
      frames += one('response.output_text.delta', {
        item_id: textState.id, output_index: textState.outIndex, content_index: 0, delta: d,
      })
      return frames
    },
    endMessage(text, callOpts = {}) {
      let frames = ensureText(callOpts.itemId || callOpts.id || null)
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
      const callId = c.call_id || c.callId || ''
      // E4：Chat 上游的扁平展开名回程还原为 Codex 需要的 {name, namespace}。
      const collapsed = collapseToolCallName(c.name || '')
      const state = {
        id, outIndex, callId, name: collapsed.name, namespace: collapsed.namespace,
        args: '', type: c.type || 'function_call', keys: [id],
      }
      toolStates.set(id, state)
      if (callId && callId !== id) { toolStates.set(callId, state); state.keys.push(callId) }
      lastToolKey = id
      const item = { id, type: state.type, status: 'in_progress', call_id: state.callId, name: state.name, arguments: '' }
      if (state.namespace) item.namespace = state.namespace
      return one('response.output_item.added', { output_index: outIndex, item })
    },
    toolArgsDelta(delta, callOpts = {}) {
      const t = toolStateOf(callOpts)
      const d = delta == null ? '' : String(delta)
      t.args += d
      return one('response.function_call_arguments.delta', {
        item_id: t.id, output_index: t.outIndex, delta: d,
      })
    },
    endToolCall(argumentsText, callOpts = {}) {
      const t = toolStateOf(callOpts)
      const finalArgs = argumentsText == null ? t.args : String(argumentsText)
      let frames = one('response.function_call_arguments.done', {
        item_id: t.id, output_index: t.outIndex, arguments: finalArgs,
      })
      const item = { id: t.id, type: t.type, status: 'completed', call_id: t.callId, name: t.name, arguments: finalArgs }
      if (t.namespace) item.namespace = t.namespace
      frames += one('response.output_item.done', { output_index: t.outIndex, item })
      dropToolState(t)
      return frames
    },

    completed(response) {
      const r = response || baseResponse('completed')
      const normalized = Object.assign({}, r, { status: r.status || 'completed' })
      // E4：response.completed 可能被客户端当作权威 output（实测 Codex 以 item 事件路由工具，
      // 但其它客户端可能读终态对象），因此终态里的展开名同样还原为 name+namespace。
      if (Array.isArray(normalized.output)) normalized.output = collapseResponseOutputItems(normalized.output)
      return one('response.completed', { response: normalized })
    },
    failed(error) {
      const e = isPlainObject(error) ? error : { code: 'gateway_error', message: String(error == null ? 'stream failed' : error) }
      const err = { code: e.code || 'gateway_error', message: e.message || 'stream failed' }
      const resp = Object.assign(baseResponse('failed'), { error: err })
      return one('response.failed', { response: resp, error: err })
    },
  }
}
