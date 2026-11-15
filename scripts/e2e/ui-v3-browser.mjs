#!/usr/bin/env node
// A5 / UX-06：浏览器验收（零第三方依赖，只用本机 Chrome + CDP + 既有隔离网关夹具）。
//
// 用法：
//   node scripts/e2e/ui-v3-browser.mjs [--cdp 9222] [--out docs/evidence/screenshots] [--no-launch]
//
// 行为：
//   1) 探测本机 Chrome/Chromium 与 CDP 端口（默认 127.0.0.1:9222）。
//   2) 若 CDP 未运行但存在本机 Chrome，则用**临时独立 profile** 启动 headless Chrome（不下载、不安装、
//      不碰日常 profile）；启动失败则明确 NOT_RUN 并以退出码 2 结束（绝不伪造成 PASS）。
//   3) 起隔离网关（startGateway：MG_ADMIN_TOKEN + 隔离 MG_CONFIG_DIR/CODEX_HOME），打开 /ui-next。
//   4) 通过同源模块注入管理员令牌（失败则退回真实登录表单），断言首屏唯一主 CTA、三条连接状态、
//      高级分组默认收起、360/768/1440 主 CTA 可见，并截图到 docs/evidence/screenshots/。
//
// 退出码：0 = 全部通过；1 = 浏览器可用但产品断言失败（附逐项原因）；2 = NOT_RUN（无浏览器/CDP）。
// 重要：本脚本不发起任何真实模型请求；令牌与 Key 均为隔离实例的虚构值。
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startGateway, root } from '../test/offline/harness.mjs'

const argv = process.argv.slice(2)
const arg = (name, dflt) => { const i = argv.indexOf('--' + name); return i > -1 && argv[i + 1] ? argv[i + 1] : dflt }
const CDP_PORT = Number(arg('cdp', process.env.A5_CDP_PORT || '9222'))
const CDP = 'http://127.0.0.1:' + CDP_PORT
const OUT_DIR = resolve(root, arg('out', 'docs/evidence/screenshots'))
const SUFFIX = arg('suffix', '') // 例：--suffix -integrated（不覆盖基线截图）
const NO_LAUNCH = argv.includes('--no-launch')
const TOKEN = 'a5-browser-fixture-token'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const report = { chrome: {}, checks: [], screenshots: [], notes: [] }
let browserReady = false

// 页面内表达式一律用普通字符串保存，避免二次插值把测试值拼进代码。
const CTA_EXPR = '(() => {'
  + 'const root = document.getElementById("view-root"); if (!root) return [];'
  + 'const re = /^(连接 OpenCode Go|更新 OpenCode Go Key|启用聚合模式|完成 Codex 重启|在 Codex 中使用|完成 DeepSeek 接入|解锁控制台|确认配置变更|查看如何安装\\/定位 Codex|重试连接|查看并处理配置冲突)$/;'
  + 'return [...root.querySelectorAll("button, a")].filter((el) => {'
  + '  const t = (el.innerText || "").trim(); if (!re.test(t)) return false;'
  + '  const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);'
  + '  return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) !== 0;'
  + '}).map((el) => ({ text: (el.innerText || "").trim(), tag: el.tagName.toLowerCase(), href: el.getAttribute("href") || "" }));'
  + '})'

function findChrome () {
  for (const bin of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) {
    for (const d of String(process.env.PATH || '').split(':')) {
      if (!d) continue
      const p = join(d, bin)
      if (existsSync(p)) return p
    }
  }
  return null
}

async function cdpVersion () {
  try {
    const res = await fetch(CDP + '/json/version', { signal: AbortSignal.timeout(2000) })
    if (!res.ok) return null
    return await res.json()
  } catch { return null }
}

async function launchChrome (bin) {
  const profile = mkdtempSync(join(tmpdir(), 'mg-a5-chrome-'))
  const child = spawn(bin, [
    '--headless=new',
    '--remote-debugging-port=' + CDP_PORT,
    '--remote-allow-origins=*',
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-gpu',
    '--no-sandbox',
    '--window-size=1440,900',
    'about:blank',
  ], { stdio: 'ignore' })
  let exited = false
  child.once('exit', () => { exited = true })
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) {
    if (exited) break
    const v = await cdpVersion()
    if (v) return { child, profile, version: v }
    await sleep(200)
  }
  try { child.kill('SIGKILL') } catch {}
  rmSync(profile, { recursive: true, force: true })
  return null
}

