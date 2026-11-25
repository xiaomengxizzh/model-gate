# ADR-0014｜资源层扩展既有配置真源，统一预算与 Harness 边界

- 日期：2026-11-24
- 状态：Accepted for fixture-verified implementation；真实场景未签收，多租户已按隔离 fixture 接入。

## 背景

V13.1 需要服务、连接、模型、池、应用引用、策略、备份与多 Harness。现有 ModelGate 已有 provider/model/virtualModels、配置事务、路由与 Codex 适配；另建资源存储会分裂真源。现有 retry/forward/Codex 决策又各自有限制，需要统一单请求账本防止倍增。

## 决策

1. **单配置真源**：Service/Connection 扩展 providers；Model 扩展 models；Pool 扩展 virtualModels；Policy/HarnessBinding 作为同事务顶层映射。所有资源预览返回完整目标映射，由 `saveConfig` → `config-transaction` 提交。
2. **稳定 ID**：新资源使用 `svc_`/`conn_`/`mdl_`/`pool_`/`bind_`；旧 name/providerId 保留兼容投影。名称可改，引用不跟随名称。
3. **凭据独立**：Connection 只存 credentialKeyId；Key 经 `/api/keys` 加密。删除连接/服务可选择同事务删 Key；备份默认排除秘密。
4. **预算唯一执行者**：RequestLedger 在真实发送前批准、发送时计数、终态记录；内层执行器不自行放大重试。正常长生成无整体硬 deadline，故障/恢复/等待有界。
5. **安全重放**：HTTP 状态不单独证明未执行；只有 unsent、明确前置拒绝或可信原生续传可恢复。工具副作用、未知提交、已交付流、非幂等请求默认封锁。
6. **池目录能力取交集**：上下文用候选最小正值；工具能力只有全部成员有证据才声明，否则保守禁用。不得继承官方模板的未经证实能力。
7. **Codex 角色目标**：official 不走第三方池；route 父子同目标且零 GPT；aggregated 官方父 + 第三方子。目标进入当前目录后才可预览应用，consent 绑定目标并持久化 state。
8. **Harness 独立写入**：Claude Code/OpenCode/DSH 各自序列化；默认只检测，显式隔离 root 才写；xmxz 无证据不宣称支持。配置事务通过不等于真实协议通过。
9. **诚实状态**：configured/detected/desired-only/fixture-verified/PASS_REAL 分离；真实费用/GUI/账户权限未测保持 BLOCKED。
10. **在途影响可见**：Chat 链在解析模型后登记，直接 forward 路径按 provider/model 登记，流结束/关闭/错误释放；删除预览与确认均复核，在途资源 422，已发送请求保持固定代际。

## 后果

- 保留既有路由、事务、Codex 投资；资源 API 是薄编排，不是平行网关。
- 预览/confirm/requestId 回执持久化到作用域目录；token 仅存 SHA-256，重启未知态禁止重跑，只有未开始步骤可取消。预览计划不保存明文 Key，既有 Header/代理秘密以掩码引用当前配置。
- 单实例多租户由可信 `resolveActor` 注入身份，按 scope 懒加载独立配置/Key/统计/日志/usage 运行时；根配置不存租户资源，普通 role 不能写管理面，宿主 Codex/Harness 路径 fail-closed。
- 真实 HTTP(S) 出站每次建连前解析并固定 DNS，代理同样校验；多租户与新资源默认拒绝私网，旧单用户缺省配置保留本地兼容。

## 复审触发

若资源映射导致双写、需要改变既有客户端配置形状、引入新运行时依赖，或 Codex 官方协议要求不同角色 provider，先更新 ADR/合同并取得所有者授权。
