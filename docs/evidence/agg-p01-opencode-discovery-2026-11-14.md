# A2 / P01：OpenCode 全量发现证据（2026-11-14）

- **角色**：A2 OpenCode Integration Architect
- **分支 / worktree**：`fix/agg-discovery-real-shapes` / `.agents/worktrees/agg-a2-realshape`（探针首次执行于 `feat/agg-a2-discovery` 的 `4feafe0`）
- **绑定提交**：`3d68a80`（注册表 + Console 适配）、`b7027c1`（发现）、`cf14f7a`（目录 + 处理器 + 探针）、`47cca72`（离线用例）、`a5c7173`。
  本文件之后附上 live 探针与真实形状修正的 SHA（见 §7）。
- **需求口径**：`docs/product/2026-11-14-owner-product-contract.md`（MG-R003/R004/R008/R009/R011/R012）与 `docs/architecture/2026-11-14-aggregation-interfaces.md`（ADR-0003）。
- **结论先行**：**MG-R003 仍不是 `PASS_REAL`**。清单端点与形状已由真实调用核对，80 个模型全部发现、无一遗漏；
  但 (a) Go 清单不随凭据变化，账户授权无法证明；(b) 20 个模型（console 14 / go 6）只广告 Anthropic/Google 协议，
  本网关不能路由，只能“发现但不可用”。这两点是产品事实，不是测试缺口——在补齐前不得签收。

## 1. 本轮真正落地的行为

| 能力 | 实现 | 证据 |
| --- | --- | --- |
| Provider 自动入职 | `src/aggregation/registry.js`：写入既有 `gateway.local.json` 的 `providers` 映射，复用 `src/config-transaction.js` 的锁/指纹/原子 rename，推进既有 `configVersion`（过期 409 + `currentVersion`） | `agg-discovery-catalog.test.mjs` 注册表用例 |
| Console 适配 | `src/providers/opencode-console.js`：入口白名单、别名 fail-closed、effort、错误解码、HMAC 会话头、能力新鲜度 | `agg-discovery-console.test.mjs` 9 用例 |
| 全量发现 | `src/aggregation/discovery.js`：游标 + 页码分页、`maxPages` 上限、重复/别名合并、逐模型授权、ETag/Last-Modified、`discovery_complete/partial/failed` | `agg-discovery-pagination.test.mjs` 14 用例 |
| 真实形状对齐 | `limit.context` 主来源、`capabilities{…{supported}}`、`canonical_id→vendorCanonical`、HTML 200 拒绝、`protocol/routable`、Go `authBasis=unverified` | `agg-discovery-realshape.test.mjs` 12 用例 |
| 同步 | `sync(providerId)`：新增/删除/更新；部分失败不覆盖已完成快照；scope 隔离 | `agg-discovery-sync.test.mjs` 7 用例 |
| 目录发布 | `src/aggregation/catalog.js`：经 `catalog-generation` 生成世代 + CAS 原子提交；`assertCatalog`/`assertZeroCollisions`；`mg-opencodego-*` 字节兼容；无权/不可路由模型不发布；溢出写本机全量目录；整代回滚 | `agg-discovery-catalog.test.mjs` 10 用例 |
| HTTP 面 | `src/aggregation/handlers.js`：显式管理员 + 回环 + Host/Origin + `configVersion`；`/models`、`/health` 暴露 `notRoutable` 与授权分档 | 同上「HTTP 守卫」+ realshape 用例 |
| live 探针 | `scripts/aggregation-probe.mjs`，`MG_AGG_LIVE_PROBE=1` 才联网；只打印 counts/IDs | 本文件 §4、§5 |

**没有**接线 `src/index.js`、`src/router.js`、UI、`package.json`、`scripts/test/run.mjs`。

## 2. 可复制命令与结果

逐套件（无需登记，直接跑，均在 `fix/agg-discovery-real-shapes` 上）：

