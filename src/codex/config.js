// Codex config.toml 受控写入（E6 / D5：受控自动管理）。
//
// 契约（与 docs/reference/codex-config.md 一致）：
//  * 只改"声明所有权"的字段：顶层 model_provider / openai_base_url / model / model_catalog_json，
//    [features] 的白名单键（multi_agent / multi_agent_v2），以及原生子代理段
//    [agents.go_deepseek]（MG-FIX-P1-05）。
//  * 绝不生成或改写 [model_providers.openai]：Codex 0.167 把 openai 列为 reserved built-in
//    provider ID，覆盖它会让客户端直接启动失败（E3 实测）。发现已有该段时只告警、不动它。
//  * 其余行（未知字段、MCP、projects、权限、注释）逐字节保留；写前写后用
//    unmanagedFingerprint 断言"未被管理的行完全一致"，不等则 fail closed。
//  * 写前快照（size + sha256）→ 显式确认令牌 → 写入前再校验一次（缩小 TOCTOU 窗口）。
//  * tmp + fsync + rename 原子替换；旧内容存 .bak；写失败/校验失败自动用 .bak 恢复。
//  * 绝不读写 auth.json；绝不整文件覆盖；不读 HOME —— 所有函数只接受显式绝对路径，
//    便于服务端路由直接调用，也便于测试用临时目录 fixture。
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { GO_CLI_ALIAS, V2_TARGET_PUBLIC_ID, V2_TARGET_UPSTREAM_MODEL } from '../providers/opencode-go.js'

export const CONFIG_CONTRACT = 'mg-codex-config/1'
export const OWNED_TOP_LEVEL = Object.freeze(['model_provider', 'openai_base_url', 'model', 'model_catalog_json'])
// Codex 内置 provider 不可覆盖：0.167.0-alpha.3.2 实测任何 [model_providers.openai*] 都会让
// 配置加载失败（reserved built-in provider IDs）。能力声明只能落在 ModelGate 自有的 provider 段。
export const RESERVED_BUILTIN_PROVIDER_IDS = Object.freeze(['openai'])
export const MANAGED_PROVIDER_ID = 'modelgate'
// Provider 级原生压缩能力（A1 结论的落点）：
//   [model_providers.modelgate.capabilities]
//   remote_compaction = "unsupported"   # RemoteCompactionSupport 枚举，仅 unsupported | v2
// 该字面量由捆绑 Codex 0.167.0-alpha.3.2 的 serde 解析器实证（错误信息给出枚举候选），
// 不是猜测；requires_openai_auth 同样由该版本配置解析器接受。
export const REMOTE_COMPACTION_LITERALS = Object.freeze(['unsupported', 'v2'])
export const MANAGED_PROVIDER_SECTIONS = Object.freeze({
  'model_providers.modelgate': Object.freeze(['name', 'base_url', 'wire_api', 'requires_openai_auth', 'supports_websockets']),
  'model_providers.modelgate.capabilities': Object.freeze(['remote_compaction']),
})
// MG-FIX-P1-05：Codex 原生命名子代理（GPT 父 → Go DeepSeek 子）由 ModelGate 托管。
// 这两个键 + 子配置文件 go-deepseek.toml 一起纳入所有权：启用写入、退出字节兼容回滚；
// 用户自行改动时给 409 三方差异，绝不覆盖。不是自造 AgentTeam/MCP 调度，仍是 Codex 原生配置。
export const MANAGED_AGENT_SECTION = 'agents.go_deepseek'
export const MANAGED_AGENT_FILE = 'go-deepseek.toml'
export const MANAGED_AGENT_DESCRIPTION = 'OpenCode Go DeepSeek V4.1 Flash child agent (billing on OpenCode Go, separate from ChatGPT plan)'
// 真机取证（2026-11-16）：Go DeepSeek 拒绝 medium（Supported: low, high）。
// 产品接入路径与启动器路径统一用受支持的 high；旧托管文件（medium）由状态识别后允许升级。
export const MANAGED_AGENT_CHILD_EFFORT = 'high'
export const MANAGED_AGENT_SECTION_KEYS = Object.freeze(['description', 'config_file'])
// 只声明 ModelGate 自有段/键的白名单；其它 feature、其它 provider、其它 agent 一律视为外部所有。
export const OWNED_SECTIONS = Object.freeze({
  features: Object.freeze(['multi_agent', 'multi_agent_v2']),
  [MANAGED_AGENT_SECTION]: MANAGED_AGENT_SECTION_KEYS,
  'model_providers.modelgate': MANAGED_PROVIDER_SECTIONS['model_providers.modelgate'],
  'model_providers.modelgate.capabilities': MANAGED_PROVIDER_SECTIONS['model_providers.modelgate.capabilities'],
})
const OWNED_SECTION_NAMES = Object.keys(OWNED_SECTIONS)
// 这些段会让 Codex 启动失败（reserved built-in provider ID）：只检测、告警，绝不自动删改。
export const RESERVED_OVERRIDE_SECTIONS = Object.freeze(['model_providers.openai', 'model_providers.openai.capabilities'])
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
  let bst = null
  try { bst = lstatSync(bak) } catch {}
  if (bst && bst.isSymbolicLink()) throw new ConfigError('symlink_refused', '备份文件是符号链接，拒绝读取（fail closed）。')
  return bak
}

// —— 行级 TOML 子集解析（只做"按行段定位"，不做完整 TOML 语义）——
function splitLines (text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  return { eol, lines: text.split(eol) }
}

