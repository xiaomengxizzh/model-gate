# ModelGate 聚合基线冻结与真实状态清单（P00）

## 1. 目的与范围

本文是 P00 的唯一交付物：在开始并行开发（P01–P06）之前，冻结一个可复核的本地基线，并把「已经有的」「可以复用的」「缺失的」与「真实测试状态」分开记录。

范围仅限本机离线状态：源码工作树、测试清单、门禁命令、进程与隔离状态目录。**不包括**真实 OAuth 授权、真实付费模型调用、原版 Desktop 内的功能验收。

- 基线固定提交（merge commit）：`a9f32c976f5415adb898c31605b362b25d2ee6aa`
- 分支：`mg-codex-native`
- 工作树：`/home/xiaomengxizi/ai/workplace/idproject/model-gateway/.agents/worktrees/mg-codex-native`
- 采集时间：2026-11-14T10:48Z 至 2026-11-14T11:05Z
- 需求口径：`docs/product/2026-11-14-owner-product-contract.md`（MG-R001..MG-R012，本文件不改写其措辞）
- 执行计划：`docs/roadmap/2026-11-14-aggregation-pseudocode-plan.md`

固定提交之后的提交（门禁修复与本文）不属于被测代码，其 SHA 记录在 §5 与 §8。复现本文结论应检出 `a9f32c97`。

## 2. 环境

| 项目 | 值 |
| --- | --- |
| OS | Ubuntu 26.04.1 LTS |
| Kernel | `Linux 7.0.0-43-generic x86_64` |
| Node | `v24.22.2` |
| npm | `11.19.1` |
| git | `git version 2.53.0` |
| Codex CLI 路径 | `/home/xiaomengxizi/.local/bin/codex` → `/home/xiaomengxizi/ai/harness/codex/cli/bin/codex` |
| Codex CLI 版本 | `codex-cli 0.167.0` |
| Codex Desktop 可执行文件 | `/usr/lib/chatgpt/ChatGPT` |
| Desktop 识别方式 | `/usr/bin/chatgpt` 是指向 `../lib/chatgpt/codex-launcher` 的符号链接；实际 Electron 主进程为 `/usr/lib/chatgpt/ChatGPT`（由运行中进程树确认，父进程是 bwrap 包装器） |
| 网关主入口 | `src/index.js` |
| 网关 CLI 入口 | `bin/mg.mjs` |
| Desktop 启动器入口 | `bin/mg-desktop.mjs` |
| 测试运行器 | `node scripts/test/run.mjs`（显式清单，无目录扫描） |
| 套件数（登记 P09 前 / 后） | 76 / 77 |
| 磁盘上的测试文件 | 72 个 `scripts/test/offline/*.test.mjs` + 5 个 legacy 顶层套件 |

零第三方运行时依赖，无构建步骤。

## 3. 工作站状态（仅事实）

采集瞬间：

- PID `551774` 正在运行 `node --use-env-proxy .../bin/mg-desktop.mjs launch`，已持续约 4 小时 11 分，监听 `127.0.0.1:18787`。
- ChatGPT Electron 主进程 `/usr/lib/chatgpt/ChatGPT` 及其 helper 进程在运行，`--user-data-dir=/home/xiaomengxizi/.config/Codex`。
- 隔离状态目录为 `~/.local/state/modelgate-desktop/`（`0700`），内含 `codex/`、`desktop/`、`gateway/` 与 `host.json`。桌面端使用该目录下的独立 `codex/config.toml`，不写用户主目录的 `~/.codex/`。
- `~/.local/state/modelgate-desktop/grant.json` **不存在**（`test -e` 返回未命中）。
- `~/.codex/auth.json` **未被读取**：本次只做了进程与目录列举，没有打开任何凭据文件。
- `~/.codex/config.toml` **未被修改**：其 mtime 为 `2026-11-14 12:59:20 +0800`，早于本轮第一条命令（`2026-11-14 18:48 +0800`）。仅 `stat` 元数据，未读取内容。
- 以上进程在本次作业期间全程存活，未被终止。

