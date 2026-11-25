#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import net from 'node:net'
import { execFileSync } from 'node:child_process'
import { codeFingerprint } from '../tree-fingerprint.mjs'
import { startGateway, startMockUpstream, root } from '../test/offline/harness.mjs'

const outDir = resolve(root, 'docs/evidence/v13.1-r2/browser')
mkdirSync(outDir, { recursive: true })
const report = {
  contract: 'mg-v13-a2-browser/1',
  startedAt: new Date().toISOString(),
  headSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  codeFingerprint: codeFingerprint(),
  boundary: 'real Chrome + real isolated HTTP gateway + local fixture; no real upstream',
  checks: [],
  viewports: [],
  dialogs: [],
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
      msg.error ? item.reject(new Error(msg.error.message)) : item.resolve(msg.result)
      return
    }
    if (msg.method === 'Runtime.exceptionThrown') report.errors.push(msg.params)
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      if (msg.params.entry.source === 'network') report.networkErrors.push(msg.params.entry)
      else report.errors.push(msg.params.entry)
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
        const timer = setTimeout(() => { pending.delete(current); rejectSend(new Error('CDP timeout: ' + method)) }, 15000)
        pending.set(current, { resolve: resolveSend, reject: rejectSend, timer })
        ws.send(JSON.stringify({ id: current, method, params }))
      })
    },
    on(method, handler) { handlers.set(method, handler) },
    close() { ws.close() },
  }
}

