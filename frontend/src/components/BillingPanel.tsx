"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ChevronDown, RefreshCw, Search, ShieldCheck } from "lucide-react";
import type { Locale } from "@/lib/types";
import { useAppStore } from "@/lib/store";
import type { BillingData as Billing, BillingOrder as Order } from "@/lib/billing-types";
import { SubscriptionCheckout, paymentName } from "./SubscriptionCheckout";

type Admin = {
  orders: Order[];
  events: Array<{ orderId: string; type: string; createdAt: string }>;
};
const statusNames: Record<string, [string, string]> = {
  PENDING: ["Awaiting payment", "待付款"],
  REVIEW: ["Awaiting manual verification", "待人工核账"],
  EXPIRED: ["Payment window closed", "付款窗口已关闭"],
  PAID: ["Payment recorded", "已核实到账"],
  GRANT_PENDING: ["Paid, activation pending", "已支付，开通处理中"],
  ACTIVE: ["Active", "已开通"],
  ENDED: ["Ended", "已到期"],
  REFUNDED: ["Refund verified", "已核实退款"],
  REVOKED: ["Revoked", "权益已撤销"],
  REQUESTED: ["Refund requested", "退款已申请"],
  PROCESSING: ["Refund processing", "退款办理中"],
  FAILED: ["Refund failed", "退款失败"],
};
function Status({ value, locale }: { value: string; locale: Locale }) {
  return <span>{statusNames[value]?.[locale === "zh-CN" ? 1 : 0] ?? value}</span>;
}
async function getData<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: "no-store" });
  const data = await r.json();
  if (!r.ok) throw Error(data.error ?? "BILLING_UNAVAILABLE");
  return data as T;
}
async function command(value: Record<string, string>) {
  const r = await fetch("/api/billing", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
  const data = await r.json();
  if (!r.ok) throw Error(data.error ?? "BILLING_UNAVAILABLE");
  return data;
}
function date(value: string | null, locale: Locale) {
  return value ? new Date(value).toLocaleString(locale) : "—";
}
function iso(value: FormDataEntryValue | null) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw Error("INVALID_PAYMENT_TIME");
  return new Date(value).toISOString();
}
function billingError(code: string, locale: Locale) {
  const messages: Record<string, [string, string]> = {
    ORDER_CHANNEL_CONFLICT: [
      "An order already exists for another method. Continue it, or confirm it is unpaid before changing method.",
      "已有其他支付方式的订单，请继续原订单；确认尚未付款后再更换方式。",
    ],
    ORDER_CANNOT_CANCEL: [
      "This order cannot be closed. Refresh and continue verification if already paid.",
      "该订单不能关闭。请刷新；已付款请继续核账，不要重复付款。",
    ],
    PAYMENT_NOT_CONFIGURED: [
      "This payment method is unavailable. Refresh and choose an available method.",
      "该支付方式暂不可用，请刷新并重新选择。",
    ],
    BILLING_REFRESH_FAILED: [
      "Could not refresh status. Retry or refresh this page; do not pay again.",
      "状态刷新失败，请重试或刷新页面，不要重复付款。",
    ],
    TEST_OFFER_ALREADY_USED: [
      "Your one-time trial offer has already been used.",
      "一次性测试购买资格已使用，不能再次购买。",
    ],
    INVALID_PAYMENT_TIME: [
      "Check the actual payment time; it cannot be in the future.",
      "请核对实际付款时间，不可填写未来时间。",
    ],
    ADMIN_SUBSCRIPTION_NOT_REQUIRED: [
      "Administrator accounts do not need a subscription.",
      "管理员无需订阅。",
    ],
    RECEIPT_MISMATCH: [
      "The receipt does not match this order. Check the recipient, amount and confirmation.",
      "到账凭据与订单不符，请核对收款账户、金额及核实勾选。",
    ],
    TRANSACTION_ALREADY_CLAIMED: [
      "This transaction is already attached to another order. Check the original record.",
      "该交易号已关联其他订单，请核对原始记录。",
    ],
    RECEIPT_ALREADY_RECORDED: [
      "A different receipt is already recorded. Refresh the order before continuing.",
      "该订单已记录其他到账凭据，请刷新订单后核对。",
    ],
    REAL_REFUND_CONFIRMATION_REQUIRED: [
      "Enter the real refund transaction and confirm the full return before recording success.",
      "请填写真实退款交易号并确认已全额退回，再记录成功。",
    ],
    INVALID_REFUND_TRANSITION: [
      "The refund status has changed. Refresh the order before continuing.",
      "退款状态已变化，请刷新订单后继续。",
    ],
    BILLING_UNAVAILABLE: [
      "Billing is unavailable. Try refreshing the orders.",
      "订单服务暂不可用，请刷新后重试。",
    ],
  };
  return messages[code]?.[locale === "zh-CN" ? 1 : 0] ?? code;
}

