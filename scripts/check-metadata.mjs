// 发布元数据一致性核对（离线、零第三方依赖、不联网）。
//   node scripts/check-metadata.mjs
// 核对项：package.json 版本/名称/许可/engines、LICENSE 实际文件与 license 字段、
//         CHANGELOG 版本标题、README 的版本与 Node 下限/项目名声明、
//         README「运行时支持矩阵」与 engines/CI 一致（当前支持 = Linux + Node 24）、
//         manifest.yaml（存在时）的 project/version/engines 声明、
//         CI workflow 的触发方式、Node 矩阵等于已实测支持矩阵、依赖与工具链下载禁令。
// 输出 PASS/FAIL 行，任一失败时退出码为 1。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const results = []
const readText = rel => { try { return readFileSync(join(root, rel), 'utf8') } catch { return null } }
const check = (name, okFlag, detail) => results.push({ name, ok: okFlag, detail: detail === undefined ? '' : String(detail) })
const ok = (name, detail) => check(name, true, detail)
const fail = (name, detail) => check(name, false, detail)

// N00（2026-11-12）：当前**已实测**的运行时支持矩阵只有一条线：Linux + Node 24。
// 本机实测 v24.22.2（Ubuntu 26.04 / x86_64），没有 Node 18/20/22 runner，也不允许下载工具链。
// 因此 engines 下限、CI 矩阵、README 支持矩阵必须同时收敛到 24；18/20（及 22）只作历史记录。
const SUPPORTED_NODE_MAJORS = Object.freeze([24])
const RETIRED_NODE_MAJORS = Object.freeze([18, 20, 22])
const SUPPORTED_FLOOR = String(SUPPORTED_NODE_MAJORS[0])

const semver = v => /^\d+\.\d+\.\d+$/.test(String(v))
const cmpVersion = (a, b) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i]
  return 0
}
const floorOf = s => {
  const m = typeof s === 'string' ? s.match(/^>=\s*(\d+)/) : null
  return m ? m[1] : ''
}
// 取 manifest.yaml 顶层标量（只解析本仓库需要的简单键值，不引入 YAML 依赖）。
const yamlScalar = (text, key) => {
  const m = text.match(new RegExp('^' + key + ':\\s*["\\x27]?([^"\\x27\\n]+)["\\x27]?\\s*$', 'm'))
  return m ? m[1].trim() : ''
}

// —— 1. package.json ——
let pkg = null
const pkgRaw = readText('package.json')
if (pkgRaw === null) fail('package.json 存在', '缺失')
else {
  try { pkg = JSON.parse(pkgRaw); ok('package.json 可解析') } catch (e) { fail('package.json 可解析', e.message) }
}
const version = pkg && typeof pkg.version === 'string' ? pkg.version : ''
const name = pkg && typeof pkg.name === 'string' ? pkg.name.trim() : ''
if (pkg) {
  if (semver(version)) ok('package.json version 为 x.y.z', version)
  else fail('package.json version 为 x.y.z', JSON.stringify(pkg.version))
  if (/^[a-z0-9][a-z0-9._-]*$/.test(name)) ok('package.json name 合法', name)
  else fail('package.json name 合法', JSON.stringify(pkg.name))
  const licenseId = typeof pkg.license === 'string' ? pkg.license.trim() : ''
  if (licenseId) ok('package.json license 字段存在', licenseId)
  else fail('package.json license 字段存在', '缺失或非字符串')
  const nodeFloor = pkg.engines && typeof pkg.engines.node === 'string' ? pkg.engines.node.trim() : ''
  if (/^>=\s*\d+/.test(nodeFloor)) ok('package.json engines.node 声明下限', nodeFloor)
  else fail('package.json engines.node 声明下限', JSON.stringify(pkg.engines === undefined ? null : pkg.engines.node))
  // engines 下限必须等于已实测支持矩阵的最小版本：写未验证的更低版本等于暗示支持。
  if (floorOf(nodeFloor) === SUPPORTED_FLOOR) ok('package.json engines.node 等于已实测支持矩阵下限', '>= ' + SUPPORTED_FLOOR)
  else fail('package.json engines.node 等于已实测支持矩阵下限', 'engines ' + JSON.stringify(nodeFloor) + ' ≠ >= ' + SUPPORTED_FLOOR + '（当前已实测矩阵 Linux + Node ' + SUPPORTED_NODE_MAJORS.join('/') + '）')
}

