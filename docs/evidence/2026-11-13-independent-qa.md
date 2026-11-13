# 2026-11-13 独立 QA 审计（只读）

- 工作树：`.agents/worktrees/native-delegation`；分支 `feat/modelgate-native-delegation-20261113`；HEAD `f36e1da`；审计开始 `git status --short` 为空。
- 边界：只读审计；未安装依赖、未读 `~/.codex/auth.json`、未调用真实 OpenCode Go/GPT、未 push/merge。本文件是唯一新增文件。
- 证据分级：下文结论均来自本机亲自执行的命令或代码行；未执行项标 UNKNOWN/NOT_RUN。

## 0. 结论

| # | 审计项 | 结论 |
|---|---|---|
| 1 | 认证边界（auth.json/CODEX_HOME/backend-api/local-subscription/三入口 403） | **PASS** |
| 2 | MCP 委派核心不变量（单次写入/DISPATCHED/UNKNOWN/幂等/归属/参数） | **PASS（有 3 个缺口）** |
| 3 | G6 证据自洽（回执 sha256 vs 磁盘 vs task turns） | **PASS（2 个文档级问题）** |
| 4 | 契约 v1-alignment 声称 vs 实现（抽查 12 条） | **PASS（2 条不符）** |
| 5 | 回归门禁 | **PASS** |

## 1. 认证边界：PASS

- `node --input-type=module -e "scanAuthBoundary(...)"` → `violations=[]`，exit 0；`src/codex/local-subscription.js` 不存在。
- 原始 grep 的命中全部不可执行或为护栏：auth.json 20 行（16 行非注释，全部在 5 个白名单护栏/UI 模块 src/codex/{config,api,history}.js、src/ui-next/js/views/{codex,clients}.js，护栏只做 basename 比较，如 src/codex/api.js:367、config.js:53）；CODEX_HOME 2 行均为注释（src/codex/config.js:1130/1168）；backend-api 非注释仅 2 行，均为拒绝/告警文案（src/codex/auth.js:184、src/index.js:2519），无请求路径字面量；local-subscription 仅 1 行注释（src/index.js:27）。
  - 注：任务措辞「全量递归不得出现」按字面不成立（注释/UI 文案仍出现），按生产可执行读取语义成立；静态扫描套件名同样放宽为「护栏白名单除外」。
- 三入口 fail-closed 有回归实证：`node --test scripts/test/offline/codex-p09-native-proxy.test.mjs` → 13 pass / 0 fail / exit 0，含官方原生、第三方原生、官方 Chat 桥各 403 `gateway_subscription_retired` 且 `official.hits/go.hits===0`；`/backend-api/codex/responses` 断言 `official_path_not_allowlisted`。代码侧：src/index.js:1497、2238-2242；src/forward.js:1137-1153；src/codex/target-authz.js:193-207、279-281。

## 2. MCP 委派：三条核心不变量成立，但有缺口

成立：
- 单次写入不重放：src/mcp/delegation-executor.js:158 `noRetry:true`，src/request.js:274-275 `maxAttempts=1`；5xx 用例断言 hits=1。
- DISPATCHED 先落盘：src/mcp/delegation-server.js:180（persist）→183（send）。自建探针在 mock 收到请求时读盘：`dispatchedAt` 已写、状态 RUNNING（RUNNING 也在 send 前落盘，src/mcp/delegation-executor.js:210）；崩溃只会偏保守。
- 重启在途→UNKNOWN 且禁止重发：src/mcp/delegation-store.js:277-295；bin/mg-mcp.mjs:87 启动即 reconcile；UNKNOWN 上 followup 被拒（delegation-server.js:334-336）；同幂等键 delegate 只回放（server.js:263-268）。
- wait 超时不改状态（server.js:312-324，测试断言 state 仍 RUNNING）；ownerRef 归属校验（server.js:137-145，测试含 NOT_OWNER）；工具参数不能指定 url/provider/model/凭据（delegation-contract.js:118-154 + 值级密钥正则，测试拒绝矩阵）。

