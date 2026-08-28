# StudyPulse Cloud AI — API Documentation

**Version:** `0.9-beta`
**Runtime:** Cloudflare Workers
**AI Gateway:** Router → Provider Adapter (MiMo / HY3 / MiniMax-M3)
**Last Updated:** 2026-08-28

---

## 1. 概述

StudyPulse Cloud AI 是 StudyPulse 的 AI 后端网关，支持两种调用方式：

- **App 用户**：通过邮箱验证码登录获取 Session Token 调用 AI
- **Beta/开发者用户**：通过 API Key 调用 AI

两套体系最终统一关联到 `user_id`，共享会员权限和额度检查。

**架构:**

```
iOS App / Web 控制台 / 第三方客户端
    │  HTTPS
    ├─ Authorization: Bearer sp_sess_xxx  (Session Token)
    │  或
    ├─ X-API-Key: sp_beta_xxx            (API Key, 推荐)
    │  或
    └─ Authorization: Bearer sp_beta_xxx  (API Key, 兼容旧版)
    ▼
Cloudflare Worker（按子域名分流）
    ├─ spapi.chenkai.space              → 公开 AI / 认证 API
    ├─ auth.chenkai.space               → 统一登录中心
    ├─ dash.studypulse.chenkai.space    → 用户控制台 WebUI + /api/user/*
    ├─ support.chenkai.space            → 申诉页 + 工单 API
    └─ admin.chenkai.space              → 管理后台
    │
    ▼
D1 (StudyPulseDB)
    ├─ users / sessions / api_keys / user_passkeys
    ├─ membership_plans / usage_records
    ├─ feedback_tickets / contribution_tickets
    ├─ bans / appeals
    └─ request_logs / admin_logs
    │
    │  Bearer / api-key (per provider)
    ▼
Provider Adapter  (MiMo / HY3 / MiniMax)  — client does not pick the upstream model
```

---

## 2. 基础信息

| 项 | 值 |
|---|---|
| 协议 | HTTPS |
| 字符集 | UTF-8 |
| 请求体 | `application/json` |
| 响应体 | `application/json` |
| 时间格式 | ISO 8601 (UTC) |
| 公开 API | `https://spapi.chenkai.space` |
| 统一登录 | `https://auth.chenkai.space` |
| 用户控制台 | `https://dash.studypulse.chenkai.space` |
| 申诉与工单 | `https://support.chenkai.space` |
| 管理后台 | `https://admin.chenkai.space` |
| 本地开发 | `http://localhost`（路径路由，所有模块可访问） |

---

## 3. 鉴权

### 3.1 App 用户鉴权（Session Token）

App 用户通过邮箱验证码登录获取 Session Token，使用 `Authorization: Bearer` 传递。

```
Authorization: Bearer sp_sess_<64位hex>
```

Session Token 有效期 30 天，支持多设备登录。

### 3.2 Beta/开发者鉴权（API Key）

API Key 通过 `X-API-Key` Header 传递（推荐），也兼容旧版 `Authorization: Bearer` 方式。

```
X-API-Key: sp_beta_<hex>
```

### 3.3 鉴权优先级

`/v1/chat` 接口的鉴权优先级：

1. `Authorization: Bearer sp_sess_xxx` → Session Token（App 用户）
2. `X-API-Key: sp_beta_xxx` → API Key（推荐方式）
3. `Authorization: Bearer sp_beta_xxx` → API Key（兼容旧版）

---

## 4. 用户认证接口

### 4.1 发送验证码

#### `POST /auth/email/send`

**请求体:**

```json
{
  "email": "user@example.com"
}
```

**成功响应 `200 OK`:**

```json
{
  "success": true
}
```

**错误响应:**

| HTTP | error | 说明 |
|---|---|---|
| 400 | `Invalid email format` | 邮箱格式不合法 |
| 429 | `Please wait before requesting a new code` | 1 分钟内重复发送 |
| 502 | `Email delivery failed` | 邮件发送失败 |

### 4.2 验证码登录

#### `POST /auth/email/verify`

**请求体:**

```json
{
  "email": "user@example.com",
  "code": "123456"
}
```

**成功响应 `200 OK`:**

