import { sha256Hex } from "../auth.js";

export const NATIVE_AUTH_REDIRECT_URI = "studypulse://auth/callback";

const STATE_RE = /^[A-Za-z0-9._~-]{16,256}$/;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

export function parseOAuthAuthorizationRequest(params, returnTo) {
	const responseType = params.get("response_type");
	if (responseType === null) return { request: null, error: null };
	if (responseType !== "code") return { request: null, error: "unsupported_response_type" };
	if (returnTo !== NATIVE_AUTH_REDIRECT_URI) return { request: null, error: "invalid_redirect_uri" };

	const state = params.get("state") || "";
	const codeChallenge = params.get("code_challenge") || "";
	if (!STATE_RE.test(state)) return { request: null, error: "invalid_state" };
	if (!CHALLENGE_RE.test(codeChallenge) || params.get("code_challenge_method") !== "S256") {
		return { request: null, error: "invalid_code_challenge" };
	}
	return {
		request: {
			state,
			codeChallenge,
			redirectUri: NATIVE_AUTH_REDIRECT_URI,
		},
		error: null,
	};
}

export function parseAuthorizationCodeRequest(body) {
	if (body?.response_type !== "code") return { request: null, error: "unsupported_response_type" };
	if (body?.redirect_uri !== NATIVE_AUTH_REDIRECT_URI) return { request: null, error: "invalid_redirect_uri" };
	const params = new URLSearchParams({
		response_type: String(body.response_type || ""),
		state: typeof body.state === "string" ? body.state : "",
		code_challenge: typeof body.code_challenge === "string" ? body.code_challenge : "",
		code_challenge_method: typeof body.code_challenge_method === "string" ? body.code_challenge_method : "",
	});
	return parseOAuthAuthorizationRequest(params, body.redirect_uri);
}

export async function createAuthorizationCode(userId, authorizationRequest, env) {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	const code = `ac_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
	const codeHash = await sha256Hex(code);
	const now = new Date();
	const expiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
	await env.StudyPulseDB.prepare(
		"DELETE FROM oauth_authorization_codes WHERE expires_at <= ?",
	).bind(now.toISOString()).run();
	await env.StudyPulseDB.prepare(
		`INSERT INTO oauth_authorization_codes
			 (code_hash, user_id, code_challenge, redirect_uri, expires_at)
		 VALUES (?, ?, ?, ?, ?)`,
	).bind(codeHash, userId, authorizationRequest.codeChallenge, authorizationRequest.redirectUri, expiresAt).run();
	return code;
}

export function authorizationCallbackUrl(authorizationRequest, code) {
	const callback = new URL(authorizationRequest.redirectUri);
	callback.searchParams.set("code", code);
	callback.searchParams.set("state", authorizationRequest.state);
	return callback.toString();
}

export function isValidCodeVerifier(value) {
	return typeof value === "string" && VERIFIER_RE.test(value);
}

export function codeChallengeForVerifier(value) {
	return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)).then((digest) => {
		const bytes = new Uint8Array(digest);
		let binary = "";
		for (const byte of bytes) binary += String.fromCharCode(byte);
		return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
	});
}

export function timingSafeEqual(left, right) {
	if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false;
	let difference = 0;
	for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
	return difference === 0;
}

export async function consumeAuthorizationCode(code, codeVerifier, redirectUri, env) {
	if (typeof code !== "string" || !/^ac_[a-f0-9]{64}$/.test(code) || !isValidCodeVerifier(codeVerifier)) return null;
	if (redirectUri !== NATIVE_AUTH_REDIRECT_URI) return null;
	const codeHash = await sha256Hex(code);
	const now = new Date().toISOString();
	const record = await env.StudyPulseDB.prepare(
		`SELECT user_id, code_challenge
		   FROM oauth_authorization_codes
		  WHERE code_hash = ?
		    AND redirect_uri = ?
		    AND consumed_at IS NULL
		    AND expires_at > ?`,
	).bind(codeHash, redirectUri, now).first();
	if (!record) return null;
	const verifierChallenge = await codeChallengeForVerifier(codeVerifier);
	if (!timingSafeEqual(verifierChallenge, record.code_challenge)) return null;

	const consumedAt = new Date().toISOString();
	const result = await env.StudyPulseDB.prepare(
		`UPDATE oauth_authorization_codes
		    SET consumed_at = ?
		  WHERE code_hash = ?
		    AND redirect_uri = ?
		    AND consumed_at IS NULL
		    AND expires_at > ?`,
	).bind(consumedAt, codeHash, redirectUri, consumedAt).run();
	if (Number(result.meta?.changes || 0) !== 1) return null;
	return record;
}
