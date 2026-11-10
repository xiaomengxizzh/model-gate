# DSH CLI × ModelGate 真实链路验证报告（2026-11-09）

> 执行依据：[交接提示词](2026-11-09-dsh-cli-live-handoff-prompt.md)。本报告**不含任何 API Key、Key 片段或长度**，不含 prompt 正文、私有 profile 内容与账号信息；只记录来源/存在性/布尔结论。
> 现场：本机 Linux，Node v24.22.2（DSH CLI wrapper 也指向该二进制），ModelGate 分支 `dev/gateway-audit-20261108`，DSH CLI `0.2.2-rc.1`。

## 1. 起点与本次采用的决策

交接文档 §3 列了 5 个需用户确认的问题。本次按**最保守可逆**方式执行，未触碰生产：

| 问题 | 本次取值 | 理由 |
| --- | --- | --- |
| 验证实例 | 隔离 **8788**（另起 8789 作错误路径夹具） | 生产 8787 未监听、service inactive，不重启不接管 |
| 真实调用预算 | 3 个真实回合 / 7 次上游请求 / 约 29.4k token，全部成功；错误路径改用本地 mock（零成本） | 最小必要验证；失败即停 |
| DSH 修复范围 | 只做验证与文档/测试；未改 DSH 源码（无证据缺陷） | 复现的都属于「配置契约」而非代码缺陷 |
| 网关客户端鉴权 | 未启用 `clientKey`（配置与运行期均为空） | 现状即无数据面鉴权 |
| 报告内容 | 只写摘要与命令/退出码，不写请求正文 | 隐私与凭据纪律 |

## 2. 任务 A：Linux 环境变量 Key 链路

### A1 掩码核验（只输出 SET/UNSET 与计数）

| 位置 | 结论 |
| --- | --- |
| 当前 shell 进程环境 | `OPENCODE_API_KEY` UNSET；`MG_CLIENT_KEY`/`MG_ADMIN_TOKEN` UNSET |
| systemd user manager | `OPENCODE_API_KEY` PRESENT（计数 1，未取值） |
| `~/.config/environment.d/` | 有 1 个 `.conf` 定义该变量（文件名计数，未读取内容） |

### A2 网关两条启动方式（隔离 8788，`MG_CONFIG_DIR` 独立）

- **进程 env 无 Key → env-registry 生效**：`MG_CONFIG_DIR=<私有临时目录> node src/index.js` 于 8788 启动，`/healthz`=ok；`/api/status` 中 9 个上游全部 `hasKey=true`、`keySource=env-registry`（含 `opencodego`，`apiKeyEnv=OPENCODE_API_KEY`）。说明 Linux 兜底（systemd user env + `environment.d`）在真实启动路径可用。
- **进程 env 有 Key → source=env**：在 systemd 用户瞬态服务里运行同一段 `resolveKey` 检查，得到 `{"source":"env","hasKey":true}`；同目录的普通 shell 得到 `{"source":"env-registry","hasKey":true}`。两条分支与文档一致。

### A3 CLI 启动环境的 Key 注入（这是本次的**关键差异**，已实测）

- 普通 shell 直接跑 CLI（无 Key）：`rc=1`，`turn_end.reason.kind=error`，`code=MISSING_CREDENTIAL`，message 明确指到「`OPENCODE_API_KEY` 未设置」且**不含值**；`final` 为空。
- **可用的安全注入方式**（已验证，全过程不回显）：
  ```bash
  systemd-run --user --pipe --wait --collect --unit=dsh-live-N /bin/bash /path/to/run-dsh.sh --json '<任务>'
  ```
  瞬态 user service 继承 systemd user manager 环境（因此拿到 `OPENCODE_API_KEY`），`--pipe --wait` 把 stdout/退出码带回当前终端。
- **反面结论（实测）：`systemd-run --user --scope` 不继承 manager 环境**——scope 跑在调用者上下文里，实测 `OPENCODE_API_KEY` 仍为 UNSET。用 scope 做「注入 Key」是无效做法，别照抄。
- 其余两条可行但不如上面的干净：① 由已加载 `environment.d` 的登录会话启动；② 在进程内 `eval "$(systemctl --user show-environment | grep '^OPENCODE_API_KEY=')"`（不落盘、不回显，但会把值放进 shell 环境，可被同 shell 的子进程看到）。

### A4 Linux 分支的复核与补齐（有证据的最小改动）

