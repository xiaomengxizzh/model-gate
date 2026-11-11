// M0-3 / T-KEY-03+04：配置与 Key 的提交、恢复、锁、外部修改 fail-closed。
// 全部离线：OS 临时目录 + 本地 mock 上游；故障注入只作用于显式子进程（绝不污染测试进程/网关）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  artifacts,
  beginWrite,
  fingerprint,
  recoverStore,
  TARGET_CONFIG,
  TARGET_KEYS,
} from '../../../src/config-transaction.js'
import { startGateway, startMockUpstream } from './harness.mjs'

const MODULE_URL = new URL('../../../src/config-transaction.js', import.meta.url).href
const OLD_LOCAL = JSON.stringify({ configVersion: 1, defaults: { proxyMode: 'direct' } })
const NEW_LOCAL = JSON.stringify({ configVersion: 2, defaults: { proxyMode: 'auto' } })
const OLD_KEYS = 'OLD-KEYS-BYTES'
const NEW_KEYS = 'NEW-KEYS-BYTES'
const POST_MARKER_POINTS = new Set(['after_commit_marker', 'before_publish'])
// journal 在 rename 之前写入：这三个注入点尚未留下 journal，恢复应为 clean（没有任何目标被替换）。
const PRE_JOURNAL_POINTS = new Set(['before_stage', 'before_stage_fsync', 'before_intent'])

const CHILD_DIR = mkdtempSync(join(tmpdir(), 'mg-txn-child-'))
const COMMIT_CHILD = join(CHILD_DIR, 'commit.mjs')
const LOCK_CHILD = join(CHILD_DIR, 'lock.mjs')
writeFileSync(COMMIT_CHILD, [
  'import { beginWrite, fingerprint } from ' + JSON.stringify(MODULE_URL),
  "const [dir] = process.argv.slice(2)",
  "const paths = { dir, local: dir + '/" + TARGET_CONFIG + "', keys: dir + '/" + TARGET_KEYS + "' }",
  'const tx = beginWrite(paths, { expected: fingerprint(paths), opId: "child-" + process.pid })',
  "tx.commit({ files: { '" + TARGET_KEYS + "': " + JSON.stringify(NEW_KEYS) + ", '" + TARGET_CONFIG + "': " + JSON.stringify(NEW_LOCAL) + " }, operation: 'child.commit' })",
  'tx.release()',
  "console.log('COMMITTED')",
  '',
].join('\n'))
writeFileSync(LOCK_CHILD, [
  'import { beginWrite, fingerprint } from ' + JSON.stringify(MODULE_URL),
  "const [dir] = process.argv.slice(2)",
  "const paths = { dir, local: dir + '/" + TARGET_CONFIG + "', keys: dir + '/" + TARGET_KEYS + "' }",
  'try {',
  '  const tx = beginWrite(paths, { expected: fingerprint(paths) })',
  '  tx.release()',
  "  console.log('ACQUIRED')",
  '} catch (error) {',
  "  console.log('ERROR:' + error.code)",
  '  process.exit(42)',
  '}',
  '',
].join('\n'))

function makeStore () {
  const dir = mkdtempSync(join(tmpdir(), 'mg-txn-store-'))
  writeFileSync(join(dir, 'gateway.json'), JSON.stringify({ providers: {}, models: {} }))
  writeFileSync(join(dir, TARGET_CONFIG), OLD_LOCAL)
  writeFileSync(join(dir, TARGET_KEYS), OLD_KEYS, { mode: 0o600 })
  return { dir, local: join(dir, TARGET_CONFIG), keys: join(dir, TARGET_KEYS) }
}
function pathsOf (store) { return { dir: store.dir, local: store.local, keys: store.keys } }
function readPair (store) { return { keys: readFileSync(store.keys, 'utf8'), local: readFileSync(store.local, 'utf8') } }
function modeOf (path) { return statSync(path).mode & 0o777 }
function runCommitChild (store, fault) {
  return spawnSync(process.execPath, [COMMIT_CHILD, store.dir], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, MG_TXN_FAULT: fault },
  })
}
function cleanupStore (store) { try { rmSync(store.dir, { recursive: true, force: true }) } catch {} }

