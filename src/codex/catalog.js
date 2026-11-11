// Codex 动态模型目录生成器：把官方基线目录与 ModelGate 已配置第三方模型合并成
// Codex 0.167 可直接解析的完整 ModelInfo 目录（model_catalog_json / GET /v1/models）。
//
// 设计约束（见 docs/reference/codex-catalog.md）：
// - 纯函数 + Node 内置模块；不读写 ~/.codex，不联网，不调用上游 /v1/models。
// - Codex 对 model_catalog_json 是整体替换语义，缺字段直接启动失败 → 输出必须自包含。
// - 校验闸门 fail-closed：任何错误在落盘前抛出，不产出半成品。
// - 聚合 ID 稳定且不可重绑定；历史版本与回滚指针由 state 记录。
import { createHash } from 'node:crypto'

export const CATALOG_SCHEMA = 'modelgate.codex-catalog/1'
export const META_SCHEMA = 'modelgate.codex-catalog.meta/1'
export const STATE_SCHEMA = 'modelgate.codex-catalog.state/1'
export const AGGREGATED_ID_PREFIX = 'mg-'
export const DEFAULT_HISTORY_LIMIT = 5

// Codex 0.167 serde 实测必填字段（缺失即 "failed to parse model_catalog_json"）。
// 另需 base_instructions 或 model_messages.instructions_template 二者之一。
export const SERDE_REQUIRED_MODEL_FIELDS = Object.freeze([
  'slug', 'display_name', 'supported_reasoning_levels', 'shell_type', 'visibility',
  'supported_in_api', 'priority', 'support_verbosity', 'truncation_policy',
  'experimental_supported_tools',
])

// 聚合目录策略还要求能力元数据可追溯（Codex 允许缺省，但缺省会退化成未知能力）。
export const POLICY_REQUIRED_MODEL_FIELDS = Object.freeze([
  'context_window', 'max_context_window',
])

export const ENUMS = Object.freeze({
  visibility: Object.freeze(['list', 'hide', 'none']),
  shell_type: Object.freeze(['default', 'local', 'shell_command', 'unified_exec', 'disabled']),
  apply_patch_tool_type: Object.freeze(['freeform']),
  default_verbosity: Object.freeze(['low', 'medium', 'high']),
  default_reasoning_summary: Object.freeze(['auto', 'concise', 'detailed', 'none']),
  truncation_mode: Object.freeze(['bytes', 'tokens']),
  input_modality: Object.freeze(['text', 'image']),
})

// 官方 0.167 目录实际使用 low..ultra；Codex 解析器对字符串本身不设枚举，
// 但生成器默认只接受已知档位，未知档位记 warning（--strict 时升级为错误）。
export const KNOWN_REASONING_EFFORTS = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])

export const KNOWN_MODEL_FIELDS = Object.freeze([
  'slug', 'display_name', 'description', 'default_reasoning_level', 'supported_reasoning_levels',
  'shell_type', 'visibility', 'supported_in_api', 'priority', 'additional_speed_tiers',
  'service_tiers', 'availability_nux', 'upgrade', 'model_messages',
  'include_skills_usage_instructions', 'include_plugin_usage_instructions',
  'include_apps_usage_instructions', 'default_reasoning_summary', 'support_verbosity',
  'default_verbosity', 'apply_patch_tool_type', 'web_search_tool_type', 'truncation_policy',
  'supports_image_detail_original', 'context_window', 'max_context_window', 'comp_hash',
  'effective_context_window_percent', 'experimental_supported_tools', 'input_modalities',
  'supports_search_tool', 'supports_experimental_context', 'use_responses_lite',
  'supports_reasoning_effort_updates', 'node_repl_auto_review_required', 'node_repl_disabled',
  'tool_mode', 'multi_agent_version', 'multi_agent_reasoning_effort', 'base_instructions',
  'default_service_tier', 'model_specialty',
])

export const OFFICIAL_PROVIDER_IDS = Object.freeze(['openai', 'chatgpt', 'codex', 'openai-official', 'openai-codex'])

export const CODEX_OVERRIDE_FIELDS = Object.freeze([
  'displayName', 'description', 'contextWindow', 'maxContextWindow', 'modalities',
  'reasoningLevels', 'defaultReasoningLevel', 'priority', 'visibility', 'multiAgentVersion',
  'webSearchToolType', 'baseModel', 'supportedInApi', 'experimentalSupportedTools', 'toolMode',
  'capabilities', 'evidence', 'baseInstructions',
])

// P1 目录契约：第三方条目默认**不声明**未证实能力。以下能力只能经 codex.capabilities +
// codex.evidence{source,observedAt} 显式声明；官方模板里的同类字段一律不复制。
export const CODEX_CAPABILITY_FIELDS = Object.freeze({
  shellType: 'shell_type',
  applyPatchToolType: 'apply_patch_tool_type',
  webSearchToolType: 'web_search_tool_type',
  supportsSearchTool: 'supports_search_tool',
  experimentalSupportedTools: 'experimental_supported_tools',
  multiAgentVersion: 'multi_agent_version',
  toolMode: 'tool_mode',
  useResponsesLite: 'use_responses_lite',
  supportsReasoningEffortUpdates: 'supports_reasoning_effort_updates',
  modelSpecialty: 'model_specialty',
})

// 未证实能力的保守默认：Codex serde 必填字段给“关闭”值，可选能力字段不写（= 未知，不冒充支持）。
export const NEUTRAL_BASE_INSTRUCTIONS = 'You are a helpful assistant. Follow the user request and the API contract. Do not assume tools, search, patching, or agent capabilities that the provider has not declared.'
export const THIRD_PARTY_CONSERVATIVE_FIELDS = Object.freeze({
  shell_type: 'disabled',
  support_verbosity: false,
  experimental_supported_tools: Object.freeze([]),
})

export class CatalogError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'CatalogError'
    this.code = code
    this.details = details
  }
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const isPositiveInt = value => Number.isInteger(value) && value > 0
const isNonNegativeInt = value => Number.isInteger(value) && value >= 0
const isNonEmptyString = value => typeof value === 'string' && value.trim().length > 0

export function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort()
    return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}'
  }
  return JSON.stringify(value)
}

