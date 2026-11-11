#!/usr/bin/env node
// E3 LIVE-REAL：真实 Codex CLI（ChatGPT 官方登录）经 ModelGate 同线程
// 官方 GPT → 真实第三方上游（OpenCode Go / deepseek-v4.1-flash）→ 官方 GPT。
// 三方都是真实网络请求；费用由所有者授权的额度承担。上游 key 由网关运行时从用户环境解析，脚本不读取 key。
import { spawn } from 'node:child_process'
import { mkdtemp, rm, copyFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { startGateway } from './offline/harness.mjs'

const CODEX = process.env.CODEX_BIN || 'codex'
const OFFICIAL_MODEL = 'gpt-6-astra'
const THIRD_MODEL_RAW = 'deepseek-v4.1-flash'
const THIRD_SLUG = 'mg-opencodego-' + THIRD_MODEL_RAW.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
const catalogBase = process.env.MG_E3_CATALOG_BASE || '/tmp/mg-e0/catalog-default.json'
if (!existsSync(catalogBase)) { console.error('缺少目录基线: ' + catalogBase); process.exit(2) }

const home = await mkdtemp(join(tmpdir(), 'mg-e3-real-home-'))
await copyFile(process.env.HOME + '/.codex/auth.json', join(home, 'auth.json'))
await chmod(join(home, 'auth.json'), 0o600)

const gw = await startGateway({
  env: { MG_CODEX_OFFICIAL_PASSTHROUGH: '1', MG_MAX_BODY: '' },
  config: {
    defaults: {
      model: '',
      codexOfficialProvider: 'codex-official',
      codexCatalogBasePath: catalogBase,
      timeout: { firstByteMs: 180000, idleMs: 180000 },
    },
    providers: {
      'codex-official': { baseUrl: 'https://chatgpt.com', codexIdentity: 'official', responsesPath: '/backend-api/codex/responses' },
      opencodego: { baseUrl: 'https://opencode.ai/inference/go', api: 'openai', apiKeyEnv: 'OPENCODE_API_KEY' },
    },
    models: { [THIRD_MODEL_RAW]: { provider: 'opencodego', api: 'openai', maxContext: 128000 } },
  },
})

const checks = []
const check = (n, ok, d) => { checks.push(ok); console.log((ok ? 'PASS' : 'FAIL') + '  ' + n + (d ? ' :: ' + d : '')) }
const env = Object.assign({}, process.env, { CODEX_HOME: home })
function run(args, timeoutMs = 240000) {
  return new Promise((resolve) => {
    const c = spawn(CODEX, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    c.stdout.on('data', (b) => { out += b }); c.stderr.on('data', (b) => { err += b })
    const t = setTimeout(() => { try { c.kill('SIGKILL') } catch {} }, timeoutMs)
    c.once('exit', (code) => { clearTimeout(t); resolve({ code, out, err }) })
  })
}
const text = (events) => (events.match(/"type":"agent_message","text":"([^"]*)"/g) || []).map((s) => (s.match(/"text":"([^"]*)"/) || [])[1]).join(' | ')
try {
  const base = ['exec', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', '-c', 'openai_base_url="' + gw.base + '"']
  const r1 = await run([...base, '-c', 'model="' + OFFICIAL_MODEL + '"', 'Reply with exactly: REAL_T1_OFFICIAL_OK'])
  check('LIVE-REAL turn1 官方 exit 0', r1.code === 0, 'code=' + r1.code + ' err=' + r1.err.slice(-500))
  check('LIVE-REAL turn1 文本', /REAL_T1_OFFICIAL_OK/.test(r1.out), text(r1.out))
  const thread = (r1.out.match(/"type":"thread\.started","thread_id":"([0-9a-f-]{36})"/) || [])[1]
  check('LIVE-REAL turn1 thread id', !!thread, String(thread))

  const r2 = await run(['exec', 'resume', thread, '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', '-c', 'openai_base_url="' + gw.base + '"', '-c', 'model="' + THIRD_SLUG + '"', 'Reply with exactly: REAL_T2_THIRD_OK'])
  check('LIVE-REAL turn2 真实第三方 exit 0', r2.code === 0, 'code=' + r2.code + ' err=' + r2.err.slice(-300) + ' out=' + r2.out.slice(-2200) + ' gw=' + gw.stderr().slice(-800))
  check('LIVE-REAL turn2 第三方有回复文本', text(r2.out).length > 0, text(r2.out).slice(0, 200))

  const r3 = await run(['exec', 'resume', thread, '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', '-c', 'openai_base_url="' + gw.base + '"', '-c', 'model="' + OFFICIAL_MODEL + '"', 'Reply with exactly: REAL_T3_BACK_OK'])
  check('LIVE-REAL turn3 切回官方 exit 0', r3.code === 0, 'code=' + r3.code + ' err=' + r3.err.slice(-700))
  check('LIVE-REAL turn3 文本', /REAL_T3_BACK_OK/.test(r3.out), text(r3.out))
} finally {
  await gw.stop()
  await rm(home, { recursive: true, force: true })
}
const failed = checks.filter((x) => !x).length
console.log('\n' + (checks.length - failed) + '/' + checks.length + ' live-real checks passed')
process.exitCode = failed ? 1 : 0
