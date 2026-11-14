// AGG-P05：认证操作的组合入口（P05 伪代码的唯一落点）。
//
//   authenticatedOperation(actor, providerId, modelId, deps) -> { scope, provider, binding, logFields, context }
//
// 设计边界：
//   · **默认单用户**：config.tenancy 缺省时只有作用域 `local`，无 actor 的旧调用按默认作用域处理，
//     现有路由行为不变（本模块不被 src/index.js 引用即完全不生效）。
//   · 六步顺序固定，任一失败即终止（typed deny），不换 provider、不换作用域、不换模型。
//   · 不联网、不读凭据、不写用户 HOME；存储只在显式注入的 root 下按作用域分隔。

import { requireUserScope, resolveTenancy, createScopeStore, TenancyError, isTenancyError } from './scope.js'
import {
  requireProviderOwnedBy,
  requirePublishedBindingFor,
  enforceKeySeparationAndNoSecretsInLogs,
  enforceQuotaAndSafeCancellation,
  invokeWithoutCrossTenantFallback,
  buildInvocationContext,
} from './policy.js'

function providerFrom(deps, providerId) {
  const source = deps && deps.providers
  if (!source) return null
  if (typeof source.get === 'function') return source.get(providerId) || null
  if (typeof source === 'object') return source[providerId] || null
  return null
}

// 只解析、不调用：给管理面/诊断用的干跑版本。
export function authorizeOperation(actor, providerId, modelId, deps = {}) {
  const scope = requireUserScope(actor, { config: deps.config, tenancy: deps.tenancy })
  const provider = requireProviderOwnedBy(scope, providerFrom(deps, providerId))
  const binding = requirePublishedBindingFor(scope, provider, modelId, deps.catalog)
  const logFields = enforceKeySeparationAndNoSecretsInLogs(scope, provider, {
    authDomain: deps.authDomain,
    providerKeyPresent: deps.providerKeyPresent === true,
    subscriptionCredentialPresent: deps.subscriptionCredentialPresent === true,
  })
  enforceQuotaAndSafeCancellation(scope, provider, binding, deps.quota, { signal: deps.signal })
  return Object.freeze({ scope, provider, binding, logFields })
}

// 完整链路：授权 + 单次调用。ctx 默认不含正文/历史，也不上传。
export async function authenticatedOperation(actor, providerId, modelId, deps = {}) {
  const authz = authorizeOperation(actor, providerId, modelId, deps)
  const context = buildInvocationContext(authz.scope, authz.provider, authz.binding, {
    authDomain: deps.authDomain,
    allowRequestBody: deps.allowRequestBody === true,
    allowHistory: deps.allowHistory === true,
    body: deps.body,
    history: deps.history,
  })
  const result = await invokeWithoutCrossTenantFallback(deps.invoke, Object.assign({}, context, { logFields: authz.logFields }))
  return Object.freeze({ ...authz, context, result })
}

export {
  TenancyError, isTenancyError, requireUserScope, resolveTenancy, createScopeStore,
  requireProviderOwnedBy, requirePublishedBindingFor, enforceKeySeparationAndNoSecretsInLogs,
  enforceQuotaAndSafeCancellation, invokeWithoutCrossTenantFallback, buildInvocationContext,
}
