-- Migration number: 0024  2026-08-28T13:00:00.000Z
--
-- Live per-model millipoint rates (1000 millipoints = 1 user point, ceiled).
-- Seed matches PRICING["2026-08-v1"]. INSERT OR IGNORE so later admin edits
-- are not overwritten if this migration is reapplied.

CREATE TABLE IF NOT EXISTS pricing_rates (
	model TEXT PRIMARY KEY NOT NULL,
	input_millipoints INTEGER NOT NULL,
	output_millipoints INTEGER NOT NULL,
	reasoning_millipoints INTEGER NOT NULL,
	cache_millipoints INTEGER NOT NULL,
	multiplier INTEGER NOT NULL DEFAULT 1,
	updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO pricing_rates (
	model, input_millipoints, output_millipoints, reasoning_millipoints, cache_millipoints, multiplier
) VALUES
	('mimo-v2.5', 10, 30, 30, 5, 1),
	('hy3', 40, 120, 120, 10, 1),
	('minimax-m3', 80, 240, 240, 20, 1);
