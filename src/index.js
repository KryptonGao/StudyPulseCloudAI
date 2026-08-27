/**
 * StudyPulse Cloud AI - Worker 入口
 *
 * v0.6：SaaS 用户体系 + 双鉴权
 *   - admin.chenkai.space  → 管理后台（WebUI + API）
 *   - support.chenkai.space → 账号封禁申诉页面与 API
 *   - spapi.chenkai.space  → 公开 AI API（健康检查 + auth + /v1/chat）
 *   - localhost（开发）     → 路径路由（兼容旧行为，全部可访问）
 *
 * 新增模块：
 *   src/auth/email.js         邮箱验证码
 *   src/auth/session.js       Session 管理
 *   src/auth/middleware.js    双鉴权中间件
 *   src/users/users.js        用户 CRUD
 *   src/membership/membership.js 会员与额度
 *   src/database/usage.js     用量记录
 */

import { authenticate } from "./auth.js";
import { chat as minimaxChat, chatStream as minimaxChatStream } from "./providers/minimax.js";
import { incrementApiKeyUsage } from "./database/api_keys.js";
import { handleAdminApi } from "./admin/routes.js";
import { writeRequestLog } from "./admin/database.js";
import { authenticateRequest } from "./auth/middleware.js";
import { sendVerificationCode, verifyCode } from "./auth/email.js";
import { createSession, destroySession } from "./auth/session.js";
import { handleGitHubBindSendCode, handleGitHubBindVerify, handleGitHubCallback, handleGitHubStart } from "./auth/oauth.js";
import { checkUserQuota, getMembershipPlan, recordUsage } from "./membership/membership.js";
import { getUserById } from "./users/users.js";
import { handleAppealStatus, handleSubmitAppeal } from "./appeals/routes.js";
import {
	handleSupportSendCode,
	handleSupportVerifyCode,
	handleSupportMe,
	handleListTickets,
	handleCreateTicket,
} from "./support/routes.js";
import { handleUserDashboardApi } from "./dashboard/routes.js";
import { authPageOptions, serveAdminPage, serveStaticPage } from "./ui/static-pages.js";
import { handlePasskeyRoute, isPasskeyRoute } from "./auth/passkey.js";
import {
	handleAuthSendCode,
	handlePasswordChange,
	handlePasswordLogin,
	handlePasswordReset,
	handlePasswordResetRequest,
	handlePasswordSetupAfterCode,
	handleRegisterVerify,
	handleLogoutCurrent,
	handleLogoutAll,
	handleMe,
	handleCodeLogin,
	handleRefresh,
} from "./auth/routes.js";
import { CHAT_MAX_BODY_BYTES, CHAT_MAX_CONTENT_ITEMS, CHAT_MAX_MESSAGE_CHARS } from "./chat-limits.js";

// 服务元信息
const SERVICE_META = {
	service: "StudyPulse Cloud AI",
	version: "0.5-beta-github",
};

// 生产环境自定义域名
const SPAPI_HOSTNAME = "spapi.chenkai.space";
const ADMIN_HOSTNAME = "admin.chenkai.space";
const SUPPORT_HOSTNAME = "support.chenkai.space";
const AUTH_HOSTNAME = "auth.chenkai.space";
const DASH_HOSTNAME = "dash.studypulse.chenkai.space";

class ChatBodyTooLargeError extends Error {
	constructor() {
		super("Chat request body exceeds the application limit");
		this.code = "CHAT_BODY_TOO_LARGE";
	}
}

/**
 * 在 JSON.parse 前限制 /v1/chat 的请求体大小。
 * Content-Length 可能缺失或不可信，因此仍需限制实际读取的字节数。
 */
async function parseChatRequestBody(request) {
	const contentLength = request.headers.get("Content-Length");
	if (contentLength !== null) {
		const declaredLength = Number(contentLength);
		if (Number.isFinite(declaredLength) && declaredLength > CHAT_MAX_BODY_BYTES) {
			throw new ChatBodyTooLargeError();
		}
	}

	if (!request.body) {
		return JSON.parse(await request.text());
	}

	const reader = request.body.getReader();
	const chunks = [];
	let totalBytes = 0;

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;

		totalBytes += value.byteLength;
		if (totalBytes > CHAT_MAX_BODY_BYTES) {
			// 返回 413 时 runtime 也可能同时取消请求流，忽略这个竞态。
			await reader.cancel().catch(() => {});
			throw new ChatBodyTooLargeError();
		}
		chunks.push(value);
	}

	const bytes = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return JSON.parse(new TextDecoder().decode(bytes));
}

