# A5 独立质量审计｜ModelGate 修复分支（2026-11-16）

> 文档类型：**独立对抗性审计结论**，不是发布批准，也不是真实模型/桌面验收通过的证明。
> 审计人：A5（独立质量审计）。审计对象：集成分支 HEAD `2bdd7b1c2651a20c4b5a02a7ad503c281972c394`（`fix/mg-a5-audit`，基线 `9a371d3` = `feat/modelgate-ux-v3`）。
> 方法：在独立 worktree 重跑全部指定命令、逐行阅读关键源码与新增测试、密钥扫描与文档诚实性检查。**假设一切声明为假，直到独立复跑/复读证实。** 未连接生产服务、未触碰 `~/.codex`/`config/*.local.json`/运行中的网关（PID 323092）、未调用付费模型、未安装任何依赖、未修改产品代码或任何测试。
> 对照任务书：`origin/plan/modelgate-remediation-20261116:docs/roadmap/2026-11-16-modelgate-remediation-audit-and-start.md`（§0 约束、§3 台账、§7 验收清单）。

---

## 1. 总体裁决（先看结论）

| 维度 | 裁决 |
| --- | --- |
| 离线/源码层交付 | **PASS**（全部门禁与新增测试真实通过，无绕过、无弱化断言） |
| 真实付费/原版 Desktop 验收 | **BLOCKED**（缺额度与授权，按任务书不得宣称通过；所有新文档均诚实标注） |
| `npm run release:freeze` | **FAIL（预期的正确阻断）** —— 因 MG-R006 partial、MG-R009 条件、缺所有者/A5 签收、需重新冻结，**不是** 因 cheat 或篡改证据 |
| 是否发现 CRITICAL/HIGH 缺陷 | **无**。未发现真实安全漏洞、伪造 PASS_REAL、弱化断言或测试声明低于契约的情况 |
| 是否可开 Draft PR | **可以（带强制保留意见）**：仅 Draft，**不得合并/部署/发布**；P0-01 真实关闭与 P0-02 压缩仍 BLOCKED，审批必须由所有者真实写入 |

逐问题裁决见 §3。关键发现与保留意见见 §4。

---

## 2. 命令复跑结果（全部在 HEAD `2bdd7b1` 独立 worktree）

| 命令 | 结果 | 计数 / 证据 |
| --- | --- | --- |
| `npm run check` | PASS (exit 0) | 全部 `node --check` 通过；UI modules 19/19 syntax OK |
| `npm test` | PASS (exit 0) | **suites 127 passed / 0 failed / 0 skipped / 0 timed out / 0 not run**；**tests 1230 passed / 0 failed / 3 skipped**；total 81.9s（manifest 127/selected 127） |
| `npm run contract:check` | PASS (exit 0) | Product contract consistency PASS: 12 requirements, 7 stages, 5 subagent roles |
| `npm run docs:check` | PASS (exit 0) | Scanned 114 files (4 archived skipped); 480 in-repo + 1 anchor + 37 external links; Documentation paths: PASS |
| `npm run gate:v2` | PASS (exit 0) | 9/9 断言通过，含 R006 阻断、stale_evidence、owner_approval、反绕过等 |
| `npm run gate:v2:independent` | PASS (exit 0) | **12/12**；含禁自建压缩、`gpt-6-luna` 唯一父模型、V1 证据逐字节冻结 |
| `npm run gate:audit-diff` | PASS (exit 0) | `base=main merge-base=e7463857 head=2bdd7b1 mode=range files-touched=570`；no unapproved anti-downgrade findings |
| `npm run release:freeze` | **FAIL (exit 1，正确阻断)** | 见下方展开 |

新增测试文件逐个 `node --test` 复跑（全部 exit 0）：

| 文件 | tests | pass | fail | skipped |
| --- | --- | --- | --- | --- |
| `agg-v2-p0-01-shape-trace.test.mjs` | 5 | 5 | 0 | 0 |
| `agg-v2-tool-id-collision.test.mjs` | 6 | 6 | 0 | 0 |
| `agg-v2-explicit-model-guard.test.mjs` | 4 | 4 | 0 | 0 |
| `agg-v2-security-auth-invariants.test.mjs` | 7 | 7 | 0 | 0 |
| `agg-v2-security-discovery-state.test.mjs` | 3 | 3 | 0 | 0 |
| `agg-v2-compaction-resume-investigation.test.mjs` | 18 | 18 | 0 | 0 |
| `agg-desktop-managed-agent.test.mjs` | 8 | 8 | 0 | 0 |
| `ui-v3-admin-unlock.test.mjs` | 5 | 5 | 0 | 0 |
| `ui-v3-managed-journey.test.mjs` | 4 | 4 | 0 | 0 |
| `admin-local-session.test.mjs` | 4 | 4 | 0 | 0 |
| **合计** | **64** | **64** | **0** | **0** |

