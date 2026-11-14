#!/usr/bin/env node
// M2 只读取证：v2 关闭（multi_agent_v1 协作命名空间）时，官方主代理 spawn 第三方子代理，
// 观察子代理请求里的任务是否仍加密。只写事件原文，不修改产品行为。
import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { mkdtemp, rm, copyFile, chmod, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startGateway } from './offline/harness.mjs'

const CODEX = process.env.CODEX_BIN || 'codex'

// M0-1b fail-closed 前置守卫：本脚本复制真实 ~/.codex/auth.json、访问真实上游并真跑 codex exec。
// 缺少显式授权 / 真实凭据 / codex 可执行文件时立即非 0 退出，绝不进入复制、起网关或 spawn 分支
// （也避免 spawn ENOENT 时只因没有 error 监听而挂住）。
function refuse(msg) {
  console.error('[codex-v1-live] REFUSED: ' + msg)
  process.exit(2)
}
function resolveCodexBinary(bin) {
  if (bin.includes('/')) {
    try { accessSync(bin, constants.X_OK); return bin } catch { return null }
  }
  for (const dir of (process.env.PATH || '').split(':')) {
    if (!dir) continue
    const candidate = join(dir, bin)
    try { accessSync(candidate, constants.X_OK); return candidate } catch { /* next */ }
  }
  return null
}
if (process.env.MG_ALLOW_LIVE_TESTS !== '1') {
  refuse('需要显式 MG_ALLOW_LIVE_TESTS=1（真实凭据/真实上游取证，不属于默认套件）')
}
const authFile = join(process.env.HOME || '', '.codex', 'auth.json')
if (!existsSync(authFile)) refuse('缺少真实授权文件 ' + authFile + '（仅做存在性检查，不读取内容）')
if (!resolveCodexBinary(CODEX)) refuse('找不到 codex 可执行文件（CODEX_BIN=' + CODEX + '；不在 PATH）')
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
