# 开发规范

> **禁止需求降级：** 本项目以 [MG-R001..MG-R012 所有者产品契约](docs/product/2026-11-14-owner-product-contract.md) 为最终产品目标，以 [可执行伪代码总计划](docs/roadmap/2026-11-14-aggregation-pseudocode-plan.md) 为实施入口。执行者不能通过缩小验收范围、静默删模型、改为 MCP/非原生 Agent 或替换 GPT-6 Luna 来宣布完成。新开发 PR 需逐项链接 MG-R ID，独立验收绑定精确 commit SHA；最终产品 PASS 与单元测试 PASS 严格区分。

新增大型安装/下载：无；历史提议仅供研究，不自动执行。任何依赖动作先遵守 [资源规则](RESOURCE_APPROVAL.md)。

## 选择任务

从 [开发计划](docs/development-plan.md) 选择一个有验收标准的条目，先复核实际代码。记录目标、允许修改文件、回归条件和未验证范围。通用生命周期沿用工作区 project-build-workflow；本仓库只维护具体任务与证据。

## 实现与验证

维持 Node.js 内置模块实现。先给缺陷建立行为复现，再修复并运行 `npm run check`、`npm test`、`npm run docs:check`、`node scripts/check-metadata.mjs`。单个主题可用 `npm test -- boundary` 筛选；交付前运行完整默认套件。只要改了 API、配置或操作步骤，同一提交同步相应参考或指南。

默认套件使用本地 mock，不需要用户网关。旧套件另见[测试指南](docs/how-to/testing.md)。保持同一文件同一时刻一个写者；需要独立审查时给 reviewer 固定 diff 和验收条件，区分作者自检与独立结论。

## 文档维护

README 保留定位和导航；教程只负责第一次跑通，how-to 写具体操作，reference 写契约，explanation 写架构取舍。当前开发计划维护任务状态，审计文件保留时间点证据，archive 保留历史。避免在多个交接文件复制“下一步”。

## 提交

审查 `git diff --ignore-space-at-eol` 和暂存清单，检查未误纳入 config、日志、临时文件、凭据。提交说明写明触发条件、行为变化与验证结果。推送后核对远端 HEAD。源码提交不代表生产已部署；服务重启、真实上游验收需单独记录。
