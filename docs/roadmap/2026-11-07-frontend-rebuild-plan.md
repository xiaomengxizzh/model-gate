# ModelGate 控制台前端完全重做计划 V1.0｜2026-11-07

> **授权范围：从零重建前端的视觉、布局、DOM、交互和前端代码；只借用旧控制台作为功能/HTTP 契约清单，不复用现有 admin.html 的 CSS/JS/页面结构。** 当前文档是方案，不能直接删除生产文件。审查基线 main @ 7d616cc1507d2889bc726b192a21db409f316518；后端并行计划见 2026-11-07-gateway-platform-plan.md。

## 一、决策：完全放弃旧前端，保留网关内核

现有 src/admin.html 为约 84KB/743 行（按仓库 fetch 文本计数），包含 CSS、布局、页面脚本、图表、弹窗和数据调用，紧密耦合。当前三个顶层标签是模型配置、数据统计、运行日志；已支持 Provider 管理、Model 管理、defaults.directory、虚拟模型、Provider/Model 探测、路由预览、鉴权令牌、保存/重载、7/30/90 天模型 token 图、日志、暗/亮模式等。用户要求完全弃用该 UI，**但不是删除后端功能或丢弃配置数据**。

前端应成为让不懂 API 配置的人也能完成“接入 Provider → 配置模型 → 在 Codex/DSH 使用 → 定位 400/429/断流 → 控制配额”的专业操作控制台，而非仅做新的皮肤。

## 二、目标信息架构（新设计，不照搬旧布局）

桌面 1440px 优先，响应式向下兼容小屏。一级导航建议：
1. **总览 Dashboard**：服务在线/降级、最近请求、成功率（无数据不伪造）、p50/p95、token 趋势、429/5xx、最近告警、最近实际落地模型；顶部快速动作新增 Provider/Model、测试连接、查看诊断。
2. **供应商 Providers**：卡片/表格切换，供应商名称、真实 URL（敏感部分掩码）、认证来源状态、协议（Chat/Responses/Anthropic/Gemini）、可用能力、连接测试、调用延迟、当前故障/限流。新增与编辑使用清晰分步表单，支持独立 Key/代理/headers 高级区。
3. **模型与路由 Models & Routing**：真实模型、别名、虚拟模型、client access key、默认目录与 fallback、QPS/并发/额度、reasoning effort、路由优先级；支持可视化 route preview（只读）和安全的草稿保存。
4. **客户端连接 Clients**：Codex CLI/桌面、DSH、其他 OpenAI 兼容客户端的接入向导、可复制 Base URL 和测试 profile，展示支持的 wire、有效模型、会话头、配置未验证警告；始终保留 auth.json，不在网页展示/收集 OAuth Token。后端未提供该能力前，可静态说明，不伪造连接状态。
5. **监控与诊断 Observability**：时间范围、Provider/Model 过滤、真实请求状态码、attempt、trace、stream/429/Retry-After 详情，搜索和脱敏日志、延迟/Token/缓存趋势；图表无法提供时显示“数据不可用”，不能用静态演示值伪装。
6. **安全与设置 Security & Settings**：管理令牌会话、全局重试/timeout/代理模式、预热开关、保留时长、只读配置版本与诊断、备份/恢复向导（未实现的后台功能显式不可用），危险操作二次确认。

首页简洁高信息密度，不堆积所有表单；提供全局搜索/筛选、清晰的空状态与引导，页脚展示当前 Gateway / API 版本和数据最近更新时间。

## 三、视觉系统与体验要求

- **彻底重设计**：简洁专业、成熟 infra 控制台气质，层次分明、统一 8px/4px spacing、清晰排版与视觉层级。不要沿用旧 admin.html 的赛璐璐外观、玻璃卡片、颜色体系、按钮、弹窗或 HTML 树；避免只换配色的伪重构。
- 设计 tokens：排版、层级、颜色、边框、圆角、间距、交互状态；同时提供可用的 light / dark，遵守 prefers-reduced-motion。图形需有图例和表格替代，不依赖颜色独自编码错误。
- 上游状态用“正常/降级/不可达/未经测试/未知”区分；Probe 成功不等于真实 Chat 推理、工具调用或流式运行通过。
- 操作表单：字段帮助、格式校验、敏感字段单独遮蔽、废弃配置提示、操作反馈（成功/失败/部分成功）、长任务显式进度、保存前 diff 预览、放弃修改确认。
- 交互一致：键盘可达、Tab 顺序、可见焦点、表单 label、可关闭 dialog、aria 状态/状态提示、屏幕阅读器语义；目标符合 WCAG 2.2 AA 的相关准则。不得滥用纯 hover 操作。
- 响应式断点建议：>=1280 宽侧边栏+主内容；768–1279 可折叠侧栏；<768 单列、底部/抽屉导航；数据表提供横向滚动并保留首列标签。1024/768/390 作为最低检查视口。
- 性能：首屏不用外部 CDN/在线字体/大型组件套件，静态文件体积可控；避免所有图表同时高频轮询。低频状态更新，隐藏页面暂停非必要轮询，避免浏览器持续重复请求。

