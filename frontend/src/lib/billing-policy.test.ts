import { describe, expect, it } from "vitest";
import { FREE_PLAN, PRO_PLAN, freePeriod, paymentConfig } from "./billing-policy";
import { parseBillingCommand } from "./server/billing/service";
import { automaticPaymentAdapter } from "./server/billing/payment-adapter";
describe("billing boundaries", () => {
  it("uses account-anchored half-open 30-day periods", () => {
    const anchor = new Date("2026-01-01T12:34:56Z");
    expect(freePeriod(anchor, new Date("2026-01-31T12:34:55.999Z")).start).toEqual(anchor);
    expect(freePeriod(anchor, new Date("2026-01-31T12:34:56Z")).start.toISOString()).toBe(
      "2026-01-31T12:34:56.000Z",
    );
    expect(FREE_PLAN.dailyTokens).toBe(1500000);
    expect(PRO_PLAN.periodTokens).toBe(30000000);
    expect(PRO_PLAN.amountFen).toBe(1);
  });
  it("rejects fabricated price, owner, tier, simulator and oversized evidence fields", () => {
    for (const extra of [
      { amountFen: 1 },
      { ownerId: "another" },
      { tier: "Pro" },
      { simulate: true },
    ])
      expect(() =>
        parseBillingCommand({ action: "create_order", requestKey: "test-request", ...extra }),
      ).toThrow();
    expect(() => parseBillingCommand({ action: "simulate_success" })).toThrow();
    expect(() =>
      parseBillingCommand({
        action: "request_refund",
        orderId: "ord-test",
        reason: "x".repeat(1001),
      }),
    ).toThrow();
  });
  it("requires explicit complete configuration and confines collection images to payments", () => {
    expect(paymentConfig({}).ready).toBe(false);
    const cfg = {
      PROMPTMASTER_PAYMENT_ENABLED: "true",
      PROMPTMASTER_PAYMENT_QR_PATH: "/payments/real.png",
      PROMPTMASTER_PAYMENT_RECEIVER_ACCOUNT: "receiver",
      PROMPTMASTER_PAYMENT_RECEIVER_HINT: "name",
      PROMPTMASTER_PAYMENT_REFUND_CONTACT: "contact",
    };
    expect(paymentConfig(cfg).ready).toBe(true);
    for (const path of ["https://evil.test/qr.png", "/payments/../secret.png", "/payments/a.svg"])
      expect(paymentConfig({ ...cfg, PROMPTMASTER_PAYMENT_QR_PATH: path }).ready).toBe(false);
  });
  it("keeps every unconfigured official payment operation unavailable", async () => {
    await expect(
      automaticPaymentAdapter.createOrder({ id: "synthetic", amountFen: 1, currency: "CNY" }),
    ).rejects.toMatchObject({
      code: "AUTOMATIC_PAYMENT_NOT_CONFIGURED",
    });
    await expect(
      automaticPaymentAdapter.verifyNotification(new Uint8Array(), new Headers()),
    ).rejects.toMatchObject({ code: "AUTOMATIC_PAYMENT_NOT_CONFIGURED" });
    await expect(automaticPaymentAdapter.queryOrder("synthetic")).rejects.toThrow();
    await expect(
      automaticPaymentAdapter.refundOrder({
        orderId: "synthetic",
        refundRequestId: "synthetic",
        amountFen: 1,
      }),
    ).rejects.toThrow();
  });
  it("validates selected channels and keeps independent WeChat configuration fail-closed", () => {
    expect(
      parseBillingCommand({
        action: "create_order",
        requestKey: "test-request",
        channel: "WECHAT_MANUAL",
      }).channel,
    ).toBe("WECHAT_MANUAL");
    for (const channel of ["wechat", "STRIPE", "", 42])
      expect(() =>
        parseBillingCommand({ action: "create_order", requestKey: "test-request", channel }),
      ).toThrow();
    const env = {
      PROMPTMASTER_PAYMENT_ENABLED: "true",
      PROMPTMASTER_WECHAT_PAYMENT_ENABLED: "true",
      PROMPTMASTER_WECHAT_PAYMENT_QR_PATH: "/payments/wechat.png",
      PROMPTMASTER_WECHAT_PAYMENT_RECEIVER_ACCOUNT: "synthetic-wechat",
      PROMPTMASTER_WECHAT_PAYMENT_RECEIVER_HINT: "Synthetic WeChat",
      PROMPTMASTER_WECHAT_PAYMENT_REFUND_CONTACT: "Synthetic contact",
    };
    expect(paymentConfig(env).ready).toBe(false);
    expect(paymentConfig(env, "WECHAT_MANUAL")).toMatchObject({
      ready: true,
      channel: "WECHAT_MANUAL",
      receiverAccount: "synthetic-wechat",
    });
    expect(
      paymentConfig({ ...env, PROMPTMASTER_PAYMENT_ENABLED: "false" }, "WECHAT_MANUAL").ready,
    ).toBe(false);
    expect(
      paymentConfig({ ...env, PROMPTMASTER_WECHAT_PAYMENT_RECEIVER_ACCOUNT: "" }, "WECHAT_MANUAL")
        .ready,
    ).toBe(false);
    expect(parseBillingCommand({ action: "cancel_order", orderId: "synthetic" })).toEqual({
      action: "cancel_order",
      orderId: "synthetic",
    });
    expect(() =>
      parseBillingCommand({ action: "cancel_order", orderId: "synthetic", paid: false }),
    ).toThrow();
  });
});
