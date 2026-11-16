# ModelGate 交接文档（2026-11-16，所有者指令停止排障后如实记录）

> **2026-11-16 晚更新：** 本文记录的"唯一未关闭阻断"（孤儿 function_call_output）及后续审计发现已在 `fix/modelgate-codex-audit-20261116` 修复并合并 main（a36880d）、部署生产。续轮历史重建见 [审计修复证据](../evidence/2026-11-16-codex-audit-remediation.md) 与 [部署记录](../evidence/2026-11-16-audit-fix-deployment.md)。本文保留为时间点记录；真实长会话复验仍待所有者授权。

> 状态：**半可用（PARTIAL）**。网关侧、UI、聚合启用、官方/DeepSeek 双路路由均已就绪并有真实证据；但 **Codex 真实会话里调用 DeepSeek 仍被一个"工具历史形状"问题阻断**（本轮按所有者指令停止修复，未解决即未解决）。
> 分支：`feat/modelgate-ux-v3`（含 UX-00…UX-06 与后续生产接入修复）· 生产工作树：`/home/xiaomengxizi/ai/workplace/idproject/model-gateway`（分支 `deploy/modelgate-ux-v3`）· 服务：systemd 用户单元 `model-gateway.service`（127.0.0.1:8787）

## 1. 一句话结论

- **能**：网关可以把 DeepSeek 请求真实转发到 OpenCode Go（已用真实请求拿到 `status=completed` 与 Go 计费回执）；官方 GPT 与 DeepSeek 同处一个 `base_url`，父线程 GPT 走 ChatGPT 本机登录、子模型走 Go 环境变量 Key，额度互不占用。
- **不能（当前）**：在 Codex Desktop 的真实会话中，"新开对话"仍会因 Codex 发来的历史里存在**孤立的 `function_call_output`（第 5 项，缺 `call_id` 且前面没有可配对的 `function_call`）**而被网关拦截为 400，Codex 反复重连后报我们给出的可操作错误。**这是本轮唯一未关闭的阻断。**

## 2. 运行事实（本机，2026-11-16 13:30 前后实测）

| 项 | 值 |
| --- | --- |
| 服务 | `systemctl --user model-gateway.service` = active；`/healthz` = ok；端口 8787 仅回环 |
| 管理令牌 | **未设置**（`/api/auth.needAuth=false`；按所有者要求）；`/api/aggregation/*` 因此 403（设计如此） |
| 配置版本 | `configVersion=396`；10 个上游；19 个模型 |
| Go 凭据 | `opencodego: hasKey=true, keySource=env, apiKeyEnv=OPENCODE_API_KEY`（**Key 从未写入/显示**；`config/keys.local.json` 仍为 47 字节的空库） |
| 官方订阅上游 | `chatgptplan`：`https://chatgpt.com` + `codexIdentity=official` + `responsesPath=/backend-api/codex/responses` + `gatewaySubscription.enabled=true` |
| 聚合状态 | `mode=aggregated`，`appliedSha=3c149cd5f6b2…`，备份 `~/.codex/config.toml.bak`（sha 与写入前一致） |
| 聚合目录 | `config/aggregation/catalog/local/current.json`：**12 个模型 = 11 官方 GPT + `mg-opencodego-deepseek-v4-1-flash`**（另有 30 个 Go 模型显式列入 `v2_scope_excluded`） |
| UI | `/` → 302 `/ui-next/`；`/admin`、`/admin.html` → **410**（旧管理台已退役）；`/ui-next/` 200 |
| 路由预演 | `mg-opencodego-deepseek-v4-1-flash → opencodego`；`gpt-6-luna（及其它 gpt-*）→ chatgptplan`；`deepseek-v4.1-flash`（旧 V1 名）→ opencodego |

## 3. Codex 侧配置（已写入，均有备份）

`~/.codex/config.toml`（157 → 约 165 行，非自有段落逐字保留）：

```
model_provider = "openai"
openai_base_url = "http://127.0.0.1:8787"
model = "mg-opencodego-deepseek-v4-1-flash"
model_catalog_json = "<proj>/config/aggregation/catalog/local/current.json"

[features]
multi_agent = true            # 本轮为原生多代理新增

[agents.go_deepseek]          # 本轮新增（命名子代理）
description = "OpenCode Go DeepSeek V4.1 Flash child agent (billing on OpenCode Go, separate from ChatGPT plan)"
config_file = "go-deepseek.toml"
```

