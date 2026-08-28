import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { executeChat } from "../src/ai/gateway.js";
import { normalizeChatRequest } from "../src/chat/normalize.js";
import { PROVIDERS } from "../src/ai/models.js";
import { ProviderError } from "../src/providers/errors.js";
import { sha256Hex } from "../src/auth.js";

function jsonAdapter(providerId, reply, usage) {
	return {
		providerId,
		isAvailable() {
			return true;
		},
		async createChatCompletion({ stream }) {
			if (stream) {
				const body = [
					`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\n`,
					`data: ${JSON.stringify({ usage })}\n\n`,
					"data: [DONE]\n\n",
				].join("");
				return {
					response: new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
					model: providerId === "minimax" ? "minimax-m3" : providerId === "hy3" ? "hy3" : "mimo-v2.5",
					provider: providerId,
				};
			}
			return {
				reply,
				usage: {
					prompt_tokens: usage.prompt_tokens,
					completion_tokens: usage.completion_tokens,
					total_tokens: usage.total_tokens,
					reasoning_tokens: usage.reasoning_tokens || 0,
					cached_tokens: 0,
					missing: false,
				},
				model: providerId === "minimax" ? "minimax-m3" : providerId === "hy3" ? "hy3" : "mimo-v2.5",
				provider: providerId,
			};
		},
	};
}

function failingAdapter(providerId, { status, retryable, message }) {
	return {
		providerId,
		isAvailable() {
			return true;
		},
		async createChatCompletion() {
			throw new ProviderError(message || `${providerId} failed`, {
				status,
				retryable,
				provider: providerId,
			});
		},
	};
}

function registryOf(adapters) {
	const byId = new Map(adapters.map((adapter) => [adapter.providerId, adapter]));
	return {
		get: (id) => byId.get(id),
		isAvailable: (id) => Boolean(byId.get(id)?.isAvailable()),
		hasAny: () => adapters.some((adapter) => adapter.isAvailable()),
	};
}

async function seedUser() {
	const userId = crypto.randomUUID();
	const requestKey = `sp_beta_${crypto.randomUUID().slice(0, 8)}`;
	const keyHash = await sha256Hex(requestKey);
	await env.StudyPulseDB.prepare(
		`INSERT INTO users (id, email, email_normalized, email_verified, role, membership_type)
		 VALUES (?, ?, ?, 1, 'user', 'plus')`,
	)
		.bind(userId, `${userId}@example.com`, `${userId}@example.com`)
		.run();
	const row = await env.StudyPulseDB.prepare(
		`INSERT INTO api_keys (key_hash, name, user_id, enabled, request_limit)
		 VALUES (?, 'compat', ?, 1, NULL) RETURNING id`,
	)
		.bind(keyHash, userId)
		.first();
	return { userId, apiKeyId: row.id };
}

