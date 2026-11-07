// 敏感字段脱敏（G1）：管理面响应、错误体、诊断导出统一走这里。
// 原则：只掩码「值」，保留键名与可诊断信息；掩码统一为 '****'，保存时可识别为「未改动」。

export const MASK = '****'
const SECRET_KEY_RE = /(authorization|api[-_]?key|token|secret|password|passwd|cookie|session[-_]?id|bearer|credential|x-api-key)/i
const VALUE_PATTERNS = [
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\b(gh[pousr]_[A-Za-z0-9]{10,})\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
]

// 文本级脱敏：错误体、日志片段、诊断字符串
export function redactText(text, extraSecrets = []) {
  let s = String(text == null ? '' : text)
  for (const sec of extraSecrets) {
    const v = String(sec || '')
    if (v.length < 6) continue
    s = s.split(v).join(MASK)
  }
  for (const re of VALUE_PATTERNS) s = s.replace(re, (m, p1) => (p1 && /^Bearer/i.test(p1)) ? p1 + MASK : MASK)
  return s
}

// 头对象脱敏：敏感头整体掩码，其余原样
export function redactHeaders(headers) {
  const out = {}
  for (const [k, v] of Object.entries(headers || {})) {
    out[k] = SECRET_KEY_RE.test(k) ? MASK : (typeof v === 'string' ? redactText(v) : v)
  }
  return out
}

// 代理地址脱敏：保留 host:port 与协议，userinfo 掩码（http://user:pass@host:port）
export function redactProxy(proxy) {
  const s = String(proxy || '')
  if (!s) return s
  try {
    const u = new URL(s)
    if (u.username || u.password) { u.username = MASK; u.password = MASK }
    return u.toString().replace(/\/$/, '')
  } catch { return redactText(s) }
}

// 上游 4xx/5xx 响应体回显前的脱敏：JSON 原文保留结构，只替换敏感字面量
export function redactBody(buf) {
  if (!buf) return buf
  let text
  try { text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf) } catch { return buf }
  const safe = redactText(text)
  return safe === text ? buf : Buffer.from(safe)
}

// 判断某请求体是否携带工具语义（与 budget.isToolBearingBody 同义，集中导出便于契约文档引用）
export function bodyHasTools(body) {
  if (!body || typeof body !== 'object') return false
  if (Array.isArray(body.tools) && body.tools.length) return true
  if (Array.isArray(body.messages) && body.messages.some(m => m && m.role === 'tool')) return true
  return false
}
