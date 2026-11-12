# Codex 原生 Multi-Agent V2 客户端验收矩阵（CLI × Desktop）｜MG-017-T5

状态：**离线阶段矩阵与收据已定稿（2026-11-12 16:14）；离线性验收完成（OFFLINE + COMPONENT 级）；真实验收 NOT_EXECUTED，授权项 BLOCKED_PENDING_AUTHORIZATION。**
真实验收的通过/失败由本文件的判据与[收据](receipts/2026-11-12-codex-v2-offline-stage.md)共同判定，不由口头结论判定。

- 规格来源：[跨供应商契约 v0](../contracts/codex-multi-agent-v2.md) §9（生命周期验收边界）、§10（验收与证据边界）；审计文档 `/home/xiaomengxizi/.codex/visualizations/2026/11/12/01a1ce0e-afae-77c3-90fc-cca8854fad99/modelgate-codex-multi-agent-v2.md` 的「真实端到端验收」与「通过标准」两节。
- 写集：本文件与 `docs/roadmap/receipts/`。不改源码、不改他人文档。
- 失效条件：客户端版本（CLI `0.167.0` / Desktop `0.167.0-alpha.3.2`）或网关 `/v1/responses` 试点路由任一变化，本矩阵必须重签；版本升级后旧收据只能作历史。

## 0. 口径（先读）

| 层级 | 含义 | 能否算「真实验收」 |
| --- | --- | --- |
| 组件验收 | 裸 CLI 或裸 bundled app-server 在隔离配置下可用：目录加载、feature、schema、method 形状 | **不能**，只算组件 |
| 离线生命周期 | 两个 mock 上游 + 原版 Codex 创建线程（`codex-v2-lifecycle.test.mjs`） | **不能**，只算离线 |
| 真实验收 | 真实 GPT 上游 + 真实 DeepSeek 上游 + 原版客户端（CLI 与 Desktop 各自） | 只能由这等证据主张 |

状态枚举（收据里只允许这五种，禁止自造）：

| 状态 | 含义 |
| --- | --- |
| `NOT_EXECUTED` | 本轮没跑 |
| `BLOCKED_PENDING_AUTHORIZATION` | 缺前置授权（§1），跑了也无效 |
| `EXECUTED_PASS` | 已跑且满足该行全部通过判据 |
| `EXECUTED_FAIL` | 已跑且不满足判据（必须写归因） |
| `EXECUTED_PARTIAL` | 已跑但有字段缺失或只覆盖部分组合（必须列出缺哪一项） |

**模型自报身份不算证据。** 唯一有效证据是客户端事件 ID、原生线程/工具身份与两路上游的请求/响应收据（§6）。

## 1. 前置授权清单（缺一不可，逐项待用户勾选）

未填写 = 该项下所有用例一律记 `BLOCKED_PENDING_AUTHORIZATION`，**不得**用 mock、离线套件或 HTTP 200 顶替，也不得写成「部分通过」。

| 编号 | 授权项 | 用户填写（留空） | 未填写时的状态 | 封锁的用例 |
| --- | --- | --- | --- | --- |
| A1 | 认证模式：**OpenAI Platform API Key** 与/或 **ChatGPT 登录 + 工作区**（两者分开记分，可只授权其一） | ______________ | `BLOCKED_PENDING_AUTHORIZATION` | CL-*、DS-* 全部 |
| A2 | 具体模型与档位：GPT 服务名 + reasoning effort、DeepSeek 服务名 + reasoning effort（含备用名） | GPT: ______ / effort: ______<br>DS: ______ / effort: ______ | 同上 | CL-00～CL-14、DS-03～DS-09 |
| A3 | 费用上限：总额（USD 或 token 数）、单请求上限、失败即停阈值、是否允许重复跑 | ______________ | 同上 | 全部真实用例 |
| A4 | 允许发送的数据范围：合成工作区目录 allowlist、禁止发送的路径（家目录/凭据/仓库私有内容）、日志脱敏要求 | ______________ | 同上 | 全部真实用例 |
| A5 | 隔离 Desktop 环境：允许使用的测试配置入口（临时 `CODEX_HOME` / 独立 profile / 可丢弃 Worktree）、是否允许在该入口写入、是否允许重启 Desktop | ______________ | 同上 | DS-* 全部 |
| A6 | 隔离运行面：`MG_CONFIG_DIR` 与隔离 `CODEX_HOME` 落点（不得在 `/tmp`，见 §2.2）、动态端口范围、是否允许本机回环监听 | ______________ | 同上 | 全部 |
| A7 | 上游凭据放置方式：由网关持有点对点凭据（`keys.local.json` 或环境变量），确认不进入脚本/Git/日志/收据 | ______________ | 同上 | 全部 |

