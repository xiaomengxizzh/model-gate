#!/usr/bin/env node
// 真实 Codex CLI 0.167.0 + ModelGate + 双回环 mock（opt-in）；--native-v1 验证直接协作与公开预览请求形态。
// 默认验证三轮模型切换，--native-v2 验证原生父子派发、工具结果与同子追派。
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCatalog, serializeCatalog } from '../../src/codex/catalog.js'
import { startGateway } from './offline/harness.mjs'
import { makeV1Parent } from './fixtures/codex/native-v1-parent.mjs'

// 版本锁定：真实 CLI 只接受 0.167.0；版本不符时生命周期断言不可信，必须失败。
const LOCKED_CODEX_VERSION = '0.167.0'
const MANIFEST_PATH = new URL('./fixtures/codex/v2-lifecycle-manifest.json', import.meta.url)
const ROLE_FIXTURE_PATH = new URL('./fixtures/codex/roles/0.167.0-negative.toml', import.meta.url)

// 显式清单：P05 把 V2 工具/等待/跟进/取消/权限/恢复纳入 runner 的声明面。
// 这里只声明与纯 mock 校验，不执行 Codex；真实执行归 Q02（要求 OS 级出网隔离）。
const V2_CASES = Object.freeze([
  { id: 'tool_nonce', status: 'FIXTURE_PREPARED', requires: 'Q02 + OS isolation', assert: 'child runs a read-only tool and the nonce reaches the parent wait notification' },
  { id: 'wait_agent', status: 'FIXTURE_PREPARED', requires: 'Q02 + OS isolation', assert: 'wait_agent receives the native completion notification; no timeout before child final' },
  { id: 'followup_task', status: 'FIXTURE_PREPARED', requires: 'Q02 + OS isolation', assert: 'followup_task starts a new child turn and the new nonce returns to the parent' },
  { id: 'send_message', status: 'FIXTURE_PREPARED', requires: 'Q02 + OS isolation', assert: 'send_message is routed as a namespace collaboration tool with plaintext projection' },
  { id: 'cancel', status: 'FIXTURE_PREPARED', requires: 'Q02 + OS isolation', assert: 'cancel prevents further followup and yields a canceled terminal, not a fake success' },
  { id: 'permission_deny', status: 'FIXTURE_PREPARED', requires: 'Q02 + OS isolation', assert: 'denied tool permission is reported and no tool executes' },
  { id: 'permission_allow', status: 'FIXTURE_PREPARED', requires: 'Q02 + OS isolation', assert: 'allowed tool permission executes once with the expected nonce' },
  { id: 'resume_cold', status: 'FIXTURE_PREPARED', requires: 'Q02 + OS isolation', assert: 'resume returns the same root SID and reuses the existing child id/history' },
  { id: 'fork_turns_none', status: 'FIXTURE_PREPARED', requires: 'Q02 + OS isolation', assert: 'fork_turns=none child starts without parent history' },
  { id: 'fork_turns_all', status: 'FIXTURE_PREPARED', requires: 'Q02 + OS isolation', assert: 'fork_turns=all child receives the parent history in order' },
  { id: 'concurrency_limit', status: 'FIXTURE_PREPARED', requires: 'Q02 + OS isolation', assert: 'native concurrency limit rejects the over-limit spawn with a typed error' },
  { id: 'parent_child_ids', status: 'FIXTURE_PREPARED', requires: 'Q02 + OS isolation', assert: 'root/child ids are distinct and linked; no gateway-invented child' },
  { id: 'zero_egress', status: 'FIXTURE_PREPARED', requires: 'Q02 + OS isolation', assert: 'requests hit only loopback mocks; no external connect' },
])

// 历史回归：M2-3 接线后本地跑到 22/27，第 2 轮 502 candidate pool empty；不得当作 PASS。
const REGRESSIONS = Object.freeze([
  {
    id: 'm2-3-round2-502-candidate-pool',
    status: 'REGRESSION_DECLARED',
    historical: 'After wiring, the local run reached 22/27 checks and round 2 returned 502 candidate pool empty; not accepted as PASS.',
    assert: 'round 2 must not return 502; an empty candidate pool must produce a typed/readable diagnosis',
    reopen: 'Q02 on a host with enforced egress isolation',
  },
])

