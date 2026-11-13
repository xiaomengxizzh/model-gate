# ModelGate 原生 Codex 真实双上游验收

2026-11-13。用户授权在隔离 ModelGate 实例中承载 GPT 套餐推理，执行一次真实初派和一次同子追派。新增大型安装/下载为无。测试使用本地实验工作树 `mg-codex-native`，基线 `9e037db` 加本地 Responses 和路由修复。CC Switch 未参与运行。

## 结果

| 项目 | 结果 |
| --- | --- |
| 父推理 | 原版 Codex CLI 0.167.0 使用原生 ChatGPT 登录，`gpt-6-luna` 经 ModelGate 到 ChatGPT 订阅端点。正式测试的 7 次官方请求全部 HTTP 200。 |
| 初派 | 父通过 Codex Code Mode 调原生 `spawn_agent` 一次，`fork_turns=none`。子线程收到可读随机挑战 A，ModelGate 发给真实 Go 的 `deepseek-v4.1-flash`。子执行 `exec_command`，工具输出和子终答都含 A。 |
| 同子追派 | 首次父进程在等待阶段超过 230 秒被测试器停止。恢复同一父会话后，父通过 Codex Code Mode 向原子路径发出一次原生 `followup_task`。同一子 ID 开始第二个 turn，收到挑战 B，再执行工具并完成。父收到原生消息并报告 B，退出码为 0。 |
| 实际 Go 上游 | 四次请求全部到 `https://opencode.ai/inference/go/v1/responses`，请求模型均为 `deepseek-v4.1-flash`，全部 HTTP 200。每轮分别验证挑战正文及工具结果确实进入 Go 请求。 |
| 凭据隔离 | 四次 Go 请求均使用 Go Key，均无 ChatGPT 账号头。官方端使用本机 ChatGPT 登录态。隔离进程只读挂载现有认证文件，未复制或修改它。 |
| 配置恢复 | 正式 Codex 配置的 SHA-256 前后一致。两个测试实例均已退出，测试端口均未监听。生产服务未启动。 |

脱敏逐请求收据与独立校验见 [JSON](2026-11-13-modelgate-native-live-receipt.json)。挑战只在派单消息中，没有预置任务文件。收据保存哈希、标志、时间和上游元数据。

## 生效条件

Codex 0.167.0 使用 `[features.multi_agent_v2]` 表，令 `enabled=true`、`non_code_mode_only=false`、`expose_spawn_agent_model_overrides=true`。父模型目录选择 Code Mode，父从 Codex 自己的 JavaScript 工具调用原生协作工具。Codex 将这类任务标记为明文，ModelGate 将可读消息投影成 Go Responses 可接受的用户消息。测试中使用主机已有出站代理解决官方目标的 TCP 连通问题。

## 首次父进程等待停滞

| 时间（北京时间） | 已核实事件 |
| --- | --- |
| 17:44:26 | 父线程通过 Code Mode 启动原生子线程。 |
| 17:44:39 | 父线程在 `exec` 单元调用 `collaboration__wait_agent({timeout_ms:60000})`。这个单元在约 31 秒后以仍在运行的状态让出控制，返回单元 ID 2。 |
| 17:45:39 | Codex 记录内层协作等待结束，早于子任务实际完成。单凭 `CollabAgentToolCall.status=completed` 无法判定子任务完成。 |
| 17:45:43 | Go 已返回第二个 HTTP 200，子线程完成首轮，父线程记录了同一子 ID 的完成事件。后续没有观察到父线程调用顶层 `wait` 收取单元 2 的结果，也没有新的 GPT 推理请求到达 ModelGate。 |
| 父进程启动后约 230 秒 | 外部测试器停止首次父进程。首轮工具结果和子终答可核对，父端最终文本回执缺失。 |
| 17:48:47–17:49:49 | 恢复同一父会话，仅追派一次。子线程完成第二轮后，父模型调用顶层 `wait` 收取让出控制的单元，随后收到原生子消息、报告挑战 B，并正常退出。 |

**直接阻碍是父侧 Code Mode 等待单元没有被收取。** 首次等待将协作邮箱的等待超时设为 60 秒，但原生 `wait_agent` 在子代理完成前已经返回。Go 已完成两次 Responses 请求，Codex 已产生子完成事件，父端却没有把让出控制的单元推进到下一次推理。第二次用显式的顶层 `wait` 完成了交接。现有收据没有保留首次父端每次本地传输的完整 trace，无法确定 Codex 没有继续收取单元的内部原因。 [Codex 协作等待源码](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs#L53-L120) · [Codex Code Mode 等待契约](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/core/src/tools/code_mode/wait_spec.rs#L10-L42)

## 解决方案与复验标准

1. 父代理保持原版 Codex Code Mode，以原生 `spawn_agent` 创建唯一子线程。保存原生任务路径和线程 ID。ModelGate 继续转发 Responses 和投影可读任务。
2. 将等待拆成可推进的小步。内层 `collaboration__wait_agent` 使用短于本轮整体期限的等待。若 `exec` 返回运行中单元 ID，立即用顶层 `wait({cell_id})` 收取该单元，直到结束或本轮预算到期。内层超时只表示本次等待结束，按剩余预算继续等待同一子线程的完成消息。
3. 只有在收到目标子 ID 的完成消息并核对工具结果后才进入追派。单次追派期间同样收取让出控制的单元。出现超时时可恢复同一父会话，先核对原生历史是否已派单或已追派，再继续等待或补做尚未发出的操作。
4. 后续用一次未中断的 Codex 进程验证：两个随机挑战分别只在初派与追派中出现。父线程收到两次匹配的完成消息并正常退出，原生日志只出现一次派发、一次追派和一个子 ID。隔离 mock 应覆盖内层等待先超时、Code Mode 单元让出、顶层等待收取、子完成消息稍后到达。真实上游复验和 Desktop 分开签收。

恢复同一父会话并完成同子追派是本轮已实测的恢复方案。按上述短等待循环在单进程自动收尾、首次父端 A 的文本回执与 Desktop 入口仍待验。真实子请求约 938–940 KB，Go 首字节 8–33 秒，测试总时限应覆盖每轮模型推理与工具回填。
