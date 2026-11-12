# Codex Multi-Agent V2 离线生命周期夹具 · 抓线与判据（task-4 / MG-017-T4）

> 结论来源：2026-11-12 在本机原版 Codex 上的**实测抓线**，非推断。所有线程、任务路径、完成通知、
> 并发/审批/取消语义均由原版 Codex 生成；fixtures 只扮演"上游模型"（Responses SSE），不伪造 Codex 状态。
> **证据等级：离线生命周期 / 组件验收。不是真实上游验收**，mock 响应不得当成真实供应商证据。

## 0. 固定环境

| 项 | 值 |
| --- | --- |
| CLI | /home/xiaomengxizi/ai/harness/codex/cli/bin/codex → codex-cli 0.167.0 |
| bundled app-server | /usr/lib/chatgpt/resources/codex → codex-cli 0.167.0-alpha.3.2 |
| Node | v24.22.2（零新增依赖） |
| 隔离状态 | mkdtemp 生成 CODEX_HOME，结束清理；不读写用户 ~/.codex |
| 门禁 | 默认只跑纯编排快测；MG_CODEX_V2=1 才起真实 CLI / app-server |

## 1. 隔离 CODEX_HOME 配置（单 provider）

    model = "gpt-mock"
    model_provider = "mgmock"
    approval_policy = "never"
    sandbox_mode = "read-only"          # 或 workspace-write
    features.multi_agent_v2 = true
    suppress_unstable_features_warning = true

    [model_providers.mgmock]
    name = "mgmock"
    base_url = "http://127.0.0.1:<port>/v1"
    wire_api = "responses"              # 0.167.0 已不支持 wire_api="chat"
    env_key = "MG_CODEX_V2_FAKE_KEY"    # 只放虚构 Key，来自进程环境

判据：单 provider 足以让 root 与子线程都打到同一端点；子线程模型由 spawn_agent.model +
model_catalog_json 决定，不依赖第二个 provider。

## 2. 模型目录（model_catalog_json）

- 传参：-c model_catalog_json=<abs path>，文件形状 {"models":[...]}，必须非空。
- fixtures/models.v2.json 的两个条目（gpt-mock / deepseek-mock）**都显式声明** multi_agent_version:"v2"；
  这是递归门槛：只开全局 Feature 不够，子线程模型自身也要声明 V2。
- 实测必填字段（serde 逐个报错得出）：slug、display_name、supported_reasoning_levels、shell_type、
  visibility、supported_in_api、priority、support_verbosity、truncation_policy{mode,limit}、
  experimental_supported_tools，且必须给 base_instructions（或 model_messages.instructions_template）。
- 递归实测：root(gpt-mock) → worker(deepseek-mock) → grandchild(gpt-mock) 三级都拿到协作工具，
  且 grandchild 的模型确实由 catalog 条目的 slug 决定。

## 3. V2 协作工具声明形状（发给上游的 tools[]）

顶层是一个 namespace 工具（不是 6 个平级 function）：

    {
      "type": "namespace",
      "name": "collaboration",
      "description": "Tools for spawning and managing sub-agents.",
      "tools": [
        { "type": "function", "name": "spawn_agent", ... },
        { "type": "function", "name": "send_message", ... },
        { "type": "function", "name": "followup_task", ... },
        { "type": "function", "name": "wait_agent", ... },
        { "type": "function", "name": "list_agents", ... },
        { "type": "function", "name": "interrupt_agent", ... }
      ]
    }

- **共 6 个工具**（任务书最初只写 4 个；实测另有 list_agents 与 interrupt_agent）。
- spawn_agent 参数：task_name、message、model、reasoning_effort、fork_turns（"none"|"all"）。
  **没有 agent_type**：本版本无法从 V2 工具点名角色文件。
