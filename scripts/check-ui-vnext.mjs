import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const dir = join(root, 'src/ui-vnext')
const files = []
function walk(current) {
  for (const name of readdirSync(current)) {
    const path = join(current, name)
    if (statSync(path).isDirectory()) walk(path)
    else if (name.endsWith('.js')) files.push(path)
  }
}
walk(dir)
files.sort()
let failed = 0
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (result.status !== 0) {
    failed++
    console.error('FAIL ' + relative(root, file) + '\n' + (result.stderr || ''))
  }
}
console.log('UI vNext modules: ' + (files.length - failed) + '/' + files.length + ' syntax OK')
process.exitCode = failed ? 1 : 0
