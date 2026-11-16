# ModelGate 任务卡与验收矩阵

每卡初始为 TODO。执行时把状态和证据写到本轮独立账本，保留本模板。角色在[启动提示词](agentteam-start.md)，业务伪代码在[执行规格](plan.md)。以下路径为候选写集。文件超出卡范围时，由队长按同一里程碑拆出后继卡，先释放冲突写集。测试文件名如在目标分支缺失，优先扩展现有同职责套件。新增测试、接口和行为的文档变更随该卡一起审查。

## P00 固定基线与团队

- [ ] **P00 — 现场和权限收据**（队长 + QA，依赖无）。核对目标 repo、全部开放 PR、远端 refs、Git worktree、当前写者、lock、可用 Node 和现有工具。核验现有 `OPENCODE_API_KEY` 仅存在性，固定任务档位和本轮 delivery。盘点资源及 registry，失败写 UNKNOWN。QA 确认旧 main runner 默认会连 8787，采用静态判读与隔离语法门禁，不原样跑旧 runner。保存基线 ref 和候选源树；已有用户 worktree 保持原状。
- [ ] **P00 检查点。** 工作目录和运行目录独立，队长与五个角色最多一层，模型调用配置只有指定 provider/model。已核实的规则、已存在工具和外部缺口入账。本轮执行线只基于实际远端 main。

## M0 主干安全和可靠验收

- [ ] **M0-1 — 新建离线验证入口**（A，依赖 P00）。范围 `scripts/test/run.mjs`、`scripts/test/offline/harness.mjs`、现有离线测试文件、`package.json`。先实现显式离线用例清单、回环随机端口、临时 key/config、进程关闭。若 #5 runner 随源码耦合，只取当前 main 可支撑的夹具，分批迁移。**验收** 在没有 8787、空 HOME、无真实凭据的纯检出通过；未列入脚本不会被扫描执行；失败和超时正确退出、回收 PID。相关断言 `T-ENV-01/02`。
- [ ] **M0-2 — Key 三态与有效期**（A，依赖 M0-1）。范围 `src/index.js`、`src/router.js`、`src/admin.html`、现有 `key-encrypt`、`virtual-models` 或离线配置套件。只迁移经过现有加密路径的旧明文 Key，保持 env 优先。**验收** 请求省略、掩码、替换、显式清空结果各自匹配；无权限不修改；格式兼容和到期判定覆盖边界，非法值拒绝且日志脱敏。`T-KEY-01/02`。
- [ ] **M0-3 — 配置事务和重启恢复**（A，依赖 M0-2）。范围 `src/index.js`、`src/router.js`、拟 `src/config-transaction.js`、配置管理和恢复测试。把 key/token/config/reload 进入同一事务门，守住权限和旧格式。**验收** 正常提交后可读完整新代际；故障注入覆盖持久意图前后、每个发布步骤及 commit 前后；多个写者/外部修改下保留旧值或拒绝写入，任何情况不短暂放松鉴权。`T-KEY-03/04`。
- [ ] **M0-4 — 纯检出文档与门禁**（C，可与 M0-2/3 互斥写集并行，最终接线依赖 M0-1）。范围 `scripts/check-docs.mjs`、`scripts/check-metadata.mjs`、`.github/workflows/check.yml`、文档和独立 runner 配置。共享 `package.json` 由 A 收尾接线。**验收** 从干净 clone 检查 docs，无工作区外相对链接；元数据和现有 Node 版本匹配；CI 只复用 runner 已有能力，不触发模型、镜像或工具链下载。`T-ENV-03`。
- [ ] **M0 检查点。** A 和 QA 提交修复前失败证据及修复后全绿。主干继承 P0 已处理，文档检查可复验，现有用户配置可读。若 Key 事务未通过，集成线停留于上一绿 SHA，QA 和其他模块可继续独立工作。

## M1 统一推理执行

