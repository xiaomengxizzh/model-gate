// Codex 0.167 Responses <-> Chat 工具互操作 + v2 子代理可读性判定（E4）。
//
// 契约与实测证据：docs/explanation/codex-v2-agents.md。
// 设计约束：
//  · 纯函数、零第三方依赖、不读进程状态、不发请求；可被 node --test 直接 import；
//  · 只做 wire 形状的"可逆"映射：namespace 分组展开成合法的 Chat function 名，回程再还原；
//  · 无法用 Chat 表达的工具不再"静默丢弃"：逐项产出稳定 unsupported 错误码（unsupported_tool），
//    并允许调用方切换到 onUnsupported:'reject' 让整条请求显式失败；
//  · v2 加密内容（encrypted_content / encrypted_task_id）是网关不理解的不透明数据：
//    只判定"不可读性"并给出 v2_encrypted_task_unsupported，绝不解析、删除、伪造或降级。
//
// 稳定代码：
//   unsupported_tool                 工具无法用 Chat 协议表达（托管工具/空 namespace/命名冲突等）
//   v2_encrypted_task_unsupported    请求含加密 v2 子代理任务，Chat 桥无法保证可读
//   tool_dropped:<type>              兼容既有 lossy 口径（丢弃了该类型）
//   tool_name_too_long / tool_name_invalid / tool_namespace_ambiguous  展开失败的具体原因
//   tool_call_missing_call_id        历史里 function_call 缺 call_id（无法保证配对）

export const UNSUPPORTED_TOOL = 'unsupported_tool'
export const V2_ENCRYPTED_TASK_UNSUPPORTED = 'v2_encrypted_task_unsupported'
export const WIRE_NS_PREFIX = 'mg_ns__'
export const MAX_CHAT_TOOL_NAME = 64

const NAME_RE = /^[A-Za-z0-9_-]+$/
const OPAQUE_FIELDS = ['encrypted_content', 'encrypted_task_id']

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v) }
function isNonEmptyString(v) { return typeof v === 'string' && v.trim() !== '' }
function unsupportedEntry(type, name, reason, extra) {
  return Object.assign({ code: UNSUPPORTED_TOOL, toolType: String(type || ''), toolName: typeof name === 'string' ? name : '', reason: String(reason || '') }, extra || {})
}

/**
 * namespace 内嵌 function 展开成 Chat 可接受的扁平函数名。
 * 规则（可逆且无歧义）：`mg_ns__<namespace>__<toolName>`（WIRE_NS_PREFIX + ns + "__" + name）
 *  · namespace 必须匹配 [A-Za-z0-9_-]+ 且不含保留分隔符 "__"；
 *  · 结果长度必须 <= 64（OpenAI Chat function name 上限）。
 */
export function encodeNamespacedToolName(namespace, name) {
  if (!isNonEmptyString(namespace)) throw new Error('namespace tool 缺少 name')
  if (!isNonEmptyString(name)) throw new Error('namespace 内工具缺少 name')
  if (!NAME_RE.test(namespace)) throw new Error('namespace 名称含非法字符: ' + namespace)
  if (namespace.includes('__')) throw new Error('namespace 名称含保留分隔符: ' + namespace)
  if (!NAME_RE.test(name)) throw new Error('namespace 内工具名含非法字符: ' + name)
  const wire = WIRE_NS_PREFIX + namespace + '__' + name
  if (wire.length > MAX_CHAT_TOOL_NAME) throw new Error('namespace 工具名超过 ' + MAX_CHAT_TOOL_NAME + ' 字符: ' + wire)
  return wire
}

/** 展开名 -> {namespace, name}；不是本模块展开的形态返回 null（普通 function 名原样保留）。 */
export function decodeNamespacedToolName(wireName) {
  if (typeof wireName !== 'string' || !wireName.startsWith(WIRE_NS_PREFIX)) return null
  const rest = wireName.slice(WIRE_NS_PREFIX.length)
  const at = rest.indexOf('__')
  if (at <= 0 || at >= rest.length - 2) return null
  const namespace = rest.slice(0, at)
  const name = rest.slice(at + 2)
  if (!NAME_RE.test(namespace) || !NAME_RE.test(name)) return null
  return { namespace, name }
}

/** 回程：Chat tool_call 的扁平名 -> Responses function_call 的 {name, namespace?}。 */
export function collapseToolCallName(wireName) {
  const decoded = decodeNamespacedToolName(wireName)
  return decoded ? { name: decoded.name, namespace: decoded.namespace } : { name: wireName, namespace: null }
}

/** 回程：把最终 response.output[] 里被展开的 function_call 还原成带 namespace 的 item（不改其它字段）。 */
export function collapseResponseOutputItems(output) {
  if (!Array.isArray(output)) return output
  return output.map((item) => {
    if (!isPlainObject(item)) return item
    if (item.type !== 'function_call' && item.type !== 'custom_tool_call') return item
    const c = collapseToolCallName(item.name)
    if (!c.namespace) return item
    return Object.assign({}, item, { name: c.name, namespace: c.namespace })
  })
}

function pushFunctionTool(chatTools, seen, fn, lossy) {
  if (seen.has(fn.name)) { lossy.push('duplicate_tool_name:' + fn.name); return false }
  seen.add(fn.name)
  chatTools.push({ type: 'function', function: fn })
  return true
}

function functionToolSpec(t, descriptionPrefix) {
  const name = t.name || (t.function && t.function.name)
  if (!name) throw new Error('function tool 缺少 name')
  const description = t.description != null ? String(t.description) : (t.function && t.function.description != null ? String(t.function.description) : '')
  const parameters = t.parameters || (t.function && t.function.parameters) || { type: 'object', properties: {} }
  const fn = { name, description: (descriptionPrefix || '') + description, parameters }
  if (typeof t.strict === 'boolean') fn.strict = t.strict
  return fn
}

function customToolSpec(t, name, descriptionPrefix) {
  return {
    name,
    description: (descriptionPrefix || '') + (t.description != null ? String(t.description) : '') + '（custom tool：input 为自由文本）',
    parameters: { type: 'object', properties: { input: { type: 'string', description: '自由文本输入' } }, required: ['input'] },
  }
}

