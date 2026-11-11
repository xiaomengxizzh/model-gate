# 下一轮开发启动提示词

复制下面内容到 Codex 或 DSH。测试角色按本轮所有者分工执行。

```text
你接管 ModelGate 的 M0。仓库 xiaomengxizzh/model-gate，路径
/home/xiaomengxizi/ai/workplace/idproject/model-gateway。
审计交付位于本地 audit/modelgate-20261111 分支，对应路径
/home/xiaomengxizi/ai/tmp/modelgate-audit-20261111/docs/audits/2026-11-11/。
从该目录的 audit.md、git-pr.md、architecture.md、roadmap.md 开始。
读取目标 worktree 的 AGENTS.md、RESOURCE_APPROVAL.md、README.md 和测试入口。

上轮远端 main 6bc6441，#5 ec66b24 → main，#6 64a5c96 → #5。
#4 是 #5 的祖先，#2 是被候选通用 Responses 路径覆盖的实验分支。
上轮没有合并产品 PR。先实时查所有开放 PR、base/head、远端 checks、
worktree、未提交内容和正在写入的任务。现有产品 worktree 可能有用户改动。
创建独立窄分支和 worktree，禁止强制 reset、force push、覆盖现有工作或改变 PR base 来隐藏重复。

当前首个交付是配置 Key 的事务与验收基线。
1. 在远端 main 的独立分支定位 src/index.js 的客户端 Key 省略/掩码/显式清空语义。
   保存其他字段时保留现有 Key，验证有效期格式兼容和有歧义时的拒绝策略。
2. 定义 Key/配置的事务提交与失败恢复。保持旧配置可读和现有有效客户端行为。
   独立验证空值、过期、冲突、失败恢复、无敏感日志。
3. 另一个窄切片只迁移安全隔离 runner 与可靠文档/CI 门禁。
   记录每个 SHA、命令、测试时间、版本、通过/失败、真实程度及证据。
   Node 版本按现有可用工具，不下载工具链。修复每个仓库外相对链接。
4. 只有 M0 通过且独立审查完成，才进入 roadmap.md 的 M1。
   #5 和 #6 的合并阻断保留。不要加新端点、Agent 框架或付费验收来绕开它们。

主控进行静态审查和交付裁决。所有代码测试与最小验证仅由原生 gpt-6-luna high
在独立快照运行。如果当前 DSH 无此子代理入口，先完成静态及实现工作，
将测试卡交给 Codex 的 Luna high，实际结果回收后再决策。不要换测试者或假报通过。
用户级真实配置、认证文件、历史、正式端口和 systemd 都在本任务权限之外。
新增大型安装/下载为零，历史建议仅供研究；真实调用预算为 0。
严禁运行会读取或复制 auth.json 的脚本，禁用联网模型调用。测试使用隔离目录、
现有 CLI、合成凭据和回环 Mock。Git 集成与部署权限分别确认。

验收汇报至少包含修复行为、固定 SHA、可复验命令、检查结果、未执行项与回滚点。
可复用 Codex 目录和 SSE 经验需要通过 M2 的工具往返及域隔离。
原生 v2 加密委派保持 fail-closed。跨供应商明文委派待 M5，经 MCP 和 UHR 契约。
```
