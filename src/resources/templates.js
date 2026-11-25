import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

// A3 provider-template resource. The R2 JSON is a design snapshot, not a live
// catalog, account grant, adapter capability declaration, or permission to call
// an upstream. This module deliberately performs no I/O other than reading that
// public snapshot and never imports credential/config loaders.
const CONTRACT = 'mg-provider-templates/1'
const CATALOG_URL = new URL('../../docs/evidence/v13.1-r2/input/01-原型与目录/modelgate-v12-provider-catalog.json', import.meta.url)
const CATALOG_SOURCE = 'docs/evidence/v13.1-r2/input/01-原型与目录/modelgate-v12-provider-catalog.json'
const CATALOG_KIND = 'modelgate-template-design-snapshot'
const EXPECTED_TEMPLATES = 63
const EXPECTED_MODEL_EXAMPLES = 87
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100
const ID_RE = /^[a-z][a-z0-9-]{0,63}$/
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/
const SECRET_ASSIGNMENT_RE = /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|password|secret)\s*[:=]\s*\S+/i
const TOKEN_RE = /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/

export const TEMPLATE_STATUSES = Object.freeze([
  'existing-adapter-unverified',
  'official-native-boundary',
  'planned-unverified',
])

const PROTOCOLS = Object.freeze({
  Chat: 'openai-chat',
  Responses: 'openai-responses',
  Messages: 'anthropic-messages',
  Gemini: 'google-gemini',
  Cohere: 'cohere',
  Bedrock: 'aws-bedrock',
  待确认: 'unconfirmed',
})

const AUTH_KINDS = Object.freeze({
  'API Key': 'api-key',
  '套餐 API Key': 'subscription-api-key',
  '原生 Codex 登录': 'codex-native-login',
  '腾讯云授权': 'tencent-cloud-authorization',
  'API Key / Entra ID': 'api-key-or-entra-id',
  'AWS 授权': 'aws-authorization',
  'Google Cloud 授权': 'google-cloud-authorization',
  'API Token': 'api-token',
  '原生应用登录': 'native-app-login',
  '官方授权': 'official-authorization',
  '套餐专用授权': 'subscription-specific-authorization',
  '本地服务': 'local-service',
  '本地服务 / API Key': 'local-service-or-api-key',
  '网关密钥': 'gateway-key',
})

const GO_ADAPTER = Object.freeze({
  status: 'existing-adapter-unverified',
  verified: false,
  reusableMechanisms: Object.freeze([
    'opencode-go-entry-binding',
    'host-allowlist',
    'declared-model-alias-mapping',
    'derived-session-header',
    'reasoning-effort-evidence-gate',
  ]),
  sources: Object.freeze([
    'src/providers/opencode-go.js',
    'src/aggregation/registry.js',
    'src/aggregation/discovery.js',
  ]),
  boundary: 'Only existing source mechanisms are identified; this snapshot does not verify the endpoint, account, models, quota, or live adapter behavior.',
})

const OFFICIAL_ADAPTER = Object.freeze({
  status: 'official-native-boundary',
  verified: false,
  reusableMechanisms: Object.freeze(['official-provider-identity-classification']),
  sources: Object.freeze(['src/codex/catalog.js']),
  boundary: 'The official ChatGPT plan must retain native authorization and official-model identity. It is not a generic API Key provider or a third-party pool member.',
})

function fail(code, message) {
  throw new Error('Invalid provider template catalog (' + code + '): ' + message)
}

function assertText(value, label, max = 500) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('invalid_text', label + ' must be a non-empty string of at most ' + max + ' characters')
  if (SECRET_ASSIGNMENT_RE.test(value) || TOKEN_RE.test(value)) fail('secret_shape', label + ' resembles an embedded credential')
  return value.trim()
}

