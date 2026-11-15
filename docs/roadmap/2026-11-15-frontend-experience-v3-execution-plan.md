# ModelGate｜前端产品体验重构执行计划 V3（完整开发任务书）

> **制定日期**：2026-11-15 · **性质**：前端设计与实施计划，**不是实施完成/发布授权**。基线 `mg-codex-native@e337f4a6693bff75f7aed3f5db1f0a4b53d68752`，PR #7 仍 Draft，`main@6bc6441` 未修改。
>
> **产品目标不变**：[所有者批准 V2 范围](../product/2026-11-14-owner-scope-v2.md)：原版 Codex Desktop、既有 ChatGPT 套餐、OpenCode Go `deepseek-v4.1-flash`、Codex 原生 Agent Team 与原生压缩（不自建摘要/压缩），Codex 真实 GPT 测试只允许 GPT-6 Luna。其他 OpenCode 模型非本轮必达项，不做全量协议扩张。
>
> **重要历史约束**：V2 冻结代码为 `12cf5d97a60f151af59c731e26b71245a50e5169`，发布门禁目前未放行、七项签收记录待处理。禁止改写历史证据回执、`v2-frozen-sha.txt`、审批 JSON、既有 PASS 状态或手工绕过门禁。前端重构一律走**独立开发分支/工作树**；合入意味着按变更范围重新冻结与再验收，而非借旧实测回执签收。

## 0. 用户角色与产品策略

**普通用户**：只关心已有 ChatGPT 套餐是否可保留、OpenCode Go 是否连接、聚合是否开启、能否在**原版** Codex Desktop 使用 GPT/DeepSeek，以及关闭后能否恢复。默认不应要求理解 Provider ID、Base URL、apiKeyEnv、model_catalog_json、TOML、SHA、SSE、OAuth 端点、原生压缩能力声明或手工编辑。

**开发者/高级用户**：保留现有完整 Provider/Key/协议/模型路由/虚拟模型/CLI/SDK 接入、诊断、日志、配置差异、回滚、原生工具与会话证据等高级能力，通过明确的“高级功能”入口访问，不删除旧接口或抹除真实能力。

**不可混淆的两个界面**：
- ModelGate = 配置聚合与看状态的**控制台**；不重写、不代替 Codex Desktop。
- 原版 Codex Desktop = 实际聊天、模型选择、原生工具/Agent Team/压缩的**工作界面**。
- “打开 Codex”按钮**只有**在受控桌面启动 API 已实际实现、验证可用时才能操作；没有该能力就提示“打开已安装的 Codex Desktop”，绝不可提供假按钮或声称已启动。

**设计目标**：默认路径为“打开 ModelGate → 添加或确认 OpenCode Go 凭据 → 预览并启用聚合 → 必要时重启 Codex → 在原版 Codex 使用”；**同一页面引导完成**，不能跨四个一级菜单手工拼流程。确认配置变更、外部启动和必要授权不能为追求点击数而自动跳过。

## 1. 完整信息架构（普通 / 高级分层）

### 1.1 导航

```text
ModelGate
├── 首页 /overview                  [默认：配置状态 + 唯一主操作 + 后续一步]
├── 模型与账号 /connections         [套餐状态 + Go Key/授权 + 模型清晰状态]
├── 设置 /settings                  [常规设置、配置恢复、刷新与退出]
└── 高级功能（默认收起）
    ├── 上游供应商 /providers       [保留完整通用 Provider 管理]
    ├── 模型与路由 /models          [保留全部高级路由及虚拟模型]
    ├── 客户端接入 /clients         [DSH / SDK / CLI 原导出和兼容性文档]
    ├── 聚合详情 /aggregation       [现有调试与目录、SHA、诊断表，保留直链]
    └── 监控与诊断 /observability   [全部运行指标、日志和上游分析]
```

实施优先复用旧路由与旧视图，只新增 `connections` 视图和分组导航，不删除深链；`#/aggregation` 保留作专业详情页。旧 `/`、`/admin` 继续按既有退役契约保留。默认首屏仍为 `#/overview`，只替换其内容排序，不擅自将服务根路由重定向到 `/ui-next`。

### 1.2 正常用户首页（只显示必要信息）

