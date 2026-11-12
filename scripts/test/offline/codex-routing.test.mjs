// MG-017-T1 Codex 试点路由（gateway-routing）离线契约测试。
// 双 mock 上游（OpenAI 侧 / DeepSeek 侧）验证：
//  1) 模型 -> 固定 provider 单上游；providerModels 覆盖名；服务端凭据注入与客户端凭据隔离；
//  2) 明文工具声明投影、agent_message 历史投影、reasoning drop、完成项 namespace/marker 恢复；
//  3) strictModelRouting 未声明模型 400 unknown_model 且零上游；
//  4) 试点模型不因 429/5xx 切上游；
//  5) 非 codex 的 api:"responses" 保持原有逐字节透传与 model 回写；
//  6) 保存校验拒绝非法 codex 配置且不落盘。
// 全部离线：本地回环 mock，不触真实上游、不读写用户主配置。
import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, startScriptedUpstream } from './harness.mjs'
import { codexRoute, codexPilotEnabled, createRouter } from '../../../src/router.js'

const json = () => ({ 'content-type': 'application/json' })
const CLIENT_HEADERS = Object.assign(json(), {
  authorization: 'Bearer client-gateway-key',
  cookie: 'session=client-cookie',
  'chatgpt-account-id': 'acct_client_123',
  'openai-beta': 'responses=v1',
  'x-api-key': 'client-x-api-key',
})

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8')
  try { return raw ? JSON.parse(raw) : null } catch { return raw }
}

function responseJson(overrides = {}) {
  return Object.assign({
    id: 'resp_up',
    object: 'response',
    created_at: 1700000000,
    status: 'completed',
    model: 'vendor-model',
    output: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'pong' }] },
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'send_message', arguments: '{"message":"hi"}', status: 'completed' },
    ],
    output_text: 'pong',
    usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
  }, overrides)
}

// 记录到达 body 后交给测试脚本；默认返回带工具项的 Responses JSON。
function jsonUpstream(handler) {
  return startScriptedUpstream(async (req, res, rec) => {
    rec.body = await readBody(req)
    if (handler) return handler(req, res, rec)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(responseJson()))
  })
}

function pilotConfig(openai, ds, mutate) {
  const cfg = {
    defaults: { proxyMode: 'direct', codex: { strictModelRouting: true } },
    providers: {
      'openai-official': { baseUrl: openai.base, api: 'responses', apiKeyEnv: 'MG_TEST_OPENAI_KEY' },
      'deepseek-official': { baseUrl: ds.base, api: 'responses', apiKeyEnv: 'MG_TEST_DS_KEY' },
    },
    models: {
      // 目录 slug / 网关模型名必须完全一致；alias 也可作为严格路由的合法名字
      'codex-gpt': {
        provider: 'openai-official', api: 'responses', alias: ['codex-root'],
        providerModels: { 'openai-official': 'gpt-6.1-sol' },
        codex: { multiAgentVersion: 'v2', plaintextTools: true },
      },
      'codex-deepseek': {
        provider: 'deepseek-official', api: 'responses',
        providerModels: { 'deepseek-official': 'deepseek-v4-pro' },
        codex: {
          multiAgentVersion: 'v2', plaintextTools: true,
          history: { agentMessage: 'project', reasoning: 'drop', compaction: 'reject' },
        },
      },
      'plain-native': { provider: 'openai-official', api: 'responses' },
      'plain-chat': { provider: 'openai-official' },
    },
  }
  if (mutate) mutate(cfg)
  return cfg
}

async function startPilot(t, openai, ds, mutate) {
  const gw = await startGateway({
    name: 'mg017',
    config: pilotConfig(openai, ds, mutate),
    env: { MG_TEST_OPENAI_KEY: 'sk-openai-server', MG_TEST_DS_KEY: 'sk-ds-server' },
  })
  t.after(async () => { await gw.stop(); await openai.stop(); await ds.stop() })
  return gw
}

