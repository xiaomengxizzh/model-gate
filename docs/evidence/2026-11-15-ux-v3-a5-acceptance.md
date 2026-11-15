# UX-V3 A5 独立验收记录（黑箱 + 浏览器 + 反降级）｜2026-11-15

> 验收人：A5（独立 QA）· 分支 `feat/ux-v3-a5-qa`（基线 `e1beb85`）
> 本文件所在提交即本次证据提交（`git log -1 --format=%H -- docs/evidence/2026-11-15-ux-v3-a5-acceptance.md` 可复核）。
> 相关：[UX-00 独立审查](2026-11-15-ux-v3-a5-ux00-review.md) · [契约](../contracts/ui-v3-product-status.md) · [执行计划](../roadmap/2026-11-15-frontend-experience-v3-execution-plan.md)
> **本轮没有任何真实模型请求**（无付费调用授权）；所有网关都是隔离实例 + 本地 mock/临时目录。状态词严格区分 mocked / real / BLOCKED / NOT_TESTED。
> **R2 复验（集成分支）已追加在 §8**：被测代码 = `1ab9239`（A5 合并提交 `741525c`）；基线截图保留，集成截图带 `-integrated`。

## 1. 交付物

| 交付 | 路径 |
| --- | --- |
| 黑箱验收套件 | [scripts/test/offline/ui-v3-acceptance.test.mjs](../../scripts/test/offline/ui-v3-acceptance.test.mjs) |
| 浏览器验收脚本（零新依赖，Chrome CDP） | [scripts/e2e/ui-v3-browser.mjs](../../scripts/e2e/ui-v3-browser.mjs) |
| 浏览器截图（真实渲染） | [360×800](screenshots/ui-v3-360x800.png) · [768×900](screenshots/ui-v3-768x900.png) · [1440×900](screenshots/ui-v3-1440x900.png) |
| 本记录 + UX-00 审查 | 本文件、[UX-00 审查](2026-11-15-ux-v3-a5-ux00-review.md) |

写集合规：只新增 `scripts/test/offline/ui-v3-acceptance.test.mjs`、`scripts/e2e/**`、`docs/evidence/**`；**未修改** `src/**`、`scripts/test/run.mjs`、`scripts/test/offline/ui-next.test.mjs`、`package.json`、冻结证据。

## 2. 环境（实测）

| 项 | 值 |
| --- | --- |
| OS / Node | Linux · Node v24.22.2 |
| 浏览器 | `/usr/bin/google-chrome` · Chrome 153.0.8010.36（CDP protocol 1.3） |
| CDP 端口 | 运行前 `127.0.0.1:9222` **未运行**；脚本用**临时独立 profile** 启动 `--headless=new`（未下载/未安装/未碰日常 profile，`launched_by_script=true`） |
| 隔离网关 | `startGateway`：临时 `MG_CONFIG_DIR` + `MG_KEYS_MASTER=isolated-test-master` + 显式 `MG_ADMIN_TOKEN` + 临时 `CODEX_HOME` |
| 宿主 Codex | detect 实测找到 `/usr/lib/chatgpt/ChatGPT`（26.1103.32239）与 bundled CLI 0.167.0-alpha.3.2；**未启动、未执行、未写其配置** |
| 真实上游 | **0 次**（Go/GPT 均未调用） |

## 3. 命令与真实结果

```bash
npm run check
# exit 0 · UI modules: 19/19 syntax OK（含 1 次 node --check 全量 src/bin/scripts）

node --test scripts/test/offline/ui-v3-acceptance.test.mjs
# tests 10 · pass 8 · fail 0 · skipped 2（UI-01 BLOCKED_UNTIL_A1、UI-16 BLOCKED_NO_PAID_MODEL_AUTH）

node --test scripts/test/offline/ui-next.test.mjs scripts/test/offline/ui-product-status.test.mjs scripts/test/offline/agg-desktop-activate.test.mjs
# tests 28 · pass 28 · fail 0（受影响既有套件未回归）

node scripts/e2e/ui-v3-browser.mjs
# exit 1 · checks 10 · passed 4 · failed 6
# 失败项：UI-01-status-rows / UI-01-single-cta / UI-01-advanced-collapsed / UI-15-viewport-360/768/1440
# 通过项：UI-00-load、UI-01-no-fake-success、UI-10-no-credential-persistence、UI-13-no-page-errors
# 截图 3 张写入 docs/evidence/screenshots/；页面异常日志 0 条
```

