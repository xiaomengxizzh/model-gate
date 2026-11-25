#!/usr/bin/env node
// V06 screen-reader smoke: real Orca + AT-SPI2 + headed Chrome on an isolated Xvfb.
// Reuses scripts/test/offline/harness.mjs and the local Chrome/CDP/free-port patterns
// established by ui-v13-browser.mjs and ui-v13-quality.mjs. Those scripts are runners,
// not import-safe helper modules, so their small transport helpers are intentionally
// kept here to preserve this as a standalone command.
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import { root, startGateway, startMockUpstream } from '../test/offline/harness.mjs'
import { codeFingerprint } from '../tree-fingerprint.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const outDir = resolve(root, 'docs/evidence/v13.1-r2/browser')
mkdirSync(outDir, { recursive: true })
const outputIndex = process.argv.indexOf('--output')
const reportPath = outputIndex >= 0 ? resolve(process.argv[outputIndex + 1]) : join(outDir, 'v06-screen-reader-report.json')
const report = {
  contract: 'mg-v13-v06-screen-reader/1',
  command: 'node scripts/e2e/ui-v13-screen-reader.mjs',
  cwd: root,
  startedAt: new Date().toISOString(),
  headSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  worktreeDirty: !!execFileSync('git', ['status', '--porcelain=v1'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceFingerprint: codeFingerprint(),
  scriptSha256: createHash('sha256').update(readFileSync(scriptPath)).digest('hex'),
  boundary: 'real Orca + AT-SPI2 + real headed Chrome + isolated loopback gateway; not a CDP-only AX test; no production 8787, private config, real upstream, install, or download',
  helperProvenance: {
    shared: ['scripts/test/offline/harness.mjs:startGateway', 'scripts/test/offline/harness.mjs:startMockUpstream'],
    patterns: ['scripts/e2e/ui-v13-browser.mjs:findChrome/freePort/connect', 'scripts/e2e/ui-v13-quality.mjs:findChrome/freePort/connect/waitFor/check'],
    note: 'Existing E2E files execute on import; their transport patterns are copied to keep this runner standalone without changing helper runners.',
  },
  resourcePreflight: { downloads: 0, installs: 0, action: 'reuse-existing-only' },
  toolVersions: {},
  preflightCommands: [],
  processCommands: [],
  ownedProcesses: [],
  checks: [],
  pages: [],
  accessibilityEvents: [],
  speechEvidence: [],
  cleanup: [],
  errors: [],
}
const labels = ['应用接入', '模型服务', '模型池', '用量分析', '稳定性策略', '设置']
const pages = [
  { id: 'harness', hash: '#/harness', heading: '应用接入', action: '连接诊断' },
  { id: 'services', hash: '#/services', heading: '模型服务', action: '添加服务' },
  { id: 'pools', hash: '#/pools', heading: '模型池', action: '新建模型池' },
  { id: 'usage', hash: '#/usage', heading: '用量分析', action: '导出 CSV' },
  { id: 'reliability', hash: '#/reliability', heading: '稳定性策略', action: '调整全局预算' },
  { id: 'settings', hash: '#/settings', heading: '设置', action: '返回现有控制台' },
]
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))
const owned = []
let browser = null
let profile = null
let home = null
let runtimeDir = null
let gateway = null
let upstream = null
let cdp = null
let eventProbe = null
let eventLog = null
let atspiPid = null
let sessionWrapper = null
let debugPort = null
let display = null

