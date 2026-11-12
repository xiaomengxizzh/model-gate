// Codex V2 生命周期纯 mock 夹具（P05）。
//
// 只模拟编排语义：spawn / child 工具 nonce / wait / followup / send_message / cancel /
// permission / cold resume / fork_turns / concurrency。不执行 Codex CLI、不联网、不写文件。
// 真实生命周期执行归 Q02，且要求 OS 级出网隔离；本夹具只证明"测试清单与断言形状"。
//
// 角色边界复用 P01 合成模型：provider 恒继承，role 的 model_provider 不生效。

import { resolveChild } from './role-provider-0.167.0.mjs'

export const LIFECYCLE_MOCK_VERSION = 1

function nonEmpty(v) { return typeof v === 'string' && v !== '' }

export function createLifecycleMock(options = {}) {
  const maxChildren = Number.isInteger(options.maxChildren) && options.maxChildren > 0 ? options.maxChildren : 4
  const provider = options.provider || 'mg'
  const rootModel = options.model || 'codex-gpt'
  const requireApproval = options.requireApproval !== false
  const roots = new Map()
  const agents = new Map()
  let seq = 0

  function openRoot(input = {}) {
    const rootId = input.rootId || 'root-synthetic-1'
    if (roots.has(rootId)) return { error: 'duplicate_root_id', rootId }
    const session = {
      rootId,
      provider,
      model: input.model || rootModel,
      history: [{ type: 'message', role: 'user', content: input.prompt || 'root' }],
      children: new Map(),
    }
    roots.set(rootId, session)
    return { ok: true, rootId, provider: session.provider, model: session.model }
  }

  function agentOf(taskName) {
    return typeof taskName === 'string' ? agents.get(taskName) || null : null
  }

  function spawn(input = {}) {
    const root = roots.get(input.rootId)
    if (!root) return { error: 'session_not_found' }
    const name = nonEmpty(input.taskName) ? input.taskName : '/root/task-' + (++seq)
    if (root.children.has(name)) return { error: 'duplicate_task_name' }
    if (root.children.size >= maxChildren) return { error: 'agent_limit_reached', limit: maxChildren }
    const role = input.role && typeof input.role === 'object' ? input.role : null
    const resolved = resolveChild({ parentProvider: root.provider, parentModel: root.model, role })
    const nonce = 'nonce-' + (++seq) + '-synthetic'
    const agent = {
      name,
      nonce,
      state: 'pending',
      turn: 0,
      provider: resolved.provider,
      model: input.model || resolved.model,
      forkTurns: input.fork_turns === 'all' ? 'all' : 'none',
      history: input.fork_turns === 'all' ? root.history.slice() : [],
      roleDiagnostics: resolved.diagnostics.slice(),
      result: null,
    }
    agents.set(name, agent)
    root.children.set(name, agent)
    root.history.push({
      type: 'function_call',
      call_id: 'call_spawn_' + (++seq),
      name: 'spawn_agent',
      arguments: JSON.stringify({ task_name: name, message: input.message || '', fork_turns: agent.forkTurns }),
    })
    return {
      ok: true,
      task_name: name,
      nonce,
      provider: agent.provider,
      model: agent.model,
      fork_turns: agent.forkTurns,
      historyLength: agent.history.length,
      roleDiagnostics: agent.roleDiagnostics.slice(),
    }
  }

  function runChild(input = {}) {
    const agent = agentOf(input.taskName)
    if (!agent) return { error: 'agent_not_found' }
    if (agent.state === 'canceled') return { error: 'agent_canceled' }
    if (requireApproval && input.approval !== 'allow') return { error: 'permission_denied', task_name: agent.name }
    agent.state = 'done'
    agent.turn += 1
    agent.result = { tool: 'exec_command', output: 'NONCE=' + agent.nonce, turn: agent.turn }
    agent.history.push({
      type: 'function_call',
      call_id: 'call_tool_' + (++seq),
      name: 'exec_command',
      arguments: JSON.stringify({ cmd: 'read synthetic nonce' }),
    })
    agent.history.push({ type: 'function_call_output', call_id: 'call_tool_' + seq, output: agent.result.output })
    return { ok: true, task_name: agent.name, nonce: agent.nonce, output: agent.result.output, turn: agent.turn }
  }

  function wait(input = {}) {
    const agent = agentOf(input.taskName)
    if (!agent) return { error: 'agent_not_found' }
    if (agent.state === 'canceled') return { error: 'agent_canceled' }
    if (agent.state !== 'done') return { message: 'Wait timed out.', timed_out: true }
    return {
      message: 'Wait completed.',
      timed_out: false,
      notification: { author: agent.name, recipient: '/root', text: 'FINAL_ANSWER NONCE=' + agent.nonce },
    }
  }

  function followup(input = {}) {
    const agent = agentOf(input.taskName)
    if (!agent) return { error: 'agent_not_found' }
    if (agent.state === 'canceled') return { error: 'agent_canceled' }
    if (agent.state !== 'done') return { error: 'agent_not_done' }
    const previous = agent.nonce
    agent.nonce = 'nonce-' + (++seq) + '-followup'
    agent.turn += 1
    agent.state = 'done'
    agent.result = { tool: 'exec_command', output: 'NONCE=' + agent.nonce, turn: agent.turn }
    return { ok: true, task_name: agent.name, previous_nonce: previous, nonce: agent.nonce, turn: agent.turn, message: input.message || '' }
  }

  function sendMessage(input = {}) {
    const agent = agentOf(input.taskName)
    if (!agent) return { error: 'agent_not_found' }
    if (agent.state === 'canceled') return { error: 'agent_canceled' }
    return { ok: true, task_name: agent.name, message: input.message || '', projected: { type: 'message', role: 'user' } }
  }

  function cancel(input = {}) {
    const agent = agentOf(input.taskName)
    if (!agent) return { error: 'agent_not_found' }
    agent.state = 'canceled'
    return { ok: true, task_name: agent.name, state: agent.state }
  }

  function permission(input = {}) {
    const agent = agentOf(input.taskName)
    if (!agent) return { error: 'agent_not_found' }
    const allowed = input.policy === 'allow'
    return { task_name: agent.name, action: input.action || 'tool', allowed, reason: allowed ? 'allowed_by_fixture_policy' : 'denied_by_fixture_policy' }
  }

  function resume(input = {}) {
    const root = roots.get(input.rootId)
    if (!root) return { error: 'session_not_found' }
    return {
      ok: true,
      rootId: root.rootId,
      provider: root.provider,
      model: root.model,
      children: [...root.children.keys()],
      historyLength: root.history.length,
      history: root.history.slice(),
    }
  }

  function snapshot(input = {}) {
    const root = roots.get(input.rootId)
    if (!root) return { error: 'session_not_found' }
    const child = input.taskName ? agentOf(input.taskName) : null
    return {
      rootId: root.rootId,
      provider: root.provider,
      model: root.model,
      childNames: [...root.children.keys()],
      child: child ? { name: child.name, state: child.state, nonce: child.nonce, provider: child.provider, model: child.model, turn: child.turn, forkTurns: child.forkTurns, historyLength: child.history.length, roleDiagnostics: child.roleDiagnostics.slice() } : null,
    }
  }

  return { openRoot, spawn, runChild, wait, followup, sendMessage, cancel, permission, resume, snapshot }
}
