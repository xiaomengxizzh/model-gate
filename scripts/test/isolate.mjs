// 旧集成套件共用的隔离夹具（MG-004）：OS 临时配置目录 + 动态回环端口 + 本地 mock 上游 + 失败清理。
// 契约：
//  - 不读用户主配置：MG_CONFIG_DIR/MG_CONFIG 全部指向 mkdtemp 出的临时目录；
//  - 不用固定端口：网关端口用「bind(0) 预占再释放」拿到空闲回环端口，mock 上游直接 listen(0)；
//  - 不触达真实上游：providers 由用例自己指向 127.0.0.1 上的 mock；默认 defaults.directory = []；
//  - 失败也清理：stop() 杀子进程并删临时目录，同时注册 process exit 兜底清理。
// 使用：const fx = await startGateway({ name, config }); try { ... } finally { await fx.stop() }
import http from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = fileURLToPath(new URL('../../', import.meta.url))

// 预占一个空闲回环端口再释放：比写死端口更能避免并行 checkout/残留进程的占用冲突。
export async function reservePort() {
  const s = http.createServer()
  s.listen(0, '127.0.0.1')
  await once(s, 'listening')
  const port = s.address().port
  await new Promise((r) => s.close(r))
  return port
}

// 本地 mock 上游：handler 自定义行为，端口由 OS 分配。
export async function startMockServer(handler) {
  const server = http.createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  const base = 'http://127.0.0.1:' + port
  return {
    port,
    base,
    server,
    url: (p = '') => base + p,
    stop: async () => {
      server.closeAllConnections?.()
      await new Promise((r) => server.close(r))
    },
  }
}

const exitCleanups = new Set()
let exitHook = false
function trackSync(fn) {
  exitCleanups.add(fn)
  if (!exitHook) {
    exitHook = true
    process.once('exit', () => { for (const c of exitCleanups) { try { c() } catch {} } })
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 启动隔离网关实例。config 是 gateway.json 内容；server.port 由夹具分配，调用方不必写。
export async function startGateway(opts = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'modelgate-' + (opts.name || 'gw') + '-'))
  const port = await reservePort()
  const base = 'http://127.0.0.1:' + port
  const provided = opts.config || {}
  const server = Object.assign({ host: '127.0.0.1', port, logFile: join(dir, 'gateway.log') }, provided.server || {}, opts.server || {})
  const defaults = Object.assign({
    clientKey: '',
    directory: [],              // 默认清空目录链：未显式配置的兜底模型不应把请求兜成 200
    retry: { maxAttempts: 1, initialDelayMs: 10, maxDelayMs: 20 },
    timeout: { connectMs: 3000, firstByteMs: 5000, idleMs: 5000 },
    failbackProbe: { enabled: false },
  }, provided.defaults || {})
  if (provided.defaults && provided.defaults.directory === undefined) defaults.directory = []
  const cfg = Object.assign({ providers: {}, models: {}, virtualModels: [] }, provided, { server, defaults })
  await writeFile(join(dir, 'gateway.json'), JSON.stringify(cfg, null, 2))

  const env = Object.assign({}, process.env, {
    MG_CONFIG_DIR: dir,
    MG_CONFIG: join(dir, 'gateway.json'),
    MG_KEYS_MASTER: 'isolated-test-master',
    MG_MAX_BODY: '',
    MG_CLIENT_KEY: '',
    MG_ADMIN_TOKEN: 'devtoken',
    MG_SILENT: '1',
  }, opts.env || {})

  const child = spawn(process.execPath, ['src/index.js'], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'], env })
  let stderr = ''
  child.stderr.on('data', (b) => { stderr += String(b) })
  const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })))
  trackSync(() => { try { child.kill('SIGKILL') } catch {} ; try { rmSync(dir, { recursive: true, force: true }) } catch {} })

  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited }
    await rm(dir, { recursive: true, force: true })
  }

  const call = (path, o = {}) => {
    const headers = Object.assign({}, o.headers || {})
    let body = o.body
    if (body !== undefined && typeof body !== 'string') { headers['content-type'] = 'application/json'; body = JSON.stringify(body) }
    return fetch(base + path, { method: o.method || 'GET', headers, body })
  }
  const admin = { authorization: 'Bearer devtoken' }
  const get = (path, headers) => call(path, { method: 'GET', headers })
  const post = (path, body, headers) => call(path, { method: 'POST', body, headers })
  const status = async () => (await (await get('/api/status', admin)).json())
  const chat = (model, stream, extra) => post('/v1/chat/completions', { model, stream: !!stream, messages: [{ role: 'user', content: 'x' }], ...(extra || {}) })

  let ready = false
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) { await stop(); throw new Error('isolated gateway exited early: ' + stderr.slice(-2000)) }
    try { if ((await call('/healthz')).ok) { ready = true; break } } catch { /* not up yet */ }
    await sleep(25)
  }
  if (!ready) { await stop(); throw new Error('isolated gateway did not become ready: ' + stderr.slice(-2000)) }

  return { base, dir, port, child, get, post, call, admin, status, chat, stop, stderr: () => stderr }
}

// 杀子进程并等它真正退出：网关退出前仍可能写日志/统计，先等退出再删目录，否则目录会被重建。
export async function killAndWait(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  await new Promise((resolve) => { child.once('exit', resolve); try { child.kill() } catch { resolve() } })
}

// 轮询直到 fn() 返回真值；超时返回 false（断言失败交给用例，不用空等）。
export async function waitFor(fn, timeoutMs = 5000, everyMs = 50) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    let v = false
    try { v = await fn() } catch { v = false }
    if (v) return v
    await sleep(everyMs)
  }
  return false
}