function validateChatPayload(body) {
	if (typeof body?.message === "string" && body.message.length > CHAT_MAX_MESSAGE_CHARS) {
		return "Message too long";
	}

	if (Array.isArray(body?.content)) {
		if (body.content.length > CHAT_MAX_CONTENT_ITEMS) {
			return "Too many content items";
		}

		// 多模态文本也属于用户消息，不能绕过 message 的长度限制。
		for (const item of body.content) {
			if (typeof item?.text === "string" && item.text.length > CHAT_MAX_MESSAGE_CHARS) {
				return "Content item text too long";
			}
		}
	}

	return null;
}

/**
 * Worker 默认导出（Cloudflare Workers 标准格式）
 */
export default {
	async fetch(request, env, ctx) {
		try {
			const url = new URL(request.url);
			const { pathname } = url;
			const method = request.method.toUpperCase();
			const hostname = url.hostname;
			// Path routing is local-only. Production custom domains always match
			// hostname below, even if LOCAL_DEV were accidentally set remotely.
			// Wrangler remaps localhost to the first custom domain (spapi).
			const usePathRouting =
				hostname === "localhost" ||
				hostname.startsWith("127.0.0.1") ||
				hostname.endsWith(".workers.dev") ||
				((env.LOCAL_DEV === "1" || env.LOCAL_DEV === "true") && hostname === SPAPI_HOSTNAME);

			console.log(`[${method}] ${hostname}${pathname}`);

			// The auth center is also consumed by native/web clients hosted on a
			// different origin. JSON POST requests trigger a browser preflight.
			if (method === "OPTIONS") return corsResponse(request);

			// workers.dev 是公开的调试/预览入口，不作为生产管理后台入口。
			// 即使请求携带 Authorization，也不能通过该域名访问管理页面或 API。
			if (hostname.endsWith(".workers.dev") && isAdminPath(pathname)) {
				return withCors(Response.json({ error: "Not Found" }, { status: 404 }), request);
			}

			// Wrangler 本地会把请求主机改写成第一条 custom domain（spapi），
			// 因此用 LOCAL_DEV / localhost 走路径路由，而不是按生产子域名分流。
			if (usePathRouting) {
				if (pathname === "/login" && method === "GET") return withCors(await serveStaticPage(request, env, "/pages/auth/index.html", authPageOptions()), request);
				if (pathname === "/support" && method === "GET") return withCors(await serveStaticPage(request, env, "/pages/support/index.html"), request);
				if (pathname === "/oauth/github/bind" && method === "GET") return withCors(await serveStaticPage(request, env, "/pages/auth-bind/index.html", authPageOptions()), request);
				if ((pathname === "/dashboard" || pathname === "/dashboard/" || pathname === "/contributions" || pathname === "/feedback" || pathname === "/security") && method === "GET") return withCors(await serveStaticPage(request, env, "/pages/dashboard/index.html"), request);
				if ((pathname === "/admin" || pathname === "/admin/") && method === "GET") return withCors(await serveAdminPage(request, env), request);
				if (pathname.startsWith("/appeal/") && method === "GET") return withCors(await serveStaticPage(request, env, "/pages/appeal/index.html"), request);
				if (pathname === "/api/user/dashboard" || pathname === "/api/user/contributions" || pathname === "/api/user/feedback") return withCors(await handleUserDashboardApi(request, env, pathname), request);
				if (isPasskeyRoute(pathname)) return withCors(await handlePasskeyRoute(request, env, pathname), request);
				if (
					pathname.startsWith("/api/admin/") ||
					pathname.startsWith("/admin")
				) {
					return withCors(await handleAdmin(request, env, ctx, pathname, method), request);
				}
				if (pathname === "/api/appeals" && (method === "GET" || method === "POST")) {
					return withCors(await handleSupport(request, env, pathname, method), request);
				}
				return withCors(await handlePublicApi(request, env, ctx, pathname, method), request);
			}

			// ── 管理后台子域名：仅 admin.chenkai.space ──
			if (hostname === ADMIN_HOSTNAME) {
				return withCors(await handleAdmin(request, env, ctx, pathname, method), request);
			}

			// ── 申诉子域名：仅 support.chenkai.space ──
			if (hostname === SUPPORT_HOSTNAME) {
				return withCors(await handleSupport(request, env, pathname, method), request);
			}

			if (hostname === AUTH_HOSTNAME) {
				return withCors(await handleAuthCenter(request, env, pathname, method), request);
			}

			if (hostname === DASH_HOSTNAME) {
				return withCors(await handleDashboard(request, env, pathname, method), request);
			}

			// ── 公开 API 子域名：仅 spapi.chenkai.space ──
			if (hostname === SPAPI_HOSTNAME) {
				return withCors(await handlePublicApi(request, env, ctx, pathname, method), request);
			}

			// ── 未知主机名 → 404 ──
			return withCors(Response.json({ error: "Not Found" }, { status: 404 }), request);
		} catch (err) {
			// 不要把未捕获异常升级成 Cloudflare 1101 HTML 页面；API 客户端需要
			// 收到稳定的 JSON，并且异常详情只写入 Workers Logs，避免泄露内部信息。
			console.error("Unhandled Worker request error:", err?.stack || err?.message || err);
			return withCors(Response.json(
				{ error: "Internal server error" },
				{ status: 500 },
			), request);
		}
	},
};

