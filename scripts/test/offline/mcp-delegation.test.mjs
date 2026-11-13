// G3/G4：ModelGate 本地 MCP 委派（OpenCode Go 外部 worker）离线验收。
//
// 覆盖：契约拒绝矩阵、状态机/持久化/对账、delegate→工具执行→结果回执、幂等（不重复派发）、
// 同 session 追派、wait 超时≠失败、取消、上游失败不重试、凭据与会话头隔离。
//
// 全部离线：回环 mock 上游 + 合成 Key + 临时工作区/状态目录。不访问真实 OpenCode Go、不读 Codex auth.json。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTaskStore, StoreError } from '../../../src/mcp/delegation-store.js'
import { createDelegationServer } from '../../../src/mcp/delegation-server.js'
import { createWorkspaceTools } from '../../../src/mcp/delegation-tools.js'
import { buildProvider } from '../../../src/router.js'
import {
  ERRORS, LIMITS, STATES, parseCancelArgs, parseDelegateArgs, parseFollowupArgs, parseGetArgs, parseWaitArgs, sanitizeResultText,
} from '../../../src/mcp/delegation-contract.js'

const MODEL = 'deepseek-v4.1-flash'
const SHA = (s) => createHash('sha256').update(s).digest('hex')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function sseFrame(event, data) { return 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n' }

async function startGoMock(script) {
  const hits = []
  const holds = []
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    let body = null
    try { body = JSON.parse(raw) } catch {}
    const index = hits.length
    hits.push({ method: req.method, path: req.url, headers: req.headers, body, raw, at: Date.now() })
    const step = script[Math.min(index, script.length - 1)]
    const out = typeof step === 'function' ? await step({ index, body, res }) : step
    if (!out) { res.statusCode = 500; res.end('no script'); return }
    res.statusCode = out.status || 200
    for (const [k, v] of Object.entries(out.headers || {})) res.setHeader(k, v)
    if (out.hold) {
      res.setHeader('content-type', 'text/event-stream')
      if (out.first) res.write(out.first)
      holds.push({ index, res, end: () => { try { res.end() } catch {} } })
      return
    }
    if (out.sse) {
      res.setHeader('content-type', 'text/event-stream')
      for (const frame of out.sse) res.write(frame)
      res.end()
      return
    }
    res.setHeader('content-type', 'application/json')
    res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  return {
    port,
    hits,
    holds,
    baseUrl: 'http://127.0.0.1:' + port,
    close: () => new Promise((r) => server.close(r)),
  }
}

function makeSetup(mock, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mg-mcp-'))
  const stateDir = join(dir, 'state')
  const workspace = join(dir, 'ws')
  const { mkdirSync } = require_fs()
  mkdirSync(stateDir, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  const cfg = {
    defaults: { proxyMode: 'direct', retry: { maxAttempts: 1 } },
    providers: {
      opencodego: { baseUrl: mock.baseUrl, api: 'openai' },
    },
    models: { [MODEL]: { provider: 'opencodego', api: 'openai' } },
    _keys: { opencodego: 'test-go-key-not-real' },
  }
  const workspaceTools = createWorkspaceTools({ root: workspace, enabled: opts.tools || ['read_file', 'list_dir', 'write_file', 'stat_path'] })
  const store = createTaskStore({ dir: join(stateDir, 'tasks') })
  const server = createDelegationServer({
    cfg,
    store,
    providerId: 'opencodego',
    model: MODEL,
    workspaceRoot: workspace,
    workspaceTools: opts.noTools ? null : workspaceTools,
    maxConcurrent: Number(opts.maxConcurrent) || 2,
    maxSteps: opts.maxSteps,
    now: opts.now,
    ownerRef: opts.ownerRef,
  })
  return {
    dir, stateDir, workspace, cfg, store, server, workspaceTools,
    cleanup: () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} },
    provider: () => buildProvider(cfg, 'opencodego'),
  }
}
function require_fs() { return { mkdirSync: (p, o) => { const fs = fsRef; return fs.mkdirSync(p, o) } } }
import * as fsRef from 'node:fs'

