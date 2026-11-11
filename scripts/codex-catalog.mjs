#!/usr/bin/env node
// Codex 聚合模型目录 CLI：生成 / 校验 / 版本化 / 回滚 / 差异摘要。
// 用法见 docs/reference/codex-catalog.md。零第三方依赖，默认不联网、不写 ~/.codex。
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, mkdtempSync, readdirSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  CatalogError,
  AGGREGATED_ID_PREFIX,
  DEFAULT_HISTORY_LIMIT,
  OUTPUT_FORMATS,
  assertCatalog,
  buildCatalog,
  catalogFingerprint,
  diffBindings,
  diffCatalogs,
  emptyState,
  markRollback,
  nextVersion,
  recordVersion,
  resolveRollbackTarget,
  retireBindings,
  serializeCatalog,
  sourceFingerprint,
  validateCatalog,
  versionFileName,
} from '../src/codex/catalog.js'
import {
  generationRecordFromBuilt,
  persistAndSwapValidatedGeneration,
} from '../src/codex/catalog-generation.js'

const EXIT = { OK: 0, USAGE: 2, INVALID: 3, CONFLICT: 4, IO: 5, VERIFY: 6 }
const CONFLICT_CODES = new Set(['stable_id_rebinding', 'retired_id_reuse', 'slug_collision', 'official_slug_reuse', 'identity_collision', 'generation_conflict', 'generation_not_monotonic'])
const USAGE_CODES = new Set(['usage', 'unsafe_out_path'])
const STATE_FILE = 'state.json'

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

function fail(code, message, details = {}) {
  return new CatalogError(code, message, details)
}

function parseArgs(argv) {
  const args = { officialProviders: [], command: 'generate', format: 'catalog-json' }
  const takesValue = new Set([
    'base', 'models', 'out', 'format', 'state-dir', 'template-model', 'history-limit',
    'priority-start', 'rollback', 'codex-bin', 'codex-home', 'official-provider',
  ])
  const flags = new Set(['dry-run', 'json', 'help', 'verify-codex', 'status', 'list-versions', 'strict', 'allow-unknown-efforts'])
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]
    if (!raw.startsWith('--')) throw fail('usage', '无法识别的参数：' + raw)
    const eq = raw.indexOf('=')
    const name = eq === -1 ? raw.slice(2) : raw.slice(2, eq)
    if (takesValue.has(name)) {
      const value = eq === -1 ? argv[++i] : raw.slice(eq + 1)
      if (value === undefined || value === '' || value.startsWith('--')) {
        throw fail('usage', '参数 --' + name + ' 需要一个值')
      }
      if (name === 'official-provider') args.officialProviders.push(value)
      else args[name] = value
      continue
    }
    if (flags.has(name)) {
      if (eq !== -1) throw fail('usage', '参数 --' + name + ' 不接受值')
      args[name] = true
      continue
    }
    throw fail('usage', '未知参数：--' + name)
  }
  if (args.help) args.command = 'help'
  else if (args.status) args.command = 'status'
  else if (args['list-versions']) args.command = 'list-versions'
  else if (args.rollback !== undefined) args.command = 'rollback'
  if (args.format !== undefined && !OUTPUT_FORMATS.includes(args.format)) {
    throw fail('usage', '--format 只能是 ' + OUTPUT_FORMATS.join(' / '))
  }
  return args
}

