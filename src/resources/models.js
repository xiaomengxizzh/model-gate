import { randomBytes } from 'node:crypto'
import { modelInFlightImpact, inFlightDeleteError } from './in-flight.js'

const APIS = new Set(['openai', 'responses', 'anthropic', 'gemini', 'cohere'])
const CAPABILITIES = new Set(['chat', 'embedding', 'rerank', 'audio', 'image', 'video'])
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype'])
const PATCH_FIELDS = new Set([
  'name', 'providerId', 'upstreamModelId', 'displayName', 'capability', 'api',
  'enabled', 'providerModels', 'maxContext', 'maxTokensMax',
])
const NUMERIC_FIELDS = ['maxContext', 'maxTokensMax']

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function cleanText(value, max, label) {
  if (typeof value !== 'string' || !value.trim()) return { error: label + '不能为空' }
  const out = value.trim()
  if (out.length > max) return { error: label + '不能超过 ' + max + ' 个字符' }
  if (/[\0-\x1f]/.test(out)) return { error: label + '不能包含控制字符' }
  return { value: out }
}

function stableId(value, legacy) {
  if (typeof value !== 'string' || !value.trim()) return legacy
  const out = value.trim()
  if (out.length > 100 || RESERVED_IDS.has(out) || /[\0-\x1f]/.test(out)) return legacy
  return out
}

function providerIdOf(def) {
  const value = def?.provider ?? def?.providerId
  return typeof value === 'string' ? value.trim() : ''
}

function providerOf(cfg, providerId) {
  return Object.hasOwn(cfg?.providers || {}, providerId) ? cfg.providers[providerId] : null
}

function upstreamModelIdOf(name, def, providerId) {
  const overrides = def?.providerModels
  if (object(overrides) && Object.hasOwn(overrides, providerId)) {
    const value = overrides[providerId]
    if (typeof value === 'string' && value.trim()) return value
  }
  if (typeof def?.upstreamModelId === 'string' && def.upstreamModelId.trim()) return def.upstreamModelId
  return name
}

// Safe projection only. Runtime credentials, endpoints, headers, aliases and unknown
// extension fields stay in cfg.models/cfg.providers and never enter this resource view.
export function publicModel(name, def, cfg = {}) {
  if (!object(def)) return null
  const providerId = providerIdOf(def)
  const provider = providerOf(cfg, providerId)
  const serviceId = stableId(def.serviceId, stableId(provider?.serviceId, 'legacy:' + providerId))
  const modelId = stableId(def.modelId, 'legacy:' + name)
  return {
    name,
    modelId,
    serviceId,
    providerId,
    upstreamModelId: upstreamModelIdOf(name, def, providerId),
    displayName: typeof def.displayName === 'string' && def.displayName.trim() ? def.displayName.trim() : name,
    capability: typeof def.capability === 'string' && def.capability.trim() ? def.capability.trim() : 'chat',
    api: typeof def.api === 'string' && def.api.trim()
      ? def.api.trim()
      : typeof provider?.api === 'string' && provider.api.trim() ? provider.api.trim() : 'openai',
    enabled: def.enabled !== false,
    metadataProvenance: typeof def.metadataProvenance === 'string' && def.metadataProvenance.trim() ? def.metadataProvenance.trim() : 'legacy',
  }
}

function emptyImpact() {
  return { defaults: [], virtualModels: [], fallbacks: [], providerModels: [], codexBindings: [] }
}

function unique(values) {
  return [...new Set(values)]
}

