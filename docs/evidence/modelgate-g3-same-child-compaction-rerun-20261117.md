# G3 同子跨压缩 resume 有界重跑——PASS_REAL 完整闭环达成（最后缺口补齐）

> 状态：**PASS_REAL**（同子跨压缩 resume 完整闭环，2 有效付费单轮内达成）。补齐 `modelgate-g3-remaining-e2e-acceptance-20261117.md` §4 / §6 遗留的"同子跨压缩"最后缺口——该文当时记部分覆盖（判据级 `NOT_RUN`），本轮以真实闭环推翻。
> 执行：general-purpose-1 · 2026-11-17 · 本文落盘：general-purpose-2 · 来源收据：`/tmp/mg-g7-e2e/receipts/R18b-same-child-compaction-bounded-rerun-receipt.md`（逐条核对）。
> 本文只写脱敏证据与结论：不含任何密钥 / auth.json 内容 / token / cookie / prompt / 报文正文；所有 id 仅以截断形态出现（完整值见收据，且收据本身亦为截断 / hash 形态）。
> 统一枚举：`PASS_REAL` / `FAIL_REAL` / `PASS_MOCK` / `NOT_RUN` / `BLOCKED`；**只有 `PASS_REAL` 算验收通过**。
> 边界：纯文档写入——不碰源码 / 生产配置、不启动服务、不发起付费请求、不 push、不合并 main。

## 0. 摘要

- 授权：owner "追加有界重跑"，严格 **≤2 有效付费单轮 `gpt-6-luna`**（另 1 次为零请求 harness 拒收，见 §7）。
- 判据：压缩前捕获的真实 child id，在压缩点后仍可见（步骤 1）；模型压缩后沿 V1 `send_input` / `resume_agent` / `wait_agent` 指向**同一 child**、**不新建子代理**（步骤 2）并完成真实剩余工作。
- 结果：**两步观测全满足、真实闭环**；`client_visible_400=0`、`fail_closed=0`、`degraded=0`、`continuation_error=0`。
- 结论：**同子闭环可达，无需放宽为"同会话继续"、无需 NO-GO、无需固定客户端版本。**

## 1. 被测树与形态

- 被测树：`dc6e26e6dd149d57bbd9ff7770f76cb98ca119a9`，执行前后 HEAD 一致、工作树干净。
- 形态：first-party `model_provider=openai` + `openai_base_url=127.0.0.1:18790`（等价生产 `8787` 仅换端口）、local 订阅（`chatgpt-plan` / `local_codex_auth`）。
- 模型：父 `gpt-6-luna` 全程请求级核验；子代理固定 `mg-opencodego-deepseek-v4-1-flash`。
- 反降级审计：全程**未换模型 / 未关能力 / 未放大窗口（272000 × 95% → 阈值 258400）/ 未关压缩 / 未改 auth**。
- 凭据：日常 config / auth 仅字节副本 + 哈希核验（auth 哈希 `c4c34ff5…`，从未读内容）。
- 生产隔离：未触碰生产 `8787` / systemd / CC Switch。

## 2. 运行时关键发现（修正此前研究结论，不改判据）

- 冻结 catalog `current.json` 对全部 **11 个模型显式钉死 `multi_agent_version=v1`**；真实 rollout turn_context 亦为 `v1`。tool 面只有 `spawn_agent` / `send_input` / `resume_agent` / `wait_agent`，**无 V2 的 `list_agents` / `followup_task`**。此前两份研究"默认 V2"的结论与实测不符。
- 按硬约束**不改能力、保持 V1**：同子续做原语为 `send_input(agent_id,target)` / `resume_agent(id)`。策略改为把压缩前捕获的真实 child id（`01a1ea1b-939a…`）作为**文本常量重复固化进压缩点后的 user 消息**，而非依赖 V2 `followup_task`。

## 3. 两步观测（均满足）

**轮 1（fresh thread `01a1ea1a-d464…`，stdin 注入 40 个真实源码文件共 571,929 chars）**

- L11 `spawn_agent`（`call_E1nX…`，`go_deepseek`，`fork_context=false`）真子；
- L14 捕获 child id = `01a1ea1b-939a…`（写入真值）；
- L15 `token_count input=175668`、L20 `token_count input=451533`（远超 258400 阈值）；
- L21 `task_complete`，`EXIT=0`，duration 94,627ms；无 `compacted` 事件（压缩推迟到下一轮起点，符合 Codex 行为）。

**轮 2（resume 同 thread；提示固化旧 id ×7 + 禁 NEW spawn + 禁 ps / mcp）**