export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex')
}

export function catalogFingerprint(catalog) {
  const models = catalog && Array.isArray(catalog.models) ? catalog.models : []
  return sha256Hex(stableStringify({ models }))
}

// ---------------------------------------------------------------------------
// 输入规范化
// ---------------------------------------------------------------------------

// 显式拒绝普通 OpenAI /v1/models 形状；它不是 Codex 目录，不能直接喂给客户端。
export function normalizeCatalogInput(parsed, source = 'catalog') {
  if (Array.isArray(parsed)) {
    throw new CatalogError('catalog_shape', source + ' 必须是 {"models":[...]} 对象；收到裸数组', { source })
  }
  if (!isPlainObject(parsed)) {
    throw new CatalogError('catalog_shape', source + ' 必须是 JSON 对象；收到 ' + typeof parsed, { source })
  }
  if (parsed.object === 'list' || Array.isArray(parsed.data)) {
    throw new CatalogError('openai_list_shape',
      source + ' 是普通 OpenAI /v1/models 形状（object/data），不含 Codex ModelInfo 元数据，不能作为 Codex 目录使用',
      { source })
  }
  if (!Array.isArray(parsed.models)) {
    throw new CatalogError('catalog_shape', source + ' 缺少 models 数组', { source })
  }
  const unknown = Object.keys(parsed).filter(k => k !== 'models')
  return { catalog: { models: parsed.models }, unknown_top_level: unknown }
}

// ---------------------------------------------------------------------------
// 校验闸门
// ---------------------------------------------------------------------------

function pushError(errors, code, path, message) {
  errors.push({ code, path, message })
}

function checkEnum(errors, path, field, value, allowed) {
  if (value === undefined) return
  if (!allowed.includes(value)) {
    pushError(errors, 'invalid_enum', path + '.' + field,
      field + ' 只能是 [' + allowed.join(' / ') + ']，收到 ' + JSON.stringify(value))
  }
}

function checkStringArray(errors, path, field, value) {
  if (value === undefined) return
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) {
    pushError(errors, 'invalid_type', path + '.' + field, field + ' 必须是字符串数组')
  }
}

function validateReasoningLevels(model, path, errors, warnings, opts) {
  const levels = model.supported_reasoning_levels
  if (!Array.isArray(levels) || levels.length === 0) {
    pushError(errors, 'missing_required_field', path + '.supported_reasoning_levels',
      'supported_reasoning_levels 必须是非空数组（Codex 0.167 必填）')
    return
  }
  const seen = new Set()
  for (let i = 0; i < levels.length; i++) {
    const level = levels[i]
    const at = path + '.supported_reasoning_levels[' + i + ']'
    if (!isPlainObject(level)) {
      pushError(errors, 'invalid_type', at, '推理档位必须是对象 {effort, description}')
      continue
    }
    if (!isNonEmptyString(level.effort)) {
      pushError(errors, 'invalid_type', at + '.effort', 'effort 必须是非空字符串')
      continue
    }
    if (seen.has(level.effort)) {
      pushError(errors, 'duplicate_reasoning_level', at + '.effort', '重复档位 ' + level.effort)
    }
    seen.add(level.effort)
    if (level.description !== undefined && typeof level.description !== 'string') {
      pushError(errors, 'invalid_type', at + '.description', 'description 必须是字符串')
    }
    if (!KNOWN_REASONING_EFFORTS.includes(level.effort) && !opts.allowUnknownEfforts) {
      warnings.push({ code: 'unknown_reasoning_level', path: at + '.effort', message: '未知推理档位 ' + JSON.stringify(level.effort) })
    }
  }
}