结论：**功能可用，不需要修分支逻辑**；但发现两个覆盖缺口，已修：

1. **零离线回归**：Linux 兜底是当前环境唯一的 Key 来源，却没有任何离线测试覆盖（唯一相关套件 `user-env-fallback.mjs` 仅 Windows，Linux 打印 `N/A` 不计通过）。
   现 `src/router.js` 增加测试注入点 `__setUserEnvReaderForTest/__clearUserEnvCache`（注入后仍复用同一份 60s TTL 正/负缓存与变量名白名单），`readEnvironmentDir(name, baseDir?)` 支持指定目录便于用临时目录验证解析规则。
   新增 `scripts/test/offline/user-env.test.mjs`（5 用例）：来源优先级 keys→env→env-registry→无、正/负缓存与清缓存重查、变量名白名单（非法名不触达读取器）、`environment.d` 排序覆盖与注释/非法行、双引号转义还原。
2. **文档/CHANGELOG 口径过期**：CHANGELOG 仍写「仅 Windows 生效（其他平台维持进程环境行为）」，与代码事实不符。已在 CHANGELOG 新条目与[配置参考](../reference/configuration.md)中按实际行为改写。

### A5 泄漏扫描

用脚本在**内存**里把 12 个环境变量值（含 Key/Token 类，长度≥12）与目标文件内容做包含比较，只输出变量名与路径：

```text
SCAN_DONE files=286 env_values=12 hits=0
PATTERN_DONE suspects=0
```

扫描范围：`workplace/idproject/model-gateway`（含本次改动与全部证据）、私有证据目录、`harness/deepseek/docs`。另外对 `OPENCODE_API_KEY=<明文>` 与长 `Bearer ` 形态做了模式检查，**0 命中**。

## 3. 任务 B：DSH CLI → ModelGate → OpenCode 真实链路

### B1 隔离运行面

全新 `DSH_HOME`/`DSH_AGENTS_HOME`/`TMPDIR` 与唯一 custom profile `mg-live`，从公开 headless 模板初始化（`--from-default-profile headless`），overlay 只含：

```yaml
- id: agent-default-model
  config: { provider: opencode-go, model: deepseek-v4.1-flash, reasoningEffort: high }
- id: llm-pi-ai
  config:
    providers:
      opencode-go:
        apiKeyEnv: OPENCODE_API_KEY
        baseURL: http://127.0.0.1:8788/v1
```

`--dump-config` 复核组合树：`agent-default-model` 与 `llm-pi-ai` 均为 overlay 生效态，工具面为 headless 默认（`tool-fs`/`tool-fs-search`/`tool-bash`/`tool-web` 等）。raw NDJSON、config、profile 全在项目树之外的私有目录。

### B2 真实调用证据（三个回合，全部 exit 0 / completed）

| 回合 | 内容 | NDJSON 结论 | 网关计数（global requests / tokens） |
| --- | --- | --- | --- |
| t1 | 纯文本流式（不用工具） | 7 事件；`turn_end.reason.kind=completed`；`final` 非空（"OK"） | 0/0 → **2 / 5479** |
| t2 | 工具调用 `read`+`glob`+`bash` | 15 事件；3 组 `tool_call`→`tool_result` 的 `callId` 全部配对且 `status=completed`；final 复述三项结果 | 2/5479 → **5 / 17363** |
| t3 | 同 SID 续传（`--session-id`），`grep`+`read` | 13 事件；SID 与 t2 一致、cwd 一致；2 组工具调用成功；`completed` | 5/17363 → **7 / 29402** |

补充：每个回合 DSH 都会额外发一个**并发的次要请求**（`reasoning_effort=low`、`max_tokens=4096`、无 tools、2 条 message）；真实上游回合里它在 turn 结束时被客户端中断，网关按 `client_closed` 记账（不计错误、不熔断），因此 t1 的 2 次请求里只有 1 次产出 token。

### B4 reasoning=high 透传（零成本取证）

用本地 mock 上游（记录请求体白名单字段，不记录正文与鉴权头）做两次对照：