勾选方式：把 §1 表复制到本次[收据](receipts/codex-v2-receipt-template.md)的「授权」块，逐项填 `GRANTED` 或 `NOT_GRANTED` + 日期；**只填 `GRANTED` 的行才允许出现 EXECUTED_* 状态。**

## 2. 环境固定（本轮实测值 + 复核命令）

### 2.1 客户端与运行时

| 项 | 实测值（2026-11-12 本机） | 复核命令 |
| --- | --- | --- |
| Node | `v24.22.2` | `node -v` |
| CLI 版本 | `codex-cli 0.167.0` | `$CLI --version` |
| CLI 入口 | `/home/xiaomengxizi/ai/harness/codex/cli/bin/codex`（wrapper → `cli/versions/current/vendor/x86_64-unknown-linux-musl/bin/codex`，readlink 落到 `versions/0.167.0/…`） | `ls -l /home/xiaomengxizi/ai/harness/codex/cli/bin/codex; readlink -f …` |
| CLI 二进制指纹 | `sha256:cdcb45aaa01d0f14e298985e09465aebccd47f64ecd298aea44814af7b62bbda` | `sha256sum /home/xiaomengxizi/ai/harness/codex/cli/versions/current/vendor/x86_64-unknown-linux-musl/bin/codex` |
| Desktop 捆绑版本 | `codex-cli 0.167.0-alpha.3.2` | `/usr/lib/chatgpt/resources/codex --version` |
| Desktop 捆绑指纹 | `sha256:c8242fc9e1bac7c6d661a228cecfaf50e6db74da219e4a9ca8912827e11607f0` | `sha256sum /usr/lib/chatgpt/resources/codex` |
| 插件 app-server 指纹 | 同上 `c8242fc9…`（与捆绑二进制同哈希） | `sha256sum ~/.codex/plugins/.plugin-appserver/codex` |
| 实际运行的 bundled app-server | `/usr/lib/chatgpt/resources/codex -c features.code_mode_host=true app-server --analytics-default-enabled -c plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true`（PID 每轮变化） | `pgrep -a -f /usr/lib/chatgpt/resources/codex` |
| app-server 自报版本 | `{"appServerVersion":"0.167.0-alpha.3.2",…}` | `/usr/lib/chatgpt/resources/codex app-server --print-startup-config` |
| 网关代码基线 | `git rev-parse HEAD`（收据记录实际 HEAD 与 `git status --short`） | 同左 |

> Desktop 侧证据必须同时记录 **GUI 进程（`/usr/lib/chatgpt/ChatGPT`）** 与 **它实际拉起的 bundled app-server argv**；只记录包路径不算「实际运行的 app-server」。

### 2.2 隔离运行面（唯一允许的写入位置）

- `CODEX_HOME=$ISO/codex`（临时 `config.toml`、catalog、角色 TOML、rollout 全部落这里）。
- **不要用 `/tmp` 作 `CODEX_HOME`**：实测会打印 `WARNING: proceeding, even though we could not create PATH aliases: Refusing to create helper binaries under temporary dir "/tmp"`；改用 `$ISO`（例如 `$HOME/.cache/mg-codex-acceptance/<run-id>`），警告消失且状态可控。
- `MG_CONFIG_DIR=$ISO/mg`（keys/local/stats 隔离）、`MG_CONFIG=$ISO/mg/gateway.json`（显式主配置，避免命中家目录配置）。
- 端口：配置里 `server.port` 固定到**当轮空闲回环端口**（禁止 8787），生成方式 `node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'`；每轮记录端口号。
- 日志：隔离实例的 stdout/stderr 重定向到 `$ISO/logs/gateway.log`（收据只引摘要，不贴请求正文）。

```bash
ISO=$HOME/.cache/mg-codex-acceptance/$(date +%Y%m%d-%H%M%S)
mkdir -p "$ISO"/{codex,codex/agents,mg,logs,schema,ws}
export ISO
```

### 2.3 网关侧：单 ModelGate provider + 两个试点 alias

按契约 §3 冻结形状：两个 provider（`openai-official`、`deepseek-official`，均 `api:"responses"`）、两个模型 alias（`codex-gpt`→GPT 服务名、`codex-deepseek`→DS 服务名）、`defaults.codex.strictModelRouting=true`、试点模型**禁止 `fallbacks`**。真实凭据只放 `$MG_CONFIG_DIR/keys.local.json` 或环境变量；`gateway.json` 内不得出现 Key。