```json
{
  "success": true,
  "data": {
    "token": "sp_sess_a81f92..."
  }
}
```

**错误响应:**

| HTTP | error | 说明 |
|---|---|---|
| 400 | `Invalid verification code` | 验证码错误 |
| 400 | `Verification code already used` | 验证码已使用 |
| 400 | `Verification code expired` | 验证码过期（10 分钟） |
| 429 | `Verification code locked due to too many attempts` | 5 次错误尝试后锁定 |

> 新用户首次登录自动创建账号（role=user, membership=free）。

### 4.3 密码认证 API（`/v1/auth/*`）

### 4.4 统一身份中心（`auth.chenkai.space`）

统一登录入口为 `https://auth.chenkai.space/login`，支持邮箱密码、邮箱验证码和 GitHub OAuth。新接口为：

- `POST /auth/login/password`：`{ email, password }`
- `POST /auth/send-code`：`{ email }`，验证码有效 10 分钟且服务端仅保存验证码哈希
- `POST /auth/login/code`：`{ email, code }`，邮箱不存在时自动创建用户
- `POST /auth/refresh`：`{ refresh_token }`，refresh token 单次轮换
- `GET /oauth/github/start?return_to=studypulse://auth/callback`
- `GET /oauth/github/callback`

三种登录方式返回同一 Session 结构：`access_token`、`refresh_token`、`expires_at`、`refresh_expires_at` 和 `user`。GitHub 账号按 verified email 关联既有 `users`，没有可用邮箱时返回 `github_email_required`；OAuth state 存在 HttpOnly/Secure cookie 中用于 CSRF 防护。

密码认证与邮箱验证码、Session、API Key 共用同一个 `users.id`，不会产生第二套会员、额度或使用记录体系。

密码策略为 10–128 个 Unicode 字符；允许空格、中文和特殊字符，但不能是空字符串或全空白。新密码使用 bcrypt（默认 cost `12`），D1 仅保存 bcrypt hash；历史 PBKDF2 凭据在成功登录后自动升级为 bcrypt。

#### `POST /v1/auth/email/send`

保留旧的 `POST /auth/email/send`。新客户端可以通过 `purpose` 请求注册验证码：

```json
{"email":"user@example.com","purpose":"register"}
```

`purpose` 支持 `register`、`login`、`reset_password`、`change_email`。

#### `POST /v1/auth/register/verify`

```json
{"email":"user@example.com","code":"123456","password":"用户设置的密码","device_name":"iPhone"}
```

成功返回：

```json
{"success":true,"data":{"session_token":"sp_sess_xxx","expires_at":"2026-08-25T00:00:00.000Z","user":{"id":"usr_xxx","email":"user@example.com"}}}
```

验证码只可使用一次；已存在密码凭证时返回 `409 EMAIL_ALREADY_REGISTERED`。

#### `POST /v1/auth/login`

```json
{"email":"user@example.com","password":"用户密码","device_name":"Gao Chenkai’s iPhone"}
```

邮箱不存在、未设置密码、密码错误和账号锁定统一返回 `401 INVALID_CREDENTIALS`：

```json
{"success":false,"error":{"code":"INVALID_CREDENTIALS","message":"邮箱或密码错误"}}
```

#### `POST /v1/auth/password/request-reset`

请求 `{"email":"user@example.com"}`。无论邮箱是否存在均返回：

```json
{"success":true,"message":"如果该邮箱已注册，我们已经发送验证码"}
```

#### `POST /v1/auth/password/reset`

请求 `{"email":"user@example.com","code":"123456","new_password":"新的密码"}`。成功后更新/创建密码凭证、撤销该用户全部旧 Session，并返回成功但不自动登录。API Key 不受影响。

#### `POST /v1/auth/password/change`

需要 `Authorization: Bearer sp_sess_xxx`，请求体为 `{"current_password":"旧密码","new_password":"新密码"}`。成功后撤销全部旧 Session，并返回新的 `session_token`；当前设备也必须改用新 Token。当前密码错误返回 `401 INVALID_CREDENTIALS`，新旧密码相同返回 `409 PASSWORD_UNCHANGED`。

#### `POST /v1/auth/logout` / `POST /v1/auth/logout-all`

