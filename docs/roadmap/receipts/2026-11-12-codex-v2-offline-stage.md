# 收据 · Codex Multi-Agent V2 离线阶段（2026-11-12）

> **阶段标签：`OFFLINE` —— 离线阶段，不含真实上游。** 本收据里的任何数字都不得被引用为「真实验收通过」；真实用例见[验收矩阵](../2026-11-12-codex-v2-acceptance.md) §3/§4，全部 `BLOCKED_PENDING_AUTHORIZATION`。
> 范围内不做：真实 GPT/DeepSeek 调用、GUI 操作、Desktop 配置改写、`~/.codex` 写入、8787/systemd、git commit/push、任何依赖安装。

**状态：离线性验收完成（OFFLINE + COMPONENT 级，代码/测试已冻结），真实验收仍 `BLOCKED_PENDING_AUTHORIZATION`。** 定稿 2026-11-12 16:13（Asia/Shanghai）；本收据不含任何真实上游证据，不抬高记分卡等级。

## 0. 标识

| 字段 | 值 |
| --- | --- |
| 收据 ID | `MG017-OFFLINE-none-20261112-01` |
| 阶段标签 | `OFFLINE`（+ 其中 CMP-* 行属 `COMPONENT` 级离线断言） |
| 客户端 | `none(离线)`：CLI 与 Desktop 二进制只做版本/形状断言，未发起真实回合 |
| 执行人 / 复核人 | `client-acceptance`（队友） / 待 Lead 复核 |
| 时间窗 | 2026-11-12 13:22～13:36（Asia/Shanghai） |
| 工作树 / 分支 | `/home/xiaomengxizi/ai/workplace/idproject/model-gateway/.agents/worktrees/codex-multiagent-v2` / `codex-multiagent-v2` |
| `git rev-parse HEAD` | `3a4ba8956732e2aabdff2cfce8a118107189542a` |
| `git status --short` 摘要 | `M src/router.js`（同队 gateway-routing 进行中，非本收据写集）、`?? docs/contracts/codex-multi-agent-v2.md`、`?? docs/roadmap/2026-11-12-codex-v2-acceptance.md`、`?? docs/roadmap/receipts/`（本收据写集） |

> **基线为何在干净副本里跑**：本工作树的 `src/router.js` 正被同队改写（未提交），在工作树内直接跑回归会把「同队半成品」当基线。因此 BASE-01～03 在 `git archive HEAD` 解出的干净副本（`/tmp/mg-baseline-3a4ba89`，只读解压，未修改工作树）里执行，结果等价于 HEAD `3a4ba89` 的基线。工作树内的同一批命令也跑过一次，结论相同（见备注 B-1）。

## 1. 环境指纹

| 项 | 值 | 复核命令 |
| --- | --- | --- |
| Node | `v24.22.2` | `node -v` |
| CLI 版本 + sha256 | `codex-cli 0.167.0` / `sha256:cdcb45aaa01d0f14e298985e09465aebccd47f64ecd298aea44814af7b62bbda` | `/home/xiaomengxizi/ai/harness/codex/cli/bin/codex --version`；`sha256sum …/cli/versions/current/vendor/x86_64-unknown-linux-musl/bin/codex` |
| CLI 入口解析 | wrapper → `cli/versions/current/…`，`readlink -f` = `cli/versions/0.167.0/vendor/x86_64-unknown-linux-musl/bin/codex` | `ls -l`；`readlink -f` |
| Desktop 捆绑版本 + sha256 | `codex-cli 0.167.0-alpha.3.2` / `sha256:c8242fc9e1bac7c6d661a228cecfaf50e6db74da219e4a9ca8912827e11607f0` | `/usr/lib/chatgpt/resources/codex --version`；`sha256sum` |
| 插件 app-server sha256 | 同上 `c8242fc9…`（同哈希） | `sha256sum ~/.codex/plugins/.plugin-appserver/codex` |
| 实际运行的 bundled app-server | `/usr/lib/chatgpt/resources/codex -c features.code_mode_host=true app-server --analytics-default-enabled -c plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true`（GUI 进程 `/usr/lib/chatgpt/ChatGPT` 同日运行） | `pgrep -a -f /usr/lib/chatgpt/resources/codex` |
| app-server 自报版本 | `{"appServerVersion":"0.167.0-alpha.3.2","configRequirements":{"supportsIndependentSpeedModes":true,"requirements":null}}` | `… app-server --print-startup-config` |
| 隔离 `CODEX_HOME` | 本轮全部探针目录用后即删（`$HOME/.cache/mg-codex-acceptance-probe`、`mktemp -d`），**未残留**、**未写 `~/.codex`** | `test -d … && echo NO` → `YES(已删)` |
| `MG_CONFIG_DIR` / `MG_CONFIG` | 未创建（离线阶段未起网关；避免与同队集成实例抢端口/配置） | — |
| 网关口径 | 未启动隔离网关；8787 未监听、未触碰 | `curl -s -m 2 127.0.0.1:8787/healthz` 未执行（按纪律不探测生产） |
| **目录指纹** | 离线阶段无长期配置目录 → 记 `N/A`（真实阶段按矩阵 §2.8 必填） | — |

## 2. 授权块

| 编号 | 授权项 | 状态 | 说明 |
| --- | --- | --- | --- |
| A1 | 认证模式 | `NOT_GRANTED` | 离线阶段不需要；因此 CL-*/DS-* 真实行全部 `BLOCKED_PENDING_AUTHORIZATION` |
| A2 | 模型与档位 | `NOT_GRANTED` | 同上；本轮未选择任何真实服务模型 |
| A3 | 费用上限 | `NOT_GRANTED` | 本轮真实上游花费 **0** |
| A4 | 数据范围 | `NOT_GRANTED` | 本轮未发送任何数据出本机 |
| A5 | 隔离 Desktop 入口 | `NOT_GRANTED` | 未改 Desktop 配置、未重启 Desktop |
| A6 | 隔离运行面 | `NOT_GRANTED` | 未起网关实例 |
| A7 | 凭据放置 | `NOT_GRANTED` | 未读取/未使用任何上游凭据 |

## 3. 用例行

### 3.1 基线回归（`OFFLINE`，干净 HEAD 副本）

