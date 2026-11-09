# ModelGate｜新前端初稿及后端合并实施计划 V1.0

日期：2026-11-09。性质：**已落地的只读 UI 原型 + 待验收的分支整合计划**。本文件不是生产变更授权。禁止新增依赖下载，禁止任何模型权重或大型软件安装；遵守 AGENTS.md / RESOURCE_APPROVAL.md，先查已安装与共享缓存，即使是小依赖也需先行核查及明确授权。

## 1. 本轮落地内容

工作分支：dev/ui-next-integration-plan-20261109，起点为 dev/gateway-audit-20261108 @ 3a4ba8956732e2aabdff2cfce8a118107189542a。**不触及 main、8787 生产进程、用户的私有配置或 Codex auth.json。**

- src/ui-next/index.html：全新结构而非搬运旧 src/admin.html，左侧导航 + 六页信息架构 + 管理令牌解锁界面。
- src/ui-next/styles.css：原生 CSS token、深色导航、浅色内容、指标/供应商卡片、图表、表格、手机响应、暗色主题、减少动画模式。
- src/ui-next/app.js：实际读取同源 API；当前使用 /api/auth、/api/status、/api/config、/api/route-preview、/api/logs；文案区分真实 / 未知 / 未连接。所有来自上游与日志的文本经 textContent 插入，不用动态 innerHTML；令牌仅保存在标签页 JS 内存，不存 localStorage。
- src/index.js：将 /ui-next、/ui-next/styles.css、/ui-next/app.js 作为**精确白名单只读静态文件**提供；带 CSP 和 nosniff，不改已有 / 与 /admin。
- scripts/test/offline/ui-next.test.mjs：隔离临时实例测试静态资源、CSP、受保护 API、旧控制台入口，以及页面对真实 API 路径的静态契约；无外部请求。
- **此轮只读**：供应商 / 模型 / 虚拟模型浏览、状态与 token 趋势、路由预览、可复制 Base URL、脱敏日志读取、实例概况。没有保存配置、编辑密钥、付费探活、自动调用模型。按钮不得暗示已支持的写入。操作仍转向旧控制台。

预览入口（仅开发分支且服务运行时）：http://127.0.0.1:8788/ui-next。这里的 8788 **仅为隔离实例示例**，不是声明运行服务已启动。默认本地服务若使用该分支但仍绑 8787，则路径为 /ui-next。不得为查看初稿擅自启动、重启或改变现有 8787。

## 2. 当前分支形态与为何不能直接一键合并

审查基线（2026-11-09）：
- main：6bc6441，仍是旧 Chat 网关和旧 UI；仅 11-07 两轨规划已合并。
- dev/gateway-g0-g4-20261107：66f274c，main 前方 25 次提交；有 429 与 Codex 大量单元/隔离测试、Responses 实现，以及 85% 阶段性估计（旧口径）。
- dev/gateway-audit-20261108：3a4ba89，main 前方 43 次提交；真实 DSH 和 Codex CLI → OpenCode Go 链路、统一 budget、Responses Chat 桥与原生透传、多能力入口，以及更全面的工程审计。
- feature/codex-opencode-go-adapter-20261107：9a0bfe3，Draft PR #2 尚未合并；旁路统一治理，不得直接合并。
- 新 UI 初稿基于 audit 分支，需随 audit 版本进入候选整合分支，不能独立 cherry-pick 到原 main 后即宣称可运行（缺 /api/config 投影等后端契约）。

两条主要后端开发分支**互相分叉，且重叠修改 src/index.js / forward.js / request.js / responses.js**。禁止自动 git merge -X ours/theirs、整仓 reset、强推和用提交数量取代逐项验收。对比实现时特别关注：
1. Responses 工具处理差异：G0-G4 会把 namespace 展开成函数；audit 在 Chat 桥中丢弃 namespace/web_search 并记录 lossy。明确功能保真优先级，绝不能在 UI 显示“完整工具兼容”。
2. 429 / Retry-After / 非幂等重放：按请求预算、真实返回状态、尝试次数，设计统一策略；避免叠加重试导致额度问题恶化。
3. 配置服务与字段投影：/api/status 是显示态数组，/api/config 是可保存形态；不可把 status 原样写回配置。MG-003 409 语义、未知字段保留和代理凭据脱敏必须留存。
4. 多能力（embedding/rerank/audio/image/video）：audit 已实现 Mock，尚无完整真实服务验收；合并进产品要显式带“实验”能力标记。
5. 旧端点、现有 Key 加密、虚拟模型、统计持久化、SSE 中断语义不得回退。

## 3. 推荐分支拓扑（无生产写入）

