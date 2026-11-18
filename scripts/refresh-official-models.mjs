#!/usr/bin/env node
// 一键刷新官方模型基线并重发布本地聚合目录。
//
// 数据来源只有当前已安装 CLI 的 `codex debug models --bundled` 本地导出：
//   - 不联网、不读 ~/.codex、不读 auth.json / keys.local.json 内容、不发付费请求、不启停 8787。
//   - fail-closed：导出 / 结构 / 数量任一异常即报错退出，且在写任何文件前完成全部校验。
//   - 备份旧基线（带时间戳 .bak）+ 版本化目录（state.json versions/）双回滚锚点。
//
// 用法：从仓库任意目录运行均可（脚本会 chdir 到仓库根）。
//   node scripts/refresh-official-models.mjs            # 全量刷新 + 重发布
//   node scripts/refresh-official-models.mjs --dry-run  # 只导出/校验/预览差异，不写文件
//   npm run refresh:models                              # 同上（需在 PATH 中有 0.170+ 的 codex）
//
// 前置：先升级 Codex CLI（本机实测 0.170.0 自带 14 个官方模型，含 gpt-6.2-sol/astra）。
// 可选环境变量：
//   MG_CODEX_BIN                 指定 codex 可执行文件（默认 PATH 中的 codex）
//   MG_REFRESH_REQUIRED_SLUGS    覆盖必需 slug 白名单（逗号分隔）；官方目录演进后用来自定义门槛
//
// 回滚（见脚本末尾 ROLLBACK 输出）：
//   1) cp <baseline.bak> <baseline>                       恢复旧基线（运行时 /v1/models 来源）
//   2) node scripts/codex-catalog.mjs --rollback prev \
//        --out config/aggregation/catalog/local/current.json \
//        --state-dir config/aggregation/catalog/local      恢复上一代目录（CLI model_catalog_json 来源）
//   3) 由所有者统一重启网关后再验证 /v1/models。

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, renameSync,
  rmSync, writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(ROOT)

const { configPaths } = await import('../src/router.js')
const { createRegistry } = await import('../src/aggregation/registry.js')
const { createFileSnapshotStore } = await import('../src/aggregation/discovery.js')
const { createAggregatedCatalog } = await import('../src/aggregation/catalog.js')
const {
  validateCatalog, sha256Hex, stableStringify,
} = await import('../src/codex/catalog.js')

// ---- 门槛常量（fail-closed）------------------------------------------------
const MIN_MODEL_COUNT = 12          // 官方目录低于此数视为骤降
const MAX_COUNT_DROP = 3            // 相对上一次基线允许最多退役 N 个（官方会淘汰 hide 模型）
const SCOPE = 'local'
const DEFAULT_REQUIRED_SLUGS = [
  'gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra',
  'gpt-6.1-sol', 'gpt-6.1-terra',
  'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
  'codex-auto-review',
  // 本次所有者明确要求：gpt-6.2 必须可见（MG-R012：可见但 UNVERIFIED）。
  'gpt-6.2-sol', 'gpt-6.2-astra',
]

const dryRun = process.argv.includes('--dry-run')
const codexBin = process.env.MG_CODEX_BIN || 'codex'
const requiredSlugs = process.env.MG_REFRESH_REQUIRED_SLUGS
  ? String(process.env.MG_REFRESH_REQUIRED_SLUGS).split(',').map((s) => s.trim()).filter(Boolean)
  : DEFAULT_REQUIRED_SLUGS

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function fail(message, details = {}) {
  const err = new Error(message)
  err.details = details
  throw err
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

function atomicWrite(path, text) {
  const tmp = join(dirname(path), '.' + path.split('/').pop() + '.tmp-' + process.pid)
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, path)
}

function backupFile(src, dest) {
  copyFileSync(src, dest)
  chmodSync(dest, 0o600)
}

function codexVersion() {
  const r = spawnSync(codexBin, ['--version'], { encoding: 'utf8', timeout: 60000 })
  if (r.error || r.status !== 0) return null
  const m = String(r.stdout || '').match(/(\d+\.\d+\.\d+)/)
  return m ? m[1] : null
}

// 用隔离 CODEX_HOME + --bundled 导出官方目录；只读、不联网、不写客户端配置。
function exportOfficialCatalog() {
  const home = mkdtempSync(join(tmpdir(), 'mg-refresh-codex-'))
  try {
    const r = spawnSync(codexBin, ['debug', 'models', '--bundled'], {
      env: { ...process.env, CODEX_HOME: home },
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 16 * 1024 * 1024,
    })
    if (r.error) fail('codex_export_failed', { reason: r.error.message })
    if (r.status !== 0) {
      // 只回传退出码与 code，绝不回传 stderr 正文（可能含环境细节）。
      fail('codex_export_failed', { exit: r.status })
    }
    let parsed
    try { parsed = JSON.parse(String(r.stdout || '')) } catch (e) {
      fail('export_not_json', { reason: e.message })
    }
    return { parsed, home }
  } catch (e) {
    rmSync(home, { recursive: true, force: true })
    throw e
  }
}

// 全部校验在写文件之前完成。
function validateExport(parsed, previousCount) {
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.models)) {
    fail('export_shape_invalid', { reason: '缺少 models 数组' })
  }
  const validation = validateCatalog({ models: parsed.models }, { source: 'codex debug models export' })
  if (!validation.ok) {
    fail('export_catalog_invalid', {
      errors: validation.errors.slice(0, 5).map((e) => ({ code: e.code, path: e.path })),
    })
  }
  const count = parsed.models.length
  if (count < MIN_MODEL_COUNT) fail('model_count_collapse', { count, min: MIN_MODEL_COUNT })
  if (previousCount != null && count < previousCount - MAX_COUNT_DROP) {
    fail('model_count_collapse', { count, previousCount, maxDrop: MAX_COUNT_DROP })
  }
  const slugs = parsed.models.map((m) => m && m.slug).filter(Boolean)
  const missing = requiredSlugs.filter((s) => !slugs.includes(s))
  if (missing.length) fail('required_slug_missing', { missing })
  return { count, slugs }
}

