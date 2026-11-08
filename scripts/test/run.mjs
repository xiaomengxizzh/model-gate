// Safe default: only self-contained mock suites. Legacy tests require a separate opt-in.
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../../', import.meta.url))
const filter = (process.argv[2] || '').toLowerCase()
const suites = ['virtual-models.mjs', 'effort-normalize.mjs', 'upstream-side-4xx.mjs',
  ...readdirSync(new URL('./offline/', import.meta.url)).filter(f => f.endsWith('.test.mjs')).map(f => 'offline/' + f)]
const selected = suites.filter(f => f.toLowerCase().includes(filter))
if (!selected.length) { console.error('No matching isolated test: ' + filter); process.exit(2) }
let failed = 0
for (const file of selected) {
  console.log('\n== ' + file + ' ==')
  const args = file.endsWith('.test.mjs') ? ['--test', 'scripts/test/' + file] : ['scripts/test/' + file]
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', env: {
      ...process.env, MG_KEYS_MASTER: 'isolated-test-master', MG_MAX_BODY: '',
      MG_CONFIG: '', MG_CONFIG_DIR: '', MG_CLIENT_KEY: '', MG_ADMIN_TOKEN: ''
    } })
    child.once('error', reject)
    child.once('exit', code => resolve(code))
  })
  if (code !== 0) failed++
}
console.log(`\nIsolated suites: ${selected.length - failed}/${selected.length} passed`)
process.exitCode = failed ? 1 : 0
