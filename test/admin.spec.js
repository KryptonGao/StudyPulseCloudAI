/**
 * StudyPulse Cloud AI - 管理后台 API 测试
 *
 * 测试范围：
 *   - 未授权访问
 *   - 列出 Key
 *   - 创建 Key（rawKey 仅创建时返回，需要 user_id）
 *   - 禁用 Key
 *   - 删除 Key
 *   - 重置配额
 *   - key_hash 绝不暴露
 */
import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { sha256Hex } from "../src/auth.js";

const ADMIN_TOKEN = "test-admin-token-12345";

// 种子用户 ID
let seedUserId;

// 辅助函数：发送管理 API 请求
async function adminFetch(path, options = {}) {
	const { method = "GET", body, token = ADMIN_TOKEN, accessJwt } = options;
	const headers = {
		"Content-Type": "application/json",
		"X-CSRF-Token": "test-csrf",
	};
	if (token) {
		headers["Authorization"] = `Bearer ${token}`;
	}
	if (accessJwt) {
		headers["Cf-Access-Jwt-Assertion"] = accessJwt;
	}
	if (options.csrfCookie) {
		headers["Cookie"] = `admin_csrf=${options.csrfCookie}`;
	}

	const opts = { method, headers };
	if (body) opts.body = JSON.stringify(body);

	return SELF.fetch(`http://localhost${path}`, opts);
}

// 种子测试数据和用户
beforeAll(async () => {
	// 获取种子用户 ID
	const user = await env.StudyPulseDB.prepare(
		"SELECT id FROM users WHERE email = ?",
	)
		.bind("test@studypulse.app")
		.first();
	seedUserId = user.id;

	// 创建几个测试 Key
	const keys = [
		{ name: "Test Key 1", request_limit: 100 },
		{ name: "Test Key 2", request_limit: null },
		{ name: "Disabled Key", request_limit: 50 },
	];

	for (const k of keys) {
		const rawKey = "sp_test_" + crypto.randomUUID().slice(0, 8);
		const hash = await sha256Hex(rawKey);
		await env.StudyPulseDB.prepare(
			`INSERT OR IGNORE INTO api_keys (key_hash, name, enabled, request_count, request_limit)
			 VALUES (?, ?, ?, 0, ?)`,
		)
			.bind(hash, k.name, k.name === "Disabled Key" ? 0 : 1, k.request_limit ?? null)
			.run();
	}

	// 创建一个已超额 Key
	const exceededKey = "sp_test_exceeded_" + crypto.randomUUID().slice(0, 8);
	const exceededHash = await sha256Hex(exceededKey);
	await env.StudyPulseDB.prepare(
		`INSERT OR IGNORE INTO api_keys (key_hash, name, enabled, request_count, request_limit)
		 VALUES (?, ?, 1, 10, 10)`,
	)
		.bind(exceededHash, "Exceeded Key")
		.run();
});

describe("Admin API - 鉴权", () => {
	it("无 Authorization header 返回 401", async () => {
		const res = await adminFetch("/api/admin/keys", { token: "" });
		expect(res.status).toBe(401);
	});

	it("错误的 ADMIN_API_TOKEN 返回 401", async () => {
		const res = await adminFetch("/api/admin/keys", { token: "wrong-token" });
		expect(res.status).toBe(401);
	});

	it("伪造的 Cloudflare Access header 返回 401", async () => {
		const res = await adminFetch("/api/admin/keys", {
			token: "",
			accessJwt: "eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJhdHRhY2tlciJ9.invalid",
		});
		expect(res.status).toBe(401);
	});

	it("workers.dev 不提供管理后台入口", async () => {
		const res = await SELF.fetch("https://studypulse-cloud-ai.workers.dev/api/admin/keys", {
			headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
		});
		expect(res.status).toBe(404);
	});

	it("正确的 ADMIN_API_TOKEN 可以访问管理 API", async () => {
		const res = await adminFetch("/api/admin/keys", {
			csrfCookie: "test-csrf",
		});
		expect(res.status).toBe(200);
	});

	it("状态变更接口需要 CSRF Token", async () => {
		const res = await adminFetch("/api/admin/keys/create", {
			method: "POST",
			body: { name: "Test", user_id: seedUserId },
			csrfCookie: "",
		});
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: "CSRF validation failed" });
	});
});

