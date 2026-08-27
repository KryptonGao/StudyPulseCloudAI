-- Migration number: 0022  2026-08-27T00:00:00.000Z
--
-- Raise monthly token quotas to match current membership pricing.

UPDATE membership_plans
   SET daily_request_limit = 5,
       monthly_token_limit = 50000
 WHERE id = 'free';

UPDATE membership_plans
   SET daily_request_limit = 50,
       monthly_token_limit = 2000000
 WHERE id = 'plus';

UPDATE membership_plans
   SET daily_request_limit = 200,
       monthly_token_limit = 4000000
 WHERE id = 'pro';
