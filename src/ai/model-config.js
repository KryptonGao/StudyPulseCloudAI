/**
 * Dynamic model management — DB-backed model registry.
 *
 * The AI Router reads routing views from this module instead of the static
 * CALLER_POLICIES → model mapping. Admin edits (add/edit/disable) take
 * effect on the next request: rows are cached for CACHE_MS only.
 *
 * When the table is empty or unreadable the built-in defaults (MiMo / HY3 /
 * MiniMax M3, configurable through wrangler vars) keep the service running.
 */

import { decryptSecret, keyHintFor } from "../security/secretbox.js";

export const ROUTING_PURPOSES = {
	light: {
		label: "轻量快速",
		description: "低成本低延迟任务：建议、雷达、周报、配额判断等",
	},
	chat: {
		label: "标准对话",
		description: "通用问答、批改、教练对话等主力用途",
	},
	reasoning: {
		label: "深度推理",
		description: "复杂推理、辩论、考试深度分析；通常配较高优先级",
	},
	vision: {
		label: "视觉理解",
		description: "含图片输入的请求只会路由到带 vision 能力的模型",
	},
};

/** Fallback ladder after the caller's own purpose pool is exhausted. */
export const PURPOSE_LADDER = ["chat", "light", "reasoning", "vision"];

export const ROUTING_PURPOSE_IDS = Object.keys(ROUTING_PURPOSES);

export const PROVIDER_PROTOCOLS = {
	"openai-compat": {
		label: "OpenAI 兼容",
		description: "通用 /chat/completions 协议，可直接新增第三方模型",
	},
	mimo: { label: "MiMo（内置协议）", description: "thinking: enabled/disabled" },
	hy3: { label: "HY3（内置协议）", description: "thinking + reasoning_effort" },
	minimax: { label: "MiniMax（内置协议）", description: "thinking: disabled/adaptive" },
};

export const PROVIDER_PROTOCOL_IDS = Object.keys(PROVIDER_PROTOCOLS);

export const MIN_PLANS = ["free", "plus", "pro"];

const PLAN_RANK = { free: 0, plus: 1, pro: 2, admin: 3 };

/**
 * Built-in models. Used to seed migration 0025 and as the fallback routing
 * table when ai_models is empty/unreadable. `envPrefix` wires wrangler vars
 * (MIMO_BASE_URL / MIMO_MODEL / MIMO_AUTH_STYLE / MIMO_API_KEY ...).
 */
export const DEFAULT_MODEL_CONFIGS = [
	{
		id: "mimo-v2.5",
		displayName: "MiMo v2.5",
		provider: "mimo",
		upstreamModel: "mimo-v2.5-free",
		baseURL: "https://opencode.ai/zen/v1",
		authStyle: "bearer",
		envKeyName: "MIMO_API_KEY",
		envPrefix: "MIMO",
		contextLength: 0,
		capabilities: { streaming: true, thinking: false, vision: false },
		purposes: ["light"],
		priority: 10,
		minPlan: "free",
		enabled: 1,
	},
	{
		id: "hy3",
		displayName: "HY3",
		provider: "hy3",
		upstreamModel: "hy3-free",
		baseURL: "https://opencode.ai/zen/v1",
		authStyle: "bearer",
		envKeyName: "HY3_API_KEY",
		envPrefix: "HY3",
		contextLength: 0,
		capabilities: { streaming: true, thinking: true, vision: false },
		purposes: ["chat"],
		priority: 10,
		minPlan: "free",
		enabled: 1,
	},
	{
		id: "minimax-m3",
		displayName: "MiniMax M3",
		provider: "minimax",
		upstreamModel: "MiniMax-M3",
		baseURL: "https://api.minimaxi.com/v1",
		authStyle: "bearer",
		envKeyName: "MINIMAX_API_KEY",
		envPrefix: "MINIMAX",
		contextLength: 0,
		capabilities: { streaming: true, thinking: true, vision: true },
		purposes: ["chat", "reasoning", "vision"],
		priority: 20,
		minPlan: "plus",
		enabled: 1,
	},
];

const CACHE_MS = 15_000;
let cache = { at: 0, rows: null };

