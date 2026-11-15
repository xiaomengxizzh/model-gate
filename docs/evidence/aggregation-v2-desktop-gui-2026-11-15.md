# ModelGate V2｜原版 Codex Desktop GUI 真机验收（2026-11-15，V2-REAL-2）

> 所有者已授权本轮真实调用（仅 `gpt-6-luna` 与 OpenCode Go `deepseek-v4.1-flash`）。本文件只记录**实际发生**的事实；未执行项一律 `NOT_TESTED`/`BLOCKED`，不用 Web 控制台或 CLI 结果冒充 GUI。
>
> 被测树：`3116459899c17b811300995986a88de67ee50051`（`mg-codex-native`，工作树 `.agents/worktrees/v2-a3-gui`，分支 `feat/v2-a3-gui`）。
>
> 结论摘要：**GUI 内同时可见官方模型与 Go 模型（PASS_REAL）**；**Go `deepseek-v4.1-flash` 在 GUI 内真实推理成功（PASS_REAL）**；**产品 `launch` 路径的官方 `gpt-6-luna` 请求在树 `3116459` 上被网关 403 拒绝（FAIL，已确定性复现；历史记录保留）**；退出后用户日常配置/登录字节未变、官方订阅再请求成功（PASS_REAL）。
>
> **修复复测（2026-11-15，树 `fb986eeb7341877c8e8017918abf2f2b90cd95bb` + 修复提交 `5481bd9（旁支等价提交 0c867fd）`）**：`MG_DESKTOP_SUBSCRIPTION_MODE=auto` → `mode=local`，产品默认 `launch` 下 GUI 官方 `gpt-6-luna` 正常回复 `MG_GUI_LUNA_FIXED_OK`，网关出现 `gateway_subscription ... target=chatgpt.com/backend-api/codex/responses` 且**无** `chatgpt_plan_target_denied` → **官方 GUI 请求升 PASS_REAL**（详见 §8）。原 `3116459` FAIL 记录不删改。

## 1. 环境与隔离（本机事实）

| 项目 | 值 |
| --- | --- |
| 图形会话 | KDE Plasma，`XDG_SESSION_TYPE=wayland`、`DISPLAY=:1`、`WAYLAND_DISPLAY=wayland-0`、`XDG_RUNTIME_DIR=/run/user/1000`、`graphical-session.target=active` |
| 原版 Desktop | `/usr/bin/chatgpt → /usr/lib/chatgpt/codex-launcher`，产品版本 `26.1103.32239`（`resources/linux-package-metadata.json`），运行时 `157.0.8103.39` |
| 捆绑 Codex | `/usr/lib/chatgpt/resources/codex` → `codex-cli 0.167.0-alpha.3.2`（只读探测 `--version`） |
| 隔离状态根 | `MG_DESKTOP_STATE=/tmp/mg-desktop-gui-a3`（**未**写 `~/.local/state/modelgate-desktop`） |
| 隔离 Codex HOME | `/tmp/mg-desktop-gui-a3/codex`（**未**写 `~/.codex`；config/models 均由 `configure` 生成） |
| 隔离 Desktop 数据目录 | `/tmp/mg-desktop-gui-a3/desktop`（Electron `--user-data-dir`） |
| 网关端口 | `18873`（非 18787/8891；`ss` 确认空闲后使用） |
| Go 凭据 | `OPENCODE_API_KEY` 从 `~/.config/environment.d/90-apikeys.conf` 注入子进程；**未打印、未入库** |
| 日常实例 | 用户日常 Codex（`~/.config/Codex`）保持运行，未聚焦/未操作；隔离实例窗口类名明确含 `/tmp/mg-desktop-gui-a3/desktop` |

只读集合证据（运行前后一致）：

```
ee7267f88572811c461c1065c59598a58a7e4df2ceeb0df62fa2ca7bdaffbbfd  ~/.codex/config.toml
de7cc6e996e6bcef35041d489f5dac84b799de735851531d5a11f7f6a4a7fc11  ~/.codex/auth.json
/home/xiaomengxizi/.local/state/modelgate-desktop 2026-11-14 14:34:55.691755916 +0800   （mtime 未变）
```

## 2. 执行命令（可复制）

```bash
cd .agents/worktrees/v2-a3-gui
export MG_DESKTOP_STATE=/tmp/mg-desktop-gui-a3 MG_DESKTOP_PORT=18873
node bin/mg-desktop.mjs configure
# 输出：{"codexHome":".../codex","guiHome":".../desktop","gatewayHome":".../gateway",
#        "port":18873,"parentModel":"gpt-6-luna","childModel":"deepseek-v4.1-flash",
#        "alias":"mg-opencodego-deepseek-v4-1-flash"}

set -a; . ~/.config/environment.d/90-apikeys.conf; set +a
# 仅取证用途：wrapper 在同样参数上追加本机 CDP 端口，不改变产品行为
cat > /tmp/mg-chatgpt-cdp-wrapper.sh <<'SH'
#!/bin/sh
exec /usr/bin/chatgpt "$@" --remote-debugging-port=9333 --remote-allow-origins=*
SH
chmod 700 /tmp/mg-chatgpt-cdp-wrapper.sh
MG_DESKTOP_EXECUTABLE=/tmp/mg-chatgpt-cdp-wrapper.sh node bin/mg-desktop.mjs launch
```

