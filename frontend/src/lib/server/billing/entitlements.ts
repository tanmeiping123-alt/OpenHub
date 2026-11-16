import "server-only";
import type { PoolClient } from "pg";
import { FREE_PLAN, PRO_PLAN, freePeriod } from "@/lib/billing-policy";
import { AccountError } from "../account-errors";

// Shared lock order: execution (if any), global quota, owner capacity. Payment writes
// also take global quota before owner; reads never hold these locks across requests.
export async function lockQuota(c: PoolClient) {
  await c.query("SELECT pg_advisory_xact_lock(hashtext('billing-model-budget'))");
}
export async function lockCapacity(c: PoolClient, owner: string) {
  await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`billing-capacity:${owner}`]);
}
export async function entitlement(c: PoolClient, owner: string) {
  const user = (
    await c.query("SELECT created_at,now() AS time FROM app_users WHERE id=$1", [owner])
  ).rows[0];
  if (!user) throw new AccountError("AUTH_REQUIRED", 401);
  const grant = (
    await c.query(
      `SELECT e.*,o.snapshot,EXISTS(SELECT 1 FROM billing_refunds r WHERE r.order_id=e.order_id AND r.status IN ('REQUESTED','PROCESSING')) AS frozen FROM billing_entitlements e JOIN billing_orders o ON o.id=e.order_id WHERE e.owner_user_id=$1 AND e.revoked_at IS NULL AND e.starts_at<=now() AND e.ends_at>now() ORDER BY e.starts_at DESC LIMIT 1`,
      [owner],
    )
  ).rows[0];
  const period = freePeriod(new Date(user.created_at), new Date(user.time));
  return grant
    ? {
        plan: PRO_PLAN,
        code: "PRO_TEST_30D_V1",
        orderId: grant.order_id as string,
        start: new Date(grant.starts_at),
        end: new Date(grant.ends_at),
        frozen: Boolean(grant.frozen),
      }
    : {
        plan: FREE_PLAN,
        code: "FREE_V1",
        orderId: null,
        start: period.start,
        end: period.end,
        frozen: false,
      };
}
export async function capacity(c: PoolClient, owner: string) {
  const e = await entitlement(c, owner);
  const r = (
    await c.query(
      `SELECT
 (SELECT count(*)::int FROM prompts WHERE owner_user_id=$1 AND kind='PERSONAL_PROMPT') AS prompts,
 (SELECT count(*)::int FROM model_executions WHERE owner_user_id=$1 AND purpose='PROMPT_GENERATION' AND status='PENDING' AND quota_reservation_status='RESERVED') AS pending,
 (SELECT count(*)::int FROM skills s WHERE owner_user_id=$1 AND retired_at IS NULL AND (
  EXISTS(SELECT 1 FROM skill_versions v JOIN skill_personal_access a ON a.version_id=v.id WHERE v.skill_id=s.id AND NOT EXISTS(SELECT 1 FROM skill_library_entries l WHERE l.version_id=v.id AND NOT EXISTS(SELECT 1 FROM skill_library_withdrawals w WHERE w.version_id=l.version_id)))
  OR NOT EXISTS (SELECT 1 FROM skill_versions v JOIN skill_library_entries l ON l.version_id=v.id WHERE v.skill_id=s.id AND NOT EXISTS(SELECT 1 FROM skill_library_withdrawals w WHERE w.version_id=l.version_id)))) AS skills`,
      [owner],
    )
  ).rows[0];
  return {
    promptCount: r.prompts as number,
    pendingPrompts: r.pending as number,
    privateSkillCount: r.skills as number,
    promptLimit: e.plan.prompts,
    privateSkillLimit: e.plan.privateSkills,
  };
}
export async function assertPromptCapacity(c: PoolClient, owner: string) {
  await lockCapacity(c, owner);
  const q = await capacity(c, owner);
  if (q.promptCount + q.pendingPrompts >= q.promptLimit)
    throw new AccountError("PROMPT_CAPACITY_EXCEEDED", 429);
}
export async function assertSkillCapacity(
  c: PoolClient,
  owner: string,
  source: string,
  manifest?: string,
) {
  await lockCapacity(c, owner);
  const user = (await c.query("SELECT account_kind FROM app_users WHERE id=$1", [owner])).rows[0];
  if (user?.account_kind !== "USER") return; // Administrator imports are shared, not private capacity.
  const existing = (
    await c.query(
      `SELECT s.id,
    EXISTS(SELECT 1 FROM skill_versions v JOIN skill_personal_access a ON a.version_id=v.id WHERE v.skill_id=s.id AND NOT EXISTS(SELECT 1 FROM skill_library_entries l WHERE l.version_id=v.id AND NOT EXISTS(SELECT 1 FROM skill_library_withdrawals w WHERE w.version_id=l.version_id))) AS private,
    EXISTS(SELECT 1 FROM skill_versions v JOIN skill_library_entries l ON l.version_id=v.id WHERE v.skill_id=s.id AND NOT EXISTS(SELECT 1 FROM skill_library_withdrawals w WHERE w.version_id=l.version_id)) AS shared,
    EXISTS(SELECT 1 FROM skill_versions v JOIN skill_library_entries l ON l.version_id=v.id WHERE v.skill_id=s.id AND v.manifest_sha256=$3 AND NOT EXISTS(SELECT 1 FROM skill_library_withdrawals w WHERE w.version_id=l.version_id)) AS same_shared
    FROM skills s WHERE owner_user_id=$1 AND source_key=$2`,
      [owner, source, manifest ?? null],
    )
  ).rows[0];
  if (existing && (existing.private || !existing.shared || existing.same_shared)) return;
  const q = await capacity(c, owner);
  if (q.privateSkillCount >= q.privateSkillLimit)
    throw new AccountError("PRIVATE_SKILL_CAPACITY_EXCEEDED", 429);
}
