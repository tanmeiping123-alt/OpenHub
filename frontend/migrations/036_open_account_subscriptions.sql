-- Open subscriptions for every active account; retain immutable order, receipt,
-- entitlement and refund validation. Legacy allowlist history is retained unused.
CREATE OR REPLACE FUNCTION validate_billing_record() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o billing_orders;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'BILLING_HISTORY_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='billing_orders' THEN
  IF TG_OP='INSERT' THEN
   IF NEW.plan_code<>'PRO_TEST_30D_V1' OR NEW.snapshot IS DISTINCT FROM (SELECT snapshot FROM billing_plan_versions WHERE code=NEW.plan_code)
     OR NOT (EXISTS(SELECT 1 FROM regular_users WHERE user_id=NEW.owner_user_id AND NOT disabled)
       OR EXISTS(SELECT 1 FROM administrator_users WHERE user_id=NEW.owner_user_id AND NOT disabled))
     OR NEW.status<>'PENDING' OR NEW.paid_at IS NOT NULL
   THEN RAISE EXCEPTION 'INVALID_ORDER_SNAPSHOT' USING ERRCODE='23514'; END IF;
  ELSIF (to_jsonb(NEW)-ARRAY['status','claim_transaction','claim_paid_at','paid_at','issue_code']) IS DISTINCT FROM
        (to_jsonb(OLD)-ARRAY['status','claim_transaction','claim_paid_at','paid_at','issue_code'])
    OR (OLD.status='PAID' AND NEW.status<>'PAID')
    OR (NEW.status='PAID' AND NOT EXISTS(SELECT 1 FROM billing_receipts WHERE order_id=NEW.id))
  THEN RAISE EXCEPTION 'INVALID_ORDER_TRANSITION' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='billing_receipts' THEN
  SELECT * INTO o FROM billing_orders WHERE id=NEW.order_id;
  IF NEW.channel<>o.channel OR NEW.receiver_account<>o.receiver_account OR NEW.amount_fen<>o.amount_fen OR NEW.currency<>o.currency
    OR NOT EXISTS(SELECT 1 FROM administrator_users WHERE user_id=NEW.reviewer_id AND NOT disabled)
    OR length(trim(NEW.transaction_id)) NOT BETWEEN 4 AND 120 OR length(trim(NEW.evidence_note)) NOT BETWEEN 5 AND 1000
  THEN RAISE EXCEPTION 'RECEIPT_MISMATCH' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='billing_entitlements' THEN
  SELECT * INTO o FROM billing_orders WHERE id=NEW.order_id;
  IF NEW.owner_user_id<>o.owner_user_id OR o.status<>'PAID'
    OR NOT EXISTS(SELECT 1 FROM billing_consumed_offers WHERE order_id=NEW.order_id AND owner_user_id=NEW.owner_user_id)
    OR (TG_OP='INSERT' AND EXISTS(SELECT 1 FROM billing_refunds WHERE order_id=NEW.order_id AND status IN ('REQUESTED','PROCESSING','SUCCESS')))
    OR (TG_OP='UPDATE' AND (NEW.order_id<>OLD.order_id OR NEW.owner_user_id<>OLD.owner_user_id OR NEW.starts_at<>OLD.starts_at
         OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)))
  THEN RAISE EXCEPTION 'ENTITLEMENT_REJECTED' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' AND (NEW.ends_at<>NEW.starts_at+interval '720 hours' OR EXISTS(SELECT 1 FROM billing_entitlements WHERE owner_user_id=NEW.owner_user_id AND revoked_at IS NULL AND ends_at>NEW.starts_at AND starts_at<NEW.ends_at))
  THEN RAISE EXCEPTION 'ENTITLEMENT_OVERLAP' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='billing_refunds' THEN
  IF TG_OP='INSERT' AND NEW.status<>'REQUESTED'
    OR TG_OP='UPDATE' AND ((to_jsonb(NEW)-ARRAY['status','completed_at','refund_transaction','evidence_note','reviewer_id']) IS DISTINCT FROM
       (to_jsonb(OLD)-ARRAY['status','completed_at','refund_transaction','evidence_note','reviewer_id'])
       OR NOT ((OLD.status='REQUESTED' AND NEW.status IN ('PROCESSING','FAILED')) OR (OLD.status='PROCESSING' AND NEW.status IN ('SUCCESS','FAILED'))))
    OR NEW.status IN ('PROCESSING','FAILED','SUCCESS') AND NOT EXISTS(SELECT 1 FROM administrator_users WHERE user_id=NEW.reviewer_id AND NOT disabled)
    OR NEW.status='SUCCESS' AND (NEW.refund_transaction IS NULL OR NEW.completed_at IS NULL OR length(trim(NEW.evidence_note))<5)
  THEN RAISE EXCEPTION 'REFUND_TRANSITION_REJECTED' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END; $$;
