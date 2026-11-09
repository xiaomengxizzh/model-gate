# 开发计划与任务状态

基线日期：2026-11-08。**新增大型安装/下载：无；历史提议仅供研究，不自动执行。** 资源执行遵守 [RESOURCE_APPROVAL.md](../RESOURCE_APPROVAL.md)。范围：在现有 Node 内置模块架构上提升 Chat 网关的安全性、资源边界、协议一致性和可维护性，再扩展其他模型能力。下表是后续任务状态唯一来源；历史 phase 计划仅作需求来源。计划不是未来所有需求的承诺，新增需求先补契约与验收。

## 2026-11-09 整合候选分支（integration/modelgate-next）

起点 `35bed9b`（`dev/gateway-audit-20261108` @ `3a4ba89` + ui-next 三个预览提交）。候选分支只做整合与新增，不改写审计分支历史；旧 `/` 与 `/admin` 保留。

已完成：G1 429 归因 / Retry-After / 工具请求不重放移植；管理面配置投影修复（虚拟模型 `expiresAt/note`、`clientKey` 掩码）；`/ui-next` 静态资源安全服务与数据面 `out.headers` 透传；六大功能区前端（Dashboard / Providers / Models & Routing / Clients / Observability / Security & Settings）与共享草稿/409 事务；浏览器验收 14/14；Codex CLI 0.167 与 DSH 0.2.2-rc.1 经真实上游 `deepseek-v4.1-flash` 最小链路 PASS（3 请求 / 18,809 tokens）；分支已推送并创建 Draft PR #5。

验证：`npm test` 28/28 隔离套件；`npm run check` 0（含 15 个 UI 模块语法）；`npm run docs:check` PASS；`node scripts/check-metadata.mjs` PASS (21)；浏览器证据见 [验收报告](roadmap/2026-11-09-integration-candidate-report.md)。

未验证/阻断：真实工具执行（Codex/DSH shell/apply_patch）因宿主 bwrap user namespace 不可用 NOT_RUN（未使用跳过沙箱参数）；Codex Desktop 未启动；429/5xx 故障注入未做；Web 备份/恢复无后端 API（NOT_SUPPORTED）。生产 8787、systemd、真实 Key 与用户私有配置均未触碰。

## 当前状态（2026-11-09 第三批/真实链路验证收口）

分支 `dev/gateway-audit-20261108`。第一批三个提交：`33853d2`（契约基线 + P1 卡）、`522da4a`（旧套件隔离 + 日志脱敏性能）、`9a41547`（指标口径）。第二批（2026-11-09）：`5498c1a`（MG-002 预算/取消/背压 + 契约 + deadline 测试）、`42f06cd`（MG-009 投影契约/fixture/托盘文档）、`81b37e6`（MG-009 服务端投影清洗、Key 白名单、面板版本）、`027a97f`（MG-015 Responses 契约草案）。

已闭环：MG-016、MG-001、MG-003、MG-005、MG-007、MG-006、MG-004、MG-010（工程侧）、**MG-002（请求生命周期预算/取消/SSE 背压）**、**MG-009（服务端投影清洗/Key 白名单/面板版本，浏览器实跑待 F2）**、**MG-008（适配器半边 + 模型解析一致性 + 错误信封映射）**、**MG-011（capability 声明 + Embedding，chat/embedding 双向隔离、Gemini 适配、记账/探测/发现）**、**MG-012（Rerank：/v1/rerank、OpenAI/Cohere 适配与稳定排序）**、**MG-013（Audio/Image：multipart 原样转发、二进制响应、体积/预算/取消）**、**MG-014（Video 异步任务池：创建/幂等/轮询/取消/重启恢复/GC，ADR-0001）**、**MG-015（Chat 桥 + 原生 responses 透传；真实客户端对照 UNVERIFIED）**、**MG-009 余项（D-1 不透明袋 + D-6 只读配置投影；浏览器/托盘实跑仍 NOT EXECUTED）**。
代码侧全部卡片已闭环。剩余仅为需要授权/环境的验证：MG-009 浏览器真实鉴权/保存回读/托盘实跑（NOT EXECUTED）、MG-015 真实 Codex/DSH 对照与 Draft PR #2 审计（UNVERIFIED）、MG-008/011/012/013/014 真实上游对照与计费（需单独授权）、Windows/macOS 与 Node 18/20 实跑。MG-002 二次复核：H1/M1–M3 PASS，M4 边界（已完成流误判超时）已修并补 AC-4e。