- [ ] **M1-1 — 一次发送、截止时间和取消**（B，依赖 M0）。范围 `src/request.js`、`src/budget.js`、`src/retry-policy.js`、拟尝试状态模块及 `deadline`、`retry-governance` 现有套件。**验收** 同一 deadline 覆盖排队、连接、请求写入、读头、流和恢复；尝试有单调阶段；已发状态未知、工具风险和取消不会触发错误重放；并发令牌按请求归还。`T-LIFE-01/02/03`。
- [ ] **M1-2 — SSE、原生与 Chat 桥**（B，依赖 M1-1 的状态契约）。范围 `src/sse.js`、`src/responses-stream.js`、`src/responses.js` 和现有映射/流测试。**验收** UTF-8 分块和 CRLF、完整与截断终态、文本与工具输出序列；不同 call ID 不串线，item ID 贯穿完成帧，未知字段明确拒绝或有损选择。`T-SSE-01/02`。
- [ ] **M1-3 — 主路径与观察接线**（B，依赖 M1-2、M2-1 的出站契约）。范围 `src/forward.js`、`src/index.js`、`src/logger.js`、Chat/Responses endpoint 与日志套件。**验收** 三条 Chat/Native/Bridge 主路径共用尝试与 429 规则；有效旧 Chat 客户端输出契约通过；token、请求、计费与真实来源可解释；日志、统计和错误信封仅保留必要信息。`T-LIFE-04`。
- [ ] **M1-4 — 可选端点与幂等**（B，依赖 M1-3）。对 `src/embeddings.js`、`src/rerank.js`、`src/media.js`、`src/videos.js` 按能力分四个提交，共享入口由同一写者接线。**验收** 各开放能力用同一策略入口；视频两个并发相同键只一次上游创建，异常可恢复，主体隔离；任何未达到契约的新增可选端点默认关闭并有拒绝测试。`T-OPTIONAL-01`。

## M2 Codex 身份、目录和实机双 Mock

- [ ] **M2-1 — 统一身份授权**（C，依赖 M0 与 M1-1 接口，模块可提前实现）。范围 `src/codex/identity.js`、`src/codex/auth.js`、目标构建适配和现有身份测试。接线由 C/B 顺序领取共享文件。**验收** 最终规范化目标和身份同一授权记录；不明、未声明或冲突目标零发送；官方密文/认证头/账号标识与原线程 ID 不进入第三方；同源供应商会话标识可重复，不同域不可关联。`T-ID-01/02`。
- [ ] **M2-2 — 一致目录世代**（C，依赖 M2-1）。范围 `src/codex/catalog.js`、`src/router.js`、`scripts/codex-catalog.mjs`、目录相关测试和文档。**验收** 元数据符合固定客户端版本；本地/远端目录与实际路由代际一致；未知/下架 ID 硬拒绝，别名和虚拟模型遮蔽拒绝；同名模型配置更改刷新，原子发布、回滚、重启和并发读一致。`T-CAT-01/02`。
- [ ] **M2-3 — CLI 同线程和 v2 边界**（C，依赖 M1-3 与 M2-2）。范围 `src/codex/interop.js`、转换映射及 `scripts/test/codex-e2e.mjs`、`codex-control-items`、`codex-interop`。在身份、体积与目录断言明确后接真实 CLI。**验收** 三轮回环双 mock，至少一条本机只读工具 call/output 闭环，零凭据和会话串线，目录无 fallback 警告；不透明 v2 项明确拒绝，网关不处理或伪造密文。无法取得已安装 CLI 时，协议 mock 仍须通过，客户端实机为 NOT_RUN 并保持聚合功能实验。`T-CLI-01/02`。

## M3 路由、账本和统一接线

- [ ] **M3-1 — 可追溯的候选选择**（D，依赖 M1-1 和 M2-1/2 的输入 schema，可在独立模块先实现）。范围 `src/routing/decision.js`、候选构造、现有 `codex-fallback`。**验收** 能力、健康、价格、授权各自决定入围与排序，理由稳定且无敏感信息；官方订阅从通用池排除；未知/过期事实和未授权目标不可入选。`T-ROUTE-01`。
- [ ] **M3-2 — 预算账本与恢复**（D，依赖 M0-3 事务约束和 M3-1）。范围拟 `src/routing/ledger.js`、持久化与账本测试。**验收** 并发总额、每日时间边界、重启、同键重复、过期价格和未知扣费可恢复；无实际费用记录不填零；已超预估如实对账并限制下一笔。`T-BUDGET-01/02`。
- [ ] **M3-3 — 决策接线、用量与禁用回退**（D，依赖 M3-2、M1-3、M2-2）。范围 `src/forward.js`、`src/index.js`、`src/native-usage.js`、现有 `codex-fallback-forward`。**验收** 上游 mock 看到的 model/provider 与裁决相同，每次发送前均有持久预留，运行中断后不重复扣费或重放；禁用智能调度时保留显式旧链，但复用安全检查。`T-ROUTE-02`。

