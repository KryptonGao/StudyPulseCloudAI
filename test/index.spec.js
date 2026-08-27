import { env, createExecutionContext, waitOnExecutionContext, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";
import { CHAT_MAX_BODY_BYTES, CHAT_MAX_CONTENT_ITEMS, CHAT_MAX_MESSAGE_CHARS } from "../src/chat-limits.js";
import { sha256Hex } from "../src/auth.js";

async function createUserApiKey({ membershipType = "free", requestKey = `sp_stream_${crypto.randomUUID()}` } = {}) {
	const userId = crypto.randomUUID();
	const keyHash = await sha256Hex(requestKey);
	await env.StudyPulseDB.prepare(
		`INSERT INTO users (id, email, email_normalized, email_verified, role, membership_type)
		 VALUES (?, ?, ?, 1, 'user', ?)`,
	).bind(userId, `${userId}@example.com`, `${userId}@example.com`, membershipType).run();
	await env.StudyPulseDB.prepare(
		`INSERT INTO api_keys (key_hash, name, user_id, enabled, request_limit)
		 VALUES (?, 'Stream quota regression key', ?, 1, NULL)`,
	).bind(keyHash, userId).run();
	return { userId, requestKey };
}

async function streamChat(requestKey, body) {
	return SELF.fetch("http://localhost/v1/chat", {
		method: "POST",
		headers: {
			"X-API-Key": requestKey,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
}

describe("StudyPulse Cloud AI v0.2-beta", () => {
	describe("GET / (health check)", () => {
		it("returns online status with service meta", async () => {
			const response = await SELF.fetch("http://localhost/");
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				success: true,
				service: "StudyPulse Cloud AI",
				version: "0.5-beta-github",
				status: "online",
			});
		});
	});

	describe("POST /v1/chat auth failures", () => {
		it("returns 401 when Authorization header is missing", async () => {
			const response = await SELF.fetch("http://localhost/v1/chat", {
				method: "POST",
			});
			expect(response.status).toBe(401);
			expect(await response.json()).toEqual({ error: "Missing API Key or Session Token" });
		});

		it("returns 403 when API Key is invalid", async () => {
			const response = await SELF.fetch("http://localhost/v1/chat", {
				method: "POST",
				headers: { Authorization: "Bearer test" },
			});
			expect(response.status).toBe(403);
			expect(await response.json()).toEqual({ error: "Invalid API Key" });
		});
	});

	describe("POST /v1/chat application limits", () => {
		it("rejects a declared request body above the application limit before JSON parsing", async () => {
			const requestBody = JSON.stringify({ message: "small" });
			const request = new Request("http://localhost/v1/chat", {
				method: "POST",
				headers: {
					"X-API-Key": "sp_beta_test001",
					"Content-Type": "application/json",
					"Content-Length": String(CHAT_MAX_BODY_BYTES + 1),
				},
				body: requestBody,
			});
			const response = await worker.fetch(request, env, createExecutionContext());

			expect(response.status).toBe(413);
			expect(await response.json()).toEqual({ error: "Request body too large" });
		});

		it("rejects an oversized text message", async () => {
			const response = await SELF.fetch("http://localhost/v1/chat", {
				method: "POST",
				headers: {
					"X-API-Key": "sp_beta_test001",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ message: "x".repeat(CHAT_MAX_MESSAGE_CHARS + 1) }),
			});

			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({ error: "Message too long" });
		});

		it("rejects an oversized multimodal content array", async () => {
			const response = await SELF.fetch("http://localhost/v1/chat", {
				method: "POST",
				headers: {
					"X-API-Key": "sp_beta_test001",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					content: Array.from({ length: CHAT_MAX_CONTENT_ITEMS + 1 }, () => ({
						type: "text",
						text: "x",
					})),
				}),
			});

			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({ error: "Too many content items" });
		});
	});

	describe("POST /v1/chat server config failures", () => {
		// 注：.dev.vars 已配置 MINIMAX_API_KEY（测试用假 Key），
		// 鉴权通过后会实际调用 MiniMax API，因 Key 无效返回 502
		it("returns 502 when MiniMax API key is invalid", async () => {
			const request = new Request("http://localhost/v1/chat", {
				method: "POST",
				headers: {
					Authorization: "Bearer sp_beta_test001",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ message: "你好" }),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);
			expect(response.status).toBe(502);
			const json = await response.json();
			expect(json.error).toBe("AI request failed");
		});
	});

	describe("POST /v1/chat stream access checks", () => {
		it("rejects streaming requests when the daily quota is exhausted", async () => {
			const { userId, requestKey } = await createUserApiKey();
			await env.StudyPulseDB.prepare(
				`INSERT INTO usage_records (user_id, total_tokens) VALUES ${Array.from({ length: 5 }, () => "(?, 0)").join(", ")}`,
			).bind(...Array(5).fill(userId)).run();

			const response = await streamChat(requestKey, { stream: true, message: "quota" });
			expect(response.status).toBe(429);
			expect(await response.json()).toEqual({ error: "Daily request limit exceeded" });
		});

		it("rejects streaming requests for models outside the membership plan", async () => {
			const { requestKey } = await createUserApiKey();

			const response = await streamChat(requestKey, {
				stream: true,
				model: "model-not-in-free-plan",
				message: "model access",
			});
			expect(response.status).toBe(403);
			expect(await response.json()).toEqual({
				error: 'Model "model-not-in-free-plan" is not available on your plan',
			});
		});
	});
});