// Impact labels deliberately contain names/keys only, never configuration bodies.
// Legacy fallbacks/providerModels are provider-keyed maps; matching the public model
// name here catches explicit legacy references without treating a shared provider as
// a reason to block deletion of one of its models.
export function modelImpact(cfg, name, opts = {}) {
  const impact = emptyImpact()
  const modelId = publicModel(name, cfg?.models?.[name], cfg)?.modelId
  const directory = Array.isArray(cfg?.defaults?.directory) ? cfg.defaults.directory : []
  impact.defaults = unique(directory
    .filter((entry) => entry?.model === name || entry?.modelId === name || (modelId && entry?.modelId === modelId))
    .map((entry) => entry.model || entry.modelId))
  const pools = Array.isArray(cfg?.virtualModels) ? cfg.virtualModels : []
  impact.virtualModels = unique(pools
    .map((pool, index) => ({ pool, index }))
    .filter(({ pool }) => {
      const members = [...(Array.isArray(pool?.directory) ? pool.directory : []), ...(Array.isArray(pool?.members) ? pool.members : [])]
      return members.some((entry) => entry?.model === name || entry?.modelId === name || (modelId && entry?.modelId === modelId))
    })
    .map(({ pool, index }) => typeof pool?.name === 'string' && pool.name ? pool.name : String(index)))

  for (const [otherName, def] of Object.entries(cfg?.models || {})) {
    if (otherName === name || !object(def)) continue
    if (Array.isArray(def.fallbacks) && (def.fallbacks.includes(name) || (modelId && def.fallbacks.includes(modelId)))) impact.fallbacks.push(otherName)
    if (object(def.providerModels) && (Object.hasOwn(def.providerModels, name) || (modelId && Object.hasOwn(def.providerModels, modelId)))) impact.providerModels.push(otherName)
  }

  const bindings = cfg?._codexCatalog?.bindings
  if (object(bindings)) {
    for (const [key, binding] of Object.entries(bindings)) {
      if (!object(binding)) continue
      const referenced = binding.model === name || (modelId && binding.modelId === modelId) || (binding.model === undefined && binding.modelId === undefined && key === name)
      if (referenced) impact.codexBindings.push(typeof binding.slug === 'string' && binding.slug ? binding.slug : key)
    }
  }
  impact.fallbacks = unique(impact.fallbacks)
  impact.providerModels = unique(impact.providerModels)
  impact.codexBindings = unique(impact.codexBindings)
  impact.inFlight = modelInFlightImpact(opts.inFlight, name, modelId)
  return impact
}

function failure(status, code, error, details) {
  return { status, code, error, ...(details !== undefined ? { details } : {}) }
}

function hasReferences(impact) {
  return Object.values(impact).some((refs) => Array.isArray(refs) && refs.length > 0)
}

function findModel(cfg, body) {
  const hasModelId = body.modelId !== undefined
  const hasServiceId = body.serviceId !== undefined
  const hasName = body.name !== undefined
  if (!hasModelId && !hasServiceId && !hasName) return { missing: true }
  const modelId = hasModelId && typeof body.modelId === 'string' ? body.modelId.trim() : ''
  const serviceId = hasServiceId && typeof body.serviceId === 'string' ? body.serviceId.trim() : ''
  const name = hasName && typeof body.name === 'string' ? body.name.trim() : ''
  if ((hasModelId && (!modelId || RESERVED_IDS.has(modelId))) || (hasServiceId && (!serviceId || RESERVED_IDS.has(serviceId))) || (hasName && (!name || RESERVED_IDS.has(name)))) return { missing: true }

  const matches = []
  for (const [modelName, def] of Object.entries(cfg?.models || {})) {
    if (!object(def)) continue
    const view = publicModel(modelName, def, cfg)
    if (hasName && modelName !== name) continue
    if (hasModelId && view.modelId !== modelId) continue
    // serviceId normally identifies the provider; name/modelId disambiguates when a
    // service has multiple models. A modelId is also accepted here for API symmetry.
    if (hasServiceId && view.modelId !== serviceId && view.serviceId !== serviceId) continue
    matches.push(modelName)
  }
  if (matches.length > 1) return { conflict: true }
  if (!matches.length) return { missing: true }
  return { name: matches[0], def: cfg.models[matches[0]] }
}

function newModelId(cfg) {
  let id
  do {
    id = 'mdl_' + randomBytes(12).toString('base64url')
  } while (Object.values(cfg?.models || {}).some((def) => object(def) && publicModel('', def, cfg).modelId === id))
  return id
}

function validateProviderModels(cfg, providerModels) {
  if (!object(providerModels)) return { error: 'providerModels 必须是对象' }
  const normalized = {}
  for (const [providerId, upstreamModelId] of Object.entries(providerModels)) {
    if (RESERVED_IDS.has(providerId)) return { error: 'providerModels 含保留键名' }
    if (!Object.hasOwn(cfg?.providers || {}, providerId)) return { error: 'providerModels 引用了不存在的上游' }
    const checked = cleanText(upstreamModelId, 256, 'providerModels 上游模型名')
    if (checked.error) return checked
    normalized[providerId] = checked.value
  }
  return { value: normalized }
}

