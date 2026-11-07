// 真实 Codex CLI → ModelGate → 本地 mock 上游：零外部 API 调用、零费用、不读 ~/.codex/auth.json。
// 场景：1) Chat 桥接文本 2) Chat 桥接工具闭环（exec_command） 3) 原生 Responses 直通文本。
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { startGateway, mockUpstream, sseStart, sseWrite, CLIENT } from '../offline/harness.mjs'

import { homedir } from 'node:os'
const CODEX = process.env.MG_CODEX_BIN || join(homedir(), 'ai/harness/codex/cli/versions/current/vendor/x86_64-unknown-linux-musl/bin/codex')
if (!existsSync(CODEX)) { console.log('SKIP  未找到 Codex 二进制: ' + CODEX); process.exit(0) }
const scratch = join(process.cwd(), '.tmp-cfgdir'); mkdirSync(scratch, { recursive: true })

function runCodex(port, prompt, sandbox = 'read-only', timeoutMs = 120000) {
  const home = mkdtempSync(join(scratch, 'codex-home-'))
  const work = mkdtempSync(join(scratch, 'codex-work-'))
  writeFileSync(join(home, 'config.toml'), `model = "codex-bridge"\nmodel_provider = "mg"\napproval_policy = "never"\n[model_providers.mg]\nname = "ModelGate"\nbase_url = "http://127.0.0.1:${port}/v1"\nenv_key = "MG_CODEX_API_KEY"\nwire_api = "responses"\nrequires_openai_auth = false\n`)
  const env = Object.assign({}, process.env, { CODEX_HOME: home, MG_CODEX_API_KEY: CLIENT, RUST_LOG: 'error' })
  delete env.OPENAI_API_KEY; delete env.OPENAI_BASE_URL
  return new Promise((resolve) => {
    // 工具闭环场景用 danger-full-access：本机嵌套 sandbox 无法创建 user namespace，
    // Codex 自带的 bwrap 会拒绝执行（read-only 场景仍保留默认沙箱）
    const p = spawn(CODEX, ['exec', '--skip-git-repo-check', '-s', sandbox, '-C', work, prompt], { env, cwd: work, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    const t = setTimeout(() => { try { p.kill('SIGKILL') } catch {} }, timeoutMs)
    p.stdout.on('data', d => { out += d }); p.stderr.on('data', d => { err += d })
    p.on('close', (code, signal) => {
      clearTimeout(t)
      try { rmSync(home, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }) } catch {}
      resolve({ code, signal, out, err })
    })
  })
}

const results = []
function check(name, ok, detail) {
  results.push(!!ok)
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? ' :: ' + JSON.stringify(detail) : ''))
}

// ---------- 场景 1/2：Chat 桥接（上游 mock 只说 Chat SSE） ----------
async function chatWireScenario(toolLoop) {
  const captures = []
  let turn = 0
  const upstream = await mockUpstream((req, res, body) => {
    const j = JSON.parse(body || '{}')
    captures.push(j); turn++
    sseStart(res)
    if (toolLoop && turn === 1) {
      sseWrite(res, { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_codex_1', function: { name: 'exec_command', arguments: '{"cmd":"echo codex-tool-ok"}' } }] } }] })
      sseWrite(res, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } })
      sseWrite(res, '[DONE]'); res.end(); return
    }
    const text = toolLoop ? 'tool-loop-done' : 'codex-gateway-ok'
    sseWrite(res, { choices: [{ index: 0, delta: { role: 'assistant', content: text } }] })
    sseWrite(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } })
    sseWrite(res, '[DONE]'); res.end()
  })
  const gw = await startGateway({
    defaults: { retry: { maxAttempts: 1, initialDelayMs: 10, maxDelayMs: 20 }, timeout: { connectMs: 3000, firstByteMs: 10000, idleMs: 8000, loopMs: 15000 } },
    providers: { mock: { baseUrl: upstream.url, apiKeyEnv: '', api: 'openai' } },
    models: { 'codex-bridge': { provider: 'mock', responsesWire: 'chat' } },
  })
  const r = await runCodex(gw.port, toolLoop ? 'Run echo codex-tool-ok, then reply tool-loop-done.' : 'Reply with exactly: hi', toolLoop ? 'danger-full-access' : 'read-only')
  const tools = (captures[0] && captures[0].tools || []).map(t => t.function ? t.function.name : t.type)
  const allTools = captures.flatMap(c => (c.messages || []).filter(m => m.role === 'tool'))
  const toolMsg = allTools.length > 0 && allTools.every(m => m.tool_call_id) && allTools.some(m => /codex-tool-ok/.test(String(m.content)))
  await gw.close(); await upstream.close()
  return { r, captures, tools, toolMsg, allTools }
}