## 4. 基线保全的原型清单

P00 开始前工作树有 9 项未提交改动，全部按原样提交，未改写代码。三项保全提交：

| 提交 | SHA | 内容 |
| --- | --- | --- |
| A `feat(codex): ModelGate Desktop 聚合启动器与 SIWC 官方授权原型（保全 WIP）` | `f5a534c3259b7b6b6a37ab64d97a68c18c2331e8` | 见下 |
| B `test(codex): 原生 V1 父代理 fixture 与 --native-v1 e2e 模式` | `0707d901f7b0e07bc801e54a9e6361ce96711fce` | 见下 |
| C `docs(codex): 记录 Desktop 集成进度与 OAuth 阻断` | `f9a272c1b3c2f9e99b747a47d3d0ecd817ab16b9` | 见下 |

逐项说明：

- `bin/mg-desktop.mjs`（A，新增）：隔离状态目录下的 `sign-in` / `configure` / `launch` 三段式入口；父模型 `gpt-6-luna` 走 `chatgpt-plan` provider，子模型 `deepseek-v4.1-flash` 走 OpenCode Go，最后拉起 ChatGPT Desktop。
- `src/subscription/official.js`（A，新增）：公开 Sign in with ChatGPT 的 OAuth 原型（PKCE、动态客户端、`id_token` 校验、`grant.json` 原子写入 `0600`）与 plan credential 读取。
- `src/index.js`（A，修改）：新增 `chatgptPlan` 路由分支——目标 / 本机入口 / 候选数三重 `403` 守卫、`401 chatgpt_plan_sign_in_required`、失败不跨候选重放、`rejectBindFailure` 让绑定失败快速返回。
- `scripts/test/fixtures/codex/native-v1-parent.mjs`（B，新增）：可脚本化的 V1 父代理响应器（首派、工具结果、两次等待、同子追派）。
- `scripts/test/codex-e2e.mjs`（B，修改）：新增 `--native-v1` 模式；工具结果判定同时要求退出码 0 与标记词。
- `CHANGELOG.md`、`docs/README.md`、`docs/development-plan.md`、`docs/reference/configuration.md`（C，修改）：记录 Desktop 集成进度、订阅路由边界入口，并明确应用授权是独立的、默认关闭的本机实验。

原型状态：**未验收**。SIWC token exchange 实测返回 HTTP 403，本机没有 `grant.json`，因此没有完成任何真实授权，也没有发生付费调用。`src/index.js` 的新分支默认不生效（只在配置了 `chatgptPlan` 时进入）。

## 5. 需求初始状态

全部 12 项均未在真实产品路径上验收。下表只记录事实，不做加权或百分比汇总。

