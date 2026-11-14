// AGG-P05：按作用域的授权链（纯判定 + 单次调用，无网络、无重试）。
//
// 顺序固定：requireUserScope → requireProviderOwnedBy → requirePublishedBindingFor →
//           enforceKeySeparationAndNoSecretsInLogs → enforceQuotaAndSafeCancellation →
//           invokeWithoutCrossTenantFallback
// 每一步只依赖前一步的产物；任何失败都是 typed deny，绝不回落到默认 provider / 默认作用域。
//
// 与 MG-R008/R009 的对应：
//   · 跨租户不可见：binding/provider 必须显式属于当前 scope，缺 owner 即拒绝（不「默认属于我」）。
//   · 无静默降级：失败不换 provider、不换域、不换模型；invoke 只被调用一次。
//   · 日志脱敏：日志字段只有 scope/provider/域，正文与历史默认不进入调用上下文。

import { TenancyError, sanitizeLogEntry } from './scope.js'

export const TENANCY_AUTH_DOMAINS = Object.freeze(['codex-subscription', 'siwc-app', 'api-key'])

function deny(code, message, options) {
  return new TenancyError(code, message, options)
}

function idOf(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : ''
}

export function requireProviderOwnedBy(scope, provider) {
  if (!scope || !idOf(scope.scopeId)) throw deny('scope_invalid', '缺少已解析的作用域', { status: 400 })
  if (!provider || typeof provider !== 'object') throw deny('provider_missing', '缺少 provider', { status: 404 })
  const providerId = idOf(provider.id)
  if (!providerId) throw deny('provider_id_missing', 'provider 缺少 id', { status: 400 })
  const owner = idOf(provider.scopeId) || idOf(provider.ownerScopeId)
  // 单用户模式只有一个作用域，缺省归属是明确的（今天的配置没有 scope 字段，行为不变）。
  // 多用户模式下「无 owner」是未知归属，必须拒绝，不能默认属于当前用户。
  if (!owner) {
    if (scope.mode === 'single') return provider
    throw deny('provider_owner_unknown', 'provider 未声明归属作用域，拒绝跨作用域访问', { status: 403 })
  }
  if (owner !== scope.scopeId) throw deny('provider_not_owned', 'provider 不属于当前作用域', { status: 403 })
  return provider
}

function lookupBinding(catalog, scopeId, modelId) {
  if (!catalog) return null
  if (typeof catalog.get === 'function') {
    const byScope = catalog.get(scopeId, modelId)
    if (byScope !== undefined) return byScope
    return catalog.get(modelId) || null
  }
  if (Array.isArray(catalog)) {
    return catalog.find((b) => b && (b.publicId === modelId || b.modelPublicId === modelId)) || null
  }
  if (typeof catalog === 'object') return catalog[modelId] || null
  return null
}

export function requirePublishedBindingFor(scope, provider, modelId, catalog) {
  const id = idOf(modelId)
  if (!id) throw deny('model_missing', '缺少模型 ID', { status: 400 })
  const binding = lookupBinding(catalog, scope.scopeId, id)
  if (!binding) throw deny('binding_not_published', '模型未发布到当前作用域：' + id, { status: 404 })
  const owner = idOf(binding.scopeId) || idOf(binding.ownerScopeId)
  if (owner && owner !== scope.scopeId) throw deny('binding_cross_scope', '模型绑定属于另一个作用域', { status: 403 })
  if (idOf(binding.providerId) && idOf(binding.providerId) !== idOf(provider.id)) {
    throw deny('binding_provider_mismatch', '模型绑定的 provider 与请求 provider 不一致')
  }
  if (binding.published !== true) throw deny('binding_not_published', '模型绑定未发布（published!=true）')
  if (binding.authorized === false) throw deny('binding_not_authorized', '当前账户无权使用该模型')
  return binding
}

// 凭据分离：订阅域不得同时持有 provider key；api-key 域不得同时持有订阅凭据。
// 返回值是**可安全写日志**的字段集合（只有 id 与域名，没有任何凭据值或正文）。
export function enforceKeySeparationAndNoSecretsInLogs(scope, provider, options = {}) {
  const authDomain = idOf(options.authDomain) || idOf(provider.authDomain)
  if (!TENANCY_AUTH_DOMAINS.includes(authDomain)) {
    throw deny('auth_domain_unknown', '未知授权域：' + String(authDomain || '?'))
  }
  const subscriptionDomain = authDomain === 'codex-subscription' || authDomain === 'siwc-app'
  if (subscriptionDomain && options.providerKeyPresent === true) {
    throw deny('credential_mixing_subscription_provider_key', '订阅域同时存在网关自有 key：计费身份会混用', { status: 403 })
  }
  if (authDomain === 'api-key' && options.subscriptionCredentialPresent === true) {
    throw deny('credential_mixing_api_key_subscription', 'api-key 域同时存在订阅凭据：凭据会串域', { status: 403 })
  }
  return Object.freeze(sanitizeLogEntry({
    scopeId: scope.scopeId,
    providerId: provider.id,
    authDomain,
  }))
}

// 额度与取消：软阈值不静默放行；取消发生在发送前即终止（不换 provider 重试）。
export function enforceQuotaAndSafeCancellation(scope, provider, binding, quota, options = {}) {
  const signal = options.signal
  if (signal && signal.aborted === true) throw deny('cancelled_before_send', '请求在发送前已取消', { status: 499 })
  if (quota && typeof quota === 'object') {
    const limit = Number(quota.limit)
    const used = Number(quota.used)
    if (Number.isFinite(limit) && limit >= 0 && Number.isFinite(used) && used >= limit) {
      throw deny('quota_exceeded', '作用域额度已用尽（' + used + '/' + limit + '）', { status: 429 })
    }
  }
  return Object.freeze({ scopeId: scope.scopeId, providerId: provider.id, modelPublicId: binding.publicId || binding.modelPublicId || null })
}

// 单次调用：上下文只允许一个 provider、一个绑定；没有 fallback 列表，也没有重试。
export async function invokeWithoutCrossTenantFallback(invoke, ctx) {
  if (typeof invoke !== 'function') throw deny('invoke_missing', '缺少调用函数', { status: 500 })
  if (!ctx || typeof ctx !== 'object') throw deny('invocation_context_invalid', '缺少调用上下文', { status: 500 })
  if (Array.isArray(ctx.fallbacks) || Array.isArray(ctx.providers) || Array.isArray(ctx.candidates)) {
    throw deny('cross_tenant_fallback_forbidden', '禁止跨 provider/跨作用域回退：调用上下文只能有一个目标')
  }
  return invoke(Object.freeze(Object.assign({}, ctx)))
}

// 默认不携带请求正文与历史：只有显式 allowRequestBody / allowHistory 才会写进上下文。
export function buildInvocationContext(scope, provider, binding, options = {}) {
  const allowBody = options.allowRequestBody === true
  const allowHistory = options.allowHistory === true
  return Object.freeze({
    scopeId: scope.scopeId,
    providerId: provider.id,
    authDomain: idOf(options.authDomain) || idOf(provider.authDomain) || null,
    modelPublicId: binding.publicId || binding.modelPublicId || null,
    upstreamModelId: binding.upstreamModelId || null,
    body: allowBody && options.body !== undefined ? options.body : null,
    history: allowHistory && options.history !== undefined ? options.history : null,
    upload: false,
    telemetry: 'local-only',
  })
}