| 用例 ID | 状态 | 运行命令 | 实际输出摘要 | 证据文件 | 归因 |
| --- | --- | --- | --- | --- | --- |
| BASE-01 | `EXECUTED_PASS` | `git archive HEAD \| tar -x -C /tmp/mg-baseline-3a4ba89; cd …; npm run check` | 退出码 `0`（14 个 `node --check` 目标全过） | `/tmp/b-check.log`（临时，未入库） | — |
| BASE-02 | `EXECUTED_PASS` | 同上目录 `npm test` | 退出码 `0`；末行 `Isolated suites: 25/25 passed` | `/tmp/b-test.log` | — |
| BASE-03 | `EXECUTED_PASS` | `node --test scripts/test/offline/responses-mapping.test.mjs scripts/test/offline/responses-endpoint.test.mjs scripts/test/offline/responses-native.test.mjs` | `ℹ tests 27 / pass 27 / fail 0 / skipped 0`，退出码 `0` | `/tmp/b-resp.log` | — |
| BASE-04 | `EXECUTED_FAIL`（历史，已被 Lead 顺带修复） | `npm run docs:check` | 当时 `Documentation paths: FAIL (1)`：`docs/roadmap/2026-11-09-dsh-cli-live-verification-report.md: missing link ../../../../../harness/deepseek/docs/headless-runbook.md` | 终端输出 | **既有缺陷，非本轮引入**：干净 HEAD 副本上同样 `FAIL (1)`。Lead 已把该仓库外相对链接改掉（见「基线偏差」与 BASE-04b） |
| BASE-04b | `EXECUTED_PASS`（已闭环） | `npm run docs:check` | 先 `FAIL (1)`：`docs/development-plan.md: missing link roadmap/receipts/`；Lead 把该链接改为 `roadmap/receipts/README.md` 后复核 → `Documentation paths: PASS` | 终端输出 | `scripts/check-docs.mjs` 只接受**文件**目标（`statSync(dest).isFile()`），目录链接永不通过。该文件在 Lead 写集；本收据只提供可链接的 `README.md` 索引页 |
| BASE-05 | `EXECUTED_PASS` | `node scripts/check-metadata.mjs` | `Metadata: PASS (21 checks)`，退出码 `0` | 终端输出 | — |

### 3.2 组件级离线断言（`COMPONENT`，零上游、零联网）

| 用例 ID | 状态 | 运行命令 | 实际输出摘要 | 归因 |
| --- | --- | --- | --- | --- |
| CMP-01 | `EXECUTED_PASS` | `CODEX_HOME=$(mktemp -d) $CLI features list\| grep -E 'multi_agent\|code_mode'` | `multi_agent stable true`；`multi_agent_v2 stable false`；`multi_agent_v2_dynamic_tools under development false`；`code_mode under development false`；另记 `wake_on_agent_messages under development false`、`agent_message_board under development false` | — |
| CMP-02 | `EXECUTED_PASS` | `$CLI features list -c features.multi_agent_v2=true` | `multi_agent_v2 stable true`（显式开启生效，未改任何文件） | — |
| CMP-03 | `EXECUTED_PASS` | 写契约 §6 形状 catalog → `$CLI debug models -c model_catalog_json=<path>` | 输出含 `"slug":"codex-gpt" … "multi_agent_version":"v2" … "context_window":200000`；解析成功 | 发现：形状写 `shell_type:"default"`，渲染归一为 `"unified_exec"`（断言勿逐字节比） |
| CMP-04 | `EXECUTED_PASS` | `CODEX_HOME=$ISO/codex /usr/lib/chatgpt/resources/codex app-server --strict-config --print-startup-config`（config.toml 含 `model_provider`/`model_catalog_json`/`[features] multi_agent_v2`/`[model_providers.modelgate] env_key`） | 返回 `{"appServerVersion":"0.167.0-alpha.3.2",…}`，无 `configLoad` 错误 → 该键组合合法 | 这是本轮的**配置合法性权威断言**，替代猜测键名 |
| CMP-05 | `EXECUTED_FAIL`（负向断言，**符合预期**） | 把 CMP-04 的 `env_key` 换成 `bearer_token_env_var` | `{"error":{"code":-32600,"data":{"reason":"configLoad",…,"detail":"unknown configuration field `model_providers.modelgate.bearer_token_env_var`"}}}` | 结论：0.167.0 的 provider 凭据键是 `env_key`；已在矩阵 §2.4 固化 |
| CMP-06 | `EXECUTED_PASS` | `/usr/lib/chatgpt/resources/codex app-server generate-json-schema --out $ISO/schema` | 生成 39 个 schema 文件；`ClientRequest.json` 中 `thread/start`、`thread/read`、`thread/resume`、`turn/start`、`turn/interrupt`、`model/list` 全部 PRESENT；`Model` 含 `multiAgentVersion`；`ThreadStartParams`=`approvalPolicy,approvalsReviewer,baseInstructions,config,cwd,developerInstructions,ephemeral,model,modelProvider,personality,sandbox,serviceName,serviceTier,sessionStartSource,threadSource`；`ThreadResumeParams` 含 `threadId`；`ThreadReadParams` 含 `includeTurns`；`ModelListResponse`=`data,nextCursor` | Desktop 的 DS-10 组件断言可用 |
| CMP-07 | `EXECUTED_PASS` | `pgrep -a -f /usr/lib/chatgpt/resources/codex` | 命中 GUI 拉起的 app-server 与 exec-server 两进程，argv 已抄录于 §1 | 「实际运行的 bundled app-server」可被客观采集 |
| CMP-08 | `EXECUTED_PASS`（发现项） | `CODEX_HOME=/tmp/<mktemp> $CLI features list` | `WARNING: proceeding, even though we could not create PATH aliases: Refusing to create helper binaries under temporary dir "/tmp"` | 结论：隔离 `CODEX_HOME` **不要放 /tmp**；矩阵 §2.2 已固化 |
| CMP-09 | `EXECUTED_PASS`（发现项） | 在 `$CODEX_HOME/agents/` 放坏 TOML / 缺 `developer_instructions` 的角色文件，跑 `features list` 与 `app-server --print-startup-config` | 两者都不报错 → **角色文件是懒加载**（spawn 时才读）；二进制字符串含 `agent role file at …` / `must define developer_instructions` / `developer_instructions cannot be blank` | 角色目录与键名**留待真实 spawn 确认**，矩阵 §2.7 已标「待确认」 |
| CMP-10 | `NOT_EXECUTED` | — | 角色文件在真实 spawn 下的加载路径/键名校验未做（需授权） | 需 A1+A2 |

