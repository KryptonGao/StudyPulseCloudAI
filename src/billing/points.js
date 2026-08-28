import { AI_MODELS } from "../ai/models.js";
import { CURRENT_PRICING_VERSION, PRICING } from "./pricing.js";

export function calculatePoints({
	model,
	inputTokens = 0,
	outputTokens = 0,
	reasoningTokens = 0,
	cachedInputTokens = 0,
	pricingVersion = CURRENT_PRICING_VERSION,
} = {}) {
	const table = PRICING[pricingVersion] || PRICING[CURRENT_PRICING_VERSION];
	const rates = table[model] || table[AI_MODELS.MIMO_V25];
	const millipoints =
		Math.max(0, inputTokens) * rates.input +
		Math.max(0, outputTokens) * rates.output +
		Math.max(0, reasoningTokens) * rates.reasoning +
		Math.max(0, cachedInputTokens) * rates.cache;
	const scaled = millipoints * (rates.multiplier || 1);
	if (scaled <= 0) return 0;
	return Math.ceil(scaled / 1000);
}
