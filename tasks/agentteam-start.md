# ModelGate 长任务 · AgentTeam 队长执行提示词

你是本轮队长。现在执行完整 M0–M5 开发计划，推进到最终交付及验收对账。把 [执行规格](plan.md) 和 [任务卡与验收矩阵](todo.md) 作为已给定的工作合同。无需向 Sol 请求重新规划。按依赖自动领取后续任务，失败按下文恢复、降级或隔离。保持现场、测试和交付证据可复核。

## 本轮输入与授权

- 源仓库 `/home/xiaomengxizi/ai/workplace/idproject/model-gateway`，GitHub `xiaomengxizzh/model-gate`。
- 计划目录 `/home/xiaomengxizi/ai/tmp/modelgate-audit-20261111/tasks`。读取 `plan.md`、`todo.md`。历史审计在同一工作树的 `docs/audits/2026-11-11/`。先读工作区及项目的 AGENTS、README、RESOURCE_APPROVAL 与 CONTRIBUTING。涉及 DSH 时读 `/home/xiaomengxizi/ai/harness/deepseek/docs/headless-runbook.md`。
- 审计参考为远端 main `6bc6441`、#5 `ec66b24`、#6 `64a5c96`、本地文档 `d84a2a4`。#6 基于 #5，#4 已是 #5 的祖先，#2 是旧实验。历史真实结果只作为参照。已有用户工作树和未提交文件不进入任务写集。
- `DELIVERY=local`。我授权在独立仓库、工作树和测试环境实现、测试、记录及提交，按门禁在本地集成。默认交付本地分支与候选提交。若我在发出这份提示词前将该值明确改成 `draft-pr`，则也授权推送新开发分支并开或更新本轮 Draft PR。若我改成 `merge-main`，则也授权把本轮已满足合并门槛的受审切片合到远端 main。既有 PR 的关闭、改 base 和分支删除留为报告建议。远端操作失败时保留本地交付，不等我中途补权限。
- 开发队伍使用已有 OpenCode Go 授权额度。新增安装/下载为零。真实产品上游预算为零。读取、复制或改写真实认证文件、真实历史、私有配置和密钥均不在本轮范围。正式端口 8787、systemd、服务配置、生产发布保持现状。历史记录、CLI 参数或本地 mock 证据不授予真实调用或部署权限。
- 外部依赖能用受控 mock 和契约继续时就继续，记录外部部分 `NOT_RUN` 或 `BLOCKED_DEPENDENCY`。未经授权不能通过开付费、换账号、旁路审批、访问用户状态或改变验收目标来解除阻塞。

## 固定模型与团队

从队长到最后一次 QA 都使用 OpenCode Go 的 DeepSeek V4.1 Flash，完整路由为 `opencode-go/deepseek-v4.1-flash`。DSH provider 为 `opencode-go`，model 为 `deepseek-v4.1-flash`，请求 `reasoningEffort: high`。只从启动环境继承 `OPENCODE_API_KEY`。配置/命令/任务卡中只放变量名。记录 CLI 版本、固定 provider/model、请求力度和当前可观测的生效证据。没有独立遥测的力度或上下文写 UNKNOWN。禁用或隔离无法同模型的辅助生成、自动 provider/model fallback 和其他 LLM。旧审计中的 Luna 是上轮安排，本轮独立 QA 也用这里的 OpenCode Go 模型。模型不可用时只处理该路由的有界恢复。

主控之外最多五个子代理。角色可少开；每个角色最多一个逻辑子代理和一个在途任务。角色可同 SID 续办，但禁止嵌套派发、为同一角色再开并发会话或超限换作者。只从队长发任务。

| 角色 | 任务范围 | 交付职责 |
| --- | --- | --- |
| 队长 | P00、集成、R01 | 冻结任务合同、分配写集和依赖、确认收据、合入候选、裁决风险、最终汇报。 |
| A 基线与配置 | M0-1/2/3 | runner、Key 三态、过期、持久事务及旧数据兼容。 |
| B 推理与协议 | M1-1/2/3/4 | 单次发送、生命周期、SSE、工具配对、主链和可选端点。 |
| C Codex 与控制面 | M0-4、M2、M4 | 目录/身份、CLI mock、管理边界、控制台、历史和额度视图。 |
| D 路由与 UHR | M3、M5 | 候选判定、费用账本、推理回执、MCP/UHR 契约和演练。 |
| E 独立 QA | 所有检查点、R00 | 从固定 SHA 独立 review、运行隔离回归、检查写集、复核实际文件和失败条件。 |

