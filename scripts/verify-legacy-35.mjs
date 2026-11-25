#!/usr/bin/env node
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const SCHEMA = 'modelgate-legacy-35/1'
const ID_RE = /^L35-[0-9]{2}$/
const SAFE_FILE_RE = /^scripts\/test\/[A-Za-z0-9._/-]+\.(?:mjs|js)$/

function fail(code, message, details) {
  const error = new Error(message)
  error.code = code
  if (details) error.details = details
  return error
}

function plain(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function clean(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw fail('invalid_field', label + ' 必须是非空安全文本')
  }
  return value.trim()
}

function escapeReg(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function findTestMapping(source, testName) {
  const calls = /\b(?:test|it)(?:\.(?:only|skip))?\s*\(\s*(['"`])([^'"`]*?)\1/g
  let match
  while ((match = calls.exec(source))) {
    if (match[2] === testName) return source.slice(0, match.index).split('\n').length
  }
  return null
}

export function validateLegacy35Input(input, options = {}) {
  const root = options.root || ROOT
  const errors = []
  if (!plain(input) || input.schema !== SCHEMA) return { ok: false, code: 'schema_invalid', errors: ['schema 必须为 ' + SCHEMA] }
  if (!plain(input.source)) errors.push('缺少权威 source 元数据')
  else {
    try { clean(input.source.origin, 500, 'source.origin') } catch (error) { errors.push(error.message) }
    try { clean(input.source.sha256, 64, 'source.sha256') } catch (error) { errors.push(error.message) }
    if (!/^[a-f0-9]{64}$/.test(input.source.sha256 || '')) errors.push('source.sha256 必须是 SHA-256')
  }
  try { clean(input.originalCommand, 2000, 'originalCommand') } catch (error) { errors.push(error.message) }
  if (!Array.isArray(input.groups) || input.groups.length !== 2) errors.push('必须提供两个回归组定义')
  const groups = new Map()
  for (const [index, group] of (Array.isArray(input.groups) ? input.groups : []).entries()) {
    try {
      const id = clean(group?.id, 80, 'groups[' + index + '].id')
      const name = clean(group?.name, 200, 'groups[' + index + '].name')
      if (groups.has(id)) errors.push('回归组 ID 重复：' + id)
      if (!Array.isArray(group.assertionIds) || !group.assertionIds.length) errors.push('回归组必须列出 assertionIds：' + id)
      groups.set(id, { id, name, assertionIds: group.assertionIds })
    } catch (error) { errors.push(error.message) }
  }
  if (!Array.isArray(input.assertions) || input.assertions.length !== 35) errors.push('assertions 必须恰好包含 35 条')
  const assertions = []
  const ids = new Set()
  const covered = new Set()
  for (const [index, assertion] of (Array.isArray(input.assertions) ? input.assertions : []).entries()) {
    try {
      const id = clean(assertion?.id, 20, 'assertions[' + index + '].id')
      if (!ID_RE.test(id)) errors.push('断言 ID 必须为 L35-01..L35-35：' + id)
      if (ids.has(id)) errors.push('断言 ID 重复：' + id)
      ids.add(id)
      const name = clean(assertion.name, 300, id + '.name')
      const body = clean(assertion.body, 20000, id + '.body')
      const file = clean(assertion.mapping?.file, 300, id + '.mapping.file')
      const testName = clean(assertion.mapping?.testName, 500, id + '.mapping.testName')
      if (!SAFE_FILE_RE.test(file)) errors.push(id + ' 映射文件必须位于 scripts/test：' + file)
      const absolute = resolve(root, file)
      if (absolute !== resolve(root, file) || !absolute.startsWith(resolve(root) + sep)) errors.push(id + ' 映射路径越界')
      let mappingLine = null
      if (existsSync(absolute)) {
        try {
          const source = readFileSync(absolute, 'utf8')
          mappingLine = findTestMapping(source, testName)
          if (mappingLine === null) errors.push(id + ' 映射测试名称不在文件中：' + testName)
        } catch (error) { errors.push(id + ' 映射文件不可读：' + error.message) }
      } else errors.push(id + ' 映射文件不存在：' + file)
      if (!groups.size) errors.push(id + ' 无法归属回归组')
      for (const group of groups.values()) {
        if (group.assertionIds.includes(id)) {
          if (covered.has(id)) errors.push('断言被多个回归组重复覆盖：' + id)
          covered.add(id)
        }
      }
      assertions.push(Object.freeze({ id, name, body, file, testName, mappingLine, pattern: '^' + escapeReg(testName) + '$' }))
    } catch (error) { errors.push(error.message) }
  }
  for (let n = 1; n <= 35; n++) {
    const id = 'L35-' + String(n).padStart(2, '0')
    if (!ids.has(id)) errors.push('缺少断言：' + id)
  }
  for (const id of ids) if (!covered.has(id)) errors.push('断言未被两个回归组之一覆盖：' + id)
  for (const group of groups.values()) for (const id of group.assertionIds) if (!ids.has(id)) errors.push('回归组引用未知断言：' + id)
  if (errors.length) return { ok: false, code: 'authoritative_input_incomplete', errors: [...new Set(errors)] }
  return Object.freeze({ ok: true, schema: SCHEMA, originalCommand: input.originalCommand.trim(), source: Object.freeze({ ...input.source }), groups: Object.freeze([...groups.values()]), assertions: Object.freeze(assertions) })
}

export async function runLegacy35(input, options = {}) {
  const validated = validateLegacy35Input(input, options)
  if (!validated.ok) return validated
  const root = options.root || ROOT
  const execute = typeof options.execute === 'function' ? options.execute : (assertion) => spawnSync(
    process.execPath,
    ['--test', '--test-reporter=tap', '--test-name-pattern=' + assertion.pattern, assertion.file],
    {
      cwd: root, encoding: 'utf8', timeout: Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 120000,
      env: { ...process.env, NODE_OPTIONS: '' },
    },
  )
  const results = []
  for (const assertion of validated.assertions) {
    let run
    try { run = await execute(assertion, root) } catch (error) {
      results.push({ id: assertion.id, file: assertion.file, testName: assertion.testName, status: null, signal: null, passed: false, error: String(error && error.message || error), outputTail: '' })
      continue
    }
    const output = String(run.stdout || '') + String(run.stderr || '')
    const matches = output.split('\n').flatMap((line) => {
      const match = /^(ok|not ok)\s+\d+\s+-\s+(.*)$/.exec(line.trim())
      return match && match[2] === assertion.testName ? [{ ok: match[1] === 'ok', line }] : []
    })
    const passed = run.status === 0 && matches.length === 1 && matches[0].ok
    results.push({ id: assertion.id, file: assertion.file, testName: assertion.testName, status: run.status, signal: run.signal, passed, matchedAssertions: matches.length, outputTail: output.slice(-4000) })
  }
  const passed = results.filter((item) => item.passed).length
  return { ok: passed === 35, validated, results, summary: { total: 35, passed, failed: 35 - passed, notRun: 0 } }
}

function writeTemplate(outputPath) {
  const ids = Array.from({ length: 35 }, (_, index) => 'L35-' + String(index + 1).padStart(2, '0'))
  const template = {
    schema: SCHEMA,
    status: 'TEMPLATE_NOT_EVIDENCE',
    notice: 'Fill every field from the authoritative historical source. This template is intentionally invalid and cannot pass verification.',
    source: { origin: '', sha256: '' },
    originalCommand: '',
    groups: [
      { id: '', name: '', assertionIds: [] },
      { id: '', name: '', assertionIds: [] },
    ],
    assertions: ids.map((id) => ({ id, name: '', body: '', mapping: { file: '', testName: '' } })),
  }
  writeFileSync(outputPath, JSON.stringify(template, null, 2))
  return template
}

async function selfTest() {
  const mapping = { file: 'scripts/test/offline/v13-network-policy.test.mjs', testName: '网络策略：真实 localhost 使用 Promise DNS 并返回可固定地址' }
  const assertions = Array.from({ length: 35 }, (_, index) => ({ id: 'L35-' + String(index + 1).padStart(2, '0'), name: 'fixture-' + (index + 1), body: 'synthetic validator fixture; not product evidence', mapping }))
  const input = {
    schema: SCHEMA, source: { origin: 'fixture://validator', sha256: 'a'.repeat(64) }, originalCommand: 'node --test fixture',
    groups: [
      { id: 'g1', name: 'fixture group one', assertionIds: assertions.slice(0, 18).map((item) => item.id) },
      { id: 'g2', name: 'fixture group two', assertionIds: assertions.slice(18).map((item) => item.id) },
    ],
    assertions,
  }
  const ok = validateLegacy35Input(input)
  const missing = validateLegacy35Input({ ...input, assertions: assertions.slice(1) })
  const duplicate = validateLegacy35Input({ ...input, assertions: [...assertions.slice(0, 34), assertions[0]] })
  const escape = validateLegacy35Input({ ...input, assertions: [{ ...assertions[0], mapping: { ...mapping, file: '../outside.mjs' } }, ...assertions.slice(1)] })
  const unknownMapping = validateLegacy35Input({ ...input, assertions: [{ ...assertions[0], mapping: { ...mapping, testName: 'definitely missing test name' } }, ...assertions.slice(1)] })
  const template = writeTemplate(join(ROOT, '.legacy-35-self-test-template.json'))
  const templateRejected = !validateLegacy35Input(template).ok
  try { unlinkSync(join(ROOT, '.legacy-35-self-test-template.json')) } catch {}
  let executed = 0
  const run = await runLegacy35(input, { execute: (assertion) => {
    executed += 1
    return { status: 0, signal: null, stdout: 'TAP version 13\nok 1 - ' + assertion.testName + '\n1..1\n# pass 1\n', stderr: '' }
  } })
  const mismatch = await runLegacy35(input, { execute: () => ({ status: 0, signal: null, stdout: 'TAP version 13\nok 1 - different test\n1..1\n# pass 1\n', stderr: '' }) })
  const result = {
    ok: ok.ok && !missing.ok && !duplicate.ok && !escape.ok && !unknownMapping.ok && templateRejected && run.ok && executed === 35 && !mismatch.ok,
    checks: { exact35: ok.ok, missingRejected: !missing.ok, duplicateRejected: !duplicate.ok, traversalRejected: !escape.ok, unknownMappingRejected: !unknownMapping.ok, templateRejected, all35Executed: executed === 35 && run.summary.passed === 35, mismatchedTestRejected: !mismatch.ok && mismatch.summary.failed === 35 },
    fixtureOnly: true,
  }
  console.log(JSON.stringify(result, null, 2))
  return result.ok
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--self-test')) { process.exitCode = await selfTest() ? 0 : 1; return }
  const runIndex = args.indexOf('--run')
  const inputIndex = args.findIndex((arg) => arg.startsWith('--input='))
  const outputIndex = args.findIndex((arg) => arg.startsWith('--output='))
  const templateIndex = args.findIndex((arg) => arg.startsWith('--template='))
  const inputPath = inputIndex >= 0 ? args[inputIndex].slice('--input='.length) : ''
  const outputPath = outputIndex >= 0 ? args[outputIndex].slice('--output='.length) : ''
  const templatePath = templateIndex >= 0 ? args[templateIndex].slice('--template='.length) : ''
  if (templatePath) {
    writeTemplate(templatePath)
    console.log('TEMPLATE_NOT_EVIDENCE: ' + templatePath)
    process.exitCode = 0
    return
  }
  if (!inputPath) {
    const report = { schema: SCHEMA, status: 'BLOCKED_AUTHORITATIVE_INPUT_MISSING', required: ['source.origin', 'source.sha256', 'originalCommand', 'two groups', '35 assertions L35-01..L35-35', 'mapping.file and mapping.testName'], fabricated: false }
    if (outputPath) writeFileSync(outputPath, JSON.stringify(report, null, 2))
    console.error('BLOCKED_AUTHORITATIVE_INPUT_MISSING: 请提供 --input=<authoritative.json>；校验器不会生成替代断言')
    process.exitCode = 2
    return
  }
  let parsed
  try { parsed = JSON.parse(readFileSync(inputPath, 'utf8')) } catch (error) {
    console.error('AUTHORITATIVE_INPUT_UNREADABLE: ' + error.message)
    process.exitCode = 2
    return
  }
  const result = runIndex >= 0 ? await runLegacy35(parsed) : validateLegacy35Input(parsed)
  if (outputPath) writeFileSync(outputPath, JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result.ok ? { ok: true, assertions: result.assertions?.length || result.results?.length } : { ok: false, code: result.code, errors: result.errors }, null, 2))
  process.exitCode = result.ok ? 0 : 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main()
