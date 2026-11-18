# 原版 Codex Desktop GUI 验收手册（隔离实例）

本手册用于在**不改动用户日常 Codex** 的前提下，用 ModelGate 生成的原版 Desktop 实例做真机验收：模型选择器可见性、官方/Go 请求回执、退出后配置与登录未被破坏。所有路径、端口、状态目录都可复制；禁止把本项目 Web 控制台截图当作原版 Desktop 证据。

## 0. 前置条件与边界

- Linux 图形会话（KDE/GNOME 均可），`echo $DISPLAY $WAYLAND_DISPLAY $XDG_SESSION_TYPE` 有值。
- 已安装原版 ChatGPT/Codex Desktop（本机 `/usr/bin/chatgpt`），**不要**启动第二个日常实例。
- 仓库已 checkout 到被测 commit；Go 凭据只从受控环境注入（本机 `~/.config/environment.d/90-apikeys.conf`），**不要**写进命令历史/文档。
- 真实调用额度需所有者授权；真实 GPT 仅允许 `gpt-6-luna`，Go 仅 `deepseek-v4.1-flash`。
- 隔离约定：`MG_DESKTOP_STATE` 必须指向 `/tmp/...` 之类可丢弃目录；**禁止**指向 `~/.local/state/modelgate-desktop`，**禁止**让 Desktop 使用 `~/.codex` 作为 `CODEX_HOME`。

## 1. 准备隔离状态与端口

```bash
cd .agents/worktrees/v2-a3-gui
export MG_DESKTOP_STATE=/tmp/mg-desktop-gui-accept
export MG_DESKTOP_PORT=18873          # 选一个空闲且非 18787/8891 的端口
rm -rf "$MG_DESKTOP_STATE" && mkdir -p "$MG_DESKTOP_STATE"
ss -ltn | grep -E ":${MG_DESKTOP_PORT}\b" && echo "端口占用，换一个" || true
```

记录**日常**配置基线（只读，供退出后比对）：

```bash
sha256sum ~/.codex/config.toml ~/.codex/auth.json
stat -c '%n %y' ~/.local/state/modelgate-desktop 2>/dev/null || echo "日常状态目录不存在"
```

## 2. 生成配置（不启动 GUI）

```bash
node bin/mg-desktop.mjs configure
# 期望输出包含：codexHome/guiHome/gatewayHome/port/parentModel=gpt-6-luna/
#             childModel=deepseek-v4.1-flash/alias=mg-opencodego-deepseek-v4-1-flash
cat "$MG_DESKTOP_STATE/codex/config.toml"
cat "$MG_DESKTOP_STATE/codex/models.json" | python3 -m json.tool | grep -E '"slug"|display_name'
```

检查项：

- `codex/config.toml` 的 `model = "gpt-6-luna"`、`model_provider = "modelgate"`、`model_catalog_json` 指向隔离目录。
- `codex/models.json` 同时含 `gpt-6-luna` 与 `mg-opencodego-deepseek-v4-1-flash`（后者 `display_name` 常为 `deepseek-v4.1-flash (opencodego)`）。

## 3. 拉起原版 Desktop（产品 `launch`）

```bash
set -a; . ~/.config/environment.d/90-apikeys.conf; set +a   # 仅注入 shell 环境，不打印
node bin/mg-desktop.mjs launch
# 前台会打印 ModelGate Desktop gateway ready，随后等待 Desktop 退出
```

可选取证增强（只影响取证，不改变产品行为）：设置 `MG_DESKTOP_EXECUTABLE` 指向一个 wrapper，在原参数后追加本机 CDP 端口：

```sh
#!/bin/sh
exec /usr/bin/chatgpt "$@" --remote-debugging-port=9333 --remote-allow-origins=*
```

## 4. 窗口与截图取证

```bash
# 窗口存在（含隔离 user-data-dir 的 WM_CLASS 是可审计证据）
xwininfo -root -tree | grep -iE "chatgpt|codex"
pgrep -af "user-data-dir=$MG_DESKTOP_STATE/desktop"

# 截图：优先只截该窗口，避免把用户桌面/其它内容带入证据
WID=$(xwininfo -root -tree | awk '/ChatGPT/ && /mg-desktop-gui/ {print $1; exit}')
import -display :1 -window "$WID" /tmp/desktop-window.png
# KDE/Wayland 也可用 spectacle（-a 活动窗口 / -u 鼠标下窗口 / -f 全屏）
# spectacle -b -n -a -o /tmp/desktop-window.png
```