验证（本机 Node v24.22.2，全部离线 mock，未触真实上游）：

| 命令 | 结果 |
| --- | --- |
| `npm run check` | 退出码 0 |
| `npm test` | 14/14 隔离套件通过（新增 offline/deadline.test.mjs 13 用例，覆盖 MG-002 AC-1..AC-7） |
| `MG_ALLOW_LIVE_TESTS=1 node scripts/test/live.mjs` | 27/27 旧套件文件通过（133 断言，无 SKIP） |
| `npm run docs:check` | PASS |
| `node scripts/check-metadata.mjs` | PASS (21) |

未验证：GitHub Actions 远程执行、真实上游与计费、生产 8787 重启、Windows/macOS、Node 18/20 实跑。

### 第三批（2026-11-09）真实客户端链路验证

**真实链路已跑通（不再是 UNVERIFIED 的那一格）**：DSH CLI `0.2.2-rc.1` 作为真实客户端，经隔离网关 8788 调 OpenCode 上游 `deepseek-v4.1-flash`（`reasoning_effort=high`）——流式文本、`read`/`glob`/`bash` 工具调用、同 SID 续传三回合全部 exit 0、`turn_end.reason.kind=completed`、final 非空；错误路径（未知模型/上游 400/上游 500/首字节超时/缺 Key）两端可读且不泄露 Key。证据与边界见[验证报告](roadmap/2026-11-09-dsh-cli-live-verification-report.md)。

本轮命令结果（本机 Node v24.22.2）：

| 命令 | 结果 |
| --- | --- |
| `npm run check` | 退出码 0 |
| `npm test` | **25/25** 隔离套件通过（新增 offline/user-env.test.mjs 5 用例） |
| `npm run docs:check` | PASS |
| `node scripts/check-metadata.mjs` | PASS (21) |
| `MG_ALLOW_LIVE_TESTS=1 node scripts/test/live.mjs` | 27/27 旧套件文件通过（133 断言，无 SKIP） |

本轮代码改动：`src/router.js` 增加用户级环境读取的测试注入点与 `readEnvironmentDir(name, baseDir?)`（运行时行为不变），回归见 `scripts/test/offline/user-env.test.mjs`。

仍未验证：真实上游故障注入（本轮用本地 mock 复现错误路径，未为制造故障消耗额度）、生产 8787/systemd 服务重启、`/responses` 通道与虚拟共用名 `gatemodel` 的真实上游往返、Windows/macOS 与 Node 18/20、GitHub Actions。

另记：本轮复现了 **DSH 侧**流式 tool_call 参数「整串重发被重复拼接」导致的 `MALFORMED_RESPONSE`（归因、最小复现与修法建议见报告 §6.1），以及 CLI/网关两侧档位白名单必须一致（§6.2）；两项都不属本仓库代码，网关 OpenAI chat 路径逐字节透传，不受影响。

已知遗留：`user-env-fallback` 的 Windows 分支仍未在 Windows 实跑（Linux 分支已由 `offline/user-env.test.mjs` 覆盖）；`/api/keys` 的 id 仍无完整白名单（随 MG-009）；前端 F0–F5 全部 TODO，本轮只到契约基线；网关 502 信封「已循环兜底约 120s」文案与实际耗时不符（待单独立卡）。

### 第三批续（2026-11-09 晚）：剩余验证闭环

用户指示「暂时不做多端适配」，其余可执行项本轮跑完。唯一口径见[验证报告](roadmap/2026-11-09-dsh-cli-live-verification-report.md) §7，摘要：

