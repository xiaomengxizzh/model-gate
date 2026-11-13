// G2/G3：OpenCode Go 本地 MCP 委派契约（纯模块：无 IO、无网络、无时钟副作用）。
//
// 契约文档：docs/contracts/modelgate-mcp-delegation-v1.md
// 实现对齐记录：docs/contracts/modelgate-mcp-delegation-v1-alignment.md（本文与实现的差异以此为准）
//
// 定位（诚实性要求）：这是**工具驱动的外部 worker 委派**，不是 Codex 原生 `spawn_agent` 跨供应商子线程。
// GPT 父模型由用户自己的 Codex 官方客户端直连官方服务；ModelGate 只在本机作为 stdio MCP server
// 接收显式、可审计的工具参数，用 OpenCode Go 自己的凭据执行子任务，再把完整结果回执给父模型。
//
// 硬边界：
//   · 工具参数**不能**指定 URL / provider host / 凭据 / 任意 model；provider 与 model 由服务端 allowlist 决定。
//   · 任务正文有硬字节上限；超限一律拒绝，不静默截断（截断只能显式声明并留 lossy 记录）。
//   · V2 密文键（encrypted_content / encrypted_task_id / opaque_v2 ...）在参数层直接 fail-closed：
//     不解密、不伪造、不删除、不降级 v1。

import { createHash } from 'node:crypto'

export const MCP_CONTRACT = 'modelgate-mcp-delegation-v1'
export const MCP_CONTRACT_VERSION = 1
export const SERVER_NAME = 'modelgate-mcp-delegation'
export const SERVER_VERSION = '0.1.0'

/** 任务状态机（方案 §3.4）。终态之后只允许 READY→ACKNOWLEDGED。UNKNOWN 需对账，不算成功终态。 */
export const STATES = Object.freeze({
  CREATED: 'CREATED',
  ADMITTED: 'ADMITTED',
  DISPATCHED: 'DISPATCHED',
  RUNNING: 'RUNNING',
  RESULT_READY: 'RESULT_READY',
  ACKNOWLEDGED: 'ACKNOWLEDGED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  UNKNOWN: 'UNKNOWN',
})
export const STATE_VALUES = Object.freeze(Object.values(STATES))
export const TERMINAL_STATES = Object.freeze([STATES.RESULT_READY, STATES.ACKNOWLEDGED, STATES.FAILED, STATES.CANCELLED, STATES.UNKNOWN])
/** 未确认送达/未收终态：重启后必须对账成 UNKNOWN，不得重发。 */
export const IN_FLIGHT_STATES = Object.freeze([STATES.DISPATCHED, STATES.RUNNING])
export const isTerminal = (s) => TERMINAL_STATES.includes(s)
export const isInFlight = (s) => IN_FLIGHT_STATES.includes(s)