窗口取证（`xwininfo`，未安装新依赖）：

```
0x3e00004 "ChatGPT" ("chatgpt (/tmp/mg-desktop-gui-a3/desktop)" "Chatgpt")  1090x760+735+406
```

进程取证（节选）：

```
/usr/lib/chatgpt/ChatGPT ... --user-data-dir=/tmp/mg-desktop-gui-a3/desktop ...
(另见 /tmp/mg-desktop-gui-a3/desktop/artifact-sessions/... 的子进程，均在该隔离目录下)
```

截图：`import -display :1 -window 0x3e00004`（X11 窗口）与 CDP `Page.captureScreenshot`（仅本机 127.0.0.1:9333）双路取图；`spectacle` 亦可用但本轮未依赖。

## 3. 分步结果（严格状态）

| 步骤 | 状态 | 证据 |
| --- | --- | --- |
| 隔离 `configure`：生成 codex config/models、gateway.json，alias=`mg-opencodego-deepseek-v4-1-flash` | **PASS_REAL** | `/tmp/mg-desktop-gui-a3/codex/config.toml`（sha256 `91630dd0…`）、`models.json`（`f7f2bf65…`）、`gateway.json`；见 §2 输出 |
| 产品 `launch` 拉起原版 Desktop（隔离 user-data-dir），窗口存在、网关健康 | **PASS_REAL** | `xwininfo` 窗口行、`curl /healthz → ok`；截图 [01](2026-11-15-desktop-gui/01-isolated-desktop-window.png) |
| 打开原版模型选择器，同时出现官方与 Go 模型 | **PASS_REAL** | 截图 [02](2026-11-15-desktop-gui/02-model-picker-both-models.png)；DOM 文本 `选择模型 / 6 Luna / deepseek-v4.1-flash (opencodego)`；目录 `models.json` 中 slug 为 `gpt-6-luna` 与 `mg-opencodego-deepseek-v4-1-flash`（display_name 即截图文案） |
| GUI 内选择官方 `gpt-6-luna` 并发请求（产品 launch 路径，历史树 `3116459`） | **FAIL**（历史） | GUI 显示 `403 Forbidden: ChatGPT 应用授权只允许指定的本机入口与 OpenAI Responses 目标`；截图 [03](2026-11-15-desktop-gui/03-official-403-in-gui.png)；确定性复现见 §4。**已在 `fb986ee` 修复并复测，见下一行与 §8** |
| 同上，修复后复测（树 `fb986ee` + `5481bd9（旁支等价提交 0c867fd）`，`MG_DESKTOP_SUBSCRIPTION_MODE=auto`→local） | **PASS_REAL** | GUI 回复 `MG_GUI_LUNA_FIXED_OK`（截图 [06](2026-11-15-desktop-gui/06-luna-fixed-ok.png)）；网关日志 `gateway_subscription provider=chatgpt-plan target=chatgpt.com/backend-api/codex/responses`，`chatgpt_plan_target_denied` 0 次；回执见 `2026-11-15-desktop-gui/luna-fixed-receipts.txt` |
| GUI 内选择 `deepseek-v4.1-flash` 并发请求 | **PASS_REAL** | 回复 `MG_GUI_GO_OK`（截图 [04](2026-11-15-desktop-gui/04-go-deepseek-reply.png)）；网关 stats `byModel.mg-opencodego-deepseek-v4-1-flash.tokens=34879`（in 34818 / out 61）；provider=`opencodego` 日志见 `gateway-receipts.txt` §3 |
| 诊断性替代接线（隔离 gateway.json 内 provider 改名 `chatgpt-local`，不传 `chatgptPlan`）下官方 `gpt-6-luna` | **PASS_MOCK**（workaround，非产品默认） | 回复 `MG_GUI_LUNA_OK`（截图 [05](2026-11-15-desktop-gui/05-luna-diagnostic-reply.png)）；日志 `gateway_subscription provider=chatgpt-local target=chatgpt.com/backend-api/codex/responses` |
| 退出 GUI 实例：日常 `config.toml`/`auth.json` 字节不变、日常状态目录未写 | **PASS_REAL** | §1 哈希与 mtime 前后一致；隔离进程全部退出、端口释放 |
| 退出后官方 `gpt-6-luna` 再请求成功 | **PASS_REAL** | 独立 `node src/index.js` 启动**同一隔离**订阅配置，SSE `response.completed`、`model:"gpt-6-luna"`、文本 `MG_OFFICIAL_AFTER_EXIT_OK`、output_tokens=10；节选 `post-exit-official-sse-excerpt.txt` |
| 产品 Web 控制台「一键启停聚合」按钮 | **NOT_TESTED** | 本轮限定原版 Desktop GUI；Web 控制台截图不作为原版 GUI 证据 |

