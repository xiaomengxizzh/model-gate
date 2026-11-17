// G2 止损 P0-B：正式 fail-closed（默认 ON）· 双向回归（纯离线，零付费请求 / 零真实上游）。
// 把单轮 C 已验证机理的 fail-closed 从实验仪器转为默认正式行为：官方续轮 reconstruct
// 未命中 / restored=0 时不再降级转发孤儿 function_call_output，而是返回可操作 typed 400。
// 正向：命中走原路径 / 普通对话零影响 / 显式 false 回落降级；
// 反向：未命中 typed 400 且携带孤儿 output 的上游 POST 未发出（mock 计数 2→1）。
// 脱敏：hashId/offStructIdLevel；50hex→other；日志只记 type/计数/布尔/id 层级/corr。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { startGateway, startScriptedUpstream } from './harness.mjs'
import {
  offStructIdLevel,
  p0bFailClosedOnReconstructMiss,
  p0bCorr,
} from '../../../src/index.js'

const HEX50 = 'c'.repeat(50) // 真机续轮 id：50hex，必须归 other，不写死 56hex
const REAL_ID = 'resp_' + HEX50
const UNKNOWN_ID = 'resp_' + 'f'.repeat(50)
const PROMPT_MARKER = 'P0B_TOPSAFE_PROMPT_9d2f'
const OUTPUT_TEXT = 'P0B_UNIQUE_OUTPUT_20261117'
const CLIENT_TOKEN = 'client-p0b-token-7b3e'
const UP_KEY = 'gw-p0b-test-key'
const THREAD = 'thread-p0b-1a2b'
const SESSION = 'sess-p0b-3c4d'
const REQID = 'req-p0b-5e6f'
const CALL_ID = 'call_' + 'd'.repeat(24)

function readLog (gw) {
  const names = readdirSync(gw.dir).filter((n) => n.endsWith('.log')).sort()
  return names.map((n) => readFileSync(join(gw.dir, n), 'utf8')).join('\n')
}
function failClosedLines (gw) {
  return readLog(gw).split('\n').filter((l) => l.includes('continuation reconstruct fail-closed'))
}
function leaks (text) {
  const secrets = [PROMPT_MARKER, OUTPUT_TEXT, CLIENT_TOKEN, 'Bearer', UP_KEY, THREAD, SESSION, REQID, REAL_ID, UNKNOWN_ID]
  return secrets.filter((s) => text.includes(s))
}

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
    body: { model: 'gpt-6-astra', input: PROMPT_MARKER, stream: false, ...bodyExtra },
  }
}
// 真实发生的上一轮：带 id 的 assistant 消息 → 登记续轮状态。
function normalResponse () {
  return {
    id: REAL_ID, object: 'response', status: 'completed',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: OUTPUT_TEXT }] }],
  }
}
// 子代理工具结果续轮的增量：孤儿 function_call_output（其 function_call 在上一轮 output 里，
// 但上一轮状态若缺失，降级转发就会把它当孤儿发给上游 → 不可诊断的 400）。
function orphanToolInput () {
  return [
    { type: 'function_call_output', call_id: CALL_ID, output: 'CHILD_DONE' },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续' }] },
  ]
}

async function setup (t, { server, responder } = {}) {
  const hits = []
  const upstream = await startScriptedUpstream(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    hits.push(Buffer.concat(chunks).toString('utf8'))
    const out = responder ? responder(hits.length - 1) : normalResponse()
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(out))
  })
  const gw = await startGateway({
    env: { MG_TEST_OFFICIAL_KEY: UP_KEY },
    config: {
      defaults: { model: '', codexOfficialHosts: ['localhost'] },
      server: server || {},
      providers: { 'codex-official': { baseUrl: 'http://localhost:' + upstream.port, codexIdentity: 'official', apiKeyEnv: 'MG_TEST_OFFICIAL_KEY' } },
      models: { 'gpt-6-astra': { provider: 'codex-official', api: 'responses' } },
    },
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })
  return { gw, hits }
}

test('配置默认语义：未显式 false 就 fail-closed；仅布尔 false 回滚；corr=hashId 无明文', () => {
  // 缺省 / 未配置 / 非严格 false 一律默认 true
  assert.equal(p0bFailClosedOnReconstructMiss({ cfg: {} }), true, '无 server 块 → 默认 ON')
  assert.equal(p0bFailClosedOnReconstructMiss({ cfg: { server: {} } }), true, 'server 块缺键 → 默认 ON')
  assert.equal(p0bFailClosedOnReconstructMiss({ cfg: { server: { p0bFailClosedOnReconstructMiss: true } } }), true)
  for (const v of [1, 0, 'false', 'true', null, undefined, {}, []]) {
    assert.equal(p0bFailClosedOnReconstructMiss({ cfg: { server: { p0bFailClosedOnReconstructMiss: v } } }), true, '宽松读取：非布尔 false → ON (' + String(v) + ')')
  }
  // 唯一显式关闭：布尔 false
  assert.equal(p0bFailClosedOnReconstructMiss({ cfg: { server: { p0bFailClosedOnReconstructMiss: false } } }), false, '显式 false → 回滚旧降级')
  // corr 必须是 hashId，无明文 thread/rid
  const corr = p0bCorr({ headers: { 'thread-id': THREAD, 'x-request-id': REQID } }, null)
  assert.match(corr, /^[0-9a-f]+$/)
  assert.equal(leaks(corr).length, 0)
  assert.equal(offStructIdLevel(REAL_ID), 'other', '50hex → other，不写死 56hex')
})

