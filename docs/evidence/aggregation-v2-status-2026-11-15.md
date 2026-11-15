# ModelGate V2 当前验收状态（Go DeepSeek 单模型 + Codex 原生压缩）

> 本文件是 V2 门禁（`scripts/test/offline/aggregation-gate-v2.js`）的状态输入，**不是**任何能力的自证。
> 它只搬运事实：每条状态来自对应证据文档，冲突必须显式写 `取代 <旧状态> @ <旧文档路径>`，否则 V2 矩阵生成失败。
> 历史 V1 状态与矩阵（`docs/evidence/aggregation-acceptance-matrix.md`）保持逐字节不变，仅作溯源。

被测树 SHA：`9db5ed11a557d30203b661d8002a98f61c0e6031`

> 上面这行是 **V2 门禁迁移基线**（P00 起点），不是任何 `PASS_REAL` 的绑定树。每条 `PASS_REAL` 的真实绑定 SHA 在下表「依据」列内单独写明；门禁按实际 HEAD 判定 `stale_evidence`，旧树回执不得继承。

## 1. 本轮边界（先于状态）

- 本轮只做 V2 门禁迁移与代码修复；**未发起**任何真实 Codex Desktop、真实 GPT 或真实 OpenCode Go 推理请求（无所有者的额度/时间窗授权）。
- Codex 真实 GPT 测试只允许 `gpt-6-luna`；没有额度就记 `BLOCKED`，不换型号、不自动回退。
- 已知核心阻断：Codex 原生压缩触发时，历史实现返回 `unsupported_input_item`（compaction）。V2 不接受“调大窗口避开压缩”“网关自建摘要”“删除 compaction item 后假成功”作为通过。

## 2. 需求状态

| 需求 | 状态 | 依据 |
| --- | --- | --- |
| MG-R001 | `PASS_MOCK` | 一键接入/退出、写前预览、409 冲突、回滚均有离线测试（`agg-desktop-activate.test.mjs`、`agg-desktop-rollback.test.mjs`、`agg-desktop-ui.test.mjs`）；V2 当前树未在真实 Desktop 执行 |
| MG-R002 | `PASS_MOCK` | 授权域隔离与订阅收据离线通过（`agg-auth-resolve.test.mjs`、`agg-auth-subscription.test.mjs`、`agg-auth-receipt.test.mjs`、`codex-target-authz.test.mjs`）；真实 Desktop 登录/登出切换未执行 |
| MG-R003 | `PASS_MOCK` | V2 只要求 OpenCode Go `deepseek-v4.1-flash`；目录/分页/同步 fixtures 通过（`agg-discovery-catalog.test.mjs`、`agg-discovery-pagination.test.mjs`、`agg-discovery-sync.test.mjs`）；真实 Go 授权与推理未在 V2 当前树执行 |
| MG-R004 | `NOT_TESTED` | 原版 Codex Desktop 模型选择器未实际操作；不得用本项目 Web 控制台或 CLI 结果冒充 |
| MG-R005 | `PASS_REAL` | 真实原生父子代理（父 GPT、子 Go DeepSeek）回执见于旧树 `67b97354ad28a3924607b35a663801f417f14b8e`；**V2 当前树未复测**；离线协议侧由 `agg-native-invariants.test.mjs`、`agg-native-wait.test.mjs` 覆盖；取代 PASS_MOCK @ docs/evidence/aggregation-integration-2026-11-14.md |
| MG-R006 | `FAIL` | 真实触发 Codex 原生压缩时返回 `unsupported_input_item`（compaction）；V2 新增的 `native-compaction` / `post-compact-followup` / `context-proof` 用例尚未通过，故旧树 PASS_REAL 不得继承；保留原失败记录不删改；取代 PASS_REAL @ docs/evidence/aggregation-native-real-2026-11-14.md；取代 NOT_TESTED @ docs/evidence/aggregation-integration-2026-11-14.md |
| MG-R007 | `PASS_MOCK` | 预览/备份/原子写/回滚离线通过（`agg-desktop-activate.test.mjs`、`agg-desktop-rollback.test.mjs`、`config-transaction.test.mjs`）；空白安装与已有配置的真实 GUI 演练未做 |
| MG-R008 | `PASS_MOCK` | 无静默降级反向用例离线通过（`agg-auth-leak.test.mjs`、`agg-native-invariants.test.mjs`、`agg-discovery-sync.test.mjs`）；`no-silent-compaction-drop` 的真实负向验收依赖 MG-R006 修复 |
| MG-R009 | `PASS_MOCK` | 租户原语与隔离用例通过（`agg-tenant-isolation.test.mjs`、`agg-discovery-catalog.test.mjs`）；第二真实身份未创建（授权项） |
| MG-R010 | `PASS_MOCK` | 回滚与中断恢复离线通过（`agg-desktop-rollback.test.mjs`、`config-transaction.test.mjs`）；可丢弃实例的真实演练未做 |
| MG-R011 | `PASS_MOCK` | 证据纪律由离线套件自证（`aggregation-acceptance-matrix.test.mjs`、`aggregation-acceptance-audit.test.mjs`、`aggregation-acceptance-v2.test.mjs`）；真实回执仍缺 |
| MG-R012 | `PASS_REAL` | 请求级脱敏收据证明上游 `model=gpt-6-luna`、无其他 GPT 型号/无自动回退，3/3 HTTP 200，绑定旧树 `4feafe0e51dc02d48c45734df5b34e70d3679bd5`；V2 当前树未复测；离线负向（无其他 GPT 型号/无回退）由 `agg-auth-receipt.test.mjs`、`aggregation-acceptance-v2.test.mjs` 覆盖；取代 BLOCKED @ docs/evidence/agg-p01-opencode-discovery-2026-11-14.md |

## 3. 状态口径与不通过即不发布

- 只允许五值：`NOT_TESTED` / `BLOCKED` / `FAIL` / `PASS_MOCK` / `PASS_REAL`。
- `PASS_MOCK` 只表示离线套件真正执行过的行为，点名套件必须已登记在 `scripts/test/run.mjs`。
- `PASS_REAL` 必须绑定完整 40 位 commit SHA、可复制命令与脱敏回执；换树即失效。
- 本表任一 `FAIL`/`BLOCKED`/`NOT_TESTED`/`PASS_MOCK` 都使 V2 门禁 `ready:false`；`MG-R006` 是当前首个产品级阻断。
