import { el, clear, callout } from './dom.js'
import { DEFAULTS, normalizeSettings, settingsJson } from './settings.js'
import { fmtDuration } from './format.js'
import { modeMeta } from './mode.js'

function segmented (options, value, onChange) {
  return el('div', { class: 'segmented' }, options.map((o) => el('button', {
    class: 'seg', type: 'button', 'aria-pressed': String(o.value) === String(value),
    onclick: () => onChange(o.value),
  }, o.label)))
}

function toggle (checked, onChange, label) {
  const input = el('input', { type: 'checkbox', checked, class: 'switch-input', 'aria-label': label })
  input.addEventListener('change', () => onChange(input.checked))
  return el('label', { class: 'switch' }, input, el('span', { class: 'switch-track', 'aria-hidden': 'true' }), el('span', { class: 'switch-label', text: checked ? '开' : '关' }))
}

function row (title, desc, control) {
  return el('div', { class: 'setting-row' },
    el('div', { class: 'setting-copy' }, el('b', { text: title }), desc ? el('p', { text: desc }) : null),
    el('div', { class: 'setting-control' }, control))
}

function group (title, desc, rows) {
  return el('section', { class: 'panel setting-group' },
    el('div', { class: 'panel-head' }, el('div', {}, el('h2', { text: title }), desc ? el('p', { class: 'panel-sub', text: desc }) : null)),
    el('div', { class: 'setting-list' }, ...rows))
}

function copyText (text) {
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text)
  return Promise.reject(new Error('clipboard unavailable'))
}

