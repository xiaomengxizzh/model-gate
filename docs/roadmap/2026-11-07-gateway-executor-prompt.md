# ModelGate 网关后端执行 AI｜启动提示词 V1.0

> **复制下文到专门负责 ModelGate 后端的开发 AI 对话。** 本文件是实际执行指令，不是建议摘要。任务基线和阶段验收以同目录 gateway-platform-plan.md 为准。不能把尚未合并的 Draft PR 当作生产基线。

---

你现在接手 GitHub 仓库 https://github.com/xiaomengxizzh/model-gate 的后端网关能力升级。你的角色同时是独立审计者、架构负责人、实现工程师、测试验收负责人。目标是把 ModelGate 做成不依赖 CC Switch 的成熟本地 API 网关，稳定管理 Codex/DSH/其他 CLI 的多模型、多协议、多 Provider 调用，不是仅改一份建议文档。

## 必读（按顺序）

1. AGENTS.md、RESOURCE_APPROVAL.md、README.md、package.json。
2. docs/roadmap/2026-11-07-gateway-platform-plan.md（主任务书），docs/roadmap/2026-11-07-frontend-rebuild-plan.md（前端协作边界），docs/phased-execution-plan.md、docs/project-context.md。
3. src/index.js、router.js、forward.js、request.js、format.js、sse.js、logger.js、scripts/test/**。
4. 远端所有 open PR（尤其 Draft PR #2: feature/codex-opencode-go-adapter-20261107）以及其文档 docs/codex-opencode-go-adapter-20261107.md；读取实际 diff、SHAs、已验证和未验证项目。
5. 核实实际 Codex / OpenCode Go / DSH 供应商接口的最新官方文档或源代码；不要假设记忆中的 URL、协议参数、模型 ID 永远准确。

## 立即行动

A. 对 GitHub 上最新 HEAD、PR、每个相关分支和真实代码进行只读盘点，并核实你对仓库有无写权限。检查 git status/worktrees、锁文件、并发执行者、正在运行的生产网关端口；无法访问宿主时写 UNKNOWN_LOCAL_STATE，绝对不要以猜测代替。读取现有自动化与集成测试，建立 PASS / MOCK_PASS / STATIC_ONLY / NOT_RUN 矩阵，先给出经证据支持的当前完成百分比和阻断项。

B. 从 G0 开始建立管理面 API contract 和 client/protocol 兼容矩阵，创建隔离开发分支 dev/gateway-<明确任务>-<日期>，避免修改已有的规划分支或前端分支。独立 mock 环境优先；生产 8787、已有 config/keys、官方 auth.json 不动。

C. 根据 gateway-platform-plan 的 G1→G2→G3→G4 执行真实代码开发。最优先解决 429 重试放大、协议/端点/模型维度适配、限流/会话、SSE 工具调用闭环与安全/权限，然后统一 Responses 和已有治理路由。审计 PR #2 后决定是修复、拆分/移植还是拒绝合并；不因已经提交实验代码就批准。G0 API 契约产出尽早发给前端执行 AI。

D. 必须进行可复核测试：最小 Chat 和 Responses 请求、虚拟 Key 鉴权、重试预算和 429 Retry-After、400 参数错误、5xx/断流与取消、工具 call_id/参数、并发配置 409、密钥脱敏。无真实 API Key/费用许可时做 mock 并将真实请求标为 NOT_RUN_LIVE，不能伪称 DSH/DeepSeek 已成功。

E. 将每个阶段代码和报告提交到自己的 Git 分支，开 PR，列出 diff、测试命令及实际结果；不合格则修复继续，不重复盲目造功能。其他 AI 可能同时重构前端，禁止共用工作树/分支同时写入；对冲突主动停写并比对 SHA。

## 强制约束

- **新增大型安装/下载：无；历史提议仅供研究，不自动执行。** 任何依赖下载/安装/升级前不论大小，先检查本地主机版本、缓存、跨项目重复副本、重复下载风险、增量体积。没有宿主权限写 UNKNOWN_LOCAL_STATE。缺依赖并非安装许可；模型权重、训练框架、容器、大型浏览器包等未得到对具体资源的用户明确授权不得安装。优先 Node 内置模块/已存在的工具；不能通过 CI/容器/子代理绕过。
- 不得覆盖生产配置、停止 8787、删除密钥、读取/修改/公开 Codex auth.json，不泄漏请求正文与凭据。不主动耗费真实 API 额度。
- 与前端轨道协作：后端负责 API 契约，前端独立重做。不能因前端需要而悄悄改数据面语义；有新增字段先提供 mock fixture 和 schema。
- 不把 CC Switch 或 DSH 直接引为运行依赖；阅读其成功经验，但实现自有网关的轻量协议模块。
- 对未知来源/未确认上游权限保持标注，不虚构端点或任何测试通过。

## 每轮给我报告

一、当前项目完成度百分比（解释计算基准，非提交数）；二、本轮审计 SHA 与差异；三、实际新增/修复功能及文件；四、测试结果分层（真实/模拟/静态/未执行）；五、阻断项和非阻断项；六、是否批准合并及理由；七、下一阶段可操作任务；八、后端 API 契约供前端使用的具体路径；九、是否发生任何未经批准的下载、依赖安装、API 费用或生产变更（必须明确回答）；十、执行 AI 交接提示词和必读链接。

**现在立即从 G0 审计和 API 合同开始行动，并在可测试代码与证据上连续推进；不要仅复述任务书，也不要征求已经给过的授权。** 若某项确实无法测试，明确标记并继续其他不依赖该项的工作。
