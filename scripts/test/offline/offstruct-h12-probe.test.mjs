// 补丁⑧ H1/H2 区分探针 · 双向回归（纯离线，零付费请求 / 零真实上游）。
// 正向：正常 SSE 轮 A 点 applyevent 计数/type/官方分支正确、B 点 sinkattach/sinkrecv 完整，零泄漏。
// 反向：构造两种 mock——
//   H1（A 点无事件）：上游 SSE 只有 :comment 无 data → 无 applyevent（信封没进事件分发）。
//   H2（A 点有事件 + B 点未挂）：上游 JSON 分支 → 有 applyevent(kind=json) 且 sinkattach attached=0。
// 断言两探针签名可区分 H1/H2；id 层级按实际 50hex=other 归类，不写死 56hex。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { startGateway, startScriptedUpstream } from './harness.mjs'
import { offStructIdLevel } from '../../../src/index.js'

const HEX56 = 'a'.repeat(56)
const HEX50 = 'c'.repeat(50) // 真机新事实：prev/response_id 为 50hex，不得判定为 official56
const PROMPT_MARKER = 'TOPSECRET_H12_PROMPT_9d2f'
const OUTPUT_TEXT = 'H12_UNIQUE_OUTPUT_20261117'
const CLIENT_TOKEN = 'client-h12-token-7b3e'

function readLog (gw) {
  const names = readdirSync(gw.dir).filter((n) => n.endsWith('.log')).sort()
  return names.map((n) => readFileSync(join(gw.dir, n), 'utf8')).join('\n')
}
function offLines (gw) {
  return readLog(gw).split('\n').filter((l) => l.includes('mgp0.offstruct.'))
}
// 服务端 finish()/recordCapture() 在响应流结束后异步落日志；有界等待目标探针行，避免读到半截日志。
async function waitForLine (gw, needle, timeoutMs = 2000) {
  const start = Date.now()
  let lines = offLines(gw)
  while (!lines.some((l) => l.includes(needle)) && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 15))
    lines = offLines(gw)
  }
  return lines
}
function pick (lines, point) {
  return lines.filter((l) => l.includes('mgp0.offstruct.' + point + ' '))
}

async function setup (t, { diagnostic = true, sseMode = 'normal', prevId = null, model = 'gpt-6-astra' } = {}) {
  const upstream = await startScriptedUpstream(async (req, res) => {
    for await (const c of req) { /* drain request */ }
    if (sseMode === 'json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: 'resp_' + HEX50, object: 'response', status: 'completed',
        output: [{ type: 'function_call', call_id: 'call_' + 'd'.repeat(24), name: 'x' }],
      }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (sseMode === 'comments') {
      // 只有注释帧：没有 data 行 → 事件分发入口拿不到任何可解析事件（H1 mock）。
      res.write(': ping\n\n')
      res.write(': keep-alive\n\n')
      res.end()
      return
    }
    const emit = (type, response) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, response }) + '\n\n')
    const id = 'resp_' + HEX56
    emit('response.created', { id, object: 'response', status: 'in_progress', output: [] })
    emit('response.output_text.delta', { output_index: 0, delta: OUTPUT_TEXT })
    emit('response.completed', { id, object: 'response', status: 'completed', output: [] })
    res.end()
  })
  const gw = await startGateway({
    env: { MG_TEST_OFFICIAL_KEY: 'gw-official-test-key' },
    config: {
      defaults: { model: '', codexOfficialHosts: ['localhost'] },
      server: { diagnosticOfficialStructure: diagnostic },
      providers: { 'codex-official': { baseUrl: 'http://localhost:' + upstream.port, codexIdentity: 'official', apiKeyEnv: 'MG_TEST_OFFICIAL_KEY' } },
      models: {
        'gpt-6-astra': { provider: 'codex-official', api: 'responses' },
        'gpt-6-astra-native': { provider: 'codex-official', api: 'responses', codex: {} },
      },
    },
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })
  return gw
}

function reqOpts (bodyExtra = {}) {
  return {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + CLIENT_TOKEN,
      'thread-id': 'thread-h12-1a2b',
      'session-id': 'sess-h12-3c4d',
      'x-request-id': 'req-h12-5e6f',
      'content-type': 'application/json',
    },
    body: { model: 'gpt-6-astra', input: PROMPT_MARKER, stream: true, ...bodyExtra },
  }
}

function leaks (text) {
  const secrets = [PROMPT_MARKER, OUTPUT_TEXT, CLIENT_TOKEN, 'Bearer', 'gw-official-test-key',
    'thread-h12-1a2b', 'sess-h12-3c4d', 'req-h12-5e6f', 'resp_' + HEX56, 'resp_' + HEX50]
  return secrets.filter((s) => text.includes(s))
}

test('id 层级：50hex=other（不写死 56hex）；56hex=official56；32hex=go32', () => {
  assert.equal(offStructIdLevel('resp_' + HEX56), 'official56')
  assert.equal(offStructIdLevel('resp_' + 'b'.repeat(32)), 'go32')
  assert.equal(offStructIdLevel('resp_' + HEX50), 'other', '50hex 真机 id 必须落 other，不得误判 official56')
  assert.equal(offStructIdLevel('a'.repeat(24)), 'other', '24hex call_id 不得误判 go32')
})

test('正向 OFF：默认关闭时 A/B 点零日志、零行为变化', async (t) => {
  const gw = await setup(t, { diagnostic: false })
  const r = await gw.call('/v1/responses', reqOpts())
  assert.equal(r.status, 200)
  assert.match(await r.text(), new RegExp(OUTPUT_TEXT), '输出不受诊断开关影响')
  const lines = offLines(gw)
  assert.equal(pick(lines, 'applyevent').length, 0, 'OFF 不得有 A 点')
  assert.equal(pick(lines, 'sinkattach').length, 0, 'OFF 不得有 B 点 attach')
  assert.equal(pick(lines, 'sinkrecv').length, 0, 'OFF 不得有 B 点 recv')
})

