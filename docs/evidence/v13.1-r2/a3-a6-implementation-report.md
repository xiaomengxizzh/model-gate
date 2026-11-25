# V13.1 A3–A6 功能闭环报告（真实场景除外）

- 日期：2026-11-24
- HEAD：`48325bf0027e583108c66677c7dec15fd5007228`（工作树未提交）
- 最终代码指纹：`4ab8600e166a1957eca890b6a21ebb39e7347b1558b88f26214a5a4488012834`
- 指纹：`scripts/tree-fingerprint.mjs`，175 个源码/测试/浏览器文件，`sha256(relative path + NUL + bytes)`。
- 结论：**A3/A4/A6 核心功能已接线并通过真实 HTTP + 真实浏览器 + fixture；A5 代码路径通过 fixture，真实 Codex GUI/服务 BLOCKED。整体目标尚未完成。**

## 2026-11-25 最终门禁补充

- `npm test`：183 suites / 1624 passed / 3 skipped / 0 failed。
- `node scripts/e2e/ui-v13-quality.mjs`：171/171 PASS，真实 Chrome 153，最大路由 1028.9ms、long task 790ms。
- `node scripts/e2e/ui-v13-screen-reader.mjs`：39/39 PASS，真实 Orca 50.2 + AT-SPI 2.60.4，66 条实际语音输出。
- 服务与连接凭据弹窗已改为预览→确认安全保存；`ui-v13-browser.mjs` 完整旅程与 266+72 矩阵通过。AI 视觉联络表检查 100 个当前样本，无阻断性重叠/裁切；人工签收未做。
- MG-R009 单进程双身份隔离、持久 Operation/Preview/取消、DNS 解析固定、旧配置/Key 预览确认、U04 在途删除保护均接入真实 API。
- 安全审计修复：租户嵌套环境凭据拒绝、连接/策略预览秘密掩码、锁内 CAS、租户日志轮转、操作临时文件恢复、native 预演目标解析；新增 4 个安全套件并纳入显式清单。
- 仍未完成：V07 权威 35 条输入、真实场景与人工签收。

## 1. 已交付功能

### A3 服务、连接、模型、模板

- 稳定 `serviceId`、`connectionId`、`modelId`；旧 provider/model 保持兼容投影。
- 服务创建/编辑/启停/删除预览→确认→现有配置事务；删除影响覆盖模型、池、Codex 目录、聚合引用和连接。
- 多连接独立 Key、优先级、并发、额度域、认证域、模型权限；最后启用连接不可删除/停用。
- 连接 Key 轮换、独立冷却、独立并发槽位；删除凭据与连接配置同事务提交。
- 63 个版本化模板、87 个示例模型；模板不是实时账户目录，未验收模板保持 planned-unverified。
- OpenAI 兼容连接目录发现：真实 HTTP、独立 Bearer Key、1 MiB 上限、不自动写模型。
- 旧 `/api/status`、`/api/config` 的 extraHeaders/proxy 秘密回显已收敛；掩码回存保留原值。

### A4 模型池、绑定、策略、预算

- `poolId`/`mg-pool-<stable-id>`、成员优先级/权重/轮询、候选启停、目录投影与扩展字段保留。
- 修复 `loadConfig`、`configProjection`、`cleanVms` 三处虚拟模型扩展字段丢失。
- 服务/模型停用后从目录隐藏并返回 404；池停用不参与新请求路由。
- `HarnessBinding` 稳定 desired 引用、应用端查询、删除保护、解除引用；Codex 另走真实模式切换。
- 全局→Harness→池有效策略：预算取最严、并发取最大、硬约束不可覆盖；全局预算可预览确认修改。
- RequestLedger 接入真实转发链：首次发送计数、候选/连接/模型/域 attempts、failover/recovery/wait/elapsed、取消。
- 400/401 终态；429 真等待且不缩短；共享额度域耗尽跳过整域；工具/未知提交/已交付流不重放。
- 普通无工具 HTTP 失败按预算回退；预算耗尽保留 429 归因；Codex 可信 unsent 续传仍单独受证据约束。

### A5 Codex 三模式与角色目标

- route 支持父子共同 model/pool 目标；aggregated 支持官方父 + 第三方 model/pool 子目标。
- 目标校验稳定 ID、启用状态和当前 Codex 目录；未发布目录 fail-closed 422。
- consent 绑定父子目标；state 持久化 routeTarget/childTarget；回滚沿用既有备份与 SHA。
- 命名池可发布到 Codex 目录；上下文取候选最小正值；工具能力只有全部成员有 source+observedAt 证据才声明 unified_exec，否则保守禁用。
- 纯路由零 GPT、聚合官方父、原生父子/工具/压缩仍由 Codex；真实 GUI/真实 Luna/Go/原生压缩未授权。

