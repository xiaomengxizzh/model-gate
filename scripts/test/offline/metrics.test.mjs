// MG-006 指标口径：一次请求只计一次对话请求；token/缓存回调只累加数值；状态字典有容量上限。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startGateway } from './harness.mjs'

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
