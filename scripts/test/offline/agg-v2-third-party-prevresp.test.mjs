// 回归：Codex WS 续轮帧带 previous_response_id 到第三方原生 Responses 目标（Go DeepSeek 子代理）。
// 修复前入口 nativeGate 报 "nativeContract 未声明"，400 unsupported_native_parameter，子代理无法派单。
// 修复后：nativeGate 放行（声明 contract），投影层按目标能力剔除 previous_response_id 后再转发上游。
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

test('第三方原生 Responses 子代理：previous_response_id 不被 nativeGate 拒绝，剔除后转发上游', { timeout: 30000 }, async (t) => {
  const upstreamBodies = []
  const up = await startScriptedUpstream(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    upstreamBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: {"type":"response.created","response":{"id":"resp_go","status":"in_progress","output":[]}}\n\n' +
      'data: {"type":"response.completed","response":{"id":"resp_go","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n')
  })
  const gw = await startGateway({ config: config(up.base), env: { [SYNTH_ENV]: 'sk-synthetic-offline-not-a-real-key' } })
  t.after(async () => { await gw.stop(); await up.stop() })

  const r = await gw.post('/v1/responses', {
    model: V2_TARGET_PUBLIC_ID,
    input: [{ type: 'function_call_output', call_id: 'call_x', output: 'child result' }],
    stream: true,
    previous_response_id: 'resp_prev_parent_session',
  }, { 'content-type': 'application/json' })

  assert.equal(r.status, 200, '不应再被 nativeGate 以 nativeContract 未声明拒绝')
  await r.text()
  assert.equal(upstreamBodies.length, 1)
  assert.equal(Object.prototype.hasOwnProperty.call(upstreamBodies[0], 'previous_response_id'), false, 'previous_response_id 必须在转发 Go 上游前剔除')
  assert.equal(upstreamBodies[0].input[0].output, 'child result', '对话内容未被改写')
})
