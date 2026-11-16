// MG-FIX-P1-05：Codex 原生命名子代理配置/子文件托管回归（离线、隔离临时目录）。
// 覆盖：空白/既有用户零手工 TOML、字节兼容回滚、用户改动 409 三方差异、崩溃恢复、显式关闭。
// 全部在 OS 临时目录；不读真实 HOME、不碰 ~/.codex、不联网、不执行 Desktop、不调用付费模型。
import test from 'node:test'
import assert from 'node:assert/strict'
import { stat } from 'node:fs/promises'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildManagedAgentConfig,
  sha256Hex,
  unmanagedFingerprint,
} from '../../../src/codex/config.js'
import {
  DESKTOP_CONTRACT,
  DesktopError,
  activate,
  deactivate,
  preview,
  status,
} from '../../../src/codex/desktop-integration.js'

const MODEL = 'mg-opencodego-deepseek-v4-1-flash'
const CATALOG = JSON.stringify({ models: [{ slug: MODEL, display_name: 'DeepSeek V4.1 Flash' }] })
const USER_CONFIG = [
  '# 用户自己的配置（fixture，非 ModelGate 托管）',
  'model = "gpt-5"',
  'model_provider = "openai"',
  'approval_policy = "on-request"',
  '',
  '[mcp_servers.docs]',
  'command = "node"',
  '',
  '[model_providers.myproxy]',
  'name = "My Proxy"',
  'base_url = "https://proxy.example/v1"',
  '',
].join('\n')

async function fixture (configText, childText) {
  const dir = await mkdtemp(join(tmpdir(), 'mg-agg-desktop-agent-'))
  const configPath = join(dir, 'config.toml')
  const childPath = join(dir, 'go-deepseek.toml')
  const catalogPath = join(dir, 'catalog.json')
  await writeFile(catalogPath, CATALOG)
  if (configText !== undefined) await writeFile(configPath, configText)
  if (childText !== undefined) await writeFile(childPath, childText)
  return {
    dir, configPath, childPath, catalogPath,
    opts: {
      codexHome: dir,
      configPath,
      managedAgentPath: childPath,
      baseUrl: 'http://127.0.0.1:18787',
      model: MODEL,
      catalogPath,
      disableExec: true,
      verifyGateway: async () => ({ ok: true, status: 200, ms: 1 }),
    },
    cleanup: async () => { await rm(dir, { recursive: true, force: true }) },
  }
}

function canonicalChild () {
  return buildManagedAgentConfig({ model: MODEL }).child.text
}

async function activateFully (f, extra) {
  const p = preview(Object.assign({}, f.opts, extra))
  assert.equal(p.ok, true, 'preview 必须可用')
  return activate(Object.assign({}, f.opts, extra, { consentToken: p.consentToken, expectedSha: p.expectedSha }))
}

test('空白用户：启用即写入原生多代理字段与子文件，零手工 TOML', async (t) => {
  const f = await fixture(undefined)
  t.after(f.cleanup)
  const p = preview(f.opts)
  assert.equal(p.contract, DESKTOP_CONTRACT)
  assert.equal(p.agentChild.action, 'create')
  assert.equal(p.agentChild.managed, true)
  assert.equal(p.consentRequired, true, '含子文件写入必须显式同意')
  assert.ok(p.rows.some((r) => r.path === 'features.multi_agent' && r.kind === 'add'))
  assert.ok(p.rows.some((r) => r.path === 'agents.go_deepseek.config_file' && r.kind === 'add'))

  const applied = await activateFully(f)
  assert.equal(applied.ok, true)
  const text = await readFile(f.configPath, 'utf8')
  assert.match(text, /^\[features\][\s\S]*?multi_agent = true$/m)
  assert.match(text, /^\[agents\.go_deepseek\]$/m)
  assert.match(text, /^config_file = "go-deepseek\.toml"$/m)
  assert.match(text, /^description = "OpenCode Go DeepSeek.*"$/m)
  assert.equal(await readFile(f.childPath, 'utf8'), canonicalChild())
  assert.equal((await stat(f.childPath)).mode & 0o777, 0o600, '子文件必须 0600')
  const s = status({ configPath: f.configPath, managedAgentPath: f.childPath })
  assert.equal(s.agentChild.managed, true)
  assert.equal(s.agentChild.current.exists, true)
})