浏览器失败**不是环境失败**：真实渲染成功（截图可见侧边栏、顶栏、hero、指标卡），而是 A1/A4 尚未集成——首屏没有"ChatGPT/OpenCode Go/Codex"三条连接状态、没有契约定义的主 CTA、没有"高级功能"收起分组、没有可测量的主 CTA（A4 的触控高度/断点也未落地）。脚本按设计以退出码 1 结束并逐项打印原因，**没有伪造 PASS**。

## 4. 验收矩阵（UI-01..UI-16）

| Case | 本轮结论 | 证据（mocked/real 分离） |
| --- | --- | --- |
| UI-01 新用户首屏 | **本期 FAIL_UNTIL_A1 + NOT_TESTED_UNTIL_A1** | 黑箱：`/ui-next` 200、CSP、无内联脚本、401 正确；浏览器真实渲染：三条状态行=0、主 CTA=0、"高级"分组不存在、无伪成功文案 PASS。首屏状态驱动属 A1，未集成 → 套件 `t.skip` 记录。 |
| UI-02 已登录 ChatGPT + 无 Go Key | **PASS（detected/missing 契约）** | 隔离 `CODEX_HOME/auth.json`（虚构 token）→ `official.credential='detected'`；空目录 → `'missing'`；响应字段白名单且无 token/账号/邮箱；`level!=='runtime-verified'`。**mock 文件 + 真实探测代码**，不是真实账号。 |
| UI-03 添加 Go（只填 Key） | **BLOCKED_UNTIL_A2**（含真实反向断言） | 真实 `POST /api/aggregation/providers {preset:'opencode-go'}` → **400 `provider_kind_unknown`**，未写 provider、`configVersion` 不变（A2 未把 preset 透传到 registry）；内联 `apiKey` → 400 `provider_key_inline_forbidden`；显式两步（kind+baseUrl → 201）可用。**不把旧四字段路径冒充单字段向导。** |
| UI-04 Go 401/限流 | **NOT_TESTED（真实上游）+ FAIL（投影）** | 真实 401/429 需 Go 上游 → 无授权不发；投影层 429 被归为 `recoverable_error`/"无法连接本地网关"，无 Retry-After/受限文案 → 见 UX-00 审查 F-5。 |
| UI-05 首次启用聚合 | **部分 PASS；428 全链 BLOCKED_UNTIL_A2** | 写虚构 Key → `/api/keys` 200，`/api/status.providers[id].hasKey=true`、`keySource` 可追踪，`/api/status`、`/api/keys`、`/api/config` 均不回显 Key（且拒孤儿 Key id）。`POST /api/aggregation/activate {}` 实测 **422 `invalid_desired`**（实例无已发布聚合目录），**未写 `config.toml`、CODEX_HOME 保持空**；伪造 consentToken 也 4xx 且不写。真实的 428→preview→consent→原子写→验证链只由既有单测（`agg-desktop-activate`）覆盖，A5 黑箱未打通 → BLOCKED。 |
| UI-06 需重启 | **NOT_TESTED（真实重启）+ 代码级 PASS** | 真实"完全退出 Codex 再打开"不能在本轮执行；投影只用 `detect.restart.needed`，缺失时"无法确认"（F-9 例外见审查）。 |
| UI-07 回访已启用用户 | **BLOCKED_UNTIL_A1/A3** | 首屏状态与快照统一由 A1/A3 交付；当前首页仍是运行总览仪表盘。 |
| UI-08 409 冲突 | **部分 PASS（不写入）；409 演练 NOT_TESTED** | 黑箱：activate 未同意/伪造 consent 均未写入（字节级空目录）。409 三方差异由既有 `agg-desktop-* / agg-v2-desktop-restore` 单测覆盖，A5 未做真实外部改配置演练。 |
| UI-09 切页/并发/快刷 | **BLOCKED_UNTIL_A3** | epoch/AbortController/草稿保护属 A3；静态代码有 `handleUnauthorized`/`silent` 轮询，但无集成后行为证据。 |
| UI-10 令牌过期 401/403 | **PASS（服务端无敏感数据 + 前端不持久化）** | 未授权/错误令牌 401 仅 `{error}`；无 token 实例聚合面 403 `explicit_admin_required` 仅 `ok/error/code`；浏览器实测 localStorage 只有 `mg-theme`、sessionStorage 空、无令牌。DOM 清空属 A3 → NOT_TESTED_UNTIL_A3。 |
| UI-11 断网/旧后端 | **PASS（404 语义）+ BLOCKED_OLD_INSTANCE** | 未知聚合路由 404 `aggregation_route_unknown` → 投影 `read_only_unknown`、Go `unknown`、不写"0 个模型"；404 后 `/ui-next` 仍 200。真实旧版本二进制不可得，未做跨版本联调。 |
| UI-12 原版能力不回归 | **PASS（静态反降级）** | 见 §5：`src/codex/**`、压缩、路由、既有 API 未删改；`/api/status` 仅新增只读 `official` 字段。真实 Codex 原生能力回归不在本轮（NOT_TESTED）。 |
| UI-13 历史深链/旧入口 | **PASS** | `/ui-next/index.html`、`/`、`/admin`、`/admin.html` 全 200；路径穿越 404；7 个旧 hash 路由仍在 `js/router.js`（A1 未改）。 |
| UI-14 退出聚合恢复 | **NOT_TESTED** | 需要真实写入后退出并做字节级对账；既有 `agg-desktop-rollback/restore` 单测未在本轮重跑（后端未改动）。 |
| UI-15 360/768/1440 + 200% | **静态 PASS（A4 前）；视觉 FAIL_UNTIL_A4** | `index.html` 有 viewport；`styles.css` 有 `@media max-width:540` 等断点、`:focus-visible`、`prefers-reduced-motion`。真实截图 360/768/1440 已生成；基线 1440 截图底部仍有横向滚动条，且无主 CTA 可测 → 视觉/触控目标未验收。 |
| UI-16 真实 Desktop 联调 | **BLOCKED_NO_PAID_MODEL_AUTH** | 无付费授权；GPT 只允许 `gpt-6-luna`、Go 只 `deepseek-v4.1-flash`，未发起任何真实请求。 |

