#!/usr/bin/env node
// U02: real Chrome navigation/draft matrix. Existing Chrome and an isolated
// gateway are reused; no installs, production config, inference or real upstream.
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { codeFingerprint, root } from '../tree-fingerprint.mjs'
import { startGateway, startMockUpstream } from '../test/offline/harness.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const outDir = resolve(root, 'docs/evidence/v13.1-r2/browser')
const reportPath = join(outDir, 'u02-browser-report.json')
const screenshotDir = join(outDir, 'u02')
const DRAFT_KEY = 'mg.ui-vnext.codex-mode-drafts.v1'
const MODES = ['official', 'route', 'aggregated']
const WINDOWS = [
  { id: 'harness', title: '应用接入' }, { id: 'services', title: '模型服务' }, { id: 'pools', title: '模型池' },
  { id: 'usage', title: '用量分析' }, { id: 'reliability', title: '稳定性策略' }, { id: 'settings', title: '设置' },
]
const VIEWPORTS = [[266, 720], [1440, 900]]
const THEMES = ['dark', 'light']
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))
mkdirSync(outDir, { recursive: true })
mkdirSync(screenshotDir, { recursive: true })
const report = {
  contract: 'mg-v13-u02-browser/1', command: 'node scripts/e2e/ui-v13-u02-browser.mjs', cwd: root,
  startedAt: new Date().toISOString(), headSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  worktreeDirty: !!execFileSync('git', ['status', '--porcelain=v1'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceFingerprint: codeFingerprint(), scriptSha256: createHash('sha256').update(readFileSync(scriptPath)).digest('hex'),
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  boundary: 'real Chrome + real isolated HTTP gateway + loopback catalog fixture; no production config, port 8787, real upstream, inference, install, or download',
  evidenceType: 'REAL_BROWSER_FIXTURE', resourcePreflight: { action: 'reuse-existing-only', downloads: 0, installs: 0, chrome: null },
  isolation: null, checks: [], combinations: [], screenshots: [], nativeDialogs: [], jsErrors: [], networkErrors: [], requests: [], fixture: null,
  limitations: ['Automated geometry and state assertions do not replace human visual signoff or real Codex GUI restart verification.', 'No credentials, consent tokens, configuration bodies, production data, or real upstream requests are used.'],
}
let browser = null
let profile = null
let gateway = null
let upstream = null
let cdp = null
let ws = null

function findChrome() {
  const candidates = process.env.MG_CHROME_BIN ? [process.env.MG_CHROME_BIN] : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']
  for (const candidate of candidates) {
    if (candidate.includes('/') && existsSync(candidate)) return candidate
    for (const dir of String(process.env.PATH || '').split(':')) if (dir && existsSync(join(dir, candidate))) return join(dir, candidate)
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
  let id = 0
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      const item = pending.get(msg.id); pending.delete(msg.id); clearTimeout(item.timer)
      if (msg.error) item.reject(new Error(msg.error.message)); else item.resolve(msg.result)
      return
    }
    if (msg.method === 'Runtime.exceptionThrown') report.jsErrors.push({ source: 'Runtime.exceptionThrown', text: msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text || 'exception' })
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
      report.requests.push({ serial: report.requests.length + 1, method: request.method, url: request.url })
    }
  })
  await new Promise((ok, fail) => { ws.addEventListener('open', ok, { once: true }); ws.addEventListener('error', fail, { once: true }) })
  return {
    send(method, params = {}) {
      return new Promise((resolveSend, reject) => {
        const current = ++id
        const timer = setTimeout(() => { pending.delete(current); reject(new Error('CDP timeout: ' + method)) }, 30000)
        pending.set(current, { resolve: resolveSend, reject, timer })
        ws.send(JSON.stringify({ id: current, method, params }))
      })
    }, close() { ws.close() },
  }
}

async function ev(expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  return result.result.value
}

