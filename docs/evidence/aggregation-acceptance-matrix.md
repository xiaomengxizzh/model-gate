# ModelGate 聚合模式独立验收矩阵（MG-R001..MG-R012）

> 本文件由 `node scripts/test/offline/aggregation-matrix.js --write` 从产品契约、执行计划 §I 与**证据文档的状态表**生成，**禁止手工编辑**。
> `scripts/test/offline/aggregation-acceptance-matrix.test.mjs` 在每次 `npm test` 中重新生成并逐字节比对；手工改动契约、计划、证据状态或本文件任一方向都会失败。

- 被测树 SHA：`ebfb1d688cb9c293de438605c57fcb7acc1a6f23`（来自 docs/evidence/aggregation-integration-2026-11-14.md 的「被测树 SHA」字段，生成器不再保存常量）
- 契约来源：`docs/product/2026-11-14-owner-product-contract.md`（sha256 `e2068e6edbf76eee47db3c04556eb9ab60548556d6632f955af29269e74edc83`）
- 用例映射来源：`docs/roadmap/2026-11-14-aggregation-pseudocode-plan.md` §I（sha256 `ed743d3c159cadcdeb704a4ecec6e626d5a6abc6e38c921e4dfafb590e892bc1`）
- 状态来源：`docs/evidence/aggregation-integration-2026-11-14.md`（12 行）、`docs/evidence/agg-p01-opencode-discovery-2026-11-14.md`（6 行）；多份证据对同一需求必须一致，冲突即生成失败。
- 状态口径：契约 §2 的五值（`NOT_TESTED` / `BLOCKED` / `FAIL` / `PASS_MOCK` / `PASS_REAL`）；`PASS_MOCK` 只用于**离线套件真正执行过**的行为，且每行都在「状态依据」里点名已登记的套件。
- 历史基线：`docs/evidence/aggregation-baseline-2026-11-14.md` §5（采集于 `a9f32c976f5415adb898c31605b362b25d2ee6aa`，sha256 `d7fc53316e07760f77e4234adcaa1175519582ee68a4153673742daffa3f5878`）只说明当时的起点，不是本表当前状态的来源。
- 当前门禁：`ready:false`。逐项原因见 `docs/evidence/aggregation-acceptance-verdict-2026-11-14.md`（该文件是本矩阵的历史结论，不是本矩阵的输入）。

## 1. 矩阵

