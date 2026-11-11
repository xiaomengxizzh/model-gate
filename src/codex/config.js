// Codex config.toml 受控写入（E6 / D5：受控自动管理）。
//
// 契约（与 docs/reference/codex-config.md 一致）：
//  * 只改"声明所有权"的字段：顶层 model_provider / openai_base_url / model / model_catalog_json，
//    以及 [features] 的白名单键（multi_agent / multi_agent_v2）。
//  * 绝不生成或改写 [model_providers.openai]：Codex 0.167 把 openai 列为 reserved built-in
//    provider ID，覆盖它会让客户端直接启动失败（E3 实测）。发现已有该段时只告警、不动它。
//  * 其余行（未知字段、MCP、projects、权限、注释）逐字节保留；写前写后用
//    unmanagedFingerprint 断言"未被管理的行完全一致"，不等则 fail closed。
//  * 写前快照（size + sha256）→ 显式确认令牌 → 写入前再校验一次（缩小 TOCTOU 窗口）。
//  * tmp + fsync + rename 原子替换；旧内容存 .bak；写失败/校验失败自动用 .bak 恢复。
//  * 绝不读写 auth.json；绝不整文件覆盖；不读 HOME —— 所有函数只接受显式绝对路径，
//    便于服务端路由直接调用，也便于测试用临时目录 fixture。
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

export const CONFIG_CONTRACT = 'mg-codex-config/1'
export const OWNED_TOP_LEVEL = Object.freeze(['model_provider', 'openai_base_url', 'model', 'model_catalog_json'])
// 只声明 features 的白名单键；其它 feature 一律视为外部所有。
export const OWNED_SECTIONS = Object.freeze({
  features: Object.freeze(['multi_agent', 'multi_agent_v2']),
})
const OWNED_SECTION_NAMES = Object.keys(OWNED_SECTIONS)
// 这些段会让 Codex 启动失败（reserved built-in provider ID）：只检测、告警，绝不自动删改。
export const RESERVED_OVERRIDE_SECTIONS = Object.freeze(['model_providers.openai'])
export const MAX_CONFIG_BYTES = 512 * 1024
const MAX_DIFF_CELLS = 4000000

export class ConfigError extends Error {
  constructor (code, message, detail) {
    super(message)
    this.name = 'ConfigError'
    this.code = code
    this.detail = detail === undefined ? null : detail
  }
}

export function sha256Hex (input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input == null ? '' : input), 'utf8')
  return createHash('sha256').update(buf).digest('hex')
}

// —— 路径护栏 ——
// 只接受显式绝对路径；文件名必须是 config.toml（除非调用方显式放行）；auth.json 一律拒绝；
// 符号链接一律拒绝（避免写到 ~/.codex 之外或写错目标）。
export function assertConfigPath (path, opts = {}) {
  const raw = typeof path === 'string' ? path.trim() : ''
  if (!raw) throw new ConfigError('invalid_path', '必须提供显式的 config.toml 绝对路径（本模块不读 HOME、不猜默认值）。')
  if (!isAbsolute(raw)) throw new ConfigError('invalid_path', '必须使用绝对路径：' + raw)
  const target = resolve(raw)
  const base = basename(target)
  if (base.toLowerCase() === 'auth.json') throw new ConfigError('forbidden_path', 'auth.json 永不写入：官方凭据文件不属于本模块职责。')
  if (!opts.allowNonStandardName) {
    if (base !== 'config.toml') throw new ConfigError('invalid_path', '目标文件名必须是 config.toml（收到 ' + base + '）。')
  } else if (!/\.toml$/i.test(base)) {
    throw new ConfigError('invalid_path', '放行非标准文件名时仍要求 .toml 扩展名（收到 ' + base + '）。')
  }
  let st = null
  try { st = lstatSync(target) } catch {}
  if (st && st.isSymbolicLink()) throw new ConfigError('symlink_refused', '目标路径是符号链接，拒绝写入（fail closed）。')
  return target
}

function assertBackupPath (target, backupPath) {
  const raw = typeof backupPath === 'string' ? backupPath.trim() : ''
  if (!raw) throw new ConfigError('invalid_path', '必须提供备份文件绝对路径。')
  if (!isAbsolute(raw)) throw new ConfigError('invalid_path', '备份路径必须是绝对路径。')
  const bak = resolve(raw)
  if (!(bak === target + '.bak' || bak.startsWith(target + '.bak'))) {
    throw new ConfigError('invalid_path', '备份路径必须位于 ' + target + '.bak* 名下，拒绝任意文件读取。')
  }
  return bak
}

