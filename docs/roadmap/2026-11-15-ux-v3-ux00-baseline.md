# UX-00｜前端 V3 代码审计、状态机与测试基线（2026-11-15）

> 阶段：V3 执行计划 UX-00（**不含产品界面重写**）。
> 基线：`origin/mg-codex-native@708cf5e803fed27517caf8639af1bebb28401e04`（"docs(ux): complete V3 execution plan"）。
> 开发分支：`feat/modelgate-ux-v3`（从上述 HEAD 新建，独立工作树；`mg-codex-native` 冻结点、PR #7、历史回执未改动）。
> 契约：[产品状态投影与模块契约](../contracts/ui-v3-product-status.md)（`mg-ui-product-status/1`）。

## 1. 执行前现场核对

```bash
git rev-parse origin/mg-codex-native   # 708cf5e8...（本地 mg-codex-native 曾落后到 e337f4a，已 fetch 校正）
git rev-parse --abbrev-ref HEAD        # feat/modelgate-ux-v3
git status --short                     # 空（无遗留未提交改动）
```

- 实际远端 HEAD 与计划中 "基线 e337f4a" **不一致**：计划提交本身在 `708cf5e`，因此以 708cf5e 为准，计划文档设计不变。
- 未创建/未合并任何 PR；未触碰 `main`（`6bc6441`）、`docs/evidence/v2-frozen-sha.txt`、`v2-release-approvals.json`。

## 2. 基线门禁实测（改动前，同一提交）

```bash
npm run check          # PASS：全部 src 模块 + UI modules 17/17 syntax OK
npm run docs:check     # PASS：104 files / 482 links
npm run contract:check # PASS：12 requirements / 7 stages / 5 subagent roles
npm test               # PASS：119 套件 / 1135 用例 / 0 失败 / 2 用例级 skip（81.5s）
```

结论：基线绿。后续任何回归均可与该数字对比（`119 suites / 1135 tests`）。

## 3. 代码审计结论（决定后续阶段的真实约束）

| 观察 | 事实（本次核对） | 影响 |
| --- | --- | --- |
| 首页与聚合页各读一套数据 | `app.js` 每 15s 静默刷 `/api/status`；`views/aggregation.js` 自己持有 `AGG` 快照与 `AGG.fetched` | 同一页面上"未配置上游"与"聚合已启用"可同时出现 → UX-04 必须统一快照 |
| 路由是平铺 7 项 | `js/router.js` 无分组、无 `connections` | UX-01 需加分组与 `connections`，且旧深链不可丢 |
| 首页是开发者仪表盘 | `views/dashboard.js` 首屏 4 个指标卡 + 趋势/健康/路由分布表 | UX-01 需改为状态驱动首屏，技术指标迁至 `observability` |
| 聚合向导要求 4 个技术字段 | `views/aggregation.js` 弹窗含 id/kind/baseUrl/apiKeyEnv，默认 kind=console | UX-02 收敛为"只填 Key"，后端需 preset 透传 |
| 后端已支持 preset，但适配层丢弃 | `registry.js:normalizeProviderConfig` 接受 `preset:'opencode-go'`；`aggregation/api.js:normalizeProviderInput` 只挑 id/kind/baseUrl/apiKeyEnv/apiKey/version | 最小后端改动 = `normalizeProviderInput` 透传 `preset`（A2 负责，附离线测试） |
| 内联 Key 一律被拒 | `registry.js` 对 `apiKey/token/secret` 抛 `provider_key_inline_forbidden` | Key 只能走 `POST /api/keys`，且 `doSaveKeys` 要求 keyId 已在 `cfg.providers` 中 → 顺序：注册 provider → 写 Key |
| 无 ChatGPT 登录状态投影 | `/api/status` 无 `official` 字段；登录探测只在请求路径内部使用 | UX-00 增加只读 `official` 投影（`probeLocalCodexAuth`，无 token） |
| 聚合健康面已足够 | `/api/aggregation/health` 返回 `mode/detect(desktop,bundledCli,cli,restart,state)/backup/activation` | 首页/连接页可据此判定 Codex 与聚合状态，无需新端点 |
| 404 语义已存在 | `handleAggregationApi` 对未挂载路径返回 `aggregation_route_unknown` / 404 | UI-11 可区分"版本不支持"与"未启用" |
| 测试清单是字面量 | `scripts/test/run.mjs` 显式列出 119 个套件；`runner-selftest` 拒绝未登记/重复/缺失 | 新增测试必须由主代理登记，子代理只提交文件 |
| UI 静态门禁已存在 | `scripts/check-ui.mjs` 自动遍历 `src/ui-next`；`ui-next.test.mjs` 校验资产清单与"无 innerHTML/无凭据持久化" | 新增模块要加入 `ui-next.test.mjs` 的 ASSETS 列表（主代理集成） |

## 4. 本阶段交付（真实代码，非设计稿）

1. `src/ui-next/js/product-status.js`（新增，纯函数）：`deriveProductStatus/nextPrimaryAction/homeStateOf/overallOf/deriveOfficial/deriveGo/deriveCodex/deriveAggregation/classifyAggregationError`。
2. `scripts/test/offline/ui-product-status.test.mjs`（新增，14 用例）：锁定/加载/404/无 Codex/无 Key/未配模型/待启用/需重启/就绪/409/官方登录/不得伪造 verified。
3. `src/index.js`：`GET /api/status` 新增只读 `official` 投影（`probeLocalCodexAuth`，异常 → `unknown`，永不回显 token）。
4. `docs/contracts/ui-v3-product-status.md`：状态机、证据等级、接口来源、写集、错误矩阵。

```bash
node --test scripts/test/offline/ui-product-status.test.mjs   # 14/14 pass
```

## 5. 未验证 / 明确不在本阶段

- **未做**任何真实上游调用（Go/GPT 均未调用）；未发起付费请求。
- **未做**浏览器真实渲染验证；`official` 投影的真实登录文件取值只在本机只读探测范围内验证，跨机器未验收。
- **未做** `npm run release:freeze`（该门禁属于 V2 发布，不因本分支 UI 改动放行）。
- 真实 GPT 测试仍只允许 `gpt-6-luna`，Go 仍只 `deepseek-v4.1-flash`；本轮没有任何真实模型调用。

## 6. 下一阶段依赖

UX-01（A1）/ UX-02（A2）/ UX-03（A2）/ UX-04（A3）/ UX-05（A4）按契约并行；A5 独立验收。共享入口（`src/index.js`、`scripts/test/run.mjs`、`ui-next.test.mjs` ASSETS、`app.js` 集成）由主代理统一落地。
