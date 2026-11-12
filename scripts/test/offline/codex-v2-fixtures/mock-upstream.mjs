// Codex V2 离线生命周期夹具：只编排**模型输出**（Responses SSE），不伪造 Codex 线程/任务/通知。
// 所有线程、父子关系、完成通知、并发/审批/取消语义都由原版 Codex 生成；本模块仅扮演上游模型。
// 判定规则（实测 0.167.0）：npm test 默认不加载本文件的任何 CLI；由 codex-v2-lifecycle.test.mjs 在
// MG_CODEX_V2=1 门禁下引用。
import http from 'node:http'
import { once } from 'node:events'

export const GPT_MODEL = 'gpt-mock'
export const DEEPSEEK_MODEL = 'deepseek-mock'

// —— 输入形状工具（只做只读解析，绝不改写 Codex 侧状态） ——
export function itemTypes(input = []) {
  return input.map((x) => x.type + (x.name ? ':' + x.name : '') + (x.role ? ':' + x.role : ''))
}

export function functionCalls(input = []) {
  return input.filter((x) => x.type === 'function_call')
}

export function functionCallOutputs(input = []) {
  return input.filter((x) => x.type === 'function_call_output')
}

export function agentMessages(input = []) {
  return input.filter((x) => x.type === 'agent_message')
}

// agent_message 的正文：content[].type==='input_text' 拼接。
export function agentMessageText(item) {
  const parts = (item && item.content) || []
  return parts.filter((p) => p && (p.type === 'input_text' || p.type === 'text')).map((p) => p.text || '').join('\n')
}

// 原生委派正文的载荷段：'...Payload:\n<正文>'。
export function agentMessagePayload(item) {
  const text = agentMessageText(item)
  const i = text.lastIndexOf('Payload:\n')
  return i === -1 ? text : text.slice(i + 'Payload:\n'.length)
}

// exec_command 工具输出里的实际 stdout 段（Codex 统一包了 Chunk ID/Wall time/...）。
export function toolOutputBody(output) {
  const s = String(output == null ? '' : output)
  const i = s.lastIndexOf('Output:\n')
  return i === -1 ? s : s.slice(i + 'Output:\n'.length)
}

export function callsNamed(calls, name) {
  return calls.filter((c) => c.name === name)
}

export function outputForCall(outputs, callId) {
  return outputs.find((o) => o.call_id === callId) || null
}

// SSE 帧（最小可执行序列，0.167.0 实测通过）：created → output_item.added → output_item.done → completed。
// 协作工具项必须带 namespace:'collaboration' + encrypted_function_args:[]；普通工具项**绝不能**带 namespace。
export function buildSseFrames(items, { model, responseId = 'resp_mock_1' } = {}) {
  const frames = []
  const push = (type, payload) => frames.push('event: ' + type + '\ndata: ' + JSON.stringify(Object.assign({ type }, payload)) + '\n\n')
  push('response.created', { response: { id: responseId, object: 'response', status: 'in_progress', model, output: [] } })
  items.forEach((it, idx) => {
    const full = Object.assign({ id: it.id, status: 'completed' }, it)
    push('response.output_item.added', { output_index: idx, item: full })
    push('response.output_item.done', { output_index: idx, item: full })
  })
  push('response.completed', { response: { id: responseId, object: 'response', status: 'completed', model, output: items, usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } })
  return frames.join('')
}

