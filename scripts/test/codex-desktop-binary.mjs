#!/usr/bin/env node
// Desktop 内置 codex（0.167.0-alpha.3.2）在 CLI 模式下的配置/目录/传输验证。
// 目的：不改动正在运行的 Desktop 应用，也能验证它真正使用的 alpha 二进制是否兼容 D1-A 配置。
// 全程本地 mock，无真实上游、无真实登录。
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import { once } from 'node:events'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { startGateway } from './offline/harness.mjs'

const CODEX = process.env.CODEX_BIN || '/usr/lib/chatgpt/resources/codex'
const basePath = process.env.MG_E3_CATALOG_BASE || '/tmp/mg-e0/catalog-default.json'
if (!existsSync(CODEX)) { console.error('缺少 Desktop 内置 codex: ' + CODEX); process.exit(2) }
if (!existsSync(basePath)) { console.error('缺少目录基线: ' + basePath); process.exit(2) }
const checks = []
const check = (n, ok, d) => { checks.push(ok); console.log((ok ? 'PASS' : 'FAIL') + '  ' + n + (d ? ' :: ' + d : '')) }

const hits = []
function sse(res, text) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const emit = (e, d) => res.write('event: ' + e + String.fromCharCode(10) + 'data: ' + JSON.stringify(d) + String.fromCharCode(10, 10))
  emit('response.created', { type: 'response.created', response: { id: 'r1', object: 'response', status: 'in_progress', model: 'gpt-6-astra', output: [] } })
  emit('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: 'm1', type: 'message', status: 'in_progress', role: 'assistant', content: [] } })
  emit('response.output_text.delta', { type: 'response.output_text.delta', item_id: 'm1', output_index: 0, content_index: 0, delta: text })
  emit('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { id: 'm1', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] } })
  emit('response.completed', { type: 'response.completed', response: { id: 'r1', object: 'response', status: 'completed', model: 'gpt-6-astra', output: [], usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } } })
  res.end()
}
const official = http.createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  hits.push({ url: req.url, method: req.method })
  if (req.method !== 'POST') { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{}') }
  if ((req.url || '').endsWith('/responses')) return sse(res, 'DESKTOP_BIN_OK')
  res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}')
})
official.listen(0, '127.0.0.1'); await once(official, 'listening')
const gw = await startGateway({
  env: { MG_CODEX_OFFICIAL_PASSTHROUGH: '1' },
  config: {
    server: { maxBodyBytes: 8 * 1024 * 1024 },
    defaults: { model: '', codexOfficialHosts: ['localhost'], codexOfficialProvider: 'codex-official', codexCatalogBasePath: basePath },
    providers: { 'codex-official': { baseUrl: 'http://localhost:' + official.address().port, codexIdentity: 'official', responsesPath: '/backend-api/codex/responses' } },
    models: {},
  },
})
const home = await mkdtemp(join(tmpdir(), 'mg-e3-desktop-'))
try {
  await writeFile(join(home, 'config.toml'), [
    'model = "gpt-6-astra"',
    'model_provider = "openai"',
    'openai_base_url = "' + gw.base + '"',
    'model_catalog_json = "' + basePath + '"',
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    ''
  ].join(String.fromCharCode(10)))
  const env = Object.assign({}, process.env, { CODEX_HOME: home, OPENAI_API_KEY: 'sk-desktop-bin-test' })
  const ver = spawnSync(CODEX, ['--version'], { env, encoding: 'utf8', timeout: 30000 })
  check('Desktop 二进制版本可读', ver.status === 0 && /0\.167/.test(String(ver.stdout || '')), String(ver.stdout || '').trim())
  const models = spawnSync(CODEX, ['debug', 'models'], { env, encoding: 'utf8', timeout: 60000 })
  let parsed = null; try { parsed = JSON.parse(models.stdout) } catch {}
  check('Desktop 二进制加载 config.toml + 目录', models.status === 0 && !!parsed && Array.isArray(parsed.models), 'models=' + (parsed && parsed.models ? parsed.models.length : 0))
  const r = await new Promise((resolve) => {
    const c = spawn(CODEX, ['exec', '--json', '--skip-git-repo-check', 'Reply with exactly: DESKTOP_BIN_OK'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    c.stdout.on('data', (b) => { out += b }); c.stderr.on('data', (b) => { err += b })
    const t = setTimeout(() => { try { c.kill('SIGKILL') } catch {} }, 120000)
    c.once('exit', (code) => { clearTimeout(t); resolve({ code, out, err }) })
  })
  check('Desktop 二进制一轮 exit 0', r.code === 0, 'code=' + r.code + ' err=' + r.err.slice(-400))
  check('文本回传', /DESKTOP_BIN_OK/.test(r.out), r.out.slice(-200))
  check('网关/官方 mock 被命中', hits.length > 0, 'hits=' + hits.length)
} finally {
  await gw.stop()
  official.closeAllConnections?.(); await new Promise((r) => official.close(r))
  await rm(home, { recursive: true, force: true })
}
const failed = checks.filter((x) => !x).length
console.log(String.fromCharCode(10) + (checks.length - failed) + '/' + checks.length + ' desktop-binary checks passed')
process.exitCode = failed ? 1 : 0
