// V2-03 / A4：SSE 终态与取消的单一性（离线，纯内存 fake client + 合成上游流，零网络）。
//
// 契约：同一条客户端连接上只允许一个流终态。
//   · 正常完成（收到 [DONE]）→ 恰好一个 [DONE]，之后任何"中断收尾"都不得再写；
//   · 中断/取消/预算中止 → relay 自己不写终态（留给调用方决定切换还是收尾），收尾时恰好一个错误事件 + 一个 [DONE]；
//   · 多条收尾路径交错（取消 + 兜底收尾）→ 仍然只有一个终态，后到者返回 false 而不是再写一遍。
// 这是 Codex 原生压缩/恢复所需的流保真前提：客户端不能在"结束后再收到结束"。
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  relayStream, endInterruptedStream, claimStreamTerminal, streamTerminalOf,
  STREAM_TERMINAL, STREAM_TERMINALS,
} from '../../../src/sse.js'

function fakeClient() {
  const client = new EventEmitter()
  client.writes = []
  client.destroyed = false
  client.writableEnded = false
  client.writableLength = 0
  client.endCalls = 0
  client.write = (chunk) => {
    if (client.writableEnded || client.destroyed) throw new Error('write after end')
    client.writes.push(String(chunk))
    return true
  }
  client.end = () => { client.endCalls += 1; client.writableEnded = true }
  client.destroy = () => { client.destroyed = true; client.emit('close') }
  Object.defineProperty(client, 'text', { get: () => client.writes.join('') })
  return client
}

// 手动可控上游流：支持 async iteration + destroy + error，用来精确制造"中断/取消"。
function manualStream() {
  const chunks = []
  let waiter = null
  let finished = false
  const stream = {
    destroyed: false,
    push(chunk) { chunks.push(chunk); if (waiter) { const w = waiter; waiter = null; w() } },
    finish() { finished = true; if (waiter) { const w = waiter; waiter = null; w() } },
    on() {},
    destroy() { stream.destroyed = true; stream.finish() },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (chunks.length) { yield chunks.shift(); continue }
        if (finished) return
        await new Promise((resolve) => { waiter = resolve })
      }
    },
  }
  return stream
}

// budget 形状与真实 budget.js 一致（relayStream 只消费 timedOut() 与 signal）。
function budgetWith(controller) {
  return { signal: controller.signal, timedOut: () => controller.signal.aborted, cancelled: () => false }
}

const dataFrame = (text) => 'data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n'
const doneCount = (client) => client.text.split('data: [DONE]').length - 1
const errorEventCount = (client) => client.text.split('"type":"stream_interrupted"').length - 1

async function flush() { await new Promise((r) => setImmediate(r)) }

test('完成 + 兜底收尾：只允许一个终态（[DONE] 恰好一次，收尾返回 false）', { timeout: 15000 }, async () => {
  const client = fakeClient()
  const upstream = manualStream()
  const relayed = relayStream(client, upstream, { idleMs: 0, maxReconnects: 0, noEventMs: 0 })
  upstream.push(dataFrame('你好'))
  upstream.push('data: [DONE]\n\n')
  upstream.finish()
  const result = await relayed

  assert.equal(result.completed, true)
  assert.equal(result.terminal, STREAM_TERMINALS.COMPLETED, '结果必须暴露唯一终态')
  assert.equal(doneCount(client), 1, '[DONE] 恰好一次')
  assert.equal(streamTerminalOf(client), STREAM_TERMINALS.COMPLETED)

  // 同一连接上的兜底收尾（旧实现只靠 writableEnded 防重）必须被终态门挡住。
  const wrote = endInterruptedStream(client, '上游流式响应中断', 0)
  assert.equal(wrote, false, '已有完成终态时不得再写中断终态')
  assert.equal(doneCount(client), 1)
  assert.equal(errorEventCount(client), 0, '不得在正常完成后补发错误事件')
})

