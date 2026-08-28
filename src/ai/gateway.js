import { incrementApiKeyUsage } from "../database/api_keys.js";
import { writeRequestLog } from "../admin/database.js";
import { recordUsage } from "../membership/membership.js";
import { calculatePoints } from "../billing/points.js";
import { CURRENT_PRICING_VERSION } from "../billing/pricing.js";
import { AI_MODELS } from "./models.js";
import { routeChat } from "./router.js";
import { createProviderRegistry } from "../providers/registry.js";
import { extractUsageFromSse, normalizeUsage } from "../providers/openai-compat.js";
import { isRetryableProviderError, ProviderError } from "../providers/errors.js";
import { getFallbackModel, providerForModel, reasoningEffortFor } from "./policies.js";

function logGateway(event) {
	console.log("[ai-gateway]", JSON.stringify(event));
}

async function callProvider(registry, env, route, messages, stream, signal) {
	const adapter = registry.get(route.provider);
	if (!adapter) {
		throw new ProviderError(`provider ${route.provider} not registered`, {
			retryable: true,
			provider: route.provider,
			code: "unavailable",
			status: 503,
		});
	}
	if (!adapter.isAvailable(env)) {
		throw new ProviderError(`${route.provider} unavailable`, {
			retryable: true,
			provider: route.provider,
			code: "unavailable",
			status: 503,
		});
	}
	return adapter.createChatCompletion({
		messages,
		stream,
		thinking: route.effectiveThinking,
		reasoningEffort: route.reasoningEffort,
		signal,
		env,
	});
}

function withModel(route, model) {
	return {
		...route,
		model,
		provider: providerForModel(model),
		reasoningEffort: reasoningEffortFor(model, route.effectiveThinking),
		fallbackModel: getFallbackModel(model),
		fallbackProvider: providerForModel(getFallbackModel(model)),
	};
}

function pickAvailableRoute(primary, registry) {
	const candidates = [
		primary.model,
		primary.fallbackModel,
		AI_MODELS.MINIMAX_M3,
		AI_MODELS.HY3,
		AI_MODELS.MIMO_V25,
	];
	const seen = new Set();
	for (const model of candidates) {
		if (!model || seen.has(model)) continue;
		seen.add(model);
		if (registry.isAvailable(providerForModel(model))) {
			return withModel(primary, model);
		}
	}
	return null;
}

async function attemptWithFallback(primary, run) {
	try {
		const result = await run(primary);
		return { result, finalRoute: primary, fallbackUsed: false, fallbackReason: null, primary };
	} catch (err) {
		if (!isRetryableProviderError(err)) throw err;
		const finalRoute = withModel(primary, primary.fallbackModel);
		logGateway({
			event: "fallback",
			primary_model: primary.model,
			final_model: finalRoute.model,
			fallback_used: true,
			fallback_reason: err.code || err.message || "provider_error",
		});
		try {
			const result = await run(finalRoute);
			return {
				result,
				finalRoute,
				fallbackUsed: true,
				fallbackReason: err.code || err.message || "provider_error",
				primary,
			};
		} catch (err2) {
			err2.fallbackUsed = true;
			err2.fallbackReason = err.code || err.message || "provider_error";
			err2.finalRoute = finalRoute;
			throw err2;
		}
	}
}

export async function executeChat({
	request,
	env,
	ctx,
	auth,
	normalized,
	plan,
	startTime,
	clientIp,
	clientUa,
	registry,
}) {
	const providers = registry || createProviderRegistry(env);
	if (!providers.hasAny()) {
		return Response.json(
			{ error: "Server not configured: no AI provider API keys" },
			{ status: 500 },
		);
	}

	const routed = routeChat({
		caller: normalized.caller,
		knownCaller: normalized.knownCaller,
		requestedThinking: normalized.requestedThinking,
		stream: normalized.stream,
		hasImages: normalized.hasImages,
		estimatedInputTokens: normalized.estimatedInputTokens,
		messageCount: normalized.messageCount,
		plan,
	});
	const primary = pickAvailableRoute(routed, providers);
	if (!primary) {
		return Response.json(
			{ error: "Server not configured: no AI provider API keys" },
			{ status: 500 },
		);
	}

	logGateway({
		event: "route",
		caller: primary.caller,
		requestedThinking: primary.requestedThinking,
		effectiveThinking: primary.effectiveThinking,
		primary_model: primary.model,
		provider: primary.provider,
		routing_version: primary.routingVersion,
		reason: primary.reason,
	});

	if (normalized.stream) {
		return executeStream({
			request,
			env,
			ctx,
			auth,
			normalized,
			primary,
			startTime,
			clientIp,
			clientUa,
			providers,
		});
	}

	return executeJson({
		env,
		ctx,
		auth,
		normalized,
		primary,
		startTime,
		clientIp,
		clientUa,
		providers,
	});
}

