// 文档路径门禁：在**纯检出**（git archive / CI checkout）下必须可判定。
//
//   node scripts/check-docs.mjs
//
// 判定规则：
//   - 仓库内相对链接：解析到本仓库根内的真实文件才算通过；
//   - 越出仓库根的相对/绝对本地链接：一律 FAIL（即使宿主上恰好存在该文件，
//     其它机器/CI 的纯检出没有工作区外文件，不能作为存在性证据）；
//   - 页内锚点（#...）与外部 scheme（http/https/mailto/...）单独归类，不解析、不误报；
//   - 归档目录只校验导航页 README.md（历史报告保留原始上下文）。
// 输出 PASS/FAIL 行，任一失败时退出码为 1。零第三方依赖、不联网。
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { resolve, dirname, join, relative, isAbsolute, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../', import.meta.url)))
const stats = { files: 0, inRepo: 0, anchors: 0, external: 0, skippedArchive: 0 }
const failures = []

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.md') ? [join(dir, e.name)] : [])
}

const docs = ['README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'CHANGELOG.md'].map(f => join(root, f)).concat(files(join(root, 'docs')))

// 去掉围栏代码块（三反引号），避免把示例里的链接当导航链接。
const fence = String.fromCharCode(96).repeat(3)
function stripFences(text) {
  const out = []
  let inside = false
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith(fence)) { inside = !inside; continue }
    if (!inside) out.push(line)
  }
  return out.join('\n')
}

// 链接目标清洗：去掉 <> 包裹与可选 title（[x](path "title")），只保留路径部分。
function targetOf(raw) {
  let target = raw.trim()
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1).trim()
  target = target.split(/\s+/)[0]
  return target.split('#')[0].split('?')[0]
}

for (const file of docs) {
  // 归档报告保留原始上下文；只校验归档导航页 README.md。
  if (file.includes('/archive/') && !file.endsWith('/README.md')) { stats.skippedArchive++; continue }
  stats.files++
  const relFile = relative(root, file)
  const source = stripFences(readFileSync(file, 'utf8'))
  for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = targetOf(match[1])
    if (!target) { stats.anchors++; continue }
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) { stats.external++; continue }
    if (target.startsWith('/') || /^[A-Za-z]:[\\/]/.test(target)) {
      failures.push(relFile + ': link escapes repository root: ' + match[1])
      continue
    }
    let dest
    try { dest = resolve(dirname(file), decodeURIComponent(target)) }
    catch { failures.push(relFile + ': malformed link target: ' + match[1]); continue }
    const relDest = relative(root, dest)
    if (relDest === '' || relDest === '..' || relDest.startsWith('..' + sep) || isAbsolute(relDest)) {
      failures.push(relFile + ': link escapes repository root: ' + match[1])
      continue
    }
    if (!existsSync(dest) || !statSync(dest).isFile()) {
      failures.push(relFile + ': missing link ' + match[1])
      continue
    }
    stats.inRepo++
  }
}

const agentsLines = readFileSync(join(root, 'AGENTS.md'), 'utf8').split('\n').length
if (agentsLines > 200) failures.push('AGENTS.md exceeds 200 lines (' + agentsLines + ')')

for (const failure of failures) console.error('FAIL ' + failure)
console.log('Scanned ' + stats.files + ' files (' + stats.skippedArchive + ' archived reports skipped); links in-repo=' + stats.inRepo + ' anchor=' + stats.anchors + ' external=' + stats.external)
if (!failures.length) console.log('Documentation paths: PASS (' + stats.files + ' files, ' + (stats.inRepo + stats.anchors + stats.external) + ' links)')
else console.log('Documentation paths: FAIL (' + failures.length + ')')
process.exitCode = failures.length ? 1 : 0
