import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { ensureDatabaseReady, getPool, withTransaction } from "../db";
import { createAccountInTransaction } from "../accounts";
import type { Actor } from "../identity-context";
import {
  adminBillingOverview,
  billingOverview,
  billingCommand,
  grantOrder,
  parseBillingCommand,
} from "./service";
import { FREE_PLAN, paymentConfig } from "@/lib/billing-policy";
import { assertPromptCapacity, assertSkillCapacity, entitlement } from "./entitlements";
import { periodUsage } from "./quota-periods";
import {
  finalizeModelQuota,
  reserveModelQuotaInTransaction,
} from "../model/model-quota-repository";
import type { LiveModelConfig } from "../model/model-types";

const cfg = {
  ...paymentConfig({}),
  ready: true,
  receiverAccount: "synthetic-receiver",
  receiverHint: "SYNTHETIC ONLY",
  refundContact: "Rollback-only test; no money",
  qrPath: "/payments/synthetic.png",
};
type Scope = { c: PoolClient; admin: Actor; user: Actor; stranger: Actor };
async function scenario(work: (s: Scope) => Promise<void>) {
  await ensureDatabaseReady();
  const c = await getPool().connect();
  await c.query("BEGIN");
  try {
    const account = async (role: Actor["role"]) =>
      createAccountInTransaction(
        c,
        `billing-${randomUUID()}@example.test`,
        "scrypt$rollback-only",
        role,
      );
    await work({
      c,
      admin: await account("ADMIN"),
      user: await account("USER"),
      stranger: await account("USER"),
    });
  } finally {
    await c.query("ROLLBACK");
    c.release();
  }
}
const command = (s: Scope, actor: Actor, v: Record<string, string>) =>
  billingCommand(s.c, actor, parseBillingCommand(v), cfg);
const allow = (s: Scope, u = s.user) =>
  command(s, s.admin, {
    action: "allowlist_add",
    email: u.email,
    reason: "Synthetic rollback-only allowlist test",
  });
const create = async (s: Scope, u = s.user) => {
  return (await command(s, u, { action: "create_order", requestKey: randomUUID() })) as {
    id: string;
    status: string;
  };
};
const review = (s: Scope, order: string, transaction: string = randomUUID()) =>
  command(s, s.admin, {
    action: "review_order",
    orderId: order,
    transactionId: transaction,
    receivedAt: new Date().toISOString(),
    receiverAccount: cfg.receiverAccount,
    amountFen: "1",
    currency: "CNY",
    note: "Synthetic receipt in rollback-only test",
    verified: "CONFIRMED_REAL_RECEIPT",
  });
async function paid(s: Scope) {
  const o = await create(s);
  await review(s, o.id);
  await grantOrder(s.c, s.admin, o.id);
  return o;
}
async function sqlReject(c: PoolClient, sql: string, values: unknown[] = [], message?: string) {
  await c.query("SAVEPOINT expected_rejection");
  try {
    await expect(c.query(sql, values)).rejects.toThrow(message);
  } finally {
    await c.query("ROLLBACK TO SAVEPOINT expected_rejection");
    await c.query("RELEASE SAVEPOINT expected_rejection");
  }
}
const model: LiveModelConfig = {
  mode: "LIVE",
  provider: "deepseek",
  apiKey: "unused-no-network",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-flash",
  productVersion: "DeepSeek-V4.1-Flash-1017",
  timeoutMs: 1000,
  maxRetries: 0,
  maxOutputTokens: 100,
  dailyTokenLimit: 200000,
  dailyCostLimitUsd: 0.25,
  pricingWindow: "AUTO",
};
async function pending(s: Scope) {
  const id = `mex_${randomUUID()}`;
  await s.c.query(
    "INSERT INTO model_executions(id,owner_user_id,status,purpose,provider,requested_model,product_version,input_sha256) VALUES($1,$2,'PENDING','OPTIMIZATION','deepseek','deepseek-flash','DeepSeek-V4.1-Flash-1017',$3)",
    [id, s.user.id, "a".repeat(64)],
  );
  return id;
}
const reserve = (s: Scope, id: string) =>
  reserveModelQuotaInTransaction(
    s.c,
    { executionId: id, config: model, serializedMessages: "x" },
    s.user.id,
  );

