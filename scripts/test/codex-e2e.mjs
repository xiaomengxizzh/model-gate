#!/usr/bin/env node
// M2-3：真实 Codex CLI 0.167.0 三轮回环双 mock（opt-in，不进默认 SUITES）。
import http from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCatalog, serializeCatalog } from '../../src/codex/catalog.js'
import { startGateway } from './offline/harness.mjs'

// 状态（2026-11-12）：NOT_RUN —— 本机无网络命名空间隔离（unshare -Urn 不可用），而 codex-cli
// 0.167.0 在空 CODEX_HOME 首次启动会尝试 curated plugin sync（github.com/openai/plugins.git）。
// 为避免误触外连，默认拒绝运行；只有在**外部已强制阻断 egress**的主机上显式设置
// MGR_E2E_NETWORK_ISOLATED=1 才继续（脚本本身另加 --disable plugins 与 127.0.0.1 死代理）。
if (process.env.MGR_E2E_NETWORK_ISOLATED !== '1') {
  console.error('NOT_RUN: real codex-cli may perform curated plugin sync over the network. Run only on a host with enforced egress isolation and set MGR_E2E_NETWORK_ISOLATED=1.')
  process.exit(2)
}

const CODEX = process.env.CODEX_BIN || '/home/xiaomengxizi/.local/bin/codex'
const SYNTHETIC_KEY = 'sk-synthetic-not-real'
const PRODUCT_DEFAULT_MAX_BODY = 32 * 1024 * 1024
const FIXTURE_MAX_BODY = 1024 * 1024
const OFFICIAL_SLUG = 'gpt-synthetic-official'
const THIRD_MODEL = 'deepseek-mock'
const TURN1 = 'TURN1_OK'
const TURN2 = 'TURN2_OK'
const TURN3 = 'TURN3_OK'
const TOOL_CALL_ID = 'call_turn1_pwd'

function arg (name, dflt) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt }
const codexBin = arg('--codex', CODEX)
const KEEP = process.argv.includes('--keep')

const checks = []
function check (name, ok, detail) {
  checks.push({ name, ok: !!ok })
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? ' :: ' + detail : ''))
}

function sse (res, emit) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
  emit((e, d) => res.write('event: ' + e + '\ndata: ' + JSON.stringify(d) + '\n\n'))
  res.end()
}

