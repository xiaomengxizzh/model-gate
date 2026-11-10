// 离线契约测试共用的隔离夹具：OS 临时配置目录 + 动态回环端口 + 本地 mock 上游。
// 不读取用户主配置、不写 cwd/config、不触达真实上游；每个夹具一个子进程，结束即清理。
import http from 'node:http'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = fileURLToPath(new URL('../../../', import.meta.url))

async function reservePort() {
  const s = http.createServer()
  s.listen(0, '127.0.0.1')
  await once(s, 'listening')
  const port = s.address().port
  await new Promise((r) => s.close(r))
  return port
}

// 本地 mock 上游：GET 一律返回模型清单，POST 一律返回最小 chat 响应；记录收到的头与到达时间。
export async function startMockUpstream(opts = {}) {
  const hits = []
  const server = http.createServer(async (req, res) => {
    for await (const chunk of req) { /* drain */ }
    hits.push({ method: req.method, url: req.url, headers: req.headers, at: Date.now() })
    if (req.method === 'GET') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'vendor-model', object: 'model' }] }))
      return
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ id: 'mock-1', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  return {
    port,
    base: 'http://127.0.0.1:' + port,
    hits,
    lastHeaders: () => (hits.length ? hits[hits.length - 1].headers : null),
    stop: async () => {
      server.closeAllConnections?.()
      await new Promise((r) => server.close(r))
    },
  }
}

// 启动隔离网关。config 为 gateway.json 内容（server.port 由夹具分配）。
export async function startGateway(opts = {}) {
  const name = opts.name || 'mg'
  const dir = opts.dir || await mkdtemp(join(tmpdir(), 'modelgate-' + name + '-'))
  const port = await reservePort()
  const base = 'http://127.0.0.1:' + port
  const server = Object.assign({ host: '127.0.0.1', port, maxBodyBytes: 64 * 1024, logFile: join(dir, 'test.log') }, opts.config && opts.config.server)
  const cfg = Object.assign({
    defaults: { retry: { maxAttempts: 1 }, timeout: { firstByteMs: 2000, idleMs: 2000 }, proxyMode: 'direct' },
    providers: {},
    models: {},
    virtualModels: [],
  }, opts.config || {}, { server })
  await writeFile(join(dir, 'gateway.json'), JSON.stringify(cfg))
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: Object.assign({}, process.env, {
      MG_CONFIG_DIR: dir,
      MG_CONFIG: join(dir, 'gateway.json'),
      MG_KEYS_MASTER: 'isolated-test-master',
      MG_MAX_BODY: '',
      MG_CLIENT_KEY: '',
      MG_ADMIN_TOKEN: '',
    }, opts.env || {}),
  })
  let stderr = ''
  child.stderr.on('data', (b) => { stderr += String(b) })
  const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })))

  const call = (path, o = {}) => {
    const headers = Object.assign({}, o.headers || {})
    let body = o.body
    if (body !== undefined && typeof body !== 'string') { headers['content-type'] = 'application/json'; body = JSON.stringify(body) }
    return fetch(base + path, { method: o.method || 'GET', headers, body })
  }
  const get = (path, headers) => call(path, { method: 'GET', headers })
  const post = (path, body, headers) => call(path, { method: 'POST', body, headers })

  let ready = false
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('isolated gateway exited: ' + exited + ' ' + stderr)
    try { if ((await get('/healthz')).ok) { ready = true; break } } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 25))
  }
  if (!ready) {
    child.kill()
    throw new Error('isolated gateway did not become ready: ' + stderr)
  }
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited }
    if (!opts.dir) await rm(dir, { recursive: true, force: true })
  }
  return { base, dir, port, child, call, get, post, stop, stderr: () => stderr }
}


// 可脚本化 mock 上游（MG-002 扩展）：handler(req, res, rec) 完全接管响应。
// rec 记录到达时间与 socket 关闭时间（closedAt/aborted），用于断言网关确实销毁了上游连接。
// 既有 startMockUpstream 的默认行为不变；本函数只新增入口。
export async function startScriptedUpstream(handler) {
  const hits = []
  const server = http.createServer(async (req, res) => {
    const rec = {
      index: hits.length,
      method: req.method,
      url: req.url,
      headers: req.headers,
      at: Date.now(),
      closedAt: null,
      aborted: null, // true = 响应未正常 end 连接就被关掉（网关中止/销毁）
    }
    hits.push(rec)
    res.on('close', () => { rec.closedAt = Date.now(); rec.aborted = !res.writableEnded })
    res.on('error', () => {})
    req.on('error', () => {})
    try { await handler(req, res, rec) } catch { try { res.destroy() } catch {} }
  })
  server.on('clientError', (err, socket) => { try { socket.destroy() } catch {} })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  return {
    port,
    base: 'http://127.0.0.1:' + port,
    hits,
    stop: async () => {
      server.closeAllConnections?.()
      await new Promise((r) => server.close(r))
    },
  }
}

// 接受 TCP 连接后只读取 CONNECT 请求行、永不应答的本地代理（AC-2 的挂起隧道）。
// connections 记录每条隧道收到的字节与关闭时间；closing 表示网关是否主动关闭了隧道 socket。
export async function startHangingProxy() {
  const connections = []
  const server = net.createServer((sock) => {
    const rec = { at: Date.now(), data: '', closedAt: null }
    connections.push(rec)
    sock.on('data', (d) => { rec.data += d.toString('utf8') })
    sock.on('close', () => { rec.closedAt = Date.now() })
    sock.on('error', () => {})
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  return {
    port,
    url: 'http://127.0.0.1:' + port,
    connections,
    stop: async () => {
      server.closeAllConnections?.()
      await new Promise((r) => server.close(r))
    },
  }
}

