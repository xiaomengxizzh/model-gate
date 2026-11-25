#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { codeFingerprint, root } from '../tree-fingerprint.mjs'
import { startGateway, startMockUpstream } from '../test/offline/harness.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const outDir = resolve(root, 'docs/evidence/v13.1-r2/browser')
const reportPath = join(outDir, 'v04-error-matrix-report.json')
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))
const clone = (value) => structuredClone(value)
const report = {
  contract: 'mg-v13-v04-error-matrix/1',
  command: 'node scripts/e2e/ui-v13-error-matrix.mjs',
  cwd: root,
  startedAt: new Date().toISOString(),
  headSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  worktreeDirty: !!execFileSync('git', ['status', '--porcelain=v1'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceFingerprint: codeFingerprint(),
  scriptSha256: createHash('sha256').update(readFileSync(scriptPath)).digest('hex'),
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  boundary: 'real Chrome + real isolated HTTP gateway + loopback catalog fixture + CDP API fault injection; no production config, port 8787, real upstream, inference, install, or download',
  evidenceType: 'REAL_BROWSER_FIXTURE',
  resourcePreflight: {
    action: 'reuse-existing-only',
    downloads: 0,
    installs: 0,
    chrome: null,
  },
  isolation: null,
  checks: [],
  cases: [],
  failures: [],
  requests: [],
  httpErrors: [],
  networkErrors: [],
  jsErrors: [],
  cdpErrors: [],
  nativeDialogs: [],
  heldRequests: [],
  fixture: null,
  coverage: {},
  limitations: [
    '401/403 and selected 5xx/428 states are deliberate CDP fixtures because the current loopback control plane has no administrator-token gate; they are not real account-auth evidence.',
    'Offline is injected at the isolated browser network boundary; the real gateway process remains available for retry.',
    'No real vendor, Codex Desktop, paid model, production HOME/config, or inference request is used.',
  ],
}

let browser = null
let profile = null
let isolatedHome = null
let codexHome = null
let harnessRoot = null
let gateway = null
let upstream = null
let cdp = null
let ws = null
let currentSnapshot = null
let fetchRules = []
let held = null
let requestSerial = 0
const browserRequests = []
const completedPaths = []

function findChrome() {
  const override = process.env.MG_CHROME_BIN
  const candidates = override ? [override] : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']
  for (const candidate of candidates) {
    if (candidate.includes('/') && existsSync(candidate)) return candidate
    for (const dir of String(process.env.PATH || '').split(':')) {
      if (!dir) continue
      const path = join(dir, candidate)
      if (existsSync(path)) return path
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
  ws = new WebSocket(wsUrl)
  const pending = new Map()
  const handlers = new Map()
  let id = 0
  ws.addEventListener('message', (event) => {
    let msg
    try { msg = JSON.parse(event.data) } catch { return }
    if (msg.id && pending.has(msg.id)) {
      const item = pending.get(msg.id)
      pending.delete(msg.id)
      clearTimeout(item.timer)
      if (msg.error) item.reject(new Error(msg.error.message))
      else item.resolve(msg.result)
      return
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const detail = msg.params.exceptionDetails
      report.jsErrors.push({ source: 'Runtime.exceptionThrown', text: detail?.exception?.description || detail?.text || 'uncaught exception' })
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      report.jsErrors.push({ source: 'console.error', text: msg.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ') })
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      const entry = msg.params.entry
      if (entry.source === 'network') report.networkErrors.push({ text: entry.text, url: entry.url || '' })
      else report.jsErrors.push({ source: entry.source, text: entry.text, url: entry.url || '' })
    }
    if (msg.method === 'Page.javascriptDialogOpening') {
      report.nativeDialogs.push({ type: msg.params.type, message: msg.params.message || '' })
      ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: false } }))
    }
    if (msg.method === 'Network.requestWillBeSent') {
      const request = msg.params.request
      const item = { serial: ++requestSerial, method: request.method, url: request.url }
      browserRequests.push(item)
      report.requests.push(item)
    }
    if (msg.method === 'Network.responseReceived' && msg.params.response.status >= 400) {
      report.httpErrors.push({ status: msg.params.response.status, url: msg.params.response.url })
    }
    if (msg.method === 'Fetch.requestPaused') {
      void handlePaused(msg.params).catch((error) => report.cdpErrors.push({ method: msg.params.request.method, path: new URL(msg.params.request.url).pathname, message: error.message }))
    }
    const handler = handlers.get(msg.method)
    if (handler) handler(msg.params)
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
    close() { ws.close() },
  }
}

async function ev(expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  return result.result.value
}

async function snapshot() {
  return ev(`(() => {
    const visible = (node) => !!node && !!(node.offsetWidth || node.offsetHeight || node.getClientRects().length)
    const active = document.activeElement
    const dialogs = [...document.querySelectorAll('dialog[open]')].map((node) => ({
      title: node.querySelector('h2')?.textContent || '',
      busy: node.getAttribute('aria-busy') === 'true',
      error: node.querySelector('.dialog-error')?.hidden === false ? node.querySelector('.dialog-error').textContent : '',
      buttons: [...node.querySelectorAll('button')].filter(visible).map((button) => ({ text: button.textContent.trim(), disabled: button.disabled })),
    }))
    return {
      hash: location.hash,
      gatewayState: document.getElementById('gateway-state')?.dataset.state || '',
      gatewayText: document.getElementById('gateway-state')?.textContent.trim() || '',
      mainText: document.getElementById('main')?.innerText.slice(-3500) || '',
      dialogs,
      activeElement: active ? { tag: active.tagName, id: active.id, text: (active.textContent || '').trim().slice(0, 120), label: active.getAttribute?.('aria-label') || '', inDialog: !!active.closest?.('dialog[open]') } : null,
      successToasts: [...document.querySelectorAll('#toasts .toast.success')].map((node) => node.textContent),
      errorToasts: [...document.querySelectorAll('#toasts .toast.error')].map((node) => node.textContent),
      nativeDialogCount: ${report.nativeDialogs.length},
    }
  })()`)
}

async function waitFor(expression, label, timeoutMs = 12000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try { if (await ev(expression)) return } catch {}
    await sleep(80)
  }
  currentSnapshot = await snapshot()
  throw new Error('wait timeout: ' + label + '\n' + JSON.stringify(currentSnapshot, null, 2))
}

function check(id, ok, detail, expected, actual) {
  const item = { id, ok: !!ok, detail }
  if (expected !== undefined) item.expected = expected
  if (actual !== undefined) item.actual = actual
  if (!ok) {
    item.state = currentSnapshot || null
    report.failures.push({ id, detail, state: item.state })
  }
  report.checks.push(item)
  console.log((item.ok ? 'PASS ' : 'FAIL ') + id + ' :: ' + detail)
  return item.ok
}

async function caseRun(id, title, fn) {
  const item = { id, title, status: 'PASS', startedAt: new Date().toISOString(), checks: [] }
  report.cases.push(item)
  console.log('\nCASE ' + id + ' :: ' + title)
  try {
    await fn()
  } catch (error) {
    item.status = 'FAIL'
    item.error = error.stack || error.message
    currentSnapshot = await snapshot().catch(() => null)
    check(id + '-EXECUTION', false, error.message, 'scenario completes', item.error)
  } finally {
    clearRules()
    await closeDialogs()
    const phase = await ev(`document.getElementById('gateway-state')?.dataset.state || ''`).catch(() => '')
    if (phase && phase !== 'ready') {
      await focusClick(`document.getElementById('refresh')`).catch(() => {})
      await ready().catch((error) => { item.cleanupError = error.message })
    }
    item.checks = report.checks.filter((entry) => entry.id.startsWith(id + '-')).map((entry) => entry.id)
    item.finishedAt = new Date().toISOString()
  }
}

function clearRules() {
  fetchRules = []
}

function addRule(rule) {
  const item = { method: rule.method || 'GET', path: rule.path, times: rule.times ?? 1, ...rule }
  fetchRules.push(item)
  return item
}

function responseBody(rule) {
  return Buffer.from(typeof rule.body === 'string' ? rule.body : JSON.stringify(rule.body ?? {})).toString('base64')
}

async function handlePaused(event) {
  const rule = fetchRules.find((item) => item.times > 0 && item.method === event.request.method && new URL(event.request.url).pathname === item.path)
  if (!rule) {
    await continueRequest(event)
    return
  }
  rule.times -= 1
  if (rule.times <= 0) fetchRules = fetchRules.filter((item) => item !== rule)
  report.heldRequests.push({ serial: ++requestSerial, method: event.request.method, path: rule.path, action: rule.hold ? 'held' : rule.abort ? 'aborted' : 'fulfilled', status: rule.status || null })
  if (rule.hold) {
    held = { event, rule }
    return
  }
  if (rule.delayMs) await sleep(rule.delayMs)
  if (rule.abort) {
    await cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: rule.errorReason || 'InternetDisconnected' })
    return
  }
  if (rule.status !== undefined || rule.body !== undefined) {
    await cdp.send('Fetch.fulfillRequest', {
      requestId: event.requestId,
      responseCode: rule.status ?? 200,
      responseHeaders: [{ name: 'content-type', value: 'application/json' }, { name: 'cache-control', value: 'no-store' }],
      body: responseBody(rule),
    })
    return
  }
  await continueRequest(event)
}

