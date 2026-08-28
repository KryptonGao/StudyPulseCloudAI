/**
 * StudyPulse Cloud AI - 管理后台数据库操作
 *
 * 所有对 D1 的查询集中在这里，使用参数化查询（prepared statements）。
 * 管理后台绝对不返回 key_hash 字段，防止哈希泄露。
 */

// ────────────────────────────────────────────────────────────────────────────
// 仪表盘统计
// ────────────────────────────────────────────────────────────────────────────

/**
 * 获取仪表盘统计数据。
 * @param {{ StudyPulseDB: D1Database }} env
 * @returns {Promise<{totalKeys: number, enabledKeys: number, totalRequests: number, exceededQuotaKeys: number, totalUsers: number}>}
 */
export async function getDashboardStats(env) {
	const db = env.StudyPulseDB;

	const [totalKeys, enabledKeys, totalRequests, exceededQuotaKeys, totalUsers] =
		await Promise.all([
			db
				.prepare("SELECT COUNT(*) AS count FROM api_keys")
				.first("count"),
			db
				.prepare("SELECT COUNT(*) AS count FROM api_keys WHERE enabled = 1")
				.first("count"),
			db
				.prepare("SELECT COALESCE(SUM(request_count), 0) AS count FROM api_keys")
				.first("count"),
			db
				.prepare(
					"SELECT COUNT(*) AS count FROM api_keys WHERE request_limit IS NOT NULL AND ((limit_type = 'tokens' AND token_count >= request_limit) OR ((limit_type IS NULL OR limit_type = 'count') AND request_count >= request_limit))",
				)
				.first("count"),
			db
				.prepare("SELECT COUNT(*) AS count FROM users")
				.first("count"),
		]);

	return {
		totalKeys,
		enabledKeys,
		totalRequests,
		exceededQuotaKeys,
		totalUsers,
	};
}

export async function getDashboardUsageTrend(env, range = "1D") {
	const configs = {
		"1D": { modifier: "-1 day", bucket: "strftime('%Y-%m-%dT%H:00:00Z', request_time)" },
		"3D": { modifier: "-3 days", bucket: "date(request_time)" },
		"1W": { modifier: "-7 days", bucket: "date(request_time)" },
		"2W": { modifier: "-14 days", bucket: "date(request_time)" },
		"1M": { modifier: "-1 month", bucket: "date(request_time)" },
		"3M": { modifier: "-3 months", bucket: "date(request_time, '-' || ((CAST(strftime('%w', request_time) AS INTEGER) + 6) % 7) || ' days')" },
		"6M": { modifier: "-6 months", bucket: "date(request_time, '-' || ((CAST(strftime('%w', request_time) AS INTEGER) + 6) % 7) || ' days')" },
		"1Y": { modifier: "-1 year", bucket: "strftime('%Y-%m', request_time)" },
	};
	const config = configs[range] || configs["1D"];
	const { results } = await env.StudyPulseDB.prepare(
		`SELECT ${config.bucket} AS bucket,
		        COUNT(*) AS calls,
		        COALESCE(SUM(total_tokens), 0) AS tokens
		   FROM request_logs
		  WHERE request_time >= datetime('now', ?)
		  GROUP BY bucket
		  ORDER BY bucket ASC`,
	).bind(config.modifier).all();
	return results.map((row) => ({
		bucket: row.bucket,
		calls: Number(row.calls) || 0,
		tokens: Number(row.tokens) || 0,
	}));
}

// ────────────────────────────────────────────────────────────────────────────
// API Key 管理
// ────────────────────────────────────────────────────────────────────────────

// createApiKey 已移至 src/database/api_keys.js（增加 user_id 参数）
export { createApiKey } from "../database/api_keys.js";

// ────────────────────────────────────────────────────────────────────────────
// 用户封禁（底层表名保留 blacklisted_emails 以兼容现有数据）
// ────────────────────────────────────────────────────────────────────────────

/**
 * 检查邮箱是否已被封禁。
 * @param {string} email
 * @param {{ StudyPulseDB: D1Database }} env
 * @returns {Promise<boolean>}
 */
export async function isEmailBlacklisted(email, env) {
	try {
		const row = await env.StudyPulseDB.prepare(
			"SELECT email FROM blacklisted_emails WHERE email = ?",
		)
			.bind(email.trim().toLowerCase())
			.first();
		return !!row;
	} catch (e) {
		console.error("isEmailBlacklisted error:", e?.message || e);
		return false;
	}
}