两者都只接受 Session Token。前者撤销当前设备，后者撤销用户全部设备。成功响应为 `{"success":true,"data":{}}`。

#### `GET /v1/auth/me`

只接受 Session Token，返回用户基础信息和登录方式：

```json
{"success":true,"data":{"user":{"id":"usr_xxx","email":"user@example.com"},"login_methods":["email_code","password"],"auth_type":"session"}}
```

不会返回密码 hash/salt、验证码、完整 Session Token 或 API Key 明文。

#### `GET /user/profile`

支持 Session Token 或绑定用户的 API Key，返回当前用户的会员与计划信息（`spapi.chenkai.space`）。

**成功响应：**

```json
{
  "success": true,
  "data": {
    "email": "user@example.com",
    "role": "user",
    "membership": {
      "type": "free",
      "expires_at": null,
      "effective_type": "free"
    },
    "plan": {
      "name": "FREE",
      "daily_request_limit": 5,
      "monthly_point_limit": 5000,
      "available_models": ["MiniMax-M3"]
    }
  }
}
```

### 4.5 退出登录（兼容旧路径）

#### `POST /auth/logout`

需要携带 Session Token。

```
Authorization: Bearer sp_sess_xxx
```

**成功响应 `200 OK`:**

```json
{
  "success": true
}
```

---

## 5. 错误码总表

| HTTP | error 字段 | 触发条件 |
|---|---|---|
| `400` | `Invalid JSON Body` | POST 请求体非合法 JSON |
| `401` | `Missing API Key or Session Token` | 未携带任何鉴权信息 |
| `401` | `Invalid or expired session` | Session Token 无效或过期 |
| `403` | `Invalid API Key` | Key 格式错误 / D1 中无此哈希 |
| `403` | `API Key disabled` | Key 已被管理员禁用 |
| `403` | `API Key expired` | Key 已超过 `expires_at` 有效期 |
| `404` | `Not Found` | 请求了未定义的路径 |
| `429` | `API quota exceeded` | API Key 额度用尽 |
| `429` | `Daily request limit exceeded` | 会员每日请求数用尽 |
| `429` | `Monthly point limit exceeded` | 会员月 AI Points 额度用尽 |
| `500` | `Server not configured: no AI provider API keys` | 服务端三个上游 Key 均未配置 |
| `502` | `AI request failed` | 上游 Provider 调用失败 |
| `400` | `INVALID_EMAIL` / `WEAK_PASSWORD` / `INVALID_VERIFICATION_CODE` | 新认证接口参数或验证码错误 |
| `401` | `INVALID_CREDENTIALS` / `SESSION_EXPIRED` | 密码错误、未设置密码或 Session 已失效 |
| `403` | `FORBIDDEN` | 账号管理接口使用了 API Key |
| `409` | `EMAIL_ALREADY_REGISTERED` / `PASSWORD_UNCHANGED` | 重复注册或新旧密码相同 |
| `429` | `RATE_LIMITED` | 登录、验证码尝试或发送频率超限 |
| `403` | `Account banned` | 账号被封禁，无法调用 AI 或控制台 API |
| `403` | `仅 Pro 用户可以提交顶级工单` | 非 Pro 用户提交 `top` 优先级工单 |
| `409` | `您已有一条待审核贡献，请等待处理` | 贡献申请重复提交 |

---

## 6. AI 对话接口

### `POST /v1/chat`

支持 Session Token 和 API Key 两种鉴权方式。官方 Cloud 请求由服务端 Router 选模型；**忽略**客户端 `model` 字段。BYOK 客户端请直接调用自己的 OpenAI 兼容端点，不走本网关。

**请求头:**

| Header | 必填 | 说明 |
|---|---|---|
| `Authorization` | 二选一 | `Bearer sp_sess_xxx`（Session Token） |
| `X-API-Key` | 二选一 | `sp_beta_xxx`（API Key，推荐） |
| `Content-Type` | 是 | `application/json` |

**新客户端请求体（优先）:**