async function waitState(store, taskRef, states, ms = 4000) {
  const t0 = Date.now()
  for (;;) {
    const rec = store.get(taskRef)
    const turn = rec && rec.turns[rec.turns.length - 1]
    if (turn && states.includes(turn.state)) return turn
    if (Date.now() - t0 > ms) throw new Error('等待状态超时：期望 ' + states.join('/') + '，实际 ' + (turn && turn.state))
    await sleep(15)
  }
}

const toolCallFrame = (callId, name, args) => sseFrame('response.output_item.done', {
  type: 'response.output_item.done',
  item: { type: 'function_call', call_id: callId, name, arguments: JSON.stringify(args) },
})
const completedFrame = (id, text, usage) => sseFrame('response.completed', {
  type: 'response.completed',
  response: {
    id,
    status: 'completed',
    output: text == null ? [] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
    usage: usage || { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  },
})

function fullLoopScript() {
  return [
    () => ({ sse: [
      sseFrame('response.created', { type: 'response.created', response: { id: 'resp_1' } }),
      toolCallFrame('call_a', 'write_file', { path: 'child-out.txt', content: 'hello-from-go-child' }),
      completedFrame('resp_1', null),
    ] }),
    () => ({ sse: [
      sseFrame('response.output_text.delta', { type: 'response.output_text.delta', delta: 'ignored-delta' }),
      completedFrame('resp_2', '已写入 child-out.txt（sha256 见工具结果）'),
    ] }),
  ]
}

test('契约：delegate 入参拒绝矩阵（未知键/超长/密文/凭据/预算/幂等键）', () => {
  const ok = parseDelegateArgs({ task: 'do it', idempotencyKey: 'idem-0001' })
  assert.equal(ok.ok, true)
  assert.equal(ok.value.budgetMs, LIMITS.budgetMsDefault)
  assert.match(ok.value.requestDigest, /^[0-9a-f]{64}$/)

  const K = 'idem-0001'
  const cases = [
    // 契约 §8 拒绝优先级：V2 密文 → 凭据 → 目标 URL → provider → model → 未知字段
    [{ task: 'x', idempotencyKey: K, title: { encrypted_content: 'AAAA' } }, ERRORS.OPAQUE_V2],
    [{ task: 'x', idempotencyKey: K, constraints: { authorization: 'Bearer x' } }, ERRORS.CREDENTIAL_IN_ARGUMENT],
    [{ task: 'x', idempotencyKey: K, title: { baseUrl: 'https://evil.example' } }, ERRORS.URL_NOT_ALLOWED],
    [{ task: 'x', idempotencyKey: K, provider: 'evil' }, ERRORS.PROVIDER_NOT_ALLOWED],
    [{ task: 'x', idempotencyKey: K, model: 'gpt-6-luna' }, ERRORS.MODEL_NOT_ALLOWED],
    [{ task: 'x', idempotencyKey: K, arbitrary: 'y' }, ERRORS.BAD_REQUEST],
    [{ task: 'x' }, ERRORS.BAD_REQUEST],
    [{ task: '', idempotencyKey: K }, ERRORS.BAD_REQUEST],
    [{ task: 'x'.repeat(LIMITS.taskBytes + 1), idempotencyKey: K }, ERRORS.TOO_LARGE],
    [{ task: 'x', idempotencyKey: 'bad key!' }, ERRORS.IDEM_KEY_INVALID],
    [{ task: 'use sk-abcdefghijklmnopqrstuvwx now', idempotencyKey: K }, ERRORS.SECRET_REJECTED],
    [{ task: 'x', idempotencyKey: K, budgetMs: 10 }, ERRORS.BUDGET_INVALID],
    [{ task: 'x', idempotencyKey: K, workspaceRefs: [{ path: '../etc/passwd' }] }, ERRORS.WORKSPACE_DENIED],
    [{ task: 'x', idempotencyKey: K, workspaceRefs: [{ path: '/abs' }] }, ERRORS.WORKSPACE_DENIED],
    [{ task: 'x', idempotencyKey: K, workspaceRefs: [{ path: 'a.txt', kind: 'file', content: 'x' }] }, ERRORS.BAD_REQUEST],
  ]
  for (const [input, code] of cases) {
    const r = parseDelegateArgs(input)
    assert.equal(r.ok, false, JSON.stringify(input).slice(0, 80))
    assert.equal(r.error.code, code, JSON.stringify(input).slice(0, 80))
  }
  assert.equal(parseGetArgs({ taskRef: 'nope' }).ok, false)
  assert.equal(parseWaitArgs({ taskRef: 'mgtask-0123456789abcdef', timeoutMs: 999999 }).value.timeoutMs, LIMITS.waitMaxMs)
  assert.equal(parseCancelArgs({ taskRef: 'mgtask-0123456789abcdef' }).ok, true)
  assert.equal(parseFollowupArgs({ taskRef: 'mgtask-0123456789abcdef', task: 'x' }).ok, false)
})

test('状态机：非法转移被拒绝；重启把在途回合对账成 UNKNOWN 且不重发', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mg-mcp-store-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = createTaskStore({ dir: join(dir, 'tasks') })
  const rec = store.create({
    taskRef: 'mgtask-00000000000000a1', provider: 'opencodego', model: MODEL,
    requestDigest: 'd1', taskBytes: 3, budgetMs: 1000, idempotencyKey: 'idem-0001',
  })
  const turnId = rec.turns[0].turnId
  store.transition(rec.taskRef, turnId, STATES.ADMITTED)
  assert.throws(() => store.transition(rec.taskRef, turnId, STATES.RESULT_READY), (e) => e instanceof StoreError && e.code === ERRORS.STATE_CONFLICT)
  store.transition(rec.taskRef, turnId, STATES.DISPATCHED)
  assert.throws(() => store.transition(rec.taskRef, turnId, STATES.ADMITTED), (e) => e.code === ERRORS.STATE_CONFLICT)

  const store2 = createTaskStore({ dir: join(dir, 'tasks') })
  const reconciled = store2.reconcile()
  assert.equal(reconciled.length, 1)
  const turn = store2.mustGet(rec.taskRef).turns[0]
  assert.equal(turn.state, STATES.UNKNOWN)
  assert.equal(turn.error.code, ERRORS.UPSTREAM_UNKNOWN)
  assert.equal(store2.reconcile().length, 0, '对账必须幂等')
})

