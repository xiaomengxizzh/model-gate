// G2 治本：工具结果续轮连续性恢复（纯离线，零付费请求 / 零真实上游）。
// 根因闭环（G2 诊断强证据）：上游订阅返回 200 SSE 正文但 content-type 为空 →
// 仅按 ct 判分支误走 JSON → j.id 解析失败、captureSink 从不挂载 → 真实 50hex id
// 从未登记 → 下一轮 previous_response_id reconstruct 未命中 → 孤儿 function_call_output → 400。
// 三项治本（路线 A）：①ct 嗅探让 SSE 正文进 SSE 分支并纠正写回 contentType；
// ②JSON 分支也经 captureSink 登记；③登记键 = 回写给 codex 的真实 id（非合成）。
// 开关 server.continuationRootFix 默认 true（v!==false），false 完全回落旧行为。
// 脱敏：只注入标记串并断言日志零命中；50hex → other，不写死 56hex。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { startGateway, startScriptedUpstream } from './harness.mjs'
import { continuationRootFixOn, offStructIdLevel } from '../../../src/index.js'

const HEX50 = 'c'.repeat(50) // 真机续轮 id：50hex，必须归 other，不写死 56hex
const REAL_ID = 'resp_' + HEX50
const OUTPUT_TEXT = 'ROOTFIX_UNIQUE_OUTPUT_20261117'
const ASSISTANT_ITEM = { type: 'message', role: 'assistant', id: 'msg_rootfix_1', content: [{ type: 'output_text', text: OUTPUT_TEXT }] }
const PROMPT_MARKER = 'ROOTFIX_TOPSAFE_PROMPT_7f3a91'
const CLIENT_TOKEN = 'client-rootfix-token-9d2c'
const UP_KEY = 'gw-rootfix-test-key'
const THREAD = 'thread-rootfix-1a2b'
const SESSION = 'sess-rootfix-3c4d'
const REQID = 'req-rootfix-5e6f'
const CALL_ID = 'call_' + 'd'.repeat(24)

function readLog (gw) {
  const names = readdirSync(gw.dir).filter((n) => n.endsWith('.log')).sort()
  return names.map((n) => readFileSync(join(gw.dir, n), 'utf8')).join('\n')
}
function leaks (text) {
  // 注意：响应 id 本身（REAL_ID）由既有运营日志 'responses continuation recorded' 记录，
  // 属预先存在的非诊断日志，不在本次脱敏断言范围；敏感串是 prompt/凭据/线程标识。
  const secrets = [PROMPT_MARKER, OUTPUT_TEXT, CLIENT_TOKEN, 'Bearer', UP_KEY, THREAD, SESSION, REQID]
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
    body: { model: 'gpt-6-astra', input: PROMPT_MARKER, stream: true, ...bodyExtra },
  }
}
function orphanToolInput () {
  return [
    { type: 'function_call_output', call_id: CALL_ID, output: 'CHILD_DONE' },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续' }] },
  ]
}
function sseBody (id = REAL_ID) {
  const ev = (type, response) =>
    'event: ' + type + '\ndata: ' + JSON.stringify(Object.assign({ type }, response)) + '\n\n'
  const itemEvent = 'event: response.output_item.done\ndata: ' + JSON.stringify({ type: 'response.output_item.done', item: ASSISTANT_ITEM, output_index: 0 }) + '\n\n'
  return ev('response.created', { response: { id, object: 'response', status: 'in_progress', output: [] } }) +
    itemEvent +
    ev('response.completed', { response: { id, object: 'response', status: 'completed', output: [ASSISTANT_ITEM], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })
}
function jsonBody (id = REAL_ID) {
  return JSON.stringify({ id, object: 'response', status: 'completed', output: [ASSISTANT_ITEM], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } })
}