function usage() {
  return [
    'Codex 聚合模型目录工具（离线、零依赖）',
    '',
    '生成：',
    '  node scripts/codex-catalog.mjs --base <官方目录.json|目录> --out <输出文件> [选项]',
    '',
    '选项：',
    '  --models <gateway.json>      ModelGate 配置（读取 models/providers），省略则只输出官方模型',
    '  --format catalog-json|codex-models   两种出路同一 ModelsResponse 结构（默认 catalog-json）',
    '  --state-dir <目录>           版本/回滚状态目录（默认 <out 目录>/.codex-catalog）',
    '  --template-model <slug>      记录/校验用的官方模板模型（默认首个可见官方模型；不再向第三方继承行为字段）',
    '  --official-provider <id>     视为官方直连的 provider id（可重复，默认 openai/chatgpt/codex/...）',
    '  --history-limit <n>          保留最近 n 个版本（默认 5）',
    '  --priority-start <n>         第三方模型 priority 起始值（默认官方最大 priority + 1）',
    '  --dry-run                    只打印计划与差异，不落盘',
    '  --json                       机器可读输出',
    '  --strict                     警告升级为错误（fail-closed 模式）',
    '  --verify-codex               发布前用 codex debug models 离线解析生成物（失败即中止）',
    '  --codex-bin <path>           codex 可执行文件（默认 PATH 中的 codex 或 MG_CODEX_BIN）',
    '  --codex-home <目录>          验证用临时 CODEX_HOME（默认系统临时目录），绝不使用 ~/.codex',
    '',
    '查看/回滚：',
    '  node scripts/codex-catalog.mjs --status --state-dir <目录> [--out <文件>]',
    '  node scripts/codex-catalog.mjs --list-versions --state-dir <目录>',
    '  node scripts/codex-catalog.mjs --rollback prev --out <文件> --state-dir <目录>',
    '  --rollback 接受 prev | current | 版本号 | v000003 | sha 前缀',
    '',
    '退出码：0 成功；2 用法；3 校验/生成失败；4 身份冲突；5 IO；6 codex 校验失败',
  ].join('\n')
}

function loadJsonFile(path, label) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    throw fail('io_read', '无法读取' + label + ' ' + path + '：' + err.message)
  }
  try {
    return { text, json: JSON.parse(text) }
  } catch (err) {
    throw fail('invalid_json', label + ' 不是合法 JSON（' + path + '）：' + err.message)
  }
}

function resolveBasePath(base) {
  const absolute = resolve(base)
  if (!existsSync(absolute)) throw fail('io_read', '基线目录不存在：' + absolute)
  if (statSync(absolute).isDirectory()) {
    for (const name of ['catalog.json', 'models.json']) {
      const candidate = join(absolute, name)
      if (existsSync(candidate)) return candidate
    }
    throw fail('io_read', '目录 ' + absolute + ' 下没有 catalog.json 或 models.json')
  }
  return absolute
}

// 硬约束：生成器不写 ~/.codex（客户端正式目录只由 E6 的受控配置流程处理）。
function assertSafePath(target, what) {
  const absolute = resolve(target)
  const codexHome = join(homedir(), '.codex')
  if (absolute === codexHome || absolute.startsWith(codexHome + sep)) {
    throw fail('unsafe_out_path', '拒绝写入 ~/.codex（' + what + '）：' + absolute + '（正式 Codex 配置必须走受控写入流程）')
  }
  return absolute
}

function assertSafeOutPath(out) {
  return assertSafePath(out, '输出文件')
}

function atomicWrite(path, text) {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, '.' + path.split(sep).pop() + '.tmp-' + process.pid)
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, path)
}

function readState(stateDir) {
  const file = join(stateDir, STATE_FILE)
  if (!existsSync(file)) return { state: emptyState(), existed: false }
  const loaded = loadJsonFile(file, '状态文件')
  if (!loaded.json || typeof loaded.json !== 'object') throw fail('invalid_state', '状态文件损坏：' + file)
  return { state: { ...emptyState(), ...loaded.json }, existed: true }
}

function readPublishedCatalog(stateDir, state) {
  if (!state.current || !state.current.file) return null
  const file = join(stateDir, state.current.file)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function codexVersion(bin) {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 60000 })
  if (r.error || r.status !== 0) return null
  const match = String(r.stdout || '').match(/(\d+\.\d+\.\d+)/)
  return match ? match[1] : String(r.stdout || '').trim() || null
}