test('取消/预算中止：relay 不写终态，收尾只写一次，二次收尾被拒绝', { timeout: 15000 }, async () => {
  const client = fakeClient()
  const controller = new AbortController()
  const upstream = manualStream()
  const relayed = relayStream(client, upstream, {
    idleMs: 0, maxReconnects: 0, noEventMs: 0,
    budget: budgetWith(controller), signal: controller.signal,
  })
  upstream.push(dataFrame('部分'))
  await flush()
  controller.abort()
  const result = await relayed

  assert.equal(result.completed, false)
  assert.equal(result.interrupted, true)
  assert.equal(result.timedOut, true, '预算中止必须与客户端断开区分开')
  assert.equal(result.terminal, null, '中断不自行写终态（切/不切由调用方决定）')
  assert.equal(doneCount(client), 0, '中断时不得抢先写 [DONE]')
  assert.equal(streamTerminalOf(client), null, '中断尚未产生终态')
  assert.equal(client.destroyed, false, '预算中止不应销毁客户端连接')
  assert.equal(upstream.destroyed, true, '中止必须掐断上游')

  assert.equal(endInterruptedStream(client, '请求超出整体预算', 0, { code: 'REQUEST_TIMEOUT' }), true, '第一次收尾写出唯一终态')
  assert.equal(doneCount(client), 1)
  assert.equal(errorEventCount(client), 1)
  assert.equal(streamTerminalOf(client), STREAM_TERMINALS.INTERRUPTED)

  // 兜底路径重复收尾（真实接线里 forward 与 index 两层都可能调）：必须是无副作用的 no-op。
  assert.equal(endInterruptedStream(client, '请求超出整体预算', 0, { code: 'REQUEST_TIMEOUT' }), false)
  assert.equal(doneCount(client), 1, '[DONE] 仍恰好一次')
  assert.equal(errorEventCount(client), 1, '错误事件不得重复')
  assert.equal(client.endCalls, 1)
})

test('取消信号（无预算对象）按客户端取消处理：不留终态、不写第二个结束', { timeout: 15000 }, async () => {
  const client = fakeClient()
  const controller = new AbortController()
  const upstream = manualStream()
  const relayed = relayStream(client, upstream, { idleMs: 0, maxReconnects: 0, noEventMs: 0, signal: controller.signal })
  upstream.push(dataFrame('x'))
  await flush()
  controller.abort()
  const result = await relayed

  assert.equal(result.clientGone, true, '取消按客户端离开处理')
  assert.equal(result.timedOut, false, '取消不得记成超时')
  assert.equal(doneCount(client), 0, '取消路径不得写 [DONE] 伪装完成')
  // 客户端连接已按"已断/取消"收尾 → 兜底收尾必须拒绝。
  assert.equal(endInterruptedStream(client, 'canceled', 0), false)
  assert.equal(doneCount(client), 0)
})

test('客户端断开：中断后不再写任何终态帧（避免写已断连接）', { timeout: 15000 }, async () => {
  const client = fakeClient()
  const upstream = manualStream()
  const relayed = relayStream(client, upstream, { idleMs: 0, maxReconnects: 0, noEventMs: 0 })
  upstream.push(dataFrame('head'))
  await flush()
  const before = client.writes.length
  client.emit('close')
  upstream.finish()
  const result = await relayed

  assert.equal(result.clientGone, true)
  assert.equal(result.completed, false)
  assert.equal(client.writes.length, before, 'close 之后不得再写任何帧')
  assert.equal(doneCount(client), 0)
})

test('换上游继续写同一连接：前一跳中断不留终态，最终完成仍只有一个 [DONE]', { timeout: 15000 }, async () => {
  const client = fakeClient()
  const first = manualStream()
  const firstRelayed = relayStream(client, first, { idleMs: 0, maxReconnects: 0, noEventMs: 0 })
  first.push(dataFrame('a'))
  await flush()
  first.destroy()
  first.finish()
  const firstResult = await firstRelayed
  assert.equal(firstResult.interrupted, true)
  assert.equal(firstResult.terminal, null, '中断跳不得占用终态')
  assert.equal(doneCount(client), 0)

  // 调用方决定切下一上游：同一条连接上继续写，最终正常完成。
  const second = manualStream()
  const secondRelayed = relayStream(client, second, { idleMs: 0, maxReconnects: 0, noEventMs: 0 })
  second.push(dataFrame('b'))
  second.push('data: [DONE]\n\n')
  second.finish()
  const secondResult = await secondRelayed
  assert.equal(secondResult.completed, true)
  assert.equal(secondResult.terminal, STREAM_TERMINALS.COMPLETED)
  assert.equal(doneCount(client), 1, '整条连接上只有一个 [DONE]')
  assert.equal(client.text.includes('"a"'), true)
  assert.equal(client.text.includes('"b"'), true)
})

test('终态门本身：先到者胜、不可改写、不参与序列化', () => {
  const client = {}
  assert.equal(streamTerminalOf(client), null)
  assert.equal(claimStreamTerminal(client, STREAM_TERMINALS.INTERRUPTED), true)
  assert.equal(claimStreamTerminal(client, STREAM_TERMINALS.COMPLETED), false, '后到者必须被拒绝')
  assert.equal(streamTerminalOf(client), STREAM_TERMINALS.INTERRUPTED, '终态不可被覆盖')
  assert.equal(Object.keys(client).includes(String(STREAM_TERMINAL)), false, '终态标记不参与枚举/序列化')
  assert.equal(JSON.stringify(client), '{}')
  // 冻结/不可扩展对象：不抛错，只是拒绝（调用方按"已有终态"处理）。
  const frozen = Object.freeze({})
  assert.equal(claimStreamTerminal(frozen, STREAM_TERMINALS.COMPLETED), false)
})
