// V2-01 / A3：原版 Codex Desktop 自动检测（只读文件 + 捆绑 Codex CLI 版本）。
// 全部使用 OS 临时目录描述真实 Linux 安装布局；不读真实 HOME、不执行真实 Desktop、不联网。
// 真实宿主只做只读勘察，不修改 ~/.codex 或用户运行中的 Codex。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detect } from '../../../src/codex/desktop-integration.js'

// 复刻真实宿主 /usr/lib/chatgpt 的布局：
//   ChatGPT（Electron 主体）· resources/codex（随包 CLI）·
//   resources/linux-package-metadata.json（产品版本 26.x）· version（运行时版本 157.x）
async function desktopFixture ({ productVersion = '26.1103.32239', runtimeVersion = '157.0.8103.39', bundledScript = '#!/bin/sh\necho "codex-cli 0.167.0-alpha.3.2"\n' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mg-v2-detect-'))
  const desktopDir = join(root, 'chatgpt')
  const resources = join(desktopDir, 'resources')
  await mkdir(resources, { recursive: true })
  const desktopPath = join(desktopDir, 'ChatGPT')
  await writeFile(desktopPath, '#!/bin/sh\nexit 99\n', { mode: 0o755 })
  const configPath = join(root, 'config.toml')
  await writeFile(configPath, 'model = "gpt-6-luna"\n')
  if (runtimeVersion !== null) await writeFile(join(desktopDir, 'version'), runtimeVersion + '\n')
  if (productVersion !== null) {
    await writeFile(join(resources, 'linux-package-metadata.json'), JSON.stringify({
      codexAppBrand: 'chatgpt',
      codexBuildFlavor: 'prod',
      version: productVersion,
    }))
  }
  if (bundledScript !== null) await writeFile(join(resources, 'codex'), bundledScript, { mode: 0o755 })
  return {
    root,
    desktopPath,
    configPath,
    cleanup: async () => { await rm(root, { recursive: true, force: true }) },
  }
}

test('原版 Desktop 检测：产品版本来自包元数据（纯文件读取），运行时版本单独保留', async (t) => {
  const f = await desktopFixture()
  t.after(f.cleanup)
  const r = detect({ configPath: f.configPath, desktopPath: f.desktopPath, disableExec: true, clientProbe: false })
  assert.equal(r.desktop.found, true)
  assert.equal(r.desktop.version, '26.1103.32239', '产品版本必须来自 linux-package-metadata.json')
  assert.equal(r.desktop.versionState, 'known')
  assert.equal(r.desktop.source, 'linux-package-metadata.json')
  assert.equal(r.desktop.versionKind, 'package-metadata')
  assert.equal(r.desktop.buildFlavor, 'prod')
  assert.equal(r.desktop.runtimeVersion, '157.0.8103.39')
  assert.equal(r.desktop.runtimeVersionSource, 'version')
  assert.equal(r.client.kind, 'desktop')
  assert.equal(r.client.desktopVersion, '26.1103.32239')
  assert.equal(r.client.versionEvidence.desktop.executed, false, '读取 Desktop 版本绝不能执行 GUI')
})

test('原版 Desktop 检测：捆绑 Codex CLI 自动定位并读出真实引擎版本', async (t) => {
  const f = await desktopFixture()
  t.after(f.cleanup)
  const r = detect({ configPath: f.configPath, desktopPath: f.desktopPath, disableExec: true, clientProbe: false })
  assert.equal(r.desktop.bundledCodex.found, true)
  assert.equal(r.desktop.bundledCodex.path, join(f.desktopPath, '..', 'resources', 'codex'))
  assert.equal(r.desktop.bundledCodex.version, '0.167.0-alpha.3.2', '预发布版本号必须完整保留')
  assert.equal(r.desktop.bundledCodex.versionState, 'known')
  assert.equal(r.bundledCli.version, '0.167.0-alpha.3.2')
  assert.equal(r.client.bundledCodexVersion, '0.167.0-alpha.3.2')
  assert.equal(r.client.versionEvidence.bundledCodex.executed, true)
})

test('原版 Desktop 检测：显式关闭捆绑 CLI 探测时如实标注 not_probed，不伪造版本', async (t) => {
  const f = await desktopFixture()
  t.after(f.cleanup)
  const r = detect({ configPath: f.configPath, desktopPath: f.desktopPath, probeBundledCodex: false, clientProbe: false })
  assert.equal(r.desktop.bundledCodex.found, true)
  assert.equal(r.desktop.bundledCodex.version, null)
  assert.equal(r.desktop.bundledCodex.versionState, 'not_probed')
  assert.equal(r.desktop.bundledCodex.source, 'disabled')
  assert.equal(r.client.versionEvidence.bundledCodex, null)
})

test('原版 Desktop 检测：没有包元数据时回落到 version 文件，并标注来源', async (t) => {
  const f = await desktopFixture({ productVersion: null, bundledScript: null })
  t.after(f.cleanup)
  const r = detect({ configPath: f.configPath, desktopPath: f.desktopPath, disableExec: true, clientProbe: false })
  assert.equal(r.desktop.version, '157.0.8103.39')
  assert.equal(r.desktop.source, 'version')
  assert.equal(r.desktop.versionKind, 'version-file')
  assert.equal(r.desktop.versionState, 'known')
  assert.equal(r.desktop.bundledCodex.found, false)
  assert.equal(r.desktop.bundledCodex.versionState, 'not_found')
})
