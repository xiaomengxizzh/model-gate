# model-gate｜AI 执行规则

> **不可降级产品契约（最新执行优先）：** 执行前必须读取 [2026-11-14 所有者产品契约](docs/product/2026-11-14-owner-product-contract.md)、[聚合完整伪代码执行计划](docs/roadmap/2026-11-14-aggregation-pseudocode-plan.md) 与 [Agent Team 启动提示词](docs/roadmap/2026-11-14-aggregation-agentteam-start.md)。MG-R001..MG-R012 不得由 AI 自行修改；Codex 真实 GPT 测试只准 GPT-6 Luna，Agent Team 同时最多 5 个子代理。任何阻断必须保留原要求，不能使用 MCP、V1 缩水模式、CLI 单测冒充完整原版 Desktop 能力。真实付费测试、正式合并和发布仍需所有者授权。

> **新增 2026-11-06 必经检查：任何依赖（无论大小）下载、安装或升级前，必须先检查真实本地宿主中已有的软件/版本、项目和共享缓存、跨项目重复副本以及重复下载风险；存在兼容依赖优先零下载复用。缺少宿主访问时写 UNKNOWN_LOCAL_STATE，不得自行下载。具体规则见 [RESOURCE_APPROVAL.md](RESOURCE_APPROVAL.md)。本地缺失也不意味着获得用户安装授权。**


> **用户资源授权最高优先级**：执行任何计划、环境准备、配置修改前，必须读取 [RESOURCE_APPROVAL.md](RESOURCE_APPROVAL.md)。未经用户对具体新增资源的明确许可，不能安装/下载模型权重、训练/推理框架、大型软件、运行时镜像或浏览器包；不能通过 CI、容器或子代理绕过。

本项目为 Node.js 内置模块构建的本地 API 网关。优先复用既有零第三方运行时结构和已配置的远端/现有模型 API；配置模型别名不等于拥有权限部署本地模型。历史研究/说明不授予安装许可。

开发前读 `README.md` 与既有测试；新增依赖或下载任务必须先按 `RESOURCE_APPROVAL.md` 提供体积/成本/替代方案，并取得用户明确授权。无证据的模型安装或测试标记 `NOT_RUN_RESOURCE_APPROVAL`，不能称为通过。

# ModelGate 开发入口

先执行上方资源预检规则；再读 [docs/audit-20261108.md](docs/audit-20261108.md) 的验证边界和 [docs/development-plan.md](docs/development-plan.md) 的当前任务。实现或改测试前读 [CONTRIBUTING.md](CONTRIBUTING.md)；改协议/路由时读 [架构](docs/explanation/architecture.md) 和 [配置参考](docs/reference/configuration.md)。

- 用 `git status --short` 核对现场，保留既有未提交改动；提交时明确写集。
- 默认 `npm test` 只跑自包含 mock。旧测试会改目标配置，先按 [测试指南](docs/how-to/testing.md) 准备可丢弃实例。
- 生产端口 8787、用户 systemd 服务、私有配置与账号凭据独立于源码。使用 `MG_CONFIG_DIR` 隔离 keys/local/stats，显式设置日志路径与测试主密钥。
- 凭据与真实请求正文不进提交、日志或报告。测试使用虚构 Key，本地 mock 不消耗真实上游额度。
- 修改 API/配置时同步配置参考与回归；变更行为需在 CHANGELOG 的 Unreleased 中记录。
- Windows `.bat/.cmd` 保持 CRLF、无 BOM。旧 docs/archive 仅作溯源；历史运行状态不可作为当前证据。
- 完成任务后更新开发计划：已执行命令、结果、未验证项；不得把 mock 测试当真实上游验收。
