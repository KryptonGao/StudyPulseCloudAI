/**
 * HY3 via OpenAI-compatible Chat Completions.
 * Default upstream: OpenCode Zen (`hy3-free`).
 */
import { PROVIDERS, getProviderConfig } from "../ai/models.js";
import { createOpenAICompatAdapter } from "./openai-compat.js";

export function createHy3Adapter() {
	return createOpenAICompatAdapter({
		providerId: PROVIDERS.HY3,
		getConfig: (env) => getProviderConfig(PROVIDERS.HY3, env),
		buildExtraBody({ thinking, reasoningEffort }) {
			if (thinking === "off" || reasoningEffort === "none") {
				return {
					thinking: { type: "disabled" },
				};
			}
			return {
				thinking: { type: "enabled" },
				reasoning_effort: reasoningEffort === "high" ? "high" : "low",
			};
		},
	});
}