// 动作 → Responses output item。
export function actionToItem(action, i = 0) {
  if (action.kind === 'text') {
    return { id: 'msg_' + i, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: action.text, annotations: [] }] }
  }
  if (action.kind === 'collab') {
    return {
      id: 'fc_' + i,
      type: 'function_call',
      namespace: 'collaboration',
      name: action.name,
      call_id: action.callId,
      arguments: JSON.stringify(action.args || {}),
      encrypted_function_args: [],
    }
  }
  if (action.kind === 'tool') {
    return { id: 'fc_' + i, type: 'function_call', name: action.name, call_id: action.callId, arguments: JSON.stringify(action.args || {}) }
  }
  // 网关后方的"上游视角"：协作工具是扁平 function，无 namespace、无 encrypted_function_args。
  // 恢复 namespace/name 是 ModelGate 的责任；mock 绝不能直接给 Codex 原生形状。
  if (action.kind === 'flat_collab') {
    return { id: 'fc_' + i, type: 'function_call', name: action.name, call_id: action.callId, arguments: JSON.stringify(action.args || {}) }
  }
  throw new Error('unknown action kind: ' + action.kind)
}

// —— 编排上下文 ——
// 每个请求构造一次；director 是纯函数（除显式 state 外无副作用），便于离线快测。
export function buildContext(record, state) {
  const body = record.body || {}
  const input = body.input || []
  const calls = functionCalls(input)
  const outputs = functionCallOutputs(input)
  const agentMsgs = agentMessages(input)
  const last = input[input.length - 1] || null
  const meta = body.client_metadata || {}
  let turnMeta = {}
  try { turnMeta = JSON.parse(meta['x-codex-turn-metadata'] || '{}') } catch { turnMeta = {} }
  return {
    record,
    body,
    input,
    model: body.model,
    state,
    // 原生身份字段（Codex 自报，仅只读使用）：thread/parent/agent 路径/深度/子代理种类。
    threadId: meta.thread_id || null,
    parentThreadId: meta['x-codex-parent-thread-id'] || null,
    agentName: turnMeta.agent_name || null,
    depth: typeof turnMeta.depth === 'number' ? turnMeta.depth : null,
    subagentKind: turnMeta.subagent_kind || null,
    turnMeta,
    calls,
    outputs,
    agentMessages: agentMsgs,
    last,
    newUserTurn: !!last && last.type === 'message' && last.role === 'user',
    lastOutput: last && last.type === 'function_call_output' ? last : null,
    lastAgentMessage: last && last.type === 'agent_message' ? last : null,
    headers: record.headers || {},
    callNames: calls.map((c) => c.name),
    outputFor: (callId) => outputForCall(outputs, callId),
    hadCall: (name) => calls.some((c) => c.name === name),
    outputForPrefix: (prefix) => outputs.find((o) => String(o.call_id).startsWith(prefix)) || null,
  }
}

// root 通用流程：新用户回合 → spawn；spawn 结果 → wait；拿到完成通知 → 收尾文本。
function rootFlow(ctx, { childModel, taskName, ifSpawned, ifWaited, finalText }) {
  const { last, state } = ctx
  if (last && last.type === 'agent_message') return { kind: 'text', text: finalText(last) }
  if (last && last.type === 'function_call_output') {
    if (String(last.call_id).startsWith('call_spawn_')) {
      state.spawnOutput = last.output
      return { kind: 'collab', name: 'wait_agent', args: { timeout_ms: 30000 }, callId: 'call_wait_1' }
    }
    if (String(last.call_id).startsWith('call_wait_')) return { kind: 'text', text: finalText(null) }
    return { kind: 'text', text: 'ROOT_UNEXPECTED_OUTPUT ' + last.call_id }
  }
  if (ctx.newUserTurn) {
    state.nonceA = (state.nonceA || 'A-NONCE-' + Math.random().toString(36).slice(2, 8))
    return ifSpawned(state)
  }
  return { kind: 'text', text: 'ROOT_NOOP' }
}

