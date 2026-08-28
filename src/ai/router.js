/**
 * Dynamic AI router.
 *
 * routeChat(input, models) resolves the caller's purpose policy against the
 * admin-managed model registry (`models` = routing view from model-config):
 *
 *   1. candidate pool  = enabled models tagged with the target purpose,
 *                        then the purpose ladder (chat → light → reasoning →
 *                        vision) for fallback depth
 *   2. hard filter     = vision-capable models only when images are present
 *   3. soft filters    = thinking capability when forced thinking is required,
 *                        streaming support when the request streams,
 *                        context length vs estimated input tokens,
 *                        min_plan floor (vision requests are exempt) —
 *                        relaxed only when no candidate survives them
 *   4. ordering        = priority ASC (smaller number = higher priority)
 *
 * The first candidate is Primary, the rest is the ordered fallback chain.
 */

import { purposeSearchOrder, resolveEffectiveThinking, reasoningEffortFor, ROUTING_VERSION, UPGRADE_THRESHOLDS, getCallerPolicy, getPlanCapabilities } from "./policies.js";
import { CALLERS } from "./callers.js";
import { planRank } from "./model-config.js";
import { defaultModelConfigs, toRoutingView } from "./model-config.js";

function isHeavy(input) {
	return (
		(input.estimatedInputTokens || 0) >= UPGRADE_THRESHOLDS.hy3.estimatedInputTokens ||
		(input.messageCount || 0) >= UPGRADE_THRESHOLDS.hy3.messageCount
	);
}

function isComplex(input) {
	return (
		(input.estimatedInputTokens || 0) >= UPGRADE_THRESHOLDS.m3.estimatedInputTokens ||
		(input.messageCount || 0) >= UPGRADE_THRESHOLDS.m3.messageCount
	);
}

function capabilityCompatible(model, { thinkingRequired, streamingRequired, visionRequired, estimatedInputTokens }) {
	if (visionRequired && !model.capabilities.vision) return false;
	if (thinkingRequired && !model.capabilities.thinking) return false;
	if (streamingRequired && !model.capabilities.streaming) return false;
	if (model.contextLength > 0 && (estimatedInputTokens || 0) > model.contextLength) return false;
	return true;
}

/**
 * Build the ordered candidate chain for one purpose pool.
 * `relaxed` drops the soft capability filters (used only when the strict
 * pass produced no candidates, so serving degraded beats failing).
 */
function candidatesForPurpose(models, purpose, constraints, relaxed) {
	const pool = models.filter((m) => m.purposes.includes(purpose));
	const accepted = [];
	for (const model of pool) {
		const planBlocked =
			planRank(model.minPlan) > constraints.planRank &&
			!(constraints.visionRequired && model.capabilities.vision);
		if (planBlocked) continue;
		const caps = relaxed
			? { visionRequired: constraints.visionRequired, thinkingRequired: false, streamingRequired: false, estimatedInputTokens: constraints.estimatedInputTokens }
			: constraints;
		if (!capabilityCompatible(model, caps)) continue;
		accepted.push(model);
	}
	return accepted.sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : 1));
}

function collectChain(models, purposes, constraints, relaxed) {
	const seen = new Set();
	const chain = [];
	for (const purpose of purposes) {
		let candidates = candidatesForPurpose(models, purpose, constraints, relaxed);
		for (const model of candidates) {
			if (seen.has(model.id)) continue;
			seen.add(model.id);
			chain.push(model);
		}
	}
	return chain;
}

function buildChain(models, purposes, constraints) {
	// Strict pass first (capability + plan filters everywhere). The relaxed
	// pass re-runs the whole ladder without the soft capability filters, so a
	// request that no model can fully satisfy still degrades gracefully
	// instead of failing.
	let chain = collectChain(models, purposes, constraints, false);
	if (!chain.length) {
		chain = collectChain(models, purposes, constraints, true);
	}
	return chain;
}