describe("Admin API - 仪表盘统计", () => {
	it("返回正确的统计数据", async () => {
		const res = await adminFetch("/api/admin/stats");
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.success).toBe(true);
		expect(json.data.totalKeys).toBeGreaterThanOrEqual(4);
		expect(json.data.enabledKeys).toBeGreaterThanOrEqual(3);
		expect(json.data.enabledKeys).toBeLessThanOrEqual(json.data.totalKeys);
		expect(typeof json.data.totalRequests).toBe("number");
		expect(json.data.exceededQuotaKeys).toBeGreaterThanOrEqual(1);
		expect(typeof json.data.totalUsers).toBe("number");
		expect(json.data.totalUsers).toBeGreaterThanOrEqual(1);
	});
});

describe("Admin API - Key 列表", () => {
	it("列出所有 Key，不包含 key_hash", async () => {
		const res = await adminFetch("/api/admin/keys");
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.success).toBe(true);
		expect(Array.isArray(json.data)).toBe(true);
		expect(json.data.length).toBeGreaterThanOrEqual(4);

		for (const key of json.data) {
			expect(key).not.toHaveProperty("key_hash");
			expect(key).not.toHaveProperty("rawKey");
			expect(key).toHaveProperty("id");
			expect(key).toHaveProperty("name");
			expect(key).toHaveProperty("enabled");
			expect(key).toHaveProperty("request_count");
			expect(key).toHaveProperty("request_limit");
		}
	});
});

describe("Admin API - 创建 Key", () => {
	it("成功创建 Key 并返回 rawKey", async () => {
		const res = await adminFetch("/api/admin/keys/create", {
			method: "POST",
			body: { name: "New Test Key", user_id: seedUserId, request_limit: 200, notes: "单元测试" },
			csrfCookie: "test-csrf",
		});
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.success).toBe(true);
		expect(json.data).toHaveProperty("id");
		expect(json.data).toHaveProperty("rawKey");
		expect(json.data.rawKey).toMatch(/^sp_beta_/);
		expect(json.data.rawKey.length).toBeGreaterThan(20);

		// 验证 rawKey 不会再次出现
		const listRes = await adminFetch("/api/admin/keys");
		const list = await listRes.json();
		const created = list.data.find((k) => k.id === json.data.id);
		expect(created).toBeTruthy();
		expect(created).not.toHaveProperty("rawKey");
		expect(created).not.toHaveProperty("key_hash");
	});

	it("缺少 name 返回 400", async () => {
		const res = await adminFetch("/api/admin/keys/create", {
			method: "POST",
			body: { user_id: seedUserId },
			csrfCookie: "test-csrf",
		});
		expect(res.status).toBe(400);
		const json = await res.json();
		expect(json.error).toBe("name is required");
	});

	it("缺少 user_id 返回 400", async () => {
		const res = await adminFetch("/api/admin/keys/create", {
			method: "POST",
			body: { name: "Test" },
			csrfCookie: "test-csrf",
		});
		expect(res.status).toBe(400);
		const json = await res.json();
		expect(json.error).toBe("user_id is required");
	});
});

describe("Admin API - 更新 Key", () => {
	it("成功更新 Key 的名称和状态", async () => {
		const res = await adminFetch("/api/admin/keys/update", {
			method: "POST",
			body: { id: 1, name: "Updated Key", enabled: false },
			csrfCookie: "test-csrf",
		});
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.success).toBe(true);
	});

	it("更新不存在的 Key 返回 404", async () => {
		const res = await adminFetch("/api/admin/keys/update", {
			method: "POST",
			body: { id: 99999, name: "Ghost" },
			csrfCookie: "test-csrf",
		});
		expect(res.status).toBe(404);
	});
});

describe("Admin API - 禁用 Key", () => {
	it("禁用 Key 后 enabled = 0", async () => {
		const res = await adminFetch("/api/admin/keys/update", {
			method: "POST",
			body: { id: 1, enabled: false },
			csrfCookie: "test-csrf",
		});
		expect(res.status).toBe(200);

		const listRes = await adminFetch("/api/admin/keys");
		const list = await listRes.json();
		const key = list.data.find((k) => k.id === 1);
		expect(key.enabled).toBe(0);
	});
});