test('M0-3 正常提交：两文件同代际、0600、工件清理、锁释放、日志不含正文', () => {
  const store = makeStore()
  try {
    const logs = []
    const log = { info: (...args) => logs.push(args.join(' ')) }
    const tx = beginWrite(pathsOf(store), { expected: fingerprint(pathsOf(store)), log })
    const result = tx.commit({
      files: { [TARGET_KEYS]: NEW_KEYS, [TARGET_CONFIG]: NEW_LOCAL },
      operation: 'unit.normal',
    })
    tx.release()
    assert.equal(result.changed.length, 2)
    assert.deepEqual(readPair(store), { keys: NEW_KEYS, local: NEW_LOCAL })
    assert.equal(modeOf(store.keys), 0o600, 'keys 必须以 0600 落盘')
    assert.deepEqual(artifacts(pathsOf(store)), [], '正常提交后不得残留 journal/marker/暂存/锁')
    assert.ok(logs.some((line) => line.includes('opId=') && line.includes('operation=unit.normal')), '应有结构化提交日志')
    assert.equal(logs.join('\n').includes(NEW_KEYS), false, '日志不得包含配置正文/Key')
  } finally { cleanupStore(store) }
})

for (const point of ['before_stage', 'before_stage_fsync', 'before_intent', 'after_intent', 'after_rename_keys', 'after_rename_config', 'before_commit_marker', 'after_commit_marker', 'before_publish']) {
  test('M0-3 故障注入 @' + point + ' → 重启恢复为一致代际（不混合）', () => {
    const store = makeStore()
    try {
      const child = runCommitChild(store, point + ':exit')
      assert.equal(child.status, 97, '注入点应让子进程在提交中途 exit：' + point + ' stderr=' + child.stderr)
      const recovery = recoverStore(pathsOf(store))
      // marker 之后的注入点：磁盘已是新代际 → 前滚；journal 之前的点：尚未替换任何目标 → clean；
      // 其余（journal 已写、未提交）→ 回滚旧代际。
      const expected = POST_MARKER_POINTS.has(point)
        ? { keys: NEW_KEYS, local: NEW_LOCAL }
        : { keys: OLD_KEYS, local: OLD_LOCAL }
      assert.deepEqual(readPair(store), expected, '恢复后必须是完整旧代际或完整新代际（' + point + '）')
      const expectedStatus = POST_MARKER_POINTS.has(point)
        ? 'recovered-new'
        : (PRE_JOURNAL_POINTS.has(point) ? 'clean' : 'recovered-old')
      assert.equal(recovery.status, expectedStatus, '恢复动作应与注入点阶段一致：' + point)
      assert.deepEqual(artifacts(pathsOf(store)), [], '恢复后不得残留事务工件：' + point)
    } finally { cleanupStore(store) }
  })
}

test('M0-3 真实进程 SIGKILL @after_rename_keys → 恢复旧代际且权限 0600', () => {
  const store = makeStore()
  try {
    const child = runCommitChild(store, 'after_rename_keys:kill')
    assert.equal(child.status, null, 'SIGKILL 后没有退出码')
    assert.equal(child.signal, 'SIGKILL')
    const recovery = recoverStore(pathsOf(store))
    assert.equal(recovery.status, 'recovered-old')
    assert.deepEqual(readPair(store), { keys: OLD_KEYS, local: OLD_LOCAL })
    assert.equal(modeOf(store.keys), 0o600, '回滚写回的 keys 仍须 0600')
    assert.deepEqual(artifacts(pathsOf(store)), [])
  } finally { cleanupStore(store) }
})

test('M0-3 外部修改：beginWrite 指纹不一致 → fail-closed，保留用户文件', () => {
  const store = makeStore()
  try {
    const expected = fingerprint(pathsOf(store))
    const external = JSON.stringify({ configVersion: 99, external: true })
    writeFileSync(store.local, external)
    assert.throws(
      () => beginWrite(pathsOf(store), { expected }),
      (error) => error.code === 'store_conflict',
      '外部编辑后内存指纹失效，必须拒绝写入',
    )
    assert.equal(readFileSync(store.local, 'utf8'), external, '外部文件必须原样保留')
    assert.deepEqual(artifacts(pathsOf(store)), [], '拒绝写入不得留下半成品')
    // 重新加载后的指纹应接受新磁盘状态
    const tx = beginWrite(pathsOf(store), { expected: fingerprint(pathsOf(store)) })
    tx.release()
  } finally { cleanupStore(store) }
})

