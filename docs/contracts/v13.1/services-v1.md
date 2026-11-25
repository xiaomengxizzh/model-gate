# mg-services/1｜稳定服务资源与影响预览（A3 切片）

状态：创建/编辑/删除/启停、按连接目录发现与多连接已实现；OAuth 授权仍未实现。所有写操作复用现有 `config-transaction.js` 与持久 Operation 回执，不建立第二配置真源。

## 1. 端点

| 方法 | 路径 | 语义 |
| --- | --- | --- |
| GET | `/api/services` | `{contract,configVersion,services[]}` |
| GET | `/api/services/:providerId` | `{contract,service}`；未知 404 |
| POST | `/api/config/preview` | `action=service.create/update/delete`；5 分钟一次性预览 |
| POST | `/api/services` | 用 previewId + confirmToken 创建 |
| PATCH | `/api/services/:providerId` | 用预览更新显示名/地址/协议/区域 |
| DELETE | `/api/services/:providerId` | 用预览删除；明确凭据 delete/retain |

安全与 `/api/status` 相同：Host/Origin + 回环/显式 allowRemote。响应不返回 Key、认证头、代理凭据、配置正文或文件路径。服务 ID 新格式 `svc_<base64url>`；旧 provider 投影为 `legacy:<providerId>`，providerId 保持路由兼容。

## 2. 预览请求

```ts
// 创建
{ action:'service.create', expectedVersion, requestId,
  patch:{displayName, endpoint, api:'openai'|'responses'|'anthropic'|'gemini'|'cohere', region?, allowPrivateNetwork?} }
// 更新
{ action:'service.update', expectedVersion, requestId, serviceId:providerId, patch:{...} }
// 删除
{ action:'service.delete', expectedVersion, requestId, serviceId:providerId,
  credentialAction:'delete'|'retain' }
```

响应：

```ts
{ ok:true, previewId, confirmToken, requestId, expiresAt, expectedVersion,
  action, serviceId, before, after,
  impact:{models,pools,codexBindings,aggregationProviders,credentialPresent},
  credentialAction }
```

`endpoint` 仅 http(s)，禁止 URL userinfo、fragment 和云元数据地址；本地/私有/保留/链路本地地址必须显式 `allowPrivateNetwork:true`。创建、修改端点或授权时异步解析全部 DNS 答案，DNS 失败、超时、空答案或任一受限地址均失败关闭；授权持久化在 provider 上，后续端点更新可继承。确认写入前再次解析 DNS，避免预览后重绑定直接落盘；发现请求每次重新解析。不做真实推理或发现。创建不自动入池。

## 3. 确认写入

```ts
{ expectedVersion, requestId, previewId, confirmToken }
```

- previewId/confirmToken 绑定 action、providerId、expectedVersion、requestId 和计划 hash；不匹配 409。
- 缺失/过期/已使用 428；确认 token 只返回一次，服务端仅存 SHA-256，不落 localStorage。
- `requestId` 回执在 `<配置目录>/resource-operations/<scope>/` 持久保留；同 body 重放返回首个回执，不同 body 409。重启后回执可重放；未提交操作标记 interrupted，已开始但结果未知的操作标记 unknown，均禁止自动重跑。
- 预览计划中的既有 Header/代理凭据只存掩码，确认时从当前配置代际恢复；明文 Key 不进入预览计划。
- 成功返回 `{ok:true,contract,requestId,service|null,configVersion,operation}`，不返回完整 status。
- 删除凭据 `delete` 时，Key 删除与 provider 删除在同一 keys/local 事务中提交；`retain` 明确保留加密 Key。

## 4. 引用保护

删除前检查模型、虚拟模型池、Codex 目录绑定、聚合 provider 引用和在途请求。任一非空返回 422 `service_referenced` 或 `service_in_flight` 与 `details`，不写入。当前不支持级联删除；用户先删除/迁移引用或在途请求完成。

在途请求使用已构建的配置代际，不受删除影响；预览与确认写入前都会读取有界在途登记，删除在途资源返回 422。登记只含 requestId/model/startedAt，不含正文或凭据；流在 end/close/error 时释放。

## 5. 错误

| HTTP | code | 行为 |
| --- | --- | --- |
| 400 | invalid_body/invalid_service/invalid_request_id/credential_action_required | 就地修正 |
| 403 | remote_forbidden/origin_denied | 只读并解释来源 |
| 404 | service_not_found | 刷新列表 |
| 409 | version_conflict/preview_binding_mismatch/idempotency_conflict/store_conflict | 保留现场，刷新后重新预览 |
| 422 | service_referenced | 展示引用，不写入 |
| 428 | confirmation_required/preview_expired | 重新预览 |
| 500 | transaction_failed/service_write_failed | 明确失败阶段，不假装成功 |

## 6. 验收与未实现

- 真实隔离 HTTP：创建/编辑/引用 422/删除/凭据同事务/幂等/403/404/畸形 ID/零上游，见 `scripts/test/offline/v13-services-http.test.mjs`。
- 真实 Chrome：弹窗预览→确认、Key 不落 localStorage、编辑、删除、Esc/焦点、3 尺寸 × 2 主题弹窗几何，见 `browser/a2-browser-report.json`。
- 未实现：OAuth 授权流程、按连接真实账户模型权限、真实上游额度/冷却。均保持规划，不标可用。
- 网络边界：服务预览/确认写入执行 DNS 私网复核；目录发现原生 Node HTTP(S) 请求把 socket lookup 固定到本次验证地址，拒绝重定向。测试注入的 `fetchImpl`/`requestImpl` 只能请求前复核，无法保证 socket lookup 固定，响应以 `networkPolicy:"dns-revalidated-unpinned"` 和 note 披露残余 DNS TOCTOU；生产默认路径为 `dns-revalidated-pinned`。