1. **DSH 直连 mock**：先 `GET /v1/models`，再 `POST /v1/chat/completions`——证明 `baseURL=http://127.0.0.1:8790/v1` 与 `/v1` 拼接正确（没有 `/v1/v1`）。请求体含 `reasoning_effort:"high"`、`thinking:{"type":"enabled"}`、`max_tokens=384000`、23 个工具 schema。
2. **DSH → 8789 网关 → mock**：网关转发到上游的体里 `reasoning_effort` 仍为 `high`，次要请求的 `low` 也被原样保留（网关不覆盖客户端显式档位）。`thinking` 对象按模型 `effortFormat=reasoning_effort` 整形后不出现在出站体。

### B3 错误路径（DSH 与网关两侧都核）

| 场景 | 网关 | DSH |
| --- | --- | --- |
| 未知模型（curl 直连 8788） | `404` + `{"error":{"message":"未知模型名: …","type":"unknown_model"}}` | — |
| 未知模型（CLI） | 未触达网关 | `rc=1`，`UNKNOWN_MODEL`：`pi-ai provider "opencode-go" has no configured model "…"`（DSH 本地模型目录先拦截） |
| 上游 400 | `400` 1.7ms，信封原样透传 `invalid_request_error`（业务 4xx 不空跑兜底链） | `rc=1`，`INVALID_REQUEST`，message 可读、无 Key |
| 上游 500 | `502` `all_providers_failed`，约 9.9s（重试后放弃） | — |
| 首字节超时（`firstByteMs=5000` + 上游挂起） | `502` `first-byte timeout` | `rc=1`，`SERVER`，message 可读 |
| 缺 Key | 不涉及 | `MISSING_CREDENTIAL`，`final` 空、`rc=1` |

副作用观察：502 信封文案写「已循环兜底约 120s」，与实际耗时（9.9s）不符，容易误导排障；建议改述为「已耗尽兜底链（单轮上限 loopMs=120s）」。

## 4. 任务 C：本次复现的问题清单

1. **【配置契约，不是缺陷】DSH 不接受网关独有的模型名**：DSH 的模型准入来自 provider 目录/profile，不来自 `GET /v1/models`（它会请求该端点，但只服务配置界面的模型发现）。因此 `gatemodel` 这类虚拟共用名、或只存在于网关的模型名会先在 CLI 侧报 `UNKNOWN_MODEL`。**可用解**：在该 provider 路由上显式声明，且手工声明的模型必须同时给出 `api`：
   ```yaml
   - id: llm-pi-ai
     config:
       providers:
         opencode-go:
           apiKeyEnv: OPENCODE_API_KEY
           baseURL: http://127.0.0.1:8788/v1
           api: openai-completions        # 目录未描述该模型时必填，否则 INVALID_CONFIG
           models:
             - id: gatemodel
               reasoningEfforts: { low: low, high: high, max: max }
   ```
   已用本地 mock 网关验证：声明后 `turn_end=completed`、下游收到该模型名的请求，`reasoning_effort` 正常。（未声明 `api` 时的报错是 `INVALID_CONFIG: … needs an api…`，可诊断。）
2. **【行为观察】每回合一个额外低档位请求**：见 B2 补充。它会真实占用一个上游请求（可能被中断），并让网关 `requests` 计数比"回合数"多 1。排障时不要把它当成重复请求或重试。
3. **【已排除】baseURL/`v1` 双拼、SSE 分帧/usage、tool call id/arguments、同 SID 续传、reasoningEffort 透传**：本次均未复现问题，证据见 B1/B2/B4。
4. **【网关文案】502 兜底耗时描述误导**，见 §3 B3。

本轮**未修改 DSH 源码**（没有可归因到代码的复现）；相关配置配方与注入方式已写入 [headless 操作规范](../../../../../harness/deepseek/docs/headless-runbook.md)。

## 5. 任务 D：收口与未验证项

本仓库本轮改动（未新增依赖/下载）：

| 文件 | 变更 |
| --- | --- |
| `src/router.js` | 用户级环境读取器注入点 + `readEnvironmentDir(name, baseDir?)`（仅供离线测试，不改运行时行为） |
| `scripts/test/offline/user-env.test.mjs` | 新增 5 用例离线回归 |
| `docs/reference/configuration.md` | 补 `apiKeyEnv` 解析顺序与「网关兜底不替客户端补 Key」 |
| `CHANGELOG.md` | 新增本轮条目（含 Linux 分支口径纠正） |
| `docs/development-plan.md`、`docs/README.md` | 状态与索引更新 |

验证命令：

