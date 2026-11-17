// G2 第三层（方案 B）离线回归：id 登记/重建一致性（纯离线，零付费请求 / 零真实上游 / 零真实凭据）。
//
// 断链帧（dc6e26e，G1 取证）：deepseek 父派子走第三方 native Responses 路径，入口删
// previous_response_id（index.js:3499-3502）；靠 continuation store 重建上一轮真实 function_call，
// 但 WS 桥合成 id（responses-ws.js:429/453 resp_mgws_）与 Codex 续轮帧真实 id（50hex/24hex）
// 不一致 → reconstruct 落空 / continuation_state_missing / restored=0 → delta 只剩
// function_call_output → projectOrderedHistory 闸门（responses.js:599 → codex/interop.js:1042-1081）
// 以 tool_call_pairing typed 400 拒绝（index.js:3518），repairThirdPartyToolCallIds（index.js:810-908）
// 够不到。方案 A（改闸门顺序）明确不采用；方案 B = 让"续轮引用 id"与"登记键"为同一值。
//
// 本套件钉死：
//   ① 别名原语（register/resolve）双向、有界、可回滚；
//   ② 50hex / 24hex / resp_mgws_ 三种 id 形态下，登记键与续轮引用 id 一致 → reconstruct 命中且
//      restored.input 含上一轮真实 function_call（不伪造、不删历史、不丢孤儿 output）；
//   ③ 未命中仍 fail-closed（reason 不变、无半截历史）；
//   ④ 显式 continuationIdAlias=false 完全回落 dc6e26e（别名不写入、不解析）。
//   ⑤ 端到端：第三方 native 父代理 spawn→wait，用合成 id 续轮，上游拿到配对的 call+output，不再 400。
//
// 脱敏：只注入标记串；响应 id 层级用 offStructIdLevel 断言，不写死 56hex；日志零泄漏正文/凭据。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  resetContinuationStore, recordContinuation, reconstructContinuation,
  continuationStoreSize, registerContinuationAlias, resolveContinuationId,
  configureContinuationIdAlias,
} from '../../../src/responses-continuation.js'
import { startGateway, startScriptedUpstream } from './harness.mjs'
import { V2_TARGET_PUBLIC_ID, V2_TARGET_UPSTREAM_MODEL } from '../../../src/providers/opencode-go.js'

const HEX50 = 'a'.repeat(50)                 // 官方实测响应 id 形态
const HEX24 = 'b'.repeat(24)                 // 第三方 go 常见 24hex 形态
const MGWS = 'resp_mgws_' + 'e'.repeat(24)   // WS 桥合成 id 形态
const REAL_50 = 'resp_' + HEX50
const REAL_24 = HEX24
const CALL_ID = 'call_' + 'd'.repeat(24)

const fc = (id, callId) => ({ type: 'function_call', id, call_id: callId, name: 'spawn_agent', arguments: '{}', status: 'completed' })
const fnOut = (callId, text) => ({ type: 'function_call_output', call_id: callId, output: text })
const msg = (id, role, text) => ({ type: 'message', id, role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] })

// ── ① 别名原语 ─────────────────────────────────────────────────────────────────

test('① registerContinuationAlias/resolveContinuationId：双向、自映射拒绝、可重置', () => {
  resetContinuationStore()
  configureContinuationIdAlias(true)
  assert.equal(resolveContinuationId(MGWS), MGWS, '未登记时原样返回')
  assert.equal(registerContinuationAlias(MGWS, REAL_50), true)
  assert.equal(resolveContinuationId(MGWS), REAL_50, '合成 id → 真实 50hex')
  assert.equal(resolveContinuationId(REAL_50), MGWS, '双向解析')
  assert.equal(registerContinuationAlias(REAL_50, REAL_50), false, '自映射不建别名')
  assert.equal(registerContinuationAlias('', REAL_50), false, '空 id 不建别名')
  assert.ok(continuationStoreSize().aliases >= 2)
  resetContinuationStore()
  assert.equal(resolveContinuationId(MGWS), MGWS, 'reset 清空别名')
  assert.equal(continuationStoreSize().aliases, 0)
})

test('① 别名有界：超过上限淘汰最旧，进程内不无限增长', () => {
  resetContinuationStore()
  configureContinuationIdAlias(true)
  for (let i = 0; i < 600; i++) registerContinuationAlias('a' + i, 'b' + i)
  assert.ok(continuationStoreSize().aliases <= 512, '别名数受 DEFAULT_MAX_ALIASES 约束')
  resetContinuationStore()
})

