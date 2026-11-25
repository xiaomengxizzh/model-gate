# V13.1 目标完成审计（2026-11-25）

## 裁决

**NOT COMPLETE（本地生产切换已完成；仍缺权威输入与人工/真实签收）。** 本轮已关闭 MG-R009、持久 Operation/Preview/取消、DNS 出站固定、U04 在途删除保护、U08 多连接压力、V04 完整错误矩阵、V02/V05/V06 的可执行门禁，并按所有者授权完成 8787 的 Node 24 与 `/ui-vnext/` 根入口切换。V07 原 35 条权威断言清单仍缺失；真实场景按所有者决定保持 BLOCKED，不以 fixture 替代。

## 最终证据

- 原始目标逐项映射：`objective-checklist.csv`（44 项；已交付、fixture、unsupported 与 BLOCKED 分列）。

- HEAD：`48325bf0027e583108c66677c7dec15fd5007228`，工作树未提交。
- 代码指纹：`a0df9a9f91fed8620963ce5689d39a5d74e846ecec42b4af6e3d294eaa343123`。
- 指纹范围：176 文件，包含 `src/`、package、测试清单、全部 V13/安全离线测试与六个 V13 浏览器脚本；算法 `sha256(relative path + NUL + bytes)`。
- `npm test`：183 suites / 1625 passed / 3 skipped / 0 failed / 0 timed out。
- `npm run check`：PASS；旧 UI 19/19、新 UI 19/19。
- `npm run docs:check`：PASS，150 files / 743 links。
- `node scripts/check-metadata.mjs`：PASS，39 checks。
- `npm run contract:check`：PASS，12 requirements / 7 stages / 5 roles。
- `git diff --check`：PASS。
- `node scripts/e2e/ui-v13-quality.mjs`：171/171 PASS；Chrome 153；100 服务、31 池、1,488 候选引用、1,000 模型、40 连接；68 路由/主题/尺寸组合；最大路由 1028.9ms、long task 790ms；0 JS/network/HTTP errors；0 推理。该报告属于切换前指纹 `4ab8600e…`，未冒充当前树证据。
- `node scripts/e2e/ui-v13-screen-reader.mjs`：39/39 PASS；真实 Orca 50.2、AT-SPI 2.60.4、私有 Xvfb/D-Bus；66 条实际 Orca 语音输出。人工听音未签收；报告属于切换前指纹。
- `browser/visual-review-report.json`：AI 视觉检查 100 个矩阵样本（19 页面 × 双主题 × 双尺寸、12 弹窗 × 双主题），无阻断性重叠/裁切；所有者人工视觉与 OS IME 候选窗未签收。该报告属于切换前指纹。
- 真实浏览器既有旅程：26 项 PASS；页面矩阵 266/266；弹窗矩阵 72/72。历史报告保留其采集时 SHA，不冒充最终树证据。
- 当前树根入口由离线 HTTP 回归与生产 curl 验证：`/` 302 到 `/ui-vnext/`，`/ui-vnext/` 200，`/ui-next/` 200（回滚），`/admin` 410；未重跑重型浏览器矩阵，人工视觉签收仍待所有者。
- 2026-11-26 样例布局真实 Chrome 冒烟：35/35，覆盖 18 路由、服务弹窗、真实 route-preview、设置备份、360px 五页；0 JS/network error、0 上游推理。证据 `browser/sample-smoke/report.json`，与当前指纹 `a0df9a9f…` 同树。
- 生产与所有者 V13.1 HTML 基线并排截图：`browser/baseline-compare/compare-1440x900.png`。二次修正后默认深色、shell、系统导航分组、Codex/第一次使用双卡、应用搜索/筛选与两张应用卡一致；剩余差异仅为真实生产标识、真实检测/目标数据和操作文案。

## 本轮关闭项

