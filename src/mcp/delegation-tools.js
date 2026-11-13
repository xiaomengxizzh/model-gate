// G3：子任务本地工作区工具执行器（受限路径 + 有界输出，零依赖）。
//
// 为什么需要它：MCP 委派把任务文本发给 OpenCode Go 模型；模型若只产出文本，就无法证明
// 「子任务执行了实际工具」。本模块给子模型一组**受限**的本地文件工具，由 ModelGate 亲自执行，
// 因此产出的结果与 sha256 是可核验的本地事实，而不是上游自述。
//
// 硬边界：
//   · 所有路径必须落在显式 workspaceRoot 内；绝对路径、'..'、符号链接逃逸一律拒绝。
//   · 单次输出/写入有字节上限；超限报错，不静默截断（读文件可显式声明截断并在结果里标记）。
//   · 默认不提供 shell 执行：命令执行需要显式开启，且不属于本轮交付范围。

import { createHash, randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { ERRORS, LIMITS } from './delegation-contract.js'

export const TOOL_DEFS = Object.freeze({
  read_file: {
    name: 'read_file',
    description: '读取工作区内一个文本文件（UTF-8）。超出单次上限时截断并标记 truncated。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '工作区内相对路径' }, maxBytes: { type: 'integer' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  write_file: {
    name: 'write_file',
    description: '在工作区内创建或覆盖一个文本文件（自动创建父目录）。返回写入字节数与 sha256。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '工作区内相对路径' }, content: { type: 'string' } },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  list_dir: {
    name: 'list_dir',
    description: '列出工作区内一个目录的直接子项（名称/类型/大小），最多 200 条。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  stat_path: {
    name: 'stat_path',
    description: '查看工作区内路径的存在性、类型、大小与 sha256。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
})

export const ALL_TOOL_NAMES = Object.freeze(Object.keys(TOOL_DEFS))
export const DEFAULT_TOOLS = Object.freeze(['read_file', 'list_dir', 'write_file', 'stat_path'])

function isInside(root, target) {
  return target === root || target.startsWith(root + sep)
}

function sha256Buf(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

function hashFile(abs, sizeCap) {
  const st = statSync(abs)
  if (!st.isFile()) return null
  if (st.size > sizeCap) {
    // 大文件分块哈希：不把整个文件读进内存。
    const hash = createHash('sha256')
    const fd = openSync(abs, 'r')
    const buf = Buffer.allocUnsafe(1024 * 1024)
    let pos = 0
    try {
      for (;;) {
        const n = readSync(fd, buf, 0, buf.length, pos)
        if (n <= 0) break
        hash.update(buf.subarray(0, n))
        pos += n
      }
    } finally {
      try { closeSync(fd) } catch {}
    }
    return hash.digest('hex')
  }
  return sha256Buf(readFileSync(abs))
}

/**
 * createWorkspaceTools({ root, enabled?, now? })
 * root 必须是已 realpath 化的绝对目录；enabled 限定可调用子集。
 */
export function createWorkspaceTools(opts = {}) {
  const rawRoot = String(opts.root || '')
  if (!isAbsolute(rawRoot)) throw new Error('workspaceRoot 必须是绝对路径：' + rawRoot)
  let root
  try { root = realpathSync(rawRoot) } catch { throw new Error('workspaceRoot 不存在：' + rawRoot) }
  const enabled = Array.isArray(opts.enabled) && opts.enabled.length ? opts.enabled.slice() : DEFAULT_TOOLS.slice()
  for (const name of enabled) if (!TOOL_DEFS[name]) throw new Error('未知工具：' + name)

  function safePath(rel) {
    if (typeof rel !== 'string' || rel.trim() === '') throw Object.assign(new Error('path 必填'), { code: ERRORS.WORKSPACE_DENIED })
    if (isAbsolute(rel)) throw Object.assign(new Error('拒绝绝对路径：' + rel), { code: ERRORS.WORKSPACE_DENIED })
    const parts = rel.split(/[\\/]+/).filter((p) => p !== '' && p !== '.')
    if (parts.includes('..')) throw Object.assign(new Error('拒绝父目录跳转：' + rel), { code: ERRORS.WORKSPACE_DENIED })
    const abs = resolve(join(root, parts.join('/')))
    if (!isInside(root, abs)) throw Object.assign(new Error('路径越界：' + rel), { code: ERRORS.WORKSPACE_DENIED })
    // 已存在时做 realpath 校验，防止符号链接把读写引到工作区外。
    try {
      const real = realpathSync(abs)
      if (!isInside(root, real)) throw Object.assign(new Error('符号链接逃逸：' + rel), { code: ERRORS.WORKSPACE_DENIED })
      return real
    } catch (err) {
      if (err && err.code === ERRORS.WORKSPACE_DENIED) throw err
      // 不存在：返回目标路径（写入场景），父目录仍会再校验。
      return abs
    }
  }

  function check(name) {
    if (!enabled.includes(name)) throw Object.assign(new Error('工具未启用：' + name), { code: ERRORS.TOOL_EXEC_FAILED })
  }

  const tools = {
    root,
    enabled,
    definitions() { return enabled.map((n) => TOOL_DEFS[n]) },

    stat(rel) {
      const abs = safePath(rel)
      let st
      try { st = statSync(abs) } catch { return { ok: true, path: rel, exists: false } }
      const out = { ok: true, path: rel, exists: true, type: st.isDirectory() ? 'dir' : (st.isFile() ? 'file' : 'other'), size: st.size }
      if (st.isFile()) out.sha256 = hashFile(abs, 8 * 1024 * 1024)
      return out
    },

    execute(name, args) {
      check(name)
      const a = args && typeof args === 'object' ? args : {}
      if (name === 'read_file') {
        const abs = safePath(a.path)
        const st = statSync(abs)
        if (!st.isFile()) throw Object.assign(new Error('不是普通文件：' + a.path), { code: ERRORS.TOOL_EXEC_FAILED })
        const cap = Math.min(Number(a.maxBytes) > 0 ? Number(a.maxBytes) : LIMITS.maxOutputPerCall, LIMITS.maxOutputPerCall)
        const buf = readFileSync(abs)
        const truncated = buf.length > cap
        return {
          ok: true,
          path: a.path,
          bytes: buf.length,
          sha256: sha256Buf(buf),
          truncated,
          content: buf.subarray(0, cap).toString('utf8'),
        }
      }
      if (name === 'write_file') {
        const abs = safePath(a.path)
        const content = typeof a.content === 'string' ? a.content : null
        if (content == null) throw Object.assign(new Error('content 必填字符串'), { code: ERRORS.BAD_REQUEST })
        const buf = Buffer.from(content, 'utf8')
        if (buf.length > LIMITS.maxOutputPerCall) {
          throw Object.assign(new Error('写入超限：' + buf.length + ' 字节 > ' + LIMITS.maxOutputPerCall), { code: ERRORS.TOO_LARGE })
        }
        mkdirSync(dirname(abs), { recursive: true })
        let existed = true
        try { statSync(abs) } catch { existed = false }
        const tmp = abs + '.tmp-' + randomBytes(6).toString('hex')
        writeFileSync(tmp, buf, { mode: 0o600 })
        renameSync(tmp, abs)
        return { ok: true, path: a.path, bytes: buf.length, sha256: sha256Buf(buf), created: !existed }
      }
      if (name === 'list_dir') {
        const abs = safePath(a.path === undefined ? '.' : a.path)
        const entries = readdirSync(abs, { withFileTypes: true })
        const out = []
        for (const e of entries.slice(0, 200)) {
          const p = join(abs, e.name)
          let size = null
          try { size = statSync(p).size } catch {}
          out.push({ name: e.name, type: e.isDirectory() ? 'dir' : (e.isFile() ? 'file' : 'other'), size })
        }
        return { ok: true, path: a.path === undefined ? '.' : a.path, count: entries.length, truncated: entries.length > 200, entries: out }
      }
      if (name === 'stat_path') return tools.stat(a.path)
      throw Object.assign(new Error('未知工具：' + name), { code: ERRORS.UNKNOWN_TOOL })
    },
  }
  return tools
}

/** 在任务前后对引用做指纹，证明子任务确实改了工作区（本地可核验事实）。 */
export function fingerprintRefs(workspaceTools, refs) {
  const out = []
  for (const ref of Array.isArray(refs) ? refs : []) {
    let entry
    try {
      if (ref.kind === 'dir') {
        const listing = workspaceTools.execute('list_dir', { path: ref.path })
        entry = { path: ref.path, kind: 'dir', exists: true, entries: listing.count, digest: sha256Buf(Buffer.from(JSON.stringify(listing.entries))) }
      } else {
        const st = workspaceTools.stat(ref.path)
        entry = { path: ref.path, kind: 'file', exists: st.exists === true, size: st.exists ? st.size : null, sha256: st.exists ? st.sha256 : null }
      }
    } catch (err) {
      entry = { path: ref.path, kind: ref.kind || 'file', exists: false, error: String(err && err.code ? err.code : 'error') }
    }
    out.push(entry)
  }
  return out
}

export function diffRefs(before, after) {
  const artifacts = []
  for (let i = 0; i < before.length; i++) {
    const b = before[i]
    const a = after[i] || {}
    artifacts.push({
      path: b.path,
      kind: b.kind,
      sha256Before: b.sha256 || null,
      sha256After: a.sha256 || null,
      sizeBefore: b.size == null ? null : b.size,
      sizeAfter: a.size == null ? null : a.size,
      changed: (b.sha256 || null) !== (a.sha256 || null) || (b.exists !== a.exists),
    })
  }
  return artifacts
}