// ── ② 三形态登记/重建一致性 + restored 含真实 function_call ───────────────────

// clientRef = Codex 续轮帧引用的 id；registerKey = captureSink 捕获并登记的键。
// 方案 B：recordContinuation 时把 clientRef 作为 aliases 绑定到 registerKey，
// reconstruct(clientRef) 未直接命中时解析到 registerKey → 命中。
for (const [label, registerKey, clientRef] of [
  ['50hex（官方实测）', REAL_50, MGWS],
  ['24hex（第三方 go）', REAL_24, MGWS],
  ['resp_mgws_ 合成', MGWS, REAL_50],
]) {
  test(`② ${label}：登记键与续轮引用 id 一致 → reconstruct 命中且 restored 含 function_call`, () => {
    resetContinuationStore()
    configureContinuationIdAlias(true)
    const prior = [msg('u1', 'user', 'spawn a child'), fc('fc1', CALL_ID)]
    recordContinuation({
      responseId: registerKey,
      prevId: null,
      input: prior,
      output: [],
      aliases: [clientRef],
      status: 'completed',
    })
    // 上一轮的真实 function_call 已在 input（captureSink 终态快照机制保留的真实项）
    const rec = reconstructContinuation(clientRef, [fnOut(CALL_ID, 'CHILD_DONE')])
    assert.equal(rec.ok, true, '引用 id 解析到登记键 → 命中')
    const calls = rec.input.filter((i) => i.type === 'function_call' && i.call_id === CALL_ID)
    assert.equal(calls.length, 1, 'restored 含上一轮真实 function_call，不伪造')
    assert.equal(calls[0].name, 'spawn_agent', 'function_call 内容未被改写')
    const callAt = rec.input.findIndex((i) => i.type === 'function_call' && i.call_id === CALL_ID)
    const outAt = rec.input.findIndex((i) => i.type === 'function_call_output' && i.call_id === CALL_ID)
    assert.ok(callAt >= 0 && callAt < outAt, '真实 call 排在 output 前 → 配对终检可通过')
    assert.equal(rec.input.find((i) => i.type === 'function_call_output').output, 'CHILD_DONE', '孤儿 output 内容未丢')
    assert.ok(rec.input.some((i) => i.id === 'u1'), '历史消息未删')
    resetContinuationStore()
  })
}

test('② 直接命中优先：real→real 正常链不被别名干扰（防误解析到上一轮）', () => {
  resetContinuationStore()
  configureContinuationIdAlias(true)
  recordContinuation({ responseId: 'r1', input: [msg('m1', 'user', 't1')], output: [msg('m2', 'assistant', 'o1')], aliases: [MGWS] })
  const rec2 = reconstructContinuation('r1', [msg('m3', 'user', 't2')])
  recordContinuation({ responseId: 'r2', prevId: 'r1', input: rec2.input, output: [msg('m4', 'assistant', 'o2')], aliases: [MGWS] })
  const rec3 = reconstructContinuation('r2', [msg('m5', 'user', 't3')])
  assert.deepEqual(rec3.input.map((i) => i.id), ['m1', 'm2', 'm3', 'm4', 'm5'], '链式重建不受共享别名污染')
  resetContinuationStore()
})

// ── ③ fail-closed 不变 ─────────────────────────────────────────────────────────

test('③ 未命中仍 fail-closed：reason 不变、无半截历史', () => {
  resetContinuationStore()
  configureContinuationIdAlias(true)
  assert.deepEqual(reconstructContinuation('resp_never_seen', [fnOut(CALL_ID, 'x')]), { ok: false, reason: 'continuation_state_missing' })
  // 仅绑定别名但从未登记条目 → 解析后仍无条目 → 不伪造历史
  registerContinuationAlias(MGWS, REAL_50)
  assert.deepEqual(reconstructContinuation(MGWS, []), { ok: false, reason: 'continuation_state_missing' })
  resetContinuationStore()
})

// ── ④ 回滚开关 ─────────────────────────────────────────────────────────────────

test('④ configureContinuationIdAlias(false)：别名不写入、不解析，回落 dc6e26e 直接查键', () => {
  resetContinuationStore()
  configureContinuationIdAlias(false)
  assert.equal(registerContinuationAlias(MGWS, REAL_50), false, '关闭时不写别名')
  assert.equal(resolveContinuationId(MGWS), MGWS, '关闭时原样返回')
  recordContinuation({ responseId: REAL_50, input: [fc('fc1', CALL_ID)], output: [], aliases: [MGWS] })
  assert.equal(continuationStoreSize().aliases, 0, '关闭时记录也不建立别名')
  assert.deepEqual(reconstructContinuation(MGWS, []), { ok: false, reason: 'continuation_state_missing' })
  configureContinuationIdAlias(true)
  resetContinuationStore()
})