/**
 * Responses tools[] -> Chat tools[]（可逆展开）。
 * 返回 { chatTools, aliases, unsupported, lossy, rejected }：
 *  · chatTools 为空时 undefined（与既有行为一致：不向上游下发空 tools）；
 *  · aliases: [{ wireName, namespace, name }]，供诊断/回程核对；
 *  · unsupported: [{ code:'unsupported_tool', toolType, toolName, reason }]，绝不静默丢弃；
 *  · opts.onUnsupported === 'reject' 时整条 rejected（code=unsupported_tool）。
 */
export function planChatTools(tools, opts = {}) {
  const onUnsupported = opts && opts.onUnsupported === 'reject' ? 'reject' : 'drop'
  const lossy = []
  const chatTools = []
  const aliases = []
  const unsupported = []
  const seen = new Set()

  const markUnsupported = (entry, lossyType) => {
    unsupported.push(entry)
    if (lossyType) lossy.push('tool_dropped:' + String(lossyType))
  }

  if (tools == null) return { chatTools: undefined, aliases, unsupported, lossy, rejected: null }
  if (!Array.isArray(tools)) throw new Error('tools 须为数组')

  for (const t of tools) {
    if (!t || typeof t !== 'object') throw new Error('tools 项须为对象')
    const type = t.type || 'function'
    if (type === 'function') {
      pushFunctionTool(chatTools, seen, functionToolSpec(t), lossy)
      continue
    }
    if (type === 'custom') {
      const name = t.name
      if (!name) throw new Error('custom tool 缺少 name')
      pushFunctionTool(chatTools, seen, customToolSpec(t, name), lossy)
      if (t.format != null) lossy.push('custom_tool_format')
      continue
    }
    if (type === 'namespace') {
      const namespace = t.name
      if (!isNonEmptyString(namespace)) throw new Error('namespace tool 缺少 name')
      const nested = Array.isArray(t.tools) ? t.tools : []
      const prefix = '[namespace ' + namespace + '] '
      let expanded = 0
      for (const n of nested) {
        if (!n || typeof n !== 'object') throw new Error('namespace 内 tools 项须为对象')
        const ntype = n.type || 'function'
        if (ntype !== 'function' && ntype !== 'custom') {
          markUnsupported(unsupportedEntry(ntype, n.name, 'namespace 内嵌工具类型无法用 Chat 表达', { namespace }), ntype)
          continue
        }
        if (!isNonEmptyString(n.name)) throw new Error('namespace 内工具缺少 name')
        let wire
        try { wire = encodeNamespacedToolName(namespace, n.name) } catch (e) {
          markUnsupported(unsupportedEntry(ntype, n.name, e.message, { namespace }), ntype)
          continue
        }
        const spec = ntype === 'custom' ? customToolSpec(n, wire, prefix) : functionToolSpec(Object.assign({}, n, { name: wire }), prefix)
        if (!pushFunctionTool(chatTools, seen, spec, lossy)) continue
        aliases.push({ wireName: wire, namespace, name: n.name })
        expanded++
        if (ntype === 'custom' && n.format != null) lossy.push('custom_tool_format')
      }
      if (expanded === 0) {
        // 兼容既有 lossy 口径：空 namespace 仍记 tool_dropped:namespace，但现在同时给出 unsupported 错误码。
        markUnsupported(unsupportedEntry('namespace', namespace, 'namespace 没有可展开的 function 工具'), 'namespace')
      }
      continue
    }
    // 托管工具（web_search / file_search / code_interpreter / mcp / computer_* / image_generation /
    // local_shell …）与未知类型：Chat 协议只能表达 function/custom，必须显式报 unsupported，不能静默丢弃。
    markUnsupported(unsupportedEntry(type, t.name, 'Chat 协议无法表达该工具类型；需要原生 Responses 上游'), type)
  }

  const result = {
    chatTools: chatTools.length ? chatTools : undefined,
    aliases,
    unsupported,
    lossy,
    rejected: null,
  }
  if (onUnsupported === 'reject' && unsupported.length) {
    result.rejected = { code: UNSUPPORTED_TOOL, message: '工具无法用 Chat 协议表达: ' + unsupported.map((u) => u.toolType + (u.toolName ? ':' + u.toolName : '')).join(', ') }
  }
  return result
}

/**
 * 请求方向：Responses function_call item（可能带 namespace）-> 扁平 Chat 工具名。
 * 返回 { name, namespace, original }；namespace 为空时 name 原样。
 */
export function normalizeInputToolCall(item) {
  if (!isPlainObject(item)) return { name: '', namespace: null, original: '' }
  const original = typeof item.name === 'string' ? item.name : ''
  if (isNonEmptyString(item.namespace)) {
    return { name: encodeNamespacedToolName(item.namespace, original), namespace: item.namespace, original }
  }
  return { name: original, namespace: null, original }
}

function collectOpaque(value, out, depth) {
  if (depth > 6 || value == null) return
  if (typeof value === 'string') {
    // 值里也可能内嵌 encrypted_content/encrypted_task_id（例如被序列化进 arguments/output 的 JSON）。
    if (/\bencrypted_(?:content|task_id)\b/.test(value)) out.push('string_value')
    return
  }
  if (Array.isArray(value)) { for (const v of value) collectOpaque(v, out, depth + 1); return }
  if (typeof value !== 'object') return
  for (const key of Object.keys(value)) {
    if (OPAQUE_FIELDS.includes(key)) { out.push(key); continue }
    collectOpaque(value[key], out, depth + 1)
  }
}

function parseJsonMaybe(text) {
  if (typeof text !== 'string' || text === '') return undefined
  try { return JSON.parse(text) } catch { return undefined }
}

/**
 * v2 任务可读性判定：请求里是否含网关无法理解的加密内容。
 * 只返回信号（字段名/位置/是否加密），绝不返回密文或任务正文。
 * 返回 { opaque, readable, signals: [{kind, itemType, itemId?, encrypted?}] }
 */
