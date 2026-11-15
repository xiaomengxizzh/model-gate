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
| MG-R003 | `PASS_REAL` | 真实 Go 授权 + `deepseek-v4.1-flash` 推理 HTTP 200（`model` 回写、`billing_source=go`、usage 71 tokens）；公共别名 `mg-opencodego-deepseek-v4-1-flash` 也在同一实测中路由成功并按别名回写；离线目录/请求身份回归由 `agg-v2-go-catalog.test.mjs`、`agg-v2-go-routing.test.mjs` 覆盖。回执与被测树见 [真实验收记录](aggregation-v2-real-acceptance-2026-11-15.md)，绑定树 `2645b8f29d2a5ac31302300f56830d3222ae349c`；取代 PASS_MOCK @ docs/evidence/aggregation-integration-2026-11-14.md；取代 PASS_MOCK @ docs/evidence/agg-p01-opencode-discovery-2026-11-14.md |
| MG-R004 | `NOT_TESTED` | 原版 Codex Desktop 模型选择器未实际操作；不得用本项目 Web 控制台或 CLI 结果冒充 |
| MG-R005 | `PASS_REAL` | 真实原生父子代理（父 GPT、子 Go DeepSeek）回执见于旧树 `67b97354ad28a3924607b35a663801f417f14b8e`；**V2 当前树未复测**；离线协议侧由 `agg-native-invariants.test.mjs`、`agg-native-wait.test.mjs` 覆盖；取代 PASS_MOCK @ docs/evidence/aggregation-integration-2026-11-14.md |
| MG-R006 | `FAIL` | `native-compaction` 子用例已在真实 Go 模型上观测到 `context compacted`（原生压缩 native compaction 由 Codex 自己执行）；但 Codex 未向该模型下发工具定义（`tools: None`），工具/追派/压缩后上下文用例无法成立 → 整体 `FAIL`。历史失败 `unsupported_input_item` 保留不删改。离线协议与配置声明见 `agg-v2-compaction-protocol.test.mjs`、`agg-v2-desktop-compaction.test.mjs`；真实客户端 + 回环上游回放见 `agg-v2-real-client-compaction.test.mjs`（PASS_MOCK）；真实缺口见 [真实验收记录](aggregation-v2-real-acceptance-2026-11-15.md) §2.4。旧树 PASS_REAL 不得继承；保留原失败记录不删改；取代 PASS_REAL @ docs/evidence/aggregation-native-real-2026-11-14.md；取代 NOT_TESTED @ docs/evidence/aggregation-integration-2026-11-14.md |
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
- **N04（`history/export` 迁移导出）：所有者已批准书面例外（2026-11-15）**。授权来源：所有者在本轮对话中明确指令"保留并书面登记例外"。例外边界写在 [V2 产品契约](../product/2026-11-14-owner-scope-v2.md) 「明确取消与明确保留」段：非压缩/摘要器、不调用 LLM、不参与模型请求组装（有守卫断言）、原件逐字节不变、不得用于满足 `MG-R006`。超出该边界的任何摘要/压缩实现仍按绝对条款禁止。
- **managed provider 运行时登录复用**：`requires_openai_auth` 仅经 serde 解析验证，运行时是否复用 ChatGPT 登录为 `UNVERIFIED`，默认关闭（保持内置 `openai` 身份）。

## 5. 关联证据

- [V2 集成证据（本轮代码/命令/本机事实）](aggregation-v2-integration-2026-11-15.md)
- [A5 独立验收](aggregation-v2-independent-qa-2026-11-15.md) / [A5 对抗复核发现](aggregation-v2-qa-findings-2026-11-15.md)