```text
┌─ ModelGate ────────────────────────────────────────────────┐
│  总体：准备就绪 / 需要操作 / 状态未知 / 出现问题              │
│                                                            │
│  ChatGPT 套餐       已检测到本机登录 / 待登录 / 未验证          │
│  OpenCode Go        DeepSeek V4.1 Flash 可用 / 待连接 / 失败   │
│  Codex Desktop      已检测到 / 需要重新打开 / 未安装          │
│                                                            │
│  聚合模式           [已启用/未启用]                           │
│  [连接 OpenCode Go] 或 [启用聚合] 或 [完成重启]               │
│  [查看高级诊断] [退出聚合并恢复]                              │
└────────────────────────────────────────────────────────────┘
```

**禁止**把“检测到登录文件/目录中有模型/控制台 HTTP 200”标成“官方推理已真实验证”；必须有来源与等级：`detected`、`configured`、`runtime-verified`、`not-tested`、`unknown`。无真实推理时可显示“已配置，尚未实测”，不得偷偷发付费请求。

首页不再默认展示累计请求、错误数、Token、P95、曲线、熔断详细表；移到监控页。若故障严重可显示 1 条短的用户可操作提示，并提供详情入口。

## 2. 用户操作路径与页面状态机

### 2.1 首次使用

```ts
// 用户只直接填写真正缺少的资料。所有 preset 来自后端能力/现有受支持常量。
type HomeState =
  | "locked" | "loading" | "cannot_detect_codex" | "needs_go_key"
  | "go_key_invalid" | "ready_to_enable" | "preview_pending"
  | "write_in_progress" | "needs_codex_restart" | "ready"
  | "conflict" | "recoverable_error" | "read_only_unknown";

function nextPrimaryAction(status) {
  if (!status.authenticatedAdmin) return "解锁控制台";
  if (!status.codex.found) return "查看如何安装/定位 Codex";
  if (!status.go.credentialConfigured) return "连接 OpenCode Go";
  if (!status.go.targetModelConfigured) return "完成 DeepSeek 接入";
  if (status.aggregation.mode !== "aggregated") return "启用聚合模式";
  if (status.codex.restartNeeded) return "完成 Codex 重启";
  if (status.aggregation.readyVerified) return "在 Codex 中开始使用";
  return "检查连接";
}
// 每个状态最多一个主要 CTA；次级操作不得冲淡本次应做的事。
```

真实流程：读取登录状态（可复用本机授权）→ Go Key 设置（普通单字段）→ 必要的 Go 目标测试需**显式、可预估费用且用户授权**→ 配置差异预览与一次确认（不能省略）→ 原子写入、备份、验证→ 如果要重启则展示精确步骤→ 终态返回首页。若后端不支持可靠桌面启动，按钮只能写“已配置，打开原版 Codex Desktop”，提供实际操作指引，不声称自动启动成功。

### 2.2 回访

- 首页直接显示模式、官方登录状态、Go 凭据是否有效（只可按已验证的事实）、Codex 是否需要重启。
- 聚合已开启时，唯一主操作是“继续使用 Codex”；“退出聚合/恢复”是明确可见的次级操作，不埋在高级菜单。
- 快速刷新不抹去输入框与未提交草稿；安全敏感信息不持久化。
- 未连接网关/后端老版本/API 不可达时，应显示真实错误与安全重试，不展示臆造“已连接”。

### 2.3 异常路径（必须作为一等公民）

| 条件 | 用户可理解的提示 | 必须保留的技术行为 |
| --- | --- | --- |
| Go 401 / Key 失效 | OpenCode Go 验证失败，请更新 Key | `401` 与供应商域、无 GPT 回退；Key 不回显 |
| Go 429 / 配额不足 | OpenCode Go 当前受限，请稍后重试或查看账户额度 | 明确 `Retry-After` 与真实上游，无跨域兜底 |
| 未找到原版 Desktop | 没有找到 Codex Desktop，请检查安装/路径 | 可展开路径、二进制与版本探测，不假造可用 |
| 需要客户端重启 | 配置已保存；请完全退出并重新打开 Codex | 判断依据 `health.restart`，不能默默称已生效 |
| `428 consent_required` | 即将更新 Codex 接入设置，请先确认变更 | 完整差异、备份、`consentToken` 与 `expectedSha` |
| `409 conflict` | Codex 设置已被其他程序修改，未覆盖你的更改 | 三方 diff `base/ours/theirs` + 重新检测 + 手工处理 |
| 网关 404/版本不兼容 | 当前实例不支持聚合管理，请检查版本 | 停止自动写入，提供确切受支持 API |
| 压缩兼容未证明 | Codex 原生压缩状态尚未验证/存在阻断 | 不说“已通过”，展开 `nativeCompaction` 声明与真实证据 |
| 无 Go Key / 目录无数据 | 未连接 Go / 状态未知 | 不能把未探测显示成模型“0 个”或“全部可用” |

