# 架构与设计边界

单个 Node HTTP 进程同时承担控制面与数据面。src/index.js 处理 HTTP 入口、门禁、配置操作、统计与后台任务；src/forward.js 负责模型治理、候选链、请求整形及 fallback。前者将有限依赖传给后者，尚不是可独立替换的完整服务层。

数据流为：客户端 → index 鉴权与收集 body → router 解析入口 → forward 按目标模型生成路由请求 → request 执行网络重试 → JSON 或 sse 输出。format 提供协议适配，logger 输出掩码日志。admin.html 调用同进程 /api 接口，不单独构建。

配置加载在主模板上合并本地覆盖；provider/models 按键合并，defaults 顶层合并，virtualModels 整体替换。配置保存有进程内写锁和可选版本检查，但不构成跨进程事务。模型删除、配置 schema 与严格验证仍需专项设计。

Key 库使用 AES-GCM；stats 周期性落盘。加密解决静态存储，不替代进程权限、主密钥备份或日志脱敏。MG-002 已把单次数据面请求收敛为单一 deadline + AbortSignal（src/budget.js）：排队/QPS 等待/代理 CONNECT/读 body/等响应头/非流式读体/SSE 中继与续传共享 `defaults.timeout.overallMs`（0=不限，旧行为），客户端断开经同一取消源从队列移除 waiter 并销毁上游连接；SSE 写客户端遵守背压（等待 drain，30s 或 8MiB 上限）。管理面请求与探测/预热/回切探活不在该预算内。契约见 `docs/contracts/request-lifecycle-v1.md`。

当前协议桥以 OpenAI Chat 为入口；非 OpenAI tools 流可能先降级再封装。为保持已有客户端行为，本轮没有把未来 Embedding/媒体能力塞入现有 Chat 分支。先完成安全、资源边界及协议保真测试，再按开发计划扩展能力入口。
