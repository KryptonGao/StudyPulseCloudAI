/**
 * MiMo via OpenAI-compatible Chat Completions.
 * Default upstream: OpenCode Zen (`mimo-v2.5-free`).
 */
import { PROVIDERS, getProviderConfig } from "../ai/models.js";
import { createOpenAICompatAdapter } from "./openai-compat.js";

export function createMimoAdapter() {
	return createOpenAICompatAdapter({
		providerId: PROVIDERS.MIMO,
		getConfig: (env) => getProviderConfig(PROVIDERS.MIMO, env),
		buildExtraBody({ thinking }) {
			return {
				thinking: { type: thinking === "on" ? "enabled" : "disabled" },
			};
		},
	});
}
