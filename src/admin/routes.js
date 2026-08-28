/**
 * StudyPulse Cloud AI - 管理后台 API 路由处理
 *
 * 所有管理 API 路径：/api/admin/*
 *
 * 安全措施：
 *   - 所有路由统一校验管理员身份
 *   - 状态变更接口（POST/PUT/DELETE）需要 CSRF Token
 *   - 参数化 D1 查询防止 SQL 注入
 *   - 绝不返回 key_hash
 *   - 安全响应头（CSP、X-Frame-Options、X-Content-Type-Options 等）
 */

import { authenticateAdmin } from "./auth.js";
import {
	getDashboardStats,
	getDashboardUsageTrend,
	listApiKeys,
	createApiKey,
	updateApiKey,
	deleteApiKey,
	resetQuota,
	getRequestLogs,
	listUsers,
	getUserDetail,
	getUserSessions,
	revokeUserSessions,
	getUserApiKeys,
	getUserUsageStats,
	createUser,
	deleteUserAccount,
	updateUser,
	writeAdminLog,
	getAdminLogs,
	isEmailBlacklisted,
	blacklistEmail,
	removeBlacklistedEmail,
	listBlacklistedEmails,
} from "./database.js";
import { createBan, reviewAppeal, sendTransactionalEmail } from "../appeals/service.js";
import { accountDeletionEmail } from "../email/templates.js";
import { reviewContribution } from "../contributions/service.js";
import { CURRENT_PRICING_VERSION } from "../billing/pricing.js";
import {
	listPricingRates,
	restoreDefaultPricing,
	upsertPricingRates,
	validateModelRates,
} from "../billing/store.js";

// ────────────────────────────────────────────────────────────────────────────
// CSRF 保护
// ────────────────────────────────────────────────────────────────────────────

const CSRF_COOKIE = "admin_csrf";
const CSRF_HEADER = "X-CSRF-Token";

/**
 * 生成 CSRF Token 并设置 Cookie。
 * Cookie: SameSite=Strict, Path=/api/admin, Secure（生产环境）
 */
