export const SECRET_MASK = '********'

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }

export function safeUrl(value) {
  try {
    const url = new URL(String(value || ''))
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return ''
  }
}

function hasUrlSecrets(value) {
  try {
    const url = new URL(String(value || ''))
    return !!(url.username || url.password || url.search || url.hash)
  } catch {
    return false
  }
}

function configured(value) { return value != null && value !== '' }

function redactSecretFields(value) {
  const out = { ...value }
  if (value.extraHeaders && typeof value.extraHeaders === 'object' && !Array.isArray(value.extraHeaders)) {
    out.extraHeaders = Object.fromEntries(Object.keys(value.extraHeaders).map((name) => [name, SECRET_MASK]))
  }
  if (value.proxy && value.proxy !== 'direct') {
    out.proxy = SECRET_MASK
    out.proxyConfigured = true
  }
  if (configured(value.sessionHmacSecret)) out.sessionHmacSecret = SECRET_MASK
  if (hasUrlSecrets(value.baseUrl)) {
    out.baseUrl = safeUrl(value.baseUrl)
    out.baseUrlMasked = true
  }
  return out
}

export function redactConnectionForConfig(connection) {
  return object(connection) ? redactSecretFields(connection) : connection
}

export function redactProviderForConfig(provider) {
  const out = redactSecretFields(provider)
  if (Array.isArray(provider.connections)) out.connections = provider.connections.map(redactConnectionForConfig)
  return out
}

export function redactProviderForStatus(provider) {
  return {
    baseUrl: safeUrl(provider.baseUrl),
    extraHeaderCount: provider.extraHeaders && typeof provider.extraHeaders === 'object' ? Object.keys(provider.extraHeaders).length : 0,
    proxyConfigured: !!provider.proxy && provider.proxy !== 'direct',
  }
}

export function redactDefaultsForConfig(defaults) {
  const out = { ...defaults }
  if (out.extraHeaders && typeof out.extraHeaders === 'object' && !Array.isArray(out.extraHeaders)) {
    out.extraHeaders = Object.fromEntries(Object.keys(out.extraHeaders).map((name) => [name, SECRET_MASK]))
  }
  if (out.proxy && out.proxy !== 'direct') {
    out.proxy = SECRET_MASK
    out.proxyConfigured = true
  }
  if (configured(out.sessionHmacSecret)) out.sessionHmacSecret = SECRET_MASK
  return out
}

function restoreSecretFields(incoming, current) {
  if (!object(incoming)) return incoming
  const out = { ...incoming }
  delete out.proxyConfigured
  if (out.baseUrlMasked) out.baseUrl = current?.baseUrl
  delete out.baseUrlMasked
  if (out.proxy === SECRET_MASK) out.proxy = current?.proxy
  if (out.baseUrl === SECRET_MASK) out.baseUrl = current?.baseUrl
  if (out.sessionHmacSecret === SECRET_MASK) out.sessionHmacSecret = current?.sessionHmacSecret
  if (out.extraHeaders && typeof out.extraHeaders === 'object' && !Array.isArray(out.extraHeaders)) {
    const prior = current?.extraHeaders && typeof current.extraHeaders === 'object' ? current.extraHeaders : {}
    out.extraHeaders = Object.fromEntries(Object.entries(out.extraHeaders).map(([name, value]) => [name, value === SECRET_MASK && Object.hasOwn(prior, name) ? prior[name] : value]))
  }
  return out
}

function currentConnection(current, incoming) {
  const connections = Array.isArray(current?.connections) ? current.connections : []
  if (typeof incoming?.connectionId === 'string' && incoming.connectionId) {
    const matches = connections.filter((connection) => connection?.connectionId === incoming.connectionId)
    if (matches.length === 1) return matches[0]
    if (matches.length > 1) return null
  }
  // Legacy connections have no connectionId. Their explicit legacy id is stable;
  // never fall back to an array position, which could restore another connection's secret.
  if (incoming?.id != null) {
    const legacy = connections.filter((connection) => connection?.connectionId == null && connection?.id === incoming.id)
    if (legacy.length === 1) return legacy[0]
  }
  return null
}

export function restoreConnectionSecrets(incoming, current) {
  return restoreSecretFields(incoming, current)
}

export function restoreProviderSecrets(incoming, current) {
  const out = restoreSecretFields(incoming, current)
  if (!object(out) || !Array.isArray(out.connections)) return out
  out.connections = out.connections.map((connection) => restoreConnectionSecrets(connection, currentConnection(current, connection)))
  return out
}

export function restoreDefaultsSecrets(incoming, current) {
  return restoreSecretFields(incoming, current)
}

export function restoreDefaultsSecretsFromCurrent(incoming, current) {
  const out = restoreDefaultsSecrets(incoming, current)
  return object(out) ? copyCurrentSecretFields(out, current, ['proxy', 'extraHeaders', 'sessionHmacSecret']) : out
}

const CURRENT_SECRET_FIELDS = ['baseUrl', 'proxy', 'extraHeaders', 'sessionHmacSecret']

function copyCurrentSecretFields(out, current, fields) {
  for (const field of fields) {
    if (Object.hasOwn(current || {}, field)) out[field] = structuredClone(current[field])
    else delete out[field]
  }
  delete out.baseUrlMasked
  delete out.proxyConfigured
  return out
}

export function restoreConnectionSecretsFromCurrent(incoming, current) {
  const out = restoreConnectionSecrets(incoming, current)
  return object(out) ? copyCurrentSecretFields(out, current, CURRENT_SECRET_FIELDS) : out
}

export function restoreProviderSecretsFromCurrent(incoming, current, opts = {}) {
  const out = restoreProviderSecrets(incoming, current)
  if (!object(out) || !object(current)) return out
  copyCurrentSecretFields(out, current, opts.editableBaseUrl ? CURRENT_SECRET_FIELDS.filter((field) => field !== 'baseUrl') : CURRENT_SECRET_FIELDS)
  if (Array.isArray(out.connections)) {
    out.connections = out.connections.map((connection) => restoreConnectionSecretsFromCurrent(connection, currentConnection(current, connection)))
  }
  return out
}