| 命令 | 结果 |
| --- | --- |
| `npm run check` | 退出码 0 |
| `npm test` | **25/25** 隔离套件通过（新增 user-env 1 套件；其余 24 套不变） |
| `MG_ALLOW_LIVE_TESTS=1 node scripts/test/live.mjs` | 27/27 旧套件文件通过（133 断言，无 SKIP） |
| `npm run docs:check` | PASS |
| `node scripts/check-metadata.mjs` | PASS (21) |

**未执行 / 未验证（不得当通过）**：
- 生产 8787 与 systemd 服务的启动/验收（按约束未触碰）。
- 真实上游的失败类路径（4xx/5xx/超时全部用本地 mock 复现，未消耗上游额度去制造故障）。
- Windows/macOS 与 Node 18/20 实跑（本机未执行）。
- ~~DSH 侧真实 /responses 通道、gatemodel 虚拟名的真实上游往返~~ → 已在第二批闭环（§7）完成：DSH `api: openai-responses` 与 `gatemodel` 虚拟名均真实往返成功。

## 6. 任务 C 补充：候选缺陷的源码核查与最小复现（2026-11-09 追加）

本节由「只读源码核查 + 本地零成本最小复现」组成。仅标注**已复现**的条目作为事实；其余只有代码证据的列为候选，**本轮不改代码**（改 pi-ai 需走 patch-package，属该仓库规则内的独立工作）。源码事实卡的 file:line 明细在私有证据目录（research/dsh-cli-source-facts.md），不入库。

### 6.1 已复现

**D1 · 流式 tool_call 参数「整串重发」被重复拼接（DSH 侧缺陷，已复现）**

- 场景：mock 上游在相邻两帧分别发 `arguments: '{"file_path":'` 与完整串 `'{"file_path":"seed.txt"}'`（常见聚合/翻译网关行为）。
- 期望：以完整串替换，参数解析为 `{"file_path":"seed.txt"}`。
- 实际：`rc=1`，`turn_end.reason.kind=error`，`code=MALFORMED_RESPONSE`，message 为
  `Tool call "read": Expected ',' or '}' after property value in JSON at position 37`，并回显拼坏的
  `{"file_path":{"file_path":"seed.txt"}`；`final` 为空。
- 归因（源码）：`@earendil-works/pi-ai/dist/api/openai-completions.js:440-443` 只做字符串 append；同包 `utils/streaming-json.js:429-437` 的 `replace()` 在该路径**从未被调用**。
- 影响面：任何会重发完整 arguments 的网关/翻译层。**ModelGate 的 OpenAI chat 路径是逐字节透传，本次不受影响**；只有网关自己做帧聚合/重排时才会踩到。
- 建议修法（未改）：append 前判断新片段是否已是可解析的完整 JSON（或以 `{` 开头且长度不小于旧值）→ 改为 replace；或按 `index` 记录上次值做前缀去重。补一条 mock SSE 回归。

**D2 · reasoningEffort 白名单两侧必须一致（已复现，两端结论一致）**

- CLI：`reasoningEffort: medium` 且不覆盖模型目录 → `rc=1`、`UNSUPPORTED_REASONING_EFFORT: provider "opencode-go" model "deepseek-v4.1-flash" does not support reasoning effort "medium"`；请求未发出（mock 无新请求）。
- 网关：同一模型 `effortOptions=[low,high,max]`，`reasoning_effort=medium|xhigh` → 本地 `400`，错误信封 `type=UnsupportedParamsError`、message 列出允许档位，`/api/status` 计数不变（无上游调用）。
- 结论：本机两侧白名单**一致**，档位错误在本地即可诊断；换 provider/模型时要同时改 CLI 目录与网关 `effortOptions`。

### 6.2 未复现（仅代码证据，候选）

