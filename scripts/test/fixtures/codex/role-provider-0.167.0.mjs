// Synthetic parser / app-server role-resolution fixture (card P01).
//
// This module is NOT upstream Codex source and NEVER executes the Codex CLI.
// It encodes only the boundary that the planning package cites for 0.167.0:
//   · a child turn inherits the provider of its parent turn;
//   · the role override whitelist does not include model_provider;
//   · a role may select another model, but only within the inherited provider identity.
//
// Provenance (read-only, no network):
//   openai/codex rust-v0.167.0 codex-rs/core/src/agent/child_config.rs
//   openai/codex rust-v0.167.0 codex-rs/core/src/agent/role.rs#L69-L113
// Primary source re-verification is UNKNOWN_PRIMARY_SOURCE (no local Rust checkout;
// network is forbidden here). Real CLI execution is BLOCKED_ENV (bwrap unavailable)
// and belongs to Q02. See docs/explanation/adr-0003-codex-role-provider-boundary.md.
//
// Deliberate scope limits:
//   · only "key = \"string\"" and [section] lines are parsed; anything else throws;
//   · the full role.rs whitelist is UNKNOWN, so callers must pass the fields they assert;
//   · no file, environment, credential, clock, or network access.

export const FIXTURE_VERSION = '0.167.0-linux-x64'

export const PROVIDER_SOURCE = 'parent_turn'
export const ROLE_PROVIDER_FIELD = 'model_provider'
export const DEFAULT_SUPPORTED_ROLE_FIELDS = Object.freeze(['model'])

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

// Restricted parser for the isolated fixture only. Throws on unsupported syntax so a
// test can never silently treat unrelated TOML as understood.
export function parseSyntheticRolesConfig(text) {
  if (typeof text !== 'string') throw new TypeError('config text must be a string')
  const topLevel = {}
  const sections = {}
  let current = topLevel
  let currentName = ''
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    if (line.startsWith('[') && line.endsWith(']')) {
      currentName = line.slice(1, -1).trim()
      if (currentName === '') throw new Error('empty section name')
      if (!sections[currentName]) sections[currentName] = {}
      current = sections[currentName]
      continue
    }
    const at = line.indexOf('=')
    if (at === -1) throw new Error('unsupported config line: ' + line)
    const key = line.slice(0, at).trim()
    const rawValue = line.slice(at + 1).trim()
    if (key === '') throw new Error('empty config key')
    if (!rawValue.startsWith('"') || !rawValue.endsWith('"')) {
      throw new Error('unsupported value for ' + key + ' (only quoted strings are modeled)')
    }
    current[key] = rawValue.slice(1, -1)
  }
  return { topLevel, sections }
}

// Locked child resolution: the provider is always the parent's provider.
// A role model_provider is reported as ignored (negative fixture), never applied.
export function resolveChild({ parentProvider, parentModel = '', role = null, supportedRoleFields = DEFAULT_SUPPORTED_ROLE_FIELDS } = {}) {
  const applied = {}
  const ignored = {}
  const diagnostics = []
  if (typeof parentProvider !== 'string' || parentProvider.trim() === '') {
    return { provider: null, model: null, applied, ignored, diagnostics: ['parent_provider_missing'] }
  }
  const provider = parentProvider
  let model = parentModel
  if (role != null) {
    if (!isPlainObject(role)) {
      diagnostics.push('role_not_object')
    } else {
      const supported = new Set(Array.isArray(supportedRoleFields) ? supportedRoleFields : [])
      for (const key of Object.keys(role)) {
        if (key === ROLE_PROVIDER_FIELD) {
          ignored[key] = role[key]
          diagnostics.push('role_model_provider_not_applied')
          continue
        }
        if (supported.has(key)) {
          applied[key] = role[key]
          if (key === 'model') model = role[key]
          continue
        }
        ignored[key] = role[key]
        diagnostics.push('role_field_unknown:' + key)
      }
    }
  }
  return { provider, model, applied, ignored, diagnostics }
}
