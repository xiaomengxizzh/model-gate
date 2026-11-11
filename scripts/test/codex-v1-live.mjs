#!/usr/bin/env node
// M2 只读取证：v2 关闭（multi_agent_v1 协作命名空间）时，官方主代理 spawn 第三方子代理，
// 观察子代理请求里的任务是否仍加密。只写事件原文，不修改产品行为。
import { spawn } from 'node:child_process'
import { mkdtemp, rm, copyFile, chmod, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startGateway } from './offline/harness.mjs'

const CODEX = process.env.CODEX_BIN || '/home/xiaomengxizi/ai/harness/codex/cli/bin/codex'
const OFFICIAL = 'gpt-6-astra'
const THIRD_SLUG = 'mg-opencodego-deepseek-v4-1-flash'
const home = await mkdtemp(join(tmpdir(), 'mg-e4-v1-'))
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
const prompt = 'Use the spawn_agent tool from namespace multi_agent_v1 exactly once with task_name third_probe and message "Reply with exactly: SUB_OK". Then wait_agent for it and report its final message verbatim. If unavailable, reply TOOLS_UNAVAILABLE.'
const r = await new Promise((resolve) => {
  const c = spawn(CODEX, ['exec', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', '-c', 'features.multi_agent_v2=false', '-c', 'openai_base_url="' + gw.base + '"', '-c', 'model="' + OFFICIAL + '"', prompt], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = ''
  c.stdout.on('data', (b) => { out += b }); c.stderr.on('data', (b) => { err += b })
  const t = setTimeout(() => { try { c.kill('SIGKILL') } catch {} }, 420000)
  c.once('exit', (code) => { clearTimeout(t); resolve({ code, out, err }) })
})
await writeFile('/tmp/mg-e0/v1-live-events.jsonl', r.out)
await writeFile('/tmp/mg-e0/v1-live-stderr.txt', r.err)
console.log('exit', r.code, 'stdout bytes', r.out.length)
await gw.stop()
await rm(home, { recursive: true, force: true })