function publicUrl(value, label, allowEmpty) {
  const raw = String(value || '').trim()
  if (!raw && allowEmpty) return ''
  let url
  try { url = new URL(raw) } catch { fail('invalid_url', label + ' is not an absolute URL') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') fail('invalid_url', label + ' must use http(s)')
  if (url.username || url.password || url.search || url.hash) fail('url_credentials_or_query', label + ' must not contain credentials, query, or fragment')
  if (SECRET_ASSIGNMENT_RE.test(raw) || TOKEN_RE.test(raw)) fail('secret_shape', label + ' resembles an embedded credential')
  const host = url.hostname.toLowerCase()
  const loopback = host === 'localhost' || host === '[::1]' || host === '::1' || host.startsWith('127.')
  if (url.protocol === 'http:' && !loopback) fail('insecure_url', label + ' may use http only for loopback')
  return url.toString().replace(/\/+$/, '')
}

function regionOf(provider) {
  if (provider.cat === '本地与自建') return 'local'
  if (provider.id.endsWith('-intl') || provider.name.includes('（国际）') || ['zai', 'byteplus'].includes(provider.id)) return 'global'
  if (provider.id.endsWith('-cn') || provider.cat === '国内模型' || provider.name.includes('（中国）')) return 'cn'
  if (provider.id === 'siliconflow') return 'cn'
  if (provider.id === 'modelscope') return 'cn'
  return 'global'
}

function discoveryOf(provider, protocol, region) {
  if (provider.id === 'chatgptplan') return 'native-official-catalog'
  if (provider.id === 'opencodego') return 'account-model-list'
  if (region === 'local') return 'local-model-list'
  if (provider.id === 'azure') return 'account-deployment-list'
  if (['anthropic', 'gemini', 'deepseek', 'qwen-cn', 'qwen-intl', 'moonshot-cn', 'moonshot-intl', 'zhipu', 'zai', 'minimax-cn', 'minimax-intl', 'openai', 'xai', 'mistral', 'cohere', 'perplexity'].includes(provider.id)) return 'account-model-list'
  if (protocol === 'openai-chat' && provider.url) return 'account-model-list'
  return 'manual-or-unconfirmed'
}

function projectProvider(provider, index, asOf, sourceWarning) {
  const templateId = assertText(provider.id, 'providers[' + index + '].id', 64)
  if (!ID_RE.test(templateId)) fail('invalid_id', templateId + ' does not match the stable template ID shape')
  const name = assertText(provider.name, templateId + '.name', 120)
  const category = assertText(provider.cat, templateId + '.cat', 80)
  const catalogStatus = assertText(provider.status, templateId + '.status', 80)
  const rawProtocol = assertText(provider.api, templateId + '.api', 40)
  if (!Object.hasOwn(PROTOCOLS, rawProtocol)) fail('unsupported_protocol', templateId + ' has unknown protocol ' + rawProtocol)
  const rawAuth = assertText(provider.auth, templateId + '.auth', 100)
  if (!Object.hasOwn(AUTH_KINDS, rawAuth)) fail('unsupported_auth', templateId + ' has unknown auth kind ' + rawAuth)
  if (provider.url != null && typeof provider.url !== 'string') fail('invalid_url', templateId + '.url must be a string')
  if (provider.doc != null && typeof provider.doc !== 'string') fail('invalid_url', templateId + '.doc must be a string')
  if (provider.note != null && typeof provider.note !== 'string') fail('invalid_text', templateId + '.note must be a string')
  const baseUrl = publicUrl(provider.url, templateId + '.url', true)
  const docs = publicUrl(provider.doc, templateId + '.doc', false)
  if (provider.note) assertText(provider.note, templateId + '.note', 1000)
  if (!Array.isArray(provider.models)) fail('invalid_models', templateId + '.models must be an array')
  const modelsExample = provider.models.map((model, modelIndex) => {
    const value = assertText(model, templateId + '.models[' + modelIndex + ']', 200)
    if (!MODEL_RE.test(value)) fail('invalid_model', templateId + ' contains an invalid model example ' + value)
    return value
  })
  if (new Set(modelsExample).size !== modelsExample.length) fail('duplicate_model', templateId + ' contains duplicate model examples')

  const protocol = PROTOCOLS[rawProtocol]
  const region = regionOf(provider)
  const status = templateId === 'opencodego' ? 'existing-adapter-unverified' : templateId === 'chatgptplan' ? 'official-native-boundary' : 'planned-unverified'
  const adapter = status === 'existing-adapter-unverified' ? GO_ADAPTER : status === 'official-native-boundary' ? OFFICIAL_ADAPTER : null
  const discovery = discoveryOf(provider, protocol, region)
  return {
    templateId: 'tpl_' + templateId,
    version: 1,
    name,
    category,
    region,
    authKind: AUTH_KINDS[rawAuth],
    protocol,
    baseUrl,
    discovery,
    docs,
    modelsExample,
    status,
    enabled: false,
    evidence: {
      level: status,
      source: CATALOG_SOURCE,
      checkedAt: asOf,
      sourceKind: CATALOG_KIND,
      sourceWarning,
      regionPolicy: 'derived-from-snapshot-name-and-url; not an account region or availability permission',
      catalogSha256: null,
      catalogStatus,
      raw: { id: templateId, category, status: catalogStatus, protocol: rawProtocol, auth: rawAuth },
      modelsExamplePolicy: 'illustrative-only; not account permissions or a production model catalog',
      permissions: 'not-asserted',
      adapter: adapter ? {
        status: adapter.status,
        verified: false,
        reusableMechanisms: [...adapter.reusableMechanisms],
        sources: [...adapter.sources],
        boundary: adapter.boundary,
      } : {
        status: 'planned-unverified',
        verified: false,
        reusableMechanisms: [],
        sources: [],
        boundary: 'No production adapter is asserted for this design-snapshot template.',
      },
      discoveryBoundary: discovery === 'manual-or-unconfirmed' ? 'Endpoint, protocol, or account-specific discovery still requires confirmation.' : 'Discovery is a capability label only; it has not been executed against an account or endpoint.',
    },
  }
}

function loadCatalog() {
  const bytes = readFileSync(CATALOG_URL)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  let catalog
  try { catalog = JSON.parse(bytes.toString('utf8')) } catch { fail('invalid_json', 'catalog is not valid JSON') }
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) fail('invalid_root', 'catalog root must be an object')
  if (catalog.kind !== CATALOG_KIND) fail('invalid_kind', 'catalog.kind must be ' + CATALOG_KIND)
  const asOf = assertText(catalog.asOf, 'catalog.asOf', 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || !Number.isFinite(Date.parse(asOf + 'T00:00:00Z'))) fail('invalid_as_of', 'catalog.asOf must be an ISO date')
  const sourceWarning = assertText(catalog.warning, 'catalog.warning', 1000)
  if (!Array.isArray(catalog.providers)) fail('invalid_providers', 'catalog.providers must be an array')

  const seen = new Set()
  const templates = catalog.providers.map((provider, index) => {
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)) fail('invalid_provider', 'providers[' + index + '] must be an object')
    const template = projectProvider(provider, index, asOf, sourceWarning)
    if (seen.has(template.templateId)) fail('duplicate_id', template.templateId + ' is duplicated')
    seen.add(template.templateId)
    template.evidence.catalogSha256 = sha256
    return template
  })
  const modelExamples = templates.reduce((total, template) => total + template.modelsExample.length, 0)
  if (templates.length !== EXPECTED_TEMPLATES) fail('template_count', 'expected ' + EXPECTED_TEMPLATES + ' templates, received ' + templates.length)
  if (modelExamples !== EXPECTED_MODEL_EXAMPLES) fail('model_example_count', 'expected ' + EXPECTED_MODEL_EXAMPLES + ' model examples, received ' + modelExamples)
  return Object.freeze({ contract: CONTRACT, catalogVersion: asOf, catalogSha256: sha256, templates })
}

