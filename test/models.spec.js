import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";

import { encryptSecret, decryptSecret, keyHintFor } from "../src/security/secretbox.js";
import {
	validateModelPayload,
	slugifyModelId,
	toRoutingView,
	resolveModelConfig,
	getActiveModelConfigs,
	invalidateModelConfigCache,
} from "../src/ai/model-config.js";
import { routeChat } from "../src/ai/router.js";
import { createAdminModel, updateAdminModel, listAdminModels } from "../src/admin/models.js";
import { getPricingTable, listKnownModelIds } from "../src/billing/store.js";
import { testModelConnectivity } from "../src/ai/connectivity.js";

function uniqueModelId() {
	return `test-model-${crypto.randomUUID().slice(0, 8)}`;
}

describe("secretbox", () => {
	it("round-trips an API key without storing plaintext", async () => {
		const cipher = await encryptSecret("sk-live-abc123", env);
		expect(cipher).toMatch(/^v1\./);
		expect(cipher).not.toContain("sk-live-abc123");
		expect(await decryptSecret(cipher, env)).toBe("sk-live-abc123");
	});

	it("returns null for undecryptable or malformed payloads", async () => {
		const cipher = await encryptSecret("secret", env);
		expect(await decryptSecret(cipher, { MODEL_SECRET_ENCRYPTION_KEY: "another-secret" })).toBeNull();
		expect(await decryptSecret("garbage", env)).toBeNull();
		expect(await encryptSecret("", env)).toBeNull();
	});

	it("derives a safe hint", () => {
		expect(keyHintFor("sk-1234567890")).toBe("…7890");
		expect(keyHintFor("abc")).toBe("****");
		expect(keyHintFor("")).toBeNull();
	});
});

describe("validateModelPayload", () => {
	it("accepts an OpenAI-compatible model definition", () => {
		const parsed = validateModelPayload({
			display_name: "DeepSeek V3",
			model_id: "deepseek-chat",
			provider: "openai-compat",
			base_url: "https://api.deepseek.com/v1/",
			api_key: "sk-test",
			purposes: ["chat"],
			capabilities: { streaming: true, thinking: false, vision: false },
			priority: 5,
		}, { partial: false });
		expect(parsed.error).toBeUndefined();
		expect(parsed.fields.base_url).toBe("https://api.deepseek.com/v1");
		expect(parsed.fields.provider).toBe("openai-compat");
	});

	it("rejects unknown purposes and bad urls", () => {
		expect(validateModelPayload({
			display_name: "x", model_id: "y", base_url: "https://a.com", purposes: ["nope"],
		}, { partial: false }).error).toMatch(/purposes/);
		expect(validateModelPayload({
			display_name: "x", model_id: "y", base_url: "ftp://a.com", purposes: ["chat"],
		}, { partial: false }).error).toMatch(/http/);
	});

	it("supports partial updates", () => {
		const parsed = validateModelPayload({ priority: 3 }, { partial: true });
		expect(parsed.error).toBeUndefined();
		expect(parsed.fields.priority).toBe(3);
	});
});

describe("dynamic routing", () => {
	const base = { caller: "HomeAsk-Answer", requestedThinking: "auto", plan: "plus" };
	const mimo = {
		id: "mimo-v2.5", provider: "mimo", purposes: ["light"],
		capabilities: { streaming: true, thinking: false, vision: false },
		priority: 10, minPlan: "free", contextLength: 0, baseURL: "https://a.example/v1", host: "a.example",
	};
	const hy3 = {
		id: "hy3", provider: "hy3", purposes: ["chat"],
		capabilities: { streaming: true, thinking: true, vision: false },
		priority: 10, minPlan: "free", contextLength: 0, baseURL: "https://a.example/v1", host: "a.example",
	};
	const m3 = {
		id: "minimax-m3", provider: "minimax", purposes: ["chat", "reasoning", "vision"],
		capabilities: { streaming: true, thinking: true, vision: true },
		priority: 20, minPlan: "plus", contextLength: 0, baseURL: "https://b.example/v1", host: "b.example",
	};

	it("sends chat callers to the built-in HY3 with MiniMax as fallback", () => {
		const routed = routeChat(base, [mimo, hy3, m3]);
		expect(routed.model).toBe("hy3");
		expect(routed.fallbackModel).toBe("minimax-m3");
	});

	it("puts a new high-priority model for the same purpose at the top of the pool", () => {
		const newcomer = {
			id: "deepseek-v3", provider: "openai-compat", purposes: ["chat"],
			capabilities: { streaming: true, thinking: true, vision: false },
			priority: 5, minPlan: "free", contextLength: 0, baseURL: "https://c.example/v1", host: "c.example",
		};
		const routed = routeChat(base, [mimo, hy3, m3, newcomer]);
		expect(routed.model).toBe("deepseek-v3");
		expect(routed.chain.map((c) => c.id)).toEqual(["deepseek-v3", "hy3", "minimax-m3", "mimo-v2.5"]);
	});

	it("excludes disabled or plan-gated models from the candidate pool", () => {
		const free = routeChat({ ...base, plan: "free" }, [hy3, m3]);
		expect(free.chain.map((c) => c.id)).toEqual(["hy3"]);

		const gated = { ...hy3, minPlan: "pro" };
		expect(routeChat(base, [gated, m3]).model).toBe("minimax-m3");
	});

	it("routes vision requests only to vision-capable models, exempt from min_plan", () => {
		const routed = routeChat({ ...base, plan: "free", hasImages: true }, [mimo, hy3, m3]);
		expect(routed.model).toBe("minimax-m3");
		expect(routed.chain.map((c) => c.id)).toEqual(["minimax-m3"]);
	});

	it("upgrades thinking requests to thinking-capable models", () => {
		const routed = routeChat({
			caller: "LLMChat", requestedThinking: "on", plan: "pro",
		}, [mimo, hy3, m3]);
		expect(routed.model).toBe("hy3");
		expect(routed.effectiveThinking).toBe("on");
	});

	it("keeps heavy light-caller prompts in the chat pool", () => {
		const routed = routeChat({
			caller: "StudySuggestions", requestedThinking: "auto", plan: "plus",
			estimatedInputTokens: 9000, messageCount: 2,
		}, [mimo, hy3, m3]);
		expect(routed.model).toBe("hy3");
		expect(routed.reason).toContain("heavy_prompt_upgrade_chat");
	});

	it("respects context length when configured", () => {
		const small = { ...hy3, contextLength: 1000 };
		const routed = routeChat({
			...base, estimatedInputTokens: 4000,
		}, [small, m3]);
		expect(routed.model).toBe("minimax-m3");
	});
});