// 场景 1：spawn + 子代理真实本地工具读取 nonce B + 原生完成通知回 root。
export function lifecycleDirector(ctx) {
  const { state } = ctx
  if (ctx.model === DEEPSEEK_MODEL) {
    if (ctx.lastOutput) {
      const payload = ctx.agentMessages.length ? agentMessagePayload(ctx.agentMessages[ctx.agentMessages.length - 1]) : ''
      const nonceA = (payload.match(/A-NONCE-[a-z0-9]+/) || ['A-NONCE-unknown'])[0]
      return { kind: 'text', text: 'CHILD_REPORT nonceA=' + nonceA + ' nonceB=' + toolOutputBody(ctx.lastOutput.output).trim() }
    }
    return { kind: 'tool', name: 'exec_command', args: { cmd: 'cat ' + state.seedPath }, callId: 'call_child_exec_1' }
  }
  return rootFlow(ctx, {
    childModel: DEEPSEEK_MODEL,
    taskName: 'worker',
    ifSpawned: (s) => ({
      kind: 'collab',
      name: 'spawn_agent',
      args: { task_name: 'worker', model: DEEPSEEK_MODEL, fork_turns: 'none', message: 'Read seed.txt with a local tool and report nonce A=' + s.nonceA + ' together with nonce B.' },
      callId: 'call_spawn_1',
    }),
    ifWaited: () => ({ kind: 'text', text: 'ROOT_WAIT_EMPTY' }),
    finalText: (item) => 'ROOT_FINAL payload=' + (item ? agentMessagePayload(item) : 'missing'),
  })
}

// 场景 2：闲置目标 send_message 只排队、不误启动新 turn。
// 顺序：spawn → wait（被完成通知唤醒）→ send_message（目标已闲置）→ wait（应超时，不因排队消息起新 turn）→ 收尾。
export function queueDirector(ctx) {
  const { state } = ctx
  if (ctx.model === DEEPSEEK_MODEL) {
    // 子代理一次工具往返后收尾，随后保持闲置。
    if (ctx.lastOutput) return { kind: 'text', text: 'CHILD_DONE nonceB=' + toolOutputBody(ctx.lastOutput.output).trim() }
    return { kind: 'tool', name: 'exec_command', args: { cmd: 'cat ' + state.seedPath }, callId: 'call_child_exec_1' }
  }
  const { last } = ctx
  if (last && last.type === 'agent_message') {
    // 完成通知已回 root：此刻 target 闲置，投递排队消息。
    return { kind: 'collab', name: 'send_message', args: { target: '/root/worker', message: 'Queued only: do not start a new turn.' }, callId: 'call_send_1' }
  }
  if (last && last.type === 'function_call_output') {
    if (String(last.call_id).startsWith('call_spawn_')) {
      return { kind: 'collab', name: 'wait_agent', args: { timeout_ms: 30000 }, callId: 'call_wait_1' }
    }
    if (String(last.call_id).startsWith('call_send_')) {
      state.sendOutput = last.output
      return { kind: 'collab', name: 'wait_agent', args: { timeout_ms: 10000 }, callId: 'call_wait_2' }
    }
    if (String(last.call_id).startsWith('call_wait_2')) {
      state.idleWaitOutput = last.output
      return { kind: 'text', text: 'ROOT_FINAL send=' + JSON.stringify(String(state.sendOutput)) + ' idleWait=' + JSON.stringify(String(last.output)) }
    }
    if (String(last.call_id).startsWith('call_wait_')) {
      return { kind: 'text', text: 'ROOT_WAIT_EMPTY' }
    }
  }
  if (ctx.newUserTurn) {
    return { kind: 'collab', name: 'spawn_agent', args: { task_name: 'worker', model: DEEPSEEK_MODEL, fork_turns: 'none', message: 'Read seed.txt and report once, then stay idle.' }, callId: 'call_spawn_1' }
  }
  return { kind: 'text', text: 'ROOT_NOOP' }
}

