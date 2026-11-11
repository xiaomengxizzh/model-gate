# 独立复验收据

执行者 gpt-6-luna high。源树为 `git archive` 固定快照，路径 `/tmp/modelgate-audit-verification-20261111/{main,pr5,pr6}`。命令在对应快照执行。现有环境 Node v24.22.2、npm 11.19.1、系统 Chrome 和现有 Codex CLI 0.167.0。候选使用隔离配置、临时 HOME/CODEX_HOME 和回环 mock，部分套件做空环境复跑。未安装软件。远端 CI 无记录，CI 配置声明的 Node 18/20/22 矩阵未运行。

| 快照 | 完整 SHA |
| --- | --- |
| main | `6bc6441fc7bf3e620b19af5af3b4d62543b31193` |
| #5 | `ec66b24b529cc6c4e531d2bb718ac22edb70f334` |
| #6 | `64a5c96df8ec6445371150fb21414b98aed1bac3` |

以下时间为 2026-11-11 Asia/Shanghai，使用执行收据，旧日志仅有文件落盘时取落盘时间。证据文件名相对于 `/tmp/modelgate-audit-verification-20261111`。

| 快照 | 时间 | 命令 | 结果与证据 |
| --- | --- | --- | --- |
| main | 17:35:35 | `npm run check` | PASS，6 个语法检查。 `main-check.log` |
| main | 17:35:35 / 17:37:30 | `npm test`，复跑为空环境的 `node scripts/test/run.mjs` | 25 个本地断言通过，20 个套件因连接失败报错。主干 runner 依赖已有网关，两个启动均遗漏显式目标，预检连接了默认 `127.0.0.1:8787`，地址不可达。未启动或修改该服务。主干集成门禁未建立。 `main-test.log`、`main-empty-env-test.log`、`main-empty-env-meta.txt` |
| main | 17:35 | `npm run docs:check` | 缺少命令，未执行文档校验。main 同样没有候选的元数据脚本。 `main-docs.log` |
| #5 | 17:36:06 | `npm test` | 30 套件通过，0 失败，本地 mock。 `pr5-test.log` |
| #5 | 17:36:07 | `npm run check` | PASS，UI 模块 15/15。 `pr5-check.log` |
| #5 | 17:36:07 | `npm run docs:check` | 1 条坏链接。证据报告用跨仓相对路径指向 DeepSeek runbook。 `pr5-docs.log` |
| #5 | 17:41:32 | `node scripts/check-metadata.mjs` | 21/21，0 失败。 `pr5-metadata.log`、`metadata-meta.txt` |
| #6 | 17:36:44 / 17:38:27 | `npm test`，空环境复跑 | 两次各 45 套件通过，0 失败，本地 mock。 `pr6-test.log`、`pr6-empty-env-test.log`、`pr6-empty-env-meta.txt` |
| #6 | 17:36:45 | `npm run check` | PASS，UI 模块 16/16。 `pr6-check.log` |
| #6 | 17:36:55 | `npm run docs:check` | 1 条坏链接，与 #5 相同。 `pr6-docs-meta.txt` |
| #6 | 17:41:32 | `node scripts/check-metadata.mjs` | 21/21，0 失败。 `pr6-metadata.log`、`metadata-meta.txt` |
| #6 | 17:47:43 | `node scripts/test/codex-config-e2e.mjs` | 14/14，0 失败。回环 API 与合成配置覆盖预览、应用、备份、回滚、并发修改和现有路径拒绝。没有访问凭据文件。 `pr6-codex-config-e2e.{meta,log}` |
| #6 | 17:37:17 | `node scripts/test/codex-catalog-rollback.mjs` | 7/7，0 失败。真实本地 Codex `debug models` 加载回滚目录（13 个条目），未发对话。临时目录中的 PATH alias 提示未影响解析。 `pr6-cli-catalog.log` |
| #6 | 17:37:17 | `node scripts/test/history-migration-drill.mjs` | 11/11，0 失败，合成 JSONL 诊断、模拟迁移与回滚。 `pr6-history.log` |
| #6 | 17:37:17 | `node scripts/test/quota-emergency-drill.mjs` | 13/13，0 失败，合成额度与应急状态。 `pr6-quota.log` |
| #5 / #6 | 17:44:46 / 17:44:47 | `MG_ALLOW_LIVE_TESTS=1 node scripts/test/live.mjs affinity` | 各 1/1 套件、4/4 断言，动态回环网关和 Mock A/B，验证故障转移、亲和与回流。 `pr{5,6}-legacy-affinity.{meta,log}` |
| #5 / #6 | 17:45:49 / 17:44:26 | `node /tmp/modelgate-audit-verification-20261111/browser-smoke-pr5.mjs` / `node /tmp/modelgate-audit-verification-20261111/browser-smoke.mjs` | 真实系统 Chrome + 隔离 mock。锁屏、管理登录、六个路由均通过，0 页面异常。完整浏览器套件 NOT_RUN。 `pr{5,6}-browser-smoke.{meta,log}`，附两张 dashboard 截图。 |
| #6 | 17:52:26 | `node scripts/test/codex-e2e.mjs` | 2/9，7 失败。真实本地 CLI、未创建认证文件、合成 API Key、官方角色和第三方均为 mock、用户网络命名空间仅有回环。三个 turn 均收到 413（测试夹具的 65,536 字节限制），上游命中 0。第二轮同时回退到默认模型元数据。零头部命中断言在未发送情况下无效。证据 `pr6-codex-e2e-meta.txt`、`pr6-codex-e2e.log`、`user-netns-probe.{meta,log}`。 |
| #6 | 17:55:08 | `node scripts/test/codex-e2e-scratch.mjs` | 8/9，1 失败。仅复制测试夹具到临时快照并把请求体上限改为 1 MiB，产品源码不变。三个 turn 完成，官方角色 mock 两次、第三方 mock 一次。官方角色未收到认证头，第三方轮仍报告模型元数据回退。回环命名空间、合成 Key，不能证明真实账号认证。证据 `pr6-codex-e2e-retry.log`、`pr6-codex-e2e-meta.txt`。 |