```bash
node scripts/test/offline/agg-discovery-console.test.mjs       # tests 9  pass 9  fail 0
node scripts/test/offline/agg-discovery-pagination.test.mjs    # tests 14 pass 14 fail 0
node scripts/test/offline/agg-discovery-sync.test.mjs          # tests 7  pass 7  fail 0
node scripts/test/offline/agg-discovery-catalog.test.mjs       # tests 10 pass 10 fail 0
node scripts/test/offline/agg-discovery-realshape.test.mjs     # tests 12 pass 12 fail 0
npm run check                                                  # PASS, UI modules 17/17
npm test                                                       # suites 98 passed, 0 failed; tests 958 pass, 2 skip
```

`agg-discovery-realshape.test.mjs` 是新增套件，**未**登记进 `scripts/test/run.mjs`；登记前 `npm test` 不会执行它（需主代理登记）。

## 3. 13 条 API 假设：实测结论

探针（2026-11-14，所有者批准，只读 `GET`）核对结果。**没有任何 chat/completions 或 responses 调用**。

| # | 假设 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | Console 入口 `/console/v1`、`/console/openai/v1`、`/zen/v1` | **WRONG（部分）** | `/console/v1/models`、`/console/openai/v1/models` 返回 **200 text/html**（SPA）；真实清单在 `/zen/v1/models`。模型自述的 chat base 是 `/inference/openai/v1`（+ `/inference/anthropic/v1`、`/inference/google/v1beta`），不是 `/console/v1` |
| 2 | Console 清单 URL = 入口根 + `/models` | **CONFIRMED（仅 zen）** | `https://opencode.ai/zen/v1/models` → 200 application/json，50 条 |
| 3 | Go 清单 URL = `<root>/models` | **CONFIRMED** | `https://opencode.ai/inference/go/v1/models` → 200 application/json，30 条 |
| 4 | 响应形状 `{data:[…]}` 等 | **CONFIRMED** | 两端点均为 `{object:"list", data:[…]}`；适配器报 shape=`data` |
| 5 | 游标分页字段 | **STILL UNKNOWN（未出现）** | 响应无任何 cursor 字段；不触发 |
| 6 | 页码分页字段 | **WRONG** | `?page=2`、`?limit=5`、`?offset=50`、`?per_page=5` 全部被忽略，返回字节相同的 50 条；单页全量 |
| 7 | 模型字段别名（含 `limits.context`） | **WRONG（细节）** | `id` 正确；上下文在 **`limit.context`**（单数 `limit`，另有 `limit.input/output`），原实现读 `limits.context` → 0/80 命中 |
| 8 | 授权字段；缺席按“出现即可用” | **部分成立** | 无授权字段。Console 清单按授权过滤（匿名 86 / 鉴权 50，鉴权集 ⊂ 匿名集）；Go 清单匿名与鉴权**完全一致（30/30）**，因此 “listed⇒授权” 对 Go 不成立 |
| 9 | 能力字段布尔 | **WRONG** | 真实形状 `capabilities.tools={supported:true}`、`reasoning{…}`、`structured_output`、`temperature`、`effort_updates{…}`；布尔读取导致 0/80 识别 |
| 10 | 条件缓存 ETag / Last-Modified / 304 | **WRONG** | 两个端点均无 ETag、无 Last-Modified；304 分支不可达 |
| 11 | Codex 规模上限 512 / 2 MiB | **STILL UNKNOWN** | 未观测到官方限制；实测目录 61 条 / 52,673 B，远低于两者，溢出分支未触发 |
| 12 | Console/Go 是否暴露上下文窗口 | **CONFIRMED（数据存在）** | `limit.context` 对 80/80 为数值（128k…1,050,000）；原实现看不到，现修正 |
| 13 | 429/403 语义 | **PARTIAL** | 401 实测：`{"error":{"type":"authentication_error","message":"Invalid credential"}}`，在解析形状前分类；403/429 未触发 |