## 4. 真实缺口（阻断官方 GUI 请求）与根因

现象：产品 `launch` 路径下，官方 `gpt-6-luna` 在 GUI 内直接 403；同实例的 Go 模型正常。

根因（代码事实，`src/index.js` 当前树）：

- `bin/mg-desktop.mjs` 在**本地 Codex 登录可用**时把 provider 配成 `gatewaySubscription.enabled=true`（复用本机登录），但 `launch` 仍然调用 `start({ chatgptPlan: { providerId: 'chatgpt-plan', accessToken } })`。
- `src/index.js` 中 `appPlan = state.chatgptPlan && state.chatgptPlan.providerId === pid` 为真，且 `gatewaySubscription` 为真，命中：
  `if (appPlan) { if (gatewaySubscription || ...) return jsonError(403, 'chatgpt_plan_target_denied', ...) }`
- 因此请求在**转发上游之前**被拒绝；网关 stats 请求数不增加，未产生任何真实 GPT 额度消耗。

确定性复现（不触发真实上游，端口 18874，隔离副本）：

```json
{"status":403,"body":"{\"error\":{\"message\":\"ChatGPT 应用授权只允许指定的本机入口与 OpenAI Responses 目标\",\"code\":\"chatgpt_plan_target_denied\",\"type\":\"official_target_rejected\"}}"}
```

见 `repro-403-response.json`。诊断替代接线（provider 改名后 `appPlan=false`）立即恢复官方 200 回复，说明**缺口只在 launch 的授权接线选择，不在订阅实现本身**。

建议修复（不属于本任务写集，交 A4 `task-7` / 主代理）：`bin/mg-desktop.mjs` 在 `gatewaySubscription` 模式（local）下不得传入 `chatgptPlan`，或让 `src/index.js` 在 `gatewaySubscription` 优先时跳过 `appPlan` 分支；并按 task-7 的 `MG_DESKTOP_SUBSCRIPTION_MODE=auto|local|app|off` 显式化。

## 5. 对 MG-R 的影响（只陈述证据，不自行改门禁）

| 需求 | 本轮证据结论 |
| --- | --- |
| MG-R001（GUI 一键开关/重载） | 隔离实例可启动/退出、配置生成正确；**未**测试 Web 控制台开关 → 维持原状态，GUI 侧部分证据 |
| MG-R004（GUI 逐个选择官方与 DeepSeek） | **选择器双方可见 = PASS_REAL**；Go 请求收据 PASS_REAL（§3）；官方请求收据在历史树 `3116459` **FAIL**（§4），修复后 `fb986ee` 复测 **PASS_REAL**（§8）→ 建议按 §8 证据重评，由 A5/门禁裁决；历史 FAIL 保留不删改 |
| MG-R007（自动检测/备份/退出恢复） | 本任务未走 `desktop-integration` 的 activate/deactivate；日常配置/登录未被写 = PASS_REAL 事实；聚合开关的恢复仍为 `PASS_MOCK` |
| MG-R010（原配置与登录可恢复） | 日常 `config.toml`/`auth.json` sha256、mtime 前后一致，日常状态目录未写；退出后订阅请求成功 → 本轮**未破坏**用户实例；仍缺"经产品开关走一遍导入/回滚"的真机链路 |
| MG-R002 / MG-R012 | 本轮真实 GPT 调用仅 `gpt-6-luna`；官方请求经本地登录（诊断接线）成功；产品 launch 路径官方失败见 §4 |

## 6. 未满足项与恢复条件

1. **官方模型 GUI 请求（产品默认路径）**：~~FAIL~~ → **已在 `fb986ee`（修复提交 `5481bd9（旁支等价提交 0c867fd）`）修复并复测 PASS_REAL**（§8）。历史 FAIL 与复现回执保留；如后续换树失败，按新树重新记 FAIL。
2. **Web 控制台一键启停**：NOT_TESTED。恢复条件：所有者授权后在 GUI 控制台操作并保留截图+配置哈希，或明确该能力不纳入本轮。
3. **模型选择器内容的机器可读证明**：本轮用截图 + DOM 文本 + `models.json` slug 对照；未做像素级 OCR 门禁。
4. **真实额度记录**：本轮 Go 消耗 34,879 tokens（网关 stats）；官方请求为订阅入口，本地 stats 未计 token（`gpt-6-luna` 条目 tokens=0，请求次数已计）。

