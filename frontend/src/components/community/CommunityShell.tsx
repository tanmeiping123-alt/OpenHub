"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { createContext, useContext, type ReactNode } from "react";
import { Braces, Globe2, Plus, Star, ShieldCheck } from "lucide-react";
import type { Locale } from "@/lib/types";
import type { CommunityViewer } from "@/lib/community-types";
import { loginDestination } from "@/lib/auth-navigation";
import { text, useCommunityResource } from "./client";
import { SignOutButton } from "../SignOutButton";

const Context = createContext<{
  locale: Locale;
  viewer: CommunityViewer | null;
  loading: boolean;
  reloadViewer: () => void;
  login: string;
} | null>(null);
export function useCommunity() {
  const value = useContext(Context);
  if (!value) throw new Error("CommunityShell required");
  return value;
}
export function CommunityShell({ locale, children }: { locale: Locale; children: ReactNode }) {
  const path = usePathname();
  const search = useSearchParams();
  const parts = path.split("/");
  const id =
    parts[3] && !["new", "me", "creators", "moderation"].includes(parts[3]) ? parts[3] : "";
  const session = useCommunityResource<CommunityViewer>(
    `/api/community/viewer${id ? `?id=${encodeURIComponent(id)}` : ""}`,
  );
  const base = `/${locale}/open-prompts`;
  const otherLocale = locale === "en" ? "zh-CN" : "en";
  const login = loginDestination(path + (search.size ? `?${search}` : ""), locale);
  return (
    <Context.Provider
      value={{
        locale,
        viewer: session.data,
        loading: session.loading,
        reloadViewer: session.reload,
        login,
      }}
    >
      <div className="op-shell">
        <a className="op-skip" href="#community-main">
          {text(locale, "Skip to content", "跳到主要内容")}
        </a>
        <header className="op-header">
          <Link className="op-brand" href={base}>
            <span className="op-brand-icon">
              <Braces size={22} aria-hidden="true" />
            </span>
            <span>Open Prompt</span>
          </Link>
          <nav
            className="op-main-nav"
            aria-label={text(locale, "Community navigation", "社区导航")}
          >
            <Link
              className={path === base ? "op-active" : ""}
              href={base}
              aria-current={path === base ? "page" : undefined}
            >
              {text(locale, "Explore", "发现")}
            </Link>
            {session.data?.user && (
              <Link href={`${base}/me`} aria-current={path.endsWith("/me") ? "page" : undefined}>
                {text(locale, "My space", "我的社区")}
              </Link>
            )}
            <Link href={`/${locale}/pelican`}>{text(locale, "Pelican study", "鹈鹕测智")}</Link>
            <Link href={`/${locale}/app`}>{text(locale, "Workspace", "创作工作台")}</Link>
          </nav>
          <div className="op-header-actions">
            <Link
              className="op-button op-icon op-language"
              aria-label={text(locale, "Switch to Chinese", "切换到英文")}
              href={
                path.replace(/^\/(en|zh-CN)/, `/${otherLocale}`) + (search.size ? `?${search}` : "")
              }
            >
              <Globe2 size={17} aria-hidden="true" />
              <span>{locale === "en" ? "中文" : "EN"}</span>
            </Link>
            {session.data?.user?.role === "ADMIN" && (
              <Link
                className="op-button op-icon"
                href={`${base}/moderation`}
                aria-label={text(locale, "Moderation", "社区治理")}
              >
                <ShieldCheck size={18} aria-hidden="true" />
              </Link>
            )}
            {session.data?.user ? (
              <span className="op-sign-out">
                <SignOutButton locale={locale} />
              </span>
            ) : (
              <Link className="op-button op-login" href={login}>
                {text(locale, "Log in", "登录")}
              </Link>
            )}
            <Link
              className="op-button op-primary op-publish-link"
              href={`${base}/new`}
              aria-label={text(locale, "Share a Prompt", "发布 Prompt")}
            >
              <Plus size={17} aria-hidden="true" />
              <span>{text(locale, "Share a Prompt", "发布 Prompt")}</span>
            </Link>
          </div>
        </header>
        <main id="community-main" className="op-main" tabIndex={-1}>
          {children}
        </main>
        <footer className="op-footer">
          <div>
            <Braces size={17} aria-hidden="true" />
            <span>Open Prompt</span>
          </div>
          <div>
            <Link href={`${base}/new`}>{text(locale, "Share your work", "分享你的作品")}</Link>
            <Link href={`/${locale}/help`}>{text(locale, "Help", "帮助")}</Link>
          </div>
        </footer>
      </div>
    </Context.Provider>
  );
}

export function CommunityGate({ children }: { children: ReactNode }) {
  const { viewer, loading, locale, login } = useCommunity();
  if (loading)
    return (
      <div className="op-state" role="status">
        {text(locale, "Checking your session…", "正在确认登录状态…")}
      </div>
    );
  if (!viewer?.user)
    return (
      <div className="op-state">
        <Star size={32} aria-hidden="true" />
        <h1>{text(locale, "Join the community", "参与开放社区")}</h1>
        <p>
          {text(
            locale,
            "Sign in to share, Star and save your favorite Prompts. Reading and copying are always open.",
            "登录后即可发布、Star 和保存喜欢的 Prompt。浏览与复制始终免费开放。",
          )}
        </p>
        <Link className="op-button op-primary" href={login}>
          {text(locale, "Log in to continue", "登录后继续")}
        </Link>
      </div>
    );
  return children;
}