`~/.codex/go-deepseek.toml`（0600）：
```
model = "mg-opencodego-deepseek-v4-1-flash"
model_reasoning_effort = "medium"
```

备份：`~/.codex/config.toml.bak`（启用聚合前）、`~/.codex/config.toml.bak-before-agents-<ts>`、`~/.codex/config.toml.bak-before-subagent-<ts>`。

## 4. 已验证的证据

1. **真实 DeepSeek 响应**（与 Codex 同路径 `POST /v1/responses`）：
   `status=completed`，`model=mg-opencodego-deepseek-v4-1-flash`，`usage={input 37, output 14}`，`opencode.billing_source=go`。
2. **官方 GPT 经网关转发**（日志）：`gateway_subscription provider=chatgptplan target=chatgpt.com/backend-api/codex/responses credential=local_codex_auth`，客户端凭据头被丢弃、由网关只读本机登录替代。
3. **修复 1（已上线）**：第三方 Responses 目标剔除 `stream_options`（`projectThirdPartyResponsesParams`）——Codex 带该字段时 OpenCode Go 会 400，现不再报错。
4. **修复 2（已上线）**：`repairThirdPartyToolCallIds()` 对第三方目标**按位置无损补齐** `call_id`（assign/pair/backfill），实测 `[function_call(无id), function_call_output(无id)]` 与 `[message:user, function_call(无id)]` 均被上游接受；日志 `Codex 工具项 call_id 已按位置补齐 … 0:assign,1:pair`。
5. **回归**：`npm run check` 19/19；`npm test` **127 套件 / 1230 用例 / 0 失败 / 3 skip**；`codex doctor` 配置解析 ok。

## 5. 唯一未关闭的阻断（如实记录）

**现象**：Codex Desktop 新开对话即失败并反复重连，最终错误：

```
会话历史第 5 项（function_call_output）的工具项缺少 call_id，且网关无法按位置配对
（前面没有可对应的工具调用）。第三方便携 Responses 上游要求 call_id 非空；
请新开会话，或清理这段异常历史后重试。
```

**日志证据**（`logs/gateway-2026-11-16.log`，本地 13:27:15）：

```
第三方 Responses 历史中工具项缺少 call_id opencodego index=4 type=function_call_output
shapes=message|message|message|message|function_call_output|message|message|function_call_output|message
```

即：Codex 发来的 `input` 里有 `function_call_output`，但**它前面没有任何 `function_call`/`custom_tool_call`/`local_shell_call`**（4 个 message 之后直接是 output）。因此：
- 不是压缩/旧历史（13:25 那次新会话首轮就是 `message:user|function_call` 缺 id，已由补齐修复解决）；
- 孤儿 output **无法**用位置配对修复（没有对端 call），网关不改写、不丢弃，按 fail-closed 返回可操作 400；
- 请求在发往上游之前就被拒，**不产生任何模型计费**。

**已排除**：stream_options（已修）、缺 id 的 call/output（已修）、代理/端口/Host 校验、Key 解析（`hasKey=true`）、模型路由（预演正确）、目录缺失（12 模型 present）。

**尚未确认的根因（建议按序调查）**：
1. 打印更细的 shape 诊断（每项 `type`、`id`、`call_id` 是否存在、`name`，**不含内容**），确认这 4 个 `message` 是否其实是 `type:"message"` 的**工具结果**被 Codex 重命名；
2. 用同一轮对话对比"指向官方 ChatGPT"与"指向网关"时 Codex 发出的 item 序列差异（是否 Codex 对非官方 provider 主动丢弃了 `function_call` 项）；
3. 备选修复方向：
   - (a) **改走 Chat 桥**：把聚合模型 `api` 改为 `openai`（Chat 桥会把 Responses 历史转成 Chat 消息，桥内已有 `tool_output_without_call` 等 lossy 处理），代价是原生 Responses/原生压缩链路需重新验收；
   - (b) 对孤儿 output **显式丢弃并记 lossy 诊断**（会改变模型可见历史，需所有者批准）；
   - (c) 在 output 前**合成占位 `function_call`**（把 output 变成合法配对；语义上等于"历史里有一次已完成的工具调用"）；
   - (d) 让 Codex 侧不要发送该形状（检查 `features.unified_exec` / `code_mode` / 子代理 `fork_context` 等开关）。
4. 每次试验只需 `tail -f logs/gateway-<date>.log` 看 `shapes=` 与 `工具项 call_id 已按位置补齐` 两行即可判断。

