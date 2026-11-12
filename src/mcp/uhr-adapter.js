// 本地 MCP ↔ UHR 适配器（M5-2 / T-AGENT-02）：隔离实验目录，零新增依赖。
// 契约文档：docs/contracts/uhr-mcp-v1.md
//
// 定位：这是 **mock 契约验收**（uhr-mock.js），不是真实 UHR 集成（NOT_RUN）。
// 适配器只做一件事：把 MCP 工具调用收敛成"有作用域、有预算、有引用白名单"的委派请求，
// 并在边界上拒绝一切越权/越界输入。它不解析对话正文，也不转发工作区内容。
//
// 硬约束：
//   · 需要授权的 connectionIdentity（caller/scope/expiry/只读意图/引用种类/工具范围/预算上限）；
//   · 只接受有界的任务摘要与不透明引用；绝对路径、密钥、内联正文、v2 密文一律拒绝；
//   · 预算必须 > 0 且不超过身份/策略上限；截止时间不得晚于作用域到期；
//   · 重复提交（同 idempotencyKey 同摘要）返回同一 taskRef，不重复执行；
//   · getTaskResult/cancelTask 必须拥有该 taskRef 或有 scoped grant；
//   · 结果回到原 toolCallId（原样回填，不做任何改写；空/缺失一律拒绝，且零提交）；
//   · 摘要默认**不裁剪**：超硬上限即拒绝，只有显式 allowSummaryTruncation 才裁剪并留痕；
//   · v2 密文检测是**键级**契约（只看键名，不扫描字符串值、不做语义猜测）；
//   · 所有对外结构深度冻结、脱敏（id 哈希、结果文本脱敏+截断）。
//
// 信任边界（重要）：connectionIdentity 由已验证的传输层/调用方注入，adapter 只校验它的形状与授权字段。
// 任何"让模型或工具参数控制 connectionIdentity"的接线都会绕过本模块的全部边界检查（模型只能提供 tool arguments）。
import { createHash } from 'node:crypto'
import { taskRefToken } from './uhr-mock.js'

export const UHR_MCP_CONTRACT = 'uhr-mcp-v1'
export const UHR_MCP_VERSION = 1

export const UHR_TOOL = Object.freeze({
  DELEGATE: 'uhr_delegate_task',
  GET_RESULT: 'uhr_get_task_result',
  CANCEL: 'uhr_cancel_task',
})

/** 稳定拒绝码（日志/测试/接线只认这些）。 */
export const UHR_REJECT = Object.freeze({
  BAD_REQUEST: 'UHR_REJECT_BAD_REQUEST',
  IDENTITY: 'UHR_REJECT_IDENTITY',
  SCOPE: 'UHR_REJECT_SCOPE',
  INTENT: 'UHR_REJECT_INTENT',
  V2_OPAQUE: 'UHR_REJECT_V2_OPAQUE',
  SHAPE: 'UHR_REJECT_SHAPE',
  SUMMARY_TOO_LARGE: 'UHR_REJECT_SUMMARY_TOO_LARGE',
  REFS: 'UHR_REJECT_REFS',
  BUDGET: 'UHR_REJECT_BUDGET',
  DEADLINE: 'UHR_REJECT_DEADLINE',
  TOOL_SCOPE: 'UHR_REJECT_TOOL_SCOPE',
  NOT_OWNER: 'UHR_REJECT_NOT_OWNER',
  NOT_FOUND: 'UHR_REJECT_TASK_NOT_FOUND',
  CONFLICT: 'UHR_REJECT_CONFLICT',
  STATE: 'UHR_REJECT_STATE',
})

const DEFAULT_POLICY = Object.freeze({
  maxBudgetMicro: 5_000_000,
  maxRefs: 20,
  maxRefLength: 512,
  maxTitleLength: 200,
  maxGoalLength: 500,
  maxTags: 10,
  // 摘要硬上限（UTF-8 字节，canonical JSON 计）：默认超限即拒绝，只有调用方显式 allowSummaryTruncation 才裁剪。
  summaryMaxBytes: 1024,
  maxTagLength: 40,
  maxResultBytes: 16 * 1024,
  allowedIntents: ['read_only'],
  allowedRefKinds: ['file', 'doc', 'issue', 'commit', 'symbol'],
  allowedToolScope: ['read_file', 'search', 'list_dir'],
})