## M4 控制面与产品可用性

- [ ] **M4-1 — 管理 API 安全**（C，依赖 M0-3；可在 M1 后并行模块，接线串行）。范围 `src/codex/api.js`、`src/codex/config.js`、`src/index.js` 入口和现有 Codex 配置 API 测试。**验收** 管理操作无明确 token/可信来源即拒绝；请求不能选任意文件，预览只返回白名单字段差异；普通产品模式的外部配置 apply/rollback 关闭，受控自管 fixture 使用版本和备份 ID。`T-ADMIN-01/02`。
- [ ] **M4-2 — 控制台与客户端导出**（C，依赖 M4-1，接口冻结后并行前端）。范围 `src/ui-next/js/{api,store,config-draft,save-flow}.js`、`views/clients.js` 与现有视图逐片提交。**验收** 面板展示来源、状态、目录与生效配置差异，401 清理旧展示、409 不覆盖用户值、失败可重试；客户端导出只含所拥有字段，核心操作与旧 UI 等价前保留旧入口。`T-UI-01`。
- [ ] **M4-3 — 历史诊断与额度应急**（C，依赖 M4-1/2 与 M3-3 回执 schema）。范围 `src/codex/history.js`、`src/codex/quota.js`、对应管理投影/UI 和现有测试。**验收** 历史只读、限制规模和路径根，迁移仅导出计划；额度可区分 fresh/stale/unknown，应急进入/退出可审计，缺官方可信来源时显示 UNKNOWN。`T-UI-02`。

## M5 委派和后续激活

- [ ] **M5-1 — UHR 推理契约与回执**（D，依赖 M3-3）。范围拟 `src/routing/inference-receipt.js`、`src/forward.js` 接线和契约夹具。**验收** 调用者、作用域、请求和尝试标识关联；请求只能使用授权候选和额度；回执按终态及未知用量输出，越权明确拒绝。`T-AGENT-01`。
- [ ] **M5-2 — 本地 MCP 与 mock UHR**（D，依赖 M5-1）。范围独立 adapter 实验目录、fixture、文档。默认以已有 MCP 工具能力或最小协议夹具验证。若缺可复用运行时，不增加依赖，交付 schema + 隔离 adapter contract，并标实际 Codex MCP 工具执行 NOT_RUN。**验收** 正常委派、重复、取消、重启、过期权限、超预算和结果回到原 call ID；不传完整对话/工作区内容。真实 UHR 需读到现行授权接口和明确写集，保持单独分支。`T-AGENT-02`。
- [ ] **M5-3 — 支持矩阵与退出策略**（D + QA，依赖已达到验收的各阶段）。写 README/支持矩阵、运维和回滚。**验收** 标注纯 mock、真实 CLI 本地 mock、真实官方、真实第三方、Desktop GUI、真实 UHR 各项。真实 UHR/授权/原生 v2 不满足时停用对应入口。已有 Desktop 环境允许独立 profile 且保证回环时可验 GUI，否则明确 NOT_RUN。

## R00–R01 最终验证与交付

- [ ] **R00 — 组合验证**（QA，依赖已接入切片）。干净检出集成提交。运行语法、默认离线、docs、metadata、选定集成、合成 Codex 和浏览器。固定测试脚本、版本和 SHA，记录失败和跳过。复核兼容、用户数据、凭据、打包内容和失败回退。
- [ ] **R01 — 最终交付**（队长，依赖 R00）。给出本地集成 SHA、每卡结果和证据、完整保留的回滚点，按 DELIVERY 选择本地、Draft 或满足门槛的合并。合并时先在可丢弃工作树验证合并树，合并后由 QA 绑定新 SHA 复验。若现有保护拒绝或检查缺失，记录并以已验证本地结果结案。

## 可执行测试矩阵

