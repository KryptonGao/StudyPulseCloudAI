import { AI_MODELS } from "../ai/models.js";
import { CURRENT_PRICING_VERSION, PRICING } from "./pricing.js";
import { calculatePoints } from "./points.js";

export const MODEL_LABELS = {
	[AI_MODELS.MIMO_V25]: "MiMo v2.5",
	[AI_MODELS.HY3]: "HY3",
	[AI_MODELS.MINIMAX_M3]: "MiniMax M3",
};

const CACHE_MS = 15_000;
let cache = { at: 0, table: null };

export function defaultPricingTable() {
	return structuredClone(PRICING[CURRENT_PRICING_VERSION]);
}

export function knownModels() {
	return Object.keys(defaultPricingTable());
}

export function invalidatePricingCache() {
	cache = { at: 0, table: null };
}

function cloneRates(rates) {
	return {
		input: Number(rates.input) || 0,
		output: Number(rates.output) || 0,
		reasoning: Number(rates.reasoning) || 0,
		cache: Number(rates.cache) || 0,
		multiplier: Number(rates.multiplier) || 1,
	};
}

export function mergePricingTable(rows) {
	const table = defaultPricingTable();
	for (const row of rows || []) {
		if (!table[row.model]) continue;
		table[row.model] = {
			input: Number(row.input_millipoints),
			output: Number(row.output_millipoints),
			reasoning: Number(row.reasoning_millipoints),
			cache: Number(row.cache_millipoints),
			multiplier: Number(row.multiplier) || 1,
		};
	}
	return table;
}

export async function getPricingTable(env) {
	if (cache.table && Date.now() - cache.at < CACHE_MS) return cache.table;
	if (!env?.StudyPulseDB) return defaultPricingTable();
	try {
		const result = await env.StudyPulseDB.prepare(
			`SELECT model, input_millipoints, output_millipoints, reasoning_millipoints, cache_millipoints, multiplier
			 FROM pricing_rates`,
		).all();
		cache = { at: Date.now(), table: mergePricingTable(result.results) };
		return cache.table;
	} catch {
		return defaultPricingTable();
	}
}

export function tokensPerPoint(millipoints, multiplier = 1) {
	const weighted = Number(millipoints) * (Number(multiplier) || 1);
	if (weighted <= 0) return null;
	return Math.round(1000 / weighted);
}

export function serializeModelRates(model, rates, extra = {}) {
	const cloned = cloneRates(rates);
	return {
		model,
		label: MODEL_LABELS[model] || model,
		input: cloned.input,
		output: cloned.output,
		reasoning: cloned.reasoning,
		cache: cloned.cache,
		multiplier: cloned.multiplier,
		tokensPerPoint: {
			input: tokensPerPoint(cloned.input, cloned.multiplier),
			output: tokensPerPoint(cloned.output, cloned.multiplier),
			reasoning: tokensPerPoint(cloned.reasoning, cloned.multiplier),
			cache: tokensPerPoint(cloned.cache, cloned.multiplier),
		},
		preview: {
			input1000: calculatePoints({
				model,
				inputTokens: 1000,
				table: { [model]: cloned },
			}),
			output1000: calculatePoints({
				model,
				outputTokens: 1000,
				table: { [model]: cloned },
			}),
			mixed: calculatePoints({
				model,
				inputTokens: 1000,
				outputTokens: 500,
				table: { [model]: cloned },
			}),
		},
		...extra,
	};
}

function asInt(value, { min, max }) {
	if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
		return null;
	}
	if (value < min || value > max) return null;
	return value;
}

export function validateModelRates(body) {
	const model = typeof body?.model === "string" ? body.model.trim() : "";
	if (!knownModels().includes(model)) {
		return { error: "Unknown model" };
	}
	const input = asInt(body.input, { min: 0, max: 1_000_000 });
	const output = asInt(body.output, { min: 0, max: 1_000_000 });
	const reasoning = asInt(body.reasoning, { min: 0, max: 1_000_000 });
	const cacheRate = asInt(body.cache, { min: 0, max: 1_000_000 });
	const multiplier = asInt(body.multiplier, { min: 1, max: 1000 });
	if (input == null || output == null || reasoning == null || cacheRate == null || multiplier == null) {
		return { error: "Rates must be integers (millipoints 0–1000000, multiplier 1–1000)" };
	}
	return {
		model,
		rates: {
			input,
			output,
			reasoning,
			cache: cacheRate,
			multiplier,
		},
	};
}

export async function listPricingRates(env) {
	const table = defaultPricingTable();
	let rows = [];
	try {
		const result = await env.StudyPulseDB.prepare(
			`SELECT model, input_millipoints, output_millipoints, reasoning_millipoints, cache_millipoints, multiplier, updated_at
			 FROM pricing_rates`,
		).all();
		rows = result.results || [];
	} catch {
		rows = [];
	}
	const byModel = new Map(rows.map((row) => [row.model, row]));
	return knownModels().map((model) => {
		const row = byModel.get(model);
		const rates = row
			? {
				input: row.input_millipoints,
				output: row.output_millipoints,
				reasoning: row.reasoning_millipoints,
				cache: row.cache_millipoints,
				multiplier: row.multiplier,
			}
			: table[model];
		return serializeModelRates(model, rates, { updatedAt: row?.updated_at || null });
	});
}

export async function upsertPricingRates(env, model, rates) {
	await env.StudyPulseDB.prepare(
		`INSERT INTO pricing_rates (
			model, input_millipoints, output_millipoints, reasoning_millipoints, cache_millipoints, multiplier, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(model) DO UPDATE SET
			input_millipoints = excluded.input_millipoints,
			output_millipoints = excluded.output_millipoints,
			reasoning_millipoints = excluded.reasoning_millipoints,
			cache_millipoints = excluded.cache_millipoints,
			multiplier = excluded.multiplier,
			updated_at = CURRENT_TIMESTAMP`,
	)
		.bind(model, rates.input, rates.output, rates.reasoning, rates.cache, rates.multiplier)
		.run();
	invalidatePricingCache();
}

export async function restoreDefaultPricing(env) {
	const table = defaultPricingTable();
	for (const model of knownModels()) {
		await upsertPricingRates(env, model, table[model]);
	}
}