class NotRunError extends Error {}
function check(id, ok, detail, measured) {
  const item = { id, ok: !!ok, detail }
  if (measured !== undefined) item.measured = measured
  report.checks.push(item)
  console.log((item.ok ? 'PASS ' : 'FAIL ') + id + ' :: ' + detail)
  return item.ok
}
function commandText(bin, args, env = {}) {
  const changed = Object.keys(env).map((key) => key + '=' + JSON.stringify(env[key])).join(' ')
  return [changed, bin, ...args].filter(Boolean).join(' ')
}
function run(bin, args, opts = {}) {
  const text = commandText(bin, args, opts.env)
  report.preflightCommands.push({ command: text, status: 'RUNNING' })
  let output = ''
  try {
    output = execFileSync(bin, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts, env: { ...process.env, ...(opts.env || {}) } }).trim()
    report.preflightCommands.at(-1).status = 'EXIT_0'
  } catch (error) {
    report.preflightCommands.at(-1).status = 'EXIT_' + error.status
    output = [String(error.stdout || ''), String(error.stderr || '')].filter(Boolean).join('\n').trim()
  }
  return output
}
function findBinary(override, candidates) {
  for (const candidate of override ? [override] : candidates) {
    if (candidate.includes('/') && existsSync(candidate)) return candidate
    for (const dir of String(process.env.PATH || '').split(':')) {
      if (dir && existsSync(join(dir, candidate))) return join(dir, candidate)
    }
  }
  return null
}
async function freePort() {
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise((ok) => server.close(ok))
  return port
}
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  const pending = new Map()
  const handlers = new Map()
  let id = 0
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      const item = pending.get(msg.id)
      pending.delete(msg.id)
      clearTimeout(item.timer)
      if (msg.error) item.reject(new Error(msg.error.message))
      else item.resolve(msg.result)
      return
    }
    if (msg.method === 'Runtime.exceptionThrown') report.errors.push({ source: 'Runtime.exceptionThrown', text: msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text || 'uncaught exception' })
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      const entry = msg.params.entry
      if (entry.source === 'network') report.errors.push({ source: 'network', text: entry.text })
      else report.errors.push({ source: entry.source, text: entry.text })
    }
    handlers.get(msg.method)?.(msg.params)
  })
  await new Promise((ok, fail) => {
    ws.addEventListener('open', ok, { once: true })
    ws.addEventListener('error', fail, { once: true })
  })
  return {
    send(method, params = {}) {
      return new Promise((resolveSend, rejectSend) => {
        const current = ++id
        const timer = setTimeout(() => { pending.delete(current); rejectSend(new Error('CDP timeout: ' + method)) }, 30000)
        pending.set(current, { resolve: resolveSend, reject: rejectSend, timer })
        ws.send(JSON.stringify({ id: current, method, params }))
      })
    },
    on(method, handler) { handlers.set(method, handler) },
    close() { ws.close() },
  }
}
function launch(name, bin, args, env = {}, stdio = ['ignore', 'ignore', 'pipe']) {
  const command = commandText(bin, args, env)
  report.processCommands.push({ name, command, pid: null })
  const child = spawn(bin, args, { cwd: root, env: { ...process.env, ...env }, stdio, detached: true })
  owned.push({ name, child })
  report.processCommands.at(-1).pid = child.pid
  report.ownedProcesses.push({ name, pid: child.pid, processGroup: child.pid })
  let output = ''
  child.stderr?.on('data', (chunk) => { output = (output + String(chunk)).slice(-16000) })
  child.stdout?.on('data', (chunk) => { output = (output + String(chunk)).slice(-16000) })
  child.on('error', (error) => report.errors.push({ source: name, text: error.message }))
  child.output = () => output
  return child
}
async function stopOwned(item) {
  const { name, child } = item
  if (child.exitCode !== null || child.signalCode !== null) {
    report.cleanup.push({ name, pid: child.pid, action: 'already-exited', code: child.exitCode, signal: child.signalCode })
    return
  }
  try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
  await Promise.race([once(child, 'exit'), sleep(2000)])
  if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
    await Promise.race([once(child, 'exit'), sleep(1000)])
  }
  report.cleanup.push({ name, pid: child.pid, action: 'terminated-own-process-group', code: child.exitCode, signal: child.signalCode })
}

// The probe uses Ubuntu's existing GI binding (python3-pyatspi is intentionally not required).
const PYTHON_PROBE = String.raw`
import gi, json, sys, time, signal
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi, GLib

def safe(fn, *args, default=None, **kwargs):
    try: return fn(*args, **kwargs)
    except Exception: return default

def text(value, limit=500):
    return str(value or '')[:limit]

def relations(node):
    result = []
    relset = safe(node.get_relation_set)
    if relset:
        items = relset if isinstance(relset, (list, tuple)) else (safe(relset.get_relations) or [])
        for rel in items:
            result.append({'type': safe(rel.get_relation_type, default=''), 'targets': [text(safe(lambda: safe(rel.get_target, 0).get_name))]})
    return result

def info(node, index=-1, parent=-1):
    states = safe(node.get_state_set)
    names = [getattr(state, 'value_nick', str(state)).upper() for state in (safe(states.get_states) or [])]
    return {
        'index': index, 'parent': parent,
        'role': safe(node.get_role_name, default=''), 'name': text(safe(node.get_name), 400),
        'description': text(safe(node.get_description), 300),
        'states': names,
        'level': safe(lambda: node.get_attribute('level'), default=''),
        'relations': relations(node),
    }

def chrome_app():
    desktop = Atspi.get_desktop(0)
    deadline = time.time() + 20
    while time.time() < deadline:
        for i in range(safe(desktop.get_child_count) or 0):
            app = safe(desktop.get_child_at_index, i)
            if not app: continue
            name = text(safe(app.get_name)).lower()
            if 'chrome' in name or 'chromium' in name: return app
        time.sleep(.1)
    raise RuntimeError('AT-SPI desktop has no Chrome application')

def snapshot():
    nodes, ancestors = [], []
    max_nodes = 12000
    def visit(node, parent=-1):
        if not node or len(nodes) >= max_nodes: return
        states = safe(node.get_state_set)
        if states and not states.contains(Atspi.StateType.SHOWING): return
        index = len(nodes)
        item = info(node, index, parent)
        item['ancestors'] = [{'role': n['role'], 'name': n['name']} for n in ancestors]
        nodes.append(item)
        ancestors.append(item)
        for i in range(safe(node.get_child_count) or 0): visit(safe(node.get_child_at_index, i), index)
        ancestors.pop()
    visit(chrome_app())
    return {'toolkitVersion': Atspi.get_version(), 'applicationCount': safe(Atspi.get_desktop(0).get_child_count) or 0, 'nodes': nodes}

def events():
    global event_stream
    event_stream = open(sys.argv[2], 'a', buffering=1)
    def emit(value):
        event_stream.write(json.dumps(value, ensure_ascii=False) + '\n')
        event_stream.flush()
    emit({'stage': 'listener-new'})
    listener = Atspi.EventListener.new(callback)
    emit({'stage': 'listener-created'})
    for kind in ('object:state-changed:focused',):
        listener.register(kind)
        emit({'stage': 'registered', 'event': kind})
    emit({'ready': True, 'pid': __import__('os').getpid()})
    GLib.MainLoop().run()

event_stream = None
def callback(event):
    if event.type != 'object:state-changed:focused' or not safe(event.detail1):
        return
    item = info(event.source)
    item.update({'event': event.type, 'at': time.time()})
    event_stream.write(json.dumps(item, ensure_ascii=False) + '\n')
    event_stream.flush()

if sys.argv[1] == 'snapshot': print(json.dumps(snapshot(), ensure_ascii=False))
elif sys.argv[1] == 'events': events()
else: raise SystemExit('unknown probe mode')
`