// 用 codex debug models 离线解析生成物；失败即中止发布（fail-closed）。
function verifyWithCodex(file, options) {
  const bin = options.codexBin || process.env.MG_CODEX_BIN || 'codex'
  const home = options.codexHome || mkdtempSync(join(tmpdir(), 'mg-codex-catalog-'))
  const createdHome = !options.codexHome
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const expected = Array.isArray(parsed.models) ? parsed.models.map(m => m && m.slug).filter(Boolean) : []
    const r = spawnSync(bin, ['debug', 'models', '-c', 'model_catalog_json="' + file + '"'], {
      env: { ...process.env, CODEX_HOME: home },
      encoding: 'utf8',
      timeout: 120000,
    })
    if (r.error) {
      throw fail('codex_verify_failed', '无法执行 codex debug models（' + bin + '）：' + r.error.message)
    }
    if (r.status !== 0) {
      throw fail('codex_verify_failed', 'codex debug models 解析失败（exit ' + r.status + '）：' + String(r.stderr || '').trim().split('\n').slice(-3).join(' | '))
    }
    let echoed
    try {
      echoed = JSON.parse(String(r.stdout || ''))
    } catch (err) {
      throw fail('codex_verify_failed', 'codex debug models 输出不是 JSON：' + err.message)
    }
    const echoedSlugs = new Set((echoed.models || []).map(m => m && m.slug).filter(Boolean))
    const missing = expected.filter(slug => !echoedSlugs.has(slug))
    if (missing.length) {
      throw fail('codex_verify_failed', 'codex 未能识别生成的 slug：' + missing.join(', '))
    }
    return {
      by: 'codex debug models',
      codexVersion: codexVersion(bin),
      at: new Date().toISOString(),
      modelCount: (echoed.models || []).length,
      file: file.split(sep).pop(),
    }
  } finally {
    if (createdHome) rmSync(home, { recursive: true, force: true })
  }
}

function printJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n')
}

function formatDiffLines(diff, bindings) {
  const lines = []
  for (const slug of diff.added) {
    const binding = bindings[slug]
    lines.push('  + ' + slug + (binding ? ' (' + binding.provider + '/' + binding.model + ')' : ''))
  }
  for (const slug of diff.removed) lines.push('  - ' + slug)
  for (const item of diff.changed) {
    const fields = Object.keys(item.fields)
    const preview = fields.slice(0, 4).map(f => f + ' ' + JSON.stringify(item.fields[f].from) + ' -> ' + JSON.stringify(item.fields[f].to)).join('; ')
    lines.push('  ~ ' + item.slug + ': ' + preview + (fields.length > 4 ? ' …(+' + (fields.length - 4) + ')' : ''))
  }
  return lines
}

function printWarnings(meta, json) {
  if (json) return
  const warnings = (meta && meta.warnings) || []
  if (!warnings.length) return
  process.stderr.write('warnings: ' + warnings.length + '\n')
  for (const w of warnings.slice(0, 8)) process.stderr.write('  ! [' + w.code + '] ' + w.path + ': ' + w.message + '\n')
  if (warnings.length > 8) process.stderr.write('  … 其余 ' + (warnings.length - 8) + ' 条见 --json 输出\n')
}

function stateDirFor(args, out) {
  if (args['state-dir']) return assertSafePath(args['state-dir'], '状态目录')
  if (out) return join(dirname(resolve(out)), '.codex-catalog')
  throw fail('usage', '该操作需要 --state-dir')
}

