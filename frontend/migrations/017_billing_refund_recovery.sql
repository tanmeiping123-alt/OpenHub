ALTER TABLE billing_orders ADD CONSTRAINT billing_paid_timestamp CHECK ((status='PAID')=(paid_at IS NOT NULL));
ALTER TABLE billing_orders ADD UNIQUE(id,owner_user_id,plan_code);
ALTER TABLE billing_consumed_offers ADD FOREIGN KEY(order_id,owner_user_id,plan_code) REFERENCES billing_orders(id,owner_user_id,plan_code);
ALTER TABLE billing_consumed_offers ADD UNIQUE(order_id,owner_user_id);
ALTER TABLE billing_entitlements ADD FOREIGN KEY(order_id,owner_user_id) REFERENCES billing_consumed_offers(order_id,owner_user_id);

-- A failed manual return can be retried with a new freeze interval. Each transition
-- is recorded in immutable billing_events; success remains terminal.
DROP TRIGGER billing_refund_validate ON billing_refunds;
CREATE FUNCTION validate_billing_refund_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'BILLING_HISTORY_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'REQUESTED' THEN RAISE EXCEPTION 'REFUND_TRANSITION_REJECTED' USING ERRCODE='23514'; END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['status','completed_at','refund_transaction','evidence_note','reviewer_id','frozen_at']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['status','completed_at','refund_transaction','evidence_note','reviewer_id','frozen_at'])
    OR NOT ((OLD.status='REQUESTED' AND NEW.status IN ('PROCESSING','FAILED')) OR (OLD.status='PROCESSING' AND NEW.status IN ('SUCCESS','FAILED')) OR (OLD.status='FAILED' AND NEW.status='PROCESSING'))
    OR (NEW.frozen_at IS DISTINCT FROM OLD.frozen_at AND NOT (OLD.status='FAILED' AND NEW.status='PROCESSING'))
  THEN RAISE EXCEPTION 'REFUND_TRANSITION_REJECTED' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.status IN ('PROCESSING','FAILED','SUCCESS') AND NOT EXISTS(SELECT 1 FROM administrator_users WHERE user_id=NEW.reviewer_id AND NOT disabled)
   OR NEW.status='SUCCESS' AND (NEW.refund_transaction IS NULL OR NEW.completed_at IS NULL OR length(trim(NEW.evidence_note))<5)
 THEN RAISE EXCEPTION 'REFUND_EVIDENCE_REQUIRED' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER billing_refund_validate BEFORE INSERT OR UPDATE OR DELETE ON billing_refunds FOR EACH ROW EXECUTE FUNCTION validate_billing_refund_recovery();