async function waitFor(expression, label, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try { if (await ev(expression)) return } catch { /* navigation can replace the execution context */ }
    await sleep(60)
  }
  const text = await ev('document.body?.innerText || ""').catch(() => '')
  const diagnostics = await ev(`(async () => ({ value: document.querySelector('select[aria-label="第三方角色目标"]')?.value, marker: document.querySelector('select[aria-label="第三方角色目标"]')?.dataset.draftTarget, selectedIndex: document.querySelector('select[aria-label="第三方角色目标"]')?.selectedIndex, options: [...document.querySelectorAll('select[aria-label="第三方角色目标"] option')].map((node) => ({ value: node.value, selected: node.selected, attribute: node.getAttribute('selected') })), stored: localStorage.getItem('${DRAFT_KEY}'), source: await fetch('/ui-vnext/js/pages/mode.js').then((response) => response.text()).then((text) => ({ marker: text.includes('draftTarget: draft.target'), selected: text.includes('selected: item.value === draft.target'), bytes: text.length })), module: await import('/ui-vnext/js/pages/mode.js').then((module) => ({ marker: module.renderCodexPanel.toString().includes('draftTarget'), selected: module.renderCodexPanel.toString().includes('selected: item.value') })), store: await import('/ui-vnext/js/store.js').then((module) => ({ status: module.state.codexDraftStatus, reason: module.state.codexDraftError, phase: module.state.phase, drafts: module.state.codexDrafts })), html: document.querySelector('select[aria-label="第三方角色目标"]')?.outerHTML }))()`).catch(() => null)
  throw new Error('wait timeout: ' + label + ' :: ' + text.slice(-2500) + ' diagnostics=' + JSON.stringify(diagnostics))
}

function check(id, ok, detail, expected, actual) {
  const item = { id, ok: !!ok, detail }
  if (expected !== undefined) item.expected = expected
  if (actual !== undefined) item.actual = actual
  report.checks.push(item)
  console.log((ok ? 'PASS ' : 'FAIL ') + id + ' :: ' + detail)
  if (!ok) throw new Error(id + ': ' + detail + (actual === undefined ? '' : ' actual=' + JSON.stringify(actual)))
}

async function ready() {
  await waitFor('document.readyState === "complete" && document.querySelector("#gateway-state")?.dataset.state === "ready" && document.querySelector("#main h1")', 'ready control plane')
}

async function reload() {
  const token = 'reload-' + Date.now() + '-' + Math.random()
  await ev(`globalThis.__u02ReloadSentinel = ${JSON.stringify(token)}`)
  await cdp.send('Page.reload', { ignoreCache: true })
  await waitFor(`typeof globalThis.__u02ReloadSentinel === 'undefined' && document.readyState === 'complete' && document.querySelector('#gateway-state')?.dataset.state === 'ready' && document.querySelector('#main h1')`, 'new document ready')
  await frame()
}

async function frame() { await ev('new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)))') }

async function navigate(id) {
  await ev(`document.querySelector('[data-route="${id}"]').click()`)
  await waitFor(`location.hash === '#/${id}' && document.querySelector('#main h1')`, 'navigate ' + id)
  await frame()
}

async function screenshot(name) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const file = join(screenshotDir, name + '.png')
  writeFileSync(file, Buffer.from(shot.data, 'base64'))
  report.screenshots.push(relative(root, file))
}

async function clickButton(text, scope = '#main') {
  await ev(`(() => { const button = [...document.querySelectorAll(${JSON.stringify(scope + ' button')})].find((node) => node.textContent.trim() === ${JSON.stringify(text)}); if (!button) throw new Error('missing button: ' + ${JSON.stringify(text)}); button.click(); })()`)
}

async function chooseMode(mode, target) {
  await ev(`document.querySelector('[data-mode="${mode}"]').click()`)
  await waitFor(`document.querySelector('[data-mode="${mode}"]')?.getAttribute('aria-checked') === 'true'`, 'mode ' + mode)
  if (mode !== 'official') {
    await ev(`(() => { const select = document.querySelector('select[aria-label="第三方角色目标"]'); select.value = ${JSON.stringify(target)}; select.dispatchEvent(new Event('change', { bubbles: true })); })()`)
    await waitFor(`document.querySelector('select[aria-label="第三方角色目标"]')?.value === ${JSON.stringify(target)}`, 'target ' + target)
  }
  await frame()
}

