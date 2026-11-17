// G2 第二轮治本：终态快照保留已捕获项 + recordContinuation 拒绝空覆盖非空（纯离线，零付费请求 / 零真实上游）。
// 根因闭环：真机 corr=b2d2728d38b52842 — 上一轮治本已让 captureSink 捕获到真实 function_call
// （recorded items=1），但订阅后端把 function_call 只放在 response.output_item.done，
// response.completed.output 为空；终态 snapshot 优先取空的 completedOutput → 返回空 output →
// record_final 幂等覆盖把 items=1 冲成 items=0 → reconstruct restored 只含 input、不含 function_call
// → 下轮 function_call_output 成孤儿 → 上游 400。
// 两处独立修复（互为防御），共用 server.continuationRootFix（默认 ON，仅显式 false 回落旧语义）。
// 脱敏：只注入标记串并断言日志零命中；50hex → other，不写死 56hex；id 仅层级，不记正文/凭据。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  resetContinuationStore, recordContinuation, reconstructContinuation,
  createCaptureSink, configureContinuationRootFix,
} from '../../../src/responses-continuation.js'
import { startGateway, startScriptedUpstream } from './harness.mjs'
import { continuationRootFixOn, offStructIdLevel } from '../../../src/index.js'

const HEX50 = 'c'.repeat(50)
const REAL_ID = 'resp_' + HEX50
const CALL_ID = 'call_' + 'd'.repeat(24)
const FC_ITEM = { type: 'function_call', id: 'fc_snapshot_1', call_id: CALL_ID, name: 'wait_agent', arguments: '{}' }
const ASSISTANT_TEXT = 'SNAPSHOTFIX_UNIQUE_OUTPUT_20261117'
const ASSISTANT_ITEM = { type: 'message', role: 'assistant', id: 'msg_snapshotfix_1', content: [{ type: 'output_text', text: ASSISTANT_TEXT }] }
const PROMPT_MARKER = 'SNAPSHOTFIX_TOPSAFE_PROMPT_7f3a91'
const CLIENT_TOKEN = 'client-snapshotfix-token-9d2c'
const UP_KEY = 'gw-snapshotfix-test-key'
const THREAD = 'thread-snapshotfix-1a2b'
const SESSION = 'sess-snapshotfix-3c4d'
const REQID = 'req-snapshotfix-5e6f'

const msg = (id, role, text) => ({ type: 'message', id, role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] })
const fc = (id, callId) => ({ type: 'function_call', id, call_id: callId, name: 'wait_agent', arguments: '{}' })
const fnOut = (callId, text) => ({ type: 'function_call_output', call_id: callId, output: text })
const sse = (obj) => 'data: ' + JSON.stringify(obj) + '\n\n'

function readLog (gw) {
  const names = readdirSync(gw.dir).filter((n) => n.endsWith('.log')).sort()
  return names.map((n) => readFileSync(join(gw.dir, n), 'utf8')).join('\n')
}
function leaks (text) {
  // 响应 id 由既有运营日志记录，不属本次脱敏范围；敏感串是 prompt/凭据/线程标识。
  const secrets = [PROMPT_MARKER, ASSISTANT_TEXT, CLIENT_TOKEN, 'Bearer', UP_KEY, THREAD, SESSION, REQID]
  return secrets.filter((s) => text.includes(s))
}

// ── 单元测试：直接锁 responses-continuation.js 的两处语义 ────────────────────────

test('开关语义：server.continuationRootFix 仅显式布尔 false 关闭；宽松读取一律默认 ON', () => {
  assert.equal(continuationRootFixOn({ cfg: {} }), true)
  assert.equal(continuationRootFixOn({ cfg: { server: {} } }), true)
  for (const v of [1, 0, 'false', 'true', null, undefined, {}, []]) {
    assert.equal(continuationRootFixOn({ cfg: { server: { continuationRootFix: v } } }), true, '宽松读取 → ON (' + String(v) + ')')
  }
  assert.equal(continuationRootFixOn({ cfg: { server: { continuationRootFix: false } } }), false, '显式 false → 回滚旧行为')
  assert.equal(offStructIdLevel(REAL_ID), 'other', '50hex 必须归 other，不写死 56hex')
})

