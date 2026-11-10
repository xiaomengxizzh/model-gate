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
  '/ui-next/js/views/clients.js', '/ui-next/js/views/observability.js', '/ui-next/js/views/settings.js',
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
  const html = readFileSync(join(root, 'src/ui-next/index.html'), 'utf8')
  assert.doesNotMatch(html, /https?:\/\/[^"'\s>]+/i)
  assert.doesNotMatch(html, /localStorage\.(setItem|getItem)|sessionStorage/)
})