/** 稳定错误码（契约 §9，发出即稳定：不改名、不复用、不删除）。 */
export const ERRORS = Object.freeze({
  // 通道 A（JSON-RPC error）
  PARSE_ERROR: 'MCP_PARSE_ERROR',
  INVALID_REQUEST: 'MCP_INVALID_REQUEST',
  METHOD_NOT_FOUND: 'MCP_METHOD_NOT_FOUND',
  UNKNOWN_TOOL: 'MCP_UNKNOWN_TOOL',
  PROTOCOL_VERSION_UNSUPPORTED: 'MCP_PROTOCOL_VERSION_UNSUPPORTED',
  SERVER_NOT_INITIALIZED: 'MCP_SERVER_NOT_INITIALIZED',
  BATCH_UNSUPPORTED: 'MCP_BATCH_UNSUPPORTED',
  FRAME_TOO_LARGE: 'MCP_FRAME_TOO_LARGE',
  INTERNAL: 'MCP_INTERNAL',
  // 通道 B（工具结果 isError）
  BAD_REQUEST: 'MCP_INVALID_ARGUMENTS',
  TOO_LARGE: 'MCP_ARGUMENT_TOO_LARGE',
  IDEM_KEY_INVALID: 'MCP_IDEMPOTENCY_KEY_INVALID',
  IDEM_CONFLICT: 'MCP_IDEMPOTENCY_CONFLICT',
  URL_NOT_ALLOWED: 'MCP_URL_NOT_ALLOWED',
  CREDENTIAL_IN_ARGUMENT: 'MCP_CREDENTIAL_IN_ARGUMENT',
  SECRET_REJECTED: 'MCP_SECRET_IN_ARGUMENT',
  OPAQUE_V2: 'MCP_V2_OPAQUE',
  WORKSPACE_DENIED: 'MCP_WORKSPACE_DENIED',
  TOOL_POLICY_DENIED: 'MCP_TOOL_POLICY_DENIED',
  BUDGET_INVALID: 'MCP_BUDGET_INVALID',
  PROVIDER_NOT_ALLOWED: 'MCP_PROVIDER_NOT_ALLOWED',
  MODEL_NOT_ALLOWED: 'MCP_MODEL_NOT_ALLOWED',
  TASK_NOT_FOUND: 'MCP_TASK_NOT_FOUND',
  NOT_OWNER: 'MCP_NOT_OWNER',
  STATE_CONFLICT: 'MCP_TASK_STATE_INVALID',
  FOLLOWUP_CONFLICT: 'MCP_FOLLOWUP_CONFLICT',
  BUSY: 'MCP_BUSY',
  UPSTREAM_UNAVAILABLE: 'MCP_UPSTREAM_UNAVAILABLE',
  UPSTREAM_AUTH_FAILED: 'MCP_UPSTREAM_AUTH_FAILED',
  UPSTREAM_RATE_LIMITED: 'MCP_UPSTREAM_RATE_LIMITED',
  UPSTREAM_TIMEOUT: 'MCP_UPSTREAM_TIMEOUT',
  UPSTREAM_PROTOCOL: 'MCP_UPSTREAM_PROTOCOL',
  UPSTREAM_ERROR: 'MCP_UPSTREAM_ERROR',
  UPSTREAM_UNKNOWN: 'MCP_UNKNOWN_OUTCOME',
  RESULT_UNAVAILABLE: 'MCP_RESULT_UNAVAILABLE',
  STORE_IO: 'MCP_STORE_UNAVAILABLE',
  STORE_CORRUPT: 'MCP_STORE_UNAVAILABLE',
  TOOL_EXEC_FAILED: 'MCP_TOOL_EXEC_FAILED',
  // 追加：进程重启前尚未写入上游（ADMITTED/CREATED）。未发生网络写入，因此不是 UNKNOWN。
  INTERRUPTED_BEFORE_DISPATCH: 'MCP_INTERRUPTED_BEFORE_DISPATCH',
})

/** 上限：一律按 UTF-8 字节计，避免多字节字符把限制放大。 */
export const LIMITS = Object.freeze({
  taskBytes: 64 * 1024,
  constraintsBytes: 4 * 1024,
  titleBytes: 512,
  idempotencyKeyBytes: 128,
  idempotencyKeyMin: 8,
  parentThreadIdBytes: 128,
  maxRefs: 16,
  refPathBytes: 512,
  maxResultBytes: 64 * 1024,
  maxOutputPerCall: 32 * 1024,
  waitDefaultMs: 15_000,
  waitMaxMs: 60_000,
  budgetMsDefault: 300_000,
  budgetMsMin: 1_000,
  budgetMsMax: 1_800_000,
  maxStepsDefault: 8,
  maxStepsCap: 16,
  busyInFlight: 8,
  maxLineBytes: 1024 * 1024,
})

export const TOOL_NAMES = Object.freeze({
  DELEGATE: 'modelgate_delegate_task',
  GET: 'modelgate_get_task',
  WAIT: 'modelgate_wait_task',
  FOLLOWUP: 'modelgate_followup_task',
  CANCEL: 'modelgate_cancel_task',
})

// 委派请求顶层允许的键：多一个都拒绝（防止顺手把 provider/url/key 塞进工具参数）。
const DELEGATE_KEYS = new Set(['task', 'title', 'constraints', 'workspaceRefs', 'budgetMs', 'parentThreadId', 'idempotencyKey', 'allowResultTruncation', 'reasoningEffort'])
const FOLLOWUP_KEYS = new Set(['taskRef', 'task', 'constraints', 'budgetMs', 'idempotencyKey', 'allowResultTruncation'])
const GET_KEYS = new Set(['taskRef', 'includeResult'])
const WAIT_KEYS = new Set(['taskRef', 'timeoutMs', 'includeResult'])
const CANCEL_KEYS = new Set(['taskRef', 'reason'])
const REF_KEYS = new Set(['path', 'kind'])
const REF_KINDS = new Set(['file', 'dir'])
const GO_EFFORTS = new Set(['low', 'high', 'max'])