| 项目 | 结果 |
| --- | --- |
| MG-015 DSH 真客户端 `/v1/responses`（修复 `include` 后） | **PASS**（rc=0、completed、final 非空） |
| MG-015 `/v1/responses` 真上游 非流式 + 流式 | **PASS**（200；SSE created→…→completed，无 `[DONE]`） |
| MG-015 虚拟共用名 `gatemodel` | **PASS**（`model=gatemodel serving=deepseek-v4.1-flash`） |
| MG-015 真实 Codex CLI 0.167 | **PASS**：`wire_api="responses"` + 丢弃不可表达工具后，真实回合 rc=0、输出 `CODEX_OK`，并有真实工具往返（`exec_command pwd`） |
| MG-015 Draft PR #2 审计 | **DONE**：不合并原样（旁路 forwardChain/预算/治理；仅 `noRetry429` 值得移植） |
| MG-008 anthropic 协议真上游 | **BLOCKED（上游 402 余额）**；同轮证明真实 402 → 目录链兜底 200 正常 |
| MG-011/012/013/014 真上游 | **NOT_EXECUTED**：现有 7 个模型全是 `capability=chat`，新增媒体/向量模型属「模型+计费」决策 |
| MG-009 双标签 409（API 层） | **PASS**（带 `version` 过期 → 409 + currentVersion，配置不变） |
| MG-009 托盘 Linux 实跑 | **NOT_EXECUTED**：缺 `gir1.2-ayatanaappindicator3`（按资源门禁不自行安装） |
| Windows/macOS | **SKIPPED**（用户指示） |
| Node 18/20 | **NOT_EXECUTED**：本机仅 v24.22.2，装第二运行时需授权 |

本轮代码改动：Responses 桥对 `include` 只接受可安全丢弃项（`reasoning.encrypted_content` / `output_text.logprobs`）并记 lossy，其余仍显式拒绝；否则真实 Codex/DSH 无法使用 `/v1/responses`。契约与 `offline/responses-mapping.test.mjs` 同步。

## 暂停点（2026-11-09 收口，等待用户真实验证）

状态：分支 `dev/gateway-audit-20261108` 已推送远端，HEAD `298e9b0`（本轮四个提交：`4fec9ad` / `1396bb7` / `3a651ee` / `298e9b0`）。代码侧任务卡全部闭环，**不再继续开发**；等用户真实验证后按下面清单恢复。

待用户真实验证（按顺序）：

1. **生产实例**：以既有方式启动 `model-gateway.service`（8787），核对 `/healthz` 与 `/api/status` 的 provider `hasKey`/`keySource`——本轮全程未触碰 8787，仍是 inactive。
2. **真实客户端三连**：Codex CLI（`wire_api="responses"`）、DSH headless（`api: openai-responses` 或默认 chat）、任一 OpenAI 兼容 SDK；判据见[验证报告](roadmap/2026-11-09-dsh-cli-live-verification-report.md) §7。
3. **有损项确认**：网关日志 `responses 有损转换 …` 是否符合预期（Codex 的 `web_search`/`multi_agent` 经 Chat 桥不可用，属设计内丢弃；要支持只能走原生 `api:"responses"` 上游）。
4. **能力卡 MG-011/012/013/014**：需要一个真实 embedding/rerank/audio/image/video 模型才能做真上游对照（属"模型+计费"决策，本轮 NOT_EXECUTED）。
5. **托盘（Linux）**：需 `gir1.2-ayatanaappindicator3`（属安装授权）；`scripts/tray/mg-tray-linux.py` 仍是未跟踪文件。

恢复开发前先读：本文件「当前状态」、验证报告 §7/§8、`CHANGELOG` 最新两节。

环境备注（非本仓库代码，`2026-11-09` 已修）：`~/.workbuddy/mcp.json` 与 `aitool/mcp/tool-gate/gate.json` 里 5 处 Node 绝对路径原先指向已删除的 `v22.23.2`（`~/.nvm/...` 与 `~/.local/share/nvm/...` 两种写法都有），导致 GitHub MCP 完全不可用；已改为现存的 `v24.22.2` 并各自备份（`*.bak-20261109-140208` / `*.bak-20261109-140326`），`tool_find "github"` 已能发现 26 个 github 工具。下次升级 Node 需同步这两个文件。遗留：`gate.json` 的 obsidian 项 vault 路径 `knowledge/resource/aistudy` 不存在，且 obsidian-mcp 提示需要 `--legacy`（未改，待决定）。

## 本轮完成

