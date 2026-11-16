# ModelGate 全量修复交付报告（2026-11-16）

> 本文件是本轮修复的**唯一交付汇总**，以下状态严格区分，绝不合并：
> `代码已提交` / `离线验收通过` / `模拟(PASS_MOCK)` / `真实上游通过(PASS_REAL)` /
> `原版 Desktop 通过` / `所有者已签收` / `已发布`。
> **发布门禁未通过，未合并 main，未部署，未触碰真实凭据/生产服务。**

## 0. 基线与分支

| 项 | 值 |
| --- | --- |
| 修复基线 | `9a371d3`（= `feat/modelgate-ux-v3` = `deploy/modelgate-ux-v3` 同源；审计基准 SHA 一致） |
| 规划文档分支 | `plan/modelgate-remediation-20261116` @ `b79b4b1`（仅多一份任务书，无额外代码） |
| 修复分支 | `fix/modelgate-remediation-20261116`（独立工作树 `.agents/worktrees/fix-modelgate-remediation-20261116`） |
| 子代理工作树 | A2 `fix/mg-a2-compaction`、A3 `fix/mg-a3-desktop-ux`、A4 `fix/mg-a4-security`、A5 `fix/mg-a5-audit`（均从基线派生，文件写集互斥，主代理统一 cherry-pick 集成） |
| PR #7 | 保持 Draft，未改发布状态；本轮修复为独立分支，未并入 #7 或 main |

## 1. 提交清单（按 G0→G6 顺序）

| 提交 SHA | 阶段 | 内容 |
| --- | --- | --- |
| `4d2a83c` | G2 | P1-03 显式模型静默回退→422；P2-08 发现完成态误报 |
| `af6fe8f` | G1 | P0-01 脱敏结构 trace + P2-07 合成工具 ID 碰撞硬化 |
| `278b081` | G4 | A2 原生压缩/同子恢复根因调查 + 协议不变量回归（cherry-pick `778f7b9`） |
| `19fc7ca` | G2/G4 | A4 授权域隔离负向测试 + 安全审计证据 |
| `324952d` | G3 | A3 P1-05 原生多代理配置纳入托管所有权（cherry-pick `85fb47d`） |
| `c24f829` | G3/G5 | A3 P1-04 前端解锁 CTA + V3 用户旅程（cherry-pick `22162bc`） |
| `2bdd7b1` | G3 | P1-04 本机管理会话解锁（服务端半）+ P1-03 测试隔离修复 |
| `de48b05` | G6 | 交付报告（状态分层/证据/阻断/回滚） |
| `2ba7d45` | G6 | A5 LOW-1 令牌响应加 `Cache-Control:no-store` |
| `ee60645` | G6 | A5 独立审计报告（cherry-pick `aa8ba10`） |

## 2. 问题台账：根因 / 修复 / 回归 / 状态