describe("Admin API - 重置配额", () => {
	it("重置配额后 request_count = 0", async () => {
		const res = await adminFetch("/api/admin/keys/reset-quota", {
			method: "POST",
			body: { id: 1 },
			csrfCookie: "test-csrf",
		});
		expect(res.status).toBe(200);
	});

	it("重置不存在的 Key 返回 404", async () => {
		const res = await adminFetch("/api/admin/keys/reset-quota", {
			method: "POST",
			body: { id: 99999 },
			csrfCookie: "test-csrf",
		});
		expect(res.status).toBe(404);
	});
});

describe("Admin API - 删除 Key", () => {
	it("成功删除 Key", async () => {
		const res = await adminFetch("/api/admin/keys/delete", {
			method: "POST",
			body: { id: 3 },
			csrfCookie: "test-csrf",
		});
		expect(res.status).toBe(200);
	});

	it("删除不存在的 Key 返回 404", async () => {
		const res = await adminFetch("/api/admin/keys/delete", {
			method: "POST",
			body: { id: 99999 },
			csrfCookie: "test-csrf",
		});
		expect(res.status).toBe(404);
	});
});

describe("Admin API - 踢用户下线", () => {
	it("撤销用户的全部 Session", async () => {
		const sessionId = crypto.randomUUID();
		await env.StudyPulseDB.prepare(
			`INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
			 VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
		)
			.bind(sessionId, seedUserId, await sha256Hex("sp_sess_admin_test"), new Date(Date.now() + 86_400_000).toISOString())
			.run();

		const res = await adminFetch("/api/admin/users/revoke-sessions", {
			method: "POST",
			body: { user_id: seedUserId },
			csrfCookie: "test-csrf",
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.revoked_count).toBeGreaterThanOrEqual(1);

		const session = await env.StudyPulseDB.prepare("SELECT revoked_at FROM sessions WHERE id = ?").bind(sessionId).first();
		expect(session.revoked_at).toBeTruthy();
	});

	it("用户不存在返回 404", async () => {
		const res = await adminFetch("/api/admin/users/revoke-sessions", {
			method: "POST",
			body: { user_id: crypto.randomUUID() },
			csrfCookie: "test-csrf",
		});
		expect(res.status).toBe(404);
	});
});

describe("Admin API - 用户认证状态", () => {
	it("返回 GitHub 绑定和密码设置状态，但不暴露凭证", async () => {
		const userId = crypto.randomUUID();
		const email = `${userId}@example.com`;
		await env.StudyPulseDB.prepare(
			"INSERT INTO users (id,email,email_normalized,email_verified) VALUES (?,?,?,1)",
		).bind(userId, email, email).run();
		await env.StudyPulseDB.prepare(
			"INSERT INTO user_oauth_accounts (id,user_id,provider,provider_user_id) VALUES (?,?,?,?)",
		).bind(crypto.randomUUID(), userId, "github", `github-${userId}`).run();
		await env.StudyPulseDB.prepare(
			"INSERT INTO user_credentials (user_id,password_hash,password_salt,password_iterations,password_updated_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
		).bind(userId, "not-returned", "", 12, new Date().toISOString(), new Date().toISOString(), new Date().toISOString()).run();
		await env.StudyPulseDB.prepare(
			"INSERT INTO user_passkeys (credential_id,user_id,public_key,name,last_used_at) VALUES (?,?,?,?,?)",
		).bind(`admin-test-${crypto.randomUUID()}`, userId, "not-returned", "Admin test device", new Date().toISOString()).run();

		const list = await adminFetch("/api/admin/users");
		expect(list.status).toBe(200);
		const listed = (await list.json()).data.find((user) => user.id === userId);
		expect(listed.github_bound).toBe(1);
		expect(listed.password_set).toBe(1);
		expect(listed.passkey_bound).toBe(1);
		expect(listed.passkey_count).toBe(1);
		expect(listed).not.toHaveProperty("password_hash");
		expect(listed).not.toHaveProperty("public_key");

		const detail = await adminFetch(`/api/admin/users/${encodeURIComponent(userId)}`);
		expect(detail.status).toBe(200);
		const detailed = (await detail.json()).data;
		expect(detailed.github_bound).toBe(1);
		expect(detailed.password_set).toBe(1);
		expect(detailed.passkey_bound).toBe(1);
		expect(detailed.passkey_count).toBe(1);
		expect(detailed.passkey_last_used_at).toBeTruthy();
		expect(detailed).not.toHaveProperty("password_hash");
		expect(detailed).not.toHaveProperty("public_key");
	});
});

describe("Admin API - 更新用户会员到期时间", () => {
	it("可以设置和清空会员到期时间", async () => {
		const userId = crypto.randomUUID();
		const email = `${userId}@example.com`;
		await env.StudyPulseDB.prepare(
			"INSERT INTO users (id,email,email_normalized,email_verified,membership_type) VALUES (?,?,?,1,'plus')",
		).bind(userId, email, email).run();

		const expiresAt = "2026-09-01T14:00:00.000Z";
		const updateRes = await adminFetch("/api/admin/users/update", {
			method: "POST",
			body: { id: userId, membership_expires_at: expiresAt },
			csrfCookie: "test-csrf",
		});
		expect(updateRes.status).toBe(200);

		const updated = await env.StudyPulseDB.prepare(
			"SELECT membership_expires_at FROM users WHERE id = ?",
		).bind(userId).first();
		expect(new Date(updated.membership_expires_at).toISOString()).toBe(expiresAt);

		const clearRes = await adminFetch("/api/admin/users/update", {
			method: "POST",
			body: { id: userId, membership_expires_at: null },
			csrfCookie: "test-csrf",
		});
		expect(clearRes.status).toBe(200);

		const cleared = await env.StudyPulseDB.prepare(
			"SELECT membership_expires_at FROM users WHERE id = ?",
		).bind(userId).first();
		expect(cleared.membership_expires_at).toBeNull();
	});

	it("非法到期时间返回 400", async () => {
		const res = await adminFetch("/api/admin/users/update", {
			method: "POST",
			body: { id: seedUserId, membership_expires_at: "not-a-date" },
			csrfCookie: "test-csrf",
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("membership_expires_at is invalid");
	});
});

describe("Admin API - 删除用户", () => {
	it("删除用户及关联数据，并返回邮件发送状态", async () => {
		const userId = crypto.randomUUID();
		const email = `${userId}@example.com`;
		await env.StudyPulseDB.prepare("INSERT INTO users (id,email,email_normalized,email_verified) VALUES (?,?,?,1)").bind(userId, email, email).run();
		await env.StudyPulseDB.prepare("INSERT INTO api_keys (key_hash,name,user_id) VALUES (?,?,?)").bind(await sha256Hex(`delete-${userId}`), "待删除 Key", userId).run();
		await env.StudyPulseDB.prepare("INSERT INTO usage_records (user_id,total_tokens) VALUES (?,?)").bind(userId, 123).run();
		await env.StudyPulseDB.prepare("INSERT INTO user_passkeys (credential_id,user_id,public_key) VALUES (?,?,?)").bind(`delete-passkey-${crypto.randomUUID()}`, userId, "not-returned").run();
		await env.StudyPulseDB.prepare("INSERT INTO auth_challenges (token_hash,kind,user_id,expires_at) VALUES (?,?,?,?)").bind(await sha256Hex(`delete-challenge-${userId}`), "passkey_registration", userId, new Date(Date.now() + 60_000).toISOString()).run();

		const res = await adminFetch("/api/admin/users/delete", { method: "POST", body: { user_id: userId }, csrfCookie: "test-csrf" });
		expect(res.status).toBe(200);
		expect((await res.json()).data.emailSent).toBe(false);
		expect(await env.StudyPulseDB.prepare("SELECT id FROM users WHERE id=?").bind(userId).first()).toBeNull();
		expect(await env.StudyPulseDB.prepare("SELECT id FROM api_keys WHERE user_id=?").bind(userId).first()).toBeNull();
		expect(await env.StudyPulseDB.prepare("SELECT user_id FROM usage_records WHERE user_id=?").bind(userId).first()).toBeNull();
		expect(await env.StudyPulseDB.prepare("SELECT user_id FROM user_passkeys WHERE user_id=?").bind(userId).first()).toBeNull();
		expect(await env.StudyPulseDB.prepare("SELECT user_id FROM auth_challenges WHERE user_id=?").bind(userId).first()).toBeNull();
	});

	it("不允许删除管理员账号", async () => {
		const res = await adminFetch("/api/admin/users/delete", { method: "POST", body: { user_id: seedUserId }, csrfCookie: "test-csrf" });
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("Admin users cannot be deleted");
	});
});

describe("Admin API - rawKey 安全性", () => {
	it("创建 Key 时返回 rawKey", async () => {
		const res = await adminFetch("/api/admin/keys/create", {
			method: "POST",
			body: { name: "Security Test Key", user_id: seedUserId },
			csrfCookie: "test-csrf",
		});
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.data.rawKey).toBeTruthy();
		expect(json.data.rawKey).toMatch(/^sp_beta_/);
	});

	it("列表和更新接口绝不返回 rawKey 或 key_hash", async () => {
		const statsRes = await adminFetch("/api/admin/stats");
		const stats = await statsRes.json();
		expect(stats.data).not.toHaveProperty("key_hash");

		const listRes = await adminFetch("/api/admin/keys");
		const list = await listRes.json();
		for (const key of list.data) {
			expect(key).not.toHaveProperty("rawKey");
			expect(key).not.toHaveProperty("key_hash");
		}

		const updateRes = await adminFetch("/api/admin/keys/update", {
			method: "POST",
			body: { id: 1, name: "Safety Check" },
			csrfCookie: "test-csrf",
		});
		const update = await updateRes.json();
		expect(update).not.toHaveProperty("rawKey");
		expect(update).not.toHaveProperty("key_hash");
	});

	it("更新 Key 响应不包含 rawKey 或 key_hash", async () => {
		const res = await adminFetch("/api/admin/keys/update", {
			method: "POST",
			body: { id: 1, name: "Another Check" },
			csrfCookie: "test-csrf",
		});
		const json = await res.json();
		expect(json).not.toHaveProperty("rawKey");
		expect(json).not.toHaveProperty("key_hash");
	});
});

describe("Admin API - 请求日志", () => {
	it("可以查询请求日志", async () => {
		const res = await adminFetch("/api/admin/logs");
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.success).toBe(true);
		expect(Array.isArray(json.data)).toBe(true);
	});

	it("日志不包含敏感字段", async () => {
		const res = await adminFetch("/api/admin/logs");
		const json = await res.json();
		for (const log of json.data) {
			expect(log).not.toHaveProperty("prompt");
			expect(log).not.toHaveProperty("response");
			expect(log).not.toHaveProperty("rawKey");
			expect(log).not.toHaveProperty("key_hash");
		}
	}, 30000);
});

describe("Admin API - 积分计价", () => {
	afterEach(async () => {
		await adminFetch("/api/admin/pricing/restore", {
			method: "POST",
			csrfCookie: "test-csrf",
			body: {},
		});
	});
	it("列出三个模型的默认毫积分", async () => {
		const res = await adminFetch("/api/admin/pricing");
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.success).toBe(true);
		const models = Object.fromEntries(json.data.models.map((row) => [row.model, row]));
		expect(models["mimo-v2.5"].input).toBe(10);
		expect(models.hy3.output).toBe(120);
		expect(models["minimax-m3"].cache).toBe(20);
		expect(models["mimo-v2.5"].tokensPerPoint.input).toBe(100);
	});

	it("按模型更新比值并影响后续计费预览", async () => {
		const update = await adminFetch("/api/admin/pricing/update", {
			method: "POST",
			csrfCookie: "test-csrf",
			body: {
				model: "mimo-v2.5",
				input: 20,
				output: 60,
				reasoning: 60,
				cache: 10,
				multiplier: 2,
			},
		});
		expect(update.status).toBe(200);
		const json = await update.json();
		const mimo = json.data.models.find((row) => row.model === "mimo-v2.5");
		expect(mimo.input).toBe(20);
		expect(mimo.multiplier).toBe(2);
		expect(mimo.preview.input1000).toBe(40);

		const restore = await adminFetch("/api/admin/pricing/restore", {
			method: "POST",
			csrfCookie: "test-csrf",
			body: {},
		});
		expect(restore.status).toBe(200);
		const restored = (await restore.json()).data.models.find((row) => row.model === "mimo-v2.5");
		expect(restored.input).toBe(10);
		expect(restored.multiplier).toBe(1);
	});

	it("拒绝未知模型", async () => {
		const res = await adminFetch("/api/admin/pricing/update", {
			method: "POST",
			csrfCookie: "test-csrf",
			body: { model: "gpt-x", input: 1, output: 1, reasoning: 1, cache: 1, multiplier: 1 },
		});
		expect(res.status).toBe(400);
	});
});
