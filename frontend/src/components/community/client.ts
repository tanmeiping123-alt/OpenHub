"use client";

import { useCallback, useEffect, useState } from "react";
import type { Locale } from "@/lib/types";

export const text = (locale: Locale, en: string, zh: string) => (locale === "zh-CN" ? zh : en);
export class CommunityError extends Error {
  constructor(
    public code: string,
    public status = 0,
  ) {
    super(code);
  }
}
export async function communityFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  const deadline = AbortSignal.timeout(20000);
  const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  const response = await fetch(url, { cache: "no-store", ...init, signal });
  const data = await response.json();
  if (!response.ok)
    throw new CommunityError(data.error ?? "COMMUNITY_UNAVAILABLE", response.status);
  return data as T;
}
export function errorText(error: unknown, locale: Locale) {
  const code = error instanceof CommunityError ? error.code : "COMMUNITY_UNAVAILABLE";
  if (error instanceof CommunityError && error.status === 404)
    return text(
      locale,
      "This Prompt is unavailable or has been withdrawn.",
      "这条 Prompt 不存在、已撤回或已下架。",
    );
  const messages: Record<string, [string, string]> = {
    PUBLIC_AUTHOR_NAME_EMAIL_REJECTED: [
      "Choose a public nickname instead of an email address.",
      "请使用公开昵称，不要填写邮箱地址。",
    ],
    PUBLICATION_REMOVED: [
      "An administrator removed this publication. It needs review before it can be restored.",
      "此作品已被管理员下架，需要复核后恢复。",
    ],
    SELF_STAR_FORBIDDEN: ["You cannot Star your own Prompt.", "不能给自己的 Prompt Star。"],
    PUBLISH_DAILY_LIMIT: [
      "Today's publication limit has been reached. Please return tomorrow (UTC day).",
      "已达到今日发布上限，请于下一 UTC 日再试。",
    ],
    COMMUNITY_RATE_LIMIT: [
      "You have reached the activity limit. Please try again later.",
      "操作较频繁，请稍后重试。",
    ],
    ORIGIN_MISMATCH: [
      "The selected source does not match this publication. Please select the original saved version again.",
      "选择的来源与此次发布不一致，请重新选择准确的已保存版本。",
    ],
    AUTH_REQUIRED: [
      "Please sign in to continue. Your public browsing remains available.",
      "请登录后继续。公开内容仍可自由浏览和复制。",
    ],
    NOT_FOUND: [
      "This Prompt is unavailable or has been withdrawn.",
      "这条 Prompt 不存在、已撤回或已下架。",
    ],
    COMMUNITY_NOT_FOUND: [
      "This Prompt is unavailable or has been withdrawn.",
      "这条 Prompt 不存在、已撤回或已下架。",
    ],
    FORBIDDEN: ["You do not have permission for this action.", "你没有执行此操作的权限。"],
    ADMIN_REQUIRED: [
      "Only community administrators can manage reports.",
      "仅管理员可处理社区举报。",
    ],
    PROMPT_CAPACITY_EXCEEDED: [
      "Your private Prompt library is full. You can still copy the full text, or free up space and save again.",
      "我的 Prompt 容量已满。你仍可复制完整正文，或清理空间后再保存。",
    ],
    VERSION_CONFLICT: [
      "A newer version was published. Reload before publishing your update.",
      "已有更新的公开版本，请重新加载后再发布更新。",
    ],
    SOURCE_CONTENT_MISMATCH: [
      "The selected private version has different content. Edit and save it in your workspace, then select that exact version.",
      "正文与选中的私人版本不一致。请先在工作台编辑并保存，再选择准确版本发布。",
    ],
    ALREADY_PUBLISHED: [
      "This content is already published. View your publications or Star the original instead.",
      "此内容已发布。请查看我的发布，或为原作 Star。",
    ],
    SELF_STAR: ["You cannot Star your own Prompt.", "不能给自己的 Prompt Star。"],
    SELF_STAR_NOT_ALLOWED: ["You cannot Star your own Prompt.", "不能给自己的 Prompt Star。"],
    CONSENT_REQUIRED: [
      "Confirm the sharing rights and CC0 license before publishing.",
      "发布前请确认共享权利并同意 CC0 授权。",
    ],
    RATE_LIMITED: [
      "You have reached the activity limit. Please try again later.",
      "操作较频繁，请稍后重试。",
    ],
    PUBLICATION_LIMIT: [
      "Today's publication limit has been reached. Please return tomorrow (UTC day).",
      "已达到今日发布上限，请于下一 UTC 日再试。",
    ],
    IDEMPOTENCY_CONFLICT: [
      "This request has different content. Reconcile the original request first.",
      "此请求的内容发生变化，请先核对原请求。",
    ],
    PENDING_REQUEST: [
      "An earlier request is still unconfirmed. Restore and retry its original content first.",
      "上次请求结果待确认，请恢复并重试原始内容。",
    ],
    UNCONFIRMED: [
      "The result is not confirmed. Retry this same action to recover it without creating duplicates.",
      "结果尚未确认。请重试同一操作以核对结果，不会重复创建。",
    ],
    STORAGE_REQUIRED: [
      "Enable browser session storage to safely retain this request before retrying.",
      "请允许浏览器会话存储，以保留请求回执后重试。",
    ],
    INVALID_INPUT: [
      "Check the required fields and text lengths, then try again.",
      "请检查必填字段与文本长度后重试。",
    ],
    INVALID_PUBLICATION: [
      "Check the required fields and text lengths, then try again.",
      "请检查必填字段与文本长度后重试。",
    ],
  };
  const pair = messages[code];
  return pair
    ? text(locale, ...pair)
    : text(
        locale,
        "The community service is temporarily unavailable. Your input is retained; please retry.",
        "社区服务暂时不可用，输入内容已保留，请重试。",
      );
}

