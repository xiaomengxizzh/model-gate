// defaults 合并保存契约（面板保存不冲掉自定义字段）：
// 1) 含自定义字段的完整保存可见；2) 面板式保存（仅白名单字段）不得冲掉未回传字段；
// 3) 不带 defaults 键的保存原样保留；4) 显式提交仍可覆盖。
// 注：合并语义下字段无法经保存接口删除，收尾把自定义字段重置为与「未设置」行为等价的值。
// MG-004：自建隔离实例（保存只落在 OS 临时配置目录，销毁即弃），不再读写目标网关配置。
import { startGateway } from './isolate.mjs'
import { check, finish } from './utils.mjs'

const fx = await startGateway({ name: 'z-defaults-merge', config: { providers: {}, models: {} } })
const saveDefaults = (defaults) => fx.post('/api/config/save', defaults === undefined ? {} : { defaults }, fx.admin)
const status = () => fx.status()

try {
  const base = await status()
  const custom = { affinityTtlMs: 120000, failbackProbe: { enabled: true, everyMs: 30000, successStreak: 2, system: 'ping' } }

  // 1) 完整保存（含自定义字段）
  let st = await status()
  await saveDefaults(Object.assign({}, st.defaults, custom))
  st = await status()
  check('完整保存·自定义字段落盘', st.defaults.affinityTtlMs === 120000 && st.defaults.failbackProbe && st.defaults.failbackProbe.everyMs === 30000, st.defaults)

  // 2) 面板式保存：defaults 只含白名单字段（extraHeaders 硬编码 {}，模拟 admin.html 行为）
  const panelDefaults = { provider: base.defaults.provider ?? null, model: base.defaults.model || '', clientKey: '********', directory: base.defaults.directory || [], retry: base.defaults.retry, timeout: base.defaults.timeout, concurrency: base.defaults.concurrency || {}, extraHeaders: {}, proxy: base.defaults.proxy || '', proxyMode: base.defaults.proxyMode || 'auto' }
  await saveDefaults(panelDefaults)
  st = await status()
  check('面板式保存·affinityTtlMs 保留', st.defaults.affinityTtlMs === 120000, st.defaults)
  check('面板式保存·failbackProbe 保留', !!(st.defaults.failbackProbe && st.defaults.failbackProbe.enabled === true), st.defaults)
  check('面板式保存·白名单字段仍生效', st.defaults.proxy === (base.defaults.proxy || '') && st.defaults.proxyMode === (base.defaults.proxyMode || 'auto'), st.defaults)

  // 3) 无 defaults 键的保存
  await saveDefaults(undefined)
  st = await status()
  check('无 defaults 键·原样保留', st.defaults.affinityTtlMs === 120000 && !!(st.defaults.failbackProbe && st.defaults.failbackProbe.enabled), st.defaults)

  // 4) 显式覆盖仍生效
  await saveDefaults(Object.assign({}, panelDefaults, { affinityTtlMs: 60000 }))
  st = await status()
  check('显式提交·覆盖生效', st.defaults.affinityTtlMs === 60000, st.defaults)

  // 收尾：重置为与未设置等价（合并语义下无法删除，只能等价值覆盖）
  await saveDefaults(Object.assign({}, panelDefaults, { affinityTtlMs: 300000, failbackProbe: { enabled: false } }))
  st = await status()
  check('收尾·重置为等价默认', st.defaults.affinityTtlMs === 300000 && st.defaults.failbackProbe && st.defaults.failbackProbe.enabled === false, st.defaults)
} finally {
  await fx.stop()
}
finish('z-defaults-merge')
