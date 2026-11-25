import { randomUUID } from 'node:crypto'

const MAX_IN_FLIGHT = 10000

function poolMatches(pool, model) {
  return pool && (pool.name === model || pool.slug === model || pool.poolId === model)
}

function memberModel(member) {
  return typeof member?.model === 'string' ? member.model : typeof member?.modelId === 'string' ? member.modelId : ''
}

export function registerInFlight(state, body) {
  if (!state || !(state.inFlight instanceof Map)) return null
  if (state.inFlight.size >= MAX_IN_FLIGHT) {
    const error = new Error('在途请求登记已满：拒绝新发送')
    error.code = 'in_flight_capacity_exceeded'
    error.status = 503
    throw error
  }
  const requestId = randomUUID()
  const requestedModel = typeof body?.model === 'string' ? body.model : ''
  const models = new Set(requestedModel ? [requestedModel] : [])
  const modelIds = new Set()
  for (const [name, def] of Object.entries(state.cfg?.models || {})) {
    if (models.has(name) && typeof def?.modelId === 'string') modelIds.add(def.modelId)
  }
  const providers = new Set()
  const pools = new Set()
  for (const pool of state.cfg?.virtualModels || []) {
    if (!poolMatches(pool, requestedModel)) continue
    if (pool.poolId) pools.add(pool.poolId)
    if (pool.slug) pools.add(pool.slug)
    if (typeof pool.name === 'string' && pool.name) pools.add(pool.name)
    for (const member of [...(pool.members || []), ...(pool.directory || [])]) {
      const model = memberModel(member)
      if (model) models.add(model)
      if (typeof member.providerId === 'string') providers.add(member.providerId)
      for (const provider of member.providers || []) if (typeof provider === 'string') providers.add(provider)
    }
  }
  for (const model of models) {
    const provider = state.cfg?.models?.[model]?.provider
    if (typeof provider === 'string') providers.add(provider)
  }
  state.inFlight.set(requestId, Object.freeze({
    requestId, requestedModel, startedAt: Date.now(),
    models: Object.freeze([...models]), modelIds: Object.freeze([...modelIds]), providers: Object.freeze([...providers]), pools: Object.freeze([...pools]),
  }))
  return requestId
}

export function releaseInFlight(state, requestId) {
  if (state && state.inFlight instanceof Map && requestId) state.inFlight.delete(requestId)
}

export function registerProviderInFlight(provider) {
  if (!(provider?._inFlight instanceof Map)) return null
  if (provider._inFlight.size >= MAX_IN_FLIGHT) {
    const error = new Error('在途请求登记已满：拒绝新发送')
    error.code = 'in_flight_capacity_exceeded'
    error.status = 503
    throw error
  }
  const requestId = randomUUID()
  const models = Array.isArray(provider._modelNames) ? provider._modelNames : []
  const modelIds = Array.isArray(provider._modelIds) ? provider._modelIds : []
  provider._inFlight.set(requestId, Object.freeze({
    requestId, requestedModel: models[0] || provider.id || '', startedAt: Date.now(),
    models: Object.freeze([...models]), modelIds: Object.freeze([...modelIds]), providers: Object.freeze([provider.id]), pools: Object.freeze([]),
  }))
  return requestId
}

export function releaseProviderInFlight(provider, requestId, stream) {
  if (!(provider?._inFlight instanceof Map) || !requestId) return
  let released = false
  const release = () => {
    if (released) return
    released = true
    provider._inFlight.delete(requestId)
  }
  if (!stream) { release(); return }
  if (stream.readableEnded || stream.destroyed) { release(); return }
  stream.once('end', release)
  stream.once('close', release)
  stream.once('error', release)
}

export function inFlightImpact(inFlight, match) {
  if (!(inFlight instanceof Map)) return { state: 'unknown', count: 0, requests: [], note: '在途请求数量未知：未注入在途请求登记表；已启动请求使用固定配置代际，不取消已启动请求。' }
  const requests = [...inFlight.values()].filter(match).map((entry) => ({
    requestId: entry.requestId, model: entry.requestedModel, startedAt: entry.startedAt,
  }))
  return { state: 'tracked', count: requests.length, requests }
}

export function serviceInFlightImpact(inFlight, providerId) {
  return inFlightImpact(inFlight, (entry) => entry.providers.includes(providerId))
}

export function modelInFlightImpact(inFlight, modelName, modelId) {
  return inFlightImpact(inFlight, (entry) => entry.models.includes(modelName) || (modelId && (entry.models.includes(modelId) || entry.modelIds?.includes(modelId))))
}

export function poolInFlightImpact(inFlight, refs) {
  return inFlightImpact(inFlight, (entry) => entry.pools.some((pool) => refs.includes(pool)))
}

export function inFlightDeleteError(impact, code, message) {
  if (impact.state !== 'tracked' || impact.count === 0) return null
  return { status: 422, code, error: message, details: impact }
}
