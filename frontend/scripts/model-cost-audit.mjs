import { Client } from "pg";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
const client = new Client({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
});
await client.connect();
try {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  // Compare independently aggregated execution entries against daily ledger rows.
  const days = await client.query(`
    WITH e AS (
      SELECT owner_user_id, quota_usage_day usage_day,
        sum(reserved_total_tokens) reserved_tokens, sum(estimated_cost_usd) reserved_cost_usd,
        sum(CASE WHEN calculated_cost_usd IS NOT NULL THEN coalesce(total_tokens,0) ELSE 0 END) settled_tokens,
        sum(coalesce(calculated_cost_usd,0)) settled_cost_usd,
        count(*) FILTER (WHERE status='SUCCEEDED' AND quota_reservation_status <> 'RESERVED') successful_executions,
        count(*) FILTER (WHERE status='FAILED' AND quota_reservation_status <> 'RESERVED') failed_executions
      FROM model_executions WHERE pricing_snapshot_id IS NOT NULL
      GROUP BY owner_user_id, quota_usage_day
    )
    SELECT coalesce(u.owner_user_id,e.owner_user_id) owner_user_id,
      to_char(coalesce(u.usage_day,e.usage_day),'YYYY-MM-DD') usage_day,
      coalesce(u.reserved_tokens,0) reserved_tokens, coalesce(u.settled_tokens,0) settled_tokens,
      coalesce(u.reserved_cost_usd,0) reserved_cost_usd, coalesce(u.settled_cost_usd,0) settled_cost_usd,
      coalesce(u.reserved_tokens,0)=coalesce(e.reserved_tokens,0)
        AND coalesce(u.settled_tokens,0)=coalesce(e.settled_tokens,0)
        AND coalesce(u.reserved_cost_usd,0)=coalesce(e.reserved_cost_usd,0)
        AND coalesce(u.settled_cost_usd,0)=coalesce(e.settled_cost_usd,0)
        AND coalesce(u.successful_executions,0)=coalesce(e.successful_executions,0)
        AND coalesce(u.failed_executions,0)=coalesce(e.failed_executions,0) internal_ledger_matches
    FROM model_quota_usage_daily u FULL JOIN e USING (owner_user_id,usage_day)
    ORDER BY owner_user_id,usage_day
  `);
  const exceptions = await client.query(`
    SELECT id, owner_user_id, purpose, status, quota_reservation_status, reconciliation_status,
      provider_attempt_count, max_attempts, pricing_snapshot_id, provider_request_id,
      CASE WHEN pricing_snapshot_id IS NULL THEN 'LEGACY_UNPRICED'
        WHEN quota_reservation_status='RESERVED' THEN 'IN_FLIGHT_OR_INTERRUPTED'
        WHEN quota_reservation_status='HELD' THEN 'UNKNOWN_ATTEMPT_COST'
        ELSE 'PENDING_PROVIDER_EVIDENCE' END audit_reason,
      reserved_total_tokens, estimated_cost_usd, calculated_cost_usd, provider_billed_cost_usd,
      created_at, (quota_reservation_status='RESERVED' AND created_at < now()-interval '30 minutes') stale_reservation
    FROM model_executions
    WHERE reconciliation_status IN ('REQUIRED','PENDING_PROVIDER','DISCREPANCY')
      OR quota_reservation_status IN ('RESERVED','HELD')
      OR (pricing_snapshot_id IS NULL AND (status='SUCCEEDED' OR provider_attempt_count>0))
    ORDER BY owner_user_id,created_at
  `);
  const prices = await client.query(`SELECT id, requested_model, product_version, pricing_window,
    input_cache_hit_usd_per_million, input_cache_miss_usd_per_million, output_usd_per_million,
    currency, source_url, effective_at, valid_until, valid_until > now() current
    FROM model_pricing_snapshots ORDER BY effective_at,pricing_window`);
  await client.query("COMMIT");
  const matches = days.rows.every((row) => row.internal_ledger_matches);
  console.log(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        scope: "LOCAL_DATABASE_READ_ONLY",
        costBasis: "LOCAL_ESTIMATE_NOT_PROVIDER_INVOICE",
        internalLedger: matches ? "PASS" : "DISCREPANCY",
        providerReconciliation: "PENDING_PROVIDER_EVIDENCE",
        historicalCoverage:
          "Only retained model_executions are covered; earlier deleted smoke calls cannot be reconstructed.",
        dailyLedger: days.rows,
        exceptions: exceptions.rows,
        pricingSnapshots: prices.rows,
      },
      null,
      2,
    ),
  );
  if (!matches) process.exitCode = 1;
} catch (error) {
  await client.query("ROLLBACK");
  // Never echo connection strings, query parameters, output text or API keys.
  console.error("Cost audit failed:", error instanceof Error ? error.message : "Unknown error");
  process.exitCode = 1;
} finally {
  await client.end();
}
