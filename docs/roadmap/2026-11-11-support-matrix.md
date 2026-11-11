# 支持矩阵与验证等级（2026-11-11 加固轮 · M5-3）

本轮对外交付的**诚实状态表**。铁律一条：**mock 通过 ≠ 真实接入通过**。
每一行都指到具体证据（套件名 + 断言数、或 `docs/evidence/` 下的历史记录、或本轮回执）；找不到证据的行一律写 `NOT_RUN(无证据)`。

配套文档：[回滚与降级开关](../how-to/rollback-and-disable.md)、[智能 Fallback 决策](../explanation/fallback-decision.md)、[UHR 推理契约](../contracts/uhr-inference-v1.md)、[UHR MCP 契约](../contracts/uhr-mcp-v1.md)。

## 0. 先说数字口径（避免误读）

- 下表所有套件/断言数字来自本卡验收时的**实测**：分支 `work/d`（代码基线 `cceb949`，本卡只加文档，不改变套件数），隔离 `HOME`/`TMPDIR`、无网络，命令 `node scripts/test/run.mjs`：
  - **49 套件全部通过**（输出 `Isolated suites: 49/49 passed`，退出码 0）
  - node:test 用例 **396**：395 通过、**1 SKIP**（`MG_CODEX_VERIFY=1` 才执行的真实 CLI 用例）、0 失败
  - 3 个旧式验收脚本：`virtual-models` 18/18、`effort-normalize` 20/20、`upstream-side-4xx` 7/7
  - `npm run check` 退出码 0；`npm run docs:check` → `Documentation paths: PASS`
- 集成线（lead 合并其它角色交付后）为 **53 套件 / 492 pass**，里程碑 SHA **`<见交付报告>`**。
  本分支没有 integration ref，**无法在本地复现这组数字**，因此下表不引用未复现的计数；凡依赖集成线交付的行，
  证据列写 `<见交付报告>` 并同时标 `NOT_RUN(本分支不可复现)`，而不是写成通过。
- 证据白名单：`scripts/test/offline/<suite>.test.mjs`、`scripts/test/*.mjs`（旧式或被门控的脚本）、
  `docs/evidence/**`、`docs/contracts/**`、本轮回执日志
  （`/home/xiaomengxizi/ai/tmp/modelgate-runtime-20261111-a1/d/logs/`，机器本地，不入库）。

## 1. 图例

| 标记 | 含义 |
| --- | --- |
| `PASS(mock)` | 本机离线、无真实上游即可复现；证据是可执行套件与其断言数 |
| `PASS(real)` | 真实上游/真实客户端上验证过。**本轮没有任何一行是 PASS(real)**，这是结论，不是遗漏 |
| `NOT_RUN(原因)` | 本轮没有执行，且写明原因（无授权/无真实账号/未接线/不可复现） |
| `BLOCKED(原因)` | 不是"没做"，而是当前**做不了**（缺接口/缺写集/缺授权） |
| `DISABLED(默认)` | 能力存在，但默认关闭或以拒绝方式呈现；有拒绝路径测试 |

## 2. 表 A：纯 mock（本机离线可复现）

