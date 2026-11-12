# Codex 0.167.0 role/provider 反向 fixture（P01）

本目录只服务 [ADR-0003](../../../../docs/explanation/adr-0003-codex-role-provider-boundary.md) 与
[`codex-role-provider.test.mjs`](../../offline/codex-role-provider.test.mjs)。它**不是** upstream Codex 源码，
也**不会**执行 Codex CLI、访问网络、读取 `auth.json`、真实会话或任何凭据。

## 文件

| 文件 | 作用 |
| --- | --- |
| `role-provider-matrix.json` | 锁定版本 `0.167.0-linux-x64`、provenance、四矩阵（官方直连 / mock 双 provider / 同 provider / SIWC preview）、证据与状态枚举、终止条件 |
| `role-provider-0.167.0.mjs` | 合成 parser + `resolveChild()`：provider 恒继承父 turn；role 的 `model_provider` 被忽略并留诊断 |
| `roles/0.167.0-negative.toml` | 隔离客户配置夹具：父 `probe-a`，role 故意写 `probe-b`；仅 loopback + 合成 key 名，不写入真实 HOME |
| `README.md` | 本说明 |

## 边界

1. 锁定事实来自计划包引用的 upstream 源码（`child_config.rs` / `role.rs`），本环境禁网且无本地 Rust 检出，故标 `UNKNOWN_PRIMARY_SOURCE`，不声称已独立复核。
2. 本机 CLI 在 `bwrap` 不可用下无法启动，真实 CLI 用例标 `BLOCKED_ENV`，归 Q02（需 OS 级出网隔离）。
3. 这里验证的是**不支持行为**：role 不能换 `model_provider`。role 只能在同一 provider 身份内换 `model`。
4. 任何“role 换 provider 成功”的改动都应让测试失败；不要放宽 fixture 去迁就实现。
5. 未来新版本正式支持 role-level provider 时，先 supersede ADR-0003，再新增正向用例。

## 运行

```bash
node --test scripts/test/offline/codex-role-provider.test.mjs
```

新测试文件尚未登记进 `scripts/test/run.mjs`（该清单由 Lead 独占）；登记行见 P01 回报。