### A6 用量、日志、备份、Harness

- `/api/usage/summary`：持久累计 logical/completed/upstream attempts、token 分桶、模型/池/服务维度；未知费用/额度 null。
- 真实进程重启后用量累计保留。
- `/api/logs/structured`：脱敏文本 + 有界事件投影、级别/关键词/traceId 过滤、分页与 JSON 导出。
- 通用脱敏备份文件、导入预览/应用、冲突阻止、真实回滚；Key/认证头/代理凭据默认排除。
- Claude Code、OpenCode、DSH 独立配置适配器：默认只检测，显式 `MG_HARNESS_ROOT` 才可预览/应用/回滚；xmxz 无公开契约保持 unsupported。
- 19 个页面深链、六项固定一级导航、四个高级入口；12 类弹窗共享 Modal/焦点/Esc/footer。

## 2. 同代码指纹验证

| 命令 | 结果 | 边界 |
| --- | --- | --- |
| `npm run check` | PASS；旧 UI 19/19，新 UI 18/18 | 静态语法 |
| `npm test` | **169 suites / 1516 passed / 3 skipped / 0 failed** | 离线 mock + 真实隔离 HTTP + fixture |
| `npm run docs:check` | PASS | 文档链接 |
| `node scripts/check-metadata.mjs` | PASS 39 checks | Node>=24/元数据 |
| `npm run contract:check` | PASS | MG-R001..R012 形式一致 |
| `node scripts/e2e/ui-v13-browser.mjs` | **26 项检查全 PASS** | 真实 Chrome + 真实隔离后端 + fixture |
| V01 页面矩阵 | **19 × 7 × 2 = 266/266** | `browser/matrix/*.png` |
| V01 弹窗矩阵 | **12 × 3 × 2 = 72/72** | `browser/matrix/dialog-*.png` |
| 浏览器旅程 | 服务/连接/发现/模型/池/绑定/备份/导航/错误通过 | 0 次推理；1 次显式目录 GET |
| 生产服务 | PID `38474`，启动时间未变 | 未重启、未替换、未写配置 |

原始回执：`browser/a2-browser-report.json`（含 Chrome 版本、HEAD、最终代码指纹、266 页面几何、72 弹窗几何、26 项检查）。338 张矩阵截图共约 33 MB。

## 3. 明确未完成/阻断

1. **MG-R009 单实例多租户未接线**：现有 `src/tenancy/*` 只是原语；双实例隔离不等于单实例多租户。必须实现 schema、per-scope keys/config/stats/logs、管理面 403/404 与迁移，不得以 fixture 代签。
2. **持久 Operation/Preview/幂等回执**：当前预览、confirm token、requestId receipt 在进程内存；重启后需重新预览。异步取消 API 未实现，不能伪造已提交事务可取消。
3. **DNS 解析后私网/元数据复核**：新服务地址已阻止 URL userinfo、fragment、字面私网未确认与已知元数据 host，但尚未对 hostname 解析结果做统一复核。
4. **真实场景全部 BLOCKED**：用户明确暂不授权付费测试。DeepSeek V4.1 Flash、GPT-6 Luna、原版 Codex GUI、真实 Harness 客户端、真实套餐额度与原生压缩不得代换或标 PASS_REAL。
5. **V02/V05/V06/V07 完整门禁未完成**：缩放/IME/屏幕阅读器、31+池/48+候选/100服务/40账户/千模型压力、V13 35 条业务断言同树复跑仍需补齐。
6. **默认策略未经真实流量校准**：当前有界默认值只经 fixture 校准，生产推荐必须标 provisional。
7. **xmxz Harness**：没有可核验官方公开配置契约，保持 unsupported；这不是静默删除需求，需所有者提供资料后单独适配。
8. **发布**：未提交 git commit、未 push/merge/PR、未重启 8787、未切根入口；所有者批准前不得生产切换。

## 4. 下一步门禁

1. 单实例多租户 schema/keys/stats/logs 隔离与双身份 fixture。
2. 持久 Operation/Preview/回执与安全取消语义。
3. DNS 解析后地址复核与 SSRF 回归。
4. V02/V05/V06/V07 剩余视觉、压力、可访问性、旧业务断言。
5. 获得书面授权后再跑真实 DeepSeek/Luna/原版 GUI/Harness/native compaction，并绑同 SHA。