## 3. Go 凭据向导：从四个技术输入收敛为一个用户输入

当前 `src/ui-next/js/views/aggregation.js` 的弹窗要求用户填写 `id`、`kind`、`baseUrl`、`apiKeyEnv`，默认类型是 Console，且“添加并发现全部模型”仍残留 V1 语言——必须修正。

**普通路径**：
1. 标题“连接 OpenCode Go”，默认 Provider kind=`go`、model=`deepseek-v4.1-flash`，ID/端点/模型别名由**现有后端真实预设**提供或从其唯一合法定义推导；若查不到受支持预设，标 `BLOCKED` 而不是硬猜一个 URL。
2. 默认只显示“OpenCode Go API Key”密码输入；如环境已有 `OPENCODE_API_KEY` 且后端已能安全检测，可提供“使用现有凭据”选项。严禁把已存在 Key 回显或下载。
3. Go Key 存入服务端现有加密键存储，与 Provider 注册共享可追踪、原子化或具有补偿操作的向导事务；如需复用 `POST /api/keys`，先确认 `POST /api/aggregation/providers` 生成的 ID 与通用上游键映射一致。不能直接认为两套 API 已联通。
4. 注册/写 Key/必要同步每一步独立可回滚或重试；若只有部分成功，UI 显示“已保存 Key、连接未完成”，不得撒谎称全流程成功。
5. 保存 Key ≠ 发真实推理；真正的“测试连接并推理”单独解释费用，必须用户授权。
6. 高级展开才允许手工改 Provider ID、endpoint、apiKeyEnv、协议，且只有系统确实支持时才开放。

**禁止**只在旧通用 `providers.js` 加一个“设 Key”按钮就宣称完成；必须实现端到端向导与状态衔接。

```ts
async function connectGo(form) {
  // 伪代码，NOT IMPLEMENTED；服务端需校验 preset/凭据域/权限。
  const preset = await loadVerifiedGoPreset();
  const saved = await storeKeyWithoutEcho({ providerId: preset.id, key: form.key });
  try {
    const provider = await ensureAggregationProvider({ presetId: preset.id, kind:"go", expectedVersion: form.version });
    const selected = await configureSingleTarget(provider.id, "deepseek-v4.1-flash");
    return { status:"configured", savedKey:true, model:selected.publicId, tested:false };
  } catch (e) {
    return await compensateOrReportPartialState(saved, e);
  }
}
```

## 4. 页面/模块重构任务（必须按职责映射）