export function invalidateModelConfigCache() {
	cache = { at: 0, rows: null };
}

function trimSlash(url) {
	return String(url || "").replace(/\/+$/, "");
}

export function hostOf(url) {
	try {
		return new URL(trimSlash(url)).host;
	} catch {
		return trimSlash(url);
	}
}

export function planRank(plan) {
	return PLAN_RANK[plan] ?? 0;
}

function parseJsonField(value, fallback) {
	if (value == null) return fallback;
	try {
		const parsed = typeof value === "string" ? JSON.parse(value) : value;
		return parsed ?? fallback;
	} catch {
		return fallback;
	}
}

function normalizeCapabilities(raw) {
	const caps = parseJsonField(raw, {});
	return {
		streaming: Boolean(caps.streaming),
		thinking: Boolean(caps.thinking),
		vision: Boolean(caps.vision),
	};
}

function normalizePurposes(raw) {
	const list = parseJsonField(raw, []);
	if (!Array.isArray(list)) return [];
	return [...new Set(list.filter((p) => ROUTING_PURPOSE_IDS.includes(p)))];
}

/** Row (D1) → resolved runtime config; apiKey resolved from cipher or env. */
async function resolveRow(row, env) {
	let apiKey = null;
	let keySource = null;
	if (row.api_key_cipher) {
		apiKey = await decryptSecret(row.api_key_cipher, env);
		keySource = apiKey ? "encrypted" : "encrypted_error";
	} else if (row.env_key_name && env?.[row.env_key_name]) {
		apiKey = env[row.env_key_name];
		keySource = "env";
	}
	return {
		id: row.id,
		displayName: row.display_name,
		provider: PROVIDER_PROTOCOLS[row.provider] ? row.provider : "openai-compat",
		upstreamModel: row.upstream_model,
		baseURL: trimSlash(row.base_url),
		authStyle: row.auth_style === "api-key" ? "api-key" : "bearer",
		apiKey,
		keySource,
		keyHint: row.key_hint || null,
		envKeyName: row.env_key_name || null,
		contextLength: Number(row.context_length) || 0,
		capabilities: normalizeCapabilities(row.capabilities),
		purposes: normalizePurposes(row.purposes),
		priority: Number(row.priority) || 100,
		minPlan: MIN_PLANS.includes(row.min_plan) ? row.min_plan : "free",
		extraBody: parseJsonField(row.extra_body, null),
		enabled: Number(row.enabled) === 1,
		updatedAt: row.updated_at || null,
	};
}

/** Default configs with wrangler-var overrides applied. */
export function defaultModelConfigs(env = {}) {
	return DEFAULT_MODEL_CONFIGS.map((config) => {
		const prefix = config.envPrefix;
		const authStyle = env?.[`${prefix}_AUTH_STYLE`] === "api-key" ? "api-key" : config.authStyle;
		return {
			...config,
			upstreamModel: env?.[`${prefix}_MODEL`] || config.upstreamModel,
			baseURL: trimSlash(env?.[`${prefix}_BASE_URL`] || config.baseURL),
			authStyle,
			apiKey: env?.[config.envKeyName] || null,
			keySource: env?.[config.envKeyName] ? "env" : null,
			keyHint: env?.[config.envKeyName] ? keyHintFor(env[config.envKeyName]) : null,
			enabled: true,
			extraBody: null,
			updatedAt: null,
		};
	});
}

export async function listModelRows(env) {
	if (cache.rows && Date.now() - cache.at < CACHE_MS) return cache.rows;
	if (!env?.StudyPulseDB) {
		cache = { at: Date.now(), rows: [] };
		return [];
	}
	try {
		const result = await env.StudyPulseDB.prepare(
			`SELECT id, display_name, provider, upstream_model, base_url, auth_style,
			        api_key_cipher, env_key_name, key_hint, context_length, capabilities,
			        purposes, priority, min_plan, extra_body, enabled, updated_at
			   FROM ai_models
			  ORDER BY priority ASC, id ASC`,
		).all();
		cache = { at: Date.now(), rows: result.results || [] };
		return cache.rows;
	} catch (err) {
		// Missing table / transient D1 error → fall back to built-in defaults.
		console.warn("[model-config] failed to load ai_models:", err?.message || err);
		cache = { at: Date.now(), rows: [] };
		return [];
	}
}

