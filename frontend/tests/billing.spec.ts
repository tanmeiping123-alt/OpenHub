import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { PAYMENT_CHANNELS, paymentConfig, type PaymentChannel } from "../src/lib/billing-policy";
import type { BillingData, BillingOrder } from "../src/lib/billing-types";
const origin = "http://127.0.0.1:3000";
const methods = PAYMENT_CHANNELS.map((channel) => paymentConfig(process.env, channel));

function overview(): BillingData {
  return {
    role: "USER",
    payment: {
      ready: true,
      methods: PAYMENT_CHANNELS.map((channel) => ({ channel, ready: true })),
    },
    eligibility: true,
    offerUsed: false,
    entitlement: {
      code: "FREE_V1",
      tier: "Free",
      start: new Date().toISOString(),
      end: new Date(Date.now() + 2592000000).toISOString(),
      frozen: false,
    },
    capacity: { promptCount: 0, promptLimit: 100, privateSkillCount: 0, privateSkillLimit: 10 },
    orders: [],
  };
}
function syntheticOrder(channel: PaymentChannel, index = 1): BillingOrder {
  const cfg = paymentConfig(process.env, channel);
  return {
    id: `ord_00000000-0000-4000-a000-${String(index).padStart(12, "0")}`,
    channel,
    status: "PENDING",
    amountFen: 1,
    currency: "CNY",
    expiresAt: new Date(Date.now() + 900000).toISOString(),
    createdAt: new Date().toISOString(),
    receiverHint: cfg.receiverHint || "Synthetic recipient",
    refundContact: cfg.refundContact || "Synthetic contact",
    qrPath: cfg.qrPath || "/payments/synthetic.png",
    claimTransaction: null,
    claimPaidAt: null,
    grantStatus: "NONE",
    refundStatus: null,
    entitlementStart: null,
    entitlementEnd: null,
    issueCode: null,
  };
}
async function mockBilling(page: Page, state = overview()) {
  const commands: Array<Record<string, string>> = [];
  await page.route("**/api/billing", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: state });
      return;
    }
    const value: Record<string, string> = route.request().postDataJSON();
    commands.push(value);
    if (value.action === "create_order") {
      expect(Object.keys(value).sort()).toEqual(["action", "channel", "requestKey"]);
      expect(value.requestKey).toMatch(/^web-/);
      const order = syntheticOrder(value.channel as PaymentChannel, state.orders.length + 1);
      state.orders.unshift(order);
      await route.fulfill({ json: order });
      return;
    }
    const order = state.orders.find((o) => o.id === value.orderId);
    expect(order).toBeTruthy();
    if (order && value.action === "submit_claim") {
      order.status = "REVIEW";
      order.claimTransaction = value.transactionId;
      order.claimPaidAt = value.paidAt;
    }
    if (order && value.action === "cancel_order") {
      order.status = "EXPIRED";
      order.issueCode = "USER_CLOSED";
    }
    await route.fulfill({ json: { status: order?.status } });
  });
  return { state, commands };
}
const checkout = (page: Page) => page.locator(".subscription-checkout");
async function expectNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