## 5. 反降级审查（计划 §10/§12 + V2 契约）

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 冻结证据未被改写 | **PASS** | `docs/evidence/v2-frozen-sha.txt` 在 `708cf5e` 与 `90ac729` 的 blob 同为 `a08a2f1…`，内容 `12cf5d9…`；`v2-release-approvals.json` 同为 `5898f53…`；我的分支对它俩 `git diff --numstat` 为空。 |
| `main` 未被改 | **PASS（本地）** | 本地 `main` 最后一次移动是 **2026-09-18**（`git reflog show main`），远早于本轮（11-15 22:01 起）；工作树均不在 main 上。 |
| PR #7 / 远端状态 | **BLOCKED_REMOTE_PR_STATE** | 无 `gh`、未联网 fetch；不伪造"已确认 Draft"。本地 `mg-codex-native` reflog 最后移动 2026-11-15 19:46（本轮之前）。 |
| 没删既有路由/导出/入口 | **PASS（静态）** | `708cf5e..90ac729` 的 `src/index.js` 仅 1 行"删除"且是 import 行改写（新增 `probeLocalCodexAuth`），无路由/字段删除；`/ui-next`、`/`、`/admin`、聚合四接口、7 个旧 hash 路由均保在；`components.js` 导出未动（A4 未开始）。 |
| 没把 mock 写成 real | **PASS** | 新增证据只写 PASS(mock/isolated)/BLOCKED/NOT_TESTED；真实模型项全部 BLOCKED；验收套件里 `UI-16` 显式 skip。未新增任何"PASS_REAL"。 |
| 没改测试清单/资产清单 | **PASS（本轮）** | 我的提交不含 `scripts/test/run.mjs`、`ui-next.test.mjs`；Lead 集成提交里两者各 +1 行（登记新套件/新资产），属预期。**我的新套件尚未登记 → BLOCKED_UNTIL_REGISTRATION（需 Lead 在 `run.mjs` 字面量清单加入本文件，否则 `runner-selftest` 不会跑到）。** |
| 零新依赖 | **PASS** | `package.json` 无 `dependencies`/`devDependencies`；两个新脚本只用 Node 内置模块（`fetch`、内置 `WebSocket`、`node:fs`）与本仓库 harness。 |
| 未改压缩/原生 Harness | **PASS** | `src/codex/interop.js`、`src/responses*.js`、原生 capabilities 均无 diff（`708cf5e..90ac729`）。 |
| 未新增假按钮/假健康分 | **PASS** | 首页/连接壳无"打开 Codex"按钮；连接壳对缺数据只渲染"未知"/"正在读取"，不显示已连接/已启用。 |
| 静态 UI 安全门禁 | **PASS** | `npm run check` → `UI modules 19/19`；`/ui-next` 无 innerHTML（既有 `ui-next.test` 28/28 中该项通过）。 |

