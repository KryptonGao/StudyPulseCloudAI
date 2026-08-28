/**
 * StudyPulse Cloud AI - 会员与额度管理
 *
 * 统一按 user_id 管理额度。用户 UI 使用 daily requests + monthly points。
 * Token 字段仍写入账本，供内部成本核算，不再作为用户配额。
 */

import { recordUsageRecord } from "../database/usage.js";

export async function getMembershipPlan(planId, env) {
	return env.StudyPulseDB.prepare(
		`SELECT id, name, daily_request_limit, monthly_token_limit, monthly_point_limit, available_models
		   FROM membership_plans
		  WHERE id = ?`,
	)
		.bind(planId)
		.first();
}

export async function checkUserQuota(userId, env) {
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

	if (user.role === "admin") {
		return { allowed: true };
	}

	let effectivePlan = user.membership_type;
	let planTransitionAt = null;

	if (effectivePlan !== "free" && user.membership_expires_at) {
		const now = new Date();
		const expiresAt = new Date(user.membership_expires_at);
		if (now >= expiresAt) {
			effectivePlan = "free";
			planTransitionAt = expiresAt;
		}
	}

	const plan = await getMembershipPlan(effectivePlan, env);
	if (!plan) {
		return { allowed: false, reason: "Membership plan not found" };
	}

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

	if (plan.monthly_point_limit !== null) {
		const monthStartDate = new Date(Date.UTC(dateParts.year, dateParts.month - 1, 1) - 8 * 60 * 60 * 1000);
		const monthStart = planTransitionAt && planTransitionAt > monthStartDate
			? planTransitionAt.toISOString()
			: monthStartDate.toISOString();

		const monthlyPoints = await env.StudyPulseDB.prepare(
			`SELECT COALESCE(SUM(points_charged), 0) AS total
			   FROM usage_records
			  WHERE user_id = ?
			    AND datetime(created_at) >= datetime(?)`,
		)
			.bind(userId, monthStart)
			.first("total");

		if (monthlyPoints >= plan.monthly_point_limit) {
			return { allowed: false, reason: "Monthly point limit exceeded" };
		}
	}

	return { allowed: true };
}

/**
 * @param {string} userId
 * @param {number|null} apiKeyId
 * @param {object} record
 * @param {{ StudyPulseDB: D1Database }} env
 */
export async function recordUsage(userId, apiKeyId, record, env) {
	await recordUsageRecord(env, {
		user_id: userId,
		api_key_id: apiKeyId ?? null,
		model: record?.model ?? null,
		provider: record?.provider ?? null,
		caller: record?.caller ?? null,
		requested_thinking: record?.requested_thinking ?? null,
		effective_thinking: record?.effective_thinking ?? null,
		input_tokens: record?.input_tokens ?? 0,
		output_tokens: record?.output_tokens ?? 0,
		total_tokens: record?.total_tokens ?? 0,
		reasoning_tokens: record?.reasoning_tokens ?? 0,
		points_charged: record?.points_charged ?? 0,
		pricing_version: record?.pricing_version ?? null,
		routing_version: record?.routing_version ?? null,
	});
}
