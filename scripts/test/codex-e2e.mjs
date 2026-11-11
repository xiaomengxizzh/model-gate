#!/usr/bin/env node
// E3 真客户端离线验收：Codex CLI（内置 openai 身份，openai_base_url 指到网关）在同一条线程里
// GPT 模型 → 第三方模型 → GPT 模型，验证网关按模型选择官方/第三方上游，且官方凭据不流向第三方。
// 上游全部是本地 mock（不联网、不产生任何真实官方/付费调用）；CODEX_HOME 必须是临时目录。
//
// 用法：
//   CODEX_HOME=/tmp/xxx node scripts/test/codex-e2e.mjs [--codex <path>] [--keep]
// 退出码 0 = 全部断言通过。

import { spawn } from 'node:child_process'
import http from 'node:http'
import { once } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startGateway } from './offline/harness.mjs'

const CODEX = process.env.CODEX_BIN || '/home/xiaomengxizi/ai/harness/codex/cli/bin/codex'
const OFFICIAL_MODEL = 'gpt-6-astra'
// 聚合 slug 由目录生成器产出：mg-<provider>-<model>（config 里的模型名不含前缀）
const THIRD_CONFIG_MODEL = 'deepseek-v4-flash'
const THIRD_MODEL = 'mg-third-' + THIRD_CONFIG_MODEL

function arg(name, dflt) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt }
const codex = arg('--codex', CODEX)

function sseResponses(res, text, model) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const emit = (e, d) => res.write('event: ' + e + '\ndata: ' + JSON.stringify(d) + '\n\n')
  emit('response.created', { type: 'response.created', response: { id: 'r-' + Date.now(), object: 'response', status: 'in_progress', model, output: [] } })
  emit('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: 'm1', type: 'message', status: 'in_progress', role: 'assistant', content: [] } })
  emit('response.content_part.added', { type: 'response.content_part.added', item_id: 'm1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
  emit('response.output_text.delta', { type: 'response.output_text.delta', item_id: 'm1', output_index: 0, content_index: 0, delta: text })
  emit('response.output_text.done', { type: 'response.output_text.done', item_id: 'm1', output_index: 0, content_index: 0, text })
  emit('response.content_part.done', { type: 'response.content_part.done', item_id: 'm1', output_index: 0, content_index: 0, part: { type: 'output_text', text, annotations: [] } })
  emit('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { id: 'm1', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] } })
  emit('response.completed', { type: 'response.completed', response: { id: 'r-' + Date.now(), object: 'response', status: 'completed', model, output: [{ id: 'm1', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }], usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 } } })
  res.end()
}

async function mockUpstream(kind) {
  const hits = []
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    let body = {}
    try { body = JSON.parse(/gzip/i.test(req.headers['content-encoding'] || '') ? require('node:zlib').gunzipSync(Buffer.concat(chunks)).toString('utf8') : Buffer.concat(chunks).toString('utf8')) } catch {}
    hits.push({ url: req.url, headers: req.headers, bodyLen: Buffer.concat(chunks).length })
    const text = kind + ' ok'
    if (kind === 'official') {
      if ((req.url || '').startsWith('/v1/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ object: 'list', data: [{ id: OFFICIAL_MODEL, object: 'model' }, { id: THIRD_MODEL, object: 'model' }] })) }
      return sseResponses(res, text, body.model || OFFICIAL_MODEL)
    }
    if ((req.url || '').endsWith('/chat/completions')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ id: 'c1', object: 'chat.completion', model: body.model || THIRD_MODEL, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }))
    }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}')
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  return { port: server.address().port, hits, stop: async () => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)) } }
}

function runCodex(args, env, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const child = spawn(codex, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    child.stdout.on('data', (b) => { out += String(b) })
    child.stderr.on('data', (b) => { err += String(b) })
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, timeoutMs)
    child.once('exit', (code) => { clearTimeout(timer); resolve({ code, out, err }) })
  })
}

const checks = []
function check(name, ok, detail) { checks.push({ name, ok }); console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? ' :: ' + detail : '')) }

const officialHome = process.env.CODEX_HOME
if (!officialHome) { console.error('必须显式设置临时 CODEX_HOME（含隔离的官方登录副本）'); process.exit(2) }