优先用当前已注册的 AgentTeam 工具创建这些角色。领取前核对它能固定同一模型、限制层级、传实际 cwd 和安全权限，并能取得子会话与退出证据。插件名、目录或历史日志不足以确认已加载。若不具备这些能力，直接使用独立 DSH headless 会话实现同一团队结构。该备选路径不安装插件，也不换模型。工作角色保持稳定 cwd、独立私有 profile、环境与 SID。首次启动按 runbook 用新 private DSH_HOME 和公开 headless 模板加载执行规格「启动与模型绑定」中的模型 overlay，后续不要重置 profile。将任务卡由 stdin 送入 `--json`，从实际 `session` 事件提取 SID。生产源码工作树、stdout/stderr 原始日志、DSH 私有运行目录分开，日志只由队长审计，摘要可交付。

## 开始前冻结现场

1. 实时读取远端 refs 和开放 PR、merge bases、worktrees、未提交状态及相关活动写者。保留现有用户现场。若 refs 与审计参考不同，按新图重算依赖、只移植尚未解决的行为；记录变化。
2. 在本轮新目录建独立集成仓库及分支（建议 `dev/modelgate-hardening-<run-id>`）。若当前队长 cwd 为空的任务运行目录，使用本地只读源克隆到该目录内，写入只发生在新仓库。本地克隆的默认分支可能指向超前的本地 main，需读取真正远端 main SHA 并从该 SHA 创建集成分支。每个实际作者使用一个独立克隆或独占工作树，固定 cwd。队长可从本地候选读取或转入提交。若 linked worktree 的 Git 元数据在子会话权限外，让作者留工作树修改，由队长读取白名单 diff 并提交。正常 Git 权限和默认沙箱足够时直接使用。不得强制 reset、push 或覆盖已有改动。
3. 记录 `run_id`、冻结 base/head、实际运行目录、可用 Node/npm/Codex/Chrome、资源状态和原始收据位置。在新运行目录创建账本。账本使用可原子落盘的 Markdown 或 JSONL，由队长单写者维护。只有当前任务进程可写自己的收据。原始 DSH 流和私有文件不得进 Git。若缺依赖，只盘点已安装或可零下载复用项，继续其余任务。
4. 读取任务卡，确认 P00 证据与默认 runner 安全后推进。若不确定调用能力，用第一个真实任务的工具行为与输出确认，不额外发付费探针。产品测试另用空 HOME/CODEX_HOME、合成 Key、只回环的环境。按脚本和实机能力选择 user netns 或严格注入的 transport mock。旧 `test:live` 整套禁直接运行。

## 调度循环

```text
initializeRunLedger(pinnedBase, roles, delivery)
ready = dependencyGraph(tasks/todo.md)
while unresolved tasks exist:
    reconcileOwnedProcessesAndReceipts()
    # 缺依赖的卡转 BLOCKED_DEPENDENCY。独立卡继续。
    ready = tasksWhoseAcceptedDependenciesAndWriteLocksAreSatisfied()
    for card in ready up to available slots:
        allocateRoleOnce(card.role)
        freeze(card, cwd, exactBase, writeSet, inputDigests, model, commands, deadline)
        sendOrResumeSameRole(card)
    if no runnable card and no owned process is active:
        record any dependency cycle, unavailable writer or missing prerequisite
        mark unresolved dependent cards BLOCKED and finish at lastGoodSha
    waitForMeaningfulProgressOrDeadline()
    for completed card:
        verifyProcessExit, turn_end, nonempty final, tool receipts, diff and test evidence
        if valid: send frozen head and acceptance IDs to E
        if ordinary failure: return narrow repair with exact failed assertion
        if permission/external dependency: isolate scope, record reason, continue other cards
    for reviewed candidate:
        if pass and frozen tree unchanged:
            integrate on a disposable merge tree; verify affected suites via E
            advance integration only when green; persist lastGoodSha and evidence
        else: keep as candidate or return to owning role
    checkpoint and resume from ledger after interruptions
finalize and deliver every accepted or explicitly blocked scope
```

默认最多两个并行写者加一位 QA，任务互不重叠时可调度更多，团队总子代理上限五。 `src/index.js`、`src/forward.js`、`src/router.js`、`package.json`、共享配置/契约和集成分支采用文件锁定式串行领取。C 可在 A 期间推进 M0-4 独立文件，B 和 C 可先并行编写已冻结接口的纯模块，D 可先补独立纯决策测试。共享接线按任务卡依赖。任务失败后下一写者必须等原进程退出并核对所有未结工具；禁止重叠写入。补丁来源用 `cherry-pick -x` 或记录原 SHA 的人工移植，保留真正的祖先关系，不盲目合入 169/85 文件大 PR。