| 需求 | 现状 | 证据 | 阻塞项 |
| --- | --- | --- | --- |
| MG-R001 GUI 一键进入/退出聚合模式 | NOT_TESTED | 无 GUI 聚合开关；`src/ui-next/js/views/` 只有 clients/codex/dashboard/models/observability/providers/settings | 缺 P03 的一键流程与状态持久化实现 |
| MG-R002 复用已有 ChatGPT 登录与官方模型 | NOT_TESTED | 离线 P09 用例只用临时 HOME 的合成 `auth.json`，不接触真实登录 | 真实桌面登录身份与额度归属未验证 |
| MG-R003 自动发现 OpenCode 全部可用模型 | NOT_TESTED | `src/providers/opencode-go.js` 只覆盖 Go 单 provider；无发现器 | `src/aggregation/discovery.js` 不存在 |
| MG-R004 原版 Desktop GUI 内使用官方与聚合模型 | NOT_TESTED | 桌面端可由启动器拉起，但未在 GUI 内逐模型发请求 | 需所有者授权在真实 Desktop 内操作 |
| MG-R005 沿用 Codex 原生 Harness 调度父子代理 | NOT_TESTED | `--native-v1` / `--native-v2` e2e 是对真实 CLI 的 opt-in 脚本，本轮未运行 | 需真实 CLI 会话与额度窗口 |
| MG-R006 工具执行/等待/追派/恢复可复核 | NOT_TESTED | 同上；离线仅覆盖协议投影与重放禁令 | 需真实父子线程回执 |
| MG-R007 零手工配置的配置导入/备份/回滚 | NOT_TESTED | `src/config-transaction.js` 有原子写与回滚，但没有 Desktop 一键接入层 | `src/codex/desktop-integration.js` 不存在 |
| MG-R008 无静默降级 | NOT_TESTED | 有离线不变量（未知聚合 ID 404 零上游、失败不换供应商），但不等于产品级反向验收 | 需 P06 独立反向用例 |
| MG-R009 多用户凭据/目录/额度隔离 | NOT_TESTED | 现有隔离是单用户内的 provider 级隔离 | 需第二个测试身份，属授权项 |
| MG-R010 安装/升级/停止不破坏原 Codex 环境 | NOT_TESTED | 当前桌面实验使用独立状态目录，未对用户真实配置做导入/回滚演练 | 需在可丢弃实例上做前后一致性比对 |
| MG-R011 每阶段保留真实证据 | NOT_TESTED | 本文是第一份按 P00 口径产出的证据文件 | 其余阶段的 PASS_REAL 证据尚不存在 |
| MG-R012 真实 GPT 测试仅用 GPT-6 Luna | BLOCKED | 无 Luna 真实调用记录 | 需所有者授权的 Luna 调用额度与时间窗；无资格则保持 BLOCKED，不代换模型 |

## 6. 组件盘点

### existing（已存在且离线可验证）

- `src/codex/`：`identity.js`、`api.js`、`catalog.js`、`catalog-generation.js`、`config.js`、`history.js`、`interop.js`、`local-subscription.js`、`quota.js`、`target-authz.js`、`auth.js`。
- `src/providers/opencode-go.js`：单 provider 适配（Go）。
- `src/subscription/`：`capabilities.js`、`oauth.js`、`session.js`，以及本轮保全的 `official.js` 原型。
- `src/ui-next/`：7 个 view 与控制台骨架（`api.js`/`router.js`/`store.js`/`save-flow.js`/`config-draft.js`）。
- `scripts/test/`：72 个离线测试文件，77 个登记套件，782 个通过用例。

### reusable（可直接复用，不需重写）

- `src/codex/catalog.js` 的构建/序列化，用于聚合模型目录投影。
- `src/config-transaction.js` 的原子写、CAS 发布与整代替换回滚——MG-R007 的基础。
- `src/codex/identity.js` 与 `src/codex/target-authz.js` 的身份/目标边界——MG-R008 的基础。
- `src/routing/ledger.js` 与推理回执——MG-R011 的观测基础。
- `src/ui-next/js/save-flow.js` —— GUI 配置保存与失败回滚的既有实现。
- `scripts/test/run.mjs` 的显式清单、环境白名单与进程树回收——新增测试直接登记即可。

### missing（产品验收必需但当前不存在）

- `src/aggregation/discovery.js`（OpenCode 全量模型发现）。
- `src/codex/desktop-integration.js`（原版 Desktop 一键配置、备份、回滚）。
- GUI 聚合模式视图与状态机（MG-R001）。
- 多用户隔离模型（MG-R009）。
- 可用的真实 `grant.json` 与真实 OAuth 通路（MG-R002 前置）。

### regressed（已确认回归）

- 无。基线前存在两处**门禁漂移**，不是功能回归，已在 §7 修复并复验。

## 7. 门禁结果与已知漂移

在固定提交 `a9f32c97` 上完成两处漂移修复后，5 条离线门全部通过：