function generateCsrfToken() {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function setCsrfCookie(headers, token, secure) {
	headers.append(
		"Set-Cookie",
		`${CSRF_COOKIE}=${token}; Path=/api/admin; SameSite=Strict; HttpOnly; Max-Age=3600${secure ? "; Secure" : ""}`,
	);
}

/**
 * 校验 CSRF Token：Cookie 中的值与 X-CSRF-Token header 一致。
 */
function verifyCsrf(request) {
	const cookieHeader = request.headers.get("Cookie") || "";
	const cookies = Object.fromEntries(
		cookieHeader.split(";").map((c) => {
			const [k, ...v] = c.trim().split("=");
			return [k, v.join("=")];
		}),
	);
	const cookieToken = cookies[CSRF_COOKIE];
	const headerToken = request.headers.get(CSRF_HEADER);

	if (!cookieToken || !headerToken) return false;

	// 常量时间比较避免时序攻击
	let result = cookieToken.length ^ headerToken.length;
	for (let i = 0; i < cookieToken.length && i < headerToken.length; i++) {
		result |= cookieToken.charCodeAt(i) ^ headerToken.charCodeAt(i);
	}
	return result === 0;
}

// ────────────────────────────────────────────────────────────────────────────
// 安全响应头
// ────────────────────────────────────────────────────────────────────────────

const SECURITY_HEADERS = {
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options": "DENY",
	"X-XSS-Protection": "1; mode=block",
	"Referrer-Policy": "strict-origin-when-cross-origin",
	"Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

function applySecurityHeaders(headers) {
	for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
		headers.set(key, value);
	}
}

// ────────────────────────────────────────────────────────────────────────────
// 辅助函数
// ────────────────────────────────────────────────────────────────────────────

function json(data, status = 200, extraHeaders = {}) {
	const headers = new Headers({ "Content-Type": "application/json" });
	applySecurityHeaders(headers);
	for (const [k, v] of Object.entries(extraHeaders)) {
		headers.set(k, v);
	}
	return new Response(JSON.stringify(data), { status, headers });
}

function error(message, status = 400) {
	return json({ error: message }, status);
}

function unauthorized() {
	return error("Unauthorized", 401);
}

// ────────────────────────────────────────────────────────────────────────────
// 路由表
// ────────────────────────────────────────────────────────────────────────────

/**
 * 管理 API 路由入口。
 *
 * @param {Request} request
 * @param {{ StudyPulseDB: D1Database, ADMIN_API_TOKEN?: string }} env
 * @param {string} pathname - URL pathname
 * @returns {Promise<Response>}
 */
export async function handleAdminApi(request, env, pathname) {
	const method = request.method.toUpperCase();

	// 1. 管理员鉴权
	if (!(await authenticateAdmin(request, env))) {
		return unauthorized();
	}

	// 2. 状态变更操作需要 CSRF 校验
	const stateChanging = ["POST", "PUT", "DELETE"].includes(method);
	if (stateChanging) {
		if (!verifyCsrf(request)) {
			return error("CSRF validation failed", 403);
		}
	}

	// 3. 路由分发
	try {
		switch (true) {
			// GET /api/admin/stats
			case pathname === "/api/admin/stats" && method === "GET":
				return handleStats(env);

			case pathname === "/api/admin/usage-trend" && method === "GET":
				return handleUsageTrend(request, env);

			// GET /api/admin/keys
			case pathname === "/api/admin/keys" && method === "GET":
				return handleListKeys(env);

			// POST /api/admin/keys/create
			case pathname === "/api/admin/keys/create" && method === "POST":
				return handleCreateKey(request, env);

			// POST /api/admin/keys/update
			case pathname === "/api/admin/keys/update" && method === "POST":
				return handleUpdateKey(request, env);

			// POST /api/admin/keys/delete
			case pathname === "/api/admin/keys/delete" && method === "POST":
				return handleDeleteKey(request, env);

			// POST /api/admin/keys/reset-quota
			case pathname === "/api/admin/keys/reset-quota" && method === "POST":
				return handleResetQuota(request, env);

			case pathname === "/api/admin/pricing" && method === "GET":
				return handleGetPricing(env);

			case pathname === "/api/admin/pricing/update" && method === "POST":
				return handleUpdatePricing(request, env);

			case pathname === "/api/admin/pricing/restore" && method === "POST":
				return handleRestorePricing(env);

			// GET /api/admin/logs
		case pathname === "/api/admin/logs" && method === "GET":
			return handleLogs(request, env);

		// GET /api/admin/users
		case pathname === "/api/admin/users" && method === "GET":
			return handleListUsers(request, env);

		// GET /api/admin/users/:id
		case pathname.startsWith("/api/admin/users/") && method === "GET": {
			const userId = decodeURIComponent(pathname.slice("/api/admin/users/".length));
			if (pathname.endsWith("/stats")) {
				const uid = userId.slice(0, -6); // remove "/stats"
				return handleUserStats(env, uid);
			}
			if (pathname.endsWith("/sessions")) {
				const uid = userId.slice(0, -9); // remove "/sessions"
				return handleUserSessions(env, uid);
			}
			if (pathname.endsWith("/keys")) {
				const uid = userId.slice(0, -5); // remove "/keys"
				return handleUserKeys(env, uid);
			}
			return handleGetUser(env, userId);
		}

		// POST /api/admin/users/update
		case pathname === "/api/admin/users/update" && method === "POST":
			return handleUpdateUser(request, env);

		// POST /api/admin/users/create
		case pathname === "/api/admin/users/create" && method === "POST":
			return handleCreateUser(request, env);

		// POST /api/admin/users/delete
		case pathname === "/api/admin/users/delete" && method === "POST":
			return handleDeleteUser(request, env);

		// POST /api/admin/users/revoke-sessions
		case pathname === "/api/admin/users/revoke-sessions" && method === "POST":
			return handleRevokeUserSessions(request, env);

		case pathname === "/api/admin/bans/create" && method === "POST":
			return handleCreateBan(request, env);

		case pathname === "/api/admin/appeals" && method === "GET":
			return handleListAppeals(request, env);

		case pathname === "/api/admin/appeals/review" && method === "POST":
			return handleReviewAppeal(request, env);

		case pathname === "/api/admin/tickets" && method === "GET":
			return handleListTickets(request, env);

		case pathname === "/api/admin/tickets/process" && method === "POST":
			return handleProcessTicket(request, env);

		case pathname === "/api/admin/contributions" && method === "GET":
			return handleListContributions(request, env);

		case pathname === "/api/admin/contributions/review" && method === "POST":
			return handleReviewContribution(request, env);

		// GET /api/admin/blacklist
		case pathname === "/api/admin/blacklist" && method === "GET":
			return handleListBlacklist(env);

		// POST /api/admin/blacklist/add
		case pathname === "/api/admin/blacklist/add" && method === "POST":
			return handleAddBlacklist(request, env);

		// POST /api/admin/blacklist/remove
		case pathname === "/api/admin/blacklist/remove" && method === "POST":
			return handleRemoveBlacklist(request, env);

		default:
				return error("Not Found", 404);
		}
	} catch (err) {
		console.error("[admin] Internal error:", err?.message || err);
		return error("Internal server error", 500);
	}
}

async function handleCreateBan(request, env) {
	let body;
	try { body = await request.json(); } catch { return error("Invalid JSON body", 400); }
	if (!body?.user_id || typeof body.user_id !== "string") return error("user_id is required", 400);
	if (!body.reason || typeof body.reason !== "string" || body.reason.trim().length < 3) return error("reason is required", 400);
	const result = await createBan(body.user_id, body.reason.trim().slice(0, 1000), env);
	if (!result.success) return error(result.error, 404);
	writeAdminLog(env, { admin_user_id: "admin_system", action: "ban_user", target_user_id: body.user_id, details: JSON.stringify({ reason: body.reason, ban_id: result.banId }) }).catch(() => {});
	return json({ success: true, data: result });
}

async function handleListAppeals(request, env) {
	const status = new URL(request.url).searchParams.get("status") || "";
	const where = status ? "WHERE a.status = ?" : "";
	const result = await env.StudyPulseDB.prepare(`SELECT a.id,a.ban_id,a.user_id,a.content,a.status,a.created_at,a.reviewed_at,a.admin_reply,b.reason,u.email FROM appeals a JOIN bans b ON b.id=a.ban_id JOIN users u ON u.id=a.user_id ${where} ORDER BY a.created_at DESC LIMIT 200`).bind(...(status ? [status] : [])).all();
	return json({ success: true, data: result.results });
}

async function handleReviewAppeal(request, env) {
	let body;
	try { body = await request.json(); } catch { return error("Invalid JSON body", 400); }
	if (!body?.id || !["approved", "rejected"].includes(body.decision)) return error("id and decision are required", 400);
	const result = await reviewAppeal(body.id, body.decision, body.admin_reply || "", env);
	if (!result.success) return error(result.error, result.status || 400);
	writeAdminLog(env, { admin_user_id: "admin_system", action: `appeal_${body.decision}`, details: JSON.stringify({ appeal_id: body.id }) }).catch(() => {});
	return json({ success: true, data: result });
}

async function handleListTickets(request, env) {
	const params = new URL(request.url).searchParams;
	const archive = params.get("archive") === "1";
	const search = (params.get("search") || "").trim().slice(0, 120);
	const status = archive ? "processed" : "pending";
	const where = search
		? "WHERE t.status = ? AND (t.subject LIKE ? OR t.content LIKE ? OR u.email LIKE ?)"
		: "WHERE t.status = ?";
	const bindings = search ? [status, `%${search}%`, `%${search}%`, `%${search}%`] : [status];
	const order = archive ? "t.processed_at DESC" : "CASE t.priority WHEN 'top' THEN 3 WHEN 'urgent' THEN 2 ELSE 1 END DESC, t.created_at ASC";
	const limit = archive ? 200 : 200;
	const result = await env.StudyPulseDB.prepare(`SELECT t.id,t.user_id,t.subject,t.content,t.priority,t.status,t.admin_reply,t.created_at,t.processed_at,u.email,u.membership_type FROM feedback_tickets t JOIN users u ON u.id=t.user_id ${where} ORDER BY ${order} LIMIT ${limit}`).bind(...bindings).all();
	return json({ success: true, data: result.results });
}

async function handleProcessTicket(request, env) {
	let body; try { body = await request.json(); } catch { return error("Invalid JSON body", 400); }
	const id = typeof body?.id === "string" ? body.id : "";
	const reply = typeof body?.admin_reply === "string" ? body.admin_reply.trim().slice(0, 5000) : "";
	if (!id || !reply) return error("id 和处理内容均为必填", 400);
	const result = await env.StudyPulseDB.prepare(`UPDATE feedback_tickets SET status='processed',admin_reply=?,processed_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'`).bind(reply, id).run();
	if (!result.meta.changes) return error("工单不存在或已处理", 404);
	// Keep the archive bounded to the latest 200 processed tickets.
	await env.StudyPulseDB.prepare(`DELETE FROM feedback_tickets WHERE status='processed' AND id NOT IN (SELECT id FROM feedback_tickets WHERE status='processed' ORDER BY processed_at DESC LIMIT 200)`).run();
	writeAdminLog(env, { admin_user_id: "admin_system", action: "process_feedback_ticket", details: JSON.stringify({ ticket_id: id }) }).catch(() => {});
	return json({ success: true });
}

async function handleListContributions(request, env) {
	const status = new URL(request.url).searchParams.get("status") || "pending";
	const where = ["pending", "approved", "rejected"].includes(status) ? "WHERE c.status = ?" : "";
	const result = await env.StudyPulseDB.prepare(`SELECT c.id,c.user_id,c.email,c.contribution_url,c.contribution_type,c.description,c.status,c.awarded_membership,c.membership_expires_at,c.admin_reply,c.created_at,c.reviewed_at,u.membership_type FROM contribution_tickets c JOIN users u ON u.id=c.user_id ${where} ORDER BY c.created_at DESC LIMIT 200`).bind(...(where ? [status] : [])).all();
	return json({ success: true, data: result.results || [] });
}

async function handleReviewContribution(request, env) {
	let body; try { body = await request.json(); } catch { return error("Invalid JSON body", 400); }
	if (!body?.id || !["approved", "rejected"].includes(body.decision)) return error("id 和审核结果为必填", 400);
	const result = await reviewContribution(body.id, body.decision, body.membership, body.duration_days, body.admin_reply, env);
	if (!result.success) return error(result.error, result.status || 400);
	writeAdminLog(env, { admin_user_id: "admin_system", action: `review_contribution_${body.decision}`, target_user_id: body.user_id || null, details: JSON.stringify({ contribution_id: body.id, membership: result.membership, expires_at: result.expiresAt }) }).catch(() => {});
	return json({ success: true, data: result });
}

// ────────────────────────────────────────────────────────────────────────────
// 路由处理器
// ────────────────────────────────────────────────────────────────────────────

async function handleStats(env) {
	const stats = await getDashboardStats(env);
	return json({ success: true, data: stats });
}

async function handleUsageTrend(request, env) {
	const range = new URL(request.url).searchParams.get("range") || "1D";
	const allowedRanges = ["1D", "3D", "1W", "2W", "1M", "3M", "6M", "1Y"];
	if (!allowedRanges.includes(range)) return error("Invalid range", 400);
	const trend = await getDashboardUsageTrend(env, range);
	return json({ success: true, data: { range, points: trend } });
}

async function handleGetPricing(env) {
	const models = await listPricingRates(env);
	return json({
		success: true,
		data: {
			version: CURRENT_PRICING_VERSION,
			models,
		},
	});
}

async function handleUpdatePricing(request, env) {
	let body;
	try {
		body = await request.json();
	} catch {
		return error("Invalid JSON body", 400);
	}
	const parsed = validateModelRates(body);
	if (parsed.error) return error(parsed.error, 400);
	await upsertPricingRates(env, parsed.model, parsed.rates);
	writeAdminLog(env, {
		admin_user_id: "admin_system",
		action: "update_pricing",
		details: JSON.stringify({ model: parsed.model, rates: parsed.rates }),
	}).catch(() => {});
	const models = await listPricingRates(env);
	return json({ success: true, data: { models } });
}

async function handleRestorePricing(env) {
	await restoreDefaultPricing(env);
	writeAdminLog(env, {
		admin_user_id: "admin_system",
		action: "restore_pricing",
		details: JSON.stringify({ version: CURRENT_PRICING_VERSION }),
	}).catch(() => {});
	const models = await listPricingRates(env);
	return json({ success: true, data: { models } });
}

async function handleListKeys(env) {
	const keys = await listApiKeys(env);
	return json({ success: true, data: keys });
}

async function handleCreateKey(request, env) {
	let body;
	try {
		body = await request.json();
	} catch {
		return error("Invalid JSON body", 400);
	}

	const { name, user_id } = body;
	if (!name || typeof name !== "string" || name.trim().length === 0) {
		return error("name is required", 400);
	}
	if (!user_id || typeof user_id !== "string") {
		return error("user_id is required", 400);
	}

	const params = {
		name: name.trim(),
		user_id,
		limit_type: body.limit_type || undefined,
		request_limit: body.request_limit ? Number(body.request_limit) : null,
		notes: body.notes || null,
		expires_at: body.expires_at || null,
	};

	const result = await createApiKey(env, params);

	// 写管理员操作日志
	writeAdminLog(env, {
		admin_user_id: "admin_system",
		action: "create_api_key",
		target_user_id: user_id,
		details: JSON.stringify({ key_id: result.id, name: params.name }),
	}).catch(() => {});

	return json({
		success: true,
		data: {
			id: result.id,
			rawKey: result.rawKey,
		},
	});
}

async function handleUpdateKey(request, env) {
	let body;
	try {
		body = await request.json();
	} catch {
		return error("Invalid JSON body", 400);
	}

	const { id } = body;
	if (!id || typeof id !== "number") {
		return error("id is required (number)", 400);
	}

	const fields = {};
	if (body.name !== undefined) fields.name = body.name;
	if (body.enabled !== undefined) fields.enabled = body.enabled;
	if (body.request_limit !== undefined) fields.request_limit = body.request_limit === null ? null : Number(body.request_limit);
	if (body.limit_type !== undefined) fields.limit_type = body.limit_type;
	if (body.notes !== undefined) fields.notes = body.notes;
	if (body.expires_at !== undefined) fields.expires_at = body.expires_at;

	if (Object.keys(fields).length === 0) {
		return error("no fields to update", 400);
	}

	const updated = await updateApiKey(env, id, fields);
	if (!updated) {
		return error("Key not found", 404);
	}

	return json({ success: true });
}

async function handleDeleteKey(request, env) {
	let body;
	try {
		body = await request.json();
	} catch {
		return error("Invalid JSON body", 400);
	}

	const { id } = body;
	if (!id || typeof id !== "number") {
		return error("id is required (number)", 400);
	}

	const deleted = await deleteApiKey(env, id);
	if (!deleted) {
		return error("Key not found", 404);
	}

	return json({ success: true });
}

async function handleResetQuota(request, env) {
	let body;
	try {
		body = await request.json();
	} catch {
		return error("Invalid JSON body", 400);
	}

	const { id } = body;
	if (!id || typeof id !== "number") {
		return error("id is required (number)", 400);
	}

	const reset = await resetQuota(env, id);
	if (!reset) {
		return error("Key not found", 404);
	}

	return json({ success: true });
}

async function handleLogs(request, env) {
	const url = new URL(request.url);
	const api_key_id = url.searchParams.get("api_key_id");
	const user_id = url.searchParams.get("user_id");
	const call_method = url.searchParams.get("call_method");
	const status = url.searchParams.get("status");

	const logs = await getRequestLogs(env, {
		api_key_id: api_key_id ? Number(api_key_id) : undefined,
		user_id: user_id || undefined,
		call_method: call_method || undefined,
		status: status ? Number(status) : undefined,
	});

	return json({ success: true, data: logs });
}

// ────────────────────────────────────────────────────────────────────────────
// 用户管理路由处理
// ────────────────────────────────────────────────────────────────────────────

async function handleListUsers(request, env) {
	const url = new URL(request.url);
	const search = url.searchParams.get("search") || "";
	const role = url.searchParams.get("role") || "";
	const membership_type = url.searchParams.get("membership") || "";

	const users = await listUsers(env, { search, role, membership_type });
	return json({ success: true, data: users });
}

async function handleGetUser(env, userId) {
	const user = await getUserDetail(env, userId);
	if (!user) return error("User not found", 404);
	return json({ success: true, data: user });
}

async function handleUpdateUser(request, env) {
	let body;
	try {
		body = await request.json();
	} catch {
		return error("Invalid JSON body", 400);
	}

	const { id } = body;
	if (!id || typeof id !== "string") {
		return error("id is required (string)", 400);
	}

	const fields = {};
	if (body.role !== undefined) fields.role = body.role;
	if (body.membership_type !== undefined) fields.membership_type = body.membership_type;
	if (body.membership_expires_at !== undefined) {
		if (body.membership_expires_at === null || body.membership_expires_at === "") {
			fields.membership_expires_at = null;
		} else if (typeof body.membership_expires_at !== "string") {
			return error("membership_expires_at must be an ISO datetime or null", 400);
		} else {
			const expiresAt = new Date(body.membership_expires_at);
			if (Number.isNaN(expiresAt.getTime())) {
				return error("membership_expires_at is invalid", 400);
			}
			fields.membership_expires_at = expiresAt.toISOString();
		}
	}

	if (Object.keys(fields).length === 0) {
		return error("no fields to update", 400);
	}

	const updated = await updateUser(env, id, fields);
	if (!updated) return error("User not found", 404);

	// 写管理员操作日志
	writeAdminLog(env, {
		admin_user_id: "admin_system",
		action: fields.role !== undefined ? "change_role"
			: fields.membership_type !== undefined ? "change_membership"
			: fields.membership_expires_at !== undefined ? "change_membership_expires"
			: "update_user",
		target_user_id: id,
		details: JSON.stringify(fields),
	}).catch(() => {});

	return json({ success: true });
}

async function handleCreateUser(request, env) {
	let body;
	try {
		body = await request.json();
	} catch {
		return error("Invalid JSON body", 400);
	}

	const { email } = body;
	if (!email || typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
		return error("有效的邮箱地址为必填项", 400);
	}

	// 允许的角色和会员类型
	const allowedRoles = ["user", "admin"];
	const allowedMemberships = ["free", "plus", "pro"];

	const role = body.role && allowedRoles.includes(body.role) ? body.role : "user";
	const membershipType = body.membership_type && allowedMemberships.includes(body.membership_type)
		? body.membership_type
		: "free";

	try {
		const user = await createUser(env, {
			email: email.trim(),
			role,
			membership_type: membershipType,
		});

		// 写管理员操作日志
		writeAdminLog(env, {
			admin_user_id: "admin_system",
			action: "create_user",
			target_user_id: user.id,
			details: JSON.stringify({ email: user.email, role, membership_type: membershipType }),
		}).catch(() => {});

		return json({ success: true, data: user });
	} catch (err) {
		if (err.message === "DUPLICATE_EMAIL") {
			return error("该邮箱已被注册", 409);
		}
		throw err;
	}
}

async function handleDeleteUser(request, env) {
	let body;
	try {
		body = await request.json();
	} catch {
		return error("Invalid JSON body", 400);
	}

	const { user_id: userId } = body;
	if (!userId || typeof userId !== "string") {
		return error("user_id is required (string)", 400);
	}

	const result = await deleteUserAccount(env, userId);
	if (!result.success) return error(result.error, result.error === "User not found" ? 404 : 400);

	const email = await sendTransactionalEmail({
		to: result.email,
		subject: "[StudyPulse Cloud AI] 账户删除申请已通过",
		html: accountDeletionEmail({ email: result.email }),
	}, env);
	writeAdminLog(env, {
		admin_user_id: "admin_system",
		action: "delete_user",
		target_user_id: userId,
		details: JSON.stringify({ email: result.email, email_sent: email.success }),
	}).catch(() => {});

	return json({
		success: true,
		data: { emailSent: email.success, emailError: email.success ? null : email.error },
	});
}

async function handleUserStats(env, userId) {
	const stats = await getUserUsageStats(env, userId);
	return json({ success: true, data: stats });
}

async function handleUserSessions(env, userId) {
	const sessions = await getUserSessions(env, userId);
	return json({ success: true, data: sessions });
}

async function handleRevokeUserSessions(request, env) {
	let body;
	try {
		body = await request.json();
	} catch {
		return error("Invalid JSON body", 400);
	}

	const { user_id: userId } = body;
	if (!userId || typeof userId !== "string") {
		return error("user_id is required (string)", 400);
	}

	const user = await getUserDetail(env, userId);
	if (!user) return error("User not found", 404);

	const revokedCount = await revokeUserSessions(env, userId);
	writeAdminLog(env, {
		admin_user_id: "admin_system",
		action: "revoke_user_sessions",
		target_user_id: userId,
		details: JSON.stringify({ revoked_count: revokedCount }),
	}).catch(() => {});

	return json({ success: true, data: { revoked_count: revokedCount } });
}

async function handleUserKeys(env, userId) {
	const keys = await getUserApiKeys(env, userId);
	return json({ success: true, data: keys });
}

// ────────────────────────────────────────────────────────────────────────────
// 用户封禁路由处理（保留 blacklist API 路径以兼容现有客户端）
// ────────────────────────────────────────────────────────────────────────────

async function handleListBlacklist(env) {
	const emails = await listBlacklistedEmails(env);
	return json({ success: true, data: emails });
}

async function handleAddBlacklist(request, env) {
	let body;
	try {
		body = await request.json();
	} catch {
		return error("Invalid JSON body", 400);
	}

	const { email, reason } = body;
	if (!email || typeof email !== "string") {
		return error("email is required", 400);
	}
	const normalizedEmail = email.trim().toLowerCase();
	const user = await env.StudyPulseDB.prepare(
		"SELECT id FROM users WHERE email_normalized = ? OR email = ?",
	).bind(normalizedEmail, normalizedEmail).first();
	let banUser = user;
	if (!banUser) {
		try {
			banUser = await createUser(env, { email: normalizedEmail, role: "user", membership_type: "free" });
		} catch (createError) {
			if (createError?.message !== "DUPLICATE_EMAIL") throw createError;
			banUser = await env.StudyPulseDB.prepare(
				"SELECT id FROM users WHERE email_normalized = ? OR email = ?",
			).bind(normalizedEmail, normalizedEmail).first();
		}
	}
	let banResult = null;
	if (banUser) {
		const banReason = typeof reason === "string" && reason.trim()
			? reason.trim()
			: "违反服务条款和使用政策";
		banResult = await createBan(banUser.id, banReason, env);
		if (!banResult.success) return error(banResult.error, 400);
	}

	const result = await blacklistEmail(normalizedEmail, reason || null, env);
	if (!result.success) {
		return error(result.error, 400);
	}

	writeAdminLog(env, {
		admin_user_id: "admin_system",
		action: "blacklist_email",
		target_user_id: null,
		details: JSON.stringify({ email: normalizedEmail, reason, ban_id: banResult?.banId || null }),
	}).catch(() => {});

	return json({ success: true, data: banResult ? { emailSent: banResult.emailSent, emailError: banResult.emailError } : null });
}

async function handleRemoveBlacklist(request, env) {
	let body;
	try {
		body = await request.json();
	} catch {
		return error("Invalid JSON body", 400);
	}

	const { email } = body;
	if (!email || typeof email !== "string") {
		return error("email is required", 400);
	}

	const removed = await removeBlacklistedEmail(email.trim(), env);
	if (!removed) {
		return error("Email not found in blacklist", 404);
	}

	writeAdminLog(env, {
		admin_user_id: "admin_system",
		action: "unblacklist_email",
		target_user_id: null,
		details: JSON.stringify({ email: email.trim().toLowerCase() }),
	}).catch(() => {});

	return json({ success: true });
}

// ────────────────────────────────────────────────────────────────────────────
// 导出 CSRF 工具供 UI 页面使用
// ────────────────────────────────────────────────────────────────────────────

export { generateCsrfToken, setCsrfCookie, applySecurityHeaders, json, error };
