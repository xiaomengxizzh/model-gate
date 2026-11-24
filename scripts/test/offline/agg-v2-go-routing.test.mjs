// V2-02 / A2：Go 单模型请求路由与「绝不静默换模型/换供应商」回归（离线，全 mock）。
//
// 只连本机 mock 上游：不触达 opencode.ai，不读宿主凭据（provider 只贴合成 Key，值不落盘）。
// 证明：
//   1. 聚合公共 ID（mg-opencodego-deepseek-v4-1-flash）请求 → 上游 host/path/出站 model 正确；
//   2. x-opencode-session 由本服务派生，绝不转发客户端原始 thread/session id；
//   3. Responses 路径打到 Go 的 /responses 入口，仍带派发会话头与真实模型名；
//   4. 上游 4xx 不换供应商、不换模型（fallback 上游零命中），failurePolicy 给稳定 code；
//   5. 未声明的聚合保留 ID / 无凭据 → 显式 typed 拒绝且零上游命中；
//   6. readiness() 的 typed code 与运行期行为方向一致（凭据缺失 ≠ 静默继承）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { startGateway, startScriptedUpstream } from './harness.mjs'
import {
  GO_PRESET_BASE_URL,
  GO_READY_CODES,
  SERVICE_UA,
  SESSION_HEADER,
  V2_TARGET_PUBLIC_ID,
  V2_TARGET_UPSTREAM_MODEL,
  failurePolicy,
  identityOf,
  readiness,
} from '../../../src/providers/opencode-go.js'

const BASE_CATALOG = fileURLToPath(new URL('../fixtures/agg-a2/base-catalog.json', import.meta.url))
const SYNTH_ENV = 'SYNTH_V2_GO_KEY'
const SYNTH_KEY = 'sk-synthetic-offline-not-a-real-key'

function jsonHandler(hits, respond) {
  return async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    hits.push({ url: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
    return respond(req, res, hits[hits.length - 1])
  }
}

function chatOk(res) {
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({
    id: 'chatcmpl-mock', object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  }))
}

// 隔离网关：Go provider 指向本地 mock；公共 ID 通过官方基线目录 + config.models 生成绑定。
function gatewayConfig(goBase, extra = {}) {
  return Object.assign({
    defaults: {
      retry: { maxAttempts: 1 },
      timeout: { firstByteMs: 3000, idleMs: 3000, loopMs: 3000 },
      proxyMode: 'direct',
      codexCatalogBasePath: BASE_CATALOG,
    },
    providers: {
      opencodego: { baseUrl: goBase + '/inference/go/openai/v1', api: 'openai', apiKeyEnv: SYNTH_ENV, opencodeGoVersion: 'go-v1' },
    },
    models: {
      [V2_TARGET_UPSTREAM_MODEL]: {
        provider: 'opencodego',
        api: 'openai',
        providerModels: { opencodego: V2_TARGET_UPSTREAM_MODEL },
        alias: [V2_TARGET_PUBLIC_ID],
      },
    },
  }, extra)
}

