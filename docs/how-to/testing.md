# 执行测试

在仓库根目录运行：

```bash
npm run check
npm test
npm run docs:check
```

`npm test` 串行启动白名单内的自包含测试：virtual-models、effort-normalize、upstream-side-4xx，以及 offline 下的 Node 测试（管理面契约、来源策略、秘密边界、配置结构、指标口径、生命周期、协议 wire）。mock 不访问厂商服务；子进程显式使用测试主密钥。所有套件都用系统分配端口与 OS 临时目录（`scripts/test/isolate.mjs`、`scripts/test/offline/harness.mjs`），因此同一 checkout 可重复运行。

筛选如 `npm test -- probe`。筛选未命中返回非零，不作为“通过”。

## 旧集成套件

`npm run test:live -- 关键词` 运行 27 个旧套件。它们已迁移为自建隔离实例（mkdtemp 配置目录 + 动态回环端口 + 本地 mock 上游），因此只需 `MG_ALLOW_LIVE_TESTS=1`，不再要求 `MG_CONFIG_DIR`/`MG_GW`，也不会碰 8787 或真实上游。`live.mjs` 按文件独立子进程运行，退出码即结果。

旧套件已全部隔离（MG-004）：配置读写经加密 Key 与临时目录，上游为本地 mock，默认 `npm test` 与旧套件互不影响。`user-env-fallback` 的 Windows 分支在 Linux 上打印 `N/A`（不计通过）。仍不要为了让测试通过而关闭日常网关鉴权。

若测试失败，保留命令、错误、Node 版本和相关 diff，先排除端口占用，再判断行为回归。退出、SKIP 和超时均不得写成成功。
