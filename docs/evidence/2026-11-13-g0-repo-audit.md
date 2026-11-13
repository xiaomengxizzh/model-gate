# G0 现场冻结与分支审计（2026-11-13）

- 执行基线：`plan/modelgate-native-delegation-20261113` @ `dc7d15f`（= `integration/modelgate-release` @ `c6d97da` + 方案文档一个提交）
- 执行分支：`feat/modelgate-native-delegation-20261113`
- 隔离工作树：`.agents/worktrees/native-delegation`
- 新增大型安装/下载：**无**。未安装依赖、未下载模型、未新增运行时包。
- 未触碰：生产 8787、systemd、`~/.codex/config.toml`、`~/.codex/auth.json`、用户 sessions。

## 1. 现场核对

| 项 | 事实 |
| --- | --- |
| 主工作树 HEAD | `dev/gateway-audit-20261108` @ `3a4ba89`，未提交改动 4 项（`config/videos.json`、`scripts/tray/icons/`、`scripts/tray/mg-prices.json`、`scripts/tray/mg-tray-linux.py`）——**保持原样未动** |
| 既有 worktree | 8 个（含 `codex-multiagent-v2`、`mg-codex-native`）；本轮新增 4 个隔离工作树，未复用/未重置任何既有工作树 |
| `integration/modelgate-release` | `c6d97da`，相对 `main` **ahead 246 / behind 0** |
| merge-base(main, release) | `6bc6441`（= `origin/main` head），说明 release 是 main 的直系后代，**可 fast-forward** |
| 本地 `main` | `e746385`，与 `origin/main` 相差「领先 17 / 落后 2」——本地 main 未同步，本轮不改 |
| 远端分支 | 20 个；PR #5/#6 仍是 Draft，release 分支**没有** PR |
| 方案文档位置 | 只在 `plan/modelgate-native-delegation-20261113`，release 分支上没有 |

## 2. release 相对 main 的 246 个提交差异

```
commits: 246（其中 merge 51，非 merge 195）
files:   310 changed, +64960 / -1419
按目录: scripts 133 / docs 106 / src 61 / 其余 10（package.json、bin、README、LICENSE、CONTRIBUTING、CHANGELOG、AGENTS、.gitignore、.github、.gitattributes）
```

提交类型分布（top）：

| 类型/范围 | 数量 | 归属 |
| --- | --- | --- |
| `merge` | 51 | 分支整合提交（无独立语义） |
| `test(codex)` / `docs(codex)` / `fix(codex)` / `feat(codex)` | 11 / 11 / 3 / 5 | Codex 原生适配、V2 互操作、目录/身份/额度 |
| `chore(test)` / `fix(test)` / `feat(test)` / `test(test)` | 10 / 4 / 2 / 1 | 测试基建（隔离 runner、超时回收、白名单） |
| `feat(ui-next)` / `fix(ui-next)` / `fix(ui)` / `feat(admin)` | 6 / 2 / 1 / 3 | 新控制台预览与旧管理面 |
| `fix(forward)` / `feat(forward)` / `fix(responses)` | 4 / 3 / 2 | 转发链、Responses 桥、SSE 生命周期 |
| `feat(MG-0xx)` / `docs(MG-0xx)` | 4 / 2 | MG 任务卡（预算、投影、Embedding、Responses） |
| 其余 `docs(...)` / `fix(...)` | ~50 | 证据、审计、计划、零散修复 |

结论与处理意见：

1. release **不是**一个「小型功能 PR」：195 个实质提交、310 个文件。但它相对 main 是**纯增量**（merge-base = main head），因此整合动作本身是 fast-forward 语义，风险集中在「审阅范围过大」而不是「冲突解决」。
2. 差异主体是测试与文档（239/310 文件），运行时代码 61 个文件；本轮不再重复审计全部历史，只对与本轮相关的部分做定向核对（认证边界、Responses 发送链、MCP/路由、SSE 生命周期）。
3. 已核实的关键事实：`src/codex/local-subscription.js` 在本基线**仍在生产路径**（`src/index.js` 直接 import），与 11/12 的 F01「不读 auth.json」结论冲突——这就是本轮 P0 要收口的问题，不是历史遗留等价物。
4. 本轮**不**合并、不 push、不开 PR；release 整合留到 G8，并按用户批准执行。

## 3. 基线测试证据（本机真实复跑）

执行目录：`.agents/worktrees/native-delegation`，Node v24.22.2 / npm 11.19.1。

| 命令 | exit | 结果 |
| --- | --- | --- |
| `npm run check` | 0 | 全部 `node --check` + `check-ui` 16/16 |
| `npm test` | 0 | **77 套件 / 782 通过 / 1 跳过 / 0 失败**，70.5s |

与文档记录（76 套件 / 774 通过）的差异属于 11/13 复核记录之后的继续累积，本表是本轮现场事实，不回填历史。

## 4. 回滚

`git worktree remove .agents/worktrees/native-delegation` + 删除分支 `feat/modelgate-native-delegation-20261113`。主工作树与用户未提交改动不受影响。
