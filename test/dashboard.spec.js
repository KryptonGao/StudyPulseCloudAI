import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createSession } from "../src/auth/session.js";
import { checkUserQuota } from "../src/membership/membership.js";

describe("user dashboard usage semantics", () => {
	it("separates usage from an expired plan from the current Free quota period", async () => {
		const userId = crypto.randomUUID();
		const expiredAt = new Date(Date.now() - 2 * 60 * 1000).toISOString();
		const beforeExpiry = new Date(Date.now() - 3 * 60 * 1000).toISOString();
		const afterExpiry = new Date(Date.now() - 60 * 1000).toISOString();
		await env.StudyPulseDB.prepare(
			`INSERT INTO users (id,email,email_verified,membership_type,membership_expires_at)
			 VALUES (?,?,1,'pro',?)`,
		).bind(userId, `dashboard-${userId}@example.com`, expiredAt).run();
		await env.StudyPulseDB.prepare(
			`INSERT INTO usage_records (user_id,input_tokens,output_tokens,total_tokens,created_at)
			 VALUES (?,?,?,?,?),(?,?,?,?,?)`,
		).bind(userId, 120000, 30000, 150000, beforeExpiry, userId, 800, 200, 1000, afterExpiry).run();

		const session = await createSession(userId, env);
		const response = await SELF.fetch("https://dash.studypulse.chenkai.space/api/user/dashboard", {
			headers: { Authorization: `Bearer ${session.token}` },
		});
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.data.subscription.effective_type).toBe("free");
		expect(body.data.usage.month.tokens).toBeGreaterThanOrEqual(151000);
		expect(body.data.usage.quota.month.tokens).toBe(1000);
		expect(body.data.usage.quota.month.starts_at).toBe(expiredAt);
		expect(body.data.usage.trend).toHaveLength(14);
		expect(await checkUserQuota(userId, env)).toEqual({ allowed: true });
	});
});