缺口（本人复现/静态确认）：
- **F1 幂等键明文落盘，违反契约「只存哈希」**：`store.create/appendTurn` 把 `idempotencyKey` 写进 turn 并持久化（src/mcp/delegation-store.js:189、222）。契约 v1 §6.2（docs/contracts/modelgate-mcp-delegation-v1.md:533）与 CHANGELOG 均称明文不落盘。实际 G6 记录 `.mg-e2e/state/tasks/mgtask-be66411758f2ded8.json` 中两轮分别为 `"e2e8a1121-r1"` / `"-r2"`；idem.json 侧确为哈希（`delegate:eded7e16…` 经复算 = idemKeyHash(ownerRef,key)）。即：索引哈希成立，任务记录明文未清理。
- **F2 上游流无终态被记 FAILED，不是契约要求的 UNKNOWN**：src/mcp/delegation-executor.js:266-268 抛 `MCP_UPSTREAM_ERROR` → server.js:229-244 落 FAILED。契约 §5.4（契约:521）要求「上游流中断无终态 → UNKNOWN, reconcileRequired」。自建探针（mock 只发 response.created 后关闭）实测 `state=FAILED`，且随后 followup 成功进入 ADMITTED（UNKNOWN 本应禁止追派）。这是「结果未知必须 UNKNOWN」的真实缺口。
- **F3 重启后 ADMITTED 任务搁死**：reconcile 只处理 DISPATCHED/RUNNING（store.js:282）。探针：占满槽位产生 ADMITTED 排队任务后重建 store/server，同幂等键回放仍为 ADMITTED（不重新派发），followup 返回 `MCP_TASK_STATE_INVALID`，只能 cancel。窗口窄且不会重复执行，但恢复语义不完整。
- 小问题：store.js:291 `from` 恒为 DISPATCHED（RUNNING 也这样报）；alignment 声称的 `reason=upstream_unconfirmed` 未写入 error；契约 T1「task 记录 + 幂等索引同一原子写」（契约:484）实为两次独立落盘（server.js:280-294），但网络发送在两者之后，未观察到重复执行。

## 3. G6 证据一致性：PASS（无 mock 当 real）

- 独立复算：父端回执里的 r1/r2 sha256 = docs/evidence/2026-11-13-g6-receipt.json `files.sha256` = 磁盘 `.mg-e2e/ws/round1.txt`/`round2.txt` 实测 sha256（676adc05… / ecc56fed…，各 22 字节）。
- 用源码 `resultDigestOf` 从落盘 result 重算两 turn digest，与 receipt 的 ae6209f1… / 7fe3ef55… 完全一致；单 sessionRef、toolCallCount 2/6 与 receipt 相符；`modelSeenInEvents=null` 限制如实记录。
- 上游为真实 Go：G6 使用的主仓 config 中 opencodego baseUrl=`https://opencode.ai/inference/go`（非 mock 回环），并有真实 usage/落盘产物佐证。
- 文档级问题（不影响结论）：(a) CHANGELOG.md:5 的「### Verified (real) —— G6」位于首个 `##` 版本标题（CHANGELOG.md:12）之前，且 CHANGELOG.md:35 同一文件写「G6 未执行」，自相矛盾；(b) 父端回执写 `r1_state=RESULT_READY` 而记录为 ACKNOWLEDGED，属 ACK-on-read 时序（wait 返回前未 ACK），但证据文档未解释，易被误读。

## 4. 契约对齐抽查（12 条）

相符 10 条：扁平 workspaceRefs、budgetMs 区间、reasoningEffort low/high/max、未开放 maxResultBytes、taskRef/turnRef/ownerRef 形状、resultDigest 不含 state、DISPATCHED 先落盘、UNKNOWN 禁 followup/cancel、8 并发无排队、单行 1MiB/批处理/初始化门禁「未实现」如实登记。
不符 2 条：(a) alignment §4 把 `MCP_UPSTREAM_PROTOCOL` 列为「已发出」，但全 src 仅 contract 定义处出现 1 次、无产生点（G3/G4 证据 §5 重复该说法）；(b) alignment §5「明文键不落盘」只对 idem 索引成立（见 F1）。

## 5. 回归（本机 Node v24.22.2，亲自执行）

| 命令 | exit | 结果 |
|---|---|---|
| `npm run check` | 0 | 全部 node --check + `check-ui` 16/16 |
| `npm test` | 0 | 79 suites passed / 0 failed / 0 skipped；806 pass / 1 skip / 0 fail；75.0s |
| `npm run docs:check` | 0 | 81 files，316 in-repo / 1 anchor / 26 external，PASS |
| `node scripts/check-metadata.mjs` | 0 | 39 checks PASS |
| `git diff --check` | 0 | clean |

与 docs/development-plan.md:25-29（79/806/1 skip、75.1s、check/docs/meta/diff 全过）一致。

## 6. 未验证 / 限制

- 真实 Go 取消、超时、429/5xx 注入、真实进程崩溃恢复：NOT_RUN_LIVE（G6 证据 §5 已如实登记；本人未消耗真实额度）。
- G7 Desktop、G8 GUI/发布：未验，不推断。
- 父模型身份：accept 证据文档的「CLI -m + doctor + 目录」三方交叉确认及其限制；未读会话文件。
- 本审计未覆盖管理 GUI 实跑与所有 docs 交叉引用，仅按要求范围。
