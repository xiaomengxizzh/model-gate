// MG-017-T4 · Codex 原生 Multi-Agent V2 生命周期离线套件
//
// 门禁：默认（不设 MG_CODEX_V2）只跑本文件顶部的纯编排/解析快测，不启动任何子进程，
//       因此默认 npm test 不会因缺少本机 Codex 二进制而变慢或变脆。
//       设置 MG_CODEX_V2=1 才运行真实原版 CLI（0.167.0）与 bundled app-server（0.167.0-alpha.3.2）。
// 边界：mock 只编排**模型输出**（Responses SSE）；线程、父子关系、任务路径、完成通知、并发/审批/取消
//       全部由原版 Codex 生成。本套件属"离线生命周期 / 组件验收"，不是真实上游验收。
// 环境：不需要新增依赖；不读写用户 ~/.codex（用 mkdtemp 隔离 CODEX_HOME，结束即清理）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import {
  catalogPath,
  configToml,
  makeSandbox,
  writeHome,
  runCli,
  threadId,
  agentMessages,
  readRollouts,
  startAppServer,
  phaseBExecArgs,
  phaseBGatewayConfig,
  CLI_BIN,
  APP_SERVER_BIN,
} from './codex-v2-fixtures/codex-cli.mjs'
import { startGateway } from './harness.mjs'
import {
  startMockUpstream,
  lifecycleDirector,
  queueDirector,
  recursionDirector,
  concurrencyDirector,
  approvalDirector,
  followupDirector,
  cancelDirector,
  phasebOpenaiDirector,
  phasebDeepseekDirector,
  buildContext,
  buildSseFrames,
  actionToItem,
  agentMessagePayload,
  toolOutputBody,
  GPT_MODEL,
  DEEPSEEK_MODEL,
} from './codex-v2-fixtures/mock-upstream.mjs'

const GATE = process.env.MG_CODEX_V2 === '1'
const SKIP_REAL = GATE ? false : '需要 MG_CODEX_V2=1（真实本机 Codex CLI / bundled app-server）'

const gated = (name, fn, timeout = 150000) => test(name, { skip: SKIP_REAL, timeout }, fn)

// 每个真实子用例都用独立 mock + 独立 CODEX_HOME，结束即清理。
async function withScenario({ director, state = {}, seed = {}, homeExtra = [], sandboxMode = 'read-only' }, fn) {
  const mock = await startMockUpstream({ director, state })
  const sandbox = await makeSandbox()
  const seedPaths = {}
  try {
    const { writeFile } = await import('node:fs/promises')
    for (const [name, body] of Object.entries(seed)) {
      const p = join(sandbox.workspace, name)
      await writeFile(p, body)
      seedPaths[name] = p
    }
    mock.state.seedPath = seedPaths['seed.txt'] || join(sandbox.workspace, 'seed.txt')
    mock.state.seed2Path = seedPaths['seed2.txt'] || join(sandbox.workspace, 'seed2.txt')
    mock.state.writeTarget = join(sandbox.workspace, 'written.txt')
    await writeHome(sandbox, { baseUrl: mock.base, extra: homeExtra, sandboxMode })
    return await fn({ mock, sandbox, seedPaths })
  } finally {
    await mock.stop()
    await sandbox.cleanup()
  }
}

function cliArgs(sandbox, prompt, { sandboxMode = 'read-only', extraArgs = [] } = {}) {
  return [
    'exec',
    '--skip-git-repo-check',
    '-s',
    sandboxMode,
    '-C',
    sandbox.workspace,
    '-c',
    'model_catalog_json=' + catalogPath,
    '-c',
    'features.multi_agent_v2=true',
    ...extraArgs,
    '--json',
    prompt,
  ]
}

function resumeArgs(sandbox, sid, prompt) {
  return ['exec', 'resume', '--skip-git-repo-check', '-c', 'model_catalog_json=' + catalogPath, '-c', 'features.multi_agent_v2=true', '--json', sid, prompt]
}

function turnMetaOf(record) {
  const meta = (record.body && record.body.client_metadata) || {}
  try { return JSON.parse(meta['x-codex-turn-metadata'] || '{}') } catch { return {} }
}

// ——————————————————————————————————————————————————————————————
// 快测（默认门禁）：纯解析/编排，不启动子进程
// ——————————————————————————————————————————————————————————————

test('fixture 目录：双模型均声明 multi_agent_version="v2" 且满足契约 §6 必填字段', async () => {
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'))
  assert.ok(Array.isArray(catalog.models) && catalog.models.length === 2)
  const required = ['slug', 'display_name', 'supported_reasoning_levels', 'shell_type', 'visibility', 'supported_in_api', 'priority', 'support_verbosity', 'truncation_policy', 'experimental_supported_tools']
  for (const model of catalog.models) {
    for (const key of required) assert.ok(key in model, model.slug + ' 缺 ' + key)
    assert.equal(model.multi_agent_version, 'v2', model.slug + ' 必须显式声明 V2（递归门槛）')
    assert.ok(model.base_instructions, '必须给 base_instructions')
    assert.equal(model.use_responses_lite, false)
    assert.equal(model.prefer_websockets, false)
  }
  assert.deepEqual(catalog.models.map((m) => m.slug), [GPT_MODEL, DEEPSEEK_MODEL])
})

