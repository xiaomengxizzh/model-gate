# 回滚与降级开关（2026-11-11 加固轮 · M5-3）

本页只写**回滚点、回滚命令、回滚后的门禁、降级/禁用开关**。安装、升级、配置备份、systemd 与停机语义见
[安装、升级与回滚](deploy-and-rollback.md)；逐能力验证状态见[支持矩阵](../roadmap/2026-11-11-support-matrix.md)。

> 记一条贯穿全页的纪律：**来源就位 ≠ 已部署，mock 全绿 ≠ 真实接入通过**。
> 回滚或关闭任何开关后，都要重新跑门禁并把"执行命令 + 末尾输出 + 未验证项"写进记录，不要只写"已回滚"。

## 1. 回滚点

仓库**没有发布 tag**（`git tag` 为空），一律按提交 sha 回滚。本轮完整里程碑列表见
[支持矩阵](../roadmap/2026-11-11-support-matrix.md) §0；本页只挑 4 个常用回滚点并写明各自门禁。

| 回滚点 | SHA | 含义 | 回滚到这里的后果 |
| --- | --- | --- | --- |
| 远端 main | `6bc6441` | 本轮开始前的远端 main | 丢掉本轮全部加固交付（调度证据化、账本、UHR 契约/回执、MCP mock、支持矩阵） |
| 基线采纳 | `64a5c96` | 加固轮起点（ff #5+#6，真实祖先链） | 回到本轮之前，仅保留历史聚合/网关能力 |
| Key 三态 | `dacc564` | M0-2/P0-1 数据面 Key 三态 | 回到"Key 未分态"的入口行为，需重验数据面 Key 判定 |
| 入口收口 | `9ebb2d5` | M4-1b（P0-2 入口收口） | 回到自管 apply/rollback 入口开放前的状态 |
| 最终交付 | `<最终集成 SHA，见交付报告 R01>` | R01 交付点 | 回到本轮最终状态；本页所有门禁预期值按此点书写 |
| 本分支自测锚点 | `a7b969e`（M4-3a）→ `cdb13e3`（矩阵同步） | 本卡所在分支 `work/d` 的提交 | **不是发布里程碑**，只用于核对"本卡验收时的树" |

回滚前先记录现场：

```bash
DEPLOY=/opt/model-gateway            # 按实际部署路径改写
git -C "$DEPLOY" rev-parse HEAD       # 当前提交 = 你的回滚起点
git -C "$DEPLOY" status --short       # 有未提交改动先停下确认来源
git -C "$DEPLOY" log --oneline -10    # 找到要回滚到的里程碑
```

### 1.1 关键里程碑：回滚到此处后跑什么

四个最常用回滚点各自的门禁（"五条"指 §3 的 `node --version` / `npm run check` / `node scripts/test/run.mjs` /
`npm run docs:check` / `node scripts/check-metadata.mjs`）：

| 回滚到 | 必跑门禁 | 额外核对 |
| --- | --- | --- |
| `64a5c96`（基线采纳） | 五条（该点套件很少，摘要行以当次输出为准，**不要拿 59 套件去比**） | 确认 runner 是旧格式（`Isolated suites: n/n passed`）时不要误判为失败；`/healthz` 与 `/v1/models` |
| `dacc564`（Key 三态） | 五条 + `offline/admin-origin`、`offline/admin-secrets` | 数据面 Key 三态（缺失/错误/有效）行为、`MG_CLIENT_KEY` 设置后的 401/200 判定 |
| `9ebb2d5`（入口收口） | 五条 + `offline/admin-entry`、`offline/codex-api` | 确认自管 apply/rollback 在**普通产品模式仍是 DISABLED**（C7），fixture 模式才可用 |
| `<最终集成 SHA，见交付报告 R01>`（交付点） | 五条（期望 59 套件 / 562 pass / 0 fail / 1 skip、docs 60 files/213 links、metadata 32 checks） | 与[支持矩阵](../roadmap/2026-11-11-support-matrix.md) §0 的数字逐项对齐 |

