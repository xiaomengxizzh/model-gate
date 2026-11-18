// A3 / P03：原版 Codex Desktop 一键接入的配置集成层。
//
// 契约（ADR-0003 §2 冻结）：detect / preview / activate / deactivate / status。
//  * 每次写盘都走 src/codex/config.js 的事务语义：预检快照 → 合并 → 二次快照 → 备份 →
//    原子写 → 写后校验。本模块不重写 TOML 合并、不新建第二把配置锁的语义（这里是
//    "桌面接入流程锁"，只用来串行化 activate/deactivate/recover，不替代 configVersion）。
//  * 只写 config.js 声明的 owned 字段：model_provider / openai_base_url / model /
//    model_catalog_json 与 [features] 的 multi_agent(_v2)。其余行逐字节保留。
//  * 绝不读写 auth.json；只接受显式绝对 config.toml 路径（不猜 HOME，detect 负责解析）。
//  * 写盘不算成功：写后必须通过"配置解析 + 目录存在且包含目标模型 + 网关健康"三项验证。
//  * 失败/崩溃只回滚"仍然属于我们"的字节；用户或第三方改过就返回三方差异，绝不覆盖。
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import {
  ConfigError,
  MANAGED_AGENT_FILE,
  MANAGED_AGENT_SECTION,
  MANAGED_PROVIDER_ID,
  MANAGED_PROVIDER_SECTIONS,
  OWNED_SECTIONS,
  OWNED_TOP_LEVEL,
  REMOTE_COMPACTION_LITERALS,
  RESERVED_OVERRIDE_SECTIONS,
  SENSITIVE_FIELD_RE,
  atomicWriteFile,
  buildDesiredCodexConfig,
  buildManagedAgentConfig,
  commitConfigPlan,
  commitConfigRollback,
  diffConfigText,
  mergeOwnedFields,
  normalizeOwnedValue,
  parseConfigDocument,
  planRollback,
  readOwnedFields,
  sha256Hex,
  snapshotConfigFile,
  summarizePreserved,
  unmanagedFingerprint,
  withManagedAgentDesired,
} from './config.js'
import {
  AGGREGATION_MODES,
  DEFAULT_PARENT_MODEL,
  DEEPSEEK_CHILD_MODEL,
  ROUTE_MODEL,
  modeDescriptor,
  resolveModeTarget,
} from './profiles.js'

export const DESKTOP_CONTRACT = 'mg-codex-desktop/1'
export const STATE_SCHEMA = 'mg-codex-desktop-state/1'
export const JOURNAL_SCHEMA = 'mg-codex-desktop-journal/1'
export const MAX_CATALOG_BYTES = 4 * 1024 * 1024
export const DEFAULT_LOCK_STALE_MS = 120000
export const DEFAULT_GATEWAY_BASE_URL = 'http://127.0.0.1:18787'
export const MODES = Object.freeze(['official', 'route', 'aggregated', 'unknown'])
const MAX_CONFIG_BYTES = 512 * 1024

export class DesktopError extends Error {
  constructor (code, message, detail, status) {
    super(message)
    this.name = 'DesktopError'
    this.code = code
    this.detail = detail === undefined ? null : detail
    this.status = status === undefined ? 500 : status
  }
}

function asDesktopError (error, fallbackCode) {
  if (error instanceof DesktopError) return error
  if (error instanceof ConfigError) {
    const status = {
      concurrent_modification: 409,
      unmanaged_conflict: 409,
      duplicate_section: 422,
      duplicate_key: 422,
      unsupported_layout: 422,
      multiline_value: 422,
      too_large: 413,
    }[error.code] || 422
    return new DesktopError(error.code, error.message, error.detail, status)
  }
  return new DesktopError(fallbackCode || 'desktop_integration_failed', error && error.message ? error.message : '未知错误', null, 500)
}

// —— 路径 ——
export function resolveDesktopPaths (opts = {}) {
  const codexHome = String(opts.codexHome || process.env.CODEX_HOME || (process.env.HOME ? join(process.env.HOME, '.codex') : '')).trim()
  if (!codexHome) throw new DesktopError('config_path_unresolved', '无法确定 Codex 配置目录：请设置 CODEX_HOME 或显式传入 configPath。', null, 422)
  const configPath = resolve(String(opts.configPath || join(codexHome, 'config.toml')))
  if (basename(configPath) !== 'config.toml') {
    throw new DesktopError('invalid_config_path', '集成层只接受 config.toml：' + basename(configPath), null, 422)
  }
  if (/auth\.json/i.test(configPath)) throw new DesktopError('forbidden_path', 'auth.json 永不读写。', null, 422)
  return {
    codexHome,
    configPath,
    lockPath: configPath + '.mg-lock',
    journalPath: configPath + '.mg-journal.json',
    statePath: resolve(String(opts.statePath || join(dirname(configPath), '.modelgate-desktop-state.json'))),
    // MG-FIX-P1-05：Codex 原生命名子代理文件，默认在 codexHome 下；测试可用 managedAgentPath 覆盖到临时目录。
    managedAgentPath: resolve(String(opts.managedAgentPath || join(codexHome, MANAGED_AGENT_FILE))),
  }
}

function readJsonFile (path) {
  try {
    const text = readFileSync(path, 'utf8')
    if (Buffer.byteLength(text, 'utf8') > MAX_CONFIG_BYTES) return { ok: false, reason: 'oversize' }
    return { ok: true, value: JSON.parse(text) }
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: false, reason: 'missing' }
    return { ok: false, reason: 'unreadable' }
  }
}

function writeAtomicJson (path, value, mode) {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, '.' + basename(path) + '.mg-' + process.pid + '-' + randomBytes(6).toString('hex') + '.tmp')
  let fd = null
  try {
    fd = openSync(tmp, 'wx', mode || 0o600)
    writeSync(fd, Buffer.from(JSON.stringify(value, null, 2), 'utf8'))
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(tmp, path)
  } catch (e) {
    try { if (fd != null) closeSync(fd) } catch {}
    try { unlinkSync(tmp) } catch {}
    throw new DesktopError('state_write_failed', '写入接入状态失败：' + (e && e.message ? e.message : '未知错误'), null, 500)
  }
}

// —— 流程锁：只串行化本模块的 activate/deactivate/recover，不替代 configVersion ——
function readLock (lockPath, now) {
  let st = null
  try { st = lstatSync(lockPath) } catch { return { present: false } }
  if (st.isSymbolicLink()) return { present: true, malformed: true, stale: false }
  const parsed = readJsonFile(lockPath)
  const ageMs = Math.max(0, now - Number(st.mtimeMs || 0))
  return {
    present: true,
    malformed: !parsed.ok,
    nonce: parsed.ok ? String(parsed.value.nonce || '') : null,
    pid: parsed.ok && Number.isInteger(parsed.value.pid) ? parsed.value.pid : null,
    at: parsed.ok ? Number(parsed.value.at) || null : null,
    ageMs,
    stale: ageMs > (parsed.ok && Number.isFinite(parsed.value.staleMs) ? Number(parsed.value.staleMs) : DEFAULT_LOCK_STALE_MS),
  }
}

export function acquireDesktopLock (opts = {}) {
  const { lockPath } = resolveDesktopPaths(opts)
  const now = Number.isFinite(opts.now) ? Number(opts.now) : Date.now()
  const staleMs = Number.isFinite(opts.staleMs) ? Number(opts.staleMs) : DEFAULT_LOCK_STALE_MS
  const nonce = randomBytes(12).toString('hex')
  const payload = JSON.stringify({ schema: DESKTOP_CONTRACT + '/lock', nonce, pid: process.pid, at: now, staleMs })
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd = null
    try {
      fd = openSync(lockPath, 'wx', 0o600)
      writeSync(fd, Buffer.from(payload, 'utf8'))
      fsyncSync(fd)
      closeSync(fd)
      fd = null
      return {
        ok: true,
        nonce,
        path: lockPath,
        release: () => {
          const current = readJsonFile(lockPath)
          if (!current.ok || String(current.value.nonce) !== nonce) return false
          try { unlinkSync(lockPath) } catch { return false }
          return true
        },
      }
    } catch (e) {
      try { if (fd != null) closeSync(fd) } catch {}
      if (!e || e.code !== 'EEXIST') throw new DesktopError('lock_failed', '获取接入流程锁失败：' + (e && e.message ? e.message : '未知错误'), null, 500)
      const lock = readLock(lockPath, now)
      if (lock.stale) {
        try { unlinkSync(lockPath) } catch {}
        continue
      }
      throw new DesktopError('lock_held', '另一个 ModelGate 操作正在进行（接入流程锁未释放），请稍后重试。', { lockPath: lockPath, stale: false }, 409)
    }
  }
  throw new DesktopError('lock_held', '接入流程锁无法获取。', null, 409)
}

function readConfigText (target) {
  const snap = snapshotConfigFile(target)
  if (!snap.exists) return { snap, text: '', owned: readOwnedFields('') }
  const text = readFileSync(target, 'utf8')
  if (Buffer.byteLength(text, 'utf8') > MAX_CONFIG_BYTES) {
    throw new DesktopError('config_too_large', 'config.toml 超过 ' + MAX_CONFIG_BYTES + ' 字节，拒绝自动接入。', null, 413)
  }
  return { snap, text, owned: readOwnedFields(text) }
}

// —— MG-FIX-P1-05：Codex 原生命名子代理文件（go-deepseek.toml）托管 ——
// 与 config.toml 的 owned 字段同一事务语义：启用写入规范字节；退出字节兼容恢复（我们新建的
// 删除、接入前存在的按备份逐字节还原）；用户自行改过 → 409 三方差异，绝不覆盖。
const AGENT_CHILD_MAX_BYTES = 64 * 1024

function snapshotManagedAgentChild (path) {
  let st = null
  try { st = lstatSync(path) } catch { return { exists: false, sha256: '', size: 0, mode: 0, symlink: false } }
  if (st.isSymbolicLink()) return { exists: true, sha256: '', size: 0, mode: st.mode & 0o777, symlink: true }
  try {
    const bytes = readFileSync(path)
    if (bytes.length > AGENT_CHILD_MAX_BYTES) return { exists: true, sha256: '', size: bytes.length, mode: st.mode & 0o777, symlink: false, oversize: true }
    return { exists: true, sha256: sha256Hex(bytes), size: bytes.length, mode: st.mode & 0o777, symlink: false, bytes }
  } catch {
    return { exists: true, sha256: '', size: st.size, mode: st.mode & 0o777, symlink: false, unreadable: true }
  }
}

function agentChildThreeWay (baseText, theirsText, guidance) {
  return {
    contract: DESKTOP_CONTRACT + '/three-way/agent-child',
    base: { sha256: sha256Hex(String(baseText || '')), size: Buffer.byteLength(String(baseText || ''), 'utf8') },
    ours: { sha256: sha256Hex(String(baseText || '')), size: Buffer.byteLength(String(baseText || ''), 'utf8') },
    theirs: { sha256: sha256Hex(String(theirsText || '')), size: Buffer.byteLength(String(theirsText || ''), 'utf8') },
    oursVsTheirs: redactDiffRows(diffConfigText(baseText, theirsText)).slice(0, 400),
    baseVsTheirs: redactDiffRows(diffConfigText(baseText, theirsText)).slice(0, 400),
    guidance,
  }
}

// 计算启用时的子代理文件计划。不写盘。
function planManagedAgentChild (paths, opts, desired, prevRecord) {
  const childPath = paths.managedAgentPath
  if (opts.managedAgent === false || !String(opts.model || '').trim()) {
    return { path: childPath, fileName: MANAGED_AGENT_FILE, managed: false, action: 'none', conflict: null,
      text: '', model: null, reasoningEffort: null,
      before: { exists: false, sha256: '', size: 0 }, after: { exists: false, sha256: '', size: 0 } }
  }
  const built = buildManagedAgentConfig({ model: opts.model, reasoningEffort: opts.agentReasoningEffort })
  const childText = built.child.text
  const afterSha = sha256Hex(Buffer.from(childText, 'utf8'))
  const before = snapshotManagedAgentChild(childPath)
  const plan = {
    path: childPath,
    fileName: MANAGED_AGENT_FILE,
    managed: true,
    model: built.child.model,
    reasoningEffort: built.child.reasoningEffort,
    text: childText,
    before: { exists: before.exists, sha256: before.sha256, size: before.size },
    after: { exists: true, sha256: afterSha, size: Buffer.byteLength(childText, 'utf8') },
    action: 'create',
    conflict: null,
  }
  if (before.symlink || before.unreadable || before.oversize) {
    plan.action = 'conflict'
    plan.conflict = {
      reason: before.symlink ? 'agent_child_symlink' : (before.oversize ? 'agent_child_oversize' : 'agent_child_unreadable'),
      path: childPath,
    }
    return plan
  }
  if (!before.exists) { plan.action = 'create'; return plan }
  if (before.sha256 === afterSha) { plan.action = 'same'; return plan }
  // 已存在且与目标字节不同：先识别是否是我们上次写入的规范字节（状态记录或字节级规范形状），
  // 是 → 允许升级（换模型/effort 不再永久 409，2026-11-16 审计 P1-5）；否 → 用户所有，拒绝覆盖。
  const prevAppliedSha = prevRecord && prevRecord.applied ? prevRecord.applied.sha256 : null
  if (prevAppliedSha && before.sha256 === prevAppliedSha) {
    plan.action = 'upgrade'
    return plan
  }
  const theirsText = readFileSync(childPath, 'utf8')
  if (isCanonicalManagedChildText(theirsText, opts.model)) {
    // 状态漂移（记录丢失/早期版本写入）但文件恰为 ModelGate 规范形状：按可升级的托管文件对待。
    plan.action = 'upgrade'
    return plan
  }
  plan.action = 'conflict'
  plan.conflict = {
    reason: 'agent_child_modified',
    path: childPath,
    threeWay: agentChildThreeWay(childText, theirsText,
      'go-deepseek.toml 不是 ModelGate 写入的规范内容；为不覆盖你的修改，本次不写入。请手工合并后重试，或移走该文件。'),
  }
  return plan
}

// 字节级规范形状识别：仅 model + model_reasoning_effort 两键、与 buildManagedAgentConfig
// 对同一 (model, effort) 的输出逐字一致，且 model 属于 ModelGate 托管别名（本次目标模型或
// mg-opencodego- 命名空间）。用户自有模型（如 "user-own"）即使形状相同也判非托管（保守）。
function isCanonicalManagedChildText (text, expectedModel) {
  const modelMatch = /^model = "([^"]+)"$/m.exec(String(text))
  const effortMatch = /^model_reasoning_effort = "([^"]+)"$/m.exec(String(text))
  if (!modelMatch || !effortMatch) return false
  const model = modelMatch[1]
  if (model !== String(expectedModel || '') && !model.startsWith('mg-opencodego-')) return false
  try {
    const built = buildManagedAgentConfig({ model, reasoningEffort: effortMatch[1] })
    return built.child.text === text
  } catch { return false }
}

// 写入子代理文件：先留原始字节备份，再原子替换并写后校验；失败尽量恢复原状。
function commitManagedAgentChild (childPlan) {
  const path = childPlan.path
  const before = childPlan.before
  let backupPath = null
  if (before.exists) {
    backupPath = path + '.mg-bak'
    try { writeAtomicTextFile(backupPath, readFileSync(path, 'utf8'), 0o600) } catch (e) {
      throw new DesktopError('agent_child_backup_failed', '子代理文件备份失败：' + (e && e.message ? e.message : '未知错误'), null, 500)
    }
  }
  try { writeAtomicTextFile(path, childPlan.text, 0o600) } catch (e) {
    throw new DesktopError('agent_child_write_failed', '写入子代理文件失败：' + (e && e.message ? e.message : '未知错误'), null, 500)
  }
  const after = snapshotManagedAgentChild(path)
  if (!after.exists || after.sha256 !== childPlan.after.sha256) {
    try { if (before.exists && backupPath) writeAtomicTextFile(path, readFileSync(backupPath), 0o600); else unlinkSync(path) } catch {}
    throw new DesktopError('agent_child_verify_failed', '子代理文件写入后校验失败，已尝试恢复原状。', { expected: childPlan.after.sha256, actual: after.sha256 }, 502)
  }
  return { path, backupPath, sha: after.sha256, size: after.size }
}

