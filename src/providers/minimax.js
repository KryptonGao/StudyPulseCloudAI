/**
 * MiniMax-M3 via official OpenAI-compatible Chat Completions.
 * Docs: https://platform.minimaxi.com/
 *
 * Thinking uses MiniMax fields only: disabled | adaptive.
 */
import { PROVIDERS, getProviderConfig } from "../ai/models.js";
import { createOpenAICompatAdapter } from "./openai-compat.js";

export function createMinimaxAdapter() {
	return createOpenAICompatAdapter({
		providerId: PROVIDERS.MINIMAX,
		getConfig: (env) => getProviderConfig(PROVIDERS.MINIMAX, env),
		buildExtraBody({ thinking }) {
			return {
				thinking: { type: thinking === "off" ? "disabled" : "adaptive" },
			};
		},
	});
}

const defaultAdapter = createMinimaxAdapter();

/** @deprecated Use createMinimaxAdapter().createChatCompletion */
export function chat(messages, env) {
	return defaultAdapter.createChatCompletion({
		messages,
		stream: false,
		thinking: "off",
		env,
	});
}

/** @deprecated Use createMinimaxAdapter().createChatCompletion */
export function chatStream(messages, env) {
	return defaultAdapter.createChatCompletion({
		messages,
		stream: true,
		thinking: "off",
		env,
	}).then((result) => result.response);
}
