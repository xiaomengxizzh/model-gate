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

// chat-completions 子代理（deepseek 当前生效配置）：provider 与 model 都走 api='openai'。
function configChatCompletions(goBase) {
  return {
    defaults: {
      retry: { maxAttempts: 1 },
      timeout: { firstByteMs: 3000, idleMs: 3000, loopMs: 3000 },
      proxyMode: 'direct',
    },
    providers: { opencodego: { baseUrl: goBase + '/v1', api: 'openai', apiKeyEnv: SYNTH_ENV } },
    models: {
      [V2_TARGET_PUBLIC_ID]: {
        provider: 'opencodego',
        api: 'openai',
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

  // 无状态续轮：优雅降级——孤儿 output 走 orphan-adopt 补齐 call_id 后转发（真机验证过的形状修复）
  const r3 = await gw.post('/v1/responses', {
    model: V2_TARGET_PUBLIC_ID,
    input: [{ type: 'function_call_output', call_id: 'call_orphan_degraded', output: 'degraded result' }],
    stream: true,
    previous_response_id: 'resp_prev_parent_session',
  }, { 'content-type': 'application/json' })
  assert.equal(r3.status, 200, '状态缺失降级转发，不打断会话')
  await r3.text()
  assert.equal(upstreamBodies.length, 3)
  assert.equal(upstreamBodies[2].previous_response_id, undefined)
  assert.equal(upstreamBodies[2].input[0].output, 'degraded result', '降级不改写工具结果内容')
})

test('第三方 chat-completions 子代理：续轮帧 previous_response_id 在 Chat 桥前剔除，无状态重发不被 400 拒绝', { timeout: 30000 }, async (t) => {
  const upstreamBodies = []
  const up = await startScriptedUpstream(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    let parsed = null
    try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* 非 JSON，交由断言报错 */ }
    upstreamBodies.push({ url: String(req.url || ''), body: parsed })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      id: 'chatcmpl_go', object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: 'child ack' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }))
  })
  const gw = await startGateway({ config: configChatCompletions(up.base), env: { [SYNTH_ENV]: 'sk-synthetic-offline-not-a-real-key' } })
  t.after(async () => { await gw.stop(); await up.stop() })

  // 模拟 luna 父调用 deepseek 子后的续轮帧：子代理带 previous_response_id（Codex 连接续轮自行填入），
  // input 已含完整历史（function_call + function_call_output，Codex 全量重发）。
  const r = await gw.post('/v1/responses', {
    model: V2_TARGET_PUBLIC_ID,
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'parent task from luna' }] },
      { type: 'function_call', call_id: 'call_child', name: 'delegate', arguments: '{"task":"child work"}' },
      { type: 'function_call_output', call_id: 'call_child', output: 'child result' },
    ],
    stream: false,
    previous_response_id: 'resp_luna_parent_go',
  }, { 'content-type': 'application/json' })

  const raw = await r.text()
  assert.equal(r.status, 200, 'thirdParty chat-completions 续轮帧不应被 Chat 桥以 previous_response_id 拒绝；body=' + raw)
  assert.doesNotMatch(raw, /网关不维护响应续轮/, '响应体不得含 Chat 桥拒绝文案')
  assert.equal(upstreamBodies.length, 1, '上游应收到一次请求')
  const hit = upstreamBodies[0]
  assert.equal(hit.url, '/v1/chat/completions', 'chat-completions 子请求应经 Chat 桥发到 chat/completions')
  assert.ok(hit.body && typeof hit.body === 'object', '上游应收到 JSON Chat 体')
  assert.equal(Object.prototype.hasOwnProperty.call(hit.body, 'previous_response_id'), false, 'previous_response_id 必须在 Chat 桥前剔除')
  assert.equal(Object.prototype.hasOwnProperty.call(hit.body, 'input'), false, 'Responses input 不得原样漏给 chat 上游')

  const msgs = hit.body.messages || []
  const assistant = msgs.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls))
  assert.ok(assistant, '应产生含 tool_calls 的 assistant 消息')
  const tool = msgs.find((m) => m.role === 'tool')
  assert.ok(tool, '应产生 tool 结果消息')
  assert.equal(assistant.tool_calls[0].id, tool.tool_call_id, 'function_call 与 function_call_output 的 call_id 必须保持一致（MG-R008 配对未放宽）')
  assert.ok(msgs.some((m) => m.role === 'user' && String(m.content).includes('parent task from luna')), '用户历史 input 未被删除')
})