test("administrator has a dedicated glass-card review workspace without checkout", async ({
  page,
}) => {
  const state = {
    ...overview(),
    role: "ADMIN" as const,
    eligibility: false,
    modelQuotaUnlimited: true,
  };
  const { commands } = await mockBilling(page, state);
  const orders = [1, 2].map((n) => ({
    ...syntheticOrder("ALIPAY_MANUAL", n),
    status: "REVIEW",
    ownerEmail: `payer${n}@example.test`,
    receiverAccount: "synthetic-receiver",
    claimTransaction: `claim-${n}`,
    claimPaidAt: new Date(Date.now() - 60000).toISOString(),
  }));
  state.orders = orders;
  await page.route("**/api/billing?admin=1", (route) =>
    route.fulfill({ json: { orders, events: [] } }),
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/zh-CN/app/account");
  const review = page.getByRole("region", { name: "管理员支付审核" });
  await expect(review.getByRole("heading", { name: "人工核账" })).toBeVisible();
  await expect(review.getByText("模型额度不限量", { exact: true })).toBeVisible();
  await expect(checkout(page)).toHaveCount(0);
  await expect(page.getByText("当前套餐", { exact: false })).toHaveCount(0);
  const cards = review.locator(".billing-order-card");
  await expect(cards).toHaveCount(2);
  await expect(cards.first().getByText("payer1@example.test", { exact: true })).toHaveCSS(
    "font-weight",
    "700",
  );
  await expect(cards.first().getByText(orders[0].id, { exact: true })).toHaveCSS(
    "font-weight",
    "700",
  );
  await expect(cards.first().locator("form").first()).toBeHidden();
  await cards.first().getByText("核账与处理", { exact: true }).click();
  const form = cards.first().locator("form").first();
  await form.getByLabel("实际到账时间（本地）").fill("2026-11-01T12:00");
  await form.getByLabel("核账说明（勿填密码或密钥）").fill("Synthetic UI receipt; no funds");
  await form.getByRole("checkbox").check();
  await form.getByRole("button", { name: "记录真实到账并开通" }).click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toMatchObject({
    action: "review_order",
    orderId: orders[0].id,
    amountFen: "1",
    verified: "CONFIRMED_REAL_RECEIPT",
  });
  await expect(cards.nth(1).locator("form").first()).toBeHidden();
  await review.getByRole("searchbox", { name: "搜索订单" }).fill("payer2");
  await expect(cards).toHaveCount(1);
  await expect(cards.first().getByText("payer2@example.test", { exact: true })).toBeVisible();
  await review.getByRole("searchbox", { name: "搜索订单" }).fill("");
  await expectNoOverflow(page);
  await review.screenshot({
    path: `${process.env.LOCALAPPDATA}/PromptMasterAI/admin-billing-cards.png`,
  });
  await page.goto("/zh-CN/app/checkout?subscribe=pro");
  await expect(page.getByRole("heading", { name: "人工核账" })).toBeVisible();
  await expect(checkout(page)).toHaveCount(0);
  expect(commands.some((c) => c.action === "create_order")).toBe(false);
});

test("administrator filters and paginates orders, retains refund controls and recovers refresh errors", async ({
  page,
}) => {
  const orders: BillingOrder[] = Array.from({ length: 10 }, (_, i) => ({
    ...syntheticOrder("WECHAT_MANUAL", i + 1),
    ownerEmail: `payer${i + 1}@example.test`,
    status: "PAID",
    grantStatus: "ACTIVE",
  }));
  orders[0] = { ...orders[0], status: "REVIEW", grantStatus: "NONE" };
  orders[1].grantStatus = "GRANT_PENDING";
  orders[2].refundStatus = "PROCESSING";
  orders[3].refundStatus = "FAILED";
  orders[4] = { ...orders[4], refundStatus: "SUCCESS", grantStatus: "REFUNDED" };
  const state = {
    ...overview(),
    role: "ADMIN" as const,
    eligibility: false,
    modelQuotaUnlimited: false,
    orders,
  };
  const { commands } = await mockBilling(page, state);
  let unavailable = false;
  await page.route("**/api/billing?admin=1", (route) =>
    route.fulfill(
      unavailable
        ? { status: 503, json: { error: "BILLING_UNAVAILABLE" } }
        : { json: { orders, events: [] } },
    ),
  );
  await page.goto("/zh-CN/app/account");
  const review = page.getByRole("region", { name: "管理员支付审核" });
  const cards = review.locator(".billing-order-card");
  await expect(cards).toHaveCount(8);
  await expect(review.getByText("模型额度不限量", { exact: true })).toHaveCount(0);
  await review.getByRole("button", { name: "下一页" }).click();
  await expect(cards).toHaveCount(2);
  await expect(cards.first().getByText("payer9@example.test", { exact: true })).toBeVisible();
  await review.getByRole("button", { name: /待处理/ }).click();
  await expect(cards).toHaveCount(4);
  await cards.nth(1).getByText("核账与处理", { exact: true }).click();
  await expect(cards.nth(1).getByRole("button", { name: "重试本订单权益发放" })).toBeVisible();
  await cards.nth(3).getByText("核账与处理", { exact: true }).click();
  await expect(cards.nth(3).getByRole("button", { name: "重新办理退款" })).toBeVisible();
  await cards.nth(2).getByText("核账与处理", { exact: true }).click();
  const refund = cards.nth(2).locator("form");
  await refund.getByLabel("处理说明", { exact: true }).fill("Synthetic refund confirmation");
  await refund.getByLabel("真实退款交易号（记录成功时必填）").fill("synthetic-refund-transaction");
  await refund.getByRole("checkbox").check();
  await refund.getByRole("button", { name: "记录退款状态" }).click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toMatchObject({
    action: "refund_success",
    orderId: orders[2].id,
    verified: "CONFIRMED_REAL_REFUND",
    refundTransaction: "synthetic-refund-transaction",
  });
  await expect(review.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
  unavailable = true;
  await review.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(review.getByRole("alert")).toContainText("状态刷新失败");
  await expect(cards).toHaveCount(4);
  unavailable = false;
  await review.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(review.getByRole("alert")).toHaveCount(0);
  await review.getByRole("button", { name: /其他记录/ }).click();
  await expect(cards).toHaveCount(6);
  await expect(cards.first().getByText("已核实退款", { exact: true })).toBeVisible();
  await expectNoOverflow(page);
});

test("real API opens subscription eligibility while protecting identity, fields and configured QR bytes", async ({
  context,
}) => {
  const response = await context.request.get("/api/billing");
  expect(response.status()).toBe(200);
  const state = await response.json();
  expect(state.entitlement.tier).toBe("Free");
  expect(state.payment.ready).toBe(methods.some((m) => m.ready));
  expect(state.payment.methods).toEqual(methods.map(({ channel, ready }) => ({ channel, ready })));
  expect(state.payment.automaticPaymentEnabled).toBe(false);
  expect(state.eligibility).toBe(true);
  expect(state.orders).toEqual([]);
  for (const cfg of methods.filter((m) => m.ready)) {
    const qr = await context.request.get(cfg.qrPath);
    expect(qr.status()).toBe(200);
    expect(qr.headers()["content-type"]).toMatch(/^image\/(jpeg|png|webp)/);
    const expected = await readFile(path.join(process.cwd(), "public", cfg.qrPath));
    const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    expect(hash(await qr.body())).toBe(hash(expected));
  }
  expect((await context.request.get("/api/billing?admin=1")).status()).toBe(403);
  for (const extra of [{ amountFen: 1, ownerId: "forged" }, { channel: "AUTOMATIC" }]) {
    expect(
      (
        await context.request.post("/api/billing", {
          headers: { origin },
          data: { action: "create_order", requestKey: "e2e-request", ...extra },
        })
      ).status(),
    ).toBe(400);
  }
  for (const channel of PAYMENT_CHANNELS) {
    expect(
      (
        await context.request.post("/api/billing", {
          headers: { origin },
          data: { action: "create_order", requestKey: "short", channel },
        })
      ).status(),
    ).toBe(400);
  }
  expect(
    (
      await context.request.post("/api/billing", {
        headers: { origin: "https://other.invalid" },
        data: { action: "create_order", requestKey: "e2e-request" },
      })
    ).status(),
  ).toBe(403);
  await context.clearCookies();
  expect((await context.request.get("/api/billing")).status()).toBe(401);
});

test("new account outside the legacy allowlist can open checkout and remains responsive", async ({
  page,
}) => {
  await page.goto("/zh-CN/app/account");
  await expect(page.getByRole("heading", { name: "套餐与订单" })).toBeVisible();
  await expect(page.getByText(/所有账号均可订阅/)).toBeVisible();
  const subscribe = checkout(page).getByRole("button", { name: "立即订阅" });
  if (methods.some((m) => m.ready)) {
    await expect(subscribe).toBeEnabled();
    await subscribe.click();
    await expect(checkout(page).getByRole("button", { name: "确认并支付 ¥0.01" })).toBeVisible();
  } else await expect(subscribe).toBeDisabled();
  await expect(page.getByText("暂无订单。", { exact: true })).toBeVisible();
  await expectNoOverflow(page);
  await page.goto("/en/app/settings");
  await expect(page.getByRole("link", { name: "Manage plan and orders" })).toBeVisible();
  await expect(page.getByText("Subscription demo scenario")).toHaveCount(0);
});

test("anonymous Subscribe now requires login and preserves the subscription destination", async ({
  page,
  context,
}) => {
  await context.clearCookies();
  await page.goto("/zh-CN/pricing");
  await expect(page.getByText("开放订阅", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "立即订阅", exact: true }).click();
  await expect(page).toHaveURL(/\/zh-CN\/login\?next=/);
  const target = new URL(page.url()).searchParams.get("next");
  expect(target).toContain("/zh-CN/app/checkout?subscribe=pro");
  await page.goto("/en/pricing");
  await expect(page.getByRole("link", { name: "Subscribe now", exact: true })).toHaveAttribute(
    "href",
    "/en/app/checkout?subscribe=pro",
  );
});

test("mocked disabled configuration closes checkout even for an eligible account", async ({
  page,
}) => {
  const state = overview();
  state.payment.ready = false;
  await mockBilling(page, state);
  await page.goto("/zh-CN/app/account");
  await expect(page.getByText("收款资料配置中，暂未开放购买。")).toBeVisible();
  await expect(checkout(page).getByRole("button", { name: "立即订阅" })).toBeDisabled();
});

for (const channel of PAYMENT_CHANNELS) {
  const name = channel === "WECHAT_MANUAL" ? "微信支付" : "支付宝";
  test(`mocked ${channel}: subscribe, select, QR, evidence, verified success`, async ({
    page,
  }, testInfo) => {
    const mock = await mockBilling(page);
    await page.goto("/zh-CN/pricing");
    await page.getByRole("link", { name: "立即订阅", exact: true }).click();
    await expect(page.getByRole("heading", { name: "订阅 Pro", exact: true })).toBeVisible();
    const flow = checkout(page);
    await expect(flow.getByRole("button", { name: "确认并支付 ¥0.01" })).toBeDisabled();
    await flow.getByRole("radio", { name: new RegExp(name) }).check();
    await page.screenshot({ path: testInfo.outputPath("method-selection.png"), fullPage: true });
    await flow.getByRole("button", { name: "确认并支付 ¥0.01" }).click();
    expect(mock.commands[0]).toMatchObject({ action: "create_order", channel });
    const order = mock.state.orders[0];
    const image = flow.getByRole("img", { name: `${name} 收款码` });
    await expect(image).toHaveAttribute("src", order.qrPath);
    await expect(flow.getByText(order.receiverHint, { exact: false })).toBeVisible();
    if (paymentConfig(process.env, channel).ready)
      await expect
        .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
        .toBeGreaterThan(0);
    await page.screenshot({ path: testInfo.outputPath("qr-payment-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 375, height: 812 });
    await expectNoOverflow(page);
    await page.screenshot({ path: testInfo.outputPath("qr-payment-mobile.png"), fullPage: true });
    await flow.getByRole("button", { name: "我已支付，下一步" }).click();
    await flow.getByLabel("已付款交易号").fill("synthetic-only-transaction");
    await flow.getByLabel("实际付款时间（本地时间）").fill("2026-11-06T09:00");
    await flow.getByRole("button", { name: "完成，提交核账" }).click();
    await expect(flow.getByRole("heading", { name: "待人工核账", exact: true })).toBeVisible();
    await expect(flow.getByRole("heading", { name: "订阅成功", exact: true })).toHaveCount(0);
    expect(mock.commands[1]).toMatchObject({
      action: "submit_claim",
      orderId: order.id,
      transactionId: "synthetic-only-transaction",
    });
    // Simulated server grant, not a real receipt/entitlement in the application DB.
    mock.state.entitlement.tier = "Pro";
    mock.state.offerUsed = true;
    order.status = "PAID";
    order.grantStatus = "ACTIVE";
    if (channel === "WECHAT_MANUAL") {
      await expect(flow.getByRole("heading", { name: "订阅成功", exact: true })).toBeVisible({
        timeout: 14000,
      });
    } else {
      await flow.getByRole("button", { name: "查询订阅状态" }).click();
      await expect(flow.getByRole("heading", { name: "订阅成功", exact: true })).toBeVisible();
    }
    await page.screenshot({ path: testInfo.outputPath("verified-success.png"), fullPage: true });
    await expect(flow.getByRole("link", { name: "开始使用" })).toHaveAttribute(
      "href",
      "/zh-CN/app/generate",
    );
    await page.setViewportSize({ width: 844, height: 390 });
    await expectNoOverflow(page);
  });
}

test("mocked pending order can only change method after explicit unpaid confirmation", async ({
  page,
}) => {
  const state = overview();
  state.orders = [syntheticOrder("ALIPAY_MANUAL")];
  const mock = await mockBilling(page, state);
  await page.goto("/zh-CN/app/account");
  const flow = checkout(page);
  await flow.getByRole("button", { name: "尚未付款，更换支付方式" }).click();
  await flow.getByRole("button", { name: "关闭未付款订单并更换" }).click();
  expect(mock.commands).toHaveLength(0);
  await flow.getByRole("checkbox").check();
  await flow.getByRole("button", { name: "关闭未付款订单并更换" }).click();
  await expect(flow.getByRole("radio", { name: /微信支付/ })).toBeVisible();
  await flow.getByRole("radio", { name: /微信支付/ }).check();
  await flow.getByRole("button", { name: "确认并支付 ¥0.01" }).click();
  await expect(flow.getByRole("img", { name: "微信支付 收款码" })).toBeVisible();
  expect(mock.commands.map((v) => v.action)).toEqual(["cancel_order", "create_order"]);
  expect(state.orders[1]).toMatchObject({
    status: "EXPIRED",
    channel: "ALIPAY_MANUAL",
    issueCode: "USER_CLOSED",
  });
});

test("mocked unconfigured WeChat cannot be selected even while Alipay is enabled", async ({
  page,
}) => {
  const state = overview();
  state.payment.methods[1].ready = false;
  const mock = await mockBilling(page, state);
  await page.goto("/en/app/account?subscribe=pro");
  const flow = checkout(page);
  await expect(flow.getByRole("radio", { name: /WeChat Pay/ })).toBeDisabled();
  await expect(flow.getByRole("radio", { name: /Alipay/ })).toBeEnabled();
  await expect(flow.getByRole("button", { name: "Confirm & pay ¥0.01" })).toBeDisabled();
  expect(mock.commands).toHaveLength(0);
});

test("mocked expired orders hide QR and retain original late-payment evidence submission", async ({
  page,
}) => {
  const state = overview();
  const order = syntheticOrder("WECHAT_MANUAL");
  order.status = "EXPIRED";
  order.expiresAt = new Date(Date.now() - 1000).toISOString();
  state.orders = [order];
  await mockBilling(page, state);
  await page.goto("/zh-CN/app/account");
  await page.getByRole("button", { name: "已付款？提交原订单凭据" }).click();
  await expect(checkout(page).getByRole("img")).toHaveCount(0);
  await expect(checkout(page).getByLabel("已付款交易号")).toBeVisible();
  await expect(checkout(page).getByRole("heading", { name: "订阅成功", exact: true })).toHaveCount(
    0,
  );
});

test("mocked paid-but-ungranted and refund-frozen accounts cannot show subscription success", async ({
  page,
}) => {
  const state = overview();
  const order = syntheticOrder("WECHAT_MANUAL");
  order.status = "PAID";
  order.grantStatus = "GRANT_PENDING";
  state.orders = [order];
  await mockBilling(page, state);
  await page.goto("/zh-CN/app/account");
  await expect(
    checkout(page).getByRole("heading", { name: "已核实到账，开通处理中" }),
  ).toBeVisible();
  await expect(checkout(page).getByRole("heading", { name: "订阅成功", exact: true })).toHaveCount(
    0,
  );
  state.entitlement.tier = "Pro";
  state.entitlement.frozen = true;
  order.grantStatus = "ACTIVE";
  order.refundStatus = "PROCESSING";
  state.offerUsed = true;
  await page.reload();
  await expect(page.getByText("退款核查期间暂停新的模型调用。")).toBeVisible();
  await expect(checkout(page).getByRole("heading", { name: "订阅成功", exact: true })).toHaveCount(
    0,
  );
});

test("mocked late paid original order takes priority over a newer unpaid QR", async ({ page }) => {
  const state = overview();
  const old = syntheticOrder("ALIPAY_MANUAL");
  old.status = "EXPIRED";
  old.claimTransaction = "synthetic-original-paid";
  state.orders = [syntheticOrder("WECHAT_MANUAL", 2), old];
  await mockBilling(page, state);
  await page.goto("/zh-CN/app/account");
  await expect(
    checkout(page).getByRole("heading", { name: "待人工核账", exact: true }),
  ).toBeVisible();
  await expect(checkout(page).getByRole("img")).toHaveCount(0);
  await expect(checkout(page).getByRole("button", { name: "确认并支付 ¥0.01" })).toHaveCount(0);
});

test("mocked paused payment method hides an existing QR but retains already-paid evidence", async ({
  page,
}) => {
  const state = overview();
  state.payment.methods[1].ready = false;
  state.orders = [syntheticOrder("WECHAT_MANUAL")];
  await mockBilling(page, state);
  await page.goto("/zh-CN/app/account");
  await expect(checkout(page).getByRole("img")).toHaveCount(0);
  await expect(
    checkout(page).getByText("该支付方式已暂停，请勿继续付款。如已付款，请在下方提交原订单凭据。"),
  ).toBeVisible();
  await expect(checkout(page).getByLabel("已付款交易号")).toBeVisible();
});
