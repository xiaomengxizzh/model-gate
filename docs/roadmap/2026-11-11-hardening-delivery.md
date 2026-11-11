# ModelGate 加固循环交付报告（M0–M5 / R00–R01）

- **run_id**: `modelgate-hardening-a1`
- **交付模式**: `DELIVERY=local` —— 仅本地集成分支与候选提交；**未 push、未开/改 PR、未合并远端 main**（本轮无远端写授权动作发生）。
- **时间**: 2026-11-11 21:58 → 2026-11-12 01:2x（Asia/Shanghai，+0800），跨午夜。
- **集成分支**: `dev/modelgate-hardening-a1`
- **R00 受审交付点（代码）**: `2d82ea2e663db5726c866fa261be36fc09f8d8b3`
- **最终 HEAD**: 本报告与其数字校正所在的 docs-only 提交（父提交即上面的受审交付点；两者之间无代码差异）。
- **基线**: 远端 main `6bc6441`（实时 `ls-remote` 核对一致）→ 基线采纳 `64a5c96`
- **开发模型**: 全队（队长 + A/B/C/D/E）均为 `opencode-go/deepseek-v4.1-flash`，请求 `reasoningEffort: high`。实际生效取舍由 harness 记录；本轮无独立遥测，**实际生效力度/上下文记为 UNKNOWN**。

## 1. 权威门禁数字（绑定受审交付点 `2d82ea2`）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 套件 | `node scripts/test/run.mjs` | **59 套件 / 564 pass / 0 fail / 1 skip**，exit 0（49.6s） |
| 语法/UI | `npm run check` | exit 0，UI modules 16/16 |
| 文档 | `node scripts/check-docs.mjs` | exit 0，PASS（60 files / 213 links） |
| 元数据 | `node scripts/check-metadata.mjs` | exit 0，PASS（32 checks） |
| 清单不变量 | 磁盘 `offline/*.test.mjs` vs `SUITES` | 56 = 56，`missing=[] ghost=[] duplicates=0` |
| 纯检出 | `git archive` → 无 `.git` 目录 | 上述四命令逐项一致（E 独立复跑） |

唯一 skip = `MG_CODEX_VERIFY=1` 门控的真实 Codex CLI 用例（默认不跑，见 §5）。

## 2. 三个 P0 的收口证据

| P0 | 缺陷 | 收口点 | 证据（独立 QA 亲手验证） |
| --- | --- | --- | --- |
| **P0-1** | 省略 `defaults.clientKey` 的保存会删除加密 `__mg_client`，重载后无凭据即可调用数据面 | `dacc564`（M0-2）+ `695b346`（M0-3） | HTTP 级三态表：不带 defaults / `{defaults:{}}` / 掩码（含空白）⇒ **keys 字节不变、旧 Key 仍 200**；`''` 才清空；非法值 400 且零落盘；日志无 `sk-` 哨兵。同类缺陷 `virtualModels` 省略式清空（会让过期 Key 复活）在 `695b346` 一并修复并复验仍 401 |
| **P0-2** | `/api/codex/*` 复用"无 token 即放行"的本地信任域，preview 回显保留行原文，apply/rollback 只部分校验路径 | `7b2b531`（M4-1a 模块）+ `9ebb2d5`（M4-1b 入口） | 模块侧：每路由 `explicitAdmin`、只收不透明 `root`/`backupId`、plan 只回 `{field,from,to,redacted,owner}`、普通模式写入口 `403 write_disabled`、confirmToken 绑定管理员+文件+代际+TTL。入口侧：**无令牌 + 1MiB 声明 body 立即 403 且未读 body**（不是 413）；跨源/非回环 403；有效令牌回环同源 200 且响应/日志无令牌 |
| **P0-3** | 官方目录 slug 只验证目标存在；授权检查用拼装前信息，实际发送另行构造 URL | `ea6e27f`（M2-1 记录）+ `a5a5c97`（M1-3a/b 接线）+ `2d82ea2`（M1-3c 补齐） | 授权记录冻结目标并 `assertSendTarget` 二次校验（改实发 ⇒ `send_target_drift` 403）；非规范形状（baseUrl `?`/`#`、pathPrefix `?`/`#`/`//`/`..`/非 `/` 开头/前缀重复）**发送前 403、上游零命中、账本零残留**；官方 Chat 走 config-declared 世代仍 200；目录 slug 缺 record ⇒ 403 `catalog_generation_missing` 零命中 |

## 3. 逐卡结果

状态口径：`PASS` = 作者自检 + 独立 QA 或 lead 复跑有据；`部分` = 模块交付但生产入口未接；`BLOCKED` / `NOT_RUN` 见 §5。