export function BillingPanel({
  locale,
  checkoutPage = false,
}: {
  locale: Locale;
  checkoutPage?: boolean;
}) {
  const { accountId } = useAppStore();
  return (
    <BillingAccount
      key={accountId ?? "guest"}
      locale={locale}
      signedIn={!!accountId}
      checkoutPage={checkoutPage}
    />
  );
}
function BillingAccount({
  locale,
  signedIn,
  checkoutPage,
}: {
  locale: Locale;
  signedIn: boolean;
  checkoutPage: boolean;
}) {
  const [data, setData] = useState<Billing | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const [clock, setClock] = useState(() => Date.now());
  const [resumeOrderId, setResumeOrderId] = useState<string | null>(null);
  useEffect(() => {
    const pending = data?.orders.some((o) => o.status === "PENDING");
    if (!pending && data?.entitlement.tier !== "Pro") return;
    const timer = setInterval(() => setClock(Date.now()), pending ? 1000 : 60000);
    return () => clearInterval(timer);
  }, [data]);
  const t = (en: string, zh: string) => (locale === "zh-CN" ? zh : en);
  const load = useCallback(async () => {
    setData(await getData<Billing>("/api/billing"));
  }, []);
  const polling =
    data?.role !== "ADMIN" &&
    !!data?.orders.some(
      (o) =>
        o.status === "REVIEW" ||
        (o.claimTransaction && o.status === "EXPIRED" && o.issueCode !== "CLAIM_REJECTED") ||
        (o.status === "PAID" && o.grantStatus === "GRANT_PENDING"),
    );
  useEffect(() => {
    if (!signedIn) return;
    let active = true;
    const controller = new AbortController();
    let refreshing = false;
    const refresh = async () => {
      if (document.hidden || refreshing) return;
      refreshing = true;
      try {
        const response = await fetch("/api/billing", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw Error("BILLING_UNAVAILABLE");
        const next = await response.json();
        if (active) {
          setData(next);
          setError("");
        }
      } catch (error) {
        if (active && !(error instanceof DOMException && error.name === "AbortError"))
          setError("BILLING_REFRESH_FAILED");
      } finally {
        refreshing = false;
      }
    };
    const timer = polling ? setInterval(() => void refresh(), 8000) : undefined;
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [signedIn, polling]);
  useEffect(() => {
    let active = true;
    if (signedIn)
      void getData<Billing>("/api/billing")
        .then((v) => {
          if (active) setData(v);
        })
        .catch((e) => {
          if (active) setError(String(e.message));
        });
    return () => {
      active = false;
    };
  }, [signedIn]);
  const run = async (v: Record<string, string>) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await command(v);
      await load();
      setMessage(t("Saved. The current state is shown below.", "已提交，当前状态已更新。"));
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "BILLING_UNAVAILABLE");
      return false;
    } finally {
      setBusy(false);
    }
  };
  if (!signedIn)
    return (
      <p>
        <Link
          className="btn"
          href={`/${locale}/login?next=${encodeURIComponent(`/${locale}/app/account`)}`}
        >
          {t("Sign in to view your plan and orders", "登录查看套餐与订单")}
        </Link>
      </p>
    );
  if (data?.role === "ADMIN")
    return <AdminBillingPanel locale={locale} unlimited={data.modelQuotaUnlimited === true} />;
  return (
    <section
      id="billing"
      className="panel panel-pad"
      aria-busy={busy}
      aria-label={t("Plan and billing", "套餐与支付")}
    >
      <div className="panel-head">
        <h2>
          {checkoutPage ? t("Subscribe to Pro", "订阅 Pro") : t("Plan and orders", "套餐与订单")}
        </h2>
        <button
          className="btn btn-sm"
          disabled={busy}
          onClick={() => void load().catch((e) => setError(e.message))}
        >
          {t("Refresh", "刷新")}
        </button>
      </div>
      {error && (
        <p role="alert">
          {t("Unable to complete the action", "操作未完成")}: {billingError(error, locale)}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {!data && !error && <p role="status">{t("Loading your plan…", "正在读取套餐……")}</p>}
      {data && (
        <div className="stack">
          <p>
            {t("Current plan", "当前套餐")}: <strong>{data.entitlement.tier}</strong> ·{" "}
            {t("30-day period ends", "30 天周期结束")}: {date(data.entitlement.end, locale)}
          </p>
          <p>
            {t("Saved Prompts", "已保存 Prompt")}: {data.capacity.promptCount} /{" "}
            {data.capacity.promptLimit} · {t("Private Skills", "私人 Skills")}:{" "}
            {data.capacity.privateSkillCount} / {data.capacity.privateSkillLimit}
          </p>
          {data.entitlement.frozen && (
            <p role="status">
              {t(
                "New model calls are paused during refund review.",
                "退款核查期间暂停新的模型调用。",
              )}
            </p>
          )}
          <p>
            {t(
              "Pro trial: ¥0.01 for 30 days, open to all accounts. Prepaid once; no automatic renewal. Activation follows manual receipt verification.",
              "Pro 测试版：¥0.01 / 30 天，所有账号均可订阅。一次预付，不自动续费；人工核实到账后开通。",
            )}
          </p>
          {!data.payment.ready && (
            <p role="status">
              {t(
                "Purchases are currently closed while payment details are being configured.",
                "收款资料配置中，暂未开放购买。",
              )}
            </p>
          )}
          {!data.eligibility && (
            <p>
              {t(
                "Subscriptions are unavailable for this account. Refresh or contact an administrator.",
                "此账号暂不可订阅，请刷新或联系管理员。",
              )}
            </p>
          )}
          {data.offerUsed && (
            <p>
              {t(
                "The one-time trial offer has been used. A refund does not reset eligibility.",
                "一次测试购买资格已使用，退款不会恢复资格。",
              )}
            </p>
          )}
          <SubscriptionCheckout
            data={data}
            locale={locale}
            busy={busy}
            run={run}
            clock={clock}
            refresh={() => void load().catch(() => setError("BILLING_REFRESH_FAILED"))}
            resumeOrderId={resumeOrderId}
            clearResume={() => setResumeOrderId(null)}
          />
          <h3>{t("Order history & refunds", "订单记录与退款")}</h3>
          {data.orders.length === 0 && (
            <p className="subtle">{t("No orders yet.", "暂无订单。")}</p>
          )}
          {data.orders.map((order) => {
            const o = {
              ...order,
              status:
                order.status === "PENDING" && Date.parse(order.expiresAt) <= clock
                  ? "EXPIRED"
                  : order.status,
            };
            return (
              <article
                className="panel panel-pad stack"
                key={o.id}
                style={{ overflowWrap: "anywhere" }}
              >
                <p>
                  <strong>
                    <Status value={o.status} locale={locale} />
                  </strong>{" "}
                  · ¥0.01 CNY · {paymentName(o.channel, locale)}{" "}
                  {o.grantStatus !== "NONE" && (
                    <>
                      {" "}
                      · <Status value={o.grantStatus} locale={locale} />
                    </>
                  )}
                  {o.refundStatus && (
                    <>
                      {" "}
                      · <Status value={o.refundStatus} locale={locale} />
                    </>
                  )}
                </p>
                <p>
                  {t("Order", "订单")}: {o.id}
                </p>
                {o.issueCode && o.issueCode !== "USER_CLOSED" && (
                  <p role="status">
                    {t("Manual handling required", "需人工处理")}: {o.issueCode}
                  </p>
                )}
                <p>
                  {t("Payment window ends", "付款窗口截止")}: {date(o.expiresAt, locale)}
                </p>
                {o.entitlementEnd && (
                  <p>
                    {t("Service period", "服务期")}: {date(o.entitlementStart, locale)} —{" "}
                    {date(o.entitlementEnd, locale)}
                  </p>
                )}
                <p>
                  {t("Recipient", "收款方")}: {o.receiverHint}
                </p>
                {o.status === "EXPIRED" && !o.claimTransaction && (
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={() => {
                      setResumeOrderId(o.id);
                      document.getElementById("billing")?.scrollIntoView();
                    }}
                  >
                    {t("Already paid? Submit original evidence", "已付款？提交原订单凭据")}
                  </button>
                )}
                {o.status === "PAID" && !o.refundStatus && (
                  <form
                    className="stack"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const f = new FormData(e.currentTarget);
                      void run({
                        action: "request_refund",
                        orderId: o.id,
                        reason: String(f.get("reason")),
                      });
                    }}
                  >
                    <label>
                      {t("Refund reason", "退款原因")}
                      <input
                        name="reason"
                        className="input"
                        required
                        minLength={5}
                        maxLength={1000}
                      />
                    </label>
                    <p>
                      {t(
                        "Requesting a refund pauses new model calls for this order until the request is resolved.",
                        "提交退款申请后，该订单的新模型调用会暂停，直至处理完成。",
                      )}
                    </p>
                    <button className="btn" disabled={busy}>
                      {t("Request full ¥0.01 refund", "申请全额退回 ¥0.01")}
                    </button>
                  </form>
                )}
                <p className="subtle">
                  {t("Refund contact and instructions", "退款联系及处理说明")}: {o.refundContact}
                </p>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
function reviewRequired(o: Order) {
  return (
    ["REVIEW"].includes(o.status) ||
    (o.status === "EXPIRED" && !!o.claimTransaction && o.issueCode !== "CLAIM_REJECTED") ||
    (o.grantStatus === "GRANT_PENDING" && !o.refundStatus) ||
    ["REQUESTED", "PROCESSING", "FAILED"].includes(o.refundStatus ?? "")
  );
}
function AdminBillingPanel({ locale, unlimited }: { locale: Locale; unlimited: boolean }) {
  const [data, setData] = useState<Admin | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(0);
  const t = (en: string, zh: string) => (locale === "zh-CN" ? zh : en);
  const load = useCallback(async () => setData(await getData<Admin>("/api/billing?admin=1")), []);
  const refresh = async () => {
    setBusy(true);
    setError("");
    try {
      await load();
    } catch {
      setError("BILLING_REFRESH_FAILED");
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    let active = true;
    void getData<Admin>("/api/billing?admin=1")
      .then((v) => {
        if (active) setData(v);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, []);
  const run = async (v: Record<string, string>) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const r = await command(v);
      try {
        await load();
      } catch {
        setError("BILLING_REFRESH_FAILED");
      }
      setMessage(
        r.grantStatus === "GRANT_PENDING"
          ? t(
              "Receipt saved. Activation needs recovery; do not request another payment.",
              "到账记录已保存，开通需补发处理，请勿要求用户再次付款。",
            )
          : t("Saved and audited.", "已保存并记录审核日志。"),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "BILLING_UNAVAILABLE");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      id="billing"
      className="billing-admin"
      aria-label={t("Administrator payment review", "管理员支付审核")}
      aria-busy={busy}
    >
      <header className="billing-admin-header">
        <div className="billing-admin-title">
          <ShieldCheck size={25} aria-hidden="true" />
          <div>
            <h2>{t("Manual payment review", "人工核账")}</h2>
            <p>
              {t("Administrator workspace · No subscription needed", "管理员工作区 · 无需订阅")}
            </p>
          </div>
        </div>
        <div className="billing-admin-tools">
          {unlimited && (
            <strong className="billing-admin-unlimited">
              {t("Unlimited model quota", "模型额度不限量")}
            </strong>
          )}
          <button className="btn" disabled={busy} onClick={() => void refresh()}>
            <RefreshCw size={16} aria-hidden="true" />
            {t("Refresh", "刷新")}
          </button>
        </div>
      </header>
      <p className="billing-admin-guidance">
        {t(
          "Match the original receipt, amount and payer before confirming payment.",
          "核对原始收款记录、金额与付款归属后，再确认到账。",
        )}
      </p>
      {error && <p role="alert">{billingError(error, locale)}</p>}
      {message && <p role="status">{message}</p>}
      {data && (
        <div className="billing-admin-toolbar">
          <div
            className="billing-admin-filters"
            role="group"
            aria-label={t("Order filter", "订单筛选")}
          >
            {[
              ["all", t("All orders", "全部订单"), data.orders.length],
              ["review", t("Needs handling", "待处理"), data.orders.filter(reviewRequired).length],
              [
                "other",
                t("Other records", "其他记录"),
                data.orders.filter((o) => !reviewRequired(o)).length,
              ],
            ].map(([value, label, count]) => (
              <button
                key={String(value)}
                className="btn"
                aria-pressed={filter === value}
                onClick={() => {
                  setFilter(String(value));
                  setPage(0);
                }}
              >
                {label}
                <span>{count}</span>
              </button>
            ))}
          </div>
          <label className="billing-admin-search">
            <Search size={17} aria-hidden="true" />
            <input
              type="search"
              aria-label={t("Search orders", "搜索订单")}
              placeholder={t("Email, order or transaction", "搜索邮箱、订单号或交易号")}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
              }}
            />
          </label>
        </div>
      )}
      {!data && !error && <p role="status">{t("Loading orders…", "正在读取订单…")}</p>}
      {data?.orders.length === 0 && (
        <p>{t("No payment orders to review.", "暂无支付审核订单。")}</p>
      )}
      {(() => {
        const filtered = (data?.orders ?? []).filter((o) => {
          const group =
            filter === "all" || (filter === "review" ? reviewRequired(o) : !reviewRequired(o));
          const haystack = [o.ownerEmail, o.id, o.claimTransaction, o.verifiedTransaction]
            .join(" ")
            .toLowerCase();
          return group && haystack.includes(search.trim().toLowerCase());
        });
        const pages = Math.max(1, Math.ceil(filtered.length / 8));
        const current = Math.min(page, pages - 1);
        return (
          <>
            {filtered.length === 0 && data && data.orders.length > 0 && (
              <p role="status">{t("No matching orders.", "没有匹配的订单。")}</p>
            )}
            <div className="billing-orders-grid">
              {filtered.slice(current * 8, current * 8 + 8).map((o) => (
                <article
                  className="billing-order-card"
                  key={o.id}
                  aria-label={`${t("Order", "订单")} ${o.id}`}
                >
                  <div className="billing-order-top">
                    <span>{o.ownerEmail}</span>
                    <strong>
                      ¥{(o.amountFen / 100).toFixed(2)} <small>{o.currency}</small>
                    </strong>
                  </div>
                  <p className="billing-order-id">{o.id}</p>
                  <p className="billing-order-state">
                    <Status value={o.status} locale={locale} />
                    {o.grantStatus !== "NONE" && (
                      <>
                        {" "}
                        · <Status value={o.grantStatus} locale={locale} />
                      </>
                    )}
                    {o.refundStatus && o.refundStatus !== "SUCCESS" && (
                      <>
                        {" "}
                        · <Status value={o.refundStatus} locale={locale} />
                      </>
                    )}
                  </p>
                  <dl className="billing-order-facts">
                    <div>
                      <dt>{t("Payment method", "支付方式")}</dt>
                      <dd>{paymentName(o.channel, locale)}</dd>
                    </div>
                    <div>
                      <dt>{t("Collection account", "收款账户")}</dt>
                      <dd>{o.receiverAccount ?? "—"}</dd>
                    </div>
                    <div>
                      <dt>{t("Claimed transaction", "用户提交交易号")}</dt>
                      <dd>{o.claimTransaction ?? "—"}</dd>
                    </div>
                    <div>
                      <dt>{t("Claimed payment time", "用户提交付款时间")}</dt>
                      <dd>{date(o.claimPaidAt, locale)}</dd>
                    </div>
                    {o.verifiedTransaction && (
                      <div>
                        <dt>{t("Verified transaction", "已核实交易号")}</dt>
                        <dd>{o.verifiedTransaction}</dd>
                      </div>
                    )}
                    <div>
                      <dt>{t("Created", "创建时间")}</dt>
                      <dd>{date(o.createdAt, locale)}</dd>
                    </div>
                  </dl>
                  {o.issueCode && o.issueCode !== "USER_CLOSED" && <p>{o.issueCode}</p>}
                  <details className="billing-order-details">
                    <summary>
                      {t("Review and handling", "核账与处理")}
                      <ChevronDown size={16} aria-hidden="true" />
                    </summary>
                    <div className="billing-order-actions stack">
                      {o.status === "PAID" &&
                        o.grantStatus !== "GRANT_PENDING" &&
                        !o.refundStatus && (
                          <p>
                            {t("Receipt verified. No action needed.", "到账已核实，无需处理。")}
                          </p>
                        )}
                      {o.refundStatus === "SUCCESS" && (
                        <p>
                          {t(
                            "Refund verified. Record retained for audit.",
                            "退款已核实，记录已留存。",
                          )}
                        </p>
                      )}
                      {o.status !== "PAID" && (
                        <form
                          className="stack"
                          onSubmit={(e) => {
                            e.preventDefault();
                            const f = new FormData(e.currentTarget);
                            try {
                              void run({
                                action: "review_order",
                                orderId: o.id,
                                transactionId: String(f.get("transactionId")),
                                receivedAt: iso(f.get("receivedAt")),
                                receiverAccount: String(f.get("receiverAccount")),
                                amountFen: "1",
                                currency: "CNY",
                                note: String(f.get("note")),
                                verified:
                                  f.get("verified") === "on" ? "CONFIRMED_REAL_RECEIPT" : "",
                              });
                            } catch {
                              setError("INVALID_PAYMENT_TIME");
                            }
                          }}
                        >
                          <label>
                            {t("Verified recipient account", "已核对的收款账户")}
                            <input
                              name="receiverAccount"
                              className="input"
                              required
                              defaultValue={o.receiverAccount}
                            />
                          </label>
                          <label>
                            {t("Original receipt transaction number", "真实收入交易号")}
                            <input
                              name="transactionId"
                              className="input"
                              required
                              minLength={4}
                              maxLength={120}
                              defaultValue={o.claimTransaction ?? ""}
                            />
                          </label>
                          <label>
                            {t("Actual receipt time (local)", "实际到账时间（本地）")}
                            <input
                              name="receivedAt"
                              type="datetime-local"
                              className="input"
                              required
                            />
                          </label>
                          <label>
                            {t(
                              "Verification note (no passwords or secrets)",
                              "核账说明（勿填密码或密钥）",
                            )}
                            <input
                              name="note"
                              className="input"
                              required
                              minLength={5}
                              maxLength={1000}
                            />
                          </label>
                          <label className="row">
                            <input type="checkbox" name="verified" required />
                            {t(
                              "I verified a real CNY 0.01 receipt in the original collection account and its owner/order association.",
                              "我已在原收款账户核实真实到账 CNY 0.01，并核对付款归属与本订单关联。",
                            )}
                          </label>
                          <button className="btn btn-primary" disabled={busy}>
                            {t("Record verified receipt and activate", "记录真实到账并开通")}
                          </button>
                        </form>
                      )}
                      {o.status !== "PAID" && (
                        <form
                          className="row"
                          onSubmit={(e) => {
                            e.preventDefault();
                            const f = new FormData(e.currentTarget);
                            void run({
                              action: "reject_claim",
                              orderId: o.id,
                              note: String(f.get("note")),
                            });
                          }}
                        >
                          <label>
                            {t("Unverified / rejected reason", "无法核实 / 拒绝原因")}
                            <input
                              name="note"
                              className="input"
                              minLength={5}
                              maxLength={1000}
                              required
                            />
                          </label>
                          <button className="btn" disabled={busy}>
                            {t("Close without recording income", "关闭并保留未到账状态")}
                          </button>
                        </form>
                      )}
                      {o.grantStatus === "GRANT_PENDING" && !o.refundStatus && (
                        <form
                          className="row"
                          onSubmit={(e) => {
                            e.preventDefault();
                            const f = new FormData(e.currentTarget);
                            void run({
                              action: "repair_grant",
                              orderId: o.id,
                              note: String(f.get("note")),
                            });
                          }}
                        >
                          <label>
                            {t("Recovery reason", "补发原因")}
                            <input name="note" className="input" required minLength={5} />
                          </label>
                          <button className="btn" disabled={busy}>
                            {t("Retry this order's activation", "重试本订单权益发放")}
                          </button>
                        </form>
                      )}
                      {o.refundStatus && (
                        <p>
                          <Status value={o.refundStatus} locale={locale} /> · {o.refundReason}
                        </p>
                      )}
                      {o.refundStatus === "FAILED" && (
                        <form
                          className="row"
                          onSubmit={(e) => {
                            e.preventDefault();
                            const f = new FormData(e.currentTarget);
                            void run({
                              action: "refund_retry",
                              orderId: o.id,
                              note: String(f.get("note")),
                            });
                          }}
                        >
                          <label>
                            {t("Refund retry reason", "重试退款原因")}
                            <input className="input" name="note" required minLength={5} />
                          </label>
                          <button className="btn" disabled={busy}>
                            {t("Retry refund processing", "重新办理退款")}
                          </button>
                        </form>
                      )}
                      {["REQUESTED", "PROCESSING"].includes(o.refundStatus ?? "") && (
                        <form
                          className="stack"
                          onSubmit={(e) => {
                            e.preventDefault();
                            const f = new FormData(e.currentTarget);
                            const action = String(f.get("action"));
                            const base = { action, orderId: o.id, note: String(f.get("note")) };
                            void run(
                              action === "refund_success"
                                ? {
                                    ...base,
                                    refundTransaction: String(f.get("refundTransaction")),
                                    verified:
                                      f.get("verified") === "on" ? "CONFIRMED_REAL_REFUND" : "",
                                  }
                                : base,
                            );
                          }}
                        >
                          <label>
                            {t("Refund processing result", "退款办理结果")}
                            <select name="action" className="input">
                              <option
                                value={
                                  o.refundStatus === "REQUESTED"
                                    ? "refund_processing"
                                    : "refund_success"
                                }
                              >
                                {o.refundStatus === "REQUESTED"
                                  ? t("Accept for processing", "受理并开始办理")
                                  : t("Real refund verified", "真实退款已核实")}
                              </option>
                              <option value="refund_failed">
                                {t(
                                  "Failed — restore service and compensate frozen time",
                                  "失败 — 恢复服务并补偿冻结时间",
                                )}
                              </option>
                            </select>
                          </label>
                          <label>
                            {t("Handling note", "处理说明")}
                            <input
                              name="note"
                              className="input"
                              required
                              minLength={5}
                              maxLength={1000}
                            />
                          </label>
                          {o.refundStatus === "PROCESSING" && (
                            <>
                              <label>
                                {t(
                                  "Real refund transaction number (required for success)",
                                  "真实退款交易号（记录成功时必填）",
                                )}
                                <input name="refundTransaction" className="input" maxLength={120} />
                              </label>
                              <label className="row">
                                <input name="verified" type="checkbox" />
                                {t(
                                  "I have verified the actual full CNY 0.01 return. This button only records that fact.",
                                  "我已核实真实全额退回 CNY 0.01，此按钮仅记录已发生的退款。",
                                )}
                              </label>
                            </>
                          )}
                          <button className="btn" disabled={busy}>
                            {t("Record refund status", "记录退款状态")}
                          </button>
                        </form>
                      )}
                    </div>
                  </details>
                </article>
              ))}
            </div>
            {filtered.length > 8 && (
              <nav className="billing-admin-pagination" aria-label={t("Order pages", "订单分页")}>
                <button
                  className="btn"
                  disabled={current === 0}
                  onClick={() => setPage(current - 1)}
                >
                  {t("Previous", "上一页")}
                </button>
                <span>
                  {current + 1} / {pages}
                </span>
                <button
                  className="btn"
                  disabled={current === pages - 1}
                  onClick={() => setPage(current + 1)}
                >
                  {t("Next", "下一页")}
                </button>
              </nav>
            )}
          </>
        );
      })()}
      {data?.orders.length === 100 && (
        <p className="billing-admin-guidance">
          {t(
            "Showing up to 100 recent records, outstanding first. Search and filters apply to these records.",
            "展示最多 100 条近期记录，待处理优先；搜索与筛选仅作用于这些记录。",
          )}
        </p>
      )}
    </section>
  );
}