function toolByName(tools, name) {
  return (Array.isArray(tools) ? tools : []).find((x) => (x && (x.name || (x.function && x.function.name))) === name) || null
}
function toolParameters(tool) {
  if (!tool) return null
  return tool.parameters || (tool.function && tool.function.parameters) || null
}

test('codex-gpt 只路由到 OpenAI mock：服务端 Key、覆盖名、明文工具声明、完成项恢复', { timeout: 30000 }, async (t) => {
  const openai = await jsonUpstream()
  const ds = await jsonUpstream()
  const gw = await startPilot(t, openai, ds)

  const res = await gw.post('/v1/responses', {
    model: 'codex-gpt',
    client_metadata: { thread_id: 'thread_root_1', parent_thread_id: 'thread_parent_0' },
    prompt_cache_key: 'client-prompt-cache-key',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    tools: [{
      type: 'namespace', name: 'collaboration',
      tools: [{
        type: 'function', name: 'send_message', description: 'send a message',
        parameters: { type: 'object', properties: { target: { type: 'string' }, message: { type: 'string', encrypted: true } }, required: ['target', 'message'] },
      }],
    }],
  }, CLIENT_HEADERS)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.model, 'codex-gpt', '非流式响应 model 回写客户端请求名')

  assert.equal(openai.hits.length, 1, '只命中 OpenAI mock')
  assert.equal(ds.hits.length, 0, 'DeepSeek mock 零命中')
  const hit = openai.hits[0]
  assert.equal(hit.url, '/v1/responses', '端点 = provider.baseUrl + responsesPath 默认值')
  assert.equal(hit.headers.authorization, 'Bearer sk-openai-server', '注入该 provider 的服务端 Key')
  for (const h of ['cookie', 'chatgpt-account-id', 'openai-beta', 'x-api-key']) {
    assert.equal(hit.headers[h], undefined, '不转发客户端 ' + h)
  }
  assert.equal(hit.body.model, 'gpt-6.1-sol', 'providerModels 覆盖名生效')
  assert.equal(hit.body.input[0].content[0].text, 'hi')
  assert.equal('client_metadata' in hit.body, false, '客户端 thread/parent_thread 元数据不进上游')
  assert.equal('prompt_cache_key' in hit.body, false, '客户端 prompt_cache_key 不进上游')

  // 工具声明形状：三工具之一以普通 function 明文声明，message 参数不再带 encrypted
  const tool = toolByName(hit.body.tools, 'send_message')
  assert.ok(tool, '上游收到 send_message 声明')
  const params = toolParameters(tool)
  assert.equal(params.properties.message.type, 'string')
  assert.equal('encrypted' in params.properties.message, false, '删除 message.encrypted')
  assert.deepEqual(params.required, ['target', 'message'], 'required 原样保留（只删 encrypted）')

  // 完成项恢复：本轮明文声明过的 send_message → namespace + encrypted_function_args:[]
  const fc = (body.output || []).find((x) => x.type === 'function_call' && x.name === 'send_message')
  assert.ok(fc, '完成项仍是 function_call')
  assert.equal(fc.namespace, 'collaboration', '恢复 collaboration namespace')
  assert.deepEqual(fc.encrypted_function_args, [], '补明文 marker')
  assert.equal(fc.call_id, 'call_1', 'call_id 保持原值')
  assert.equal(fc.arguments, '{"message":"hi"}', 'arguments 保持原值')

  // 别名同样按精确命中进入试点路由（严格路由不因别名拒绝）
  const aliasRes = await gw.post('/v1/responses', { model: 'codex-root', input: 'hi' }, json())
  assert.equal(aliasRes.status, 200)
  assert.equal(openai.hits.length, 2, '别名命中仍只打 OpenAI mock')
  assert.equal(openai.hits[1].body.model, 'gpt-6.1-sol')
  assert.equal(ds.hits.length, 0)
})

