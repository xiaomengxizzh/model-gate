// 共享纯工具（index.js 与 forward.js 双向使用，独立成模块避免循环依赖）
export function todayKey(d) { const x = d || new Date(); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0') }
