# scripts/test · 测试入口与隔离迁移记录（MG-004）

本目录有两套测试：

| 入口 | 覆盖 | 是否需要外部网关 | 门禁 |
| --- | --- | --- | --- |
| `npm test`（scripts/test/run.mjs） | 白名单自包含套件：virtual-models、effort-normalize、upstream-side-4xx，以及 `offline/*.test.mjs` | 否 | 无（默认套件） |
| `npm run test:live -- 关键词`（scripts/test/live.mjs） | 其余旧集成套件（27 个文件，133 条断言） | 否（自建隔离实例） | `MG_ALLOW_LIVE_TESTS=1` |

所有用例只使用本地 mock 上游与虚构 Key，不访问厂商服务、不读写用户主配置。

## 隔离夹具（isolate.mjs）

旧集成套件统一使用 `scripts/test/isolate.mjs`：

- **OS 临时目录**：`mkdtemp(join(tmpdir(), 'modelgate-<name>-'))` 作为 `MG_CONFIG_DIR`/`MG_CONFIG`；不再在仓库内写 `.tmp-test-*`，也不读写目标网关配置。
- **动态回环端口**：网关端口先 `bind(0)` 预占再释放；mock 上游直接 `listen(0, '127.0.0.1')`；不再出现 8795/8796/8798、9891-9897 这类写死端口。
- **失败清理**：`fx.stop()` 先杀子进程并等其真正退出（`killAndWait`）再删临时目录——网关退出前仍会写日志/统计，先删会被重建；同时注册 `process.once('exit')` 兜底同步清理。
- **默认确定性**：夹具默认 `defaults.directory=[]`、`failbackProbe.enabled=false`、只允许 1 次重试与 5s 超时，避免未配置的兜底链或后台探活污染断言。
- **通过判定**：每个文件收尾调用 `finish()`，有任何 FAIL 即置非零退出码；live.mjs 按文件独立子进程运行，退出码非 0 即判该文件失败。

直接单跑任一旧套件（推荐排查单个主题）：

```bash
MG_ALLOW_LIVE_TESTS=1 node scripts/test/affinity.mjs
MG_ALLOW_LIVE_TESTS=1 node scripts/test/stream-failover.mjs
```

不再需要 `MG_GW`/`MG_CONFIG_DIR`：套件自己起实例，端口与目录都由 OS 分配。

## 迁移证据（改造前 → 改造后）

统一验证命令与结果：

```bash
MG_ALLOW_LIVE_TESTS=1 node scripts/test/live.mjs     # → 27/27 文件通过（共 133 条断言）
npm test                                             # → Isolated suites: 12/12 passed，exit 0
```

| 文件 | 改造前问题 | 改造后（本文件实测） |
| --- | --- | --- |
| acl.mjs | 依赖目标网关已配置 `deepseek-official`，未就绪时 3 条 SKIP | PASS 3/3 |
| affinity.mjs | 读改写目标网关配置，需运行中的网关 | PASS 4/4 |
| body-limit.mjs | 依赖外部 `MG_MAX_BODY`，未启用时 SKIP | PASS 1/1（实例以 maxBodyBytes=1000 启动） |
| circuit.mjs | 读改写目标网关配置 | PASS 2/2 |
| concurrency.mjs | 读改写目标网关配置，两段串在同一实例 | PASS 2/2（两段各一实例） |
| effort-normalize.mjs | 仓库内 `.tmp-test-effort` + 固定 8796 + mock 9891/9892/9893 | PASS 20/20 |
| empty-model.mjs | 读改写目标网关配置 | PASS 1/1 |
| failback.mjs | 读改写目标网关配置，20s 等后台探活 | PASS 5/5 |
| format-conversion.mjs | 读改写目标网关配置 | PASS 4/4 |
| key-encrypt.mjs | `keyEncrypted` 未开时 SKIP，依赖目标 keys 路径 | PASS 3/3 |
| logrotate.mjs | 仓库内 `.tmp-log` | PASS 7/7 |
| model-reject-failover.mjs | 读改写目标网关配置 | PASS 5/5 |
| modelstats.mjs | 读改写目标网关配置 | PASS 3/3 |
| payment-402-failover.mjs | 读改写目标网关配置（靠随机后缀避亲和残留） | PASS 7/7（实例天然无残留） |
| qps.mjs | 读改写目标网关配置 | PASS 2/2 |
| rate429.mjs | 读改写目标网关配置 | PASS 2/2 |
| sse-resume.mjs | 读改写目标网关配置 | PASS 1/1 |
| stream-drop-halfopen.mjs | 读改写目标网关配置 | PASS 6/6 |
| stream-failover.mjs | 读改写目标网关配置（场景 5 中途改 defaults） | PASS 10/10（场景 5 用第二个隔离实例） |
| stream-started-4xx.mjs | 读改写目标网关配置 | PASS 4/4 |
| tools.mjs | 读改写目标网关配置 | PASS 4/4 |
| trend.mjs | 依赖外部运行中的网关 | PASS 2/2 |
| upstream-side-4xx.mjs | 仓库内 `.tmp-test-upside` + 固定 8798 + mock 9894-9897 | PASS 7/7 |
| user-env-fallback.mjs | 非 Windows 时 1 条 SKIP；注册表写入失败也静默放行 | Linux 打印 `N/A ... 未执行，不计通过`；注册表写入失败改为抛错（未在 Windows 实跑，见下） |
| virtual-models.mjs | 仓库内 `.tmp-test-vm` + 固定 8795 + mock 9897 | PASS 18/18 |
| z-defaults-merge.mjs | 依赖目标网关验证保存合并语义 | PASS 7/7（保存只落在临时实例） |
| z2-noevent.mjs | 读改写目标网关配置 | PASS 3/3 |

## 未验证 / 已知缺陷

- **user-env-fallback（Windows 注册表实时环境变量）**：本机为 Linux，仅打印 N/A，未执行；Windows 分支代码按同一隔离模式改好但**未经 Windows 实跑**，不得记为通过。
- **真实上游**：全部用例只用本地 mock；真实厂商连通性与额度不在本套件范围（需单独授权与收据）。
- **logger 性能缺陷（已报 Lead，不在本任务写集）**：`src/logger.js` 的 `mask()` 用
  `/([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@)/gi` 兜底脱敏 URL 内嵌凭据，对「超长且无分隔符的单行」呈 O(n²)
  回溯（实测 16KB≈127ms、64KB≈1.7s、128KB≈6.8s、1MB 单行数十秒级），任何以单条超大日志行触发的路径都会被拖住。
  本套件 logrotate 已改为多行累计 6.5MB 触发轮转（轮转只看累计字节），不掩盖该缺陷也不被它卡死。
- `/tmp` 下可能见到 `modelgate-*` 残留目录：只来自被 `SIGKILL` 强杀（测试超时）的进程——正常结束与断言失败都会经
  `finally`/`process exit` 清理；连续跑完整套件后不应新增残留。
