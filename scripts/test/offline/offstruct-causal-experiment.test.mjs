// 补丁⑨ P0-B 根因链受控 A/B 因果实验 · 双向回归（纯离线，零付费请求 / 零真实上游）。
// 这是取证仪器，不是修复：验证三个子开关默认全 OFF 零行为变更、各自单独 ON 路径可观测、
// 组合可叠加、脱敏零泄漏、50hex→other 层级。所有断言只认结构化元数据与 HTTP 状态。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { startGateway, startScriptedUpstream } from './harness.mjs'
import {
  offStructIdLevel,
  CAUSAL_SWITCH_KEYS,
  causalSnapshot,
  causalAnyOn,
  causalAliasLink,
  causalAliasResolve,
  causalAliasOnRegister,
  resetCausalExperiment,
} from '../../../src/index.js'

const HEX50 = 'c'.repeat(50) // 真机续轮/响应 id：50hex，必须归 other
const HEX56 = 'a'.repeat(56) // 官方 56hex 参照
const REAL_ID = 'resp_' + HEX50
const SYNTH_ID = 'resp_mgws_' + 'e'.repeat(24) // WS 桥合成 id
const UNKNOWN_ID = 'resp_' + 'f'.repeat(50)
const PROMPT_MARKER = 'CAUSAL_TOPSECRET_PROMPT_9d2f'
const OUTPUT_TEXT = 'CAUSAL_UNIQUE_OUTPUT_20261117'
const CLIENT_TOKEN = 'client-causal-token-7b3e'
const UP_KEY = 'gw-causal-test-key'
const THREAD = 'thread-causal-1a2b'
const SESSION = 'sess-causal-3c4d'
const REQID = 'req-causal-5e6f'

function readLog (gw) {
  const names = readdirSync(gw.dir).filter((n) => n.endsWith('.log')).sort()
  return names.map((n) => readFileSync(join(gw.dir, n), 'utf8')).join('\n')
}
function causalLines (gw) {
  return readLog(gw).split('\n').filter((l) => l.includes('mgp0.causal.'))
}
function leaks (text) {
  const secrets = [PROMPT_MARKER, OUTPUT_TEXT, CLIENT_TOKEN, 'Bearer', UP_KEY, THREAD, SESSION, REQID, REAL_ID, SYNTH_ID, UNKNOWN_ID]
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
function normalResponse () {
  return {
    id: REAL_ID, object: 'response', status: 'completed',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: OUTPUT_TEXT }] }],
  }
}
// 无 id 响应：模拟 root cause ① —— 续轮响应体空/无 response id。
function noIdResponse () {
  return { object: 'response', status: 'completed', output: [] }
}

async function setup (t, { experiment, responder } = {}) {
  let n = 0
  const hits = []
  const upstream = await startScriptedUpstream(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    hits.push(Buffer.concat(chunks).toString('utf8'))
    const out = responder ? responder(n++) : normalResponse()
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(out))
  })
  // 取证仪器须显式关闭正式止损（默认 ON），否则 reconstruct 未命中会先被正式 typed 400 拦截，
  // 掩盖三个实验子开关的可观测行为；这样实验回归与正式止损互不干扰。
  const server = Object.assign({ p0bFailClosedOnReconstructMiss: false }, experiment ? { g1CausalExperiment: experiment } : {})
  const gw = await startGateway({
    env: { MG_TEST_OFFICIAL_KEY: UP_KEY },
    config: {
      defaults: { model: '', codexOfficialHosts: ['localhost'] },
      server,
      providers: { 'codex-official': { baseUrl: 'http://localhost:' + upstream.port, codexIdentity: 'official', apiKeyEnv: 'MG_TEST_OFFICIAL_KEY' } },
      models: { 'gpt-6-astra': { provider: 'codex-official', api: 'responses' } },
    },
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })
  return { gw, hits }
}