| 断言 | 命令 | 期望 |
| --- | --- | --- |
| 试点路由生效 | `curl -s $BASE/healthz` + `curl -s -H 'Authorization: Bearer $CLIENT' $BASE/v1/models` | 两个 alias 可见；`/healthz`=ok |
| 未知名不回落 | `curl -s -o /dev/null -w '%{http_code}' -H … -d '{"model":"no-such-model","input":"x"}' $BASE/v1/responses` | `400` `unknown_model`，上游零请求（日志无该请求） |
| 单上游 | 每个用例结束后核对日志：一次响应只出现一个 provider 的转发记录 | 不出现跨上游写重试/迁移 |

### 2.4 Codex 侧：`$CODEX_HOME/config.toml`（实测有效形状）

下列键组合已用**捆绑 app-server 的 strict 校验**在本机离线验证通过（`env_key` 是 0.167.0 认的 provider 凭据键；`bearer_token_env_var` 会报 `unknown configuration field`）：

```toml
# $CODEX_HOME/config.toml
model = "codex-gpt"
model_provider = "modelgate"
model_catalog_json = "$ISO/codex/catalog.json"

[features]
multi_agent_v2 = true

[model_providers.modelgate]
name = "ModelGate"
base_url = "http://127.0.0.1:<动态端口>/v1"
wire_api = "responses"
env_key = "MG_CODEX_KEY"          # 网关客户端鉴权 Key 的变量名，值不进文件
```

**两条实测陷阱（Phase B 证据，见离线收据 §3.5）**：

- 若加 `--ignore-user-config`（隔离测试常用），Codex **完全不读** `CODEX_HOME/config.toml`，必须用 `-c model=… -c model_provider=… -c 'model_providers.mg={name="ModelGate",base_url="…",env_key="…",wire_api="responses"}' -c model_catalog_json=… -c features.multi_agent_v2=true` 显式传整块；漏传 `model_providers` 会直接找不到 provider。
- `prefer_websockets` **不是合法 `-c` 键**：写了只会得到 `Codex is ignoring 1 unrecognized configuration setting … prefer_websockets is ignored`（本机 0.167.0 实测），不要写进命令。

离线校验命令（不需要上游、不联网）：

```bash
CODEX_HOME=$ISO/codex /usr/lib/chatgpt/resources/codex app-server --strict-config --print-startup-config
# 期望：{"appServerVersion":"0.167.0-alpha.3.2","configRequirements":{…}}，无 configLoad 错误
```

### 2.5 `model_catalog_json`（契约 §6 形状）

- 形状以契约 §6 为准；**递归门槛**：孩子线程模型自身也必须带 `multi_agent_version:"v2"`，只开全局 feature 不够。
- 离线断言（已实测通过）：`codex debug models` 渲染出的 catalog 含 `"multi_agent_version":"v2"`、`context_window`、`supported_reasoning_levels`。

```bash
CODEX_HOME=$ISO/codex $CLI debug models -c model_catalog_json="$ISO/codex/catalog.json" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const m=JSON.parse(s).models;
  console.log(m.map(x=>[x.slug,x.multi_agent_version,x.context_window].join(" ")).join("\n"));
})'
# 期望：codex-gpt v2 200000 / codex-deepseek v2 128000
```

> 实测差异：形状里写 `shell_type:"default"`，渲染输出会归一成 `"unified_exec"`；断言只比较 `slug`/`multi_agent_version`/`context_window`，不要逐字节比 catalog。

### 2.6 Feature 开关（本机默认值 + 开启方式）

| Feature | 默认（隔离 `CODEX_HOME`，实测） | 本轮取用 |
| --- | --- | --- |
| `multi_agent` | `stable` / **true** | 保持默认 |
| `multi_agent_v2` | `stable` / **false** | 显式开启 |
| `multi_agent_v2_dynamic_tools` | `under development` / false | 首版**不开**；若测，单列一行证据 |
| `code_mode` / `code_mode_only` | false / false | 保持默认 |
| `wake_on_agent_messages` | `under development` / false | 保持默认（决定 `send_message` 是否唤醒闲置目标，见 CL-02） |
| `agent_message_board` | `under development` / false | 保持默认 |

开启与复核：

```bash
$CLI --enable multi_agent_v2 …            # 等价 -c features.multi_agent_v2=true
CODEX_HOME=$ISO/codex $CLI features list -c features.multi_agent_v2=true | grep -E '^(multi_agent|multi_agent_v2) '
# 期望：multi_agent stable true / multi_agent_v2 stable true
```

### 2.7 角色 TOML 锁模型（provider 与权限继承自父线程）

**结论先行**：角色 TOML 决定子代理的模型名与档位；provider 由父线程继承，角色文件里写另一个 provider 不会改路由。所以「GPT 根 + DeepSeek 子」只能靠**同一个 ModelGate provider + 两个 alias**，不能靠角色里换 provider。