test('请求级身份：公共 ID → Go 上游正确 host/path/出站 model/派生会话头', { timeout: 30000 }, async (t) => {
  const hits = []
  const up = await startScriptedUpstream(jsonHandler(hits, (req, res) => chatOk(res)))
  const gw = await startGateway({ config: gatewayConfig(up.base), env: { [SYNTH_ENV]: SYNTH_KEY } })
  t.after(async () => { await gw.stop(); await up.stop() })

  const res = await gw.post('/v1/chat/completions', {
    model: V2_TARGET_PUBLIC_ID,
    messages: [{ role: 'user', content: 'hi' }],
  }, { 'session-id': 'codex-raw-thread-77', 'thread-id': 'codex-raw-thread-77' })
  assert.equal(res.status, 200)
  assert.equal(hits.length, 1, '必须只打一次 Go 上游')

  const hit = hits[0]
  assert.equal(hit.url, '/inference/go/openai/v1/chat/completions')
  const body = JSON.parse(hit.body)
  assert.equal(body.model, V2_TARGET_UPSTREAM_MODEL, '上游必须收到真实模型名')
  assert.notEqual(body.model, V2_TARGET_PUBLIC_ID, '公共 ID 绝不外发')
  assert.equal(hit.headers['user-agent'], SERVICE_UA, 'UA 必须是本服务，不冒用客户端')
  assert.match(String(hit.headers[SESSION_HEADER]), /^[A-Za-z0-9_-]{32}$/, '会话头必须存在且为派生值')
  assert.notEqual(hit.headers[SESSION_HEADER], 'codex-raw-thread-77')
  assert.equal(hit.headers['session-id'], undefined, '不转发客户端原始 session-id')
  assert.equal(hit.headers['thread-id'], undefined, '不转发客户端原始 thread-id')
  assert.equal(hit.headers.authorization, 'Bearer ' + SYNTH_KEY)

  // 同一线程第二轮保持同一派生会话（会话亲和），但仍不是原始 id。
  const again = await gw.post('/v1/chat/completions', {
    model: V2_TARGET_PUBLIC_ID,
    messages: [{ role: 'user', content: 'again' }],
  }, { 'thread-id': 'codex-raw-thread-77' })
  assert.equal(again.status, 200)
  assert.equal(hits.length, 2)
  assert.equal(hits[1].headers[SESSION_HEADER], hit.headers[SESSION_HEADER], '同线程必须稳定')
})

test('Responses 路由：公开 ID → Go /responses 入口，带派发会话头与真实 model', { timeout: 30000 }, async (t) => {
  const hits = []
  const up = await startScriptedUpstream(jsonHandler(hits, (req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({
      id: 'resp_mock', object: 'response', status: 'completed',
      model: V2_TARGET_UPSTREAM_MODEL,
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
      usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
    }))
  }))
  const gw = await startGateway({
    config: gatewayConfig(up.base, {
      models: {
        [V2_TARGET_UPSTREAM_MODEL]: {
          provider: 'opencodego',
          api: 'responses',
          providerModels: { opencodego: V2_TARGET_UPSTREAM_MODEL },
          alias: [V2_TARGET_PUBLIC_ID],
        },
      },
    }),
    env: { [SYNTH_ENV]: SYNTH_KEY },
  })
  t.after(async () => { await gw.stop(); await up.stop() })

  const res = await gw.post('/v1/responses', {
    model: V2_TARGET_PUBLIC_ID,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
  }, { 'thread-id': 'codex-raw-thread-88' })
  assert.equal(res.status, 200)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].url, '/inference/go/openai/v1/responses', 'Responses 必须走 Go 的 responses 入口')
  assert.equal(JSON.parse(hits[0].body).model, V2_TARGET_UPSTREAM_MODEL)
  assert.match(String(hits[0].headers[SESSION_HEADER]), /^[A-Za-z0-9_-]{32}$/)
  assert.equal(hits[0].headers['thread-id'], undefined)
})