| 优先 | 模块 / 现有文件 | 操作 | 验收要点 |
| --- | --- | --- | --- |
| U0 | `src/ui-next/index.html`, `js/router.js` | 普通三级主导航 + 可展开“高级功能”；旧 hash 路由仍可访问 | 旧深链/浏览器前进后退工作；不丢权限 |
| U0 | `js/views/dashboard.js` | 改为状态驱动首页：官方/Go/Codex/聚合状态、一主 CTA、错误一步指引 | 未配置/正常/断网/重启/冲突五状态有意义且真实 |
| U0 | 新建 `js/views/connections.js` + Go 向导组件（可拆文件） | ChatGPT 登录“已检测/未验证”，Go 直填 Key，目标模型只 DeepSeek | 不暴露默认 ID、URL、env；可进入高级配置 |
| U0 | `js/views/aggregation.js` | 去掉旧 Console 全量话术和默认选项；技术长表移高级详情；复用 activate/deactivate | 428/409/回滚语义完全保留 |
| U1 | `js/store.js`, `js/api.js`, `app.js` | 引入聚合页面统一请求快照与 freshness，进入页面时按需同步；消除 AGG 本地缓存与主状态不一致 | 多次切页、快刷、并发竞态、401 清空；输入不丢 |
| U1 | `js/views/providers.js` | 保持所有高级配置，新增与 Go 向导的正确跳转/“高级编辑”入口 | 通用 Provider 功能不退化，Key 通道安全 |
| U1 | `js/views/models.js` | 只放高级路由，不再强迫正常 Go 接入用户使用它 | 真实/虚拟模型/路由预览和保存差异不回退 |
| U1 | `js/views/clients.js` | 移至高级；Codex Desktop 主入口指向新向导；旧手工模板显示高级/历史用途 | 避免和自动接入构成两个相互矛盾的“默认方式” |
| U1 | `js/views/observability.js` | 完整迁移首页技术指标的发现位置，不删除能力；提供错误代码与可复制脱敏诊断 | 统计口径标注、原生与网关流量不混淆 |
| U1 | `js/views/settings.js` | 普通设置优先，账号安全/回滚状态/配置管理高级展开 | 不把不存在的备份 API 伪装为按钮 |
| U2 | `js/components.js`, `styles.css` | 提高字体/可点击区域，规范表单、步骤、消息、危险动作层级 | 桌面/平板/手机自适应、键盘和读屏 |
| U2 | UI 文案/导航索引/契约文档 | 清理 V1 残留 Console 全量承诺、内部术语 | 不删除历史代码/证据、不更改用户已批准范围 |

**不修改** `src/codex/interop.js` 的 compaction 逻辑或另写自建压缩；本任务仅正确显示真实状态。除 Go Key 向导与状态组合所必需的最小后台支撑外，不改变 V2 网关路由/认证/模型语义。

## 5. 后端契约复用与最小必要补充

**已存在，优先复用**：
- `GET /api/aggregation/health`, `/providers`, `/models`, `/diagnostics`；
- `POST /api/aggregation/providers`, `POST /api/aggregation/providers/:id/sync`；
- `POST /api/aggregation/activate`, `POST /api/aggregation/deactivate`；
- `POST /api/keys`（通用键通道，需确认聚合 Provider 与键 ID 是否映射）；
- `GET /api/auth`、`GET /api/status`、`GET /api/config`。

**计划检查点**：
```ts
type ProductConnectionView = {
  official:{status:"detected"|"configured"|"verified"|"unknown"|"blocked"; reason?:string};
  go:{status:"missing"|"configured"|"verified"|"error"|"unknown"; model:"deepseek-v4.1-flash"; credentialPresent:boolean};
  codex:{found:boolean; version?:string; restartNeeded?:boolean; detectionLevel:string};
  aggregation:{mode:"aggregated"|"official"|"unknown"; configSha?:string; backupAvailable?:boolean};
  lastUpdatedAt:string; // ISO; 每项可带 checkedAt 以避免陈旧显示
};
// 前端适配器可从现有多个 GET 组合，但不得把 missing/unknown 转成 false/健康。
// 如不可避免需要新增专门状态 API，必须先交契约测试，不能用 mock 假造事实。
```

若服务端确实不能安全将 Go Key 设置绑定到聚合 Provider，允许增加**一个最小、受管理鉴权保护**的 Key 保存适配动作（或小型复合端点），只覆盖 Go 预设、固定 DeepSeek、版本竞争与回滚。先审计现有 API，避免重复设计另一套 Key 存储。不得提供任意远端文件写入接口或绕过 loopback/管理员鉴权。

**浏览器安全**：敏感凭据不写 `localStorage`/`sessionStorage`/URL/日志/DOM 隐藏副本/导出 JSON；不读取打印 `auth.json`。后端可以在授权范围内按已有安全机制使用 Codex 登录文件（没有绝对禁止触碰规则）。管理请求 401/403 后清掉旧敏感 DOM；取消、刷新和失败要安全收束。请求错误区分 `status`、`code`、`message`，普通提示简短，技术详情可展开。

## 6. 状态更新与用户反馈

当前 `app.js` 每 15 秒刷新全局 `/api/status`；聚合页单独用 `AGG.fetched` 缓存四个 API，一次读取后可能长时间不再更新。要解决的是状态一致性，不是简单增大轮询频率。

