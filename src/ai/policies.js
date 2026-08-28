import { AI_MODELS, FALLBACK_MODEL, MODEL_PROVIDER } from "./models.js";
import { CALLERS } from "./callers.js";

export const ROUTING_VERSION = "2026-08-v1";

export const UPGRADE_THRESHOLDS = {
	hy3: { estimatedInputTokens: 6000, messageCount: 12 },
	m3: { estimatedInputTokens: 12000, messageCount: 20 },
};

const MIMO_OFF = {
	model: AI_MODELS.MIMO_V25,
	defaultThinking: "off",
	allowsUserThinking: true,
};

const HY3_AUTO = {
	model: AI_MODELS.HY3,
	defaultThinking: "auto",
	allowsUserThinking: true,
};

const HY3_AUTO_BACKGROUND = {
	model: AI_MODELS.HY3,
	defaultThinking: "auto",
	allowsUserThinking: false,
};

const M3_ON = {
	model: AI_MODELS.MINIMAX_M3,
	defaultThinking: "on",
	allowsUserThinking: true,
	forceM3: true,
};

const M3_VISION = {
	model: AI_MODELS.MINIMAX_M3,
	defaultThinking: "auto",
	allowsUserThinking: false,
	forceM3: true,
	requiresVision: true,
};

export const CALLER_POLICIES = {
	[CALLERS.StudySuggestions]: { ...MIMO_OFF, allowsUserThinking: false },
	[CALLERS.ScorePrediction]: { ...MIMO_OFF, allowsUserThinking: false },
	[CALLERS.SubjectRadar]: { ...MIMO_OFF, allowsUserThinking: false },
	[CALLERS.WeeklyReport]: { ...MIMO_OFF, allowsUserThinking: false },
	[CALLERS.HomeAskRouter]: { ...MIMO_OFF, allowsUserThinking: false },
	[CALLERS.HabitInsight]: { ...MIMO_OFF, allowsUserThinking: false },
	[CALLERS.BrainUsageQuota]: { ...MIMO_OFF, allowsUserThinking: false },
	[CALLERS.BodyRadar]: { ...MIMO_OFF, allowsUserThinking: false },
	[CALLERS.StudySessionStress]: { ...MIMO_OFF, allowsUserThinking: false },
	[CALLERS.LLMChat]: MIMO_OFF,
	[CALLERS.Legacy]: MIMO_OFF,
	[CALLERS.HomeAskAnswer]: HY3_AUTO,
	[CALLERS.MistakeAI]: { ...HY3_AUTO, complexityUpgrade: true },
	[CALLERS.SimilarQuestion]: HY3_AUTO,
	[CALLERS.SimilarQuestionGrading]: { ...HY3_AUTO, complexityUpgrade: true },
	[CALLERS.KnowledgeFaultLine]: HY3_AUTO_BACKGROUND,
	[CALLERS.AIQuiz]: HY3_AUTO,
	[CALLERS.AIQuizGrading]: HY3_AUTO,
	[CALLERS.ExamSimulationGeneration]: HY3_AUTO,
	[CALLERS.ExamSimulationGrading]: HY3_AUTO,
	[CALLERS.ExamRoleAnalysis]: HY3_AUTO_BACKGROUND,
	[CALLERS.ExamReadiness]: HY3_AUTO_BACKGROUND,
	[CALLERS.ExamReversePlanner]: HY3_AUTO_BACKGROUND,
	[CALLERS.AICoach]: { ...HY3_AUTO, complexityUpgrade: true },
	[CALLERS.AIDiscussion]: { ...HY3_AUTO, complexityUpgrade: true },
	[CALLERS.AutoMindMap]: HY3_AUTO_BACKGROUND,
	[CALLERS.MistakeDebate]: M3_ON,
	[CALLERS.ExamAutopsy]: M3_VISION,
	[CALLERS.MistakeImageRecognition]: M3_VISION,
};

export const DEFAULT_POLICY = { ...MIMO_OFF, allowsUserThinking: false };

export const PLAN_CAPABILITIES = {
	free: {
		allowForcedThinking: false,
		allowM3Upgrade: false,
		allowDesignatedM3: false,
	},
	plus: {
		allowForcedThinking: true,
		allowM3Upgrade: true,
		allowDesignatedM3: true,
	},
	pro: {
		allowForcedThinking: true,
		allowM3Upgrade: true,
		allowDesignatedM3: true,
	},
	admin: {
		allowForcedThinking: true,
		allowM3Upgrade: true,
		allowDesignatedM3: true,
	},
};

export function getCallerPolicy(caller) {
	return CALLER_POLICIES[caller] || DEFAULT_POLICY;
}

export function getPlanCapabilities(plan) {
	return PLAN_CAPABILITIES[plan] || PLAN_CAPABILITIES.free;
}

export function getFallbackModel(model) {
	return FALLBACK_MODEL[model] || AI_MODELS.HY3;
}

export function providerForModel(model) {
	return MODEL_PROVIDER[model] || MODEL_PROVIDER[AI_MODELS.MIMO_V25];
}

export function reasoningEffortFor(model, effectiveThinking) {
	if (model !== AI_MODELS.HY3) return null;
	if (effectiveThinking === "on") return "high";
	if (effectiveThinking === "auto") return "low";
	return "none";
}
