import { sendVerificationCode, consumeVerificationCode } from "./email.js";
import {
	createSessionWithMetadata,
	refreshSession,
	revokeAllSessions,
	revokeSessionById,
} from "./session.js";
import { requireSessionAuth } from "./middleware.js";
import { getUserById, getUserByEmail } from "../users/users.js";
import {
	clearFailedLogins,
	getCredentialByEmail,
	getCredentialByUserId,
	recordFailedLogin,
	savePassword,
} from "../database/credentials.js";
import {
	DEFAULT_PASSWORD_COST,
	needsPasswordRehash,
	validatePassword,
	verifyPassword,
} from "../security/password.js";
import {
	checkLoginRateLimits,
	getRequestIp,
	resetLoginRateLimits,
} from "../security/rateLimit.js";
import { sha256Hex } from "../auth.js";
import { consumeAuthChallenge, createAuthChallenge, getAuthChallenge } from "./challenges.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GENERIC_RESET_MESSAGE = "如果该邮箱已注册，我们已经发送验证码";

function genericResetResponse() {
	return Response.json({ success: true, message: GENERIC_RESET_MESSAGE });
}

function normalizeEmail(value) {
	return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function ok(data = {}) {
	return Response.json({ success: true, data });
}

function fail(code, message, status = 400) {
	return Response.json({ success: false, error: { code, message } }, { status });
}

function parseBodyError(error) {
	return error instanceof SyntaxError
		? fail("INVALID_REQUEST", "请求体必须是有效 JSON")
		: fail("INVALID_REQUEST", "请求参数无效");
}

async function readJson(request) {
	try {
		return { body: await request.json() };
	} catch (error) {
		return { error: parseBodyError(error) };
	}
}

function validateEmail(email) {
	if (!email || !EMAIL_RE.test(email)) {
		return fail("INVALID_EMAIL", "请输入有效的邮箱地址");
	}
	return null;
}

function validatePasswordInput(password) {
	const result = validatePassword(password);
	return result.valid ? null : fail(result.code, result.message);
}

function sessionMetadata(request, deviceName) {
	return sha256Hex(getRequestIp(request)).then((ipAddress) => ({
		deviceName: typeof deviceName === "string" ? deviceName.trim().slice(0, 200) || null : null,
		userAgent: request.headers.get("User-Agent")?.slice(0, 500) || null,
		ipAddress,
	}));
}

function sessionPayload(session, user) {
	return {
		access_token: session.token,
		refresh_token: session.refreshToken,
		session_token: session.token,
		token: session.token,
		expires_at: session.expiresAt,
		refresh_expires_at: session.refreshExpiresAt,
		user: { id: user.id, email: user.email },
	};
}

function sessionAuthFailure(request, auth) {
	if (auth.response?.status === 403) return fail("FORBIDDEN", "该接口仅支持 Session Token", 403);
	const token = request.headers.get("Authorization") || "";
	return token.startsWith("Bearer sp_sess_")
		? fail("SESSION_EXPIRED", "登录状态已失效，请重新登录", 401)
		: fail("UNAUTHORIZED", "请先登录", 401);
}

async function createUserIfNeeded(email, env) {
	const existing = await getUserByEmail(email, env);
	if (existing) return existing;
	const userId = crypto.randomUUID();
	await env.StudyPulseDB.prepare(
		`INSERT OR IGNORE INTO users
			 (id, email, email_normalized, email_verified, role, membership_type)
		 VALUES (?, ?, ?, 1, 'user', 'free')`,
	).bind(userId, email, email).run();
	return getUserByEmail(email, env);
}

export async function handlePasswordLogin(request, env) {
	const parsed = await readJson(request);
	if (parsed.error) return parsed.error;
	const email = normalizeEmail(parsed.body?.email);
	const emailError = validateEmail(email);
	if (emailError) return emailError;
	if (typeof parsed.body?.password !== "string") {
		return fail("INVALID_REQUEST", "password 必须是字符串");
	}

	const rate = await checkLoginRateLimits(email, request, env);
	if (!rate.allowed) {
		const response = fail("RATE_LIMITED", "请求过于频繁，请稍后再试", 429);
		response.headers.set("Retry-After", String(rate.retryAfterSeconds || 30));
		return response;
	}

	const credential = await getCredentialByEmail(email, env);
	const locked = credential?.locked_until && Date.now() < new Date(credential.locked_until).getTime();
	const verified = !locked && credential?.password_hash
		? await verifyPassword(parsed.body.password, credential)
		: false;
	if (!verified) {
		if (credential?.user_id && !locked) {
			const nextFailure = Number(credential.failed_login_count || 0) + 1;
			const lockUntil = nextFailure >= 5 ? new Date(Date.now() + 10 * 60_000).toISOString() : null;
			await recordFailedLogin(credential.user_id, env, lockUntil);
		}
		console.warn("password_login_failed", {
			user_id: credential?.user_id || null,
			failure_type: locked ? "account_locked" : credential?.password_hash ? "password_mismatch" : "credential_missing",
		});
		return fail("INVALID_CREDENTIALS", "邮箱或密码错误", 401);
	}

	await clearFailedLogins(credential.user_id, env);
	await resetLoginRateLimits(email, request, env);
	const configuredCost = Number(env.PASSWORD_BCRYPT_COST || DEFAULT_PASSWORD_COST);
	if (needsPasswordRehash(credential, { cost: configuredCost })) {
		await savePassword(credential.user_id, parsed.body.password, env, { cost: configuredCost });
	}
	const user = await getUserById(credential.user_id, env);
	if (user?.status === "banned") return fail("ACCOUNT_BANNED", "账号已被暂停，请通过申诉链接提交申诉", 403);
	const session = await createSessionWithMetadata(
		credential.user_id,
		env,
		await sessionMetadata(request, parsed.body?.device_name),
	);
	return ok(sessionPayload(session, user));
}

export async function handleRegisterVerify(request, env) {
	const parsed = await readJson(request);
	if (parsed.error) return parsed.error;
	const email = normalizeEmail(parsed.body?.email);
	const emailError = validateEmail(email);
	if (emailError) return emailError;
	const passwordError = validatePasswordInput(parsed.body?.password);
	if (passwordError) return passwordError;
	if (typeof parsed.body?.code !== "string" || !/^\d{6}$/.test(parsed.body.code)) {
		return fail("INVALID_VERIFICATION_CODE", "验证码无效");
	}

	const consumed = await consumeVerificationCode(email, parsed.body.code, env, "register");
	if (!consumed.success) return verificationFailure(consumed);
	const user = await createUserIfNeeded(email, env);
	const existingCredential = await getCredentialByUserId(user.id, env);
	if (existingCredential) {
		return fail("EMAIL_ALREADY_REGISTERED", "该邮箱已注册，请直接登录或重置密码", 409);
	}
	await savePassword(user.id, parsed.body.password, env, {
		cost: Number(env.PASSWORD_BCRYPT_COST || DEFAULT_PASSWORD_COST),
	});
	const session = await createSessionWithMetadata(
		user.id,
		env,
		await sessionMetadata(request, parsed.body?.device_name),
	);
	return ok(sessionPayload(session, user));
}

function verificationFailure(result) {
	if (result.error === "Verification code expired") {
		return fail("VERIFICATION_CODE_EXPIRED", "验证码已过期");
	}
	if (result.error === "Verification code locked due to too many attempts") {
		return fail("RATE_LIMITED", "验证码尝试次数过多，请重新获取验证码", 429);
	}
	return fail("INVALID_VERIFICATION_CODE", "验证码无效");
}

export async function handlePasswordResetRequest(request, env) {
	const parsed = await readJson(request);
	if (parsed.error) return parsed.error;
	const email = normalizeEmail(parsed.body?.email);
	const emailError = validateEmail(email);
	if (emailError) return emailError;
	const user = await getUserByEmail(email, env);
	if (user) {
		const result = await sendVerificationCode(email, env, "reset_password");
		if (!result.success && result.error === "Please wait before requesting a new code") {
			return genericResetResponse();
		}
		// Delivery errors intentionally keep the same response to avoid account enumeration.
	}
	return genericResetResponse();
}

export async function handlePasswordReset(request, env) {
	const parsed = await readJson(request);
	if (parsed.error) return parsed.error;
	const email = normalizeEmail(parsed.body?.email);
	const emailError = validateEmail(email);
	if (emailError) return emailError;
	const passwordError = validatePasswordInput(parsed.body?.new_password);
	if (passwordError) return passwordError;
	if (typeof parsed.body?.code !== "string" || !/^\d{6}$/.test(parsed.body.code)) {
		return fail("INVALID_VERIFICATION_CODE", "验证码无效");
	}
	const consumed = await consumeVerificationCode(email, parsed.body.code, env, "reset_password");
	if (!consumed.success) return verificationFailure(consumed);
	const user = await getUserByEmail(email, env);
	if (!user) return fail("INVALID_VERIFICATION_CODE", "验证码无效");
	await savePassword(user.id, parsed.body.new_password, env, {
		cost: Number(env.PASSWORD_BCRYPT_COST || DEFAULT_PASSWORD_COST),
	});
	await revokeAllSessions(user.id, env);
	return ok({ user: { id: user.id, email: user.email } });
}

export async function handlePasswordChange(request, env) {
	const auth = await requireSessionAuth(request, env);
	if (!auth.ok) return sessionAuthFailure(request, auth);
	const parsed = await readJson(request);
	if (parsed.error) return parsed.error;
	if (typeof parsed.body?.current_password !== "string") {
		return fail("INVALID_REQUEST", "current_password 必须是字符串");
	}
	const passwordError = validatePasswordInput(parsed.body?.new_password);
	if (passwordError) return passwordError;
	const credential = await getCredentialByUserId(auth.userId, env);
	if (!credential || !(await verifyPassword(parsed.body.current_password, credential))) {
		return fail("INVALID_CREDENTIALS", "当前密码错误", 401);
	}
	if (await verifyPassword(parsed.body.new_password, credential)) {
		return fail("PASSWORD_UNCHANGED", "新密码不能与旧密码相同", 409);
	}
	await savePassword(auth.userId, parsed.body.new_password, env, {
		cost: Number(env.PASSWORD_BCRYPT_COST || DEFAULT_PASSWORD_COST),
	});
	await revokeAllSessions(auth.userId, env);
	const user = await getUserById(auth.userId, env);
	const session = await createSessionWithMetadata(
		auth.userId,
		env,
		await sessionMetadata(request, null),
	);
	return ok(sessionPayload(session, user));
}

export async function handleLogoutCurrent(request, env) {
	const auth = await requireSessionAuth(request, env);
	if (!auth.ok) return sessionAuthFailure(request, auth);
	await revokeSessionById(auth.sessionId, env);
	return ok({});
}

export async function handleLogoutAll(request, env) {
	const auth = await requireSessionAuth(request, env);
	if (!auth.ok) return sessionAuthFailure(request, auth);
	await revokeAllSessions(auth.userId, env);
	return ok({});
}

export async function handleMe(request, env) {
	const auth = await requireSessionAuth(request, env);
	if (!auth.ok) return sessionAuthFailure(request, auth);
	const user = await getUserById(auth.userId, env);
	if (!user) return fail("UNAUTHORIZED", "用户不存在", 401);
	const credential = await getCredentialByUserId(auth.userId, env);
	const oauthAccounts = await env.StudyPulseDB.prepare(
		"SELECT DISTINCT provider FROM user_oauth_accounts WHERE user_id = ?",
	).bind(auth.userId).all();
	const oauthLoginMethods = (oauthAccounts.results || [])
		.map((account) => account.provider)
		.filter((provider) => provider === "github" || provider === "google");
	return ok({
		user: { id: user.id, email: user.email },
		login_methods: ["email_code", ...(credential ? ["password"] : []), ...oauthLoginMethods],
		auth_type: auth.authType,
	});
}

export async function handleAuthSendCode(request, env, legacy = false) {
	const parsed = await readJson(request);
	if (parsed.error) return parsed.error;
	const email = normalizeEmail(parsed.body?.email);
	const emailError = validateEmail(email);
	if (emailError) return legacy ? Response.json({ error: "Invalid email format" }, { status: 400 }) : emailError;
	const purpose = parsed.body?.purpose || "login";
	const result = await sendVerificationCode(email, env, purpose);
	if (!result.success) {
		if (legacy) {
			const status = result.error === "Please wait before requesting a new code" ? 429 : result.error === "Email delivery failed" ? 502 : 400;
			return Response.json({ error: result.error }, { status });
		}
		return result.error === "Please wait before requesting a new code"
			? fail("RATE_LIMITED", "请求过于频繁，请稍后再试", 429)
			: fail("INVALID_REQUEST", "无法发送验证码");
	}
	return legacy ? Response.json({ success: true }) : ok({});
}

export async function handleCodeLogin(request, env) {
	const parsed = await readJson(request);
	if (parsed.error) return parsed.error;
	const email = normalizeEmail(parsed.body?.email);
	const emailError = validateEmail(email);
	if (emailError) return emailError;
	if (typeof parsed.body?.code !== "string" || !/^\d{6}$/.test(parsed.body.code)) {
		return fail("INVALID_VERIFICATION_CODE", "验证码无效");
	}
	const consumed = await consumeVerificationCode(email, parsed.body.code, env, "login");
	if (!consumed.success) return verificationFailure(consumed);
	const user = await createUserIfNeeded(email, env);
	if (user.status === "banned") return fail("ACCOUNT_BANNED", "账号已被暂停", 403);
	await env.StudyPulseDB.prepare(
		"UPDATE users SET email_verified = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
	).bind(user.id).run();
	const credential = await getCredentialByUserId(user.id, env);
	if (!credential) {
		const setupToken = await createAuthChallenge(env, {
			kind: "password_setup",
			userId: user.id,
			email,
		});
		return ok({
			requires_password_setup: true,
			setup_token: setupToken,
			user: { id: user.id, email },
		});
	}
	const session = await createSessionWithMetadata(user.id, env, await sessionMetadata(request, parsed.body?.device_name));
	return ok(sessionPayload(session, { ...user, email }));
}

export async function handlePasswordSetupAfterCode(request, env) {
	const parsed = await readJson(request);
	if (parsed.error) return parsed.error;
	const passwordError = validatePasswordInput(parsed.body?.password);
	if (passwordError) return passwordError;
	const challenge = await getAuthChallenge(parsed.body?.setup_token, env, "password_setup");
	if (!challenge) return fail("AUTH_CHALLENGE_EXPIRED", "设置密码链接已失效，请重新使用验证码登录", 401);
	const user = await getUserById(challenge.user_id, env);
	if (!user) return fail("AUTH_CHALLENGE_EXPIRED", "设置密码链接已失效，请重新使用验证码登录", 401);
	if (await getCredentialByUserId(user.id, env)) {
		return fail("PASSWORD_ALREADY_SET", "该账号已设置密码，请直接登录", 409);
	}
	if (!(await consumeAuthChallenge(challenge.id, env))) {
		return fail("AUTH_CHALLENGE_EXPIRED", "设置密码链接已失效，请重新使用验证码登录", 401);
	}
	await savePassword(user.id, parsed.body.password, env, {
		cost: Number(env.PASSWORD_BCRYPT_COST || DEFAULT_PASSWORD_COST),
	});
	const session = await createSessionWithMetadata(
		user.id,
		env,
		await sessionMetadata(request, parsed.body?.device_name),
	);
	return ok(sessionPayload(session, user));
}

export async function handleRefresh(request, env) {
	const parsed = await readJson(request);
	if (parsed.error) return parsed.error;
	const session = await refreshSession(parsed.body?.refresh_token, env);
	if (!session) return fail("INVALID_REFRESH_TOKEN", "刷新令牌无效或已过期", 401);
	const user = await getUserByIdFromSession(session, env);
	return ok(sessionPayload(session, user));
}

async function getUserByIdFromSession(session, env) {
	const row = await env.StudyPulseDB.prepare("SELECT id, email FROM users WHERE id = ?").bind(session.userId || "").first();
	return row || { id: session.userId, email: "" };
}