export function detectOpaqueV2Task(body) {
  const signals = []
  const input = body && Array.isArray(body.input) ? body.input : []
  // v2 子代理工具（collaboration / multi_agent_v2）。只有这些工具的
  // arguments/output 才按"不透明任务"解释，避免误伤普通工具里恰好同名的业务字段。
  const V2_AGENT_TOOLS = new Set(['spawn_agent', 'send_message', 'followup_task'])
  const callNames = new Map()
  for (const it of input) {
    if (!isPlainObject(it)) continue
    if ((it.type === 'function_call' || it.type === 'custom_tool_call') && typeof it.call_id === 'string') {
      callNames.set(it.call_id, typeof it.name === 'string' ? it.name : '')
    }
  }
  for (const item of input) {
    if (!isPlainObject(item)) continue
    const itemType = typeof item.type === 'string' ? item.type : (typeof item.role === 'string' ? 'message:' + item.role : '')
    // item 级密文字段（任意 item 类型）：存在即不可读，不依赖键名扫描的上下文。
    if ((item.encrypted_content != null && item.encrypted_content !== '') || (item.encrypted_task_id != null && item.encrypted_task_id !== '')) {
      signals.push({ kind: 'item_field', itemType, itemId: typeof item.id === 'string' ? item.id : '', encrypted: true })
    }
    if (itemType === 'agent_message') {
      const fields = []
      collectOpaque(item.content, fields, 0)
      collectOpaque({ x: item.encrypted_content, y: item.encrypted_task_id }, fields, 0)
      const encrypted = fields.length > 0
      signals.push({
        kind: 'agent_message',
        itemType,
        itemId: typeof item.id === 'string' ? item.id : '',
        encrypted,
      })
      continue
    }
    if (itemType === 'function_call' || itemType === 'custom_tool_call') {
      const toolName = typeof item.name === 'string' ? item.name : ''
      const parsed = parseJsonMaybe(item.arguments)
      const fields = []
      collectOpaque(parsed, fields, 0)
      if (fields.length && (V2_AGENT_TOOLS.has(toolName) || fields.includes('encrypted_task_id'))) {
        signals.push({ kind: 'tool_arguments', itemType, toolName, encrypted: true })
      }
      continue
    }
    if (itemType === 'function_call_output') {
      const toolName = callNames.get(typeof item.call_id === 'string' ? item.call_id : '') || ''
      const parsed = parseJsonMaybe(item.output)
      const fields = []
      collectOpaque(parsed, fields, 0)
      if (fields.length && (V2_AGENT_TOOLS.has(toolName) || fields.includes('encrypted_task_id'))) {
        signals.push({ kind: 'tool_output', itemType, toolName, encrypted: true })
      }
      continue
    }
    const own = []
    collectOpaque({ a: item.encrypted_content, b: item.encrypted_task_id }, own, 0)
    if (own.length) signals.push({ kind: 'unknown_item', itemType, encrypted: true })
  }
  const opaque = signals.some((s) => s.encrypted === true)
  return { opaque, readable: !opaque, signals }
}

/** 工具 schema 是否显式声明 encrypted:true（明文投影必须在发送前处理）。 */
export function detectEncryptedToolSchema(tools) {
  let found = false
  const walk = (value, depth) => {
    if (found || depth > 8 || value == null) return
    if (Array.isArray(value)) { for (const v of value) walk(v, depth + 1); return }
    if (typeof value !== 'object') return
    if (value.encrypted === true) { found = true; return }
    for (const v of Object.values(value)) walk(v, depth + 1)
  }
  walk(tools, 0)
  return found
}

/**
 * 可读 agent_message（只有文本 part）降级为一条 Chat user 消息。
 * 只在 detectOpaqueV2Task 判定 readable 后调用；不处理 encrypted_content。
 */
export function flattenAgentMessage(item) {
  if (!isPlainObject(item)) return ''
  let text = ''
  for (const part of Array.isArray(item.content) ? item.content : []) {
    if (typeof part === 'string') { text += part; continue }
    if (!isPlainObject(part)) continue
    if (typeof part.text === 'string') text += part.text
  }
  const who = [isNonEmptyString(item.author) ? 'author=' + item.author : '', isNonEmptyString(item.recipient) ? 'recipient=' + item.recipient : ''].filter(Boolean).join(' ')
  return who ? '[' + who + ']\n' + text : text
}

/**
 * call_id 配对诊断（请求历史）：并行调用 / 结果回填 / 缺失 id。
 * 返回 { calls, outputs, problems, ok }；problems 只含 call_id 与稳定 code，不含正文。
 */
export function analyzeToolPairs(input) {
  const calls = []
  const outputs = []
  const problems = []
  const items = Array.isArray(input) ? input : []
  for (const item of items) {
    if (!isPlainObject(item)) continue
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      const id = typeof item.call_id === 'string' ? item.call_id : ''
      calls.push({ call_id: id, name: typeof item.name === 'string' ? item.name : '', namespace: typeof item.namespace === 'string' ? item.namespace : '' })
      if (!id) problems.push({ code: 'tool_call_missing_call_id', call_id: '', name: typeof item.name === 'string' ? item.name : '' })
      continue
    }
    if (item.type === 'function_call_output' || item.role === 'tool') {
      const id = typeof item.call_id === 'string' ? item.call_id : (typeof item.tool_call_id === 'string' ? item.tool_call_id : '')
      outputs.push({ call_id: id })
      if (!id) problems.push({ code: 'tool_output_missing_call_id' })
    }
  }
  const callIds = new Map()
  for (const c of calls) {
    if (!c.call_id) continue
    if (callIds.has(c.call_id)) problems.push({ code: 'duplicate_call_id', call_id: c.call_id })
    else callIds.set(c.call_id, c)
  }
  const outputIds = new Set(outputs.map((o) => o.call_id).filter(Boolean))
  for (const c of calls) if (c.call_id && !outputIds.has(c.call_id)) problems.push({ code: 'tool_call_without_output', call_id: c.call_id })
  for (const o of outputs) if (o.call_id && !callIds.has(o.call_id)) problems.push({ code: 'tool_output_without_call', call_id: o.call_id })
  return { calls, outputs, problems, ok: problems.length === 0 }
}

