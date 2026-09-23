# StudyPulse 登录与统一身份系统

## 1. 概述

StudyPulse 使用统一身份中心：

```text
https://auth.chenkai.space
```

支持以下登录方式：

1. 邮箱 + 密码
2. 邮箱验证码
3. GitHub OAuth
4. Google OAuth

这些方式最终都关联到同一个 `users` 用户，并使用统一的 Session 系统。

## 2. 用户与登录方式

### users

核心字段：

| 字段 | 说明 |
| --- | --- |
| `id` | 用户唯一 ID |
| `email` | 用户邮箱 |
| `password_hash` | bcrypt 密码哈希，可为空 |
| `created_at` | 创建时间 |
| `updated_at` | 更新时间 |

密码明文不会保存。历史 PBKDF2 凭据会在成功登录后升级为 bcrypt。

### user_oauth_accounts

OAuth 账户独立保存：

| 字段 | 说明 |
| --- | --- |
| `user_id` | 关联的 StudyPulse 用户 |
| `provider` | `github` 或 `google` |
| `provider_user_id` | GitHub 用户 ID 或 Google `sub` |
| `provider_email` | 提供方返回的已验证邮箱 |
| `username` | 提供方用户名或显示名称 |
| `avatar_url` | 提供方头像 |

一个用户可以绑定多个 OAuth 账户。

## 3. 邮箱密码登录

### 请求

```http
POST /auth/login/password
Content-Type: application/json
```

```json
{
  "email": "user@example.com",
  "password": "your-password",
  "device_name": "iPhone"
}
```

兼容旧接口：

```http
POST /v1/auth/login
```

### 密码规则

- 10–128 个 Unicode 字符
- 不能为空或全部为空白
- 服务端使用 bcrypt hash
- 数据库只保存 hash，不保存明文密码

## 4. 邮箱验证码登录

### 发送验证码

```http
POST /auth/send-code
Content-Type: application/json
```

```json
{
  "email": "user@example.com"
}
```

规则：

- 6 位数字验证码
- 有效期 10 分钟
- 数据库保存 SHA-256 hash
- 同一邮箱发送有频率限制
- 验证失败超过限制后验证码失效

### 验证并登录

```http
POST /auth/login/code
Content-Type: application/json
```

```json
{
  "email": "user@example.com",
  "code": "123456",
  "device_name": "iPhone"
}
```

邮箱不存在时，系统会自动创建一个新的 `users` 用户。

## 5. GitHub OAuth 登录

### 启动 OAuth

```http
GET https://auth.chenkai.space/oauth/github/start?return_to=studypulse://auth/callback
```

流程：

```text
App
  ↓
ASWebAuthenticationSession
  ↓
auth.chenkai.space/oauth/github/start
  ↓
GitHub 授权
  ↓
auth.chenkai.space/oauth/github/callback
  ↓
studypulse://auth/callback
```

OAuth 请求使用随机 `state`，并通过 Secure、HttpOnly、SameSite cookie 保存，用于防止 CSRF。

### GitHub 邮箱关联规则

1. 获取 GitHub verified email
2. 使用邮箱查询 `users.email`
3. 如果用户存在，绑定到现有用户
4. 如果用户不存在，创建用户并绑定 GitHub
5. 如果 GitHub 无法提供 verified email，返回 `github_email_required`

系统不会因为同一个邮箱再次使用 GitHub 登录而创建重复用户。

### OAuth 回调成功结果

```text
studypulse://auth/callback?access_token=...&refresh_token=...
```

客户端应立即读取 token，并保存到 Keychain。

## 6. Google OAuth 登录

### 启动 OAuth

```http
GET https://auth.chenkai.space/oauth/google/start?return_to=studypulse://auth/callback
```