describe("chat compatibility and gateway", () => {
	it("accepts a legacy body without studypulse metadata", async () => {
		const { userId, apiKeyId } = await seedUser();
		const usage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
		const ctx = createExecutionContext();
		const response = await executeChat({
			request: new Request("http://localhost/v1/chat", { method: "POST" }),
			env,
			ctx,
			auth: { userId, apiKeyId },
			normalized: normalizeChatRequest({ message: "你好" }),
			plan: "plus",
			startTime: Date.now(),
			clientIp: "",
			clientUa: "",
			registry: registryOf([jsonAdapter(PROVIDERS.MIMO, "ok", usage)]),
		});
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ success: true, data: { reply: "ok" } });
		const row = await env.StudyPulseDB.prepare(
			`SELECT caller, points_charged, pricing_version FROM usage_records WHERE user_id = ?`,
		)
			.bind(userId)
			.first();
		expect(row.caller).toBe("Legacy");
		expect(row.points_charged).toBeGreaterThan(0);
		expect(row.pricing_version).toBe("2026-08-v1");
	});

	it("ignores a client-specified model for official routing", async () => {
		const { userId, apiKeyId } = await seedUser();
		const usage = { prompt_tokens: 8, completion_tokens: 8, total_tokens: 16 };
		const ctx = createExecutionContext();
		const response = await executeChat({
			request: new Request("http://localhost/v1/chat", { method: "POST" }),
			env,
			ctx,
			auth: { userId, apiKeyId },
			normalized: normalizeChatRequest({
				message: "hi",
				model: "model-not-in-free-plan",
				studypulse: { caller: "StudySuggestions", thinking: "off" },
			}),
			plan: "free",
			startTime: Date.now(),
			clientIp: "",
			clientUa: "",
			registry: registryOf([jsonAdapter(PROVIDERS.MIMO, "routed", usage)]),
		});
		expect(response.status).toBe(200);
	});

	it("falls back once on retryable provider errors", async () => {
		const { userId, apiKeyId } = await seedUser();
		const usage = { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 };
		const ctx = createExecutionContext();
		const response = await executeChat({
			request: new Request("http://localhost/v1/chat", { method: "POST" }),
			env,
			ctx,
			auth: { userId, apiKeyId },
			normalized: normalizeChatRequest({
				message: "grade this",
				studypulse: { caller: "MistakeAI", thinking: "auto" },
			}),
			plan: "plus",
			startTime: Date.now(),
			clientIp: "",
			clientUa: "",
			registry: registryOf([
				failingAdapter(PROVIDERS.HY3, { status: 503, retryable: true, message: "hy3 down" }),
				jsonAdapter(PROVIDERS.MINIMAX, "fallback-ok", usage),
			]),
		});
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		const log = await env.StudyPulseDB.prepare(
			`SELECT fallback_used, primary_model, model FROM request_logs WHERE user_id = ? ORDER BY id DESC LIMIT 1`,
		)
			.bind(userId)
			.first();
		expect(log.fallback_used).toBe(1);
		expect(log.primary_model).toBe("hy3");
		expect(log.model).toBe("minimax-m3");
	});

	it("skips same-host OpenCode fallback and uses MiniMax after 429", async () => {
		const { userId, apiKeyId } = await seedUser();
		const usage = { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 };
		const ctx = createExecutionContext();
		const response = await executeChat({
			request: new Request("http://localhost/v1/chat", { method: "POST" }),
			env,
			ctx,
			auth: { userId, apiKeyId },
			normalized: normalizeChatRequest({
				message: "ping",
				studypulse: { caller: "Legacy", thinking: "off" },
			}),
			plan: "plus",
			startTime: Date.now(),
			clientIp: "",
			clientUa: "",
			registry: registryOf([
				failingAdapter(PROVIDERS.MIMO, { status: 429, retryable: true, message: "rate limit" }),
				failingAdapter(PROVIDERS.HY3, { status: 429, retryable: true, message: "rate limit hy3" }),
				jsonAdapter(PROVIDERS.MINIMAX, "minimax-ok", usage),
			]),
		});
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		const log = await env.StudyPulseDB.prepare(
			`SELECT fallback_used, primary_model, model FROM request_logs WHERE user_id = ? ORDER BY id DESC LIMIT 1`,
		)
			.bind(userId)
			.first();
		expect(log.fallback_used).toBe(1);
		expect(log.primary_model).toBe("mimo-v2.5");
		expect(log.model).toBe("minimax-m3");
	});

	it("does not fall back on 400 errors", async () => {
		const { userId, apiKeyId } = await seedUser();
		const ctx = createExecutionContext();
		const response = await executeChat({
			request: new Request("http://localhost/v1/chat", { method: "POST" }),
			env,
			ctx,
			auth: { userId, apiKeyId },
			normalized: normalizeChatRequest({
				message: "bad",
				studypulse: { caller: "MistakeAI", thinking: "auto" },
			}),
			plan: "plus",
			startTime: Date.now(),
			clientIp: "",
			clientUa: "",
			registry: registryOf([
				failingAdapter(PROVIDERS.HY3, { status: 400, retryable: false, message: "malformed" }),
				jsonAdapter(PROVIDERS.MINIMAX, "should-not-run", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
			]),
		});
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(502);
		const count = await env.StudyPulseDB.prepare(
			`SELECT COUNT(*) AS n FROM usage_records WHERE user_id = ?`,
		)
			.bind(userId)
			.first("n");
		expect(count).toBe(0);
	});

	it("records 0 points when stream usage is missing", async () => {
		const { userId, apiKeyId } = await seedUser();
		const ctx = createExecutionContext();
		const adapter = {
			providerId: PROVIDERS.MIMO,
			isAvailable: () => true,
			async createChatCompletion() {
				return {
					response: new Response("data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n\n", {
						headers: { "Content-Type": "text/event-stream" },
					}),
					model: "mimo-v2.5",
					provider: PROVIDERS.MIMO,
				};
			},
		};
		const response = await executeChat({
			request: new Request("http://localhost/v1/chat", { method: "POST" }),
			env,
			ctx,
			auth: { userId, apiKeyId },
			normalized: normalizeChatRequest({ message: "stream", stream: true }),
			plan: "plus",
			startTime: Date.now(),
			clientIp: "",
			clientUa: "",
			registry: registryOf([adapter]),
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("text/event-stream");
		await waitOnExecutionContext(ctx);
		const row = await env.StudyPulseDB.prepare(
			`SELECT points_charged, total_tokens FROM usage_records WHERE user_id = ?`,
		)
			.bind(userId)
			.first();
		expect(row.points_charged).toBe(0);
		expect(row.total_tokens).toBe(0);
	});
});