```json
{
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." }
  ],
  "stream": true,
  "studypulse": { "caller": "MistakeAI", "thinking": "auto" }
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `messages` | array | OpenAI 风格多轮消息（含 system / assistant） |
| `stream` | boolean | SSE 流式，默认 false |
| `studypulse.caller` | string | 功能场景。未知 caller 记日志并按 Legacy 默认策略（不 400） |
| `studypulse.thinking` | string | 仅 `off` / `auto` / `on`。非法值记日志并视为 `auto` |
| `model` | string | **忽略**，不再做套餐白名单 403 |

**旧客户端（迁移期）：** 无 `studypulse` → `caller=Legacy`, `thinking=auto`；仍接受 `message` 或 `content`。

**应用层限制：**整个请求体最多 256 KiB；单条消息文本最多 32,768 字符；`content` 数组最多 16 项；`messages` 最多 64 条。超出请求体限制返回 `413 Request body too large`，超出字段限制返回 `400`。当前代码**没有**独立的 max-token / context 安全上限。

**成功响应 `200 OK`:**

```json
{
  "success": true,
  "data": {
    "reply": "你好！有什么可以帮你的吗？"
  }
}
```

#### 流式响应 (`stream: true`)

响应为 SSE（`Content-Type: text/event-stream`），透传上游 chunk；网关 `tee()` 一份用于提取 usage 并写入账本。

**请求示例:**

```bash
# 新协议
curl -X POST https://spapi.chenkai.space/v1/chat \
  -H "Authorization: Bearer sp_sess_xxx" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"你好"}],"studypulse":{"caller":"LLMChat","thinking":"auto"}}'

# 旧客户端兼容
curl -X POST https://spapi.chenkai.space/v1/chat \
  -H "X-API-Key: sp_beta_xxx" \
  -H "Content-Type: application/json" \
  -d '{"message":"你好"}'
```

---

## 7. 会员与额度

App 用户和绑定用户的 API Key 共享统一的会员额度体系（**INTERNAL_TEST** 积分，非商业报价）：

| 会员等级 | 价格 / 月 | 每日请求数 | 月 AI Points |
|---|---|---|---|
| Free | ¥0 | 5 | 5,000 |
| Plus | ¥14.9 | 50 | 200,000 |
| Pro | ¥34.9 | 200 | 400,000 |

用户配额 = 日请求 `COUNT(*)` + 月 `SUM(points_charged)`。账本仍保存 token 供内部核算，用户 Dashboard / Profile **不返回** token、定价系数或 provider cost。`monthly_token_limit` 列保留但已 deprecated。历史 `usage_records` 的 `points_charged` 默认为 0，不做 Token 折算。

管理员（role=admin）调用 AI 不受额度限制。

旧版匿名 API Key（无 user_id 关联）继续使用 `api_keys` 表自身的 `request_limit` 控制。

---

## 8. 上游模型与路由

官方请求由 `routing_version: "2026-08-v1"` 决定模型。Fallback 最多一次：MiMo→HY3，HY3→M3，M3→HY3；仅 timeout / 5xx / unavailable。400/401/403/quota/abort 不 fallback。

| 稳定 ID | Provider | 上游 model | Endpoint | Auth |
|---|---|---|---|---|
| `mimo-v2.5` | MiMo | `mimo-v2.5-free` | `https://opencode.ai/zen/v1/chat/completions` | `Authorization: Bearer`（`MIMO_AUTH_STYLE=api-key` 可切回官方 Xiaomi header） |
| `hy3` | HY3 | `hy3-free` | `https://opencode.ai/zen/v1/chat/completions` | `Authorization: Bearer` |
| `minimax-m3` | MiniMax | `MiniMax-M3` | `https://api.minimaxi.com/v1/chat/completions` | `Authorization: Bearer` |

Secret：`MIMO_API_KEY` / `HY3_API_KEY` / `MINIMAX_API_KEY`（`wrangler secret put`，禁止本地 deploy）。缺某个 key 时该 provider unavailable，可走 fallback；三个都缺返回 500。

---

## 9. 用户控制台 API

**域名：** `https://dash.studypulse.chenkai.space`

所有接口均需 Session Token：

```
Authorization: Bearer sp_sess_<64位hex>
```

未登录或 Token 失效返回 `401`；账号被封禁返回 `403 Account banned`。

### 9.1 获取控制台概览

#### `GET /api/user/dashboard`

