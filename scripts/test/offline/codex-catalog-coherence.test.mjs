import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startGateway, startScriptedUpstream, root as repoRoot } from './harness.mjs'

// D2×D1 一致性：/v1/models 与路由必须同源；模型下架后立即 404 且零上游。
// 目录基线用官方导出样本（/tmp/mg-e0/catalog-default.json）；不存在时跳过该组断言。

async function catalogBase() {
  const p = process.env.MG_E3_CATALOG_BASE || '/tmp/mg-e0/catalog-default.json'
  try { return JSON.parse(await readFile(p, 'utf8')) } catch { return null }
}

test('目录与路由同源：/v1/models 列出聚合 slug，下架后 404 且零上游', { timeout: 60000 }, async (t) => {
  const base = await catalogBase()
  if (!base) { t.skip('缺少官方目录基线样本'); return }
  const hits = []
  const up = await startScriptedUpstream(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    hits.push({ model: JSON.parse(Buffer.concat(chunks).toString('utf8')).model })
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ id: 'c1', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
  })
  const gw = await startGateway({
    env: { MG_ADMIN_TOKEN: '' },
    config: {
      providers: { third: { baseUrl: up.base + '/v1', api: 'openai' } },
      models: {
        alpha: { provider: 'third', api: 'openai', maxContext: 128000 },
        beta: { provider: 'third', api: 'openai', maxContext: 128000 },
      },
      defaults: { model: '', codexOfficialProvider: 'codex-official', codexCatalogBasePath: process.env.MG_E3_CATALOG_BASE || '/tmp/mg-e0/catalog-default.json' },
    },
  })
  t.after(async () => { await gw.stop(); await up.stop() })

  const models1 = await gw.get('/v1/models?client_version=0.167.0').then((r) => r.json())
  const slugs1 = (models1.models || []).map((m) => m.slug)
  assert.ok(slugs1.includes('mg-third-alpha'), '目录应包含 mg-third-alpha：' + slugs1.slice(-3))
  assert.ok(slugs1.includes('mg-third-beta'), '目录应包含 mg-third-beta')

  const ok = await gw.call('/v1/responses', { method: 'POST', body: { model: 'mg-third-alpha', input: 'hi', stream: false } })
  assert.equal(ok.status, 200)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].model, 'alpha', '上游必须收到原始模型名，而不是 slug')

  // 下架 beta：改配置文件后 reload
  const cfgPath = join(gw.dir, 'gateway.json')
  const cfg = JSON.parse(await readFile(cfgPath, 'utf8'))
  delete cfg.models.beta
  await writeFile(cfgPath, JSON.stringify(cfg))
  const reload = await gw.call('/api/config/reload', { method: 'POST' })
  assert.equal(reload.status, 200)

  const models2 = await gw.get('/v1/models?client_version=0.167.0').then((r) => r.json())
  const slugs2 = (models2.models || []).map((m) => m.slug)
  assert.ok(!slugs2.includes('mg-third-beta'), '下架后目录不得再列出 beta')
  assert.ok(slugs2.includes('mg-third-alpha'), 'alpha 仍应存在')

  const before = hits.length
  const gone = await gw.call('/v1/responses', { method: 'POST', body: { model: 'mg-third-beta', input: 'hi', stream: false } })
  assert.equal(gone.status, 404)
  const body = await gone.json()
  assert.equal(body.error.type, 'unknown_model')
  assert.equal(hits.length, before, '下架的聚合 ID 必须零上游请求')
})