function usageToLedger(usage, model, extra = {}) {
	const normalized = usage?.missing ? normalizeUsage(null) : (usage || normalizeUsage(null));
	const pointsCharged = normalized.missing
		? 0
		: calculatePoints({
			model,
			inputTokens: normalized.prompt_tokens,
			outputTokens: normalized.completion_tokens,
			reasoningTokens: normalized.reasoning_tokens,
			cachedInputTokens: normalized.cached_tokens,
			pricingVersion: CURRENT_PRICING_VERSION,
		});
	return {
		input_tokens: normalized.prompt_tokens,
		output_tokens: normalized.completion_tokens,
		total_tokens: normalized.total_tokens,
		reasoning_tokens: normalized.reasoning_tokens,
		points_charged: pointsCharged,
		pricing_version: CURRENT_PRICING_VERSION,
		usage_missing: Boolean(normalized.missing),
		...extra,
	};
}

async function persistSuccess({
	env,
	auth,
	normalized,
	primary,
	finalRoute,
	fallbackUsed,
	fallbackReason,
	usage,
	startTime,
	clientIp,
	clientUa,
	status = 200,
	errorMessage = null,
}) {
	const ledger = usageToLedger(usage, finalRoute.model);
	if (ledger.usage_missing && !errorMessage) {
		errorMessage = "usage_missing";
	}

	const promises = [];
	if (auth.apiKeyId) {
		promises.push(incrementApiKeyUsage(env, auth.apiKeyId, ledger.usage_missing ? undefined : ledger.total_tokens));
	}
	if (auth.userId) {
		promises.push(recordUsage(auth.userId, auth.apiKeyId ?? null, {
			model: finalRoute.model,
			provider: finalRoute.provider,
			caller: normalized.caller,
			requested_thinking: normalized.requestedThinking,
			effective_thinking: finalRoute.effectiveThinking,
			reasoning_tokens: ledger.reasoning_tokens,
			input_tokens: ledger.input_tokens,
			output_tokens: ledger.output_tokens,
			total_tokens: ledger.total_tokens,
			points_charged: ledger.points_charged,
			pricing_version: ledger.pricing_version,
			routing_version: finalRoute.routingVersion,
		}, env));
	}
	promises.push(writeRequestLog(env, {
		api_key_id: auth.apiKeyId ?? null,
		user_id: auth.userId ?? null,
		model: finalRoute.model,
		provider: finalRoute.provider,
		status,
		latency_ms: Date.now() - startTime,
		ip: clientIp,
		user_agent: clientUa,
		prompt_tokens: ledger.usage_missing ? null : ledger.input_tokens,
		completion_tokens: ledger.usage_missing ? null : ledger.output_tokens,
		total_tokens: ledger.usage_missing ? null : ledger.total_tokens,
		reasoning_tokens: ledger.usage_missing ? null : ledger.reasoning_tokens,
		points_charged: ledger.points_charged,
		caller: normalized.caller,
		requested_thinking: normalized.requestedThinking,
		effective_thinking: finalRoute.effectiveThinking,
		routing_version: finalRoute.routingVersion,
		fallback_used: fallbackUsed ? 1 : 0,
		fallback_reason: fallbackReason,
		primary_model: primary.model,
		error_message: errorMessage,
	}));
	await Promise.all(promises);
	logGateway({
		event: "complete",
		caller: normalized.caller,
		primary_model: primary.model,
		final_model: finalRoute.model,
		fallback_used: fallbackUsed,
		fallback_reason: fallbackReason,
		points_charged: ledger.points_charged,
		usage_missing: ledger.usage_missing,
	});
}

async function persistFailure({
	env,
	ctx,
	auth,
	normalized,
	primary,
	finalRoute,
	fallbackUsed,
	fallbackReason,
	startTime,
	clientIp,
	clientUa,
	err,
}) {
	ctx.waitUntil(
		writeRequestLog(env, {
			api_key_id: auth.apiKeyId ?? null,
			user_id: auth.userId ?? null,
			model: (finalRoute || primary).model,
			provider: (finalRoute || primary).provider,
			status: err?.status || 502,
			latency_ms: Date.now() - startTime,
			ip: clientIp,
			user_agent: clientUa,
			caller: normalized.caller,
			requested_thinking: normalized.requestedThinking,
			effective_thinking: primary.effectiveThinking,
			routing_version: primary.routingVersion,
			fallback_used: fallbackUsed ? 1 : 0,
			fallback_reason: fallbackReason,
			primary_model: primary.model,
			error_message: (err?.message || "Unknown error").slice(0, 500),
		}).catch((e) => console.error("Failed to write error log:", e?.message || e)),
	);
}

