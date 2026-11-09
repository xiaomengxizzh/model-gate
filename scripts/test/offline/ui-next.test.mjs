import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startGateway, root } from './harness.mjs'

test('F1 preview: independent static assets, content-types and protected API', {timeout:30000}, async t=>{
  const gw=await startGateway({name:'ui-next-preview',env:{MG_ADMIN_TOKEN:'preview-test-token'}})
  t.after(()=>gw.stop())
  const page=await gw.get('/ui-next')
  assert.equal(page.status,200)
  assert.match(page.headers.get('content-type'),/text\/html/)
  assert.match(page.headers.get('content-security-policy')||'',/default-src 'none'/)
  assert.match(page.headers.get('x-content-type-options')||'','nosniff')
  const html=await page.text()
  assert.match(html,/ModelGate/)
  assert.match(html,/\/ui-next\/app\.js/)
  assert.doesNotMatch(html,/<script[^>]*>[^<]+<\/script>/)
  const css=await gw.get('/ui-next/styles.css'),js=await gw.get('/ui-next/app.js')
  assert.equal(css.status,200);assert.match(css.headers.get('content-type'),/text\/css/)
  assert.equal(js.status,200);assert.match(js.headers.get('content-type'),/javascript/)
  assert.match(await js.text(),/\/api\/route-preview/)
  assert.equal((await gw.get('/ui-next/../../src/index.js')).status,404)
  assert.equal((await gw.get('/')).status,200,'legacy entry remains intact')
  assert.equal((await gw.get('/api/status')).status,401,'read-only UI does not weaken admin auth')
  const authorized=await gw.get('/api/status',{authorization:'Bearer preview-test-token'})
  assert.equal(authorized.status,200)
  const conf=await gw.get('/api/config',{authorization:'Bearer preview-test-token'})
  assert.equal(conf.status,200)
})
test('F1 preview: no external asset requests, persistent tokens or config writes in app script',()=>{
  const html=readFileSync(join(root,'src/ui-next/index.html'),'utf8')
  const js=readFileSync(join(root,'src/ui-next/app.js'),'utf8')
  assert.doesNotMatch(html,/https?:\/\/[^"'\s>]+/i)
  assert.doesNotMatch(js,/localStorage|sessionStorage|indexedDB/)
  assert.doesNotMatch(js,/innerHTML\s*=/)
  assert.doesNotMatch(js,/\/api\/config\/save|\/api\/keys|\/api\/model-test|\/api\/probe\b/)
})
