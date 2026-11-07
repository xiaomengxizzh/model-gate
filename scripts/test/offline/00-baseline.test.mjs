// G0/G1 基线回归：鉴权、/v1/models、Chat 非流式/流式、错误信封、trace 头。
import { startGateway, mockUpstream, check, summary, readSse, sseStart, sseWrite, ADMIN, CLIENT } from './harness.mjs'

const up = await mockUpstream((req, res, body) => {
  const j = JSON.parse(body)
  if (j.stream) {
    sseStart(res)
    sseWrite(res, { id: 'c1', object: 'chat.completion.chunk', model: j.model, choices: [{ index: 0, delta: { role: 'assistant', content: '你' } }] })
    sseWrite(res, { id: 'c1', object: 'chat.completion.chunk', model: j.model, choices: [{ index: 0, delta: { content: '好' } }] })
    sseWrite(res, { id: 'c1', object: 'chat.completion.chunk', model: j.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })
    sseWrite(res, '[DONE]')
    res.end()
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ id: 'c1', object: 'chat.completion', model: j.model, choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } }))
})

const gw = await startGateway({
  providers: { mock: { baseUrl: up.url, apiKeyEnv: '', api: 'openai' } },
  models: {
    'm-good': { provider: 'mock', alias: ['alias-good'] },
    'm-bad': { provider: 'mock', alias: [] },
  },
})

// 1. 管理鉴权
const noAuth = await fetch(gw.base + '/api/status')
check('管理面无令牌 401', noAuth.status === 401, { status: noAuth.status })
const st = await (await gw.adminFetch('/api/status')).json()
check('管理面带令牌 200 且含 configVersion', typeof st.configVersion === 'number', { cv: st.configVersion })

// 2. 数据面鉴权
const badKey = await fetch(gw.base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-key' }, body: JSON.stringify({ model: 'm-good', messages: [] }) })
check('数据面错误 Key 401', badKey.status === 401, { status: badKey.status })

// 3. 模型列表（能力字段）
const models = await (await fetch(gw.base + '/v1/models', { headers: { authorization: 'Bearer ' + CLIENT } })).json()
check('/v1/models 暴露 capabilities/wire', Array.isArray(models.data) && models.data.every(m => m.capabilities && m.wire), { ids: (models.data || []).map(m => m.id) })

// 4. 非流式 Chat 回归
const r1 = await gw.chat({ model: 'm-good', messages: [{ role: 'user', content: 'hi' }] })
const j1 = await r1.json()
check('Chat 非流式 200 + usage', r1.status === 200 && j1.choices && j1.usage.total_tokens === 5, { status: r1.status })
check('Chat 响应带 x-mg-trace-id', !!r1.headers.get('x-mg-trace-id'), { trace: r1.headers.get('x-mg-trace-id') })

// 5. 流式 Chat 回归（含 [DONE]）
const r2 = await gw.chat({ model: 'alias-good', stream: true, messages: [{ role: 'user', content: 'hi' }] })
const { text, events } = await readSse(r2)
const deltas = events.filter(e => e.data && e.data.choices && e.data.choices[0] && e.data.choices[0].delta && e.data.choices[0].delta.content)
check('Chat 流式 200 + 内容 delta + [DONE]', r2.status === 200 && deltas.length === 2 && /\[DONE\]/.test(text), { deltas: deltas.length })

// 6. 未知模型（无虚拟模型时走默认上游，不应 404；这里只验证不 500）
const r3 = await gw.chat({ model: 'nope', messages: [{ role: 'user', content: 'x' }] })
check('未知模型且无默认上游 → 400（非 5xx）', r3.status === 400, { status: r3.status })

// 7. Responses 入口存在且方法受限
const m = await fetch(gw.base + '/v1/responses', { method: 'GET', headers: { authorization: 'Bearer ' + CLIENT } })
check('Responses 非 POST → 405', m.status === 405, { status: m.status, allow: m.headers.get('allow') })

check('上游只收到合法请求 2 次（未知模型未转发）', up.hits.length === 2, { hits: up.hits.length })

await gw.close()
await up.close()