function generate(args) {
  if (!args.base) throw fail('usage', '生成目录需要 --base（官方 codex debug models 导出的 {"models":[...]} 或所在目录）')
  if (!args.out) throw fail('usage', '生成目录需要 --out')
  const out = assertSafeOutPath(args.out)
  const basePath = resolveBasePath(args.base)
  const baseLoaded = loadJsonFile(basePath, '基线目录')
  const base = { path: basePath, catalog: baseLoaded.json, sha256: sha256(baseLoaded.text) }

  let config = null
  let configPath = null
  if (args.models) {
    configPath = resolve(args.models)
    const loaded = loadJsonFile(configPath, 'ModelGate 配置')
    const json = loaded.json
    if (!json || typeof json !== 'object' || Array.isArray(json) || typeof json.models !== 'object' || Array.isArray(json.models) || json.models === null) {
      throw fail('invalid_config', 'ModelGate 配置必须是 {"models":{...},"providers":{...}} 形状：' + configPath)
    }
    config = { path: configPath, data: json, sha256: sha256(loaded.text) }
  }

  const stateDir = stateDirFor(args, out)
  const { state } = readState(stateDir)
  const previousCatalog = readPublishedCatalog(stateDir, state)
  const historyLimit = args['history-limit'] ? Number(args['history-limit']) : DEFAULT_HISTORY_LIMIT
  if (!Number.isInteger(historyLimit) || historyLimit < 1) throw fail('usage', '--history-limit 必须是 >=1 的整数')
  const priorityStart = args['priority-start'] !== undefined ? Number(args['priority-start']) : undefined
  if (priorityStart !== undefined && (!Number.isInteger(priorityStart) || priorityStart < 0)) {
    throw fail('usage', '--priority-start 必须是非负整数')
  }

  const startedAt = new Date()
  const built = buildCatalog({
    base: base.catalog,
    config: config ? config.data : null,
    options: {
      templateModel: args['template-model'],
      officialProviders: args.officialProviders.length ? args.officialProviders : undefined,
      priorityStart,
      strict: !!args.strict,
      allowUnknownEfforts: !!args['allow-unknown-efforts'],
      // 墓碑 ID 参与生成前零碰撞检查：别名/真实模型不得复活已下架聚合 ID。
      retiredSlugs: Object.keys(state.retiredBindings || {}),
    },
  })
  const catalog = built.catalog
  const meta = built.meta
  if (args.strict && meta.warnings.length) {
    throw fail('strict_warnings',
      '--strict 模式下存在 ' + meta.warnings.length + ' 条警告，拒绝发布：' + meta.warnings.slice(0, 3).map(w => '[' + w.code + '] ' + w.path).join('; '),
      { warnings: meta.warnings })
  }
  const text = serializeCatalog(catalog, { format: args.format })
  const digest = sha256(text)
  const validation = validateCatalog(JSON.parse(text), { source: 'serialized catalog', strict: !!args.strict })
  if (!validation.ok) {
    throw fail('catalog_invalid', '序列化后的目录未通过校验：' + validation.errors[0].path + ' ' + validation.errors[0].message, { errors: validation.errors })
  }

  const bindingDiff = diffBindings(state.current ? state.current.bindings : {}, meta.bindings)
  const conflicts = [...bindingDiff.conflicts]
  for (const slug of Object.keys(meta.bindings)) {
    const retired = state.retiredBindings && state.retiredBindings[slug]
    if (!retired) continue
    const next = meta.bindings[slug]
    if (retired.provider !== next.provider || retired.model !== next.model) {
      conflicts.push({ slug, from: { provider: retired.provider, model: retired.model }, to: { provider: next.provider, model: next.model }, retired: true })
    }
  }
  if (conflicts.length) {
    throw fail('stable_id_rebinding',
      '检测到聚合 ID 重绑定（D2 禁止同一 ID 指向不同 provider/model）：' + conflicts.map(c => c.slug + ' ' + c.from.provider + '/' + c.from.model + ' -> ' + c.to.provider + '/' + c.to.model).join('; '),
      { conflicts })
  }

  const diff = previousCatalog ? diffCatalogs(previousCatalog, catalog) : null
  const version = nextVersion(state)
  const fileName = versionFileName(version, digest)
  const fingerprint = sourceFingerprint({
    base: { path: base.path, sha256: base.sha256 },
    config: config ? { path: config.path, sha256: config.sha256 } : null,
    templateModel: meta.templateModel,
    options: { priorityStart: priorityStart === undefined ? null : priorityStart },
  })
  const generatedAt = startedAt.toISOString()
  // 世代记录：generation key 显式包含 wire 配置指纹（同名模型改 api/providerModels/effortFormat/
  // maxContext/capability 等都会产生新世代，避免旧读者/路由跨代）。
  const record = generationRecordFromBuilt({
    generation: version,
    built,
    text,
    base: { path: base.path, sha256: base.sha256 },
    config: config ? config.data : null,
    options: {
      templateModel: meta.templateModel,
      officialProviders: args.officialProviders.length ? args.officialProviders : undefined,
      priorityStart: priorityStart === undefined ? null : priorityStart,
      format: args.format,
    },
    format: args.format,
  })

  const summary = {
    ok: true,
    mode: 'generate',
    dryRun: !!args['dry-run'],
    out,
    format: args.format,
    version,
    generation: record.generation,
    generationKey: record.key,
    configFingerprint: record.configFingerprint,
    sha256: digest,
    counts: meta.counts,
    skipped: meta.skipped,
    diff,
    bindings: meta.bindings,
    warnings: meta.warnings,
    templateModel: meta.templateModel,
    sourceFingerprint: fingerprint,
    stateDir,
    versionFile: join('versions', fileName),
    generatedAt,
    verified: null,
  }

  if (args['dry-run']) {
    if (args.json) printJson(summary)
    else {
      process.stdout.write('[dry-run] would publish catalog v' + version + ' -> ' + out + '\n')
      process.stdout.write('format: ' + args.format + ' | schema: ' + (meta.catalogSchema || '') + '\n')
      process.stdout.write('models: ' + meta.counts.total + ' (official ' + meta.counts.official + ', third-party ' + meta.counts.thirdParty + ')\n')
      if (diff) {
        process.stdout.write('diff vs v' + (state.current ? state.current.version : '?') + ': +' + diff.counts.added + ' -' + diff.counts.removed + ' ~' + diff.counts.changed + '\n')
        for (const line of formatDiffLines(diff, meta.bindings)) process.stdout.write(line + '\n')
      } else {
        process.stdout.write('diff: 无上一版本，按全量新增处理\n')
      }
      printWarnings(meta, args.json)
      if (args['verify-codex']) {
        const tmpDir = mkdtempSync(join(tmpdir(), 'mg-codex-catalog-dry-'))
        const tmpFile = join(tmpDir, fileName)
        writeFileSync(tmpFile, text)
        try {
          const verified = verifyWithCodex(tmpFile, { codexBin: args['codex-bin'], codexHome: args['codex-home'] })
          summary.verified = verified
          process.stdout.write('verified: codex ' + verified.codexVersion + ', ' + verified.modelCount + ' models parsed (dry-run)\n')
        } finally {
          rmSync(tmpDir, { recursive: true, force: true })
        }
      }
    }
    return { code: EXIT.OK, summary }
  }

  // 原子发布（CAS）：期望世代 = 本次读取到的 currentVersion；并发发布者版本不一致即拒绝。
  // commit 内 stage 版本文件 → 校验 → rename → out → state（state 最后写 = 提交点）；失败保留旧代。
  const baseState = retireBindings(state, bindingDiff.removed, version)
  const nextState = recordVersion(baseState, {
    version,
    file: join('versions', fileName),
    sha256: digest,
    generatedAt,
    format: args.format,
    counts: meta.counts,
    sourceFingerprint: fingerprint,
    key: record.key,
    configFingerprint: record.configFingerprint,
    catalogFingerprint: record.catalogFingerprint,
    bindings: meta.bindings,
    verified: null,
  }, { historyLimit })
  const next = { generation: version, key: record.key, digest, state: nextState, verified: null, record }
  const io = {
    readState: () => readState(stateDir).state,
    commit: (rec) => {
      mkdirSync(join(stateDir, 'versions'), { recursive: true })
      const staged = join(stateDir, '.staging-' + process.pid + '.json')
      writeFileSync(staged, record.text, { mode: 0o600 })
      try {
        let verified = null
        if (args['verify-codex']) verified = verifyWithCodex(staged, { codexBin: args['codex-bin'], codexHome: args['codex-home'] })
        const versionPath = join(stateDir, 'versions', fileName)
        renameSync(staged, versionPath)
        atomicWrite(join(stateDir, 'versions', fileName.replace(/\.json$/, '.meta.json')), JSON.stringify({
          ...meta,
          catalogVersion: version,
          generation: record.generation,
          generationKey: record.key,
          configFingerprint: record.configFingerprint,
          generatedAt,
          format: args.format,
          sourceFingerprint: fingerprint,
          verified,
        }, null, 2) + '\n')
        atomicWrite(out, record.text)
        const committedState = Object.assign({}, rec.state, {
          current: Object.assign({}, rec.state.current, { verified }),
        })
        atomicWrite(join(stateDir, STATE_FILE), JSON.stringify(committedState, null, 2) + '\n')
        rec.verified = verified
        rec.state = committedState
      } finally {
        rmSync(staged, { force: true })
      }
    },
  }
  persistAndSwapValidatedGeneration(state.currentVersion, next, io)
  summary.verified = next.verified
  summary.versionFile = join('versions', fileName)
  if (args.json) printJson(summary)
  else {
    process.stdout.write('catalog v' + version + ' -> ' + out + '\n')
    process.stdout.write('format: ' + args.format + ' | schema: ' + (meta.catalogSchema || '') + '\n')
    process.stdout.write('models: ' + meta.counts.total + ' (official ' + meta.counts.official + ', third-party ' + meta.counts.thirdParty + ')\n')
    if (diff) {
      process.stdout.write('diff vs v' + (state.current ? state.current.version : '?') + ': +' + diff.counts.added + ' -' + diff.counts.removed + ' ~' + diff.counts.changed + '\n')
      for (const line of formatDiffLines(diff, meta.bindings)) process.stdout.write(line + '\n')
    } else {
      process.stdout.write('diff: 无上一版本，按全量新增处理\n')
    }
    process.stdout.write('version: ' + join('versions', fileName) + ' (history ' + Math.min(historyLimit, next.state.history.length) + ')\n')
    process.stdout.write('generation: ' + record.generation + ' key ' + record.key.slice(0, 12) + '\n')
    process.stdout.write('state: ' + join(stateDir, STATE_FILE) + '\n')
    if (summary.verified) process.stdout.write('verified: codex ' + summary.verified.codexVersion + ', ' + summary.verified.modelCount + ' models parsed\n')
    printWarnings(meta, args.json)
  }
  return { code: EXIT.OK, summary }
}

