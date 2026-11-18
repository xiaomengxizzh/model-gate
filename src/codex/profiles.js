// 三种接入模式的纯函数层：official（直连）/ route（路由）/ aggregated（聚合）。
//
// 设计要点：
//  * 不触发网络、不读写文件、不接触任何凭据；所有函数只处理内存中的目标描述。
//  * 父（顶层 model）与子（[agents.go_deepseek] + go-deepseek.toml）解耦：
//    aggregated 父为官方 GPT（默认 gpt-6-luna），子为 deepseek；route 父子同为路由别名。
//  * 真机签收只认 gpt-6-luna；其它父模型一律 UNVERIFIED，绝不自动替换或降级。

export const AGGREGATION_MODES = Object.freeze(['official', 'route', 'aggregated'])
export const DEFAULT_PARENT_MODEL = 'gpt-6-luna'
export const ROUTE_MODEL = 'mg-opencodego-deepseek-v4-1-flash'
export const DEEPSEEK_CHILD_MODEL = 'deepseek-v4.1-flash'

/**
 * 把一次模式选择解析成确定的接入目标。
 * @param {object}  input
 * @param {string}  input.mode         official | route | aggregated
 * @param {string} [input.parentModel] 聚合模式可选父模型（默认 gpt-6-luna）
 * @param {object} [input.catalog]     目录（本函数不修改它）
 * @param {object} [input.cfg]         网关配置，仅用于 official 默认父模型回退
 * @returns {{mode:string,parentModel:string,childModel:(string|null),model:string,providerMode:string,authMode:string}}
 */
export function resolveModeTarget (input = {}) {
  const mode = AGGREGATION_MODES.includes(input.mode) ? input.mode : 'official'
  if (mode === 'route') {
    return Object.freeze({
      mode,
      parentModel: ROUTE_MODEL,
      childModel: ROUTE_MODEL,
      model: ROUTE_MODEL,
      providerMode: 'managed-provider',
      authMode: 'loopback-trust',
    })
  }
  if (mode === 'aggregated') {
    const parentModel = String(input.parentModel || '').trim() || DEFAULT_PARENT_MODEL
    return Object.freeze({
      mode,
      parentModel,
      childModel: DEEPSEEK_CHILD_MODEL,
      model: parentModel,
      providerMode: 'builtin-openai',
      authMode: 'official',
    })
  }
  const cfgDefault = input.cfg && input.cfg.defaults && input.cfg.defaults.model
  const parentModel = String(input.parentModel || '').trim() ||
    String(cfgDefault || '').trim() || DEFAULT_PARENT_MODEL
  return Object.freeze({
    mode,
    parentModel,
    childModel: null,
    model: parentModel,
    providerMode: 'builtin-openai',
    authMode: 'official',
  })
}

/**
 * 从目录里筛选可作为父模型的官方 GPT：visibility=list 且 supported_in_api!==false。
 * 只有 gpt-6-luna 标记 ALLOWED_FOR_REAL_TEST，其余一律 UNVERIFIED。
 */
export function listSelectableParents (catalog) {
  const models = catalog && Array.isArray(catalog.models)
    ? catalog.models
    : (Array.isArray(catalog) ? catalog : [])
  const result = []
  const seen = new Set()
  for (const model of models) {
    if (!model || typeof model.slug !== 'string' || !model.slug) continue
    if (model.visibility !== 'list' || model.supported_in_api === false) continue
    if (seen.has(model.slug)) continue
    seen.add(model.slug)
    result.push(Object.freeze({
      slug: model.slug,
      displayName: typeof model.display_name === 'string' ? model.display_name : model.slug,
      realTest: model.slug === DEFAULT_PARENT_MODEL ? 'ALLOWED_FOR_REAL_TEST' : 'UNVERIFIED',
    }))
  }
  return result
}

/**
 * consentToken 的模式绑定串：任一字段变化都会让同意令牌失配（428）。
 */
export function modeDescriptor (target = {}) {
  return [
    'mode=' + String(target.mode || ''),
    'parent=' + String(target.parentModel || ''),
    'child=' + String(target.childModel || ''),
    'model=' + String(target.model || ''),
    'provider=' + String(target.providerMode || ''),
    'auth=' + String(target.authMode || ''),
  ].join('|')
}