### 3.3 同队新增离线套件

| 用例 ID | 状态 | 说明 |
| --- | --- | --- |
| NEW-01 `codex-responses.test.mjs`（纯映射） | `NOT_EXECUTED` | 文件在本轮取样时尚未落地 |
| NEW-02 `codex-responses-stream.test.mjs`（SSE） | `NOT_EXECUTED` | 同上 |
| NEW-03 `codex-v2-lifecycle.test.mjs`（两 mock + 原版 Codex 生命周期） | `NOT_EXECUTED` | 同上；落地后由集成复跑写入本收据的续页 |

### 3.4 真实验收用例（本收据一律不判）

| 用例范围 | 状态 | 阻塞项 |
| --- | --- | --- |
| CL-00～CL-14（CLI） | `BLOCKED_PENDING_AUTHORIZATION` | A1～A4、A6、A7 |
| DS-00～DS-09（Desktop GUI） | `BLOCKED_PENDING_AUTHORIZATION` | A1～A7，其中 DS-01 需 A5 |
| CARD-API / CARD-ChatGPT 等级 | `BLOCKED_PENDING_AUTHORIZATION` | 同上；CARD-ChatGPT 另需先实现官方头 allowlist（契约 §3.6 首版不实现） |

### 3.5 Lead 的 Phase B：原版 CLI → 隔离网关（单 provider）→ 两 mock 上游（**OFFLINE 级，mock 上游**）

> 两次运行，结论不同，必须分开记：**PHASEB-00** 是首跑（client 竞态 → `EXECUTED_PARTIAL`），**PHASEB-01** 是修 mock 后的复跑（`EXECUTED_PASS`，**仍只是 OFFLINE 级**）。
> 证据目录 `/tmp/mg-phaseb/`：`run.json`、`records.json`、`ports.json`、`catalog.json`、`mock.mjs`、`run.mjs`、`mgcfg/{gateway.json,test-2026-11-12.log,stats.json}`（由 Lead 执行，本收据独立复核落盘原文）。
> **mock 只编排模型输出；线程、委派、通知、等待由原版 Codex 生成。这不构成真实供应商验收。**

| 用例 ID | 状态 | 运行命令（可复现） | 实际输出摘要 | 归因 |
| --- | --- | --- | --- | --- |
| PHASEB-00 | `EXECUTED_PARTIAL` | 首跑，同下命令但 mock 在 spawn 的 `function_call_output` 之后直接回 `ROOT_FINAL_OK` | 3 次上游请求（openai-mock×2 / deepseek-mock×1）；DS 路在收到 mock 响应头后 ~1ms 出现 `request aborted client_closed /v1/responses`；`stats.json`：codex-gpt 26 tokens / `global.requests=2` / deepseek-mock requests=0、tokens=0；子线程 turn 未完成 | **client 竞态**：root 拿到 spawn 输出立刻给 final → 非交互 CLI 退出 → 子线程被终止。**非网关缺陷** |
| PHASEB-01 | `EXECUTED_PASS`（OFFLINE 级） | `node /tmp/mg-phaseb/mock.mjs`（改版：spawn 后先回 `wait_agent{timeout_ms:60000}`；判态改为检查 input 里 `function_call.name`，不用字符串子串）→ `MG_CONFIG_DIR=/tmp/mg-phaseb/mgcfg MG_CONFIG=…/gateway.json node src/index.js`（端口 8899）→ `$CLI exec --skip-git-repo-check --ignore-user-config --ephemeral -s read-only -C /tmp/mg-phaseb -c model=codex-gpt -c model_provider=mg -c 'model_providers.mg={…,env_key="MG_CODEX_FAKE_KEY",wire_api="responses"}' -c model_catalog_json=…/catalog.json -c features.multi_agent_v2=true "Spawn a worker agent with model codex-deepseek to answer, then report."`（`CODEX_HOME=/tmp/mg-phaseb/home` + 假 Key） | Codex `exit 0`、stdout 末行 `ROOT_SAW_NOTIFICATION`、stderr 含 `collab: Wait`；4 次上游请求（见下表）；两路各自记账；root 第 3 回合消费到原生 `agent_message`（FINAL_ANSWER） | — |

**字段级证据（本收据复核的原文值；两次运行对照）**