function status(args) {
  const stateDir = stateDirFor(args, args.out)
  const { state, existed } = readState(stateDir)
  const out = args.out ? assertSafeOutPath(args.out) : null
  let outInfo = null
  if (out) {
    const exists = existsSync(out)
    const digest = exists ? sha256(readFileSync(out, 'utf8')) : null
    outInfo = {
      path: out,
      exists,
      sha256: digest,
      matchesPublished: !!(state.current && digest === state.current.sha256),
      clientMayBeStale: !exists || !state.current || digest !== state.current.sha256,
    }
  }
  const payload = {
    ok: true,
    mode: 'status',
    stateDir,
    stateExists: existed,
    currentVersion: state.currentVersion,
    published: state.current,
    out: outInfo,
    history: (state.history || []).map(item => ({ version: item.version, sha256: item.sha256, generatedAt: item.generatedAt, counts: item.counts, verified: item.verified })),
    bindings: Object.keys((state.current && state.current.bindings) || {}).length,
    retiredBindings: Object.keys(state.retiredBindings || {}).length,
    lastRollback: state.lastRollback || null,
  }
  if (args.json) printJson(payload)
  else {
    process.stdout.write('state: ' + stateDir + ' (' + (existed ? 'exists' : 'missing') + ')\n')
    process.stdout.write('current: v' + state.currentVersion + (state.current ? ' ' + state.current.file : ' (未发布)') + '\n')
    if (state.current) {
      process.stdout.write('published: ' + state.current.counts.total + ' models, sha256 ' + state.current.sha256.slice(0, 12) + ', ' + state.current.generatedAt + '\n')
      process.stdout.write('verified: ' + (state.current.verified ? 'codex ' + state.current.verified.codexVersion + ' / ' + state.current.verified.modelCount + ' models' : 'NOT_RUN') + '\n')
    }
    if (outInfo) {
      process.stdout.write('out: ' + outInfo.path + '\n')
      process.stdout.write('  exists=' + outInfo.exists + ' matchesPublished=' + outInfo.matchesPublished + ' clientMayBeStale=' + outInfo.clientMayBeStale + '\n')
    }
    process.stdout.write('history: ' + payload.history.map(h => 'v' + h.version).join(', ') + '\n')
    process.stdout.write('bindings: ' + payload.bindings + ' active, ' + payload.retiredBindings + ' retired\n')
    if (state.lastRollback) process.stdout.write('lastRollback: v' + state.lastRollback.from + ' -> v' + state.lastRollback.to + ' @ ' + state.lastRollback.at + '\n')
  }
  return { code: EXIT.OK, summary: payload }
}

