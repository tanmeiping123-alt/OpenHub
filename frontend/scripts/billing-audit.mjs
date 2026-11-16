// Read-only local audit: no model/provider requests or payment mutations.
import { Client } from "pg";
const url = new URL(process.env.DATABASE_URL ?? "invalid:");
if (
  !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
  url.pathname !== "/promptmaster_dev"
)
  throw Error("LOCAL_DATABASE_REQUIRED");
const c = new Client({ connectionString: url.toString() });
await c.connect();
try {
  await c.query("BEGIN READ ONLY");
  const counts = {};
  for (const table of [
    "billing_orders",
    "billing_receipts",
    "billing_entitlements",
    "billing_refunds",
    "billing_consumed_offers",
    "billing_events",
  ])
    counts[table] = Number((await c.query(`SELECT count(*) n FROM ${table}`)).rows[0].n);
  const allowlist = (
    await c.query(
      "SELECT a.email FROM billing_test_allowlist b JOIN regular_users a ON a.user_id=b.owner_user_id ORDER BY a.email",
    )
  ).rows.map((r) => r.email);
  const anomalies = (
    await c.query(`SELECT
 (SELECT count(*) FROM billing_orders o LEFT JOIN billing_receipts p ON p.order_id=o.id WHERE (o.status='PAID') IS DISTINCT FROM (p.order_id IS NOT NULL)) AS paid_receipt_mismatch,
 (SELECT count(*) FROM billing_entitlements e JOIN billing_orders o ON o.id=e.order_id WHERE e.owner_user_id<>o.owner_user_id OR o.status<>'PAID') AS invalid_grants,
 (SELECT count(*) FROM billing_refunds r JOIN billing_entitlements e ON e.order_id=r.order_id WHERE r.status='SUCCESS' AND e.revoked_at IS NULL) AS unrevoked_refunds,
 (SELECT count(*) FROM billing_entitlements a JOIN billing_entitlements b ON a.owner_user_id=b.owner_user_id AND a.order_id<b.order_id AND a.revoked_at IS NULL AND b.revoked_at IS NULL AND a.starts_at<b.ends_at AND b.starts_at<a.ends_at) AS overlapping_grants`)
  ).rows[0];
  const funds = (
    await c.query(
      "SELECT (SELECT COALESCE(sum(amount_fen),0) FROM billing_receipts) AS received_fen,(SELECT COALESCE(sum(amount_fen),0) FROM billing_refunds WHERE status='SUCCESS') AS refunded_fen",
    )
  ).rows[0];
  console.log(
    JSON.stringify(
      {
        readOnly: true,
        paymentEnabled: process.env.PROMPTMASTER_PAYMENT_ENABLED === "true",
        automaticPaymentsEnabled: false,
        allowlist,
        counts,
        funds,
        anomalies,
      },
      null,
      2,
    ),
  );
  if (Object.values(anomalies).some((n) => Number(n) !== 0)) process.exitCode = 1;
  await c.query("ROLLBACK");
} finally {
  await c.end();
}