> **实测补充（2026-11-12，Phase B 与 gated lifecycle 套件）**：0.167.0 里子模型**更常用的落地方式**是 `spawn_agent` 参数自带 `model`（证据：mock 收到的 `function_call` 为 `{"task_name":"worker","model":"codex-deepseek","fork_turns":"none","message":…}`，子线程随后按 `codex-deepseek` 路由）。角色文件（`CODEX_HOME/agents/*.toml`）是另一条路径，**本轮未验证**（懒加载，见下）；两条路径都必须靠同一 ModelGate provider + alias，不能靠角色换 provider。

```toml
# $CODEX_HOME/agents/deepseek-worker.toml
name = "deepseek-worker"
description = "DeepSeek 子代理（ModelGate alias 锁定）"
model = "codex-deepseek"
model_reasoning_effort = "high"
developer_instructions = "只做被指派的检查与只读工具调用，结果用一句话回传。"
```

- 键证据：0.167.0 二进制含 `agent role file at …`、`must define developer_instructions`、`developer_instructions cannot be blank`（缺失即报错）。
- **未离线验证**：角色文件在 `spawn_agent` 时才加载（`app-server --strict-config --print-startup-config` 与 `features list` 都不读它，本轮实测坏 TOML 也不报错）。首次真实 spawn 时用实际报错文本确认目录与键名，把结果写进收据「待确认项」，确认前该行记 `EXECUTED_PARTIAL`。
- 角色里出现 `model` 不在 catalog 或档位不在 `supported_reasoning_levels` → 原生拒绝；这条本身是 CL-07 之外的一项负向断言。

### 2.8 目录指纹（每份收据必填）

```bash
# 单个文件
sha256sum "$ISO/mg/gateway.json" "$ISO/codex/config.toml" "$ISO/codex/catalog.json" "$ISO/codex/agents/"*.toml
# 目录指纹 = 对上面清单再取一次 sha256（清单排序固定，结果可复算）
find "$ISO" -maxdepth 3 -type f \( -name '*.json' -o -name '*.toml' \) -print0 \
  | sort -z | xargs -0 sha256sum > "$ISO/manifest.sha256"
sha256sum "$ISO/manifest.sha256"      # ← 记这个值
```

指纹必须与「版本 + 端口 + 认证模式」同段落记录；缺指纹的收据不受理。

## 3. CLI 用例矩阵

运行环境一律：`CODEX_HOME=$ISO/codex`、`$CLI=/home/xiaomengxizi/ai/harness/codex/cli/bin/codex`、合成工作区 `$WS=$ISO/ws`（`--skip-git-repo-check` 或不初始化 git）。

### 3.1 命令形状（下面矩阵用 S1～S5 引用）

| 代号 | 形状 |
| --- | --- |
| S1 | 新根会话、JSONL 事件：`$CLI exec --json -C $WS -m codex-gpt --enable multi_agent_v2 "<PROMPT>"` |
| S2 | 续同一会话：`$CLI exec resume --json <ROOT_SID> "<PROMPT>"` |
| S3 | 冷恢复（同 S2，但只在新进程里执行，必要时网关已重启） |
| S4 | 交互式 CLI（人工观察通知/审批提示）：`$CLI -m codex-gpt --enable multi_agent_v2` |
| S5 | 网关收据：`$ISO/logs/gateway.log` 中该请求的 alias/provider/upstreamModel/上游响应 id/SSE 终态 |

事件字段（`--json` 输出实测存在）：`thread.started`（thread id）、`turn.started`/`turn.completed`（turn id、usage）、`item.started`/`item.completed`（工具 `call_id`、`namespace`/`name`、`encrypted_function_args`）。

### 3.2 矩阵