test('①终态快照保留 function_call：无 response.completed.output、function_call 仅在 output_item.done', (t) => {
  configureContinuationRootFix(true)
  t.after(() => configureContinuationRootFix(true))
  const sink = createCaptureSink()
  sink.write(Buffer.from(sse({ type: 'response.created', response: { id: REAL_ID, status: 'in_progress', output: [] } })))
  sink.write(Buffer.from(sse({ type: 'response.output_item.done', item: FC_ITEM, output_index: 0 })))
  // response.completed 带空 output —— 真机触发空覆盖的精确形状。
  sink.write(Buffer.from(sse({ type: 'response.completed', response: { id: REAL_ID, status: 'completed', output: [] } })))
  const snap = sink.finish()
  assert.equal(snap.responseId, REAL_ID)
  assert.equal(snap.output.length, 1, '终态 items 不回退到 0')
  assert.equal(snap.output[0].type, 'function_call')
  assert.equal(snap.output[0].call_id, CALL_ID)
  const term = sink.terminalSnapshot()
  assert.ok(term, '终态已到达')
  assert.equal(term.output.some((i) => i.type === 'function_call'), true, 'terminalSnapshot 也保留 function_call')
})

test('①变体：完全没有 response.completed 时也不丢已捕获项', (t) => {
  configureContinuationRootFix(true)
  t.after(() => configureContinuationRootFix(true))
  const sink = createCaptureSink()
  sink.write(Buffer.from(sse({ type: 'response.created', response: { id: REAL_ID, status: 'in_progress', output: [] } })))
  sink.write(Buffer.from(sse({ type: 'response.output_item.done', item: FC_ITEM })))
  const snap = sink.finish()
  assert.equal(snap.output.length, 1)
  assert.equal(snap.output[0].type, 'function_call')
})

test('①非回归：completed.output 非空时以其为权威，冲突按 id 去重且不重复', (t) => {
  configureContinuationRootFix(true)
  t.after(() => configureContinuationRootFix(true))
  const sink = createCaptureSink()
  sink.write(Buffer.from(sse({ type: 'response.output_item.done', item: msg('m1', 'assistant', 'partial') })))
  sink.write(Buffer.from(sse({ type: 'response.completed', response: { id: REAL_ID, status: 'completed', output: [msg('m1', 'assistant', 'final')] } })))
  const snap = sink.finish()
  assert.equal(snap.output.length, 1, 'id 冲突只保留 completedOutput 版本，不重复')
  assert.equal(snap.output[0].content[0].text, 'final', 'completedOutput 仍为权威')
})

test('④回滚：显式 false 恢复旧 snapshot 语义（空 completedOutput 优先 → 返回空）', (t) => {
  configureContinuationRootFix(false)
  t.after(() => configureContinuationRootFix(true))
  const sink = createCaptureSink()
  sink.write(Buffer.from(sse({ type: 'response.created', response: { id: REAL_ID, status: 'in_progress', output: [] } })))
  sink.write(Buffer.from(sse({ type: 'response.output_item.done', item: FC_ITEM })))
  sink.write(Buffer.from(sse({ type: 'response.completed', response: { id: REAL_ID, status: 'completed', output: [] } })))
  const snap = sink.finish()
  assert.equal(snap.output.length, 0, '旧行为：function_call 被空快照冲掉')
})

