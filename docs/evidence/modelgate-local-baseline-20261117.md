# ModelGate｜本机环境与证据基线快照（G0 预取证，2026-11-17）

> 取证时间：2026-11-17 13:35–13:45（本地时区）。方法：只读命令 + 源码静态审计；**未启动/停止任何服务、未读取任何密钥值、未产生模型费用**。
> 本文件是**时间点快照**，不是实时状态。执行 AI 在 G0 必须用文末命令重新核实每一项；快照与现场冲突时以现场为准，并把差异记入执行台账。
> 用途：为 [总任务书](../roadmap/2026-11-16-modelgate-source-research-real-e2e-master-plan.md) 与 [传输可靠性补充任务书](../research/modelgate-stream-interruption-reliability-20261117.md) 提供已核实的本机事实，避免执行 AI 重复盘点或基于云端猜测行动。

## 1. 仓库与分支拓扑

GitHub 仓库：`xiaomengxizzh/model-gate`。**origin/main = `886e22a863343192e4ae5ab41e38396df4d4813c`**（2026-11-17 fetch 核实）。

本机同一仓库有 5 个克隆 + 多个 worktree，**只有第一个是当前基线**：

| 本机路径 | 分支 | HEAD | 定位 |
| --- | --- | --- | --- |
| `~/ai/workplace/idproject/model-gateway` | `deploy/modelgate-ux-v3` | `886e22a`（= origin/main，工作树干净） | **规范生产/执行基线**。systemd 服务的 WorkingDirectory |
| `~/ai/workplace/idproject/model-gateway-dev` | `dev/gateway-g0-g4-20261107` | `66f274c` | 历史开发克隆，落后，不得作为基线 |
| `~/ai/workplace/idproject/model-gateway-next` | `integration/modelgate-next` | `ec66b24` | 历史集成克隆，不得作为基线 |
| `~/ai/workplace/idproject/model-gateway-codex-agg` | `dev/codex-aggregation-20261111` | `64a5c96` | 历史聚合克隆（PR #6 head），不得作为基线 |
| `~/ai/workplace/idproject/model-gate-frontend` | `dev/frontend-console-rebuild-20261107` | `6bc6441`（有未提交改动） | 历史前端克隆，不得作为基线 |

注意：**远端** `origin/deploy/modelgate-ux-v3` 仍在 `9a371d3`（落后于本地 deploy 分支）；本地 deploy 分支已含 main 的续轮韧性提交。引用 SHA 时一律以 `git rev-parse` 现场值为准。

仓库工作树约定：新分支工作树放 `.agents/worktrees/<name>`（已有 30+ 个历史工作树，含 `main-integration` @ `886e22a` [main]）。执行 AI 新建工作树沿用该约定，不要污染生产 checkout 的分支。

未合并 PR（gh 核实，全部 Draft）：
- **#8** `fix/modelgate-remediation-20261116` head `5ab1a517a7ea498b018a619e39e527841cc89cc7`（2026-11-16 全量修复交付，标注勿合并）
- **#6** `dev/codex-aggregation-20261111` head `64a5c96d…`（多供应商聚合 E1–E8）
- **#4** `dev/ui-next-integration-plan-20261109` head `35bed9bf…`（ui-next 控制中心预览）

gh CLI 已登录账号 `xiaomengxizzh`（scopes: gist/read:org/repo/workflow），可直接用于 PR/Issue 取证。

## 2. 服务运行状态（取证时点）

| 组件 | 状态 | 证据 |
| --- | --- | --- |
| ModelGate 网关 | **inactive (dead)**，disabled | `systemctl --user status model-gateway.service`；`ss -tlnp` 8787/8788/8789 均无监听 |
| ModelGate 托盘 | 在跑（PID 9781，12:38 起） | `scripts/tray/mg-tray-linux.py`；只通过 systemctl start/stop/restart 控制网关，不自行拉起 |
| CC Switch | **没跑**，15721 无监听 | 无 cc-switch 进程；`~/.cc-switch/logs/cc-switch.log` 最后写入 11/13 13:10 |
| ChatGPT 桌面（含 Codex） | **在跑**（主进程 PID 22765；内置 codex app-server PID 23628） | dpkg `chatgpt 26.1103.32239`；`--user-data-dir=~/.config/Codex` |