合并目标不是直接更新 main，而是先建立 **integration/modelgate-next** 候选分支：
1. 锁定审计起点：记录 main / audit / G0-G4 / UI 当前 HEAD、git status、各 PR 状态与活跃 worktree；若有人同时写同一分支或文件，先协调，不进行并发覆盖。GitHub 远端无本机 worktree 状态时标 UNKNOWN_LOCAL_STATE。
2. 从 audit 的受审 HEAD 创建 integration/modelgate-next（新增分支、保持 audit 原分支不动）；**按路径移植新 UI 分支的三个 src/ui-next 文件、静态路由与测试**，避免把前端分支的父提交误当成 main 的依赖。
3. 对 G0–G4 逐能力检查 test、实现和 docs；先移植 audit 缺失且有证据的行为（如 429 上游归因和高级 tool namespace 策略），禁止整包合并 src/ 冲突。每项独立 commit 和审计说明。
4. 单独评估 Draft PR #2 可移植价值，优先精确落实 noRetry429 / Retry-After 等到统一链；**不合并独立 Codex 旁路**。
5. 在整合候选分支进行离线验收、隔离 8788 真实浏览器回归、有限成本的真实客户端验证；再创建 Draft PR 到 main，明确未验证项，等待用户决定正式合并。
6. main 合并后先在隔离服务灰度 /ui-next，旧 /admin 永远保留到 F5 功能矩阵、备份/回滚和用户批准均通过；生产入口 / 不提前替换。

## 4. 新前端与最终网关 API 对齐矩阵

| 页面 | 已使用接口 | 下一阶段必须补的能力 | 放行门槛 |
| --- | --- | --- | --- |
| Dashboard | GET /api/status | 可诊断状态、可追溯 trace 与客户端维度指标 | 空状态真实、指标不伪造、访问令牌正确 |
| Providers | GET /api/status | GET /api/config + POST /api/config/save 配置事务；独立 Key；按协议 Probe | 敏感 header 脱敏、未知字段完整保留、版本 409 |
| Models & Routing | GET /api/status；POST /api/route-preview | 真实/虚拟模型 CRUD、额度/effort/路由编辑 | 能力声明、fallback 与 schema 回归 |
| Clients | 本地当前 origin | Codex/DSH 配置向导、wire 与工具保真指示、连接自测 | 不读取/更改 auth.json；实测状态与协议能力分离 |
| Diagnostics | GET /api/logs；GET /api/status | 可查询 trace、429 与上游 status、会话聚合、成本来源 | 业务日志脱敏、无模拟在线指标 |
| Security & Settings | GET /api/config；GET /api/status | 管理令牌修改、Key 流程、保存差异、回滚 | token 不持久存储；带 version 事务；无静默覆盖 |

本版所有非 GET 的 API 调用**只有 /api/route-preview**，这是无推理、无计费的只读语义 POST。正式增加 /api/model-test、/api/probe 时必须让用户明确确认可能产生费用。所有客户端链接仅为文本说明，不能伪装连接成功。

## 5. 阶段性实施顺序与验收

- **I0：基线冻结与分叉审计**。四分支 SHA、diff、CI/本地测试证据、冲突矩阵、合并选择；无未解释高风险差异。预期 0 次依赖安装。
- **I1：统一后端数据契约**。保留 audit 的 /api/config 投影、请求 budget、加密 Key、权限；导入 G0–G4 独有且证据充分的能力；逐个 Mock / 同端到端用例回归。
- **F1：本初稿落地**。所有六页可打开；浏览器 390/768/1024/1440 检查；只读功能正常，静态/CSP/auth/空数据测试通过，端口与生产隔离。**本轮只完成代码提交，未在实际浏览器实跑就不能标 PASS。**
- **F2：配置编辑与保存**。基于 GET /api/config 原始对象的不可丢失事务：dirty state、差异对照、version 409、重载与回滚；Key 独立 POST /api/keys，失败不误提示成功；至少两个标签页并发测试。
- **F3：客户端与诊断**。明确 Codex CLI/桌面、DSH、Chat/Responses、工具保真、错误原始 status 和 Retry-After；Mock 成功和真实调用成功分开展示。
- **F4：安全/体验**。XSS/日志/密钥检查、CSP、键盘/屏幕阅读器、响应式、浅暗主题、断线/超时/大数据空白、无外部依赖与资源扫描。
- **F5：合并发布**。真实浏览器/可回滚测试完毕，用户批准从 /ui-next 切换正式 /；旧页面保留备份/历史；不触碰实际模型 Key、现有运行服务，除非用户对相关操作单独授权。

验收分层：STATIC_CHECK、MOCK_PASS、BROWSER_PASS、CLIENT_LIVE_PASS、UPSTREAM_LIVE_PASS、DEPLOY_PASS。任何一层缺证据必须标 NOT_RUN / BLOCKED，不能以主观百分比掩盖。

## 6. 禁止事项与回滚

- 不下载或安装任何第三方 UI 库、浏览器、模型、权重、训练套件；运行现有 Node 与系统浏览器前先检查本地已存在。
- 不覆盖用户运行中的 8787，不修改真实 API Key、生产 stats、Codex auth.json；不改 Git 全局配置、不强推、不代替 owner 批准 PR。
- UI 初稿撤销仅需停止使用 /ui-next；原 / 和 /admin 不受影响。候选分支需记录回滚 commit SHA，必须可用 git revert 反转 UI 的独立提交。
- 开发分支文档可能含旧状态，按当前源代码与最近实测记录优先；例如 “真实 Codex/DSH 均未执行” 已由 11-09 报告更正，但桌面端/完整高级工具仍未覆盖。
