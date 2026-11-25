import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'
import { resolveKey } from '../router.js'
import { selectConnection } from './connections.js'
import { validateEndpointNetwork } from './network-policy.js'

function endpointFor(baseUrl) {
  const url = new URL(String(baseUrl || ''))
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported_endpoint')
  url.username = ''; url.password = ''; url.hash = ''
  url.pathname = url.pathname.replace(/\/+$/, '') + '/models'
  return url
}

function pinnedLookup(network) {
  return (hostname, options, callback) => {
    const lookupHostname = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
    if (lookupHostname !== network.hostname) {
      return callback(Object.assign(new Error('unexpected lookup hostname'), { code: 'ENOTFOUND' }))
    }
    const answers = network.addresses.filter((answer) => options.family === undefined || options.family === 0 || answer.family === options.family)
    if (!answers.length) return callback(Object.assign(new Error('no validated address for family'), { code: 'ENOTFOUND' }))
    if (options.all) return callback(null, answers)
    const answer = answers[0]
    callback(null, answer.address, answer.family)
  }
}

function nativeRequest(url, headers, network, opts) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest
    const request = transport(url, {
      method: 'GET',
      headers,
      lookup: pinnedLookup(network),
      signal: AbortSignal.timeout(opts.timeoutMs || 10000),
    }, (response) => resolve({
      ok: response.statusCode >= 200 && response.statusCode < 300,
      status: response.statusCode,
      body: Readable.toWeb(response),
    }))
    request.on('error', reject)
    request.end()
  })
}

export async function discoverConnection(cfg, providerId, connectionId, opts = {}) {
  if (!Object.hasOwn(cfg.providers || {}, providerId)) throw Object.assign(new Error('服务不存在'), { status: 404, code: 'service_not_found' })
  const provider = cfg.providers[providerId]
  if ((provider.api || 'openai') !== 'openai') throw Object.assign(new Error('当前仅支持 OpenAI 兼容目录发现'), { status: 422, code: 'discovery_protocol_unsupported' })
  const selection = selectConnection({ connectionCursors: {} }, cfg, providerId, Date.now())
  const connection = connectionId ? (provider.connections || []).find((item) => (item.connectionId || item.id) === connectionId) : selection.connection
  if (connectionId && !connection) throw Object.assign(new Error('连接不存在'), { status: 404, code: 'connection_not_found' })
  if (!connection && selection.unavailable) throw Object.assign(new Error('没有可用连接'), { status: 422, code: 'no_eligible_connection' })
  const keyId = connection?.credentialKeyId || connection?.connectionId || connection?.id || providerId
  const key = resolveKey(cfg, connection ? { ...provider, ...connection } : provider, keyId).key
  const network = await validateEndpointNetwork(provider.baseUrl, {
    allowPrivateNetwork: provider.allowPrivateNetwork === true,
    lookup: opts.lookup,
    timeoutMs: opts.networkTimeoutMs,
  })
  if (network.error) throw Object.assign(new Error(network.error), { status: 400, code: network.code })
  let url
  try { url = endpointFor(network.value) } catch { throw Object.assign(new Error('服务地址无效'), { status: 422, code: 'invalid_endpoint' }) }
  const headers = { accept: 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}) }
  let response
  try {
    response = opts.requestImpl
      ? await opts.requestImpl(url, headers, network)
      : opts.fetchImpl
        ? await opts.fetchImpl(url, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(opts.timeoutMs || 10000) })
        : await nativeRequest(url, headers, network, opts)
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError' || error?.code === 'ETIMEDOUT') {
      throw Object.assign(new Error('目录发现超时'), { status: 504, code: 'discovery_timeout' })
    }
    throw Object.assign(new Error('目录发现网络请求失败'), { status: 502, code: 'discovery_unreachable' })
  }
  if (!response.ok) {
    await response.body?.cancel?.().catch(() => {})
    throw Object.assign(new Error('目录发现失败：HTTP ' + response.status), { status: response.status === 401 ? 401 : 502, code: response.status === 401 ? 'discovery_unauthorized' : 'discovery_failed' })
  }
  const reader = response.body?.getReader()
  if (!reader) throw Object.assign(new Error('目录响应为空'), { status: 502, code: 'discovery_empty' })
  const chunks = []
  let bytes = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.length
      if (bytes > 1024 * 1024) { await reader.cancel(); throw Object.assign(new Error('目录响应超过 1 MiB'), { status: 502, code: 'discovery_too_large' }) }
      chunks.push(part.value)
    }
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throw Object.assign(new Error('目录发现超时'), { status: 504, code: 'discovery_timeout' })
    }
    if (error.status) throw error
    throw Object.assign(new Error('目录响应读取失败'), { status: 502, code: 'discovery_unreachable' })
  }
  let data
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw Object.assign(new Error('目录不是合法 JSON'), { status: 502, code: 'discovery_invalid_json' }) }
  const rows = Array.isArray(data) ? data : Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : []
  const models = [...new Set(rows.map((row) => typeof row === 'string' ? row : row?.id || row?.name).filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 256))].sort()
  const pinned = !opts.fetchImpl && !opts.requestImpl
  return { contract: 'mg-discovery/1', providerId, connectionId: connection?.connectionId || connection?.id || null, models: models.map((upstreamModelId) => ({ upstreamModelId, availability: 'discovered', capabilityEvidence: 'account-catalog-only' })), count: models.length, upstreamCalls: 1, networkPolicy: pinned ? 'dns-revalidated-pinned' : 'dns-revalidated-unpinned', note: 'Discovery does not assert inference, tool, quota, or account permission beyond this catalog response.' + (pinned ? '' : ' Injected transport performs DNS validation but cannot guarantee socket lookup pinning; residual DNS TOCTOU remains.') }
}