function sseText (res, model, text) {
  sse(res, (emit) => {
    emit('response.created', { type: 'response.created', response: { id: 'r-' + Date.now(), object: 'response', status: 'in_progress', model, output: [] } })
    emit('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: 'm1', type: 'message', status: 'in_progress', role: 'assistant', content: [] } })
    emit('response.content_part.added', { type: 'response.content_part.added', item_id: 'm1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
    emit('response.output_text.delta', { type: 'response.output_text.delta', item_id: 'm1', output_index: 0, content_index: 0, delta: text })
    emit('response.output_text.done', { type: 'response.output_text.done', item_id: 'm1', output_index: 0, content_index: 0, text })
    emit('response.content_part.done', { type: 'response.content_part.done', item_id: 'm1', output_index: 0, content_index: 0, part: { type: 'output_text', text, annotations: [] } })
    emit('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { id: 'm1', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] } })
    emit('response.completed', { type: 'response.completed', response: { id: 'r-' + Date.now(), object: 'response', status: 'completed', model, output: [{ id: 'm1', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }], usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 } } })
  })
}

function sseToolCall (res, model, callId, toolArgs) {
  const argText = JSON.stringify(toolArgs)
  sse(res, (emit) => {
    emit('response.created', { type: 'response.created', response: { id: 'r-' + Date.now(), object: 'response', status: 'in_progress', model, output: [] } })
    emit('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: 'fc1', type: 'function_call', status: 'in_progress', name: 'exec_command', arguments: '', call_id: callId } })
    emit('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: 'fc1', output_index: 0, delta: argText })
    emit('response.function_call_arguments.done', { type: 'response.function_call_arguments.done', item_id: 'fc1', output_index: 0, arguments: argText })
    emit('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { id: 'fc1', type: 'function_call', status: 'completed', name: 'exec_command', arguments: argText, call_id: callId } })
    emit('response.completed', { type: 'response.completed', response: { id: 'r-' + Date.now(), object: 'response', status: 'completed', model, output: [{ id: 'fc1', type: 'function_call', status: 'completed', name: 'exec_command', arguments: argText, call_id: callId }], usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 } } })
  })
}


function lastUserText (input) {
  const users = (Array.isArray(input) ? input : []).filter((i) => i && i.type === 'message' && i.role === 'user')
  return bodyTextOf(users.length ? [users[users.length - 1]] : [])
}

function bodyTextOf (input) {
  let text = ''
  for (const item of Array.isArray(input) ? input : []) {
    if (!item || typeof item !== 'object') continue
    if (typeof item.content === 'string') text += item.content
    if (Array.isArray(item.content)) {
      for (const part of item.content) {
        if (typeof part === 'string') text += part
        else if (part && typeof part.text === 'string') text += part.text
      }
    }
    if (typeof item.output === 'string') text += item.output
  }
  return text
}

async function readAll (req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return Buffer.concat(chunks)
}

async function startOfficialMock () {
  const hits = []
  const state = { toolCallSeen: null, toolOutput: null, round3Context: null, lastUserTexts: [] }
  const server = http.createServer(async (req, res) => {
    if (req.headers.upgrade) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('no websocket'); return }
    const raw = await readAll(req)
    let body = {}
    try { body = JSON.parse(raw.toString('utf8')) } catch {}
    const input = Array.isArray(body.input) ? body.input : []
    hits.push({ url: req.url, headers: req.headers, model: body.model, input, len: raw.length })
    const outputs = input.filter((i) => i && i.type === 'function_call_output')
    const text = lastUserText(input)
    state.lastUserTexts.push(text.slice(0, 60))
    const lastItem = input.length ? input[input.length - 1] : null
    if (lastItem && lastItem.type === 'function_call_output') {
      state.toolCallSeen = lastItem.call_id || null
      state.toolOutput = String(lastItem.output || '')
      const firstLine = (state.toolOutput.split('\n').find((l) => l.trim()) || '').trim()
      return sseText(res, body.model || OFFICIAL_SLUG, TURN1 + ' pwd=' + firstLine)
    }
    if (text.includes('TURN1')) return sseToolCall(res, body.model || OFFICIAL_SLUG, TOOL_CALL_ID, { cmd: 'pwd' })
    state.round3Context = text.includes('TURN3') && bodyTextOf(input).includes(TURN2)
    return sseText(res, body.model || OFFICIAL_SLUG, TURN3 + ' context=' + (state.round3Context ? 'TURN2' : 'missing'))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  return {
    port: server.address().port,
    hits,
    state,
    stop: async () => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)) },
  }
}

async function startThirdMock () {
  const hits = []
  const state = { contextSeen: false, round2Text: null, lastMessages: [] }
  const server = http.createServer(async (req, res) => {
    if (req.headers.upgrade) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('no websocket'); return }
    const raw = await readAll(req)
    let body = {}
    try { body = JSON.parse(raw.toString('utf8')) } catch {}
    hits.push({ url: req.url, headers: req.headers, body, len: raw.length })
    state.lastMessages = (body.messages || []).map((m) => ({ role: m && m.role, text: typeof (m && m.content) === 'string' ? m.content.slice(0, 160) : String(JSON.stringify(m && m.content)).slice(0, 160) }))
    const text = bodyTextOf((body.messages || []).map((m) => ({ content: m && m.content })))
    state.contextSeen = /TURN1_OK/.test(text)
    state.round2Text = TURN2 + ' context=' + (state.contextSeen ? 'TURN1' : 'missing')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      id: 'c-' + Date.now(),
      object: 'chat.completion',
      model: body.model || THIRD_MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content: state.round2Text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    }))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  return {
    port: server.address().port,
    hits,
    state,
    stop: async () => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)) },
  }
}


