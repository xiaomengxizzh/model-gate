import { appendFileSync, mkdirSync } from 'node:fs'
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

// 失败必留痕：日志同时写控制台与文件
export function createLogger(opts = {}) {
  const file = opts.logFile || join(homedir(), '.model-gateway', 'gateway.log')
  const silent = !!opts.silent
  // 硬性约定：环境变量/面板 Key 值一律抹成 '****'，杜绝落盘/落日志
  const secrets = (opts.secrets || []).map((s) => String(s)).filter((s) => s && s.length >= 3)
  function mask(line) {
    let s = line
    for (const sec of secrets) { const re = new RegExp(escapeReg(sec), 'g'); s = s.replace(re, '****') }
    s = s.replace(TOKEN_RE, 'Bearer ****')
    return s
  }
  function write(line) {
    const safe = mask(String(line))
    if (!silent) process.stdout.write(safe + '\n')
    try {
      mkdirSync(dirname(file), { recursive: true })
      appendFileSync(file, safe + '\n')
    } catch { /* 日志文件不可写时忽略，避免级联失败 */ }
  }
  const ts = () => new Date().toISOString()
  return {
    info: (m, ...r) => write('[' + ts() + '] [info]  ' + fmt(m, r)),
    warn: (m, ...r) => write('[' + ts() + '] [warn]  ' + fmt(m, r)),
    error: (m, ...r) => write('[' + ts() + '] [error] ' + fmt(m, r)),
  }
}