| 卡 | 角色 | 状态 | 关键交付 |
| --- | --- | --- | --- |
| P00 现场冻结 | lead + E | PASS | refs/worktrees/版本/资源盘点；E 独立复核 FAIL→两项阻塞分派关闭；用户现场 4 条未跟踪全程不变 |
| M0-1 / M0-1b / M0-1c | A | PASS | 离线入口改**显式清单 + 白名单环境 + 每套件独立 HOME/TMPDIR + 超时与进程组回收**；live runner 改正向白名单（denylist 降为第二道闸）；E 的拼接/大小写/base64 三种绕过全部失效 |
| M0-2 / M0-2b | A | PASS | **P0-1**；Key 三态用原始补丁判定（早于 defaults 合并）；过期时间后端单一真源（非法值 400、不落盘）；虚拟模型元数据三态 |
| M0-3 | A | PASS | 配置与 Key **同代际事务**（journal + commit marker + 原子 rename + fsync）；9 个注入点 + 真实 SIGKILL/启动自恢复/外部修改 409 保留现场/锁竞争 0600；**两文件始终成对，无混合代际** |
| M0-4 | C | PASS | docs/metadata/CI 门禁纯检出可判定；E 对抗证明门禁非空转（删 PR 触发/塞 setup-node/塞 schedule 均 exit 1） |
| M1-1 | B | PASS | 单调 deadline + 尝试状态机；**写开始即 SENT_UNKNOWN**；写后无头/收头后 5xx/断流/工具风险一次终态；429 保留 Retry-After 且不越 deadline |
| M1-2 | B | PASS | SSE 流式解码（UTF-8 跨 chunk、CRLF/LF/CR、单帧 1MiB/缓冲 2MiB 上界）；item id 贯穿；callId 不串线；桥默认严格 + 显式有损；`nativeContract` 驱动原生分支 |
| M1-3a/1-3b/1-3c | B | PASS | **生产发送层切到 `execute/forwardOnce`**；发送前授权断言（P0-3）+ 账本预留；候选能力改事实证据；裁决目标 = 上游实际目标；`index.js` 注入 catalogRecord/ledgerOptions；非规范目标形状发送前拒绝 |
| M1-4a | A | 部分 | 可选端点统一策略入口（未证实能力默认 501 关闭）+ 视频"先落 PENDING_SEND 再发上游"幂等（并发单次/主体隔离/重启不重发）。**入口接线未做** |
| M2-1 | C | PASS | `target-authz`：一次规范化 + 冻结 + `assertSendTarget`；第三方头从空白构造 + HMAC 域派生会话；订阅身份禁止用于计费路径 |
| M2-2 | C | PASS | 目录世代：wire 配置指纹入 cache key、同世代三元同源、CAS 发布保旧代、零碰撞 fail-closed、第三方不再继承官方模板行为字段、能力需 `evidence{source,observedAt}` |
| M2-3 | C | **NOT_RUN** | 真实 Codex CLI 三轮回环双 mock 未取得确定性结果；见 §5 重开条件 |
| M3-1 / M3-1b | D | PASS | 证据化候选选择（能力/健康/价格/授权各自带来源与时间）；官方订阅排除出通用池；稳定排序与脱敏 audit；legacy 伪造能力在混池中失效；D7 身份闸门归一化（不能证明"非官方"就不许自动离开官方池）；`MG_FB_BUDGET_EXCEEDED` |
| M3-2 | D | PASS | 持久预算账本：micro 整数 + 显式币种、单写者 + `O_EXCL` 跨进程锁、`(requestId,digest)` 幂等不双记、未知用量不归零、超预估封顶后续消费、固定时区跨日、脱敏落盘 |
| M3-3 | B（并入 M1-3a） | 部分 | reserve→send→settle/release/markUnknown 已接；`STOP_RECONCILE` 已接；**账本默认未配置时**仅在有费用上限时拒绝发送（默认部署不启用账本） |
| M4-1a/1b | C | PASS | **P0-2** 模块 + 入口 |
| M4-2 + U1 | A | PASS | 控制台状态完备（loading/empty/unknown≠0）、**401 才锁屏**、功能级 403 局部可重试、409 逐字段保留草稿、导出仅客户端字段、旧 `/admin` 保留；E 真机 17/17 + `ui-browser-check` 14/14 + 4 类反例未击穿 |
| M4-3a | D | 部分 | 历史只读（根登记、零写入 hash/mtime/目录清单前后一致、有界截断不静默、迁移只产导出计划）；额度三态 fresh/stale/unknown（边界相等算 fresh、未知不伪装 0%/100%、不足不自动切身份）。**管理路由接线未做** |
| M5-1 | D | PASS | UHR 推理回执契约：`SENT_UNKNOWN/STOP_RECONCILE` 恒 `unknown`、`ROUTE_MISMATCH`、脱敏 hashRef 可复算、三层冻结 |
| M5-2 / M5-2b | D | PASS | 本地 MCP 委派 + mock UHR（真实临时目录落盘、重启可查、幂等/取消/归属、摘要硬上限默认拒绝、空 toolCallId 拒绝、v2 键级边界契约） |
| M5-3 | D | PASS | 支持矩阵（PASS(mock) 25 / **PASS(real) 0** / NOT_RUN 10 / BLOCKED 1 / DISABLED 9）+ 回滚与降级开关文档 |
| R00 | E | PASS（受审点） | 纯检出四命令 + 清单不变量 + 接线黑盒 T1–T7 + 浏览器绑定最终 SHA + 回归抽样 3/3。首次 R00 判 FAIL（文档数字过期、T3 漂移）→ 修复后复验 |
| R01 | lead | PASS | 本报告 + CHANGELOG + 数字校正 |

