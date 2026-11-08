# 执行测试

在仓库根目录运行：

```bash
npm run check
npm test
npm run docs:check
```

`npm test` 串行启动白名单内的自包含测试：virtual-models、effort-normalize、upstream-side-4xx，以及 offline 下的 Node 测试。mock 不访问厂商服务；子进程显式使用测试主密钥。旧三套测试使用固定临时端口，因此同一 checkout 同时运行一次完整套件。新测试使用系统分配端口与 OS 临时目录。

筛选如 `npm test -- probe`。筛选未命中返回非零，不作为“通过”。

## 旧集成套件

`npm run test:live -- 关键词` 保留原有测试，运行前必须设置 `MG_ALLOW_LIVE_TESTS=1`、`MG_CONFIG_DIR` 和 `MG_GW`，其中 MG_GW 必须是回环地址且端口不能是 8787。MG_CONFIG_DIR 必须对应目标网关的可丢弃目录。这个门禁也用于直接调用旧测试文件。

旧测试可能覆盖配置、写入并清除 Key、调用配置中的上游；只准使用测试 Key 与本地 mock。部分用例尚未适配管理鉴权；未迁移项见 MG-004。默认离线测试不代表整套旧测试已验收，不要为了让旧测试通过而关闭日常网关鉴权。

若测试失败，保留命令、错误、Node 版本和相关 diff，先排除端口占用，再判断行为回归。退出、SKIP 和超时均不得写成成功。