| 编号 | 根因 | 修复方式 | 回归证据 | 状态 |
| --- | --- | --- | --- | --- |
| MG-FIX-P0-01 | Codex 发孤儿 `function_call_output`（无前序 call、无 call_id），第三方便携 Responses 要求非空 call_id → typed 400 | 补最小脱敏结构 trace（`toolHistoryShapeTrace`）+ 400 守卫；**真实根因未确证，未做有损修复** | `agg-v2-p0-01-shape-trace` 5/5 | 离线 DONE / 真实 **BLOCKED** |
| MG-FIX-P0-02 | 冻结树压缩 3 次未触发 + resume 新建 childId = **Codex 客户端版本边界**（短会话 token 不达阈值 / resume 跨版本不稳定），非网关缺陷 | 不自建压缩；锁定协议不变量；呈报客户端限制 | `agg-v2-compaction-resume-investigation` 18/18 | 离线 DONE / 真实 **BLOCKED** |
| MG-FIX-P1-03 | `pickModel` 对显式请求但目录缺失的 model 静默回退默认/首项 | 显式 model 不在目录 → 422 `requested_model_unavailable`，零写入/零出站 | `agg-v2-explicit-model-guard` 4/4 | **离线 PASS** |
| MG-FIX-P1-04 | `needAuth=false` 时管理面 403，GUI 无法退出聚合 | 本机管理会话解锁（回环+同源、纯内存、30 分钟、重启失效）+ 前端解锁 CTA | `admin-local-session` 4/4 + `ui-v3-admin-unlock` 5/5 | **离线 PASS** / 真实 GUI **BLOCKED** |
| MG-FIX-P1-05 | `[features].multi_agent`/`[agents.go_deepseek]`/`go-deepseek.toml` 为手工新增，退出不清理 | 纳入 ModelGate 托管：启用写规范字节、退出字节级回滚、用户改动→409 | `agg-desktop-managed-agent` 8/8 + `ui-v3-managed-journey` 4/4 | **离线 PASS** / 真实 Desktop **BLOCKED** |
| MG-FIX-P1-06 | V3 开发/部署树与 V2 冻结门禁不同基线 | 修复分支重建在最新 V3 树；现有证据原样保留；本轮证据独立绑 SHA | 本报告 + 各提交 | **代码 DONE** / 发布 **BLOCKED** |
| MG-FIX-P2-07 | 合成 `call_mg_N` 可能与已有 ID 碰撞；output 自带 id 时盲取栈顶错绑 | 合成 ID 避开所有已存在 ID；按 call_id 精确配对；回填查占用；孤儿 fail-closed | `agg-v2-tool-id-collision` 6/6 + `agg-v2-third-party-params` 回归 6/6 | **离线 PASS** |
| MG-FIX-P2-08 | `discoverySummary` 在 provider 缺快照时仍报 complete | 缺快照 → `partial`/`complete:false` + `missingProviders` | `agg-v2-security-discovery-state` 3/3 | **离线 PASS** |
| MG-FIX-P2-09 | 单实例多租户形态未实现，R009 仅双实例验收 | 不擅自扩成多租户平台；保留双实例证据，交所有者选形态 | 现有 `agg-tenant-isolation` 等 | **交所有者裁决** |

## 3. 测试与门禁结果（真实命令 + 计数）

在 `fix/modelgate-remediation-20261116` @ `2bdd7b1`（A5 追加前）执行：

| 命令 | 结果 |
| --- | --- |
| `npm run check` | EXIT 0；19/19 UI 模块语法 OK；全量 `node --check` 通过 |
| `npm test` | **127 suites passed / 0 failed / 0 skipped**；**1230 tests passed / 0 failed / 3 skipped** |
| `npm run contract:check` | PASS（12 需求、7 阶段、5 子代理角色） |
| `npm run docs:check` | PASS（113 文件、518 链接） |
| `npm run gate:v2` | PASS（反绕过自证，非发布批准） |
| `npm run gate:v2:independent` | PASS（12/12） |
| `npm run gate:audit-diff` | PASS（range，562 文件，无未授权反降级） |
| `node scripts/e2e/ui-v3-browser.mjs`（自启隔离 Chrome，无安装） | **11/11 PASS**，3 视口截图；纯 UI 断言（PASS_MOCK 级，非真实推理） |
| `npm run release:freeze` | **EXIT 1 / BLOCKED**（正确原因：MG-R006 四项 partial、MG-R009 条件通过、缺等价冻结与所有者/A5 批准；**未改 SHA 作弊**） |

本轮新增/独立运行的离线套件（不在 `npm test` 固定 manifest 内，逐文件运行）：
`agg-v2-explicit-model-guard` 4/4、`agg-v2-security-discovery-state` 3/3、
`agg-v2-p0-01-shape-trace` 5/5、`agg-v2-tool-id-collision` 6/6、
`agg-v2-security-auth-invariants` 7/7、`agg-v2-compaction-resume-investigation` 18/18、
`agg-desktop-managed-agent` 8/8、`ui-v3-admin-unlock` 5/5、
`ui-v3-managed-journey` 4/4、`admin-local-session` 4/4 —— **合计 64 用例全通过，0 失败**。

## 4. 真实 / 模拟 / 离线 分层

- **真实上游通过（PASS_REAL）**：本轮**0 项**。历史 V2 的 12 行 PASS_REAL 属旧采集树，不继承到本树。
- **原版 Desktop GUI 真实验收**：本轮**0 项**（无付费授权；浏览器 E2E 是隔离 mock 数据下的 UI 断言）。
- **模拟/回环（PASS_MOCK）**：V3 浏览器 E2E 11/11；既有 `agg-v2-real-client-compaction` 等历史 mock 证据。
- **离线（DONE）**：§3 全部离线套件 + 新增 64 用例。
- **BLOCKED（需授权）**：真实 Go DeepSeek 推理、真实 `gpt-6-luna` 父→Go 子派单、真实原生压缩/同子 resume、真实 Desktop 工具往返、真实 GUI 启停/回滚。