```ts
// 待实现：基于现有 store 的共享 snapshot，按可见路由节流获取。
// 对并发请求使用 epoch / AbortController；旧响应不得覆盖新响应。
function shouldRefresh(section, now) {
  return isVisible(section) && (now - lastRefresh[section]) > FRESHNESS_BUDGET[section];
}
async function refreshAggregation(epoch) {
  const result = await readOnlyAggregationSnapshot();
  if (epoch !== currentEpoch) return;         // 旧请求丢弃，不覆盖最新状态
  if (editDialogOpen()) updateStatusOnly();   // 不重建正在输入的表单
  else applyStatusAndRerenderRelevantSections(result);
}
// 页面离开/返回、连接变化、启停完成、服务恢复时同步状态；
// 不允许轮询触发真实 Go/GPT 推理或改配置。
// 客户端重启状态来源仍依赖真实 detect，不推测已重启。
```

状态优先级：**错误/冲突/待授权 > 需要重启 > 未连接 > 已配置未验证 > 已有真实验证**。提示只给用户下一步动作；对于真正不同类型的验证，不用一个绿色“已连接”徽章混为一谈。

## 7. 视觉与无障碍规范

- 继续使用现有无外部依赖的设计系统与明暗主题；**不为了换视觉框架而引入 React/Vue 或大依赖**，除非所有者另外批准。
- 普通用户正文建议 14–16 px、帮助文字尽量不低于 12 px；主要按钮触控区至少约 40–44 px，支持缩放和适当断行，不让 10.5 px 技术说明塞满默认页面。
- 普通首页优先单列主任务 + 三条连接状态；桌面可采用两栏次要信息；技术表格只在高级页且支持横向滚动。
- 核心操作按钮的语义不混淆：主要 CTA 强调当前任务；退出聚合/删除凭据使用二次确认，但不是所有读操作都要多次确认。
- 表单完整 `label`、字段内联错误、焦点可见；`aria-live` 只播报关键状态，不将整个页面频繁重读；弹窗保留 Escape、焦点圈定与关闭后恢复焦点。
- 兼容窄屏/大字号/键盘导航/读屏与 reduced motion；目标按 WCAG 2.2 AA 原则执行，须有可复测证据。
- 文案用词统一：**“连接 OpenCode Go / 启用聚合 / 需要重新打开 Codex / 在 Codex 中使用 / 查看高级诊断 / 退出并恢复”**；默认不出现 `providerId`/`configVersion`/`model_catalog_json`/`remote_compaction` 字段名。
- 不添加无用的商业仪表盘、费用预测、不存在的桌面启动器、自动登录按钮或假“健康”评分。

## 8. 实施里程碑与 PR 分割

**前置步骤 U0-BASE（仅审计不改产品）**：
```bash
git status --short
git rev-parse HEAD
git branch --show-current
# 工作树不能有未处理改动；只保全，不 reset/clean。
# 从 mg-codex-native 最新 HEAD 新建隔离 branch/worktree：
# feat/modelgate-ux-v3
# 原分支原有 PR #7 / freeze / evidence / approvals 原封不动。
npm run check && npm test && npm run docs:check && npm run contract:check
```

以下为逻辑顺序与建议 PR，不设置虚构完成时间：

| 次序 | PR / 阶段 | 输入依赖 | 最低交付物 | 验收 |
| --- | --- | --- | --- | --- |
| 0 | UX-00 / UX 契约、首屏状态 | 当前 V2 仓库快照 | 任务状态机、接口来源、错误矩阵、可复现实测脚本 | 不新增伪状态/API；baseline 绿 |
| 1 | UX-01 / 首页与分层导航 | UX-00 | 改造 `dashboard`、`router`、`index.html`、新增 connections 壳 | 首屏 CTA 正确、旧路由不丢、无 Key 前不显示成功 |
| 2 | UX-02 / Go Key 单字段向导 | UX-00；先审计键存储关联 | 安全 Go preset + 凭据提交 + 目标模型配置/状态 | 普通表单零 ID/URL/env、重复/401/409/中断可恢复 |
| 3 | UX-03 / 聚合启停完整引导 | UX-01/02 | 428 preview、一次 consent、atomic apply、重启提示、退出恢复 | 用户未手改 TOML、409 不覆写、不丢原登录 |
| 4 | UX-04 / 状态共享与高级归位 | UX-01/03 | `store`/缓存竞态修复、原技术页归档为高级入口 | 旧配置/虚拟路由/SDK 导出功能完整 |
| 5 | UX-05 / 视觉、可访问性与响应式 | UX-01/04 | tokens、组件、多尺寸交互、文案质量 | 键盘、屏幕缩放、暗色、错误反馈通过 |
| 6 | UX-06 / 整体验收与交接 | UX-01..05 | 截图、浏览器脚本、功能对照、可复现回滚和用户手册 | 离线/真实分开、现行 V2 能力无降级 |

