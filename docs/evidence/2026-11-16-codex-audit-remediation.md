# Codex 实际使用严格审计与修复（2026-11-16，所有者指令：审计→修复→合并→推送）

> 文档类型：**审计发现 + 修复交付 + 离线验证证据**。不是真实长会话/父子派单/原生压缩的 PASS_REAL 证明。
> 工作分支：`fix/modelgate-codex-audit-20261116`（基线 `8a6faea` = `feat/responses-ws-bridge-20261116`）。
> 本轮**零付费模型调用、零下载、零对真实上游的请求**；生产 `~/.codex` 与 `config/*.local.json` 在审计阶段只读。

## 1. 审计方法

三路并行深度审计（WS 桥/Responses 传输、codex 配置/目录/桌面集成、支线合并风险）+ 主代理逐条复核代码行号与生产配置/日志取证。所有 P0/P1 结论均经主代理亲自读码或离线复现确认，不采信未经复核的代理结论。

## 2. 发现与修复（按严重度）

| # | 严重度 | 缺陷 | 修复落点 |
| --- | --- | --- | --- |
| 1 | P0 | 续轮历史丢失：Codex 续轮帧只发增量 input，网关剔除 previous_response_id 却不重建；旧 WS 缓存只注入 function_call，HTTP 回落/淘汰/重启即失效 | `src/responses-continuation.js`（新）+ `src/index.js` 入口重建/捕获；WS 与 HTTP 共用；缺失 fail-closed 400 |
| 2 | P0 | TOML 段头带行内注释 → 追加重复段、非法 TOML、指纹自检通过 | `src/codex/config.js` HEADER_RE + 疑似段头 fail-closed |
| 3 | P0 | 生产 Go 路由无压缩能力声明；目录投影丢弃覆盖 → shell disabled、effort assumed medium（真机 spawn 被拒） | `src/aggregation/catalog.js` projectionEntry 继承 + `src/providers/opencode-go.js` GO_NATIVE_CODEX_DEFAULTS + `src/index.js` 路由默认 + `MANAGED_AGENT_CHILD_EFFORT='high'` |
| 4 | P1 | 多行字符串续行被当 owned 键改写 | config.js 多行状态跟踪（三引号/括号深度，引号感知） |
| 5 | P1 | 再次激活重置回滚基线 → 退出"恢复"出聚合态 | desktop-integration.js 基线继承 + `.bak.baseline` 稳定化 |
| 6 | P1 | 自有子文件换模型/effort 永久 409 | planManagedAgentChild 状态记录/规范形状识别 → upgrade |
| 7 | P1 | SSE 嗅探注释/BOM 开头或空 body → 无终态挂死；半关闭僵尸连接 | responses-ws.js 嗅探兼容 + end 必回终态 + 'end' 收尾 + 60s ping |
| 8 | P1 | WS 帧控制字段 type/generate 泄漏进上游 body；不强制 stream | runTurn 剔除 + stream:true |
| 9 | P1 | 健康 ok 把从未同步的 provider 计为健康 | handlers.js every(snapshotComplete) |
| 10 | P2 | 帧层：RSV/控制帧 fin+len/分片中新数据帧/UTF-8/closing 异步 | WsPeer 校验 + 同步 closing + 1007 |
| 11 | P2 | orphan-adopt seed 含 index → 位置漂移 id 变 | seed 去 index（碰撞循环仍保证唯一） |
| 12 | P2 | interrupt 双终态 + 空 output 抹掉部分输出 | 先停转发再 incomplete，回传累积 output |
| 13 | P2 | 轮次级陈旧头（turn-metadata/routing-hint/client-request-id）复用 | STRIP_HEADERS 剔除 |
| 14 | P2 | 目录回滚丢 aliases/officialSlugs | recordVersion 持久化 + rollback 继承 + 投影 alias 继承 |
| 15 | P2 | removeProvider 不查引用 → 状态漂移 | provider_in_use 守卫（force 显式越过） |
| 16 | P2 | Desktop 进程探测目录前缀误匹配 /usr/bin 全部进程 | 只认同一可执行文件（含符号链接/同目录同名） |
| 17 | P2 | owned 行替换丢行内注释；带注释单行数组误判多行 | splitTrailingComment 保留注释 + 判定修正 |

## 3. 离线验证（真实执行，本树）

- `npm test`：**132 suites / 1274 tests PASS / 0 failed / 3 skipped**（manifest 132/132）。
- `npm run check` / `contract:check` / `docs:check` / `gate:v2` / `gate:v2:independent` / `node scripts/check-metadata.mjs`：全部 exit 0。
- 新增套件：`responses-continuation.test.mjs`（11）、`codex-toml-safety.test.mjs`（8）、`codex-desktop-lifecycle.test.mjs`（6）；`responses-ws-bridge.test.mjs` 重写为续轮契约（14，含 HTTP 回落共用缓存、缺失 400、帧控制字段、注释嗅探、空 body 终态、interrupt 部分输出、FIN 收尾）。
- 更新既有契约测试：`codex-official`/`agg-v2-third-party-prevresp` 从"剔除即转发"改为"有状态重建 + 无状态 fail-closed"。
- 测试基础设施修复：WS 测试客户端帧双投递竞态（等待者交付后不再入队）。

## 4. 仍 BLOCKED / 需所有者裁决（如实记录，不宣称通过）

1. **真实长会话复验**（多轮上下文保真、luna→Go 父子派单、WS 续轮）：需真实额度与授权。本轮零付费调用。
2. **原生压缩的 provider 级约束**：生产用内置 openai 身份（所有者否决切 named provider），无法声明 `remote_compaction="unsupported"`；Codex 对 Go 子线程可能走远程压缩（compaction_trigger），Go 无法承接。网关侧已按调查 §7.1 声明 `codex-owned-local + preserve`（本地标记原样透传、远程密文 typed 拒绝）。**Go 子线程强制本地压缩需要子代理 provider 级方案，属所有者裁决**（MG-R006 不得由 AI 降级）。
3. **父/子模型分设 API**（P1-7 完整修复）：当前 activate 的 opts.model 同时驱动父与子；生产"GPT 父 + Go 子"靠手工配置。本轮已修漂移收编与子文件升级，完整分设属产品 API 变更，留待所有者排期。
4. `release:freeze` 仍因真实证据缺失正确阻断，不得改 SHA/代填审批使其变绿。

## 5. 部署注意（生产生效步骤）

代码修复随服务重启生效；**能力声明修复还需更新运行期产物**（不在 git）：
1. 用现有快照重新发布聚合目录（零网络）：新投影产出 `shell_type:"unified_exec"`、effort low/high、压缩归属声明。
2. `go-deepseek.toml` 的 effort medium → high（ canonical 字节，先备份）。必须与目录同步更新，否则 Codex spawn 校验不一致。
3. 重启 `model-gateway.service`，`/healthz` 与真实会话由所有者复验。