/**
 * @param {object} input { caller, knownCaller, requestedThinking, stream,
 *                         hasImages, estimatedInputTokens, messageCount, plan }
 * @param {Array} [models] routing view; defaults to built-in models
 */
export function routeChat(input, models) {
	const caller = input.caller || CALLERS.Legacy;
	const policy = getCallerPolicy(caller);
	const planCaps = getPlanCapabilities(input.plan || "free");
	const requestedThinking = input.requestedThinking || "auto";
	const routingModels = models?.length
		? models
		: toRoutingView(defaultModelConfigs(input.env || {}), { requireKey: false });
	const reasons = [];

	if (input.knownCaller === false) {
		reasons.push("unknown_or_legacy_caller");
	}
	reasons.push(`purpose_${policy.purpose}`);

	const visionRequired = Boolean(input.hasImages) || policy.purpose === "vision";
	if (input.hasImages) reasons.push("vision_required");
	if (visionRequired && policy.purpose !== "vision") reasons.push("vision_pool");

	const thinkingRequired =
		!visionRequired &&
		requestedThinking === "on" &&
		policy.allowsUserThinking &&
		planCaps.allowForcedThinking;

	let targetPurpose = policy.purpose;
	if (visionRequired) {
		targetPurpose = "vision";
	} else if (policy.escalateHeavy && isHeavy(input)) {
		targetPurpose = policy.heavyPurpose;
		reasons.push(`heavy_prompt_upgrade_${targetPurpose}`);
	} else if (
		policy.complexityUpgrade &&
		!visionRequired &&
		(thinkingRequired || isComplex(input))
	) {
		targetPurpose = "reasoning";
		reasons.push(`complexity_upgrade_${targetPurpose}`);
	}

	if (thinkingRequired) reasons.push("thinking_capability_required");

	const constraints = {
		planRank: planRank(input.plan || "free"),
		visionRequired,
		thinkingRequired,
		streamingRequired: Boolean(input.stream),
		estimatedInputTokens: input.estimatedInputTokens || 0,
	};
	const purposes = visionRequired
		? ["vision"]
		: [targetPurpose, ...purposeSearchOrder(policy).filter((p) => p !== targetPurpose)];
	let chain = buildChain(routingModels, purposes, constraints);

	if (!chain.length && !visionRequired && routingModels.length) {
		// Last resort: every purpose pool was exhausted (plan floor or missing
		// capabilities). Serve the best available model rather than failing —
		// mirrors the legacy global fallback that ignored plan gating.
		const downgraded = routingModels.map((m) => ({ ...m, minPlan: "free" }));
		chain = collectChain(downgraded, purposes, constraints, true);
		if (chain.length) reasons.push("plan_gate_relaxed_no_alternative");
	}

	if (!chain.length) {
		return {
			model: null,
			provider: null,
			chain: [],
			effectiveThinking: resolveEffectiveThinking(policy, requestedThinking, planCaps),
			reasoningEffort: null,
			routingVersion: ROUTING_VERSION,
			fallbackModel: null,
			fallbackProvider: null,
			reason: reasons.join(",") + ",no_candidate",
			caller,
			requestedThinking,
			policyDefaultThinking: policy.defaultThinking,
			targetPurpose,
		};
	}

	const primary = chain[0];
	const fallback = chain[1] || null;
	const effectiveThinking = primary.capabilities.thinking
		? resolveEffectiveThinking(policy, requestedThinking, planCaps)
		: "off";
	if (!primary.capabilities.thinking) {
		reasons.push("thinking_unsupported_off");
	}

	return {
		model: primary.id,
		provider: primary.provider,
		chain,
		effectiveThinking,
		reasoningEffort: reasoningEffortFor(primary.provider, effectiveThinking),
		routingVersion: ROUTING_VERSION,
		fallbackModel: fallback?.id || null,
		fallbackProvider: fallback?.provider || null,
		reason: reasons.join(",") || "purpose_pool",
		caller,
		requestedThinking,
		policyDefaultThinking: policy.defaultThinking,
		targetPurpose,
	};
}