**并行依赖关系**：UX-01 与 UX-02 可分别在独立工作树推进；UX-03 等到接口稳定后；UX-04/UX-05 分担不同文件避免交叉写入。每个 PR 必有文件级 owner、契约 ID、用户操作路径、截图（成功/失败/空状态）、回归与回滚说明。不得在同一 PR 顺便重构 Codex 原生压缩或全部网关协议。

## 9. Agent Team 最大五子代理

如使用 Agent Team，主代理协调但**同时最多 5 个子代理**：

| 子代理 | 角色 | 唯一职责与写集 |
| --- | --- | --- |
| A1 | 首屏与信息架构 | `index.html`、`router.js`、`dashboard.js` 及其 UI 单测 |
| A2 | Go Key 向导与聚合 | `views/connections.js`、`views/aggregation.js`、必要 Go preset/键存储接口（先审计） |
| A3 | 状态机/交互可靠性 | `store.js`、`app.js`、`api.js` 与请求竞态/401/409 测试 |
| A4 | 视觉/无障碍/高级功能归位 | `styles.css`、`components.js`，旧 `providers/models/clients/observability` 在明确分配后串行整理 |
| A5 | 独立 QA | 浏览器 E2E、可用性场景、真实/Mock 边界、证据与回归审查；不自行降低验收 |

`src/index.js` / `bin/mg-desktop.mjs` / `package.json` / CI 等共享入口由主代理单独整合，子代理通过明确补丁/接口协商交付。A5 不得修改产品需求或在没有真实执行情况下写 PASS_REAL。若实际环境不支持 Agent Team，只能串行执行，不得假称多代理执行。

**测试模型约束**：所有通过 Codex 进行的真实 GPT 模型测试只允许 **`gpt-6-luna`**；Go 真实测试只使用 **`deepseek-v4.1-flash`**。除非本轮获得新的明确授权，否则前端 E2E 首选 mock/本地网关与预存脱敏回执，不擅自发起付费模型请求。UI 测试必须标示 mocked vs original Codex GUI real。

## 10. 验收矩阵（有行为、有证据，不以截图漂亮代替可用）

| Case | 场景与动作 | 成功条件 |
| --- | --- | --- |
| UI-01 | 新用户第一次打开 `/ui-next` | 不显示虚假的成功状态，立即给出正确下一步 |
| UI-02 | 检测到已登录的 ChatGPT，但没有 Go Key | 官方套餐可保留；显示“连接 Go”，而不是要求用户编辑协议 |
| UI-03 | 添加 Go | 默认界面只输入 Key；安全储存、唯一 DeepSeek ID 正确、状态可追踪 |
| UI-04 | Go Key 失效/限流 | 明确供应商/状态，保持 ChatGPT 不变且不降级换 GPT |
| UI-05 | 第一次启用聚合 | 预览/consent/备份/写入/验证，显示真实状态而非只弹 Toast |
| UI-06 | Codex 已开、需重启 | 解释完全退出/重开；未实测重载不能称生效 |
| UI-07 | 回访已启用用户 | 首页直接显示状态，次级操作可安全退出/恢复 |
| UI-08 | 激活或退出时出现 409 | 保留所有用户修改，三方差异可展开，不出现强制覆盖 |
| UI-09 | 两个页面来回切换/刷新/并发请求 | 最新状态胜出，未保存内容保持，不用旧缓存标“已连接” |
| UI-10 | 管理令牌过期 401/403 | 敏感投影清空、要求重解锁；无假状态 |
| UI-11 | Web 断网/旧后端缺聚合接口 | 真实错误、可重试，不显示“0 个模型”等伪事实 |
| UI-12 | 原版 Codex CLI / Desktop 的原有能力 | 前端重构未修改原生 tool/Agent/compaction 后端；旧 E2E 正确回归 |
| UI-13 | 高级旧用户打开历史深链 | 全部旧路由、模型/虚拟模型、日志/导出、管理 Key 等仍可用 |
| UI-14 | 空白/旧配置退出聚合 | config/auth 和用户其它设置保持，回滚 hash 对账 |
| UI-15 | 360px、768px、1440px 及 200% 缩放 | 不截断主 CTA，不产生不可用横向滚动，键盘操作可达 |
| UI-16 | 真实原版 Desktop 实测（须另获批准） | GUI 模型选择 GPT/Go、请求归因、用户体验一条龙；证据钉 SHA |