// —— Codex 原生 V2 请求分类 / 有序历史（P02，定向移植 7afb4dc） ——
//
// 来源：7afb4dc src/codex-responses.js（契约 docs/contracts/codex-multi-agent-v2.md §4.1/§5）。
// 适配：并入 src/codex/interop.js 复用既有 isPlainObject；不引入 route/codex 配置读取；
//       增加显式大小/项数上限、控制项分类与 generation 边界说明。
//
// 该层只做"目标端能否保真"的判定，不发请求、不读写状态：
//   · 信封：model/input 形状 + store/background/previous_response_id/truncation/include 拒绝矩阵；
//   · 工具声明：仅把本轮声明的 collaboration namespace 扁平化；三消息工具去 encrypted 标记；
//     同名冲突用 <namespace>__<name> 确定性别名；
//   · 有序历史：逐项投影，绝不重排；agent_message 仅在可证明明文时投影；reasoning/compaction 按路由策略；
//     控制项（configuration_update/additional_tools）显式分类（默认 drop + lossy，可 preserve/reject）；
//     工具调用按 call_id 配对；非空 encrypted_function_args / 未知密文字段一律拒绝；
//   · 回程：只依据"本轮 plan"恢复 namespace/name，绝不跨请求缓存工具身份（generation 边界）。
//
// 稳定拒绝码：invalid_envelope / unsupported_parameter / invalid_tools / tool_identity_conflict /
//   tool_call_pairing / opaque_function_args / agent_message_unsupported / opaque_agent_message /
//   reasoning_unsupported / unsupported_input_item / unsupported_control_item / input_too_large。
// 稳定 lossy：include_dropped:<csv> / agent_message_projected / agent_message_metadata_dropped /
//   reasoning_dropped / compaction_dropped / control_item_dropped:<type> / tool_choice_unmapped。

// 上限只约束"发送前投影"的规模；HTTP body 上限仍由 request 层负责。
export const CODEX_MAX_INPUT_ITEMS = 10000
export const CODEX_MAX_INPUT_BYTES = 8 * 1024 * 1024
export const CODEX_CONTROL_ITEMS = Object.freeze(['configuration_update', 'additional_tools'])
const CONTROL_ITEM_TYPES = new Set(CODEX_CONTROL_ITEMS)
const OPAQUE_INPUT_TYPES = new Set(['item_reference', 'continuation', 'opaque_continuation'])

const COLLABORATION_TOOL_LIST = ['spawn_agent', 'send_message', 'followup_task']
export const COLLABORATION_TOOLS = Object.freeze(COLLABORATION_TOOL_LIST.slice())

const DEFAULT_NAMESPACE = 'collaboration'
const DROPPABLE_INCLUDE = ['reasoning.encrypted_content', 'output_text.logprobs']
const AGENT_MESSAGE_KEYS = new Set([
  'type', 'id', 'author', 'recipient', 'content', 'status',
  'internal_chat_message_metadata_passthrough', 'encrypted_content',
])
const CONTENT_PART_KEYS = new Set(['type', 'text'])
const TOOL_ITEM_KEYS = new Set([
  'type', 'id', 'status', 'call_id', 'name', 'namespace', 'arguments', 'input', 'encrypted_function_args',
])

function own(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone)
  if (isPlainObject(value)) {
    const out = {}
    for (const key of Object.keys(value)) out[key] = clone(value[key])
    return out
  }
  return value
}

function rejected(code, message) {
  return { code, message }
}

function codexOf(route) {
  return isPlainObject(route) && isPlainObject(route.codex) ? route.codex : {}
}

function historyOf(route) {
  const codex = codexOf(route)
  return isPlainObject(codex.history) ? codex.history : {}
}

function namespaceOf(route) {
  const ns = codexOf(route).namespace
  return typeof ns === 'string' && ns !== '' ? ns : DEFAULT_NAMESPACE
}

function toolType(tool) {
  if (!isPlainObject(tool)) return ''
  if (typeof tool.type === 'string' && tool.type !== '') return tool.type
  if (isPlainObject(tool.function)) return 'function'
  return ''
}

function toolName(tool) {
  if (!isPlainObject(tool)) return ''
  if (typeof tool.name === 'string' && tool.name !== '') return tool.name
  if (isPlainObject(tool.function) && typeof tool.function.name === 'string' && tool.function.name !== '') return tool.function.name
  return ''
}

function groupNamespace(tool) {
  if (!isPlainObject(tool)) return ''
  if (typeof tool.name === 'string' && tool.name !== '') return tool.name
  if (typeof tool.namespace === 'string' && tool.namespace !== '') return tool.namespace
  return ''
}

function parametersOf(tool) {
  if (!isPlainObject(tool)) return null
  if (isPlainObject(tool.parameters)) return tool.parameters
  if (isPlainObject(tool.function) && isPlainObject(tool.function.parameters)) return tool.function.parameters
  return null
}

function renameTool(tool, name) {
  const out = clone(tool)
  if (isPlainObject(out.function)) out.function.name = name
  else out.name = name
  return out
}

function stripMessageEncryption(tool) {
  const params = parametersOf(tool)
  if (!params || !isPlainObject(params.properties) || !isPlainObject(params.properties.message)) return
  const message = params.properties.message
  if (own(message, 'encrypted')) delete message.encrypted
  if (typeof message.type !== 'string' || message.type === '') message.type = 'string'
}

function makePlan(declared, declarations, toolChoice, lossy) {
  return { declared, declarations, toolChoice, lossy }
}

function isJsonArguments(value) {
  if (typeof value !== 'string') return false
  if (value === '') return true
  try { JSON.parse(value); return true } catch { return false }
}


// 显式分类 input item；只返回类别，不判定是否允许（允许性由 projectOrderedHistory 按路由决定）。
export function classifyCodexInputItem(item) {
  if (!isPlainObject(item)) return 'invalid'
  const type = item.type
  if (type === 'message' || (type == null && own(item, 'role'))) return 'message'
  if (type === 'agent_message') return 'agent_message'
  if (type === 'reasoning') return 'reasoning'
  if (type === 'compaction') return 'compaction'
  if (type === 'function_call' || type === 'custom_tool_call') return 'tool_call'
  if (type === 'function_call_output' || type === 'custom_tool_call_output') return 'tool_output'
  if (CONTROL_ITEM_TYPES.has(type)) return 'control'
  if (OPAQUE_INPUT_TYPES.has(type)) return 'opaque_continuation'
  return 'unknown'
}

function inputByteLength(input) {
  let text
  try { text = JSON.stringify(input) } catch { return Infinity }
  return typeof Buffer !== 'undefined' && typeof Buffer.byteLength === 'function'
    ? Buffer.byteLength(text, 'utf8')
    : text.length
}

