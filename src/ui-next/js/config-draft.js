// Config editing transaction: immutable base, dirty diff, versioned save, 409 conflict.
import { clone, diffObjects } from './format.js'
import { api, ApiError } from './api.js'

// 掩码（允许首尾空白）：代表“已设置/未改动”，永远不能作为真实 Key 上送。
export const CLIENT_KEY_MASK_RE = /^\s*\*{8}\s*$/

// 保存 payload 的唯一构造入口（M4-2 T-UI-01）：
//  - 未编辑的字段完全不出现在 defaults 里（尤其是 clientKey：省略=保留，空串=清空）。
//  - 仅掩码（含 '********  '）同样不上送，避免误清空数据面 Key。
//  - 只提交可编辑投影字段，不携带任何服务端私有/凭据字段。
export function buildSavePayload(draft) {
  const data = (draft && draft.data) || {}
  const defaults = Object.assign({}, data.defaults || {})
  const diff = typeof draft.diff === 'function' ? draft.diff() : []
  const editedClientKey = diff.some((d) => d.path === 'defaults.clientKey')
  const value = defaults.clientKey
  if (!editedClientKey || (value != null && CLIENT_KEY_MASK_RE.test(String(value)))) delete defaults.clientKey
  return {
    version: Number(draft && draft.baseVersion) || 0,
    providers: data.providers || {},
    models: data.models || {},
    defaults,
    virtualModels: Array.isArray(data.virtualModels) ? data.virtualModels : [],
  }
}

export class ConflictError extends Error {
  constructor(currentVersion) {
    super('远端配置已变化，请重新加载后再保存')
    this.name = 'ConflictError'
    this.currentVersion = currentVersion
  }
}

export class ConfigDraft {
  constructor(config) {
    this.original = clone(config)
    this.data = clone(config)
    this.baseVersion = Number(config.configVersion) || 0
    this.createdAt = Date.now()
  }
  get providers() { return this.data.providers || (this.data.providers = {}) }
  get models() { return this.data.models || (this.data.models = {}) }
  get defaults() { return this.data.defaults || (this.data.defaults = {}) }
  get virtualModels() { return Array.isArray(this.data.virtualModels) ? this.data.virtualModels : (this.data.virtualModels = []) }
  diff() { return diffObjects(this.original, this.data) }
  isDirty() { return this.diff().length > 0 }
  reset() { this.data = clone(this.original); this.baseVersion = Number(this.original.configVersion) || 0 }
  reload(config) {
    this.original = clone(config)
    this.data = clone(config)
    this.baseVersion = Number(config.configVersion) || 0
  }
  validate() {
    const errors = []
    const providerIds = new Set(Object.keys(this.providers))
    for (const [id, p] of Object.entries(this.providers)) {
      if (!String(id).trim()) errors.push('上游 ID 不能为空')
      if (!p || typeof p !== 'object') { errors.push('上游「' + id + '」必须是对象'); continue }
      if (!/^https?:\/\//.test(String(p.baseUrl || ''))) errors.push('上游「' + id + '」Base URL 必须是 http(s) 地址')
      if (p.api && !['openai', 'anthropic', 'gemini', 'cohere', 'responses'].includes(String(p.api))) errors.push('上游「' + id + '」协议不在允许集合')
      if (p.proxy && !['', 'direct'].includes(String(p.proxy)) && !/^https?:\/\//.test(String(p.proxy))) errors.push('上游「' + id + '」代理必须是 direct 或 http(s) 地址')
    }
    for (const [name, m] of Object.entries(this.models)) {
      if (!m || typeof m !== 'object') { errors.push('模型「' + name + '」必须是对象'); continue }
      if (!providerIds.has(m.provider)) errors.push('模型「' + name + '」引用了不存在的上游「' + m.provider + '」')
      for (const fb of m.fallbacks || []) if (!providerIds.has(fb)) errors.push('模型「' + name + '」的备用上游「' + fb + '」不存在')
      if (m.capability && !['chat', 'embedding', 'rerank', 'audio', 'image', 'video'].includes(String(m.capability))) errors.push('模型「' + name + '」能力标签非法')
      for (const f of ['dailyQuota', 'quota', 'maxContext', 'maxTokensMax', 'maxConcurrent', 'qps']) {
        if (m[f] != null && m[f] !== '' && (!Number.isFinite(Number(m[f])) || Number(m[f]) < 0)) errors.push('模型「' + name + '」的 ' + f + ' 必须是非负数')
      }
      for (const pid of Object.keys(m.providerModels || {})) if (!providerIds.has(pid)) errors.push('模型「' + name + '」的 providerModels 引用了不存在的上游「' + pid + '」')
      if (m.api && !['', 'openai', 'anthropic', 'gemini', 'cohere', 'responses'].includes(String(m.api))) errors.push('模型「' + name + '」协议非法')
    }
    const names = new Set()
    for (const vm of this.virtualModels) {
      if (!vm || !String(vm.name || '').trim()) { errors.push('虚拟模型缺少名称'); continue }
      if (names.has(vm.name)) errors.push('虚拟模型名重复：' + vm.name)
      names.add(vm.name)
      if (Object.prototype.hasOwnProperty.call(this.models, vm.name)) errors.push('虚拟模型「' + vm.name + '」与真实模型同名')
      if (!Array.isArray(vm.directory) || !vm.directory.length) errors.push('虚拟模型「' + vm.name + '」目录为空')
      for (const e of vm.directory || []) {
        if (!e || !this.models[e.model]) errors.push('虚拟模型「' + vm.name + '」目录引用了不存在的模型')
        for (const pid of e.providers || []) if (!providerIds.has(pid)) errors.push('虚拟模型「' + vm.name + '」目录引用了不存在的上游「' + pid + '」')
      }
      for (const f of ['quota', 'dailyQuota', 'maxContext', 'maxConcurrent', 'qps']) {
        if (vm[f] != null && (!Number.isFinite(Number(vm[f])) || Number(vm[f]) < 0)) errors.push('虚拟模型「' + vm.name + '」的 ' + f + ' 必须是非负数')
      }
    }
    return errors
  }
  async save() {
    const errors = this.validate()
    if (errors.length) throw new Error(errors[0])
    try {
      const res = await api.saveConfig(buildSavePayload(this))
      const nextVersion = Number(res?.status?.configVersion ?? this.baseVersion + 1)
      return { ok: true, version: nextVersion, status: res?.status || null }
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) throw new ConflictError(e.currentVersion)
      throw e
    }
  }
}

// Global draft slot used by Providers/Models/Settings views. One editable snapshot at a time.
let current = null
export function ensureDraft(config) {
  if (!config) return null
  if (!current) current = new ConfigDraft(config)
  else if (!current.isDirty() && current.baseVersion !== Number(config.configVersion)) current = new ConfigDraft(config)
  return current
}
export function peekDraft() { return current }
export function setDraft(draft) { current = draft }
export function clearDraft() { current = null }
export function dirtyDraft() { return !!(current && current.isDirty()) }
