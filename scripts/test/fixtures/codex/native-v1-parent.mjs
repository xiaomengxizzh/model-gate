// Synthetic Responses backend. Only the stock Codex runtime executes the agent tools.
const namespace = 'multi_agent_v1'
const unsupportedFields = new Set([
  'background', 'conversation', 'max_output_tokens', 'max_tool_calls', 'metadata',
  'moderation', 'multi_agent', 'prompt', 'prompt_cache_retention', 'safety_identifier',
  'temperature', 'top_logprobs', 'top_p', 'truncation', 'user', 'previous_response_id',
])
const unsupportedTools = new Set([
  'tool_search', 'programmatic_tool_calling', 'image_generation', 'file_search',
  'code_interpreter', 'computer', 'computer_use_preview', 'mcp',
])

function outputFor (input, callId) {
  const item = input.find((entry) => entry.type === 'function_call_output' && entry.call_id === callId)
  if (!item) return null
  const raw = typeof item.output === 'string' ? item.output
    : (Array.isArray(item.output) ? item.output.map((part) => part.text || '').join('') : '')
  if (!raw) return {}
  try { return JSON.parse(raw) } catch { return { raw } }
}

export function makeV1Parent ({ sseText, sseToolCall, getChildModel, taskA, taskB }) {
  return (res, body, state) => {
    const input = Array.isArray(body.input) ? body.input : []
    const tools = Array.isArray(body.tools) ? body.tools : []
    const directNames = tools.filter((tool) => tool.type === 'namespace' && tool.name === namespace)
      .flatMap((tool) => tool.tools || []).map((tool) => tool.name)
    const required = ['spawn_agent', 'wait_agent', 'send_input']
    state.preview ??= { requestKeys: new Set(), toolTypes: new Set(), violations: new Set() }
    for (const key of Object.keys(body)) {
      state.preview.requestKeys.add(key)
      if (unsupportedFields.has(key)) state.preview.violations.add(key)
    }
    for (const tool of tools) {
      state.preview.toolTypes.add(tool.type)
      if (unsupportedTools.has(tool.type) || unsupportedTools.has(tool.name)) {
        state.preview.violations.add(tool.type + ':' + (tool.name || tool.type))
      }
    }
    if (body.store !== false || body.stream !== true || !Array.isArray(body.input)) {
      state.preview.violations.add('HTTP transport')
    }
    if (input.some((item) => item.type === 'message' && item.role === 'system')) {
      state.preview.violations.add('system message')
    }
    const finish = (message) => sseText(res, body.model, message)
    const invoke = (name, id, args) => sseToolCall(res, body.model, id, args, { name, namespace })
    const hasDirect = required.every((name) => directNames.includes(name))
    state.nativeTools ||= hasDirect
    if (!state.nativeTools) return finish('V1_DIRECT_TOOLS_UNAVAILABLE')
    if (state.preview.violations.size) return finish('V1_PREVIEW_REQUEST_UNSUPPORTED')

    if (state.resumeExpectedHistory) {
      const textFor = (role) => input.filter((item) => item.type === 'message' && item.role === role)
        .flatMap((item) => item.content || []).map((part) => part.text || '').join('\n')
      state.resumeObserved = textFor('user').includes('MODEL_GATE_NATIVE_V1_RESUME_PROBE') &&
        textFor('assistant').includes('MODEL_GATE_NATIVE_V1_OK ' + taskA + ' ' + taskB)
      return finish(state.resumeObserved ? 'MODEL_GATE_NATIVE_V1_RESUME_OK' : 'V1_RESUME_HISTORY_MISSING')
    }
    if (!state.spawned) {
      state.spawned = true
      return invoke('spawn_agent', 'call_v1_spawn', { model: getChildModel(), fork_context: false, message: taskA })
    }
    if (!state.childId) {
      const output = outputFor(input, 'call_v1_spawn')
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(output?.agent_id || '')) return finish('V1_CHILD_ID_MISSING')
      state.childId = output.agent_id
      state.phase = 'a'
    }
    const phase = state.phase
    const expected = 'CHILD_DONE_' + (phase === 'a' ? taskA : taskB)
    const lastWait = state.lastWait?.phase === phase ? state.lastWait.id : null
    if (lastWait) {
      const output = outputFor(input, lastWait)
      if (!output) return finish('V1_WAIT_RESULT_MISSING_' + phase)
      const statuses = Object.values(output.status || {})
      const completed = statuses.length === 1 ? statuses[0]?.completed : null
      if (completed === expected && output.timed_out === false) {
        state['receipt_' + phase] = true
        if (phase === 'b') {
          state.receivedBoth = state.receipt_a === true
          return finish('MODEL_GATE_NATIVE_V1_OK ' + taskA + ' ' + taskB)
        }
        state.phase = 'b'
        state.followedUp = true
        return invoke('send_input', 'call_v1_followup', { target: state.childId, message: taskB })
      }
      const previousCompletion = phase === 'b' && completed === 'CHILD_DONE_' + taskA
      if (output.timed_out !== true && !previousCompletion) return finish('V1_WRONG_RESULT_' + phase)
    }
    state.waits = (state.waits || 0) + 1
    if (state.waits > 8) return finish('V1_WAIT_LIMIT')
    const id = 'call_v1_wait_' + phase + '_' + state.waits
    state.lastWait = { id, phase }
    return invoke('wait_agent', id, { targets: [state.childId], timeout_ms: 5000 })
  }
}
