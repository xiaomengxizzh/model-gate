# ADR-0001：Video 异步任务池的存储与生命周期（MG-014）

状态：已接受（2026-11-09）。范围：为 `capability=video` 的模型提供异步任务创建、状态轮询与取消；不涉及真实上游计费与对外发布（单独授权）。

## 背景

视频生成通常耗时数分钟到数十分钟，不能同步占住 HTTP 连接；需要任务 ID、状态查询、取消与重启恢复。仓库约束：Node 内置模块、零第三方依赖、单进程本地网关、配置目录可丢弃。

## 决策

1. **存储**：`<MG_CONFIG_DIR>/videos.json`，与 stats/keys 同目录，原子写（临时文件 + rename）。单进程独占；不引入 SQLite/外部 DB，避免 Node 版本与二进制依赖。跨进程并发不支持（网关本身单实例）。
2. **Node 版本**：保持 `>=18`；仅使用 `crypto.randomUUID`、`AbortSignal`、原子写等既有能力。
3. **状态机**：`queued → running → succeeded | failed | canceled`。终态不可再变（cancel 对终态幂等）。
4. **轮询**：客户端 `GET /v1/videos/:id` 惰性触发（每任务 ≥1.5s 最多一次）+ 后台 5s 扫描非终态任务；无 webhook、无外部调度。后台定时器 `unref()`，`close()` 时清理。
5. **上游协议**：只桥接 OpenAI 兼容上游（`api=openai`）；路径按模型配置：
   - `videoCreatePath`（默认 `/v1/videos`）
   - `videoStatusPath`（默认 `/v1/videos/{id}`）
   - `videoCancelPath`（默认 `/v1/videos/{id}/cancel`）
   上游返回里的任务 ID 依次取 `id/task_id/request_id`；状态字段取 `status/state`。
6. **幂等创建**：客户端 `Idempotency-Key` 头映射到任务；同 key 重复创建返回同一任务，不重复请求上游。无 key 时每次新建。
7. **保留与 GC**：终态任务保留 7 天；总量上限 500（超出按最旧终态优先淘汰）；非终态超过 24h 标记 `failed`（`expired`）。启动时与每小时执行一次 GC。
8. **错误与取消**：创建/轮询/取消复用 `forward()` 的 retry/timeout 与 `defaults.timeout.overallMs` 预算；客户端断开取消创建在途请求。上游失败记为任务 `failed`（保留 `error`），不以 5xx 直接丢任务。
9. **安全**：任务记录只保存上游 id、状态、结果 URL/JSON 摘要与模型/时间；不保存上游 Key；日志不记录 prompt 正文。
10. **探活**：video 不提供在线探测（会产生计费生成），`/api/model-test` 明确返回不支持。

## 后果

- 单实例/单配置目录是硬前提；多实例共享目录会互相覆盖。
- `videos.json` 会随任务增长，但受 500 条上限与 7 天保留约束。
- 上游状态语义差异（状态词、结果字段）由适配层归一；无法识别的状态保持 `running` 并在 24h 后过期。

## 未决

- 真实视频上游（Sora/Veo/Kling 等）的路径与结果格式需要单独适配与授权验证。
- 是否需要 webhook 回调、任务结果文件的本地缓存/转存，留待真实需求。
