// 发布元数据一致性核对（离线、零第三方依赖、不联网）。
//   node scripts/check-metadata.mjs
// 核对项：package.json 版本/许可/engines、LICENSE 实际文件与 license 字段、
//         CHANGELOG 版本标题、README 的版本与 Node 下限声明、CI 版本矩阵与 engines 下限。
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

const semver = v => /^\d+\.\d+\.\d+$/.test(String(v))
const cmpVersion = (a, b) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i]
  return 0
}

// —— 1. package.json ——
let pkg = null
const pkgRaw = readText('package.json')
if (pkgRaw === null) fail('package.json 存在', '缺失')
else {
  try { pkg = JSON.parse(pkgRaw); ok('package.json 可解析') } catch (e) { fail('package.json 可解析', e.message) }
}
const version = pkg && typeof pkg.version === 'string' ? pkg.version : ''
if (pkg) {
  if (semver(version)) ok('package.json version 为 x.y.z', version)
  else fail('package.json version 为 x.y.z', JSON.stringify(pkg.version))
  const licenseId = typeof pkg.license === 'string' ? pkg.license.trim() : ''
  if (licenseId) ok('package.json license 字段存在', licenseId)
  else fail('package.json license 字段存在', '缺失或非字符串')
  const nodeFloor = pkg.engines && typeof pkg.engines.node === 'string' ? pkg.engines.node.trim() : ''
  if (/^>=\s*\d+/.test(nodeFloor)) ok('package.json engines.node 声明下限', nodeFloor)
  else fail('package.json engines.node 声明下限', JSON.stringify(pkg.engines === undefined ? null : pkg.engines.node))
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

// —— 4. README 版本与 Node 下限声明 ——
const readme = readText('README.md')
if (readme === null) fail('README.md 存在', '缺失')
else {
  ok('README.md 存在')
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

// —— 5. CI 版本矩阵与 engines 下限 ——
const workflow = readText('.github/workflows/check.yml')
if (workflow === null) fail('CI workflow 存在', '.github/workflows/check.yml 缺失')
else {
  const matrixMatch = workflow.match(/^\s*node:\s*\[([^\]]*)\]/m)
  const majors = matrixMatch ? [...matrixMatch[1].matchAll(/\d+/g)].map(x => Number(x[0])) : []
  if (!majors.length) fail('CI 固定 Node 版本矩阵', '未在 check.yml 找到 node: [ ... ] 矩阵')
  else {
    ok('CI 固定 Node 版本矩阵', majors.join('/'))
    const floorMatch = pkg && pkg.engines && typeof pkg.engines.node === 'string' ? pkg.engines.node.match(/^>=\s*(\d+)/) : null
    if (!floorMatch) fail('CI 矩阵覆盖 engines 下限', 'engines.node 无法解析为 >=N')
    else if (majors.includes(Number(floorMatch[1]))) ok('CI 矩阵覆盖 engines 下限', '包含 ' + floorMatch[1])
    else fail('CI 矩阵覆盖 engines 下限', '矩阵 ' + majors.join('/') + ' 未包含 engines 下限 ' + floorMatch[1])
  }
  if (/workflow_dispatch/.test(workflow)) ok('CI 支持手动触发（workflow_dispatch）')
  else fail('CI 支持手动触发（workflow_dispatch）', '缺少 workflow_dispatch')
  if (/^\s{2}(push|pull_request|schedule):/m.test(workflow)) fail('CI 不自动触发', '存在 push/pull_request/schedule 触发器')
  else ok('CI 不自动触发', '无 push/pull_request/schedule 触发器')
  if (/npm ci|npm install|pnpm install|yarn install|actions\/setup-node/.test(workflow)) fail('CI 不下载依赖或工具链', '出现 npm ci/install 或 setup-node')
  else ok('CI 不下载依赖或工具链', '仅使用 runner 既有 node/npm')
}

// —— 汇总 ——
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.detail ? ' — ' + r.detail : ''))
const failed = results.filter(r => !r.ok).length
console.log('Metadata: ' + (failed ? 'FAIL (' + failed + '/' + results.length + ' failed)' : 'PASS (' + results.length + ' checks)'))
process.exitCode = failed ? 1 : 0
