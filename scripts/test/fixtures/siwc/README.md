# SIWC 预览合成 OIDC mock（P07）

本目录的 `oidc-mock.mjs` 是**纯内存虚构服务**，只服务 [siwc-preview.test.mjs](../../offline/siwc-preview.test.mjs)。
它不监听端口、不联网、不写文件、不读取 `auth.json`/真实 HOME/真实会话；端点与 scope 均为合成合同标签，
不代表任何真实 OpenAI 账户、工作区、客户端资格或端点。

## 固定合同

| 端点 | 行为 |
| --- | --- |
| `https://issuer.synthetic.example/authorize` | 只生成授权码；校验 state/nonce/PKCE challenge 的存在与必需 scope |
| `https://issuer.synthetic.example/token` | `authorization_code`（PKCE S256 校验、单次使用）与 `refresh_token`（轮换、旧 token 失效） |
| `https://issuer.synthetic.example/revoke` | 标记/删除 refresh token；可模拟网络失败 |

ID token 为 HS256 合成 JWT，`verifyIdToken` 用同一测试 secret 验签；仅用于证明 claim 校验路径，
不是真实 OIDC 安全实现。`tokenAudience`、`idTokenExpOffset`、`grantScopes`、`*NetworkDown` 等选项用于负例。

## 边界

- 默认 off；没有满足条件的自有预览客户端就不暴露登录（见 `src/subscription/capabilities.js`）。
- 真实 OAuth / 真实账户 / 真实端点 / 资格：**UNKNOWN，NOT_RUN**。
- 真实网络调用必须由调用方注入 `fetchImpl`；`src/subscription/` 模块不含全局 `fetch`。
- 令牌只属于隔离测试；日志与状态必须脱敏。
