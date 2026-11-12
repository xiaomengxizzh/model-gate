// 测试共享工具（MG-004 后只保留断言/结果/SSE 解析；不再提供 snapshot/save 这类「读改写目标网关配置」的入口）
// 门禁：npm test 白名单里的自包含套件直接运行；其余旧套件（现均为自建隔离实例）需显式 MG_ALLOW_LIVE_TESTS=1。
// 它们不再读写目标网关配置，也不再需要 MG_GW / MG_CONFIG_DIR。
import { basename } from 'node:path'

const defaultSuites = new Set(['virtual-models.mjs', 'effort-normalize.mjs', 'upstream-side-4xx.mjs',
  // Q01：circuit 经 E 隔离审计（自建 isolate 实例 + 回环 mock + 零宿主 env）后在默认回归中执行。
  // affinity 未登记：它依赖「5xx 响应后换上游」的过期语义（与契约 §9.5 一次终态冲突），需先重写。
  'circuit.mjs'])
if (!defaultSuites.has(basename(process.argv[1] || '')) && process.env.MG_ALLOW_LIVE_TESTS !== '1') {
  throw new Error('Legacy suites require MG_ALLOW_LIVE_TESTS=1（旧套件自建隔离网关实例，不再需要 MG_GW / MG_CONFIG_DIR）')
}

export const results = []

// 断言记录。FAIL 不中断用例（便于一次看完全部失败），退出码由 finish() 统一给出。
export function check(name, ok, detail) {
  results.push(!!ok)
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? ' :: ' + JSON.stringify(detail) : ''))
}

export const count = () => {
  const pass = results.filter(Boolean).length
  const fail = results.filter(x => !x).length
  return { pass, fail, total: pass + fail }
}

// 每个旧套件收尾调用：打印子结果，失败时置非零退出码（退出码 0 才代表通过）。
export function finish(label) {
  const c = count()
  console.log('  （' + (label || basename(process.argv[1] || 'suite')) + ' 子结果: ' + c.pass + '/' + c.total + '）')
  if (c.fail) process.exitCode = 1
  return c
}

export function streamDeltaText(text) {
  let o = ''
  for (const m of text.matchAll(/data:\s*([^\n]+)/g)) { const r = m[1].trim(); if (r === '[DONE]') continue; try { const j = JSON.parse(r); const c = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content; if (typeof c === 'string') o += c } catch {} }
  return o
}