test('既有配置用户：只改托管字段，用户行逐字节保留，子文件自动创建', async (t) => {
  const f = await fixture(USER_CONFIG)
  t.after(f.cleanup)
  const applied = await activateFully(f)
  assert.equal(applied.ok, true)
  const after = await readFile(f.configPath, 'utf8')
  assert.equal(unmanagedFingerprint(USER_CONFIG), unmanagedFingerprint(after), '非托管行必须逐字节保留')
  assert.match(after, /^\[agents\.go_deepseek\]$/m)
  assert.equal(await readFile(f.childPath, 'utf8'), canonicalChild())
})

test('退出聚合：新建子文件被删除且配置逐字节恢复（空白与既有用户）', async (t) => {
  for (const initial of [undefined, USER_CONFIG]) {
    const f = await fixture(initial)
    const applied = await activateFully(f)
    assert.ok(applied.agentChild && applied.agentChild.action === 'create')
    const out = await deactivate({ configPath: f.configPath, managedAgentPath: f.childPath, expectedSha: applied.sha })
    assert.equal(out.ok, true)
    assert.equal(out.agentChild.removed, true, '我们新建的子文件退出时必须删除')
    assert.equal(await readFile(f.childPath, 'utf8').then(() => true, () => false), false)
    if (initial === undefined) assert.equal(await readFile(f.configPath, 'utf8').then(() => true, () => false), false)
    else assert.equal(await readFile(f.configPath, 'utf8'), initial, '既有配置必须逐字节恢复')
    await f.cleanup()
  }
})

test('认领既有规范子文件：不覆盖；退出保留；被用户改过则 409 三方差异', async (t) => {
  const f = await fixture(USER_CONFIG, canonicalChild())
  t.after(f.cleanup)
  const beforeChild = await readFile(f.childPath, 'utf8')
  const applied = await activateFully(f)
  assert.equal(applied.ok, true)
  // 认领路径 action 为 same，我们没写子文件；字节完全不变。
  assert.equal(await readFile(f.childPath, 'utf8'), beforeChild)
  const out = await deactivate({ configPath: f.configPath, managedAgentPath: f.childPath, expectedSha: applied.sha })
  assert.equal(out.ok, true)
  assert.equal(await readFile(f.childPath, 'utf8'), beforeChild, '认领的子文件退出时保持原状')

  // 再启用后用户自行修改子文件 → 退出 409，零写入。
  const f2 = await fixture(USER_CONFIG, canonicalChild())
  t.after(f2.cleanup)
  const a2 = await activateFully(f2)
  await writeFile(f2.childPath, 'model = "user-own-model"\nmodel_reasoning_effort = "high"\n')
  const configBefore = await readFile(f2.configPath, 'utf8')
  let conflict = null
  try { await deactivate({ configPath: f2.configPath, managedAgentPath: f2.childPath, expectedSha: a2.sha }) } catch (e) { conflict = e }
  assert.ok(conflict instanceof DesktopError)
  assert.equal(conflict.code, 'agent_child_modified')
  assert.equal(conflict.status, 409)
  assert.ok(conflict.detail.threeWay && conflict.detail.threeWay.theirs)
  assert.equal(await readFile(f2.configPath, 'utf8'), configBefore, '冲突时 config.toml 不得被写入')
  assert.equal(status({ configPath: f2.configPath, managedAgentPath: f2.childPath }).mode, 'aggregated')
})

test('非规范已存在子文件：启用 409 三方差异，绝不覆盖（preview 阻断 + activate 拒绝）', async (t) => {
  const injected = 'model = "user-own"\nmodel_reasoning_effort = "high"\n'
  const f = await fixture(undefined, injected)
  t.after(f.cleanup)
  const p = preview(f.opts)
  assert.equal(p.ok, false)
  assert.equal(p.agentChild.action, 'conflict')
  assert.ok(p.blocked.some((b) => b.code === 'agent_child_modified'))
  assert.equal(p.consentToken, null)

  let conflict = null
  try {
    await activate(Object.assign({}, f.opts, { consentToken: 'any', expectedSha: '' }))
  } catch (e) { conflict = e }
  assert.ok(conflict instanceof DesktopError)
  assert.equal(conflict.code, 'agent_child_modified')
  assert.equal(conflict.status, 409)
  assert.ok(conflict.detail.threeWay && conflict.detail.threeWay.oursVsTheirs)
  assert.equal(await readFile(f.childPath, 'utf8'), injected, '冲突时子文件不得被覆盖')
  assert.equal(await readFile(f.configPath, 'utf8').then(() => true, () => false), false, '冲突时 config.toml 不得被创建')
})

