// M4-1b：/api/codex/* 管理面入口接线（P0-2 收口）的 HTTP 级回归。
// 真实隔离网关子进程（127.0.0.1 随机端口）+ 合成管理令牌；不联网、不读 HOME、不写正式配置。
// 关键断言：显式管理员与可信来源都在读 body 之前；未设置令牌不再有 loopback 放行。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startGateway } from './harness.mjs'

const TOKEN = 'm4-1b-test-admin-token'
const USER_CONFIG = [
  '# M4-1b fixture：外部段只应留在文件里',
  'model = "gpt-5"',
  '',
  '[mcp_servers.docs]',
  'command = "node"',
  'env = { API_KEY = "sk-ENTRY-SENTINEL-MCP" }',
  '',
].join('\n')
const DESIRED = {
  topLevel: {
    model: 'mg/demo-aggregate',
    model_provider: 'openai',
    openai_base_url: 'http://127.0.0.1:8787',
    model_catalog_json: '/tmp/mg-catalog/codex-catalog.json',
  },
}

function raw (base, path, opts = {}) {
  const u = new URL(base + path)
  return new Promise((resolve) => {
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers: opts.headers || {},
    }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(data) } catch {}
        resolve({ status: res.statusCode, body: data, json })
      })
    })
    req.on('error', (e) => resolve({ status: 0, error: String(e && e.message ? e.message : e) }))
    if (opts.body !== undefined && opts.body !== null) req.write(opts.body)
    req.end()
  })
}

async function readLogs (gw) {
  let names = []
  try { names = (await readdir(gw.dir)).filter((n) => n.endsWith('.log')).sort() } catch {}
  const parts = []
  for (const n of names) { try { parts.push(await readFile(join(gw.dir, n), 'utf8')) } catch {} }
  return parts.join('\n')
}

function bearer (extra = {}) {
  return Object.assign({ authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, extra)
}

function lanIPv4 () {
  for (const list of Object.values(networkInterfaces())) {
    for (const n of list || []) {
      if (n && n.family === 'IPv4' && !n.internal && !n.address.startsWith('169.254.')) return n.address
    }
  }
  return null
}

test('P0-2 入口：无令牌 ⇒ 403 且未读 body（超大 Content-Length 也不会 413）', { timeout: 30000 }, async (t) => {
  const gw = await startGateway({ name: 'm4-1b-anon' })
  t.after(() => gw.stop())
  const started = Date.now()
  // 声明 1MiB body 但一个字节都不发：若入口先读 body，这里会挂住；收到 403 即证明没读。
  const out = await raw(gw.base, '/api/codex/config/plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': String(1024 * 1024) },
  })
  const elapsed = Date.now() - started
  assert.equal(out.status, 403, JSON.stringify(out))
  assert.equal(out.json.code, 'explicit_admin_required')
  assert.ok(elapsed < 3000, '必须立刻 403 而不是等待 body：' + elapsed + 'ms')
  // 旧 /api/* 的本机初始化语义不变（本卡不扩大范围）
  assert.equal((await gw.get('/api/status')).status, 200)
})

test('P0-2 入口：错令牌/缺令牌 403；正确令牌 + 回环 + 同源 200；日志不含令牌', { timeout: 30000 }, async (t) => {
  const gw = await startGateway({ name: 'm4-1b-token', env: { MG_ADMIN_TOKEN: TOKEN } })
  t.after(() => gw.stop())

  const missing = await gw.get('/api/codex/policy')
  assert.equal(missing.status, 403)
  assert.equal((await missing.json()).code, 'explicit_admin_required')

  const wrong = await raw(gw.base, '/api/codex/policy', { headers: { authorization: 'Bearer wrong-token' } })
  assert.equal(wrong.status, 403, JSON.stringify(wrong))
  assert.equal(wrong.json.code, 'explicit_admin_required')

  const ok = await raw(gw.base, '/api/codex/policy', { headers: bearer() })
  assert.equal(ok.status, 200, JSON.stringify(ok))
  assert.equal(ok.json.ok, true)
  assert.equal(ok.json.auth.explicitAdminRequired, true)
  assert.equal(ok.json.auth.adminSubjectBound, true)
  assert.equal(JSON.stringify(ok.json).includes(TOKEN), false, '响应不得回显管理令牌')

  // 跨源（即使带正确令牌）必须 403，且在读 body 之前
  const cross = await raw(gw.base, '/api/codex/config/plan', {
    method: 'POST',
    headers: bearer({ origin: 'http://evil.example', 'content-length': String(1024 * 1024) }),
  })
  assert.equal(cross.status, 403, JSON.stringify(cross))
  assert.match(String(cross.json && cross.json.error), /跨源/)

  // 日志（含审计与拒绝日志）不得出现令牌本体
  const text = await readLogs(gw)
  assert.equal(text.includes(TOKEN), false, 'logs must not contain the admin token')
  assert.ok(text.includes('explicit_admin_required') || text.includes('codex admin denied'), 'denials should be auditable by code')
})