function agentChildRecord (childPlan, commit, adopted) {
  return {
    path: childPlan.path,
    fileName: MANAGED_AGENT_FILE,
    model: childPlan.model,
    reasoningEffort: childPlan.reasoningEffort,
    text: childPlan.text,
    before: childPlan.before,
    applied: childPlan.after,
    backupPath: commit ? commit.backupPath : null,
    // adopted：接入前就存在且恰好等于规范字节；我们没写它，退出时也不动它，只跟踪用户改动。
    adopted: !!adopted,
  }
}

// 退出时先"只检查不写"：返回 conflict / error（备份问题）/ action。任何 conflict/error 都必须在
// config.toml 回滚之前判定，保证"用户改过子代理文件 → 409 且零写入"。
function planManagedAgentChildRestore (paths, state) {
  const rec = state && state.agentChild
  if (!rec || !rec.path) return { action: 'none', conflict: null, error: null, record: null }
  const path = rec.path
  const current = snapshotManagedAgentChild(path)
  const oursSha = rec.applied && rec.applied.sha256 ? rec.applied.sha256 : ''
  const canonicalText = rec.text || buildManagedAgentConfig({ model: rec.model, reasoningEffort: rec.reasoningEffort }).child.text
  const plan = { action: 'none', conflict: null, error: null, record: rec, path, canonicalText }
  if (rec.adopted) {
    // 接入前就存在且由我们"认领"的规范文件：我们从未改写，退出时保持原状，不创建也不删除；
    // 但若用户后来改过它，依然是三方冲突。
    if (current.exists && current.sha256 !== oursSha) {
      plan.conflict = {
        reason: 'agent_child_modified',
        path,
        threeWay: agentChildThreeWay(canonicalText, readFileSync(path, 'utf8'),
          'go-deepseek.toml 在接入后被修改；为不覆盖你的改动，退出已中止。请查看三方差异后手工处理。'),
      }
    }
    return plan
  }
  if (current.symlink || current.unreadable || current.oversize) {
    plan.error = { code: current.symlink ? 'agent_child_symlink' : 'agent_child_unreadable', message: '子代理文件状态异常，拒绝自动恢复，请人工处理。' }
    return plan
  }
  if (!current.exists) {
    plan.action = (!rec.before || !rec.before.exists) ? 'none' : 'restore'
  } else if (oursSha && current.sha256 === oursSha) {
    plan.action = (!rec.before || !rec.before.exists) ? 'remove' : 'restore'
  } else {
    plan.conflict = {
      reason: 'agent_child_modified',
      path,
      threeWay: agentChildThreeWay(canonicalText, readFileSync(path, 'utf8'),
        'go-deepseek.toml 在接入后被修改；为不覆盖你的改动，退出已中止。请查看三方差异后手工处理。'),
    }
    return plan
  }
  if (plan.action === 'restore') {
    if (!rec.backupPath || !existsSync(rec.backupPath)) {
      plan.error = { code: 'agent_child_backup_missing', message: '子代理文件的接入前备份不存在，拒绝自动恢复（未做任何写入）。' }
    } else {
      const bytes = readFileSync(rec.backupPath)
      if (rec.before && rec.before.sha256 && sha256Hex(bytes) !== rec.before.sha256) {
        plan.error = { code: 'agent_child_backup_mismatch', message: '子代理文件备份与接入前快照不一致，拒绝自动恢复。' }
      }
    }
  }
  return plan
}

function applyManagedAgentChildRestore (plan) {
  if (!plan || plan.action === 'none') return { handled: false }
  const rec = plan.record
  const path = plan.path
  if (plan.action === 'remove') {
    try { unlinkSync(path) } catch (e) {
      if (e && e.code === 'ENOENT') return { handled: true, removed: true }
      throw new DesktopError('agent_child_restore_failed', '删除 ModelGate 新建的子代理文件失败：' + (e && e.message ? e.message : '未知错误'), null, 500)
    }
    return { handled: true, removed: true, restored: false }
  }
  const bytes = readFileSync(rec.backupPath)
  try { writeAtomicTextFile(path, bytes, 0o600) } catch (e) {
    throw new DesktopError('agent_child_restore_failed', '恢复子代理文件原始字节失败：' + (e && e.message ? e.message : '未知错误'), null, 500)
  }
  const after = snapshotManagedAgentChild(path)
  if (rec.before && rec.before.sha256 && after.sha256 !== rec.before.sha256) {
    throw new DesktopError('agent_child_restore_verify_failed', '子代理文件恢复后 sha256 与接入前不一致。', { expected: rec.before.sha256, actual: after.sha256 }, 502)
  }
  return { handled: true, removed: false, restored: true, sha: after.sha256 }
}

// —— 配置状态分类：official（直连）/ route（路由）/ aggregated（聚合）/ unknown ——
// route：model_provider="modelgate" + [model_providers.modelgate] + 回环 base_url + 目录存在。
// aggregated：内置身份 + 回环 openai_base_url + 目录存在，或状态记录与当前字节一致。
// official：没有任何改向字段（或只存在我们写入前的默认值）。
// unknown：用户自己指向非回环地址、文件损坏/超限/符号链接等——给明确路径，不猜。
// drifted：形态仍可识别，但当前字节与 state.appliedSha 不一致（本机漂移）。
export function classifyConfigState (opts = {}) {
  const paths = resolveDesktopPaths(opts)
  const baseUrl = String(opts.baseUrl || DEFAULT_GATEWAY_BASE_URL).replace(/\/+$/, '')
  let st = null
  try { st = lstatSync(paths.configPath) } catch {}
  if (st && st.isSymbolicLink()) return { mode: 'unknown', reason: 'symlink_config', exists: true, sha256: null, size: null, drifted: false }
  if (!st) return { mode: 'official', reason: 'config_absent', exists: false, sha256: null, size: null, drifted: false }
  let snap
  let text
  try {
    snap = snapshotConfigFile(paths.configPath)
    text = readFileSync(paths.configPath, 'utf8')
  } catch (e) {
    return { mode: 'unknown', reason: e && e.code ? e.code : 'unreadable', exists: true, sha256: null, size: null, drifted: false }
  }
  let owned
  try {
    owned = readOwnedFields(text)
  } catch (e) {
    return { mode: 'unknown', reason: e && e.code ? e.code : 'parse_failed', exists: true, sha256: snap.sha256, size: snap.size, drifted: false }
  }
  const state = loadState(paths)
  const norm = (entry) => {
    const v = normalizeOwnedValue(entry)
    return typeof v === 'string' ? v.trim() : ''
  }
  const provider = norm(owned.topLevel.model_provider)
  const url = norm(owned.topLevel.openai_base_url)
  const catalog = norm(owned.topLevel.model_catalog_json)
  const section = owned.sections['model_providers.modelgate']
  const mgBase = section && section.present ? norm(section.keys.base_url) : ''
  const loopback = isLoopbackUrl(url) || (!!url && String(baseUrl) === url.replace(/\/+$/, ''))
  const loopbackMg = isLoopbackUrl(mgBase) || (!!mgBase && (String(baseUrl) + '/v1' === mgBase.replace(/\/+$/, '') || String(baseUrl) === mgBase.replace(/\/+$/, '')))
  let mode
  let reason
  if (provider === MANAGED_PROVIDER_ID && section && section.present && loopbackMg && catalog) {
    mode = 'route'
    reason = 'managed_provider_loopback_with_catalog'
  } else if (!url && !catalog && provider !== MANAGED_PROVIDER_ID) {
    mode = 'official'
    reason = 'no_redirect_fields'
  } else if (loopback && catalog) {
    mode = 'aggregated'
    reason = 'loopback_redirect_with_catalog'
  } else {
    mode = 'unknown'
    reason = 'third_party_redirect'
  }
  const drifted = !!(state && state.appliedSha && snap.sha256 !== state.appliedSha && mode !== 'unknown')
  if (state && state.mode === mode && snap.sha256 === state.appliedSha) {
    return { mode, reason: 'state_record_match', exists: true, sha256: snap.sha256, size: snap.size, drifted: false }
  }
  return { mode, reason, exists: true, sha256: snap.sha256, size: snap.size, drifted }
}

function isLoopbackUrl (value) {
  try {
    const u = new URL(String(value))
    const host = u.hostname.replace(/^\[|\]$/g, '')
    return u.protocol === 'http:' && (host === '127.0.0.1' || host === 'localhost' || host === '::1')
  } catch { return false }
}

// —— 状态与崩溃日志 ——
function loadState (paths) {
  const parsed = readJsonFile(paths.statePath)
  if (!parsed.ok) return null
  const v = parsed.value
  if (!v || v.schema !== STATE_SCHEMA || !MODES.includes(String(v.mode))) return null
  return v
}

function saveState (paths, record) {
  writeAtomicJson(paths.statePath, Object.assign({ schema: STATE_SCHEMA }, record), 0o600)
}

function journalPhase (paths) {
  const parsed = readJsonFile(paths.journalPath)
  if (!parsed.ok) return null
  const v = parsed.value
  if (!v || v.schema !== JOURNAL_SCHEMA) return { malformed: true }
  return v
}

// 崩溃恢复（在持锁时调用）：
//  applying → 已写入但未验证：字节仍是我们的就恢复原文件；不是就保留并报告冲突。
//  verified → 已通过验证但没来得及落状态：补写状态，视为成功。
export function recoverInterruptedApply (opts = {}) {
  const paths = resolveDesktopPaths(opts)
  const journal = journalPhase(paths)
  if (!journal) return { recovered: 'none' }
  if (journal.malformed) {
    try { unlinkSync(paths.journalPath) } catch {}
    return { recovered: 'discarded_malformed_journal' }
  }
  let current = null
  try { current = snapshotConfigFile(paths.configPath) } catch { current = null }
  if (journal.phase === 'verified') {
    saveState(paths, {
      mode: journal.toMode || 'aggregated',
      before: journal.before || null,
      applied: journal.applied || null,
      appliedSha: journal.applied ? journal.applied.sha256 : null,
      beforeSha: journal.before ? journal.before.sha256 : null,
      backupPath: journal.backupPath || null,
      desired: journal.desired || null,
      agentChild: journal.agentChild || null,
      previous: journal.previous || null,
      fromMode: journal.fromMode || 'official',
      toMode: journal.toMode || 'aggregated',
      appliedAt: journal.at || null,
      lastApply: journal.lastApply || { ok: true, recoveredAfterCrash: true, at: Date.now() },
    })
    try { unlinkSync(paths.journalPath) } catch {}
    return { recovered: 'finalized_verified' }
  }
  // phase === 'applying'
  if (current && current.exists && journal.applied && current.sha256 === journal.applied.sha256) {
    // MG-FIX-P1-05：子代理文件若已被用户改过，整个恢复判冲突，不覆盖任何一边。
    let childRestore = null
    if (journal.agentChild) {
      childRestore = planManagedAgentChildRestore(paths, { agentChild: journal.agentChild })
      if (childRestore.conflict || childRestore.error) {
        return { recovered: 'conflict', reason: 'agent_child_conflict_since_crash', detail: childRestore.conflict || childRestore.error }
      }
    }
    const restored = restoreIfOurs(paths, journal)
    if (restored.ok) {
      if (childRestore) { try { applyManagedAgentChildRestore(childRestore) } catch {} }
      saveState(paths, {
        mode: journal.fromMode || 'official',
        before: journal.before || null,
        applied: null,
        appliedSha: null,
        beforeSha: journal.before ? journal.before.sha256 : null,
        backupPath: journal.backupPath || null,
        desired: null,
        agentChild: null,
        previous: journal.previous || null,
        fromMode: journal.fromMode || 'official',
        toMode: journal.toMode || 'aggregated',
        appliedAt: null,
        lastApply: { ok: false, code: 'interrupted_apply_recovered', recoveredAfterCrash: true, at: Date.now() },
      })
      try { unlinkSync(paths.journalPath) } catch {}
      return { recovered: 'restored_after_crash', sha: restored.sha }
    }
    return { recovered: 'conflict', reason: 'restore_failed', detail: restored.detail || null }
  }
  if (current && current.exists && journal.before && current.sha256 === journal.before.sha256) {
    try { unlinkSync(paths.journalPath) } catch {}
    return { recovered: 'nothing_written' }
  }
  if (journal.before && journal.before.exists === false && current && !current.exists) {
    try { unlinkSync(paths.journalPath) } catch {}
    return { recovered: 'nothing_written' }
  }
  return {
    recovered: 'conflict',
    reason: 'external_modification_since_crash',
    detail: { currentSha: current && current.sha256 ? current.sha256 : null, journalAppliedSha: journal.applied ? journal.applied.sha256 : null },
  }
}

function restoreIfOurs (paths, journal) {
  const current = snapshotConfigFile(paths.configPath)
  if (!journal.applied || current.sha256 !== journal.applied.sha256) return { ok: false, detail: 'not_ours' }
  if (journal.before && journal.before.exists === false) {
    try { unlinkSync(paths.configPath) } catch (e) { return { ok: false, detail: e && e.message } }
    return { ok: true, sha: '' }
  }
  if (!journal.backupPath) return { ok: false, detail: 'backup_missing' }
  try {
    const backupBytes = readFileSync(journal.backupPath)
    const backupSha = sha256Hex(backupBytes)
    if (journal.before && backupSha !== journal.before.sha256) return { ok: false, detail: 'backup_mismatch' }
    const plan = planRollback({ path: paths.configPath, backupPath: journal.backupPath })
    const result = commitConfigRollback(plan)
    return { ok: true, sha: result.after.sha256 }
  } catch (e) {
    return { ok: false, detail: e && e.message ? e.message : 'restore_failed' }
  }
}

// —— 重启提示状态机（V2-01）——
// 原版 Desktop 不会热加载模型目录：写入后必须重启/重开。旧实现把 needsRestart 固定成
// "只要处于聚合模式就是 true"，重启后仍永远提示。这里改为只读地比对客户端进程启动时间
// 与本次写入时间：客户端在写入之后启动过 → 已生效；仍在用旧进程 → 明确要求重启。
// 只读 /proc（Linux），不发送信号、不影响用户运行中的 Codex；探测失败时如实标未验证。
const CLIENT_PROBE_TTL_MS = 5000
const clientProbeCache = new Map()

function readProcStartTicks (pid) {
  const stat = readFileSync('/proc/' + pid + '/stat', 'utf8')
  const close = stat.lastIndexOf(')')
  const parts = stat.slice(close + 2).split(' ')
  const starttime = Number(parts[19])
  return Number.isFinite(starttime) ? starttime : null
}

function readProcBootTimeMs () {
  const stat = readFileSync('/proc/stat', 'utf8')
  const m = /^btime\s+(\d+)/m.exec(stat)
  return m ? Number(m[1]) * 1000 : null
}