| 字段 | PHASEB-00（首跑） | PHASEB-01（复跑，PASS） |
| --- | --- | --- |
| 时间 | 日志 UTC `06:18:15Z`～`06:18:26Z`（14:18:15～14:18:26 +08:00） | 日志 UTC `06:39:39Z`～`06:39:50Z`（14:39:39～14:39:50 +08:00）；4 次请求 `06:39:40.348/.370/.376/.391Z` |
| CLI 版本 + sha256 | `codex-cli 0.167.0` / `sha256:cdcb45aa…b62bbda` | 同左（同一二进制） |
| root session id | `01a1ce68-2c10-7bd2-9041-051ce875c0fb` | `01a1ce7b-c427-7590-8416-7cf3136f0983` |
| 网关隔离配置目录 | `MG_CONFIG_DIR=/tmp/mg-phaseb/mgcfg`、`MG_CONFIG=…/gateway.json`、`127.0.0.1:8899`、`logFile=…/test.log`、`strictModelRouting=true`、`retry.maxAttempts=1` | 同左（同一配置；每轮重建 stats/log） |
| 上游请求序列 | openai×2、deepseek×1 | **openai×3、deepseek×1（共 4）**：①openai 6×message→`spawn_agent{task_name:worker,model:codex-deepseek,fork_turns:none,message:…}`；②openai 6×message+`function_call(spawn_agent)`+`function_call_output{"task_name":"/root/worker"}`→`wait_agent{timeout_ms:60000}`；③deepseek 6×message→`CHILD_OK`；④openai 尾部 `function_call wait_agent`→`function_call_output{"message":"Wait completed.","timed_out":false}`→`agent_message`(FINAL_ANSWER) |
| 上游 model | openai→`gpt-mock`（providerModels 覆盖）、deepseek→`deepseek-mock` | 同左 |
| 上游 Authorization 类别 | openai→`openai-provider-key`、deepseek→`deepseek-provider-key`；`chatgpt-account-id=null`、`cookie=null`、`x-openai-subagent=null` | 同左（4 次全部） |
| 工具声明形状 | 14 项扁平（`exec_command`、`write_stdin`、`request_user_input`、`view_image`、`followup_task`、`interrupt_agent`、`list_agents`、`send_message`、`spawn_agent`、`wait_agent`、`get_goal`、`create_goal`、`update_goal`、`web_search`）；`hasNamespaceTool=false`；`spawnHasEncrypted=false` | 同左（4 次全部） |
| input item 类型 | openai 第 1 次 6×message；第 2 次 +`function_call`+`function_call_output`；deepseek 6×message（末条 `[agent_message from=/root to=/root/worker]` 文本） | openai ①6×message ②6×message+fc+fco ④尾部 `function_call(wait_agent)`+`function_call_output(Wait completed.,timed_out:false)`+`agent_message`；deepseek ③6×message，**无原生 `agent_message` 结构**，末条正文为 `[agent_message from=/root to=/root/worker]` + Payload |
| 客户端元数据 | 两路 `hasClientMetadata=false`、`hasPromptCacheKey=false` | 同左（4 次全部） |
| 网关日志 | `include_dropped:reasoning.encrypted_content`×3、`codex 剥离客户端元数据`×3、第 3 次含 `agent_message_projected`、`request aborted client_closed`×1 | `include_dropped:reasoning.encrypted_content`×4、`codex 剥离客户端元数据`×4、第 3 次（DS 路）含 `agent_message_projected`、**无 aborted**（正常关闭） |
| token 统计（`stats.json` 原文） | codex-gpt 26（in22/out4）；`global.requests=2`；openai-mock 2/26；deepseek-mock 0/0；codex-deepseek 0 | **codex-gpt 39（in33/out6）、codex-deepseek 13（in11/out2）**；`global.requests=4, errors=0, tokens=52`；openai-mock 3/39、deepseek-mock 1/13（两路 `errors=0`） |
| 子线程身份 | 仅 task path `/root/worker`；child UUID 未落盘；子线程 turn 未完成 | task path `/root/worker`（spawn 工具输出）+ 第 4 次 input 里 `agent_message` 的 `Task name: /root` / `Sender: /root/worker`；**child UUID 仍未落盘**（需 app-server/rollout 提供，属下一阶段补证项） |
| 子线程终态 | 无（client_closed 中止） | 子线程回合完成并被记账（deepseek-mock 1 请求、13 tokens），root 通过 `wait_agent` 的完成通知收到 `FINAL_ANSWER` |

**两次运行的差别（正是矩阵要抓的 client 竞态）**

PHASEB-00 里 root 拿到 `spawn_agent` 输出后立刻给 final，非交互 `exec` 随即退出，子线程那条流在 ~1ms 内被 `client_closed` 掐断——于是网关既不记 DS 请求也不记 usage，`CHILD_OK` 从未被消费。PHASEB-01 让 root 先 `wait_agent`，子线程 turn 正常完成、请求记账、`wait_agent` 被原生完成通知唤醒、root 第 3 回合真正消费到 `FINAL_ANSWER` 的 `agent_message`。**归因在客户端编排（是否等待），不在网关。**

**PHASEB-01 已证明 / 仍未证明**

- 已证明（mock 级）：原生 `spawn_agent` 真的落到子线程；两路各自路由到固定 mock 且用网关持有的服务端凭据；工具声明扁平、`message` 无 encrypted；DS 路 `agent_message` 被投影成带方向前缀的 user 文本（无原生结构）；GPT 路保留原生 `agent_message`（`history.agentMessage=preserve`）；客户端元数据未外发；`wait_agent` 完成通知回流并被 root 消费；两路 usage 各自记账。
- 仍未证明：**child UUID**、真实供应商语义（模型是否真消费任务）、真实计费、GUI 侧一切、并发/审批/取消/冷恢复。因此 `EXECUTED_PASS` 只适用于**本行（OFFLINE 级）**，不抬高 §2 记分卡等级。

**复现注意（已吸收进矩阵 §2.4）**

- `--ignore-user-config` 会让 Codex 忽略 `CODEX_HOME/config.toml`，必须 `-c` 显式传 `model_provider` 与整块 `model_providers`。
- `prefer_websockets` **不是**合法 `-c` 键（`run.json` stderr：`… prefer_websockets is ignored`），不要写进命令。

## 4. 身份与关联证据

离线阶段**没有**原生 Codex 会话 → 本表全部 `N/A`。这正是「离线通过 ≠ 真实验收」的依据：矩阵 §6 的最少字段一个都取不到，所以本轮**不能**判定任何等级。

| 字段 | root | child | grandchild |
| --- | --- | --- | --- |
| 线程 ID（SID） | N/A | N/A | N/A |
| turn ID | N/A | N/A | N/A |
| 工具 call ID | N/A | N/A | N/A |
| 上游响应 ID | N/A | N/A | N/A |
| SSE 终态 | N/A | N/A | N/A |
| nonce A/B | N/A | — | — |

## 5. 上游收据与 mock 边界

| 路 | 本轮请求数 | 费用 | 说明 |
| --- | --- | --- | --- |
| GPT 真实上游 | `0` | `0` | 未配置、未调用 |
| DeepSeek 真实上游 | `0` | `0` | 未配置、未调用 |
| 本地 mock 上游 | 由 `npm test` 驱动（自包含） | `0` | 只跑既有离线套件，未新增 mock 场景 |

边界声明：

- [x] 本收据**不含真实上游**（阶段标签 `OFFLINE`）。
- [x] 未启动任何隔离网关实例；8787/systemd 全程未触碰。
- [x] 未改写 `~/.codex`；所有探针 `CODEX_HOME` 为临时目录且已删除。
- [x] 未联网、未安装/下载/升级任何东西（零新增依赖）。
- [x] 未执行 `git commit`/`git push`。
- [x] 未创建或调用任何子代理/外部代理。