## 4. 独立 QA 的对抗结果（摘要）

E 全程以"不信作者声明"的方式独立构造反例，被推翻并修复的宣称包括：

1. **"新增同类脚本不可能再被选中"**（M0-1b denylist）——用字符串拼接/大小写/base64 三种注入全部绕过；改为**正向白名单**后三种注入全部失效，且"把危险文件加进 allowlist"仍被第二道闸拦下。
2. **"能力伪造已修"**（M3-1）——legacy 形状下候选顶层 `tools` 仍被采信，且生产唯一模式就是 legacy（`forward.js` 复制请求工具）；改为混池规则 + 生产候选改事实证据。
3. **"D7 官方额度闸门已归一"**（M3-1）——evidence 形状官方候选遇 402 直接 failover（授权放宽）；改为 `identityOf` 单一入口，"不能证明非官方就不许离开官方池"。
4. **"adapter 契约不可破"**（M1-1）——adapter 写后抛 `ECONNRESET` 但不调 `onWriteBegin` ⇒ 真实重放 sends=2；改为执行器自身在真实 write 前置位 + 强制 adapter 工厂。
5. **"单行超长正文会被拒绝"**（M5-2）——5000 字符单行被裁剪后照常提交；改为超硬上限默认拒绝、裁剪需显式开关。
6. **"授权漂移零发送"**（M1-3a）——5 种非规范配置全部 200 且命中 1；补齐发送前形状拒绝后为 403/零命中/零账本残留。
7. **门禁覆盖空洞**（R00 preflight）——`codex-target-authz.test.mjs`（P0-3 的正式断言 9 项）在磁盘但**从未登记进清单**，因此 `npm test` 从未执行它。补登记后 57→59 套件。
8. **文档与实测不符**（R00）——矩阵/回滚文档数字过期、回滚文档期望输出格式过期；已按实测改正。

## 5. 未执行项与重开条件（NOT_RUN / BLOCKED / 部分）

| 项 | 状态 | 原因 | 重开条件 |
| --- | --- | --- | --- |
| 真实 Codex CLI 三轮回环双 mock（M2-3） | NOT_RUN | 本轮未在空 HOME/合成身份下取得确定性三轮结果 | 在可隔离主机上，`env -i` + 临时 HOME/`CODEX_HOME` + 合成 Key + 回环双 mock，三轮同一 thread 并逐轮断言模型/上游/工具配对/目录来源/完成事件 |
| 真实官方上游 / 真实第三方上游 | NOT_RUN | 零真实产品上游预算；需独立授权 | 独立授权 + 真实账号 + 出网；先以双 mock 通过为前提 |
| Desktop GUI | NOT_RUN | 本轮未启动桌面客户端 | 独立 profile + 保证回环 + 真实 GUI 手测 |
| 真实 UHR 委派 | BLOCKED | 需读到现行授权接口与明确写集 | 拿到 UHR 授权接口契约与写集后另开分支 |
| 原生 v2 密文跨域 | DISABLED（拒绝） | 跨域前拒绝是既定安全边界 | 需供应商公开支持 + 真实闭环证据 |
| 可选端点入口接线（M1-4b） | 部分 | 模块与断言已交付，`index.js` 仍走旧 create 流程 | 把 `createVideoTask` 换成 `VideoTaskStore.create`、四端点切 `createOptionalEndpointPolicy` |
| 历史/额度管理路由（M4-3b） | 部分 | 模块已交付，无管理路由与 UI | 在 `/api/codex/*` 下加只读投影路由，复用 M4-1a 的登记根 |
| 账本默认启用 | 部分 | 默认不配 `routing.ledger` 时不记账；配了费用上限而不配账本则拒绝发送 | 部署侧配置 `cfg.routing.ledger` 后即生效 |
| `live.mjs` 全量 | NOT_RUN（纪律） | 会读取真实凭据/真实上游 | 单独授权 + 场景白名单 |
| 远端 CI / PR / 合并 | NOT_RUN | `DELIVERY=local`，无远端写授权 | 授权 `draft-pr`/`merge-main` 且远端检查可读 |
| 掉电持久性 / NFS 锁语义 | NOT_RUN | 只验证原子写与重启读回 | 断电注入设备 / 共享文件系统 |

