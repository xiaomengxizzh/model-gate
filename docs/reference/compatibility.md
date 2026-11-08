# 版本与平台兼容矩阵

本页区分**声明**、**本地已验证**和**未执行**三种状态，不把配置好的 CI 当成已经跑绿的证据。

## 声明

| 项 | 声明 | 出处 |
| --- | --- | --- |
| Node.js 下限 | >= 18 | `package.json` → `engines.node`；README 同口径 |
| 运行时第三方依赖 | 无 | `package.json` 无 `dependencies` / `devDependencies`；源码只用 `node:` 内置模块 |
| 模块形态 | ESM（`"type": "module"`） | `package.json` |
| 许可 | MIT | `package.json` 的 `license` 与 [LICENSE](../../LICENSE) 实际文件 |
| CI 版本矩阵 | 18 / 20 / 22，仅 `workflow_dispatch` 手动触发 | [.github/workflows/check.yml](../../.github/workflows/check.yml) |

`scripts/check-metadata.mjs` 会强制核对“CI 矩阵必须包含 `engines` 下限”，改一处忘另一处会以非 0 退出码失败。

## 已验证 / 未验证

| Node | Linux x86_64 | Windows | macOS | 依据 |
| --- | --- | --- | --- | --- |
| 18 | 未执行 | 未验证 | 未验证 | 静态审计无阻碍项；本机无该版本，未下载 |
| 20 | 未执行 | 未验证 | 未验证 | 同上 |
| 22 | 未执行 | 未验证 | 未验证 | 同上 |
| 24 | **本地执行通过** | 未验证 | 未验证 | 2026-11-08 本机 `node v24.22.2`：语法/文档/元数据全绿，离线套件 11/11 通过 |

- “未执行”不等于失败：本机只装了 Node 24，按[资源门禁](../../RESOURCE_APPROVAL.md)不得为验收自行下载其它 Node 版本。
- **GitHub Actions 远程执行：未远程执行（NOT_RUN）**。工作流只在手动 dispatch 时运行，本轮没有触发，也不声称 CI 已通过。
- Windows/macOS 需要各自宿主：Windows 侧还涉及 `start.bat`、`mg-tray.cs`（csc 编译）等本机组件，不在本轮范围。

## 本地验证证据（2026-11-08）

环境：Linux x86_64，`node v24.22.2`，`npm 11.19.1`，仓库分支 `dev/gateway-audit-20261108`。

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 语法 | `npm run check` | 退出码 0 |
| 离线套件 | `npm test` | 2026-11-08 23:56 `Isolated suites: 11/11 passed`，退出码 0（只跑本地 mock，无真实上游）；23:31 基线为 8/8，套件被并行任务增改，数量以执行时为准 |
| 文档链接 | `npm run docs:check` | `Documentation paths: PASS` |
| 元数据 | `node scripts/check-metadata.mjs` | `Metadata: PASS (21 checks)` |
| 生命周期 | 隔离目录 + 端口 8792 启动/停止/重启 | `/healthz` ok；SIGTERM 退出状态 143；重启后 `configVersion` 保持；端口释放 |

操作细节与判据见[安装、升级与回滚](../how-to/deploy-and-rollback.md)。

## 静态审计（为什么认为 18 能跑，但没有实跑）

- `src/` 只 import `node:http`、`node:https`、`node:tls`、`node:net`、`node:zlib`、`node:fs`、`node:path`、`node:url`、`node:os`、`node:crypto`，全部是长期稳定的内置模块。
- 检索未发现 Node 20+ 才有的运行面 API（`import.meta.dirname`、`Object.groupBy`、`Array.prototype.toSorted/toReversed`、`Array.fromAsync`、`process.getBuiltinModule`），也没有 `structuredClone` / `AbortSignal.timeout/any` 依赖。
- 测试侧依赖 `node --test`（18 起可用）与全局 `fetch`（18 起稳定），这正是 `engines >= 18` 的实际理由；Node 16 不在支持范围。
- 静态审计只排除“明显不可能跑”的版本，不能替代在 18/20/22 上的真实执行。

## 平台与端口

- 绑定地址默认回环；设置 `server.host`/`server.port` 才对外。生产默认 8787 属于本机部署，仓库不证明其在线。
- 面板是同一进程提供的静态页面，需要现代浏览器（ES2020 级）；未做浏览器矩阵验证，也没有在浏览器里做真实鉴权/保存回读验收。

## 维护规则

1. 改 Node 下限：同步 `package.json` `engines.node`、README 的 Node 声明、CI 矩阵、本页，四处一致。
2. 新增 CI 目标版本：改 `.github/workflows/check.yml` 的 `matrix.node`，并确认 runner 镜像已预装该版本——工作流**不下载**工具链，缺版本时显式失败而不是静默降级。
3. 只有真正跑过远程 CI 或其它平台后，才能把对应格改成“已验证”，并附日期、运行时版本与结果。