- L25 `compacted` 事件：`window_number=1`，window `01a1ea1a-d465…` → `01a1ea20-6936…`，`compaction_response_id=resp_06de842d…`（截断脱敏）；
- L31 压缩后新窗口 user 消息含旧 child id `01a1ea1b-939a…` ×7 → **步骤 1 满足**；
- L35 `send_input(target=01a1ea1b-939a…)` → `agent not found`（轮 1 末 child 被中断）；
- L42 `resume_agent(id=01a1ea1b-939a…)` → `{"status":"interrupted"}`（复活同一 thread）；
- L48 `send_input(target=01a1ea1b-939a…)` → `{"submission_id":"01a1ea22-5f94…"}`（同一旧目标提交成功）；
- L53 / L58 `wait_agent(targets=[01a1ea1b-939a…])` → `timed_out` ×2（等待继续工作的同一 child）；
- L69 终态 JSON：`child_id_used=01a1ea1b-939a…, compaction_seen=true, child_continued=true, new_child_spawned=false`；
- L72 `task_complete`，`EXIT=0`，duration 538,120ms（约 9 分钟，无 900s 超时）；
- 压缩后 `spawn_agent` 调用数 = 0（唯一 spawn 在 L11 压缩前）→ **步骤 2 满足**。

## 4. 同子闭环真实性核验（不采信模型自报，逐一比对工具输出 / rollout）

- **同一 child thread 内出现压缩后第二段真实工作**：child rollout `01a1ea1b-939a…` 在 L11 `turn_aborted`（轮 1 末）后，L13 再次 `task_started`，L22–L52 共 **5 次 `exec_command`**，L61 `task_complete`（duration 218,364ms）。`consolidated.py` 于 **23:34:39 生成（4,742 bytes）**，落在轮 2 时间窗（23:26:27–23:35:35）内，真实落盘（git status `?? src/analytics/consolidated.py`）。
- **目标 id 始终是旧 child**：`send_input` / `resume_agent` / `wait_agent` 的 target / id 全为 `01a1ea1b-939a…`；`01a1ea22-5f94…` 是 `submission_id`（消息提交 id），**不是新 child**。压缩后 NEW spawn = 0。
- **断链点印证**：`compacted.resume_metadata` keys = `[dynamic_tools, multi_agent_version, last_started_turn_id, turn_attribution, previous_turn_settings]`，**不含 child id**；原始 function_call 历史被 `replacement_history` 替代。旧 id 仅因写在 user 消息（L31 ×7）而在压缩后可见——既验证研究判断的断链点，也验证"文本固化"是唯一杠杆。

## 5. 判定字段与错误计数

```yaml
id: R18b-same-child-cross-compaction-bounded-rerun
status: PASS_REAL   # 同子跨压缩 resume 完整闭环（2 有效付费轮内达成）
frozen_sha: dc6e26e6dd149d57bbd9ff7770f76cb98ca119a9
compaction_event:
  window_number: 1
  window_id_from: "01a1ea1a-d465…"
  window_id_to:   "01a1ea20-6936…"
  compaction_response_id_truncated: "resp_06de842d…"
  input_tokens_peak: 451533     # > 258400 阈值
  resume_metadata_has_child_id: false
child_continuity:
  child_id: "01a1ea1b-939a…"
  pre_compact_spawn: true
  post_compact_targets: [send_input, resume_agent, send_input, wait_agent, wait_agent]
  post_compact_new_spawn: 0
  post_compact_real_work: true  # consolidated.py + 5 exec_command + task_complete in same child thread
  child_continued_in_same_thread: true
step1_old_id_visible_post_compaction: true  # user msg L31 ×7，在 compacted L25 之后
step2_model_reuses_old_id_not_new_spawn: true
exit_codes: {turn1: 0, turn2: 0, zero_request_rejected: 1}
terminal_state: task_complete (L21, L72)
errors:
  client_visible_400: 0
  fail_closed: 0
  degraded: 0
  continuation_error: 0
  transient_upstream_502: 3      # responses-ws internal POST，进程内终止不换候选、非静默降级
  agent_not_found_once: true     # L35 首轮 send_input；resume_agent 复活同一 id 后成功
  wait_timeouts: 2               # wait_agent 30s ×2，child 仍在工作；非产品失败
no_900s_timeout: true            # 轮 2 约 9 分钟干净 EXIT=0
```

- `client_visible_400=0`、`fail_closed=0`、`degraded=0`、`continuation_error=0`。
- 3× 瞬时 upstream `502`（`responses-ws internal POST`，网关进程内终止、不换候选重放、非静默降级；与压缩无关）。
- 1× `agent not found`（轮 1 末 child 被 `turn_aborted`；`resume_agent` 复活同一 id 后成功）+ 2× `wait_agent` 30s 超时（child 仍工作）——均为 V1 子代理生命周期 / 瞬时上游，**非产品失败**。

## 6. 对产品的结论

