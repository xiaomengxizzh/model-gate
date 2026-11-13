# G8 发布整合准备（2026-11-13，未合并/未 push）

状态：**准备完成，等待所有者批准**。本文件只给事实、方案与回滚，不代替批准。

## 1. 待整合对象

| 对象 | SHA | 说明 |
| --- | --- | --- |
| `origin/main` | `6bc6441` | 当前主干 |
| `origin/integration/modelgate-release` | `c6d97da` | 相对 main ahead **246** / behind **0**；merge-base = main |
| `feat/modelgate-native-delegation-20261113` | 本分支 | release + 方案文档 + G1 退役 + MCP 委派 + SSE 回归 + 文档 |

## 2. 整合形态

因为 merge-base 就是 main 的头，release **不含**与 main 的分叉，所以：

- release → main 属于 **fast-forward 语义**，不存在内容冲突。
- 本分支 → release 也是 fast-forward（本分支以 release+方案 为父）。
- 因此整合的真实风险不是"冲突解决"，而是**一次性审阅面过大**（310 文件 / +64960 −1419）。

## 3. 建议步骤（需所有者逐步批准）

1. **只读审阅**：按目录分组看 `src/`（61 文件）与 `package.json`/`bin/`；`scripts/`(133) 与 `docs/`(106) 可抽查。
2. **CI 先行**：在 PR 上跑既有四门禁（`npm run check` / `npm test` / `npm run docs:check` / `check-metadata`），不新增 CI 依赖。
3. **PR**：base `main` ← head `feat/modelgate-native-delegation-20261113`（或先 `integration/modelgate-release`，再单独 PR 本轮增量）。**不直接合并 Draft PR #5/#6**。
4. **合并**：所有者批准后按 fast-forward 或 merge 提交；合并后立刻跑一次四门禁 + 冒烟启动（非 8787）。
5. **发布**：不在本轮范围。

## 4. 回滚

| 层级 | 动作 |
| --- | --- |
| 单个阶段 | `git revert` 对应 G1 / MCP / G5 提交（均为独立 commit/merge） |
| 本轮整体 | 从 `dc7d15f` 重置本分支；release 与 main 未动，天然回滚 |
| 运行期 | `gatewaySubscription` 已退役为 403 fail-closed，无新增开关需要关闭；MCP 服务默认不启动，删除 MCP 登记即完全退出 |
| 数据 | 删除 `<config>/mcp/` 即可（纯派生任务状态，无迁移需求） |

## 5. 未做（明确）

- 未 push、未开 PR、未合并 main、未打 tag、未部署。
- 未触碰生产 8787、systemd、所有者日常 Codex 配置与 Desktop 配置。
