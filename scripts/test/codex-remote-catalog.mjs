#!/usr/bin/env node
// 远端目录验收：Codex 不配置 model_catalog_json，只靠 openai_base_url，从网关 /v1/models 拉取目录。
// 关键：错误的目录形状会让客户端报 "failed to decode models response"（此前实测会直接导致 resume 失败）。
// 全程离线（官方 mock），不联网、不需要真实登录。
import { spawn } from 'node:child_process'
import http from 'node:http'
import { once } from 'node:events'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { startGateway } from './offline/harness.mjs'

const CODEX = process.env.CODEX_BIN || 'codex'
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
  hits.push({ url: req.url, method: req.method })
  if (req.method !== 'POST') { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{}') }
  if ((req.url || '').endsWith('/responses')) return sse(res, 'REMOTE_CATALOG_OK')
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
const home = await mkdtemp(join(tmpdir(), 'mg-e3-remotecat-'))
try {
  // 注意：没有 model_catalog_json —— 客户端只能从 /v1/models 取目录
  await writeFile(join(home, 'config.toml'), [
    'model = "gpt-6-astra"',
    'model_provider = "openai"',
    'openai_base_url = "' + gw.base + '"',
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    ''
  ].join(String.fromCharCode(10)))
  const env = Object.assign({}, process.env, { CODEX_HOME: home, OPENAI_API_KEY: 'sk-remote-catalog-test' })
  const r = await new Promise((resolve) => {
    const c = spawn(CODEX, ['exec', '--json', '--skip-git-repo-check', 'Reply with exactly: REMOTE_CATALOG_OK'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    c.stdout.on('data', (b) => { out += b }); c.stderr.on('data', (b) => { err += b })
    const t = setTimeout(() => { try { c.kill('SIGKILL') } catch {} }, 120000)
    c.once('exit', (code) => { clearTimeout(t); resolve({ code, out, err }) })
  })
  const combined = r.out + String.fromCharCode(10) + r.err
  check('无 model_catalog_json 时一轮 exit 0', r.code === 0, 'code=' + r.code + ' err=' + r.err.slice(-400))
  check('未出现目录解码失败', !/failed to decode models response|models response/i.test(combined))
  check('文本回传（说明目录+请求链可用）', /REMOTE_CATALOG_OK/.test(r.out), r.out.slice(-160))
  check('官方 mock 被命中', hits.length > 0, 'hits=' + hits.length)
} finally {
  await gw.stop()
  official.closeAllConnections?.(); await new Promise((r) => official.close(r))
  await rm(home, { recursive: true, force: true })
}
const failed = checks.filter((x) => !x).length
console.log(String.fromCharCode(10) + (checks.length - failed) + '/' + checks.length + ' remote-catalog checks passed')
process.exitCode = failed ? 1 : 0