`release:freeze` 失败原因（逐条核对，**均为正确原因，无 cheat**）：

```
- 冻结后出现非文档改动（必须重新冻结）：.gitignore, CHANGELOG.md, README.md, bin/mg-desktop.mjs,
  scripts/e2e/ui-v3-browser.mjs, scripts/test/offline/admin-local-session.test.mjs,
  scripts/test/offline/agg-desktop-activate.test.mjs, scripts/test/offline/agg-desktop-managed-agent.test.mjs
- MG-R006 用例 native-compaction / post-compact-followup / context-proof / resume 在冻结树未复现，
  缺少所有者/A5 批准（partial-case）
- MG-R009 为条件通过（owner-approval:two-instance-installation-isolation），缺少批准（requirement-form）
- 缺少代码等价冻结批准：1a527c6e → 12cf5d97（覆盖 R002/R003/R005/R012/R006/R004/R001/R007/R008/R009/R010）
- 缺少代码等价冻结批准：51e78e0d → 12cf5d97（覆盖 R011）
```

结论：冻结门禁用真实缺失项阻断，**未**被改成假绿、未篡改 SHA、未代填审批。

---

## 3. 逐问题裁决与证据

### MG-FIX-P0-01（孤立 function_call_output 400）—— PARTIAL：离线 PASS，真实 BLOCKED

- **离线部分 PASS（已独立证实）**：
  - `src/index.js:2075-2083`：第三方目标先 `repairThirdPartyToolCallIds`（只补 `call_id`，不改内容/不丢历史），再由 `firstEmptyToolCallId` 检测；官方目标完全不动。
  - `src/index.js:2103-2122`：无法配对的孤儿 output **仍返回 typed 400**（`third_party_tool_call_id_missing`），零发送、零模型计费。复刻 fixture 命中第 5 项（`agg-v2-p0-01-shape-trace.test.mjs:28-31`）。
  - **未发现任何删除历史、伪造 `function_call`、隐藏 400 的代码路径**。`projectThirdPartyResponsesParams`（`src/index.js:711-745`）只剔除请求参数字段（`stream_options`、`reasoning.context` 等），不是历史 item。
  - `toolHistoryShapeTrace`（`src/index.js:868-895`）仅输出 `index/type/role/name/id存在性/callId存在性` + meta 的 `route/provider/model/reason` 与**已哈希**的 `thread/correlation`；测试用 `*_SECRET_*`、authorization、Bearer、sk- 哨兵验证零泄漏（`agg-v2-p0-01-shape-trace.test.mjs:58-75`）。调用点 `src/index.js:2088-2099` 对会话标识先 `hashId`。**确认不可泄漏正文/凭据**。
- **真实部分 BLOCKED**：实际 Desktop 400 关闭需所有者裁决与真实额度授权。证据文档 `2026-11-16-p0-01-root-cause-and-decision.md:3-4` 明确写“离线/无损部分 DONE；真实 Desktop 400 关闭 BLOCKED”“不伪造 PASS_REAL”。符合约束，**不判 FAIL**。

### MG-FIX-P2-07（合成工具 ID 碰撞/错配）—— PASS

- 代码 `src/index.js:768-848`：先扫描已存在全部 `call_id` 到 `existingIds`，`nextSyntheticId()` 跳过全部已用 ID；output 带真实 id 时优先在未闭合 call 中**精确匹配**，无匹配仅在栈顶为合成 id 且目标 id 未被 call 占用时回填；无法确认关联则保持原样交 guard fail-closed。
- 6 项对抗测试全通过（已有 `call_mg_1` 跳过、从 `call_mg_3` 起、精确匹配不错绑、真实 id 不被覆盖、混合交错唯一、孤儿仍 fail-closed）。测试确实声明了契约的全部要点。

### MG-FIX-P1-03（显式模型静默回退）—— PASS

