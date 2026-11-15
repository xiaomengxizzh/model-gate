// Hash routing with deep links (#/providers). No token material in the URL.
//
// 契约：docs/contracts/ui-v3-product-status.md §4。
//   * ROUTES 是唯一路由表（id / group / navLabel / title / icon / order）。
//   * primary  = 普通用户默认可见的 3 项（首页 / 模型与账号 / 设置）。
//   * advanced = 开发者入口，index.html 用 <details> 默认收起、可键盘展开。
//   * 旧 7 个 id 全部保留，新增 connections；#/connections?step=key 的查询串不参与匹配。
//   * 未知 hash 一律回落 overview；不把服务根路由重定向到 /ui-next。

const ROUTE_LIST = [
  {
    id: 'overview',
    group: 'primary',
    navLabel: '首页',
    label: '首页',
    title: '首页',
    icon: 'M3 3h6v6H3zM11 3h6v4h-6zM11 9h6v8h-6zM3 11h6v6H3z',
    order: 1,
  },
  {
    id: 'connections',
    group: 'primary',
    navLabel: '模型与账号',
    label: '模型与账号',
    title: '模型与账号',
    icon: 'M12 8a3 3 0 10-2.6 3L4 16v2h3l1-1v-2h2v-2h2l.6-.6',
    order: 2,
  },
  {
    id: 'settings',
    group: 'primary',
    navLabel: '设置',
    label: '设置',
    title: '设置',
    icon: 'M10 6.5a3.5 3.5 0 100 7 3.5 3.5 0 000-7M10 2v3M10 15v3M2 10h3M15 10h3M4.3 4.3l2.1 2.1M13.6 13.6l2.1 2.1M15.7 4.3l-2.1 2.1M6.4 13.6l-2.1 2.1',
    order: 3,
  },
  {
    id: 'providers',
    group: 'advanced',
    navLabel: '上游供应商',
    label: '上游供应商',
    title: '上游供应商',
    icon: 'M10 2l7 4v8l-7 4-7-4V6zM10 10l7-4M10 10v8M10 10L3 6',
    order: 4,
  },
  {
    id: 'models',
    group: 'advanced',
    navLabel: '模型与路由',
    label: '模型与路由',
    title: '模型与路由',
    icon: 'M4 4h5v5H4zM11 11h5v5h-5zM11 4h5v5h-5zM4 11h5v5H4z',
    order: 5,
  },
  {
    id: 'clients',
    group: 'advanced',
    navLabel: '客户端接入',
    label: '客户端接入',
    title: '客户端接入',
    icon: 'M3 6h14v9H3zM7 3h6v3H7zM8 17h4',
    order: 6,
  },
  {
    id: 'aggregation',
    group: 'advanced',
    navLabel: '聚合详情',
    label: '聚合详情',
    title: '聚合详情',
    icon: 'M10 2l7 4v8l-7 4-7-4V6zM10 10l7-4M10 10v8M10 10L3 6M12 10a2 2 0 11-4 0 2 2 0 014 0',
    order: 7,
  },
  {
    id: 'observability',
    group: 'advanced',
    navLabel: '监控与诊断',
    label: '监控与诊断',
    title: '监控与诊断',
    icon: 'M3 17V8M8 17V4M13 17v-6M18 17V9M2 17h17',
    order: 8,
  },
]

for (const route of ROUTE_LIST) Object.freeze(route)

export const ROUTES = Object.freeze(ROUTE_LIST)

const BY_ID = new Map(ROUTES.map((route) => [route.id, route]))

function hashString (value) {
  if (value === undefined || value === null) {
    return typeof location !== 'undefined' && location ? String(location.hash || '') : ''
  }
  return String(value)
}

// '#/connections?step=key' -> 'connections'；未知或空 hash -> 'overview'。
export function routeFromHash (hash) {
  const raw = hashString(hash)
    .replace(/^#\/?/, '')
    .split('?')[0]
    .split('#')[0]
    .trim()
    .replace(/\/+$/, '')
  return BY_ID.has(raw) ? raw : 'overview'
}

// 单条路由元数据（副本，调用方不得改路由表）；未知 id 返回 null。
export function routeMeta (id) {
  const route = BY_ID.get(String(id == null ? '' : id))
  return route ? { ...route } : null
}

// 按分区返回排序后的路由副本；index.html 与测试共用同一顺序来源。
export function routesByGroup () {
  const groups = { primary: [], advanced: [] }
  const sorted = [...ROUTES].sort((a, b) => a.order - b.order)
  for (const route of sorted) {
    if (groups[route.group]) groups[route.group].push({ ...route })
  }
  return groups
}

// hash 导航入口：opts.step 生成 '#/connections?step=key' 这类深链。
// 返回目标 hash；未知 id 返回 null 且不改变 location。
export function navigate (id, opts = {}) {
  const meta = routeMeta(id)
  if (!meta) return null
  const step = opts && opts.step != null ? String(opts.step).trim() : ''
  const target = '#/' + meta.id + (step ? '?step=' + encodeURIComponent(step) : '')
  const current = typeof location !== 'undefined' && location ? String(location.hash || '') : ''
  if (current !== target) location.hash = target
  return target
}

// 深链进入高级路由时展开"高级功能"分组（默认仍是收起；只展开、不自动收起用户已展开的分组）。
function syncNavGroup (route) {
  const meta = routeMeta(route)
  if (!meta || meta.group !== 'advanced') return
  if (typeof document === 'undefined' || !document || typeof document.querySelector !== 'function') return
  const group = document.querySelector('#nav-advanced')
  if (group && 'open' in group) group.open = true
}

export function startRouter (onChange) {
  const fire = () => {
    const route = routeFromHash()
    syncNavGroup(route)
    onChange(route)
  }
  window.addEventListener('hashchange', fire)
  fire()
}
