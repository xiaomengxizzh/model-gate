import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = fileURLToPath(new URL('../', import.meta.url))

export function codeFingerprint() {
  const files = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else files.push(path)
    }
  }
  walk(join(root, 'src'))
  const scriptFiles = (dir, accept) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) scriptFiles(path, accept)
      else if (accept(entry.name)) files.push(path)
    }
  }
  scriptFiles(join(root, 'scripts/e2e'), (name) => /^ui-v13-.*\.mjs$/.test(name))
  scriptFiles(join(root, 'scripts/test/offline'), (name) => /^(?:v13-.*|mg-r009-.*|tenancy-findings|tenant-env-credential|config-write-concurrency|legacy-config-write|egress-dns-pinning)\.test\.mjs$/.test(name))
  for (const path of ['package.json', 'scripts/tree-fingerprint.mjs', 'scripts/test/run.mjs', 'scripts/check-ui-vnext.mjs']) files.push(join(root, path))
  const hash = createHash('sha256')
  for (const path of files.sort()) {
    hash.update(relative(root, path))
    hash.update('\0')
    hash.update(readFileSync(path))
    hash.update('\0')
  }
  return { algorithm: 'sha256(path+NUL+bytes)', files: files.length, sha256: hash.digest('hex') }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) console.log(JSON.stringify(codeFingerprint(), null, 2))
