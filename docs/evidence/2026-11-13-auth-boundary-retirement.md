# 2026-11-13 认证边界退役（G1）证据

- 日期：2026-11-13
- 范围：G1「认证边界收口」——退役 `gatewaySubscription` / `local-subscription` 生产认证路径
- 分支：`feat/mg-g1-auth-boundary`（worktree `.agents/worktrees/native-auth`）
- 基线：`dc7d15f`（= `feat/modelgate-native-delegation-20261113`，含 release `c6d97da` 与方案文档）
- 证据分级：**离线 mock + 静态扫描**。未执行真实 Codex / ChatGPT / OpenCode Go 上游请求，未读取真实 `~/.codex/auth.json`。
- 新增大型安装/下载：无。

## 1. 退役结论

- `src/codex/local-subscription.js` 已删除；生产代码不再读取 Codex 登录态（`auth.json` / `CODEX_HOME`），不再从 `CODEX_HOME` 推导订阅凭据。
- `src/index.js` 的 `proxyOfficialResponses` 与 Chat 桥不再有订阅凭据分支：官方目标只认网关自有 key。
- `src/codex/target-authz.js` 移除 `CREDENTIAL_MODES.GATEWAY_SUBSCRIPTION`；旧调用方传 `gatewaySubscription=true` 或 `credentialMode='gateway-subscription'` 得到 typed deny `gateway_subscription_retired`。`/backend-api/codex` 永不进入官方路径白名单。
- 残留 `providers.<id>.gatewaySubscription.enabled=true` 三个入口统一 fail-closed：官方原生 `/v1/responses`、第三方原生 `/v1/responses`、官方 Chat 桥。三者均 403 `gateway_subscription_retired` + **零上游命中**，不重试、不换账号、不改投其它候选。
- 启动时对残留配置写退役告警；`/api/status` 的 `gatewaySubscription` 恒为 false，旧配置另以 `gatewaySubscriptionRetired` 暴露（仅迁移提示）。
- P07 SIWC 原型（`src/subscription/*`）未改动，仍默认关闭。

## 2. 改动文件

| 文件 | 改动 |
| --- | --- |
| `src/index.js` | 删除 local-subscription import 与订阅发送分支；官方/第三方 responses 入口残留配置 fail-closed；状态字段与启动告警迁移提示 |
| `src/forward.js` | 不再把 `opts.gatewaySubscription` 传入授权 intent；转发链在并发/预算/任何上游发送前统一 fail-closed（覆盖 Chat 桥） |
| `src/codex/target-authz.js` | 移除 `GATEWAY_SUBSCRIPTION` 模式与订阅路径例外；导出稳定退役码/提示；旧声明 typed retired |
| `src/codex/local-subscription.js` | **删除**（git rm） |
| `scripts/test/offline/auth-boundary-scan.mjs` | **新增**：递归静态扫描单一实现（供两个套件复用） |
| `scripts/test/offline/native-boundary.test.mjs` | “不读取登录态”改为递归扫描全部 `src/**/*.js`，覆盖 F01 回归漏掉的 `local-subscription.js` |
| `scripts/test/offline/codex-p09-native-proxy.test.mjs` | 由 P09 正向代理验证改造为“退役 + 静态扫描”套件（文件名保留，`run.mjs` 无需改动） |
| `docs/reference/configuration.md` | P09 段标记已退役并给出迁移；F01 段落补 G1 说明 |
| `docs/explanation/adr-0002-codex-aggregation-identity.md` | 增加 2026-11-13 G1 修订 |
| `CHANGELOG.md` | Unreleased 增加 G1 行为变更 |
| `docs/evidence/2026-11-13-auth-boundary-retirement.md` | 本文件 |

未改动（按分工）：`package.json`、`scripts/test/run.mjs`、`docs/development-plan.md`。

## 3. 验证命令与结果

本机 Node `v24.22.2`，全部离线；测试使用 OS 临时目录、动态回环端口、合成 Key 与合成登录态。