test('用户改动托管字段 [agents.go_deepseek]：退出 409 三方差异，零写入', async (t) => {
  const f = await fixture(USER_CONFIG)
  t.after(f.cleanup)
  const applied = await activateFully(f)
  const edited = (await readFile(f.configPath, 'utf8')).replace(/^config_file = .*$/m, 'config_file = "hijacked.toml"')
  await writeFile(f.configPath, edited)
  const childBefore = await readFile(f.childPath, 'utf8')
  let conflict = null
  try { await deactivate({ configPath: f.configPath, managedAgentPath: f.childPath, expectedSha: applied.sha }) } catch (e) { conflict = e }
  assert.ok(conflict instanceof DesktopError)
  assert.equal(conflict.code, 'concurrent_modification')
  assert.equal(conflict.status, 409)
  assert.ok(conflict.detail.restoreConflicts.some((c) => c.path === 'agents.go_deepseek.config_file'))
  assert.equal(await readFile(f.configPath, 'utf8'), edited, '冲突时不得写入 config.toml')
  assert.equal(await readFile(f.childPath, 'utf8'), childBefore, '冲突时不得触碰子文件')
})

test('显式 managedAgent:false：不写托管字段也不写子文件', async (t) => {
  const f = await fixture(undefined)
  t.after(f.cleanup)
  const p = preview(Object.assign({}, f.opts, { managedAgent: false }))
  assert.equal(p.agentChild.action, 'none')
  assert.ok(!p.rows.some((r) => r.path.startsWith('agents.go_deepseek')))
  const applied = await activateFully(f, { managedAgent: false })
  assert.equal(applied.ok, true)
  const text = await readFile(f.configPath, 'utf8')
  assert.equal(/\[agents\.go_deepseek\]/.test(text), false)
  assert.equal(await readFile(f.childPath, 'utf8').then(() => true, () => false), false)
})

test('崩溃恢复：applying 阶段崩溃后子文件与 config 一并回滚', async (t) => {
  const f = await fixture(USER_CONFIG)
  t.after(f.cleanup)
  const applied = await activateFully(f)
  assert.equal(applied.ok, true)
  // 模拟"config 已写、子文件已写、状态未落、journal 停在 applying"。
  const { mergeOwnedFields, buildDesiredCodexConfig, withManagedAgentDesired } = await import('../../../src/codex/config.js')
  const base = await readFile(f.configPath, 'utf8')
  const desired = withManagedAgentDesired(
    buildDesiredCodexConfig({ openaiBaseUrl: f.opts.baseUrl, model: MODEL, modelCatalogJsonPath: f.catalogPath }).desired,
    { model: MODEL },
  )
  const merged = mergeOwnedFields(USER_CONFIG, desired).text
  await writeFile(f.configPath, merged)
  await writeFile(f.configPath + '.mg-journal.json', JSON.stringify({
    schema: 'mg-codex-desktop-journal/1',
    phase: 'applying',
    at: Date.now(),
    before: { exists: true, sha256: sha256Hex(USER_CONFIG), size: Buffer.byteLength(USER_CONFIG) },
    applied: { sha256: sha256Hex(merged), size: Buffer.byteLength(merged) },
    backupPath: applied.backupPath,
    desired,
    agentChild: {
      path: f.childPath, fileName: 'go-deepseek.toml', model: MODEL, reasoningEffort: 'medium',
      text: canonicalChild(),
      before: { exists: false, sha256: '', size: 0 },
      applied: { exists: true, sha256: sha256Hex(canonicalChild()), size: Buffer.byteLength(canonicalChild()) },
      backupPath: null, adopted: false,
    },
  }))
  const s = status({ configPath: f.configPath, managedAgentPath: f.childPath })
  assert.equal(s.recovery.recovered, 'restored_after_crash')
  assert.equal(await readFile(f.configPath, 'utf8'), USER_CONFIG)
  assert.equal(await readFile(f.childPath, 'utf8').then(() => true, () => false), false, '崩溃恢复必须删除我们新建的子文件')
})
