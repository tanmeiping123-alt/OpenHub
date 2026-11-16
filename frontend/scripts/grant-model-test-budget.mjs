// Local operator action only. Does not call a provider or modify usage/payment records.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const args = process.argv.slice(2);
assert.equal(args.length, 4, "Specify email, daily USD, expiry and explicit approval note.");
const values = Object.fromEntries(
  args.map((a) => {
    const match = /^--(email|daily-usd|expires-at|approval-note)=(.+)$/.exec(a);
    assert.ok(match, "Unknown or missing argument.");
    return [match[1], match[2]];
  }),
);
assert.equal(Object.keys(values).length, 4, "Duplicate arguments are not allowed.");
const amount = Number(values["daily-usd"]);
assert.ok(Number.isFinite(amount) && amount > 0 && amount <= 1, "Approval is bounded to USD 1.00.");
assert.match(values.email, /^[^\s@]+@[^\s@]+\.[^\s@]+$/);
assert.match(values["expires-at"], /^\d{4}-\d{2}-\d{2}T00:00:00Z$/);
assert.ok(values["approval-note"].trim().length >= 10 && values["approval-note"].length <= 1000);
const target = new URL(process.env.DATABASE_URL ?? "invalid:");
assert.ok(["localhost", "127.0.0.1"].includes(target.hostname));
assert.equal(target.port, "55432");
assert.equal(target.pathname, "/promptmaster_dev");
const client = new pg.Client({
  connectionString: target.toString(),
  connectionTimeoutMillis: 4000,
});
await client.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('billing-model-budget'))");
  const account = (
    await client.query(
      `SELECT u.user_id AS id FROM regular_users u JOIN app_users a ON a.id=u.user_id
     WHERE u.email=$1 AND NOT u.disabled AND a.account_kind='USER'`,
      [values.email],
    )
  ).rows;
  assert.equal(account.length, 1, "An exact enabled regular account is required.");
  const owner = account[0].id;
  const active = (
    await client.query(
      `SELECT e.order_id FROM billing_entitlements e JOIN billing_orders o ON o.id=e.order_id
     WHERE e.owner_user_id=$1 AND e.revoked_at IS NULL AND e.starts_at<=clock_timestamp()
       AND e.ends_at>clock_timestamp() AND o.plan_code='PRO_TEST_30D_V1'
       AND NOT EXISTS(SELECT 1 FROM billing_refunds r WHERE r.order_id=e.order_id
         AND r.status IN ('REQUESTED','PROCESSING','SUCCESS'))`,
      [owner],
    )
  ).rows;
  assert.equal(active.length, 1, "A single active, non-refunding Pro subscription is required.");
  const clock = (
    await client.query(
      `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS day,
       (((clock_timestamp() AT TIME ZONE 'UTC')::date+1)::timestamp AT TIME ZONE 'UTC') AS expires`,
    )
  ).rows[0];
  assert.equal(
    new Date(values["expires-at"]).getTime(),
    new Date(clock.expires).getTime(),
    "The expiry must be the end of the current UTC day; no future-day grant is authorized.",
  );
  const existing = (
    await client.query(
      "SELECT * FROM model_daily_cost_allowances WHERE owner_user_id=$1 AND usage_day=$2",
      [owner, clock.day],
    )
  ).rows[0];
  if (existing) {
    assert.equal(
      Number(existing.daily_cost_limit_usd),
      amount,
      "A different immutable approval exists.",
    );
    assert.equal(
      existing.order_id,
      active[0].order_id,
      "Approval belongs to another subscription.",
    );
    assert.equal(new Date(existing.expires_at).getTime(), new Date(clock.expires).getTime());
    assert.equal(existing.approval_note, values["approval-note"], "Approval evidence differs.");
  } else {
    const enabled = (
      await client.query(
        "SELECT enabled,daily_cost_limit_usd FROM model_quota_policies WHERE owner_user_id=$1 FOR UPDATE",
        [owner],
      )
    ).rows[0];
    assert.ok(
      enabled?.enabled && Number(enabled.daily_cost_limit_usd) > 0,
      "Do not bypass a disabled or zero-budget policy.",
    );
    await client.query(
      `INSERT INTO model_daily_cost_allowances
       (id,owner_user_id,order_id,usage_day,daily_cost_limit_usd,starts_at,expires_at,approval_note)
       VALUES($1,$2,$3,$4,$5,clock_timestamp(),$6,$7)`,
      [
        `mqa_${randomUUID()}`,
        owner,
        active[0].order_id,
        clock.day,
        amount,
        values["expires-at"],
        values["approval-note"],
      ],
    );
  }
  await client.query("COMMIT");
  console.log(
    JSON.stringify({
      email: values.email,
      dailyCostLimitUsd: amount,
      expiresAt: values["expires-at"],
      alreadyGranted: !!existing,
      usageUnchanged: true,
      providerCalls: 0,
    }),
  );
} catch (error) {
  await client.query("ROLLBACK");
  console.error(error.code === "23505" ? "APPROVAL_CONFLICT" : "MODEL_TEST_BUDGET_GRANT_FAILED");
  process.exitCode = 1;
} finally {
  await client.end();
}