## 6. 契约偏差与风险（需 Lead 决策）

1. **A5 新套件未登记**：`scripts/test/run.mjs` 是字面量清单，`runner-selftest` 会拒绝未登记文件。本轮按写集禁止改它 → **BLOCKED_UNTIL_REGISTRATION**，请 Lead 集成时加入 `scripts/test/offline/ui-v3-acceptance.test.mjs`。
2. **UX-00 仍 FAIL**：除已修的 F-1（P0）外，[审查](2026-11-15-ux-v3-a5-ux00-review.md) 的 F-2/F-3/F-4（P1，未知→否定/待登录）、F-5（429）、F-6（过期登录）、F-7（428 死状态）、F-8（mode unknown→启用聚合）、F-10（压缩未证明）在 `90ac729` 上仍可复现。UI-04/UI-06/UI-07 的最终通过依赖这些修复。
3. **浏览器首屏未达标**：A1（状态驱动首页/三条状态/唯一 CTA/高级分组）+ A4（触控高度/断点）集成前，`node scripts/e2e/ui-v3-browser.mjs` 必须保持退出码 1；集成后重跑同一命令即可转为证据（脚本会按同一断言自动判定）。
4. **目标模型 ID**：本套件用容错断言同时接受 `mg-opencodego-deepseek-v4-1-flash`（已发布公共 ID，Lead `90ac729` 起为 `GO_PUBLIC_MODEL_ID`）与历史 `opencodego/deepseek-v4.1-flash`/`deepseek-v4.1-flash`，不把旧 ID 写死为期望值。

## 7. 未实现 / 未验证（真实边界，不得省略）

- **真实模型请求：0 次**。UI-04/UI-06/UI-16 的相关场景一律 BLOCKED；没有 `PASS_REAL`。
- **真实原版 Codex Desktop 联调、真实重启、真实 409 外部改配置、真实退出恢复**：NOT_TESTED（需要所有者授权与真实桌面操作）。
- **旧版本网关实例**（无 `/api/aggregation/*`）联调：BLOCKED_OLD_INSTANCE；仅 404 形状 + 投影已测。
- **A1/A2/A3/A4 集成后的最终 UI**：本记录只对基线 `e1beb85`（+ `90ac729` 静态复核）负责；集成后需重跑三命令。
- **200% 缩放/键盘环/reduced-motion 的浏览器实测**：NOT_TESTED_UNTIL_A4（只有静态 CSS 事实）。
- **PR #7 Draft/远端状态**：BLOCKED_REMOTE_PR_STATE。

## 8. R2 复验（集成分支 `1ab9239` + A5 合并 `741525c`）

> 合并：`git merge --no-ff feat/modelgate-ux-v3 -m "test(ux-v3-a5): 合并集成分支复验"` → `741525c`。
> 被测产品代码 = 集成分支 HEAD `1ab9239`（A1/A2/A3/A4/A5 + 状态诚实性修复）；本文件所在提交为 R2 证据提交。
> 集成截图：`ui-v3-360x800-integrated.png`、`ui-v3-768x900-integrated.png`、`ui-v3-1440x900-integrated.png`（基线截图未覆盖）。

### 8.1 命令与真实数字（集成后）

```bash
npm run check
# exit 0 · UI modules 19/19 syntax OK

node --test scripts/test/offline/ui-v3-acceptance.test.mjs
# tests 10 · pass 9 · fail 0 · skipped 1（UI-16 BLOCKED_NO_PAID_MODEL_AUTH）

node scripts/e2e/ui-v3-browser.mjs --suffix -integrated
# exit 1 · checks 11 · passed 8 · failed 3
# PASS：UI-00-load、UI-01-status-rows、UI-01-single-cta、UI-01-advanced-collapsed（像素级）、
#       UI-01-nav-current、UI-01-no-fake-success、UI-10-no-credential-persistence、UI-15-viewport-1440
# FAIL：UI-15-viewport-360、UI-15-viewport-768（A1 已接单）、UI-13-no-page-errors（A3 已接单）

npm test   # 全量（Lead 已允许）
# suites: 125 passed / 0 failed / 0 skipped / 0 timed out / 0 not run（manifest 125/selected 125）
# tests:  1212 passed / 0 failed / 3 skipped
# total:  82.7s
```

