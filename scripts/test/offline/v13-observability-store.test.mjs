// G15：按 scope 的有界持久观测事件。只使用临时目录、回环 mock 与合成标识。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createObservability, hashId } from '../../../src/observability/events.js'
import { structuredLogs } from '../../../src/resources/diagnostics.js'
import { startGateway, startMockUpstream } from './harness.mjs'

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mg-g15-store-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function lines(file) {
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

function storedLines(file) {
  return (existsSync(file + '.1') ? lines(file + '.1') : []).concat(lines(file))
}

test('G15 未提供 persistFile 时持久化禁用，ring/分页兼容保持不变', (t) => {
  const obs = createObservability({ capacity: 2 })
  obs.recordTerminal({ requestId: hashId('r1'), terminal: 'SUCCEEDED' })
  assert.equal(obs.durability().enabled, false)
  assert.equal(obs.history().items.length, 1)
  assert.equal(obs.page({ limit: 1 }).items.length, 1)
  assert.equal(obs.page({ durable: true }).retained.capacity, 2)
  const persistent = createObservability({ persistFile: join(tempDir(t), 'events.jsonl') })
  const empty = persistent.page({ durable: true })
  assert.equal(empty.items.length, 0)
  assert.equal(empty.retained.count, 0)
  assert.equal(empty.retained.enabled, true)
  assert.equal(empty.retained.maxRecords, 5000)
})

test('G15 JSONL 0600、重启加载、seq 连续且 SSE 仍只使用实时 ring', (t) => {
  const dir = tempDir(t)
  const file = join(dir, 'observability', 'events.jsonl')
  const opts = { persistFile: file, capacity: 1, maxBytes: 8192, maxRecords: 20, now: () => 1700000000000 }
  const first = createObservability(opts)
  first.recordTerminal({ requestId: hashId('raw-r1'), terminal: 'SUCCEEDED', model: 'demo' })
  first.recordTerminal({ requestId: hashId('raw-r2'), terminal: 'FAILED', status: 503 })
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.equal(statSync(join(dir, 'observability')).mode & 0o777, 0o700)
  assert.equal(first.size(), 1, '实时 ring 仍受 capacity 限制')
  assert.equal(first.history().items.length, 2, '持久历史不受实时 capacity 限制')

  const restarted = createObservability(opts)
  assert.equal(restarted.size(), 0, '重启不把历史注入 SSE ring')
  assert.deepEqual(restarted.history().items.map((event) => event.seq), [1, 2])
  const p1 = restarted.page({ durable: true, limit: 1 })
  const p2 = restarted.page({ durable: true, limit: 1, cursor: p1.nextCursor })
  assert.deepEqual([p1.items[0].seq, p2.items[0].seq], [1, 2])
  assert.equal(p2.hasMore, false)
  const seen = []
  restarted.subscribe((event) => seen.push(event.seq))
  restarted.recordTerminal({ requestId: hashId('raw-r3'), terminal: 'SUCCEEDED' })
  const live = restarted.history().items.at(-1)
  assert.equal(live.seq, 3, '重启后 seq 必须继续，不能与历史冲突')
  assert.deepEqual(seen, [3])
  assert.deepEqual(restarted.page({ limit: 10 }).items.map((event) => event.seq), [3])
})

test('G15 maxRecords/maxBytes 轮转后总保留量有界且只留最新事件', (t) => {
  const dir = tempDir(t)
  const byRecords = join(dir, 'records', 'events.jsonl')
  const obs = createObservability({ persistFile: byRecords, maxRecords: 3, maxBytes: 8192 })
  for (let i = 1; i <= 5; i++) obs.recordTerminal({ requestId: hashId('record-' + i), terminal: 'SUCCEEDED', model: 'm' + i })
  assert.equal(existsSync(byRecords + '.1'), true, '达到记录上限应轮转')
  const durable = obs.page({ durable: true, limit: 100 }).items
  assert.deepEqual(durable.map((event) => event.seq), [3, 4, 5])
  assert.deepEqual(storedLines(byRecords).map((event) => event.seq), [3, 4, 5], '磁盘轮转文件也必须有界且与内存一致')
  assert.ok(obs.durability().dropped >= 2)
  assert.ok(obs.durability().rotations >= 1)

  const byBytes = join(dir, 'bytes', 'events.jsonl')
  const bounded = createObservability({ persistFile: byBytes, maxRecords: 100, maxBytes: 700 })
  for (let i = 1; i <= 10; i++) bounded.recordTerminal({ requestId: hashId('byte-' + i), terminal: 'SUCCEEDED' })
  const totalBytes = statSync(byBytes).size + (existsSync(byBytes + '.1') ? statSync(byBytes + '.1').size : 0)
  assert.ok(totalBytes <= 700, '当前文件与轮转文件总字节不得超过 maxBytes')
  const byteDurable = bounded.page({ durable: true, limit: 100 }).items
  assert.ok(byteDurable.length <= 100)
  assert.equal(storedLines(byBytes).length, byteDurable.length, '字节轮转淘汰时不得复活旧 archive')
  assert.equal(byteDurable.at(-1).seq, 10)
  assert.ok(byteDurable.every((event) => event.seq > 1), '旧事件应已淘汰')
})

test('G15 损坏/截断/含 forbidden 字段/明文 ID 的行跳过计数，修复后可继续追加', (t) => {
  const dir = tempDir(t)
  const file = join(dir, 'events.jsonl')
  const opts = { persistFile: file, maxBytes: 8192, maxRecords: 20 }
  const obs = createObservability(opts)
  obs.recordTerminal({ requestId: hashId('clean-1'), terminal: 'SUCCEEDED' })
  obs.recordTerminal({ requestId: hashId('clean-2'), terminal: 'FAILED' })
  const valid = lines(file)
  const forbidden = { ...valid[0], seq: 50, metadata: { body: 'G15-SECRET-BODY' } }
  const plaintext = { ...valid[0], seq: 51, requestId: 'G15-RAW-ID' }
  const invalidTime = { ...valid[0], seq: 52, at: 1e300 }
  writeFileSync(file, JSON.stringify(valid[0]) + '\nnot-json\n' + JSON.stringify(forbidden) + '\n' + JSON.stringify(plaintext) + '\n' + JSON.stringify(invalidTime) + '\n' + JSON.stringify(valid[1]) + '\n' + '{"kind":')

  const restarted = createObservability(opts)
  assert.deepEqual(restarted.history().items.map((event) => event.seq), [1, 2])
  assert.ok(restarted.durability().corrupt >= 5, '坏 JSON、forbidden、明文 ID、非法时间和截断尾行都要计数')
  assert.equal(JSON.stringify(restarted.history()).includes('G15-SECRET-BODY'), false)
  assert.equal(JSON.stringify(restarted.history()).includes('G15-RAW-ID'), false)
  assert.equal(readFileSync(file, 'utf8').includes('G15-SECRET-BODY'), false, '启动收敛应移除坏行而不是继续暴露')
  restarted.recordTerminal({ requestId: hashId('clean-3'), terminal: 'SUCCEEDED' })
  assert.deepEqual(lines(file).map((event) => event.seq), [1, 2, 3], '截断修复后新记录不能拼到坏尾行')
})

test('G15 启动收敛崩溃残留的 archive/current 重叠不丢较新事件', (t) => {
  const dir = tempDir(t)
  const file = join(dir, 'events.jsonl')
  const opts = { persistFile: file, maxBytes: 8192, maxRecords: 20 }
  const obs = createObservability(opts)
  for (let i = 1; i <= 3; i++) obs.recordTerminal({ requestId: hashId('overlap-' + i), terminal: 'SUCCEEDED' })
  const all = lines(file)
  writeFileSync(file + '.1', all.slice(0, 2).map((event) => JSON.stringify(event)).join('\n') + '\n')
  writeFileSync(file, all.map((event) => JSON.stringify(event)).join('\n') + '\n')
  const restarted = createObservability(opts)
  assert.deepEqual(restarted.page({ durable: true, limit: 10 }).items.map((event) => event.seq), [1, 2, 3])
  assert.equal(restarted.durability().corrupt, 0, '一致的重叠不是损坏')
  assert.deepEqual(storedLines(file).map((event) => event.seq), [1, 2, 3])
})

test('G15 符号链接等非 scope-owned 普通文件 fail-closed，且不写外部目标', (t) => {
  const dir = tempDir(t)
  const outside = join(dir, 'outside.jsonl')
  const file = join(dir, 'owned', 'events.jsonl')
  writeFileSync(outside, 'outside-sentinel\n')
  mkdirSync(join(dir, 'owned'), { recursive: true })
  symlinkSync(outside, file)
  const denied = createObservability({ persistFile: file })
  denied.recordTerminal({ requestId: hashId('r'), terminal: 'SUCCEEDED' })
  assert.equal(denied.durability().enabled, false)
  assert.equal(denied.durability().error, 'observability_store_unsafe_path')
  assert.equal(readFileSync(outside, 'utf8'), 'outside-sentinel\n')
})

test('G15 emit 递归拒绝正文/凭据/原始 attempt ID，持久文件不含 canary', (t) => {
  const dir = tempDir(t)
  const file = join(dir, 'events.jsonl')
  const obs = createObservability({ persistFile: file })
  assert.throws(() => obs.emit({ kind: 'usage', metadata: { nested: { authorization: 'Bearer G15-SECRET' } } }), /forbidden field/)
  assert.throws(() => obs.recordAttempt({ attemptId: 'raw-attempt-id', phase: 'sending' }), /sha256-derived/)
  obs.recordAttempt({ requestId: hashId('raw-request'), attemptId: hashId('raw-attempt'), phase: 'sending' })
  const text = readFileSync(file, 'utf8')
  assert.equal(text.includes('G15-SECRET'), false)
  assert.equal(text.includes('raw-request'), false)
  assert.equal(text.includes('raw-attempt'), false)
})

test('G15 写盘失败不阻断实时 ring，已加载历史与未持久化实时事件仍可查询', (t) => {
  const dir = tempDir(t)
  const file = join(dir, 'events.jsonl')
  const obs = createObservability({ persistFile: file })
  obs.recordTerminal({ requestId: hashId('before-write-failure'), terminal: 'SUCCEEDED' })
  rmSync(file)
  mkdirSync(file)
  obs.recordTerminal({ requestId: hashId('after-write-failure'), terminal: 'FAILED', status: 503 })
  assert.equal(obs.size(), 2)
  assert.equal(obs.durability().enabled, false)
  assert.equal(obs.durability().error, 'observability_store_write_failed')
  assert.deepEqual(obs.history().items.map((event) => event.seq), [1, 2])
  assert.equal(structuredLogs([], obs.history()).items.length, 2)
})

test('G15 structuredLogs 合并持久事件，支持级别/traceId 过滤与完整游标分页', (t) => {
  const dir = tempDir(t)
  const obs = createObservability({ persistFile: join(dir, 'events.jsonl'), now: () => 1700000001000 })
  const requestId = hashId('trace-request')
  obs.recordTerminal({ requestId, terminal: 'FAILED', status: 503, model: 'demo', provider: 'p1' })
  obs.recordAttempt({ requestId, attemptId: hashId('attempt-1'), phase: 'sending', status: 200, model: 'demo', provider: 'p1' })
  const textLines = [
    '[2026-11-25T00:00:00.000Z] [info] started',
    '[2026-11-25T00:00:01.000Z] [error] upstream failed',
  ]
  const all = structuredLogs(textLines, obs.history(), { limit: 1 })
  const ids = []
  let cursor = null
  do {
    const page = structuredLogs(textLines, obs.history(), { limit: 1, cursor })
    assert.equal(page.items.length, 1)
    ids.push(page.items[0].id)
    cursor = page.nextCursor
  } while (cursor)
  assert.equal(new Set(ids).size, 4, '合并后的每一页都不得重复/漏项')
  assert.equal(all.retained.sourceEvents, 2)
  assert.equal(all.retained.durable.enabled, true)

  const traced = structuredLogs(textLines, obs.history(), { q: requestId })
  assert.equal(traced.items.length, 2)
  assert.ok(traced.items.every((item) => item.traceId === requestId && item.id.startsWith('observability:')))
  assert.ok(traced.items.some((item) => item.terminal === 'FAILED' && item.status === 503))
  const errors = structuredLogs(textLines, obs.history(), { level: 'error' })
  assert.ok(errors.items.length >= 2)
  assert.ok(errors.items.every((item) => item.level === 'error'))
})

test('G15 HTTP 重启后结构化日志可查询持久事件，实时事件端点与 SSE 不重放历史', { timeout: 45000 }, async (t) => {
  const upstream = await startMockUpstream()
  const dir = mkdtempSync(join(tmpdir(), 'mg-g15-http-'))
  const file = join(dir, 'observability', 'events.jsonl')
  const config = {
    defaults: { observability: { capacity: 2, maxBytes: 65536, maxRecords: 100 } },
    providers: { mock: { baseUrl: upstream.base } },
    models: { demo: { provider: 'mock', forceNoStream: true } },
  }
  let gateway = await startGateway({ name: 'g15-restart', dir, config })
  t.after(async () => { if (gateway) await gateway.stop(); await upstream.stop(); rmSync(dir, { recursive: true, force: true }) })
  const canaryBody = 'G15-BODY-DO-NOT-PERSIST'
  const canaryKey = 'sk-g15-DO-NOT-PERSIST'
  const rawId = 'raw-request-id-g15'
  const response = await gateway.post('/v1/chat/completions', { model: 'demo', messages: [{ role: 'user', content: canaryBody }] }, { 'x-request-id': rawId, authorization: 'Bearer ' + canaryKey })
  assert.equal(response.status, 200)
  const deadlineForFile = Date.now() + 3000
  while ((!existsSync(file) || !readFileSync(file, 'utf8').includes('"kind":"request"')) && Date.now() < deadlineForFile) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  const before = lines(file)
  const oldRequest = before.find((event) => event.kind === 'request')
  assert.ok(oldRequest && oldRequest.requestId)
  const diskText = readFileSync(file, 'utf8')
  for (const secret of [canaryBody, canaryKey, rawId]) assert.equal(diskText.includes(secret), false)
  assert.equal(statSync(file).mode & 0o777, 0o600)
  await gateway.stop()

  gateway = await startGateway({ name: 'g15-restart', dir, config })
  const livePage = await (await gateway.get('/api/observability/events?limit=10')).json()
  assert.equal(livePage.items.length, 0, '持久历史不得回填实时 ring')
  const persisted = await (await gateway.get('/api/logs/structured?traceId=' + oldRequest.requestId)).json()
  assert.ok(persisted.items.some((item) => item.id === 'observability:' + oldRequest.seq && item.traceId === oldRequest.requestId))
  assert.equal(JSON.stringify(persisted).includes(canaryBody), false)
  assert.equal(JSON.stringify(persisted).includes(canaryKey), false)
  assert.equal(JSON.stringify(persisted).includes(rawId), false)

  const ctl = new AbortController()
  const stream = await fetch(gateway.base + '/api/observability/stream', { headers: { accept: 'text/event-stream' }, signal: ctl.signal })
  assert.equal(stream.status, 200)
  const reader = stream.body.getReader()
  await gateway.post('/v1/chat/completions', { model: 'demo', messages: [{ role: 'user', content: 'next' }] })
  let sse = ''
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && !/event: request/.test(sse)) {
    const chunk = await reader.read()
    if (chunk.done) break
    sse += Buffer.from(chunk.value).toString('utf8')
  }
  ctl.abort()
  void reader.cancel().catch(() => {})
  assert.match(sse, /event: request/)
  assert.equal(sse.includes(oldRequest.requestId), false, 'SSE 只能重放实时 ring，不能重放持久历史')
  const frames = [...sse.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]))
  assert.ok(frames.filter((event) => event.kind === 'request').every((event) => event.seq > oldRequest.seq))

  const paged = await (await gateway.get('/api/logs/structured?limit=1')).json()
  const ids = new Set()
  let cursor = paged.nextCursor
  let pages = 1
  while (cursor && pages < 30) {
    const next = await (await gateway.get('/api/logs/structured?limit=1&cursor=' + encodeURIComponent(cursor))).json()
    assert.equal(next.items.length, 1)
    ids.add(next.items[0].id)
    cursor = next.nextCursor
    pages += 1
  }
  assert.ok(pages >= 2)
})