test('完整闭环：delegate → 真实 SSE → 本地工具执行 → 结果回执 → ACK，且凭据/会话头隔离', async (t) => {
  const mock = await startGoMock(fullLoopScript())
  const env = makeSetup(mock)
  t.after(async () => { await env.server.shutdown(); await mock.close(); env.cleanup() })

  const r = await env.server.callTool('modelgate_delegate_task', {
    task: '把 hello-from-go-child 写进 child-out.txt 并如实报告',
    idempotencyKey: 'idem-full-1',
    workspaceRefs: [{ path: 'child-out.txt', kind: 'file' }],
    budgetMs: 20000,
  })
  assert.equal(r.isError, undefined)
  const taskRef = r.structuredContent.taskRef
  assert.match(taskRef, /^mgtask-[0-9a-f]{16}$/)

  const waited = await env.server.callTool('modelgate_wait_task', { taskRef, timeoutMs: 8000 })
  assert.equal(waited.isError, undefined)
  assert.equal(waited.structuredContent.state, STATES.RESULT_READY)
  assert.equal(waited.structuredContent.waitTimedOut, false)
  const result = waited.structuredContent.result
  assert.match(result.text, /已写入 child-out\.txt/)
  assert.equal(result.toolCallCount, 1)
  assert.equal(result.toolCalls[0].name, 'write_file')
  assert.equal(result.toolCalls[0].ok, true)
  assert.equal(result.artifacts[0].path, 'child-out.txt')
  assert.equal(result.artifacts[0].changed, true)
  assert.equal(result.artifacts[0].sha256After, SHA('hello-from-go-child'))
  assert.equal(result.upstream.responseId, 'resp_2')
  assert.deepEqual(result.usage, { input: 10, output: 5, total: 15, kind: 'actual' })

  // 真实落盘：文件确实被本地工具写出
  assert.equal(readFileSync(join(env.workspace, 'child-out.txt'), 'utf8'), 'hello-from-go-child')

  // 上游只应收到 2 次（第一轮工具调用 + 第二轮收敛），不得重放
  assert.equal(mock.hits.length, 2)
  for (const hit of mock.hits) {
    assert.equal(hit.headers.authorization, 'Bearer test-go-key-not-real')
    assert.match(String(hit.headers['x-opencode-session']), /^mgs-[0-9a-f]{32}$/)
    assert.equal(hit.headers['chatgpt-account-id'], undefined, 'Go 请求不得带 ChatGPT 账号头')
    assert.equal(hit.body.store, false)
    assert.equal(hit.body.stream, true)
    assert.equal(hit.body.model, MODEL)
  }
  assert.equal(mock.hits[0].headers['x-opencode-session'], mock.hits[1].headers['x-opencode-session'], '同一回合内会话标识稳定')
  // 第二轮必须把本地工具结果回填给上游
  const secondInput = JSON.stringify(mock.hits[1].body.input)
  assert.match(secondInput, /function_call_output/)
  assert.match(secondInput, new RegExp(SHA('hello-from-go-child')))

  // 读取结果后推进 ACKNOWLEDGED
  const ack = await env.server.callTool('modelgate_get_task', { taskRef })
  assert.equal(ack.structuredContent.state, STATES.ACKNOWLEDGED)
  assert.equal(ack.structuredContent.delegation.native, false)
  assert.equal(ack.structuredContent.delegation.degraded, true)
})

