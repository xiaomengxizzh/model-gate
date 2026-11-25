// Only non-sensitive Codex mode selections may cross a reload. Credentials,
// consent tokens, request bodies and arbitrary configuration text are rejected.
export const DRAFT_KEY = 'mg.ui-vnext.codex-mode-drafts.v1'
export const DRAFT_SCHEMA = 'mg-ui-vnext-codex-mode-drafts/1'
export const MODES = Object.freeze(['official', 'route', 'aggregated'])
export const OFFICIAL_PARENT = 'gpt-6-luna'

export function emptyDrafts() {
  return {
    mode: 'official',
    official: { target: '' },
    route: { target: '' },
    aggregated: { parent: OFFICIAL_PARENT, target: '' },
  }
}

export function sanitizeTarget(value, allowedTargets) {
  const target = typeof value === 'string' ? value : ''
  return allowedTargets.has(target) ? target : ''
}

export function sanitizeDrafts(value, allowedTargets = new Set()) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const safe = emptyDrafts()
  if (MODES.includes(source.mode)) safe.mode = source.mode
  for (const mode of MODES) {
    const item = source[mode]
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    safe[mode].target = sanitizeTarget(item.target, allowedTargets)
  }
  return safe
}

export function dirtyModes(drafts, allowedTargets) {
  const safe = sanitizeDrafts(drafts, allowedTargets || new Set([drafts?.route?.target, drafts?.aggregated?.target].filter(Boolean)))
  return MODES.filter((mode) => mode !== 'official' && safe[mode].target)
}

function storage() {
  return { getItem: (key) => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value), removeItem: (key) => localStorage.removeItem(key) }
}

function discardInvalid(io) {
  try { io.removeItem(DRAFT_KEY) } catch { /* The visible error below still prevents form recovery. */ }
}

export function loadDrafts(version, allowedTargets = new Set(), io = storage()) {
  let raw
  try { raw = io.getItem(DRAFT_KEY) } catch (error) { return { status: 'error', reason: 'read', drafts: emptyDrafts() } }
  if (!raw) return { status: 'ready', drafts: emptyDrafts() }
  let record
  try { record = JSON.parse(raw) } catch { discardInvalid(io); return { status: 'error', reason: 'invalid', drafts: emptyDrafts() } }
  if (!record || record.schema !== DRAFT_SCHEMA || typeof record.baseVersion !== 'string' || !record.drafts || typeof record.drafts !== 'object' || Array.isArray(record.drafts)) {
    discardInvalid(io)
    return { status: 'error', reason: 'invalid', drafts: emptyDrafts() }
  }
  // Construct a new allowlisted object; never echo untrusted persisted text.
  const drafts = sanitizeDrafts(record.drafts, allowedTargets)
  const source = record.drafts
  const exactKeys = (object, keys) => object && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).length === keys.length && keys.every((key) => Object.hasOwn(object, key))
  const valid = exactKeys(record, ['schema', 'baseVersion', 'drafts'])
    && exactKeys(source, ['mode', ...MODES])
    && exactKeys(source.official, ['target']) && source.official.target === ''
    && exactKeys(source.route, ['target']) && source.route.target === drafts.route.target
    && exactKeys(source.aggregated, ['parent', 'target']) && source.aggregated.parent === OFFICIAL_PARENT && source.aggregated.target === drafts.aggregated.target
  if (!valid) {
    try { io.removeItem(DRAFT_KEY) } catch { /* The visible error below still prevents form recovery. */ }
    return { status: 'error', reason: 'target', drafts: emptyDrafts() }
  }
  if (String(version) !== record.baseVersion) return { status: 'stale', reason: 'version', drafts, storedDrafts: drafts }
  return { status: 'ready', drafts }
}

export function saveDrafts(version, drafts, allowedTargets = new Set(), io = storage()) {
  const safe = sanitizeDrafts(drafts, allowedTargets)
  const record = { schema: DRAFT_SCHEMA, baseVersion: String(version), drafts: safe }
  try { io.setItem(DRAFT_KEY, JSON.stringify(record)); return { ok: true, drafts: safe } } catch (error) { return { ok: false, error, drafts: safe } }
}

export function clearDrafts(io = storage()) {
  try { io.removeItem(DRAFT_KEY); return { ok: true } } catch (error) { return { ok: false, error } }
}
