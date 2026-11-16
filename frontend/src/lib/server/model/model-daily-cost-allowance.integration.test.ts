import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { ensureDatabaseReady, getPool } from "../db";
import { createAccountInTransaction } from "../accounts";
import { billingCommand, grantOrder, parseBillingCommand } from "../billing/service";
import { paymentConfig } from "@/lib/billing-policy";
import { readModelConfig } from "./model-config";
import { finalizeModelQuota, reserveModelQuotaInTransaction } from "./model-quota-repository";
import type { Actor } from "../identity-context";
import type { LiveModelConfig } from "./model-types";

type Scope = { c: PoolClient; user: Actor; stranger: Actor; orderId: string };
const selected = [
  ["tencent/Hy4-preview", "default"],
  ["zai-org/GLM-5.3", "default"],
  ["deepseek-ai/DeepSeek-V4-Pro", "max"],
] as const;
// Historical frozen 1200-token calls exercise the legacy allowance ledger.
// New-request maxima are covered by full-output and workflow service tests.
const config = (key: string, strength: "default" | "max" = "default") =>
  ({
    ...readModelConfig(process.env, {
      modelKey: key,
      strength,
      maxOutputTokens: 1200,
    }),
    maxOutputTokens: 1200,
    dailyTokenLimit: 200000,
    dailyCostLimitUsd: 0.25,
  }) as LiveModelConfig;

async function scenario(work: (scope: Scope) => Promise<void>) {
  expect(new URL(process.env.DATABASE_URL!).pathname).toMatch(
    /^\/promptmaster_sf_test_[a-f0-9]{12}$/,
  );
  await ensureDatabaseReady();
  const c = await getPool().connect();
  await c.query("BEGIN");
  try {
    const create = (role: Actor["role"]) =>
      createAccountInTransaction(
        c,
        `allowance-${randomUUID()}@example.test`,
        "scrypt$synthetic-rollback-only",
        role,
      );
    const admin = await create("ADMIN"),
      user = await create("USER"),
      stranger = await create("USER");
    const payment = {
      ...paymentConfig({}),
      ready: true,
      receiverAccount: "synthetic-receiver",
      receiverHint: "Synthetic only",
      refundContact: "Synthetic, no funds",
      qrPath: "/payments/synthetic.png",
    };
    const command = (actor: Actor, body: Record<string, string>) =>
      billingCommand(c, actor, parseBillingCommand(body), payment);
    await command(admin, {
      action: "allowlist_add",
      email: user.email,
      reason: "Synthetic rollback-only test",
    });
    const order = (await command(user, { action: "create_order", requestKey: randomUUID() })) as {
      id: string;
    };
    await command(admin, {
      action: "review_order",
      orderId: order.id,
      transactionId: randomUUID(),
      receivedAt: new Date().toISOString(),
      receiverAccount: payment.receiverAccount,
      amountFen: "1",
      currency: "CNY",
      note: "Synthetic receipt in isolated rollback-only test; no payment",
      verified: "CONFIRMED_REAL_RECEIPT",
    });
    await grantOrder(c, admin, order.id);
    await work({ c, user, stranger, orderId: order.id });
  } finally {
    await c.query("ROLLBACK");
    c.release();
  }
}
async function reserve(s: Scope, model: LiveModelConfig, owner = s.user.id) {
  const id = `mex_${randomUUID()}`;
  await s.c.query(
    `INSERT INTO model_executions(id,owner_user_id,status,provider,requested_model,product_version,input_sha256)
     VALUES($1,$2,'PENDING',$3,$4,$5,$6)`,
    [id, owner, model.provider, model.model, model.productVersion, "a".repeat(64)],
  );
  await reserveModelQuotaInTransaction(
    s.c,
    { executionId: id, config: model, serializedMessages: "x" },
    owner,
  );
  return id;
}
async function seedUnknownCosts(s: Scope) {
  const ids: string[] = [];
  for (const key of ["zai-org/GLM-5.3-Flash", "tencent/Hy4-preview"]) {
    const id = await reserve(s, config(key));
    await s.c.query(
      `UPDATE model_executions SET provider_attempt_count=1,status='FAILED',error_code='SYNTHETIC_TIMEOUT',
       error_message='Synthetic, no actual provider request',completed_at=clock_timestamp() WHERE id=$1`,
      [id],
    );
    await finalizeModelQuota(s.c, id, s.user.id);
    ids.push(id);
  }
  return ids;
}
async function grant(s: Scope, offset = 0) {
  const id = `mqa_${randomUUID()}`;
  await s.c.query(
    `INSERT INTO model_daily_cost_allowances(id,owner_user_id,order_id,usage_day,daily_cost_limit_usd,starts_at,expires_at,approval_note)
     SELECT $1,$2,$3,day,1,day::timestamp AT TIME ZONE 'UTC',(day+1)::timestamp AT TIME ZONE 'UTC','Synthetic explicit approval; isolated rollback-only'
     FROM (SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date+$4::int AS day) d`,
    [id, s.user.id, s.orderId, offset],
  );
  return id;
}
const daily = async (s: Scope) =>
  (await s.c.query("SELECT * FROM model_quota_usage_daily WHERE owner_user_id=$1", [s.user.id]))
    .rows[0];