## 2. 回滚命令

**方式一（推荐）：反向提交，保留历史与审计链**

```bash
# 逐个 revert 需要撤销的提交（从新到旧），避免一次性冲突
git -C "$DEPLOY" revert --no-commit <sha 较新> <sha 较旧> ...
git -C "$DEPLOY" status --short
git -C "$DEPLOY" commit -m "revert: 回到里程碑 <目标 sha>（原因：<触发条件>）"
```

冲突时 `git -C "$DEPLOY" revert --abort`，改用"切回上一份版本目录/软链"的方式（更适合多版本目录部署），不要硬 reset。

**方式二：仅限独立部署目录、且确认没有他人未提交改动**

```bash
git -C "$DEPLOY" reset --hard <目标 sha>
git -C "$DEPLOY" status --short       # 必须为空
```

**禁止**在共享工作树上 `reset --hard`：共享树里可能有其他协作者的未跟踪/未提交文件，reset 会直接吃掉。
配置与凭据的回滚（`gateway.local.json` / `keys.local.json` / `stats.json`，以及主密钥必须与加密库成对恢复）
按[安装、升级与回滚](deploy-and-rollback.md) 的「回滚」小节执行。

## 3. 回滚后的门禁

任何回滚都必须重跑这五条（顺序固定，任一失败就停）：

```bash
node --version                       # 必须 >= 18
npm run check                        # 语法自检，不起服务
node scripts/test/run.mjs            # 期望摘要行 "suites: <N> passed, 0 failed, ..."（本交付点 59 passed / 562 pass / 0 failed / 1 skip），退出码 0
npm run docs:check                   # 期望 "Documentation paths: PASS"（交付报告记录 60 files / 213 links；脚本只打印 PASS）
node scripts/check-metadata.mjs      # 期望 "Metadata: PASS (32 checks)"（本交付点；分支/旧里程碑的文档更少，数字会更小，PASS 才是判据）
```

判读规则：

- 摘要行格式为 `suites: <N> passed, 0 failed, ...`（本交付点：**59 passed / 562 pass / 0 failed / 1 skip**，
  其中 1 skip 是 `MG_CODEX_VERIFY=1` 门控的真实 CLI 用例）。若看到旧的 `Isolated suites: n/n passed`，
  说明跑的是 M0-1 之前的旧 runner，以实际输出为准。
- `<N>` **随分支/里程碑变化**：57 是**本交付点**的数字，不是永久常量。不要在任何脚本或文档里把 `N` 写死，
  回滚后必须重新读输出；`N` 变小且不是因为回滚目标本身就少套件，说明有交付被意外丢弃。
- 回滚后如涉及配置目录，先按 deploy 文档做一次隔离实例启动体检：`/healthz` → `ok`、
  `/v1/models` 模型清单符合预期、`/api/status` 的 `configVersion` 与备份一致（`configVersion` 是并发冲突检测，
  **回滚不会回退它**）。
- 记录：回滚原因、时间、回滚前后 sha、执行命令、五条门禁的末尾输出、未验证项。
  特别标注"本次没有验证真实上游/真实客户端"，不要用 mock 全绿代替。

## 4. 降级与禁用开关

原则：**能逐层关、关掉后行为明确、风险写在开关旁边**。下表"默认值"即是当前仓库/配置的现状。

### 4.1 智能调度（决策器换模型/重试）

