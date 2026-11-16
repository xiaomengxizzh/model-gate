# ModelGate 交接文档｜2026-11-16 晚（审计修复四轮真机反馈后，如实记录）

> 状态：**部分可用（PARTIAL）**。Go 子代理链路（含续轮重建）已在真机日志中证实工作；
> **官方父代理的多轮工具续轮仍被上游 400 阻断**（`No tool call found for function call output`），
> 根因已缩小到"官方订阅响应未被续轮捕获登记"，**未解决**。所有者指令：本轮停止修复，如实交接。
>
> 生产：`/home/xiaomengxizi/ai/workplace/idproject/model-gateway`，分支 `deploy/modelgate-ux-v3`（= main `829aa2e`），
> systemd 用户单元 `model-gateway.service`（127.0.0.1:8787，active）。远端 `origin/main = 829aa2e`（已推送）。
> 本文取代同日早间交接（`2026-11-16-modelgate-handoff.md`）的"当前状态"部分；早间文档保留为时间点记录。

## 1. 一句话结论

- **能**：网关路由/鉴权/计费、官方 GPT 单轮推理、Go DeepSeek 子代理派单与**子代理续轮历史重建**
  （日志证据：`recorded id=resp_c72ccc0f… items=0→2`、`reconstructed prev=resp_c72ccc0f… restored=5 delta=1`）。
- **不能（当前唯一阻断）**：官方父代理带工具调用的续轮——父代理上一轮响应（ChatGPT 后端 id，
  如 `resp_0fa1ff7d5a054040016afb1d23fd1c87d0b155215074ea1490`，56 位 hex）**从未被登记**，
  续轮降级转发后官方后端拒绝孤儿工具结果：
  `No tool call found for function call output with call_id call_xH29ykNtfincsIL33iigPOjq`。

## 2. 本轮全部问题台账（按发生顺序，如实）

### A. 严格审计发现（17 项，全部已修复并离线验证）

| # | 严重度 | 问题 | 修复提交 |
| --- | --- | --- | --- |
| A1 | P0 | 续轮历史丢失：剔除 previous_response_id 却不重建；旧 WS 缓存只补工具调用、回落/淘汰/重启即失效 | eec7c53（responses-continuation 模块） |
| A2 | P0 | TOML 段头带行内注释 → 追加重复段、非法 TOML、指纹自检通过 | 2256591 |
| A3 | P0 | Go 路由无压缩声明；目录投影丢覆盖 → shell disabled、effort assumed medium（真机 spawn 被拒） | 0c4b8cd |
| A4 | P1 | 多行字符串续行被当 owned 键静默改写 | 2256591 |
| A5 | P1 | 再次激活重置回滚基线 → 退出"恢复"出聚合态 | 0b25f38 |
| A6 | P1 | 自有子文件换模型/effort 永久 409 | 0b25f38 |
| A7 | P1 | WS SSE 嗅探注释/BOM/空 body → 无终态挂死；半关闭僵尸连接 | eec7c53 |
| A8 | P1 | WS 帧控制字段 type/generate 泄漏进上游 body；不强制 stream | eec7c53 |
| A9 | P1 | 健康 ok 把从未同步的 provider 计为健康 | 0b25f38 |
| A10 | P2 | WS 帧层：RSV/控制帧 fin+len/分片中新数据帧/UTF-8/closing 异步 | eec7c53 |
| A11 | P2 | orphan-adopt seed 含 index → 位置漂移 id 变 | eec7c53 |
| A12 | P2 | interrupt 双终态 + 空 output 抹掉部分输出 | eec7c53 |
| A13 | P2 | 轮次级陈旧头复用（turn-metadata/routing-hint/client-request-id） | eec7c53 |
| A14 | P2 | 目录回滚丢 aliases/officialSlugs | 0c4b8cd/0b25f38 |
| A15 | P2 | removeProvider 不查引用 → 状态漂移 | 0b25f38 |
| A16 | P2 | Desktop 进程探测目录前缀误匹配 /usr/bin 全部进程 | 0b25f38 |
| A17 | P2 | owned 行替换丢行内注释；带注释单行数组误判多行 | 2256591 |

### B. 真机第一轮：子代理 include 400（已修复）

- 现象：`include 不支持: output.encrypted_content（仅接受 reasoning.encrypted_content / output_text.logprobs）`。
- 根因：Codex 0.167 多代理新 include 项不在两处闸门白名单。
- 修复：三层白名单 + 第三方投影剔除（官方保留）。提交 ae9e23c，合并 dbd488d。

