# V2 支线合并与清理记录（2026-11-15）

> 目的：主线 `mg-codex-native` 是唯一活跃 V2 分支；所有子代理支线的内容已核对为 patch-equivalent（`git cherry` 全为已应用），归档后不再参与构建。
> 合并方式：集成时逐提交 `cherry-pick`（保留各子代理的分步提交与署名），**没有** squash、没有改写历史。

## 1. 结论

| 支线 | 原提交链 | 归档名 | 状态 |
| --- | --- | --- | --- |
| A1 原生压缩协议 | `5e6c069`→`d232ba6`（4）| `archive/v2-a1-native-compaction` | 已合入 |
| A1 工具下发声明 | `f9b0278`、`ee83f35`（2）| `archive/v2-a1-tool-declaration` | 已合入 |
| A2 Go 单模型 | `9a2c552`→`204faa6`（6）| `archive/v2-a2-go-deepseek` | 已合入 |
| A3 Desktop/config | `14b14a9`→`a568f98`（4）| `archive/v2-a3-desktop-ux` | 已合入 |
| A3 GUI 真机证据 | `d539680`、`bc502ca`（2）| `archive/v2-a3-gui` | 已合入 |
| A4 订阅与安全 | `31c981c`→`241abcb`（6）| `archive/v2-a4-auth-isolation` | 已合入 |
| A4 订阅策略 A | `781cd8d`→`59d30d7`（3）| `archive/v2-a4-subscription` | 已合入 |
| A5 独立验收 | `2e8e70a`（1）| `archive/v2-a5-acceptance` | 已合入 |

核对方法：

```bash
for b in <每个支线>; do git cherry mg-codex-native "$b" | awk '{print $1}' | sort | uniq -c; done
# 输出全部为 "-"（等价补丁已在主线）→ 内容已包含
```

同时确认：`git diff <支线>..mg-codex-native` 只显示主线后续新增（门禁修补、状态证据、注册套件），没有支线独占内容。

## 2. 清理动作

- 移除 15 个临时工作树：`v2-a1`、`v2-a1-tools`、`v2-a2`、`v2-a3`、`v2-a3-gui-fixed`、`v2-a4`、`v2-a4-subscription`、`v2-a5`，以及 A5 七轮复核的 detached 树 `v2-a5-final`…`v2-a5-final7`。
- 移除嵌套在工作树内的历史遗留 `agg-a2-realshape`（其分支同样已包含）。
- 8 条 `feat/v2-*` 本地分支重命名为 `archive/v2-*`（保留历史与提交，不删除）。
- `origin/feat/v2-a3-gui` 与主线内容等价，作为历史保留在远端；不再用于后续开发。
- V1 时代的 `feat/agg-*` 工作树（A1–A5、chatcompat 等）未动：它们属于 V1 历史证据链，与 V2 无关。

## 3. 主线当前状态（清理后）

- 分支：`mg-codex-native`；远端 `origin/mg-codex-native` 与本地一致（见 `git log --oneline -1`）。
- 工作树：仅 `.agents/worktrees/mg-codex-native` 一个 V2 工作树。
- 门禁：`npm test` 119 套件 / 1135 用例；`gate:v2` 9/9；`matrix-v2 --check` byte-identical；`audit-diff --all-commits` 无未批准 findings。
- 发布门禁：`npm run release:freeze` 仍会 FAIL 并列出 6 项待重跑的 `PASS_REAL`（中间树回执不作为发布证据）。

## 4. 后续规则

1. 新工作直接在 `mg-codex-native` 或从它开的新短分支上进行；不要再从旧的 `archive/*` 分支拉工作树。
2. 子代理交付统一走「独立工作树 + 逐提交 cherry-pick」，完成后按本文件方式归档支线并移除工作树。
3. 若需保留某个支线用于对照，先在本文件登记原因，再保留工作树。