> 清单计数口径：`--list` 共 127 行 = 125 条套件路径 + 空行 + 汇总行（"125 suites (explicit manifest)"），因此实际 manifest 是 **125 套件**（含 `ui-v3-acceptance.test.mjs`，登记在第 120 条）；全量 1212 tests 已包含 5 个新套件。

### 8.2 本次修复的 3 个过期断言（不是产品缺陷）

| 断言 | 失败现象 | 真实原因（实测） | 修复方式（未放宽） |
| --- | --- | --- | --- |
| UI-02 | `official` 键集多出 `expiry` | 新增只读有效期校验（与转发链同源 `readSubscriptionCredential`），属增强 | 键集加入 `expiry`；断言 detected→`valid`、missing→`unknown`、过期 JWT→`expired`+UI"登录已过期"，并继续断言 token 零回显 |
| UI-03 | 显式两步注册收到 409，原断言期望 201 | **不是版本冲突**：`{preset:'opencode-go'}` 现在真实返回 201 并已创建 `opencodego`，随后同 ID 显式注册 → `409 {code:'provider_exists'}`（body 实测）；带过期 `version:0` 才是 `409 {code:'version_conflict'}` | 按真实语义重写：内联 Key→400、preset→201（`baseUrl` 必须来自服务端预设、`v2Scope=go-single-model`）→ 重复注册→409 `provider_exists` 且不覆盖 → 过期 version→409 `version_conflict`；**没有**接受任意状态码 |
| UI-01 | 静态 HTML 断言 `aria-current` | `aria-current="page"` 由 `app.js` 运行时写入，静态文件本就不该预写 | 离线只断言 index.html 全量 `data-route` + `app.js` 含运行时写入；运行时行为交给浏览器 `UI-01-nav-current`（实测 `{current:['overview'],route:'overview'}`），离线不假装验证 |

### 8.3 浏览器 3 项 FAIL：保持标准、归属明确（当前未放宽）

1. **UI-15-viewport-360 / 768（A1）**：CTA 真实存在（`text='连接 OpenCode Go'`、`height=44px`、左右未截断），但位于折叠线以下：360px `top=961.3 > vh 800`；768px `top=909.3 > vh 900`。1440px PASS（`top=790 < 900`）。
2. **UI-13-no-page-errors（A3）**：首绘出现 401 `/api/status` 与 403 `/api/aggregation/health`、`/api/aggregation/providers` 网络错误日志。**根因（代码证据）**：`app.js:wire()` 里 `startRouter(...)` 的回调在 `bootstrap()` 鉴权门之前调用 `refreshForRoute(route)`，因此在未解锁时已发出管理面请求。这是真实产品时序缺陷（也是用户在登录前看到 401/403 的原因），**不是测试过严**；A5 不放宽为"忽略 401/403"。
3. 附加观察（未计入 check，A1 已接单）：1440 集成截图可见 `OpenCode GoDeepSeek V4.1 Flash` 缺分隔、ChatGPT 行同时出现"待登录/已检测"徽章。
4. 横向溢出实测（`documentElement.scrollWidth - innerWidth`）：360=0、768=-15、1440=-15 → **无横向滚动缺陷**（截图中底部条不是页面横向溢出）。

### 8.4 UI-01..UI-16 集成后状态

