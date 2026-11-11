// E7：Codex 历史会话的**只读**诊断与迁移预演。
//
// 边界（与 D6 契约一致）：
//  · 只读：绝不写、绝不改 mtime、绝不删除历史文件；实际写入接口抛 not_authorized。
//  · 显式输入：sessions 根目录必须由调用方传入；本模块不读取 ~/.codex、不联网。
//  · 脱敏：只输出计数、模型 slug、provider、相对路径、sha256、风险 code；
//    绝不输出消息正文、工具参数、密文或凭据。
//  · 不解密：遇到 encrypted_content / encrypted_task_id 一律判 unreadable，不尝试解码。
//
// 参考实现（不改动）：src/native-usage.js 的 JSONL 读取/上限策略。
// 证据与 wire 形状：docs/explanation/codex-v2-agents.md。

import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { basename, join, relative, resolve } from 'node:path'

export const HISTORY_DIAGNOSIS_VERSION = 1
export const HISTORY_WRITE_NOT_AUTHORIZED = 'not_authorized'

const MAX_FILES = 2000
const MAX_TOTAL_BYTES = 128 * 1024 * 1024
const MAX_LINE_BYTES = 2 * 1024 * 1024
const MAX_LINES_PER_FILE = 400000

const TOOL_CALL_TYPES = new Set([
  'function_call', 'custom_tool_call', 'local_shell_call', 'web_search_call',
  'mcp_tool_call', 'computer_call', 'tool_call',
])
const TOOL_OUTPUT_TYPES = new Set(['function_call_output', 'custom_tool_call_output'])
const TOOL_MARKER_RE = /(unsupported|unknown)\s+(call|tool)|tool_not_found|unknown_tool/i

// 只判定"存在不透明字段"，不取值、不解码；嵌套的 arguments/output JSON 字符串会再解析一层。
function scanOpaqueKeys(value, found, depth) {
  if (depth > 8 || value == null) return found
  if (Array.isArray(value)) { for (const v of value) scanOpaqueKeys(v, found, depth + 1); return found }
  if (typeof value !== 'object') return found
  for (const key of Object.keys(value)) {
    if (key === 'encrypted_content') found.content = true
    else if (key === 'encrypted_task_id') found.taskId = true
    if (found.content && found.taskId) return found
    scanOpaqueKeys(value[key], found, depth + 1)
    if (found.content && found.taskId) return found
  }
  return found
}
function parseJsonMaybe(text) {
  if (typeof text !== 'string' || text === '') return undefined
  try { return JSON.parse(text) } catch { return undefined }
}

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v) }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0 }

// catalog 兼容：数组 slug、{slugs}、{models:[{slug}|string]}、Codex ModelsResponse {data:[{id|slug}]}
export function normalizeCatalog(catalog) {
  const out = new Set()
  const push = (v) => {
    if (typeof v === 'string' && v.trim()) { out.add(v.trim()); return }
    if (isPlainObject(v)) {
      const s = v.slug || v.id || v.model
      if (typeof s === 'string' && s.trim()) out.add(s.trim())
    }
  }
  if (Array.isArray(catalog)) { for (const v of catalog) push(v); return out }
  if (!isPlainObject(catalog)) return out
  if (Array.isArray(catalog.slugs)) for (const v of catalog.slugs) push(v)
  if (Array.isArray(catalog.models)) for (const v of catalog.models) push(v)
  if (Array.isArray(catalog.data)) for (const v of catalog.data) push(v)
  return out
}