## 6. 未验证 / 不要当作已通过

- **父 GPT → DeepSeek 子代理的真实派单**：未由代理执行（需一次真实 `gpt-6-luna` 父调用）。DeepSeek 侧本身已真实通过。
- **Codex 内工具往返（含多轮）与原生压缩（MG-R006）**：未在真实会话中验证。
- **官方 GPT 推理成功码**：日志证明请求经网关带本机凭据发出，未逐条核对 200/usage。
- 读屏器/axe、Windows/macOS、真实 Codex GUI 模型选择器截图：未验收。

## 7. 本轮变更清单（均在分支 `feat/modelgate-ux-v3`）

- 前端 V3 全量（UX-00…UX-06）：`src/ui-next/**`、`src/index.js`（`official` 投影、静态服务、旧入口退役）、`scripts/test/offline/ui-*`、`scripts/e2e/ui-v3-browser.mjs`、文档与证据。
- 生产接入：`src/aggregation/registry.js`（`adopt` 接管）、`src/aggregation/api.js`（`preset`/`adopt` 透传、`providerCredentialResolver`）、`src/index.js`（`stream_options` 剔除、`call_id` 校验与补齐）、`src/ui-next/views/connections.js`（环境变量凭据优先）。
- 运行期配置（**不在 git 里**）：`config/gateway.local.json`（adopt 元数据 + chatgptplan + 11 官方模型 + `defaults.codexCatalogBasePath`）、`config/codex-models-baseline.json`、`config/aggregation/**`（目录/快照）、`~/.codex/config.toml` 与 `go-deepseek.toml`。
- `.gitignore` 增补：`config/aggregation/`、`config/codex-models-baseline.json`、`config/videos.json`（防止运行期产物被误提交）。

## 8. 部署与回滚

**部署现状**：生产工作树已是 `deploy/modelgate-ux-v3`（= 本分支内容），systemd 单元 `ExecStart=node src/index.js`（Node 22.22.2，工作目录即该树）。
**完整回滚（Codex 侧）**：
```bash
cp ~/.codex/config.toml.bak ~/.codex/config.toml        # 回到启用聚合前
rm -f ~/.codex/go-deepseek.toml                          # 移除命名子代理（可选）
systemctl --user restart model-gateway.service           # 无需，但可确保状态一致
```
**回滚网关切回旧代码**：备份在 `<proj>/.agents/deploy-backup-20261115-234750/`（含旧 `src/`、旧 `ui-next`、`local-index.patch`、`STATE.txt`）：
```bash
git -C <proj> checkout dev/gateway-audit-20261108
cp -a <proj>/.agents/deploy-backup-20261115-234750/src/. <proj>/src/
systemctl --user restart model-gateway.service
```
**退出聚合**（需先设管理令牌）：`POST /api/aggregation/deactivate` 或控制台「退出并恢复」。

## 9. 凭据与安全（本轮自查）

- OpenCode Key 仅以**环境变量** `OPENCODE_API_KEY` 提供；进程/用户级环境实时解析（`resolveKey`），**未写入** `gateway.local.json`、`keys.local.json`、目录、日志或任何文档。
- `config/keys.local.json` 保持 47 字节；`gateway.local.json` 仅含变量名（`grep sk-` = 0 命中）。
- 为执行聚合写入曾临时设置随机管理令牌，操作完成后立即以空值清除并删除临时文件；终态 `needAuth=false`。
- 提交/推送前扫描：`git log -p origin/mg-codex-native..HEAD | grep` 关键模式（`sk-`/`ghp_`/`gho_`/`AKIA`/`BEGIN PRIVATE`/`Bearer 长串`）= **0 命中**；本次推送不含 `config/*.local.json`、`keys.local.json`、`admin.token`、`master.key`、`.agents/`（均在 `.gitignore`）。

## 10. 需要所有者决定

1. 是否继续排障（推荐先做 §5 的 (1)(2) 诊断，再在 (a)(b)(c)(d) 中选一条）。
2. 是否允许一次真实 `gpt-6-luna` 父 → DeepSeek 子代理派单验证。
3. `MiniMaxAI/MiniMax-M3` 的真实上下文窗口（补 `maxContext` 可消除"Codex 目录不可用"启动警告）。
4. 是否需要把 `[agents.go_deepseek]` 纳入网关的配置所有权（目前为手工写入，退出聚合不会自动清理由此产生的段）。