function validateOneModel(model, index, errors, warnings, opts) {
  const path = 'models[' + index + ']'
  if (!isPlainObject(model)) {
    pushError(errors, 'model_not_object', path, '模型条目必须是对象')
    return
  }
  const slug = model.slug
  if (!isNonEmptyString(slug)) {
    pushError(errors, 'missing_required_field', path + '.slug', 'slug 必须是非空字符串')
  } else if (!/^[A-Za-z0-9._-]+$/.test(slug)) {
    if (opts.strictSlug) {
      pushError(errors, 'invalid_slug', path + '.slug', 'slug 只能包含字母数字与 . _ -：' + JSON.stringify(slug))
    } else {
      warnings.push({ code: 'slug_charset', path: path + '.slug', message: 'slug 含非常规字符：' + JSON.stringify(slug) })
    }
  }
  for (const field of SERDE_REQUIRED_MODEL_FIELDS) {
    if (model[field] === undefined) {
      pushError(errors, 'missing_required_field', path + '.' + field, 'Codex 0.167 serde 必填字段缺失：' + field)
    }
  }
  if (model.display_name !== undefined && typeof model.display_name !== 'string') {
    pushError(errors, 'invalid_type', path + '.display_name', 'display_name 必须是字符串')
  }
  if (model.priority !== undefined && !isNonNegativeInt(model.priority)) {
    pushError(errors, 'invalid_type', path + '.priority', 'priority 必须是非负整数')
  }
  if (model.supported_in_api !== undefined && typeof model.supported_in_api !== 'boolean') {
    pushError(errors, 'invalid_type', path + '.supported_in_api', 'supported_in_api 必须是布尔值')
  }
  if (model.support_verbosity !== undefined && typeof model.support_verbosity !== 'boolean') {
    pushError(errors, 'invalid_type', path + '.support_verbosity', 'support_verbosity 必须是布尔值')
  }
  checkEnum(errors, path, 'shell_type', model.shell_type, ENUMS.shell_type)
  checkEnum(errors, path, 'visibility', model.visibility, ENUMS.visibility)
  checkEnum(errors, path, 'apply_patch_tool_type', model.apply_patch_tool_type, ENUMS.apply_patch_tool_type)
  checkEnum(errors, path, 'default_verbosity', model.default_verbosity, ENUMS.default_verbosity)
  checkEnum(errors, path, 'default_reasoning_summary', model.default_reasoning_summary, ENUMS.default_reasoning_summary)
  if (model.truncation_policy !== undefined) {
    if (!isPlainObject(model.truncation_policy)) {
      pushError(errors, 'invalid_type', path + '.truncation_policy', 'truncation_policy 必须是对象')
    } else {
      checkEnum(errors, path + '.truncation_policy', 'mode', model.truncation_policy.mode, ENUMS.truncation_mode)
      if (!isPositiveInt(model.truncation_policy.limit)) {
        pushError(errors, 'invalid_type', path + '.truncation_policy.limit', 'truncation_policy.limit 必须是正整数')
      }
    }
  }
  checkStringArray(errors, path, 'experimental_supported_tools', model.experimental_supported_tools)
  checkStringArray(errors, path, 'input_modalities', model.input_modalities)
  if (Array.isArray(model.input_modalities)) {
    for (const modality of model.input_modalities) {
      if (!ENUMS.input_modality.includes(modality)) {
        pushError(errors, 'invalid_enum', path + '.input_modalities', '未知输入模态 ' + JSON.stringify(modality))
      }
    }
  }
  validateReasoningLevels(model, path, errors, warnings, opts)
  if (model.default_reasoning_level !== undefined && typeof model.default_reasoning_level !== 'string') {
    pushError(errors, 'invalid_type', path + '.default_reasoning_level', 'default_reasoning_level 必须是字符串')
  }
  if (typeof model.default_reasoning_level === 'string' && Array.isArray(model.supported_reasoning_levels) &&
      !model.supported_reasoning_levels.some(l => l && l.effort === model.default_reasoning_level)) {
    pushError(errors, 'default_reasoning_level_unsupported', path + '.default_reasoning_level',
      'default_reasoning_level ' + JSON.stringify(model.default_reasoning_level) + ' 不在 supported_reasoning_levels 中')
  }
  const hasBase = isNonEmptyString(model.base_instructions)
  const hasTemplate = isPlainObject(model.model_messages) && isNonEmptyString(model.model_messages.instructions_template)
  if (model.base_instructions !== undefined && typeof model.base_instructions !== 'string') {
    pushError(errors, 'invalid_type', path + '.base_instructions', 'base_instructions 必须是字符串')
  }
  if (model.model_messages !== undefined && !isPlainObject(model.model_messages)) {
    pushError(errors, 'invalid_type', path + '.model_messages', 'model_messages 必须是对象')
  }
  if (!hasBase && !hasTemplate) {
    pushError(errors, 'missing_instructions', path,
      '缺少 base_instructions，且 model_messages.instructions_template 也不存在（Codex 0.167 必填二者之一）')
  }
  // 能力元数据：Codex 允许缺省，但缺省会在客户端变成 undefined，无法支撑 D2 的来源/置信度要求。
  for (const field of POLICY_REQUIRED_MODEL_FIELDS) {
    if (model[field] === undefined) {
      pushError(errors, 'missing_capability_field', path + '.' + field,
        '缺少 ' + field + '；Codex 解析会退化为未知能力，聚合目录要求显式声明')
      continue
    }
    if (!isPositiveInt(model[field])) {
      pushError(errors, 'invalid_type', path + '.' + field, field + ' 必须是正整数（Codex 内部为 i64）')
    }
  }
  if (isPositiveInt(model.context_window) && isPositiveInt(model.max_context_window) &&
      model.max_context_window < model.context_window) {
    pushError(errors, 'context_window_order', path,
      'max_context_window (' + model.max_context_window + ') 小于 context_window (' + model.context_window + ')')
  }
  if (model.visibility === 'list' && model.supported_in_api === false) {
    warnings.push({ code: 'listed_but_not_api', path, message: 'visibility=list 但 supported_in_api=false，客户端可能可选却无法调用' })
  }
  if (model.base_instructions !== undefined) {
    const unknown = Object.keys(model).filter(k => !KNOWN_MODEL_FIELDS.includes(k))
    if (unknown.length) {
      warnings.push({ code: 'unknown_model_field', path, message: 'Codex 会忽略的未知字段：' + unknown.join(', ') })
    }
  }
}

// 返回 { ok, errors, warnings }，不抛异常（供 CLI 打印完整问题列表）。
export function validateCatalog(input, options = {}) {
  const opts = {
    strict: false,
    strictSlug: false,
    allowUnknownEfforts: false,
    requireModels: true,
    ...options,
  }
  const errors = []
  const warnings = []
  let catalog
  try {
    catalog = normalizeCatalogInput(input, options.source || 'catalog').catalog
  } catch (err) {
    if (err instanceof CatalogError) {
      return { ok: false, errors: [{ code: err.code, path: '$', message: err.message }], warnings }
    }
    throw err
  }
  if (catalog.models.length === 0 && opts.requireModels) {
    pushError(errors, 'empty_catalog', '$', '目录至少需要 1 个模型（整体替换语义，空目录会让 /model 无模型可选）')
  }
  const seen = new Map()
  for (let i = 0; i < catalog.models.length; i++) {
    validateOneModel(catalog.models[i], i, errors, warnings, opts)
    const slug = catalog.models[i] && catalog.models[i].slug
    if (isNonEmptyString(slug)) {
      if (seen.has(slug)) {
        pushError(errors, 'duplicate_slug', 'models[' + i + '].slug', '重复 slug ' + slug + '（首次出现于 models[' + seen.get(slug) + ']）')
      } else {
        seen.set(slug, i)
      }
    }
  }
  if (opts.strict) {
    for (const warning of warnings) errors.push({ code: 'strict_' + warning.code, path: warning.path, message: warning.message })
  }
  return { ok: errors.length === 0, errors, warnings }
}

export function assertCatalog(input, options = {}) {
  const result = validateCatalog(input, options)
  if (!result.ok) {
    const first = result.errors[0]
    throw new CatalogError('catalog_invalid',
      '目录校验失败（' + result.errors.length + ' 项）：' + first.path + ' ' + first.message,
      { errors: result.errors, warnings: result.warnings })
  }
  return result
}

// ---------------------------------------------------------------------------
// 稳定聚合 ID 与绑定
// ---------------------------------------------------------------------------

