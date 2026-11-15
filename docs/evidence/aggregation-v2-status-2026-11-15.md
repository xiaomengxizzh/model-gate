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
| MG-R001 | `PASS_MOCK` | 一键接入/退出、写前预览、409 冲突、回滚、重启判定、客户端版本探测均有离线测试（`agg-desktop-activate.test.mjs`、`agg-desktop-rollback.test.mjs`、`agg-desktop-ui.test.mjs`、`agg-v2-desktop-detect.test.mjs`、`agg-v2-desktop-restart.test.mjs`、`agg-v2-desktop-ui.test.mjs`）；V2 当前树未在真实 Desktop 执行 |
| MG-R002 | `PASS_MOCK` | 授权域隔离与订阅收据离线通过（`agg-auth-resolve.test.mjs`、`agg-auth-subscription.test.mjs`、`agg-auth-receipt.test.mjs`、`codex-target-authz.test.mjs`）；真实 Desktop 登录/登出切换未执行 |
| MG-R003 | `PASS_MOCK` | V2 只要求 OpenCode Go `deepseek-v4.1-flash`：目录只发布该模型、越界模型进 outOfScope 诊断、公共 ID↔出站 model 请求级身份、SSE/工具保真由 `agg-v2-go-catalog.test.mjs`、`agg-v2-go-routing.test.mjs`、`agg-v2-go-stream.test.mjs` 与 `agg-discovery-catalog.test.mjs` 覆盖；真实 Go 授权与推理未在 V2 当前树执行 |
| MG-R004 | `NOT_TESTED` | 原版 Codex Desktop 模型选择器未实际操作；不得用本项目 Web 控制台或 CLI 结果冒充 |
| MG-R005 | `PASS_REAL` | 真实原生父子代理（父 GPT、子 Go DeepSeek）回执见于旧树 `67b97354ad28a3924607b35a663801f417f14b8e`；**V2 当前树未复测**；离线协议侧由 `agg-native-invariants.test.mjs`、`agg-native-wait.test.mjs` 覆盖；取代 PASS_MOCK @ docs/evidence/aggregation-integration-2026-11-14.md |
| MG-R006 | `FAIL` | 真实触发 Codex 原生压缩时返回 `unsupported_input_item`（compaction）；离线协议侧已实现「声明支持才原样透传，否则 typed 拒绝」（`agg-v2-compaction-protocol.test.mjs`）且 Desktop 配置已能声明 provider 级 `remote_compaction=unsupported`（`agg-v2-desktop-compaction.test.mjs`），但 V2 新增的 `native-compaction` / `post-compact-followup` / `context-proof` 仍未在真实 Codex 上通过，故旧树 PASS_REAL 不得继承；保留原失败记录不删改；取代 PASS_REAL @ docs/evidence/aggregation-native-real-2026-11-14.md；取代 NOT_TESTED @ docs/evidence/aggregation-integration-2026-11-14.md |
| MG-R007 | `PASS_MOCK` | 预览/备份/原子写/回滚/选择性与完整撤销离线通过（`agg-desktop-activate.test.mjs`、`agg-desktop-rollback.test.mjs`、`agg-v2-desktop-restore.test.mjs`、`config-transaction.test.mjs`）；provider 级 `remote_compaction=unsupported` 声明与 reserved 身份拒绝由 `agg-v2-desktop-compaction.test.mjs` 覆盖；空白安装与已有配置的真实 GUI 演练未做 |
| MG-R008 | `PASS_MOCK` | 无静默降级反向用例离线通过（`agg-auth-leak.test.mjs`、`agg-native-invariants.test.mjs`、`agg-discovery-sync.test.mjs`）；401/402/403/配额型 429 按真实授权域返回终态信封、跨授权域 429 回退被阻断（`agg-v2-auth-domains.test.mjs`）、压缩项不静默丢弃（`agg-v2-compaction-protocol.test.mjs`）；`no-silent-compaction-drop` 的真实负向验收仍依赖 MG-R006 修复 |
| MG-R009 | `PASS_MOCK` | 租户原语与隔离用例通过（`agg-tenant-isolation.test.mjs`、`agg-v2-auth-isolation.test.mjs`、`agg-discovery-catalog.test.mjs`）；第二真实身份未创建（授权项） |
| MG-R010 | `PASS_MOCK` | 回滚与中断恢复离线通过（`agg-desktop-rollback.test.mjs`、`agg-v2-desktop-restore.test.mjs`、`config-transaction.test.mjs`）；退出只撤销自有键并逐字节保留用户后改配置；可丢弃实例的真实演练未做 |
| MG-R011 | `PASS_MOCK` | 证据纪律由离线套件自证（`aggregation-acceptance-matrix.test.mjs`、`aggregation-acceptance-audit.test.mjs`、`aggregation-acceptance-v2.test.mjs`）；真实回执仍缺 |
| MG-R012 | `PASS_REAL` | 请求级脱敏收据证明上游 `model=gpt-6-luna`、无其他 GPT 型号/无自动回退，3/3 HTTP 200，绑定旧树 `4feafe0e51dc02d48c45734df5b34e70d3679bd5`；V2 当前树未复测；离线负向（无其他 GPT 型号/无回退）由 `agg-auth-receipt.test.mjs`、`aggregation-acceptance-v2.test.mjs` 覆盖；取代 BLOCKED @ docs/evidence/agg-p01-opencode-discovery-2026-11-14.md |

## 3. 状态口径与不通过即不发布

- 只允许五值：`NOT_TESTED` / `BLOCKED` / `FAIL` / `PASS_MOCK` / `PASS_REAL`。
- `PASS_MOCK` 只表示离线套件真正执行过的行为，点名套件必须已登记在 `scripts/test/run.mjs`。
- `PASS_REAL` 必须绑定完整 40 位 commit SHA、可复制命令与脱敏回执；换树即失效。
- 本表任一 `FAIL`/`BLOCKED`/`NOT_TESTED`/`PASS_MOCK` 都使 V2 门禁 `ready:false`；`MG-R006` 是当前首个产品级阻断。

## 4. 本轮明确未解决项（不得因门禁迁移而消失）

- **MG-R006 真实 native compaction**：真实 Codex 上仍未通过（历史失败保留）；离线协议与配置声明只到 `PASS_MOCK`。恢复条件：所有者授权的 Codex 时间窗/额度，A5 用 `gpt-6-luna` 父模型 + `deepseek-v4.1-flash` 子模型实测。
- **N04（`history/export` 迁移导出）**：A5 独立门禁按契约绝对条款判 `FAIL`；当前仍未获所有者裁决，本文件不记录任何减免。两种处理方式见 [V2 集成证据](aggregation-v2-integration-2026-11-15.md) §5。
- **managed provider 运行时登录复用**：`requires_openai_auth` 仅经 serde 解析验证，运行时是否复用 ChatGPT 登录为 `UNVERIFIED`，默认关闭（保持内置 `openai` 身份）。

## 5. 关联证据

- [V2 集成证据（本轮代码/命令/本机事实）](aggregation-v2-integration-2026-11-15.md)
- [A5 独立验收](aggregation-v2-independent-qa-2026-11-15.md) / [A5 对抗复核发现](aggregation-v2-qa-findings-2026-11-15.md)