| 需求 | 目标产品行为（契约原文） | 必需实测验收（契约原文） | 计划用例 ID | 每条用例所需证据 | 当前状态 @ `ebfb1d68` | 状态依据（证据原文） |
| --- | --- | --- | --- | --- | --- | --- |
| MG-R001 | GUI 一键进入/退出聚合模式，默认官方套餐保持可用 | 全新用户 GUI 流程，自动启停与回滚，重启后状态一致 | `gui-activate`<br>`gui-deactivate`<br>`restart` | **`gui-activate`**：原版 GUI 录屏 + `/api/aggregation/activate` 回执（consentToken、configVersion、traceId）+ 写前预览<br>**`gui-deactivate`**：GUI 退出录屏 + 回滚回执 + 恢复后字节级 diff 为空<br>**`restart`**：重启进程后 `status()` 仍为 aggregation，目录版本与激活时一致 | PASS_MOCK @ `ebfb1d68` | 一键接入/退出、428 预览、409 冲突、回滚均有离线测试（`agg-desktop-activate.test.mjs`、`agg-desktop-rollback.test.mjs`、`agg-desktop-ui.test.mjs`）；未在真实 Desktop 执行 |
| MG-R002 | Codex 已有 ChatGPT 登录、额度和官方模型正常使用，不要求用户再走开发调试 OAuth | 原版 Desktop 登录身份、官方实际模型请求与额度归属；切换/退出后未破坏原登录 | `codex-official-login-unchanged`<br>`official-gpt-6-luna-real` | **`codex-official-login-unchanged`**：前后 `auth.json` 元数据（mtime/size/sha256，不读内容）+ 同一 account 身份<br>**`official-gpt-6-luna-real`**：脱敏请求收据 `model=gpt-6-luna`、`authDomain=codex-subscription`、上游 200 回执 | PASS_MOCK @ `ebfb1d68` | 授权域与订阅收据离线测试通过（`agg-auth-resolve.test.mjs`、`agg-auth-subscription.test.mjs`、`agg-auth-receipt.test.mjs`、`codex-target-authz.test.mjs`）；真实登录身份/额度未验证 |
| MG-R003 | 添加 OpenCode Console/Go，自动发现本人全部可用模型并同步 | 真实目录快照与 GUI/Codex 模型清单逐一对账；无静默遗漏，模型更新可恢复 | `all-opencode-console-models`<br>`all-opencode-go-models`<br>`refresh-diff` | **`all-opencode-console-models`**：真实目录快照（分页穷尽）↔ GUI/Desktop 清单双向对账，缺一即 FAIL<br>**`all-opencode-go-models`**：Go 真实目录快照 ↔ 清单对账；`mg-opencodego-*` 公共 ID 字节兼容<br>**`refresh-diff`**：`/sync` 回执 added/removed/updated 与上游变更逐项一致 | PASS_MOCK @ `ebfb1d68` | 发现/分页/目录 fixtures 通过（`agg-discovery-console.test.mjs`、`agg-discovery-pagination.test.mjs`、`agg-discovery-sync.test.mjs`、`agg-discovery-catalog.test.mjs`）；真实 Console/Go 目录未对账 |
| MG-R004 | 原版 Codex Desktop GUI 内使用官方与聚合模型，无需手工改文件 | 在原版 Desktop 逐一选择官方与两种 OpenCode 模型，实际回执核对正确供应商 | `desktop-model-picker-official`<br>`desktop-model-picker-go`<br>`desktop-model-picker-console` | **`desktop-model-picker-official`**：原版 Desktop 选择器截图 + 该模型请求回执 provider=chatgpt-official<br>**`desktop-model-picker-go`**：原版 Desktop 选择器截图 + 该模型请求回执 provider=opencode-go<br>**`desktop-model-picker-console`**：原版 Desktop 选择器截图 + 该模型请求回执 provider=opencode-console | NOT_TESTED @ `ebfb1d68` | GUI 视图与接口已就绪；原版 Desktop 选择器未实际操作 |
| MG-R005 | 继续采用**Codex 原生 Harness** 创建/调度父子代理；网关仅承担授权、模型目录、协议/路由与观测 | 原生日志含父子线程、工具、上下文、恢复；不以 MCP/自建 Agent 调度替代 | `native-child-thread-not-mcp`<br>`native-tools` | **`native-child-thread-not-mcp`**：原生日志含 parent thread id 与 child thread id，且无 MCP/外部调度请求<br>**`native-tools`**：子代理真实工具调用与结果回执（退出码 + 输出摘要） | PASS_MOCK @ `ebfb1d68` | 原生协议单元与生命周期离线测试通过（`agg-native-invariants.test.mjs`、`agg-native-capabilities.test.mjs`）；真实父子线程未验证 |
| MG-R006 | 保留原生工具执行、等待、同子追派、中断、上下文与恢复，父子可跨供应商模型 | 单一子 ID 两轮不同任务 + 真实工具回执 + 取消/恢复 + 无额外派单，所有事件可复核 | `same-child-two-tasks`<br>`interrupt`<br>`resume`<br>`context`<br>`no-duplicate` | **`same-child-two-tasks`**：同一 childId 的两轮任务回执<br>**`interrupt`**：取消请求 → 终态 `cancelled` + 上游取消回执<br>**`resume`**：恢复后沿用同一 childId 并完成任务的回执<br>**`context`**：第二轮输入包含第一轮 tool/agent_message 上下文<br>**`no-duplicate`**：上游请求计数 = 派单数（无重放、无重复派单） | NOT_TESTED @ `ebfb1d68` | `interrupt` 用例 `NOT_ACCEPTED`；不能宣称保留中断终态 |
| MG-R007 | 零手工配置的普通用户体验：导入/检测/备份/写入/回滚 Codex 用户级配置 | 空白安装与已有配置安装各自 GUI 测试；变更原子化、有冲突处理及无损回滚 | `fresh-install-no-manual-edit`<br>`existing-config-preserve` | **`fresh-install-no-manual-edit`**：空白 HOME 全流程录屏；除产品写入外无任何 TOML 手改<br>**`existing-config-preserve`**：已有手改配置 → 三方 diff + 变更前后逐字节对比 | PASS_MOCK @ `ebfb1d68` | 预览/备份/原子写/回滚离线测试通过（`agg-desktop-activate.test.mjs`、`agg-desktop-rollback.test.mjs`）；未做空白安装与已有配置的真实 GUI 演练 |
| MG-R008 | 无静默降级：不得悄悄换模型、换供应商、换协议、关闭工具或丢弃关键功能 | 功能失败显示精确原因、原请求归因与阻断；反向测试验证零静默替换 | `no-silent-fallback`<br>`unsupported-tool-fails-explicitly`<br>`catalog-not-truncated` | **`no-silent-fallback`**：强制上游失败；响应为 typed error，且模型/供应商/协议三者未变<br>**`unsupported-tool-fails-explicitly`**：不支持工具返回精确错误码，不静默丢弃或降级<br>**`catalog-not-truncated`**：`modelCount` == 上游授权模型数；目录超限时本地目录仍完整 | PASS_MOCK @ `ebfb1d68` | 无静默降级反向用例离线通过（`agg-auth-leak.test.mjs`、`agg-native-invariants.test.mjs`、`agg-discovery-sync.test.mjs`）；真实产品路径未执行 |
| MG-R009 | 允许面向其他用户分发，认证凭据、目录、额度、统计相互隔离 | 两个独立测试身份的跨用户访问、删除、刷新、日志脱敏测试 | `two-user-isolation`<br>`token-rotation`<br>`redacted-logs` | **`two-user-isolation`**：两个测试身份跨租户读/写/刷新均 403/404<br>**`token-rotation`**：轮换后旧 Key 失效、新 Key 生效，无跨用户串用<br>**`redacted-logs`**：全量日志扫描无 token/cookie/authorization 值 | PASS_MOCK @ `ebfb1d68` | 默认关闭的租户原语与隔离用例通过（`agg-tenant-isolation.test.mjs`、`agg-discovery-catalog.test.mjs`）；第二真实身份未创建（授权项） |
| MG-R010 | 安装/升级/停止聚合不破坏用户原 Codex 环境 | 导入与回滚前后配置一致，原登录文件不被篡改，异常中断恢复 | `rollback-byte-compatible`<br>`crash-recovery`<br>`conflict-409` | **`rollback-byte-compatible`**：回滚后配置 sha256 与导入前一致<br>**`crash-recovery`**：写事务中 SIGKILL，重启后自动恢复到一致状态<br>**`conflict-409`**：并发写触发 409 + `currentVersion`，UI 展示三方 diff | PASS_MOCK @ `ebfb1d68` | 回滚与中断恢复离线用例通过（`agg-desktop-rollback.test.mjs`、`config-transaction.test.mjs`）；可丢弃实例演练未做 |
| MG-R011 | 每个项目阶段保留准确真实证据，不得把 mock/静态检查称真实验收通过 | 精确 SHA、运行环境、命令、回执、测试类型和失败/跳过状态登记 | `receipts-pin-sha`<br>`mock-vs-real-accuracy` | **`receipts-pin-sha`**：每条回执含本次 commit SHA + 可复制命令 + 环境<br>**`mock-vs-real-accuracy`**：同一用例 mock 与 real 的差异登记（有损字段单列） | PASS_MOCK @ `ebfb1d68` | 本报告提供 SHA/命令/结果/模拟标签，且矩阵与门禁由离线套件自证（`aggregation-acceptance-matrix.test.mjs`、`aggregation-acceptance-audit.test.mjs`）；仍缺真实目标回执 |
| MG-R012 | Codex 的真实 GPT 测试调用**仅可使用 GPT-6 Luna**（模型实际 ID 核验）；OpenCode 子模型可按目标调用 | 请求级脱敏收据证明 GPT model 为 Luna；不允许其他 GPT 模型/自动回退；无 Luna 资格则 BLOCKED，不代换 | `codex-gpt-parent-only-luna`<br>`no-gpt-fallback` | **`codex-gpt-parent-only-luna`**：父请求收据 `model=gpt-6-luna`<br>**`no-gpt-fallback`**：负向收据：无其他 GPT 模型请求，无自动回退 | BLOCKED @ `ebfb1d68` | 无所有者授权的 GPT-6 Luna 额度与时间窗；不代换模型 |

## 2. 汇总

- 需求：12；计划用例：33
- 状态分布：`NOT_TESTED` 2、`BLOCKED` 1、`FAIL` 0、`PASS_MOCK` 9、`PASS_REAL` 0
- 结论：发布门禁 `ready:false`。一项需求缺少真实目标上的 `PASS_REAL`，其所在行都不能视为完成；`NOT_TESTED` 不是通过，`PASS_MOCK` 不是通过，`BLOCKED` 必须在授权后重测。

## 3. 不可判定即不可发布

- 本表只记录事实：状态列全部来自证据文档的状态表，本文件不产生任何 `PASS_REAL`。
- 每条结论必须绑定 commit SHA + 可复制命令 + 脱敏回执（契约 §4）；代码或测试变化后旧证据不得复用。
- 任何“已通过”声明若在本表无对应 `PASS_REAL` 行与回执，按未通过处理。
