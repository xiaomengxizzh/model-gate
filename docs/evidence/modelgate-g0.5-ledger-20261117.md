# ModelGate｜G0.5 研究台账（2026-11-17）

> **只读研究文档 / READ-ONLY RESEARCH** — 状态 **NOT_RUN**：未做真机、未发付费请求、未启动服务、未改源码、未改生产配置、未 push、未合并 main。
> 本文机械集成 G0.5 五份只读研究的结论，**不构成真实验收证据**，不伪造 `PASS_REAL`。
> 基线 main = `886e22a`。关联裁决见 [modelgate-g0-arbitration-20261117.md](modelgate-g0-arbitration-20261117.md)。

## 1. 三路径对照

| 路径 | 端点 | 原生性 | 传输/能力要点 | 关键缺口 / 阻断 |
| --- | --- | --- | --- | --- |
| **A direct** | 官方直连 | 高 | 原生 300s 超时 + 5 重试 + 永久降级 | 跨供应商密文不可解（#33267） |
| **B ModelGate** | 8787 | 中 | WS 桥 + 128/128/6h 缓存 | 缺 60min 上限恢复 + failover 保真；**唯一阻断 P0-B（孤儿 output 400）** |
| **C CC Switch** | 15721 | 低 | 无 retry-continuation（#8126 #8281） | 真 WS（#8404 open）、426 退化 |

对照结论：A 原生性最高但跨供应商密文不可解；B 为当前唯一需收敛的网关路径，P0-B 未解前不得记 `PASS_REAL`；C 能力最弱且存在未关闭 Issue，不作为主路线。

## 2. 假说表（每条绑定可证伪实验）

| 编号 | 假说 | 机制 | 可证伪实验 / 判据 |
| --- | --- | --- | --- |
| **H-A** | id 形状串线 | 官版 56hex 与 Go 侧 32hex 不一致 → reconstruct miss → 400 | P3 分类器 + P5 degraded + 下轮 400；若分类器正确区分形状则证伪。 |
| **H-B** | 默认 `completed` 早登记 | 无终态却标 `completed` → 孤儿 output | P5 `status=completed` 但 P4 无终态、无 `function_call`；同时成立即证实。 |
| **H-C** | 半死流无看门狗 | keepalive 无 data 事件 → 悬挂 + 默认登记 | 注入仅 keepalive 流，`noEventMs` 内未杀即证实。 |
| **H-D** | finish 竞态吞终态 | WS 合成 `failed:436` 缺 id/error + 环回未 abort | P4/P5 出现 synthetic `failed` 且 finish 后环回仍在跑即证实。 |
| **H-E** | 跨供应商 V2 密文不可解 | GPT 父 spawn 第三方子 → `unreadable_encrypted_agent_task` → NO-GO | 真机复现该错误即证实；A 路径跨供应商场景直接判 `FAIL_REAL`/NO-GO。 |

## 3. ADR 候选

| 候选 | 方案 | 适用 / 约束 | 裁决意见 |
| --- | --- | --- | --- |
| **a** | 原生透传 | 仅同 provider；跨供应商 `FAIL_REAL` | 同 provider 可用，不能单独满足跨供应商。 |
| **b** | 连接内缓存重建 | 推荐主路线 | **推荐**；P0-B 未解前不记 `PASS_REAL`。 |
| **c** | 客户端压缩 PR#4092 / MIT | 需切 named provider，与所有者决议冲突 | **待裁决**，不得擅自采用。 |
| **d** | typed 拒绝 | 底线 | 作为安全底线保留。 |

**结论**：a + b 互补，d 为底线，c 待裁决；**单条候选均无法满足 MG-R006**，须组合（a+b）并保留 d 底线，c 经所有者裁决后方可纳入。

## 4. 已解决项

- **GUI 403**：代码层已修（`5481bd9` 祖先；local 不传 `chatgptPlan`），真机 **NOT_RUN**（未在真机复验，不记真实通过）。
- **§2.2 三处精度修正**：
  1. 降级为**进程/客户端级**；
  2. `x-codex-turn-state` 随 **auth owner 清空**；
  3. **25min 为推导值**（非实测常量）。
- **P0-B 取证前置**：使用隔离端口 **18790** 即可满足「网关在线」前置，**无需触碰生产 8787**。

## 5. 集成清单与状态声明

本批集成的 G0.5 成果（共 33 个取回文件）均为**只读研究产物**，与来源逐字节一致（sha256 已核，0 处不符），状态统一为 **NOT_RUN / 只读研究 / 未做真机 / 未发付费请求**：

| 来源 | 取回路径（相对本仓库根） | 文件数 |
| --- | --- | --- |
| A1 @ `cc34e11` | `docs/research/modelgate-ccswitch-local-source-atlas-20261116.md` | 1 |
| A2 @ `8c02418` | `docs/research/a2-codex-native-findings.md` | 1 |
| A2 @ `8c02418` | `docs/research/evidence/rust-v0.167.0/`（含 `tree.json` 等） | 27 |
| A3（未提交，取自 worktree） | `docs/research/A3-transport-route-research-20261117.md`、`pr4092.diff`、`codex-integration.md` | 3 |
| A5 @ `4966751` | `docs/evidence/a5-g0.5-isolation-receipts-20261117.md` | 1 |

> **说明**：为满足「逐字节一致」硬约束，取回文件原文未注入横幅；其只读/NOT_RUN 状态由本台账与 [G0 裁决记录](modelgate-g0-arbitration-20261117.md) 统一声明。
