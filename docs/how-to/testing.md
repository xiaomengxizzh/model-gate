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

`npm run test:live -- 关键词` **只运行** `scripts/test/live.mjs` 里 `EXECUTABLE_ALLOWLIST` 明确列出的旧套件（当前 27 个）。**正向白名单是安全边界**：`scripts/test` 下的其它文件（当前 47 个顶层 `.mjs` 中的另外 20 个：夹具/工具，或需要真实凭据/真实上游的手动取证脚本）一律 `present-but-not-allowed`，**不在清单里就永远不会被选中执行**。第二道显式 opt-in 是 `MG_ALLOW_LIVE_TESTS=1`，与白名单是 AND 关系（只有一个不成立就不启动）。危险特征 denylist（`auth.json`/`.codex`/`chatgpt.com`/`opencode.ai`/`codex exec`/`/tmp/mg-e0`）只作为**第二道闸**扫描清单内文件，命中即拒绝启动；它拦不住字符串拼接、大小写或编码绕过，**不是安全边界，白名单才是**。临时运行清单外单个文件必须 `--only <file>` 且同时设置 `MG_ALLOW_LIVE_TESTS=1` 与 `MG_LIVE_ALLOW_UNLISTED=1`，启动会打印醒目警告、摘要标注 `UNLISTED_OVERRIDE`，不可能静默。`node scripts/test/live.mjs --list` 输出 `allowlisted / present-but-not-allowed / missing-from-disk` 三栏及原因；`--scan-only` 只静态检查、不启动套件。

旧套件已全部隔离（MG-004）：配置读写经加密 Key 与临时目录，上游为本地 mock，默认 `npm test` 与旧套件互不影响。`user-env-fallback` 的 Windows 分支在 Linux 上打印 `N/A`（不计通过）。仍不要为了让测试通过而关闭日常网关鉴权。

配置事务与恢复的回归在 `scripts/test/offline/config-transaction.test.mjs`：覆盖 journal/commit marker 的 9 个故障注入点（子进程 `process.exit`/SIGKILL）、重启恢复一致代际、外部修改 fail-closed、跨进程锁竞争、0600 权限、日志脱敏与网关级「失败不发布内存/不降低鉴权」。故障注入只通过 `MG_TXN_FAULT` 传给显式子进程（默认 runner 白名单不会透传该变量）。

`scripts/test/offline/runner-selftest.test.mjs` 会在 `scripts/test/offline/` 短暂写入哨兵 `.test.mjs`（正常路径自删；进程被 SIGKILL 时可能残留，已加入 `.gitignore`）。残留不会被自动执行：默认运行器是显式清单 `SUITES`，清单外文件不参与。live 白名单反例（拼接/大小写/base64）全部在临时副本目录中构造，不会写进仓库。

若测试失败，保留命令、错误、Node 版本和相关 diff，先排除端口占用，再判断行为回归。退出、SKIP 和超时均不得写成成功。
