# DSH CLI 真实链路验证与排障 · 交接提示词（2026-11-09）

> 用途：把 §2 的提示词交给下一位执行代理（或新会话）执行；§0/§1 是本次已核实的起点事实与边界。**本文件与执行过程都不得出现、打印、复制或提交任何 API Key 明文。**

## 0. 起点事实（2026-11-09 核实，均为掩码结论）

### 0.1 ModelGate 代码与提交

- 仓库：`/home/xiaomengxizi/ai/workplace/idproject/model-gateway`，分支 `dev/gateway-audit-20261108`。
- 开发计划中的代码卡已全部关闭（MG-002/008/009/011/012/013/014/015）；最新提交以 `git log --oneline -1` 现场为准（本文件写作时为 `759b972`）。
- 基线验证：`npm run check` 0、`npm test` 24/24 隔离套件、`MG_ALLOW_LIVE_TESTS=1 node scripts/test/live.mjs` 27/27、`npm run docs:check` PASS、`node scripts/check-metadata.mjs` PASS (21)。这些是**离线 mock** 结论，不是真实上游/真实客户端验收。

### 0.2 网关配置中与本次实验相关的条目（掩码）

- provider `opencodego`：`baseUrl=https://opencode.ai/inference/go`，`apiKeyEnv=OPENCODE_API_KEY`，`api=openai`，`proxy=direct`。
- 真实模型 `deepseek-v4.1-flash`：provider `opencodego`，`reasoning=high`，`effortOptions=[low,high,max]`，`effortFormat=reasoning_effort`，`maxContext=1000000`，`maxTokensMax=384000`。
- `defaults.model=gatemodel`（虚拟共用名），`defaults.provider=jiyuan`；配置文件里 `defaults.clientKey` 未设置（运行期是否有 `MG_CLIENT_KEY` 需按 §1 掩码核验）。
- 生产端口 8787 当前**未监听**，`systemctl --user is-active model-gateway.service` 为 `inactive`；不要未经确认直接启动/重启生产实例。

### 0.3 Linux 环境变量 Key 的当前状态（掩码）

- 当前执行 shell：`OPENCODE_API_KEY` **UNSET**，`MG_CLIENT_KEY` **UNSET**。
- systemd user manager 环境中存在 `OPENCODE_API_KEY`（计数 1）；`~/.config/environment.d/*.conf` 中有文件定义它（文件计数 1，未读取/未输出值）。
- 直接调用仓库 `resolveKey()`（进程 env 无该变量、模拟 provider `opencodego`）得到：`source=env-registry`、`hasKey=true`（仅输出来源与布尔，不输出值）。说明 **router.js 的 Linux 兜底（systemd user env + environment.d）在当前环境可工作**。
- 但 DSH CLI 的 headless 规范要求启动环境注入 `OPENCODE_API_KEY`（见 `harness/deepseek/docs/headless-runbook.md`），当前 shell 没有该变量：**网关能从 systemd/env.d 兜底，CLI 自身不能**。这是本次要核查/修复的核心差异，不能想当然。

### 0.4 DSH CLI

- 稳定入口：`/home/xiaomengxizi/ai/harness/deepseek/cli/bin/dsh`，当前版本 **0.2.2-rc.1**（headless runbook 记录的历史基线是 0.2.1-rc.2，执行前以 `--version`/`--help` 现场为准）。
- 产品源码：`/home/xiaomengxizi/ai/harness/deepseek/source/`（先读 `source/AGENTS.md`）。
- 官方 `auth.json`、现有 `~/.dsh` 私有 profile **不得修改/复制**；按 runbook 使用全新 `DSH_HOME`、空 `DSH_AGENTS_HOME` 与唯一 custom profile。

### 0.5 尚未完成（本交接要做的）

- 真实 DSH CLI → ModelGate → OpenCode 上游的端到端链路（流式、工具调用、续传、错误路径、reasoning=high 透传）**未执行**。
- Linux 下“网关从无 env 的进程启动仍能取到 Key”与“CLI 启动环境注入 Key”两条链路**未做端到端联调**；相关失败模式未复现。
- DSH CLI 本次实验中发现的问题未收集/未修。

## 1. 不可违反的约束

