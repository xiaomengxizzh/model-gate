export const SETTINGS_KEY = 'mg-demo-settings/1'

export const DEFAULTS = Object.freeze({
  theme: 'auto',            // auto | light | dark
  density: 'comfortable',   // comfortable | compact
  motion: 'auto',           // auto | full | reduced
  border: 2,                // 1 | 2 | 3 px
  radius: 4,                // 0 | 4 | 8 px
  shadow: 'normal',         // none | soft | normal
  defaultRange: 1,          // 1 | 7 | 30 days
  defaultChart: 'bar',      // bar | line
  defaultMetric: 'tokens',  // tokens | requests | hitrate
  autoRefresh: 0,           // 0 | 15 | 30 | 60 seconds
  logLines: 40,             // 20 | 40 | 80
  showZeroModels: true,
  showTechnical: true,
  confirmBeforeSwitch: true,
})

export const CHOICES = Object.freeze({
  theme: ['auto', 'light', 'dark'],
  density: ['comfortable', 'compact'],
  motion: ['auto', 'full', 'reduced'],
  border: [1, 2, 3],
  radius: [0, 4, 8],
  shadow: ['none', 'soft', 'normal'],
  defaultRange: [1, 7, 30],
  defaultChart: ['bar', 'line'],
  defaultMetric: ['tokens', 'requests', 'hitrate'],
  autoRefresh: [0, 15, 30, 60],
  logLines: [20, 40, 80],
})

function pick (input, key) {
  const value = input ? input[key] : undefined
  const allowed = CHOICES[key]
  if (allowed) return allowed.includes(value) ? value : DEFAULTS[key]
  if (key === 'showZeroModels' || key === 'showTechnical') return typeof value === 'boolean' ? value : DEFAULTS[key]
  if (key === 'confirmBeforeSwitch') return true
  return DEFAULTS[key]
}

export function normalizeSettings (input) {
  const source = input && typeof input === 'object' ? input : {}
  const out = {}
  for (const key of Object.keys(DEFAULTS)) out[key] = pick(source, key)
  return out
}

export function loadSettings (storage = globalThis.localStorage) {
  try {
    const raw = storage && storage.getItem(SETTINGS_KEY)
    return normalizeSettings(raw ? JSON.parse(raw) : null)
  } catch {
    return normalizeSettings(null)
  }
}

export function saveSettings (settings, storage = globalThis.localStorage) {
  try { storage && storage.setItem(SETTINGS_KEY, JSON.stringify(normalizeSettings(settings))) } catch { /* 隐私模式忽略 */ }
}

// 只设置 data-*；具体数值由 CSS 的 [data-border]/[data-radius]/[data-shadow] 规则表达，
// 不写内联 style，避免与预览服务器的 CSP 冲突。
export function applySettings (settings, root = document.documentElement) {
  const s = normalizeSettings(settings)
  root.dataset.mode = s.theme
  root.dataset.density = s.density
  root.dataset.motion = s.motion
  root.dataset.border = String(s.border)
  root.dataset.radius = String(s.radius)
  root.dataset.shadow = s.shadow
  return s
}

export function settingsJson (settings) {
  return JSON.stringify(normalizeSettings(settings), null, 2)
}