const CATALOG = loadCatalog()
const TEMPLATES = Object.freeze(CATALOG.templates.map((template) => Object.freeze({
  ...template,
  modelsExample: Object.freeze([...template.modelsExample]),
  evidence: Object.freeze({
    ...template.evidence,
    raw: Object.freeze({ ...template.evidence.raw }),
    adapter: Object.freeze({
      ...template.evidence.adapter,
      reusableMechanisms: Object.freeze([...template.evidence.adapter.reusableMechanisms]),
      sources: Object.freeze([...template.evidence.adapter.sources]),
    }),
  }),
})))
const TEMPLATE_BY_ID = new Map(TEMPLATES.map((template) => [template.templateId, template]))

function clone(value) { return structuredClone(value) }

function filterText(value, label) {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string') throw new TypeError(label + ' must be a string')
  return value.trim().toLowerCase()
}

function normalizedOptions(opts) {
  if (opts === undefined || opts === null) return { filters: {}, limit: DEFAULT_LIMIT }
  if (typeof opts !== 'object' || Array.isArray(opts)) throw new TypeError('listProviderTemplates options must be an object')
  const filters = {}
  for (const key of ['category', 'region', 'status']) {
    const value = filterText(opts[key], key)
    if (value) filters[key] = value
  }
  const auth = filterText(opts.auth !== undefined ? opts.auth : opts.authKind, 'auth')
  if (auth) filters.authKind = auth
  const query = filterText(opts.query, 'query')
  if (query) filters.query = query
  const limit = opts.limit === undefined || opts.limit === null ? DEFAULT_LIMIT : opts.limit
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new RangeError('limit must be an integer between 1 and ' + MAX_LIMIT)
  return { filters, limit }
}

