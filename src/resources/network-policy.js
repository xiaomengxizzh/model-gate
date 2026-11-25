import { isIP } from 'node:net'
import { lookup as dnsLookupCallback } from 'node:dns'
import { promisify } from 'node:util'

const dnsLookup = promisify(dnsLookupCallback)

const DEFAULT_TIMEOUT_MS = 5000
const HOST_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/

function ipv4Numbers(address) {
  return isIP(address) === 4 ? address.split('.').map(Number) : null
}

function privateIPv4(address) {
  const parts = ipv4Numbers(address)
  if (!parts) return false
  const [a, b] = parts
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && parts[2] === 0)))
    || (a === 168 && b === 63 && parts[2] === 129 && parts[3] === 16) // Azure platform virtual IP
    || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19))
    || a >= 224
}

// URL and DNS normally return compressed hexadecimal, but injected resolvers may
// return an embedded dotted-quad. Normalize either form before range checks.
function ipv6Words(address) {
  if (isIP(address) !== 6 || address.includes('%')) return null
  let text = address.toLowerCase()
  if (text.includes('.')) {
    const colon = text.lastIndexOf(':')
    const dotted = text.slice(colon + 1)
    const parts = ipv4Numbers(dotted)
    if (!parts) return null
    const hex = [(parts[0] << 8) | parts[1], (parts[2] << 8) | parts[3]]
      .map((part) => part.toString(16))
    text = text.slice(0, colon + 1) + hex.join(':')
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves[1] ? halves[1].split(':') : []
  if ([...left, ...right].some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return null
  if (halves.length === 1 && left.length !== 8) return null
  if (halves.length === 2 && left.length + right.length >= 8) return null
  const words = halves.length === 2
    ? [...left, ...Array(8 - left.length - right.length).fill(0), ...right]
    : left
  return words.map((word) => Number.parseInt(word, 16))
}

function mappedIPv4(words) {
  // IPv4-mapped ::ffff:0:0/96 and IPv4-translated ::ffff:0:0:0/96.
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return `${words[6] >>> 8}.${words[6] & 255}.${words[7] >>> 8}.${words[7] & 255}`
  }
  if (words.slice(0, 4).every((word) => word === 0) && words[4] === 0xffff
      && words[5] === 0) {
    return `${words[6] >>> 8}.${words[6] & 255}.${words[7] >>> 8}.${words[7] & 255}`
  }
  return ''
}

function privateIPv6(address) {
  const words = ipv6Words(address)
  if (!words) return true
  const embedded = mappedIPv4(words)
  if (embedded) return privateIPv4(embedded)
  // Deprecated IPv4-compatible forms must not bypass the mapped checks.
  if (words.slice(0, 6).every((word) => word === 0)) {
    return privateIPv4(`${words[6] >>> 8}.${words[6] & 255}.${words[7] >>> 8}.${words[7] & 255}`)
  }
  // A NAT64 translation of a restricted IPv4 destination is restricted too.
  if (words[0] === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every((word) => word === 0)) {
    return privateIPv4(`${words[6] >>> 8}.${words[6] & 255}.${words[7] >>> 8}.${words[7] & 255}`)
  }
  // RFC 8215 local-use NAT64 /48 embeds IPv4 in bits 48..63 and 72..87.
  if (words[0] === 0x64 && words[1] === 0xff9b && words[2] === 1 && (words[4] & 0xff00) === 0) {
    return privateIPv4(`${words[3] >>> 8}.${words[3] & 255}.${words[5] >>> 8}.${words[5] & 255}`)
  }
  // 6to4 and Teredo can encapsulate a restricted IPv4 endpoint.
  if (words[0] === 0x2002) {
    return privateIPv4(`${words[1] >>> 8}.${words[1] & 255}.${words[2] >>> 8}.${words[2] & 255}`)
  }
  if (words[0] === 0x2001 && words[1] === 0) {
    const server = `${words[2] >>> 8}.${words[2] & 255}.${words[3] >>> 8}.${words[3] & 255}`
    const client = `${(words[5] ^ 0xffff) >>> 8}.${(words[5] ^ 0xffff) & 255}.${(words[6] ^ 0xffff) >>> 8}.${(words[6] ^ 0xffff) & 255}`
    return privateIPv4(server) || privateIPv4(client)
  }
  return words.every((word) => word === 0)
    || words.slice(0, 7).every((word) => word === 0) && words[7] === 1
    || (words[0] & 0xfe00) === 0xfc00 // unique-local fc00::/7
    || (words[0] & 0xffc0) === 0xfe80 // link-local fe80::/10
    || (words[0] & 0xffc0) === 0xfec0 // deprecated site-local fec0::/10
    || (words[0] & 0xff00) === 0xff00 // multicast ff00::/8
}

function canonicalAddress(address) {
  return isIP(address) === 6
    ? new URL(`http://[${address}]`).hostname.slice(1, -1)
    : address
}

function invalid(code, error) {
  return { code, error }
}

function parseEndpoint(raw) {
  if (typeof raw !== 'string' || !raw || /[\u0000-\u0020\u007f]/.test(raw)) {
    return invalid('invalid_endpoint', '服务地址必须是完整 http(s) URL')
  }
  let url
  try { url = new URL(raw) } catch { return invalid('invalid_endpoint', '服务地址必须是完整 http(s) URL') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return invalid('invalid_endpoint', '服务地址仅支持 http(s)')
  }
  const match = raw.match(/^https?:\/\/([^/?#]*)/i)
  if (!match) return invalid('invalid_endpoint', '服务地址必须是完整 http(s) URL')
  const authority = match[1]
  if (authority.includes('@') || authority.includes('\\')) {
    return invalid('invalid_endpoint', '服务地址不能包含账号或密码')
  }
  if (raw.includes('#')) return invalid('invalid_endpoint', '服务地址不能包含 fragment')
  const portText = authority.startsWith('[')
    ? authority.slice(authority.indexOf(']') + 1)
    : authority.slice(authority.lastIndexOf(':') + 1)
  const hasPort = authority.startsWith('[') ? portText.startsWith(':') : authority.includes(':')
  if (hasPort && (!/^\d+$/.test(portText.slice(1)) || Number(portText.slice(1)) < 1
      || Number(portText.slice(1)) > 65535)) {
    return invalid('invalid_endpoint', '服务地址端口必须在 1-65535 之间')
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (hostname.includes('%')) return invalid('invalid_endpoint', '服务地址包含无效主机名')
  if (!isIP(hostname)) {
    const dnsName = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname
    if (!dnsName || dnsName.length > 253 || dnsName.split('.').some((label) => !HOST_LABEL.test(label))) {
      return invalid('invalid_endpoint', '服务地址包含无效主机名')
    }
    return { url, hostname: dnsName }
  }
  return { url, hostname }
}

/**
 * Validate an endpoint immediately before connecting. Success:
 * { value, hostname, addresses }. Failure: { code, error }.
 *
 * Callers performing real I/O must also install pinnedLookup(result) on the
 * socket/request. Validation alone is not TOCTOU protection.
 */
export async function validateEndpointNetwork(raw, options = {}) {
  const parsed = parseEndpoint(raw)
  if (parsed.code) return parsed
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    return invalid('invalid_options', 'options 必须是对象')
  }
  const { url, hostname } = parsed
  const lookup = options.lookup === undefined ? dnsLookup : options.lookup
  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs
  const signal = options.signal
  if (typeof lookup !== 'function') return invalid('invalid_options', 'lookup 必须是函数')
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return invalid('invalid_options', 'timeoutMs 必须是正数')
  if (signal != null && (typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function')) {
    return invalid('invalid_options', 'signal 必须是 AbortSignal')
  }
  if (signal && signal.aborted) return Object.assign(invalid('aborted', '服务地址解析已取消'), { aborted: true })

  let addresses
  if (isIP(hostname)) {
    addresses = [{ address: hostname, family: isIP(hostname) }]
  } else {
    let timer
    let onAbort
    try {
      const answers = await Promise.race([
        Promise.resolve().then(() => lookup(hostname, { all: true, verbatim: true })),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error('DNS lookup timed out')
            error.code = 'ETIMEOUT'
            reject(error)
          }, timeoutMs)
          timer.unref()
          if (signal) {
            onAbort = () => {
              const error = new Error('DNS lookup aborted')
              error.code = 'ABORT_ERR'
              error.aborted = true
              reject(error)
            }
            signal.addEventListener('abort', onAbort, { once: true })
          }
        })
      ])
      if (!Array.isArray(answers) || answers.length === 0) {
        return invalid('dns_error', '服务域名没有返回可用地址')
      }
      addresses = answers.map((answer) => {
        if (!answer || typeof answer.address !== 'string') return null
        const family = isIP(answer.address)
        const answerFamily = typeof answer.family === 'string'
          ? (answer.family === 'IPv4' || answer.family === 'IPv6' ? answer.family : '')
          : answer.family
        if (!family || (answerFamily !== 4 && answerFamily !== 6 && answerFamily !== 'IPv4' && answerFamily !== 'IPv6')
            || (answerFamily === 4 || answerFamily === 'IPv4' ? family !== 4 : family !== 6)) return null
        return { address: canonicalAddress(answer.address), family }
      })
      if (addresses.some((answer) => !answer)) return invalid('dns_error', '服务域名返回了无效地址')
      addresses.sort((left, right) => left.family - right.family)
    } catch (error) {
      if ((signal && signal.aborted) || (error && error.code === 'ABORT_ERR')) {
        return Object.assign(invalid('aborted', '服务地址解析已取消'), { aborted: true })
      }
      return invalid('dns_error', '服务域名解析失败或超时')
    } finally {
      clearTimeout(timer)
      if (signal && onAbort) { try { signal.removeEventListener('abort', onAbort) } catch {} }
    }
  }

  for (const { address, family } of addresses) {
    const restricted = family === 4 ? privateIPv4(address) : privateIPv6(address)
    if (restricted && options.allowPrivateNetwork !== true) {
      return invalid('private_address', `服务地址解析到禁止的网络地址: ${address}`)
    }
  }
  return { value: url.toString().replace(/\/+$/, ''), hostname, addresses }
}

function lookupHostname(hostname) {
  return String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
}

/**
 * Build a Node-compatible lookup that can only return this validation's exact
 * answers. A second DNS query (including a rebinding query) is never performed.
 */
export function pinnedLookup(network) {
  if (!network || !Array.isArray(network.addresses) || !network.addresses.length) {
    throw new TypeError('pinnedLookup requires validated addresses')
  }
  const expected = lookupHostname(network.hostname)
  return (hostname, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {} }
    options = options || {}
    if (lookupHostname(hostname) !== expected) {
      return callback(Object.assign(new Error('unexpected lookup hostname'), { code: 'ENOTFOUND' }))
    }
    const family = options.family === undefined || options.family === 0 ? null : options.family
    const answers = network.addresses.filter((answer) => !family || answer.family === family)
    if (!answers.length) {
      return callback(Object.assign(new Error('no validated address for family'), { code: 'ENOTFOUND' }))
    }
    if (options.all) return callback(null, answers.map((answer) => ({ ...answer })))
    const answer = answers[0]
    callback(null, answer.address, answer.family)
  }
}