async function main() {
  const paths = configPaths()
  if (!existsSync(paths.local)) fail('gateway_config_missing', { path: paths.local })
  // 只读解析配置：不加载 keys.local.json，不触碰 auth.json。
  const cfg = JSON.parse(readFileSync(paths.local, 'utf8'))
  const baselinePath = cfg.defaults && cfg.defaults.codexCatalogBasePath
  if (!baselinePath || typeof baselinePath !== 'string' || !existsSync(baselinePath)) {
    fail('baseline_path_missing', { path: baselinePath || null })
  }

  const statePath = join(paths.dir, 'aggregation', 'catalog', SCOPE, 'state.json')
  const previousState = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null
  const oldGeneration = previousState && Number.isInteger(previousState.currentVersion)
    ? previousState.currentVersion : null
  const previousBaseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
  const previousSlugs = (previousBaseline.models || []).map((m) => m && m.slug).filter(Boolean)
  const oldSha = sha256File(baselinePath)

  const version = codexVersion()
  if (!version) fail('codex_version_unavailable', { bin: codexBin })

  const { parsed, home } = exportOfficialCatalog()
  let validated
  try {
    validated = validateExport(parsed, previousSlugs.length)
  } catch (e) {
    rmSync(home, { recursive: true, force: true })
    throw e
  }

  const added = validated.slugs.filter((s) => !previousSlugs.includes(s))
  const removed = previousSlugs.filter((s) => !validated.slugs.includes(s))
  const newSha = sha256Hex(stableStringify(parsed.models))
  // 幂等：模型清单与当前基线逐字节同构时视为已刷新，不再写文件/推进世代。
  const previousFingerprint = sha256Hex(stableStringify(previousBaseline.models || []))
  const noop = newSha === previousFingerprint

  // 保留旧基线的信封字段（fetched_at/etag/client_version/identity），models 以导出为准。
  const nextBaseline = {
    fetched_at: new Date().toISOString(),
    etag: null,
    client_version: version,
    identity: newSha,
    models: parsed.models,
  }
  const nextText = JSON.stringify(nextBaseline, null, 2) + '\n'

  const report = {
    codexVersion: version,
    baseline: baselinePath,
    oldSha,
    newSha: createHash('sha256').update(nextText).digest('hex'),
    modelsFingerprint: newSha,
    oldCount: previousSlugs.length,
    newCount: validated.count,
    added,
    removed,
    oldGeneration,
    noop,
    dryRun,
  }

  if (dryRun || noop) {
    rmSync(home, { recursive: true, force: true })
    if (noop) {
      report.newSha = oldSha
      report.newGeneration = oldGeneration
      report.catalogModelCount = null
      report.note = '模型清单未变化：跳过写入与重发布（幂等）'
    }
    process.stdout.write(JSON.stringify({ ok: true, mode: dryRun ? 'dry-run' : 'noop', ...report }, null, 2) + '\n')
    return 0
  }

  // 备份 → 写基线 → 用新基线重发布目录；任一步失败都带回退说明。
  const backupPath = baselinePath + '.bak-' + stamp()
  backupFile(baselinePath, backupPath)
  report.backup = backupPath
  atomicWrite(baselinePath, nextText)

  let published
  try {
    const registry = createRegistry({ readConfig: () => cfg })
    const cacheStore = createFileSnapshotStore({ dir: paths.dir })
    const catalog = createAggregatedCatalog({ registry, cacheStore, dir: paths.dir, readConfig: () => cfg })
    published = await catalog.publish(SCOPE, { cfg })
  } catch (e) {
    // 目录发布失败：把基线恢复成备份，避免留下「新基线 + 旧目录」的半状态。
    backupFile(backupPath, baselinePath)
    rmSync(home, { recursive: true, force: true })
    fail('catalog_publish_failed', { reason: (e && (e.code || e.message)) || 'unknown', baselineRestored: true })
  }
  rmSync(home, { recursive: true, force: true })

  report.newGeneration = published.version
  report.catalogModelCount = published.modelCount
  report.counts = published.catalogRef && published.catalogRef.counts
  const oldBindings = (previousState && previousState.current && previousState.current.bindings) || {}
  const newState = JSON.parse(readFileSync(statePath, 'utf8'))
  const newBindings = (newState.current && newState.current.bindings) || {}
  report.bindings = {
    before: Object.keys(oldBindings),
    after: Object.keys(newBindings),
    unchanged: stableStringify(oldBindings) === stableStringify(newBindings),
  }
  report.rollback = [
    'cp ' + backupPath + ' ' + baselinePath,
    'node scripts/codex-catalog.mjs --rollback prev --out ' + join(paths.dir, 'aggregation', 'catalog', SCOPE, 'current.json') +
      ' --state-dir ' + join(paths.dir, 'aggregation', 'catalog', SCOPE),
    '# 然后由所有者统一重启网关并验证 /v1/models',
  ]

  process.stdout.write(JSON.stringify({ ok: true, mode: 'refresh', ...report }, null, 2) + '\n')
  return 0
}

try {
  process.exitCode = await main()
} catch (err) {
  process.stderr.write('refresh failed[' + (err.message || 'unknown') + ']: ' +
    JSON.stringify(err.details || {}) + '\n')
  process.exitCode = 1
}