function officialModel (overrides = {}) {
  const level = (effort) => ({ effort, description: effort + ' reasoning' })
  return {
    slug: OFFICIAL_SLUG,
    display_name: 'Synthetic Official',
    description: 'Synthetic official model for offline CLI e2e',
    default_reasoning_level: 'low',
    supported_reasoning_levels: [level('low'), level('medium'), level('high')],
    shell_type: 'unified_exec',
    visibility: 'list',
    supported_in_api: true,
    priority: 1,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    include_skills_usage_instructions: false,
    include_plugin_usage_instructions: false,
    include_apps_usage_instructions: false,
    default_reasoning_summary: 'none',
    support_verbosity: true,
    default_verbosity: 'low',
    apply_patch_tool_type: 'freeform',
    web_search_tool_type: 'text_and_image',
    truncation_policy: { mode: 'tokens', limit: 200000 },
    supports_image_detail_original: true,
    context_window: 200000,
    max_context_window: 400000,
    comp_hash: '1000',
    effective_context_window_percent: 95,
    experimental_supported_tools: ['clock'],
    input_modalities: ['text', 'image'],
    supports_search_tool: true,
    supports_experimental_context: false,
    use_responses_lite: false,
    supports_reasoning_effort_updates: true,
    node_repl_auto_review_required: false,
    node_repl_disabled: true,
    tool_mode: 'default',
    base_instructions: 'You are a synthetic official fixture agent.',
    model_messages: { instructions_template: 'You are a synthetic official fixture agent.' },
    ...overrides,
  }
}

function runCodex (args, env, cwd, straceLog, timeoutMs = 240000) {
  return new Promise((resolve) => {
    const useStrace = !!straceLog && existsSync('/usr/bin/strace')
    const bin = useStrace ? '/usr/bin/strace' : codexBin
    const fullArgs = useStrace ? ['-f', '-e', 'trace=openat,connect', '-o', straceLog, codexBin, ...args] : args
    const child = spawn(bin, fullArgs, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (b) => { out += String(b) })
    child.stderr.on('data', (b) => { err += String(b) })
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, timeoutMs)
    child.once('exit', (code) => { clearTimeout(timer); resolve({ code, out, err }) })
  })
}

const official = await startOfficialMock()
const third = await startThirdMock()


const runtimeTmp = process.env.MGR_TMP || process.env.TMPDIR || tmpdir()
const home = await mkdtemp(join(runtimeTmp, 'mg-e2e-cli-home-'))
const codexHome = await mkdtemp(join(runtimeTmp, 'mg-e2e-cli-ch-'))
const cwd = await mkdtemp(join(runtimeTmp, 'mg-e2e-cli-cwd-'))
const work = await mkdtemp(join(runtimeTmp, 'mg-e2e-cli-work-'))
const basePath = join(work, 'official-base.json')
const catalogPath = join(work, 'codex-catalog.json')
await writeFile(basePath, JSON.stringify({ models: [officialModel()] }), 'utf8')
await writeFile(join(home, 'README-synthetic.txt'), 'synthetic home; no real credentials\n', 'utf8')

const gatewayConfig = {
  server: { maxBodyBytes: FIXTURE_MAX_BODY },
  defaults: {
    model: '',
    codexOfficialProvider: 'codex-official',
    codexOfficialHosts: ['localhost'],
    codexCatalogBasePath: basePath,
    timeout: { firstByteMs: 60000, idleMs: 60000 },
  },
  providers: {
    'codex-official': { baseUrl: 'http://localhost:' + official.port, codexIdentity: 'official', responsesPath: '/backend-api/codex/responses' },
    third: { baseUrl: 'http://127.0.0.1:' + third.port + '/v1', api: 'openai' },
  },
  models: {
    [THIRD_MODEL]: { provider: 'third', api: 'openai', maxContext: 128000, effortOptions: ['low', 'medium', 'high'], reasoning: 'low' },
  },
}

const built = buildCatalog({ base: { models: [officialModel()] }, config: gatewayConfig })
const aggregateSlug = Object.keys(built.meta.bindings || {})[0]
await writeFile(catalogPath, serializeCatalog(built.catalog, { format: 'catalog-json' }), 'utf8')