对应基线确实有这些命令时执行。新增测试先按文件/标题绑定矩阵 ID，再放进明确的离线清单。运行单主题可用 `npm test -- <主题>`，复核当前 runner 的筛选语义。最终基本门禁为 `npm run check`、`npm test`、`npm run docs:check`、`node scripts/check-metadata.mjs`。历史脚本先读再用，禁止直接执行不安全的全量 `test:live`。结果以每个断言的实际记录为准，历史 30/45 套件数只提供比较基线。

| ID | 测试入口或夹具 | 强制断言 |
| --- | --- | --- |
| T-ENV-01/02/03 | 新 runner 自检、`check-docs`、`check-metadata` | 空环境、只回环、隔离 HOME/config、超时回收、没有目录自动执行、纯检出链接和版本元数据一致。 |
| T-KEY-01/02 | 扩展 `admin-secrets`、`config-schema`、`virtual-models` | 保存时省略、掩码、显式替换、清空、旧值迁移、env 覆盖及到期前后。无凭据合法路由保持旧契约，受保护路由全程保留拒绝。 |
| T-KEY-03/04 | 独立配置恢复、并发 fixture | 模拟任意提交步骤失败、进程退出与重启，重读得到一致代际。授权、文件 mode、日志、外部变更和锁竞争证据齐全。 |
| T-LIFE-01/02/03/04 | `deadline`、`retry-governance`、`lifecycle`、各主端点 | 挂起队列取消、超时无超预算等待、429 归因与 Retry-After、已发送结果未知、402/404/5xx 分类、并发回收与上游真实命中次数。 |
| T-SSE-01/02 | `responses-mapping`、`responses-native`、`wire-format` | 字符与事件边界、终态唯一、工具 call/output 对应、arguments 增量、半截流、取消、背压及无隐式重放。 |
| T-OPTIONAL-01 | `embeddings/rerank/media/video` 合成上游 | 已启用适配器共用身份/取消/429，视频幂等隔离，默认关闭能力有明确响应。 |
| T-ID-01/02 | `codex-identity`、`codex-official`、`codex-opencode-session` | 双域普通合成请求，校验最终目标、目标身份、专用头和派生会话值。配置错误时零发送，官方 bearer 实际接入按独立授权。 |
| T-CAT-01/02 | `codex-catalog`、`codex-routing-catalog`、`codex-catalog-rollback` | 同世代、稳定 ID、回滚一致、热切换边界、真实 `debug models` 能加载且目标 slug 有完整 metadata。 |
| T-CLI-01/02 | 实际已装 CLI、三轮回环双 mock、`codex-interop` | 隔离空 HOME/CODEX_HOME，合成身份、实际命中分布和工具结果。相同 thread ID 跨三轮，目标目录可验证。拒绝 opaque v2 无上游命中。 |
| T-ROUTE-01/02 | `codex-fallback`、`codex-fallback-forward` | 不伪造 capability；裁决目标与执行一致，官方订阅排除，每次发送前审计，取消、短路、已提交状态的终态准确。 |
| T-BUDGET-01/02 | 新账本单元、并发与重启 fixture | 并发预留不过限，重复不双记；未知实际保留；成本超预估、跨日、重启和核销按同一账本收口。 |
| T-ADMIN-01/02 | `admin-origin`、`codex-api`、`codex-config-e2e` | 显式 admin、来源和文件注册；秘密字段不出现在投影、错误及日志；备份/回滚只作用测试自管根，409 保留旧内容。 |
| T-UI-01/02 | `ui-contract`、本机 Chrome 隔离夹具、`codex-history/quota` | 六路由、空/未知/401/409、导出、配置失败与重试，响应式、浏览器错误为零；只读历史/额度状态不改真实用户配置。 |
| T-AGENT-01/02 | MCP contract、mock UHR、`inference-receipt` | 一个只读任务从提交、轮询到结果，取消/幂等/重启/越权/预算均有断言。可选真实 UHR/GUI/官方认证分别独立验收。 |

真实产品上游、真实 Codex 登录、真实历史和正式服务访问为独立授权矩阵。开发团队的 OpenCode Go 会话只用于完成本计划。原始测试脚本和历史收据存在不等于获得执行它们的权限。
