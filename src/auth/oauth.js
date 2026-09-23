import { createSessionWithMetadata } from "./session.js";
import { getUserByEmail, getUserById } from "../users/users.js";
import { sendVerificationCode, consumeVerificationCode } from "./email.js";
import { consumeAuthChallenge, createAuthChallenge, getAuthChallenge } from "./challenges.js";
import { createRemoteJWKSet, jwtVerify } from "jose";

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

export function handleGitHubStart(request, env) {
	const url = new URL(request.url);
	const state = randomToken("st_");
	const returnTo = safeReturnTo(url.searchParams.get("return_to"));
	const authUrl = new URL("https://github.com/login/oauth/authorize");
	authUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID || GITHUB_CLIENT_ID);
	authUrl.searchParams.set("redirect_uri", env.GITHUB_CALLBACK_URL || CALLBACK);
	authUrl.searchParams.set("scope", "read:user user:email");
	authUrl.searchParams.set("state", state);
	const cookie = `${COOKIE}=${encodeURIComponent(JSON.stringify({ state, returnTo }))}; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax`;
	return redirect(authUrl.toString(), 302, { "Set-Cookie": cookie });
}

export async function handleGitHubCallback(request, env) {
	const url = new URL(request.url);
	const state = url.searchParams.get("state");
	const cookie = request.headers.get("Cookie") || "";
	const raw = cookie.match(new RegExp(`${COOKIE}=([^;]+)`))?.[1];
	let stateData;
	try { stateData = JSON.parse(decodeURIComponent(raw || "")); } catch { stateData = null; }
	const returnTo = safeReturnTo(stateData?.returnTo);
	if (!state || !stateData || state !== stateData.state) return redirect(`${returnTo}?error=invalid_state`, 302);
	if (url.searchParams.get("error")) return redirect(`${returnTo}?error=github_denied`, 302);
	if (!env.GITHUB_CLIENT_SECRET) return redirect(`${returnTo}?error=server_not_configured`, 302);

	let tokenResponse;
	try {
		tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
			method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
			body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID || GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code: url.searchParams.get("code"), redirect_uri: env.GITHUB_CALLBACK_URL || CALLBACK }),
		});
	} catch (error) {
		console.error("GitHub token exchange failed:", error?.message || error);
		return redirect(`${returnTo}?error=github_token_exchange_failed`, 302);
	}
	const token = await tokenResponse.json().catch(() => ({}));
	if (!token.access_token) return redirect(`${returnTo}?error=github_token_exchange_failed`, 302);
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
		return redirect(`${returnTo}?error=github_profile_failed`, 302);
	}
	if (!profileResponse.ok || !emailsResponse.ok) {
		console.error("GitHub user lookup failed:", profileResponse.status, emailsResponse.status);
		return redirect(`${returnTo}?error=github_profile_failed`, 302);
	}
	const profile = await profileResponse.json().catch(() => ({}));
	const emails = await emailsResponse.json().catch(() => []);
	if (!profile.id) return redirect(`${returnTo}?error=github_profile_failed`, 302);
	const primary = Array.isArray(emails) ? emails.find((item) => item.primary && item.verified) || emails.find((item) => item.verified) : null;
	if (!primary?.email) {
		const challenge = await createAuthChallenge(env, {
			kind: "github_email_binding",
			payload: { githubId: String(profile.id), login: profile.login || null, avatarUrl: profile.avatar_url || null, returnTo },
		});
		return redirect(`${new URL(request.url).origin}/oauth/github/bind?challenge=${encodeURIComponent(challenge)}`, 302, {
			"Set-Cookie": `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`,
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
	if (user.status === "banned") return redirect(`${returnTo}?error=account_banned`, 302);
	const existingOAuth = await env.StudyPulseDB.prepare("SELECT user_id FROM user_oauth_accounts WHERE provider = 'github' AND provider_user_id = ?")
		.bind(String(profile.id)).first();
	if (existingOAuth && existingOAuth.user_id !== user.id) return redirect(`${returnTo}?error=github_already_bound`, 302);
	const existingEmailOAuth = await env.StudyPulseDB.prepare("SELECT user_id FROM user_oauth_accounts WHERE provider = 'github' AND provider_email = ?")
		.bind(email).first();
	if (existingEmailOAuth && existingEmailOAuth.user_id !== user.id) return redirect(`${returnTo}?error=github_email_already_bound`, 302);
	await env.StudyPulseDB.prepare(`INSERT INTO user_oauth_accounts (id, user_id, provider, provider_user_id, provider_email, username, avatar_url) VALUES (?, ?, 'github', ?, ?, ?, ?) ON CONFLICT(provider, provider_user_id) DO UPDATE SET user_id = excluded.user_id, provider_email = excluded.provider_email, username = excluded.username, avatar_url = excluded.avatar_url, updated_at = CURRENT_TIMESTAMP`)
		.bind(crypto.randomUUID(), user.id, String(profile.id), email, profile.login || null, profile.avatar_url || null).run();
	const session = await createSessionWithMetadata(user.id, env, { userAgent: request.headers.get("User-Agent") });
	const separator = returnTo.includes("?") ? "&" : "?";
	return redirect(`${returnTo}${separator}access_token=${encodeURIComponent(session.token)}&refresh_token=${encodeURIComponent(session.refreshToken)}`, 302, { "Set-Cookie": `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax` });
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

function googleStateCookie(value, maxAge = 600) {
	return `${GOOGLE_COOKIE}=${encodeURIComponent(JSON.stringify(value))}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
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

function googleFailure(returnTo, error) {
	return redirect(redirectWithQuery(returnTo, { error }), 302, {
		"Set-Cookie": googleStateCookie("", 0),
	});
}

export function handleGoogleStart(request, env) {
	const url = new URL(request.url);
	const returnTo = safeReturnTo(url.searchParams.get("return_to"));
	if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
		return googleFailure(returnTo, "server_not_configured");
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
		"Set-Cookie": googleStateCookie({ state, nonce, returnTo }),
	});
}

export async function handleGoogleCallback(request, env) {
	const url = new URL(request.url);
	const state = url.searchParams.get("state");
	const stateData = readJsonCookie(request, GOOGLE_COOKIE);
	const returnTo = safeReturnTo(stateData?.returnTo);
	if (!state || !stateData || state !== stateData.state) {
		return googleFailure(returnTo, "invalid_state");
	}
	if (url.searchParams.has("error")) return googleFailure(returnTo, "google_denied");
	if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
		return googleFailure(returnTo, "server_not_configured");
	}
	const code = url.searchParams.get("code");
	if (!code) return googleFailure(returnTo, "google_token_exchange_failed");

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
			return googleFailure(returnTo, "google_token_exchange_failed");
		}

		const verified = await jwtVerify(tokens.id_token, getGoogleJwks(), {
			issuer: ["https://accounts.google.com", "accounts.google.com"],
			audience: env.GOOGLE_CLIENT_ID,
			algorithms: ["RS256"],
		});
		const profile = verified.payload;
		if (typeof profile.sub !== "string" || !profile.sub || profile.sub.length > 255 || profile.nonce !== stateData.nonce) {
			return googleFailure(returnTo, "invalid_google_identity");
		}
		const email = typeof profile.email === "string" ? profile.email.trim().toLowerCase() : "";
		const emailVerified = profile.email_verified === true || profile.email_verified === "true";
		if (!emailVerified || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
			return googleFailure(returnTo, "google_email_required");
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
		if (!user) return googleFailure(returnTo, "google_account_failed");
		if (user.status === "banned") return googleFailure(returnTo, "account_banned");

		if (!existingAccount) {
			const existingEmailAccount = await db.prepare(
				"SELECT user_id FROM user_oauth_accounts WHERE provider = 'google' AND provider_email = ?",
			).bind(email).first();
			if (existingEmailAccount && existingEmailAccount.user_id !== user.id) {
				return googleFailure(returnTo, "google_account_conflict");
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
				return googleFailure(returnTo, "google_account_conflict");
			}
		}

		const session = await createSessionWithMetadata(user.id, env, {
			userAgent: request.headers.get("User-Agent"),
		});
		return redirect(redirectWithQuery(returnTo, {
			access_token: session.token,
			refresh_token: session.refreshToken,
		}), 302, { "Set-Cookie": googleStateCookie("", 0) });
	} catch (error) {
		console.warn("Google OAuth callback failed", { code: error?.code || "unknown" });
		return googleFailure(returnTo, "google_auth_failed");
	}
}