function corsHeaders(request) {
	const origin = request.headers.get("Origin");
	return {
		"Access-Control-Allow-Origin": origin || "*",
		"Access-Control-Allow-Methods": "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type, Authorization",
		"Access-Control-Max-Age": "86400",
		"Vary": "Origin",
	};
}

function handleDashboard(request, env, pathname, method) {
	if ((pathname === "/" || pathname === "/dashboard" || pathname === "/dashboard/" || pathname === "/contributions" || pathname === "/feedback" || pathname === "/security") && method === "GET") return serveStaticPage(request, env, "/pages/dashboard/index.html");
	if (pathname === "/api/user/dashboard" || pathname === "/api/user/contributions" || pathname === "/api/user/feedback") return handleUserDashboardApi(request, env, pathname);
	if (isPasskeyRoute(pathname)) return handlePasskeyRoute(request, env, pathname);
	if (pathname === "/api/v1/auth/logout" && method === "POST") return destroySession(request, env).then(() => Response.json({ success: true }));
	return Response.json({ error: "Not Found" }, { status: 404 });
}

function corsResponse(request) {
	return new Response(null, { status: 204, headers: corsHeaders(request) });
}

function withCors(response, request) {
	const headers = new Headers(response.headers);
	for (const [name, value] of Object.entries(corsHeaders(request))) headers.set(name, value);
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function isAdminPath(pathname) {
	return (
		pathname === "/admin" ||
		pathname === "/admin/" ||
		pathname.startsWith("/admin/") ||
		pathname.startsWith("/api/admin/")
	);
}

// ────────────────────────────────────────────────────────────────────────────
// 管理后台路由（仅 admin.chenkai.space 可访问）
// ────────────────────────────────────────────────────────────────────────────

function handleAdmin(request, env, ctx, pathname, method) {
	if (pathname.startsWith("/appeal/") && method === "GET") {
		return serveStaticPage(request, env, "/pages/appeal/index.html");
	}
	// 管理后台 WebUI
	if ((pathname === "/admin" || pathname === "/admin/") && method === "GET") {
		return serveAdminPage(request, env);
	}

	// 管理后台 API
	if (pathname.startsWith("/api/admin/")) {
		return handleAdminApi(request, env, pathname);
	}

	return Response.json({ error: "Not Found" }, { status: 404 });
}

// ────────────────────────────────────────────────────────────────────────────
// 申诉路由（仅 support.chenkai.space 可访问）
// ────────────────────────────────────────────────────────────────────────────

function handleSupport(request, env, pathname, method) {
	if (pathname === "/" && method === "GET") return serveStaticPage(request, env, "/pages/support/index.html");
	if (pathname.startsWith("/appeal/") && method === "GET") {
		return serveStaticPage(request, env, "/pages/appeal/index.html");
	}
	if (pathname === "/api/appeals" && method === "GET") return handleAppealStatus(request, env);
	if (pathname === "/api/appeals" && method === "POST") return handleSubmitAppeal(request, env);
	if (pathname === "/api/support/auth/send-code" && method === "POST") return handleSupportSendCode(request, env);
	if (pathname === "/api/support/auth/verify-code" && method === "POST") return handleSupportVerifyCode(request, env);
	if (pathname === "/api/auth/login" && method === "POST") return handlePasswordLogin(request, env);
	if (pathname === "/api/auth/logout" && method === "POST") return handleLogoutCurrent(request, env);
	if (pathname === "/api/support/me" && method === "GET") return handleSupportMe(request, env);
	if (pathname === "/api/support/tickets" && method === "GET") return handleListTickets(request, env);
	if (pathname === "/api/support/tickets" && method === "POST") return handleCreateTicket(request, env);
	return Response.json({ error: "Not Found" }, { status: 404 });
}

// ────────────────────────────────────────────────────────────────────────────
// 公开 API 路由（仅 spapi.chenkai.space 可访问）
// ────────────────────────────────────────────────────────────────────────────

function handlePublicApi(request, env, ctx, pathname, method) {
	if (isPasskeyRoute(pathname)) return handlePasskeyRoute(request, env, pathname);

	// 健康检查
	if (pathname === "/" && method === "GET") {
		return handleHealth();
	}

	// 邮箱验证码 — 发送
	if (pathname === "/auth/email/send" && method === "POST") {
		return handleSendCode(request, env);
	}

	// 邮箱验证码 — 校验
	if (pathname === "/auth/email/verify" && method === "POST") {
		return handleVerifyCode(request, env);
	}

	// 退出登录
	if (pathname === "/auth/logout" && method === "POST") {
		return handleLogout(request, env);
	}

	// 新版统一认证 API（保留上面的旧路径和响应格式）
	if (pathname === "/v1/auth/email/send" && method === "POST") {
		return handleAuthSendCode(request, env);
	}
	if (pathname === "/auth/send-code" && method === "POST") return handleAuthSendCode(request, env);
	if (pathname === "/auth/login/password" && method === "POST") return handlePasswordLogin(request, env);
	if (pathname === "/auth/login/code" && method === "POST") return handleCodeLogin(request, env);
	if (pathname === "/auth/password/set-after-code" && method === "POST") return handlePasswordSetupAfterCode(request, env);
	if (pathname === "/v1/auth/password/set-after-code" && method === "POST") return handlePasswordSetupAfterCode(request, env);
	if (pathname === "/auth/refresh" && method === "POST") return handleRefresh(request, env);
	if (pathname === "/v1/auth/login" && method === "POST") {
		return handlePasswordLogin(request, env);
	}
	if (pathname === "/v1/auth/register/verify" && method === "POST") {
		return handleRegisterVerify(request, env);
	}
	if (pathname === "/v1/auth/password/request-reset" && method === "POST") {
		return handlePasswordResetRequest(request, env);
	}
	if (pathname === "/v1/auth/password/reset" && method === "POST") {
		return handlePasswordReset(request, env);
	}
	if (pathname === "/v1/auth/password/change" && method === "POST") {
		return handlePasswordChange(request, env);
	}
	if (pathname === "/v1/auth/logout" && method === "POST") {
		return handleLogoutCurrent(request, env);
	}
	if (pathname === "/v1/auth/logout-all" && method === "POST") {
		return handleLogoutAll(request, env);
	}
	if (pathname === "/v1/auth/me" && method === "GET") {
		return handleMe(request, env);
	}

	// 用户信息
	if (pathname === "/user/profile" && method === "GET") {
		return handleUserProfile(request, env);
	}

	// AI 聊天接口
	if (pathname === "/v1/chat" && method === "POST") {
		return handleChat(request, env, ctx);
	}

	// 其余路径 → 404
	return Response.json({ error: "Not Found" }, { status: 404 });
}

async function handleAuthCenter(request, env, pathname, method) {
	if ((pathname === "/" || pathname === "/login") && method === "GET") return serveStaticPage(request, env, "/pages/auth/index.html", authPageOptions());
	if (isPasskeyRoute(pathname)) return handlePasskeyRoute(request, env, pathname);
	if (pathname === "/oauth/github/start" && method === "GET") return handleGitHubStart(request, env);
	if (pathname === "/oauth/github/callback" && method === "GET") return handleGitHubCallback(request, env);
	if (pathname === "/oauth/github/bind" && method === "GET") return serveStaticPage(request, env, "/pages/auth-bind/index.html", authPageOptions());
	if (pathname === "/oauth/github/bind/send-code" && method === "POST") return handleGitHubBindSendCode(request, env);
	if (pathname === "/oauth/github/bind/verify" && method === "POST") return handleGitHubBindVerify(request, env);
	if (pathname === "/auth/send-code" && method === "POST") return handleAuthSendCode(request, env);
	if (pathname === "/auth/login/password" && method === "POST") return handlePasswordLogin(request, env);
	if (pathname === "/auth/login/code" && method === "POST") return handleCodeLogin(request, env);
	if (pathname === "/auth/password/set-after-code" && method === "POST") return handlePasswordSetupAfterCode(request, env);
	if (pathname === "/auth/refresh" && method === "POST") return handleRefresh(request, env);
	return Response.json({ error: "Not Found" }, { status: 404 });
}

// ────────────────────────────────────────────────────────────────────────────
// 健康检查
// ────────────────────────────────────────────────────────────────────────────

/**
 * GET / 健康检查
 */
function handleHealth() {
	return Response.json({
		success: true,
		...SERVICE_META,
		status: "online",
	});
}

// ────────────────────────────────────────────────────────────────────────────
// POST /auth/email/send — 发送验证码
// ────────────────────────────────────────────────────────────────────────────

async function handleSendCode(request, env) {
	let body;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: "Invalid JSON Body" }, { status: 400 });
	}

	const { email } = body || {};
	if (!email || typeof email !== "string") {
		return Response.json({ error: "email is required" }, { status: 400 });
	}

	const result = await sendVerificationCode(email, env, body.purpose || "login");

	if (!result.success) {
		const status = result.error === "Please wait before requesting a new code"
			? 429
			: result.error === "Email delivery failed"
				? 502
				: 400;
		return Response.json({ error: result.error }, { status });
	}

	return Response.json({ success: true });
}

