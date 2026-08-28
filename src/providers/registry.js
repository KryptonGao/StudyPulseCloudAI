/**
 * Provider protocol adapters are maintained in code (openai-compat plus the
 * three built-in dialects). This registry binds one adapter instance to each
 * admin-managed model record, keyed by internal model id.
 */

import { createOpenAICompatAdapter } from "./openai-compat.js";
import { getActiveModelConfigs, toRoutingView } from "../ai/model-config.js";

function buildExtraBodyFor(provider, staticExtra) {
	return ({ thinking, reasoningEffort }) => {
		if (provider === "mimo") {
			return { thinking: { type: thinking === "on" ? "enabled" : "disabled" } };
		}
		if (provider === "hy3") {
			if (thinking === "off" || reasoningEffort === "none") {
				return { thinking: { type: "disabled" } };
			}
			return {
				thinking: { type: "enabled" },
				reasoning_effort: reasoningEffort === "high" ? "high" : "low",
			};
		}
		if (provider === "minimax") {
			return { thinking: { type: thinking === "off" ? "disabled" : "adaptive" } };
		}
		// Generic OpenAI-compatible: thinking control is opt-in via the
		// model's extra_body JSON so we never guess vendor-specific params.
		return { ...(staticExtra || {}) };
	};
}

export function createModelAdapter(config) {
	return createOpenAICompatAdapter({
		providerId: config.provider,
		getConfig: () => ({
			apiKey: config.apiKey,
			baseURL: config.baseURL,
			model: config.upstreamModel,
			authStyle: config.authStyle,
			internalModel: config.id,
		}),
		buildExtraBody: buildExtraBodyFor(config.provider, config.extraBody),
	});
}

/**
 * @param {object} env Worker env (StudyPulseDB, provider secrets)
 * @param {Array} [configs] pre-resolved model configs (tests); when omitted
 *                          the registry loads ai_models with built-in fallback
 */
export async function createProviderRegistry(env, configs) {
	const list = (configs || (await getActiveModelConfigs(env))).filter((c) => c.enabled);
	const byModel = new Map();
	for (const config of list) {
		if (!byModel.has(config.id)) {
			byModel.set(config.id, { config, adapter: createModelAdapter(config) });
		}
	}

	const resolve = (modelId) => byModel.get(modelId);
	const isAvailable = (modelId) => {
		const entry = resolve(modelId);
		return Boolean(entry?.adapter.isAvailable(env));
	};

	return {
		/** Adapter for an internal model id (null when unknown/disabled). */
		get(modelId) {
			return resolve(modelId)?.adapter || null;
		},
		isAvailable,
		/** Resolved upstream model string for an internal model id. */
		upstreamModelOf(modelId) {
			return resolve(modelId)?.config.upstreamModel || null;
		},
		baseUrlOf(modelId) {
			return resolve(modelId)?.config.baseURL || null;
		},
		hasAny() {
			return list.some((config) => isAvailable(config.id));
		},
		ids() {
			return [...byModel.keys()];
		},
		/** Routing view for routeChat(): enabled models with resolvable keys. */
		routeModels() {
			return toRoutingView(list);
		},
	};
}