| ID | 交付 | 验收证据 |
| --- | --- | --- |
| MG-A01 | 无全局 Key 时仍校验虚拟模型独立 Key；保留全局 Key 与本地匿名入口语义 | offline/boundary.test.mjs |
| MG-A02 | 转发剥离管理/Google 凭据头、Host 和 Connection 指定的逐跳头 | offline/boundary.test.mjs |
| MG-A03 | 管理/数据面 body 限制；超限可返回 413，非法 Chat JSON 返回 400 | offline/boundary.test.mjs |
| MG-A04 | 探测采用模型协议、上游模型映射和协议鉴权头 | offline/probe.test.mjs |
| MG-A05 | 默认测试隔离；旧测试显式门禁；修正旧用例的生产端口/Key 路径 | run.mjs、utils.mjs；npm test |
| MG-A06 | 配置保存克隆 defaults，避免提前改内存对象；补齐现有模型状态字段回归 | offline/boundary.test.mjs、代码审查 |
| MG-A07 | QPS 为等待请求预留负余额，避免一批并发请求同时醒来突破限速 | boundary 的 10 并发、5 QPS 时序断言 |
| MG-A08 | 文档分层、AI 入口、开发规范、CI 与本地链接检查 | npm run docs:check；CI 本轮未远程运行 |
| MG-016 | 管理 API v1 契约基线：逐路径 schema/鉴权矩阵/错误信封/敏感字段/偏离清单/前端调用矩阵 | offline/admin-contract.test.mjs、offline/admin-secrets.test.mjs、scripts/test/offline/harness.mjs；docs/contracts/management-api-v1.md；v1 仍未冻结 |
| MG-001 | 管理面来源策略：Host/DNS 重绑定白名单、跨源 Origin 拒绝、无令牌时仅本机可管理、非回环绑定告警 | offline/admin-origin.test.mjs（4 组，含局域网对端实测）；docs/reference/configuration.md |
| MG-003 | 配置结构校验单一入口、保留键拦截、删除墓碑（重启不复活）、并发版本冲突 | offline/config-schema.test.mjs（4 组）；src/index.js、src/router.js |
| MG-005 | 日志脱敏词表随配置热更新、代理内嵌凭据与 Bearer 兜底、端到端验证错误摘要不落明文 | offline/logger-secrets.test.mjs；src/logger.js、src/index.js（collectSecrets） |
| MG-009 余项 | `GET /api/config` 只读配置投影（D-6：五大业务键+configVersion、剥离运行时字段、不返回 keys/paths、clientKey 掩码）；admin.html `_extra` 不透明袋（D-1：未知字段编辑/保存不丢，`serializeMap` 合并回送） | offline/config-projection.test.mjs（3 组：投影形状/鉴权与保存回读/面板静态检查）；management-api-v1.md、management-ui-projection-v1.md |
| MG-015（原生透传） | `models.api="responses"` 时 `/v1/responses` 不经 Chat 桥：请求原样转发到 `responsesPath`、providerModels 覆盖、非流式 JSON 透传+model 回写、流式 SSE 逐字节管道（不翻译）；拒绝矩阵/能力隔离仍生效；预算与错误透传 | offline/responses-native.test.mjs（4 用例）；docs/contracts/responses-v1.md §9 |
| MG-014 | Video 异步任务池：capability `video`；`POST /v1/videos`（Idempotency-Key 幂等）、`GET /v1/videos/:id`（惰性+后台轮询）、`POST /v1/videos/:id/cancel`、列表；任务持久化 `<config>/videos.json`（原子写）、状态机与终态幂等、重启恢复、7 天保留/500 上限/24h 过期 GC；上游路径可配置；只桥接 OpenAI 兼容 | offline/video.test.mjs（6 用例：创建轮询、幂等、取消、重启+GC、隔离/协议、校验/预算）；docs/explanation/adr-0001-video-task-pool.md；npm test 22/22 |
| MG-013 | capability `audio`/`image` + 四个媒体入口：speech（JSON→二进制）、transcriptions（multipart 原样转发）、images/generations（JSON）、images/edits（multipart）；multipart 只解析 model 字段、per-上游覆盖名替换、文件字节不动；响应 content-type/字节透传；请求体 maxBodyBytes、响应体 mediaMaxResponseBytes（超限 media_too_large）；能力隔离/fallback/预算/记账；不支持的协议显式 502 | offline/media.test.mjs（8 用例）；docs/reference/configuration.md；npm test 21/21 |
| MG-012 | capability `rerank` + `/v1/rerank`（兼容 `/rerank`）：OpenAI 兼容 `/v1/rerank` 与 Cohere `/v2/rerank` 适配，结果按分数降序/同分 index 升序稳定排序、top_n 裁剪、model 回写；能力隔离、fallback、探测、记账、预算 | offline/rerank.test.mjs（6 用例）；docs/reference/configuration.md；npm test 20/20 |
| MG-011 | capability 声明（chat/embedding）+ `/v1/embeddings`：OpenAI 透传、Gemini batchEmbedContents 适配、Anthropic 拒绝；双向能力隔离；usage 记账、/v1/models 与 /api/status 暴露 capability、/api/model-test 按能力探测；批量上限/dimensions/fallback/预算测试 | offline/embeddings.test.mjs（7 用例）；docs/reference/configuration.md；npm test 19/19 |
| MG-015（Chat 桥） | `/v1/responses` 入口：responsesToChat 请求映射 + 拒绝矩阵、chatToResponse 非流式整形、流式事件桥（复用 relayStream 续传/预算/背压）、降级单帧；原生 responses 透传与真实客户端对照仍待 | offline/responses-mapping.test.mjs（17）+ responses-endpoint.test.mjs（6）；docs/contracts/responses-v1.md §9 |
| MG-008（余项） | 模型解析单一入口 `modelTarget`（转发/探测/预热/failback 一致）；warm/probeChat 按 api+providerModels 整形 path/body/鉴权头；非 OpenAI 原生错误信封映射为 OpenAI 形状 | offline/model-resolution.test.mjs（7 用例）；docs/reference/protocol-bridge.md §5；npm test 16/16 |
| MG-008（协议桥半边） | format.js 11 项修复（tool_result 合并、Gemini usage/finish/thought 过滤、tool_choice 等）+ 22 例 wire 测试 + 有损转换清单；sse.js 同帧 finish、forward.js 空 tools 判定 | offline/wire-format.test.mjs；docs/reference/protocol-bridge.md |
| MG-004 | 27 个旧套件迁移为 OS 临时目录 + 动态端口 + 本地 mock（新增 isolate.mjs/README 证据表），utils 删掉"读改写目标配置"入口与 SKIP 语义，live.mjs 每文件独立子进程 | MG_ALLOW_LIVE_TESTS=1 node scripts/test/live.mjs → 27/27 文件、133 PASS、0 FAIL/SKIP |
| MG-006 | 指标口径分离：一次请求只计一次对话请求（token/缓存回调只累加数值）、状态字典按当前配置裁剪、对话/模型统计硬上限 | offline/metrics.test.mjs（2 组）；src/index.js、src/forward.js |
| MG-007 | 统一关闭接口 close()（定时器清理 → 排空连接 → 原子落盘）、SIGTERM/SIGINT 优雅退出、损坏 stats 先备份再重建 | offline/lifecycle.test.mjs（2 组）；src/index.js |
| MG-010 | Node 18/20/22 CI 矩阵（仅手动触发、零下载探测 runner 自带 node）、元数据核对脚本、LICENSE、部署/回滚与兼容矩阵文档 | scripts/check-metadata.mjs（21 项 PASS）；.github/workflows/check.yml；远程 CI **未执行** |
| MG-009（服务端+面板） | D-2 保存剥离投影运行时字段（未知扩展保留）；`/api/keys` id 白名单（§8.3 并集 + meta 写保护）；D-7 Key 保存带版本；D-3 dirty 冻结 baseVersion | offline/admin-projection.test.mjs（4 组）；npm test 15/15；live 27/27 |
| MG-002 | 新增 `src/budget.js`（请求级 deadline + AbortSignal 单一来源）；预算覆盖读 body/全部排队（QPS、provider/模型并发、429 退避）/代理 CONNECT/等头/非流式读体/SSE 中继与续传，并钳制 `loopMs`；排队 waiter 可取消（移除 + 归还 QPS 令牌 + release 恰好一次）；SSE 背压（write=false 暂停读上游、等待 drain，30s/8MiB 上限）；预算耗尽 504 `request_timeout`（流式则 `code=REQUEST_TIMEOUT` 错误事件 + `[DONE]`）；客户端断开始终取消且不熔断 | offline/deadline.test.mjs（13 用例，AC-1..AC-7）；docs/contracts/request-lifecycle-v1.md；npm test 14/14；npm run check 0 |

