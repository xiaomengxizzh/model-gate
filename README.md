# ModelGate（model-gateway）

本地 OpenAI 兼容模型网关，统一 Chat / Responses 转发、失败重试、多上游兜底、429 治理、SSE 续传和用量统计。Node.js >=24，运行时无第三方 npm 依赖；管理面板由同一进程提供。当前验收线只有 **Linux + Node 24**（见[运行时支持矩阵](#运行时支持矩阵)）。

新一代控制台（候选版）位于 `/ui-next`，源代码在 `src/ui-next/`；旧管理台 `/` 与 `/admin` 保留，未经所有者批准不做默认入口替换。

首次验证请使用隔离环境，避免占用日常网关端口：

```bash
npm run check
npm test
```

上述测试自行启动本地 mock 和临时网关。首次运行服务见[隔离启动教程](docs/tutorials/local-start.md)；真实接入需要自行配置上游与 Key。

## 运行时支持矩阵

本轮（N00，2026-11-12）只把下列组合当作**当前支持**；没有实测环境的一律标未验收/已退役，不写成支持（"跳过"不等于"通过"）。

| 平台 | Node | 状态 | 证据 |
| --- | --- | --- | --- |
| Linux x64（Ubuntu 26.04，kernel 7.0.0-43-generic） | Node 24（实测 v24.22.2，npm 11.19.1） | **当前支持（已实测）** | 本机四条门禁全绿：`npm run check` / `npm test`（76 套件、769 用例）/ `npm run docs:check` / `node scripts/check-metadata.mjs`；CI 矩阵同为 Node 24 |
| macOS / Windows | 任意大版本 | **未验收（NOT_RUN）** | 无实测环境；Windows `.bat/.cmd` 只做静态检查，未在真实 Windows 上运行 |
| Linux / macOS / Windows | Node 18 / 20 / 22 | **已退役（仅历史记录）** | 旧 CI 矩阵与旧版验证记录；本机没有 Node 18/20/22 runner，也不下载工具链（见 RESOURCE_APPROVAL.md），因此不再声明为受支持版本 |

`package.json` 的 `engines.node`（`>=24`）、CI 矩阵（`24`）与上表由 `node scripts/check-metadata.mjs` 强制一致；改任一处都要同步其余两处。低于 24 的大版本不会被"兼容模式"放行。

## 开发与交接

- [AI 接手入口](AGENTS.md)：必读顺序与操作边界。
- [文档索引](docs/README.md)：按任务选择文档。
- [开发规范](CONTRIBUTING.md)：实现、验证与提交要求。
- [审计与验证记录](docs/audit-20261108.md)：发现、修复、局限。
- [整合候选验收与合并建议](docs/roadmap/2026-11-09-integration-candidate-report.md)：分支取舍、测试证据、未验证项与回滚。
- [新控制台 ↔ API 适配矩阵](docs/contracts/ui-next-api-matrix.md)：六个功能区的实际接口与状态。
- [后续开发计划](docs/development-plan.md)：优先级、依赖和逐项验收。
- [变更记录](CHANGELOG.md)：历史行为变更。

## 当前能力与边界

支持 `/v1/chat/completions`、`/chat/completions`、`/v1/responses`（模型 `api:"responses"` 时原生透传，其余经 Chat 桥）、`/v1/embeddings`、`/v1/rerank` 以及 images/audio/video 媒体入口。按 provider 或 model 选择 OpenAI、Anthropic、Gemini、Cohere 适配，支持虚拟模型独立 Key。原生 Responses 保留托管工具语义；Chat 桥对 `namespace`/`web_search` 等无法保真的工具显式丢弃并记录 `lossy`，不伪装完整兼容。Embedding/Rerank/媒体/视频已实现 Mock 回归，真实上游服务尚未验收，界面标为实验能力。

默认配置为空，上游调用需要显式配置。网关自身不存响应缓存；缓存命中来自上游 usage。额度是按已完成请求记账的软限制，不能当作并发严格预算。429 按上游归因返回 `Retry-After`，不再吞成 502；带工具的请求同上游只发一次、整条链最多一轮，避免危险重放。

原生 ChatGPT/直连流量默认不经过网关；可在「安全与设置」启用只读的 Codex sessions 采集，在「监控与诊断」中把原生用量与代理流量分开展示。

配置与变量见[参考](docs/reference/configuration.md)，运行与凭据边界见[操作指南](docs/how-to/operations.md)。日常进程在线状态、私有配置、价格均不由本 README 证明。

## 能力与验证状态（2026-11-11 加固轮）

本轮交付的验证状态按 `PASS(mock)` / `PASS(real)` / `NOT_RUN(原因)` / `BLOCKED(原因)` / `DISABLED(默认关闭)` 分开记录，**不把 mock 通过写成真实接入通过**；逐格证据（套件名 + 断言数或历史证据）见[支持矩阵](docs/roadmap/2026-11-11-support-matrix.md)。

- 离线可复现（`PASS(mock)`）：Chat/Responses/SSE 协议与映射、Codex 目录与配置、身份域与额度、智能调度决策、预算账本、UHR 推理回执、MCP 契约、管理面与旧/新控制台静态资源等。本分支实测 76 套件 / 769 用例全绿（1 个用例级 skip，非套件跳过；`node scripts/test/run.mjs`）；集成线 `integration/modelgate-release` 的数字与证据见 `docs/evidence/2026-11-12-closure/delivery-report.md`。
- 未验证（`NOT_RUN`）：真实官方/第三方上游、真实流式链路、真实 Codex CLI 三轮回环（`MG_CODEX_VERIFY=1`）、Desktop GUI、真实浏览器验收、真实计费。
- 阻塞（`BLOCKED`）：真实 UHR 委派（需现行授权接口与明确写集）；本轮只交付 mock UHR + 契约。
- 默认关闭/拒绝（`DISABLED`）：原生 v2 密文跨域（硬拒绝、无开关）、受控官方聚合实验、匿名远程管理面、MCP 委派（未接线）、新控制台默认入口。
- 账本已交付但**未接线**：`defaults.codexBudget.taskUsd/dailyUsd` 在接线前不生效，不要据此宣称已限费。

回滚点、回滚门禁与降级开关见[回滚与禁用](docs/how-to/rollback-and-disable.md)。