返回当前用户的账号信息、会员状态、用量统计和最近调用记录。

**成功响应 `200 OK`：**

```json
{
  "success": true,
  "data": {
    "user": {
      "id": "usr_xxx",
      "email": "user@example.com",
      "username": null,
      "avatar": null,
      "created_at": "2026-01-01T00:00:00.000Z",
      "status": "active",
      "email_verified": true
    },
    "subscription": {
      "plan": "FREE",
      "type": "free",
      "effective_type": "free",
      "status": "active",
      "expire_time": null,
      "auto_renew": false,
      "daily_request_limit": 5,
      "monthly_point_limit": 5000
    },
    "usage": {
      "today": {
        "requests": 2,
        "points": 40
      },
      "month": {
        "requests": 15,
        "points": 620
      },
      "quota": {
        "day": { "requests": 2, "starts_at": "2026-08-27T00:00:00.000Z" },
        "month": { "points": 620, "starts_at": "2026-08-01T00:00:00.000Z" }
      },
      "trend": [
        { "day": "2026-08-14", "requests": 1, "points": 20 },
        { "day": "2026-08-15", "requests": 0, "points": 0 }
      ]
    },
    "recent_calls": [
      {
        "id": 123,
        "model": "hy3",
        "status": 200,
        "caller": "MistakeAI",
        "created_at": "2026-08-27T10:00:00.000Z"
      }
    ]
  }
}
```

**字段说明：**

| 字段 | 说明 |
|---|---|
| `subscription.effective_type` | 考虑过期后的实际会员等级 |
| `subscription.status` | 会员已过期但数据库仍保留原等级时为 `expired` |
| `usage.today` / `usage.month` | 自然日/自然月（Asia/Shanghai）内的实际用量 |
| `usage.quota` | 当前额度周期内的计数；会员过期降级后，`starts_at` 为过期时间，仅统计降级后的用量 |
| `usage.trend` | 最近 14 天每日用量，按上海时区日期聚合 |
| `recent_calls` | 最近 8 条 AI 调用记录（不含 Prompt/Reply 文本） |

### 9.2 退出登录

#### `POST /api/v1/auth/logout`

撤销当前 Session，成功返回 `{"success": true}`。

---

## 10. 代码贡献 API

**域名：** `https://dash.studypulse.chenkai.space`

用于开源贡献换会员的申请与查询。均需 Session Token。

### 10.1 查询贡献记录

#### `GET /api/user/contributions`

返回当前用户最近 30 条贡献工单。

