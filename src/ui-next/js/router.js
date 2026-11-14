// Hash routing with deep links (#/providers). No token material in the URL.
export const ROUTES = [
  { id: 'overview', label: '总览', title: '运行总览' },
  { id: 'providers', label: '上游供应商', title: '上游供应商' },
  { id: 'models', label: '模型与路由', title: '模型与路由' },
  { id: 'clients', label: '客户端接入', title: '客户端接入' },
  { id: 'aggregation', label: '聚合模式', title: '聚合模式' },
  { id: 'observability', label: '监控与诊断', title: '监控与诊断' },
  { id: 'settings', label: '安全与设置', title: '安全与设置' },
]
export function routeFromHash() {
  const raw = String(location.hash || '').replace(/^#\/?/, '').split('?')[0]
  return ROUTES.some((r) => r.id === raw) ? raw : 'overview'
}
export function navigate(id) {
  if (routeFromHash() === id) return
  location.hash = '#/' + id
}
export function startRouter(onChange) {
  const fire = () => onChange(routeFromHash())
  window.addEventListener('hashchange', fire)
  fire()
}
