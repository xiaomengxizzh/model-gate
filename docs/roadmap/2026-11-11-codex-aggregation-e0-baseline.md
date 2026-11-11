# ModelGate｜Codex 聚合模式 E0 事实审计与隔离基线

> 2026-11-11 · 只读审计 + 隔离环境验证 · **未修改任何产品代码、未触碰正式配置/凭据/服务**
>
> 依据：`docs/roadmap/2026-11-10-codex-aggregation-d1-d7-execution-plan.md`（origin/docs/codex-aggregation-d1-d7-20261110 @ 4006591）
>
> 基线提交：`integration/modelgate-next @ ec66b24b529cc6c4e531d2bb718ac22edb70f334`（= Draft PR #5 head）
>
> 本阶段结论：**E0 审计完成，隔离环境已建立并通过实测；E1 代码实施待单独授权。**

---

## 0. 一页结论

| 项目 | 结论 |
| --- | --- |
| 参考基线可复现 | `npm test` → **30/30 隔离套件通过**；`check-ui` 15/15；`check-docs` PASS；`check-metadata` 21/21 PASS |
| 运行时依赖 | **零运行时依赖**（package.json 无 dependencies，无 node_modules）；Node v24.22.2 已具备，**无需任何下载/安装** |
| 客户端版本 | Codex CLI **0.167.0**、ChatGPT Desktop **26.1103.32239**（内置同一 Codex） |
| PR 状态 | #5 / #4 / #2 均 OPEN + **Draft**；#3 / #1 已合并。未合并、未改动 |
| 生产边界 | 8787/18787/19000 无残留监听；`model-gateway.service` inactive；托盘服务在跑（勿动）；正式配置哈希前后不变 |
| 隔离环境 | 新 worktree + 临时 `CODEX_HOME` + 独立 `MG_CONFIG_DIR` + 端口 18787 / mock 19000，已验证 |
| P0 缺口 | 计划所列 5 项**逐条代码确认**；另发现 3 项计划未记录的事实（见 §5.6） |
| 真实调用 | **未发生任何真实付费请求**；本轮只有本地 mock 与离线 CLI 探测 |

---

## 1. 仓库与协作状态（只读核对）

| 引用 | SHA | 说明 |
| --- | --- | --- |
| `origin/main` | `6bc6441f` (2026-11-07) | 未改动，本工作不从 main 出发 |
| `origin/integration/modelgate-next` | `ec66b24b` (2026-11-10) | **开发基线**；领先 main 63 commits / 169 files (+19,211/−1,304) |
| Draft PR #5 | head `ec66b24b` → base `main` | OPEN / Draft，即集成基线本身 |
| Draft PR #4 | head `35bed9bf` → base `dev/gateway-audit-20261108` | OPEN / Draft，已包含在 #5 历史中 |
| Draft PR #2 | head `9a0bfe3b` → base `main` | OPEN / Draft，**未**并入集成基线（独立实验分支） |
| PR #3 / #1 | 已 MERGED | 文档 / 资源治理 |
| 计划文档分支 | `origin/docs/codex-aggregation-d1-d7-20261110` @ `4006591` | 计划+启动词，已核实可读 |

本地 worktree 现状（新增前）：

```text
model-gateway        3a4ba89  dev/gateway-audit-20261108
model-gateway-dev    66f274c  dev/gateway-g0-g4-20261107
model-gateway-next   ec66b24  integration/modelgate-next      ← 参考基线（只读使用）
model-gate-frontend  6bc6441  dev/frontend-console-rebuild-20261107
```

**E0 新增隔离工作树**：`workplace/idproject/model-gateway-codex-agg`，分支 `dev/codex-aggregation-20261111`（从 `ec66b24` 切出，本地分支，**未 push、未建 PR**）。

---

## 2. 版本、工具与依赖