| # | 能力 | 等级 | 证据（套件 · 断言数） | 边界 |
| --- | --- | --- | --- | --- |
| A1 | Chat 上游协议适配（OpenAI / Anthropic / Gemini / Cohere 的请求构造、响应与 SSE 还原） | `PASS(mock)` | `offline/wire-format` 22 | 只证明"按协议形状正确"，不证明真实上游接受 |
| A2 | 请求整形、编码、体积上限与边界 | `PASS(mock)` | `offline/request-encoding` 4、`offline/boundary` 1 | 同上 |
| A3 | 虚拟模型 / 模型解析 / 思考档位归一化 | `PASS(mock)` | `virtual-models` 18/18、`offline/model-resolution` 7、`effort-normalize` 20/20 | 档位字段随上游协议整形，未在真实上游校验语义 |
| A4 | 转发链治理：上游侧 4xx 判定、重试/429/退避/整体死线/SSE 生命周期 | `PASS(mock)` | `upstream-side-4xx` 7/7、`offline/retry-governance` 11、`offline/deadline` 17、`offline/lifecycle` 2 | 真实网络抖动/断流未复现 |
| A5 | Responses 端点（Chat 桥 + 原生透传 + 映射/lossy 标记） | `PASS(mock)` | `offline/responses-endpoint` 6、`offline/responses-mapping` 17、`offline/responses-native` 4 | 原生透传只对本地 mock 上游验证 |
| A6 | 可选端点协议（embeddings / rerank / images / audio / video） | `PASS(mock)` | `offline/embeddings` 7、`offline/rerank` 6、`offline/media` 8、`offline/video` 6 | 端点已接线（`src/index.js`），**真实上游 NOT_RUN**（见 B12） |
| A7 | Codex 目录（官方基线 + 聚合 slug + 一致性/路由） | `PASS(mock)` | `offline/codex-catalog` 26（+1 SKIP，见 B1）、`offline/codex-catalog-coherence` 1、`offline/codex-routing-catalog` 10 | 真实 `codex debug models` 导出的目录未在本轮复验 |
| A8 | Codex 配置读写（TOML 保留、原子写、备份/回滚、权限段不动） | `PASS(mock)` | `offline/codex-config` 31 | 真实 `~/.codex/config.toml` 未读写（隔离副本测试） |
| A9 | 配置投影与字段校验（管理面） | `PASS(mock)` | `offline/config-projection` 3、`offline/config-schema` 4 | — |
| A10 | 身份域 / 官方目标分类 / 控制项 | `PASS(mock)` | `offline/codex-identity` 14、`offline/codex-official` 4、`offline/codex-control-items` 1 | 真实官方 host 与凭据隔离未在本轮验证 |
| A11 | 额度与应急流程（离线合成演练） | `PASS(mock)` | `offline/codex-quota` 6（对应历史演练 `docs/evidence/2026-11-11-e8-quota-drill.txt`，标注为离线合成） | 真实官方额度耗尽未演练 |
| A12 | Codex API 兼容层（v1 形状 / 错误码映射 / WS 404 回落） | `PASS(mock)` | `offline/codex-api` 26 | 真实 Codex CLI 未跑（B1） |
| A13 | v2 互操作（namespace 展开、不可表达工具显式标记、加密任务**只给信号**） | `PASS(mock)` | `offline/codex-interop` 15 | 见 C1：密文一律拒绝跨域 |
| A14 | Codex 会话历史（只读诊断 / 迁移演练 / opencode 会话） | `PASS(mock)` | `offline/codex-history` 3、`offline/codex-opencode-session` 2 | 真实历史库只读诊断的历史证据见 `docs/evidence/2026-11-11-e7-real-history-readonly.txt`（上一轮） |
| A15 | 智能调度决策（错误分类 / 阶段机 / 候选证据 / 排序 / 对账停机 / D7 身份闸门） | `PASS(mock)` | `offline/codex-fallback` 29、`offline/routing-decision` 20 | 见 B7：接线仍未完成 |
| A16 | 调度接线（`forward.js` 聚合路径 + 阶段推进） | `PASS(mock)` | `offline/codex-fallback-forward` 10（本地 mock 上游 + 动态端口 + 临时配置目录） | 只覆盖聚合 slug 路径；官方真机未跑 |
| A17 | 预算账本（整数 micro / 显式币种 / 单写者 / 幂等 / 未知保留 / 超支封顶 / 跨日 / 并发 / 重启恢复 / 脱敏） | `PASS(mock)` | `offline/routing-ledger` 14（真实临时目录 + 3 个真实子进程并发） | 见 B7/B8：**未接进 forward.js，运行时费用上限不生效** |
| A18 | UHR 推理回执契约（授权/候选/预算/终态/未知用量/路由一致性/不可变/幂等） | `PASS(mock)` | `offline/inference-receipt` 12 | 真实 UHR 未接（B6） |
| A19 | MCP ↔ mock UHR 委派契约（作用域/只读意图/引用白名单/预算/幂等/取消/归属/callId 回填/脱敏） | `PASS(mock)` | `offline/mcp-uhr-contract` 15（真实临时目录落盘 + 重启重建） | mock UHR，不是真实 UHR（B6） |
| A20 | 管理面契约（保存/鉴权矩阵/版本冲突/投影/来源策略/密钥不回显） | `PASS(mock)` | `offline/admin-contract` 2、`offline/admin-projection` 4、`offline/admin-origin` 4、`offline/admin-secrets` 1 | 见 C4：匿名远程默认拒绝 |
| A21 | 控制台 UI（静态树/CSP/遍历防护/接口契约） | `PASS(mock)` | `offline/ui-contract` 2、`offline/ui-next` 2 | 真实浏览器见 B10 |
| A22 | 可观测（指标/日志脱敏/原生用量） | `PASS(mock)` | `offline/metrics` 2、`offline/logger-secrets` 2、`offline/native-usage` 2 | — |
| A23 | 工具互操作（托管工具不可表达时显式丢弃并记 `lossy`） | `PASS(mock)` | `offline/hosted-tools` 1 | 真实工具调用未跑 |
| A24 | 探活与用户环境（/healthz、模型探测、用户 env 回落） | `PASS(mock)` | `offline/probe` 4、`offline/user-env` 5 | 真实上游探活未跑 |

