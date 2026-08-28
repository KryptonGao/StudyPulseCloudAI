import { describe, expect, it } from "vitest";
import {
	applyOutputLanguage,
	detectLanguageFromText,
	normalizeLocale,
	parseAcceptLanguage,
	resolveOutputLanguage,
} from "../src/ai/language.js";

describe("output language", () => {
	it("maps locale tags", () => {
		expect(normalizeLocale("zh-Hans-CN")).toBe("zh-Hans");
		expect(normalizeLocale("zh_TW")).toBe("zh-Hant");
		expect(normalizeLocale("ja-JP")).toBe("ja");
		expect(parseAcceptLanguage("zh-CN,zh;q=0.9,en;q=0.8")).toBe("zh-Hans");
	});

	it("detects CJK from the last user message", () => {
		expect(detectLanguageFromText("请解释这道题")).toBe("zh");
		expect(detectLanguageFromText("この問題を説明して")).toBe("ja");
		expect(detectLanguageFromText("이 문제를 설명해줘")).toBe("ko");
		expect(detectLanguageFromText("ping")).toBe(null);
	});

	it("prefers message script over English locale", () => {
		expect(
			resolveOutputLanguage({
				messages: [{ role: "user", content: "你好，帮我看看错题" }],
				locale: "en-US",
			}),
		).toBe("zh-Hans");
	});

	it("uses locale when the user message has no script signal", () => {
		expect(
			resolveOutputLanguage({
				messages: [{ role: "user", content: "ping" }],
				locale: "zh-Hans",
			}),
		).toBe("zh-Hans");
	});

	it("injects a system prefix and a user hint for Chinese", () => {
		const next = applyOutputLanguage(
			[
				{ role: "system", content: "You are a tutor." },
				{ role: "user", content: "这题怎么做" },
			],
			{ locale: "en" },
		);
		expect(next[0].content).toContain("[StudyPulse output language]");
		expect(next[0].content).toContain("简体中文");
		expect(next[0].content).toContain("You are a tutor.");
		expect(next[1].content).toContain("Please reply in Simplified Chinese");
	});

	it("does not duplicate the instruction", () => {
		const once = applyOutputLanguage([{ role: "user", content: "你好" }], { locale: "zh-Hans" });
		const twice = applyOutputLanguage(once, { locale: "zh-Hans" });
		expect(twice.filter((msg) => msg.role === "system")).toHaveLength(1);
		expect(twice[0].content.match(/\[StudyPulse output language\]/g)).toHaveLength(1);
	});
});