## 与既有计划的映射

保留远端 [网关 G0–G4 计划](roadmap/2026-11-07-gateway-platform-plan.md) 与 [前端 F0–F5 重建计划](roadmap/2026-11-07-frontend-rebuild-plan.md) 的目标、边界和验收。这里作为逐卡状态入口补充其执行顺序，不把前端重做改成旧 UI 换皮。G0 本轮仅部分完成；Draft PR #2 及真实 Codex/DSH/OpenCode Go 对照尚未审计/验收。

- G0：MG-016 管理面契约和兼容矩阵；当前已有 [API 初稿](contracts/management-api-v1.md)，未冻结。
- G1：MG-001 至 MG-007，MG-002 还须统一 attempt budget 和 429 Retry-After，防多层重试放大；不能仅靠本轮 QPS 修复宣称 429 已解决。
- G2：MG-015 Responses/Codex 接入，与 MG-008 协议保真一起完成。
- G3：MG-011 至 MG-014 多能力；G4：MG-009/010 交付。
- 前端：F0 先以契约盘点；F1 从头构建独立原生 UI 壳；F2 接入配置与 Key；F3 统计诊断；F4 可访问性/安全/性能；F5 影子部署并经批准替换入口。以上全部 TODO，独立工作树，不改本轮后端写集，不据旧页面存在宣称重建完成。