// —— 2. LICENSE 实际文件与 license 字段一致 ——
const licenseText = readText('LICENSE')
if (licenseText === null) fail('LICENSE 文件存在', '缺失（package.json 已声明 ' + (pkg && pkg.license ? pkg.license : '许可') + '）')
else {
  ok('LICENSE 文件存在', licenseText.length + ' bytes')
  const body = licenseText.toLowerCase()
  const itIsMit = /\bmit license\b/.test(body) && body.includes('permission is hereby granted') && body.includes('without warranty of any kind')
  const conflicting = []
  if (/apache license/.test(body)) conflicting.push('Apache')
  if (/gnu general public license/.test(body)) conflicting.push('GPL')
  if (/redistribution and use in source and binary forms/.test(body)) conflicting.push('BSD')
  if (/mozilla public license/.test(body)) conflicting.push('MPL')
  const declared = pkg && typeof pkg.license === 'string' ? pkg.license.trim().toLowerCase() : ''
  if (declared !== 'mit') fail('LICENSE 正文与 license 字段一致', 'package.json 声明 ' + JSON.stringify(pkg && pkg.license) + '，本脚本只内置 MIT 正文核对')
  else if (!itIsMit) fail('LICENSE 正文与 license 字段一致', '声明 MIT 但正文缺少 MIT 关键段落')
  else if (conflicting.length) fail('LICENSE 正文与 license 字段一致', '正文疑似包含其它许可段落: ' + conflicting.join('/'))
  else ok('LICENSE 正文与 license 字段一致', 'MIT')
  if (/copyright \(c\)\s*\d{4}/i.test(licenseText)) ok('LICENSE 含版权行')
  else fail('LICENSE 含版权行', '未找到 Copyright (c) <year>')
}

