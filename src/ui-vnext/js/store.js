import { api } from './api.js'
import { emptyDrafts, loadDrafts, saveDrafts, clearDrafts, sanitizeDrafts, sanitizeTarget } from './drafts.js'

export const state = {
  phase: 'loading',
  capabilities: null,
  aggregation: null,
  stats: null,
  usage: null,
  native: null,
  models: null,
  pools: null,
  bindings: null,
  errors: {},
  checkedAt: null,
  codexDrafts: null,
  codexStoredDrafts: null,
  codexDraftStatus: 'loading',
  codexDraftError: '',
  codexDraftBaseVersion: '',
}

export function draftTargets() {
  return new Set([
    ...(state.models?.items || []).filter((model) => model.enabled).map((model) => 'model:' + model.modelId),
    ...(state.pools?.items || []).filter((pool) => pool.enabled).map((pool) => 'pool:' + (pool.poolId || pool.slug)),
  ])
}

function initializeDrafts(version, targets) {
  const baseVersion = String(version)
  if (state.codexDrafts && state.codexDraftBaseVersion === baseVersion) return
  if (state.codexDrafts) {
    state.codexDraftBaseVersion = baseVersion
    state.codexStoredDrafts = sanitizeDrafts(state.codexDrafts, targets)
    state.codexDrafts = emptyDrafts()
    state.codexDraftStatus = 'stale'
    state.codexDraftError = ''
    return
  }
  const result = loadDrafts(baseVersion, targets)
  state.codexDraftBaseVersion = baseVersion
  state.codexDrafts = result.status === 'stale' ? emptyDrafts() : result.drafts
  state.codexStoredDrafts = result.storedDrafts || null
  state.codexDraftStatus = result.status
  state.codexDraftError = result.reason || ''
}

export function selectDraftMode(mode) {
  if (!state.codexDrafts || !['official', 'route', 'aggregated'].includes(mode) || state.codexDraftStatus === 'stale') return
  state.codexDrafts.mode = mode
  persistDrafts()
}

export function updateDraft(mode, patch) {
  if (!state.codexDrafts || !['route', 'aggregated'].includes(mode) || state.codexDraftStatus === 'stale') return
  if (Object.hasOwn(patch, 'target')) state.codexDrafts[mode].target = sanitizeTarget(patch.target, draftTargets())
  persistDrafts()
}

function persistDrafts() {
  const result = saveDrafts(state.codexDraftBaseVersion, state.codexDrafts, draftTargets())
  state.codexDrafts = result.drafts
  state.codexDraftStatus = result.ok ? 'ready' : 'error'
  state.codexDraftError = result.ok ? '' : 'write'
  emit()
}

export function restoreStaleDrafts() {
  if (!state.codexStoredDrafts || state.codexDraftStatus !== 'stale') return
  state.codexDrafts = sanitizeDrafts(state.codexStoredDrafts, draftTargets())
  state.codexStoredDrafts = null
  persistDrafts()
}

export function discardDrafts(mode = '') {
  const result = mode ? { ok: true } : clearDrafts()
  if (!state.codexDrafts) state.codexDrafts = emptyDrafts()
  if (!result.ok) {
    // Keep the form and stored record intact so the explicit action can be retried.
    state.codexDraftStatus = 'error'
    state.codexDraftError = 'remove'
    emit()
    return result
  }
  if (mode && ['route', 'aggregated'].includes(mode)) {
    const fresh = emptyDrafts()
    state.codexDrafts[mode] = fresh[mode]
    persistDrafts()
  } else {
    state.codexDrafts = emptyDrafts()
    state.codexStoredDrafts = null
    state.codexDraftBaseVersion = String(state.capabilities?.runtime.configVersion || 0)
    state.codexDraftStatus = 'ready'
    state.codexDraftError = ''
    emit()
  }
  return result
}

let epoch = 0
let inFlight = null
const listeners = new Set()

export function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function emit() {
  for (const fn of [...listeners]) fn(state)
}

export function refresh() {
  if (inFlight) return inFlight
  const current = ++epoch
  const controller = new AbortController()
  state.phase = 'loading'
  state.errors = {}
  emit()
  inFlight = (async () => {
    try {
      const capabilities = await api.capabilities({ signal: controller.signal })
      if (current !== epoch) return state
      if (!capabilities || capabilities.contract !== 'mg-capabilities/1') throw new Error('控制面契约不匹配')
      state.capabilities = capabilities
      state.checkedAt = capabilities.generatedAt
      // Models/pools arrive with the same snapshot; validate draft targets once
      // the complete snapshot is available below.
      const results = await Promise.allSettled([
        api.aggregationHealth({ signal: controller.signal }),
        api.modelStats(7, { signal: controller.signal }),
        api.usageSummary(7, { signal: controller.signal }),
        capabilities.usage.native === 'enabled' ? api.nativeUsage(7, { signal: controller.signal }) : Promise.resolve(null),
        api.models({ signal: controller.signal }),
        api.pools({ signal: controller.signal }),
        api.bindings({ signal: controller.signal }),
      ])
      if (current !== epoch) return state
      if (results[0].status === 'fulfilled') state.aggregation = results[0].value
      else state.errors.aggregation = results[0].reason
      if (results[1].status === 'fulfilled') state.stats = results[1].value
      else state.errors.stats = results[1].reason
      if (results[2].status === 'fulfilled') state.usage = results[2].value
      else state.errors.usage = results[2].reason
      if (results[3].status === 'fulfilled') state.native = results[3].value
      else state.errors.native = results[3].reason
      if (results[4].status === 'fulfilled') state.models = results[4].value
      else state.errors.models = results[4].reason
      if (results[5].status === 'fulfilled') state.pools = results[5].value
      else state.errors.pools = results[5].reason
      if (results[6].status === 'fulfilled') state.bindings = results[6].value
      else state.errors.bindings = results[6].reason
      initializeDrafts(capabilities.runtime.configVersion, draftTargets())
      state.phase = Object.keys(state.errors).length ? 'partial' : 'ready'
      return state
    } catch (error) {
      if (current !== epoch || error.aborted) return state
      state.phase = error.status === 0 ? 'offline' : 'error'
      state.capabilities = null
      state.aggregation = null
      state.stats = null
      state.usage = null
      state.native = null
      state.models = null
      state.pools = null
      state.bindings = null
      state.errors.core = error
      return state
    } finally {
      if (current === epoch) {
        inFlight = null
        emit()
      }
    }
  })()
  return inFlight
}
