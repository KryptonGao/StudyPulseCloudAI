import { createSessionWithMetadata } from "./session.js";
import { getUserByEmail, getUserById } from "../users/users.js";
import { sendVerificationCode, consumeVerificationCode } from "./email.js";
import { consumeAuthChallenge, createAuthChallenge, getAuthChallenge } from "./challenges.js";
import { createRemoteJWKSet, jwtVerify } from "jose";
import {
	authorizationCallbackUrl,
	createAuthorizationCode,
	parseOAuthAuthorizationRequest,
} from "./authorization-codes.js";

const GITHUB_CLIENT_ID = "Ov23lilABeGFN4QQdBHu";
const CALLBACK = "https://auth.chenkai.space/oauth/github/callback";
const COOKIE = "github_oauth_state";
const GOOGLE_CALLBACK = "https://auth.chenkai.space/oauth/google/callback";
const GOOGLE_COOKIE = "google_oauth_state";
const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
let googleJwksResolver;

function randomToken(prefix) {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return prefix + Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function redirect(url, status = 302, headers = {}) {
	return new Response(null, { status, headers: { Location: url, ...headers } });
}

function safeReturnTo(value) {
	if (typeof value === "string" && /^studypulse:\/\/auth\/callback(?:\?.*)?$/.test(value)) return value;
	try {
		const url = new URL(value);
		if (url.protocol === "https:" && url.hostname === "dash.studypulse.chenkai.space") {
			return url.pathname === "/" ? `${url.origin}/dashboard` : url.pathname.startsWith("/dashboard") ? value : "studypulse://auth/callback";
		}
	} catch { /* invalid return URL */ }
	return "studypulse://auth/callback";
}

function oauthContext(url, returnTo) {
	return parseOAuthAuthorizationRequest(url.searchParams, returnTo);
}

function stateCookie(name, value, maxAge = 600) {
	return `${name}=${encodeURIComponent(JSON.stringify(value))}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function clearStateCookie(name) {
	return `${name}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function githubFailure(returnTo, error, authorizationRequest = null) {
	const params = { error };
	if (authorizationRequest?.state) params.state = authorizationRequest.state;
	return redirect(redirectWithQuery(returnTo, params), 302, {
		"Set-Cookie": clearStateCookie(COOKIE),
	});
}

export function handleGitHubStart(request, env) {
	const url = new URL(request.url);
	const state = randomToken("st_");
	const returnTo = safeReturnTo(url.searchParams.get("return_to"));
	const authorization = oauthContext(url, returnTo);
	if (authorization.error) return githubFailure(returnTo, authorization.error, authorization.request);
	const authUrl = new URL("https://github.com/login/oauth/authorize");
	authUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID || GITHUB_CLIENT_ID);
	authUrl.searchParams.set("redirect_uri", env.GITHUB_CALLBACK_URL || CALLBACK);
	authUrl.searchParams.set("scope", "read:user user:email");
	authUrl.searchParams.set("state", state);
	const cookie = stateCookie(COOKIE, { state, returnTo, authorizationRequest: authorization.request });
	return redirect(authUrl.toString(), 302, { "Set-Cookie": cookie });
}

export async function handleGitHubCallback(request, env) {
	const url = new URL(request.url);
	const state = url.searchParams.get("state");
	const stateData = readJsonCookie(request, COOKIE);
	const returnTo = safeReturnTo(stateData?.returnTo);
	const authorizationRequest = stateData?.authorizationRequest || null;
	if (!state || !stateData || state !== stateData.state) return githubFailure(returnTo, "invalid_state", authorizationRequest);
	if (url.searchParams.get("error")) return githubFailure(returnTo, "github_denied", authorizationRequest);
	if (!env.GITHUB_CLIENT_SECRET) return githubFailure(returnTo, "server_not_configured", authorizationRequest);

	let tokenResponse;
	try {
		tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
			method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
			body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID || GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code: url.searchParams.get("code"), redirect_uri: env.GITHUB_CALLBACK_URL || CALLBACK }),
		});
	} catch (error) {
		console.error("GitHub token exchange failed:", error?.message || error);
		return githubFailure(returnTo, "github_token_exchange_failed", authorizationRequest);
	}
	const token = await tokenResponse.json().catch(() => ({}));
	if (!token.access_token) return githubFailure(returnTo, "github_token_exchange_failed", authorizationRequest);
	const githubHeaders = {
		Authorization: `Bearer ${token.access_token}`,
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent": "StudyPulse-Cloud-AI",
	};
	let profileResponse;
	let emailsResponse;
	try {
		[profileResponse, emailsResponse] = await Promise.all([
			fetch("https://api.github.com/user", { headers: githubHeaders }),
			fetch("https://api.github.com/user/emails", { headers: githubHeaders }),
		]);
	} catch (error) {
		console.error("GitHub user lookup request failed:", error?.message || error);
		return githubFailure(returnTo, "github_profile_failed", authorizationRequest);
	}
	if (!profileResponse.ok || !emailsResponse.ok) {
		console.error("GitHub user lookup failed:", profileResponse.status, emailsResponse.status);
		return githubFailure(returnTo, "github_profile_failed", authorizationRequest);
	}
	const profile = await profileResponse.json().catch(() => ({}));
	const emails = await emailsResponse.json().catch(() => []);
	if (!profile.id) return githubFailure(returnTo, "github_profile_failed", authorizationRequest);
	const primary = Array.isArray(emails) ? emails.find((item) => item.primary && item.verified) || emails.find((item) => item.verified) : null;
	if (!primary?.email) {
		const challenge = await createAuthChallenge(env, {
			kind: "github_email_binding",
			payload: { githubId: String(profile.id), login: profile.login || null, avatarUrl: profile.avatar_url || null, returnTo, authorizationRequest },
		});
		return redirect(`${new URL(request.url).origin}/oauth/github/bind?challenge=${encodeURIComponent(challenge)}`, 302, {
			"Set-Cookie": clearStateCookie(COOKIE),
		});
	}
	const email = primary.email.trim().toLowerCase();
	let user = await getUserByEmail(email, env);
	if (!user) {
		const id = crypto.randomUUID();
		await env.StudyPulseDB.prepare(`INSERT OR IGNORE INTO users (id, email, email_normalized, email_verified, role, membership_type, username, avatar_url) VALUES (?, ?, ?, 1, 'user', 'free', ?, ?)`)
			.bind(id, email, email, profile.login || null, profile.avatar_url || null).run();
		user = await getUserByEmail(email, env);
	}
	if (user.status === "banned") return githubFailure(returnTo, "account_banned", authorizationRequest);
	const existingOAuth = await env.StudyPulseDB.prepare("SELECT user_id FROM user_oauth_accounts WHERE provider = 'github' AND provider_user_id = ?")
		.bind(String(profile.id)).first();
	if (existingOAuth && existingOAuth.user_id !== user.id) return githubFailure(returnTo, "github_already_bound", authorizationRequest);
	const existingEmailOAuth = await env.StudyPulseDB.prepare("SELECT user_id FROM user_oauth_accounts WHERE provider = 'github' AND provider_email = ?")
		.bind(email).first();
	if (existingEmailOAuth && existingEmailOAuth.user_id !== user.id) return githubFailure(returnTo, "github_email_already_bound", authorizationRequest);
	await env.StudyPulseDB.prepare(`INSERT INTO user_oauth_accounts (id, user_id, provider, provider_user_id, provider_email, username, avatar_url) VALUES (?, ?, 'github', ?, ?, ?, ?) ON CONFLICT(provider, provider_user_id) DO UPDATE SET user_id = excluded.user_id, provider_email = excluded.provider_email, username = excluded.username, avatar_url = excluded.avatar_url, updated_at = CURRENT_TIMESTAMP`)
		.bind(crypto.randomUUID(), user.id, String(profile.id), email, profile.login || null, profile.avatar_url || null).run();
	const clearCookie = { "Set-Cookie": clearStateCookie(COOKIE) };
	if (authorizationRequest) {
		const code = await createAuthorizationCode(user.id, authorizationRequest, env);
		return redirect(authorizationCallbackUrl(authorizationRequest, code), 302, clearCookie);
	}
	const session = await createSessionWithMetadata(user.id, env, { userAgent: request.headers.get("User-Agent") });
	return redirect(redirectWithQuery(returnTo, {
		access_token: session.token,
		refresh_token: session.refreshToken,
	}), 302, clearCookie);
}