export function probeDesktopClient (desktopPath, opts = {}) {
  if (!desktopPath) return { running: null, startedAt: null, pid: null, matches: 0, source: 'desktop_not_found' }
  if (process.platform !== 'linux') return { running: null, startedAt: null, pid: null, matches: 0, source: 'unsupported_platform' }
  const key = 'client:' + desktopPath
  const cached = clientProbeCache.get(key)
  if (cached && Date.now() - cached.at < CLIENT_PROBE_TTL_MS) return cached.value
  let value
  try {
    const target = realpathSync(desktopPath)
    const dir = dirname(target)
    const boot = opts.bootTimeMs !== undefined ? Number(opts.bootTimeMs) : readProcBootTimeMs()
    let earliest = null
    let earliestPid = null
    let matches = 0
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue
      let cmdline = ''
      try { cmdline = readFileSync('/proc/' + name + '/cmdline', 'utf8') } catch { continue }
      const argv0 = cmdline.split('\0')[0]
      // 只认同一可执行文件（含符号链接路径与同目录同名 Electron 子进程）；
      // 旧 dir 前缀匹配会把 /usr/bin 下所有进程误判为 Desktop（2026-11-16 审计 P2）。
      const sameExe = argv0 === target || argv0 === desktopPath ||
        (basename(argv0) === basename(target) && (dirname(argv0) === dir || dirname(argv0) === dirname(desktopPath)))
      if (!argv0 || !sameExe) continue
      matches++
      const ticks = readProcStartTicks(name)
      if (ticks == null || !Number.isFinite(boot)) continue
      // Linux USER_HZ 默认 100；starttime 是自开机起的时钟滴答数。
      const startedAt = boot + Math.round((ticks * 1000) / 100)
      if (earliest == null || startedAt < earliest) { earliest = startedAt; earliestPid = Number(name) }
    }
    value = { running: matches > 0, startedAt: earliest, pid: earliestPid, matches, source: 'proc' }
  } catch {
    value = { running: null, startedAt: null, pid: null, matches: 0, source: 'proc_unavailable' }
  }
  clientProbeCache.set(key, { at: Date.now(), value })
  return value
}

export function computeRestartState (opts = {}) {
  const mode = MODES.includes(opts.mode) ? opts.mode : 'official'
  const exiting = opts.lastAction === 'deactivate' || opts.action === 'deactivate' || !!opts.exitedAt
  const appliedAt = Number.isFinite(Number(opts.appliedAt)) && Number(opts.appliedAt) > 0 ? Number(opts.appliedAt) : null
  const client = opts.client && typeof opts.client === 'object' ? opts.client : { running: null, startedAt: null, source: 'unknown' }
  const base = { client, appliedAt, evidenceAt: Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now(), mode, exiting }
  // route 与 aggregated 都需要重启；退出到 official 也必须重启（写 exitedAt / lastAction）。
  if (mode !== 'route' && mode !== 'aggregated' && !exiting) {
    return Object.assign({ needed: false, reason: 'not_aggregated' }, base)
  }
  if (exiting && mode === 'official') {
    return Object.assign({ needed: true, reason: 'exited_to_official' }, base)
  }
  if (!appliedAt) return Object.assign({ needed: true, reason: 'applied_at_unknown' }, base)
  if (client.running === true && Number.isFinite(Number(client.startedAt))) {
    if (Number(client.startedAt) >= appliedAt) return Object.assign({ needed: false, reason: 'client_restarted_after_apply' }, base)
    return Object.assign({ needed: true, reason: 'client_running_with_old_config' }, base)
  }
  if (client.running === false) return Object.assign({ needed: true, reason: 'client_not_running' }, base)
  return Object.assign({ needed: true, reason: 'client_restart_unverified' }, base)
}

function resolveDesktopForProbe (opts) {
  const envPath = String(opts.desktopPath || process.env.MG_DESKTOP_EXECUTABLE || '').trim()
  return existingPath(envPath ? [envPath, ...DESKTOP_CANDIDATES] : DESKTOP_CANDIDATES)
}

function resolveClientRuntime (opts, desktopInfo) {
  if (opts.clientProbe === false) return { running: null, startedAt: null, pid: null, matches: 0, source: 'disabled' }
  if (typeof opts.clientProbe === 'function') {
    try { return Object.assign({ source: 'injected' }, opts.clientProbe(desktopInfo || null) || {}) } catch { return { running: null, startedAt: null, pid: null, matches: 0, source: 'probe_failed' } }
  }
  const desktopPath = (desktopInfo && desktopInfo.found && desktopInfo.path) || null
  if (!desktopPath) return { running: null, startedAt: null, pid: null, matches: 0, source: 'desktop_not_found' }
  return probeDesktopClient(desktopPath, opts)
}

// —— 探测：CLI / Desktop / 配置 / 备份 ——
const CLI_CANDIDATES = ['~/.local/bin/codex', '/usr/local/bin/codex', '/usr/bin/codex', '/opt/homebrew/bin/codex']
// Linux 包布局：/usr/lib/chatgpt/ChatGPT（Electron 主体）优先于 /usr/bin/chatgpt（launcher 脚本），
// 因为版本元数据与捆绑 Codex CLI 都在 resources/ 下；只查存在性，绝不执行 Desktop 本体。
const DESKTOP_CANDIDATES = ['/usr/lib/chatgpt/ChatGPT', '/usr/bin/chatgpt', '/opt/ChatGPT/ChatGPT', '/usr/lib/chatgpt/codex-launcher', '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT']

// Desktop 安装内随包分发的 Codex CLI：只从已确认的 Desktop 目录推导，不接受任意路径。
function bundledCodexCandidates (desktopPath) {
  const dir = dirname(desktopPath)
  return [
    join(dir, 'resources', 'codex'),
    join(dir, 'resources', 'codex', 'codex'),
    join(dir, 'codex'),
    join(dir, '..', 'resources', 'codex'),
  ]
}

function expandHome (p) {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

function existingPath (candidates) {
  for (const raw of candidates) {
    if (!raw) continue
    const p = expandHome(String(raw))
    try {
      if (existsSync(p)) {
        let real = p
        try { real = realpathSync(p) } catch {}
        return { found: true, path: real, requested: p }
      }
    } catch {}
  }
  return { found: false, path: null, requested: null }
}

function probeCliVersion (binPath) {
  const cached = versionCache.get('cli:' + binPath)
  if (cached && Date.now() - cached.at < VERSION_TTL_MS) return cached.value
  let value
  try {
    const out = execFileSync(binPath, ['--version'], {
      timeout: 1500,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: process.env.HOME || '' },
    })
    const m = /(\d+(?:\.\d+){2,3}(?:[-+][0-9A-Za-z.-]+)?)/.exec(String(out || ''))
    value = m ? { version: m[1], source: 'codex --version' } : { version: null, source: 'unparsed' }
  } catch {
    value = { version: null, source: 'probe_failed' }
  }
  versionCache.set('cli:' + binPath, { at: Date.now(), value })
  return value
}

const VERSION_TTL_MS = 5 * 60 * 1000
const versionCache = new Map()

// Desktop 二进制不执行（会拉起 GUI）：只从同目录的版本文件/包元数据读取，读不到就 unknown。
// Linux 安装的版本在 resources/linux-package-metadata.json（纯文件读取，不需要也不允许执行 GUI）。
const DESKTOP_VERSION_FILES = ['version', 'VERSION']
const DESKTOP_VERSION_METADATA = [
  ['resources', 'linux-package-metadata.json'],
  ['resources', 'app', 'package.json'],
  ['..', 'resources', 'app', 'package.json'],
]

function readDesktopVersionFile (candidate) {
  if (!existsSync(candidate)) return null
  const text = readFileSync(candidate, 'utf8')
  if (candidate.endsWith('.json')) {
    try {
      const parsed = JSON.parse(text)
      const version = parsed && (parsed.version || parsed.appVersion)
      if (version) return { version: String(version), buildFlavor: parsed.codexBuildFlavor || parsed.buildFlavor || null }
    } catch { /* 非法 JSON 视为没有版本，继续找下一个来源 */ }
    return null
  }
  const m = /^\s*v?(\d+(?:\.\d+){2,3}(?:[-+][0-9A-Za-z.-]+)?)/m.exec(text)
  return m ? { version: m[1], buildFlavor: null } : null
}

function probeDesktopVersion (binPath) {
  const cached = versionCache.get('desktop:' + binPath)
  if (cached && Date.now() - cached.at < VERSION_TTL_MS) return cached.value
  const dir = dirname(binPath)
  let runtime = null
  let product = null
  for (const name of DESKTOP_VERSION_FILES) {
    try {
      const found = readDesktopVersionFile(join(dir, name))
      if (found) { runtime = { version: found.version, source: basename(name) }; break }
    } catch { /* 单个来源不可读不阻断其它来源 */ }
  }
  // Linux 包元数据是产品版本（如 26.1103.32239）；目录下 version 通常是运行时版本，两者都保留以便复核。
  for (const parts of DESKTOP_VERSION_METADATA) {
    try {
      const candidate = join(dir, ...parts)
      const found = readDesktopVersionFile(candidate)
      if (found) { product = { version: found.version, source: basename(candidate), buildFlavor: found.buildFlavor }; break }
    } catch { /* 单个来源不可读不阻断其它来源 */ }
  }
  const value = {
    version: product ? product.version : (runtime ? runtime.version : null),
    source: product ? product.source : (runtime ? runtime.source : 'not_read'),
    versionKind: product ? 'package-metadata' : (runtime ? 'version-file' : null),
    buildFlavor: product ? product.buildFlavor : null,
    runtimeVersion: runtime ? runtime.version : null,
    runtimeVersionSource: runtime ? runtime.source : null,
  }
  versionCache.set('desktop:' + binPath, { at: Date.now(), value })
  return value
}

function backupSummary (paths, state, current) {
  if (!state || !state.backupPath) return { available: false, path: null, sha256: null, matches: false }
  let exists = false
  let sha = null
  try {
    const bytes = readFileSync(state.backupPath)
    exists = true
    sha = sha256Hex(bytes)
  } catch { exists = false }
  return {
    available: exists,
    path: exists ? state.backupPath : null,
    sha256: sha,
    matches: !!(exists && state.beforeSha && sha === state.beforeSha),
    baseExistsHint: current ? current.exists : null,
  }
}

export function detect (opts = {}) {
  const paths = resolveDesktopPaths(opts)
  const gatewayBaseUrl = String(opts.baseUrl || process.env.MG_DESKTOP_GATEWAY || DEFAULT_GATEWAY_BASE_URL).replace(/\/+$/, '')
  let current = null
  try { current = snapshotConfigFile(paths.configPath) } catch { current = null }
  const state = loadState(paths)
  const classification = classifyConfigState({ configPath: paths.configPath, baseUrl: gatewayBaseUrl })
  const lock = readLock(paths.lockPath, Date.now())

  const cliEnvPath = String(opts.cliPath || process.env.MG_CODEX_CLI || '').trim()
  const cli = existingPath(cliEnvPath ? [cliEnvPath, ...CLI_CANDIDATES] : CLI_CANDIDATES)
  let cliInfo = { found: cli.found, path: cli.path, version: null, versionState: cli.found ? 'unknown' : 'not_found', source: null }
  if (cli.found) {
    if (opts.disableExec === true) {
      cliInfo.source = 'exec_disabled'
    } else {
      const probed = probeCliVersion(cli.path)
      cliInfo = Object.assign(cliInfo, { version: probed.version, versionState: probed.version ? 'known' : 'unknown', source: probed.source })
    }
  }

  const desktopEnvPath = String(opts.desktopPath || process.env.MG_DESKTOP_EXECUTABLE || '').trim()
  const desktop = existingPath(desktopEnvPath ? [desktopEnvPath, ...DESKTOP_CANDIDATES] : DESKTOP_CANDIDATES)
  let desktopInfo = { found: desktop.found, path: desktop.path, version: null, versionState: desktop.found ? 'unknown' : 'not_found', source: null, buildFlavor: null, bundledCodex: { found: false, path: null, version: null, versionState: 'desktop_not_found', source: null } }
  if (desktop.found) {
    // 读取版本文件/包元数据不是执行 Desktop：即使 disableExec 也允许读取（只读、不拉起 GUI）。
    const probed = probeDesktopVersion(desktop.path)
    desktopInfo = Object.assign(desktopInfo, {
      version: probed.version,
      versionState: probed.version ? 'known' : 'unknown',
      source: probed.source,
      versionKind: probed.versionKind || null,
      buildFlavor: probed.buildFlavor || null,
      runtimeVersion: probed.runtimeVersion || null,
      runtimeVersionSource: probed.runtimeVersionSource || null,
    })

    // Desktop 随包分发的 Codex CLI：优先于 PATH 里的独立 CLI 作为"原版客户端引擎"证据。
    const bundled = existingPath(bundledCodexCandidates(desktop.path))
    let bundledInfo = { found: bundled.found, path: bundled.path, version: null, versionState: bundled.found ? 'not_probed' : 'not_found', source: null }
    if (bundled.found) {
      // 捆绑 Codex CLI 来自已验证的 Desktop 安装目录，--version 不会拉起 GUI 也不写配置；
      // 与 PATH 里来源不明的 CLI 不同，因此 disableExec 不阻止它，只有显式 false 才关闭。
      if (opts.probeBundledCodex === false) {
        bundledInfo.source = 'disabled'
      } else if (typeof opts.probeBundledCodex === 'function') {
        const probedBundled = opts.probeBundledCodex(bundled.path) || {}
        bundledInfo = Object.assign(bundledInfo, { version: probedBundled.version || null, versionState: probedBundled.version ? 'known' : 'unknown', source: probedBundled.source || 'injected' })
      } else {
        const probedBundled = probeCliVersion(bundled.path)
        bundledInfo = Object.assign(bundledInfo, { version: probedBundled.version, versionState: probedBundled.version ? 'known' : 'unknown', source: probedBundled.source })
      }
    }
    desktopInfo.bundledCodex = bundledInfo
  }

  const appliedAt = state && (state.mode === 'aggregated' || state.mode === 'route') && Number(state.appliedAt) > 0 ? Number(state.appliedAt) : null
  const clientRuntime = resolveClientRuntime(opts, desktopInfo)
  const restart = computeRestartState({ mode: classification.mode, appliedAt, client: clientRuntime })
  const nativeCompaction = nativeCompactionSummary(opts, classification)
  return {
    contract: DESKTOP_CONTRACT,
    ok: true,
    codexHome: paths.codexHome,
    configPath: paths.configPath,
    gateway: { baseUrl: gatewayBaseUrl, loopback: isLoopbackUrl(gatewayBaseUrl) },
    config: Object.assign({}, classification, {
      exists: !!(current && current.exists),
      size: current ? current.size : 0,
      mtimeMs: current ? current.mtimeMs : 0,
      fileMode: current ? current.mode : 0,
    }),
    cli: cliInfo,
    desktop: desktopInfo,
    // 面向"原版 Desktop 用户路径"的单一探测摘要：优先使用 Desktop 随包 CLI 作为客户端引擎证据。
    bundledCli: desktopInfo.bundledCodex,
    client: {
      kind: desktopInfo.found ? 'desktop' : (cliInfo.found ? 'cli' : 'unknown'),
      desktopPath: desktopInfo.path,
      desktopVersion: desktopInfo.version,
      desktopVersionSource: desktopInfo.source,
      desktopVersionKind: desktopInfo.versionKind || null,
      desktopRuntimeVersion: desktopInfo.runtimeVersion || null,
      desktopBuildFlavor: desktopInfo.buildFlavor || null,
      bundledCodexPath: desktopInfo.bundledCodex.path,
      bundledCodexVersion: desktopInfo.bundledCodex.version,
      cliPath: cliInfo.path,
      cliVersion: cliInfo.version,
      // 明确区分"文件元数据"与"执行 --version"两种版本来源，证据可按来源复核。
      versionEvidence: {
        desktop: desktopInfo.version ? { source: desktopInfo.source, executed: false } : null,
        bundledCodex: desktopInfo.bundledCodex.version ? { source: desktopInfo.bundledCodex.source, executed: desktopInfo.bundledCodex.source !== 'exec_disabled' } : null,
        cli: cliInfo.version ? { source: cliInfo.source, executed: true } : null,
      },
    },
    state: state
      ? { mode: state.mode, appliedAt: state.appliedAt || null, appliedSha: state.appliedSha || null, lastApply: state.lastApply || null, previous: state.previous || null }
      : null,
    backup: backupSummary(paths, state, current),
    lock: { present: lock.present, stale: !!lock.stale },
    journal: journalPhase(paths) ? { present: true } : { present: false },
    clientRuntime,
    restart,
    nativeCompaction,
    needsRestart: restart.needed,
  }
}

