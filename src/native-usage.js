// Read-only native/direct usage from Codex session JSONL logs.
// Never reads message content: only session_meta (provider/id), turn_context (model),
// and token_count events (usage counters). Config is opt-in via defaults.nativeUsageDir
// or MG_NATIVE_USAGE_DIR; "off"/empty disables.
import { createReadStream, existsSync, statSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const MAX_FILES = 1200
const MAX_TOTAL_BYTES = 96 * 1024 * 1024
const MAX_LINE_BYTES = 2 * 1024 * 1024
const CACHE_TTL_MS = 20000
const USAGE_FIELDS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens']

let cache = { key: '', at: 0, value: null }

function expandDir(raw) {
  const s = String(raw || '').trim()
  if (!s) return ''
  if (s === 'off' || s === 'false') return ''
  if (s === '~') return homedir()
  if (s.startsWith('~/')) return join(homedir(), s.slice(2))
  return resolve(s)
}

export function nativeUsageConfig(cfg) {
  const raw = String(process.env.MG_NATIVE_USAGE_DIR || (cfg && cfg.defaults && cfg.defaults.nativeUsageDir) || '').trim()
  const dir = expandDir(raw)
  return { enabled: !!dir, dir, label: raw || '' }
}

function dateKey(ts) {
  const d = new Date(ts)
  if (!Number.isFinite(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}
function emptyTotals() {
  return { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0, turns: 0 }
}
function addUsage(target, usage) {
  target.inputTokens += Number(usage.input_tokens) || 0
  target.cachedInputTokens += Number(usage.cached_input_tokens) || 0
  target.cacheWriteTokens += Number(usage.cache_write_input_tokens) || 0
  target.outputTokens += Number(usage.output_tokens) || 0
  target.reasoningOutputTokens += Number(usage.reasoning_output_tokens) || 0
  target.totalTokens += Number(usage.total_tokens) || 0
  target.turns += 1
}

async function listSessionFiles(dir, cutoff) {
  const out = []
  let visited = 0
  async function walk(d) {
    if (out.length >= MAX_FILES || visited > 5000) return
    let entries
    try { entries = await readdir(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (out.length >= MAX_FILES || visited > 5000) return
      const p = join(d, e.name)
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) { visited += 1; await walk(p); continue }
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue
      try {
        const st = await stat(p)
        // Sessions can span days; keep files touched since the cutoff plus one day.
        if (st.mtimeMs >= cutoff - 86400000) out.push({ path: p, size: st.size, mtime: st.mtimeMs })
      } catch {}
    }
  }
  await walk(dir)
  out.sort((a, b) => b.mtime - a.mtime)
  return out
}

async function parseSession(file, cutoff, acc) {
  let provider = ''
  let model = ''
  let sessionId = ''
  let lines = 0
  let tokenEvents = 0
  const rl = createInterface({ input: createReadStream(file.path, { encoding: 'utf8' }), crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      lines += 1
      if (lines > 400000) break
      if (line.length > MAX_LINE_BYTES) continue
      if (line.indexOf('"token_count"') === -1 && line.indexOf('"session_meta"') === -1 && line.indexOf('"turn_context"') === -1) continue
      let o
      try { o = JSON.parse(line) } catch { acc.parseErrors += 1; continue }
      const payload = o && o.payload
      if (!payload || typeof payload !== 'object') continue
      if (o.type === 'session_meta') {
        if (typeof payload.model_provider === 'string') provider = payload.model_provider
        if (typeof payload.session_id === 'string') sessionId = payload.session_id
        continue
      }
      if (o.type === 'turn_context') {
        if (typeof payload.model === 'string' && payload.model) model = payload.model
        continue
      }
      if (payload.type !== 'token_count') continue
      const ts = Date.parse(o.timestamp || '')
      if (!Number.isFinite(ts) || ts < cutoff) continue
      const usage = payload.info && (payload.info.last_token_usage || payload.info.total_token_usage)
      if (!usage || typeof usage !== 'object') continue
      tokenEvents += 1
      const day = dateKey(ts)
      const dayRow = acc.byDay.get(day) || emptyTotals()
      addUsage(dayRow, usage)
      acc.byDay.set(day, dayRow)
      const key = (provider || 'unknown') + '\u0000' + (model || 'unknown')
      const mRow = acc.byModel.get(key) || Object.assign(emptyTotals(), { provider: provider || 'unknown', model: model || 'unknown' })
      addUsage(mRow, usage)
      acc.byModel.set(key, mRow)
      addUsage(acc.totals, usage)
    }
  } finally {
    rl.close()
  }
  acc.sessions += 1
  acc.bytes += file.size
  if (sessionId) acc.sessionIds.add(sessionId)
  return tokenEvents
}

export async function readNativeUsage(cfg, days = 7, now = Date.now()) {
  const conf = nativeUsageConfig(cfg)
  const safeDays = Math.min(90, Math.max(1, Number(days) || 7))
  if (!conf.enabled) {
    return {
      enabled: false,
      source: 'codex-sessions',
      days: safeDays,
      dirLabel: '',
      note: '未启用原生/直连用量采集。在设置中填写 Codex sessions 目录（如 ~/.codex/sessions）后只读汇总，不读取消息内容。',
      totals: emptyTotals(), byDay: [], byModel: [],
    }
  }
  const key = conf.dir + '|' + safeDays
  if (cache.value && cache.key === key && now - cache.at < CACHE_TTL_MS) return cache.value
  const cutoff = now - safeDays * 86400000
  const base = {
    enabled: true,
    source: 'codex-sessions',
    days: safeDays,
    dirLabel: conf.label || conf.dir,
    generatedAt: now,
    scanned: { files: 0, sessions: 0, bytes: 0, parseErrors: 0 },
    totals: emptyTotals(),
    byDay: [],
    byModel: [],
    note: '只读采集 Codex 本地会话日志中的 token 计数；不读取消息内容，也不代表经过网关的代理流量。',
  }
  if (!existsSync(conf.dir)) return Object.assign(base, { error: '目录不存在或不可读' })
  const files = await listSessionFiles(conf.dir, cutoff)
  const acc = { sessions: 0, bytes: 0, parseErrors: 0, totals: emptyTotals(), byDay: new Map(), byModel: new Map(), sessionIds: new Set() }
  for (const f of files) {
    if (acc.bytes >= MAX_TOTAL_BYTES) break
    try { await parseSession(f, cutoff, acc) } catch { acc.parseErrors += 1 }
  }
  const byDay = [...acc.byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, v]) => Object.assign({ date }, v))
  const byModel = [...acc.byModel.entries()].map(([, v]) => v).sort((a, b) => b.totalTokens - a.totalTokens)
  const value = Object.assign(base, {
    scanned: { files: files.length, sessions: acc.sessions, bytes: acc.bytes, parseErrors: acc.parseErrors },
    totals: acc.totals,
    byDay,
    byModel,
  })
  cache = { key, at: now, value }
  return value
}

export function __clearNativeUsageCache() { cache = { key: '', at: 0, value: null } }
