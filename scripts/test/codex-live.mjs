#!/usr/bin/env node
// E3 LIVE：真实 Codex CLI（ChatGPT 官方登录，临时 CODEX_HOME 副本）经 ModelGate 同线程
// GPT → 第三方（本地 mock）→ GPT。官方两轮是真实的 chatgpt.com 后端请求；第三方轮是本地 mock。
// 用法：CODEX_HOME=/tmp/xxx node scripts/test/codex-live.mjs
import { spawn } from 'node:child_process'
import http from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startGateway } from './offline/harness.mjs'

const CODEX = process.env.CODEX_BIN || '/home/xiaomengxizi/ai/harness/codex/cli/bin/codex'
const OFFICIAL_MODEL = 'gpt-6-astra'
const THIRD_CONFIG_MODEL = 'deepseek-v4-flash'
const THIRD_MODEL = 'mg-third-' + THIRD_CONFIG_MODEL
const home = process.env.CODEX_HOME
if (!home) { console.error('必须设置临时 CODEX_HOME（隔离的官方登录副本）'); process.exit(2) }

const third = http.createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ id: 'c1', object: 'chat.completion', model: THIRD_CONFIG_MODEL, choices: [{ index: 0, message: { role: 'assistant', content: 'LIVE_THIRD_OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }))
})
third.listen(0, '127.0.0.1'); await once(third, 'listening')
const thirdPort = third.address().port

const gw = await startGateway({
  env: { MG_CODEX_OFFICIAL_PASSTHROUGH: '1' },
  config: {
    defaults: {
      model: '',
      codexOfficialProvider: 'codex-official',
      codexCatalogBasePath: process.env.MG_E3_CATALOG_BASE || '/tmp/mg-e0/catalog-default.json',
      timeout: { firstByteMs: 120000, idleMs: 120000 },
    },
    providers: {
      'codex-official': { baseUrl: 'https://chatgpt.com', codexIdentity: 'official', responsesPath: '/backend-api/codex/responses' },
      third: { baseUrl: 'http://127.0.0.1:' + thirdPort + '/v1' },
    },
    models: { [THIRD_CONFIG_MODEL]: { provider: 'third', api: 'openai', maxContext: 128000 } },
  },
})

const checks = []
const check = (n, ok, d) => { checks.push(ok); console.log((ok ? 'PASS' : 'FAIL') + '  ' + n + (d ? ' :: ' + d : '')) }
const env = Object.assign({}, process.env, { CODEX_HOME: home })

function run(args, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const c = spawn(CODEX, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    c.stdout.on('data', (b) => { out += b }); c.stderr.on('data', (b) => { err += b })
    const timer = setTimeout(() => { try { c.kill('SIGKILL') } catch {} }, timeoutMs)
    c.once('exit', (code) => { clearTimeout(timer); resolve({ code, out, err }) })
  })
}

const wd = await mkdtemp(join(tmpdir(), 'mg-codex-live-'))
try {
  const base = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '-c', 'sandbox_mode="read-only"', '-c', 'openai_base_url="' + gw.base + '"']
  const r1 = await run([...base, '-c', 'model="' + OFFICIAL_MODEL + '"', 'Reply with exactly: LIVE_OFFICIAL_OK'], 240000)
  check('LIVE turn1 官方真实请求 exit 0', r1.code === 0, 'code=' + r1.code + ' err=' + r1.err.slice(-600))
  check('LIVE turn1 有 assistant 输出', /agent_message|output_text/.test(r1.out), r1.out.slice(-400))
  const thread = (r1.out.match(/"type":"thread\.started","thread_id":"([0-9a-f-]{36})"/) || [])[1]
  check('LIVE turn1 thread id', !!thread, String(thread))

  const r2 = await run(['exec', 'resume', thread, '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', '-c', 'openai_base_url="' + gw.base + '"', '-c', 'model="' + THIRD_MODEL + '"', 'Reply with exactly: LIVE_THIRD_OK'], 180000)
  check('LIVE turn2 同线程切第三方 exit 0', r2.code === 0, 'code=' + r2.code + ' err=' + r2.err.slice(-600))

  const r3 = await run(['exec', 'resume', thread, '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', '-c', 'openai_base_url="' + gw.base + '"', '-c', 'model="' + OFFICIAL_MODEL + '"', 'Reply with exactly: LIVE_BACK_OK'], 240000)
  check('LIVE turn3 同线程切回官方 exit 0', r3.code === 0, 'code=' + r3.code + ' err=' + r3.err.slice(-800))
} finally {
  await gw.stop(); third.closeAllConnections?.(); await new Promise((r) => third.close(r)); await rm(wd, { recursive: true, force: true })
}
const failed = checks.filter((x) => !x).length
console.log('\n' + (checks.length - failed) + '/' + checks.length + ' live checks passed')
process.exitCode = failed ? 1 : 0