1. **绝不输出/记录 Key**：不执行 `env`/`printenv`/`cat ~/.config/environment.d/*`，不把 Key 作为命令行参数、profile 字段、prompt 内容、日志、报告、提交或截图。只允许“存在/不存在、来源（keys/env/env-registry）、长度”这类掩码结论（长度也尽量不写）。
2. 不新增依赖/下载/升级；不安装浏览器、模型或工具。DSH 产品源码修改只在其仓库内，按该仓库规则测试。
3. 不重启/不接管生产 8787 与用户 systemd 服务，除非用户明确批准；优先用隔离实例（独立 `MG_CONFIG_DIR` + 动态/约定端口，如 8788）验证。
4. 真实上游调用仅用于最小必要验证；控制请求数/token；失败即停，不靠重试烧额度。
5. 不改官方 `auth.json`、不读/复制私有 DSH profile、不把私有目录放进实验项目树。
6. 所有“已通过”结论必须有命令、退出码或可复核证据；没跑的写 `NOT_EXECUTED`/`UNVERIFIED`。

## 2. 直接粘贴给执行代理的提示词

```text
你是本次“DSH CLI × ModelGate 真实链路验证与排障”的执行代理。目标：用 DSH CLI 作为真实客户端，经 ModelGate 调 OpenCode 的 deepseek-v4.1-flash（high 思考），完成端到端验证；同时核查/修复 Linux 环境下 ModelGate 的环境变量 API Key 解析，并顺手修复实验中复现的 DSH CLI 问题。

先读（按顺序，不要跳）：
1) /home/xiaomengxizi/ai/AGENTS.md；workplace/AGENTS.md；
2) /home/xiaomengxizi/ai/workplace/idproject/model-gateway/AGENTS.md、RESOURCE_APPROVAL.md、docs/development-plan.md；
3) /home/xiaomengxizi/ai/harness/deepseek/docs/headless-runbook.md、/home/xiaomengxizi/ai/harness/deepseek/README.md；
4) /home/xiaomengxizi/ai/harness/deepseek/source/AGENTS.md；
5) 本文件 §0 的起点事实。

硬约束（违反即停止）：
- 不输出/记录/复制任何 API Key。禁止 env/printenv/cat environment.d；仅允许掩码检查（存在性、来源、是否可解析）。失败信息也不得包含 Key。
- 不新增依赖/下载/安装；不改官方 auth.json；不改/复制现有 ~/.dsh 私有 profile；不重启生产 8787 或用户 systemd 服务（除非用户明确批准）。
- 真实上游调用最小化，失败即停；不把 mock 结论当真实验收；没跑的写 NOT_EXECUTED/UNVERIFIED。

任务 A：Linux 环境变量 Key 的核查与修复
A1. 掩码核验：当前 shell、systemd user env、~/.config/environment.d 三处 OPENCODE_API_KEY 是否存在（只输出 SET/UNSET 与计数，不输出值）。
A2. 核验 ModelGate 两条启动方式：
    - 进程 env 无 Key、但 systemd/env.d 有：启动隔离网关（独立 MG_CONFIG_DIR/端口），确认 resolveKey 返回 source=env-registry、/api/status 的 opencodego hasKey=true（不打印 Key）。
    - 进程 env 有 Key：确认 source=env。
    注意 60s 缓存；需要时用 /api/config/reload 而非重启生产。
A3. 核验 DSH CLI 启动环境：runbook 要求 OPENCODE_API_KEY 在启动环境；当前 shell 没有。给出安全注入方式（例如由 systemd user 环境启动、或 source environment.d 但不回显、或 systemd-run --user --scope），实际验证 CLI 能拿到（只报告存在/来源）。
A4. 若发现不可用：先写失败复现（场景/命令/期望/实际，全部掩码），再最小修复；优先修 router.readUserEnv/resolveKey 的 Linux 分支或启动/文档路径，不改 Key 存储格式。修复必须有离线测试（可注入 user-env 读取器，不触碰真实 Key），并更新配置参考/CHANGELOG。若判断是环境问题而非代码问题，写清证据与用户需做的操作。
A5. 扫描泄漏：用脚本读取环境变量并与仓库/日志/报告文件做“是否包含”的布尔比较（不得把 Key 放进 argv、grep 模式或输出），确认本次改动与记录未包含 Key。

任务 B：DSH CLI → ModelGate 真实链路
B1. 按 runbook 建全新 DSH_HOME/AGENTS_HOME/唯一 custom profile；模型 overlay：
    provider=opencode-go（或实际 provider id），baseURL 指向 ModelGate（如 http://127.0.0.1:8788/v1，按网关实际监听与 /v1 规则核对），apiKeyEnv 指向 DSH 启动环境中的 Key 变量；
    model=deepseek-v4.1-flash，reasoningEffort=high。
    如网关设置了客户端 Key（当前配置未见 defaults.clientKey；运行期需掩码核验），DSH 必须通过对应环境变量携带，不得写进 profile/prompt。
B2. 先做最小实测：流式文本回复成功；再测工具调用（read/glob/grep/write/edit/bash 中至少 3 类）；再测同 SID 续传；记录 NDJSON 关键事件（turn_end=completed、final 非空）与网关侧 /api/status 计数变化（requests/tokens/model）。
B3. 错误路径：未知模型、上游 4xx/5xx、超时/取消；确认 DSH 报错可读、网关错误信封/状态码正确，不泄露上游 Key。
B4. 确认 reasoning=high 被透传（网关日志/上游请求形态，不得打印请求正文中的敏感内容）；若 DSH 或网关丢失档位，记录并修。
B5. 证据：版本、提交、命令、时间、退出码、关键事件摘要；raw NDJSON/config/profile 放模型工作区之外的私有目录，不入 Git。

任务 C：修复实验中复现的 DSH CLI 问题
C1. 每个问题先写最小复现（输入、期望、实际、影响面），再定位是 CLI、profile 解析、provider 适配、SSE/协议、错误处理还是文档问题。
C2. 只修有证据的问题；修改 DSH 源码时遵守其 AGENTS/测试/版本规则，补回归；无法在本轮修完的，写清复现与建议，不硬改。
C3. 候选重点（仅在复现时修，不要凭空改）：baseURL 与 /v1 路径拼接、SSE 分帧/usage、tool call id/arguments、session resume、reasoningEffort 透传、超时/取消、错误信封、Key 缺失时的报错是否可诊断（不回显值）。

任务 D：收口
D1. ModelGate：跑 npm run check / npm test / live 27 / npm run docs:check / node scripts/check-metadata.mjs；更新开发计划与 CHANGELOG；提交（明确写集）。
D2. DSH：按该仓库规则跑测试/构建；若改动，提交并记录版本/影响。
D3. 写交接/验证报告（掩码）：起点、命令与结果、真实链路证据、修复清单、未验证项、下一步。报告不得包含 Key、prompt 正文、私有配置或用户账号。
D4. 停止条件：出现 Key 泄露风险、需要下载/安装、需要重启生产、或需要真实计费但未获授权时，立即停止并报告。
```