function listVersions(args) {
  const stateDir = stateDirFor(args, args.out)
  const { state } = readState(stateDir)
  const history = (state.history || []).map(item => ({
    version: item.version,
    file: item.file,
    sha256: item.sha256,
    generatedAt: item.generatedAt,
    format: item.format,
    counts: item.counts,
    bindings: Object.keys(item.bindings || {}).length,
    verified: item.verified ? 'codex ' + item.verified.codexVersion : 'NOT_RUN',
    current: !!(state.current && state.current.version === item.version),
  }))
  const payload = { ok: true, mode: 'list-versions', stateDir, currentVersion: state.currentVersion, versions: history }
  if (args.json) printJson(payload)
  else {
    if (!history.length) process.stdout.write('no published versions in ' + stateDir + '\n')
    for (const item of history) {
      process.stdout.write((item.current ? '* ' : '  ') + 'v' + item.version + ' ' + item.file + ' ' + item.counts.total + ' models ' + item.verified + ' ' + item.generatedAt + '\n')
    }
  }
  return { code: EXIT.OK, summary: payload }
}

function rollback(args) {
  if (!args.out) throw fail('usage', '回滚需要 --out 指向要覆盖的目录文件')
  const out = assertSafeOutPath(args.out)
  const stateDir = stateDirFor(args, out)
  const { state } = readState(stateDir)
  const target = resolveRollbackTarget(state, args.rollback)
  const file = join(stateDir, target.file)
  if (!existsSync(file)) throw fail('io_read', '回滚目标版本文件不存在：' + file)
  const text = readFileSync(file, 'utf8')
  assertCatalog(JSON.parse(text), { source: 'rollback target' })
  if (sha256(text) !== target.sha256) {
    throw fail('rollback_integrity', '回滚目标文件 sha256 与状态记录不一致：' + target.file)
  }
  const at = new Date().toISOString()
  // 回滚同样是 CAS：读取后若已有并发发布，拒绝覆盖（避免把新代回滚成旧代）。
  const fresh = readState(stateDir).state
  if (fresh.currentVersion !== state.currentVersion) {
    throw fail('generation_conflict', '回滚期间目录世代已变化（期望 ' + state.currentVersion + '，当前 ' + fresh.currentVersion + '），拒绝发布')
  }
  if (args['dry-run']) {
    const payload = { ok: true, mode: 'rollback', dryRun: true, out, from: state.current ? state.current.version : null, to: target.version, file: target.file }
    if (args.json) printJson(payload)
    else process.stdout.write('[dry-run] would rollback ' + out + ' from v' + payload.from + ' to v' + target.version + '\n')
    return { code: EXIT.OK, summary: payload }
  }
  atomicWrite(out, text)
  const nextState = markRollback(state, target, at)
  atomicWrite(join(stateDir, STATE_FILE), JSON.stringify(nextState, null, 2) + '\n')
  const payload = {
    ok: true,
    mode: 'rollback',
    out,
    from: state.current ? state.current.version : null,
    to: target.version,
    sha256: target.sha256,
    file: target.file,
    at,
  }
  if (args.json) printJson(payload)
  else process.stdout.write('rolled back ' + out + ': v' + payload.from + ' -> v' + target.version + ' (' + target.file + ')\n')
  return { code: EXIT.OK, summary: payload }
}