test('Codex Go Chat 接受旧配置的工具声明和增量工具结果', { timeout: 30000 }, async (t) => {
  const hits = []
  const up = await startScriptedUpstream(jsonHandler(hits, (_req, res) => {
    if (hits.length > 1) return chatOk(res)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({
      choices: [{
        message: { role: 'assistant', tool_calls: [{
          id: 'call_arithmetic', type: 'function',
          function: { name: 'calculate', arguments: '{}' },
        }] },
        finish_reason: 'tool_calls',
      }],
    }))
  }))
  const config = gatewayConfig(up.base)
  config.models[V2_TARGET_UPSTREAM_MODEL] = { provider: 'opencodego', maxContext: 1000000 }
  config.models['other-go-model'] = { provider: 'opencodego', maxContext: 1000000 }
  const gw = await startGateway({ config, env: { [SYNTH_ENV]: SYNTH_KEY } })
  t.after(async () => { await gw.stop(); await up.stop() })

  const tools = [{ type: 'function', name: 'calculate', parameters: { type: 'object', properties: {} } }]
  const first = await gw.post('/v1/responses', { model: V2_TARGET_PUBLIC_ID, input: '17 * 19', tools })
  const result = await first.json()
  assert.equal(first.status, 200, JSON.stringify(result))
  assert.match(result.id, /^resp_mgchat_/)
  const second = await gw.post('/v1/responses', {
    model: V2_TARGET_PUBLIC_ID, previous_response_id: result.id, tools,
    input: [{ type: 'function_call_output', call_id: 'call_arithmetic', output: '323' }],
  })
  assert.equal(second.status, 200, await second.text())
  assert.equal(hits.length, 2)
  const body = JSON.parse(hits[1].body)
  assert.equal(body.model, V2_TARGET_UPSTREAM_MODEL)
  assert.equal(body.messages.find((message) => message.role === 'assistant').tool_calls[0].id, 'call_arithmetic')
  assert.deepEqual(body.messages.find((message) => message.role === 'tool'),
    { role: 'tool', tool_call_id: 'call_arithmetic', content: '323' })

  const catalog = await (await gw.get('/v1/models?client_version=0.170.0')).json()
  for (const slug of [V2_TARGET_PUBLIC_ID, 'deepseekv4.1flash']) {
    assert.equal(catalog.models.find((model) => model.slug === slug)?.shell_type, 'unified_exec')
  }
  const remote = await gw.post('/v1/responses', {
    model: 'deepseekv4.1flash', previous_response_id: result.id,
    input: [{ type: 'compaction_trigger' }],
  })
  assert.equal(remote.status, 400)
  assert.equal((await remote.json()).error.code, 'native_compaction_route_not_ready')
  assert.equal(hits.length, 2, '远程压缩标记不能进入 Go Chat 上游')
  const other = await gw.post('/v1/responses', { model: 'mg-opencodego-other-go-model', input: '17 * 19', tools })
  assert.equal(other.status, 502)
  assert.equal((await other.json()).error.code, 'MG_FB_NO_CANDIDATE')
  assert.equal(hits.length, 2, '未声明能力的其他模型不能继承目标模型的工具能力')
})