## 第一阶段：稳定性与安全（先完成，再扩展能力）

MG-002 已闭环（离线故障注入），其余条目均为 **TODO**；下列“现状”区分已从代码确认的限制与需要专项复现的风险。每张卡实现前补一个失败复现，提交时写实际结果和未验证项。

| ID / 优先级 | 现状与目标 | 依赖 | 验收标准 |
| --- | --- | --- | --- |
| MG-016 / P1、先做 G0 | 契约基线与离线回归已闭环（逐路径 schema、鉴权矩阵、错误信封、敏感字段、前端调用矩阵、偏离清单）；PR #2 仅核对元数据、未审计实现；前端 fixture 归 MG-009/F0 | 无（已完成，待 MG-001/003/005 后冻结 v1） | 每个管理路径鉴权/默认值/错误/409/敏感字段契约测试；前端确认 fixture；明确 PR SHA 和真实 vs mock 边界 |
| MG-001 / P1 | 已闭环：Host 只收 IP 字面量/白名单；跨源 Origin 403；未设令牌时仅本机可管理；非回环绑定且无令牌打 error 级告警 | 无 | offline/admin-origin.test.mjs；迁移说明见配置参考「管理面来源策略」 |
| MG-002 / P1 | **已闭环**：`src/budget.js` 单一 deadline/AbortSignal 贯穿读 body、排队、代理 CONNECT、等头、读体、SSE 与续传；队列可取消并归还令牌；SSE 尊重 write 背压（drain 等待 + 8MiB 上限）。独立 review 与二次复核已完成：H1（取消/超时混淆）、M1–M4（含已完成流边界）已修并补 AC-1b/4c/4d/4e/6e | 无 | offline/deadline.test.mjs（17 用例）；契约见 docs/contracts/request-lifecycle-v1.md；余项：修复后二次 review、真实上游对照 |
| MG-003 / P1 | 已闭环：形状/保留键单一入口；删除墓碑；并发 409 | 无 | offline/config-schema.test.mjs；余项：/api/keys 的 id 白名单（低频，待 MG-009 一起定） |
| MG-004 / P1 | 已闭环：旧套件全部隔离（27/27 文件、133 PASS、无 SKIP）；`user-env-fallback` Windows 分支仍未在 Windows 实跑 | 无 | affinity/circuit/concurrency/QPS/SSE/配额/日志/加密全部迁移 OS 临时目录+动态回环端口；无 SKIP；失败清理；默认套件禁止外部网络 |
| MG-005 / P1 | 已闭环：secrets 词表随 reloadConfig 刷新；代理 userinfo 与 Bearer 兜底；错误摘要脱敏端到端验证；URL 凭据脱敏改线性扫描（128KB 单行 6.8s → 0ms，1MB 2ms） | MG-003 | 动态凭据、extraHeaders、代理用户信息均脱敏；植入测试秘密后扫描日志/状态无明文；最小必要错误信息 |
| MG-006 / P2 | 已闭环：request/attempt/completion 口径分离；对话请求只 +1；health/throttle/affinity/cacheStat 按配置裁剪 + 硬上限；对话 ≤80、byModel ≤500 | MG-004 | 请求/尝试/完成三种指标定义；一次请求只计一次；续传 usage 无重复；缓存/对话/延迟/路由状态有可测容量上限 |
| MG-007 / P2 | 已闭环：close() 幂等（停定时器/排空连接/最终原子落盘）、SIGTERM 退出码 0、损坏 stats 留证重建 | MG-002 | close 停止定时器、排空连接、最终原子落盘；SIGTERM/重启/损坏 stats 恢复测试；不损坏旧数据 |

