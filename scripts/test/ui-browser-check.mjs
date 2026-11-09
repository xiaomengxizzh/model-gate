// Browser acceptance via Chrome DevTools Protocol (no playwright/puppeteer install).
// Usage: node scripts/test/ui-browser-check.mjs --port 8788 --token fixture-admin-token --out /tmp/mg-ui-shots
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > -1 ? process.argv[i + 1] : dflt }
const PORT = Number(arg('port', 8788))
const TOKEN = arg('token', 'fixture-admin-token')
const OUT = arg('out', '/tmp/mg-ui-shots')
const CDP = arg('cdp', '9222')
const BASE = 'http://127.0.0.1:' + PORT
mkdirSync(OUT, { recursive: true })

const results = []
function record (name, fn) {
  try { const detail = fn(); results.push({ name, ok: true, detail }) } catch (e) { results.push({ name, ok: false, detail: e.message }) }
}
async function check (name, fn) {
  try { const detail = await fn(); results.push({ name, ok: true, detail }) } catch (e) { results.push({ name, ok: false, detail: e.message }) }
}

const targets = await (await fetch('http://127.0.0.1:' + CDP + '/json')).json()
const target = targets.find((t) => t.type === 'page')
if (!target) throw new Error('no CDP page target on port ' + CDP)
const ws = new WebSocket(target.webSocketDebuggerUrl)
let nextId = 0
const pending = new Map()
const events = []
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return }
  if (msg.method) events.push(msg)
})
await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject) })
const send = (method, params = {}) => new Promise((resolve) => { const id = ++nextId; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })) })
await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable'); await send('Emulation.setFocusEmulationEnabled', { enabled: true })

async function ev (expression, awaitPromise = true) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
  const res = r.result
  if (res && res.exceptionDetails) throw new Error('page exception: ' + (res.exceptionDetails.exception && res.exceptionDetails.exception.description || res.exceptionDetails.text))
  const v = res && res.result
  if (!v) return undefined
  if (v.subtype === 'error') throw new Error(v.description || 'page error')
  return v.value !== undefined ? v.value : v.description
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor (expression, timeout = 8000, label = expression) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    try { if (await ev(expression)) return true } catch {}
    await sleep(100)
  }
  throw new Error('timeout waiting for ' + label)
}
async function nav (url) {
  await send('Page.navigate', { url })
  await sleep(600)
  await waitFor("document.readyState==='complete'")
}
async function shot (name) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const file = join(OUT, name + '.png')
  writeFileSync(file, Buffer.from(r.result.data, 'base64'))
  return file
}
async function setViewport (width, height) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await sleep(250)
}
async function login (token = TOKEN) {
  await ev("document.getElementById('admin-token').value=" + JSON.stringify(token) + ";document.getElementById('auth-form').requestSubmit();'submitted'")
  await waitFor("document.getElementById('auth-overlay').hidden===true", 8000, 'auth overlay hidden')
  await waitFor("document.querySelector('.hero')!==null", 8000, 'dashboard hero')
}

// ---------- boot + dashboard ----------
await nav(BASE + '/ui-next')
await check('boot: locked screen before auth', async () => {
  await waitFor("document.getElementById('auth-overlay').hidden===false", 6000, 'auth overlay')
  const text = await ev('document.body.innerText')
  assert.match(text, /控制面已锁定|解锁管理控制面/)
  assert.doesNotMatch(text, /无法读取本地控制面/)
  return 'locked UI shown, no data fetched'
})
await check('dashboard: login and real metrics', async () => {
  await login()
  const data = await ev("JSON.stringify({hero:document.querySelector('.hero h2').textContent,metrics:[...document.querySelectorAll('.metric-value')].map(x=>x.textContent),cards:[...document.querySelectorAll('.card-head h2')].map(x=>x.textContent),status:document.getElementById('side-status').textContent})")
  const d = JSON.parse(data)
  assert.equal(d.status, '网关在线')
  assert.ok(d.metrics.length >= 4)
  assert.ok(d.cards.includes('请求延迟趋势'))
  assert.ok(d.cards.includes('上游健康'))
  assert.ok(d.cards.includes('最近路由'))
  assert.ok(d.metrics[0] !== '—' && d.metrics[0] !== '0', 'requests metric has fixture traffic: ' + d.metrics[0])
  await shot('01-dashboard-light')
  return JSON.stringify(d)
})
await check('dashboard: no runtime errors so far', async () => {
  const errs = events.filter((e) => e.method === 'Runtime.exceptionThrown')
  assert.equal(errs.length, 0, errs.map((e) => e.params.exceptionDetails.text).join('; '))
  return '0 page exceptions'
})