## 6. 脱敏与泄漏扫描

| 检查 | 方法 | 结果 |
| --- | --- | --- |
| 收据无 Key/Token | 本文件按「只写变量名/布尔/哈希」写就；未读取任何上游凭据 | `hits=0`（人工核对，无变量值入文） |
| 无请求正文/prompt 全文 | 离线阶段未发起真实回合；日志路径未产生 | `suspects=0` |
| 无账号标识 | 未登录、未读 `auth.json` | `suspects=0` |

## 7. 结论

| 项 | 值 |
| --- | --- |
| 记分卡 | 两张均**不登记**（离线阶段） |
| 等级 | **不可判定**；对真实用例记 `BLOCKED_PENDING_AUTHORIZATION` |
| 通过项 | 基线回归 BASE-01/02/03/05；组件断言 CMP-01～CMP-04、CMP-06～CMP-09；**PHASEB-01 = `EXECUTED_PASS`（OFFLINE 级）**；**阶段 2 全绿**：S2-01～S2-12（`isolation 29/29`、responses 27/27、codex-responses 44/44、codex-responses-stream 38/38（R4 修复后）、codex-routing 8/8、lifecycle 默认门禁 6 pass/10 skip、gated 16/16（129s）） |
| 失败/例外项 | ①BASE-04 历史 `docs:check` 缺链（既有缺陷，已由 Lead 顺带修复）；②BASE-04b 的目录链接已由 Lead 改为 `roadmap/receipts/README.md`，2026-11-12 14:4x 复核 `docs:check` = **PASS**（`Documentation paths: PASS`）；③CMP-05 为预期内负向断言（符合预期，不是缺陷）；④**PHASEB-00 = `EXECUTED_PARTIAL`**（首跑 client 竞态，已被 PHASEB-01 覆盖） |
| 未执行项 | CMP-10（角色 TOML 加载路径）、Desktop GUI 用例、全部 CL-*/DS-* 真实用例；Windows/macOS 与 Node 18/20 |
| 与矩阵的偏差 | 无代码判据改动；但据 Phase B 证据补了两条运行约束进矩阵（`--ignore-user-config` 下必须 `-c` 显式传 provider；`prefer_websockets` 非法键） |
| 回退是否执行 | 不需要（Phase B 用的是隔离实例 8899，非生产；8787 未触碰） |
| 下一步 | ①用户填[矩阵](../2026-11-12-codex-v2-acceptance.md) §1 授权；②授权后先跑 CARD-API 的 CL-00/CL-01 最小试点（最小额度、失败即停）；③Desktop 先 DS-00/DS-10（组件）再进 GUI；④按 §9.1 的 R1/R2 在真实客户端版本上做一次形状回归 |

## 8. 备注

- **B-1**：同一批命令在工作树内（`src/router.js` 为同队未提交改动）也跑过：`npm run check` 退出码 0、三个 responses 套件 27/27、`npm test` 25/25——与干净 HEAD 副本一致，说明工作树的进行中改动在本轮取样时刻未破坏既有回归。**但集成后必须重跑并以那时输出为准**，本行不得当作同队改动已验收。
- **B-2**：`/tmp/mg-baseline-3a4ba89`、`/tmp/b-*.log` 为临时证据，未入库；需要复核时可凭 §3.1 的命令在任意干净 HEAD 副本重建。
- **B-3**：发现的权重写进验收矩阵：`env_key`（非 `bearer_token_env_var`）、`CODEX_HOME` 不放 `/tmp`、角色文件懒加载、`shell_type` 渲染归一。
- **B-4（基线偏差说明）**：BASE-04 的 `docs:check` 失败是**既有缺陷**（干净 HEAD 上就能复现，指向仓库外 `harness/deepseek/docs/headless-runbook.md`），本轮由 **Lead 顺带修复**（改成不依赖工作树深度的写法）——不是本轮引入，也不是本收据修掉的。修复后又出现 BASE-04b 的新失败：`check-docs.mjs` 要求链接目标是**文件**，`docs/development-plan.md` 的 `receipts/` 指向 `roadmap/receipts/` 的目录链接 指向目录。该文件属 Lead 写集，本收据不越界修改；本目录已补 `README.md` 索引页作为可链接文件。
- **B-5**：Phase B 的证据目录 `/tmp/mg-phaseb/` 是临时/仓库外证据（含 `records.json` 等），未入库；本收据只写摘要与类别，未复制请求正文。需要复核时按 §3.5 的命令重建。

## 9. 阶段 2（集成复跑）—— 已执行（2026-11-12 15:31～15:44 +08:00）

> 执行人：`client-acceptance`（acceptance 复跑）；触发：Lead 通知「集成稳定，可 stage 2」。全部数字为**本轮实跑输出**，非转述。
> 除 §3.5 的 Phase B（Lead 执行、本收据复核）外，阶段 2 的命令均由本代理执行。