// 契约 §8 拒绝优先级：V2 密文键 → 凭据键 → 目标 URL 键 → provider/model 键 → 值级凭据形状 → schema。
const KEY_GROUPS = [
  {
    code: 'OPAQUE_V2',
    label: 'V2 密文',
    keys: new Set(['encrypted_content', 'encrypted_task_id', 'encrypted_payload', 'opaque_v2', 'encrypted']),
  },
  {
    code: 'CREDENTIAL_IN_ARGUMENT',
    label: '凭据',
    keys: new Set(['apikey', 'api_key', 'authorization', 'auth', 'token', 'cookie', 'headers', 'secret', 'password', 'credential', 'credentials']),
  },
  {
    code: 'URL_NOT_ALLOWED',
    label: '目标地址',
    keys: new Set(['url', 'uri', 'host', 'baseurl', 'base_url', 'endpoint', 'pathprefix', 'proxy', 'origin']),
  },
  {
    code: 'PROVIDER_NOT_ALLOWED',
    label: 'provider',
    keys: new Set(['provider', 'providerid', 'provider_id', 'upstream']),
  },
  {
    code: 'MODEL_NOT_ALLOWED',
    label: 'model',
    keys: new Set(['model', 'modelid', 'model_id', 'upstreammodel', 'upstream_model']),
  },
]

const SECRET_VALUE_RE = /(^|[^A-Za-z0-9_-])(sk-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|bearer\s+[A-Za-z0-9._~+/=-]{16,}|api[_-]?key\s*[=:]|password\s*[=:])/i
const TASK_REF_RE = /^mgtask-[0-9a-f]{16}$/
const IDEM_RE = /^[A-Za-z0-9_.:-]{8,128}$/

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
export const byteLen = (v) => Buffer.byteLength(String(v == null ? '' : v), 'utf8')

export function taskRefFor(seed) {
  return 'mgtask-' + createHash('sha256').update(String(seed)).digest('hex').slice(0, 16)
}
export function turnRefFor(seed) {
  return 'mgturn-' + createHash('sha256').update(String(seed)).digest('hex').slice(0, 16)
}
/** ownerRef：由配置目录绝对路径 + OS 用户名派生，跨重启稳定；模型不可控制。 */
export function ownerRefFor(parts) {
  const p = parts || {}
  const canon = 'owner:' + String(p.configDir || '') + ':' + String(p.user || '')
  return 'mgowner-' + createHash('sha256').update(canon).digest('hex').slice(0, 16)
}
export const isTaskRef = (v) => typeof v === 'string' && TASK_REF_RE.test(v)

/** 规范化摘要：键排序后的 canonical JSON。 */
export function digestOf(value) {
  const canon = (v) => {
    if (v == null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v)
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']'
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort()
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}'
  }
  return createHash('sha256').update(canon(value)).digest('hex')
}

/** 结果回执摘要（契约 §4.4）：**不含 state**，因此 ACK 前后保持一致。 */
export function resultDigestOf(parts) {
  const p = parts || {}
  if (p.resultText == null || String(p.resultText) === '') return null
  return digestOf({
    artifacts: p.artifacts || [],
    model: p.model || null,
    provider: p.provider || null,
    resultText: String(p.resultText),
    taskRef: p.taskRef || null,
    turnRef: p.turnRef || null,
  })
}

/** 幂等键落盘形态：只存哈希，明文键不落盘（契约 §6.2）。 */
export function idemKeyHash(ownerRef, key) {
  return createHash('sha256').update(String(ownerRef) + ':' + String(key)).digest('hex').slice(0, 32)
}

function fail(code, message, details) {
  return { ok: false, error: Object.assign({ code, message: String(message || code) }, details || {}) }
}

function rejectUnknownKeys(args, allowed) {
  for (const k of Object.keys(args)) {
    if (!allowed.has(k)) return fail(ERRORS.BAD_REQUEST, '不接受的参数：' + k + '（工具参数不能控制 provider/url/凭据/model）', { field: k })
  }
  return null
}