// 请求顶层允许的字段：多一个都拒绝（防止顺手把 messages/工作区/密钥塞进来）。
const REQUEST_KEYS = new Set([
  'readOnlyIntent', 'budgetMicro', 'currency', 'timeMs', 'deadlineAt',
  'toolScope', 'summary', 'refs', 'parentRef', 'idempotencyKey', 'toolCallId',
  'allowSummaryTruncation',
])
const SUMMARY_KEYS = new Set(['title', 'goal', 'tags'])
const REF_KEYS = new Set(['kind', 'ref'])
const OPAQUE_KEYS = new Set(['encrypted_content', 'encrypted_task_id', 'encrypted_payload', 'opaque_v2'])
const SAFE_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/
const TASK_REF_RE = /^task-[a-z0-9]{8,40}$/
// 注意边界：'task-parent-1' 里含子串 'sk-'，无边界匹配会把普通引用误判成密钥。
const SECRET_RE = /(^|[^A-Za-z0-9_-])(sk-[A-Za-z0-9_-]{8,}|bearer\s+[A-Za-z0-9._-]{8,}|api[_-]?key\s*[=:]|password\s*[=:]|secret\s*[=:])/i
const POSIX_ABS_RE = /(^|[\s"'(=])\/(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]*/
const WIN_ABS_RE = /(^|[\s"'(=])[A-Za-z]:[\\/]/
const TILDE_RE = /(^|[\s"'(=])~[\\/]/
const MULTILINE_RE = /[\r\n]/

const toStr = (v) => (v == null ? '' : String(v))
const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const isMicro = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const sha256Hex = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex')

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  const keys = Object.keys(value).sort()
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}'
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

function hashRef(kind, raw) {
  return kind + '_' + sha256Hex(kind + ':' + toStr(raw)).slice(0, 24)
}

function label(value, max = 64) {
  const text = toStr(value).trim()
  if (!text) return null
  if (SECRET_RE.test(text) || MULTILINE_RE.test(text) || text.length > max) return 'redacted'
  return text
}

function rejection(code, message, details) {
  const safe = {}
  if (isPlain(details)) {
    for (const [key, value] of Object.entries(details)) {
      if (key === 'reason' || key === 'field' || key === 'kind' || key === 'taskRef' || key === 'code') {
        const text = label(value, 128)
        if (text) safe[key] = text
      } else if (typeof value === 'number' && Number.isFinite(value)) safe[key] = value
      else if (typeof value === 'boolean') safe[key] = value
    }
  }
  return deepFreeze({ ok: false, contract: UHR_MCP_CONTRACT, version: UHR_MCP_VERSION, code, message, details: safe })
}

/** 深度扫描 v2 不透明密文标记：跨域前必须明确拒绝，绝不解密、绝不透传。 */
function detectOpaqueV2(value, budget = { nodes: 0, hits: [] }) {
  if (!value || typeof value !== 'object' || budget.nodes > 500 || budget.hits.length) return budget
  budget.nodes += 1
  if (Array.isArray(value)) {
    for (const item of value) detectOpaqueV2(item, budget)
    return budget
  }
  for (const [key, child] of Object.entries(value)) {
    if (OPAQUE_KEYS.has(String(key).toLowerCase())) budget.hits.push(String(key))
    if (child && typeof child === 'object') detectOpaqueV2(child, budget)
    if (budget.hits.length) return budget
  }
  return budget
}

function hasAbsolutePath(text) {
  return POSIX_ABS_RE.test(text) || WIN_ABS_RE.test(text) || TILDE_RE.test(text)
}

function normalizeCurrency(value) {
  const text = toStr(value).trim().toUpperCase()
  return /^[A-Z]{3,8}$/.test(text) ? text : null
}

function checkIdentity(identity, now, policy) {
  const id = isPlain(identity) ? identity : {}
  const callerRef = toStr(id.callerRef).trim()
  const scopeRef = toStr(id.scopeRef).trim()
  if (!callerRef || !scopeRef) return { ok: false, code: UHR_REJECT.IDENTITY, message: '缺少 callerRef/scopeRef（连接身份必须带作用域）' }
  if (id.authorized !== true) return { ok: false, code: UHR_REJECT.SCOPE, message: '连接身份未经授权', details: { reason: 'not_authorized' } }
  const expiresAt = Number(id.expiresAt)
  if (!Number.isFinite(expiresAt)) return { ok: false, code: UHR_REJECT.SCOPE, message: '连接身份缺少到期时间', details: { reason: 'no_expiry' } }
  if (expiresAt <= now) return { ok: false, code: UHR_REJECT.SCOPE, message: '连接身份已过期', details: { reason: 'expired', expiresAt: 0 } }
  const currency = normalizeCurrency(id.currency)
  if (!currency) return { ok: false, code: UHR_REJECT.BUDGET, message: '连接身份缺少显式币种' }
  return {
    ok: true,
    callerRef,
    scopeRef,
    expiresAt,
    currency,
    allowedIntents: Array.isArray(id.allowedIntents) && id.allowedIntents.length ? id.allowedIntents.map((v) => toStr(v)) : policy.allowedIntents.slice(),
    allowedRefKinds: Array.isArray(id.allowedRefKinds) && id.allowedRefKinds.length ? id.allowedRefKinds.map((v) => toStr(v)) : policy.allowedRefKinds.slice(),
    allowedToolScope: Array.isArray(id.allowedToolScope) && id.allowedToolScope.length ? id.allowedToolScope.map((v) => toStr(v)) : policy.allowedToolScope.slice(),
    maxBudgetMicro: isMicro(id.maxBudgetMicro) && id.maxBudgetMicro > 0 ? id.maxBudgetMicro : policy.maxBudgetMicro,
    grants: Array.isArray(id.grants) ? id.grants.map((v) => toStr(v)).filter(Boolean) : [],
    ownerRef: 'owner_' + sha256Hex(callerRef + '|' + scopeRef).slice(0, 24),
  }
}

function boundedSummary(raw, policy, allowTruncation) {
  if (raw == null) return { ok: true, value: {}, truncated: false, originalBytes: 2, bytes: 2 }
  if (!isPlain(raw)) return { ok: false, code: UHR_REJECT.SHAPE, message: 'summary 必须是对象（只允许 title/goal/tags）' }
  for (const key of Object.keys(raw)) {
    if (!SUMMARY_KEYS.has(key)) {
      return { ok: false, code: UHR_REJECT.SHAPE, message: 'summary 含不允许的字段（不转发对话/工作区内容）', details: { field: label(key, 40) || 'unknown' } }
    }
  }
  // 先按"将要发送的内容"算字节数与是否需要裁剪。默认策略：需要裁剪就拒绝，
  // 绝不静默把 5000 字符单行正文裁进摘要（那等于把完整对话偷渡出去）。
  let originalBytes = 0
  try {
    originalBytes = Buffer.byteLength(canonicalJson(raw), 'utf8')
  } catch {
    return { ok: false, code: UHR_REJECT.SHAPE, message: 'summary 无法序列化（可能是循环引用），拒绝转发' }
  }
  const overBytes = originalBytes > policy.summaryMaxBytes
  let needsFieldTrim = false
  for (const [key, max] of [['title', policy.maxTitleLength], ['goal', policy.maxGoalLength]]) {
    if (raw[key] != null && typeof raw[key] === 'string' && raw[key].length > max) needsFieldTrim = true
  }
  if (Array.isArray(raw.tags) && (raw.tags.length > policy.maxTags ||
    raw.tags.some((tag) => typeof tag === 'string' && tag.length > policy.maxTagLength))) needsFieldTrim = true
  if ((overBytes || needsFieldTrim) && allowTruncation !== true) {
    return {
      ok: false,
      code: UHR_REJECT.SUMMARY_TOO_LARGE,
      message: '任务摘要超过硬上限：默认拒绝裁剪（确需裁剪请显式 allowSummaryTruncation）',
      details: {
        reason: overBytes ? 'total_bytes' : 'field_length',
        limit: policy.summaryMaxBytes,
        actual: originalBytes,
      },
    }
  }
  let truncated = false
  const out = {}
  for (const key of ['title', 'goal']) {
    if (raw[key] == null) continue
    if (typeof raw[key] !== 'string') return { ok: false, code: UHR_REJECT.SHAPE, message: 'summary.' + key + ' 必须是字符串' }
    const text = raw[key]
    if (SECRET_RE.test(text)) return { ok: false, code: UHR_REJECT.SHAPE, message: '任务摘要里出现疑似密钥：拒绝转发', details: { field: key, reason: 'secret' } }
    if (hasAbsolutePath(text)) return { ok: false, code: UHR_REJECT.SHAPE, message: '任务摘要里出现绝对路径：请改用 refs 传递引用', details: { field: key, reason: 'absolute_path' } }
    if (MULTILINE_RE.test(text)) return { ok: false, code: UHR_REJECT.SHAPE, message: '任务摘要必须是单行（不转发粘贴的对话正文）', details: { field: key, reason: 'multiline' } }
    const max = key === 'title' ? policy.maxTitleLength : policy.maxGoalLength
    if (text.length > max) {
      out[key] = text.slice(0, max)
      truncated = true
    } else {
      out[key] = text
    }
  }
  if (raw.tags != null) {
    if (!Array.isArray(raw.tags)) return { ok: false, code: UHR_REJECT.SHAPE, message: 'summary.tags 必须是数组' }
    const tags = []
    for (const tag of raw.tags) {
      const text = toStr(tag).trim()
      if (!text) continue
      if (SECRET_RE.test(text) || hasAbsolutePath(text) || MULTILINE_RE.test(text)) {
        return { ok: false, code: UHR_REJECT.SHAPE, message: 'summary.tags 含敏感/路径值：拒绝转发', details: { field: 'tags', reason: 'sensitive' } }
      }
      tags.push(text.length > policy.maxTagLength ? text.slice(0, policy.maxTagLength) : text)
      if (tags.length >= policy.maxTags) { truncated = true; break }
    }
    out.tags = tags
  }
  return {
    ok: true,
    value: out,
    truncated,
    originalBytes,
    bytes: Buffer.byteLength(canonicalJson(out), 'utf8'),
  }
}

/** 引用校验：只允许"不透明引用"，拒绝内联正文、绝对路径、穿越、带凭据 URL。 */
function validateRefs(raw, identity, policy) {
  const list = raw == null ? [] : raw
  if (!Array.isArray(list)) return { ok: false, code: UHR_REJECT.REFS, message: 'refs 必须是数组' }
  if (list.length > policy.maxRefs) return { ok: false, code: UHR_REJECT.REFS, message: '引用数量超出上限', details: { count: list.length, limit: policy.maxRefs } }
  const out = []
  const kinds = new Set()
  for (const item of list) {
    if (!isPlain(item)) return { ok: false, code: UHR_REJECT.REFS, message: '每个引用必须是 {kind, ref} 对象' }
    for (const key of Object.keys(item)) {
      if (!REF_KEYS.has(key)) {
        // 内联正文（content/body/text/patch）是最典型的越界：直接拒绝，绝不裁剪后偷偷发送。
        return { ok: false, code: UHR_REJECT.REFS, message: '引用只能含 kind/ref（不得内联正文）', details: { field: label(key, 40) || 'unknown' } }
      }
    }
    const kind = toStr(item.kind).trim()
    const ref = toStr(item.ref).trim()
    if (!kind || !ref) return { ok: false, code: UHR_REJECT.REFS, message: '引用缺 kind 或 ref' }
    if (!identity.allowedRefKinds.includes(kind)) {
      return { ok: false, code: UHR_REJECT.REFS, message: '引用种类不在授权白名单', details: { kind: label(kind, 40) || 'unknown' } }
    }
    if (ref.length > policy.maxRefLength) return { ok: false, code: UHR_REJECT.REFS, message: '引用过长', details: { reason: 'too_long' } }
    if (hasAbsolutePath(ref)) return { ok: false, code: UHR_REJECT.REFS, message: '引用不得是绝对路径（跨域前只传不透明引用）', details: { reason: 'absolute_path' } }
    if (ref.split(/[\\/]+/).includes('..')) return { ok: false, code: UHR_REJECT.REFS, message: '引用不得含路径穿越', details: { reason: 'path_traversal' } }
    if (SECRET_RE.test(ref)) return { ok: false, code: UHR_REJECT.REFS, message: '引用里出现疑似密钥：拒绝转发', details: { reason: 'secret' } }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(ref) && /^[a-z][a-z0-9+.-]*:\/\/[^/]*@/i.test(ref)) {
      return { ok: false, code: UHR_REJECT.REFS, message: '引用 URL 含凭据：拒绝转发', details: { reason: 'credential_in_url' } }
    }
    kinds.add(kind)
    out.push({ kind, ref })
  }
  return { ok: true, value: out, kinds: Array.from(kinds).sort() }
}

/**
 * 创建 UHR MCP 适配器。
 * @param {object} options { uhr（uhr-mock 实例）, now()=>ms, at, policy }
 */
export function createUhrAdapter(options = {}) {
  const uhr = options.uhr
  if (!uhr || typeof uhr.submit !== 'function') throw new TypeError('createUhrAdapter 需要 uhr 实例（openMockUhr）')
  const clock = typeof options.now === 'function' ? options.now : null
  const fixedAt = Number.isFinite(Number(options.at)) ? Number(options.at) : null
  const nowMs = () => (fixedAt != null ? fixedAt : clock ? Number(clock()) : Date.now())
  const policy = Object.assign({}, DEFAULT_POLICY, isPlain(options.policy) ? options.policy : {})

  function guardToolCall(name, request, connectionIdentity, toolCallId) {
    if (!Object.values(UHR_TOOL).includes(name)) {
      return rejection(UHR_REJECT.BAD_REQUEST, '未知工具名', { reason: 'unknown_tool' })
    }
    // 结果必须能回到原 call ID：空/缺失一律拒绝，且拒绝发生在任何提交之前（零副作用）。
    if (typeof toolCallId !== 'string' || toolCallId.trim() === '') {
      return rejection(UHR_REJECT.BAD_REQUEST, 'toolCallId 必须是非空字符串（结果必须回到原 call ID）')
    }
    if (!isPlain(request)) return rejection(UHR_REJECT.BAD_REQUEST, '工具参数必须是对象')
    const now = nowMs()
    const identity = checkIdentity(connectionIdentity, now, policy)
    if (!identity.ok) return rejection(identity.code, identity.message, identity.details)
    return { ok: true, identity, now }
  }

  function delegateTask(connectionIdentity, request, meta = {}) {
    const toolCallId = meta.toolCallId == null ? (isPlain(request) ? request.toolCallId : undefined) : meta.toolCallId
    const guarded = guardToolCall(UHR_TOOL.DELEGATE, request, connectionIdentity, toStr(toolCallId))
    if (!guarded.ok) return guarded
    const { identity, now } = guarded

    // 1) v2 不透明密文：先于形状检查——密文无论藏在哪个字段，都必须给出明确的"拒绝跨域"码。
    const opaque = detectOpaqueV2(request)
    if (opaque.hits.length) {
      return rejection(UHR_REJECT.V2_OPAQUE, '请求含 v2 不透明密文：拒绝跨域转发（绝不解密）', { reason: 'opaque_v2' })
    }

    // 2) 请求形状：只允许契约字段（多一个都拒绝，防止把对话正文/工作区塞进来）。
    for (const key of Object.keys(request)) {
      if (!REQUEST_KEYS.has(key)) {
        return rejection(UHR_REJECT.SHAPE, 'request 含不允许的字段（只转发有界的任务摘要与引用）', { field: label(key, 40) || 'unknown' })
      }
    }

    // 3) 只读意图。
    const intent = toStr(request.readOnlyIntent).trim()
    if (intent !== 'read_only' || !identity.allowedIntents.includes('read_only')) {
      return rejection(UHR_REJECT.INTENT, '只允许 read_only 意图的委派', { reason: intent ? 'intent_not_allowed' : 'missing_intent' })
    }

    // 4) 有界摘要：默认**不裁剪**（超硬上限即拒绝），只有显式 allowSummaryTruncation 才裁剪并留痕。
    if (request.allowSummaryTruncation != null && typeof request.allowSummaryTruncation !== 'boolean') {
      return rejection(UHR_REJECT.BAD_REQUEST, 'allowSummaryTruncation 必须是布尔值')
    }
    const summary = boundedSummary(request.summary, policy, request.allowSummaryTruncation === true)
    if (!summary.ok) return rejection(summary.code, summary.message, summary.details)

    // 5) 不透明引用。
    const refs = validateRefs(request.refs, identity, policy)
    if (!refs.ok) return rejection(refs.code, refs.message, refs.details)
    const parentRef = request.parentRef == null ? null : toStr(request.parentRef).trim()
    if (parentRef) {
      // parentRef 是"上级任务的引用"，不是文件路径：只允许不透明 id 形状。
      if (!SAFE_ID_RE.test(parentRef) || hasAbsolutePath(parentRef) || SECRET_RE.test(parentRef) || parentRef.split(/[\\/]+/).includes('..')) {
        return rejection(UHR_REJECT.REFS, 'parentRef 必须是上级任务的不透明引用（不得是路径/密钥）', { reason: 'bad_parent_ref' })
      }
    }

    // 6) 预算：必须 > 0，且不超过身份与策略上限；币种必须显式一致。
    if (!isMicro(request.budgetMicro) || request.budgetMicro <= 0) {
      return rejection(UHR_REJECT.BUDGET, 'budgetMicro 必须是正整数最小单位', { reason: 'non_positive' })
    }
    if (request.budgetMicro > identity.maxBudgetMicro || request.budgetMicro > policy.maxBudgetMicro) {
      return rejection(UHR_REJECT.BUDGET, '预算超出身份/策略上限', {
        budgetMicro: request.budgetMicro,
        limitMicro: Math.min(identity.maxBudgetMicro, policy.maxBudgetMicro),
      })
    }
    const currency = normalizeCurrency(request.currency)
    if (!currency) return rejection(UHR_REJECT.BUDGET, '必须显式给 currency', { reason: 'currency_missing' })
    if (currency !== identity.currency) return rejection(UHR_REJECT.BUDGET, '预算币种与连接身份不一致：拒绝隐式换算', { reason: 'currency_mismatch' })

    // 7) 截止时间：不得晚于作用域到期。
    let deadlineAt = Number(request.deadlineAt)
    if (!Number.isFinite(deadlineAt)) {
      const timeMs = Number(request.timeMs)
      if (!Number.isFinite(timeMs) || timeMs <= 0) return rejection(UHR_REJECT.DEADLINE, '缺少截止时间（deadlineAt 或正数 timeMs）', { reason: 'missing_deadline' })
      deadlineAt = now + timeMs
    }
    if (deadlineAt <= now) return rejection(UHR_REJECT.DEADLINE, '截止时间已过', { reason: 'past' })
    if (deadlineAt > identity.expiresAt) return rejection(UHR_REJECT.DEADLINE, '截止时间晚于连接身份到期时间', { reason: 'beyond_scope' })

    // 8) 工具范围：只允许只读工具子集。
    const requestedTools = request.toolScope == null ? [] : request.toolScope
    if (!Array.isArray(requestedTools)) return rejection(UHR_REJECT.TOOL_SCOPE, 'toolScope 必须是数组')
    const allowedTools = identity.allowedToolScope.filter((t) => policy.allowedToolScope.includes(t))
    for (const tool of requestedTools) {
      const name = toStr(tool).trim()
      if (!allowedTools.includes(name)) {
        return rejection(UHR_REJECT.TOOL_SCOPE, '工具不在授权的只读范围内', { reason: 'tool_not_allowed' })
      }
    }

    // 9) 幂等键与摘要：同键同摘要复用，不同摘要冲突。
    const idempotencyKey = toStr(request.idempotencyKey).trim() || ('mcp:' + toStr(toolCallId).trim())
    if (!idempotencyKey) return rejection(UHR_REJECT.BAD_REQUEST, '缺少 idempotencyKey/toolCallId')
    if (idempotencyKey.length > 512) return rejection(UHR_REJECT.BAD_REQUEST, 'idempotencyKey 过长')

    const payloadForDigest = {
      scopeRef: hashRef('scope', identity.scopeRef),
      parentRef,
      refs: refs.value,
      budgetMicro: request.budgetMicro,
      currency,
      deadlineAt,
      toolScope: requestedTools.map((t) => toStr(t).trim()).sort(),
      summary: summary.value,
    }
    const digest = sha256Hex(canonicalJson(payloadForDigest))

    let submitted
    try {
      submitted = uhr.submit({
        idempotencyKey,
        digest,
        ownerRef: identity.ownerRef,
        parentRef,
        refs: refs.value,
        budgetMicro: request.budgetMicro,
        currency,
        deadlineAt,
        toolScope: payloadForDigest.toolScope,
        summary: summary.value,
      })
    } catch (e) {
      if (e && e.code === 'UHR_MOCK_IDEMPOTENCY_CONFLICT') return rejection(UHR_REJECT.CONFLICT, '同一 idempotencyKey 的摘要不同：拒绝重复提交', { taskRef: label(e.detail && e.detail.taskRef, 64) || null })
      if (e && e.code === 'UHR_MOCK_BAD_REQUEST') return rejection(UHR_REJECT.BAD_REQUEST, 'mock UHR 拒绝了委派请求')
      return rejection(UHR_REJECT.BAD_REQUEST, 'mock UHR 调用失败')
    }

    // P06：UHR 委派**永远是外部路径**，不是原生 child thread。结果里显式标注降级，
    // 任何下游（面板/CLI/回执）都不得把它算作原生同会话能力。
    const delegation = { kind: 'external_delegation', native: false, degraded: true, proof: UHR_MCP_CONTRACT }
    const minimalReceipt = {
      contract: UHR_MCP_CONTRACT,
      version: UHR_MCP_VERSION,
      toolCallId: toStr(toolCallId),
      taskRef: submitted.taskRef,
      state: submitted.state,
      duplicate: submitted.duplicate === true,
      executions: submitted.executions,
      callerRef: hashRef('caller', identity.callerRef),
      scopeRef: hashRef('scope', identity.scopeRef),
      budgetMicro: request.budgetMicro,
      currency,
      deadlineAt,
      toolScope: payloadForDigest.toolScope,
      refs: { count: refs.value.length, kinds: refs.kinds },
      summaryDigest: sha256Hex(canonicalJson(summary.value)).slice(0, 24),
      // 裁剪只有在调用方显式 allowSummaryTruncation 时才会发生；这里回执原始/实际字节数，便于对账。
      summaryTruncated: summary.truncated,
      summaryOriginalBytes: summary.originalBytes,
      summaryBytes: summary.bytes,
      delegation,
    }
    return deepFreeze({ ok: true, toolCallId: toStr(toolCallId), taskRef: submitted.taskRef, state: submitted.state, delegation, minimalReceipt })
  }

  function loadTask(identity, taskRef) {
    const ref = toStr(taskRef).trim()
    if (!TASK_REF_RE.test(ref)) return { ok: false, code: UHR_REJECT.BAD_REQUEST, message: 'taskRef 形状非法' }
    let found
    try {
      found = uhr.getResult({ taskRef: ref, ownerRef: identity.ownerRef, grants: identity.grants })
    } catch (e) {
      if (e && e.code === 'UHR_MOCK_NOT_FOUND') return { ok: false, code: UHR_REJECT.NOT_FOUND, message: '没有该 taskRef' }
      if (e && e.code === 'UHR_MOCK_NOT_OWNER') return { ok: false, code: UHR_REJECT.NOT_OWNER, message: '调用者既不是任务拥有者，也没有 scoped grant' }
      return { ok: false, code: UHR_REJECT.BAD_REQUEST, message: 'mock UHR 读取失败' }
    }
    return { ok: true, task: found.task }
  }

  function scrubResultText(text) {
    const raw = toStr(text)
    const redacted = raw.replace(/(^|[^A-Za-z0-9_-])sk-[A-Za-z0-9_-]{8,}/g, (m, lead) => lead + '[redacted]')
    const truncated = redacted.length > policy.maxResultBytes
    return { text: truncated ? redacted.slice(0, policy.maxResultBytes) : redacted, truncated, redacted: redacted !== raw }
  }

  function getTaskResult(connectionIdentity, request, meta = {}) {
    const toolCallId = meta.toolCallId == null ? (isPlain(request) ? request.toolCallId : undefined) : meta.toolCallId
    const guarded = guardToolCall(UHR_TOOL.GET_RESULT, request, connectionIdentity, toStr(toolCallId))
    if (!guarded.ok) return guarded
    const { identity } = guarded
    const loaded = loadTask(identity, request.taskRef)
    if (!loaded.ok) return rejection(loaded.code, loaded.message)
    const task = loaded.task
    const result = task.result ? scrubResultText(task.result.text) : null
    return deepFreeze({
      ok: true,
      toolCallId: toStr(toolCallId),
      taskRef: task.taskRef,
      state: task.state,
      expired: task.expired === true,
      executions: task.executions,
      result: result ? { text: result.text, truncated: result.truncated, redacted: result.redacted } : null,
      delegation: { kind: 'external_delegation', native: false, degraded: true, proof: UHR_MCP_CONTRACT },
      receipts: { refsCount: task.refsCount, refKinds: task.refKinds, budgetMicro: task.budgetMicro, currency: task.currency },
    })
  }

  function cancelTask(connectionIdentity, request, meta = {}) {
    const toolCallId = meta.toolCallId == null ? (isPlain(request) ? request.toolCallId : undefined) : meta.toolCallId
    const guarded = guardToolCall(UHR_TOOL.CANCEL, request, connectionIdentity, toStr(toolCallId))
    if (!guarded.ok) return guarded
    const { identity } = guarded
    const loaded = loadTask(identity, request.taskRef)
    if (!loaded.ok) return rejection(loaded.code, loaded.message)
    if (request.reason != null && (typeof request.reason !== 'string' || SECRET_RE.test(request.reason) || hasAbsolutePath(request.reason))) {
      return rejection(UHR_REJECT.BAD_REQUEST, '取消原因必须是普通字符串（不含密钥/路径）')
    }
    let cancelled
    try {
      cancelled = uhr.cancel({ taskRef: loaded.task.taskRef, ownerRef: identity.ownerRef, grants: identity.grants })
    } catch (e) {
      if (e && e.code === 'UHR_MOCK_TASK_TERMINAL') return rejection(UHR_REJECT.STATE, '任务已终态，无法取消')
      return rejection(UHR_REJECT.BAD_REQUEST, 'mock UHR 取消失败')
    }
    return deepFreeze({
      ok: true,
      toolCallId: toStr(toolCallId),
      taskRef: cancelled.taskRef,
      state: cancelled.state,
      duplicate: cancelled.duplicate === true,
      delegation: { kind: 'external_delegation', native: false, degraded: true, proof: UHR_MCP_CONTRACT },
    })
  }

  /** MCP 工具描述（inputSchema 只描述契约字段；不含实现细节）。 */
  function toolDefinitions() {
    return deepFreeze([
      {
        name: UHR_TOOL.DELEGATE,
        description: '把只读任务委派给 UHR（仅限有界摘要与不透明引用；预算/截止由调用者身份约束）',
        inputSchema: {
          type: 'object',
          required: ['readOnlyIntent', 'budgetMicro', 'currency', 'summary'],
          properties: {
            readOnlyIntent: { type: 'string', enum: ['read_only'] },
            budgetMicro: { type: 'integer', minimum: 1 },
            currency: { type: 'string' },
            timeMs: { type: 'integer', minimum: 1 },
            deadlineAt: { type: 'integer' },
            toolScope: { type: 'array', items: { type: 'string' } },
            summary: { type: 'object', properties: { title: { type: 'string' }, goal: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } } },
            refs: { type: 'array', items: { type: 'object', required: ['kind', 'ref'], properties: { kind: { type: 'string' }, ref: { type: 'string' } } } },
            parentRef: { type: 'string' },
            idempotencyKey: { type: 'string' },
          },
        },
      },
      {
        name: UHR_TOOL.GET_RESULT,
        description: '读取已委派任务的状态/结果（需要拥有该 taskRef 或有 scoped grant）',
        inputSchema: { type: 'object', required: ['taskRef'], properties: { taskRef: { type: 'string' } } },
      },
      {
        name: UHR_TOOL.CANCEL,
        description: '取消已委派任务（幂等；需要拥有该 taskRef 或有 scoped grant）',
        inputSchema: { type: 'object', required: ['taskRef'], properties: { taskRef: { type: 'string' }, reason: { type: 'string' } } },
      },
    ])
  }

  /** MCP 工具调用入口：结果必须回到原 toolCallId（原样回填，不改写）。 */
  function handleToolCall(call = {}) {
    const name = toStr(call.name)
    const toolCallId = call.toolCallId == null ? '' : toStr(call.toolCallId)
    const args = isPlain(call.arguments) ? call.arguments : {}
    const identity = call.connectionIdentity
    let outcome
    try {
      if (name === UHR_TOOL.DELEGATE) outcome = delegateTask(identity, args, { toolCallId })
      else if (name === UHR_TOOL.GET_RESULT) outcome = getTaskResult(identity, args, { toolCallId })
      else if (name === UHR_TOOL.CANCEL) outcome = cancelTask(identity, args, { toolCallId })
      else outcome = rejection(UHR_REJECT.BAD_REQUEST, '未知工具名', { reason: 'unknown_tool' })
    } catch {
      outcome = rejection(UHR_REJECT.BAD_REQUEST, '工具调用内部错误（已收敛，不外泄细节）')
    }
    const payload = outcome
    return deepFreeze({
      toolCallId,
      isError: outcome.ok !== true,
      structuredContent: payload,
      content: [{ type: 'text', text: JSON.stringify(payload) }],
    })
  }

  return {
    contract: UHR_MCP_CONTRACT,
    version: UHR_MCP_VERSION,
    delegateTask,
    getTaskResult,
    cancelTask,
    handleToolCall,
    toolDefinitions,
    policy: deepFreeze(Object.assign({}, policy)),
    taskRefToken,
  }
}