/**
 * 封禁邮箱。
 * @param {string} email
 * @param {string} [reason]
 * @param {{ StudyPulseDB: D1Database }} env
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function blacklistEmail(email, reason, env) {
	const normalized = email.trim().toLowerCase();
	if (!normalized || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
		return { success: false, error: "Invalid email format" };
	}

	try {
		await env.StudyPulseDB.prepare(
			"INSERT INTO blacklisted_emails (email, reason) VALUES (?, ?)",
		)
			.bind(normalized, reason || null)
			.run();
		return { success: true };
	} catch (err) {
			// UNIQUE constraint violation = 已被封禁
		if (err?.message?.includes("UNIQUE")) {
			return { success: false, error: "Email already blacklisted" };
		}
		throw err;
	}
}

/**
 * 解除邮箱封禁。
 * @param {string} email
 * @param {{ StudyPulseDB: D1Database }} env
 * @returns {Promise<boolean>}
 */
export async function removeBlacklistedEmail(email, env) {
	const normalized = email.trim().toLowerCase();
	const user = await env.StudyPulseDB.prepare(
		"SELECT id FROM users WHERE email_normalized = ? OR lower(email) = ?",
	).bind(normalized, normalized).first();

	const db = env.StudyPulseDB;
	const results = await db.batch([
		db.prepare("DELETE FROM blacklisted_emails WHERE lower(email) = ?").bind(normalized),
		...(user
			? [
				db.prepare("UPDATE bans SET status = 'cancelled' WHERE user_id = ? AND status = 'active'").bind(user.id),
				db.prepare("UPDATE users SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'banned'").bind(user.id),
			]
			: []),
	]);

	return results.some((result) => result.meta?.changes > 0);
}

/**
 * 列出所有已封禁邮箱。
 * @param {{ StudyPulseDB: D1Database }} env
 * @returns {Promise<Array>}
 */
export async function listBlacklistedEmails(env) {
	const { results } = await env.StudyPulseDB.prepare(
		`SELECT email, reason, created_at FROM (
			SELECT u.email, b.reason, b.created_at
			  FROM bans b
			  JOIN users u ON u.id = b.user_id
			 WHERE b.status = 'active'
			UNION ALL
			SELECT legacy.email, legacy.reason, legacy.created_at
			  FROM blacklisted_emails legacy
			 WHERE NOT EXISTS (
				SELECT 1
				  FROM bans b2
				  JOIN users u2 ON u2.id = b2.user_id
				 WHERE b2.status = 'active'
				   AND lower(u2.email) = lower(legacy.email)
			 )
		) ORDER BY created_at DESC`,
	).all();
	return results;
}

/**
 * 列出所有 API Key（不含 key_hash）。
 * @param {{ StudyPulseDB: D1Database }} env
 * @returns {Promise<Array>}
 */
export async function listApiKeys(env) {
	const { results } = await env.StudyPulseDB.prepare(
		`SELECT id, name, enabled, request_count, request_limit,
		        limit_type, token_count,
		        user_id, notes, expires_at, created_at, last_used_at
		   FROM api_keys
		  ORDER BY created_at DESC`,
	).all();

	return results;
}

/**
 * 更新 API Key（不允许修改 key_hash、request_count、created_at）。
 * @param {{ StudyPulseDB: D1Database }} env
 * @param {number} id - API Key ID
 * @param {{ name?: string, enabled?: number, limit_type?: string, request_limit?: number|null, notes?: string|null, expires_at?: string|null }} fields
 * @returns {Promise<boolean>} true = 更新成功，false = 记录不存在
 */
export async function updateApiKey(env, id, fields) {
	// 构建动态 SET 子句（参数化查询）
	const setClauses = [];
	const bindings = [];

	if (fields.name !== undefined) {
		setClauses.push("name = ?");
		bindings.push(fields.name);
	}
	if (fields.enabled !== undefined) {
		setClauses.push("enabled = ?");
		bindings.push(fields.enabled ? 1 : 0);
	}
	if (fields.request_limit !== undefined) {
		setClauses.push("request_limit = ?");
		bindings.push(fields.request_limit);
	}
	if (fields.limit_type !== undefined) {
		setClauses.push("limit_type = ?");
		bindings.push(fields.limit_type);
	}
	if (fields.notes !== undefined) {
		setClauses.push("notes = ?");
		bindings.push(fields.notes);
	}
	if (fields.expires_at !== undefined) {
		setClauses.push("expires_at = ?");
		bindings.push(fields.expires_at);
	}

	if (setClauses.length === 0) return false;

	bindings.push(id);

	const { meta } = await env.StudyPulseDB.prepare(
		`UPDATE api_keys SET ${setClauses.join(", ")} WHERE id = ?`,
	)
		.bind(...bindings)
		.run();

	return meta.changes > 0;
}

