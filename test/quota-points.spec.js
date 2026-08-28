import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { checkUserQuota } from "../src/membership/membership.js";

async function insertUser({ role = "user", membershipType = "free", expiresAt = null } = {}) {
	const userId = crypto.randomUUID();
	await env.StudyPulseDB.prepare(
		`INSERT INTO users (id, email, email_normalized, email_verified, role, membership_type, membership_expires_at)
		 VALUES (?, ?, ?, 1, ?, ?, ?)`,
	)
		.bind(userId, `${userId}@example.com`, `${userId}@example.com`, role, membershipType, expiresAt)
		.run();
	return userId;
}

describe("points quota", () => {
	it("blocks when daily request limit is exceeded", async () => {
		const userId = await insertUser();
		await env.StudyPulseDB.prepare(
			`INSERT INTO usage_records (user_id, total_tokens, points_charged) VALUES ${Array.from({ length: 5 }, () => "(?, 0, 0)").join(", ")}`,
		)
			.bind(...Array(5).fill(userId))
			.run();
		expect(await checkUserQuota(userId, env)).toEqual({
			allowed: false,
			reason: "Daily request limit exceeded",
		});
	});

	it("blocks when monthly points are exceeded", async () => {
		const userId = await insertUser();
		await env.StudyPulseDB.prepare(
			`INSERT INTO usage_records (user_id, total_tokens, points_charged) VALUES (?, 10, ?)`,
		)
			.bind(userId, 5000)
			.run();
		expect(await checkUserQuota(userId, env)).toEqual({
			allowed: false,
			reason: "Monthly point limit exceeded",
		});
	});

	it("lets admins bypass quota", async () => {
		const userId = await insertUser({ role: "admin", membershipType: "free" });
		await env.StudyPulseDB.prepare(
			`INSERT INTO usage_records (user_id, points_charged) VALUES (?, 999999)`,
		)
			.bind(userId)
			.run();
		expect(await checkUserQuota(userId, env)).toEqual({ allowed: true });
	});

	it("isolates paid-plan points after expiration", async () => {
		const expiredAt = new Date(Date.now() - 60 * 1000).toISOString();
		const before = new Date(Date.now() - 2 * 60 * 1000).toISOString();
		const userId = await insertUser({ membershipType: "pro", expiresAt: expiredAt });
		await env.StudyPulseDB.prepare(
			`INSERT INTO usage_records (user_id, points_charged, created_at) VALUES (?, ?, ?)`,
		)
			.bind(userId, 400000, before)
			.run();
		expect(await checkUserQuota(userId, env)).toEqual({ allowed: true });
	});
});