- **D3 `thinking:{type:"enabled"}` 被严格网关 400**：本链路**未发生**。CLI 确实同时发 `reasoning_effort` 与 `thinking`（mock 抓包可见），但 ModelGate 按模型 `effortFormat=reasoning_effort` 整形后，出站体只剩 `reasoning_effort`；真实上游 3 回合均 200。这反过来是网关归一化的一次正向价值。
- D4 手工声明模型被当作「标准 OpenAI」（`store:false`、`developer` 角色）：未观察到拒绝，本机网关不校验这些字段。
- D5 缺 `finish_reason` 硬失败、D6 `data: [DONE] ` 带尾随空格不识别：本轮 mock 都发了 `finish_reason` 与严格 `[DONE]`，故未构造。
- D7 空 text + 退 0 与退 1 在 stdout 上难区分、D8 续传被 cwd 锁死、D9 最坏 5×600s 无总时限、D11 headless 关凭据库、D12 `--dump-config` 也写盘、D13 错误分类正则误判、D14 usage 口径、D15 `patches/` 为空却宣称有 shim：均只有代码证据，本轮未验证。
- 与本轮实测**一致**的源码结论：baseURL 不做 `/v1` 去重（实测请求就是 `/v1/chat/completions`）；退出码仅 `completed` 为 0（实测 error/缺 Key 均 rc=1 且 final 空）；缺 Key 只回 credential-ref 名（实测无值无长度）；`--dump-config` 会写 `cordis.yml`（runbook 已记，实测也不能当零写入）。

### 6.3 DSH 仓库文档漂移（未改，仅记录）

- `harness/deepseek/source/package.json` 为 `0.2.2-rc.1`，但 `AGENTS.md` 仍写「精确锁 0.2.1-rc.2」、`docs/FOR-MODELS.md` 写 `0.1.5-rc.1`。
- `source/patches/` 为空目录，而 `AGENTS.md`/`FOR-MODELS.md` 宣称用 patch-package 维护 dsh-session shim。

## 7. 剩余测试闭环（第二批，2026-11-09）

用户指示「暂时不做多端适配」，其余可执行的验证本轮一次跑完；下表是**唯一口径**。

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| MG-015 DSH 真客户端 · Chat | **PASS** | §3 B2（3 回合 completed） |
| MG-015 DSH 真客户端 · Responses | **PASS**（修复 `include` 后） | `api: openai-responses` → 网关 `POST /v1/responses`，`rc=0`、`completed`、final `RESP_CLIENT_OK` |
| MG-015 `/v1/responses` 真上游（非流式/流式） | **PASS** | 200 + `object=response` + 归一 usage；SSE 8 类事件（created → … → completed），按契约不发 `[DONE]` |
| MG-015 虚拟共用名 `gatemodel` | **PASS** | 网关日志 `model=gatemodel serving=deepseek-v4.1-flash provider=opencodego`，final `GATEMODEL_OK` |
| MG-015 真实 Codex CLI 0.167 | **PASS**（修复工具丢弃后） | `wire_api="responses"` → 8788/v1；rc=0、输出 `CODEX_OK`、tokens used 8,468；另有一次真实工具往返（`exec_command pwd`）。日志有损：`tool_dropped:namespace, tool_dropped:web_search, reasoning_summary, unknown_field:prompt_cache_key, unknown_field:client_metadata` |
| MG-015 Draft PR #2 审计 | **DONE** | 结论见 §7.2：**不合并原样** |
| MG-008 anthropic 协议真上游 | **BLOCKED（上游 402）** | openrouter `union-alpha` 返回 `402 billing_error`（账户无额度）→ 目录链切 `deepseek-v4.1-flash` 返回 200：**真实 402 兜底 PASS**，但 anthropic 适配未被真实调用覆盖 |
| MG-011/012/013/014 真上游 | **NOT_EXECUTED** | `/v1/models` 的 7 个模型全部 `capability=chat`；没有 embedding/rerank/audio/image/video 模型，新增属「模型+计费」决策 |
| MG-009 双标签 409（API 层） | **PASS** | 带 `version` 且过期 → `409` + `currentVersion`，配置未变；不带 `version` 按契约「旧客户端宽容放行」 |
| MG-009 托盘 Linux 实跑 | **NOT_EXECUTED** | 需 `gir1.2-ayatanaappindicator3`（未安装；按资源门禁不自行安装），`tkinter` 亦不可用 |
| Windows/macOS | **SKIPPED** | 按用户 2026-11-09 指示本轮不做多端适配 |
| Node 18/20 | **NOT_EXECUTED** | 本机仅 v24.22.2；装第二运行时需授权 |

### 7.1 代码改动①：`include` 兼容

真实客户端（Codex/DSH）在 Responses 请求里固定发 `include:["reasoning.encrypted_content"]`。原实现整条拒绝 → 真实 DSH 直接 400（`b1-responses` 复现：`4xx: {"message":"include 不支持…","type":"unsupported_parameter"}`）。现改为：**只接受丢弃后不影响正确性的项**（`reasoning.encrypted_content` / `output_text.logprobs`）并记 `lossy: include_dropped:<项>`；图片、托管产物与未知项仍显式拒绝。契约 §3.3/§4/§7、回归 `offline/responses-mapping.test.mjs` 同步。

