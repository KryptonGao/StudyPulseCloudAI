# 动态模型管理（Dynamic Model Management）

**版本:** 2026-08-28 · **迁移:** `0025_ai_models.sql` · **路由版本:** `2026-08-v2`

管理员可在后台随时新增 / 编辑 / 禁用路由模型，保存后**无需重新部署**即参与路由（配置仅 15 秒缓存）。

## 核心设计

| 概念 | 说明 |
| --- | --- |
| 用途（purpose） | Caller 只映射到用途类别：`light` 轻量快速 / `chat` 标准对话 / `reasoning` 深度推理 / `vision` 视觉理解。**Caller → 具体模型的映射已废除** |
| 候选池 | Router 在 `ai_models` 中筛选打了对应用途标签、已启用且有可用 Key 的模型 |
| 优先级（priority） | 数字越小越优先；同用途内决定 Primary 与 Fallback 顺序 |
| 能力（capabilities） | `streaming` / `thinking` / `vision`。带图片的请求只路由到 `vision` 模型；强制思考只路由到 `thinking` 模型 |
| min_plan | 低于该会员等级的 Caller 不会选到该模型（vision 请求豁免；全部候选耗尽时才作为最后手段放宽） |
| 协议（provider） | 适配器由代码维护：`openai-compat`（新增 OpenAI 兼容模型用这个）+ 内置方言 `mimo` / `hy3` / `minimax` |

新增一个符合某用途标签的模型后，它自动进入该用途的路由候选池，按优先级参与 Primary/Fallback 选择。运行时回退会跳过与失败模型同 host 的候选并避开不可用模型。

## 保留的既有行为

- 三个内置模型（MiMo V2.5 / HY3 / MiniMax M3）由迁移 0025 种子化，可在后台编辑。它们的 API Key 默认继续走 Worker secrets（`MIMO_API_KEY` / `HY3_API_KEY` / `MINIMAX_API_KEY`，见 `env_key_name`），在后台填入 Key 后覆盖为加密存储。
- **积分计算逻辑与 `pricing_version` 不变**：动态模型的系数存于既有 `pricing_rates` 表（毫积分/Token + 倍率），随模型表单一起保存；历史 `usage_records.points_charged` 永不重算。"恢复默认计价"只重置三个内置模型。
- 升级语义保留：轻量 Caller 的大请求升级到 chat 池；复杂/强制思考升级到 reasoning 池；免费用户的 plus 模型自动降级到 chat 池。

## API Key 加密

`api_key_cipher` 列存储 AES-GCM 密文（`v1.<iv>.<ct>`），**绝不明文落库**。加密密钥从 `MODEL_SECRET_ENCRYPTION_KEY` secret 派生（SHA-256），未配置时依次回退 `ADMIN_API_TOKEN` → 本地开发常量。轮换加密密钥会使已存 Key 不可解密（该模型视为未配置 Key），需重新填写。

```bash
npx wrangler secret put MODEL_SECRET_ENCRYPTION_KEY
```

## Admin API

| 路由 | 说明 |
| --- | --- |
| `GET /api/admin/models` | 模型列表 + 用途/协议元数据（不含任何 Key 内容，仅 `keySource` 与尾 4 位提示） |
| `POST /api/admin/models/create` | 新增：`display_name`、`model_id`（上游）、`base_url`、`api_key`、`provider`、`auth_style`、`context_length`、`capabilities`、`purposes`、`priority`、`min_plan`、`rates`、`extra_body`、`internal_id`（可选） |
| `POST /api/admin/models/update` | 部分更新（含 `enabled` 启停、`api_key` 留空不改 / 空串清除） |
| `POST /api/admin/models/test` | 按模型 ID 连通性测试（含动态模型） |

后台页面：管理后台 → 「模型管理」标签页。

## 相关代码

- `src/ai/model-config.js` — 模型注册表 DB 层 + 校验 + 内置默认
- `src/ai/policies.js` — Caller → 用途映射（`CALLER_POLICIES`）
- `src/ai/router.js` — 动态候选链构建
- `src/providers/registry.js` — 按模型绑定协议适配器（含 openai-compat 通用方言）
- `src/security/secretbox.js` — AES-GCM 加密
- `src/admin/models.js` + `src/admin/routes.js` — 管理服务层与 API
- `src/billing/store.js` — 计价表并入动态模型（`DYNAMIC_DEFAULT_RATES` 兜底）
