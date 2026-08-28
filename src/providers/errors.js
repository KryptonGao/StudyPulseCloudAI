export class ProviderError extends Error {
	constructor(message, { status = 502, retryable = false, provider = null, code = null } = {}) {
		super(message);
		this.name = "ProviderError";
		this.status = status;
		this.retryable = retryable;
		this.provider = provider;
		this.code = code;
	}
}

export function isRetryableProviderError(err) {
	if (!err) return false;
	if (err.name === "AbortError") return false;
	if (err instanceof ProviderError) return Boolean(err.retryable);
	return true;
}

export function classifyHttpStatus(status) {
	if (status >= 500 || status === 408 || status === 429) {
		return { retryable: true };
	}
	return { retryable: false };
}