## 5. 安全与合规自查

- 密钥扫描：`git log -p 9a371d3..HEAD` 对 `sk-`/`ghp_`/`gho_`/`AKIA`/`BEGIN PRIVATE`/长 Bearer = **0 命中**。
- 无 `config/*.local.json`、`auth.json`、真实凭据值进入提交。
- 真实 `~/.codex`（config.toml / go-deepseek.toml / 备份）、`config/gateway.local.json`、生产服务（PID 323092，127.0.0.1:8787）、`main`/`deploy` 分支：**均未触碰**。
- 本机管理会话令牌：纯内存、不落盘、不写日志、重启即失效；解锁端点受回环+同源/Host+（有全局令牌时）令牌校验约束；不放宽远程/跨源（见 `admin-local-session` 4/4）。
- 脱敏 trace 只记录结构（type/role/name/id/call_id 存在性 + 哈希关联 + route），不输出正文/凭据（见 `agg-v2-p0-01-shape-trace`）。

## 6. 独立 A5 审计

> 待 A5 在其独立工作树完成审计后，追加审计报告 SHA 与结论。A5 结论以
> `docs/evidence/2026-11-16-a5-independent-audit.md` 为准，本节仅引用其 SHA/verdict。

- A5 工作树：`fix/mg-a5-audit`（审计对象 HEAD `2bdd7b1`），报告 cherry-pick 到本分支 `ee60645`
- A5 报告：`docs/evidence/2026-11-16-a5-independent-audit.md`
- A5 独立结论：离线/源码层 **PASS**（全部门禁与 64 新增用例真实通过，无绕过/无弱化断言）；真实付费/原版 Desktop **BLOCKED**；`release:freeze` **正确 FAIL**（非 cheat）；**无 CRITICAL/HIGH 缺陷**。
  - 逐项：P0-01 PARTIAL（离线 trace+ID 硬化真实完成；真实 400 关闭 BLOCKED）、P2-07 PASS、P1-03 PASS、P2-08 PASS、P1-04 PASS（含安全边界逐行复核，无提权/跨源/日志泄漏漏洞）、P1-05 PASS、P0-02 BLOCKED。
  - A5 LOW-1（解锁令牌响应缺 `Cache-Control:no-store`）已由本分支 `2ba7d45` 修复并加断言。
  - A5 OPEN-1（Go 路由默认 `compaction:'reject'` vs 生产目录声明）支撑 P0-02 BLOCKED，非 FAIL；真实压缩验收前须核对生产 catalog 声明（运行时配置，本轮越界未改）。
  - A5 独立就绪意见：**可开 Draft PR，不得合并/部署/发布**；审批须所有者真实写入，不强制 `release:freeze` 变绿。

## 7. 资源费用与回滚

- 模型费用：**0**（本轮无任何真实付费调用）。下载/安装：**0**（复用现有 Node 与本地 Chrome）。
- 回滚路径：本机 Codex 侧 `cp ~/.codex/config.toml.bak ~/.codex/config.toml` + 按需 `rm ~/.codex/go-deepseek.toml`；本修复分支可整体废弃（`git worktree remove` + 删分支），不影响 `main`/`deploy`/生产。
- 生产不变量：本轮所有改动仅在独立工作树/分支；未改任何运行期配置或服务。

## 8. 发布门禁与后续审批事项（未执行）

1. **MG-R006 四项**（native-compaction / post-compact-followup / context-proof / resume）需在同一最终冻结树上有真实证据，或经所有者+A5 明确接受 partial；当前 **BLOCKED**。
2. **MG-R009** 双实例验收形态需所有者批准（或另提单实例多租户方案）。
3. `docs/evidence/v2-release-approvals.json` 仍为空；**不得代填**，仅由真实审批写入。
4. 冻结门禁 `npm run release:freeze` 在获批前保持 BLOCKED，不通过改 SHA/放宽断言绕过。
5. PR 保持 Draft；未获所有者同意不合并 main、不发布、不切生产配置。

## 9. 明确未做/不可宣称

- 不宣称“ModelGate 已完成”：P0-01 真实 400 未关闭（BLOCKED），MG-R006 真实压缩未在本树通过。
- 不把代码完成/模拟通过/真实通过/Desktop 通过/所有者批准/已发布 混为一谈。
- 不删除或改写 V1/V2/UX-V3 历史证据；不安装未授权依赖；不改真实生产。
