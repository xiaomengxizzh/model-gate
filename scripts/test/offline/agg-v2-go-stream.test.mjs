// V2-02 / A2：Go 上游 SSE 与工具调用关联保真回归（离线，全 mock）。
//
// 复用既有真实形状 fixture（scripts/test/fixtures/agg-chatcompat/）：
//   chat-sse-text-and-tools.sse —— 文本 + 两个并行工具调用，参数被拆到多帧
//   chat-response-tools.json    —— 非流式双工具调用响应
//
// 证明（MG-R005/R006 的协议前置，压缩/Agent Team 本身由 A1/A5 真实验收）：
//   1. 文本与工具帧顺序、call id、name、拆分 arguments 全部原样透传，不被丢弃/合并/改写；
//   2. 参数按 index 拼回后与 fixture 原文逐字节一致（工具 call 关联不失真）；
//   3. usage 帧（含 cached_tokens）与 [DONE] 终态保留，EOF 不冒充成功；
//   4. 多轮 tool loop：上一轮 call_id 与结果原样进入下一轮，会话标识同一线程稳定；
//   5. 非流式响应的 tool_calls 与 finish_reason 保真。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { startGateway, startScriptedUpstream } from './harness.mjs'
import { SESSION_HEADER, V2_TARGET_PUBLIC_ID, V2_TARGET_UPSTREAM_MODEL } from '../../../src/providers/opencode-go.js'

const BASE_CATALOG = fileURLToPath(new URL('../fixtures/agg-a2/base-catalog.json', import.meta.url))
const SSE_FIXTURE = readFileSync(fileURLToPath(new URL('../fixtures/agg-chatcompat/chat-sse-text-and-tools.sse', import.meta.url)), 'utf8')
const TOOLS_FIXTURE = JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/agg-chatcompat/chat-response-tools.json', import.meta.url)), 'utf8'))
const SYNTH_ENV = 'SYNTH_V2_GO_KEY'
const SYNTH_KEY = 'sk-synthetic-offline-not-a-real-key'

function goGatewayConfig(goBase) {
  return {
    defaults: {
      retry: { maxAttempts: 1 },
      timeout: { firstByteMs: 3000, idleMs: 3000, loopMs: 3000 },
      proxyMode: 'direct',
      codexCatalogBasePath: BASE_CATALOG,
    },
    providers: { opencodego: { baseUrl: goBase + '/inference/go/openai/v1', api: 'openai', apiKeyEnv: SYNTH_ENV } },
    models: {
      [V2_TARGET_UPSTREAM_MODEL]: {
        provider: 'opencodego',
        api: 'openai',
        providerModels: { opencodego: V2_TARGET_UPSTREAM_MODEL },
        alias: [V2_TARGET_PUBLIC_ID],
      },
    },
  }
}

function framesOf(sseText) {
  return String(sseText).split('\n\n')
    .filter((f) => f.startsWith('data: '))
    .map((f) => f.slice(6).trim())
}

function chatFrames(sseText) {
  return framesOf(sseText).filter((f) => f !== '[DONE]').map((f) => JSON.parse(f))
}

test('SSE 保真：工具 call id/name/参数分片原样透传，usage 与 [DONE] 保留', { timeout: 30000 }, async (t) => {
  const hits = []
  const up = await startScriptedUpstream(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    hits.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.end(SSE_FIXTURE)
  })
  const gw = await startGateway({ config: goGatewayConfig(up.base), env: { [SYNTH_ENV]: SYNTH_KEY } })
  t.after(async () => { await gw.stop(); await up.stop() })

  const res = await gw.post('/v1/chat/completions', {
    model: V2_TARGET_PUBLIC_ID,
    stream: true,
    messages: [{ role: 'user', content: 'read a.txt' }],
    tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
  }, { 'thread-id': 'codex-raw-thread-tools' })
  assert.equal(res.status, 200)
  assert.match(String(res.headers.get('content-type')), /text\/event-stream/)
  const text = await res.text()

  // 上游请求身份：真实模型、Go 入口、派生会话头。
  assert.equal(hits.length, 1)
  assert.equal(hits[0].url, '/inference/go/openai/v1/chat/completions')
  assert.equal(JSON.parse(hits[0].body).model, V2_TARGET_UPSTREAM_MODEL)
  assert.match(String(hits[0].headers[SESSION_HEADER]), /^[A-Za-z0-9_-]{32}$/)

  // 终态：必须带 [DONE]，不能靠 EOF 断流冒充完成。
  assert.ok(text.trimEnd().endsWith('[DONE]'), 'SSE 必须以 [DONE] 结束')

  const frames = chatFrames(text)
  assert.equal(frames.length, 8, 'fixture 的 8 个数据帧必须全部透传（不丢帧/不合并）')

  // 文本 delta 顺序保真。
  const textDeltas = frames
    .map((f) => f.choices && f.choices[0] && f.choices[0].delta && f.choices[0].delta.content)
    .filter((c) => typeof c === 'string' && c.length)
  assert.deepEqual(textDeltas, ['Look', 'ing up.'])

  // 工具调用：index / id / name / 参数分片顺序保真，拼回后与原文一致。
  const toolDeltas = []
  for (const f of frames) {
    const choice = f.choices && f.choices[0]
    const tc = choice && choice.delta && choice.delta.tool_calls
    if (Array.isArray(tc)) for (const item of tc) toolDeltas.push(item)
  }
  assert.equal(toolDeltas.length, 4, '两个工具各 2 个分片帧，不得合并或丢弃')
  const byIndex = new Map()
  for (const d of toolDeltas) {
    const idx = d.index
    if (!byIndex.has(idx)) byIndex.set(idx, { id: null, name: null, args: '' })
    const acc = byIndex.get(idx)
    if (d.id) acc.id = d.id
    if (d.function && d.function.name) acc.name = d.function.name
    if (d.function && typeof d.function.arguments === 'string') acc.args += d.function.arguments
  }
  assert.deepEqual([...byIndex.keys()].sort(), [0, 1], '两个并行工具调用都必须保留 index')
  assert.deepEqual(byIndex.get(0), { id: 'call_alpha', name: 'read_file', args: '{"path":"a.txt"}' })
  assert.deepEqual(byIndex.get(1), { id: 'call_beta', name: 'list_dir', args: '{"path":"."}' })

  // finish_reason 与 usage（含 cached_tokens）保真：工具已出帧后不得当成未发送。
  const finish = frames.find((f) => f.choices && f.choices[0] && f.choices[0].finish_reason)
  assert.equal(finish.choices[0].finish_reason, 'tool_calls')
  const usageFrame = frames.find((f) => f.usage)
  assert.equal(usageFrame.usage.prompt_tokens, 120)
  assert.equal(usageFrame.usage.completion_tokens, 18)
  assert.equal(usageFrame.usage.prompt_tokens_details.cached_tokens, 64, '缓存命中明细不得被抹掉')
})

