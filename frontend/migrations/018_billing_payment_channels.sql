-- Extend only channel validation; existing order/receipt snapshots remain immutable.
ALTER TABLE billing_orders DROP CONSTRAINT billing_orders_channel_check;
ALTER TABLE billing_orders ADD CONSTRAINT billing_orders_channel_check
 CHECK(channel IN ('ALIPAY_MANUAL','WECHAT_MANUAL'));
ALTER TABLE billing_receipts ADD CONSTRAINT billing_receipts_channel_check
 CHECK(channel IN ('ALIPAY_MANUAL','WECHAT_MANUAL'));
