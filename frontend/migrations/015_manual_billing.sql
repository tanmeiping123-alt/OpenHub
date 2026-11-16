-- Additive local trial billing. No transaction, order or entitlement is seeded.
CREATE TABLE billing_plan_versions (
 code text PRIMARY KEY, snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
 created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO billing_plan_versions(code,snapshot) VALUES
('FREE_V1','{"tier":"Free","amountFen":0,"currency":"CNY","durationDays":30,"dailyTokens":50000,"periodTokens":300000,"dailyUsd":0.05,"periodUsd":0.30,"prompts":100,"privateSkills":10}'),
('PRO_TEST_30D_V1','{"tier":"Pro","amountFen":1,"currency":"CNY","durationDays":30,"dailyTokens":200000,"periodTokens":2000000,"dailyUsd":0.25,"periodUsd":2.00,"prompts":1000,"privateSkills":100,"eligibility":"ALLOWLIST_ONCE","environment":"LOCAL_MANUAL"}');
CREATE TRIGGER billing_plans_immutable BEFORE UPDATE OR DELETE ON billing_plan_versions FOR EACH ROW EXECUTE FUNCTION reject_skill_snapshot_mutation();
CREATE TABLE billing_test_allowlist (
 owner_user_id text PRIMARY KEY REFERENCES app_users(id),
 added_by text REFERENCES administrator_users(user_id),
 reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION billing_allowlist_limit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('billing-allowlist'));
 IF (SELECT count(*) FROM billing_test_allowlist)>=5 THEN RAISE EXCEPTION 'ALLOWLIST_FULL'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER billing_allowlist_limit BEFORE INSERT ON billing_test_allowlist FOR EACH ROW EXECUTE FUNCTION billing_allowlist_limit();
INSERT INTO billing_test_allowlist(owner_user_id,reason)
 SELECT user_id,'Explicit user authorization 2026-11-05; initial allowlist only' FROM regular_users WHERE email='1540744366@qq.com';
CREATE TABLE billing_orders (
 id text PRIMARY KEY, owner_user_id text NOT NULL REFERENCES app_users(id),
 plan_code text NOT NULL REFERENCES billing_plan_versions(code), snapshot jsonb NOT NULL,
 amount_fen integer NOT NULL CHECK(amount_fen=1), currency text NOT NULL CHECK(currency='CNY'),
 environment text NOT NULL CHECK(environment='LOCAL_MANUAL'), channel text NOT NULL CHECK(channel='ALIPAY_MANUAL'),
 receiver_account text NOT NULL, receiver_hint text NOT NULL, refund_contact text NOT NULL, qr_path text NOT NULL,
 request_key text NOT NULL CHECK(length(request_key) BETWEEN 8 AND 120),
 status text NOT NULL CHECK(status IN ('PENDING','REVIEW','EXPIRED','PAID')),
 claim_transaction text, claim_paid_at timestamptz,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), paid_at timestamptz,
 UNIQUE(owner_user_id,request_key), CHECK(expires_at>created_at)
);
CREATE UNIQUE INDEX billing_one_pending ON billing_orders(owner_user_id,plan_code) WHERE status IN ('PENDING','REVIEW');
CREATE TABLE billing_receipts (
 order_id text PRIMARY KEY REFERENCES billing_orders(id),
 channel text NOT NULL, receiver_account text NOT NULL, transaction_id text NOT NULL,
 amount_fen integer NOT NULL CHECK(amount_fen=1), currency text NOT NULL CHECK(currency='CNY'),
 received_at timestamptz NOT NULL, reviewer_id text NOT NULL REFERENCES administrator_users(user_id),
 evidence_note text NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(channel,receiver_account,transaction_id)
);
CREATE TABLE billing_entitlements (
 order_id text PRIMARY KEY REFERENCES billing_orders(id), owner_user_id text NOT NULL REFERENCES app_users(id),
 starts_at timestamptz NOT NULL DEFAULT now(), ends_at timestamptz NOT NULL,
 revoked_at timestamptz, CHECK(ends_at>starts_at)
);
CREATE TABLE billing_refunds (
 order_id text PRIMARY KEY REFERENCES billing_receipts(order_id), request_id text NOT NULL UNIQUE,
 status text NOT NULL CHECK(status IN ('REQUESTED','PROCESSING','FAILED','SUCCESS')),
 amount_fen integer NOT NULL CHECK(amount_fen=1), reason text NOT NULL,
 requested_at timestamptz NOT NULL DEFAULT now(), frozen_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz, refund_transaction text UNIQUE, evidence_note text,
 reviewer_id text REFERENCES administrator_users(user_id)
);
CREATE TABLE billing_events (
 id text PRIMARY KEY, order_id text REFERENCES billing_orders(id), actor_id text NOT NULL REFERENCES app_users(id),
 event_type text NOT NULL, details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER billing_events_immutable BEFORE UPDATE OR DELETE ON billing_events FOR EACH ROW EXECUTE FUNCTION reject_skill_snapshot_mutation();
CREATE TRIGGER billing_receipts_immutable BEFORE UPDATE OR DELETE ON billing_receipts FOR EACH ROW EXECUTE FUNCTION reject_skill_snapshot_mutation();
CREATE TABLE billing_request_limits (
 owner_user_id text PRIMARY KEY REFERENCES app_users(id), window_start timestamptz NOT NULL DEFAULT now(), attempts integer NOT NULL
);
-- Preserve explicit operator overrides. Only raise the former stock development defaults;
-- current plan limits are applied separately, not encoded as a mutable tier on the owner.
UPDATE model_quota_policies SET daily_token_limit=200000,daily_cost_limit_usd=0.25,updated_at=now()
 WHERE daily_token_limit=100000 AND daily_cost_limit_usd=0.12;
ALTER TABLE model_executions ADD COLUMN quota_reserved_at timestamptz,
 ADD COLUMN quota_order_id text REFERENCES billing_orders(id),
 ADD COLUMN quota_period_start timestamptz, ADD COLUMN quota_period_end timestamptz,
 ADD COLUMN quota_plan_snapshot jsonb;
UPDATE model_executions SET quota_reserved_at=created_at WHERE pricing_snapshot_id IS NOT NULL;
CREATE INDEX model_quota_period_owner ON model_executions(owner_user_id,quota_reserved_at);