| 项 | 值 | 说明 |
| --- | --- | --- |
| Node | v24.22.2 | 仓库要求 >=18 |
| npm / pnpm | 11.19.1 / 12.18.0 | pnpm 存在但**本项目不需要** |
| Codex CLI | 0.167.0（vendor `x86_64-unknown-linux-musl`） | 稳定入口 `harness/codex/cli/bin/codex` |
| ChatGPT Desktop | 26.1103.32239（deb，内置 Codex 0.167.0） | 本轮未启动 |
| 项目依赖 | **无** | 零第三方运行时；`node_modules` 不存在 |
| 资源预检 | 全部为宿主已有能力 | 无模型权重/框架/大包需求 → 未触发 RESOURCE_APPROVAL 下载流程 |

> 结论：E1–E5 的实现可用现有 Node 内置模块完成，**不需要安装任何依赖**。

---

## 3. 生产环境边界（保护对象与实测值）

| 资源 | 正式值 | 本轮实测 |
| --- | --- | --- |
| 网关服务 | `systemctl --user model-gateway.service` | **inactive (dead)**，未启动、未 stop/restart |
| 生产端口 | `127.0.0.1:8787` | 无监听（未占用） |
| 托盘 | `app-mg-tray@autostart.service`（python，读 8787） | 运行中；**未交互、未重启** |
| 生产配置 | `model-gateway/config/gateway.local.json` | sha256 `d59bd492…e71a` 审计前后一致 |
| Codex 配置 | `~/.codex/config.toml` | sha256 `f51a749c…4e62` 审计前后一致 |
| Codex 凭据 | `~/.codex/auth.json` | sha256 `de7cc6e9…fc11` 审计前后一致（未读取内容） |
| 历史会话 | `~/.codex/sessions` | 未读写；mtime 保持 2026-09-23 |
| 用户主密钥 | `~/.model-gateway/master.key` | 未读取；测试统一用临时 `MG_KEYS_MASTER` |

---

## 4. 真实客户端离线探测（无网络、无付费、无正式凭据）

### 4.1 Codex 实际发出的请求头（对象：自定义 provider + dummy env_key）

方法：临时 `CODEX_HOME=/tmp/mg-e0/codex-home`、本地 mock `127.0.0.1:19000` 记录头、`codex exec --ephemeral --sandbox read-only`。

```text
POST /v1/responses    body=59,311 bytes（单条极短 prompt 的完整 Codex 载荷）
头集合：accept, authorization(Bearer, dummy), content-length, content-type, host,
        originator, session-id, thread-id, user-agent,
        x-client-request-id, x-codex-beta-features, x-codex-turn-metadata, x-codex-window-id
```

**含义（P0 证据）**：
1. `session-id` / `thread-id` / `x-codex-*` / `originator` 当前**不在网关 STRIP_IN** → 会被原样转发到任意第三方上游。
2. 走内置 openai + ChatGPT 登录时还会增加 `chatgpt-account-id` 等官方标识；该组头**目前没有任何过滤**（本轮未用真实登录验证，需 E3 授权）。
3. 单轮 59KB 固定开销 → E5 预算/上下文评估必须按"每轮 + 上下文"估，不能只算用户文本。

### 4.2 Codex 模型目录的真实契约

| 探测 | 结果 |
| --- | --- |
| `codex debug models`（默认） | 输出 745KB / **12 个模型**，字段含 `slug, display_name, default_reasoning_level, supported_reasoning_levels, shell_type, context_window, max_context_window, multi_agent_version, base_instructions, …` |
| `-c model_catalog_json=<file>`（最小条目） | **失败**：`failed to parse model_catalog_json path … missing field \`supported_reasoning_levels\`` → 普通 `/v1/models` 形状**不可用**，与计划 §2.1 一致 |
| `-c model_catalog_json=<file>`（完整元数据 + 合成第三方模型） | **成功**：目录被**整体替换**（2 条：官方 + 合成第三方），`codex debug models` 原样返回 |
| 目录中缺模型 | 运行时告警：`Model metadata for … not found. Defaulting to fallback metadata`（即 M1 里"列表可见但能力退化"的根源） |

