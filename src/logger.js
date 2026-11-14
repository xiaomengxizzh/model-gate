import { appendFileSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

function safeJSON(v) {
  try { return typeof v === 'string' ? v : JSON.stringify(v) } catch { return String(v) }
}
function fmt(msg, rest) {
  if (!rest.length) return typeof msg === 'string' ? msg : safeJSON(msg)
  return safeJSON(msg) + ' ' + rest.map(safeJSON).join(' ')
}

function escapeReg(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
// 通用 Bearer 令牌兜底脱敏
const TOKEN_RE = /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi
// 常见 API Key 形态（sk-/rk-/pk-）兜底脱敏：即使 Key 不在启动/热更新词表里，
// 也不允许以上游错误片段/请求摘要形式落盘（审计 P1「上游错误片段可能回显请求内容并写日志」）。
const API_KEY_RE = /\b(?:sk|rk|pk)-[A-Za-z0-9._-]{8,}/g
// URL 内嵌凭据（scheme://user:pass@host）用线性扫描抹除：可回溯字符类在超长单行上是 O(n²)。
const URL_STOP = /[\s"'()<>,;]/
function maskUrlCreds(s) {
  if (s.indexOf('://') === -1 || s.indexOf('@') === -1) return s
  let out = ''
  let i = 0
  while (true) {
    const at = s.indexOf('://', i)
    if (at === -1) break
    let end = at + 3
    const limit = Math.min(s.length, at + 3 + 512)
    while (end < limit && !URL_STOP.test(s[end])) end++
    const authority = s.slice(at + 3, end)
    const atSign = authority.indexOf('@')
    const colon = authority.indexOf(':')
    if (atSign > 0 && colon > 0 && colon < atSign) {
      out += s.slice(i, at + 3) + '****:****@' + authority.slice(atSign + 1)
      i = end
      continue
    }
    out += s.slice(i, at + 3)
    i = at + 3
  }
  return out + s.slice(i)
}

// 日志落盘策略（2026-08-29）：按天分文件 <base>-YYYY-MM-DD.log；
//   启动/跨天时清理 7 天前的旧日志（含 .old 轮转件与历史无日期旧版，后者按 mtime 判断）；
//   单文件超 5MB 轮转为 <base>-<date>.log.old（同日覆盖），防错误风暴刷爆磁盘。
// prune 只碰「本日志前缀」命中的文件，其它文件一律不动。
const KEEP_DAYS = 7
const MAX_BYTES = 5 * 1024 * 1024

// 失败必留痕：日志同时写控制台与文件
export function createLogger(opts = {}) {
  const spec = opts.logFile || join(homedir(), '.model-gateway', 'gateway.log')
  const silent = !!opts.silent
  const m = spec.match(/^(.*[\\/])?([^\\/]+?)(\.[^.]+)?$/)
  const dir = m[1] || ''
  const base = m[2] || 'gateway'
  const ext = m[3] || '.log'
  // 硬性约定：环境变量/面板 Key 值一律抹成 '****'，杜绝落盘/落日志。
  // 列表可在运行期替换（MG-005）：热更新 Key 后面板保存会调 setSecrets 重新收集，
  // 否则新 Key 在重启前永远不会被脱敏。
  const normalize = (list) => (list || []).map((s) => String(s)).filter((s) => s && s.length >= 3)
  let secrets = normalize(opts.secrets)
  function setSecrets(list) { secrets = normalize(list) }
  function mask(line) {
    let s = line
    for (const sec of secrets) { const re = new RegExp(escapeReg(sec), 'g'); s = s.replace(re, '****') }
    s = s.replace(TOKEN_RE, 'Bearer ****')
    s = s.replace(API_KEY_RE, '****')
    // 代理/URL 内嵌凭据：http://user:pass@host 属于最常见的"日志里带秘密"形态，与 secrets 列表无关地兜底
    return maskUrlCreds(s)
  }
  function localDate(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') }
  let curDate = localDate(new Date())
  let curFile = join(dir, base + '-' + curDate + ext)
  function prune() {
    const cutoff = localDate(new Date(Date.now() - KEEP_DAYS * 86400000))
    const re = new RegExp('^' + escapeReg(base) + '(?:-(\\d{4}-\\d{2}-\\d{2}))?' + escapeReg(ext) + '(?:\\.old)?$')
    let names = []
    try { names = readdirSync(dir || '.') } catch { return }
    for (const f of names) {
      const mm = f.match(re)
      if (!mm) continue
      let old = false
      if (mm[1]) old = mm[1] < cutoff
      else { try { old = statSync(join(dir, f)).mtime.getTime() < Date.now() - KEEP_DAYS * 86400000 } catch { continue } }
      if (old) { try { unlinkSync(join(dir, f)) } catch { } }
    }
  }
  function rotateIfNeeded() {
    try {
      if (statSync(curFile).size < MAX_BYTES) return
      try { unlinkSync(curFile + '.old') } catch { }
      renameSync(curFile, curFile + '.old')
    } catch { }
  }
  prune()
  function write(line) {
    const safe = mask(String(line))
    if (!silent) process.stdout.write(safe + '\n')
    try {
      const today = localDate(new Date())
      if (today !== curDate) { curDate = today; curFile = join(dir, base + '-' + today + ext); prune() }
      mkdirSync(dirname(curFile), { recursive: true })
      rotateIfNeeded()
      appendFileSync(curFile, safe + '\n')
    } catch { /* 日志文件不可写时忽略，避免级联失败 */ }
  }
  const ts = () => new Date().toISOString()
  return {
    info: (m, ...r) => write('[' + ts() + '] [info]  ' + fmt(m, r)),
    warn: (m, ...r) => write('[' + ts() + '] [warn]  ' + fmt(m, r)),
    error: (m, ...r) => write('[' + ts() + '] [error] ' + fmt(m, r)),
    file: () => curFile, // 当前实际日志文件（面板 /api/logs 用）
    setSecrets,          // 运行期刷新脱敏词表（配置保存/Key 热更新后调用）
    secrets: () => secrets.slice(),
  }
}