| 项 | 内容 |
| --- | --- |
| 客体 | `src/routing/decision.js` 驱动的自动换模型、同上游重试、阶段机重放保护、D7 官方池闸门 |
| 默认值 | `defaults.codexFallback = false`（`docs/reference/configuration.md`）；但**聚合 slug（`mg-*`）与官方 slug 会自动启用** |
| 关闭方法 | ① 保持 `codexFallback:false`；② 不配置聚合目录绑定、不使用 `mg-*` slug；③ 用显式 provider 链（`models` 别名直接指向某个 `providers.<pid>`），让请求不经决策器 |
| 关闭后行为 | 回到旧 `forwardChain`：仍是显式链式兜底与本地重试，但**没有**阶段机重放保护、D7 官方池自动停机与候选证据化排序 |
| 打开（启用）的风险 | 会自动换模型/换上游并产生额外调用与计费；官方池依赖 D7 闸门与身份域兜底，不等于零风险 |
| 验证 | 隔离实例 `/v1/models` 不含 `mg-*`；`node scripts/test/run.mjs` 全绿（决策器相关：`offline/routing-decision` 20、`offline/codex-fallback` 29、`offline/codex-fallback-forward` 10） |

### 4.2 预算账本强制（费用上限）

| 项 | 内容 |
| --- | --- |
| 客体 | `src/routing/ledger.js` + `facts.budgetFromLedger()` → 决策器 `budget` |
| 默认值 | **未接线**：`src/forward.js` 的 `codexBudgetOf` 仍把 `spent` 恒填 0，`taskUsd`/`dailyUsd` 当前不生效（支持矩阵 B7/B8） |
| 关闭方法 | 当前"关闭"就是现状：不接线、不配置 `codexBudget.taskUsd/dailyUsd`、不注入账本。将来接线后的开关是 `defaults.codexBudget.enforceUnknownCost`（默认 `false`，即未知报价不 fail-closed）与各维度 caps（0 = 不限） |
| 关闭后行为 | 费用上限**无法强制**；未知价格不会被拒绝；只能靠 `requestUsd` 单请求估算闸门与额度软限制。必须显式声明"费用不设防"，不得对外宣称"已限费" |
| 打开（启用）的风险 | 账本目录不可写、跨进程锁等待超时会**拒绝请求**（fail-closed）；`dailyUsd` 按固定时区日切记账，实际超预估会如实记账并封顶后续消费（可能让当天余下请求全部失败） |
| 验证 | 模块能力：`offline/routing-ledger` 14（整数/币种/幂等/未知/超支/跨日/并发/重启/脱敏）；接线端到端：**NOT_RUN**，接线后需新增断言 |

### 4.3 管理面写入口

| 项 | 内容 |
| --- | --- |
| 客体 | `/api/config/save`、`/api/config/reload`、`/api/admin-token`、`/api/keys` 等管理写操作 |
| 默认值 | 未设 `MG_ADMIN_TOKEN` 时：本机回环可用，**远程匿名读写一律 403** |
| 关闭/收紧方法 | ① 设置强 `MG_ADMIN_TOKEN`；② `server.host` 保持 `127.0.0.1`（不要绑 `0.0.0.0`）；③ 反向代理层对 `/api/*` 的写方法直接拒绝；④ 不把管理端口映射到非回环 |
| 关闭后行为 | 面板与远程运维不可用（这是有意的）；数据面 `/v1/*` 不受影响 |
| 打开（放宽）的风险 | 只有一把令牌 = 全量管理权限（配置、Key 元数据、模型测试）；令牌存加密 keys 库，重启不失效；泄露即等于面板完全暴露 |
| 验证 | `offline/admin-origin` 4（回环放行/跨源与坏 Host 拒绝/非回环匿名 403）、`offline/admin-secrets` 1（不泄露明文凭据）、`offline/admin-contract` 2 |

### 4.4 MCP ↔ UHR 委派

| 项 | 内容 |
| --- | --- |
| 客体 | `src/mcp/uhr-adapter.js` + `src/mcp/uhr-mock.js`（隔离目录，当前无 HTTP/工具注册入口） |
| 默认值 | **未接线**（默认不可用） |
| 关闭方法 | 不导入 adapter、不注册任何 MCP 工具、不暴露 stdio/HTTP 入口；若未来接线，删除注册并停用对应连接 |
| 关闭后行为 | UHR 委派不可用（调用方会收到明确的"无此工具/未接线"，不是静默降级） |
| 打开（接线）的风险 | 会把有界任务摘要与不透明引用送出进程边界；必须保持只读意图、引用白名单、预算上限与归属校验，否则等于把对话/路径外泄 |
| 验证 | `offline/mcp-uhr-contract` 15（作用域/只读意图/引用白名单/预算/幂等/取消/归属/callId 回填/脱敏）；**无运行时入口，因此没有"运行时拒绝路径"可断言**（诚实标注） |

