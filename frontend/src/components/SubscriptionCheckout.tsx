"use client";
import { useEffect, useId, useRef, useState } from "react";
import { ArrowRight, Check, CheckCircle2, Clock3, QrCode, ShieldCheck } from "lucide-react";
import Link from "next/link";
import type { BillingData } from "@/lib/billing-types";
import { PAYMENT_CHANNELS, type PaymentChannel } from "@/lib/billing-policy";
import type { Locale } from "@/lib/types";

export function paymentName(channel: string, locale: Locale) {
  return channel === "WECHAT_MANUAL"
    ? locale === "zh-CN"
      ? "微信支付"
      : "WeChat Pay"
    : locale === "zh-CN"
      ? "支付宝"
      : "Alipay";
}

export function SubscriptionCheckout({
  data,
  locale,
  busy,
  run,
  refresh,
  clock,
  resumeOrderId,
  clearResume,
}: {
  data: BillingData;
  locale: Locale;
  busy: boolean;
  run: (v: Record<string, string>) => Promise<boolean>;
  refresh: () => void;
  clock: number;
  resumeOrderId: string | null;
  clearResume: () => void;
}) {
  const t = (en: string, zh: string) => (locale === "zh-CN" ? zh : en);
  const [open, setOpen] = useState(
    () =>
      typeof window !== "undefined" &&
      new URL(window.location.href).searchParams.get("subscribe") === "pro",
  );
  const [selected, setSelected] = useState<PaymentChannel | null>(null);
  const [evidence, setEvidence] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (new URL(window.location.href).searchParams.get("subscribe") === "pro") {
      heading.current?.focus();
      heading.current?.scrollIntoView({ block: "start" });
    }
  }, []);
  useEffect(() => {
    if (resumeOrderId) {
      heading.current?.focus();
      heading.current?.scrollIntoView({ block: "start" });
    }
  }, [resumeOrderId]);
  const resumed = data.orders.find(
    (o) => o.id === resumeOrderId && o.status === "EXPIRED" && !o.claimTransaction,
  );
  const order =
    resumed ??
    data.orders.find(
      (o) =>
        o.status === "REVIEW" ||
        (o.status === "EXPIRED" && o.claimTransaction && o.issueCode !== "CLAIM_REJECTED") ||
        (o.status === "PAID" &&
          o.grantStatus === "GRANT_PENDING" &&
          !["REQUESTED", "PROCESSING", "SUCCESS"].includes(o.refundStatus ?? "")),
    ) ??
    data.orders.find((o) => o.status === "PENDING");
  const success =
    data.entitlement.tier === "Pro" &&
    !data.entitlement.frozen &&
    Date.parse(data.entitlement.end) > clock;
  const expired = order?.status === "EXPIRED" || (!!order && Date.parse(order.expiresAt) <= clock);
  const channelReady = (channel: PaymentChannel) =>
    data.payment.ready &&
    (data.payment.methods?.find((method) => method.channel === channel)?.ready ??
      channel === "ALIPAY_MANUAL");
  const canPay = !expired && !!order && channelReady(order.channel);
  const waiting =
    !!order && (order.status === "REVIEW" || !!order.claimTransaction || order.status === "PAID");
  const step = success ? 3 : waiting ? 2 : order ? 1 : 0;
  const steps = [
    t("Payment method", "选择支付方式"),
    t("Scan & pay", "扫码支付"),
    t("Verify payment", "完成与核账"),
    t("Subscribed", "订阅成功"),
  ];
  const permitted = data.payment.ready && data.eligibility && !data.offerUsed;
  const date = (value: string) => new Date(value).toLocaleString(locale);
  const seconds = order
    ? Math.min(900, Math.max(0, Math.ceil((Date.parse(order.expiresAt) - clock) / 1000)))
    : 0;
  return (
    <section className="subscription-checkout" aria-labelledby={titleId}>
      <div className="checkout-offer">
        <div>
          <span className="checkout-eyebrow">PROMPTMASTER PRO</span>
          <h3 id={titleId} ref={heading} tabIndex={-1}>
            {t("A clearer path from idea to Prompt", "让每个想法，更进一步")}
          </h3>
          <p>
            {t(
              "30-day trial · One-time payment · No automatic renewal",
              "30 天测试套餐 · 一次预付 · 不自动续费",
            )}
          </p>
        </div>
        <div className="checkout-price">
          ¥0.01<span> / {t("30 days", "30 天")}</span>
        </div>
      </div>
      {!open && !order && !success && (
        <button
          className="btn btn-primary"
          disabled={!permitted || busy}
          onClick={() => {
            setOpen(true);
            heading.current?.focus();
          }}
        >
          {t("Subscribe now", "立即订阅")} <ArrowRight size={16} aria-hidden="true" />
        </button>
      )}
      {(open || order || success) && (
        <>
          <ol className="checkout-steps" aria-label={t("Subscription progress", "订阅进度")}>
            {steps.map((label, index) => (
              <li
                key={label}
                className={index <= step ? "is-current" : ""}
                aria-current={index === step ? "step" : undefined}
              >
                <span aria-hidden="true">{index < step ? <Check size={15} /> : index + 1}</span>
                {label}
              </li>
            ))}
          </ol>
          {success ? (
            <div className="checkout-result checkout-success" role="status">
              <CheckCircle2 size={36} aria-hidden="true" />
              <h4>{t("Subscription successful", "订阅成功")}</h4>
              <p>
                {t(
                  "Your Pro entitlement is active. Enjoy your upgraded limits.",
                  "Pro 权益已实际开通，升级后的额度现已可用。",
                )}
              </p>
              <p>
                {t("Valid until", "服务期至")}: {date(data.entitlement.end)}
              </p>
              <Link className="btn btn-primary" href={`/${locale}/app/generate`}>
                {t("Start creating", "开始使用")}
              </Link>
            </div>
          ) : order ? (
            <div className="stack">
              <div className="checkout-order-heading">
                <strong>{paymentName(order.channel, locale)} · ¥0.01</strong>
                {!waiting && (
                  <span className="checkout-countdown">
                    {expired
                      ? t("Payment window closed", "付款窗口已关闭")
                      : `${t("Pay within", "剩余付款时间")} ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`}
                  </span>
                )}
              </div>
              <p className="checkout-order-id">
                {t("Order", "订单号")}: {order.id}
              </p>
              {waiting ? (
                <div className="checkout-result" role="status">
                  <Clock3 size={32} aria-hidden="true" />
                  <h4>
                    {order.status === "PAID"
                      ? t("Payment verified, activation pending", "已核实到账，开通处理中")
                      : t("Awaiting manual verification", "待人工核账")}
                  </h4>
                  <p>
                    {t(
                      "Your evidence is saved. An administrator will check the original receipt. This page refreshes automatically; do not pay again.",
                      "凭据已保存，管理员将核对原始收款记录。此页会自动刷新，请勿重复付款。",
                    )}
                  </p>
                  <button className="btn" disabled={busy} onClick={refresh}>
                    {t("Check subscription status", "查询订阅状态")}
                  </button>
                </div>
              ) : (
                <>
                  {canPay && (
                    <div className="checkout-payment-grid">
                      <div className="checkout-qr">
                        {/* Display the exact operator-supplied image, never a generated payment QR. */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={order.qrPath}
                          alt={`${paymentName(order.channel, locale)} ${t("collection QR", "收款码")}`}
                          width={300}
                          height={420}
                        />
                        <div className="checkout-image-actions">
                          <a className="btn" href={order.qrPath} target="_blank" rel="noreferrer">
                            {t("View original", "查看原图")}
                          </a>
                          <a className="btn" href={order.qrPath} download>
                            {t("Save QR image", "保存收款码")}
                          </a>
                        </div>
                      </div>
                      <div className="stack">
                        <h4>
                          <QrCode size={19} aria-hidden="true" />{" "}
                          {t("Scan with the selected payment app", "使用所选支付 App 扫码")}
                        </h4>
                        <p>
                          {t("Recipient", "收款方")}: <strong>{order.receiverHint}</strong>
                        </p>
                        <p>
                          {t(
                            "Enter exactly ¥0.01 yourself. A personal QR does not fill the amount or link your order automatically.",
                            "请手动输入 ¥0.01。个人收款码不会自动填写金额或关联平台订单。",
                          )}
                        </p>
                        <div className="checkout-note">
                          <ShieldCheck size={19} aria-hidden="true" />
                          <span>
                            {t(
                              "Activation after manual receipt verification, not after clicking Done.",
                              "人工核实到账后开通，点击“完成”不会直接开通权益。",
                            )}
                          </span>
                        </div>
                        <button
                          className="btn btn-primary"
                          disabled={busy}
                          onClick={() => setEvidence(order.id)}
                        >
                          {t("I've paid, continue", "我已支付，下一步")}{" "}
                          <ArrowRight size={16} aria-hidden="true" />
                        </button>
                        <button
                          className="btn"
                          disabled={busy}
                          onClick={() => setChanging(!changing)}
                        >
                          {t("Not paid? Change method", "尚未付款，更换支付方式")}
                        </button>
                      </div>
                    </div>
                  )}
                  {expired && (
                    <>
                      <p role="status">
                        {t(
                          "Do not scan or pay this expired order. If you already paid, submit evidence below; otherwise start a new order.",
                          "此订单付款窗口已关闭，请勿继续扫码付款。已付请提交原订单凭据；未付可重新选择支付方式。",
                        )}
                      </p>
                      <button
                        className="btn"
                        disabled={busy}
                        onClick={() => {
                          clearResume();
                          setOpen(true);
                          refresh();
                        }}
                      >
                        {t("Unpaid — choose payment method again", "尚未付款，重新选择支付方式")}
                      </button>
                    </>
                  )}
                  {!expired && !canPay && (
                    <>
                      <p role="status">
                        {t(
                          "This payment method is paused. Do not pay. If you already paid, submit the original evidence below.",
                          "该支付方式已暂停，请勿继续付款。如已付款，请在下方提交原订单凭据。",
                        )}
                      </p>
                      <button
                        className="btn"
                        disabled={busy}
                        onClick={() => setChanging(!changing)}
                      >
                        {t("Not paid? Change method", "尚未付款，更换支付方式")}
                      </button>
                    </>
                  )}
                  {changing && !expired && (
                    <form
                      className="checkout-note stack"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void run({ action: "cancel_order", orderId: order.id }).then((ok) => {
                          if (ok) {
                            setChanging(false);
                            setSelected(null);
                            setOpen(true);
                          }
                        });
                      }}
                    >
                      <label>
                        <input type="checkbox" required />{" "}
                        {t(
                          "I confirm this order has not been paid. Close it before changing method.",
                          "我确认此订单尚未付款，关闭原订单后更换方式。",
                        )}
                      </label>
                      <button className="btn" disabled={busy}>
                        {t("Close unpaid order & change", "关闭未付款订单并更换")}
                      </button>
                    </form>
                  )}
                  {(evidence === order.id || expired || !canPay) && (
                    <form
                      className="checkout-evidence stack"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const form = new FormData(event.currentTarget);
                        const paidAt = String(form.get("paidAt"));
                        if (!Number.isFinite(Date.parse(paidAt))) return;
                        void run({
                          action: "submit_claim",
                          orderId: order.id,
                          transactionId: String(form.get("transactionId")),
                          paidAt: new Date(paidAt).toISOString(),
                        });
                      }}
                    >
                      <h4>{t("Complete payment evidence", "完成付款信息")}</h4>
                      <p>
                        {t(
                          "Submit only after an actual payment. Find the transaction number in your payment app's bill details.",
                          "仅在真实付款后提交。交易号请从所选支付 App 的账单详情复制。",
                        )}
                      </p>
                      <label>
                        {t("Paid transaction number", "已付款交易号")}
                        <input
                          name="transactionId"
                          className="input"
                          required
                          minLength={4}
                          maxLength={120}
                          autoComplete="off"
                        />
                      </label>
                      <label>
                        {t("Actual payment time (your local time)", "实际付款时间（本地时间）")}
                        <input name="paidAt" type="datetime-local" className="input" required />
                      </label>
                      <button className="btn btn-primary" disabled={busy}>
                        {busy
                          ? t("Submitting…", "正在提交……")
                          : t("Done — submit for verification", "完成，提交核账")}
                      </button>
                    </form>
                  )}
                </>
              )}
              <p className="checkout-refund">
                {t("Refund help", "退款联系及处理说明")}: {order.refundContact}
              </p>
            </div>
          ) : permitted ? (
            <form
              className="stack"
              onSubmit={(event) => {
                event.preventDefault();
                if (selected)
                  void run({
                    action: "create_order",
                    channel: selected,
                    requestKey: `web-${crypto.randomUUID()}`,
                  });
              }}
            >
              <fieldset className="checkout-methods" disabled={busy}>
                <legend>{t("Choose your payment method", "选择支付方式")}</legend>
                <div className="checkout-method-grid">
                  {PAYMENT_CHANNELS.map((channel) => {
                    const available = channelReady(channel);
                    return (
                      <label
                        key={channel}
                        className={`checkout-method ${selected === channel ? "is-selected" : ""}`}
                      >
                        <input
                          type="radio"
                          name="payment-channel"
                          value={channel}
                          checked={selected === channel}
                          onChange={() => setSelected(channel)}
                          disabled={!available}
                          required
                        />
                        <span>
                          <strong>{paymentName(channel, locale)}</strong>
                          <small>
                            {available
                              ? t("Scan QR · Manual verification", "扫码付款 · 人工核账")
                              : t("Not configured yet", "收款资料待配置")}
                          </small>
                        </span>
                        <QrCode size={22} aria-hidden="true" />
                      </label>
                    );
                  })}
                </div>
              </fieldset>
              <div className="checkout-total">
                <span>{t("Total due", "应付金额")}</span>
                <strong>
                  ¥0.01 <small>CNY</small>
                </strong>
              </div>
              <p className="checkout-refund">
                {t(
                  "One-time trial for all accounts. Administrator receipt verification is required. You can request a full refund from your order.",
                  "所有账号均可参加一次性测试，管理员核实到账后开通；可在订单内申请全额退款。",
                )}
              </p>
              <div className="checkout-actions">
                <button
                  className="btn"
                  type="button"
                  disabled={busy}
                  onClick={() => setOpen(false)}
                >
                  {t("Back", "返回")}
                </button>
                <button
                  className="btn btn-primary"
                  disabled={!selected || !channelReady(selected) || busy}
                >
                  {busy
                    ? t("Creating order…", "正在创建订单……")
                    : t("Confirm & pay ¥0.01", "确认并支付 ¥0.01")}
                  <ArrowRight size={16} aria-hidden="true" />
                </button>
              </div>
            </form>
          ) : (
            <p role="status">
              {t(
                "This account cannot purchase the trial right now. Check availability and eligibility above.",
                "当前账号暂不能购买，请查看上方开放状态与测试资格说明。",
              )}
            </p>
          )}
        </>
      )}
    </section>
  );
}