test('M0-3 待决事务遇到外部修改 → 保留现场、结构化冲突、不覆盖', () => {
  const store = makeStore()
  try {
    assert.equal(runCommitChild(store, 'after_rename_keys:exit').status, 97)
    // keys 已 rename 为新值，local 仍旧；此时外部编辑 local 成第三种内容
    const external = JSON.stringify({ configVersion: 77, external: 'hand-edit' })
    writeFileSync(store.local, external)
    let caught = null
    try { recoverStore(pathsOf(store)) } catch (error) { caught = error }
    assert.ok(caught, '无法判定代际时必须抛错')
    assert.equal(caught.code, 'store_conflict')
    assert.ok(caught.details && caught.details.targets && caught.details.targets[TARGET_CONFIG] === 'other')
    assert.equal(readFileSync(store.keys, 'utf8'), NEW_KEYS, '已提交的新 keys 保留')
    assert.equal(readFileSync(store.local, 'utf8'), external, '外部文件保留，不覆盖')
    assert.ok(existsSync(join(store.dir, 'config-txn.json')), 'journal 保留供人工核对')
  } finally { cleanupStore(store) }
})

test('M0-3 锁竞争：另一个写者被立即拒绝（不排队），不产生半成品', () => {
  const store = makeStore()
  try {
    const tx = beginWrite(pathsOf(store), { expected: fingerprint(pathsOf(store)) })
    try {
      const blocked = spawnSync(process.execPath, [LOCK_CHILD, store.dir], { encoding: 'utf8', timeout: 30000, env: process.env })
      assert.equal(blocked.status, 42, '拿不到锁应明确拒绝：' + blocked.stdout + blocked.stderr)
      assert.ok(blocked.stdout.includes('ERROR:store_locked'))
      assert.deepEqual(readPair(store), { keys: OLD_KEYS, local: OLD_LOCAL }, '锁竞争不得改动文件')
    } finally {
      tx.release()
    }
    const allowed = spawnSync(process.execPath, [LOCK_CHILD, store.dir], { encoding: 'utf8', timeout: 30000, env: process.env })
    assert.equal(allowed.status, 0, allowed.stderr)
    assert.ok(allowed.stdout.includes('ACQUIRED'))
    assert.deepEqual(artifacts(pathsOf(store)), [], '释放后不得残留锁')
  } finally { cleanupStore(store) }
})

test('M0-3 静态约束：配置目标只经事务原子替换，不再直写', () => {
  const indexSrc = readFileSync(new URL('../../../src/index.js', import.meta.url), 'utf8')
  assert.equal(indexSrc.includes('writeFileSync(state.paths.keys'), false, '不得再直写 keys 目标文件')
  assert.equal(indexSrc.includes('writeFileSync(state.paths.local'), false, '不得再直写 local 目标文件')
  assert.equal(indexSrc.includes('writeJsonAtomic(state.paths.local'), false, 'configVersion 不得与 keys 分两步写')
  const txnSrc = readFileSync(new URL('../../../src/config-transaction.js', import.meta.url), 'utf8')
  assert.ok(txnSrc.includes('renameSync('), '目标文件必须 rename 替换')
  assert.ok(txnSrc.includes('fsyncSync('), '必须 fsync 文件与目录')
})

test('M0-3 旧格式兼容：无 journal 的明文 keys + local 可直接读入并升级', () => {
  const store = makeStore()
  try {
    const clean = recoverStore(pathsOf(store))
    assert.equal(clean.status, 'clean')
    const tx = beginWrite(pathsOf(store), { expected: fingerprint(pathsOf(store)) })
    tx.commit({ files: { [TARGET_KEYS]: 'MG1:upgraded-ciphertext', [TARGET_CONFIG]: JSON.stringify({ configVersion: 3 }) }, operation: 'legacy.upgrade' })
    tx.release()
    assert.equal(readFileSync(store.keys, 'utf8'), 'MG1:upgraded-ciphertext')
    assert.equal(modeOf(store.keys), 0o600)
  } finally { cleanupStore(store) }
})