| ID | 目的 | 命令形状 | 通过判据 | 证据字段 | 失败归因（client/gateway/upstream/authz） |
| --- | --- | --- | --- | --- | --- |
| CL-00 | 单路对照基线：两上游各自用**直连**方式跑一个普通回合（不经网关） | S1，`model_provider` 临时指向厂商直连（或厂商官方 CLI 路径） | 两路各自 `turn.completed` 且有真实工具往返；记录两路 SSE 形状差异 | 两路响应 ID、SSE 事件序列摘要、工具 call ID | upstream/authz |
| CL-01 | **基础双上游**：GPT 根 → 原生 `spawn_agent` 派 DeepSeek 子，非 `none` 上下文 | S1 + 任务文本：根把 nonce **A** 交给子，子用只读工具读 `$WS/token-b.txt` 得 **B**，回传 A/B | ①同一条原生会话里有 GPT 根 turn 与 DS 子 turn；②两路上游各自有收据且模型名不同；③root/child SID 与 parent/path 对齐；④工具 call ID 在两边一致；⑤根能核对 A 与 B（B 不在根 prompt 内） | root SID、child SID、task path、两路 upstream response id、call ID、nonce A/B、SSE 终态 | 明文工具声明失败→gateway；子线程未生成→client(config/feature)；任务未消费→upstream；401→authz |
| CL-02 | `send_message`：目标活跃时投递到正确线程；闲置目标不意外启动 | 子线程执行可控延时工具保持活跃期间，根发 **C**（S1/S2） | C 只出现在目标线程 inbox；`wake_on_agent_messages=false` 时闲置目标**不**产生新 turn（若目标闲置产生新 turn → 归因 client feature 语义，不是网关） | 目标 thread id、消息到达事件、目标是否新增 turn | client（原生队列语义） |
| CL-03 | `followup_task`：对**原** thread 追加新 turn 且保留历史、独立通知 | 根对既有 child 发 **D** | child 仍是同一 SID；新 turn id ≠ 旧 turn id；历史未被截断（child 能复述 A/B）；完成通知方向正确 | child SID（前后一致）、旧/新 turn id、通知事件 | gateway（历史投影错）→ 内容丢失；client → 未恢复目标 |
| CL-04 | `wait_agent` 三种收敛：消息唤醒 / 超时 / 取消 | ①子先睡后发；②子不做任何输入；③等待中 `Ctrl-C`（S4）或等 root turn 取消 | ①被消息唤醒；②超时返回且原生状态明确；③取消后 root 停、无伪造成功、无重复投递 | wait 事件、超时值、取消事件、终态 | client（原生等待）；若有网关侧重复投递→gateway |
| CL-05 | 递归 DS→DS：`/root/worker/grandchild` | S1 任务让 child 再 spawn 一个 DeepSeek 孙代理 | 孙代理真实存在，三代 SID/path 连续；孙的请求打到 DS 上游；结果沿原生链回流 | root/child/grandchild SID、三代 path、第三路上游收据 | gateway（V2 工具不暴露→无递归工具）；config（catalog 缺 v2） |
| CL-06 | 递归 DS→GPT | 同上，但孙代理角色锁 `codex-gpt` | 孙代理请求打到 GPT 上游；root/child/grandchild 都在同一会话树 | 三代 ID、孙代理的 GPT 收据（模型名与服务名） | config（角色模型不在 catalog）；gateway（错误路由） |
| CL-07 | 并发上限：原生拒绝超出配额的 spawn | 一次性 spawn 多于上限的子代理 | 超限请求被**原生**拒绝（不是网关 429/超时），已成功的子代理不受影响 | 拒绝事件的错误文本、成功/失败 spawn 计数、上限值配置 | client（原生上限）；若网关 429→gateway |
| CL-08 | 审批拒绝 | 让子代理执行写操作，交互模式拒绝（S4） | 原生审批提示出现且被拒绝；无副作用；root 收到明确的拒绝/失败回传 | 审批事件、拒绝结果、文件系统未变更证明 | client |
| CL-09 | 审批批准 | 同上，批准一次最小写操作 | 工具真实执行且副作用可核对（`sha256sum` 前后对比） | 审批事件、执行结果、文件哈希前后 | client |
| CL-10 | 取消：root turn 中途取消 | S4 中 `Ctrl-C`（或等预算用尽） | root 停止，SSE 记录取消终态；**已产生副作用的工具不被网关重复投递**；child 状态由原生决定并在收据写明 | 取消事件、网关侧 cancel 记账、工具执行次数 | gateway（重复投递/伪造完成） |
| CL-11 | SSE 断流：上游在终态前断开 | 用可注入故障的本地代理挡在上游前（不改产物、不联网攻击），或按 A5/A6 授权的故障注入手段 | 客户端收到明确失败（`STREAM_INTERRUPTED` 或等价终态），**无自动重发**；已送出的工具调用不被重放 | 终端事件、错误码、重发计数=0 | gateway |
| CL-12 | SSE 首字节/终态超时 | 同上，注入慢头/慢体 | 触发网关预算（504 `request_timeout` 或流式错误事件），客户端状态明确 | 耗时、错误码、上游是否被销毁 | gateway |
| CL-13 | 冷恢复：原 root SID + 既有 child ID + 历史复用 | S3 追加一个任务，要求引用既有 child 的既有产出 | 同 root SID；既有 child ID 不变；child 能复述**历史**内容（证明历史重放而非新线程）；不要求模型恢复未提交状态 | 恢复前后 root SID/child ID（成对记录）、历史命中证明 | gateway（历史投影丢项）→ 复述失败；client（恢复失败） |
| CL-14 | 重启网关再恢复 | 停网关 → 起同配置同端口 → S3 追加任务 | 同 CL-13 判据；并核对重启前后 `configVersion`/目录指纹一致（配置未漂移） | 重启前后指纹、两次 SID、重启时间点 | gateway（状态未持久化）/config（配置漂移） |

