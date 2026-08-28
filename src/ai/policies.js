/**
 * Caller policies and plan capabilities.
 *
 * Callers map to a routing PURPOSE (light/chat/reasoning/vision), never to a
 * concrete model. The router resolves the purpose against the ai_models
 * table (purpose tags, capabilities, priority, min_plan, enabled) to pick
 * primary/fallback dynamically — adding a model with a matching purpose tag
 * automatically puts it into that route's candidate pool.
 */

import { PURPOSE_LADDER } from "./model-config.js";
import { CALLERS } from "./callers.js";

export const ROUTING_VERSION = "2026-08-v2";

export const UPGRADE_THRESHOLDS = {
	hy3: { estimatedInputTokens: 6000, messageCount: 12 },
	m3: { estimatedInputTokens: 12000, messageCount: 20 },
};

const LIGHT = {
	purpose: "light",
	defaultThinking: "off",
	allowsUserThinking: true,
	// Heavy prompts escalate to the standard-chat purpose pool.
	escalateHeavy: true,
	heavyPurpose: "chat",
};

const CHAT_AUTO = {
	purpose: "chat",
	defaultThinking: "auto",
	allowsUserThinking: true,
};

const REASONING_ON = {
	purpose: "reasoning",
	defaultThinking: "on",
	allowsUserThinking: true,
};

const VISION_AUTO = {
	purpose: "vision",
	defaultThinking: "auto",
	allowsUserThinking: false,
};

export const CALLER_POLICIES = {
	[CALLERS.StudySuggestions]: { ...LIGHT, allowsUserThinking: false },
	[CALLERS.ScorePrediction]: { ...LIGHT, allowsUserThinking: false },
	[CALLERS.SubjectRadar]: { ...LIGHT, allowsUserThinking: false },
	[CALLERS.WeeklyReport]: { ...LIGHT, allowsUserThinking: false },
	[CALLERS.HomeAskRouter]: { ...LIGHT, allowsUserThinking: false },
	[CALLERS.HabitInsight]: { ...LIGHT, allowsUserThinking: false },
	[CALLERS.BrainUsageQuota]: { ...LIGHT, allowsUserThinking: false },
	[CALLERS.BodyRadar]: { ...LIGHT, allowsUserThinking: false },
	[CALLERS.StudySessionStress]: { ...LIGHT, allowsUserThinking: false },
	[CALLERS.LLMChat]: LIGHT,
	[CALLERS.Legacy]: LIGHT,
	[CALLERS.HomeAskAnswer]: CHAT_AUTO,
	[CALLERS.MistakeAI]: { ...CHAT_AUTO, complexityUpgrade: true },
	[CALLERS.SimilarQuestion]: CHAT_AUTO,
	[CALLERS.SimilarQuestionGrading]: { ...CHAT_AUTO, complexityUpgrade: true },
	[CALLERS.KnowledgeFaultLine]: { ...CHAT_AUTO, allowsUserThinking: false },
	[CALLERS.AIQuiz]: CHAT_AUTO,
	[CALLERS.AIQuizGrading]: CHAT_AUTO,
	[CALLERS.ExamSimulationGeneration]: CHAT_AUTO,
	[CALLERS.ExamSimulationGrading]: CHAT_AUTO,
	[CALLERS.ExamRoleAnalysis]: { ...CHAT_AUTO, allowsUserThinking: false },
	[CALLERS.ExamReadiness]: { ...CHAT_AUTO, allowsUserThinking: false },
	[CALLERS.ExamReversePlanner]: { ...CHAT_AUTO, allowsUserThinking: false },
	[CALLERS.AICoach]: { ...CHAT_AUTO, complexityUpgrade: true },
	[CALLERS.AIDiscussion]: { ...CHAT_AUTO, complexityUpgrade: true },
	[CALLERS.AutoMindMap]: { ...CHAT_AUTO, allowsUserThinking: false },
	[CALLERS.MistakeDebate]: REASONING_ON,
	[CALLERS.ExamAutopsy]: VISION_AUTO,
	[CALLERS.MistakeImageRecognition]: VISION_AUTO,
};

export const DEFAULT_POLICY = { ...LIGHT, allowsUserThinking: false };

export const PLAN_CAPABILITIES = {
	free: {
		allowForcedThinking: false,
	},
	plus: {
		allowForcedThinking: true,
	},
	pro: {
		allowForcedThinking: true,
	},
	admin: {
		allowForcedThinking: true,
	},
};

export function getCallerPolicy(caller) {
	return CALLER_POLICIES[caller] || DEFAULT_POLICY;
}

export function getPlanCapabilities(plan) {
	return PLAN_CAPABILITIES[plan] || PLAN_CAPABILITIES.free;
}

/** Ordered purpose pools searched for candidates: caller purpose first. */
export function purposeSearchOrder(policy) {
	const target = policy.purpose;
	return [target, ...PURPOSE_LADDER.filter((p) => p !== target)];
}

export function resolveEffectiveThinking(policy, requestedThinking, planCaps) {
	if (!policy.allowsUserThinking) {
		return policy.defaultThinking;
	}
	if (requestedThinking === "on" && !planCaps.allowForcedThinking) {
		return policy.defaultThinking === "off" ? "auto" : policy.defaultThinking;
	}
	if (requestedThinking === "auto") {
		return policy.defaultThinking === "off" ? "off" : "auto";
	}
	return requestedThinking;
}

/** reasoning_effort is an upstream dialect handled by the hy3 adapter. */
export function reasoningEffortFor(provider, effectiveThinking) {
	if (provider !== "hy3") return null;
	if (effectiveThinking === "on") return "high";
	if (effectiveThinking === "auto") return "low";
	return "none";
}