// 真机回归（2026-11-19）：Codex 0.169/0.170 的 deepseek 子代理续轮帧是**增量**——
// input 只带 function_call_output，其配对的 function_call 在上一轮响应里（靠 previous_response_id 关联）。
// 3c74cc3 注释里"input 已含完整历史（全量重发）"的假设不成立 → 裸删 prev_id 后桥配对闸门判
// tool_output_without_call → 400。正确修复：删 prev_id 前先 reconstruct 补回上一轮完整历史
// （复用 native 路径已验证机制），桥配对闸门自然通过；未命中仍退回无状态重发（不回归）。
const REGISTRAR_MODEL = 'mg-offline-cont-registrar'
const REC = 'resp_parent_calls_offline'
// 双模型：native registrar（api=responses）用于让网关进程自己登记 continuation；
// V2_TARGET_PUBLIC_ID（api=openai）是被测的 chat-completions 子代理。
function configChatIncremental (goBase) {
  const c = configChatCompletions(goBase)
  c.models[REGISTRAR_MODEL] = {
    provider: 'opencodego',
    api: 'responses',
    providerModels: { opencodego: 'registrar-upstream-model' },
  }
  return c
}

test('chat-completions 子代理增量续轮：reconstruct 补回上一轮 function_call，桥配对通过不 400', { timeout: 30000 }, async (t) => {
  const upstreamBodies = []
  const up = await startScriptedUpstream(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    let parsed = null
    try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* ignore */ }
    upstreamBodies.push({ url: String(req.url || ''), body: parsed })
    // registrar 轮：Responses SSE，output 带 function_call + response.id=REC，让网关 captureSink 登记。
    if (parsed && parsed.model === 'registrar-upstream-model') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: {"type":"response.created","response":{"id":"' + REC + '","status":"in_progress","output":[]}}\n\n' +
        'data: {"type":"response.output_item.done","item":{"type":"function_call","id":"fc_child_1","call_id":"call_child","name":"spawn_agent","arguments":"{\\"agent\\":\\"go_deepseek\\"}"}}\n\n' +
        'data: {"type":"response.completed","response":{"id":"' + REC + '","status":"completed","output":[{"type":"function_call","id":"fc_child_1","call_id":"call_child","name":"spawn_agent","arguments":"{\\"agent\\":\\"go_deepseek\\"}"}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n')
      return
    }
    // chat 子代理轮：普通 chat JSON。
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      id: 'chatcmpl_go', object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: 'child ack' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }))
  })
  const gw = await startGateway({ config: configChatIncremental(up.base), env: { [SYNTH_ENV]: 'sk-synthetic-offline-not-a-real-key' } })
  t.after(async () => { await gw.stop(); await up.stop() })

  // 轮1：经网关进程发 native 请求，网关 captureSink 登记 continuation（key=REC，含 function_call）。
  const r1 = await gw.post('/v1/responses', {
    model: REGISTRAR_MODEL,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'parent task from luna' }] }],
    stream: true,
  }, { 'content-type': 'application/json' })
  assert.equal(r1.status, 200)
  await r1.text()

  // 轮2：chat 子代理增量续轮帧——只有 function_call_output，prev_id 指向轮1 登记的 REC。
  const r = await gw.post('/v1/responses', {
    model: V2_TARGET_PUBLIC_ID,
    input: [{ type: 'function_call_output', call_id: 'call_child', output: 'child result' }],
    stream: false,
    previous_response_id: REC,
  }, { 'content-type': 'application/json' })

  const raw = await r.text()
  assert.equal(r.status, 200, '增量续轮帧应在 reconstruct 后通过桥配对闸门；body=' + raw)
  assert.doesNotMatch(raw, /工具调用配对不自洽/, '不得再出现 tool_output_without_call 配对错误')
  assert.doesNotMatch(raw, /网关不维护响应续轮/, '不得出现 Chat 桥续轮拒绝文案')
  const chatHits = upstreamBodies.filter((h) => h.body && h.body.messages)
  assert.equal(chatHits.length, 1, 'chat 子代理应命中一次上游')
  const hit = chatHits[0]
  assert.equal(hit.url, '/v1/chat/completions', '仍经 Chat 桥到 chat/completions')
  assert.equal(Object.prototype.hasOwnProperty.call(hit.body, 'previous_response_id'), false, 'previous_response_id 必须在 Chat 桥前剔除')

  const msgs = hit.body.messages || []
  const assistant = msgs.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls))
  const tool = msgs.find((m) => m.role === 'tool')
  assert.ok(assistant, 'reconstruct 补回的 function_call 应转成 assistant.tool_calls')
  assert.ok(tool, '增量 function_call_output 应转成 tool 结果消息')
  assert.equal(assistant.tool_calls[0].id, tool.tool_call_id, 'call_id 必须配对一致（MG-R008 未放宽）')
  assert.ok(msgs.some((m) => m.role === 'user' && String(m.content).includes('parent task from luna')), '重建保留上一轮用户历史')
})
