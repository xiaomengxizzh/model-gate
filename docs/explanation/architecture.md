# 架构与设计边界

单个 Node HTTP 进程同时承担控制面与数据面。src/index.js 处理 HTTP 入口、门禁、配置操作、统计与后台任务；src/forward.js 负责模型治理、候选链、请求整形及 fallback。前者将有限依赖传给后者，尚不是可独立替换的完整服务层。

数据流为：客户端 → index 鉴权与收集 body → router 解析入口 → forward 按目标模型生成路由请求 → request 执行网络重试 → JSON 或 sse 输出。format 提供协议适配，logger 输出掩码日志。admin.html 调用同进程 /api 接口，不单独构建。

配置加载在主模板上合并本地覆盖；provider/models 按键合并，defaults 顶层合并，virtualModels 整体替换。配置保存有进程内写锁和可选版本检查，但不构成跨进程事务。模型删除、配置 schema 与严格验证仍需专项设计。

Key 库使用 AES-GCM；stats 周期性落盘。加密解决静态存储，不替代进程权限、主密钥备份或日志脱敏。重试、目录轮转、SSE 重连及各级超时并存，尚无统一的跨排队/流式生命周期 deadline；这也是下一阶段优先收敛的契约。

当前协议桥以 OpenAI Chat 为入口；非 OpenAI tools 流可能先降级再封装。为保持已有客户端行为，本轮没有把未来 Embedding/媒体能力塞入现有 Chat 分支。先完成安全、资源边界及协议保真测试，再按开发计划扩展能力入口。
