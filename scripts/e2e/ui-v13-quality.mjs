#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { codeFingerprint, root } from '../tree-fingerprint.mjs'
import { startGateway, startMockUpstream } from '../test/offline/harness.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const outDir = resolve(root, 'docs/evidence/v13.1-r2/browser')
mkdirSync(outDir, { recursive: true })
const outputIndex = process.argv.indexOf('--output')
const reportPath = outputIndex >= 0 ? resolve(process.argv[outputIndex + 1]) : join(outDir, 'v05-v06-quality-report.json')
const budgets = Object.freeze({
  gatewayStartMs: 15000,
  fixtureApiMs: 10000,
  initialRenderMs: 20000,
  routeRenderMs: 5000,
  interactionMs: 2000,
  scrollMs: 2000,
  longTaskMs: 2500,
})
const fixtureScale = Object.freeze({ services: 100, pools: 31, candidatesPerPool: 48, models: 1000, connections: 40 })
const viewports = Object.freeze([[266, 720], [1440, 900]])
const themes = Object.freeze(['dark', 'light'])
const pageScales = Object.freeze([0.8, 1, 1.25, 1.5])
const report = {
  contract: 'mg-v13-v05-v06-quality/2',
  command: 'node scripts/e2e/ui-v13-quality.mjs',
  cwd: root,
  startedAt: new Date().toISOString(),
  headSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  worktreeDirty: !!execFileSync('git', ['status', '--porcelain=v1'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceFingerprint: codeFingerprint(),
  scriptSha256: createHash('sha256').update(readFileSync(scriptPath)).digest('hex'),
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  boundary: 'real Chrome + real isolated HTTP gateway + loopback fixture; no production config, port 8787, real upstream, install, or download',
  budgets,
  fixtureScale,
  resourcePreflight: { downloads: 0, installs: 0, action: 'reuse-existing-only' },
  checks: [],
  timings: { fixture: [], initial: null, routes: [], interactions: [], longTasks: [] },
  fixture: null,
  viewports: [],
  pageScans: [],
  axScans: [],
  contrast: [],
  focus: [],
  dialogs: [],
  reachability: [],
  scrolling: [],
  reducedMotion: null,
  pageScales: [],
  pageScaleMethod: 'computed CSS zoom on isolated .shell; CDP Emulation.setPageScaleFactor was ineffective in this headless Chrome build',
  ime: null,
  controlStates: [],
  manualVisualSignoff: {
    status: 'NOT_RUN_HUMAN_VISUAL_SIGNOFF',
    detail: 'Automated CDP geometry, input-event and computed-style checks cannot replace human visual signoff for clipping, visual quality or IME candidate-window presentation.',
  },
  screenshots: [],
  errors: [],
  networkErrors: [],
  httpErrors: [],
}

let browser = null
let profile = null
let codexHome = null
let harnessHome = null
let gateway = null
let upstream = null
let cdp = null

class NotRunError extends Error {}
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))

function check(id, ok, detail, measured) {
  const item = { id, ok: !!ok, detail }
  if (measured !== undefined) item.measured = measured
  report.checks.push(item)
  console.log((item.ok ? 'PASS ' : 'FAIL ') + id + ' :: ' + detail)
  return item.ok
}

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
    if (msg.method === 'Runtime.exceptionThrown') {
      const params = msg.params
      report.errors.push({ source: 'Runtime.exceptionThrown', text: params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || 'uncaught exception' })
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      report.errors.push({ source: 'console.error', text: msg.params.args.map((arg) => arg.value || arg.description || '').join(' ') })
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      const entry = msg.params.entry
      if (entry.source === 'network') report.networkErrors.push({ text: entry.text, url: entry.url || '' })
      else report.errors.push({ source: entry.source, text: entry.text, url: entry.url || '' })
    }
    if (msg.method === 'Network.responseReceived') {
      const response = msg.params.response
      if (response.status >= 400) report.httpErrors.push({ status: response.status, url: response.url })
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
    on(method, handler) { handlers.set(method, handler) },
    close() { ws.close() },
  }
}

function buildFixture(upstreamBase) {
  const providers = {}
  const models = {}
  const modelNames = []
  for (let i = 0; i < fixtureScale.services; i++) {
    const suffix = String(i).padStart(3, '0')
    const providerId = 'fixture-provider-' + suffix
    providers[providerId] = {
      serviceId: 'svc_fixture_' + suffix,
      displayName: 'Fixture Service ' + String(i + 1).padStart(3, '0'),
      baseUrl: upstreamBase + '/v1',
      api: 'openai',
      region: 'fixture',
      enabled: true,
      ...(i === 0 ? { connections: Array.from({ length: fixtureScale.connections }, (_, index) => {
        const connectionSuffix = String(index + 1).padStart(3, '0')
        return {
          connectionId: 'conn_fixture_account_' + connectionSuffix,
          displayName: 'Fixture Account ' + String(index + 1).padStart(2, '0'),
          enabled: true,
          priority: index,
          maxConcurrent: 0,
          quotaScopeId: '',
          authDomain: '',
          modelIds: [],
        }
      }) } : {}),
    }
  }
  for (let i = 0; i < fixtureScale.models; i++) {
    const suffix = String(i).padStart(4, '0')
    const name = 'fixture-model-' + suffix
    modelNames.push(name)
    models[name] = {
      modelId: 'mdl_fixture_' + suffix,
      provider: 'fixture-provider-' + String(Math.floor(i / 10)).padStart(3, '0'),
      upstreamModelId: 'vendor-model-' + suffix,
      displayName: 'Fixture Model ' + String(i + 1).padStart(4, '0'),
      capability: 'chat',
      api: 'openai',
      enabled: true,
    }
  }
  const virtualModels = Array.from({ length: fixtureScale.pools }, (_, poolIndex) => {
    const suffix = String(poolIndex + 1).padStart(3, '0')
    const selection = poolIndex % 3 === 0 ? 'weighted' : poolIndex % 3 === 1 ? 'priority' : 'round_robin'
    const members = Array.from({ length: fixtureScale.candidatesPerPool }, (_, candidateIndex) => {
      const model = modelNames[(poolIndex * fixtureScale.candidatesPerPool + candidateIndex) % modelNames.length]
      return {
        modelId: model,
        model,
        providerId: models[model].provider,
        priority: candidateIndex,
        weight: selection === 'weighted' ? candidateIndex + 1 : 0,
        enabled: true,
      }
    })
    return {
      poolId: 'pool_fixture_' + suffix,
      slug: 'fixture-pool-' + suffix,
      name: 'Fixture Pool ' + String(poolIndex + 1).padStart(2, '0'),
      enabled: true,
      selection,
      revision: 1,
      members,
      directory: members.map((member, index) => ({ model: member.model, providers: [member.providerId], mode: index % 2 ? 'afterAll' : 'onFail', enabled: true })),
    }
  })
  return {
    defaults: { retry: { maxAttempts: 1 }, timeout: { firstByteMs: 2000, idleMs: 2000 }, proxyMode: 'direct', directory: [{ model: modelNames[0], providers: [models[modelNames[0]].provider] }] },
    providers,
    models,
    virtualModels,
    harnessBindings: [],
  }
}

async function fetchJson(path) {
  const started = performance.now()
  const response = await fetch(gateway.base + path)
  const text = await response.text()
  const elapsedMs = performance.now() - started
  if (!response.ok) throw new Error(path + ' HTTP ' + response.status + ': ' + text.slice(0, 300))
  report.timings.fixture.push({ path, elapsedMs: Number(elapsedMs.toFixed(2)), bytes: Buffer.byteLength(text) })
  return JSON.parse(text)
}

