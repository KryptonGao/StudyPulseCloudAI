import { AI_MODELS } from "./models.js";
import { CALLERS } from "./callers.js";
import {
	ROUTING_VERSION,
	UPGRADE_THRESHOLDS,
	getCallerPolicy,
	getFallbackModel,
	getPlanCapabilities,
	providerForModel,
	reasoningEffortFor,
} from "./policies.js";

function resolveEffectiveThinking(policy, requestedThinking, caps) {
	if (!policy.allowsUserThinking) {
		return policy.defaultThinking;
	}
	if (requestedThinking === "on" && !caps.allowForcedThinking) {
		return policy.defaultThinking === "off" ? "auto" : policy.defaultThinking;
	}
	if (requestedThinking === "auto") {
		return policy.defaultThinking === "off" ? "off" : "auto";
	}
	return requestedThinking;
}

function isComplex(input) {
	return (
		(input.estimatedInputTokens || 0) >= UPGRADE_THRESHOLDS.m3.estimatedInputTokens ||
		(input.messageCount || 0) >= UPGRADE_THRESHOLDS.m3.messageCount
	);
}

function isHeavy(input) {
	return (
		(input.estimatedInputTokens || 0) >= UPGRADE_THRESHOLDS.hy3.estimatedInputTokens ||
		(input.messageCount || 0) >= UPGRADE_THRESHOLDS.hy3.messageCount
	);
}

export function routeChat(input) {
	const caller = input.caller || CALLERS.Legacy;
	const policy = getCallerPolicy(caller);
	const caps = getPlanCapabilities(input.plan || "free");
	const requestedThinking = input.requestedThinking || "auto";
	const reasons = [];

	if (input.knownCaller === false) {
		reasons.push("unknown_or_legacy_caller");
	}

	let model = policy.model;
	let effectiveThinking = resolveEffectiveThinking(policy, requestedThinking, caps);

	if (input.hasImages) {
		model = AI_MODELS.MINIMAX_M3;
		reasons.push("vision_requires_minimax");
		if (effectiveThinking === "off") effectiveThinking = "auto";
	} else if (policy.forceM3) {
		if (caps.allowDesignatedM3) {
			model = AI_MODELS.MINIMAX_M3;
			reasons.push("designated_m3_caller");
		} else {
			model = AI_MODELS.HY3;
			reasons.push("free_plan_demote_m3");
		}
	} else if (model === AI_MODELS.MIMO_V25 && (requestedThinking === "on" && policy.allowsUserThinking) && caps.allowForcedThinking) {
		model = AI_MODELS.HY3;
		effectiveThinking = "on";
		reasons.push("thinking_on_upgrade_hy3");
	} else if (model === AI_MODELS.MIMO_V25 && isHeavy(input)) {
		model = AI_MODELS.HY3;
		if (effectiveThinking === "off") effectiveThinking = "auto";
		reasons.push("heavy_prompt_upgrade_hy3");
	}

	if (
		policy.complexityUpgrade &&
		caps.allowM3Upgrade &&
		!input.hasImages &&
		(requestedThinking === "on" || isComplex(input))
	) {
		model = AI_MODELS.MINIMAX_M3;
		effectiveThinking = requestedThinking === "off" ? "auto" : "on";
		reasons.push("complexity_upgrade_m3");
	}

	if (model === AI_MODELS.MIMO_V25 && effectiveThinking === "auto") {
		effectiveThinking = "off";
		reasons.push("mimo_auto_maps_off");
	}

	const provider = providerForModel(model);
	const fallbackModel = getFallbackModel(model);

	return {
		model,
		provider,
		effectiveThinking,
		reasoningEffort: reasoningEffortFor(model, effectiveThinking),
		routingVersion: ROUTING_VERSION,
		fallbackModel,
		fallbackProvider: providerForModel(fallbackModel),
		reason: reasons.join(",") || "caller_policy",
		caller,
		requestedThinking,
		policyDefaultThinking: policy.defaultThinking,
	};
}
