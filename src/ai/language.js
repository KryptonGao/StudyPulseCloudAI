const MARKER = "[StudyPulse output language]";

const LABELS = {
	"zh-Hans": "Simplified Chinese (简体中文)",
	"zh-Hant": "Traditional Chinese (繁體中文)",
	ja: "Japanese (日本語)",
	ko: "Korean (한국어)",
	en: "English",
};

export function normalizeLocale(raw) {
	if (typeof raw !== "string" || !raw.trim()) return null;
	const value = raw.trim().toLowerCase().replace(/_/g, "-");
	if (
		value.startsWith("zh-hant") ||
		value === "zh-tw" ||
		value === "zh-hk" ||
		value === "zh-mo"
	) {
		return "zh-Hant";
	}
	if (value.startsWith("zh")) return "zh-Hans";
	if (value.startsWith("ja")) return "ja";
	if (value.startsWith("ko")) return "ko";
	if (value.startsWith("en")) return "en";
	return null;
}

export function parseAcceptLanguage(header) {
	if (typeof header !== "string" || !header.trim()) return null;
	const first = header.split(",")[0]?.split(";")[0];
	return normalizeLocale(first);
}

function contentText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((item) => (typeof item?.text === "string" ? item.text : ""))
		.join("\n");
}

function lastUserText(messages) {
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		if (messages[i]?.role === "user") return contentText(messages[i].content);
	}
	return "";
}

export function detectLanguageFromText(text) {
	if (typeof text !== "string" || !text) return null;
	if (/[\uac00-\ud7af]/.test(text)) return "ko";
	if (/[\u3040-\u30ff]/.test(text)) return "ja";
	const han = (text.match(/[\u4e00-\u9fff]/g) || []).length;
	const latin = (text.match(/[A-Za-z]/g) || []).length;
	if (han >= 2 && han >= latin) return "zh";
	return null;
}

export function resolveOutputLanguage({ messages, locale, acceptLanguage } = {}) {
	const detected = detectLanguageFromText(lastUserText(messages));
	const fromLocale = normalizeLocale(locale);
	const fromHeader = parseAcceptLanguage(acceptLanguage);

	if (detected === "ko" || detected === "ja") return detected;
	if (detected === "zh") {
		return fromLocale === "zh-Hant" ? "zh-Hant" : "zh-Hans";
	}
	return fromLocale || fromHeader || null;
}

export function languageInstruction(language) {
	const label = LABELS[language];
	if (!label) {
		return `${MARKER}
Reply in the same language as the user's latest message. Do not default to English.
If the output must be JSON, keep JSON keys and enum values in English, and write human-readable string values in the user's language.`;
	}
	return `${MARKER}
You MUST write the user-visible reply in ${label}.
Do not switch to English unless the user explicitly asks for English.
If the output must be JSON, keep JSON keys and enum values in English; write all human-readable string values in ${label}.`;
}

function prependText(content, prefix) {
	if (typeof content === "string") return `${prefix}\n\n${content}`;
	if (Array.isArray(content)) return [{ type: "text", text: prefix }, ...content];
	return prefix;
}

function appendText(content, suffix) {
	if (typeof content === "string") return `${content}\n\n${suffix}`;
	if (Array.isArray(content)) return [...content, { type: "text", text: suffix }];
	return suffix;
}

export function applyOutputLanguage(messages, { locale, acceptLanguage } = {}) {
	const list = Array.isArray(messages) ? messages.map((msg) => ({ ...msg })) : [];
	const language = resolveOutputLanguage({ messages: list, locale, acceptLanguage });
	const instruction = languageInstruction(language);
	const already = list.some(
		(msg) => msg?.role === "system" && contentText(msg.content).includes(MARKER),
	);
	if (already) return list;

	const sysIdx = list.findIndex((msg) => msg?.role === "system");
	if (sysIdx >= 0) {
		list[sysIdx] = {
			...list[sysIdx],
			content: prependText(list[sysIdx].content, instruction),
		};
	} else {
		list.unshift({ role: "system", content: instruction });
	}

	if (language && language !== "en") {
		const hint = `(Please reply in ${LABELS[language]}.)`;
		for (let i = list.length - 1; i >= 0; i -= 1) {
			if (list[i]?.role === "user") {
				list[i] = { ...list[i], content: appendText(list[i].content, hint) };
				break;
			}
		}
	}

	return list;
}