// —— §4.1 validateCodexResponsesEnvelope ——

export function validateCodexResponsesEnvelope(body) {
  const lossy = []
  if (!isPlainObject(body)) {
    return { ok: false, lossy, rejected: rejected('invalid_envelope', '请求体必须是 JSON 对象') }
  }
  if (typeof body.model !== 'string' || body.model.trim() === '') {
    return { ok: false, lossy, rejected: rejected('invalid_envelope', 'model 必须是非空字符串') }
  }
  if (!(typeof body.input === 'string' || Array.isArray(body.input))) {
    return { ok: false, lossy, rejected: rejected('invalid_envelope', 'input 必须是字符串或数组') }
  }
  if (body.store === true) {
    return { ok: false, lossy, rejected: rejected('unsupported_parameter', 'store 不支持：网关不保存响应（store=true）') }
  }
  if (body.background === true) {
    return { ok: false, lossy, rejected: rejected('unsupported_parameter', 'background 不支持：网关不提供后台任务') }
  }
  if (body.previous_response_id != null && String(body.previous_response_id).trim() !== '') {
    return { ok: false, lossy, rejected: rejected('unsupported_parameter', 'previous_response_id 不支持：网关不维护响应续轮') }
  }
  if (body.truncation != null && body.truncation !== 'disabled') {
    return { ok: false, lossy, rejected: rejected('unsupported_parameter', 'truncation 不支持：网关不截断对话（仅接受 disabled）') }
  }
  if (body.include != null) {
    if (!Array.isArray(body.include)) {
      return { ok: false, lossy, rejected: rejected('unsupported_parameter', 'include 必须是字符串数组') }
    }
    for (const item of body.include) {
      if (typeof item !== 'string' || !DROPPABLE_INCLUDE.includes(item)) {
        return { ok: false, lossy, rejected: rejected('unsupported_parameter', 'include 不支持: ' + String(item) + '（仅接受 ' + DROPPABLE_INCLUDE.join(' / ') + '）') }
      }
    }
    if (body.include.length) lossy.push('include_dropped:' + body.include.join(','))
  }
  // 不校验 agent_message / reasoning / namespace 工具：那是 Chat 桥或后续投影层的语义。
  return { ok: true, lossy, rejected: null }
}

// —— §4.1 buildToolPlan ——

function lookupDeclared(name, namespaceHint, declared) {
  if (!declared || declared.size === 0 || typeof name !== 'string' || name === '') return { entry: null, upstreamName: name }
  const entries = [...declared.entries()]
  if (typeof namespaceHint === 'string' && namespaceHint !== '') {
    const matches = entries.filter(([, entry]) => entry.name === name && entry.namespace === namespaceHint)
    if (matches.length === 1) return { entry: matches[0][1], upstreamName: matches[0][0] }
    if (matches.length > 1) return { ambiguous: true }
    const direct = declared.get(name)
    if (direct && direct.namespace === namespaceHint && direct.name === name) return { entry: direct, upstreamName: name }
    return { entry: null, upstreamName: name }
  }
  const sameOriginal = entries.filter(([, entry]) => entry.name === name)
  if (sameOriginal.length > 1) return { ambiguous: true }
  const direct = declared.get(name)
  if (direct) return { entry: direct, upstreamName: name }
  if (sameOriginal.length === 1) return { entry: sameOriginal[0][1], upstreamName: sameOriginal[0][0] }
  return { entry: null, upstreamName: name }
}

function mapToolChoiceValue(choice, declared, lossy) {
  if (choice == null) return { value: undefined, declared: [] }
  if (choice === 'auto' || choice === 'required' || choice === 'none') return { value: choice, declared: [] }
  if (!isPlainObject(choice)) {
    lossy.push('tool_choice_unmapped')
    return { value: choice, declared: [] }
  }
  if (choice.type === 'function' || choice.type === 'custom') {
    const name = typeof choice.name === 'string' ? choice.name : (isPlainObject(choice.function) && typeof choice.function.name === 'string' ? choice.function.name : '')
    const hint = typeof choice.namespace === 'string' ? choice.namespace : null
    if (choice.type === 'custom' || name === '') {
      if (name === '') lossy.push('tool_choice_unmapped')
      return { value: clone(choice), declared: [] }
    }
    const found = lookupDeclared(name, hint, declared)
    if (found.ambiguous) return { rejected: rejected('tool_identity_conflict', 'tool_choice 同名歧义: ' + name) }
    if (!found.entry) {
      lossy.push('tool_choice_unmapped')
      return { value: clone(choice), declared: [] }
    }
    const out = clone(choice)
    out.name = found.upstreamName
    if (own(out, 'namespace')) delete out.namespace
    if (isPlainObject(out.function)) out.function.name = found.upstreamName
    return { value: out, declared: [found.entry] }
  }
  if (choice.type === 'allowed_tools') {
    const out = clone(choice)
    const declaredEntries = []
    if (Array.isArray(out.tools)) {
      for (const entry of out.tools) {
        if (!isPlainObject(entry)) continue
        if (entry.type !== 'function' && entry.type !== 'custom') continue
        const name = typeof entry.name === 'string' ? entry.name : (isPlainObject(entry.function) && typeof entry.function.name === 'string' ? entry.function.name : '')
        if (name === '') continue
        const hint = typeof entry.namespace === 'string' ? entry.namespace : null
        const found = lookupDeclared(name, hint, declared)
        if (found.ambiguous) return { rejected: rejected('tool_identity_conflict', 'tool_choice.allowed_tools 同名歧义: ' + name) }
        if (!found.entry) continue
        entry.name = found.upstreamName
        if (own(entry, 'namespace')) delete entry.namespace
        declaredEntries.push(found.entry)
      }
    }
    return { value: out, declared: declaredEntries }
  }
  lossy.push('tool_choice_unmapped')
  return { value: clone(choice), declared: [] }
}

