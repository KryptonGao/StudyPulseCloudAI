import { AI_MODELS } from "../ai/models.js";
import { CURRENT_PRICING_VERSION, PRICING } from "./pricing.js";

export function calculatePoints({
	model,
	inputTokens = 0,
	outputTokens = 0,
	reasoningTokens = 0,
	cachedInputTokens = 0,
	pricingVersion = CURRENT_PRICING_VERSION,
	table = null,
	rates = null,
} = {}) {
	const pricingTable = table || PRICING[pricingVersion] || PRICING[CURRENT_PRICING_VERSION];
	const modelRates = rates || pricingTable[model] || pricingTable[AI_MODELS.MIMO_V25];
	const millipoints =
		Math.max(0, inputTokens) * modelRates.input +
		Math.max(0, outputTokens) * modelRates.output +
		Math.max(0, reasoningTokens) * modelRates.reasoning +
		Math.max(0, cachedInputTokens) * modelRates.cache;
	const scaled = millipoints * (modelRates.multiplier || 1);
	if (scaled <= 0) return 0;
	return Math.ceil(scaled / 1000);
}