### 4.5 受控官方聚合实验

| 项 | 内容 |
| --- | --- |
| 默认值 | 关闭（不配置聚合目录/官方 slug） |
| 关闭方法 | 不配置聚合目录绑定；不在客户端使用 `mg-*` slug |
| 关闭后行为 | 智能调度不参与，回到显式链 |
| 打开的风险 | 真实换模型/换上游、可能跨身份调用；仅在隔离回环 + 本地 mock 的测试入口里验证过（`offline/codex-fallback-forward` 10） |
| 验证 | 同上 + `docs/reference/configuration.md` 的 `codexFallback` 默认值 |

### 4.6 新控制台默认入口

| 项 | 内容 |
| --- | --- |
| 默认值 | `/ui-next` 可用但**不是默认入口**；`/` 与 `/admin` 保留 |
| 关闭方法 | 不对外公布 `/ui-next`、不在客户端配置里写它 |
| 关闭后行为 | 使用旧管理台 |
| 打开（设为默认）的风险 | 面板保存会**整体替换** `providers`/`models` 两段（deploy 文档已写明），误操作会改掉真实路由 |
| 验证 | `offline/ui-next` 2（静态树/CSP/遍历防护）、`offline/ui-contract` 2 |

## 5. DISABLED 入口的拒绝路径（必须有测试）

| 入口 | 拒绝行为 | 证据 |
| --- | --- | --- |
| 原生 v2 密文跨域 | 400 `v2_encrypted_task_unsupported`，不解析、不删除、不伪造密文，也不降级到 v1 | `offline/codex-interop` 15、`offline/responses-mapping` 17、`offline/mcp-uhr-contract` 15（`UHR_REJECT_V2_OPAQUE`）、真实实测 `docs/evidence/2026-11-11-e4-v2-live-blocked.md` |
| 官方订阅候选进入通用池 | 硬过滤 `reasons=['official_subscription_excluded']`，不进 fallback 池 | `offline/routing-decision` 20、`offline/codex-fallback` 29 |
| 官方额度耗尽后的自动换池 | 未确认应急 ⇒ `MG_FB_OFFICIAL_QUOTA` 停机（含 evidence/legacy 双形状与身份无法证明的 fail-closed） | `offline/routing-decision` 20、`offline/codex-fallback` 29 |
| 远程匿名管理读写 | 403（跨源/Host/非回环） | `offline/admin-origin` 4、`offline/admin-secrets` 1 |
| 未接线的预算账本 | **不是拒绝路径**：模块未接进 `forward.js`，属 `NOT_RUN`，不得写成"已禁用"或"已生效" | 支持矩阵 B7/B8；`offline/routing-ledger` 14 只证明模块能力 |
| 未接线的 MCP 委派 | 没有运行时入口，因此**没有**运行时拒绝路径可断言；模块边界拒绝由 `offline/mcp-uhr-contract` 15 覆盖 | 同上 |

## 6. 不要做的事

- 不要用 `reset --hard` 处理共享工作树；不要在回滚后把旧套件数写死进断言。
- 不要用环境变量/配置绕过 v2 密文拒绝（那是硬边界，需单独授权与设计）。
- 不要为了让"费用上限看起来生效"去改 `src/forward.js`；接线属于 M1-3a 的写集，必须带账本 receipt 与`可能已提交 ⇒ 对账`语义。
- 不要把 `PASS(mock)` 写成 `PASS(real)`；支持矩阵里 `PASS(real)` 本轮为 0 行。
- 关闭/降级后仍要跑 §3 的五条门禁，并记录"未验证项"。
