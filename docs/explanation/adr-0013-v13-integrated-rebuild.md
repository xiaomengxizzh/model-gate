# ADR-0013｜V13.1 在现有 ModelGate 上增量重构，不建立平行网关

- 日期：2026-11-24
- 状态：Accepted（A1 架构决策；实现门禁见 A2–A7）
- 约束：Node >=24、原生 ES modules/Web、零新增第三方运行时依赖；旧 `/ui-next` 与生产 8787 不变。

## 背景

V13.1 是单文件多层覆盖原型；现有 ModelGate 已有配置事务、协议适配、虚拟模型、路由、Codex 三模式与原生能力边界。若按原型另建 state/dispatch/网关，会产生两套配置真源、两套调度与不可审计的“假成功”。

## 决策

1. **一个后端真源**：扩展 `src/index.js` 管理面、`config-transaction.js`、`router.js`、`forward.js`、`routing/*`、`aggregation/*`、`codex/*`。新资源 API 是现有事务/决策器的薄封装。
2. **独立预览前端**：新增 `/ui-vnext`，模块化为 api/store/router/components/pages；共享 V13.1 设计令牌。2026-11-25 所有者授权生产切换后，根入口改为 `/ui-vnext/`；`/ui-next/` 仅保留为回滚入口。2026-11-26 按所有者样例逐页重构视觉与布局，但数据、写事务和安全边界继续使用真实后端。
3. **稳定 ID 与兼容别名分离**：Service/Connection/Model/Pool/HarnessBinding 使用稳定 ID；现有 provider/model/virtual name 作为迁移与请求兼容层，不静默重命名。
4. **池复用 virtualModels**：先修 `cleanVms` 字段丢失，再扩展 poolId/member/revision/policy/refs。默认目录、虚拟模型和 Codex 角色目标保持可迁移，不另建 route engine。
5. **统一预算**：扩展现有 budget/retry-policy/decision/ledger，引入单请求 ledger；首次发送、重试、切换、恢复、等待都计数。正常长生成可无整体硬超时，但故障阶段、恢复与重试必须有总上限；取消/非幂等/未知提交优先停止。
6. **真实能力证据**：configured/detected/runtime-verified 分离；模板、Models.dev、mock、真实 HTTP fixture、真实浏览器、真实厂商/GUI 分层。任何未实现 feature `available:false`，UI 不显示空按钮。
7. **凭据边界**：Key 仅走后端现有加密通道；前端不持有、不存 localStorage、不导出。新增 `/api/capabilities` 投影不返回 `extraHeaders`、代理凭据或路径；旧 `/api/status` 与 `/api/config` 的敏感字段收敛列为 A3 P0，不能因新 UI 不渲染就视为全局安全完成。
8. **Codex 边界**：official 直连不走第三方池；route 零 GPT；aggregated 保留官方父与第三方子。父子调度、工具、同子续轮和压缩由 Codex 原生执行，ModelGate 不自建压缩/Agent Team。
9. **多 Harness 独立适配**：Codex、Claude Code、OpenCode、DSH 各自声明协议/配置/认证/压缩能力；xmxz 无官方证据前为规划。禁止一个 Harness 通过替代另一个。
10. **发布人工门禁**：隔离实例→真实 HTTP fixture→真实浏览器→获授权的真实 GUI/服务→同 SHA U/V/MG-R→所有者批准。push/merge/重启/切根一律不自动执行。

## 备选方案

- **按 V13.1 单文件复刻并逐渐接线**：拒绝。多层函数覆盖与模拟 state 会固化假数据、掩盖后端缺口。
- **引入 React/Vue/大型 UI 或网关框架**：拒绝。当前无依赖结构与既有原生组件足够；新增资源未授权。
- **新建独立路由/账户服务**：拒绝。会造成配置、额度、日志与回滚分裂。
- **先做 UI 写操作模拟，再补后端**：拒绝。违反真实反馈与无静默降级合同。

## 后果

- 正面：保留已有事务/协议/Codex 投资；可逐垂直切片验收；旧 UI 可回滚。
- 代价：A2 只读壳不会立即提供所有写流程；A3/A4 必须先补资源与预算，真实完整交付周期更长。
- 风险：现有 status/config 有敏感字段与虚拟字段丢失，必须在相关写切片前修复；不能因 UI 不渲染就视为安全。

## 触发复审

若稳定 ID 迁移需要双写、Codex 官方协议要求改变角色 provider、或新增运行时依赖，先更新本 ADR、契约与所有者授权，不静默实施。
