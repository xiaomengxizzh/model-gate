const nf = new Intl.NumberFormat('zh-CN')
const cf = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 })

export const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
export const fmtInt = (v) => (Number.isFinite(v) ? nf.format(v) : '—')
export const fmtCompact = (v) => {
  if (!Number.isFinite(v)) return '—'
  return Math.abs(v) < 10000 ? nf.format(v) : cf.format(v)
}
export const fmtPct = (v) => (Number.isFinite(v) ? v.toFixed(1) + '%' : '—')
export const fmtMs = (v) => (Number.isFinite(v) && v > 0 ? fmtInt(Math.round(v)) + ' ms' : '—')
export const fmtClock = (ts) => {
  if (!Number.isFinite(ts)) return '—'
  try { return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }) } catch { return '—' }
}
export const fmtDateTime = (ts) => {
  if (!Number.isFinite(ts)) return '—'
  try { return new Date(ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) } catch { return '—' }
}
export const fmtDuration = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const total = Math.floor(ms / 1000)
  const d = Math.floor(total / 86400)
  const h = Math.floor((total % 86400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  if (d > 0) return d + ' 天 ' + h + ' 小时'
  if (h > 0) return h + ' 小时 ' + m + ' 分'
  return m + ' 分 ' + (total % 60) + ' 秒'
}
export const relTime = (ts) => {
  if (!Number.isFinite(ts)) return '—'
  const diff = Math.max(0, Date.now() - ts)
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前'
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前'
  return Math.floor(diff / 86400000) + ' 天前'
}
export const shortSha = (sha, show = true) => {
  const s = String(sha || '')
  if (!s) return '—'
  return show ? s.slice(0, 16) + (s.length > 16 ? '…' : '') : s.slice(0, 8) + '…'
}