// —— 预览 ——
function renderTomlValue (value) {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  throw new DesktopError('unsupported_value', '不支持的配置值类型：' + typeof value, null, 422)
}

// 同意令牌绑定模式与父子目标：fromMode/toMode/parentModel/childModel/providerMode 任一变化即失配（428）。
function consentModeBinding (binding = {}) {
  return [
    'from=' + String(binding.fromMode || ''),
    'to=' + String(binding.toMode || ''),
    'parent=' + String(binding.parentModel || ''),
    'child=' + String(binding.childModel || ''),
    'provider=' + String(binding.providerMode || ''),
  ].join('|')
}

function consentTokenFor (target, beforeSha, afterSha, binding) {
  return sha256Hex(DESKTOP_CONTRACT + '\n' + target + '\n' + consentModeBinding(binding) + '\n' + beforeSha + '\n' + afterSha)
}

// MG-FIX-P1-05：同意令牌同时绑定 config.toml 与子代理文件的 before/after 字节，
// 保证"同意覆盖写什么"在 UI 与事务两侧完全一致（任一变化都会令令牌失配）。
function agentConsentToken (target, beforeSha, afterSha, childPlan, binding) {
  return sha256Hex(DESKTOP_CONTRACT + '\n' + target + '\n' + consentModeBinding(binding) + '\n' + beforeSha + '\n' + afterSha +
    '\n' + MANAGED_AGENT_FILE + '\n' + (childPlan ? childPlan.before.sha256 + '\n' + childPlan.after.sha256 : ''))
}

// 模式参数统一解析：preview 与 activate 共用，保证"看到什么就写什么"。
// 未指定 mode 的旧调用方沿用 opts.model（父子相同）；显式 route 父子同别名；
// 显式 aggregated 父为可选 GPT（默认 luna）、子为 deepseek 别名。
function resolveModeParams (opts = {}) {
  const explicitMode = AGGREGATION_MODES.includes(opts.mode)
  const toMode = explicitMode ? opts.mode : 'aggregated'
  const target = resolveModeTarget({ mode: toMode, parentModel: opts.parentModel || opts.model })
  const model = toMode === 'route' ? ROUTE_MODEL : (opts.model || target.model)
  const childModel = toMode === 'route' ? ROUTE_MODEL
    : (opts.agentModel || (explicitMode && toMode === 'aggregated' ? DEEPSEEK_CHILD_MODEL : opts.model))
  const provider = toMode === 'route' ? (opts.managedProvider || {}) : opts.managedProvider
  return { explicitMode, toMode, target, model, childModel, provider }
}

// preview 与 activate 共用的文本合并：模式切换时走 planModeTransition，
// 保证预览看到的 afterSha / consentToken 与实际写入完全一致。
function computeModeMerge (paths, beforeText, desired, toMode) {
  const transitionState = loadState(paths)
  if (transitionState && transitionState.desired && AGGREGATION_MODES.includes(transitionState.mode) &&
      transitionState.mode !== 'official' && transitionState.mode !== toMode) {
    let baseText = ''
    if (transitionState.before && transitionState.before.exists && transitionState.backupPath) {
      try { baseText = readFileSync(transitionState.backupPath, 'utf8') } catch { baseText = '' }
    }
    const planned = planModeTransition({
      baseText,
      currentText: beforeText,
      baseExists: !!(transitionState.before && transitionState.before.exists),
      fromDesired: transitionState.desired,
      toDesired: desired,
    })
    if (!planned.ok) {
      throw new DesktopError('mode_transition_conflict', '模式切换与当前配置冲突，未做任何写入。', { conflicts: planned.conflicts }, 409)
    }
    return {
      text: planned.text,
      changed: diffConfigText(beforeText, planned.text),
      warnings: [],
      preserved: summarizePreserved(beforeText),
      createdSections: [],
      transitionState,
    }
  }
  const merged = mergeOwnedFields(beforeText, desired)
  return Object.assign({}, merged, { transitionState })
}

// 从调用参数推导本次切换的模式绑定；未指定 mode 时按历史聚合路径处理，保持旧调用方语义。
function consentBindingFromOpts (opts, fromMode) {
  const toMode = AGGREGATION_MODES.includes(opts && opts.mode) ? opts.mode : 'aggregated'
  const target = resolveModeTarget({ mode: toMode, parentModel: opts && opts.parentModel })
  return {
    fromMode: fromMode || 'official',
    toMode,
    parentModel: target.parentModel,
    childModel: String((opts && opts.agentModel) || '').trim() || target.childModel || '',
    providerMode: target.providerMode,
  }
}

// Managed Provider 段现在走"回环信任、无客户端 Key"（requires_openai_auth=false），
// 不再依赖 ChatGPT 登录复用。裸传 managedProvider 而没有显式 mode 仍要求实验开关，
// 防止旧调用方在不知情下切换 provider 身份；显式的 mode=route/aggregated 请求直接放行。
function managedProviderGuard (opts) {
  if (opts.managedProvider === undefined || opts.managedProvider === null) return null
  if (opts.experimentalManagedProvider === true) return null
  if (opts.mode === 'route' || opts.mode === 'aggregated') return null
  return {
    code: 'managed_provider_unverified',
    message: '裸传 managedProvider 但没有显式 mode；为防误切换 Codex provider 身份，' +
      '请显式传入 mode="route"（路由模式）或 experimentalManagedProvider=true。' +
      '确认后使用回环信任（requires_openai_auth=false），不写 env_key / token。',
    evidence: {
      capabilityField: 'model_providers.' + MANAGED_PROVIDER_ID + '.capabilities.remote_compaction',
      literals: REMOTE_COMPACTION_LITERALS.slice(),
      requiresOpenAiAuth: false,
      configParse: 'PASS_MOCK (codex-cli 0.167.0-alpha.3.2 serde validation)',
      runtimeAuth: 'LOOPBACK_TRUST',
    },
  }
}

function buildDesired (opts) {
  try {
    const built = buildDesiredCodexConfig({
      openaiBaseUrl: opts.baseUrl,
      model: opts.model,
      modelCatalogJsonPath: opts.catalogPath,
      features: opts.features,
      managedProvider: opts.managedProvider,
    })
    // MG-FIX-P1-05：普通用户接入即托管原生 [features].multi_agent 与 [agents.go_deepseek]，
    // 不需要手工编辑 TOML。仅当显式 managedAgent:false 时关闭（用于诊断/回退）。
    return withManagedAgentDesired(built.desired, {
      model: opts.model,
      agentModel: opts.agentModel,
      managedAgent: opts.managedAgent,
      agentReasoningEffort: opts.agentReasoningEffort,
    })
  } catch (e) {
    throw asDesktopError(e, 'invalid_desired')
  }
}

// 只读审计：当前配置里 ModelGate provider 段是否声明了原生压缩能力。
export function readNativeCompactionBinding (text, opts = {}) {
  const providerId = String(opts.providerId || MANAGED_PROVIDER_ID)
  const providerSectionName = 'model_providers.' + providerId
  const capsSectionName = providerSectionName + '.capabilities'
  const doc = parseConfigDocument(String(text == null ? '' : text))
  const providerSection = doc.sections.find((sec) => sec.name === providerSectionName && !sec.isArray)
  const capability = doc.meta.find((m) => m.kind === 'entry' && m.sectionName === capsSectionName && m.key === 'remote_compaction')
  const requiresAuth = doc.meta.find((m) => m.kind === 'entry' && m.sectionName === providerSectionName && m.key === 'requires_openai_auth')
  const remote = capability ? String(capability.value).trim().replace(/^"|"$/g, '') : null
  return {
    providerId,
    providerDeclared: !!providerSection,
    providerSection: providerSection ? providerSectionName : null,
    requiresOpenAiAuth: requiresAuth ? /^true$/i.test(String(requiresAuth.value).trim()) : null,
    remoteCompaction: remote,
    declarable: providerSection ? true : false,
  }
}

function nativeCompactionSummary (opts, classification) {
  let binding = { providerId: MANAGED_PROVIDER_ID, providerDeclared: false, remoteCompaction: null, requiresOpenAiAuth: null }
  let configText = ''
  try {
    const paths = resolveDesktopPaths(opts)
    if (classification.mode !== 'official') configText = readFileSync(paths.configPath, 'utf8')
  } catch { configText = '' }
  try { binding = readNativeCompactionBinding(configText, { providerId: (opts.managedProvider && opts.managedProvider.id) || MANAGED_PROVIDER_ID }) } catch { /* 配置不可解析时按未声明处理 */ }
  if (binding.providerDeclared || opts.managedProvider != null) {
    return {
      mode: 'managed-provider',
      providerId: binding.providerId,
      declarable: true,
      declared: binding.remoteCompaction === 'unsupported' || binding.remoteCompaction === 'v2',
      remoteCompaction: binding.remoteCompaction,
      requiresOpenAiAuth: binding.requiresOpenAiAuth,
      field: 'model_providers.' + binding.providerId + '.capabilities.remote_compaction',
      literals: REMOTE_COMPACTION_LITERALS.slice(),
      evidence: 'codex-cli 0.167.0-alpha.3.2 config serde validation (offline)',
      runtimeAuth: 'UNVERIFIED',
      note: '让 Codex 对 Go DeepSeek 走它自己的本地自动压缩；退出聚合时随自有段一并撤销。',
    }
  }
  return {
    mode: 'builtin-openai',
    providerId: 'openai',
    declarable: false,
    declared: false,
    reason: 'reserved_builtin_provider',
    detail: 'Codex 拒绝任何 [model_providers.openai*] 覆盖（reserved built-in provider ID）；内置身份无法声明 provider capability。',
    evidence: 'codex-cli 0.167.0-alpha.3.2: model_providers contains reserved built-in provider IDs: openai',
    runtimeAuth: 'NOT_APPLICABLE',
  }
}

function ownedRows (existing, desired, opts = {}) {
  const rows = []
  for (const [key, value] of Object.entries(desired.topLevel || {})) {
    const entry = existing.topLevel[key] || { present: false, raw: '' }
    const to = renderTomlValue(value)
    rows.push({
      path: key,
      owner: 'modelgate',
      kind: !entry.present ? 'add' : (entry.raw === to ? 'same' : 'replace'),
      from: entry.present ? entry.raw : null,
      to,
    })
  }
  for (const [name, keys] of Object.entries(desired.sections || {})) {
    for (const [key, value] of Object.entries(keys)) {
      const entry = (existing.sections[name] && existing.sections[name].keys[key]) || { present: false, raw: '' }
      const to = renderTomlValue(value)
      rows.push({
        path: name + '.' + key,
        owner: 'modelgate',
        kind: !entry.present ? 'add' : (entry.raw === to ? 'same' : 'replace'),
        from: entry.present ? entry.raw : null,
        to,
      })
    }
  }
  // 模式切换需要展示"哪些自有字段会被删除"；默认不开启，避免改变既有预览的行数语义。
  if (opts.includeRemovals === true) {
    for (const key of OWNED_TOP_LEVEL) {
      if (desired.topLevel && Object.prototype.hasOwnProperty.call(desired.topLevel, key)) continue
      const entry = existing.topLevel[key]
      if (entry && entry.present) rows.push({ path: key, owner: 'modelgate', kind: 'remove', from: entry.raw, to: null })
    }
    for (const [name, keys] of Object.entries(OWNED_SECTIONS)) {
      const want = (desired.sections && desired.sections[name]) || {}
      const section = existing.sections && existing.sections[name]
      if (!section) continue
      for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(want, key)) continue
        const entry = section.keys[key]
        if (entry && entry.present) rows.push({ path: name + '.' + key, owner: 'modelgate', kind: 'remove', from: entry.raw, to: null })
      }
    }
  }
  return rows
}

// 两模式之间的一事务文本计划：先把旧的 owned 字段按基线恢复，再合并新的 owned 字段。
// 未管理行逐字节保留（由 buildOwnedRestore / mergeOwnedFields 的 unmanagedFingerprint 自证）。
export function planModeTransition (opts = {}) {
  const baseText = String(opts.baseText == null ? '' : opts.baseText)
  const currentText = String(opts.currentText == null ? '' : opts.currentText)
  const baseExists = opts.baseExists === true
  const fromDesired = opts.fromDesired || {}
  const toDesired = opts.toDesired || {}
  const fromEmpty = !(fromDesired.topLevel && Object.keys(fromDesired.topLevel).length) &&
    !(fromDesired.sections && Object.keys(fromDesired.sections).length)
  // 从 official（无自有字段）进入时无需先恢复，直接在当前字节上合并目标字段。
  const restore = fromEmpty
    ? { ok: true, text: currentText, changed: false, changedKeys: [], removeFile: false, conflicts: [] }
    : buildOwnedRestore({ baseText, currentText, baseExists, desired: fromDesired })
  if (!restore.ok) {
    return { ok: false, text: null, rows: [], restore, conflicts: restore.conflicts }
  }
  let merged
  try {
    merged = mergeOwnedFields(restore.text, toDesired)
  } catch (e) {
    return {
      ok: false, text: null, rows: [], restore,
      conflicts: [{ path: '$config', reason: e && e.code ? e.code : 'merge_failed', message: e && e.message ? e.message : null }],
    }
  }
  const existing = readOwnedFields(currentText)
  const rows = ownedRows(existing, toDesired, { includeRemovals: true })
  const conflicts = []
  if (unmanagedFingerprint(currentText) !== unmanagedFingerprint(merged.text)) {
    conflicts.push({ path: '$config', reason: 'unmanaged_lines_would_change' })
  }
  if (conflicts.length) return { ok: false, text: null, rows, restore, conflicts }
  return { ok: true, text: merged.text, rows, restore, conflicts: [] }
}

function catalogSummary (catalogPath, model, opts = {}) {
  const path = String(catalogPath || '').trim()
  if (!path) return { ok: false, state: 'missing_path', path: null, bytes: 0, modelCount: 0, targetPresent: false, reason: '未提供 model_catalog_json 路径' }
  let st = null
  try { st = statSync(path) } catch { return { ok: false, state: 'missing_file', path, bytes: 0, modelCount: 0, targetPresent: false, reason: '目录文件不存在' } }
  if (!st.isFile()) return { ok: false, state: 'not_a_file', path, bytes: 0, modelCount: 0, targetPresent: false, reason: '目录路径不是普通文件' }
  if (st.size > MAX_CATALOG_BYTES) return { ok: false, state: 'overflow', path, bytes: st.size, modelCount: 0, targetPresent: false, reason: '目录超过 ' + MAX_CATALOG_BYTES + ' 字节上限' }
  let parsed
  try { parsed = JSON.parse(readFileSync(path, 'utf8')) } catch { return { ok: false, state: 'invalid_json', path, bytes: st.size, modelCount: 0, targetPresent: false, reason: '目录不是合法 JSON' } }
  const models = parsed && Array.isArray(parsed.models) ? parsed.models : null
  if (!models) return { ok: false, state: 'invalid_shape', path, bytes: st.size, modelCount: 0, targetPresent: false, reason: '目录缺少 models 数组' }
  const slugs = models.map((m) => (m && (m.slug || m.id || m.model)) || null).filter(Boolean)
  const target = String(model || '').trim()
  const targetPresent = target ? slugs.includes(target) : false
  return {
    ok: models.length > 0 && (opts.requireModelInCatalog === false || targetPresent),
    state: models.length === 0 ? 'empty' : (targetPresent ? 'present' : 'target_missing'),
    path,
    bytes: st.size,
    modelCount: models.length,
    targetPresent,
    reason: models.length === 0 ? '目录为空（客户端会回落到 fallback metadata）' : (targetPresent ? null : '目录中没有目标模型 ' + target),
  }
}

function blockedFromConfigError (error) {
  if (error instanceof ConfigError) return [{ code: error.code, message: error.message }]
  throw error
}