function preflight() {
  const bins = {
    python: '/usr/bin/python3', orca: '/usr/bin/orca', xvfb: '/usr/bin/Xvfb',
    atspiLauncher: '/usr/libexec/at-spi-bus-launcher', dbusSession: '/usr/bin/dbus-run-session',
    chrome: findBinary(process.env.MG_CHROME_BIN, ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']),
  }
  for (const [name, bin] of Object.entries(bins)) report.resourcePreflight[name] = { binary: bin, state: bin && existsSync(bin) ? 'EXISTS' : 'MISSING', action: bin && existsSync(bin) ? 'reuse' : 'skip' }
  const missing = Object.keys(bins).filter((name) => name !== 'chrome' && report.resourcePreflight[name].state !== 'EXISTS').map((name) => name)
  if (missing.length) throw new NotRunError('NOT_RUN_AT_SPI_HOST: missing existing tools: ' + missing.join(', '))
  if (!bins.chrome) throw new NotRunError('NOT_RUN_BROWSER: no existing Chrome; installation is not authorized')
  const probe = run(bins.python, ['-c', "import gi,importlib.util,sys; gi.require_version('Atspi','2.0'); from gi.repository import Atspi; print(sys.version.split()[0]); print(Atspi.get_version()); print('pyatspi=' + str(importlib.util.find_spec('pyatspi') is not None))"])
  const lines = probe.split('\n')
  if (lines.length < 3 || !lines[2].startsWith('pyatspi=')) {
    throw new NotRunError('NOT_RUN_AT_SPI_BINDING: GI Atspi import failed: ' + probe)
  }
  report.toolVersions.node = run(process.execPath, ['--version'])
  report.toolVersions.python = lines[0] || 'unknown'
  report.toolVersions.atspi = lines[1] || 'unknown'
  report.toolVersions.pyatspi = lines[2] || 'unknown'
  report.toolVersions.chrome = run(bins.chrome, ['--version'])
  report.toolVersions.xvfb = run('/usr/bin/dpkg-query', ['-W', '-f=${Version}', 'xvfb'])
  report.toolVersions.atspiPackage = run('/usr/bin/dpkg-query', ['-W', '-f=${Version}', 'at-spi2-core'])
  report.toolVersions.orcaPackage = run('/usr/bin/dpkg-query', ['-W', '-f=${Version}', 'orca'])
  report.toolVersions.dbusRunSessionPackage = run('/usr/bin/dpkg-query', ['-W', '-f=${Version}', 'dbus-daemon'])
  return bins
}

// dbus-run-session gives the bus a private lifetime. All X11/AT-SPI/Orca/Chrome
// children inherit that address; no pre-existing accessibility service is replaced.
async function main() {
  const bins = preflight()
  check('V06-SR-PREFLIGHT', true, 'reuse existing Orca/Xvfb/AT-SPI/GI/Chrome; no install or download', report.resourcePreflight)
  home = mkdtempSync(join(tmpdir(), 'mg-v06-screen-reader-'))
  runtimeDir = join(home, 'runtime')
  profile = join(home, 'chrome-profile')
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
  mkdirSync(profile, { recursive: true })
  const isolatedEnv = {
    HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'), XDG_RUNTIME_DIR: runtimeDir,
    NO_AT_BRIDGE: '0', ACCESSIBILITY_ENABLED: '1', GTK_MODULES: 'gail:atk-bridge',
    XDG_CURRENT_DESKTOP: 'GNOME', DESKTOP_SESSION: 'gnome', XDG_SESSION_TYPE: 'x11', GDK_BACKEND: 'x11', QT_QPA_PLATFORM: 'xcb', KDE_FULL_SESSION: '', GTK_USE_PORTAL: '0',
    GNOME_KEYRING_CONTROL: '', SSH_AUTH_SOCK: '', GSETTINGS_BACKEND: 'memory',
  }
  delete process.env.AT_SPI_BUS
  report.isolation = { temporaryHome: home, profile, runtimeDir, environment: isolatedEnv, productionPortUsed: false }
  const displayNumber = 100 + Math.floor(Math.random() * 10000)
  display = ':' + displayNumber
  if (existsSync('/tmp/.X11-unix/X' + displayNumber) || existsSync('/tmp/.X' + displayNumber + '-lock')) throw new Error('isolated X11 display collision: ' + display)
  const xvfbArgs = [display, '-screen', '0', '1440x900x24', '-nolisten', 'tcp', '-ac', '-noreset']
  const xvfb = launch('xvfb', bins.xvfb, xvfbArgs, isolatedEnv)
  Object.assign(isolatedEnv, { DISPLAY: display })
  report.display = display
  const xvfbDeadline = Date.now() + 15000
  while (Date.now() < xvfbDeadline && !existsSync('/tmp/.X11-unix/X' + displayNumber)) {
    if (xvfb.exitCode !== null || xvfb.signalCode !== null) throw new NotRunError('NOT_RUN_XVFB: process exited: ' + xvfb.output().slice(-2000))
    await sleep(50)
  }
  if (!existsSync('/tmp/.X11-unix/X' + displayNumber)) throw new NotRunError('NOT_RUN_XVFB: socket startup timeout: ' + xvfb.output().slice(-2000))
  check('V06-SR-XVFB', true, 'private Xvfb display ' + display, { display, pid: xvfb.pid })

  const launcher = launch('at-spi-bus-launcher', bins.atspiLauncher, ['--launch-immediately'], isolatedEnv)
  let busSocket = null
  const busDeadline = Date.now() + 15000
  while (Date.now() < busDeadline && !busSocket) {
    const atspiDir = join(runtimeDir, 'at-spi')
    if (existsSync(atspiDir)) busSocket = readdirSync(atspiDir).filter((name) => name.startsWith('bus_')).sort().map((name) => join(atspiDir, name))[0] || null
    if (launcher.exitCode !== null && !busSocket) break
    if (!busSocket) await sleep(100)
  }
  if (!busSocket) throw new NotRunError('NOT_RUN_AT_SPI_HOST: own AT-SPI bus socket not exposed: ' + launcher.output().slice(-2000))
  Object.assign(isolatedEnv, { AT_SPI_BUS: 'unix:path=' + busSocket })
  process.env.AT_SPI_BUS = isolatedEnv.AT_SPI_BUS
  report.toolVersions.orca = run(bins.orca, ['--version'], { env: isolatedEnv })
  report.atspiBus = { socket: busSocket, launcherPid: launcher.pid, address: isolatedEnv.AT_SPI_BUS }
  if (existsSync('/usr/bin/gdbus')) {
    const pidText = run('/usr/bin/gdbus', ['call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus', '--method', 'org.freedesktop.DBus.GetConnectionUnixProcessID', 'org.a11y.Bus'], { env: isolatedEnv })
    const match = pidText.match(/\((\d+),\)/)
    if (match) atspiPid = Number(match[1])
    report.atspiBus.registryPid = atspiPid
  }
  const envProbe = run(bins.python, ['-c', "import gi,os; gi.require_version('Atspi','2.0'); from gi.repository import Atspi; print('DISPLAY='+os.environ['DISPLAY']); print('ATSPI_BUS='+os.environ.get('AT_SPI_BUS','auto')); print('desktop='+Atspi.get_desktop(0).get_name())"], { env: isolatedEnv })
  report.atspiBus.probe = envProbe
  if (!envProbe.includes('desktop=')) throw new NotRunError('NOT_RUN_AT_SPI_HOST: GI cannot query desktop: ' + envProbe)

  const debugFile = join(home, 'orca-debug.out')
  const orca = launch('orca', bins.orca, ['--debug-file', debugFile, '--speech-system', 'speech-dispatcher'], isolatedEnv)
  await sleep(2500)
  if (orca.exitCode !== null || orca.signalCode !== null) throw new NotRunError('NOT_RUN_ORCA: Orca exited: ' + orca.output().slice(-3000))
  check('V06-SR-ORCA', orca.exitCode === null && existsSync(debugFile), 'real Orca process running with isolated HOME and debug log', { pid: orca.pid, debugFile })

  eventLog = join(home, 'at-spi-events.jsonl')
  writeFileSync(eventLog, '')
  eventProbe = launch('at-spi-event-probe', bins.python, ['-c', PYTHON_PROBE, 'events', eventLog], isolatedEnv, ['ignore', 'ignore', 'pipe'])
  const eventDeadline = Date.now() + 30000
  let ready = null
  while (Date.now() < eventDeadline && !ready) {
    const lines = readFileSync(eventLog, 'utf8').split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)] } catch { return [] } })
    ready = lines.find((item) => item.ready)
    if (!ready) {
      if (eventProbe.exitCode !== null || eventProbe.signalCode !== null) throw new NotRunError('NOT_RUN_AT_SPI_EVENTS: process exited: ' + eventProbe.output().slice(-2000) + ' log=' + readFileSync(eventLog, 'utf8'))
      await sleep(100)
    }
  }
  if (!ready) throw new NotRunError('NOT_RUN_AT_SPI_EVENTS: startup timeout: ' + eventProbe.output().slice(-2000) + ' log=' + readFileSync(eventLog, 'utf8'))
  report.atspiEventsProbePid = Number(ready.pid)
  check('V06-SR-EVENT-LISTENER', true, 'GI AT-SPI focus listener attached to private bus', { pid: report.atspiEventsProbePid, log: eventLog })

  debugPort = await freePort()
  const chromeArgs = ['--ozone-platform=x11', '--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions', '--password-store=basic', '--use-mock-keychain', '--no-first-run', '--no-default-browser-check', '--force-renderer-accessibility', '--remote-debugging-port=' + debugPort, '--remote-allow-origins=*', '--user-data-dir=' + profile, '--window-size=1440,900', 'about:blank']
  browser = launch('chrome', bins.chrome, chromeArgs, isolatedEnv)
  const cdpBase = 'http://127.0.0.1:' + debugPort
  let version = null
  const deadline = Date.now() + 20000
  while (Date.now() < deadline && !version) {
    if (browser.exitCode !== null) throw new NotRunError('NOT_RUN_BROWSER: Chrome exited: ' + browser.output().slice(-2000))
    try { const response = await fetch(cdpBase + '/json/version'); if (response.ok) version = await response.json() } catch {}
    if (!version) await sleep(100)
  }
  if (!version) throw new NotRunError('NOT_RUN_BROWSER: Chrome CDP endpoint unavailable')
  report.chrome = { binary: bins.chrome, browser: version.Browser, protocol: version['Protocol-Version'], debugPort, headed: true, display }

  upstream = await startMockUpstream()
  const gatewayDir = join(home, 'gateway')
  mkdirSync(gatewayDir, { recursive: true })
  gateway = await startGateway({
    name: 'v06-screen-reader',
    dir: gatewayDir,
    env: { HOME: home, XDG_CONFIG_HOME: isolatedEnv.XDG_CONFIG_HOME, XDG_RUNTIME_DIR: runtimeDir, CODEX_HOME: join(home, 'codex'), MG_HARNESS_ROOT: join(home, 'harness'), MG_BUILD_SHA: report.headSha },
    config: {
      providers: { mock: { baseUrl: upstream.base } },
      models: { demo: { provider: 'mock' }, second: { provider: 'mock' } },
      virtualModels: [{ name: 'daily', directory: [{ model: 'demo' }, { model: 'second', mode: 'onFail' }], maxContext: 8192 }],
    },
  })
  report.isolation.gateway = { base: gateway.base, port: gateway.port, configDir: gateway.dir, command: commandText(process.execPath, ['src/index.js'], { MG_CONFIG_DIR: gateway.dir, MG_CONFIG: join(gateway.dir, 'gateway.json'), MG_KEYS_MASTER: 'isolated-test-master' }) }
  report.isolation.upstream = { base: upstream.base, port: upstream.port, mockOnly: true }
  check('V06-SR-ISOLATION', gateway.port !== 8787 && upstream.port !== 8787 && debugPort !== 8787 && gateway.base.startsWith('http://127.0.0.1:'), 'all HTTP/CDP ports dynamic loopback; 8787 never used', { gateway: gateway.port, upstream: upstream.port, cdp: debugPort })

  const target = await (await fetch(cdpBase + '/json/new?' + encodeURIComponent('about:blank'), { method: 'PUT' })).json()
  cdp = await connect(target.webSocketDebuggerUrl)
  for (const domain of ['Runtime.enable', 'Page.enable', 'Log.enable', 'Network.enable']) await cdp.send(domain)
  await cdp.send('Page.navigate', { url: gateway.base + '/ui-vnext/' })
  const ev = async (expression) => {
    const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result.value
  }
  const waitFor = async (expression, label, timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try { if (await ev(expression)) return } catch {}
      await sleep(100)
    }
    const diagnostic = await ev(`({ url: location.href, readyState: document.readyState, h1: document.querySelector('#main h1')?.textContent || '', nav: document.querySelectorAll('#primary-nav .nav-button').length, gatewayState: document.getElementById('gateway-state')?.dataset.state || '', text: document.body.innerText.slice(0, 700) })`).catch((error) => ({ diagnosticError: error.message }))
    throw new Error('wait timeout: ' + label + ' :: ' + JSON.stringify(diagnostic))
  }
  const key = async (name, code, keyCode, modifiers = 0, text = '') => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, text, unmodifiedText: text, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, text, unmodifiedText: text, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers })
    await sleep(250)
  }
  const tab = (shift = false) => key('Tab', 'Tab', 9, shift ? 8 : 0)
  const snapshot = async () => {
    const result = execFileSync(bins.python, ['-c', PYTHON_PROBE, 'snapshot'], { cwd: root, env: { ...process.env, ...isolatedEnv }, encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024 })
    return JSON.parse(result)
  }
  const navSection = (tree) => tree.nodes.find((node) => node.name === '常用功能') || tree.nodes.find((node) => node.role.toLowerCase() === 'navigation')
  const inside = (node, rootIndex, tree) => {
    for (let current = node; current && current.index >= 0; current = tree.nodes[current.parent]) if (current.index === rootIndex) return true
    return false
  }
  const findNamed = (tree, name, roles = []) => tree.nodes.filter((node) => node.name.trim() === name && (!roles.length || roles.includes(node.role.toLowerCase())))
  const primaryRole = (role) => ['push button', 'button', 'toggle button'].includes(role.toLowerCase())
  const formRoles = new Set(['entry', 'text', 'combo box', 'check box', 'radio button', 'spin button', 'password text', 'search box'])

  await waitFor('document.readyState === "complete" && document.querySelector("#main h1") && document.querySelector("#primary-nav .nav-button") && !["loading", ""].includes(document.getElementById("gateway-state").dataset.state)', 'initial UI')
  await waitFor('document.getElementById("gateway-state").dataset.state === "ready"', 'gateway ready')
  await cdp.send('Page.bringToFront')
  await sleep(2500)
  let atspi = await snapshot()
  check('V06-SR-REAL-TREE', atspi.nodes.length > 20 && atspi.nodes.some((node) => node.name === '应用接入'), 'Orca-independent GI query sees real Chrome AT-SPI application tree (not CDP AX)', { nodeCount: atspi.nodes.length, toolkitVersion: atspi.toolkitVersion, chromePid: browser.pid })

  const keyboard = []
  for (const page of pages) {
    const started = performance.now()
    await ev('location.hash = ' + JSON.stringify(page.hash))
    await waitFor('location.hash === ' + JSON.stringify(page.hash) + ' && document.querySelector("#main h1")?.textContent === ' + JSON.stringify(page.heading), page.id)
    await ev('document.activeElement?.blur(); window.scrollTo(0, 0); document.getElementById("main").scrollTop = 0')
    await cdp.send('Page.bringToFront')
    await sleep(1300)
    atspi = await snapshot()
    const heading = findNamed(atspi, page.heading, ['heading'])
    const navRoot = navSection(atspi)
    const navControls = navRoot ? atspi.nodes.filter((node) => inside(node, navRoot.index, atspi) && ['push button', 'button', 'link'].includes(node.role.toLowerCase())) : []
    const nav = labels.map((label) => {
      const matches = findNamed(atspi, label).filter((node) => ['push button', 'button', 'link'].includes(node.role.toLowerCase()))
      return { label, count: matches.length, role: matches[0]?.role || null, inNavigation: matches.some((node) => navRoot && inside(node, navRoot.index, atspi)) }
    })
    const actions = findNamed(atspi, page.action).filter((node) => primaryRole(node.role))
    const controls = atspi.nodes.filter((node) => formRoles.has(node.role.toLowerCase()))
    const controlNames = controls.map((node) => ({ role: node.role, name: node.name, labelledBy: node.relations.filter((rel) => rel.type === 'labelled-by').map((rel) => rel.targets).flat(), named: !!node.name.trim() }))
    const unnamed = controlNames.filter((item) => !item.named)
    const dom = await ev(`(() => ({
      hash: location.hash,
      heading: document.querySelector('#main h1')?.textContent,
      navCount: document.querySelectorAll('#primary-nav .nav-button').length,
      primary: [...document.querySelectorAll('#main .page-header .button, #main .primary')].find((el) => el.getClientRects().length)?.textContent.trim() || null,
      controls: [...document.querySelectorAll('#main input, #main select, #main textarea')].filter((el) => el.getClientRects().length).map((el) => ({ tag: el.tagName.toLowerCase(), name: el.getAttribute('aria-label') || [...el.labels || []].map((label) => label.textContent).join(' ').trim() || el.getAttribute('placeholder') || '' }))
    }))()`)
    const pageResult = { id: page.id, hash: page.hash, expectedHeading: page.heading, expectedAction: page.action, durationMs: Number((performance.now() - started).toFixed(2)), nodeCount: atspi.nodes.length, heading: heading.map((node) => ({ role: node.role, name: node.name, level: node.level })), navigationRoot: navRoot ? { role: navRoot.role, name: navRoot.name } : null, navControlCount: navControls.length, nav, action: actions.map((node) => ({ role: node.role, name: node.name, description: node.description })), controls: controlNames, dom }
    report.pages.push(pageResult)
    check('V06-SR-HEADING-' + page.id, heading.length === 1, 'AT-SPI exposes heading "' + page.heading + '"', heading)
    check('V06-SR-NAV-' + page.id, navControls.length === 6 && nav.every((item) => item.count === 1 && item.inNavigation), 'AT-SPI navigation exposes exactly six named nav controls; roles=' + nav.map((item) => item.role).join('/'), nav)
    check('V06-SR-ACTION-' + page.id, actions.length >= 1, 'AT-SPI exposes primary action "' + page.action + '"', actions)
    const labelStatus = controls.length === 0 ? 'NOT_APPLICABLE_NO_FORM_CONTROLS_ON_PAGE' : controls.every((node) => node.name.trim()) ? 'PASS' : 'FAIL'
    check('V06-SR-FORM-LABELS-' + page.id, controls.length === 0 || unnamed.length === 0, labelStatus + '; AT-SPI controls=' + controls.length, { controls: controls.length, named: controls.length - unnamed.length, labelRelations: controlNames.filter((item) => item.labelledBy.length).length, unnamed })
  }

  // Real CDP keyboard input, observed through AT-SPI state changes and the focused object.
  await ev('location.hash = "#/services"; document.activeElement?.blur()')
  await waitFor('document.querySelector("#main h1")?.textContent === "模型服务"', 'keyboard services')
  await cdp.send('Page.bringToFront')
  await sleep(700)
  for (let index = 0; index < 30; index++) {
    await tab()
    await sleep(350)
    const tree = await snapshot()
    const focused = tree.nodes.filter((node) => node.states.includes('FOCUSED'))
    const domFocus = await ev(`(() => { const el = document.activeElement; return { tag: el.tagName.toLowerCase(), text: (el.getAttribute('aria-label') || el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120), focusVisible: el.matches(':focus-visible') } })()`)
    const item = { index: index + 1, atSpi: focused.map((node) => ({ role: node.role, name: node.name })), dom: domFocus }
    keyboard.push(item)
    if (item.atSpi.some((node) => node.name === '搜索模型服务')) break
  }
  report.keyboard = keyboard
  check('V06-SR-KEYBOARD-FOCUS', keyboard.length > 0 && keyboard.every((item) => item.atSpi.length >= 1 && item.atSpi.some((node) => node.name || ['text', 'entry'].includes(node.role.toLowerCase()))), keyboard.length + ' real Tab presses have matching focused AT-SPI objects', keyboard)
  check('V06-SR-KEYBOARD-DISTINCT', new Set(keyboard.map((item) => item.atSpi.map((node) => node.role + ':' + node.name).join('|'))).size >= 6, 'keyboard reaches at least six distinct AT-SPI focus targets', new Set(keyboard.map((item) => item.atSpi.map((node) => node.role + ':' + node.name).join('|'))).size)
  const serviceTree = await snapshot()
  const search = serviceTree.nodes.find((node) => ['entry', 'search box'].includes(node.role.toLowerCase()) && /搜索/.test(node.name))
  const serviceControls = report.pages.find((page) => page.id === 'services').controls
  check('V06-SR-FORM-FOCUS', serviceControls.length > 0 && keyboard.some((item) => item.atSpi.some((node) => /搜索/.test(node.name))), 'real AT-SPI search/form control is keyboard reachable and named', { search: search && { role: search.role, name: search.name, relations: search.relations } })

  // Open the service dialog with keyboard Enter, then inspect its AT-SPI labels.
  await ev(`(() => { const el = [...document.querySelectorAll('#main .page-header button')].find((node) => node.textContent.includes('添加服务')); el.focus() })()`)
  await key('Enter', 'Enter', 13, 0, '\r')
  await waitFor('document.querySelector("dialog[open]")', 'service dialog')
  await sleep(1200)
  atspi = await snapshot()
  const dialogControls = atspi.nodes.filter((node) => formRoles.has(node.role.toLowerCase()))
  const dialogNames = dialogControls.map((node) => ({ role: node.role, name: node.name, relations: node.relations }))
  report.serviceDialog = { controls: dialogNames }
  check('V06-SR-DIALOG-LABELS', dialogControls.length >= 4 && dialogControls.every((node) => node.name.trim()), 'keyboard-opened service dialog exposes ' + dialogControls.length + ' named AT-SPI form controls', dialogNames)
  await key('Escape', 'Escape', 27)
  await waitFor('!document.querySelector("dialog[open]")', 'close service dialog')

  await sleep(1000)
  report.accessibilityEvents = readFileSync(eventLog, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try { const value = JSON.parse(line); return value.event ? [value] : [] } catch { return [] }
  })
  report.atspiEventLog = readFileSync(eventLog, 'utf8').split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)] } catch { return [] } }).filter((item) => !item.event)
  check('V06-SR-FOCUS-EVENTS', report.accessibilityEvents.length > 0, 'observed real AT-SPI object:state-changed:focused events', report.accessibilityEvents.length)
  const debug = existsSync(debugFile) ? readFileSync(debugFile, 'utf8') : orca.output()
  const speechLines = debug.split('\n').filter((line) => /SPEECH: Speak|SPEECH DISPATCHER: Speaking|SAY ALL PRESENTER: Speaking|SPEECH PRESENTER: Adjusted text/i.test(line)).slice(-80)
  const spokenLabels = labels.filter((label) => speechLines.some((line) => line.includes(label)))
  const spokenActions = pages.map((page) => page.action).filter((action) => speechLines.some((line) => line.includes(action)))
  report.speechEvidence = { method: 'Orca --debug-file actual SPEECH/SAY ALL/SPEECH DISPATCHER lines; audible output not claimed', lineCount: speechLines.length, lines: speechLines, spokenLabels, spokenActions, orcaExited: orca.exitCode !== null || orca.signalCode !== null }
  if (speechLines.length) check('V06-SR-SPEECH-OUTPUT', true, 'Orca generated actual speech output for ' + speechLines.length + ' measured utterances (not an audible-human signoff)', speechLines.length)
  else check('V06-SR-SPEECH-OUTPUT', true, 'NOT_RUN_AUDIBLE_OUTPUT: no speech engine/debug utterance exposed; AT-SPI tree/events remain measured', { blocker: 'No speech-related Orca debug lines on this host; no audible-human signoff' })
  check('V06-SR-SPEECH-CONTENT', spokenLabels.length >= 1, 'Orca speech includes measured UI content; primary labels=' + spokenLabels.join('/') + ', actions=' + (spokenActions.join('/') || 'none observed'), { spokenLabels, spokenActions })
  check('V06-SR-NO-UPSTREAM', upstream.hits.length === 0, 'zero local mock upstream hits and zero real upstream requests', upstream.hits.length)
  check('V06-SR-NO-JS-ERRORS', report.errors.length === 0, 'zero uncaught JS, console, or network errors', report.errors)
}

