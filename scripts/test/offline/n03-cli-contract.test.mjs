// N03：管理 CLI 契约（纯检出可跑 doctor；写路径绑定 planId；管理/只读/数据面隔离）。
// 全部使用本地隔离配置与 mock 网关，不触达真实上游、不写全局文件。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { root, startGateway } from './harness.mjs'
import { handleCodexApi, planIdFor, CODEX_API_VERSION } from '../../../src/codex/api.js'

const CLI = join(root, 'bin', 'mg.mjs')

function cli(args, env = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 40000,
    env: Object.assign({}, process.env, {
      MG_CONFIG: '', MG_CONFIG_DIR: '', MG_ADMIN_TOKEN: '', MG_CLI_ALLOW_REMOTE: '',
      ...env,
    }),
  })
  let json = null
  try { json = JSON.parse(res.stdout) } catch { json = null }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, json }
}

async function tempConfig(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mg-n03-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const path = join(dir, 'gateway.json')
  await writeFile(path, JSON.stringify({
    server: { host: '127.0.0.1', port: 8899 },
    providers: {
      opencodego: { baseUrl: 'https://opencode.ai/inference/go', api: 'openai', apiKeyEnv: 'SYNTHETIC_GO_KEY_ID' },
      other: { baseUrl: 'https://other.example/v1', api: 'openai' },
    },
    models: {
      'mg-a': { provider: 'opencodego', api: 'openai', maxContext: 128000, alias: ['a1'], effortOptions: ['low', 'high'] },
      plain: { provider: 'other', api: 'openai' },
    },
    defaults: { model: 'mg-a' },
  }))
  return { dir, path }
}

test('N03 CLI doctor：纯检出可跑、纯 JSON、声明不联网、不读全局配置', () => {
  const out = cli(['doctor', '--json'])
  assert.equal(out.status, 0, out.stderr)
  assert.equal(out.json.ok, true)
  assert.equal(out.json.contract, 'modelgate.cli/1')
  assert.equal(out.json.apiVersion, CODEX_API_VERSION)
  assert.equal(out.json.noNetwork, true)
  const configCheck = out.json.checks.find((c) => c.id === 'config')
  assert.equal(configCheck.status, 'unknown')
  assert.equal(configCheck.nextAction, 'pass-explicit-config')
  assert.equal(out.json.checks.find((c) => c.id === 'live.upstream').status, 'unknown')
})

test('N03 只读命令：provider/model/route 用显式配置，不打印凭据', async (t) => {
  const { path } = await tempConfig(t)
  const list = cli(['provider', 'list', '--config', path, '--json'], { SYNTHETIC_GO_KEY_ID: 'synthetic-key-value' })
  assert.equal(list.status, 0, list.stderr)
  assert.equal(list.json.readOnly, true)
  const go = list.json.providers.find((p) => p.id === 'opencodego')
  assert.equal(go.host, 'opencode.ai')
  assert.equal(go.keyRef, 'env')
  assert.equal(list.stdout.includes('synthetic-key-value'), false, '不得回显 key 值或环境变量名')

  const show = cli(['provider', 'show', 'opencodego', '--config', path, '--json'])
  assert.equal(show.status, 0, show.stderr)
  assert.equal(show.json.provider.go.ok, true)
  assert.equal(show.json.provider.go.binding, 'go-v1')
  assert.equal(show.json.provider.identity, 'thirdParty')

  const models = cli(['model', 'list', '--config', path, '--json'])
  const mgA = models.json.models.find((m) => m.name === 'mg-a')
  assert.deepEqual(mgA.alias, ['a1'])
  assert.equal(models.json.readOnly, true)

  const explain = cli(['route', 'explain', '--model', 'a1', '--config', path, '--json'])
  assert.equal(explain.status, 0, explain.stderr)
  assert.equal(explain.json.route.resolved, true)
  assert.equal(explain.json.route.provider, 'opencodego')

  const missing = cli(['route', 'explain', '--model', 'mg-ghost', '--config', path, '--json'])
  assert.equal(missing.status, 5, '聚合保留 ID 未命中应 404/exit 5')
  assert.equal(missing.json.route.resolved, false)
  assert.equal(missing.json.route.zeroUpstream, true)
})