const HEADER_RE = /^\[\[?([^\[\]]+)\]\]?(?:[ \t]*#.*)?$/
const KEY_RE = /^([A-Za-z0-9_-]+)\s*=\s*([\s\S]*)$/

// 引号感知的行内注释切分：返回 [值部分, 注释部分(含 #，无则 '')]。
// 只识别单/双引号字符串外的 #；TOML 注释不得出现在字符串字面量内部。
function splitTrailingComment (text) {
  const s = String(text == null ? '' : text)
  let quote = null
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quote) {
      if (ch === '\\' && quote === '"') { i++; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === '#') return [s.slice(0, i), s.slice(i)]
  }
  return [s, '']
}

// 去掉字符串字面量后统计括号深度变化（多行数组/内联表续行判定用）。
function bracketDelta (line, open, close) {
  const stripped = String(line).replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '')
  let delta = 0
  for (const ch of stripped) {
    if (ch === open) delta++
    else if (ch === close) delta--
  }
  return delta
}

function isMultilineValue (value) {
  const v = splitTrailingComment(String(value || ''))[0].trim()
  if (v === '') return true
  if (v.startsWith('"""')) return (v.match(/"""/g) || []).length < 2
  if (v.startsWith("'''")) return (v.match(/'''/g) || []).length < 2
  if (v.startsWith('[')) return bracketDelta(v, '[', ']') > 0
  if (v.startsWith('{')) return bracketDelta(v, '{', '}') > 0
  return false
}

// 多行值的续行状态：opening 行之后直到闭合分隔符的所有行都是 continuation，
// 绝不被当作段头/键值改写（2026-11-16 审计 P1：多行字符串内的 `model = "…"` 曾被误改写）。
function openMultilineState (value) {
  const v = splitTrailingComment(String(value || ''))[0].trim()
  if (v.startsWith('"""') && (v.match(/"""/g) || []).length < 2) return { type: 'triple', delim: '"""' }
  if (v.startsWith("'''") && (v.match(/'''/g) || []).length < 2) return { type: 'triple', delim: "'''" }
  if (v.startsWith('[')) { const d = bracketDelta(v, '[', ']'); if (d > 0) return { type: 'bracket', depth: d } }
  if (v.startsWith('{')) { const d = bracketDelta(v, '{', '}'); if (d > 0) return { type: 'brace', depth: d } }
  return null
}

function multilineCloses (state, line) {
  if (state.type === 'triple') return String(line).includes(state.delim)
  if (state.type === 'bracket') { state.depth += bracketDelta(line, '[', ']'); return state.depth <= 0 }
  if (state.type === 'brace') { state.depth += bracketDelta(line, '{', '}'); return state.depth <= 0 }
  return true
}

export function parseConfigDocument (text) {
  const src = String(text == null ? '' : text)
  const { eol, lines } = splitLines(src)
  const meta = []
  const sections = []
  let current = { name: '', isArray: false, start: -1, end: -1 }
  let pendingMultiline = null
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const trimmed = raw.trim()
    if (pendingMultiline) {
      meta.push({ i, kind: 'continuation', raw, sectionName: current.name })
      if (multilineCloses(pendingMultiline, raw)) pendingMultiline = null
      continue
    }
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
    // 疑似段头但无法解析（如 `[features] 额外文本`）：fail-closed，绝不静默当普通行，
    // 否则合并会在文末追加重复段而指纹自检仍通过（2026-11-16 审计 P0）。
    if (trimmed.startsWith('[')) {
      throw new ConfigError('toml_header_unparseable', '第 ' + (i + 1) + ' 行疑似段头但无法解析（' + trimmed.slice(0, 60) + '）；拒绝自动改写，请手工修正。')
    }
    const kv = KEY_RE.exec(trimmed)
    if (kv) {
      const multiline = isMultilineValue(kv[2])
      meta.push({
        i,
        kind: 'entry',
        raw,
        sectionName: current.name,
        key: kv[1],
        value: kv[2],
        multiline,
      })
      if (multiline) pendingMultiline = openMultilineState(kv[2])
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
      // 保留原行的行内注释（owned 行替换不得丢用户注释，2026-11-16 审计 P2）。
      const comment = splitTrailingComment(doc.lines[idx])[1]
      const fullLine = comment ? line + ' ' + comment : line
      if (doc.lines[idx].trim() !== fullLine) {
        replacements.set(idx, withIndent(doc.lines[idx], fullLine))
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
        const comment = splitTrailingComment(doc.lines[idx])[1]
        const fullLine = comment ? line + ' ' + comment : line
        if (doc.lines[idx].trim() !== fullLine) {
          replacements.set(idx, withIndent(doc.lines[idx], fullLine))
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

export function atomicWriteFile (path, text, mode) {
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

// ---------------------------------------------------------------------------
// M4-1a：登记根 / 不透明备份 / 显式管理员确认令牌
// 管理面不再接受调用方给的任意路径与原始 TOML；只能引用服务端登记的不透明 id。
// 这些注册表是**进程内状态**：由受控启动流程（M4-1b）登记，浏览器无法创建/枚举路径。
// ---------------------------------------------------------------------------

export const CONFIG_ROOT_MODES = Object.freeze({ MANAGED: 'managed', READONLY: 'readonly' })
export const CONFIRM_TTL_MS = 5 * 60 * 1000
const ROOT_ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/
const BACKUP_ID_RE = /^bk_[a-f0-9]{32}$/
const configRoots = new Map()
const backupRecords = new Map()
const confirmations = new Map()

export function resetManagementStateForTest () {
  configRoots.clear()
  backupRecords.clear()
  confirmations.clear()
}

function generationOf (snapshot) {
  return snapshot && snapshot.exists ? String(snapshot.sha256) : 'absent'
}

// 登记根：登记时做一次基名校验/符号链接校验，并把父目录 realpath 固化；运行期只认 id。
export function registerConfigRoot (opts = {}) {
  const id = typeof opts.id === 'string' ? opts.id.trim() : ''
  if (!ROOT_ID_RE.test(id)) throw new ConfigError('invalid_root_id', '登记根 id 必须是 2-64 位小写字母/数字/._-（不透明引用，不接受路径）')
  const mode = opts.mode === undefined ? CONFIG_ROOT_MODES.READONLY : String(opts.mode)
  if (mode !== CONFIG_ROOT_MODES.MANAGED && mode !== CONFIG_ROOT_MODES.READONLY) {
    throw new ConfigError('invalid_root_mode', '登记根 mode 只能是 managed / readonly')
  }
  const target = assertConfigPath(opts.path)
  let realDir
  try { realDir = realpathSync(dirname(target)) } catch (e) {
    throw new ConfigError('root_unavailable', '登记根的父目录不存在或不可解析：' + (e && e.message ? e.message : '未知错误'))
  }
  const realPath = join(realDir, basename(target))
  let st = null
  try { st = lstatSync(realPath) } catch {}
  if (st && st.isSymbolicLink()) throw new ConfigError('symlink_refused', '登记根是符号链接，拒绝登记（fail closed）')
  const record = Object.freeze({ id, path: realPath, mode, registeredAt: Date.now() })
  configRoots.set(id, record)
  const generation = st && st.isFile() && st.size <= MAX_CONFIG_BYTES ? sha256Hex(readFileSync(realPath)) : (st && st.isFile() ? 'oversize' : 'absent')
  return { id, mode, generation }
}

export function resolveRegisteredRoot (id) {
  const key = typeof id === 'string' ? id.trim() : ''
  if (!ROOT_ID_RE.test(key)) throw new ConfigError('invalid_root_id', '配置登记根 id 不合法（必须使用服务端返回的不透明 id，不接受路径）')
  const record = configRoots.get(key)
  if (!record) throw new ConfigError('unknown_config_root', '未知的配置登记根：' + key + '（只能使用服务端登记后的不透明 id）')
  // 运行期再验一次：父目录 realpath 与目标都不是符号链接；被替换/搬走即 fail closed。
  let realDir
  try { realDir = realpathSync(dirname(record.path)) } catch {
    throw new ConfigError('root_changed', '配置登记根的父目录已不可解析：' + key)
  }
  if (join(realDir, basename(record.path)) !== record.path) {
    throw new ConfigError('root_changed', '配置登记根路径已变化（父目录 realpath 不一致）：' + key)
  }
  let st = null
  try { st = lstatSync(record.path) } catch {}
  if (st && st.isSymbolicLink()) throw new ConfigError('symlink_refused', '配置登记根在登记后变成了符号链接，拒绝访问：' + key)
  return { id: record.id, path: record.path, mode: record.mode }
}

export function listRegisteredRoots () {
  return [...configRoots.values()].map((r) => ({ id: r.id, mode: r.mode }))
}

function registerBackupRecord (rootId, backupPath, meta = {}) {
  const id = 'bk_' + randomBytes(16).toString('hex')
  const resolved = resolve(backupPath)
  backupRecords.set(id, Object.freeze({ id, rootId, path: resolved, sha256: meta.sha256 || null, generation: meta.generation || null, createdAt: Date.now() }))
  return id
}

export function resolveBackupRecord (rootId, backupId) {
  const key = typeof backupId === 'string' ? backupId.trim() : ''
  if (!BACKUP_ID_RE.test(key)) throw new ConfigError('invalid_backup_id', '备份必须使用服务端返回的不透明 backupId（不接受路径）')
  const record = backupRecords.get(key)
  if (!record) throw new ConfigError('backup_not_found', '未知或已过期的备份 id：' + key)
  if (record.rootId !== rootId) throw new ConfigError('backup_scope_mismatch', '备份 id 不属于该配置登记根，拒绝跨文件回滚')
  const root = resolveRegisteredRoot(rootId)
  assertBackupPath(root.path, record.path)
  return record
}

export function issueManagementConfirmation (opts = {}) {
  const operation = String(opts.operation || '')
  if (operation !== 'apply' && operation !== 'rollback') throw new ConfigError('invalid_operation', '确认令牌只用于 apply / rollback')
  const rootId = typeof opts.rootId === 'string' ? opts.rootId.trim() : ''
  const adminSubject = typeof opts.adminSubject === 'string' ? opts.adminSubject.trim() : ''
  if (!ROOT_ID_RE.test(rootId) || !adminSubject) throw new ConfigError('invalid_confirmation_binding', '确认令牌必须绑定登记根与显式管理员')
  const ttl = Number(opts.ttlMs === undefined ? CONFIRM_TTL_MS : opts.ttlMs)
  const now = Number(opts.now === undefined ? Date.now() : opts.now)
  for (const [tokenKey, rec] of confirmations) if (now > rec.expiresAt) confirmations.delete(tokenKey)
  const token = 'cf_' + randomBytes(24).toString('hex')
  const record = Object.freeze({
    token,
    operation,
    rootId,
    adminSubject,
    generation: String(opts.generation === undefined ? '' : opts.generation),
    beforeSha256: String(opts.beforeSha256 === undefined ? '' : opts.beforeSha256),
    afterSha256: String(opts.afterSha256 === undefined ? '' : opts.afterSha256),
    issuedAt: now,
    expiresAt: now + ttl,
  })
  confirmations.set(token, record)
  return { token, expiresAt: record.expiresAt, operation, rootId, generation: record.generation }
}

export function verifyManagementConfirmation (opts = {}) {
  const token = typeof opts.token === 'string' ? opts.token.trim() : ''
  if (!token) throw new ConfigError('confirmation_required', '缺少确认令牌：写入前必须先 plan 并回传 confirmToken')
  const record = confirmations.get(token)
  if (!record) throw new ConfigError('confirmation_required', '未知或已使用过的确认令牌：请重新 plan')
  const now = Number(opts.now === undefined ? Date.now() : opts.now)
  if (now > record.expiresAt) {
    confirmations.delete(token)
    throw new ConfigError('confirmation_expired', '确认令牌已过期：请重新 plan')
  }
  const mismatch = record.operation !== String(opts.operation || '') ||
    record.rootId !== String(opts.rootId || '') ||
    record.adminSubject !== String(opts.adminSubject || '') ||
    record.generation !== String(opts.generation === undefined ? '' : opts.generation) ||
    record.beforeSha256 !== String(opts.beforeSha256 === undefined ? '' : opts.beforeSha256) ||
    record.afterSha256 !== String(opts.afterSha256 === undefined ? '' : opts.afterSha256)
  if (mismatch) throw new ConfigError('confirmation_binding_mismatch', '确认令牌与本次文件/操作/管理员/代际不匹配（不可跨文件或跨操作复用）')
  if (opts.consume !== false) confirmations.delete(token)
  return record
}

// 敏感字段名（只用于把“值”替换成 <redacted>；绝不回显原文）。
export const SENSITIVE_FIELD_RE = /(api[_-]?key|token|secret|password|passwd|authorization|bearer|cookie|credential|env)/i
export function redactValue (field, value) {
  if (value === undefined || value === null || value === '') return ''
  if (SENSITIVE_FIELD_RE.test(String(field || ''))) return '<redacted>'
  return value
}

// 把 owned 字段的 TOML 原始 atom 转为归一化值（字符串去引号、布尔/数字还原）；仍受 redactValue 保护。
export function normalizeOwnedValue (entry) {
  if (!entry || !entry.present) return null
  const raw = String(entry.raw === undefined ? '' : entry.raw).trim()
  if (raw === '') return ''
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    try { return JSON.parse(raw) } catch { return raw.slice(1, -1) }
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1)
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw)
  return raw
}

export function publicOwnedProjection (owned) {
  const topLevel = {}
  for (const [key, entry] of Object.entries((owned && owned.topLevel) || {})) {
    const value = normalizeOwnedValue(entry)
    topLevel[key] = { present: !!entry.present, value: entry.present ? redactValue(key, value) : null, redacted: entry.present && SENSITIVE_FIELD_RE.test(key) }
  }
  const sections = {}
  for (const [name, sec] of Object.entries((owned && owned.sections) || {})) {
    sections[name] = { present: !!sec.present, keys: {} }
    for (const [key, entry] of Object.entries(sec.keys || {})) {
      const value = normalizeOwnedValue(entry)
      sections[name].keys[key] = { present: !!entry.present, value: entry.present ? redactValue(name + '.' + key, value) : null, redacted: entry.present && SENSITIVE_FIELD_RE.test(key) }
    }
  }
  return { topLevel, sections }
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
  if (expected.mtimeMs !== undefined && Number(expected.mtimeMs) !== Number(before.mtimeMs)) {
    throw new ConfigError('concurrent_modification', '目标文件 mtime 与快照不一致（外部已改动），已中止。')
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

// 写盘提交（预览 -> 校验 -> 二次快照 -> 备份 -> 原子写 -> 写后校验）；
// 供旧 path 级 API 与 M4-1a 的登记根 API 共用，避免两条实现漂移。
export function commitConfigPlan (plan, opts = {}) {
  const pathOpts = { allowNonStandardName: !!opts.allowNonStandardName }
  // 写入前再取一次快照：把 TOCTOU 窗口压到一次 stat+read（hash + size + mtime）。
  const recheck = snapshotConfigFile(plan.target, pathOpts)
  if (recheck.exists !== plan.before.exists || recheck.sha256 !== plan.before.sha256 ||
      recheck.size !== plan.before.size || recheck.mtimeMs !== plan.before.mtimeMs) {
    throw new ConfigError('concurrent_modification', '另一进程在预览后修改了 config.toml（sha256/大小/mtime 变化），已中止本次写入。')
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
    before: { exists: plan.before.exists, size: plan.before.size, sha256: plan.before.sha256, mtimeMs: plan.before.mtimeMs },
    after: { size: after.size, sha256: after.sha256, mtimeMs: after.mtimeMs },
    changed: plan.changed,
    warnings: plan.warnings,
    preserved: plan.preserved,
    createdSections: plan.createdSections,
    backupPath,
    confirmToken: plan.confirmToken,
  }
}

export function applyConfigChange (opts = {}) {
  const pathOpts = { allowNonStandardName: !!opts.allowNonStandardName }
  const plan = buildPlan(opts)
  assertExpected(plan.before, opts.expected)
  assertConfirm(opts.confirmToken, plan.confirmToken)
  return commitConfigPlan(plan, opts)
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

export function commitConfigRollback (plan) {
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
    after: { sha256: after.sha256, size: after.size, mtimeMs: after.mtimeMs },
  }
}

export function rollbackConfigChange (opts = {}) {
  const plan = planRollback(opts)
  if (opts.expectedSha256 !== undefined && String(opts.expectedSha256) !== plan.current.sha256) {
    throw new ConfigError('concurrent_modification', '当前文件 sha256 与预期不一致（外部已修改），回滚中止。')
  }
  assertConfirm(opts.confirmToken, plan.confirmToken)
  return commitConfigRollback(plan)
}

// —— M4-1a：登记根 + 显式管理员绑定的管理面操作（不透明 id，绝不接受路径/原始 TOML）——

function requireAdminSubject (adminSubject) {
  const subject = typeof adminSubject === 'string' ? adminSubject.trim() : ''
  if (!subject) throw new ConfigError('admin_subject_required', '受控写入必须绑定显式管理员身份（adminSubject）')
  return subject
}

function pathOptsForRoot () {
  return { allowNonStandardName: false }
}

export function planConfigForRoot (opts = {}) {
  const root = resolveRegisteredRoot(opts.rootId)
  const adminSubject = requireAdminSubject(opts.adminSubject)
  const plan = buildPlan({
    path: root.path,
    desired: opts.desired,
    expected: opts.expected,
    allowCreate: opts.allowCreate === true,
  })
  const generation = generationOf(plan.before)
  const confirmation = issueManagementConfirmation({
    operation: 'apply',
    rootId: root.id,
    adminSubject,
    generation,
    beforeSha256: plan.before.sha256,
    afterSha256: plan.after.sha256,
    now: opts.now,
    ttlMs: opts.ttlMs,
  })
  return {
    rootId: root.id,
    generation,
    before: plan.before,
    after: plan.after,
    existing: publicOwnedProjection(plan.existing),
    changed: plan.changed,
    warnings: plan.warnings,
    preserved: plan.preserved,
    createdSections: plan.createdSections,
    confirmToken: confirmation.token,
    expiresAt: confirmation.expiresAt,
    requiresConfirmation: true,
    wrote: false,
  }
}

export function applyConfigForRoot (opts = {}) {
  const root = resolveRegisteredRoot(opts.rootId)
  if (root.mode !== CONFIG_ROOT_MODES.MANAGED) {
    throw new ConfigError('write_disabled', '该登记根是只读模式（readonly）：apply 仅在受控自管 fixture（managed）中启用')
  }
  const adminSubject = requireAdminSubject(opts.adminSubject)
  const plan = buildPlan({
    path: root.path,
    desired: opts.desired,
    expected: opts.expected,
    allowCreate: opts.allowCreate === true,
  })
  const generation = generationOf(plan.before)
  verifyManagementConfirmation({
    token: opts.confirmToken,
    operation: 'apply',
    rootId: root.id,
    adminSubject,
    generation,
    beforeSha256: plan.before.sha256,
    afterSha256: plan.after.sha256,
    now: opts.now,
  })
  const result = commitConfigPlan(plan, pathOptsForRoot())
  const backupId = result.backupPath
    ? registerBackupRecord(root.id, result.backupPath, { sha256: plan.before.sha256, generation })
    : null
  return Object.assign({}, result, { rootId: root.id, generation, backupId })
}

export function planRollbackForRoot (opts = {}) {
  const root = resolveRegisteredRoot(opts.rootId)
  const adminSubject = requireAdminSubject(opts.adminSubject)
  const backup = resolveBackupRecord(root.id, opts.backupId)
  const plan = planRollback({ path: root.path, backupPath: backup.path })
  const generation = generationOf(plan.current)
  const confirmation = issueManagementConfirmation({
    operation: 'rollback',
    rootId: root.id,
    adminSubject,
    generation,
    beforeSha256: plan.current.sha256,
    afterSha256: plan.restore.sha256,
    now: opts.now,
    ttlMs: opts.ttlMs,
  })
  return {
    rootId: root.id,
    generation,
    backupId: backup.id,
    current: plan.current,
    restore: plan.restore,
    expectedSha256: plan.current.sha256,
    confirmToken: confirmation.token,
    expiresAt: confirmation.expiresAt,
    requiresConfirmation: true,
  }
}

export function rollbackConfigForRoot (opts = {}) {
  const root = resolveRegisteredRoot(opts.rootId)
  if (root.mode !== CONFIG_ROOT_MODES.MANAGED) {
    throw new ConfigError('write_disabled', '该登记根是只读模式（readonly）：rollback 仅在受控自管 fixture（managed）中启用')
  }
  const adminSubject = requireAdminSubject(opts.adminSubject)
  const backup = resolveBackupRecord(root.id, opts.backupId)
  const plan = planRollback({ path: root.path, backupPath: backup.path })
  const generation = generationOf(plan.current)
  if (opts.expectedSha256 !== undefined && String(opts.expectedSha256) !== plan.current.sha256) {
    throw new ConfigError('concurrent_modification', '当前文件 sha256 与预期不一致（外部已修改），回滚中止。')
  }
  verifyManagementConfirmation({
    token: opts.confirmToken,
    operation: 'rollback',
    rootId: root.id,
    adminSubject,
    generation,
    beforeSha256: plan.current.sha256,
    afterSha256: plan.restore.sha256,
    now: opts.now,
  })
  const result = commitConfigRollback(plan)
  const safetyBackupId = result.safetyBackupPath
    ? registerBackupRecord(root.id, result.safetyBackupPath, { generation })
    : null
  return Object.assign({}, result, { rootId: root.id, generation, backupId: backup.id, safetyBackupId })
}

// export 只回“声明所有权”的字段归一化投影；不含保留行/整文件/凭据。
export function exportOwnedFieldsForRoot (opts = {}) {
  const root = resolveRegisteredRoot(opts.rootId)
  let snapshot = null
  try { snapshot = snapshotConfigFile(root.path) } catch (e) {
    if (e && e.code === 'config_not_found') snapshot = { exists: false, sha256: '', size: 0, mtimeMs: 0 }
    else throw e
  }
  if (!snapshot.exists) {
    return {
      rootId: root.id,
      generation: 'absent',
      exists: false,
      owned: publicOwnedProjection(readOwnedFields('')),
    }
  }
  const text = readFileSync(root.path, 'utf8')
  if (Buffer.byteLength(text, 'utf8') > MAX_CONFIG_BYTES) throw new ConfigError('too_large', 'config.toml 超过 ' + MAX_CONFIG_BYTES + ' 字节，拒绝导出。')
  return {
    rootId: root.id,
    generation: sha256Hex(text),
    exists: true,
    owned: publicOwnedProjection(readOwnedFields(text)),
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

// Managed Provider 段（路由模式/聚合模式共用；回环信任、无客户端 Key）：
//   model_provider = "modelgate"
//   [model_providers.modelgate]
//     name = "ModelGate"
//     base_url = "http://127.0.0.1:<port>/v1"
//     wire_api = "responses"
//     requires_openai_auth = false
//     supports_websockets = false
//   [model_providers.modelgate.capabilities]
//     remote_compaction = "unsupported"
// 安全约束：绝不写 env_key / experimental_bearer_token / 任何字面量 token；
// 认证由本机回环信任承担（网关只监听 127.0.0.1，且由本机进程访问）。
// 该模式会切换 provider 身份，只能由调用方显式请求（mode=route/aggregated 或显式 managedProvider）。
export function buildManagedProviderSection (opts = {}) {
  const origin = normalizeGatewayBaseUrl(opts.openaiBaseUrl || opts.gatewayBaseUrl)
  const rawId = String(opts.providerId || MANAGED_PROVIDER_ID).trim()
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(rawId)) {
    throw new ConfigError('invalid_provider_id', 'provider id 只允许小写字母开头、字母/数字/_/-：' + rawId)
  }
  if (RESERVED_BUILTIN_PROVIDER_IDS.includes(rawId)) {
    throw new ConfigError('reserved_provider_id',
      'Codex 把 "' + rawId + '" 列为 reserved built-in provider ID：覆盖它会让客户端配置加载失败。' +
      'provider capability 不能写在 [model_providers.' + rawId + ']；请使用非内置的 ModelGate provider id。')
  }
  if (rawId !== MANAGED_PROVIDER_ID) {
    throw new ConfigError('unsupported_provider_id',
      '当前只声明 ' + MANAGED_PROVIDER_ID + ' 这一个自有 provider 段；收到 ' + rawId + '。新增 id 需要同步所有权声明与回滚测试。')
  }
  const remote = opts.remoteCompaction === undefined ? 'unsupported' : String(opts.remoteCompaction)
  if (!REMOTE_COMPACTION_LITERALS.includes(remote)) {
    throw new ConfigError('invalid_compaction_capability',
      'remote_compaction 只接受 ' + REMOTE_COMPACTION_LITERALS.join(' | ') + '（RemoteCompactionSupport 枚举）：' + remote)
  }
  const name = String(opts.name || 'ModelGate').trim() || 'ModelGate'
  const baseUrl = origin.replace(/\/+$/, '') + '/v1'
  return {
    providerId: rawId,
    remoteCompaction: remote,
    sections: {
      ['model_providers.' + rawId]: {
        name,
        base_url: baseUrl,
        wire_api: 'responses',
        requires_openai_auth: false,
        supports_websockets: false,
      },
      ['model_providers.' + rawId + '.capabilities']: {
        remote_compaction: remote,
      },
    },
  }
}

export function buildDesiredCodexConfig (opts = {}) {
  const origin = normalizeGatewayBaseUrl(opts.openaiBaseUrl || opts.gatewayBaseUrl)
  const model = String(opts.model || '').trim()
  if (!model) throw new ConfigError('invalid_desired', '必须提供聚合模型名（model）。')
  const catalog = String(opts.modelCatalogJsonPath || '').trim()
  const topLevel = { model_provider: 'openai', openai_base_url: origin, model }
  const sections = {}
  if (opts.features && typeof opts.features === 'object') sections.features = opts.features
  let managedProvider = null
  if (opts.managedProvider !== undefined && opts.managedProvider !== null) {
    if (typeof opts.managedProvider !== 'object' || Array.isArray(opts.managedProvider)) {
      throw new ConfigError('invalid_provider', 'managedProvider 必须是对象（{ id?, name?, remoteCompaction? }）。')
    }
    managedProvider = buildManagedProviderSection({
      openaiBaseUrl: origin,
      providerId: opts.managedProvider.id,
      name: opts.managedProvider.name,
      remoteCompaction: opts.managedProvider.remoteCompaction,
    })
    topLevel.model_provider = managedProvider.providerId
    // 自定义 provider 用自身的 base_url；移除内置 openai 的改向键，避免身份语义混淆。
    delete topLevel.openai_base_url
    Object.assign(sections, managedProvider.sections)
  }
  if (catalog) topLevel.model_catalog_json = catalog
  const desired = { topLevel }
  if (Object.keys(sections).length) desired.sections = sections
  return {
    desired,
    openaiBaseUrl: origin,
    catalogPath: catalog || null,
    providerMode: managedProvider ? 'managed-provider' : 'builtin-openai',
    providerId: managedProvider ? managedProvider.providerId : 'openai',
    remoteCompaction: managedProvider ? managedProvider.remoteCompaction : null,
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

// MG-FIX-P1-05：ModelGate 托管的原生子代理配置片段（纯函数，不写盘）。
// 设计要点：
//  * 这是 Codex 原生配置（[features] multi_agent + [agents.go_deepseek] + 子 toml），
//    不是第二套 AgentTeam/MCP 调度；父代理仍由 Codex 原生管理。
//  * 段内只允许 OWNED_SECTIONS 声明的键；子文件内容由 model + 固定 effort 确定性生成，
//    因此同一目标模型永远得到同一字节，可用于幂等比较与字节兼容回滚。
//  * model 来自聚合目标（Go 别名），绝不在产物里放任何凭据/token。
export function buildManagedAgentConfig (opts = {}) {
  const model = String(opts.model || '').trim()
  if (!model) throw new ConfigError('invalid_desired', '构建原生子代理配置必须提供目标模型 model。')
  const effort = String(opts.reasoningEffort || MANAGED_AGENT_CHILD_EFFORT).trim() || MANAGED_AGENT_CHILD_EFFORT
  const description = String(opts.description || MANAGED_AGENT_DESCRIPTION).trim() || MANAGED_AGENT_DESCRIPTION
  const configFile = MANAGED_AGENT_FILE
  let text = 'model = ' + JSON.stringify(model) + '\n' + 'model_reasoning_effort = ' + JSON.stringify(effort) + '\n'
  if (opts.gatewayBaseUrl && [V2_TARGET_PUBLIC_ID, GO_CLI_ALIAS, V2_TARGET_UPSTREAM_MODEL].includes(model)) {
    const baseUrl = normalizeGatewayBaseUrl(opts.gatewayBaseUrl) + '/v1'
    // A child inheriting the built-in OpenAI provider may send compaction_trigger.
    // Give the Go child its own provider so this setting cannot affect the parent.
    text += 'model_provider = "modelgate-go-child"\n\n' +
      '[model_providers.modelgate-go-child]\n' +
      'name = "ModelGate Go child"\n' +
      'base_url = ' + JSON.stringify(baseUrl) + '\n' +
      'wire_api = "responses"\n' +
      'requires_openai_auth = false\n' +
      'supports_websockets = false\n' +
      (opts.envKey ? 'env_key = ' + JSON.stringify(opts.envKey) + '\n' : '') +
      '\n[model_providers.modelgate-go-child.capabilities]\n' +
      'remote_compaction = "unsupported"\n'
  }
  return {
    sections: {
      features: { multi_agent: true },
      [MANAGED_AGENT_SECTION]: { description, config_file: configFile },
    },
    child: {
      fileName: configFile,
      text,
      model,
      reasoningEffort: effort,
    },
  }
}

// 把托管子代理片段合并进一个 desired（只补，不覆盖调用方显式传入的 features 键）。
// 显式 opts.managedAgent === false 可关闭；否则默认开启（普通用户路径零手工 TOML）。
// 父/子解耦：顶层 model 由 desired.topLevel.model 决定（父），子代理 ([agents.go_deepseek] +
// go-deepseek.toml) 用 opts.agentModel；未显式给出时回落到 opts.model，保持旧调用方语义不变。
export function withManagedAgentDesired (desired, opts = {}) {
  if (opts.managedAgent === false) return desired
  const childModel = String(opts.agentModel || opts.model || '').trim()
  if (!childModel) return desired
  const managed = buildManagedAgentConfig({ model: childModel, reasoningEffort: opts.agentReasoningEffort })
  const out = {
    topLevel: Object.assign({}, desired && desired.topLevel),
    sections: Object.assign({}, desired && desired.sections),
  }
  out.sections.features = Object.assign({ multi_agent: true }, out.sections.features || {})
  out.sections[MANAGED_AGENT_SECTION] = Object.assign({}, managed.sections[MANAGED_AGENT_SECTION], out.sections[MANAGED_AGENT_SECTION] || {})
  return out
}

// —— N01：客户端接入的只读模板 + 可观察 drift ——
// 只产出文本/结构化样例，**不写任何文件、不碰 auth.json、不改客户端配置**。
export const CLIENT_TEMPLATE_FORMAT = 'codex-toml-readonly/1'

export function exportClientTemplate (opts = {}) {
  const built = buildDesiredCodexConfig(opts)
  const profile = String(opts.profile || 'modelgate').trim() || 'modelgate'
  if (!/^[A-Za-z0-9._-]+$/.test(profile)) {
    throw new ConfigError('invalid_profile_name', 'profile 名只允许字母/数字/._-：' + profile)
  }
  const role = String(opts.role || 'mg-child').trim() || 'mg-child'
  const model = built.desired.topLevel.model
  const aliases = []
  for (const item of Array.isArray(opts.aliases) ? opts.aliases : []) {
    if (!item || typeof item !== 'object') continue
    const alias = String(item.alias == null ? '' : item.alias).trim()
    const target = String(item.model == null ? '' : item.model).trim()
    if (alias && target) aliases.push(Object.freeze({ alias, model: target }))
  }
  const lines = [
    '# ModelGate client template (read-only) — 由 exportClientTemplate 生成，不写入任何文件。',
    '# 用法：codex -p ' + profile + '（profile 文件由用户自行放到 $CODEX_HOME/' + profile + '.config.toml）',
    'model = ' + tomlValue(model),
    'model_provider = ' + tomlValue('openai'),
    'openai_base_url = ' + tomlValue(built.openaiBaseUrl),
  ]
  if (built.catalogPath) lines.push('model_catalog_json = ' + tomlValue(built.catalogPath))
  lines.push(
    '',
    '# 别名样例（仅说明网关侧声明；客户端可见 ID 以 /v1/models 目录为准）：',
  )
  if (aliases.length) for (const a of aliases) lines.push('# alias ' + a.alias + ' -> ' + a.model)
  else lines.push('# alias <alias> -> <model>（在网关 config/models[].alias 中声明）')
  lines.push(
    '',
    '# 显式角色样例（**不是** provider 切换）：Codex 0.167 的 child_config 从父 turn 复制 provider，',
    '# 角色覆盖白名单没有 model_provider —— 角色只能选 model，子代理仍走父会话的 provider。',
    '# 需要第三方上游请开独立会话/profile，不要把这里当成“原生同会话切模型”。',
    '# name = ' + tomlValue(role),
    '# description = ' + tomlValue('read-only sample; model-only override'),
    '# model = ' + tomlValue(model),
  )
  return Object.freeze({
    format: CLIENT_TEMPLATE_FORMAT,
    readOnly: true,
    writesFiles: false,
    profile,
    text: lines.join('\n') + '\n',
    samples: Object.freeze({
      profile: Object.freeze({ name: profile, topLevel: Object.freeze(Object.assign({}, built.desired.topLevel)) }),
      role: Object.freeze({
        name: role,
        fields: Object.freeze({ model }),
        providerOverride: 'unsupported',
        reason: 'codex-0.167-child-config-inherits-provider',
      }),
      aliases: Object.freeze(aliases),
    }),
    notes: Object.freeze([
      '只读模板：不写文件、不改 $CODEX_HOME、不创建 profile。',
      '角色样例只覆盖 model；provider 覆盖在当前锁定版本不受支持，不能替代独立会话。',
      'openai_base_url 指向网关根地址（不带 /v1）；auth.json 永不由本模块处理。',
    ]),
    risks: built.risks,
  })
}

// 可观察 drift：把「声明式期望」与「实际文件里被本模块拥有的字段」逐字段对比。
// 纯函数；返回值只含归一化字段（敏感字段已脱敏），不返回文件正文。
export function clientConfigDrift (opts = {}) {
  const built = opts.desired
    ? { desired: opts.desired }
    : buildDesiredCodexConfig(opts)
  const want = normalizeDesired(built.desired)
  const actualText = String(opts.actualText == null ? '' : opts.actualText)
  if (Buffer.byteLength(actualText, 'utf8') > MAX_CONFIG_BYTES) {
    throw new ConfigError('too_large', '实际 config.toml 超过 ' + MAX_CONFIG_BYTES + ' 字节，拒绝对比。')
  }
  const actual = readOwnedFields(actualText)
  const fields = []
  for (const [key, value] of Object.entries(want.topLevel)) {
    const expectedRaw = String(tomlValue(value))
    const entry = actual.topLevel[key]
    const actualRaw = entry && entry.present ? String(entry.raw).trim() : null
    if (actualRaw !== expectedRaw) {
      fields.push(Object.freeze({
        path: key,
        expected: redactValue(key, normalizeOwnedValue({ present: true, raw: expectedRaw })),
        actual: actualRaw === null ? null : redactValue(key, normalizeOwnedValue({ present: true, raw: actualRaw })),
      }))
    }
  }
  for (const [name, keys] of Object.entries(want.sections)) {
    for (const [key, value] of Object.entries(keys)) {
      const expectedRaw = String(tomlValue(value))
      const entry = actual.sections[name] && actual.sections[name].keys[key]
      const actualRaw = entry && entry.present ? String(entry.raw).trim() : null
      if (actualRaw !== expectedRaw) {
        fields.push(Object.freeze({
          path: name + '.' + key,
          expected: redactValue(name + '.' + key, normalizeOwnedValue({ present: true, raw: expectedRaw })),
          actual: actualRaw === null ? null : redactValue(name + '.' + key, normalizeOwnedValue({ present: true, raw: actualRaw })),
        }))
      }
    }
  }
  return Object.freeze({
    format: 'modelgate.client-config-drift/1',
    readOnly: true,
    drift: fields.length > 0,
    fields: Object.freeze(fields),
    actualFingerprint: sha256Hex(actualText),
    ownedSectionsPresent: Object.freeze(Object.entries(actual.sections).filter(([, s]) => s.present).map(([name]) => name)),
    preserved: actual.preserved,
  })
}

