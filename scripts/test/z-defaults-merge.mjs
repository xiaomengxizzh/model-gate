// defaults 合并保存契约（面板保存不冲掉自定义字段）：
// 1) 含自定义字段的完整保存可见；2) 面板式保存（仅白名单字段）不得冲掉未回传字段；
// 3) 不带 defaults 键的保存原样保留；4) 显式提交仍可覆盖。
// 注：合并语义下字段无法经保存接口删除，收尾把自定义字段重置为与「未设置」行为等价的值，
//     避免残留影响同实例上的其他测试（affinityTtlMs 回代码默认 300000，failbackProbe.enabled=false）。
import { GW, check, snapshot, save } from './utils.mjs'

const status = async () => (await fetch(GW + '/api/status')).json()
const base = await snapshot()
const custom = { affinityTtlMs: 120000, failbackProbe: { enabled: true, everyMs: 30000, successStreak: 2, system: 'ping' } }

// 1) 完整保存（含自定义字段）
let st = await status()
const before = st.defaults.affinityTtlMs
await save(base.providers, base.models, Object.assign({}, base.defaults, custom))
st = await status()
check('完整保存·自定义字段落盘', st.defaults.affinityTtlMs === 120000 && st.defaults.failbackProbe && st.defaults.failbackProbe.everyMs === 30000, st.defaults)

// 2) 面板式保存：defaults 只含白名单字段（extraHeaders 硬编码 {}，模拟 admin.html 行为）
const panelDefaults = { provider: base.defaults.provider ?? null, model: base.defaults.model || '', clientKey: '********', directory: base.defaults.directory || [], retry: base.defaults.retry, timeout: base.defaults.timeout, concurrency: base.defaults.concurrency || {}, extraHeaders: {}, proxy: base.defaults.proxy || '', proxyMode: base.defaults.proxyMode || 'auto' }
await save(base.providers, base.models, panelDefaults)
st = await status()
check('面板式保存·affinityTtlMs 保留', st.defaults.affinityTtlMs === 120000, st.defaults)
check('面板式保存·failbackProbe 保留', !!(st.defaults.failbackProbe && st.defaults.failbackProbe.enabled === true), st.defaults)
check('面板式保存·白名单字段仍生效', st.defaults.proxy === (base.defaults.proxy || '') && st.defaults.proxyMode === (base.defaults.proxyMode || 'auto'), st.defaults)

// 3) 无 defaults 键的保存
await save(base.providers, base.models, undefined)
st = await status()
check('无 defaults 键·原样保留', st.defaults.affinityTtlMs === 120000 && !!(st.defaults.failbackProbe && st.defaults.failbackProbe.enabled), st.defaults)

// 4) 显式覆盖仍生效
await save(base.providers, base.models, Object.assign({}, panelDefaults, { affinityTtlMs: 60000 }))
st = await status()
check('显式提交·覆盖生效', st.defaults.affinityTtlMs === 60000, st.defaults)

// 收尾：重置为与未设置等价（合并语义下无法删除，只能等价值覆盖）
await save(base.providers, base.models, Object.assign({}, panelDefaults, { affinityTtlMs: 300000, failbackProbe: { enabled: false } }))
st = await status()
check('收尾·重置为等价默认', st.defaults.affinityTtlMs === 300000 && st.defaults.failbackProbe && st.defaults.failbackProbe.enabled === false, st.defaults)
