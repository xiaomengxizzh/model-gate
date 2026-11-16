# 部署记录｜2026-11-16 审计修复上生产（main a36880d）

> 文档类型：**部署与生产冒烟证据**。不是真实长会话/父子派单/原生压缩的 PASS_REAL 证明。
> 授权：所有者本轮指令"严格审计并解决这些问题，解决所有问题后合并所有支线并进行 git push"。

## 1. 合并与推送

- `main`：`6bc6441 → a36880d`（快进推送 origin）。包含审计修复分支 `fix/modelgate-codex-audit-20261116`（39c074b，已推送）与全部支线合并。
- 支线处置：内容合并（docs/证据/SSE 测试抢救）、补丁等价 no-op 合并、已被取代支线 `-s ours` 保留历史（含 archive/* 8 条）；所有本地与远端分支均为 main 祖先（逐一 `merge-base --is-ancestor` 核验）。
- 合并后 main 门禁：`npm test` **133 suites / 1282 tests / 0 failed / 3 skipped**；check / contract:check / docs:check / gate:v2 / gate:v2:independent / check-metadata 全 exit 0；`gate:audit-diff --base e7463857` PASS。

## 2. 生产切换

- 生产工作树 `deploy/modelgate-ux-v3` 快进 `9a371d3 → a36880d`（= main）。切换前未提交 src 改动已验证与 ws-bridge 分支逐字一致（内容在 git 历史），补丁备份 `/tmp/prod-uncommitted-backup-20261116.patch`；未跟踪 tray 文件已入库（39c074b）。
- `systemctl --user restart model-gateway.service` → active；`/healthz` = ok；`needAuth=false`（所有者要求保持）。

## 3. 运行期产物更新（零网络、零付费）

- 聚合目录：用现有磁盘快照重发布 **generation 6 → 7**（12 模型不变）。Go 条目修正：`shell_type:"unified_exec"`、effort `low/high`（default high）、`context_window 1000000`、`auto_compact_token_limit 943718`。回滚锚点：generation 6（`catalog.rollback('local','prev')`）。
- `~/.codex/go-deepseek.toml`：effort 已为 high（与目录一致）；canonical 字节重写前备份 `go-deepseek.toml.bak-before-effort-high-20261116`。
- `~/.codex/config.toml` **未触碰**（model=gpt-6.1-sol 为用户当前选择；openai 身份/base_url/目录路径不变）。
- 目录发布告警 `catalog_warnings`：官方模型未声明网关侧压缩归属（官方走后端原生远程压缩，预期行为，非阻断）。

## 4. 生产冒烟（零上游调用）

| 项 | 结果 |
| --- | --- |
| `POST /v1/responses` 无状态续轮（未知 previous_response_id） | **400 `continuation_state_missing`**（新代码生效，零上游） |
| WS 握手 `GET /v1/responses` upgrade | **101 + Sec-WebSocket-Accept**（桥挂载正常） |
| 日志 | `responses continuation state missing reason=continuation_state_missing`（仅结构诊断） |

## 5. 待所有者复验（需真实额度/授权，本轮未执行）

1. Codex Desktop 多轮长会话上下文保真（续轮重建的核心场景）。
2. luna→Go 父子派单 + 子代理 shell 工具（目录已声明 unified_exec）。
3. 原生压缩：Go 子线程受 openai 身份 provider 级 remote_compaction 约束（见审计证据 §4.2），需所有者裁决子代理 provider 方案。
4. 真实会话验证前不要改回旧目录；回滚用 generation 6 + 服务回退 `git checkout 9a371d3`（备份在 .agents/deploy-backup-*）。