import { describe, expect, it } from "vitest";
import { testModelConnectivity } from "../src/ai/connectivity.js";
import { PROVIDERS } from "../src/ai/models.js";
import { ProviderError } from "../src/providers/errors.js";

function mockRegistry(adapter) {
	return {
		get: () => adapter,
		isAvailable: () => adapter.isAvailable(),
	};
}

describe("testModelConnectivity", () => {
	it("rejects unknown models", async () => {
		const result = await testModelConnectivity("gpt-x", {});
		expect(result.ok).toBe(false);
		expect(result.status).toBe(400);
	});

	it("reports missing provider keys without calling upstream", async () => {
		const adapter = {
			providerId: PROVIDERS.MIMO,
			isAvailable: () => false,
			createChatCompletion: async () => {
				throw new Error("should not run");
			},
		};
		const result = await testModelConnectivity("mimo-v2.5", {}, { registry: mockRegistry(adapter) });
		expect(result.ok).toBe(false);
		expect(result.status).toBe(503);
		expect(result.error).toMatch(/API key/);
	});

	it("returns latency when the adapter replies", async () => {
		const adapter = {
			providerId: PROVIDERS.HY3,
			isAvailable: () => true,
			async createChatCompletion() {
				return { reply: "pong", upstreamModel: "hy3-free" };
			},
		};
		const result = await testModelConnectivity("hy3", { HY3_API_KEY: "x" }, { registry: mockRegistry(adapter) });
		expect(result.ok).toBe(true);
		expect(result.provider).toBe("hy3");
		expect(result.upstreamModel).toBe("hy3-free");
		expect(result.replyPreview).toBe("pong");
	});

	it("redacts secrets from provider errors", async () => {
		const adapter = {
			providerId: PROVIDERS.MINIMAX,
			isAvailable: () => true,
			async createChatCompletion() {
				throw new ProviderError("minimax API error 401: Bearer sk-secret-token-value failed", {
					status: 401,
					provider: PROVIDERS.MINIMAX,
				});
			},
		};
		const result = await testModelConnectivity("minimax-m3", { MINIMAX_API_KEY: "x" }, {
			registry: mockRegistry(adapter),
		});
		expect(result.ok).toBe(false);
		expect(result.error).not.toContain("sk-secret");
		expect(result.error).toContain("[redacted]");
	});
});