> 关键：**本地 `model_catalog_json` 可用，且是"全量替换"语义** → E2 生成器必须输出完整 `ModelInfo`（官方元数据 + 第三方条目），不能做增量拼接；目录与 provider 无关（同一 `CODEX_HOME` 一个 picker），这正是 M1 同会话切换的技术落点。

### 4.3 客户端能力事实（0.167.0）

| 事实 | 证据 |
| --- | --- |
| `multi_agent` feature: stable / **true** | `codex features list` |
| `multi_agent_v2`: stable / **false（默认关闭）** | 同上 → D3"v2 优先"必须显式启用并留证 |
| `model_catalog_in_context`: under development / false | 同上 |
| Provider 支持 `model_catalog_url`、`requires_openai_auth`、`gateway_oauth` 等字段 | 二进制 schema 字符串（`ModelProviderInfo`） |
| `codex debug models` 可完全离线校验目录 | 已实测 |

---

## 5. 代码缺口核对（基线 ec66b24，逐条定位）

| # | 计划缺口 | 代码证据 | 影响 | 阶段 |
| --- | --- | --- | --- | --- |
| 1 | 模型目录是简化 OpenAI list | `src/index.js:310 staticModels`、`:1092` `GET /v1/models` | 无 Codex `ModelInfo`、无上下文/推理等元数据 → 客户端回落 fallback | E2 |
| 2 | 未知模型静默回落 defaults.provider | `src/router.js:217-229`（`if (defaultProvider) return { canonicalName: model, known: alias.has(model), def: { provider: defaultProvider } }`） | 聚合 ID 一旦下架会被**偷偷改绑**到默认上游 → D1 禁止行为 | E1 |
| 3 | 官方头未过滤 | `src/forward.js:13 STRIP_IN` 无 `chatgpt-account-id`，也无 `session-id/thread-id/x-codex-*`；`:72-73` 其余头原样复制 | 凭据/会话标识可流入第三方（**P0 串线风险**） | E1 |
| 4 | extraHeaders 可覆盖鉴权 | `src/forward.js:78-80`（先写 authorization，再 `Object.assign` extra 并小写覆盖） | 配置层可覆盖/篡改鉴权头；无白名单 | E1 |
| 5 | 重定向已禁用 | `src/forward.js:664-665`（302 视为 upstream_error，不跟随） | 现状合规，E1 需保留并加 host/path 白名单 | E1 |
| 6 | 托管工具/namespace 静默丢弃 | `src/responses.js:91-99 mapTools` → `lossy.push('tool_dropped:'+type)` | v2 子代理 `namespace` 工具在 Chat 桥上不可用 → M2 阻断点 | E4 |

补充事实（计划未写、E0 新发现）：

- **5.6.a** Codex 0.167 自定义 provider 的实际头集合包含 `session-id/thread-id/x-codex-*`，比计划假设更宽 → E1 白名单必须覆盖。
- **5.6.b** `multi_agent_v2` 默认 false：D3"v2 优先"要在 0.167 上生效需显式 enable（并在 E4 证据里注明是 feature flag 状态）。
- **5.6.c** `model_catalog_json` 为**整体替换**语义且 schema 严格：目录生成器必须"官方全量 + 第三方增量"合并后输出完整对象，缺字段直接启动失败（fail-closed 反而是好事，可做校验闸门）。

---

## 6. 隔离测试环境设计（E0 验收项）

| 维度 | 正式/受保护 | 隔离值（本轮已验证） | 验证方式 |
| --- | --- | --- | --- |
| Codex home | `~/.codex` | `/tmp/mg-e0/codex-home`（空目录，无 auth/sessions） | `CODEX_HOME=… codex --version`；目录内 0 文件生成 |
| 网关实例 | systemd `model-gateway.service` :8787 | 前台 `node src/index.js` + `MG_CONFIG_DIR=/tmp/mg-e0/gw-config` + `MG_KEYS_MASTER=e0-isolated-master` + `:18787` | `/v1/models`、`/api/status` 实测 200；进程已退出 |
| 上游 | 真实 OpenCode Go / 官方 | 本地 mock `:19000`（记录请求头/体，返回 Responses SSE） | Codex `exec` exit 0，输出 `probe responses ok` |
| 测试数据 | 生产 `config/` | `MG_CONFIG_DIR` 临时目录（keys/stats 随之隔离） | 正式配置哈希前后一致 |
| Git | main / 集成分支 / PR | 新 worktree + 本地分支 `dev/codex-aggregation-20261111` | `git worktree list`；未 push |
| 客户端 | Desktop（未启动） | 仅 CLI 离线探测 | 无 GUI 进程 |