## 4. Desktop 用例矩阵

> **硬边界：裸 bundled app-server 跑通 `thread/start`… 只算组件验收（DS-00/DS-10），不能替代 GUI 用例。** GUI 用例必须由人在实际窗口里完成，并记录可核对的线程/工具身份。

| ID | 目的 | 操作/命令 | 通过判据 | 证据字段 |
| --- | --- | --- | --- | --- |
| DS-00 | 版本与实际运行面（组件） | `/usr/lib/chatgpt/resources/codex --version`；`app-server --print-startup-config`；`pgrep -a -f /usr/lib/chatgpt/resources/codex` | 版本 `0.167.0-alpha.3.2`；被记录的 app-server argv 与 GUI 进程同源；二进制 sha256 与 §2.1 一致 | 版本、argv、PID、sha256、时间 |
| DS-01 | 配置层：GUI 使用**隔离**配置入口，不污染日常 profile | 按 A5 授权的方式注入 `CODEX_HOME`/profile；GUI 内确认模型列表来自 `model_catalog_json` | GUI 模型列表出现 `codex-gpt`/`codex-deepseek`；日常 `~/.codex` 未被写入（前后 `config.toml` 指纹不变） | GUI 侧模型列表、日常配置指纹前后 |
| DS-02 | GUI 内新建会话并**实际选中** provider/model | 新建 Local 会话（或可丢弃 Worktree），选 ModelGate provider + `codex-gpt` | 会话头显示的 provider/model 与实际请求一致（S5 收据佐证） | thread id、所选 model、首个上游收据 |
| DS-03 | 基础双上游（GUI 版 CL-01） | GUI 输入任务：根派 DeepSeek 子读 token B、回传 A/B | 同 CL-01 全部判据；UI 能看到子代理线程 | root/child thread id、两路收据、call ID、nonce |
| DS-04 | send/followup/wait（GUI） | 在 GUI 里追加消息、观察目标线程与等待状态 | 同 CL-02/03/04 判据；UI 进度与原生事件一致 | 消息事件、turn id、等待/超时状态 |
| DS-05 | 递归（GUI） | 触发 DS→DS 与 DS→GPT 各一次 | 子代理线程在 UI 可见；三代 ID 连续；两路收据 | 三代 ID、两路收据 |
| DS-06 | 权限提示与错误回传 | 触发写操作审批（拒绝 + 批准各一次）、触发一个上游错误 | 原生权限提示出现在 GUI；拒绝/批准生效；错误在 GUI 可读且不含凭据 | 审批事件、错误摘要、副作用哈希 |
| DS-07 | 取消 | GUI 中停止正在运行的 turn | 同 CL-10；UI 状态不为「完成」 | 取消事件、终态 |
| DS-08 | 退出重启后同一会话追加 | 完全退出 Desktop → 重开 → 打开同一会话 → 追加任务 | 同一 thread id；原始父子关系保留；child 能复述历史 | 重启前后 thread id（成对）、父子关系快照 |
| DS-09 | 第二个会话隔离 | 另开一个会话，发不同 nonce | 两会话不共享消息/权限/child；互不串线 | 两会话 thread id、各自收据 |
| DS-10 | app-server 协议形状（组件，离线） | `app-server generate-json-schema --out $ISO/schema` | schema 含 `thread/start`、`thread/read`、`thread/resume`、`turn/start`、`turn/interrupt`、`model/list`；`model/list` 的 `Model` 带 `multiAgentVersion`；`ThreadStartParams` 含 `modelProvider`/`cwd`，`ThreadResumeParams` 含 `threadId`，`ThreadReadParams` 含 `includeTurns` | schema 文件清单 + 上述字段存在性 |

DS-10 参考命令（离线、可重复，本轮已实跑通过）：

```bash
/usr/lib/chatgpt/resources/codex app-server generate-json-schema --out "$ISO/schema"
node -e '
const fs=require("fs");const d=process.env.ISO+"/schema";
const req=JSON.parse(fs.readFileSync(d+"/ClientRequest.json","utf8"));
const s=fs.readFileSync(d+"/codex_app_server_protocol.v2.schemas.json","utf8");
for (const m of ["thread/start","thread/read","thread/resume","turn/start","turn/interrupt","model/list"])
  console.log(m, JSON.stringify(req).includes("\""+m+"\"") ? "PRESENT" : "MISSING");
console.log("multiAgentVersion", s.includes("multiAgentVersion") ? "PRESENT" : "MISSING");
' 
```