async function draftRecord() { return ev(`JSON.parse(localStorage.getItem('${DRAFT_KEY}'))`) }
async function selectedDraft() {
  return ev(`(() => { const mode = document.querySelector('[role="radio"][aria-checked="true"]')?.dataset.mode; const target = document.querySelector('select[aria-label="第三方角色目标"]'); return { mode, target: target?.value || '', parent: document.querySelector('input[aria-label="官方父模型"]')?.value || '' }; })()`)
}

async function geometry(id, title) {
  const value = await ev(`(() => { const main = document.getElementById('main'); const selected = [...document.querySelectorAll('#primary-nav [aria-current="page"]')].map((node) => node.dataset.route); const crumbs = [...document.querySelectorAll('#breadcrumb [aria-current="page"]')].map((node) => node.textContent); return { hash: location.hash, h1: document.querySelector('#main h1')?.textContent, docWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, viewportWidth: innerWidth, viewportHeight: innerHeight, mainClientWidth: main.clientWidth, mainScrollWidth: main.scrollWidth, selected, crumbs, firstCrumb: document.querySelector('#breadcrumb a')?.getAttribute('href') }; })()`)
  const ok = value.h1 === title && value.selected.length === 1 && value.selected[0] === id && value.crumbs.at(-1) === title && value.firstCrumb === '#/harness'
    && value.docWidth <= value.viewportWidth + 1 && value.bodyWidth <= value.viewportWidth + 1 && value.mainScrollWidth <= value.mainClientWidth + 1
  return { ok, ...value }
}

async function discard(scope = '#main') {
  await clickButton('放弃全部草稿', scope)
  await waitFor('document.querySelector("dialog[open]") && document.querySelector("dialog[open] h2").textContent.includes("确认放弃")', 'custom discard dialog')
  check('U02-DISCARD-DIALOG', await ev('document.querySelector("dialog[open]").getAttribute("aria-modal") === "true" && [...document.querySelectorAll("dialog[open] button")].some((node) => node.textContent === "保留草稿")'), 'discard uses an accessible custom modal with a cancel choice')
  await clickButton('确认放弃', 'dialog[open]')
  await waitFor('!document.querySelector("dialog[open]")', 'discard confirmed')
}

