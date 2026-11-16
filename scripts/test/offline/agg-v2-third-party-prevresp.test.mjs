// 回归：Codex WS 续轮帧带 previous_response_id 到第三方原生 Responses 目标（Go DeepSeek 子代理）。
// 修复前入口 nativeGate 报 "nativeContract 未声明"，400 unsupported_native_parameter，子代理无法派单。
// 2026-11-16 审计后契约：续轮帧在入口按 response.id 重建完整历史（parent.input+output+delta），
// 再剔除 previous_response_id 转发；无状态续轮 fail-closed 400 continuation_state_missing。
import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, startScriptedUpstream } from './harness.mjs'
import { V2_TARGET_PUBLIC_ID, V2_TARGET_UPSTREAM_MODEL } from '../../../src/providers/opencode-go.js'

const SYNTH_ENV = 'SYNTH_V2_PREVRESP_KEY'

function config(goBase) {
  return {
    defaults: {
      retry: { maxAttempts: 1 },
      timeout: { firstByteMs: 3000, idleMs: 3000, loopMs: 3000 },
      proxyMode: 'direct',
    },
    providers: { opencodego: { baseUrl: goBase + '/inference/go/openai/v1', api: 'responses', apiKeyEnv: SYNTH_ENV } },
    models: {
      [V2_TARGET_PUBLIC_ID]: {
        provider: 'opencodego',
        api: 'responses',
        providerModels: { opencodego: V2_TARGET_UPSTREAM_MODEL },
      },
    },
  }
}

test('第三方原生 Responses 子代理：续轮重建完整历史，previous_response_id 剔除后转发上游', { timeout: 30000 }, async (t) => {
  const upstreamBodies = []
  const up = await startScriptedUpstream(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    upstreamBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: {"type":"response.created","response":{"id":"resp_go","status":"in_progress","output":[]}}\n\n' +
      'data: {"type":"response.completed","response":{"id":"resp_go","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"parent ack"}]}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n')
  })
  const gw = await startGateway({ config: config(up.base), env: { [SYNTH_ENV]: 'sk-synthetic-offline-not-a-real-key' } })
  t.after(async () => { await gw.stop(); await up.stop() })

  // 轮1：父任务建立续轮状态
  const r1 = await gw.post('/v1/responses', {
    model: V2_TARGET_PUBLIC_ID,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'parent task' }] }],
    stream: true,
  }, { 'content-type': 'application/json' })
  assert.equal(r1.status, 200)
  await r1.text()

  // 轮2：子代理结果以增量续轮帧回来（真实 Codex wait_agent 形状）
  const r = await gw.post('/v1/responses', {
    model: V2_TARGET_PUBLIC_ID,
    input: [{ type: 'function_call_output', call_id: 'call_x', output: 'child result' }],
    stream: true,
    previous_response_id: 'resp_go',
  }, { 'content-type': 'application/json' })

  assert.equal(r.status, 200, '有状态续轮不应被 nativeGate 以 nativeContract 未声明拒绝')
  await r.text()
  assert.equal(upstreamBodies.length, 2)
  assert.equal(Object.prototype.hasOwnProperty.call(upstreamBodies[1], 'previous_response_id'), false, 'previous_response_id 必须在转发 Go 上游前剔除')
  const input = upstreamBodies[1].input
  assert.ok(input.some((i) => i.type === 'message' && i.content[0].text === 'parent task'), '轮1 用户消息被重建保留')
  assert.ok(input.some((i) => i.type === 'message' && i.content[0].text === 'parent ack'), '轮1 助手输出被重建保留')
  assert.equal(input.find((i) => i.type === 'function_call_output').output, 'child result', '对话内容未被改写')

  // 无状态续轮：typed 400，零上游调用
  const r3 = await gw.post('/v1/responses', {
    model: V2_TARGET_PUBLIC_ID,
    input: [],
    stream: true,
    previous_response_id: 'resp_prev_parent_session',
  }, { 'content-type': 'application/json' })
  assert.equal(r3.status, 400)
  const e3 = JSON.parse(await r3.text())
  assert.equal(e3.error.code, 'continuation_state_missing')
  assert.equal(upstreamBodies.length, 2)
})
