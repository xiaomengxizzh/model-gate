# 聚合模式整合报告（2026-11-14）

- **整合分支**：`mg-codex-native`
- **整合起点**：`2f641a975a6345f086aca0d547ab5f0e2523a28c`（五个工作包共同基线，工作树干净）
- **整合者**：主代理（integration engineer）
- **性质**：离线整合与门禁证据。没有任何真实 Desktop / 真实 OAuth / 真实付费模型调用。
  `PASS_MOCK` 不等于 `PASS_REAL`；本报告不上调任何 MG-R 的真实验收状态。

## 1. 合并拓扑

按 A5 → A2 → A3 → A4 → A1 顺序 `--no-ff` 合并；五次合并零冲突。

| 顺序 | 来源分支 | 来源 HEAD | 合并提交 |
| --- | --- | --- | --- |
| 1 | `feat/agg-a5-acceptance` | `9ce870f` | `a0150d2ae90c8ee898c6cc5b02c8381e99106534` |
| 2 | `feat/agg-a2-discovery` | `9e8f908` | `96dded36a33d58cf59df7db3e24b3ab213f01823` |
| 3 | `feat/agg-a3-desktop-ux` | `b3ad2f9` | `7ac52561f976a2e27b136e3a3b5fb29918718e8c` |
| 4 | `feat/agg-a4-auth-isolation` | `f9b9fe2` | `eb4d2ecd09c17a1c949ebe360363ca07050c7358` |
| 5 | `feat/agg-a1-native-team` | `bc47b82` | `91d7bc6c5464f149afe91f36d3b19844f6439e7e` |

合并后整合提交：

| 提交 | 内容 |
| --- | --- |
| `a8ead0c` | `chore(check): 纳入 19 个聚合套件与新增源文件语法门` |
| `33656f9` | `feat(aggregation): 统一 /api/aggregation 入口与 Desktop 集成适配` |
| `e84d139` | `feat(ui): 注册聚合模式视图` |

每次合并后均执行 `npm run check` 与 `npm test`，五次结果都是 exit 0、77/77 套件通过
（782 passed / 1 skipped）。没有堆叠破坏；合并期间未改动任何既有测试断言。

## 2. 套件登记与门禁

`scripts/test/run.mjs` 显式清单从 **77 → 96**，19 个新套件按字母序插入
`admin-secrets` 与 `boundary` 之间（`agg-*` 在前，`aggregation-acceptance-*` 在后）。

- `node scripts/test/run.mjs --list`：`96 suites (explicit manifest)`
- `node scripts/test/run.mjs agg`：19/19 套件通过，162 passed / 0 failed / 1 skipped
- 全量 `npm test`：96/96 套件通过，**944 passed / 0 failed / 2 skipped**

两个 skip 是声明式跳过，不是通过：

1. A5 矩阵中的 `interrupt` 用例：`NOT_ACCEPTED`（上游 Responses 无 `response.cancel` /
   `response.interrupted`，网关不能证明单一中断终态）。
2. `MG_CODEX_VERIFY=1` 才运行的真实 CLI 解析用例。

`package.json` 的 `check` 链只增不减：新增 `node --check` 覆盖 A1/A2/A3/A4 全部新源文件
（`src/codex/native-*.js`、`src/codex/desktop-integration.js`、`src/subscription/domain.js`、
`src/tenancy/*.js`、`src/aggregation/*.js`、`src/providers/opencode-console.js`、
`scripts/aggregation-probe.mjs`）以及本次适配器 `src/aggregation/api.js`。UI 侧由
`scripts/check-ui.mjs` 覆盖（17/17 模块）。

