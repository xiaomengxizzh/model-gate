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
4. `docs(g3-g4)` 能力契约、3 份 runbook、验收报告、离线证据
5. `docs(g4)` PR 描述与平台限制说明（本文件）
6. `merge` 合并本地 main 17 个未推送硬化提交 + 冲突解决 + 合并回归测试
7. `feat(g2)` Codex 0.167 兼容（namespace 展开、web_search 省略）+ 真实 Codex CLI 实机验收

## 测试证据

```bash
npm run check          # 全部 src/*.js 语法检查
npm run test:offline       # 96 断言 / 0 失败（含合并回归）
npm run test:codex-client # 真实 Codex CLI 9/9（mock 上游，零费用）
MG_GW=http://127.0.0.1:8788 node scripts/test/run.mjs  # 隔离 8788：125/125，6 SKIP
```

- 合并前 G1 提交在干净 worktree 复跑：34/0；G2 提交：73/0
- 隔离 8788 集成日志：`docs/audits/evidence/2026-11-07-integration-8788.log`
- Codex 实机日志：`docs/audits/evidence/2026-11-07-codex-client.log`
- 完整日志：`docs/audits/evidence/2026-11-07-offline-tests.log`
- 既有 `scripts/test/*.mjs`（依赖真实网关 + live 配置）：`NOT_RUN`（无 8787 实例，拒绝用生产配置跑）
- 真实 Codex/DSH/OpenCode Go：`NOT_RUN_LIVE`（无凭据/费用授权）

## 风险与阻断

- ~~**B1**：本地 main 17 个未推送提交与远端分叉~~ → **已解决**：17 个提交已推送到 `dev/gateway-hardening-20261107` 并合入本分支，冲突解决保留双方语义。
- **B2**：真实厂商（Codex/DSH/OpenCode Go 接真实上游）仍 `NOT_RUN_LIVE`：本机无凭据注入、生产 keys 加密私密不读取、DSH `~/.dsh` 只读。客户端协议兼容已用真实 Codex 进程 + mock 上游验证（9/9），但不得据此宣称真实厂商可用。
- **B3**：PR #2（`feature/codex-opencode-go-adapter-20261107`）建议关闭；其转换器思路已独立重写吸收，且原实现绕过治理、无记账、SSE 顺序不完整。

## 回滚

`git revert <sha>` 或切回 `6bc6441` 后重启；无配置迁移、无新增依赖、无数据格式变更。

## 未发生的行为

无下载/安装/升级；无真实 API 费用；未修改生产配置；未向 `main` 推送；未合并 PR。
