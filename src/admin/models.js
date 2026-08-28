/**
 * Admin console — dynamic model management service layer.
 *
 * CRUD over ai_models + the per-model credit coefficients in pricing_rates.
 * API keys are stored AES-GCM encrypted (security/secretbox) and never
 * returned to the client; only a hint and the key source are exposed.
 */

import {
	getActiveModelConfigs,
	invalidateModelConfigCache,
	listModelRows,
	PROVIDER_PROTOCOLS,
	ROUTING_PURPOSES,
	slugifyModelId,
	validateModelPayload,
} from "../ai/model-config.js";
import { encryptSecret, keyHintFor } from "../security/secretbox.js";
import { listPricingRates, upsertPricingRates } from "../billing/store.js";
import { writeAdminLog } from "./database.js";

function serializeModel(row, ratesByModel) {
	const capabilities = safeParse(row.capabilities, {});
	const purposes = safeParse(row.purposes, []);
	const rates = ratesByModel.get(row.id) || null;
	return {
		id: row.id,
		displayName: row.display_name,
		provider: row.provider,
		upstreamModel: row.upstream_model,
		baseURL: row.base_url,
		authStyle: row.auth_style,
		contextLength: row.context_length || 0,
		capabilities: {
			streaming: Boolean(capabilities.streaming),
			thinking: Boolean(capabilities.thinking),
			vision: Boolean(capabilities.vision),
		},
		purposes,
		priority: row.priority,
		minPlan: row.min_plan,
		extraBody: row.extra_body || null,
		enabled: Number(row.enabled) === 1,
		keyConfigured: Boolean(row.api_key_cipher) || Boolean(row.env_key_name),
		keySource: row.api_key_cipher ? "encrypted" : row.env_key_name ? `env:${row.env_key_name}` : "none",
		keyHint: row.key_hint || null,
		rates,
		createdAt: row.created_at || null,
		updatedAt: row.updated_at || null,
	};
}

function safeParse(value, fallback) {
	try {
		const parsed = typeof value === "string" ? JSON.parse(value) : value;
		return parsed ?? fallback;
	} catch {
		return fallback;
	}
}

export async function listAdminModels(env) {
	const rows = await listModelRows(env);
	const rates = await listPricingRates(env);
	const ratesByModel = new Map(rates.map((r) => [r.model, r]));
	return {
		models: rows.map((row) => serializeModel(row, ratesByModel)),
		purposes: Object.entries(ROUTING_PURPOSES).map(([id, meta]) => ({ id, ...meta })),
		protocols: Object.entries(PROVIDER_PROTOCOLS).map(([id, meta]) => ({ id, ...meta })),
		minPlans: ["free", "plus", "pro"],
	};
}

async function modelIdExists(env, id) {
	const row = await env.StudyPulseDB.prepare("SELECT id FROM ai_models WHERE id = ?").bind(id).first();
	return Boolean(row);
}

function uniqueId(base, existing) {
	if (!existing.has(base)) return base;
	let n = 2;
	while (existing.has(`${base}-${n}`)) n++;
	return `${base}-${n}`;
}

function buildInsertBindings(id, fields, cipher, hint) {
	return [
		id,
		fields.display_name,
		fields.provider,
		fields.upstream_model,
		fields.base_url,
		fields.auth_style,
		cipher,
		null,
		hint,
		fields.context_length ?? 0,
		fields.capabilities ?? "{}",
		fields.purposes ?? "[]",
		fields.priority ?? 100,
		fields.min_plan ?? "free",
		fields.extra_body ?? null,
		fields.enabled ?? 1,
	];
}

export async function createAdminModel(env, body, adminUserId = "admin_system") {
	const parsed = validateModelPayload(body, { partial: false });
	if (parsed.error) return { error: parsed.error, status: 400 };

	// Internal id: explicit and valid, or slugified from the upstream model id.
	let internalId;
	if (body.internal_id != null && body.internal_id !== "") {
		if (typeof body.internal_id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,59}$/.test(body.internal_id.trim())) {
			return { error: "internal_id must match [a-z0-9][a-z0-9._-]{0,59}", status: 400 };
		}
		internalId = body.internal_id.trim();
		if (await modelIdExists(env, internalId)) {
			return { error: `model id "${internalId}" already exists`, status: 409 };
		}
	} else {
		const existing = new Set(
			(await getActiveModelConfigs(env)).map((c) => c.id),
		);
		internalId = uniqueId(slugifyModelId(body.model_id), existing);
	}

	const fields = parsed.fields;
	const cipher = await encryptSecret(fields.api_key || "", env);
	const hint = fields.api_key ? keyHintFor(fields.api_key) : null;

	await env.StudyPulseDB.prepare(
		`INSERT INTO ai_models (
			id, display_name, provider, upstream_model, base_url, auth_style,
			api_key_cipher, env_key_name, key_hint, context_length, capabilities,
			purposes, priority, min_plan, extra_body, enabled
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(...buildInsertBindings(internalId, fields, cipher, hint))
		.run();

	if (parsed.rates) {
		await upsertPricingRates(env, internalId, parsed.rates);
	}
	invalidateModelConfigCache();
	writeAdminLog(env, {
		admin_user_id: adminUserId,
		action: "model_create",
		details: JSON.stringify({ model: internalId, provider: fields.provider, enabled: fields.enabled ?? 1 }),
	}).catch(() => {});
	return { model: await getModelForAdmin(env, internalId) };
}

async function getModelForAdmin(env, id) {
	const { models } = await listAdminModels(env);
	return models.find((m) => m.id === id) || null;
}

export async function updateAdminModel(env, id, body, adminUserId = "admin_system") {
	if (typeof id !== "string" || !id.trim()) return { error: "id is required", status: 400 };
	const parsed = validateModelPayload(body, { partial: true });
	if (parsed.error) return { error: parsed.error, status: 400 };

	const current = await env.StudyPulseDB.prepare("SELECT * FROM ai_models WHERE id = ?").bind(id.trim()).first();
	if (!current) return { error: "Model not found", status: 404 };

	const fields = parsed.fields;
	const assignments = [];
	const bindings = [];
	for (const [column, value] of Object.entries(fields)) {
		if (column === "api_key") continue;
		assignments.push(`${column} = ?`);
		bindings.push(value);
	}

	if (fields.api_key !== undefined) {
		if (fields.api_key === "") {
			// Explicit empty string clears the stored key.
			assignments.push("api_key_cipher = NULL", "key_hint = NULL");
		} else {
			const cipher = await encryptSecret(fields.api_key, env);
			assignments.push("api_key_cipher = ?", "key_hint = ?");
			bindings.push(cipher, keyHintFor(fields.api_key));
		}
	}

	if (assignments.length) {
		assignments.push("updated_at = CURRENT_TIMESTAMP");
		bindings.push(id.trim());
		await env.StudyPulseDB.prepare(
			`UPDATE ai_models SET ${assignments.join(", ")} WHERE id = ?`,
		).bind(...bindings).run();
	}

	if (parsed.rates) {
		await upsertPricingRates(env, id.trim(), parsed.rates);
	}
	invalidateModelConfigCache();
	writeAdminLog(env, {
		admin_user_id: adminUserId,
		action: "model_update",
		details: JSON.stringify({
			model: id.trim(),
			fields: Object.keys(fields).filter((f) => f !== "api_key"),
			key_changed: fields.api_key !== undefined,
			rates: parsed.rates || undefined,
		}),
	}).catch(() => {});
	return { model: await getModelForAdmin(env, id.trim()) };
}
