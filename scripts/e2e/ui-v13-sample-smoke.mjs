#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import net from 'node:net'
import { codeFingerprint, root } from '../tree-fingerprint.mjs'
import { startGateway, startMockUpstream } from '../test/offline/harness.mjs'

const outDir = resolve(root, 'docs/evidence/v13.1-r2/browser/sample-smoke')
mkdirSync(outDir, { recursive: true })
const report = {
  contract: 'mg-ui-vnext-sample-smoke/1',
  startedAt: new Date().toISOString(),
  headSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  codeFingerprint: codeFingerprint(),
  boundary: 'real Chrome + isolated HTTP gateway + local mock; no real upstream',
  checks: [],
  routes: [],
  screenshots: [],
  errors: [],
  networkErrors: [],
}
let browser = null
let profile = null
let gateway = null
let upstream = null
let cdp = null

function check(id, ok, detail) {
  report.checks.push({ id, ok: !!ok, detail })
  console.log((ok ? 'PASS ' : 'FAIL ') + id + ' :: ' + detail)
  if (!ok) throw new Error(id + ': ' + detail)
}

function findChrome() {
  for (const bin of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    for (const dir of String(process.env.PATH || '').split(':')) if (dir && existsSync(join(dir, bin))) return join(dir, bin)
  }
  return null
}

async function freePort() {
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await new Promise((ok) => server.once('listening', ok))
  const port = server.address().port
  server.close()
  await new Promise((ok) => server.once('close', ok))
  return port
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  const pending = new Map()
  let id = 0
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      const item = pending.get(msg.id)
      pending.delete(msg.id)
      clearTimeout(item.timer)
      msg.error ? item.reject(new Error(msg.error.message)) : item.resolve(msg.result)
      return
    }
    if (msg.method === 'Runtime.exceptionThrown') report.errors.push(msg.params)
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      if (msg.params.entry.source === 'network') report.networkErrors.push(msg.params.entry)
      else report.errors.push(msg.params.entry)
    }
  })
  await new Promise((ok, fail) => {
    ws.addEventListener('open', ok, { once: true })
    ws.addEventListener('error', fail, { once: true })
  })
  return {
    send(method, params = {}) {
      return new Promise((resolveSend, reject) => {
        const current = ++id
        const timer = setTimeout(() => { pending.delete(current); reject(new Error('CDP timeout: ' + method)) }, 15000)
        pending.set(current, { resolve: resolveSend, reject, timer })
        ws.send(JSON.stringify({ id: current, method, params }))
      })
    },
    close() { ws.close() },
  }
}

