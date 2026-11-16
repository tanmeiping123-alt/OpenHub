"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { CircleCheck, CircleAlert, LoaderCircle } from "lucide-react";
import type { ModelSelection } from "@/lib/model-catalog";
import type { Locale } from "@/lib/types";

export function ModelAvailability({
  selection,
  locale,
}: {
  selection: ModelSelection;
  locale: Locale;
}) {
  const [result, setResult] = useState<{
    key: string;
    status: string;
    remainingTokens?: number;
    unlimited?: boolean;
  } | null>(null);
  const key = `${selection.modelKey ?? "deepseek-direct"}:${selection.strength ?? "off"}`;
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => {
      const params = new URLSearchParams({
        modelKey: selection.modelKey ?? "deepseek-direct",
        strength: selection.strength ?? "off",
      });
      void fetch(`/api/models/availability?${params}`, {
        cache: "no-store",
        signal: controller.signal,
      })
        .then(async (r) => {
          if (!r.ok) throw Error("unavailable");
          const value = await r.json();
          if (!controller.signal.aborted) setResult({ ...value, key });
        })
        .catch(() => {
          if (!controller.signal.aborted) setResult({ key, status: "unknown" });
        });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      controller.abort();
      window.removeEventListener("focus", refresh);
    };
  }, [key, selection.modelKey, selection.strength]);
  const status = result?.key === key ? result.status : "loading";
  const zh = locale === "zh-CN";
  const labels: Record<string, [string, string]> = {
    ready: ["额度初检通过", "Budget initial check passed"],
    daily: ["今日剩余额度不足", "Daily budget is insufficient"],
    period: ["本周期剩余额度不足", "Period budget is insufficient"],
    platform: ["平台共享预算暂不足", "Shared platform budget is insufficient"],
    disabled: ["账号模型调用已停用", "Model access is disabled"],
    frozen: ["退款审核期间暂停调用", "Calls paused during refund review"],
    unconfigured: ["模型或价格依据未就绪", "Model or pricing is unavailable"],
    unknown: ["暂时无法核对额度", "Budget check unavailable"],
    loading: ["正在核对可用额度…", "Checking available budget…"],
  };
  const Icon = status === "loading" ? LoaderCircle : status === "ready" ? CircleCheck : CircleAlert;
  return (
    <div className={`model-availability ${status === "ready" ? "ready" : ""}`} role="status">
      <Icon size={16} aria-hidden="true" />
      <div>
        <strong>{(labels[status] ?? labels.unknown)[zh ? 0 : 1]}</strong>
      </div>
      <Link href={`/${locale}/app/settings`}>{zh ? "查看额度" : "Usage"}</Link>
    </div>
  );
}