test('正向 ON · SSE：A 点按事件计数/type/官方分支正确，B 点 attach/recv 完整，零泄漏', async (t) => {
  const gw = await setup(t, { diagnostic: true, prevId: 'resp_' + HEX50 })
  const r = await gw.call('/v1/responses', reqOpts({ previous_response_id: 'resp_' + HEX50 }))
  assert.equal(r.status, 200)
  assert.match(await r.text(), new RegExp(OUTPUT_TEXT), '观测不得改变输出')
  const lines = await waitForLine(gw, 'mgp0.offstruct.sinkrecv')
  const ae = pick(lines, 'applyevent').filter((l) => l.includes('kind=sse'))
  assert.equal(ae.length, 3, '正常 SSE 三轮事件 → A 点应有 3 行 applyevent')
  const aeText = ae.join('\n')
  for (const n of ['n=1', 'n=2', 'n=3']) assert.ok(aeText.includes(n), 'A 点计数须含 ' + n)
  for (const ty of ['response.created', 'response.output_text.delta', 'response.completed']) {
    assert.ok(aeText.includes('type=' + ty), 'A 点须记录事件 type=' + ty)
  }
  assert.ok(aeText.includes('branch=raw') && aeText.includes('official=1'), 'A 点须标注官方 raw 分支')
  assert.ok(aeText.includes('hasRespId=1') && aeText.includes('idLevel=official56'), 'A 点须记 id 布尔与层级')
  // B 点：raw 分支、continuation 存在 → attached=1；recv 须有事件规模。
  const sa = pick(lines, 'sinkattach').filter((l) => l.includes('branch=raw'))
  const sr = pick(lines, 'sinkrecv').filter((l) => l.includes('branch=raw'))
  assert.equal(sa.length, 1, 'B 点 attach 应有 1 行')
  assert.ok(sa[0].includes('attached=1') && sa[0].includes('continuation=1'), 'B 点 attach 须为官方续轮已挂')
  assert.equal(sr.length, 1, 'B 点 recv 应有 1 行')
  assert.ok(sr[0].includes('sawAny=1') && sr[0].includes('hasRespId=1'), 'B 点 recv 须确认 sink 实际收到事件')
  // 单轮 corr 一致 + 零泄漏。
  const all = lines.join('\n')
  const corrs = new Set(lines.map((l) => (l.match(/corr=([0-9a-f]+)/) || [])[1]).filter(Boolean))
  assert.equal(corrs.size, 1, '所有探针行须共享一个 corr')
  assert.deepEqual(leaks(all), [], '诊断日志不得含任何敏感值或明文 id')
})

test('反向 H1 mock：A 点无事件（SSE 只有注释帧）；签名 = 无 applyevent', async (t) => {
  const gw = await setup(t, { diagnostic: true, sseMode: 'comments', prevId: 'resp_' + HEX50 })
  const r = await gw.call('/v1/responses', reqOpts({ previous_response_id: 'resp_' + HEX50 }))
  assert.equal(r.status, 200)
  const lines = offLines(gw)
  assert.equal(pick(lines, 'applyevent').filter((l) => l.includes('kind=sse')).length, 0,
    'H1 签名：A 点无 applyevent —— 信封没进事件分发/applyEvent')
  assert.deepEqual(leaks(lines.join('\n')), [], 'H1 日志同样不得泄漏')
})

test('反向 H2 mock：A 点有事件 + B 点未挂（JSON 分支）；签名可区分 H1/H2', async (t) => {
  const gw = await setup(t, { diagnostic: true, sseMode: 'json', prevId: 'resp_' + HEX50 })
  const r = await gw.call('/v1/responses', reqOpts({ stream: false, previous_response_id: 'resp_' + HEX50 }))
  assert.equal(r.status, 200)
  const lines = offLines(gw)
  const ae = pick(lines, 'applyevent').filter((l) => l.includes('kind=json'))
  assert.equal(ae.length, 1, 'H2 签名：A 点有 applyevent（JSON 分支事件进了分发）')
  assert.ok(ae[0].includes('official=1') && ae[0].includes('hasRespId=1'), 'H2 A 点须标官方 + 含 response.id')
  assert.ok(ae[0].includes('hasFnCall=1') || ae[0].includes('hasFnCallOut=1'), 'H2 A 点须记 function_call 布尔标志')
  assert.ok(ae[0].includes('idLevel=other'), 'H2 A 点 50hex id 须归类 other（不写死 56hex）')
  const sa = pick(lines, 'sinkattach').filter((l) => l.includes('branch=json'))
  assert.equal(sa.length, 1, 'H2 须有 B 点 attach 行')
  assert.ok(sa[0].includes('attached=0'), 'H2 签名：B 点 attached=0 —— 事件进了但该分支没挂 captureSink')
  // 决定性：H1（无 applyevent）与 H2（有 applyevent + attached=0）两签名互斥，可区分。
  const h1Signature = pick(lines, 'applyevent').length === 0
  const h2Signature = pick(lines, 'applyevent').length > 0 && sa.some((l) => l.includes('attached=0'))
  assert.equal(h1Signature, false)
  assert.equal(h2Signature, true, '探针须能判定为 H2 而非 H1')
  assert.deepEqual(leaks(lines.join('\n')), [], 'H2 日志不得含 output/prompt/参数/明文 id')
})
