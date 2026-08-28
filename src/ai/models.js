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

export const FALLBACK_MODEL = {
	[AI_MODELS.MIMO_V25]: AI_MODELS.HY3,
	[AI_MODELS.HY3]: AI_MODELS.MINIMAX_M3,
	[AI_MODELS.MINIMAX_M3]: AI_MODELS.HY3,
};

const DEFAULTS = {
	[PROVIDERS.MIMO]: {
		baseURL: "https://opencode.ai/zen/v1",
		model: "mimo-v2.5-free",
		authStyle: "bearer",
	},
	[PROVIDERS.HY3]: {
		baseURL: "https://opencode.ai/zen/v1",
		model: "hy3-free",
		authStyle: "bearer",
	},
	[PROVIDERS.MINIMAX]: {
		baseURL: "https://api.minimaxi.com/v1",
		model: "MiniMax-M3",
		authStyle: "bearer",
	},
};

function trimSlash(url) {
	return String(url || "").replace(/\/+$/, "");
}

export function getProviderConfig(providerId, env = {}) {
	if (providerId === PROVIDERS.MIMO) {
		return {
			providerId,
			internalModel: AI_MODELS.MIMO_V25,
			apiKey: env.MIMO_API_KEY,
			baseURL: trimSlash(env.MIMO_BASE_URL || DEFAULTS.mimo.baseURL),
			model: env.MIMO_MODEL || DEFAULTS.mimo.model,
			authStyle: env.MIMO_AUTH_STYLE === "api-key" ? "api-key" : "bearer",
		};
	}
	if (providerId === PROVIDERS.HY3) {
		return {
			providerId,
			internalModel: AI_MODELS.HY3,
			apiKey: env.HY3_API_KEY,
			baseURL: trimSlash(env.HY3_BASE_URL || DEFAULTS.hy3.baseURL),
			model: env.HY3_MODEL || DEFAULTS.hy3.model,
			authStyle: "bearer",
		};
	}
	return {
		providerId: PROVIDERS.MINIMAX,
		internalModel: AI_MODELS.MINIMAX_M3,
		apiKey: env.MINIMAX_API_KEY,
		baseURL: trimSlash(env.MINIMAX_BASE_URL || DEFAULTS.minimax.baseURL),
		model: env.MINIMAX_MODEL || DEFAULTS.minimax.model,
		authStyle: "bearer",
	};
}

export function hasAnyProviderKey(env) {
	return Boolean(env?.MINIMAX_API_KEY || env?.MIMO_API_KEY || env?.HY3_API_KEY);
}
