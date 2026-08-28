import { PROVIDERS } from "../ai/models.js";
import { createHy3Adapter } from "./hy3.js";
import { createMimoAdapter } from "./mimo.js";
import { createMinimaxAdapter } from "./minimax.js";

export function createProviderRegistry(env, adapters) {
	const list = adapters || [
		createMimoAdapter(),
		createHy3Adapter(),
		createMinimaxAdapter(),
	];
	const byId = new Map(list.map((adapter) => [adapter.providerId, adapter]));
	return {
		get(providerId) {
			return byId.get(providerId);
		},
		isAvailable(providerId) {
			return Boolean(byId.get(providerId)?.isAvailable(env));
		},
		hasAny() {
			return list.some((adapter) => adapter.isAvailable(env));
		},
		ids() {
			return [PROVIDERS.MIMO, PROVIDERS.HY3, PROVIDERS.MINIMAX].filter((id) => byId.has(id));
		},
	};
}