## 测试边界与证据质量

- `docs:check` 失败位置为 `docs/roadmap/2026-11-09-dsh-cli-live-verification-report.md`。当前目录结构中可存在目标文件，纯仓库检出及远端 runner 缺少该工作区外部文件。
- 全量旧集成 runner NOT_RUN。#5 会扫描常驻夹具与需参数的浏览器脚本。#6 采用排除列表，遗漏了读取认证文件并访问真实端点的 v1 live 脚本。历史 27/27 不能作为当前 head 安全执行该命令的证据。 [#5 runner](https://github.com/xiaomengxizzh/model-gate/blob/ec66b24b529cc6c4e531d2bb718ac22edb70f334/scripts/test/live.mjs#L14-L22) · [#6 runner](https://github.com/xiaomengxizzh/model-gate/blob/64a5c96df8ec6445371150fb21414b98aed1bac3/scripts/test/live.mjs#L14-L23)
- 真 CLI 双 mock 用 `timeout 55s`、`unshare -Urn`、仅回环和空路由表、`env -i`、独立临时 HOME/CODEX_HOME，指定本机 Codex 0.167.0 二进制和由该 CLI 生成的 12 项目录样本。两次 `strace` 文件访问记录均未引用 `auth.json`。临时夹具文件、运行参数、命名空间探测与版本见原始收据。
- 正式官方、OpenCode Go 及其他真实供应商调用、真实历史诊断/迁移、真实账户额度、真实 Desktop GUI 及 v2 协作本轮 NOT_RUN。既有真 CLI、真双上游文本和 Desktop 二进制记录独立保留在[审计](audit.md)的历史证据中。真实费用为 0。
- 本轮浏览器以本地夹具验证可打开性、鉴权和基本渲染。真实配置写入、冲突重试、复杂交互和 XSS 注入测试均未由该冒烟覆盖。Chrome 与夹具已退出。
- 未执行合并，合并后验收 NOT_RUN。已有测试通过数量针对各自断言范围。源码合并阻断见[审计](audit.md)。