/** 按契约 §8 优先级扫描任意层级的键名；命中即零提交。 */
export function scanForbiddenKeys(value, path = '$', depth = 0) {
  if (depth > 8) return fail(ERRORS.BAD_REQUEST, '参数嵌套过深', { field: path })
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const r = scanForbiddenKeys(value[i], path + '[' + i + ']', depth + 1)
      if (r) return r
    }
    return null
  }
  if (!isObject(value)) return null
  // 同一层内按优先级顺序扫描，保证拒绝码稳定（不依赖 object 键顺序）。
  for (const group of KEY_GROUPS) {
    for (const k of Object.keys(value)) {
      if (!group.keys.has(String(k).toLowerCase())) continue
      const code = group.code === 'OPAQUE_V2' ? ERRORS.OPAQUE_V2
        : group.code === 'CREDENTIAL_IN_ARGUMENT' ? ERRORS.CREDENTIAL_IN_ARGUMENT
          : group.code === 'URL_NOT_ALLOWED' ? ERRORS.URL_NOT_ALLOWED
            : group.code === 'PROVIDER_NOT_ALLOWED' ? ERRORS.PROVIDER_NOT_ALLOWED
              : ERRORS.MODEL_NOT_ALLOWED
      return fail(code, '参数 ' + path + '.' + k + ' 属于「' + group.label + '」：网关不接受该字段（零提交）', { field: path + '.' + k })
    }
  }
  for (const [k, v] of Object.entries(value)) {
    const r = scanForbiddenKeys(v, path + '.' + k, depth + 1)
    if (r) return r
  }
  return null
}

function scanSecretValues(value, path = '$', depth = 0) {
  if (depth > 8) return null
  if (typeof value === 'string') {
    if (SECRET_VALUE_RE.test(value)) return fail(ERRORS.SECRET_REJECTED, '参数 ' + path + ' 含疑似凭据片段：拒绝入队/入日志', { field: path })
    return null
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const r = scanSecretValues(value[i], path + '[' + i + ']', depth + 1)
      if (r) return r
    }
    return null
  }
  if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      const r = scanSecretValues(v, path + '.' + k, depth + 1)
      if (r) return r
    }
  }
  return null
}

function parseCommon(args) {
  const forbidden = scanForbiddenKeys(args, 'arguments')
  if (forbidden) return forbidden
  return scanSecretValues(args, 'arguments')
}

function parseText(args, key, limitBytes, required) {
  const raw = args[key]
  if (raw === undefined || raw === null) {
    if (required) return fail(ERRORS.BAD_REQUEST, '缺少必填参数 ' + key, { field: key, reason: 'required' })
    return { ok: true, value: null }
  }
  if (typeof raw !== 'string') return fail(ERRORS.BAD_REQUEST, key + ' 必须是字符串', { field: key })
  if (raw.trim() === '') return fail(ERRORS.BAD_REQUEST, key + ' 不得为空', { field: key })
  const bytes = byteLen(raw)
  if (bytes > limitBytes) {
    return fail(ERRORS.TOO_LARGE, key + ' 超限：' + bytes + ' 字节 > ' + limitBytes + '（不静默截断）', { field: key, bytes, limit: limitBytes })
  }
  return { ok: true, value: raw, bytes }
}

function parseBudgetMs(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: LIMITS.budgetMsDefault }
  const n = Number(raw)
  if (!Number.isFinite(n) || Math.trunc(n) !== n) return fail(ERRORS.BUDGET_INVALID, 'budgetMs 必须是整数毫秒', { field: 'budgetMs' })
  if (n < LIMITS.budgetMsMin || n > LIMITS.budgetMsMax) {
    return fail(ERRORS.BUDGET_INVALID, 'budgetMs 必须在 ' + LIMITS.budgetMsMin + '..' + LIMITS.budgetMsMax + ' 之间', { field: 'budgetMs', limit: LIMITS.budgetMsMax })
  }
  return { ok: true, value: n }
}

function parseIdempotencyKey(raw, required) {
  if (raw === undefined || raw === null || raw === '') {
    if (required) return fail(ERRORS.BAD_REQUEST, '缺少必填参数 idempotencyKey（无幂等键无法保证不重复派发）', { field: 'idempotencyKey', reason: 'required' })
    return { ok: true, value: null }
  }
  if (typeof raw !== 'string' || !IDEM_RE.test(raw)) {
    return fail(ERRORS.IDEM_KEY_INVALID, 'idempotencyKey 形状非法：^[A-Za-z0-9_.:-]{8,128}$', { field: 'idempotencyKey' })
  }
  return { ok: true, value: raw }
}