// ============================================================================
// 网关级：真实 HTTP 路径上的失败语义（内存不发布、鉴权不降低、重启恢复）
// ============================================================================

function baseConfig (upstream, extra = {}) {
  return Object.assign({
    providers: { mock: { baseUrl: upstream.base, apiKeyEnv: '' } },
    models: { demo: { provider: 'mock', api: 'openai' } },
  }, extra)
}
function chat (gw, key) {
  return gw.post('/v1/chat/completions', { model: 'demo', messages: [{ role: 'user', content: 'hi' }] }, key ? { authorization: 'Bearer ' + key } : {})
}

test('网关：事务注入失败返回 500，不发布内存、不降低鉴权、不改磁盘', { timeout: 45000 }, async (t) => {
  const upstream = await startMockUpstream()
  const dir = mkdtempSync(join(tmpdir(), 'mg-txn-gw-'))
  const config = baseConfig(upstream, { defaults: { clientKey: 'sk-old-txn-1' } })
  const old = 'sk-old-txn-1'
  const next = 'sk-new-txn-2'
  const gw = await startGateway({ name: 'txn-fault', dir, config, env: { MG_TXN_FAULT: 'after_intent:throw' } })
  t.after(async () => { await gw.stop(); await upstream.stop(); rmSync(dir, { recursive: true, force: true }) })

  assert.equal((await chat(gw, old)).status, 200, '旧代际 Key 生效')
  assert.equal((await chat(gw, next)).status, 401)
  const before = await (await gw.get('/api/status')).json()

  const failed = await gw.post('/api/config/save', { defaults: { clientKey: next } })
  assert.equal(failed.status, 500, '事务注入失败必须是 500（不能假装成功）')
  const body = await failed.json()
  assert.equal(body.code, 'injected_fault')
  assert.equal(JSON.stringify(body).includes(next), false, '错误不得回显 Key')
  const logs = (await (await gw.get('/api/logs?lines=200')).json()).lines.join('\n')
  assert.equal(logs.includes(next), false, '日志不得回显 Key')

  const after = await (await gw.get('/api/status')).json()
  assert.equal(after.configVersion, before.configVersion, '失败保存不得推进代际')
  assert.equal((await chat(gw, old)).status, 200, '失败后旧 Key 仍然有效（鉴权未被放宽/改写）')
  assert.equal((await chat(gw, next)).status, 401, '失败后新 Key 不得生效')
  assert.equal(existsSync(join(dir, TARGET_CONFIG)), false, '失败保存不得产生/改写 local')

  // 重启：启动恢复把未完成的 journal 回滚为旧代际
  await gw.stop()
  const gw2 = await startGateway({ name: 'txn-fault', dir, config })
  t.after(() => gw2.stop())
  assert.equal((await (await gw2.get('/api/status')).json()).configVersion, before.configVersion)
  assert.equal((await chat(gw2, old)).status, 200)
  assert.equal((await chat(gw2, next)).status, 401)
})

test('网关：rename 后真实进程退出，重启恢复旧代际且鉴权一致', { timeout: 60000 }, async (t) => {
  const upstream = await startMockUpstream()
  const dir = mkdtempSync(join(tmpdir(), 'mg-txn-crash-'))
  const config = baseConfig(upstream)
  const old = 'sk-crash-old'
  const next = 'sk-crash-new'
  t.after(async () => { await upstream.stop(); rmSync(dir, { recursive: true, force: true }) })

  const gw1 = await startGateway({ name: 'txn-crash', dir, config })
  try {
    assert.equal((await gw1.post('/api/config/save', { defaults: { clientKey: old } })).status, 200)
    assert.equal((await chat(gw1, old)).status, 200)
  } finally { await gw1.stop() }

  const gw2 = await startGateway({ name: 'txn-crash', dir, config, env: { MG_TXN_FAULT: 'after_rename_keys:exit' } })
  try {
    await assert.rejects(gw2.post('/api/config/save', { defaults: { clientKey: next } }), '进程应在提交中途退出')
  } catch { /* 预期：连接被断开 */ }
  // 等子进程退出
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.notEqual(gw2.child.exitCode, null, '网关应已退出')

  const gw3 = await startGateway({ name: 'txn-crash', dir, config })
  t.after(() => gw3.stop())
  const status = await (await gw3.get('/api/status')).json()
  assert.equal(status.configVersion, 1, '恢复后回到旧代际（K1 保存的版本）')
  const recoveryLogs = (await (await gw3.get('/api/logs?lines=200')).json()).lines.join('\n')
  assert.ok(recoveryLogs.includes('配置事务恢复') && recoveryLogs.includes('recovered-old'), '启动恢复应记录结构化日志')
  assert.equal(recoveryLogs.includes(next), false, '恢复日志不得包含 Key')
  assert.equal((await chat(gw3, old)).status, 200, '旧 Key 仍然有效')
  assert.equal((await chat(gw3, next)).status, 401, '未提交的新 Key 不得生效')
  assert.equal(JSON.stringify(status).includes(next), false)
})