function normalizeModel(cfg, input, before, beforeName, creating) {
  if (!object(input)) return { error: 'patch 必须是对象' }
  for (const key of Object.keys(input)) {
    if (RESERVED_IDS.has(key) || !PATCH_FIELDS.has(key)) return { error: '不支持的模型字段: ' + key }
  }

  const checkedName = cleanText(creating ? input.name : input.name !== undefined ? input.name : beforeName, 120, '模型公共名')
  if (checkedName.error) return checkedName
  const name = checkedName.value
  if (RESERVED_IDS.has(name)) return { error: '模型公共名是保留标识' }

  const rawProviderId = creating ? input.providerId : input.providerId !== undefined ? input.providerId : providerIdOf(before)
  const checkedProvider = cleanText(rawProviderId, 120, 'providerId')
  if (checkedProvider.error) return checkedProvider
  const providerId = checkedProvider.value
  if (!Object.hasOwn(cfg?.providers || {}, providerId)) return { error: 'providerId 引用了不存在的上游' }
  const provider = cfg.providers[providerId]
  if (!object(provider)) return { error: 'providerId 引用了无效上游' }

  const beforeView = before ? publicModel(beforeName, before, cfg) : null
  let upstreamModelId
  if (input.upstreamModelId !== undefined) {
    const checked = cleanText(input.upstreamModelId, 256, 'upstreamModelId')
    if (checked.error) return checked
    upstreamModelId = checked.value
  } else if (creating) {
    return { error: 'upstreamModelId 不能为空' }
  } else if (object(input.providerModels) && Object.hasOwn(input.providerModels, providerId)) {
    const checked = cleanText(input.providerModels[providerId], 256, 'upstreamModelId')
    if (checked.error) return checked
    upstreamModelId = checked.value
  } else {
    upstreamModelId = beforeView.upstreamModelId
  }

  if (input.providerModels !== undefined) {
    const checked = validateProviderModels(cfg, input.providerModels)
    if (checked.error) return checked
    if (Object.hasOwn(input.providerModels, providerId) && input.upstreamModelId !== undefined && input.providerModels[providerId].trim() !== upstreamModelId) {
      return { error: 'upstreamModelId 与 providerModels 中的主上游模型名不一致' }
    }
  }
  if (before?.providerModels !== undefined && before.providerModels !== null && before.providerModels !== '' && !object(before.providerModels)) {
    return { error: '既有 providerModels 必须是对象' }
  }
  let providerModels = {
    ...(object(before?.providerModels) ? clone(before.providerModels) : {}),
    ...(input.providerModels !== undefined ? clone(input.providerModels) : {}),
  }
  providerModels[providerId] = upstreamModelId
  const checkedProviderModels = validateProviderModels(cfg, providerModels)
  if (checkedProviderModels.error) return checkedProviderModels
  providerModels = checkedProviderModels.value

  if (input.capability !== undefined && !CAPABILITIES.has(input.capability)) return { error: 'capability 仅支持 chat/embedding/rerank/audio/image/video' }
  if (input.api !== undefined && !APIS.has(input.api)) return { error: 'api 仅支持 openai/responses/anthropic/gemini/cohere' }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') return { error: 'enabled 必须是布尔值' }
  for (const field of NUMERIC_FIELDS) {
    if (input[field] !== undefined && (!Number.isFinite(input[field]) || input[field] < 0)) return { error: field + ' 必须是非负数字' }
  }

  const after = creating ? {} : clone(before)
  after.provider = providerId
  if (before && Object.hasOwn(before, 'providerId')) after.providerId = providerId
  if (before && Object.hasOwn(before, 'serviceId')) after.serviceId = stableId(provider.serviceId, 'legacy:' + providerId)
  after.upstreamModelId = upstreamModelId
  after.providerModels = providerModels
  if (input.displayName !== undefined) {
    const checked = cleanText(input.displayName, 120, 'displayName')
    if (checked.error) return checked
    after.displayName = checked.value
  } else if (creating) {
    after.displayName = name
  }
  if (input.capability !== undefined) after.capability = input.capability
  else if (creating) after.capability = 'chat'
  if (input.api !== undefined) after.api = input.api
  else if (creating) after.api = provider.api || 'openai'
  if (input.enabled !== undefined) after.enabled = input.enabled
  else if (creating) after.enabled = true
  if (creating) after.metadataProvenance = 'manual'
  else if (!Object.hasOwn(after, 'metadataProvenance')) after.metadataProvenance = 'manual'
  for (const field of NUMERIC_FIELDS) if (input[field] !== undefined) after[field] = input[field]

  const effectiveApi = after.api || provider.api || 'openai'
  const effectiveCapability = after.capability || 'chat'
  if (!APIS.has(effectiveApi)) return { error: 'api 仅支持 openai/responses/anthropic/gemini/cohere' }
  if (!CAPABILITIES.has(effectiveCapability)) return { error: 'capability 仅支持 chat/embedding/rerank/audio/image/video' }
  return { name, after }
}