**额外发现（探针副产品）**：
- `canonical_id`（console 48/50、go 29/30）是厂商规范名（`deepseek/deepseek-v4.1-flash-1017`），从不等同于清单内 ID；
  旧实现当别名 → 77 条假警告 + 潜在“两模型合并”隐患，已改为 `vendorCanonical`。
- 同一上游 ID 可同时存在于 console 与 go（如 `deepseek-v4.1-flash`），公共 ID 段不同，不构成碰撞。
- 权限矩阵的另一面：console 匿名 86 条、鉴权 50 条，说明“清单即授权”对 Console 是可用的强证据；
  Go 的 30 条两种调用完全一致，属于公开目录，不能当授权证据。

## 4. live 探针：命令与实测结果

隔离方式：`HOME` 与 `MG_CONFIG_DIR` 都在 `/tmp`，provider 只写 `apiKeyEnv`（不落 Key 文件），
未触碰 `~/.codex/config.toml`、`auth.json`，未启停任何进程（所有者网关 PID 551774 未动）。

```bash
MG_AGG_LIVE_PROBE=1 node scripts/aggregation-probe.mjs --provider console    --max-pages 3
MG_AGG_LIVE_PROBE=1 node scripts/aggregation-probe.mjs --provider opencodego --max-pages 3
```

| Provider | 端点 | HTTP | 页 | 发现/唯一/授权 | 不可路由 | 授权依据 |
| --- | --- | --- | --- | --- | --- | --- |
| console | `/zen/v1/models` | 200 application/json | 1 | 50 / 50 / 50 | 14 | listed（清单按授权过滤） |
| opencodego | `/inference/go/v1/models` | 200 application/json | 1 | 30 / 30 / 30 | 6 | **unverified**（清单不随凭据变化） |

协议分布：console = openai 20 / responses 16 / messages 9 / generate-content 5；
go = openai 19 / responses 5 / messages 5 / generate-content 1。

## 5. 真实快照 → 目录发布（对账）

同一份真实快照走 `discovery` → `catalog.publish`：

| 指标 | 数值 |
| --- | --- |
| 发现 | 80（console 50 + go 30），0 重复、0 别名折叠、0 解析失败 |
| 授权 | 80 全部 authorized；其中 30 条 `authBasis=unverified`（Go） |
| 上下文窗口 | 80/80（`limit.context`），`context_window_missing` = 0 |
| 可发布（routable） | 60（console 36 + go 24） |
| 已发布 | **61**（1 条官方基线 + 60）；`standard` 模式，52,673 B，无溢出 |
| 发现但不可路由 | **20**（console 14 + go 6），`discovered_not_routable` 带 count+IDs，未发布、未丢弃 |
| 碰撞 / 重名 slug | 0 / 0（同一上游 ID 跨 provider 段合法） |

修正前：同一路径 `context_window_missing` 直接拒绝发布，0 条聚合模型进入目录。

> 关于 “81”：若 80 个模型全部是 openai/responses 协议，修正后确实发布 81（1 + 50 + 30），
> 这是 §3 假设 7/9/12 的验收口径；真实清单里有 20 条非 openai 协议，因此真实发布数是 61。
> 两个数字都对，差别是协议门禁（「能发现」≠「能调用」）。

### 5.1 20 条不可路由模型：逐条 `api` 键（2026-11-14，两次只读请求）

只导出 `api` 的键与 `base_url` 路径，不含任何 Key 值或账户标识：

| 来源 | 条数 | `api` 键（唯一一个） | 广告的 base URL 路径 |
| --- | --- | --- | --- |
| console | 9 | `messages` | `/inference/anthropic/v1` |
| console | 5 | `generate-content` | `/inference/google/v1beta` |
| go | 5 | `messages` | `/inference/go/anthropic/v1` |
| go | 1 | `generate-content` | `/inference/go/google/v1beta` |