test('幂等：同 key 同摘要是回放、同 key 不同摘要冲突；都不产生第二次上游调用', async (t) => {
  const mock = await startGoMock(fullLoopScript())
  const env = makeSetup(mock)
  t.after(async () => { await env.server.shutdown(); await mock.close(); env.cleanup() })

  const a = await env.server.callTool('modelgate_delegate_task', { task: '任务甲', idempotencyKey: 'idem-same' })
  const taskRef = a.structuredContent.taskRef
  await env.server.callTool('modelgate_wait_task', { taskRef, timeoutMs: 8000 })
  const hitsAfterFirst = mock.hits.length

  const b = await env.server.callTool('modelgate_delegate_task', { task: '任务甲', idempotencyKey: 'idem-same' })
  assert.equal(b.structuredContent.replayed, true)
  assert.equal(b.structuredContent.taskRef, taskRef)
  assert.equal(mock.hits.length, hitsAfterFirst, '幂等回放不得再发上游')

  const c = await env.server.callTool('modelgate_delegate_task', { task: '任务乙（不同正文）', idempotencyKey: 'idem-same' })
  assert.equal(c.isError, true)
  assert.equal(c.structuredContent.error.code, ERRORS.IDEM_CONFLICT)
  assert.equal(mock.hits.length, hitsAfterFirst)
})

test('同 session 追派：复用 taskRef/session，两轮各自独立回执，幂等不重复派发', async (t) => {
  const mock = await startGoMock([
    ...fullLoopScript(),
    () => ({ sse: [completedFrame('resp_3', '第二轮完成：child-out.txt 仍在')] }),
  ])
  const env = makeSetup(mock)
  t.after(async () => { await env.server.shutdown(); await mock.close(); env.cleanup() })

  const a = await env.server.callTool('modelgate_delegate_task', { task: '第一轮：写文件', idempotencyKey: 'idem-round-1' })
  const taskRef = a.structuredContent.taskRef
  const w1 = await env.server.callTool('modelgate_wait_task', { taskRef, timeoutMs: 8000 })
  assert.equal(w1.structuredContent.state, STATES.RESULT_READY)
  const session1 = mock.hits[0].headers['x-opencode-session']

  const f = await env.server.callTool('modelgate_followup_task', { taskRef, task: '第二轮：确认文件还在', idempotencyKey: 'idem-round-2' })
  assert.equal(f.isError, undefined)
  assert.equal(f.structuredContent.turns, 2)
  const w2 = await env.server.callTool('modelgate_wait_task', { taskRef, timeoutMs: 8000 })
  assert.equal(w2.structuredContent.state, STATES.RESULT_READY)
  assert.match(w2.structuredContent.result.text, /第二轮完成/)
  assert.equal(mock.hits.length, 3)
  assert.equal(mock.hits[2].headers['x-opencode-session'], session1, '追派必须复用同一 Go session')

  const replay = await env.server.callTool('modelgate_followup_task', { taskRef, task: '第二轮：确认文件还在', idempotencyKey: 'idem-round-2' })
  assert.equal(replay.structuredContent.replayed, true)
  assert.equal(mock.hits.length, 3, '追派幂等回放不得再发上游')
})

