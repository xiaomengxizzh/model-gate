# ModelGate V2｜冻结树真机复核（`1a527c6`，2026-11-15）

> 冻结树：`1a527c6e0d3217ee008ed7da950e4f297acda604`（`docs/evidence/v2-frozen-sha.txt`）。
> 目的：按 P05 在**冻结源码**上重跑核心路径，替换中间树回执；冻结后只允许文档改动。
> 环境：隔离网关 `127.0.0.1:8897`（`MG_CONFIG_DIR=/tmp/mg-app-state/gateway`）、隔离 `CODEX_HOME`；真实 Go 与真实 `gpt-6-luna`；零下载。

## 1. 冻结树上重新取得的真实回执

| 项 | 结果 | 回执要点 |
| --- | --- | --- |
| R002 官方套餐父模型 | **PASS_REAL** | `POST /v1/responses` `gpt-6-luna` → HTTP 200 / 2.24s，SSE `model:"gpt-6-luna"`，文本 `FREEZE_LUNA_OK`；凭据只读复用本机登录（`auth.json` mtime 未变）|
| R003 Go 真实推理 | **PASS_REAL** | `deepseek-v4.1-flash` → HTTP 200，`model` 回写，`usage.opencode.billing_source=go`，文本 `FREEZE_GO_OK` |
| R005 原生父生子 + 工具 | **PASS_REAL** | 冻结树生成配置 → 父 `gpt-6-luna` 经 `[agents.go_deepseek]` 派生子代理；子代理执行 `printf`，`freeze-child.txt=FREEZE_CHILD_OK+FREEZE_CHILD_SECOND`（同子第二轮）|
| R006 工具 / 同子追派 | **PASS_REAL** | 同上（同子第二轮成功并复述第一轮）|
| R006 中断 | **PASS_REAL** | 子代理执行 `sleep 300` 时 `SIGINT` → `turn interrupted`、工具未完成、`int3-long.txt` 未生成 |
| R006 恢复（resume） | **PASS_REAL** | `resume <父 session>` 成功，子代理继续执行并返回 `FREEZE_RESUME_OK` / `FREEZE_RESUME2_OK` / `FREEZE_RESUME3_OK` |
| R008 负向 | **PASS_REAL** | 未知模型 404 零上游；失效 Go key 真实 1 次请求 → 401 typed；429 跨域两对照均 `cross_domain_fallback_blocked`（修复后）|
| R009 双实例隔离 | **PASS_REAL** | A 凭据打 B 7/7 401、B 控制组 200、配置/统计/日志互不串 |
| R010 崩溃/回滚/冲突 | **PASS_REAL** | 冻结树上重跑 10 时点 SIGKILL：配置从未半写、回滚逐字节一致；对照组 activate→deactivate 恢复一致 |

## 2. 冻结树上**未能重触发**的部分（如实记录，不冒充）

- **`native-compaction` / `post-compact-followup` / `context-proof`**：冻结树上尝试 3 次（`auto_compact_token_limit` 32000、32000 更大 prompt、24000），均**未出现** `context compacted`；同期工具执行与"复述第一条命令输出"（`FREEZE_BASE_OK`）正常。
  - 这三条的**真机证据仍来自中间树 `3116459`**（当时 `context compacted` 出现 2–3 次，压缩后工具 `marker-b.txt=POST_COMPACT_MARKER`、复述 `BASE_OK`）。
  - 结论：**冻结树上未重新触发压缩**，因此这三条不能声称"冻结树已复测"；需要更多上下文或真实较长会话才能复现。
- **中断后 `resume` 是否会复用原子代理**：冻结树两次尝试中，父代理都执行了 `spawn_agent` 新建子线程（`01a1deca-…`），没有复用被中断的子线程（`01a1dec9-…`）。
  - 这与中间树 `3116459` 的一次观察（resume 后工具结果落回原 child rollout）不一致 → **客户端行为不稳定，不能作为产品保证**。
  - 已确认不受影响的是：中断终态唯一、`no-duplicates` 的"一次派单一次请求"（`spawn_agent` 计数与子线程一一对应）、resume 后能继续工作。

## 3. 冻结树复核状态汇总

| 需求 | 冻结树复核 | 说明 |
| --- | --- | --- |
| R002 / R003 / R005 / R008 / R009 / R010 | 已复核 | 见 §1（R009 为双实例形态，条件需所有者批准）|
| R006 | 部分复核 | 工具/同子/中断/恢复/去重已复核；压缩三条沿用 `3116459` 证据 |
| R001 / R004 / R007 | 已复核（A3） | 控制台三场景 + 原版 GUI 官方/Go 各一次真实请求；409 UI 在冻结树正确显示 |
| R012 | 随 R002 复核 | 冻结树所有 GPT 调用仅 `gpt-6-luna` |

## 4. 费用

冻结树复核真实调用：Go 4 次（含 1 次无效 key）、Codex 会话 4 轮（父+子）、GPT 请求 1 次（`gpt-6-luna`）；约 25 万 tokens。