async function main() {
  const bin = findChrome()
  if (!bin) throw new Error('NOT_RUN_BROWSER: no existing Chrome; installation is not authorized')
  console.log('SMOKE stage: chrome', bin)
  const port = await freePort()
  profile = mkdtempSync(join(tmpdir(), 'mg-vnext-sample-chrome-'))
  browser = spawn(bin, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=' + port, '--remote-allow-origins=*', '--user-data-dir=' + profile, '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' })
  console.log('SMOKE stage: browser spawned', browser.pid)
  const cdpBase = 'http://127.0.0.1:' + port
  let version = null
  const deadline = Date.now() + 15000
  while (Date.now() < deadline && !version) {
    try { const res = await fetch(cdpBase + '/json/version'); if (res.ok) version = await res.json() } catch {}
    if (!version) await new Promise((ok) => setTimeout(ok, 100))
  }
  if (!version) throw new Error('NOT_RUN_BROWSER: existing Chrome CDP did not start')
  report.chrome = { binary: bin, browser: version.Browser }
  console.log('SMOKE stage: CDP ready')

  upstream = await startMockUpstream()
  console.log('SMOKE stage: mock upstream ready')
  gateway = await startGateway({
    name: 'vnext-sample-smoke',
    env: { MG_BUILD_SHA: report.headSha, CODEX_HOME: mkdtempSync(join(tmpdir(), 'mg-vnext-sample-codex-')) },
    config: {
      providers: { mock: { baseUrl: upstream.base, allowPrivateNetwork: true } },
      models: { demo: { provider: 'mock' }, second: { provider: 'mock' } },
      virtualModels: [{ name: 'daily', directory: [{ model: 'demo' }, { model: 'second', mode: 'onFail' }], maxContext: 8192 }],
    },
  })
  const target = await (await fetch(cdpBase + '/json/new?' + encodeURIComponent(gateway.base + '/ui-vnext/'), { method: 'PUT' })).json()
  console.log('SMOKE stage: gateway ready', gateway.base)
  cdp = await connect(target.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await cdp.send('Log.enable')
  await cdp.send('Network.enable')
  const ev = async (expression) => {
    const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result.value
  }
  const waitFor = async (expression, label) => {
    const end = Date.now() + 15000
    while (Date.now() < end) {
      try { if (await ev(expression)) return } catch {}
      await new Promise((ok) => setTimeout(ok, 100))
    }
    throw new Error('wait timeout: ' + label + ' :: ' + String(await ev('document.body.innerText').catch(() => '')).slice(-2000))
  }
  const screenshot = async (name) => {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const file = join(outDir, name + '.png')
    writeFileSync(file, Buffer.from(shot.data, 'base64'))
    report.screenshots.push(file.slice(root.endsWith('/') ? root.length : root.length + 1))
  }
  const clickText = (selector, text) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find((node) => node.textContent.includes(${JSON.stringify(text)}))?.click()`

  await waitFor('document.readyState === "complete" && document.querySelector("#primary-nav .navbtn") && document.querySelector("h1")', 'initial render')
  console.log('SMOKE stage: initial render ready')
  check('SHELL-01', await ev('document.title') === '应用接入 · ModelGate Desktop V13.1', 'sample title and route title')
  check('SHELL-02', await ev('!!document.querySelector(".shell .side") && !!document.querySelector(".shell .main .top") && !!document.querySelector(".shell .main .content")'), 'sample shell classes')
  check('SHELL-03', await ev('document.querySelectorAll("#primary-nav .navbtn").length') === 6, 'six primary navigation items')
  check('SHELL-04', await ev('document.querySelector("#production-badge").textContent.includes("本地生产")'), 'production badge replaces preview badge')
  const source = await (await fetch(gateway.base + '/ui-vnext/app.js')).text()
  check('SHELL-05', !source.includes('navigateOld'), 'no old frontend navigation action')

  const caps = await (await fetch(gateway.base + '/api/capabilities')).json()
  const service = caps.services.find((item) => item.providerId === 'mock')
  const connectionId = service?.connections?.[0]?.connectionId || ''
  const routes = [
    ['harness', '#/harness'], ['mode', '#/mode'], ['services', '#/services'], ['pools', '#/pools'], ['usage', '#/usage'],
    ['reliability', '#/reliability'], ['settings', '#/settings'], ['service-detail', '#/service-detail?service=mock'],
    ['account-detail', '#/account-detail?service=mock&connection=' + encodeURIComponent(connectionId)],
    ['service-models', '#/service-models?service=mock'], ['pool-strategy', '#/pool-strategy'], ['pool-apps', '#/pool-apps'],
    ['pool-test', '#/pool-test'], ['reliability-detail', '#/reliability-detail'], ['models', '#/models'], ['routing', '#/routing'],
    ['clients', '#/clients'], ['logs', '#/logs'],
  ]
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  const expectedTitles = { harness: '应用接入', mode: 'Codex 接入配置', services: '模型服务', pools: '模型池', usage: '用量分析', reliability: '稳定性策略', settings: '设置', 'service-detail': 'mock', 'account-detail': '连接详情', 'service-models': '服务模型', 'pool-strategy': '模型池', 'pool-apps': '模型池', 'pool-test': '模型池', 'reliability-detail': '稳定性详细', models: '高级模型目录', routing: '手动路由', clients: 'API 与密钥', logs: '请求日志' }
  for (const [id, hash] of routes) {
    await ev('location.hash = ' + JSON.stringify(hash))
    await ev('new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)))')
    const geometry = await ev('({ hash: location.hash, h1: document.querySelector("h1")?.textContent, doc: document.documentElement.scrollWidth, view: innerWidth })')
    const ok = geometry.h1 === expectedTitles[id] && geometry.doc <= geometry.view + 1
    report.routes.push({ id, ok, ...geometry })
    check('ROUTE-' + id, ok, geometry.h1 + ' · ' + geometry.hash)
  }
  await ev('location.hash = "#/pool-test"')
  await waitFor('document.querySelector(".tabs8")?.textContent.includes("模拟测试") && document.querySelector(".pool-body8")?.textContent.includes("无副作用预演")', 'pool test tab')
  check('POOL-01', true, 'pool-test route opens simulation tab')

  await ev('location.hash = "#/services"')
  await waitFor('document.querySelector("h1")?.textContent === "模型服务"', 'services route')
  await ev(clickText('.page-header button', '连接模型服务'))
  await waitFor('document.querySelector("dialog") && document.querySelector("dialog").textContent.includes("连接模型服务")', 'service dialog')
  await screenshot('sample-service-dialog')
  await ev('document.querySelector("dialog .dialog-close").click()')
  check('DIALOG-01', true, 'sample service connection dialog opens')

  await ev('location.hash = "#/routing"')
  await waitFor('document.querySelector("h1")?.textContent === "手动路由"', 'routing route')
  await ev(`(() => { const input = document.querySelector('[aria-label="预演模型名称"]'); input.value = 'daily'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await ev(clickText('button', '生成真实决策'))
  await waitFor('document.body.textContent.includes("上游调用")', 'route preview')
  check('ROUTE-PREVIEW-01', await ev('document.body.textContent.includes("daily")'), 'real same-core route preview')

  await ev('location.hash = "#/settings"')
  await waitFor('document.querySelector("h1")?.textContent === "设置"', 'settings route')
  await ev(clickText('.subnav button', '配置与备份'))
  await waitFor('document.body.textContent.includes("创建脱敏备份")', 'settings backup tab')
  check('SETTINGS-01', true, 'sample settings subnavigation and real backup panel')

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 740, deviceScaleFactor: 1, mobile: false })
  for (const id of ['harness', 'mode', 'services', 'pools', 'settings']) {
    await ev('location.hash = ' + JSON.stringify('#/' + id))
    await ev('new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)))')
    const geometry = await ev('({ doc: document.documentElement.scrollWidth, view: innerWidth, h1: document.querySelector("h1")?.textContent })')
    check('MOBILE-' + id, geometry.doc <= geometry.view + 1 && geometry.h1, geometry.h1 + ' · ' + geometry.doc + '/' + geometry.view)
  }
  await ev('location.hash = "#/harness"')
  await screenshot('sample-harness-360')

  check('ERRORS-01', report.errors.length === 0, 'zero JavaScript errors')
  check('ERRORS-02', report.networkErrors.length === 0, 'zero network errors')
  check('UPSTREAM-01', upstream.hits.length === 0, 'zero upstream inference calls')
  report.ok = report.checks.every((item) => item.ok)
  report.finishedAt = new Date().toISOString()
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2))
}

try {
  await main()
} catch (error) {
  report.ok = false
  report.failure = String(error && error.stack || error)
  report.finishedAt = new Date().toISOString()
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2))
  console.error(report.failure)
  process.exitCode = 1
} finally {
  if (cdp) cdp.close()
  if (browser) browser.kill('SIGTERM')
  if (gateway) await gateway.stop()
  if (upstream) await upstream.stop()
  if (profile) rmSync(profile, { recursive: true, force: true })
}