## 四、技术方案（零下载默认）

**首选：纯原生 HTML + CSS + 现代浏览器 ES modules + SVG/Canvas，后端 Node 原生静态文件服务；不引入 React/Vite/Next/Tailwind/Chart.js 作为强制依赖。** 这符合现有项目“零第三方运行时”边界，也避免重复下载。若确有理由引入第三方库，只写替代方案与预估体积，先检查宿主已有安装/共享缓存，得到用户明确授权前不执行 npm install、npx、curl、浏览器包下载或 CI 自动拉取。

建议新建隔离目录 src/ui-next/（目录名称可依据 repo 风格微调），组件化模块：
- index.html 仅语义壳 + 导航容器；
- styles/tokens.css、base.css、layout.css、components.css；
- js/app.js、router.js、state.js、api-client.js、auth.js、forms.js、formatters.js；
- views/dashboard.js、providers.js、models.js、routes.js、clients.js、diagnostics.js、settings.js；
- components/*：table、dialog、field、status-tag、toast、chart、empty-state；可在不改变技术栈的前提下重新组织。

必须是**从头编写的新 UI**，不能将旧 admin.html 拆文件后冒充重做，不能复制旧 CSS、脚本、DOM 作为基本骨架。旧 UI 只用于列操作与 API 行为，Git history 为回滚保留。待新 UI 全部验收且由用户批准上线后才移除生产入口的旧 admin.html；历史记录不会破坏。

## 五、后端契约映射（以 src/index.js 实际代码为准）

| 功能 | 已有控制面路径 | 新 UI 最低要求 |
|---|---|---|
| 登录检测 | GET /api/auth | 显示是否需管理 Token，区分锁定/无连接/认证失败 |
| 网关总览/配置快照 | GET /api/status | Provider/模型/虚拟模型/全局统计；保留 configVersion |
| 配置保存 | POST /api/config/save | 携带 version、409 冲突处理、保存前仅提交已允许字段 |
| Key 更新 | POST /api/keys | 单独保存或清除，响应成功后才提示成功；绝不回显真实 Key |
| 管理令牌 | POST /api/admin-token | 明确用户交互，重认证，错误反馈 |
| 上游探活 | POST /api/probe | 单项、批量；明确探针类型，避免误判推理可用 |
| 模型调用测试 | POST /api/model-test | 选择模型、明确真实调用成本提示，错误显示 |
| 路由预览 | POST /api/route-preview | 路由链与治理限制可视化，不直接触发推理 |
| 统计曲线 | GET /api/model-stats?days=N | 1/7/30/90 天（服务端允许范围），空数据正确显示 |
| 日志 | GET /api/logs?lines=N | 带脱敏、过滤、复制，最多合理行数 |
| 读取文件配置 | POST /api/config/reload | dirty state 警告、确认后重新加载 |
| 数据面 | GET /v1/models、POST /v1/chat/completions、实验 /v1/responses | 仅接入说明或安全的显式调用，不在 UI 自动发真实 LLM 测试 |

后端尚未提供的 Client 运行会话/限额/trace endpoint 必须由网关轨道定义并交付后才能接入；前端先使用**标记 DEMO/MOCK 的匿名 fixture** 做 UI 集成。新增 API 需要稳定 schema、feature flag、版本迁移、明确状态码并由后端先验收。

现有旧前端将管理令牌存于 localStorage（src/admin.html），新界面禁止把明文管理 token/API Key 写入 localStorage、URL query、持久化调试日志；建议内存态为默认，用户明确选择单次标签页记住时可审查 sessionStorage 风险。服务端权限检查依旧不可依赖前端隐藏按钮。

## 六、阶段 F0–F5 与验收

### F0｜功能盘点、UX 文档与契约冻结（先做）

对照旧 admin.html 的所有用户操作做迁移矩阵：保留/重新设计/明确废弃、API 路径、权限、失败路径、完成状态。产出 docs/ui/feature-parity-matrix.md、docs/ui/design-system.md、docs/ui/screen-flow.md、API fixtures 与界面文字表。先从已有 API 确认字段，不猜未实现。确定完整页面线框描述和移动端规则。此阶段仍不删除旧 UI。

**验收**：所有旧业务能力（含虚拟模型 Key、默认目录、路由模板、代理模式、保存冲突）有明确归宿；不存在只画 Dashboard 的缩水方案。

### F1｜全新 UI 框架、基础交互（P0）

src/ui-next/ 新建纯前端壳、主题、导航、状态容器、错误边界、loading、empty、disabled、dialog、toast、API client、认证页。提供访问新 UI 的独立试验路径（如 /ui-next），默认 / 继续提供旧 UI。未经授权不改生产入口。

**验收**：各页面可导航、键盘可用、手机/桌面布局完整、离线静态示例可展示；关闭 JS 后基本降级提示合理；敏感数据无持久化。

### F2｜供应商/模型/虚拟模型完整功能（P0）

新增/编辑/删除、Key、代理、fallback、虚拟模型目录、默认目录、版本冲突、危险操作确认和测试/预览，全部通过 API client 与真实管理 API 对接。复杂表单采用草稿，保存失败不覆盖已加载原状态；若 409 显示冲突差异、重载/手动合并，禁止自动覆盖。支持高级字段结构化编辑/只读警示，不能静默删去不认识的扩展字段（Codex provider 专用 fields 也属于此类）。

**验收**：本地 mock 和 8788 开发实例能完成 CRUD/独立 Key/409 并发/回滚；旧配置逐一来回读写结构一致，不丢 Key/未知字段。

### F3｜总览、统计、诊断、客户端指引（P1）

统计数据按实际接口绑定；Provider/Model 健康、错误细分、用量、缓存、可复制安全诊断摘要。Codex/DSH 接入指南只使用当前后端实际可支持模式（如 Draft PR 尚未合并，Responses 显示实验/暂不可用）；不能出现“已连通”占位欺骗。模型测试必须显式确认可能产生费用。

**验收**：处理无统计/无 API Key/服务断开/错误 400、401、409、429/大量日志等状态，出错时前端可恢复；测试按钮有真实反馈。

### F4｜可用性、隐私、安全与性能（P1）

键盘和可访问性审查、HTML 注入/XSS 防护（日志、provider 名、header 值一律文本输出，不插任意 HTML）、移动响应式、高对比、暗色主题、页面隐藏时暂停轮询、重连退避、导出结果脱敏。分离静态内容与认证 API，设置严格 CSP 与只允许 localhost 的管理界面访问策略（需后端协同）。

**验收**：测试 390/768/1024/1440px，明暗主题；无浏览器控制台未处理异常；关键操作支持键盘；长名单/长日志仍可用；不把 token 存 localStorage。

### F5｜影子部署、验收与替换旧入口（P0）

在隔离 8788 下运行新 UI，分阶段测试与旧 API 兼容。功能矩阵、截图/录屏（无秘密）、手动可用性检查、权限/保存/回滚全部通过后，另开“旧 UI 退役 PR”，明确将 / 或 /admin 入口切到新 UI，旧源代码删除只在用户批准与有 Git rollback/历史版本时执行；旧 UI 作为静态历史不再生产加载。不得在规划阶段或未验收前直接删除 src/admin.html。

**验收**：全功能迁移矩阵 PASS；旧数据、providers、models、virtualModels、keys、stats 保持不变；新 UI 真实可用，原生产 8787 不受开发期影响。

## 七、前后端并行与交付顺序

先等待网关轨道 G0 管理 API contract 冻结，F0/F1 可先基于现有 API 同时进行，F2/F3 在契约可用后对接。前端不得为适配 UI 而自行修改数据面逻辑，后端新增字段先写 schema/fixture。两条轨道用独立分支和工作目录；发生并行 Git/配置冲突暂停写入。后端 Codex PR #2 也独立审计，前端不主动合并。

## 八、严格资源门禁与测试证据

**新增大型安装/下载：无；历史提议仅供研究，不自动执行。** 任何依赖大小不限，先审查宿主安装版本、共享缓存与重复下载风险；本机状态无法检查写 UNKNOWN_LOCAL_STATE 并停止下载。未经用户对具体资源明确授权不得安装重型前端框架、模型权重、训练包、容器镜像、Playwright/Chromium 浏览器包、额外服务。优先现有 Node 和系统浏览器；浏览器测试仅使用已存在环境。

真实 API Key/Token/用户对话不得泄漏或上传。测试证据按 STATIC / MOCK_PASS / DEV_PASS / REAL_PASS / NOT_RUN 分开记录。PR 包括 screenshots、键盘/响应式结果、行为矩阵、API 兼容性、审计 SHA 与回滚说明，不接受只有漂亮截图没有可操作功能。

## 九、必读材料

AGENTS.md、RESOURCE_APPROVAL.md、README.md、package.json、src/admin.html（仅行为审计，不复用）、src/index.js 里 /api/* 及 buildStatus/saveConfig/saveKeys、src/router.js、docs/phased-execution-plan.md、docs/roadmap/2026-11-07-gateway-platform-plan.md。启动提示词：docs/roadmap/2026-11-07-frontend-executor-prompt.md。