## 3. 表 B：真实环境与接线（未验证项）

| # | 能力 | 等级 | 证据 | 原因 / 缺口 |
| --- | --- | --- | --- | --- |
| B1 | 真实 Codex CLI 三轮回环（`MG_CODEX_VERIFY=1` 门控） | `NOT_RUN(本轮未执行)` | `offline/codex-catalog` 的 `CLI：真实 codex 可解析生成物（离线，需 MG_CODEX_VERIFY=1）` 在默认全量里是 **SKIP**（本机日志 1 skipped）；`scripts/test/codex-e2e.mjs`、`codex-live*.mjs` 需 `MG_ALLOW_LIVE_TESTS=1` 且被 `live.mjs` 显式排除 | 未在本轮执行真实 CLI 三轮；需要真实 CLI 与本机回环，且不得复用日常 `CODEX_HOME` |
| B2 | 真实官方上游（官方目录 / 身份 / 透传） | `NOT_RUN(本轮零真实上游)` | 历史证据：`docs/evidence/2026-11-11-e3-live-switching.md`（第 1/3 轮为**真实 chatgpt.com 官方后端**，用户已授权）、`docs/evidence/2026-11-11-e4-v2-live-blocked.md`（真实官方主代理）。注：`2026-11-11-e3-official-transport.txt` 是**本地 mock 上游**，不能当真实上游证据 | 需独立授权 + 真实账号；本轮禁止访问真实上游 |
| B3 | 真实第三方上游（付费/订阅账号） | `NOT_RUN(本轮零真实上游)` | 历史证据：`docs/evidence/2026-11-11-e4-v2-live-blocked.md`（子代理为**真实 OpenCode Go**）。注：`e3-live-switching.md` 第 2 轮是本地 mock 第三方（零真实费用），不算真实第三方证据 | 同上；不得用真实 Key 做本轮验收 |
| B4 | 真实流式/SSE 上游链路与断流续传 | `NOT_RUN(本轮零真实上游)` | mock 侧 `offline/lifecycle` 2、`offline/retry-governance` 11；历史 `docs/evidence/2026-11-09-integration/` | 真实网络中断/背压未复现 |
| B5 | Desktop GUI（Codex Desktop / 托盘客户端） | `NOT_RUN(本轮未启动)` | `docs/how-to/tray-deployment.md`；历史 `docs/evidence/2026-11-09-integration/codex-switching-desktop.txt` | 需独立 profile 且保证回环（不能碰日常客户端与账号）才可验 |
| B6 | 真实 UHR 委派（submit/getResult/cancel 对真实服务） | `BLOCKED(缺现行授权接口与写集)` | 本轮交付 `offline/mcp-uhr-contract` 15 + 契约 `docs/contracts/uhr-mcp-v1.md` | 需要读到现行 UHR 授权接口并单独立项/写集；mock 契约不等于真实集成 |
| B7 | 账本接线（`reserve → 发送 → settle/release/markUnknown`，`receipt.status !== 'released' ⇒ 可能已提交`） | `NOT_RUN(未接线)` | `grep -rn "routing/ledger" src` 只命中 `decision.js`/`facts.js` 注释；`src/forward.js` 的 `codexBudgetOf` 仍把 `spent` 恒填 0；账本能力由 `offline/routing-ledger` 14 证明 | 由 B/M1-3a 接线；本卡不碰 `forward.js` |
| B8 | 费用上限强制（`taskUsd` / `dailyUsd` 真正约束消费） | `NOT_RUN(依赖 B7)` | `docs/reference/configuration.md` §预算明确写"未接费用账本，spent 恒 0（NOT_RUN）"；`docs/explanation/fallback-decision.md` §10.5 同 | 接线前**不得**宣称费用上限生效；只声明"模块已就绪" |
| B9 | 管理面自管 `apply/rollback`（受控 fixture 模式） | `NOT_RUN(本分支不可复现)` | M4-1a 交付在集成线，`<见交付报告>`；本分支 `grep` 无自管 apply/rollback 端点 | 普通产品模式应为 DISABLED（见 C6），fixture 模式需集成线证据 |
| B10 | 控制台真实浏览器验收（CSP/交互/截图） | `NOT_RUN(本轮未跑)` | `scripts/test/ui-browser-check.mjs` 需已启动的 CDP Chrome + 显式 `--port/--token`，被 `live.mjs` 排除 | 需真实浏览器与隔离实例；不做自动化假通过 |
| B11 | 真实计费 / 账单对账 | `NOT_RUN(无真实账单输入)` | `offline/routing-ledger` 14 只证明本地整数记账能力 | 真实账单口径、发票与退款不在本轮范围 |
| B12 | 可选端点真实上游（embeddings/rerank/media/video） | `NOT_RUN(本轮零真实上游)` | 协议侧 `offline/embeddings` 7、`rerank` 6、`media` 8、`video` 6；README 原表述"真实上游尚未验收" | 端点已接线 ≠ 上游可用 |