function matches(template, filters) {
  if (filters.category && template.category.toLowerCase() !== filters.category) return false
  if (filters.region && template.region !== filters.region) return false
  if (filters.status && template.status !== filters.status) return false
  if (filters.authKind && template.authKind !== filters.authKind) return false
  if (filters.query) {
    const haystack = [template.templateId, template.name, template.category, template.region, template.authKind, template.protocol, template.baseUrl, template.docs, ...template.modelsExample].join('\n').toLowerCase()
    if (!haystack.includes(filters.query)) return false
  }
  return true
}

function cursorFingerprint(filters) {
  return createHash('sha256').update(JSON.stringify(filters)).digest('hex').slice(0, 16)
}

function encodeCursor(offset, filters) {
  return 'v1.' + Buffer.from(JSON.stringify({ offset, filters: cursorFingerprint(filters) }), 'utf8').toString('base64url')
}

function decodeCursor(cursor, filters, total) {
  if (cursor === undefined || cursor === null || cursor === '') return 0
  if (typeof cursor !== 'string' || !cursor.startsWith('v1.')) throw new TypeError('cursor is not a valid provider-template cursor')
  let value
  try { value = JSON.parse(Buffer.from(cursor.slice(3), 'base64url').toString('utf8')) } catch { throw new TypeError('cursor is not a valid provider-template cursor') }
  if (!value || !Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset > total || value.filters !== cursorFingerprint(filters)) throw new TypeError('cursor does not match the current filters or catalog page')
  return value.offset
}

export function listProviderTemplates(opts = {}) {
  const { filters, limit } = normalizedOptions(opts)
  const filtered = TEMPLATES.filter((template) => matches(template, filters))
  const offset = decodeCursor(opts?.cursor, filters, filtered.length)
  const page = filtered.slice(offset, offset + limit)
  const nextOffset = offset + page.length
  return {
    contract: CONTRACT,
    catalogVersion: CATALOG.catalogVersion,
    items: clone(page),
    total: filtered.length,
    limit,
    nextCursor: page.length > 0 && nextOffset < filtered.length ? encodeCursor(nextOffset, filters) : null,
  }
}

export function getProviderTemplate(templateId) {
  if (typeof templateId !== 'string') return null
  const template = TEMPLATE_BY_ID.get(templateId.trim())
  return template ? clone(template) : null
}

function increment(counts, key) { counts[key] = (counts[key] || 0) + 1 }

export function templateStats() {
  const stats = {
    contract: CONTRACT,
    catalogVersion: CATALOG.catalogVersion,
    catalogSha256: CATALOG.catalogSha256,
    totalTemplates: TEMPLATES.length,
    totalModelExamples: TEMPLATES.reduce((total, template) => total + template.modelsExample.length, 0),
    validated: true,
    productionEnabled: 0,
    byStatus: {},
    byCategory: {},
    byRegion: {},
    byAuthKind: {},
    byProtocol: {},
  }
  for (const template of TEMPLATES) {
    increment(stats.byStatus, template.status)
    increment(stats.byCategory, template.category)
    increment(stats.byRegion, template.region)
    increment(stats.byAuthKind, template.authKind)
    increment(stats.byProtocol, template.protocol)
  }
  return clone(stats)
}