test('codex-deepseek 只路由到 DeepSeek mock：不带 OpenAI/客户端凭据，agent_message 投影、reasoning drop', { timeout: 30000 }, async (t) => {
  const openai = await jsonUpstream()
  const ds = await jsonUpstream()
  const gw = await startPilot(t, openai, ds)

  const res = await gw.post('/v1/responses', {
    model: 'codex-deepseek',
    client_metadata: { thread_id: 'thread_child_1', parent_thread_id: 'thread_root_1' },
    prompt_cache_key: 'client-prompt-cache-key-child',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { type: 'agent_message', author: 'root', recipient: 'child', content: [{ type: 'input_text', text: 'please help' }] },
      { type: 'reasoning', id: 'rs_1', encrypted_content: 'OPAQUE_CIPHERTEXT', summary: [] },
    ],
    tools: [{
      type: 'namespace', name: 'collaboration',
      tools: [{
        type: 'function', name: 'followup_task',
        parameters: { type: 'object', properties: { target: { type: 'string' }, message: { type: 'string', encrypted: true } }, required: ['target', 'message'] },
      }],
    }],
  }, CLIENT_HEADERS)
  assert.equal(res.status, 200)

  assert.equal(ds.hits.length, 1, '只命中 DeepSeek mock')
  assert.equal(openai.hits.length, 0, 'OpenAI mock 零命中')
  const hit = ds.hits[0]
  assert.equal(hit.url, '/v1/responses')
  assert.equal(hit.headers.authorization, 'Bearer sk-ds-server', '只注入 DeepSeek 服务端 Key')
  for (const h of ['cookie', 'chatgpt-account-id', 'openai-beta', 'x-api-key']) {
    assert.equal(hit.headers[h], undefined, '不转发客户端 ' + h)
  }
  assert.notEqual(hit.headers.authorization, 'Bearer client-gateway-key')
  assert.equal(hit.body.model, 'deepseek-v4-pro', 'providerModels 覆盖名生效')
  assert.equal('client_metadata' in hit.body, false, 'DeepSeek 侧同样不接收客户端 thread 元数据')
  assert.equal('prompt_cache_key' in hit.body, false, 'DeepSeek 侧同样不接收 prompt_cache_key')

  const input = Array.isArray(hit.body.input) ? hit.body.input : []
  assert.equal(input.some((x) => x && x.type === 'agent_message'), false, 'agent_message 不原样发给 DeepSeek')
  const projected = input.find((x) => JSON.stringify(x).includes('please help'))
  assert.ok(projected, 'agent_message 正文被投影为普通消息')
  assert.equal(projected.role, 'user')
  assert.equal(projected.type, 'message')
  assert.match(projected.content[0].text, /\[agent_message from=root to=child\]/, '投影保留 author/recipient 前缀')
  assert.equal(input.some((x) => x && x.type === 'reasoning'), false, 'history.reasoning=drop 时省略 reasoning')

  const tool = toolByName(hit.body.tools, 'followup_task')
  assert.ok(tool, '上游收到 followup_task 明文声明')
  assert.equal('encrypted' in toolParameters(tool).properties.message, false)
})

test('strictModelRouting：未声明模型 400 unknown_model 且两个 mock 都 0 命中', { timeout: 30000 }, async (t) => {
  const openai = await jsonUpstream()
  const ds = await jsonUpstream()
  const gw = await startPilot(t, openai, ds)

  const res = await gw.post('/v1/responses', { model: 'not-in-catalog', input: 'hi' }, json())
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.equal(body.error.type, 'unknown_model')
  assert.match(body.error.message, /not-in-catalog/)
  assert.equal(openai.hits.length, 0, '零上游请求（OpenAI）')
  assert.equal(ds.hits.length, 0, '零上游请求（DeepSeek）')

  // 缺 model 也必须 400 且不出网
  const noModel = await gw.post('/v1/responses', { input: 'hi' }, json())
  assert.equal(noModel.status, 400)
  assert.equal((await noModel.json()).error.type, 'unknown_model')
  assert.equal(openai.hits.length + ds.hits.length, 0)
})