第一阶段退出条件：所有 P1 卡通过离线故障注入和独立 review；默认测试覆盖主要既有能力；生产部署仍单独留收据。不能用新增功能抵消未关闭的安全/生命周期缺口。

## 第二阶段：Responses、协议与控制面

| ID / 优先级 | 交付范围 | 依赖 | 验收标准 |
| --- | --- | --- | --- |
| MG-015 / P1 | **代码已闭环（2026-11-09）**：Chat 桥（映射 + SSE 事件桥）+ 原生 `api:"responses"` 透传（JSON model 回写/SSE 逐字节）；剩余真实 Codex/DSH 对照与 Draft PR #2 审计（均 **UNVERIFIED**，需授权/联网） | MG-002、MG-004、MG-016 | 工具 call_id/arguments/custom tool、SSE 顺序、完成/失败、取消/usage/权限/配额全部 wire 测试；真实 Codex CLI/桌面与 DSH 对照单独授权；不改官方 auth.json |
| MG-008 / P2 | 已闭环（2026-11-09）：适配器 wire 保真（22 例）+ 模型解析单一入口 + 错误信封映射；剩余真实上游对照（MG-015/单独授权） | MG-002、MG-004、MG-006 | 固定 wire fixtures；分片/断流/重连/多 tool-call 索引测试；显式列出有损转换；探测、预热、failback 采用一致模型解析 |
| MG-009 / P2 | **代码闭环（2026-11-09）**：D-2 投影字段剥离、D-7 Key 版本、D-3 baseVersion、`/api/keys` 白名单（§8.3）、D-1 面板不透明袋、D-6 只读配置投影 `GET /api/config`；浏览器真实鉴权与保存回读 **PASS**（Headless Chrome，见 docs/audit-20261109-browser-smoke.md）；剩余双标签 409/完整 UI 交互与托盘 smoke（**NOT EXECUTED**）、provider 删除联动清 Key | MG-003、MG-005 | 浏览器真实鉴权和保存回读；未知字段保留；无静默洗配置；Linux/Windows 托盘有单独 smoke 记录，价格为用户输入。离线回归已过；浏览器/托盘实跑 **NOT EXECUTED** |
| MG-010 / P2 | 已交付：CI 矩阵 18/20/22（手动触发、零下载探测 runner 自带 node）、元数据核对脚本、LICENSE、部署/回滚与兼容矩阵文档 | MG-004、MG-007 | 本地 21 项元数据 PASS + 启动/关闭/恢复实测；**远程 CI 未执行**；Windows/macOS 与 Node 18/20 实跑未验证 |

## 第三阶段：能力扩展（按卡启动，不一次铺开）