test('快测：lifecycle 编排按 model+input 判态，乱序到达仍确定性推进', () => {
  const state = {}
  const rootPrompt = { headers: {}, body: { model: GPT_MODEL, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] }] } }
  const spawn = lifecycleDirector(buildContext(rootPrompt, state))
  assert.equal(spawn.kind, 'collab')
  assert.equal(spawn.name, 'spawn_agent')
  assert.equal(spawn.args.model, DEEPSEEK_MODEL, '子代理模型由 spawn_agent.model 指定')
  assert.equal(spawn.args.fork_turns, 'none')
  assert.match(spawn.args.message, /A-NONCE-/, '任务正文携带 root 侧 nonce A')

  const spawnItem = actionToItem(spawn, 0)
  assert.equal(spawnItem.namespace, 'collaboration')
  assert.deepEqual(spawnItem.encrypted_function_args, [])

  const rootAfterSpawn = { headers: {}, body: { model: GPT_MODEL, input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] },
    spawnItem,
    { type: 'function_call_output', call_id: spawnItem.call_id, output: JSON.stringify({ task_name: '/root/worker' }) },
  ] } }
  const wait = lifecycleDirector(buildContext(rootAfterSpawn, state))
  assert.equal(wait.kind, 'collab')
  assert.equal(wait.name, 'wait_agent', 'spawn 结果返回后 root 进入原生等待')

  const childTask = { headers: {}, body: { model: DEEPSEEK_MODEL, input: [
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'child' }] },
    { type: 'agent_message', author: '/root', recipient: '/root/worker', content: [{ type: 'input_text', text: 'Message Type: NEW_TASK\nTask name: /root/worker\nSender: /root\nPayload:\nRead seed. nonce A=A-NONCE-abc123' }] },
  ] } }
  const tool = lifecycleDirector(buildContext(childTask, state))
  assert.equal(tool.kind, 'tool')
  assert.equal(tool.name, 'exec_command')
  assert.equal(tool.namespace, undefined, '普通工具调用绝不能带 namespace')

  const childAfterTool = { headers: {}, body: { model: DEEPSEEK_MODEL, input: [
    { type: 'agent_message', author: '/root', recipient: '/root/worker', content: [{ type: 'input_text', text: 'Payload:\nRead seed. nonce A=A-NONCE-abc123' }] },
    { type: 'function_call_output', call_id: tool.callId, output: 'Chunk ID: x\nOutput:\nB-NONCE-disk\n' },
  ] } }
  const childReport = lifecycleDirector(buildContext(childAfterTool, state))
  assert.equal(childReport.kind, 'text')
  assert.match(childReport.text, /nonceA=A-NONCE-abc123/)
  assert.match(childReport.text, /nonceB=B-NONCE-disk/)

  const rootNotified = { headers: {}, body: { model: GPT_MODEL, input: [
    spawnItem,
    { type: 'function_call_output', call_id: spawnItem.call_id, output: '{"task_name":"/root/worker"}' },
    actionToItem(wait, 1),
    { type: 'function_call_output', call_id: wait.callId, output: '{"message":"Wait completed.","timed_out":false}' },
    { type: 'agent_message', author: '/root/worker', recipient: '/root', content: [{ type: 'input_text', text: 'Message Type: FINAL_ANSWER\nPayload:\n' + childReport.text }] },
  ] } }
  const final = lifecycleDirector(buildContext(rootNotified, state))
  assert.equal(final.kind, 'text')
  assert.match(final.text, /ROOT_FINAL payload=CHILD_REPORT/, '完成通知由 Codex 原生回灌 root')

  // 乱序：子线程请求先到也不会改变 root 侧判定（判定只看本线程 model+input）
  const lateRoot = lifecycleDirector(buildContext(rootAfterSpawn, state))
  assert.deepEqual(lateRoot, wait)
})

test('快测：SSE 最小可执行帧序与工具项形状（协作工具带 namespace+空 marker，普通工具不带）', () => {
  const collab = actionToItem({ kind: 'collab', name: 'spawn_agent', args: { task_name: 'w' }, callId: 'call_1' }, 0)
  const tool = actionToItem({ kind: 'tool', name: 'exec_command', args: { cmd: 'pwd' }, callId: 'call_2' }, 1)
  const frames = buildSseFrames([collab, tool], { model: GPT_MODEL })
  const events = frames.split('\n\n').filter(Boolean).map((block) => {
    const data = block.split('\n').find((l) => l.startsWith('data: '))
    return JSON.parse(data.slice('data: '.length))
  })
  assert.deepEqual(events.map((e) => e.type), [
    'response.created',
    'response.output_item.added',
    'response.output_item.done',
    'response.output_item.added',
    'response.output_item.done',
    'response.completed',
  ])
  const addedCollab = events[1].item
  assert.equal(addedCollab.namespace, 'collaboration')
  assert.deepEqual(addedCollab.encrypted_function_args, [])
  assert.equal(events[3].item.namespace, undefined, '普通工具项不得带 namespace')
  assert.equal(events[5].response.output.length, 2)
  assert.equal(events[5].response.usage.total_tokens, 12)
})

