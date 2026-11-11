import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { startGateway, root } from './harness.mjs'

const ASSETS = [
  '/ui-next', '/ui-next/', '/ui-next/index.html', '/ui-next/styles.css', '/ui-next/app.js',
  '/ui-next/js/api.js', '/ui-next/js/store.js', '/ui-next/js/router.js', '/ui-next/js/dom.js',
  '/ui-next/js/format.js', '/ui-next/js/components.js', '/ui-next/js/config-draft.js', '/ui-next/js/save-flow.js',
  '/ui-next/js/views/dashboard.js', '/ui-next/js/views/providers.js', '/ui-next/js/views/models.js',
  '/ui-next/js/views/clients.js', '/ui-next/js/views/codex.js', '/ui-next/js/views/observability.js', '/ui-next/js/views/settings.js',
]

test('UI: static tree, CSP, auth and traversal protection', { timeout: 30000 }, async (t) => {
  const gw = await startGateway({ name: 'ui-next-preview', env: { MG_ADMIN_TOKEN: 'preview-test-token' } })
  t.after(() => gw.stop())
  const page = await gw.get('/ui-next')
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-type'), /text\/html/)
  const csp = page.headers.get('content-security-policy') || ''
  assert.match(csp, /default-src 'none'/)
  assert.match(csp, /script-src 'self'/)
  assert.match(csp, /frame-ancestors 'none'/)
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff')
  const html = await page.text()
  assert.match(html, /ModelGate/)
  assert.match(html, /\/ui-next\/app\.js/)
  assert.doesNotMatch(html, /<script[^>]*>[^<]+<\/script>/, 'no inline script')
  assert.doesNotMatch(html, /https?:\/\/[^"'\s>]+/i, 'no external asset URLs')
  for (const p of ASSETS) {
    const r = await gw.get(p)
    assert.equal(r.status, 200, p + ' should be served')
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
  }
  assert.match((await gw.get('/ui-next/js/api.js')).headers.get('content-type'), /javascript/)
  // traversal / extension / hidden-file attempts stay 404 and never fall through to data plane
  for (const p of ['/ui-next/../src/index.js', '/ui-next/js/../../src/index.js', '/ui-next/%2e%2e/%2e%2e/src/index.js', '/ui-next/..%2fsrc%2findex.js', '/ui-next/config/gateway.local.json', '/ui-next/foo.txt', '/ui-next/.env', '/ui-next/js/']) {
    const r = await gw.get(p)
    assert.equal(r.status, 404, p)
  }
  assert.equal((await gw.get('/')).status, 200, 'legacy entry remains intact')
  assert.equal((await gw.get('/admin')).status, 200, 'legacy /admin console must remain available (M4-2)')
  assert.equal((await gw.get('/api/status')).status, 401, 'read-only asset serving does not weaken admin auth')
  const authorized = await gw.get('/api/status', { authorization: 'Bearer preview-test-token' })
  assert.equal(authorized.status, 200)
  const conf = await gw.get('/api/config', { authorization: 'Bearer preview-test-token' })
  assert.equal(conf.status, 200)
  const body = await conf.json()
  assert.ok(Number.isFinite(body.configVersion))
  assert.equal(body.hasOwnProperty('_keys'), false)
  assert.equal(body.hasOwnProperty('_paths'), false)
})

test('UI source: no HTML injection sinks, no credential persistence, no fake data strings', () => {
  const modules = ASSETS.filter((p) => p.endsWith('.js')).map((p) => join(root, 'src/ui-next', p.replace('/ui-next/', '')))
  for (const f of modules) {
    assert.ok(existsSync(f), f)
    const src = readFileSync(f, 'utf8')
    assert.doesNotMatch(src, /innerHTML\s*=/, f + ' must not assign innerHTML')
    assert.doesNotMatch(src, /insertAdjacentHTML/, f)
    assert.doesNotMatch(src, /sessionStorage|indexedDB/, f + ' must not persist tokens/state')
    assert.doesNotMatch(src, /localStorage\.setItem\((['"])(?!mg-theme)/, f + ' may only persist theme')
  }
  // M4-2：状态机/401 清理/导出所有权/旧入口保留的源码级不变量。
  const readSrc = (rel) => readFileSync(join(root, 'src/ui-next', rel), 'utf8')
  assert.match(readSrc('js/store.js'), /DATA_PHASES/, 'store 必须显式定义数据阶段')
  assert.match(readSrc('js/store.js'), /handleUnauthorized/, '401/403 必须有统一清理入口')
  assert.match(readSrc('js/api.js'), /res\.status === 401 && opts\.authEvent/, '只有 401 才触发会话失效清理')
  assert.doesNotMatch(readSrc('js/api.js'), /res\.status === 403/, '功能级 403 不得进入会话失效路径')
  assert.match(readSrc('app.js'), /phaseOf\('status'\) === 'loading'/, 'loading 骨架必须由 phase 驱动')
  assert.match(readSrc('app.js'), /loadStatus\(\{ silent: true \}\)/, '后台轮询必须静默，不得把视图替换成骨架')
  assert.match(readSrc('js/views/clients.js'), /受控写入未启用/, 'clients 必须对功能级 403 给出局部提示')
  assert.match(readSrc('js/config-draft.js'), /buildSavePayload/, '保存 payload 必须有单一构造入口')
  assert.match(readSrc('js/save-flow.js'), /sanitizeDiff/, '差异展示必须经过脱敏')
  assert.match(readSrc('js/save-flow.js'), /saveDraft/, '保存必须走去抖入口')
  assert.match(readSrc('js/views/clients.js'), /modelgate-client-export\/1/, '客户端导出 schema 必须存在')
  assert.match(readSrc('js/views/clients.js'), /退役条件/, '旧面板退役条件必须写入代码')
  assert.match(readSrc('js/views/models.js'), /expiresAtState/, '有效期状态必须使用后端投影')
  assert.match(readSrc('js/views/settings.js'), /sanitizeForExport/, '管理导出必须可测试/可复用')
  const html = readFileSync(join(root, 'src/ui-next/index.html'), 'utf8')
  assert.doesNotMatch(html, /https?:\/\/[^"'\s>]+/i)
  assert.doesNotMatch(html, /localStorage\.(setItem|getItem)|sessionStorage/)
})
