// Codex 原生 Multi-Agent V2 ↔ 目标上游的纯映射层（MG-017 task-2 / responses-mapping）。
// 契约：docs/contracts/codex-multi-agent-v2.md §4.1（冻结接口）与 §5（线级规则、§5.1 marker 矩阵）。
// 设计约束：
//  · 纯函数、零 import、零第三方依赖，可被 node --test 直接 import；
//  · 只依据“本轮已声明的工具身份”做明文判定，不读 UA、不按名字相似猜测、不信任上游任意字段；
//  · 无法证明明文 / 无法配对 / 无法保真的载荷一律显式拒绝（400 且不出网），绝不猜测、绝不解密；
//  · 所有函数不修改传入对象/数组；返回值均为新对象（clone）。
//
// 真实抓线校准（Codex 0.167.0，Lead 实测）：
//  · tools[] 为 {type:"namespace", name:"collaboration", tools:[6 个 function]}；只有
//    spawn_agent / send_message / followup_task 带 message 参数，形状 {type:"string",description,encrypted:true}；
//  · 声明投影 = 删除 parameters.properties.message.encrypted + 把 namespace 工具扁平化为普通 function；
//  · 历史完成项带 namespace:"collaboration" 但 encrypted_function_args 被 Codex 出站清理删除，
//    因此“缺失 marker”按普通历史项处理，不得补 marker（只有“本轮明文声明的三工具 + 完成项 + 参数可判定”才补 []）。
//  · collaboration namespace 下 6 个工具全部参与 plan→restore 身份映射：完成项一律恢复 namespace 与原名，
//    否则 Codex 报 unsupported call（原版 0.167.0 实测）。只有三个消息工具允许补 encrypted_function_args: []；
//    wait_agent / list_agents / interrupt_agent 与 custom 工具不得携带该字段。
//  · 普通 function（exec_command / read_file 等）完成项绝不添加 namespace
//    （Codex 会把 namespace+name 拼成 collaboration<name> 去找工具）。
//
// lossy 代码（稳定字符串，供日志/诊断依赖；本模块不静默丢弃不可证明的明文）：
//   include_dropped:<csv>            信封 include 中可安全丢弃项（reasoning.encrypted_content / output_text.logprobs）
//   agent_message_projected          agent_message 已按明文投影为标准 user message
//   agent_message_metadata_dropped   投影时丢弃 internal_chat_message_metadata_passthrough
//   reasoning_dropped                route.history.reasoning === 'drop'，reasoning item 被省略
//   compaction_dropped               route.history.compaction === 'drop'，compaction item 被省略
//   tool_choice_unmapped             无法映射的 tool_choice 形状，原样透传给上游（由上游裁决）
//
// 拒绝码（返回 rejected.code；调用方应转 400 且零上游请求）：
//   invalid_envelope                 请求体不是对象 / model 非字符串 / input 非字符串或数组
//   unsupported_parameter            store=true / background=true / previous_response_id 非空 / truncation≠disabled / include 不可丢弃
//   invalid_tools                    tools 非数组、工具项非法或缺 name
//   tool_identity_conflict           同一上游名对应两个不同工具身份（含别名再次冲突）
//   tool_call_pairing                工具调用配对失败：缺 call_id、孤立/重复 output、重复 call、kind 不匹配、同名歧义
//   opaque_function_args             非空/非法形状 encrypted_function_args、未知字段、参数非字符串或非 JSON 明文
//   agent_message_unsupported        route.history.agentMessage === 'reject'
//   opaque_agent_message             agent_message 含非空 encrypted_content、未知字段、非字符串正文/part
//   reasoning_unsupported            route.history.reasoning === 'reject'
//   unsupported_input_item           compaction（route 拒绝）与未知 input item 类型
//
// 接口补充（不改变 §4.1 冻结签名）：
//  · buildToolPlan(tools, route, toolChoice?) 第三个参数可选；也接受请求体形状
//    { tools, tool_choice }（因为冻结签名没有单独的 tool_choice 入口，而 plan.toolChoice 必须已映射）。
//  · plan.declared 以“上游实际看到的扁平名”为 key；entry = { kind, name, namespace, messagePlaintext, restoredName }。
//  · namespace 工具（6 个）被扁平化后，projectOrderedHistory 会去掉目标不认识的 namespace /
//    encrypted_function_args 字段；回程由 restoreToolItem 依据 plan 恢复 namespace/name。
//    只有三个消息工具在完成项补 encrypted_function_args: []，其余 namespace 工具绝不携带该字段。
//  · encrypted_function_args === null 按 §5.1“未声明语义”原样返回（不补、不拒）。
//  · status 缺失按已完成处理（兼容非流式 JSON 可能省略 status）；status==='in_progress' 视为 added，只恢复身份。

export const COLLABORATION_TOOLS = Object.freeze(['spawn_agent', 'send_message', 'followup_task'])

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

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

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
        declared.set(upstreamName, { kind: 'namespace', name, namespace: ns, messagePlaintext, restoredName: name })
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
      declared.set(name, { kind: type, name, namespace: null, messagePlaintext: false, restoredName: name })
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
    return { rejected: rejected('opaque_agent_message', 'agent_message 含非空 encrypted_content（密文/未知来源，绝不解密）') }
  }
  if (own(item, 'author') && item.author != null && typeof item.author !== 'string') {
    return { rejected: rejected('opaque_agent_message', 'agent_message.author 不是字符串') }
  }
  if (own(item, 'recipient') && item.recipient != null && typeof item.recipient !== 'string') {
    return { rejected: rejected('opaque_agent_message', 'agent_message.recipient 不是字符串') }
  }
  let body = ''
  if (typeof item.content === 'string') {
    body = item.content
  } else if (Array.isArray(item.content)) {
    for (const part of item.content) {
      if (!isPlainObject(part)) {
        return { rejected: rejected('opaque_agent_message', 'agent_message.content 含非对象 part') }
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
    if (type === 'message' || (type == null && own(item, 'role'))) {
      out.push(clone(item))
      continue
    }
    if (type === 'agent_message') {
      const projected = projectAgentMessage(item, history.agentMessage, lossy)
      if (projected.rejected) return { input: null, lossy, rejected: projected.rejected }
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
