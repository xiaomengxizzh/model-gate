// M0-3 配置/Key 提交与恢复（plan §2.3）。
//
// 目标：keys.local.json 与 gateway.local.json 是「同一代际」的两个文件；任何一步失败或进程中断，
// 重启后必须读回一致代际（全旧或全新），不得混合，也不得降低已有鉴权。
//
// 机制：
//   - 目录级跨进程写锁（O_EXCL 锁文件；持有者存活则立即拒绝，不排队）
//   - 暂存新旧两代内容到 <dir>/.mg-txn/<opId>/，逐个文件 fsync
//   - 先写 journal（old/new 哈希、目标清单、opId），再对每个目标做「校验旧指纹 → rename 新文件 → fsync 目录」
//   - 全部 rename 后写 commit marker；随后 publish（调用方 reload 内存）再清理自有工件
//   - recover()：有 marker 且目标均为新 → 前滚；无 marker 且每个目标只可能是旧或新 → 回滚到旧；
//     其它（外部修改/无法判定）→ 保留现场、fail-closed、返回结构化冲突
// 所有写目标文件的路径都经过 rename，禁止 writeFileSync 直写目标（journal/暂存件除外）。
import { closeSync, existsSync, fchmodSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'

export const TARGET_KEYS = 'keys.local.json'
export const TARGET_CONFIG = 'gateway.local.json'
export const TARGETS = [TARGET_KEYS, TARGET_CONFIG]
export const JOURNAL_FILE = 'config-txn.json'
export const MARKER_FILE = 'config-txn.commit.json'
export const LOCK_FILE = 'config-txn.lock'
export const TXN_DIR = '.mg-txn'
export const FAULT_ENV = 'MG_TXN_FAULT'
export const FAULT_POINTS = Object.freeze([
  'before_stage', 'before_stage_fsync', 'before_intent', 'after_intent',
  'after_rename_keys', 'after_rename_config', 'before_commit_marker',
  'after_commit_marker', 'before_publish',
])

export class TransactionError extends Error {
  constructor (code, message, details) {
    super(message)
    this.name = 'TransactionError'
    this.code = code
    if (details) this.details = details
  }
}

function fail (code, message, details) { throw new TransactionError(code, message, details) }
function sha256 (buf) { return createHash('sha256').update(buf).digest('hex') }
function nowIso () { return new Date().toISOString() }

// 故障注入：MG_TXN_FAULT=<point>[:exit|kill|throw]（opts.fault 可传同格式字符串或回调，供进程内测试）。
function faultAction (spec) {
  if (!spec) return null
  if (typeof spec === 'function') return spec
  const [name, action] = String(spec).split(':')
  return { name, action: action || 'throw' }
}
export function checkFault (point, opts = {}) {
  const spec = opts.fault !== undefined ? opts.fault : process.env[FAULT_ENV]
  const parsed = faultAction(spec)
  if (!parsed) return
  if (typeof parsed === 'function') {
    const verdict = parsed(point)
    if (!verdict) return
    if (verdict === 'exit') process.exit(97)
    if (verdict === 'kill') process.kill(process.pid, 'SIGKILL')
    fail('injected_fault', 'transaction fault injected at ' + point)
  }
  if (parsed.name !== point) return
  if (parsed.action === 'exit') process.exit(97)
  if (parsed.action === 'kill') process.kill(process.pid, 'SIGKILL')
  fail('injected_fault', 'transaction fault injected at ' + point)
}

export function fileState (path) {
  try {
    const buf = readFileSync(path)
    return { exists: true, buf, hash: sha256(buf), size: buf.length }
  } catch (error) {
    if (error && error.code === 'ENOENT') return { exists: false, buf: null, hash: null, size: 0 }
    throw error
  }
}

function stateOf (path) {
  const st = fileState(path)
  return { exists: st.exists, hash: st.hash, size: st.size }
}

// 磁盘指纹（可安全放进内存 cfg）：只含存在性与哈希，不含正文/Key。
export function fingerprint (paths, targets = TARGETS) {
  const out = {}
  for (const name of targets) out[name === TARGET_KEYS ? 'keys' : 'local'] = stateOf(join(paths.dir, name))
  return out
}

function fsyncDir (dir) {
  let fd
  try { fd = openSync(dir, 'r'); fsyncSync(fd) } catch { /* 目录 fsync 在个别平台不支持 */ } finally { if (fd !== undefined) { try { closeSync(fd) } catch {} } }
}

// 原子+持久写：临时文件 → fsync → rename → fsync 目录。所有「目标文件」都走这里。
export function writeFileDurable (path, data, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + '.' + process.pid + '.' + randomBytes(4).toString('hex') + '.tmp'
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')
  const fd = openSync(tmp, 'w', mode)
  try {
    fchmodSync(fd, mode)
    writeSync(fd, buf)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
  fsyncDir(dirname(path))
}

function pidAlive (pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}

function readJsonFile (path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch (error) {
    if (error && error.code === 'ENOENT') return null
    fail('journal_unreadable', '事务元数据不可解析：' + path)
  }
}

function acquireLock (paths, opId) {
  mkdirSync(paths.dir, { recursive: true })
  const lockPath = join(paths.dir, LOCK_FILE)
  const payload = JSON.stringify({ pid: process.pid, opId, at: Date.now() })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600)
      try { writeSync(fd, payload); fsyncSync(fd) } finally { closeSync(fd) }
      return { path: lockPath, opId }
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error
      const owner = readJsonFile(lockPath)
      if (owner && pidAlive(Number(owner.pid))) {
        fail('store_locked', '配置正被另一个写者持有锁（pid ' + owner.pid + '）', { ownerPid: Number(owner.pid) })
      }
      // 持有者已不存在：清理陈旧锁后重试一次（仍然失败则拒绝，不排队等待）
      try { unlinkSync(lockPath) } catch {}
    }
  }
  fail('store_locked', '配置写锁无法获取（存在未清理的锁文件）')
}