export function preview (opts = {}) {
  const paths = resolveDesktopPaths(opts)
  const gatewayBaseUrl = String(opts.baseUrl || process.env.MG_DESKTOP_GATEWAY || DEFAULT_GATEWAY_BASE_URL).replace(/\/+$/, '')
  const modeParams = resolveModeParams(opts)
  const guard = managedProviderGuard(opts)
  if (guard) {
    let snap = { exists: false, size: 0, sha256: '', mtimeMs: 0 }
    try { snap = snapshotConfigFile(paths.configPath) } catch { /* 保持空快照 */ }
    let mode = 'unknown'
    try { mode = classifyConfigState({ configPath: paths.configPath, baseUrl: gatewayBaseUrl }).mode } catch { /* unknown */ }
    return {
      contract: DESKTOP_CONTRACT,
      ok: false,
      state: 'blocked',
      mode,
      configPath: paths.configPath,
      before: { exists: snap.exists, size: snap.size, sha256: snap.sha256, mtimeMs: snap.mtimeMs },
      expectedSha: snap.exists ? snap.sha256 : '',
      after: { exists: false, size: 0, sha256: '' },
      desired: null,
      rows: [],
      changed: [],
      conflicts: [],
      blocked: [{ code: guard.code, message: guard.message }],
      warnings: [guard.message],
      preserved: null,
      consentRequired: false,
      consentToken: null,
      firstRun: false,
      alreadyAggregated: false,
      catalog: catalogSummary(opts.catalogPath, modeParams.model, opts),
      nativeCompaction: {
        mode: 'managed-provider',
        providerId: (opts.managedProvider && opts.managedProvider.id) || MANAGED_PROVIDER_ID,
        declarable: true,
        declared: false,
        reason: 'experimental_flag_required',
        field: 'model_providers.' + ((opts.managedProvider && opts.managedProvider.id) || MANAGED_PROVIDER_ID) + '.capabilities.remote_compaction',
        literals: REMOTE_COMPACTION_LITERALS.slice(),
        runtimeAuth: 'UNVERIFIED',
      },
    }
  }
  const desired = buildDesired({ baseUrl: gatewayBaseUrl, model: modeParams.model, catalogPath: opts.catalogPath, features: opts.features, managedProvider: modeParams.provider, managedAgent: opts.managedAgent, agentModel: modeParams.childModel, agentReasoningEffort: opts.agentReasoningEffort })
  const childPlan = planManagedAgentChild(paths, Object.assign({}, opts, { model: modeParams.childModel }), desired, (loadState(paths) || {}).agentChild || null)
  let before
  let beforeText = ''
  let existing
  let merged
  try {
    before = snapshotConfigFile(paths.configPath)
    beforeText = before.exists ? readFileSync(paths.configPath, 'utf8') : ''
    existing = readOwnedFields(beforeText)
    merged = computeModeMerge(paths, beforeText, desired, modeParams.toMode)
  } catch (error) {
    const blocked = blockedFromConfigError(error)
    const snap = { exists: false, size: 0, sha256: '', mtimeMs: 0 }
    try { Object.assign(snap, snapshotConfigFile(paths.configPath)) } catch {}
    return {
      contract: DESKTOP_CONTRACT,
      ok: false,
      state: 'corrupted',
      mode: 'unknown',
      configPath: paths.configPath,
      before: { exists: snap.exists, size: snap.size, sha256: snap.sha256, mtimeMs: snap.mtimeMs },
      expectedSha: snap.exists ? snap.sha256 : '',
      after: { exists: false, size: 0, sha256: '' },
      desired,
      rows: [],
      changed: [],
      conflicts: blocked.map((b) => ({ path: '$config', reason: b.code, message: b.message })),
      blocked,
      warnings: ['配置文件无法按受控 TOML 子集解析：本产品不会猜写，也不会覆盖。请先人工修复或移走该文件。'],
      preserved: null,
      consentRequired: true,
      consentToken: null,
      firstRun: false,
      alreadyAggregated: false,
      agentChild: childPlan,
      catalog: catalogSummary(opts.catalogPath, modeParams.model, opts),
    }
  }
  const rows = ownedRows(existing, desired, { includeRemovals: true })
  const previewFromMode = classifyConfigState({ configPath: paths.configPath, baseUrl: gatewayBaseUrl }).mode
  const previewToMode = modeParams.toMode
  const afterText = merged.text
  const afterSha = sha256Hex(Buffer.from(afterText, 'utf8'))
  const expectedSha = before.exists ? before.sha256 : ''
  const firstRun = !before.exists || !rows.some((r) => r.kind === 'same')
  const preserved = summarizePreserved(beforeText || '')
  const blocked = []
  const conflicts = []
  const warnings = merged.warnings.slice()
  for (const sec of preserved.reservedOverrides) {
    blocked.push({
      code: 'reserved_provider_override',
      message: '检测到 [' + sec + ']：Codex 把 openai 视为 reserved built-in provider ID，该段会让客户端启动失败。本产品不删改它；请先在 Codex 配置里移除该段，再回到本页接入。',
    })
  }
  for (const row of rows) {
    if (row.kind !== 'replace') continue
    conflicts.push({ path: row.path, from: row.from, to: row.to, reason: 'overwrite' })
  }
  if (!opts.managedProvider && existing.sections && existing.sections['model_providers.' + MANAGED_PROVIDER_ID] && existing.sections['model_providers.' + MANAGED_PROVIDER_ID].present) {
    warnings.push('检测到 [model_providers.' + MANAGED_PROVIDER_ID + ']（早期原型或自定义段）：默认仍使用内置 openai 身份，本次不修改该段；如需 provider 级原生压缩声明（remote_compaction）请显式启用 Managed Provider 模式。')
  }
  const catalog = catalogSummary(opts.catalogPath, modeParams.model, opts)
  if (!String(opts.catalogPath || '').trim()) blocked.push({ code: 'catalog_path_required', message: '必须先由网关生成聚合模型目录（model_catalog_json 绝对路径），否则客户端会回落到不完整目录。' })
  else if (!catalog.ok && catalog.state !== 'missing_file') warnings.push('目录当前不可用（' + catalog.state + '）：' + catalog.reason)
  if (childPlan.conflict) {
    const message = '子代理文件 ' + MANAGED_AGENT_FILE + ' 已存在且不是 ModelGate 写入的规范内容；为不覆盖你的修改，本次不接入。' +
      '请查看三方差异后手工合并或移走该文件，再重新预览。'
    blocked.push({ code: childPlan.conflict.reason, message })
    conflicts.push({ path: MANAGED_AGENT_FILE, reason: childPlan.conflict.reason, message })
    warnings.push(message)
  }
  const consentRequired = blocked.length === 0 && (firstRun || conflicts.length > 0 || childPlan.action === 'create')
  return {
    contract: DESKTOP_CONTRACT,
    ok: blocked.length === 0,
    state: blocked.length ? 'blocked' : (rows.every((r) => r.kind === 'same') ? 'already_aggregated' : 'ready'),
    mode: previewFromMode,
    fromMode: previewFromMode,
    toMode: previewToMode,
    modeTarget: modeParams.target,
    configPath: paths.configPath,
    before: { exists: before.exists, size: before.size, sha256: before.sha256, mtimeMs: before.mtimeMs },
    expectedSha,
    after: { exists: true, size: Buffer.byteLength(afterText, 'utf8'), sha256: afterSha },
    desired,
    rows,
    changed: merged.changed,
    conflicts,
    blocked,
    warnings,
    preserved,
    consentRequired,
    consentToken: blocked.length ? null : agentConsentToken(paths.configPath, expectedSha, afterSha, childPlan,
      consentBindingFromOpts(opts, classifyConfigState({ configPath: paths.configPath, baseUrl: gatewayBaseUrl }).mode)),
    firstRun: !before.exists,
    alreadyAggregated: rows.every((r) => r.kind === 'same'),
    agentChild: {
      path: childPlan.path,
      fileName: MANAGED_AGENT_FILE,
      managed: childPlan.managed,
      before: childPlan.before,
      after: childPlan.after,
      action: childPlan.action,
      conflict: childPlan.conflict,
    },
    catalog,
    nativeCompaction: nativeCompactionSummary(opts, classifyConfigState({ configPath: paths.configPath, baseUrl: gatewayBaseUrl })),
  }
}

// —— 验证 ——
async function defaultGatewayProbe (baseUrl) {
  const startedAt = Date.now()
  try {
    const res = await fetch(String(baseUrl).replace(/\/+$/, '') + '/healthz', { signal: AbortSignal.timeout(2000) })
    return { ok: res.ok, status: res.status, checkedAt: startedAt, ms: Date.now() - startedAt }
  } catch (e) {
    return { ok: false, status: 0, checkedAt: startedAt, ms: Date.now() - startedAt, error: e && e.message ? e.message : 'unreachable' }
  }
}

async function verifyAll (opts, paths, desired, expectedAfterSha) {
  const gatewayBaseUrl = String(opts.baseUrl || DEFAULT_GATEWAY_BASE_URL).replace(/\/+$/, '')
  const verification = { ok: false, config: null, catalog: null, gateway: null, needsRestart: true, verifiedAt: Date.now() }
  // 1) 配置解析校验：owned 字段逐字段相等 + 未管理的行逐字节一致。
  const text = readFileSync(paths.configPath, 'utf8')
  const owned = readOwnedFields(text)
  const mismatches = []
  for (const [key, value] of Object.entries(desired.topLevel || {})) {
    const want = renderTomlValue(value)
    const got = owned.topLevel[key] && owned.topLevel[key].present ? owned.topLevel[key].raw : null
    if (got !== want) mismatches.push({ path: key, expected: want, actual: got })
  }
  for (const [name, keys] of Object.entries(desired.sections || {})) {
    for (const [key, value] of Object.entries(keys)) {
      const want = renderTomlValue(value)
      const entry = owned.sections[name] && owned.sections[name].keys[key]
      const got = entry && entry.present ? entry.raw : null
      if (got !== want) mismatches.push({ path: name + '.' + key, expected: want, actual: got })
    }
  }
  const snap = snapshotConfigFile(paths.configPath)
  if (mismatches.length || snap.sha256 !== expectedAfterSha) {
    verification.config = { ok: false, sha256: snap.sha256, mismatches }
    throw new DesktopError('config_verify_failed', '写入后的 config.toml 未通过字段校验。', { verification }, 502)
  }
  verification.config = { ok: true, sha256: snap.sha256, size: snap.size, owned: Object.keys(desired.topLevel || {}) }

  // 2) 目录校验：存在、可解析、包含目标模型、未超上限。
  const catalog = catalogSummary(opts.catalogPath, opts.effectiveModel || opts.model, opts)
  if (!catalog.ok) {
    verification.catalog = catalog
    const code = catalog.state === 'overflow' ? 'catalog_overflow' : 'catalog_verify_failed'
    throw new DesktopError(code, '聚合目录未通过验证：' + catalog.reason, { catalog }, catalog.state === 'overflow' ? 413 : 502)
  }
  verification.catalog = catalog

  // 3) 网关健康：写盘后必须真实可达，不能"写完就报成功"。
  const probe = typeof opts.verifyGateway === 'function'
    ? await opts.verifyGateway({ baseUrl: gatewayBaseUrl, configPath: paths.configPath })
    : await defaultGatewayProbe(gatewayBaseUrl)
  if (!probe || probe.ok !== true) {
    verification.gateway = probe || { ok: false, status: 0 }
    throw new DesktopError('gateway_unreachable', '网关健康检查未通过：配置已写入但网关不可达，客户端接入不会生效。', { verification }, 502)
  }
  verification.gateway = probe
  verification.ok = true
  return verification
}