test('多轮 tool loop：call_id 与工具结果原样进入下一轮，会话保持同一派生值', { timeout: 30000 }, async (t) => {
  const bodies = []
  const up = await startScriptedUpstream(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    bodies.push({ url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
    res.setHeader('content-type', 'application/json')
    if (bodies.length === 1) res.end(JSON.stringify(TOOLS_FIXTURE))
    else res.end(JSON.stringify({ id: 'chatcmpl-2', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10 } }))
  })
  const gw = await startGateway({ config: goGatewayConfig(up.base), env: { [SYNTH_ENV]: SYNTH_KEY } })
  t.after(async () => { await gw.stop(); await up.stop() })

  const tools = [
    { type: 'function', function: { name: 'read_file', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'list_dir', description: 'list', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
  ]
  const first = await gw.post('/v1/chat/completions', {
    model: V2_TARGET_PUBLIC_ID,
    tools,
    messages: [{ role: 'user', content: 'read a.txt and list .' }],
  }, { 'thread-id': 'thread-loop-1' })
  assert.equal(first.status, 200)
  const firstBody = await first.json()
  const calls = firstBody.choices[0].message.tool_calls
  assert.equal(calls.length, 2)
  assert.deepEqual(calls.map((c) => c.id), ['call_alpha', 'call_beta'], 'call id 必须原样透传')
  assert.deepEqual(calls.map((c) => c.function.name), ['read_file', 'list_dir'])
  assert.equal(calls[0].function.arguments, '{"path":"a.txt"}', '参数不得被改写')
  assert.equal(firstBody.choices[0].finish_reason, 'tool_calls')

  // 第二轮：把两个工具结果按 call_id 回传。
  const second = await gw.post('/v1/chat/completions', {
    model: V2_TARGET_PUBLIC_ID,
    tools,
    messages: [
      { role: 'user', content: 'read a.txt and list .' },
      { role: 'assistant', content: firstBody.choices[0].message.content, tool_calls: calls },
      { role: 'tool', tool_call_id: 'call_alpha', content: 'hello' },
      { role: 'tool', tool_call_id: 'call_beta', content: 'a.txt' },
    ],
  }, { 'thread-id': 'thread-loop-1' })
  assert.equal(second.status, 200)
  assert.equal(bodies.length, 2)

  const secondAt = bodies[1]
  assert.equal(secondAt.body.model, V2_TARGET_UPSTREAM_MODEL)
  const toolMsgs = secondAt.body.messages.filter((m) => m.role === 'tool')
  assert.deepEqual(toolMsgs.map((m) => [m.tool_call_id, m.content]), [['call_alpha', 'hello'], ['call_beta', 'a.txt']])
  const assistantToolCalls = secondAt.body.messages.find((m) => m.role === 'assistant').tool_calls
  assert.deepEqual(assistantToolCalls.map((c) => c.id), ['call_alpha', 'call_beta'])
  assert.deepEqual(assistantToolCalls.map((c) => c.function.arguments), ['{"path":"a.txt"}', '{"path":"."}'])

  // 同一线程两轮：派生会话标识稳定，且始终不是原始 thread id。
  const s1 = bodies[0].headers[SESSION_HEADER]
  const s2 = bodies[1].headers[SESSION_HEADER]
  assert.equal(s1, s2, '同一原生线程的会话标识必须稳定（会话亲和）')
  assert.notEqual(s1, 'thread-loop-1')
  assert.equal(bodies[1].headers['thread-id'], undefined)
})

test('非流式工具响应：tool_calls 与 finish_reason 保真，不插入额外字段', { timeout: 30000 }, async (t) => {
  const up = await startScriptedUpstream(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(TOOLS_FIXTURE))
  })
  const gw = await startGateway({ config: goGatewayConfig(up.base), env: { [SYNTH_ENV]: SYNTH_KEY } })
  t.after(async () => { await gw.stop(); await up.stop() })

  const res = await gw.post('/v1/chat/completions', {
    model: V2_TARGET_PUBLIC_ID,
    messages: [{ role: 'user', content: 'go' }],
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.choices[0].finish_reason, 'tool_calls')
  assert.deepEqual(body.choices[0].message.tool_calls, TOOLS_FIXTURE.choices[0].message.tool_calls,
    '上游工具调用必须逐字节保真（id/type/function 结构）')
  assert.equal(body.usage.total_tokens, 138)
})
