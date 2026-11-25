import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, lstatSync, unlinkSync, openSync, writeSync, fsyncSync, closeSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { createBackup } from './backups.js'

const ID_RE = /^bk_[A-Za-z0-9_-]{16,64}$/
const MAX_BACKUPS = 50

function backupId() { return 'bk_' + randomBytes(18).toString('base64url') }
function filePath(root, id) {
  if (!ID_RE.test(String(id || ''))) throw new Error('invalid_backup_id')
  return join(root, id + '.json')
}
function writeAtomic(path, value) {
  const tmp = path + '.tmp-' + process.pid + '-' + randomBytes(4).toString('hex')
  let fd = null
  try {
    fd = openSync(tmp, 'wx', 0o600)
    writeSync(fd, JSON.stringify(value, null, 2))
    fsyncSync(fd)
    closeSync(fd); fd = null
    renameSync(tmp, path)
  } catch (error) {
    if (fd !== null) try { closeSync(fd) } catch {}
    try { unlinkSync(tmp) } catch {}
    throw error
  }
}
function readBackup(root, id) {
  const path = filePath(root, id)
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('invalid_backup_file')
  const backup = JSON.parse(readFileSync(path, 'utf8'))
  if (backup.schema !== 'modelgate-config-backup' || backup.version !== 1 || !backup.config || typeof backup.createdAt !== 'string') throw new Error('invalid_backup_file')
  return { schema: backup.schema, version: backup.version, createdAt: backup.createdAt, config: backup.config }
}

export function createStoredBackup(cfg, root, opts = {}) {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const envelope = createBackup(cfg, opts)
  const id = backupId()
  const sha256 = createHash('sha256').update(JSON.stringify(envelope)).digest('hex')
  writeAtomic(filePath(root, id), envelope)
  pruneBackups(root)
  return { ...envelope, backupId: id, sha256 }
}

export function listStoredBackups(root) {
  let names = []
  try { names = readdirSync(root) } catch { return [] }
  const items = []
  for (const name of names) {
    if (!/^bk_[A-Za-z0-9_-]{16,64}\.json$/.test(name)) continue
    try {
      const id = name.slice(0, -5)
      const backup = readBackup(root, id)
      items.push({ backupId: id, createdAt: backup.createdAt, schema: backup.schema, version: backup.version, sha256: createHash('sha256').update(JSON.stringify(backup)).digest('hex'), bytes: Buffer.byteLength(JSON.stringify(backup)) })
    } catch {}
  }
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function readStoredBackup(root, id) { return readBackup(root, id) }
export function deleteStoredBackup(root, id) { const path = filePath(root, id); const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('invalid_backup_file'); unlinkSync(path) }
function pruneBackups(root) {
  const items = listStoredBackups(root)
  for (const item of items.slice(MAX_BACKUPS)) deleteStoredBackup(root, item.backupId)
}