async function verifyFixture() {
  const [capabilities, models, pools] = await Promise.all([
    fetchJson('/api/capabilities'),
    fetchJson('/api/models'),
    fetchJson('/api/pools'),
  ])
  const serviceCount = capabilities.services.length
  const modelCount = models.items.length
  const poolCount = pools.items.length
  const maxCandidates = Math.max(0, ...pools.items.map((pool) => pool.members.length))
  const candidateReferences = pools.items.reduce((sum, pool) => sum + pool.members.length, 0)
  const connectionCount = capabilities.services.reduce((sum, service) => sum + service.connections.length, 0)
  report.fixture = {
    gateway: { base: gateway.base, port: gateway.port, host: '127.0.0.1' },
    upstream: { base: upstream.base, port: upstream.port, host: '127.0.0.1' },
    observed: { services: serviceCount, pools: poolCount, maxCandidatesPerPool: maxCandidates, candidateReferences, models: modelCount, connections: connectionCount },
  }
  check('V05-FIXTURE-SERVICES', serviceCount >= fixtureScale.services, 'services=' + serviceCount, serviceCount)
  check('V05-FIXTURE-POOLS', poolCount >= fixtureScale.pools, 'pools=' + poolCount, poolCount)
  check('V05-FIXTURE-CANDIDATES', maxCandidates >= fixtureScale.candidatesPerPool, 'maxCandidatesPerPool=' + maxCandidates + ', references=' + candidateReferences, maxCandidates)
  check('V05-FIXTURE-MODELS', modelCount >= fixtureScale.models, 'models=' + modelCount, modelCount)
  check('V05-FIXTURE-CONNECTIONS', connectionCount >= fixtureScale.connections, 'connections=' + connectionCount, connectionCount)
  check('V05-FIXTURE-API-TIMING', report.timings.fixture.every((item) => item.elapsedMs <= budgets.fixtureApiMs), 'all fixture API reads within ' + budgets.fixtureApiMs + 'ms', Math.max(...report.timings.fixture.map((item) => item.elapsedMs)))
  check('V05-ISOLATION', gateway.port !== 8787 && upstream.port !== 8787 && gateway.base.startsWith('http://127.0.0.1:') && upstream.base.startsWith('http://127.0.0.1:'), 'dynamic loopback ports; production 8787 not used', { gatewayPort: gateway.port, upstreamPort: upstream.port })
}

const PAGE_SCAN = `(() => {
  const visibleText = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || ''
    if (node.nodeType !== Node.ELEMENT_NODE) return ''
    if (node.getAttribute('aria-hidden') === 'true') return ''
    const style = getComputedStyle(node)
    if (style.display === 'none' || style.visibility === 'hidden') return ''
    return [...node.childNodes].map(visibleText).join(' ')
  }
  const nameOf = (el) => {
    const labelledBy = el.getAttribute('aria-labelledby')
    if (labelledBy) return labelledBy.split(/\\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ').trim()
    if (el.getAttribute('aria-label')?.trim()) return el.getAttribute('aria-label').trim()
    if (el.labels?.length) return [...el.labels].map((label) => visibleText(label)).join(' ').trim()
    return visibleText(el).replace(/\\s+/g, ' ').trim()
  }
  const sample = (el) => ({
    tag: el.tagName.toLowerCase(),
    id: el.id || undefined,
    class: el.className || undefined,
    text: (el.getAttribute('aria-label') || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
  })
  const buttons = [...document.querySelectorAll('button')]
  const controls = [...document.querySelectorAll('input, select, textarea')]
  const unnamedButtons = buttons.filter((el) => !nameOf(el))
  const unnamedControls = controls.filter((el) => !nameOf(el))
  const ids = [...document.querySelectorAll('[id]')].map((el) => el.id)
  const seen = new Set()
  const duplicates = []
  for (const id of ids) { if (seen.has(id)) duplicates.push(id); seen.add(id) }
  const brokenAriaRefs = []
  for (const el of document.querySelectorAll('[aria-labelledby], [aria-describedby], [aria-controls]')) {
    for (const attr of ['aria-labelledby', 'aria-describedby', 'aria-controls']) {
      for (const id of (el.getAttribute(attr) || '').split(/\\s+/).filter(Boolean)) if (!document.getElementById(id)) brokenAriaRefs.push({ attr, id, element: sample(el) })
    }
  }
  const internalScroll = '.table-wrap, .pool-list, .sidebar, .dialog-body'
  const overflowOffenders = [...document.querySelectorAll('body *')].filter((el) => {
    if (el.closest(internalScroll)) return false
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden' || style.position === 'fixed') return false
    const rect = el.getBoundingClientRect()
    return rect.width > 0 && (rect.right > innerWidth + 1 || rect.left < -1)
  }).slice(0, 12).map((el) => ({ ...sample(el), left: Math.round(el.getBoundingClientRect().left), right: Math.round(el.getBoundingClientRect().right), width: Math.round(el.getBoundingClientRect().width) }))
  const main = document.getElementById('main')
  return {
    hash: location.hash,
    title: document.title,
    h1Count: document.querySelectorAll('h1').length,
    h1: document.querySelector('h1')?.textContent || '',
    buttonCount: buttons.length,
    formControlCount: controls.length,
    unnamedButtons: unnamedButtons.map(sample),
    unnamedControls: unnamedControls.map(sample),
    duplicateIds: [...new Set(duplicates)],
    brokenAriaRefs,
    viewportWidth: innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
    mainClientWidth: main.clientWidth,
    mainScrollWidth: main.scrollWidth,
    overflowOffenders,
  }
})()`

async function scanAx(label) {
  const tree = await cdp.send('Accessibility.getFullAXTree')
  const controlRoles = new Set(['button', 'checkbox', 'combobox', 'radio', 'searchbox', 'slider', 'spinbutton', 'textbox', 'menuitem', 'tab', 'link', 'summary'])
  const unnamedButtons = []
  const unnamedControls = []
  let exposedButtons = 0
  let exposedControls = 0
  for (const node of tree.nodes) {
    if (node.ignored) continue
    const role = node.role?.value || ''
    const name = String(node.name?.value || '').trim()
    if (role === 'button') {
      exposedButtons++
      if (!name) unnamedButtons.push({ backendDOMNodeId: node.backendDOMNodeId, role })
    }
    if (controlRoles.has(role) && role !== 'button') {
      exposedControls++
      if (!name) unnamedControls.push({ backendDOMNodeId: node.backendDOMNodeId, role })
    }
  }
  const item = { label, exposedButtons, exposedControls, unnamedButtons, unnamedControls }
  report.axScans.push(item)
  check('V06-AX-' + label, unnamedButtons.length === 0 && unnamedControls.length === 0, 'CDP AX unnamed buttons=' + unnamedButtons.length + ', controls=' + unnamedControls.length, { exposedButtons, exposedControls })
}