### 7.1b 代码改动②：托管工具/`namespace` 丢弃放行（让 Codex 真正可用）

调研结论（外部一手来源）：**Codex 0.167 已取消 `wire_api="chat"`**，配置它会直接报错 `wire_api = "chat" is no longer supported` 并指向 [openai/codex discussions#7782](https://github.com/openai/codex/discussions/7782)（该讨论明确写 chat/completions 支持将于 2026-02 彻底移除，自定义 provider 必须改成 `wire_api = "responses"`）。所以"让 Codex 走网关的 chat 入口"这条路已被上游封死，网关必须能吞下 Codex 的 Responses 请求。

Codex 的 Responses 请求形态（本轮抓包）：`keys = client_metadata, include, input, model, parallel_tool_calls, prompt_cache_key, reasoning, store, stream, tool_choice, tools`；`tools` 类型为 `function×7 + namespace(multi_agent_v1) + web_search`。Chat 协议只能表达 function tool，因此桥方向**丢弃不可表达的类型**并逐项记 `lossy: tool_dropped:<type>`；`tool_choice` 点名被丢弃工具时降级 `auto`（否则上游按"无名工具"400）。`store/previous_response_id/background/truncation` 的显式拒绝保持不变，原生 `api:"responses"` 透传路径不经过该映射。

真实结果：Codex rc=0、输出 `CODEX_OK`、tokens used 8,468；随后一次真实工具往返（`exec_command pwd` → `function_call_output` → 第二回合给出真实目录）同样成功。这同时关闭了 MG-015「真实 Codex 对照」与「工具调用循环」两项。

### 7.2 Draft PR #2 审计（`xiaomengxizzh/model-gate` PR #2，draft，未实机验收）

结论：**不合并原样**，理由均为可复核的代码事实：

1. **旁路治理链**：PR 在数据面入口处直接 `await handleCodexResponses(...); return`，不走 `forwardChain` → 没有 MG-002 预算/取消、没有 MG-003/011 的额度与虚拟模型、没有 SSE 背压；它自带的测试 `decline governance bypass for quota-controlled model` 直接把这些治理配置判成 422。已合并实现（`src/responses.js` + `responses-stream.js` + `forwardChain`）已经把 `/v1/responses` 纳入同一条链，合并 PR 会回退 MG-002/006/008/015。
2. **两套 Responses 实现**：`codex-responses.js` 与已合并的 `responses.js` 写同一套事件序列，路由 `/v1/responses` 只能有一个主人，合并即冲突。
3. **配置面分叉**：新增 provider 级 `codexWire/opencodeSession/omitStreamOptions/omitReasoningEffort`。本轮真实上游对照显示 `opencodego` 接受 `stream_options` 与 `reasoning_effort`（3 回合 200），没有证据表明需要这些开关。
4. **无 budget/AbortSignal**：PR 内 `forward(..., { retry: { maxAttempts: 1 }, noRetry429: true })` 不带 MG-002 的 signal，客户端断开/超时不会取消上游。
5. **唯一值得移植的点**：`noRetry429`（429 原样透传 + `Retry-After`，不做内部再重试）。这正好是 MG-002 余项「统一 attempt budget 与 429 Retry-After」，建议单独立卡在统一链内实现，而不是合并整个旁路入口。
6. **可取的诚实度**：PR 文档自标 `Draft / NOT_RUN_LIVE`，与它自己的证据口径一致；这条值得保留为其它草稿的写法。

## 8. 下一步建议

1. 若要长期用隔离实例验证，建议把 `systemd-run --user --pipe --wait --collect` 的启动封装写进 `harness/deepseek/docs/` 的操作脚本（本轮只写文档，不新增脚本）。
2. 把「每回合额外低档位请求」写进网关/CLI 的对接说明，避免排障时误判为重复请求。
3. 网关 502 文案按 §4 第 4 条调整（属 MG-002/008 文案层，需单独卡片）。
4. D1 建议在 DSH 仓库按 patch-package 流程单独立卡（含 mock SSE 回归），本轮只留复现与修法建议，不硬改 vendored 依赖。
5. DSH 仓库的版本号/patches 文档漂移（§6.3）单独清理，别与本轮网关改动混在一批。
