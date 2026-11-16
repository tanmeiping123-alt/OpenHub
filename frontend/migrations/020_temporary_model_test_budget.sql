-- Explicit operator-approved, single-owner, single-UTC-day testing allowances.
-- No grants are seeded and no historical policies, usage or plan snapshots change.
CREATE TABLE model_daily_cost_allowances (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  order_id text NOT NULL,
  usage_day date NOT NULL,
  daily_cost_limit_usd numeric(16,8) NOT NULL
    CHECK (daily_cost_limit_usd > 0 AND daily_cost_limit_usd <= 1),
  starts_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  approval_note text NOT NULL CHECK (length(trim(approval_note)) BETWEEN 10 AND 1000),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (order_id, owner_user_id)
    REFERENCES billing_consumed_offers(order_id, owner_user_id) ON DELETE RESTRICT,
  UNIQUE (owner_user_id, usage_day),
  CHECK (starts_at >= (usage_day::timestamp AT TIME ZONE 'UTC')),
  CHECK (starts_at < expires_at),
  CHECK (expires_at = ((usage_day + 1)::timestamp AT TIME ZONE 'UTC'))
);

CREATE FUNCTION prevent_model_daily_allowance_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Model testing allowances are immutable approval records' USING ERRCODE='23514';
END; $$;
CREATE TRIGGER model_daily_cost_allowances_immutable
  BEFORE UPDATE OR DELETE ON model_daily_cost_allowances
  FOR EACH ROW EXECUTE FUNCTION prevent_model_daily_allowance_mutation();