function manifestPayload() {
  return {
    schema: 'mg.codex.v2-lifecycle-manifest/v1',
    codexVersion: LOCKED_CODEX_VERSION,
    lockedAt: '2026-11-12',
    roleFixture: 'scripts/test/fixtures/codex/roles/0.167.0-negative.toml',
    roleExpectation: 'same-provider model override only; role model_provider must not change the provider (ADR-0003)',
    isolation: {
      required: 'OS-level egress isolation (network namespace or host-level block)',
      current: 'BLOCKED_ENV: bwrap/unshare unavailable; curated plugin sync risk cannot be excluded',
      executionOwner: 'Q02',
      optInEnv: 'MGR_E2E_NETWORK_ISOLATED=1',
      v2OptInEnv: 'MG_CODEX_V2=1',
    },
    cases: V2_CASES.map((c) => Object.assign({}, c)),
    regressions: REGRESSIONS.map((r) => Object.assign({}, r)),
    notes: [
      'This manifest is declarative. It does not run Codex and does not claim PASS.',
      'Real lifecycle execution belongs to Q02 and requires OS-level egress isolation; bwrap/unshare is unavailable here.',
      'The role fixture is the P01 negative fixture: model_provider in a role is ignored, provider is inherited.',
    ],
  }
}

function checkManifest() {
  const issues = []
  const add = (name, ok, detail) => {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? ' :: ' + detail : ''))
    if (!ok) issues.push(name)
  }
  let manifest = null
  try { manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) } catch (err) { add('manifest 可读', false, err && err.message) }
  add('manifest schema/version 锁定', !!manifest && manifest.schema === 'mg.codex.v2-lifecycle-manifest/v1' && manifest.codexVersion === LOCKED_CODEX_VERSION, manifest && manifest.codexVersion)
  const ids = new Set((manifest && Array.isArray(manifest.cases) ? manifest.cases : []).map((c) => c && c.id))
  const missing = V2_CASES.map((c) => c.id).filter((id) => !ids.has(id))
  add('V2 case 清单完整', missing.length === 0, missing.join(','))
  add('role fixture 存在', existsSync(ROLE_FIXTURE_PATH), fileURLToPath(ROLE_FIXTURE_PATH))
  const regressions = Array.isArray(manifest && manifest.regressions) ? manifest.regressions : []
  add('22/27 502 回归已声明', regressions.some((r) => r && r.id === 'm2-3-round2-502-candidate-pool'))
  const claims = (manifest && Array.isArray(manifest.cases) ? manifest.cases : []).filter((c) => c && /^(PASS|VERIFIED|LIVE)$/i.test(String(c.status || '')))
  add('清单不声称真实通过', claims.length === 0, claims.map((c) => c.id).join(','))
  return issues.length === 0
}

const CODEX = process.env.CODEX_BIN || '/home/xiaomengxizi/.local/bin/codex'
const SYNTHETIC_KEY = 'sk-synthetic-upstream-not-real'
const SYNTHETIC_GO_KEY = 'sk-synthetic-go-not-real'
const SYNTHETIC_CLIENT_KEY = 'sk-client-synthetic-not-real'
const PRODUCT_DEFAULT_MAX_BODY = 32 * 1024 * 1024
const FIXTURE_MAX_BODY = 1024 * 1024
const OFFICIAL_SLUG = 'gpt-synthetic-official'
const NATIVE_V2 = process.argv.includes('--native-v2')
const NATIVE_V1 = process.argv.includes('--native-v1')
const NATIVE_COLLABORATION = NATIVE_V1 || NATIVE_V2
const THIRD_MODEL = NATIVE_COLLABORATION ? 'deepseek-v4.1-flash' : 'deepseek-mock'
const TURN1 = 'TURN1_OK'
const TURN2 = 'TURN2_OK'
const TURN3 = 'TURN3_OK'
const TOOL_CALL_ID = 'call_turn1_pwd'

function arg (name, dflt) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt }
const codexBin = arg('--codex', CODEX)
let nativeV1Parent = null
const KEEP = process.argv.includes('--keep')
const TASK_A = 'MG_A_' + randomUUID()
const TASK_B = 'MG_B_' + randomUUID()
const CHILD_TASK = 'modelgate_worker'

const checks = []
function check (name, ok, detail) {
  checks.push({ name, ok: !!ok })
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? ' :: ' + detail : ''))
}

