# ModelGate（model-gateway）

本地 OpenAI 兼容模型网关，统一 Chat / Responses 转发、失败重试、多上游兜底、429 治理、SSE 续传和用量统计。Node.js >=18，运行时无第三方 npm 依赖；管理面板由同一进程提供。

新一代控制台（候选版）位于 `/ui-next`，源代码在 `src/ui-next/`；旧管理台 `/` 与 `/admin` 保留，未经所有者批准不做默认入口替换。

首次验证请使用隔离环境，避免占用日常网关端口：

```bash
npm run check
npm test
```

上述测试自行启动本地 mock 和临时网关。首次运行服务见[隔离启动教程](docs/tutorials/local-start.md)；真实接入需要自行配置上游与 Key。

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

配置与变量见[参考](docs/reference/configuration.md)，运行与凭据边界见[操作指南](docs/how-to/operations.md)。日常进程在线状态、私有配置、价格均不由本 README 证明。
