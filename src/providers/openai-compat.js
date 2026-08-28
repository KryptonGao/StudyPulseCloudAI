import { classifyHttpStatus, ProviderError } from "./errors.js";

export function normalizeUsage(raw) {
	if (!raw || typeof raw !== "object") {
		return {
			prompt_tokens: 0,
			completion_tokens: 0,
			total_tokens: 0,
			reasoning_tokens: 0,
			cached_tokens: 0,
			missing: true,
		};
	}
	const prompt = Number(raw.prompt_tokens ?? raw.input_tokens ?? 0) || 0;
	const completion = Number(raw.completion_tokens ?? raw.output_tokens ?? 0) || 0;
	const total = Number(raw.total_tokens ?? prompt + completion) || 0;
	const reasoning =
		Number(
			raw.reasoning_tokens ??
				raw.completion_tokens_details?.reasoning_tokens ??
				raw.output_tokens_details?.reasoning_tokens ??
				0,
		) || 0;
	const cached =
		Number(
			raw.cached_tokens ??
				raw.prompt_tokens_details?.cached_tokens ??
				raw.input_tokens_details?.cached_tokens ??
				0,
		) || 0;
	return {
		prompt_tokens: prompt,
		completion_tokens: completion,
		total_tokens: total,
		reasoning_tokens: reasoning,
		cached_tokens: cached,
		missing: false,
	};
}

export async function extractUsageFromSse(stream, { signal } = {}) {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let lastUsageEvent = null;

	const onAbort = () => {
		reader.cancel().catch(() => {});
	};
	signal?.addEventListener("abort", onAbort);

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			buffer += decoder.decode(value, { stream: true });
			const parts = buffer.split("\n\n");
			buffer = parts.pop();
			for (const event of parts) {
				const usageJson = findUsageData(event);
				if (usageJson) lastUsageEvent = usageJson;
			}
		}
		buffer += decoder.decode();
		if (buffer.trim()) {
			const usageJson = findUsageData(buffer);
			if (usageJson) lastUsageEvent = usageJson;
		}
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}

	if (!lastUsageEvent) return normalizeUsage(null);
	try {
		return normalizeUsage(JSON.parse(lastUsageEvent).usage);
	} catch {
		return normalizeUsage(null);
	}
}

function findUsageData(event) {
	const dataLine = event.split("\n").find((line) => line.startsWith("data: "));
	if (!dataLine) return null;
	const json = dataLine.slice(6);
	if (json === "[DONE]") return null;
	try {
		const parsed = JSON.parse(json);
		if (parsed.usage) return json;
	} catch {
		/* ignore non-JSON SSE lines */
	}
	return null;
}

function trimSlash(url) {
	return String(url || "").replace(/\/+$/, "");
}

export function createOpenAICompatAdapter({ providerId, getConfig, buildExtraBody }) {
	return {
		providerId,
		isAvailable(env) {
			return Boolean(getConfig(env).apiKey);
		},
		async createChatCompletion({
			messages,
			stream = false,
			thinking = "off",
			reasoningEffort = null,
			signal,
			env,
			fetchImpl,
		}) {
			const cfg = getConfig(env);
			if (!cfg.apiKey) {
				throw new ProviderError(`${providerId} unavailable`, {
					status: 503,
					retryable: true,
					provider: providerId,
					code: "unavailable",
				});
			}

			const url = `${trimSlash(cfg.baseURL)}/chat/completions`;
			const extra = buildExtraBody?.({ thinking, reasoningEffort, stream }) || {};
			const body = {
				model: cfg.model,
				messages,
				stream: Boolean(stream),
				...extra,
			};
			if (stream && extra.stream_options == null) {
				body.stream_options = { include_usage: true };
			}

			const headers = { "Content-Type": "application/json" };
			if (cfg.authStyle === "api-key") {
				headers["api-key"] = cfg.apiKey;
			} else {
				headers.Authorization = `Bearer ${cfg.apiKey}`;
			}

			let response;
			try {
				response = await (fetchImpl || fetch)(url, {
					method: "POST",
					headers,
					body: JSON.stringify(body),
					signal,
				});
			} catch (err) {
				if (err?.name === "AbortError") throw err;
				throw new ProviderError(err?.message || "network error", {
					status: 502,
					retryable: true,
					provider: providerId,
					code: "network",
				});
			}

			if (!response.ok) {
				const errText = await response.text().catch(() => "");
				const { retryable } = classifyHttpStatus(response.status);
				throw new ProviderError(
					`${providerId} API error ${response.status}: ${errText.slice(0, 200)}`,
					{
						status: response.status,
						retryable,
						provider: providerId,
					},
				);
			}

			if (stream) {
				if (!response.body || typeof response.body.tee !== "function") {
					throw new ProviderError(`${providerId} stream missing body`, {
						status: 502,
						retryable: true,
						provider: providerId,
					});
				}
				return {
					response,
					model: cfg.internalModel,
					provider: providerId,
					upstreamModel: cfg.model,
				};
			}

			const data = await response.json();
			const reply = data?.choices?.[0]?.message?.content;
			if (typeof reply !== "string") {
				throw new ProviderError(`${providerId} returned unexpected shape`, {
					status: 502,
					retryable: true,
					provider: providerId,
				});
			}
			return {
				reply,
				usage: normalizeUsage(data?.usage),
				model: cfg.internalModel,
				provider: providerId,
				upstreamModel: cfg.model,
			};
		},
	};
}
