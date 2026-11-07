# PR：ModelGate 网关 Responses 统一入口 · 尝试预算 / 429 归因 · 契约与离线验收

> 用途：本环境无 `gh`、GitHub API 凭据被平台拦截（MCP `fetch failed`），GitHub push option 未创建 PR。
> 分支已推送，请用下面链接一键开 PR，并粘贴本文件内容作为描述：
> https://github.com/xiaomengxizzh/model-gate/pull/new/dev/gateway-g0-g4-20261107

## 基线与范围

- base：`main@6bc6441`
- head：`dev/gateway-g0-g4-20261107`
- 独立 worktree：`workplace/idproject/model-gateway-dev`；未触碰生产 8787 / `config/` / 前端 worktree。

## 提交

1. `feat(g0)` 管理 API 契约 v1、协议兼容矩阵、11 份 fixtures、G0 审计
2. `feat(g1)` 单请求尝试预算、429 语义归因、非幂等不重放、全链路脱敏、configVersion 409
3. `feat(g2)` `/v1/responses` 一等入口、Codex SSE 事件契约、原生 Responses 直通、`upstreamModel`
4. `docs(g3-g4)` 能力契约、3 份 runbook、验收报告、82 断言证据
5. `docs(g4)` PR 描述与平台限制说明（本文件）

## 测试证据

```bash
npm run check          # 全部 src/*.js 语法检查
npm run test:offline   # 82 断言 / 0 失败
```

- G1 提交在干净 worktree 复跑：34/0
- G2 提交在干净 worktree 复跑：73/0
- 完整日志：`docs/audits/evidence/2026-11-07-offline-tests.log`
- 既有 `scripts/test/*.mjs`（依赖真实网关 + live 配置）：`NOT_RUN`（无 8787 实例，拒绝用生产配置跑）
- 真实 Codex/DSH/OpenCode Go：`NOT_RUN_LIVE`（无凭据/费用授权）

## 风险与阻断

- **B1**：本地 `main` 领先 `origin/main` 17 个未推送提交（约 900 行硬化修复），与远端分叉。本 PR 基于远端 main；合并前请 owner 决定先推送/审阅这些提交或明确放弃。
- **B2**：实机验收未完成，不应据本 PR 宣称「已兼容 Codex/OpenCode Go」。
- **B3**：PR #2（`feature/codex-opencode-go-adapter-20261107`）建议关闭；其转换器思路已独立重写吸收，且原实现绕过治理、无记账、SSE 顺序不完整。

## 回滚

`git revert <sha>` 或切回 `6bc6441` 后重启；无配置迁移、无新增依赖、无数据格式变更。

## 未发生的行为

无下载/安装/升级；无真实 API 费用；未修改生产配置；未向 `main` 推送；未合并 PR。