**已实测的隔离断言**：`config.toml`、`auth.json`、生产 `gateway.local.json` 三个 sha256 前后完全一致；8787/18787/19000 审计后均无残留监听；`~/.codex/sessions` 未变。

**回滚**：删除 `model-gateway-codex-agg` worktree 与 `dev/codex-aggregation-20261111` 分支、清空 `/tmp/mg-e0` 即回到审计前状态；正式侧无任何可回滚变更。

---

## 7. P0 缺口与阶段映射

| 优先级 | 缺口 | 阶段 | 依赖 |
| --- | --- | --- | --- |
| P0-1 | 官方/第三方头与凭据串线（含 extraHeaders 覆盖） | E1 | 无（可离线全测） |
| P0-2 | 聚合 ID 静默回落 | E1 | 无 |
| P0-3 | 完整 Codex 目录生成/发布/回滚 | E2 | E1（身份/目标白名单） |
| P0-4 | 同会话 GPT→第三方→GPT 连续性 | E3 | E1+E2；**真实官方登录/政策核查另需授权** |
| P0-5 | v2 子代理可读性与工具闭环 | E4 | E3；v2 加密任务研究 |
| P0-6 | 智能 Fallback（副作用安全） | E5 | E1/E2/E4 |

---

## 8. 首阶段执行方案（E1，待授权）

**范围**：只做 `src/codex/identity` + `src/forward.js` + `src/router.js` 的凭据/路由护栏；不写配置、不碰历史、不接真实上游。

### E1-a 身份分类与头防火墙（最小 PR，可离线全测）

- 新增 `src/codex/identity.js`：`classifyTarget(provider, cfg)` → `official` / `thirdParty` / `unknown`（官方 = 内置 openai 语义目标，非"名字叫 openai"）。
- 修改 `src/forward.js buildHeaders`：
  - 拆除"extraHeaders 覆盖鉴权头"能力：`authorization/x-api-key/x-goog-api-key/chatgpt-account-id` 等进入**禁止覆盖集**；
  - 第三方目标剥离 `chatgpt-account-id`、`session-id`、`thread-id`、`x-codex-*`、`originator`（默认剥，白名单显式放行）；
  - 官方目标仅允许白名单头通过，其余丢弃并计数。
- 新增 `offline/codex-identity.test.mjs`：mock echo 上游断言每种目标的"允许/禁止头集合"、恶意 extraHeaders、错配 host、302 重定向。

**验收门禁**（按 CONTRIBUTING）：`npm run check`、`npm test`、`npm run docs:check`、`node scripts/check-metadata.mjs` 全绿；新增矩阵用例全绿；无真实上游调用；日志脱敏；`forward.js` 差异 < 80 行。先写失败复现（现有实现把 `session-id`/`chatgpt-account-id` 透传给第三方）再改代码。

### E1-b 聚合 ID 严格不回退

- `src/router.js`：识别聚合保留前缀（如 `mg/`）→ 命中字典即返回；未命中**直接** `unknown_model` 错误（附可用 ID 列表），绝不落 defaults.provider；旧接口行为保持不变（用独立分支）。
- 回归：`offline/model-resolution.test.mjs` 增补聚合 ID 用例（存在/下架/大小写/同名不同源）。

### E1-c 官方目标 host/path 白名单（默认 fail-closed）

