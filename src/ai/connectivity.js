import { knownModels } from "../billing/store.js";
import { getProviderConfig } from "./models.js";
import { providerForModel } from "./policies.js";
import { createProviderRegistry } from "../providers/registry.js";

const PING_TIMEOUT_MS = 15_000;

function sanitizeError(message) {
	return String(message || "AI request failed")
		.replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
		.replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
		.slice(0, 240);
}

export async function testModelConnectivity(model, env, { registry, fetchImpl, now = Date.now } = {}) {
	if (!knownModels().includes(model)) {
		return { ok: false, status: 400, error: "Unknown model" };
	}

	const providerId = providerForModel(model);
	const providers = registry || createProviderRegistry(env);
	const adapter = providers.get(providerId);
	const cfg = getProviderConfig(providerId, env);

	if (!adapter || !adapter.isAvailable(env)) {
		return {
			ok: false,
			status: 503,
			model,
			provider: providerId,
			upstreamModel: cfg.model,
			error: `${providerId} API key is not configured`,
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
			model,
			provider: providerId,
			upstreamModel: result.upstreamModel || cfg.model,
			latencyMs: now() - started,
			replyPreview: String(result.reply || "").slice(0, 80),
		};
	} catch (err) {
		if (err?.name === "AbortError") {
			return {
				ok: false,
				status: 504,
				model,
				provider: providerId,
				upstreamModel: cfg.model,
				latencyMs: now() - started,
				error: "Timed out after 15s",
			};
		}
		return {
			ok: false,
			status: err?.status && err.status >= 400 ? err.status : 502,
			model,
			provider: providerId,
			upstreamModel: cfg.model,
			latencyMs: now() - started,
			error: sanitizeError(err?.message),
		};
	} finally {
		clearTimeout(timer);
	}
}
