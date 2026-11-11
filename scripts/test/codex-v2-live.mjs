#!/usr/bin/env node
// E4/M2 LIVE 探针：官方主代理尝试 spawn 第三方子代理；只取证，不伪造成功。
// 用法：node scripts/test/codex-v2-live.mjs ；事件原文写到 /tmp/mg-e0/v2-events.jsonl。
import { spawn } from 'node:child_process'
import { mkdtemp, rm, copyFile, chmod, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startGateway } from './offline/harness.mjs'

const CODEX = process.env.CODEX_BIN || '/home/xiaomengxizi/ai/harness/codex/cli/bin/codex'
const OFFICIAL = 'gpt-6-astra'
const THIRD_SLUG = 'mg-opencodego-deepseek-v4-1-flash'
const home = await mkdtemp(join(tmpdir(), 'mg-e4-live-'))
await copyFile(process.env.HOME + '/.codex/auth.json', join(home, 'auth.json'))
await chmod(join(home, 'auth.json'), 0o600)
const gw = await startGateway({
  env: { MG_CODEX_OFFICIAL_PASSTHROUGH: '1' },
  config: {
    defaults: { model: '', codexOfficialProvider: 'codex-official', codexCatalogBasePath: '/tmp/mg-e0/catalog-default.json', timeout: { firstByteMs: 240000, idleMs: 240000 } },
    providers: {
      'codex-official': { baseUrl: 'https://chatgpt.com', codexIdentity: 'official', responsesPath: '/backend-api/codex/responses' },
      opencodego: { baseUrl: 'https://opencode.ai/inference/go', api: 'openai', apiKeyEnv: 'OPENCODE_API_KEY' },
    },
    models: { 'deepseek-v4.1-flash': { provider: 'opencodego', api: 'openai', maxContext: 128000 } },
  },
})
const env = Object.assign({}, process.env, { CODEX_HOME: home })
const prompt = 'Use spawn_agent exactly once with task_name third_probe and model ' + THIRD_SLUG + ' and message "Reply with exactly: SUB_OK". Wait for it, then report its final message verbatim. If spawn_agent is not available, reply TOOLS_UNAVAILABLE.'
const r = await new Promise((resolve) => {
  const c = spawn(CODEX, ['exec', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', '-c', 'openai_base_url="' + gw.base + '"', '-c', 'model="' + OFFICIAL + '"', '--enable', 'multi_agent_v2', prompt], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = ''
  c.stdout.on('data', (b) => { out += b }); c.stderr.on('data', (b) => { err += b })
  const t = setTimeout(() => { try { c.kill('SIGKILL') } catch {} }, 420000)
  c.once('exit', (code) => { clearTimeout(t); resolve({ code, out, err }) })
})
await writeFile('/tmp/mg-e0/v2-events.jsonl', r.out)
await writeFile('/tmp/mg-e0/v2-stderr.txt', r.err)
console.log('exit', r.code, 'stdout bytes', r.out.length, 'stderr bytes', r.err.length)
await gw.stop()
await rm(home, { recursive: true, force: true })
