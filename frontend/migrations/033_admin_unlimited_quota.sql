-- Per-account operator exemption. Platform daily/period cost guards still apply.
ALTER TABLE model_quota_policies ADD COLUMN unlimited boolean NOT NULL DEFAULT false;
-- Existing administrators receive the exemption; newly created accounts keep the default.
INSERT INTO model_quota_policies(owner_user_id, daily_token_limit, daily_cost_limit_usd, unlimited)
SELECT user_id, 200000, 0.25, true FROM administrator_users
ON CONFLICT (owner_user_id) DO UPDATE SET unlimited=true, updated_at=now();