/**
 * All model configs (enabled and disabled), resolved with API keys.
 * Falls back to built-in defaults when the table has no rows.
 */
export async function getActiveModelConfigs(env) {
	const rows = await listModelRows(env);
	if (!rows.length) return defaultModelConfigs(env);
	return Promise.all(rows.map((row) => resolveRow(row, env)));
}

/** Single model by internal id (DB row first, then built-in defaults). */
export async function resolveModelConfig(modelId, env) {
	if (typeof modelId !== "string" || !modelId.trim()) return null;
	const wanted = modelId.trim();
	const rows = await listModelRows(env);
	if (rows.length) {
		const row = rows.find((r) => r.id === wanted);
		return row ? resolveRow(row, env) : null;
	}
	return defaultModelConfigs(env).find((c) => c.id === wanted) || null;
}

/**
 * Routing view consumed by routeChat(): enabled models with the fields the
 * router needs (purpose pools, capabilities, priority, plan floor, host).
 * `requireKey` is false for built-in fallback views — key resolution happens
 * in the registry layer for DB-backed models.
 */
export function toRoutingView(configs, { requireKey = true } = {}) {
	return configs
		.filter((c) => c.enabled && (!requireKey || c.apiKey))
		.map((c) => ({
			id: c.id,
			provider: c.provider,
			purposes: c.purposes,
			capabilities: c.capabilities,
			priority: c.priority,
			minPlan: c.minPlan,
			contextLength: c.contextLength,
			baseURL: c.baseURL,
			host: hostOf(c.baseURL),
		}));
}

// ────────────────────────────────────────────────────────────────────────────
// Validation (admin API input)
// ────────────────────────────────────────────────────────────────────────────

const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,59}$/;

export function slugifyModelId(raw) {
	const slug = String(raw || "")
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60)
		.replace(/^[._-]+/, "");
	return slug || "model";
}

function asInt(value, { min, max }, fallback = null) {
	if (value === undefined || value === null || value === "") return fallback;
	const n = Number(value);
	if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) return undefined;
	return n;
}

function asString(value, { max }, fallback = undefined) {
	if (value === undefined) return fallback;
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed.length > max) return undefined;
	return trimmed;
}

/**
 * Validate create/update payload. Returns { error } or { fields, rates? }.
 * When `partial` is true, omitted fields keep their current values.
 */
