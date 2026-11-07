// 合并回归：本地 main 17 个硬化提交与本分支 G1/G2 共存后的关键行为。
// 覆盖：baseUrl /v1 归一、max_tokens 归一化、per-model protocol、thinking 整形、
//       上游侧 4xx/402 继续目录链、providerModels/upstreamModel、gzip 解压与 gzip 炸弹上限。
import { gzipSync } from 'node:zlib'
import { startGateway, mockUpstream, check, summary, CLIENT } from './harness.mjs'

let mode = 'ok'
const seen = []
const up = await mockUpstream((req, res, body) => {
  const j = JSON.parse(body || '{}')
  seen.push({ url: req.url, body: j, headers: req.headers })
  if (req.url.endsWith('/v1/messages')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ model: j.model, content: [{ type: 'text', text: 'anthropic-ok' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 2 } }))
    return
  }
  if (mode === 'gzip') {
    const payload = gzipSync(Buffer.from(JSON.stringify({ model: j.model, choices: [{ message: { role: 'assistant', content: 'gz' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } })))
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
    res.end(payload)
    return
  }
  if (mode === 'bomb') {
    // 40MB 全零 → 压缩后约 40KB；解压上限 32MB 应拒绝而不是 OOM
    const payload = gzipSync(Buffer.alloc(40 * 1024 * 1024, 0))
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
    res.end(payload)
    return
  }
  if ((mode === '402' || mode === 'upstream400') && j.model === 'm-src') {
    const code = mode === '402' ? 402 : 400
    const msg = mode === '402' ? 'payment required' : 'upstream_error: inference request failed, please try again later'
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: msg } }))
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ model: j.model, choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
})

const gw = await startGateway({
  defaults: { retry: { maxAttempts: 1, initialDelayMs: 10, maxDelayMs: 20 }, directory: [{ model: 'm-ok', mode: 'afterAll' }] },
  providers: { p1: { baseUrl: up.url, apiKeyEnv: '', api: 'openai' }, p2: { baseUrl: up.url, apiKeyEnv: '', api: 'openai' } },
  models: {
    'm-plain': { provider: 'p1' },
    'm-cap': { provider: 'p1', maxTokensMax: 1000 },
    'm-think': { provider: 'p1', effortFormat: 'thinking' },
    'm-anth': { provider: 'p1', api: 'anthropic' },
    'm-ovr': { provider: 'p1', providerModels: { p1: 'actual-upstream-id' } },
    'm-um': { provider: 'p1', upstreamModel: 'upstream-id-2' },
    'm-src': { provider: 'p1' },
    'm-ok': { provider: 'p2' },
    'm-gzip': { provider: 'p1' },
    'm-bomb': { provider: 'p1' },
  },
})
const chat = (body) => fetch(gw.base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + CLIENT }, body: JSON.stringify(body) })
const msg = { role: 'user', content: 'x' }

// 1. baseUrl 带 /v1 不双拼
const baseV1 = await startGateway({ providers: { pv1: { baseUrl: up.url + '/v1', apiKeyEnv: '', api: 'openai' } }, models: { 'm-v1': { provider: 'pv1' } } })
const r1 = await baseV1.chat({ model: 'm-v1', messages: [msg] })
check('baseUrl 以 /v1 结尾不产生 /v1/v1 双拼', r1.status === 200 && seen.some(s => s.url === '/v1/chat/completions'), { status: r1.status, urls: seen.map(s => s.url).slice(-2) })
await baseV1.close()

// 2. max_tokens 非法值删除
seen.length = 0
const r2 = await chat({ model: 'm-plain', messages: [msg], max_tokens: 0 })
check('max_tokens=0 被删除而非透传', r2.status === 200 && seen[0].body.max_tokens === undefined, { max: seen[0] && seen[0].body.max_tokens })

// 3. max_tokens 按模型上限钳制
seen.length = 0
const r3 = await chat({ model: 'm-cap', messages: [msg], max_tokens: 999999 })
check('max_tokens 按 maxTokensMax 钳制', r3.status === 200 && seen[0].body.max_tokens === 1000, { max: seen[0] && seen[0].body.max_tokens })

// 4. thinking 形态整形（high → enabled）
seen.length = 0
const r4 = await chat({ model: 'm-think', messages: [msg], reasoning_effort: 'high' })
check('thinking 模型收到 thinking.type=enabled 且无 reasoning_effort', r4.status === 200 && seen[0].body.thinking && seen[0].body.thinking.type === 'enabled' && seen[0].body.reasoning_effort === undefined, { body: seen[0] && seen[0].body })

// 5. per-model protocol：同上游 anthropic 只改模型配置
seen.length = 0
const r5 = await chat({ model: 'm-anth', messages: [{ role: 'system', content: 'sys' }, msg] })
const j5 = await r5.json()
check('models.api=anthropic 走到 /v1/messages 并转回 OpenAI', r5.status === 200 && seen[0].url.endsWith('/v1/messages') && seen[0].body.system === 'sys' && j5.choices[0].message.content === 'anthropic-ok', { url: seen[0] && seen[0].url, status: r5.status })

// 6. providerModels / upstreamModel 覆盖
seen.length = 0
const r6 = await chat({ model: 'm-ovr', messages: [msg] })
const r6b = await chat({ model: 'm-um', messages: [msg] })
check('providerModels[pid] 优先于 upstreamModel', seen[0].body.model === 'actual-upstream-id' && seen[1].body.model === 'upstream-id-2', { models: seen.map(s => s.body.model) })

// 7. 402 继续目录链
mode = '402'; seen.length = 0
const r7 = await chat({ model: 'm-src', messages: [msg] })
const j7 = await r7.json()
check('402 继续目录链并成功', r7.status === 200 && j7.model === 'm-src', { status: r7.status, model: j7.model })

// 8. 上游侧 4xx（语义为上游出错）继续目录链
mode = 'upstream400'; seen.length = 0
const r8 = await chat({ model: 'm-src', messages: [msg] })
check('上游侧 4xx 继续目录链并成功', r8.status === 200, { status: r8.status })

// 9. gzip 响应正常解压
mode = 'gzip'; seen.length = 0
const r9 = await chat({ model: 'm-gzip', messages: [msg] })
const j9 = await r9.json()
check('gzip 响应解压后正常解析', r9.status === 200 && j9.choices[0].message.content === 'gz', { status: r9.status })

// 10. gzip 炸弹被上限拒绝（不 OOM、不假成功）
mode = 'bomb'; seen.length = 0
const t0 = Date.now()
const r10 = await chat({ model: 'm-bomb', messages: [msg] })
const ms = Date.now() - t0
check('gzip 解压超上限被拒绝（502）且不假成功', r10.status === 502 && ms < 5000, { status: r10.status, ms })

await gw.close()
await up.close()
export { summary }