export function buildToolPlan(tools, route, toolChoiceArg) {
  const lossy = []
  let list = tools
  let choice = toolChoiceArg
  if (isPlainObject(tools) && !Array.isArray(tools) && (own(tools, 'tools') || own(tools, 'tool_choice'))) {
    list = tools.tools
    if (choice === undefined) choice = tools.tool_choice
  }
  const namespace = namespaceOf(route)
  const plaintextTools = codexOf(route).plaintextTools === true

  if (list == null) {
    const plan = makePlan(new Map(), undefined, undefined, lossy)
    const mapped = mapToolChoiceValue(choice, plan.declared, lossy)
    if (mapped.rejected) return { plan: null, lossy, rejected: mapped.rejected }
    plan.toolChoice = mapped.value
    return { plan, lossy, rejected: null }
  }
  if (!Array.isArray(list)) return { plan: null, lossy, rejected: rejected('invalid_tools', 'tools 必须是数组') }

  const ordinaryNames = new Set()
  for (const tool of list) {
    if (!isPlainObject(tool)) return { plan: null, lossy, rejected: rejected('invalid_tools', 'tools 项必须是对象') }
    const type = toolType(tool)
    if (type === 'namespace') continue
    if (type === 'function' || type === 'custom') {
      const name = toolName(tool)
      if (name === '') return { plan: null, lossy, rejected: rejected('invalid_tools', type + ' tool 缺少 name') }
      ordinaryNames.add(name)
    }
  }

  const declared = new Map()
  const declarations = []
  for (const tool of list) {
    const type = toolType(tool)
    if (type === 'namespace') {
      const ns = groupNamespace(tool)
      const flatten = plaintextTools && ns !== '' && ns === namespace
      if (!flatten) {
        declarations.push(clone(tool))
        continue
      }
      const nested = Array.isArray(tool.tools) ? tool.tools : null
      if (!nested) {
        declarations.push(clone(tool))
        continue
      }
      for (const nestedTool of nested) {
        if (!isPlainObject(nestedTool)) return { plan: null, lossy, rejected: rejected('invalid_tools', 'namespace tools 项必须是对象') }
        const nestedType = toolType(nestedTool)
        if (nestedType !== 'function' && nestedType !== 'custom') {
          declarations.push(clone(nestedTool))
          continue
        }
        const name = toolName(nestedTool)
        if (name === '') return { plan: null, lossy, rejected: rejected('invalid_tools', 'namespace ' + nestedType + ' tool 缺少 name') }
        const isMessageTool = nestedType === 'function' && COLLABORATION_TOOLS.includes(name)
        let upstreamName = name
        if (ordinaryNames.has(upstreamName)) upstreamName = ns + '__' + name
        if (declared.has(upstreamName) || (upstreamName !== name && ordinaryNames.has(upstreamName))) {
          return { plan: null, lossy, rejected: rejected('tool_identity_conflict', '同一个上游工具名冲突: ' + upstreamName) }
        }
        const messagePlaintext = isMessageTool && plaintextTools
        const declaration = renameTool(nestedTool, upstreamName)
        if (own(declaration, 'namespace')) delete declaration.namespace
        if (messagePlaintext) stripMessageEncryption(declaration)
        declarations.push(declaration)
        declared.set(upstreamName, { kind: 'namespace', toolType: nestedType, name, namespace: ns, messagePlaintext, restoredName: name })
      }
      continue
    }
    if (type === 'function' || type === 'custom') {
      const name = toolName(tool)
      if (name === '') return { plan: null, lossy, rejected: rejected('invalid_tools', type + ' tool 缺少 name') }
      if (declared.has(name)) {
        return { plan: null, lossy, rejected: rejected('tool_identity_conflict', '同一个上游工具名对应两个身份: ' + name) }
      }
      declarations.push(clone(tool))
      declared.set(name, { kind: type, toolType: type, name, namespace: null, messagePlaintext: false, restoredName: name })
      continue
    }
    // 托管工具（web_search / file_search / custom format 等）不参与协作工具处理，原样透传。
    declarations.push(clone(tool))
  }

  const plan = makePlan(declared, declarations, undefined, lossy)
  const mapped = mapToolChoiceValue(choice, declared, lossy)
  if (mapped.rejected) return { plan: null, lossy, rejected: mapped.rejected }
  plan.toolChoice = mapped.value
  return { plan, lossy, rejected: null }
}

// —— §4.1 / §5 projectOrderedHistory ——

function projectAgentMessage(item, mode, lossy) {
  if (mode === 'preserve') return { item: clone(item) }
  if (mode !== 'project') {
    return { rejected: rejected('agent_message_unsupported', 'agent_message 不被该路由接受（agentMessage=' + String(mode) + '）') }
  }
  for (const key of Object.keys(item)) {
    if (!AGENT_MESSAGE_KEYS.has(key)) {
      return { rejected: rejected('opaque_agent_message', 'agent_message 含未知字段: ' + key + '（无法证明明文）') }
    }
  }
  if (own(item, 'encrypted_content') && item.encrypted_content != null && item.encrypted_content !== '') {
    // The caller explicitly opted into plaintext projection. The encrypted field is
    // never decoded or forwarded; it is dropped and the readable parts are kept.
    lossy.push('agent_message_encrypted_field_dropped')
  }
  if (own(item, 'author') && item.author != null && typeof item.author !== 'string') {
    return { rejected: rejected('opaque_agent_message', 'agent_message.author 不是字符串') }
  }
  if (own(item, 'recipient') && item.recipient != null && typeof item.recipient !== 'string') {
    return { rejected: rejected('opaque_agent_message', 'agent_message.recipient 不是字符串') }
  }
  let body = ''
  let encryptedParts = 0
  if (typeof item.content === 'string') {
    body = item.content
  } else if (Array.isArray(item.content)) {
    for (const part of item.content) {
      if (!isPlainObject(part)) {
        return { rejected: rejected('opaque_agent_message', 'agent_message.content 含非对象 part') }
      }
      if (part.type === 'encrypted_content' || own(part, 'encrypted_content')) {
        encryptedParts++
        lossy.push('agent_message_encrypted_part_dropped')
        continue
      }
      for (const key of Object.keys(part)) {
        if (!CONTENT_PART_KEYS.has(key)) {
          return { rejected: rejected('opaque_agent_message', 'agent_message content part 含未知字段: ' + key) }
        }
      }
      if (part.type !== 'input_text' && part.type !== 'text') {
        return { rejected: rejected('opaque_agent_message', 'agent_message content part 类型不可投影: ' + String(part.type)) }
      }
      if (typeof part.text !== 'string') {
        return { rejected: rejected('opaque_agent_message', 'agent_message content part.text 不是字符串') }
      }
      body += part.text
    }
  } else {
    return { rejected: rejected('opaque_agent_message', 'agent_message.content 必须是字符串或 input_text/text 数组') }
  }
  if (body === '' && encryptedParts > 0) {
    lossy.push('agent_message_dropped_opaque_only')
    return { drop: true }
  }
  if (body === '' && own(item, 'encrypted_content') && item.encrypted_content != null && item.encrypted_content !== '') {
    lossy.push('agent_message_dropped_opaque_only')
    return { drop: true }
  }
  const author = typeof item.author === 'string' && item.author !== '' ? item.author : null
  const recipient = typeof item.recipient === 'string' && item.recipient !== '' ? item.recipient : null
  const prefix = author !== null && recipient !== null ? '[agent_message from=' + author + ' to=' + recipient + ']\n' : ''
  if (own(item, 'internal_chat_message_metadata_passthrough')) lossy.push('agent_message_metadata_dropped')
  lossy.push('agent_message_projected')
  return {
    item: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: prefix + body }],
    },
  }
}

