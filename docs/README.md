# 文档索引

| 需要做什么 | 文档 |
| --- | --- |
| **当前所有者批准的 V2 范围：单一 DeepSeek + Codex 原生压缩** | [V2 现行产品契约](product/2026-11-14-owner-scope-v2.md) |
| **直接执行的新伪代码计划（优先 Desktop、Go、原生压缩）** | [V2 聚合实施计划](roadmap/2026-11-14-go-deepseek-native-compact-plan.md) |
| **启动主代理与最多 5 个子代理** | [V2 Agent Team 启动词](roadmap/2026-11-14-go-deepseek-native-compact-start.md) |
| 查用户批准的不可降级产品目标、完整真实验收 | [ModelGate 产品契约 MG-R001..MG-R012](product/2026-11-14-owner-product-contract.md) |
| 直接执行聚合模式开发（伪代码、模块、测试与 PR） | [2026-11-14 聚合完整执行计划](roadmap/2026-11-14-aggregation-pseudocode-plan.md) |
| 激活主代理与最多 5 名专职子代理 | [Agent Team 直接执行启动提示词](roadmap/2026-11-14-aggregation-agentteam-start.md) |
| 首次启动独立实例 | [教程](tutorials/local-start.md) |
| 保留 Codex 原生套餐，同时接入其他订阅模型 | [Codex 多 provider 接入](how-to/codex-multi-provider.md) |
| Codex 原生父子代理与应用套餐授权 | [订阅路由边界](explanation/codex-subscription-routing.md) |
| 测试与回归 | [测试指南](how-to/testing.md) |
| 运行、配置、排错 | [运维指南](how-to/operations.md) |
| 查询配置与环境变量 | [配置参考](reference/configuration.md) |
| 查询当前管理 API 契约 | [管理 API v1（未冻结）](contracts/management-api-v1.md) |
| 查询请求预算/取消/SSE 背压契约 | [请求生命周期契约（未冻结）](contracts/request-lifecycle-v1.md) |
| 查询 Responses/Codex 接入设计 | [Responses 契约（Chat 桥 + 原生透传）](contracts/responses-v1.md) |
| 查询 UHR 推理回执契约 | [UHR 推理回执 v1](contracts/uhr-inference-v1.md) |
| 查询 UHR MCP 委派契约 | [UHR MCP v1](contracts/uhr-mcp-v1.md) |
| 查询 Codex 历史只读与额度三态契约 | [Codex 历史/额度 v1](contracts/codex-history-quota-v1.md) |
| 查询新控制台每个操作对应的 API/鉴权/错误 | [新控制台 ↔ 管理 API 适配矩阵](contracts/ui-next-api-matrix.md) |
| 查询管理面 UI 投影/保存/409 契约 | [管理面 UI 投影 v1（草案）](contracts/management-ui-projection-v1.md) |
| 前端 F0 联调样例与调用矩阵 | [管理面投影 fixture v1](contracts/fixtures/v1/README.md) |
| 部署/替换/回滚托盘管理器 | [托盘部署（Linux/Windows）](how-to/tray-deployment.md) |
| 查协议桥字段映射与有损转换 | [协议桥映射](reference/protocol-bridge.md) |
| 安装、升级、回滚与停机语义 | [部署与回滚](how-to/deploy-and-rollback.md) |
| 回滚、降级与紧急禁用开关 | [回滚与禁用](how-to/rollback-and-disable.md) |
| 查询能力支持矩阵（已实现/禁用/证据要求） | [支持矩阵](roadmap/2026-11-11-support-matrix.md) |
| 本轮加固循环的交付结论、P0 收口证据与未执行项 | [加固循环交付报告](roadmap/2026-11-11-hardening-delivery.md) |
| 查询 Node/平台支持边界 | [兼容矩阵](reference/compatibility.md) |
| 既有后端/前端重建目标 | [G0–G4](roadmap/2026-11-07-gateway-platform-plan.md)、[F0–F5](roadmap/2026-11-07-frontend-rebuild-plan.md) |
| 理解项目术语 | [术语表](reference/glossary.md) |
| 理解模块边界和数据流 | [架构说明](explanation/architecture.md) |
| 查视频异步任务池的存储/恢复决策 | [ADR-0001 Video 任务池](explanation/adr-0001-video-task-pool.md) |
| 确定当前已修复项及验证限制 | [2026-11-08 审计](audit-20261108.md)、[2026-11-09 浏览器 smoke](audit-20261109-browser-smoke.md) |
| 查真实客户端（DSH CLI）经网关调上游的验证证据 | [2026-11-09 DSH CLI × ModelGate 验证](roadmap/2026-11-09-dsh-cli-live-verification-report.md) |
| 验收整合候选版、查看分支取舍与合并/回滚条件 | [2026-11-09 整合候选验收报告](roadmap/2026-11-09-integration-candidate-report.md) |
| 查逐能力分支差异、已知问题与风险等级 | [后端能力差异审计](roadmap/2026-11-09-backend-diff-audit.md) |
| 查看浏览器截图与客户端 Mock 证据 | [2026-11-09 整合证据](evidence/2026-11-09-integration/browser-acceptance.txt) |
| Codex 聚合身份/目录/管理面设计 | [ADR-0002](explanation/adr-0002-codex-aggregation-identity.md)、[Codex 管理面 API](reference/codex-api.md) |
| 聚合模式接口契约与文件写入范围（A1–A5 绑定） | [聚合接口 ADR](architecture/2026-11-14-aggregation-interfaces.md) |
| 接手 Codex 聚合交付（看这里先） | [Codex 聚合 HANDOFF](roadmap/2026-11-11-codex-aggregation-handoff.md) |
| 安排后续工作 | [开发计划](development-plan.md) |

[旧上下文入口](project-context.md) 已迁移为导航；[archive/2026-08](archive/2026-08/README.md) 只保留历史，不定义当前开发顺序。