## 6. 回滚点

| SHA | 含义 | 回滚后须复跑 |
| --- | --- | --- |
| `6bc6441` | 远端 main（本轮基线起点） | 与本轮无关，作为最终下界 |
| `64a5c96` | 基线采纳（ff #5+#6，保留真实祖先链） | 五条门禁（该点套件很少，别拿 59 去比；runner 为旧格式） |
| `dacc564` | P0-1（Key 三态）收口点 | 五条 + `admin-secrets`/`key-tristate` + 数据面 Key 三态手验 |
| `9ebb2d5` | P0-2（管理面入口）收口点 | 五条 + `admin-entry`/`codex-api`，并确认产品模式写入口仍 DISABLED |
| **`2d82ea2`** | **R00 受审交付点**（代码） | 五条 + 与支持矩阵 §0 数字逐项对齐 |

`git revert` 命令与每个点的预期输出见 [回滚与禁用](../how-to/rollback-and-disable.md)。**共享工作树禁止 `reset --hard`**。

## 7. 风险与已知限制

1. **`capability_evidence_missing` 是行为变更**：既有配置里若写了非保守 `codex.capabilities`/`multiAgentVersion`/`toolMode`/`webSearchToolType`/`experimentalSupportedTools` 而无证据，目录生成会 fail-closed。迁移做法见 [配置参考](../reference/configuration.md)（补 `codex.evidence.<同键> = {source, observedAt}` 或删除未证实字段）。
2. **`/api/codex/*` 需显式管理员令牌**：依赖"本机无 token 也能管"的旧习惯会 403。
3. **面板 trim 与 API 不 trim 的差异**已被修复（掩码容忍空白），但同类"面板/API 语义一致性"仍建议持续抽查。
4. **M2-2 零碰撞错误信息会回显模型名原文**（E 发现，P2）：模型名不是凭据，但若有人把秘密写进模型名会外泄；未修，记录为已知项。
5. **`codex-catalog-coherence`/`codex-routing-catalog` 的 200 断言依赖目录 record 注入**：若将来去掉注入，这两处会 403（设计如此）。
6. 配额数字随分支变化，**不得写死**（文档已注明判读规则）。

## 8. 过程偏差（如实披露）

1. **E 在 M0-1c 复核中误执行了一次 `MG_ALLOW_LIVE_TESTS=1 live.mjs`**：因内联补丁引号错误未生效。实际执行的是 27 个白名单内自包含套件（本地 mock + 动态回环端口），**无真实上游、无真实凭据、未触达 8787、无文件改动**；随后用独立补丁脚本重做取得确定性结果。已记录在案。
2. **B 在 M1-3b/M1-3c 对 `src/forward.js` 做了写集外的最小顺序调整**（注入接线 9/-6；授权校验前置到 reserve 之前），均在回执中主动披露，理由成立（不前置就无法满足"403 时零 attempt"）。
3. **lead 两次给出过错误数字**（把 `fbeda55` 的 52/465 说成 `2f809c4` 的数；漏登记 `codex-target-authz`），均由 E 的对账纠正，已修正并在账本留痕。
4. **lead 一处标准定错并自行纠正**：曾要求"官方目标缺 catalog record 一律 fail-closed"，会导致所有普通官方 Chat 403；纠正为"目录参与才强制 record，普通官方 Chat 用 config-declared 世代但仍产出授权记录"。
5. 写集审计（A 独立机械核对）：**越界项 0**；共享/禁改项零违规；3 处同里程碑相邻模块变更判为非越界。

## 9. 远端动作

**无。** 未 push 任何分支、未创建/更新 PR、未合并远端 main、未 tag、未改分支保护。所有交付物仅存在于本地集成分支与本地运行目录。