// 场景 3：递归 /root/worker/grandchild（worker 再 spawn 一层）。
export function recursionDirector(ctx) {
  const { state } = ctx
  // 用 Codex 自报的 agent 路径区分 worker 与 grandchild（不按请求序号猜）。
  const isGrandchild = ctx.agentName === '/root/worker/grandchild'
  if (isGrandchild) {
    if (ctx.lastOutput) return { kind: 'text', text: 'GRANDCHILD_REPORT nonceB2=' + toolOutputBody(ctx.lastOutput.output).trim() }
    return { kind: 'tool', name: 'exec_command', args: { cmd: 'cat ' + state.seed2Path }, callId: 'call_gc_exec_1' }
  }
  if (ctx.model === DEEPSEEK_MODEL) {
    // 首请求的历史里最后一项就是 NEW_TASK agent_message；不能据此判定"已完成"。
    if (ctx.outputForPrefix('call_wait_')) {
      return { kind: 'text', text: 'WORKER_FINAL ' + agentMessagePayload(ctx.lastAgentMessage) }
    }
    if (ctx.outputForPrefix('call_spawn_')) {
      return { kind: 'collab', name: 'wait_agent', args: { timeout_ms: 30000 }, callId: 'call_wait_gc_1' }
    }
    return {
      kind: 'collab',
      name: 'spawn_agent',
      args: { task_name: 'grandchild', model: state.grandchildModel, fork_turns: 'none', message: 'Read seed2.txt with a local tool and report nonce B2.' },
      callId: 'call_spawn_gc_1',
    }
  }
  return rootFlow(ctx, {
    childModel: DEEPSEEK_MODEL,
    taskName: 'worker',
    ifSpawned: () => ({ kind: 'collab', name: 'spawn_agent', args: { task_name: 'worker', model: DEEPSEEK_MODEL, fork_turns: 'none', message: 'Delegate to a grandchild and report its nonce B2 in your final answer.' }, callId: 'call_spawn_1' }),
    ifWaited: () => ({ kind: 'text', text: 'ROOT_WAIT_EMPTY' }),
    finalText: (item) => 'ROOT_FINAL payload=' + (item ? agentMessagePayload(item) : 'missing'),
  })
}

// 场景 4：并发上限原生拒绝（root 同一回合内 spawn 两个子代理）。
export function concurrencyDirector(ctx) {
  if (ctx.model === DEEPSEEK_MODEL) return { kind: 'text', text: 'CHILD_DONE' }
  const { last } = ctx
  if (last && last.type === 'agent_message') {
    return { kind: 'text', text: 'ROOT_FINAL concurrency_notification=' + agentMessagePayload(last) }
  }
  if (last && last.type === 'function_call_output') {
    // 收集同回合两个 spawn 的结果后收尾（第二个应被原生并发上限拒绝）。
    return { kind: 'text', text: 'ROOT_FINAL spawn_outputs=' + JSON.stringify(ctx.outputs.map((o) => ({ call_id: o.call_id, output: String(o.output).slice(0, 400) }))) }
  }
  if (ctx.newUserTurn) {
    return [
      { kind: 'collab', name: 'spawn_agent', args: { task_name: 'alpha', model: DEEPSEEK_MODEL, fork_turns: 'none', message: 'Reply CHILD_DONE.' }, callId: 'call_spawn_alpha_1' },
      { kind: 'collab', name: 'spawn_agent', args: { task_name: 'beta', model: DEEPSEEK_MODEL, fork_turns: 'none', message: 'Reply CHILD_DONE.' }, callId: 'call_spawn_beta_1' },
    ]
  }
  return { kind: 'text', text: 'ROOT_NOOP' }
}