test('网关：启动时遇到不可判定的待决事务 → fail-closed 拒绝启动并记录结构化冲突', { timeout: 30000 }, async (t) => {
  const upstream = await startMockUpstream()
  const dir = mkdtempSync(join(tmpdir(), 'mg-txn-boot-'))
  const config = baseConfig(upstream)
  t.after(async () => { await upstream.stop(); rmSync(dir, { recursive: true, force: true }) })
  // 制造「keys 已 rename、local 仍旧」的待决事务，再把 local 外部改成第三种内容
  const store = { dir, local: join(dir, TARGET_CONFIG), keys: join(dir, TARGET_KEYS) }
  writeFileSync(store.local, OLD_LOCAL)
  writeFileSync(store.keys, OLD_KEYS, { mode: 0o600 })
  assert.equal(runCommitChild(store, 'after_rename_keys:exit').status, 97)
  writeFileSync(store.local, JSON.stringify({ configVersion: 55, external: true }))
  await assert.rejects(
    startGateway({ name: 'txn-boot', dir, config }),
    (error) => /RECOVERY_FAILED|配置事务恢复失败/.test(String(error && error.message)),
    '不可判定时必须拒绝启动',
  )
  assert.equal(readFileSync(store.local, 'utf8'), JSON.stringify({ configVersion: 55, external: true }), '外部文件保留')
})

test('网关：外部修改后保存 fail-closed，reload 后才继续', { timeout: 45000 }, async (t) => {
  const upstream = await startMockUpstream()
  const dir = mkdtempSync(join(tmpdir(), 'mg-txn-ext-'))
  const config = baseConfig(upstream)
  const old = 'sk-ext-old'
  const next = 'sk-ext-new'
  const gw = await startGateway({ name: 'txn-ext', dir, config })
  t.after(async () => { await gw.stop(); await upstream.stop(); rmSync(dir, { recursive: true, force: true }) })

  assert.equal((await gw.post('/api/config/save', { defaults: { clientKey: old } })).status, 200)
  assert.equal(statSync(join(dir, TARGET_KEYS)).mode & 0o777, 0o600, 'keys 落盘权限必须 0600')
  const localPath = join(dir, TARGET_CONFIG)
  const edited = Object.assign(JSON.parse(readFileSync(localPath, 'utf8')), { externalMarker: 'hand-edit' })
  writeFileSync(localPath, JSON.stringify(edited, null, 2))

  const refused = await gw.post('/api/config/save', { defaults: { clientKey: next } })
  assert.equal(refused.status, 409)
  assert.equal((await refused.json()).code, 'store_conflict')
  assert.equal(JSON.parse(readFileSync(localPath, 'utf8')).externalMarker, 'hand-edit', '不得覆盖外部文件')
  assert.equal((await chat(gw, old)).status, 200, '被拒绝的保存不得改变鉴权')

  assert.equal((await gw.post('/api/config/reload', {})).status, 200)
  assert.equal((await gw.post('/api/config/save', { defaults: { clientKey: next } })).status, 200)
  assert.equal((await chat(gw, next)).status, 200)
  assert.equal((await chat(gw, old)).status, 401)
})