const CONTRAST_SCAN = `(() => {
  const parse = (value) => {
    const text = String(value).trim()
    const hex = text.match(/^#([0-9a-f]{3,8})$/i)
    if (hex) {
      let raw = hex[1]
      if (raw.length === 3 || raw.length === 4) raw = [...raw].map((c) => c + c).join('')
      const int = parseInt(raw, 16)
      return raw.length === 6 ? [int >> 16 & 255, int >> 8 & 255, int & 255, 1] : [int >> 24 & 255, int >> 16 & 255, int >> 8 & 255, int & 255]
    }
    const nums = text.match(/[-+]?\\d*\\.?\\d+(?:e[-+]?\\d+)?/gi)?.map(Number)
    if (!nums || nums.length < 3) return [0, 0, 0, 0]
    const srgb = /^color\\(srgb\\s/i.test(text)
    return [nums[0] * (srgb ? 255 : 1), nums[1] * (srgb ? 255 : 1), nums[2] * (srgb ? 255 : 1), nums.length > 3 ? (text.includes('%') && nums[3] <= 1 ? nums[3] * 100 : nums[3]) / (srgb ? 1 : 100) : 1]
  }
  const over = (top, bottom) => {
    const alpha = top[3]
    return [0, 1, 2].map((i) => top[i] * alpha + bottom[i] * (1 - alpha)).concat(1)
  }
  const background = (el) => {
    const chain = []
    for (let node = el; node; node = node.parentElement) chain.push(parse(getComputedStyle(node).backgroundColor))
    return chain.reduceRight((bottom, top) => over(top, bottom), [255, 255, 255, 1])
  }
  const renderedPair = (el) => {
    const nodes = []
    let opacity = 1
    for (let node = el; node; node = node.parentElement) {
      opacity *= Number(getComputedStyle(node).opacity)
      nodes.push({ color: parse(getComputedStyle(node).backgroundColor), opacity })
    }
    const backdrop = nodes.reduceRight((bottom, item) => over([...item.color.slice(0, 3), item.color[3] * item.opacity], bottom), [255, 255, 255, 1])
    const ownOpacity = nodes[0]?.opacity || 1
    const fg = parse(getComputedStyle(el).color)
    return { foreground: over([...fg.slice(0, 3), fg[3] * ownOpacity], backdrop), background: backdrop }
  }
  const luminance = (rgb) => {
    const linear = rgb.slice(0, 3).map((value) => {
      const channel = value / 255
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    })
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
  }
  const ratio = (foreground, backdrop) => {
    const a = luminance(foreground)
    const b = luminance(backdrop)
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  }
  const hex = (rgb) => '#' + rgb.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase()
  const rootStyle = getComputedStyle(document.documentElement)
  const panel = document.querySelector('.panel')
  const primary = document.querySelector('.button.primary')
  const secondary = document.querySelector('.button.ghost')
  const search = document.querySelector('.search')
  const heading = document.querySelector('h1')
  const muted = document.querySelector('.muted')
  const link = document.querySelector('tbody a') || document.querySelector('.page a') || muted
  const bodyBg = background(document.body)
  const panelBg = background(panel)
  const primaryBg = background(primary)
  const secondaryBg = background(secondary)
  const searchBg = background(search)
  const accent = parse(rootStyle.getPropertyValue('--accent'))
  const divider = parse(rootStyle.getPropertyValue('--divider'))
  const pairs = []
  const add = (id, label, fg, bg, threshold, kind) => pairs.push({ id, label, foreground: hex(fg), background: hex(bg), ratio: Number(ratio(fg, bg).toFixed(2)), threshold, kind })
  add('body-text', 'Body primary text / workspace', parse(getComputedStyle(document.body).color), bodyBg, 4.5, 'text')
  add('muted-text', 'Muted text / panel', parse(getComputedStyle(muted).color), panelBg, 4.5, 'text')
  add('primary-button-text', 'Primary button text / primary background', parse(getComputedStyle(primary).color), primaryBg, 4.5, 'text')
  add('secondary-button-text', 'Secondary button text / control background', parse(getComputedStyle(secondary).color), secondaryBg, 4.5, 'text')
  add('input-text', 'Search input text / control background', parse(getComputedStyle(search).color), searchBg, 4.5, 'text')
  add('link-text', 'Link text / panel', parse(getComputedStyle(link).color), panelBg, 4.5, 'text')
  add('heading-text', 'Large heading text / workspace', parse(getComputedStyle(heading).color), bodyBg, 3, 'large-text')
  add('focus-indicator', 'Focus indicator / panel', accent, panelBg, 3, 'non-text')
  add('primary-control-boundary', 'Primary control border / adjacent background', parse(getComputedStyle(primary).borderTopColor), background(primary.parentElement), 3, 'non-text')
  add('control-boundary', 'Secondary control border / adjacent background', parse(getComputedStyle(secondary).borderTopColor), background(secondary.parentElement), 3, 'non-text')
  add('input-boundary', 'Input border / adjacent panel', parse(getComputedStyle(search).borderTopColor), panelBg, 3, 'non-text')
  const controls = [...document.querySelectorAll('.button, .icon-button, input, select, textarea')].filter((el) => {
    const style = getComputedStyle(el)
    const rect = el.getBoundingClientRect()
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
  }).sort((a, b) => Number(b.disabled || b.getAttribute('aria-disabled') === 'true') - Number(a.disabled || a.getAttribute('aria-disabled') === 'true')).slice(0, 24).map((el, index) => {
    const style = getComputedStyle(el)
    const colors = renderedPair(el)
    const state = el.disabled || el.getAttribute('aria-disabled') === 'true' ? 'disabled' : el.matches(':hover') ? 'hover' : el.matches(':focus') ? 'focus' : el.matches(':active') ? 'active' : 'default'
    const threshold = state === 'disabled' ? 3 : 4.5
    return {
      index,
      state,
      tag: el.tagName.toLowerCase(),
      label: (el.getAttribute('aria-label') || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
      disabled: !!el.disabled,
      ariaDisabled: el.getAttribute('aria-disabled'),
      ariaBusy: el.getAttribute('aria-busy'),
      foreground: hex(colors.foreground),
      background: hex(colors.background),
      opacity: style.opacity,
      ratio: Number(ratio(colors.foreground, colors.background).toFixed(2)),
      threshold,
      note: state === 'disabled' ? '3:1 product floor; WCAG 1.4.3 exempts inactive controls' : undefined,
    }
  })
  void divider
  return { theme: document.documentElement.dataset.theme, width: innerWidth, pairs, controls }
})()`

