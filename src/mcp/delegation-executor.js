// G3：OpenCode Go 子任务执行器（Responses 协议 + 本地受限工具循环）。
//
// 复用既有发送链，不重造能力：
//   · 头构造/身份域防火墙：src/forward.js buildHeaders
//   · HTTP 发送与超时/预算：src/request.js forward（noRetry=true：委派任务绝不重放）
//   · SSE 解码：src/responses-stream.js createCodexSSEParser
//   · 预算：src/budget.js createBudget
//   · Go 入口/会话/错误映射：src/providers/opencode-go.js
//
// 硬边界：
//   · provider / model / 入口只由服务端配置决定；工具参数无法影响目标。
//   · Go Key 只出现在请求头，不返回、不落盘、不进结果。
//   · 一次委派 = 一次网络写入；失败不自动重试、不换上游（避免重复执行）。
//   · 上游正文只有解析出的文本/工具事实会进结果，且经过脱敏与上限处理。

import { createBudget, abortedError } from '../budget.js'
import { buildHeaders } from '../forward.js'
import { forward } from '../request.js'
import { createCodexSSEParser } from '../responses-stream.js'
import { classifyTarget } from '../codex/identity.js'
import { decodeError, usageOf } from '../providers/opencode-go.js'
import { ERRORS, LIMITS, sanitizeResultText, byteLen } from './delegation-contract.js'
import { diffRefs, fingerprintRefs } from './delegation-tools.js'

const MAX_STREAM_BYTES = 8 * 1024 * 1024
const DEFAULT_RESPONSES_PATH = '/v1/responses'

export const CHILD_INSTRUCTIONS = [
  '你是 ModelGate 委派到 OpenCode Go 的本地执行子代理。',
  '你只能使用给定的受限文件工具（read_file / list_dir / write_file / stat_path），根目录是本次任务的工作区。',
  '必须真实调用工具完成需要文件操作的部分；不要臆造未执行的操作或未读取的内容。',
  '最终答复用简洁中文或英文，列出你实际执行的关键操作与结果；如果工具返回了 sha256，请原样引用。',
].join('\n')

export class TurnError extends Error {
  constructor(code, message, extra) {
    super(message || code)
    this.name = 'TurnError'
    this.code = code
    this.extra = extra || null
  }
}

function errorOf(err) {
  if (!err) return { code: ERRORS.INTERNAL, message: '未知错误' }
  if (err instanceof TurnError) return { code: err.code, message: err.message, extra: err.extra }
  if (err && err.code && typeof err.code === 'string' && err.code.startsWith('MCP_')) return { code: err.code, message: String(err.message || err.code) }
  if (err && err.aborted) {
    return { code: err.reason === 'client_closed' ? ERRORS.UPSTREAM_TIMEOUT : ERRORS.UPSTREAM_TIMEOUT, message: String(err.message || '请求被取消/超时') }
  }
  return { code: ERRORS.INTERNAL, message: String((err && err.message) || 'internal error') }
}

async function readAll(stream, cap) {
  const chunks = []
  let total = 0
  for await (const chunk of stream) {
    total += chunk.length
    if (total > cap) throw new TurnError(ERRORS.UPSTREAM_ERROR, '上游响应超过上限 ' + cap + ' 字节')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function collectFromJson(json) {
  const out = { text: '', toolCalls: [], usage: null, responseId: null, sawTerminal: false }
  if (!json || typeof json !== 'object') return out
  out.responseId = typeof json.id === 'string' ? json.id : null
  out.usage = usageOf(json)
  const items = Array.isArray(json.output) ? json.output : []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    if (item.type === 'function_call' || item.type === 'custom_tool_call') out.toolCalls.push(item)
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part && (part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') out.text += part.text
      }
    }
  }
  out.sawTerminal = true
  return out
}