function targetsOf(name, def) {
  const targets = []
  const providerId = providerIdOf(def)
  if (providerId) targets.push([providerId, upstreamModelIdOf(name, def, providerId)])
  if (object(def?.providerModels)) {
    for (const [otherProviderId, upstreamModelId] of Object.entries(def.providerModels)) {
      if (typeof upstreamModelId === 'string' && upstreamModelId) targets.push([otherProviderId, upstreamModelId])
    }
  }
  return unique(targets.map((target) => target[0] + '\0' + target[1]))
}

function targetConflict(cfg, name, def, excludedNames) {
  const targets = new Set(targetsOf(name, def))
  for (const [otherName, otherDef] of Object.entries(cfg?.models || {})) {
    if (excludedNames.has(otherName) || !object(otherDef)) continue
    for (const target of targetsOf(otherName, otherDef)) {
      if (targets.has(target)) return { name: otherName, providerId: target.slice(0, target.indexOf('\0')), upstreamModelId: target.slice(target.indexOf('\0') + 1) }
    }
  }
  return null
}

// Preview-only planner. cfg is never mutated; payload.models is the complete existing
// mapping so the current configuration transaction remains the only persistence path.
export function planModel(cfg = {}, body, opts = {}) {
  if (!object(body)) return failure(400, 'invalid_body', '请求体必须是对象')
  const action = String(body.action || '')
  if (!['model.create', 'model.update', 'model.delete'].includes(action)) return failure(400, 'unsupported_preview_action', '仅支持 model.create/update/delete 预览')
  const expectedVersion = Number.isInteger(body.expectedVersion) ? body.expectedVersion : null
  if (expectedVersion === null || expectedVersion !== (cfg.configVersion || 0)) {
    return failure(409, 'version_conflict', '配置版本已过期，请刷新后重试', { currentVersion: cfg.configVersion || 0 })
  }
  if (typeof body.requestId !== 'string' || !body.requestId.trim() || body.requestId.length > 100) {
    return failure(400, 'invalid_request_id', 'requestId 必填且不能超过 100 字符')
  }

  const creating = action === 'model.create'
  const deleting = action === 'model.delete'
  let before = null
  let beforeName = null
  let modelId = null
  let impact = emptyImpact()

  if (!creating) {
    const found = findModel(cfg, body)
    if (found.conflict) return failure(409, 'model_id_conflict', '模型稳定 ID 不唯一，请先修正配置')
    if (found.missing) return failure(404, 'model_not_found', '模型不存在')
    beforeName = found.name
    before = found.def
    modelId = publicModel(beforeName, before, cfg).modelId
    impact = modelImpact(cfg, beforeName, opts)
    if (deleting) {
      const active = inFlightDeleteError(impact.inFlight, 'model_in_flight', '模型仍有在途请求，请等待完成后删除')
      if (active) return active
    }
    if (deleting && hasReferences(impact)) {
      return failure(422, 'model_referenced', '模型仍被默认目录、模型池、其他模型或 Codex 目录引用，请先解绑', impact)
    }
  }

  let after = null
  let name = beforeName
  if (!deleting) {
    const normalized = normalizeModel(cfg, body.patch, before, beforeName, creating)
    if (normalized.error) return failure(400, 'invalid_model', normalized.error)
    name = normalized.name
    after = normalized.after
    if (creating) {
      modelId = newModelId(cfg)
      after.modelId = modelId
    } else {
      // Materializing the legacy projection before a rename keeps modelId stable.
      after.modelId = modelId
    }

    if (Object.hasOwn(cfg.models || {}, name) && (creating || name !== beforeName)) {
      return failure(409, 'model_name_conflict', '模型公共名已存在')
    }
    if (name !== beforeName && hasReferences(impact)) {
      return failure(422, 'model_referenced', '模型仍被引用，不能直接重命名；请先解除引用', impact)
    }
    const conflict = targetConflict(cfg, name, after, new Set([beforeName, name].filter(Boolean)))
    if (conflict) return failure(409, 'model_target_conflict', '同一服务已存在相同 upstreamModelId 的模型', conflict)
  }

  const models = clone(object(cfg.models) ? cfg.models : {})
  if (creating) models[name] = after
  else if (deleting) delete models[beforeName]
  else {
    if (name !== beforeName) delete models[beforeName]
    models[name] = after
  }

  const now = Number.isFinite(opts.now) ? opts.now : Date.now()
  const nextCfg = { ...cfg, models }
  return {
    status: 200,
    plan: {
      action,
      modelId,
      name,
      expectedVersion,
      requestId: body.requestId,
      before: before ? publicModel(beforeName, before, cfg) : null,
      after: after ? publicModel(name, after, nextCfg) : null,
      impact,
      payload: { expectedVersion, models },
      expiresAt: new Date(now + 300000).toISOString(),
    },
  }
}
