export const PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
export const FREE_PLAN = Object.freeze({
  tier: "Free" as const,
  amountFen: 0,
  currency: "CNY",
  durationDays: 30,
  dailyTokens: 1500000,
  periodTokens: 6000000,
  dailyUsd: 2,
  periodUsd: 5,
  prompts: 100,
  privateSkills: 10,
});
export const PRO_PLAN = Object.freeze({
  tier: "Pro" as const,
  amountFen: 1,
  currency: "CNY",
  durationDays: 30,
  dailyTokens: 4500000,
  periodTokens: 30000000,
  dailyUsd: 6,
  periodUsd: 15,
  prompts: 1000,
  privateSkills: 100,
});
export type Plan = typeof FREE_PLAN | typeof PRO_PLAN;
export function freePeriod(anchor: Date, now: Date) {
  const start =
    anchor.getTime() +
    Math.max(0, Math.floor((now.getTime() - anchor.getTime()) / PERIOD_MS)) * PERIOD_MS;
  return { start: new Date(start), end: new Date(start + PERIOD_MS) };
}
export function billingInput(value: unknown, fields: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("INVALID_BILLING_INPUT");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(",") !== [...fields].sort().join(","))
    throw Error("INVALID_BILLING_INPUT");
  for (const key of fields)
    if (
      typeof v[key] !== "string" ||
      !(v[key] as string).trim() ||
      (v[key] as string).length > 1000 ||
      /[\u0000-\u001f]/.test(v[key] as string)
    )
      throw Error("INVALID_BILLING_INPUT");
  return Object.fromEntries(fields.map((k) => [k, (v[k] as string).trim()])) as Record<
    string,
    string
  >;
}
export const PAYMENT_CHANNELS = ["ALIPAY_MANUAL", "WECHAT_MANUAL"] as const;
export type PaymentChannel = (typeof PAYMENT_CHANNELS)[number];
export function paymentConfig(
  env: Record<string, string | undefined> = process.env,
  channel: PaymentChannel = "ALIPAY_MANUAL",
) {
  const prefix =
    channel === "WECHAT_MANUAL" ? "PROMPTMASTER_WECHAT_PAYMENT_" : "PROMPTMASTER_PAYMENT_";
  const qrPath = env[`${prefix}QR_PATH`]?.trim() ?? "";
  const receiverAccount = env[`${prefix}RECEIVER_ACCOUNT`]?.trim() ?? "";
  const receiverHint = env[`${prefix}RECEIVER_HINT`]?.trim() ?? "";
  const refundContact = env[`${prefix}REFUND_CONTACT`]?.trim() ?? "";
  const ready =
    env.PROMPTMASTER_PAYMENT_ENABLED === "true" &&
    env[`${prefix}ENABLED`] === "true" &&
    /^\/payments\/[a-zA-Z0-9_-]+\.(png|jpg|webp)$/.test(qrPath) &&
    [receiverAccount, receiverHint, refundContact].every(
      (v) => v.length > 0 && v.length <= 500 && !/[\u0000-\u001f]/.test(v),
    );
  return {
    ready,
    qrPath,
    receiverAccount,
    receiverHint,
    refundContact,
    channel,
    automaticPaymentEnabled: false as const,
  };
}