function resolveHistoryEntry(item, plan) {
  if (!isPlainObject(plan) || !(plan.declared instanceof Map) || plan.declared.size === 0) return { entry: null, upstreamName: '' }
  const name = typeof item.name === 'string' ? item.name : ''
  if (name === '') return { entry: null, upstreamName: '' }
  const entries = [...plan.declared.entries()]
  const ns = typeof item.namespace === 'string' && item.namespace !== '' ? item.namespace : null
  if (ns !== null) {
    const matches = entries.filter(([, entry]) => entry.name === name && entry.namespace === ns)
    if (matches.length === 1) return { entry: matches[0][1], upstreamName: matches[0][0] }
    if (matches.length > 1) return { ambiguous: true }
    const direct = plan.declared.get(name)
    if (direct && direct.namespace === ns && direct.name === name) return { entry: direct, upstreamName: name }
    return { entry: null, upstreamName: name }
  }
  const sameOriginal = entries.filter(([, entry]) => entry.name === name)
  if (sameOriginal.length > 1) return { ambiguous: true }
  const direct = plan.declared.get(name)
  if (direct) return { entry: direct, upstreamName: name }
  if (sameOriginal.length === 1) return { entry: sameOriginal[0][1], upstreamName: sameOriginal[0][0] }
  return { entry: null, upstreamName: name }
}

function projectToolCall(item, plan) {
  const resolved = resolveHistoryEntry(item, plan)
  if (resolved.ambiguous) {
    return { rejected: rejected('tool_call_pairing', '工具名同名歧义，无法确定身份: ' + String(item.name)) }
  }
  const marker = own(item, 'encrypted_function_args') ? item.encrypted_function_args : undefined
  if (marker !== undefined) {
    if (marker !== null && !Array.isArray(marker)) {
      return { rejected: rejected('opaque_function_args', 'encrypted_function_args 形状不可判定') }
    }
    if (Array.isArray(marker) && marker.length > 0) {
      return { rejected: rejected('opaque_function_args', '历史工具项含非空 encrypted_function_args（上游密文不可投影）') }
    }
  }
  const out = clone(item)
  if (resolved.entry) {
    out.name = resolved.upstreamName
    if (resolved.entry.namespace) {
      // 该 namespace 工具在本轮被声明为扁平 function：目标端不认识 namespace / marker。
      if (own(out, 'namespace')) delete out.namespace
      if (own(out, 'encrypted_function_args')) delete out.encrypted_function_args
    }
  }
  return { item: out, entry: resolved.entry || null }
}

export function projectOrderedHistory(input, route, plan) {
  const lossy = []
  const history = historyOf(route)
  if (typeof input === 'string') return { input, lossy, rejected: null }
  if (!Array.isArray(input)) {
    return { input: null, lossy, rejected: rejected('invalid_envelope', 'input 必须是字符串或数组') }
  }
  if (input.length > CODEX_MAX_INPUT_ITEMS) {
    return { input: null, lossy, rejected: rejected('input_too_large', 'input 项数超过上限 ' + CODEX_MAX_INPUT_ITEMS) }
  }
  if (inputByteLength(input) > CODEX_MAX_INPUT_BYTES) {
    return { input: null, lossy, rejected: rejected('input_too_large', 'input 序列化后超过上限 ' + CODEX_MAX_INPUT_BYTES + ' bytes') }
  }
  const out = []
  const calls = new Map()
  const outputs = []
  const outputSeen = new Set()

  for (const item of input) {
    if (typeof item === 'string') { out.push(item); continue }
    if (!isPlainObject(item)) {
      return { input: null, lossy, rejected: rejected('unsupported_input_item', 'input 数组包含非对象项') }
    }
    const type = item.type
    if (CONTROL_ITEM_TYPES.has(type)) {
      // Codex resume 会带非协议型控制项；它们不是内容，也不是密文。默认显式丢弃并记 lossy，
      // 避免原生上游收到未知 item；路由可显式选择 preserve（原样，交给上游裁决）或 reject。
      const mode = history.controls === 'preserve' || history.controls === 'reject' ? history.controls : 'drop'
      if (mode === 'preserve') { out.push(clone(item)); continue }
      if (mode === 'reject') {
        return { input: null, lossy, rejected: rejected('unsupported_control_item', '控制项不被该路由接受: ' + String(type)) }
      }
      lossy.push('control_item_dropped:' + String(type))
      continue
    }
    if (type === 'message' || (type == null && own(item, 'role'))) {
      out.push(clone(item))
      continue
    }
    if (type === 'agent_message') {
      const projected = projectAgentMessage(item, history.agentMessage, lossy)
      if (projected.rejected) return { input: null, lossy, rejected: projected.rejected }
      if (projected.drop) continue
      out.push(projected.item)
      continue
    }
    if (type === 'reasoning') {
      if (history.reasoning === 'preserve') {
        out.push(clone(item))
      } else if (history.reasoning === 'drop') {
        lossy.push('reasoning_dropped')
      } else {
        return { input: null, lossy, rejected: rejected('reasoning_unsupported', 'reasoning 不被该路由接受（reasoning=' + String(history.reasoning) + '）') }
      }
      continue
    }
    if (type === 'compaction') {
      if (history.compaction === 'drop') {
        lossy.push('compaction_dropped')
        continue
      }
      return { input: null, lossy, rejected: rejected('unsupported_input_item', 'compaction 不被该路由接受（compaction=' + String(history.compaction) + '）') }
    }
    if (type === 'function_call' || type === 'custom_tool_call') {
      const callId = item.call_id
      if (typeof callId !== 'string' || callId === '') {
        return { input: null, lossy, rejected: rejected('tool_call_pairing', type + ' 缺少 call_id') }
      }
      if (calls.has(callId)) {
        return { input: null, lossy, rejected: rejected('tool_call_pairing', '重复 call_id: ' + callId) }
      }
      const projected = projectToolCall(item, plan)
      if (projected.rejected) return { input: null, lossy, rejected: projected.rejected }
      calls.set(callId, { type })
      out.push(projected.item)
      continue
    }
    if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      const callId = item.call_id
      if (typeof callId !== 'string' || callId === '') {
        return { input: null, lossy, rejected: rejected('tool_call_pairing', type + ' 缺少 call_id') }
      }
      if (outputSeen.has(callId)) {
        return { input: null, lossy, rejected: rejected('tool_call_pairing', '重复工具输出 call_id: ' + callId) }
      }
      outputSeen.add(callId)
      outputs.push({ callId, type })
      out.push(clone(item))
      continue
    }
    return { input: null, lossy, rejected: rejected('unsupported_input_item', '不支持的 input item 类型: ' + String(type || '(缺 type)')) }
  }

  for (const output of outputs) {
    const call = calls.get(output.callId)
    if (!call) {
      return { input: null, lossy, rejected: rejected('tool_call_pairing', '工具输出没有对应调用: ' + output.callId) }
    }
    const expected = output.type === 'function_call_output' ? 'function_call' : 'custom_tool_call'
    if (call.type !== expected) {
      return { input: null, lossy, rejected: rejected('tool_call_pairing', '工具输出类型与调用不匹配: ' + output.callId) }
    }
  }
  return { input: out, lossy, rejected: null }
}