test('配置门与 id 层级：三开关严格 ===true；50hex=other 不写死 56hex；组合可叠加', () => {
  assert.equal(offStructIdLevel('resp_' + HEX50), 'other', '真机 50hex 必须归 other')
  assert.equal(offStructIdLevel('resp_' + HEX56), 'official56')
  assert.equal(offStructIdLevel('call_' + 'b'.repeat(32)), 'go32')
  assert.deepEqual([...CAUSAL_SWITCH_KEYS], ['idRegisterFromClientPrev', 'bridgeIdUseRealPrev', 'reconstructFailClosedOnRestoredZero'])

  const off = causalSnapshot({ cfg: {} }, null, null)
  assert.deepEqual(
    [off.idRegisterFromClientPrev, off.bridgeIdUseRealPrev, off.reconstructFailClosedOnRestoredZero],
    [false, false, false], '缺位配置 → 全 OFF'
  )
  assert.equal(causalAnyOn(off), false)
  const partial = causalSnapshot(
    { cfg: { server: { g1CausalExperiment: { idRegisterFromClientPrev: 1, bridgeIdUseRealPrev: 'true', reconstructFailClosedOnRestoredZero: false } } } },
    null, null
  )
  assert.deepEqual(
    [partial.idRegisterFromClientPrev, partial.bridgeIdUseRealPrev, partial.reconstructFailClosedOnRestoredZero],
    [false, false, false], '非严格 true（1 / "true" / false）一律 OFF'
  )
  const all = causalSnapshot(
    { cfg: { server: { g1CausalExperiment: { idRegisterFromClientPrev: true, bridgeIdUseRealPrev: true, reconstructFailClosedOnRestoredZero: true } } } },
    { headers: { 'thread-id': THREAD, 'x-request-id': REQID } }, null
  )
  assert.equal(causalAnyOn(all), true)
  assert.deepEqual(
    [all.idRegisterFromClientPrev, all.bridgeIdUseRealPrev, all.reconstructFailClosedOnRestoredZero],
    [true, true, true], '三开关组合可叠加'
  )
  assert.match(all.corr, /^[0-9a-f]+$/, 'corr 必须是 hashId，不含明文')
})

test('bridgeIdUseRealPrev 原语：双向别名、缺配置不生效（仅实验态）', () => {
  resetCausalExperiment()
  assert.equal(causalAliasResolve(SYNTH_ID), SYNTH_ID, '未登记时原样返回')
  assert.equal(causalAliasLink(SYNTH_ID, REAL_ID), true)
  assert.equal(causalAliasResolve(SYNTH_ID), REAL_ID, '合成 → 真实 50hex')
  assert.equal(causalAliasResolve(REAL_ID), SYNTH_ID, '双向解析')
  assert.equal(causalAliasLink(SYNTH_ID, SYNTH_ID), false, '自映射不建别名')
  // 无 causal 配置 / 无真实 id → 不建别名（零默认行为变更）
  assert.equal(causalAliasOnRegister(null, REAL_ID, null), false)
  assert.equal(causalAliasOnRegister({ causal: null }, REAL_ID, null), false)
  assert.equal(causalAliasOnRegister({ causal: { bridgeIdUseRealPrev: false }, rawPrevId: SYNTH_ID }, REAL_ID, null), false)
  resetCausalExperiment()
})

test('全部 OFF：两轮均无实验日志，reconstruct 未命中仍走基线降级，零行为变更', async (t) => {
  const { gw, hits } = await setup(t, { responder: () => noIdResponse() })
  const r1 = await gw.call('/v1/responses', reqOpts({ previous_response_id: REAL_ID }))
  const r2 = await gw.call('/v1/responses', reqOpts({ previous_response_id: REAL_ID }))
  assert.equal(r1.status, 200)
  assert.equal(r2.status, 200)
  assert.equal(hits.length, 2, '两轮均真实到达上游')
  assert.equal(causalLines(gw).length, 0, 'OFF 时零 mgp0.causal.* 日志')
  const log = readLog(gw)
  assert.ok(log.includes('responses continuation degraded'), '基线：未命中仍降级转发（未被实验改写）')
  assert.equal(log.includes('responses continuation reconstructed'), false, '基线：未命中不得重建成功')
  // 脱敏约束只针对补丁⑨新增的实验日志；基线既有日志不在本补丁范围内。
  assert.equal(leaks(causalLines(gw).join('\n')).length, 0, '实验日志零泄漏（本轮为空）')
})

test('switch 1 idRegisterFromClientPrev：无 j.id 时用 previous_response_id 登记，下一轮 reconstruct 命中', async (t) => {
  const { gw } = await setup(t, {
    experiment: { idRegisterFromClientPrev: true },
    responder: (i) => (i === 0 ? noIdResponse() : normalResponse()),
  })
  // 轮1：reconstruct 未命中（降级）；响应无 id → 实验回退以 REAL_ID 登记。
  const r1 = await gw.call('/v1/responses', reqOpts({ previous_response_id: REAL_ID }))
  assert.equal(r1.status, 200)
  // 轮2：同 prev id → reconstruct 应命中（restored>0）。
  const r2 = await gw.call('/v1/responses', reqOpts({ previous_response_id: REAL_ID }))
  assert.equal(r2.status, 200)
  const lines = causalLines(gw)
  const text = lines.join('\n')
  assert.ok(lines.some((l) => l.includes('mgp0.causal.register_from_prev')), '须有回退登记信号')
  assert.ok(lines.some((l) => l.includes('recorded=1')), '回退登记须成功')
  assert.ok(lines.some((l) => l.includes('idLevel=other')), '50hex 层级须记 other')
  assert.ok(lines.some((l) => l.includes('mgp0.causal.reconstruct_hit')), '轮2 须重建命中')
  assert.ok(lines.some((l) => l.includes('restored=1')), 'restored>0 可观测')
  assert.ok(lines.some((l) => l.includes('corr=')), '所有实验日志带 corr')
  assert.ok(readLog(gw).includes('responses continuation reconstructed'), '基线重建日志确认命中')
  assert.deepEqual(leaks(text), [], '实验日志零泄漏（prompt/凭据/明文 id）')
})