const gw = await startGateway({ name: 'm4e2e', env: { MG_CODEX_OFFICIAL_PASSTHROUGH: '1' }, config: gatewayConfig })

const env = {
  HOME: home,
  CODEX_HOME: codexHome,
  TMPDIR: runtimeTmp,
  PATH: '/usr/bin:/bin',
  LANG: 'C.UTF-8',
  NO_COLOR: '1',
  OPENAI_API_KEY: SYNTHETIC_KEY,
  // 只回环保证：任何试图出网的插件同步/更新都必须打到本机死端口，不允许真实外连。
  HTTP_PROXY: 'http://127.0.0.1:9',
  HTTPS_PROXY: 'http://127.0.0.1:9',
  ALL_PROXY: 'http://127.0.0.1:9',
  NO_PROXY: '',
}

function baseArgs (model, prompt, thread) {
  const pluginOff = ['--disable', 'plugins', '--disable', 'remote_plugin', '--disable', 'plugin_discovery_prefetch']
  const common = ['--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', '-c', 'model_provider="openai"', '-c', 'openai_base_url="' + gw.base + '"', '-c', 'model_catalog_json="' + catalogPath + '"', '-c', 'model="' + model + '"']
  return thread
    ? [...pluginOff, 'exec', 'resume', thread, ...common, prompt]
    : [...pluginOff, 'exec', ...common, prompt]
}

const round1Strace = join(work, 'round1.strace')
const round2Strace = join(work, 'round2.strace')
const round3Strace = join(work, 'round3.strace')
const debugStrace = join(work, 'debug.strace')