## 4. 表 C：默认关闭 / 明确拒绝（DISABLED）

| # | 能力/入口 | 等级 | 拒绝路径与证据 | 开启方式与风险 |
| --- | --- | --- | --- | --- |
| C1 | 原生 v2 密文跨域（`encrypted_content` / `encrypted_task_id`） | `DISABLED(拒绝)` | `offline/codex-interop` 15（v2 加密任务判定只给信号，不返回/不记录密文）、`offline/responses-mapping` 17（`include` 丢弃记 `lossy`）、`offline/mcp-uhr-contract` 15（`UHR_REJECT_V2_OPAQUE`）、真实实测 `docs/evidence/2026-11-11-e4-v2-live-blocked.md`（`v2_encrypted_task_unsupported`，400 显式阻断） | **没有开关**：不可用环境变量开启，也不降级到 v1。要支持需单独授权与设计（明文重派或原生 Responses 上游） |
| C2 | 受控官方聚合实验（智能调度作用于聚合/官方 slug） | `DISABLED(默认)` | `defaults.codexFallback=false`（`docs/reference/configuration.md` 第 29/132 行）；唯一测试入口 `offline/codex-fallback-forward` 10（回环双 mock：网关与上游都在 `127.0.0.1` 动态端口，零外网） | 开启 = 配置聚合目录绑定或 `codexFallback:true`。风险：换模型/重试会真实发生，可能产生额外计费或跨身份调用；D7 与身份域闸门兜底但不等于零风险 |
| C3 | 官方订阅候选进入通用池 / 官方额度自动换池 | `DISABLED(拒绝)` | `offline/routing-decision` 20（`official_subscription_excluded`、D7 身份闸门、evidence/legacy 双形状）、`offline/codex-fallback` 29 | 需用户显式确认应急（`defaults.codexEmergency`）。风险：确认后第三方计费与数据跨域 |
| C4 | 远程管理面（未配置令牌时） | `DISABLED(默认拒绝)` | `offline/admin-origin` 4（非回环绑定时匿名读/写 403、跨源/Host 校验）、`offline/admin-secrets` 1 | 开启 = `MG_ADMIN_TOKEN` + `server.host` 绑定/反代。风险：令牌泄露等于管理面完全暴露；令牌存 keys 库，重启不失效 |
| C5 | MCP ↔ UHR 委派入口 | `DISABLED(未接线)` | `src/mcp/` 是隔离目录，`src/index.js` 无注册/HTTP 入口；边界拒绝由 `offline/mcp-uhr-contract` 15 覆盖 | 开启 = 由接线卡（M1-3/M3-3）决定注册；风险：委派会把任务摘要与引用送出进程边界，必须保持只读意图与引用白名单 |
| C6 | 新控制台（`/ui-next`）作为**默认**入口 | `DISABLED(非默认)` | `offline/ui-next` 2（静态树/CSP/遍历防护）、README 明确"未经所有者批准不做默认入口替换"；旧 `/` 与 `/admin` 保留 | 开启 = 所有者批准后改默认入口。风险：面板状态与新接口契约不匹配时用户误操作（保存会重写 providers/models） |
| C7 | 管理面**自管 apply/rollback** 入口（普通产品模式） | `DISABLED(不启用)` | 本分支无该入口（M4-1a 在集成线，`<见交付报告>`，见 B9）；现有管理写操作只有配置保存/重载/令牌/Key 元数据，受 `offline/admin-contract` 2、`admin-projection` 4、`admin-origin` 4、`admin-secrets` 1 约束 | 开启 = 集成线的受控自管 fixture 模式（需回滚点 + 人工确认）。风险：apply 会真实改写配置与目录，误触即改路由；没有"撤销"按钮，只能靠回滚点 |