function releaseLock (lock) {
  if (!lock) return
  try {
    const owner = readJsonFile(lock.path)
    if (!owner || owner.opId === lock.opId) unlinkSync(lock.path)
  } catch {}
}

function removeIfExists (path) { try { unlinkSync(path) } catch {} }

// 只清理本事务自有的临时写文件（writeFileDurable 的命名模式），不碰用户其它文件。
const OWN_TMP_RE = /^(?:keys\.local\.json|gateway\.local\.json|config-txn(?:\.commit)?\.json)\.[0-9]+\.[a-f0-9]+\.tmp$/
function cleanupOwnedTmp (paths) {
  let names = []
  try { names = readdirSync(paths.dir) } catch { return }
  for (const name of names) if (OWN_TMP_RE.test(name)) removeIfExists(join(paths.dir, name))
}

function cleanupArtifacts (paths, opId) {
  if (opId) { try { rmSync(join(paths.dir, TXN_DIR, opId), { recursive: true, force: true }) } catch {} }
  // 只清理空的事务目录（仍有其它 op 的暂存件时保留）。
  try { rmdirSync(join(paths.dir, TXN_DIR)) } catch {}
  cleanupOwnedTmp(paths)
  removeIfExists(join(paths.dir, JOURNAL_FILE))
  removeIfExists(join(paths.dir, MARKER_FILE))
  fsyncDir(paths.dir)
}