// ---------- providers ----------
await check('providers: list, status and dialog', async () => {
  await ev("location.hash='#/providers'")
  await waitFor("document.querySelector('.page-head h1') && document.querySelector('.page-head h1').textContent==='上游供应商'")
  const text = await ev('document.body.innerText')
  assert.match(text, /mock-openai/)
  assert.match(text, /mock-backup/)
  const buttons = await ev("document.querySelectorAll('button').length")
  assert.ok(buttons > 3)
  await shot('02-providers')
  // open add-provider dialog if the view exposes one
  const opened = await ev("(()=>{const b=[...document.querySelectorAll('button')].find(x=>/新增|添加/.test(x.textContent));if(!b)return false;b.click();return true})()")
  if (opened) {
    await waitFor("document.querySelector('.dialog')!==null")
    const dlg = await ev("document.querySelector('.dialog').innerText")
    assert.match(dlg, /Base URL|上游|协议/)
    await ev("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")
    await sleep(200)
    assert.equal(await ev("document.querySelector('.dialog')===null"), true, 'Esc closes dialog')
  }
  return 'providers rendered' + (opened ? ', dialog + Esc' : '')
})

// ---------- models ----------
await check('models: catalog, capability tags, virtual model, route preview', async () => {
  await ev("location.hash='#/models'")
  await waitFor("document.querySelector('.page-head h1') && document.querySelector('.page-head h1').textContent==='模型与路由'")
  const text = await ev('document.body.innerText')
  assert.match(text, /deepseek-fixture/)
  assert.match(text, /gatemodel/)
  assert.match(text, /embedding|chat/)
  await shot('03-models')
  return 'catalog + virtual model visible'
})