// —— 极简 CDP 客户端（Node 内置 WebSocket，无依赖） ——
async function connectTarget (url) {
  let res = await fetch(CDP + '/json/new?' + encodeURIComponent(url), { method: 'PUT' })
  if (!res.ok) res = await fetch(CDP + '/json/new?' + encodeURIComponent(url))
  if (!res.ok) throw new Error('CDP /json/new 失败：HTTP ' + res.status)
  const target = await res.json()
  if (!target.webSocketDebuggerUrl) throw new Error('CDP 目标缺少 webSocketDebuggerUrl')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  const pending = new Map()
  const events = []
  let nextId = 0
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return }
    if (msg.method) events.push(msg)
  })
  await new Promise((resolveOpen, rejectOpen) => {
    ws.addEventListener('open', resolveOpen, { once: true })
    ws.addEventListener('error', rejectOpen, { once: true })
  })
  const send = (method, params = {}) => new Promise((resolveSend, rejectSend) => {
    const id = ++nextId
    const timer = setTimeout(() => { pending.delete(id); rejectSend(new Error('CDP 超时：' + method)) }, 15000)
    pending.set(id, (msg) => { clearTimeout(timer); resolveSend(msg) })
    ws.send(JSON.stringify({ id, method, params }))
  })
  const close = async () => {
    try { await fetch(CDP + '/json/close/' + target.id) } catch {}
    try { ws.close() } catch {}
  }
  return { send, close, events }
}