/**
 * 删除 API Key 及关联的 request_logs（CASCADE）。
 * @param {{ StudyPulseDB: D1Database }} env
 * @param {number} id
 * @returns {Promise<boolean>}
 */
export async function deleteApiKey(env, id) {
	const { meta } = await env.StudyPulseDB.prepare(
		"DELETE FROM api_keys WHERE id = ?",
	)
		.bind(id)
		.run();

	return meta.changes > 0;
}

/**
 * 重置 API Key 的请求计数为 0。
 * @param {{ StudyPulseDB: D1Database }} env
 * @param {number} id
 * @returns {Promise<boolean>}
 */
export async function resetQuota(env, id) {
	const { meta } = await env.StudyPulseDB.prepare(
		"UPDATE api_keys SET request_count = 0, token_count = 0 WHERE id = ?",
	)
		.bind(id)
		.run();

	return meta.changes > 0;
}

// ────────────────────────────────────────────────────────────────────────────
// 请求日志
// ────────────────────────────────────────────────────────────────────────────

/**
 * 查询请求日志（最近 300 条，按时间倒序）。
 * 支持按 api_key_id、user_id、call_method 和 status 筛选。
 * 不返回 prompt/reply 内容 —— 日志表本身就不存这些字段。
 *
 * @param {{ StudyPulseDB: D1Database }} env
 * @param {{ api_key_id?: number, user_id?: string, call_method?: string, status?: number }} filters
 * @returns {Promise<Array>}
 */
export async function getRequestLogs(env, filters = {}) {
	const conditions = [];
	const bindings = [];

	if (filters.api_key_id) {
		conditions.push("rl.api_key_id = ?");
		bindings.push(filters.api_key_id);
	}
	if (filters.user_id) {
		conditions.push("rl.user_id = ?");
		bindings.push(filters.user_id);
	}
	if (filters.call_method === "api_key") {
		conditions.push("rl.api_key_id IS NOT NULL");
	} else if (filters.call_method === "session") {
		conditions.push("rl.api_key_id IS NULL AND rl.user_id IS NOT NULL");
	}
	if (filters.status !== undefined && filters.status !== null && filters.status !== "") {
		conditions.push("rl.status = ?");
		bindings.push(Number(filters.status));
	}

	const where = conditions.length > 0
		? `WHERE ${conditions.join(" AND ")}`
		: "";

	const { results } = await env.StudyPulseDB.prepare(
		`SELECT rl.id, rl.api_key_id, ak.name AS key_name,
		        rl.user_id, u.email AS user_email,
		        CASE WHEN rl.api_key_id IS NOT NULL THEN 'api_key' ELSE 'session' END AS call_method,
		        rl.request_time, rl.model, rl.provider,
		        rl.status, rl.latency_ms,
		        rl.prompt_tokens, rl.completion_tokens, rl.total_tokens,
		        rl.user_agent, rl.error_message
		   FROM request_logs rl
		   LEFT JOIN api_keys ak ON ak.id = rl.api_key_id
		   LEFT JOIN users u ON u.id = rl.user_id
		   ${where}
		  ORDER BY rl.request_time DESC
		  LIMIT 300`,
	)
		.bind(...bindings)
		.all();

	return results;
}

/**
 * 写入请求日志。
 * 仅在 AI 调用完成后调用（成功或失败都写）。
 *
 * @param {{ StudyPulseDB: D1Database }} env
 * @param {object} entry
 * @param {number} entry.api_key_id
 * @param {string} entry.model
 * @param {string} entry.provider
 * @param {number} entry.status
 * @param {number} [entry.latency_ms]
 * @param {number} [entry.prompt_tokens]
 * @param {number} [entry.completion_tokens]
 * @param {number} [entry.total_tokens]
 * @param {string} [entry.ip]
 * @param {string} [entry.user_agent]
 * @param {string} [entry.error_message]
 * @returns {Promise<void>}
 */