test('正向：reconstruct 命中 / restored>0 走原续轮路径，无 typed 400，无 fail-closed 信号', async (t) => {
  const { gw, hits } = await setup(t)
  // 轮1：登记 REAL_ID 状态
  const r1 = await gw.call('/v1/responses', reqOpts())
  assert.equal(r1.status, 200)
  // 轮2：同 prev id → 重建命中（restored>0），工具结果不丢
  const r2 = await gw.call('/v1/responses', reqOpts({ previous_response_id: REAL_ID, input: orphanToolInput() }))
  assert.equal(r2.status, 200, '命中不应被止损误伤')
  const body = await r2.json()
  assert.notEqual(body.error && body.error.code, 'continuation_reconstruct_failed')
  assert.equal(hits.length, 2, '两轮均真实到达上游')
  const log = readLog(gw)
  assert.ok(log.includes('responses continuation reconstructed'), '命中走原重建路径')
  assert.equal(failClosedLines(gw).length, 0, '命中不得产生 fail-closed 信号')
})

test('正向：普通对话（无工具、无 previous_response_id）完全不受影响', async (t) => {
  const { gw, hits } = await setup(t)
  const r = await gw.call('/v1/responses', reqOpts({ input: 'plain hello' }))
  assert.equal(r.status, 200)
  assert.match(await r.text(), new RegExp(OUTPUT_TEXT), '输出正文不变')
  assert.equal(hits.length, 1)
  assert.equal(failClosedLines(gw).length, 0, '普通对话不得触发续轮止损')
})

test('正向回滚：显式 p0bFailClosedOnReconstructMiss=false 时回落旧降级行为', async (t) => {
  const { gw, hits } = await setup(t, { server: { p0bFailClosedOnReconstructMiss: false } })
  const r = await gw.call('/v1/responses', reqOpts({ previous_response_id: UNKNOWN_ID, input: orphanToolInput() }))
  assert.equal(r.status, 200, '回滚后未命中仍降级转发，不打断会话')
  assert.equal(hits.length, 1, '降级转发真实到达上游')
  assert.ok(readLog(gw).includes('responses continuation degraded'), '旧降级 warn 仍在')
  assert.equal(failClosedLines(gw).length, 0, '回滚后无 fail-closed typed 400')
})

test('反向：默认配置下 reconstruct miss → typed 400；携带孤儿 output 的上游 POST 未发出（2→1）', async (t) => {
  const { gw, hits } = await setup(t)
  // 轮1：正常登记（POST #1）
  const r1 = await gw.call('/v1/responses', reqOpts())
  assert.equal(r1.status, 200)
  assert.equal(hits.length, 1)
  // 轮2：未知 prev id（miss）+ 孤儿 output → 若降级会发出 POST #2 造成上游 400；止损应拦截
  const r2 = await gw.call('/v1/responses', reqOpts({ previous_response_id: UNKNOWN_ID, input: orphanToolInput() }))
  assert.equal(r2.status, 400, '未命中改 typed 终止')
  assert.equal(hits.length, 1, '携带孤儿 output 的上游 POST 未发出（本应 2，实测 1）')
  const body = await r2.json()
  assert.equal(body.error.code, 'continuation_reconstruct_failed')
  assert.equal(body.error.type, 'continuation_error')
  assert.match(body.error.message, /tool-result turn cannot be safely continued/, 'message 含可操作诊断')
  assert.match(body.error.message, /corr=[0-9a-f]+/, 'message 带 hashId corr')
  assert.match(body.error.corr, /^[0-9a-f]+$/)
  // 脱敏：message / code / 新日志都不含敏感串与明文 id
  assert.equal(leaks(body.error.message + '|' + body.error.code + '|' + body.error.corr).length, 0, 'typed 400 不含敏感串')
  const lines = failClosedLines(gw)
  const text = lines.join('\n')
  assert.ok(lines.length >= 1, '须有 fail-closed 日志便于定位')
  assert.ok(text.includes('idLevel=other'), '50hex prev id 记 other')
  assert.ok(text.includes('restored=0'))
  assert.ok(text.includes('corr='))
  assert.deepEqual(leaks(text), [], 'fail-closed 日志零泄漏')
})

test('反向：实验开关全 OFF 时正式 fail-closed 仍生效；显式开启实验 switch3 保留实验语义（互不干扰）', async (t) => {
  // 三实验子开关全 OFF（且未设正式开关键）→ 默认正式止损仍生效
  const a = await setup(t, { server: { g1CausalExperiment: { idRegisterFromClientPrev: false, bridgeIdUseRealPrev: false, reconstructFailClosedOnRestoredZero: false } } })
  const ra = await a.gw.call('/v1/responses', reqOpts({ previous_response_id: UNKNOWN_ID, input: orphanToolInput() }))
  assert.equal(ra.status, 400)
  const ba = await ra.json()
  assert.equal(ba.error.code, 'continuation_reconstruct_failed', '实验全 OFF → 正式 typed 400')
  assert.equal(a.hits.length, 0, '止损先于上游 POST')

  // 显式开启实验 switch3（正式失败语义优先保留实验自身 code）→ 取证仪器能力不被吞掉
  const b = await setup(t, { server: { g1CausalExperiment: { reconstructFailClosedOnRestoredZero: true } } })
  const rb = await b.gw.call('/v1/responses', reqOpts({ previous_response_id: UNKNOWN_ID, input: orphanToolInput() }))
  assert.equal(rb.status, 400)
  const bb = await rb.json()
  assert.equal(bb.error.code, 'causal_reconstruct_fail_closed', '实验显式 opt-in → 保留实验 typed 400')
  assert.equal(bb.error.type, 'causal_experiment')
})
