const LEVELS = new Set(['debug', 'info', 'warn', 'error'])
const LINE_RE = /^\[([^\]]+)\]\s+\[([^\]]+)\]\s*(.*)$/

function decodeCursor(value) {
  if (!value) return 0
  try { const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8')); return Number.isSafeInteger(parsed.offset) && parsed.offset >= 0 ? parsed.offset : 0 } catch { return 0 }
}
function encodeCursor(offset) { return Buffer.from(JSON.stringify({ offset })).toString('base64url') }

export function structuredLogs(lines, events, query = {}) {
  const level = String(query.level || '').toLowerCase()
  const text = String(query.q || '').toLowerCase()
  const limit = Math.min(500, Math.max(1, Number(query.limit) || 100))
  const parsed = []
  for (const line of lines || []) {
    const match = LINE_RE.exec(String(line))
    if (!match) continue
    const item = { id: 'log:' + createHashStable(String(line)), timestamp: match[1], level: LEVELS.has(match[2]) ? match[2] : 'info', kind: 'log', message: match[3] }
    if (level && item.level !== level) continue
    if (text && !(item.message + ' ' + item.timestamp).toLowerCase().includes(text)) continue
    parsed.push(item)
  }
  for (const event of events?.items || []) {
    const at = event.at == null ? null : (Number.isFinite(Number(event.at)) ? Number(event.at) : null)
    const timestamp = at == null ? new Date().toISOString() : new Date(at).toISOString()
    const status = event.status == null ? null : (Number.isFinite(Number(event.status)) ? Number(event.status) : null)
    const eventLevel = String(event.level || (status >= 500 ? 'error' : (status >= 400 ? 'warn' : 'info'))).toLowerCase()
    const traceId = event.requestId || null
    const message = event.code || event.type || event.terminal || 'gateway-event'
    const item = { id: 'observability:' + event.seq, timestamp, level: eventLevel, kind: event.kind || 'event', message, traceId }
    for (const field of ['terminal', 'status', 'model', 'provider', 'phase']) {
      if (event[field] != null) item[field] = event[field]
    }
    if (level && item.level !== level) continue
    const searchable = [item.message, item.timestamp, item.traceId, item.kind, item.terminal, item.status, item.model, item.provider, item.phase].join(' ').toLowerCase()
    if (text && !searchable.includes(text)) continue
    parsed.push(item)
  }
  parsed.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)) || a.id.localeCompare(b.id))
  const offset = decodeCursor(query.cursor)
  const page = parsed.slice(offset, offset + limit)
  return { contract: 'mg-logs/1', items: page, nextCursor: offset + page.length < parsed.length ? encodeCursor(offset + page.length) : null, hasMore: offset + page.length < parsed.length, retained: { matched: parsed.length, sourceLines: (lines || []).length, sourceEvents: (events?.items || []).length, eventCapacity: events?.retained?.capacity ?? events?.retained?.maxRecords ?? 0, eventRetained: events?.retained || null, durable: events?.durable || null } }
}

function createHashStable(value) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index++) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 16777619) }
  return (hash >>> 0).toString(16)
}
