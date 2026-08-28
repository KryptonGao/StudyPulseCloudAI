# StudyPulse Cloud AI 错误码表

本文档记录当前 API 对外返回的主要错误码、HTTP 状态码和响应格式。

## 1. 通用响应格式

### 旧版/公开 API

`/v1/chat`、`/user/profile` 以及旧版 `/auth/*` 接口通常返回：

```json
{
  "error": "错误信息"
}
```

### 新版认证 API

`/v1/auth/*` 接口的业务错误通常返回：

```json
{
  "success": false,
  "error": {
    "code": "错误码",
    "message": "错误说明"
  }
}
```

## 2. 鉴权与账号状态

| HTTP | 错误码/`error` | 返回说明 | 触发条件 |
|---:|---|---|---|
| 401 | `Missing API Key or Session Token` | 未携带鉴权信息 | 请求没有 `Authorization` 或 `X-API-Key` |
| 401 | `Missing API Key` | 缺少 API Key | 直接调用旧版 API Key 鉴权函数时未携带 `Authorization` |
| 401 | `Invalid or expired session` | Session 无效或过期 | `Authorization: Bearer sp_sess_...` 校验失败 |
| 401 | `UNAUTHORIZED` | 请先登录 | Session-only 接口未提供有效 Session |
| 401 | `SESSION_EXPIRED` | 登录状态已失效，请重新登录 | Session-only 接口使用了失效 Session |
| 403 | `Invalid API Key` | API Key 无效 | Key 格式错误，或数据库中不存在对应 Key |
| 403 | `API Key disabled` | API Key 已禁用 | 管理员已禁用该 Key |
| 403 | `API Key expired` | API Key 已过期 | Key 已超过 `expires_at` |
| 403 | `FORBIDDEN` | 该接口仅支持 Session Token | 账号管理接口使用了 API Key |
| 403 | `Account banned` | 账号已被封禁 | 已通过鉴权，但用户状态为 `banned` |
| 403 | `ACCOUNT_BANNED` | 账号已被暂停，请通过申诉链接提交申诉 | 密码登录时账号状态为 `banned` |
| 403 | `账号已被暂停` | 账号已被暂停 | Support 接口登录或提交工单时账号状态为 `banned` |
| 403 | `Email is banned` | 邮箱已被封禁 | 邮箱登录/注册时命中黑名单 |

### 账号被封禁的典型响应

公开业务接口，例如 `/v1/chat`：

```http
HTTP/1.1 403 Forbidden
```

```json
{
  "error": "Account banned"
}
```

密码登录接口 `/v1/auth/login`：

```json
{
  "success": false,
  "error": {
    "code": "ACCOUNT_BANNED",
    "message": "账号已被暂停，请通过申诉链接提交申诉"
  }
}
```

## 3. 请求、认证和密码错误

| HTTP | 错误码/`error` | 返回说明 |
|---:|---|---|
| 400 | `Invalid JSON Body` | 请求体不是合法 JSON |
| 400 | `INVALID_REQUEST` | 请求参数缺失或类型错误 |
| 400 | `INVALID_EMAIL` | 邮箱地址格式无效 |
| 400 | `WEAK_PASSWORD` | 密码不符合安全要求 |
| 400 | `INVALID_VERIFICATION_CODE` | 验证码无效 |
| 400 | `VERIFICATION_CODE_EXPIRED` | 验证码已过期 |
| 401 | `INVALID_CREDENTIALS` | 邮箱不存在、密码错误、未设置密码或账号锁定 |
| 409 | `EMAIL_ALREADY_REGISTERED` | 邮箱已经注册 |
| 409 | `PASSWORD_UNCHANGED` | 新密码与旧密码相同 |
| 429 | `RATE_LIMITED` | 登录、验证码发送或验证码尝试频率超限 |

## 4. 配额和上游服务

| HTTP | 错误码/`error` | 返回说明 |
|---:|---|---|
| 403 | `Model "xxx" is not available on your plan` | 当前会员计划不支持所选模型 |
| 403 | `API Key not bound to a user` | API Key 未绑定用户 |
| 403 | `Account banned` | 绑定用户已被封禁 |
| 429 | `API quota exceeded` | API Key 配额已用尽 |
| 429 | `Daily request limit exceeded` | 会员每日请求次数已用尽 |
| 429 | `Monthly point limit exceeded` | 会员月 AI Points 配额已用尽 |
| 500 | `Server not configured: MINIMAX_API_KEY missing` | 服务端未配置上游 AI Key |
| 502 | `AI request failed` | 上游 MiniMax 请求失败 |

## 5. 其他

| HTTP | 错误码/`error` | 返回说明 |
|---:|---|---|
| 404 | `Not Found` | 请求了未定义的路径 |
| 404 | `User not found` | 用户不存在 |

## 6. 客户端处理建议

- 收到 `401`：清除本地 Session，并引导用户重新登录。
- 收到 `403` 且为 `ACCOUNT_BANNED` 或 `Account banned`：展示账号暂停状态和申诉入口。
- 收到 `403` 且为 API Key 错误：提示检查 Key、禁用状态和有效期。
- 收到 `429`：根据错误信息展示配额或频率限制提示，不要立即无限重试。
