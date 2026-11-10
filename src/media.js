// 媒体能力（MG-013，Audio / Image）：请求校验、multipart 路由字段解析与能力边界。
// 设计：只桥接 OpenAI 兼容上游；multipart 请求体原样转发（不重编码），响应二进制/JSON 原样回传。
// 体积、预算、取消由调用方（index.js）统一控制；不支持的上游协议显式拒绝，不做伪桥接。
export const MEDIA_MAX_RESPONSE_BYTES = 64 * 1024 * 1024

// 上游协议是否支持媒体桥接：只支持 OpenAI 兼容（含中转站）。
export function supportsMedia(api) { return !api || api === 'openai' }

// 从 multipart/form-data 里取一个普通字段（用于路由必需的 model）。仅解析头部与边界，
// 不重编码文件内容；解析失败返回 null（调用方按 400 处理）。
export function parseMultipartField(buf, contentType, name) {
  if (!buf || !buf.length || !contentType) return null
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType))
  const boundary = m && (m[1] || m[2])
  if (!boundary) return null
  const delim = Buffer.from('--' + boundary)
  const want = new RegExp('name="' + String(name).replace(/[.*+?^\${}()|[\]\\]/g, '\\$&') + '"')
  let idx = buf.indexOf(delim)
  while (idx !== -1) {
    const after = idx + delim.length
    if (buf[after] === 0x2d && buf[after + 1] === 0x2d) break // 结束标记
    const hdrEnd = buf.indexOf('\r\n\r\n', after)
    if (hdrEnd === -1) break
    const headers = buf.slice(after, hdrEnd).toString('utf8')
    const bodyStart = hdrEnd + 4
    let next = buf.indexOf(delim, bodyStart)
    if (next === -1) next = buf.length
    if (want.test(headers)) {
      let val = buf.slice(bodyStart, next)
      if (val.length >= 2 && val[val.length - 2] === 0x0d && val[val.length - 1] === 0x0a) val = val.slice(0, -2)
      return val.toString('utf8').trim()
    }
    idx = buf.indexOf(delim, bodyStart)
  }
  return null
}

export function isMultipart(contentType) { return /^multipart\/form-data/i.test(String(contentType || '')) }

// 重写 multipart 普通字段（如 per-上游模型名覆盖）。返回新 Buffer；找不到字段/边界时返回 null。
export function replaceMultipartField(buf, contentType, name, value) {
  if (!buf || !buf.length || !contentType) return null
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType))
  const boundary = m && (m[1] || m[2])
  if (!boundary) return null
  const delim = Buffer.from('--' + boundary)
  const want = new RegExp('name="' + String(name).replace(/[.*+?^\${}()|[\]\\]/g, '\\$&') + '"')
  let idx = buf.indexOf(delim)
  while (idx !== -1) {
    const after = idx + delim.length
    if (buf[after] === 0x2d && buf[after + 1] === 0x2d) break
    const hdrEnd = buf.indexOf('\r\n\r\n', after)
    if (hdrEnd === -1) break
    const bodyStart = hdrEnd + 4
    let next = buf.indexOf(delim, bodyStart)
    if (next === -1) next = buf.length
    const headers = buf.slice(after, hdrEnd).toString('utf8')
    if (want.test(headers)) {
      return Buffer.concat([buf.slice(0, bodyStart), Buffer.from(String(value)), buf.slice(next)])
    }
    idx = buf.indexOf(delim, bodyStart)
  }
  return null
}

const SPEECH_FORMATS = ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm']

export function validateSpeechRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: '请求体必须为 JSON 对象' }
  if (typeof body.model !== 'string' || body.model.trim() === '') return { error: '缺少 model' }
  if (typeof body.input !== 'string' || body.input === '') return { error: 'input 必须为非空字符串' }
  if (body.voice != null && (typeof body.voice !== 'string' || body.voice === '')) return { error: 'voice 必须为非空字符串' }
  if (body.response_format != null && !SPEECH_FORMATS.includes(String(body.response_format))) return { error: 'response_format 仅支持 ' + SPEECH_FORMATS.join('/') }
  if (body.speed != null && (!Number.isFinite(Number(body.speed)) || Number(body.speed) < 0.25 || Number(body.speed) > 4)) return { error: 'speed 必须在 0.25–4 之间' }
  return null
}

export function validateImageRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: '请求体必须为 JSON 对象' }
  if (typeof body.model !== 'string' || body.model.trim() === '') return { error: '缺少 model' }
  if (typeof body.prompt !== 'string' || body.prompt === '') return { error: 'prompt 必须为非空字符串' }
  if (body.n != null && (!Number.isInteger(Number(body.n)) || Number(body.n) < 1 || Number(body.n) > 10)) return { error: 'n 必须为 1–10 的整数' }
  if (body.size != null && typeof body.size !== 'string') return { error: 'size 必须为字符串（如 1024x1024）' }
  if (body.response_format != null && !['url', 'b64_json'].includes(String(body.response_format))) return { error: 'response_format 仅支持 url/b64_json' }
  return null
}

// 媒体响应体上限：默认 64MiB；允许 defaults.mediaMaxResponseBytes 覆盖（测试与受限实例）。
export function mediaResponseLimit(cfg) {
  const n = Number(cfg && cfg.defaults && cfg.defaults.mediaMaxResponseBytes)
  return Number.isFinite(n) && n > 0 ? n : MEDIA_MAX_RESPONSE_BYTES
}