| 用例 ID | 命令 | 实际输出 | 状态 |
| --- | --- | --- | --- |
| S2-01 | `npm run check` | 退出码 `0`；`node --check` 目标 16 个（含新增 `src/codex-responses.js`、`src/codex-responses-stream.js`） | `EXECUTED_PASS` |
| S2-02 | `npm test` | 退出码 `0`；末行 `Isolated suites: 29/29 passed`（白名单按 `scripts/test/run.mjs` 实测 = 3 旧套件 + 26 个 offline 套件） | `EXECUTED_PASS` |
| S2-03 | `node --test …/responses-{mapping,endpoint,native}.test.mjs` | `tests 27 / pass 27 / fail 0 / skipped 0`，退出码 `0`（与基线 27/27 一致，无回退） | `EXECUTED_PASS` |
| S2-04 | `node --test …/codex-responses.test.mjs` | `tests 44 / pass 44 / fail 0 / skipped 0`，退出码 `0` | `EXECUTED_PASS` |
| S2-05 | `node --test …/codex-responses-stream.test.mjs` | **R4 修复后复跑（15:55）**：`tests 38 / pass 38 / fail 0 / skipped 0`，退出码 `0`（修复前为 36/36，新增 2 例覆盖 `response.incomplete` 的 `output[]` 身份恢复） | `EXECUTED_PASS` |
| S2-06 | `node --test …/codex-routing.test.mjs` | `tests 8 / pass 8 / fail 0 / skipped 0`，退出码 `0` | `EXECUTED_PASS` |
| S2-07a | `node --test …/codex-v2-lifecycle.test.mjs`（默认门禁） | `tests 16 / pass 6 / fail 0 / **skipped 10**`（R4 后复跑同值），退出码 `0`。**10 条 skip 不计入通过**，只算「默认门禁未被跳过部分」 | `EXECUTED_PASS`（仅默认门禁） |
| S2-07b | `MG_CODEX_V2=1 node --test …/codex-v2-lifecycle.test.mjs`（本代理 acceptance 复跑；R4 修复后 15:56 重跑） | 退出码 `0`，耗时 `126s`（定稿重跑）；`tests 16 / pass 16 / fail 0 / skipped 0`（修复前 122s，同为 16/16）。逐项含 spawn→真实工具 nonce→通知、闲置 send 只排队、递归、并发上限原生拒绝、审批 read-only 拒绝 vs workspace-write 放行、冷恢复（同 root SID+同 child+历史重放）、`interrupt_agent` 取消、Phase B 生命周期、Phase B 递归、app-server 组件 | `EXECUTED_PASS` |
| S2-07c | 同上（Lead 独立复跑，15:29 起，非转述） | 退出码 `0`；`tests 16 / pass 16 / fail 0 / skipped 0`（约 124s）；与我这次 16/16 一致。Lead 另记：旧版 SIGINT 取消用例曾出现 1 次 flake（`取消后 child 请求 0!==1`），改为原生 `interrupt_agent` 后复验通过 | `EXECUTED_PASS`（独立第三方复跑） |
| S2-08 | `npm run docs:check` | `Documentation paths: PASS`（BASE-04b 闭环） | `EXECUTED_PASS` |
| S2-09 | `node scripts/check-metadata.mjs` | `Metadata: PASS (21 checks)` | `EXECUTED_PASS` |
| S2-10 | `git rev-parse HEAD` / `git status --short` / `git diff --check` | HEAD `3a4ba8956732e2aabdff2cfce8a118107189542a`；未提交：`M CHANGELOG.md`、`M docs/development-plan.md`、`M docs/how-to/testing.md`、`M docs/reference/configuration.md`、`M docs/roadmap/2026-11-09-dsh-cli-live-verification-report.md`、`M package.json`、`M src/index.js`、`M src/router.js`；未跟踪：`docs/contracts/codex-multi-agent-v2.md`、`docs/contracts/fixtures/codex/`、`docs/roadmap/2026-11-12-codex-v2-acceptance.md`、`docs/roadmap/receipts/`、`scripts/test/offline/codex-responses*.test.mjs`、`scripts/test/offline/codex-routing.test.mjs`、`scripts/test/offline/codex-v2-lifecycle.test.mjs`、`scripts/test/offline/codex-v2-fixtures/`、`src/codex-responses*.js`；`git diff --check` = 退出码 `0` | `EXECUTED_PASS` |
| S2-11 | 交叉阅读同队 diff（见下「代码评审记录」） | 未发现确定性缺陷；列 5 条 pilot 风险（R1～R5），每条带 文件:行号 + 最小复现 | `EXECUTED_PASS`（评审完成） |
| S2-12 | Phase B 复跑（PHASEB-01 已 PASS）+ S2-07b 的两个 Phase B 用例 | 见 §3.5 与 S2-07b；两路收据/扁平工具/DS 投影/通知回流/两路记账均在 | `EXECUTED_PASS`（OFFLINE 级） |


**阶段 2 续（R4 修复后复跑，2026-11-12 15:55～15:58 +08:00）**：`responses-streaming` 落地 `response.incomplete` 的 `output[]` 身份恢复后，本代理重跑受影响项：
`npm run check` exit 0；`npm test` → `Isolated suites: 29/29 passed`（26 个 offline 套件 + 3 旧套件，套件数不变）；`codex-responses-stream` 36 → **38/38**；lifecycle 默认门禁仍 16 tests / 6 pass / **10 skip**；gated `MG_CODEX_V2=1` → **16/16**（129s）。其余 S2 行未受影响。
### 9.1 代码评审记录（S2-11，只报事实）

审阅范围：`src/index.js` 的 `proxyCodexResponses`/`relayCodexStream`/`codexUpstreamHeaders`/`videoJsonHeaders`；`src/codex-responses.js` 的 `buildToolPlan`/`projectOrderedHistory`/`restoreToolItem`；`src/codex-responses-stream.js` 的终态/背压/身份保持。

**核对通过的点（附行号）**

| 契约点 | 实现位置 | 复核方式 |
| --- | --- | --- |
| 单上游、无 fallback、不跨上游迁移 | `src/index.js:954-963`（`pid = route.provider`）、`1005-1011`（失败只回可读归因，不换上游） | 读码 + Phase B 四请求路由固定 |
| 凭据隔离（客户端 auth 不转发） | `src/index.js:726-732`：上游头是**新建**固定集合 + `provider.extraHeaders` + `provider.apiKey`，从不复制入站头；`901-906` 再剥离逐跳头 | 读码；Phase B 两路 mock 收到的是各自 provider key，`accountId/cookie/subagent` 全 null |
| 客户端元数据剥离 | `src/index.js:941-943`（`client_metadata`/`prompt_cache_key` 删除 + lossy 记录） | Phase B 两路 `hasClientMetadata=false`、`hasPromptCacheKey=false` |
| usage 只记一次 | `src/index.js:1019-1027`（`usageSeen` 守卫）+ `910-924`；非流式 `994` | 读码；Phase B 39+13=52 tokens 与 4 请求一致 |
| 6 个 namespace 工具恢复身份、仅 3 个消息工具带 marker | `src/codex-responses.js:51`（`COLLABORATION_TOOLS` 只有 spawn/send/followup）、`321-332`、`599-608` | 微跑 C1：declared 7 项、`messagePlaintext` 只有 3 个 true；C4 补 `[]`、C5 `wait_agent` 不携带 |
| added 只恢复身份、done 才补 marker | `src/codex-responses-stream.js:310-315` | 微跑 C3：`in_progress` 项只有 namespace、无 marker |
| 终态后忽略后续帧 / 缺终态即失败 | `src/codex-responses-stream.js:294-298`、`351-357`、`359-373` | 读码 + S2-05 的 36 例 |
| 背压 30s / 8MiB | `src/codex-responses-stream.js:190-236` | 读码 + S2-05 |
| 扁平别名冲突确定性 | `src/codex-responses.js:322-326` | 微跑 C8：冲突时 `collaboration__spawn_agent` + 普通 `spawn_agent` 并存 |