export function renderSettings (host, ctx) {
  const { settings, state } = ctx
  clear(host)

  host.append(el('section', { class: 'page-head' },
    el('div', {},
      el('p', { class: 'eyebrow', text: 'SETTINGS / 界面与交互' }),
      el('h1', { text: '设置' }),
      el('p', { class: 'lede', text: '这里只控制演示前端的外观、图表和交互，不改网关配置、不填 Provider/Key。所有改动即时生效并保存在本机 localStorage。' })),
    el('div', { class: 'head-actions' },
      el('span', { class: 'meta-pill', text: 'cel-dusk 基线' }))))

  host.append(
    group('外观', 'cel-dusk 的令牌级开关；描边/圆角/阴影使用 data-* 属性，不写内联样式。', [
      row('主题', '跟随系统时由 prefers-color-scheme 决定；顶栏的月亮按钮是快捷切换。', segmented([
        { value: 'auto', label: '跟随系统' }, { value: 'light', label: '亮色' }, { value: 'dark', label: '暗色' },
      ], settings.theme, (v) => ctx.updateSetting('theme', v))),
      row('密度', '紧凑模式压缩卡片内边距和表格行高，适合一屏看更多数据。', segmented([
        { value: 'comfortable', label: '舒适' }, { value: 'compact', label: '紧凑' },
      ], settings.density, (v) => ctx.updateSetting('density', v))),
      row('动效', 'cel-dusk 默认 steps(2) 定格动画；减弱模式会关闭位移和过渡。', segmented([
        { value: 'auto', label: '跟随系统' }, { value: 'full', label: '标准' }, { value: 'reduced', label: '减弱' },
      ], settings.motion, (v) => ctx.updateSetting('motion', v))),
      row('描边', '2px 是基线；1px 更轻，3px 更接近海报。可访问性不依赖描边单独传达状态。', segmented([
        { value: 1, label: '1px' }, { value: 2, label: '2px' }, { value: 3, label: '3px' },
      ], settings.border, (v) => ctx.updateSetting('border', v))),
      row('圆角', '0 是硬边海报，8 更接近卡片。只影响容器和按钮。', segmented([
        { value: 0, label: '0' }, { value: 4, label: '4px' }, { value: 8, label: '8px' },
      ], settings.radius, (v) => ctx.updateSetting('radius', v))),
      row('阴影', '位移实色影是 cel-dusk 的签名元素；关闭后仍靠 2px 描边区分层级。', segmented([
        { value: 'none', label: '无' }, { value: 'soft', label: '轻' }, { value: 'normal', label: '标准' },
      ], settings.shadow, (v) => ctx.updateSetting('shadow', v))),
    ]),
    group('图表与刷新', '图表页的默认值；改动会立即同步到图表控件。', [
      row('默认时间范围', '打开演示或刷新图表时使用的窗口。', segmented([
        { value: 1, label: '24 小时' }, { value: 7, label: '7 天' }, { value: 30, label: '30 天' },
      ], settings.defaultRange, (v) => ctx.updateSetting('defaultRange', v))),
      row('默认图表类型', '柱状适合逐桶比较，折线适合看趋势。', segmented([
        { value: 'bar', label: '柱状' }, { value: 'line', label: '折线' },
      ], settings.defaultChart, (v) => ctx.updateSetting('defaultChart', v))),
      row('默认指标', '记账请求在后端没有逐桶字段时会自动退回 Token。', segmented([
        { value: 'tokens', label: 'Token' }, { value: 'requests', label: '记账请求' }, { value: 'hitrate', label: '缓存命中率' },
      ], settings.defaultMetric, (v) => ctx.updateSetting('defaultMetric', v))),
      row('自动刷新', '只刷新只读快照；模式对话框打开时不会自动重建页面。', segmented([
        { value: 0, label: '关闭' }, { value: 15, label: '15s' }, { value: 30, label: '30s' }, { value: 60, label: '60s' },
      ], settings.autoRefresh, (v) => ctx.updateSetting('autoRefresh', v))),
      row('日志行数', '最近日志尾部读取的行数；改大后重新拉取。', segmented([
        { value: 20, label: '20' }, { value: 40, label: '40' }, { value: 80, label: '80' },
      ], settings.logLines, (v) => ctx.updateSetting('logLines', v))),
    ]),
    group('数据与显示', '只影响演示的呈现，不改变后端记录。', [
      row('显示零用量模型', '关闭后模型表只保留本窗口有 Token 或请求的模型。', toggle(settings.showZeroModels, (v) => ctx.updateSetting('showZeroModels', v), '显示零用量模型')),
      row('显示完整 SHA / 路径', '关闭后只显示短 SHA；安全令牌永远不展示。', toggle(settings.showTechnical, (v) => ctx.updateSetting('showTechnical', v), '显示完整 SHA / 路径')),
    ]),
    group('交互安全', '涉及 Codex 配置的写入由后端一次性 consentToken 强制保护。', [
      row('切换前二次确认', '无法关闭：预览 → 勾选确认 → 带 consentToken 提交，是后端契约的一部分。', el('span', { class: 'badge', 'data-tone': 'ok', text: '固定开启' })),
      row('切换后重启提醒', '切换/回滚成功后会明确提示完全退出并重开 Codex；演示不会替你启动或重启客户端。', el('span', { class: 'badge', 'data-tone': 'warn', text: '固定开启' })),
    ]),
  )

  const importArea = el('textarea', { class: 'textarea', rows: '6', placeholder: '粘贴设置 JSON，例如 { "theme": "dark", "density": "compact" }', 'aria-label': '导入设置 JSON' })
  const importFeedback = el('p', { class: 'hint', role: 'status' })
  const importButton = el('button', {
    class: 'btn', type: 'button', text: '导入并应用',
    onclick: () => {
      try {
        const parsed = JSON.parse(importArea.value)
        ctx.replaceSettings(parsed)
        clear(importFeedback)
        importFeedback.append(el('span', { class: 'good-text', text: '已导入并应用。' }))
      } catch (error) {
        clear(importFeedback)
        importFeedback.append(el('span', { class: 'err-text', text: '导入失败：' + (error.message || 'JSON 无法解析') }))
      }
    },
  })

  const copyButton = el('button', {
    class: 'btn', type: 'button', text: '复制设置 JSON',
    onclick: async () => {
      try {
        await copyText(settingsJson(settings))
        ctx.showToast('设置 JSON 已复制', 'ok')
      } catch {
        ctx.showToast('浏览器拒绝剪贴板；请从下方导入框复制', 'warn')
      }
    },
  })

  host.append(
    group('配置与操作', '设置只保存在本机；不含任何凭据。', [
      el('div', { class: 'setting-actions' },
        el('button', { class: 'btn btn-primary', type: 'button', text: '恢复默认设置', onclick: () => ctx.resetSettings() }),
        copyButton,
        el('span', { class: 'hint', text: 'localStorage: mg-demo-settings/1' })),
      el('details', { class: 'import-box' },
        el('summary', { text: '导入设置 JSON' }),
        importArea,
        el('div', { class: 'toolbar' }, importButton),
        importFeedback),
    ]),
    group('网关信息（只读）', '来自 /api/status 与 /api/aggregation/modes，仅用于核对。', [
      row('配置版本', '网关当前配置代际。', el('b', { class: 'mono', text: state.status ? 'v' + (state.status.configVersion ?? '—') : '—' })),
      row('运行时长', '本进程启动以来。', el('b', { class: 'mono', text: state.status ? fmtDuration(Number(state.status.uptimeMs)) : '—' })),
      row('接入方式', '只读；切换请到「模式」页。', el('b', { class: 'mono', text: modeMeta((state.health && state.health.mode) || (state.modes && state.modes.current && state.modes.current.mode)).label })),
      row('管理 API', '同源、只读 GET；写入只由模式页的 consent 流程触发。', el('code', { class: 'mono', text: '/api/status · /api/model-stats · /api/aggregation/* · /api/logs' })),
    ]),
    group('最近日志', '尾部读取，不是全量检索；行数可在上方调整。', [
      el('div', { class: 'toolbar' },
        el('button', { class: 'btn', type: 'button', onclick: () => ctx.loadAll({ silent: true }), text: '重新读取' }),
        el('span', { class: 'hint', text: 'GET /api/logs?lines=' + settings.logLines })),
      el('pre', {
        class: 'log-tail', tabindex: '0', 'aria-label': '最近日志',
        text: state.errors.logs ? '读取失败：' + state.errors.logs : (state.logs.length ? state.logs.join('\n') : '日志为空。'),
      }),
    ]),
  )
}