// —— 激活 ——
export async function activate (opts = {}) {
  const paths = resolveDesktopPaths(opts)
  const gatewayBaseUrl = String(opts.baseUrl || DEFAULT_GATEWAY_BASE_URL).replace(/\/+$/, '')
  let lock
  try {
    lock = acquireDesktopLock({ configPath: paths.configPath, now: opts.now, staleMs: opts.staleMs })
  } catch (e) {
    throw asDesktopError(e, 'lock_failed')
  }
  try {
    const guard = managedProviderGuard(opts)
    if (guard) throw new DesktopError(guard.code, guard.message, guard.evidence, 422)
    const recovery = recoverInterruptedApply({ configPath: paths.configPath })
    // 模式目标解析：preview 与 activate 共用同一解析，保证"看到什么就写什么"。
    const { toMode, model: effectiveModel, childModel: effectiveChild, provider: effectiveProvider } = resolveModeParams(opts)
    const fromMode = classifyConfigState({ configPath: paths.configPath, baseUrl: gatewayBaseUrl }).mode
    const before = snapshotConfigFile(paths.configPath)
    const beforeText = before.exists ? readFileSync(paths.configPath, 'utf8') : ''
    if (opts.expectedSha !== undefined && opts.expectedSha !== null && String(opts.expectedSha) !== String(before.exists ? before.sha256 : '')) {
      throw new DesktopError('concurrent_modification', '预览后 config.toml 已被修改（sha256 不一致），本次接入已中止，请重新预览。', {
        expected: String(opts.expectedSha), actual: before.exists ? before.sha256 : null,
      }, 409)
    }
    let desired
    try {
      desired = buildDesired({ baseUrl: gatewayBaseUrl, model: effectiveModel, catalogPath: opts.catalogPath, features: opts.features, managedProvider: effectiveProvider, managedAgent: opts.managedAgent, agentModel: effectiveChild, agentReasoningEffort: opts.agentReasoningEffort })
    } catch (e) { throw asDesktopError(e, 'invalid_desired') }
    // MG-FIX-P1-05：用户自行改过 go-deepseek.toml 时在任何写入之前 409，绝不覆盖。
    const childPlan = planManagedAgentChild(paths, Object.assign({}, opts, { model: effectiveChild }), desired, (loadState(paths) || {}).agentChild || null)
    if (childPlan.conflict) {
      const conflict = childPlan.conflict
      throw new DesktopError(conflict.reason,
        '子代理文件 ' + MANAGED_AGENT_FILE + ' 不是 ModelGate 写入的规范内容；为不覆盖你的修改，本次接入已中止，未做任何写入。',
        { path: conflict.path, threeWay: conflict.threeWay || null }, 409)
    }
    let merged
    try {
      merged = computeModeMerge(paths, beforeText, desired, toMode)
    } catch (e) {
      if (e instanceof DesktopError) throw e
      throw asDesktopError(e, 'config_unsupported')
    }
    const transitionState = merged.transitionState
    const preserved = summarizePreserved(beforeText)
    if (preserved.reservedOverrides.length) {
      throw new DesktopError('reserved_provider_override',
        '检测到 [' + preserved.reservedOverrides.join('], [') + ']：reserved built-in provider ID 会让 Codex 启动失败；本产品不删改它，请先手工移除。',
        { sections: preserved.reservedOverrides }, 422)
    }
    const afterText = merged.text
    const afterSha = sha256Hex(Buffer.from(afterText, 'utf8'))
    const noChange = merged.changed.length === 0 && before.exists
    const childNeedsWrite = childPlan.action !== 'same' && childPlan.action !== 'none'
    if (!noChange || childNeedsWrite) {
      const wantToken = agentConsentToken(paths.configPath, before.exists ? before.sha256 : '', afterSha, childPlan,
        consentBindingFromOpts(opts, classifyConfigState({ configPath: paths.configPath, baseUrl: gatewayBaseUrl }).mode))
      if (!opts.consentToken || String(opts.consentToken) !== wantToken) {
        throw new DesktopError('consent_required', '写入前必须显式确认：请先调用预览并把 consentToken 与 expectedSha 一起回传。', {
          expectedSha: before.exists ? before.sha256 : '', afterSha, consentTokenHint: wantToken,
        }, 428)
      }
    }
    const stateBefore = {
      exists: before.exists,
      sha256: before.exists ? before.sha256 : '',
      size: before.size,
      mtimeMs: before.mtimeMs,
    }
    // 回滚基线不可重置（2026-11-16 审计 P1-4）：再次激活（换模型/用户改过 owned 键）时，
    // before/backup 必须继承首次接入前的原始基线，否则退出会"恢复"出仍聚合的配置。
    const previousState = transitionState
    const keepBaseline = !!(previousState && (previousState.mode === 'aggregated' || previousState.mode === 'route') && previousState.before)
    const baselineBefore = keepBaseline ? previousState.before : stateBefore
    const baselineBeforeSha = keepBaseline ? previousState.beforeSha : stateBefore.sha256
    let baselineBackupPath = keepBaseline ? previousState.backupPath || null : null
    // previous 记录紧邻的上一次模式，支撑回滚到 previous；不清空原始 before/backupPath。
    const previousRecord = previousState
      ? { mode: previousState.mode || fromMode, sha: previousState.appliedSha || stateBefore.sha256, desired: previousState.desired || null, backupPath: previousState.backupPath || null }
      : { mode: fromMode, sha: stateBefore.sha256, desired: null, backupPath: null }
    if (keepBaseline && baselineBackupPath && baselineBeforeSha) {
      // 稳定化原始备份：commit 会把 .bak 轮换成 .bak.prev（两代后丢失）。在写入前把与基线
      // sha 一致的原始字节复制到 .bak.baseline，回滚锚点永不随轮转漂移。
      try {
        const orig = readFileSync(baselineBackupPath, 'utf8')
        if (sha256Hex(Buffer.from(orig, 'utf8')) === String(baselineBeforeSha)) {
          const stable = paths.configPath + '.bak.baseline'
          let needWrite = true
          try { needWrite = sha256Hex(Buffer.from(readFileSync(stable, 'utf8'), 'utf8')) !== String(baselineBeforeSha) } catch {}
          if (needWrite) atomicWriteFile(stable, orig, 0o600)
          baselineBackupPath = stable
        }
      } catch { /* 原始备份不可读时保持原记录，回滚仍可按 before 记录诊断 */ }
    }
    if (noChange) {
      const verification = await verifyAll(Object.assign({}, opts, { baseUrl: gatewayBaseUrl, effectiveModel }), paths, desired, afterSha)
      // 幂等：保留第一次接入时记录的 before/backup，绝不用"聚合后的文件"覆盖回滚基线。
      const previous = loadState(paths)
      const keepBaseline = previous && (previous.mode === 'aggregated' || previous.mode === 'route') && previous.before
      const appliedAt = keepBaseline && previous.appliedAt ? Number(previous.appliedAt) : Date.now()
      // 幂等激活也要补齐托管子代理文件（如被删），但不得覆盖既有基线记录。
      let childRecord = previous && previous.agentChild ? previous.agentChild : null
      if (childNeedsWrite) {
        const committedChild = commitManagedAgentChild(childPlan)
        childRecord = agentChildRecord(childPlan, committedChild)
      } else if (!childRecord && childPlan.action === 'same') {
        childRecord = agentChildRecord(childPlan, null, true)
      }
      saveState(paths, {
        mode: toMode,
        before: keepBaseline ? previous.before : stateBefore,
        applied: { sha256: afterSha, size: Buffer.byteLength(afterText, 'utf8') },
        appliedSha: afterSha,
        beforeSha: keepBaseline ? previous.beforeSha : stateBefore.sha256,
        backupPath: keepBaseline ? previous.backupPath || null : null,
        desired,
        agentChild: childRecord,
        previous: previousRecord,
        fromMode,
        toMode,
        parentModel: opts.parentModel || effectiveModel,
        childModel: effectiveChild,
        appliedAt,
        lastApply: { ok: true, idempotent: true, at: Date.now(), verification: summarizeVerification(verification), agentChild: childRecord ? { action: childPlan.action } : null },
      })
      const desktop = resolveDesktopForProbe(opts)
      const clientRuntime = resolveClientRuntime(opts, { found: desktop.found, path: desktop.path })
      const restart = computeRestartState({ mode: toMode, appliedAt, client: clientRuntime })
      return {
        ok: true,
        changed: false,
        idempotent: true,
        sha: afterSha,
        backupPath: keepBaseline ? previous.backupPath || null : null,
        verification,
        recovery,
        mode: toMode,
        agentChild: childRecord ? { action: childPlan.action, path: childPlan.path, managed: true } : null,
        clientRuntime,
        restart,
        needsRestart: restart.needed,
      }
    }
    const fromState = { mode: fromMode, sha: stateBefore.sha256, desired: previousState ? previousState.desired || null : null, backupPath: previousState ? previousState.backupPath || null : null }
    const toState = { mode: toMode, sha: afterSha, model: effectiveModel, childModel: effectiveChild }
    const journalBase = {
      schema: JOURNAL_SCHEMA,
      phase: 'applying',
      at: Date.now(),
      pid: process.pid,
      before: stateBefore,
      applied: { sha256: afterSha, size: Buffer.byteLength(afterText, 'utf8') },
      backupPath: null,
      desired,
      fromMode,
      toMode,
      fromState,
      toState,
      previous: previousRecord,
    }
    writeAtomicJson(paths.journalPath, journalBase, 0o600)
    let committed
    try {
      committed = commitConfigPlan({
        target: paths.configPath,
        before,
        beforeText,
        after: { exists: true, size: Buffer.byteLength(afterText, 'utf8'), sha256: afterSha },
        afterText,
        changed: merged.changed,
        warnings: merged.warnings,
        preserved: merged.preserved,
        createdSections: merged.createdSections,
      })
    } catch (e) {
      // commitConfigPlan 自身在写后校验失败时会尝试恢复；这里统一给出可诊断错误。
      const restored = restoreIfOurs(paths, Object.assign({}, journalBase, { backupPath: null }))
      try { unlinkSync(paths.journalPath) } catch {}
      throw new DesktopError('apply_failed', e && e.message ? e.message : '写入失败', { restored: restored.ok }, 500)
    }
    journalBase.backupPath = committed.backupPath || null
    writeAtomicJson(paths.journalPath, journalBase, 0o600)
    if (typeof opts.hooks?.afterWrite === 'function') await opts.hooks.afterWrite({ configPath: paths.configPath, afterSha })
    let verification
    try {
      verification = await verifyAll(Object.assign({}, opts, { baseUrl: gatewayBaseUrl, effectiveModel }), paths, desired, afterSha)
    } catch (error) {
      const failure = asDesktopError(error, 'verification_failed')
      const restored = restoreIfOurs(paths, journalBase)
      try { unlinkSync(paths.journalPath) } catch {}
      saveState(paths, {
        mode: restored.ok ? fromMode : 'unknown',
        before: stateBefore,
        applied: null,
        appliedSha: null,
        beforeSha: stateBefore.sha256,
        backupPath: journalBase.backupPath,
        desired: null,
        previous: previousRecord,
        fromMode,
        toMode,
        appliedAt: null,
        lastApply: { ok: false, code: failure.code, at: Date.now(), restored: restored.ok, restoredSha: restored.sha || null },
      })
      throw new DesktopError(failure.code, failure.message, Object.assign({}, failure.detail || {}, {
        restored: restored.ok,
        restoredSha: restored.sha || null,
        restoreDetail: restored.detail || null,
      }), failure.status)
    }
    // MG-FIX-P1-05：子代理文件写入纳入同一事务。先记 journal（含子文件计划）再写，
    // 若写子文件失败则把 config.toml 一并回滚到接入前字节，状态如实记失败。
    let childRecord = null
    if (childNeedsWrite) {
      journalBase.agentChild = agentChildRecord(childPlan, null)
      writeAtomicJson(paths.journalPath, journalBase, 0o600)
      try {
        const committedChild = commitManagedAgentChild(childPlan)
        childRecord = agentChildRecord(childPlan, committedChild)
        journalBase.agentChild = childRecord
      } catch (childError) {
        const restored = restoreIfOurs(paths, journalBase)
        try { unlinkSync(paths.journalPath) } catch {}
        const ce = childError instanceof DesktopError ? childError : null
        saveState(paths, {
          mode: restored.ok ? fromMode : 'unknown',
          before: stateBefore,
          applied: null,
          appliedSha: null,
          beforeSha: stateBefore.sha256,
          backupPath: journalBase.backupPath,
          desired: null,
          agentChild: null,
          previous: previousRecord,
          fromMode,
          toMode,
          appliedAt: null,
          lastApply: { ok: false, code: ce ? ce.code : 'agent_child_write_failed', at: Date.now(), restored: restored.ok },
        })
        throw new DesktopError(ce ? ce.code : 'agent_child_write_failed', ce ? ce.message : '写入子代理文件失败',
          Object.assign({}, ce && ce.detail ? ce.detail : {}, { restored: restored.ok }), ce ? ce.status : 500)
      }
    } else if (childPlan.action === 'same') {
      childRecord = agentChildRecord(childPlan, null, true)
    }
    // 先落"已验证"再落状态：两者之间崩溃由 recoverInterruptedApply 补齐，不会重复写盘。
    journalBase.phase = 'verified'
    journalBase.lastApply = { ok: true, idempotent: false, at: Date.now(), verification: summarizeVerification(verification) }
    writeAtomicJson(paths.journalPath, journalBase, 0o600)
    const appliedAt = Date.now()
    saveState(paths, {
      mode: toMode,
      before: baselineBefore,
      applied: { sha256: afterSha, size: Buffer.byteLength(afterText, 'utf8') },
      appliedSha: afterSha,
      beforeSha: baselineBeforeSha,
      backupPath: baselineBackupPath || journalBase.backupPath,
      desired,
      agentChild: childRecord,
      previous: previousRecord,
      fromMode,
      toMode,
      parentModel: opts.parentModel || effectiveModel,
      childModel: effectiveChild,
      appliedAt,
      lastApply: { ok: true, at: appliedAt, verification: summarizeVerification(verification), agentChild: childRecord ? { action: childPlan.action } : null },
    })
    try { unlinkSync(paths.journalPath) } catch {}
    const desktop = resolveDesktopForProbe(opts)
    const clientRuntime = resolveClientRuntime(opts, { found: desktop.found, path: desktop.path })
    const restart = computeRestartState({ mode: toMode, appliedAt, client: clientRuntime })
    return {
      ok: true,
      changed: true,
      idempotent: false,
      sha: afterSha,
      backupPath: baselineBackupPath || journalBase.backupPath,
      verification,
      recovery,
      mode: toMode,
      agentChild: childRecord ? { action: childPlan.action, path: childPlan.path, managed: true } : null,
      clientRuntime,
      restart,
      needsRestart: restart.needed,
    }
  } finally {
    lock.release()
  }
}

function summarizeVerification (v) {
  return {
    ok: v.ok,
    configSha: v.config ? v.config.sha256 : null,
    modelCount: v.catalog ? v.catalog.modelCount : null,
    catalogState: v.catalog ? v.catalog.state : null,
    gatewayStatus: v.gateway ? v.gateway.status : null,
  }
}

// —— 退出聚合（只回滚我们改过的字节）——
function redactDiffRows (rows) {
  return rows.map((row) => {
    const m = /^(\s*)([A-Za-z0-9_.-]+)\s*=\s*([\s\S]*)$/.exec(String(row.text || ''))
    if (m && SENSITIVE_FIELD_RE.test(m[2])) {
      return Object.assign({}, row, { text: m[1] + m[2] + ' = <redacted>', redacted: true })
    }
    return Object.assign({}, row, { redacted: false })
  })
}

export function threeWayDiff (baseText, oursText, theirsText) {
  return {
    contract: DESKTOP_CONTRACT + '/three-way',
    base: { sha256: sha256Hex(String(baseText || '')), size: Buffer.byteLength(String(baseText || ''), 'utf8') },
    ours: { sha256: sha256Hex(String(oursText || '')), size: Buffer.byteLength(String(oursText || ''), 'utf8') },
    theirs: { sha256: sha256Hex(String(theirsText || '')), size: Buffer.byteLength(String(theirsText || ''), 'utf8') },
    oursVsTheirs: redactDiffRows(diffConfigText(oursText, theirsText)).slice(0, 400),
    baseVsTheirs: redactDiffRows(diffConfigText(baseText, theirsText)).slice(0, 400),
    guidance: '保持现状，不覆盖你的修改。确认三方差异后，可先手工合并，再重新预览接入或退出。',
  }
}

// —— 退出聚合：只撤销 ModelGate 拥有的键（V2-01）——
// 场景：接入后用户又改了配置里与 ModelGate 无关的内容（新增 MCP、projects、注释等）。
// 旧实现只要 sha 变化就永久 409；V2 要求"只撤销自有键、保留用户修改"，只有用户改到
// ModelGate 拥有的键时才 409 并给三方差异。纯函数：不读盘、不写盘，便于离线取证。
export function buildOwnedRestore (opts = {}) {
  const baseText = String(opts.baseText == null ? '' : opts.baseText)
  const currentText = String(opts.currentText == null ? '' : opts.currentText)
  const desired = opts.desired || {}
  const projection = { topLevel: {}, sections: {} }
  for (const [key, value] of Object.entries(desired.topLevel || {})) projection.topLevel[key] = renderTomlValue(value)
  for (const [name, keys] of Object.entries(desired.sections || {})) {
    projection.sections[name] = {}
    for (const [key, value] of Object.entries(keys)) projection.sections[name][key] = renderTomlValue(value)
  }
  if (!Object.keys(projection.topLevel).length && !Object.keys(projection.sections).length) {
    return { ok: false, conflicts: [{ path: '$state', reason: 'owned_projection_missing' }], text: null, changed: false, changedKeys: [], removeFile: false }
  }
  const baseExists = opts.baseExists === true
  const baseOwned = readOwnedFields(baseText)
  const currentOwned = readOwnedFields(currentText)
  const baseTop = (key) => baseOwned.topLevel[key] || { present: false, raw: '', multiline: false }
  const baseSectionKey = (name, key) => ((baseOwned.sections[name] && baseOwned.sections[name].keys[key]) || { present: false, raw: '', multiline: false })
  const conflicts = []
  const changedKeys = []
  const judge = (path, cur, base, want) => {
    const isOurs = cur.present && !cur.multiline && cur.raw === want
    const alreadyBase = (!cur.present && !base.present) || (cur.present && base.present && cur.raw === base.raw)
    if (isOurs) { changedKeys.push(path); return }
    if (alreadyBase) return
    conflicts.push({
      path,
      reason: cur.present ? 'owned_key_modified' : 'owned_key_removed',
      expected: want,
      actual: cur.present ? cur.raw : null,
      base: base.present ? base.raw : null,
    })
  }
  for (const [key, want] of Object.entries(projection.topLevel)) judge(key, currentOwned.topLevel[key], baseTop(key), want)
  for (const [name, keys] of Object.entries(projection.sections)) {
    for (const [key, want] of Object.entries(keys)) {
      const cur = (currentOwned.sections[name] && currentOwned.sections[name].keys[key]) || { present: false, raw: '', multiline: false }
      const base = (baseOwned.sections[name] && baseOwned.sections[name].keys[key]) || { present: false, raw: '', multiline: false }
      judge(name + '.' + key, cur, base, want)
    }
  }
  if (conflicts.length) return { ok: false, conflicts, text: null, changed: false, changedKeys: [], removeFile: false }

  const doc = parseConfigDocument(currentText)
  const out = []
  for (const m of doc.meta) {
    // 只处理"我们写入过的键"（projection 覆盖的键）；基线里其它自有键属于用户，原样保留。
    if (m.kind === 'entry' && m.sectionName === '' && Object.prototype.hasOwnProperty.call(projection.topLevel, m.key)) {
      const base = baseTop(m.key)
      if (base.present) out.push(withIndentOf(m.raw, m.key + ' = ' + base.raw))
      continue
    }
    const sectionProjection = projection.sections[m.sectionName]
    if (m.kind === 'entry' && sectionProjection && Object.prototype.hasOwnProperty.call(sectionProjection, m.key)) {
      const base = baseSectionKey(m.sectionName, m.key)
      if (base.present) out.push(withIndentOf(m.raw, m.key + ' = ' + base.raw))
      continue
    }
    out.push(m.raw)
  }
  // 接入前文件不存在时，撤掉自有行后不留前导空行（用户内容从第一行开始）。
  if (!baseExists) { while (out.length && out[0].trim() === '') out.shift() }
  // 接入时由我们新建、且自有键全部撤掉后变空的段（[features] / [model_providers.*]）不留空段头。
  for (let i = 0; i < out.length; i++) {
    const header = /^\s*\[([^\[\]]+)\]\s*$/.exec(out[i])
    if (!header) continue
    const name = header[1].trim()
    if (!Object.prototype.hasOwnProperty.call(projection.sections, name)) continue
    const baseSection = baseOwned.sections[name]
    if (baseSection && baseSection.present) continue
    let j = i + 1
    while (j < out.length && !/^\s*\[\[?[^\[\]]+\]\]?\s*$/.test(out[j])) j++
    if (out.slice(i + 1, j).every((line) => line.trim() === '')) { out.splice(i, j - i); i-- }
  }
  const text = out.join(doc.eol)
  if (unmanagedFingerprint(currentText) !== unmanagedFingerprint(text)) {
    return { ok: false, conflicts: [{ path: '$config', reason: 'unmanaged_lines_would_change' }], text: null, changed: false, changedKeys: [], removeFile: false }
  }
  // 自证：恢复结果里的自有字段必须精确等于接入前基线。
  const afterOwned = readOwnedFields(text)
  const mismatch = []
  for (const key of OWNED_TOP_LEVEL) {
    const base = baseTop(key)
    const got = afterOwned.topLevel[key]
    if (base.present !== got.present || (base.present && base.raw !== got.raw)) mismatch.push(key)
  }
  const sectionNames = new Set([...Object.keys(baseOwned.sections || {}), ...Object.keys(projection.sections)])
  for (const name of sectionNames) {
    const keys = new Set([
      ...Object.keys((baseOwned.sections[name] && baseOwned.sections[name].keys) || {}),
      ...Object.keys(projection.sections[name] || {}),
    ])
    for (const key of keys) {
      const base = baseSectionKey(name, key)
      const got = (afterOwned.sections[name] && afterOwned.sections[name].keys[key]) || { present: false, raw: '' }
      if (base.present !== got.present || (base.present && base.raw !== got.raw)) mismatch.push(name + '.' + key)
    }
  }
  if (mismatch.length) {
    return { ok: false, conflicts: [{ path: '$config', reason: 'owned_restore_verify_failed', fields: mismatch }], text: null, changed: false, changedKeys: [], removeFile: false }
  }
  return { ok: true, text, changed: text !== currentText, changedKeys, removeFile: !baseExists && text.trim() === '', conflicts: [] }
}