`model-gateway.service` 单元细节（`~/.config/systemd/user/model-gateway.service`）：
- `WorkingDirectory=/home/xiaomengxizi/ai/workplace/idproject/model-gateway`
- `ExecStart=/home/xiaomengxizi/.workbuddy/binaries/node/versions/22.22.2/bin/node src/index.js`（**生产 Node 是 22.22.2**，不是会话 shell 的 node）
- `Restart=always`；Environment 键名仅 `MG_ADMIN_TOKEN`（取证时值为空）
- override `model-gateway.service.d/20-opencode-env.conf`（0600）：`EnvironmentFile=/home/xiaomengxizi/.config/environment.d/90-apikeys.conf`（Go 等凭据来源，**不得打印内容**）
- journal 告警：`StartLimitIntervalSec` 写在 [Service] 段被忽略（应放 [Unit]）——非阻断配置瑕疵，修复需单独授权。

**含义**：若现在启动网关，跑的将是 `886e22a`。真机复现任何阻断前，必须先明确启动哪个树、哪个端口、哪份配置，并记录 PID/SHA。

## 3. 客户端版本与形态

- **Codex CLI**：`codex-cli 0.167.0`。`~/.local/bin/codex` → `~/ai/harness/codex/cli/bin/codex`（versions 目录含 0.167.0）。
- **Codex Desktop 的实际形态 = ChatGPT 桌面应用内置 Codex**，无独立 Codex 桌面应用：
  - deb 包 `chatgpt 26.1103.32239`，安装于 `/usr/lib/chatgpt/`；内置 `resources/codex` app-server，`CODEX_CLI_PATH=/usr/lib/chatgpt/resources/codex`。
  - 启动链：`chatgpt.desktop` → `~/.local/bin/chatgpt-quiet-launch`（日志限流包装）→ `~/ai/harness/codex/app/bin/chatgpt`。
  - `~/.config/Codex/` 是 Chromium 风格 profile（`Last Version`=157.0.8103.39 是引擎版本，不是 Codex 版本）。
  - **验收时"原版 Codex Desktop"指的就是这个 ChatGPT 桌面窗口内的 Codex**；隔离实例按 `docs/how-to/desktop-acceptance.md` 用 `bin/mg-desktop.mjs` 生成。
- **CC Switch**：dpkg `cc-switch 4.0.27`，`/usr/bin/cc-switch`（48.6MB Tauri 二进制，11/7 安装）。`~/ai/projects/cc-switch/` 只有 `downloads/CC-Switch-v4.0.27-Linux-x86_64.deb` 与解包 `app/usr/`，**不是源码工作树**。
- **本机没有任何 cc-switch 或 openai/codex 源码克隆**（已扫描 ~/ai/projects、~/ai/tmp、~/ai/harness、~/Documents、~/Downloads 全部 .git remote 核实）。源码研究必须走 GitHub 对应 tag 的网页/raw 读取；需要整树 shallow clone 时按 `RESOURCE_APPROVAL.md` 先提交候选申请。
- **已有 v4.0.27 tag 源码选摘快照**：`/tmp/ccs427/`（1.8MB，2026-11-17 调研时从 `raw.githubusercontent.com/farion1231/cc-switch/v4.0.27/…` 抓取的关键文件：`proxy/handlers.rs`、`proxy/server.rs`、`proxy/providers/streaming_responses.rs`、`proxy/providers/streaming_codex_chat.rs`、`mode/`、`codex_config.rs`、`codex_login.rs`、`live/` 等）。**这是研究快照不是安装**；/tmp 可丢弃，执行 AI 用前先核对文件存在与内容，缺失则按同 tag 重新抓取单文件（网页/raw 读取属允许的研究方式）。关键行号已抽查核实（handlers.rs L1060–1074 固定 426；streaming_responses.rs L4595–4599 终态后传输错误静默 break；streaming_codex_chat.rs L801–807 [DONE] 后 return）。
- 上游版本溯源：v4.0.27 发布于 2026-11-07（与本机 deb 安装日期一致）；上游最新 release 为 v4.0.33（2026-11-16），本机落后 6 个 patch。**不得把上游 main/v4.0.33 的行为当作用户运行版行为**；对照修复时间线：PR #8138→v4.0.12、PR #8281→v4.0.13，均已含于 v4.0.27。

## 4. Codex 配置元数据（只读结构，不含秘密值）

`~/.codex/config.toml`（5453B，**2026-11-17 12:41 修改**，另有 6 份 .bak）：
- `model = "gpt-6-luna"`（注意：2026-11-10 的 how-to 文档记录当时默认是 `gpt-6.1-sol`，**今天已改**）
- `model_reasoning_effort = "medium"`；`model_provider = "openai"`（**当前日常路径 = 官方直连**）
- `model_catalog_json` 指向仓库 `config/aggregation/catalog/local/current.json`
- `[model_providers.custom]`：`base_url = "http://127.0.0.1:15721/v1"`（CC Switch 代理口，**当前死端口**）、`wire_api = "responses"`、含 `experimental_bearer_token` 键（占位值）
- **无 `experimental_responses_websocket` 键**（WS 行为由客户端默认决定，见补充任务书 §3）
- `[features]`：`multi_agent=true`、`memories=true`、`chronicle=false`、`local_thread_store_compression=true`
- `[agents.go_deepseek]`：`config_file = go-deepseek.toml`（76B，OpenCode Go 子代理配置，另有 2 备份）
- 其余：desktop 主题、plugins、mcp_servers（tool-gate/penpot/node_repl）、projects 信任段