test('wait 超时不等于失败；取消后状态为 CANCELLED 且如实记录上游停止未知', async (t) => {
  const mock = await startGoMock([
    () => ({ hold: true, first: sseFrame('response.created', { type: 'response.created', response: { id: 'resp_hold' } }) }),
  ])
  const env = makeSetup(mock)
  t.after(async () => { await env.server.shutdown(); await mock.close(); env.cleanup() })

  const a = await env.server.callTool('modelgate_delegate_task', { task: '长任务', idempotencyKey: 'idem-hold', budgetMs: 30000 })
  const taskRef = a.structuredContent.taskRef
  await waitState(env.store, taskRef, [STATES.RUNNING])

  const w = await env.server.callTool('modelgate_wait_task', { taskRef, timeoutMs: 80 })
  assert.equal(w.structuredContent.waitTimedOut, true)
  assert.equal(w.structuredContent.state, STATES.RUNNING, 'wait 超时不得把任务改成失败或终态')

  const c = await env.server.callTool('modelgate_cancel_task', { taskRef, reason: 'test-cancel' })
  assert.equal(c.structuredContent.state, STATES.CANCELLED)
  assert.equal(c.structuredContent.cancel.delivered, true)
  assert.equal(c.structuredContent.cancel.upstreamStopUnknown, true)

  const again = await env.server.callTool('modelgate_cancel_task', { taskRef })
  assert.equal(again.structuredContent.noop, true)
  assert.equal(mock.hits.length, 1)
})

test('上游 5xx：任务 FAILED 且只发一次（不重试、不换上游、不重复执行）', async (t) => {
  const mock = await startGoMock([() => ({ status: 502, body: { error: { message: 'upstream boom' } } })])
  const env = makeSetup(mock)
  t.after(async () => { await env.server.shutdown(); await mock.close(); env.cleanup() })

  const a = await env.server.callTool('modelgate_delegate_task', { task: '会失败的任务', idempotencyKey: 'idem-5xx' })
  const taskRef = a.structuredContent.taskRef
  const w = await env.server.callTool('modelgate_wait_task', { taskRef, timeoutMs: 8000 })
  assert.equal(w.structuredContent.state, STATES.FAILED)
  assert.match(w.structuredContent.error.code, /^MCP_UPSTREAM_/)
  assert.equal(mock.hits.length, 1, '委派任务绝不重放')

  const afterFail = await env.server.callTool('modelgate_followup_task', { taskRef, task: '再试一次', idempotencyKey: 'idem-5xx-f' })
  assert.equal(afterFail.isError, undefined, '终态失败后允许同 session 追派一次新回合')
  await env.server.callTool('modelgate_wait_task', { taskRef, timeoutMs: 8000 })
  assert.equal(mock.hits.length, 2)
})

test('工作区工具：路径逃逸与绝对路径一律拒绝；未启用工具时不虚构工具执行', async (t) => {
  const mock = await startGoMock([() => ({ sse: [completedFrame('resp_x', '纯文本回答')] })])
  const env = makeSetup(mock, { noTools: true })
  t.after(async () => { await env.server.shutdown(); await mock.close(); env.cleanup() })

  const tools = createWorkspaceTools({ root: env.workspace })
  assert.throws(() => tools.execute('read_file', { path: '../x' }), (e) => e.code === ERRORS.WORKSPACE_DENIED)
  assert.throws(() => tools.execute('read_file', { path: '/etc/passwd' }), (e) => e.code === ERRORS.WORKSPACE_DENIED)
  assert.throws(() => tools.execute('write_file', { path: 'a/../../x', content: 'x' }), (e) => e.code === ERRORS.WORKSPACE_DENIED)

  const a = await env.server.callTool('modelgate_delegate_task', { task: '只回答，不碰文件', idempotencyKey: 'idem-notools' })
  const w = await env.server.callTool('modelgate_wait_task', { taskRef: a.structuredContent.taskRef, timeoutMs: 8000 })
  assert.equal(w.structuredContent.state, STATES.RESULT_READY)
  assert.equal(w.structuredContent.result.toolCallCount, 0)
  assert.ok(w.structuredContent.result.lossy.some((l) => l.kind === 'no_workspace_tools'), '无工具时必须显式标记 lossy')
  assert.equal(mock.hits[0].body.tools, undefined)
})