// 事务恢复（需在持锁状态下调用）。
function recoverLocked (paths, opts = {}) {
  const journalPath = join(paths.dir, JOURNAL_FILE)
  const markerPath = join(paths.dir, MARKER_FILE)
  if (!existsSync(journalPath)) {
    // 无 journal：可能只剩 marker 或未写完的暂存目录（journal 永远写在 rename 之前，
    // 因此「无 journal ⇒ 没有任何目标文件被替换」）。这些都只是自有半成品，直接清理。
    if (existsSync(markerPath)) removeIfExists(markerPath)
    try { rmSync(join(paths.dir, TXN_DIR), { recursive: true, force: true }) } catch {}
    cleanupOwnedTmp(paths)
    fsyncDir(paths.dir)
    return { status: 'clean', generation: fingerprint(paths) }
  }
  const journal = readJsonFile(journalPath)
  if (!journal || !Array.isArray(journal.targets) || !journal.opId) {
    fail('journal_unreadable', '事务 journal 结构非法，保留现场并 fail-closed')
  }
  const marker = readJsonFile(markerPath)
  const commitMarker = !!marker && marker.opId === journal.opId
  const stageDir = join(paths.dir, TXN_DIR, journal.opId)
  const states = {}
  let allNew = true
  let allOldOrNew = true
  for (const target of journal.targets) {
    const current = stateOf(join(paths.dir, target.name))
    if (!current.exists || current.hash !== target.new.hash) allNew = false
    const isOld = target.old.exists ? (current.exists && current.hash === target.old.hash) : !current.exists
    const isNew = current.exists && current.hash === target.new.hash
    states[target.name] = isOld ? 'old' : (isNew ? 'new' : (current.exists ? 'other' : 'missing'))
    if (!isOld && !isNew) allOldOrNew = false
  }
  if (commitMarker && allNew) {
    cleanupArtifacts(paths, journal.opId)
    return { status: 'recovered-new', opId: journal.opId, generation: fingerprint(paths) }
  }
  if (!commitMarker && allOldOrNew) {
    // 回滚到旧代际：逐目标校验后原子写回（旧文件不存在则删除本次创建的文件）。
    for (const target of journal.targets) {
      const targetPath = join(paths.dir, target.name)
      if (states[target.name] === 'old') continue
      if (!target.old.exists) {
        if (existsSync(targetPath) && stateOf(targetPath).hash === target.new.hash) removeIfExists(targetPath)
        continue
      }
      const backupPath = join(stageDir, target.name + '.old')
      const backup = fileState(backupPath)
      if (!backup.exists || backup.hash !== target.old.hash) {
        fail('recovery_backup_missing', '回滚所需的旧内容缺失或不匹配：' + target.name, { target: target.name })
      }
      writeFileDurable(targetPath, backup.buf, 0o600)
    }
    fsyncDir(paths.dir)
    cleanupArtifacts(paths, journal.opId)
    return { status: 'recovered-old', opId: journal.opId, generation: fingerprint(paths) }
  }
  // 外部修改/无法判定：保留磁盘与 journal，停止写入。
  fail('store_conflict', '磁盘文件既非事务旧代际也非新代际（可能被外部编辑），已保留现场并停止写入', {
    opId: journal.opId, commitMarker, targets: states,
  })
}

// 只读恢复入口：加锁 → 恢复 → 释放。供启动、/api/config/reload 与测试使用。
export function recoverStore (paths, opts = {}) {
  const opId = opts.opId || ('recover-' + process.pid + '-' + Date.now())
  const lock = acquireLock(paths, opId)
  try { return recoverLocked(paths, opts) } finally { releaseLock(lock) }
}