| 命令 | 退出码 | 结果 | 关键数字 |
| --- | --- | --- | --- |
| `npm run check` | 0 | PASS | 语法门含 2 个新入口；`UI modules: 16/16 syntax OK` |
| `npm test` | 0 | PASS | `suites: 77 passed, 0 failed, 0 skipped, 0 timed out, 0 not run (manifest 77/selected 77)` |
| `npm run docs:check` | 0 | PASS | `Documentation paths: PASS (74 files, 310 links)`（本文新增前）；加入本文后 `75 files, 310 links` 仍 PASS |
| `node scripts/check-metadata.mjs` | 0 | PASS | `Metadata: PASS (39 checks)` |
| `node scripts/check-product-contract.mjs` | 0 | PASS | `Product contract consistency PASS: 12 requirements, 7 stages, 5 subagent roles` |

测试明细：`tests: 782 passed, 0 failed, 1 skipped (72/77 suites reported node:test counts)`，总耗时 69.6s。

唯一跳过项为测试级 skip，需显式环境开关才会执行：

```
﹣ CLI：真实 codex 可解析生成物（离线，需 MG_CODEX_VERIFY=1） # SKIP
```

### 已修复的漂移

1. `scripts/test/offline/codex-p09-native-proxy.test.mjs` 在磁盘上但未登记进 `scripts/test/run.mjs` 的显式清单——该套件等于从未被执行。已按字母序登记在 `codex-opencode-session.test.mjs` 与 `codex-quota.test.mjs` 之间。登记后直接运行：8 tests / 8 pass / 0 fail（`P09 ...` 全部通过）。套件数 76 → 77。
2. `npm run check` 未对 `bin/mg-desktop.mjs` 与 `src/subscription/official.js` 做 `node --check`。已加入同一链条（`src/subscription/official.js` 接在 `session.js` 之后，`bin/mg-desktop.mjs` 接在 `bin/mg.mjs` 之后）。断言未放宽，检查项只增不减。

### 已知失败

- 无。本基线上没有需要登记的既有失败。

## 8. 合并记录

`origin/mg-codex-native` 领先 12 个提交（全部为治理/文档/契约门）。以真实 merge commit `a9f32c97` 合并，未 rebase、未强推。

预期冲突 `docs/development-plan.md`、`docs/README.md`、`package.json`、`AGENTS.md` 实际**均未冲突**（改动是纯追加，`ort` 策略自动合并）。复核结论：

- `docs/development-plan.md`：本地 2026-11-14 小节保留在最上，远端在文件头新增了产品优先级说明，两者并存。
- `docs/README.md`：本地「订阅路由边界」链接与远端契约/路线图/Agent Team 三个链接并存。
- `package.json`：保留全部本地脚本，并新增 `contract:check`。
- `AGENTS.md`：取远端治理版本（链接产品契约、限制子代理并发、锁定 Luna）。已逐条比对，未与本地规则冲突——"保留既有未提交改动""明确写集""mock 不冒充真实验收"等本地条款仍在。
- 无任何文件因远端删除而丢失本地内容（远端改动为 481 行纯新增）。

## 9. 授权边界（当前阻塞项）

以下事项在获得所有者明确授权前不做：

- 真实 OAuth 授权与真实令牌交换（当前 SIWC 返回 HTTP 403，需要服务地区/工作区政策结论）。
- 任何付费模型调用，包括 GPT-6 Luna 的真实请求（MG-R012 因此为 BLOCKED）。
- 写入用户真实 `~/.codex/config.toml`（本轮只改隔离状态目录）。
- 申请或使用第二个测试身份（MG-R009 前置）。
- `git push`、开 PR、合并 `main`、打 tag、发布。

## 10. 下一阶段

按 `docs/roadmap/2026-11-14-aggregation-pseudocode-plan.md` 的既有编排推进，不新增计划：P01 OpenCode 全量发现（A2）、P02 订阅授权与隔离（A4）、P03 原版 Desktop 自动配置与 GUI（A3）、P04 原生协议/会话/Agent Team（A1）、P05 多用户安全（A4）、P06 独立真实验收（A5），全部完成后由所有者决定是否合并与发布。
