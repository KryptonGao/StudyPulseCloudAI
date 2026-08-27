import { requireSessionAuth } from "../auth/middleware.js";
import { getMembershipPlan } from "../membership/membership.js";
import { getUserById } from "../users/users.js";
import { createContribution } from "../contributions/service.js";
import { handleListTickets, handleCreateTicket } from "../support/routes.js";

const TIME_ZONE = "Asia/Shanghai";

function json(data, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "private, no-store" } });
}

function periodStarts(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(now);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  const today = new Date(Date.UTC(values.year, values.month - 1, values.day) - 8 * 60 * 60 * 1000);
  const month = new Date(Date.UTC(values.year, values.month - 1, 1) - 8 * 60 * 60 * 1000);
  const trend = new Date(today.getTime() - 13 * 24 * 60 * 60 * 1000);
  return { today: today.toISOString(), month: month.toISOString(), trend: trend.toISOString() };
}

function effectivePlan(user) {
  if (user.membership_type !== "free" && user.membership_expires_at && Date.now() >= new Date(user.membership_expires_at).getTime()) return "free";
  return user.membership_type || "free";
}

function quotaStarts(user, planId, starts) {
  const expiredAt = planId === "free" && user.membership_type !== "free" && user.membership_expires_at
    ? new Date(user.membership_expires_at)
    : null;
  const transition = expiredAt && Number.isFinite(expiredAt.getTime()) ? expiredAt.toISOString() : null;
  return {
    day: transition && transition > starts.today ? transition : starts.today,
    month: transition && transition > starts.month ? transition : starts.month,
  };
}

function trendSeries(rows, startsAt) {
  const byDay = new Map(rows.map((point) => [point.day, point]));
  const start = new Date(startsAt).getTime();
  return Array.from({ length: 14 }, (_, index) => {
    const day = new Date(start + index * 24 * 60 * 60 * 1000 + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const point = byDay.get(day);
    return { day, requests: Number(point?.requests || 0), tokens: Number(point?.tokens || 0) };
  });
}

export async function handleUserDashboardApi(request, env, pathname) {
	const auth = await requireSessionAuth(request, env);
	if (!auth.ok) return auth.response;
	const user = await getUserById(auth.userId, env);
	if (!user) return json({ error: "User not found" }, 404);
	if (user.status === "banned") return json({ error: "Account banned" }, 403);
	if (pathname === "/api/user/feedback") {
		if (request.method.toUpperCase() === "GET") return handleListTickets(request, env);
		if (request.method.toUpperCase() === "POST") return handleCreateTicket(request, env);
	}
	if (pathname === "/api/user/contributions" && request.method.toUpperCase() === "GET") {
		const result = await env.StudyPulseDB.prepare("SELECT id,contribution_url,contribution_type,description,status,awarded_membership,membership_expires_at,admin_reply,created_at,reviewed_at FROM contribution_tickets WHERE user_id = ? ORDER BY created_at DESC LIMIT 30").bind(auth.userId).all();
		return json({ success: true, data: result.results || [] });
	}
	if (pathname === "/api/user/contributions" && request.method.toUpperCase() === "POST") {
		let body; try { body = await request.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
		const result = await createContribution(auth.userId, body, env);
		return json(result.success ? { success: true, data: { id: result.id } } : { error: result.error }, result.success ? 201 : result.status || 400);
	}
	if (pathname !== "/api/user/dashboard" || request.method.toUpperCase() !== "GET") return json({ error: "Not Found" }, 404);

  const starts = periodStarts();
  const planId = effectivePlan(user);
  const plan = await getMembershipPlan(planId, env);
  const quota = quotaStarts(user, planId, starts);
  const [today, month, quotaDay, quotaMonth, trend, recent] = await Promise.all([
    env.StudyPulseDB.prepare(`SELECT COUNT(*) AS requests, COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens, COALESCE(SUM(total_tokens),0) AS tokens FROM usage_records WHERE user_id = ? AND datetime(created_at) >= datetime(?)`).bind(user.id, starts.today).first(),
    env.StudyPulseDB.prepare(`SELECT COUNT(*) AS requests, COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens, COALESCE(SUM(total_tokens),0) AS tokens FROM usage_records WHERE user_id = ? AND datetime(created_at) >= datetime(?)`).bind(user.id, starts.month).first(),
    env.StudyPulseDB.prepare(`SELECT COUNT(*) AS requests FROM usage_records WHERE user_id = ? AND datetime(created_at) >= datetime(?)`).bind(user.id, quota.day).first(),
    env.StudyPulseDB.prepare(`SELECT COALESCE(SUM(total_tokens),0) AS tokens FROM usage_records WHERE user_id = ? AND datetime(created_at) >= datetime(?)`).bind(user.id, quota.month).first(),
    env.StudyPulseDB.prepare(`SELECT strftime('%Y-%m-%d', created_at, '+8 hours') AS day, COUNT(*) AS requests, COALESCE(SUM(total_tokens),0) AS tokens FROM usage_records WHERE user_id = ? AND datetime(created_at) >= datetime(?) GROUP BY day ORDER BY day`).bind(user.id, starts.trend).all(),
    env.StudyPulseDB.prepare(`SELECT id, model, status, prompt_tokens AS input_tokens, completion_tokens AS output_tokens, total_tokens AS tokens, request_time AS created_at FROM request_logs WHERE user_id = ? ORDER BY request_time DESC LIMIT 8`).bind(user.id).all(),
  ]);

  return json({ success: true, data: {
    user: { id: user.id, email: user.email, username: user.username, avatar: user.avatar_url, created_at: user.created_at, status: user.status || "active", email_verified: !!user.email_verified },
    subscription: { plan: plan?.name || planId.toUpperCase(), type: user.membership_type || "free", effective_type: planId, status: planId === "free" && user.membership_type !== "free" ? "expired" : "active", expire_time: user.membership_expires_at, auto_renew: false, daily_request_limit: plan?.daily_request_limit ?? null, monthly_token_limit: plan?.monthly_token_limit ?? null },
    usage: {
      today: { requests: Number(today?.requests || 0), input_tokens: Number(today?.input_tokens || 0), output_tokens: Number(today?.output_tokens || 0), tokens: Number(today?.tokens || 0) },
      month: { requests: Number(month?.requests || 0), input_tokens: Number(month?.input_tokens || 0), output_tokens: Number(month?.output_tokens || 0), tokens: Number(month?.tokens || 0) },
      quota: { day: { requests: Number(quotaDay?.requests || 0), starts_at: quota.day }, month: { tokens: Number(quotaMonth?.tokens || 0), starts_at: quota.month } },
      trend: trendSeries(trend.results || [], starts.trend),
    },
    recent_calls: recent.results || [],
  } });
}
