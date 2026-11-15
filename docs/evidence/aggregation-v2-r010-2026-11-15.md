# ModelGate V2｜配置写入的崩溃恢复、回滚与冲突（MG-R010 真机）

> 被测树：`787953f`（本轮无代码改动）。环境：隔离 `config.toml`（`/tmp/mg-r010/target`）、
> 真实进程 `SIGKILL`、真实网关健康端点（`127.0.0.1:18884`）。**零模型推理请求**。

## 1. 方法

1. 基线 `config.toml`（含 `model`/`model_provider`/`[features]`/`[mcp_servers.docs]`，模拟已有手改配置）。
2. `desktopPreview()` 取 `consentToken` + `expectedSha`（写前预览）。
3. 子进程执行 `desktopActivate()`，父进程在 `[0,2,5,8,12,20,35,60,120,250]ms` 后发 `SIGKILL`。
4. 每次崩溃后检查：配置文件是否完整、`detect()` 是否可读、`deactivate()` 能否恢复、最终是否与基线逐字节一致。
5. 对照组：不中断的 `activate → deactivate`。
6. 冲突组：预览后由"用户"手改文件，再用旧 token 激活。

## 2. 结果

| 观测 | 结果 |
| --- | --- |
| 10 次不同时点 `SIGKILL` | **配置从未半写**：每次读回都是完整 TOML（`afterComplete=true`）|
| 崩溃时点 `<60ms`（写前/写中） | 文件保持基线；恢复后 `deactivate` 返回 `not_aggregated`（没有半成品状态）|
| 崩溃时点 `60ms`（已写完、尚未返回） | 文件已聚合 → 恢复后 `deactivate` 成功 → **逐字节回到基线** |
| 全部 10 次 | `rollbackByteIdentical=true` |
| 对照（不中断） | `activated=true`、字节确实变化、`deactivated=true`、**恢复逐字节一致** |
| 冲突（预览后手改） | `409 concurrent_modification`，**用户改动被保留**（未被覆盖）|
| 写后网关不可达 | activate **自动回滚**（`restored=true`，`restoredSha` = 基线）：写后校验失败不会留下"已接入但不可用"的状态 |

## 3. 判定

- `MG-R010` 的三个用例——`rollback-byte-compatible`、`crash-recovery`、`conflict-409`——在真实进程崩溃与真实文件系统上均成立。
- 边界：本测试覆盖配置写入层（`src/codex/desktop-integration.js` 的真实 `activate/deactivate`），
  不覆盖"从 GUI 点击"的路径（那是 R001/R004 的范围）。

## 4. 复现

脚本：`scripts/test/live/desktop-crash-recovery.mjs`（参数化 `--config`、`--catalog`、`--health-port`，只读/可丢弃目录）。

```bash
node scripts/test/live/desktop-crash-recovery.mjs \
  --config /tmp/mg-r010/target/config.toml --catalog /tmp/mg-r010/catalog.json --health-port 18884
```

## 5. 费用

零模型调用；只产生本地文件与进程。