async function main() {
  const bin = findChrome()
  if (!bin) throw new NotRunError('NOT_RUN_BROWSER: no existing Chrome executable; installation is not authorized')
  let binaryVersion = 'unknown'
  try { binaryVersion = execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim() } catch {}
  report.resourcePreflight.chrome = { binary: bin, version: binaryVersion, localState: 'EXISTS', reused: true }

  const debugPort = await freePort()
  profile = mkdtempSync(join(tmpdir(), 'mg-v05-v06-chrome-'))
  browser = spawn(bin, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-background-networking',
    '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=' + debugPort,
    '--remote-allow-origins=*', '--user-data-dir=' + profile, '--window-size=1440,900', 'about:blank',
  ], { stdio: 'ignore' })
  const cdpBase = 'http://127.0.0.1:' + debugPort
  let version = null
  const deadline = Date.now() + budgets.initialRenderMs
  while (Date.now() < deadline && !version) {
    try { const response = await fetch(cdpBase + '/json/version'); if (response.ok) version = await response.json() } catch {}
    if (!version) await sleep(100)
  }
  if (!version) throw new NotRunError('NOT_RUN_BROWSER: existing Chrome did not expose a working CDP endpoint')
  report.chrome = { browser: version.Browser, protocol: version['Protocol-Version'], debugPort }

  const gatewayStarted = performance.now()
  upstream = await startMockUpstream()
  codexHome = mkdtempSync(join(tmpdir(), 'mg-v05-v06-codex-'))
  harnessHome = mkdtempSync(join(tmpdir(), 'mg-v05-v06-harness-'))
  gateway = await startGateway({
    name: 'v05-v06-quality',
    env: { MG_BUILD_SHA: report.headSha, CODEX_HOME: codexHome, MG_HARNESS_ROOT: harnessHome },
    config: buildFixture(upstream.base),
  })
  report.timings.gatewayStartMs = Number((performance.now() - gatewayStarted).toFixed(2))
  check('V05-GATEWAY-START-TIMING', report.timings.gatewayStartMs <= budgets.gatewayStartMs, 'isolated gateway start within ' + budgets.gatewayStartMs + 'ms', report.timings.gatewayStartMs)
  await verifyFixture()

  const target = await (await fetch(cdpBase + '/json/new?' + encodeURIComponent('about:blank'), { method: 'PUT' })).json()
  cdp = await connect(target.webSocketDebuggerUrl)
  for (const domain of ['Runtime.enable', 'Page.enable', 'Log.enable', 'Network.enable', 'Accessibility.enable', 'Performance.enable']) await cdp.send(domain)
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    globalThis.__mgQualityLongTasks = []
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) globalThis.__mgQualityLongTasks.push({ start: Math.round(entry.startTime), duration: Math.round(entry.duration * 100) / 100 })
      }).observe({ type: 'longtask', buffered: true })
    } catch {}
  ` })
  const ev = async (expression) => {
    const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result.value
  }
  const settle = () => ev('new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)))')
  const waitFor = async (expression, label, timeoutMs = budgets.initialRenderMs) => {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      try { if (await ev(expression)) return } catch {}
      await sleep(50)
    }
    throw new Error('wait timeout: ' + label)
  }
  const key = async (name, code, keyCode, modifiers = 0, text = '') => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, text, unmodifiedText: text, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, text, unmodifiedText: text, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers })
    await settle()
  }
  const enter = () => key('Enter', 'Enter', 13, 0, '\r')
  const escape = () => key('Escape', 'Escape', 27)
  const tab = (shift = false) => key('Tab', 'Tab', 9, shift ? 8 : 0)
  const screenshot = async (name) => {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const file = join(outDir, name + '.png')
    writeFileSync(file, Buffer.from(shot.data, 'base64'))
    report.screenshots.push(relative(root, file))
  }
  const navigate = async (hash, expectedH1, label) => {
    const started = performance.now()
    try {
      const measured = await ev(`new Promise((resolve, reject) => {
        const hash = ${JSON.stringify(hash)}
        const expectedH1 = ${JSON.stringify(expectedH1)}
        const started = performance.now()
        if (location.hash !== hash) location.hash = hash
        const poll = () => {
          const h1 = document.querySelector('#main h1')?.textContent || ''
          if (location.hash === hash && h1 === expectedH1) {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve({ durationMs: Math.round((performance.now() - started) * 100) / 100, h1 })))
          } else if (performance.now() - started > ${budgets.routeRenderMs}) {
            reject(new Error('route timeout ' + hash + ' expected=' + expectedH1 + ' actual=' + h1))
          } else setTimeout(poll, 16)
        }
        poll()
      })`)
      const wallMs = performance.now() - started
      report.timings.routes.push({ label, hash, viewport: await ev('innerWidth + "x" + innerHeight'), theme: await ev('document.documentElement.dataset.theme'), durationMs: measured.durationMs, wallMs: Number(wallMs.toFixed(2)) })
      return measured
    } catch (error) {
      report.timings.routes.push({ label, hash, durationMs: performance.now() - started, error: error.message })
      return null
    }
  }
  const scanPage = async (label) => {
    const scanned = await ev(PAGE_SCAN)
    report.pageScans.push({ label, ...scanned })
    return scanned
  }
  const reachable = async (selector, label) => {
    const result = await ev(`(() => {
      const selector = ${JSON.stringify(selector)}
      let el = document.querySelector(selector)
      if (!el) return { ok: false, reason: 'missing' }
      el.scrollIntoView({ block: 'center', inline: 'center' })
      el.focus({ preventScroll: true })
      return new Promise((ok) => {
        let frames = 0
        const settle = () => {
          const current = document.querySelector(selector)
          if (!current) { ok({ ok: false, reason: 'missing-after-render' }); return }
          if (current !== el || !current.isConnected) {
            el = current
            el.scrollIntoView({ block: 'center', inline: 'center' })
            el.focus({ preventScroll: true })
            frames = 0
          }
          if (frames++ < 3) { requestAnimationFrame(settle); return }
          const rect = el.getBoundingClientRect()
          const x = rect.left + rect.width / 2
          const y = rect.top + rect.height / 2
          const top = document.elementFromPoint(x, y)
          const inViewport = rect.width > 0 && rect.height > 0 && rect.left >= -1 && rect.right <= innerWidth + 1 && rect.top >= -1 && rect.bottom <= innerHeight + 1
          ok({ ok: inViewport && !!top && (top === el || el.contains(top) || el === top), active: document.activeElement === el, inViewport, hit: top ? top.tagName.toLowerCase() + '.' + String(top.className || '') : null, rect: { left: Math.round(rect.left), right: Math.round(rect.right), top: Math.round(rect.top), bottom: Math.round(rect.bottom) } })
        }
        requestAnimationFrame(settle)
      })
    })()`)
    report.reachability.push({ label, selector, ...result })
    check('V05-REACH-' + label, result.ok, result.reason || 'control visible and topmost at viewport center', result.rect)
    return result
  }
  const wheel = async (selector, label, deltas = 4) => {
    const started = performance.now()
    await ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('missing scroll target'); el.scrollTop = 0 })()`)
    for (let i = 0; i < deltas; i++) {
      const point = await ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('missing scroll target'); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 120) } })()`)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: 900 })
      await settle()
      if (await ev(`document.querySelector(${JSON.stringify(selector)})?.scrollTop > 0`)) break
    }
    try { await waitFor('document.querySelector(' + JSON.stringify(selector) + ').scrollTop > 0', 'wheel ' + label, budgets.scrollMs) } catch {}
    const result = await ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); const th = el.querySelector('th'); const wrapRect = el.getBoundingClientRect(); const thRect = th?.getBoundingClientRect(); return { scrollTop: Math.round(el.scrollTop), scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, stickyHeader: th ? getComputedStyle(th).position : null, headerOffset: thRect ? Math.round(thRect.top - wrapRect.top) : null } })()`)
    result.elapsedMs = Number((performance.now() - started).toFixed(2))
    report.scrolling.push({ label, selector, ...result })
    check('V05-SCROLL-' + label, result.scrollTop > 0 && result.elapsedMs <= budgets.scrollMs && (result.stickyHeader !== 'sticky' || Math.abs(result.headerOffset) <= 2), 'scrollTop=' + result.scrollTop + ', elapsed=' + result.elapsedMs + 'ms', result)
  }
  const dialogGeometry = async (label) => {
    const geometry = await ev(`(() => { const dialog = document.querySelector('dialog[open]'); const rect = dialog.getBoundingClientRect(); const footer = dialog.querySelector('.dialog-footer')?.getBoundingClientRect(); return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), left: Math.round(rect.left), right: Math.round(rect.right), footerBottom: footer ? Math.round(footer.bottom) : null, viewportWidth: innerWidth, viewportHeight: innerHeight, documentWidth: document.documentElement.scrollWidth, mainScrollWidth: document.getElementById('main').scrollWidth, mainClientWidth: document.getElementById('main').clientWidth } })()`)
    const ok = geometry.top >= 0 && geometry.bottom <= geometry.viewportHeight + 1 && geometry.left >= 0 && geometry.right <= geometry.viewportWidth + 1 && geometry.footerBottom <= geometry.viewportHeight + 1 && geometry.documentWidth <= geometry.viewportWidth + 1 && geometry.mainScrollWidth <= geometry.mainClientWidth + 1
    report.dialogs.push({ label, ok, ...geometry })
    check('V05-DIALOG-GEOMETRY-' + label, ok, 'dialog and sticky footer fit viewport without page/main horizontal overflow', geometry)
    return ok
  }
  const trapAndRestore = async (label) => {
    const before = await ev(`(() => { const dialog = document.querySelector('dialog[open]'); const focusable = [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')].filter((el) => !el.hidden && el.getClientRects().length); return { count: focusable.length, opener: globalThis.__qualityOpener === document.activeElement, activeInside: dialog.contains(document.activeElement) } })()`)
    await ev(`(() => document.querySelector('dialog[open]').querySelector('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]').focus())()`)
    await tab(true)
    const atLast = await ev(`(() => { const dialog = document.querySelector('dialog[open]'); const focusable = [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')].filter((el) => !el.hidden && el.getClientRects().length); return document.activeElement === focusable.at(-1) })()`)
    await tab()
    const atFirst = await ev(`(() => { const dialog = document.querySelector('dialog[open]'); const focusable = [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')].filter((el) => !el.hidden && el.getClientRects().length); return document.activeElement === focusable[0] })()`)
    let inside = true
    for (let i = 0; i < Math.min(8, before.count + 1); i++) { await tab(); inside = inside && await ev(`document.querySelector('dialog[open]')?.contains(document.activeElement)`) }
    await escape()
    await waitFor('!document.querySelector("dialog[open]")', 'close ' + label, budgets.interactionMs)
    const restored = await ev('globalThis.__qualityOpener === document.activeElement && globalThis.__qualityOpener?.isConnected')
    const item = { label, ...before, shiftTabWrappedToLast: atLast, tabWrappedToFirst: atFirst, stayedInside: inside, restored }
    report.dialogs.push(item)
    check('V06-DIALOG-TRAP-' + label, before.activeInside && atLast && atFirst && inside, 'Tab and Shift+Tab remain inside modal', item)
    check('V06-DIALOG-RESTORE-' + label, restored, 'Escape restores focus to opener', { restored })
  }
  const measureMotion = async (label) => ev(`(() => {
    function valuesFor(value) { return String(value).split(',').map((v) => (parseFloat(v) || 0) * (String(v).includes('ms') ? 1 : 1000)) }
    const elements = [...document.querySelectorAll('body *')].filter((el) => el.getClientRects().length).map((el) => {
      const style = getComputedStyle(el)
      return { tag: el.tagName.toLowerCase(), class: String(el.className || '').slice(0, 100), animationDurationMs: Math.max(0, ...valuesFor(style.animationDuration)), transitionDurationMs: Math.max(0, ...valuesFor(style.transitionDuration)) }
    }).filter((item) => item.animationDurationMs > 0 || item.transitionDurationMs > 0)
    const spinner = document.createElement('span')
    spinner.className = 'spinner'
    document.body.append(spinner)
    const spinnerStyle = getComputedStyle(spinner)
    const probe = { animationDurationMs: Math.max(0, ...valuesFor(spinnerStyle.animationDuration)), animationName: spinnerStyle.animationName }
    spinner.remove()
    return { label: ${JSON.stringify(label)}, mediaMatches: matchMedia('(prefers-reduced-motion: reduce)').matches, scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior, elementCount: elements.length, maxAnimationDurationMs: Math.max(0, ...elements.map((item) => item.animationDurationMs)), maxTransitionDurationMs: Math.max(0, ...elements.map((item) => item.transitionDurationMs)), animatedElements: elements.slice(0, 12), spinnerProbe: probe }
  })()`)
  const zoomGeometry = () => ev(`(() => {
    const main = document.getElementById('main')
    return { hash: location.hash, theme: document.documentElement.dataset.theme, innerWidth, innerHeight, computedPageScale: Number(getComputedStyle(document.querySelector('.shell')).zoom), visualViewportWidth: visualViewport.width, visualViewportHeight: visualViewport.height, visualViewportScale: visualViewport.scale, visualViewportOffsetLeft: visualViewport.offsetLeft, visualViewportOffsetTop: visualViewport.offsetTop, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, mainClientWidth: main.clientWidth, mainScrollWidth: main.scrollWidth }
  })()`)
  const runIme = async () => {
    await ev('document.querySelector(".shell").style.removeProperty("zoom"); document.querySelector(".shell").style.removeProperty("width")')
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await navigate('#/settings', '设置', 'ime-settings')
    await ev(`(() => {
      const input = document.querySelector('input[aria-label="搜索诊断日志"]')
      input.value = ''
      globalThis.__mgImeEvents = []
      globalThis.__mgImeInputEvents = []
      for (const type of ['compositionstart', 'compositionupdate', 'compositionend']) document.addEventListener(type, (event) => {
        if (event.target === input) globalThis.__mgImeEvents.push({ type, data: event.data, value: event.target.value })
      }, true)
      for (const type of ['beforeinput', 'input']) document.addEventListener(type, (event) => {
        if (event.target === input) globalThis.__mgImeInputEvents.push({ type, inputType: event.inputType, data: event.data, isComposing: event.isComposing, isComposingType: typeof event.isComposing, value: event.target.value })
      }, true)
    })()`)
    await settle()
    const imePoint = await ev(`(() => { const input = document.querySelector('input[aria-label="搜索诊断日志"]'); input.scrollIntoView({ block: 'center' }); const rect = input.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } })()`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...imePoint, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...imePoint, button: 'left', clickCount: 1 })
    await settle()
    await ev('document.querySelector("input[aria-label=\\"搜索诊断日志\\"]").focus()')
    await settle()
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Process', code: 'Process', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 })
    await cdp.send('Input.imeSetComposition', { text: '模', selectionStart: 1, selectionEnd: 1, replacementStart: 0, replacementEnd: 0 })
    await settle()
    await cdp.send('Input.imeSetComposition', { text: 'Fixture IME 42', selectionStart: 15, selectionEnd: 15, replacementStart: 0, replacementEnd: 1 })
    await settle()
    const during = await ev('({ events: globalThis.__mgImeEvents, inputEvents: globalThis.__mgImeInputEvents, isComposing: globalThis.__mgImeInputEvents.filter((event) => event.type === "beforeinput").at(-1)?.isComposing || false, value: globalThis.__mgImeEvents.filter((event) => event.type !== "compositionend").at(-1)?.value || document.querySelector("input[aria-label=\\"搜索诊断日志\\"]").value })')
    await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
    await cdp.send('Input.insertText', { text: 'Fixture IME 42' })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Process', code: 'Process', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 })
    await settle()
    const result = await ev(`(() => ({
      events: globalThis.__mgImeEvents,
      inputEvents: globalThis.__mgImeInputEvents,
      duringIsComposing: ${JSON.stringify(during.isComposing)},
      duringValue: ${JSON.stringify(during.value)},
      finalIsComposing: document.querySelector('input[aria-label="搜索诊断日志"]').isComposing,
      finalValue: document.querySelector('input[aria-label="搜索诊断日志"]').value,
      active: document.activeElement === document.querySelector('input[aria-label="搜索诊断日志"]'),
      filteredRows: document.querySelectorAll('tbody tr').length,
      filteredText: document.querySelector('tbody')?.textContent || ''
    }))()`)
    result.method = 'CDP Input.imeSetComposition (start/update/end) + Input.insertText (commit) on real diagnostics text input'
    report.ime = result
    const types = result.events.map((event) => event.type)
    check('V06-IME-EVENTS', types.includes('compositionstart') && types.includes('compositionupdate') && types.includes('compositionend') && types.indexOf('compositionstart') < types.indexOf('compositionupdate') && types.indexOf('compositionupdate') < types.indexOf('compositionend'), 'real CDP IME emits compositionstart/update/end in order', result.events)
    check('V06-IME-FLAGS', result.inputEvents.some((event) => event.type === 'beforeinput' && event.isComposing === true) && result.inputEvents.some((event) => event.type === 'beforeinput' && event.isComposing === false), 'InputEvent.isComposing true during composition and false after commit', { during: result.duringIsComposing, final: result.finalIsComposing, inputEvents: result.inputEvents })
    check('V06-IME-COMMIT-ACTION', result.finalValue === 'Fixture IME 42' && result.active, 'committed IME text remains in the focused real text input', { finalValue: result.finalValue, active: result.active })
    await tab()
    await enter()
    await waitFor('document.querySelector("#main tbody") || document.querySelector("#main")?.textContent.includes("尚无日志")', 'IME diagnostics query action', budgets.interactionMs).catch(() => {})
    const imeAction = await ev('({ activeTag: document.activeElement.tagName, activeText: document.activeElement.textContent.trim(), hasQueryAction: [...document.querySelectorAll("#main .button")].some((el) => el.textContent.trim() === "查询"), tableOrEmpty: !!document.querySelector("#main tbody") || document.querySelector("#main")?.textContent.includes("尚无日志") })')
    check('V06-IME-USABLE-ACTION', imeAction.hasQueryAction && imeAction.tableOrEmpty, 'committed input retains a usable diagnostics query action', imeAction)
    await ev('document.querySelector("input[aria-label=\\"搜索诊断日志\\"]").value = ""')
  }

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 266, height: 720, deviceScaleFactor: 1, mobile: false })
  const initialStarted = performance.now()
  await cdp.send('Page.navigate', { url: gateway.base + '/ui-vnext/' })
  await waitFor('document.readyState === "complete" && document.querySelector("#main h1") && !["loading", ""].includes(document.getElementById("gateway-state").dataset.state)', 'initial large-fixture render')
  report.timings.initial = Number((performance.now() - initialStarted).toFixed(2))
  check('V05-INITIAL-RENDER-TIMING', report.timings.initial <= budgets.initialRenderMs, 'initial render within ' + budgets.initialRenderMs + 'ms', report.timings.initial)

  const states = [
    { id: 'harness', hash: '#/harness', h1: '应用接入' },
    { id: 'services', hash: '#/services', h1: '模型服务' },
    { id: 'serviceDetail', hash: '#/service-detail?service=fixture-provider-000', h1: 'Fixture Service 001' },
    { id: 'accountDetail', hash: '#/account-detail?service=fixture-provider-000&connection=conn_fixture_account_001', h1: 'Fixture Account 01' },
    { id: 'serviceModels', hash: '#/service-models?service=fixture-provider-000', h1: '服务模型' },
    { id: 'pools', hash: '#/pools', h1: '模型池' },
    { id: 'poolStrategy', hash: '#/pool-strategy', h1: '模型池' },
    { id: 'poolApps', hash: '#/pool-apps', h1: '模型池' },
    { id: 'poolTest', hash: '#/pool-test', h1: '模型池' },
    { id: 'usage', hash: '#/usage', h1: '用量分析' },
    { id: 'reliability', hash: '#/reliability', h1: '稳定性策略' },
    { id: 'reliabilityDetail', hash: '#/reliability-detail', h1: '稳定性详细' },
    { id: 'settings', hash: '#/settings', h1: '设置' },
    { id: 'models', hash: '#/models', h1: '高级模型目录' },
    { id: 'routing', hash: '#/routing', h1: '手动路由' },
    { id: 'clients', hash: '#/clients', h1: 'API 与密钥' },
    { id: 'logs', hash: '#/logs', h1: '请求日志' },
  ]
  const axStates = new Set(['harness', 'services', 'serviceDetail', 'serviceModels', 'pools', 'settings', 'models', 'clients'])
  for (const theme of themes) {
    for (const [width, height] of viewports) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
      await ev('document.documentElement.dataset.theme = ' + JSON.stringify(theme))
      for (const state of states) {
        const label = state.id + '-' + theme + '-' + width + 'x' + height
        const timing = await navigate(state.hash, state.h1, label)
        await settle()
        const geometry = await ev('({ hash: location.hash, h1: document.querySelector("#main h1")?.textContent, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, viewportWidth: innerWidth, viewportHeight: innerHeight, mainClientWidth: document.getElementById("main").clientWidth, mainScrollWidth: document.getElementById("main").scrollWidth })')
        const ok = !!timing && geometry.documentWidth <= geometry.viewportWidth + 1 && geometry.bodyWidth <= geometry.viewportWidth + 1 && geometry.mainScrollWidth <= geometry.mainClientWidth + 1 && geometry.h1 === state.h1
        const scan = theme === 'dark' ? await scanPage(label) : null
        if (scan) geometry.overflowOffenders = scan.overflowOffenders
        report.viewports.push({ theme, width, height, state: state.id, ok, ...geometry })
        if (theme === 'dark' && axStates.has(state.id)) await scanAx(label)
      }
    }
  }
  const badViewports = report.viewports.filter((item) => !item.ok)
  check('V05-OVERFLOW', badViewports.length === 0, 'no document/body/main horizontal overflow in ' + report.viewports.length + ' large-fixture route/theme/viewport combinations', { combinations: report.viewports.length, failures: badViewports.length })
  const routeTimings = report.timings.routes.filter((item) => !item.error)
  const maxRouteMs = Math.max(0, ...routeTimings.map((item) => item.durationMs))
  check('V05-ROUTE-TIMING', routeTimings.length === report.viewports.length && report.timings.routes.every((item) => !item.error && item.durationMs <= budgets.routeRenderMs), 'all measured route renders within ' + budgets.routeRenderMs + 'ms', { measured: routeTimings.length, maxMs: maxRouteMs })

  const allScans = report.pageScans
  check('V06-BUTTON-NAMES', allScans.every((item) => item.unnamedButtons.length === 0), 'no unnamed buttons across ' + allScans.length + ' page scans', allScans.reduce((sum, item) => sum + item.unnamedButtons.length, 0))
  check('V06-CONTROL-NAMES', allScans.every((item) => item.unnamedControls.length === 0), 'every form control has a label/name across ' + allScans.length + ' page scans', allScans.reduce((sum, item) => sum + item.unnamedControls.length, 0))
  check('V06-ONE-H1', allScans.every((item) => item.h1Count === 1), 'exactly one h1 on every scanned page', allScans.filter((item) => item.h1Count !== 1).length)
  check('V06-NO-DUPLICATE-IDS', allScans.every((item) => item.duplicateIds.length === 0), 'no duplicate IDs across ' + allScans.length + ' page scans', allScans.reduce((sum, item) => sum + item.duplicateIds.length, 0))
  check('V06-ARIA-REFERENCES', allScans.every((item) => item.brokenAriaRefs.length === 0), 'all aria-labelledby/describedby/controls references resolve', allScans.reduce((sum, item) => sum + item.brokenAriaRefs.length, 0))

  for (const [width, height] of viewports) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    await ev('document.documentElement.dataset.theme = "dark"')
    await navigate('#/services', '模型服务', 'reach-services-' + width)
    const serviceRows = await ev('document.querySelectorAll("tbody tr").length')
    check('V05-SERVICE-ROWS-' + width, serviceRows === fixtureScale.services, 'rendered service rows=' + serviceRows, serviceRows)
    await reachable('tbody tr:last-child button', 'service-last-' + width)
    if (width === 266) {
      const searchStarted = performance.now()
      await ev(`(() => { const input = document.querySelector('input[type="search"]'); input.value = 'Fixture Service 100'; input.dispatchEvent(new Event('input', { bubbles: true })) })()`)
      await settle()
      const filtered = await ev('({ rows: document.querySelectorAll("tbody tr").length, text: document.querySelector("tbody")?.textContent || "" })')
      const elapsedMs = performance.now() - searchStarted
      report.timings.interactions.push({ id: 'service-search', elapsedMs: Number(elapsedMs.toFixed(2)) })
      check('V05-SEARCH', filtered.rows === 1 && filtered.text.includes('Fixture Service 100') && elapsedMs <= budgets.interactionMs, '100 services filter to one within ' + budgets.interactionMs + 'ms', { rows: filtered.rows, elapsedMs: Number(elapsedMs.toFixed(2)) })
      await ev(`(() => { const input = document.querySelector('input[type="search"]'); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })) })()`)
      await settle()
      await wheel('.table-wrap', 'services-' + width)
    }

    await navigate('#/service-detail?service=fixture-provider-000', 'Fixture Service 001', 'reach-connections-' + width)
    const connectionRows = await ev('document.querySelectorAll("tbody tr").length')
    check('V05-CONNECTION-ROWS-' + width, connectionRows === fixtureScale.connections, 'rendered connection rows=' + connectionRows, connectionRows)
    await reachable('tbody tr:last-child a', 'connection-last-' + width)

    await navigate('#/models', '高级模型目录', 'reach-models-' + width)
    const modelRows = await ev('document.querySelectorAll("tbody tr").length')
    check('V05-MODEL-ROWS-' + width, modelRows === fixtureScale.models, 'rendered model rows=' + modelRows, modelRows)
    await reachable('tbody tr:last-child button', 'model-last-' + width)
    if (width === 266) await wheel('.table-wrap', 'models-' + width)

    await navigate('#/pools', '模型池', 'reach-pools-' + width)
    const poolCount = await ev('document.querySelectorAll(".pool-item").length')
    const candidateRows = await ev('document.querySelectorAll("tbody tr").length')
    check('V05-POOL-ROWS-' + width, poolCount === fixtureScale.pools && candidateRows === fixtureScale.candidatesPerPool, 'pool buttons=' + poolCount + ', selected candidate rows=' + candidateRows, { poolCount, candidateRows })
    if (width === 266) await wheel('.pool-list', 'pools-' + width)
    await ev(`(() => { const el = document.querySelector('.pool-item:last-child'); globalThis.__qualityPoolOpener = el; el.focus() })()`)
    await enter()
    let poolSelected = false
    try {
      await waitFor('document.querySelector(".pool-item:last-child")?.getAttribute("aria-pressed") === "true"', 'select last pool', budgets.interactionMs)
      poolSelected = true
    } catch (error) {
      report.poolSelectionFailure = error.message
    }
    check('V05-POOL-SELECTION-' + width, poolSelected, 'last of 31 pools remains selected after scroll/keyboard activation')
    await reachable('.pool-item:last-child', 'pool-last-' + width)
  }

  await runIme()
  for (const theme of themes) {
    for (const [width, height] of viewports) {
      for (const scale of pageScales) {
        const label = theme + '-' + width + 'x' + height + '-' + Math.round(scale * 100) + 'pct'
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
        await ev('document.querySelector(".shell").style.zoom = ' + JSON.stringify(scale) + '; document.querySelector(".shell").style.width = ' + JSON.stringify((scale < 1 ? 100 : 100 / scale) + '%') + '; document.documentElement.dataset.theme = ' + JSON.stringify(theme) + '; location.hash = "#/services"')
        await waitFor('document.querySelector("#main h1")?.textContent === "模型服务"', 'page scale ' + label)
        await settle()
        const geometry = await zoomGeometry()
        const noOverflow = geometry.documentWidth <= geometry.innerWidth + 1 && geometry.bodyWidth <= geometry.innerWidth + 1 && geometry.mainScrollWidth <= geometry.mainClientWidth + 1
        const focus = await reachable('input[type="search"]', 'scale-search-' + label)
        const actionGeometry = await ev(`(() => { const el = [...document.querySelectorAll('.page-header .button')].find((button) => button.textContent.includes('添加服务')); if (!el) return null; el.scrollIntoView({ block: 'center', inline: 'center' }); const rect = el.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, text: el.textContent.trim() } })()`)
        let dialogOpened = false
        if (actionGeometry && focus.ok) {
          await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...actionGeometry, button: 'left', clickCount: 1 })
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...actionGeometry, button: 'left', clickCount: 1 })
          try { await waitFor('document.querySelector("dialog[open]")', 'scaled dialog ' + label, budgets.interactionMs); dialogOpened = true } catch {}
          if (dialogOpened) {
            await reachable('dialog[open] .button', 'scale-dialog-action-' + label)
            await escape()
            await waitFor('!document.querySelector("dialog[open]")', 'close scaled dialog ' + label, budgets.interactionMs)
          }
        }
        const item = { label, theme, width, height, requestedScale: scale, noOverflow, focusedSearch: focus.ok, action: actionGeometry?.text || null, dialogOpened, ...geometry }
        report.pageScales.push(item)
        check('V05-PAGE-SCALE-' + label, noOverflow && Math.abs(geometry.computedPageScale - scale) < 0.01 && focus.ok && dialogOpened, 'computed CSS page scale measured; no layout overflow, search focus and real pointer dialog action usable', item)
      }
    }
  }
  check('V05-PAGE-SCALE-MATRIX', report.pageScales.length === pageScales.length * themes.length * viewports.length && report.pageScales.every((item) => item.noOverflow && item.focusedSearch && item.dialogOpened), 'all 80/100/125/150% scales, themes and viewports remain overflow-free and actionable', report.pageScales.length)
  await ev('document.querySelector(".shell").style.removeProperty("zoom"); document.querySelector(".shell").style.removeProperty("width")')

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 266, height: 720, deviceScaleFactor: 1, mobile: false })
  await ev('document.documentElement.dataset.theme = "dark"; location.hash = "#/harness"')
  await waitFor('document.querySelector("#main h1")?.textContent === "应用接入"', 'keyboard harness')
  await ev('document.activeElement?.blur()')
  for (let i = 0; i < 12; i++) {
    await tab()
    report.focus.push(await ev(`(() => { const el = document.activeElement; const style = getComputedStyle(el); const rect = el.getBoundingClientRect(); return { index: ${i}, tag: el.tagName.toLowerCase(), id: el.id || undefined, class: el.className || undefined, text: (el.getAttribute('aria-label') || el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 100), focusVisible: el.matches(':focus-visible'), outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, inViewport: rect.top >= 0 && rect.bottom <= innerHeight + 1 } })()`))
  }
  check('V06-KEYBOARD-NAV', report.focus.length === 12 && new Set(report.focus.map((item) => item.tag + ':' + item.text)).size >= 8, '12 real Tab key events reach at least 8 distinct controls', report.focus)
  const focusableTargets = report.focus.filter((item) => !['body', 'html'].includes(item.tag))
  const invisibleFocus = focusableTargets.filter((item) => !item.focusVisible || item.outlineStyle === 'none' || parseFloat(item.outlineWidth) < 2)
  check('V06-FOCUS-VISIBLE', focusableTargets.length >= 10 && invisibleFocus.length === 0, 'every keyboard-focused control has a visible outline of at least 2px', invisibleFocus)

  await navigate('#/services', '模型服务', 'dialog-service')
  await ev(`(() => { const opener = [...document.querySelectorAll('.page-header button')].find((el) => el.textContent.includes('添加服务')); globalThis.__qualityOpener = opener; opener.focus() })()`)
  const serviceDialogStarted = performance.now()
  await enter()
  await waitFor('document.querySelector("dialog[open]")', 'service dialog', budgets.interactionMs)
  report.timings.interactions.push({ id: 'service-dialog-open', elapsedMs: Number((performance.now() - serviceDialogStarted).toFixed(2)) })
  await dialogGeometry('service-create-266')
  await scanPage('dialog-service-create-266')
  await trapAndRestore('service-create-266')

  await navigate('#/service-detail?service=fixture-provider-000', 'Fixture Service 001', 'dialog-connections')
  await ev(`(() => { const opener = [...document.querySelectorAll('button')].find((el) => el.textContent === '管理连接'); globalThis.__qualityOpener = opener; opener.focus() })()`)
  await enter()
  await waitFor('document.querySelector("dialog[open]")', 'connection manager', budgets.interactionMs)
  const accountCards = await ev('document.querySelectorAll("dialog[open] article").length')
  check('V05-CONNECTION-DIALOG', accountCards === fixtureScale.connections, 'connection manager renders all 40 accounts', accountCards)
  await dialogGeometry('connection-manager-266')
  await escape()
  await waitFor('!document.querySelector("dialog[open]")', 'close connection manager', budgets.interactionMs)

  await navigate('#/pools', '模型池', 'dialog-pool')
  await ev(`(() => { const opener = [...document.querySelectorAll('button')].find((el) => el.textContent === '编辑'); globalThis.__qualityOpener = opener; opener.focus() })()`)
  const poolDialogStarted = performance.now()
  await enter()
  await waitFor('document.querySelector("dialog[open]")', 'pool dialog', budgets.interactionMs)
  report.timings.interactions.push({ id: 'pool-dialog-open', elapsedMs: Number((performance.now() - poolDialogStarted).toFixed(2)) })
  const poolControlContrast = await ev(CONTRAST_SCAN)
  report.controlStates.push(...poolControlContrast.controls.map((control) => ({ theme: poolControlContrast.theme, width: 266, route: 'pool-dialog', ...control })))
  const candidateChoices = await ev('document.querySelectorAll("dialog[open] .candidate-choice").length')
  check('V05-CANDIDATE-DIALOG', candidateChoices === fixtureScale.models, 'pool editor renders all 1,000 selectable models; selected pool has 48 members', candidateChoices)
  await dialogGeometry('pool-edit-266')
  await reachable('dialog[open] .candidate-choice:last-child input[type="number"]:last-child', 'pool-candidate-last-266')
  await screenshot('v05-v06-pool-dialog-266-dark')
  await trapAndRestore('pool-edit-266')

  for (const theme of themes) {
    for (const [width, height] of viewports) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
      await ev('document.documentElement.dataset.theme = ' + JSON.stringify(theme) + '; location.hash = "#/services"')
      await waitFor('document.querySelector("#main h1")?.textContent === "模型服务"', 'contrast services')
      await settle()
      await sleep(200)
      const result = await ev(CONTRAST_SCAN)
      report.contrast.push(result)
      for (const pair of result.pairs) {
        check('V06-CONTRAST-' + pair.id + '-' + theme + '-' + width, pair.ratio >= pair.threshold, pair.label + ' ratio=' + pair.ratio + ':1 threshold=' + pair.threshold + ':1', pair)
      }
      report.controlStates.push(...result.controls.map((control) => ({ theme, width, route: 'services', ...control })))
    }
  }
  for (const theme of themes) {
    await ev('document.documentElement.dataset.theme = ' + JSON.stringify(theme) + '; location.hash = "#/settings"')
    await waitFor('document.querySelector("#main h1")?.textContent === "设置"', 'control states ' + theme)
    await settle()
    await ev('(() => { const el = document.querySelector("#main .button"); globalThis.__mgDisabledControl = el; globalThis.__mgDisabledWas = el.disabled; el.disabled = true })()')
    await settle()
    const disabledContrast = await ev(CONTRAST_SCAN)
    report.controlStates.push(...disabledContrast.controls.filter((control) => control.state === 'disabled').map((control) => ({ theme, width: viewports.at(-1)[0], route: 'settings-disabled', ...control })))
    await ev('globalThis.__mgDisabledControl.disabled = globalThis.__mgDisabledWas')
    await ev('document.querySelector("#main input:not(:disabled), #main select:not(:disabled), #main .button:not(:disabled)")?.focus()')
    await settle()
    const states = await ev(`(() => [...document.querySelectorAll('.button, .icon-button, input, select, textarea')].filter((el) => el.getClientRects().length && (el.disabled || el.getAttribute('aria-disabled') === 'true' || el.matches(':focus') || el.matches(':hover'))).slice(0, 24).map((el) => ({ tag: el.tagName.toLowerCase(), label: (el.getAttribute('aria-label') || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80), disabled: !!el.disabled, ariaDisabled: el.getAttribute('aria-disabled'), focused: el.matches(':focus'), hovered: el.matches(':hover'), outlineStyle: getComputedStyle(el).outlineStyle, outlineWidth: getComputedStyle(el).outlineWidth, borderColor: getComputedStyle(el).borderTopColor, backgroundColor: getComputedStyle(el).backgroundColor })))()`)
    report.controlStates.push(...states.map((state) => ({ theme, width: viewports.at(-1)[0], route: 'settings', ...state })))
    check('V06-CONTROL-STATES-' + theme, states.some((state) => state.focused) && states.every((state) => state.borderColor !== 'rgba(0, 0, 0, 0)' || state.outlineStyle !== 'none'), 'real focused controls expose computed state styling', states)
  }
  const stateContrast = report.controlStates.filter((state) => Number.isFinite(state.ratio))
  const badStateContrast = stateContrast.filter((state) => state.ratio < state.threshold)
  check('V06-CONTROL-STATE-CONTRAST', stateContrast.length > 0 && stateContrast.some((state) => state.state === 'disabled') && badStateContrast.length === 0, 'rendered default/focus/disabled control text meets product thresholds (disabled floor 3:1)', { measured: stateContrast.length, failures: badStateContrast })

  await navigate('#/services', '模型服务', 'reduced-services')
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
  const normalMotion = await measureMotion('services-normal')
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  const reducedServices = await measureMotion('services-reduced')
  await navigate('#/settings', '设置', 'reduced-settings')
  await settle()
  const reducedSettings = await measureMotion('settings-reduced')
  report.reducedMotion = { normal: normalMotion, reduced: [reducedServices, reducedSettings] }
  const motionOk = normalMotion.mediaMatches === false && normalMotion.maxTransitionDurationMs > 0 && report.reducedMotion.reduced.every((item) => item.mediaMatches && item.maxAnimationDurationMs <= 0.02 && item.maxTransitionDurationMs <= 0.02 && item.spinnerProbe.animationDurationMs <= 0.02 && item.scrollBehavior === 'auto')
  check('V06-REDUCED-MOTION', motionOk, 'computed durations across rendered services/settings elements and spinner probe reduce to <=0.02ms; normal transitions measured as baseline', report.reducedMotion)

  await cdp.send('Emulation.setEmulatedMedia', { features: [] })
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await ev('document.documentElement.dataset.theme = "light"; location.hash = "#/models"')
  await waitFor('document.querySelector("#main h1")?.textContent === "高级模型目录"', 'models screenshot')
  await screenshot('v05-v06-models-1440-light')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 266, height: 720, deviceScaleFactor: 1, mobile: false })
  await ev('document.documentElement.dataset.theme = "dark"; location.hash = "#/services"')
  await waitFor('document.querySelector("#main h1")?.textContent === "模型服务"', 'services screenshot')
  await screenshot('v05-v06-services-266-dark')

  await sleep(150)
  report.timings.longTasks = await ev('globalThis.__mgQualityLongTasks || []')
  const maxLongTaskMs = Math.max(0, ...report.timings.longTasks.map((item) => item.duration))
  check('V05-LONG-TASKS', maxLongTaskMs <= budgets.longTaskMs, 'maximum observed long task within ' + budgets.longTaskMs + 'ms', { count: report.timings.longTasks.length, maxMs: maxLongTaskMs })
  check('V05-JS-ERRORS', report.errors.length === 0, 'zero uncaught/console JavaScript errors', report.errors.length)
  check('V05-NO-INFERENCE', upstream.hits.length === 0, 'zero upstream requests; fixture UI made no discovery or inference calls', upstream.hits.length)
  check('V05-INTERACTION-TIMING', report.timings.interactions.every((item) => item.elapsedMs <= budgets.interactionMs), 'all measured interactions within ' + budgets.interactionMs + 'ms', report.timings.interactions)
}

