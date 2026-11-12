# ModelGate 收工交付报告（2026-11-12）

**层级结论：`OFFLINE_RC`（仅内部交接，不是 `RELEASED`）。**

按计划的收工层级：`OFFLINE_RC` / `CLI_NATIVE_ACCEPTED` / `GUI_ACCEPTED` / `RELEASE_READY` / `RELEASED`。当前只达到第一级：G0 全绿、G1 主体落地并全部通过离线门禁；**CLI 原生门（Q03/Q04）因缺少真实授权与环境隔离而阻断，正式 GUI 按计划锁死在 Q04 之后**。没有做任何远端动作（`DELIVERY=LOCAL`）。

## 1. 实际集成身份

| 项 | 值 |
|---|---|
| 集成分支 | `integration/modelgate-release`（隔离 Git 副本，非 daily 工作树的 worktree） |
| 基线 | `2a735fb772c5490222130f5eddc3420bd2dca7bd`（tree `3ae52ba2c685d833638d68cfdc4339f76836a1b8`） |
| 当前 HEAD | 见 §7 收据表最后一行的 SHA/tree（每次集成后刷新） |
| 隔离根 | `/home/xiaomengxizi/ai/workplace/idproject/model-gateway/.mg-release/`（`repo/` 主副本 + `wt/{release,A,B,C,D,E}`） |
| daily 工作树 | **零改动**：仅 `.git/info/exclude` 追加本地 `/.mg-release/`（不入库），`git status --short` 前后逐行相同（4 个原未跟踪项一致） |
| 移植源 | V2 `7afb4dc`（与基线最近共同祖先 `3a4ba89`）；R1 `505890a`（`2c4f2a9`/`28dd25b`/`e57235f` 反向对照）；A1 `2a735fb` |
| 远端 | 只读核对：`refs/heads/main = e7463857`、默认分支 HEAD `dev/gateway-audit-20261108 = 3a4ba89`、`codex-multiagent-v2 = 7afb4dc`。**未 push、未建 PR、未合并、未打 tag、未发 release、未关旧 PR** |

为什么不在 `/home/xiaomengxizi/ai/tmp` 建工作树：本会话文件沙箱只允许写入会话工作区，`/home/xiaomengxizi/ai/tmp` 与 `/var/tmp` 被拒，`/tmp` 是每次调用重置的私有 tmpfs（实测）。因此改为**会话工作区内的独立 Git 副本 + 独立 worktree**，不共享 daily 树的索引/HEAD/工作区。回滚见 §8。

## 2. 启动方式（隔离实例，不碰 8787）

```bash
WS=/home/xiaomengxizi/ai/workplace/idproject/model-gateway
WT=$WS/.mg-release/wt/release
export HOME=$WS/.mg-release/tmp/demo-home TMPDIR=$WS/.mg-release/tmp/demo-tmp \
       MG_CONFIG_DIR=$WS/.mg-release/tmp/demo-cfg MG_KEYS_MASTER=demo-only-synthetic
mkdir -p "$HOME" "$TMPDIR" "$MG_CONFIG_DIR"
cd "$WT"
node bin/mg.mjs doctor --json            # 纯只读、noNetwork:true、无需配置
node bin/mg.mjs --version                # modelgate.cli/1 version 0.2.3 api mg-management/1
node src/index.js                        # 默认端口见配置；如需端口请显式设置，勿用 8787
```

四条标准门禁（纯检出可复现）：

```bash
cd "$WT" && npm run check && npm test && npm run docs:check && node scripts/check-metadata.mjs
```

## 3. 范围覆盖 / 缺口矩阵