test('结果脱敏与截断：默认不静默裁剪，显式允许才截断', () => {
  const secret = 'token sk-abcdefghijklmnopqrstuvwx done'
  const s = sanitizeResultText(secret)
  assert.equal(s.text.includes('sk-abcdefghijklmnopqrstuvwx'), false)
  const big = 'x'.repeat(LIMITS.maxResultBytes + 10)
  const over = sanitizeResultText(big)
  assert.equal(over.truncated, false)
  assert.equal(over.overLimit, true)
  const cut = sanitizeResultText(big, { allowTruncation: true })
  assert.equal(cut.truncated, true)
  assert.ok(Buffer.byteLength(cut.text, 'utf8') <= LIMITS.maxResultBytes)
})

test('归属隔离：不同 ownerRef 不能读取/取消他人 taskRef（NOT_OWNER，不泄露内容）', async (t) => {
  const mock = await startGoMock(fullLoopScript())
  const env = makeSetup(mock)
  t.after(async () => { await env.server.shutdown(); await mock.close(); env.cleanup() })

  const a = await env.server.callTool('modelgate_delegate_task', { task: '归属测试任务', idempotencyKey: 'idem-owner-1' })
  const taskRef = a.structuredContent.taskRef
  await env.server.callTool('modelgate_wait_task', { taskRef, timeoutMs: 8000 })
  assert.match(String(a.structuredContent.ownerRef), /^mgowner-[0-9a-f]{16}$/)

  const otherServer = createDelegationServer({
    cfg: env.cfg,
    store: env.store,
    providerId: 'opencodego',
    model: MODEL,
    workspaceRoot: env.workspace,
    workspaceTools: env.workspaceTools,
    ownerRef: 'mgowner-ffffffffffffffff',
  })
  const denied = await otherServer.callTool('modelgate_get_task', { taskRef })
  assert.equal(denied.isError, true)
  assert.equal(denied.structuredContent.error.code, ERRORS.NOT_OWNER)
  const deniedCancel = await otherServer.callTool('modelgate_cancel_task', { taskRef })
  assert.equal(deniedCancel.structuredContent.error.code, ERRORS.NOT_OWNER)
  await otherServer.shutdown()
})

test('MCP 协议：initialize / tools/list / 未知方法 / 未知工具', async (t) => {
  const mock = await startGoMock([() => ({ sse: [completedFrame('r', 'x')] })])
  const env = makeSetup(mock)
  t.after(async () => { await env.server.shutdown(); await mock.close(); env.cleanup() })

  const init = await env.server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })
  assert.equal(init.result.serverInfo.name, 'modelgate-mcp-delegation')
  assert.equal(init.result.capabilities.tools.listChanged, false)
  assert.equal(await env.server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null)

  const list = await env.server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  const names = list.result.tools.map((x) => x.name)
  assert.deepEqual(names, ['modelgate_delegate_task', 'modelgate_get_task', 'modelgate_wait_task', 'modelgate_followup_task', 'modelgate_cancel_task'])

  const bad = await env.server.handle({ jsonrpc: '2.0', id: 3, method: 'nope' })
  assert.equal(bad.error.code, -32601)

  // 未知工具名是通道 A（JSON-RPC error），不是工具结果错误
  const unknownTool = await env.server.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'shell', arguments: {} } })
  assert.equal(unknownTool.error.code, -32602)
  assert.equal(unknownTool.error.data.modelgateCode, ERRORS.UNKNOWN_TOOL)

  const missing = await env.server.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'modelgate_get_task', arguments: { taskRef: 'mgtask-ffffffffffffffff' } } })
  assert.equal(missing.result.structuredContent.error.code, ERRORS.TASK_NOT_FOUND)
})