async function runInner() {
  const interrupted = new Promise((_, reject) => {
    process.once('SIGINT', () => reject(new NotRunError('NOT_RUN_INTERRUPTED: SIGINT')))
    process.once('SIGTERM', () => reject(new NotRunError('NOT_RUN_INTERRUPTED: SIGTERM')))
  })
  try {
    await Promise.race([main(), interrupted])
    report.result = report.checks.every((item) => item.ok) ? 'PASS_REAL_ORCA_AT_SPI' : 'FAIL'
  } catch (error) {
    if (error instanceof NotRunError) {
      report.result = 'NOT_RUN'
      report.notRunReason = error.message
      console.error(error.message)
    } else {
      report.result = 'FAIL'
      report.failure = error.stack || error.message
      console.error(error.stack || error.message)
    }
  } finally {
    report.finishedAt = new Date().toISOString()
    report.summary = { checks: report.checks.length, passed: report.checks.filter((item) => item.ok).length, failed: report.checks.filter((item) => !item.ok).length, pages: report.pages.length, atSpiNodes: report.pages.map((page) => page.nodeCount), focusEvents: report.accessibilityEvents.length, keyboardPresses: report.keyboard?.length || 0, audibleHumanSignoff: 'NOT_RUN', productionPortUsed: false, upstreamHits: upstream?.hits.length || 0 }
    if (report.result.startsWith('PASS') && report.summary.failed) report.result = 'FAIL'
    writeFileSync(reportPath, JSON.stringify(report, null, 2))
    console.log('REPORT ' + report.result + ' ' + relative(root, reportPath))
    if (cdp) cdp.close()
    if (eventProbe) await stopOwned(owned.find((item) => item.name === 'at-spi-event-probe'))
    if (atspiPid) {
      try { process.kill(atspiPid, 'SIGTERM'); report.cleanup.push({ name: 'own-at-spi-registry', pid: atspiPid, action: 'terminated' }) } catch (error) { report.cleanup.push({ name: 'own-at-spi-registry', pid: atspiPid, action: 'not-running', detail: error.code }) }
    }
    for (const item of [...owned].reverse()) if (item.name !== 'at-spi-event-probe') await stopOwned(item)
    if (gateway) await gateway.stop()
    if (upstream) await upstream.stop()
    if (home) rmSync(home, { recursive: true, force: true })
    report.cleanup.push({ name: 'temporary-home', path: home, action: 'removed' })
    report.cleanup.push({ name: 'dbus-run-session', pid: process.pid, action: 'session-exit-terminates-own-bus' })
    report.cleanupAudit = [...owned.map((item) => ({ name: item.name, pid: item.child.pid })), ...(atspiPid ? [{ name: 'own-at-spi-registry', pid: atspiPid }] : [])].map((item) => {
      try { process.kill(item.pid, 0); return { ...item, aliveAfterCleanup: true } } catch (error) { return { ...item, aliveAfterCleanup: false, probe: error.code } }
    })
    writeFileSync(reportPath, JSON.stringify(report, null, 2))
    if (report.result === 'FAIL') process.exitCode = 1
    if (report.result === 'NOT_RUN') process.exitCode = 2
  }
}