注意：不要用全屏截图记录用户其它窗口；只保留隔离实例窗口。

## 5. 模型选择器验收（核心）

在**原版 Desktop 窗口**内：

1. 打开模型选择器（composer 右侧模型名 / 推理强度弹层里的「选择模型」）。
2. 截图，必须同时看到：
   - `6 Luna`（官方 `gpt-6-luna` 的显示名）
   - `deepseek-v4.1-flash (opencodego)`（slug `mg-opencodego-deepseek-v4-1-flash`）
3. 依次选择两个模型，各发一条最小消息：
   - 官方：`Reply with exactly MG_GUI_LUNA_OK`
   - Go：`Reply with exactly MG_GUI_GO_OK`
4. 每条都保留：**GUI 回复截图** + **网关回执**。网关证据：

```bash
tail -50 "$MG_DESKTOP_STATE/gateway/gateway-$(date +%F).log"
python3 -m json.tool "$MG_DESKTOP_STATE/gateway/stats.json" | grep -A3 byModel
```

期望：Go 请求 `byModel.mg-opencodego-deepseek-v4-1-flash` 有 token；官方请求日志出现 `gateway_subscription ... provider=<official> ... domain=official`。

> 已知缺陷（2026-11-15，树 `3116459`）：`bin/mg-desktop.mjs launch` 在本地登录可用时仍传入 `chatgptPlan`，与 `gatewaySubscription` 冲突 → GUI 官方请求 403 `chatgpt_plan_target_denied`，请求未到上游、不耗额度。修复前请把官方 GUI 请求记为 `FAIL`，不要用诊断替代接线（provider 改名）冒充产品通过。详见 `docs/evidence/aggregation-v2-desktop-gui-2026-11-15.md` §4。

## 6. 退出与恢复校验

1. 正常关闭 Desktop 窗口；`launch` 前台进程随之退出，网关关闭。
2. 确认隔离进程/端口清空：

```bash
ss -ltnp | grep -E ":${MG_DESKTOP_PORT}\b|:9333" || echo "ports closed"
pgrep -af "$MG_DESKTOP_STATE" | grep -v grep || echo "no isolated procs"
```

3. 日常配置/登录字节未变（与 §1 基线比对，**必须逐项相同**）：

```bash
sha256sum ~/.codex/config.toml ~/.codex/auth.json
stat -c '%n %y' ~/.local/state/modelgate-desktop 2>/dev/null
```

4. 官方 `gpt-6-luna` 再请求成功（不依赖 GUI 开关的独立证据）：用同一隔离网关配置独立启动 `node src/index.js`（`MG_CONFIG_DIR=$MG_DESKTOP_STATE/gateway`），向 `/v1/responses` 发送 `gpt-6-luna` 最小请求；保留 SSE `response.completed`、`model:"gpt-6-luna"` 与输出文本。若该步失败，记录 `FAIL` 并保留回执，不得只写通过。

5. 只读自动检查：

```bash
node scripts/test/live/desktop-gui-checklist.mjs \
  --state "$MG_DESKTOP_STATE" --port "$MG_DESKTOP_PORT" \
  --expect-daily-sha "$(sha256sum ~/.codex/config.toml | cut -d' ' -f1)"
```

## 7. 清理

- 只删除隔离状态目录 `/tmp/...`；**不要**动 `~/.codex`、`~/.local/state/modelgate-desktop`、用户 systemd 服务。
- 若子进程残留，按**精确隔离路径**终止（如 `pgrep -af "$MG_DESKTOP_STATE"` 后逐个 kill），不要按宽泛的 `chatgpt` 关键字杀进程，以免误伤日常实例。
- 截图中若出现账号标识，提交前裁剪/打码；凭据与 token 永不入库。

## 8. 三模式验收矩阵（直连 / 路由 / 聚合）

