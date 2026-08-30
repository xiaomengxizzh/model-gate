// 半死流看门狗契约：上游以 SSE 注释心跳续命却从不发 data 事件时，
// noEventMs（默认 idleMs 两倍）内必须判死并给客户端 OpenAI 兼容错误事件——
// 此前字节级 idle 被注释喂活、keepalive 注释又喂活客户端空闲检测，会无限悬挂（生产 08-30 09:43-09:48 实录）。
// 同时验证：注释心跳 + 正常 data 交替的健康流不得误杀。
import http from 'node:http'
import { GW, check, snapshot, save, chat, streamDeltaText } from './utils.mjs'

// 场景1：纯注释心跳（半死流）
const up1 = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const t = setInterval(() => { try { res.write(': ping\n\n') } catch {} }, 250)
  res.on('close', () => clearInterval(t))
})
await new Promise(r => up1.listen(0, () => r()))

const base = await snapshot()
const origIdle = base.defaults.timeout ? base.defaults.timeout.idleMs : 60000
base.defaults.timeout = Object.assign({}, base.defaults.timeout, { idleMs: 600 }) // 字节 idle 0.6s（被注释喂活），事件看门狗 1.2s
base.providers['t-hang'] = { baseUrl: `http://127.0.0.1:${up1.address().port}`, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai' }
base.models['t-hang-m'] = { provider: 't-hang', alias: [], fallbacks: [], maxConcurrent: 0 }
await save(base.providers, base.models, base.defaults)

const started = Date.now()
const text = await (await chat('t-hang-m', true)).text()
const ms = Date.now() - started
check('半死流·无事件看门狗判死并回错误事件', text.includes('"stream_interrupted"'), { ms, tail: text.slice(-140) })
check('半死流·有限时间内结束（<15s，此前无限悬挂）', ms < 15000, { ms })

// 场景2：注释心跳 + 正常 data 交替 → 不得误杀
const up2 = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  let i = 0
  const t = setInterval(() => {
    i++
    if (i > 10) { clearInterval(t); res.write('data: [DONE]\n\n'); res.end(); return }
    res.write(': ka\n\n')
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'ab' } }] }) + '\n\n')
  }, 120)
  res.on('close', () => clearInterval(t))
})
await new Promise(r => up2.listen(0, () => r()))
base.providers['t-hang2'] = { baseUrl: `http://127.0.0.1:${up2.address().port}`, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai' }
base.models['t-hang2-m'] = { provider: 't-hang2', alias: [], fallbacks: [], maxConcurrent: 0 }
await save(base.providers, base.models, base.defaults)
const text2 = await (await chat('t-hang2-m', true)).text()
check('健康心跳流·不误杀且内容完整', streamDeltaText(text2) === 'ab'.repeat(10) && !text2.includes('stream_interrupted'), { len: text2.length })

// 清理：摘除测试上游、恢复 idleMs（合并语义下显式覆盖即可复原）
const after = await snapshot()
delete after.providers['t-hang']; delete after.providers['t-hang2']
delete after.models['t-hang-m']; delete after.models['t-hang2-m']
after.defaults.timeout.idleMs = origIdle == null ? 60000 : origIdle
await save(after.providers, after.models, after.defaults)
await new Promise(r => up1.close(r)); await new Promise(r => up2.close(r))
