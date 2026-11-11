// E1 / D1-A：Codex 聚合的「目标身份域」分类。
//
// 唯一判定依据是**显式声明 + baseUrl 主机白名单**，provider 名字不参与判定——把条目命名为 openai
// 既不使其成为官方目标，也不使其被排除在第三方之外（Codex 0.167 的内置 openai 只能由顶层
// openai_base_url 改向，model_providers.openai.* 是保留 ID，无法覆盖）。
//
// 三个身份域：
//   official   —— 官方端点（ChatGPT/OpenAI 官方 host，或显式声明且 host 在白名单内）。官方凭据域。
//   thirdParty —— 其它一切自建/中转/第三方上游。任何官方专用头在此域必须消失。
//   unknown    —— 无法可信判定（缺 baseUrl、声明与 host 冲突、非法声明值）。调用方必须 fail-closed。
//
// credential 说明「这次请求用谁的身份」：
//   provider-key       使用网关自持的上游 key（配置 keys/apiKeyEnv）。
//   client-passthrough 官方目标且网关无自有 key：只能用客户端带来的官方凭据（默认关闭，见 auth.js）。
//   none               thirdParty 且无 key（宁可让上游 401，绝不继承客户端官方 token）。

export const DEFAULT_OFFICIAL_HOSTS = Object.freeze(['api.openai.com', 'chatgpt.com', 'chat.openai.com'])

// 聚合保留 ID 前缀（E2 目录 slug 形状 mg-<provider>-<model>；mg/ 形式作为别名一并保留）。
// 命中前缀但未在 config.models 显式声明的 ID 一律 unknown_model，绝不回落 defaults.provider。
export const DEFAULT_AGGREGATE_PREFIXES = Object.freeze(['mg-', 'mg/'])

const IDENTITY_KINDS = Object.freeze({ OFFICIAL: 'official', THIRD_PARTY: 'thirdParty', UNKNOWN: 'unknown' })

// baseUrl → 小写主机名；非法/缺失返回 null。
export function hostOf(baseUrl) {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) return null
  try {
    const u = new URL(baseUrl.trim())
    if (!u.hostname) return null
    return u.hostname.toLowerCase().replace(/\.$/, '')
  } catch { return null }
}

function schemeOf(baseUrl) {
  try { return new URL(String(baseUrl || '').trim()).protocol.toLowerCase() } catch { return null }
}

// 官方 host 清单：defaults.codexOfficialHosts 可覆盖（运维显式扩白名单）。
export function officialHosts(cfg) {
  const raw = cfg && cfg.defaults && cfg.defaults.codexOfficialHosts
  if (Array.isArray(raw)) {
    const list = raw.map((v) => String(v || '').trim().toLowerCase()).filter(Boolean)
    if (list.length) return list
  }
  return DEFAULT_OFFICIAL_HOSTS.slice()
}

export function isOfficialHost(host, cfg) {
  return !!host && officialHosts(cfg).includes(host)
}

function declaredIdentity(def) {
  const raw = def && (def.codexIdentity != null ? def.codexIdentity : def.codex_identity)
  if (raw == null || raw === '') return null
  const v = String(raw).trim().toLowerCase().replace(/[\s_-]/g, '')
  if (v === 'official') return 'official'
  if (v === 'thirdparty' || v === 'third' || v === 'third-party') return 'thirdParty'
  return 'invalid'
}

function providerFields(provider) {
  const p = provider || {}
  const def = p._def || p
  return { id: p.id || def.id || null, baseUrl: p.baseUrl != null ? p.baseUrl : def.baseUrl, def }
}

// classifyTarget(provider, cfg) -> { kind, host, declared, credential, reason }
// provider 可以是 buildProvider() 的产物（含 _def/baseUrl/apiKey）或 provider 配置片段。
export function classifyTarget(provider, cfg) {
  const { baseUrl, def } = providerFields(provider)
  const host = hostOf(baseUrl)
  const declared = declaredIdentity(def)
  const hasKey = !!((provider && provider.apiKey) || (def && def.apiKey))
  const base = { host, declared, scheme: schemeOf(baseUrl) }

  if (declared === 'invalid') return Object.assign(base, { kind: IDENTITY_KINDS.UNKNOWN, reason: 'invalid_codex_identity', credential: 'none' })
  if (!host) return Object.assign(base, { kind: IDENTITY_KINDS.UNKNOWN, reason: 'missing_base_url', credential: 'none' })

  const officialHost = isOfficialHost(host, cfg)
  if (declared === 'official' && !officialHost) {
    // 声明官方却指向非官方 host：这是最危险的错配，判 unknown 并 fail-closed，绝不「按官方处理」。
    return Object.assign(base, { kind: IDENTITY_KINDS.UNKNOWN, reason: 'declared_official_host_mismatch', credential: 'none' })
  }
  if (declared === 'thirdParty' && officialHost) {
    return Object.assign(base, { kind: IDENTITY_KINDS.UNKNOWN, reason: 'declared_third_party_on_official_host', credential: 'none' })
  }
  if (officialHost) {
    return Object.assign(base, {
      kind: IDENTITY_KINDS.OFFICIAL,
      reason: declared === 'official' ? 'declared_official' : 'official_host_allowlist',
      credential: hasKey ? 'provider-key' : 'client-passthrough',
    })
  }
  return Object.assign(base, { kind: IDENTITY_KINDS.THIRD_PARTY, reason: declared === 'thirdParty' ? 'declared_third_party' : 'non_official_host', credential: hasKey ? 'provider-key' : 'none' })
}

// E3 集成接口（单一真源）：官方目标判定。index.js 的官方透传代理必须调用本函数，
// 不得复制 host 白名单或自建判定，避免两处清单漂移。
export function isOfficialTarget(def, cfg) {
  return classifyTarget(def || {}, cfg).kind === IDENTITY_KINDS.OFFICIAL
}

export function aggregatePrefixes(cfg) {
  const raw = cfg && cfg.defaults && cfg.defaults.aggregatePrefixes
  if (Array.isArray(raw)) {
    const list = raw.map((v) => String(v == null ? '' : v).trim()).filter(Boolean)
    if (list.length) return list
  }
  return DEFAULT_AGGREGATE_PREFIXES.slice()
}

// 聚合保留 ID：只按前缀判定，与是否已配置无关（是否命中由调用方查字典决定）。
export function isAggregateModelId(model, cfg) {
  if (typeof model !== 'string' || !model) return false
  const m = model.toLowerCase()
  return aggregatePrefixes(cfg).some((p) => m.startsWith(p.toLowerCase()))
}

export { IDENTITY_KINDS }