export function sanitizeSlugSegment(value) {
  return String(value === undefined || value === null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function stableModelId(provider, model) {
  const providerPart = sanitizeSlugSegment(provider)
  const modelPart = sanitizeSlugSegment(model)
  if (!providerPart || !modelPart) {
    throw new CatalogError('stable_id_invalid',
      '无法生成稳定 ID：provider=' + JSON.stringify(provider) + ' model=' + JSON.stringify(model))
  }
  return AGGREGATED_ID_PREFIX + providerPart + '-' + modelPart
}

export const DEFAULT_RESERVED_MODEL_NAMES = Object.freeze(['__proto__', 'constructor', 'prototype'])

// 收集配置里的“身份名”：真实模型、别名、虚拟模型、默认虚拟共用名。别名指回自身模型也计入。
export function collectIdentityNames(config) {
  const models = isPlainObject(config) && isPlainObject(config.models) ? config.models : {}
  const realModels = Object.keys(models).filter(name => {
    const entry = models[name]
    return !(isPlainObject(entry) && entry.disabled === true)
  }).sort()
  const aliases = []
  for (const name of Object.keys(models)) {
    const entry = models[name]
    if (!isPlainObject(entry) || !Array.isArray(entry.alias)) continue
    for (const raw of entry.alias) {
      if (isNonEmptyString(raw)) aliases.push({ alias: raw.trim(), model: name })
    }
  }
  const virtualModels = Array.isArray(config && config.virtualModels)
    ? config.virtualModels.map(v => v && v.name).filter(isNonEmptyString).map(v => v.trim())
    : []
  const defaultsModel = isPlainObject(config && config.defaults) && isNonEmptyString(config.defaults.model)
    ? config.defaults.model.trim()
    : null
  return { realModels, aliases, virtualModels, defaultsModel }
}

// P1 目录契约：真实模型名 / 别名 / 虚拟模型名 / 保留名必须零碰撞；墓碑 ID 不得被别名复活。
// 返回冲突数组（空 = 通过），供 buildCatalog 与配置写入侧共用同一判定。
export function zeroCollisionsAcrossRealModelsAliasesVirtualAndReservedNames(config, options = {}) {
  const reserved = new Set(options.reservedNames || DEFAULT_RESERVED_MODEL_NAMES)
  const retired = new Set((options.retiredSlugs || []).filter(isNonEmptyString))
  const { realModels, aliases, virtualModels, defaultsModel } = collectIdentityNames(config)
  const owner = new Map()
  const collisions = []
  const claim = (name, kind, source) => {
    if (reserved.has(name)) return collisions.push({ code: 'reserved_name', name, kind, source })
    if (retired.has(name)) return collisions.push({ code: kind === 'alias' ? 'alias_to_retired_id' : 'retired_name_reuse', name, kind, source })
    if (owner.has(name)) return collisions.push({ code: 'name_collision', name, kind, source, first: owner.get(name) })
    owner.set(name, { kind, source })
  }
  for (const name of realModels) claim(name, 'model', name)
  for (const item of aliases) claim(item.alias, 'alias', item.model)
  for (const name of virtualModels) claim(name, 'virtualModel', name)
  if (defaultsModel) claim(defaultsModel, 'defaults.model', 'defaults.model')
  return collisions
}

export function assertZeroCollisions(config, options = {}) {
  const collisions = zeroCollisionsAcrossRealModelsAliasesVirtualAndReservedNames(config, options)
  if (collisions.length) {
    throw new CatalogError('identity_collision',
      '模型身份名冲突（真实模型/别名/虚拟模型/保留名必须零碰撞）：' + collisions.map(c => '[' + c.code + '] ' + c.kind + ' ' + c.name + ' <- ' + c.source).join('; '),
      { collisions })
  }
  return true
}

export function reasoningDescription(effort) {
  const table = {
    minimal: 'Minimal reasoning for the fastest responses',
    low: 'Fast responses with lighter reasoning',
    medium: 'Balanced reasoning for everyday tasks',
    high: 'Greater reasoning depth for complex problems',
    xhigh: 'Extra high reasoning depth for complex problems',
    max: 'Maximum reasoning depth for the hardest problems',
    ultra: 'Maximum reasoning with automatic task delegation',
  }
  return table[effort] || ('Reasoning effort: ' + effort)
}

function toReasoningLevels(value) {
  if (value === undefined || value === null) return []
  const list = Array.isArray(value) ? value : [value]
  const levels = []
  for (const item of list) {
    if (typeof item === 'string') {
      if (item.trim()) levels.push({ effort: item.trim(), description: reasoningDescription(item.trim()) })
    } else if (isPlainObject(item) && typeof item.effort === 'string' && item.effort.trim()) {
      levels.push({ effort: item.effort.trim(), description: typeof item.description === 'string' && item.description ? item.description : reasoningDescription(item.effort.trim()) })
    } else {
      throw new CatalogError('invalid_reasoning_override', 'reasoningLevels 只接受字符串或 {effort, description} 对象')
    }
  }
  return levels
}

function pickTemplateModel(officialModels, requested) {
  if (requested) {
    const found = officialModels.find(m => m && m.slug === requested)
    if (!found) throw new CatalogError('template_model_missing', '基线目录中不存在模板模型 ' + JSON.stringify(requested))
    return found
  }
  return officialModels.find(m => m && m.visibility === 'list' && m.supported_in_api !== false) ||
    officialModels.find(m => m && m.visibility === 'list') ||
    officialModels[0]
}

// ---------------------------------------------------------------------------
// 合并生成
// ---------------------------------------------------------------------------

const DEFAULT_OVERRIDE_GUARDS = Object.freeze({ officialProviders: OFFICIAL_PROVIDER_IDS })

function validateOverrideShape(name, override) {
  if (override === undefined) return
  if (!isPlainObject(override)) {
    throw new CatalogError('invalid_override', 'models.' + name + '.codex 必须是对象')
  }
  const unknown = Object.keys(override).filter(k => !CODEX_OVERRIDE_FIELDS.includes(k))
  if (unknown.length) {
    throw new CatalogError('unknown_override_field',
      'models.' + name + '.codex 含未知字段：' + unknown.join(', ') + '（允许：' + CODEX_OVERRIDE_FIELDS.join(', ') + '）')
  }
}

const OBSERVED_AT_RE = /^\d{4}-\d{2}-\d{2}([T ].*)?$/

function isObservedAt(value) {
  return typeof value === 'string' && OBSERVED_AT_RE.test(value.trim())
}

// 值本身是否在“声称能力”。false / 空数组 / disabled 这类保守声明不算声称，无需证据。
function claimsCapability(value) {
  if (value === undefined || value === null) return false
  if (typeof value === 'boolean') return value === true
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    return v !== '' && v !== 'disabled' && v !== 'none' && v !== 'false' && v !== 'off'
  }
  return true
}

function capabilityEvidenceFor(name, key, evidence) {
  const item = evidence && evidence[key]
  if (!isPlainObject(item) || !isNonEmptyString(item.source) || !isObservedAt(item.observedAt)) {
    throw new CatalogError('capability_evidence_missing',
      'models.' + name + '.codex.' + key + ' 声明了未证实能力；必须提供 evidence.' + key + ' = { source, observedAt(YYYY-MM-DD) }',
      { model: name, field: key })
  }
  return { source: item.source.trim(), observedAt: String(item.observedAt).trim() }
}

// 收集显式能力声明（新旧字段都收），逐项要求可追溯证据；返回 { caps, evidence }。
function collectCapabilities(name, override) {
  const declared = Object.create(null)
  if (override.capabilities !== undefined) {
    if (!isPlainObject(override.capabilities)) {
      throw new CatalogError('invalid_override', 'models.' + name + '.codex.capabilities 必须是对象')
    }
    for (const key of Object.keys(override.capabilities)) {
      if (!Object.prototype.hasOwnProperty.call(CODEX_CAPABILITY_FIELDS, key)) {
        throw new CatalogError('unknown_override_field',
          'models.' + name + '.codex.capabilities 含未知能力：' + key + '（允许：' + Object.keys(CODEX_CAPABILITY_FIELDS).join(', ') + '）')
      }
      declared[key] = override.capabilities[key]
    }
  }
  // 兼容旧字段：同样视为能力声明，同样必须带证据。
  for (const legacy of ['multiAgentVersion', 'toolMode', 'webSearchToolType', 'experimentalSupportedTools']) {
    if (override[legacy] !== undefined) declared[legacy] = override[legacy]
  }
  const evidence = isPlainObject(override.evidence) ? override.evidence : {}
  if (override.evidence !== undefined && !isPlainObject(override.evidence)) {
    throw new CatalogError('invalid_override', 'models.' + name + '.codex.evidence 必须是对象')
  }
  const caps = Object.create(null)
  const used = Object.create(null)
  for (const key of Object.keys(declared)) {
    const value = declared[key]
    if (claimsCapability(value) || evidence[key] !== undefined) used[key] = capabilityEvidenceFor(name, key, evidence)
    caps[key] = value
  }
  return { caps, evidence: used }
}

function buildThirdPartyEntry(name, entry, template, options, warnings) {
  validateOverrideShape(name, entry.codex)
  const override = entry.codex || {}
  let templateModel = template
  if (override.baseModel) {
    templateModel = options.baseModels.find(m => m.slug === override.baseModel)
    if (!templateModel) {
      throw new CatalogError('template_model_missing', 'models.' + name + '.codex.baseModel 不存在：' + JSON.stringify(override.baseModel))
    }
  }
  if (!templateModel) throw new CatalogError('template_model_missing', '基线目录为空，无法为第三方模型提供元数据模板')
  const provider = entry.provider
  if (!isNonEmptyString(provider)) {
    throw new CatalogError('third_party_provider_missing', 'models.' + name + '.provider 缺失，无法生成稳定聚合 ID')
  }
  const slug = stableModelId(provider, name)
  const capability = entry.capability === undefined ? 'chat' : entry.capability
  const providerEntry = options.providerNames ? options.providerNames[provider] : undefined
  const providerName = typeof providerEntry === 'string' ? providerEntry : (providerEntry && typeof providerEntry.name === 'string' ? providerEntry.name : provider)

  // 上下文窗口：声明必须可追溯；不允许凭猜测填数。
  const contextWindow = override.contextWindow !== undefined ? override.contextWindow : entry.maxContext
  if (!isPositiveInt(contextWindow)) {
    throw new CatalogError('third_party_context_missing',
      'models.' + name + ' 缺少正整数上下文窗口：请配置 models.' + name + '.maxContext 或 models.' + name + '.codex.contextWindow',
      { model: name, provider })
  }
  const maxContextWindow = override.maxContextWindow !== undefined ? override.maxContextWindow : contextWindow
  if (!isPositiveInt(maxContextWindow)) {
    throw new CatalogError('third_party_context_missing', 'models.' + name + '.codex.maxContextWindow 必须是正整数')
  }

  let levels = toReasoningLevels(override.reasoningLevels)
  let levelsConfidence = 'declared'
  if (!levels.length) levels = toReasoningLevels(entry.effortOptions)
  if (!levels.length) levels = toReasoningLevels(entry.reasoning)
  if (!levels.length) {
    levels = [{ effort: 'medium', description: reasoningDescription('medium') }]
    levelsConfidence = 'assumed'
    warnings.push({ code: 'assumed_reasoning_levels', path: 'models.' + name,
      message: '未声明 effortOptions/reasoning；按 assumed 档位 [' + levels[0].effort + '] 生成，客户端可能无法按真实能力调节' })
  }
  const declaredDefault = override.defaultReasoningLevel !== undefined ? override.defaultReasoningLevel : entry.reasoning
  const defaultLevel = levels.some(l => l.effort === declaredDefault)
    ? declaredDefault
    : levels[0].effort
  if (declaredDefault !== undefined && !levels.some(l => l.effort === declaredDefault)) {
    warnings.push({ code: 'default_reasoning_level_fallback', path: 'models.' + name,
      message: '默认档位 ' + JSON.stringify(declaredDefault) + ' 不在支持列表中，回落到 ' + defaultLevel })
  }

  const modalities = override.modalities ? [...override.modalities] : ['text']
  const modalitiesConfidence = override.modalities ? 'declared' : 'assumed'

  const priority = override.priority !== undefined ? override.priority : options.nextPriority()
  if (!isNonNegativeInt(priority)) {
    throw new CatalogError('invalid_override', 'models.' + name + '.codex.priority 必须是非负整数')
  }

  // 能力：只有显式 capabilities + evidence 才写入；官方模板里的同名字段一律不复制。
  const capabilityDecl = collectCapabilities(name, override)
  const baseInstructionsDeclared = override.baseInstructions !== undefined
  if (baseInstructionsDeclared && !isNonEmptyString(override.baseInstructions)) {
    throw new CatalogError('invalid_override', 'models.' + name + '.codex.baseInstructions 必须是非空字符串')
  }
  const baseInstructions = baseInstructionsDeclared ? override.baseInstructions.trim() : NEUTRAL_BASE_INSTRUCTIONS

  // 从“保守骨架”构造：不 clone 官方模板，避免把模板的 tool/search/patch/agent/hosted-tools
  // 等未证实行为字段带到第三方上游（审计 P1 §模板行为）。
  const model = {
    slug,
    display_name: override.displayName || (name + ' (' + providerName + ')'),
    description: override.description || ('Third-party ' + capability + ' model ' + name + ' via ' + providerName + ' (ModelGate aggregation)'),
    visibility: override.visibility || 'list',
    supported_in_api: override.supportedInApi !== undefined ? override.supportedInApi : true,
    priority,
    supported_reasoning_levels: levels,
    default_reasoning_level: defaultLevel,
    context_window: contextWindow,
    max_context_window: maxContextWindow,
    input_modalities: modalities,
    shell_type: THIRD_PARTY_CONSERVATIVE_FIELDS.shell_type,
    support_verbosity: THIRD_PARTY_CONSERVATIVE_FIELDS.support_verbosity,
    truncation_policy: { mode: 'tokens', limit: maxContextWindow },
    experimental_supported_tools: [...THIRD_PARTY_CONSERVATIVE_FIELDS.experimental_supported_tools],
    base_instructions: baseInstructions,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
  }
  for (const key of Object.keys(capabilityDecl.caps)) {
    model[CODEX_CAPABILITY_FIELDS[key]] = capabilityDecl.caps[key]
  }

  const sources = {
    contextWindow: { value: contextWindow, origin: override.contextWindow !== undefined ? 'models.' + name + '.codex.contextWindow' : 'models.' + name + '.maxContext', confidence: 'declared' },
    maxContextWindow: { value: maxContextWindow, origin: override.maxContextWindow !== undefined ? 'models.' + name + '.codex.maxContextWindow' : (override.contextWindow !== undefined ? 'models.' + name + '.codex.contextWindow' : 'models.' + name + '.maxContext'), confidence: 'declared' },
    reasoningLevels: { values: levels.map(l => l.effort), origin: override.reasoningLevels !== undefined ? 'models.' + name + '.codex.reasoningLevels' : (entry.effortOptions !== undefined ? 'models.' + name + '.effortOptions' : (entry.reasoning !== undefined ? 'models.' + name + '.reasoning' : 'assumed')), confidence: levelsConfidence },
    inputModalities: { values: modalities, origin: override.modalities ? 'models.' + name + '.codex.modalities' : 'assumed:text-only', confidence: modalitiesConfidence },
    baseInstructions: baseInstructionsDeclared
      ? { origin: 'models.' + name + '.codex.baseInstructions', confidence: 'declared' }
      : { origin: 'modelgate:neutral-instructions', confidence: 'conservative' },
    clientBehavior: { origin: 'modelgate:conservative-defaults', confidence: 'conservative', fields: ['shell_type', 'support_verbosity', 'truncation_policy', 'experimental_supported_tools'] },
  }
  if (Object.keys(capabilityDecl.caps).length) {
    sources.capabilities = {
      fields: Object.keys(capabilityDecl.caps).map(k => CODEX_CAPABILITY_FIELDS[k]),
      evidence: capabilityDecl.evidence,
    }
  }

  const warningsForModel = warnings.filter(w => w.path === 'models.' + name)
  return {
    model,
    binding: { slug, stableId: slug, provider, providerName, model: name, capability },
    meta: {
      slug,
      stableId: slug,
      provider,
      providerName,
      model: name,
      capability,
      templateModel: templateModel.slug,
      inheritedFields: [],
      templateFieldsNotInherited: Object.keys(templateModel),
      sources,
      warnings: warningsForModel,
    },
  }
}

export function selectThirdPartyModels(config, options = {}) {
  const officialProviders = options.officialProviders || OFFICIAL_PROVIDER_IDS
  const selected = []
  const skipped = []
  const models = isPlainObject(config) && isPlainObject(config.models) ? config.models : {}
  const providers = isPlainObject(config) && isPlainObject(config.providers) ? config.providers : {}
  for (const name of Object.keys(models)) {
    const entry = models[name]
    if (!isPlainObject(entry)) {
      throw new CatalogError('invalid_config', 'models.' + name + ' 必须是对象')
    }
    if (entry.disabled === true) {
      skipped.push({ model: name, reason: 'disabled' })
      continue
    }
    const provider = entry.provider
    if (!isNonEmptyString(provider)) {
      throw new CatalogError('third_party_provider_missing', 'models.' + name + '.provider 缺失')
    }
    if (officialProviders.includes(provider)) {
      skipped.push({ model: name, provider, reason: 'official_provider_passthrough' })
      continue
    }
    const capability = entry.capability === undefined ? 'chat' : entry.capability
    if (capability !== 'chat') {
      skipped.push({ model: name, provider, reason: 'non_chat_capability:' + capability })
      continue
    }
    selected.push({
      name,
      entry,
      provider,
      providerName: providers[provider] && providers[provider].name ? providers[provider].name : provider,
    })
  }
  return { selected, skipped, providerNames: providers }
}

export function buildCatalog({ base, config = null, options = {} }) {
  const warnings = []
  // P1：身份名零碰撞 + 墓碑复活在生成前 fail-closed（别名指向已删 ID 同样拒绝）。
  assertZeroCollisions(config, { retiredSlugs: options.retiredSlugs })
  const officialCatalog = normalizeCatalogInput(base, 'base catalog').catalog
  if (officialCatalog.models.length === 0) {
    throw new CatalogError('empty_catalog', '基线目录没有模型；拒绝生成空目录（整体替换语义会清空客户端模型列表）')
  }
  const baseValidation = validateCatalog({ models: officialCatalog.models }, { source: 'base catalog' })
  if (!baseValidation.ok) {
    throw new CatalogError('base_catalog_invalid',
      '基线目录未通过校验（' + baseValidation.errors.length + ' 项）：' + baseValidation.errors[0].path + ' ' + baseValidation.errors[0].message,
      { errors: baseValidation.errors })
  }
  warnings.push(...baseValidation.warnings.map(w => ({ ...w, path: 'base:' + w.path })))

  const template = pickTemplateModel(officialCatalog.models, options.templateModel)
  const officialSlugs = new Set(officialCatalog.models.map(m => m && m.slug).filter(Boolean))
  const officialPriorities = officialCatalog.models.map(m => m && m.priority).filter(isNonNegativeInt)
  const maxOfficialPriority = officialPriorities.length ? Math.max(...officialPriorities) : 0
  let priorityCursor = isNonNegativeInt(options.priorityStart) ? options.priorityStart : maxOfficialPriority + 1
  const nextPriority = () => priorityCursor++

  const thirdParty = []
  const { selected, skipped, providerNames } = selectThirdPartyModels(config, options)
  const baseModels = officialCatalog.models
  const seenSlugs = new Map()
  for (const item of selected) {
    if (officialSlugs.has(item.name)) {
      throw new CatalogError('official_slug_reuse',
        'models.' + item.name + ' 与官方模型同名；聚合模型不得复用/遮蔽官方模型 ID（D1/D2 稳定身份约束）')
    }
    const built = buildThirdPartyEntry(item.name, item.entry, template, {
      ...options,
      baseModels,
      providerNames,
      nextPriority,
    }, warnings)
    if (officialSlugs.has(built.model.slug)) {
      throw new CatalogError('official_slug_reuse', '生成的聚合 ID ' + built.model.slug + ' 与官方 slug 冲突')
    }
    if (seenSlugs.has(built.model.slug)) {
      throw new CatalogError('slug_collision',
        '聚合 ID 冲突：models.' + seenSlugs.get(built.model.slug) + ' 与 models.' + item.name + ' 映射到同一 ID ' + built.model.slug,
        { slug: built.model.slug })
    }
    seenSlugs.set(built.model.slug, item.name)
    thirdParty.push(built)
  }

  const catalog = { models: [...officialCatalog.models, ...thirdParty.map(t => t.model)] }
  assertCatalog(catalog, { source: 'generated catalog' })

  const bindings = {}
  for (const item of thirdParty) bindings[item.binding.slug] = item.binding
  // 生成的聚合/官方 slug 不得与配置身份名（真实模型/别名/虚拟模型/defaults.model）重合，
  // 否则 /v1/models 与路由会出现同名不同源，必须 fail-closed。
  if (config) {
    const identities = collectIdentityNames(config)
    const officialProviderIds = options.officialProviders || OFFICIAL_PROVIDER_IDS
    const passthroughNames = new Set(Object.keys(config.models || {}).filter(name => {
      const entry = config.models[name]
      return isPlainObject(entry) && officialProviderIds.includes(entry.provider)
    }))
    const identitySet = new Set([
      ...identities.realModels.filter(name => !passthroughNames.has(name)),
      ...identities.aliases.map(a => a.alias),
      ...identities.virtualModels,
      ...(identities.defaultsModel ? [identities.defaultsModel] : []),
    ])
    for (const slug of Object.keys(bindings)) {
      if (identitySet.has(slug)) {
        throw new CatalogError('slug_collision', '生成的聚合 ID ' + slug + ' 与配置里的真实模型/别名/虚拟模型同名', { slug })
      }
    }
    for (const slug of officialSlugs) {
      if (identitySet.has(slug)) {
        throw new CatalogError('official_slug_reuse', '官方目录 slug ' + slug + ' 与配置里的真实模型/别名/虚拟模型同名', { slug })
      }
    }
  }
  const meta = {
    schema: META_SCHEMA,
    catalogSchema: CATALOG_SCHEMA,
    templateModel: template.slug,
    officialSlugs: [...officialSlugs].sort(),
    counts: { official: officialCatalog.models.length, thirdParty: thirdParty.length, total: catalog.models.length },
    skipped,
    models: thirdParty.map(t => t.meta),
    bindings,
    warnings,
  }
  return { catalog, meta }
}

// ---------------------------------------------------------------------------
// 差异摘要
// ---------------------------------------------------------------------------

const LONG_VALUE_PREVIEW = 160

export function summarizeValue(value) {
  if (typeof value === 'string') {
    if (value.length <= LONG_VALUE_PREVIEW) return value
    return '<string len=' + value.length + ' sha256:' + sha256Hex(value).slice(0, 12) + '>'
  }
  const text = stableStringify(value)
  return text.length <= LONG_VALUE_PREVIEW ? value : '<' + (Array.isArray(value) ? 'array' : typeof value) + ' len=' + text.length + ' sha256:' + sha256Hex(text).slice(0, 12) + '>'
}

export function diffCatalogs(previous, next) {
  const prevModels = new Map(((previous && previous.models) || []).filter(Boolean).map(m => [m.slug, m]))
  const nextModels = new Map(((next && next.models) || []).filter(Boolean).map(m => [m.slug, m]))
  const added = [...nextModels.keys()].filter(slug => !prevModels.has(slug))
  const removed = [...prevModels.keys()].filter(slug => !nextModels.has(slug))
  const changed = []
  for (const [slug, nextModel] of nextModels) {
    const prevModel = prevModels.get(slug)
    if (!prevModel) continue
    const fields = {}
    for (const field of new Set([...Object.keys(prevModel), ...Object.keys(nextModel)])) {
      if (stableStringify(prevModel[field]) !== stableStringify(nextModel[field])) {
        fields[field] = { from: summarizeValue(prevModel[field]), to: summarizeValue(nextModel[field]) }
      }
    }
    if (Object.keys(fields).length) changed.push({ slug, fields })
  }
  return {
    added,
    removed,
    changed,
    counts: { added: added.length, removed: removed.length, changed: changed.length, previous: prevModels.size, next: nextModels.size },
  }
}

// 同一 slug 指向不同 provider/model = 重绑定（D2 禁止），必须 fail-closed。
export function diffBindings(previousBindings, nextBindings) {
  const prev = previousBindings || {}
  const next = nextBindings || {}
  const added = []
  const removed = []
  const changed = []
  const conflicts = []
  for (const slug of Object.keys(next)) {
    if (!prev[slug]) { added.push(slug); continue }
    if (prev[slug].provider !== next[slug].provider || prev[slug].model !== next[slug].model) {
      changed.push({ slug, from: { provider: prev[slug].provider, model: prev[slug].model }, to: { provider: next[slug].provider, model: next[slug].model } })
      conflicts.push({ slug, from: { provider: prev[slug].provider, model: prev[slug].model }, to: { provider: next[slug].provider, model: next[slug].model } })
    }
  }
  for (const slug of Object.keys(prev)) if (!next[slug]) removed.push(slug)
  return { added, removed, changed, conflicts }
}

// ---------------------------------------------------------------------------
// 版本化、回滚指针
// ---------------------------------------------------------------------------

export function emptyState() {
  return { schema: STATE_SCHEMA, currentVersion: 0, highWaterVersion: 0, current: null, history: [], retiredBindings: {}, lastRollback: null }
}

// 世代号单调：回滚只换整代，不回退“已用过的最高版本”，因此回滚后再发布不会复用旧版本号。
export function nextVersion(state) {
  const current = Number.isInteger(state && state.currentVersion) ? state.currentVersion : 0
  const high = Number.isInteger(state && state.highWaterVersion) ? state.highWaterVersion : 0
  return Math.max(current, high) + 1
}

export function versionFileName(version, sha256) {
  return 'v' + String(version).padStart(6, '0') + '-' + String(sha256 || '').slice(0, 8) + '.json'
}

export function recordVersion(state, entry, { historyLimit = DEFAULT_HISTORY_LIMIT } = {}) {
  const limit = isPositiveInt(historyLimit) ? historyLimit : DEFAULT_HISTORY_LIMIT
  const summary = {
    version: entry.version,
    file: entry.file,
    sha256: entry.sha256,
    generatedAt: entry.generatedAt,
    format: entry.format,
    counts: entry.counts,
    sourceFingerprint: entry.sourceFingerprint,
    key: entry.key || null,
    configFingerprint: entry.configFingerprint || null,
    catalogFingerprint: entry.catalogFingerprint || null,
    bindings: entry.bindings || {},
    verified: entry.verified || null,
  }
  return {
    ...state,
    schema: STATE_SCHEMA,
    currentVersion: entry.version,
    highWaterVersion: Math.max(Number(state.highWaterVersion) || 0, entry.version),
    current: summary,
    history: [summary, ...(state.history || []).filter(item => item.version !== entry.version)].slice(0, limit),
    retiredBindings: { ...(state.retiredBindings || {}) },
  }
}

export function retireBindings(state, removedSlugs, version) {
  const retired = { ...(state.retiredBindings || {}) }
  const bindings = (state.current && state.current.bindings) || {}
  for (const slug of removedSlugs) {
    if (bindings[slug]) retired[slug] = { ...bindings[slug], retiredAtVersion: version }
  }
  return { ...state, retiredBindings: retired }
}

export function resolveRollbackTarget(state, selector) {
  const text = String(selector === undefined || selector === null ? 'prev' : selector).trim()
  if (!state || !state.current) throw new CatalogError('no_previous_version', '没有可回滚的已发布目录版本')
  let target = null
  if (text === 'current') target = state.current
  else if (text === 'prev' || text === 'previous' || text === '-1') {
    target = (state.history || []).find(item => item.version !== (state.current && state.current.version)) || null
  } else if (/^\d+$/.test(text)) {
    target = (state.history || []).find(item => item.version === Number(text)) || (state.current.version === Number(text) ? state.current : null)
  } else if (/^v\d+/.test(text)) {
    const version = Number(text.replace(/^v/, '').split('-')[0])
    target = (state.history || []).find(item => item.version === version) || null
  } else {
    target = (state.history || []).find(item => String(item.sha256 || '').startsWith(text)) || null
  }
  if (!target) throw new CatalogError('rollback_target_missing', '找不到回滚目标 ' + JSON.stringify(selector))
  return target
}

export function markRollback(state, target, at) {
  return {
    ...state,
    currentVersion: target.version,
    current: target,
    lastRollback: { from: state.current ? state.current.version : null, to: target.version, at },
  }
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

export const OUTPUT_FORMATS = Object.freeze(['catalog-json', 'codex-models'])

export function renderCodexModels(catalog) {
  return { models: (catalog && Array.isArray(catalog.models) ? catalog.models : []) }
}

// catalog-json（model_catalog_json 文件）与 codex-models（GET /v1/models 响应体）
// 在 Codex 0.167 上是同一个 ModelsResponse {models:[...]} 结构；序列化保持同一份
// 真源，避免两条路径产生漂移。format 只影响元数据与默认文件名。
export function serializeCatalog(catalog, { format = 'catalog-json', pretty = false } = {}) {
  if (!OUTPUT_FORMATS.includes(format)) {
    throw new CatalogError('invalid_format', 'format 只能是 ' + OUTPUT_FORMATS.join(' / ') + '，收到 ' + JSON.stringify(format))
  }
  const body = renderCodexModels(catalog)
  return pretty ? JSON.stringify(body, null, 2) : JSON.stringify(body)
}

export function sourceFingerprint({ base, config, templateModel, options = {} }) {
  const official = base && base.sha256 ? base.sha256 : sha256Hex(stableStringify(base && base.catalog ? base.catalog : base))
  const models = config && config.sha256 ? config.sha256 : (config ? sha256Hex(stableStringify(config)) : null)
  return {
    official: { path: (base && base.path) || null, sha256: official },
    models: models ? { path: (config && config.path) || null, sha256: models } : null,
    combined: sha256Hex(stableStringify({ official, models, templateModel: templateModel || null, priorityStart: options.priorityStart === undefined ? null : options.priorityStart })),
  }
}