function withIndentOf (rawLine, text) {
  const indent = /^[ \t]*/.exec(String(rawLine || ''))[0]
  return indent + text
}

function writeAtomicTextFile (path, text, mode) {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, '.' + basename(path) + '.mg-' + process.pid + '-' + randomBytes(6).toString('hex') + '.tmp')
  let fd = null
  try {
    fd = openSync(tmp, 'wx', mode || 0o600)
    writeSync(fd, Buffer.from(String(text == null ? '' : text), 'utf8'))
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(tmp, path)
  } catch (e) {
    try { if (fd != null) closeSync(fd) } catch {}
    try { unlinkSync(tmp) } catch {}
    throw e
  }
}

// 只撤销自有键的原子写：先留退出前快照，写前再核对一次当前字节，写后自校验，失败即恢复。
function commitOwnedRestore (paths, current, currentText, restore) {
  const target = paths.configPath
  const mode = current.mode || 0o600
  const safetyPath = target + '.bak.pre-owned-restore'
  try {
    writeAtomicTextFile(safetyPath, currentText, 0o600)
  } catch (e) {
    throw new DesktopError('backup_failed', '退出前快照写入失败：' + (e && e.message ? e.message : '未知错误'), null, 500)
  }
  const recheck = snapshotConfigFile(target)
  if (recheck.exists !== current.exists || recheck.sha256 !== current.sha256 || Number(recheck.size) !== Number(current.size)) {
    throw new DesktopError('concurrent_modification', '退出写入前配置又发生变化，已中止且未做任何写入。', { expectedSha: current.sha256, currentSha: recheck.sha256 }, 409)
  }
  try {
    if (restore.removeFile) unlinkSync(target)
    else writeAtomicTextFile(target, restore.text, mode)
  } catch (e) {
    throw new DesktopError('restore_failed', '撤回 ModelGate 自有字段失败：' + (e && e.message ? e.message : '未知错误'), null, 500)
  }
  const after = snapshotConfigFile(target)
  const expectedSha = restore.removeFile ? '' : sha256Hex(Buffer.from(restore.text, 'utf8'))
  if (after.sha256 !== expectedSha) {
    try { writeAtomicTextFile(target, currentText, mode) } catch {}
    throw new DesktopError('restore_verify_failed', '退出后 sha256 校验失败，已尝试恢复退出前快照（' + safetyPath + '）。', { expected: expectedSha, actual: after.sha256 }, 502)
  }
  return { sha: after.sha256, safetyBackupPath: safetyPath, removed: !!restore.removeFile }
}

export async function deactivate (opts = {}) {
  const paths = resolveDesktopPaths(opts)
  let lock
  try {
    lock = acquireDesktopLock({ configPath: paths.configPath, now: opts.now, staleMs: opts.staleMs })
  } catch (e) {
    throw asDesktopError(e, 'lock_failed')
  }
  try {
    const recovery = recoverInterruptedApply({ configPath: paths.configPath })
    const state = loadState(paths)
    if (!state || (state.mode !== 'aggregated' && state.mode !== 'route') || !state.before) {
      throw new DesktopError('not_aggregated', '当前不是由 ModelGate 管理的路由/聚合配置，没有可回滚的备份。', { mode: state ? state.mode : null }, 409)
    }
    if (!state.desired || (typeof state.desired !== 'object')) {
      throw new DesktopError('state_incomplete', '接入状态缺少 ModelGate 写入的字段记录，无法只撤销自有键；未做任何写入。', { mode: state.mode }, 409)
    }
    const current = snapshotConfigFile(paths.configPath)
    const currentSha = current.exists ? current.sha256 : ''
    const currentText = current.exists ? readFileSync(paths.configPath, 'utf8') : ''
    // 备份损坏且已对账时不再 409：退化为"只撤销自有键"，基线视为空（用户其它行仍逐字节保留）。
    let baseText = ''
    if (state.before.exists) {
      try { baseText = readBackupText(state, paths) } catch (e) {
        if (!(state.reconciled && state.reconciled.reason === 'backup_sha_mismatch')) throw e
      }
    }
    let oursText = baseText
    try { oursText = mergeOwnedFields(baseText, state.desired).text } catch { oursText = null }
    const conflictDetail = (extra) => {
      const theirsText = current.exists ? readFileSync(paths.configPath, 'utf8') : ''
      return Object.assign({
        threeWay: threeWayDiff(baseText, oursText == null ? theirsText : oursText, theirsText),
        appliedSha: state.appliedSha || null,
        currentSha: currentSha || null,
      }, extra || {})
    }
    // 退出策略（V2-01）：
    //  1) 当前字节 == 我们写入的字节 → 逐字节恢复接入前备份（可证明、无需解释）。
    //  2) 当前字节被改过，但 ModelGate 拥有的字段仍等于我们写入的值 → 只撤销自有键，
    //     用户后来新增/修改的其它配置逐字节保留，不再因为无关编辑而永久卡在 409。
    //  3) 用户改过/删除自有键 → 409 + 三方差异，绝不覆盖。
    const stateApplied = String(state.appliedSha || '')
    const restoreViaOwnedOnly = !!(state.reconciled && state.reconciled.reason === 'backup_sha_mismatch')
    const fullRestore = current.exists && currentSha === stateApplied && !restoreViaOwnedOnly
    // MG-FIX-P1-05：子代理文件的冲突/备份问题必须在任何 config.toml 写入之前判定，
    // 保证"用户改过 go-deepseek.toml → 409 且零写入"。
    const childRestore = planManagedAgentChildRestore(paths, state)
    if (childRestore.conflict) {
      throw new DesktopError('agent_child_modified',
        '子代理文件 ' + MANAGED_AGENT_FILE + ' 在接入后被修改；为不覆盖你的改动，退出已中止，未做任何写入。',
        { path: childRestore.path, threeWay: childRestore.conflict.threeWay, configThreeWay: conflictDetail().threeWay }, 409)
    }
    if (childRestore.error) {
      throw new DesktopError(childRestore.error.code, childRestore.error.message, null, 409)
    }
    if (fullRestore) {
      let result
      if (!state.before.exists) {
        try { unlinkSync(paths.configPath) } catch (e) {
          throw new DesktopError('restore_failed', '删除接入时新建的 config.toml 失败：' + (e && e.message ? e.message : '未知错误'), null, 500)
        }
        result = { sha: '', restoredFrom: null, removed: true }
      } else {
        if (!state.backupPath || !existsSync(state.backupPath)) {
          throw new DesktopError('backup_missing', '备份文件不存在，无法无损回滚；为安全起见未做任何写入。', { backupPath: state.backupPath || null }, 409)
        }
        const backupSha = sha256Hex(readFileSync(state.backupPath))
        if (state.beforeSha && backupSha !== state.beforeSha) {
          throw new DesktopError('backup_mismatch', '备份内容与接入前快照不一致（备份被替换或损坏），未做任何写入。', { expected: state.beforeSha, actual: backupSha }, 409)
        }
        const plan = planRollback({ path: paths.configPath, backupPath: state.backupPath })
        const committed = commitConfigRollback(plan)
        if (state.beforeSha && committed.after.sha256 !== state.beforeSha) {
          throw new DesktopError('restore_verify_failed', '回滚后 sha256 与接入前快照不一致；原状态已保存在 ' + committed.safetyBackupPath, { sha: committed.after.sha256 }, 502)
        }
        result = { sha: committed.after.sha256, restoredFrom: committed.restoredFrom, safetyBackupPath: committed.safetyBackupPath, removed: false }
      }
      const childApplied = applyManagedAgentChildRestore(childRestore)
      saveState(paths, {
        mode: 'official',
        before: state.before,
        applied: null,
        appliedSha: null,
        beforeSha: state.beforeSha || null,
        backupPath: state.backupPath || null,
        desired: null,
        agentChild: null,
        previous: { mode: state.mode, sha: state.appliedSha || currentSha, desired: state.desired, backupPath: state.backupPath || null },
        fromMode: state.mode,
        toMode: 'official',
        exitedAt: Date.now(),
        appliedAt: null,
        lastApply: { ok: true, action: 'deactivate', scope: 'byte-exact', at: Date.now(), restoredSha: result.sha, agentChild: childApplied.handled ? { action: childRestore.action } : null },
      })
      return { ok: true, mode: 'official', sha: result.sha, restoredFrom: result.restoredFrom, removed: result.removed, selective: false, changed: true, agentChild: childApplied.handled ? { action: childRestore.action, removed: !!childApplied.removed, restored: !!childApplied.restored } : null, verification: { ok: true, sha: result.sha }, recovery }
    }

    if (opts.expectedSha !== undefined && opts.expectedSha !== null && String(opts.expectedSha) !== String(currentSha) && !current.exists) {
      throw new DesktopError('concurrent_modification', '退出前检测到 config.toml 已被删除，未做任何写入。', Object.assign({ expected: String(opts.expectedSha), actual: null }, conflictDetail()), 409)
    }
    if (opts.expectedSha !== undefined && opts.expectedSha !== null && String(opts.expectedSha) !== String(currentSha)) {
      // 页面看到的 sha 已过期：只有当改动不涉及自有键时才继续（下面 buildOwnedRestore 会证伪）。
      // 记录证据，最终由 threeWay 与 preservedUserEdits 说明发生了什么。
    }
    let restore
    try {
      restore = buildOwnedRestore({ baseText, baseExists: !!state.before.exists, currentText, desired: state.desired })
    } catch (e) {
      throw new DesktopError('restore_plan_failed', '无法计算"只撤销自有键"的计划：' + (e && e.message ? e.message : '未知错误'), conflictDetail(), 409)
    }
    if (!restore.ok) {
      throw new DesktopError('concurrent_modification',
        '配置在接入后被修改，且 ModelGate 拥有的字段已不再是接入时写入的值。为不覆盖你的改动，已中止退出；请在界面查看三方差异后手工处理。',
        conflictDetail({ restoreConflicts: restore.conflicts }), 409)
    }
    if (!restore.changed && !restore.removeFile) {
      const childApplied = applyManagedAgentChildRestore(childRestore)
      saveState(paths, {
        mode: 'official',
        before: state.before,
        applied: null,
        appliedSha: null,
        beforeSha: state.beforeSha || null,
        backupPath: state.backupPath || null,
        desired: null,
        agentChild: null,
        previous: { mode: state.mode, sha: state.appliedSha || currentSha, desired: state.desired, backupPath: state.backupPath || null },
        fromMode: state.mode,
        toMode: 'official',
        exitedAt: Date.now(),
        appliedAt: null,
        lastApply: { ok: true, action: 'deactivate', scope: 'already-restored', at: Date.now(), preservedUserEdits: true, agentChild: childApplied.handled ? { action: childRestore.action } : null },
      })
      return { ok: true, mode: 'official', sha: currentSha, removed: false, selective: true, changed: false, preservedUserEdits: true, changedKeys: [], agentChild: childApplied.handled ? { action: childRestore.action } : null, verification: { ok: true, sha: currentSha }, recovery }
    }
    const committed = commitOwnedRestore(paths, current, currentText, restore)
    const childApplied = applyManagedAgentChildRestore(childRestore)
    saveState(paths, {
      mode: 'official',
      before: state.before,
      applied: null,
      appliedSha: null,
      beforeSha: state.beforeSha || null,
      backupPath: state.backupPath || null,
      desired: null,
      agentChild: null,
      previous: { mode: state.mode, sha: state.appliedSha || currentSha, desired: state.desired, backupPath: state.backupPath || null },
      fromMode: state.mode,
      toMode: 'official',
      exitedAt: Date.now(),
      appliedAt: null,
      lastApply: {
        ok: true,
        action: 'deactivate',
        scope: 'owned-only',
        at: Date.now(),
        restoredSha: committed.sha,
        preservedUserEdits: true,
        changedKeys: restore.changedKeys,
        safetyBackupPath: committed.safetyBackupPath,
        agentChild: childApplied.handled ? { action: childRestore.action } : null,
      },
    })
    return {
      ok: true,
      mode: 'official',
      sha: committed.sha,
      removed: committed.removed,
      selective: true,
      changed: true,
      preservedUserEdits: true,
      changedKeys: restore.changedKeys,
      safetyBackupPath: committed.safetyBackupPath,
      agentChild: childApplied.handled ? { action: childRestore.action, removed: !!childApplied.removed, restored: !!childApplied.restored } : null,
      verification: { ok: true, sha: committed.sha },
      recovery,
    }
  } finally {
    lock.release()
  }
}

function readBackupText (state, paths) {
  if (!state.backupPath) throw new DesktopError('backup_missing', '缺少接入前备份，无法计算三方差异。', null, 409)
  try {
    const text = readFileSync(state.backupPath, 'utf8')
    if (state.before && state.before.sha256 && sha256Hex(text) !== state.before.sha256) {
      throw new DesktopError('backup_mismatch', '备份内容与接入前快照不一致。', null, 409)
    }
    return text
  } catch (e) {
    if (e instanceof DesktopError) throw e
    throw new DesktopError('backup_missing', '读取接入前备份失败：' + (e && e.message ? e.message : '未知错误'), null, 409)
  }
}