## 3. 最终门禁结果

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm run check` | 0 | 语法检查全通过；`UI modules: 17/17 syntax OK` |
| `npm test` | 0 | 96/96 套件；944 passed / 0 failed / 2 skipped；71.3s |
| `npm run docs:check` | 0 | Documentation paths: PASS |
| `node scripts/check-metadata.mjs` | 0 | `Metadata: PASS (39 checks)` |
| `node scripts/check-product-contract.mjs` | 0 | 12 requirements / 7 stages / 5 roles 一致 |

默认单操作员路径的行为未变：合并前 77 个套件在最终树上全部仍通过，且 A4 的授权收据只在
配置里存在 `modelgate.aggregation.provider/1` 记录时才启用（见 §5）。

## 4. 适配器决策（`src/aggregation/api.js`）

A2 的工厂签名是 `handler(req, body, ctx)`，返回 A2 自己的响应形状；A3 的 GUI 按 ADR-0003 §5
写死了另一套形状。适配器**没有改 A2 模块，也没有改 A3 期望**，只在边界做投影：

- `isAggregationApiPath` / `handleAggregationApi({method,path,cfg,log,rawBody,explicitAdmin,managedRoot,isLocal})`
  按要求导出；非聚合路径返回 `null`。
- 先鉴权后解析 body：`explicitAdmin !== true` → 403；`isLocal !== true` → 403；非法 JSON → 400。
- `GET /health`：`desktop.status()` + `desktop.detect({disableExec:true})`，输出
  `{ok,mode,reason,needsRestart,detect,backup,activation:{appliedSha,lastApply,needsRestart}}`。
  `disableExec` 避免健康检查触发子进程探测。
- `GET /providers`：注册表记录 + 发现缓存投影出
  `{id,kind,baseUrl,modelCount,authorizedCount,discoveryState}`；从未同步时计数为 `null`
  而不是 0（“未知”不等于“没有”）。
- `POST /providers`：A3 发 `kind=console|go` 与 `configVersion`，A2 只接受
  `opencode-console|opencode-go` 与 `version`。适配器做别名映射（`console→console` 段，
  `go→opencodego` 段，保持已发布 ID），并把 `configVersion` 映射为 A2 的 `version`。
  自定义 ID 原样交给注册表，由注册表给 typed 错误，不静默改名。
- 版本冲突：A2 把 `currentVersion` 放在 `details` 里，适配器提升到顶层，满足 GUI 的
  `409 {code:'version_conflict', currentVersion}`。
- `POST /providers/:id/sync`：A2 发现/同步后，适配器再调用 `publishAggregatedCatalog`。
  发现成功但发布失败返回 502 + 稳定 `code`，`changed` 与诊断原样带回，不谎称已可用。
- `GET /models`：优先用发现快照返回 §3 记录（含 `authorized:false` 供诊断）；
  无快照但有已发布目录时退化为只读目录投影，`evidence.source='published_catalog'`。
  `discovery` 汇总保持 `complete/partial/failed/unknown` 与 `upstreamConfirmedEmpty` 语义。
- `GET /diagnostics`：把每供应商快照/最近失败/未同步与目录 generation 展平成
  `{diagnostics:[{level,code,message,at}]}`；不含 token、cookie、`auth.json` 内容。
- `POST /activate`：无 `consentToken` → `preview()`；`preview.ok=false` → 422
  `{code,blocked,preview}`；可预览 → 428 `{code:'consent_required',preview}`。
  带令牌 → `activate()`，`DesktopError.status` 原样映射，`detail` 原样透传（GUI 需要
  `detail.threeWay`）。目录路径只取服务端已发布 `current.json`，绝不接受客户端路径。
- `POST /deactivate`：`deactivate({expectedSha})`；409 的 `detail.threeWay` 原样返回。
- 所有未知路由 404 `aggregation_route_unknown`；未知异常落到稳定的
  `aggregation_internal_error`，不返回泛化 500 文本。

A2 的 `activate`/`deactivate` handler 只会把结果包成 200、把 `DesktopError` 变成 500，
无法表达 422/428/409；适配器因此直接调用 A3 的 Desktop 集成，而不复用这两个 handler。
其余写路径（providers 增删、同步）复用 A2 handler 的校验与事务。

## 5. `src/index.js` 接线

- `/api/aggregation/*` 块按相邻 `/api/codex/*` 块逐行镜像：Host/Origin 已由全局层校验 →
  回环或显式 allowRemote → `explicitAdminOf` → 读 body → `handleAggregationApi` → `sendJson`。
  未设置管理令牌时没有回环放行，403 `explicit_admin_required`。
- A4 的四个符号（`resolveUpstream`、`assertResolvedUpstream`、
  `assertNoSubscriptionCredentialToThirdParty`、`authFailureReceipt`）在合并后的
  `src/codex/target-authz.js` 中确实存在。仓库里**没有** A4 声称的精确 `src/index.js`
  补丁（`git grep` 全部分支/历史无命中），因此按真实代码实现为“聚合模式下才启用”的
  发送前收据：域/host/path/模型一次定型，实际 URL 必须与收据一致，订阅头不得进入
  非订阅上游；401/403 记录终态收据且不重试/不换域。
- 该收据闸门只在配置中存在 `modelgate.aggregation.provider/1` 记录时运行；默认单操作员
  配置不启用，既有 77 个套件在最终树上全部通过即为行为不变的证据。

## 6. UI 注册

- `src/ui-next/app.js`：新增 `aggregation` 视图导入与 `views` 映射。
  （任务书写的是 `src/ui-next/js/app.js`，实际文件是 `src/ui-next/app.js`。）
- `src/ui-next/js/router.js`：`{ id:'aggregation', label:'聚合模式', title:'聚合模式' }`。
- `src/ui-next/index.html`：在 `clients` 后新增 `data-route="aggregation"` 导航按钮，
  SVG 与既有按钮同构。
- `scripts/test/offline/ui-next.test.mjs`：`ASSETS` 增加 `/ui-next/js/views/aggregation.js`。
- `src/ui-next/js/api.js` 无需改动：视图只用 `request`，既有导出已足够。

## 7. 与专家报告不一致的事实

1. **A3 声称的 `src/index.js` 精确接线块不存在**。`feat/agg-a3-desktop-ux` 的文件变更里没有
   `src/index.js`，全部分支与近 200 个历史提交也搜不到 `handleAggregationApi` /
   `isAggregationApiPath`。UI 里“见交付报告中的精确补丁”的指引没有对应产物；接线由整合者
   按相邻 `/api/codex/*` 块重写。
2. **A3 的 `app.js` 路径与任务书不一致**：实际是 `src/ui-next/app.js`，不是
   `src/ui-next/js/app.js`。
3. **A2 handler 签名与任务书契约不同**：实际是 `(req, body, ctx)`，不是
   `{method,path,cfg,...}`；`health`/`providers`/`models`/`diagnostics` 的响应形状也与 GUI
   契约不同（例如 health 返回 providers/published，而不是 detect/backup/activation）。
   这是适配器存在的原因。
4. **A2 注册表与 A3 表单的枚举不一致**：A3 发 `kind=console|go`，A2 只接受
   `opencode-console|opencode-go`；A3 的 ID 占位符 `opencode-console` 会被 A2 的固定段规则
   拒绝；A3 发 `configVersion`，A2 读 `version`。适配器只做别名归一，不改变注册表的
   已发布 ID 规则。
5. **A2 的错误形状把 `currentVersion` 藏在 `details` 下**，GUI 读顶层；适配器提升。
6. **A4 声称的 `proxyOfficialResponses` 精确 diff 不存在**于其分支或历史；四个符号存在，
   但调用点必须按真实代码设计。A4 只在副本上验证过。
7. **A3 的 `activate()` 忽略 `MG_DESKTOP_GATEWAY`**（`detect()`/`preview()` 会读），
   适配器始终显式传 `baseUrl`，避免同一请求内探测与写入指向不同实例。
8. **A5 的基线门禁 `ready:false` 是在 `2f641a9` 上测的**，当时 A2/A3 实现尚不存在；
   本次合并后实现已落地，但门禁结论仍不能被离线结果上调（见 §8）。

## 8. MG-R 诚实状态（整合后）

| 需求 | 状态 | 依据 |
| --- | --- | --- |
| MG-R001 | `PASS_MOCK` | 一键接入/退出、428 预览、409 冲突、回滚均有离线测试；未在真实 Desktop 执行 |
| MG-R002 | `PASS_MOCK` | 授权域与订阅收据离线测试通过；真实登录身份/额度未验证 |
| MG-R003 | `PASS_MOCK` | 发现/分页/目录 fixtures 通过；真实 Console/Go 目录未对账 |
| MG-R004 | `NOT_TESTED` | GUI 视图与接口已就绪；原版 Desktop 选择器未实际操作 |
| MG-R005 | `PASS_MOCK` | 原生协议单元与生命周期离线测试通过；真实父子线程未验证 |
| MG-R006 | `NOT_TESTED` | `interrupt` 用例 `NOT_ACCEPTED`；不能宣称保留中断终态 |
| MG-R007 | `PASS_MOCK` | 预览/备份/原子写/回滚离线测试通过；未做空白安装与已有配置的真实 GUI 演练 |
| MG-R008 | `PASS_MOCK` | 无静默降级反向用例离线通过；真实产品路径未执行 |
| MG-R009 | `PASS_MOCK` | 默认关闭的租户原语与隔离用例通过；第二真实身份未创建（授权项） |
| MG-R010 | `PASS_MOCK` | 回滚与中断恢复离线用例通过；可丢弃实例演练未做 |
| MG-R011 | `PASS_MOCK` | 本报告提供 SHA/命令/结果/模拟标签；仍缺真实目标回执 |
| MG-R012 | `BLOCKED` | 无所有者授权的 GPT-6 Luna 额度与时间窗；不代换模型 |

## 9. 未做与边界

- 未 push、未开 PR、未合并 `main`、未打 tag、未发布。
- 未触碰其他 worktree；五个专业工作树保留。
- 未杀死任何进程（PID 551774、18787 网关、ChatGPT Electron 均未操作）；冒烟网关使用
  独立临时 HOME / `MG_CONFIG_DIR` / 端口 18999，并由 `timeout` 自行退出。
- 未读写 `~/.codex/auth.json`；未写用户真实 `~/.codex/config.toml`
  （其 mtime 保持 `2026-11-14 12:59:20 +0800`）。
- 未安装、未下载、未联网调用真实模型、未做真实 OAuth。
- 未修改 `docs/product/*`、`docs/roadmap/*` 或 MG-R001..MG-R012 的任何措辞；未弱化任何测试。
