import { CHAT_MAX_CONTENT_ITEMS, CHAT_MAX_MESSAGE_CHARS, CHAT_MAX_MESSAGES } from "../chat-limits.js";
import { canonicalizeCaller, normalizeThinking } from "../ai/callers.js";

function contentCharCount(content) {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	return content.reduce((sum, item) => sum + (typeof item?.text === "string" ? item.text.length : 0), 0);
}

function contentHasImages(content) {
	if (!Array.isArray(content)) return false;
	return content.some((item) => item?.type === "image_url" || item?.type === "video_url" || item?.image_url);
}

function messagesHaveImages(messages) {
	return messages.some((msg) => contentHasImages(msg.content));
}

export function validateChatPayload(body) {
	if (typeof body?.message === "string" && body.message.length > CHAT_MAX_MESSAGE_CHARS) {
		return "Message too long";
	}

	if (Array.isArray(body?.content)) {
		if (body.content.length > CHAT_MAX_CONTENT_ITEMS) {
			return "Too many content items";
		}
		for (const item of body.content) {
			if (typeof item?.text === "string" && item.text.length > CHAT_MAX_MESSAGE_CHARS) {
				return "Content item text too long";
			}
		}
	}

	if (Array.isArray(body?.messages)) {
		if (body.messages.length > CHAT_MAX_MESSAGES) {
			return "Too many messages";
		}
		for (const msg of body.messages) {
			if (Array.isArray(msg?.content) && msg.content.length > CHAT_MAX_CONTENT_ITEMS) {
				return "Too many content items";
			}
			if (contentCharCount(msg?.content) > CHAT_MAX_MESSAGE_CHARS) {
				return "Message too long";
			}
		}
	}

	return null;
}

function legacyMessages(body) {
	if (Array.isArray(body?.content)) {
		return [{ role: "user", content: body.content }];
	}
	const message = typeof body?.message === "string" ? body.message : "";
	return [{ role: "user", content: message }];
}

export function normalizeChatRequest(body) {
	const meta = body?.studypulse && typeof body.studypulse === "object" ? body.studypulse : null;
	const callerInfo = canonicalizeCaller(meta?.caller);
	const thinkingInfo = normalizeThinking(meta ? meta.thinking : "auto");

	if (meta && !thinkingInfo.valid) {
		console.warn(`[chat] invalid thinking "${meta.thinking}" from caller=${meta.caller}; defaulting to auto`);
	}
	if (meta && !callerInfo.known) {
		console.warn(`[chat] unknown caller "${callerInfo.raw}"; using Legacy default routing`);
	}
	if (!meta) {
		console.log("[chat] missing studypulse metadata; caller=Legacy thinking=auto");
	}

	const messages = Array.isArray(body?.messages) && body.messages.length > 0
		? body.messages
		: legacyMessages(body);

	const estimatedInputTokens = Math.ceil(JSON.stringify(messages).length / 4);

	return {
		messages,
		stream: body?.stream === true,
		caller: callerInfo.caller,
		knownCaller: callerInfo.known && Boolean(meta),
		requestedThinking: thinkingInfo.valid ? thinkingInfo.thinking : "auto",
		hasImages: messagesHaveImages(messages),
		estimatedInputTokens,
		messageCount: messages.length,
		clientModel: typeof body?.model === "string" ? body.model : null,
	};
}