### C. 真机第二轮：父代理 continuation_state_missing（已修复其一因）

- 现象：父代理续轮 400 `continuation_state_missing`。
- 根因（已证实）：真实 ChatGPT 订阅后端在 `response.completed` 后**不关闭 SSE 流**；
  登记原挂在流结束回调，Codex 收到终态即续轮 → 登记未执行。离线 mock 立即关流故未暴露。
- 修复：终态事件到达即登记。提交 e60414d，合并 300c331。

### D. 真机第三轮：父代理仍 continuation_state_missing（韧性修正，未根治）

- 现象：C 修复部署后父代理续轮仍 400。
- 推断：官方订阅 SSE 的**事件信封形状**与 sink 假设（`{type, response:{id}}`）仍有差异——**未证实**（见 §3）。
- 修正（提交 e8ed185，合并 829aa2e）：
  1. 增量预登记：created 预登记 / output_item.done 增量更新 / 终态定稿；sink 兼容顶层 id。
  2. 优雅降级：状态缺失不再硬 400，warn + 落回形状修复链路转发。
  3. 全链路结构化诊断（仅协议元数据）：recorded / capture empty / reconstructed / degraded。
- **降级对官方孤儿无效**（已知限制，设计如此）：官方后端要求真实配对，孤儿 output 无 call 可配 →
  上游 400。第三方有 orphan-adopt（只补 call_id，上游接受）；官方不能伪造 call（契约禁止）。

### E. 真机第四轮：官方上游 400（当前唯一阻断，未解决）

- 现象：`No tool call found for function call output with call_id call_xH29ykNtfincsIL33iigPOjq`。
- 日志证据（logs/gateway-2026-11-16.log，15:11:49–54）：
  ```
  [warn] responses continuation degraded reason=continuation_state_missing
         prev=resp_0fa1ff7d5a054040016afb1d23fd1c87d0b155215074ea1490 store=5
  [info] gateway_subscription provider=chatgptplan target=chatgpt.com/backend-api/codex/responses
  [warn] responses-ws internal POST failed status=400 bodyKeys=error
  ```
- 已证实事实：
  1. 全部 6 条 `recorded` 日志的 id 均为 32 位 hex（Go 上游格式）；**没有任何官方父代理响应被登记**。
  2. 观察窗口内**没有** `capture empty` 告警 → 官方流的 sink 要么没到流结束（流保持打开），
     要么 `sawAny=false`（一个事件都没解析出来）。
  3. Go 子代理链路登记+重建完全正常（restored=5 delta=1）。
  4. 降级机制按设计工作（不再硬 400），但官方后端拒绝孤儿 → 阻断转移到上游。
- 未证实假设（按可能性排序）：
  1. 官方订阅 SSE 的 data JSON 不是 `{type, response:{id}}` 信封（可能是裸 response 快照/其它包装），
     sink 与 WS 桥的终态判定都依赖该信封；
  2. 官方响应走 JSON 路径（content-type 非 event-stream）且 id 不在顶层（JSON 路径登记无日志，是诊断盲点）；
  3. WS 桥 JSON 合成路径给 Codex 的 id 与网关登记的 id 不一致。
- **下一步诊断（精确、最小）**：在 proxyOfficialResponses 的 up.ok 分支加一条结构日志：
  `content-type` + 流式首个 data 块的 **JSON 键名列表**（`Object.keys`，不记值/正文）+ id 出现位置
  （顶层/响应对象内/缺失）；JSON 路径补登记日志。一次真机父代理单轮即可定位，然后按真实形状修 sink。
  **不要**在没有形状证据前继续改 sink 猜测兼容。

### F. 已知非阻断问题（如实保留）

1. 启动告警 `third_party_context_missing models.MiniMaxAI/MiniMax-M3`：V1 遗留模型缺 maxContext；
   不影响 V2 目录（12 模型正常），补 maxContext 或移除该 V1 定义可消除。
2. 目录发布 `catalog_warnings`：官方模型未声明网关侧压缩归属（官方走后端原生远程压缩，预期）。
3. **provider 级压缩约束（所有者裁决项）**：内置 openai 身份无法声明 `remote_compaction="unsupported"`；
   Go 子线程若被 Codex 走远程压缩（compaction_trigger），Go 无法承接。网关侧已声明
   codex-owned-local + preserve（本地标记透传、远程密文 typed 拒绝）。强制 Go 本地压缩需子代理
   provider 级方案，违反"不切 named provider"的所有者决议之处需重新裁决。