test('试点模型不因上游 429/500 切到另一个 provider（fallbacks 被运行时忽略）', { timeout: 30000 }, async (t) => {
  const openai = await jsonUpstream(async (req, res, rec) => {
    if (rec.index === 0) {
      res.writeHead(429, json())
      res.end(JSON.stringify({ error: { message: 'rate limited', type: 'rate_limit_exceeded' } }))
      return
    }
    res.writeHead(500, json())
    res.end(JSON.stringify({ error: { message: 'boom', type: 'server_error' } }))
  })
  const ds = await jsonUpstream()
  const gw = await startPilot(t, openai, ds, (cfg) => {
    // 手改配置绕过保存校验：运行时仍必须只打 provider 单上游
    cfg.models['codex-gpt'].fallbacks = ['deepseek-official']
  })

  const r1 = await gw.post('/v1/responses', { model: 'codex-gpt', input: 'hi' }, json())
  assert.equal(r1.status, 429, '保留上游 429 状态码（forward 重试耗尽后带 status 抛出）')
  assert.match((await r1.json()).error.message, /HTTP 429/, '错误可读且归因到该上游')
  const r2 = await gw.post('/v1/responses', { model: 'codex-gpt', input: 'hi' }, json())
  assert.equal(r2.status, 500, '保留上游 500 状态码')
  assert.match((await r2.json()).error.message, /HTTP 500/)

  assert.equal(openai.hits.length, 2, '两次请求都只打 OpenAI')
  assert.equal(ds.hits.length, 0, '429/500 不触发跨上游迁移')
})

test('非 codex 的 api:"responses" 保持原生透传与 model 回写（不经过试点投影）', { timeout: 30000 }, async (t) => {
  const openai = await jsonUpstream(async (req, res, rec) => {
    res.writeHead(200, json())
    res.end(JSON.stringify(responseJson({ model: 'vendor-upstream-name', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'pong' }] }] })))
  })
  const ds = await jsonUpstream()
  const gw = await startPilot(t, openai, ds)

  const res = await gw.post('/v1/responses', {
    model: 'plain-native', input: 'hi', include: ['reasoning.encrypted_content'], store: false,
    client_metadata: { thread_id: 'thread_native_1' }, prompt_cache_key: 'native-cache-key',
  }, json())
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.model, 'plain-native', '非 codex 原生路径同样回写 model')
  assert.equal(ds.hits.length, 0)
  assert.equal(openai.hits.length, 1)
  const hit = openai.hits[0]
  assert.equal(hit.url, '/v1/responses')
  assert.equal(hit.body.model, 'plain-native', '无 providerModels 时透传客户端模型名')
  assert.equal(hit.body.input, 'hi', 'input 原样透传，未转换成 messages')
  assert.equal(hit.body.messages, undefined)
  assert.equal(hit.body.tools, undefined)
  assert.equal(hit.body.store, false)
  // 边界：元数据剥离只发生在 codex 试点路由；普通原生透传保持既有透传语义（不只是否剥离作为契约）
  assert.deepEqual(hit.body.client_metadata, { thread_id: 'thread_native_1' })
  assert.equal(hit.body.prompt_cache_key, 'native-cache-key')
})