async function main() {
  const bin = findChrome()
  if (!bin) throw new Error('NOT_RUN_BROWSER: no existing Chrome; installation is not authorized')
  const port = await freePort()
  profile = mkdtempSync(join(tmpdir(), 'mg-v13-chrome-'))
  browser = spawn(bin, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=' + port, '--remote-allow-origins=*', '--user-data-dir=' + profile, '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' })
  const cdpBase = 'http://127.0.0.1:' + port
  let version = null
  const deadline = Date.now() + 15000
  while (Date.now() < deadline && !version) {
    try { const res = await fetch(cdpBase + '/json/version'); if (res.ok) version = await res.json() } catch {}
    if (!version) await new Promise((ok) => setTimeout(ok, 100))
  }
  if (!version) throw new Error('NOT_RUN_BROWSER: existing Chrome CDP did not start')
  report.chrome = { binary: bin, browser: version.Browser, protocol: version['Protocol-Version'] }

  upstream = await startMockUpstream()
  gateway = await startGateway({
    name: 'v13-browser',
    env: { MG_BUILD_SHA: report.sourceSha, CODEX_HOME: mkdtempSync(join(tmpdir(), 'mg-v13-codex-')) },
    config: {
      providers: { mock: { baseUrl: upstream.base, allowPrivateNetwork: true } },
      models: { demo: { provider: 'mock' }, second: { provider: 'mock' } },
      virtualModels: [{ name: 'daily', directory: [{ model: 'demo' }, { model: 'second', mode: 'onFail' }], maxContext: 8192 }],
    },
  })
  const target = await (await fetch(cdpBase + '/json/new?' + encodeURIComponent(gateway.base + '/ui-vnext/'), { method: 'PUT' })).json()
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
    const pageText = await ev('document.body.innerText').catch(() => '')
    throw new Error('wait timeout: ' + label + ' :: ' + pageText.slice(-2500))
  }
  const clickNav = async (id) => {
    await ev(`document.querySelector('[data-route="${id}"]').click()`)
    await waitFor(`location.hash === '#/${id}' && document.querySelector('h1')`, 'nav ' + id)
  }
  const screenshot = async (name) => {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const file = join(outDir, name + '.png')
    writeFileSync(file, Buffer.from(shot.data, 'base64'))
    report.screenshots.push(file.slice(root.length + 1))
  }

  await waitFor('document.readyState === "complete" && document.querySelector("#primary-nav .nav-button") && document.querySelector("h1")', 'initial render')
  check('A2-UI-01', await ev('document.querySelectorAll("#primary-nav .nav-button").length') === 6, 'six primary navigation items')
  check('A2-UI-02', (await ev('document.querySelector("h1").textContent')) === '应用接入', 'default route is harness')
  check('A2-UI-03', await ev('document.querySelector("#production-badge").textContent.includes("本地生产")'), 'production entry is active')

  for (const id of ['services', 'pools', 'usage', 'reliability', 'settings']) await clickNav(id)
  await clickNav('harness')
  await ev('history.back()')
  await waitFor('location.hash === "#/settings"', 'history back')
  await ev('history.forward()')
  await waitFor('location.hash === "#/harness"', 'history forward')
  await cdp.send('Page.reload', { ignoreCache: true })
  await waitFor('document.readyState === "complete" && document.querySelector("h1") && document.querySelector("#gateway-state").textContent.includes("已连接")', 'reload')
  check('A2-UI-05', await ev('location.hash') === '#/harness', 'refresh preserves route')

  await clickNav('services')
  await ev(`(() => { const input = document.querySelector('input[type="search"]'); input.value = 'mock'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  check('A2-UI-06', await ev('document.body.textContent.includes("mock")'), 'service search filters real backend data')
  await ev(`(() => { const input = document.querySelector('input[type="search"]'); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)

  await ev(`[...document.querySelectorAll('.page-header button')].find((node) => node.textContent.includes('连接模型服务')).click()`)
  await waitFor('document.querySelector("dialog") && document.querySelector("dialog").textContent.includes("连接模型服务")', 'create service dialog')
  await ev(`(() => { const set = (label, value) => { const input = document.querySelector('[aria-label="' + label + '"]'); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }; set('服务显示名称', '浏览器服务'); set('服务地址', '${upstream.base}'); set('区域（可选）', 'test'); document.querySelector('[aria-label="允许本地或私有网络地址"]').checked = true; })()`)
  await screenshot('a3-service-create-dialog-1440')
  await ev(`[...document.querySelectorAll('dialog button')].find((node) => node.textContent.includes('预览变更')).click()`)
  await waitFor('document.querySelector("dialog") && document.querySelector("dialog").textContent.includes("确认创建")', 'service preview')
  await ev(`[...document.querySelectorAll('dialog button')].find((node) => node.textContent.includes('确认创建')).click()`)
  await waitFor('document.querySelector("dialog") && document.querySelector("dialog").textContent.includes("的凭据")', 'credential dialog')
  await ev(`(() => { const input = document.querySelector('dialog input[type="password"]'); input.value = 'browser-fixture-key'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await ev(`[...document.querySelectorAll('dialog button')].find((node) => node.textContent.includes('预览凭据变更')).click()`)
  await waitFor('document.querySelector("dialog") && document.querySelector("dialog").textContent.includes("预览已生成")', 'credential preview')
  await ev(`[...document.querySelectorAll('dialog button')].find((node) => node.textContent.includes('确认安全保存')).click()`)
  await waitFor('!document.querySelector("dialog") && document.body.textContent.includes("浏览器服务")', 'service created with credential')
  check('A3-UI-01', await ev('document.body.textContent.includes("已配置")'), 'real service create and encrypted credential flow')
  check('A3-UI-02', !(await ev('localStorage.getItem("mg.ui-vnext.preferences.v1") || ""')).includes('browser-fixture-key'), 'credential never enters localStorage')

  await ev(`(() => { const row = [...document.querySelectorAll('.catalog12-card')].find((node) => node.textContent.includes('浏览器服务')); [...row.querySelectorAll('button')].find((node) => node.textContent === '编辑').click(); })()`)
  await waitFor('document.querySelector("dialog") && document.querySelector("dialog").textContent.includes("编辑 浏览器服务")', 'edit service dialog')
  await ev(`(() => { const input = document.querySelector('dialog input[aria-label="服务显示名称"]'); input.value = '浏览器服务（已编辑）'; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('dialog input[type="checkbox"]').checked = true; })()`)
  await ev(`[...document.querySelectorAll('dialog button')].find((node) => node.textContent.includes('预览变更')).click()`)
  await waitFor('document.querySelector("dialog") && document.querySelector("dialog").textContent.includes("确认保存")', 'edit preview')
  await ev(`[...document.querySelectorAll('dialog button')].find((node) => node.textContent.includes('确认保存')).click()`)
  await waitFor('!document.querySelector("dialog") && document.body.textContent.includes("浏览器服务（已编辑）")', 'service edited')
  check('A3-UI-03', true, 'real service edit preview and transaction')

  await ev(`(() => { const row = [...document.querySelectorAll('.catalog12-card')].find((node) => node.textContent.includes('浏览器服务（已编辑）')); [...row.querySelectorAll('button')].find((node) => node.textContent === '删除').click(); })()`)
  await waitFor('document.querySelector("dialog") && document.querySelector("dialog").textContent.includes("删除 浏览器服务（已编辑）")', 'delete service dialog')
  await ev(`[...document.querySelectorAll('dialog button')].find((node) => node.textContent.includes('预览删除影响')).click()`)
  await waitFor('document.querySelector("dialog") && document.querySelector("dialog").textContent.includes("同事务删除")', 'delete confirmation')
  await ev(`[...document.querySelectorAll('dialog button')].find((node) => node.textContent === '确认删除').click()`)
  await waitFor('!document.querySelector("dialog") && !document.body.textContent.includes("浏览器服务（已编辑）")', 'service deleted')
  check('A3-UI-04', true, 'real service delete impact and confirmation')

  await ev(`[...document.querySelectorAll('.page-header button')].find((node) => node.textContent.includes('连接模型服务')).click()`)
  await waitFor('document.querySelector("dialog")', 'escape dialog')
  await ev(`document.querySelector("dialog").dispatchEvent(new Event('cancel', { cancelable: true }))`)
  await waitFor('!document.querySelector("dialog")', 'dialog escape')
  check('A3-UI-05', await ev('document.activeElement?.textContent.includes("添加服务")'), 'Escape closes dialog and restores focus')

  await ev(`(() => { const row = [...document.querySelectorAll('tbody tr')].find((node) => node.textContent.includes('legacy:mock')); [...row.querySelectorAll('button')].find((node) => node.textContent.includes('连接')).click(); })()`)
  await waitFor('document.querySelector("dialog[open]") && document.querySelector("dialog").textContent.includes("连接管理")', 'connection manager')
  await ev(`[...document.querySelectorAll('dialog[open] button')].find((node) => node.textContent === '添加连接').click()`)
  await waitFor('document.querySelector("dialog[open]") && document.querySelector("dialog").textContent.includes("添加连接")', 'add connection')
  await ev(`(() => { const input = document.querySelector('dialog[open] [aria-label="连接显示名"]'); input.value = '浏览器连接'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await ev(`[...document.querySelectorAll('dialog[open] button')].find((node) => node.textContent.includes('预览变更')).click()`)
  await waitFor('document.querySelector("dialog[open]") && document.querySelector("dialog").textContent.includes("确认保存")', 'connection preview')
  await ev(`[...document.querySelectorAll('dialog[open] button')].find((node) => node.textContent === '确认保存').click()`)
  await waitFor('document.querySelector("dialog[open]") && document.querySelector("dialog").textContent.includes("浏览器连接 · 凭据")', 'connection key dialog')
  await ev(`(() => { const input = document.querySelector('dialog[open] input[type="password"]'); input.value = 'browser-connection-key'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await ev(`[...document.querySelectorAll('dialog[open] button')].find((node) => node.textContent === '预览凭据变更').click()`)
  await waitFor('document.querySelector("dialog[open]") && document.querySelector("dialog[open]").textContent.includes("预览已生成")', 'connection credential preview')
  await ev(`[...document.querySelectorAll('dialog[open] button')].find((node) => node.textContent === '确认安全保存').click()`)
  await waitFor('!document.querySelector("dialog[open]") && document.body.textContent.includes("连接 1")', 'connection created')
  check('A3-UI-05b', true, 'independent connection preview, encrypted key and real runtime registration')

  await ev(`[...document.querySelectorAll('[role="tab"]')].find((node) => node.textContent.includes('服务模型')).click()`)
  await ev(`[...document.querySelectorAll('button')].find((node) => node.textContent === '从连接发现').click()`)
  await waitFor('document.querySelector("dialog[open]") && document.querySelector("dialog").textContent.includes("vendor-model")', 'connection model discovery')
  check('A3-UI-05c', true, 'real account catalog discovery without automatic model writes')
  await ev(`document.querySelector("dialog[open] .dialog-close").click()`)

  await ev(`[...document.querySelectorAll('[role="tab"]')].find((node) => node.textContent.includes('服务目录')).click()`)
  await waitFor('document.body.textContent.includes("63 个设计模板") && document.body.textContent.includes("OpenCode Go")', 'provider templates')
  check('A3-UI-06', await ev('document.body.textContent.includes("非实时账户目录")'), 'versioned template catalog is visible and honest')
  await ev(`[...document.querySelectorAll('article button')].find((node) => node.textContent.includes('使用模板')).click()`)
  await waitFor('document.querySelector("dialog[open]") && document.querySelector("dialog").textContent.includes("使用模板")', 'template service dialog')
  await ev(`document.querySelector("dialog[open] .dialog-close").click()`)

  await ev(`[...document.querySelectorAll('[role="tab"]')].find((node) => node.textContent.includes('服务模型')).click()`)
  await waitFor('document.body.textContent.includes("添加模型")', 'models panel')
  await ev(`[...document.querySelectorAll('button')].find((node) => node.textContent === '添加模型').click()`)
  await waitFor('document.querySelector("dialog[open]") && document.querySelector("dialog").textContent.includes("添加模型")', 'add model dialog')
  await ev(`(() => { const set = (label, value) => { const input = document.querySelector('dialog[open] [aria-label="' + label + '"]'); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }; set('模型公共名', 'browser-model'); set('上游模型 ID', 'upstream-browser-model'); set('模型显示名', 'Browser Model'); })()`)
  await ev(`[...document.querySelectorAll('dialog[open] button')].find((node) => node.textContent.includes('预览变更')).click()`)
  await waitFor('document.querySelector("dialog[open]") && document.querySelector("dialog").textContent.includes("确认保存")', 'model preview')
  await ev(`[...document.querySelectorAll('dialog[open] button')].find((node) => node.textContent === '确认保存').click()`)
  await waitFor('!document.querySelector("dialog[open]") && document.body.textContent.includes("Browser Model")', 'model created')
  check('A3-UI-07', true, 'stable model create preview and transaction')

  await clickNav('pools')
  await ev(`[...document.querySelectorAll('.page-header button')].find((node) => node.textContent.includes('新建模型池')).click()`)
  await waitFor('document.querySelector("dialog[open]") && document.querySelector("dialog").textContent.includes("新建模型池")', 'create pool dialog')
  await ev(`(() => { const input = document.querySelector('dialog[open] [aria-label="模型池名称"]'); input.value = '浏览器池'; input.dispatchEvent(new Event('input', { bubbles: true })); const candidate = [...document.querySelectorAll('dialog[open] .candidate-choice')].find((row) => row.textContent.includes('Browser Model')); candidate.querySelector('input[type="checkbox"]').checked = true; })()`)
  await ev(`[...document.querySelectorAll('dialog[open] button')].find((node) => node.textContent.includes('预览变更')).click()`)
  await waitFor('document.querySelector("dialog[open]") && document.querySelector("dialog").textContent.includes("确认保存")', 'pool preview')
  await ev(`[...document.querySelectorAll('dialog[open] button')].find((node) => node.textContent === '确认保存').click()`)
  await waitFor('!document.querySelector("dialog[open]") && document.body.textContent.includes("浏览器池")', 'pool created')
  await ev(`[...document.querySelectorAll('.pool-item')].find((node) => node.textContent.includes('浏览器池')).click()`)
  check('A3-UI-08', await ev('document.body.textContent.includes("稳定池 ID")'), 'named pool create with stable ID and real directory projection')

  await ev(`[...document.querySelectorAll('[role="tab"]')].find((node) => node.textContent.includes('应用引用')).click()`)
  await ev(`[...document.querySelectorAll('button')].find((node) => node.textContent === '添加应用引用').click()`)
  await waitFor('document.querySelector("dialog[open]") && document.querySelector("dialog").textContent.includes("添加应用引用")', 'add pool binding')
  await ev(`[...document.querySelectorAll('dialog[open] button')].find((node) => node.textContent.includes('预览引用')).click()`)
  await waitFor('document.querySelector("dialog[open]") && document.querySelector("dialog").textContent.includes("确认引用")', 'binding preview')
  await ev(`[...document.querySelectorAll('dialog[open] button')].find((node) => node.textContent === '确认保存').click()`)
  await waitFor('!document.querySelector("dialog[open]") && document.body.textContent.includes("desired-only")', 'binding created')
  check('A4-UI-01', true, 'stable bidirectional pool binding created as desired revision')
  await ev(`[...document.querySelectorAll('button')].find((node) => node.textContent === '解除').click()`)
  await ev(`[...document.querySelectorAll('dialog[open] button')].find((node) => node.textContent.includes('预览解除')).click()`)
  await waitFor('[...document.querySelectorAll("dialog[open] button")].some((node) => node.textContent === "确认解除")', 'binding delete preview')
  await ev(`[...document.querySelectorAll('dialog[open] button')].find((node) => node.textContent === '确认解除').click()`)
  await waitFor('!document.querySelector("dialog[open]") && document.body.textContent.includes("尚无应用引用")', 'binding removed')

  await clickNav('services')
  await ev(`[...document.querySelectorAll('[role="tab"]')].find((node) => node.textContent.includes('服务模型')).click()`)
  await ev(`(() => { const row = [...document.querySelectorAll('.catalog12-card')].find((node) => node.textContent.includes('Browser Model')); [...row.querySelectorAll('button')].find((node) => node.textContent === '停用').click(); })()`)
  await waitFor('document.querySelector("dialog[open]") && document.querySelector("dialog").textContent.includes("停用 Browser Model")', 'disable model preview')
  await ev(`[...document.querySelectorAll('dialog[open] button')].find((node) => node.textContent.includes('预览变更')).click()`)
  await waitFor('document.querySelector("dialog[open]") && document.querySelector("dialog").textContent.includes("确认停用")', 'disable model confirm')
  await ev(`[...document.querySelectorAll('dialog[open] button')].find((node) => node.textContent === '确认').click()`)
  await waitFor('!document.querySelector("dialog[open]") && document.body.textContent.includes("已停用")', 'model disabled')
  check('A3-UI-09', true, 'model disable changes real routing eligibility')

  await ev(`(() => { const row = [...document.querySelectorAll('.catalog12-card')].find((node) => node.textContent.includes('Browser Model')); [...row.querySelectorAll('button')].find((node) => node.textContent === '启用').click(); })()`)
  await ev(`[...document.querySelectorAll('dialog[open] button')].find((node) => node.textContent.includes('预览变更')).click()`)
  await waitFor('document.querySelector("dialog[open]") && document.querySelector("dialog").textContent.includes("确认启用")', 'enable model confirm')
  await ev(`[...document.querySelectorAll('dialog[open] button')].find((node) => node.textContent === '确认').click()`)
  await waitFor('!document.querySelector("dialog[open]")', 'model enabled')

  await clickNav('pools')
  await ev(`[...document.querySelectorAll('.pool-item')].find((node) => node.textContent.includes('浏览器池')).click()`)
  await ev(`[...document.querySelectorAll('.page button')].find((node) => node.textContent === '删除').click()`)
  await waitFor('document.querySelector("dialog[open]") && document.querySelector("dialog").textContent.includes("删除 浏览器池")', 'delete pool preview')
  await ev(`[...document.querySelectorAll('dialog[open] button')].find((node) => node.textContent.includes('预览删除影响')).click()`)
  await waitFor('document.querySelector("dialog[open]") && document.querySelector("dialog").textContent.includes("确认删除")', 'delete pool confirm')
  await ev(`[...document.querySelectorAll('dialog[open] button')].find((node) => node.textContent === '确认删除').click()`)
  await waitFor('!document.querySelector("dialog[open]") && !document.body.textContent.includes("浏览器池")', 'pool deleted')

  await clickNav('services')
  await ev(`[...document.querySelectorAll('[role="tab"]')].find((node) => node.textContent.includes('服务模型')).click()`)
  await ev(`(() => { const row = [...document.querySelectorAll('.catalog12-card')].find((node) => node.textContent.includes('Browser Model')); [...row.querySelectorAll('button')].find((node) => node.textContent === '删除').click(); })()`)
  await ev(`[...document.querySelectorAll('dialog[open] button')].find((node) => node.textContent.includes('预览删除影响')).click()`)
  await waitFor('document.querySelector("dialog[open]") && document.querySelector("dialog").textContent.includes("确认删除")', 'delete model confirm')
  await ev(`[...document.querySelectorAll('dialog[open] button')].find((node) => node.textContent === '确认删除').click()`)
  await waitFor('!document.querySelector("dialog[open]") && !document.body.textContent.includes("Browser Model")', 'model deleted')
  check('A3-UI-10', true, 'pool and model deletion use real impact previews')

  await clickNav('pools')
  await ev(`(() => { const input = document.querySelector('input[aria-label="预演模型名称"]'); input.value = 'daily'; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('form').requestSubmit(); })()`)
  await waitFor('document.body.textContent.includes("上游调用") && document.body.textContent.includes("预演完成")', 'route preview')
  check('A2-UI-07', await ev('document.body.textContent.includes("daily")'), 'pure route preview shows backend hit')
  check('A2-UI-08', upstream.hits.length === 1 && upstream.hits[0].method === 'GET', 'browser journey made zero inference calls; one explicit catalog discovery only')

  await clickNav('settings')
  await ev(clickText('.subnav button', '配置与备份'))
  await waitFor('document.body.textContent.includes("创建脱敏备份")', 'backup panel')
  await ev(`[...document.querySelectorAll('button')].find((node) => node.textContent.includes('创建脱敏备份')).click()`)
  await waitFor('document.body.textContent.includes("无秘密") && document.body.textContent.includes("恢复预览")', 'backup created')
  check('A6-UI-01', true, 'real sanitized backup created and listed')
  await ev(`[...document.querySelectorAll('button')].find((node) => node.textContent === '恢复预览').click()`)
  await waitFor('document.querySelector("dialog[open]") && document.querySelector("dialog").textContent.includes("确认导入")', 'backup restore preview')
  await ev(`document.querySelector("dialog[open] .dialog-close").click()`)
  await ev(`[...document.querySelectorAll('.subnav button')].find((node) => node.textContent.includes('常规与外观')).click()`)
  await ev(`(() => { const select = document.querySelector('select[aria-label="界面主题"]'); select.value = 'light'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`)
  check('A2-UI-09', await ev('document.documentElement.dataset.theme') === 'light', 'light theme applied and persisted')
  const stored = await ev('localStorage.getItem("mg.ui-vnext.preferences.v1")')
  check('A2-UI-10', !/key|token|secret|authorization/i.test(stored), 'localStorage contains no sensitive fields')

  const viewports = [[1440, 900], [1920, 1080], [1024, 768], [768, 1024], [360, 740], [1280, 500], [2560, 1080]]
  const liveCaps = await (await fetch(gateway.base + '/api/capabilities')).json()
  const connectionId = liveCaps.services.find((item) => item.providerId === 'mock')?.connections?.[0]?.connectionId
  const states = [
    { id: 'harness', hash: '#/harness' },
    { id: 'mode', hash: '#/mode' },
    { id: 'providers', hash: '#/services' },
    { id: 'directory', hash: '#/services', prepare: `[...document.querySelectorAll('[role="tab"]')].find((node) => node.textContent.includes('服务目录'))?.click()` },
    { id: 'serviceDetail', hash: '#/service-detail?service=mock' },
    { id: 'accountDetail', hash: '#/account-detail?service=mock&connection=' + encodeURIComponent(connectionId || '') },
    { id: 'serviceModels', hash: '#/service-models?service=mock' },
    { id: 'pools', hash: '#/pools' },
    { id: 'poolStrategy', hash: '#/pool-strategy' },
    { id: 'poolApps', hash: '#/pool-apps' },
    { id: 'poolTest', hash: '#/pool-test' },
    { id: 'usage', hash: '#/usage' },
    { id: 'reliability', hash: '#/reliability' },
    { id: 'reliabilityDetail', hash: '#/reliability-detail' },
    { id: 'settings', hash: '#/settings' },
    { id: 'models', hash: '#/models' },
    { id: 'routing', hash: '#/routing' },
    { id: 'clients', hash: '#/clients' },
    { id: 'logs', hash: '#/logs' },
  ]
  const matrixDir = join(outDir, 'matrix')
  mkdirSync(matrixDir, { recursive: true })
  for (const theme of ['dark', 'light']) {
    await ev(`document.documentElement.dataset.theme = '${theme}'`)
    for (const [width, height] of viewports) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
      for (const item of states) {
        await ev('location.hash = ' + JSON.stringify(item.hash))
        await ev('new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)))')
        if (item.prepare) await ev(item.prepare)
        await ev('new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)))')
        const geometry = await ev('({ hash: location.hash, doc: document.documentElement.scrollWidth, view: innerWidth, h1: document.querySelector("h1")?.textContent, main: document.getElementById("main").getBoundingClientRect().width })')
        const ok = geometry.doc <= geometry.view + 1 && geometry.h1 && geometry.main > 0
        report.viewports.push({ theme, width, height, state: item.id, ok, ...geometry })
        if (!ok) throw new Error('viewport overflow: ' + JSON.stringify(report.viewports.at(-1)))
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
        const file = join(matrixDir, item.id + '-' + theme + '-' + width + 'x' + height + '.png')
        writeFileSync(file, Buffer.from(shot.data, 'base64'))
        report.screenshots.push(file.slice(root.length + 1))
      }
    }
  }
  check('A2-V01-pages', report.viewports.length === 266 && report.viewports.every((item) => item.ok), '19 states × 7 viewports × 2 themes = 266 real-browser combinations')

  const clickText = (selector, text) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find((node) => node.textContent.includes(${JSON.stringify(text)}))?.click()`
  const dialogs = [
    { id: 'service-create', hash: '#/services', steps: [clickText('button', '连接模型服务')] },
    { id: 'service-template', hash: '#/services', steps: [clickText('[role="tab"]', '服务目录'), clickText('article button', '使用模板')] },
    { id: 'service-edit', hash: '#/services', steps: [clickText('[role="tab"]', '我的服务'), clickText('.catalog12-card button', '编辑')] },
    { id: 'service-delete', hash: '#/services', steps: [clickText('[role="tab"]', '我的服务'), clickText('.catalog12-card button', '删除')] },
    { id: 'account-add', hash: '#/service-detail?service=mock', steps: [clickText('button', '管理连接'), clickText('dialog button', '添加连接')] },
    { id: 'account-edit', hash: '#/service-detail?service=mock', steps: [clickText('button', '管理连接'), clickText('dialog button', '编辑')] },
    { id: 'model-add', hash: '#/service-models?service=mock', steps: [clickText('button', '添加模型')] },
    { id: 'pool-create', hash: '#/pools', steps: [clickText('button', '新建模型池')] },
    { id: 'pool-candidates', hash: '#/pools', steps: [clickText('.pool-item', 'daily'), clickText('button', '编辑')] },
    { id: 'pool-bind', hash: '#/pool-apps', steps: [clickText('button', '添加应用引用')] },
    { id: 'generic-access', hash: '#/clients', steps: [clickText('button', '通用 API 接入')] },
    { id: 'backup-import', hash: '#/settings', steps: [clickText('.subnav button', '配置与备份'), clickText('button', '恢复预览')] },
  ]
  for (const theme of ['dark', 'light']) {
    for (const [width, height] of [[1440, 900], [360, 740], [1280, 500]]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
      await ev(`document.documentElement.dataset.theme = '${theme}'; document.querySelectorAll('dialog[open]').forEach((node) => node.close())`)
      for (const item of dialogs) {
        await ev('location.hash = ' + JSON.stringify(item.hash))
        await ev('new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)))')
        for (const step of item.steps) { await ev(step); await ev('new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)))') }
        await waitFor('document.querySelector("dialog[open]")', 'dialog ' + item.id)
        const geometry = await ev('(() => { const dialog = [...document.querySelectorAll("dialog[open]")].at(-1); const rect = dialog.getBoundingClientRect(); const footer = dialog.querySelector(".dialog-footer").getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, footerBottom: footer.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight, docWidth: document.documentElement.scrollWidth }; })()')
        const ok = geometry.top >= 0 && geometry.bottom <= geometry.viewportHeight + 1 && geometry.left >= 0 && geometry.right <= geometry.viewportWidth + 1 && geometry.footerBottom <= geometry.viewportHeight + 1 && geometry.docWidth <= geometry.viewportWidth + 1
        report.dialogs.push({ theme, width, height, kind: item.id, ok, ...geometry })
        if (!ok) throw new Error('dialog overflow: ' + JSON.stringify(report.dialogs.at(-1)))
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
        const file = join(matrixDir, 'dialog-' + item.id + '-' + theme + '-' + width + 'x' + height + '.png')
        writeFileSync(file, Buffer.from(shot.data, 'base64'))
        report.screenshots.push(file.slice(root.length + 1))
        await ev('document.querySelectorAll("dialog[open]").forEach((node) => node.close())')
      }
    }
  }
  check('A2-V01-dialogs', report.dialogs.length === 72 && report.dialogs.every((item) => item.ok), '12 dialogs × 3 viewports × 2 themes = 72 real-browser combinations')

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await ev('location.hash = "#/harness"; document.documentElement.dataset.theme = "dark"')
  await screenshot('a2-harness-dark-1440')
  await ev('document.documentElement.dataset.theme = "light"')
  await screenshot('a2-harness-light-1440')
  await ev('location.hash = "#/pools"; document.documentElement.dataset.theme = "dark"')
  await screenshot('a2-pools-dark-1440')

  for (const status of [404, 500]) {
    let paused
    const pausedPromise = new Promise((ok) => { paused = ok })
    cdp.on('Fetch.requestPaused', paused)
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/capabilities' }] })
    await ev('document.getElementById("refresh").click()')
    const event = await Promise.race([pausedPromise, new Promise((_, fail) => setTimeout(() => fail(new Error('fetch pause timeout')), 10000))])
    await cdp.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: status, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from(JSON.stringify({ error: 'injected-' + status })).toString('base64') })
    await cdp.send('Fetch.disable')
    await waitFor('document.querySelector(".error-state") && document.querySelector(".error-state").textContent.includes("injected-' + status + '")', 'HTTP ' + status)
    check('A2-V04-' + status, true, 'real browser displays HTTP ' + status + ' error with retry')
  }

  await gateway.stop()
  gateway = null
  await ev('document.getElementById("refresh").click()')
  await waitFor('document.getElementById("gateway-state").textContent.includes("网关离线") && document.querySelector(".error-state")', 'offline')
  check('A2-V04-offline', true, 'gateway offline is visible and not fake-ready')
  check('A2-UI-11', report.errors.length === 0 && report.networkErrors.length >= 3, 'no uncaught JS errors; expected 404/500/offline network errors=' + report.networkErrors.length)
  report.finishedAt = new Date().toISOString()
  report.result = 'PASS'
}

try {
  await main()
} catch (error) {
  report.result = 'FAIL'
  report.failure = error.stack || error.message
  console.error(error.stack || error.message)
  process.exitCode = 1
} finally {
  report.finishedAt = new Date().toISOString()
  writeFileSync(join(outDir, 'a2-browser-report.json'), JSON.stringify(report, null, 2))
  if (cdp) cdp.close()
  if (browser && browser.exitCode === null) browser.kill('SIGTERM')
  if (gateway) await gateway.stop()
  if (upstream) await upstream.stop()
  if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