function collectFromSSE(frames, acc) {
  const out = { textDelta: '', toolCalls: [], usage: null, responseId: null, sawTerminal: false, terminalType: null }
  for (const frame of frames) {
    const line = String(frame).split('\n').find((l) => l.startsWith('data:'))
    if (!line) continue
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') continue
    let ev
    try { ev = JSON.parse(data) } catch { continue }
    if (!ev || typeof ev !== 'object') continue
    const type = typeof ev.type === 'string' ? ev.type : ''
    if (type === 'response.output_text.delta' && typeof ev.delta === 'string') out.textDelta += ev.delta
    if (type === 'response.output_item.done' && ev.item && typeof ev.item === 'object') {
      if (ev.item.type === 'function_call' || ev.item.type === 'custom_tool_call') out.toolCalls.push(ev.item)
    }
    if (type === 'response.completed' || type === 'response.failed' || type === 'response.incomplete') {
      out.sawTerminal = true
      out.terminalType = type
      const resp = ev.response && typeof ev.response === 'object' ? ev.response : null
      if (resp) {
        if (typeof resp.id === 'string') out.responseId = resp.id
        out.usage = usageOf(resp) || out.usage
        if (Array.isArray(resp.output)) {
          for (const item of resp.output) {
            if (item && (item.type === 'function_call' || item.type === 'custom_tool_call')) {
              if (!out.toolCalls.some((t) => t.call_id && t.call_id === item.call_id)) out.toolCalls.push(item)
            }
            if (item && item.type === 'message' && Array.isArray(item.content)) {
              for (const part of item.content) {
                if (part && (part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') out.textDelta += part.text
              }
            }
          }
        }
      }
      if (type === 'response.failed') {
        const err = resp && resp.error ? resp.error : null
        out.failed = { code: (err && err.code) || 'response_failed', message: (err && err.message) || '上游报告 response.failed' }
      }
    }
  }
  if (!acc.text) acc.text = ''
  acc.text += out.textDelta
  for (const t of out.toolCalls) if (!acc.toolCalls.some((x) => x.call_id && x.call_id === t.call_id)) acc.toolCalls.push(t)
  if (out.usage) acc.usage = out.usage
  if (out.responseId) acc.responseId = out.responseId
  if (out.sawTerminal) { acc.sawTerminal = true; acc.terminalType = out.terminalType; acc.failed = out.failed || null }
  return out
}

/**
 * createGoExecutor({ cfg, providerId, model, workspaceRoot, workspaceTools, maxSteps?, reasoningEffort?, log?, now? })
 */
export function createGoExecutor(opts = {}) {
  const cfg = opts.cfg || {}
  const providerId = String(opts.providerId || 'opencodego')
  const model = String(opts.model || '')
  const workspaceTools = opts.workspaceTools || null
  const workspaceRoot = opts.workspaceRoot || null
  const maxSteps = Math.min(Math.max(1, Number(opts.maxSteps) || LIMITS.maxStepsDefault), LIMITS.maxStepsCap)
  const reasoningEffort = opts.reasoningEffort === undefined ? null : opts.reasoningEffort
  const log = opts.log && typeof opts.log === 'object' ? opts.log : null

  const def = (cfg.providers || {})[providerId] || null
  if (!def) throw new Error('provider 未配置：' + providerId)
  const responsesPath = (typeof def.responsesPath === 'string' && def.responsesPath) || DEFAULT_RESPONSES_PATH

  /** 由调用方注入：{ provider, cfg, identity } —— 保持执行器本身可离线测试（可替换 transport）。 */
  function transportOf(injected) {
    if (injected && typeof injected.send === 'function') return injected
    return { send: defaultSend }
  }

  async function defaultSend({ provider, path, headers, payload, budget }) {
    return forward(provider, path, 'POST', headers, payload, cfg.defaults || {}, log, { budget, signal: budget.signal, noRetry: true })
  }

  /**
   * 执行一轮：runTurn({ task, constraints, budgetMs, sessionRef, refsBefore, provider, signal, onState, onProgress, transport })
   * 返回 { ok:true, resultText, truncated, usage, toolCalls, steps, artifacts, lossy, upstream } 或抛 TurnError。
   */
  async function runTurn(input) {
    const provider = input.provider
    const identity = classifyTarget(provider, cfg)
    const transport = transportOf(input.transport)
    const budget = createBudget({ overallMs: Number(input.budgetMs) > 0 ? Number(input.budgetMs) : LIMITS.budgetMsDefault, signal: input.signal || null })
    const refsBefore = input.refsBefore || (workspaceTools ? fingerprintRefs(workspaceTools, input.workspaceRefs || []) : [])
    const toolDefs = workspaceTools ? workspaceTools.definitions() : []
    const lossy = []
    let steps = 0
    let text = ''
    let usage = null
    let responseId = null
    const toolCallLog = []
    const inputItems = [{
      role: 'user',
      content: [{ type: 'input_text', text: buildUserText(input.task, input.constraints) }],
    }]
    let stateNotified = false
    const notifyRunning = () => { if (!stateNotified) { stateNotified = true; if (typeof input.onState === 'function') input.onState('RUNNING') } }

    try {
      while (steps < maxSteps) {
        steps += 1
        if (budget.expired()) throw new TurnError(ERRORS.UPSTREAM_TIMEOUT, '任务预算耗尽（' + budget.deadlineAt + '）')
        const body = {
          model,
          instructions: CHILD_INSTRUCTIONS,
          input: inputItems,
          stream: true,
          store: false,
        }
        if (toolDefs.length) {
          body.tools = toolDefs.map((d) => ({ type: 'function', name: d.name, description: d.description, parameters: d.parameters }))
          body.tool_choice = 'auto'
        }
        const effort = input.reasoningEffort || reasoningEffort
        if (effort) body.reasoning = { effort }
        const payload = Buffer.from(JSON.stringify(body))
        const syntheticReq = { headers: {} }
        const headers = buildHeaders(syntheticReq, provider, payload, cfg, 'responses', body, { identity, principalRef: input.principalRef, sessionScope: 'child' })
        headers['content-type'] = 'application/json'
        headers['content-length'] = payload.length
        headers['accept'] = 'text/event-stream'
        // 上游会话标识由本服务生成并持久化：跨重启稳定、与父端线程 id 无关。
        if (input.sessionRef) headers['x-opencode-session'] = String(input.sessionRef)
        notifyRunning()
        let up
        try {
          up = await transport.send({ provider, path: responsesPath, headers, payload, budget, model, steps })
        } catch (err) {
          // forward() 对 5xx/429 是「抛出」而不是返回：这里统一映射成稳定 MCP 错误码，
          // 并且绝不因为可重试状态就自动重发（委派任务只允许一次网络写入）。
          if (err && err.aborted) throw new TurnError(ERRORS.UPSTREAM_TIMEOUT, '上游请求被中止：' + String(err.message || ''), { reason: err.reason })
          const mapped = decodeError(err && err.status, err && (err.bodyText || err.message), {}, {})
          throw new TurnError(ERRORS.UPSTREAM_ERROR, '上游失败：' + mapped.message, {
            status: (err && err.status) || null, upstreamCode: mapped.code, retryAfterMs: (err && err.retryAfter) || mapped.retryAfterMs, quota: mapped.quota,
          })
        }
        if (!up || typeof up !== 'object') throw new TurnError(ERRORS.INTERNAL, 'transport 未返回结果')
        if (up.status >= 300 && up.status < 400) {
          try { await readAll(up.stream, 1024 * 1024) } catch {}
          throw new TurnError(ERRORS.UPSTREAM_ERROR, '上游返回重定向 ' + up.status + '：拒绝跟随')
        }
        if (!up.ok) {
          let bodyText = ''
          try { bodyText = (await readAll(up.stream, 1024 * 1024)).toString('utf8') } catch {}
          const mapped = decodeError(up.status, bodyText, up.headers || {}, {})
          throw new TurnError(up.status === 429 ? ERRORS.UPSTREAM_UNAVAILABLE : ERRORS.UPSTREAM_ERROR, '上游 ' + up.status + '：' + mapped.message, {
            status: up.status, upstreamCode: mapped.code, retryAfterMs: mapped.retryAfterMs, quota: mapped.quota,
          })
        }
        const ct = String((up.headers && up.headers['content-type']) || '')
        let acc
        if (/text\/event-stream/i.test(ct)) {
          acc = { text: '', toolCalls: [], usage: null, responseId: null, sawTerminal: false, terminalType: null, failed: null }
          const parser = createCodexSSEParser()
          let bytes = 0
          let sawFirst = false
          // 取消/预算中止必须能打断「上游只发了一半就不动」的流，否则取消语义会退化成等超时。
          const onAbort = () => { try { up.stream.destroy(Object.assign(new Error('aborted'), { aborted: true })) } catch {} }
          if (budget.signal) budget.signal.addEventListener('abort', onAbort, { once: true })
          try {
            for await (const chunk of up.stream) {
              if (budget.expired()) { try { up.stream.destroy() } catch {}; throw abortedError(budget.reason || 'request_timeout') }
              bytes += chunk.length
              if (bytes > MAX_STREAM_BYTES) throw new TurnError(ERRORS.UPSTREAM_ERROR, '上游 SSE 超过上限 ' + MAX_STREAM_BYTES + ' 字节')
              if (!sawFirst) { sawFirst = true; notifyRunning() }
              const frames = parser.push(chunk)
              if (frames.length) collectFromSSE(frames, acc)
              if (typeof input.onProgress === 'function') input.onProgress({ events: bytes, steps })
            }
            const tail = parser.flush()
            if (tail.length) collectFromSSE(tail, acc)
          } catch (err) {
            if (err && err.aborted) throw new TurnError(ERRORS.UPSTREAM_TIMEOUT, '上游流被中止：' + String(err.message || ''), { reason: err.reason })
            if (err instanceof TurnError) throw err
            if (budget.expired()) throw new TurnError(ERRORS.UPSTREAM_TIMEOUT, '任务预算中止：' + String((err && err.message) || err), { reason: budget.reason })
            throw new TurnError(ERRORS.UPSTREAM_ERROR, '上游流中断：' + String((err && err.message) || err))
          } finally {
            if (budget.signal) { try { budget.signal.removeEventListener('abort', onAbort) } catch {} }
          }
          if (!acc.sawTerminal) {
            throw new TurnError(ERRORS.UPSTREAM_ERROR, '上游流没有给出终态事件（不允许把 EOF 当成功）')
          }
          if (acc.terminalType === 'response.failed') {
            throw new TurnError(ERRORS.UPSTREAM_ERROR, '上游报告失败：' + JSON.stringify(acc.failed || {}))
          }
          usage = acc.usage || usage
          if (acc.responseId) responseId = acc.responseId
          // 若最后一轮只有工具调用没有正文，保留上一轮已有正文作为结果回执。
          text = acc.text || text
          const calls = acc.toolCalls
          if (!calls.length) break
          // 有工具调用：本地执行并把结果回填，进入下一轮。
          const results = []
          for (const call of calls) results.push(await executeCall(call, workspaceTools))
          appendCallItems(inputItems, calls, results)
          for (const r of results) toolCallLog.push(r.record)
          if (steps >= maxSteps) { lossy.push({ kind: 'step_cap', message: '达到最大步数 ' + maxSteps + '，剩余工具调用未继续执行' }) }
          continue
        }
        const buf = await readAll(up.stream, MAX_STREAM_BYTES)
        let json
        try { json = JSON.parse(buf.toString('utf8')) } catch { throw new TurnError(ERRORS.UPSTREAM_ERROR, '上游返回非 JSON 且非 SSE') }
        const collected = collectFromJson(json)
        usage = collected.usage || usage
        responseId = collected.responseId || responseId
        text = collected.text || text
        if (!collected.toolCalls.length) break
        const results = []
        for (const call of collected.toolCalls) results.push(await executeCall(call, workspaceTools))
        appendCallItems(inputItems, collected.toolCalls, results)
        for (const r of results) toolCallLog.push(r.record)
        continue
      }
      if (!workspaceTools) lossy.push({ kind: 'no_workspace_tools', message: '未启用本地工具：本次任务没有真实工具执行' })
      const refsAfter = workspaceTools ? fingerprintRefs(workspaceTools, input.workspaceRefs || []) : []
      const artifacts = diffRefs(refsBefore, refsAfter)
      const safe = sanitizeResultText(text, { allowTruncation: input.allowResultTruncation === true })
      if (safe.overLimit) lossy.push({ kind: 'result_over_limit', message: '结果 ' + safe.bytes + ' 字节 > ' + safe.limit + '，未获允许截断，已原样返回' })
      const failedTools = toolCallLog.filter((t) => t && t.ok === false)
      return {
        ok: true,
        resultText: safe.text,
        truncated: safe.truncated,
        resultBytes: byteLen(safe.text),
        usage: usage ? { input: usage.input, output: usage.output, total: usage.total, kind: usage.kind } : null,
        toolCalls: toolCallLog,
        toolCallCount: toolCallLog.length,
        failedToolCalls: failedTools.length,
        steps,
        artifacts,
        lossy,
        upstream: { provider: providerId, model, path: responsesPath, responseId, transport: 'https-mock-or-go' },
      }
    } finally {
      budget.dispose()
    }
  }

  return { runTurn, providerId, model, responsesPath, maxSteps, reasoningEffort }
}

function buildUserText(task, constraints) {
  const parts = [String(task || '')]
  if (constraints && String(constraints).trim()) parts.push('\n[CONSTRAINTS]\n' + String(constraints))
  return parts.join('')
}

// 把模型发起的工具调用与本地执行结果一起回填到下一次请求的 input 里。
// 不加 previous_response_id 依赖：无状态全量上下文在兼容实现上更可靠。
function appendCallItems(inputItems, calls, results) {
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i]
    if (!call) continue
    const callId = call.call_id || call.id || null
    const argsText = typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments || {})
    inputItems.push({ type: 'function_call', call_id: callId, name: call.name || '', arguments: argsText })
    const out = results[i] ? results[i].payload : JSON.stringify({ error: ERRORS.TOOL_EXEC_FAILED })
    inputItems.push({ type: 'function_call_output', call_id: callId, output: out })
  }
}