test('保存校验：协议/fallbacks/版本/明文开关/namespace/history/未知字段非法 → 400 且配置未变', { timeout: 30000 }, async (t) => {
  const openai = await jsonUpstream()
  const ds = await jsonUpstream()
  const gw = await startPilot(t, openai, ds)
  const before = await (await gw.get('/api/config')).json()
  const gpt = before.models['codex-gpt']
  const save = (models) => gw.post('/api/config/save', { models }, json())

  const cases = [
    ['codex 放在非 responses 模型', { api: 'openai' }, '仅允许用于 api:"responses"'],
    ['试点模型带 fallbacks', { fallbacks: ['deepseek-official'] }, 'codex 试点模型不允许 fallbacks'],
    ['multiAgentVersion 非 v2', { codex: Object.assign({}, gpt.codex, { multiAgentVersion: 'v1' }) }, 'multiAgentVersion 仅支持 "v2"'],
    ['plaintextTools 非布尔', { codex: Object.assign({}, gpt.codex, { plaintextTools: 'yes' }) }, 'plaintextTools 须为布尔值'],
    ['namespace 非 collaboration', { codex: Object.assign({}, gpt.codex, { namespace: 'multi_agent_v1' }) }, 'namespace 仅支持缺省或 "collaboration"'],
    ['history.agentMessage 非法', { codex: Object.assign({}, gpt.codex, { history: { agentMessage: 'drop' } }) }, 'history.agentMessage 仅支持 preserve/project/reject'],
    ['history.compaction 非法', { codex: Object.assign({}, gpt.codex, { history: { compaction: 'project' } }) }, 'history.compaction 仅支持 reject/drop'],
    ['codex 未知字段', { codex: Object.assign({}, gpt.codex, { bogus: true }) }, '含未知字段'],
  ]
  for (const [name, patch, expected] of cases) {
    const res = await save({ 'codex-gpt': Object.assign({}, gpt, patch) })
    assert.equal(res.status, 400, name + ' 应被拒绝')
    const body = await res.json()
    assert.match(String(body.error), new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), name + ' 的错误文案')
    const after = await (await gw.get('/api/config')).json()
    assert.deepEqual(after.models, before.models, name + ' 被拒绝后模型配置未变')
    assert.equal(after.configVersion, before.configVersion, name + ' 被拒绝后 configVersion 未变')
  }

  // 合法配置仍可保存（防止校验过宽），保存后 codex 定义保留
  const ok = await save(before.models)
  assert.equal(ok.status, 200)
  const saved = await (await gw.get('/api/config')).json()
  assert.ok(saved.configVersion > before.configVersion, '合法保存推进 configVersion')
  assert.equal(saved.models['codex-gpt'].codex.multiAgentVersion, 'v2')
  assert.deepEqual(saved.models['codex-gpt'].codex, before.models['codex-gpt'].codex, '合法保存后 codex 定义原样保留')
})

test('codex-gpt 流式：createCodexStreamAdapter 接线（身份恢复、终态唯一、usage 记账）', { timeout: 30000 }, async (t) => {
  const openai = await jsonUpstream(async (req, res, rec) => {
    const frames = [
      'event: response.created\ndata: ' + JSON.stringify({ type: 'response.created', response: { id: 'resp_up', object: 'response', status: 'in_progress', model: 'gpt-6.1-sol' } }) + '\n\n',
      'event: response.output_item.added\ndata: ' + JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { id: 'fc_1', type: 'function_call', status: 'in_progress', call_id: 'call_1', name: 'send_message', arguments: '' } }) + '\n\n',
      'event: response.output_item.done\ndata: ' + JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: { id: 'fc_1', type: 'function_call', status: 'completed', call_id: 'call_1', name: 'send_message', arguments: '{"target":"/root","message":"hi"}' } }) + '\n\n',
      'event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response: { id: 'resp_up', object: 'response', created_at: 1700000000, status: 'completed', model: 'gpt-6.1-sol', output: [{ id: 'fc_1', type: 'function_call', status: 'completed', call_id: 'call_1', name: 'send_message', arguments: '{"target":"/root","message":"hi"}' }], usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } } }) + '\n\n',
    ].join('')
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.end(frames)
  })
  const ds = await jsonUpstream()
  const gw = await startPilot(t, openai, ds)

  const res = await gw.post('/v1/responses', {
    model: 'codex-gpt', input: 'hi', stream: true,
    tools: [{
      type: 'namespace', name: 'collaboration',
      tools: [{
        type: 'function', name: 'send_message',
        parameters: { type: 'object', properties: { target: { type: 'string' }, message: { type: 'string', encrypted: true } }, required: ['target', 'message'] },
      }],
    }],
  }, json())
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') || '', /text\/event-stream/)
  const text = await res.text()
  assert.equal(text.includes('data: [DONE]'), false, 'Responses 流不追加 [DONE]')
  assert.equal(openai.hits.length, 1)
  assert.equal(ds.hits.length, 0)
  assert.equal(openai.hits[0].body.stream, true)
  assert.equal(openai.hits[0].body.model, 'gpt-6.1-sol')

  const events = text.split('\n\n').filter(Boolean).map((block) => {
    const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n')
    try { return JSON.parse(data) } catch { return null }
  }).filter(Boolean)
  const done = events.filter((e) => e.type === 'response.output_item.done')
  assert.equal(done.length, 1)
  assert.equal(done[0].item.namespace, 'collaboration', 'done 项恢复 namespace')
  assert.deepEqual(done[0].item.encrypted_function_args, [], 'done 项补明文 marker')
  assert.equal(done[0].item.call_id, 'call_1')
  const terminals = events.filter((e) => e.type === 'response.completed' || e.type === 'response.failed' || e.type === 'response.incomplete')
  assert.equal(terminals.length, 1, '终态事件唯一')
  assert.equal(terminals[0].type, 'response.completed')
  const restored = terminals[0].response.output.find((x) => x.type === 'function_call')
  assert.equal(restored.namespace, 'collaboration', 'completed.output 走同一恢复器')
  assert.deepEqual(restored.encrypted_function_args, [])

  const st = await (await gw.get('/api/status')).json()
  const m = st.models.find((x) => x.name === 'codex-gpt')
  assert.equal(m.requests, 1, '流式请求计 1 次')
  assert.equal(m.tokens, 7, '流式 usage 记一次（3+4）')
})

