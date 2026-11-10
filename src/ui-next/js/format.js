// Pure formatters and config diff helpers.
const LOCALE = 'zh-CN'
export const fmtNum = (v, digits = 1) => {
  const n = Number(v)
  if (v == null || v === '' || !Number.isFinite(n)) return '—'
  return n.toLocaleString(LOCALE, { maximumFractionDigits: digits })
}
export const fmtInt = (v) => {
  const n = Number(v)
  if (v == null || v === '' || !Number.isFinite(n)) return '—'
  return Math.round(n).toLocaleString(LOCALE)
}
export const fmtCompact = (v) => {
  const n = Number(v)
  if (v == null || v === '' || !Number.isFinite(n)) return '—'
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(Math.round(n))
}
export const fmtMs = (v) => {
  const n = Number(v)
  if (v == null || v === '' || !Number.isFinite(n) || n <= 0) return '—'
  return n >= 1000 ? (n / 1000).toFixed(2) + ' s' : Math.round(n) + ' ms'
}
export const fmtPct = (v, digits = 1) => {
  const n = Number(v)
  if (v == null || v === '' || !Number.isFinite(n)) return '—'
  return n.toFixed(digits) + '%'
}
export const fmtTime = (ts) => {
  const n = Number(ts)
  if (!Number.isFinite(n) || n <= 0) return '—'
  const d = new Date(n)
  return d.toLocaleString(LOCALE, { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
export const fmtClock = (ts) => {
  const n = Number(ts)
  if (!Number.isFinite(n)) return '—'
  return new Date(n).toLocaleTimeString(LOCALE, { hour12: false, hour: '2-digit', minute: '2-digit' })
}
export const fmtAgo = (ts) => {
  const n = Number(ts)
  if (!Number.isFinite(n) || n <= 0) return '—'
  const s = Math.max(0, (Date.now() - n) / 1000)
  if (s < 60) return Math.round(s) + ' 秒前'
  if (s < 3600) return Math.round(s / 60) + ' 分钟前'
  if (s < 86400) return Math.round(s / 3600) + ' 小时前'
  return Math.round(s / 86400) + ' 天前'
}
export const fmtDuration = (ms) => {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return '—'
  const s = Math.round(n / 1000)
  if (s < 60) return s + ' 秒'
  if (s < 3600) return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒'
  if (s < 86400) return Math.floor(s / 3600) + ' 小时 ' + Math.floor((s % 3600) / 60) + ' 分'
  return Math.floor(s / 86400) + ' 天 ' + Math.floor((s % 86400) / 3600) + ' 小时'
}
export const safeHost = (value) => {
  try {
    const u = new URL(String(value))
    if (!/^https?:$/.test(u.protocol)) return '协议不可显示'
    return u.protocol + '//' + u.host + (u.pathname === '/' ? '' : u.pathname)
  } catch { return '未配置或地址不可用' }
}
export const safeOrigin = (value) => {
  try {
    const u = new URL(String(value))
    if (!/^https?:$/.test(u.protocol)) return '协议不可显示'
    return u.protocol + '//' + u.host
  } catch { return '地址不可用' }
}
export const maskValue = (value, keep = 2) => {
  const s = String(value == null ? '' : value)
  if (!s) return ''
  if (s.length <= keep * 2) return '••••'
  return s.slice(0, keep) + '••••' + s.slice(-keep)
}
export const maskHeaderValue = (key, value) => {
  if (/(authorization|api[-_]?key|token|secret|password|cookie|credential|session)/i.test(String(key))) return maskValue(value)
  return String(value)
}
export const clone = (obj) => obj == null ? obj : JSON.parse(JSON.stringify(obj))
export const parseKv = (text) => {
  const out = {}
  for (const line of String(text || '').split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i <= 0 || !line.trim()) continue
    const k = line.slice(0, i).trim()
    const v = line.slice(i + 1).trim()
    if (k) out[k] = v
  }
  return out
}
export const kvText = (obj) => Object.entries(obj || {}).map(([k, v]) => k + ': ' + v).join('\n')
export const pretty = (obj) => JSON.stringify(obj, null, 2)
export function diffObjects(before, after, base = '') {
  const out = []
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)
  if (JSON.stringify(before) === JSON.stringify(after)) return out
  if (isObj(before) && isObj(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)])
    for (const k of keys) out.push(...diffObjects(before[k], after[k], base ? base + '.' + k : k))
    return out
  }
  if (Array.isArray(before) || Array.isArray(after)) {
    if (JSON.stringify(before) !== JSON.stringify(after)) out.push({ path: base || '(root)', before, after })
    return out
  }
  if (before !== after) out.push({ path: base || '(root)', before, after })
  return out
}
export const shortValue = (v, max = 72) => {
  if (v == null) return '—'
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > max ? s.slice(0, max) + '…' : s
}