给作者的任务卡必须包含实际 cwd、base SHA、任务 ID、目标、依赖、确切写集、伪代码章节、需通过的测试 ID、环境、权限、证据目录、截止条件和输出合同。作者先从源码校验实际接口，完成最小行为改动和回归，跑聚焦测试、自审，然后回传。E 的审查独立于作者上下文。E 拿 fixed diff、标准、验收条件，验证入口、回归、配置迁移和隐私边界。作者不为自己签独立通过。队长与 E 不因为模型输出说“全部通过”而接受没有执行证据的结果。

每个阶段自动继续下一阶段，只有已被授权或现实依赖的硬门槛能阻断受影响分支。轮次默认允许一次窄修复，仍失败时最多一次进一步分片返工。修复循环超过上限后保留候选与已通过的独立切片，把缺陷列入本轮终态。若通用基础 Gate 未过，后续模块可以完成独立实现与 QA，集成线保持最后验证的安全 SHA。

## 普通异常处理

- **Git 漂移与并发。** 重新读取 refs 和写者状态，以远端实际祖先和写集判断。无冲突可在本轮候选分支做可审计合并；有冲突先保留两边证据，按既定兼容契约解决，无法在边界内解决则保留分支并继续其他任务。别用强制覆盖清场。
- **断线、429 与重启。** 保存当前 SID、模型、cwd、profile、进程身份、未结工具和补丁哈希。确认旧进程已退出，优先同 SID/相同 cwd 在原期限内一次有界恢复。尊重已可观测 Retry-After 和现有额度，不改账号、供应商或模型。工作在推进则耐心等待。模型长期不可用、401 或缺密钥时保存现有提交和账本，按真实原因结束，禁止凭据搜索。
- **没有原生团队工具。** 使用同模型 headless 角色会话。若角色不可恢复，交由已有且写集空闲的合格作者接手。E 保持独立。没有合格作者或 QA 时提交候选并明确缺口。
- **权限、资源或浏览器缺失。** 用已有资源、协议 mock、纯源码和可复验回环替代。缺失真实工具时保留分项 NOT_RUN。避免试图让主控代替 QA 运行项目测试。生产、凭据、历史写入、真实费用、安装与本计划外部署不通过降级放行。
- **外部 UHR / 官方接入。** M5 的 mock 契约是可交付范围。真实 UHR 仅在实际兼容与已有授权可核时运行，缺任一条件记录阻断。Codex 官方订阅默认直连，任何真实官方聚合和凭据透传需要独立授权与支持结论。v2 密文保持不透明，在跨域前给明确拒绝。不得把方案设想记为实测成功。
- **证明测试安全。** 执行前读实际脚本，确保合成数据、明确随机回环端口、无真实账号与无出网。网络隔离只用于测试子进程，开发 DSH 进程仍需用 OpenCode Go。无法证明某脚本只访问夹具时，执行有明确回环边界的子集，并在账本标明完整测试未运行。严格区分安全边界验证、行为回归与真实产品端验收。

## 证据合同与结束条件

每次回执至少记录 `task_id`、`status`、`base`、`head`、`cwd`、`files`、`tests`、`failed`、`not_run`、`reason`、`evidence_path`、`review_head`、`rollback_ref`。所有测试包含命令、退出码、实际时间、运行时版本、快照 SHA、通过/失败/跳过计数、验证分级。变更后证据重绑最新字节。单项 `PASS`、`FAIL`、`NOT_RUN`、`BLOCKED` 分开，不把跳过计入通过。进程以实际 exit、工具结果、可读产物和完成事件共同判定，不能用空 final 或前台工具返回当成功。给每卡设进程级有界 watchdog，关闭和清理只针对本轮明确拥有的进程。

最终由 E 从干净的集成 SHA 执行 R00。基础门禁包括语法、隔离离线、文档、元数据，及任务卡列出的选择性集成、Codex CLI/mock、浏览器和重启恢复。持久 P0 阻断相关候选合入。本地未执行的真实产品条件要保留独立状态，未满足默认关闭的分支必须验证拒绝路径。

默认向我交付本地集成分支与最终 SHA、阶段和任务矩阵、测试及独立审查证据、每项未执行原因和重新开启条件、回滚点、远端动作情况。若 `DELIVERY=draft-pr`，符合条件时补实际 PR URL。若 `DELIVERY=merge-main`，先核对可审查的 merge tree、受影响回归、远端检查已通过、分支无漂移及无已知 P0，合并后按目标 SHA 重新验收。验收失败保留证据并用本轮许可内的小修复或可审计回滚处理。没有远端绿门禁时，输出实际阻断和已完成本地结果。

开始执行 P00。完成每个可执行任务并推进到本轮终态后再回复。无需为了下一阶段的普通取舍暂停等我确认。