> 红线不变：`MG_DESKTOP_STATE` 必须指向 `/tmp/...` 可丢弃目录，**禁止**指向日常状态目录；**禁止**让 Desktop 使用 `~/.codex` 作为 `CODEX_HOME`；§1 的日常配置/登录基线比对在每种模式切换后都要重做。本文只记录验收口径，不代表已通过（三模式实现中，真机 `NOT_TESTED`）。
>
> **切换通用要求**：每次切换走预览→确认→回执；**必须完全退出并重新打开 Codex GUI 才生效**（含切回直连）；只关窗口/刷新/换会话不算生效。映射口径见[三模式接入方式映射](../product/2026-11-18-three-mode-access-mapping.md)。

| 验收项 | 直连 `official` | 路由 `route` | 聚合 `aggregated` |
| --- | --- | --- | --- |
| `mode` 投影 | `official` | `route` | `aggregated` |
| 顶层 config 字段 | 无 `openai_base_url` 改向；`model_provider` 内置 `openai` | `model_provider="modelgate"`；顶层 `model="mg-opencodego-deepseek-v4-1-flash"` | `model_provider="openai"`；`openai_base_url="http://127.0.0.1:8787"`；`model_catalog_json` 指向隔离目录 |
| provider 段 | 无 `[model_providers.modelgate]` | `[model_providers.modelgate]`：`base_url=…:8787/v1`、`wire_api=responses`、`requires_openai_auth=false`、`supports_websockets=false`；`capabilities.remote_compaction=unsupported` | 不生成 provider 段；靠顶层 `openai_base_url` 改向 |
| 子代理 | 无 | 父=子=同一别名；无 GPT 父 | GPT 父（默认 `gpt-6-luna`）+ DeepSeek 子；`[agents.go_deepseek]` 托管 |
| 选择器可见 | 官方 `6 Luna` | **只**有 `deepseek-v4.1-flash (opencodego)`，无 GPT 入口 | `6 Luna` + `deepseek-v4.1-flash (opencodego)` |
| GPT 调用 | 官方直连，是 | **0**：`chatgpt-plan` 出站 = 0 | 是，父 model 必须为 `gpt-6-luna` 才符合 MG-R012 |
| 重启 | 切回直连后完全退出重开 | 切换后完全退出重开 | 切换/启用后完全退出重开 |
| 回执核对 | 官方请求日志 `domain=official` | 网关日志出现 DeepSeek 别名；**无任何 `chatgpt-plan` / official 出站** | `byModel.mg-opencodego-deepseek-v4-1-flash` 有 token；官方请求 `domain=official` |
| 状态判定 | `PASS_REAL` 需真实官方回执 | 子调用真实、`chatgpt-plan` 出站=0 才可 `PASS_REAL` | 父仅 luna 可签 `PASS_REAL`；其它父 `UNVERIFIED` |

### 8.1 路由模式零 GPT 调用怎么验（必做）

1. 切到路由 `mode=route` 并完全退出、重开 Codex GUI。
2. 在隔离实例内发一条最小消息（如 `Reply with exactly MG_ROUTE_OK`）。
3. 查网关日志与 `stats.json`：`byModel.mg-opencodego-deepseek-v4-1-flash` 有 token；`chatgpt-plan` 出站计数 **必须为 0**。
4. 若出现任何官方 GPT / `chatgpt-plan` 出站，判 `FAIL`，保留脱敏回执，不得记为通过。

```bash
tail -100 "$MG_DESKTOP_STATE/gateway/gateway-$(date +%F).log" | grep -iE 'chatgpt-plan|openai|gpt|mg-opencodego'
python3 -m json.tool "$MG_DESKTOP_STATE/gateway/stats.json" | grep -A5 byModel
```

> 非 `gpt-6-luna` 父：按 MG-R012 一律 `UNVERIFIED`，不得签 `PASS_REAL`；放宽需所有者书面授权，AI 不自行签（见[三模式接入方式映射 §4](../product/2026-11-18-three-mode-access-mapping.md)）。

## 9. 状态口径

- `PASS_REAL`：本手册步骤中实际观察到 GUI/网关回执。
- `PASS_MOCK`：只证明离线/替代接线，不能替代产品默认路径。
- `FAIL`：观察到真实失败；保留截图、日志与复现命令。
- `BLOCKED`：缺少授权/额度/图形会话等外部条件，写清恢复条件。
- `NOT_TESTED`：未执行，不得用其它层证据顶替。