export async function handleGitHubBindSendCode(request, env) {
	let body;
	try { body = await request.json(); } catch { return Response.json({ success: false, error: { message: "请求参数无效" } }, { status: 400 }); }
	const challenge = await getAuthChallenge(body?.challenge, env, "github_email_binding");
	if (!challenge) return Response.json({ success: false, error: { message: "绑定链接已失效，请重新使用 GitHub 登录" } }, { status: 401 });
	const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
	const result = await sendVerificationCode(email, env, "github_bind");
	if (!result.success) return Response.json({ success: false, error: { message: result.error === "Please wait before requesting a new code" ? "请稍后再试" : "无法发送验证码" } }, { status: 400 });
	return Response.json({ success: true });
}

export async function handleGitHubBindVerify(request, env) {
	let body;
	try { body = await request.json(); } catch { return Response.json({ success: false, error: { message: "请求参数无效" } }, { status: 400 }); }
	const challenge = await getAuthChallenge(body?.challenge, env, "github_email_binding");
	if (!challenge) return Response.json({ success: false, error: { message: "绑定链接已失效，请重新使用 GitHub 登录" } }, { status: 401 });
	const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
	const verified = await consumeVerificationCode(email, body?.code, env, "github_bind");
	if (!verified.success) return Response.json({ success: false, error: { message: "验证码无效或已过期" } }, { status: 400 });
	let user = await getUserByEmail(email, env);
	if (!user) {
		const id = crypto.randomUUID();
		await env.StudyPulseDB.prepare(`INSERT OR IGNORE INTO users (id, email, email_normalized, email_verified, role, membership_type, username, avatar_url) VALUES (?, ?, ?, 1, 'user', 'free', ?, ?)`)
			.bind(id, email, email, challenge.payload?.login || null, challenge.payload?.avatarUrl || null).run();
		user = await getUserByEmail(email, env);
	}
	if (user.status === "banned") return Response.json({ success: false, error: { message: "该账号已被暂停" } }, { status: 403 });
	const existing = await env.StudyPulseDB.prepare("SELECT user_id FROM user_oauth_accounts WHERE provider = 'github' AND provider_user_id = ?").bind(challenge.payload?.githubId || "").first();
	if (existing && existing.user_id !== user.id) return Response.json({ success: false, error: { message: "该 GitHub 已绑定其他账号" } }, { status: 409 });
	if (!(await consumeAuthChallenge(challenge.id, env))) return Response.json({ success: false, error: { message: "绑定链接已失效，请重新开始" } }, { status: 401 });
	await env.StudyPulseDB.prepare(`INSERT INTO user_oauth_accounts (id, user_id, provider, provider_user_id, provider_email, username, avatar_url) VALUES (?, ?, 'github', ?, ?, ?, ?) ON CONFLICT(provider, provider_user_id) DO UPDATE SET user_id = excluded.user_id, provider_email = excluded.provider_email, username = excluded.username, avatar_url = excluded.avatar_url, updated_at = CURRENT_TIMESTAMP`)
		.bind(crypto.randomUUID(), user.id, challenge.payload?.githubId || "", email, challenge.payload?.login || null, challenge.payload?.avatarUrl || null).run();
	const authorizationRequest = challenge.payload?.authorizationRequest || null;
	if (authorizationRequest) {
		const code = await createAuthorizationCode(user.id, authorizationRequest, env);
		return Response.json({ success: true, data: { redirect_uri: authorizationCallbackUrl(authorizationRequest, code) } });
	}
	const session = await createSessionWithMetadata(user.id, env, { userAgent: request.headers.get("User-Agent") });
	return Response.json({ success: true, data: { access_token: session.token, refresh_token: session.refreshToken, return_to: challenge.payload?.returnTo || "studypulse://auth/callback" } });
}