// —— 行级 TOML 子集解析（只做"按行段定位"，不做完整 TOML 语义）——
function splitLines (text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  return { eol, lines: text.split(eol) }
}

const HEADER_RE = /^\[\[?([^\[\]]+)\]\]?$/
const KEY_RE = /^([A-Za-z0-9_-]+)\s*=\s*([\s\S]*)$/

function isMultilineValue (value) {
  const v = String(value || '').trim()
  if (v === '') return true
  if (v.startsWith('"""')) return (v.match(/"""/g) || []).length < 2
  if (v.startsWith("'''")) return (v.match(/'''/g) || []).length < 2
  if (v.startsWith('[')) return !v.endsWith(']')
  if (v.startsWith('{')) return !v.endsWith('}')
  return false
}

export function parseConfigDocument (text) {
  const src = String(text == null ? '' : text)
  const { eol, lines } = splitLines(src)
  const meta = []
  const sections = []
  let current = { name: '', isArray: false, start: -1, end: -1 }
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const trimmed = raw.trim()
    if (trimmed === '') { meta.push({ i, kind: 'blank', raw, sectionName: current.name }); continue }
    if (trimmed.startsWith('#')) { meta.push({ i, kind: 'comment', raw, sectionName: current.name }); continue }
    const header = HEADER_RE.exec(trimmed)
    if (header) {
      const isArray = trimmed.startsWith('[[')
      current.end = i - 1
      if (current.start >= 0) sections.push(current)
      const name = header[1].trim()
      current = { name, isArray, start: i, end: -1 }
      meta.push({ i, kind: 'header', raw, sectionName: name, isArray })
      continue
    }
    const kv = KEY_RE.exec(trimmed)
    if (kv) {
      meta.push({
        i,
        kind: 'entry',
        raw,
        sectionName: current.name,
        key: kv[1],
        value: kv[2],
        multiline: isMultilineValue(kv[2]),
      })
      continue
    }
    meta.push({ i, kind: 'other', raw, sectionName: current.name })
  }
  current.end = lines.length - 1
  if (current.start >= 0) sections.push(current)
  return { eol, lines, meta, sections }
}

function findSection (doc, name) {
  const hits = doc.sections.filter((s) => s.name === name)
  const plain = hits.filter((s) => !s.isArray)
  if (hits.length > plain.length) {
    throw new ConfigError('unsupported_layout', '检测到 [[' + name + ']] 数组表；本模块不处理该布局（fail closed）。')
  }
  if (plain.length > 1) throw new ConfigError('duplicate_section', '重复定义 [' + name + ']，拒绝自动改写。')
  return plain.length ? plain[0] : null
}

function findEntry (doc, sectionName, key) {
  const hits = doc.meta.filter((m) => m.kind === 'entry' && m.sectionName === sectionName && m.key === key)
  if (hits.length > 1) throw new ConfigError('duplicate_key', '键 ' + (sectionName ? '[' + sectionName + '] ' : '') + key + ' 重复出现，拒绝自动改写。')
  return hits.length ? hits[0].i : -1
}

function tomlValue (value) {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  throw new ConfigError('unsupported_value', '仅支持 string / boolean / number 值（收到 ' + (value === null ? 'null' : typeof value) + '）。')
}

function renderKeyLine (key, value) {
  return key + ' = ' + tomlValue(value)
}

// 已有行可能带缩进/行内风格：替换时保留原有前导空白，避免无意义格式变更。
function withIndent (rawLine, line) {
  const indent = /^[ \t]*/.exec(String(rawLine || ''))[0]
  return indent + line
}

function ownedKeysForSection (sectionName) {
  return OWNED_SECTIONS[sectionName] || null
}

function normalizeDesired (desired) {
  const out = { topLevel: {}, sections: {} }
  if (!desired || typeof desired !== 'object') throw new ConfigError('invalid_desired', '缺少 desired 字段声明。')
  const top = desired.topLevel == null ? {} : desired.topLevel
  if (typeof top !== 'object') throw new ConfigError('invalid_desired', 'desired.topLevel 必须是对象。')
  for (const [key, value] of Object.entries(top)) {
    if (!OWNED_TOP_LEVEL.includes(key)) throw new ConfigError('not_owned_field', '字段 ' + key + ' 不在所有权声明内，拒绝写入。')
    tomlValue(value)
    out.topLevel[key] = value
  }
  const sections = desired.sections == null ? {} : desired.sections
  if (typeof sections !== 'object') throw new ConfigError('invalid_desired', 'desired.sections 必须是对象。')
  for (const [name, keys] of Object.entries(sections)) {
    const allowed = ownedKeysForSection(name)
    if (!allowed) throw new ConfigError('not_owned_field', '段 [' + name + '] 不在所有权声明内，拒绝写入。')
    if (!keys || typeof keys !== 'object') throw new ConfigError('invalid_desired', 'sections.' + name + ' 必须是对象。')
    out.sections[name] = {}
    for (const [key, value] of Object.entries(keys)) {
      if (!allowed.includes(key)) throw new ConfigError('not_owned_field', '[' + name + '] 的 ' + key + ' 不在所有权声明内，拒绝写入。')
      tomlValue(value)
      out.sections[name][key] = value
    }
  }
  return out
}

function pushInsert (map, index, line) {
  if (!map.has(index)) map.set(index, [])
  map.get(index).push(line)
}

function composeText (doc, replacements, insertBefore, append) {
  const out = []
  const ensureBlank = () => { if (out.length && out[out.length - 1].trim() !== '') out.push('') }
  for (let i = 0; i < doc.lines.length; i++) {
    const ins = insertBefore.get(i)
    if (ins) {
      if (i === 0) ensureBlank()
      for (const line of ins) out.push(line)
    }
    out.push(replacements.has(i) ? replacements.get(i) : doc.lines[i])
  }
  if (append.length) {
    ensureBlank()
    for (const line of append) out.push(line)
  }
  return out.join(doc.eol)
}

function classifyLine (meta) {
  if (meta.kind === 'blank') return 'blank'
  if (meta.kind === 'comment') return 'comment'
  if (meta.kind === 'header') return OWNED_SECTION_NAMES.includes(meta.sectionName) ? 'modelgate' : 'external'
  if (meta.kind === 'entry') {
    if (meta.sectionName === '' && OWNED_TOP_LEVEL.includes(meta.key)) return 'modelgate'
    const owned = ownedKeysForSection(meta.sectionName)
    if (owned && owned.includes(meta.key)) return 'modelgate'
  }
  return 'external'
}

// "未被管理的行"指纹：去掉空行、owned 字段行与 owned 段头后按顺序拼接。
// 只要指纹前后一致，就证明模块没有碰其它配置（MCP/权限/未知字段/注释）。
export function unmanagedFingerprint (text) {
  const doc = parseConfigDocument(text)
  const out = []
  for (const m of doc.meta) {
    if (m.kind === 'blank') continue
    if (m.kind === 'header' && OWNED_SECTION_NAMES.includes(m.sectionName) && !m.isArray) continue
    if (m.kind === 'entry' && m.sectionName === '' && OWNED_TOP_LEVEL.includes(m.key)) continue
    const owned = ownedKeysForSection(m.sectionName)
    if (m.kind === 'entry' && owned && owned.includes(m.key)) continue
    out.push(m.raw)
  }
  return out.join('\n')
}

export function summarizePreserved (text) {
  const doc = typeof text === 'string' ? parseConfigDocument(text) : text
  const topLevelKeys = []
  const sectionNames = []
  for (const m of doc.meta) {
    if (m.kind === 'entry' && m.sectionName === '' && !OWNED_TOP_LEVEL.includes(m.key) && !topLevelKeys.includes(m.key)) topLevelKeys.push(m.key)
  }
  for (const s of doc.sections) {
    if (!s.name || OWNED_SECTION_NAMES.includes(s.name)) continue
    if (!sectionNames.includes(s.name)) sectionNames.push(s.name)
  }
  const mcp = sectionNames.filter((n) => n.startsWith('mcp_servers.')).map((n) => n.slice('mcp_servers.'.length))
  return {
    topLevelKeys,
    sections: sectionNames,
    mcpServers: mcp,
    hasProjects: sectionNames.some((n) => n === 'projects' || n.startsWith('projects.')),
    hasPermissions: sectionNames.some((n) => /approval|sandbox|permission/i.test(n)),
    reservedOverrides: sectionNames.filter((n) => RESERVED_OVERRIDE_SECTIONS.includes(n)),
  }
}

// —— 只读：当前 owned 字段的取值 + 需要人工处理的既有段 ——
export function readOwnedFields (text) {
  const doc = parseConfigDocument(text)
  const top = {}
  for (const key of OWNED_TOP_LEVEL) {
    const i = doc.meta.findIndex((m) => m.kind === 'entry' && m.sectionName === '' && m.key === key)
    top[key] = i >= 0 ? { present: true, raw: String(doc.meta[i].value).trim(), multiline: !!doc.meta[i].multiline } : { present: false, raw: '', multiline: false }
  }
  const sections = {}
  for (const name of OWNED_SECTION_NAMES) {
    const sec = doc.sections.find((s) => s.name === name && !s.isArray) || null
    sections[name] = { present: !!sec, keys: {} }
    for (const key of OWNED_SECTIONS[name]) {
      const hit = sec ? doc.meta.find((m) => m.kind === 'entry' && m.sectionName === name && m.key === key) : null
      sections[name].keys[key] = hit ? { present: true, raw: String(hit.value).trim(), multiline: !!hit.multiline } : { present: false, raw: '', multiline: false }
    }
  }
  return { topLevel: top, sections, preserved: summarizePreserved(doc) }
}

// —— 合并：只改 owned 行，其余行保持原样，并用指纹自证 ——
export function mergeOwnedFields (beforeText, desired) {
  const text = String(beforeText == null ? '' : beforeText)
  const doc = parseConfigDocument(text)
  const want = normalizeDesired(desired)
  const replacements = new Map()
  const insertBefore = new Map()
  const append = []
  const changed = []
  const warnings = []
  const createdSections = []

  for (const [key, value] of Object.entries(want.topLevel)) {
    const line = renderKeyLine(key, value)
    const idx = findEntry(doc, '', key)
    if (idx >= 0) {
      const m = doc.meta[idx]
      if (m.multiline) throw new ConfigError('multiline_value', '顶层 ' + key + ' 是多行/数组值，自动改写被拒绝；请手工合并。')
      if (doc.lines[idx].trim() !== line) {
        replacements.set(idx, withIndent(doc.lines[idx], line))
        changed.push({ path: key, from: String(m.value).trim(), to: line })
      }
    } else {
      const firstHeader = doc.meta.findIndex((m) => m.kind === 'header')
      if (firstHeader >= 0) pushInsert(insertBefore, firstHeader, line)
      else append.push(line)
      changed.push({ path: key, from: null, to: line })
    }
  }

  for (const [name, keys] of Object.entries(want.sections)) {
    const sec = findSection(doc, name)
    if (!sec) {
      append.push('[' + name + ']')
      for (const [k, v] of Object.entries(keys)) {
        const line = renderKeyLine(k, v)
        append.push(line)
        changed.push({ path: name + '.' + k, from: null, to: line })
      }
      createdSections.push(name)
      continue
    }
    let insertAt = sec.end
    while (insertAt > sec.start && doc.lines[insertAt].trim() === '') insertAt--
    insertAt += 1
    for (const [k, v] of Object.entries(keys)) {
      const line = renderKeyLine(k, v)
      const idx = findEntry(doc, name, k)
      if (idx >= 0) {
        const m = doc.meta[idx]
        if (m.multiline) throw new ConfigError('multiline_value', '[' + name + '] ' + k + ' 是多行/数组值，自动改写被拒绝；请手工合并。')
        if (doc.lines[idx].trim() !== line) {
          replacements.set(idx, withIndent(doc.lines[idx], line))
          changed.push({ path: name + '.' + k, from: String(m.value).trim(), to: line })
        }
      } else {
        pushInsert(insertBefore, insertAt, line)
        changed.push({ path: name + '.' + k, from: null, to: line })
      }
    }
  }

  const preserved = summarizePreserved(doc)
  if (preserved.reservedOverrides.length) {
    warnings.push('检测到 [' + preserved.reservedOverrides.join('], [') + ']：Codex 把 openai 视为 reserved built-in provider ID，该段会让客户端启动失败；本模块不删改它，请手工移除。')
  }
  if (!changed.length) return { text, changed, warnings, preserved, createdSections }
  const merged = composeText(doc, replacements, insertBefore, append)
  if (!merged.trim()) throw new ConfigError('unmanaged_conflict', '合并结果为空，已拒绝写入（fail closed）。')
  if (unmanagedFingerprint(text) !== unmanagedFingerprint(merged)) {
    throw new ConfigError('unmanaged_conflict', '合并会改动未被管理的行，已拒绝（fail closed）。')
  }
  if (preserved.mcpServers.length) warnings.push('保留了 ' + preserved.mcpServers.length + ' 个 MCP server 段（未修改）。')
  return { text: merged, changed, warnings, preserved, createdSections }
}

// —— 行级 diff（仅用于预览/展示）——
function lcsRows (a, b) {
  const n = a.length
  const m = b.length
  const w = m + 1
  const dp = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j]
        ? dp[(i + 1) * w + j + 1] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1])
    }
  }
  const rows = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { rows.push({ kind: 'same', beforeNo: i + 1, afterNo: j + 1, text: a[i] }); i++; j++ }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { rows.push({ kind: 'del', beforeNo: i + 1, afterNo: null, text: a[i] }); i++ }
    else { rows.push({ kind: 'add', beforeNo: null, afterNo: j + 1, text: b[j] }); j++ }
  }
  while (i < n) { rows.push({ kind: 'del', beforeNo: i + 1, afterNo: null, text: a[i] }); i++ }
  while (j < m) { rows.push({ kind: 'add', beforeNo: null, afterNo: j + 1, text: b[j] }); j++ }
  return rows
}

function coarseRows (a, b) {
  const rows = []
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) { rows.push({ kind: 'same', beforeNo: p + 1, afterNo: p + 1, text: a[p] }); p++ }
  let s = 0
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
  for (let i = p; i < a.length - s; i++) rows.push({ kind: 'del', beforeNo: i + 1, afterNo: null, text: a[i] })
  for (let j = p; j < b.length - s; j++) rows.push({ kind: 'add', beforeNo: null, afterNo: j + 1, text: b[j] })
  const tail = Math.min(s, b.length)
  for (let k = 0; k < tail; k++) rows.push({ kind: 'same', beforeNo: a.length - tail + k + 1, afterNo: b.length - tail + k + 1, text: b[b.length - tail + k] })
  return rows
}

// 每行标注所有者：modelgate = 本模块可改；external = 只读保留。
export function diffConfigText (beforeText, afterText) {
  const beforeSrc = String(beforeText == null ? '' : beforeText)
  const afterSrc = String(afterText == null ? '' : afterText)
  const before = splitLines(beforeSrc)
  const after = splitLines(afterSrc)
  const rows = (before.lines.length * after.lines.length > MAX_DIFF_CELLS)
    ? coarseRows(before.lines, after.lines)
    : lcsRows(before.lines, after.lines)
  const byBefore = new Map(parseConfigDocument(beforeSrc).meta.map((m) => [m.i, m]))
  const byAfter = new Map(parseConfigDocument(afterSrc).meta.map((m) => [m.i, m]))
  const out = []
  for (const row of rows) {
    const meta = row.kind === 'del'
      ? (byBefore.get(row.beforeNo - 1) || null)
      : (byAfter.get(row.afterNo - 1) || byBefore.get((row.beforeNo || 0) - 1) || null)
    const owner = meta ? classifyLine(meta) : 'external'
    out.push({
      kind: row.kind,
      beforeNo: row.beforeNo,
      afterNo: row.afterNo,
      owner: owner === 'modelgate' ? 'modelgate' : 'external',
      section: meta ? meta.sectionName : '',
      text: row.text,
    })
  }
  return out
}

// —— 快照与写盘 ——
export function snapshotConfigFile (path, opts = {}) {
  const target = assertConfigPath(path, opts)
  let st = null
  try { st = lstatSync(target) } catch (e) {
    if (e && e.code === 'ENOENT') return { path: target, exists: false, size: 0, sha256: '', mtimeMs: 0, mode: 0 }
    throw new ConfigError('stat_failed', '无法读取目标文件状态：' + (e && e.message ? e.message : '未知错误'))
  }
  if (!st.isFile()) throw new ConfigError('not_a_file', '目标路径不是普通文件：' + target)
  const buf = readFileSync(target)
  if (buf.length > MAX_CONFIG_BYTES) throw new ConfigError('too_large', 'config.toml 超过 ' + MAX_CONFIG_BYTES + ' 字节，拒绝自动写入。')
  return { path: target, exists: true, size: buf.length, sha256: sha256Hex(buf), mtimeMs: Math.round(Number(st.mtimeMs) || 0), mode: st.mode & 0o777 }
}

function confirmTokenFor (path, beforeSha, afterSha) {
  return sha256Hex(CONFIG_CONTRACT + '\n' + path + '\n' + beforeSha + '\n' + afterSha)
}

function rollbackTokenFor (path, currentSha, backupSha) {
  return sha256Hex(CONFIG_CONTRACT + '/rollback\n' + path + '\n' + currentSha + '\n' + backupSha)
}

function atomicWriteFile (path, text, mode) {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, '.' + basename(path) + '.mg-' + process.pid + '-' + randomBytes(6).toString('hex') + '.tmp')
  let fd = null
  try {
    fd = openSync(tmp, 'wx', mode || 0o600)
    writeSync(fd, Buffer.from(String(text == null ? '' : text), 'utf8'))
    fsyncSync(fd)
  } catch (e) {
    try { if (fd != null) closeSync(fd) } catch {}
    try { unlinkSync(tmp) } catch {}
    throw new ConfigError('write_failed', '写入临时文件失败：' + (e && e.message ? e.message : '未知错误'))
  }
  try { closeSync(fd) } catch {}
  try { chmodSync(tmp, mode || 0o600) } catch {}
  try {
    renameSync(tmp, path)
  } catch (e) {
    try { unlinkSync(tmp) } catch {}
    throw new ConfigError('write_failed', '原子替换失败：' + (e && e.message ? e.message : '未知错误'))
  }
}

function writeBackup (path, text, backupDir) {
  const dir = backupDir ? resolve(backupDir) : dirname(path)
  mkdirSync(dir, { recursive: true })
  const bak = join(dir, basename(path) + '.bak')
  const buf = Buffer.from(String(text == null ? '' : text), 'utf8')
  let existing = null
  try { existing = readFileSync(bak) } catch {}
  if (existing && existing.length) {
    if (existing.equals(buf)) return bak
    try { renameSync(bak, bak + '.prev') } catch {}
  }
  let fd = null
  try {
    fd = openSync(bak, 'w', 0o600)
    writeSync(fd, buf)
    fsyncSync(fd)
  } catch (e) {
    try { if (fd != null) closeSync(fd) } catch {}
    throw new ConfigError('backup_failed', '备份写入失败：' + (e && e.message ? e.message : '未知错误'))
  }
  try { closeSync(fd) } catch {}
  try { chmodSync(bak, 0o600) } catch {}
  return bak
}

function restoreSilently (path, backupPath, mode) {
  try {
    const buf = readFileSync(backupPath)
    atomicWriteFile(path, buf, mode || 0o600)
    return true
  } catch { return false }
}

function buildPlan (opts = {}) {
  const pathOpts = { allowNonStandardName: !!opts.allowNonStandardName }
  const target = assertConfigPath(opts.path, pathOpts)
  const before = snapshotConfigFile(target, pathOpts)
  // 传入快照时先比对：文件被外部删除/替换也算并发冲突，比"文件不存在"更准确。
  if (opts.expected) assertExpected(before, opts.expected)
  if (!before.exists && !opts.allowCreate) {
    throw new ConfigError('config_not_found', '目标 config.toml 不存在；创建新文件需要显式 allowCreate。路径：' + target)
  }
  const beforeText = before.exists ? readFileSync(target, 'utf8') : ''
  const merged = mergeOwnedFields(beforeText, opts.desired)
  const afterBuf = Buffer.from(merged.text, 'utf8')
  const after = { exists: true, size: afterBuf.length, sha256: sha256Hex(afterBuf) }
  return {
    target,
    before,
    beforeText,
    after,
    afterText: merged.text,
    existing: readOwnedFields(beforeText),
    changed: merged.changed,
    warnings: merged.warnings,
    preserved: merged.preserved,
    createdSections: merged.createdSections,
    diff: diffConfigText(beforeText, merged.text),
    confirmToken: confirmTokenFor(target, before.sha256, after.sha256),
    backupPath: target + '.bak',
  }
}

function assertExpected (before, expected) {
  if (!expected) {
    throw new ConfigError('snapshot_required', '必须提供写前快照（exists/size/sha256）；不做"盲写"。')
  }
  if (expected.exists !== undefined && !!expected.exists !== !!before.exists) {
    throw new ConfigError('concurrent_modification', '目标文件存在性与快照不一致（外部新建或删除），已中止。')
  }
  if (expected.sha256 !== undefined && String(expected.sha256) !== String(before.sha256)) {
    throw new ConfigError('concurrent_modification', '目标文件 sha256 与快照不一致（外部已修改），已中止。')
  }
  if (expected.size !== undefined && Number(expected.size) !== Number(before.size)) {
    throw new ConfigError('concurrent_modification', '目标文件大小与快照不一致（外部已修改），已中止。')
  }
}

function assertConfirm (token, expectedToken) {
  if (!token || String(token) !== expectedToken) {
    throw new ConfigError('confirmation_required', '缺少或错误的确认令牌：写入前必须先预览 plan 并把 confirmToken 回传。')
  }
}

// 纯预览：默认不返回文件正文（避免把 config.toml 内容带进响应/日志）。
export function planConfigApply (opts = {}) {
  const plan = buildPlan(opts)
  const view = {
    ok: true,
    contract: CONFIG_CONTRACT,
    path: plan.target,
    policy: describeConfigPolicy(),
    before: plan.before,
    after: plan.after,
    existing: plan.existing,
    changed: plan.changed,
    warnings: plan.warnings,
    preserved: plan.preserved,
    createdSections: plan.createdSections,
    diff: plan.diff,
    confirmToken: plan.confirmToken,
    backupPath: plan.backupPath,
    requiresConfirmation: true,
  }
  if (opts.includeTexts) { view.beforeText = plan.beforeText; view.afterText = plan.afterText }
  return view
}

export function applyConfigChange (opts = {}) {
  const pathOpts = { allowNonStandardName: !!opts.allowNonStandardName }
  const plan = buildPlan(opts)
  assertExpected(plan.before, opts.expected)
  assertConfirm(opts.confirmToken, plan.confirmToken)
  // 写入前再取一次快照：把 TOCTOU 窗口压到一次 stat+read。
  const recheck = snapshotConfigFile(plan.target, pathOpts)
  if (recheck.exists !== plan.before.exists || recheck.sha256 !== plan.before.sha256 || recheck.size !== plan.before.size) {
    throw new ConfigError('concurrent_modification', '另一进程在预览后修改了 config.toml（sha256/大小变化），已中止本次写入。')
  }
  let backupPath = null
  if (plan.before.exists) backupPath = writeBackup(plan.target, plan.beforeText, opts.backupDir)
  const mode = plan.before.exists ? (plan.before.mode || 0o600) : 0o600
  try {
    atomicWriteFile(plan.target, plan.afterText, mode)
  } catch (e) {
    if (backupPath) restoreSilently(plan.target, backupPath, mode)
    throw e instanceof ConfigError ? e : new ConfigError('write_failed', e && e.message ? e.message : '写入失败')
  }
  const after = snapshotConfigFile(plan.target, pathOpts)
  if (after.sha256 !== plan.after.sha256) {
    const restored = backupPath ? restoreSilently(plan.target, backupPath, mode) : false
    throw new ConfigError('verify_failed', '写入后 sha256 校验失败' + (restored ? '，已用备份恢复。' : '。'))
  }
  return {
    ok: true,
    contract: CONFIG_CONTRACT,
    path: plan.target,
    before: { exists: plan.before.exists, size: plan.before.size, sha256: plan.before.sha256 },
    after: { size: after.size, sha256: after.sha256 },
    changed: plan.changed,
    warnings: plan.warnings,
    preserved: plan.preserved,
    createdSections: plan.createdSections,
    backupPath,
    confirmToken: plan.confirmToken,
  }
}

export function planRollback (opts = {}) {
  const pathOpts = { allowNonStandardName: !!opts.allowNonStandardName }
  const target = assertConfigPath(opts.path, pathOpts)
  const backupPath = assertBackupPath(target, opts.backupPath || (target + '.bak'))
  const current = snapshotConfigFile(target, pathOpts)
  let bakBuf = null
  try { bakBuf = readFileSync(backupPath) } catch {
    throw new ConfigError('backup_not_found', '未找到备份文件：' + backupPath)
  }
  return {
    ok: true,
    contract: CONFIG_CONTRACT,
    path: target,
    backupPath,
    current: { exists: current.exists, size: current.size, sha256: current.sha256 },
    restore: { size: bakBuf.length, sha256: sha256Hex(bakBuf) },
    confirmToken: rollbackTokenFor(target, current.sha256, sha256Hex(bakBuf)),
    requiresConfirmation: true,
  }
}

export function rollbackConfigChange (opts = {}) {
  const plan = planRollback(opts)
  if (opts.expectedSha256 !== undefined && String(opts.expectedSha256) !== plan.current.sha256) {
    throw new ConfigError('concurrent_modification', '当前文件 sha256 与预期不一致（外部已修改），回滚中止。')
  }
  assertConfirm(opts.confirmToken, plan.confirmToken)
  const currentText = plan.current.exists ? readFileSync(plan.path, 'utf8') : ''
  const bakBuf = readFileSync(plan.backupPath)
  // 回滚前把"当前状态"另存一份，避免回滚本身成为不可逆操作。
  const safetyPath = plan.path + '.bak.pre-rollback'
  let fd = null
  try {
    fd = openSync(safetyPath, 'w', 0o600)
    writeSync(fd, Buffer.from(currentText, 'utf8'))
    fsyncSync(fd)
  } catch (e) {
    try { if (fd != null) closeSync(fd) } catch {}
    throw new ConfigError('backup_failed', '回滚前快照写入失败：' + (e && e.message ? e.message : '未知错误'))
  }
  try { closeSync(fd) } catch {}
  try { chmodSync(safetyPath, 0o600) } catch {}
  atomicWriteFile(plan.path, bakBuf.toString('utf8'), 0o600)
  const after = snapshotConfigFile(plan.path)
  if (after.sha256 !== plan.restore.sha256) {
    throw new ConfigError('verify_failed', '回滚后 sha256 校验失败；原状态已保存在 ' + safetyPath)
  }
  return {
    ok: true,
    contract: CONFIG_CONTRACT,
    path: plan.path,
    restoredFrom: plan.backupPath,
    safetyBackupPath: safetyPath,
    before: { sha256: plan.current.sha256 },
    after: { sha256: after.sha256 },
  }
}

export function describeConfigPolicy () {
  return {
    contract: CONFIG_CONTRACT,
    identity: 'D1-A 内置 openai 身份（保留官方登录）',
    ownedTopLevel: OWNED_TOP_LEVEL.slice(),
    ownedSections: Object.fromEntries(Object.entries(OWNED_SECTIONS).map(([k, v]) => [k, v.slice()])),
    reservedOverrideSections: RESERVED_OVERRIDE_SECTIONS.slice(),
    requiredBasename: 'config.toml',
    forbiddenBasenames: ['auth.json'],
    guarantees: [
      'atomic-tmp-fsync-rename',
      'sha256-and-size-preflight',
      'explicit-confirm-token',
      'bak-backup-and-rollback',
      'unmanaged-lines-byte-identical',
      'never-writes-auth-json',
      'never-restarts-client',
    ],
    preservedScopes: ['[mcp_servers.*]', '[projects.*]', 'approval_policy / sandbox / trust 权限段', '未知字段与注释'],
    notCovered: [
      '不重启/不重载正在运行的 Codex（配置在客户端下次启动或重载时生效）',
      '不做历史会话迁移（D6 只读）',
      '不写 auth.json、不管理官方登录凭据',
      '不生成 [model_providers.openai]（reserved built-in provider ID，会让客户端启动失败）',
    ],
  }
}

// —— D1-A 内置 openai 身份的声明式目标配置 ——
// openai_base_url 语义：客户端会向 {openai_base_url}/v1/models?client_version=… 与
// {openai_base_url}/v1/responses 发请求（E3 实测），因此这里给的是网关根地址（不带 /v1）。
export function normalizeGatewayBaseUrl (raw) {
  const s = String(raw || '').trim()
  if (!s) throw new ConfigError('invalid_desired', '必须提供网关 base URL。')
  let u
  try { u = new URL(s) } catch { throw new ConfigError('invalid_desired', '网关 base URL 不是合法 URL：' + s) }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ConfigError('invalid_desired', '网关 base URL 只支持 http/https。')
  let path = u.pathname.replace(/\/+$/, '')
  if (path.endsWith('/v1')) path = path.slice(0, -3)
  return u.origin + path
}

export function buildDesiredCodexConfig (opts = {}) {
  const origin = normalizeGatewayBaseUrl(opts.openaiBaseUrl || opts.gatewayBaseUrl)
  const model = String(opts.model || '').trim()
  if (!model) throw new ConfigError('invalid_desired', '必须提供聚合模型名（model）。')
  const catalog = String(opts.modelCatalogJsonPath || '').trim()
  const topLevel = { model_provider: 'openai', openai_base_url: origin, model }
  if (catalog) topLevel.model_catalog_json = catalog
  const desired = { topLevel }
  if (opts.features && typeof opts.features === 'object') desired.sections = { features: opts.features }
  return {
    desired,
    openaiBaseUrl: origin,
    catalogPath: catalog || null,
    risks: [
      'D1-A：沿用内置 openai 身份（model_provider="openai"）+ 官方登录；客户端版本/账号能力必须真实验证，未验证前不得宣称已兼容。',
      'Codex 0.167 把 openai 列为 reserved built-in provider ID：不要写 [model_providers.openai]，那会让客户端直接启动失败；改向只经顶层 openai_base_url。',
      '官方身份下客户端会先 GET {openai_base_url}/v1/models?client_version=…；目录缺失/不完整时告警并回落 fallback metadata（上下文与工具能力退化）。',
      '客户端会先尝试 WebSocket GET /v1/responses（upgrade），失败后回落 POST；请求体 content-encoding 可能是 zstd。网关侧必须能承受这两点，否则表现为连接失败而不是模型错误。',
      '走官方身份时客户端会带真实 ChatGPT Bearer 与 chatgpt-account-id 打到网关：这些标识只能留在受支持的官方路径，第三方上游一律不得接收（E1 身份隔离）。',
      '写入不重启 Codex：配置在下次启动或重载时生效，运行中的会话仍使用旧配置。',
      'auth.json 永不由本模块写入；回滚用 config.toml.bak。',
    ],
  }
}