async function executeJson({
	env,
	ctx,
	auth,
	normalized,
	primary,
	startTime,
	clientIp,
	clientUa,
	providers,
}) {
	let fallbackUsed = false;
	let fallbackReason = null;
	let finalRoute = primary;
	try {
		const attempted = await attemptWithFallback(primary, (route) =>
			callProvider(providers, env, route, normalized.messages, false, undefined),
		);
		fallbackUsed = attempted.fallbackUsed;
		fallbackReason = attempted.fallbackReason;
		finalRoute = attempted.finalRoute;
		const { reply, usage } = attempted.result;
		try {
			await persistSuccess({
				env,
				auth,
				normalized,
				primary,
				finalRoute,
				fallbackUsed,
				fallbackReason,
				usage,
				startTime,
				clientIp,
				clientUa,
			});
		} catch (err) {
			console.error("Failed to record usage:", err?.message || err);
		}
		return Response.json({
			success: true,
			data: { reply },
		});
	} catch (err) {
		console.error("AI provider error:", err?.message || err);
		fallbackUsed = err.fallbackUsed || fallbackUsed;
		fallbackReason = err.fallbackReason || fallbackReason;
		finalRoute = err.finalRoute || finalRoute;
		await persistFailure({
			env,
			ctx,
			auth,
			normalized,
			primary,
			finalRoute,
			fallbackUsed,
			fallbackReason,
			startTime,
			clientIp,
			clientUa,
			err,
		});
		return Response.json({ error: "AI request failed" }, { status: 502 });
	}
}

async function executeStream({
	request,
	env,
	ctx,
	auth,
	normalized,
	primary,
	startTime,
	clientIp,
	clientUa,
	providers,
}) {
	let fallbackUsed = false;
	let fallbackReason = null;
	let finalRoute = primary;
	let upstream;
	try {
		const attempted = await attemptWithFallback(primary, (route) =>
			callProvider(providers, env, route, normalized.messages, true, request.signal),
		);
		fallbackUsed = attempted.fallbackUsed;
		fallbackReason = attempted.fallbackReason;
		finalRoute = attempted.finalRoute;
		upstream = attempted.result;
	} catch (err) {
		console.error("AI provider stream error:", err?.message || err);
		fallbackUsed = err.fallbackUsed || fallbackUsed;
		fallbackReason = err.fallbackReason || fallbackReason;
		finalRoute = err.finalRoute || finalRoute;
		await persistFailure({
			env,
			ctx,
			auth,
			normalized,
			primary,
			finalRoute,
			fallbackUsed,
			fallbackReason,
			startTime,
			clientIp,
			clientUa,
			err,
		});
		return Response.json({ error: "AI request failed" }, { status: 502 });
	}

	let clientStream;
	let usageStream;
	try {
		[clientStream, usageStream] = upstream.response.body.tee();
	} catch (err) {
		console.error("Failed to split stream:", err?.stack || err?.message || err);
		return Response.json({ error: "AI request failed" }, { status: 502 });
	}

	ctx.waitUntil(
		(async () => {
			try {
				const usage = await extractUsageFromSse(usageStream, { signal: request.signal });
				await persistSuccess({
					env,
					auth,
					normalized,
					primary,
					finalRoute,
					fallbackUsed,
					fallbackReason,
					usage,
					startTime,
					clientIp,
					clientUa,
				});
			} catch (err) {
				if (err?.name === "AbortError") return;
				console.error("Usage stream processing error:", err?.message || err);
				await writeRequestLog(env, {
					api_key_id: auth.apiKeyId ?? null,
					user_id: auth.userId ?? null,
					model: finalRoute.model,
					provider: finalRoute.provider,
					status: 200,
					latency_ms: Date.now() - startTime,
					ip: clientIp,
					user_agent: clientUa,
					caller: normalized.caller,
					requested_thinking: normalized.requestedThinking,
					effective_thinking: finalRoute.effectiveThinking,
					routing_version: finalRoute.routingVersion,
					fallback_used: fallbackUsed ? 1 : 0,
					fallback_reason: fallbackReason,
					primary_model: primary.model,
					error_message: (err?.message || "Usage processing error").slice(0, 500),
				}).catch(() => {});
			}
		})(),
	);

	return new Response(clientStream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
}

export { providerForModel };
