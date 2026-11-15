// 连接与聚合（UX-02 由 A2 落地；本文件在 UX-00 提供**诚实的最小壳**，不伪造任何状态）。
//
// 目的：让路由与状态层（A1/A3）在 A2 交付前可独立运行；A2 会在本文件位置实现完整
// "连接 OpenCode Go → 预览 → 启用聚合 → 重启提示 → 退出恢复"向导。
// 本壳只渲染真实快照能证明的事实，缺失就是"未知"，绝不显示"已连接/已启用"。
import { h } from '../dom.js'
import { pageHead, card, callout, tag } from '../components.js'

export const CONNECTIONS_VIEW_CONTRACT = 'mg-ui-connections/1'

function line (label, value, kind) {
  return h('div', { class: 'list-row' },
    h('div', { class: 'grow' }, h('div', { class: 'primary', text: label }), h('div', { class: 'secondary', text: value })),
    tag(kind === 'good' ? '就绪' : kind === 'warn' ? '需要操作' : '未知', kind === 'good' ? 'good' : kind === 'warn' ? 'warn' : 'muted'))
}

export function render (root, ctx = {}) {
  const product = typeof ctx.product === 'function' ? ctx.product() : (ctx.product || null)
  root.append(pageHead('模型与账号', '连接 OpenCode Go、启用聚合、必要时重新打开 Codex。', { eyebrow: 'CONNECTIONS' }))
  if (!product) {
    root.append(callout('info',
      h('strong', { text: '正在读取真实状态。' }),
      ' 连接向导不会在取得真实快照前显示任何"已连接"或"已启用"结论。'))
    return
  }
  root.append(card('当前状态', '来自只读状态快照（/api/status 与 /api/aggregation/*）',
    h('div', { class: 'list' },
      line('ChatGPT 套餐', product.official ? product.official.detail : '未验证（没有状态投影）', product.official && product.official.state === 'detected' ? 'good' : 'warn'),
      line('OpenCode Go', product.go ? product.go.detail : '状态未知', product.go && product.go.state === 'configured' ? 'good' : 'warn'),
      line('Codex Desktop', product.codex ? product.codex.detail : '状态未知', product.codex && product.codex.found ? 'good' : 'warn'),
      line('聚合模式', product.aggregation ? product.aggregation.detail : '状态未知', product.aggregation && product.aggregation.mode === 'aggregated' ? 'good' : 'muted'))))
  root.append(callout('warn',
    h('strong', { text: '连接向导尚未在本实例启用。' }),
    ' 单字段 Go 接入与一键聚合将由 UX-02 在此页实现；在此之前请勿手工修改 Codex 配置。本页不会代替你写入。'))
}
