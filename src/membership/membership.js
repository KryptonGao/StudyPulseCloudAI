/**
 * StudyPulse Cloud AI - 会员与额度管理
 *
 * 统一按 user_id 管理额度。两种入口统一流程：
 *   Session 用户：session → user_id → membership → quota
 *   API Key 用户（绑定用户）：api_key → user_id → membership → quota
 *   API Key 用户（未绑定用户）：走 api_keys 表自身 quota（不改动）
 *
 * 避免双重额度限制：
 *   - authenticate() 仅负责 Key 校验、存在、禁用、过期
 *   - 绑定用户的 API Key：设置 request_limit=NULL，额度由 checkUserQuota() 统一管理
 *   - 旧匿名 API Key：保留 request_limit 值，由 authenticate() 内部检查
 */

// ────────────────────────────────────────────────────────────────────────────
// 会员计划查询
// ────────────────────────────────────────────────────────────────────────────

/**
 * 获取会员计划配置。
 * @param {string} planId - 'free' | 'plus' | 'pro'
 * @param {{ StudyPulseDB: D1Database }} env
 * @returns {Promise<object|null>}
 */
export async function getMembershipPlan(planId, env) {
	return env.StudyPulseDB.prepare(
		`SELECT id, name, daily_request_limit, monthly_token_limit, available_models
		   FROM membership_plans
		  WHERE id = ?`,
	)
		.bind(planId)
		.first();
}

// ────────────────────────────────────────────────────────────────────────────
// 额度检查
// ────────────────────────────────────────────────────────────────────────────

/**
 * 检查用户是否有可用额度。
 *
 * @param {string} userId - users.id
 * @param {{ StudyPulseDB: D1Database }} env
 * @returns {Promise<{allowed: boolean, reason?: string}>}
 */
export async function checkUserQuota(userId, env) {
	// 1. 查用户角色和会员信息
	const user = await env.StudyPulseDB.prepare(
		`SELECT role, membership_type, membership_expires_at
		   FROM users
		  WHERE id = ?`,
	)
		.bind(userId)
		.first();

	if (!user) {
		return { allowed: false, reason: "User not found" };
	}

	// 2. admin 跳过额度检查
	if (user.role === "admin") {
		return { allowed: true };
	}

	// 3. 确定有效会员等级
	let effectivePlan = user.membership_type;
	let planTransitionAt = null;

	if (effectivePlan !== "free" && user.membership_expires_at) {
		const now = new Date();
		const expiresAt = new Date(user.membership_expires_at);
		if (now >= expiresAt) {
			// 运行时降级为 free（不写库）。新额度只统计降级后的用量，
			// 避免将同一周期内原会员套餐的用量计入 Free 额度。
			effectivePlan = "free";
			planTransitionAt = expiresAt;
		}
	}

	// 4. 查 membership_plans 获取限额
	const plan = await getMembershipPlan(effectivePlan, env);
	if (!plan) {
		return { allowed: false, reason: "Membership plan not found" };
	}

	// 5. 查当日请求数（按 UTC+8 自然日）
	const nowParts = new Intl.DateTimeFormat("en-US", {
		timeZone: "Asia/Shanghai",
		year: "numeric",
		month: "numeric",
		day: "numeric",
	}).formatToParts(new Date());
	const dateParts = Object.fromEntries(
		nowParts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]),
	);
	const todayStartDate = new Date(Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day) - 8 * 60 * 60 * 1000);
	const todayStart = todayStartDate.toISOString();

	if (plan.daily_request_limit !== null) {
		const dailyQuotaStart = planTransitionAt && planTransitionAt > todayStartDate
			? planTransitionAt.toISOString()
			: todayStart;
		const dailyCount = await env.StudyPulseDB.prepare(
			`SELECT COUNT(*) AS count
			   FROM usage_records
			  WHERE user_id = ?
			    AND datetime(created_at) >= datetime(?)`,
		)
			.bind(userId, dailyQuotaStart)
			.first("count");

		if (dailyCount >= plan.daily_request_limit) {
			return { allowed: false, reason: "Daily request limit exceeded" };
		}
	}

	// 6. 查当月 Token 消耗
	if (plan.monthly_token_limit !== null) {
		const monthStartDate = new Date(Date.UTC(dateParts.year, dateParts.month - 1, 1) - 8 * 60 * 60 * 1000);
		const monthStart = planTransitionAt && planTransitionAt > monthStartDate
			? planTransitionAt.toISOString()
			: monthStartDate.toISOString();

		const monthlyTokens = await env.StudyPulseDB.prepare(
			`SELECT COALESCE(SUM(total_tokens), 0) AS total
			   FROM usage_records
			  WHERE user_id = ?
			    AND datetime(created_at) >= datetime(?)`,
		)
			.bind(userId, monthStart)
			.first("total");

		if (monthlyTokens >= plan.monthly_token_limit) {
			return { allowed: false, reason: "Monthly token limit exceeded" };
		}
	}

	return { allowed: true };
}

// ────────────────────────────────────────────────────────────────────────────
// 用量记录
// ────────────────────────────────────────────────────────────────────────────

/**
 * 写入 usage_records。
 *
 * 三种情况：
 *   - Session 调用：user_id 有值, api_key_id=NULL
 *   - API Key 绑定用户：user_id 有值, api_key_id 有值
 *   - 旧 API Key 无用户：不写（调用方判断 userId 存在才调此函数）
 *
 * @param {string} userId
 * @param {number|null} apiKeyId
 * @param {string} model
 * @param {{ prompt_tokens?: number, completion_tokens?: number, total_tokens?: number }|null} usage
 * @param {{ StudyPulseDB: D1Database }} env
 * @returns {Promise<void>}
 */
export async function recordUsage(userId, apiKeyId, model, usage, env) {
	await env.StudyPulseDB.prepare(
		`INSERT INTO usage_records
		   (user_id, api_key_id, model, input_tokens, output_tokens, total_tokens)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			userId,
			apiKeyId ?? null,
			model ?? null,
			usage?.prompt_tokens ?? 0,
			usage?.completion_tokens ?? 0,
			usage?.total_tokens ?? 0,
		)
		.run();
}