test('②recordContinuation 拒绝空覆盖非空：保留已捕获的 function_call', (t) => {
  configureContinuationRootFix(true)
  t.after(() => configureContinuationRootFix(true))
  resetContinuationStore()
  recordContinuation({ responseId: REAL_ID, prevId: null, input: [msg('u1', 'user', 'q')], output: [fc('fc1', CALL_ID)], status: 'in_progress' })
  const guarded = recordContinuation({ responseId: REAL_ID, prevId: null, input: [msg('u1', 'user', 'q')], output: [], status: 'completed' })
  assert.equal(guarded.recorded, false)
  assert.equal(guarded.reason, 'keep_richer_output')
  const rec = reconstructContinuation(REAL_ID, [fnOut(CALL_ID, 'CHILD_DONE')])
  assert.equal(rec.ok, true)
  assert.equal(rec.input.some((i) => i.type === 'function_call'), true, '终态空快照未冲掉 function_call')
})

test('④回滚：显式 false 时 recordContinuation 恢复无条件覆盖（空 output 冲掉非空）', (t) => {
  configureContinuationRootFix(false)
  t.after(() => configureContinuationRootFix(true))
  resetContinuationStore()
  recordContinuation({ responseId: REAL_ID, input: [msg('u1', 'user', 'q')], output: [fc('fc1', CALL_ID)] })
  const overwrite = recordContinuation({ responseId: REAL_ID, input: [msg('u1', 'user', 'q')], output: [] })
  assert.equal(overwrite.recorded, true, '旧行为：无条件覆盖')
  const rec = reconstructContinuation(REAL_ID, [fnOut(CALL_ID, 'CHILD_DONE')])
  assert.equal(rec.input.some((i) => i.type === 'function_call'), false, '旧行为：function_call 丢失')
})

test('③reconstruct restored 的输出含 function_call（不再只 input），function_call_output 不 orphan', (t) => {
  configureContinuationRootFix(true)
  t.after(() => configureContinuationRootFix(true))
  resetContinuationStore()
  // 模拟记录链：created 空登记 → output_item.done 捕获 function_call → 终态空快照（被 guard 拒绝）。
  const sink = createCaptureSink()
  sink.write(Buffer.from(sse({ type: 'response.created', response: { id: REAL_ID, status: 'in_progress', output: [] } })))
  const early = sink.takeRecordable()
  recordContinuation({ responseId: early.responseId, input: [msg('u1', 'user', 'q')], output: early.output })
  sink.write(Buffer.from(sse({ type: 'response.output_item.done', item: FC_ITEM })))
  const mid = sink.takeRecordable()
  recordContinuation({ responseId: mid.responseId, input: [msg('u1', 'user', 'q')], output: mid.output })
  assert.equal(mid.output.length, 1)
  sink.write(Buffer.from(sse({ type: 'response.completed', response: { id: REAL_ID, status: 'completed', output: [] } })))
  const final = sink.finish()
  assert.equal(final.output.length, 1, '终态快照本身保留 function_call')
  recordContinuation({ responseId: final.responseId, input: [msg('u1', 'user', 'q')], output: final.output, status: 'completed' })

  const rec = reconstructContinuation(REAL_ID, [fnOut(CALL_ID, 'CHILD_DONE'), msg('u2', 'user', '继续')])
  assert.equal(rec.ok, true)
  const callAt = rec.input.findIndex((i) => i.type === 'function_call' && i.call_id === CALL_ID)
  const outAt = rec.input.findIndex((i) => i.type === 'function_call_output' && i.call_id === CALL_ID)
  assert.ok(callAt >= 0 && outAt > callAt, 'function_call 被 restored 且排在结果前，不产生孤儿')
  assert.equal(rec.input[outAt].output, 'CHILD_DONE', '工具结果内容逐字保留')
})

// ── 集成测试：真实网关 + 脚本上游，验证端到端与护栏 ─────────────────────────────

