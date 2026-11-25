const KEY = 'mg.ui-vnext.preferences.v1'
const DEFAULTS = Object.freeze({ theme: 'dark', density: 'comfortable', advanced: false })

export function getPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}')
    return {
      theme: ['dark', 'light', 'system'].includes(saved.theme) ? saved.theme : DEFAULTS.theme,
      density: ['comfortable', 'compact'].includes(saved.density) ? saved.density : DEFAULTS.density,
      advanced: saved.advanced === true,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

export function applyPreferences(prefs) {
  const theme = prefs.theme === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : prefs.theme
  document.documentElement.dataset.theme = theme
  document.documentElement.dataset.density = prefs.density === 'compact' ? 'compact' : 'comfortable'
  const advanced = document.getElementById('advanced-nav')
  if (advanced) advanced.open = prefs.advanced
}

export function savePreferences(prefs) {
  const safe = {
    theme: ['dark', 'light', 'system'].includes(prefs.theme) ? prefs.theme : DEFAULTS.theme,
    density: ['comfortable', 'compact'].includes(prefs.density) ? prefs.density : DEFAULTS.density,
    advanced: prefs.advanced === true,
  }
  applyPreferences(safe)
  try {
    localStorage.setItem(KEY, JSON.stringify(safe))
    return { ok: true }
  } catch (error) {
    return { ok: false, error }
  }
}