describe.skipIf(process.env.PROMPTMASTER_SILICONFLOW_DB_TEST !== "true")(
  "temporary daily testing budget (isolated, no network)",
  () => {
    afterAll(async () => {
      if (process.env.PROMPTMASTER_SILICONFLOW_DB_TEST === "true") await getPool().end();
    });
    it("allows the three selected modes without altering old holds or the base policy", () =>
      scenario(async (s) => {
        const holds = await seedUnknownCosts(s);
        const before = (
          await s.c.query("SELECT * FROM model_executions WHERE id=ANY($1::text[]) ORDER BY id", [
            holds,
          ])
        ).rows;
        for (const [key, strength] of selected)
          await expect(reserve(s, config(key, strength))).rejects.toMatchObject({
            code: "MODEL_USER_QUOTA_EXCEEDED",
          });
        await grant(s);
        for (const [key, strength] of selected) await reserve(s, config(key, strength));
        const usage = await daily(s);
        expect(Number(usage.reserved_cost_usd)).toBeGreaterThan(0.6);
        expect(Number(usage.reserved_cost_usd)).toBeLessThan(1);
        expect(usage.reserved_tokens).toBeLessThan(200000);
        expect(
          (
            await s.c.query("SELECT * FROM model_executions WHERE id=ANY($1::text[]) ORDER BY id", [
              holds,
            ])
          ).rows,
        ).toEqual(before);
        expect(
          Number(
            (
              await s.c.query(
                "SELECT daily_cost_limit_usd FROM model_quota_policies WHERE owner_user_id=$1",
                [s.user.id],
              )
            ).rows[0].daily_cost_limit_usd,
          ),
        ).toBe(0.25);
        await expect(
          reserve(s, { ...config(selected[0][0]), dailyCostLimitUsd: 0.1 }, s.stranger.id),
        ).rejects.toMatchObject({
          code: "MODEL_USER_QUOTA_EXCEEDED",
        });
      }));
    it("ignores past and future grants, and keeps approvals immutable and bounded", () =>
      scenario(async (s) => {
        await seedUnknownCosts(s);
        await grant(s, -1);
        await grant(s, 1);
        await expect(reserve(s, config(selected[0][0]))).rejects.toMatchObject({
          code: "MODEL_USER_QUOTA_EXCEEDED",
        });
        const id = await grant(s);
        for (const sql of [
          "UPDATE model_daily_cost_allowances SET daily_cost_limit_usd=0.5 WHERE id=$1",
          "DELETE FROM model_daily_cost_allowances WHERE id=$1",
        ]) {
          await s.c.query("SAVEPOINT rejected_change");
          await expect(s.c.query(sql, [id])).rejects.toThrow("immutable");
          await s.c.query("ROLLBACK TO SAVEPOINT rejected_change");
        }
        await s.c.query("SAVEPOINT rejected_change");
        await expect(
          s.c.query(
            `INSERT INTO model_daily_cost_allowances SELECT $1,owner_user_id,order_id,usage_day+2,2,starts_at+interval '48 hours',expires_at+interval '48 hours',approval_note,recorded_at FROM model_daily_cost_allowances WHERE id=$2`,
            [`mqa_${randomUUID()}`, id],
          ),
        ).rejects.toThrow();
        await s.c.query("ROLLBACK TO SAVEPOINT rejected_change");
        await reserve(s, config(selected[0][0]));
      }));
    it("keeps token, zero-budget, disabled-user and platform protections", () =>
      scenario(async (s) => {
        await seedUnknownCosts(s);
        await grant(s);
        const model = config(selected[0][0]);
        await expect(reserve(s, { ...model, dailyTokenLimit: 1 })).rejects.toMatchObject({
          code: "MODEL_USER_QUOTA_EXCEEDED",
        });
        await expect(reserve(s, { ...model, dailyCostLimitUsd: 0 })).rejects.toMatchObject({
          code: "MODEL_USER_QUOTA_EXCEEDED",
        });
        await s.c.query("UPDATE model_quota_policies SET enabled=false WHERE owner_user_id=$1", [
          s.user.id,
        ]);
        await expect(reserve(s, model)).rejects.toMatchObject({ code: "MODEL_USER_DISABLED" });
        await s.c.query("UPDATE model_quota_policies SET enabled=true WHERE owner_user_id=$1", [
          s.user.id,
        ]);
        await s.c.query("UPDATE billing_runtime_policy SET daily_usd=0 WHERE id=true");
        await expect(reserve(s, model)).rejects.toMatchObject({
          code: "MODEL_PLATFORM_BUDGET_EXCEEDED",
        });
      }));
    it("does not carry the allowance beyond the bound Pro subscription", () =>
      scenario(async (s) => {
        await seedUnknownCosts(s);
        await grant(s);
        await s.c.query(
          "UPDATE billing_entitlements SET revoked_at=clock_timestamp() WHERE order_id=$1",
          [s.orderId],
        );
        await expect(reserve(s, config(selected[0][0]))).rejects.toMatchObject({
          code: "MODEL_USER_QUOTA_EXCEEDED",
        });
      }));
  },
);