function proxyInvalid(message) {
  return invalid('invalid_proxy', message)
}

function decodeProxyCredential(value) {
  try { return decodeURIComponent(value) } catch { throw new Error('invalid proxy credential encoding') }
}

/**
 * Validate and pin an HTTP CONNECT/forward proxy. Credentials are supported in
 * URL userinfo only; HTTPS/SOCKS proxies are rejected because this transport
 * does not implement their wire protocol. The historical default port is 7890.
 */
export async function validateProxyNetwork(raw, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    return proxyInvalid('代理配置必须是对象')
  }
  let host
  let port
  let auth = null
  let endpoint
  if (raw && typeof raw === 'object') {
    host = typeof raw.host === 'string' ? raw.host.trim() : ''
    port = raw.port === undefined ? 7890 : Number(raw.port)
    auth = raw.auth == null ? null : String(raw.auth)
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return proxyInvalid('代理地址或端口无效')
    if (auth && !/^Basic [A-Za-z0-9+/]+={0,2}$/.test(auth)) return proxyInvalid('代理认证格式无效')
    endpoint = `http://${host.includes(':') && isIP(host) === 6 ? `[${host}]` : host}:${port}`
  } else if (typeof raw === 'string' && raw) {
    if (/[\u0000-\u0020\u007f]/.test(raw)) return proxyInvalid('代理 URL 包含无效字符')
    let url
    try { url = new URL(raw) } catch { return proxyInvalid('代理 URL 无效') }
    if (url.protocol !== 'http:') return proxyInvalid('代理仅支持 http:// URL')
    if (url.hash || url.search || (url.pathname && url.pathname !== '/') || raw.includes('#') || raw.includes('?')) {
      return proxyInvalid('代理 URL 不能包含路径、查询或 fragment')
    }
    const authority = raw.match(/^http:\/\/([^/?#]*)/i)
    if (!authority || authority[1].endsWith(':')) return proxyInvalid('代理 URL 端口无效')
    if (String(raw).includes('\\')) return proxyInvalid('代理 URL 包含无效字符')
    if (url.password && !url.username) return proxyInvalid('代理 URL 凭据格式无效')
    try {
      if (url.username) {
        auth = 'Basic ' + Buffer.from(decodeProxyCredential(url.username) + ':' + decodeProxyCredential(url.password || '')).toString('base64')
      }
    } catch { return proxyInvalid('代理 URL 凭据编码无效') }
    host = url.hostname.replace(/^\[|\]$/g, '')
    const hostPort = authority[1].slice(authority[1].lastIndexOf('@') + 1)
    const portText = hostPort.startsWith('[')
      ? hostPort.slice(hostPort.indexOf(']') + 1)
      : (hostPort.includes(':') ? hostPort.slice(hostPort.lastIndexOf(':') + 1) : '')
    port = portText ? Number(portText.replace(/^:/, '')) : 7890
    endpoint = `http://${url.host}`
  } else {
    return proxyInvalid('代理 URL 无效')
  }
  const network = await validateEndpointNetwork(endpoint, options)
  if (network.error) {
    return network.code === 'invalid_endpoint'
      ? proxyInvalid(network.error)
      : network
  }
  return Object.assign({}, network, { host: network.hostname, port, auth, lookup: pinnedLookup(network) })
}
