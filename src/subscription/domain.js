// AGG-P02：SIWC 应用授权域的固定描述（纯常量 + 纯判定，不读凭据、不联网）。
//
// 授权域是**互斥**的三选一（见 ADR-0003 §2 与产品契约 MG-R002/MG-R008）：
//   codex-subscription —— 复用本机已有 Codex 登录态，入口 /backend-api/codex（P09）
//   siwc-app           —— Sign in with ChatGPT 的独立应用授权，入口 api.openai.com/v1/responses
//   api-key            —— 网关自持上游 key
//
// 本文件只声明 siwc-app 的入口事实，供 src/codex/target-authz.js 的 resolveUpstream() 引用。
// 令牌获取/刷新/撤销仍只在 src/subscription/{oauth,session}.js；本文件不持有任何凭据。

export const SIWC_AUTH_DOMAIN = 'siwc-app'
export const SIWC_UPSTREAM_HOST = 'api.openai.com'
export const SIWC_RESOURCE = 'https://api.openai.com/v1'
export const SIWC_RESPONSES_PATH = '/v1/responses'

export function siwcDomainDescriptor() {
  return Object.freeze({
    authDomain: SIWC_AUTH_DOMAIN,
    upstreamHost: SIWC_UPSTREAM_HOST,
    upstreamPath: SIWC_RESPONSES_PATH,
    resource: SIWC_RESOURCE,
  })
}
