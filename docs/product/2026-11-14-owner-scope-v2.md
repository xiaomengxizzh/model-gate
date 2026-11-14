# ModelGate｜所有者明确批准的 V2 范围修订（现行需求基线）

**批准时间：2026-11-14。批准来源：项目所有者在本轮对话中的明确指令：无需 OpenCode 全量协议适配，正式支持 OpenCode Go 的 deepseek-v4.1-flash；其余模型只做初探，初探不成即放弃；压缩必须适配 Codex 自己的压缩，不可自建压缩。**

历史 [V1 产品契约](2026-11-14-owner-product-contract.md) 与 2026-11-14 验收矩阵保留用于审计，不得抹除、伪造此前状态。**本文件为当前执行及新验收的优先产品范围**。这次变更由所有者明确授权，并非执行 AI 私自降级。除明确列出的模型覆盖变更外，原生 Codex、ChatGPT 套餐、GUI 一键集成、跨供应商 Agent Team、测试 GPT-6 Luna、账号保护、多用户分发、独立验收等全部不变。

## 当前唯一交付目标

用户打开 ModelGate GUI，选择聚合模式，添加 OpenCode Go Provider 后，**原版 Codex Desktop** 保留原来 ChatGPT 套餐登录，能够在模型选择器里使用套餐允许的 GPT 模型及 OpenCode Go 的 **`deepseek-v4.1-flash`**，无需人工改 TOML、维护模型别名或操作调试端点。Codex 原生 Harness 继续管理父子线程、工具、等待、追派、中断、上下文、**Codex 自身的原生压缩（native compaction）**与恢复。ModelGate 只承担授权、发现/固定目标模型配置、路由、协议适配及观测，不创建第二套压缩体系。

## 当前逐项验收（沿用 MG-R001..MG-R012 编号，不增设默认功能）

| ID | 本轮现行要求 | 对应真实验收 |
| --- | --- | --- |
| MG-R001 | GUI 一键开启/关闭聚合模式，原版 Codex 正常重载 | 实际 GUI 点击、状态回执、重启、回滚 |
| MG-R002 | 原有 ChatGPT 登录与套餐能力无损保留 | 原版 Codex Desktop 官方模型真实请求、登录状态/额度归属与回滚核验 |
| MG-R003 | **只强制支持 OpenCode Go `deepseek-v4.1-flash`**；其他模型非交付项 | Go 凭据与目标模型真实推理成功；公共模型 ID 与真实模型、服务端出站一致 |
| MG-R004 | 原版 Codex Desktop GUI 可选 ChatGPT 官方模型和上述 DeepSeek 模型 | 在原版 GUI 内逐个选择，模型选择器和请求收据一致 |
| MG-R005 | 保留 Codex 原生 Harness 的父子 Agent Team，不用 MCP/自建代理替代 | 原生父/子线程 + 指定 DeepSeek 子模型 + 原生工具真实回执 |
| MG-R006 | 保留原生等待、追派、中断、上下文、恢复，**必须能经过 Codex 自身的压缩后继续工作** | 真实触发原生压缩，压缩前后同一子线程、工具和记忆连续，确认中断/恢复与无重复派单 |
| MG-R007 | GUI 自动处理客户端检测、配置备份、写入与退出恢复 | 新用户和既有配置用户的实际桌面演练，零手工 TOML |
| MG-R008 | 不允许静默换 GPT、换 DeepSeek、丢工具或私自总结历史 | 错误模型/鉴权/压缩失败/协议不兼容反向测试，无隐式替换或历史丢失 |
| MG-R009 | 支持其他用户使用时凭据/配置/记录隔离 | 双用户/双身份真实或经所有者批准的可复现安装隔离验收 |
| MG-R010 | 原 Codex 安装、账号、原始配置在启停升级后可恢复 | 字节级回滚、崩溃恢复、冲突提示，不破坏现有用户登录 |
| MG-R011 | 每个阶段保留真实证据和费用/权限记录 | 精确 commit、可复现实测、日志脱敏；mock 与 real 分离 |
| MG-R012 | **所有原版 Codex 真实 GPT 测试仅允许 GPT-6 Luna** | 出站请求级 `model=gpt-6-luna`；不存在其他 GPT 型号或自动 fallback |

## 明确取消与明确保留

- **取消必达**：OpenCode Console 全量接入；Console/Go 所有可见模型自动发现/可调用；Anthropic Messages、Google Generate Content 的全量转换；20 条历史不可路由模型全部适配；所有模型的上下文/推理档位全面研究。
- **保留可选初探**：若需要判断其它模型是否已经现成可用，只可复用已有能力进行一次小规模、**有预算且需遵守授权**的初探；失败即标 OPTIONAL_STOP，不追加针对该模型的翻译器、特殊补丁或循环研究。此规则不允许影响必达目标 DeepSeek。
- **必须修复**：Go DeepSeek 的原生工具、历史、上下文压缩兼容；已知 `unsupported_input_item` / `compaction` 阻断不能通过增大窗口、关闭压缩或删历史伪装通过。
- **压缩机制归属**：由 Codex 核心选择和执行其原生压缩机制（包括该版本实际支持的本地/远程路径）。网关不得自建 summarize、LLM 历史压缩 API、摘要缓存、后台截断任务或自行重写历史；只可做协议保真、能力声明、正确路由、透明回执和原生客户端配置适配。
- **不等价于盲转密文**：Codex 产生的 opaque/encrypted compaction 数据不得擅自解密、伪造、丢弃或转发给不支持它的第三方模型；需要让 Codex 选择目标模型实际可用的原生压缩路径，并用真实原生日志验证。
- **不改变凭据授权原则**：没有“永不读取/复制/触碰 auth.json”的绝对禁令；必要时经用户授权、安全隔离和脱敏管理，但不能破坏原登录或泄漏凭据。
- 旧矩阵 `docs/evidence/aggregation-acceptance-matrix.md` 是 **V1 历史快照**，不得当作本轮 V2 当前发布门禁；执行第一阶段必须切换生成器/门禁到本文件，历史证据可复用但 `MG-R006` 的真实压缩尚未通过，不能因旧矩阵 `PASS_REAL` 而直接签收。

## 状态控制

`NOT_TESTED`、`BLOCKED`、`FAIL`、`PASS_MOCK`、`PASS_REAL`。目标真实终态要求 MG-R001..012 均有针对本轮目标的实际证据，A5 独立验收、最终所有者审批。上游/环境/预算阻断不授权进一步降低本文件要求。

[现行执行计划](../roadmap/2026-11-14-go-deepseek-native-compact-plan.md) · [现行启动提示词](../roadmap/2026-11-14-go-deepseek-native-compact-start.md)
