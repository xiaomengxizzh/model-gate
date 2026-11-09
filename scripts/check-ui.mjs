// Syntax-check every /ui-next ES module without executing it. Zero dependencies.
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const dir = join(root, 'src/ui-next')
const files = []
function walk (d) {
  for (const name of readdirSync(d)) {
    const p = join(d, name)
    if (statSync(p).isDirectory()) walk(p)
    else if (name.endsWith('.js')) files.push(p)
  }
}
walk(dir)
files.sort()
let failed = 0
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' })
  if (r.status !== 0) { failed++; console.error('FAIL ' + relative(root, f) + '\n' + (r.stderr || '')) }
}
console.log('UI modules: ' + (files.length - failed) + '/' + files.length + ' syntax OK')
process.exitCode = failed ? 1 : 0