test('P0-2 入口：非回环 peer 403；显式 allowRemote 才放行', { timeout: 40000 }, async (t) => {
  const lan = lanIPv4()
  if (!lan) { t.diagnostic('本机无非回环 IPv4，跳过远程 peer 断言'); return }
  const gw = await startGateway({
    name: 'm4-1b-remote',
    env: { MG_ADMIN_TOKEN: TOKEN },
    config: { server: { host: '0.0.0.0' } },
  })
  t.after(() => gw.stop())
  const remote = 'http://' + lan + ':' + gw.port
  const denied = await fetch(remote + '/api/codex/policy', { headers: { authorization: 'Bearer ' + TOKEN } })
  assert.equal(denied.status, 403)
  assert.equal((await denied.json()).code, 'remote_forbidden')

  const allowed = await startGateway({
    name: 'm4-1b-remote-ok',
    env: { MG_ADMIN_TOKEN: TOKEN, MG_ADMIN_ALLOW_REMOTE: '1' },
    config: { server: { host: '0.0.0.0' } },
  })
  t.after(() => allowed.stop())
  const okRemote = await fetch('http://' + lan + ':' + allowed.port + '/api/codex/policy', { headers: { authorization: 'Bearer ' + TOKEN } })
  assert.equal(okRemote.status, 200)
})

test('managedRoot 默认关闭：apply/rollback 403 write_disabled（不是 404）', { timeout: 30000 }, async (t) => {
  const gw = await startGateway({ name: 'm4-1b-managed-off', env: { MG_ADMIN_TOKEN: TOKEN } })
  t.after(() => gw.stop())
  const apply = await raw(gw.base, '/api/codex/config/apply', {
    method: 'POST',
    headers: bearer(),
    body: JSON.stringify({ root: 'managed-root', desired: DESIRED }),
  })
  assert.equal(apply.status, 403, JSON.stringify(apply))
  assert.equal(apply.json.code, 'write_disabled')
  const rollback = await raw(gw.base, '/api/codex/config/rollback', {
    method: 'POST',
    headers: bearer(),
    body: JSON.stringify({ root: 'managed-root', backupId: 'bk_' + 'a'.repeat(32) }),
  })
  assert.equal(rollback.status, 403)
  assert.equal(rollback.json.code, 'write_disabled')
})

test('MG_CODEX_MANAGED_ROOT：启动期登记 → plan 只回白名单字段差异、无哨兵；apply/rollback 可用', { timeout: 40000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'm4-1b-managed-'))
  const configPath = join(dir, 'config.toml')
  await writeFile(configPath, USER_CONFIG, 'utf8')
  const gw = await startGateway({
    name: 'm4-1b-managed',
    env: { MG_ADMIN_TOKEN: TOKEN, MG_CODEX_MANAGED_ROOT: configPath },
  })
  t.after(async () => { await gw.stop(); await rm(dir, { recursive: true, force: true }) })

  const policy = await raw(gw.base, '/api/codex/policy', { headers: bearer() })
  assert.equal(policy.status, 200)
  assert.equal(policy.json.write.available, true)
  assert.equal(policy.json.write.requiresManagedRoot, true)

  const plan = await raw(gw.base, '/api/codex/config/plan', {
    method: 'POST',
    headers: bearer(),
    body: JSON.stringify({ root: 'managed-root', desired: DESIRED }),
  })
  assert.equal(plan.status, 200, JSON.stringify(plan))
  assert.equal(plan.json.root, 'managed-root')
  assert.ok(Array.isArray(plan.json.changed) && plan.json.changed.length > 0)
  assert.ok(plan.json.changed.every((c) => typeof c.field === 'string' && Object.prototype.hasOwnProperty.call(c, 'from') && Object.prototype.hasOwnProperty.call(c, 'to') && c.owner === 'modelgate'))
  assert.ok(!Object.prototype.hasOwnProperty.call(plan.json, 'diff'))
  const planText = JSON.stringify(plan.json)
  assert.equal(planText.includes('sk-ENTRY-SENTINEL-MCP'), false, 'plan 不得回保留行原文/哨兵')
  assert.equal(planText.includes('mcp_servers'), false, 'plan 不得回外部段内容')

  const applied = await raw(gw.base, '/api/codex/config/apply', {
    method: 'POST',
    headers: bearer(),
    body: JSON.stringify({ root: 'managed-root', desired: DESIRED, expected: plan.json.before, confirmToken: plan.json.confirmToken }),
  })
  assert.equal(applied.status, 200, JSON.stringify(applied))
  assert.equal(applied.json.wrote, true)
  assert.match(String(applied.json.backupId), /^bk_[a-f0-9]{32}$/)
  assert.equal(JSON.stringify(applied.json).includes(configPath), false, '响应不得回文件路径')
  const written = await readFile(configPath, 'utf8')
  assert.ok(written.includes('model = "mg/demo-aggregate"'))
  assert.ok(written.includes('sk-ENTRY-SENTINEL-MCP'), '未管理行必须逐字节保留在文件里')

  const rolled = await raw(gw.base, '/api/codex/config/rollback', {
    method: 'POST',
    headers: bearer(),
    body: JSON.stringify({ root: 'managed-root', backupId: applied.json.rollback.backupId, expectedSha256: applied.json.rollback.expectedSha256, confirmToken: applied.json.rollback.confirmToken }),
  })
  assert.equal(rolled.status, 200, JSON.stringify(rolled))
  assert.equal(await readFile(configPath, 'utf8'), USER_CONFIG)

  // 重启语义：registry 是进程内的；新进程必须重新登记（同 env 即可），旧 backupId 不跨进程。
  const logs = await readLogs(gw)
  assert.equal(logs.includes(TOKEN), false, 'logs must not contain the admin token')
  assert.ok(logs.includes('managed root 已登记'), '启动日志应记录受控根已登记（不含路径/令牌）')
})