| 要求 | 实现与证据 |
| --- | --- |
| MG-R009 单实例多租户 | `src/tenancy/http.js` + scope 存储；可信 `resolveActor`；双身份配置/Key/目录/统计/日志/额度/角色隔离；重启持久化；跨 scope 404；`mg-r009-tenancy-http.test.mjs` |
| 持久预览/操作/取消 | `operation-store.js`；scope+actor 绑定、SHA-256 token、一次性消费、requestId 重放、容量限制、commit marker、重启 interrupted/unknown、仅未开始步骤可取消；服务/资源/备份/Harness/旧配置与 Key 写入全部接线 |
| 秘密不进入预览计划 | 服务计划仅存 Header/代理掩码，提交时从当前配置恢复；Key 只在 apply 请求提供，预览/回执仅存 hash/动作；凭据文件 0600 |
| DNS/SSRF | 保存与每次真实 HTTP(S) 建连前解析全部 A/AAAA；目标与代理校验；socket lookup 固定；Host/SNI 保留；禁止重定向；多租户与新资源默认拒绝私网，旧单用户缺省保留本地兼容 |
| U04 在途删除保护 | `in-flight.js` + Chat/direct forward 登记；服务/模型/池预览与确认复核；在途 422；流 end/close/error 释放；`v13-in-flight-http.test.mjs` |
| U02 三模式草稿 | `drafts.js` + 专用浏览器矩阵；三模式 × 六窗口 × 双尺寸 × 双主题、历史/刷新、明确丢弃、存储故障、恶意草稿隔离；193/193 |
| G11 同核路由预演 | `route-preview.js`；旧 `{model}` 字段兼容，role/capability/scenario/budget 复用 router/policy/decision/RequestLedger；route 禁 GPT、费用账本失败关闭；8/8 |
| G15 持久 trace | scope-owned 有界 JSONL、0600/0700、fsync/轮转、重启加载、损坏行计数；结构化日志过滤分页；10/10 + 兼容 8/8 |
| U08 多连接压力 | `v13-connection-stress.test.mjs`；40 连接/8 provider、独立槽位、429 冷却、共享额度域、半开单飞、取消与精确尝试账本；45/45 |
| V04 错误矩阵 | `v04-error-matrix-report.json`；loading/empty/error/partial/cancel/retry/conflict/401/403/404/409/422/428/500/offline；72/72 |
| V02/V05/V06 | 缩放、IME 事件、减少动效、对比度、AX 名称、键盘/焦点、弹窗、压力与真实 Orca/AT-SPI；见两份 browser 报告 |
| 安全审计修复 | 递归拒绝租户嵌套环境凭据；连接/策略预览秘密掩码并在提交时恢复（含连接级 Header/代理与 provider/default `sessionHmacSecret`）；锁内 expectedVersion CAS；租户日志有界轮转；操作临时文件安全恢复；native 预演目标按真实 router 解析 |
| 旧写接口契约 | `/api/config/save`、`/api/keys` 改为 `/api/config/write:preview` → 确认提交；旧 UI 使用自定义确认弹窗，无 native confirm |
| V13 凭据弹窗回归 | 服务与连接凭据均改为“预览凭据变更→确认安全保存”；Key 只保留在内存与 apply 请求，不进入 localStorage/预览计划 |
| Codex 阶段日志洪水 | `advancePhase()` 对 `phase -> phase` 幂等 no-op；同一响应多个工具调用不再写 `codex phase rejected`，非法回退与重放阻断不变；新增单元与真实流回归 |
| 本地生产切换 | 2026-11-25 22:52:54 CST 经所有者授权重启 8787；systemd drop-in 固定 Node v24.22.2；23:18:10 CST 加载最终入口提示后 MainPID `275796`。根 `/` 302 到 `/ui-vnext/`，`/ui-next/` 保留回滚；Codex `openai_base_url` 与 custom provider 均改为 `http://127.0.0.1:8787/v1` |
| 前端与托盘入口 | 新前端内部旧 `/ui-next/` 跳转全部清除；Linux/Windows 托盘源码显式打开 `/ui-vnext/`；`/admin` 410 提示同步。Linux 托盘已于所有者明确授权后重启，PID `290596` |
| V13.1 样例逐页重构 | shell/导航/面包屑/应用与服务卡片/池四 tab/用量趋势/稳定性/设置子导航/详情页按样例重排；保留真实 API 与安全事务。新增 `#/mode`，修复 `pool-test` 与快速路由竞态；高级路由只提供真实只读预演，不伪造规则 CRUD |

