/**
 * Static model constants (legacy). Routing now reads the dynamic registry in
 * ai/model-config.js; these ids remain the canonical billing keys shared by
 * pricing, usage records and the seeded ai_models rows.
 */
export const AI_MODELS = {
	MIMO_V25: "mimo-v2.5",
	HY3: "hy3",
	MINIMAX_M3: "minimax-m3",
};

export const PROVIDERS = {
	MIMO: "mimo",
	HY3: "hy3",
	MINIMAX: "minimax",
};

export const MODEL_PROVIDER = {
	[AI_MODELS.MIMO_V25]: PROVIDERS.MIMO,
	[AI_MODELS.HY3]: PROVIDERS.HY3,
	[AI_MODELS.MINIMAX_M3]: PROVIDERS.MINIMAX,
};