模型目录 `~/.codex/cc-switch-model-catalog.json`（906KB，11/7）：顶层 `models` 数组 **15 条** = 官方 10（gpt-6.1-sol、gpt-6-astra、gpt-6.1-terra、gpt-6-sol、gpt-reserve、**gpt-6-luna**、gpt-5.6-sol/terra/luna、codex-auto-review）+ `ccs-opencode/` 5（glm-5.3-flash、**deepseek-v4.1-flash**、beam-free、mimo-v2.6-flash、muse-spark-1.3-contributor）。

旧线程证据规模（R17 旧线程 A/B 的素材充足）：
- `~/.codex/sessions/` **454 个文件**（最新 11/16 23:11 rollout jsonl）
- `~/.codex/archived_sessions/` **113 个**
- `~/.codex/thread_history_1.sqlite` **446MB**（11/16 23:30）、`logs_2.sqlite` 73MB、`.codex-global-state.json` 1.7MB
- `auth.json` 3995B（11/7）——**只记存在与哈希，禁止读内容**

## 5. CC Switch 数据元数据

- `~/.cc-switch/cc-switch.db` 21,950,464B，mtime **11/13 13:14**（未打开读取）
- `settings.json`、`live-state.json`、`codex-official-models.json`（675KB）、`model-pricing.json`、`codex-catalog-history.json`、`backups/`、`skills/`
- `logs/cc-switch.log` 253,956B，mtime **11/13 13:10**；最近 50 行仅 3 条 WARN（FWD-003 上游 HTTP 429），均为 11/13 刻意注入/取证测试（"A6 synthetic Go failure (intentional 429)"、"capture only"），**无断流类错误记录**
- `~/.config/com.ccswitch.desktop/` 仅 .window-state.json；`~/.local/share/com.ccswitch.desktop/` 为 WebKit 缓存

**含义**：本机 CC Switch 日志不能直接证明用户历史断流根因（最后活动停在 11/13 的注入测试）。用户报告的"以前在 CC Switch 遇到过"需要向用户确认时间窗与版本，再对照上游 Issue。

## 6. 历史真机证据与当前阻断

`~/ai/tmp/mg-ccswitch-live-20261113/`：fixture/ 9 文件 + out/ 26 文件，是 11/13 的刻意 429 注入取证（a6 子代理按预期死于 `exceeded retry limit, last status: 429`），**不是断流自然复现**。

仓库最近证据（docs/evidence/）：
- `2026-11-16-audit-fix-deployment.md`：main 6bc6441→a36880d 部署；133 suites/1282 tests 全绿；目录 generation 6→7；冒烟含 WS 101 与续轮 400 新行为。
- `2026-11-16-p0-01-root-cause-and-decision.md`：孤儿 `function_call_output` 缺 `call_id` → 网关 typed 400（零计费）；真实 Desktop 关闭仍 BLOCKED 待所有者裁决。
- `2026-11-16-p0-01-real-validation.md`：所有者授权真实付费验证；orphan-adopt 补稳定合成键 `call_mg_orphan_<hash>`（提交 5f765f7），隔离 CODEX_HOME，未触生产。

**晚间交接（`docs/roadmap/2026-11-16-modelgate-handoff-evening.md`）当前唯一阻断**：
官方父代理带工具调用的续轮被上游 400 拒绝（`No tool call found for function call output`）。官方后端 resp id（**56 位 hex**）从未被登记；6 条 recorded 全是 Go 的 **32 位 hex**。降级转发按设计工作但官方拒孤儿。交接指定的下一步：在 `proxyOfficialResponses` 加 content-type + 首个 data 块 JSON 键名 + id 位置的结构日志，**一次真机单轮取证后再修 sink，禁止盲猜兼容**。

台账状态：A 严格审计 17 项全修复；B 子代理 include 400 已修（ae9e23c）；C 后端 completed 不关流→终态即登记（e60414d）；D 状态缺失→增量预登记+优雅降级+诊断（e8ed185，**未根治**）；E = 当前阻断。F 非阻断 6 项（V1 模型告警、压缩归属、provider 级压缩约束待裁决、父/子模型分设 API 缺失、重启丢续轮状态、release:freeze 正确阻断）。

