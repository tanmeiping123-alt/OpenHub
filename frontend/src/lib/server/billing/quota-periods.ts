import "server-only";
import type { PoolClient } from "pg";
import { freePeriod } from "@/lib/billing-policy";
import { entitlement } from "./entitlements";

export async function periodUsage(
  c: PoolClient,
  owner: string,
  e: Awaited<ReturnType<typeof entitlement>>,
) {
  const row = (
    await c.query(
      `SELECT
 COALESCE(sum(CASE WHEN quota_reservation_status IN ('SETTLED','HELD') OR quota_reservation_status='NOT_RESERVED' THEN COALESCE(total_tokens,0) ELSE 0 END),0)::bigint AS settled,
 COALESCE(sum(CASE WHEN quota_reservation_status IN ('RESERVED','HELD') THEN COALESCE(reserved_total_tokens,0) ELSE 0 END),0)::bigint AS reserved,
 COALESCE(sum(calculated_cost_usd),0) AS cost,
 COALESCE(sum(CASE WHEN quota_reservation_status IN ('RESERVED','HELD') THEN COALESCE(estimated_cost_usd,0) ELSE 0 END),0) AS held
 FROM model_executions WHERE owner_user_id=$1 AND
 (($2::text IS NOT NULL AND quota_order_id=$2) OR ($2::text IS NULL AND COALESCE(quota_reserved_at,created_at)>=$3 AND COALESCE(quota_reserved_at,created_at)<$4))`,
      [owner, e.orderId, e.start, e.end],
    )
  ).rows[0];
  return {
    settledTokens: Number(row.settled),
    reservedTokens: Number(row.reserved),
    settledUsd: Number(row.cost),
    reservedUsd: Number(row.held),
  };
}
export async function platformBudget(c: PoolClient) {
  const policy = (await c.query("SELECT *,now() AS time FROM billing_runtime_policy WHERE id=true"))
    .rows[0];
  if (!policy) throw Error("PLATFORM_BUDGET_NOT_CONFIGURED");
  const period = freePeriod(new Date(policy.platform_period_anchor), new Date(policy.time));
  const daily = (
    await c.query(
      "SELECT COALESCE(sum(settled_cost_usd+reserved_cost_usd),0) AS cost FROM model_quota_usage_daily WHERE usage_day=(now() AT TIME ZONE 'UTC')::date",
    )
  ).rows[0];
  const cycle = (
    await c.query(
      `SELECT COALESCE(sum(COALESCE(calculated_cost_usd,0)+CASE WHEN quota_reservation_status IN ('RESERVED','HELD') THEN COALESCE(estimated_cost_usd,0) ELSE 0 END),0) AS cost FROM model_executions WHERE COALESCE(quota_reserved_at,created_at)>=$1 AND COALESCE(quota_reserved_at,created_at)<$2`,
      [period.start, period.end],
    )
  ).rows[0];
  return {
    dailyLimitUsd: Number(policy.daily_usd),
    periodLimitUsd: Number(policy.period_usd),
    dailyUsedUsd: Number(daily.cost),
    periodUsedUsd: Number(cycle.cost),
    periodEnd: period.end.toISOString(),
  };
}