try {
  await main()
  report.result = 'PASS'
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
  report.summary = {
    checks: report.checks.length,
    passed: report.checks.filter((item) => item.ok).length,
    failed: report.checks.filter((item) => !item.ok).length,
    viewportCombinations: report.viewports.length,
    pageScans: report.pageScans.length,
    axScans: report.axScans.length,
    jsErrors: report.errors.length,
    networkErrors: report.networkErrors.length,
    httpErrors: report.httpErrors.length,
    maxRouteMs: Math.max(0, ...report.timings.routes.map((item) => item.durationMs || 0)),
    maxLongTaskMs: Math.max(0, ...report.timings.longTasks.map((item) => item.duration)),
    pageScaleCombinations: report.pageScales.length,
    imeEventCount: report.ime?.events.length || 0,
    controlStateSamples: report.controlStates.length,
    humanVisualSignoff: report.manualVisualSignoff.status,
  }
  if (report.result === 'PASS' && report.summary.failed) report.result = 'FAIL'
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  console.log('REPORT ' + report.result + ' ' + relative(root, reportPath))
  if (cdp) cdp.close()
  if (browser && browser.exitCode === null) {
    browser.kill('SIGTERM')
    await Promise.race([once(browser, 'exit'), sleep(3000)])
    if (browser.exitCode === null) browser.kill('SIGKILL')
  }
  if (gateway) await gateway.stop()
  if (upstream) await upstream.stop()
  for (const dir of [profile, codexHome, harnessHome]) if (dir) rmSync(dir, { recursive: true, force: true })
  if (report.result === 'FAIL') process.exitCode = 1
  if (report.result === 'NOT_RUN') process.exitCode = 2
}
