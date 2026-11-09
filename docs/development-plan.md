# 开发计划与任务状态

基线日期：2026-11-08。**新增大型安装/下载：无；历史提议仅供研究，不自动执行。** 资源执行遵守 [RESOURCE_APPROVAL.md](../RESOURCE_APPROVAL.md)。范围：在现有 Node 内置模块架构上提升 Chat 网关的安全性、资源边界、协议一致性和可维护性，再扩展其他模型能力。下表是后续任务状态唯一来源；历史 phase 计划仅作需求来源。计划不是未来所有需求的承诺，新增需求先补契约与验收。

## 当前状态（2026-11-09 第二批收口）

分支 `dev/gateway-audit-20261108`。第一批三个提交：`33853d2`（契约基线 + P1 卡）、`522da4a`（旧套件隔离 + 日志脱敏性能）、`9a41547`（指标口径）。第二批（2026-11-09）：`5498c1a`（MG-002 预算/取消/背压 + 契约 + deadline 测试）、`42f06cd`（MG-009 投影契约/fixture/托盘文档）、`81b37e6`（MG-009 服务端投影清洗、Key 白名单、面板版本）、`027a97f`（MG-015 Responses 契约草案）。

已闭环：MG-016、MG-001、MG-003、MG-005、MG-007、MG-006、MG-004、MG-010（工程侧）、**MG-002（请求生命周期预算/取消/SSE 背压）**、**MG-009（服务端投影清洗/Key 白名单/面板版本，浏览器实跑待 F2）**、**MG-008（适配器半边 + 模型解析一致性 + 错误信封映射）**、**MG-011（capability 声明 + Embedding，chat/embedding 双向隔离、Gemini 适配、记账/探测/发现）**。
仍待办：MG-012 Rerank、MG-013 Audio/Image、MG-014 Video 异步任务池、MG-015 原生 responses 透传与真实客户端对照（Chat 桥已闭环）、MG-009 余项（不透明袋 D-1、只读配置投影 D-6、browser/托盘实跑）、MG-008/MG-011 真实上游对照（单独授权）。MG-002 二次复核：H1/M1–M3 PASS，M4 边界（已完成流误判超时）已修并补 AC-4e。

验证（本机 Node v24.22.2，全部离线 mock，未触真实上游）：

| 命令 | 结果 |
| --- | --- |
| `npm run check` | 退出码 0 |
| `npm test` | 14/14 隔离套件通过（新增 offline/deadline.test.mjs 13 用例，覆盖 MG-002 AC-1..AC-7） |
| `MG_ALLOW_LIVE_TESTS=1 node scripts/test/live.mjs` | 27/27 旧套件文件通过（133 断言，无 SKIP） |
| `npm run docs:check` | PASS |
| `node scripts/check-metadata.mjs` | PASS (21) |

未验证：GitHub Actions 远程执行、真实上游与计费、生产 8787 重启、Windows/macOS、Node 18/20 实跑。

已知遗留：`user-env-fallback` 的 Windows 分支在 Linux 上打印 N/A；`/api/keys` 的 id 仍无完整白名单（随 MG-009）；前端 F0–F5 全部 TODO，本轮只到契约基线。

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
| MG-015 / P1 | **Chat 桥已闭环（2026-11-09）**：`/v1/responses` 入口 + 请求/响应映射 + SSE 事件桥 + 拒绝矩阵；剩余原生 `api:"responses"` 透传与真实 Codex/DSH 对照。Draft PR #2 审计 **UNVERIFIED** | MG-002、MG-004、MG-016 | 工具 call_id/arguments/custom tool、SSE 顺序、完成/失败、取消/usage/权限/配额全部 wire 测试；真实 Codex CLI/桌面与 DSH 对照单独授权；不改官方 auth.json |
| MG-008 / P2 | 已闭环（2026-11-09）：适配器 wire 保真（22 例）+ 模型解析单一入口 + 错误信封映射；剩余真实上游对照（MG-015/单独授权） | MG-002、MG-004、MG-006 | 固定 wire fixtures；分片/断流/重连/多 tool-call 索引测试；显式列出有损转换；探测、预热、failback 采用一致模型解析 |
| MG-009 / P2 | 契约、fixture 与服务端实现已闭环：D-2 投影字段剥离、D-7 Key 版本、D-3 baseVersion、`/api/keys` 白名单（§8.3）；剩余：浏览器真实鉴权/保存回读（F2）、未知字段不透明袋 D-1、只读配置投影 D-6、provider 删除联动清 Key、托盘 smoke | MG-003、MG-005 | 浏览器真实鉴权和保存回读；未知字段保留；无静默洗配置；Linux/Windows 托盘有单独 smoke 记录，价格为用户输入。离线回归已过；浏览器/托盘实跑 **NOT EXECUTED** |
| MG-010 / P2 | 已交付：CI 矩阵 18/20/22（手动触发、零下载探测 runner 自带 node）、元数据核对脚本、LICENSE、部署/回滚与兼容矩阵文档 | MG-004、MG-007 | 本地 21 项元数据 PASS + 启动/关闭/恢复实测；**远程 CI 未执行**；Windows/macOS 与 Node 18/20 实跑未验证 |

