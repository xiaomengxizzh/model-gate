E4/M2 LIVE 证据：官方主代理 → 第三方子代理（2026-11-11）
=======================================================

环境：真实 Codex CLI 0.167（--enable multi_agent_v2）→ ModelGate → 真实 chatgpt.com 官方主代理；
子代理指定模型 mg-opencodego-deepseek-v4-1-flash（真实 OpenCode Go）。隔离 CODEX_HOME（官方登录副本，测后 shred）。
复现：node scripts/test/codex-v2-live.mjs（事件原文 /tmp/mg-e0/v2-events.jsonl）

## 实际发生（原文摘录，已截断）

```text
1) 主代理确实发起 spawn：
   item: {type:"agent_message", text:"I’ll spawn the requested agent and wait for its reply."}
   item: {type:"collab_tool_call", tool:"wait", receiver_thread_ids:[], status:"completed"}

2) 第三方子代理的请求带有加密 agent_message，网关按 D3 显式阻断：
   Agent errored: {"error":{"message":"v2 子代理任务不可读：请求含加密的 agent_message
   （encrypted_content/encrypted_task_id）。网关不解析、不删除、不伪造密文，Chat 桥无法保证任务可读；
   请改用官方原生 Responses 上游，或取得授权后以明文重新委派。",
   "type":"v2_encrypted_task_unsupported"}}

3) 主代理完成轮次并把错误如实回显（turn.completed, output 182 tokens）
```

## 结论

- M2 在 v2 加密任务下被显式阻断，不是静默失败、不是伪造成功、也不降级到 v1。
  这与计划 §2.2（D1×D3：同一 Provider 身份不保证 v2 加密任务可读）完全一致，属于设计内结果。
- 可复用的确定事实：spawn_agent 的 model 覆盖确实生效（子代理被派到第三方聚合 slug），
  因此阻断点唯一且清晰——加密任务内容，而非路由/身份/模型解析。
- 后续若要打通 M2，只有两条被允许的路径（均需单独授权与设计）：
  1) 明文重新委派：由主代理在生成任务时使用可读文本（需要客户端支持或网关侧受控改写，当前不做）；
  2) 子代理也走原生 Responses 且上游能理解密文（当前第三方 Chat 上游不具备）。

## NOT_RUN / 边界

- 真实 v2 子代理成功闭环：NOT_RUN（被加密边界阻断，符合 D3）。
- 官方主代理向官方子代理 spawn：未测（不属于本阶段目标）。
- Desktop 端 v2：NOT_RUN。
