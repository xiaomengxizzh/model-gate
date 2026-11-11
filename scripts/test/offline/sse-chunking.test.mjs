// M1-2（T-SSE-01）：SSE 帧解码与中继的字节/行边界、有界拒绝。
// 纯进程内 Readable + 假客户端，不启动网关、不触真实上游。
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createSSEFrameDecoder, MAX_SSE_FRAME_BYTES, normalizeSseFrame, relayStream } from '../../../src/sse.js'

function fakeClient() {
  const client = new EventEmitter()
  client.writes = []
  client.destroyed = false
  client.writableEnded = false
  client.writableLength = 0
  client.write = (chunk) => { client.writes.push(String(chunk)); return true }
  client.end = () => { client.writableEnded = true }
  client.destroy = () => { client.destroyed = true; client.emit('close') }
  return client
}

function source(chunks) {
  let i = 0
  return {
    destroyed: false,
    destroy() { this.destroyed = true },
    async *[Symbol.asyncIterator]() {
      for (; i < chunks.length; i++) {
        if (this.destroyed) return
        yield chunks[i]
      }
    },
  }
}

function chatFrames(text) {
  return String(text).split('\n\n').filter((b) => b.trim() !== '').map((block) => {
    const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n')
    return data
  })
}

// ============================================================================
// 解码器：UTF-8 跨 chunk / CRLF 与 LF 混用 / 有界 / 不完整尾部
// ============================================================================
test('T-SSE-01a UTF-8 多字节字符被任意字节边界切开仍正确解码（emoji/中文分 3 段喂入）', () => {
  const payload = Buffer.from('data: {"t":"你好😀"}\n\n', 'utf8')
  // emoji 4 字节；按 3 段切在字符中间（选择落在多字节序列内部的边界）
  const cuts = [0, 16, 18, payload.length]
  const decoder = createSSEFrameDecoder()
  const frames = []
  for (let i = 0; i < cuts.length - 1; i++) frames.push(...decoder.push(payload.subarray(cuts[i], cuts[i + 1])))
  assert.deepEqual(frames, ['data: {"t":"你好😀"}'], '跨 chunk 的多字节字符不得乱码')
  assert.equal(decoder.flush(), '', '完整帧后无残留')

  // 更极端：逐字节喂入
  const oneByOne = createSSEFrameDecoder()
  const out = []
  for (let i = 0; i < payload.length; i++) out.push(...oneByOne.push(payload.subarray(i, i + 1)))
  assert.deepEqual(out, ['data: {"t":"你好😀"}'], '逐字节喂入也不得丢字符')
})

test('T-SSE-01b 帧边界：\r\n / \n / \r 及其混用都识别为空行', () => {
  const decoder = createSSEFrameDecoder()
  const frames = decoder.push('event: a\r\ndata: 1\r\n\r\ndata: 2\n\ndata: 3\r\rdata: 4\n\r\n')
  assert.deepEqual(frames, ['event: a\ndata: 1', 'data: 2', 'data: 3', 'data: 4'], 'CRLF/LF/CR 混用必须逐个成帧')
  assert.equal(normalizeSseFrame('event: x\r\ndata: 1\r'), 'event: x\ndata: 1\n', '帧内行终止符统一为 LF')
})

test('T-SSE-01c 多帧同 chunk / 边界跨 chunk：按到达顺序产出，不合并、不丢帧', () => {
  const decoder = createSSEFrameDecoder()
  const first = decoder.push('data: 1\n\ndata: 2\n\nda')
  assert.deepEqual(first, ['data: 1', 'data: 2'])
  const second = decoder.push('ta: 3\n\r\n')
  assert.deepEqual(second, ['data: 3'])
  assert.equal(decoder.bufferedBytes, 0)
})

test('T-SSE-01d 单帧超长被有界拒绝（不进入无界缓冲），失败后不可继续使用', () => {
  const decoder = createSSEFrameDecoder({ maxFrameBytes: 32 })
  assert.throws(
    () => decoder.push(Buffer.from('data: ' + 'x'.repeat(64) + '\n\n')),
    (err) => err && err.code === 'SSE_FRAME_TOO_LARGE' && err.bytes > 32,
    '超过 maxFrameBytes 必须抛 SSE_FRAME_TOO_LARGE',
  )
  assert.ok(decoder.failed, '失败状态可观测')
  assert.throws(() => decoder.push('data: ok\n\n'), (err) => err.code === 'SSE_FRAME_TOO_LARGE', '失败后不得静默恢复')
})

test('T-SSE-01e 未闭合缓冲超长被有界拒绝；不完整尾部 flush 不合成半截帧', () => {
  const bounded = createSSEFrameDecoder({ maxBufferBytes: 32 })
  assert.throws(() => bounded.push('data: ' + 'y'.repeat(64)), (err) => err && err.code === 'SSE_FRAME_TOO_LARGE')

  const decoder = createSSEFrameDecoder()
  assert.deepEqual(decoder.push('data: partial'), [], '没有空行时不得产出帧')
  assert.equal(decoder.flush(), 'data: partial', 'flush 返回未闭合尾部供调用方按中断处理')
  assert.equal(MAX_SSE_FRAME_BYTES > 0, true)
})

// ============================================================================
// relayStream 集成：字节边界 + CRLF + 有界拒绝
// ============================================================================
test('T-SSE-01f relayStream：UTF-8/CRLF 跨 chunk 的 Chat 流逐事件中继，内容完整且 [DONE] 一次', { timeout: 15000 }, async () => {
  const raw = Buffer.from(
    'data: ' + JSON.stringify({ choices: [{ delta: { content: '你好😀' } }] }) + '\r\n\r\n' +
    'data: ' + JSON.stringify({ choices: [{ delta: { content: '尾' } }] }) + '\n\n' +
    'data: [DONE]\r\n\r\n',
    'utf8',
  )
  const chunks = []
  for (let i = 0; i < raw.length; i += 7) chunks.push(raw.subarray(i, Math.min(i + 7, raw.length)))
  const client = fakeClient()
  const result = await relayStream(client, source(chunks), { idleMs: 0, maxReconnects: 0, noEventMs: 0 })
  assert.equal(result.completed, true, '收到 [DONE] 即为正常完成')
  assert.equal(result.interrupted, false)
  const payloads = chatFrames(client.writes.join('')).filter((d) => d !== '[DONE]')
  const text = payloads.map((d) => JSON.parse(d).choices[0].delta.content || '').join('')
  assert.equal(text, '你好😀尾', '跨 chunk 的中文/emoji 内容必须完整')
  assert.equal(chatFrames(client.writes.join('')).filter((d) => d === '[DONE]').length, 1, '[DONE] 恰好一次')
})

test('T-SSE-01g relayStream：单帧超限 → 一次中断终态、不续传、销毁上游', { timeout: 15000 }, async () => {
  const big = 'data: ' + 'z'.repeat(MAX_SSE_FRAME_BYTES + 1024) + '\n\n'
  const upstream = source([Buffer.from(big)])
  const client = fakeClient()
  const result = await relayStream(client, upstream, { idleMs: 0, maxReconnects: 3, noEventMs: 0 })
  assert.equal(result.completed, false, '超限帧不得视为完成')
  assert.equal(result.interrupted, true, '超限必须产生一次中断终态')
  assert.equal(result.reconnects, 0, '有界拒绝不得重连/重放')
  assert.equal(upstream.destroyed, true, '必须销毁上游流')
  assert.equal(client.writes.join('').includes('z'.repeat(1024)), false, '不得把超长帧写给客户端')
})
