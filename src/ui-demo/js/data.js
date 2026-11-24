import { num } from './format.js'

export function providerMap (status) {
  const map = new Map()
  for (const def of (status && Array.isArray(status.models) ? status.models : [])) {
    if (def && def.name) map.set(def.name, def.provider || '')
  }
  return map
}

export function modelNames (stats, { provider = '', model = '', meta = new Map() } = {}) {
  const models = (stats && stats.models) || {}
  let names = Object.keys(models)
  if (model) names = names.filter((n) => n === model)
  if (provider) names = names.filter((n) => meta.get(n) === provider)
  return names
}

export function bucketSeries (stats, names) {
  const models = (stats && stats.models) || {}
  const list = Array.isArray(names) ? names : Object.keys(models)
  if (!list.length) return []
  let length = 0
  for (const n of list) if (Array.isArray(models[n])) length = Math.max(length, models[n].length)
  const rows = []
  for (let i = 0; i < length; i++) {
    const row = {
      index: i, label: '', tokens: 0, inTokens: 0, outTokens: 0,
      requests: 0, hit: 0, miss: 0, hasRequests: false, unknownRequests: false,
    }
    for (const n of list) {
      const bucket = (Array.isArray(models[n]) ? models[n] : [])[i]
      if (!bucket) continue
      if (!row.label && bucket.date) row.label = String(bucket.date)
      row.tokens += num(bucket.tokens)
      row.inTokens += num(bucket.inTokens)
      row.outTokens += num(bucket.outTokens)
      row.hit += num(bucket.hit)
      row.miss += num(bucket.miss)
      if (typeof bucket.requests === 'number') {
        row.requests += bucket.requests
        row.hasRequests = true
      } else {
        // 升级前的历史桶没有请求计数字段：未知，不是 0。
        row.unknownRequests = true
      }
    }
    row.hitRate = row.hit + row.miss > 0 ? (row.hit / (row.hit + row.miss)) * 100 : null
    rows.push(row)
  }
  return rows
}

export function metricOf (row, metric) {
  if (!row) return null
  if (metric === 'requests') return row.hasRequests ? row.requests : null
  if (metric === 'hitrate') return row.hitRate
  return row.tokens
}

export function metricAvailable (rows, metric) {
  if (metric === 'requests') return rows.some((r) => r.hasRequests)
  return rows.some((r) => metricOf(r, metric) != null)
}

export function metricLabel (metric) {
  return ({ tokens: 'Token', requests: '记账请求', hitrate: '缓存命中率' })[metric] || metric
}

export function metricFormat (metric, value) {
  if (!Number.isFinite(value)) return '—'
  if (metric === 'hitrate') return value.toFixed(1) + '%'
  if (metric === 'requests') return new Intl.NumberFormat('zh-CN').format(Math.round(value))
  return new Intl.NumberFormat('zh-CN').format(Math.round(value))
}

export function summarize (rows, metric) {
  const totals = { tokens: 0, inTokens: 0, outTokens: 0, requests: 0, hit: 0, miss: 0, knownBuckets: 0, unknownBuckets: 0 }
  let peak = null
  for (const row of rows) {
    totals.tokens += row.tokens
    totals.inTokens += row.inTokens
    totals.outTokens += row.outTokens
    totals.hit += row.hit
    totals.miss += row.miss
    if (row.hasRequests) { totals.requests += row.requests; totals.knownBuckets += 1 }
    if (row.unknownRequests) totals.unknownBuckets += 1
    const v = metricOf(row, metric)
    if (v != null && (peak == null || v > peak.value)) peak = { value: v, label: row.label, index: row.index }
  }
  totals.hitRate = totals.hit + totals.miss > 0 ? (totals.hit / (totals.hit + totals.miss)) * 100 : null
  totals.hasRequests = totals.knownBuckets > 0
  return { totals, peak }
}

export function niceMax (value) {
  if (!Number.isFinite(value) || value <= 0) return 1
  const exp = Math.floor(Math.log10(value))
  const base = Math.pow(10, exp)
  const n = value / base
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10
  return step * base
}

export function bucketLabel (date) {
  const s = String(date || '')
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s.slice(5)
  return s
}

export function modelRows (stats, meta, { showZero = true } = {}) {
  const models = (stats && stats.models) || {}
  const rows = []
  for (const [name, list] of Object.entries(models)) {
    const row = { name, provider: meta.get(name) || '—', tokens: 0, requests: 0, hit: 0, miss: 0, hasRequests: false, unknownRequests: false }
    for (const b of (Array.isArray(list) ? list : [])) {
      row.tokens += num(b.tokens)
      row.hit += num(b.hit)
      row.miss += num(b.miss)
      if (typeof b.requests === 'number') { row.requests += b.requests; row.hasRequests = true }
      else row.unknownRequests = true
    }
    row.hitRate = row.hit + row.miss > 0 ? (row.hit / (row.hit + row.miss)) * 100 : null
    if (showZero || row.tokens > 0 || row.requests > 0) rows.push(row)
  }
  return rows.sort((a, b) => b.tokens - a.tokens || b.requests - a.requests || a.name.localeCompare(b.name))
}