export function useCommunityResource<T>(url: string | null) {
  const [state, setState] = useState<{
    url: string | null;
    data: T | null;
    error: unknown;
    loading: boolean;
  }>({ url: null, data: null, error: null, loading: true });
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((n) => n + 1), []);
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    communityFetch<T>(url, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setState({ url, data, error: null, loading: false });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setState({ url, data: null, error, loading: false });
      });
    return () => controller.abort();
  }, [url, revision]);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") reload();
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", refresh);
    window.addEventListener("storage", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pageshow", refresh);
      window.removeEventListener("storage", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [reload]);
  return {
    data: state.url === url ? state.data : null,
    error: state.url === url ? state.error : null,
    loading: !!url && (state.url !== url || state.loading),
    reload,
  };
}

type Receipt = { key: string; body: string };
export function readReceipt(actor: string, operation: string): Receipt | null {
  try {
    return JSON.parse(
      sessionStorage.getItem(`open-prompt-request:${actor}:${operation}`) ?? "null",
    );
  } catch {
    return null;
  }
}
export async function communityMutation<T>(
  actor: string,
  operation: string,
  url: string,
  method: string,
  payload: unknown,
): Promise<T> {
  const storage = `open-prompt-request:${actor}:${operation}`;
  const body = JSON.stringify(payload);
  const previous = readReceipt(actor, operation);
  if (previous && previous.body !== body) throw new CommunityError("PENDING_REQUEST");
  const receipt = previous ?? { key: crypto.randomUUID(), body };
  try {
    sessionStorage.setItem(storage, JSON.stringify(receipt));
  } catch {
    throw new CommunityError("STORAGE_REQUIRED");
  }
  try {
    const result = await communityFetch<T>(url, {
      method,
      headers: { "Content-Type": "application/json", "Idempotency-Key": receipt.key },
      body,
    });
    sessionStorage.removeItem(storage);
    return result;
  } catch (error) {
    if (error instanceof CommunityError && error.status >= 400 && error.status < 500) {
      sessionStorage.removeItem(storage);
      throw error;
    }
    throw new CommunityError("UNCONFIRMED");
  }
}

export function dateLabel(value: string, locale: Locale) {
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}