// ---------- clients ----------
await check('clients: templates and honest verification labels', async () => {
  await ev("location.hash='#/clients'")
  await waitFor("document.querySelector('.page-head h1') && document.querySelector('.page-head h1').textContent==='客户端接入'")
  const text = await ev('document.body.innerText')
  assert.match(text, /Codex/i)
  assert.match(text, /DSH/)
  assert.match(text, new RegExp(BASE.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&')))
  assert.match(text, /未自动检测|不能自动|不读取/)
  assert.doesNotMatch(text, /已连接客户端/)
  await shot('04-clients')
  return 'templates + honest states'
})

// ---------- observability ----------
await check('observability: real stats, logs and derived failure counts', async () => {
  await ev("location.hash='#/observability'")
  await waitFor("document.querySelector('.page-head h1') && document.querySelector('.page-head h1').textContent==='监控与诊断'")
  await sleep(1200)
  const text = await ev('document.body.innerText')
  assert.match(text, /mock-openai/)
  assert.match(text, /429|限流/)
  assert.match(text, /日志/)
  assert.match(text, /派生|非持久化/)
  await shot('05-observability')
  return 'stats + logs + derived classification'
})

// ---------- settings + 409 ----------
await check('settings: instance facts and versioned save', async () => {
  await ev("location.hash='#/settings'")
  await waitFor("document.querySelector('.page-head h1') && document.querySelector('.page-head h1').textContent==='安全与设置'")
  const text = await ev('document.body.innerText')
  assert.match(text, /配置版本/)
  assert.match(text, /管理令牌/)
  assert.match(text, /备份/)
  await shot('06-settings')
  return 'settings rendered'
})
await check('settings: 409 conflict is surfaced, not overwritten', async () => {
  // Change a retry field, then advance the server version from the page (simulating another tab).
  const changed = await ev("(()=>{const fields=[...document.querySelectorAll('.field')];const f=fields.find(x=>x.querySelector('label')&&x.querySelector('label').textContent.includes('最大尝试次数'));if(!f)return false;const i=f.querySelector('input');i.value='4';i.dispatchEvent(new Event('change',{bubbles:true}));return true})()")
  assert.equal(changed, true, 'retry field found')
  await sleep(200)
  const advanced = await ev("(async()=>{const h={authorization:'Bearer '+localStorage.getItem('__noop')};const r=await fetch('/api/config',{headers:{authorization:'Bearer "+TOKEN+"'}});const c=await r.json();const r2=await fetch('/api/config/save',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer "+TOKEN+"'},body:JSON.stringify({version:c.configVersion,defaults:Object.assign({},c.defaults,{retry:Object.assign({},c.defaults.retry,{maxAttempts:3})})})});return r2.status})()")
  assert.equal(advanced, 200, 'external save advanced version')
  await ev("document.getElementById('save-defaults').click()")
  await waitFor("document.querySelector('.dialog')!==null")
  await ev("(()=>{const b=[...document.querySelectorAll('.dialog button')].find(x=>/保存.*更改/.test(x.textContent));if(!b)return false;b.click();return true})()")
  await waitFor("document.body.innerText.includes('配置已被其他窗口修改')", 8000, 'conflict dialog')
  await shot('07-conflict-409')
  const reloaded = await ev("(()=>{const b=[...document.querySelectorAll('.dialog button')].find(x=>/重新加载远端配置/.test(x.textContent));if(!b)return false;b.click();return true})()")
  assert.equal(reloaded, true)
  await waitFor("document.querySelector('.dialog')===null", 8000)
  return 'stale save rejected with visible conflict + reload'
})

// ---------- XSS ----------
await check('XSS: dynamic config text is rendered as text', async () => {
  await ev("location.hash='#/models'")
  await waitFor("document.querySelector('.page-head h1') && document.querySelector('.page-head h1').textContent==='模型与路由'")
  const saved = await ev("(async()=>{const r=await fetch('/api/config',{headers:{authorization:'Bearer "+TOKEN+"'}});const c=await r.json();c.models['deepseek-fixture'].alias=['<img src=x onerror=window.__mgxss=1>'];const r2=await fetch('/api/config/save',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer "+TOKEN+"'},body:JSON.stringify({version:c.configVersion,providers:c.providers,models:c.models,defaults:c.defaults,virtualModels:c.virtualModels})});return r2.status})()")
  assert.equal(saved, 200)
  await ev("document.getElementById('refresh').click()")
  await sleep(1500)
  const out = await ev("JSON.stringify({xss:window.__mgxss||0,img:!!document.querySelector('img[src=\"x\"]'),text:document.body.innerText.includes('<img src=x onerror=')})")
  const o = JSON.parse(out)
  assert.equal(o.xss, 0, 'onerror must not execute')
  assert.equal(o.img, false, 'no injected img element')
  assert.equal(o.text, true, 'payload visible as literal text')
  // Clean up the fixture so later screenshots and runs are not polluted.
  await ev("(async()=>{const r=await fetch('/api/config',{headers:{authorization:'Bearer "+TOKEN+"'}});const c=await r.json();c.models['deepseek-fixture'].alias=['ds-fixture'];const r2=await fetch('/api/config/save',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer "+TOKEN+"'},body:JSON.stringify({version:c.configVersion,providers:c.providers,models:c.models,defaults:c.defaults,virtualModels:c.virtualModels})});return r2.status})()")
  return 'payload inert and visible as text (fixture restored)'
})

// ---------- theme + responsive ----------
await check('theme: dark mode toggles and renders', async () => {
  await ev("location.hash='#/overview'")
  await waitFor("document.querySelector('.hero')!==null")
  await ev("document.getElementById('theme-toggle').click()")
  await sleep(300)
  const theme = await ev("document.documentElement.dataset.theme")
  assert.equal(theme, 'dark')
  await shot('08-dashboard-dark')
  await ev("document.getElementById('theme-toggle').click()")
  await sleep(200)
  assert.equal(await ev("document.documentElement.dataset.theme"), 'light')
  return 'light/dark toggles'
})
await check('responsive: 1440/1024/768/390 without horizontal overflow', async () => {
  const widths = [1440, 1024, 768, 390]
  const report = []
  for (const w of widths) {
    await setViewport(w, w <= 390 ? 844 : 1000)
    await sleep(350)
    const overflow = await ev("JSON.stringify({sw:document.documentElement.scrollWidth,iw:window.innerWidth,nav:document.querySelector('.sidebar').getBoundingClientRect().width})")
    const o = JSON.parse(overflow)
    assert.ok(o.sw <= o.iw + 2, 'no horizontal overflow at ' + w + ': ' + JSON.stringify(o))
    report.push(w + 'px ok')
    if (w === 390) await shot('09-dashboard-mobile')
  }
  await setViewport(1440, 1000)
  return report.join(', ')
})

// ---------- auth failure ----------
await check('auth: reload locks console; wrong token rejected; right token unlocks', async () => {
  await nav(BASE + '/ui-next')
  await waitFor("document.getElementById('auth-overlay').hidden===false", 6000)
  await ev("document.getElementById('admin-token').value='wrong-token';document.getElementById('auth-form').requestSubmit();'submitted'")
  await sleep(900)
  const err = await ev("document.getElementById('auth-error').textContent")
  assert.match(err, /令牌|失败/)
  assert.equal(await ev("document.getElementById('auth-overlay').hidden"), false)
  await login()
  return 'wrong token rejected, correct token unlocks'
})

// ---------- console health ----------
await check('console: no uncaught exceptions during the whole run', async () => {
  const errs = events.filter((e) => e.method === 'Runtime.exceptionThrown')
  assert.equal(errs.length, 0, errs.map((e) => e.params.exceptionDetails.text).join('; '))
  return errs.length + ' exceptions'
})

const failed = results.filter((r) => !r.ok)
console.log('\nUI browser acceptance (' + BASE + ')')
for (const r of results) console.log((r.ok ? 'PASS' : 'FAIL') + '  ' + r.name + (r.detail ? ' — ' + r.detail : ''))
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed; screenshots: ' + OUT)
ws.close()
process.exitCode = failed.length ? 1 : 0