async function executeCall(call, workspaceTools) {
  const name = call && call.name ? String(call.name) : ''
  let args = {}
  try { args = typeof call.arguments === 'string' ? JSON.parse(call.arguments || '{}') : (call.arguments || {}) } catch { args = null }
  const record = { name, ok: false, code: null, bytes: 0, path: null }
  const done = (payload) => {
    const clipped = payload.length > LIMITS.maxOutputPerCall ? payload.slice(0, LIMITS.maxOutputPerCall) + '…[truncated]' : payload
    record.outputBytes = byteLen(clipped)
    return { record, payload: clipped }
  }
  if (!workspaceTools) {
    record.code = ERRORS.TOOL_EXEC_FAILED
    record.message = '本地工具未启用'
    return done(JSON.stringify({ error: record.code, message: record.message }))
  }
  if (args == null) {
    record.code = ERRORS.BAD_REQUEST
    record.message = '工具参数不是合法 JSON'
    return done(JSON.stringify({ error: record.code, message: record.message }))
  }
  try {
    const out = workspaceTools.execute(name, args)
    record.ok = true
    record.path = typeof args.path === 'string' ? args.path : null
    record.bytes = Number(out && out.bytes) || Number(out && out.content ? Buffer.byteLength(out.content) : 0) || 0
    return done(JSON.stringify(out))
  } catch (err) {
    record.ok = false
    record.code = (err && err.code) || ERRORS.TOOL_EXEC_FAILED
    record.message = String((err && err.message) || 'tool failed')
    return done(JSON.stringify({ error: record.code, message: record.message }))
  }
}