async function main() {
  const bin = findChrome()
  if (!bin) { report.result = 'NOT_RUN_BROWSER'; throw new Error('NOT_RUN_BROWSER: no existing Chrome; installation is not authorized') }
  const port = await freePort()
  profile = mkdtempSync(join(tmpdir(), 'mg-u02-chrome-'))
  browser = spawn(bin, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=' + port, '--remote-allow-origins=*', '--user-data-dir=' + profile, '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' })
  const cdpBase = 'http://127.0.0.1:' + port
  let version = null
  const deadline = Date.now() + 15000
  while (Date.now() < deadline && !version) {
    try { const response = await fetch(cdpBase + '/json/version'); if (response.ok) version = await response.json() } catch {}
    if (!version) await sleep(100)
  }
  if (!version) throw new Error('NOT_RUN_BROWSER: existing Chrome CDP did not start')
  report.resourcePreflight.chrome = { binary: bin, version: version.Browser, reused: true }
  upstream = await startMockUpstream()
  gateway = await startGateway({
    name: 'u02-browser', env: { MG_BUILD_SHA: report.headSha, CODEX_HOME: mkdtempSync(join(tmpdir(), 'mg-u02-codex-')) },
    config: { providers: { mock: { baseUrl: upstream.base } }, models: { demo: { provider: 'mock' }, second: { provider: 'mock' } }, virtualModels: [{ name: 'daily', directory: [{ model: 'demo' }, { model: 'second', mode: 'onFail' }], maxContext: 8192 }] },
  })
  report.isolation = { gateway: '127.0.0.1 dynamic port', config: 'temporary MG_CONFIG_DIR', profile: 'temporary Chrome profile', productionTouched: false }
  const target = await (await fetch(cdpBase + '/json/new?' + encodeURIComponent(gateway.base + '/ui-vnext/#/harness'), { method: 'PUT' })).json()
  cdp = await connect(target.webSocketDebuggerUrl)
  for (const method of ['Runtime.enable', 'Page.enable', 'Log.enable', 'Network.enable', 'DOMStorage.enable']) await cdp.send(method)
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `globalThis.__nativeDialogCalls = 0; for (const name of ['confirm', 'prompt', 'alert']) globalThis[name] = () => { globalThis.__nativeDialogCalls++; throw new Error('native dialog forbidden: ' + name); };` })
  await ready()
  const liveCaps = await (await fetch(gateway.base + '/api/capabilities')).json()
  const livePools = await (await fetch(gateway.base + '/api/pools')).json()
  const liveModels = await (await fetch(gateway.base + '/api/models')).json()
  report.fixture = { configVersion: liveCaps.runtime.configVersion, services: liveCaps.services.length, models: liveModels.items.length, pools: livePools.items.length }
  const modelTarget = 'model:' + liveModels.items.find((item) => item.enabled).modelId
  const pool = livePools.items.find((item) => item.enabled)
  const poolTarget = pool ? 'pool:' + (pool.poolId || pool.slug) : modelTarget
  const targets = { official: '', route: modelTarget, aggregated: poolTarget }
  check('U02-FIXTURE', liveModels.items.length >= 2 && !!pool, 'real isolated model/pool fixture supplies route and aggregated targets', { models: '>=2', pool: true }, { models: liveModels.items.length, pool: !!pool })
  // Seed distinct values in both editable modes before testing official-mode isolation.
  await chooseMode('route', modelTarget)
  await chooseMode('aggregated', poolTarget)

  for (const theme of THEMES) {
    for (const [width, height] of VIEWPORTS) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
      for (const mode of MODES) {
        const id = `U02-${theme}-${width}x${height}-${mode}`
        await navigate('harness')
        await chooseMode(mode, targets[mode])
        // The harness has enough real content to scroll at both required sizes.
        await ev('document.getElementById("main").scrollTop = 260')
        await frame()
        const scrollBefore = await ev('document.getElementById("main").scrollTop')
        await navigate('services')
        await ev('history.back()')
        await waitFor('location.hash === "#/harness"', 'history back to harness')
        await frame()
        const scrollAfter = await ev('document.getElementById("main").scrollTop')
        check(id + '-BACK-SCROLL', scrollBefore > 0 && Math.abs(scrollAfter - scrollBefore) <= 2, 'browser Back restores the parent window scroll position', { before: scrollBefore, after: scrollAfter }, { before: scrollBefore, after: scrollAfter })
        await ev('history.forward()')
        await waitFor('location.hash === "#/services"', 'history forward to services')
        await frame()
        check(id + '-FORWARD-SCROLL', (await geometry('services', '模型服务')).ok, 'browser Forward restores the child window with parent navigation selected')
        await navigate('harness')
        await ev('document.getElementById("main").scrollTop = 0')
        const windows = []
        for (const window of WINDOWS.slice(1)) {
          await navigate(window.id)
          const measured = await geometry(window.id, window.title)
          check(id + '-WINDOW-' + window.id, measured.ok, `${mode} draft survives ${window.id}; breadcrumb, parent selection and geometry are correct`, { selected: window.id, title: window.title, noOverflow: true }, measured)
          windows.push({ id: window.id, ...measured })
        }
        await navigate('harness')
        const selected = await selectedDraft()
        const record = await draftRecord()
        check(id + '-ROUNDTRIP', selected.mode === mode && selected.target === targets[mode], 'three-mode draft survives all six primary windows and returns to its parent', { mode, target: targets[mode] || '(none)' }, selected)
        check(id + '-ISOLATION', record.drafts.official.target === '' && record.drafts.route.target === modelTarget && record.drafts.aggregated.target === poolTarget && record.drafts.aggregated.parent === 'gpt-6-luna', 'official/route/aggregated drafts remain isolated and the official parent is fixed', { route: modelTarget, aggregated: poolTarget, parent: 'gpt-6-luna' }, record.drafts)
        await ev('history.back()')
        await waitFor('location.hash === "#/settings"', 'history back after full window loop')
        await frame()
        check(id + '-BACK', (await geometry('settings', '设置')).ok, 'Back selects the settings parent and renders its breadcrumb')
        await ev('history.forward()')
        await waitFor('location.hash === "#/harness"', 'history forward after full window loop')
        await frame()
        check(id + '-FORWARD', (await selectedDraft()).mode === mode, 'Forward restores the selected draft mode')
        await reload()
        const restored = await selectedDraft()
        check(id + '-REFRESH', restored.mode === mode && restored.target === targets[mode], 'real-origin refresh restores the non-sensitive per-mode draft', { mode, target: targets[mode] || '(none)' }, restored)
        const storage = await ev(`(() => { const result = {}; for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); result[key] = localStorage.getItem(key); } return result; })()`)
        const serialized = JSON.stringify(storage)
        check(id + '-NO-SECRETS', !/api[_-]?key|authorization|consent|confirmToken|expectedSha|secret|credential|password/i.test(serialized), 'localStorage contains preferences and allowlisted mode selections only', 'no sensitive field names or values', Object.keys(storage))
        const harnessGeometry = await geometry('harness', '应用接入')
        check(id + '-HARNESS-GEOMETRY', harnessGeometry.ok, 'restored harness fits the viewport with selected parent navigation', { selected: 'harness', title: '应用接入', noOverflow: true }, harnessGeometry)
        await screenshot(id)
        report.combinations.push({ id, theme, width, height, mode, ok: true, windows, restored })
      }
    }
  }
  const windowStates = report.combinations.reduce((sum, item) => sum + item.windows.length + 1, 0)
  check('U02-MATRIX', report.combinations.length === 12 && windowStates === 72 && report.combinations.every((item) => item.ok), '3 modes × 6 primary windows × 2 viewports × 2 themes = 72 measured window states across 12 complete journeys', { journeys: 12, windowStates: 72 }, { journeys: report.combinations.length, windowStates })

  // Cancel and confirm are distinct; no native dialog is involved.
  await navigate('harness')
  await chooseMode('route', modelTarget)
  await clickButton('放弃全部草稿')
  await waitFor('document.querySelector("dialog[open]")', 'discard cancel dialog')
  await clickButton('保留草稿', 'dialog[open]')
  await waitFor('!document.querySelector("dialog[open]")', 'discard cancelled')
  check('U02-DISCARD-CANCEL', (await selectedDraft()).target === modelTarget && !!(await draftRecord()), 'cancelling custom discard preserves the live and stored draft')
  await discard()
  check('U02-DISCARD-CONFIRM', await ev(`localStorage.getItem('${DRAFT_KEY}') === null`) && (await selectedDraft()).target === '', 'explicit custom discard clears stored draft and resets the form')

  // Persist failure is visible and does not prevent in-page navigation.
  await ev(`(() => { const original = Storage.prototype.setItem; globalThis.__restoreSetItem = () => { Storage.prototype.setItem = original }; Storage.prototype.setItem = function(key, value) { if (key === '${DRAFT_KEY}') throw new DOMException('quota', 'QuotaExceededError'); return original.call(this, key, value); }; })()`)
  await chooseMode('aggregated', poolTarget)
  await waitFor('document.querySelector("[data-draft-status]")?.textContent.includes("浏览器拒绝保存本地草稿")', 'visible write failure')
  check('U02-STORAGE-WRITE-FAIL', await ev(`localStorage.getItem('${DRAFT_KEY}') === null`), 'failed localStorage write does not create a partial draft record')
  await navigate('services')
  await navigate('harness')
  check('U02-STORAGE-MEMORY', (await selectedDraft()).target === poolTarget, 'visible storage failure falls back to current-page memory across navigation')
  await ev('globalThis.__restoreSetItem()')
  await discard()

  // Failed removal must not claim success; retry remains available.
  await chooseMode('route', modelTarget)
  await ev(`(() => { const original = Storage.prototype.removeItem; globalThis.__restoreRemoveItem = () => { Storage.prototype.removeItem = original }; Storage.prototype.removeItem = function(key) { if (key === '${DRAFT_KEY}') throw new DOMException('denied', 'SecurityError'); return original.call(this, key); }; })()`)
  await discard()
  await waitFor('document.querySelector("[data-draft-status]")?.textContent.includes("浏览器未能删除已存草稿")', 'visible remove failure')
  check('U02-STORAGE-REMOVE-FAIL', !!(await draftRecord()), 'failed removal keeps the old record and visibly reports that refresh may recover it')
  await ev('globalThis.__restoreRemoveItem()')
  await discard()
  check('U02-STORAGE-REMOVE-RETRY', await ev(`localStorage.getItem('${DRAFT_KEY}') === null`), 'explicit discard can be retried after localStorage recovers')

  // Read failure is visible after a real reload, while editing remains usable.
  await chooseMode('route', modelTarget)
  const readScript = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { const original = Storage.prototype.getItem; globalThis.__restoreGetItem = () => { Storage.prototype.getItem = original }; Storage.prototype.getItem = function(key) { if (key === '${DRAFT_KEY}') throw new DOMException('denied', 'SecurityError'); return original.call(this, key); }; })()` })
  await reload()
  await waitFor('document.querySelector("[data-draft-status]")?.textContent.includes("浏览器无法读取本地草稿")', 'visible read failure')
  check('U02-STORAGE-READ-FAIL', (await selectedDraft()).target === '', 'failed read does not silently claim draft recovery')
  await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: readScript.identifier })
  await ev('globalThis.__restoreGetItem()')
  await reload()
  check('U02-STORAGE-READ-RETRY', (await selectedDraft()).target === modelTarget, 'draft is recoverable after read access is restored')

  // Version drift quarantines persisted values until an explicit choice.
  await ev(`(() => { const key = '${DRAFT_KEY}'; const record = JSON.parse(localStorage.getItem(key)); record.baseVersion = 'stale-fixture-version'; localStorage.setItem(key, JSON.stringify(record)); })()`)
  await reload()
  await waitFor(`document.querySelector('[data-draft-status="stale"]')`, 'stale draft status')
  const staleSelected = await selectedDraft()
  const staleControlsDisabled = await ev(`[...document.querySelectorAll('[role="radio"]')].every((node) => node.disabled) && [...document.querySelectorAll('#main button')].find((node) => node.textContent === '预览并应用')?.disabled === true`)
  check('U02-STALE-QUARANTINE', staleSelected.mode === 'official' && staleSelected.target === '' && staleControlsDisabled, 'stale version never autofills or enables stale draft controls', { mode: 'official', target: '', disabled: true }, { ...staleSelected, controlsDisabled: staleControlsDisabled })
  await clickButton('放弃旧草稿')
  await waitFor('document.querySelector("dialog[open]")', 'stale discard dialog')
  await clickButton('保留草稿', 'dialog[open]')
  await clickButton('保留并恢复旧草稿')
  await waitFor(`document.querySelector('[data-draft-status="ready"]')`, 'explicit stale recovery')
  check('U02-STALE-RECOVER', (await selectedDraft()).target === modelTarget && (await draftRecord()).baseVersion === String(report.fixture.configVersion), 'explicit recovery rebases the sanitized draft to the current config version')
  await ev(`(() => { const key = '${DRAFT_KEY}'; const record = JSON.parse(localStorage.getItem(key)); record.baseVersion = 'stale-fixture-version'; localStorage.setItem(key, JSON.stringify(record)); })()`)
  await reload()
  await discard()
  check('U02-STALE-DISCARD', await ev(`localStorage.getItem('${DRAFT_KEY}') === null`), 'stale draft can be explicitly discarded without native confirmation')

  // Hostile/corrupt persisted data is isolated and removed, never rendered or retained.
  const hostileDraft = JSON.stringify({ schema: 'mg-ui-vnext-codex-mode-drafts/1', baseVersion: String(report.fixture.configVersion), apiKey: 'U02-SECRET-SENTINEL', consentToken: 'U02-TOKEN-SENTINEL', drafts: { mode: 'aggregated', official: { target: '' }, route: { target: 'model:U02-SECRET-SENTINEL' }, aggregated: { parent: 'U02-SECRET-SENTINEL', target: 'model:U2-SECRET-SENTINEL' } } })
  await ev(`(() => { const frame = document.createElement('iframe'); frame.src = 'about:blank'; document.body.appendChild(frame); frame.contentWindow.localStorage.setItem('${DRAFT_KEY}', ${JSON.stringify(hostileDraft)}); frame.remove(); })()`)
  await frame()
  check('U02-UNTRUSTED-SEED', await ev(`localStorage.getItem('${DRAFT_KEY}')?.includes('U02-SECRET-SENTINEL') === true`), 'hostile draft fixture is present before reload')
  await reload()
  await waitFor(`document.querySelector('[data-draft-status="error"]')`, 'invalid draft isolated')
  const localStorageAfterInvalid = await ev('JSON.stringify(localStorage)')
  check('U02-UNTRUSTED-DRAFT', await ev(`localStorage.getItem('${DRAFT_KEY}') === null`) && !localStorageAfterInvalid.includes('U02-SECRET-SENTINEL') && !(await ev('document.body.innerText')).includes('U02-SECRET-SENTINEL'), 'unknown fields, invalid parent and unapproved target are removed and never rendered')

  // Detail breadcrumbs keep the correct primary parent and preserve query context.
  await ev('location.hash = "#/service-detail?service=mock"')
  await ready()
  const detail = await ev(`({ selected: document.querySelector('#primary-nav [aria-current="page"]')?.dataset.route, crumbs: [...document.querySelectorAll('#breadcrumb a')].map((node) => ({ text: node.textContent, href: node.getAttribute('href') })) })`)
  check('U02-DETAIL-BREADCRUMB', detail.selected === 'services' && detail.crumbs.some((item) => item.text === '模型服务' && item.href === '#/services'), 'service detail breadcrumb links to its selected primary parent', { selected: 'services', serviceCrumb: '#/services' }, detail)
  await ev('location.hash = "#/account-detail?service=mock"')
  await ready()
  const account = await ev(`({ selected: document.querySelector('#primary-nav [aria-current="page"]')?.dataset.route, href: [...document.querySelectorAll('#breadcrumb a')].at(-1).getAttribute('href') })`)
  check('U02-NESTED-BREADCRUMB', account.selected === 'services' && account.href === '#/service-detail?service=mock', 'connection detail retains service context in its clickable breadcrumb', { selected: 'services', href: '#/service-detail?service=mock' }, account)

  check('U02-NO-NATIVE-DIALOG', report.nativeDialogs.length === 0 && await ev('globalThis.__nativeDialogCalls') === 0, 'navigation, discard, storage failures and stale recovery never call native dialogs', 0, { cdp: report.nativeDialogs.length, calls: await ev('globalThis.__nativeDialogCalls') })
  check('U02-NO-JS-ERRORS', report.jsErrors.length === 0 && report.networkErrors.length === 0, 'no JavaScript or network errors in the U02 browser run', 0, { js: report.jsErrors.length, network: report.networkErrors.length })
  const nonGateway = report.requests.filter((item) => !item.url.startsWith(gateway.base))
  const writes = report.requests.filter((item) => item.method !== 'GET' && item.method !== 'OPTIONS')
  check('U02-ZERO-UPSTREAM', upstream.hits.length === 0 && nonGateway.length === 0 && writes.length === 0, 'U02 performs zero inference, upstream and configuration-write requests', { upstream: 0, nonGateway: 0, writes: 0 }, { upstream: upstream.hits.length, nonGateway: nonGateway.length, writes: writes.length })
  report.result = 'PASS'
}

try { await main() } catch (error) { report.result = 'FAIL'; report.failure = error.stack || error.message; console.error(error.stack || error.message); process.exitCode = 1 } finally {
  report.finishedAt = new Date().toISOString()
  report.summary = { checks: report.checks.length, passed: report.checks.filter((item) => item.ok).length, failed: report.checks.filter((item) => !item.ok).length, combinations: report.combinations.length, windowStates: report.combinations.reduce((sum, item) => sum + item.windows.length + 1, 0), screenshots: report.screenshots.length, nativeDialogs: report.nativeDialogs.length, jsErrors: report.jsErrors.length, networkErrors: report.networkErrors.length, upstreamHits: upstream?.hits.length ?? 0 }
  if (report.result === 'PASS' && report.summary.failed) report.result = 'FAIL'
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  console.log('REPORT ' + report.result + ' ' + relative(root, reportPath))
  if (cdp) cdp.close()
  if (browser && browser.exitCode === null) { browser.kill('SIGTERM'); await Promise.race([once(browser, 'exit'), sleep(3000)]); if (browser.exitCode === null) browser.kill('SIGKILL') }
  if (gateway) await gateway.stop()
  if (upstream) await upstream.stop()
  if (profile) rmSync(profile, { recursive: true, force: true })
}
