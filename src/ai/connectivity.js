import { resolveModelConfig } from "./model-config.js";
import { createProviderRegistry } from "../providers/registry.js";

const PING_TIMEOUT_MS = 15_000;

function sanitizeError(message) {
	return String(message || "AI request failed")
		.replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
		.replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
		.slice(0, 240);
}

/**
 * Ping a model by internal id through its own adapter. Works for built-in
 * models and admin-added dynamic models alike.
 */
export async function testModelConnectivity(modelId, env, { registry, fetchImpl, now = Date.now } = {}) {
	const record = await resolveModelConfig(modelId, env);
	if (!record) {
		return { ok: false, status: 400, error: "Unknown model" };
	}

	const providers = registry || (await createProviderRegistry(env, [record]));
	const adapter = providers.get(record.id);
	const upstreamModel = record.upstreamModel;

	if (!adapter || !adapter.isAvailable(env)) {
		return {
			ok: false,
			status: 503,
			model: record.id,
			provider: record.provider,
			upstreamModel,
			error: `${record.provider} API key is not configured`,
		};
	}

	const started = now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
	try {
		const result = await adapter.createChatCompletion({
			messages: [
				{ role: "system", content: "You are a connectivity check endpoint." },
				{ role: "user", content: "ping" },
			],
			stream: false,
			thinking: "off",
			reasoningEffort: "none",
			signal: controller.signal,
			env,
			fetchImpl,
		});
		return {
			ok: true,
			status: 200,
			model: record.id,
			provider: record.provider,
			upstreamModel: result.upstreamModel || upstreamModel,
			latencyMs: now() - started,
			replyPreview: String(result.reply || "").slice(0, 80),
		};
	} catch (err) {
		if (err?.name === "AbortError") {
			return {
				ok: false,
				status: 504,
				model: record.id,
				provider: record.provider,
				upstreamModel,
				latencyMs: now() - started,
				error: "Timed out after 15s",
			};
		}
		return {
			ok: false,
			status: err?.status && err.status >= 400 ? err.status : 502,
			model: record.id,
			provider: record.provider,
			upstreamModel,
			latencyMs: now() - started,
			error: sanitizeError(err?.message),
		};
	} finally {
		clearTimeout(timer);
	}
}
