"use client";
import { useRef, useState } from "react";
import { LogOut } from "lucide-react";
import type { Locale } from "@/lib/types";
export function SignOutButton({ locale }: { locale: Locale }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const lock = useRef(false);
  const t = (en: string, zh: string) => (locale === "zh-CN" ? zh : en);
  return (
    <div className="auth-signout">
      <button
        className="btn btn-sm"
        disabled={busy}
        onClick={async () => {
          if (lock.current) return;
          lock.current = true;
          setBusy(true);
          setError("");
          try {
            const response = await fetch("/api/auth/logout", {
              method: "POST",
              signal: AbortSignal.timeout(15000),
            });
            if (!response.ok) throw Error("LOGOUT_FAILED");
            try {
              localStorage.setItem("pm-account-changed", crypto.randomUUID());
            } catch {}
            window.location.replace(`/${locale}/login?reason=logged-out`);
          } catch {
            setError(t("Sign-out could not be confirmed. Please retry.", "未能确认退出，请重试。"));
          } finally {
            lock.current = false;
            setBusy(false);
          }
        }}
      >
        <LogOut size={15} aria-hidden="true" />
        {busy ? t("Signing out…", "正在退出…") : t("Log out", "退出登录")}
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