## 5. 成绩等级（引用审计「通过标准」表，分两张记分卡）

| 等级 | 必须同时满足（审计原文口径） | 本轮状态 |
| --- | --- | --- |
| 基础通过 | 同一条原生会话里有**真实 GPT 根 turn** 与**真实 DeepSeek 子 turn**；两供应商请求收据与 root/child ID、task path、工具 call ID 对齐；子代理执行本地工具并把根可核对的 nonce 回传 | `BLOCKED_PENDING_AUTHORIZATION` |
| 完整通过 | CLI 与 Desktop 各自通过基础，并覆盖 send/followup/wait、完成与错误通知、递归、权限与并发、SSE 故障、取消、重启后恢复；线程与工具状态由原生 Codex 管理 | `BLOCKED_PENDING_AUTHORIZATION` |
| 工作区通过 | 完整通过 + 官方 ChatGPT 认证、工作区归属、认证更新与凭据隔离 | `BLOCKED_PENDING_AUTHORIZATION` |

两张记分卡**分开登记**，互不代偿：

| 记分卡 | 认证模式 | 覆盖用例 | 等级 | 备注 |
| --- | --- | --- | --- | --- |
| CARD-API | OpenAI Platform API Key（按 API 计费） | CL-00～CL-14 + DS-00～DS-10 | `BLOCKED_PENDING_AUTHORIZATION` | 最低成本路径，先做 |
| CARD-ChatGPT | ChatGPT 登录 + 工作区 | 同上 + 认证刷新/吊销、工作区归属、官方头只出现在允许域名 | `BLOCKED_PENDING_AUTHORIZATION` | 当前网关**无**该能力（契约 §3.6 首版不实现），需先实现 `src/codex-upstream-auth.js` 与官方 catalog 路由 |

任一记分卡出现 `EXECUTED_FAIL` 时，等级记「未通过 — 失败」，不得以另一张卡通过来抵消。

## 6. 证据字段最少集（缺一即不收）

| 字段 | 采集方式 | 说明 |
| --- | --- | --- |
| 时间 | `date -Is`（每条用例开始/结束） | 与上游收据时间对得上 |
| 版本 | CLI/Desktop/app-server/Node 版本 + 二进制 sha256（§2.1） | 版本变则重签矩阵 |
| 目录指纹 | §2.8 的 `sha256` 汇总 | 证明当轮配置可复算 |
| 认证模式 | A1 的 `GRANTED` 值 + 实际请求头形状（脱敏：只写头名与布尔） | 区分 CARD-API / CARD-ChatGPT |
| root / child / grandchild ID | `thread.started`、`item.completed`(spawn 工具回填)、GUI 会话头 | 三代成对记录，恢复前后各一份 |
| turn ID | `turn.started`/`turn.completed`；`thread/read` 的 turns | 追加任务必须是新 turn |
| 工具 call ID | `item.completed` 的 `call_id`（及 `namespace`/`name`） | 与上游响应收据里的 call ID 一致 |
| 供应商 + 服务模型 | 网关日志的 provider/upstreamModel；上游响应里的 model | 两路必须不同，且与 A2 一致 |
| 可关联的上游响应 ID | 上游 SSE `response.id` / JSON `id`（或上游 request id 头） | 用于把客户端事件与上游请求配对 |
| SSE 终态 | `response.completed`/`failed`/`incomplete` 或等价；客户端终态事件 | 断流/超时必须能看到非正常终态 |
| 恢复前后身份 | 冷恢复前后 root SID、既有 child ID、父子关系快照 | 证明「同一会话」而非重开新线程 |
| nonce A/B | 任务文本与回传文本 | A 由根给出、B 只在沙箱文件里；根能核对即证明子代理真执行 |

**不作为证据**：模型自报的身份/模型名；UI 截图里的文字；HTTP 200 状态码本身；任何 mock 收据。

脱敏纪律：只记变量名/布尔/计数，不记 Key、Key 片段、长度、请求正文、prompt 全文、账号信息（沿用[验证报告](2026-11-09-dsh-cli-live-verification-report.md) §A5 的口径）。

## 7. 禁止项（出现任一即该收据无效）

1. **mock 不算**：`scripts/test/offline/*`、两 mock 上游、`codex-v2-lifecycle.test.mjs` 的结果只能写「离线/组件」，不得写「真实验收通过」。
2. **HTTP 200 不算**：状态码、`curl` 成功、上游 200 都不能证明语义被消费（DeepSeek 可能静默忽略未知 item）。
3. **纯文本不算**：只有文本回复、没有原生工具调用/线程身份，不能证明 V2 生命周期。
4. **UI 选择器截图不算**：GUI 强调色/下拉项截图不能替代 thread id + 上游收据。
5. **历史 MG-015 smoke 不算**：2026-11-09 的 CLI 记录是 `multi_agent_v1` 且 Chat 桥丢弃了 namespace，不能作为 V2 证据（仅可作对照基线，且必须标注）。
6. 伪造/拼接证据、把 `EXECUTED_PARTIAL` 写成 `PASS`、用另一张记分卡代偿，一律无效。