| ID / 优先级 | 交付范围 | 依赖 | 验收标准 |
| --- | --- | --- | --- |
| MG-011 / P3 | **已闭环（2026-11-09）**：`models.<名>.capability`（chat/embedding）；`/v1/embeddings` 入口、OpenAI 透传 + Gemini batchEmbedContents 适配、Anthropic 拒绝；记账/探测/模型发现六处打通；虚拟模型不支持 embeddings | 第一阶段、MG-008 | offline/embeddings.test.mjs（批量上限、dimensions、fallback、能力隔离、预算） |
| MG-012 / P3 | **已闭环（2026-11-09）**：`/v1/rerank`（OpenAI 兼容与 Cohere v2 适配）、稳定排序/top_n/model 回写、能力隔离、fallback/探测/记账/预算；`documents` 上限 2048 | MG-011 | offline/rerank.test.mjs（排序稳定、批量限制、模型路由、预算、隔离） |
| MG-013 / P3 | **已闭环（2026-11-09）**：Audio（speech/transcriptions）+ Image（generations/edits）；multipart 原样转发（只改 model 字段）、二进制响应透传、请求/响应体积上限、overallMs 预算/取消、能力隔离、fallback；Anthropic/Gemini/Cohere 显式拒绝；媒体 probe 明确不执行（避免计费） | MG-011、MG-002 | offline/media.test.mjs（multipart、二进制、体积、预算、隔离、拒绝） |
| MG-014 / P3 | **已闭环（2026-11-09，ADR-0001）**：`/v1/videos` 创建/查询/取消/列表；JSON 文件持久化 + 原子写、重启恢复、终态幂等、7 天/500 条/24h GC；Idempotency-Key 幂等；上游路径可配置；只桥接 OpenAI 兼容；真实预算与外部发布仍单独授权 | MG-007、MG-013 | offline/video.test.mjs（创建/轮询、幂等、取消、重启+GC、隔离、预算） |

虚拟模型 priority、exact/prefix 匹配为候选需求，待 MG-003 确立名称匹配/冲突契约后单独立卡；现阶段保留精确名称语义。不要将字段预留当已实现。

## 下一位 AI 的第一张卡

G0 契约基线（MG-016）、第一阶段 P1 卡（MG-001/002/003/005）与 MG-004/006/007 已闭环。下一批按依赖顺序：

1. ~~**MG-008 余项**（P2）：模型解析一致性、错误信封映射~~ **已闭环（2026-11-09）**。
2. **MG-009**（P2）：管理面配置编辑与状态投影分离、`/api/keys` id 白名单、前端 fixture；契约与 fixture 已先行（docs/contracts/management-ui-projection-v1.md、docs/contracts/fixtures/v1/），实现写集 src/index.js、src/admin.html。
3. ~~**MG-015**（P1）：Responses/Codex 接入~~ **Chat 桥已闭环（2026-11-09）**；剩余原生响应透传与真实客户端对照。
4. ~~**MG-011**（P3）：capability 声明与 Embedding~~ **已闭环（2026-11-09）**。
5. ~~**MG-012**（P3）：Rerank~~ **已闭环（2026-11-09）**。
6. ~~**MG-013**（P3）：Audio / Image~~ **已闭环（2026-11-09）**。
7. ~~**MG-014**（P3）：Video 异步任务池与持久化~~ **已闭环（2026-11-09，ADR-0001）**。
8. ~~**MG-015 原生 responses 透传 / MG-009 余项**~~ **代码闭环（2026-11-09）**。

下一阶段只剩**需要授权或真实环境**的验证，不再新增功能卡：真实 Codex/DSH 与 PR #2 审计、真实上游/计费、浏览器与托盘实跑、Windows/macOS、Node 18/20。

同一时刻一个文件一个作者：MG-008 与 MG-009 都改 src/index.js，必须串行；MG-015 的 format.js/router.js 写集与二者不重叠。全部完成后由 Lead 统一提交并更新本表。

并行分派记录（2026-11-08 第二批）：MG-004、MG-008、MG-010 写集互不重叠。2026-11-09 第二批：MG-002 由 Lead 独写 src/ 四文件；mg002-tests 只写 scripts/test/offline/；mg015-spec 只写 docs/contracts/responses-v1.md；mg009-fixture 只写 docs/contracts/management-ui-projection-v1.md、docs/contracts/fixtures/v1/、docs/how-to/tray-deployment.md。2026-11-09 第三批：MG-008 余项由 Lead 独写 src/（router/request/index/forward/format）；MG-015 纯映射模块由 mg002-tests 只写 src/responses.js 与 scripts/test/offline/responses-mapping.test.mjs，接线待其后串行。
