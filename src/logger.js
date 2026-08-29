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
  // 硬性约定：环境变量/面板 Key 值一律抹成 '****'，杜绝落盘/落日志
  const secrets = (opts.secrets || []).map((s) => String(s)).filter((s) => s && s.length >= 3)
  function mask(line) {
    let s = line
    for (const sec of secrets) { const re = new RegExp(escapeReg(sec), 'g'); s = s.replace(re, '****') }
    s = s.replace(TOKEN_RE, 'Bearer ****')
    return s
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
  }
}
