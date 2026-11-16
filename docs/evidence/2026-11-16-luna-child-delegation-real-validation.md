# luna 父→Go DeepSeek 子派单失败：根因与真实修复验证（2026-11-16）

> 所有者报告：deepseek 父能调子代理成功，但切到 luna 父后回报
> “当前没有可用的子代理调用入口，因此我无法按要求调用 deepseek…子代理”。本文记录根因、
> 两处真机缺陷的修复与生产 8787 上的真实验证。真实调用已获授权、有界；未改真实
> `~/.codex/config.toml`（sha `8f3d6cc6…` 前后一致）；隔离 CODEX_HOME 仅临时副本，已清理。

## 1. 现象与根因（两个独立缺陷）

### 缺陷 A：luna 父没有 spawn_agent 入口（目录能力声明）
- 生产聚合目录 `config/aggregation/catalog/local/current.json` 的 luna 用官方 baseline 原值：
  `tool_mode="code_mode_only"` + `use_responses_lite=true` + `multi_agent_version="v2"`。
- 真机证据（`aggregation-v2-real-acceptance` §L66）：这种声明下 Codex 发 `tools:None`，
  不下发 `spawn_agent`/collaboration 工具 → 父回报“没有可用的子代理调用入口”。
- 对比：deepseek 子条目走 `codex.plaintextTools` 原生工具声明，故 deepseek 父能派单。
- 而真机证明可派单的父声明是 `mg-desktop.mjs configure()` 的覆盖：
  `tool_mode="direct"` + `use_responses_lite=false` + `multi_agent_version="v1"`。

**修复 A**（`6a5982c`）：在 `codex/catalog.js` 抽出共享投影 `asNativeDelegationParent`/
`projectNativeDelegationBase`，聚合目录 `publish()` 对所有带 `multi_agent_version` 的官方父模型
投影成上述声明（跳过 `mg-*` 第三方，保持目录世代/回滚完整，不改入参）；`configure()` 复用同一
投影消除漂移。生产目录经产品 publish 路径重发：世代 4→5，luna 变 direct/false/v1，12 模型不变。

### 缺陷 B：子请求被 Go 上游拒绝（access_programs）
修复 A 后重跑，luna 已能 spawn，但子请求报：
`access_programs: requires a native Responses target; portable routing requires the full conversation in input`。
`access_programs`/`prompt_cache_key` 是官方 Responses 目标专属顶层控制，不携带对话内容；
Chat 兼容桥 `responses.js:625` 早已对第三方剔除，但原生 `projectThirdPartyResponsesParams` 未处理。

**修复 B**（`467bfc8`）：`projectThirdPartyResponsesParams` 对第三方目标剔除
`access_programs`/`prompt_cache_key`，官方目标逐字节保留。`agg-v2-third-party-params` 7/7。

## 2. 生产 8787 真实验证（隔离 CODEX_HOME，model=gpt-6-luna→8787）

| 阶段 | 结果 |
| --- | --- |
| 缺陷 A 修复前（上次验证） | 父报“没有可用的子代理调用入口”，无 spawn |
| 修复 A 后 | 日志出现 `collab: Wait`（父已 spawn）；子请求报 `access_programs` 400 |
| 修复 A+B 后（本次） | **子代理文件 `LUNA_CHILD_OK` 成功创建**；日志 `剔除 …access_programs,prompt_cache_key` 后子请求成功，无 400 |

Rollout 证据：父 `gpt-6-luna`（refs: spawn_agent + wait_agent + go_deepseek）→
子 `mg-opencodego-deepseek-v4-1-flash`（refs: go_deepseek），无 MCP 自建调度。
`codex exec` 本次 EXIT=124 是隔离副本带进来的无关 `penpot` MCP（localhost:9001）反复重连拖到超时，
子任务本身已完成；与 ModelGate 无关（隔离 HOME 已清理，不含 penpot 的正常用户环境不受影响）。

## 3. 状态
- **PASS_REAL（本树/生产 8787）**：luna 父→Go DeepSeek 子原生派单（spawn/wait/工具结果），
  无 MCP、无“无子代理入口”、无 `access_programs` 400。
- 离线：`agg-native-delegation-parent` 4/4、`agg-v2-third-party-params` 7/7；全量 suite 127 套件绿。
- MG-R006 原生压缩仍 BLOCKED（本轮未覆盖压缩触发）。
- 生产 8787 / PID 拓扑：本轮重启后 PID 755364，healthz ok；`main`/`deploy` 分支未改。

## 4. 复现（离线零额度）
```bash
node --test scripts/test/offline/agg-native-delegation-parent.test.mjs
node --test scripts/test/offline/agg-v2-third-party-params.test.mjs
```