- 代码 `src/aggregation/api.js:317-339`：显式 `model` 不在目录 → 抛 `DesktopError('requested_model_unavailable', …, 422)`；`mapFailure`（`src/aggregation/api.js:63-68`）按 `error.status` 映射为 422。
- 该检查在 `activationOptions`（:341-353）→ `/activate`（:529-546）的 preview 与写入之前执行，异常被 `catch`（:558-559）拦截，**零配置写入、零模型出站**。
- 4 项测试覆盖：显式 DeepSeek 缺目录 → 422 不选官方 GPT、任意未知 ID → 422、未显式模型保留默认规则、目录中存在的模型正常进入同意流程（不误拒）。

### MG-FIX-P2-08（部分 Provider 未发现误报 complete）—— PASS

- 代码 `src/aggregation/api.js:188-192`：`missing.length>0` 时返回 `state:'partial'`, `complete:false`, `reason:'providers_not_synced'`，仅全部 provider 有 complete 快照才返回 complete（:193-201）。
- 3 项测试含红灯（某 provider 无快照不得 complete）、绿灯（全部 complete 才 complete、`complete:false` 快照报 partial）。

### MG-FIX-P1-04（关闭管理令牌后管理面可操作）—— PASS（含 1 项 LOW 观察）

**CRITICAL 安全审查结论：未发现远程/跨源提权漏洞。** 逐项独立核验：

1. **远程调用者能否取得 local-admin 令牌？不能。** `POST /api/admin/unlock`（`src/index.js:2302-2318`）先做 peer 检查：`!isLoopbackPeer(req) && !remoteManagementAllowed(state)` → 403（`isLoopbackPeer` 在 :314-317 仅接受 `::1`/`127.0.0.1`/`::ffff:127.*`）。远程管理须所有者显式 `allowRemote`/`MG_ADMIN_ALLOW_REMOTE`，属明确 opt-in。
2. **跨源调用者能否取得令牌？不能。** 全局来源校验在 unlock 之前：`hostAllowed`（DNS 重绑定防护，:2263）+ `originAllowed`（:2264-2267, :304-313）。浏览器无法伪造 `Origin`（forbidden header）；跨源页 `Origin: https://evil.example` 与 Host 不符 → 403。`Origin: null` 显式拒绝（:307）。`admin-local-session.test.mjs:82-87` 与 `admin-origin.test.mjs` 在真实 HTTP 层覆盖。
3. **已设置全局令牌时能否仅凭本机连接提权？不能。** `src/index.js:2310-2314`：设了 `state.adminToken` 时 unlock 必须先 `adminOk` 出示它（`admin-local-session.test.mjs:68-80`）。
4. **能否绕过 `explicit_admin_required`？不能。** 入口 `explicitAdminOf`（:333-346）只对全局令牌或有效 local session 返回 `explicitAdmin:true`；`/api/codex/*` 与 `/api/aggregation/*` 入口（:2323-2365）均先 peer→显式管理员→读 body；模块侧 `handleAggregationApi`（`api.js:414-420`）再独立复核 `explicitAdmin===true` 且 `isLocal===true`。
5. **令牌是否记录/持久化？否。** `issueLocalAdminSession`（:358-371）仅写入进程内存 `state.localAdminSessions` Map（32 字节随机 hex，30 分钟 TTL，容量上限 8）；启动处 `localAdminSessions: new Map()`（:3186）→ **重启即失效**。日志只记 `reason` 与哈希 subject，不含令牌本体；测试 `admin-local-session.test.mjs:45-66` 验证日志不含令牌且新进程旧令牌 403。
6. **前端行为**：`ui-v3-admin-unlock.test.mjs` 验证 403 投影显示只读原因+解锁 CTA、解锁令牌只存内存不写 localStorage、无假成功按钮、无死循环。

**LOW-1（信息级，非阻断）**：`/api/admin/unlock` 的成功响应经通用 `sendJson`（`src/index.js:244-246`）返回，未设置 `Cache-Control: no-store`。因端点为回环限定 + POST 语义 + 令牌仅内存存储，实际可被中间缓存的风险极低。建议（非本次必改）为该响应单独加 `no-store`。

### MG-FIX-P1-05（多代理配置与回滚所有权）—— PASS

- 代码 `src/codex/desktop-integration.js`：托管 `go-deepseek.toml` 的快照/备份/原子写/字节校验/冲突（`198-384`）；启用时用户改过该文件在**任何写入前** 409（:1285-1292）；退出时子代理冲突/备份问题在 config.toml 回滚**之前**判定（:1728-1732）。
- `unmanagedFingerprint` 校验（:1606-1608）保证非自有行逐字节不变；`threeWayDiff` 提供三方差异。
- 8 项测试覆盖：空白/既有用户、逐字节恢复、认领既有规范文件、非规范文件 409 绝不覆盖、**用户改动 `[agents.go_deepseek]` → 409 且 config 与子文件均未写入**（测试 `:189-190` 显式断言文件字节不变），崩溃恢复。

