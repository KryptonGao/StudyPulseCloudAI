/**
 * StudyPulse Cloud AI - usage_records 写操作
 *
 * 独立模块，避免 index.js 直接拼 SQL。
 */

/**
 * 写入使用记录（仅在 user_id 存在时调用）。
 *
 * @param {{ StudyPulseDB: D1Database }} env
 * @param {object} entry
 */
export async function recordUsageRecord(env, entry) {
	await env.StudyPulseDB.prepare(
		`INSERT INTO usage_records
		   (user_id, api_key_id, model, provider, caller,
		    requested_thinking, effective_thinking,
		    input_tokens, output_tokens, total_tokens, reasoning_tokens,
		    points_charged, pricing_version, routing_version)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			entry.user_id,
			entry.api_key_id ?? null,
			entry.model ?? null,
			entry.provider ?? null,
			entry.caller ?? null,
			entry.requested_thinking ?? null,
			entry.effective_thinking ?? null,
			entry.input_tokens ?? 0,
			entry.output_tokens ?? 0,
			entry.total_tokens ?? 0,
			entry.reasoning_tokens ?? 0,
			entry.points_charged ?? 0,
			entry.pricing_version ?? null,
			entry.routing_version ?? null,
		)
		.run();
}
