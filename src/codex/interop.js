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