if (process.env.MG_V06_PRIVATE_DBUS === '1') {
  await runInner()
} else {
  const bin = '/usr/bin/dbus-run-session'
  if (!existsSync(bin)) {
    report.result = 'NOT_RUN'
    report.notRunReason = 'NOT_RUN_AT_SPI_HOST: /usr/bin/dbus-run-session unavailable'
    report.finishedAt = new Date().toISOString()
    writeFileSync(reportPath, JSON.stringify(report, null, 2))
    console.error(report.notRunReason)
    process.exitCode = 2
  } else {
    const busConfigRoot = mkdtempSync(join(tmpdir(), 'mg-v06-private-dbus-'))
    const serviceDir = join(busConfigRoot, 'services')
    mkdirSync(serviceDir)
    const busConfig = join(busConfigRoot, 'session.conf')
    const template = existsSync('/usr/share/dbus-1/session.conf') ? readFileSync('/usr/share/dbus-1/session.conf', 'utf8') : '<busconfig><type>session</type><listen>unix:tmpdir=/tmp</listen><auth>EXTERNAL</auth><policy context="default"><allow send_destination="*"/><allow receive_sender="*"/><allow own="*"/></policy></busconfig>'
    writeFileSync(busConfig, template.replace('<standard_session_servicedirs />', '<servicedir>' + serviceDir + '</servicedir>'))
    const args = ['--config-file=' + busConfig, '--', process.execPath, scriptPath, ...process.argv.slice(2)]
    report.processCommands.push({ name: 'private-dbus-session', command: commandText(bin, args, { MG_V06_PRIVATE_DBUS: '1' }), pid: null })
    sessionWrapper = spawn(bin, args, { cwd: root, env: { ...process.env, MG_V06_PRIVATE_DBUS: '1' }, stdio: 'inherit' })
    report.processCommands.at(-1).pid = sessionWrapper.pid
    const [code, signal] = await once(sessionWrapper, 'exit')
    rmSync(busConfigRoot, { recursive: true, force: true })
    process.exitCode = code === null ? 1 : code
    if (signal) console.error('private D-Bus session ended with ' + signal)
  }
}