test('快测：隔离 config.toml 单 provider + 显式 V2，且不含任何明文密钥', () => {
  const toml = configToml({ baseUrl: 'http://127.0.0.1:1234', extra: ['features.multi_agent_v2.max_concurrent_threads_per_session = 1'] })
  assert.match(toml, /model_provider = "mgmock"/)
  assert.match(toml, /wire_api = "responses"/)
  assert.match(toml, /features\.multi_agent_v2 = true/)
  assert.match(toml, /env_key = "MG_CODEX_V2_FAKE_KEY"/)
  assert.equal((toml.match(/\[model_providers\./g) || []).length, 1, '只允许一个 provider（单 provider 前提）')
  assert.doesNotMatch(toml, /sk-[A-Za-z0-9]{8,}/, '配置里不得写明文 Key')
})

test('快测：原生委派正文与工具输出解析（仅文本切分，不改写）', () => {
  const item = { type: 'agent_message', content: [{ type: 'input_text', text: 'Message Type: NEW_TASK\nTask name: /root/worker\nSender: /root\nPayload:\n读文件并回复' }] }
  assert.equal(agentMessagePayload(item), '读文件并回复')
  assert.equal(toolOutputBody('Chunk ID: 1\nWall time: 0.0\nOutput:\nB-NONCE\n'), 'B-NONCE\n')
  assert.equal(toolOutputBody('plain'), 'plain')
})

// ——————————————————————————————————————————————————————————————
// 真实 CLI 子用例（MG_CODEX_V2=1）
// ——————————————————————————————————————————————————————————————

gated('CLI：spawn → 子代理真实工具读 nonce B → 完成通知回 root（跨模型、fork_turns:none）', async () => {
  const NONCE_B = 'B-NONCE-lifecycle-7788'
  await withScenario({ director: lifecycleDirector, state: {}, seed: { 'seed.txt': NONCE_B + '\n' } }, async ({ mock, sandbox }) => {
    const res = await runCli({ home: sandbox.home, workspace: sandbox.workspace, args: cliArgs(sandbox, 'Spawn a worker subagent that reads the seed file, then report.'), timeoutMs: 120000 })
    assert.equal(res.code, 0, '原版 CLI 退出码（stderr 尾部：' + res.stderr.slice(-300) + '）')
    assert.equal(res.timedOut, false)

    const rootSid = threadId(res.events)
    assert.match(rootSid, /^[0-9a-f-]{36}$/)

    const rootReqs = mock.requestsFor(GPT_MODEL)
    const childReqs = mock.requestsFor(DEEPSEEK_MODEL)
    assert.ok(rootReqs.length >= 2, 'root 至少 2 个模型请求')
    assert.ok(childReqs.length >= 2, '子线程至少 2 个模型请求（工具前/后）')

    // 工具声明形状：协作工具在单个 namespace 下，普通工具扁平且不带 namespace。
    const tools = rootReqs[0].body.tools || []
    const collab = tools.find((t) => t.type === 'namespace' && t.name === 'collaboration')
    assert.ok(collab, '必须声明原生 collaboration namespace')
    const names = collab.tools.map((t) => t.name).sort()
    assert.deepEqual(names, ['followup_task', 'interrupt_agent', 'list_agents', 'send_message', 'spawn_agent', 'wait_agent'])
    const spawnDecl = collab.tools.find((t) => t.name === 'spawn_agent')
    assert.equal(spawnDecl.parameters.properties.message.encrypted, true, '原生声明里 message 带 encrypted 标注')
    assert.ok(!collab.tools.some((t) => t.name === 'exec_command'), '普通工具不在 collaboration 内')

    // 子线程身份：同一 child thread、parent=root、agent path=/root/worker（depth 只在 rollout 的
    // session_meta.source.subagent.thread_spawn 里，不在请求 turn metadata 里）。
    const childThreads = new Set(childReqs.map((r) => turnMetaOf(r).thread_id))
    assert.equal(childThreads.size, 1, '所有子线程请求来自同一个 child thread')
    const childTid = [...childThreads][0]
    assert.notEqual(childTid, rootSid)
    for (const r of childReqs) {
      const meta = turnMetaOf(r)
      assert.equal(meta.parent_thread_id, rootSid)
      assert.equal(meta.agent_name, '/root/worker')
      assert.equal(meta.subagent_kind, 'thread_spawn')
      assert.equal(r.headers['x-openai-subagent'], 'collab_spawn')
      assert.equal(r.headers['x-codex-parent-thread-id'], rootSid)
    }
    assert.ok(childReqs.some((r) => (r.body.input || []).some((i) => i.type === 'agent_message' && i.recipient === '/root/worker')), '委派以原生 agent_message 下发')

    // nonce B 只经子代理工具结果进入，之后才随原生完成通知回到 root（root prompt 不含 B）。
    const rootWithoutNotification = rootReqs.filter((r) => !JSON.stringify(r.body.input || []).includes('"agent_message"'))
    assert.ok(rootWithoutNotification.length >= 2)
    for (const r of rootWithoutNotification) {
      assert.equal(JSON.stringify(r.body.input).includes(NONCE_B), false, 'nonce B 不得出现在 root 未收到通知前的上下文')
    }
    const finalTexts = agentMessages(res.events)
    assert.ok(finalTexts.length >= 1)
    const final = finalTexts[finalTexts.length - 1]
    assert.match(final, /ROOT_FINAL payload=CHILD_REPORT/)
    assert.match(final, /nonceA=A-NONCE-[a-z0-9]+/, 'root 侧 nonce A 出现在最终答复')
    assert.ok(final.includes(NONCE_B), 'nonce B 经完成通知回到 root')
    assert.ok(res.events.some((e) => e.item && e.item.type === 'collab_tool_call' && e.item.tool === 'wait'), 'wait 是原生协作工具调用')

    // 原生 rollout（Codex 自己写的，不是夹具伪造）核对身份与模型。
    const rollouts = await readRollouts(sandbox.home)
    assert.equal(rollouts.length, 2, 'root + child 各一份 rollout')
    const childRollout = rollouts.find((r) => r.meta && r.meta.parent_thread_id === rootSid)
    assert.ok(childRollout, 'child rollout 记录 parent_thread_id')
    assert.equal(childRollout.meta.agent_path, '/root/worker')
    assert.equal(childRollout.meta.source.subagent.thread_spawn.depth, 1)
    assert.equal(childRollout.firstTurn.model, DEEPSEEK_MODEL, 'turn_context 的模型是实际路由模型')
    const rootRollout = rollouts.find((r) => r.meta && r.meta.id === rootSid)
    assert.equal(rootRollout.firstTurn.model, GPT_MODEL)
    assert.equal(rootRollout.meta.multi_agent_version, 'v2')
  })
})

gated('CLI：闲置目标 send_message 只排队，不误启动新 turn（wait 超时而非唤醒）', async () => {
  await withScenario({ director: queueDirector, state: {}, seed: { 'seed.txt': 'B-NONCE-queue\n' } }, async ({ mock, sandbox }) => {
    const res = await runCli({ home: sandbox.home, workspace: sandbox.workspace, args: cliArgs(sandbox, 'Spawn a worker, wait for it, then queue a message.'), timeoutMs: 150000 })
    assert.equal(res.code, 0, res.stderr.slice(-300))
    const childReqs = mock.requestsFor(DEEPSEEK_MODEL)
    assert.equal(childReqs.length, 2, '排队消息不得让闲置子代理起新 turn（仍为任务+工具两请求）')
    const final = agentMessages(res.events).pop() || ''
    assert.match(final, /ROOT_FINAL send=/)
    // 工具输出里的 JSON 在内层又被转义了一层，先解一层转义再判读。
    const unwrapped = final.replace(/\\"/g, '"')
    assert.match(unwrapped, /"timed_out":true/, '第二次 wait 因无活动超时（排队消息不唤醒闲置目标）')
  })
})

gated('CLI：递归 /root/worker/grandchild（DeepSeek worker → GPT grandchild）', async () => {
  await withScenario({ director: recursionDirector, state: { grandchildModel: GPT_MODEL }, seed: { 'seed.txt': 'B1\n', 'seed2.txt': 'B2-GRAND\n' } }, async ({ mock, sandbox }) => {
    const res = await runCli({ home: sandbox.home, workspace: sandbox.workspace, args: cliArgs(sandbox, 'Delegate two levels deep.'), timeoutMs: 150000 })
    assert.equal(res.code, 0, res.stderr.slice(-300))
    const rootSid = threadId(res.events)
    const byAgent = new Map()
    for (const r of mock.received.filter((x) => x.method === 'POST')) {
      const meta = turnMetaOf(r)
      if (!byAgent.has(meta.agent_name)) byAgent.set(meta.agent_name, { models: new Set(), threads: new Set(), parents: new Set() })
      const rec = byAgent.get(meta.agent_name)
      rec.models.add(r.body.model)
      rec.threads.add(meta.thread_id)
      rec.parents.add(meta.parent_thread_id)
    }
    assert.deepEqual([...byAgent.keys()].sort(), ['/root', '/root/worker', '/root/worker/grandchild'])
    assert.deepEqual([...byAgent.get('/root').models], [GPT_MODEL])
    assert.deepEqual([...byAgent.get('/root/worker').models], [DEEPSEEK_MODEL])
    assert.deepEqual([...byAgent.get('/root/worker/grandchild').models], [GPT_MODEL], '孙代理模型来自 catalog 的 GPT 条目')
    const workerTid = [...byAgent.get('/root/worker').threads][0]
    assert.equal([...byAgent.get('/root/worker/grandchild').parents][0], workerTid)
    assert.equal([...byAgent.get('/root/worker').parents][0], rootSid)
    const final = agentMessages(res.events).pop() || ''
    assert.match(final, /ROOT_FINAL payload=WORKER_FINAL GRANDCHILD_REPORT/)
    assert.match(final, /B2-GRAND/, '孙代理结果沿原生链回流到 root')
    const rollouts = await readRollouts(sandbox.home)
    assert.equal(rollouts.length, 3)
    assert.ok(rollouts.some((r) => r.meta && r.meta.agent_path === '/root/worker/grandchild' && r.meta.source.subagent.thread_spawn.depth === 2))
  })
})

gated('CLI：并发上限由原生运行时拒绝（max_concurrent_threads_per_session=1）', async () => {
  await withScenario({ director: concurrencyDirector, state: {} }, async ({ mock, sandbox }) => {
    const args = cliArgs(sandbox, 'Spawn two workers.', { extraArgs: ['-c', 'features.multi_agent_v2.max_concurrent_threads_per_session=1'] })
    const res = await runCli({ home: sandbox.home, workspace: sandbox.workspace, args, timeoutMs: 120000 })
    assert.equal(res.code, 0, res.stderr.slice(-400))
    const final = agentMessages(res.events).pop() || ''
    assert.match(final, /agent thread limit reached/, '原生并发上限拒绝，而不是网关/模型侧拒绝')
    assert.equal(mock.requestsFor(DEEPSEEK_MODEL).length, 0, '被拒绝的 spawn 不产生子线程模型请求')
  })
})

gated('CLI：审批/沙箱 —— read-only 拒绝写操作，workspace-write 放行（同一夹具对照）', async () => {
  // read-only：原生沙箱拒绝，文件不落地
  await withScenario({ director: approvalDirector, state: {} }, async ({ sandbox }) => {
    const res = await runCli({ home: sandbox.home, workspace: sandbox.workspace, args: cliArgs(sandbox, 'Spawn a worker that tries to write.'), timeoutMs: 120000 })
    assert.equal(res.code, 0, res.stderr.slice(-300))
    const final = agentMessages(res.events).pop() || ''
    assert.match(final, /Read-only file system/, 'read-only 沙箱的原生拒绝文本')
    assert.match(final, /Process exited with code 1/)
    await assert.rejects(() => stat(join(sandbox.workspace, 'written.txt')), '写操作没有落地')
  })
  // workspace-write：无审批提示（approval_policy=never）但沙箱放宽后允许写入
  await withScenario({ director: approvalDirector, state: {}, sandboxMode: 'workspace-write' }, async ({ sandbox }) => {
    const res = await runCli({ home: sandbox.home, workspace: sandbox.workspace, args: cliArgs(sandbox, 'Spawn a worker that tries to write.', { sandboxMode: 'workspace-write' }), timeoutMs: 120000 })
    assert.equal(res.code, 0, res.stderr.slice(-300))
    const final = agentMessages(res.events).pop() || ''
    assert.match(final, /WROTE/)
    assert.match(final, /Process exited with code 0/)
    assert.equal((await readFile(join(sandbox.workspace, 'written.txt'), 'utf8')), 'HELLO')
  })
})

gated('CLI：冷恢复（同 root SID + 同 child thread + 历史重放 + followup_task 新 turn）', async () => {
  await withScenario({ director: followupDirector, state: {} }, async ({ mock, sandbox }) => {
    const first = await runCli({ home: sandbox.home, workspace: sandbox.workspace, args: cliArgs(sandbox, 'Spawn a worker and finish.'), timeoutMs: 120000 })
    assert.equal(first.code, 0, first.stderr.slice(-300))
    const rootSid = threadId(first.events)
    const childReqs1 = mock.requestsFor(DEEPSEEK_MODEL)
    assert.equal(childReqs1.length, 1, '首轮子代理一个回合')
    const childTid = turnMetaOf(childReqs1[0]).thread_id
    const rootReqs1Count = mock.requestsFor(GPT_MODEL).length

    const second = await runCli({ home: sandbox.home, workspace: sandbox.workspace, args: resumeArgs(sandbox, rootSid, 'Follow up with the worker.'), timeoutMs: 120000 })
    assert.equal(second.code, 0, second.stderr.slice(-400))
    assert.equal(threadId(second.events), rootSid, 'resume 复用同一 root SID')

    const childReqs2 = mock.requestsFor(DEEPSEEK_MODEL).slice(childReqs1.length)
    assert.equal(childReqs2.length, 1, 'followup_task 在既有 child 上起一个 turn')
    assert.equal(turnMetaOf(childReqs2[0]).thread_id, childTid, '恢复后的 turn 落在原 child thread')

    // 历史重放：取 resume 之后的 root 请求（不能按正文 'FINAL_ANSWER' 搜索——工具说明里也有该词），
    // 断言它带上一轮完成通知与原生工具调用配对。
    const resumedRoot = mock.requestsFor(GPT_MODEL).slice(rootReqs1Count).find((r) => (r.body.input || []).some((i) => i.type === 'agent_message'))
    assert.ok(resumedRoot, 'resume 请求带上一轮完成通知（历史重放）')
    const items = resumedRoot.body.input || []
    const replayedSpawn = items.find((i) => i.type === 'function_call' && i.name === 'spawn_agent')
    assert.ok(replayedSpawn, '重放保留 spawn_agent 调用')
    assert.equal(replayedSpawn.namespace, 'collaboration', '重放保留 collaboration namespace')
    // 实测：自定义 provider 的出站构造会清掉 encrypted_function_args 扩展；网关不得依赖重放 marker。
    if ('encrypted_function_args' in replayedSpawn) assert.ok(Array.isArray(replayedSpawn.encrypted_function_args))
    assert.ok(items.some((i) => i.type === 'function_call_output' && String(i.call_id).startsWith('call_spawn_')))
    assert.ok(items.some((i) => i.type === 'agent_message' && i.author === '/root/worker'), '重放保留原生完成通知')

    const final = agentMessages(second.events).pop() || ''
    assert.match(final, /ROOT_FINAL payload=CHILD_TURN/, '子代理新 turn 的结果经通知回到 root')
  })
})

// 取消用例使用**原生 interrupt_agent**（Codex 自己的取消 API），不依赖外部信号或精确时序：
// 子代理首回合被 mock 故意拖住，root 在回合内 interrupt，然后 followup 复用同一 child。
// 外部 SIGINT/SIGKILL 在本机实测会出现进程长时间不退出（平台行为），故不作为门禁手段；
// 该结论记录在 fixtures/NOTES.md §11，取消语义由原生工具路径覆盖。
gated('CLI：interrupt_agent 取消运行中的子回合，followup 复用同一 child（无重复投递）', async () => {
  await withScenario({ director: cancelDirector, state: {} }, async ({ mock, sandbox }) => {
    const res = await runCli({ home: sandbox.home, workspace: sandbox.workspace, args: cliArgs(sandbox, 'Spawn a worker, interrupt it, then follow up.'), timeoutMs: 120000 })
    assert.equal(res.code, 0, res.stderr.slice(-400))

    // 取消用例是**时序敏感**的：这里只断言"同一个 child thread 上确实起了后续 turn"，
    // 不依赖精确请求数（interrupt 可能早于/晚于子线程首个模型请求，两种都合法）。
    const childReqs = mock.requestsFor(DEEPSEEK_MODEL)
    assert.ok(childReqs.length >= 1, 'interrupt 后 followup 在 child 上起了新 turn')
    const childThreads = new Set(childReqs.map((r) => turnMetaOf(r).thread_id))
    assert.equal(childThreads.size, 1, '取消与恢复都落在同一个 child thread')

    const final = agentMessages(res.events).pop() || ''
    assert.match(final, /ROOT_FINAL payload=CHILD_AFTER_INTERRUPT/, '被中断的 child 在 followup 后正常产出')
    assert.match(final, /interrupt=/, 'root 拿到了 interrupt_agent 的原生返回')
    assert.match(final, /previous_status/, 'interrupt_agent 返回了被取消目标的状态')
    // 线程状态明确：root 会话与 child 会话都留在原生 rollout 里。
    const rollouts = await readRollouts(sandbox.home)
    assert.equal(rollouts.length, 2, 'root + child 原生 rollout 都在')
    const childRollout = rollouts.find((r) => r.meta && r.meta.parent_thread_id === rollouts.find((x) => !x.meta.parent_thread_id).meta.id)
    assert.ok(childRollout, 'child rollout 记录 parent_thread_id')
    // 稳定窗口：CLI 退出后不应再出现新的子线程请求（无重复投递）。
    const afterExit = mock.requestsFor(DEEPSEEK_MODEL).length
    await new Promise((resolve) => setTimeout(resolve, 1500))
    assert.equal(mock.requestsFor(DEEPSEEK_MODEL).length, afterExit, '进程退出后没有重复投递')
  })
})

// —— Phase B：Codex 单 provider 指向隔离网关，网关按 alias 路由到两个 mock 上游 ——

async function withGatewayScenario({ openaiDirector, deepseekDirector, deepseekState = {}, seed = {} }, fn) {
  const openai = await startMockUpstream({ director: openaiDirector, state: {} })
  const deepseek = await startMockUpstream({ director: deepseekDirector, state: Object.assign({}, deepseekState) })
  const gateway = await startGateway({
    name: 'phaseb',
    config: phaseBGatewayConfig({ openaiBase: openai.base, deepseekBase: deepseek.base }),
    env: { MG_OPENAI_MOCK_KEY: 'sk-openai-mock-fake', MG_DEEPSEEK_MOCK_KEY: 'sk-deepseek-mock-fake' },
  })
  const sandbox = await makeSandbox()
  try {
    const { writeFile } = await import('node:fs/promises')
    for (const [name, body] of Object.entries(seed)) {
      const path = join(sandbox.workspace, name)
      await writeFile(path, body)
      if (name === 'seed.txt') { openai.state.seedPath = path; deepseek.state.seedPath = path }
      if (name === 'seed2.txt') { openai.state.seed2Path = path; deepseek.state.seed2Path = path }
    }
    await writeHome(sandbox, { baseUrl: gateway.base })
    return await fn({ openai, deepseek, gateway, sandbox })
  } finally {
    await gateway.stop()
    await openai.stop()
    await deepseek.stop()
    await sandbox.cleanup()
  }
}

gated('Phase B · CLI 经隔离网关：root(codex-gpt) → spawn(codex-deepseek) → 真实工具读 nonce → 完成通知回 root', async () => {
  const NONCE_B = 'B-NONCE-PHASEB-42'
  await withGatewayScenario({
    openaiDirector: phasebOpenaiDirector,
    deepseekDirector: phasebDeepseekDirector,
    seed: { 'seed.txt': NONCE_B + '\n' },
  }, async ({ openai, deepseek, sandbox, gateway }) => {
    const res = await runCli({ home: sandbox.home, workspace: sandbox.workspace, args: phaseBExecArgs({ sandbox, gatewayBase: gateway.base, prompt: 'Spawn a worker that reads the seed file and reports.' }), timeoutMs: 120000 })
    assert.equal(res.code, 0, 'CLI 经网关退出码（stderr 尾部：' + res.stderr.slice(-400) + '）')
    assert.equal(res.timedOut, false)

    const openaiReqs = openai.requestsFor(GPT_MODEL)
    const deepseekReqs = deepseek.requestsFor(DEEPSEEK_MODEL)
    assert.ok(openaiReqs.length >= 2, 'OpenAI mock 收到 root 的多个回合')
    assert.ok(deepseekReqs.length >= 2, 'DeepSeek mock 收到子线程两个回合（工具前/后）')

    // —— 收据 1：OpenAI 上游 ——
    for (const r of openaiReqs) {
      assert.equal(r.body.model, 'gpt-mock', 'providerModels 覆盖：客户端 codex-gpt → 上游 gpt-mock')
      assert.equal(r.headers.authorization, 'Bearer sk-openai-mock-fake', '只注入该 provider 的服务端凭据')
      assert.equal(r.headers['chatgpt-account-id'], undefined)
      assert.equal('cookie' in r.headers, false)
      assert.equal(r.body.client_metadata, undefined, '客户端元数据不得转发')
      assert.equal(r.body.prompt_cache_key, undefined, 'prompt_cache_key 不得转发')
      const tools = r.body.tools || []
      assert.equal(tools.some((t) => t.type === 'namespace'), false, '工具声明必须扁平化，不能把 namespace 工具原样发给上游')
      const collabNames = tools.filter((t) => ['spawn_agent', 'send_message', 'followup_task', 'wait_agent', 'list_agents', 'interrupt_agent'].includes(t.name)).map((t) => t.name).sort()
      assert.deepEqual(collabNames, ['followup_task', 'interrupt_agent', 'list_agents', 'send_message', 'spawn_agent', 'wait_agent'])
      const spawnDecl = tools.find((t) => t.name === 'spawn_agent')
      assert.equal('encrypted' in (spawnDecl.parameters.properties.message || {}), false, 'message 的 encrypted 标记必须被删除（明文声明）')
    }
    assert.equal(JSON.stringify(openaiReqs[0].body.input).includes(NONCE_B), false, 'root 首回合看不到 nonce B')

    // —— 收据 2：DeepSeek 上游（目的端投影） ——
    for (const r of deepseekReqs) {
      assert.equal(r.body.model, 'deepseek-mock')
      assert.equal(r.headers.authorization, 'Bearer sk-deepseek-mock-fake', 'DeepSeek 路由使用 DeepSeek 凭据')
      assert.equal(r.headers['x-openai-subagent'], undefined, 'Codex 的子代理标记不得透传给上游')
      assert.equal(r.body.client_metadata, undefined)
      assert.equal(r.body.prompt_cache_key, undefined)
      const inputs = r.body.input || []
      assert.equal(inputs.some((i) => i.type === 'agent_message'), false, 'agent_message 必须被投影，不能直达 DeepSeek')
    }
    const deepseekText = JSON.stringify(deepseekReqs[0].body.input)
    assert.ok(deepseekText.includes('[agent_message from=/root to=/root/worker]'), '投影后的 user message 保留可读收发方向')
    assert.ok(deepseekReqs.some((r) => JSON.stringify(r.body.input || []).includes(NONCE_B)), '子代理已用真实本地工具读到 nonce B')

    // —— 原生控制流 ——
    const final = agentMessages(res.events).pop() || ''
    assert.match(final, /ROOT_FINAL payload=CHILD_REPORT/)
    assert.match(final, /nonceA=A-NONCE-PHASEB/)
    assert.ok(final.includes(NONCE_B), 'nonce B 经原生完成通知回到 root')
    assert.ok(res.events.some((e) => e.item && e.item.type === 'collab_tool_call' && e.item.tool === 'wait'), 'wait 由原生 Codex 执行（网关只恢复工具项）')
    assert.match(threadId(res.events), /^[0-9a-f-]{36}$/)
    const rollouts = await readRollouts(sandbox.home)
    assert.equal(rollouts.length, 2, 'root + child 各一份原生 rollout')
  })
})

gated('Phase B · 递归：DeepSeek worker → GPT grandchild，经网关两路上游各收各的模型', async () => {
  await withGatewayScenario({
    openaiDirector: phasebOpenaiDirector,
    deepseekDirector: phasebDeepseekDirector,
    deepseekState: { grandchildModel: 'codex-gpt' },
    seed: { 'seed.txt': 'B1\n', 'seed2.txt': 'B2\n' },
  }, async ({ openai, deepseek, sandbox, gateway }) => {
    const res = await runCli({ home: sandbox.home, workspace: sandbox.workspace, args: phaseBExecArgs({ sandbox, gatewayBase: gateway.base, prompt: 'Delegate two levels deep.' }), timeoutMs: 150000 })
    assert.equal(res.code, 0, res.stderr.slice(-400))
    // 网关会剥掉 client_metadata，所以 Phase B 的身份证据取原生 rollout（Codex 自己写），
    // 上游只按"收到哪个模型"分组。
    const openaiModels = new Set(openai.requestsFor(GPT_MODEL).map((r) => r.body.model))
    const otherOpenai = openai.received.filter((r) => r.method === 'POST' && (!r.body || r.body.model !== GPT_MODEL))
    assert.equal(otherOpenai.length, 0, 'OpenAI mock 只应收到 gpt-mock')
    assert.deepEqual([...openaiModels], [GPT_MODEL])
    const deepseekModels = new Set(deepseek.requestsFor(DEEPSEEK_MODEL).map((r) => r.body.model))
    assert.deepEqual([...deepseekModels], [DEEPSEEK_MODEL])

    const rollouts = await readRollouts(sandbox.home)
    assert.equal(rollouts.length, 3, 'root + worker + grandchild 三份原生 rollout')
    const byPath = new Map(rollouts.map((r) => [r.meta.agent_path || '/root', r]))
    assert.deepEqual([...byPath.keys()].sort(), ['/root', '/root/worker', '/root/worker/grandchild'])
    assert.equal(byPath.get('/root/worker').meta.source.subagent.thread_spawn.depth, 1)
    assert.equal(byPath.get('/root/worker/grandchild').meta.source.subagent.thread_spawn.depth, 2)
    assert.equal(byPath.get('/root/worker/grandchild').meta.source.subagent.thread_spawn.parent_thread_id, byPath.get('/root/worker').meta.id)
    assert.equal(byPath.get('/root/worker').meta.parent_thread_id, byPath.get('/root').meta.id)
    const final = agentMessages(res.events).pop() || ''
    assert.match(final, /ROOT_FINAL payload=WORKER_FINAL GRANDCHILD_OK/)
  })
})

gated('app-server（组件验收）：initialize / model-list / thread-start / turn-start / thread-read', async () => {
  await withScenario({ director: () => ({ kind: 'text', text: 'APPSRV_OK' }), state: {} }, async ({ mock, sandbox }) => {
    const server = await startAppServer({
      home: sandbox.home,
      extraArgs: ['--enable', 'multi_agent_v2', '-c', 'features.multi_agent_v2=true', '-c', 'model_catalog_json=' + catalogPath],
    })
    try {
      const init = await server.request('initialize', { clientInfo: { name: 'mg-lifecycle', title: 'MG Lifecycle', version: '0.0.0' } })
      assert.ok(init.result && init.result.userAgent.includes('0.167.0-alpha.3.2'), 'bundled app-server 版本')
      const models = await server.request('model/list', {})
      const slugs = (models.result.data || []).map((m) => m.model || m.id)
      assert.ok(slugs.includes(GPT_MODEL) && slugs.includes(DEEPSEEK_MODEL), '目录端点返回导入的 V2 模型')

      const started = await server.request('thread/start', { model: GPT_MODEL, cwd: sandbox.workspace })
      const thread = started.result.thread
      assert.match(thread.id, /^[0-9a-f-]{36}$/)
      assert.equal(thread.model, GPT_MODEL)
      assert.equal(thread.modelProvider, 'mgmock')

      const turn = await server.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'say hi' }] })
      assert.equal(turn.result.turn.status, 'inProgress')
      const deadline = Date.now() + 15000
      while (Date.now() < deadline && mock.requestsFor(GPT_MODEL).length === 0) await new Promise((r) => setTimeout(r, 100))
      assert.equal(mock.requestsFor(GPT_MODEL).length >= 1, true, 'turn/start 真的打到隔离 provider')
      assert.equal(mock.requestsFor(GPT_MODEL)[0].body.model, GPT_MODEL)

      const read = await server.request('thread/read', { threadId: thread.id })
      assert.equal(read.result.thread.id, thread.id)
      assert.equal(read.result.thread.preview, 'say hi')
    } finally {
      await server.stop()
    }
  })
})

test('门禁说明：默认只跑快测，真实 CLI 需 MG_CODEX_V2=1', () => {
  if (!GATE) {
    assert.equal(SKIP_REAL, '需要 MG_CODEX_V2=1（真实本机 Codex CLI / bundled app-server）')
  } else {
    assert.match(CLI_BIN, /codex$/)
    assert.match(APP_SERVER_BIN, /codex$/)
  }
})