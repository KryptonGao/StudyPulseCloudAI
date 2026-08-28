-- Migration number: 0023  2026-08-28T00:00:00.000Z
--
-- StudyPulse Cloud AI - AI Router + Points ledger
--
-- Adds monthly AI point quotas, routing/billing metadata on usage_records
-- and request_logs. Does not drop monthly_token_limit (deprecated, kept for
-- one-to-two-version compatibility). Historical token rows are not converted
-- into points: new points_charged defaults to 0.

ALTER TABLE membership_plans ADD COLUMN monthly_point_limit INTEGER;

-- INTERNAL_TEST initial conversion (~10 tokens per point from prior token caps).
-- Not a commercial price. Edit these numbers here when retuning quotas.
UPDATE membership_plans SET monthly_point_limit = 5000 WHERE id = 'free';
UPDATE membership_plans SET monthly_point_limit = 200000 WHERE id = 'plus';
UPDATE membership_plans SET monthly_point_limit = 400000 WHERE id = 'pro';

ALTER TABLE usage_records ADD COLUMN provider TEXT;
ALTER TABLE usage_records ADD COLUMN caller TEXT;
ALTER TABLE usage_records ADD COLUMN requested_thinking TEXT;
ALTER TABLE usage_records ADD COLUMN effective_thinking TEXT;
ALTER TABLE usage_records ADD COLUMN reasoning_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_records ADD COLUMN points_charged INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_records ADD COLUMN pricing_version TEXT;
ALTER TABLE usage_records ADD COLUMN routing_version TEXT;

CREATE INDEX IF NOT EXISTS idx_usage_records_caller ON usage_records(caller);
CREATE INDEX IF NOT EXISTS idx_usage_records_provider ON usage_records(provider);

ALTER TABLE request_logs ADD COLUMN caller TEXT;
ALTER TABLE request_logs ADD COLUMN requested_thinking TEXT;
ALTER TABLE request_logs ADD COLUMN effective_thinking TEXT;
ALTER TABLE request_logs ADD COLUMN routing_version TEXT;
ALTER TABLE request_logs ADD COLUMN fallback_used INTEGER NOT NULL DEFAULT 0;
ALTER TABLE request_logs ADD COLUMN fallback_reason TEXT;
ALTER TABLE request_logs ADD COLUMN primary_model TEXT;
ALTER TABLE request_logs ADD COLUMN reasoning_tokens INTEGER;
ALTER TABLE request_logs ADD COLUMN points_charged INTEGER;

CREATE INDEX IF NOT EXISTS idx_request_logs_caller ON request_logs(caller);
CREATE INDEX IF NOT EXISTS idx_request_logs_provider ON request_logs(provider);