**成功响应 `200 OK`：**

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "contribution_url": "https://github.com/org/repo/pull/1",
      "contribution_type": "pull_request",
      "description": "修复了某个 bug",
      "status": "pending",
      "awarded_membership": null,
      "membership_expires_at": null,
      "admin_reply": null,
      "created_at": "2026-08-27T00:00:00.000Z",
      "reviewed_at": null
    }
  ]
}
```

### 10.2 提交贡献申请

#### `POST /api/user/contributions`

**请求体：**

```json
{
  "contribution_url": "https://github.com/org/repo/pull/1",
  "contribution_type": "pull_request",
  "email": "user@example.com",
  "description": "可选说明，最多 2000 字"
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `contribution_url` | string | 是 | 有效的 `http://` 或 `https://` URL，最长 2048 字符 |
| `contribution_type` | string | 否 | `fork` / `issue` / `pull_request` / `other`，默认 `other` |
| `email` | string | 是 | 必须与当前登录账号邮箱一致 |
| `description` | string | 否 | 补充说明 |

**成功响应 `201 Created`：**

```json
{
  "success": true,
  "data": { "id": "uuid" }
}
```

**错误响应：**

| HTTP | error | 说明 |
|---|---|---|
| 400 | `请输入有效的贡献 URL` | URL 格式不合法 |
| 400 | `请输入有效的邮箱地址` | 邮箱格式不合法 |
| 400 | `邮箱必须与当前账号一致` | email 与账号不匹配 |
| 403 | `Account banned` | 账号被封禁 |
| 409 | `您已有一条待审核贡献，请等待处理` | 已有 pending 工单 |

---

## 11. 反馈工单 API

用户可通过控制台或支持中心提交反馈。两套路径共用同一后端逻辑，均需 Session Token。

| 入口 | 列表 | 创建 |
|---|---|---|
| 用户控制台 | `GET /api/user/feedback` | `POST /api/user/feedback` |
| 支持中心 | `GET /api/support/tickets` | `POST /api/support/tickets` |

### 11.1 查询工单列表

#### `GET /api/user/feedback` 或 `GET /api/support/tickets`

**成功响应 `200 OK`：**

```json
{
  "success": true,
  "data": {
    "user": {
      "email": "user@example.com",
      "membership_type": "free"
    },
    "tickets": [
      {
        "id": "uuid",
        "subject": "功能建议",
        "content": "希望增加……",
        "priority": "normal",
        "status": "pending",
        "admin_reply": null,
        "created_at": "2026-08-27T00:00:00.000Z",
        "processed_at": null
      }
    ]
  }
}
```

返回最近 50 条工单，按创建时间倒序。

### 11.2 创建工单

#### `POST /api/user/feedback` 或 `POST /api/support/tickets`

**请求体：**

```json
{
  "subject": "功能建议",
  "content": "详细描述",
  "priority": "normal"
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `subject` | string | 是 | 主题，最长 120 字符 |
| `content` | string | 是 | 内容，最长 5000 字符 |
| `priority` | string | 否 | `normal`（默认）/ `urgent` / `top`；`top` 仅 Pro 用户可用 |

**成功响应 `201 Created`：**

```json
{
  "success": true,
  "data": { "id": "uuid" }
}
```

**错误响应：**

| HTTP | error | 说明 |
|---|---|---|
| 400 | `请填写主题和反馈内容` | subject 或 content 为空 |
| 403 | `仅 Pro 用户可以提交顶级工单` | 非 Pro 用户使用了 `top` 优先级 |
| 403 | `账号已被暂停` | 账号被封禁 |

---

## 12. Passkey API

Passkey 基于 WebAuthn，RP ID 为 `chenkai.space`。生产环境允许的 Origin：

- `https://auth.chenkai.space`
- `https://dash.studypulse.chenkai.space`
- `https://spapi.chenkai.space`

以下路径在 `auth.chenkai.space`、`spapi.chenkai.space`、`dash.studypulse.chenkai.space` 均可访问（路径前缀不同，行为相同）：

| 用途 | auth / spapi 路径 | 控制台路径 |
|---|---|---|
| 登录选项 | `POST /auth/passkey/login/options` | — |
| 登录验证 | `POST /auth/passkey/login/verify` | — |
| 注册选项 | `POST /auth/passkey/register/options` | `POST /api/user/passkeys/register/options` |
| 注册验证 | `POST /auth/passkey/register/verify` | `POST /api/user/passkeys/register/verify` |
| 列表 | `GET /auth/passkey` | `GET /api/user/passkeys` |
| 删除 | `DELETE /auth/passkey/{credentialId}` | `DELETE /api/user/passkeys/{credentialId}` |

`/v1/auth/passkey/*` 与 `/auth/passkey/*` 等价。

### 12.1 Passkey 登录（无需 Session）

#### `POST /auth/passkey/login/options`

**请求体：** `{}`（可为空）

**成功响应：**

```json
{
  "success": true,
  "data": {
    "challenge_token": "ch_xxx",
    "public_key": { }
  }
}
```

将 `public_key` 传给浏览器 `navigator.credentials.get()`，再将结果连同 `challenge_token` 提交到验证接口。

#### `POST /auth/passkey/login/verify`

**请求体：**

```json
{
  "challenge_token": "ch_xxx",
  "response": { }
}
```

`response` 为 WebAuthn `AuthenticationResponseJSON`。成功返回标准 Session 结构（`access_token`、`refresh_token`、`expires_at`、`user` 等）。

### 12.2 Passkey 注册与管理（需 Session）

注册流程：先调用 `register/options` 获取 `challenge_token` 和 `public_key`，完成 WebAuthn 注册后调用 `register/verify`。

**列表响应示例：**

```json
{
  "success": true,
  "data": {
    "passkeys": [
      {
        "id": "credential_id",
        "name": "MacBook",
        "device_type": "multiDevice",
        "backed_up": true,
        "created_at": "2026-08-27T00:00:00.000Z",
        "last_used_at": "2026-08-27T10:00:00.000Z"
      }
    ],
    "prompt_dismissed": false
  }
}
```

**常见错误码：**

| code | HTTP | 说明 |
|---|---|---|
| `INVALID_ORIGIN` | 403 | 当前页面 Origin 不在白名单 |
| `INVALID_PASSKEY` | 400/401 | WebAuthn 验证失败 |
| `PASSKEY_ALREADY_REGISTERED` | 409 | 凭证已绑定 |
| `AUTH_CHALLENGE_EXPIRED` | 401 | 挑战已过期（5 分钟）或已使用 |
| `RATE_LIMITED` | 429 | 请求过于频繁 |

---

## 13. 申诉 API

**域名：** `https://support.chenkai.space`（本地开发：`http://localhost`）

账号被封禁时，系统会向用户邮箱发送带 `token` 的申诉链接。申诉接口**无需登录**，通过 token 鉴权。

### 13.1 查询申诉状态

#### `GET /api/appeals?token={appeal_token}`

**成功响应 `200 OK`：**

```json
{
  "success": true,
  "data": {
    "email": "user@example.com",
    "reason": "违反服务条款",
    "status": null,
    "appeal_id": null
  }
}
```

| 字段 | 说明 |
|---|---|
| `status` | `null` 表示尚未提交；`pending` / `approved` / `rejected` 表示已提交 |
| `appeal_id` | 已提交时返回申诉记录 ID |

**错误响应：**

| HTTP | error | 说明 |
|---|---|---|
| 400 | `申诉链接无效：缺少 token` | 未传 token |
| 404 | `Appeal link is invalid or expired` | token 无效或封禁已解除 |

### 13.2 提交申诉

#### `POST /api/appeals`

**请求体：**

```json
{
  "token": "appeal_token_from_email",
  "content": "申诉说明"
}
```

**成功响应 `201 Created`：**

```json
{
  "success": true,
  "data": { "appeal_id": "uuid" }
}
```

---

## 14. 支持中心认证 API

**域名：** `https://support.chenkai.space`

支持中心提供独立的邮箱验证码登录，用于未从统一登录中心跳转的用户。

### 14.1 发送验证码

#### `POST /api/support/auth/send-code`

```json
{ "email": "user@example.com" }
```

成功返回 `{"success": true}`。1 分钟内重复发送返回 `429`。

### 14.2 验证码登录

#### `POST /api/support/auth/verify-code`

```json
{ "email": "user@example.com", "code": "123456" }
```

**成功响应：**

```json
{
  "success": true,
  "data": {
    "token": "sp_sess_xxx",
    "user": { "id": "usr_xxx", "email": "user@example.com" },
    "membership_type": "free"
  }
}
```

### 14.3 获取当前用户

#### `GET /api/support/me`

需 Session Token，返回用户 ID、邮箱和会员信息。

---

## 15. 管理后台 API 扩展

**域名：** `https://admin.chenkai.space`

以下接口在既有 `/api/admin/*` 体系上新增，均需管理员鉴权；`POST`/`PUT`/`DELETE` 还需 CSRF Token（`X-CSRF-Token` Header 与 Cookie 一致）。

### 15.1 封禁用户

#### `POST /api/admin/bans/create`

```json
{
  "user_id": "usr_xxx",
  "reason": "违反服务条款"
}
```

成功后会向用户邮箱发送含申诉链接的通知。

### 15.2 申诉管理

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/admin/appeals?status=pending` | 列出申诉（可选 status 过滤） |
| `POST` | `/api/admin/appeals/review` | 审核申诉 |

审核请求体：

```json
{
  "id": "appeal_uuid",
  "decision": "approved",
  "admin_reply": "可选回复"
}
```

`decision` 为 `approved` 或 `rejected`。

### 15.3 反馈工单管理

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/admin/tickets` | 待处理工单（默认） |
| `GET` | `/api/admin/tickets?archive=1` | 已处理工单（最近 200 条） |
| `GET` | `/api/admin/tickets?search=关键词` | 搜索主题/内容/邮箱 |
| `POST` | `/api/admin/tickets/process` | 处理工单 |

处理请求体：

```json
{
  "id": "ticket_uuid",
  "admin_reply": "处理说明"
}
```

### 15.4 代码贡献审核

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/admin/contributions?status=pending` | 列出贡献申请 |
| `POST` | `/api/admin/contributions/review` | 审核贡献 |

审核请求体：

```json
{
  "id": "contribution_uuid",
  "decision": "approved",
  "membership": "plus",
  "duration_days": 30,
  "admin_reply": "感谢贡献"
}
```

`decision` 为 `approved` 时 `membership` 必须为 `plus` 或 `pro`；`duration_days` 范围 1–3650，默认 30。

---

## 16. 安全说明

- **Session Token**：仅存 SHA-256 哈希，原始 Token 登录时返回一次
- **API Key**：仅存 SHA-256 哈希，创建时返回一次原始 Key
- **邮箱验证码**：6 位数字，10 分钟过期，最多 5 次错误尝试
- **不记录** Prompt/Reply 文本内容
- 上游 AI Key 通过 Cloudflare Secret 注入

---

## 17. 版本历史

| 版本 | 变更 |
|---|---|
| `0.1-beta` | 基础 API Gateway, `/v1/chat` 回显 |
| `0.2-beta` | 接入 MiniMax-M3, 多模态支持 |
| `0.3-beta` | D1 鉴权, SHA-256 哈希存储 |
| `0.4-beta` | 额度控制, 请求日志, Key 管理 |
| `0.5-beta` | SSE 流式传输, 过期校验, Token 配额 |
| `0.6-beta` | SaaS 用户体系（邮箱登录 + Session Token + 会员系统 + 双鉴权） |
| `0.7-beta` | 邮箱 + 密码登录、密码重置、Session 撤销和统一认证上下文 |
| `0.8-beta` | 用户控制台（用量/会员/趋势）、代码贡献、反馈工单、Passkey、账号申诉与支持中心 |

## 18. 配置、测试与发布

必需 Secret 保持不变：`MINIMAX_API_KEY`、`RESEND_API_KEY`；新增 `GITHUB_CLIENT_SECRET`，管理员仍使用 `ADMIN_API_TOKEN`。GitHub Client ID 可作为公开配置，GitHub Secret 必须通过 Cloudflare Secret 注入，不能写入客户端或仓库。可选配置：`GITHUB_CLIENT_ID`、`GITHUB_CALLBACK_URL`、`PASSWORD_BCRYPT_COST`（默认 12）、`PASSKEY_RP_ID`、`PASSKEY_ALLOWED_ORIGINS`。

本地测试：

```bash
npm install
npm test -- --run
```

D1 迁移由 GitHub 绑定的 Cloudflare 部署流程应用。不要在本地执行 `npx wrangler deploy`；完成代码后使用：

```bash
git add .
git commit -m "feat: add password authentication"
git push
```

示例：

```bash
# 密码登录
curl -X POST https://spapi.chenkai.space/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"user@example.com","password":"用户密码","device_name":"iPhone"}'

# 申请重置验证码（邮箱不存在时响应相同）
curl -X POST https://spapi.chenkai.space/v1/auth/password/request-reset \
  -H 'Content-Type: application/json' \
  -d '{"email":"user@example.com"}'

# 查看当前用户
curl https://spapi.chenkai.space/v1/auth/me \
  -H 'Authorization: Bearer sp_sess_xxx'

# 查看控制台概览
curl https://dash.studypulse.chenkai.space/api/user/dashboard \
  -H 'Authorization: Bearer sp_sess_xxx'

# 提交反馈工单
curl -X POST https://dash.studypulse.chenkai.space/api/user/feedback \
  -H 'Authorization: Bearer sp_sess_xxx' \
  -H 'Content-Type: application/json' \
  -d '{"subject":"功能建议","content":"希望增加导出功能","priority":"normal"}'

# 提交代码贡献申请
curl -X POST https://dash.studypulse.chenkai.space/api/user/contributions \
  -H 'Authorization: Bearer sp_sess_xxx' \
  -H 'Content-Type: application/json' \
  -d '{"contribution_url":"https://github.com/org/repo/pull/1","contribution_type":"pull_request","email":"user@example.com"}'
```