// ────────────────────────────────────────────────────────────────────────────
// POST /auth/email/verify — 校验验证码并登录
// ────────────────────────────────────────────────────────────────────────────

async function handleVerifyCode(request, env) {
	let body;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: "Invalid JSON Body" }, { status: 400 });
	}

	const { email, code } = body || {};
	if (!email || typeof email !== "string") {
		return Response.json({ error: "email is required" }, { status: 400 });
	}
	if (!code || typeof code !== "string") {
		return Response.json({ error: "code is required" }, { status: 400 });
	}

	const result = await verifyCode(email, code, env);

	if (!result.success) {
		const status = result.error === "Verification code locked due to too many attempts"
			? 429
			: 400;
		return Response.json({ error: result.error }, { status });
	}

	// 创建 Session
	const session = await createSession(result.userId, env);

	// 查询用户会员信息
	const user = await getUserById(result.userId, env);

	return Response.json({
		success: true,
		data: {
			access_token: session.token,
			refresh_token: session.refreshToken,
			token: session.token,
			refresh_expires_at: session.refreshExpiresAt,
			membership_type: user?.membership_type || "free",
			membership_expires_at: user?.membership_expires_at || null,
		},
	});
}

// ────────────────────────────────────────────────────────────────────────────
// POST /auth/logout — 退出登录
// ────────────────────────────────────────────────────────────────────────────