function main(argv) {
  const args = parseArgs(argv)
  if (args.command === 'help') {
    process.stdout.write(usage() + '\n')
    return EXIT.OK
  }
  const result = args.command === 'status' ? status(args)
    : args.command === 'list-versions' ? listVersions(args)
      : args.command === 'rollback' ? rollback(args)
        : generate(args)
  return result.code
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (err) {
  const code = err instanceof CatalogError ? err.code : 'internal_error'
  const exitCode = CONFLICT_CODES.has(code) ? EXIT.CONFLICT
    : code === 'codex_verify_failed' ? EXIT.VERIFY
      : (code === 'io_read' || code === 'io_write') ? EXIT.IO
        : USAGE_CODES.has(code) ? EXIT.USAGE
          : EXIT.INVALID
  const wantsJson = process.argv.includes('--json')
  if (wantsJson) {
    process.stdout.write(JSON.stringify({ ok: false, error: { code, message: err.message, details: err.details || {} } }, null, 2) + '\n')
  } else {
    process.stderr.write('error[' + code + ']: ' + err.message + '\n')
    if (err.details && Array.isArray(err.details.errors)) {
      for (const item of err.details.errors.slice(0, 12)) process.stderr.write('  - ' + item.path + ': ' + item.message + '\n')
      if (err.details.errors.length > 12) process.stderr.write('  … 其余 ' + (err.details.errors.length - 12) + ' 项\n')
    }
    if (err.details && Array.isArray(err.details.conflicts)) {
      for (const item of err.details.conflicts) process.stderr.write('  - ' + item.slug + ': ' + item.from.provider + '/' + item.from.model + ' -> ' + item.to.provider + '/' + item.to.model + '\n')
    }
  }
  process.exitCode = exitCode
}