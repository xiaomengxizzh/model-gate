# 收据索引（Codex Multi-Agent V2 验收）

本目录存放 MG-017 客户端验收收据。规则与判据见[验收矩阵](../2026-11-12-codex-v2-acceptance.md) §9；模板见[codex-v2-receipt-template.md](codex-v2-receipt-template.md)。

| 收据 | 阶段 | 客户端 | 结论 | 说明 |
| --- | --- | --- | --- | --- |
| [2026-11-12-codex-v2-offline-stage.md](2026-11-12-codex-v2-offline-stage.md) | `OFFLINE` | none | 不可判定等级（全部真实用例 `BLOCKED_PENDING_AUTHORIZATION`） | 基线回归 + 离线组件断言 + Lead 的 Phase B（原版 CLI → 隔离网关 → 两 mock 上游，mock 级）；**不含真实上游** |

## 命名与状态约定

- 文件名：`<YYYY-MM-DD>-codex-v2-<阶段>-<client>.md`，阶段 ∈ `offline` / `component` / `real`。
- 状态只用五态枚举：`NOT_EXECUTED`、`BLOCKED_PENDING_AUTHORIZATION`、`EXECUTED_PASS`、`EXECUTED_FAIL`、`EXECUTED_PARTIAL`。
- `OFFLINE`/`COMPONENT` 收据不得被引用为「真实验收通过」；mock / HTTP 200 / 纯文本 / UI 截图 / 历史 MG-015 smoke 均不构成真实证据。
- 每份收据必须带：时间、版本 + 二进制 `sha256`、隔离目录与目录指纹、授权块、逐用例状态、脱敏声明、结论（等级 + 未验证项 + 下一步）。

> 本文件是**索引页**，不是收据；它同时给文档链接提供一个可解析的文件目标（`check-docs` 不接受目录链接）。
