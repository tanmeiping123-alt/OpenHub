"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Locale } from "@/lib/types";
import type { PelicanSample } from "@/lib/pelican-types";

export const text = (locale: Locale, en: string, zh: string) => (locale === "zh-CN" ? zh : en);
export class PelicanError extends Error {
  constructor(
    public status: number,
    public code?: string,
  ) {
    super("PELICAN_REQUEST_FAILED");
  }
}
export async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    ...init,
    signal: init.signal ?? AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    let code: string | undefined;
    try {
      const body = await response.json();
      if (typeof body.error === "string") code = body.error;
    } catch {}
    throw new PelicanError(response.status, code);
  }
  return response.json() as Promise<T>;
}
export function post<T>(url: string, body: unknown, init: RequestInit = {}) {
  return request<T>(url, {
    ...init,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
export function useResource<T>(url: string | null) {
  const [result, setResult] = useState<{
    url: string | null;
    data: T | null;
    error: boolean;
    loading: boolean;
  }>({ url, data: null, error: false, loading: !!url });
  const [version, setVersion] = useState(0);
  const serial = useRef(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    if (!url) return;
    const id = ++serial.current;
    const controller = new AbortController();
    void request<T>(url, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted && serial.current === id)
          setResult({ url, data, error: false, loading: false });
      })
      .catch(() => {
        if (!controller.signal.aborted && serial.current === id)
          setResult({ url, data: null, error: true, loading: false });
      });
    return () => {
      controller.abort();
    };
  }, [url, version]);
  return {
    ...(result.url === url ? result : { data: null, error: false, loading: !!url }),
    reload,
  };
}
export function dateLabel(value: string | null, locale: Locale) {
  if (!value || !Number.isFinite(new Date(value).getTime()))
    return text(locale, "Not recorded", "未记录");
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value;
  return `${get("year")}/${get("month")}/${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}
export type PelicanBadgeTone = "neutral" | "active" | "success" | "warning" | "danger" | "muted";
export type PelicanBadgeState = {
  status: string;
  label: string;
  tone: PelicanBadgeTone;
  busy?: boolean;
};
export function executionState(sample: PelicanSample, locale: Locale): PelicanBadgeState {
  if (sample.stopRequested && ["PENDING", "QUEUED"].includes(sample.callStatus))
    return {
      status: "stopping",
      label: text(locale, "Stopping…", "正在停止…"),
      tone: "warning",
      busy: true,
    };
  if (sample.callStatus === "PENDING" && sample.startedAt)
    return {
      status: "running",
      label: text(locale, "Running", "执行中"),
      tone: "active",
      busy: true,
    };
  const call: Record<
    Exclude<PelicanSample["callStatus"], "SUCCEEDED">,
    [string, string, PelicanBadgeTone]
  > = {
    QUEUED: ["Queued", "待执行", "neutral"],
    PENDING: ["Processing", "处理中", "active"],
    FAILED: ["Call failed", "调用失败", "danger"],
    UNKNOWN: ["Result unknown; reconciliation required", "结果待核对", "warning"],
  };
  if (sample.callStatus !== "SUCCEEDED") {
    const [en, zh, tone] = call[sample.callStatus];
    return { status: sample.callStatus.toLowerCase(), label: text(locale, en, zh), tone };
  }
  return { status: "succeeded", label: text(locale, "Succeeded", "已成功"), tone: "success" };
}
export function previewState(sample: PelicanSample, locale: Locale): PelicanBadgeState {
  const preview: Record<PelicanSample["previewStatus"], [string, string, PelicanBadgeTone]> = {
    PENDING: ["Preview pending", "预览待处理", "neutral"],
    READY: ["Animation ready", "动画可预览", "success"],
    STATIC: ["Static result", "静态作品", "success"],
    INVALID: ["Preview unavailable", "预览失败", "warning"],
    BLOCKED: ["External resources blocked", "外部资源已阻断", "warning"],
    UNSUPPORTED: ["Playback control unsupported", "暂停控制不兼容", "muted"],
    TRUNCATED: ["Output truncated", "输出截断", "warning"],
  };
  const [en, zh, tone] = preview[sample.previewStatus];
  return { status: sample.previewStatus.toLowerCase(), label: text(locale, en, zh), tone };
}
export function sampleStatus(sample: PelicanSample, locale: Locale) {
  return sample.callStatus === "SUCCEEDED"
    ? previewState(sample, locale).label
    : executionState(sample, locale).label;
}
export function batchState(
  status: "DRAFT" | "RUNNING" | "COMPLETE" | "PUBLISHED" | "WITHDRAWN",
  locale: Locale,
): PelicanBadgeState {
  const states: Record<typeof status, [string, string, PelicanBadgeTone, boolean?]> = {
    DRAFT: ["Draft", "草稿", "neutral"],
    RUNNING: ["Running", "执行中", "active", true],
    COMPLETE: ["Completed, unpublished", "已完成，未发布", "success"],
    PUBLISHED: ["Published", "已发布", "success"],
    WITHDRAWN: ["Withdrawn", "已撤回", "muted"],
  };
  const [en, zh, tone, busy] = states[status];
  return { status: status.toLowerCase(), label: text(locale, en, zh), tone, busy };
}