async function handleLogout(request, env) {
	await destroySession(request, env);
	return Response.json({ success: true });
}

// ────────────────────────────────────────────────────────────────────────────
// GET /user/profile — 获取当前用户信息和会员状态
// ────────────────────────────────────────────────────────────────────────────

async function handleUserProfile(request, env) {
	const auth = await authenticateRequest(request, env);
	if (!auth.ok) {
		return auth.response;
	}
	if (!auth.userId) {
		return Response.json({ error: "API Key not bound to a user" }, { status: 403 });
	}

	const user = await getUserById(auth.userId, env);
	if (!user) {
		return Response.json({ error: "User not found" }, { status: 404 });
	}
	if (user.status === "banned") return Response.json({ error: "Account banned" }, { status: 403 });

	// 计算有效会员等级（考虑过期降级）
	let effectivePlan = user.membership_type;
	if (effectivePlan !== "free" && user.membership_expires_at) {
		const now = new Date();
		const expiresAt = new Date(user.membership_expires_at);
		if (now >= expiresAt) {
			effectivePlan = "free";
		}
	}

	// 查计划详情
	const plan = await getMembershipPlan(effectivePlan, env);

	return Response.json({
		success: true,
		data: {
			email: user.email,
			role: user.role,
			membership: {
				type: user.membership_type,
				expires_at: user.membership_expires_at,
				effective_type: effectivePlan,
			},
			plan: plan ? {
				name: plan.name,
				daily_request_limit: plan.daily_request_limit,
				monthly_token_limit: plan.monthly_token_limit,
				available_models: JSON.parse(plan.available_models),
			} : null,
		},
	});
}

