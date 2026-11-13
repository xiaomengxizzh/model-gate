# ModelGate 原生 Codex 完整链路：进度与阻塞汇总（2026-11-13）

## 结论

ModelGate 已经承担了父官方 Responses 转发、Codex 模型目录和子代理到 OpenCode Go 的原生路由；子代理请求实际到达 Go，并用同一份投影后 body 直接回放得到完整 `response.completed`。**完整 A4/A5 仍未签收**：子 Codex 在长流式响应期间以 `ERR_STREAM_PREMATURE_CLOSE` 结束，尚未产出两个合成产物，也未完成同子追派。

CC Switch 只作为行为参照和抓包对象，不是本分支的运行依赖。

## 已打通

1. **父官方路径**
   - Codex `openai_base_url` 指向 ModelGate；ModelGate 的 `gatewaySubscription` 读取本机 Codex 登录态，只向 `chatgpt.com/backend-api/codex/responses` 转发父请求。
   - 父模型 `gpt-6-luna` 实际经 ModelGate 返回 agent message / usage。
2. **目录与别名**
   - `/v1/models?client_version=0.167.0` 返回 852 KB 的完整 Codex 目录。
   - 子模型 `mg-opencodego-deepseek-v4-1-flash` 可被 `spawn_agent` 选中，支持 `high` 推理档位。
3. **子代理原生路由**
   - 聚合 slug 解析保留原模型的 `api:"responses"` 和 `codex.plaintextTools/history`，不再退化成 Chat。
   - 原生第三方请求使用统一 header 构造，Go 所需的 `x-opencode-session` 已注入。
   - `access_programs`/`prompt_cache_key` 等官方专用控制项对第三方原生路由丢弃。
4. **密文投影策略**
   - 子模型显式 `plaintextTools:true` 且 `history.agentMessage:"project"` 时，`agent_message` 只保留可读 `input_text/text`，加密片段丢弃并记 lossy，不整条 400。
   - 无 `plaintextTools` 的第三方路由仍按原策略拒绝不可读密文。
5. **Go 上游确认**
   - 把 ModelGate 实际发出的 688 KB 子请求体原样回放到
     `https://opencode.ai/inference/go/v1/responses`：
     HTTP 200、完整 SSE、`response.completed`、1.79 MB 响应，usage
     `input 183091 / output 595 / reasoning 518`。
   - 因此 Go 接受该 body；断流不是 Go 侧拒绝协议或拒绝模型。

## 当前阻塞

`ERR_STREAM_PREMATURE_CLOSE` 出现在 ModelGate 转发子请求的 stream 阶段，尚未拿到终态。已观察到：

- 子 Codex 的 `NEW_TASK` payload 为空，因为 Codex V2 的 `spawn_agent.message` 是客户端密文；网关不能解密。
- 使用 `fork_turns=all` 可以让子代理继承父提示中的任务文本，但请求体约 725 KB、183K input，Go 生成时间较长。
- 使用 `fork_turns=none` + 合成 `AGENTS.md` 后，请求体仍约 688 KB（主要来自工具 schema/技能说明），上一轮 600 秒超时前未完成，子 Codex 侧持续出现 stream 提前关闭。
- 直接回放同一 body 能完成，说明下一步应比较 ModelGate/子 Codex 的 stream 超时与 Go 的首字节/总时长，而不是继续改路由或模型名。

## 本分支改动

| 文件 | 改动 |
| --- | --- |
| `src/codex/catalog.js` | 允许 `models.<name>.codex` 的运行时字段 `plaintextTools/history/namespace`，不写入目录 |
| `src/codex/interop.js` | 加密 `agent_message` 的可读部分投影，纯密文项丢弃；保留拒绝未知/非法正文 |
| `src/router.js` | 聚合 slug 保留原模型的 `api` 与 `codex` 投影策略 |
| `src/index.js` | 原生第三方 header 用统一构造（含 Go session）；密文门按 plaintextTools 放行；third-party soft restore |
| `src/responses.js` | 第三方原生路由丢弃 `access_programs`/`prompt_cache_key` |
| `src/responses-stream.js` | 终态/工具项恢复失败时，third-party 路由软回退；官方仍严格失败 |
| `scripts/test/offline/codex-*.test.mjs` | 同步新增投影、聚合策略与软恢复回归 |

## 验证

```text
npm run check                  PASS
npm test                       76/76 suites PASS, 771 tests PASS, 1 skipped
codex-p09-native-proxy         8/8 PASS
codex-routing-catalog          12/12 PASS
codex-v2-responses             29/29 PASS
codex-v2-stream                30/30 PASS
```

直接 Go 回放（本地证据，不入库）：

```text
POST https://opencode.ai/inference/go/v1/responses
HTTP 200, text/event-stream
response.created ... response.completed
bytes 1,791,138
usage input 183091 / output 595 / reasoning 518
```

## 下一步

1. 用同一份投影 body 测 Go 的 TTFB 与总时长，记录子 Codex 的 stream/wait 超时；确认是客户端超时还是 relay 关闭。
2. 若客户端超时：为自建 provider 设置 `stream_idle_timeout_ms`，或裁剪工具/技能/继承上下文，再做 A4。
3. 若 relay 关闭：修 `proxyNativeResponses` 的 upstream close 与 `res.close` 顺序，补齐单终态测试。
4. A4/A5：两个随机标记、独立哈希、同一子 ID 的 `followup_task`、父线程继续官方 GPT。
5. 之后再做 A6/A7 的 Go 故障与凭据隔离；Desktop 与 V1 `send_input` 仍单独签收。

## 环境恢复

- `~/.codex/config.toml` 已恢复：`f51a749c8f03d16377d4e1e51c76c6efa598af4451d0e7fe1f3bf060aecd4e62`
- CC Switch 未运行；15721/18081 未监听。
- 主工作树未改；本提交包含上述代码、测试和进度文档。
- 报告中不包含 token/API key/账号/邮箱或请求正文。