function parseRefs(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: [] }
  if (!Array.isArray(raw)) return fail(ERRORS.BAD_REQUEST, 'workspaceRefs 必须是数组', { field: 'workspaceRefs' })
  if (raw.length > LIMITS.maxRefs) return fail(ERRORS.TOO_LARGE, 'workspaceRefs 最多 ' + LIMITS.maxRefs + ' 条', { field: 'workspaceRefs', limit: LIMITS.maxRefs })
  const out = []
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i]
    if (!isObject(r)) return fail(ERRORS.BAD_REQUEST, 'workspaceRefs[' + i + '] 必须是对象', { field: 'workspaceRefs[' + i + ']' })
    for (const k of Object.keys(r)) {
      if (!REF_KEYS.has(k)) return fail(ERRORS.BAD_REQUEST, 'workspaceRefs[' + i + '] 不接受的键：' + k, { field: 'workspaceRefs[' + i + '].' + k })
    }
    if (typeof r.path !== 'string' || r.path.trim() === '') return fail(ERRORS.BAD_REQUEST, 'workspaceRefs[' + i + '].path 必填非空字符串', { field: 'workspaceRefs[' + i + '].path' })
    if (byteLen(r.path) > LIMITS.refPathBytes) return fail(ERRORS.TOO_LARGE, 'workspaceRefs[' + i + '].path 超长', { field: 'workspaceRefs[' + i + '].path', limit: LIMITS.refPathBytes })
    const kind = r.kind === undefined ? 'file' : r.kind
    if (!REF_KINDS.has(kind)) return fail(ERRORS.BAD_REQUEST, 'workspaceRefs[' + i + '].kind 只能是 file/dir', { field: 'workspaceRefs[' + i + '].kind' })
    if (r.path.startsWith('/') || r.path.startsWith('~') || /^[A-Za-z]:[\\/]/.test(r.path) || /^[a-z]+:\/\//i.test(r.path) || r.path.split(/[\\/]/).includes('..')) {
      return fail(ERRORS.WORKSPACE_DENIED, 'workspaceRefs[' + i + '].path 必须是工作区内的相对路径：' + r.path, { field: 'workspaceRefs[' + i + '].path', reason: 'path_not_allowed' })
    }
    out.push({ path: r.path, kind })
  }
  return { ok: true, value: out }
}

function parseEffort(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: null }
  const v = String(raw).toLowerCase()
  if (!GO_EFFORTS.has(v)) return fail(ERRORS.BAD_REQUEST, '未知推理档位：' + raw + '（Go 已证实：low/high/max）', { field: 'reasoningEffort', allowed: ['low', 'high', 'max'] })
  return { ok: true, value: v }
}

/** 解析 modelgate_delegate_task 入参。 */
export function parseDelegateArgs(raw) {
  if (!isObject(raw)) return fail(ERRORS.BAD_REQUEST, '工具参数必须是对象', { field: 'arguments' })
  let r = parseCommon(raw); if (r) return r
  r = rejectUnknownKeys(raw, DELEGATE_KEYS); if (r) return r
  const task = parseText(raw, 'task', LIMITS.taskBytes, true); if (!task.ok) return task
  const title = parseText(raw, 'title', LIMITS.titleBytes, false); if (!title.ok) return title
  const constraints = parseText(raw, 'constraints', LIMITS.constraintsBytes, false); if (!constraints.ok) return constraints
  const refs = parseRefs(raw.workspaceRefs); if (!refs.ok) return refs
  const budget = parseBudgetMs(raw.budgetMs); if (!budget.ok) return budget
  const idem = parseIdempotencyKey(raw.idempotencyKey, true); if (!idem.ok) return idem
  const effort = parseEffort(raw.reasoningEffort); if (!effort.ok) return effort
  if (raw.parentThreadId !== undefined && raw.parentThreadId !== null && byteLen(raw.parentThreadId) > LIMITS.parentThreadIdBytes) {
    return fail(ERRORS.BAD_REQUEST, 'parentThreadId 超长', { field: 'parentThreadId', limit: LIMITS.parentThreadIdBytes })
  }
  const value = {
    task: task.value,
    title: title.value,
    constraints: constraints.value,
    workspaceRefs: refs.value,
    budgetMs: budget.value,
    parentThreadId: typeof raw.parentThreadId === 'string' ? raw.parentThreadId : null,
    idempotencyKey: idem.value,
    reasoningEffort: effort.value,
    allowResultTruncation: raw.allowResultTruncation === true,
  }
  // 幂等摘要 = 任务正文 + 约束 + 引用（不含 budgetMs/effort：预算与档位不是任务身份）。
  value.requestDigest = digestOf({ task: value.task, constraints: value.constraints, refs: value.workspaceRefs })
  return { ok: true, value }
}