// 纯声明模式不启动 CLI/网关、不触网，也不受 egress 门控影响。
if (process.argv.includes('--list')) {
  console.log(JSON.stringify(manifestPayload(), null, 2))
  process.exit(0)
}
if (process.argv.includes('--check-manifest')) {
  process.exit(checkManifest() ? 0 : 1)
}

// 状态（2026-11-12）：NOT_RUN —— 本机无网络命名空间隔离（unshare -Urn 不可用），而 codex-cli
// 0.167.0 在空 CODEX_HOME 首次启动会尝试 curated plugin sync（github.com/openai/plugins.git）。
// 为避免误触外连，默认拒绝运行；只有在**外部已强制阻断 egress**的主机上显式设置
// MGR_E2E_NETWORK_ISOLATED=1 才继续（脚本本身另加 --disable plugins 与 127.0.0.1 死代理）。
if (process.env.MGR_E2E_NETWORK_ISOLATED !== '1') {
  console.error('NOT_RUN: real codex-cli may perform curated plugin sync over the network. Run only on a host with enforced egress isolation and set MGR_E2E_NETWORK_ISOLATED=1.')
  process.exit(2)
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

function sseToolCall (res, model, callId, toolArgs, spec = {}) {
  const argText = JSON.stringify(toolArgs)
  const { plaintext, ...identity } = { name: 'exec_command', ...spec }
  const completed = { id: 'fc1', type: 'function_call', status: 'completed', ...identity, arguments: argText, call_id: callId }
  if (plaintext) completed.encrypted_function_args = []
  sse(res, (emit) => {
    emit('response.created', { type: 'response.created', response: { id: 'r-' + Date.now(), object: 'response', status: 'in_progress', model, output: [] } })
    emit('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: 'fc1', type: 'function_call', status: 'in_progress', ...identity, arguments: '', call_id: callId } })
    emit('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: 'fc1', output_index: 0, delta: argText })
    emit('response.function_call_arguments.done', { type: 'response.function_call_arguments.done', item_id: 'fc1', output_index: 0, arguments: argText })
    emit('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: completed })
    emit('response.completed', { type: 'response.completed', response: { id: 'r-' + Date.now(), object: 'response', status: 'completed', model, output: [completed], usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 } } })
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

function nativeV2Parent(res, body, state) {
  const input = body.input || []
  const collab = body.tools?.find((tool) => tool.type === 'namespace' && tool.name === 'collaboration')
  const spawn = collab?.tools?.find((tool) => tool.name === 'spawn_agent')
  state.nativeTools = Boolean(spawn && collab.tools.some((tool) => tool.name === 'followup_task'))
  const observed = bodyTextOf(input)
  if (!state.nativeTools) return sseText(res, body.model, 'NATIVE_TOOLS_UNAVAILABLE')
  const invoke = (name, id, args, plaintext = false) => sseToolCall(res, body.model, id, args, { name, namespace: 'collaboration', plaintext })
  if (!state.spawned) {
    state.spawned = true
    return invoke('spawn_agent', 'call_mg_spawn', { task_name: CHILD_TASK, model: aggregateSlug, fork_turns: 'none', message: TASK_A }, true)
  }
  if (observed.includes('CHILD_DONE_' + TASK_A) && !state.followedUp) {
    state.followedUp = true
    return invoke('followup_task', 'call_mg_followup', { target: '/root/' + CHILD_TASK, message: TASK_B }, true)
  }
  if (observed.includes('CHILD_DONE_' + TASK_B)) {
    state.receivedBoth = state.followedUp === true
    return sseText(res, body.model, 'MODEL_GATE_NATIVE_OK')
  }
  if (input.some((item) => item.type === 'function_call' && item.name === 'wait_agent' &&
      input.some((output) => output.type === 'function_call_output' && output.call_id === item.call_id && /Wait timed out/.test(output.output)))) {
    return sseText(res, body.model, 'NATIVE_WAIT_TIMEOUT')
  }
  state.waits = (state.waits || 0) + 1
  if (state.waits > 5) return sseText(res, body.model, 'NATIVE_CHILD_RESULT_MISSING')
  return invoke('wait_agent', 'call_mg_wait_' + state.waits, { timeout_ms: 5000 })
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
    if (NATIVE_V1 && nativeV1Parent) return nativeV1Parent(res, body, state)
    if (NATIVE_V2) return nativeV2Parent(res, body, state)
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
    if (NATIVE_COLLABORATION) {
      const input = Array.isArray(body.input) ? body.input : []
      const text = bodyTextOf(input)
      const marker = text.includes(TASK_B) ? TASK_B : text.includes(TASK_A) ? TASK_A : null
      if (!marker) return sseText(res, body.model, 'CHILD_TASK_MISSING')
      const toolCallId = 'call_tool_' + marker
      const output = input.find((item) => item.type === 'function_call_output' && item.call_id === toolCallId)
      if (!output) return sseToolCall(res, body.model, toolCallId, { cmd: "printf '%s\\n' " + marker })
      state.toolOutputs ||= new Set()
      if (/Process exited with code 0/.test(String(output.output)) && String(output.output).includes(marker)) state.toolOutputs.add(marker)
      return sseText(res, body.model, state.toolOutputs.has(marker) ? 'CHILD_DONE_' + marker : 'CHILD_TOOL_RESULT_MISSING')
    }
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
const parentCatalogRow = officialModel(NATIVE_V1
  ? { supports_search_tool: false, supports_websockets: false, use_responses_lite: false }
  : (NATIVE_V2 ? { multi_agent_version: 'v2' } : {}))
const catalogPath = join(work, 'codex-catalog.json')
await writeFile(basePath, JSON.stringify({ models: [parentCatalogRow] }), 'utf8')
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
    'codex-official': { baseUrl: 'http://localhost:' + official.port, codexIdentity: 'official', apiKeyEnv: 'MG_E2E_UPSTREAM_KEY' },
    third: { baseUrl: 'http://127.0.0.1:' + third.port + '/v1', api: 'openai', ...(NATIVE_COLLABORATION ? { apiKeyEnv: 'MG_E2E_GO_KEY' } : {}) },
  },
  models: {
    [THIRD_MODEL]: {
      provider: 'third', api: NATIVE_COLLABORATION ? 'responses' : 'openai', maxContext: 128000, effortOptions: ['low', 'medium', 'high'], reasoning: 'low',
      codex: {
        ...(NATIVE_COLLABORATION ? { plaintextTools: true, history: { agentMessage: 'project' } } : {}),
        capabilities: { shellType: 'unified_exec', applyPatchToolType: 'freeform' },
        evidence: {
          shellType: { source: 'offline loopback fixture', observedAt: new Date().toISOString() },
          applyPatchToolType: { source: 'offline loopback fixture', observedAt: new Date().toISOString() },
        },
      },
    },
  },
}

const built = buildCatalog({ base: { models: [parentCatalogRow] }, config: gatewayConfig })
const aggregateSlug = Object.keys(built.meta.bindings || {})[0]
await writeFile(catalogPath, serializeCatalog(built.catalog, { format: 'catalog-json' }), 'utf8')

if (NATIVE_V1) nativeV1Parent = makeV1Parent({
  sseText,
  sseToolCall,
  getChildModel: () => aggregateSlug,
  taskA: TASK_A,
  taskB: TASK_B,
})

const gw = await startGateway({ name: 'm4e2e', env: { MG_E2E_UPSTREAM_KEY: SYNTHETIC_KEY, MG_E2E_GO_KEY: SYNTHETIC_GO_KEY, ...(NATIVE_V1 ? { MG_CLIENT_KEY: SYNTHETIC_CLIENT_KEY } : {}) }, config: gatewayConfig })

const env = {
  HOME: home,
  CODEX_HOME: codexHome,
  TMPDIR: runtimeTmp,
  PATH: '/usr/bin:/bin',
  LANG: 'C.UTF-8',
  NO_COLOR: '1',
  ...(NATIVE_V1 ? { MG_E2E_CLIENT_KEY: SYNTHETIC_CLIENT_KEY } : { OPENAI_API_KEY: SYNTHETIC_KEY }),
  // 只回环保证：任何试图出网的插件同步/更新都必须打到本机死端口，不允许真实外连。
  HTTP_PROXY: 'http://127.0.0.1:9',
  HTTPS_PROXY: 'http://127.0.0.1:9',
  ALL_PROXY: 'http://127.0.0.1:9',
  NO_PROXY: '127.0.0.1,localhost,::1',
}

async function assertLockedVersion(env, cwd) {
  const probe = await runCodex(['--version'], env, cwd, null, 30000)
  check('版本锁定：codex --version 为 ' + LOCKED_CODEX_VERSION, new RegExp(LOCKED_CODEX_VERSION.replace(/\./g, '\\.')).test(probe.out + probe.err), (probe.out + probe.err).trim().slice(0, 200))
  check('角色 fixture：存在且按 P01 反向边界（同 provider model override）', existsSync(ROLE_FIXTURE_PATH), fileURLToPath(ROLE_FIXTURE_PATH))
}

function baseArgs (model, prompt, thread) {
  const pluginOff = ['--disable', 'plugins', '--disable', 'remote_plugin', '--disable', 'plugin_discovery_prefetch']
  const providerArgs = NATIVE_V1
    ? ['-c', 'model_provider="modelgate"', '-c', 'model_providers.modelgate.name="ModelGate"', '-c', 'model_providers.modelgate.base_url="' + gw.base + '/v1"', '-c', 'model_providers.modelgate.env_key="MG_E2E_CLIENT_KEY"']
    : ['-c', 'model_provider="openai"', '-c', 'openai_base_url="' + gw.base + '"']
  const featureArgs = NATIVE_V1 ? ['-c', 'features.multi_agent=true', '-c', 'features.multi_agent_v2.enabled=false', '-c', 'web_search="disabled"'] : []
  const common = ['--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', ...featureArgs, ...providerArgs, '-c', 'model_catalog_json="' + catalogPath + '"', '-c', 'model="' + model + '"']
  return thread
    ? [...pluginOff, 'exec', 'resume', thread, ...common, prompt]
    : [...pluginOff, 'exec', ...common, prompt]
}

const round1Strace = join(work, 'round1.strace')
const round2Strace = join(work, 'round2.strace')
const round3Strace = join(work, 'round3.strace')
const debugStrace = join(work, 'debug.strace')


async function runNativeV2Fixture() {
  const args = baseArgs(OFFICIAL_SLUG, 'Run the synthetic native collaboration fixture.', false)
  args.splice(args.indexOf('exec'), 0, '--enable', 'multi_agent_v2')
  const result = await runCodex(args, env, cwd, round1Strace, 45000)
  const evidence = { nativeTools: !!official.state.nativeTools, spawned: !!official.state.spawned, followedUp: !!official.state.followedUp, parentHits: official.hits.length, childHits: third.hits.length, toolRounds: third.state.toolOutputs?.size || 0 }
  check('ModelGate 原生 V2：父工具已发布并完成两轮', result.code === 0 && official.state.receivedBoth && result.out.includes('MODEL_GATE_NATIVE_OK'), JSON.stringify(evidence))
  const childCalls = third.hits.map(({ body }) => bodyTextOf((body.input || []).filter((item) => item.type === 'message' && item.role === 'user')))
  check('ModelGate 原生 V2：第三方两轮各自收到任务并回填真实 Codex 工具结果',
    [TASK_A, TASK_B].every((marker) => childCalls.some((text) => text.includes(marker)) && third.state.toolOutputs?.has(marker)), JSON.stringify(evidence))
  check('ModelGate 原生 V2：子请求命中独立路由与原模型名', third.hits.length > 0 &&
    third.hits.every(({ body, url }) => body.model === THIRD_MODEL && url === '/v1/responses'), JSON.stringify(evidence))
  check('ModelGate 原生 V2：父子上游各自只收到配置的合成 Key', official.hits.length > 0 && third.hits.length > 0 &&
    official.hits.every(({ headers }) => headers.authorization === 'Bearer ' + SYNTHETIC_KEY) &&
    third.hits.every(({ headers }) => headers.authorization === 'Bearer ' + SYNTHETIC_GO_KEY && !headers['chatgpt-account-id']))
  const parentId = (result.out.match(/"type":"thread\.started","thread_id":"([0-9a-f-]{36})"/) || [])[1]
  const children = []
  const sessions = join(codexHome, 'sessions')
  if (existsSync(sessions)) {
    for (const file of await readdir(sessions, { recursive: true })) {
      if (!file.endsWith('.jsonl')) continue
      const events = (await readFile(join(sessions, file), 'utf8')).trim().split('\n').map(JSON.parse)
      const meta = events.find((event) => event.type === 'session_meta')?.payload
      if (parentId && meta?.source?.subagent?.thread_spawn?.parent_thread_id === parentId) children.push(events)
    }
  }
  check('ModelGate 原生 V2：仅一个原生子线程，且同一子线程有两个独立 turn', children.length === 1 &&
    new Set(children[0].filter((event) => event.type === 'turn_context').map((event) => event.payload.turn_id)).size === 2)
  if (!official.state.receivedBoth) console.log('CLI fixture diagnostics:', result.out.slice(-2100), result.err.slice(-800))
}

async function runNativeV1Fixture () {
  const args = baseArgs(OFFICIAL_SLUG, 'Use the native multi-agent V1 fixture; report both child receipts.', false)
  const result = await runCodex(args, env, cwd, round1Strace, 90000)
  const parentId = (result.out.match(/"type":"thread\.started","thread_id":"([0-9a-f-]{36})"/) || [])[1]
  const state = official.state
  const preview = state.preview || {}
  const violations = [...(preview.violations || [])]
  const requestKeys = [...(preview.requestKeys || [])].sort()
  const toolTypes = [...(preview.toolTypes || [])].sort()
  const childBRequest = third.hits.find(({ body }) => bodyTextOf(body.input || []).includes(TASK_A) && bodyTextOf(body.input || []).includes(TASK_B))
  const childBInput = childBRequest?.body.input || []
  const aHistoryItems = childBInput.filter((item) => bodyTextOf([item]).includes(TASK_A))
  const childAToolId = 'call_tool_' + TASK_A
  const childAToolCall = childBInput.some((item) => item.type === 'function_call' && item.call_id === childAToolId)
  const childAToolOutput = childBInput.find((item) => item.type === 'function_call_output' && item.call_id === childAToolId)
  const childAAssistant = childBInput.some((item) => item.type === 'message' && item.role === 'assistant' && bodyTextOf([item]).includes('CHILD_DONE_' + TASK_A))
  const evidence = {
    nativeTools: !!state.nativeTools,
    childId: state.childId || null,
    followedUp: !!state.followedUp,
    receipts: { a: !!state.receipt_a, b: !!state.receipt_b },
    previewViolations: violations,
    requestKeys,
    toolTypes,
    secondTurnHistory: { itemTypes: aHistoryItems.map((item) => item.type), hasA: aHistoryItems.length > 0, hasToolCallA: childAToolCall, toolOutputAExit0: /Process exited with code 0/.test(String(childAToolOutput?.output || '')), assistantReceiptA: childAAssistant, hasB: !!childBRequest },
    parentHits: official.hits.length,
    childHits: third.hits.length,
    childToolRounds: third.state.toolOutputs?.size || 0,
  }
  check('原生 V1：能力请求直接发布 multi_agent_v1 spawn/wait/send_input namespace',
    state.nativeTools === true && violations.length === 0 && official.hits.length > 0 &&
    official.hits.every((hit) => hit.url === '/v1/responses') && parentCatalogRow.supports_search_tool === false,
    JSON.stringify(evidence))
  check('原生 V1：请求保持官方订阅兼容边界且未带 SIWC 不支持字段', violations.length === 0, JSON.stringify(evidence))
  check('原生 V1：初派与追派收据分别由同一 child id 完成',
    /^[0-9a-f-]{36}$/i.test(state.childId || '') && state.followedUp === true && state.receipt_a === true && state.receipt_b === true && state.receivedBoth === true,
    JSON.stringify(evidence))
  check('原生 V1：两个 child Responses 任务和工具回填都命中第三方 mock',
    [TASK_A, TASK_B].every((marker) => third.hits.some(({ body }) => bodyTextOf((body.input || []).filter((item) => item.type === 'message' && item.role === 'user')).includes(marker)) && third.state.toolOutputs?.has(marker)), JSON.stringify(evidence))
  check('原生 V1：同一 child 的 B 请求保留 A 任务、工具调用、成功工具输出和 assistant 收据',
    !!childBRequest && aHistoryItems.length > 0 && childAToolCall &&
    /Process exited with code 0/.test(String(childAToolOutput?.output || '')) && String(childAToolOutput?.output || '').includes(TASK_A) && childAAssistant,
    JSON.stringify(evidence))
  check('原生 V1：父子请求只使用合成密钥并保持原模型名',
    official.hits.every(({ headers }) => headers.authorization === 'Bearer ' + SYNTHETIC_KEY && !headers['chatgpt-account-id']) &&
    third.hits.every(({ headers, body }) => headers.authorization === 'Bearer ' + SYNTHETIC_GO_KEY && !headers['chatgpt-account-id'] && body.model === THIRD_MODEL), JSON.stringify(evidence))
  check('原生 V1：单进程包含最终第二收据并 exit 0',
    result.code === 0 && result.out.includes('MODEL_GATE_NATIVE_V1_OK') && result.out.includes(TASK_B),
    'code=' + result.code + ' stdout=' + result.out.slice(-900) + ' stderr=' + result.err.slice(-500))
  const childCountBeforeResume = third.hits.length
  const parentHitsBeforeResume = official.hits.length
  if (result.code === 0 && parentId && state.receivedBoth) {
    state.resumeExpectedHistory = true
    const resume = await runCodex(baseArgs(OFFICIAL_SLUG, 'MODEL_GATE_NATIVE_V1_RESUME_PROBE', parentId), env, cwd, null, 45000)
    const resumedParentId = (resume.out.match(/"type":"thread\.started","thread_id":"([0-9a-f-]{36})"/) || [])[1]
    check('原生 V1：正常退出后同一 Custom Provider 恢复父线程和 A/B 历史，不再派发子任务',
      resume.code === 0 && resumedParentId === parentId && state.resumeObserved === true &&
      official.hits.length === parentHitsBeforeResume + 1 && third.hits.length === childCountBeforeResume &&
      state.childId === evidence.childId && resume.out.includes('MODEL_GATE_NATIVE_V1_RESUME_OK'),
      'code=' + resume.code + ' parent=' + resumedParentId + ' history=' + !!state.resumeObserved + ' childHits=' + third.hits.length + ' stdout=' + resume.out.slice(-500))
  } else check('原生 V1：跳过恢复检查（初始父子回合未完成）', false)
  const children = []
  const sessions = join(codexHome, 'sessions')
  if (existsSync(sessions)) {
    for (const file of await readdir(sessions, { recursive: true })) {
      if (!file.endsWith('.jsonl')) continue
      const events = (await readFile(join(sessions, file), 'utf8')).trim().split('\n').map(JSON.parse)
      const meta = events.find((event) => event.type === 'session_meta')?.payload
      if (parentId && meta?.source?.subagent?.thread_spawn?.parent_thread_id === parentId) children.push(events)
    }
  }
  check('原生 V1：Codex 原生日志仅有一个关联 child id，且包含两个 turn',
    children.length === 1 && new Set(children[0].filter((event) => event.type === 'turn_context').map((event) => event.payload.turn_id)).size === 2,
    'children=' + children.length + ' turns=' + (children[0]?.filter((event) => event.type === 'turn_context').length || 0))
  if (result.code !== 0 || !state.receivedBoth) console.log('V1 diagnostics:', result.out.slice(-2200), result.err.slice(-800))
}

async function runSwitchingFixture() {
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
  check('第2轮：无历史 502 candidate-pool 回归（M2-3 22/27）', r2.code === 0 && !/502|candidate pool|候选池无可用项/i.test(r2.out + r2.err), (r2.err || r2.out).slice(-300))
  check('第2轮：上游收到原模型名而不是聚合 slug', third.hits.length > 0 && third.hits.every((h) => h.body.model === THIRD_MODEL), JSON.stringify(third.hits.map((h) => h.body.model)))

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
  check('v2 密文：400 显式拒绝', v2res.status === 400 && /opaque_agent_message|v2_encrypted_task_unsupported/.test(v2text), 'status=' + v2res.status + ' body=' + v2text.slice(0, 300))
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
}

try {
  await assertLockedVersion(env, cwd)
  if (NATIVE_V1) await runNativeV1Fixture()
  else if (NATIVE_V2) await runNativeV2Fixture()
  else {
    console.log('v2LifecycleManifest=' + JSON.stringify({ version: LOCKED_CODEX_VERSION, cases: V2_CASES.length, status: 'FIXTURE_PREPARED', execution: 'Q02' }))
    await runSwitchingFixture()
  }
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