// ────────────────────────────────────────────────────────────────────────────
// POST /v1/chat
// ────────────────────────────────────────────────────────────────────────────

/**
 * POST /v1/chat
 *
 * 流程：鉴权 -> 校验 Secret -> 解析 Body -> 调用 MiniMax -> 计次 -> 写日志 -> 返回回复
 *
 * Body 支持两种形态（多模态向后兼容）：
 *   1. 纯文本：      { "message": "你好" }
 *   2. 多模态数组：  { "content": [...] }
 *   model 可选，默认 "MiniMax-M3"；需在用户计划可用模型列表中。
 *   同时存在时 content 优先；两者都缺则视为空文本。
 *
 * 错误码：
 *   400  Invalid JSON Body        Body 非合法 JSON
 *   400  Message too long         文本消息超过应用层限制
 *   400  Too many content items   多模态 content 数组超过应用层限制
 *   413  Request body too large   请求体超过应用层限制
 *   401  Missing API Key          未带 Authorization
 *   403  Invalid API Key          Key 无效 / Key 已禁用
 *   429  API quota exceeded       请求次数已达上限
 *   500  Server not configured    未配置 MINIMAX_API_KEY
 *   502  AI request failed        上游 AI 调用失败
 *
 * 额度规则：仅在 MiniMax 调用成功后才自增 request_count。
 *           鉴权失败、上游失败、内部错误一律不计次。
 * 日志规则：成功或失败都写 request_logs（通过 ctx.waitUntil 异步不阻塞响应）。
 * 应用层限制：请求体 256 KiB，文本消息 32,768 字符，content 数组 16 项。
 */