export function parseFollowupArgs(raw) {
  if (!isObject(raw)) return fail(ERRORS.BAD_REQUEST, '工具参数必须是对象', { field: 'arguments' })
  let r = parseCommon(raw); if (r) return r
  r = rejectUnknownKeys(raw, FOLLOWUP_KEYS); if (r) return r
  if (!isTaskRef(raw.taskRef)) return fail(ERRORS.BAD_REQUEST, 'taskRef 形状非法（mgtask-<16hex>）', { field: 'taskRef' })
  const task = parseText(raw, 'task', LIMITS.taskBytes, true); if (!task.ok) return task
  const constraints = parseText(raw, 'constraints', LIMITS.constraintsBytes, false); if (!constraints.ok) return constraints
  const budget = parseBudgetMs(raw.budgetMs); if (!budget.ok) return budget
  const idem = parseIdempotencyKey(raw.idempotencyKey, true); if (!idem.ok) return idem
  const value = {
    taskRef: raw.taskRef,
    task: task.value,
    constraints: constraints.value,
    budgetMs: budget.value,
    idempotencyKey: idem.value,
    allowResultTruncation: raw.allowResultTruncation === true,
  }
  value.requestDigest = digestOf({ task: value.task, constraints: value.constraints })
  return { ok: true, value }
}

export function parseGetArgs(raw) {
  if (!isObject(raw)) return fail(ERRORS.BAD_REQUEST, '工具参数必须是对象', { field: 'arguments' })
  let r = parseCommon(raw); if (r) return r
  r = rejectUnknownKeys(raw, GET_KEYS); if (r) return r
  if (!isTaskRef(raw.taskRef)) return fail(ERRORS.BAD_REQUEST, 'taskRef 形状非法（mgtask-<16hex>）', { field: 'taskRef' })
  return { ok: true, value: { taskRef: raw.taskRef, includeResult: raw.includeResult !== false } }
}

export function parseWaitArgs(raw) {
  if (!isObject(raw)) return fail(ERRORS.BAD_REQUEST, '工具参数必须是对象', { field: 'arguments' })
  let r = parseCommon(raw); if (r) return r
  r = rejectUnknownKeys(raw, WAIT_KEYS); if (r) return r
  if (!isTaskRef(raw.taskRef)) return fail(ERRORS.BAD_REQUEST, 'taskRef 形状非法（mgtask-<16hex>）', { field: 'taskRef' })
  let timeoutMs = LIMITS.waitDefaultMs
  if (raw.timeoutMs !== undefined && raw.timeoutMs !== null) {
    const n = Number(raw.timeoutMs)
    if (!Number.isFinite(n) || n < 0) return fail(ERRORS.BAD_REQUEST, 'timeoutMs 必须是非负整数', { field: 'timeoutMs' })
    timeoutMs = Math.min(Math.trunc(n), LIMITS.waitMaxMs)
  }
  return { ok: true, value: { taskRef: raw.taskRef, timeoutMs, includeResult: raw.includeResult !== false } }
}

export function parseCancelArgs(raw) {
  if (!isObject(raw)) return fail(ERRORS.BAD_REQUEST, '工具参数必须是对象', { field: 'arguments' })
  let r = parseCommon(raw); if (r) return r
  r = rejectUnknownKeys(raw, CANCEL_KEYS); if (r) return r
  if (!isTaskRef(raw.taskRef)) return fail(ERRORS.BAD_REQUEST, 'taskRef 形状非法（mgtask-<16hex>）', { field: 'taskRef' })
  const reason = typeof raw.reason === 'string' ? raw.reason.slice(0, 200) : null
  return { ok: true, value: { taskRef: raw.taskRef, reason } }
}