## 7. 清理与复现边界

- 隔离实例与网关已全部停止（`ss` 无 18873/9333 监听；`pgrep -f /tmp/mg-desktop-gui-a3` 为空）；日常 Codex 未受影响。
- 截图与回执统一在 `docs/evidence/2026-11-15-desktop-gui/`；完整原始日志仍在 `/tmp/mg-desktop-gui-a3/`（含临时状态，重启机器即丢失）。
- 本轮**未**修改 `src/**`、`bin/**`、`docs/product/**`、`docs/roadmap/**`；CDP 端口仅本机回环，仅用于读取 UI 与截图。
- 手动复现步骤见 [desktop 验收手册](../how-to/desktop-acceptance.md)；只读检查器见 `scripts/test/live/desktop-gui-checklist.mjs`。

## 8. 修复复测：官方 GUI 请求（PASS_REAL，树 `fb986ee` + `5481bd9（旁支等价提交 0c867fd）`）

修复：A4 策略 A 提交 `5481bd9（旁支等价提交 0c867fd）` 将 `chatgptPlan` 限制为 **仅 app 模式**注入（`chatgptPlan: subscription.mode === 'app' ? {...} : undefined`），local/gatewaySubscription 模式不再触发 `appPlan` 冲突守卫。

被测树：`fb986eeb7341877c8e8017918abf2f2b90cd95bb`（`mg-codex-native`，工作树 `.agents/worktrees/v2-a3-gui-fixed`，分支 `feat/v2-a3-gui`）。

环境隔离：`MG_DESKTOP_STATE=/tmp/mg-desktop-gui-a3-fixed`、`MG_DESKTOP_PORT=18875`、`MG_DESKTOP_SUBSCRIPTION_MODE=auto`；`~/.codex` 与 `~/.local/state/modelgate-desktop` 未写（哈希/mtime 复测后仍为 `ee7267f8…` / `de7cc6e9…` / 2026-11-14 14:34:55）。

命令与结果：

```bash
export MG_DESKTOP_STATE=/tmp/mg-desktop-gui-a3-fixed MG_DESKTOP_PORT=18875 MG_DESKTOP_SUBSCRIPTION_MODE=auto
node bin/mg-desktop.mjs configure
# → subscriptionMode:"local", subscriptionReason:"auto_local_login",
#   subscriptionLocalAuthAvailable:true, subscriptionLocalAuthReason:"local_codex_chatgpt"
# → providers.chatgpt-plan: baseUrl https://chatgpt.com + gatewaySubscription.enabled=true
set -a; . ~/.config/environment.d/90-apikeys.conf; set +a
MG_DESKTOP_EXECUTABLE=/tmp/mg-chatgpt-cdp-wrapper.sh node bin/mg-desktop.mjs launch
```

- 窗口：`0x3400004 "ChatGPT" ("chatgpt (/tmp/mg-desktop-gui-a3-fixed/desktop)" ...)`；网关 `/healthz → ok`。
- 原版 GUI：模型标签 `6 Luna`，发送 `Reply with exactly MG_GUI_LUNA_FIXED_OK` → 回复 **`MG_GUI_LUNA_FIXED_OK`**（截图 [06](2026-11-15-desktop-gui/06-luna-fixed-ok.png)）。
- 网关回执（`2026-11-15-desktop-gui/luna-fixed-gateway.log`）：

```
[2026-11-15T06:19:58.079Z] [info]  gateway_subscription provider=chatgpt-plan target=chatgpt.com/backend-api/codex/responses credential=local_codex_auth
[2026-11-15T06:19:58.081Z] [info]  send authz generation=config-declared (unscoped) provider=chatgpt-plan domain=official
```

- `grep -c chatgpt_plan_target_denied` = **0**；stats `requests=2`、`byModel.gpt-6-luna`（订阅入口本地不计 token，请求次数已计）。
- SSE/上游回执由订阅入口返回，GUI 最终文本即 `MG_GUI_LUNA_FIXED_OK`；`model:"gpt-6-luna"` 见网关订阅目标日志与 GUI 模型标签。
- 官方调用次数：本轮 1 次请求（2 条上游日志为同一次 turn 的连接/重试），未超总调用 ≤3 的约束。
- 日常完整性：退出后 `~/.codex/config.toml` / `auth.json` sha256 与 mtime 不变；隔离端口/进程全部停止。

**结论**：产品默认路径（无 provider 改名 workaround）下，原版 Desktop GUI 的官方 `gpt-6-luna` 请求 **PASS_REAL**。历史 `3116459` 的 FAIL 与 `repro-403-response.json` 保留作溯源。