async function handleChat(request, env, ctx) {
	const startTime = Date.now();
	const clientIp = request.headers.get("CF-Connecting-IP") || "";
	const clientUa = request.headers.get("User-Agent") || "";

	// 1. 双鉴权：Session Token 优先，其次 X-API-Key，最后 Bearer API Key
	const auth = await authenticateRequest(request, env);
	if (!auth.ok) {
		return auth.response;
	}
	const { userId, apiKeyId } = auth;
	if (userId) {
		const account = await getUserById(userId, env);
		if (account?.status === "banned") return Response.json({ error: "Account banned" }, { status: 403 });
	}

	// 2. 校验 Worker Secret 是否已注入
	if (!env || !env.MINIMAX_API_KEY) {
		return Response.json(
			{ error: "Server not configured: MINIMAX_API_KEY missing" },
			{ status: 500 },
		);
	}

	// 3. 解析 Body（先限制读取大小，再解析 JSON）
	let body;
	try {
		body = await parseChatRequestBody(request);
	} catch (err) {
		if (err?.code === "CHAT_BODY_TOO_LARGE") {
			return Response.json(
				{ error: "Request body too large" },
				{ status: 413 },
			);
		}
		return Response.json(
			{ error: "Invalid JSON Body" },
			{ status: 400 },
		);
	}

	const payloadError = validateChatPayload(body);
	if (payloadError) {
		return Response.json({ error: payloadError }, { status: 400 });
	}

	// 4. 组装 user 消息
	let userContent;
	if (Array.isArray(body?.content)) {
		userContent = body.content;
	} else {
		userContent =
			typeof body?.message === "string" ? body.message : "";
	}

	const messages = [{ role: "user", content: userContent }];

	// 5. 额度检查（统一按 user_id）
	let model = body.model || "MiniMax-M3";
	const provider = "minimax";

	if (userId) {
		const quota = await checkUserQuota(userId, env);
		if (!quota.allowed) {
			return Response.json(
				{ error: quota.reason },
				{ status: 429 },
			);
		}
		// 校验 model 是否在用户可用模型列表中
		const userRecord = await env.StudyPulseDB.prepare(
			`SELECT membership_type, membership_expires_at FROM users WHERE id = ?`
		).bind(userId).first();
		let effectiveMembership = "free";
		if (userRecord) {
			effectiveMembership = userRecord.membership_type;
			if (effectiveMembership !== "free" && userRecord.membership_expires_at && new Date() >= new Date(userRecord.membership_expires_at)) {
				effectiveMembership = "free";
			}
		}
		const plan = await getMembershipPlan(effectiveMembership, env);
		if (plan) {
			const available = JSON.parse(plan.available_models);
			if (!available.includes(model)) {
				return Response.json(
					{ error: `Model "${model}" is not available on your plan` },
					{ status: 403 },
				);
			}
		}
	}

	// 6. 流式分支（必须在额度和模型白名单检查之后）
	if (body?.stream === true) {
		try {
			return await handleChatStream(request, env, ctx, { userId, apiKeyId }, messages, model);
		} catch (err) {
			console.error("AI stream setup error:", err?.stack || err?.message || err);
			return Response.json(
				{ error: "AI request failed" },
				{ status: 502 },
			);
		}
	}

	// 7. 调用 AI Provider（非流式）
	let result;
	try {
		result = await minimaxChat(messages, env);
	} catch (err) {
		console.error("AI provider error:", err?.message || err);

		const latency = Date.now() - startTime;
		ctx.waitUntil(
			writeRequestLog(env, {
				api_key_id: apiKeyId ?? null,
				user_id: userId ?? null,
				model,
				provider,
				status: 502,
				latency_ms: latency,
				ip: clientIp,
				user_agent: clientUa,
				error_message: (err?.message || "Unknown error").slice(0, 500),
			}).catch((e) => console.error("Failed to write error log:", e?.message || e)),
		);

		return Response.json(
			{ error: "AI request failed" },
			{ status: 502 },
		);
	}

	const { reply, usage } = result;

	// 8. 成功后记录
	if (apiKeyId) {
		try {
			await incrementApiKeyUsage(env, apiKeyId, usage?.total_tokens);
		} catch (err) {
			console.error("Failed to increment API key usage:", err?.message || err);
		}
	}

	if (userId) {
		try {
			await recordUsage(userId, apiKeyId ?? null, model, usage, env);
		} catch (err) {
			console.error("Failed to record usage:", err?.message || err);
		}
	}

	// 9. 异步写成功日志
	const latency = Date.now() - startTime;
	ctx.waitUntil(
		writeRequestLog(env, {
			api_key_id: apiKeyId ?? null,
			user_id: userId ?? null,
			model,
			provider,
			status: 200,
			latency_ms: latency,
			ip: clientIp,
			user_agent: clientUa,
			prompt_tokens: usage?.prompt_tokens ?? null,
			completion_tokens: usage?.completion_tokens ?? null,
			total_tokens: usage?.total_tokens ?? null,
		}).catch((e) => console.error("Failed to write request log:", e?.message || e)),
	);

	// 10. 返回模型回复
	return Response.json({
		success: true,
		data: {
			reply,
		},
	});
}

// ────────────────────────────────────────────────────────────────────────────
// POST /v1/chat (stream: true) — SSE 流式传输
// ────────────────────────────────────────────────────────────────────────────

/**
 * POST /v1/chat 流式分支
 *
 * 与 handleChat 共享鉴权、Secret 校验、Body 解析和消息组装。
 * 差异在于 AI 调用和响应格式：
 *   - 调用 minimaxChatStream() 获取上游 SSE ReadableStream
 *   - 使用 ReadableStream.tee() 将上游流一分为二：
 *       客户端分支：零包装直接作为 Response body 返回，保证字节级完整
 *       用量分支：  异步扫描提取 token，计次后写日志
 *   - 检测客户端断开（request.signal "abort"），终止用量扫描
 *   - usage 缺失时仍正常计次，日志标记 error_message="usage_missing"
 *
 * @param {Request} request
 * @param {object} env
 * @param {ExecutionContext} ctx
 * @param {object} apiKey - 已鉴权的 API Key D1 记录
 * @param {Array} messages - 已组装的消息数组
 * @param {string} modelOverride - 客户端指定的模型（可选，默认 MiniMax-M3）
 * @returns {Promise<Response>} SSE 流式响应或错误 JSON
 */