Google 登录使用服务端授权码流程，只请求 `openid email profile`。Worker 通过 `state` cookie 防止 CSRF，并用 `nonce` 验证 ID Token；验证签名、issuer、audience 和有效期后，使用 Google `sub` 作为稳定提供方 ID。只有 `email_verified` 为真时，才允许用邮箱关联已有的 StudyPulse 用户；首次登录会创建普通免费用户。成功后签发 StudyPulse Session，不保存 Google Access Token 或 Refresh Token。

生产回调地址：

```text
https://auth.chenkai.space/oauth/google/callback
```

本地开发回调地址：

```text
http://localhost:8787/oauth/google/callback
```

Google Client Secret 只放在 Cloudflare Secret 或本地 `.dev.vars` 中，不写入仓库。客户端 token 仍按统一格式返回至 `return_to`。

## 7. 统一 Session

登录成功返回：

```json
{
  "success": true,
  "data": {
    "access_token": "sp_sess_...",
    "refresh_token": "sp_refresh_...",
    "expires_at": "2026-08-25T00:00:00.000Z",
    "refresh_expires_at": "2026-10-24T00:00:00.000Z",
    "user": {
      "id": "user-id",
      "email": "user@example.com"
    }
  }
}
```

API 请求使用：

```http
Authorization: Bearer sp_sess_...
```

Session 数据库只保存 access token 和 refresh token 的 hash。

### 刷新 token

```http
POST /auth/refresh
Content-Type: application/json
```

```json
{
  "refresh_token": "sp_refresh_..."
}
```

refresh token 为单次使用。刷新成功后旧 refresh token 立即失效，并返回一组新的 token。

## 8. iOS 接入

App 不再内置密码页面，改用：

```swift
ASWebAuthenticationSession(
    url: URL(string: "https://auth.chenkai.space/login?return_to=studypulse://auth/callback")!,
    callbackURLScheme: "studypulse"
)
```

App 需要：

1. 配置 URL Scheme：`studypulse`
2. 接收 `studypulse://auth/callback`
3. 解析 `access_token` 和 `refresh_token`
4. 保存到 Keychain
5. API 请求使用 access token
6. 收到 401 时使用 refresh token 刷新
7. 刷新失败后要求用户重新登录

禁止将 token 保存到 `UserDefaults`。

## 9. Cloudflare 配置

GitHub Client ID 可以公开配置；GitHub Secret 必须使用 Cloudflare Secret：

```bash
wrangler secret put GITHUB_CLIENT_SECRET
```

可选配置：

```text
GITHUB_CLIENT_ID
GITHUB_CALLBACK_URL
GOOGLE_CLIENT_ID
GOOGLE_CALLBACK_URL
PASSWORD_BCRYPT_COST
```

默认回调地址：

```text
https://auth.chenkai.space/oauth/github/callback
```

Google OAuth 回调地址为 `https://auth.chenkai.space/oauth/google/callback`。`GOOGLE_CLIENT_SECRET` 必须通过 Cloudflare Secret 配置；`GOOGLE_CLIENT_ID` 可作为 Worker 环境变量配置。

完成代码修改后，使用 `git commit` 和 `git push`，由 GitHub 集成触发部署。禁止本地执行 `wrangler deploy`。

## 10. 相关接口

| 接口 | 用途 |
| --- | --- |
| `GET /login` | Web 登录页面 |
| `POST /auth/login/password` | 邮箱密码登录 |
| `POST /auth/send-code` | 发送验证码 |
| `POST /auth/login/code` | 验证码登录 |
| `POST /auth/refresh` | 刷新 Session |
| `GET /oauth/github/start` | 启动 GitHub OAuth |
| `GET /oauth/github/callback` | GitHub OAuth 回调 |
| `GET /oauth/google/start` | 启动 Google OAuth |
| `GET /oauth/google/callback` | Google OAuth 回调 |
| `POST /v1/auth/logout` | 退出当前 Session |
| `POST /v1/auth/logout-all` | 退出所有 Session |
| `GET /v1/auth/me` | 获取当前用户 |