| 命令 | 结果 | exit code |
| --- | --- | --- |
| `node --test --test-reporter=spec scripts/test/offline/codex-p09-native-proxy.test.mjs` | 13 pass / 0 fail（原套件 8 个用例，改造后 13 个） | 0 |
| `node --test --test-reporter=spec scripts/test/offline/native-boundary.test.mjs` | 9 pass / 0 fail | 0 |
| `npm test` | **77 suites passed，787 pass / 1 skip / 0 fail**，71.1s（基线 77 / 782 / 1 / 0） | 0 |
| 等价 `npm run check`（去掉首个 `node --check src/codex/local-subscription.js && `） | 全部 node --check + `scripts/check-ui.mjs` 通过 | 0 |
| `npm run check`（未修改 `package.json`） | 首项指向已删除文件，立即失败；需 Lead 删除该片段（见下） | 1 |
| `node scripts/check-metadata.mjs` | PASS（39 checks） | 0 |
| `npm run docs:check` | PASS（本文件创建后） | 0 |
| `git diff --check` | clean | 0 |

说明：未修改的 `package.json` 的 `scripts.check` 首项仍指向已删除文件，直接执行 `npm run check` 会在第一步 exit 1；这是**唯一**待 Lead 处理的一行。需要删除的片段：

```diff
- node --check src/codex/local-subscription.js && node --check src/observability/events.js && ...
+ node --check src/observability/events.js && ...
```

## 4. 回归覆盖点

1. **静态扫描（可抓 F01 回归）**：递归扫描 `src/**/*.js`，出现 `.CODEX_HOME` 读取、`auth.json` 读取（防御性路径护栏模块白名单除外）、`readSubscriptionCredential` / `local-subscription` 引用、`'/backend-api/'` 请求路径字面量、`'.codex'` 目录拼装任一即失败；并断言 `src/codex/local-subscription.js` 不存在、`src/index.js` 不再 import。
2. **三入口零上游**：官方原生 responses / 第三方原生 responses / 官方 Chat 桥分别在残留 `enabled=true` 时 403 `gateway_subscription_retired`，mock 上游命中 0；合成 auth.json 中的 token 不出现在响应或日志。
3. **不依赖登录态**：即使临时 HOME 中存在合成 auth.json，行为仍是 403 retired（不读取、不回退）。
4. **保留能力**：官方自有 key 直连 `/v1/responses` 200、客户端官方头零透传、父 V2 不扁平化；F01 的 `official_no_gateway_key` 仍 fail-closed。
5. **原 P09 回归保留**：子 Go 明文投影、密文拒绝矩阵、4xx 脱敏、工具历史不重放、SSE 单终态/usage once/EOF failed。

## 5. 未验证项

- **`npm run check` 原样执行**：受 `package.json` 旧条目录入影响，需 Lead 删除首项后才全绿（本文件 §3 给出精确片段）。
- **真实上游**：未用真实 Codex/ChatGPT/OpenCode Go 账号验证；本轮不消耗真实额度，也未读取真实登录态。
- **真实管理 GUI/面板**：`gatewaySubscriptionRetired` 字段已进入 `/api/status`，但未做浏览器/托盘实跑；当前无 UI 消费该字段。
- **development-plan.md**：按 Lead 分工不由本任务更新。

## 6. 回滚点

- 回滚基线：`dc7d15f`（本任务提交的父提交）。
- 撤销本提交：`git revert <本提交 SHA>`；或在独立 worktree 执行 `git checkout dc7d15f -- src scripts/test/offline/native-boundary.test.mjs scripts/test/offline/codex-p09-native-proxy.test.mjs docs/reference/configuration.md docs/explanation/adr-0002-codex-aggregation-identity.md CHANGELOG.md` 并恢复 `src/codex/local-subscription.js`（`git checkout dc7d15f -- src/codex/local-subscription.js`）。
- 回滚只恢复实验性订阅代理代码，不涉及生产 8787、systemd、用户 Codex 配置或真实凭据；回滚后 `package.json` 的 check 首项需同步恢复。
