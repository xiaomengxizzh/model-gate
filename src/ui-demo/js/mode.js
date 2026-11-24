import { errorMessage } from './api.js'

export const MODE_ORDER = Object.freeze(['official', 'route', 'aggregated'])
export const MODE_META = Object.freeze({
  official: {
    label: '官方直连', short: '直连', tone: 'muted',
    detail: 'Codex 使用官方默认配置，不经 ModelGate；GPT 请求直连官方。',
    meta: 'GPT · 官网直连',
  },
  route: {
    label: '纯路由', short: '路由', tone: 'info',
    detail: '父 = 子 = DeepSeek，零 GPT 调用；所有请求经 ModelGate 到 OpenCode Go。',
    meta: 'DeepSeek · 零 GPT',
  },
  aggregated: {
    label: '聚合', short: '聚合', tone: 'accent',
    detail: 'GPT 父模型 + DeepSeek 子模型，同一个 Codex 会话里协作。',
    meta: 'GPT 父 + DeepSeek 子',
  },
})

export function modeMeta (mode) {
  return MODE_META[mode] || { label: mode || '未知', short: mode || '未知', tone: 'muted', detail: '无法识别的接入方式。', meta: '' }
}

export function snapshotOf (modes, health) {
  const m = modes && typeof modes === 'object' ? modes : {}
  const h = health && typeof health === 'object' ? health : {}
  const current = m.current && typeof m.current === 'object' ? m.current : {}
  const mode = String(current.mode || h.mode || 'unknown')
  const previousMode = String(m.previousMode || h.previousMode || '')
  const available = Array.isArray(m.available) && m.available.length
    ? m.available
    : MODE_ORDER.map((id) => Object.assign({ id }, MODE_META[id]))
  return {
    supported: !!modes,
    mode,
    known: MODE_ORDER.includes(mode),
    parentModel: String(current.parentModel || ''),
    childModel: String(current.childModel || ''),
    previousMode,
    drifted: m.drifted === true || h.drifted === true,
    appliedSha: String(m.appliedSha || (h.activation && h.activation.appliedSha) || (h.config && h.config.sha256) || ''),
    needsRestart: h.needsRestart === true || !!(h.detect && h.detect.restart && h.detect.restart.needed === true),
    available,
    parents: parentsOf(m),
    health: h,
  }
}

export function parentsOf (modes) {
  const m = modes && typeof modes === 'object' ? modes : {}
  const list = Array.isArray(m.selectableParents) ? m.selectableParents : []
  return list.filter((p) => p && p.id).map((p) => ({
    id: String(p.id),
    label: String(p.label || p.id),
    realTest: String(p.realTest || 'UNVERIFIED'),
  }))
}

export function buildSwitchPreviewBody (mode, parentModel) {
  const body = { mode: mode || 'aggregated' }
  if (parentModel) body.parentModel = String(parentModel)
  body.consentToken = ''
  body.expectedSha = ''
  return body
}

export function buildSwitchConfirmBody (preview, mode, parentModel) {
  const p = preview || {}
  const body = { mode: mode || 'aggregated' }
  if (parentModel) body.parentModel = String(parentModel)
  body.consentToken = typeof p.consentToken === 'string' ? p.consentToken : ''
  body.expectedSha = p.expectedSha == null ? '' : String(p.expectedSha)
  return body
}

export function buildRollbackPreviewBody () {
  return { consentToken: '', expectedSha: '' }
}

export function buildRollbackConfirmBody (preview) {
  const p = preview || {}
  return {
    consentToken: typeof p.consentToken === 'string' ? p.consentToken : '',
    expectedSha: p.expectedSha == null ? '' : String(p.expectedSha),
  }
}

export function buildReconcilePreviewBody () {
  return { consentToken: '', expectedSha: '' }
}

export function buildReconcileConfirmBody (preview) {
  return buildRollbackConfirmBody(preview)
}

export function classifyModeResponse (status, data) {
  const body = data && typeof data === 'object' ? data : {}
  const code = String(body.code || '')
  if (status === 428 || code === 'consent_required') {
    return { kind: 'preview', status, preview: body.preview || null }
  }
  if (status === 422 || code === 'activation_blocked' || Array.isArray(body.blocked)) {
    return {
      kind: 'blocked', status,
      blocked: Array.isArray(body.blocked) ? body.blocked : [],
      preview: body.preview || null,
      message: errorMessage(body, status),
    }
  }
  if (status === 409) {
    return { kind: 'conflict', status, code: code || 'config_conflict', message: errorMessage(body, status) }
  }
  if (status === 404) {
    return { kind: 'unsupported', status, message: errorMessage(body, status) }
  }
  if (status >= 200 && status < 300 && body.ok === true) {
    return { kind: 'applied', status, receipt: body }
  }
  return { kind: 'error', status, code, message: errorMessage(body, status) }
}

export function previewSummary (preview) {
  const p = preview && typeof preview === 'object' ? preview : {}
  const rows = Array.isArray(p.rows) ? p.rows.filter((r) => r && r.kind !== 'same') : []
  // 服务端同时给出字段级 rows 与逐行 TOML 差异 changed；两者都可能为空，谁有值就展示谁。
  const changed = Array.isArray(p.changed) ? p.changed : []
  const lineChanges = changed.filter((c) => c && c.kind !== 'same')
  const conflicts = Array.isArray(p.conflicts) ? p.conflicts : []
  const backup = p.backup && typeof p.backup === 'object' ? p.backup : {}
  return {
    rows,
    changed,
    lineChanges,
    addedLines: lineChanges.filter((c) => c.kind === 'add').length,
    removedLines: lineChanges.filter((c) => c.kind === 'del' || c.kind === 'remove').length,
    changeCount: lineChanges.length || rows.length,
    conflicts: conflicts.map((c) => (c && c.path) || String(c)),
    backupAvailable: backup.available === true,
    backupPath: backup.path || null,
    firstRun: p.firstRun === true,
    warnings: Array.isArray(p.warnings) ? p.warnings : [],
    catalog: p.catalog || null,
    agentChild: p.agentChild && typeof p.agentChild === 'object' ? p.agentChild : null,
    expectedSha: p.expectedSha == null ? '' : String(p.expectedSha),
    consentToken: typeof p.consentToken === 'string' ? p.consentToken : '',
    blocked: Array.isArray(p.blocked) ? p.blocked : [],
    beforeSha: p.beforeSha || (p.before && p.before.sha256) || p.expectedSha || '',
    afterSha: p.afterSha || (p.after && p.after.sha256) || '',
    restartPreview: p.restartPreview || null,
  }
}