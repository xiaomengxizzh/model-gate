# ModelGate Git 与 PR 审计

日期 2026-11-11（Asia/Shanghai）。核对 GitHub PR、远端 refs、本地提交图及全部已登记工作树。GitHub default branch 为 main，远端 HEAD 为 `6bc6441fc7bf3e620b19af5af3b4d62543b31193`。本地同名 main 指向 `e7463857b920a9844c49fcb7e86446b0607e64c9`，领先 17、落后 2。合并基线以远端 main 为准。

## 远端分支和依赖

| 远端分支 | HEAD | 关系及处理 |
| --- | --- | --- |
| `main` | `6bc6441` | 默认分支。含资源治理和两个轨道的规划。 |
| `integration/modelgate-next` | `ec66b24` | #5，远端 main 的后代，包含 #4、审计分支及硬化线。 |
| `dev/codex-aggregation-20261111` | `64a5c96` | #6，`ec66b24` 直接作为栈底，增加 23 个提交。 |
| `dev/ui-next-integration-plan-20261109` | `35bed9b` | #4，从 `3a4ba89` 增加三个提交，已是 #5/#6 祖先。 |
| `dev/gateway-audit-20261108` | `3a4ba89` | 已被 #5 吸收，曾独立推进安全和生命周期修复。 |
| `dev/gateway-hardening-20261107` | `e746385` | 与本地 main 同 SHA，17 个硬化提交均在 #5 历史中。 |
| `dev/gateway-g0-g4-20261107` | `66f274c` | 与 #5 有 `6bc6441`、`e746385` 两个 merge base。左右独有提交计数为 8/46。重复开发 lifecycle、429、Responses、Codex 与管理契约，保留断言与差异审计。 |
| `docs/codex-aggregation-d1-d7-20261110` | `4006591` | 从 #5 head 增加两个文档提交。#6 自带后续规格副本，需核对文字差异后归档。 |
| `feature/codex-opencode-go-adapter-20261107` | `9a0bfe3` | #2，基于 `7d616cc` 的独立实验，提交未进入 #5。 |
| `planning/gateway-and-frontend-rebuild-20261107` | `5712965` | #3 已合并到 main。 |
| `governance/owner-resource-approval-20261106` | `a1937de` | #1 已合并。 |

主线依赖 `main 6bc6441 → #5 ec66b24 → #6 64a5c96`。其中 `3a4ba89 → #4 35bed9b → #5`；#2 仍是分叉；G0–G4 与 #5 是共享历史后的并行实现。#3 的合并时间 2026-11-07 21:06:51，#1 的合并时间 2026-11-06 11:46:02。

## 全部开放 PR

GitHub 返回四个 Draft，均报告 MERGEABLE/CLEAN，未给出独立 review decision，`statusCheckRollup` 均为空。最近 Actions 列表为空，`main` 无启用分支保护及 branch rules。17:45 再次核对 PR base/head 与远端 main、#5、#6，保持同一 SHA。本轮远端 CI 状态为无记录。#5/#6 的 `check.yml` 只有 `workflow_dispatch`，默认 main 未提供该 workflow。 [候选 CI 配置](https://github.com/xiaomengxizzh/model-gate/blob/ec66b24b529cc6c4e531d2bb718ac22edb70f334/.github/workflows/check.yml)

| PR | GitHub base → head | 范围 | 裁决 |
| --- | --- | --- | --- |
| [#2](https://github.com/xiaomengxizzh/model-gate/pull/2) | `main 7d616cc1507d2889bc726b192a21db409f316518` → `9a0bfe3b7517068fb932dc4054c0192fee4e3791` | 6 commits，6 文件，+473/-3 | **关闭建议，暂留 Draft 至替代验收。** 专用 bridge 自己做鉴权前后的路由条件、头、SSE 和错误。对 quota、fallback、virtual 的拒绝限制使其无法替代通用路径。#5 的通用桥及 #6 的 OpenCode Go 会话处理覆盖其方向，待新切片通过后归档。当前 GitHub API base 和合并模拟 parent 仍为旧 SHA，远端 main 已前进一个合并提交。 [实验处理器](https://github.com/xiaomengxizzh/model-gate/blob/9a0bfe3b7517068fb932dc4054c0192fee4e3791/src/codex-handler.js#L20-L55) |
| [#4](https://github.com/xiaomengxizzh/model-gate/pull/4) | `dev/gateway-audit-20261108 3a4ba8956732e2aabdff2cfce8a118107189542a` → `35bed9bfc0bd8b013312460ffcb4d51de7dbe087` | 3 commits，6 文件，+435/-0 | **保留出处，建议替代集成后关闭。** 三个提交全在 #5，#5 重写前端壳并扩大 API 接线与路由；独立合并只增加两条共享分支的集成噪声。 |
| [#5](https://github.com/xiaomengxizzh/model-gate/pull/5) | `main 6bc6441fc7bf3e620b19af5af3b4d62543b31193` → `ec66b24b529cc6c4e531d2bb718ac22edb70f334` | 63 commits，169 文件，+19,211/-1,304 | **暂缓，拆分返工。** 继承主干配置 Key 缺陷，存在原生与桥接治理差异、重放和视频幂等问题。离线 30/30 对现有断言成立，纯检出 docs check 失败，远端 CI 无记录。优先独立修主干 P0，随后基础治理、Responses、控制台、可选端点分片。 |
| [#6](https://github.com/xiaomengxizzh/model-gate/pull/6) | `integration/modelgate-next ec66b24b529cc6c4e531d2bb718ac22edb70f334` → `64a5c96df8ec6445371150fb21414b98aed1bac3` | 23 commits，85 文件，+14,612/-114 | **暂缓，分拆安全、目录/协议、调度、管理。** #5 未就绪，另有官方身份误路由和 Codex 配置文件信任域 P0。45/45 离线通过并未覆盖完整产品闭环。保持堆叠依赖，待 #5 修订进入主干后重新固定比较点。 |

**实际合并 0 项。** 合并 SHA 和合并后验证均为 NOT_RUN。分支与 PR 继续保留作审计基线，未改远端 PR 状态。恢复集成时先验证小 PR 合并树，确认无 P0、核心流程与文档/CI 通过，然后按实际依赖集成，合并后按新 SHA 复验。部署权限另计。

## 工作树与并发

开始时有五个工作树。源仓库 `model-gateway` 在 `3a4ba89` 有既有未跟踪托盘和视频配置文件。`model-gate-frontend` 在 `6bc6441`，已有未提交 `src/index.js`、前端和脚本改动。`model-gateway-dev`、`model-gateway-next`、`model-gateway-codex-agg` 分别是 `66f274c`、`ec66b24`、`64a5c96`，初次 Git 状态干净。Git 锁与已观测进程仅提供时点信息，无法证明所有外部 agent 的未来写入状态。

交付使用从 `6bc6441` 建立的本地 `audit/modelgate-20261111` 和独立 worktree，仅写审计文档。Luna 使用 archive 源树及隔离目录复验。registry 的 `affected/used-by` 因多个 worktree manifest 目录名冲突及其他项目 schema 失败，陈旧缓存拒绝输出。跨仓依赖为 UNKNOWN。UHR 的规划边界基于现有源码和文档阅读，待未来集成重新绑定实际契约。 [复验记录](verification.md)