- 新增 `src/codex/auth.js`：官方目标 host 白名单（`chatgpt.com`/`api.openai.com` 等，实际清单以 E3 核查后的官方文档为准）、禁用重定向、路径前缀校验；来源不可信 → 明确错误码。
- 官方凭据实际透传**暂不启用**：D1-A 政策/条款核查未完成前，只实现"拒绝不安全路径"，不实现"真实透传"。

**回滚**：E1 全部为纯增量模块 + 局部函数改动，按 commit 粒度 revert 即可；不涉及数据/配置迁移。

**风险**：`chatgpt-account-id` 的实际作用域需在 E3 用真实登录确认（本轮只有代码级推理）；白名单过严可能误伤合法中转（用配置开关 + 默认拒绝）。

---

## 9. 风险登记（截至 E0）

| 级别 | 风险 | 说明 | 缓解 |
| --- | --- | --- | --- |
| P0 | 官方订阅流量经本地网关的条款/政策边界不明 | D1-A 前提未核实；计划 §3.1 明确"不明确则不执行真实透传" | E3 前单独提交条款核查结论与授权申请；默认保持官方直连 |
| P0 | v2 加密任务跨供应商不可读 | 原生 `agent_message` 密文经第三方线路重放可能持续失败 | E4 显式阻断 + 证据；不猜测/不删密文 |
| P0 | 工具副作用重放 | 429/5xx ≠ 安全重放 | E5 状态机 + 工具侧效应门 |
| P1 | 目录整体替换语义导致误删官方模型 | 本地 catalog 必须含官方全量 | E2 校验闸门 + 版本化 + 回滚 |
| P1 | Desktop 单实例单 provider | 已由 2026-11-10 证据确认 | 只承诺 CLI 路径；Desktop 需独立实例方案再验证 |
| P2 | 单轮 59KB 固定载荷放大第三方成本 | 计费按官方价目不可直接套用 | E5 预算按字节/轮估算 |

---

## 9.5 复现命令（E0 全部证据）

```bash
# 仓库/PR
git -C workplace/idproject/model-gateway fetch --all --prune
/home/xiaomengxizi/.local/bin/gh pr list --repo xiaomengxizzh/model-gate --state all --json number,title,isDraft,state,headRefName,headRefOid

# 基线门禁（在 model-gateway-codex-agg 工作树）
npm test && node scripts/check-ui.mjs && node scripts/check-docs.mjs && node scripts/check-metadata.mjs

# 目录契约
CODEX_HOME=/tmp/mg-e0/codex-home codex debug models > /tmp/mg-e0/catalog-default.json
CODEX_HOME=/tmp/mg-e0/codex-home codex debug models -c 'model_catalog_json="/tmp/mg-e0/catalog-synth.json"'

# 隔离网关（18787 无占用，跑完即退）
MG_CONFIG_DIR=/tmp/mg-e0/gw-config MG_KEYS_MASTER=e0-isolated-master node src/index.js   # server.port=18787

# 请求头探针：本地 mock :19000 + codex exec --ephemeral --sandbox read-only -c model_providers.probe.*
```

## 10. NOT_RUN（本轮明确未做）

- 真实官方登录 / `auth.json` 使用 / `chatgpt-account-id` 实测
- 真实付费上游调用（OpenCode Go 等）
- Codex Desktop 启动与第二 `CODEX_HOME` 端到端
- 真实工具执行（bwrap user namespace 在本机不可用）
- 正式 `config.toml` 写入、历史迁移、服务重启、PR 合并、部署

---

## 11. 授权请求（进入 E1 的前置）

需要所有者**逐项明确**：

1. 是否授权在 `dev/codex-aggregation-20261111` 实现 **E1-a/E1-b/E1-c**（纯本地代码 + 离线测试，不接真实上游、不写正式配置）？
2. 是否另行授权 **E3 所需**的官方登录透传政策核查 + 隔离 `CODEX_HOME` 真实登录测试（会产生真实官方请求）？
3. 真实付费调用（OpenCode Go 等）是否授权、上限多少？
4. Desktop 端到端测试是否授权？