export async function writeRequestLog(env, entry) {
	await env.StudyPulseDB.prepare(
		`INSERT INTO request_logs
		   (api_key_id, user_id, model, provider, status, latency_ms,
		    prompt_tokens, completion_tokens, total_tokens, reasoning_tokens, points_charged,
		    ip, user_agent, error_message,
		    caller, requested_thinking, effective_thinking, routing_version,
		    fallback_used, fallback_reason, primary_model)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			entry.api_key_id ?? null,
			entry.user_id ?? null,
			entry.model ?? null,
			entry.provider ?? null,
			entry.status,
			entry.latency_ms ?? null,
			entry.prompt_tokens ?? null,
			entry.completion_tokens ?? null,
			entry.total_tokens ?? null,
			entry.reasoning_tokens ?? null,
			entry.points_charged ?? null,
			entry.ip ?? null,
			entry.user_agent ?? null,
			entry.error_message ?? null,
			entry.caller ?? null,
			entry.requested_thinking ?? null,
			entry.effective_thinking ?? null,
			entry.routing_version ?? null,
			entry.fallback_used ? 1 : 0,
			entry.fallback_reason ?? null,
			entry.primary_model ?? null,
		)
		.run();
}

// ────────────────────────────────────────────────────────────────────────────
// 用户管理
// ────────────────────────────────────────────────────────────────────────────

/**
 * 列出所有用户，支持筛选和搜索。
 */
export async function listUsers(env, filters = {}) {
	const conditions = [];
	const bindings = [];

	if (filters.search) {
		conditions.push("email LIKE ?");
		bindings.push(`%${filters.search}%`);
	}
	if (filters.role) {
		conditions.push("role = ?");
		bindings.push(filters.role);
	}
	if (filters.membership_type) {
		conditions.push("membership_type = ?");
		bindings.push(filters.membership_type);
	}

	const where = conditions.length > 0
		? `WHERE ${conditions.join(" AND ")}`
		: "";

	const { results } = await env.StudyPulseDB.prepare(
		`SELECT id, email, email_verified, role, membership_type,
		        membership_expires_at, status, created_at,
		        CASE WHEN (github_id IS NOT NULL AND github_id <> '')
		                  OR EXISTS (
			                  SELECT 1 FROM user_oauth_accounts oa
			                   WHERE oa.user_id = users.id AND oa.provider = 'github'
		                  )
		             THEN 1 ELSE 0 END AS github_bound,
				     CASE WHEN (password_hash IS NOT NULL AND password_hash <> '')
				                  OR EXISTS (
				                  SELECT 1 FROM user_credentials uc
				                   WHERE uc.user_id = users.id AND uc.password_hash <> ''
				                  )
				             THEN 1 ELSE 0 END AS password_set
				   ,CASE WHEN EXISTS (
				                  SELECT 1 FROM user_passkeys up
				                   WHERE up.user_id = users.id
				                  )
				             THEN 1 ELSE 0 END AS passkey_bound
				   ,(SELECT COUNT(*) FROM user_passkeys upc WHERE upc.user_id = users.id) AS passkey_count
		   FROM users
		   ${where}
		  ORDER BY created_at DESC
		  LIMIT 200`,
	)
		.bind(...bindings)
		.all();

	return results;
}

/**
 * 永久删除用户及其关联账户数据。管理员操作日志不删除，以保留审计记录。
 */
export async function deleteUserAccount(env, userId) {
	const user = await env.StudyPulseDB.prepare(
		"SELECT id, email, email_normalized, role FROM users WHERE id = ?",
	).bind(userId).first();
	if (!user) return { success: false, error: "User not found" };
	if (user.role === "admin") return { success: false, error: "Admin users cannot be deleted" };

	const db = env.StudyPulseDB;
	await db.batch([
		db.prepare("DELETE FROM request_logs WHERE user_id = ? OR api_key_id IN (SELECT id FROM api_keys WHERE user_id = ?)").bind(userId, userId),
		db.prepare("DELETE FROM usage_records WHERE user_id = ?").bind(userId),
		db.prepare("DELETE FROM api_keys WHERE user_id = ?").bind(userId),
		db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
		db.prepare("DELETE FROM user_credentials WHERE user_id = ?").bind(userId),
		db.prepare("DELETE FROM user_passkeys WHERE user_id = ?").bind(userId),
		db.prepare("DELETE FROM auth_challenges WHERE user_id = ?").bind(userId),
		db.prepare("DELETE FROM email_verification_codes WHERE email_normalized = ? OR lower(trim(email)) = ?").bind(user.email_normalized, user.email_normalized),
		db.prepare("DELETE FROM appeals WHERE user_id = ?").bind(userId),
		db.prepare("DELETE FROM bans WHERE user_id = ?").bind(userId),
		db.prepare("DELETE FROM blacklisted_emails WHERE lower(email) = ?").bind(user.email_normalized),
		db.prepare("DELETE FROM users WHERE id = ?").bind(userId),
	]);

	return { success: true, email: user.email };
}

/**
 * 获取用户详情（含统计）。
 */
export async function getUserDetail(env, userId) {
	const user = await env.StudyPulseDB.prepare(
		`SELECT id, email, email_verified, role, membership_type,
		        membership_expires_at, status, github_id, username, avatar_url,
		        created_at, updated_at,
		        CASE WHEN (github_id IS NOT NULL AND github_id <> '')
		                  OR EXISTS (
			                  SELECT 1 FROM user_oauth_accounts oa
			                   WHERE oa.user_id = users.id AND oa.provider = 'github'
		                  )
		             THEN 1 ELSE 0 END AS github_bound,
				     CASE WHEN (password_hash IS NOT NULL AND password_hash <> '')
				                  OR EXISTS (
				                  SELECT 1 FROM user_credentials uc
				                   WHERE uc.user_id = users.id AND uc.password_hash <> ''
				                  )
				             THEN 1 ELSE 0 END AS password_set
				   ,CASE WHEN EXISTS (
				                  SELECT 1 FROM user_passkeys up
				                   WHERE up.user_id = users.id
				                  )
				             THEN 1 ELSE 0 END AS passkey_bound
				   ,(SELECT COUNT(*) FROM user_passkeys upc WHERE upc.user_id = users.id) AS passkey_count
				   ,(SELECT MAX(last_used_at) FROM user_passkeys upl WHERE upl.user_id = users.id) AS passkey_last_used_at
		   FROM users
		  WHERE id = ?`,
	)
		.bind(userId)
		.first();

	if (!user) return null;

	const [totalRequests, totalTokens, apiKeysCount] = await Promise.all([
		env.StudyPulseDB.prepare(
			"SELECT COUNT(*) AS count FROM usage_records WHERE user_id = ?",
		).bind(userId).first("count"),
		env.StudyPulseDB.prepare(
			"SELECT COALESCE(SUM(total_tokens), 0) AS count FROM usage_records WHERE user_id = ?",
		).bind(userId).first("count"),
		env.StudyPulseDB.prepare(
			"SELECT COUNT(*) AS count FROM api_keys WHERE user_id = ?",
		).bind(userId).first("count"),
	]);

	return {
		...user,
		stats: {
			totalRequests: totalRequests ?? 0,
			totalTokens: totalTokens ?? 0,
			apiKeysCount: apiKeysCount ?? 0,
		},
	};
}

/**
 * 获取用户的 Session 列表。
 */
export async function getUserSessions(env, userId) {
	const { results } = await env.StudyPulseDB.prepare(
		`SELECT id, user_id, expires_at, last_used_at, created_at, revoked_at,
		        device_name, user_agent, ip_address
		   FROM sessions
		  WHERE user_id = ?
		  ORDER BY created_at DESC`,
	)
		.bind(userId)
		.all();

	return results;
}

/**
 * 撤销用户的全部登录 Session，让该账号的所有设备立即下线。
 * Session 记录保留在数据库中，便于审计和排查。
 *
 * @param {{ StudyPulseDB: D1Database }} env
 * @param {string} userId
 * @returns {Promise<number>} 本次新撤销的 Session 数量
 */
export async function revokeUserSessions(env, userId) {
	const { meta } = await env.StudyPulseDB.prepare(
		`UPDATE sessions
		    SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP)
		  WHERE user_id = ?
		    AND revoked_at IS NULL`,
	)
		.bind(userId)
		.run();

	return meta.changes;
}

/**
 * 获取用户的 API Key 列表（不含 key_hash）。
 */
export async function getUserApiKeys(env, userId) {
	const { results } = await env.StudyPulseDB.prepare(
		`SELECT id, name, enabled, request_count, request_limit,
		        limit_type, token_count,
		        user_id, notes, expires_at, created_at, last_used_at
		   FROM api_keys
		  WHERE user_id = ?
		  ORDER BY created_at DESC`,
	)
		.bind(userId)
		.all();

	return results;
}

/**
 * 获取用户使用统计。
 */
export async function getUserUsageStats(env, userId) {
	const todayUTC8 = new Date(
		new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" }),
	);
	todayUTC8.setHours(0, 0, 0, 0);
	const todayStart = todayUTC8.toISOString();
	const monthStart = new Date(todayUTC8.getFullYear(), todayUTC8.getMonth(), 1).toISOString();

	const [dailyRequests, monthlyTokens] = await Promise.all([
		env.StudyPulseDB.prepare(
			"SELECT COUNT(*) AS count FROM usage_records WHERE user_id = ? AND created_at >= ?",
		).bind(userId, todayStart).first("count"),
		env.StudyPulseDB.prepare(
			"SELECT COALESCE(SUM(total_tokens), 0) AS total FROM usage_records WHERE user_id = ? AND created_at >= ?",
		).bind(userId, monthStart).first("total"),
	]);

	return {
		dailyRequests: dailyRequests ?? 0,
		monthlyTokens: monthlyTokens ?? 0,
	};
}

/**
 * 创建新用户（管理后台使用）。
 * 管理员创建的用户默认为已认证（email_verified=1），跳过邮箱验证流程。
 *
 * @param {{ StudyPulseDB: D1Database }} env
 * @param {{ email: string, role?: string, membership_type?: string }} params
 * @returns {Promise<{id: string, email: string}>}
 */
export async function createUser(env, params) {
	const email = params.email.trim().toLowerCase();

	// 检查邮箱是否已存在
	const existing = await env.StudyPulseDB.prepare(
		"SELECT id FROM users WHERE email_normalized = ?",
	)
		.bind(email.trim().toLowerCase())
		.first();

	if (existing) {
		throw new Error("DUPLICATE_EMAIL");
	}

	const userId = crypto.randomUUID();
	const role = params.role || "user";
	const membership = params.membership_type || "free";

	await env.StudyPulseDB.prepare(
		`INSERT INTO users (id, email, email_normalized, email_verified, role, membership_type)
		 VALUES (?, ?, ?, 1, ?, ?)`,
	)
		.bind(userId, email, email, role, membership)
		.run();

	return { id: userId, email };
}

/**
 * 更新用户信息。
 */
export async function updateUser(env, userId, fields) {
	const setClauses = ["updated_at = CURRENT_TIMESTAMP"];
	const bindings = [];

	if (fields.role !== undefined) {
		setClauses.push("role = ?");
		bindings.push(fields.role);
	}
	if (fields.membership_type !== undefined) {
		setClauses.push("membership_type = ?");
		bindings.push(fields.membership_type);
	}
	if (fields.membership_expires_at !== undefined) {
		setClauses.push("membership_expires_at = ?");
		bindings.push(fields.membership_expires_at);
	}

	if (bindings.length === 0) return false;

	bindings.push(userId);

	const { meta } = await env.StudyPulseDB.prepare(
		`UPDATE users SET ${setClauses.join(", ")} WHERE id = ?`,
	)
		.bind(...bindings)
		.run();

	return meta.changes > 0;
}

// ────────────────────────────────────────────────────────────────────────────
// 管理员操作日志
// ────────────────────────────────────────────────────────────────────────────

/**
 * 写入管理员操作日志。
 */
export async function writeAdminLog(env, entry) {
	await env.StudyPulseDB.prepare(
		`INSERT INTO admin_logs (admin_user_id, action, target_user_id, details)
		 VALUES (?, ?, ?, ?)`,
	)
		.bind(
			entry.admin_user_id,
			entry.action,
			entry.target_user_id ?? null,
			entry.details ?? null,
		)
		.run();
}

/**
 * 查询管理员操作日志。
 */
export async function getAdminLogs(env, filters = {}) {
	const conditions = [];
	const bindings = [];

	if (filters.admin_user_id) {
		conditions.push("admin_user_id = ?");
		bindings.push(filters.admin_user_id);
	}
	if (filters.action) {
		conditions.push("action = ?");
		bindings.push(filters.action);
	}

	const where = conditions.length > 0
		? `WHERE ${conditions.join(" AND ")}`
		: "";

	const { results } = await env.StudyPulseDB.prepare(
		`SELECT id, admin_user_id, action, target_user_id, details, created_at
		   FROM admin_logs
		   ${where}
		  ORDER BY created_at DESC
		  LIMIT 200`,
	)
		.bind(...bindings)
		.all();

	return results;
}