try {
  // 0) 目录可验证：真实 CLI debug models 加载生成目录
  const dbg = await runCodex(['--disable', 'plugins', '--disable', 'remote_plugin', '--disable', 'plugin_discovery_prefetch', 'debug', 'models', '-c', 'model_catalog_json="' + catalogPath + '"'], env, cwd, debugStrace, 120000)
  let dbgModels = []
  try { dbgModels = (JSON.parse(dbg.out).models) || [] } catch {}
  const officialEntry = dbgModels.find((m) => m && m.slug === OFFICIAL_SLUG)
  const aggregateEntry = dbgModels.find((m) => m && m.slug === aggregateSlug)
  check('目录：debug models 退出 0', dbg.code === 0, 'code=' + dbg.code + ' err=' + dbg.err.slice(-300))
  check('目录：目标 slug 均存在（官方 + 聚合）', !!officialEntry && !!aggregateEntry, 'official=' + !!officialEntry + ' aggregate=' + !!aggregateEntry + ' count=' + dbgModels.length)
  check('目录：官方条目 metadata 完整', !!(officialEntry && officialEntry.context_window && officialEntry.max_context_window && Array.isArray(officialEntry.supported_reasoning_levels) && officialEntry.supported_reasoning_levels.length > 0 && (officialEntry.base_instructions || (officialEntry.model_messages && officialEntry.model_messages.instructions_template))))
  check('目录：无 fallback metadata 警告', !/fallback metadata|Model metadata for/i.test(dbg.out + dbg.err), String(dbg.err).slice(-300))

  // 第 1 轮：官方模型 + 本机只读工具 call/output
  const r1 = await runCodex(baseArgs(OFFICIAL_SLUG, 'First use exec_command to run pwd. Then reply with exactly ' + TURN1 + ' and include the pwd output.', false), env, cwd, round1Strace)
  const thread = (r1.out.match(/"type":"thread\.started","thread_id":"([0-9a-f-]{36})"/) || [])[1]
  check('第1轮：exit 0 且拿到 thread id', r1.code === 0 && !!thread, 'code=' + r1.code + ' thread=' + thread + ' err=' + r1.err.slice(-300))
  check('第1轮：工具 call/output 配对（call_id 回填）', official.state.toolCallSeen === TOOL_CALL_ID, 'seen=' + String(official.state.toolCallSeen))
  check('第1轮：本机只读工具真实执行（pwd 输出出现在回填里）', /mg-e2e-cli-cwd-/.test(String(official.state.toolOutput || '')), 'out=' + String(official.state.toolOutput || '').slice(0, 120))
  check('第1轮：assistant 完成文本含 TURN1_OK 与 pwd', new RegExp(TURN1).test(r1.out) && /mg-e2e-cli-cwd-/.test(r1.out), r1.out.slice(-500))
  check('第1轮：官方 mock 命中且未打第三方', official.hits.length >= 2 && third.hits.length === 0, 'official=' + official.hits.length + ' third=' + third.hits.length)

  // 第 2 轮：同线程切第三方（Chat 桥）
  const officialBefore2 = official.hits.length
  const r2 = await runCodex(baseArgs(aggregateSlug, 'Reply with exactly ' + TURN2 + ' and mention the previous pwd output.', thread), env, cwd, round2Strace)
  if (r2.code !== 0) console.log('DEBUG r2 out=' + r2.out.slice(-4000) + '\nDEBUG r2 err=' + r2.err.slice(-2000) + '\nDEBUG thirdHits=' + JSON.stringify(third.hits.map((h) => ({ url: h.url, model: h.body && h.body.model, msgs: (h.body && h.body.messages || []).length }))))
  check('第2轮：exit 0', r2.code === 0, 'code=' + r2.code + ' err=' + r2.err.slice(-400))
  check('第2轮：第三方 mock 命中且未再打官方', third.hits.length >= 1 && official.hits.length === officialBefore2, 'official=' + official.hits.length + ' third=' + third.hits.length)
  if (!third.state.contextSeen) console.log('DEBUG third messages=' + JSON.stringify(third.state.lastMessages))
  check('第2轮：上下文连续（第三方收到第1轮内容）', third.state.contextSeen === true, 'round2=' + String(third.state.round2Text))
  check('第2轮：上游收到原模型名而不是聚合 slug', third.hits.every((h) => (h.body.model || '') === THIRD_MODEL), JSON.stringify(third.hits.map((h) => h.body.model)))

  // 第 3 轮：同线程切回官方
  const officialBefore3 = official.hits.length
  const thirdBefore3 = third.hits.length
  const r3 = await runCodex(baseArgs(OFFICIAL_SLUG, 'Reply with exactly ' + TURN3 + ' and mention ' + TURN2 + '.', thread), env, cwd, round3Strace)
  check('第3轮：exit 0', r3.code === 0, 'code=' + r3.code + ' err=' + r3.err.slice(-400))
  check('第3轮：官方 mock 命中且第三方零新增', official.hits.length > officialBefore3 && third.hits.length === thirdBefore3, 'official=' + official.hits.length + ' third=' + third.hits.length)
  if (!official.state.round3Context) console.log('DEBUG official lastUserTexts=' + JSON.stringify(official.state.lastUserTexts))
  check('第3轮：上下文连续（官方收到第2轮内容）', official.state.round3Context === true, 'round3=' + String(official.state.round3Context))
  check('第3轮：响应含 TURN3_OK', new RegExp(TURN3).test(r3.out), r3.out.slice(-400))

  // 零凭据与零真实 auth
  const allHits = official.hits.concat(third.hits)
  const authValues = [...new Set(allHits.map((h) => h.headers.authorization).filter(Boolean))]
  check('零凭据：mock 只收到合成 Authorization', authValues.length === 0 || (authValues.length === 1 && authValues[0] === 'Bearer ' + SYNTHETIC_KEY), JSON.stringify(authValues))
  check('零凭据：第三方 mock 不收到 chatgpt-account-id', third.hits.every((h) => h.headers['chatgpt-account-id'] === undefined))
  check('零凭据：官方/第三方 mock 只走回环', official.hits.every((h) => /^(localhost|127\.0\.0\.1):/.test(String(h.headers.host || ''))) && third.hits.every((h) => /^(localhost|127\.0\.0\.1):/.test(String(h.headers.host || ''))))
  let authFileSeen = false
  try { await readFile(join(home, '.codex', 'auth.json'), 'utf8'); authFileSeen = true } catch {}
  try { await readFile(join(codexHome, 'auth.json'), 'utf8'); authFileSeen = true } catch {}
  check('零凭据：未创建/使用 auth.json（改用合成 OPENAI_API_KEY）', authFileSeen === false)
  let realCredAccess = null
  for (const file of [round1Strace, round2Strace, round3Strace, debugStrace]) {
    let text = ''
    try { text = await readFile(file, 'utf8') } catch { continue }
    if (text.includes('/home/xiaomengxizi/.codex')) realCredAccess = file
  }
  check('零凭据：strace 未打开真实 ~/.codex（含 auth.json）', realCredAccess === null, realCredAccess ? 'opened in ' + realCredAccess : 'strace logs clean')
  let externalConnect = null
  for (const file of [round1Strace, round2Strace, round3Strace, debugStrace]) {
    let text = ''
    try { text = await readFile(file, 'utf8') } catch { continue }
    for (const line of text.split('\n')) {
      if (!line.includes('connect(') || !line.includes('AF_INET')) continue
      if (/127\.0\.0\.1|::1|AF_UNIX/.test(line)) continue
      externalConnect = line
    }
  }
  check('零外网：strace connect 仅回环/Unix（插件同步已禁用，代理指向本机死端口）', externalConnect === null, externalConnect ? externalConnect.slice(0, 240) : 'no external connect')

  // 不透明 v2：显式拒绝且零上游命中
  const beforeV2 = { official: official.hits.length, third: third.hits.length }
  const v2res = await fetch(gw.base + '/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: aggregateSlug, input: [{ type: 'agent_message', content: [{ type: 'input_text', text: 'hello', encrypted_content: 'sk-cipher-sentinel' }] }] }),
  })
  const v2text = await v2res.text()
  check('v2 密文：400 显式拒绝', v2res.status === 400 && /v2_encrypted_task_unsupported/.test(v2text), 'status=' + v2res.status + ' body=' + v2text.slice(0, 300))
  check('v2 密文：零上游命中', official.hits.length === beforeV2.official && third.hits.length === beforeV2.third, JSON.stringify(beforeV2) + ' -> ' + JSON.stringify({ official: official.hits.length, third: third.hits.length }))

  // 请求体上限（夹具 1 MiB；产品默认 32 MiB；旧 65,536 字节上限的回归）
  check('请求体上限：夹具值显式记录为 1 MiB（产品默认 32 MiB）', FIXTURE_MAX_BODY === 1048576 && PRODUCT_DEFAULT_MAX_BODY === 33554432, 'fixture=' + FIXTURE_MAX_BODY + ' product=' + PRODUCT_DEFAULT_MAX_BODY)
  const beforeBig = third.hits.length
  const bigRes = await fetch(gw.base + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: THIRD_MODEL, messages: [{ role: 'user', content: 'x'.repeat(100 * 1024) }], stream: false }),
  })
  check('请求体上限：100 KiB 请求通过（不是 413）', bigRes.status === 200 && third.hits.length === beforeBig + 1, 'status=' + bigRes.status)

  check('线程：第2/3轮均以同一 thread id resume 成功', r1.code === 0 && r2.code === 0 && r3.code === 0 && !!thread)
  console.log('\nthread=' + thread + ' aggregate=' + aggregateSlug + ' officialHits=' + official.hits.length + ' thirdHits=' + third.hits.length)
  console.log('fixtureMaxBody=' + FIXTURE_MAX_BODY + ' productDefaultMaxBody=' + PRODUCT_DEFAULT_MAX_BODY)
} finally {
  await gw.stop()
  await official.stop()
  await third.stop()
  if (!KEEP) {
    for (const dir of [home, codexHome, cwd, work]) { try { await rm(dir, { recursive: true, force: true }) } catch {} }
  } else {
    console.log('kept dirs: ' + JSON.stringify({ home, codexHome, cwd, work }))
  }
}

const failed = checks.filter((c) => !c.ok)
console.log('\n' + (checks.length - failed.length) + '/' + checks.length + ' checks passed')
process.exitCode = failed.length ? 1 : 0