async function continueRequest(event) {
  await cdp.send('Fetch.continueRequest', { requestId: event.requestId })
}

async function releaseHold() {
  if (!held) return
  const { event, rule } = held
  held = null
  if (rule.releaseStatus !== undefined) {
    await cdp.send('Fetch.fulfillRequest', {
      requestId: event.requestId,
      responseCode: rule.releaseStatus,
      responseHeaders: [{ name: 'content-type', value: 'application/json' }, { name: 'cache-control', value: 'no-store' }],
      body: responseBody(rule),
    })
    return
  }
  await continueRequest(event)
}

async function clearFeedback() {
  await ev(`document.getElementById('toasts').replaceChildren()`)
}

async function closeDialogs() {
  await ev(`document.querySelectorAll('dialog[open]').forEach((node) => node.close())`)
  await releaseHold()
  await sleep(60)
}

async function ready() {
  await waitFor(`document.getElementById('gateway-state')?.dataset.state === 'ready' && document.querySelector('h1')`, 'control plane ready')
}

async function navigate(hash) {
  await ev(`location.hash = ${JSON.stringify(hash)}`)
  await waitFor(`location.hash === ${JSON.stringify(hash)} && document.querySelector('h1')`, 'navigate ' + hash)
  await sleep(80)
}

async function focusClick(expression) {
  await ev(`(() => { const node = (${expression}); if (!node) throw new Error('click target missing'); node.focus(); node.click(); })()`)
}

async function clickButton(text, scope = 'document', exact = false) {
  const predicate = exact ? 'node.textContent.trim() === ' + JSON.stringify(text) : 'node.textContent.includes(' + JSON.stringify(text) + ')'
  const base = scope === 'document' ? 'document' : scope === '@top' ? '[...document.querySelectorAll("dialog[open]")].at(-1)' : 'document.querySelector(' + JSON.stringify(scope) + ')'
  await focusClick(`[...${base}.querySelectorAll('button')].find((node) => ${predicate} && !node.disabled)`)
}

async function pressEscape() {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
}

async function setInput(label, value, scope = 'document') {
  const base = scope === 'document' ? 'document' : 'document.querySelector(' + JSON.stringify(scope) + ')'
  await ev(`(() => { const node = [...${base}.querySelectorAll('[aria-label]')].find((item) => item.getAttribute('aria-label') === ${JSON.stringify(label)}); if (!node) throw new Error('input missing: ' + ${JSON.stringify(label)}); node.value = ${JSON.stringify(value)}; node.dispatchEvent(new Event('input', { bubbles: true })); })()`)
}

async function fillServiceEditor(name) {
  await setInput('服务显示名称', name, 'dialog[open]')
  await setInput('服务地址', upstream.base + '/v1', 'dialog[open]')
  await ev(`(() => { const node = document.querySelector('dialog[open] [aria-label="允许本地或私有网络地址"]'); node.checked = true; node.dispatchEvent(new Event('change', { bubbles: true })); })()`)
}

async function fillModelEditor(name) {
  await setInput('模型公共名', name, 'dialog[open]')
  await setInput('上游模型 ID', 'vendor-' + name, 'dialog[open]')
  await setInput('模型显示名', name, 'dialog[open]')
}

async function getJson(path) {
  const response = await gateway.get(path)
  const text = await response.text()
  if (!response.ok) throw new Error(path + ' HTTP ' + response.status + ': ' + text.slice(0, 300))
  return JSON.parse(text)
}

async function postJson(path, body) {
  const response = await gateway.post(path, body)
  const text = await response.text()
  let data = null
  try { data = JSON.parse(text) } catch { data = text }
  if (!response.ok) throw new Error(path + ' HTTP ' + response.status + ': ' + text.slice(0, 500))
  return data
}

async function externalCreateService(name) {
  const caps = await getJson('/api/capabilities')
  const requestId = 'v04-external-' + randomUUID()
  const patch = { displayName: name, endpoint: upstream.base + '/v1', api: 'openai', region: 'fixture', allowPrivateNetwork: true, enabled: true }
  const preview = await postJson('/api/config/preview', { action: 'service.create', expectedVersion: caps.runtime.configVersion, requestId, patch })
  return postJson('/api/services', { expectedVersion: preview.expectedVersion, requestId: preview.requestId, previewId: preview.previewId, confirmToken: preview.confirmToken })
}

async function lastPreview(action) {
  return ev(`window.__v04.previews.filter((item) => item.action === ${JSON.stringify(action)}).at(-1) || null`)
}

async function resetPage() {
  clearRules()
  await closeDialogs()
  await cdp.send('Page.reload', { ignoreCache: true })
  await ready()
}

function fixtureConfig(upstreamBase) {
  return {
    defaults: { retry: { maxAttempts: 1 }, timeout: { firstByteMs: 2000, idleMs: 2000 }, proxyMode: 'direct' },
    providers: {
      fixture: {
        serviceId: 'svc_0123456789abcdef',
        displayName: 'Fixture Service',
        baseUrl: upstreamBase + '/v1',
        api: 'openai',
        region: 'fixture',
        allowPrivateNetwork: true,
        enabled: true,
        connections: [{
          connectionId: 'conn_0123456789abcdef',
          displayName: 'Fixture Account',
          enabled: true,
          priority: 0,
          maxConcurrent: 0,
          quotaScopeId: '',
          authDomain: '',
          modelIds: [],
        }],
      },
    },
    models: {
      'fixture-model': { modelId: 'mdl_0123456789abcdef', provider: 'fixture', upstreamModelId: 'vendor-model', displayName: 'Fixture Model', capability: 'chat', api: 'openai', enabled: true },
    },
    virtualModels: [{
      poolId: 'pool_0123456789abcdef',
      slug: 'fixture-pool',
      name: 'Fixture Pool',
      enabled: true,
      selection: 'priority',
      revision: 1,
      members: [{ modelId: 'mdl_0123456789abcdef', model: 'fixture-model', providerId: 'fixture', priority: 0, weight: 0, enabled: true }],
      directory: [{ model: 'fixture-model', providers: ['fixture'], mode: 'onFail', enabled: true }],
    }],
    harnessBindings: {
      bind_fixture: { bindingId: 'bind_fixture', harnessId: 'codex', instanceId: 'default', mode: 'route', roleTargets: { parent: { kind: 'pool', id: 'pool_0123456789abcdef' } }, desiredRevision: 1, appliedRevision: 0, verifiedRevision: 0 },
    },
  }
}

