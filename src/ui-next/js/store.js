// Application state, data loading, and light pub/sub. Views never fetch directly.
import { api, ApiError, clearToken, setUnauthorizedHandler } from './api.js'

// 数据阶段：idle / loading / ready / empty / error。unknown 由视图在“字段缺失”时显式渲染，
// 绝不允许把 unknown 渲染成 0 或“正常”。
export const DATA_PHASES = ['idle', 'loading', 'ready', 'empty', 'error']
export const state = {
  auth: { needAuth: false, startedAt: 0 },
  status: null,
  config: null,
  loadedAt: 0,
  lastError: null,
  loading: false,
  view: 'overview',
  phase: { auth: 'idle', status: 'idle', config: 'idle', logs: 'idle' },
}

const listeners = new Map()

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set())
  listeners.get(event).add(fn)
  return () => { listeners.get(event)?.delete(fn) }
}
export function emit(event, payload) {
  for (const fn of listeners.get(event) || []) { try { fn(payload) } catch (e) { console.error(e) } }
}

export function phaseOf(key) { return (state.phase && state.phase[key]) || 'idle' }
export function isPhase(key, value) { return phaseOf(key) === value }
export function setPhase(key, phase) {
  if (!DATA_PHASES.includes(phase)) throw new Error('unknown phase: ' + phase)
  if (!state.phase) state.phase = {}
  state.phase[key] = phase
  emit('phase', { key, phase })
}

export async function loadAuth() {
  setPhase('auth', 'loading')
  try {
    const data = await api.auth()
    state.auth = { needAuth: !!data.needAuth, startedAt: Number(data.startedAt) || 0 }
    setPhase('auth', 'ready')
    return state.auth
  } catch (e) {
    setPhase('auth', 'error')
    throw e
  }
}

export async function loadStatus(opts = {}) {
  if (!opts.silent) setPhase('status', 'loading')
  try {
    const status = await api.status()
    state.status = status
    state.loadedAt = Date.now()
    state.lastError = null
    if (!opts.silent) setPhase('status', status ? 'ready' : 'empty')
    emit('status', status)
    return status
  } catch (e) {
    state.lastError = e
    if (!opts.silent) setPhase('status', 'error')
    throw e
  }
}

export async function loadConfig() {
  setPhase('config', 'loading')
  try {
    const config = await api.config()
    state.config = config
    setPhase('config', config ? 'ready' : 'empty')
    emit('config', config)
    return config
  } catch (e) {
    state.lastError = e
    setPhase('config', 'error')
    throw e
  }
}

export async function loadAll() {
  state.loading = true
  setPhase('status', 'loading')
  setPhase('config', 'loading')
  try {
    const [status, config] = await Promise.all([api.status(), api.config()])
    state.status = status
    state.config = config
    state.loadedAt = Date.now()
    state.lastError = null
    setPhase('status', status ? 'ready' : 'empty')
    setPhase('config', config ? 'ready' : 'empty')
    emit('status', status)
    emit('config', config)
    emit('data', { status, config })
    return { status, config }
  } catch (e) {
    state.lastError = e
    setPhase('status', 'error')
    setPhase('config', 'error')
    emit('error', e)
    throw e
  } finally {
    state.loading = false
  }
}

export function resetData() {
  state.status = null
  state.config = null
  state.loadedAt = 0
  state.lastError = null
  state.phase = { auth: state.auth ? 'idle' : 'idle', status: 'idle', config: 'idle', logs: 'idle' }
  emit('reset')
}

// 401/403 的统一收口：清 token、清敏感状态、通知界面跳登录。
// 不在任何地方保留旧配置/目录/额度/历史快照。
export function handleUnauthorized(info) {
  clearToken()
  resetData()
  emit('unauthorized', info || {})
}

// api 层一旦遇到 401/403 就调用这里；store 导入即生效，不依赖 app 是否接线。
setUnauthorizedHandler((info) => handleUnauthorized(info))

export function configVersion() {
  return Number(state.config?.configVersion ?? state.status?.configVersion ?? 0)
}

// 运行时字段缺失时给视图一个显式的“未知”，而不是 0。
export function unknownIfMissing(value, formatter) {
  if (value == null || value === '' || (typeof value === 'number' && !Number.isFinite(value))) return '未知'
  return formatter ? formatter(value) : value
}

// Derived operational warnings used by Dashboard/Settings. All from real state.
export function deriveWarnings() {
  const out = []
  const s = state.status
  const c = state.config
  if (!s) return out
  if (!state.auth.needAuth) out.push({ kind: 'warn', title: '管理面未启用令牌', detail: '仅本机可管理。若网关绑定非回环地址，请设置 MG_ADMIN_TOKEN 或 server.adminToken。' })
  const providers = Array.isArray(s.providers) ? s.providers : []
  const models = Array.isArray(s.models) ? s.models : []
  if (!providers.length) out.push({ kind: 'warn', title: '尚未配置任何上游', detail: '请先在「上游供应商」新增 Provider，再配置模型。' })
  if (!models.length) out.push({ kind: 'warn', title: '模型目录为空', detail: '网关当前没有可路由的真实模型。' })
  const noKey = providers.filter((p) => !p.hasKey)
  if (noKey.length) out.push({ kind: 'warn', title: noKey.length + ' 个上游缺少凭据', detail: noKey.map((p) => p.id).join('、') + ' 将无法发起真实请求。' })
  const open = providers.filter((p) => p.st && p.st.state === 'open')
  if (open.length) out.push({ kind: 'danger', title: open.length + ' 个上游处于熔断', detail: open.map((p) => p.id).join('、') + ' 暂时被跳过，冷却结束后半开放行。' })
  const g = s.global || {}
  if (Number(g.requests) > 0 && Number(g.errors) / Number(g.requests) > 0.2) out.push({ kind: 'warn', title: '错误率偏高', detail: '累计错误 ' + g.errors + ' / 请求 ' + g.requests + '，请到「监控与诊断」查看日志。' })
  if (c && s.configVersion != null && Number(c.configVersion) !== Number(s.configVersion)) out.push({ kind: 'warn', title: '配置版本不一致', detail: '可编辑配置版本 ' + c.configVersion + ' 与运行版本 ' + s.configVersion + ' 不同，请刷新。' })
  return out
}