4. **父/子模型分设 API 缺失**：activate 的 opts.model 同时驱动父与子；生产"GPT 父 + Go 子"靠手工配置。
   漂移收编与子文件升级已修（0b25f38），完整分设属产品 API 变更。
5. 网关重启后续轮状态丢失（进程内缓存）：现降级转发不再硬断，但上下文可能不完整；持久化属后续工作。
6. `release:freeze` 仍因真实证据/审批缺失正确阻断；不得改 SHA/代填审批使其变绿。

## 3. 验证边界（诚实声明）

- 离线：main `829aa2e` 全量 **133 suites / 1289 tests / 0 failed / 3 skipped**；
  check / contract:check / docs:check / gate:v2 / gate:v2:independent / gate:audit-diff(base=e7463857) / check-metadata 全 PASS。
- 真机已证实：Go 子代理派单 + 续轮重建（日志 §1）；官方单轮推理；include 修复；WS 握手；降级转发。
- 真机未通过：**官方父代理带工具调用的多轮续轮（§2.E）**；原生压缩长会话；luna→Go 父子全链路复验。
- **方法论教训（本轮核心）**：离线 mock 全绿 ≠ 真机可用。真实后端行为（不关流、include 新项、
  事件信封形状）必须用结构化诊断从真机日志取证后再修；本轮前三次修复均因 mock 与真实行为差异而反复。
  续轮诊断日志（recorded/capture empty/reconstructed/degraded）已就位，后续异常先读日志再动手。

## 4. 恢复工作指南（下一会话）

1. 读 `logs/gateway-<date>.log`，grep `continuation`：
   - `recorded id=…` 缺失官方 id → §2.E 诊断步骤（官方响应形状取证）；
   - `capture empty events=…` → 事件类型列表直接给出信封形状线索；
   - `degraded prev=… store=N` → 降级发生，查该 prev 为何未登记。
2. 复现命令（所有者授权后，一次真实父代理单轮 + 一次续轮即可）：
   Codex Desktop 新会话 → 让父代理 spawn 子代理 → 观察第二轮。零付费替代：无（官方形状必须真机取证）。
3. 修复落点：`src/responses-continuation.js`（sink 信封）、`src/index.js` proxyOfficialResponses
   （结构诊断 + JSON 路径登记日志）、必要时 `src/responses-ws.js`（终态判定与合成 id 一致性）。
4. 每次修复后：全量 npm test + 门禁；真机复验；更新本文与 CHANGELOG。

## 5. 部署 / 回滚 / 凭据边界

- 当前生产 = main `829aa2e`。目录 generation 7（Go：unified_exec + low/high + auto_compact 943718）；
  回滚锚点 generation 6（`catalog.rollback('local','prev')`）。
- `~/.codex/config.toml` 本轮未触碰（model=gpt-6.1-sol 为用户选择）；go-deepseek.toml effort=high
  （备份 `go-deepseek.toml.bak-before-effort-high-20261116`）。
- 代码回退：`git checkout 300c331`（韧性修正前）或 `dbd488d`（include 修复）；
  早间部署备份 `.agents/deploy-backup-20261115-234750/`。
- 凭据：OpenCode Key 仅环境变量 OPENCODE_API_KEY；官方凭据只读本机 ~/.codex/auth.json；
  管理令牌未设置（needAuth=false，所有者要求）；本文与日志不含任何凭据/对话正文。
- 未提交改动：无（生产树干净）。tray Linux 版已入库（39c074b）。

## 6. 分支与提交地图

- main = origin/main = `829aa2e`；所有本地/远端支线均为 main 祖先（含 archive/*，-s ours 保留历史）。
- 本轮修复链：eec7c53 → 2256591 → 0c4b8cd → 0b25f38 → 39c074b（tray）→ ae9e23c（include）
  → e60414d（终态即登记）→ e8ed185（韧性+诊断）；合并提交 dbd488d / 300c331 / 829aa2e。
- 修复分支均已推送：fix/modelgate-codex-audit-20261116、fix/modelgate-include-output-encrypted-20261116、
  fix/modelgate-continuation-terminal-record-20261116、fix/modelgate-continuation-resilience-20261116。
- 证据文档：`docs/evidence/2026-11-16-codex-audit-remediation.md`（审计清单）、
  `docs/evidence/2026-11-16-audit-fix-deployment.md`（部署与四轮反馈）。