**量化 UX 目标（验收目标，不代表已测得）**：
- 普通用户完成初次 Go 接入时，在正常成功情况下只需一个 Key 字段、一次必要的授权/配置确认，以及按真实需要进行的 Codex 重启；不手改 TOML，不手填 URL/provider ID/env。
- 默认首页 1 个主要行动 CTA、3 个必要服务状态（官方、Go、Codex）和聚合状态；不默认展示原始日志、token 明细、SHA 与 compaction 内部字段。
- 可用性验证至少覆盖“首次使用、已配置回访、Go Key 错误、需重启、409 冲突”五条剧本；记录完成率/误操作/需人工提示的步骤，不臆造百分比。
- 所有致命错误必须给“发生什么—是否写入成功—下一步”；未验证状态不得被绿色成功标签替代。

## 11. 代码冻结、发布与合并

- **本文件是计划，不授权修改任何已冻结代码。** 创建 `feat/modelgate-ux-v3` 或单独 feature worktree 执行；保留 `mg-codex-native` 的冻结点、PR #7、所有历史回执和批准文件。
- UI/状态/Key 适配代码实施会使先前 “code-equivalent freeze” 结论不再可自动沿用。等实现稳定后形成新候选 SHA，按改变范围重新跑离线/浏览器/真实受影响测试。
- 如果后端 Key 事务或 Codex 客户端配置改动触及 V2 产品 MG-R002..R012，必须覆盖对应真实验收；不要把本轮叫“纯换皮”以绕过测试。
- 在用户允许真实测试之前：仅实现可离线验证的功能，并对上游调用写 `BLOCKED`；绝对不能偷用别的 GPT 模型，更不能因为未获授权缩小功能。
- A5 单独确认关键用例后，整理新增 UX 实测证据和新冻结，提交 PR 给所有者；**不自动将 PR #7 转 Ready、不合并 main、不发版。**
- 若确实需要新依赖、桌面启动器、新服务进程、付费接口、涉及日用配置/密钥迁移或生产修改，先做已有能力查重与影响说明并获得明确许可。

## 12. 开发完成定义（Definition of Done）

```text
[ ] 主导航默认产品导向，旧高级入口无损保留
[ ] Go 凭据接入仅需真实必要字段；内置 preset 与 Key 存储已经真实闭环
[ ] ChatGPT 套餐状态、Go 目标、Codex Desktop、聚合开关显示有证据来源
[ ] 428 确认、409 三方冲突、失败回滚、退出恢复与老设置保持不变
[ ] 无伪“打开 Desktop”按钮；有受支持能力才能实际启动
[ ] 当前输入/草稿不因轮询、切页、取消或错误消失
[ ] 核心页面、移动端、深色、键盘/读屏可用
[ ] 旧高级 Provider/路由/虚拟模型/客户端模板/诊断未回归
[ ] 没有修改或自建 Codex 压缩、原生 Agent Harness
[ ] 现行 MG-R001..R012 对应受影响范围已重新验证并有准确证据
[ ] Codex 真实 GPT 测试只能 gpt-6-luna；Go 只 deepseek-v4.1-flash
[ ] CI + 独立 A5 验收通过，准确保留 BLOCKED/partial
[ ] 所有者明确批准后才可合并与发布
```

### 执行原则

先修**用户开始操作的路径**，再修控制台高级密度、视觉细节；复杂性由产品自动处理，不改变底层真实能力。禁止用再次扩展后端模型覆盖、增加更多功能页、删除测试或改写冻结证据来代替 UX 改善。