| 卡 | 归属 | 状态 | 证据要点 |
|---|---|---|---|
| F00 冻结候选与写集 | Lead | **PASS** | 隔离副本 + ref 冻结 + daily 树零改动 |
| F01 关闭官方原生凭据透传 | A | **PASS** | `native-boundary` 9 断言；`/backend-api/codex` 与旧开关 typed deny；不读登录态 |
| N00 对齐 Node/CI | A | **PASS** | `engines>=24`、CI `['24']`、metadata 39 checks、README 矩阵写实 |
| Q00 审查基线与测试隔离 | E | **PASS（独立签收）** | 两轮一致；隔离七项动态复跑；F01/N00 效果核实 |
| F02 封住配置与 Key 恢复 | A | **PASS** | 截断 keys/config fail-closed、原子锁、SIGKILL 回滚读回 |
| F03 统一发送授权与取消 | A | **PASS** | Responses 旁路封闭、下游头白名单、3xx→502、错误状态表 |
| P01 认证与原生角色判据 | B | **PASS** | ADR-0003 + 四矩阵 fixture；证据边界 `UNKNOWN_PRIMARY_SOURCE` |
| P03 OpenCode Go Provider | C | **PASS** | 入口绑定、版本/授权校验、HMAC 会话头；位形证据未独立复核（已标注） |
| N01 目录/路由授权/客户端出口 | C | **PASS（含接线缺口）** | 快照同代、墓碑零上游、别名 fail-closed；`index.js` pin 未接 |
| P02 V2 请求分类与可读历史 | B | **PASS（模块）/ 接线缺口** | 29 断言；`prepareCodexNativeRequest` 未进生产路径 |
| P07 合成 SIWC 本地原型 | B | **PASS** | 21 断言；默认 off；真实 OAuth 未开启 |
| N03 CLI 管理契约 | C | **PASS** | `bin/mg.mjs` + `mg-management/1` + planId 绑定；doctor `noNetwork:true` |
| N02 路由/限流/预算 | C | **PASS** | 默认 fail-closed 计费；billingPolicy 已由 A 接线透传 |
| P04 工具 identity 与 SSE | B | **PASS（模块）/ 接线缺口** | 30 断言；`createCodexStreamAdapter` 未进生产路径 |
| P05 真实 CLI 离线 V2 夹具 | B | **PASS** | 14 断言；13 case 为 `FIXTURE_PREPARED`，真实运行仍需 egress 隔离 |
| Q01 独立后端回归与性能 | E | **FAIL（分段）** | S1 已覆盖项全绿、无 P0/P1；S2 依赖卡未齐；S3 `NOT_RUN_EGRESS`；S4 多平台未验收 |
| Q02 锁定 CLI 离线候选 | E | **BLOCKED_ENV** | 无 OS 级仅回环约束、Codex 安全启动器缺失（见 `environment.md`） |
| Q03 真实订阅/Go/原生 | E | **BLOCKED_LIVE** | 无 live 授权、无 Platform Key、Go 溢出未证；续跑手册已写 |
| Q04 完整 CLI Gate | Lead+E | **WAITING_GATE** | 依赖 Q03；不得用 OFFLINE_RC 或 Q02 解锁 |
| U01–U07 独立控制台 | D | **WAITING_CLI_GATE（纸面已交付）** | `console-v1.md` 518 行 + 对照 173 行 + 23 个 API GAP；**未写一行 GUI 代码** |
| Q05 管理 GUI 验收 / Q06 Desktop | E | **WAITING_CLI_GATE / BLOCKED_DESKTOP_LIVE** | 未开始 |
| R01 全栈联验与灾难恢复 | A | **NOT_STARTED** | 依赖 Q05/Q06 |
| R02 合并审查与发布收工 | Lead | **PARTIAL（本地产物）** | 本报告 + CHANGELOG Unreleased + PR 文案；未执行远端动作 |

### Lead 侧已知接线缺口（不是卡失败，是共享文件所有权导致的待办）

1. `src/index.js` 接入 `prepareCodexNativeRequest` / `restoreResponseJson` / `createCodexStreamAdapter`（P02/P04）。**当前这些能力只有模块级与夹具级证据，生产请求路径未变。**
2. `src/index.js` 请求入口 pin 一次 `cfg._codexCatalog` 并用 `resolvePinned`（N01）；router 侧已 fail-closed 兜底。
3. `/api/codex/*` 在令牌校验前读 body 的顺序（C 报告的内存/CPU 放大面）；最小改法已记录在台账。
4. `src/budget.js` 默认时钟（墙钟）、`src/sse.js` 流式下游头黑名单语义、探活/媒体/可选端点未统一 `target-authz`。

## 4. 反向用例与安全证据（摘要）