async function listSessionFiles(dir) {
  const out = []
  let visited = 0
  async function walk(d) {
    if (out.length >= MAX_FILES || visited > 5000) return
    let entries
    try { entries = await readdir(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (out.length >= MAX_FILES || visited > 5000) return
      if (e.isSymbolicLink()) continue
      const p = join(d, e.name)
      if (e.isDirectory()) { visited += 1; await walk(p); continue }
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue
      try {
        const st = await stat(p)
        out.push({ path: p, size: st.size, mtime: st.mtimeMs })
      } catch { /* 不可读文件跳过（仍属只读） */ }
    }
  }
  await walk(dir)
  out.sort((a, b) => a.path.localeCompare(b.path))
  return out
}

function emptySession(file, root) {
  return {
    relPath: relative(root, file.path).split('\\').join('/'),
    sha256: '',
    size: file.size,
    mtime: file.mtime,
    sessionId: '',
    provider: 'unknown',
    models: new Map(),
    turns: 0,
    toolCalls: 0,
    toolOutputs: 0,
    toolRiskItems: 0,
    unpairedToolCalls: 0,
    encryptedItems: 0,
    encryptedTaskIds: 0,
    agentMessages: 0,
    _callIds: new Set(),
    _outputIds: new Set(),
    parseErrors: 0,
    lines: 0,
    truncated: false,
  }
}

function sessionRow(s) {
  const models = [...s.models.entries()].map(([model, turns]) => ({ model, turns })).sort((a, b) => b.turns - a.turns || a.model.localeCompare(b.model))
  const unreadable = s.encryptedItems > 0
  const risks = []
  if (unreadable) risks.push('v2_encrypted_unreadable')
  if (s.toolRiskItems > 0) risks.push('tool_replay_marker')
  if (s.unpairedToolCalls > 0) risks.push('tool_call_unpaired')
  return {
    relPath: s.relPath,
    sha256: s.sha256,
    size: s.size,
    sessionId: s.sessionId,
    provider: s.provider,
    models,
    turns: s.turns,
    toolCalls: s.toolCalls,
    toolOutputs: s.toolOutputs,
    toolRiskItems: s.toolRiskItems,
    unpairedToolCalls: s.unpairedToolCalls,
    v2: {
      encryptedItems: s.encryptedItems,
      encryptedTaskIds: s.encryptedTaskIds,
      agentMessages: s.agentMessages,
      unreadable,
      recoverable: false,
      reason: unreadable ? 'encrypted_content_opaque' : '',
    },
    risks,
  }
}

async function scanSessionFile(file, root, acc) {
  const s = emptySession(file, root)
  const hash = createHash('sha256')
  const rs = createReadStream(file.path, { encoding: null })
  const closed = new Promise((r) => rs.once('close', r))
  rs.on('data', (chunk) => hash.update(chunk))
  const rl = createInterface({ input: rs, crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      s.lines += 1
      if (s.lines > MAX_LINES_PER_FILE) { s.truncated = true; break }
      if (line.length > MAX_LINE_BYTES) continue
      // 只解析可能相关的行；其余行完全不进入内存/输出。
      if (line.indexOf('session_meta') === -1 && line.indexOf('turn_context') === -1 &&
          line.indexOf('_call') === -1 && line.indexOf('tool_call') === -1 &&
          line.indexOf('encrypted_') === -1 && line.indexOf('agent_message') === -1) continue
      let o
      try { o = JSON.parse(line) } catch { s.parseErrors += 1; continue }
      if (!isPlainObject(o)) continue
      const payload = isPlainObject(o.payload) ? o.payload : null
      if (!payload) continue
      const ptype = typeof payload.type === 'string' ? payload.type : ''

      if (o.type === 'session_meta') {
        if (typeof payload.session_id === 'string' && payload.session_id) s.sessionId = payload.session_id
        if (typeof payload.model_provider === 'string' && payload.model_provider) s.provider = payload.model_provider
        continue
      }
      if (o.type === 'turn_context') {
        const model = typeof payload.model === 'string' && payload.model ? payload.model : 'unknown'
        s.turns += 1
        s.models.set(model, (s.models.get(model) || 0) + 1)
        continue
      }

      // 加密/代理间消息：只计数，绝不保存内容。
      const opaque = scanOpaqueKeys(payload, { content: false, taskId: false }, 0)
      if (!opaque.content && !opaque.taskId) {
        // v2 工具的 encrypted_task_id 常在 arguments/output 的 JSON 字符串里。
        scanOpaqueKeys(parseJsonMaybe(payload.arguments), opaque, 1)
        scanOpaqueKeys(parseJsonMaybe(payload.output), opaque, 1)
      }
      if (opaque.content || opaque.taskId) {
        s.encryptedItems += 1
        if (opaque.taskId) s.encryptedTaskIds += 1
      }
      if (ptype === 'agent_message') s.agentMessages += 1

      // 工具调用/结果：只计数与标记，不保存 name/arguments/output。
      if (TOOL_CALL_TYPES.has(ptype)) {
        s.toolCalls += 1
        if (typeof payload.call_id === 'string' && payload.call_id) s._callIds.add(payload.call_id)
        if (TOOL_MARKER_RE.test(line)) s.toolRiskItems += 1
      } else if (TOOL_OUTPUT_TYPES.has(ptype)) {
        s.toolOutputs += 1
        if (typeof payload.call_id === 'string' && payload.call_id) s._outputIds.add(payload.call_id)
        if (TOOL_MARKER_RE.test(line)) s.toolRiskItems += 1
      }
    }
  } finally {
    rl.close()
  }
  // 必须等流关闭后再 digest：否则尾部 chunk 可能还没进入 hash。
  await closed
  s.sha256 = hash.digest('hex')
  for (const id of s._callIds) if (!s._outputIds.has(id)) s.unpairedToolCalls += 1
  acc.sessions += 1
  acc.files += 1
  acc.bytes += file.size
  acc.parseErrors += s.parseErrors
  if (s.truncated) acc.truncated = true
  return s
}

function emptyReport(opts) {
  return {
    version: HISTORY_DIAGNOSIS_VERSION,
    generatedAt: Number.isFinite(opts && opts.now) ? opts.now : Date.now(),
    enabled: false,
    source: 'codex-sessions',
    readOnly: true,
    dirLabel: '',
    catalogProvided: false,
    scanned: { files: 0, sessions: 0, bytes: 0, parseErrors: 0, truncated: false },
    summary: null,
    sessions: [],
    notes: [],
  }
}

/**
 * 只读诊断 Codex sessions 目录。
 * opts: { sessionsDir, catalog?, label?, now?, includeSessions? }
 *  · sessionsDir 必填（显式传入）；不会默认 ~/.codex。
 *  · catalog 用于计算 missingModels（数组/Codex ModelsResponse 均可）。
 *  · 返回 JSON 可序列化对象，不含消息正文/参数/密文/凭据。
 */
export async function diagnoseHistory(opts = {}) {
  const report = emptyReport(opts)
  const rawDir = typeof opts.sessionsDir === 'string' ? opts.sessionsDir.trim() : ''
  if (!rawDir) {
    report.error = '未提供 sessions 目录：必须显式传入（本模块绝不默认读取 ~/.codex）'
    report.notes.push('只读诊断需要显式 sessionsDir；未启用时不做任何文件访问。')
    return report
  }
  const root = resolve(rawDir)
  report.dirLabel = typeof opts.label === 'string' && opts.label ? opts.label : basename(root)
  const catalog = normalizeCatalog(opts.catalog)
  report.catalogProvided = catalog.size > 0 || Array.isArray(opts.catalog) || isPlainObject(opts.catalog)
  if (!existsSync(root)) {
    report.error = '目录不存在或不可读'
    return report
  }
  report.enabled = true

  const files = await listSessionFiles(root)
  const acc = { files: 0, sessions: 0, bytes: 0, parseErrors: 0, truncated: false }
  const rows = []
  let totalTurns = 0, totalToolCalls = 0, totalEncrypted = 0, totalAgentMessages = 0
  const byProvider = new Map()
  const byModel = new Map()
  const missingModels = new Set()
  const sessionsWithMissingModel = new Set()
  let sessionsWithToolRisk = 0
  let sessionsWithEncrypted = 0

  for (const f of files) {
    if (acc.bytes >= MAX_TOTAL_BYTES) { acc.truncated = true; break }
    let s
    try { s = await scanSessionFile(f, root, acc) } catch { acc.parseErrors += 1; continue }
    rows.push(s)
    totalTurns += s.turns
    totalToolCalls += s.toolCalls
    totalEncrypted += s.encryptedItems
    totalAgentMessages += s.agentMessages
    if (s.encryptedItems > 0) sessionsWithEncrypted += 1
    if (s.toolRiskItems > 0 || s.unpairedToolCalls > 0) sessionsWithToolRisk += 1

    const p = byProvider.get(s.provider) || { provider: s.provider, sessions: 0, turns: 0, models: new Map() }
    p.sessions += 1
    p.turns += s.turns
    for (const [model, turns] of s.models) p.models.set(model, (p.models.get(model) || 0) + turns)
    byProvider.set(s.provider, p)

    for (const [model, turns] of s.models) {
      const m = byModel.get(model) || { model, providers: new Set(), sessions: 0, turns: 0 }
      m.providers.add(s.provider)
      m.sessions += 1
      m.turns += turns
      byModel.set(model, m)
      if (report.catalogProvided && !catalog.has(model)) {
        missingModels.add(model)
        sessionsWithMissingModel.add(s.sessionId || s.relPath)
      }
    }
  }

  const sessionRows = rows.map((s) => {
    const row = sessionRow(s)
    const perSessionMissing = report.catalogProvided ? row.models.map((m) => m.model).filter((m) => !catalog.has(m)) : []
    if (perSessionMissing.length) row.risks.push(...perSessionMissing.map((m) => 'missing_model:' + m))
    return row
  })
  if (opts.includeSessions === false) report.sessions = []
  else report.sessions = sessionRows

  report.scanned = { files: acc.files, sessions: acc.sessions, bytes: acc.bytes, parseErrors: acc.parseErrors, truncated: acc.truncated }
  report.summary = {
    sessions: acc.sessions,
    totals: {
      files: acc.files,
      bytes: acc.bytes,
      turns: totalTurns,
      toolCalls: totalToolCalls,
      encryptedItems: totalEncrypted,
      agentMessages: totalAgentMessages,
    },
    byProvider: [...byProvider.values()].map((p) => ({
      provider: p.provider,
      sessions: p.sessions,
      turns: p.turns,
      models: [...p.models.entries()].map(([model, turns]) => ({ model, turns })).sort((a, b) => b.turns - a.turns || a.model.localeCompare(b.model)),
    })).sort((a, b) => b.sessions - a.sessions || a.provider.localeCompare(b.provider)),
    byModel: [...byModel.values()].map((m) => ({
      model: m.model,
      providers: [...m.providers].sort(),
      sessions: m.sessions,
      turns: m.turns,
      inCatalog: !report.catalogProvided || catalog.has(m.model),
    })).sort((a, b) => b.turns - a.turns || a.model.localeCompare(b.model)),
    unreadableEncrypted: { sessions: sessionsWithEncrypted, items: totalEncrypted },
    missingModels: [...missingModels].sort(),
    risks: {
      missingModels: { models: [...missingModels].sort(), sessions: sessionsWithMissingModel.size },
      toolReplay: {
        items: rows.reduce((a, s) => a + s.toolRiskItems, 0),
        sessions: sessionsWithToolRisk,
        unpairedCalls: rows.reduce((a, s) => a + s.unpairedToolCalls, 0),
      },
      encryptedUnreadable: { sessions: sessionsWithEncrypted, items: totalEncrypted },
    },
  }
  report.notes.push('只读诊断：未修改任何历史文件；不含消息正文、工具参数或密文。')
  if (!report.catalogProvided) report.notes.push('未提供 catalog：missingModels 未计算（catalogProvided=false）。')
  if (sessionsWithEncrypted > 0) report.notes.push('检测到 v2 加密历史：按不可读处理，网关不解密、不伪造、不删除。')
  if (acc.truncated) report.notes.push('扫描达到上限（文件数/字节/行数），结果可能不完整。')
  return report
}

function notAuthorized(message) {
  const err = new Error(message || '历史写入未授权：E7 只做只读诊断，写入能力未实现')
  err.code = HISTORY_WRITE_NOT_AUTHORIZED
  return err
}

function stamp(now) {
  const d = new Date(Number.isFinite(now) ? now : Date.now())
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
}

/**
 * 迁移预演（只读）：返回将改哪些文件/字段、文件 sha256 与备份建议。
 * selection: { sessions?: [sessionId|relPath], relPaths?: [], all?: boolean, target?: {provider?, model?}, apply?: boolean }
 *  · apply:true 直接抛 not_authorized（写入未实现）。
 * opts: { sessionsDir?, catalog?, diagnosis?, now? }
 */
export async function planSelectiveMigration(selection = {}, opts = {}) {
  if (isPlainObject(selection) && selection.apply === true) throw notAuthorized('迁移写入未授权：planSelectiveMigration 只做只读预演')
  const sel = Array.isArray(selection) ? { sessions: selection } : (isPlainObject(selection) ? selection : {})
  const diag = opts.diagnosis || await diagnoseHistory({ sessionsDir: opts.sessionsDir, catalog: opts.catalog, now: opts.now })
  const now = Number.isFinite(opts.now) ? opts.now : Date.now()
  const plan = {
    version: HISTORY_DIAGNOSIS_VERSION,
    generatedAt: now,
    dryRun: true,
    authorized: false,
    writeSupported: false,
    selection: { requested: [], matched: [], unmatched: [] },
    target: { provider: '', model: '' },
    changes: [],
    backup: { suggested: true, strategy: '复制原文件为 <file>.bak-<stamp> 并记录 sha256；写入用临时文件+rename；失败用备份恢复', files: [] },
    totals: { files: 0, bytes: 0 },
    warnings: [],
    note: '只读预演：不写入任何历史文件。真正迁移需逐条授权、备份与回滚演练（当前写入接口抛 not_authorized）。',
  }
  if (!diag || diag.enabled !== true) {
    plan.error = (diag && diag.error) || '无可用诊断结果：请显式提供 sessionsDir'
    return plan
  }
  const target = isPlainObject(sel.target) ? sel.target : {}
  plan.target = {
    provider: typeof sel.targetProvider === 'string' ? sel.targetProvider : (typeof target.provider === 'string' ? target.provider : ''),
    model: typeof sel.targetModel === 'string' ? sel.targetModel : (typeof target.model === 'string' ? target.model : ''),
  }
  const requested = []
  if (Array.isArray(sel.sessions)) requested.push(...sel.sessions.map(String))
  if (Array.isArray(sel.relPaths)) requested.push(...sel.relPaths.map(String))
  plan.selection.requested = requested
  const all = sel.all === true
  const wanted = new Set(requested)
  const rows = diag.sessions || []

  for (const row of rows) {
    const hit = all || wanted.has(row.sessionId) || wanted.has(row.relPath)
    if (!hit) continue
    const fields = []
    const models = (row.models || []).map((m) => m.model)
    if (plan.target.provider || !plan.target.model) {
      fields.push({ field: 'session_meta.payload.model_provider', from: row.provider, to: plan.target.provider || '' })
    }
    if (plan.target.model || !plan.target.provider) {
      fields.push({ field: 'turn_context.payload.model', from: models, to: plan.target.model || '' })
    }
    const backupPath = row.relPath + '.bak-' + stamp(now)
    plan.changes.push({
      relPath: row.relPath,
      sessionId: row.sessionId || '',
      sha256: row.sha256 || '',
      size: row.size || 0,
      target: { provider: plan.target.provider, model: plan.target.model },
      fields,
      backupSuggested: backupPath,
      writeMode: 'tmp+rename',
      requiresApproval: true,
    })
    plan.backup.files.push({ relPath: row.relPath, backupPath, sha256: row.sha256 || '' })
    plan.totals.files += 1
    plan.totals.bytes += row.size || 0
  }
  for (const req of requested) {
    if (!rows.some((r) => r.sessionId === req || r.relPath === req)) plan.selection.unmatched.push(req)
  }
  plan.selection.matched = plan.changes.map((c) => ({ relPath: c.relPath, sessionId: c.sessionId }))
  if (!plan.changes.length) plan.warnings.push('没有选中任何会话：selection 未匹配到历史文件')
  for (const c of plan.changes) if (c.sha256 === '') plan.warnings.push('缺少 sha256：无法在写入前校验文件未被外部修改（' + c.relPath + '）')
  if ((diag.summary && diag.summary.unreadableEncrypted.sessions) > 0) plan.warnings.push('诊断包含 v2 加密历史：迁移不能使密文可读，也不得删除/伪造密文')
  return plan
}

/** 写入接口：按 D6/E7 明确未授权；调用即抛 not_authorized，绝不落盘。 */
export async function applySelectiveMigration() {
  throw notAuthorized()
}