async function setup (t, { server, mode = 'sse-empty-ct' } = {}) {
  const hits = []
  const upstream = await startScriptedUpstream(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    hits.push(Buffer.concat(chunks).toString('utf8'))
    if (mode === 'json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(jsonBody())
      return
    }
    // G2 精确复现：SSE 正文 + 空 content-type。
    res.writeHead(200, { 'content-type': '' })
    res.end(sseBody())
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

test('开关默认语义：仅显式布尔 false 关闭；undefined/null/0/\'false\' 一律默认 ON', () => {
  assert.equal(continuationRootFixOn({ cfg: {} }), true)
  assert.equal(continuationRootFixOn({ cfg: { server: {} } }), true)
  assert.equal(continuationRootFixOn({ cfg: { server: { continuationRootFix: true } } }), true)
  for (const v of [1, 0, 'false', 'true', null, undefined, {}, []]) {
    assert.equal(continuationRootFixOn({ cfg: { server: { continuationRootFix: v } } }), true, '宽松读取 → ON (' + String(v) + ')')
  }
  assert.equal(continuationRootFixOn({ cfg: { server: { continuationRootFix: false } } }), false, '显式 false → 回滚旧行为')
  assert.equal(offStructIdLevel(REAL_ID), 'other', '50hex 必须归 other，不写死 56hex')
})

test('治本①：ct 空 + SSE 正文 → 走 SSE 分支并登记真实 id（非合成），第二轮 reconstruct 命中', async (t) => {
  const { gw, hits } = await setup(t)
  const r1 = await gw.call('/v1/responses', reqOpts())
  assert.equal(r1.status, 200)
  assert.match(r1.headers.get('content-type') || '', /text\/event-stream/, '写回下游的 ct 被纠正为 SSE')
  const text1 = await r1.text()
  assert.match(text1, /data: /, '响应正文为 SSE 帧')
  assert.ok(text1.includes(REAL_ID), '真实 id 出现在回写给 codex 的 SSE 正文')
  const log1 = readLog(gw)
  assert.ok(log1.includes('kind=sse'), '证明按正文前缀进入了 SSE 分支（非 JSON 分支）')
  assert.ok(log1.includes('responses continuation recorded'), 'captureSink 登记了真实 id')
  assert.equal(log1.includes('capture empty'), false)

  const r2 = await gw.call('/v1/responses', reqOpts({ previous_response_id: REAL_ID, input: orphanToolInput() }))
  assert.equal(r2.status, 200, '不应被止损误伤')
  await r2.text()
  assert.equal(hits.length, 2)
  const log = readLog(gw)
  assert.ok(log.includes('responses continuation reconstructed'), '重建命中')
  assert.equal(log.includes('responses continuation degraded'), false, '无降级')
  assert.equal(log.includes('continuation reconstruct fail-closed'), false, '无止损 typed 400')
  const hit2 = JSON.parse(hits[1])
  assert.equal(Object.prototype.hasOwnProperty.call(hit2, 'previous_response_id'), false, '转发上游前剔除 prev')
  assert.ok(hit2.input.some((i) => i.type === 'message' && (i.content || []).some((c) => c.text === OUTPUT_TEXT)), '上一轮真实 output 被重建保留')
  assert.equal(leaks(log).length, 0, '日志零泄漏敏感串')
})

test('治本②：JSON 分支也经 captureSink 登记（attached=1 / sinkrecv hasRespId=1）', async (t) => {
  const { gw, hits } = await setup(t, { mode: 'json' })
  const r1 = await gw.call('/v1/responses', reqOpts())
  assert.equal(r1.status, 200)
  const body = await r1.json()
  assert.equal(body.id, REAL_ID)
  const log1 = readLog(gw)
  assert.match(log1, /mgp0\.offstruct\.sinkattach[^\n]*branch=json[^\n]*attached=1/, 'JSON 分支挂上了 captureSink')
  assert.match(log1, /mgp0\.offstruct\.sinkrecv[^\n]*branch=json[^\n]*hasRespId=1/, 'sink 捕获到真实 id')

  const r2 = await gw.call('/v1/responses', reqOpts({ previous_response_id: REAL_ID, input: orphanToolInput() }))
  assert.equal(r2.status, 200)
  await r2.text()
  assert.equal(hits.length, 2)
  assert.ok(readLog(gw).includes('responses continuation reconstructed'), '由 sink 登记的 id 能被下一轮重建命中')
})

test('治本③：写出的真实 id == store 键；合成 resp_mgws_ 不得出现在真实轮', async (t) => {
  const { gw } = await setup(t)
  const r1 = await gw.call('/v1/responses', reqOpts())
  assert.equal(r1.status, 200)
  const text1 = await r1.text()
  // 从写回 codex 的 response.created 帧取真实 id（与 WS 桥 onEvent 同一字段）。
  const created = text1.split('\n').find((l) => l.startsWith('data: '))
  const emittedId = JSON.parse(created.slice(6)).response.id
  assert.equal(emittedId, REAL_ID)
  assert.equal(emittedId.startsWith('resp_mgws_'), false, '真实轮绝不写合成 id')
  // 以该写出 id 续轮必须命中——证明登记键与写出的 id 完全一致。
  const r2 = await gw.call('/v1/responses', reqOpts({ previous_response_id: emittedId, input: orphanToolInput() }))
  assert.equal(r2.status, 200)
  await r2.text()
  const log = readLog(gw)
  assert.ok(log.includes('responses continuation reconstructed'))
  assert.equal(log.includes('continuation reconstruct fail-closed'), false)
  assert.equal(leaks(log).length, 0)
})

test('回滚开关 false：回落旧行为（JSON 分支不挂 sink / 不纠正 ct / 续轮 miss 降级）', async (t) => {
  const { gw } = await setup(t, { server: { continuationRootFix: false, p0bFailClosedOnReconstructMiss: false } })
  const r1 = await gw.call('/v1/responses', reqOpts())
  assert.equal(r1.status, 200)
  assert.match(r1.headers.get('content-type') || '', /application\/json/, '旧行为：ct 不纠正')
  const text1 = await r1.text()
  assert.ok(text1.includes('data: '), 'SSE 正文被当 JSON 原样写回（旧缺陷）')
  const log1 = readLog(gw)
  assert.ok(log1.includes('kind=json'), '旧行为：仍走 JSON 分支')
  assert.match(log1, /mgp0\.offstruct\.sinkattach[^\n]*branch=json[^\n]*attached=0/, '旧行为：JSON 分支不挂 sink')

  const r2 = await gw.call('/v1/responses', reqOpts({ previous_response_id: REAL_ID, input: orphanToolInput() }))
  assert.equal(r2.status, 200, '旧行为：未命中降级转发，不打断会话')
  await r2.text()
  assert.ok(readLog(gw).includes('responses continuation degraded'), '旧行为：degraded 仍存在')
})

test('反向护栏：普通对话（无 previous_response_id）逐字节不变、不触发新逻辑', async (t) => {
  const { gw, hits } = await setup(t, { mode: 'json' })
  const req = reqOpts({ input: 'plain hello' })
  const r = await gw.call('/v1/responses', req)
  assert.equal(r.status, 200)
  assert.ok((await r.text()).includes(OUTPUT_TEXT), '输出正文不变')
  assert.match(r.headers.get('content-type') || '', /application\/json/)
  assert.equal(hits.length, 1)
  assert.deepEqual(JSON.parse(hits[0]), req.body, '上游收到的 body 与发送一致（嗅探透传不改写）')
  const log = readLog(gw)
  for (const marker of ['responses continuation reconstructed', 'responses continuation degraded', 'continuation reconstruct fail-closed']) {
    assert.equal(log.includes(marker), false, '普通对话不得触发续轮逻辑：' + marker)
  }
  assert.equal(leaks(log).length, 0)
})

test('反向护栏：止损 fail-closed 仍生效（治本遗漏时 typed 400 兜底，MG-R008 不静默降级）', async (t) => {
  const { gw, hits } = await setup(t, { mode: 'json' })
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

test('反向护栏：治本代码只落在官方路径，第三方续轮剔除逻辑零改动', () => {
  const src = readFileSync(join(process.cwd(), 'src/index.js'), 'utf8')
  const offStart = src.indexOf('async function proxyOfficialResponses')
  const nativeStart = src.indexOf('async function proxyNativeResponses')
  assert.ok(offStart > 0 && nativeStart > offStart)
  const officialBlock = src.slice(offStart, nativeStart)
  const nativeBlock = src.slice(nativeStart, nativeStart + 60000)
  assert.ok(officialBlock.includes('continuationRootFixOn'), '治本开关落在官方路径')
  assert.ok(officialBlock.includes('peekFirstChunk'), '正文嗅探落在官方路径')
  assert.equal(nativeBlock.includes('continuationRootFixOn'), false, '第三方路径不引入治本开关')
  assert.equal(nativeBlock.includes('peekFirstChunk'), false, '第三方路径不引入嗅探')
  assert.ok(nativeBlock.includes('third_party_tool_call_id_missing'), '第三方 tool-call id 剔除逻辑仍在')
})