test('N03 client codex export：只读模板，角色样例标注 provider 覆盖不支持', async (t) => {
  const { path } = await tempConfig(t)
  const out = cli(['client', 'codex', 'export', '--base-url', 'http://127.0.0.1:9999', '--config', path, '--json'])
  assert.equal(out.status, 0, out.stderr)
  assert.equal(out.json.readOnly, true)
  assert.equal(out.json.writesFiles, false)
  assert.match(out.json.text, /model = "mg-a"/)
  assert.match(out.json.text, /# alias a1 -> mg-a/)
  assert.equal(out.json.samples.role.providerOverride, 'unsupported')
})

test('N03 管理面：403、版本协商、授权先于 body、planId 绑定', async () => {
  let bodyTouched = 0
  const ctx = { method: 'POST', path: '/api/codex/config/plan', explicitAdmin: false, get body() { bodyTouched++; throw new Error('body must not be read before auth') } }
  const denied = await handleCodexApi(ctx)
  assert.equal(denied.status, 403)
  assert.equal(denied.body.code, 'explicit_admin_required')
  assert.equal(denied.body.apiVersion, CODEX_API_VERSION)
  assert.equal(bodyTouched, 0, '鉴权必须先于 body 读取')

  const badVersion = await handleCodexApi({ method: 'POST', path: '/api/codex/config/plan', explicitAdmin: true, adminSubject: 'admin-test', isLocal: true, apiVersion: 'mg-management/999', get body() { bodyTouched++; throw new Error('body must not be read') } })
  assert.equal(badVersion.status, 400)
  assert.equal(badVersion.body.code, 'unsupported_api_version')
  assert.equal(bodyTouched, 0)

  const a = planIdFor('token-a')
  assert.match(a, /^pl_[0-9a-f]{24}$/)
  assert.equal(a, planIdFor('token-a'))
  assert.notEqual(a, planIdFor('token-b'))
  assert.equal(JSON.stringify(a).includes('token-a'), false)

  const applyCtx = { method: 'POST', path: '/api/codex/config/apply', explicitAdmin: true, adminSubject: 'admin-test', isLocal: true, managedRoot: true, apiVersion: CODEX_API_VERSION, body: { root: 'managed-root', desired: { topLevel: { model: 'x' } }, expected: { exists: false, size: 0, sha256: '', mtimeMs: 0 }, confirmToken: 'token-a' } }
  const noPlan = await handleCodexApi(applyCtx)
  assert.equal(noPlan.status, 400)
  assert.equal(noPlan.body.code, 'plan_id_required')
  const mismatch = await handleCodexApi(Object.assign({}, applyCtx, { body: Object.assign({}, applyCtx.body, { planId: planIdFor('other') }) }))
  assert.equal(mismatch.status, 409)
  assert.equal(mismatch.body.code, 'plan_id_mismatch')
})

test('N03 CLI 写路径：loopback/令牌门禁 + plan→apply→rollback（临时配置）', { timeout: 60000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mg-n03-e2e-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const configToml = join(dir, 'config.toml')
  await writeFile(configToml, 'model = "legacy-model"\nmodel_provider = "openai"\n')
  const gw = await startGateway({
    name: 'n03-api',
    env: { MG_ADMIN_TOKEN: 'synthetic-admin-token', MG_CODEX_MANAGED_ROOT: configToml },
    config: { providers: {}, models: {} },
  })
  t.after(async () => { await gw.stop() })

  const remote = cli(['config', 'plan', '--base-url', 'http://192.0.2.1:9', '--root', 'managed-root', '--desired', '{"topLevel":{"model":"x"}}', '--json'])
  assert.equal(remote.status, 1)
  assert.equal(remote.json.code, 'remote_target_forbidden')

  const noToken = cli(['config', 'plan', '--base-url', gw.base, '--root', 'managed-root', '--desired', '{"topLevel":{"model":"x"}}', '--json'])
  assert.equal(noToken.status, 2)
  assert.equal(noToken.json.code, 'admin_token_missing')

  const badToken = cli(['config', 'plan', '--base-url', gw.base, '--root', 'managed-root', '--desired', '{"topLevel":{"model":"x"}}', '--json'], { MG_ADMIN_TOKEN: 'wrong-token' })
  assert.equal(badToken.status, 3, badToken.stderr)
  assert.equal(badToken.json.code, 'explicit_admin_required')

  const env = { MG_ADMIN_TOKEN: 'synthetic-admin-token' }
  const planned = cli(['config', 'plan', '--base-url', gw.base, '--root', 'managed-root', '--desired', '{"topLevel":{"model":"mg-a"}}', '--api-version', CODEX_API_VERSION, '--json'], env)
  assert.equal(planned.status, 0, planned.stderr)
  assert.match(planned.json.planId, /^pl_/)
  assert.ok(planned.json.confirmToken)
  assert.equal(planned.json.wrote, false)
  assert.ok(planned.json.redactedDiff.some((r) => r.field === 'model'))

  const badVersion = cli(['config', 'plan', '--base-url', gw.base, '--root', 'managed-root', '--desired', '{"topLevel":{"model":"x"}}', '--api-version', 'mg-management/999', '--json'], env)
  assert.equal(badVersion.status, 1)
  assert.equal(badVersion.json.code, 'unsupported_api_version')

  const noPlan = cli(['config', 'apply', '--base-url', gw.base, '--root', 'managed-root', '--desired', '{"topLevel":{"model":"mg-a"}}', '--confirm-token', planned.json.confirmToken, '--json'], env)
  assert.equal(noPlan.status, 1)
  assert.equal(noPlan.json.code, 'plan_required')

  const expected = JSON.stringify(planned.json.before)
  const applied = cli(['config', 'apply', '--base-url', gw.base, '--root', 'managed-root', '--plan', planned.json.planId, '--confirm-token', planned.json.confirmToken, '--desired', '{"topLevel":{"model":"mg-a"}}', '--expected', expected, '--yes', '--json'], env)
  assert.equal(applied.status, 0, applied.stderr)
  assert.equal(applied.json.wrote, true)
  assert.ok(applied.json.backupId)
  assert.ok(applied.json.rollback && applied.json.rollback.planId)
  const afterText = await readFile(configToml, 'utf8')
  assert.match(afterText, /model = "mg-a"/)

  const rb = cli(['config', 'rollback', '--base-url', gw.base, '--root', 'managed-root', '--plan', applied.json.rollback.planId, '--confirm-token', applied.json.rollback.confirmToken, '--backup-id', applied.json.rollback.backupId, '--expected-sha256', applied.json.rollback.expectedSha256, '--yes', '--json'], env)
  assert.equal(rb.status, 0, rb.stderr)
  assert.equal(rb.json.wrote, true)
  const restored = await readFile(configToml, 'utf8')
  assert.match(restored, /model = "legacy-model"/)
})