- **同子跨压缩闭环可达**：在真实窗口（272000 / 95%）、零能力 / 窗口 / 压缩 / auth 改动下，把压缩前 child id 文本固化进压缩点后的 user 消息，模型压缩后沿 V1 `send_input` / `resume_agent` / `wait_agent` 指向同一 child、完成真实文件创建与测试，压缩后 NEW spawn = 0。**无需放宽为"同会话继续"、无需 NO-GO、无需固定客户端版本。**
- 断链根因（metadata 不持久化 child id + function_call 历史被压缩 item 替代）属**模型 / harness 行为，非网关协议缺陷**。网关不持有 child id、不能伪造，补映射会违反契约"禁止第二套调度"。
- 本产品实测为 **V1 协作**（`send_input` / `resume_agent`）。若日后切 **V2**（`list_agents` / `followup_task`）须**单独真机验收**，不能由本轮 V1 PASS 外推。

## 7. 失败项 / 干扰（如实，不计产品判据）

1. **零请求拒收（harness 自错）**：首版 turn1 payload 双 pass = 1,141,862 chars，被 Codex `turn/start` 以 `input_too_large`（上限 1,048,576）拒收，`EXIT=1`、零上游请求、零付费；改单 pass（571,929 chars）后成功。
2. **3× 瞬时 upstream 502**（`responses-ws internal POST failed status=502`）：网关进程内终止、不换候选重放、非静默降级；turn2 仍干净 `EXIT=0`，与压缩无关。
3. **wait_agent 2× 30s 超时 + 1× agent not found**：V1 子代理中断后需 `resume` 的生命周期行为，复活同一 id 后闭环仍成立。
4. **stats.json 计数不可靠**：网关未设 `MG_CONFIG_DIR`，stats 写到被测 worktree `config/stats.json`（gitignore，工作树仍干净），其计数（16/3）与实际日志路由不一致；请求数以网关 stdout 日志 + rollout 为准，不强行引用 stats 数字。

## 8. 收尾核验

- 隔离网关进程已 SIGTERM 优雅关闭，`18790` 不再监听；生产 `8787` 全程 inactive / 未监听；无残留 node / codex 进程。
- 被测树 HEAD 前后 `dc6e26e…`、`git status` 空（`stats.json` gitignore）。
- 凭据哈希前后一致（config `8f3d6cc6…` / auth `c4c34ff5…`，只哈希未读内容）；全程零密钥泄漏、正文 / prompt 未打印。
- 未碰生产 8787 / systemd / CC Switch；未 push、未合并 main。

## 9. 完整验收矩阵最终态

| 项 | 状态枚举 | 说明 |
| --- | --- | --- |
| R13 direct 基线 | `PASS_REAL` | 官方直连无网关，P0-A 基线稳定（见 `modelgate-g3-remaining-e2e-acceptance-20261117.md` §1） |
| R14 经 ModelGate 同任务 | `PASS_REAL` | 见 `modelgate-g3-r16-e2e-acceptance-20261117.md` |
| R15 CC Switch 对照 | `BLOCKED` | 无写入授权；符合"借鉴 CC Switch 而非完善它"的口径 |
| R16 长时间 / 多文件任务 | `PASS_REAL` | G3 R16 主轮 PASS_REAL |
| R17 旧 / 新线程 | `PASS_REAL` | A→B→恢复 A，各自 reconstructed 自有历史、无串扰（见 remaining §2） |
| R18 有工具 vs 无工具 | `PASS_REAL` | 有工具主轮 PASS_REAL（真实工具 call/output 配对、无 400） |
| **R18b 同子跨压缩 resume** | **`PASS_REAL`** | **本文补齐最后缺口：压缩前后同一 child id、压缩后 NEW spawn=0、真实闭环、无 400/degraded/fail_closed（§3–§5）** |
| R19 WS 长连接 / 断线恢复 | 部分覆盖 | 断流 / 瞬时 502 恢复已验；断网 / 网络切换 `NOT_RUN` |
| R20 故障恢复 / 用户可见错误 | `PASS_REAL` | 真实故障注入全过（见 remaining §3） |
| 跨供应商委派 | V1 `PASS_REAL` / V2 未启用不背书 | 本轮实测 V1；V2 `list_agents` / `followup_task` 未启用，不背书 |

- **所有明确验收项 PASS_REAL**；R15 为授权边界 `BLOCKED`，R19 为部分覆盖（判据级 `NOT_RUN`），均如实保留，不冒充通过。
- 状态枚举统一：`PASS_REAL` / `FAIL_REAL` / `PASS_MOCK` / `NOT_RUN` / `BLOCKED`；**只有 `PASS_REAL` 算验收通过**，本文无 `PASS_MOCK` 冒充真实通过。