function readJsonCookie(request, name) {
	const entry = (request.headers.get("Cookie") || "")
		.split(";")
		.map((part) => part.trim())
		.find((part) => part.startsWith(`${name}=`));
	if (!entry) return null;
	try {
		return JSON.parse(decodeURIComponent(entry.slice(name.length + 1)));
	} catch {
		return null;
	}
}

function getGoogleJwks() {
	if (!googleJwksResolver) {
		googleJwksResolver = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
	}
	return googleJwksResolver;
}

function redirectWithQuery(url, params) {
	const target = new URL(url);
	for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
	return target.toString();
}

function googleFailure(returnTo, error, authorizationRequest = null) {
	const params = { error };
	if (authorizationRequest?.state) params.state = authorizationRequest.state;
	return redirect(redirectWithQuery(returnTo, params), 302, {
		"Set-Cookie": clearStateCookie(GOOGLE_COOKIE),
	});
}

export function handleGoogleStart(request, env) {
	const url = new URL(request.url);
	const returnTo = safeReturnTo(url.searchParams.get("return_to"));
	const authorization = oauthContext(url, returnTo);
	if (authorization.error) return googleFailure(returnTo, authorization.error, authorization.request);
	if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
		return googleFailure(returnTo, "server_not_configured", authorization.request);
	}

	const state = randomToken("st_");
	const nonce = randomToken("nonce_");
	const authUrl = new URL(GOOGLE_AUTHORIZE_URL);
	authUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
	authUrl.searchParams.set("redirect_uri", env.GOOGLE_CALLBACK_URL || GOOGLE_CALLBACK);
	authUrl.searchParams.set("response_type", "code");
	authUrl.searchParams.set("scope", "openid email profile");
	authUrl.searchParams.set("state", state);
	authUrl.searchParams.set("nonce", nonce);
	return redirect(authUrl.toString(), 302, {
		"Set-Cookie": stateCookie(GOOGLE_COOKIE, { state, nonce, returnTo, authorizationRequest: authorization.request }),
	});
}