7. **版本重签义务（固化）**：换 Codex 客户端版本或上游版本**必测**——若新版 `agent_message` 出现新字段、或协作工具/上游工具项出现未知字段，网关会**按设计**返回 400（`opaque_agent_message`）或 502/失败帧（`opaque_function_args`），这是「无法证明明文一律显式失败、不猜测」的契约选择（契约 §5、§5.1），不是降级；因此**每个新版本都要重测并重签本矩阵与收据**，旧版本的通过不能继承。

## 8. 回退（隔离实例失败即停）

精确步骤（按顺序，全部只在隔离面内操作）：

1. **关闭试点 alias**：从 `$MG_CONFIG` 删除两模型的 `codex` 块（或把 `api` 改回原值），保存；`/healthz` 仍 ok。也可整体切回原 provider（`model.provider` 改回日常值）。
2. **保留原 rollout**：不迁移、不改写旧密文；`$CODEX_HOME`（隔离）与日常 `~/.codex` 都不做跨供应商历史重放。
3. **旧密文不迁移**：需要跨路由时由用户同意后**新线程重发**必要明文任务；禁止把旧密文当文本投影。
4. **隔离实例失败**：`kill` 该实例（记端口/PID）→ 验证**原入口** `curl -s http://127.0.0.1:8787/healthz` 可用（只读探测，不重启、不接管）→ 在收据写「回退已执行 + 时间 + 原入口状态」。
5. **Desktop**：按 A5 授权方式回退配置入口；若已重启过 Desktop，记录重启前后 `~/.codex` 指纹以证明未越界。

## 9. 收据规则

- 模板：[codex-v2-receipt-template.md](receipts/codex-v2-receipt-template.md)（三态字段 + 环境指纹 + 授权块 + 用例行 + 上游收据 + 泄漏扫描 + 结论）。
- 本轮离线阶段收据：[2026-11-12-codex-v2-offline-stage.md](receipts/2026-11-12-codex-v2-offline-stage.md)（**明确标注：离线阶段，不含真实上游**）。
- 每份收据必须写：阶段标签（`OFFLINE` / `COMPONENT` / `REAL`）、日期时间、执行人、`git rev-parse HEAD`、`git status --short` 摘要、§2.1 版本指纹、§2.8 目录指纹、§1 授权块、逐用例状态（五态枚举）、结论（等级 + 未验证项 + 下一步）。
- 收据只写摘要与布尔结论；证据文件（日志片段、schema 清单、事件 JSONL 摘要）落 `$ISO`，收据里写路径与哈希，**不入库**。

## 10. 本轮状态与下一步

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 本矩阵（CL/DS 用例、判据、证据字段、禁止项、回退） | DONE | 本文件 |
| 收据模板 | DONE | 同目录 `receipts/` |
| 离线阶段收据（基线回归 + 离线组件断言） | DONE | 明确标注不含真实上游 |
| 离线生命周期套件（`codex-v2-lifecycle.test.mjs`）复跑 | DONE（默认门禁 6 pass / 10 skip；gated `MG_CODEX_V2=1` 16/16，acceptance 与 Lead 各自独立复跑一致） | 见收据 §9 S2-07a/b/c；skip 不计通过 |
| CLI 真实用例 CL-00～CL-14 | `BLOCKED_PENDING_AUTHORIZATION` | 缺 A1～A7 |
| Desktop 真实用例 DS-00～DS-09 | `BLOCKED_PENDING_AUTHORIZATION` | 缺 A5；DS-00/DS-10 属组件验收，可离线跑 |
| 工作区通过（CARD-ChatGPT） | `BLOCKED_PENDING_AUTHORIZATION` | 且需先实现官方头 allowlist 能力（契约 §3.6 首版不实现） |
| 角色 TOML 目录/键名最终确认 | 待实测 | 见 §2.7，首次真实 spawn 时以报错文本确认 |

下一步顺序：①用户填 §1 授权 → ②跑 §2 环境复核并把指纹写进 REAL 收据 → ③CARD-API 的 CL-00/CL-01 最小试点（最小额度，失败即停）→ ④CL-02～CL-14 → ⑤Desktop DS-00/DS-10（组件）→ ⑥GUI DS-01～DS-09 → ⑦需要工作区模式时先做能力实现再重跑 DS-*。