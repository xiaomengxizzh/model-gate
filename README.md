# ModelGate（model-gateway）

本地 OpenAI 兼容模型网关，统一 Chat 转发、失败重试、多上游兜底、SSE 续传和用量统计。Node.js >=18，运行时无第三方 npm 依赖；管理面板由同一进程提供。

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
- [后续开发计划](docs/development-plan.md)：优先级、依赖和逐项验收。
- [变更记录](CHANGELOG.md)：历史行为变更。

## 当前能力与边界

支持 `/v1/chat/completions`、`/chat/completions` 和模型列表；按 provider 或 model 选择 OpenAI、Anthropic、Gemini 适配，支持虚拟模型独立 Key。带 tools 的非 OpenAI 流可能降级为非流式后封装 SSE；完整协议保真仍需专项验收。

默认配置为空，上游调用需要显式配置。网关自身不存响应缓存；缓存命中来自上游 usage。额度是按已完成请求记账的软限制，不能当作并发严格预算。Embedding、Rerank 和其他媒体能力属于计划，尚未交付。

配置与变量见[参考](docs/reference/configuration.md)，运行与凭据边界见[操作指南](docs/how-to/operations.md)。日常进程在线状态、私有配置、价格均不由本 README 证明。