**pilot 风险（未判定为缺陷；契约当前写法如此，需 Lead 决定是否收紧/放宽）**

| 编号 | 位置 | 现象 | 最小复现 | 影响 |
| --- | --- | --- | --- | --- |
| R1 | `src/codex-responses.js:590-594`（`TOOL_ITEM_KEYS` 白名单在 `60-63`） | 协作工具的完成项若携带**任何白名单外字段**（例如将来上游加 `caller`/`reasoning_content`），直接 `rejected: opaque_function_args` → 客户端收到失败帧/502 | `cat /tmp/s2-micro.mjs` 的 C2：`{type:'function_call',name:'spawn_agent',arguments:'{…}',unknown_future_field:1}` → `{"code":"opaque_function_args","message":"工具项含未知字段: unknown_future_field"}` | 真实 GPT 若变更 item 形状，试点会**硬失败**（不是降级）。今天 0.167.0 实测没有多余字段，但换版本必测 |
| R2 | `src/codex-responses.js:395-400` | `agent_message` 的 content part 若含额外字段（如 `annotations: []`）→ `rejected: opaque_agent_message`（400，且不出网） | 微跑 C6：`{type:'agent_message',author:'/root',recipient:'/root/w',content:[{type:'input_text',text:'hello',annotations:[]}]}` → `{"code":"opaque_agent_message",…}` | 反向证据：Phase B 真实 Codex 报文在同一投影下成功（日志 `agent_message_projected`）→ 0.167.0 不触发；**换客户端版本必须重测** |
| R3 | `src/codex-responses.js:438-461` | 普通工具项若带 `encrypted_function_args: []`，按 §5.1「原样」策略**保留该字段**并转发给上游 | 微跑 C7：`{type:'function_call',name:'exec_command',encrypted_function_args:[]}` → 原样输出含该字段 | 0.167.0 只给 3 个协作工具加 marker，实际不触发；若第三方客户端误加，是发给 DS 的未知字段（DS 可能忽略或 400） |
| R4 | `src/codex-responses-stream.js:284-292` | ~~只有 `response.completed` 会走 `restoreResponseJson`~~ → **已修复**：`response.completed` 与 `response.incomplete` 都恢复 `output[]` 工具身份（incomplete 不补 `output_text`、不改 status/incomplete_details） | 复跑 S2-05：38/38（新增 2 例覆盖该组合） | 已闭环 |
| R5 | `src/index.js:1041-1043` | 流式终态只有 `response.failed` 计错误，`response.incomplete` 仍 `markOk` | 让上游回 incomplete 后看 stats/熔断状态 | **按 Lead 决策不立卡**：口径已写入契约 §8（failed → 计错误 + markFail；incomplete → markOk + warn 日志；usage 仍一次），属有意选择，见 §9.4 B-1 |

### 9.2 可复现失败清单（阶段 2）

- **产品代码：0 个确定性失败。** 上述 S2 行全绿；R1/R2/R5 已给出可复现命令，但它们是契约规定的显式拒绝或记账语义，未判定为缺陷。
- **F-1（执行侧，非产品）**：我第一次跑 `MG_CODEX_V2=1 node --test …` 时被我自己的 120s 程序超时打断，日志出现 `✖ scripts/test/offline/codex-v2-lifecycle.test.mjs … 'Promise resolution is still pending but the event loop has already resolved'`（当时 `tests 14 / pass 13`，无 fail 计数）。这是**执行方超时造成的截断**，不是套件失败：换足额超时重跑 `122s` 全过 16/16。命令与首行输出均保留在 `/tmp/s2-lifecycle-gated.log` 的历史里，重跑覆盖后以 S2-07b 为准。
- **F-2（口径）**：默认门禁 `skipped 10` 不得计入通过；本收据把它单列（S2-07a），gated 数字只引用 S2-07b/S2-07c。
- **F-3（口径）**：Phase B 首跑（PHASEB-00）属 client 竞态，保留为 PARTIAL 对照，**不删除、不追认为通过**。
- **F-4（执行侧自修，非产品缺陷，如实记录）**：Lead 更新 CHANGELOG 时整文件写入导致读回截断，尾部 73 行（含 `## [Unreleased]`、`## [0.2.3]`）丢失，`check-metadata` 因此报 `FAIL (1/18)`（「未找到 ## [x.y.z]」）。Lead 以 `git show HEAD:CHANGELOG.md` 为基准重建（新 MG-017 段落 + 原 377 行恢复）。本收据定稿时独立复核：`Metadata: PASS (21 checks)`、`git diff --numstat CHANGELOG.md` = `22 0`（纯新增）、`git diff --check` = `0`。**执行侧事故与自修，不算产品缺陷，也不隐瞒。**

### 9.3 剩余阻断清单（阶段 2 收口时）

| 阻断项 | 影响 | 需要谁 |
| --- | --- | --- |
| 真实供应商授权 A1～A7（认证模式、模型与档位、费用上限、数据范围、隔离 Desktop 入口、隔离运行面、凭据放置） | CL-00～CL-14、DS-00～DS-09 全部真实用例仍是 `BLOCKED_PENDING_AUTHORIZATION`；两张记分卡都不能登记 | 用户 |
| `CARD-ChatGPT`（工作区通过） | 需先实现官方头 allowlist/固定域名转发（契约 §3.6 首版不实现），再做认证刷新/吊销/归属验收 | 用户授权 + Lead 排期 |
| Desktop GUI 全部用例 | 未执行（本轮只做 DS-00/DS-10 级别的组件断言） | 用户（隔离 Desktop 环境授权） |
| child UUID 未物化 | 矩阵 §6 要求 child SID；离线阶段只能给 task path `/root/worker` + 原生 `agent_message` 的 Task name/Sender。gated 套件在冷恢复断言里证明「同 child thread 复用」，但未把 UUID 落到收据 | 集成后可用 app-server `thread/read` 或 rollout 补 |
| 角色 TOML 加载路径（CMP-10） | 未验证；gated 套件与 Phase B 都是靠 `spawn_agent` 参数里的 `model` 锁定子模型，没有走 `CODEX_HOME/agents/*.toml` | 需一次真实带角色文件的 spawn |
| Windows/macOS、Node 18/20 | 未执行（本机仅 Linux + v24.22.2） | 环境授权 |

