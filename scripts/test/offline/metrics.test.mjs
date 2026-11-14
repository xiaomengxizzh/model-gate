// MG-006 指标口径：一次请求只计一次对话请求；token/缓存回调只累加数值；状态字典有容量上限。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startGateway, startMockUpstream } from './harness.mjs'

// 上游：按请求体决定返回 JSON 还是带 usage/缓存明细的 SSE
async function startUsageUpstream() {
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const c of req) raw += c
    let body = {}
    try { body = JSON.parse(raw) } catch {}
    if (body && body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }) + '\n\n')
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 6 } } }) + '\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ id: 'm', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { base: 'http://127.0.0.1:' + server.address().port, stop: async () => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)) } }
}

test('MG-006 一次请求只计一次对话请求（流式 usage+缓存不重复计数）', { timeout: 30000 }, async (t) => {
  const upstream = await startUsageUpstream()
  const gw = await startGateway({
    name: 'metrics-dialogue',
    config: {
      providers: { mock: { baseUrl: upstream.base } },
      models: { demo: { provider: 'mock', api: 'openai' } },
    },
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  const conv = 'conv-metrics-1'
  const jsonRes = await gw.post('/v1/chat/completions', { model: 'demo', messages: [{ role: 'user', content: 'hi' }] }, { 'x-conversation-id': conv })
  assert.equal(jsonRes.status, 200)
  const streamRes = await gw.post('/v1/chat/completions', { model: 'demo', stream: true, messages: [{ role: 'user', content: 'hi' }] }, { 'x-conversation-id': conv })
  assert.equal(streamRes.status, 200)
  await streamRes.text()

  const status = await (await gw.get('/api/status')).json()
  const d = status.dialogues.find((x) => x.id === conv)
  assert.ok(d, '对话出现在状态里')
  assert.equal(d.requests, 2, '两条请求各计一次（流式的 token/缓存回调不再额外 +1）')
  assert.equal(d.tokens, 5 + 15, 'token 累加：非流式 5 + 流式 15')
  assert.equal(d.hit, 6, '缓存命中来自流式 usage 明细')
  // 非流式响应没有 cached_tokens → 3 个输入全部算未命中；流式 10 输入 - 6 命中 = 4
  assert.equal(d.miss, 3 + 4, '未命中 = 各请求输入 - 命中')

  // 尝试（attempt）口径：每个请求一次上游尝试
  const provider = status.providers.find((p) => p.id === 'mock')
  assert.equal(provider.st.requests, 2)
})

test('MG-006 容量上限：对话字典不会无界增长（落盘后 ≤80 条）', { timeout: 60000 }, async (t) => {
  const upstream = await startUsageUpstream()
  const dir = await mkdtemp(join(tmpdir(), 'modelgate-metrics-cap-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const gw = await startGateway({
    name: 'metrics-cap',
    dir,
    config: {
      providers: { mock: { baseUrl: upstream.base } },
      models: { demo: { provider: 'mock', api: 'openai', forceNoStream: true } },
    },
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })

  for (let batch = 0; batch < 10; batch++) {
    await Promise.all(Array.from({ length: 10 }, (_, i) => {
      const n = batch * 10 + i
      return gw.post('/v1/chat/completions', { model: 'demo', messages: [{ role: 'user', content: 'hi' }] }, { 'x-conversation-id': 'conv-cap-' + n })
    }))
  }
  const status = await (await gw.get('/api/status')).json()
  assert.ok(status.dialogues.length <= 30, '状态只投影最近 30 个对话')

  gw.child.kill('SIGTERM')
  await once(gw.child, 'exit')
  const stats = JSON.parse(await readFile(join(dir, 'stats.json'), 'utf8'))
  const count = Object.keys(stats.dialogue || {}).length
  assert.ok(count <= 80, '对话字典落盘时被裁剪到 ≤80（实际 ' + count + '）')
})


// ============================================================================
// N06：可观测收据与事件（终态只记一次 / 版本化分页 / 有限历史 / 脱敏关联）
// ============================================================================

test('N06 收据：终态按 (requestId,terminal) 只记一次；未知用量写 unknown 不填 0', async () => {
  const { createObservability, hashId, USAGE_UNKNOWN } = await import('../../../src/observability/events.js')
  const obs = createObservability({ capacity: 10 })
  const rid = hashId('raw-request-1')
  const first = obs.recordTerminal({ requestId: rid, terminal: 'SUCCEEDED' })
  const second = obs.recordTerminal({ requestId: rid, terminal: 'SUCCEEDED' })
  assert.equal(first.recorded, true)
  assert.equal(second.recorded, false, '同终态重复上报必须去重')
  assert.equal(obs.stats().terminals, 1, 'stats 只记一次')
  assert.equal(obs.stats().deduped, 1)
  assert.equal(first.usage.tokens, USAGE_UNKNOWN, '未确证用量必须是 unknown')
  const unsent = obs.recordTerminal({ requestId: hashId('raw-request-2'), terminal: 'CANCELLED_UNSENT' })
  assert.equal(unsent.usage.tokens, 0, '确证未发出才是已知 0')
  // 不同终态是不同收据（同一 request 先 FAILED 后 SUCCEEDED 不会被合并）
  const rid3 = hashId('raw-request-3')
  obs.recordTerminal({ requestId: rid3, terminal: 'FAILED' })
  obs.recordTerminal({ requestId: rid3, terminal: 'SUCCEEDED' })
  assert.equal(obs.stats().terminals, 4, 'FAILED 与 SUCCEEDED 是不同终态，各自记一次')
})

test('N06 事件：正文/凭据/密文/原始 id 一律拒绝（父子只收显式哈希关联）', async () => {
  const { createObservability, hashId } = await import('../../../src/observability/events.js')
  const obs = createObservability()
  for (const forbidden of [{ body: 'x' }, { prompt: 'x' }, { authorization: 'Bearer x' }, { encrypted_content: 'x' }, { apiKey: 'x' }]) {
    assert.throws(() => obs.recordAttempt(Object.assign({ kind: 'attempt' }, forbidden)), /forbidden field/, JSON.stringify(forbidden))
  }
  assert.throws(() => obs.recordTerminal({ requestId: 'RAW-PLAINTEXT-ID', terminal: 'SUCCEEDED' }), /sha256-derived/)
  assert.throws(() => obs.recordAttempt({ requestId: hashId('a'), parentRequestId: 'raw-parent', kind: 'attempt' }), /hashed id/)
  const ok = obs.recordAttempt({ requestId: hashId('a'), parentRequestId: hashId('parent'), attemptId: hashId('att'), kind: 'attempt', phase: 'succeeded' })
  assert.equal(ok.version, 1)
  assert.equal(ok.contract, 'mg-observability-v1')
})

test('N06 分页：版本化 cursor 分页、hasMore、有界历史与 dropped 计数', async () => {
  const { createObservability, hashId } = await import('../../../src/observability/events.js')
  const obs = createObservability({ capacity: 3 })
  for (let i = 0; i < 5; i++) obs.recordTerminal({ requestId: hashId('r' + i), terminal: 'SUCCEEDED' })
  const p1 = obs.page({ limit: 2 })
  assert.equal(p1.version, 1)
  assert.equal(p1.contract, 'mg-observability-v1')
  assert.equal(p1.items.length, 2)
  assert.equal(p1.hasMore, true)
  assert.equal(p1.retained.count, 3, '有界历史只保留 capacity 条')
  assert.equal(p1.retained.dropped, 2, '被淘汰条数必须如实计数')
  const p2 = obs.page({ limit: 10, cursor: p1.nextCursor })
  assert.equal(p2.items.length, 1)
  assert.equal(p2.hasMore, false)
  assert.throws(() => obs.page({ cursor: 'abc' }), /cursor/)
})

test('N06 网关：/api/observability/events 版本化分页，正文/原始 id/密钥一律不出现', { timeout: 45000 }, async (t) => {
  const upstream = await startMockUpstream()
  const gw = await startGateway({
    name: 'n06-obs',
    config: { providers: { mock: { baseUrl: upstream.base } }, models: { demo: { provider: 'mock', api: 'openai' } } },
  })
  t.after(async () => { await gw.stop(); await upstream.stop() })
  const CANARY = 'CANARY-BODY-N06-DO-NOT-LEAK'
  const SENTINEL_KEY = 'sk-canary-n06-0123456789'
  await gw.post('/v1/chat/completions', { model: 'demo', messages: [{ role: 'user', content: CANARY }] }, { 'content-type': 'application/json', 'x-request-id': 'raw-parent-id-n06', authorization: 'Bearer ' + SENTINEL_KEY })
  const page = await (await gw.get('/api/observability/events?limit=5')).json()
  assert.equal(page.version, 1)
  assert.ok(page.items.length >= 1, '应有一条 request 收据')
  const text = JSON.stringify(page)
  assert.equal(text.includes(CANARY), false, '事件不得包含正文')
  assert.equal(text.includes(SENTINEL_KEY), false, '事件不得包含密钥')
  assert.equal(text.includes('raw-parent-id-n06'), false, '原始请求 id 不得出现（只允许哈希）')
  for (const ev of page.items) {
    assert.equal(ev.contract, 'mg-observability-v1')
    assert.match(ev.requestId, /^[a-f0-9]{8,64}$/)
    if (ev.usage) assert.ok(ev.usage.tokens === 'unknown' || Number.isFinite(ev.usage.tokens))
  }
})