async function main() {
  const bin = findChrome()
  if (!bin) throw new Error('NOT_RUN_BROWSER: no existing Chrome; installation is not authorized')
  let chromeVersion = ''
  try { chromeVersion = execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim() } catch {}
  report.resourcePreflight.chrome = { binary: bin, version: chromeVersion, state: 'existing-reused' }

  const chromePort = await freePort()
  profile = mkdtempSync(join(tmpdir(), 'mg-v04-chrome-'))
  isolatedHome = mkdtempSync(join(tmpdir(), 'mg-v04-home-'))
  codexHome = mkdtempSync(join(tmpdir(), 'mg-v04-codex-'))
  harnessRoot = mkdtempSync(join(tmpdir(), 'mg-v04-harness-'))
  browser = spawn(bin, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-background-networking',
    '--disable-component-update', '--disable-extensions', '--no-first-run', '--no-default-browser-check',
    '--no-pings', '--metrics-recording-only', '--remote-debugging-port=' + chromePort,
    '--remote-allow-origins=*', '--user-data-dir=' + profile, '--window-size=1440,900', 'about:blank',
  ], { detached: true, stdio: 'ignore', env: { ...process.env, HOME: profile, XDG_CONFIG_HOME: join(profile, '.config'), XDG_CACHE_HOME: join(profile, '.cache') } })
  const cdpBase = 'http://127.0.0.1:' + chromePort
  let version = null
  const deadline = Date.now() + 15000
  while (Date.now() < deadline && !version) {
    try { const response = await fetch(cdpBase + '/json/version'); if (response.ok) version = await response.json() } catch {}
    if (!version) await sleep(100)
  }
  if (!version) throw new Error('NOT_RUN_BROWSER: existing Chrome CDP did not start')
  report.chrome = { browser: version.Browser, protocol: version['Protocol-Version'], debuggingPort: chromePort }

  upstream = await startMockUpstream()
  gateway = await startGateway({
    name: 'v04-error-matrix',
    env: { HOME: isolatedHome, CODEX_HOME: codexHome, MG_HARNESS_ROOT: harnessRoot, MG_BUILD_SHA: report.headSha },
    config: fixtureConfig(upstream.base),
  })
  report.isolation = {
    gateway: { host: '127.0.0.1', port: gateway.port, base: gateway.base },
    upstream: { host: '127.0.0.1', port: upstream.port, base: upstream.base },
    chromePort,
    configDir: gateway.dir,
    home: isolatedHome,
    codexHome,
    harnessRoot,
    productionPortUsed: gateway.port === 8787 || upstream.port === 8787 || chromePort === 8787,
  }
  check('V04-ISOLATION', gateway.port !== 8787 && upstream.port !== 8787 && chromePort !== 8787 && gateway.base.startsWith('http://127.0.0.1:') && upstream.base.startsWith('http://127.0.0.1:'), 'dynamic loopback ports; production 8787 not used', 'all ports dynamic and non-8787', { gateway: gateway.port, upstream: upstream.port, chrome: chromePort })

  const target = await (await fetch(cdpBase + '/json/new?' + encodeURIComponent(gateway.base + '/ui-vnext/'), { method: 'PUT' })).json()
  cdp = await connect(target.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await cdp.send('Log.enable')
  await cdp.send('Network.enable')
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*' }] })
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__v04 = { previews: [], completed: [] };
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      try {
        const url = new URL(args[0] instanceof Request ? args[0].url : args[0], location.href);
        const method = (args[1]?.method || (args[0] instanceof Request ? args[0].method : 'GET')).toUpperCase();
        window.__v04.completed.push(url.pathname);
        if (url.pathname === '/api/config/preview' && method === 'POST') {
          const data = await response.clone().json();
          window.__v04.previews.push({ action: data.action, expectedVersion: data.expectedVersion, requestId: data.requestId, previewId: data.previewId, confirmToken: data.confirmToken });
        }
      } catch {}
      return response;
    };
  ` })

  await caseRun('V04-LOADING', 'initial and refresh loading states', async () => {
    addRule({ path: '/api/capabilities', hold: true })
    await cdp.send('Page.navigate', { url: gateway.base + '/ui-vnext/#/services' })
    await waitFor(`document.querySelector('#main .loading[role="status"]') && document.getElementById('gateway-state').dataset.state === 'loading'`, 'initial loading')
    currentSnapshot = await snapshot()
    check('V04-LOADING-INITIAL', !currentSnapshot.mainText.includes('Fixture Service') && currentSnapshot.gatewayText.includes('正在连接'), 'initial load is explicit and does not show stale success', 'loading without service data', currentSnapshot)
    await releaseHold()
    await ready()
    check('V04-LOADING-REFRESH', true, 'held capabilities response resolves to ready')

    addRule({ path: '/api/capabilities', hold: true })
    await focusClick(`document.getElementById('refresh')`)
    await waitFor(`document.getElementById('gateway-state').dataset.state === 'loading'`, 'refresh loading')
    currentSnapshot = await snapshot()
    check('V04-LOADING-SLOW-REFRESH', currentSnapshot.gatewayText.includes('正在连接') && !currentSnapshot.successToasts.length, 'slow refresh reports loading rather than fake completion', '正在连接', currentSnapshot.gatewayText)
    await releaseHold()
    await ready()
  })

  await caseRun('V04-CORE-ERRORS', '401/403/404/500/offline with actionable retry', async () => {
    const messages = {
      401: 'V04_AUTH_401：控制面暂不可用，请确认本机访问后重试',
      403: 'V04_ORIGIN_403：只读，来源校验拒绝；请从本机回环访问后重试',
      404: 'V04_LEGACY_404：当前实例不支持该控制面接口',
      500: 'V04_CORE_500：本地控制面暂时失败，可重试',
    }
    for (const status of [401, 403, 404, 500]) {
      await clearFeedback()
      addRule({ path: '/api/capabilities', status, body: { ok: false, code: 'v04_injected_' + status, error: messages[status], retryable: status >= 500 } })
      await focusClick(`document.getElementById('refresh')`)
      await waitFor(`document.querySelector('.error-state') && document.getElementById('gateway-state').dataset.state === 'error'`, 'core HTTP ' + status)
      currentSnapshot = await snapshot()
      check('V04-CORE-ERRORS-' + status, currentSnapshot.mainText.includes(messages[status]) && currentSnapshot.mainText.includes('重试') && !currentSnapshot.mainText.includes('Fixture Service') && !currentSnapshot.successToasts.length, 'HTTP ' + status + ' clears stale data and exposes retry', messages[status], currentSnapshot.mainText)
      await clickButton('重试', '.error-state', true)
      await ready()
      check('V04-CORE-ERRORS-' + status + '-RECOVER', (await snapshot()).mainText.includes('Fixture Service'), 'HTTP ' + status + ' recovers through the rendered retry action')
    }
    await clearFeedback()
    addRule({ path: '/api/capabilities', abort: true, errorReason: 'InternetDisconnected' })
    await focusClick(`document.getElementById('refresh')`)
    await waitFor(`document.getElementById('gateway-state').dataset.state === 'offline' && document.querySelector('.error-state')`, 'offline')
    currentSnapshot = await snapshot()
    check('V04-CORE-ERRORS-OFFLINE', currentSnapshot.gatewayText.includes('网关离线') && currentSnapshot.mainText.includes('无法连接本地网关') && currentSnapshot.mainText.includes('重试') && !currentSnapshot.successToasts.length, 'offline is distinct from HTTP error and offers retry', '网关离线 + retry', currentSnapshot)
    await clickButton('重试', '.error-state', true)
    await ready()
  })

  await caseRun('V04-PARTIAL', 'partial success keeps good data and exposes the failed partition', async () => {
    await navigate('#/pools')
    await clearFeedback()
    addRule({ path: '/api/pools', status: 500, body: { ok: false, code: 'v04_pools_500', error: 'V04_POOLS_500：模型池分区暂时不可用' } })
    await focusClick(`document.getElementById('refresh')`)
    await waitFor(`document.getElementById('gateway-state').dataset.state === 'partial' && document.querySelector('.notice.error')`, 'partial state')
    currentSnapshot = await snapshot()
    check('V04-PARTIAL-STATE', currentSnapshot.gatewayText.includes('部分数据不可用') && currentSnapshot.mainText.includes('模型池读取失败') && currentSnapshot.mainText.includes('V04_POOLS_500') && !currentSnapshot.successToasts.length, 'one failed partition is not reported as all-ready', 'partial + local error', currentSnapshot)
    await navigate('#/services')
    await ev(`[...document.querySelectorAll('[role="tab"]')].find((node) => node.textContent.includes('服务模型')).click()`)
    await waitFor(`document.querySelector('tbody')?.textContent.includes('Fixture Model')`, 'successful model partition remains')
    check('V04-PARTIAL-GOOD-DATA', true, 'successful model data remains usable while pools fail')
    await focusClick(`document.getElementById('refresh')`)
    await ready()
    await navigate('#/pools')
    await waitFor(`document.body.textContent.includes('Fixture Pool')`, 'partial retry recovery')
    check('V04-PARTIAL-RETRY', true, 'refresh retry restores the failed partition and ready status')
  })

  await caseRun('V04-EMPTY', 'empty resources, no results, and stale detail', async () => {
    await navigate('#/services')
    await ev(`[...document.querySelectorAll('[role="tab"]')].find((node) => node.textContent.includes('我的服务')).click()`)
    await setInput('搜索模型服务', 'no-such-v04-service')
    await waitFor(`document.querySelector('.empty')?.textContent.includes('没有匹配的服务')`, 'service no results')
    check('V04-EMPTY-NO-RESULTS', (await snapshot()).mainText.includes('尝试清除搜索条件'), 'no-results is distinct from error and offers clear-search recovery')
    await clickButton('清除搜索', '.empty', true)
    await waitFor(`document.querySelector('tbody')?.textContent.includes('Fixture Service')`, 'clear service search')
    await navigate('#/service-detail?service=missing-v04')
    currentSnapshot = await snapshot()
    check('V04-EMPTY-STALE-DETAIL', currentSnapshot.mainText.includes('服务不存在或已被删除') && currentSnapshot.mainText.includes('返回模型服务'), 'stale deep link reports invalidation with a return action', 'invalid detail + return', currentSnapshot.mainText)

    const [caps, models, pools, bindings, stats, usage, backups] = await Promise.all([
      getJson('/api/capabilities'), getJson('/api/models'), getJson('/api/pools'), getJson('/api/harness-bindings'),
      getJson('/api/model-stats?days=7'), getJson('/api/usage/summary?days=7'), getJson('/api/config/backups'),
    ])
    const emptyCaps = clone(caps)
    emptyCaps.services = emptyCaps.services.map((service) => ({ ...service, connections: [], connectionCount: 0, modelCount: 0 }))
    emptyCaps.pools = []
    emptyCaps.models = []
    const emptyStats = { ...stats, models: {} }
    const emptyUsage = { ...usage, models: [], gateway: { ...usage.gateway, logicalRequests: 0, completedRequests: 0, upstreamAttempts: 0, failedAttempts: 0, retries: 0, interrupts: 0, tokens: 0, inTokens: 0, outTokens: 0, hit: 0, miss: 0 } }
    const emptyRules = [
      { path: '/api/capabilities', body: emptyCaps },
      { path: '/api/models', body: { ...models, items: [] } },
      { path: '/api/pools', body: { ...pools, items: [] } },
      { path: '/api/harness-bindings', body: { ...bindings, items: [] } },
      { path: '/api/model-stats', body: emptyStats },
      { path: '/api/usage/summary', body: emptyUsage },
      { path: '/api/config/backups', body: { ...backups, items: [] } },
    ]
    for (const rule of emptyRules) addRule({ ...rule, times: 999 })
    await cdp.send('Page.reload', { ignoreCache: true })
    await ready()
    await navigate('#/services')
    await waitFor(`document.querySelector('tbody')?.textContent.includes('Fixture Service')`, 'empty-fixture service row')
    await clickButton('连接 0', 'tbody tr', false)
    await waitFor(`document.querySelector('dialog[open]')?.textContent.includes('尚无连接')`, 'empty connections')
    check('V04-EMPTY-CONNECTIONS', true, 'empty connection manager has an explicit empty state')
    await closeDialogs()
    await navigate('#/models')
    await waitFor(`document.querySelector('.empty')?.textContent.includes('尚未添加模型')`, 'empty models')
    check('V04-EMPTY-MODELS', true, 'empty model catalog is not reported as success')
    await navigate('#/pools')
    await waitFor(`document.querySelector('.empty')?.textContent.includes('没有模型池')`, 'empty pools')
    check('V04-EMPTY-POOLS', true, 'empty pool list is explicit')
    await navigate('#/clients')
    await waitFor(`document.querySelector('.empty')?.textContent.includes('尚无客户端入口')`, 'empty clients')
    check('V04-EMPTY-CLIENTS', true, 'empty client entry list is explicit')
    await navigate('#/usage')
    await waitFor(`document.body.textContent.includes('暂无模型用量') && document.body.textContent.includes('暂无时间桶')`, 'empty usage')
    check('V04-EMPTY-USAGE', true, 'zero usage is not presented as successful inference')
    await navigate('#/settings')
    await waitFor(`document.body.textContent.includes('尚无备份')`, 'empty backups')
    check('V04-EMPTY-BACKUPS', true, 'empty backup list is explicit')
    await navigate('#/logs')
    await waitFor(`document.querySelector('.empty')?.textContent.includes('尚未查询')`, 'empty logs')
    check('V04-EMPTY-LOGS', true, 'unqueried logs are distinct from empty results')

    clearRules()
    const noServices = clone(caps)
    noServices.services = []
    noServices.pools = []
    noServices.models = []
    addRule({ path: '/api/capabilities', body: noServices })
    await navigate('#/services')
    await focusClick(`document.getElementById('refresh')`)
    await ready()
    await waitFor(`document.querySelector('.empty')?.textContent.includes('尚未配置服务')`, 'empty services')
    check('V04-EMPTY-SERVICES', true, 'fresh empty install has an explicit service empty state')
    await resetPage()
  })

  await caseRun('V04-CANCEL', 'dialog cancellation, busy guard, and async discovery cancellation', async () => {
    await navigate('#/services')
    await focusClick(`[...document.querySelectorAll('.page-header button')].find((node) => node.textContent.includes('添加服务'))`)
    await waitFor(`document.querySelector('dialog[open]')`, 'service editor')
    await pressEscape()
    await waitFor(`!document.querySelector('dialog[open]')`, 'escape closes editor')
    currentSnapshot = await snapshot()
    check('V04-CANCEL-ESCAPE-FOCUS', currentSnapshot.activeElement?.text === '添加服务' && report.nativeDialogs.length === 0, 'Escape closes the HTML dialog, restores opener focus, and opens no native dialog', '添加服务 focused', currentSnapshot.activeElement)

    await focusClick(`[...document.querySelectorAll('.page-header button')].find((node) => node.textContent.includes('添加服务'))`)
    await fillServiceEditor('V04 Busy Cancel')
    addRule({ method: 'POST', path: '/api/config/preview', hold: true })
    await clickButton('预览变更', 'dialog[open]', true)
    await waitFor(`document.querySelector('dialog[open]')?.getAttribute('aria-busy') === 'true'`, 'busy preview')
    await ev(`(() => { window.__v04CancelEvents = []; window.__v04CloseCalls = []; const node = document.querySelector('dialog[open]'); const originalClose = node.close.bind(node); node.close = (...args) => { window.__v04CloseCalls.push({ busy: node.getAttribute('aria-busy'), stack: new Error().stack }); return originalClose(...args); }; node.addEventListener('cancel', (event) => { window.__v04CancelEvents.push({ busy: node.getAttribute('aria-busy'), cancelable: event.cancelable, prevented: event.defaultPrevented, open: node.open }); queueMicrotask(() => window.__v04CancelEvents.push({ afterListeners: true, cancelable: event.cancelable, prevented: event.defaultPrevented, open: node.open })); setTimeout(() => window.__v04CancelEvents.push({ after: true, busy: node.getAttribute('aria-busy'), open: node.open }), 0); }); })()`)
    const beforeBusy = await snapshot()
    await pressEscape()
    await sleep(120)
    currentSnapshot = await snapshot()
    const cancelEvents = await ev(`window.__v04CancelEvents || []`)
    const closeCalls = await ev(`window.__v04CloseCalls || []`)
    check('V04-CANCEL-BUSY-GUARD', currentSnapshot.dialogs.length === 1 && currentSnapshot.dialogs[0].busy && currentSnapshot.dialogs[0].buttons.every((button) => button.disabled), 'Escape cannot abandon an in-flight transaction or leave a native dialog stuck', 'one busy HTML dialog', { before: beforeBusy.dialogs, after: currentSnapshot.dialogs, cancelEvents, closeCalls })
    await releaseHold()
    if (currentSnapshot.dialogs.length) {
      await waitFor(`document.querySelector('dialog[open]')?.textContent.includes('确认创建')`, 'preview completes')
      await clickButton('取消', 'dialog[open]', true)
      await waitFor(`!document.querySelector('dialog[open]')`, 'cancel after preview')
    } else {
      await waitFor(`window.__v04.completed.includes('/api/config/preview')`, 'preview settles after unexpected close')
      await sleep(120)
    }
    currentSnapshot = await snapshot()
    check('V04-CANCEL-NO-WRITE', currentSnapshot.dialogs.length === 0 && !(await getJson('/api/services')).services.some((service) => service.displayName === 'V04 Busy Cancel'), 'cancelling after preview performs no write')

    await navigate('#/service-models?service=fixture')
    await waitFor(`document.body.textContent.includes('从连接发现')`, 'models panel')
    const beforeDiscovery = upstream.hits.length
    addRule({ path: '/api/connections/fixture/conn_0123456789abcdef/discover', hold: true })
    await focusClick(`[...document.querySelectorAll('button')].find((node) => node.textContent === '从连接发现')`)
    await waitFor(`document.querySelector('dialog[open]')?.textContent.includes('正在读取目录')`, 'discovery pending')
    await clickButton('取消', 'dialog[open]', true)
    await waitFor(`!document.querySelector('dialog[open]')`, 'discovery dialog cancelled')
    currentSnapshot = await snapshot()
    check('V04-CANCEL-DISCOVERY-FOCUS', currentSnapshot.activeElement?.text === '从连接发现' && !currentSnapshot.successToasts.length, 'cancelled discovery closes and restores focus without success feedback', '从连接发现 focused', currentSnapshot.activeElement)
    await releaseHold()
    await waitFor(`window.__v04.completed.includes('/api/connections/fixture/conn_0123456789abcdef/discover')`, 'cancelled discovery request settles')
    await sleep(150)
    currentSnapshot = await snapshot()
    check('V04-CANCEL-DISCOVERY-LATE', currentSnapshot.dialogs.length === 0 && !currentSnapshot.successToasts.length, 'late discovery completion does not reopen a cancelled dialog or claim success', 'no dialog / no success', currentSnapshot)
    check('V04-CANCEL-DISCOVERY-READONLY', upstream.hits.length === beforeDiscovery + 1 && upstream.hits.at(-1).method === 'GET', 'cancelled UI discovery only performs one read-only catalog GET')
  })

  await caseRun('V04-DIALOG-RETRY', '500 preview retry, real service success, and delete round trip', async () => {
    await navigate('#/services')
    await clearFeedback()
    await focusClick(`[...document.querySelectorAll('.page-header button')].find((node) => node.textContent.includes('添加服务'))`)
    await fillServiceEditor('V04 Retry Service')
    addRule({ method: 'POST', path: '/api/config/preview', status: 500, body: { ok: false, code: 'v04_service_500', error: 'V04_SERVICE_500：服务预览暂时失败，可重试' } })
    await clickButton('预览变更', 'dialog[open]', true)
    await waitFor(`document.querySelector('dialog[open] .dialog-error')?.hidden === false`, 'service 500')
    currentSnapshot = await snapshot()
    check('V04-DIALOG-RETRY-500', currentSnapshot.dialogs[0].error.includes('V04_SERVICE_500') && !currentSnapshot.dialogs[0].busy && !currentSnapshot.successToasts.length, '500 stays in the dialog, clears busy state, and does not claim success', 'visible retryable error', currentSnapshot.dialogs[0])
    await clickButton('预览变更', 'dialog[open]', true)
    await waitFor(`document.querySelector('dialog[open]')?.textContent.includes('确认创建')`, 'retry preview')
    await clickButton('确认创建', 'dialog[open]', true)
    await waitFor(`document.querySelector('dialog[open]')?.textContent.includes('的凭据')`, 'credential step')
    await closeDialogs()
    await waitFor(`document.querySelector('tbody')?.textContent.includes('V04 Retry Service')`, 'created service visible')
    check('V04-DIALOG-RETRY-SUCCESS', (await getJson('/api/services')).services.some((service) => service.displayName === 'V04 Retry Service'), 'retry success is backed by a real isolated backend write')

    await focusClick(`(() => { const row = [...document.querySelectorAll('tbody tr')].find((node) => node.textContent.includes('V04 Retry Service')); return [...row.querySelectorAll('button')].find((node) => node.textContent === '删除'); })()`)
    await clickButton('预览删除影响', 'dialog[open]', true)
    await waitFor(`document.querySelector('dialog[open]')?.textContent.includes('确认删除')`, 'delete impact')
    await clickButton('确认删除', 'dialog[open]', true)
    await waitFor(`!document.querySelector('dialog[open]') && !document.querySelector('tbody')?.textContent.includes('V04 Retry Service')`, 'service deleted')
    check('V04-DIALOG-RETRY-DELETE', !(await getJson('/api/services')).services.some((service) => service.displayName === 'V04 Retry Service'), 'successful delete is backed by backend absence')
  })

  await caseRun('V04-DIALOG-AUTH', '401/403 write failures remain local and actionable', async () => {
    await navigate('#/models')
    await clearFeedback()
    await focusClick(`[...document.querySelectorAll('button')].find((node) => node.textContent === '添加模型')`)
    await fillModelEditor('v04-auth-model')
    addRule({ method: 'POST', path: '/api/config/preview', status: 401, body: { ok: false, code: 'v04_auth_401', error: 'V04_AUTH_401：认证失败，请更新凭据后重试' } })
    await clickButton('预览变更', 'dialog[open]', true)
    await waitFor(`document.querySelector('dialog[open] .dialog-error')?.hidden === false`, 'model 401')
    currentSnapshot = await snapshot()
    check('V04-DIALOG-AUTH-401', currentSnapshot.dialogs[0].error.includes('更新凭据') && currentSnapshot.dialogs[0].error.includes('重试') && !currentSnapshot.successToasts.length, '401 gives credential/retry guidance without fake success', 'update credential + retry', currentSnapshot.dialogs[0].error)
    await closeDialogs()

    await navigate('#/pools')
    await ev(`[...document.querySelectorAll('[role="tab"]')].find((node) => node.textContent.includes('应用引用')).click()`)
    await clearFeedback()
    await focusClick(`[...document.querySelectorAll('button')].find((node) => node.textContent === '添加应用引用')`)
    addRule({ method: 'POST', path: '/api/config/preview', status: 403, body: { ok: false, code: 'v04_origin_403', error: 'V04_ORIGIN_403：只读，来源校验拒绝；请从本机回环访问后重试' } })
    await clickButton('预览引用', 'dialog[open]', true)
    await waitFor(`document.querySelector('dialog[open] .dialog-error')?.hidden === false`, 'binding 403')
    currentSnapshot = await snapshot()
    check('V04-DIALOG-AUTH-403', currentSnapshot.dialogs[0].error.includes('只读') && currentSnapshot.dialogs[0].error.includes('回环') && !currentSnapshot.successToasts.length, '403 is reported as read-only/source rejection, not a generic empty result', 'read-only + loopback guidance', currentSnapshot.dialogs[0].error)
    check('V04-DIALOG-AUTH-403-NO-WRITE', (await getJson('/api/harness-bindings')).items.length === 1, '403 writes no binding')
    await closeDialogs()

    await navigate('#/harness')
    await waitFor(`[...document.querySelectorAll('button')].some((node) => node.textContent === '配置预览')`, 'harness adapters')
    await clearFeedback()
    await focusClick(`[...document.querySelectorAll('button')].find((node) => node.textContent === '配置预览')`)
    addRule({ method: 'POST', path: '/api/harnesses/preview', status: 403, body: { ok: false, code: 'v04_harness_403', error: 'V04_HARNESS_403：隔离写入未授权，请检查 MG_HARNESS_ROOT 后重试' } })
    await clickButton('预览配置', 'dialog[open]', true)
    await waitFor(`document.querySelector('dialog[open] .dialog-error')?.hidden === false`, 'harness 403')
    currentSnapshot = await snapshot()
    check('V04-DIALOG-AUTH-HARNESS-403', currentSnapshot.dialogs[0].error.includes('未授权') && !currentSnapshot.successToasts.length, 'Harness 403 remains an actionable dialog error')
    await closeDialogs()
  })

  await caseRun('V04-CONFLICT', '409 external writer and 428 stale preview preserve data', async () => {
    await navigate('#/services')
    await clearFeedback()
    await focusClick(`[...document.querySelectorAll('.page-header button')].find((node) => node.textContent.includes('添加服务'))`)
    await fillServiceEditor('V04 Conflict Service')
    await clickButton('预览变更', 'dialog[open]', true)
    await waitFor(`document.querySelector('dialog[open]')?.textContent.includes('确认创建')`, 'conflict preview')
    await externalCreateService('V04 External Writer')
    await clickButton('确认创建', 'dialog[open]', true)
    await waitFor(`document.querySelector('dialog[open] .dialog-error')?.hidden === false`, '409 conflict')
    await waitFor(`document.querySelector('dialog[open]')?.getAttribute('aria-busy') === 'false'`, '409 dialog idle')
    await sleep(150)
    currentSnapshot = await snapshot()
    check('V04-CONFLICT-409', currentSnapshot.dialogs[0].error.includes('配置已被其他程序修改，未覆盖') && currentSnapshot.dialogs[0].error.includes('刷新后重试') && !currentSnapshot.successToasts.length, '409 explains external modification and does not overwrite or claim success', 'not overwritten + refresh/retry', currentSnapshot.dialogs[0].error)
    const servicesAfterConflict = (await getJson('/api/services')).services
    check('V04-CONFLICT-409-DATA', !servicesAfterConflict.some((service) => service.displayName === 'V04 Conflict Service') && servicesAfterConflict.some((service) => service.displayName === 'V04 External Writer'), 'stale UI write is absent; external writer remains')
    check('V04-CONFLICT-409-FOCUS', currentSnapshot.activeElement?.inDialog === true, 'failed async confirmation keeps focus inside the open dialog', 'focus in dialog', currentSnapshot.activeElement)
    await closeDialogs()
    await focusClick(`document.getElementById('refresh')`)
    await ready()
    await waitFor(`document.querySelector('tbody')?.textContent.includes('V04 External Writer')`, 'refresh after conflict')
    await focusClick(`(() => { const row = [...document.querySelectorAll('tbody tr')].find((node) => node.textContent.includes('V04 External Writer')); return [...row.querySelectorAll('button')].find((node) => node.textContent === '删除'); })()`)
    await clickButton('预览删除影响', 'dialog[open]', true)
    await waitFor(`document.querySelector('dialog[open]')?.textContent.includes('确认删除')`, 'external service delete preview')
    await clickButton('确认删除', 'dialog[open]', true)
    await waitFor(`!document.querySelector('dialog[open]')`, 'external service removed')

    await clearFeedback()
    await focusClick(`[...document.querySelectorAll('.page-header button')].find((node) => node.textContent.includes('添加服务'))`)
    await fillServiceEditor('V04 Stale Preview')
    await clickButton('预览变更', 'dialog[open]', true)
    await waitFor(`document.querySelector('dialog[open]')?.textContent.includes('确认创建')`, '428 preview')
    check('V04-CONFLICT-428-PREVIEW', !!await lastPreview('service.create'), 'real preview exists before injected expiry')
    addRule({ path: '/api/services', method: 'POST', status: 428, body: { ok: false, code: 'preview_expired', error: 'V04_PREVIEW_428：预览不存在、已使用或已过期，请重新预览' } })
    await clickButton('确认创建', 'dialog[open]', true)
    await waitFor(`document.querySelector('dialog[open] .dialog-error')?.hidden === false`, '428 stale preview')
    currentSnapshot = await snapshot()
    check('V04-CONFLICT-428', currentSnapshot.dialogs[0].error.includes('预览已过期或已使用') && currentSnapshot.dialogs[0].error.includes('重新操作') && !currentSnapshot.successToasts.length, '428 requires a fresh preview and never reports creation', 'fresh preview required', currentSnapshot.dialogs[0].error)
    check('V04-CONFLICT-428-NO-WRITE', !(await getJson('/api/services')).services.some((service) => service.displayName === 'V04 Stale Preview'), '428 creates no service')
    await closeDialogs()
  })

  await caseRun('V04-422', 'referenced resource deletion is blocked across service/model/connection/pool dialogs', async () => {
    const verifyBlocked = async (id, expected) => {
      await waitFor(`[...document.querySelectorAll('dialog[open] .dialog-error')].some((node) => node.hidden === false)`, id)
      currentSnapshot = await snapshot()
      check(id, currentSnapshot.dialogs.at(-1).error.includes(expected) && !currentSnapshot.successToasts.length, '422 remains visible with reference-specific recovery guidance', expected, currentSnapshot.dialogs.at(-1).error)
      await closeDialogs()
    }
    await navigate('#/services')
    await clearFeedback()
    await focusClick(`(() => { const row = [...document.querySelectorAll('tbody tr')].find((node) => node.textContent.includes('Fixture Service')); return [...row.querySelectorAll('button')].find((node) => node.textContent === '删除'); })()`)
    await clickButton('预览删除影响', 'dialog[open]', true)
    await verifyBlocked('V04-422-SERVICE', '服务仍被引用')
    check('V04-422-SERVICE-DATA', (await getJson('/api/services')).services.some((service) => service.providerId === 'fixture'), 'referenced service remains')

    await navigate('#/models')
    await clearFeedback()
    await focusClick(`(() => { const row = [...document.querySelectorAll('tbody tr')].find((node) => node.textContent.includes('Fixture Model')); return [...row.querySelectorAll('button')].find((node) => node.textContent === '删除'); })()`)
    await clickButton('预览删除影响', 'dialog[open]', true)
    await verifyBlocked('V04-422-MODEL', '模型仍被')
    check('V04-422-MODEL-DATA', (await getJson('/api/models')).items.some((model) => model.name === 'fixture-model'), 'referenced model remains')

    await navigate('#/service-detail?service=fixture')
    await clearFeedback()
    await focusClick(`[...document.querySelectorAll('button')].find((node) => node.textContent === '管理连接')`)
    await waitFor(`document.querySelector('dialog[open]')?.textContent.includes('连接管理')`, 'connection manager')
    await focusClick(`[...document.querySelectorAll('dialog[open] button')].find((node) => node.textContent === '删除')`)
    await clickButton('预览删除', '@top', true)
    await verifyBlocked('V04-422-CONNECTION', '最后一个启用连接')
    check('V04-422-CONNECTION-DATA', (await getJson('/api/capabilities')).services.find((service) => service.providerId === 'fixture').connections.length === 1, 'last enabled connection remains')

    await navigate('#/pools')
    await clearFeedback()
    await focusClick(`[...document.querySelectorAll('.page-header button, .panel .row button')].find((node) => node.textContent === '删除')`)
    await clickButton('预览删除影响', 'dialog[open]', true)
    await verifyBlocked('V04-422-POOL', '池成员不足或池仍被应用引用')
    check('V04-422-POOL-DATA', (await getJson('/api/pools')).items.some((pool) => pool.poolId === 'pool_0123456789abcdef'), 'referenced pool remains')
  })

  await caseRun('V04-ASYNC', 'slow route preview cancellation and focus preservation', async () => {
    await navigate('#/pools')
    await clearFeedback()
    await setInput('预演模型名称', 'fixture-pool')
    addRule({ path: '/api/route-preview', method: 'POST', hold: true, releaseStatus: 200, body: { ok: true, hit: { type: 'virtual', name: 'Fixture Pool', directory: [{ model: 'fixture-model', mode: 'onFail', providers: ['fixture'] }] } } })
    await focusClick(`[...document.querySelectorAll('button')].find((node) => node.textContent === '运行预演')`)
    await waitFor(`[...document.querySelectorAll('button')].some((node) => node.textContent === '正在预演…' && node.disabled)`, 'slow route preview')
    currentSnapshot = await snapshot()
    const previewPanel = currentSnapshot.mainText
    check('V04-ASYNC-CANCEL-CONTROL', previewPanel.includes('取消预演') || previewPanel.includes('取消'), 'slow route preview exposes a cancellation action', 'cancel action while pending', previewPanel.slice(-1200))
    await navigate('#/services')
    await focusClick(`document.querySelector('input[aria-label="搜索模型服务"]')`)
    await releaseHold()
    await waitFor(`window.__v04.completed.includes('/api/route-preview')`, 'route preview completion')
    await sleep(180)
    currentSnapshot = await snapshot()
    check('V04-ASYNC-FOCUS-PRESERVED', currentSnapshot.activeElement?.label === '搜索模型服务', 'late async completion does not steal focus from the current search field', '搜索模型服务 focused', currentSnapshot.activeElement)
    check('V04-ASYNC-NO-NATIVE-DIALOG', report.nativeDialogs.length === 0, 'slow async completion opens no native dialog')
  })

  await caseRun('V04-ASYNC-RETRY', 'route preview, discovery, logs, policy, and backup retries', async () => {
    await navigate('#/pools')
    await clearFeedback()
    await setInput('预演模型名称', 'fixture-pool')
    addRule({ path: '/api/route-preview', method: 'POST', status: 500, body: { ok: false, code: 'v04_route_500', error: 'V04_ROUTE_500：预演暂时失败，可重试' } })
    await focusClick(`[...document.querySelectorAll('button')].find((node) => node.textContent === '运行预演')`)
    await waitFor(`document.querySelector('.notice.error')?.textContent.includes('预演失败')`, 'route preview 500')
    currentSnapshot = await snapshot()
    check('V04-ASYNC-RETRY-ROUTE-500', currentSnapshot.mainText.includes('V04_ROUTE_500') && !currentSnapshot.successToasts.length, 'route preview 500 is explicit and not fake success')
    await focusClick(`[...document.querySelectorAll('button')].find((node) => node.textContent === '运行预演')`)
    await waitFor(`document.body.textContent.includes('预演完成') && document.body.textContent.includes('上游调用')`, 'route preview retry')
    check('V04-ASYNC-RETRY-ROUTE-SUCCESS', (await snapshot()).mainText.includes('0'), 'successful retry states zero upstream calls')

    await navigate('#/service-models?service=fixture')
    await clearFeedback()
    addRule({ path: '/api/connections/fixture/conn_0123456789abcdef/discover', method: 'POST', status: 500, body: { ok: false, code: 'v04_discovery_500', error: 'V04_DISCOVERY_500：目录发现暂时失败，可重试' } })
    await focusClick(`[...document.querySelectorAll('button')].find((node) => node.textContent === '从连接发现')`)
    await waitFor(`document.querySelector('dialog[open]')?.textContent.includes('发现失败')`, 'discovery 500')
    currentSnapshot = await snapshot()
    check('V04-ASYNC-RETRY-DISCOVERY-500', currentSnapshot.dialogs[0].error.includes('V04_DISCOVERY_500') && !currentSnapshot.successToasts.length, 'discovery failure stays in its dialog')
    await closeDialogs()
    await clearFeedback()
    await focusClick(`[...document.querySelectorAll('button')].find((node) => node.textContent === '从连接发现')`)
    await waitFor(`document.querySelector('dialog[open]')?.textContent.includes('发现结果')`, 'discovery retry')
    check('V04-ASYNC-RETRY-DISCOVERY-SUCCESS', upstream.hits.at(-1).method === 'GET', 'discovery retry performs only a catalog GET')
    await closeDialogs()

    await navigate('#/logs')
    await clearFeedback()
    addRule({ path: '/api/logs/structured', status: 500, body: { ok: false, code: 'v04_logs_500', error: 'V04_LOGS_500：日志查询暂时失败，可重试' } })
    await focusClick(`[...document.querySelectorAll('button')].find((node) => node.textContent === '查询')`)
    await waitFor(`document.querySelector('.notice.error')?.textContent.includes('查询失败')`, 'logs 500')
    currentSnapshot = await snapshot()
    check('V04-ASYNC-RETRY-LOGS-500', currentSnapshot.mainText.includes('V04_LOGS_500') && !currentSnapshot.successToasts.length, 'log query failure is visible')
    await focusClick(`[...document.querySelectorAll('button')].find((node) => node.textContent === '查询')`)
    await waitFor(`document.querySelector('table')`, 'logs retry')
    check('V04-ASYNC-RETRY-LOGS-SUCCESS', true, 'log query retry returns a real table without inference')

    await navigate('#/reliability')
    await clearFeedback()
    await focusClick(`[...document.querySelectorAll('button')].find((node) => node.textContent === '调整全局预算')`)
    addRule({ method: 'POST', path: '/api/config/preview', status: 500, body: { ok: false, code: 'v04_policy_500', error: 'V04_POLICY_500：策略预览暂时失败，可重试' } })
    await clickButton('预览变更', 'dialog[open]', true)
    await waitFor(`document.querySelector('dialog[open] .dialog-error')?.hidden === false`, 'policy 500')
    currentSnapshot = await snapshot()
    check('V04-ASYNC-RETRY-POLICY-500', currentSnapshot.dialogs[0].error.includes('V04_POLICY_500') && !currentSnapshot.successToasts.length, 'policy 500 stays local and retryable')
    await clickButton('预览变更', 'dialog[open]', true)
    await waitFor(`document.querySelector('dialog[open]')?.textContent.includes('确认策略变更')`, 'policy retry')
    check('V04-ASYNC-RETRY-POLICY-SUCCESS', true, 'policy retry reaches a real confirmation preview')
    await closeDialogs()

    await navigate('#/settings')
    await clearFeedback()
    const backupsBefore = (await getJson('/api/config/backups')).items.length
    addRule({ path: '/api/config/backups', method: 'POST', status: 500, body: { ok: false, code: 'v04_backup_500', error: 'V04_BACKUP_500：备份暂时失败，可重试' } })
    await focusClick(`[...document.querySelectorAll('button')].find((node) => node.textContent === '创建脱敏备份')`)
    await waitFor(`document.querySelector('#toasts .toast.error')`, 'backup 500')
    currentSnapshot = await snapshot()
    check('V04-ASYNC-RETRY-BACKUP-500', currentSnapshot.errorToasts.some((text) => text.includes('V04_BACKUP_500')) && !currentSnapshot.successToasts.length, 'backup 500 is an error toast, not success')
    check('V04-ASYNC-RETRY-BACKUP-500-NO-WRITE', (await getJson('/api/config/backups')).items.length === backupsBefore, 'failed backup creates no artifact')
    await focusClick(`[...document.querySelectorAll('button')].find((node) => node.textContent === '创建脱敏备份')`)
    await waitFor(`document.querySelector('#toasts .toast.success')`, 'backup retry')
    check('V04-ASYNC-RETRY-BACKUP-SUCCESS', (await getJson('/api/config/backups')).items.length === backupsBefore + 1, 'backup retry success is backed by a real sanitized artifact')
  })

  report.fixture = {
    services: (await getJson('/api/capabilities')).services.length,
    models: (await getJson('/api/models')).items.length,
    pools: (await getJson('/api/pools')).items.length,
    bindings: (await getJson('/api/harness-bindings')).items.length,
    backups: (await getJson('/api/config/backups')).items.length,
    upstreamHits: upstream.hits.length,
    upstreamMethods: upstream.hits.reduce((counts, hit) => { counts[hit.method] = (counts[hit.method] || 0) + 1; return counts }, {}),
  }
  const inferencePattern = /^\/v1\/(?:chat\/completions|responses|embeddings|rerank|images|audio|video)(?:\/|$)/
  const inferenceRequests = browserRequests.filter((request) => {
    try { return inferencePattern.test(new URL(request.url).pathname) } catch { return false }
  })
  const upstreamWrites = upstream.hits.filter((hit) => hit.method !== 'GET')
  check('V04-INFERENCE-ZERO', inferenceRequests.length === 0 && upstreamWrites.length === 0, 'zero browser inference endpoints and zero upstream writes', '0 inference requests / 0 upstream writes', { inferenceRequests: inferenceRequests.length, upstreamWrites: upstreamWrites.length, upstreamMethods: report.fixture.upstreamMethods })
  check('V04-JS-ERRORS-ZERO', report.jsErrors.length === 0, 'no uncaught JS exceptions or console errors', 0, report.jsErrors)
  check('V04-CDP-ERRORS-ZERO', report.cdpErrors.length === 0, 'no CDP interception errors', 0, report.cdpErrors)
  check('V04-NATIVE-DIALOGS-ZERO', report.nativeDialogs.length === 0, 'no native confirm/alert/prompt dialog opened or remained stuck', 0, report.nativeDialogs)
  check('V04-EXPECTED-NETWORK-ERRORS', report.networkErrors.length > 0, 'fault-injected HTTP/offline failures reached the browser network layer', '> 0 expected network errors', report.networkErrors.length)

  const caseIds = report.cases.map((item) => item.id)
  report.coverage = {
    loading: caseIds.includes('V04-LOADING'),
    empty: caseIds.includes('V04-EMPTY'),
    noResults: caseIds.includes('V04-EMPTY'),
    stale: caseIds.includes('V04-EMPTY'),
    error: caseIds.includes('V04-CORE-ERRORS'),
    partialSuccess: caseIds.includes('V04-PARTIAL'),
    cancellation: caseIds.includes('V04-CANCEL') && caseIds.includes('V04-ASYNC'),
    retry: caseIds.includes('V04-DIALOG-RETRY') && caseIds.includes('V04-ASYNC-RETRY'),
    conflict409: caseIds.includes('V04-CONFLICT'),
    conflict428: caseIds.includes('V04-CONFLICT'),
    conflict422: caseIds.includes('V04-422'),
    auth401: caseIds.includes('V04-CORE-ERRORS') && caseIds.includes('V04-DIALOG-AUTH'),
    forbidden403: caseIds.includes('V04-CORE-ERRORS') && caseIds.includes('V04-DIALOG-AUTH'),
    offline: caseIds.includes('V04-CORE-ERRORS'),
    http500: caseIds.includes('V04-CORE-ERRORS') && caseIds.includes('V04-DIALOG-RETRY'),
    slowRequest: caseIds.includes('V04-ASYNC'),
    focusPreserved: caseIds.includes('V04-CANCEL') && caseIds.includes('V04-ASYNC'),
    realPagesAndDialogs: true,
    resourceDialogs: ['service', 'model', 'connection', 'pool', 'binding', 'policy', 'harness', 'backup', 'logs', 'route-preview', 'discovery'],
  }
  report.summary = {
    cases: report.cases.length,
    checks: report.checks.length,
    passed: report.checks.filter((item) => item.ok).length,
    failed: report.checks.filter((item) => !item.ok).length,
    jsErrors: report.jsErrors.length,
    nativeDialogs: report.nativeDialogs.length,
    inferenceRequests: inferenceRequests.length,
    upstreamWrites: upstreamWrites.length,
  }
  const findingSpecs = [
    {
      id: 'V04-CANCEL-BUSY-GUARD',
      title: 'Escape closes an in-flight busy service dialog',
      detail: 'The service preview is held with aria-busy=true and every control disabled. A real CDP Escape key produces a non-cancelable cancel event; the dialog closes without a JavaScript close() call and without a write.',
      sourceReferences: ['src/ui-vnext/js/components/modal.js:22-27', 'src/ui-vnext/js/components/modal.js:51-55', 'src/ui-vnext/js/pages/services.js:78-96'],
    },
    {
      id: 'V04-CONFLICT-409-FOCUS',
      title: '409 confirmation failure can drop dialog focus',
      detail: 'After the conflict dialog becomes idle, document.activeElement is BODY rather than a control inside the still-open dialog.',
      sourceReferences: ['src/ui-vnext/js/components/modal.js:51-55', 'src/ui-vnext/js/pages/services.js:98-112'],
    },
    {
      id: 'V04-ASYNC-CANCEL-CONTROL',
      title: 'Slow route preview has no cancellation action',
      detail: 'The pending preview only shows a disabled 正在预演… button; there is no cancel action or AbortController path in the UI.',
      sourceReferences: ['src/ui-vnext/js/pages/pools.js:143-153', 'src/ui-vnext/js/api.js:11-45'],
    },
    {
      id: 'V04-ASYNC-FOCUS-PRESERVED',
      title: 'Late route-preview completion steals search focus',
      detail: 'The user focuses the service search field on another page while the preview is pending. Completion re-renders the current page and leaves document.activeElement at BODY.',
      sourceReferences: ['src/ui-vnext/js/pages/pools.js:147-149', 'src/ui-vnext/app.js:55-87', 'src/ui-vnext/js/pages/services.js:164-168'],
    },
  ]
  report.productFindings = findingSpecs.filter((finding) => report.failures.some((failure) => failure.id === finding.id)).map((finding) => ({ ...finding, state: report.failures.find((failure) => failure.id === finding.id)?.state || null }))
  report.result = report.summary.failed ? 'FAIL' : 'PASS_FIXTURE'
}

try {
  await main()
} catch (error) {
  report.result = 'BLOCKED'
  report.blocker = error.stack || error.message
  console.error(error.stack || error.message)
  process.exitCode = 1
} finally {
  const cleanup = { browser: 'not_started', gateway: 'not_started', upstream: 'not_started', tempDirs: 'not_started' }
  try {
    if (cdp) cdp.close()
    if (browser && browser.exitCode === null) {
      try { process.kill(-browser.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
      await Promise.race([once(browser, 'exit'), sleep(3000)])
      try { process.kill(-browser.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
      cleanup.browser = 'process-group-stopped'
    } else cleanup.browser = 'already-exited'
    if (gateway) { await gateway.stop(); cleanup.gateway = 'stopped' }
    if (upstream) { await upstream.stop(); cleanup.upstream = 'stopped' }
    for (const path of [profile, isolatedHome, codexHome, harnessRoot, gateway?.dir]) if (path) rmSync(path, { recursive: true, force: true })
    cleanup.tempDirs = 'removed'
  } catch (error) {
    cleanup.error = error.stack || error.message
    process.exitCode = 1
  }
  report.cleanup = cleanup
  report.finishedAt = new Date().toISOString()
  report.sourceFingerprintAfter = codeFingerprint()
  mkdirSync(outDir, { recursive: true })
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  console.log('\nREPORT ' + reportPath)
  console.log(JSON.stringify({ result: report.result, summary: report.summary, failures: report.failures.map((item) => item.id), cleanup }, null, 2))
}