### 9.4 已知边界（有意选择 / 已接受项，不是待修缺陷）

| 编号 | 边界 | 依据 / 现状 | 处置 |
| --- | --- | --- | --- |
| B-1 | **终态记账口径**：流式 `response.failed` → 计错误 + `markFail`；`response.incomplete` → `markOk` + warn 日志；usage 在任一终态只记一次 | 契约 §8（Lead 已写入）；理由：上游确实返回了终态，只是内容未完成 | 有意选择，不立卡。§9.1 R5 行保留为「为什么看起来偏松」的说明 |
| B-2 | **普通工具携带 `encrypted_function_args` 时原样透传**（R3） | 网关只对**本轮确实以明文声明的 3 个协作工具**做身份推断；普通工具不推断、不改字段（契约 §5.1「不补；工具身份不变」） | 保持现状。理由：Codex 实际回放不会给普通工具该字段；第三方客户端误加属其自身载荷问题 |
| B-3 | **未知字段一律显式失败**（R1/R2） | 契约 §5「拒绝优先于猜测」、§5.1 marker 矩阵 | 保持严格拒绝；已固化「换客户端/上游版本必测并重签」（矩阵 §7 第 7 条） |
| B-4 | **child UUID 未物化** | 现有证据：spawn 工具输出的 task path `/root/worker` + 原生 `agent_message` 的 `Task name: /root` / `Sender: /root/worker`；gated 冷恢复用例证明「同一 child thread 复用」，但 UUID 未落盘 | 接受为**下一阶段补证项**：用 app-server `thread/read` 或 rollout 复核补 UUID，届时按 §6 最少集重签 |
| B-5 | **R4 已闭环**：`response.incomplete` 的 `output[]` 已恢复工具身份 | `src/codex-responses-stream.js:284-292`；S2-05 由 36 → **38** 例全过；S2-07 gated 重跑 16/16（129s） | 已复跑并更新数字（本轮即修复后快照） |

### 9.5 定稿冻结快照（2026-11-12 16:10～16:14 +08:00）

**代码/测试冻结指纹（定稿前复核，之后未再改动）**

| 文件 | mtime | sha256 |
| --- | --- | --- |
| `src/codex-responses.js` | 2026-11-12T14:03:53 | `17d8bdb46bbb935c9ae64a1590202fda291aa1c09e2c91a7f572c0a80a79dd20` |
| `src/codex-responses-stream.js`（含 R4 最后一次改动） | 2026-11-12T15:53:27 | `c612dcae370af8858e6f9be5af8f281db1e59d80f306159298531d6f666cbe73` |
| `src/index.js` | — | `55d66f3b3391a3d611ae745ef805d7146bb82bb9d91a6e431fbcc08bb3e3d572` |
| `src/router.js` | — | `c48d41d35cb7c0b45074cd192c5483f70b9c2d91c6a9bcea3bef1570d76f7f19` |
| `scripts/test/offline/codex-responses.test.mjs` | 2026-11-12T14:05:35 | `f596703818f7fe0895231310e0745a528220c661fabf9375fad2b4f86e4ae684` |
| `scripts/test/offline/codex-responses-stream.test.mjs`（R4 +2 用例） | 2026-11-12T15:54:07 | `c14518c96924a711f88397a0ea1e9e9d8b9532ccc7215b55fffc8d4242bf7661` |
| `scripts/test/offline/codex-routing.test.mjs` | 2026-11-12T13:52:26 | `2ee755e3e9102998300d695a0d4f1651f03d474d307acc731ca1f9f69602cdbe` |
| `scripts/test/offline/codex-v2-lifecycle.test.mjs` | 2026-11-12T15:24:43 | `a6a5075c5dc817b6604c7eed82c29c3dcc1c953b3d9314f5cd7b800f945a8bc6` |

**冻结代码上的最终门禁（本代理实跑；16:11:00 起，16:13:38 止）**

| 命令 | 实际输出 |
| --- | --- |
| `npm run check` | exit `0`（16 个 `node --check` 目标） |
| `npm test` | exit `0`；`Isolated suites: 29/29 passed` |
| 三个 responses 套件 | `tests 27 / pass 27 / fail 0` |
| `codex-responses.test.mjs` | `tests 44 / pass 44 / fail 0` |
| `codex-responses-stream.test.mjs` | `tests 38 / pass 38 / fail 0 / skipped 0` |
| `codex-routing.test.mjs` | `tests 8 / pass 8 / fail 0` |
| lifecycle 默认门禁 | `tests 16 / pass 6 / fail 0 / skipped 10`（skip 不计通过） |
| `MG_CODEX_V2=1 … lifecycle` | exit `0`，`126s`，`tests 16 / pass 16 / fail 0 / skipped 0` |
| `node scripts/check-metadata.mjs` | `Metadata: PASS (21 checks)`（F-4 复核后状态） |
| `npm run docs:check` | `Documentation paths: PASS` |
| `git diff --check` | 退出码 `0` |
| `git diff --numstat CHANGELOG.md` | `22 0`（纯新增，F-4 已恢复） |

与 Lead 的最终门禁逐项一致（同命令同结果）；`126s` 与 Lead 的 `124s` 属机器抖动，均为 16/16。
## 10. 签署

| 角色 | 姓名/代理 | 时间 | 结论 |
| --- | --- | --- | --- |
| 执行 | `client-acceptance` | 2026-11-12 16:14 +08:00 | 离线性验收完成（OFFLINE + COMPONENT 级）；真实用例 `BLOCKED_PENDING_AUTHORIZATION`；不含真实上游 |
| 复核 | 待 Lead | — | — |