test('switch 2 bridgeIdUseRealPrev：合成 id→真实 50hex 别名解析后重建 restored>0', async (t) => {
  const { gw } = await setup(t, { experiment: { bridgeIdUseRealPrev: true } })
  // 轮1：prev=SYNTH_ID（合成），store 空 → 降级；上游返回 REAL_ID → 登记并建立 SYNTH↔REAL 别名。
  const r1 = await gw.call('/v1/responses', reqOpts({ previous_response_id: SYNTH_ID }))
  assert.equal(r1.status, 200)
  // 轮2：prev=SYNTH_ID → 别名解析到 REAL_ID → 重建命中。
  const r2 = await gw.call('/v1/responses', reqOpts({ previous_response_id: SYNTH_ID }))
  assert.equal(r2.status, 200)
  const lines = causalLines(gw)
  const text = lines.join('\n')
  assert.ok(lines.some((l) => l.includes('mgp0.causal.alias_link')), '须有别名建立信号')
  assert.ok(lines.some((l) => l.includes('fromLevel=opaque')), '合成 id 记 opaque')
  assert.ok(lines.some((l) => l.includes('toLevel=other')), '真实 50hex 记 other')
  assert.ok(lines.some((l) => l.includes('mgp0.causal.bridge_alias')), '轮2 须有别名解析信号')
  assert.ok(lines.some((l) => l.includes('mgp0.causal.reconstruct_hit')), '轮2 须重建命中')
  assert.ok(lines.some((l) => l.includes('restored=1')), 'restored>0 可观测')
  assert.deepEqual(leaks(text), [], '别名日志不得泄漏明文 id / 合成 id')
})

test('switch 3 reconstructFailClosedOnRestoredZero：restored=0 改 typed 400 终止', async (t) => {
  const { gw, hits } = await setup(t, { experiment: { reconstructFailClosedOnRestoredZero: true } })
  const r = await gw.call('/v1/responses', reqOpts({ previous_response_id: UNKNOWN_ID }))
  assert.equal(r.status, 400, '未命中不再降级，而是 typed 终止')
  assert.equal(hits.length, 0, 'fail-closed 在到达上游前即终止（不转发）')
  const body = await r.json()
  assert.equal(body.error.code, 'causal_reconstruct_fail_closed')
  assert.equal(body.error.type, 'causal_experiment')
  const lines = causalLines(gw)
  const text = lines.join('\n')
  assert.ok(lines.some((l) => l.includes('mgp0.causal.fail_closed')), '须有 fail_closed 信号')
  assert.ok(lines.some((l) => l.includes('restored=0')), '信号带 restored=0')
  assert.ok(lines.some((l) => l.includes('idLevel=other')), '50hex 层级记 other')
  assert.ok(lines.some((l) => l.includes('corr=')), 'fail_closed 带 corr')
  assert.deepEqual(leaks(text), [], 'fail_closed 日志零泄漏')
})

test('组合开关：三开关同时 ON，switch1 与 switch3 同轮次生效且互不屏蔽', async (t) => {
  // switch2 的可叠加性由上面「配置门」测试（三开关同时 true）+「别名原语」测试覆盖；
  // 由于 switch3 会在 reconstruct 未命中时先于响应阶段终止，组合场景要让 switch1 先有命中前提。
  const { gw } = await setup(t, {
    experiment: {
      idRegisterFromClientPrev: true,
      bridgeIdUseRealPrev: true,
      reconstructFailClosedOnRestoredZero: true,
    },
    responder: (i) => (i === 0 ? normalResponse() : noIdResponse()),
  })
  // 轮1（无 prev）：正常登记 REAL_ID；不触发 reconstruct，fail-closed 不误伤首轮。
  const r0 = await gw.call('/v1/responses', reqOpts())
  assert.equal(r0.status, 200)
  // 轮2（prev=REAL_ID）：reconstruct 命中；响应无 id → switch1 回退登记。
  const r1 = await gw.call('/v1/responses', reqOpts({ previous_response_id: REAL_ID }))
  assert.equal(r1.status, 200)
  // 轮3（未知 id）：switch3 fail-closed 终止（不被 switch1/2 屏蔽）。
  const r2 = await gw.call('/v1/responses', reqOpts({ previous_response_id: UNKNOWN_ID }))
  assert.equal(r2.status, 400)
  const text = causalLines(gw).join('\n')
  assert.ok(text.includes('mgp0.causal.reconstruct_hit'), 'switch1 前提：重建命中')
  assert.ok(text.includes('mgp0.causal.register_from_prev'), 'switch1 生效')
  assert.ok(text.includes('mgp0.causal.fail_closed'), 'switch3 生效')
  assert.deepEqual(leaks(text), [], '组合态日志零泄漏')
})
