import { describe, expect, it } from "vitest";
import { calculatePoints } from "../src/billing/points.js";
import { CURRENT_PRICING_VERSION } from "../src/billing/pricing.js";

describe("calculatePoints", () => {
	it("weights output higher than input", () => {
		const inputOnly = calculatePoints({
			model: "mimo-v2.5",
			inputTokens: 1000,
			outputTokens: 0,
			pricingVersion: CURRENT_PRICING_VERSION,
		});
		const outputOnly = calculatePoints({
			model: "mimo-v2.5",
			inputTokens: 0,
			outputTokens: 1000,
			pricingVersion: CURRENT_PRICING_VERSION,
		});
		expect(outputOnly).toBeGreaterThan(inputOnly);
	});

	it("charges MiniMax more than MiMo for the same tokens", () => {
		const args = { inputTokens: 1000, outputTokens: 500, reasoningTokens: 0 };
		const mimo = calculatePoints({ model: "mimo-v2.5", ...args });
		const m3 = calculatePoints({ model: "minimax-m3", ...args });
		expect(m3).toBeGreaterThan(mimo);
	});

	it("ceils fractional millipoints", () => {
		expect(calculatePoints({ model: "mimo-v2.5", inputTokens: 1 })).toBe(1);
	});

	it("returns 0 for empty usage", () => {
		expect(calculatePoints({ model: "hy3" })).toBe(0);
	});

	it("freezes historical pricing versions", () => {
		const v1 = calculatePoints({
			model: "hy3",
			inputTokens: 2000,
			outputTokens: 1000,
			pricingVersion: "2026-08-v1",
		});
		const unknown = calculatePoints({
			model: "hy3",
			inputTokens: 2000,
			outputTokens: 1000,
			pricingVersion: "not-a-real-version",
		});
		expect(unknown).toBe(v1);
	});
});