export async function handleGoogleCallback(request, env) {
	const url = new URL(request.url);
	const state = url.searchParams.get("state");
	const stateData = readJsonCookie(request, GOOGLE_COOKIE);
	const returnTo = safeReturnTo(stateData?.returnTo);
	const authorizationRequest = stateData?.authorizationRequest || null;
	if (!state || !stateData || state !== stateData.state) {
		return googleFailure(returnTo, "invalid_state", authorizationRequest);
	}
	if (url.searchParams.has("error")) return googleFailure(returnTo, "google_denied", authorizationRequest);
	if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
		return googleFailure(returnTo, "server_not_configured", authorizationRequest);
	}
	const code = url.searchParams.get("code");
	if (!code) return googleFailure(returnTo, "google_token_exchange_failed", authorizationRequest);

	try {
		const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
			body: new URLSearchParams({
				code,
				client_id: env.GOOGLE_CLIENT_ID,
				client_secret: env.GOOGLE_CLIENT_SECRET,
				redirect_uri: env.GOOGLE_CALLBACK_URL || GOOGLE_CALLBACK,
				grant_type: "authorization_code",
			}),
		});
		const tokens = await tokenResponse.json().catch(() => null);
		if (!tokenResponse.ok || typeof tokens?.id_token !== "string") {
			console.warn("Google OAuth token exchange rejected", { status: tokenResponse.status });
			return googleFailure(returnTo, "google_token_exchange_failed", authorizationRequest);
		}

		const verified = await jwtVerify(tokens.id_token, getGoogleJwks(), {
			issuer: ["https://accounts.google.com", "accounts.google.com"],
			audience: env.GOOGLE_CLIENT_ID,
			algorithms: ["RS256"],
		});
		const profile = verified.payload;
		if (typeof profile.sub !== "string" || !profile.sub || profile.sub.length > 255 || profile.nonce !== stateData.nonce) {
			return googleFailure(returnTo, "invalid_google_identity", authorizationRequest);
		}
		const email = typeof profile.email === "string" ? profile.email.trim().toLowerCase() : "";
		const emailVerified = profile.email_verified === true || profile.email_verified === "true";
		if (!emailVerified || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
			return googleFailure(returnTo, "google_email_required", authorizationRequest);
		}

		const db = env.StudyPulseDB;
		const existingAccount = await db.prepare(
			"SELECT user_id FROM user_oauth_accounts WHERE provider = 'google' AND provider_user_id = ?",
		).bind(profile.sub).first();
		let user = existingAccount
			? await getUserById(existingAccount.user_id, env)
			: await getUserByEmail(email, env);
		if (!user) {
			const userId = crypto.randomUUID();
			const username = typeof profile.name === "string" ? profile.name.trim().slice(0, 200) || null : null;
			const avatarUrl = typeof profile.picture === "string" ? profile.picture.slice(0, 2000) : null;
			await db.prepare(
				`INSERT OR IGNORE INTO users (id, email, email_normalized, email_verified, role, membership_type, username, avatar_url)
				 VALUES (?, ?, ?, 1, 'user', 'free', ?, ?)`,
			).bind(userId, email, email, username, avatarUrl).run();
			user = await getUserByEmail(email, env);
		}
		if (!user) return googleFailure(returnTo, "google_account_failed", authorizationRequest);
		if (user.status === "banned") return googleFailure(returnTo, "account_banned", authorizationRequest);

		if (!existingAccount) {
			const existingEmailAccount = await db.prepare(
				"SELECT user_id FROM user_oauth_accounts WHERE provider = 'google' AND provider_email = ?",
			).bind(email).first();
			if (existingEmailAccount && existingEmailAccount.user_id !== user.id) {
				return googleFailure(returnTo, "google_account_conflict", authorizationRequest);
			}
			const username = typeof profile.name === "string" ? profile.name.trim().slice(0, 200) || null : null;
			const avatarUrl = typeof profile.picture === "string" ? profile.picture.slice(0, 2000) : null;
			await db.prepare(
				`INSERT OR IGNORE INTO user_oauth_accounts
				 (id, user_id, provider, provider_user_id, provider_email, username, avatar_url)
				 VALUES (?, ?, 'google', ?, ?, ?, ?)`,
			).bind(crypto.randomUUID(), user.id, profile.sub, email, username, avatarUrl).run();
			const linkedAccount = await db.prepare(
				"SELECT user_id FROM user_oauth_accounts WHERE provider = 'google' AND provider_user_id = ?",
			).bind(profile.sub).first();
			if (!linkedAccount || linkedAccount.user_id !== user.id) {
				return googleFailure(returnTo, "google_account_conflict", authorizationRequest);
			}
		}

		if (authorizationRequest) {
			const code = await createAuthorizationCode(user.id, authorizationRequest, env);
			return redirect(authorizationCallbackUrl(authorizationRequest, code), 302, {
				"Set-Cookie": clearStateCookie(GOOGLE_COOKIE),
			});
		}
		const session = await createSessionWithMetadata(user.id, env, {
			userAgent: request.headers.get("User-Agent"),
		});
		return redirect(redirectWithQuery(returnTo, {
			access_token: session.token,
			refresh_token: session.refreshToken,
		}), 302, { "Set-Cookie": clearStateCookie(GOOGLE_COOKIE) });
	} catch (error) {
		console.warn("Google OAuth callback failed", { code: error?.code || "unknown" });
		return googleFailure(returnTo, "google_auth_failed", authorizationRequest);
	}
}
