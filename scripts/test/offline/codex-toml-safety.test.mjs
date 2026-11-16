// TOML 行级解析/合并安全回归（2026-11-16 审计 P0/P1/P2 修复锁定）。
// 纯函数离线：不触达真实 ~/.codex、不写盘。
//   1. 段头带行内注释不得导致重复段（旧 HEADER_RE 不识别 → 文末追加第二个 [features]）；
//   2. 疑似段头无法解析 → fail-closed，绝不静默当普通行；
//   3. 多行字符串/数组续行绝不被当作键值或段头改写；
//   4. 带注释的单行数组不误判为多行；
//   5. owned 行替换保留行内注释。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseConfigDocument, mergeOwnedFields, unmanagedFingerprint } from '../../../src/codex/config.js'

test('段头带行内注释：merge 原位更新，不产生重复段', () => {
  const before = [
    'model = "gpt-6-luna"',
    '',
    '[features] # 用户注释：多代理',
    'multi_agent = false',
    '',
    '[mcp_servers.x]',
    'command = "y"',
  ].join('\n')
  const res = mergeOwnedFields(before, { topLevel: {}, sections: { features: { multi_agent: true } } })
  const headers = res.text.split('\n').filter((l) => /^\s*\[features\]/.test(l))
  assert.equal(headers.length, 1, '不得追加第二个 [features] 段')
  assert.match(res.text, /\[features\] # 用户注释：多代理/, '段头注释逐字保留')
  assert.match(res.text, /multi_agent = true/)
  assert.equal(res.text.split('\n').filter((l) => l.trim() === 'multi_agent = false').length, 0)
  assert.match(res.text, /\[mcp_servers\.x\]/, '外部段保留')
})

test('疑似段头无法解析：fail-closed 拒绝改写', () => {
  const before = '[features] 额外文本\nmulti_agent = false\n'
  assert.throws(() => mergeOwnedFields(before, { sections: { features: { multi_agent: true } } }), (e) => e.code === 'toml_header_unparseable')
  assert.throws(() => parseConfigDocument('[broken\n'), (e) => e.code === 'toml_header_unparseable')
})

test('多行字符串内的伪键值行不被改写（续行按原文保留）', () => {
  const before = [
    'model = "gpt-6-luna"',
    'instructions = """',
    'model = "fake-inside-string"',
    '[features]',
    '"""',
    '',
    '[features]',
    'multi_agent = false',
  ].join('\n')
  const doc = parseConfigDocument(before)
  const fake = doc.meta.filter((m) => m.kind === 'entry' && m.key === 'model')
  assert.equal(fake.length, 1, '字符串内的 model= 不得被解析为键')
  const res = mergeOwnedFields(before, { topLevel: { model: 'mg-opencodego-deepseek-v4-1-flash' }, sections: { features: { multi_agent: true } } })
  assert.match(res.text, /model = "fake-inside-string"/, '多行字符串内容逐字保留')
  assert.equal(res.text.split('\n').filter((l) => l.trim() === '[features]').length, 2, '字符串内的伪段头不算段，真实段唯一')
  assert.match(res.text, /model = "mg-opencodego-deepseek-v4-1-flash"/)
  assert.equal(unmanagedFingerprint(before).includes('model = "fake-inside-string"'), true)
})

test('多行数组嵌套括号：续行正确闭合，内部 [ 行不触发段头错误', () => {
  const before = [
    'model = "m"',
    'matrix = [',
    '  [1,',
    '  2],',
    '  [3, 4],',
    ']',
    '',
    '[features]',
    'multi_agent = false',
  ].join('\n')
  const doc = parseConfigDocument(before)
  const entry = doc.meta.find((m) => m.kind === 'entry' && m.key === 'matrix')
  assert.equal(entry.multiline, true)
  const cont = doc.meta.filter((m) => m.kind === 'continuation')
  assert.equal(cont.length, 4, 'opening 之后 4 行续行')
  const res = mergeOwnedFields(before, { sections: { features: { multi_agent: true } } })
  assert.match(res.text, /multi_agent = true/)
  assert.match(res.text, /\[3, 4\],/, '数组内容逐字保留')
})

test('带行内注释的单行数组/值不误判为多行', () => {
  const doc = parseConfigDocument('a = [1, 2] # 注释\nb = { x = 1 } # 注释\nc = "str" # 注释\n')
  for (const key of ['a', 'b', 'c']) {
    const m = doc.meta.find((x) => x.kind === 'entry' && x.key === key)
    assert.equal(m.multiline, false, key + ' 是单行值')
  }
})

test('字符串字面量内的 # 不是注释', () => {
  const doc = parseConfigDocument('s = "a # b"\nt = """x # y"""\n')
  const s = doc.meta.find((x) => x.key === 's')
  assert.equal(s.multiline, false)
  assert.equal(doc.meta.filter((x) => x.kind === 'comment').length, 0)
})

test('owned 行替换保留行内注释', () => {
  const before = 'model = "old" # 我的备注\nmodel_provider = "openai"\n'
  const res = mergeOwnedFields(before, { topLevel: { model: 'new' } })
  assert.match(res.text, /model = "new" # 我的备注/)
  assert.equal(res.changed.length, 1)
  // 幂等：再次合并相同值不产生变更
  const res2 = mergeOwnedFields(res.text, { topLevel: { model: 'new' } })
  assert.equal(res2.changed.length, 0)
})

test('CRLF 文档合并保持 CRLF', () => {
  const before = 'model = "old"\r\n\r\n[features] # c\r\nmulti_agent = false\r\n'
  const res = mergeOwnedFields(before, { topLevel: { model: 'new' }, sections: { features: { multi_agent: true } } })
  assert.equal(res.text.includes('\r\n'), true)
  assert.equal(res.text.split('\n').filter((l) => l.includes('\r')).length, res.text.split('\n').length - 1)
})