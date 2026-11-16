"use client";

import { useEffect, useState } from "react";
import { fetchLiveModelQuota, type LiveQuotaResult } from "@/lib/api-client";
import type { Locale } from "@/lib/types";

export function ModelQuotaPanel({ locale }: { locale: Locale }) {
  const [result, setResult] = useState<LiveQuotaResult | null>(null);
  const [busy, setBusy] = useState(false);
  const t = (en: string, zh: string) => (locale === "zh-CN" ? zh : en);
  useEffect(() => {
    let active = true;
    void fetchLiveModelQuota().then((value) => {
      if (active) setResult(value);
    });
    return () => {
      active = false;
    };
  }, []);
  const refresh = async () => {
    setBusy(true);
    setResult(await fetchLiveModelQuota());
    setBusy(false);
  };
  const q = result?.kind === "ready" ? result.data : null;
  const usd = (value: number) => `$${value.toFixed(8)}`;
  const unlimited = q?.unlimited === true;
  const tokenCap = (value: number) =>
    unlimited ? t("Unlimited", "不限量") : value.toLocaleString();
  const costCap = (value: number) => (unlimited ? t("Unlimited", "不限量") : usd(value));
  return (
    <section
      className="panel panel-pad"
      aria-busy={busy || !result}
      aria-label={t("Live model quota", "真实模型额度")}
    >
      <div className="panel-head">
        <div>
          <h2>{t("Live model quota", "真实模型额度")}</h2>
        </div>
        <button className="btn btn-sm" onClick={() => void refresh()} disabled={busy || !result}>
          {busy ? t("Refreshing…", "刷新中……") : t("Refresh usage", "刷新用量")}
        </button>
      </div>
      {!result && <p role="status">{t("Loading usage…", "正在读取用量……")}</p>}
      {result?.kind === "unavailable" && (
        <p role="status" className="small subtle">
          {t("Usage unavailable; no zero usage is inferred.", "用量暂不可用；不视为零用量。")} (
          {result.code})
        </p>
      )}
      {q && (
        <div className="stack">
          <div className="quota-overview">
            <div>
              <span>{t("Daily tokens remaining", "今日剩余 tokens")}</span>
              <strong>{tokenCap(q.remainingTokens)}</strong>
            </div>
            <div>
              <span>{t("30-day tokens remaining", "30 天剩余 tokens")}</span>
              <strong>{tokenCap(q.periodRemainingTokens)}</strong>
            </div>
            <div>
              <span>{t("Pending reconciliation", "待核对记录")}</span>
              <strong>{q.pendingReconciliations}</strong>
            </div>
          </div>
          {!q.enabled && <p role="status">{t("Model access is disabled.", "模型调用已停用。")}</p>}
          {q.frozen && (
            <p role="status">
              {t("Calls are paused during refund review.", "退款审核期间暂停模型调用。")}
            </p>
          )}
          <details>
            <summary>{t("Usage details and pricing", "用量明细与计费说明")}</summary>
            <div className="stack small">
              <p>
                {t(
                  "All live models share this user ledger; switching models does not reset quota. The price snapshot below describes the default model only. SiliconFlow quotes CNY and uses a fixed local budgeting coefficient of 0.20 USD/CNY, not a live exchange rate or provider charge.",
                  "所有真实模型共用该用户账本，切换模型不重置额度。下方价格快照仅描述默认模型；SiliconFlow 原价为 CNY，采用固定本地预算系数 0.20 USD/CNY，非实时汇率、非供应商实扣。",
                )}
              </p>
              <p>
                {q.tierCode} · {q.usageDay} · {t("Resets at 00:00 UTC", "每日 UTC 00:00 重置")} ·{" "}
                {q.enabled ? t("Enabled", "已启用") : t("Disabled", "已停用")}
              </p>
              {unlimited && (
                <p role="status">
                  {t(
                    "Administrator account: per-account token and local cost ceilings and the platform trial guard are bypassed; the provider account's real balance still applies.",
                    "管理员账号：账号 tokens、本地估算费用上限及平台试运营成本门槛均不受限；供应商账号实际余额仍适用。",
                  )}
                </p>
              )}
              <p>
                {t("Next daily reset in your local time", "下次日额度重置（本地时间）")}:{" "}
                {new Date(Date.parse(`${q.usageDay}T00:00:00Z`) + 86400000).toLocaleString(locale)}
              </p>
              <p>
                {t("30-day tokens: settled + reserved / cap", "30 天 tokens：已结算 + 预留 / 上限")}
                : {q.periodSettledTokens.toLocaleString()} +{" "}
                {q.periodReservedTokens.toLocaleString()} / {tokenCap(q.periodTokenLimit)} ·{" "}
                {t("Remaining", "剩余")} {tokenCap(q.periodRemainingTokens)}
              </p>
              <p>
                {t("Period", "周期")}: {new Date(q.periodStart).toLocaleString(locale)} —{" "}
                {new Date(q.periodEnd).toLocaleString(locale)}
              </p>
              <p>
                {t(
                  "30-day local USD estimate: settled + reserved / cap",
                  "30 天本地 USD 估算：已结算 + 预留 / 上限",
                )}
                : {usd(q.periodSettledCostUsd)} + {usd(q.periodReservedCostUsd)} /{" "}
                {costCap(q.periodCostLimitUsd)} · {t("Remaining", "剩余")}{" "}
                {costCap(q.periodRemainingCostUsd)}
              </p>
              {q.frozen && (
                <p role="status">
                  {t(
                    "New model requests are paused during refund review.",
                    "退款审核期间暂停新的模型调度。",
                  )}
                </p>
              )}
              <p className="subtle">
                {t(
                  "Trial platform cost ceiling per UTC day / fixed 30-day period",
                  "试运营平台总成本上限（每 UTC 日 / 固定 30 天）",
                )}
                : {usd(q.platform.dailyLimitUsd)} / {usd(q.platform.periodLimitUsd)}.{" "}
                {t(
                  "Operator ceilings may further limit a plan.",
                  "运营保护上限也可能限制套餐可用额度。",
                )}
              </p>
              <p>
                {t("Tokens: settled + reserved / daily cap", "Tokens：已结算 + 预留 / 日上限")}:{" "}
                {q.settledTokens.toLocaleString()} + {q.reservedTokens.toLocaleString()} /{" "}
                {tokenCap(q.dailyTokenLimit)}
              </p>
              <p>
                {t("Remaining tokens", "剩余 tokens")}: {tokenCap(q.remainingTokens)}
              </p>
              <p>
                {t(
                  "Local estimated USD: settled + reserved / cap",
                  "本地估算 USD：已结算 + 预留 / 上限",
                )}
                : {usd(q.settledCostUsd)} + {usd(q.reservedCostUsd)} /{" "}
                {costCap(q.dailyCostLimitUsd)}
              </p>
              <p>
                {t("Remaining estimated budget", "剩余估算预算")}: {costCap(q.remainingCostUsd)}
              </p>
              <p>
                {t("Pending provider reconciliation", "待供应商账单核对")}:{" "}
                {q.pendingReconciliations}
              </p>
              <p className="subtle" style={{ overflowWrap: "anywhere" }}>
                {q.pricingProductVersion} · {q.pricingWindow} ·{" "}
                {t("Price snapshot valid until", "价格快照有效期至")} {q.pricingValidUntil}
              </p>
              <p className="subtle">
                {t(
                  "Local estimates are not provider charges. Retry and unknown-cost reservations count toward the cap. Refresh after model calls; resetting the demo session does not clear this ledger.",
                  "本地估算不等于供应商实扣费用。重试与未知费用预留计入上限；模型调用后可刷新，重置演示会话不会清除此账本。",
                )}
              </p>
            </div>
          </details>
        </div>
      )}
    </section>
  );
}
