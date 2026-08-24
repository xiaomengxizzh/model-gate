import { GW, check } from './utils.mjs'
// 延迟历史趋势：状态直读 /api/status 的 global.latTrend（面板 sparkline 数据源）
const st = await (await fetch(GW + '/api/status')).json()
const trend = st.global && st.global.latTrend
check('延迟趋势·latTrend 时间序列存在', Array.isArray(trend), { len: trend ? trend.length : 0 })