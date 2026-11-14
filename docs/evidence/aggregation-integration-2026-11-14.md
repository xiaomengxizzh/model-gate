# 聚合模式整合报告（2026-11-14）

- **整合分支**：`mg-codex-native`
- **整合起点**：`2f641a975a6345f086aca0d547ab5f0e2523a28c`（五个工作包共同基线，工作树干净）
- **整合者**：主代理（integration engineer）
- **被测树 SHA**：`a53e4c3decf795667ce5c51aa8cb2c40a51ed8ae`（含 F2/F3、F4、F6 修复与新增回归套件的树；门禁在该树上运行）
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

`scripts/test/run.mjs` 显式清单从 **77 → 96**（19 个聚合套件），整改后 **96 → 98**
（新增 `agg-auth-receipt`、`agg-runtime-reload`），仍按字母序插入
`admin-secrets` 与 `boundary` 之间（`agg-*` 在前，`aggregation-acceptance-*` 在后）。

- `node scripts/test/run.mjs --list`：`98 suites (explicit manifest)`
- 全量 `npm test`：98/98 套件通过，**958 passed / 0 failed / 2 skipped**

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

被测树 `a53e4c3`（含全部修复与新增回归套件）。下表是该树上的实测结果：

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm run check` | 0 | 语法检查全通过；`UI modules: 17/17 syntax OK` |
| `npm test` | 0 | 98/98 套件；958 passed / 0 failed / 2 skipped；72.8s |
| `npm run docs:check` | 0 | `Documentation paths: PASS (81 files, 317 links)` |
| `node scripts/check-metadata.mjs` | 0 | `Metadata: PASS (39 checks)` |
| `node scripts/check-product-contract.mjs` | 0 | 12 requirements / 7 stages / 5 roles 一致 |

默认单操作员路径的行为未变：合并前 77 个套件在最终树上全部仍通过，且 A4 的授权收据只在
配置里存在 `modelgate.aggregation.provider/1` 记录时才启用（见 §5）。

## 4. 适配器决策（`src/aggregation/api.js`）

A2 的工厂签名是 `handler(req, body, ctx)`，返回 A2 自己的响应形状；A3 的 GUI 按 ADR-0003 §5
写死了另一套形状。适配器**没有改 A2 模块，也没有改 A3 期望**，只在边界做投影：

- `isAggregationApiPath` / `handleAggregationApi({method,path,cfg,log,rawBody,explicitAdmin,managedRoot,isLocal,reload})`
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
- 写成功后即时生效（F4）：入口注入 `ctx.reload`（与 `/api/config/reload` 同一个
  `reloadConfig(state)`），适配器把它交给 `createRegistry` 的 `publish` 钩子，
  并在响应里回 `reload:{applied,needsRestart,reason}`。没有注入或重载失败时如实返回
  `needsRestart:true`，绝不谎称聚合模式已在内存中生效。
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
- 收据的 host/path 必须取**实际出站 URL**（`upstreamUrl(prov, upstreamPath)`）的
  `host` 与 `pathname`：`identity.host` 只有主机名（丢端口），`responsesPath` 不含
  `pathPrefix`，两者都会让合法请求被 `send_target_drift` 拒绝（F2/F3，见 §10）。
- `/api/aggregation/*` 的 ctx 额外带 `reload: () => reloadConfig(state)`：这是
  `/api/config/reload` 用的同一函数，聚合写操作复用它把新配置带回内存（F4）。

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

状态词汇只用契约 §2 的五值。`PASS_MOCK` 行必须在「依据」里点名**真实存在且已登记**的离线套件
（`scripts/test/offline/*.test.mjs`），验收矩阵生成器会逐个解析并拒绝不存在的引用。

| 需求 | 状态 | 依据 |
| --- | --- | --- |
| MG-R001 | `PASS_MOCK` | 一键接入/退出、428 预览、409 冲突、回滚均有离线测试（`agg-desktop-activate.test.mjs`、`agg-desktop-rollback.test.mjs`、`agg-desktop-ui.test.mjs`）；未在真实 Desktop 执行 |
| MG-R002 | `PASS_MOCK` | 授权域与订阅收据离线测试通过（`agg-auth-resolve.test.mjs`、`agg-auth-subscription.test.mjs`、`agg-auth-receipt.test.mjs`、`codex-target-authz.test.mjs`）。**部分真实证据已存在但不升级整行**：`official-gpt-6-luna-real` 半边已有请求级真实回执（[真实 Luna 验收](aggregation-real-luna-2026-11-14.md)），而 `codex-official-login-unchanged` 仅观测到运行期间元数据未变，没有登录/登出/切换测试，故整行仍按模拟证据计 |
| MG-R003 | `PASS_MOCK` | 发现/分页/目录 fixtures 通过（`agg-discovery-console.test.mjs`、`agg-discovery-pagination.test.mjs`、`agg-discovery-sync.test.mjs`、`agg-discovery-catalog.test.mjs`）；真实 Console/Go 目录未对账 |
| MG-R004 | `NOT_TESTED` | GUI 视图与接口已就绪；原版 Desktop 选择器未实际操作 |
| MG-R005 | `PASS_MOCK` | 原生协议单元与生命周期离线测试通过（`agg-native-invariants.test.mjs`、`agg-native-capabilities.test.mjs`）；真实父子线程未验证 |
| MG-R006 | `NOT_TESTED` | `interrupt` 用例 `NOT_ACCEPTED`；不能宣称保留中断终态 |
| MG-R007 | `PASS_MOCK` | 预览/备份/原子写/回滚离线测试通过（`agg-desktop-activate.test.mjs`、`agg-desktop-rollback.test.mjs`）；未做空白安装与已有配置的真实 GUI 演练 |
| MG-R008 | `PASS_MOCK` | 无静默降级反向用例离线通过（`agg-auth-leak.test.mjs`、`agg-native-invariants.test.mjs`、`agg-discovery-sync.test.mjs`）；窄证据：两条 no-silent-fallback 负向对照已有真实取证（错误模型 404 `unknown_model` 出站 0、错误凭据 401 `authentication_error` 出站恰好 1、无重试、无 GPT 替换，见 [真实原生验收](aggregation-native-real-2026-11-14.md)），但 unsupported-tool 与 catalog 两例仍非真实路径，整行保持 `PASS_MOCK` / partial，不得外推为整行真实通过 |
| MG-R009 | `PASS_MOCK` | 默认关闭的租户原语与隔离用例通过（`agg-tenant-isolation.test.mjs`、`agg-discovery-catalog.test.mjs`）；第二真实身份未创建（授权项） |
| MG-R010 | `PASS_MOCK` | 回滚与中断恢复离线用例通过（`agg-desktop-rollback.test.mjs`、`config-transaction.test.mjs`）；可丢弃实例演练未做 |
| MG-R011 | `PASS_MOCK` | 本报告提供 SHA/命令/结果/模拟标签，且矩阵与门禁由离线套件自证（`aggregation-acceptance-matrix.test.mjs`、`aggregation-acceptance-audit.test.mjs`）；仍缺真实目标回执 |
| MG-R012 | `PASS_REAL` | 请求级脱敏收据证明上游 `model=gpt-6-luna` 且无其他 GPT 模型/无自动回退（`4feafe0e51dc02d48c45734df5b34e70d3679bd5`，3/3 HTTP 200，见[真实 Luna 验收](aggregation-real-luna-2026-11-14.md)）；订阅域拒绝面的离线不变量由 `agg-auth-subscription.test.mjs` 覆盖 |

> **2026-11-14 政策更正与重跑结果（保留历史事实）**：这次整合没有读写 `~/.codex/auth.json`，那是**当轮政策**的要求，不是技术限制。当时“不复制、不触碰认证材料”的一刀切规则在生效，因此原生父子线程场景没有运行；所有者已于 **2026-11-14** 解除该限制，认证材料可在明确、有界、可审计的授权下读取与备份（[接口 ADR](../architecture/2026-11-14-aggregation-interfaces.md) §10）。**该次重跑已于 2026-11-14 完成**：真实原生父子代理、原生中断与恢复取证见 [真实原生验收](aggregation-native-real-2026-11-14.md)（树 `67b9735`，MG-R005 / MG-R006 实测 `PASS_REAL`）。本表 §8 的 MG-R005 `PASS_MOCK` / MG-R006 `NOT_TESTED` 是整合轮快照，已被较新证据以「取代」标记显式覆盖；历史事实保留不删，当前状态以 [验收矩阵](aggregation-acceptance-matrix.md) 为准。门禁仍为 `ready:false`（R001 / R004 等仍非 `PASS_REAL`）。

## 9. 未做与边界

- 未 push、未开 PR、未合并 `main`、未打 tag、未发布。
- 未触碰其他 worktree；五个专业工作树保留。
- 未杀死任何进程（PID 551774、18787 网关、ChatGPT Electron 均未操作）；冒烟网关使用
  独立临时 HOME / `MG_CONFIG_DIR` / 端口 18999，并由 `timeout` 自行退出。
- 未读写 `~/.codex/auth.json`；未写用户真实 `~/.codex/config.toml`
  （其 mtime 保持 `2026-11-14 12:59:20 +0800`）。
- 未安装、未下载、未联网调用真实模型、未做真实 OAuth。
- 未修改 `docs/product/*`、`docs/roadmap/*` 或 MG-R001..MG-R012 的任何措辞；未弱化任何测试。

## 10. 独立验收缺陷整改（F1–F6）

独立验证者复现的六个缺陷与本次修复（本地提交，未 push）：

| 缺陷 | 提交 |
| --- | --- |
| F2 / F3 | `8a64cd83c3992e8eca6d437c0c71df99d7d8d694` |
| F4 | `45116c55d0b7ba0b9f54f240567ecc4c45d2416c` |
| F6 | `ebfb1d688cb9c293de438605c57fcb7acc1a6f23` |

| 编号 | 缺陷（真实复现串） | 根因 | 修复 | 回归覆盖 |
| --- | --- | --- | --- | --- |
| F2 | `authorized=127.0.0.1 actual=127.0.0.1:18991` → `send_target_drift` | 收据用 `identity.host`（只有主机名），比对的是 `url.host`（含端口） | `8a64cd8`：收据从 `upstreamUrl(prov, path)` 的 host 取实际 authority | `agg-auth-receipt`（非默认端口 + 换 host / 换端口负例 + 端到端） |
| F3 | `authorized=/v1/responses actual=/v1/v1/responses` → 拒绝 | 收据用 `responsesPath`，未合成 `provider.pathPrefix` | `8a64cd8`：同一 URL 的 `pathname` 作为收据路径 | `agg-auth-receipt`（`/inference/go` 前缀、`/v1` 重复前缀、真实不匹配仍拒绝） |
| F4 | `POST /providers` 成功但 `aggregationModeActive(state.cfg)` 仍为 false | 适配器 `createRegistry({log})`，`publish: reload` 是空函数 | `45116c5`：入口注入 `/api/config/reload` 同一个 `reloadConfig`，写成功即重载；返回 `reload:{applied,needsRestart}` | `agg-runtime-reload`（false→true、true→false、未注入/失败时如实 `needsRestart:true`） |
| F1 | 矩阵钉死 `2f641a9` 的 11 `NOT_TESTED` + 1 `BLOCKED`，与本报告 9 个 `PASS_MOCK` 矛盾 | 生成器硬编码 `TESTED_TREE_SHA` 且只读基线证据 | 生成器改为解析证据文档的「被测树 SHA」与状态表；两份证据冲突即生成失败，`PASS_MOCK` 必须点名已登记的离线套件 | `aggregation-acceptance-matrix`（状态来源、SHA 解析、冲突/非法词汇/缺套件均拒绝） |
| F5 | `PASS（本文件）`、`N/A` 不是合法状态词汇 | 证据文档手写状态列 | P01 改为 `PASS_MOCK` / `BLOCKED` 并补原因；生成器拒绝非五值词汇 | 同上（`invalid status` 反例） |
| F6 | UI 说聚合接口未接线、要用户找接线补丁 | 文案停留在接线前 | `ebfb1d6`：说明真实原因（实例版本/未加载模块），渲染条件不变 | `agg-desktop-ui`（禁止过期文案回归） |

当前状态分布（证据文档 → 矩阵，2026-11-14 收尾轮重新生成后）：`PASS_REAL` 3（MG-R005、MG-R006 见
[真实原生验收](aggregation-native-real-2026-11-14.md)，MG-R012 见 [真实 Luna 验收](aggregation-real-luna-2026-11-14.md)）、
`PASS_MOCK` 7、`NOT_TESTED` 1（MG-R004）、`FAIL` 0、`BLOCKED` 0。发布门禁仍为 `ready:false`：R001 / R004 等
仍缺真实目标回执，3 项 `PASS_REAL` 不构成发布条件，也不替代其余需求。

## 11. Responses→Chat 翻译层与按模型协议闸门（本分支实际状态，2026-11-14 收尾轮）

状态以代码为准，不把「递延」写成「未接线」：

- 翻译层模块 `src/codex/chat-compat.js` 已随 `feat/agg-chat-compat` 合入（`1f963ad`），离线套件
  `agg-chat-compat.test.mjs` 已登记进 `scripts/test/run.mjs`（全量 100 套件），单独运行 24 / 24 通过，
  并已纳入 `package.json` 的 `check` 语法链。
- **该模块已被运行时引用**：`src/index.js` 导入 `resolveUpstreamProtocol` / `RESPONSES` /
  `UNSUPPORTED_PROTOCOL`；按模型协议闸门（chat / responses 显式路由、不支持协议显式失败）已在
  `ec630f3` 落地。这是本分支的实际代码状态，不再标记为「未接线」或「递延」。
- Go chat 入口的 `x-opencode-session` 头补齐已在 `46562bd` 落地（`src/request.js`）；此前真实
  400 `MissingSessionID` 的修复已在本分支内。
- **事实性结论（供所有者决策）**：`src/format.js` 已含 chat 侧 `anthropic` / `gemini` 适配器
  （见该文件 `const anthropic`、`Gemini` 段）。因此当前 20 条不可路由模型是被**路由策略**挡住，
  不是缺少翻译实现；是否开放 anthropic / google 路由是产品/策略决定，仍是**本轮未完成**事项。
- **本轮仍未完成**：原版 Desktop GUI 与模型选择器的真实测试、真实 `~/.codex` 激活演练、外部中断
  （Ctrl-C / app-server `turn/interrupt`）、Responses WebSocket、anthropic / google 路由决策、
  第二真实身份。上述能力**不得**因翻译层已合入而被表述为「已上线验收」。
