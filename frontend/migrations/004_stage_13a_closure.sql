CREATE TABLE IF NOT EXISTS model_pricing_snapshots (
  id text PRIMARY KEY,
  provider text NOT NULL,
  requested_model text NOT NULL,
  product_version text NOT NULL,
  pricing_window text NOT NULL CHECK (pricing_window IN ('OFF_PEAK', 'PEAK')),
  input_cache_hit_usd_per_million numeric(16, 10) NOT NULL CHECK (input_cache_hit_usd_per_million >= 0),
  input_cache_miss_usd_per_million numeric(16, 10) NOT NULL CHECK (input_cache_miss_usd_per_million >= 0),
  output_usd_per_million numeric(16, 10) NOT NULL CHECK (output_usd_per_million >= 0),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  source_url text NOT NULL,
  effective_at timestamptz NOT NULL,
  valid_until timestamptz NOT NULL CHECK (valid_until > effective_at),
  captured_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, requested_model, product_version, pricing_window, effective_at)
);

CREATE TABLE IF NOT EXISTS model_quota_policies (
  owner_user_id text PRIMARY KEY REFERENCES app_users(id) ON DELETE RESTRICT,
  tier_code text NOT NULL DEFAULT 'LOCAL_DEMO' CHECK (tier_code = 'LOCAL_DEMO'),
  daily_token_limit integer NOT NULL CHECK (daily_token_limit > 0),
  daily_cost_limit_usd numeric(16, 8) NOT NULL CHECK (daily_cost_limit_usd >= 0),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS model_quota_usage_daily (
  owner_user_id text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  usage_day date NOT NULL,
  reserved_tokens integer NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
  settled_tokens integer NOT NULL DEFAULT 0 CHECK (settled_tokens >= 0),
  reserved_cost_usd numeric(16, 8) NOT NULL DEFAULT 0 CHECK (reserved_cost_usd >= 0),
  settled_cost_usd numeric(16, 8) NOT NULL DEFAULT 0 CHECK (settled_cost_usd >= 0),
  successful_executions integer NOT NULL DEFAULT 0 CHECK (successful_executions >= 0),
  failed_executions integer NOT NULL DEFAULT 0 CHECK (failed_executions >= 0),
  PRIMARY KEY (owner_user_id, usage_day)
);

ALTER TABLE model_executions
  ADD COLUMN IF NOT EXISTS pricing_snapshot_id text REFERENCES model_pricing_snapshots(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS quota_usage_day date,
  ADD COLUMN IF NOT EXISTS reserved_total_tokens integer CHECK (reserved_total_tokens IS NULL OR reserved_total_tokens >= 0),
  ADD COLUMN IF NOT EXISTS estimated_cost_usd numeric(16, 8) CHECK (estimated_cost_usd IS NULL OR estimated_cost_usd >= 0),
  ADD COLUMN IF NOT EXISTS calculated_cost_usd numeric(16, 8) CHECK (calculated_cost_usd IS NULL OR calculated_cost_usd >= 0),
  ADD COLUMN IF NOT EXISTS per_attempt_tokens integer CHECK (per_attempt_tokens > 0),
  ADD COLUMN IF NOT EXISTS per_attempt_cost_usd numeric(16, 8) CHECK (per_attempt_cost_usd >= 0),
  ADD COLUMN IF NOT EXISTS provider_attempt_count integer NOT NULL DEFAULT 0 CHECK (provider_attempt_count >= 0),
  ADD COLUMN IF NOT EXISTS max_attempts integer CHECK (max_attempts > 0),
  ADD COLUMN IF NOT EXISTS reconciliation_status text NOT NULL DEFAULT 'NOT_REQUIRED'
    CHECK (reconciliation_status IN ('NOT_REQUIRED', 'PENDING_PROVIDER', 'REQUIRED', 'MATCHED', 'DISCREPANCY')),
  ADD COLUMN IF NOT EXISTS provider_billed_cost_usd numeric(16, 8) CHECK (provider_billed_cost_usd >= 0),
  ADD COLUMN IF NOT EXISTS billing_reference text,
  ADD COLUMN IF NOT EXISTS quota_reservation_status text NOT NULL DEFAULT 'NOT_RESERVED'
    CHECK (quota_reservation_status IN ('NOT_RESERVED', 'RESERVED', 'SETTLED', 'RELEASED', 'HELD')),
  ADD CONSTRAINT model_execution_quota_binding CHECK (
    quota_reservation_status = 'NOT_RESERVED' OR
    (pricing_snapshot_id IS NOT NULL AND quota_usage_day IS NOT NULL AND
     reserved_total_tokens IS NOT NULL AND estimated_cost_usd IS NOT NULL AND
     per_attempt_tokens IS NOT NULL AND per_attempt_cost_usd IS NOT NULL AND
     max_attempts IS NOT NULL AND provider_attempt_count <= max_attempts)
  );

CREATE INDEX IF NOT EXISTS model_executions_quota_day_idx
  ON model_executions(owner_user_id, quota_usage_day, created_at DESC);
CREATE INDEX IF NOT EXISTS model_quota_usage_daily_day_idx
  ON model_quota_usage_daily(usage_day, owner_user_id);

INSERT INTO model_pricing_snapshots (
  id, provider, requested_model, product_version, pricing_window,
  input_cache_hit_usd_per_million, input_cache_miss_usd_per_million,
  output_usd_per_million, source_url, effective_at, valid_until
)
VALUES
  (
    'mps_deepseek_flash_1017_off_peak_20261105',
    'deepseek', 'deepseek-flash', 'DeepSeek-V4.1-Flash-1017', 'OFF_PEAK',
    0.003, 0.15, 0.60,
    'https://api-docs.deepseek.com/quick_start/pricing',
    '2026-11-05T00:00:00Z', '2026-12-05T00:00:00Z'
  ),
  (
    'mps_deepseek_flash_1017_peak_20261105',
    'deepseek', 'deepseek-flash', 'DeepSeek-V4.1-Flash-1017', 'PEAK',
    0.006, 0.30, 1.20,
    'https://api-docs.deepseek.com/quick_start/pricing',
    '2026-11-05T00:00:00Z', '2026-12-05T00:00:00Z'
  )
ON CONFLICT (id) DO NOTHING;

CREATE FUNCTION prevent_model_pricing_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Pricing snapshots are immutable; append a new snapshot' USING ERRCODE = 'check_violation';
END;
$$;
CREATE TRIGGER model_pricing_snapshots_immutable
  BEFORE UPDATE OR DELETE ON model_pricing_snapshots
  FOR EACH ROW EXECUTE FUNCTION prevent_model_pricing_update();