describe("admin model service", () => {
	it("creates an encrypted model, participates in pricing, and tests connectivity", async () => {
		const result = await createAdminModel(env, {
			display_name: "Test GPT",
			model_id: "gpt-test",
			provider: "openai-compat",
			base_url: "https://upstream.test/v1",
			api_key: "sk-super-secret-key",
			purposes: ["chat"],
			capabilities: { streaming: true, thinking: false, vision: false },
			priority: 1,
			rates: { input: 15, output: 45, reasoning: 45, cache: 2, multiplier: 1 },
		});
		expect(result.error).toBeUndefined();
		expect(result.model.id).toBe("gpt-test");
		expect(result.model.keyConfigured).toBe(true);
		expect(result.model.keySource).toBe("encrypted");
		expect(JSON.stringify(result.model)).not.toContain("sk-super-secret-key");

		// D1 stores ciphertext only
		const row = await env.StudyPulseDB.prepare("SELECT api_key_cipher, key_hint FROM ai_models WHERE id = ?")
			.bind(result.model.id).first();
		expect(row.api_key_cipher).toMatch(/^v1\./);
		expect(row.api_key_cipher).not.toContain("sk-super-secret-key");
		expect(row.key_hint).toBe("…-key");

		// Pricing table picks up the dynamic model with its own rates
		invalidateModelConfigCache();
		const known = await listKnownModelIds(env);
		expect(known).toContain(result.model.id);
		const table = await getPricingTable(env);
		expect(table[result.model.id].input).toBe(15);

		// Connectivity test decrypts the key and hits the configured upstream
		const requests = [];
		const ping = await testModelConnectivity(result.model.id, env, {
			fetchImpl: async (url, options) => {
				requests.push({ url, options });
				return new Response(JSON.stringify({
					choices: [{ message: { content: "pong" } }],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
				}), { status: 200 });
			},
		});
		expect(ping.ok).toBe(true);
		expect(ping.upstreamModel).toBe("gpt-test");
		expect(requests[0].options.headers.Authorization).toBe("Bearer sk-super-secret-key");

		// Router picks the new model for chat callers (priority 1)
		const routed = routeChat(
			{ caller: "HomeAsk-Answer", requestedThinking: "auto", plan: "plus" },
			toRoutingView(await getActiveModelConfigs(env)),
		);
		expect(routed.model).toBe(result.model.id);
	});

	it("updates priority and can disable a model", async () => {
		const id = uniqueModelId();
		const created = await createAdminModel(env, {
			display_name: "Temp Model",
			model_id: "temp-model",
			base_url: "https://upstream.test/v1",
			api_key: "sk-x",
			purposes: ["light"],
			priority: 2,
		});
		expect(created.error).toBeUndefined();
		const modelId = created.model.id;

		const updated = await updateAdminModel(env, modelId, { priority: 900, enabled: false });
		expect(updated.error).toBeUndefined();
		expect(updated.model.priority).toBe(900);
		expect(updated.model.enabled).toBe(false);

		const configs = await getActiveModelConfigs(env);
		const view = toRoutingView(configs);
		expect(view.find((m) => m.id === modelId)).toBeUndefined();
	});

	it("rejects duplicate ids and unknown fields", async () => {
		const dup = await createAdminModel(env, {
			display_name: "Dupe", model_id: "x", base_url: "https://a.test", internal_id: "hy3",
			purposes: ["chat"],
		});
		expect(dup.error).toMatch(/exists/);
		const bad = await createAdminModel(env, {
			display_name: "Bad", model_id: "y", base_url: "https://a.test", purposes: ["chat"], provider: "nope",
		});
		expect(bad.error).toMatch(/provider/);
	});

	it("lists admin models without leaking key material", async () => {
		const { models } = await listAdminModels(env);
		expect(models.map((m) => m.id)).toEqual(expect.arrayContaining(["mimo-v2.5", "hy3", "minimax-m3"]));
		for (const model of models) {
			expect(model.keySource === "encrypted" || model.keySource?.startsWith("env:") || model.keySource === "none").toBe(true);
		}
	});

	it("resolves built-in models even without DB rows", async () => {
		const mimo = await resolveModelConfig("mimo-v2.5", {});
		expect(mimo.provider).toBe("mimo");
		expect(mimo.upstreamModel).toBe("mimo-v2.5-free");
		expect(await resolveModelConfig("does-not-exist", {})).toBeNull();
	});
});
