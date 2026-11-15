# ModelGate V2｜发布裁决（2026-11-15 收尾复核）

> 收尾复核基线：分支 `mg-codex-native`，HEAD `601381d4f662d99c8ca175203a91ca5f9d405b0b`；PR #7 仍为 **Draft**。
> 冻结目标以 [`v2-frozen-sha.txt`](v2-frozen-sha.txt) 为准：`12cf5d97a60f151af59c731e26b71245a50e5169`。
> 发布资格：**未放行**。`docs/evidence/v2-release-approvals.json` 的 `approvals` 仍为空；`npm run release:freeze` 应失败并列出七项待批，不代表 12 行状态表的历史真实证据状态已被清除。

## 1. 裁决摘要

V2 验收矩阵当前保留 12 行 `PASS_REAL`，但这些是各自**真实采集树上的历史证据状态**，不是“12 项均在冻结树完整复现”或“产品已签收”的声明。回执保留原始 `commitSha`，并以 `codeEquivalentFreeze` 指向最终冻结树；不得改写采集 SHA、审批文件、回执、状态矩阵、哈希或产品契约来让门禁通过。

发布阻断分项见下表；审批文件目前为空，PR #7 保持 Draft。

| 项目 | 当前事实 | 发布含义 |
| --- | --- | --- |
| V2 状态表 | 12 行仍显示 `PASS_REAL`，每行依据保留真实采集 SHA 与最终冻结 SHA | 这是矩阵的历史证据状态；不能据此推导冻结树上所有子用例均已复现 |
| 冻结目标 | `12cf5d97a60f151af59c731e26b71245a50e5169` | 冻结检查器以此作为 `codeEquivalentFreeze` 目标 |
| 代码等价映射 | `1a527c6e0d3217ee008ed7da950e4f297acda604 → 12cf5d97a60f151af59c731e26b71245a50e5169`；`51e78e0da66846de0b28d2904dc5216685fc5732 → 12cf5d97a60f151af59c731e26b71245a50e5169` | 前者覆盖 11 条回执，后者覆盖 R011。检查器按 `freeze-equivalence` 的 `id` 与**完整采集 SHA**匹配；审批记录还须由所有者/A5 人工核对 `from`、`to` 和签收依据。当前没有此类审批 |
| R006 | 四项 `partialCases`：`native-compaction`、`post-compact-followup`、`context-proof`、`resume` | 仍须逐项批准或在冻结树重测；不能称 R006 已关闭 |
| R009 | 回执为条件状态：`owner-approval:two-instance-installation-isolation`；证据形态为双实例隔离 | 需 `requirement-form` 审批确认该验收形态。它不证明单实例多租户已实现；该能力仍是已知 GAP |
| 发布状态 | 审批 JSON 是空数组 | `release:freeze` 阻断；PR #7 仍 Draft，未获准转 Ready、合并或发布 |

## 2. 冻结与采集树核对

- 冻结目标从 `docs/evidence/v2-frozen-sha.txt` 读取，为 `12cf5d97a60f151af59c731e26b71245a50e5169`。
- 当前 11 份回执的 `commitSha` 为 `1a527c6e0d3217ee008ed7da950e4f297acda604`；R011 的真实采集 SHA 为 `51e78e0da66846de0b28d2904dc5216685fc5732`。回执中的 `codeEquivalentFreeze` 均指向 `12cf5d9…`。
- 两个来源到冻结目标的差异不能笼统描述为“之后只有文档”：复核显示两段区间的生产 `src/` 与 `bin/` 相同；`51e78e0..12cf5d9` 仍修改了 `scripts/test/offline/aggregation-freeze-check.mjs`，即 R011 涉及验证器自身变化。检查器会阻止 `src/**` 改动，但脚本变化仍须在审批/签收时人工审阅。`1a527c6..12cf5d9` 也包含后续测试、门禁及文档变化。具体文件以相应 `git diff --name-status <from>..<to>` 为准。
- R006 三项原生压缩成功证据（`native-compaction`、`post-compact-followup`、`context-proof`）来自 `3116459899c17b811300995986a88de67ee50051`。在 `1a527c6e0d3217ee008ed7da950e4f297acda604` 的冻结树复核中，三次尝试均未触发压缩；`resume` 创建了新子代理，未证明复用同一 `childId`。最终冻结树 `12cf5d9…` 上没有真实请求/付费重测。冻结树复核还确认工具/同子追派/中断/去重口径；四项 partial 仍不可升级为最终冻结树完整通过。详情见[冻结树复核](aggregation-v2-freeze-rerun-2026-11-15.md)。
- R006 矩阵行维持 `PASS_REAL` 是采集回执和矩阵的历史状态展示，附带四项 partial 限定；它不等于 R006 发布条件满足，也不替代所有者/A5 对 partial 的审批。