test('上游 4xx：不换供应商/不换模型，fallback 上游零命中', { timeout: 30000 }, async (t) => {
  const goHits = []
  const otherHits = []
  const go = await startScriptedUpstream(jsonHandler(goHits, (req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end('{"error":{"message":"invalid request body"}}')
  }))
  const other = await startScriptedUpstream(jsonHandler(otherHits, (req, res) => chatOk(res)))
  const gw = await startGateway({
    config: gatewayConfig(go.base, {
      providers: {
        opencodego: { baseUrl: go.base + '/inference/go/openai/v1', api: 'openai', apiKeyEnv: SYNTH_ENV },
        otherprov: { baseUrl: other.base, api: 'openai', apiKeyEnv: SYNTH_ENV },
      },
      models: {
        [V2_TARGET_UPSTREAM_MODEL]: {
          provider: 'opencodego',
          fallbacks: ['otherprov'],
          api: 'openai',
          providerModels: { opencodego: V2_TARGET_UPSTREAM_MODEL, otherprov: V2_TARGET_UPSTREAM_MODEL },
          alias: [V2_TARGET_PUBLIC_ID],
        },
      },
    }),
    env: { [SYNTH_ENV]: SYNTH_KEY },
  })
  t.after(async () => { await gw.stop(); await go.stop(); await other.stop() })

  const res = await gw.post('/v1/chat/completions', {
    model: V2_TARGET_PUBLIC_ID,
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(res.status, 400, '上游业务错误必须原样按错误返回')
  assert.equal(goHits.length, 1)
  assert.equal(otherHits.length, 0, '4xx 绝不切到别的供应商/模型（含 GPT）')
  assert.equal(goHits[0].headers.authorization, 'Bearer ' + SYNTH_KEY)

  // 同一失败在适配层的稳定归因 + 禁止降级标记。
  const policy = failurePolicy(400, 'invalid request body', {}, { model: V2_TARGET_UPSTREAM_MODEL })
  assert.equal(policy.code, 'opencodego_bad_request')
  assert.equal(policy.terminal, true)
  assert.equal(policy.allowProviderSwitch, false)
  assert.equal(policy.allowModelSwitch, false)
  assert.equal(policy.fallback, 'forbidden')
})

test('429/401：可归因；V2 配置禁止跨供应商 fallbacks（配置层 fail-closed）', { timeout: 30000 }, async (t) => {
  const goHits = []
  const otherHits = []
  let status = 429
  const go = await startScriptedUpstream(jsonHandler(goHits, (req, res) => {
    res.writeHead(status, { 'content-type': 'application/json', 'retry-after': '0' })
    res.end(status === 401 ? '{"error":{"message":"invalid key sk-synthetic-aaaaaaaa"}}' : '{"error":{"message":"slow down"}}')
  }))
  const other = await startScriptedUpstream(jsonHandler(otherHits, (req, res) => chatOk(res)))
  // V2 正确配置：Go 目标模型**不声明**跨供应商 fallbacks（catalog 会对跨供应商配置 fail-closed）。
  const gw = await startGateway({ config: gatewayConfig(go.base), env: { [SYNTH_ENV]: SYNTH_KEY } })
  t.after(async () => { await gw.stop(); await go.stop(); await other.stop() })

  const r429 = await gw.post('/v1/chat/completions', { model: V2_TARGET_PUBLIC_ID, messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(r429.status, 429)
  assert.ok(goHits.length >= 1, '429 只允许在同一 Go 上游上重试')
  assert.equal(otherHits.length, 0, '限流不得切换到其他供应商')

  status = 401
  const r401 = await gw.post('/v1/chat/completions', { model: V2_TARGET_PUBLIC_ID, messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(r401.status, 401)
  assert.equal(otherHits.length, 0, '鉴权失败不得切换到其他供应商')
  const text = await r401.text()
  assert.equal(text.includes('sk-synthetic-aaaaaaaa'), false, '错误正文不得回显凭据')

  const p429 = failurePolicy(429, 'slow down', { 'retry-after': '1' })
  assert.equal(p429.code, 'opencodego_rate_limited')
  assert.equal(p429.allowProviderSwitch, false)
  assert.equal(p429.allowRetrySameModel, true, '只允许同模型重试')
  const p401 = failurePolicy(401, 'invalid key', {})
  assert.equal(p401.code, 'opencodego_auth_failed')
  assert.equal(p401.terminal, true)
  assert.equal(p401.allowRetrySameModel, false)
})

test('未声明的聚合保留 ID：404 unknown_model 且零上游命中（不回退默认上游）', { timeout: 30000 }, async (t) => {
  const hits = []
  const up = await startScriptedUpstream(jsonHandler(hits, (req, res) => chatOk(res)))
  const gw = await startGateway({
    config: gatewayConfig(up.base, { defaults: { retry: { maxAttempts: 1 }, proxyMode: 'direct', codexCatalogBasePath: BASE_CATALOG, provider: 'opencodego' } }),
    env: { [SYNTH_ENV]: SYNTH_KEY },
  })
  t.after(async () => { await gw.stop(); await up.stop() })

  const res = await gw.post('/v1/chat/completions', {
    model: 'mg-opencodego-glm-5',
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(res.status, 404)
  const body = await res.json()
  assert.equal(body.error.code, 'unknown_model')
  assert.match(body.error.message, /未在 config\/models 显式声明/)
  assert.equal(hits.length, 0, '越界聚合 ID 不得回退到 defaults.provider 或其他模型')
})

test('凭据缺失：显式拒绝（零上游命中），适配层给 Go 专属 typed code', { timeout: 30000 }, async (t) => {
  const hits = []
  const up = await startScriptedUpstream(jsonHandler(hits, (req, res) => chatOk(res)))
  const gw = await startGateway({
    config: gatewayConfig(up.base, {
      providers: { opencodego: { baseUrl: up.base + '/inference/go/openai/v1', api: 'openai', apiKeyEnv: 'SYNTH_V2_ABSENT_KEY' } },
    }),
  })
  t.after(async () => { await gw.stop(); await up.stop() })

  const res = await gw.post('/v1/chat/completions', { model: V2_TARGET_PUBLIC_ID, messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(res.status, 502)
  const body = await res.json()
  assert.equal(body.error.type, 'no_provider')
  assert.equal(hits.length, 0, '没有凭据就不得发出上游请求（更不得借用别的供应商凭据）')

  // 适配层：GUI 能拿到精确原因，而不是只看「无可用上游」。
  const r = readiness({ provider: { id: 'opencodego', baseUrl: GO_PRESET_BASE_URL, keyRef: 'none' } })
  assert.equal(r.ok, false)
  assert.equal(r.code, GO_READY_CODES.CREDENTIAL)
  assert.equal(r.allowProviderSwitch, false)
})

test('身份一致性：出站 model 恒为真实模型，公共 ID 不一致直接 typed 失败', () => {
  const good = identityOf({ upstreamId: V2_TARGET_UPSTREAM_MODEL, publicId: V2_TARGET_PUBLIC_ID })
  assert.equal(good.ok, true)
  assert.equal(good.outboundModel, V2_TARGET_UPSTREAM_MODEL)
  const bad = identityOf({ upstreamId: V2_TARGET_UPSTREAM_MODEL, publicId: 'mg-opencodego-other' })
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'opencodego_public_id_mismatch')
  const other = identityOf({ upstreamId: 'gpt-6-luna' })
  assert.equal(other.ok, false)
  assert.equal(other.code, GO_READY_CODES.MODEL_OUT_OF_SCOPE)
})

test('Go CLI alias without the Go target returns unknown_model before the bridge or default routing', async (t) => {
  const hits = []
  const up = await startScriptedUpstream(jsonHandler(hits, (req, res) => chatOk(res)))
  t.after(() => up.stop())
  const gw = await startGateway({ config: {
    defaults: { provider: 'generic' },
    providers: { generic: { baseUrl: up.base, api: 'openai' } },
  } })
  t.after(() => gw.stop())
  const res = await gw.post('/v1/responses', {
    model: 'deepseekv4.1flash', input: 'calculate', previous_response_id: 'resp_old',
  })
  assert.equal(res.status, 404)
  assert.equal((await res.json()).error.code, 'unknown_model')
  assert.equal(hits.length, 0)
})

test('CLI alias receives exact model metadata and continues through the Go Chat route', async (t) => {
  const alias = 'deepseekv4.1flash'
  const hits = []
  const up = await startScriptedUpstream(jsonHandler(hits, (req, res) => {
    if (hits.length !== 1) return chatOk(res)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'call_calc', type: 'function', function: { name: 'calculate', arguments: '{"expression":"6*7"}' } }] }, finish_reason: 'tool_calls' }] }))
  }))
  const cfg = gatewayConfig(up.base)
  cfg.models[V2_TARGET_UPSTREAM_MODEL].alias = []
  cfg.models[V2_TARGET_UPSTREAM_MODEL].maxContext = 128000
  const gw = await startGateway({ config: cfg, env: { [SYNTH_ENV]: SYNTH_KEY } })
  t.after(async () => { await gw.stop(); await up.stop() })
  const models = (await (await gw.get('/v1/models?client_version=0.170.0')).json()).models
  const canonical = models.find((m) => m.slug === V2_TARGET_PUBLIC_ID)
  assert.ok(canonical)
  const first = await gw.post('/v1/responses', { model: alias, input: 'calculate', stream: false, previous_response_id: 'resp_mgws_legacy' })
  assert.equal(first.status, 200, await first.clone().text())
  const response = await first.json()
  assert.equal(response.model, alias)
  const result = await gw.post('/v1/responses', {
    model: alias, previous_response_id: response.id, stream: false,
    input: [{ type: 'function_call_output', call_id: 'call_calc', output: '42' }],
  })
  assert.equal(result.status, 200, await result.clone().text())
  assert.deepEqual(hits.map((hit) => JSON.parse(hit.body).model), [V2_TARGET_UPSTREAM_MODEL, V2_TARGET_UPSTREAM_MODEL])
  assert.equal(JSON.parse(hits[1].body).messages.at(-1).content, '42')
  assert.deepEqual(models.find((m) => m.slug === alias), { ...canonical, slug: alias, visibility: 'hide' })
})
