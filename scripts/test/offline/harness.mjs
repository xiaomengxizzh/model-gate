// 离线测试基座（G0/G1/G2 验收）：临时配置目录 + 进程内网关 + 本地 mock 上游。
// 不读取、不写入、不依赖生产 config/，不接触 8787，不发起真实 API 调用。
import http from 'node:http'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const ADMIN = 'offline-admin-token'
export const CLIENT = 'offline-client-key'

const results = []
export function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail })
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''))
  return !!ok
}
export function summary() {
  const pass = results.filter(r => r.ok).length
  const fail = results.length - pass
  return { pass, fail, total: results.length }
}
export function resetResults() { results.length = 0 }

/** 起一个本地 mock 上游；handler(req,res,body,ctx) 自定义响应。 */
export async function mockUpstream(handler) {
  const hits = []
  const sockets = new Set()
  const srv = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = Buffer.concat(chunks).toString('utf8')
    hits.push({ method: req.method, url: req.url, headers: req.headers, body })
    try { await handler(req, res, body, { hits }) } catch (e) { try { res.writeHead(500); res.end('mock error: ' + e.message) } catch {} }
  })
  srv.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  return {
    port: srv.address().port,
    url: 'http://127.0.0.1:' + srv.address().port,
    hits,
    close: () => new Promise((r) => { for (const s of sockets) { try { s.destroy() } catch {} } srv.close(() => r()) }),
  }
}

export function sseWrite(res, payload, event) {
  if (event) res.write('event: ' + event + '\n')
  res.write('data: ' + (typeof payload === 'string' ? payload : JSON.stringify(payload)) + '\n\n')
}
export function sseStart(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
}

/** 起一个隔离网关实例（临时 MG_CONFIG_DIR，端口 0）。 */
export async function startGateway(patch = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mg-offline-'))
  process.env.MG_CONFIG_DIR = dir
  process.env.MG_ADMIN_TOKEN = ADMIN
  process.env.MG_KEYS_MASTER = 'offline-master-key'
  process.env.MG_CLIENT_KEY = CLIENT
  const cfg = {
    server: { host: '127.0.0.1', port: 0, logFile: join(dir, 'gateway.log'), maxBodyBytes: 4 * 1024 * 1024 },
    defaults: Object.assign({
      retry: { maxAttempts: 2, initialDelayMs: 20, maxDelayMs: 60, jitter: 0 },
      timeout: { connectMs: 2000, firstByteMs: 5000, idleMs: 3000, loopMs: 6000 },
      concurrency: { maxPerProvider: 8 },
      extraHeaders: {},
      preheat: [],
      directory: [],
    }, patch.defaults || {}),
    providers: patch.providers || {},
    models: patch.models || {},
    virtualModels: patch.virtualModels || [],
  }
  const file = join(dir, 'gateway.json')
  writeFileSync(file, JSON.stringify(cfg, null, 2))
  const mod = await import('../../../src/index.js')
  const gw = await mod.start({ config: file, silent: true, port: 0 })
  const base = 'http://127.0.0.1:' + gw.port
  return {
    dir, base, port: gw.port, cfg: gw.cfg, state: gw.state, log: gw.log,
    adminFetch: (path, init = {}) => fetch(base + path, Object.assign({}, init, { headers: Object.assign({ authorization: 'Bearer ' + ADMIN, 'content-type': 'application/json' }, init.headers || {}) })),
    chat: (body) => fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + CLIENT }, body: JSON.stringify(body) }),
    responses: (body, headers = {}) => fetch(base + '/v1/responses', { method: 'POST', headers: Object.assign({ 'content-type': 'application/json', authorization: 'Bearer ' + CLIENT }, headers), body: JSON.stringify(body) }),
    close: () => new Promise((resolve) => {
      try { gw.server.closeAllConnections && gw.server.closeAllConnections() } catch {}
      gw.server.close(() => { try { rmSync(dir, { recursive: true, force: true }) } catch {}; resolve() })
    }),
  }
}

/** 读取完整 SSE 响应为事件数组。 */
export async function readSse(res) {
  const text = await res.text()
  const events = []
  for (const block of text.split(/\n\n/)) {
    if (!block.trim()) continue
    let event = 'message'
    const dataLines = []
    for (const line of block.split(/\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
    }
    if (!dataLines.length) continue
    const raw = dataLines.join('\n')
    let data = raw
    try { data = JSON.parse(raw) } catch {}
    events.push({ event, data, raw })
  }
  return { text, events }
}
export const sleep = (ms) => new Promise(r => setTimeout(r, ms))
export function exists(p) { return existsSync(p) }
