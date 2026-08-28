-- Migration number: 0025  2026-08-28T14:00:00.000Z
--
-- Dynamic model management (动态模型管理).
--
-- One row per routable model. The AI Router reads this table (short cache)
-- so admin edits take effect without redeploying the Worker.
--
--   api_key_cipher  AES-GCM ciphertext "v1.<iv>.<ct>" — never plaintext.
--                   NULL → fall back to the env secret named in env_key_name
--                   (used by the seeded built-in models).
--   capabilities    JSON { streaming, thinking, vision }
--   purposes        JSON array of routing purpose ids
--                     light     轻量快速任务
--                     chat      标准对话 / 通用任务
--                     reasoning 深度推理 / 复杂任务
--                     vision    视觉理解（图片输入）
--   priority        smaller number = higher routing priority
--   min_plan        caller plans below this never get the model as
--                   primary/fallback (vision requests are exempt)

CREATE TABLE IF NOT EXISTS ai_models (
	id TEXT PRIMARY KEY NOT NULL,
	display_name TEXT NOT NULL,
	provider TEXT NOT NULL,
	upstream_model TEXT NOT NULL,
	base_url TEXT NOT NULL,
	auth_style TEXT NOT NULL DEFAULT 'bearer',
	api_key_cipher TEXT,
	env_key_name TEXT,
	key_hint TEXT,
	context_length INTEGER NOT NULL DEFAULT 0,
	capabilities TEXT NOT NULL DEFAULT '{}',
	purposes TEXT NOT NULL DEFAULT '[]',
	priority INTEGER NOT NULL DEFAULT 100,
	min_plan TEXT NOT NULL DEFAULT 'free',
	extra_body TEXT,
	enabled INTEGER NOT NULL DEFAULT 1,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Seed the three built-in models. Keys keep resolving from Worker secrets
-- (MIMO_API_KEY / HY3_API_KEY / MINIMAX_API_KEY) until an admin stores an
-- encrypted key from the admin console. INSERT OR IGNORE keeps admin edits.
INSERT OR IGNORE INTO ai_models (
	id, display_name, provider, upstream_model, base_url, auth_style,
	env_key_name, context_length, capabilities, purposes, priority, min_plan, enabled
) VALUES
	('mimo-v2.5', 'MiMo v2.5', 'mimo', 'mimo-v2.5-free', 'https://opencode.ai/zen/v1', 'bearer',
	 'MIMO_API_KEY', 0, '{"streaming":true,"thinking":false,"vision":false}', '["light"]', 10, 'free', 1),
	('hy3', 'HY3', 'hy3', 'hy3-free', 'https://opencode.ai/zen/v1', 'bearer',
	 'HY3_API_KEY', 0, '{"streaming":true,"thinking":true,"vision":false}', '["chat"]', 10, 'free', 1),
	('minimax-m3', 'MiniMax M3', 'minimax', 'MiniMax-M3', 'https://api.minimaxi.com/v1', 'bearer',
	 'MINIMAX_API_KEY', 0, '{"streaming":true,"thinking":true,"vision":true}', '["chat","reasoning","vision"]', 20, 'plus', 1);