## 仍未覆盖（不得签收 complete）

1. **V07 权威旧 35 条**：R2 仅留 35/35 汇总，未提供名称、断言体、两组定义或原命令；`legacy-35-report.json` 记录阻断。已提供严格校验器 `scripts/verify-legacy-35.mjs` 与明确无效的待填模板 `legacy-35-authoritative-input.json`，缺输入/重复/越界/错映射均拒绝且不会生成替代断言；自测通过但 35 条真实复跑仍为 NOT_RUN。
2. **人工签收**：视觉质量、OS IME 候选窗和 Orca 实际听音未由所有者签收；自动检查不冒充人工结论。
3. **xmxz**：缺官方可核验配置协议，保持 unsupported。
4. **真实场景**：DeepSeek V4.1 Flash、GPT-6 Luna、原版 Codex GUI、真实 Harness、原生 compact 均未授权。
5. **发布动作**：本地 8787 重启与根入口切换已获授权并完成；push/merge/commit/对外发布仍未授权。

## 生产与进程保护

- 2026-11-25 23:18:10 CST，最终入口改动重启成功；MainPID `275796`，`/proc/275796/exe --version` 为 `v24.22.2`，监听 `127.0.0.1:8787`。
- systemd 新增 `30-node24.conf` 仅覆盖 ExecStart；既有 `20-opencode-env.conf` 保留，仍加载 `$HOME/.config/environment.d/90-apikeys.conf`。原单元与最小源码回滚包已保存。
- 根 `/` 302 到 `/ui-vnext/`；`/ui-vnext/` 与回滚入口 `/ui-next/` 均 200，`/admin` 410。`/healthz` 为 `ok`，`/api/status.configVersion=396`，Codex 目录包含 `gpt-6.2-sol`、`gpt-6-luna` 与 Go 聚合模型。
- Codex 配置原指向未监听的 `127.0.0.1:15721`，导致请求不达网关；已备份并改到 `127.0.0.1:8787`。当前 Codex GUI 是否需要重开新会话由所有者确认，未擅自终止桌面进程。
- 2026-11-26 修复通用“服务面板”托盘第二入口：`~/.local/bin/service-panel.py` 两处 8787 映射由 `/ui-next/` 改为 `/ui-vnext/`，已备份；所有者授权重启后 PID `664439`。ModelGate 专用托盘 PID `290596` 与网关 PID `275796` 保持不变。
- `.tmp-ui/` 为会话前既有未跟踪目录，保留未动；未执行 push/merge/commit/对外发布。

## 继续顺序

所有可执行非真实场景门禁已关闭，本地生产切换已完成；V07 与 xmxz 需所有者提供权威输入。人工签收、真实场景与对外发布仍须单独书面授权。

## 停泊状态（2026-11-25）

- 已完成：全部可执行非真实场景实现与门禁；最终 183 suites / 1625 passed / 3 skipped；产品指纹 `a0df9a9f91fed8620963ce5689d39a5d74e846ecec42b4af6e3d294eaa343123`；8787 已切 Node 24 与 `/ui-vnext/`，样例布局冒烟 35/35，生产/基线截图已比对。
- 仍缺：V07 原 35 条权威断言清单。待填模板当前为空，校验器返回 76 个必填错误、执行断言数 0；xmxz OwnerConfig 权威契约缺失，保持 unsupported；人工/真实/对外发布签收未授权。
- 具体下一步：所有者在 `/ui-vnext/` 完成人工视觉、OS IME 候选窗与 Orca 听音签收；Codex 重开新会话后确认 8787 端点。V07 仅在收到权威清单后执行 `node scripts/verify-legacy-35.mjs --input=<file> --run`。
- 当前未调用 `UpdateGoal complete`，未以新测试替代历史 35 条，未执行 push/merge/commit/对外发布。