test('router：codexRoute/codexPilotEnabled 冻结快照与 resolve 共用别名表', () => {
  const cfg = {
    defaults: { provider: 'fallback' },
    providers: { p1: {}, p2: {}, fallback: {} },
    models: {
      'codex-gpt': {
        provider: 'p1', api: 'responses', alias: ['gpt-alias'],
        providerModels: { p1: 'gpt-6.1-sol' },
        codex: { multiAgentVersion: 'v2', plaintextTools: true },
      },
      'codex-ds': {
        provider: 'p2', api: 'responses',
        codex: { multiAgentVersion: 'v2', plaintextTools: false, history: { agentMessage: 'project', reasoning: 'drop' }, namespace: 'collaboration' },
      },
      'plain-native': { provider: 'p1', api: 'responses' },
      'plain-chat': { provider: 'p1' },
    },
  }
  const a = codexRoute(cfg, 'codex-gpt')
  assert.deepEqual(a, {
    alias: 'codex-gpt', provider: 'p1', upstreamModel: 'gpt-6.1-sol', api: 'responses',
    codex: {
      multiAgentVersion: 'v2', plaintextTools: true,
      history: { agentMessage: 'preserve', reasoning: 'preserve', compaction: 'reject' },
      namespace: 'collaboration',
    },
  }, 'route 形状/默认值与契约一致')
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.codex) && Object.isFrozen(a.codex.history), 'route 冻结')
  assert.equal(codexRoute(cfg, 'gpt-alias').alias, 'codex-gpt', '别名精确命中')
  assert.equal(codexRoute(cfg, 'codex-ds').upstreamModel, 'codex-ds', '无 providerModels 覆盖时用模型名')
  assert.equal(codexRoute(cfg, 'plain-native'), null, '无 codex 声明不回试点路由')
  assert.equal(codexRoute(cfg, 'plain-chat'), null)
  assert.equal(codexRoute(cfg, 'nope'), null)
  assert.equal(codexRoute({ models: { bad: { provider: 'p', api: 'responses', codex: { multiAgentVersion: 'v2' } } } }, 'bad'), null, '缺 plaintextTools 运行时判定无效')

  assert.equal(codexPilotEnabled(cfg), true)
  assert.equal(codexPilotEnabled({ models: { x: { provider: 'p' } } }), false)

  const rt = createRouter(cfg)
  assert.equal(rt.resolve('codex-gpt').canonicalName, 'codex-gpt')
  assert.equal(rt.resolve('gpt-alias').def.api, 'responses', 'resolve 与 codexRoute 共用别名表')
  const ghost = rt.resolve('ghost')
  assert.equal(ghost.known, false)
  assert.equal(ghost.def.provider, 'fallback', '原有 defaults.provider 兜底不变')
})