## 3. 需要用户确认的决策（执行前问清）

1. 验证实例：隔离 8788（推荐）还是恢复/重启生产 8787 的 systemd 服务？当前 8787 未监听、service inactive。
2. 真实调用预算：允许的最少请求数/模型上限；是否允许 `/api/model-test` 这类会消耗上游额度的探测。
3. DSH CLI 修复范围：只修 headless/CLI 使用路径，还是允许改 provider/SSE/协议核心并升版本？
4. 网关客户端鉴权：是否启用 `clientKey`/`MG_CLIENT_KEY`；若启用，DSH 用哪个环境变量承载（只给变量名，不给值）。
5. 是否允许把脱敏后的真实请求/响应片段写入 `docs/`（默认只写摘要，不写正文）。

## 4. 参考

- ModelGate 开发计划：`docs/development-plan.md`
- 配置参考：`docs/reference/configuration.md`（provider `apiKeyEnv`、`capability`、`defaults.clientKey`）
- 请求生命周期/协议桥：`docs/contracts/request-lifecycle-v1.md`、`docs/reference/protocol-bridge.md`
- DSH headless 规范：`/home/xiaomengxizi/ai/harness/deepseek/docs/headless-runbook.md`
- 资源授权：`RESOURCE_APPROVAL.md`（无新增下载；真实上游消耗按用户授权）