- **只有三个消息工具有 message 参数并带 "encrypted": true**：spawn_agent、send_message、followup_task；
  wait_agent 只有 timeout_ms、list_agents 只有 path_prefix、interrupt_agent 只有 target（无 message、无 encrypted）。
  这是网关去掉 encrypted 标注的判定点（按 3 个处理，不要按 6 个）。
  普通工具（exec_command 等）是扁平 {"type":"function",...}，无 namespace、无 encrypted 标注。
- 角色 TOML：二进制确有 $CODEX_HOME/roles/*.toml 发现逻辑，但 spawn_agent 无角色选择参数，
  provider/权限继承父线程。因此本套件**不使用 role TOML**，也不声称角色锁模型可用；
  模型锁定走 spawn_agent.model + catalog。

## 4. 请求形状（Codex → 上游）

### 4.1 root 首请求

- POST <base_url>/responses，body keys：model、stream、input、tools、tool_choice、
  parallel_tool_calls、reasoning、store、include、prompt_cache_key、client_metadata。
- input 顺序：developer×4（含 skills 指令与 cwd 等）→ user×2（环境上下文 + 用户 prompt）。
- client_metadata 关键字段（用于身份关联，只读）：
  session_id、thread_id、turn_id、root_turn_id、x-codex-window-id、
  x-codex-turn-metadata{agent_name:"/root", thread_source:"user", turn_trigger:"exec",
  sandbox_mode, model, request_kind:"turn", history_initialization:"new"}。

### 4.2 子线程首请求（原生委派）

- 同一 base_url，model = spawn_agent.model（实测 deepseek-mock）。
- input：developer×4 + user + **agent_message**（不是 message:user）。
- agent_message 形状（实测）：

      {
        "type": "agent_message",
        "id": "amsg_...",
        "author": "/root",
        "recipient": "/root/worker",
        "content": [{ "type": "input_text",
          "text": "Message Type: NEW_TASK\nTask name: /root/worker\nSender: /root\nPayload:\\n<任务正文>" }]
      }

- 请求头：x-codex-parent-thread-id=<root>、x-openai-subagent=collab_spawn。
- client_metadata：thread_id=<child>、x-codex-parent-thread-id=<root>、
  x-codex-turn-metadata{agent_name:"/root/worker", parent_thread_id, parent_turn_id,
  root_turn_id, thread_source:"subagent", subagent_kind:"thread_spawn", depth:1, model}。
- 子线程 turn_context.model 是实际路由模型；但 session_meta.base_instructions.provenance 仍是父模型
  （继承父 instructions），**不能用它判断路由**。

## 5. mock 最小 SSE（让 Codex 真的执行工具/协作调用）

    event: response.created      data: {response:{id,status:"in_progress",model,output:[]}}
    event: response.output_item.added   data: {output_index,item}
    event: response.output_item.done    data: {output_index,item}
    event: response.completed    data: {response:{id,status:"completed",model,output:[item],
                                        usage:{input_tokens,output_tokens,total_tokens}}}

- 协作工具完成项必须带：

      { "type": "function_call", "namespace": "collaboration", "name": "spawn_agent",
        "call_id": "...", "arguments": "{...}", "encrypted_function_args": [] }

- 普通工具完成项**绝不能带 namespace**（带上的实测报错：
  ERROR codex_core::tools::router: error=unsupported call: collaborationexec_command）。
- function_call_arguments.delta/.done 不是必需；实测 added+done+completed 即可执行。
- 违规/未知形状会让 Codex 直接报错或忽略，所以 mock 只按上述形状编排输出。

## 6. 完成通知与控制流（原生生成）

- 子代理完成 → Codex 生成原生 agent_message 通知给 root：

      { "type": "agent_message", "author": "/root/worker", "recipient": "/root",
        "content": [{ "type": "input_text",
          "text": "Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/worker\nPayload:\\n<最终答复>" }] }

- wait_agent 会被该通知唤醒：function_call_output = {"message":"Wait completed.","timed_out":false}。
  无活动时超时：{"message":"Wait timed out.","timed_out":true}。
- 乱序：root 第 2 回合（含 function_call + function_call_output）与子线程首请求并发到达；
  编排必须按 model + input 内容判态，不能按第 N 个请求硬编码。
- send_message 对**闲置**目标只排队、不起新 turn（实测 child 请求数不增，随后的 wait_agent 超时）。

## 7. 并发 / 审批 / 取消 / 冷恢复（实测判据）

| 场景 | 实测结果 |
| --- | --- |
| 并发上限 | -c features.multi_agent_v2.max_concurrent_threads_per_session=1 时，同回合两个 spawn 都被原生拒绝：output = "collab spawn failed: agent thread limit reached"，且被拒 spawn 不产生子线程请求。注意该键只能走 -c 覆盖；写进 config.toml 会被 TOML 判为 "cannot extend value of type boolean with a dotted key"。 |
| 审批（read-only） | 子代理 exec_command 写文件 → 工具输出 "Read-only file system"、Process exited with code 1，文件不落地。 |
| 沙箱放宽（workspace-write） | 同一夹具下写成功：Process exited with code 0、文件内容 HELLO。exec 模式 approval_policy=never，**没有触发交互式审批提示**；本套件只证明"沙箱拒绝 vs 放宽放行"，不证明审批 UI/批准路径。 |
| 取消 | 用原生 interrupt_agent（不用外部信号）：子代理首回合被 mock 拖住，root 在回合内 interrupt → 返回 {"previous_status":"running"}；随后 followup_task 在同一 child thread 上起新 turn，退出后 1.5s 稳定窗口内无新增请求（无重复投递）。 |
| 冷恢复 | codex exec resume <rootSid> 复用同一 root SID；resume 首请求历史重放含 collaboration namespace 的 function_call（含 encrypted_function_args:[]）、对应 function_call_output、以及上一轮 FINAL_ANSWER agent_message。resume 后 followup_task 触发的新 turn 落在**原 child thread**（thread_id 一致）。取消后同样可 resume，且 followup 仍落在原 child。 |
| resume 参数 | resume 子命令不接受 -s/-C/--ephemeral（只认 -c/-m/--json/--skip-git-repo-check 等）；sandbox 与 cwd 来自 config.toml 与原 session。 |

## 8. 复现命令

    node --check scripts/test/offline/codex-v2-lifecycle.test.mjs
    node --test scripts/test/offline/codex-v2-lifecycle.test.mjs          # 默认门禁：只跑快测
    MG_CODEX_V2=1 node --test scripts/test/offline/codex-v2-lifecycle.test.mjs   # 真实 CLI + app-server

app-server 组件验收用公开 JSON-RPC：initialize → model/list → thread/start → turn/start → thread/read。
实测 bundled 0.167.0-alpha.3.2 会读取 model_catalog_json，thread.modelProvider=mgmock、thread.model=gpt-mock，
turn/start 真的打到隔离 provider；thread/read 返回同一 thread 与 preview。

## 9. 边界与未验证项

- 本套件未验证：真实 OpenAI/DeepSeek 上游、真实 Desktop GUI、ChatGPT 工作区认证、计费；
  Phase B（base_url 指向隔离网关、两路上游各收各的模型/鉴权/工具声明）等 Lead 放行后另跑。
- 审批的交互式批准路径（approval_policy=on-request + TUI）未验证；仅验证沙箱拒绝/放宽。
- fork_turns:"all" 未纳入本套件首版（先做 none，符合契约 §9）。
- role TOML 锁模型未验证（spawn_agent 无角色参数，见 §3）。
- 高并发交错、动态工具（multi_agent_v2_dynamic_tools）、MCP/apply_patch 覆盖未验证。

## 10. Phase B（base_url 指向隔离网关，单 provider）

Codex 侧只配一个 provider（-c 传入，避免 --ignore-user-config 把 CODEX_HOME/config.toml 一起忽略）：

    -c model=codex-gpt -c model_provider=mg
    -c model_providers.mg={name="ModelGate",base_url="http://127.0.0.1:<gw>/v1",
                           env_key="MG_CODEX_V2_FAKE_KEY",wire_api="responses"}
    -c model_catalog_json=<catalog with codex-gpt / codex-deepseek>
    -c features.multi_agent_v2=true

网关配置：两个 provider（openai-mock / deepseek-mock，api:"responses"，各自 apiKeyEnv 假 Key）+ 两个 codex
试点模型（providerModels 覆盖到 gpt-mock / deepseek-mock；codex-gpt history.agentMessage=preserve、
reasoning=preserve；codex-deepseek agentMessage=project、reasoning=drop）+ strictModelRouting=true。
mock 位于网关后方，因此**只按"上游视角"编排**：协作工具返回扁平 function_call（无 namespace、
无 encrypted_function_args），namespace/name 的恢复由网关负责，否则测不到网关。

实测收据（原版 CLI exit 0，root/child 两路）：

| 断言 | 实测 |
| --- | --- |
| OpenAI mock 的 model | gpt-mock（客户端 codex-gpt 被 providerModels 覆盖） |
| OpenAI mock 的工具声明 | 无 namespace 类型；6 个协作工具扁平化；spawn_agent.message 无 encrypted 标记 |
| OpenAI mock 的 Authorization | Bearer <openai provider key>；无 chatgpt-account-id、无 cookie |
| OpenAI mock 的 body | 无 client_metadata、无 prompt_cache_key |
| DeepSeek mock 的 model | deepseek-mock |
| DeepSeek mock 的 input | 结构上**无 agent_message**（已投影为 message/user），正文含 "[agent_message from=/root to=/root/worker]" |
| DeepSeek mock 的 Authorization | Bearer <deepseek provider key> |
| DeepSeek mock 的 header | 无 x-openai-subagent（Codex 的子代理标记不转发） |
| 子代理真实工具 | 子线程模型回合发出 exec_command 后，function_call_output 里出现 nonce B（Codex 真实执行） |
| 完成通知 | root 收到原生 agent_message FINAL_ANSWER，final 文本含 A+B；wait_agent 被唤醒 |
| 递归 | worker(codex-deepseek→deepseek-mock) spawn grandchild(codex-gpt→openai-mock)，三份 rollout 路径/父子/depth 正确 |

判据：Phase B 断言的是"网关转换后的上游视角"，不是真实供应商；mock 仍只是模型输出的编排器。

## 11. 本轮新增的接口事实（供映射层复核）

1. **重放会清掉 marker**：codex exec resume 重放历史时，function_call 仍带 namespace:"collaboration"、
   name、call_id、arguments，但 encrypted_function_args 被清掉（自定义 provider 出站构造）。
   网关不得依赖重放项里的 marker，必须按本轮声明集合恢复。
2. **DeepSeek 侧完成通知是普通 message**：agentMessage=project 时，完成通知（FINAL_ANSWER）在
   DeepSeek 路由看到的是普通 user message，正文保留 Message Type/Sender/Payload 段；
   子代理后续回合只能按正文标记判断，不能依赖 type。
3. **外部信号取消不适合做门禁**：向 codex exec 发 SIGINT，本机实测会出现进程长时间不退出
   （有时退出码 0、有时挂住），取消语义不稳定。套件改用原生 interrupt_agent + followup_task：
   断言"中断返回 previous_status、followup 落在同一 child、退出后无新增请求"，不依赖精确请求数。
   取消后立即 `codex exec resume` 的行为同样不稳定，未计为通过。
4. **子线程身份字段位置**：depth 只在 rollout 的 session_meta.source.subagent.thread_spawn 里；
   请求的 x-codex-turn-metadata 有 agent_name/thread_id/parent_thread_id/subagent_kind，但没有 depth。
   经网关后 client_metadata 被剥离，mock 侧只能用 input 形状 + model 区分身份。
