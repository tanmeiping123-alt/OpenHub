"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Eye, EyeOff, LockKeyhole } from "lucide-react";
import type { Locale } from "@/lib/types";
import { safeWorkspaceNext } from "@/lib/auth-navigation";
class AuthFormError extends Error {}

export function AccountAuth({ locale, page }: { locale: Locale; page: "login" | "register" }) {
  const search = useSearchParams();
  const next = safeWorkspaceNext(search.get("next"), locale);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false),
    errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  const t = (en: string, zh: string) => (locale === "zh-CN" ? zh : en);
  const matches = page === "login" || password === confirm;
  const reason = search.get("reason");
  const notice =
    reason === "expired"
      ? t(
          "Your session expired. Log in again to continue; account-scoped drafts are retained in this tab.",
          "登录已失效，请重新登录。当前标签页中按账号隔离的草稿仍保留。",
        )
      : reason === "unavailable"
        ? t(
            "Session verification is temporarily unavailable. Please try signing in again.",
            "暂时无法验证登录状态，请稍后重试登录。",
          )
        : reason === "logged-out"
          ? t(
              "You have signed out. Log in to use the workspace again.",
              "已退出登录，重新登录后才可使用工作区。",
            )
          : reason === "required"
            ? t(
                "Log in or create an account to access this page.",
                "请先登录；没有账号请注册后使用。",
              )
            : "";

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!matches || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/auth/${page}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
        signal: AbortSignal.timeout(15000),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new AuthFormError(
          data.error === "TOO_MANY_ATTEMPTS"
            ? t("Too many attempts. Try again in 15 minutes.", "尝试次数过多，请在 15 分钟后重试。")
            : data.error === "ACCOUNT_UNAVAILABLE"
              ? t(
                  "This email cannot be registered. Try logging in or use another email.",
                  "该邮箱无法注册，请尝试登录或使用其他邮箱。",
                )
              : response.status >= 500 || data.error === "DEMO_API_DISABLED"
                ? t(
                    "Account service unavailable. Please retry later.",
                    "账号服务暂不可用，请稍后重试。",
                  )
                : t(
                    "Sign-in failed. Check your email and password.",
                    "登录失败，请检查邮箱和密码。",
                  ),
        );
      }
      if (!data.user || typeof data.user.id !== "string")
        throw new AuthFormError(
          t(
            "Account service returned an invalid response. Please retry.",
            "账号服务返回异常，请重试。",
          ),
        );
      try {
        sessionStorage.removeItem("promptmaster-demo-v1");
        localStorage.setItem("pm-account-changed", crypto.randomUUID());
      } catch {
        /* Storage availability never changes a confirmed authentication result. */
      }
      window.location.replace(next);
    } catch (e) {
      setError(
        e instanceof AuthFormError
          ? e.message
          : t("Account service unavailable. Please retry.", "账号服务暂不可用，请重试。"),
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <main className="public-main auth-page">
      <div className="auth-wrap">
        <section className="panel stack" aria-labelledby="auth-title">
          <div className="auth-emblem">
            <LockKeyhole size={24} aria-hidden="true" />
          </div>
          <div>
            <h1 id="auth-title">
              {page === "login" ? t("Log in", "登录") : t("Create account", "注册普通用户")}
            </h1>
            <p className="subtle">
              {page === "login"
                ? t("Welcome back to PromptMaster AI.", "欢迎回到 PromptMaster AI。")
                : t(
                    "Create your own PromptMaster AI workspace.",
                    "创建属于你的 PromptMaster AI 工作区。",
                  )}
            </p>
          </div>
          <p>
            {t(
              "An account is required to generate, evaluate, optimize and manage prompts and Skills. There is no guest workspace.",
              "注册并登录后，才可生成、评估、优化和管理 Prompt 与 Skills，不提供免登录工作区。",
            )}
          </p>
          {notice && (
            <p className="notice" role="status">
              {notice}
            </p>
          )}
          <form className="stack" onSubmit={submit} aria-busy={busy}>
            {error && (
              <p ref={errorRef} tabIndex={-1} className="auth-error" role="alert">
                {error}
              </p>
            )}
            <div className="field">
              <label htmlFor="email">{t("Email", "邮箱")}</label>
              <input
                id="email"
                className="input"
                type="email"
                required
                maxLength={254}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                value={email}
                disabled={busy}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="password">{t("Password", "密码")}</label>
              <div className="auth-password">
                <input
                  id="password"
                  className="input"
                  type={showPassword ? "text" : "password"}
                  required
                  minLength={8}
                  maxLength={128}
                  autoComplete={page === "login" ? "current-password" : "new-password"}
                  value={password}
                  disabled={busy}
                  aria-describedby={page === "register" ? "password-help" : undefined}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  aria-label={
                    showPassword ? t("Hide password", "隐藏密码") : t("Show password", "显示密码")
                  }
                  aria-pressed={showPassword}
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? (
                    <EyeOff size={18} aria-hidden="true" />
                  ) : (
                    <Eye size={18} aria-hidden="true" />
                  )}
                </button>
              </div>
              {page === "register" && (
                <p id="password-help" className="small subtle">
                  {t(
                    "Use 8–128 characters. Password managers and paste are supported.",
                    "密码为 8–128 个字符，支持密码管理器和粘贴。",
                  )}
                </p>
              )}
            </div>
            {page === "register" && (
              <div className="field">
                <label htmlFor="confirm">{t("Confirm password", "确认密码")}</label>
                <input
                  id="confirm"
                  className="input"
                  type={showPassword ? "text" : "password"}
                  required
                  minLength={8}
                  maxLength={128}
                  autoComplete="new-password"
                  value={confirm}
                  disabled={busy}
                  onChange={(e) => setConfirm(e.target.value)}
                  aria-invalid={!!confirm && !matches}
                  aria-describedby={confirm && !matches ? "password-mismatch" : undefined}
                />
                {confirm && !matches && (
                  <p id="password-mismatch" className="auth-error" role="alert">
                    {t("Passwords do not match.", "两次输入的密码不一致。")}
                  </p>
                )}
              </div>
            )}
            <button className="btn btn-primary" type="submit" disabled={busy || !matches}>
              {busy
                ? t("Please wait…", "请稍候……")
                : page === "login"
                  ? t("Log in", "登录")
                  : t("Create account", "创建账号")}
            </button>
          </form>
          <div className="auth-help stack">
            <Link href={`/${locale}/help#recovery`}>
              {t("Forgot password / account recovery", "忘记密码 / 账号恢复")}
            </Link>
            <p className="small subtle">
              {t(
                "Recovery is not implemented. Read the help page for current options.",
                "账号恢复尚未实现，请查看帮助了解当前处理方式。",
              )}
            </p>
          </div>
          <p className="auth-switch">
            {page === "login"
              ? t("New here? ", "还没有账号？")
              : t("Already registered? ", "已经有账号？")}
            <Link
              href={`/${locale}/${page === "login" ? "register" : "login"}?${new URLSearchParams({ next })}`}
            >
              {page === "login" ? t("Create account", "注册普通用户") : t("Log in", "登录")}
            </Link>
          </p>
        </section>
      </div>
    </main>
  );
}