/** 结果文本脱敏 + 上限处理。默认**不**静默裁剪（用户要求完整回执），只有显式允许才截断。 */
export function sanitizeResultText(text, opts = {}) {
  const raw = String(text == null ? '' : text)
  const limit = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : LIMITS.maxResultBytes
  const scrubbed = raw
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, 'sk-***')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'Bearer ***')
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '***')
  const bytes = byteLen(scrubbed)
  if (bytes <= limit) return { text: scrubbed, truncated: false, bytes, limit }
  if (opts.allowTruncation !== true) return { text: scrubbed, truncated: false, bytes, limit, overLimit: true }
  let cut = scrubbed
  while (byteLen(cut) > limit && cut.length > 0) cut = cut.slice(0, Math.floor(cut.length * 0.95) || 0)
  return { text: cut, truncated: true, bytes, limit }
}

function schema(properties, required) {
  return { type: 'object', properties, required, additionalProperties: false }
}
const S = {
  taskRef: { type: 'string', pattern: '^mgtask-[0-9a-f]{16}$', description: '委派任务引用（delegate/followup 返回）' },
  task: { type: 'string', description: '显式任务正文（纯文本）。不允许携带加密信封或凭据。' },
  constraints: { type: 'string', description: '任务约束（可选，纯文本，<=4KiB）' },
  idempotencyKey: { type: 'string', pattern: '^[A-Za-z0-9_.:-]{8,128}$', description: '幂等键：同 key + 同正文只产生一次派发' },
}

/** MCP tools/list 的稳定描述（实现与测试共用同一真源）。 */
export function toolDefinitions() {
  return [
    {
      name: TOOL_NAMES.DELEGATE,
      description: '在本机创建一个 OpenCode Go 子任务（外部 worker 委派，非 Codex 原生 spawn_agent）。立即返回 taskRef，用 modelgate_wait_task 收取结果。',
      inputSchema: schema({
        task: S.task,
        title: { type: 'string', description: '任务短标题（可选）' },
        constraints: S.constraints,
        workspaceRefs: {
          type: 'array',
          maxItems: LIMITS.maxRefs,
          description: '工作区内相对路径引用；服务端在任务前后计算 sha256 以证明真实改动',
          items: schema({ path: { type: 'string' }, kind: { type: 'string', enum: ['file', 'dir'] } }, ['path']),
        },
        budgetMs: { type: 'integer', minimum: LIMITS.budgetMsMin, maximum: LIMITS.budgetMsMax, description: '任务总预算毫秒' },
        parentThreadId: { type: 'string', description: '父会话标识（可选；只用于派生不透明 session，不转发原文）' },
        idempotencyKey: S.idempotencyKey,
        reasoningEffort: { type: 'string', enum: ['low', 'high', 'max'], description: '推理档位（可选）' },
        allowResultTruncation: { type: 'boolean', description: '显式允许超限结果截断（默认 false：完整回执）' },
      }, ['task', 'idempotencyKey']),
    },
    {
      name: TOOL_NAMES.GET,
      description: '查询任务当前状态与结果摘要（不等待）。首次返回结果即把任务推进到 ACKNOWLEDGED。',
      inputSchema: schema({ taskRef: S.taskRef, includeResult: { type: 'boolean' } }, ['taskRef']),
    },
    {
      name: TOOL_NAMES.WAIT,
      description: '有界等待任务终态。等待超时只代表本次等待窗口结束，不代表任务失败。',
      inputSchema: schema({
        taskRef: S.taskRef,
        timeoutMs: { type: 'integer', minimum: 0, maximum: LIMITS.waitMaxMs },
        includeResult: { type: 'boolean' },
      }, ['taskRef']),
    },
    {
      name: TOOL_NAMES.FOLLOWUP,
      description: '在同一个 Go session 上向同一子任务追派下一轮（复用原 taskRef 与 session）。',
      inputSchema: schema({ taskRef: S.taskRef, task: S.task, constraints: S.constraints, budgetMs: { type: 'integer' }, idempotencyKey: S.idempotencyKey, allowResultTruncation: { type: 'boolean' } }, ['taskRef', 'task', 'idempotencyKey']),
    },
    {
      name: TOOL_NAMES.CANCEL,
      description: '取消任务（幂等）。返回取消是否真正到达上游；已发出的上游是否停止可能未知。',
      inputSchema: schema({ taskRef: S.taskRef, reason: { type: 'string' } }, ['taskRef']),
    },
  ]
}