const official = await mockUpstream('official')
const third = await mockUpstream('third')
const workdir = await mkdtemp(join(tmpdir(), 'mg-codex-e2e-'))
const gw = await startGateway({
  env: { MG_CODEX_OFFICIAL_PASSTHROUGH: '1' },
  config: {
    defaults: {
      model: '',
      codexOfficialHosts: ['localhost'],
      codexOfficialProvider: 'codex-official',
      codexCatalogBasePath: process.env.MG_E3_CATALOG_BASE || '/tmp/mg-e0/catalog-default.json',
      timeout: { firstByteMs: 30000, idleMs: 30000 },
    },
    providers: {
      'codex-official': { baseUrl: 'http://localhost:' + official.port, codexIdentity: 'official', responsesPath: '/backend-api/codex/responses' },
      third: { baseUrl: 'http://127.0.0.1:' + third.port + '/v1' },
    },
    models: {
      // 官方模型不进 config.models（目录生成器禁止复用官方 slug）；由目录 + codexOfficialProvider 解析
      [THIRD_CONFIG_MODEL]: { provider: 'third', api: 'openai', maxContext: 128000 },
    },
  },
})

const env = Object.assign({}, process.env, { CODEX_HOME: officialHome })
const baseArgs = ['exec', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', '-c', 'openai_base_url="' + gw.base + '"']
try {
  const r1 = await runCodex([...baseArgs, '-c', 'model="' + OFFICIAL_MODEL + '"', 'Reply with exactly: TURN1'], env)
  check('turn1 官方模型：exit 0', r1.code === 0, 'code=' + r1.code + ' err=' + r1.err.slice(-300) + ' out=' + r1.out.slice(-1200))
  check('turn1 官方 mock 收到请求', official.hits.length > 0, 'hits=' + official.hits.length)
  const h1 = official.hits[official.hits.length - 1]?.headers || {}
  check('turn1 官方 mock 收到官方凭据头', !!(h1.authorization || h1['chatgpt-account-id']), 'auth=' + (!!h1.authorization) + ' acct=' + (!!h1['chatgpt-account-id']))
  const thread = (r1.out.match(/"type":"thread\.started","thread_id":"([0-9a-f-]{36})"/) || [])[1]
  check('turn1 输出包含 thread id', !!thread, 'thread=' + thread)

  if (thread) {
    const r2 = await runCodex(['exec', 'resume', thread, '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', '-c', 'openai_base_url="' + gw.base + '"', '-c', 'model="' + THIRD_MODEL + '"', 'Reply with exactly: TURN2'], env)
    check('turn2 同线程切第三方：exit 0', r2.code === 0, 'code=' + r2.code + ' err=' + r2.err.slice(-400) + ' out=' + r2.out.slice(-2500))
    check('turn2 第三方 mock 收到请求', third.hits.length > 0, 'hits=' + third.hits.length)
    const h2 = third.hits[third.hits.length - 1]?.headers || {}
    const leaked = ['authorization', 'chatgpt-account-id', 'session-id', 'thread-id', 'x-codex-turn-metadata', 'x-codex-window-id', 'openai-beta'].filter((n) => h2[n] !== undefined)
    check('turn2 官方凭据/会话头零泄漏到第三方', leaked.length === 0, 'leaked=' + JSON.stringify(leaked))

    const r3 = await runCodex(['exec', 'resume', thread, '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', '-c', 'openai_base_url="' + gw.base + '"', '-c', 'model="' + OFFICIAL_MODEL + '"', 'Reply with exactly: TURN3'], env)
    check('turn3 同线程切回官方：exit 0', r3.code === 0, 'code=' + r3.code + ' err=' + r3.err.slice(0, 400))
    check('turn3 官方 mock 再次收到请求', official.hits.length >= 2, 'hits=' + official.hits.length)
  }
} finally {
  await gw.stop(); await official.stop(); await third.stop()
  if (!process.argv.includes('--keep')) { try { const { rm } = await import('node:fs/promises'); await rm(workdir, { recursive: true, force: true }) } catch {} }
}

const failed = checks.filter((c) => !c.ok)
console.log('\n' + (checks.length - failed.length) + '/' + checks.length + ' checks passed')
process.exitCode = failed.length ? 1 : 0