- **官方凭据零外流**：第三方零收到、官方内部目标零发送、302 禁跟随、不读 `auth.json`/`CODEX_HOME`（`native-boundary` 9/9）。
- **上游敏感头零透传**：429 带 `set-cookie`/`x-upstream-secret` → 客户端只拿 `retry-after`（`wiring-e2e` 新 4 用例）。
- **目标漂移/未知发送**：官方目标 userinfo 注入 → `target_userinfo_forbidden` 且零命中；302 → 只发 1 次、落点零命中。
- **配置/Key 半写**：SIGKILL@after_rename_keys → 旧 Key 仍可解密、配置与 Key 同代（`config-transaction` 26 断言）。
- **加密/未知控制项**：不可读密文与未支持关键工具在发送前拒绝，零出网（`codex-v2-responses` 29 断言）。
- **秘密 canary**：日志/事件/收据全链路无 Key 泄漏（`logger-secrets`/`metrics`/`admin-secrets`）。
- **测试隔离**：未知 suite 不执行、环境白名单零宿主 Key 泄漏、回环随机端口、进程组（含孙进程）回收（E 七项动态复跑）。

## 5. 支撑收据

| 收据 | 位置 |
|---|---|
| 执行台账（逐卡时间/角色/SHA/命令/exit/计数/回滚） | `.mg-release/ledger.md` |
| 机器可读状态 | `.mg-release/state.json` |
| 每次集成的四条门禁日志 | `.mg-release/evidence/gates-integrate-*.log` |
| 基线门禁（冻结树） | `.mg-release/evidence/baseline-gates.log` |
| Q00 独立签收 | `.mg-release/evidence/q00-signoff-E.md` |
| Q01 分段判定与 AC 矩阵 | `.mg-release/evidence/q01-signoff-E.md`、`q01-ac-matrix-E.md` |
| R1 反向对照 | `.mg-release/evidence/r1-reverse-control-E.md` |
| 性能方向性基线 | `.mg-release/evidence/p2-perf-baseline-E.md` |
| 隔离审计 / Q02 判决 | `.mg-release/evidence/q00-isolation-audit-E.md`、`q02-env-precheck-E.md`、`docs/evidence/2026-11-12-closure/environment.md` |

**证据边界（必须随结论一起读）**：
- 本机只有 Node 24.22.2：Node 18/20/22 与 Windows/macOS 一律 `NOT_RUN`，不得写成通过。
- 真实 Codex CLI 生命周期、真实订阅、真实 Go 上游、Desktop 全部**未执行**；`CLI_MOCK_PASS` 亦未取得（Q02 `BLOCKED_ENV`）。
- P01 的 CLI 源码结论是二手引用（本机无 rust-0.167.0 源码且禁网），标 `UNKNOWN_PRIMARY_SOURCE`。
- P03 的 Go 端点「现行位形」未独立复核（只用本树历史），live 前必须用厂商文档或有效凭据探针确认。
- 已知 flake：`offline/deadline.test.mjs` AC-4a 在多代理并发满载时偶发 `2!==1`；隔离复跑 3/3 通过，未改测试掩盖。

## 6. 未完成项与重开条件

| 项 | 重开条件 |
|---|---|
| Q02 CLI 离线候选 | 提供可审计的 OS 级仅回环约束（可证 netns / 宿主级阻断，并有「外连失败+回环成功」反向证据）；恢复或替换 Codex 安全启动器（当前 `cli/sandbox/launch` 缺失） |
| Q03 真实订阅/Go/原生 | 用户一次性给齐：账号/工作区、允许的段落、模型 id、次数/并发/费用上限、样本范围、时间窗与出网白名单，并确认 Go Extra Usage 关闭或明确允许溢出。步骤见 `q03-q04-resume.md` |
| Q03 厂商能力 | 若锁定版本不支持把子代理路由到独立 provider，判 `BLOCKED_VENDOR_CAPABILITY`（P01 已给四矩阵与终止条件） |
| Q04 CLI Gate | Q00–Q03 全绿 + `NATIVE_SESSION_PASS`，Lead 与 E 双签；**禁止用 Q02 绿灯或 OFFLINE_RC 解锁 GUI** |
| U01–U07 / Q05 / Q06 | Q04 PASS 后才开工；纸面契约与 23 个 API GAP 已备（`docs/contracts/console-v1.md`） |
| Q01 性能与故障矩阵 | 补 C32 三次采样、300s RSS 斜率、断流/429/中断故障注入；`affinity.mjs` 重写通过后登记 |
| 接线缺口 §3 | 由 Lead 在 `src/index.js` 串行接入并补 e2e；接完需重跑四条门禁 + E 复核 |

