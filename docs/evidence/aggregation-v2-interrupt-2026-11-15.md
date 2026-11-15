# ModelGate V2｜原生中断与派单去重真机验收（2026-11-15）

> 所有者已授权真实验收；GPT 仅 `gpt-6-luna`。本轮无下载、无安装、未改 `~/.codex` 与生产服务。
> 被测树：`3116459`（本轮仅新增文档，产品代码与 `754a687` 一致）。隔离：`CODEX_HOME=/home/xiaomengxizi/.local/state/mg-int-accept`、网关 `MG_CONFIG_DIR=/tmp/mg-app-state/gateway`（`127.0.0.1:8897`）。

## 1. 方法

1. 用产品生成配置（`bin/mg-desktop.mjs configure` → `[agents.go_deepseek]`）起真实会话：父 `gpt-6-luna`，子 `mg-opencodego-deepseek-v4-1-flash`。
2. 提示词让子代理先写 `int3-marker.txt` 再 `sleep 300`（把"工具已开始"变成可观测锚点）。
3. marker 出现后，向 **codex 进程组**发 `SIGINT`（真正的用户中断路径，不是超时）。
4. 观察：进程退出、`int3-long.txt` 是否生成、父/子 rollout 事件。
5. 再 `codex exec resume <父 session id> -c 'sandbox_mode="workspace-write"'`，让同一 `go_deepseek` 子代理执行新任务。

## 2. 结果

| 观测 | 父 rollout | 子 rollout |
| --- | --- | --- |
| 模型 | `gpt-6-luna` | `mg-opencodego-deepseek-v4-1-flash` |
| 派单 | `spawn_agent: 1` | — |
| 中断终态 | `turn_aborted: 1`（无第二个终态） | `turn_aborted: 1` |
| 工具 | — | `exec_command`（被中断的那次）|
| 正常完成 | `task_complete: 1` | `task_complete: 1`（resume 后）|

- 中断时 `int3-long.txt` **不存在** → 确实是工具执行中被中断，不是跑完再取消。
- 会话文件总数 = **2**（父 + 子），中断后没有出现第三个子会话 → 无重复派单。
- `resume` 后父用同一个 `go_deepseek` 子代理执行 `printf RESUME_AFTER_INTERRUPT_OK`，文件内容正确、父代理回报该输出 → 中断后可恢复，且子身份复用（没有新建子代理身份）。
- 中断瞬间客户端记录了一条 `failed to record rollout items: thread … not found`（Codex 内部 rollout 记录竞态），不影响中断语义；已在下方列为已知噪声。

## 3. 对应 MG-R006 用例

| 用例 | 结论 | 证据 |
| --- | --- | --- |
| `native-tool` | PASS | 子代理 `exec_command` 真实执行（前序 `marker-real.txt=TOOL_REAL_OK`）|
| `same-child-followup` | PASS | 同子代理第二轮 `CHILD_SECOND_OK`，并复述第一轮 `CHILD_REAL_OK` |
| `interrupt` | PASS | 本节：`turn_aborted: 1`、工具未完成、进程退出 |
| `native-compaction` | PASS | 真实 Go 上 `context compacted`（Codex 自己压缩）|
| `post-compact-followup` | PASS | 压缩后仍执行 `exec_command` 生成 `marker-b.txt` |
| `context-proof` | PASS | 压缩后仍复述压缩前输出 `BASE_OK` |
| `resume` | PASS | 本节：中断后 `resume` 成功，子代理继续工作 |
| `no-duplicates` | PASS | `spawn_agent: 1`、会话文件 2 个、无第三个子会话 |

## 4. 费用与边界

- 本轮真实调用：中断轮 ~15k tokens + resume 轮 ~16k tokens + 一次误 resume（子 session，~30k tokens，被识别并改用父 session id 重跑）。
- 全部 GPT 调用为 `gpt-6-luna`；无其他型号、无自动回退。
- 已知噪声：中断时 Codex 自身 rollout 记录竞态报错（客户端侧，不是网关侧丢事件）；如后续需要零噪声证据，可在中断前等待 1 个 token 计数周期。


## 5. thread-id 级对照（回应 A5 第七轮 P2）

| 时点 | 父 thread | 子 thread | 证据 |
| --- | --- | --- | --- |
| 中断前（spawn 后） | `01a1ddc8-e8b3-7801-9363-5c1b080ce440` | `01a1ddc9-032d-7751-bf9c-85231bfd60bd` | 两个 rollout 的 `session_meta` |
| 中断瞬间 | 同一父 thread：`turn_aborted:1` | 同一子 thread：`turn_aborted:1`，`int3-long.txt` 未生成 | rollout 事件 |
| resume 后（`resume 01a1ddc8-…`） | 同一父 thread | **同一子 thread**：`RESUME_AFTER_INTERRUPT_OK` 与 `CHILD_STARTED3` 都出现在 `01a1ddc9-…` 的 rollout 里 | 该 rollout 内容检索 |

- rollout 文件总数在中断与 resume 前后都保持 **2**（父 + 子），没有第三个子 thread 文件 → 不存在"中断后重建子代理"。
- 中断瞬间的 `failed to record rollout items: thread … not found` 只影响客户端**即时记录**：子 rollout 文件仍在、且 resume 后的工具结果写入了**同一个**子 thread，因此不影响子会话持久化与身份复用。
