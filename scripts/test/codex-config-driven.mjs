#!/usr/bin/env node
// E3/E6 集成（离线）：完全由真实 CODEX_HOME/config.toml 驱动（无任何 -c 覆盖），
// Codex → 网关（openai_base_url）→ 官方 mock。验证 D1-A 配置在真实启动路径上生效。
import { spawn } from 'node:child_process'
import http from 'node:http'
import { once } from 'node:events'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { startGateway } from './offline/harness.mjs'

const CODEX = process.env.CODEX_BIN || '/home/xiaomengxizi/ai/harness/codex/cli/bin/codex'
const basePath = process.env.MG_E3_CATALOG_BASE || '/tmp/mg-e0/catalog-default.json'
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
  hits.push({ url: req.url, method: req.method, headers: req.headers })
  if (req.method !== 'POST') { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{}') }
  if ((req.url || '').endsWith('/responses')) return sse(res, 'CONFIG_DRIVEN_OK')
  res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}')
})
official.listen(0, '127.0.0.1'); await once(official, 'listening')
const officialPort = official.address().port

const gw = await startGateway({
  env: { MG_CODEX_OFFICIAL_PASSTHROUGH: '1' },
  config: {
    server: { maxBodyBytes: 8 * 1024 * 1024 },
    defaults: { model: '', codexOfficialHosts: ['localhost'], codexOfficialProvider: 'codex-official', codexCatalogBasePath: basePath },
    providers: { 'codex-official': { baseUrl: 'http://localhost:' + officialPort, codexIdentity: 'official', responsesPath: '/backend-api/codex/responses' } },
    models: {},
  },
})
const home = await mkdtemp(join(tmpdir(), 'mg-e3-configdriven-'))
try {
  const toml = [
    'model = "gpt-6-astra"',
    'model_provider = "openai"',
    'openai_base_url = "' + gw.base + '"',
    'model_catalog_json = "' + basePath + '"',
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    ''
  ].join(String.fromCharCode(10))
  await writeFile(join(home, 'config.toml'), toml)
  const env = Object.assign({}, process.env, { CODEX_HOME: home, OPENAI_API_KEY: 'sk-config-driven-test' })
  const r = await new Promise((resolve) => {
    const c = spawn(CODEX, ['exec', '--json', '--skip-git-repo-check', 'Reply with exactly: CONFIG_DRIVEN_OK'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    c.stdout.on('data', (b) => { out += b }); c.stderr.on('data', (b) => { err += b })
    const t = setTimeout(() => { try { c.kill('SIGKILL') } catch {} }, 120000)
    c.once('exit', (code) => { clearTimeout(t); resolve({ code, out, err }) })
  })
  check('config.toml 驱动的一轮 exit 0', r.code === 0, 'code=' + r.code + ' err=' + r.err.slice(-400))
  check('网关收到官方请求并回传文本', /CONFIG_DRIVEN_OK/.test(r.out), r.out.slice(-300))
  check('mock 官方后端被命中（网关转发生效）', hits.length > 0, 'hits=' + hits.length)
} finally {
  await gw.stop()
  official.closeAllConnections?.(); await new Promise((r) => official.close(r))
  await rm(home, { recursive: true, force: true })
}
const failed = checks.filter((x) => !x).length
console.log(String.fromCharCode(10) + (checks.length - failed) + '/' + checks.length + ' config-driven checks passed')
process.exitCode = failed ? 1 : 0
