import { describe, expect, it } from "vitest";
import { AI_MODELS } from "../src/ai/models.js";
import { canonicalizeCaller } from "../src/ai/callers.js";
import { routeChat } from "../src/ai/router.js";
import { ROUTING_VERSION } from "../src/ai/policies.js";
import { normalizeChatRequest } from "../src/chat/normalize.js";

describe("canonicalizeCaller", () => {
	it("maps client aliases to canonical names", () => {
		expect(canonicalizeCaller("AISimilarQuestion").caller).toBe("SimilarQuestion");
		expect(canonicalizeCaller("QuizGeneration").caller).toBe("AIQuiz");
		expect(canonicalizeCaller("AICoach-Conversation").caller).toBe("AICoach");
	});

	it("maps unknown callers to Legacy without throwing", () => {
		const result = canonicalizeCaller("NotARealCaller");
		expect(result.caller).toBe("Legacy");
		expect(result.known).toBe(false);
	});
});

describe("routeChat", () => {
	it("sends low-cost callers to MiMo with thinking off", () => {
		const routed = routeChat({ caller: "StudySuggestions", requestedThinking: "auto", plan: "plus" });
		expect(routed.model).toBe(AI_MODELS.MIMO_V25);
		expect(routed.effectiveThinking).toBe("off");
		expect(routed.routingVersion).toBe(ROUTING_VERSION);
	});

	it("sends MistakeAI to HY3", () => {
		const routed = routeChat({ caller: "MistakeAI", requestedThinking: "auto", plan: "plus" });
		expect(routed.model).toBe(AI_MODELS.HY3);
		expect(routed.effectiveThinking).toBe("auto");
		expect(routed.fallbackModel).toBe(AI_MODELS.MINIMAX_M3);
	});

	it("sends MistakeDebate to MiniMax", () => {
		const routed = routeChat({ caller: "MistakeDebate", requestedThinking: "on", plan: "plus" });
		expect(routed.model).toBe(AI_MODELS.MINIMAX_M3);
	});

	it("demotes designated MiniMax on free unless vision is required", () => {
		const debate = routeChat({
			caller: "MistakeDebate",
			requestedThinking: "on",
			plan: "free",
		});
		expect(debate.model).toBe(AI_MODELS.HY3);

		const vision = routeChat({
			caller: "MistakeDebate",
			requestedThinking: "off",
			hasImages: true,
			plan: "free",
		});
		expect(vision.model).toBe(AI_MODELS.MINIMAX_M3);
	});

	it("forces MiniMax when images are present", () => {
		const routed = routeChat({
			caller: "StudySuggestions",
			requestedThinking: "off",
			hasImages: true,
			plan: "free",
		});
		expect(routed.model).toBe(AI_MODELS.MINIMAX_M3);
	});

	it("upgrades LLMChat thinking on to HY3 for paid plans", () => {
		const routed = routeChat({
			caller: "LLMChat",
			requestedThinking: "on",
			plan: "pro",
		});
		expect(routed.model).toBe(AI_MODELS.HY3);
		expect(routed.effectiveThinking).toBe("on");
	});

	it("clamps free-plan forced thinking", () => {
		const routed = routeChat({
			caller: "LLMChat",
			requestedThinking: "on",
			plan: "free",
		});
		expect(routed.effectiveThinking).not.toBe("on");
		expect(routed.model).toBe(AI_MODELS.MIMO_V25);
	});

	it("upgrades complex MistakeAI to MiniMax on paid plans", () => {
		const routed = routeChat({
			caller: "MistakeAI",
			requestedThinking: "on",
			estimatedInputTokens: 20000,
			messageCount: 24,
			plan: "plus",
		});
		expect(routed.model).toBe(AI_MODELS.MINIMAX_M3);
	});

	it("uses default routing for unknown callers", () => {
		const routed = routeChat({
			caller: "Legacy",
			knownCaller: false,
			requestedThinking: "auto",
			plan: "free",
		});
		expect(routed.model).toBe(AI_MODELS.MIMO_V25);
		expect(routed.reason).toContain("unknown_or_legacy_caller");
	});
});

describe("normalizeChatRequest", () => {
	it("defaults missing studypulse to Legacy + auto", () => {
		const normalized = normalizeChatRequest({ message: "hi" });
		expect(normalized.caller).toBe("Legacy");
		expect(normalized.requestedThinking).toBe("auto");
		expect(normalized.messages[0].content).toBe("hi");
	});

	it("prefers messages array and reads metadata", () => {
		const normalized = normalizeChatRequest({
			messages: [
				{ role: "system", content: "sys" },
				{ role: "user", content: "q" },
			],
			studypulse: { caller: "MistakeAI", thinking: "on" },
		});
		expect(normalized.caller).toBe("MistakeAI");
		expect(normalized.requestedThinking).toBe("on");
		expect(normalized.messageCount).toBe(2);
	});

	it("treats invalid thinking as auto", () => {
		const normalized = normalizeChatRequest({
			message: "x",
			studypulse: { caller: "LLMChat", thinking: "maybe" },
		});
		expect(normalized.requestedThinking).toBe("auto");
	});
});