// 写事务入口：加锁 → 恢复 → 校验内存指纹与磁盘一致 → 返回事务对象。
// expected = 内存 cfg 的 _disk 指纹（loadConfig 产出）；磁盘改过则 store_conflict，绝不覆盖。
export function beginWrite (paths, opts = {}) {
  const opId = opts.opId || (process.pid + '-' + Date.now() + '-' + randomBytes(4).toString('hex'))
  const lock = acquireLock(paths, opId)
  try {
    recoverLocked(paths, opts)
    const disk = fingerprint(paths)
    if (opts.expected) {
      for (const key of ['keys', 'local']) {
        const want = opts.expected[key]
        if (!want) continue
        const got = disk[key]
        if (!!want.exists !== !!got.exists || (want.exists && want.hash !== got.hash)) {
          fail('store_conflict', '配置已被外部修改（' + key + ' 指纹不一致），已停止写入并保留现场', { target: key })
        }
      }
    }
    let released = false
    const tx = {
      opId,
      disk,
      commit ({ files = {}, publish, operation = 'config' } = {}) {
        const changed = TARGETS.filter((name) => files[name] !== undefined)
        if (!changed.length) {
          if (typeof publish === 'function') publish()
          return { opId, operation, changed: [] }
        }
        // 尽早在持锁期间再确认一次：防止 lock 获取后到 commit 之间被外部写入。
        for (const name of changed) {
          const current = stateOf(join(paths.dir, name))
          const before = disk[name === TARGET_KEYS ? 'keys' : 'local']
          if (!!current.exists !== !!before.exists || (current.exists && current.hash !== before.hash)) {
            fail('store_conflict', '目标文件在事务期间被外部修改：' + name, { target: name })
          }
        }
        const stageDir = join(paths.dir, TXN_DIR, opId)
        mkdirSync(stageDir, { recursive: true, mode: 0o700 })
        const targets = []
        try {
          checkFault('before_stage', opts)
          for (const name of changed) {
            const content = files[name]
            const newBuf = Buffer.from(String(content), 'utf8')
            writeFileDurable(join(stageDir, name + '.new'), newBuf, 0o600)
            const before = disk[name === TARGET_KEYS ? 'keys' : 'local']
            if (before.exists) {
              const oldBuf = readFileSync(join(paths.dir, name))
              writeFileDurable(join(stageDir, name + '.old'), oldBuf, 0o600)
            }
            targets.push({ name, old: { exists: !!before.exists, hash: before.hash }, new: { hash: sha256(newBuf), size: newBuf.length } })
          }
          checkFault('before_stage_fsync', opts)
          fsyncDir(stageDir)
          fsyncDir(join(paths.dir, TXN_DIR))
          const journal = { opId, operation, pid: process.pid, at: nowIso(), targets }
          checkFault('before_intent', opts)
          writeFileDurable(join(paths.dir, JOURNAL_FILE), JSON.stringify(journal, null, 2), 0o600)
          checkFault('after_intent', opts)
          for (const target of targets) {
            const targetPath = join(paths.dir, target.name)
            const current = stateOf(targetPath)
            const expectedOld = target.old
            const matchesOld = expectedOld.exists ? (current.exists && current.hash === expectedOld.hash) : !current.exists
            if (!matchesOld) {
              fail('store_conflict', '目标文件在事务期间被外部修改：' + target.name, { target: target.name })
            }
            renameSync(join(stageDir, target.name + '.new'), targetPath)
            fsyncDir(paths.dir)
            checkFault(target.name === TARGET_KEYS ? 'after_rename_keys' : 'after_rename_config', opts)
          }
          checkFault('before_commit_marker', opts)
          writeFileDurable(join(paths.dir, MARKER_FILE), JSON.stringify({ opId, at: nowIso(), targets }, null, 2), 0o600)
          checkFault('after_commit_marker', opts)
          checkFault('before_publish', opts)
          if (typeof publish === 'function') publish()
        } catch (error) {
          // 已发生 rename 的情况下保留 journal/marker 交给恢复处理；尚未写 journal 时清理暂存目录。
          if (!existsSync(join(paths.dir, JOURNAL_FILE))) {
            try { rmSync(stageDir, { recursive: true, force: true }) } catch {}
          }
          throw error
        }
        // publish 成功后清理本次自有工件（marker 最后删）。
        cleanupArtifacts(paths, opId)
        if (opts.log) opts.log.info('配置事务提交', 'opId=' + opId, 'operation=' + operation, 'targets=' + targets.map((t) => t.name).join(','))
        return { opId, operation, changed }
      },
      release () { if (!released) { released = true; releaseLock(lock) } },
    }
    return tx
  } catch (error) {
    releaseLock(lock)
    throw error
  }
}

// 读取当前两个目标（供测试/诊断；不解析内容）。
export function snapshot (paths) {
  const out = {}
  for (const name of TARGETS) out[name] = fileState(join(paths.dir, name))
  return out
}

// 工件是否已清理干净（测试断言「不产生半成品文件」）。
export function artifacts (paths) {
  const listed = []
  for (const name of [JOURNAL_FILE, MARKER_FILE, LOCK_FILE]) if (existsSync(join(paths.dir, name))) listed.push(name)
  try {
    for (const entry of readdirSync(join(paths.dir, TXN_DIR))) listed.push(TXN_DIR + '/' + entry)
  } catch {}
  return listed
}

// 目标文件权限（测试断言 keys 为 0600）。
export function modeOf (path) {
  try { return statSyncMode(path) } catch { return null }
}
function statSyncMode (path) {
  return statSync(path).mode & 0o777
}
