import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.md') ? [join(dir, e.name)] : [])
}
const docs = ['README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'CHANGELOG.md'].map(f => join(root, f)).concat(files(join(root, 'docs')))
let failures = 0
for (const file of docs) {
  // Archived reports preserve their original context; check their navigation page only.
  if (file.includes('/archive/') && !file.endsWith('/README.md')) continue
  const source = readFileSync(file, 'utf8').replace(/```[^\n]*\n[\s\S]*?```/g, '')
  for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].split('#')[0]
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue
    const dest = resolve(dirname(file), decodeURIComponent(target))
    if (!existsSync(dest) || !statSync(dest).isFile()) {
      console.error(`${file}: missing link ${target}`); failures++
    }
  }
}
if (readFileSync(join(root, 'AGENTS.md'), 'utf8').split('\n').length > 200) { console.error('AGENTS.md exceeds 200 lines'); failures++ }
console.log(`Documentation paths: ${failures ? 'FAIL (' + failures + ')' : 'PASS'}`)
process.exitCode = failures ? 1 : 0
