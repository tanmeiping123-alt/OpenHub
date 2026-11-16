-- Administrators do not purchase subscriptions. Existing orders remain auditable
-- and retain all original receipt, entitlement and refund transitions.
CREATE FUNCTION reject_admin_subscription_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM administrator_users WHERE user_id=NEW.owner_user_id) THEN
   RAISE EXCEPTION 'ADMIN_SUBSCRIPTION_NOT_REQUIRED' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER billing_order_admin_review_only BEFORE INSERT ON billing_orders
FOR EACH ROW EXECUTE FUNCTION reject_admin_subscription_order();
