// 用户级环境变量兜底的离线回归（Linux systemd user env / environment.d / 注入读取器）。
// 全部离线：注入假读取器 + OS 临时目录，不触碰真实注册表、~/.config/environment.d 或任何真实 Key。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveKey, readEnvironmentDir, __setUserEnvReaderForTest, __clearUserEnvCache } from '../../../src/router.js'

const ENV_NAME = 'MG_TEST_USERENV_ONLY_KEY'
const def = { baseUrl: 'http://127.0.0.1:1', apiKeyEnv: ENV_NAME }
const cfgWith = (apiKeyEnv) => ({ providers: { p: { baseUrl: 'http://127.0.0.1:1', apiKeyEnv } }, _keys: {} })

function reset() { __setUserEnvReaderForTest(null); __clearUserEnvCache() }

test('resolveKey 来源优先级：keys 存储 > 进程环境 > 用户级环境 > 无', () => {
  const prev = process.env[ENV_NAME]
  delete process.env[ENV_NAME]
  try {
    // 1) 三处都没有 → { key: '', source: null }
    __clearUserEnvCache()
    __setUserEnvReaderForTest(() => null)
    assert.deepEqual(resolveKey(cfgWith(ENV_NAME), def, 'p'), { key: '', source: null })
    // 2) 仅用户级环境命中 → env-registry（进程 env 无该变量）
    __clearUserEnvCache()
    __setUserEnvReaderForTest((name) => (name === ENV_NAME ? 'from-user-env' : null))
    assert.deepEqual(resolveKey(cfgWith(ENV_NAME), def, 'p'), { key: 'from-user-env', source: 'env-registry' })
    // 3) 进程环境存在 → env（优先于用户级环境）
    process.env[ENV_NAME] = 'from-process-env'
    assert.deepEqual(resolveKey(cfgWith(ENV_NAME), def, 'p'), { key: 'from-process-env', source: 'env' })
    // 4) keys 存储优先于一切
    const cfg = { providers: { p: def }, _keys: { p: 'from-keys-store' } }
    assert.deepEqual(resolveKey(cfg, def, 'p'), { key: 'from-keys-store', source: 'keys' })
  } finally {
    if (prev === undefined) delete process.env[ENV_NAME]; else process.env[ENV_NAME] = prev
    reset()
  }
})

test('用户级环境：60s TTL 正/负缓存与清缓存后可重查', () => {
  const prev = process.env[ENV_NAME]
  delete process.env[ENV_NAME]
  try {
    let current = 'v1'
    __clearUserEnvCache()
    __setUserEnvReaderForTest((name) => (name === ENV_NAME ? current : null))
    assert.equal(resolveKey(cfgWith(ENV_NAME), def, 'p').key, 'v1')
    current = 'v2'
    // TTL 内命中缓存：仍是旧值
    assert.equal(resolveKey(cfgWith(ENV_NAME), def, 'p').key, 'v1')
    __clearUserEnvCache()
    assert.equal(resolveKey(cfgWith(ENV_NAME), def, 'p').key, 'v2')
    // 负缓存：读取器返回 null 后同样走缓存，清缓存才会重查（避免每请求空查 systemctl）
    let hits = 0
    __clearUserEnvCache()
    __setUserEnvReaderForTest(() => { hits++; return null })
    assert.equal(resolveKey(cfgWith(ENV_NAME), def, 'p').source, null)
    assert.equal(resolveKey(cfgWith(ENV_NAME), def, 'p').source, null)
    assert.equal(hits, 1)
    __clearUserEnvCache()
    assert.equal(resolveKey(cfgWith(ENV_NAME), def, 'p').source, null)
    assert.equal(hits, 2)
  } finally {
    if (prev === undefined) delete process.env[ENV_NAME]; else process.env[ENV_NAME] = prev
    reset()
  }
})

test('变量名白名单：非法 apiKeyEnv 不查询用户级环境，也不抛错', () => {
  let calls = 0
  __clearUserEnvCache()
  __setUserEnvReaderForTest(() => { calls++; return 'should-not-be-used' })
  try {
    for (const bad of ['BAD NAME', 'foo;rm -rf /', '1LEADING']) {
      const cfg = cfgWith(bad)
      assert.deepEqual(resolveKey(cfg, cfg.providers.p, 'p'), { key: '', source: null }, 'apiKeyEnv=' + JSON.stringify(bad))
    }
    assert.equal(calls, 0, '白名单应在读取器之前拦截')
  } finally { reset() }
})

test('readEnvironmentDir：按文件名排序后者覆盖、注释与非法行忽略、缺失返回 null', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mg-envd-'))
  try {
    await writeFile(join(dir, '10-first.conf'), '# 注释\n' + ENV_NAME + '="first value"\n')
    await writeFile(join(dir, '20-second.conf'), ENV_NAME + '=second\nNOT_EQUAL_LINE\n' + ENV_NAME + 'X=ignore-me\n')
    await writeFile(join(dir, '99-empty.conf'), '# 只有注释\n')
    assert.equal(readEnvironmentDir(ENV_NAME, dir), 'second')
    assert.equal(readEnvironmentDir('MG_TEST_NOT_DEFINED_ANYWHERE', dir), null)
    assert.equal(readEnvironmentDir(ENV_NAME, join(dir, 'nope')), null, '目录不存在不抛错')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('readEnvironmentDir：双引号值还原内部转义（systemd 风格）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mg-envd2-'))
  try {
    await writeFile(join(dir, '10-quoted.conf'), ENV_NAME + '="a \\"q\\" b"\n')
    assert.equal(readEnvironmentDir(ENV_NAME, dir), 'a "q" b')
    await writeFile(join(dir, '20-plain.conf'), ENV_NAME + '=plain-value\n')
    assert.equal(readEnvironmentDir(ENV_NAME, dir), 'plain-value')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