export function validateModelPayload(body, { partial = false } = {}) {
	if (!body || typeof body !== "object") return { error: "Invalid JSON body" };
	const fields = {};

	if (body.display_name !== undefined) {
		const displayName = asString(body.display_name, { max: 80 });
		if (!displayName) return { error: "display_name must be 1-80 chars" };
		fields.display_name = displayName;
	} else if (!partial) {
		return { error: "display_name is required (1-80 chars)" };
	}

	if (body.model_id !== undefined) {
		const upstreamModel = asString(body.model_id, { max: 160 });
		if (!upstreamModel) return { error: "model_id (upstream model id) must be 1-160 chars" };
		fields.upstream_model = upstreamModel;
	} else if (!partial) {
		return { error: "model_id (upstream model id) is required (1-160 chars)" };
	}

	if (body.provider !== undefined) {
		if (!PROVIDER_PROTOCOL_IDS.includes(body.provider)) {
			return { error: `provider must be one of: ${PROVIDER_PROTOCOL_IDS.join(", ")}` };
		}
		fields.provider = body.provider;
	} else if (!partial) {
		fields.provider = "openai-compat";
	}

	const baseURL = asString(body.base_url, { max: 400 }, null);
	if (baseURL === null && !partial) return { error: "base_url is required" };
	if (baseURL != null) {
		if (!baseURL) return { error: "base_url must be 1-400 chars" };
		if (!/^https?:\/\//i.test(baseURL)) return { error: "base_url must start with http(s)://" };
		fields.base_url = trimSlash(baseURL);
	}

	if (body.auth_style !== undefined) {
		if (!["bearer", "api-key"].includes(body.auth_style)) {
			return { error: "auth_style must be bearer or api-key" };
		}
		fields.auth_style = body.auth_style;
	} else if (!partial) {
		fields.auth_style = "bearer";
	}

	if (body.api_key !== undefined && body.api_key !== null) {
		if (typeof body.api_key !== "string" || body.api_key.length > 400) {
			return { error: "api_key must be a string up to 400 chars" };
		}
		fields.api_key = body.api_key;
	}

	const contextLength = asInt(body.context_length, { min: 0, max: 10_000_000 });
	if (contextLength === undefined) return { error: "context_length must be an integer 0-10000000" };
	if (contextLength !== null) fields.context_length = contextLength;
	else if (!partial) fields.context_length = 0;

	if (body.capabilities !== undefined || !partial) {
		const caps = body.capabilities || {};
		if (typeof caps !== "object" || Array.isArray(caps)) {
			return { error: "capabilities must be an object" };
		}
		fields.capabilities = JSON.stringify({
			streaming: Boolean(caps.streaming),
			thinking: Boolean(caps.thinking),
			vision: Boolean(caps.vision),
		});
	}

	if (body.purposes !== undefined || !partial) {
		const purposes = body.purposes;
		if (!Array.isArray(purposes) || purposes.length === 0) {
			return { error: "purposes must be a non-empty array" };
		}
		const unique = [...new Set(purposes)];
		if (unique.some((p) => !ROUTING_PURPOSE_IDS.includes(p))) {
			return { error: `purposes must be a subset of: ${ROUTING_PURPOSE_IDS.join(", ")}` };
		}
		fields.purposes = JSON.stringify(unique);
	}

	const priority = asInt(body.priority, { min: 1, max: 1000 });
	if (priority === undefined) return { error: "priority must be an integer 1-1000 (smaller = higher)" };
	if (priority !== null) fields.priority = priority;
	else if (!partial) fields.priority = 100;

	if (body.min_plan !== undefined) {
		if (!MIN_PLANS.includes(body.min_plan)) {
			return { error: "min_plan must be free, plus or pro" };
		}
		fields.min_plan = body.min_plan;
	} else if (!partial) {
		fields.min_plan = "free";
	}

	if (body.extra_body !== undefined) {
		if (body.extra_body === null || body.extra_body === "") {
			fields.extra_body = null;
		} else {
			const raw = typeof body.extra_body === "string" ? body.extra_body : JSON.stringify(body.extra_body);
			if (raw.length > 4096) return { error: "extra_body is limited to 4096 chars" };
			let parsed;
			try {
				parsed = JSON.parse(raw);
			} catch {
				return { error: "extra_body must be valid JSON" };
			}
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				return { error: "extra_body must be a JSON object" };
			}
			fields.extra_body = JSON.stringify(parsed);
		}
	} else if (!partial) {
		fields.extra_body = null;
	}

	if (body.enabled !== undefined) {
		fields.enabled = body.enabled ? 1 : 0;
	}

	// Existing per-model credit coefficients (pricing_rates shape). When
	// provided all five fields are required; omitted → keep current rates.
	let rates = null;
	if (body.rates !== undefined && body.rates !== null) {
		const r = body.rates || {};
		const parsedRates = {
			input: asInt(r.input, { min: 0, max: 1_000_000 }),
			output: asInt(r.output, { min: 0, max: 1_000_000 }),
			reasoning: asInt(r.reasoning, { min: 0, max: 1_000_000 }),
			cache: asInt(r.cache, { min: 0, max: 1_000_000 }),
			multiplier: asInt(r.multiplier, { min: 1, max: 1000 }),
		};
		for (const [key, value] of Object.entries(parsedRates)) {
			if (value == null) {
				return { error: `rates.${key} must be an integer (millipoints 0-1000000, multiplier 1-1000)` };
			}
		}
		rates = parsedRates;
	}

	return { fields, rates };
}

export async function hasAnyModelConfigured(env) {
	const configs = await getActiveModelConfigs(env);
	return configs.some((c) => c.enabled && c.apiKey);
}