// —— 本机漂移对账：只写 state，不写 config.toml ——
// 场景：state.appliedSha 与当前文件不符、或 .bak 与 beforeSha 不符。
// 对账后 appliedSha 指向当前字节（备份可用时走字节级回滚；备份损坏时标记 reconciled，
// deactivate 退化为"只撤销自有键"，不再因无关的备份漂移永久 409）。
export function previewReconcile (opts = {}) {
  const paths = resolveDesktopPaths(opts)
  const state = loadState(paths)
  let current = null
  try { current = snapshotConfigFile(paths.configPath) } catch { current = null }
  const classification = classifyConfigState({ configPath: paths.configPath, baseUrl: opts.baseUrl || DEFAULT_GATEWAY_BASE_URL })
  const currentSha = current && current.exists ? current.sha256 : ''
  let backupSha = null
  let backupReadable = false
  if (state && state.backupPath) {
    try {
      backupSha = sha256Hex(readFileSync(state.backupPath))
      backupReadable = true
    } catch { backupReadable = false }
  }
  const appliedMismatch = !!(state && state.appliedSha && current.exists && current.sha256 !== state.appliedSha)
  const backupMismatch = !!(state && state.beforeSha && backupReadable && backupSha !== state.beforeSha) ||
    !!(state && state.before && state.before.exists && state.backupPath && !backupReadable)
  const reasons = []
  if (appliedMismatch) reasons.push('applied_sha_mismatch')
  if (backupMismatch) reasons.push('backup_sha_mismatch')
  return {
    contract: DESKTOP_CONTRACT,
    ok: true,
    needsReconcile: appliedMismatch || backupMismatch,
    mode: classification.mode,
    drifted: classification.drifted === true,
    currentSha,
    appliedSha: state ? state.appliedSha || null : null,
    beforeSha: state ? state.beforeSha || null : null,
    backupPath: state ? state.backupPath || null : null,
    backupSha,
    reasons,
    plan: {
      mode: classification.mode,
      appliedSha: current.exists ? currentSha : null,
      applied: current.exists ? { sha256: currentSha, size: current.size } : null,
      beforeSha: backupMismatch ? null : (state ? state.beforeSha || null : null),
      backupPath: backupMismatch ? null : (state ? state.backupPath || null : null),
      reconciled: backupMismatch ? { reason: 'backup_sha_mismatch', at: Date.now() } : null,
    },
  }
}

export function reconcileState (opts = {}) {
  const paths = resolveDesktopPaths(opts)
  const preview = previewReconcile(opts)
  const state = loadState(paths)
  if (!preview.needsReconcile || !state) {
    return { ok: true, changed: false, preview, stateBackupPath: null }
  }
  // 写前备份 state 文件：失败也不修改原 state。
  const stateBackupPath = paths.statePath + '.bak'
  try { writeAtomicJson(stateBackupPath, state, 0o600) } catch (e) {
    throw new DesktopError('state_backup_failed', '对账前 state 备份失败，未做任何写入：' + (e && e.message ? e.message : '未知错误'), null, 500)
  }
  const next = Object.assign({}, state, {
    appliedSha: preview.plan.appliedSha,
    applied: preview.plan.applied,
    beforeSha: preview.plan.beforeSha,
    backupPath: preview.plan.backupPath,
    reconciled: preview.plan.reconciled,
    reconciledAt: Date.now(),
  })
  if (preview.plan.reconciled) {
    next.lastApply = Object.assign({}, state.lastApply || {}, { reconciled: true })
  }
  saveState(paths, next)
  return { ok: true, changed: true, preview, stateBackupPath, state: next }
}

// —— 状态 ——
export function status (opts = {}) {
  const paths = resolveDesktopPaths(opts)
  const state = loadState(paths)
  let recovery = { recovered: 'none' }
  const lock = readLock(paths.lockPath, Date.now())
  if (!lock.present) {
    try {
      const held = acquireDesktopLock({ configPath: paths.configPath })
      try { recovery = recoverInterruptedApply({ configPath: paths.configPath }) } finally { held.release() }
    } catch { recovery = { recovered: 'skipped', reason: 'lock_busy' } }
  }
  const current = snapshotConfigFile(paths.configPath)
  const classification = classifyConfigState({ configPath: paths.configPath, baseUrl: opts.baseUrl })
  const fresh = loadState(paths)
  const desktop = resolveDesktopForProbe(opts)
  const clientRuntime = resolveClientRuntime(opts, { found: desktop.found, path: desktop.path })
  const appliedAt = fresh && (fresh.mode === 'aggregated' || fresh.mode === 'route') && Number(fresh.appliedAt) > 0 ? Number(fresh.appliedAt) : null
  const restart = computeRestartState({
    mode: classification.mode,
    appliedAt,
    client: clientRuntime,
    exitedAt: fresh ? fresh.exitedAt || null : null,
    lastAction: fresh && fresh.lastApply ? fresh.lastApply.action || null : null,
  })
  const nativeCompaction = nativeCompactionSummary(opts, classification)
  return {
    contract: DESKTOP_CONTRACT,
    ok: true,
    mode: classification.mode,
    reason: classification.reason,
    drifted: classification.drifted === true,
    configPath: paths.configPath,
    config: { exists: current.exists, sha256: current.exists ? current.sha256 : '', size: current.size, mtimeMs: current.mtimeMs },
    backup: backupSummary(paths, fresh, current),
    lastApply: fresh && fresh.lastApply ? fresh.lastApply : null,
    appliedAt: fresh ? fresh.appliedAt || null : null,
    lock: { present: readLock(paths.lockPath, Date.now()).present },
    journal: { present: !!journalPhase(paths) },
    recovery,
    clientRuntime,
    restart,
    nativeCompaction,
    agentChild: (() => {
      const snap = snapshotManagedAgentChild(paths.managedAgentPath)
      const rec = fresh && fresh.agentChild ? fresh.agentChild : null
      return {
        path: paths.managedAgentPath,
        fileName: MANAGED_AGENT_FILE,
        managed: !!rec,
        current: { exists: snap.exists, sha256: snap.exists ? snap.sha256 : '', size: snap.size },
        appliedSha: rec && rec.applied ? rec.applied.sha256 : null,
        modifiedSinceApply: !!(rec && rec.applied && rec.applied.sha256 && snap.exists && snap.sha256 !== rec.applied.sha256),
      }
    })(),
    needsRestart: restart.needed,
  }
}

// —— 三模式状态投影 / 回滚（供 HTTP 适配层复用；只读状态 + 受控写）——
// previousMode 不是新字段：复用 activate/deactivate 已经维护的 state.previous.mode，
// 避免另建第二份状态（两份状态一旦不同步，回滚就会写错模式）。
export function modeSnapshot (opts = {}) {
  const paths = resolveDesktopPaths(opts)
  const classification = classifyConfigState({
    configPath: paths.configPath,
    baseUrl: String(opts.baseUrl || DEFAULT_GATEWAY_BASE_URL),
  })
  const state = loadState(paths)
  const mode = classification.mode
  const target = resolveModeTarget({ mode: AGGREGATION_MODES.includes(mode) ? mode : 'official', cfg: opts.cfg })
  const cfgDefault = opts.cfg && opts.cfg.defaults && opts.cfg.defaults.model
  const parentModel = (state && state.parentModel) ||
    (mode === 'route' ? target.parentModel : (String(cfgDefault || '').trim() || target.parentModel))
  const childModel = state && state.childModel ? state.childModel : target.childModel
  const previousMode = state && state.previous && AGGREGATION_MODES.includes(String(state.previous.mode))
    ? String(state.previous.mode)
    : null
  return {
    mode,
    parentModel,
    childModel,
    previousMode,
    drifted: classification.drifted === true,
    appliedSha: classification.sha256 || null,
  }
}

// 回滚预览：回到 state.previous.mode。official 走逐字节恢复（备份），route/aggregated
// 复用模式切换预览（planModeTransition 保证"看到什么就写什么"）。无 previous / 漂移 / 备份
// 不可用一律 typed 409 + 零写入；consentToken 绑定 before/after sha，任一变化即失配。
export function previewRollback (opts = {}) {
  const paths = resolveDesktopPaths(opts)
  const state = loadState(paths)
  if (!state || !state.previous || !AGGREGATION_MODES.includes(String(state.previous.mode))) {
    throw new DesktopError('no_previous_mode', '没有可回滚的上一模式：当前配置不是由 ModelGate 从上一种模式切换而来。', {
      mode: state ? state.mode : null,
    }, 409)
  }
  const previousMode = String(state.previous.mode)
  const gatewayBaseUrl = String(opts.baseUrl || DEFAULT_GATEWAY_BASE_URL).replace(/\/+$/, '')
  const classification = classifyConfigState({ configPath: paths.configPath, baseUrl: gatewayBaseUrl })
  if (classification.drifted) {
    throw new DesktopError('config_drifted', '配置已被修改（sha 漂移），不能回滚；请重新检测后再操作。', {
      mode: classification.mode, appliedSha: state.appliedSha || null, currentSha: classification.sha256 || null,
    }, 409)
  }
  if (previousMode === 'official') {
    const backupPath = state.previous.backupPath || state.backupPath || null
    if (!backupPath || !state.before || !state.before.exists) {
      throw new DesktopError('previous_backup_missing', '上一模式（官方直连）的接入前备份不可用，无法回滚。', { previousMode }, 409)
    }
    let backupText
    try { backupText = readFileSync(backupPath, 'utf8') } catch {
      throw new DesktopError('previous_backup_missing', '上一模式（官方直连）的接入前备份不可读，无法回滚。', { previousMode }, 409)
    }
    const current = snapshotConfigFile(paths.configPath)
    const currentText = current.exists ? readFileSync(paths.configPath, 'utf8') : ''
    const existing = readOwnedFields(currentText)
    const baseOwned = readOwnedFields(backupText)
    // 期望形态 = 接入前备份里的自有字段；ownedRows 会标出要删除的 openai_base_url / 目录段等 remove 行。
    const desired = { topLevel: {}, sections: {} }
    for (const [key, entry] of Object.entries(baseOwned.topLevel || {})) {
      if (!entry || !entry.present) continue
      const value = normalizeOwnedValue(entry)
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') desired.topLevel[key] = value
    }
    for (const [name, section] of Object.entries(baseOwned.sections || {})) {
      for (const [key, entry] of Object.entries((section && section.keys) || {})) {
        if (!entry || !entry.present) continue
        const value = normalizeOwnedValue(entry)
        if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue
        if (!desired.sections[name]) desired.sections[name] = {}
        desired.sections[name][key] = value
      }
    }
    const rows = ownedRows(existing, desired, { includeRemovals: true })
    const expectedSha = current.exists ? current.sha256 : ''
    const afterSha = sha256Hex(Buffer.from(backupText, 'utf8'))
    const binding = { fromMode: classification.mode, toMode: 'official', providerMode: 'builtin-openai' }
    return {
      contract: DESKTOP_CONTRACT,
      ok: true,
      state: 'ready',
      mode: classification.mode,
      fromMode: classification.mode,
      toMode: 'official',
      previousMode: 'official',
      before: { exists: current.exists, size: current.size, sha256: expectedSha },
      after: { exists: true, size: Buffer.byteLength(backupText, 'utf8'), sha256: afterSha },
      expectedSha,
      afterSha,
      rows,
      changed: rows.filter((r) => r.kind !== 'same'),
      conflicts: [],
      blocked: [],
      warnings: [],
      preserved: summarizePreserved(currentText),
      consentRequired: true,
      consentToken: consentTokenFor(paths.configPath, expectedSha, afterSha, binding),
      firstRun: false,
      catalog: null,
      agentChild: null,
    }
  }
  const p = preview(Object.assign({}, opts, { mode: previousMode }))
  return Object.assign({}, p, { previousMode })
}

// 回滚写：previewRollback 的确认阶段。token 失配 → 428；expectedSha 不符 → 409；
// previousMode=official 走逐字节恢复，route/aggregated 走模式切换写入。
export async function rollback (opts = {}) {
  const p = previewRollback(opts)
  if (!p.ok) {
    throw new DesktopError('rollback_blocked', '回滚被前置条件阻止，未做任何写入。', {
      blocked: p.blocked || [], preview: p,
    }, 422)
  }
  if (!opts.consentToken || String(opts.consentToken) !== p.consentToken) {
    throw new DesktopError('consent_required', '回滚前必须显式确认：请先调用预览并把 consentToken 与 expectedSha 一起回传。', {
      expectedSha: p.expectedSha, afterSha: p.afterSha, consentTokenHint: p.consentToken,
    }, 428)
  }
  if (opts.expectedSha !== undefined && opts.expectedSha !== null && String(opts.expectedSha) !== String(p.expectedSha)) {
    throw new DesktopError('concurrent_modification', '预览后配置已被修改，已中止且未做任何写入。', {
      expected: String(p.expectedSha), actual: String(opts.expectedSha),
    }, 409)
  }
  const previousMode = p.previousMode
  if (previousMode === 'official') {
    const out = await deactivate(Object.assign({}, opts, { expectedSha: p.expectedSha }))
    return Object.assign({}, out, { mode: 'official', previousMode })
  }
  const out = await activate(Object.assign({}, opts, {
    mode: previousMode,
    consentToken: p.consentToken,
    expectedSha: p.expectedSha,
  }))
  return Object.assign({}, out, { previousMode })
}

// 供 HTTP 适配层一次性构造：五个导出之外的内部契约（不改变冻结签名）。
export const DESKTOP_POLICY = Object.freeze({
  contract: DESKTOP_CONTRACT,
  ownedTopLevel: OWNED_TOP_LEVEL.slice(),
  ownedSections: Object.fromEntries(Object.entries(OWNED_SECTIONS).map(([k, v]) => [k, v.slice()])),
  reservedOverrideSections: RESERVED_OVERRIDE_SECTIONS.slice(),
  // Provider 级原生压缩声明（A1 结论的落点）。默认不写：GitHub 内置 openai 身份不可覆盖。
  managedProvider: Object.freeze({
    id: MANAGED_PROVIDER_ID,
    sections: Object.freeze(Object.fromEntries(Object.entries(MANAGED_PROVIDER_SECTIONS).map(([k, v]) => [k, v.slice()]))),
    capabilityField: 'model_providers.' + MANAGED_PROVIDER_ID + '.capabilities.remote_compaction',
    literals: REMOTE_COMPACTION_LITERALS.slice(),
    requiresOpenAiAuth: true,
    experimentalFlag: 'experimentalManagedProvider',
    configParseEvidence: 'codex-cli 0.167.0-alpha.3.2 serde validation: enum accepts unsupported | v2; requires_openai_auth accepted',
    reservedBuiltinEvidence: 'codex-cli 0.167.0-alpha.3.2 rejects any [model_providers.openai*] as reserved built-in provider ID',
    runtimeAuth: 'UNVERIFIED',
  }),
  maxCatalogBytes: MAX_CATALOG_BYTES,
  // MG-FIX-P1-05：Codex 原生命名子代理由 ModelGate 托管（字段 + 子文件），仍是原生配置。
  managedAgent: Object.freeze({
    section: MANAGED_AGENT_SECTION,
    childFile: MANAGED_AGENT_FILE,
    sections: Object.freeze({ [MANAGED_AGENT_SECTION]: OWNED_SECTIONS[MANAGED_AGENT_SECTION].slice() }),
    features: Object.freeze(['multi_agent']),
    rollback: 'byte-compatible（新建则删除、既有则按接入前备份逐字节还原），用户改动 → 409 三方差异',
  }),
  verification: ['config-parse-owned-fields', 'managed-agent-child-file', 'catalog-present-and-parseable', 'gateway-health'],
  forbidden: ['auth.json', 'model_providers.openai', 'default_subagent_model（不在所有权声明内）'],
})