## 第三阶段：能力扩展（按卡启动，不一次铺开）

| ID / 优先级 | 交付范围 | 依赖 | 验收标准 |
| --- | --- | --- | --- |
| MG-011 / P3 | **已闭环（2026-11-09）**：`models.<名>.capability`（chat/embedding）；`/v1/embeddings` 入口、OpenAI 透传 + Gemini batchEmbedContents 适配、Anthropic 拒绝；记账/探测/模型发现六处打通；虚拟模型不支持 embeddings | 第一阶段、MG-008 | offline/embeddings.test.mjs（批量上限、dimensions、fallback、能力隔离、预算） |
| MG-012 / P3 | Rerank | MG-011 | 排序分数/索引稳定；批量限制、模型路由和预算测试；兼容现有 Chat |
| MG-013 / P3 | Audio、Image | MG-011、MG-002 | 单能力单卡；multipart/二进制体积、超时、计费单位和取消契约；对不支持的桥接明确拒绝 |
| MG-014 / P3 | Video 异步任务池与持久化 | MG-007、MG-013 | 先 ADR 决定存储与 Node 版本要求；幂等创建、状态轮询、取消、重启恢复、GC；真实预算与外部发布单独授权 |

虚拟模型 priority、exact/prefix 匹配为候选需求，待 MG-003 确立名称匹配/冲突契约后单独立卡；现阶段保留精确名称语义。不要将字段预留当已实现。

## 下一位 AI 的第一张卡

G0 契约基线（MG-016）、第一阶段 P1 卡（MG-001/002/003/005）与 MG-004/006/007 已闭环。下一批按依赖顺序：

1. ~~**MG-008 余项**（P2）：模型解析一致性、错误信封映射~~ **已闭环（2026-11-09）**。
2. **MG-009**（P2）：管理面配置编辑与状态投影分离、`/api/keys` id 白名单、前端 fixture；契约与 fixture 已先行（docs/contracts/management-ui-projection-v1.md、docs/contracts/fixtures/v1/），实现写集 src/index.js、src/admin.html。
3. ~~**MG-015**（P1）：Responses/Codex 接入~~ **Chat 桥已闭环（2026-11-09）**；剩余原生响应透传与真实客户端对照。
4. ~~**MG-011**（P3）：capability 声明与 Embedding~~ **已闭环（2026-11-09）**。
5. **MG-012**（P3）：Rerank（下一张卡）——新增 capability `rerank`、`/v1/rerank` 入口与 provider 适配，复用 capability/记账/探测/发现与预算。

同一时刻一个文件一个作者：MG-008 与 MG-009 都改 src/index.js，必须串行；MG-015 的 format.js/router.js 写集与二者不重叠。全部完成后由 Lead 统一提交并更新本表。

并行分派记录（2026-11-08 第二批）：MG-004、MG-008、MG-010 写集互不重叠。2026-11-09 第二批：MG-002 由 Lead 独写 src/ 四文件；mg002-tests 只写 scripts/test/offline/；mg015-spec 只写 docs/contracts/responses-v1.md；mg009-fixture 只写 docs/contracts/management-ui-projection-v1.md、docs/contracts/fixtures/v1/、docs/how-to/tray-deployment.md。2026-11-09 第三批：MG-008 余项由 Lead 独写 src/（router/request/index/forward/format）；MG-015 纯映射模块由 mg002-tests 只写 src/responses.js 与 scripts/test/offline/responses-mapping.test.mjs，接线待其后串行。
