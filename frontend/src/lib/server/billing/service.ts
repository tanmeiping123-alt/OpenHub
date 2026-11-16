import "server-only";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PoolClient } from "pg";
import { AccountError } from "../account-errors";
import type { Actor } from "../identity-context";
import { withTransaction } from "../db";
import {
  billingInput,
  FREE_PLAN,
  paymentConfig,
  PRO_PLAN,
  PAYMENT_CHANNELS,
  type PaymentChannel,
} from "@/lib/billing-policy";
import { capacity, entitlement, lockCapacity, lockQuota } from "./entitlements";
import { assertActiveActor } from "../skills/skill-library";

const id = (prefix: string) => `${prefix}_${randomUUID()}`;
type Config = ReturnType<typeof paymentConfig>;
export async function configuredPayment(
  channel: PaymentChannel = "ALIPAY_MANUAL",
): Promise<Config> {
  const cfg = paymentConfig(process.env, channel);
  if (cfg.ready) {
    try {
      const bytes = await readFile(path.join(process.cwd(), "public", cfg.qrPath));
      cfg.ready =
        bytes.length <= 2_000_000 &&
        (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
          (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) ||
          (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP"));
    } catch {
      cfg.ready = false;
    }
  }
  return cfg;
}
async function event(
  c: PoolClient,
  actor: Actor,
  orderId: string | null,
  type: string,
  details: object = {},
) {
  await c.query(
    "INSERT INTO billing_events(id,order_id,actor_id,event_type,details) VALUES($1,$2,$3,$4,$5)",
    [id("bev"), orderId, actor.id, type, JSON.stringify(details)],
  );
}
function text(v: string, min = 1, max = 1000) {
  if (v.length < min || v.length > max) throw new AccountError("INVALID_BILLING_INPUT");
  return v;
}
function time(v: string) {
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(Z|[+-]\d\d:\d\d)$/.test(v) ||
    !Number.isFinite(Date.parse(v)) ||
    Date.parse(v) > Date.now() + 5 * 60_000
  )
    throw new AccountError("INVALID_PAYMENT_TIME");
  return v;
}
const fields: Record<string, string[]> = {
  create_order: ["requestKey"],
  cancel_order: ["orderId"],
  submit_claim: ["orderId", "transactionId", "paidAt"],
  review_order: [
    "orderId",
    "transactionId",
    "receivedAt",
    "receiverAccount",
    "amountFen",
    "currency",
    "note",
    "verified",
  ],
  repair_grant: ["orderId", "note"],
  request_refund: ["orderId", "reason"],
  reject_claim: ["orderId", "note"],
  refund_processing: ["orderId", "note"],
  refund_failed: ["orderId", "note"],
  refund_retry: ["orderId", "note"],
  refund_success: ["orderId", "note", "refundTransaction", "verified"],
  allowlist_add: ["email", "reason"],
  allowlist_remove: ["email", "reason"],
};
export function parseBillingCommand(value: unknown) {
  const action = (value as { action?: unknown } | null)?.action;
  if (typeof action !== "string" || !Object.hasOwn(fields, action))
    throw new AccountError("INVALID_BILLING_INPUT");
  try {
    const withChannel = action === "create_order" && Object.hasOwn(value as object, "channel");
    const v = billingInput(value, [
      "action",
      ...fields[action],
      ...(withChannel ? ["channel"] : []),
    ]);
    if (withChannel && !PAYMENT_CHANNELS.includes(v.channel as PaymentChannel))
      throw Error("INVALID_CHANNEL");
    return v;
  } catch {
    throw new AccountError("INVALID_BILLING_INPUT");
  }
}
const orderColumns = `o.id,o.owner_user_id AS "ownerId",o.status,o.channel,o.amount_fen AS "amountFen",o.currency,o.plan_code AS "planCode",
 o.receiver_hint AS "receiverHint",o.refund_contact AS "refundContact",o.qr_path AS "qrPath",
 o.claim_transaction AS "claimTransaction",o.claim_paid_at AS "claimPaidAt",o.created_at AS "createdAt",o.expires_at AS "expiresAt",o.paid_at AS "paidAt",o.issue_code AS "issueCode",
 e.starts_at AS "entitlementStart",e.ends_at AS "entitlementEnd",e.revoked_at AS "revokedAt",r.status AS "refundStatus",
 CASE WHEN r.status='SUCCESS' THEN 'REFUNDED' WHEN o.status='PAID' AND e.order_id IS NULL THEN 'GRANT_PENDING' WHEN e.revoked_at IS NOT NULL THEN 'REVOKED' WHEN e.ends_at<=now() THEN 'ENDED' WHEN e.order_id IS NOT NULL THEN 'ACTIVE' ELSE 'NONE' END AS "grantStatus"`;
const orderJoins = `FROM billing_orders o LEFT JOIN billing_entitlements e ON e.order_id=o.id LEFT JOIN billing_refunds r ON r.order_id=o.id`;
export async function billingOverview(actor: Actor) {
  const methods = await Promise.all(PAYMENT_CHANNELS.map((channel) => configuredPayment(channel)));
  return withTransaction(async (c) => {
    await assertActiveActor(c, actor);
    const access = await entitlement(c, actor.id);
    const used = Boolean(
      (await c.query("SELECT 1 FROM billing_consumed_offers WHERE owner_user_id=$1", [actor.id]))
        .rowCount,
    );
    // Administrators review payments and never need a customer subscription.
    const eligible = actor.role === "USER";
    const modelQuotaUnlimited =
      actor.role === "ADMIN" &&
      (
        await c.query("SELECT unlimited FROM model_quota_policies WHERE owner_user_id=$1", [
          actor.id,
        ])
      ).rows[0]?.unlimited === true;
    const orders = (
      await c.query(
        `SELECT ${orderColumns},CASE WHEN o.status='PENDING' AND o.expires_at<=now() THEN 'EXPIRED' ELSE o.status END AS status ${orderJoins} WHERE o.owner_user_id=$1 ORDER BY o.created_at DESC LIMIT 50`,
        [actor.id],
      )
    ).rows;
    return {
      role: actor.role,
      modelQuotaUnlimited,
      payment: {
        ready: methods.some((method) => method.ready),
        automaticPaymentEnabled: false,
        methods: methods.map(({ channel, ready }) => ({ channel, ready })),
      },
      plans: { free: FREE_PLAN, pro: PRO_PLAN },
      eligibility: eligible,
      offerUsed: used,
      entitlement: {
        code: access.code,
        tier: access.plan.tier,
        start: access.start.toISOString(),
        end: access.end.toISOString(),
        frozen: access.frozen,
      },
      capacity: await capacity(c, actor.id),
      orders,
    };
  });
}
export async function adminBillingOverview(actor: Actor) {
  if (actor.role !== "ADMIN") throw new AccountError("ADMIN_REQUIRED", 403);
  return withTransaction(async (c) => {
    await assertActiveActor(c, actor);
    return {
      orders: (
        await c.query(
          `SELECT ${orderColumns},CASE WHEN o.status='PENDING' AND o.expires_at<=now() THEN 'EXPIRED' ELSE o.status END AS status,COALESCE(a.email,admin.email) AS "ownerEmail",o.receiver_account AS "receiverAccount",p.transaction_id AS "verifiedTransaction",p.evidence_note AS "evidenceNote",r.request_id AS "refundRequestId",r.reason AS "refundReason",r.refund_transaction AS "refundTransaction" ${orderJoins} LEFT JOIN billing_receipts p ON p.order_id=o.id LEFT JOIN regular_users a ON a.user_id=o.owner_user_id LEFT JOIN administrator_users admin ON admin.user_id=o.owner_user_id ORDER BY CASE WHEN o.status='REVIEW' OR o.status='EXPIRED' AND o.claim_transaction IS NOT NULL AND o.issue_code IS DISTINCT FROM 'CLAIM_REJECTED' OR o.status='PAID' AND e.order_id IS NULL AND r.status IS DISTINCT FROM 'SUCCESS' OR r.status IN ('REQUESTED','PROCESSING') THEN 0 ELSE 1 END,o.created_at DESC LIMIT 100`,
        )
      ).rows,
      allowlist: (
        await c.query(
          "SELECT a.email,b.reason,b.created_at FROM billing_test_allowlist b JOIN regular_users a ON a.user_id=b.owner_user_id ORDER BY b.created_at",
        )
      ).rows,
      events: (
        await c.query(
          'SELECT order_id AS "orderId",actor_id AS "actorId",event_type AS type,created_at AS "createdAt" FROM billing_events ORDER BY created_at DESC LIMIT 100',
        )
      ).rows,
    };
  });
}

// Exposed transaction core permits rollback-only integration tests. The HTTP route
// never accepts a configuration, actor identity, amount override or simulator flag.
export async function billingCommand(
  c: PoolClient,
  actor: Actor,
  v: Record<string, string>,
  cfg: Config,
) {
  await assertActiveActor(c, actor);
  await lockQuota(c);
  if (v.action.startsWith("allowlist_")) {
    if (actor.role !== "ADMIN") throw new AccountError("ADMIN_REQUIRED", 403);
    await c.query("SELECT pg_advisory_xact_lock(hashtext('billing-allowlist'))");
    const email = text(v.email.toLowerCase(), 3, 254);
    const user = (
      await c.query("SELECT user_id FROM regular_users WHERE email=$1 AND NOT disabled", [email])
    ).rows[0];
    if (!user) throw new AccountError("TEST_ACCOUNT_NOT_FOUND", 404);
    if (v.action === "allowlist_add") {
      if (
        !(
          await c.query("SELECT 1 FROM billing_test_allowlist WHERE owner_user_id=$1", [
            user.user_id,
          ])
        ).rowCount
      ) {
        if (
          Number((await c.query("SELECT count(*) AS n FROM billing_test_allowlist")).rows[0].n) >= 5
        )
          throw new AccountError("ALLOWLIST_FULL", 409);
        await c.query(
          "INSERT INTO billing_test_allowlist(owner_user_id,added_by,reason) VALUES($1,$2,$3)",
          [user.user_id, actor.id, text(v.reason, 5)],
        );
      }
    } else
      await c.query("DELETE FROM billing_test_allowlist WHERE owner_user_id=$1", [user.user_id]);
    await event(c, actor, null, v.action.toUpperCase(), {
      ownerId: user.user_id,
      reason: text(v.reason, 5),
    });
    return { ok: true };
  }
  if (v.action === "create_order") {
    if (actor.role === "ADMIN") throw new AccountError("ADMIN_SUBSCRIPTION_NOT_REQUIRED", 403);
    await lockCapacity(c, actor.id);
    if (!/^[a-zA-Z0-9._-]{8,120}$/.test(v.requestKey))
      throw new AccountError("INVALID_IDEMPOTENCY_KEY");
    const prior = (
      await c.query(
        "SELECT id,status,channel FROM billing_orders WHERE owner_user_id=$1 AND request_key=$2",
        [actor.id, v.requestKey],
      )
    ).rows[0];
    const channel = v.channel ?? "ALIPAY_MANUAL";
    if (!PAYMENT_CHANNELS.includes(channel as PaymentChannel) || cfg.channel !== channel)
      throw new AccountError("INVALID_BILLING_INPUT");
    if (prior) {
      if (prior.channel !== channel) throw new AccountError("ORDER_CHANNEL_CONFLICT", 409);
      return prior;
    }
    if (
      (await c.query("SELECT 1 FROM billing_consumed_offers WHERE owner_user_id=$1", [actor.id]))
        .rowCount
    )
      throw new AccountError("TEST_OFFER_ALREADY_USED", 409);
    if (!cfg.ready) throw new AccountError("PAYMENT_NOT_CONFIGURED", 503);
    const expired = (
      await c.query(
        "UPDATE billing_orders SET status='EXPIRED' WHERE owner_user_id=$1 AND status='PENDING' AND expires_at<=now() RETURNING id",
        [actor.id],
      )
    ).rows;
    for (const o of expired) await event(c, actor, o.id, "ORDER_EXPIRED");
    const existing = (
      await c.query(
        "SELECT id,status,channel FROM billing_orders WHERE owner_user_id=$1 AND (status IN ('PENDING','REVIEW') OR status='EXPIRED' AND claim_transaction IS NOT NULL AND issue_code IS DISTINCT FROM 'CLAIM_REJECTED') ORDER BY created_at LIMIT 1",
        [actor.id],
      )
    ).rows[0];
    if (existing) {
      if (existing.channel !== channel) throw new AccountError("ORDER_CHANNEL_CONFLICT", 409);
      return existing;
    }
    if ((await entitlement(c, actor.id)).orderId) throw new AccountError("ALREADY_PRO", 409);
    const orderId = id("ord");
    const plan = (
      await c.query("SELECT snapshot FROM billing_plan_versions WHERE code='PRO_TEST_30D_V1'")
    ).rows[0].snapshot;
    await c.query(
      `INSERT INTO billing_orders(id,owner_user_id,plan_code,snapshot,amount_fen,currency,environment,channel,receiver_account,receiver_hint,refund_contact,qr_path,request_key,status,expires_at)
      VALUES($1,$2,'PRO_TEST_30D_V1',$3,1,'CNY','LOCAL_MANUAL',$9,$4,$5,$6,$7,$8,'PENDING',now()+interval '15 minutes')`,
      [
        orderId,
        actor.id,
        JSON.stringify(plan),
        cfg.receiverAccount,
        cfg.receiverHint,
        cfg.refundContact,
        cfg.qrPath,
        v.requestKey,
        cfg.channel,
      ],
    );
    await event(c, actor, orderId, "ORDER_CREATED");
    return { id: orderId, status: "PENDING" };
  }
  if (!/^ord_[a-f0-9-]{36}$/.test(v.orderId ?? "")) throw new AccountError("INVALID_ORDER_ID");
  // Serialize all commands for an owner, including late receipts on a different order.
  const lookup = (
    await c.query("SELECT owner_user_id FROM billing_orders WHERE id=$1", [v.orderId])
  ).rows[0];
  if (!lookup || (actor.role !== "ADMIN" && lookup.owner_user_id !== actor.id))
    throw new AccountError("ORDER_NOT_FOUND", 404);
  await lockCapacity(c, lookup.owner_user_id);
  const o = (await c.query("SELECT * FROM billing_orders WHERE id=$1 FOR UPDATE", [v.orderId]))
    .rows[0];
  if (v.action === "cancel_order") {
    if (o.status !== "PENDING" || o.claim_transaction)
      throw new AccountError("ORDER_CANNOT_CANCEL", 409);
    await c.query(
      "UPDATE billing_orders SET status='EXPIRED',issue_code='USER_CLOSED' WHERE id=$1",
      [o.id],
    );
    await event(c, actor, o.id, "UNPAID_ORDER_CLOSED");
    return { orderId: o.id, status: "EXPIRED" };
  }
  if (v.action === "submit_claim") {
    const transactionId = text(v.transactionId, 4, 120),
      paidAt = time(v.paidAt);
    if (o.status === "PAID") return { orderId: o.id, status: o.status };
    if (o.claim_transaction) {
      if (
        o.claim_transaction !== transactionId ||
        new Date(o.claim_paid_at).getTime() !== Date.parse(paidAt)
      )
        throw new AccountError("CLAIM_ALREADY_SUBMITTED", 409);
      return { orderId: o.id, status: o.status };
    }
    if (Date.parse(paidAt) < new Date(o.created_at).getTime() - 5 * 60_000)
      throw new AccountError("INVALID_PAYMENT_TIME");
    const another = (
      await c.query(
        "SELECT 1 FROM billing_orders WHERE owner_user_id=$1 AND id<>$2 AND status IN ('PENDING','REVIEW')",
        [o.owner_user_id, o.id],
      )
    ).rowCount;
    await c.query(
      "UPDATE billing_orders SET status=$2,claim_transaction=$3,claim_paid_at=$4,issue_code=$5 WHERE id=$1",
      [
        o.id,
        another ? "EXPIRED" : "REVIEW",
        transactionId,
        paidAt,
        new Date(o.expires_at) < new Date() ? "LATE_PAYMENT_REVIEW" : null,
      ],
    );
    await event(c, actor, o.id, "CLAIM_SUBMITTED");
    return { orderId: o.id, status: another ? "EXPIRED" : "REVIEW" };
  }
  if (v.action === "request_refund") {
    if (o.status !== "PAID") throw new AccountError("ORDER_NOT_REFUNDABLE", 409);
    const prior = (await c.query("SELECT status FROM billing_refunds WHERE order_id=$1", [o.id]))
      .rows[0];
    if (prior) return { orderId: o.id, status: prior.status };
    await c.query(
      "INSERT INTO billing_refunds(order_id,request_id,status,amount_fen,reason) VALUES($1,$2,'REQUESTED',1,$3)",
      [o.id, id("rfd"), text(v.reason, 5)],
    );
    await event(c, actor, o.id, "REFUND_REQUESTED");
    return { orderId: o.id, status: "REQUESTED" };
  }
  if (actor.role !== "ADMIN") throw new AccountError("ADMIN_REQUIRED", 403);
  if (v.action === "reject_claim") {
    if (o.status === "PAID") throw new AccountError("PAID_ORDER_CANNOT_REJECT", 409);
    await c.query(
      "UPDATE billing_orders SET status='EXPIRED',issue_code='CLAIM_REJECTED' WHERE id=$1",
      [o.id],
    );
    await event(c, actor, o.id, "CLAIM_REJECTED", { reason: text(v.note, 5) });
    return { orderId: o.id, status: "EXPIRED" };
  }
  if (v.action === "review_order") {
    text(v.note, 5);
    text(v.transactionId, 4, 120);
    time(v.receivedAt);
    if (
      v.verified !== "CONFIRMED_REAL_RECEIPT" ||
      v.receiverAccount !== o.receiver_account ||
      v.amountFen !== "1" ||
      v.currency !== "CNY"
    )
      throw new AccountError("RECEIPT_MISMATCH");
    if (Date.parse(v.receivedAt) < new Date(o.created_at).getTime() - 5 * 60_000)
      throw new AccountError("INVALID_PAYMENT_TIME");
    const previous = (await c.query("SELECT * FROM billing_receipts WHERE order_id=$1", [o.id]))
      .rows[0];
    if (previous) {
      if (
        previous.transaction_id !== v.transactionId ||
        new Date(previous.received_at).getTime() !== Date.parse(v.receivedAt)
      )
        throw new AccountError("RECEIPT_ALREADY_RECORDED", 409);
      return { orderId: o.id, status: "PAID" };
    }
    if (
      (
        await c.query(
          "SELECT 1 FROM billing_receipts WHERE channel=$1 AND receiver_account=$2 AND transaction_id=$3",
          [o.channel, o.receiver_account, v.transactionId],
        )
      ).rowCount
    )
      throw new AccountError("TRANSACTION_ALREADY_CLAIMED", 409);
    await c.query(
      "INSERT INTO billing_receipts(order_id,channel,receiver_account,transaction_id,amount_fen,currency,received_at,reviewer_id,evidence_note) VALUES($1,$2,$3,$4,1,'CNY',$5,$6,$7)",
      [o.id, o.channel, o.receiver_account, v.transactionId, v.receivedAt, actor.id, v.note],
    );
    const consumed = await c.query(
      "INSERT INTO billing_consumed_offers(owner_user_id,plan_code,order_id) VALUES($1,$2,$3) ON CONFLICT(owner_user_id,plan_code) DO NOTHING RETURNING order_id",
      [o.owner_user_id, o.plan_code, o.id],
    );
    const issue = consumed.rowCount ? null : "OFFER_ALREADY_CONSUMED_REFUND_REQUIRED";
    await c.query(
      "UPDATE billing_orders SET status='PAID',paid_at=now(),issue_code=$2 WHERE id=$1",
      [o.id, issue],
    );
    await event(c, actor, o.id, "RECEIPT_CONFIRMED", { issue });
    return { orderId: o.id, status: "PAID" };
  }
  if (v.action === "repair_grant") {
    text(v.note, 5);
    await event(c, actor, o.id, "GRANT_REPAIR_REQUESTED", { reason: v.note });
    return { orderId: o.id, status: o.status };
  }
  const refund = (
    await c.query("SELECT * FROM billing_refunds WHERE order_id=$1 FOR UPDATE", [o.id])
  ).rows[0];
  if (!refund) throw new AccountError("REFUND_NOT_FOUND", 404);
  const target = (
    {
      refund_processing: "PROCESSING",
      refund_failed: "FAILED",
      refund_success: "SUCCESS",
      refund_retry: "PROCESSING",
    } as Record<string, string>
  )[v.action];
  if (!target) throw new AccountError("INVALID_BILLING_INPUT");
  text(v.note, 5);
  if (refund.status === target) {
    if (target === "SUCCESS" && refund.refund_transaction !== v.refundTransaction)
      throw new AccountError("REFUND_ALREADY_RECORDED", 409);
    return { orderId: o.id, status: target };
  }
  if (!(
    (refund.status === "REQUESTED" && ["PROCESSING", "FAILED"].includes(target)) ||
    (refund.status === "PROCESSING" && ["SUCCESS", "FAILED"].includes(target)) ||
    (refund.status === "FAILED" && v.action === "refund_retry")
  ))
    throw new AccountError("INVALID_REFUND_TRANSITION", 409);
  if (target === "SUCCESS") {
    text(v.refundTransaction, 4, 120);
    if (v.verified !== "CONFIRMED_REAL_REFUND")
      throw new AccountError("REAL_REFUND_CONFIRMATION_REQUIRED");
    if (
      (
        await c.query("SELECT 1 FROM billing_refunds WHERE refund_transaction=$1", [
          v.refundTransaction,
        ])
      ).rowCount
    )
      throw new AccountError("REFUND_TRANSACTION_ALREADY_USED", 409);
  }
  await c.query(
    "UPDATE billing_refunds SET status=$2,reviewer_id=$3,evidence_note=$4,refund_transaction=$5,completed_at=CASE WHEN $2 IN ('SUCCESS','FAILED') THEN now() ELSE NULL END,frozen_at=CASE WHEN $6 THEN now() ELSE frozen_at END WHERE order_id=$1",
    [
      o.id,
      target,
      actor.id,
      v.note,
      target === "SUCCESS" ? v.refundTransaction : null,
      v.action === "refund_retry",
    ],
  );
  if (target === "SUCCESS")
    await c.query(
      "UPDATE billing_entitlements SET revoked_at=now() WHERE order_id=$1 AND revoked_at IS NULL",
      [o.id],
    );
  if (target === "FAILED") {
    const compensation = (
      await c.query(
        "UPDATE billing_entitlements SET ends_at=ends_at+(now()-$2::timestamptz) WHERE order_id=$1 AND revoked_at IS NULL RETURNING extract(epoch FROM (now()-$2::timestamptz)) AS seconds",
        [o.id, refund.frozen_at],
      )
    ).rows[0];
    await event(c, actor, o.id, "REFUND_FREEZE_COMPENSATED", {
      seconds: Number(compensation?.seconds ?? 0),
    });
  }
  await event(c, actor, o.id, `REFUND_${target}`, { reason: v.note });
  return { orderId: o.id, status: target };
}

export async function grantOrder(c: PoolClient, actor: Actor, orderId: string) {
  if (actor.role !== "ADMIN") throw new AccountError("ADMIN_REQUIRED", 403);
  await assertActiveActor(c, actor);
  await lockQuota(c);
  const o = (await c.query("SELECT * FROM billing_orders WHERE id=$1", [orderId])).rows[0];
  if (!o) throw new AccountError("ORDER_NOT_FOUND", 404);
  await lockCapacity(c, o.owner_user_id);
  const old = (await c.query("SELECT * FROM billing_entitlements WHERE order_id=$1", [orderId]))
    .rows[0];
  if (old) return { grantStatus: old.revoked_at ? "REVOKED" : "GRANTED" };
  if (
    o.status !== "PAID" ||
    !(await c.query("SELECT 1 FROM billing_consumed_offers WHERE order_id=$1", [orderId])).rowCount
  )
    throw new AccountError("GRANT_NOT_ELIGIBLE", 409);
  if (
    (
      await c.query(
        "SELECT 1 FROM billing_refunds WHERE order_id=$1 AND status IN ('REQUESTED','PROCESSING','SUCCESS')",
        [orderId],
      )
    ).rowCount
  )
    throw new AccountError("REFUND_BLOCKS_GRANT", 409);
  if ((await entitlement(c, o.owner_user_id)).orderId)
    throw new AccountError("ENTITLEMENT_OVERLAP", 409);
  await c.query(
    "INSERT INTO billing_entitlements(order_id,owner_user_id,starts_at,ends_at) VALUES($1,$2,now(),now()+interval '720 hours')",
    [orderId, o.owner_user_id],
  );
  await event(c, actor, orderId, "ENTITLEMENT_GRANTED");
  return { grantStatus: "GRANTED" };
}
export async function executeBillingCommand(actor: Actor, value: unknown) {
  const v = parseBillingCommand(value);
  if (v.action === "create_order" && actor.role === "ADMIN")
    throw new AccountError("ADMIN_SUBSCRIPTION_NOT_REQUIRED", 403);
  if (v.action === "create_order") {
    const attempts = await withTransaction(
      async (c) =>
        (
          await c.query(
            `INSERT INTO billing_request_limits(owner_user_id,attempts) VALUES($1,1) ON CONFLICT(owner_user_id) DO UPDATE SET attempts=CASE WHEN billing_request_limits.window_start<now()-interval '15 minutes' THEN 1 ELSE billing_request_limits.attempts+1 END,window_start=CASE WHEN billing_request_limits.window_start<now()-interval '15 minutes' THEN now() ELSE billing_request_limits.window_start END RETURNING attempts`,
            [actor.id],
          )
        ).rows[0].attempts,
    );
    if (attempts > 10) throw new AccountError("PAYMENT_RATE_LIMIT", 429);
  }
  const cfg = await configuredPayment((v.channel ?? "ALIPAY_MANUAL") as PaymentChannel);
  const result = await withTransaction((c) => billingCommand(c, actor, v, cfg));
  if (["review_order", "repair_grant"].includes(v.action)) {
    try {
      return { ...result, ...(await withTransaction((c) => grantOrder(c, actor, v.orderId))) };
    } catch (error) {
      return {
        ...result,
        grantStatus: "GRANT_PENDING",
        issue: error instanceof AccountError ? error.code : "GRANT_RETRY_REQUIRED",
      };
    }
  }
  return result;
}