async function main () {
  mkdirSync(OUT_DIR, { recursive: true })
  const bin = findChrome()
  report.chrome.binary = bin
  let launched = null
  let version = await cdpVersion()
  if (!version) {
    if (NO_LAUNCH) {
      console.error('NOT_RUN_BROWSER: CDP 端口 ' + CDP_PORT + ' 未运行且指定了 --no-launch')
      console.error('复现：google-chrome --headless=new --remote-debugging-port=' + CDP_PORT + ' --user-data-dir=$(mktemp -d) about:blank')
      process.exit(2)
    }
    if (!bin) {
      console.error('NOT_RUN_BROWSER: 本机没有 Chrome/Chromium，且未安装任何浏览器（本任务禁止下载）')
      console.error('复现：安装/使用已有 Chrome 后运行 google-chrome --headless=new --remote-debugging-port=' + CDP_PORT + ' --user-data-dir=$(mktemp -d) about:blank')
      process.exit(2)
    }
    launched = await launchChrome(bin)
    if (!launched) {
      console.error('NOT_RUN_BROWSER: 本机有 Chrome（' + bin + '）但 headless CDP 启动失败；不改用下载/安装')
      console.error('复现：google-chrome --headless=new --remote-debugging-port=' + CDP_PORT + ' --user-data-dir=$(mktemp -d) about:blank')
      process.exit(2)
    }
    version = launched.version
  }
  browserReady = true
  report.chrome.cdp = { port: CDP_PORT, browser: version.Browser, protocol: version['Protocol-Version'] }
  report.chrome.launched_by_script = !!launched
  console.log('CHROME ' + JSON.stringify(report.chrome))

  const codexHome = mkdtempSync(join(tmpdir(), 'mg-a5-browser-codex-'))
  const gw = await startGateway({ name: 'a5-browser', env: { MG_ADMIN_TOKEN: TOKEN, CODEX_HOME: codexHome } })
  const base = gw.base
  let cdp = null
  try {
    cdp = await connectTarget(base + '/ui-next')
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    await cdp.send('Log.enable')

    const ev = async (expression) => {
      const msg = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (msg.result && msg.result.exceptionDetails) {
        const d = msg.result.exceptionDetails
        throw new Error('页面异常：' + (d.exception && d.exception.description ? d.exception.description : d.text))
      }
      const v = msg.result && msg.result.result
      if (!v) return undefined
      return v.value !== undefined ? v.value : v.description
    }
    const waitFor = async (expression, label, timeout = 15000) => {
      const end = Date.now() + timeout
      while (Date.now() < end) {
        try { if (await ev(expression)) return true } catch {}
        await sleep(120)
      }
      throw new Error('等待超时：' + label)
    }
    const check = (id, ok, detail) => {
      report.checks.push({ id, ok: !!ok, detail })
      console.log((ok ? 'PASS ' : 'FAIL ') + id + ' :: ' + detail)
      return !!ok
    }
    await waitFor('document.readyState === "complete"', 'document.readyState')

    // 注入管理员令牌：优先同源模块（真实 app 的 setToken+bootstrap），失败退回真实登录表单。
    await ev('globalThis.__A5_TOKEN = ' + JSON.stringify(TOKEN))
    await ev('globalThis.__A5_CTA = ' + CTA_EXPR)
    const injected = await ev('(async () => {'
      + ' try {'
      + '  const api = await import("/ui-next/js/api.js");'
      + '  if (typeof api.setToken !== "function") return "no-setToken";'
      + '  api.setToken(globalThis.__A5_TOKEN);'
      + '  const app = await import("/ui-next/app.js");'
      + '  if (typeof app.bootstrap !== "function") return "no-bootstrap";'
      + '  await app.bootstrap(); return "module";'
      + ' } catch (e) { return "error:" + (e && e.message) }'
      + '})()')
    if (injected !== 'module') {
      report.notes.push('模块注入失败（' + injected + '），改用真实登录表单')
      const filled = await ev('(() => {'
        + ' const input = document.getElementById("admin-token");'
        + ' const form = document.getElementById("auth-form");'
        + ' if (!input || !form) return false;'
        + ' input.value = globalThis.__A5_TOKEN;'
        + ' form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));'
        + ' return true; })()')
      if (!filled) throw new Error('无法注入管理员令牌：页面没有登录表单')
    }
    await waitFor('(() => { const o = document.getElementById("auth-overlay"); return !o || o.hidden === true })()', '登录遮罩关闭')
    await waitFor('(() => { const el = document.getElementById("view-root"); return el && el.innerText.length > 20 && !/正在读取控制面/.test(el.innerText) })()', '首屏渲染完成')

    const pageInfo = await ev('({'
      + ' title: document.title,'
      + ' route: location.hash || "#/overview",'
      + ' mainText: (document.getElementById("view-root") || {}).innerText || "",'
      + ' bodyText: document.body.innerText || "" })')
    check('UI-00-load', /ModelGate/.test(pageInfo.title || ''), 'title=' + JSON.stringify(pageInfo.title) + ' route=' + pageInfo.route)

    // 三条连接状态（ChatGPT / OpenCode Go / Codex）
    const rowsText = pageInfo.mainText || ''
    const hasOfficial = /ChatGPT|官方套餐/.test(rowsText)
    const hasGo = /OpenCode Go/.test(rowsText)
    const hasCodex = /Codex/.test(rowsText)
    const evidenceWord = /(已检测到|未验证|待登录|待连接|状态未知|已配置|需要重新打开|未检测到|无法确认|需要操作)/.test(rowsText)
    check('UI-01-status-rows', hasOfficial && hasGo && hasCodex && evidenceWord,
      'ChatGPT=' + hasOfficial + ' Go=' + hasGo + ' Codex=' + hasCodex + ' 证据等级词=' + evidenceWord + ' 首屏文本长度=' + rowsText.length)

    // 唯一主 CTA（同一时刻最多一个）
    const ctas = await ev('globalThis.__A5_CTA()')
    check('UI-01-single-cta', Array.isArray(ctas) && ctas.length === 1, '匹配到 ' + (ctas ? ctas.length : 0) + ' 个主 CTA：' + JSON.stringify(ctas))

    // 高级分组默认收起
    const advanced = await ev('(() => {'
      + ' const toggle = [...document.body.querySelectorAll("button, summary, a, [role=button]")].find((el) => /高级/.test((el.innerText || "").trim()));'
      + ' if (!toggle) return { found: false };'
      + ' const details = toggle.closest("details");'
      + ' const expanded = toggle.getAttribute("aria-expanded");'
      + ' const closed = details ? details.open === false : expanded === "false";'
      + ' const links = [...document.body.querySelectorAll("[data-route]")].filter((el) => /providers|models|clients|aggregation|observability/.test(el.getAttribute("data-route") || ""));'
      + ' const pixelVisible = links.filter((el) => {'
      + '   const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) return false;'
      + '   if (typeof el.checkVisibility === "function" && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;'
      + '   const x = Math.min(r.right - 2, r.left + r.width / 2); const y = r.top + r.height / 2;'
      + '   if (y < 0 || y > innerHeight || x < 0 || x > innerWidth) return true;'
      + '   const hit = document.elementFromPoint(x, y);'
      + '   return !!(hit && (el === hit || el.contains(hit) || hit.closest("[data-route]") === el));'
      + ' }).map((el) => el.dataset.route);'
      + ' return { found: true, closed, expanded, details: !!details, advancedLinks: links.length, pixelVisible };'
      + '})()')
    check('UI-01-advanced-collapsed', !!(advanced && advanced.found && advanced.closed && (advanced.pixelVisible || []).length === 0), '高级分组（需真正像素不可见）：' + JSON.stringify(advanced))

    // 运行时 aria-current（静态文件不写它，必须由 app.js 在运行时表达当前页）
    const navCurrent = await ev("(() => {"
      + " const raw = (location.hash || '#/overview').split('?')[0];"
      + " const route = raw.indexOf('#/') === 0 ? raw.slice(2) : (raw || 'overview');"
      + " const current = [...document.querySelectorAll('[data-route]')].filter((el) => el.getAttribute('aria-current') === 'page').map((el) => el.dataset.route);"
      + " return { current, route }; })()")
    check('UI-01-nav-current', !!(navCurrent && Array.isArray(navCurrent.current) && navCurrent.current.length === 1 && navCurrent.current[0] === navCurrent.route), '运行时 aria-current=' + JSON.stringify(navCurrent))

    // 不显示伪成功：无 Key 时不得出现这些结论
    const fake = ['准备就绪', '聚合模式已启用', '可用（已实测推理）', '所有已配置上游均可用'].filter((w) => (pageInfo.bodyText || '').includes(w))
    check('UI-01-no-fake-success', fake.length === 0, '无 Key/无真实推理时出现的成功结论：' + JSON.stringify(fake))

    // 令牌/Key 不得持久化（仅允许 mg-theme）
    const storage = await ev('(() => {'
      + ' const ls = {}; for (const k of Object.keys(localStorage)) ls[k] = localStorage.getItem(k);'
      + ' const ss = {}; for (const k of Object.keys(sessionStorage)) ss[k] = sessionStorage.getItem(k);'
      + ' return { ls, ss }; })()')
    const storageRaw = JSON.stringify(storage)
    check('UI-10-no-credential-persistence', !storageRaw.includes(TOKEN) && !Object.keys(storage.ss || {}).length && Object.keys(storage.ls || {}).every((k) => k === 'mg-theme'),
      'localStorage/sessionStorage=' + storageRaw.slice(0, 200))

    // 三种视口：主 CTA 可见、不横向截断、触控高度 >= 40
    for (const vp of [{ width: 360, height: 800 }, { width: 768, height: 900 }, { width: 1440, height: 900 }]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.width < 600 })
      await ev('window.scrollTo(0, 0)')
      await sleep(250)
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
      const file = join(OUT_DIR, 'ui-v3-' + vp.width + 'x' + vp.height + SUFFIX + '.png')
      writeFileSync(file, Buffer.from(shot.result.data, 'base64'))
      report.screenshots.push(file)
      const rect = await ev('(() => {'
        + ' const found = globalThis.__A5_CTA();'
        + ' if (!found.length) return null;'
        + ' const el = [...document.getElementById("view-root").querySelectorAll("button, a")].find((x) => (x.innerText || "").trim() === found[0].text);'
        + ' if (!el) return null;'
        + ' const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);'
        + ' return { text: (el.innerText || "").trim(), left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height, vw: innerWidth, vh: innerHeight, visibility: cs.visibility, display: cs.display };'
        + '})()')
      const ok = !!rect && rect.width > 0 && rect.height >= 40 && rect.left >= -1 && rect.right <= rect.vw + 1 && rect.top < rect.vh && rect.bottom > 0
      check('UI-15-viewport-' + vp.width, ok, '主 CTA@' + vp.width + 'px：' + JSON.stringify(rect) + ' screenshot=' + file)
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride')

    // 页面级异常/错误日志（CSP 违规等）
    const errors = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params && e.params.entry && e.params.entry.level === 'error'))
    check('UI-13-no-page-errors', errors.length === 0, '页面异常/错误日志 ' + errors.length + ' 条：' + JSON.stringify(errors.slice(0, 3)))
  } finally {
    if (cdp) await cdp.close()
    await gw.stop()
    rmSync(codexHome, { recursive: true, force: true })
    if (launched) {
      try { launched.child.kill('SIGKILL') } catch {}
      rmSync(launched.profile, { recursive: true, force: true })
    }
  }

  const failed = report.checks.filter((c) => !c.ok)
  console.log('SUMMARY ' + JSON.stringify({ checks: report.checks.length, passed: report.checks.length - failed.length, failed: failed.map((c) => c.id), screenshots: report.screenshots, notes: report.notes }))
  if (failed.length) {
    console.error('FAIL: ' + failed.length + ' 项产品断言未通过（可能是 A1/A3/A4 收尾未完成，也可能是真实回归）；未伪造通过。')
    process.exit(1)
  }
  process.exit(0)
}

main().catch((error) => {
  console.error((browserReady ? 'BROWSER_ACCEPTANCE_ERROR' : 'NOT_RUN_BROWSER') + ': ' + (error && error.stack ? error.stack : error))
  if (browserReady) {
    console.error('浏览器可用但验收流程中断：不是 PASS，按失败处理（exit 1）。')
    console.error('已完成的检查：' + JSON.stringify(report.checks))
  } else {
    console.error('复现：node scripts/e2e/ui-v3-browser.mjs --cdp ' + CDP_PORT)
  }
  process.exit(browserReady ? 1 : 2)
})