## 3. 门禁和本轮验证记录

本轮集成 HEAD `601381d4f662d99c8ca175203a91ca5f9d405b0b` 的已执行结果由主代理报告如下：

| 命令 | 结果 |
| --- | --- |
| `npm run check` | PASS |
| `npm run docs:check`（运行前 103 files） | PASS |
| `node scripts/check-metadata.mjs` | PASS（39 checks）|
| `npm run contract:check` | PASS |
| `npm run gate:v2` | PASS（9/9）|
| `npm run gate:v2:independent` | PASS（12/12）|
| `node scripts/test/offline/aggregation-matrix-v2.js --check` | PASS（byte-identical）|
| `npm run gate:audit-diff -- --base origin/main --all-commits` | PASS（399 commits、0 未批准 findings）|
| `npm run release:freeze` | **预期 FAIL**；空审批文件下只列 7 项待批准，不应通过修改回执/审批/矩阵/哈希消除阻断 |
| `npm test` | PASS（Node v24.22.2；119 suites、1,135 tests passed、0 failed、2 skipped；79.3s）|
| UI 回归 | PASS：四个套件（`agg-desktop-ui`、`agg-desktop-activate`、`agg-desktop-rollback`、`agg-tenant-isolation`）34/34；Chrome 临时 profile + HTTP 409 fixture 真实加载 `aggregation.js`，显示 base/ours/theirs SHA、增删行及手工合并指引，点击退出后只发一个 deactivate POST，无上游调用或配置写入 |

该验证清单区分门禁迁移/静态和离线结果与发布资格。`PASS` 的开发检查不会覆盖尚未签收的真实验收限定，也不会自动批准发布。

## 4. 未关闭项与边界

1. `release:freeze` 的代码匹配键是 `id=<完整真实采集 SHA>`；审批人须人工核对每组映射的 `from`/`to`、差异与签收含义。空审批文件表示当前没有批准，不代表以后不能按授权流程写入批准。
2. R009 当前有双实例配置/凭据/日志隔离证据，不代表单实例多租户 UI/后端隔离已交付；原始回执所列 token rotation 未执行。本轮独立复核与主进程均用 [Node 隔离夹具](../../scripts/test/offline/harness.mjs) 启动双实例和回环 mock，使用合成 Key 测试网关客户端密钥轮换。A 管理员更新本实例 Key 后，A 新 Key 返回 200、旧 Key 返回 401，B 自有 Key 仍返回 200 且 B 配置逐字节一致。9 项状态断言通过，共 4 次回环上游请求。历史回执维持原记录，真实账号凭据轮换仍未验证。
3. 所有者已批准 N04 历史迁移导出的书面例外，边界见[产品契约](../product/2026-11-14-owner-scope-v2.md)。该例外不替代本裁决表中的其他发布审批，也不改变 R006 口径。
4. 本轮浏览器回归使用本地夹具，真实上游请求为零。原生 Codex Desktop 和真实供应商路径的验收依据仍见历史回执。
5. PR #7 仍 Draft。转 Ready、合并 main、发版均未完成。

## 5. 证据索引

- [V2 当前状态表](aggregation-v2-status-2026-11-15.md)与[验收矩阵](aggregation-acceptance-matrix-v2.md)：12 行状态及真实采集树依据。
- [回执](aggregation-v2-receipts-2026-11-15.json)、[冻结 SHA](v2-frozen-sha.txt)、[发布审批文件](v2-release-approvals.json)：发布脚本的直接输入；审批文件为空。
- [发布冻结检查器](../../scripts/test/offline/aggregation-freeze-check.mjs)：代码等价映射、partial、条件通过及冻结树校验规则。
- [冻结树复核](aggregation-v2-freeze-rerun-2026-11-15.md)：哪些用例在最终冻结树复现、哪些沿用更早的采集。
- [R008/R009 真机证据](aggregation-v2-r008-r009-2026-11-15.md)：双实例隔离证据及边界。