async function handleChatStream(request, env, ctx, { userId, apiKeyId }, messages, modelOverride) {
	const startTime = Date.now();
	const clientIp = request.headers.get("CF-Connecting-IP") || "";
	const clientUa = request.headers.get("User-Agent") || "";
	const model = modelOverride || "MiniMax-M3";
	const provider = "minimax";

	// 1. 发起上游流式请求
	let upstreamResponse;
	try {
		upstreamResponse = await minimaxChatStream(messages, env);
	} catch (err) {
		console.error("AI provider stream error:", err?.message || err);
		const latency = Date.now() - startTime;
		ctx.waitUntil(
			writeRequestLog(env, {
				api_key_id: apiKeyId ?? null,
				user_id: userId ?? null,
				model,
				provider,
				status: 502,
				latency_ms: latency,
				ip: clientIp,
				user_agent: clientUa,
				error_message: (err?.message || "Unknown error").slice(0, 500),
			}).catch((e) => console.error("Failed to write error log:", e?.message || e)),
		);
		return Response.json(
			{ error: "AI request failed" },
			{ status: 502 },
		);
	}

	// 2. tee() 将上游流一分为二
	if (!upstreamResponse.body || typeof upstreamResponse.body.tee !== "function") {
		console.error("MiniMax stream response did not contain a readable body");
		return Response.json(
			{ error: "AI request failed" },
			{ status: 502 },
		);
	}

	let clientStream;
	let usageStream;
	try {
		[clientStream, usageStream] = upstreamResponse.body.tee();
	} catch (err) {
		console.error("Failed to split MiniMax stream:", err?.stack || err?.message || err);
		return Response.json(
			{ error: "AI request failed" },
			{ status: 502 },
		);
	}

	// 3. 异步处理用量分支
	ctx.waitUntil(
		(async () => {
			const reader = usageStream.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			let lastUsageEvent = null;

			request.signal.addEventListener("abort", () => {
				reader.cancel().catch(() => {});
			});

			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;

					buffer += decoder.decode(value, { stream: true });
					const parts = buffer.split("\n\n");
					buffer = parts.pop();
					for (const event of parts) {
						const dataLine = event
							.split("\n")
							.find((line) => line.startsWith("data: "));
						if (dataLine) {
							const json = dataLine.slice(6);
							if (json !== "[DONE]") {
								try {
									const parsed = JSON.parse(json);
									if (parsed.usage) {
										lastUsageEvent = json;
									}
								} catch {
									/* 非 JSON 行忽略 */
								}
							}
						}
					}
				}

				buffer += decoder.decode();
				if (buffer.trim()) {
					const dataLine = buffer
						.split("\n")
						.find((line) => line.startsWith("data: "));
					if (dataLine) {
						const json = dataLine.slice(6);
						if (json !== "[DONE]") {
							try {
								const parsed = JSON.parse(json);
								if (parsed.usage) {
									lastUsageEvent = json;
								}
							} catch {
								/* 非 JSON 行忽略 */
							}
						}
					}
				}

				let usage = null;
				if (lastUsageEvent) {
					try {
						usage = JSON.parse(lastUsageEvent).usage;
					} catch {
						/* JSON 解析失败视为无 usage */
					}
				}

				const latency = Date.now() - startTime;
				const logEntry = {
					api_key_id: apiKeyId ?? null,
					user_id: userId ?? null,
					model,
					provider,
					status: 200,
					latency_ms: latency,
					ip: clientIp,
					user_agent: clientUa,
					prompt_tokens: usage?.prompt_tokens ?? null,
					completion_tokens: usage?.completion_tokens ?? null,
					total_tokens: usage?.total_tokens ?? null,
				};

				if (!usage) {
					logEntry.error_message = "usage_missing";
					console.warn(
						`Stream completed but usage missing for userId=${userId}, apiKeyId=${apiKeyId}`,
					);
				}

				const promises = [];
				if (apiKeyId) {
					promises.push(incrementApiKeyUsage(env, apiKeyId, usage?.total_tokens));
				}
				if (userId) {
					promises.push(recordUsage(userId, apiKeyId ?? null, model, usage, env));
				}
				promises.push(writeRequestLog(env, logEntry));

				await Promise.all(promises);
			} catch (err) {
				console.error("Usage stream processing error:", err?.message || err);
				const latency = Date.now() - startTime;
				await writeRequestLog(env, {
					api_key_id: apiKeyId ?? null,
					user_id: userId ?? null,
					model,
					provider,
					status: 200,
					latency_ms: latency,
					ip: clientIp,
					user_agent: clientUa,
					error_message: (err?.message || "Usage processing error").slice(0, 500),
				}).catch(() => {});
			}
		})(),
	);

	// 4. 直接返回上游 SSE 流
	return new Response(clientStream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
}