// —— 3. CHANGELOG 版本标题 ——
const changelog = readText('CHANGELOG.md')
if (changelog === null) fail('CHANGELOG.md 存在', '缺失')
else {
  const headings = [...changelog.matchAll(/^##\s*(.+)$/gm)].map(m => m[1].trim())
  const released = []
  for (const h of headings) {
    const m = h.match(/^\[?(\d+\.\d+\.\d+)\]?/)
    if (m) released.push(m[1])
  }
  const dupes = released.filter((v, i) => released.indexOf(v) !== i)
  if (!released.length) fail('CHANGELOG 含已发布版本标题', '未找到 ## [x.y.z] 形式标题')
  else ok('CHANGELOG 含已发布版本标题', released.length + ' 个: ' + released.join(', '))
  if (dupes.length) fail('CHANGELOG 版本标题无重复', '重复: ' + [...new Set(dupes)].join(', '))
  else ok('CHANGELOG 版本标题无重复')
  {
    const descending = released.every((v, i) => i === 0 || cmpVersion(released[i - 1], v) > 0)
    if (descending) ok('CHANGELOG 版本标题降序排列')
    else fail('CHANGELOG 版本标题降序排列', released.join(' > '))
  }
  if (version && released.length) {
    const top = released[0]
    if (top === version) ok('CHANGELOG 最新发布版本与 package.json 一致', version)
    else fail('CHANGELOG 最新发布版本与 package.json 一致', 'CHANGELOG 顶部发布版本 ' + top + ' ≠ package.json ' + version)
    if (released.includes(version)) ok('package.json 版本在 CHANGELOG 中有对应标题', version)
    else fail('package.json 版本在 CHANGELOG 中有对应标题', '缺少 ## [' + version + ']')
    const ahead = released.filter(v => cmpVersion(v, version) > 0)
    if (ahead.length) fail('CHANGELOG 无超前于 package.json 的发布版本', ahead.join(', '))
    else ok('CHANGELOG 无超前于 package.json 的发布版本')
  }
}

// —— 4. README 版本、项目名与 Node 下限声明 ——
const readme = readText('README.md')
if (readme === null) fail('README.md 存在', '缺失')
else {
  ok('README.md 存在')
  const title = (readme.match(/^#\s+(.+)$/m) || [])[1] || ''
  if (!title) fail('README 标题声明项目名与 package.json 一致', '未找到一级标题')
  else if (name && title.includes(name)) ok('README 标题声明项目名与 package.json 一致', title)
  else fail('README 标题声明项目名与 package.json 一致', JSON.stringify(title) + ' 未包含 ' + JSON.stringify(name))
  const claims = []
  for (const m of readme.matchAll(/model-gateway@(\d+\.\d+\.\d+)/g)) claims.push({ where: 'model-gateway@', v: m[1] })
  for (const m of readme.matchAll(/版本\s*(?:为|:|：)?\s*v?(\d+\.\d+\.\d+)/g)) claims.push({ where: '版本', v: m[1] })
  for (const m of readme.matchAll(/\bversion\s*[:=]?\s*v?(\d+\.\d+\.\d+)/gi)) claims.push({ where: 'version', v: m[1] })
  if (!claims.length) ok('README 版本声明与 package.json 一致', 'README 未声明版本号，无需比对')
  else {
    const bad = claims.filter(c => c.v !== version)
    if (bad.length) fail('README 版本声明与 package.json 一致', bad.map(c => c.where + c.v + ' ≠ ' + version).join('; '))
    else ok('README 版本声明与 package.json 一致', claims.map(c => c.where + c.v).join(', '))
  }
  const readmeFloor = readme.match(/Node(?:\.js)?\s*>=\s*(\d+)/i)
  const pkgFloorMatch = pkg && pkg.engines && typeof pkg.engines.node === 'string' ? pkg.engines.node.match(/^>=\s*(\d+)/) : null
  if (!readmeFloor) ok('README Node 下限声明与 engines 一致', 'README 未声明 Node 下限，无需比对')
  else if (!pkgFloorMatch) fail('README Node 下限声明与 engines 一致', 'engines.node 不是 >=N 形式，无法比对')
  else if (readmeFloor[1] === pkgFloorMatch[1]) ok('README Node 下限声明与 engines 一致', '>= ' + readmeFloor[1])
  else fail('README Node 下限声明与 engines 一致', 'README >= ' + readmeFloor[1] + ' ≠ engines ' + pkg.engines.node)
}

// —— 4b. README 运行时支持矩阵：当前支持与退役/未验收必须写实 ——
{
  const matrix = readText('README.md') || ''
  const heading = '运行时支持矩阵'
  if (!matrix.includes(heading)) fail('README 含「' + heading + '」小节', '未找到该小节标题')
  else ok('README 含「' + heading + '」小节')
  const rows = matrix.split('\n').filter(line => /^\|[^|]*\|[^|]*\|/.test(line.trim()))
  const rowOf = (needle) => rows.find(line => line.includes(needle)) || ''
  const linuxRow = rowOf('Linux')
  if (/24/.test(linuxRow) && /(当前支持|已实测|已验收)/.test(linuxRow)) {
    ok('README 支持矩阵：Linux + Node 24 标为当前支持/已实测')
  } else {
    fail('README 支持矩阵：Linux + Node 24 标为当前支持/已实测', linuxRow ? '实际行: ' + linuxRow.trim() : '未找到 Linux 行')
  }
  const windowsRow = rowOf('Windows')
  if (!windowsRow) fail('README 支持矩阵：Windows 标为未验收', '未找到 Windows 行')
  else if (/(未验收|未验证|NOT_RUN|未实测)/.test(windowsRow)) ok('README 支持矩阵：Windows 标为未验收')
  else fail('README 支持矩阵：Windows 标为未验收', '实际行: ' + windowsRow.trim())
  const retiredRow = rows.find(line => RETIRED_NODE_MAJORS.every(m => new RegExp('(^|[^0-9])' + m + '([^0-9]|$)').test(line)))
  if (!retiredRow) fail('README 支持矩阵：18/20/22 标为历史/退役', '未找到同时列出 ' + RETIRED_NODE_MAJORS.join('/') + ' 的行')
  else if (!/(已退役|历史|不再支持|未纳入当前支持)/.test(retiredRow)) fail('README 支持矩阵：18/20/22 标为历史/退役', '实际行: ' + retiredRow.trim())
  else if (/(当前支持|已实测|已验收)/.test(retiredRow)) fail('README 支持矩阵：18/20/22 不得标为当前支持', '实际行: ' + retiredRow.trim())
  else ok('README 支持矩阵：18/20/22 标为历史/退役', '不再列入当前支持')
  // 支持矩阵与 engines/CI 必须同代：README 的 Node 下限核对已在上方完成，这里再核对矩阵里出现的
  // 「当前支持」大版本都必须属于 SUPPORTED_NODE_MAJORS。
  const activeRows = rows.filter(line => /(当前支持|已实测|已验收)/.test(line) && /Node/.test(line))
  const activeMajors = new Set()
  for (const line of activeRows) for (const m of line.matchAll(/Node\s*(\d{2})/g)) activeMajors.add(Number(m[1]))
  const unexpected = [...activeMajors].filter(m => !SUPPORTED_NODE_MAJORS.includes(m))
  if (!activeMajors.size) fail('README 当前支持矩阵与 engines/CI 一致', '未解析出当前支持的大版本')
  else if (unexpected.length) fail('README 当前支持矩阵与 engines/CI 一致', '出现未实测大版本: ' + unexpected.join('/'))
  else ok('README 当前支持矩阵与 engines/CI 一致', [...activeMajors].map(m => 'Node ' + m).join(', '))
}

// —— 5. manifest.yaml（存在时）声明与 package.json 一致 ——
const manifest = readText('manifest.yaml')
if (manifest === null) ok('manifest.yaml 存在（可选）', '不存在，跳过 manifest 声明核对')
else {
  ok('manifest.yaml 存在（可选）', '已发现，核对声明')
  const manifestProject = yamlScalar(manifest, 'project')
  if (!manifestProject) fail('manifest.yaml project 与 package.json name 一致', '缺少顶层 project 字段')
  else if (name && manifestProject === name) ok('manifest.yaml project 与 package.json name 一致', manifestProject)
  else fail('manifest.yaml project 与 package.json name 一致', manifestProject + ' ≠ ' + (name || '(package.json name 缺失)'))
  const manifestVersion = yamlScalar(manifest, 'version')
  if (!manifestVersion) ok('manifest.yaml version 与 package.json 一致', 'manifest 未声明 version，无需比对')
  else if (manifestVersion === version) ok('manifest.yaml version 与 package.json 一致', manifestVersion)
  else fail('manifest.yaml version 与 package.json 一致', manifestVersion + ' ≠ ' + version)
  const enginesBlock = manifest.match(/^engines:\s*\n((?:[ \t]+[^\n]*\n?)*)/m)
  const manifestNode = enginesBlock ? ((enginesBlock[1].match(/^[ \t]+node:\s*["\x27]?([^"\x27\n]+)/m) || [])[1] || '').trim() : ''
  if (!manifestNode) ok('manifest.yaml engines.node 与 package.json 一致', 'manifest 未声明 engines.node，无需比对')
  else if (floorOf(manifestNode) && floorOf(manifestNode) === floorOf(pkg && pkg.engines && pkg.engines.node)) ok('manifest.yaml engines.node 与 package.json 一致', manifestNode)
  else fail('manifest.yaml engines.node 与 package.json 一致', manifestNode + ' ≠ ' + JSON.stringify(pkg && pkg.engines && pkg.engines.node))
}

// —— 6. CI workflow：触发方式、Node 矩阵、命令与零下载 ——
const workflow = readText('.github/workflows/check.yml')
if (workflow === null) fail('CI workflow 存在', '.github/workflows/check.yml 缺失')
else {
  ok('CI workflow 存在', '.github/workflows/check.yml')
  const matrixMatch = workflow.match(/^\s*node:\s*\[([^\]]*)\]/m)
  const majors = matrixMatch ? [...matrixMatch[1].matchAll(/\d+/g)].map(x => Number(x[0])) : []
  if (!majors.length) fail('CI 固定 Node 版本矩阵', '未在 check.yml 找到 node: [ ... ] 矩阵')
  else {
    ok('CI 固定 Node 版本矩阵', majors.join('/'))
    // 矩阵必须**等于**已实测支持矩阵：多列未验证版本 = 假绿，少列已实测版本 = 静默缩小门禁。
    const sameSet = majors.length === SUPPORTED_NODE_MAJORS.length && SUPPORTED_NODE_MAJORS.every(m => majors.includes(m))
    if (sameSet) ok('CI 矩阵等于已实测支持矩阵', majors.join('/'))
    else fail('CI 矩阵等于已实测支持矩阵', '矩阵 ' + majors.join('/') + ' ≠ 已实测 ' + SUPPORTED_NODE_MAJORS.join('/') + '（未验证版本不得留在矩阵里，也不得静默移除已实测版本）')
    if (majors.every(m => !RETIRED_NODE_MAJORS.includes(m))) ok('CI 矩阵不含已退役大版本', '不含 ' + RETIRED_NODE_MAJORS.join('/'))
    else fail('CI 矩阵不含已退役大版本', '矩阵出现了 ' + majors.filter(m => RETIRED_NODE_MAJORS.includes(m)).join('/'))
  }
  for (const trigger of ['push', 'pull_request', 'workflow_dispatch']) {
    if (new RegExp('^\\s{2}' + trigger + ':', 'm').test(workflow)) ok('CI 支持触发: ' + trigger)
    else fail('CI 支持触发: ' + trigger, '缺少 on.' + trigger)
  }
  if (/^\s{2}schedule:/m.test(workflow)) fail('CI 不按计划自动触发', '存在 schedule 触发器')
  else ok('CI 不按计划自动触发')
  if (/^\s{4}runs-on:\s*ubuntu-latest\s*$/m.test(workflow)) ok('CI 使用 ubuntu-latest', '固定 runner 类型')
  else fail('CI 使用 ubuntu-latest', '未找到 runs-on: ubuntu-latest')
  const commands = [
    ['语法检查', /npm run check\b/],
    ['离线测试', /(npm test\b|node scripts\/test\/run\.mjs)/],
    ['文档链接检查', /(npm run docs:check\b|node scripts\/check-docs\.mjs)/],
    ['元数据核对', /node scripts\/check-metadata\.mjs/]
  ]
  const missing = commands.filter(([, re]) => !re.test(workflow)).map(([label]) => label)
  if (missing.length) fail('CI 复用仓库既有检查命令', '缺少: ' + missing.join(', '))
  else ok('CI 复用仓库既有检查命令', commands.map(([label]) => label).join('/'))
  if (/npm ci|npm install|pnpm install|yarn install|actions\/setup-node/.test(workflow)) fail('CI 不下载依赖或工具链', '出现 npm ci/install 或 setup-node')
  else ok('CI 不下载依赖或工具链', '仅使用 runner 既有 node/npm')
}

// —— 汇总 ——
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.detail ? ' — ' + r.detail : ''))
const failed = results.filter(r => !r.ok).length
console.log('Metadata: ' + (failed ? 'FAIL (' + failed + '/' + results.length + ' failed)' : 'PASS (' + results.length + ' checks)'))
process.exitCode = failed ? 1 : 0
