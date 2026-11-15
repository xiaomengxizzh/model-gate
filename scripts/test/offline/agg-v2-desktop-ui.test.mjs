// V2-01 / A3：聚合视图的重启提示、捆绑 Codex 版本与原生压缩声明展示（无 DOM）。
// 只验证纯函数与静态接线，不冒充原版 Desktop GUI 实测。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const VIEW = join(ROOT, 'src/ui-next/js/views/aggregation.js')
const source = readFileSync(VIEW, 'utf8')

async function loadView () {
  return import(new URL('../../../src/ui-next/js/views/aggregation.js', import.meta.url))
}

test('重启提示：按客户端启动时间判定，重启后自动消除而不是永久提示', async () => {
  const mod = await loadView()
  assert.equal(typeof mod.restartNotice, 'function')

  const official = mod.restartNotice(null, 'official')
  assert.equal(official.needed, false)
  assert.equal(official.label, '无需重启')

  const restarted = mod.restartNotice({ needed: false, reason: 'client_restarted_after_apply', client: { running: true, startedAt: 200 }, appliedAt: 100 }, 'aggregated')
  assert.equal(restarted.needed, false)
  assert.equal(restarted.tone, 'good')
  assert.match(restarted.label, /已检测到客户端重启/)

  const old = mod.restartNotice({ needed: true, reason: 'client_running_with_old_config' }, 'aggregated')
  assert.equal(old.needed, true)
  assert.match(old.detail, /完全退出/)

  const closed = mod.restartNotice({ needed: true, reason: 'client_not_running' }, 'aggregated')
  assert.match(closed.label, /重新打开/)

  const unverified = mod.restartNotice({ needed: true, reason: 'client_restart_unverified' }, 'aggregated')
  assert.match(unverified.label, /无法确认/)
  assert.match(unverified.detail, /不猜成功/)

  const missing = mod.restartNotice(null, 'aggregated')
  assert.equal(missing.needed, true)
  assert.match(missing.detail, /完全退出/)
})

test('版本展示：文件元数据版本可见，未探测的捆绑 CLI 不伪造版本', async () => {
  const mod = await loadView()
  assert.equal(typeof mod.versionLabel, 'function')
  assert.equal(mod.versionLabel({ found: true, versionState: 'known', version: '26.1103.32239' }).text, '26.1103.32239')
  assert.equal(mod.versionLabel({ found: true, versionState: 'not_probed' }).text, '未探测（不执行该二进制）')
  assert.equal(mod.versionLabel({ found: false }).text, '未检测到')
  assert.equal(mod.versionLabel({ found: true, versionState: 'unknown' }).text, '版本未知')
})

test('原生压缩声明：内置身份如实说明不可声明，managed provider 展示字段与 UNVERIFIED 运行态', async () => {
  const mod = await loadView()
  assert.equal(typeof mod.nativeCompactionNotice, 'function')

  const builtin = mod.nativeCompactionNotice({ mode: 'builtin-openai', declarable: false, reason: 'reserved_builtin_provider' })
  assert.equal(builtin.tone, 'muted')
  assert.match(builtin.label, /不可声明/)
  assert.match(builtin.detail, /model_providers\.openai/)

  const declared = mod.nativeCompactionNotice({
    mode: 'managed-provider', declared: true, remoteCompaction: 'unsupported',
    field: 'model_providers.modelgate.capabilities.remote_compaction', runtimeAuth: 'UNVERIFIED',
  })
  assert.equal(declared.tone, 'info')
  assert.match(declared.label, /remote_compaction = unsupported/)
  assert.match(declared.detail, /model_providers\.modelgate\.capabilities\.remote_compaction/)
  assert.match(declared.detail, /UNVERIFIED/)

  const pending = mod.nativeCompactionNotice({ mode: 'managed-provider', declared: false })
  assert.equal(pending.tone, 'warn')
})

test('聚合视图源码：接线 bundle Codex 版本、重启判定与原生压缩状态，不再固定文案', () => {
  assert.match(source, /Desktop 捆绑 Codex/)
  assert.match(source, /原生压缩（Codex 自有）/)
  assert.match(source, /restartNotice\(/)
  assert.match(source, /nativeCompactionNotice\(/)
  assert.equal(/needsRestart \? tag\('需要重启 Codex 生效'/.test(source), false, '重启标签必须来自判定结果，不能写死')
  assert.match(source, /preservedUserEdits/)
  assert.equal(/(localStorage\.(setItem|getItem)|document\.cookie\s*=)/.test(source), false)
})