describe.skipIf(process.env.PROMPTMASTER_BILLING_DB_TEST !== "true")(
  "manual billing: rollback-only PostgreSQL, no network or funds",
  () => {
    afterAll(async () => {
      await getPool().end();
    });
    it("snapshots WeChat and verifies its own receipt before granting Pro", () =>
      scenario(async (s) => {
        await allow(s);
        const wechat = {
          ...cfg,
          channel: "WECHAT_MANUAL" as const,
          receiverAccount: "synthetic-wechat",
          receiverHint: "Synthetic WeChat",
          qrPath: "/payments/synthetic-wechat.jpg",
        };
        const order = (await billingCommand(
          s.c,
          s.user,
          parseBillingCommand({
            action: "create_order",
            channel: "WECHAT_MANUAL",
            requestKey: randomUUID(),
          }),
          wechat,
        )) as { id: string };
        expect(
          (
            await s.c.query(
              "SELECT channel,receiver_account,qr_path FROM billing_orders WHERE id=$1",
              [order.id],
            )
          ).rows[0],
        ).toEqual({
          channel: "WECHAT_MANUAL",
          receiver_account: wechat.receiverAccount,
          qr_path: wechat.qrPath,
        });
        await command(s, s.user, {
          action: "submit_claim",
          orderId: order.id,
          transactionId: "synthetic-wechat-claim",
          paidAt: new Date().toISOString(),
        });
        expect((await entitlement(s.c, s.user.id)).plan.tier).toBe("Free");
        const receipt = {
          action: "review_order",
          orderId: order.id,
          transactionId: "synthetic-wechat-claim",
          receivedAt: new Date().toISOString(),
          receiverAccount: wechat.receiverAccount,
          amountFen: "1",
          currency: "CNY",
          note: "Synthetic WeChat original receipt",
          verified: "CONFIRMED_REAL_RECEIPT",
        };
        await expect(
          command(s, s.admin, { ...receipt, receiverAccount: cfg.receiverAccount }),
        ).rejects.toMatchObject({ code: "RECEIPT_MISMATCH" });
        await command(s, s.admin, receipt);
        await grantOrder(s.c, s.admin, order.id);
        expect((await entitlement(s.c, s.user.id)).plan.tier).toBe("Pro");
        expect(
          (
            await s.c.query(
              "SELECT channel,receiver_account FROM billing_receipts WHERE order_id=$1",
              [order.id],
            )
          ).rows[0],
        ).toEqual({ channel: "WECHAT_MANUAL", receiver_account: wechat.receiverAccount });
        await expect(
          command(s, s.user, { action: "create_order", requestKey: randomUUID() }),
        ).rejects.toMatchObject({ code: "TEST_OFFER_ALREADY_USED" });
        await command(s, s.user, {
          action: "request_refund",
          orderId: order.id,
          reason: "Synthetic WeChat refund",
        });
        await command(s, s.admin, {
          action: "refund_processing",
          orderId: order.id,
          note: "Synthetic return in progress",
        });
        await command(s, s.admin, {
          action: "refund_success",
          orderId: order.id,
          note: "Synthetic full return verified",
          refundTransaction: "synthetic-wechat-return",
          verified: "CONFIRMED_REAL_REFUND",
        });
        expect((await entitlement(s.c, s.user.id)).plan.tier).toBe("Free");
      }));
    it("requires closing an unpaid order before changing channel and preserves its snapshot", () =>
      scenario(async (s) => {
        const old = await create(s);
        const oldRow = (await s.c.query("SELECT * FROM billing_orders WHERE id=$1", [old.id]))
          .rows[0];
        const wechat = {
          ...cfg,
          channel: "WECHAT_MANUAL" as const,
          receiverAccount: "synthetic-wechat",
          qrPath: "/payments/synthetic-wechat.jpg",
        };
        const createWechat = (requestKey = randomUUID()) =>
          billingCommand(
            s.c,
            s.user,
            { action: "create_order", channel: "WECHAT_MANUAL", requestKey },
            wechat,
          );
        await expect(createWechat(oldRow.request_key)).rejects.toMatchObject({
          code: "ORDER_CHANNEL_CONFLICT",
        });
        await expect(createWechat()).rejects.toMatchObject({ code: "ORDER_CHANNEL_CONFLICT" });
        await expect(
          command(s, s.stranger, { action: "cancel_order", orderId: old.id }),
        ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
        await command(s, s.user, { action: "cancel_order", orderId: old.id });
        const next = (await createWechat()) as { id: string };
        expect(next.id).not.toBe(old.id);
        const closed = (await s.c.query("SELECT * FROM billing_orders WHERE id=$1", [old.id]))
          .rows[0];
        expect(closed).toMatchObject({
          channel: oldRow.channel,
          receiver_account: oldRow.receiver_account,
          qr_path: oldRow.qr_path,
          status: "EXPIRED",
          issue_code: "USER_CLOSED",
        });
        await sqlReject(s.c, "UPDATE billing_orders SET channel='WECHAT_MANUAL' WHERE id=$1", [
          old.id,
        ]);
        await command(s, s.user, {
          action: "submit_claim",
          orderId: old.id,
          transactionId: "synthetic-late-closed-payment",
          paidAt: new Date().toISOString(),
        });
        expect(
          (
            await s.c.query("SELECT status,claim_transaction FROM billing_orders WHERE id=$1", [
              old.id,
            ])
          ).rows[0],
        ).toMatchObject({ status: "EXPIRED", claim_transaction: "synthetic-late-closed-payment" });
        expect((await entitlement(s.c, s.user.id)).plan.tier).toBe("Free");
      }));
    it("rejects disabled or mismatched channel configuration without creating orders", () =>
      scenario(async (s) => {
        await allow(s);
        const v = { action: "create_order", requestKey: randomUUID(), channel: "WECHAT_MANUAL" };
        await expect(billingCommand(s.c, s.user, v, cfg)).rejects.toMatchObject({
          code: "INVALID_BILLING_INPUT",
        });
        await expect(
          billingCommand(s.c, s.user, v, { ...cfg, channel: "WECHAT_MANUAL", ready: false }),
        ).rejects.toMatchObject({ code: "PAYMENT_NOT_CONFIGURED" });
        expect(
          (
            await s.c.query("SELECT count(*) n FROM billing_orders WHERE owner_user_id=$1", [
              s.user.id,
            ])
          ).rows[0].n,
        ).toBe("0");
      }));
    it("will not cancel an order with evidence or recorded income", () =>
      scenario(async (s) => {
        const order = await create(s);
        await command(s, s.user, {
          action: "submit_claim",
          orderId: order.id,
          transactionId: "synthetic-dont-cancel",
          paidAt: new Date().toISOString(),
        });
        await expect(
          command(s, s.user, { action: "cancel_order", orderId: order.id }),
        ).rejects.toMatchObject({ code: "ORDER_CANNOT_CANCEL" });
        await review(s, order.id);
        await expect(
          command(s, s.user, { action: "cancel_order", orderId: order.id }),
        ).rejects.toMatchObject({ code: "ORDER_CANNOT_CANCEL" });
      }));
    it("keeps purchases closed without configured payment even for accounts outside the legacy allowlist", () =>
      scenario(async (s) => {
        await expect(
          billingCommand(
            s.c,
            s.user,
            { action: "create_order", requestKey: randomUUID() },
            { ...cfg, ready: false },
          ),
        ).rejects.toMatchObject({ code: "PAYMENT_NOT_CONFIGURED" });
        expect(
          (
            await s.c.query("SELECT count(*) n FROM billing_orders WHERE owner_user_id=$1", [
              s.user.id,
            ])
          ).rows[0].n,
        ).toBe("0");
      }));
    it("opens unchanged-price subscriptions for existing and future ordinary accounts without allowlisting", () =>
      scenario(async (s) => {
        const accounts = [s.user, s.stranger];
        for (let i = 0; i < 6; i++)
          accounts.push(
            await createAccountInTransaction(
              s.c,
              `future-${randomUUID()}@example.test`,
              "scrypt$rollback-only",
              "USER",
            ),
          );
        for (const account of accounts) {
          const order = await create(s, account);
          expect(
            (
              await s.c.query(
                "SELECT amount_fen,currency,plan_code FROM billing_orders WHERE id=$1",
                [order.id],
              )
            ).rows[0],
          ).toEqual({ amount_fen: 1, currency: "CNY", plan_code: "PRO_TEST_30D_V1" });
          expect(
            (
              await s.c.query("SELECT 1 FROM billing_test_allowlist WHERE owner_user_id=$1", [
                account.id,
              ])
            ).rowCount,
          ).toBe(0);
        }
        const order = await create(s);
        await review(s, order.id);
        await grantOrder(s.c, s.admin, order.id);
        expect((await entitlement(s.c, s.user.id)).plan.tier).toBe("Pro");
        await expect(create(s)).rejects.toMatchObject({ code: "TEST_OFFER_ALREADY_USED" });
      }));
    it("keeps administrators out of subscription purchases while allowing manual receipt review", () =>
      scenario(async (s) => {
        await expect(create(s, s.admin)).rejects.toMatchObject({
          code: "ADMIN_SUBSCRIPTION_NOT_REQUIRED",
        });
        const order = await create(s);
        await sqlReject(
          s.c,
          `INSERT INTO billing_orders(id,owner_user_id,plan_code,snapshot,amount_fen,currency,environment,
          channel,receiver_account,receiver_hint,refund_contact,qr_path,request_key,status,created_at,expires_at)
          SELECT 'ord_' || $1, $2, plan_code,snapshot,amount_fen,currency,environment,
          channel,receiver_account,receiver_hint,refund_contact,qr_path,$1,'PENDING',created_at,expires_at
          FROM billing_orders WHERE id=$3`,
          [randomUUID(), s.admin.id, order.id],
          "ADMIN_SUBSCRIPTION_NOT_REQUIRED",
        );
        await review(s, order.id);
        await grantOrder(s.c, s.admin, order.id);
        expect((await entitlement(s.c, s.user.id)).plan.tier).toBe("Pro");
      }));
    it("still rejects disabled account purchases after opening subscriptions", () =>
      scenario(async (s) => {
        for (const actor of [s.user, s.admin]) {
          const table = actor.role === "ADMIN" ? "administrator_users" : "regular_users";
          await s.c.query(`UPDATE ${table} SET disabled=true WHERE user_id=$1`, [actor.id]);
          await expect(create(s, actor)).rejects.toMatchObject({ code: "FORBIDDEN" });
        }
      }));
    it("reuses a pending order across keys and a claim alone never grants", () =>
      scenario(async (s) => {
        const o = await create(s);
        const again = await command(s, s.user, {
          action: "create_order",
          requestKey: randomUUID(),
        });
        expect(again).toMatchObject({ id: o.id });
        const claim = {
          action: "submit_claim",
          orderId: o.id,
          transactionId: "synthetic-claim",
          paidAt: new Date().toISOString(),
        };
        await command(s, s.user, claim);
        await command(s, s.user, claim);
        expect((await entitlement(s.c, s.user.id)).plan.tier).toBe("Free");
        await expect(command(s, s.stranger, claim)).rejects.toMatchObject({
          code: "ORDER_NOT_FOUND",
        });
        await expect(
          command(s, s.user, {
            action: "review_order",
            orderId: o.id,
            transactionId: "synthetic-txn",
            receivedAt: new Date().toISOString(),
            receiverAccount: cfg.receiverAccount,
            amountFen: "1",
            currency: "CNY",
            note: "Synthetic test",
            verified: "CONFIRMED_REAL_RECEIPT",
          }),
        ).rejects.toMatchObject({ code: "ADMIN_REQUIRED" });
      }));
    it("recovers paid-but-not-granted orders once without restarting the period", () =>
      scenario(async (s) => {
        const o = await create(s);
        await review(s, o.id);
        expect((await entitlement(s.c, s.user.id)).plan.tier).toBe("Free");
        await grantOrder(s.c, s.admin, o.id);
        const e = await entitlement(s.c, s.user.id);
        await grantOrder(s.c, s.admin, o.id);
        expect(await entitlement(s.c, s.user.id)).toEqual(e);
        expect(e.end.getTime() - e.start.getTime()).toBe(30 * 86400000);
        await expect(
          command(s, s.user, { action: "create_order", requestKey: randomUUID() }),
        ).rejects.toMatchObject({ code: "TEST_OFFER_ALREADY_USED" });
      }));
    it("rejects duplicate transaction ownership and mismatched receipt amount", () =>
      scenario(async (s) => {
        const a = await create(s),
          b = await create(s, s.stranger);
        await review(s, a.id, "same-synthetic-txn");
        await expect(review(s, b.id, "same-synthetic-txn")).rejects.toMatchObject({
          code: "TRANSACTION_ALREADY_CLAIMED",
        });
        await expect(
          command(s, s.admin, {
            action: "review_order",
            orderId: b.id,
            transactionId: "other-synthetic",
            receivedAt: new Date().toISOString(),
            receiverAccount: cfg.receiverAccount,
            amountFen: "2",
            currency: "CNY",
            note: "Synthetic mismatch",
            verified: "CONFIRMED_REAL_RECEIPT",
          }),
        ).rejects.toMatchObject({ code: "RECEIPT_MISMATCH" });
        await sqlReject(s.c, "UPDATE billing_orders SET amount_fen=2 WHERE id=$1", [a.id]);
        await sqlReject(
          s.c,
          "UPDATE billing_plan_versions SET snapshot='{}' WHERE code='PRO_TEST_30D_V1'",
        );
      }));
    it("preserves late income on an expired order for manual grant", () =>
      scenario(async (s) => {
        await allow(s);
        const oid = `ord_${randomUUID()}`;
        await s.c.query(
          `INSERT INTO billing_orders(id,owner_user_id,plan_code,snapshot,amount_fen,currency,environment,channel,receiver_account,receiver_hint,refund_contact,qr_path,request_key,status,created_at,expires_at) SELECT $1,$2,code,snapshot,1,'CNY','LOCAL_MANUAL','ALIPAY_MANUAL',$3,'Synthetic','Synthetic','/payments/synthetic.png',$4,'PENDING',now()-interval '20 minutes',now()-interval '5 minutes' FROM billing_plan_versions WHERE code='PRO_TEST_30D_V1'`,
          [oid, s.user.id, cfg.receiverAccount, randomUUID()],
        );
        await s.c.query("UPDATE billing_orders SET status='EXPIRED' WHERE id=$1", [oid]);
        await command(s, s.user, {
          action: "submit_claim",
          orderId: oid,
          transactionId: "late-synthetic",
          paidAt: new Date().toISOString(),
        });
        await review(s, oid);
        await grantOrder(s.c, s.admin, oid);
        expect((await entitlement(s.c, s.user.id)).plan.tier).toBe("Pro");
      }));
    it("requires real refund attestation, revokes only once and never restores the offer", () =>
      scenario(async (s) => {
        const o = await paid(s);
        await command(s, s.user, {
          action: "request_refund",
          orderId: o.id,
          reason: "Synthetic refund request",
        });
        expect((await entitlement(s.c, s.user.id)).frozen).toBe(true);
        await expect(
          command(s, s.admin, {
            action: "refund_success",
            orderId: o.id,
            note: "Synthetic test",
            refundTransaction: "refund-synthetic",
            verified: "CONFIRMED_REAL_REFUND",
          }),
        ).rejects.toMatchObject({ code: "INVALID_REFUND_TRANSITION" });
        await command(s, s.admin, {
          action: "refund_processing",
          orderId: o.id,
          note: "Synthetic processing",
        });
        await expect(
          command(s, s.admin, {
            action: "refund_success",
            orderId: o.id,
            note: "Synthetic test",
            refundTransaction: "refund-synthetic",
            verified: "not-confirmed",
          }),
        ).rejects.toMatchObject({ code: "REAL_REFUND_CONFIRMATION_REQUIRED" });
        const success = {
          action: "refund_success",
          orderId: o.id,
          note: "Synthetic real-return fixture",
          refundTransaction: "refund-synthetic",
          verified: "CONFIRMED_REAL_REFUND",
        };
        await command(s, s.admin, success);
        await command(s, s.admin, success);
        expect((await entitlement(s.c, s.user.id)).plan.tier).toBe("Free");
        expect(await grantOrder(s.c, s.admin, o.id)).toMatchObject({ grantStatus: "REVOKED" });
        await expect(
          command(s, s.user, { action: "create_order", requestKey: randomUUID() }),
        ).rejects.toMatchObject({ code: "TEST_OFFER_ALREADY_USED" });
      }));
    it("restores failed-refund service and records frozen-time compensation", () =>
      scenario(async (s) => {
        const o = await paid(s);
        const old = await entitlement(s.c, s.user.id);
        await command(s, s.user, {
          action: "request_refund",
          orderId: o.id,
          reason: "Synthetic refund request",
        });
        await command(s, s.admin, {
          action: "refund_failed",
          orderId: o.id,
          note: "Synthetic transfer failed",
        });
        const restored = await entitlement(s.c, s.user.id);
        expect(restored.frozen).toBe(false);
        expect(restored.end.getTime()).toBeGreaterThanOrEqual(old.end.getTime());
        expect(
          (
            await s.c.query(
              "SELECT count(*) n FROM billing_events WHERE order_id=$1 AND event_type='REFUND_FREEZE_COMPENSATED'",
              [o.id],
            )
          ).rows[0].n,
        ).toBe("1");
      }));
    it("binds Pro reservations to the order and retains unknown-attempt cost after refund", () =>
      scenario(async (s) => {
        const o = await paid(s);
        const eid = await pending(s);
        await reserve(s, eid);
        await s.c.query("UPDATE model_executions SET provider_attempt_count=1 WHERE id=$1", [eid]);
        const before = await entitlement(s.c, s.user.id);
        const start = before.start.getTime();
        await command(s, s.user, {
          action: "request_refund",
          orderId: o.id,
          reason: "Synthetic pending refund",
        });
        await expect(reserve(s, await pending(s))).rejects.toMatchObject({
          code: "MODEL_REFUND_PENDING",
        });
        await finalizeModelQuota(s.c, eid, s.user.id);
        const row = (await s.c.query("SELECT * FROM model_executions WHERE id=$1", [eid])).rows[0];
        expect(row.quota_order_id).toBe(o.id);
        expect(new Date(row.quota_period_start).getTime()).toBe(start);
        expect(row.quota_reservation_status).toBe("HELD");
        expect(row.reserved_total_tokens).toBe(357);
      }));
    it("keeps Free cycle usage across upgrade and downgrade, including Pro usage", () =>
      scenario(async (s) => {
        const original = await entitlement(s.c, s.user.id);
        const e1 = await pending(s);
        await reserve(s, e1);
        await s.c.query(
          "UPDATE model_executions SET total_tokens=10,prompt_tokens=10,completion_tokens=0,provider_attempt_count=1 WHERE id=$1",
          [e1],
        );
        await finalizeModelQuota(s.c, e1, s.user.id, {
          promptTokens: 10,
          completionTokens: 0,
          totalTokens: 10,
        });
        const o = await paid(s);
        const e2 = await pending(s);
        await reserve(s, e2);
        await s.c.query(
          "UPDATE model_executions SET total_tokens=20,prompt_tokens=20,completion_tokens=0,provider_attempt_count=1 WHERE id=$1",
          [e2],
        );
        await finalizeModelQuota(s.c, e2, s.user.id, {
          promptTokens: 20,
          completionTokens: 0,
          totalTokens: 20,
        });
        expect(
          (await periodUsage(s.c, s.user.id, await entitlement(s.c, s.user.id))).settledTokens,
        ).toBe(20);
        await command(s, s.user, {
          action: "request_refund",
          orderId: o.id,
          reason: "Synthetic downgrade test",
        });
        await command(s, s.admin, {
          action: "refund_processing",
          orderId: o.id,
          note: "Synthetic processing",
        });
        await command(s, s.admin, {
          action: "refund_success",
          orderId: o.id,
          note: "Synthetic return fixture",
          refundTransaction: "synthetic-return",
          verified: "CONFIRMED_REAL_REFUND",
        });
        const free = await entitlement(s.c, s.user.id);
        expect(free.start).toEqual(original.start);
        expect((await periodUsage(s.c, s.user.id, free)).settledTokens).toBe(30);
        expect(
          Number(
            (
              await s.c.query(
                "SELECT sum(settled_tokens) n FROM model_quota_usage_daily WHERE owner_user_id=$1",
                [s.user.id],
              )
            ).rows[0].n,
          ),
        ).toBe(30);
      }));
    it("enforces the period budget and independent platform budget before dispatch", () =>
      scenario(async (s) => {
        const fake = await pending(s);
        await s.c.query(
          "UPDATE model_executions SET total_tokens=$2,quota_reserved_at=now() WHERE id=$1",
          [fake, FREE_PLAN.periodTokens],
        );
        await expect(reserve(s, await pending(s))).rejects.toMatchObject({
          code: "MODEL_PERIOD_QUOTA_EXCEEDED",
        });
        await s.c.query("UPDATE model_executions SET total_tokens=0 WHERE id=$1", [fake]);
        await s.c.query("UPDATE billing_runtime_policy SET daily_usd=0 WHERE id=true");
        await expect(reserve(s, await pending(s))).rejects.toMatchObject({
          code: "MODEL_PLATFORM_BUDGET_EXCEEDED",
        });
      }));
    it("limits only new logical objects, keeping old Skill versions and Prompt versions available", () =>
      scenario(async (s) => {
        await s.c.query(
          "INSERT INTO prompts(id,owner_user_id,kind,title,task_type) SELECT 'prm_'||$1||n,$2,'PERSONAL_PROMPT','Synthetic','General' FROM generate_series(1,100)n",
          [randomUUID(), s.user.id],
        );
        await expect(assertPromptCapacity(s.c, s.user.id)).rejects.toMatchObject({
          code: "PROMPT_CAPACITY_EXCEEDED",
        });
        await s.c.query(
          "INSERT INTO skills(id,owner_user_id,source_key) SELECT 'skl_'||$1||n,$2,'source-'||n FROM generate_series(1,10)n",
          [randomUUID(), s.user.id],
        );
        await expect(assertSkillCapacity(s.c, s.user.id, "new-source")).rejects.toMatchObject({
          code: "PRIVATE_SKILL_CAPACITY_EXCEEDED",
        });
        await expect(assertSkillCapacity(s.c, s.user.id, "source-1")).resolves.toBeUndefined();
        await expect(
          assertSkillCapacity(s.c, s.admin.id, "admin-shared-source"),
        ).resolves.toBeUndefined();
      }));
    it("supports audited refund retry after a failed return", () =>
      scenario(async (s) => {
        const o = await paid(s);
        await command(s, s.user, {
          action: "request_refund",
          orderId: o.id,
          reason: "Synthetic retry scenario",
        });
        await command(s, s.admin, {
          action: "refund_failed",
          orderId: o.id,
          note: "Synthetic first failure",
        });
        await command(s, s.admin, {
          action: "refund_retry",
          orderId: o.id,
          note: "Synthetic explicit retry",
        });
        expect((await entitlement(s.c, s.user.id)).frozen).toBe(true);
        await command(s, s.admin, {
          action: "refund_success",
          orderId: o.id,
          note: "Synthetic retry result",
          refundTransaction: "synthetic-refund-retry",
          verified: "CONFIRMED_REAL_REFUND",
        });
        expect((await entitlement(s.c, s.user.id)).plan.tier).toBe("Free");
      }));
    it("expires service server-side without rebuilding the Free anchor or deleting data", () =>
      scenario(async (s) => {
        const original = await entitlement(s.c, s.user.id);
        const o = await create(s);
        await review(s, o.id);
        await s.c.query(
          "INSERT INTO billing_entitlements(order_id,owner_user_id,starts_at,ends_at) VALUES($1,$2,now()-interval '744 hours',now()-interval '24 hours')",
          [o.id, s.user.id],
        );
        const current = await entitlement(s.c, s.user.id);
        expect(current.plan.tier).toBe("Free");
        expect(current.start).toEqual(original.start);
        expect(
          (await s.c.query("SELECT count(*) n FROM billing_entitlements WHERE order_id=$1", [o.id]))
            .rows[0].n,
        ).toBe("1");
        await grantOrder(s.c, s.admin, o.id);
        expect((await entitlement(s.c, s.user.id)).plan.tier).toBe("Free");
      }));
    it("settles across a UTC-day boundary into the original reserved day", () =>
      scenario(async (s) => {
        const eid = await pending(s);
        await reserve(s, eid);
        const bound = (await s.c.query("SELECT * FROM model_executions WHERE id=$1", [eid]))
          .rows[0];
        await s.c.query(
          "UPDATE model_quota_usage_daily SET usage_day=usage_day-1 WHERE owner_user_id=$1",
          [s.user.id],
        );
        await s.c.query(
          "UPDATE model_executions SET quota_usage_day=quota_usage_day-1,quota_reserved_at=quota_reserved_at-interval '24 hours',provider_attempt_count=1,prompt_tokens=10,completion_tokens=0,total_tokens=10 WHERE id=$1",
          [eid],
        );
        await finalizeModelQuota(s.c, eid, s.user.id, {
          promptTokens: 10,
          completionTokens: 0,
          totalTokens: 10,
        });
        const ledger = (
          await s.c.query(
            "SELECT *,usage_day=(now() AT TIME ZONE 'UTC')::date AS today FROM model_quota_usage_daily WHERE owner_user_id=$1",
            [s.user.id],
          )
        ).rows[0];
        expect(ledger.today).toBe(false);
        expect(ledger.settled_tokens).toBe(10);
        expect(ledger.reserved_tokens).toBe(0);
        expect(
          (await s.c.query("SELECT quota_period_start FROM model_executions WHERE id=$1", [eid]))
            .rows[0].quota_period_start,
        ).toEqual(bound.quota_period_start);
      }));
    it("bounds the allowlist to five explicit regular accounts", () =>
      scenario(async (s) => {
        await allow(s);
        await allow(s, s.stranger);
        for (let i = 0; i < 3; i++) {
          const u = await createAccountInTransaction(
            s.c,
            `billing-${randomUUID()}@example.test`,
            "scrypt$synthetic",
            "USER",
          );
          await allow(s, u);
        }
        const sixth = await createAccountInTransaction(
          s.c,
          `billing-${randomUUID()}@example.test`,
          "scrypt$synthetic",
          "USER",
        );
        await expect(allow(s, sixth)).rejects.toMatchObject({ code: "ALLOWLIST_FULL" });
      }));
    it("serializes concurrent create, review and grant transactions in a disposable database", async () => {
      const target = new URL(process.env.DATABASE_URL!);
      expect(target.pathname).toMatch(/^\/pm_billing_test_[a-f0-9]{16}$/);
      await ensureDatabaseReady();
      const [admin, user] = await withTransaction(async (c) => {
        const admin = await createAccountInTransaction(
          c,
          `billing-${randomUUID()}@example.test`,
          "scrypt$synthetic",
          "ADMIN",
        );
        const user = await createAccountInTransaction(
          c,
          `billing-${randomUUID()}@example.test`,
          "scrypt$synthetic",
          "USER",
        );
        await billingCommand(
          c,
          admin,
          { action: "allowlist_add", email: user.email, reason: "Synthetic concurrency scenario" },
          cfg,
        );
        return [admin, user];
      });
      const orders = await Promise.all(
        [1, 2, 3].map(() =>
          withTransaction((c) =>
            billingCommand(c, user, { action: "create_order", requestKey: randomUUID() }, cfg),
          ),
        ),
      );
      const oid = (orders[0] as { id: string }).id;
      expect(orders.every((o) => (o as { id: string }).id === oid)).toBe(true);
      const v = {
        action: "review_order",
        orderId: oid,
        transactionId: "concurrent-synthetic-transaction",
        receivedAt: new Date().toISOString(),
        receiverAccount: cfg.receiverAccount,
        amountFen: "1",
        currency: "CNY",
        note: "Synthetic concurrency receipt",
        verified: "CONFIRMED_REAL_RECEIPT",
      };
      await Promise.all(
        [1, 2, 3].map(() => withTransaction((c) => billingCommand(c, admin, v, cfg))),
      );
      await Promise.all([1, 2, 3].map(() => withTransaction((c) => grantOrder(c, admin, oid))));
      expect(
        (await getPool().query("SELECT count(*) n FROM billing_receipts WHERE order_id=$1", [oid]))
          .rows[0].n,
      ).toBe("1");
      expect(
        (
          await getPool().query("SELECT count(*) n FROM billing_entitlements WHERE order_id=$1", [
            oid,
          ])
        ).rows[0].n,
      ).toBe("1");
      const adminView = await adminBillingOverview(admin);
      expect(adminView.orders.find((o) => o.id === oid)).toMatchObject({
        ownerEmail: user.email,
        verifiedTransaction: v.transactionId,
        grantStatus: "ACTIVE",
      });
      const ownView = await billingOverview(user);
      expect(ownView.eligibility).toBe(true);
      expect(ownView.orders).toHaveLength(1);
      expect(ownView.orders[0]).not.toHaveProperty("receiverAccount");
      expect(ownView.orders[0]).not.toHaveProperty("evidenceNote");
      await expect(
        withTransaction((c) =>
          billingCommand(c, admin, { action: "create_order", requestKey: randomUUID() }, cfg),
        ),
      ).rejects.toMatchObject({ code: "ADMIN_SUBSCRIPTION_NOT_REQUIRED" });
      expect((await billingOverview(admin)).eligibility).toBe(false);
    });
  },
);