function reqOpts (bodyExtra = {}) {
  return {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + CLIENT_TOKEN,
      'thread-id': THREAD,
      'session-id': SESSION,
      'x-request-id': REQID,
      'content-type': 'application/json',
    },
    body: { model: 'gpt-6-astra', input: PROMPT_MARKER, stream: true, ...bodyExtra },
  }
}
function orphanToolInput () {
  return [fnOut(CALL_ID, 'CHILD_DONE'), { type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续' }] }]
}
// function_call 只在 output_item.done；response.completed.output 为空（真机形状）。
function fnSseBody (id = REAL_ID) {
  return sse({ type: 'response.created', response: { id, status: 'in_progress', output: [] } }) +
    sse({ type: 'response.output_item.done', item: FC_ITEM, output_index: 0 }) +
    sse({ type: 'response.completed', response: { id, status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })
}
async function setup (t, { server, ct = '' } = {}) {
  const hits = []
  const upstream = await startScriptedUpstream(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    hits.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    res.writeHead(200, { 'content-type': ct })
    res.end(fnSseBody())
  })
  const gw = await startGateway({
    env: { MG_TEST_OFFICIAL_KEY: UP_KEY },
    config: {
      defaults: { model: '', codexOfficialHosts: ['localhost'] },
      server: Object.assign({ diagnosticOfficialStructure: true }, server || {}),
      providers: { 'codex-official': { baseUrl: 'http://localhost:' + upstream.port, codexIdentity: 'official', apiKeyEnv: 'MG_TEST_OFFICIAL_KEY' } },
      models: { 'gpt-6-astra': { provider: 'codex-official', api: 'responses' } },
    },
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })
  return { gw, hits }
}

test('⑤⑥⑦端到端：function_call 被终态保留，下一轮不 orphan、无 400；上一轮成果不回退；日志脱敏', async (t) => {
  const { gw, hits } = await setup(t) // 默认空 content-type：同时验证 ct 嗅探
  const r1 = await gw.call('/v1/responses', reqOpts())
  assert.equal(r1.status, 200)
  assert.match(r1.headers.get('content-type') || '', /text\/event-stream/, 'CT 写回被纠正为 SSE（上一轮成果）')
  const text1 = await r1.text()
  assert.ok(text1.includes(REAL_ID), '真实 id 出现在回写正文')
  const log1 = readLog(gw)
  assert.ok(log1.includes('kind=sse'), 'ct 嗅探让 SSE 正文走 SSE 分支（上一轮成果）')
  assert.match(log1, /mgp0\.offstruct\.sinkattach[^\n]*branch=(codex|raw)[^\n]*attached=1/, 'captureSink 挂载仍生效（上一轮成果）')
  assert.ok(log1.includes('responses continuation recorded'), '真实 id 登记仍生效（上一轮成果）')

  const r2 = await gw.call('/v1/responses', reqOpts({ previous_response_id: REAL_ID, input: orphanToolInput() }))
  assert.equal(r2.status, 200, '不再因孤儿 function_call_output 触发 400')
  await r2.text()
  assert.equal(hits.length, 2)
  const log = readLog(gw)
  assert.ok(log.includes('responses continuation reconstructed'), '重建命中')
  assert.equal(log.includes('responses continuation degraded'), false, '无降级')
  assert.equal(log.includes('continuation reconstruct fail-closed'), false, '无止损 typed 400')
  const hit2 = hits[1]
  assert.equal(Object.prototype.hasOwnProperty.call(hit2, 'previous_response_id'), false, '转发前剔除 prev')
  const fcAt = hit2.input.findIndex((i) => i.type === 'function_call' && i.call_id === CALL_ID)
  const outAt = hit2.input.findIndex((i) => i.type === 'function_call_output' && i.call_id === CALL_ID)
  assert.ok(fcAt >= 0 && outAt > fcAt, 'reconstruct 输出含真实 function_call 且排在结果前')
  assert.equal(leaks(log).length, 0, '日志零泄漏敏感串')
})

test('④回滚端到端：显式 false 时 function_call 不进 store，reconstruct 输出不含它（旧行为）', async (t) => {
  const { gw, hits } = await setup(t, { server: { continuationRootFix: false }, ct: 'text/event-stream' })
  const r1 = await gw.call('/v1/responses', reqOpts())
  assert.equal(r1.status, 200)
  await r1.text()
  assert.ok(readLog(gw).includes('responses continuation recorded'))
  const r2 = await gw.call('/v1/responses', reqOpts({ previous_response_id: REAL_ID, input: orphanToolInput() }))
  assert.equal(r2.status, 200)
  await r2.text()
  const hit2 = hits[1]
  assert.equal(hit2.input.some((i) => i.type === 'function_call' && i.call_id === CALL_ID), false, '旧行为：终态空快照冲掉 function_call')
})

test('⑥护栏：普通对话（无 previous_response_id）逐字节不变、不触发续轮逻辑', async (t) => {
  const { gw, hits } = await setup(t, { ct: 'text/event-stream' })
  const req = reqOpts({ input: 'plain hello' })
  const r = await gw.call('/v1/responses', req)
  assert.equal(r.status, 200)
  await r.text()
  assert.deepEqual(hits[0], req.body, '上游收到的 body 与发送一致')
  const log = readLog(gw)
  for (const marker of ['responses continuation reconstructed', 'responses continuation degraded', 'continuation reconstruct fail-closed']) {
    assert.equal(log.includes(marker), false, '普通对话不得触发续轮逻辑：' + marker)
  }
  assert.equal(leaks(log).length, 0)
})

test('⑥护栏：止损 fail-closed 仍生效（未知 prev → typed 400，孤儿 output 不发上游）', async (t) => {
  const { gw, hits } = await setup(t, { ct: 'text/event-stream' })
  const unknown = 'resp_' + 'f'.repeat(50)
  const r = await gw.call('/v1/responses', reqOpts({ previous_response_id: unknown, input: orphanToolInput() }))
  assert.equal(r.status, 400)
  const body = await r.json()
  assert.equal(body.error.code, 'continuation_reconstruct_failed')
  assert.equal(body.error.type, 'continuation_error')
  assert.match(body.error.message, /corr=[0-9a-f]+/)
  assert.equal(hits.length, 0, '孤儿 output 的上游 POST 未发出')
  const lines = readLog(gw).split('\n').filter((l) => l.includes('continuation reconstruct fail-closed'))
  assert.ok(lines.length >= 1)
  assert.ok(lines.join('\n').includes('idLevel=other'), '50hex → other')
  assert.equal(leaks(lines.join('\n')).length, 0)
})

test('⑥护栏：治本只落官方路径；第三方 tool-call id 剔除逻辑零改动；本轮两处修复都在开关保护下', () => {
  const src = readFileSync(join(process.cwd(), 'src/index.js'), 'utf8')
  const contSrc = readFileSync(join(process.cwd(), 'src/responses-continuation.js'), 'utf8')
  const offStart = src.indexOf('async function proxyOfficialResponses')
  const nativeStart = src.indexOf('async function proxyNativeResponses')
  assert.ok(offStart > 0 && nativeStart > offStart)
  const officialBlock = src.slice(offStart, nativeStart)
  const nativeBlock = src.slice(nativeStart, nativeStart + 60000)
  assert.ok(officialBlock.includes('continuationRootFixOn'), '开关落在官方路径')
  assert.ok(officialBlock.includes('configureContinuationRootFix'), '本轮开关透传落在官方路径')
  assert.equal(nativeBlock.includes('continuationRootFixOn'), false, '第三方路径不引入治本开关')
  assert.equal(nativeBlock.includes('configureContinuationRootFix'), false, '第三方路径不引入本轮开关透传')
  assert.ok(nativeBlock.includes('third_party_tool_call_id_missing'), '第三方 tool-call id 剔除逻辑仍在')
  assert.ok(contSrc.includes('mergeCapturedOutput'), '终态快照合并修复在位')
  assert.ok(contSrc.includes('keep_richer_output'), '空覆盖保护在位')
  assert.ok(/rootFixOn[^\n]*prev[^\n]*output\.length/.test(contSrc), '两处修复均受同一开关保护')
})