// 场景 5：审批/沙箱 —— 子代理尝试写文件，read-only 下应被原生拒绝；workspace-write 下应成功。
export function approvalDirector(ctx) {
  const { state } = ctx
  if (ctx.model === DEEPSEEK_MODEL) {
    if (ctx.lastOutput) return { kind: 'text', text: 'CHILD_WRITE_RESULT ' + JSON.stringify(String(ctx.lastOutput.output)).slice(0, 600) }
    return { kind: 'tool', name: 'exec_command', args: { cmd: 'printf HELLO > ' + state.writeTarget + ' && echo WROTE' }, callId: 'call_child_write_1' }
  }
  return rootFlow(ctx, {
    childModel: DEEPSEEK_MODEL,
    taskName: 'worker',
    ifSpawned: () => ({ kind: 'collab', name: 'spawn_agent', args: { task_name: 'worker', model: DEEPSEEK_MODEL, fork_turns: 'none', message: 'Try to write the target file with a local command and report the raw tool result.' }, callId: 'call_spawn_1' }),
    ifWaited: () => ({ kind: 'text', text: 'ROOT_WAIT_EMPTY' }),
    finalText: (item) => 'ROOT_FINAL payload=' + (item ? agentMessagePayload(item) : 'missing'),
  })
}

// 场景 7：原生取消 —— root 用 interrupt_agent 打断运行中的子回合，随后 followup_task 复用同一 child。
// 不用 SIGINT：外部信号在本机实测会出现"进程长时间不退出"的平台行为，不适合做门禁断言。
export function cancelDirector(ctx) {
  const { state } = ctx
  if (ctx.model === DEEPSEEK_MODEL) {
    if (state.interrupted) return { kind: 'text', text: 'CHILD_AFTER_INTERRUPT' }
    // 首回合故意拖住，让 interrupt_agent 落在子线程 turn 进行中。
    return { kind: 'text', text: 'CHILD_SLOW_TURN', delayMs: 8000 }
  }
  const { last } = ctx
  if (last && last.type === 'agent_message') {
    return { kind: 'text', text: 'ROOT_FINAL payload=' + agentMessagePayload(last) + ' interrupt=' + JSON.stringify(String(state.interruptOutput || '')) }
  }
  if (last && last.type === 'function_call_output') {
    const id = String(last.call_id)
    if (id.startsWith('call_spawn_')) {
      return { kind: 'collab', name: 'interrupt_agent', args: { target: '/root/worker' }, callId: 'call_interrupt_1' }
    }
    if (id.startsWith('call_interrupt_')) {
      state.interruptOutput = String(last.output)
      state.interrupted = true
      return { kind: 'collab', name: 'followup_task', args: { target: '/root/worker', message: 'Post-interrupt check: report your state.' }, callId: 'call_followup_1' }
    }
    if (id.startsWith('call_followup_')) {
      return { kind: 'collab', name: 'wait_agent', args: { timeout_ms: 30000 }, callId: 'call_wait_1' }
    }
    if (id.startsWith('call_wait_')) return { kind: 'text', text: 'ROOT_WAIT_EMPTY' }
  }
  if (ctx.newUserTurn) {
    return { kind: 'collab', name: 'spawn_agent', args: { task_name: 'worker', model: DEEPSEEK_MODEL, fork_turns: 'none', message: 'Stay busy until the root interrupts you.' }, callId: 'call_spawn_1' }
  }
  return { kind: 'text', text: 'ROOT_NOOP' }
}

