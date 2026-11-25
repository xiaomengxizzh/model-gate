const IDS = ['harness', 'mode', 'services', 'pools', 'usage', 'reliability', 'settings', 'service-detail', 'account-detail', 'service-models', 'pool-strategy', 'pool-apps', 'pool-test', 'reliability-detail', 'models', 'routing', 'clients', 'logs']
const TITLES = {
  harness: '应用接入', mode: 'Codex 接入配置', services: '模型服务', pools: '模型池', usage: '用量分析', reliability: '稳定性策略', settings: '设置',
  'service-detail': '服务详情', 'account-detail': '连接详情', 'service-models': '服务模型', 'pool-strategy': '池选择与回退',
  'pool-apps': '池应用引用', 'pool-test': '池预演', 'reliability-detail': '稳定性详细', models: '高级模型目录', routing: '手动路由', clients: 'API 与密钥', logs: '请求日志',
}
const PARENTS = {
  mode: 'harness', services: 'harness', pools: 'harness', usage: 'harness', reliability: 'harness', settings: 'harness',
  'service-detail': 'services', 'service-models': 'service-detail', 'account-detail': 'service-detail',
  'pool-strategy': 'pools', 'pool-apps': 'pools', 'pool-test': 'pools', 'reliability-detail': 'reliability',
  models: 'harness', routing: 'harness', clients: 'harness', logs: 'harness',
}
const positions = new Map()

export function routePath(hash = typeof location === 'undefined' ? '' : location.hash) {
  const raw = String(hash || '').replace(/^#\/?/, '')
  const [id, query = ''] = raw.split('?')
  return { id: IDS.includes(id) ? id : 'harness', query }
}

export function routeFromHash(hash) {
  return routePath(hash).id
}

export function routeKey(hash) {
  const path = routePath(hash)
  return path.id + (path.query ? '?' + path.query : '')
}

export function parentRoute(id, query = '') {
  const parent = PARENTS[id] || 'harness'
  const params = new URLSearchParams(query)
  let href = '#/' + parent
  if (['service-detail', 'service-models', 'account-detail'].includes(parent) && params.get('service')) href += '?service=' + encodeURIComponent(params.get('service'))
  return { id: parent, href }
}

export function primaryRoute(id, query = '') {
  const primary = new Set(['harness', 'services', 'pools', 'usage', 'reliability', 'settings'])
  let current = id
  let search = query
  const seen = new Set()
  while (!primary.has(current) && PARENTS[current] && !seen.has(current)) {
    seen.add(current)
    const parent = parentRoute(current, search)
    current = parent.id
    search = parent.href.split('?')[1] || ''
  }
  return current
}

export function breadcrumbTrail(id, query = '') {
  const trail = [{ id, label: TITLES[id] || TITLES.harness, href: '#/' + id + (query ? '?' + query : '') }]
  let current = id
  let search = query
  const seen = new Set()
  while (PARENTS[current] && !seen.has(current)) {
    seen.add(current)
    const parent = parentRoute(current, search)
    if (parent.id === 'harness') break
    trail.unshift({ id: parent.id, label: TITLES[parent.id] || TITLES.harness, href: parent.href })
    current = parent.id
    search = parent.href.split('?')[1] || ''
  }
  return [{ id: 'harness', label: '工作台', href: '#/harness' }, ...trail]
}

export function navigate(id) {
  if (!IDS.includes(id)) return
  const target = '#/' + id
  const current = typeof location !== 'undefined' && location ? String(location.hash || '') : ''
  if (current !== target) location.hash = target
  return target
}

export function rememberPosition(id, top) {
  positions.set(id, Math.max(0, Number(top) || 0))
}

export function restorePosition(id) {
  return positions.get(id) || 0
}

export function titleOf(id) {
  return TITLES[id] || TITLES.harness
}

export function startRouter(onChange) {
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual'
  window.addEventListener('hashchange', () => onChange(routeFromHash()))
  onChange(routeFromHash())
}