| Case | 状态 | 集成后证据 |
| --- | --- | --- |
| UI-01 | **PASS** | 浏览器：三条状态行（ChatGPT/OpenCode Go/Codex）、唯一主 CTA"连接 OpenCode Go"、高级分组像素级收起（`pixelVisible=[]`）、运行时 `aria-current=overview`、无伪成功；离线静态职责分离 PASS。 |
| UI-02 | **PASS** | detected/missing/expired 三态 + 字段白名单 + 零 token 回显（见 §8.2）。 |
| UI-03 | **PASS** | 单字段 preset 201（服务端提供 baseUrl/ID/v2Scope）；内联 Key 400；重复注册 409 `provider_exists`；过期 version 409 `version_conflict`。 |
| UI-04 | **BLOCKED（真实上游）+ 投影 FIXED** | 429 投影已为 throttled/"稍后重试"（审查 §7 F-5）；真实 Go 401/429 未调用。 |
| UI-05 | **部分 PASS / 428 链 BLOCKED** | Key 写入 200 → `hasKey=true`、`keySource` 可追踪、零回显；`activate` 空 body 实测 422 `invalid_desired`（无已发布目录）、未写 `config.toml`、伪造 consent 也 4xx 且 CODEX_HOME 保持空。完整 428→consent→原子写仍 BLOCKED（需先发布目录）。 |
| UI-06 | **NOT_TESTED（真实重启）** | 投影/检测逻辑已修（缺 detect→unknown），真实"完全退出重开"需真机操作。 |
| UI-07 | **BLOCKED** | 需要真实"已启用回访"状态；当前隔离实例无已发布目录。 |
| UI-08 | **PASS（不写入）/ 409 演练 NOT_TESTED** | 未同意/伪造 consent 均不写入（482 字节空目录）；三方 diff 演练需真实外部改配置。 |
| UI-09 | **NOT_TESTED（A5 黑箱）** | A3 自带 `ui-v3-state` 套件覆盖竞态/草稿；A5 本轮未做并发黑箱。 |
| UI-10 | **PASS** | 401/403 无敏感字段；浏览器 localStorage 仅 `mg-theme`、sessionStorage 空。A3 修好首绘时序后日志应为 0。 |
| UI-11 | **PASS + BLOCKED_OLD_INSTANCE** | 404 `aggregation_route_unknown` → `read_only_unknown`；404 后 UI 仍 200；真实旧实例不可得。 |
| UI-12 | **PASS（静态反降级）** | 后端压缩/路由/既有 API 未删改；`src/index.js` 仅只读投影改动；`npm test` 125 套件全绿。 |
| UI-13 | **PASS（入口）** | `/ui-next/index.html`、`/`、`/admin`、`/admin.html` 200；7 个旧路由保留；**但首绘网络错误日志 FAIL，归 A3（§8.3）**。 |
| UI-14 | **NOT_TESTED** | 真实写入后退出恢复/字节对账需真机；既有 `agg-desktop-rollback/restore` 套件在 `npm test` 中通过。 |
| UI-15 | **静态 PASS / 1440 PASS / 360·768 FAIL（A1）** | 断点/focus-visible/reduced-motion 静态存在；三张集成截图；无横向溢出；窄屏 CTA 折叠线以下（A1 已接单）。 |
| UI-16 | **BLOCKED_NO_PAID_MODEL_AUTH** | 零真实请求；无 `PASS_REAL`。 |

### 8.5 对 Lead 改动的复核（ui-v3-connections.test.mjs）

Lead 把 `product=null` 的断言从"必须正在读取真实状态"放宽为"正在读取真实状态|读取失败|出现问题，且绝不出现已连接/已启用"。
**A5 判定：合理，不是降低标准。** 理由：A3 状态层在无真实快照时会给出诚实降级（读取失败也是一种"没有成功状态"），断言仍强制禁止 `已连接/已启用`；真正的不变量（不伪造成功）未变。本轮的浏览器/黑箱也独立验证了"无 Key 时无伪成功"。

### 8.6 R2 剩余 BLOCKED / 未测

- 真实模型/真实原版 Desktop（UI-04/06/07/16）：**BLOCKED_NO_PAID_MODEL_AUTH**，零请求、无 PASS_REAL。
- 完整 428→preview→consent→原子写→验证（UI-05/08）：**BLOCKED**（隔离实例无已发布聚合目录；仅既有 `agg-desktop-activate` 单测覆盖）。
- 真实旧版本网关实例：**BLOCKED_OLD_INSTANCE**。
- PR #7 远端状态：**BLOCKED_REMOTE_PR_STATE**（无 gh/未联网）。
- 360/768 首屏可见与首绘 401/403：**FAIL，已分派 A1/A3**，修复后重跑本文件 §8.1 两条命令即可更新（截图仍用 `--suffix -integrated`）。