## 7. 收据表（最后一次集成）

| 项 | 值 |
|---|---|
| HEAD / tree | FINAL_HEAD_PLACEHOLDER |
| `npm run check` | exit 0 |
| `npm test` | FINAL_TEST_PLACEHOLDER |
| `npm run docs:check` | exit 0 |
| `node scripts/check-metadata.mjs` | exit 0（39 checks） |
| 唯一 skip | `offline/codex-catalog` 的真实 CLI 门控（需 `MG_CODEX_VERIFY=1`），非掩盖失败 |

## 8. 回滚路径

1. **代码**：本线是隔离副本里的 `integration/modelgate-release`，daily 树与 `main` 从未被改动。丢弃方式：`rm -rf <WS>/.mg-release` 并删除 `<WS>/.git/info/exclude` 末尾两行（`/.mg-release/`）。不需要 `git reset`/`checkout`/`clean`。
2. **单卡回退**：每卡一个提交（合并提交可追溯），按卡 ID `git revert <merge>` 即可；`src/index.js`/`package.json`/`run.mjs` 的改动集中在少数集成提交，回退面小。
3. **配置/数据**：本轮没有触碰任何真实配置、Key、历史或 8787；测试全部在 `.mg-release/tmp/*` 隔离目录，跑完即弃。
4. **未来合并回 main**：若合并改变树字节，必须按计划重跑受影响验收并重新绑定证据到新 SHA；不得 force、删 tag 或绕过保护。

## 9. 主线 / PR / 发行状态

- **主线**：`main = e7463857`（只读观察）。本线基线 `2a735fb` 是 main 的后代（领先 149 提交），合并语义上可 fast-forward。
- **PR**：**未创建**（`DELIVERY=LOCAL`）。可直接使用的 PR 文案见 §10。
- **发行**：无 tag、无 GitHub release。旧 Draft #2/#4/#5/#6 **未关闭**（LOCAL 模式不做远端动作）。
- **若改选 `PR_ONLY`**：从本线 push 新分支并建 draft PR（不合并）；**若改选 `FULL_RELEASE`**：还需 G4 全通过、分支保护满足、所有必需 checks 同 SHA 绿，才能合并/打 tag/发 release/交叉引用并关闭旧 Draft。当前 Q03/Q04 阻断，`FULL_RELEASE` 不具备条件。

## 10. 可直接使用的 PR 文案（未执行）

```
标题：feat(integration): 收工闭环 — 官方透传退役、配置/Key fail-closed、发送授权统一、V2 协议与 CLI 管理契约（离线候选）

正文：
- 基线 2a735fb（A1），新增集成线 integration/modelgate-release；定向移植 V2 7afb4dc 的协议能力，不整颗 cherry-pick。
- 安全：官方原生凭据透传退役（F01）；配置/Key 恢复 fail-closed（F02）；发送前授权统一 + 下游头白名单 + 3xx→502（F03）；付费候选无计量拒绝（N02）；Go 会话头 HMAC 域派生（P03）。
- 协议：V2 envelope/有序历史/工具 identity/SSE 适配器/生命周期夹具（P01/P02/P04/P05）；合成 SIWC 预览默认 off（P07）。
- 控制面：bin/mg.mjs + mg-management/1，写操作绑定 planId（N03）；目录同代授权与墓碑（N01）。
- 支持矩阵收敛到 Linux + Node 24（N00）；Node 18/20/22 与 Windows/macOS 未验收。
- 门禁：npm run check / npm test / npm run docs:check / node scripts/check-metadata.mjs 全绿（见 §7）。
- 未完成：src/index.js 接线（P02/P04/N01）、CLI 原生门 Q03/Q04（BLOCKED_LIVE）、Q02（BLOCKED_ENV）、正式 GUI（Q04 后）。
- 本 PR 不代表发布就绪；OFFLINE_RC 仅内部交接。
```
