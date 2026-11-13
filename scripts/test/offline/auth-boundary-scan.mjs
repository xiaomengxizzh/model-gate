// G1（2026-11-13）认证边界静态扫描：单一实现，供 native-boundary 与 codex-p09 套件复用。
//
// 目标：生产代码不得再读取 Codex 本机登录态（auth.json / CODEX_HOME），不得引用已退役的
// local-subscription 模块，也不得把订阅后端路径写回请求路径。扫描必须是递归的：只扫几个
// “看起来相关”的文件正是 F01 回归能漏掉 src/codex/local-subscription.js 的原因。
//
// 边界：
// - 只扫 src/ 下的 .js/.mjs；docs/、scripts/ 的历史证据与测试夹具不在扫描范围。
// - 行级跳过整行注释（//、*、/*、*/）；当前仓库没有跨行注释混入敏感字面量的情况。
// - auth.json 允许出现在“禁止路径”护栏模块中（只做 basename 比较/UI 文案，不读取内容）；
//   新增条目必须说明为什么不是凭据读取，否则扫描必须失败。
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

export const AUTH_JSON_GUARD_MODULES = Object.freeze([
  'src/codex/config.js',                 // 路径护栏：拒绝写 auth.json
  'src/codex/api.js',                    // 管理面路径护栏：拒绝读写 auth.json
  'src/codex/history.js',                // 导出路径护栏：拒绝写 auth.json
  'src/ui-next/js/views/codex.js',       // UI 文案：声明永不读取/写入
  'src/ui-next/js/views/clients.js',     // UI 文案：声明控制台不读取凭据文件
])

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, out)
    else if (/\.m?js$/.test(entry.name)) out.push(path)
  }
  return out
}

function codeOnly(source) {
  return source.split('\n').filter((line) => {
    const t = line.trim()
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('*/'))
  }).join('\n')
}

/** 返回违规列表（空数组 = 通过）；每个元素带文件与原因，失败信息可直接进入报告。 */
export function scanAuthBoundary(projectRoot) {
  const violations = []
  const srcRoot = join(projectRoot, 'src')
  if (!existsSync(srcRoot)) return ['src/ 不存在，无法执行认证边界扫描']
  const files = walk(srcRoot)
  for (const file of files) {
    const rel = relative(projectRoot, file).split('\\').join('/')
    const code = codeOnly(readFileSync(file, 'utf8'))
    if (/\.CODEX_HOME\b/.test(code)) violations.push(rel + ': 读取 CODEX_HOME（不得从 Codex 登录环境推导凭据）')
    if (/(?:readSubscriptionCredential|local-subscription)/.test(code)) violations.push(rel + ': 引用已退役的 local-subscription/readSubscriptionCredential')
    if (/['"`]\/backend-api\//.test(code)) violations.push(rel + ': 含订阅后端请求路径字面量')
    if (/['"]\.codex['"]/.test(code)) violations.push(rel + ': 拼装 ~/.codex 登录目录')
    if (/auth\.json/.test(code) && !AUTH_JSON_GUARD_MODULES.includes(rel)) {
      violations.push(rel + ': auth.json 只允许出现在防御性路径护栏模块')
    }
  }
  if (existsSync(join(srcRoot, 'codex', 'local-subscription.js'))) {
    violations.push('src/codex/local-subscription.js 必须删除（生产代码不得读取 Codex 登录态）')
  }
  const indexPath = join(srcRoot, 'index.js')
  if (existsSync(indexPath)) {
    // 注释里可以保留“已退役”的溯源说明；这里只要求**可执行代码**不再引用/import。
    const indexCode = codeOnly(readFileSync(indexPath, 'utf8'))
    if (/(?:readSubscriptionCredential|local-subscription)/.test(indexCode)) violations.push('src/index.js 不得再 import/引用 local-subscription.js')
    if (/['"`]\/backend-api\//.test(indexCode)) violations.push('src/index.js 不得拼装订阅后端路径')
  }
  return violations
}