// —— §4.1 / §5 restoreToolItem / restoreResponseJson ——

function findNamespaceEntry(item, plan, namespace) {
  if (!isPlainObject(plan) || !(plan.declared instanceof Map) || plan.declared.size === 0) return null
  const name = typeof item.name === 'string' ? item.name : ''
  if (name === '') return null
  const viaNamespace = typeof item.namespace === 'string' && item.namespace === namespace
  const matches = [...plan.declared.entries()].filter(([upstreamName, entry]) => (
    entry.kind === 'namespace' && (upstreamName === name || (viaNamespace && entry.name === name))
  ))
  if (matches.length > 1) return { ambiguous: true }
  return matches.length === 1 ? matches[0][1] : null
}

export function restoreToolItem(item, route, plan) {
  const lossy = []
  if (!isPlainObject(item)) return { item, lossy, rejected: null }
  const type = item.type
  if (type !== 'function_call' && type !== 'custom_tool_call') return { item: clone(item), lossy, rejected: null }
  const namespace = namespaceOf(route)
  const itemNamespace = typeof item.namespace === 'string' && item.namespace !== '' ? item.namespace : null
  if (itemNamespace !== null && itemNamespace !== namespace) {
    // §5.1：非目标 namespace 不参与明文判定，原样返回。
    return { item: clone(item), lossy, rejected: null }
  }
  const entry = findNamespaceEntry(item, plan, namespace)
  if (entry && entry.ambiguous) {
    return { item: null, lossy, rejected: rejected('tool_identity_conflict', '工具身份同名歧义: ' + String(item.name)) }
  }
  if (!entry) return { item: clone(item), lossy, rejected: null }
  // 只恢复与声明 kind 匹配的调用项：namespace function -> function_call，
  // namespace custom -> custom_tool_call。同名但不同 kind 的调用不得借用身份。
  const expectedItemType = entry.toolType === 'custom' ? 'custom_tool_call' : 'function_call'
  if (type !== expectedItemType) return { item: clone(item), lossy, rejected: null }

  const hasMarker = own(item, 'encrypted_function_args')
  const marker = item.encrypted_function_args
  if (hasMarker) {
    if (marker === null) return { item: clone(item), lossy, rejected: null } // §5.1：null = 未声明语义，原样
    if (!Array.isArray(marker)) return { item: null, lossy, rejected: rejected('opaque_function_args', 'encrypted_function_args 形状不可判定') }
    if (marker.length > 0) return { item: null, lossy, rejected: rejected('opaque_function_args', '上游返回非空 encrypted_function_args（密文，不覆盖为 []）') }
  }
  for (const key of Object.keys(item)) {
    if (!TOOL_ITEM_KEYS.has(key)) {
      return { item: null, lossy, rejected: rejected('opaque_function_args', '工具项含未知字段: ' + key) }
    }
  }
  if (type === 'function_call' && !isJsonArguments(item.arguments)) {
    return { item: null, lossy, rejected: rejected('opaque_function_args', 'function_call.arguments 不是 JSON 明文字符串') }
  }

  const out = clone(item)
  out.namespace = namespace
  out.name = entry.name
  const completed = item.status === 'completed' || item.status === undefined
  if (entry.messagePlaintext && type === 'function_call' && completed) {
    if (!hasMarker) out.encrypted_function_args = []
  } else if (own(out, 'encrypted_function_args')) {
    // wait_agent / list_agents / interrupt_agent（以及 custom）：不得携带明文 marker。
    delete out.encrypted_function_args
  }
  return { item: out, lossy, rejected: null }
}

export function restoreResponseJson(json, route, plan) {
  const lossy = []
  if (!isPlainObject(json)) return { json, lossy, rejected: null }
  if (!Array.isArray(json.output)) return { json: clone(json), lossy, rejected: null }
  const output = []
  for (const item of json.output) {
    const restored = restoreToolItem(item, route, plan)
    for (const code of restored.lossy) lossy.push(code)
    if (restored.rejected) return { json: null, lossy, rejected: restored.rejected }
    output.push(restored.item)
  }
  const out = clone(json)
  out.output = output
  return { json: out, lossy, rejected: null }
}
