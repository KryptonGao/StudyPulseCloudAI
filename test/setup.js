/**
 * Vitest 全局 setup：在所有测试前应用所有 migration 并种子数据。
 *
 * cloudflare:test 提供的 env.StudyPulseDB 是 miniflare 内存 D1，
 * 每个 vitest 进程独立，不会污染本地 .wrangler/state 数据。
 */
import { env } from "cloudflare:test";
import { beforeAll } from "vitest";
import { sha256Hex } from "../src/auth.js";

// 已有 migrations
import migration1Sql from "../migrations/0001_create_api_keys.sql?raw";
import migration2Sql from "../migrations/0002_create_request_logs.sql?raw";
import migration3Sql from "../migrations/0003_add_limit_type.sql?raw";

// 新增 migrations (SaaS 用户体系)
import migration4Sql from "../migrations/0004_create_users.sql?raw";
import migration5Sql from "../migrations/0005_create_sessions.sql?raw";
import migration6Sql from "../migrations/0006_create_verification_codes.sql?raw";
import migration7Sql from "../migrations/0007_create_membership_plans.sql?raw";
import migration8Sql from "../migrations/0008_alter_request_logs.sql?raw";
import migration9Sql from "../migrations/0009_create_usage_records.sql?raw";
import migration10Sql from "../migrations/0010_create_admin_logs.sql?raw";
import migration11Sql from "../migrations/0011_seed_membership_plans.sql?raw";
import migration12Sql from "../migrations/0012_create_blacklisted_emails.sql?raw";
import migration13Sql from "../migrations/0013_make_api_key_id_nullable.sql?raw";
import migration14Sql from "../migrations/0014_add_password_auth.sql?raw";
import migration15Sql from "../migrations/0015_create_bans_and_appeals.sql?raw";
import migration16Sql from "../migrations/0016_create_feedback_tickets.sql?raw";
import migration17Sql from "../migrations/0017_unified_identity.sql?raw";
import migration18Sql from "../migrations/0018_auth_challenges.sql?raw";
import migration19Sql from "../migrations/0019_create_contribution_tickets.sql?raw";
import migration20Sql from "../migrations/0020_update_membership_quotas.sql?raw";
import migration21Sql from "../migrations/0021_create_passkeys.sql?raw";
import migration22Sql from "../migrations/0022_update_membership_quotas.sql?raw";
import migration23Sql from "../migrations/0023_ai_router_points.sql?raw";

const allMigrations = [
	migration1Sql,  // 0001: api_keys
	migration2Sql,  // 0002: request_logs
	migration3Sql,  // 0003: add limit_type + token_count
	migration4Sql,  // 0004: users
	migration5Sql,  // 0005: sessions
	migration6Sql,  // 0006: email_verification_codes
	migration7Sql,  // 0007: membership_plans
	migration8Sql,  // 0008: alter request_logs + user_id
	migration9Sql,  // 0009: usage_records
	migration10Sql, // 0010: admin_logs
	migration11Sql, // 0011: seed membership_plans
	migration12Sql, // 0012: blacklisted_emails compatibility table
	migration13Sql, // 0013: nullable request_logs.api_key_id
	migration14Sql, // 0014: password auth, normalized email, revocation, rate limits
	migration15Sql, // 0015: bans and appeals
	migration16Sql, // 0016: support feedback tickets
	migration17Sql, // 0017: unified identity and refresh sessions
	migration18Sql, // 0018: short-lived auth challenges
	migration19Sql, // 0019: code contribution review tickets
	migration20Sql, // 0020: membership quota update
	migration21Sql, // 0021: passkey credentials and enrollment prompt state
	migration22Sql, // 0022: membership quota update
	migration23Sql, // 0023: AI router + points
];

// 与 v0.2 内存 Set 时期一致的 Beta Key，保证旧测试不破
const BETA_TEST_KEY = "sp_beta_test001";

beforeAll(async () => {
	// 1. 应用所有 migration（建表 + 索引，幂等）
	for (const sql of allMigrations) {
		const statements = sql
			.split(";")
			.map((chunk) =>
				chunk
					.split("\n")
					.filter((line) => !line.trim().startsWith("--"))
					.join("\n")
					.trim(),
			)
			.filter((s) => s.length > 0);

		for (const stmt of statements) {
			await env.StudyPulseDB.prepare(stmt).run();
		}
	}

	// 0003 is intentionally a production no-op because the live API-key
	// columns predate that migration. Keep the in-memory fixture equivalent.
	for (const statement of [
		"ALTER TABLE api_keys ADD COLUMN limit_type TEXT NOT NULL DEFAULT 'count'",
		"ALTER TABLE api_keys ADD COLUMN token_count INTEGER NOT NULL DEFAULT 0",
	]) {
		try {
			await env.StudyPulseDB.prepare(statement).run();
		} catch (error) {
			if (!/duplicate column name/i.test(error?.message || "")) throw error;
		}
	}

	// 2. 种子 Beta Key：只存哈希，原始 Key 不进 DB
	const hash = await sha256Hex(BETA_TEST_KEY);
	await env.StudyPulseDB.prepare(
		`INSERT OR IGNORE INTO api_keys (key_hash, name, enabled)
		 VALUES (?, ?, 1)`,
	)
		.bind(hash, "Beta Test Key 001")
		.run();

	// 3. 创建一个 seed 用户用于测试
	const seedUserId = crypto.randomUUID();
	await env.StudyPulseDB.prepare(
		`INSERT OR IGNORE INTO users
			 (id, email, email_normalized, email_verified, role, membership_type)
		 VALUES (?, 'test@studypulse.app', 'test@studypulse.app', 1, 'admin', 'pro')`,
	)
		.bind(seedUserId)
		.run();
});
