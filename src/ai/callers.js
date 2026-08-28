export const THINKING_MODES = ["off", "auto", "on"];

export const CALLERS = {
	StudySuggestions: "StudySuggestions",
	ScorePrediction: "ScorePrediction",
	SubjectRadar: "SubjectRadar",
	WeeklyReport: "WeeklyReport",
	HomeAskRouter: "HomeAsk-Router",
	HabitInsight: "HabitInsight",
	BrainUsageQuota: "BrainUsageQuota",
	BodyRadar: "BodyRadar",
	StudySessionStress: "StudySessionStress",
	LLMChat: "LLMChat",
	Legacy: "Legacy",
	HomeAskAnswer: "HomeAsk-Answer",
	MistakeAI: "MistakeAI",
	SimilarQuestion: "SimilarQuestion",
	SimilarQuestionGrading: "SimilarQuestionGrading",
	KnowledgeFaultLine: "KnowledgeFaultLine",
	AIQuiz: "AIQuiz",
	AIQuizGrading: "AIQuizGrading",
	ExamSimulationGeneration: "ExamSimulationGeneration",
	ExamSimulationGrading: "ExamSimulationGrading",
	ExamRoleAnalysis: "ExamRoleAnalysis",
	ExamReadiness: "ExamReadiness",
	ExamReversePlanner: "ExamReversePlanner",
	AICoach: "AICoach",
	AIDiscussion: "AIDiscussion",
	AutoMindMap: "AutoMindMap",
	MistakeDebate: "MistakeDebate",
	ExamAutopsy: "ExamAutopsy",
	MistakeImageRecognition: "MistakeImageRecognition",
};

const ALIASES = {
	AISimilarQuestion: CALLERS.SimilarQuestion,
	AISimilarGrading: CALLERS.SimilarQuestionGrading,
	QuizGeneration: CALLERS.AIQuiz,
	QuizGrading: CALLERS.AIQuizGrading,
	AutoMindMapDelta: CALLERS.AutoMindMap,
	"AICoach-Conversation": CALLERS.AICoach,
	"ScorePrediction-Subject": CALLERS.ScorePrediction,
	"ScorePrediction-Comprehensive": CALLERS.ScorePrediction,
	complete: CALLERS.Legacy,
	stream: CALLERS.Legacy,
};

export function canonicalizeCaller(raw) {
	if (typeof raw !== "string" || !raw.trim()) {
		return { caller: CALLERS.Legacy, known: false, raw: raw ?? "" };
	}
	const trimmed = raw.trim();
	if (ALIASES[trimmed]) {
		return { caller: ALIASES[trimmed], known: true, raw: trimmed };
	}
	if (Object.values(CALLERS).includes(trimmed)) {
		return { caller: trimmed, known: true, raw: trimmed };
	}
	return { caller: CALLERS.Legacy, known: false, raw: trimmed };
}

export function normalizeThinking(raw) {
	if (typeof raw !== "string") {
		return { thinking: "auto", valid: raw == null };
	}
	const value = raw.trim().toLowerCase();
	if (THINKING_MODES.includes(value)) {
		return { thinking: value, valid: true };
	}
	return { thinking: "auto", valid: false };
}