// ── ⑤ 端到端：第三方 native 父代理 spawn→wait，合成 id 续轮不再 400 ──────────

function goConfig(goBase) {
  return {
    defaults: { retry: { maxAttempts: 1 }, timeout: { firstByteMs: 3000, idleMs: 3000, loopMs: 3000 }, proxyMode: 'direct' },
    providers: { opencodego: { baseUrl: goBase + '/inference/go/openai/v1', api: 'responses', apiKeyEnv: 'G2_SYNTH_KEY' } },
    models: {
      [V2_TARGET_PUBLIC_ID]: {
        provider: 'opencodego', api: 'responses', providerModels: { opencodego: V2_TARGET_UPSTREAM_MODEL },
        codex: {
          plaintextTools: true,
          history: { agentMessage: 'project', reasoning: 'preserve' },
          capabilities: { shellType: 'unified_exec', applyPatchToolType: 'freeform' },
        },
      },
    },
  }
}

test('⑤ 端到端：deepseek 父 spawn→wait 用 WS 合成 id 续轮，上游收到配对 call+output，无 tool_call_pairing 400', { timeout: 30000 }, async (t) => {
  const bodies = []
  let n = 0
  const up = await startScriptedUpstream(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    n++
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (n === 1) {
      // 轮1：上游真实 id 为 50hex，output 含真实 function_call(spawn_agent)。
      const realCall = { type: 'function_call', id: 'fc_parent', call_id: CALL_ID, name: 'spawn_agent', arguments: '{}', status: 'completed' }
      const sse = (o) => 'data: ' + JSON.stringify(o) + '\n\n'
      res.end(
        sse({ type: 'response.created', response: { id: REAL_50, status: 'in_progress', output: [] } }) +
        sse({ type: 'response.output_item.done', item: realCall }) +
        sse({ type: 'response.completed', response: { id: REAL_50, status: 'completed', output: [realCall] } })
      )
    } else {
      const sse = (o) => 'data: ' + JSON.stringify(o) + '\n\n'
      res.end(sse({ type: 'response.created', response: { id: 'r' + n, status: 'in_progress', output: [] } }) +
        sse({ type: 'response.completed', response: { id: 'r' + n, status: 'completed', output: [msg('a' + n, 'assistant', 'ok')] } }))
    }
  })
  const gw = await startGateway({ config: goConfig(up.base), env: { G2_SYNTH_KEY: 'sk-synthetic-offline-not-a-real-key' } })
  t.after(async () => { await gw.stop(); await up.stop() })

  // 轮1：父代理建立续轮状态；Codex 携带的合成 id（MGWS）成为本轮的 client 引用 id。
  const r1 = await gw.post('/v1/responses', {
    model: V2_TARGET_PUBLIC_ID,
    input: [msg('u1', 'user', 'spawn child')],
    stream: true,
    previous_response_id: MGWS,
  }, { 'content-type': 'application/json' })
  assert.equal(r1.status, 200)
  await r1.text()

  // 轮2：Codex 续轮帧仍用合成 id（MGWS）引用上一轮，delta 只有 function_call_output。
  // 修复前：reconstruct(MGWS) 落空 → 孤儿 output → tool_call_pairing typed 400。
  const r2 = await gw.post('/v1/responses', {
    model: V2_TARGET_PUBLIC_ID,
    input: [fnOut(CALL_ID, 'CHILD_DONE')],
    stream: true,
    previous_response_id: MGWS,
  }, { 'content-type': 'application/json' })
  assert.equal(r2.status, 200, '合成 id 续轮不得被配对终检以 typed 400 拒绝')
  await r2.text()

  assert.equal(bodies.length, 2)
  const input = bodies[1].input
  const callAt = input.findIndex((i) => i.type === 'function_call' && i.call_id === CALL_ID)
  const outAt = input.findIndex((i) => i.type === 'function_call_output' && i.call_id === CALL_ID)
  assert.ok(callAt >= 0 && outAt >= 0 && callAt < outAt,
    '上游收到配对的真实 function_call + function_call_output（闸门配对终检可通过）')
  assert.equal(input.find((i) => i.type === 'function_call_output').output, 'CHILD_DONE', '对话内容未被改写')
  assert.ok(input.some((i) => i.id === 'u1'), '历史消息未丢')
})