离线 133 suites / 1289 tests / 0 failed（**旧树离线报告，不是当前真实验收**）。真机已证：Go 派单+续轮重建、官方单轮。未过：官方父多轮工具、原生压缩长会话、完整 Desktop 旅程。

## 7. 执行必须遵守的仓库操作约定（已存在，不另造）

| 约定 | 文件 |
| --- | --- |
| 资源授权门禁（任何下载/安装前本地盘点 + 所有者批准） | `RESOURCE_APPROVAL.md` |
| 零第三方运行时依赖，禁止 npm install；离线四连门禁 | `docs/how-to/deploy-and-rollback.md` |
| 测试白名单/隔离（npm test 只跑 mock；live 需 MG_ALLOW_LIVE_TESTS=1 + 白名单） | `docs/how-to/testing.md` |
| 原版 Desktop 隔离验收（MG_DESKTOP_STATE=/tmp/…、bin/mg-desktop.mjs、sha256 字节级回滚核验） | `docs/how-to/desktop-acceptance.md` |
| Codex 多 provider 隔离（-c 单次覆盖 / -p profile；同线程不能跨 provider 续接） | `docs/how-to/codex-multi-provider.md` |
| 配置三层（gateway.json 基座 / gateway.local.json 私有 / MG_CONFIG_DIR 隔离） | `docs/how-to/deploy-and-rollback.md` |
| V2 产品合同 MG-R001–R012 + N04 历史导出例外 | `docs/product/2026-11-14-owner-scope-v2.md` |

已验证的客户端边界（2026-11-10 实测，Codex CLI 0.167.0 / ChatGPT Desktop 26.1103.32239）：
- 同一 thread 不能换 provider：`codex exec resume` 跨 provider 被拒（`modelProviderMismatch`）。
- Desktop 单实例只有当前 provider：协议支持 per-thread `modelProvider`，但 Desktop 创建线程传 `modelProvider:null`，UI 无 provider 选择器。
- 真实链路 Codex → ModelGate(8789) → Go `deepseek-v4.1-flash` 曾 exit 0（历史证据，当前树需重验）。

## 8. 对执行计划的直接含义

1. **当前日常路径是官方直连**（provider=openai，网关与 CC Switch 都停）。用户报告的"官方套餐普通对话中断"若发生在今天 12:41 之后，则与 ModelGate/CC Switch 无关，属 direct 路径问题（对照 Codex 上游 Issue）；若发生在更早，需向用户确认时间窗与当时接管工具。**T13-A 必须先问清这一点，不得预设经过网关。**
2. `config.toml` 的 `[model_providers.custom]` 指向死端口 15721：任何切到 custom provider 的测试会立即连接失败。三路径对照前必须按隔离手册准备各自配置，不得直接复用日常 config 的 custom 段。
3. 复现 P0-B（官方续轮 400）需要：启动被测树网关（隔离端口）+ 隔离 CODEX_HOME + 官方登录可用 + 真实付费授权。网关停止状态下无法复现。
4. 本机无 CC Switch/Codex 源码：T01/T02 的源码研究走 GitHub tag 网页/raw；整树 clone 需资源申请。二进制侧可审计：deb 解包资源、`~/.cc-switch` 元数据、日志、配置备份。
5. 旧线程素材充足（567 会话文件），R17 可直接选取真实旧线程做只读取证 + 同路径 resume 对照。
6. GUI 状态取证遵守所有者偏好：**禁止把截图回读进模型上下文**；用 AT-SPI 无障碍树、网关日志、stats.json 回执、剪贴板文本作为可审计证据（截图可留存供人审阅，但 AI 不得依赖读图断言）。

## 9. G0 复核命令（只读）

```bash
# 仓库与 SHA
git -C ~/ai/workplace/idproject/model-gateway fetch origin --prune
git -C ~/ai/workplace/idproject/model-gateway rev-parse origin/main HEAD
git -C ~/ai/workplace/idproject/model-gateway status --short
# 服务与端口
systemctl --user status model-gateway.service --no-pager | head -15
ss -tlnp | grep -E ':(8787|8788|8789|15721)\b' || echo 'no gateway/ccswitch listeners'
pgrep -af 'mg-tray|cc-switch|chatgpt' | grep -v grep
# 版本
codex --version; dpkg-query -W cc-switch chatgpt 2>/dev/null
# 配置结构（不输出秘密值；auth.json 只取哈希）
sha256sum ~/.codex/config.toml ~/.codex/auth.json
grep -E '^(model|model_provider|model_reasoning_effort)\s*=' ~/.codex/config.toml
# PR
gh pr list --repo xiaomengxizzh/model-gate --state open --json number,title,headRefName,headRefOid,isDraft
```