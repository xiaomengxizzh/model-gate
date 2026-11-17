// 补丁⑦ T05 官方结构诊断 · 双向回归（纯离线，零付费请求 / 零真实上游）。
// 正向：开关 OFF 零日志零行为；ON 时正常轮只出结构化元数据，绝不泄漏 prompt / Bearer / key / output。
// 反向：故障轮五观测点按同一 corr 串线，足以判定 H-A…H-D；id 层级分类确实区分 56hex 与 32hex。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { startGateway, startScriptedUpstream } from './harness.mjs'
import { offStructIdLevel } from '../../../src/index.js'

const HEX56 = 'a'.repeat(56) // 官方 Responses id（去 resp_ 前缀 56 hex）
const HEX32 = 'b'.repeat(32) // Go portable id（去 call_ 前缀 32 hex）
const PROMPT_MARKER = 'TOPSECRET_PROMPT_MARKER_7f3a91'
const OUTPUT_TEXT = 'OFFSTRUCT_UNIQUE_OUTPUT_TEXT_20261117'
const CLIENT_TOKEN = 'client-secret-token-9d2c'

function readLog (gw) {
  const names = readdirSync(gw.dir).filter((n) => n.endsWith('.log')).sort()
  return names.map((n) => readFileSync(join(gw.dir, n), 'utf8')).join('\n')
}
function offLines (gw) {
  return readLog(gw).split('\n').filter((l) => l.includes('mgp0.offstruct.'))
}

async function setup (t, { diagnostic, sseMode = 'normal', prevId = null } = {}) {
  const hits = []
  const upstream = await startScriptedUpstream(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    hits.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
    if (sseMode === 'json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: 'resp_' + HEX56, object: 'response', status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: OUTPUT_TEXT }] }],
      }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const emit = (type, response) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, response }) + '\n\n')
    const id = sseMode === 'failed' ? 'call_' + HEX32 : 'resp_' + HEX56
    const terminal = sseMode === 'failed' ? 'response.failed' : 'response.completed'
    emit('response.created', { id, object: 'response', status: 'in_progress', output: [] })
    emit('response.output_text.delta', { output_index: 0, delta: OUTPUT_TEXT })
    emit(terminal, { id, object: 'response', status: sseMode === 'failed' ? 'failed' : 'completed', output: [] })
    res.end()
  })
  const server = diagnostic === undefined ? {} : { diagnosticOfficialStructure: diagnostic }
  const gw = await startGateway({
    env: { MG_TEST_OFFICIAL_KEY: 'gw-official-test-key' },
    config: {
      defaults: { model: '', codexOfficialHosts: ['localhost'] },
      server,
      providers: { 'codex-official': { baseUrl: 'http://localhost:' + upstream.port, codexIdentity: 'official', apiKeyEnv: 'MG_TEST_OFFICIAL_KEY' } },
      models: {
        'gpt-6-astra': { provider: 'codex-official', api: 'responses' },
        'gpt-6-astra-native': { provider: 'codex-official', api: 'responses', codex: {} }, // 触发 streamCodexResponse 路径
      },
    },
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })
  return { gw, hits }
}

function reqOpts (bodyExtra = {}) {
  return {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + CLIENT_TOKEN,
      'thread-id': 'thread-secret-0f1e',
      'session-id': 'sess-secret-2d3c',
      'x-request-id': 'req-secret-4b5a',
      'content-type': 'application/json',
    },
    body: { model: 'gpt-6-astra', input: PROMPT_MARKER, stream: true, ...bodyExtra },
  }
}

test('P3 分类器：resp_/call_ 去前缀后 56hex=official56、32hex=go32，其它=other/opaque', () => {
  assert.equal(offStructIdLevel('resp_' + HEX56), 'official56')
  assert.equal(offStructIdLevel('call_' + HEX56), 'official56')
  assert.equal(offStructIdLevel('resp_' + HEX32), 'go32')
  assert.equal(offStructIdLevel('call_' + HEX32), 'go32')
  assert.equal(offStructIdLevel('a'.repeat(20)), 'other')
  assert.equal(offStructIdLevel('not-hex-id'), 'opaque')
  assert.equal(offStructIdLevel(null), 'opaque')
  assert.notEqual(offStructIdLevel('resp_' + HEX56), offStructIdLevel('call_' + HEX32), '56hex 与 32hex 必须落在不同层级')
})

test('正向 OFF：默认关闭时零诊断日志、零行为变化', async (t) => {
  const { gw, hits } = await setup(t) // 未配置开关 = 默认 OFF
  const r = await gw.call('/v1/responses', reqOpts())
  assert.equal(r.status, 200)
  const body = await r.text()
  assert.match(body, new RegExp(OUTPUT_TEXT), '响应正文不受诊断开关影响')
  assert.equal(hits.length, 1)
  assert.equal(offLines(gw).length, 0, 'OFF 时不得出现任何 mgp0.offstruct.* 行')
})

