import { todayKey } from '../shared.js'

function number(value) { return Number.isFinite(Number(value)) ? Number(value) : 0 }
function sumBuckets(stats, names, days) {
  const result = { tokens: 0, inTokens: 0, outTokens: 0, hit: 0, miss: 0 }
  const dates = []
  const now = new Date()
  for (let offset = days - 1; offset >= 0; offset--) {
    const date = new Date(now)
    date.setDate(date.getDate() - offset)
    dates.push(todayKey(date))
  }
  const allowed = new Set(dates)
  for (const name of names) {
    for (const [date, bucket] of Object.entries(stats.daily?.[name] || {})) {
      if (!allowed.has(date)) continue
      for (const key of Object.keys(result)) result[key] += number(bucket[key])
    }
  }
  return result
}

export function usageSummary(state, days = 7, native = null) {
  const safeDays = Math.min(90, Math.max(1, Number(days) || 7))
  const stats = state.stats || {}
  const counters = state.st?.counters || {}
  const historicalNames = [...new Set([...Object.keys(stats.byModel || {}), ...Object.keys(stats.daily || {}), ...Object.keys(state.cfg?.models || {})])]
  const totals = sumBuckets(stats, historicalNames, safeDays)
  const attempts = number(counters.requests)
  const errors = number(counters.errors)
  const models = historicalNames.map((name) => {
    const current = state.cfg?.models?.[name]
    const pool = (state.cfg?.virtualModels || []).find((item) => item.name === name)
    const bucket = sumBuckets(stats, [name], safeDays)
    return {
      name,
      displayName: current?.displayName || pool?.name || name,
      serviceId: current?.provider || null,
      poolId: pool?.poolId || null,
      kind: pool ? 'pool' : current ? 'model' : 'retired',
      ...bucket,
      cost: null,
      quotaRemaining: null,
    }
  }).filter((item) => item.tokens || item.kind !== 'retired').sort((a, b) => b.tokens - a.tokens)
  return {
    contract: 'mg-usage/1',
    days: safeDays,
    generatedAt: new Date().toISOString(),
    gateway: {
      logicalRequests: number(counters.logicalRequests),
      completedRequests: number(counters.completedRequests),
      upstreamAttempts: attempts,
      failedAttempts: errors,
      retries: number(counters.retries),
      interrupts: number(counters.interrupts),
      ...totals,
      cost: null,
      note: 'Counters are persisted cumulative totals; token buckets cover the selected days. Unknown cost and remaining quota stay null.',
    },
    native: native ? { enabled: native.enabled !== false, totals: native.totals || null, note: native.note || null } : { enabled: false, totals: null },
    models,
  }
}
