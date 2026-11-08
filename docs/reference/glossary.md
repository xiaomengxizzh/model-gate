# 术语表

| 术语 | 本项目含义 |
| --- | --- |
| provider / 上游 | 连接地址、凭据来源和协议配置，不等于具体模型 |
| 真实模型 | models 中登记的路由项，支持 providerModels 映射到厂商名称 |
| 虚拟共用名 | defaults.model，沿 defaults.directory 决策 |
| 虚拟模型 | virtualModels 独立入口，有自己的 directory 和可选 Key/额度 |
| directory | 跨模型候选链；不同于单模型 fallbacks 上游链 |
| affinity / 亲和 | 记录成功上游并参与候选排序；不是缓存响应内容 |
| 续传 | SSE 中断后重发上下文并做内容去重；不保证厂商原生断点语义 |
| probe / 探测 | 真实最小请求，用于可达性/模型可调用性判断，会占用厂商资源 |
| quota | 完成后累积的软额度；不预留并发请求预算 |
| MG_CONFIG_DIR | local、keys、stats 的隔离目录；日志和主模板仍需显式指定 |