test('正向 ON · SSE：只出结构化元数据，prompt/Bearer/key/output/明文标识零泄漏', async (t) => {
  const { gw } = await setup(t, { diagnostic: true })
  const r = await gw.call('/v1/responses', reqOpts())
  assert.equal(r.status, 200)
  assert.match(await r.text(), new RegExp(OUTPUT_TEXT), '观测不得改变输出')
  const lines = offLines(gw)
  assert.ok(lines.length >= 3, 'SSE 轮应至少产出 entry/firstframe/terminal')
  const text = lines.join('\n')
  for (const label of ['mgp0.offstruct.entry', 'mgp0.offstruct.firstframe', 'mgp0.offstruct.terminal']) {
    assert.ok(text.includes(label), '应含 ' + label)
  }
  // 脱敏硬断言：诊断行内不含任何已知敏感值
  for (const secret of [PROMPT_MARKER, OUTPUT_TEXT, CLIENT_TOKEN, 'Bearer', 'gw-official-test-key',
    'thread-secret-0f1e', 'sess-secret-2d3c', 'req-secret-4b5a', 'resp_' + HEX56]) {
    assert.equal(text.includes(secret), false, '诊断日志不得含 ' + secret)
  }
  assert.ok(text.includes('corr='), '所有诊断行须带 corr')
  assert.ok(text.includes('idLevel=official56'), '56hex 首帧须归类 official56')
  assert.ok(text.includes('type=response.completed'), '须记录真实终态类型')
  // 同一轮 corr 必须一致（单轮串线）
  const corrs = new Set(lines.map((l) => (l.match(/corr=([0-9a-f]+)/) || [])[1]).filter(Boolean))
  assert.equal(corrs.size, 1, '同一轮所有诊断行 corr 必须相同')
})

test('正向 ON · JSON：记顶层键名/id 层级/status，output 正文零泄漏', async (t) => {
  const { gw } = await setup(t, { diagnostic: true, sseMode: 'json' })
  const r = await gw.call('/v1/responses', reqOpts({ stream: false }))
  assert.equal(r.status, 200)
  const j = await r.json()
  assert.equal(j.id, 'resp_' + HEX56, '观测不得改变 JSON 响应')
  const lines = offLines(gw)
  const text = lines.join('\n')
  assert.ok(text.includes('keys='), 'JSON 首帧须记顶层键名')
  assert.ok(text.includes('idLevel=official56'), 'JSON id 层级须可判定')
  assert.ok(text.includes('status=completed'), 'JSON 须记真实 status')
  assert.equal(text.includes(OUTPUT_TEXT), false, 'output 文本不得落日志')
  assert.equal(text.includes(PROMPT_MARKER), false, 'prompt 不得落日志')
})

test('正向 ON · Codex 原生投影流（streamCodexResponse）：探针原样透传且 P5 完整', async (t) => {
  const { gw } = await setup(t, { diagnostic: true })
  const r = await gw.call('/v1/responses', reqOpts({ model: 'gpt-6-astra-native' }))
  assert.equal(r.status, 200)
  assert.match(await r.text(), new RegExp(OUTPUT_TEXT), '原生投影流输出不被探针改变')
  const text = offLines(gw).join('\n')
  assert.ok(text.includes('mgp0.offstruct.firstframe'), '原生流须有首帧探针')
  assert.ok(text.includes('point=record_early'), 'P5 早登记')
  assert.ok(text.includes('point=record_final'), 'P5 终态定稿')
  assert.equal(text.includes(OUTPUT_TEXT), false, 'output 文本不得落日志')
  assert.equal(text.includes(CLIENT_TOKEN), false, '凭据不得落日志')
})

test('反向 · 故障轮：五观测点按 corr 串线可判 H-A/H-B/H-D，id 层级区分 56/32', async (t) => {
  // previous_response_id=56hex（未入 store → degraded），上游响应 id=32hex 且终态 failed。
  const { gw } = await setup(t, { diagnostic: true, sseMode: 'failed', prevId: 'resp_' + HEX56 })
  const r = await gw.call('/v1/responses', reqOpts({ previous_response_id: 'resp_' + HEX56 }))
  assert.equal(r.status, 200)
  const lines = offLines(gw)
  const text = lines.join('\n')
  for (const label of ['mgp0.offstruct.entry', 'mgp0.offstruct.firstframe', 'mgp0.offstruct.terminal', 'mgp0.offstruct.store']) {
    assert.ok(text.includes(label), '故障轮须含 ' + label + ' 以支撑 H-A…H-D 判定')
  }
  // H-A：目标/ID 形状串线——prev 56hex 与上游 32hex 并存，且 store 命中失败（degraded）。
  assert.ok(text.includes('point=degraded'), 'H-A 证据：续轮重建降级')
  assert.ok(text.includes('idLevel=official56'), 'H-A 证据：previous_response_id 层级')
  assert.ok(text.includes('idLevel=go32'), 'H-A 证据：上游响应 id 层级')
  assert.ok(text.includes('store='), 'H-A 证据：store count')
  // H-B/H-D：真实终态与默认 completed 可区分。
  assert.ok(text.includes('type=response.failed'), 'H-B/H-D 证据：真实 failed 终态')
  assert.ok(text.includes('statusReal='), 'H-B/H-D 证据：真实 status 是否存在')
  assert.ok(text.includes('terminal='), 'H-B/H-D 证据：终态是否已到达')
  // 所有观测点必须同一 corr，否则无法按轮判定假说。
  const corrs = new Set(lines.map((l) => (l.match(/corr=([0-9a-f]+)/) || [])[1]).filter(Boolean))
  assert.equal(corrs.size, 1, '故障轮所有观测点必须共享一个 corr')
  // 脱敏：故障轮同样不得泄漏敏感值。
  for (const secret of [PROMPT_MARKER, OUTPUT_TEXT, CLIENT_TOKEN, 'Bearer', 'resp_' + HEX56, 'call_' + HEX32]) {
    assert.equal(text.includes(secret), false, '故障轮日志不得含 ' + secret)
  }
})
