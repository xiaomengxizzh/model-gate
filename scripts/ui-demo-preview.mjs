#!/usr/bin/env node
// ModelGate 简约演示的独立预览服务器：只读静态资源 + /api 反向代理。
// 零第三方依赖；不启动、不重启、不修改运行中的 8787 网关。
//
// 用法：
//   node scripts/ui-demo-preview.mjs [--port 8791] [--target http://127.0.0.1:8787] [--fixture <file.json>]
//
// --fixture 用于离线设计验收：JSON 形如 { "/api/status": {...}, "/api/model-stats?days=1": {...} }；
// 只影响预览进程，不写入仓库或运行中实例。

import http from 'node:http'
import { readFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../src/ui-demo/', import.meta.url)))
const TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
})
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"

function flag (name, fallback) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const port = Number(flag('port', '8791'))
const target = new URL(flag('target', 'http://127.0.0.1:8787'))
const fixturePath = flag('fixture', '')
let fixture = null
if (fixturePath) {
  try { fixture = JSON.parse(readFileSync(resolve(fixturePath), 'utf8')) } catch (error) {
    console.error('fixture 读取失败：' + error.message)
    process.exit(2)
  }
}

function send (res, status, type, body) {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': CSP,
  })
  res.end(body)
}

function staticPath (pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.slice(1)
  try { rel = decodeURIComponent(rel) } catch { return null }
  if (!rel || rel.startsWith('/') || rel.includes('\\') || rel.includes('\0')) return null
  const parts = rel.split('/')
  if (parts.some((p) => !p || p === '.' || p === '..' || p.startsWith('.'))) return null
  if (!/^[A-Za-z0-9._/-]+$/.test(rel)) return null
  const type = TYPES[extname(rel).toLowerCase()]
  if (!type) return null
  return { file: resolve(ROOT, rel), type }
}

function proxy (req, res) {
  const options = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    method: req.method,
    path: req.url,
    headers: Object.assign({}, req.headers, { host: target.host }),
  }
  const up = http.request(options, (upRes) => {
    res.writeHead(upRes.statusCode || 502, upRes.headers)
    upRes.pipe(res)
  })
  up.on('error', (error) => {
    if (res.headersSent) { res.destroy(); return }
    send(res, 502, 'application/json; charset=utf-8', JSON.stringify({ error: { message: '预览代理无法连接目标网关：' + error.message } }))
  })
  req.pipe(up)
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://preview')
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    if (fixture) {
      const key = url.pathname + (url.search || '')
      const hit = fixture[key] || fixture[url.pathname]
      if (hit !== undefined) {
        send(res, 200, 'application/json; charset=utf-8', JSON.stringify(hit))
        return
      }
      send(res, 404, 'application/json; charset=utf-8', JSON.stringify({ error: { message: 'fixture 未提供 ' + key } }))
      return
    }
    proxy(req, res)
    return
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'text/plain; charset=utf-8', 'method not allowed')
    return
  }
  const asset = staticPath(url.pathname)
  if (!asset) {
    send(res, 404, 'text/plain; charset=utf-8', 'not found')
    return
  }
  let data
  try { data = readFileSync(asset.file) } catch {
    send(res, 404, 'text/plain; charset=utf-8', 'not found')
    return
  }
  res.writeHead(200, {
    'content-type': asset.type,
    'content-length': data.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': CSP,
  })
  res.end(req.method === 'HEAD' ? undefined : data)
})

server.listen(port, '127.0.0.1', () => {
  console.log('ui-demo preview: http://127.0.0.1:' + port + '/  ->  ' + (fixture ? 'fixture' : target.origin))
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => process.exit(0)))
}