// 场景 6：followup_task 在同一 child 起新 turn（配合冷恢复使用）。
export function followupDirector(ctx) {
  const { state } = ctx
  if (ctx.model === DEEPSEEK_MODEL) {
    if (ctx.lastAgentMessage) {
      const payload = agentMessagePayload(ctx.lastAgentMessage)
      const kind = /Message Type: FOLLOWUP|Message Type: NEW_TASK/.test(agentMessageText(ctx.lastAgentMessage)) ? 'TASK' : 'TASK'
      return { kind: 'text', text: 'CHILD_TURN ' + kind + ' payload=' + payload }
    }
    return { kind: 'text', text: 'CHILD_TURN no-task' }
  }
  const { last } = ctx
  if (last && last.type === 'agent_message') {
    return { kind: 'text', text: 'ROOT_FINAL payload=' + agentMessagePayload(last) }
  }
  if (last && last.type === 'function_call_output') {
    if (String(last.call_id).startsWith('call_followup_')) {
      state.followupOutput = last.output
      return { kind: 'collab', name: 'wait_agent', args: { timeout_ms: 30000 }, callId: 'call_wait_2' }
    }
    if (String(last.call_id).startsWith('call_wait_')) return { kind: 'text', text: 'ROOT_WAIT_EMPTY' }
    if (String(last.call_id).startsWith('call_spawn_')) {
      return { kind: 'collab', name: 'wait_agent', args: { timeout_ms: 30000 }, callId: 'call_wait_1' }
    }
  }
  if (ctx.newUserTurn) {
    // 历史里已有上一轮完成通知 → 走 followup_task；否则首次 spawn。
    const seenFinal = ctx.agentMessages.some((m) => agentMessageText(m).includes('FINAL_ANSWER'))
    if (seenFinal) {
      return { kind: 'collab', name: 'followup_task', args: { target: '/root/worker', message: 'Second task: reply with your turn marker only.' }, callId: 'call_followup_1' }
    }
    return { kind: 'collab', name: 'spawn_agent', args: { task_name: 'worker', model: DEEPSEEK_MODEL, fork_turns: 'none', message: 'First task: reply with your turn marker only.' }, callId: 'call_spawn_1' }
  }
  return { kind: 'text', text: 'ROOT_NOOP' }
}


// —— Phase B：mock 位于网关后方，只看到"上游视角" ——
// openai mock（codex-gpt → gpt-mock）：根代理编排；协作工具一律返回扁平 function_call。
export function phasebOpenaiDirector(ctx) {
  const { last } = ctx
  // Phase B 的 mock 看不到 client_metadata（网关已剥离），只能用 input 形状区分身份：
  // 根线程的请求历史里必有 spawn_agent 调用；孙代理的首请求没有（它是被 spawn 出来的）。
  if (last && last.type === 'agent_message') {
    const sawSpawn = ctx.callNames.includes('spawn_agent')
    if (!sawSpawn) return { kind: 'text', text: 'GRANDCHILD_OK model=' + ctx.model }
    return { kind: 'text', text: 'ROOT_FINAL payload=' + agentMessagePayload(last) }
  }
  if (last && last.type === 'function_call_output') {
    if (String(last.call_id).startsWith('call_spawn_')) {
      return { kind: 'flat_collab', name: 'wait_agent', args: { timeout_ms: 30000 }, callId: 'call_wait_1' }
    }
    if (String(last.call_id).startsWith('call_wait_')) {
      return { kind: 'text', text: 'ROOT_WAIT_EMPTY output=' + String(last.output) }
    }
  }
  if (ctx.newUserTurn) {
    return { kind: 'flat_collab', name: 'spawn_agent', args: { task_name: 'worker', model: 'codex-deepseek', fork_turns: 'none', message: 'Read seed.txt with a local tool and report nonce A=A-NONCE-PHASEB together with nonce B.' }, callId: 'call_spawn_1' }
  }
  return { kind: 'text', text: 'OPENAI_MOCK_NOOP' }
}