## 5. 汇总

| 等级 | 行数 | 说明 |
| --- | --- | --- |
| `PASS(mock)` | 24 | 全部可在本机隔离环境复现（49 套件，见 §0 实测口径） |
| `PASS(real)` | **0** | 本轮零真实上游、零真实 CLI、零真实 UHR；不把 mock 写成真实 |
| `NOT_RUN` | 11 | B1–B5、B7–B12（含 1 条依赖未接线） |
| `BLOCKED` | 1 | B6（真实 UHR：缺现行授权接口与写集） |
| `DISABLED` | 7 | C1–C7，均有拒绝路径或默认关闭证据 |

## 6. 残余风险（按重要性）

1. **账本未接线**（B7/B8）：`taskUsd`/`dailyUsd` 配置了也不生效；任何"费用上限已强制"的说法都不成立。接线前只能靠 `requestUsd` 单请求闸门与额度软限制。
2. **真实上游未知**（B2/B3/B12）：协议 mock 通过不代表上游接受；Anthropic/Gemini/Cohere 适配、媒体端点、原生 Responses 都有真实侧风险。
3. **v2 密文边界是硬拒绝**（C1）：多代理 v2 任务在第三方 Chat 上游上必然失败（设计内），用户会看到显式错误而不是静默降级。
4. **调度只在聚合路径启用**（C2）：非聚合模型仍走旧 `forwardChain`；把"智能调度"理解为全局能力会高估覆盖。
5. **管理面 = 单令牌**（C4）：没有按操作的最小权限；令牌泄露即全量管理权限。
6. **数字随分支变化**：回滚到较早里程碑后套件数与断言数都会变（本表 49/396 是本分支实测），不要把任何固定数字写进 CI 断言。