分布：**有 openai 兼容条目 0 条；仅 anthropic 19 条；仅 google 6 条；无 0 条**。
每个受影响模型的 `api` 对象只有一个键，不存在“同时也广告 openai入口”的隐式兼容路径。

结论：`routable:false` **不是悲观分类**。这 20 条要走 Codex 的 Responses API，必须有
Responses↔Messages / Responses↔generateContent 翻译层，属于独立功能；在翻译层落地前，
“发现但不可调用”（计数 + ID 可见）是唯一诚实的中间态。

## 6. 探针本身的安全与边界

- 只读：仅 `GET /models`，未调用 chat/completions、responses，未产生计费推理。
- 未打印凭据：输出只有 counts 与公共/上游 ID；诊断不含 Authorization、账户标识或上游正文。
- 未写用户配置：临时 config 目录 0700，`API key` 只以变量名引用。
- 环境提示：宿主 `https_proxy=127.0.0.1:7897` 且 `NODE_TLS_REJECT_UNAUTHORIZED=0` 是**预先存在**的；
  以 `NODE_TLS_REJECT_UNAUTHORIZED=1` 复测同一请求返回 200，证书链可验证。但流量经过本地代理这一事实需要记录在案。

## 7. 需求状态

| 需求 | 状态 | 依据 |
| --- | --- | --- |
| MG-R003 自动发现全部可用模型并同步 | **PASS_MOCK**（真实发现已验证 80/80，端点与形状已实测；但 Go 授权无法证明、20 条非 openai 模型不可路由，故不得升为 PASS_REAL） | 发现侧 `agg-discovery-pagination.test.mjs`、`agg-discovery-catalog.test.mjs` 通过（新形状套件 12/12，见 §2，未登记故不在此引用）；真实调用见 §4/§5 |
| MG-R004 GUI/Codex 使用聚合模型 | NOT_TESTED | A3/A5 范围 |
| MG-R008 无静默降级 | **PASS_MOCK**（真实形状 + 模块级；GUI 反向验收属 A5） | 失败不返回空目录、200 HTML 显式拒绝、部分页=partial、无权/不可路由不发布但计数、缺上下文 fail-closed、溢出不裁剪；`agg-discovery-sync.test.mjs`、`agg-discovery-catalog.test.mjs` 覆盖；真实形状用例见 §2（未登记）；GUI 反向验收仍待 A5 |
| MG-R009 多用户隔离 | PASS_MOCK（快照/目录 scope） | 两个 scope 独立快照文件与独立目录世代；`agg-discovery-catalog.test.mjs` 覆盖；完整多身份隔离属 A4/A5 |
| MG-R011 真实证据 | **PASS_MOCK**（端点/形状/计数已是真实测量；整体回执仍非 PASS_REAL） | §3 的 13 条假设逐条给出实测结论与证据；`agg-discovery-pagination.test.mjs`、`agg-discovery-catalog.test.mjs` 自证矩阵口径；仍缺真实目标上的端到端回执 |
| MG-R012 仅 GPT-6 Luna | BLOCKED | 本轮没有 GPT 调用，也无所有者授权的额度/时间窗 |

`PASS_MOCK` 永不等于 `PASS_REAL`。要签收 MG-R003，还差两件事：
1. **Go 授权证明**：一次能区分“目录公开”与“账户可用”的调用（例如带凭据的用量/配额端点，或所有者确认该 Key 覆盖全部 30 条）。
2. **非 openai 协议的处置决定**：20 条模型要么在适配器里补 Anthropic/Google 路由，要么由产品明确“本网关只承接 openai 兼容子集”。

## 8. 已知失败与边界

- 无离线失败；`npm test` 的 2 个 skip 是既有门禁项，与本轮无关。
- `catalog-generation` 的 `verified.official/thirdParty=true` 是生成器结构校验标志；本轮记录仍带 `verified.realUpstream=false`。
- 未接线路由、未登记 suite、未推送、未开 PR；均为主代理整合步骤。