{
  const { r, captures, tools } = await chatWireScenario(false)
  check('Codex 实机·Chat 桥接文本', r.code === 0 && /codex-gateway-ok/.test(r.out), { exit: r.code, out: r.out.trim().slice(0, 120), stderr: r.code ? r.err.trim().split('\n').slice(-3).join(' | ').slice(0, 400) : undefined })
  check('Codex namespace 工具被展开为 function', tools.some(n => n === 'multi_agent_v1.close_agent') && tools.includes('exec_command'), { count: tools.length })
  check('web_search 被显式省略（不伪造）', !tools.includes('web_search'), { tools })
  check('上游收到流式 Responses→Chat 请求', captures.length === 1 && captures[0].stream === true, { n: captures.length })
  check('网关注入 stream_options.include_usage', !!(captures[0] && captures[0].stream_options && captures[0].stream_options.include_usage), {})
}
{
  const { r, captures, toolMsg, allTools } = await chatWireScenario(true)
  check('Codex 实机·exec_command 工具闭环', r.code === 0 && /tool-loop-done/.test(r.out) && captures.length >= 2, { exit: r.code, turns: captures.length, out: r.out.trim().slice(0, 120) })
  check('工具结果以 role=tool + call_id 回传上游', toolMsg, { toolMsgs: allTools.map(m => ({ call_id: m.tool_call_id, content: String(m.content).slice(0, 200) })) })
  const asst = captures.find(c => (c.messages || []).some(m => m.role === 'assistant' && m.tool_calls))
  const tc = asst && asst.messages.find(m => m.role === 'assistant' && m.tool_calls).tool_calls[0]
  check('tool_calls call_id 与参数保真', !!tc && tc.id === 'call_codex_1' && JSON.parse(tc.function.arguments).cmd === 'echo codex-tool-ok', { tc })
}

// ---------- 场景 3：原生 Responses 直通 ----------
{
  let nativeHits = 0
  const upstream = await mockUpstream((req, res, body) => {
    nativeHits++
    const j = JSON.parse(body || '{}')
    sseStart(res)
    const id = 'resp_native_1'
    res.write('event: response.created\ndata: ' + JSON.stringify({ type: 'response.created', sequence_number: 0, response: { id, status: 'in_progress', output: [] } }) + '\n\n')
    res.write('event: response.in_progress\ndata: ' + JSON.stringify({ type: 'response.in_progress', sequence_number: 1, response: { id, status: 'in_progress', output: [] } }) + '\n\n')
    res.write('event: response.output_item.added\ndata: ' + JSON.stringify({ type: 'response.output_item.added', sequence_number: 2, output_index: 0, item: { id: 'msg_n1', type: 'message', status: 'in_progress', role: 'assistant', content: [] } }) + '\n\n')
    res.write('event: response.content_part.added\ndata: ' + JSON.stringify({ type: 'response.content_part.added', sequence_number: 3, item_id: 'msg_n1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }) + '\n\n')
    res.write('event: response.output_text.delta\ndata: ' + JSON.stringify({ type: 'response.output_text.delta', sequence_number: 4, item_id: 'msg_n1', output_index: 0, content_index: 0, delta: 'native-codex-ok' }) + '\n\n')
    res.write('event: response.output_text.done\ndata: ' + JSON.stringify({ type: 'response.output_text.done', sequence_number: 5, item_id: 'msg_n1', output_index: 0, content_index: 0, text: 'native-codex-ok' }) + '\n\n')
    const part = { type: 'output_text', text: 'native-codex-ok', annotations: [] }
    res.write('event: response.content_part.done\ndata: ' + JSON.stringify({ type: 'response.content_part.done', sequence_number: 6, item_id: 'msg_n1', output_index: 0, content_index: 0, part }) + '\n\n')
    const item = { id: 'msg_n1', type: 'message', status: 'completed', role: 'assistant', content: [part] }
    res.write('event: response.output_item.done\ndata: ' + JSON.stringify({ type: 'response.output_item.done', sequence_number: 7, output_index: 0, item }) + '\n\n')
    res.write('event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', sequence_number: 8, response: { id, status: 'completed', model: j.model, output: [item], usage: { input_tokens: 5, output_tokens: 4, total_tokens: 9 } } }) + '\n\n')
    res.end()
  })
  const gw = await startGateway({
    defaults: { retry: { maxAttempts: 1, initialDelayMs: 10, maxDelayMs: 20 }, timeout: { connectMs: 3000, firstByteMs: 10000, idleMs: 8000, loopMs: 15000 } },
    providers: { nat: { baseUrl: upstream.url, apiKeyEnv: '', api: 'responses' } },
    models: { 'codex-bridge': { provider: 'nat', responsesWire: 'native', upstreamModel: 'real-upstream-codex' } },
  })
  const r = await runCodex(gw.port, 'Reply with exactly: hi')
  check('Codex 实机·原生 Responses 直通', r.code === 0 && /native-codex-ok/.test(r.out) && nativeHits === 1, { exit: r.code, hits: nativeHits, out: r.out.trim().slice(0, 120), stderr: r.code ? r.err.trim().split('\n').slice(-3).join(' | ').slice(0, 400) : undefined })
  await gw.close(); await upstream.close()
}

const pass = results.filter(Boolean).length
console.log('\n=== Codex 实机结果: ' + pass + '/' + results.length + ' 通过 ===')
process.exit(pass === results.length ? 0 : 1)
