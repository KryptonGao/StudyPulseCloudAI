# StudyPulse Cloud AI

Cloudflare Workers 驱动的 AI 后端网关与统一身份中心，为 StudyPulse iOS App 和 Web 用户提供 MiniMax-M3 多模态 AI 调用、账号认证、用量管理和用户支持服务。

**版本：** 0.7-beta
**许可证：** Apache 2.0

---

## 目录

- [功能特性](#功能特性)
- [v0.7-beta Release Notes](#v07-beta-release-notes)
- [架构](#架构)
- [目录结构](#目录结构)
- [快速开始](#快速开始)
- [部署指南](#部署指南)
- [公开 API](#公开-api)
- [管理后台](#管理后台)
- [数据库设计](#数据库设计)
- [API Key 管理](#api-key-管理)
- [安全模型](#安全模型)
- [测试](#测试)
- [技术栈](#技术栈)
- [版本历史](#版本历史)
- [后续规划](#后续规划)

---

## 功能特性

- **AI 网关** — iOS 客户端不直接持有第三方 AI Key，统一通过本服务代理调用
- **多模态支持** — MiniMax-M3 原生支持文本、图片（JPEG/PNG/GIF/WEBP）、视频（MP4/AVI/MOV/MKV）输入
- **流式响应 (SSE)** — 支持 `stream: true`，透传 MiniMax 流式输出，含用量提取和客户端断连检测
- **SaaS 用户体系** — 邮箱验证码登录（Resend），Session Token 管理（30 天有效期），用户注册/角色/会员
- **统一身份中心** — `auth.chenkai.space` 提供邮箱密码、邮箱验证码和 GitHub OAuth 登录，统一关联同一用户身份
- **安全会话管理** — Access Token + Refresh Token、Session 撤销、退出全部设备、设备信息记录和登录限流
- **密码认证** — 密码注册、修改、重置，bcrypt 哈希存储，兼容历史 PBKDF2 凭据并在成功登录后升级
- **双鉴权** — Session Token 与 API Key 共存，统一 `authenticateRequest()` 中间件，支持 `X-API-Key` header
- **会员计划** — 三级会员（free/plus/pro），按日请求次数和月 Token 用量控制额度，运行时过期降级
- **API Key 鉴权** — D1 数据库持久化，SHA-256 哈希存储，支持启用/禁用/过期/配额控制
- **请求额度控制** — 支持按次数（count）和按 Token（tokens）两种限额模式，仅在 AI 调用成功后计数
- **请求日志** — 记录每次请求的元数据（不存 prompt/reply 内容），支持按 Key/用户/状态/调用方式筛选
- **管理后台** — 内置 WebUI + RESTful API，支持 Key CRUD、用户管理、会员管理、封禁用户、管理员操作日志
- **域名隔离** — 公开 API 与管理后台绑定不同子域名（spapi.chenkai.space / admin.chenkai.space）
- **多层安全** — Cloudflare Access SSO、CSRF 保护、常量时间比较、参数化查询防注入
- **账号支持流程** — 封禁、邮件通知、在线申诉、反馈工单和管理员审核
- **代码贡献激励** — 用户提交 GitHub 贡献链接，管理员审核后发放 Plus/Pro 会员

---

## 架构

```
                         ┌──────────────────────────┐
                         │   StudyPulse iOS App      │
                         │   (Session / API Key)     │
                         └──────────┬───────────────┘
                                    │  HTTPS
                                    ▼
┌──────────────────────────────────────────────────────────────────┐
│                       Cloudflare Worker                           │
│                                                                  │
│  spapi.chenkai.space (公开 API)        admin.chenkai.space (管理)  │
│  auth.chenkai.space (统一登录)          dash.studypulse.chenkai.space (用户中心) │
│  ┌────────────────────────────────┐   ┌──────────────────────┐   │
│  │ GET  /              健康检查    │   │ GET  /admin   WebUI   │   │
│  │ POST /auth/*         统一登录   │   │ /api/admin/* 管理API  │   │
│  │ GET  /user/profile   用户信息   │   │ /api/admin/users/*    │   │
│  │ POST /v1/auth/*      会话管理   │   │ /api/admin/appeals/* │   │
│  │ POST /v1/chat        AI 对话    │   └──────────┬───────────┘   │
│  └─────────┬──────────────────────┘              │               │
│            │                                     │               │
└────────────┼─────────────────────────────────────┼───────────────┘
             │                                     │
             ▼                                     ▼
┌────────────────────────┐          ┌──────────────────────────────┐
│   Cloudflare D1         │          │  Cloudflare Access            │
│   (StudyPulseDB)        │          │  (管理员 SSO 认证)             │
│                         │          └──────────────────────────────┘
│  users                  │
│  sessions               │          ┌──────────────────────────────┐
│  api_keys               │          │  Resend Email API             │
│  membership_plans       │          │  (验证码邮件发送)               │
│  usage_records          │          └──────────────────────────────┘
│  request_logs           │
│  email_verification_codes│
│  admin_logs             │
│  blacklisted_emails     │
│  bans / appeals         │
│  feedback_tickets       │
│  contribution_tickets   │
└────────────────────────┘
             │
             │  Bearer ${MINIMAX_API_KEY}
             ▼
┌─────────────────────────────┐
│  MiniMax OpenAI-compatible   │
│  api.minimaxi.com            │
│  Model: MiniMax-M3           │
└─────────────────────────────┘
```

### 请求处理流程

```
POST /v1/chat
    │
    ├─ 1. 双鉴权（authenticateRequest）
    │      ├─ Session Token（sp_sess_ 前缀）→ validateSession → userId
    │      ├─ X-API-Key header             → authenticate → userId/apiKeyId
    │      └─ Authorization: Bearer        → authenticate → userId/apiKeyId
    ├─ 2. 校验至少一个 Provider API Key
    ├─ 3. 解析 Body（messages 优先；兼容 message / content）
    ├─ 4. Router（caller + thinking + vision）→ Adapter
    │
    ├─ 5. 额度检查（checkUserQuota）：日请求 COUNT(*) + 月 SUM(points_charged)
    ├─ 6. 流式 tee() / 非流式 JSON；最多一次 fallback
    └─ 7. 成功则 recordUsage（用户积分）+ request_logs（可含 token）
```

### 鉴权优先级

```
authenticateRequest() 短路求值：

  1. Authorization: Bearer sp_sess_xxx  → Session 鉴权（用户身份）
     └─ 失败 → 直接 401，不回退

  2. X-API-Key: sp_beta_xxx            → API Key 鉴权（推荐方式）
     └─ 成功 → userId (如果绑定用户) + apiKeyId

  3. Authorization: Bearer sp_beta_xxx  → API Key 鉴权（兼容旧版）
     └─ 成功 → userId (如果绑定用户) + apiKeyId

  4. 无任何鉴权信息 → 401
```

---

## 目录结构

```
studypulse-cloud-ai/
├── src/                              # Worker 源码
│   ├── index.js                      # 入口：域名路由 + 请求生命周期编排
│   ├── auth.js                       # API Key 鉴权（SHA-256 哈希 + D1 查询 + 额度校验）
│   ├── auth/
│   │   ├── email.js                  # 邮箱验证码（生成/发送/校验，Resend API）
│   │   ├── session.js                # Session 管理（创建/校验/销毁，30 天过期）
│   │   └── middleware.js             # 双鉴权中间件（Session + API Key 统一入口）
│   ├── providers/
│   │   └── minimax.js                # MiniMax-M3 AI Provider（非流式 + 流式 SSE）
│   ├── database/
│   │   ├── api_keys.js               # api_keys 表写操作（创建 Key/额度自增）
│   │   └── usage.js                  # usage_records 表写操作
│   ├── users/
│   │   └── users.js                  # 用户 CRUD（按 ID/邮箱查询、列表、角色/会员更新、统计）
│   ├── membership/
│   │   └── membership.js             # 会员与额度管理（计划查询、额度检查、用量记录）
│   └── admin/
│       ├── auth.js                   # 管理员鉴权（Cloudflare Access / ADMIN_API_TOKEN）
│       ├── database.js               # 管理后台 D1 操作（统计/Key/用户/封禁/日志 CRUD）
│       ├── routes.js                 # 管理 API 路由 + CSRF 保护 + 安全响应头
│       └── ui.js                     # 管理后台 WebUI（原生 HTML/CSS/JS）
├── migrations/                       # D1 数据库迁移（按编号顺序执行）
│   ├── 0001_create_api_keys.sql      # api_keys 表
│   ├── 0002_create_request_logs.sql  # request_logs 表
│   ├── 0003_add_limit_type.sql       # limit_type 字段（占位）
│   ├── 0004_create_users.sql         # users 表
│   ├── 0005_create_sessions.sql      # sessions 表
│   ├── 0006_create_verification_codes.sql  # email_verification_codes 表
│   ├── 0007_create_membership_plans.sql    # membership_plans 表
│   ├── 0008_alter_request_logs.sql   # request_logs 增加 user_id 列
│   ├── 0009_create_usage_records.sql # usage_records 表
│   ├── 0010_create_admin_logs.sql    # admin_logs 表
│   ├── 0011_seed_membership_plans.sql # 种子会员计划数据
│   ├── 0012_create_blacklisted_emails.sql # blacklisted_emails 表
│   ├── 0013_make_api_key_id_nullable.sql  # request_logs.api_key_id 改为可空
│   ├── 0014_add_password_auth.sql         # 密码认证、邮箱规范化、登录限流
│   ├── 0015_create_bans_and_appeals.sql   # 封禁与申诉
│   ├── 0016_create_feedback_tickets.sql   # 用户反馈工单
│   ├── 0017_unified_identity.sql          # OAuth 账户与 Refresh Token
│   ├── 0018_auth_challenges.sql           # 一次性认证挑战
│   └── 0019_create_contribution_tickets.sql # 代码贡献审核
├── scripts/                          # 管理脚本
│   ├── _common.js                    # 共用工具
│   ├── create-api-key.js             # 创建 API Key
│   ├── list-api-keys.js              # 列出所有 Key
│   ├── update-quota.js               # 修改请求额度
│   ├── disable-api-key.js            # 禁用 Key
│   └── delete-api-key.js             # 删除 Key
├── test/                             # 测试
│   ├── setup.js                      # 测试环境初始化
│   ├── index.spec.js                 # 公开 API 测试
│   └── admin.spec.js                 # 管理后台测试
├── docs/
│   ├── API.md                        # 公开 API 完整文档
│   ├── AUTHENTICATION.md             # 统一身份与登录流程
│   ├── MEMBERSHIP_AND_QUOTA.md       # 套餐与用量限制实现
│   └── ERROR_CODES.md                # 错误码表
├── wrangler.jsonc                    # Cloudflare Workers 配置
├── vitest.config.js                  # Vitest 测试配置
├── package.json
└── AGENTS.md                         # Cloudflare Workers 开发参考
```

### 模块职责

| 模块 | 文件 | 职责 |
|------|------|------|
| **入口/路由** | `src/index.js` | 域名路由分发、请求生命周期编排、流式/非流式分支、错误统一处理 |
| **API Key 鉴权** | `src/auth.js` | 公开 API 的 Bearer API Key 鉴权（Hash→D1→enabled→过期→额度） |
| **双鉴权中间件** | `src/auth/middleware.js` | Session + API Key 统一鉴权入口，优先级短路求值 |
| **邮箱验证码** | `src/auth/email.js` | 验证码生成/Resend 发送/校验，自动注册新用户 |
| **Session 管理** | `src/auth/session.js` | 创建/校验/销毁 Session Token（SHA-256 哈希存储） |
| **AI Provider** | `src/providers/minimax.js` | MiniMax-M3 非流式调用 + 流式 SSE 调用 |
| **额度管理** | `src/database/api_keys.js` | API Key 创建（绑定 user_id）、request_count/token_count 自增 |
| **用量记录** | `src/database/usage.js` | usage_records 表写入 |
| **用户管理** | `src/users/users.js` | users 表查询/更新、用户统计、Session/Key 列表 |
| **会员额度** | `src/membership/membership.js` | 会员计划查询、每日/每月额度检查、用量记录 |
| **管理鉴权** | `src/admin/auth.js` | Cloudflare Access / ADMIN_API_TOKEN 双通道鉴权 |
| **管理数据** | `src/admin/database.js` | 仪表盘统计、Key CRUD、用户管理、封禁用户、管理员日志 |
| **管理路由** | `src/admin/routes.js` | RESTful 路由分发、CSRF 保护、安全头注入 |
| **管理 UI** | `src/admin/ui.js` | 内置 WebUI 页面渲染 |

---

## 快速开始

### 前置要求

- Node.js 18+
- Cloudflare 账号（已开通 Workers & D1）
- Resend 账号（用于邮箱验证码发送）

### 本地开发

```bash
# 1. 安装依赖
npm install

# 2. 应用 D1 迁移（本地 SQLite）
npx wrangler d1 migrations apply studypulse-cloud-ai-db --local

# 3. 配置环境变量
cat > .dev.vars << 'EOF'
MINIMAX_API_KEY=sk-your-minimax-api-key
ADMIN_API_TOKEN=your-admin-token
RESEND_API_KEY=re_your_resend_api_key
# GitHub OAuth（统一身份中心必需）
GITHUB_CLIENT_ID=your-github-oauth-client-id
GITHUB_CLIENT_SECRET=your-github-oauth-client-secret
EOF

# 4. 种子测试 API Key（本地）
HASH=$(node -e "
  const c = require('crypto');
  console.log(c.createHash('sha256').update('sp_beta_test001','utf8').digest('hex'));
")
npx wrangler d1 execute studypulse-cloud-ai-db --local --command \
  "INSERT OR IGNORE INTO api_keys (key_hash, name, enabled)
   VALUES ('$HASH', 'Beta Test Key 001', 1);"

# 5. 启动开发服务器
npm run dev
# → http://localhost:8787

# 统一身份中心（本地路径路由）
open http://localhost:8787/login
```

### 验证本地服务

```bash
# 健康检查
curl http://localhost:8787/

# 邮箱验证码 — 发送
curl -X POST http://localhost:8787/auth/email/send \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com"}'

# 邮箱验证码 — 校验（返回 Session Token）
curl -X POST http://localhost:8787/auth/email/verify \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","code":"123456"}'

# 用户信息（Session Token）
curl http://localhost:8787/user/profile \
  -H "Authorization: Bearer sp_sess_xxx"

# AI 对话（非流式）
curl -X POST http://localhost:8787/v1/chat \
  -H "Authorization: Bearer sp_beta_test001" \
  -H "Content-Type: application/json" \
  -d '{"message":"你好"}'

# AI 对话（流式 SSE）
curl -X POST http://localhost:8787/v1/chat \
  -H "Authorization: Bearer sp_beta_test001" \
  -H "Content-Type: application/json" \
  -d '{"message":"你好","stream":true}'

# 管理后台
open http://localhost:8787/admin
```

---

## 部署指南

### 1. 设置 Secrets

```bash
# MiniMax AI 上游 Key（必需）
npx wrangler secret put MINIMAX_API_KEY

# 管理后台降级认证 Token（推荐配置）
npx wrangler secret put ADMIN_API_TOKEN

# Resend 邮件发送 Key（邮箱登录必需）
npx wrangler secret put RESEND_API_KEY

# GitHub OAuth（统一身份中心必需）
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
```

> Secrets 由 Cloudflare 加密存储，仅运行时通过 `env` 注入，绝不写入代码或配置文件。

### 2. 应用 D1 Migrations

```bash
# 生产环境（远程 D1）
npx wrangler d1 migrations apply studypulse-cloud-ai-db --remote
```

### 3. 种子初始 API Key

```bash
# 通过管理后台 UI 创建（部署后访问 admin.chenkai.space/admin）
# 或通过脚本创建
node scripts/create-api-key.js "iOS Beta 001" --remote
```

> 脚本创建的原始 Key 仅显示一次，请立即安全保存并交付给客户端。

### 4. 配置自定义域名

在 Cloudflare Dashboard 中为 Worker 绑定三个自定义域名：

| 域名 | 用途 | DNS 记录类型 |
|------|------|-------------|
| `spapi.chenkai.space` | 公开 AI API | CNAME → Worker `*.workers.dev` |
| `admin.chenkai.space` | 管理后台 | CNAME → Worker `*.workers.dev` |
| `support.chenkai.space` | 封禁账号申诉与反馈工单 | CNAME → Worker `*.workers.dev` |
| `auth.chenkai.space` | 统一登录与 GitHub OAuth | CNAME → Worker `*.workers.dev` |
| `dash.studypulse.chenkai.space` | 用户仪表盘、反馈与代码贡献 | CNAME → Worker `*.workers.dev` |

### 5. （可选）配置 Cloudflare Access

1. 进入 Cloudflare Zero Trust Dashboard
2. 创建 Self-hosted Application，Domain 设为 `admin.chenkai.space`
3. 添加 Identity Provider（GitHub / Google / 邮箱 OTP）
4. 配置 Access Policy，限定管理员访问
5. 在 Worker 环境变量中配置 `CF_ACCESS_TEAM_DOMAIN=https://<team-name>.cloudflareaccess.com`
6. 在 Worker 环境变量中配置 `CF_ACCESS_AUDIENCE=<Application AUD tag>`
7. Worker 会从 `<team-domain>/cdn-cgi/access/certs` 获取公钥，校验 Access JWT 的签名、issuer 和 audience

生产管理后台只通过 `admin.chenkai.space` 提供；`*.workers.dev` 上的 `/admin` 和 `/api/admin/*` 路由会直接返回 404。

### 6. 配置 Resend

1. 注册 [Resend](https://resend.com) 账号
2. 添加并验证发件域名（如 `chenkai.space`）
3. 创建 API Key，通过 `wrangler secret put RESEND_API_KEY` 注入

### 7. 部署 Worker

```bash
# Worker 已与 GitHub 集成，提交并推送后由 GitHub 自动触发部署
git add README.md
git commit -m "docs: update v0.7-beta release notes"
git push origin main
```

---

## 公开 API

完整 API 文档见 [docs/API.md](docs/API.md)。

### 端点总览

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| `GET` | `/` | 无 | 健康检查 |
| `POST` | `/auth/email/send` | 无 | 发送邮箱验证码（Resend） |
| `POST` | `/auth/email/verify` | 无 | 校验验证码并返回 Session Token |
| `POST` | `/auth/logout` | Bearer Session | 退出登录（销毁 Session） |
| `GET` | `/user/profile` | Bearer Session / API Key | 获取当前用户信息和会员状态 |
| `POST` | `/v1/chat` | Bearer Session / X-API-Key / Bearer API Key | AI 对话（文本/多模态/流式） |

### 统一身份中心

统一登录入口：`https://auth.chenkai.space/login`。认证接口最终共享同一个 `users.id`、会员计划和用量记录：

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/auth/login/password` | 邮箱 + 密码登录 |
| `POST` | `/auth/send-code` | 发送登录/重置密码验证码 |
| `POST` | `/auth/login/code` | 邮箱验证码登录，首次登录可设置密码 |
| `POST` | `/auth/password/set-after-code` | 验证码登录后的首次密码设置 |
| `POST` | `/v1/auth/register/verify` | 邮箱验证码注册并设置密码 |
| `POST` | `/v1/auth/password/change` | 修改密码并撤销旧 Session |
| `POST` | `/v1/auth/password/reset` | 验证码重置密码 |
| `POST` | `/auth/refresh` | Refresh Token 单次轮换 |
| `POST` | `/v1/auth/logout` / `/v1/auth/logout-all` | 退出当前设备/全部设备 |
| `GET` | `/v1/auth/me` | 获取当前用户和登录方式 |
| `GET` | `/oauth/github/start` | 启动 GitHub OAuth |
| `GET` | `/oauth/github/callback` | GitHub OAuth 回调与身份绑定 |

密码长度要求为 10–128 个 Unicode 字符。密码只保存哈希；历史 PBKDF2 凭据会在成功登录后升级为 bcrypt。完整流程见 [docs/AUTHENTICATION.md](docs/AUTHENTICATION.md)。

### 用户支持与贡献

- `support.chenkai.space`：封禁账号申诉和反馈工单
- `dash.studypulse.chenkai.space/dashboard`：用户用量和会员状态
- `dash.studypulse.chenkai.space/contributions`：提交 GitHub Issue、Fork 或 Pull Request 参与会员激励
- `dash.studypulse.chenkai.space/feedback`：提交反馈并查看处理结果

### AI 对话请求格式

**纯文本（非流式）：**

```json
{
  "message": "你好，请介绍一下自己"
}
```

**纯文本（流式 SSE）：**

```json
{
  "message": "你好，请介绍一下自己",
  "stream": true
}
```

**多模态（图片理解）：**

```json
{
  "content": [
    { "type": "text", "text": "这张图里有什么？" },
    {
      "type": "image_url",
      "image_url": { "url": "https://example.com/photo.jpg", "detail": "default" }
    }
  ]
}
```

**指定模型（需在用户会员计划可用模型列表中）：**

```json
{
  "message": "你好",
  "model": "MiniMax-M3"
}
```

> `content` 数组优先级高于 `message`。两者同时存在时以 `content` 为准。
> `model` 可选，默认 `"MiniMax-M3"`。

应用层限制：请求体最多 256 KiB，文本消息（包括多模态项中的 `text`）最多 32,768 个字符，
`content` 数组最多 16 项。请求体超限返回 `413`，字段或数组超限返回 `400`。

### 非流式成功响应

```json
{
  "success": true,
  "data": {
    "reply": "你好！我是 StudyPulse AI 助手..."
  }
}
```

### 流式响应（SSE）

当 `stream: true` 时，响应为 `text/event-stream`，直接透传 MiniMax SSE 格式：

```
data: {"id":"...","choices":[{"delta":{"content":"你好"}}]}

data: {"id":"...","choices":[{"delta":{"content":"！"}}]}

data: {"id":"...","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":50,"total_tokens":60}}

data: [DONE]
```

最后一个非 `[DONE]` chunk 包含 `usage` 字段，Worker 异步提取用于计次和日志。

### 错误码

| HTTP | `error` 字段 | 触发条件 |
|------|-------------|---------|
| 400 | `Invalid JSON Body` | 请求体非合法 JSON |
| 400 | `email is required` | 邮箱登录缺少 email 字段 |
| 400 | `Invalid verification code` | 验证码错误或已过期 |
| 401 | `Missing API Key or Session Token` | 未携带任何鉴权信息 |
| 401 | `Invalid or expired session` | Session Token 无效或已过期 |
| 403 | `Invalid API Key` | Key 不存在或格式错误 |
| 403 | `API Key disabled` | Key 已被管理员禁用 |
| 403 | `API Key expired` | Key 已过期 |
| 404 | `Not Found` | 未定义的路径 |
| 429 | `API quota exceeded` | Key 请求次数达到 `request_limit` |
| 429 | `Daily request limit exceeded` | 用户当日请求次数达到会员上限 |
| 429 | `Monthly point limit exceeded` | 用户当月 AI Points 达到会员上限 |
| 429 | `Verification code locked` | 验证码错误次数超过 5 次 |
| 500 | `Server not configured: no AI provider API keys` | 未配置任何上游 API Key |
| 502 | `AI request failed` | 上游 Provider 调用失败 |
| 502 | `Email delivery failed` | Resend 邮件发送失败 |

### 上游模型配置

| 配置项 | 值 | 说明 |
|--------|-----|------|
| Provider | `minimax` | MiniMax OpenAI 兼容协议 |
| Endpoint | `https://api.minimaxi.com/v1/chat/completions` | 国内版 |
| Model | `MiniMax-M3` | 原生多模态，1M 上下文 |
| Thinking | `disabled` | 关闭思考过程，直接返回最终回复 |
| Streaming | 支持 | 通过 `stream: true` 开启 SSE 流式传输 |

---

## 管理后台

### 访问方式

| 域名 | 路径 | 说明 |
|------|------|------|
| `admin.chenkai.space` | `/admin` | 生产环境 |
| `support.chenkai.space` | `/appeal/:token` | 封禁账号申诉 |
| `localhost:8787` | `/admin` | 本地开发（路径路由兼容） |

### 认证方式

管理后台支持两种认证方式，短路求值，任一通过即可：

1. **Cloudflare Access（推荐）** — Worker 使用 Access JWKS 校验 `Cf-Access-Jwt-Assertion` 的 RS256 签名、issuer 和 audience
2. **ADMIN_API_TOKEN（降级）** — 本地开发或未配置 Access 时使用 Bearer Token

### 管理 API

所有管理 API 需管理员认证。状态变更接口（POST）额外需要 CSRF Token。

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/admin/stats` | 仪表盘统计（Key 数、用户数、请求总量、超配额数） |
| `GET` | `/api/admin/keys` | 列出所有 API Key |
| `POST` | `/api/admin/keys/create` | 创建 Key（需绑定 user_id，返回仅一次的 rawKey） |
| `POST` | `/api/admin/keys/update` | 更新 Key（名称/状态/配额/备注/过期） |
| `POST` | `/api/admin/keys/delete` | 删除 Key（CASCADE 删除关联日志） |
| `POST` | `/api/admin/keys/reset-quota` | 重置请求计数和 Token 计数为 0 |
| `GET` | `/api/admin/logs` | 查询请求日志（可按 api_key_id/user_id/call_method/status 筛选） |
| `GET` | `/api/admin/users` | 列出所有用户（支持搜索/角色/会员筛选） |
| `GET` | `/api/admin/users/:id` | 用户详情（含请求/Token/Key 统计） |
| `GET` | `/api/admin/users/:id/stats` | 用户使用统计 |
| `GET` | `/api/admin/users/:id/sessions` | 用户 Session 列表 |
| `GET` | `/api/admin/users/:id/keys` | 用户 API Key 列表 |
| `POST` | `/api/admin/users/create` | 创建用户（管理员创建，默认已验证） |
| `POST` | `/api/admin/users/update` | 更新用户（角色/会员/到期时间） |
| `GET` | `/api/admin/blacklist` | 列出已封禁邮箱 |
| `POST` | `/api/admin/blacklist/add` | 封禁邮箱 |
| `POST` | `/api/admin/blacklist/remove` | 解除邮箱封禁 |

### CSRF 保护

- 管理页面加载时生成随机 CSRF Token，通过 `Set-Cookie` 写入（`SameSite=Strict; HttpOnly; Path=/api/admin`）
- Token 同时注入页面 `<meta>` 标签供前端 JS 读取
- 状态变更请求需携带 `X-CSRF-Token` header，服务端常量时间比较 Cookie 与 Header 值
- 安全响应头：`X-Content-Type-Options`, `X-Frame-Options`, `X-XSS-Protection`, `Referrer-Policy`, `Permissions-Policy`

---

## 数据库设计

### api_keys 表

```sql
CREATE TABLE api_keys (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    key_hash        TEXT NOT NULL UNIQUE,        -- SHA-256(原始 Key)，绝不存原文
    name            TEXT NOT NULL,               -- 人类可读名称
    enabled         INTEGER NOT NULL DEFAULT 1,  -- 0=禁用, 1=启用
    request_count   INTEGER NOT NULL DEFAULT 0,  -- 累计请求次数
    token_count     INTEGER NOT NULL DEFAULT 0,  -- 累计消耗 Token 数
    request_limit   INTEGER,                     -- 请求上限，NULL=不限量
    limit_type      TEXT NOT NULL DEFAULT 'count', -- 'count' = 按次数, 'tokens' = 按 Token
    user_id         TEXT,                         -- 绑定用户 ID (FK users.id)
    notes           TEXT,                         -- 备注
    expires_at      TEXT,                         -- ISO 8601 过期时间，NULL=永不过期
    created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at    TEXT                          -- 最后使用时间
);
```

### users 表

```sql
CREATE TABLE users (
    id                  TEXT PRIMARY KEY,              -- UUID
    email               TEXT UNIQUE NOT NULL,
    email_verified      INTEGER NOT NULL DEFAULT 0,    -- 0=未验证, 1=已验证
    role                TEXT NOT NULL DEFAULT 'user',  -- 'admin' | 'user'
    membership_type     TEXT NOT NULL DEFAULT 'free',  -- 'free' | 'plus' | 'pro'
    membership_expires_at TEXT,                         -- NULL=未设置到期时间
    github_id           TEXT UNIQUE,                   -- 预留，暂不实现
    username            TEXT,
    avatar_url          TEXT,
    created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

### sessions 表

```sql
CREATE TABLE sessions (
    id          TEXT PRIMARY KEY,              -- UUID
    user_id     TEXT NOT NULL,                 -- FK users.id
    token_hash  TEXT NOT NULL UNIQUE,          -- SHA-256(sp_sess_xxx)
    expires_at  TEXT NOT NULL,                 -- 30 天有效期
    last_used_at TEXT,                          -- 最近使用时间
    created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

### membership_plans 表

```sql
CREATE TABLE membership_plans (
    id                  TEXT PRIMARY KEY,      -- 'free' | 'plus' | 'pro'
    name                TEXT NOT NULL,
    daily_request_limit INTEGER,
    monthly_token_limit INTEGER,              -- deprecated
    monthly_point_limit INTEGER,              -- 用户月积分上限
    available_models    TEXT NOT NULL DEFAULT '["MiniMax-M3"]'
);
```

默认种子数据（INTERNAL_TEST）：

| Plan | 价格 / 月 | 日请求上限 | 月 AI Points |
|------|----------|-----------|-------------|
| free | ¥0 | 5 | 5,000 |
| plus | ¥14.9 | 50 | 200,000 |
| pro | ¥34.9 | 200 | 400,000 |

### usage_records 表

```sql
CREATE TABLE usage_records (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         TEXT NOT NULL,             -- FK users.id
    api_key_id      INTEGER,                   -- FK api_keys.id（Session 调用时为 NULL）
    model           TEXT,
    input_tokens    INTEGER NOT NULL DEFAULT 0,
    output_tokens   INTEGER NOT NULL DEFAULT 0,
    total_tokens    INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

### request_logs 表

```sql
CREATE TABLE request_logs (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    api_key_id        INTEGER,                  -- FK api_keys.id（Session 调用时为 NULL）
    user_id           TEXT,                      -- FK users.id
    request_time      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    model             TEXT,
    provider          TEXT,
    status            INTEGER NOT NULL,          -- 200=成功, 502=失败
    latency_ms        INTEGER,
    prompt_tokens     INTEGER,
    completion_tokens INTEGER,
    total_tokens      INTEGER,
    ip                TEXT,                      -- CF-Connecting-IP
    user_agent        TEXT,
    error_message     TEXT                       -- 截断至 500 字符
);
```

### email_verification_codes 表

```sql
CREATE TABLE email_verification_codes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    email           TEXT NOT NULL,
    code            TEXT NOT NULL,                 -- 6 位数字
    used            INTEGER NOT NULL DEFAULT 0,   -- 0=未使用, 1=已使用
    attempts        INTEGER NOT NULL DEFAULT 0,   -- 错误次数（5 次锁定）
    delivery_status TEXT NOT NULL DEFAULT 'pending', -- 'pending'|'sent'|'failed'
    expires_at      TEXT NOT NULL,                 -- 10 分钟有效期
    created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

### admin_logs 表

```sql
CREATE TABLE admin_logs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_user_id   TEXT NOT NULL,
    action          TEXT NOT NULL,               -- create_api_key, create_user, change_membership 等
    target_user_id  TEXT,
    details         TEXT,                         -- JSON 格式操作详情
    created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

### blacklisted_emails 表

```sql
CREATE TABLE blacklisted_emails (
    email       TEXT PRIMARY KEY,
    reason      TEXT,
    created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

> **隐私设计：** 日志表不存储 prompt 和 reply 内容。key_hash 不通过管理 API 返回。删除 Key 时 CASCADE 清理关联日志。

---

## API Key 管理

### Key 生命周期

```
创建（仅一次显示 rawKey，必须绑定 user_id）
  │  node scripts/create-api-key.js "Name" --remote
  │  或管理后台 UI → 创建 Key
  ▼
启用（enabled = 1，默认）
  │  客户端通过 X-API-Key header 或 Authorization: Bearer 携带 Key 发起请求
  ▼
使用中（request_count/token_count 递增）
  │  管理员可随时：
  │  - 禁用 (enabled = 0)
  │  - 调整配额 (request_limit / limit_type)
  │  - 重置计数 (request_count = 0, token_count = 0)
  ▼
过期/禁用/删除
```

### 额度计数规则

- **API Key 额度**：仅在 MiniMax 调用成功后自增 `request_count` 和 `token_count`
- **用户会员额度**：按 `usage_records` 表统计，分日请求次数和月 Token 消耗两个维度
- 鉴权失败、上游 AI 失败、Worker 内部错误**一律不计次**
- `request_limit` 为 `NULL` 时表示不限量，跳过额度校验
- `limit_type` 可切换 `"count"`（按请求次数）或 `"tokens"`（按 Token 消耗量）

### 命令行管理

```bash
# 创建 Key
node scripts/create-api-key.js "iOS Beta 001" --remote

# 列出所有 Key
node scripts/list-api-keys.js --remote

# 修改配额（0=不限量，正整数=上限）
node scripts/update-quota.js <key_id> <limit> --remote

# 禁用 Key
node scripts/disable-api-key.js <key_id> --remote

# 删除 Key
node scripts/delete-api-key.js <key_id> --remote
```

---

## 安全模型

### 数据保护

| 数据 | 存储方式 | 访问控制 |
|------|---------|---------|
| 客户端 API Key 原文 | 不存储（仅创建时显示一次） | — |
| 客户端 API Key 哈希 | D1 `key_hash`（SHA-256） | 管理 API 不返回此字段 |
| Session Token 原文 | 不存储（仅登录时返回一次） | — |
| Session Token 哈希 | D1 `token_hash`（SHA-256） | 管理 API 不返回此字段 |
| MiniMax 上游 Key | Cloudflare Secret | 仅运行时 `env.MINIMAX_API_KEY` |
| 管理员 Token | Cloudflare Secret | 仅运行时 `env.ADMIN_API_TOKEN` |
| Resend API Key | Cloudflare Secret | 仅运行时 `env.RESEND_API_KEY` |
| 用户 Prompt / AI Reply | 不存储 | — |

### 防御措施

| 威胁 | 措施 |
|------|------|
| SQL 注入 | 所有 D1 查询使用参数化 prepared statements |
| 时序攻击 | Token 比较使用常量时间算法 |
| CSRF | 状态变更 API 校验 SameSite=Strict Cookie + 自定义 Header |
| Session 劫持 | Token SHA-256 哈希存储，30 天过期，退出登录即时销毁 |
| 验证码爆破 | 5 次错误锁定，10 分钟过期，发送频率限制 1 分钟 |
| 邮箱滥用 | blacklisted_emails 封禁机制 |
| XSS | 安全响应头（CSP、X-XSS-Protection、X-Content-Type-Options） |
| Clickjacking | `X-Frame-Options: DENY` |
| 信息泄露 | 错误响应统一格式，不暴露内部细节 |
| 密钥泄露 | Secrets 不进代码/Git，D1 不存原文，日志不存内容 |

### 密钥层级

```
用户持有         sp_sess_xxx  ──SHA-256──►  D1 sessions.token_hash
                         │
                         └──►  D1 users.id  ──►  会员额度管理

客户端持有      sp_beta_xxx  ──SHA-256──►  D1 api_keys.key_hash
                                                  │
Worker 持有      MINIMAX_API_KEY  ──Bearer──►  MiniMax API
(Cloudflare Secret)
```

客户端永远不接触 MiniMax Key，Worker 永远不存储客户端 Key 或 Session Token 原文。

---

## 测试

```bash
# 运行所有测试（watch 模式）
npm test

# 单次运行
npm test -- --run

# 运行特定测试文件
npx vitest run test/index.spec.js
```

### 测试覆盖

| 测试文件 | 覆盖内容 |
|---------|---------|
| `test/index.spec.js` | 健康检查、无 Key/错误 Key/禁用 Key（403）、过期 Key（403）、配额超限（429）、正常对话、流式对话、无效 JSON（400）、未配置 Key（500）、上游失败（502）、request_count 自增、request_logs 写入 |
| `test/admin.spec.js` | 管理员鉴权（Access JWT / Token）、未授权（401）、Key 列表、创建 Key、更新 Key、删除 Key、重置配额、日志查询、CSRF 校验（403）|
| `test/auth-password.spec.js` | 密码注册/登录、修改/重置、Session 撤销、登录锁定、历史用户兼容和 API Key 身份统一 |
| `test/auth-unified.spec.js` | 验证码登录、首次密码设置、Refresh Token 轮换和统一身份中心路由 |
| `test/support.spec.js` | 用户反馈工单和支持中心认证 |

### 测试环境

- 使用 `@cloudflare/vitest-pool-workers` 在本地模拟 Workers 运行时
- D1 使用 wrangler 本地 SQLite（`.wrangler/state/v3/d1/`）
- Secrets 通过 `test/setup.js` 注入测试环境变量
- 测试数据隔离，每次测试前重新应用 migration

---

## 技术栈

| 层 | 技术 | 说明 |
|----|------|------|
| **Runtime** | Cloudflare Workers | 全球边缘计算，零冷启动 |
| **Database** | Cloudflare D1 (SQLite) | 边缘 SQL 数据库，与 Workers 零延迟 |
| **AI Provider** | MiniMax-M3 | OpenAI 兼容协议，原生多模态，1M 上下文 |
| **Email** | Resend | 邮件 API，用于发送验证码 |
| **Admin UI** | 原生 HTML/CSS/JS | 零框架，零构建步骤 |
| **Auth** | bcrypt + Web Crypto API | 密码凭据、Session/API Key 哈希与统一身份认证 |
| **CLI** | wrangler | Cloudflare 官方 CLI |
| **Test** | Vitest + cloudflare/vitest-pool-workers | Workers 本地模拟测试 |

---

## 版本历史

### v0.7-beta Release Notes

发布日期：2026-07-26

#### 重大更新：统一身份中心

v0.7 将邮箱验证码、邮箱密码、GitHub OAuth、Session 和 API Key 统一到同一套用户身份模型。用户不再因为更换登录方式而产生重复账号，会员、额度、API Key 和请求记录继续绑定到同一个 `users.id`。

#### 登录与账号安全

- 新增 `auth.chenkai.space` 统一登录页，支持邮箱密码、邮箱验证码和 GitHub OAuth。
- 新增密码注册、修改、重置和首次验证码登录后的密码设置流程。
- 新增 Access Token / Refresh Token，会话支持设备信息、单设备退出、全部设备退出和 Refresh Token 单次轮换。
- 密码采用 bcrypt 哈希存储；历史 PBKDF2 凭据在成功登录后自动升级。
- 增加邮箱规范化、验证码用途区分、登录失败限流、账号锁定和一次性认证挑战，避免凭据枚举和重放。

#### 用户服务与运营流程

- 新增用户仪表盘，展示会员状态、AI 用量趋势和账号认证状态。
- 新增封禁账号邮件通知、在线申诉页面和管理员审核流程。
- 新增反馈工单，用户可提交普通/紧急反馈并查看处理结果。
- 新增 GitHub 代码贡献审核，管理员可审核 Issue、Fork、Pull Request 等贡献并发放 Plus/Pro 会员。
- 管理后台新增申诉、反馈工单和代码贡献审核页面，并保留用户、Key、会员和请求日志管理。

#### 数据库与兼容性

- 新增 D1 migrations `0014`–`0019`：密码认证、封禁申诉、反馈工单、OAuth 账户、认证挑战和代码贡献工单。
- 保留旧版 `/auth/email/*` 邮箱验证码接口和 API Key 鉴权方式，已存在的用户与 API Key 不会被重新创建或解绑。
- `docs/AUTHENTICATION.md`、`docs/API.md` 和 `docs/ERROR_CODES.md` 补充统一身份、接口和错误码说明。

#### 升级指南

从 v0.6-beta 升级到 v0.7-beta：

1. 应用 D1 migrations `0014`–`0019`：

   ```bash
   npx wrangler d1 migrations apply studypulse-cloud-ai-db --remote
   ```

2. 配置 `RESEND_API_KEY`、`GITHUB_CLIENT_ID` 和 `GITHUB_CLIENT_SECRET` Secrets。
3. 在 GitHub OAuth App 中将回调地址设置为 `https://auth.chenkai.space/oauth/github/callback`。
4. 提交并推送代码，由 GitHub 集成触发 Worker 部署。

---

| 版本 | 日期 | 变更 |
|------|------|------|
| `0.1-beta` | 2026-07 | 基础 API Gateway，内存数组鉴权，`/v1/chat` 回显 |
| `0.2-beta` | 2026-07 | 接入 MiniMax-M3，真实 AI 调用，多模态输入，Thinking 关闭 |
| `0.3-beta` | 2026-07 | 鉴权切换到 D1 持久化，SHA-256 哈希存储，请求日志表 |
| `0.4-beta` | 2026-07 | 请求额度控制（request_limit/429），Key 启用/禁用，管理脚本 |
| `0.5-beta` | 2026-07 | 管理后台 WebUI + API，域名隔离路由，CSRF 保护，Cloudflare Access |
| `0.6-beta` | 2026-07 | SaaS 用户体系（邮箱验证码登录 + Session Token + 双鉴权中间件）、三级会员计划（日请求/月 Token 额度）、流式 SSE 响应（含 tee 分叉用量提取）、usage_records 用量追踪、用户管理（角色/会员 CRUD）、封禁用户、管理员操作日志、limit_type 按次数/Token 限额切换、X-API-Key header 鉴权 |
| `0.7-beta` | 2026-07 | 统一身份中心（邮箱密码/验证码/GitHub OAuth）、Access/Refresh Token 会话、密码安全与登录限流、用户仪表盘、封禁申诉、反馈工单、代码贡献会员激励、0014–0019 数据库迁移 |

---

## 后续规划

- [ ] **多 Provider 路由** — `providers/` 新增 openai/kimi/glm，body 增加 `provider` 字段
- [ ] **时间窗口限流** — 基于 D1 的每分钟/每小时速率限制
- [ ] **用量仪表盘图表** — 管理后台增加用量趋势可视化
- [ ] **更细粒度的速率限制** — 按用户、IP、接口和设备组合限流
