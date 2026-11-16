"use client";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { loginDestination } from "@/lib/auth-navigation";
import type { Locale } from "@/lib/types";
import { useAppStore } from "@/lib/store";

export function SessionBoundary({
  locale,
  children,
}: {
  locale: Locale;
  children: React.ReactNode;
}) {
  const path = usePathname();
  const { accountId } = useAppStore();
  // Session identity belongs to the workspace, not an individual route. Keep
  // its shell mounted during route revalidation; failures still lock it.
  const [verified, setVerified] = useState<{ accountId: string | null; status: string }>({
    accountId: null,
    status: "checking",
  });
  const retry = useRef<() => void>(() => {});
  useEffect(() => {
    const controller = new AbortController();
    let busy = false;
    const check = async () => {
      if (busy || controller.signal.aborted) return;
      busy = true;
      try {
        const response = await fetch("/api/auth/session", {
          cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
        });
        const session = response.ok ? await response.json() : null;
        if (controller.signal.aborted) return;
        if (response.ok && session?.user?.id && accountId && session.user.id !== accountId) {
          setVerified({ accountId, status: "checking" });
          window.location.replace(window.location.pathname + window.location.search);
          return;
        }
        if (response.status === 401 || (response.ok && !session?.user)) {
          setVerified({ accountId, status: "checking" });
          window.location.replace(
            loginDestination(window.location.pathname + window.location.search, locale, "expired"),
          );
        } else
          setVerified({
            accountId,
            status: response.ok && session?.user ? "ready" : "unavailable",
          });
      } catch {
        if (!controller.signal.aborted) setVerified({ accountId, status: "unavailable" });
      } finally {
        busy = false;
      }
    };
    retry.current = () => {
      setVerified({ accountId, status: "checking" });
      void check();
    };
    const visible = () => {
      if (document.visibilityState === "visible") void check();
    };
    const pageShow = () => {
      setVerified({ accountId, status: "checking" });
      void check();
    };
    const initial = window.setTimeout(() => void check(), 0);
    window.addEventListener("focus", visible);
    window.addEventListener("pageshow", pageShow);
    document.addEventListener("visibilitychange", visible);
    const timer = window.setInterval(visible, 60000);
    return () => {
      controller.abort();
      clearTimeout(initial);
      clearInterval(timer);
      window.removeEventListener("focus", visible);
      window.removeEventListener("pageshow", pageShow);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [path, locale, accountId]);
  const status = verified.accountId === accountId ? verified.status : "checking";
  if (status === "ready") return children;
  return (
    <main className="public-main" aria-live="polite">
      <p>
        {locale === "zh-CN"
          ? status === "checking"
            ? "正在验证登录状态…"
            : "登录状态暂时无法验证，工作区已暂时锁定。"
          : status === "checking"
            ? "Verifying your session…"
            : "Session verification unavailable. Workspace is locked."}
      </p>
      {status === "unavailable" && (
        <button className="btn" onClick={() => retry.current()}>
          {locale === "zh-CN" ? "重新验证" : "Retry verification"}
        </button>
      )}
    </main>
  );
}