### MG-FIX-P0-02（压缩与同子恢复）—— BLOCKED（调查诚实，无网关侧可安全修复项）

- 证据文档 `2026-11-16-v3-compaction-investigation.md:5-15` 明确：根因在 Codex 客户端 0.167.x 限制，真实项（真实 Go + `gpt-6-luna` 父代理原生压缩、同子追派、resume 复用 childId）**全部 BLOCKED**，回环实验仅 `PASS_MOCK`，不得宣称通过。18 项离线调查测试全通过，且未改协议/未放宽断言/未引入 PASS_REAL。
- 文档诚实披露一项**条件性风险（OPEN-1）**：要接受本地压缩产生的标记，Go 路由需显式声明 `codex.history.compaction='preserve'` + `codex.nativeCompaction`；默认路由能力为 `compaction:'reject'`（`src/index.js:1753`）。catalog.js 对缺失声明有明确告警（`src/codex/catalog.js:770`）。该风险取决于**生产 catalog 实际声明**（本审计越界未查），属配置声明问题非协议缺陷，进一步支持 BLOCKED 而非 FAIL。建议 MAIN/所有者在真实验收前核对生产聚合 Go 模型的 catalog 声明。

---

## 4. 发现汇总

- **CRITICAL / HIGH 缺陷：无。**
- **LOW-1**：unlock 成功响应缺 `Cache-Control: no-store`（`src/index.js:244-246`）—— 信息级加固建议，非阻断。
- **OPEN-1（BLOCKED 相关）**：Go 路由 `compaction:'reject'` 默认与生产 catalog 声明的一致性需所有者/MAIN 在真实压缩验收前核对（`src/index.js:1753`；`2026-11-16-v3-compaction-investigation.md` §2.1）。
- **无伪造 PASS_REAL、无弱化断言、无测试声明低于契约**：所有新增测试均使用真实隔离网关（harness 回环 + 临时目录 + 无真实凭据）或纯判定，断言覆盖负向 fail-closed 与正向放行两侧。

---

## 5. 密钥扫描与诚实性检查

- **密钥扫描** `git log -p 9a371d3..HEAD | grep -E 'sk-|ghp_|gho_|AKIA|BEGIN PRIVATE|Bearer [A-Za-z0-9]{30,}'`：**零真实密钥命中**。全部命中均为测试合成哨兵（`sk-synthetic12345678`、`Bearer <token哨兵>`、JWT 示例）与文档脱敏说明文字。
- `git diff --name-only 9a371d3..HEAD | grep -iE 'local.json|auth.json|.env|credential|secret'`：**NONE**。`config/*.local.json`、`auth.json` 内容未进入 diff；仅有“不触碰 auth.json”的声明性注释。
- **诚实性检查**：新 2026-11-16 证据文档对真实项一律标 BLOCKED，明确区分 PASS / PASS_MOCK / PASS_REAL / offline，未出现“整体通过/已发布/已签收/可以发布”的无条件声明。历史 `PASS_REAL`（`3116459` 树、2026-11-14 Luna）均带明确树/时间锚点，未被冒充为当前树结论。

---

## 6. 独立结论：是否可开 Draft PR

**可以开 Draft PR，但必须带以下强制保留意见：**

1. 仅 **Draft**；未获所有者签收 **不得合并、不得部署到生产、不得发布**，PR #7 状态不得改动。
2. 所有离线门禁与 64 项新增测试当前真实通过，可作为“修复已提交 + 离线验收通过”的证据；**不得**据此宣称“真实上游通过/原版 Desktop 通过/已发布”。
3. **P0-01 真实 Desktop 400 关闭**与 **P0-02 原生压缩/同子恢复**保持 BLOCKED，需真实额度/时间窗授权与所有者技术裁决。`release:freeze` 因真实缺失项正确失败，**不得**通过改 SHA、代填审批或放宽断言使其变绿。
4. `v2-release-approvals.json` 的审批必须所有者真实写入；MG-R006 需在**同一最终冻结树**补齐真实证据，MG-R009 形态需所有者选择。
5. 合并前建议处理 LOW-1（响应 `no-store`）与核对 OPEN-1（生产 catalog 压缩声明）。

审计人签字：A5（独立质量审计）｜HEAD `2bdd7b1`｜本结论仅基于本次独立复跑与源码复读，不代表任何真实模型费用已发生或任何发布许可已获得。
