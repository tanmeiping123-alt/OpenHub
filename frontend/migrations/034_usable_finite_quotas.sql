-- Upgrade only the exact enabled legacy default pair. Explicit stops, custom
-- limits, admin flags, usage, frozen requests and order snapshots are retained.
UPDATE model_quota_policies
SET daily_token_limit=4500000, daily_cost_limit_usd=6, updated_at=now()
WHERE enabled=true AND unlimited=false
  AND daily_token_limit=200000 AND daily_cost_limit_usd=0.25;