// deepseek mock（codex-deepseek → deepseek-mock）：收到的是已投影的 user message（不再是 agent_message）。
export function phasebDeepseekDirector(ctx) {
  const { state } = ctx
  if (ctx.agentName === '/root/worker/grandchild') {
    return { kind: 'text', text: 'GRANDCHILD_DEEPSEEK_OK model=' + ctx.model }
  }
  // worker 在 Phase B 递归场景：先 spawn 孙代理 → wait → 完成通知 → 收尾。
  // 注意：DeepSeek 路由 history.agentMessage=project，完成通知在这里是普通 user message，
  // 只能按正文里的 FINAL_ANSWER 标记识别（这正是网关投影后的上游视角）。
  if (state.grandchildModel) {
    const lastIsNotification = ctx.last && ctx.last.type === 'message' && JSON.stringify(ctx.last).includes('FINAL_ANSWER')
    if (lastIsNotification) {
      const text = (ctx.last.content || []).map((c) => c.text || '').join('\n')
      const i = text.lastIndexOf('Payload:\n')
      return { kind: 'text', text: 'WORKER_FINAL ' + (i === -1 ? text : text.slice(i + 'Payload:\n'.length)) }
    }
    if (ctx.outputForPrefix('call_spawn_gc_')) {
      return { kind: 'flat_collab', name: 'wait_agent', args: { timeout_ms: 30000 }, callId: 'call_wait_gc_1' }
    }
    return { kind: 'flat_collab', name: 'spawn_agent', args: { task_name: 'grandchild', model: state.grandchildModel, fork_turns: 'none', message: 'Report GRANDCHILD_OK.' }, callId: 'call_spawn_gc_1' }
  }
  if (ctx.lastOutput) {
    const texts = ctx.input.filter((i) => i.type === 'message').map((m) => JSON.stringify(m)).join('\n')
    const nonceA = (texts.match(/A-NONCE-[A-Za-z0-9-]+/) || ['A-NONCE-unknown'])[0]
    return { kind: 'text', text: 'CHILD_REPORT nonceA=' + nonceA + ' nonceB=' + toolOutputBody(ctx.lastOutput.output).trim() }
  }
  return { kind: 'tool', name: 'exec_command', args: { cmd: 'cat ' + state.seedPath }, callId: 'call_child_exec_1' }
}

export const DIRECTORS = { lifecycleDirector, queueDirector, recursionDirector, concurrencyDirector, approvalDirector, followupDirector, cancelDirector, phasebOpenaiDirector, phasebDeepseekDirector }

// —— mock 上游服务器 ——
// 每请求记录：method/url/headers/body/到达时间；不记录凭据值到 stdout/报告。
export async function startMockUpstream({ director, state = {}, label = 'codex-v2-mock' } = {}) {
  const received = []
  const ctxState = Object.assign({ role: 'worker' }, state)
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    let body = null
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* 非 JSON 保留 null */ }
    const record = { index: received.length, method: req.method, url: req.url, headers: req.headers, body, at: Date.now() }
    received.push(record)
    if (req.method !== 'POST') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ object: 'list', data: [{ id: GPT_MODEL, object: 'model' }, { id: DEEPSEEK_MODEL, object: 'model' }] }))
      return
    }
    const ctx = buildContext(record, ctxState)
    let actions
    try { actions = director(ctx) } catch (e) { actions = { kind: 'text', text: 'MOCK_DIRECTOR_ERROR ' + (e && e.message) } }
    if (!Array.isArray(actions)) actions = [actions]
    record.actions = actions
    const delayMs = Math.max(0, ...actions.map((a) => a.delayMs || 0))
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
    if (res.writableEnded || res.destroyed) return
    const items = actions.map((a, i) => actionToItem(a, i))
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    res.end(buildSseFrames(items, { model: body && body.model, responseId: 'resp_' + record.index }))
  })
  server.on('clientError', (err, socket) => { try { socket.destroy() } catch {} })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  const stop = async () => {
    server.closeAllConnections?.()
    await new Promise((r) => server.close(r))
  }
  return {
    label,
    port,
    base: 'http://127.0.0.1:' + port,
    received,
    state: ctxState,
    requestsFor: (model) => received.filter((r) => r.method === 'POST' && r.body && r.body.model === model),
    stop,
  }
}

// 快速断言用：一次请求的摘要（不含凭据）。
export function summarize(record) {
  const b = record.body || {}
  return {
    model: b.model,
    stream: b.stream,
    tools: (b.tools || []).map((t) => t.type + (t.name ? ':' + t.name : '') + (t.namespace ? '/' + t.namespace : '')),
    items: itemTypes(b.input || []),
  }
}